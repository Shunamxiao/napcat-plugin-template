import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchBotConfigView, saveBotConfig, noAuthFetch } from '../utils/api'
import { useAccount } from '../hooks/useAccount'
import { showToast } from '../hooks/useToast'
import { Btn, Card, Drawer, Empty, Loading, Row, Segmented, Switch, Tag } from '../ui/kit'
import type { GroupDefaultView, GroupMode, GroupRuleEntry, GroupsResponse, MissPolicy } from '../types'

const MODE_OPTIONS: { value: GroupMode; label: string; hint: string }[] = [
    { value: 'off', label: '关闭', hint: '一律不回（含 @）' },
    { value: 'all', label: '响应所有消息', hint: '命中关键词或按未命中策略回复' },
    { value: 'at', label: '仅 @ 时响应', hint: '只有 @ / 引用机器人，或非 @ 命中关键词时才处理' },
]

const MISS_OPTIONS: { value: MissPolicy; label: string; hint: string }[] = [
    { value: 'ai_then_fallback', label: '交给 AI 再兜底', hint: '先问服务，无答案/失败回兜底' },
    { value: 'fallback_only', label: '直接回兜底', hint: '不调服务，直接发兜底文案' },
    { value: 'none', label: '不回复', hint: '未命中关键词时保持沉默' },
]

const DEFAULT_GROUP: GroupDefaultView = {
    mode: 'at',
    missPolicy: 'none',
    atForceReply: true,
    keywordOutsideAt: true,
    cooldownSeconds: null,
    fallbackText: null,
}

/** 群规则：搜索、批量改、抽屉编辑、导入导出、未配置群默认策略 */
export default function GroupsPage() {
    const { selectedUin, isCurrent } = useAccount()
    const [rows, setRows] = useState<GroupRuleEntry[]>([])
    const [global, setGlobal] = useState<GroupsResponse['global'] | null>(null)
    const [defaults, setDefaults] = useState<GroupDefaultView>(DEFAULT_GROUP)
    const [defaultsDirty, setDefaultsDirty] = useState(false)
    const [loading, setLoading] = useState(true)
    const [savingId, setSavingId] = useState('')
    const [savingDefaults, setSavingDefaults] = useState(false)
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [manualId, setManualId] = useState('')
    const [editing, setEditing] = useState<GroupRuleEntry | null>(null)
    const [welcomeTouched, setWelcomeTouched] = useState(false)
    const [batch, setBatch] = useState<{ mode: GroupMode | ''; missPolicy: MissPolicy | '' }>({ mode: '', missPolicy: '' })
    const [importOpen, setImportOpen] = useState(false)
    const [importText, setImportText] = useState('')
    const fileRef = useRef<HTMLInputElement>(null)

    // 轮询读带草稿的开关时走 ref：放进依赖数组会让每次切换都重拉整表，冲掉抽屉里的编辑
    const defaultsDirtyRef = useRef(defaultsDirty)
    defaultsDirtyRef.current = defaultsDirty

    const loadGroups = useCallback(async () => {
        try {
            const res = await noAuthFetch<GroupsResponse>('/groups')
            if (res.data) {
                const data = res.data
                setRows(data.groups ?? [])
                setGlobal(data.global ?? null)
                if (!defaultsDirtyRef.current && data.global?.groupDefault) setDefaults({ ...DEFAULT_GROUP, ...data.global.groupDefault })
            }
        } catch (e) {
            showToast('获取群规则失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { loadGroups() }, [loadGroups])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return rows
        return rows.filter((r) => r.groupId.includes(q) || (r.name || '').toLowerCase().includes(q))
    }, [rows, query])

    // welcomeTouched：只有用户真的动过欢迎开关才提交欢迎字段，
    // 否则 row.welcomeEnabled 来自全局解析值，提交上去会变成该群的独立覆盖
    const applyRow = async (row: GroupRuleEntry, welcomeTouched = false): Promise<boolean> => {
        setSavingId(row.groupId)
        try {
            const res = await noAuthFetch<GroupRuleEntry>(`/groups/${encodeURIComponent(row.groupId)}`, {
                method: 'POST',
                body: JSON.stringify({
                    mode: row.mode,
                    missPolicy: row.missPolicy,
                    atForceReply: row.atForceReply,
                    keywordOutsideAt: row.keywordOutsideAt,
                    cooldownSeconds: row.cooldownSeconds,
                    fallbackText: row.fallbackText?.trim() ? row.fallbackText.trim() : null,
                    ...(welcomeTouched || row.source !== 'default'
                        ? {
                            welcomeEnabled: row.welcomeEnabled,
                            welcomeTemplate: row.welcomeTemplate?.trim() ? row.welcomeTemplate : null,
                        }
                        : {}),
                }),
            })
            if (res.code !== 0) throw new Error(res.message || '保存失败')
            if (res.data) {
                const saved = res.data
                setRows((prev) => prev.map((item) => (item.groupId === saved.groupId ? { ...item, ...saved, name: item.name || saved.name } : item)))
            }
            return true
        } catch (e) {
            showToast(`群 ${row.groupId} 保存失败：` + (e instanceof Error ? e.message : String(e)), 'error')
            return false
        } finally {
            setSavingId('')
        }
    }

    const saveDefaults = async () => {
        setSavingDefaults(true)
        try {
            const result = await saveBotConfig({
                groupDefault: {
                    ...defaults,
                    cooldownSeconds: defaults.cooldownSeconds === null ? null : Number(defaults.cooldownSeconds),
                    fallbackText: defaults.fallbackText?.trim() ? defaults.fallbackText : null,
                },
            }, selectedUin, null)
            if (!result.ok) throw new Error(result.message)
            setDefaultsDirty(false)
            showToast(isCurrent ? '未配置群默认策略已保存' : '已保存到服务端，该号下次同步后生效', 'success')
            await loadGroups()
        } catch (e) {
            showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setSavingDefaults(false)
        }
    }

    const applyBatch = async () => {
        if (selected.size === 0) { showToast('先勾选要改的群', 'error'); return }
        if (!batch.mode && !batch.missPolicy) { showToast('至少选一项要改的值', 'error'); return }
        let ok = 0
        for (const groupId of selected) {
            const row = rows.find((r) => r.groupId === groupId)
            if (!row) continue
            const next: GroupRuleEntry = {
                ...row,
                mode: batch.mode || row.mode,
                missPolicy: batch.missPolicy || row.missPolicy,
            }
            if (await applyRow(next)) ok += 1
        }
        showToast(`批量更新 ${ok}/${selected.size} 个群`, ok === selected.size ? 'success' : 'error')
        setSelected(new Set())
        setBatch({ mode: '', missPolicy: '' })
    }

    const exportJson = () => {
        const payload = rows.map((r) => ({
            groupId: r.groupId,
            name: r.name,
            mode: r.mode,
            missPolicy: r.missPolicy,
            atForceReply: r.atForceReply,
            keywordOutsideAt: r.keywordOutsideAt,
            cooldownSeconds: r.cooldownSeconds,
            fallbackText: r.fallbackText,
            welcomeEnabled: r.welcomeEnabled,
            welcomeTemplate: r.welcomeTemplate,
        }))
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), groups: payload }, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `group-rules-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(a.href)
    }

    const importJson = async () => {
        try {
            const parsed = JSON.parse(importText) as { groups?: unknown[] } | unknown[]
            const list = Array.isArray(parsed) ? parsed : parsed.groups
            if (!Array.isArray(list)) throw new Error('需要 {"groups":[...]} 或直接是数组')
            let ok = 0
            for (const item of list) {
                const raw = item as Partial<GroupRuleEntry>
                const groupId = String(raw.groupId ?? '').trim()
                if (!/^\d{5,12}$/.test(groupId)) continue
                const base = rows.find((r) => r.groupId === groupId) ?? { ...defaultEntry(groupId) }
                if (await applyRow({
                    ...base,
                    mode: (raw.mode as GroupMode) ?? base.mode,
                    missPolicy: (raw.missPolicy as MissPolicy) ?? base.missPolicy,
                    atForceReply: raw.atForceReply ?? base.atForceReply,
                    keywordOutsideAt: raw.keywordOutsideAt ?? base.keywordOutsideAt,
                    cooldownSeconds: raw.cooldownSeconds ?? base.cooldownSeconds,
                    fallbackText: raw.fallbackText ?? base.fallbackText,
                    welcomeEnabled: raw.welcomeEnabled ?? base.welcomeEnabled,
                    welcomeTemplate: raw.welcomeTemplate ?? base.welcomeTemplate,
                }, raw.welcomeEnabled !== undefined || raw.welcomeTemplate !== undefined)) ok += 1
            }
            showToast(`导入完成：${ok} 个群`, ok > 0 ? 'success' : 'error')
            setImportOpen(false)
            setImportText('')
            await loadGroups()
        } catch (e) {
            showToast('导入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        }
    }

    const addManual = () => {
        const id = manualId.trim()
        if (!/^\d{5,12}$/.test(id)) { showToast('群号应是 5-12 位数字', 'error'); return }
        if (rows.some((r) => r.groupId === id)) { showToast('这个群已经在列表里了', 'error'); return }
        const entry = defaultEntry(id)
        setRows((prev) => [entry, ...prev])
        setManualId('')
        setEditing(entry)
    }

    if (loading) return <Loading />

    return (
        <div className="space-y-4">
            <Card
                title="未配置群的默认策略"
                desc="服务端和本地都没有条目的群，按这套策略处理"
                actions={<Btn variant="primary" size="sm" loading={savingDefaults} disabled={!defaultsDirty} onClick={saveDefaults}>保存默认</Btn>}
            >
                <Row label="回复模式">
                    <Segmented
                        value={defaults.mode}
                        options={MODE_OPTIONS}
                        onChange={(v) => { setDefaults({ ...defaults, mode: v }); setDefaultsDirty(true) }}
                    />
                </Row>
                <Row label="未命中策略" desc={defaults.mode === 'off' ? '群模式为关闭时不适用' : undefined}>
                    <Segmented
                        value={defaults.missPolicy}
                        options={MISS_OPTIONS}
                        disabled={defaults.mode === 'off'}
                        onChange={(v) => { setDefaults({ ...defaults, missPolicy: v }); setDefaultsDirty(true) }}
                    />
                </Row>
                <Row label="其他开关">
                    <div className="flex items-center gap-4">
                        <label className={`flex items-center gap-2 text-xs ${defaults.mode === 'at' ? '' : 'opacity-40'}`}>
                            <Switch checked={defaults.atForceReply} disabled={defaults.mode !== 'at'} onChange={(v) => { setDefaults({ ...defaults, atForceReply: v }); setDefaultsDirty(true) }} />
                            @ 时未命中仍回兜底
                        </label>
                        <label className={`flex items-center gap-2 text-xs ${defaults.mode === 'all' ? '' : 'opacity-40'}`}>
                            <Switch checked={defaults.keywordOutsideAt} disabled={defaults.mode !== 'all'} onChange={(v) => { setDefaults({ ...defaults, keywordOutsideAt: v }); setDefaultsDirty(true) }} />
                            非 @ 命中关键词也回
                        </label>
                    </div>
                </Row>
            </Card>

            <Card
                title={`群规则（${rows.length}）`}
                desc="服务端条目为准；改动逐群保存"
                actions={
                    <>
                        <Btn size="sm" onClick={exportJson} title="导出为 JSON">导出</Btn>
                        <Btn size="sm" onClick={() => setImportOpen(true)}>导入</Btn>
                        <Btn size="sm" onClick={() => fileRef.current?.click()} title="从文件导入 JSON">文件</Btn>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="application/json,.json"
                            className="hidden"
                            onChange={async (e) => {
                                const file = e.target.files?.[0]
                                if (!file) return
                                setImportText(await file.text())
                                setImportOpen(true)
                                e.target.value = ''
                            }}
                        />
                    </>
                }
            >
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    <input className="input-sm flex-1 min-w-[180px]" placeholder="搜索群名称或群号..." value={query} onChange={(e) => setQuery(e.target.value)} />
                    <input className="input-sm w-40" placeholder="手填群号添加" value={manualId} onChange={(e) => setManualId(e.target.value)} />
                    <Btn size="sm" onClick={addManual}>添加</Btn>
                </div>

                {selected.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 mb-3 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50/60 dark:bg-brand-500/5 px-3 py-2">
                        <span className="text-xs text-brand-700 dark:text-brand-300">已选 {selected.size} 个群</span>
                        <Segmented
                            value={batch.mode}
                            options={[{ value: '', label: '模式不变' }, ...MODE_OPTIONS]}
                            onChange={(v) => setBatch({ ...batch, mode: v as GroupMode | '' })}
                        />
                        <Segmented
                            value={batch.missPolicy}
                            options={[{ value: '', label: '未命中不变' }, ...MISS_OPTIONS]}
                            onChange={(v) => setBatch({ ...batch, missPolicy: v as MissPolicy | '' })}
                        />
                        <Btn variant="primary" size="sm" onClick={applyBatch}>应用到所选</Btn>
                        <Btn size="sm" onClick={() => { setSelected(new Set()); setBatch({ mode: '', missPolicy: '' }) }}>取消</Btn>
                    </div>
                )}

                {filtered.length === 0 ? (
                    <Empty title={rows.length === 0 ? '还没有群规则' : '没有匹配的群'} desc={rows.length === 0 ? '手填群号添加，或用「导入」批量灌规则' : '换个关键词试试'} />
                ) : (
                    <div className="overflow-x-auto -mx-1">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                                    <th className="py-2 px-1 w-8">
                                        <input
                                            type="checkbox"
                                            checked={selected.size === filtered.length && filtered.length > 0}
                                            onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((r) => r.groupId)) : new Set())}
                                        />
                                    </th>
                                    <th className="py-2 px-1 font-medium">群</th>
                                    <th className="py-2 px-1 font-medium">模式</th>
                                    <th className="py-2 px-1 font-medium hidden sm:table-cell">未命中</th>
                                    <th className="py-2 px-1 font-medium hidden md:table-cell">来源</th>
                                    <th className="py-2 px-1 font-medium text-right">操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((row) => (
                                    <tr key={row.groupId} className="row-hover border-b border-gray-50 dark:border-gray-800/50">
                                        <td className="py-2 px-1">
                                            <input
                                                type="checkbox"
                                                checked={selected.has(row.groupId)}
                                                onChange={(e) => {
                                                    const next = new Set(selected)
                                                    if (e.target.checked) next.add(row.groupId)
                                                    else next.delete(row.groupId)
                                                    setSelected(next)
                                                }}
                                            />
                                        </td>
                                        <td className="py-2 px-1">
                                            <div className="text-gray-800 dark:text-gray-200 truncate max-w-[220px]">{row.name || '（未命名群）'}</div>
                                            <div className="text-[11px] text-gray-400 tabular-nums">{row.groupId}</div>
                                        </td>
                                        <td className="py-2 px-1">
                                            <Tag tone={row.mode === 'off' ? 'muted' : row.mode === 'at' ? 'primary' : 'success'}>
                                                {MODE_OPTIONS.find((m) => m.value === row.mode)?.label}
                                            </Tag>
                                        </td>
                                        <td className="py-2 px-1 text-xs text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                                            {MISS_OPTIONS.find((m) => m.value === row.missPolicy)?.label}
                                        </td>
                                        <td className="py-2 px-1 text-xs text-gray-400 hidden md:table-cell">{row.source === 'server' ? '服务端' : row.source === 'local' ? '本地' : '默认'}</td>
                                        <td className="py-2 px-1 text-right whitespace-nowrap">
                                            <Btn size="sm" loading={savingId === row.groupId} onClick={() => { setEditing({ ...row }); setWelcomeTouched(false) }}>编辑</Btn>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <Drawer
                open={!!editing}
                title={editing ? `群 ${editing.groupId}` : ''}
                desc={editing?.name || '编辑该群的回复策略'}
                dirty={!!editing && JSON.stringify(editing) !== JSON.stringify(rows.find((r) => r.groupId === editing.groupId) ?? null)}
                onClose={() => setEditing(null)}
                footer={
                    <>
                        <Btn onClick={() => setEditing(null)}>取消</Btn>
                        <Btn
                            variant="primary"
                            loading={savingId === (editing?.groupId ?? '')}
                            onClick={async () => {
                                if (!editing) return
                                if (await applyRow(editing, welcomeTouched)) {
                                    showToast(`群 ${editing.groupId} 已保存`, 'success')
                                    setEditing(null)
                                }
                            }}
                        >保存该群</Btn>
                    </>
                }
            >
                {editing && (
                    <>
                        <Row label="回复模式">
                            <Segmented value={editing.mode} options={MODE_OPTIONS} onChange={(v) => setEditing({ ...editing, mode: v })} />
                        </Row>
                        <Row label="未命中策略">
                            <Segmented
                                value={editing.missPolicy}
                                options={MISS_OPTIONS}
                                disabled={editing.mode === 'off'}
                                onChange={(v) => setEditing({ ...editing, missPolicy: v })}
                            />
                        </Row>
                        <Row label="@ 时未命中仍回兜底" desc="仅「仅 @ 时响应」可设">
                            <Switch
                                checked={editing.atForceReply}
                                disabled={editing.mode !== 'at'}
                                onChange={(v) => setEditing({ ...editing, atForceReply: v })}
                            />
                        </Row>
                        <Row label="非 @ 命中关键词也回" desc="仅「响应所有消息」可设">
                            <Switch
                                checked={editing.keywordOutsideAt}
                                disabled={editing.mode !== 'all'}
                                onChange={(v) => setEditing({ ...editing, keywordOutsideAt: v })}
                            />
                        </Row>
                        <Row label="群冷却（秒）" desc="留空 = 跟随全局">
                            <input
                                className="input-sm w-24 text-right"
                                type="number"
                                value={editing.cooldownSeconds ?? ''}
                                placeholder="跟随全局"
                                onChange={(e) => setEditing({ ...editing, cooldownSeconds: e.target.value === '' ? null : Number(e.target.value) })}
                            />
                        </Row>
                        <Row label="群兜底文案" desc="留空 = 跟随全局" stack>
                            <textarea
                                className="input-field min-h-[64px]"
                                value={editing.fallbackText ?? ''}
                                placeholder={global?.fallbackText || '跟随全局兜底'}
                                onChange={(e) => setEditing({ ...editing, fallbackText: e.target.value })}
                            />
                        </Row>
                        <Row label="入群欢迎">
                            <Switch checked={editing.welcomeEnabled} onChange={(v) => { setWelcomeTouched(true); setEditing({ ...editing, welcomeEnabled: v }) }} />
                        </Row>
                        {editing.welcomeEnabled && (
                            <Row label="欢迎语模板" desc="支持 {nickname} / {group_id}" stack>
                                <textarea
                                    className="input-field min-h-[64px]"
                                    value={editing.welcomeTemplate ?? ''}
                                    placeholder="欢迎 {nickname} 加入本群！"
                                    onChange={(e) => setEditing({ ...editing, welcomeTemplate: e.target.value })}
                                />
                            </Row>
                        )}
                    </>
                )}
            </Drawer>

            <Drawer
                open={importOpen}
                title="导入群规则"
                desc='接受 {"groups":[...]} 或直接是数组；按 groupId 合并到现有条目'
                onClose={() => setImportOpen(false)}
                footer={
                    <>
                        <Btn onClick={() => setImportOpen(false)}>取消</Btn>
                        <Btn variant="primary" onClick={importJson}>开始导入</Btn>
                    </>
                }
            >
                <textarea
                    className="input-field min-h-[320px] font-mono text-xs"
                    value={importText}
                    placeholder='{"groups":[{"groupId":"123456","mode":"at","missPolicy":"none"}]}'
                    onChange={(e) => setImportText(e.target.value)}
                />
            </Drawer>
        </div>
    )
}

function defaultEntry(groupId: string): GroupRuleEntry {
    return {
        groupId,
        name: '',
        mode: 'at',
        missPolicy: 'none',
        atForceReply: true,
        keywordOutsideAt: true,
        cooldownSeconds: null,
        fallbackText: null,
        enabled: true,
        atOnly: true,
        aiEnabled: false,
        welcomeEnabled: false,
        welcomeTemplate: null,
        source: 'local',
    }
}
