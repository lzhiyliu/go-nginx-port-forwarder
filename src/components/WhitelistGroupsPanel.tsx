import React, { useState } from "react";
import { WhitelistGroup } from "../types";
import { Plus, Edit, Trash2, Shield, Users, X, Check, AlertTriangle } from "lucide-react";

interface WhitelistGroupsPanelProps {
  groups: WhitelistGroup[];
  onAdd: (group: Omit<WhitelistGroup, "id" | "createdAt" | "updatedAt">) => Promise<boolean>;
  onUpdate: (id: string, group: Omit<WhitelistGroup, "id" | "createdAt" | "updatedAt">) => Promise<boolean>;
  onDelete: (id: string) => void;
}

export default function WhitelistGroupsPanel({ groups, onAdd, onUpdate, onDelete }: WhitelistGroupsPanelProps) {
  const [editingGroup, setEditingGroup] = useState<WhitelistGroup | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formIps, setFormIps] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  // 计算组内 IP 数量
  const parseIpCount = (ips: string): number => {
    return ips.split(/[\s,;]+/).filter(s => s.trim().length > 0).length;
  };

  // Parse IPs for display
  const formatIps = (ips: string): string[] => {
    return ips.split(/[\s,;]+/).filter(s => s.trim().length > 0);
  };

  // Open form for create
  const handleOpenCreate = () => {
    setEditingGroup(null);
    setFormName("");
    setFormDescription("");
    setFormIps("");
    setFormError(null);
    setIsFormOpen(true);
  };

  // Open form for edit
  const handleOpenEdit = (group: WhitelistGroup) => {
    setEditingGroup(group);
    setFormName(group.name);
    setFormDescription(group.description);
    setFormIps(group.ips);
    setFormError(null);
    setIsFormOpen(true);
  };

  // Close form
  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingGroup(null);
    setFormError(null);
  };

  // Validate and submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formName.trim()) {
      setFormError("组名称不能为空");
      return;
    }

    const ips = formIps.trim();
    if (!ips) {
      setFormError("至少需要添加一个 IP 地址");
      return;
    }

    setIsSubmitting(true);
    let success: boolean;
    if (editingGroup) {
      success = await onUpdate(editingGroup.id, {
        name: formName.trim(),
        description: formDescription.trim(),
        ips,
      });
    } else {
      success = await onAdd({
        name: formName.trim(),
        description: formDescription.trim(),
        ips,
      });
    }
    setIsSubmitting(false);

    if (success) {
      handleCloseForm();
    } else {
      setFormError(editingGroup ? "更新白名单组失败" : "创建白名单组失败");
    }
  };

  const filteredGroups = searchTerm
    ? groups.filter(g =>
        g.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        g.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        g.ips.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : groups;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200/60 shrink-0">
        <div>
          <h2 className="text-lg font-bold text-slate-800">白名单组管理</h2>
          <p className="text-xs text-slate-500 mt-0.5">管理 IP 白名单组，可绑定至转发规则</p>
        </div>
        <button
          onClick={handleOpenCreate}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" />
          新建白名单组
        </button>
      </div>

      {/* Search Bar */}
      <div className="px-6 py-3 border-b border-slate-100 shrink-0">
        <div className="relative">
          <input
            type="text"
            placeholder="搜索白名单组..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/60 transition-all"
          />
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* Group List */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {filteredGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <Shield className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm font-medium">
              {searchTerm ? "未找到匹配的白名单组" : "暂无白名单组"}
            </p>
            <p className="text-xs mt-1">
              {searchTerm ? "尝试其他搜索词" : "点击「新建白名单组」创建"}
            </p>
          </div>
        ) : (
          filteredGroups.map((group) => {
            const ipList = formatIps(group.ips);
            const ipCount = ipList.length;
            const maxShow = 3;
            const displayIps = ipList.slice(0, maxShow);
            const remaining = ipCount - maxShow;

            return (
              <div
                key={group.id}
                className="bg-white border border-slate-200/70 rounded-xl p-4 hover:border-slate-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
                        <Shield className="h-4 w-4 text-indigo-600" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-800 truncate">{group.name}</h3>
                        {group.description && (
                          <p className="text-[11px] text-slate-500 truncate mt-0.5">{group.description}</p>
                        )}
                      </div>
                    </div>

                    {/* IP Tags */}
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {displayIps.map((ip, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center px-2 py-0.5 bg-slate-100 text-slate-700 text-[11px] font-mono rounded-md border border-slate-200"
                        >
                          {ip}
                        </span>
                      ))}
                      {remaining > 0 && (
                        <span className="inline-flex items-center px-2 py-0.5 bg-slate-50 text-slate-500 text-[11px] rounded-md border border-dashed border-slate-200">
                          +{remaining} 个
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 mt-2.5 text-[10px] text-slate-400">
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {ipCount} 个 IP
                      </span>
                      <span>更新于 {new Date(group.updatedAt).toLocaleDateString("zh-CN")}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 ml-3 shrink-0">
                    <button
                      onClick={() => handleOpenEdit(group)}
                      className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                      title="编辑"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(group.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Form Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden animate-in">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-800">
                {editingGroup ? "编辑白名单组" : "新建白名单组"}
              </h3>
              <button onClick={handleCloseForm} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-all">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {formError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  组名称 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="例如: 生产环境白名单、运维团队 IP"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/60 transition-all"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">描述 (可选)</label>
                <input
                  type="text"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="描述该白名单组的用途"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/60 transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  IP 地址列表 <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={formIps}
                  onChange={(e) => setFormIps(e.target.value)}
                  placeholder={`支持以下分隔符: 空格、逗号、分号、换行
例如:
192.168.1.5
192.168.1.0/24
113.89.32.229`}
                  rows={5}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/60 transition-all resize-none"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  支持单个 IP 地址或 CIDR 网段，可使用空格、逗号、分号或换行分隔
                </p>
                {formIps.trim() && (
                  <p className="text-[10px] text-indigo-500 mt-0.5">
                    已输入 {formatIps(formIps).length} 个 IP 地址
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseForm}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      保存中...
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" />
                      {editingGroup ? "保存修改" : "创建"}
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-red-100 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
            <h3 className="text-base font-bold text-slate-800 mb-2">确认删除</h3>
            <p className="text-sm text-slate-500 mb-5">
              删除此白名单组后，已绑定该组的转发规则将保留当前 IP 列表不变。
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDelete(deleteConfirmId);
                  setDeleteConfirmId(null);
                }}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
