import { useCallback, useEffect, useMemo, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { GroupMode, GroupRuleEntry, GroupsResponse, MissPolicy } from '../types'

const MODE_OPTIONS: { value: GroupMode; label: string; hint: string }[] = [
    { value: 'off', label: '关闭', hint: '一律不回（含 @）' },
    { value: 'all', label: '响应所有消息', hint: '命中规则或按未命中策略回复' },
    { value: 'at', label: '仅 @ 时响应', hint: '只有 @ 机器人或引用它时才处理' }
]

const MISS_OPTIONS: { value: MissPolicy; label: string; hint: string }[] = [
    { value: 'ai_then_fallback', label: '交给 AI 再兜底', hint: '先问服务，无答案/失败回兜底' },
    { value: 'fallback_only', label: '直接回兜底', hint: '不调服务，直接发兜底文案' },
    { value: 'none', label: '不回复', hint: '未命中关键词时保持沉默' }
]

/** 群规则：服务端为准的每群回复模式 / 未命中策略 / 兜底与欢迎配置 */
export default function GroupRulesPage() {
    const [rows, setRows] = useState<GroupRuleEntry[]>([])
    const [known, setKnown] = useState<GroupRuleEntry[]>([])
    const [globalDefaults, setGlobalDefaults] = useState<GroupsResponse['global']>({ cooldownSeconds: 0, fallbackText: '' })
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [selectedId, setSelectedId] = useState('')
    const [manualId, setManualId] = useState('')
    const [savingId, setSavingId] = useState<string | null>(null)

    const fetchGroups = useCallback(async () => {
        setLoading(true)
        try {
            const res = await noAuthFetch<GroupsResponse>('/groups')
            if (res.code === 0 && res.data) {
                setRows(res.data.groups)
                setKnown(res.data.groups)
                if (res.data.global) setGlobalDefaults(res.data.global)
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
                mode: 'off',
                missPolicy: 'fallback_only',
                atForceReply: true,
                keywordOutsideAt: true,
                cooldownSeconds: null,
                fallbackText: null,
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
            const fallbackText = row.fallbackText && row.fallbackText.trim() ? row.fallbackText.trim() : null
            const res = await noAuthFetch<GroupRuleEntry>(`/groups/${encodeURIComponent(row.groupId)}`, {
                method: 'POST',
                body: JSON.stringify({
                    mode: row.mode,
                    missPolicy: row.missPolicy,
                    atForceReply: row.atForceReply,
                    keywordOutsideAt: row.keywordOutsideAt,
                    cooldownSeconds: row.cooldownSeconds,
                    fallbackText,
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
                {filtered.map((row) => {
                    const off = row.mode === 'off'
                    return (
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

                            <div className="space-y-3">
                                <RadioGroup
                                    label="群模式"
                                    options={MODE_OPTIONS}
                                    value={row.mode}
                                    onChange={(v) => patchRow(row.groupId, { mode: v })}
                                />
                                <RadioGroup
                                    label="未命中关键词时"
                                    options={MISS_OPTIONS}
                                    value={row.missPolicy}
                                    onChange={(v) => patchRow(row.groupId, { missPolicy: v })}
                                    disabled={off}
                                    disabledHint={off ? '群模式为关闭时不适用' : ''}
                                />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
                                <Toggle
                                    label="被 @ 必回兜底"
                                    checked={row.atForceReply}
                                    disabled={row.mode !== 'at'}
                                    hint={row.mode === 'at' ? '未命中且选“不回复”时仍回兜底' : '仅「仅 @ 时响应」可设'}
                                    onChange={(v) => patchRow(row.groupId, { atForceReply: v })}
                                />
                                <Toggle
                                    label="非 @ 命中关键词也回"
                                    checked={row.keywordOutsideAt}
                                    disabled={row.mode !== 'all'}
                                    hint={row.mode === 'all' ? '关闭后非 @ 命中关键词也不回' : '仅「响应所有消息」可设'}
                                    onChange={(v) => patchRow(row.groupId, { keywordOutsideAt: v })}
                                />
                                <Toggle
                                    label="命中关键词后 AI 可补充"
                                    checked={row.missPolicy === 'ai_then_fallback'}
                                    disabled={off}
                                    hint="沿用规则 aiFallback；开启即未命中策略选「交给 AI 再兜底」"
                                    onChange={(v) => patchRow(row.groupId, { missPolicy: v ? 'ai_then_fallback' : 'fallback_only' })}
                                />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                                <div>
                                    <div className="text-xs text-gray-400 mb-1">
                                        群级兜底文案（留空跟随全局
                                        {globalDefaults.fallbackText ? `：${globalDefaults.fallbackText}` : '：当前为空'}）
                                    </div>
                                    <input
                                        className="input-field"
                                        value={row.fallbackText ?? ''}
                                        placeholder="留空 = 跟随全局"
                                        onChange={(e) => patchRow(row.groupId, { fallbackText: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <div className="text-xs text-gray-400 mb-1">
                                        群级冷却秒数（留空跟随全局，当前 {globalDefaults.cooldownSeconds} 秒；0 = 关闭）
                                    </div>
                                    <input
                                        className="input-field"
                                        type="number"
                                        min={0}
                                        max={3600}
                                        value={row.cooldownSeconds ?? ''}
                                        placeholder={`跟随全局（${globalDefaults.cooldownSeconds} 秒）`}
                                        onChange={(e) => {
                                            const raw = e.target.value.trim()
                                            patchRow(row.groupId, { cooldownSeconds: raw === '' ? null : Number(raw) })
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                                <Toggle
                                    label="入群欢迎"
                                    checked={row.welcomeEnabled}
                                    onChange={(v) => patchRow(row.groupId, { welcomeEnabled: v })}
                                />
                                <div>
                                    <div className="text-xs text-gray-400 mb-1">欢迎语模板（支持 {'{user_id}'} {'{nickname}'} {'{group_name}'}；留空跟随全局）</div>
                                    <input
                                        className="input-field"
                                        value={row.welcomeTemplate ?? ''}
                                        placeholder="例如：欢迎 {nickname} 加入本群！"
                                        onChange={(e) => patchRow(row.groupId, { welcomeTemplate: e.target.value })}
                                    />
                                </div>
                            </div>
                        </div>
                    )
                })}

                {filtered.length === 0 && (
                    <div className="py-12 text-center text-gray-400 text-sm empty-state">没有匹配的群</div>
                )}
            </div>
        </div>
    )
}

function RadioGroup<T extends string>({ label, options, value, onChange, disabled = false, disabledHint = '' }: {
    label: string
    options: { value: T; label: string; hint: string }[]
    value: T
    onChange: (v: T) => void
    disabled?: boolean
    disabledHint?: string
}) {
    return (
        <div>
            <div className="text-xs text-gray-400 mb-1">
                {label}{disabled && disabledHint ? `（${disabledHint}）` : ''}
            </div>
            <div className={`grid grid-cols-1 sm:grid-cols-3 gap-2 ${disabled ? 'opacity-50' : ''}`}>
                {options.map((option) => (
                    <label
                        key={option.value}
                        className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer ${disabled ? 'cursor-not-allowed' : ''} ${
                            value === option.value
                                ? 'border-primary bg-primary/5'
                                : 'border-gray-200 dark:border-gray-700'
                        }`}
                    >
                        <input
                            type="radio"
                            className="mt-0.5"
                            checked={value === option.value}
                            disabled={disabled}
                            onChange={() => onChange(option.value)}
                        />
                        <span>
                            <span className="block text-xs text-gray-700 dark:text-gray-200">{option.label}</span>
                            <span className="block text-[11px] text-gray-400 mt-0.5">{option.hint}</span>
                        </span>
                    </label>
                ))}
            </div>
        </div>
    )
}

function Toggle({ label, checked, onChange, disabled = false, hint = '' }: {
    label: string
    checked: boolean
    onChange: (v: boolean) => void
    disabled?: boolean
    hint?: string
}) {
    return (
        <label
            className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            title={hint}
        >
            <span>
                <span className="block text-xs text-gray-600 dark:text-gray-300">{label}</span>
                {hint && <span className="block text-[11px] text-gray-400 mt-0.5">{hint}</span>}
            </span>
            <span className="toggle flex-shrink-0">
                <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.checked)}
                />
                <span className="slider" />
            </span>
        </label>
    )
}
