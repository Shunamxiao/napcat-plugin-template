import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchBotConfigView, noAuthFetch, saveBotConfig } from '../utils/api'
import { showToast } from '../hooks/useToast'
import { useAccount } from '../hooks/useAccount'
import type {
    GroupDefaultView,
    GroupMode,
    GroupRuleEntry,
    GroupsResponse,
    HitLogEntry,
    MissPolicy
} from '../types'

const MODE_OPTIONS: { value: GroupMode; label: string; hint: string }[] = [
    { value: 'off', label: '关闭', hint: '一律不回（含 @）' },
    { value: 'all', label: '响应所有消息', hint: '命中规则或按未命中策略回复' },
    { value: 'at', label: '仅 @ 时响应', hint: '只有 @ / 引用机器人，或非 @ 命中关键词时才处理' }
]

const MISS_OPTIONS: { value: MissPolicy; label: string; hint: string }[] = [
    { value: 'ai_then_fallback', label: '交给 AI 再兜底', hint: '先问服务，无答案/失败回兜底' },
    { value: 'fallback_only', label: '直接回兜底', hint: '不调服务，直接发兜底文案' },
    { value: 'none', label: '不回复', hint: '未命中关键词时保持沉默' }
]

const DEFAULT_GROUP: GroupDefaultView = {
    mode: 'at',
    missPolicy: 'none',
    atForceReply: true,
    keywordOutsideAt: false,
    cooldownSeconds: null,
    fallbackText: null
}

const SOURCE_LABEL: Record<GroupRuleEntry['source'], string> = {
    server: '服务端',
    local: '群级',
    default: '默认'
}

const SOURCE_HINT: Record<GroupRuleEntry['source'], string> = {
    server: '服务端有该群条目，以服务端为准',
    local: '本地 groupRules 有该群条目，使用群级配置',
    default: '服务端与本地都没有条目，使用「群默认（未配置群）」'
}

/** 群规则：服务端为准的每群回复模式 / 未命中策略 / 兜底与欢迎配置 */
export default function GroupRulesPage() {
    const { selectedUin, isCurrent, configRevision } = useAccount()
    const [rows, setRows] = useState<GroupRuleEntry[]>([])
    const [known, setKnown] = useState<GroupRuleEntry[]>([])
    const [globalDefaults, setGlobalDefaults] = useState<GroupsResponse['global']>({ cooldownSeconds: 0, fallbackText: '' })
    const [groupDefault, setGroupDefault] = useState<GroupDefaultView>(DEFAULT_GROUP)
    const [keywordCount, setKeywordCount] = useState<number | null>(null)
    const [logs, setLogs] = useState<HitLogEntry[]>([])
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [selectedId, setSelectedId] = useState('')
    const [manualId, setManualId] = useState('')
    const [savingId, setSavingId] = useState<string | null>(null)
    const [savingDefault, setSavingDefault] = useState(false)

    const fetchGroups = useCallback(async () => {
        setLoading(true)
        try {
            const res = await noAuthFetch<GroupsResponse>('/groups')
            if (res.code === 0 && res.data) {
                setRows(res.data.groups)
                setKnown(res.data.groups)
                if (res.data.global) {
                    setGlobalDefaults(res.data.global)
                    if (res.data.global.groupDefault) setGroupDefault({ ...DEFAULT_GROUP, ...res.data.global.groupDefault })
                }
            }
        } catch {
            showToast('获取群列表失败', 'error')
        } finally {
            setLoading(false)
        }
    }, [])

    const fetchKeywordCount = useCallback(async () => {
        try {
            const view = await fetchBotConfigView(selectedUin, isCurrent)
            setKeywordCount((view.config.keywords ?? []).length)
            // 编辑其他实例时，「群默认（未配置群）」卡片按该号服务端配置回显
            const remoteDefault = view.config.groupDefault as Partial<GroupDefaultView> | undefined
            if (!isCurrent && remoteDefault) {
                setGroupDefault({ ...DEFAULT_GROUP, ...remoteDefault })
            }
        } catch { /* 摘要非关键数据，失败不打扰 */ }
    }, [selectedUin, isCurrent])

    const fetchLogs = useCallback(async () => {
        try {
            const res = await noAuthFetch<{ entries: HitLogEntry[] }>('/logs?limit=10')
            if (res.code === 0 && res.data) setLogs(res.data.entries ?? [])
        } catch { /* 日志非关键数据，失败不打扰 */ }
    }, [])

    useEffect(() => {
        fetchGroups()
        fetchKeywordCount()
        fetchLogs()
    }, [fetchGroups, fetchKeywordCount, fetchLogs])

    const filtered = useMemo(() => {
        if (!search) return rows
        const q = search.toLowerCase()
        return rows.filter((row) => row.groupId.includes(q) || row.name.toLowerCase().includes(q))
    }, [rows, search])

    const sourceCounts = useMemo(() => {
        const counts = { server: 0, local: 0, default: 0 }
        for (const row of rows) counts[row.source] += 1
        return counts
    }, [rows])

    const modeCounts = useMemo(() => {
        const counts = { off: 0, all: 0, at: 0 }
        for (const row of rows) counts[row.mode] += 1
        return counts
    }, [rows])

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
        setExpanded((prev) => ({ ...prev, [raw]: true }))
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

    const saveGroupDefault = async () => {
        setSavingDefault(true)
        try {
            // groupDefault 属于账号配置：走保存代理（当前实例同时落本地，其他实例写服务端）
            const result = await saveBotConfig({
                groupDefault: {
                    ...groupDefault,
                    cooldownSeconds: groupDefault.cooldownSeconds === null ? null : Number(groupDefault.cooldownSeconds),
                    fallbackText: groupDefault.fallbackText && groupDefault.fallbackText.trim() ? groupDefault.fallbackText : null
                }
            }, selectedUin, isCurrent ? configRevision : null)
            if (!result.ok) throw new Error(result.message)
            showToast(isCurrent ? '未配置群默认策略已保存' : '已保存到服务端，该号下次同步后生效', 'success')
            await fetchGroups()
        } catch (e) {
            showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setSavingDefault(false)
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
        <div className="max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
            {/* ===== 左：配置 ===== */}
            <div className="space-y-4 min-w-0">
                <div className="card p-5">
                    <div className="flex flex-wrap items-center gap-3 mb-2">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mr-auto">群默认（未配置群）</h3>
                        <button className="btn btn-primary text-xs" onClick={saveGroupDefault} disabled={savingDefault}>
                            {savingDefault ? '保存中...' : isCurrent ? '保存并立即生效' : '保存到服务端'}
                        </button>
                    </div>
                    <p className="text-xs text-gray-400 mb-3">
                        服务端无该群条目、本地 groupRules 也没有时使用这套策略。默认只响应 @ 或引用机器人；
                        普通群消息即使命中关键词也保持静默。
                    </p>
                    <div className="space-y-3">
                        <RadioGroup
                            label="群模式"
                            options={MODE_OPTIONS}
                            value={groupDefault.mode}
                            onChange={(v) => setGroupDefault({ ...groupDefault, mode: v })}
                        />
                        <RadioGroup
                            label="未命中关键词时"
                            options={MISS_OPTIONS}
                            value={groupDefault.missPolicy}
                            onChange={(v) => setGroupDefault({ ...groupDefault, missPolicy: v })}
                            disabled={groupDefault.mode === 'off'}
                            disabledHint={groupDefault.mode === 'off' ? '群模式为关闭时不适用' : ''}
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                        <Toggle
                            label="被 @ 必回兜底"
                            checked={groupDefault.atForceReply}
                            disabled={groupDefault.mode !== 'at'}
                            hint={groupDefault.mode === 'at' ? '未命中且选“不回复”时仍回兜底' : '仅「仅 @ 时响应」可设'}
                            onChange={(v) => setGroupDefault({ ...groupDefault, atForceReply: v })}
                        />
                        <Toggle
                            label="非 @ 命中关键词也回"
                            checked={groupDefault.keywordOutsideAt}
                            hint="at / all 两种模式都生效"
                            onChange={(v) => setGroupDefault({ ...groupDefault, keywordOutsideAt: v })}
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                        <div>
                            <FieldLabel label="冷却秒数" hint="留空 = 跟随全局" />
                            <input
                                className="input-field"
                                type="number"
                                min={0}
                                max={3600}
                                value={groupDefault.cooldownSeconds ?? ''}
                                placeholder={`跟随全局（${globalDefaults.cooldownSeconds} 秒）`}
                                onChange={(e) => {
                                    const raw = e.target.value.trim()
                                    setGroupDefault({ ...groupDefault, cooldownSeconds: raw === '' ? null : Number(raw) })
                                }}
                            />
                        </div>
                        <div>
                            <FieldLabel label="兜底文案" hint="留空 = 跟随全局" />
                            <textarea
                                className="input-field"
                                rows={6}
                                value={groupDefault.fallbackText ?? ''}
                                placeholder={globalDefaults.fallbackText || '留空 = 跟随全局兜底'}
                                onChange={(e) => setGroupDefault({ ...groupDefault, fallbackText: e.target.value })}
                            />
                            <CharCount text={groupDefault.fallbackText ?? ''} />
                        </div>
                    </div>
                </div>

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
                    <button className="btn btn-ghost text-xs" onClick={() => { fetchGroups(); fetchLogs(); }}>刷新</button>
                </div>

                <p className="text-xs text-gray-400">
                    共 {rows.length} 个群。保存即写入服务端（Basic 凭据来自实例环境变量），两个实例共用同一套配置。
                </p>

                {/* 群列表：表头 + 可展开行 */}
                <div className="card overflow-hidden">
                    <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_110px_160px] gap-3 px-4 py-2 text-[11px] text-gray-400 border-b border-gray-100 dark:border-gray-800">
                        <div>群</div>
                        <div>生效来源</div>
                        <div>模式</div>
                        <div className="text-right">操作</div>
                    </div>
                    {filtered.map((row) => {
                        const off = row.mode === 'off'
                        const isOpen = expanded[row.groupId] === true
                        return (
                            <div key={row.groupId} className="border-b border-gray-100 dark:border-gray-800 last:border-b-0">
                                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_120px_110px_160px] gap-2 md:gap-3 items-center px-4 py-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                                            {row.name || '（未加入/未命名群）'}（{row.groupId}）
                                        </div>
                                        <div className="text-[11px] text-gray-400 mt-0.5 truncate">{SOURCE_HINT[row.source]}</div>
                                    </div>
                                    <button
                                        className={`justify-self-start text-xs px-2 py-1 rounded-full border ${row.source === 'server'
                                            ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300'
                                            : row.source === 'local'
                                                ? 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300'
                                                : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-white/5 dark:text-gray-400'}`}
                                        title="点开查看生效 mode / missPolicy"
                                        onClick={() => setExpanded((prev) => ({ ...prev, [row.groupId]: !isOpen }))}
                                    >
                                        生效来源：{SOURCE_LABEL[row.source]} {isOpen ? '▴' : '▾'}
                                    </button>
                                    <div className="text-xs text-gray-600 dark:text-gray-300">
                                        {row.mode} / {row.missPolicy}
                                    </div>
                                    <div className="flex items-center gap-2 md:justify-end">
                                        <button className="btn btn-ghost text-xs" onClick={() => setExpanded((prev) => ({ ...prev, [row.groupId]: !isOpen }))}>
                                            {isOpen ? '收起' : '编辑'}
                                        </button>
                                        <button
                                            className="btn btn-primary text-xs"
                                            disabled={savingId === row.groupId}
                                            onClick={() => saveRow(row)}
                                        >
                                            {savingId === row.groupId ? '保存中...' : '保存'}
                                        </button>
                                    </div>
                                </div>

                                {isOpen && (
                                    <div className="px-4 pb-4">
                                        <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3 mb-3 text-xs text-gray-500 dark:text-gray-400">
                                            当前生效：<b>{row.mode}</b> / <b>{row.missPolicy}</b>（来源：{SOURCE_LABEL[row.source]}）
                                            {row.source === 'default' && '；保存后写入服务端，来源变为「服务端」'}
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
                                                hint="at / all 两种模式都生效"
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
                                                <FieldLabel
                                                    label="群级兜底文案"
                                                    hint={`留空跟随全局${globalDefaults.fallbackText ? `：${globalDefaults.fallbackText}` : '：当前为空'}`}
                                                />
                                                <textarea
                                                    className="input-field"
                                                    rows={6}
                                                    value={row.fallbackText ?? ''}
                                                    placeholder="留空 = 跟随全局"
                                                    onChange={(e) => patchRow(row.groupId, { fallbackText: e.target.value })}
                                                />
                                                <CharCount text={row.fallbackText ?? ''} />
                                            </div>
                                            <div>
                                                <FieldLabel
                                                    label="群级冷却秒数"
                                                    hint={`留空跟随全局（当前 ${globalDefaults.cooldownSeconds} 秒；0 = 关闭）`}
                                                />
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
                                                <FieldLabel label="欢迎语模板" hint="支持 {user_id} {nickname} {group_name}；留空跟随全局" />
                                                <textarea
                                                    className="input-field"
                                                    rows={6}
                                                    value={row.welcomeTemplate ?? ''}
                                                    placeholder="例如：欢迎 {nickname} 加入本群！"
                                                    onChange={(e) => patchRow(row.groupId, { welcomeTemplate: e.target.value })}
                                                />
                                                <CharCount text={row.welcomeTemplate ?? ''} />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                    {filtered.length === 0 && (
                        <div className="py-12 text-center text-gray-400 text-sm empty-state">没有匹配的群</div>
                    )}
                </div>
            </div>

            {/* ===== 右：生效摘要 + 最近命中 ===== */}
            <div className="space-y-4 xl:sticky xl:top-4">
                <div className="card p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">生效摘要</h3>
                    <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
                        <div className="flex justify-between"><span>群总数</span><b className="text-gray-800 dark:text-gray-100">{rows.length}</b></div>
                        <div className="flex justify-between"><span>服务端条目</span><b className="text-gray-800 dark:text-gray-100">{sourceCounts.server}</b></div>
                        <div className="flex justify-between"><span>群级配置</span><b className="text-gray-800 dark:text-gray-100">{sourceCounts.local}</b></div>
                        <div className="flex justify-between"><span>走群默认</span><b className="text-gray-800 dark:text-gray-100">{sourceCounts.default}</b></div>
                        <div className="h-px bg-gray-100 dark:bg-gray-800 my-1" />
                        <div className="flex justify-between"><span>模式 all / at / off</span><b className="text-gray-800 dark:text-gray-100">{modeCounts.all} / {modeCounts.at} / {modeCounts.off}</b></div>
                        <div className="flex justify-between"><span>关键词条数</span><b className="text-gray-800 dark:text-gray-100">{keywordCount ?? '-'}</b></div>
                        <div className="flex justify-between"><span>未配置群默认</span><b className="text-gray-800 dark:text-gray-100">{groupDefault.mode} / {groupDefault.missPolicy}</b></div>
                        <div className="flex justify-between"><span>全局冷却</span><b className="text-gray-800 dark:text-gray-100">{globalDefaults.cooldownSeconds} 秒</b></div>
                    </div>
                </div>

                <div className="card p-5">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">最近命中日志</h3>
                        <button className="btn btn-ghost text-xs" onClick={fetchLogs}>刷新</button>
                    </div>
                    {logs.length === 0 ? (
                        <div className="text-xs text-gray-400 py-6 text-center">暂无记录</div>
                    ) : (
                        <ul className="space-y-2">
                            {logs.slice(0, 10).map((entry, index) => (
                                <li key={entry.ts + index} className="text-xs border-b border-gray-50 dark:border-gray-800/60 pb-2 last:border-b-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-gray-500 dark:text-gray-400">{entry.channel === 'group' ? `群 ${entry.groupId}` : `私聊 ${entry.userId}`}</span>
                                        <span className={entry.result === 'answered' ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}>
                                            {entry.result}
                                        </span>
                                    </div>
                                    <div className="text-[11px] text-gray-400 mt-0.5 break-all">{entry.detail || '-'}</div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    )
}

function CharCount({ text }: { text: string }) {
    return <div className="text-[11px] text-gray-400 mt-1 text-right">{text.length} 字</div>
}

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
    return (
        <div className="text-xs text-gray-400 mb-1">
            {label}{hint ? `（${hint}）` : ''}
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
