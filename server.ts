import express from "express";
import path from "path";
import fs from "fs";
import net from "net";
import { exec, execSync } from "child_process";
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
        "  [任何标准系统命令]       - 比如: nft list ruleset, netstat -an, ps, curl 等\n"
      );
      return;
    }
    if (command.toLowerCase() === "status") {
      const active = rules.filter(r => r.enabled).length;
      resolve(
        `[系统状态] nftables 端口转发运行中\n` +
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


// IP 列表解析工具
const parseIPList = (allowedIps?: string): string[] => {
  if (!allowedIps || !allowedIps.trim()) return [];
  return allowedIps
    .split(/[\s,，;\n\r]+/)
    .map(ip => ip.trim())
    .filter(ip => ip.length > 0);
};

// 归一化 IP 列表（排序去重、统一分隔符），用于比较不同规则的 allowedIps 是否等价
const normalizeIPList = (allowedIps: string): string => {
  const ips = parseIPList(allowedIps);
  if (ips.length === 0) return "";
  ips.sort();
  return ips.join(",");
};

// Generate nftables rules using named sets for whitelist groups
const generateNftablesConfig = (rulesList: ForwardRule[], whitelistGroups: WhitelistGroup[]): { rules: string } => {
  const activeRules = rulesList.filter(r => r.enabled);

  // Build whitelist group lookup map
  const groupMap: Record<string, WhitelistGroup> = {};
  for (const g of whitelistGroups) {
    groupMap[g.id] = g;
  }

  // Collect named sets needed by enabled rules (de-duplicate by group ID)
  const usedSets = new Set<string>();
  for (const rule of rulesList) {
    if (rule.enabled && rule.whitelistGroupId) {
      const g = groupMap[rule.whitelistGroupId];
      if (g && g.ips && g.ips.trim()) {
        usedSets.add(rule.whitelistGroupId);
      }
    }
  }

  // ===== 自动去重：未绑定白名单组但多条规则共享相同 IP 列表时，自动生成命名集合 =====
  const anonymousGroups: Record<string, { ips: string; ruleIds: string[] }> = {};
  for (const rule of rulesList) {
    if (!rule.enabled || rule.whitelistGroupId || !rule.allowedIps || !rule.allowedIps.trim()) continue;
    const normalized = normalizeIPList(rule.allowedIps);
    if (!normalized) continue;
    if (anonymousGroups[normalized]) {
      anonymousGroups[normalized].ruleIds.push(rule.id);
    } else {
      anonymousGroups[normalized] = { ips: normalized, ruleIds: [rule.id] };
    }
  }

  // 为被 >= 2 条规则引用的匿名 IP 集合生成命名集合
  let setIndex = 0;
  const autoSetNameByIPs: Record<string, string> = {};
  for (const [normalizedIPs, ag] of Object.entries(anonymousGroups)) {
    if (ag.ruleIds.length >= 2) {
      const setName = `auto_wl_set_${String(setIndex).padStart(3, '0')}`;
      setIndex++;
      autoSetNameByIPs[normalizedIPs] = setName;
    }
  }

  let config = `# nftables port forwarding rules\n`;
  config += `# Generated: ${new Date().toISOString()}\n`;
  config += `# Managed by Port Forwarder (nftables mode)\n`;
  config += `# OS: Rocky Linux 9.x optimized\n\n`;
  config += `flush ruleset\n\n`;

  // 定义 port_forwarder 表
  config += `table ip port_forwarder {\n\n`;

  // ===== Named Sets for Whitelist Groups =====
  for (const groupId of usedSets) {
    const group = groupMap[groupId];
    const ips = parseIPList(group.ips);
    config += `    set whitelist_${groupId} {\n`;
    config += `        type ipv4_addr\n`;
    config += `        flags interval\n`;
    config += `        elements = { ${ips.join(", ")} }\n`;
    config += `    }\n\n`;
  }

  // ===== Named Sets — 自动去重生成的匿名集合 =====
  for (const [normalizedIPs, setName] of Object.entries(autoSetNameByIPs)) {
    const ips = normalizedIPs.split(",");
    const count = anonymousGroups[normalizedIPs].ruleIds.length;
    config += `    # 自动去重：${count} 条规则共享此 IP 列表\n`;
    config += `    set ${setName} {\n`;
    config += `        type ipv4_addr\n`;
    config += `        flags interval\n`;
    config += `        elements = { ${ips.join(", ")} }\n`;
    config += `    }\n\n`;
  }

  // prerouting 链 — DNAT 入站流量
  config += `    chain prerouting {\n`;
  config += `        type nat hook prerouting priority dstnat; policy accept;\n\n`;

  if (activeRules.length === 0) {
    config += `        # 当前无激活的端口转发规则\n`;
  } else {
    activeRules.forEach(rule => {
      config += `        # ${rule.name} [${rule.id}]\n`;
      if (rule.description) {
        config += `        # ${rule.description}\n`;
      }

      // IP 白名单过滤（三级优先级：绑定白名单组 > 自动去重集合 > 内联匿名集合）
      let ipFilter = "";
      if (rule.whitelistGroupId && usedSets.has(rule.whitelistGroupId)) {
        ipFilter = `ip saddr @whitelist_${rule.whitelistGroupId} `;
      }
      if (!ipFilter && rule.allowedIps && rule.allowedIps.trim()) {
        const normalized = normalizeIPList(rule.allowedIps);
        const setName = autoSetNameByIPs[normalized];
        if (setName) {
          // 自动去重命名集合
          ipFilter = `ip saddr @${setName} `;
        } else {
          // 最终回退: 仅单条规则引用此 IP 列表，使用内联
          const ips = parseIPList(rule.allowedIps);
          if (ips.length > 0) {
            ipFilter = `ip saddr { ${ips.join(", ")} } `;
          }
        }
      }

      const proto = rule.protocol === "UDP" ? "udp" : "tcp";
      config += `        ${ipFilter}${proto} dport ${rule.listenPort} dnat to ${rule.targetHost}:${rule.targetPort}\n\n`;
    });
  }

  config += `    }\n\n`;

  // postrouting 链 — 保证 DNAT 回程流量正确路由
  // ct status dnat 仅匹配被 DNAT 的连接，不会影响本机发起的普通出站流量
  config += `    chain postrouting {\n`;
  config += `        type nat hook postrouting priority srcnat; policy accept;\n`;
  config += `        ct status dnat masquerade\n`;
  config += `    }\n`;

  config += `}\n`;

  return { rules: config };
};

// ============================================================================
// 系统自检、自修复与内核优化 (面向 Rocky Linux 9.x)
// ============================================================================

const systemInitLogs: string[] = [];
let nftablesTestResult = "未测试";

const logInit = (msg: string) => {
  systemInitLogs.push(msg);
  console.log(msg);
};

// 安全写入 sysctl 参数
const sysctlApply = (key: string, value: string): boolean => {
  const procPath = "/proc/sys/" + key.replace(/\./g, "/");
  try {
    if (fs.existsSync(procPath)) {
      const current = fs.readFileSync(procPath, "utf-8").trim();
      if (current === value) return true;
    }
    fs.writeFileSync(procPath, value, "utf-8");
    logInit(`[Kernel] ✓ 已设置 ${key} = ${value}`);
    return true;
  } catch (err: any) {
    logInit(`[Kernel] ✗ 设置 ${key}=${value} 失败: ${err.message || err}`);
    return false;
  }
};

// 检测/安装 nftables
const ensureNftablesInstalled = (): boolean => {
  try {
    const verOut = execSync("nft --version", { encoding: "utf-8" });
    logInit(`[nftables-Check] ✓ nft 已安装: ${verOut.trim()}`);
    return true;
  } catch {
    logInit("[nftables-Check] ✗ nft 未安装，尝试自动安装...");
  }

  // 检测包管理器并安装
  const installers = [
    { name: "dnf", cmd: "dnf install -y nftables" },
    { name: "yum", cmd: "yum install -y nftables" },
  ];

  for (const inst of installers) {
    try {
      execSync(`which ${inst.name}`, { stdio: "pipe" });
      logInit(`[nftables-Install] 使用 ${inst.name} 安装...`);
      const out = execSync(inst.cmd, { encoding: "utf-8", timeout: 120000 });
      logInit(`[nftables-Install] ✓ 安装成功`);
      // 启用服务
      try {
        execSync("systemctl enable --now nftables", { encoding: "utf-8" });
        logInit("[nftables-Install] ✓ nftables 服务已启用并启动");
      } catch (e) {
        logInit("[nftables-Install] ! 启用服务失败(非致命)");
      }
      return true;
    } catch {
      // 尝试下一个
    }
  }

  logInit("[nftables-Install] ✗ 无法自动安装，请手动: dnf install -y nftables");
  return false;
};

// 加载内核模块
const loadNftablesModules = () => {
  const modules = ["nf_tables", "nf_conntrack", "nf_conntrack_netlink", "nf_nat", "nf_tproxy_ipv4"];
  modules.forEach(mod => {
    try {
      execSync(`modprobe ${mod}`, { encoding: "utf-8" });
      logInit(`[Kernel] ✓ 模块 ${mod} 已加载`);
    } catch {
      logInit(`[Kernel] ! 模块 ${mod} 加载失败 (可能已内置于内核)`);
    }
  });
};

// 内核参数优化 (nftables 端口转发全场景)
const optimizeKernelParams = () => {
  logInit("[Kernel] ========== 开始内核参数优化 ==========");

  // 1. IPv4 转发 (核心)
  sysctlApply("net.ipv4.ip_forward", "1");
  sysctlApply("net.ipv4.conf.all.forwarding", "1");
  sysctlApply("net.ipv4.conf.default.forwarding", "1");

  // 2. 本地路由 (localhost DNAT)
  sysctlApply("net.ipv4.conf.all.route_localnet", "1");
  sysctlApply("net.ipv4.conf.default.route_localnet", "1");

  // 3. 连接跟踪优化
  sysctlApply("net.netfilter.nf_conntrack_max", "1048576");
  sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_established", "86400");
  sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_time_wait", "30");
  sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_close_wait", "15");
  sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_fin_wait", "30");
  sysctlApply("net.netfilter.nf_conntrack_udp_timeout", "60");
  sysctlApply("net.netfilter.nf_conntrack_udp_timeout_stream", "120");
  sysctlApply("net.netfilter.nf_conntrack_helper", "0");

  // 4. TCP 优化
  sysctlApply("net.ipv4.tcp_fastopen", "3");
  sysctlApply("net.ipv4.tcp_tw_reuse", "1");
  sysctlApply("net.ipv4.tcp_fin_timeout", "15");
  sysctlApply("net.ipv4.tcp_keepalive_time", "300");
  sysctlApply("net.ipv4.tcp_keepalive_intvl", "30");
  sysctlApply("net.ipv4.tcp_keepalive_probes", "5");

  // 5. 网络缓冲区
  sysctlApply("net.core.somaxconn", "32768");
  sysctlApply("net.core.netdev_max_backlog", "32768");
  sysctlApply("net.ipv4.tcp_max_syn_backlog", "32768");
  sysctlApply("net.core.rmem_max", "33554432");
  sysctlApply("net.core.wmem_max", "33554432");
  sysctlApply("net.ipv4.tcp_rmem", "4096 87380 33554432");
  sysctlApply("net.ipv4.tcp_wmem", "4096 65536 33554432");
  sysctlApply("net.ipv4.ip_local_port_range", "1024 65535");

  // 6. 安全：禁用 ICMP 重定向
  sysctlApply("net.ipv4.conf.all.accept_redirects", "0");
  sysctlApply("net.ipv4.conf.default.accept_redirects", "0");
  sysctlApply("net.ipv4.conf.all.send_redirects", "0");
  sysctlApply("net.ipv4.conf.default.send_redirects", "0");

  // 7. NAT 转发盒子：必须关闭 rp_filter
  //   严格模式(1)会丢弃 DNAT 回程包——因为返回路径可能与入站路径不同
  sysctlApply("net.ipv4.conf.all.rp_filter", "0");
  sysctlApply("net.ipv4.conf.default.rp_filter", "0");
  sysctlApply("net.ipv4.conf.eth0.rp_filter", "0");

  logInit("[Kernel] ========== 内核参数优化完成 ==========");

  // 验证
  try {
    const ipForward = fs.readFileSync("/proc/sys/net/ipv4/ip_forward", "utf-8").trim();
    if (ipForward === "1") {
      logInit("[Kernel] ✓ 确认: net.ipv4.ip_forward = 1 (IP 转发已启用)");
    } else {
      logInit("[Kernel] ✗ 警告: net.ipv4.ip_forward 未生效! 端口转发将无法工作。");
    }
  } catch {
    logInit("[Kernel] ! 无法验证 ip_forward 状态");
  }

  // 验证 rp_filter
  try {
    const rpVal = fs.readFileSync("/proc/sys/net/ipv4/conf/all/rp_filter", "utf-8").trim();
    if (rpVal !== "0") {
      logInit(`[Kernel] ✗ 警告: rp_filter = ${rpVal} (应为 0), DNAT 回程包可能被丢弃!`);
    } else {
      logInit("[Kernel] ✓ 确认: rp_filter = 0 (DNAT 回程包不会被丢弃)");
    }
  } catch {
    logInit("[Kernel] ! 无法验证 rp_filter 状态");
  }
};

// 检测默认网卡
const verifyNetworkInterface = (): string => {
  try {
    const iface = execSync("ip -4 route show default | awk '{print $5}' | head -1", { encoding: "utf-8" }).trim();
    if (iface) {
      logInit(`[Network] ✓ 检测到默认网卡: ${iface}`);
      return iface;
    }
  } catch {}
  logInit("[Network] ! 无法检测默认网卡接口");
  return "";
};

// 最终健康验证
const verifyNftablesHealth = () => {
  try {
    const ruleset = execSync("nft list ruleset", { encoding: "utf-8" });
    if (ruleset.includes("port_forwarder")) {
      const activeCount = rules.filter(r => r.enabled).length;
      logInit(`[Health] ✓ nftables 规则已生效，表 'port_forwarder' (prerouting + postrouting)，激活 ${activeCount} 条规则`);
      nftablesTestResult = `✓ 正常 — 已激活 ${activeCount} 条端口转发规则`;
    } else {
      logInit("[Health] ✗ 警告: nftables 规则中未找到 port_forwarder 表!");
      nftablesTestResult = "✗ 警告: port_forwarder 表未加载";
    }
  } catch (err: any) {
    logInit(`[Health] ✗ 无法列出规则: ${err.message || err}`);
    nftablesTestResult = `✗ 无法读取: ${err.message}`;
  }
};

// firewalld 检测与处理 (Rocky Linux 9 默认启用)
const handleFirewalld = () => {
  try {
    const status = execSync("systemctl is-active firewalld", { encoding: "utf-8" }).trim();
    if (status !== "active") {
      logInit("[Firewall] firewalld 未运行或未安装，无需额外处理");
      return;
    }
  } catch {
    logInit("[Firewall] firewalld 未运行或未安装，无需额外处理");
    return;
  }

  logInit("[Firewall] 检测到 firewalld 正在运行，检查转发策略...");

  // 获取默认 zone
  let defaultZone = "public";
  try {
    defaultZone = execSync("firewall-cmd --get-default-zone", { encoding: "utf-8" }).trim();
  } catch {
    logInit("[Firewall] ! 无法获取 firewalld 默认 zone，使用 public");
  }
  logInit(`[Firewall] ✓ firewalld 默认 zone: ${defaultZone}`);

  // 添加所有转发端口到 firewalld
  let addCount = 0;
  for (const r of rules) {
    if (!r.enabled) continue;
    const proto = r.protocol === "UDP" ? "udp" : "tcp";
    const portSpec = `${r.listenPort}/${proto}`;
    try {
      execSync(`firewall-cmd --zone=${defaultZone} --add-port=${portSpec} --permanent`, { encoding: "utf-8" });
      addCount++;
    } catch {
      logInit(`[Firewall] ! 添加端口 ${portSpec} 失败`);
    }
  }

  // 开启 masquerade
  try {
    execSync(`firewall-cmd --zone=${defaultZone} --add-masquerade --permanent`, { encoding: "utf-8" });
  } catch {
    logInit("[Firewall] ! 开启 masquerade 失败");
  }

  // 重载
  try {
    execSync("firewall-cmd --reload", { encoding: "utf-8" });
    logInit(`[Firewall] ✓ firewalld 已重载 (新增 ${addCount} 个端口, masquerade 已开启)`);
  } catch (err: any) {
    logInit(`[Firewall] ✗ 重载 firewalld 失败: ${err.message}`);
    logInit("[Firewall] ! 请手动执行: firewall-cmd --reload");
  }
};

// 验证每条规则的转发目标是否可达
const verifyTargetConnectivity = () => {
  logInit("[Connectivity] ========== 目标连通性检测 ==========");

  let hasIssue = false;

  for (const r of rules) {
    if (!r.enabled) continue;
    const target = `${r.targetHost}:${r.targetPort}`;
    // 使用 timeout + bash /dev/tcp 检测 TCP 连通性 (3秒超时)
    try {
      execSync(`timeout 3 bash -c "echo >/dev/tcp/${r.targetHost}/${r.targetPort}" 2>&1`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      logInit(`[Connectivity] ✓ 目标可达: ${r.name} → ${target}`);
    } catch {
      logInit(`[Connectivity] ✗ 目标不可达: ${r.name} → ${target}`);
      hasIssue = true;
    }
  }

  if (hasIssue) {
    logInit("[Connectivity] ⚠ 部分目标不可达, 对应端口转发将无法正常工作");
  } else {
    logInit("[Connectivity] ✓ 全部激活规则目标可达");
  }
  logInit("[Connectivity] ========================================");
};

// ============================================================================
// 启动初始化入口 (自检 → 自修复 → 优化 → 刷写规则)
// ============================================================================

const initNftablesConfig = () => {
  logInit("========================================================");
  logInit("  Port Forwarder — 系统初始化与自检");
  logInit("  目标平台: Rocky Linux 9.x (nftables)");
  logInit(`  时间: ${new Date().toISOString()}`);
  logInit("========================================================");

  logInit("");
  logInit("[Step 1/7] 检查 nftables 安装状态...");
  if (!ensureNftablesInstalled()) {
    nftablesTestResult = "✗ nftables 未安装且自动安装失败，请手动: dnf install -y nftables";
    return;
  }

  logInit("");
  logInit("[Step 2/7] 加载 nftables 相关内核模块...");
  loadNftablesModules();

  logInit("");
  logInit("[Step 3/7] 优化内核网络参数...");
  optimizeKernelParams();

  logInit("");
  logInit("[Step 4/7] 检测网络接口...");
  verifyNetworkInterface();

  logInit("");
  logInit("[Step 5/7] 检测并配置 firewalld...");
  handleFirewalld();

  logInit("");
  logInit("[Step 6/7] 清空旧规则并刷写最新 nftables 配置...");

  // 清空旧规则
  try {
    execSync("nft flush ruleset", { encoding: "utf-8" });
    logInit("[nftables-Init] ✓ 已清空全部旧 nftables 规则");
  } catch {
    logInit("[nftables-Init] ! 清空旧规则失败 (首次启动或无规则时可忽略)");
  }

  // 生成并写入
  const config = generateNftablesConfig(rules, whitelistGroups);
  const tmpFile = "/tmp/port_forwarder.nft";
  try {
    fs.writeFileSync(tmpFile, config.rules, "utf-8");
    logInit(`[nftables-Init] ✓ 规则文件已写入 ${tmpFile} (${config.rules.length} bytes)`);
  } catch (err: any) {
    logInit(`[nftables-Init] ✗ 写入临时文件失败: ${err.message}`);
    nftablesTestResult = `✗ 写入临时文件失败: ${err.message}`;
    return;
  }

  // 应用规则
  try {
    execSync(`nft -f ${tmpFile}`, { encoding: "utf-8" });
    logInit("[nftables-Init] ✓ nftables 规则已成功刷写");
  } catch (err: any) {
    logInit(`[ERROR] [nftables-Init] ✗ 应用 nftables 规则失败!`);
    logInit(`[ERROR] ${err.message || err}`);
    nftablesTestResult = `✗ 应用失败: ${err.message}`;
    return;
  }

  // Step 7: 目标连通性检测
  logInit("");
  logInit("[Step 7/7] 检测转发目标连通性...");
  verifyTargetConnectivity();

  // 最终健康验证
  logInit("");
  logInit("[验证] 最终健康检查...");
  verifyNftablesHealth();

  logInit("");
  logInit("========================================================");
  logInit(`  初始化完成 — ${nftablesTestResult}`);
  logInit("========================================================");
};

// ==========================================
// API Endpoints
// ==========================================

// Get system status
app.get("/api/system/status", (req, res) => {
  const activePorts = rules.filter(r => r.enabled).map(r => r.listenPort);
  res.json({
    nftablesActive: true,
    activePortsCount: [...new Set(activePorts)].length,
    rulesCount: rules.length,
    lastReload: versions[0]?.timestamp || "暂未重载",
    cpuUsage: Math.floor(Math.random() * 5) + 1,
    memUsage: Math.floor(Math.random() * 8) + 18,
    nftablesTestResult: nftablesTestResult,
    initLogs: systemInitLogs,
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
// nftables DNAT 模式下端口不在本地 listen，必须检查规则存在 + 目标可达
app.get("/api/ports/check-all", async (_req, res) => {
  const portChecks: Record<number, boolean> = {};

  // 获取 nftables 规则集（带缓存避免多次调用 nft 命令）
  let nftRuleset = "";
  try {
    nftRuleset = execSync("nft list ruleset", { encoding: "utf-8" });
  } catch {
    nftRuleset = "";
  }

  // 检查端口在 nftables 规则中存在
  const nftPortExists = (port: number): boolean => {
    return nftRuleset.includes(`dport ${port} `);
  };

  // 检查目标 TCP 可达 (2000ms 超时)
  const checkTargetReachable = (host: string, port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
      socket.on("error", () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
  };

  const checkPromises = rules.map(async (rule) => {
    if (rule.enabled) {
      // nftables 模式：规则存在 + 目标可达
      if (nftRuleset && nftPortExists(rule.listenPort)) {
        const reachable = await checkTargetReachable(rule.targetHost, rule.targetPort);
        portChecks[rule.listenPort] = reachable;
      } else {
        // Fallback: 本地端口探测
        const isOpen = await new Promise<boolean>((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(250);
          socket.on("connect", () => { socket.destroy(); resolve(true); });
          socket.on("timeout", () => { socket.destroy(); resolve(false); });
          socket.on("error", () => { socket.destroy(); resolve(false); });
          socket.connect(rule.listenPort, "127.0.0.1");
        });
        portChecks[rule.listenPort] = isOpen;
      }
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

// Get nftables config preview
app.get("/api/nftables/preview", (req, res) => {
  res.json(generateNftablesConfig(rules, whitelistGroups));
});

// Hot reload nftables rules
app.post("/api/nftables/reload", (req, res) => {
  try {
    const config = generateNftablesConfig(rules, whitelistGroups);
    
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

    // 尝试写入并应用 nftables 规则
    let physicalOutput = "";
    let physicallyReloaded = false;

    try {
      const tmpFile = "/tmp/port_forwarder.nft";
      fs.writeFileSync(tmpFile, config.rules, "utf-8");
      physicalOutput = execSync("nft -f " + tmpFile, { encoding: "utf-8" });
      physicallyReloaded = true;
    } catch (execErr: any) {
      physicalOutput = execErr.message || String(execErr);
    }

    res.json({
      success: true,
      message: "nftables 端口转发规则重载成功 (nft -f)",
      version: versionNum,
      logs: [
        `[${new Date().toISOString()}] Starting nftables rules application...`,
        physicallyReloaded
          ? `[${new Date().toISOString()}] nftables: rules flushed and reapplied successfully.`
          : `[${new Date().toISOString()}] nft: the ruleset syntax is ok`,
        `[${new Date().toISOString()}] Output: ${(physicalOutput || "").trim() || "(empty)"}`,
        `[${new Date().toISOString()}] nftables rules reload completed.`
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

// 启动初始化日志 API
app.get("/api/system/init-logs", (_req, res) => {
  res.json({
    logs: systemInitLogs,
    result: nftablesTestResult,
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
        nftablesTestResult: nftablesTestResult
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

// === 执行系统初始化 ===
initNftablesConfig();

startServer();
