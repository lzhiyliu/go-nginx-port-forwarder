import React, { useState } from "react";
import { ConfigVersion } from "../types";
import { Terminal, Copy, Check, History, Undo2, ChevronRight, FileCode, Clock, ShieldCheck, AlertCircle } from "lucide-react";

interface NftablesPreviewPaneProps {
  previews: { rules: string };
  versions: ConfigVersion[];
  onRollback: (versionId: string) => Promise<void>;
  currentUser: any;
}

type SubTab = "live" | "backups";

export default function NftablesPreviewPane({
  previews,
  versions,
  onRollback,
  currentUser
}: NftablesPreviewPaneProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("live");
  const [copied, setCopied] = useState(false);

  const fallbackCopy = (text: string) => {
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Fallback copy failed: ", err);
    }
    document.body.removeChild(textArea);
  };

  const handleCopy = () => {
    const text = previews.rules || "";
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => {
            fallbackCopy(text);
          });
      } else {
        fallbackCopy(text);
      }
    } catch (err) {
      fallbackCopy(text);
    }
  };

  const isAdmin = currentUser?.role === "Admin";

  return (
    <div className="bg-slate-900 text-slate-100 rounded-xl shadow-lg border border-slate-800 overflow-hidden flex flex-col h-full" id="nftables-preview-container">
      {/* Top Controller Header */}
      <div className="p-4 bg-slate-950 border-b border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5 text-indigo-400" />
          <div>
            <h3 className="font-bold text-sm text-slate-100">nftables 规则管理</h3>
            <p className="text-[10px] text-slate-400">实时编译预览端口转发规则 & 版本回滚备份机制</p>
          </div>
        </div>

        {/* Sub-tab selection */}
        <div className="flex bg-slate-900 border border-slate-800 p-1 rounded-lg">
          <button
            id="tab-btn-live"
            onClick={() => setActiveSubTab("live")}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-all ${
              activeSubTab === "live"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            实时规则文件
          </button>
          <button
            id="tab-btn-backups"
            onClick={() => setActiveSubTab("backups")}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-all flex items-center gap-1.5 ${
              activeSubTab === "backups"
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <History className="h-3 w-3" />
            备份版本控制 ({versions.length})
          </button>
        </div>
      </div>

      {/* Main body of Preview pane */}
      <div className="flex-1 overflow-y-auto min-h-[400px]">
        {activeSubTab === "live" ? (
          <div className="flex flex-col h-full">
            {/* File selection Tabs */}
            <div className="flex items-center justify-between px-4 py-2 bg-slate-950/40 border-b border-slate-800/50">
              <div className="flex items-center gap-1.5">
                <span className="px-3 py-1.5 text-xs font-medium border-b-2 border-indigo-500 text-indigo-400 bg-slate-900/50">
                  port_forwarder.nft
                </span>
              </div>

              {/* Copy action */}
              <button
                id="btn-copy-config"
                onClick={handleCopy}
                className="flex items-center gap-1 text-slate-400 hover:text-white hover:bg-slate-800 p-1 px-2 rounded text-xs transition-colors cursor-pointer border border-slate-800"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "已复制" : "复制规则"}
              </button>
            </div>

            {/* Code Block Visualizer */}
            <div className="p-4 bg-slate-950 font-mono text-xs text-indigo-300 leading-relaxed overflow-x-auto select-text flex-1">
              <pre className="whitespace-pre">{previews.rules || "# 暂无规则\n"}</pre>
            </div>
          </div>
        ) : (
          /* Rollback Backups List */
          <div className="p-4 space-y-4">
            <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-lg text-xs text-slate-300 flex items-start gap-2.5">
              <AlertCircle className="h-4.5 w-4.5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-slate-200">备份版本回滚说明</p>
                <p className="text-[11px] text-slate-400 mt-1">
                  每次执行 <b>"一键热重载"</b> 时，系统均会自动对当前配置状态在后台拍摄一份快照。
                  只有 <b>系统管理员 (Admin)</b> 角色可以进行版本回滚。回滚将重置当前的转发规则数据。
                </p>
              </div>
            </div>

            {versions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                <History className="h-10 w-10 text-slate-600 mb-2" />
                <p className="text-xs">暂无自动备份版本</p>
                <p className="text-[10px] text-slate-600 mt-1">保存规则并触发 nftables 重载后将自动生成备份</p>
              </div>
            ) : (
              <div className="space-y-2" id="versions-history-list">
                {versions.map((ver) => (
                  <div
                    key={ver.id}
                    id={`version-card-${ver.id}`}
                    className="p-3 bg-slate-950 border border-slate-800/80 hover:border-slate-700/80 rounded-lg flex items-center justify-between gap-4 transition-all"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold text-indigo-400 bg-indigo-950/80 px-2 py-0.5 rounded border border-indigo-900/50">
                          v{ver.version}
                        </span>
                        <span className="text-xs text-slate-300 font-semibold">{ver.description}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-slate-400">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3 text-slate-500" />
                          {new Date(ver.timestamp).toLocaleString()}
                        </span>
                        <span className="flex items-center gap-1">
                          <ShieldCheck className="h-3 w-3 text-slate-500" />
                          创建者: {ver.createdBy}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0">
                      <button
                        id={`rollback-btn-${ver.id}`}
                        onClick={() => onRollback(ver.id)}
                        disabled={!isAdmin}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-bold transition-colors cursor-pointer ${
                          isAdmin
                            ? "bg-amber-600 text-white hover:bg-amber-700"
                            : "bg-slate-800 text-slate-500 cursor-not-allowed"
                        }`}
                        title={isAdmin ? "回滚至此版本配置" : "仅管理员权限可用"}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                        <span>回滚</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer System Path Details */}
      <div className="p-3 bg-slate-950 border-t border-slate-800 text-[10px] text-slate-400 flex flex-wrap gap-x-4 gap-y-1 justify-between items-center shrink-0">
        <div className="flex items-center gap-1">
          <FileCode className="h-3 w-3 text-slate-500" />
          <span>规则文件: /tmp/port_forwarder.nft</span>
        </div>
        <span>应用命令: nft -f /tmp/port_forwarder.nft</span>
      </div>
    </div>
  );
}
