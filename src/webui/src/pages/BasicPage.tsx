import { useCallback, useEffect, useState } from 'react'
import { fetchBotConfigView, saveBotConfig } from '../utils/api'
import { showToast } from '../hooks/useToast'
import { useAccount } from '../hooks/useAccount'
import type { PluginConfigView } from '../types'

/** 基础回复：总开关、冷却、延迟与 @ 相关设置（当前实例保存并立即生效；其他实例保存到服务端） */
export default function BasicPage() {
    const { selectedUin, isCurrent, configRevision } = useAccount()
    const [config, setConfig] = useState<PluginConfigView | null>(null)
    const [saving, setSaving] = useState(false)
    /** 编辑基底的服务端 revision（其他实例时用） */
    const [editRevision, setEditRevision] = useState<number | null>(null)

    const fetchConfig = useCallback(async () => {
        try {
            const view = await fetchBotConfigView(selectedUin, isCurrent)
            setConfig(view.config)
            setEditRevision(view.revision)
        } catch {
            showToast('获取配置失败', 'error')
        }
    }, [selectedUin, isCurrent])

    useEffect(() => { fetchConfig() }, [fetchConfig])

    const patch = (update: Partial<PluginConfigView>) => {
        if (!config) return
        setConfig({ ...config, ...update })
    }

    const save = async () => {
        if (!config || !selectedUin) return
        setSaving(true)
        try {
            const result = await saveBotConfig({
                enabled: config.enabled,
                cooldownSeconds: config.cooldownSeconds,
                replyDelayMinMs: config.replyDelayMinMs,
                replyDelayMaxMs: config.replyDelayMaxMs,
                atOnly: config.atOnly,
                atReply: config.atReply === true
            }, selectedUin, isCurrent ? configRevision : editRevision)
            if (!result.ok) throw new Error(result.message)
            showToast(isCurrent ? '配置已保存并立即生效' : '已保存到服务端，该号下次同步后生效', 'success')
            await fetchConfig()
        } catch (e) {
            showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setSaving(false)
        }
    }

    if (!config) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载配置中...</div>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-4 max-w-2xl mx-auto">
            <div className="card animate-fade-in-up">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-5">基础配置</h3>
                <div className="space-y-5">
                    <ToggleRow
                        label="启用自动回复"
                        desc="总开关，关闭后私聊与群聊都不再自动回复"
                        checked={config.enabled}
                        onChange={(v) => patch({ enabled: v })}
                    />
                    <InputRow
                        label="回复冷却（秒）"
                        desc="同一用户命中同一规则后的最短间隔，0 = 关闭"
                        value={String(config.cooldownSeconds ?? 0)}
                        type="number"
                        onChange={(v) => patch({ cooldownSeconds: Number(v) || 0 })}
                    />
                    <InputRow
                        label="回复延迟下限（毫秒）"
                        desc="回复前随机等待下限，拟人化防风控"
                        value={String(config.replyDelayMinMs ?? 0)}
                        type="number"
                        onChange={(v) => patch({ replyDelayMinMs: Number(v) || 0 })}
                    />
                    <InputRow
                        label="回复延迟上限（毫秒）"
                        desc="需大于等于下限"
                        value={String(config.replyDelayMaxMs ?? 0)}
                        type="number"
                        onChange={(v) => patch({ replyDelayMaxMs: Number(v) || 0 })}
                    />
                    <ToggleRow
                        label="群聊仅被 @ 时回复"
                        desc="全局默认值；群规则里可以按群覆盖"
                        checked={config.atOnly}
                        onChange={(v) => patch({ atOnly: v })}
                    />
                    <ToggleRow
                        label="群聊回复时 @ 触发者"
                        desc="回复消息前带上 @；私聊不受影响"
                        checked={config.atReply === true}
                        onChange={(v) => patch({ atReply: v })}
                    />
                </div>
            </div>

            <div className="flex justify-end">
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                    {saving ? '保存中...' : isCurrent ? '保存并立即生效' : '保存到服务端'}
                </button>
            </div>
        </div>
    )
}

function ToggleRow({ label, desc, checked, onChange }: {
    label: string; desc: string; checked: boolean; onChange: (v: boolean) => void
}) {
    return (
        <div className="flex items-center justify-between gap-4">
            <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{desc}</div>
            </div>
            <label className="toggle flex-shrink-0">
                <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
                <div className="slider" />
            </label>
        </div>
    )
}

function InputRow({ label, desc, value, type = 'text', onChange }: {
    label: string; desc: string; value: string; type?: string; onChange: (v: string) => void
}) {
    const [local, setLocal] = useState(value)
    useEffect(() => { setLocal(value) }, [value])
    return (
        <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">{label}</div>
            <div className="text-xs text-gray-400 mb-2">{desc}</div>
            <input
                className="input-field"
                type={type}
                value={local}
                onChange={(e) => setLocal(e.target.value)}
                onBlur={() => { if (local !== value) onChange(local) }}
            />
        </div>
    )
}
