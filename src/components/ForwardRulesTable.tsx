import React, { useState } from "react";
import { ForwardRule } from "../types";
import { Edit, Trash2, Search, ArrowRightLeft, Power, FileText, Copy, Check, RefreshCw, ExternalLink } from "lucide-react";

interface ForwardRulesTableProps {
  rules: ForwardRule[];
  onEdit: (rule: ForwardRule) => void;
  onDelete: (id: string) => void;
  onToggle: (rule: ForwardRule) => void;
  onDuplicate: (rule: ForwardRule) => void;
  currentUserRole: string;
  localIp: string;
  domain: string;
  portStatuses: Record<number, boolean>;
  isCheckingPorts: boolean;
  onCheckPorts: () => void;
}

export default function ForwardRulesTable({
  rules,
  onEdit,
  onDelete,
  onToggle,
  onDuplicate,
  currentUserRole,
  localIp,
  domain,
  portStatuses,
  isCheckingPorts,
  onCheckPorts
}: ForwardRulesTableProps) {
  const [search, setSearch] = useState("");
  const [protocolFilter, setProtocolFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredRules = rules.filter((rule) => {
    const matchesSearch =
      rule.name.toLowerCase().includes(search.toLowerCase()) ||
      rule.targetHost.toLowerCase().includes(search.toLowerCase()) ||
      rule.listenPort.toString().includes(search) ||
      rule.targetPort.toString().includes(search) ||
      (rule.description && rule.description.toLowerCase().includes(search.toLowerCase()));

    const matchesProtocol = protocolFilter === "ALL" || rule.protocol === protocolFilter;
    const matchesStatus =
      statusFilter === "ALL" ||
      (statusFilter === "ENABLED" && rule.enabled) ||
      (statusFilter === "DISABLED" && !rule.enabled);

    return matchesSearch && matchesProtocol && matchesStatus;
  });

  const fallbackCopyText = (text: string, id: string) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Fallback copy failed: ", err);
    }
    document.body.removeChild(textArea);
  };

  const handleCopyText = (text: string, id: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
          .then(() => {
            setCopiedId(id);
            setTimeout(() => setCopiedId(null), 2000);
          })
          .catch(() => {
            fallbackCopyText(text, id);
          });
      } else {
        fallbackCopyText(text, id);
      }
    } catch (err) {
      fallbackCopyText(text, id);
    }
  };

  // 构建完整入口 URL: protocol://host:port/urlSuffix
  // 规则协议为 HTTP/HTTPS 时拼接协议头，TCP/UDP 时仅展示 IP:PORT
  const buildFullUrl = (host: string, port: number, protocol: string, suffix?: string): string => {
    const protoLower = protocol.toLowerCase();
    const prefix = (protoLower === "http" || protoLower === "https") ? `${protoLower}://` : "";
    const pathSuffix = suffix ? `/${suffix.replace(/^\/+|\/+$/g, "")}` : "";
    return `${prefix}${host}:${port}${pathSuffix}`;
  };

  // 在外部浏览器中打开链接
  const handleOpenExternal = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const isReadOnly = currentUserRole === "Viewer";

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col h-full" id="rules-table-container">
      {/* Table Header Filter controls */}
      <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col md:flex-row gap-3 items-center justify-between">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            id="rule-search-input"
            placeholder="搜索规则名称、端口、目标主机..."
            className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2 w-full md:w-auto items-center">
          <select
            id="protocol-filter"
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
            value={protocolFilter}
            onChange={(e) => setProtocolFilter(e.target.value)}
          >
            <option value="ALL">所有协议 (TCP/UDP/HTTP)</option>
            <option value="TCP">TCP (四层端口映射)</option>
            <option value="UDP">UDP (物联网/高并发)</option>
            <option value="HTTP">HTTP (七层反向代理)</option>
            <option value="HTTPS">HTTPS (安全反向代理)</option>
          </select>

          <select
            id="status-filter"
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="ALL">所有状态</option>
            <option value="ENABLED">已启用</option>
            <option value="DISABLED">已禁用</option>
          </select>

          <button
            id="btn-trigger-port-check"
            onClick={onCheckPorts}
            disabled={isCheckingPorts}
            className="flex items-center gap-1 px-3 py-2 border border-indigo-200 text-indigo-700 bg-indigo-50/50 hover:bg-indigo-50 rounded-lg text-sm transition-all cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-4.5 w-4.5 ${isCheckingPorts ? "animate-spin" : ""}`} />
            <span>检测端口</span>
          </button>
        </div>
      </div>

      {/* Table Data list */}
      <div className="overflow-y-auto flex-1 min-h-[400px]">
        {filteredRules.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-slate-400" id="empty-rules-state">
            <FileText className="h-12 w-12 text-slate-300 mb-3" />
            <p className="text-sm">暂无匹配的端口转发规则</p>
            <p className="text-xs text-slate-400 mt-1">请尝试清除过滤条件或新建一条转发规则</p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse" id="rules-data-table">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 text-xs font-semibold uppercase tracking-wider">
                <th className="py-3 px-4">规则名称 / 备注描述</th>
                <th className="py-3 px-4">转发拓扑</th>
                <th className="py-3 px-4 text-center">网络协议</th>
                <th className="py-3 px-4 text-center">物理端口检测</th>
                <th className="py-3 px-4 text-center">启用状态</th>
                <th className="py-3 px-4 text-right">操作管理</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredRules.map((rule) => (
                <tr
                  key={rule.id}
                  id={`rule-row-${rule.id}`}
                  className={`hover:bg-slate-50/70 transition-colors ${!rule.enabled ? "opacity-65 bg-slate-50/30" : ""}`}
                >
                  {/* Name and description */}
                  <td className="py-4 px-4 max-w-xs">
                    <div className="font-semibold text-slate-800 break-words">{rule.name}</div>
                    {rule.description ? (
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">{rule.description}</p>
                    ) : (
                      <p className="text-xs text-slate-400 mt-1 italic">未添加备注描述</p>
                    )}
                    {rule.allowedIps && rule.allowedIps.trim() ? (
                      <div className="mt-1.5 flex flex-wrap gap-1 items-center">
                        <span className="text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded font-mono font-medium" title={rule.allowedIps}>
                          IP 限制: {rule.allowedIps.length > 25 ? rule.allowedIps.substring(0, 25) + "..." : rule.allowedIps}
                        </span>
                      </div>
                    ) : (
                      <div className="mt-1.5 flex flex-wrap gap-1 items-center">
                        <span className="text-[10px] text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded font-medium">
                          IP 限制: 全部允许访问
                        </span>
                      </div>
                    )}
                  </td>

                  {/* Forward topology */}
                  <td className="py-4 px-4">
                    <div className="flex flex-col gap-1.5 py-0.5">
                      <div className="flex items-center gap-2">
                        <div className="text-[10px] text-slate-400 w-16 shrink-0 font-medium">IP入口地址:</div>
                        <span className="font-mono text-indigo-600 font-semibold bg-indigo-50/80 px-1.5 py-0.5 rounded text-xs border border-indigo-100/60 flex items-center gap-1">
                          {buildFullUrl(localIp || "127.0.0.1", rule.listenPort, rule.protocol, rule.urlSuffix)}
                          <button
                            onClick={() => handleCopyText(buildFullUrl(localIp || "127.0.0.1", rule.listenPort, rule.protocol, rule.urlSuffix), `ip-${rule.id}`)}
                            className="text-slate-400 hover:text-indigo-600 cursor-pointer p-0.5"
                            title="复制 IP 入口地址"
                          >
                            {copiedId === `ip-${rule.id}` ? (
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => handleOpenExternal(buildFullUrl(localIp || "127.0.0.1", rule.listenPort, rule.protocol, rule.urlSuffix))}
                            className="text-slate-400 hover:text-blue-600 cursor-pointer p-0.5"
                            title="在浏览器中打开"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </div>

                      {domain && (
                        <div className="flex items-center gap-2">
                          <div className="text-[10px] text-slate-400 w-16 shrink-0 font-medium">域名入口:</div>
                          <span className="font-mono text-violet-600 font-semibold bg-violet-50/80 px-1.5 py-0.5 rounded text-xs border border-violet-100/60 flex items-center gap-1">
                            {buildFullUrl(domain, rule.listenPort, rule.protocol, rule.urlSuffix)}
                            <button
                              onClick={() => handleCopyText(buildFullUrl(domain, rule.listenPort, rule.protocol, rule.urlSuffix), `dom-${rule.id}`)}
                              className="text-slate-400 hover:text-violet-600 cursor-pointer p-0.5"
                              title="复制域名入口地址"
                            >
                              {copiedId === `dom-${rule.id}` ? (
                                <Check className="h-3.5 w-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <button
                              onClick={() => handleOpenExternal(buildFullUrl(domain, rule.listenPort, rule.protocol, rule.urlSuffix))}
                              className="text-slate-400 hover:text-blue-600 cursor-pointer p-0.5"
                              title="在浏览器中打开"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <div className="text-[10px] text-slate-400 w-16 shrink-0 font-medium">转发至物理:</div>
                        <span className="font-mono text-slate-600 bg-slate-50 px-1.5 py-0.5 rounded text-xs border border-slate-200">
                          {rule.targetHost}:{rule.targetPort}
                        </span>
                      </div>
                    </div>
                  </td>

                  {/* Protocol */}
                  <td className="py-4 px-4 text-center">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-semibold uppercase ${
                        rule.protocol === "TCP"
                          ? "bg-sky-50 text-sky-700 border border-sky-100"
                          : rule.protocol === "UDP"
                          ? "bg-amber-50 text-amber-700 border border-amber-100"
                          : "bg-emerald-50 text-emerald-700 border border-emerald-100"
                      }`}
                    >
                      {rule.protocol}
                    </span>
                  </td>

                  {/* Real-time Port Check Status */}
                  <td className="py-4 px-4 text-center">
                    {rule.enabled ? (
                      portStatuses[rule.listenPort] ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          端口开启
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 animate-pulse">
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                          端口关闭
                        </span>
                      )
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-400 border border-slate-200/60">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                        未启用
                      </span>
                    )}
                  </td>

                  {/* Enabled status */}
                  <td className="py-4 px-4 text-center">
                    <button
                      id={`toggle-btn-${rule.id}`}
                      disabled={isReadOnly}
                      onClick={() => onToggle(rule)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition-all ${
                        rule.enabled
                          ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                          : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                      } ${isReadOnly ? "cursor-not-allowed opacity-80" : ""}`}
                      title={isReadOnly ? "只读用户无法操作" : `点击${rule.enabled ? "禁用" : "启用"}`}
                    >
                      <Power className="h-3 w-3" />
                      {rule.enabled ? "已启用" : "已禁用"}
                    </button>
                  </td>

                  {/* Actions */}
                  <td className="py-4 px-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        id={`duplicate-btn-${rule.id}`}
                        onClick={() => onDuplicate(rule)}
                        disabled={isReadOnly}
                        className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-emerald-600 transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                        title={isReadOnly ? "只读权限" : "复制此规则为副本"}
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <button
                        id={`edit-btn-${rule.id}`}
                        onClick={() => onEdit(rule)}
                        disabled={isReadOnly}
                        className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600 hover:text-indigo-600 transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-600"
                        title={isReadOnly ? "只读权限" : "编辑配置"}
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                      <button
                        id={`delete-btn-${rule.id}`}
                        onClick={() => onDelete(rule.id)}
                        disabled={isReadOnly}
                        className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-rose-600 transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                        title={isReadOnly ? "只读权限" : "删除规则"}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Summary Footer */}
      <div className="p-3 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 flex justify-between items-center">
        <span>当前显示 <b>{filteredRules.length}</b> 条转发规则（总计 {rules.length} 条）</span>
        <span>
          启用中：<b>{rules.filter(r => r.enabled).length}</b> 条 | 
          禁用中：<b>{rules.filter(r => !r.enabled).length}</b> 条
        </span>
      </div>
    </div>
  );
}
