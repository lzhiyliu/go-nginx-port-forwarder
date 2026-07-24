import React, { useState, useEffect } from "react";
import { ForwardRule, WhitelistGroup } from "../types";
import { X, Sparkles, HelpCircle, Check, Info } from "lucide-react";

interface RuleFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (ruleData: any) => Promise<boolean>;
  rule?: ForwardRule;
  recommendedPorts: number[];
  usedPorts: number[];
  whitelistGroups: WhitelistGroup[];
}

export default function RuleFormModal({
  isOpen,
  onClose,
  onSave,
  rule,
  recommendedPorts,
  usedPorts,
  whitelistGroups
}: RuleFormModalProps) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<'TCP' | 'UDP' | 'HTTP' | 'HTTPS'>("HTTP");
  const [portSelectionMode, setPortSelectionMode] = useState<'auto' | 'manual'>("auto");
  const [listenPort, setListenPort] = useState<number>(8081);
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState<number>(3000);
  const [enabled, setEnabled] = useState(true);
  const [description, setDescription] = useState("");
  const [urlSuffix, setUrlSuffix] = useState("");
  const [whitelistGroupId, setWhitelistGroupId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize fields on open/edit
  useEffect(() => {
    if (isOpen) {
      setError(null);
      if (rule) {
        setName(rule.name);
        setProtocol(rule.protocol);
        setPortSelectionMode("manual");
        setListenPort(rule.listenPort);
        setTargetHost(rule.targetHost);
        setTargetPort(rule.targetPort);
        setEnabled(rule.enabled);
        setDescription(rule.description);
        setUrlSuffix(rule.urlSuffix || "");
        setWhitelistGroupId(rule.whitelistGroupId || "");
      } else {
        // Create mode
        setName("");
        setProtocol("HTTP");
        setPortSelectionMode("auto");
        // pick first recommended port
        if (recommendedPorts.length > 0) {
          setListenPort(recommendedPorts[0]);
        } else {
          setListenPort(8081);
        }
        setTargetHost("127.0.0.1");
        setTargetPort(80);
        setEnabled(true);
        setDescription("");
        setUrlSuffix("");
        setWhitelistGroupId("");
      }
    }
  }, [isOpen, rule, recommendedPorts]);

  // Handle port selection mode change
  useEffect(() => {
    if (!rule && portSelectionMode === "auto" && recommendedPorts.length > 0) {
      setListenPort(recommendedPorts[0]);
    }
  }, [portSelectionMode, recommendedPorts, rule]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("请输入规则名称");
      return;
    }

    if (!listenPort || listenPort < 1 || listenPort > 65535) {
      setError("本地监听端口必须在 1 ~ 65535 之间");
      return;
    }

    if (!targetHost.trim()) {
      setError("请输入目标服务主机地址");
      return;
    }

    if (!targetPort || targetPort < 1 || targetPort > 65535) {
      setError("目标服务端口必须在 1 ~ 65535 之间");
      return;
    }

    // Port conflict warning (client side check)
    if (enabled && (!rule || rule.listenPort !== listenPort)) {
      if (usedPorts.includes(listenPort)) {
        setError(`端口冲突警告：监听端口 ${listenPort} 正在被占用，请选择其他端口。`);
        return;
      }
    }

    setIsSubmitting(true);
    const success = await onSave({
      name,
      listenPort,
      targetHost,
      targetPort,
      protocol,
      enabled,
      description,
      allowedIps: whitelistGroupId
        ? (whitelistGroups.find(g => g.id === whitelistGroupId)?.ips || "")
        : "",
      urlSuffix,
      whitelistGroupId
    });
    setIsSubmitting(false);

    if (success) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" id="rule-form-modal-overlay">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full overflow-hidden border border-slate-200 flex flex-col max-h-[90vh]" id="rule-form-modal">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-slate-50">
          <h3 className="text-base font-bold text-slate-800" id="modal-title">
            {rule ? "编辑转发配置规则" : "新建端口转发配置规则"}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:bg-slate-200 hover:text-slate-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4 text-sm text-slate-700">
          {error && (
            <div className="p-3 bg-rose-50 text-rose-700 rounded-lg border border-rose-100 text-xs flex gap-2 items-start" id="form-error-alert">
              <span className="font-semibold">⚠️ 错误：</span>
              <span>{error}</span>
            </div>
          )}

          {/* Rule Name */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">规则名称 *</label>
            <input
              type="text"
              id="input-rule-name"
              placeholder="例如: 财务系统代理, 开发者数据库转发..."
              className="w-full px-3.5 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
            />
          </div>

          {/* Protocol & Enabled state */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">协议类型</label>
              <select
                id="input-rule-protocol"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as any)}
              >
                <option value="HTTP">HTTP (反向代理)</option>
                <option value="HTTPS">HTTPS (安全反向代理)</option>
                <option value="TCP">TCP (四层传输协议)</option>
                <option value="UDP">UDP (高并发无连接)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">服务初始状态</label>
              <div className="flex items-center h-[38px] gap-2">
                <input
                  type="checkbox"
                  id="input-rule-enabled"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500"
                />
                <span className="text-slate-600 text-xs select-none">立即启用该端口转发</span>
              </div>
            </div>
          </div>

          <hr className="border-slate-100" />

          {/* Local Port Selector: Auto Unused vs Manual */}
          <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200/60 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-700">本地监听端口 *</label>
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs">
                  <input
                    type="radio"
                    name="portMode"
                    value="auto"
                    checked={portSelectionMode === "auto"}
                    onChange={() => setPortSelectionMode("auto")}
                    className="text-indigo-600 focus:ring-indigo-500"
                    disabled={!!rule} // edit mode force manual to show existing
                  />
                  <span>智能匹配闲置端口</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs">
                  <input
                    type="radio"
                    name="portMode"
                    value="manual"
                    checked={portSelectionMode === "manual"}
                    onChange={() => setPortSelectionMode("manual")}
                    className="text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>手动填写</span>
                </label>
              </div>
            </div>

            {portSelectionMode === "auto" ? (
              <div className="space-y-2">
                <div className="relative">
                  <select
                    id="input-rule-port-select"
                    className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm"
                    value={listenPort}
                    onChange={(e) => setListenPort(Number(e.target.value))}
                  >
                    {recommendedPorts.map((p) => (
                      <option key={p} value={p}>
                        端口 {p} (系统检测当前空闲可安全使用)
                      </option>
                    ))}
                  </select>
                  <Sparkles className="absolute left-2.5 top-2.5 h-4 w-4 text-indigo-500" />
                </div>
                <p className="text-[10px] text-slate-500 flex gap-1 items-center">
                  <Info className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  系统自动跳过了已知系统占用、反向代理端口、服务网关以及当前已被配置占用的端口。
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  type="number"
                  id="input-rule-port-number"
                  placeholder="请输入端口，例如: 8080"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                  value={listenPort || ""}
                  onChange={(e) => setListenPort(Number(e.target.value))}
                  min={1}
                  max={65535}
                  required
                />
                {usedPorts.includes(listenPort) && (
                  <p className="text-[11px] text-amber-600 font-medium">
                    ⚠️ 此端口目前已被占用！保存启用将引发冲突报错。
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Forward target Host & Port */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">目标服务主机地址 *</label>
              <input
                type="text"
                id="input-rule-target-host"
                placeholder="例如: 127.0.0.1, 192.168.1.15"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                value={targetHost}
                onChange={(e) => setTargetHost(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">目标服务端口 *</label>
              <input
                type="number"
                id="input-rule-target-port"
                placeholder="例如: 3306"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                value={targetPort || ""}
                onChange={(e) => setTargetPort(Number(e.target.value))}
                min={1}
                max={65535}
                required
              />
            </div>
          </div>

          {/* Whitelist Group Binding */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              绑定白名单组
            </label>
            <select
              id="input-rule-whitelist-group"
              value={whitelistGroupId}
              onChange={(e) => {
                setWhitelistGroupId(e.target.value);
              }}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm bg-white"
            >
              <option value="">-- 不限制（所有 IP 均可访问） --</option>
              {whitelistGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} ({group.ips.split(/[\s,;\n]+/).filter(s => s.trim()).length} 个 IP)
                  {group.description ? ` - ${group.description}` : ""}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-400 mt-1">
              选择白名单组后自动应用其 IP 列表；白名单组更新后绑定规则自动同步
            </p>
          </div>

          {/* URL Path Suffix */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">URL 路径后缀 (可选)</label>
            <div className="relative">
              <input
                type="text"
                id="input-rule-url-suffix"
                placeholder="例如: api/v1, admin/portal (留空则不拼接后缀)"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-xs"
                value={urlSuffix}
                onChange={(e) => setUrlSuffix(e.target.value)}
              />
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              {urlSuffix && protocol !== "TCP" && protocol !== "UDP" ? (
                <span>IP 入口完整地址将为: <span className="font-mono text-indigo-600">{protocol.toLowerCase()}://IP:{listenPort || 0}/{urlSuffix.replace(/^\/+|\/+$/g, "")}</span></span>
              ) : urlSuffix && (protocol === "TCP" || protocol === "UDP") ? (
                <span>TCP/UDP 协议不拼接协议头，入口地址为: <span className="font-mono text-indigo-600">IP:{listenPort || 0}/{urlSuffix.replace(/^\/+|\/+$/g, "")}</span></span>
              ) : (
                <span>填写后 IP 入口链接将拼接此后缀，如选择 HTTP/HTTPS 协议还将自动拼接协议头</span>
              )}
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">备注说明</label>
            <textarea
              id="input-rule-description"
              placeholder="请填写配置的具体业务场景、联系人或部署原因，便于团队运维审计..."
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 h-20 resize-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
            />
          </div>
        </form>

        {/* Footer */}
        <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            id="modal-submit-btn"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow transition-colors cursor-pointer disabled:opacity-50"
          >
            {isSubmitting ? "正在保存..." : "确认保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
