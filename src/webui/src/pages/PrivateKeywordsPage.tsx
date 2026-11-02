import { Fragment, useCallback, useEffect, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { KeywordMatchType, KeywordRuleView, PluginConfigView } from '../types'

type RuleAction = 'reply' | 'ai' | 'human'

/** 表格里可编辑的列；图片/多回复池/动作/启用状态全部在页面内维护，保存时不丢 */
interface KeywordRow {
    id: number
    match: string
    matchType: KeywordMatchType
    reply: string
    /** 多回复池原文，一行一条；保存时解析成 string[] */
    repliesText: string
    image: string
    imageEnabled: boolean
    aiFallback: boolean
    action: RuleAction
    enabled: boolean
    /** 「更多」展开区是否打开，仅影响渲染 */
    expanded: boolean
}

interface KeywordStatEntry {
    count: number
    lastAt: string
}

type KeywordStats = Record<string, KeywordStatEntry>

let nextRowId = 1

function normalizeMatchType(value: string | undefined): KeywordMatchType {
    return value === 'prefix' || value === 'regex' ? value : 'contains'
}

function toRows(rules: KeywordRuleView[] | undefined): KeywordRow[] {
    return (rules ?? []).map((rule) => ({
        id: nextRowId++,
        match: rule.match ?? '',
        matchType: normalizeMatchType(rule.matchType),
        reply: rule.reply ?? '',
        repliesText: (rule.replies ?? []).join('\n'),
        image: rule.image ?? '',
        imageEnabled: Boolean(rule.image),
        aiFallback: rule.aiFallback === true,
        action: rule.action ?? 'reply',
        enabled: rule.enabled !== false,
        expanded: false
    }))
}

/** 多行 QQ 号 → 数组（# 到行尾为注释，坏行跳过），与服务端口径一致 */
function parseIdLines(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.split('#')[0].trim())
        .filter(Boolean)
}

/** 回复池：每行一条，空行跳过 */
function parseReplyPool(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
}

/** 统计键与服务端 keywordStatKey 一致：match 去首尾空白 + matchType（缺省 contains） */
function statKeyOf(row: KeywordRow): string {
    return row.match.trim() + '|' + row.matchType
}

function formatStatTime(iso: string): string {
    const ts = Date.parse(iso)
    if (!Number.isFinite(ts)) return '-'
    return new Date(ts).toLocaleString()
}

/**
 * 与服务端 keywordsToText 逐字节同格式：
 * 匹配词|类型|回复|图片|ai|动作|off
 * 保存时必须同时提交 keywords 与 keywordsText，否则重启后会按旧文本回退。
 */
function rulesToText(rules: KeywordRuleView[]): string {
    return rules.map((rule) => {
        const action = rule.action && rule.action !== 'reply' ? rule.action : ''
        const off = rule.enabled === false
        const extra: string[] = []
        if (rule.image) extra.push(rule.image)
        else if (rule.aiFallback || action || off) extra.push('')
        if (rule.aiFallback) extra.push('ai')
        else if (action || off) extra.push('')
        if (action) extra.push(action)
        else if (off) extra.push('')
        if (off) extra.push('off')
        return `${rule.match}|${rule.matchType || 'contains'}|${rule.reply}${extra.length ? '|' + extra.join('|') : ''}`
    }).join('\n')
}

/** 私聊与关键词：私聊开关/兜底/白名单/合并窗口、AI 私聊兜底、关键词表与黑名单 */
export default function PrivateKeywordsPage() {
    const [loaded, setLoaded] = useState(false)
    const [saving, setSaving] = useState(false)
    const [privateEnabled, setPrivateEnabled] = useState(false)
    const [defaultReply, setDefaultReply] = useState('')
    const [whitelistText, setWhitelistText] = useState('')
    const [mergeWindowMs, setMergeWindowMs] = useState('3000')
    const [aiPrivate, setAiPrivate] = useState(false)
    const [groupAtOnly, setGroupAtOnly] = useState(true)
    const [rows, setRows] = useState<KeywordRow[]>([])
    const [stats, setStats] = useState<KeywordStats>({})
    const [blacklistText, setBlacklistText] = useState('')

    const fetchConfig = useCallback(async () => {
        try {
            const res = await noAuthFetch<PluginConfigView>('/config')
            if (res.code !== 0 || !res.data) throw new Error(res.message || '返回为空')
            const data = res.data
            setPrivateEnabled(data.private?.enabled === true)
            setDefaultReply(data.private?.defaultReply ?? '')
            // 以数组为准生成文本，避免盘上的 whitelistText/blacklistText 陈旧
            setWhitelistText((data.private?.whitelist ?? []).map(String).join('\n'))
            setMergeWindowMs(String(data.private?.mergeWindowMs ?? 3000))
            setAiPrivate(data.aiTrigger?.private === true)
            setGroupAtOnly(data.aiTrigger?.groupAtOnly !== false)
            setRows(toRows(data.keywords))
            setBlacklistText((data.blacklist ?? []).map(String).join('\n'))
            setLoaded(true)
        } catch (e) {
            showToast('获取私聊配置失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        }
    }, [])

    const fetchStats = useCallback(async () => {
        try {
            const res = await noAuthFetch<KeywordStats>('/keyword-stats')
            if (res.code !== 0 || !res.data) throw new Error(res.message || '返回为空')
            setStats(res.data)
        } catch (e) {
            showToast('获取命中统计失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        }
    }, [])

    useEffect(() => {
        fetchConfig()
        fetchStats()
    }, [fetchConfig, fetchStats])

    const patchRow = (id: number, update: Partial<KeywordRow>) => {
        setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...update } : row)))
    }

    const addRow = () => {
        setRows((prev) => [...prev, {
            id: nextRowId++,
            match: '',
            matchType: 'prefix',
            reply: '',
            repliesText: '',
            image: '',
            imageEnabled: false,
            aiFallback: false,
            action: 'reply',
            enabled: true,
            expanded: false
        }])
    }

    const removeRow = (id: number) => {
        setRows((prev) => prev.filter((row) => row.id !== id))
    }

    const moveRow = (index: number, offset: number) => {
        setRows((prev) => {
            const target = index + offset
            if (target < 0 || target >= prev.length) return prev
            const next = [...prev]
            const [item] = next.splice(index, 1)
            next.splice(target, 0, item)
            return next
        })
    }

    /** 匹配内容+匹配方式重复的键；只提示、不阻止保存 */
    const duplicateLabels = (() => {
        const seen = new Set<string>()
        const duplicates = new Set<string>()
        for (const row of rows) {
            const match = row.match.trim()
            if (!match) continue
            const key = match + '|' + row.matchType
            if (seen.has(key)) duplicates.add(`${match}（${row.matchType}）`)
            else seen.add(key)
        }
        return [...duplicates]
    })()

    /** 校验并生成结构化规则；返回 null 表示校验失败（已弹 Toast） */
    const buildRules = (): KeywordRuleView[] | null => {
        const rules: KeywordRuleView[] = []
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]
            const match = row.match.trim()
            const reply = row.reply.trim()
            const replies = parseReplyPool(row.repliesText)
            const image = row.imageEnabled ? row.image.trim() : ''
            const action = row.action ?? 'reply'
            // 整行空白（含回复池/图片）自动忽略
            if (!match && !reply && replies.length === 0 && !image) continue
            if (!match) {
                showToast(`第 ${i + 1} 行关键词缺少匹配内容`, 'error')
                return null
            }
            if (!reply && replies.length === 0 && action !== 'ai') {
                showToast(`第 ${i + 1} 行关键词缺少回复内容或回复池`, 'error')
                return null
            }
            if (match.includes('|') || reply.includes('|')) {
                showToast(`第 ${i + 1} 行关键词的匹配内容或回复里不能出现竖线「|」`, 'error')
                return null
            }
            if (row.matchType === 'regex') {
                try {
                    new RegExp(match)
                } catch {
                    showToast(`第 ${i + 1} 行关键词不是合法的正则表达式`, 'error')
                    return null
                }
            }
            const rule: KeywordRuleView = {
                match,
                matchType: row.matchType,
                reply,
                action
            }
            if (image) rule.image = image
            if (replies.length > 0) rule.replies = replies
            if (row.aiFallback) rule.aiFallback = true
            if (!row.enabled) rule.enabled = false
            rules.push(rule)
        }
        return rules
    }

    const save = async () => {
        const rules = buildRules()
        if (!rules) return
        const whitelist = parseIdLines(whitelistText)
        const blacklist = parseIdLines(blacklistText)
        const windowMs = Math.min(60000, Math.max(0, Math.floor(Number(mergeWindowMs) || 0)))
        setSaving(true)
        try {
            const res = await noAuthFetch('/config', {
                method: 'POST',
                body: JSON.stringify({
                    private: {
                        enabled: privateEnabled,
                        defaultReply,
                        whitelist,
                        whitelistText,
                        mergeWindowMs: windowMs
                    },
                    aiTrigger: { private: aiPrivate },
                    keywords: rules,
                    // 服务端按 keywordsText 覆盖 keywords：两个字段必须同时写，否则重启回退
                    keywordsText: rulesToText(rules),
                    blacklist,
                    blacklistText
                })
            })
            if (res.code !== 0) throw new Error(res.message || '保存失败')
            showToast('私聊与关键词已保存', 'success')
            await fetchConfig()
        } catch (e) {
            showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setSaving(false)
        }
    }

    const resetStats = async () => {
        if (!window.confirm('确定清空所有关键词命中统计？此操作不可撤销。')) return
        try {
            const res = await noAuthFetch('/keyword-stats/reset', {
                method: 'POST',
                body: JSON.stringify({})
            })
            if (res.code !== 0) throw new Error(res.message || '重置失败')
            showToast('命中统计已重置', 'success')
            await fetchStats()
        } catch (e) {
            showToast('重置统计失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        }
    }

    if (!loaded) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载私聊配置中...</div>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-4 max-w-4xl">
            <div className="card animate-fade-in-up p-5">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-5">私聊</h3>
                <div className="space-y-5">
                    <ToggleRow
                        label="启用私聊自动回复"
                        desc="关闭后私聊消息不再触发任何回复"
                        checked={privateEnabled}
                        onChange={setPrivateEnabled}
                    />
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">私聊兜底文案</div>
                        <div className="text-xs text-gray-400 mb-2">关键词、FAQ 与 AI 都没有命中时发送这句；留空 = 不回</div>
                        <textarea
                            className="input-field"
                            rows={3}
                            value={defaultReply}
                            onChange={(e) => setDefaultReply(e.target.value)}
                            placeholder="例如：我现在不在，稍后回复你～"
                        />
                    </div>
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">私聊白名单</div>
                        <div className="text-xs text-gray-400 mb-2">每行一个 QQ 号，# 开头为注释；留空 = 所有人</div>
                        <textarea
                            className="input-field font-mono"
                            rows={4}
                            value={whitelistText}
                            onChange={(e) => setWhitelistText(e.target.value)}
                            placeholder={'123456789\n# 这一行是注释'}
                        />
                    </div>
                    <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">连发合并窗口（毫秒）</div>
                        <div className="text-xs text-gray-400 mb-2">同一用户在该窗口内连发的消息合并成一次问答；0 = 关闭，最大 60000</div>
                        <input
                            className="input-field"
                            type="number"
                            min={0}
                            max={60000}
                            value={mergeWindowMs}
                            onChange={(e) => setMergeWindowMs(e.target.value)}
                            onBlur={() => {
                                const value = Math.min(60000, Math.max(0, Math.floor(Number(mergeWindowMs) || 0)))
                                setMergeWindowMs(String(value))
                            }}
                        />
                    </div>
                </div>
            </div>

            <div className="card animate-fade-in-up p-5">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-5">AI 触发</h3>
                <div className="space-y-5">
                    <ToggleRow
                        label="私聊允许 AI 兜底"
                        desc="关键词与 FAQ 都没有命中时，是否交给 AI 服务回答"
                        checked={aiPrivate}
                        onChange={setAiPrivate}
                    />
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">群内仅 @ 时触发 AI</div>
                            <div className="text-xs text-gray-400 mt-0.5">只读展示当前值；要修改请到「群规则」页</div>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded-full ${groupAtOnly
                            ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                            : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'}`}>
                            {groupAtOnly ? '已开启' : '已关闭'}
                        </span>
                    </div>
                </div>
            </div>

            <div className="card animate-fade-in-up p-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">关键词规则</h3>
                    <div className="flex items-center gap-2">
                        <button className="btn btn-ghost text-xs" onClick={resetStats}>重置统计</button>
                        <button className="btn btn-ghost text-xs" onClick={addRow}>新增关键词</button>
                    </div>
                </div>
                <p className="text-xs text-gray-400 mb-3">
                    顺序即优先级，关键词命中优先于 FAQ 与 AI。前缀匹配用「前缀」（「你好」命中「你好啊」），包含用「包含」，正则用「正则」。
                    点「更多」配置回复池、命中动作、图片与 AI 兜底；停用的规则保留在列表里但不再命中。
                </p>
                {duplicateLabels.length > 0 && (
                    <div className="mb-3 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-500/40 dark:bg-yellow-500/10 dark:text-yellow-300">
                        存在重复规则（匹配内容 + 匹配方式）：{duplicateLabels.join('、')}。保存不会被阻止，但只会命中排在前面的那条。
                    </div>
                )}
                {rows.length === 0 ? (
                    <div className="py-8 text-center text-gray-400 text-sm empty-state">还没有关键词规则，点「新增关键词」添加</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-200 dark:border-gray-800">
                                    <th className="py-2 pr-2 font-medium w-14">启用</th>
                                    <th className="py-2 pr-2 font-medium">匹配内容</th>
                                    <th className="py-2 pr-2 font-medium w-28">匹配方式</th>
                                    <th className="py-2 pr-2 font-medium">回复内容</th>
                                    <th className="py-2 pr-2 font-medium w-20 whitespace-nowrap">命中次数</th>
                                    <th className="py-2 pr-2 font-medium w-36 whitespace-nowrap">最近命中</th>
                                    <th className="py-2 font-medium w-52">操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row, index) => {
                                    const hasPool = parseReplyPool(row.repliesText).length > 0
                                    const stat = stats[statKeyOf(row)]
                                    return (
                                        <Fragment key={row.id}>
                                            <tr className={`border-b border-gray-100 dark:border-gray-800/60 ${row.enabled ? '' : 'opacity-50'}`}>
                                                <td className="py-2 pr-2 align-top">
                                                    <label className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                                                        <input
                                                            type="checkbox"
                                                            checked={row.enabled}
                                                            onChange={(e) => patchRow(row.id, { enabled: e.target.checked })}
                                                        />
                                                        {row.enabled ? '启用' : '停用'}
                                                    </label>
                                                </td>
                                                <td className="py-2 pr-2 align-top">
                                                    <input
                                                        className="input-field"
                                                        value={row.match}
                                                        placeholder="例如：你好"
                                                        onChange={(e) => patchRow(row.id, { match: e.target.value })}
                                                    />
                                                </td>
                                                <td className="py-2 pr-2 align-top">
                                                    <select
                                                        className="input-field"
                                                        value={row.matchType}
                                                        onChange={(e) => patchRow(row.id, { matchType: e.target.value as KeywordMatchType })}
                                                    >
                                                        <option value="prefix">前缀</option>
                                                        <option value="contains">包含</option>
                                                        <option value="regex">正则</option>
                                                    </select>
                                                </td>
                                                <td className="py-2 pr-2 align-top">
                                                    <input
                                                        className={`input-field ${hasPool ? 'opacity-60' : ''}`}
                                                        value={row.reply}
                                                        disabled={hasPool}
                                                        title={hasPool ? '有回复池时随机发池内一条；回复内容仅作池空时兜底' : undefined}
                                                        placeholder={hasPool ? '有回复池时随机发池内一条' : '命中后发送的内容'}
                                                        onChange={(e) => patchRow(row.id, { reply: e.target.value })}
                                                    />
                                                    {hasPool && (
                                                        <div className="text-xs text-gray-400 mt-1">有回复池时随机发池内一条；回复内容仅作池空时兜底</div>
                                                    )}
                                                </td>
                                                <td className="py-2 pr-2 align-top text-xs text-gray-700 dark:text-gray-300">
                                                    {stat?.count ?? 0}
                                                </td>
                                                <td className="py-2 pr-2 align-top text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                                                    {stat?.lastAt ? formatStatTime(stat.lastAt) : '-'}
                                                </td>
                                                <td className="py-2 align-top">
                                                    <div className="flex items-center gap-1 flex-wrap">
                                                        <button
                                                            className="btn btn-ghost text-xs px-2 py-1 whitespace-nowrap"
                                                            onClick={() => patchRow(row.id, { expanded: !row.expanded })}
                                                        >
                                                            {row.expanded ? '收起' : '更多'}
                                                        </button>
                                                        <button
                                                            className="btn btn-ghost text-xs px-2 py-1 whitespace-nowrap"
                                                            disabled={index === 0}
                                                            onClick={() => moveRow(index, -1)}
                                                        >
                                                            上移
                                                        </button>
                                                        <button
                                                            className="btn btn-ghost text-xs px-2 py-1 whitespace-nowrap"
                                                            disabled={index === rows.length - 1}
                                                            onClick={() => moveRow(index, 1)}
                                                        >
                                                            下移
                                                        </button>
                                                        <button
                                                            className="btn btn-ghost text-xs px-2 py-1 whitespace-nowrap text-red-500"
                                                            onClick={() => removeRow(row.id)}
                                                        >
                                                            删除
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                            {row.expanded && (
                                                <tr className={`border-b border-gray-100 dark:border-gray-800/60 ${row.enabled ? '' : 'opacity-50'}`}>
                                                    <td colSpan={7} className="py-3 pr-2">
                                                        <div className="grid gap-4 md:grid-cols-2">
                                                            <div>
                                                                <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">多回复池（每行一条）</div>
                                                                <div className="text-xs text-gray-400 mb-2">有内容时随机发一条，优先于「回复内容」；清空即删除该字段</div>
                                                                <textarea
                                                                    className="input-field"
                                                                    rows={4}
                                                                    value={row.repliesText}
                                                                    onChange={(e) => patchRow(row.id, { repliesText: e.target.value })}
                                                                    placeholder={'回复一\n回复二'}
                                                                />
                                                            </div>
                                                            <div className="space-y-3">
                                                                <div>
                                                                    <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">命中动作</div>
                                                                    <select
                                                                        className="input-field"
                                                                        value={row.action}
                                                                        onChange={(e) => patchRow(row.id, { action: e.target.value as RuleAction })}
                                                                    >
                                                                        <option value="reply">回复文案</option>
                                                                        <option value="ai">直接问服务 AI</option>
                                                                        <option value="human">转人工</option>
                                                                    </select>
                                                                </div>
                                                                <InlineToggle
                                                                    label="附加图片"
                                                                    checked={row.imageEnabled}
                                                                    onChange={(v) => patchRow(row.id, { imageEnabled: v })}
                                                                />
                                                                {row.imageEnabled && (
                                                                    <input
                                                                        className="input-field"
                                                                        value={row.image}
                                                                        placeholder="图片 URL / base64:// / 容器内路径"
                                                                        onChange={(e) => patchRow(row.id, { image: e.target.value })}
                                                                    />
                                                                )}
                                                                <InlineToggle
                                                                    label="命中时先问知识库/AI"
                                                                    checked={row.aiFallback}
                                                                    onChange={(v) => patchRow(row.id, { aiFallback: v })}
                                                                />
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <div className="card animate-fade-in-up p-5">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">黑名单 QQ</h3>
                <p className="text-xs text-gray-400 mb-3">名单内的号在任何场景（私聊 / 群聊 / AI / 兜底）都不会收到回复；每行一个，# 开头为注释。</p>
                <textarea
                    className="input-field font-mono"
                    rows={4}
                    value={blacklistText}
                    onChange={(e) => setBlacklistText(e.target.value)}
                    placeholder={'10000\n# 这一行是注释'}
                />
            </div>

            <div className="flex justify-end">
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                    {saving ? '保存中...' : '保存私聊与关键词'}
                </button>
            </div>
        </div>
    )
}

function InlineToggle({ label, checked, onChange }: {
    label: string; checked: boolean; onChange: (v: boolean) => void
}) {
    return (
        <label className="inline-flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            {label}
        </label>
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
