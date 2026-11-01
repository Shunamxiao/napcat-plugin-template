import { useCallback, useEffect, useMemo, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { GroupRuleEntry } from '../types'

/** 群规则：服务端为准的每群启用/仅@/AI/欢迎配置 */
export default function GroupRulesPage() {
    const [rows, setRows] = useState<GroupRuleEntry[]>([])
    const [known, setKnown] = useState<GroupRuleEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [selectedId, setSelectedId] = useState('')
    const [manualId, setManualId] = useState('')
    const [savingId, setSavingId] = useState<string | null>(null)

    const fetchGroups = useCallback(async () => {
        setLoading(true)
        try {
            const res = await noAuthFetch<{ groups: GroupRuleEntry[] }>('/groups')
            if (res.code === 0 && res.data) {
                setRows(res.data.groups)
                setKnown(res.data.groups)
            }
        } catch {
            showToast('获取群列表失败', 'error')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { fetchGroups() }, [fetchGroups])

    const filtered = useMemo(() => {
        if (!search) return rows
        const q = search.toLowerCase()
        return rows.filter((row) => row.groupId.includes(q) || row.name.toLowerCase().includes(q))
    }, [rows, search])

    const patchRow = (groupId: string, update: Partial<GroupRuleEntry>) => {
        setRows((prev) => prev.map((row) => (row.groupId === groupId ? { ...row, ...update } : row)))
    }

    const addGroup = () => {
        const raw = (manualId || selectedId).trim()
        if (!raw) {
            showToast('请选择群或手填群号', 'warning')
            return
        }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
            showToast('群号不合法', 'error')
            return
        }
        if (rows.some((row) => row.groupId === raw)) {
            showToast('该群已在列表中', 'warning')
            return
        }
        const found = known.find((row) => row.groupId === raw)
        setRows((prev) => [
            ...prev,
            found ? { ...found } : {
                groupId: raw,
                name: '',
                enabled: false,
                atOnly: true,
                aiEnabled: false,
                welcomeEnabled: false,
                welcomeTemplate: null,
                source: 'default'
            }
        ])
        setManualId('')
        setSelectedId('')
    }

    const saveRow = async (row: GroupRuleEntry) => {
        setSavingId(row.groupId)
        try {
            const res = await noAuthFetch<GroupRuleEntry>(`/groups/${encodeURIComponent(row.groupId)}`, {
                method: 'POST',
                body: JSON.stringify({
                    enabled: row.enabled,
                    atOnly: row.atOnly,
                    aiEnabled: row.aiEnabled,
                    welcomeEnabled: row.welcomeEnabled,
                    welcomeTemplate: row.welcomeTemplate && row.welcomeTemplate.trim() ? row.welcomeTemplate : null
                })
            })
            if (res.code !== 0) throw new Error(res.message || '保存失败')
            if (res.data) {
                const saved = res.data
                setRows((prev) => prev.map((item) => (item.groupId === saved.groupId ? { ...item, ...saved, name: item.name || saved.name } : item)))
            }
            showToast(`群 ${row.groupId} 已保存`, 'success')
        } catch (e) {
            showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setSavingId(null)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载群列表...</div>
                </div>
            </div>
        )
    }

    const knownOptions = known.filter((item) => !rows.some((row) => row.groupId === item.groupId))

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-3 items-center">
                <input
                    className="input-field w-full sm:w-64"
                    placeholder="搜索群名称或群号..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <select
                    className="input-field w-full sm:w-64"
                    value={selectedId}
                    onChange={(e) => setSelectedId(e.target.value)}
                >
                    <option value="">选择已加入的群...</option>
                    {knownOptions.map((item) => (
                        <option key={item.groupId} value={item.groupId}>
                            {item.name ? `${item.name}（${item.groupId}）` : item.groupId}
                        </option>
                    ))}
                </select>
                <input
                    className="input-field w-full sm:w-40"
                    placeholder="手填群号"
                    inputMode="numeric"
                    value={manualId}
                    onChange={(e) => setManualId(e.target.value)}
                />
                <button className="btn btn-ghost text-xs" onClick={addGroup}>添加</button>
                <button className="btn btn-ghost text-xs" onClick={fetchGroups}>刷新</button>
            </div>

            <p className="text-xs text-gray-400">
                共 {rows.length} 个群。保存即写入服务端（Basic 凭据来自实例环境变量），两个实例共用同一套配置。
            </p>

            <div className="space-y-3">
                {filtered.map((row) => (
                    <div key={row.groupId} className="card animate-fade-in-up">
                        <div className="flex flex-wrap items-center gap-3 mb-3">
                            <div className="mr-auto">
                                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                                    {row.name || '（未加入/未命名群）'}（{row.groupId}）
                                </div>
                                <div className="text-[11px] text-gray-400 mt-0.5">
                                    来源：{row.source === 'server' ? '服务端' : row.source === 'local' ? '本地规则' : '默认值'}
                                </div>
                            </div>
                            <button
                                className="btn btn-primary text-xs"
                                disabled={savingId === row.groupId}
                                onClick={() => saveRow(row)}
                            >
                                {savingId === row.groupId ? '保存中...' : '保存'}
                            </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                            <Toggle label="启用自动回复" checked={row.enabled} onChange={(v) => patchRow(row.groupId, { enabled: v })} />
                            <Toggle label="仅 @ 时回复" checked={row.atOnly} onChange={(v) => patchRow(row.groupId, { atOnly: v })} />
                            <Toggle label="允许 AI 升级" checked={row.aiEnabled} onChange={(v) => patchRow(row.groupId, { aiEnabled: v })} />
                            <Toggle label="入群欢迎" checked={row.welcomeEnabled} onChange={(v) => patchRow(row.groupId, { welcomeEnabled: v })} />
                        </div>

                        <div className="mt-3">
                            <div className="text-xs text-gray-400 mb-1">欢迎语模板（支持 {'{user_id}'} {'{nickname}'} {'{group_name}'}；留空跟随全局）</div>
                            <input
                                className="input-field"
                                value={row.welcomeTemplate ?? ''}
                                placeholder="例如：欢迎 {nickname} 加入本群！"
                                onChange={(e) => patchRow(row.groupId, { welcomeTemplate: e.target.value })}
                            />
                        </div>
                    </div>
                ))}

                {filtered.length === 0 && (
                    <div className="py-12 text-center text-gray-400 text-sm empty-state">没有匹配的群</div>
                )}
            </div>
        </div>
    )
}

function Toggle({ label, checked, onChange }: {
    label: string; checked: boolean; onChange: (v: boolean) => void
}) {
    return (
        <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer">
            <span className="text-xs text-gray-600 dark:text-gray-300">{label}</span>
            <span className="toggle flex-shrink-0">
                <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
                <span className="slider" />
            </span>
        </label>
    )
}
