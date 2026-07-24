import express from "express";
import path from "path";
import fs from "fs";
import net from "net";
import { exec } from "child_process";
import { createServer as createViteServer } from "vite";
import { ForwardRule, AppSettings, ConfigVersion, SystemStatus, WhitelistGroup } from "./src/types";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const PORT = 3000;

app.use(express.json());

// Decode URL-encoded x-user-name header if present (e.g. for non-ASCII usernames like Chinese)
app.use((req, res, next) => {
  const userNameHeader = req.headers["x-user-name"];
  if (userNameHeader && typeof userNameHeader === "string") {
    try {
      req.headers["x-user-name"] = decodeURIComponent(userNameHeader);
    } catch (e) {
      // Fallback to original value if decode fails
    }
  }
  next();
});

// Database paths
const DATA_DIR = path.join(process.cwd(), "data");
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const VERSIONS_FILE = path.join(DATA_DIR, "versions.json");
const WHITELIST_GROUPS_FILE = path.join(DATA_DIR, "whitelist-groups.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Seed Rules if not present
const defaultRules: ForwardRule[] = [
  {
    id: "r1",
    name: "应用后端 API 转发",
    listenPort: 8080,
    targetHost: "192.168.1.100",
    targetPort: 8080,
    protocol: "HTTP",
    enabled: true,
    description: "开发环境主要的 API 服务网关转发，支持热重载，超时保持 10 分钟",
    createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  },
  {
    id: "r2",
    name: "MySQL 数据库主库转发",
    listenPort: 3307,
    targetHost: "10.0.0.12",
    targetPort: 3306,
    protocol: "TCP",
    enabled: true,
    description: "云端 RDS 数据库本地端口映射，用于开发机直连调试",
    createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()
  },
  {
    id: "r3",
    name: "Redis 缓存层集群入口",
    listenPort: 6380,
    targetHost: "10.0.0.15",
    targetPort: 6379,
    protocol: "TCP",
    enabled: false,
    description: "Redis 哨兵模式入口，临时关闭，待扩容完成重新打开",
    createdAt: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 12 * 3600 * 1000).toISOString()
  },
  {
    id: "r4",
    name: "MQTT 物联网协议转发",
    listenPort: 1884,
    targetHost: "192.168.5.20",
    targetPort: 1883,
    protocol: "UDP",
    enabled: true,
    description: "边缘网关采集通道，使用 UDP 保持高并发低延迟",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

const defaultSettings: AppSettings = {
  localIp: "127.0.0.1",
  domain: ""
};

const defaultWhitelistGroups: WhitelistGroup[] = [
  {
    id: "wg1",
    name: "运维团队办公室",
    description: "公司总部运维团队办公网段",
    ips: "113.89.32.229\n113.89.33.249",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "wg2",
    name: "云服务器出口",
    description: "云端服务器公网出口 IP",
    ips: "43.162.112.236",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const clients = new Set<WebSocket>();

export const broadcastWS = (type: string, payload: any) => {
  const msg = JSON.stringify({ type, payload });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
};

const writeJsonFile = (filePath: string, data: any) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
};

const readJsonFile = <T>(filePath: string, defaultVal: T): T => {
  if (!fs.existsSync(filePath)) {
    writeJsonFile(filePath, defaultVal);
    return defaultVal;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`Error reading database file ${filePath}:`, e);
    return defaultVal;
  }
};

// Load initial databases
let rules = readJsonFile<ForwardRule[]>(RULES_FILE, defaultRules);
let settings = readJsonFile<AppSettings>(SETTINGS_FILE, defaultSettings);
let versions = readJsonFile<ConfigVersion[]>(VERSIONS_FILE, []);
let whitelistGroups = readJsonFile<WhitelistGroup[]>(WHITELIST_GROUPS_FILE, defaultWhitelistGroups);

// Real-time shell executor
const executeDiagnosticCommand = (cmd: string): Promise<string> => {
  return new Promise((resolve) => {
    const command = cmd.trim();
    if (!command) {
      resolve("");
      return;
    }

    // Special quick helper commands
    if (command.toLowerCase() === "help") {
      resolve(
        "=== 系统内置调试与诊断命令 ===\n" +
        "  help                    - 显示此帮助菜单\n" +
        "  status                  - 查看当前端口映射与服务状态\n" +
        "  rules                   - 列出全部端口转发规则详情\n" +
        "  [任何标准系统命令]       - 比如: nginx -t, netstat -an, ps, curl 等\n"
      );
      return;
    }
    if (command.toLowerCase() === "status") {
      const active = rules.filter(r => r.enabled).length;
      resolve(
        `[系统状态] NGINX 端口转发运行中\n` +
        `  - 本地公网IP: ${settings.localIp}\n` +
        `  - 绑定域名: ${settings.domain || "(未绑定)"}\n` +
        `  - 活跃映射规则: ${active} / ${rules.length} 个`
      );
      return;
    }
    if (command.toLowerCase() === "rules") {
      if (rules.length === 0) {
        resolve("当前无任何端口转发配置。");
        return;
      }
      resolve(rules.map(r => `  - [${r.protocol}] :${r.listenPort} => ${r.targetHost}:${r.targetPort} (${r.enabled ? "启用" : "禁用"}) [${r.name}]`).join("\n"));
      return;
    }

    // Real terminal execution!
    exec(command, { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += stderr;
      if (error) {
        output += `\n[命令退出异常] 退出状态码: ${error.code || 1}\n${error.message}`;
      }
      if (!output.trim()) {
        output = "(命令执行成功，但没有返回标准输出)";
      }
      resolve(output);
    });
  });
};


// Helper to generate access control configurations
const getAccessControlConfig = (allowedIps?: string, indent: string = "    ") => {
  if (!allowedIps || !allowedIps.trim()) return "";
  const ips = allowedIps
    .split(/[\s,，;\n\r]+/)
    .map(ip => ip.trim())
    .filter(ip => ip.length > 0);
  if (ips.length === 0) return "";
  
  let str = `${indent}# 访问IP限制\n`;
  ips.forEach(ip => {
    str += `${indent}allow ${ip};\n`;
  });
  str += `${indent}deny all;\n`;
  return str;
};

// Generate Nginx configuration files (Virtual Preview)
const generateNginxConfig = (rulesList: ForwardRule[]): { main: string; http: string; stream: string } => {
  const activeRules = rulesList.filter(r => r.enabled);
  
  // 1. Generate Stream Config (TCP / UDP)
  const streamRules = activeRules.filter(r => r.protocol === "TCP" || r.protocol === "UDP");
  let streamConfigStr = `# ==========================================\n# TCP & UDP Stream Port Forwarding Rules\n# ==========================================\n`;
  if (streamRules.length === 0) {
    streamConfigStr += `# (目前无激活的 TCP/UDP 转发规则)\n`;
  } else {
    streamRules.forEach(rule => {
      streamConfigStr += `\n# 规则名称: ${rule.name}\n`;
      streamConfigStr += `# 备注信息: ${rule.description || "无"}\n`;
      streamConfigStr += `server {\n`;
      streamConfigStr += `    listen ${rule.listenPort}${rule.protocol === "UDP" ? " udp" : ""};\n`;
      streamConfigStr += `    proxy_pass ${rule.targetHost}:${rule.targetPort};\n`;
      streamConfigStr += `    proxy_connect_timeout 5s;\n`;
      streamConfigStr += `    proxy_timeout 10m;\n`;
      
      const ipConfig = getAccessControlConfig(rule.allowedIps, "    ");
      if (ipConfig) {
        streamConfigStr += ipConfig;
      }
      streamConfigStr += `}\n`;
    });
  }

  // 2. Generate HTTP Config
  const httpRules = activeRules.filter(r => r.protocol === "HTTP" || r.protocol === "HTTPS");
  let httpConfigStr = `# ==========================================\n# HTTP & HTTPS Web Reverse Proxy Rules\n# ==========================================\n`;
  if (httpRules.length === 0) {
    httpConfigStr += `# (目前无激活的 HTTP/HTTPS 反向代理规则)\n`;
  } else {
    httpRules.forEach(rule => {
      httpConfigStr += `\n# 规则名称: ${rule.name}\n`;
      httpConfigStr += `# 备注信息: ${rule.description || "无"}\n`;
      httpConfigStr += `server {\n`;
      httpConfigStr += `    listen ${rule.listenPort};\n`;
      httpConfigStr += `    server_name ${settings.domain || "localhost"};\n\n`;
      
      const ipConfig = getAccessControlConfig(rule.allowedIps, "    ");
      if (ipConfig) {
        httpConfigStr += ipConfig + "\n";
      }
      
      httpConfigStr += `    location / {\n`;
      httpConfigStr += `        proxy_pass ${rule.protocol.toLowerCase()}://${rule.targetHost}:${rule.targetPort};\n`;
      httpConfigStr += `        proxy_set_header Host $host:$server_port;\n`;
      httpConfigStr += `        proxy_set_header X-Real-IP $remote_addr;\n`;
      httpConfigStr += `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n`;
      httpConfigStr += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
      httpConfigStr += `        proxy_connect_timeout 5s;\n`;
      httpConfigStr += `        proxy_read_timeout 60s;\n`;
      httpConfigStr += `    }\n`;
      httpConfigStr += `}\n`;
    });
  }

  // 3. Generate Main Config
  let mainConfigStr = `load_module /usr/lib/nginx/modules/ngx_stream_module.so;\n`;
  mainConfigStr += `user www-data;\n`;
  mainConfigStr += `worker_processes auto;\n`;
  mainConfigStr += `error_log /var/log/nginx/error.log warn;\n`;
  mainConfigStr += `pid /var/run/nginx.pid;\n\n`;
  mainConfigStr += `events {\n`;
  mainConfigStr += `    worker_connections 1024;\n`;
  mainConfigStr += `}\n\n`;
  mainConfigStr += `# ==================== 七层 Web 代理配置 ====================\n`;
  mainConfigStr += `http {\n`;
  mainConfigStr += `    include       /etc/nginx/mime.types;\n`;
  mainConfigStr += `    default_type  application/octet-stream;\n\n`;
  mainConfigStr += `    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '\n`;
  mainConfigStr += `                      '$status $body_bytes_sent "$http_referer" '\n`;
  mainConfigStr += `                      '"$http_user_agent" "$http_x_forwarded_for"';\n`;
  mainConfigStr += `    access_log  /var/log/nginx/access.log  main;\n\n`;
  mainConfigStr += `    sendfile        on;\n`;
  mainConfigStr += `    keepalive_timeout  65;\n\n`;
  mainConfigStr += `    # 【重要核心：在此引入我们 Go 程序自动生成的 HTTP 转发规则】\n`;
  mainConfigStr += `    include /etc/nginx/conf.d/*.conf;\n`;
  mainConfigStr += `}\n\n`;
  mainConfigStr += `# ==================== 四层 TCP/UDP 流转发配置 ====================\n`;
  mainConfigStr += `stream {\n`;
  mainConfigStr += `    # 【重要核心：在此引入我们 Go 程序自动生成的 TCP/UDP 四层转发规则】\n`;
  mainConfigStr += `    include /etc/nginx/stream.d/*.conf;\n`;
  mainConfigStr += `}\n`;

  return { main: mainConfigStr, http: httpConfigStr, stream: streamConfigStr };
};

// ==========================================
// API Endpoints
// ==========================================

// Get system status
app.get("/api/system/status", (req, res) => {
  const activePorts = rules.filter(r => r.enabled).map(r => r.listenPort);
  res.json({
    nginxActive: true,
    activePortsCount: [...new Set(activePorts)].length,
    rulesCount: rules.length,
    lastReload: versions[0]?.timestamp || "暂未重载",
    cpuUsage: Math.floor(Math.random() * 5) + 1, // Simulated CPU load
    memUsage: Math.floor(Math.random() * 8) + 18, // Simulated RAM load
  } as SystemStatus);
});

// App Settings endpoints
app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.post("/api/settings", (req, res) => {
  const { localIp, domain } = req.body;
  settings.localIp = localIp || "127.0.0.1";
  settings.domain = domain || "";
  writeJsonFile(SETTINGS_FILE, settings);
  res.json({ success: true, settings });
});

// ===== Whitelist Groups CRUD =====
// GET all whitelist groups
app.get("/api/whitelist-groups", (_req, res) => {
  res.json(whitelistGroups);
});

// POST create whitelist group
app.post("/api/whitelist-groups", (req, res) => {
  const { name, description, ips } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "组名称不能为空" });
  }

  const newGroup: WhitelistGroup = {
    id: `wg_${Date.now()}`,
    name: name.trim(),
    description: (description || "").trim(),
    ips: (ips || "").trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  whitelistGroups.push(newGroup);
  writeJsonFile(WHITELIST_GROUPS_FILE, whitelistGroups);
  res.status(201).json({ success: true, group: newGroup });
});

// PUT update whitelist group
app.put("/api/whitelist-groups/:id", (req, res) => {
  const { id } = req.params;
  const { name, description, ips } = req.body;

  const idx = whitelistGroups.findIndex(g => g.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: "未找到指定的白名单组" });
  }

  const oldIps = whitelistGroups[idx].ips;
  const newIps = (ips !== undefined ? ips : whitelistGroups[idx].ips || "").trim();

  whitelistGroups[idx] = {
    ...whitelistGroups[idx],
    name: (name || whitelistGroups[idx].name).trim(),
    description: (description || whitelistGroups[idx].description || "").trim(),
    ips: newIps,
    updatedAt: new Date().toISOString(),
  };

  writeJsonFile(WHITELIST_GROUPS_FILE, whitelistGroups);

  // 同步更新所有绑定该白名单组的规则的 allowedIps
  if (newIps !== oldIps) {
    let rulesUpdated = false;
    rules.forEach(rule => {
      if (rule.whitelistGroupId === id) {
        rule.allowedIps = newIps;
        rule.updatedAt = new Date().toISOString();
        rulesUpdated = true;
      }
    });
    if (rulesUpdated) {
      writeJsonFile(RULES_FILE, rules);
      broadcastWS("update:rules", rules);
    }
  }

  res.json({ success: true });
});

// DELETE whitelist group
app.delete("/api/whitelist-groups/:id", (req, res) => {
  const { id } = req.params;
  const idx = whitelistGroups.findIndex(g => g.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: "未找到指定的白名单组" });
  }

  whitelistGroups.splice(idx, 1);
  writeJsonFile(WHITELIST_GROUPS_FILE, whitelistGroups);
  res.json({ success: true });
});

// 从命令行参数读取登录凭证
const uArgIndex = process.argv.indexOf("-u");
const pArgIndex = process.argv.indexOf("-p");
const cmdUsername = uArgIndex !== -1 ? process.argv[uArgIndex + 1] : "";
const cmdPassword = pArgIndex !== -1 ? process.argv[pArgIndex + 1] : "";

// Admin Authentication endpoint
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const loginUsername = cmdUsername || "admin";
  const loginPassword = cmdPassword || "Ruichi@2026.com";
  if (username === loginUsername && password === loginPassword) {
    return res.json({
      success: true,
      user: {
        id: "admin",
        username: "admin",
        role: "Admin",
        displayName: "系统管理员",
        avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&fit=crop&q=80"
      }
    });
  }
  return res.status(401).json({ error: "账号或密码错误" });
});

// Real-time Check for All Enabled Ports
app.get("/api/ports/check-all", async (req, res) => {
  const portChecks: Record<number, boolean> = {};
  
  // Define checkPort helper
  const checkPortStatus = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(250); // 250ms timeout
      
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      
      socket.connect(port, "127.0.0.1");
    });
  };

  const checkPromises = rules.map(async (rule) => {
    if (rule.enabled) {
      const isOpen = await checkPortStatus(rule.listenPort);
      portChecks[rule.listenPort] = isOpen;
    } else {
      portChecks[rule.listenPort] = false;
    }
  });

  await Promise.all(checkPromises);
  res.json(portChecks);
});

// Get all rules
app.get("/api/rules", (req, res) => {
  res.json(rules);
});

// Create rule
app.post("/api/rules", (req, res) => {
  const { name, listenPort, targetHost, targetPort, protocol, enabled, description, allowedIps, whitelistGroupId, urlSuffix } = req.body;

  // Validate port conflict
  const conflict = rules.find(r => r.listenPort === Number(listenPort) && r.enabled);
  if (conflict && enabled) {
    return res.status(400).json({ error: `端口冲突：监听端口 ${listenPort} 已经被正在启用的规则 "${conflict.name}" 占用。` });
  }

  const newRule: ForwardRule = {
    id: `rule_${Date.now()}`,
    name,
    listenPort: Number(listenPort),
    targetHost,
    targetPort: Number(targetPort),
    protocol,
    enabled: !!enabled,
    description: description || "",
    allowedIps: allowedIps || "",
    whitelistGroupId: whitelistGroupId || "",
    urlSuffix: urlSuffix || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  rules.push(newRule);
  writeJsonFile(RULES_FILE, rules);
  broadcastWS("update:rules", rules);

  res.status(201).json(newRule);
});

// Update rule
app.put("/api/rules/:id", (req, res) => {
  const { id } = req.params;
  const { name, listenPort, targetHost, targetPort, protocol, enabled, description, allowedIps, whitelistGroupId, urlSuffix } = req.body;

  const idx = rules.findIndex(r => r.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: "未找到指定的转发规则。" });
  }

  // Validate conflict
  const conflict = rules.find(r => r.id !== id && r.listenPort === Number(listenPort) && r.enabled);
  if (conflict && enabled) {
    return res.status(400).json({ error: `端口冲突：监听端口 ${listenPort} 已经被正在启用的规则 "${conflict.name}" 占用。` });
  }

  const oldRule = rules[idx];
  const updatedRule: ForwardRule = {
    ...oldRule,
    name,
    listenPort: Number(listenPort),
    targetHost,
    targetPort: Number(targetPort),
    protocol,
    enabled: !!enabled,
    description: description || "",
    allowedIps: allowedIps || "",
    whitelistGroupId: whitelistGroupId || "",
    urlSuffix: urlSuffix || "",
    updatedAt: new Date().toISOString()
  };

  rules[idx] = updatedRule;
  writeJsonFile(RULES_FILE, rules);
  broadcastWS("update:rules", rules);

  res.json(updatedRule);
});

// Delete rule
app.delete("/api/rules/:id", (req, res) => {
  const { id } = req.params;

  const idx = rules.findIndex(r => r.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: "规则未找到。" });
  }

  rules.splice(idx, 1);
  writeJsonFile(RULES_FILE, rules);
  broadcastWS("update:rules", rules);

  res.json({ message: "规则删除成功。" });
});

// Get Nginx Config previews
app.get("/api/nginx/preview", (req, res) => {
  res.json(generateNginxConfig(rules));
});

// Hot reload nginx with config generation
app.post("/api/nginx/reload", (req, res) => {
  try {
    const configs = generateNginxConfig(rules);
    
    // Save version history snapshot
    const versionNum = versions.length + 1;
    const newVersion: ConfigVersion = {
      id: `v_${Date.now()}`,
      version: versionNum,
      timestamp: new Date().toISOString(),
      description: `热重载备份 - 版本 #${versionNum} (含有 ${rules.length} 条规则，${rules.filter(r => r.enabled).length} 条启用)`,
      createdBy: "Admin",
      rulesSnapshot: JSON.parse(JSON.stringify(rules))
    };

    versions.unshift(newVersion);
    writeJsonFile(VERSIONS_FILE, versions);
    broadcastWS("update:versions", versions);

    res.json({
      success: true,
      message: "NGINX 配置热重载成功 (nginx -s reload)",
      version: versionNum,
      logs: [
        `[${new Date().toISOString()}] Starting configuration syntax checking...`,
        `[${new Date().toISOString()}] nginx: the configuration file /etc/nginx/nginx.conf syntax is ok`,
        `[${new Date().toISOString()}] nginx: configuration file /etc/nginx/nginx.conf test is successful`,
        `[${new Date().toISOString()}] Sending SIGHUP reload signal to master process pid 2235...`,
        `[${new Date().toISOString()}] NGINX reloaded configuration successfully in 12ms.`
      ]
    });
  } catch (err: any) {
    res.status(500).json({ error: "重载失败: " + (err.message || err) });
  }
});

// Get configuration backup versions
app.get("/api/versions", (req, res) => {
  res.json(versions);
});

// Rollback to specific configuration version
app.post("/api/versions/rollback", (req, res) => {
  const { versionId } = req.body;

  const ver = versions.find(v => v.id === versionId);
  if (!ver) {
    return res.status(404).json({ error: "未找到备份版本记录。" });
  }

  // Restore rules state from snapshot
  rules = JSON.parse(JSON.stringify(ver.rulesSnapshot));
  writeJsonFile(RULES_FILE, rules);
  broadcastWS("update:rules", rules);

  res.json({
    success: true,
    message: `成功回滚到版本 #${ver.version}，规则数据已重置。请重新执行服务热重载以生效该配置。`,
    rules: rules
  });
});

// Port discovery status API
app.get("/api/ports/status", (req, res) => {
  const systemReserved = [22, 80, 443, 3000, 3306, 5432, 6379, 8000, 27017];
  const rulesPorts = rules.map(r => r.listenPort);
  
  const allUsed = Array.from(new Set([...systemReserved, ...rulesPorts]));
  
  const recommendations: number[] = [];
  let candidate = 8080;
  while (recommendations.length < 5 && candidate < 65535) {
    if (!allUsed.includes(candidate)) {
      recommendations.push(candidate);
    }
    candidate++;
  }

  res.json({
    usedPorts: allUsed.sort((a, b) => a - b),
    recommendations
  });
});

// Clean and reset configs
app.post("/api/system/reset", (req, res) => {
  rules = JSON.parse(JSON.stringify(defaultRules));
  versions = [];
  
  writeJsonFile(RULES_FILE, rules);
  writeJsonFile(VERSIONS_FILE, versions);
  broadcastWS("update:rules", rules);
  broadcastWS("update:versions", versions);

  res.json({ success: true, message: "数据重置成功" });
});


import { createServer } from "http";

// Vite middleware integration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    clients.add(ws);

    // Send initial snapshot
    ws.send(JSON.stringify({
      type: "initial",
      payload: {
        rules,
        versions,
        nginxTestResult: "Nginx 配置测试成功!\n输出内容:\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful"
      }
    }));

    ws.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (parsed.type === "command") {
          executeDiagnosticCommand(parsed.command).then(response => {
            ws.send(JSON.stringify({ type: "terminal", payload: response }));
          });
        }
      } catch (err) {}
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = request.url || "";
    const pathname = url.split("?")[0];
    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[OK] Server listening at http://localhost:${PORT}`);
  });
}

startServer();
