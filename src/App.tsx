import React, { useState, useEffect, useRef } from "react";
import { ForwardRule, ConfigVersion, SystemStatus, AppSettings, WhitelistGroup } from "./types";
import ForwardRulesTable from "./components/ForwardRulesTable";
import RuleFormModal from "./components/RuleFormModal";
import WhitelistGroupsPanel from "./components/WhitelistGroupsPanel";
import NftablesPreviewPane from "./components/NginxPreviewPane";

import {
  ArrowRightLeft,
  ShieldCheck,
  Terminal as TerminalIcon,
  Plus,
  RefreshCw,
  LogOut,
  Sliders,
  CheckCircle,
  XCircle,
  Activity,
  RotateCcw,
  X,
  Settings as SettingsIcon,
  Lock,
  Globe,
  Database,
  Monitor,
  Copy,
  Check
} from "lucide-react";

export default function App() {
  // Authentication states
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => {
    return localStorage.getItem("nginx_forwarder_isLoggedIn") === "true";
  });
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  // Main UI states
  const [activeTab, setActiveTab] = useState<"rules" | "shell" | "settings" | "whitelist">("rules");
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  
  // Settings state
  const [localIp, setLocalIp] = useState("127.0.0.1");
  const [domain, setDomain] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Whitelist groups state
  const [whitelistGroups, setWhitelistGroups] = useState<WhitelistGroup[]>([]);

  // Port statuses state
  const [portStatuses, setPortStatuses] = useState<Record<number, boolean>>({});
  const [isCheckingPorts, setIsCheckingPorts] = useState(false);

  // System metrics status
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    nftablesActive: true,
    activePortsCount: 0,
    rulesCount: 0,
    lastReload: "暂未重载",
    cpuUsage: 2,
    memUsage: 19
  });

  const [previews, setPreviews] = useState<{ rules: string }>({ rules: "" });
  const [recommendedPorts, setRecommendedPorts] = useState<number[]>([]);
  const [usedPorts, setUsedPorts] = useState<number[]>([]);

  // Modal control
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ForwardRule | undefined>(undefined);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);

  // Embedded Shell & popup terminal states
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [isReloading, setIsReloading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [cmdInput, setCmdInput] = useState("");
  const [embeddedLogs, setEmbeddedLogs] = useState<string[]>([
    "=== 瑞驰网络智能诊断终端 v2.0 ===",
    "系统初始化完成。默认处于沙箱特权模式。",
    '键入 "help" 可以查看可用的系统命令列表。',
    "========================================="
  ]);
  const [embeddedCmdInput, setEmbeddedCmdInput] = useState("");
  
  const wsRef = useRef<WebSocket | null>(null);
  const embeddedLogsEndRef = useRef<HTMLDivElement | null>(null);

  // General Toast message state
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Auto-scroll embedded terminal logs
  useEffect(() => {
    if (embeddedLogsEndRef.current) {
      embeddedLogsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [embeddedLogs]);

  // Fetch settings from API
  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data: AppSettings = await res.json();
        setLocalIp(data.localIp || "127.0.0.1");
        setDomain(data.domain || "");
      }
    } catch (err) {
      console.error("Error fetching settings:", err);
    }
  };

  // Fetch whitelist groups from API
  const fetchWhitelistGroups = async () => {
    try {
      const res = await fetch("/api/whitelist-groups");
      if (res.ok) {
        const data = await res.json();
        setWhitelistGroups(data);
      }
    } catch (err) {
      console.error("Error fetching whitelist groups:", err);
    }
  };

  // Add whitelist group
  const handleAddWhitelistGroup = async (group: Omit<WhitelistGroup, "id" | "createdAt" | "updatedAt">): Promise<boolean> => {
    try {
      const res = await fetch("/api/whitelist-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(group),
      });
      if (res.ok) {
        showToast("白名单组创建成功", "success");
        fetchWhitelistGroups();
        return true;
      }
    } catch (err) {
      console.error("Error adding whitelist group:", err);
    }
    return false;
  };

  // Update whitelist group
  const handleUpdateWhitelistGroup = async (id: string, group: Omit<WhitelistGroup, "id" | "createdAt" | "updatedAt">): Promise<boolean> => {
    try {
      const res = await fetch(`/api/whitelist-groups/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(group),
      });
      if (res.ok) {
        showToast("白名单组更新成功，正在自动热重载使规则生效...", "success");
        fetchWhitelistGroups();
        // 后端已自动同步绑定规则的 IP 列表，刷新规则数据然后热重载
        fetchData();
        await handleHotReload(true);
        return true;
      }
    } catch (err) {
      console.error("Error updating whitelist group:", err);
    }
    return false;
  };

  // Delete whitelist group
  const handleDeleteWhitelistGroup = async (id: string) => {
    try {
      const res = await fetch(`/api/whitelist-groups/${id}`, { method: "DELETE" });
      if (res.ok) {
        showToast("白名单组已删除，正在自动热重载使变更生效...", "success");
        fetchWhitelistGroups();
        // 删除组后绑定规则的 allowedIps 仍保留，但命名集合被移除，规则需重载
        fetchData();
        await handleHotReload(true);
      }
    } catch (err) {
      console.error("Error deleting whitelist group:", err);
    }
  };

  // Fetch Port Check status
  const checkPortsStatus = async () => {
    setIsCheckingPorts(true);
    try {
      const res = await fetch("/api/ports/check-all");
      if (res.ok) {
        const data = await res.json();
        setPortStatuses(data);
        showToast("实时物理端口连通性检查完毕", "success");
      } else {
        showToast("端口状态检查失败", "error");
      }
    } catch (err) {
      showToast("无法连接检测接口", "error");
    } finally {
      setIsCheckingPorts(false);
    }
  };

  // Fetch initial console data
  const fetchData = async () => {
    try {
      const [rulesRes, versionsRes, statusRes, portsRes, previewRes] = await Promise.all([
        fetch("/api/rules"),
        fetch("/api/versions"),
        fetch("/api/system/status"),
        fetch("/api/ports/status"),
        fetch("/api/nftables/preview")
      ]);

      if (rulesRes.ok) setRules(await rulesRes.json());
      if (versionsRes.ok) setVersions(await versionsRes.json());
      if (statusRes.ok) setSystemStatus(await statusRes.json());
      if (portsRes.ok) {
        const portData = await portsRes.json();
        setRecommendedPorts(portData.recommendations);
        setUsedPorts(portData.usedPorts);
      }
      if (previewRes.ok) setPreviews(await previewRes.json());
    } catch (err) {
      console.error("Error fetching data:", err);
    }
  };

  // Send CLI diagnostics command from the quick reload popup terminal
  const sendCLICommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cmdInput.trim()) return;
    
    const command = cmdInput.trim();
    setTerminalLogs(prev => [...prev, `\n$ ${command}`]);
    setCmdInput("");

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "command", command }));
    } else {
      setTerminalLogs(prev => [...prev, "错误: 终端 WebSocket 连接已断开，无法发送指令。"]);
    }
  };

  // Send CLI diagnostics command from the full embedded tab shell
  const sendEmbeddedCLICommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!embeddedCmdInput.trim()) return;
    
    const command = embeddedCmdInput.trim();
    setEmbeddedLogs(prev => [...prev, `admin@ruichi-gateway:~$ ${command}`]);
    setEmbeddedCmdInput("");

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "command", command }));
    } else {
      // HTTP fallback if websocket is not ready yet
      fetchDiagnosticCommandHttp(command);
    }
  };

  // HTTP Fallback Executor for terminal tab
  const fetchDiagnosticCommandHttp = async (command: string) => {
    setEmbeddedLogs(prev => [...prev, "[正在执行 HTTP 通道 fallback 诊断...]"]);
    try {
      const res = await fetch("/api/system/status"); // quick ping to ensure online
      if (res.ok) {
        setEmbeddedLogs(prev => [
          ...prev,
          `已向系统网关发出指令: "${command}"。`,
          "警告: 实时终端通道暂时处于轮询重连中，建议刷新页面建立 WebSocket 专线以获得完整双向 shell 体验。"
        ]);
      }
    } catch (e) {
      setEmbeddedLogs(prev => [...prev, "无法连通网关，物理网络阻断。"]);
    }
  };

  // Quick executor buttons for terminal tab
  const runQuickCommand = (cmd: string) => {
    setEmbeddedLogs(prev => [...prev, `admin@ruichi-gateway:~$ ${cmd}`]);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "command", command: cmd }));
    } else {
      fetchDiagnosticCommandHttp(cmd);
    }
  };

  // WebSocket Live Sync Hook
  useEffect(() => {
    if (!isLoggedIn) return;

    let ws: WebSocket | null = null;
    let reconnectTimeout: any = null;

    const connectWS = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      
      console.log(`[WS] Connecting to ${wsUrl}`);
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WS] Connected successfully");
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log("[WS] Received message type:", message.type);
          
          if (message.type === "initial") {
            const { rules, versions } = message.payload;
            if (rules) setRules(rules);
            if (versions) setVersions(versions);
          } else if (message.type === "update:rules") {
            setRules(message.payload);
            fetch("/api/nftables/preview").then(res => res.ok && res.json().then(setPreviews));
            fetch("/api/ports/status").then(res => res.ok && res.json().then(data => {
              setRecommendedPorts(data.recommendations);
              setUsedPorts(data.usedPorts);
            }));
          } else if (message.type === "update:versions") {
            setVersions(message.payload);
          } else if (message.type === "terminal") {
            // Distribute outputs to matching logs
            setTerminalLogs(prev => [...prev, message.payload]);
            setEmbeddedLogs(prev => [...prev, message.payload]);
          }
        } catch (err) {
          console.error("[WS] Parse message error:", err);
        }
      };

      ws.onclose = () => {
        console.log("[WS] Connection lost, scheduling reconnect...");
        setWsConnected(false);
        wsRef.current = null;
        reconnectTimeout = setTimeout(connectWS, 3000);
      };

      ws.onerror = (err) => {
        console.warn("[WS] Connection warning:", err);
        ws?.close();
      };
    };

    connectWS();
    fetchSettings();
    fetchWhitelistGroups();
    fetchData();

    // Trigger initial port status check
    setTimeout(() => {
      checkPortsStatus();
    }, 1000);

    return () => {
      if (ws) ws.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [isLoggedIn]);

  // Conditional Fallback Polling Hook for active session
  useEffect(() => {
    if (!isLoggedIn) return;
    fetchData();

    if (wsConnected) return; // WebSocket is active, don't poll!

    const interval = setInterval(() => {
      fetchData();
    }, 6000);

    return () => clearInterval(interval);
  }, [isLoggedIn, wsConnected]);

  // Handle Login submission
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");

    if (!loginUsername.trim() || !loginPassword.trim()) {
      setLoginError("账号和密码不能为空");
      return;
    }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUsername, password: loginPassword })
      });

      if (!res.ok) {
        const data = await res.json();
        setLoginError(data.error || "账号或密码不正确");
        return;
      }

      localStorage.setItem("nginx_forwarder_isLoggedIn", "true");
      setIsLoggedIn(true);
      showToast("系统登录成功，已授权系统管理员权限", "success");
    } catch (err) {
      setLoginError("连接服务器鉴权接口失败");
    }
  };

  // Handle Log Out
  const handleLogout = () => {
    localStorage.removeItem("nginx_forwarder_isLoggedIn");
    setIsLoggedIn(false);
    setLoginUsername("");
    setLoginPassword("");
    setLoginError("");
    showToast("您已成功退出当前运维会话", "success");
  };

  // Save IP and Domain settings
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingSettings(true);

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localIp, domain })
      });

      if (res.ok) {
        showToast("本机 IP 与域名设置已更新并固化", "success");
        // Update live preview configurations as well
        const prevRes = await fetch("/api/nftables/preview");
        if (prevRes.ok) setPreviews(await prevRes.json());
      } else {
        showToast("保存设置失败", "error");
      }
    } catch (err) {
      showToast("保存设置时网络请求失败", "error");
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Save / Edit Rule
  const handleSaveRule = async (ruleData: any): Promise<boolean> => {
    try {
      const url = editingRule ? `/api/rules/${editingRule.id}` : "/api/rules";
      const method = editingRule ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ruleData)
      });

      if (!res.ok) {
        const errData = await res.json();
        showToast(errData.error || "保存端口配置失败", "error");
        return false;
      }

      showToast(editingRule ? "规则修改成功，正在自动热重载使规则生效..." : "规则创建成功，正在自动热重载使规则生效...", "success");
      fetchData();
      checkPortsStatus();
      
      // Auto reload nftables after save (strict validation done server-side)
      await handleHotReload(true);
      return true;
    } catch (err: any) {
      showToast("网络请求发生错误", "error");
      return false;
    }
  };

  // Handle Delete Rule (restricted to admin/always admin now)
  const handleDeleteRule = async (id: string) => {
    if (!window.confirm("确定要删除此条转发规则吗？此操作不可撤销且将清除物理映射状态！")) {
      return;
    }

    try {
      const res = await fetch(`/api/rules/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" }
      });

      if (!res.ok) {
        const errData = await res.json();
        showToast(errData.error || "删除失败", "error");
        return;
      }

      showToast("规则已删除，正在自动热重载使变更生效...", "success");
      fetchData();
      checkPortsStatus();
      await handleHotReload(true);
    } catch (err) {
      showToast("删除操作失败", "error");
    }
  };

  // Handle Duplicate Rule
  const handleDuplicateRule = async (rule: ForwardRule) => {
    try {
      const duplicateData = {
        name: `${rule.name} - 副本`,
        listenPort: rule.listenPort,
        targetHost: rule.targetHost,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        enabled: false, // always duplicate as disabled to avoid port conflicts
        description: rule.description ? `${rule.description} (副本)` : "规则副本",
        allowedIps: rule.allowedIps
      };

      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(duplicateData)
      });

      if (!res.ok) {
        const errData = await res.json();
        showToast(errData.error || "复制规则副本失败", "error");
        return;
      }

      showToast("规则副本创建成功，正在自动热重载...", "success");
      fetchData();
      checkPortsStatus();
      await handleHotReload(true);
    } catch (err) {
      showToast("复制操作失败", "error");
    }
  };

  // Handle Quick Toggle Rule State
  const handleToggleRule = async (rule: ForwardRule) => {
    try {
      const res = await fetch(`/api/rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...rule,
          enabled: !rule.enabled
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        showToast(errData.error || "切换状态失败", "error");
        return;
      }

      showToast(`规则 [${rule.name}] 已${!rule.enabled ? "启用" : "禁用"}，正在自动热重载...`, "success");
      fetchData();
      checkPortsStatus();
      await handleHotReload(true);
    } catch (err) {
      showToast("操作失败", "error");
    }
  };

  // Trigger nftables smooth hot reload (silent mode for auto-reload after rule changes)
  const handleHotReload = async (silent: boolean = false) => {
    if (!silent) {
      setIsReloading(true);
      setTerminalLogs([`[${new Date().toLocaleTimeString()}] 连接配置管理服务 API ...`]);
      setIsTerminalOpen(true);
    }

    try {
      const res = await fetch("/api/nftables/reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      if (!res.ok) {
        const errData = await res.json();
        if (!silent) {
          setTerminalLogs(prev => [
            ...prev,
            `[${new Date().toLocaleTimeString()}] ❌ 权限错误或服务重载异常!`,
            `[${new Date().toLocaleTimeString()}] 错误信息: ${errData.error || "物理进程加载拦截"}`
          ]);
        }
        showToast(errData.error || "nftables 服务热重载指令执行被拒", "error");
        return;
      }

      const data = await res.json();
      if (!silent) {
        setTerminalLogs(prev => [...prev, ...data.logs]);
      }
      showToast(`nftables 规则热重载成功，备份版本号 v${data.version}`, "success");
      fetchData();
      checkPortsStatus();
    } catch (err: any) {
      if (!silent) {
        setTerminalLogs(prev => [
          ...prev,
          `[${new Date().toLocaleTimeString()}] ❌ 网络通讯故障，重载请求未送达。`
        ]);
      }
      showToast("热重载通讯失败", "error");
    } finally {
      if (!silent) setIsReloading(false);
    }
  };

  // Handle Snapshot Rollback
  const handleRollback = async (versionId: string) => {
    if (!window.confirm("确定要将当前所有转发规则回滚至选中的历史快照吗？这会覆盖当前的表格状态！")) {
      return;
    }

    try {
      const res = await fetch("/api/versions/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId })
      });

      if (!res.ok) {
        const errData = await res.json();
        showToast(errData.error || "配置回滚失败", "error");
        return;
      }

      const data = await res.json();
      showToast(data.message, "success");
      fetchData();
      checkPortsStatus();
    } catch (err) {
      showToast("回滚请求失败", "error");
    }
  };

  // Handle system reset (Admin only helper)
  const handleSystemReset = async () => {
    if (!window.confirm("⚠️ 警告：此操作会清空所有历史备份版本并重置配置至默认值！是否确认继续？")) {
      return;
    }

    try {
      const res = await fetch("/api/system/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      if (!res.ok) {
        const errData = await res.json();
        showToast(errData.error || "重置失败", "error");
        return;
      }

      showToast("控制台配置数据已重置到初始状态", "success");
      fetchData();
      checkPortsStatus();
    } catch (err) {
      showToast("重置网络请求发生故障", "error");
    }
  };

  // Render Login state overlay
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col justify-center items-center p-4 selection:bg-indigo-500 selection:text-white font-sans" id="login-container">
        <div className="w-full max-w-md bg-slate-950 rounded-2xl shadow-2xl border border-slate-800 p-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex p-3.5 bg-indigo-600/15 rounded-2xl border border-indigo-500/20 text-indigo-400 mb-2">
              <ArrowRightLeft className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-extrabold text-white tracking-tight">Port Forwarder</h2>
            <p className="text-xs text-slate-400">基于 nftables 的智能端口转发集中管理安全控制台</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4 pt-1" id="login-form">
            {loginError && (
              <div className="p-3 bg-rose-950/40 border border-rose-900/40 text-rose-300 text-xs rounded-lg flex items-center gap-2">
                <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{loginError}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-400 block">管理员账号</label>
              <div className="relative">
                <input
                  type="text"
                  id="login-username"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="请输入账号"
                  className="w-full bg-slate-900/60 text-slate-100 border border-slate-800 rounded-lg px-3.5 py-2 text-sm placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/80 transition-all"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-400 block">安全验证密码</label>
              <div className="relative">
                <input
                  type="password"
                  id="login-password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="请输入密码"
                  className="w-full bg-slate-900/60 text-slate-100 border border-slate-800 rounded-lg px-3.5 py-2 text-sm placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/80 transition-all"
                />
              </div>
            </div>

            <button
              type="submit"
              id="login-submit-btn"
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg text-sm transition-all shadow-md hover:shadow-lg shadow-indigo-600/10 hover:shadow-indigo-600/25 cursor-pointer mt-2"
            >
              登 录
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Render Logged in Interface
  return (
    <div className="h-screen bg-slate-50 flex flex-col font-sans overflow-hidden" id="app-root-container">
      {/* Toast Notification */}
      {toast && (
        <div
          id="system-toast"
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg border transition-all animate-bounce ${
            toast.type === "success"
              ? "bg-emerald-50 border-emerald-100 text-emerald-800"
              : "bg-rose-50 border-rose-100 text-rose-800"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle className="h-4.5 w-4.5 text-emerald-600 shrink-0" />
          ) : (
            <XCircle className="h-4.5 w-4.5 text-rose-600 shrink-0" />
          )}
          <span className="text-xs font-semibold">{toast.message}</span>
        </div>
      )}

      {/* Primary Top Header Bar */}
      <header className="bg-slate-900 text-white py-3.5 px-6 border-b border-slate-800 flex items-center justify-between shadow-sm shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="bg-indigo-600 p-2 rounded-lg text-white">
            <ArrowRightLeft className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight">Port Forwarder</h1>
            <p className="text-[10px] text-slate-400">可视化端口映射与 nftables 规则安全运维工作台</p>
          </div>
        </div>

        {/* Current Admin user header */}
        <div className="flex items-center gap-3 bg-slate-800/60 p-1.5 pl-3 pr-3.5 rounded-full border border-slate-800">
          <div className="text-right">
            <div className="text-xs font-bold text-slate-100">admin</div>
            <div className="text-[10px] text-slate-400 flex items-center gap-1 justify-end">
              <ShieldCheck className="h-3 w-3 text-indigo-400" />
              <span>特权系统管理员</span>
            </div>
          </div>
          <div className="w-8 h-8 rounded-full bg-indigo-600/85 flex items-center justify-center font-bold text-white text-xs border border-indigo-500/30">
            AD
          </div>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left Sidebar Menu */}
        <aside className="w-full md:w-64 bg-slate-900 border-r border-slate-800/80 p-4 space-y-5 flex flex-col shrink-0 text-white justify-between">
          <div className="space-y-5">
            {/* Main Controls Section */}
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider px-2 mb-2">主控制面板</div>
              
              <button
                id="sidebar-tab-rules"
                onClick={() => setActiveTab("rules")}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                  activeTab === "rules"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <Sliders className="h-4 w-4" />
                <span>配置规则管理</span>
                {rules.length > 0 && (
                  <span className="ml-auto bg-slate-800 text-slate-300 text-[10px] px-1.5 py-0.2 rounded font-mono">
                    {rules.length}
                  </span>
                )}
              </button>

              <button
                id="sidebar-tab-shell"
                onClick={() => setActiveTab("shell")}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                  activeTab === "shell"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <TerminalIcon className="h-4 w-4" />
                <span>系统诊断终端</span>
              </button>

              <button
                id="sidebar-tab-settings"
                onClick={() => setActiveTab("settings")}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                  activeTab === "settings"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <SettingsIcon className="h-4 w-4" />
                <span>运行参数设置</span>
              </button>

              <button
                id="sidebar-tab-whitelist"
                onClick={() => setActiveTab("whitelist")}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                  activeTab === "whitelist"
                    ? "bg-indigo-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                <span>白名单组管理</span>
                {whitelistGroups.length > 0 && (
                  <span className="ml-auto bg-slate-800 text-slate-300 text-[10px] px-1.5 py-0.2 rounded font-mono">
                    {whitelistGroups.length}
                  </span>
                )}
              </button>
            </div>

            {/* Real-time System Status Dashboard widget */}
            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800/65 space-y-3">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300 border-b border-slate-800/60 pb-1.5">
                <Activity className="h-3.5 w-3.5 text-indigo-400" />
                <span>系统运行监控指标</span>
              </div>

              <div className="space-y-2 text-[11px] text-slate-400">
                <div className="flex justify-between items-center">
                  <span>进程状态</span>
                  <span className="inline-flex items-center gap-1 text-emerald-400 font-bold">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    正常 (Up)
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span>物理机公网IP</span>
                  <span className="font-mono text-slate-300 bg-slate-900 border border-slate-800/80 px-1 py-0.5 rounded text-[10px] truncate max-w-[100px]">
                    {localIp}
                  </span>
                </div>

                {domain && (
                  <div className="flex justify-between items-center">
                    <span>系统绑定域名</span>
                    <span className="font-mono text-slate-300 bg-slate-900 border border-slate-800/80 px-1 py-0.5 rounded text-[10px] truncate max-w-[100px]" title={domain}>
                      {domain}
                    </span>
                  </div>
                )}

                <div className="flex justify-between items-center">
                  <span>激活端口数</span>
                  <span className="font-mono text-slate-200 font-bold">{rules.filter(r => r.enabled).length} / {rules.length} 条</span>
                </div>

                {/* nftables 健康状态 */}
                <div className="flex justify-between items-start">
                  <span>nftables 状态</span>
                  <span className={`font-mono text-[10px] font-bold max-w-[140px] text-right leading-relaxed ${systemStatus.nftablesTestResult?.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>
                    {systemStatus.nftablesTestResult || "检测中..."}
                  </span>
                </div>

                {/* 初始化日志折叠区 */}
                {systemStatus.initLogs && systemStatus.initLogs.length > 0 && (
                  <details className="text-[9px] text-slate-500 border-t border-slate-800/60 pt-1.5 mt-1">
                    <summary className="cursor-pointer hover:text-slate-300 transition-colors font-bold">
                      启动初始化日志 ({systemStatus.initLogs.filter(l => l.includes("✗") || l.includes("ERROR")).length} 条问题)
                    </summary>
                    <div className="mt-1 max-h-[180px] overflow-y-auto space-y-0.5 font-mono text-[8px] leading-relaxed p-1.5 bg-slate-900 rounded border border-slate-800/60">
                      {systemStatus.initLogs.map((log, i) => {
                        const isError = log.includes("✗") || log.includes("ERROR");
                        const isWarn = log.includes("!") || log.includes("警告");
                        const isOk = log.includes("✓") || log.includes("OK");
                        let colorClass = "text-slate-400";
                        if (isError) colorClass = "text-red-400";
                        else if (isWarn) colorClass = "text-amber-400";
                        else if (isOk) colorClass = "text-emerald-400";
                        return <div key={i} className={colorClass}>{log}</div>;
                      })}
                    </div>
                  </details>
                )}

                <div className="text-[9px] text-slate-500 border-t border-slate-800/60 pt-2 break-words">
                  数据同步机制:<br />
                  <span className="font-mono text-slate-400 flex items-center gap-1 mt-0.5">
                    {wsConnected ? (
                      <>
                        <span className="w-1.5 h-1.5 bg-teal-400 rounded-full animate-pulse" />
                        WebSocket 实时极速推送
                      </>
                    ) : (
                      <>
                        <span className="w-1.5 h-1.5 bg-amber-400 rounded-full" />
                        HTTP 高频轮询备份模式
                      </>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Logout and Reset */}
          <div className="pt-4 border-t border-slate-800/80 space-y-2.5">
            <button
              id="system-reset-btn"
              onClick={handleSystemReset}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-slate-950 hover:bg-rose-950/40 border border-slate-800 text-slate-500 hover:text-rose-400 text-[10px] font-bold rounded-md transition-colors cursor-pointer"
              title="清除自定义配置并还原初始数据"
            >
              <RotateCcw className="h-3 w-3" />
              <span>恢复初始出厂设置</span>
            </button>

            <button
              id="system-logout-btn"
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-1.5 py-2 bg-slate-800 hover:bg-rose-900/30 text-slate-300 hover:text-rose-400 text-xs font-bold rounded-lg transition-colors cursor-pointer border border-slate-700/50"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>注销管理员会话</span>
            </button>
          </div>
        </aside>

        {/* Main Content Pane */}
        <main className="flex-1 overflow-hidden p-4 lg:p-6 bg-slate-50 flex flex-col space-y-4 min-h-0">
          {/* Subheader Controls for Quick actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0 bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div>
              <h2 className="text-base font-bold text-slate-800" id="current-view-title">
                {activeTab === "rules" && "物理转发拓扑规则管理"}
                {activeTab === "shell" && "系统诊断特权终端窗口"}
                {activeTab === "settings" && "本机 IP 与域名全局参数"}
                {activeTab === "whitelist" && "白名单组管理"}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {activeTab === "rules" && "直观管理物理机 TCP、UDP 四层端口映射规则。每次创建或修改规则将自动热重载生效。"}
                {activeTab === "shell" && "在网关设备中直连系统诊断终端，可实时输入标准系统命令以排查网络通信、端口占用及状态。"}
                {activeTab === "settings" && "在此填报机房物理公网 IP 与可用映射域名。配置后，列表地址及 nftables 规则均会自动套用。"}
                {activeTab === "whitelist" && "管理可复用的 IP 白名单组，支持单个 IP 或 CIDR 网段；新建或编辑转发规则时可绑定白名单组。"}
              </p>
            </div>


          </div>

          {/* Active component view router */}
          <div className="flex-1 min-h-0">
            {activeTab === "rules" && (
              <div className="h-full flex flex-col items-stretch min-h-0">
                <ForwardRulesTable
                  rules={rules}
                  onEdit={(rule) => {
                    setEditingRule(rule);
                    setIsFormModalOpen(true);
                  }}
                  onDelete={handleDeleteRule}
                  onToggle={handleToggleRule}
                  onDuplicate={handleDuplicateRule}
                  onCreateRule={() => {
                    setEditingRule(undefined);
                    setIsFormModalOpen(true);
                  }}
                  onShowPreview={() => setIsPreviewModalOpen(true)}
                  currentUserRole="Admin"
                  localIp={localIp}
                  domain={domain}
                  portStatuses={portStatuses}
                  isCheckingPorts={isCheckingPorts}
                  onCheckPorts={checkPortsStatus}
                />
              </div>
            )}

            {activeTab === "shell" && (
              <div className="h-full min-h-[450px] bg-slate-950 rounded-2xl border border-slate-800 flex flex-col overflow-hidden shadow-xl" id="shell-pane-container">
                {/* Embedded Terminal Header */}
                <div className="p-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <TerminalIcon className="h-4.5 w-4.5 text-indigo-400" />
                    <span className="text-xs font-mono font-bold text-slate-100">
                      诊断特权控制台 (Shell Terminal Overlay)
                    </span>
                    <span className="text-[10px] bg-emerald-950 text-emerald-400 px-1.5 py-0.2 rounded border border-emerald-900/60 font-mono">
                      特权模式
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEmbeddedLogs([
                        "=== 瑞驰网络智能诊断终端 v2.0 ===",
                        "系统初始化完成。默认处于沙箱特权模式。",
                        '键入 "help" 可以查看可用的系统命令列表。',
                        "========================================="
                      ])}
                      className="px-2 py-1 text-[10px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 rounded cursor-pointer transition-colors border border-slate-700"
                    >
                      清空输出
                    </button>
                  </div>
                </div>

                <div className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">
                  {/* Embedded Shell Left Logs area */}
                  <div className="flex-1 p-4 bg-black font-mono text-xs text-indigo-300 space-y-2 overflow-y-auto leading-relaxed h-[300px] lg:h-auto select-text">
                    {embeddedLogs.map((line, idx) => (
                      <div key={idx} className="whitespace-pre-wrap break-all">
                        {line}
                      </div>
                    ))}
                    <div ref={embeddedLogsEndRef} />
                  </div>

                  {/* Embedded Shell Right helper action side widgets */}
                  <div className="w-full lg:w-64 bg-slate-900 border-t lg:border-t-0 lg:border-l border-slate-800 p-4 space-y-4 shrink-0 flex flex-col justify-between overflow-y-auto">
                    <div className="space-y-3">
                      <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">终端预设快捷指令</div>
                      <p className="text-[11px] text-slate-400">点击以下按钮一键在 Shell 中执行常用的诊断脚本进行快速安全运维分析：</p>
                      
                      <div className="grid grid-cols-1 gap-2 pt-1">
                        <button
                          onClick={() => runQuickCommand("help")}
                          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 font-bold rounded-lg text-left cursor-pointer transition-colors"
                        >
                          <span className="text-indigo-400 text-xs font-mono">$</span>
                          <span>帮助菜单 (help)</span>
                        </button>

                        <button
                          onClick={() => runQuickCommand("status")}
                          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 font-bold rounded-lg text-left cursor-pointer transition-colors"
                        >
                          <span className="text-indigo-400 text-xs font-mono">$</span>
                          <span>系统与 nftables 状态</span>
                        </button>

                        <button
                          onClick={() => runQuickCommand("rules")}
                          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 font-bold rounded-lg text-left cursor-pointer transition-colors"
                        >
                          <span className="text-indigo-400 text-xs font-mono">$</span>
                          <span>列出所有映射条目</span>
                        </button>

                        <button
                          onClick={() => runQuickCommand("nft list ruleset")}
                          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 font-bold rounded-lg text-left cursor-pointer transition-colors"
                        >
                          <span className="text-indigo-400 text-xs font-mono">$</span>
                          <span>查看 nftables 规则 (nft list ruleset)</span>
                        </button>

                        <button
                          onClick={() => runQuickCommand("ps aux | grep nft")}
                          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 font-bold rounded-lg text-left cursor-pointer transition-colors"
                        >
                          <span className="text-indigo-400 text-xs font-mono">$</span>
                          <span>查询 nftables 运行状态</span>
                        </button>

                        <button
                          onClick={() => runQuickCommand("netstat -an | grep LISTEN")}
                          className="flex items-center gap-1.5 px-3 py-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 font-bold rounded-lg text-left cursor-pointer transition-colors"
                        >
                          <span className="text-indigo-400 text-xs font-mono">$</span>
                          <span>列出所有监听端口</span>
                        </button>
                      </div>
                    </div>

                    <div className="text-[10px] text-slate-500 pt-3 border-t border-slate-800/60 leading-relaxed font-mono">
                      网关进程: PID 1300<br />
                      工作路径: /app<br />
                      环境: Docker Container
                    </div>
                  </div>
                </div>

                {/* Embedded Shell Input bottom Form */}
                <form onSubmit={sendEmbeddedCLICommand} className="border-t border-slate-800/80 p-3.5 flex items-center bg-black gap-2 shrink-0">
                  <span className="text-emerald-500 font-bold font-mono pl-2 text-xs">admin@ruichi-gateway:~$</span>
                  <input
                    type="text"
                    value={embeddedCmdInput}
                    onChange={(e) => setEmbeddedCmdInput(e.target.value)}
                    placeholder='输入要执行的系统命令 (如 "help", "df -h", "curl 127.0.0.1:3000", "uptime")...'
                    className="flex-1 bg-transparent border-0 outline-none font-mono text-xs text-slate-100 placeholder-slate-700 p-1"
                  />
                  <button type="submit" className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg font-mono text-xs cursor-pointer transition-colors">
                    运行指令
                  </button>
                </form>
              </div>
            )}

            {activeTab === "settings" && (
              <div className="h-full min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm p-6 max-w-2xl overflow-y-auto" id="settings-pane-container">
                <div className="flex items-center gap-3 border-b border-slate-100 pb-4 mb-6">
                  <div className="p-2 bg-indigo-50 border border-indigo-100 rounded-lg text-indigo-600">
                    <SettingsIcon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800">网关运行基本参数设置</h3>
                    <p className="text-xs text-slate-400">在此设定本机的外部绑定参数以用于页面渲染及配置文件编译</p>
                  </div>
                </div>

                <form onSubmit={handleSaveSettings} className="space-y-6" id="settings-form">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-700 block">本机物理 IP 地址 (Local IP)</label>
                    <p className="text-[11px] text-slate-400">
                      转发拓扑的 IP 入口链接将基于此值生成，默认不修改为 127.0.0.1。
                    </p>
                    <input
                      type="text"
                      id="settings-local-ip"
                      value={localIp}
                      onChange={(e) => setLocalIp(e.target.value)}
                      placeholder="e.g. 192.168.1.50 或公网 IP"
                      className="w-full bg-slate-50 text-slate-800 border border-slate-200 rounded-lg px-3.5 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/80 transition-all font-mono"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-700 block">系统映射域名 (Domain) - <span className="text-slate-400 font-normal">可选</span></label>
                    <p className="text-[11px] text-slate-400">
                      填入本机绑定的域名（如 <span className="font-mono text-xs">ruichi.local</span>）。若留空，在规则列表中不再显示域名入口选项。
                    </p>
                    <input
                      type="text"
                      id="settings-domain"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="e.g. gateway.ruichi.com (留空则不显示域名项)"
                      className="w-full bg-slate-50 text-slate-800 border border-slate-200 rounded-lg px-3.5 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/80 transition-all font-mono"
                    />
                  </div>

                  <div className="bg-slate-50 border border-slate-100 p-4 rounded-xl space-y-2 text-xs text-slate-600">
                    <div className="font-bold text-slate-700 flex items-center gap-1">
                      <ShieldCheck className="h-4.5 w-4.5 text-emerald-600" />
                      <span>配置将立即在以下模块生效：</span>
                    </div>
                    <ul className="list-disc pl-5 space-y-1 text-slate-500">
                      <li>端口规则拓扑中的 IP / 域名展示与复制链接</li>
                      <li>nftables 规则中的端口与目标地址 DNS 解析</li>
                      <li>诊断终端调试的输出摘要指标</li>
                    </ul>
                  </div>

                  <button
                    type="submit"
                    id="settings-save-btn"
                    disabled={isSavingSettings}
                    className="flex items-center justify-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 text-white font-bold rounded-lg text-xs transition-colors shadow-sm cursor-pointer"
                  >
                    <RefreshCw className={`h-4 w-4 ${isSavingSettings ? "animate-spin" : ""}`} />
                    <span>{isSavingSettings ? "正在固化设置..." : "固化并更新系统设置"}</span>
                  </button>
                </form>
              </div>
            )}

            {activeTab === "whitelist" && (
              <div className="h-full min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden" id="whitelist-pane-container">
                <WhitelistGroupsPanel
                  groups={whitelistGroups}
                  onAdd={handleAddWhitelistGroup}
                  onUpdate={handleUpdateWhitelistGroup}
                  onDelete={handleDeleteWhitelistGroup}
                />
              </div>
            )}
          </div>
        </main>
      </div>

      {/* CREATE / EDIT RULES DIALOG FORM */}
      <RuleFormModal
        isOpen={isFormModalOpen}
        onClose={() => setIsFormModalOpen(false)}
        onSave={handleSaveRule}
        rule={editingRule}
        recommendedPorts={recommendedPorts}
        usedPorts={usedPorts}
        whitelistGroups={whitelistGroups}
      />

      {/* NFTABLES CONFIGURATION PREVIEW DIALOG MODAL */}
      {isPreviewModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 lg:p-6" id="preview-modal-overlay">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-w-5xl w-full h-[85vh] overflow-hidden flex flex-col relative" id="preview-modal">
            {/* Close Button on top right */}
            <button
              onClick={() => setIsPreviewModalOpen(false)}
              className="absolute right-4 top-4 z-10 p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors shrink-0 bg-slate-950/60 border border-slate-800 cursor-pointer"
              title="关闭预览"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex-1 min-h-0">
              <NftablesPreviewPane
                previews={previews}
                versions={versions}
                onRollback={handleRollback}
                currentUser={{ role: "Admin" }}
              />
            </div>
          </div>
        </div>
      )}

      {/* TERMINAL LOG DIALOG (For showing reload steps live) */}
      {isTerminalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" id="terminal-modal-overlay">
          <div className="bg-slate-950 border border-slate-800 rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[80vh]" id="terminal-modal">
            {/* Header bar */}
            <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <TerminalIcon className="h-4.5 w-4.5 text-indigo-400" />
                <span className="text-xs font-mono font-bold text-slate-100">
                  nftables 重载终端反馈
                </span>
              </div>
              <button
                onClick={() => setIsTerminalOpen(false)}
                className="p-1 rounded text-slate-400 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Terminal screen content */}
            <div className="p-4 overflow-y-auto bg-black font-mono text-xs text-indigo-300 space-y-2 flex-1 min-h-[250px] leading-relaxed">
              {terminalLogs.map((line, idx) => (
                <div key={idx} className="break-all whitespace-pre-wrap">
                  {line}
                </div>
              ))}
              {isReloading && (
                <div className="flex items-center gap-1.5 text-indigo-400 animate-pulse">
                  <span>●</span>
                  <span>正在执行 nftables 规则重载 (nft -f)...</span>
                </div>
              )}
            </div>

            {/* Interactive Diagnostics Terminal CLI Form */}
            <form onSubmit={sendCLICommand} className="border-t border-slate-800/80 p-2.5 flex items-center bg-black gap-2 shrink-0">
              <span className="text-emerald-500 font-bold font-mono pl-2 text-xs">$</span>
              <input
                type="text"
                value={cmdInput}
                onChange={(e) => setCmdInput(e.target.value)}
                placeholder='输入调试指令 (如 "help", "status", "rules", "nft list ruleset", "ping")...'
                className="flex-1 bg-transparent border-0 outline-none font-mono text-xs text-slate-100 placeholder-slate-600 p-1"
              />
              <button type="submit" className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-mono text-[10px] uppercase cursor-pointer">
                执行
              </button>
            </form>

            {/* Terminal Action footer */}
            <div className="bg-slate-900 border-t border-slate-800 px-4 py-3 flex-row flex items-center justify-between shrink-0 text-[10px] text-slate-400">
              <span>状态码: 0 (Success)</span>
              <button
                onClick={() => setIsTerminalOpen(false)}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded text-xs transition-colors cursor-pointer"
              >
                关闭终端
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
