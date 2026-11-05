import { useCallback, useEffect, useState } from 'react'
import { authFetch, fetchBotConfigView, noAuthFetch, saveBotConfig } from '../utils/api'
import { showToast } from '../hooks/useToast'
import { useAccount } from '../hooks/useAccount'
import type { GuardPolicy, PluginConfigView } from '../types'

/** 守卫与处罚：屏蔽词/命中动作（随账号配置）+ 处罚策略（服务端全局） */
export default function GuardPage() {
    const { selectedUin, isCurrent, configRevision } = useAccount()
    const [config, setConfig] = useState<PluginConfigView | null>(null)
    const [policy, setPolicy] = useState<GuardPolicy | null>(null)
    const [words, setWords] = useState('')
    const [action, setAction] = useState<'recall' | 'warn' | 'both'>('recall')
    const [saving, setSaving] = useState(false)
    /** 编辑基底的服务端 revision（其他实例时用） */
    const [editRevision, setEditRevision] = useState<number | null>(null)

    const fetchAll = useCallback(async () => {
        try {
            const [view, policyRes] = await Promise.all([
                fetchBotConfigView(selectedUin, isCurrent),
                noAuthFetch<GuardPolicy>('/guard-policy')
            ])
            setConfig(view.config)
            setEditRevision(view.revision)
            setWords((view.config.guard?.words ?? []).join('\n'))
            setAction(view.config.guard?.action ?? 'recall')
            if (policyRes.code === 0 && policyRes.data) setPolicy(policyRes.data)
        } catch {
            showToast('获取守卫配置失败', 'error')
        }
    }, [selectedUin, isCurrent])

    useEffect(() => { fetchAll() }, [fetchAll])

    const patchPolicy = (update: Partial<GuardPolicy>) => {
        if (!policy) return
        setPolicy({ ...policy, ...update })
    }

    const save = async () => {
        if (!policy || !config || !selectedUin) return
        setSaving(true)
        try {
            const wordList = words.split('\n').map((line) => line.trim()).filter(Boolean)
            const result = await saveBotConfig({
                guard: {
                    words: wordList,
                    action,
                    // 本地兜底警告文案跟服务端策略保持一致，服务不可达时仍能用
                    warnText: policy.warnText
                }
            }, selectedUin, isCurrent ? configRevision : editRevision)
            if (!result.ok) throw new Error(result.message)
            // 处罚策略是服务端全局状态，与账号无关；编辑其他实例时不顺手动它
            if (isCurrent) {
                const res = await authFetch<GuardPolicy>('/guard-policy', {
                    method: 'POST',
                    body: JSON.stringify({
                        windowSeconds: policy.windowSeconds,
                        threshold: policy.threshold,
                        muteSeconds: policy.muteSeconds,
                        warnText: policy.warnText,
                        muteText: policy.muteText
                    })
                })
                if (res.code !== 0) throw new Error(res.message || '处罚策略保存失败')
            }
            showToast(isCurrent ? '守卫与处罚已保存' : '已保存到服务端，该号下次同步后生效', 'success')
            await fetchAll()
        } catch (e) {
            showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setSaving(false)
        }
    }

    if (!config || !policy) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载守卫配置中...</div>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-4 max-w-3xl mx-auto">
            <div className="card animate-fade-in-up p-5">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">屏蔽词与命中动作</h3>
                <div className="space-y-4">
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">屏蔽词（每行一个，大小写不敏感）</div>
                        <div className="text-xs text-gray-400 mb-2">命中即按动作处理；服务端下发的词表会与本词表叠加生效。</div>
                        <textarea
                            className="input-field font-mono"
                            rows={6}
                            value={words}
                            onChange={(e) => setWords(e.target.value)}
                            placeholder="加微信&#10;代刷"
                        />
                    </div>
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">命中动作</div>
                        <select
                            className="input-field"
                            value={action}
                            onChange={(e) => setAction(e.target.value as 'recall' | 'warn' | 'both')}
                        >
                            <option value="recall">仅撤回</option>
                            <option value="warn">仅警告</option>
                            <option value="both">撤回并警告</option>
                        </select>
                    </div>
                </div>
            </div>

            <div className="card animate-fade-in-up p-5">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">处罚策略</h3>
                <p className="text-xs text-gray-400 mb-4">
                    窗口内命中达到阈值即禁言，并发送禁言提示；禁言失败降级为警告，不重试。
                    策略保存在服务端（当前来源：{policy.source === 'server' ? '服务端' : '本地兜底'}）。
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <NumberField
                        label="统计窗口（秒）"
                        desc="60 – 86400"
                        value={policy.windowSeconds}
                        min={60}
                        max={86400}
                        onChange={(v) => patchPolicy({ windowSeconds: v })}
                    />
                    <NumberField
                        label="阈值次数"
                        desc="1 – 20"
                        value={policy.threshold}
                        min={1}
                        max={20}
                        onChange={(v) => patchPolicy({ threshold: v })}
                    />
                    <NumberField
                        label="禁言时长（秒）"
                        desc="60 – 2592000"
                        value={policy.muteSeconds}
                        min={60}
                        max={2592000}
                        onChange={(v) => patchPolicy({ muteSeconds: v })}
                    />
                </div>
                <div className="mt-4 space-y-4">
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">警告文案</div>
                        <input
                            className="input-field"
                            value={policy.warnText}
                            maxLength={200}
                            onChange={(e) => patchPolicy({ warnText: e.target.value })}
                        />
                    </div>
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">禁言提示文案</div>
                        <input
                            className="input-field"
                            value={policy.muteText}
                            maxLength={200}
                            onChange={(e) => patchPolicy({ muteText: e.target.value })}
                        />
                    </div>
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

function NumberField({ label, desc, value, min, max, onChange }: {
    label: string; desc: string; value: number; min: number; max: number; onChange: (v: number) => void
}) {
    return (
        <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">{label}</div>
            <div className="text-xs text-gray-400 mb-2">{desc}</div>
            <input
                className="input-field"
                type="number"
                min={min}
                max={max}
                value={value}
                onChange={(e) => onChange(Number(e.target.value) || min)}
            />
        </div>
    )
}
