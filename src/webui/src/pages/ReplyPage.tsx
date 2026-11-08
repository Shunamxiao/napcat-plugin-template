import { useCallback, useEffect, useMemo, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { useConfigDraft } from '../hooks/useConfig'
import { showToast } from '../hooks/useToast'
import { Btn, Card, Drawer, Empty, Loading, Row, SaveBar, Segmented, Switch, Tag } from '../ui/kit'
import type { KeywordRuleView, KeywordStatsMap } from '../types'

const MATCH_TYPES = [
    { value: 'contains', label: '包含', hint: '消息里出现该文本即命中' },
    { value: 'prefix', label: '前缀', hint: '消息以该文本开头才命中' },
    { value: 'regex', label: '正则', hint: '/pattern/i 或裸表达式；写错会在保存前提示' },
] as const

const ACTIONS = [
    { value: 'reply', label: '回话术', hint: '发规则里的回复内容' },
    { value: 'ai', label: '直接问 AI', hint: '跳过话术，先问知识库/AI，拿不到再兜底' },
    { value: 'human', label: '转人工', hint: '回兜底话术并留档给人工' },
] as const

export type EditRule = KeywordRuleView

const emptyRule = (): EditRule => ({ match: '', matchType: 'contains', action: 'reply', reply: '', replies: [], enabled: true })

/** 回复规则：关键词全字段编辑（图片、回复池、正则、动作、AI 兜底）+ 兜底话术 + 转人工追问 */
export default function ReplyPage() {
    const { draft, update, dirty, save, saving, loading, error } = useConfigDraft()
    const [stats, setStats] = useState<KeywordStatsMap>({})
    const [editing, setEditing] = useState<{ index: number; rule: EditRule } | null>(null)

    const loadStats = useCallback(async () => {
        try {
            const res = await noAuthFetch<KeywordStatsMap>('/keyword-stats')
            if (res.data) setStats(res.data)
        } catch { /* 统计不可用不影响编辑 */ }
    }, [])

    useEffect(() => { loadStats() }, [loadStats])

    const keywords = useMemo(() => draft?.keywords ?? [], [draft])
    const collect = draft?.collect
    const fallback = draft?.fallback

    if (loading) return <Loading />
    if (error) return <Card title="加载失败"><div className="text-sm text-red-500">{error}</div></Card>
    if (!draft) return <Empty title="没有可编辑的配置" />

    const setKeywords = (next: KeywordRuleView[]) => update((d) => ({ ...d, keywords: next }))

    const commitRule = (rule: EditRule) => {
        if (!editing) return
        if (!rule.match.trim()) { showToast('匹配文本不能为空', 'error'); return }
        if (rule.matchType === 'regex') {
            try { new RegExp(rule.match) } catch { showToast('正则写错了，保存前先改好', 'error'); return }
        }
        const next = [...keywords]
        if (editing.index < 0) next.push(rule)
        else next[editing.index] = rule
        setKeywords(next)
        setEditing(null)
    }

    const removeRule = (index: number) => {
        if (!window.confirm(`删除规则「${keywords[index]?.match}」？`)) return
        setKeywords(keywords.filter((_, i) => i !== index))
    }

    const move = (index: number, delta: number) => {
        const target = index + delta
        if (target < 0 || target >= keywords.length) return
        const next = [...keywords]
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        setKeywords(next)
    }

    const persist = async () => {
        const result = await save({
            enabled: draft.enabled,
            cooldownSeconds: draft.cooldownSeconds,
            replyDelayMinMs: draft.replyDelayMinMs,
            replyDelayMaxMs: draft.replyDelayMaxMs,
            fallback: draft.fallback,
            collect: draft.collect,
            keywords: draft.keywords,
        })
        showToast(result.ok ? result.message : '保存失败：' + result.message, result.ok ? 'success' : 'error')
        if (result.ok) loadStats()
    }

    return (
        <div className="space-y-4">
            <Card title="总开关与节奏" desc="冷却与随机延迟用于拟人化防风控">
                <Row label="启用自动回复" desc="关闭后私聊与群聊都不再自动回复">
                    <Switch checked={draft.enabled} onChange={(v) => update((d) => ({ ...d, enabled: v }))} />
                </Row>
                <Row label="回复冷却（秒）" desc="同一用户命中同一规则的最短间隔，0 = 关闭">
                    <input
                        className="input-sm w-24 text-right"
                        type="number"
                        value={draft.cooldownSeconds ?? 0}
                        onChange={(e) => update((d) => ({ ...d, cooldownSeconds: Number(e.target.value) || 0 }))}
                    />
                </Row>
                <Row label="随机延迟（毫秒）" desc="回复前在区间内随机等待">
                    <div className="flex items-center gap-2">
                        <input
                            className="input-sm w-20 text-right" type="number"
                            value={draft.replyDelayMinMs ?? 0}
                            onChange={(e) => update((d) => ({ ...d, replyDelayMinMs: Number(e.target.value) || 0 }))}
                        />
                        <span className="text-xs text-gray-400">~</span>
                        <input
                            className="input-sm w-20 text-right" type="number"
                            value={draft.replyDelayMaxMs ?? 0}
                            onChange={(e) => update((d) => ({ ...d, replyDelayMaxMs: Number(e.target.value) || 0 }))}
                        />
                    </div>
                </Row>
            </Card>

            <Card
                title={`关键词规则（${keywords.length}）`}
                desc="按顺序匹配，第一条命中的规则生效；私聊与未单独配置关键词的群共用这一份"
                actions={<Btn variant="primary" size="sm" onClick={() => setEditing({ index: -1, rule: emptyRule() })}>新增规则</Btn>}
            >
                {keywords.length === 0 ? (
                    <Empty title="还没有关键词规则" desc="加一条试试：匹配「价格」，回复「这里看价：https://apks.cc」" action={<Btn variant="ghost" size="sm" onClick={() => setEditing({ index: -1, rule: emptyRule() })}>新增规则</Btn>} />
                ) : (
                    <div className="overflow-x-auto -mx-1">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                                    <th className="py-2 px-1 font-medium">匹配</th>
                                    <th className="py-2 px-1 font-medium">方式</th>
                                    <th className="py-2 px-1 font-medium hidden sm:table-cell">动作</th>
                                    <th className="py-2 px-1 font-medium hidden md:table-cell">回复</th>
                                    <th className="py-2 px-1 font-medium text-right">命中</th>
                                    <th className="py-2 px-1 font-medium text-right">操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {keywords.map((k, i) => {
                                    const stat = stats[`${k.match}|${k.matchType ?? 'contains'}`]
                                    const disabled = k.enabled === false
                                    return (
                                        <tr key={k.match + i} className={`row-hover border-b border-gray-50 dark:border-gray-800/50 ${disabled ? 'opacity-50' : ''}`}>
                                            <td className="py-2 px-1">
                                                <div className="font-medium text-gray-800 dark:text-gray-200 truncate max-w-[220px]">{k.match || '（空）'}</div>
                                                <div className="flex gap-1 mt-0.5">
                                                    {k.replies && k.replies.length > 0 && <Tag tone="primary">回复池 {k.replies.length}</Tag>}
                                                    {k.image && <Tag tone="warning">图片</Tag>}
                                                    {k.aiFallback && <Tag tone="success">AI 兜底</Tag>}
                                                </div>
                                            </td>
                                            <td className="py-2 px-1 text-xs text-gray-500 dark:text-gray-400">
                                                {MATCH_TYPES.find((m) => m.value === (k.matchType ?? 'contains'))?.label}
                                            </td>
                                            <td className="py-2 px-1 text-xs text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                                                {ACTIONS.find((a) => a.value === (k.action ?? 'reply'))?.label}
                                            </td>
                                            <td className="py-2 px-1 text-xs text-gray-500 dark:text-gray-400 hidden md:table-cell max-w-[240px] truncate">{k.reply || '（空）'}</td>
                                            <td className="py-2 px-1 text-xs text-right tabular-nums text-gray-500 dark:text-gray-400">{stat?.count ?? 0}</td>
                                            <td className="py-2 px-1 text-right whitespace-nowrap">
                                                <Btn size="sm" onClick={() => setEditing({ index: i, rule: { ...k, replies: k.replies ?? [] } })}>编辑</Btn>
                                                <Btn size="sm" onClick={() => move(i, -1)} title="上移">↑</Btn>
                                                <Btn size="sm" onClick={() => move(i, 1)} title="下移">↓</Btn>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <Card title="兜底话术" desc="私聊未命中必回；群内被 @ 且未命中时必回。留空 = 不回">
                <Row label="私聊兜底" stack>
                    <textarea
                        className="input-field min-h-[64px]"
                        value={fallback?.privateText ?? ''}
                        placeholder="例如：这个问题我拿不准，已转人工，稍后回复你～"
                        onChange={(e) => update((d) => ({ ...d, fallback: { privateText: e.target.value, groupAtText: d.fallback?.groupAtText ?? '' } }))}
                    />
                </Row>
                <Row label="群内 @ 兜底" stack>
                    <textarea
                        className="input-field min-h-[64px]"
                        value={fallback?.groupAtText ?? ''}
                        placeholder="例如：你 @ 的问题我记下了，查一下再回你"
                        onChange={(e) => update((d) => ({ ...d, fallback: { privateText: d.fallback?.privateText ?? '', groupAtText: e.target.value } }))}
                    />
                </Row>
            </Card>

            <Card title="转人工追问" desc="开启后按顺序逐条发问，问完再转人工；关闭则直接转人工">
                <Row label="启用追问" desc="一行一题，最多 5 题">
                    <Switch
                        checked={collect?.enabled === true}
                        onChange={(v) => update((d) => ({ ...d, collect: { enabled: v, questions: d.collect?.questions ?? [] } }))}
                    />
                </Row>
                {collect?.enabled && (
                    <Row label="问题列表" stack>
                        <textarea
                            className="input-field min-h-[96px]"
                            value={(collect.questions ?? []).join('\n')}
                            placeholder={'你用的是哪款设备？\n什么系统版本？\n装的是哪个版本的游戏？'}
                            onChange={(e) => update((d) => ({
                                ...d,
                                collect: { enabled: true, questions: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) },
                            }))}
                        />
                    </Row>
                )}
            </Card>

            <SaveBar dirty={dirty} saving={saving} onSave={persist} label="保存并生效" />

            <Drawer
                open={!!editing}
                title={editing && editing.index < 0 ? '新增关键词规则' : '编辑关键词规则'}
                desc="正则写错会提示；回复池非空时优先随机发池内一条"
                onClose={() => setEditing(null)}
                footer={
                    <>
                        <Btn onClick={() => setEditing(null)}>取消</Btn>
                        <Btn variant="primary" onClick={() => editing && commitRule(editing.rule)}>确定</Btn>
                    </>
                }
            >
                {editing && (
                    <RuleEditor
                        rule={editing.rule}
                        onChange={(rule) => setEditing({ ...editing, rule })}
                        onDelete={editing.index >= 0 ? () => { const i = editing.index; setEditing(null); removeRule(i) } : undefined}
                    />
                )}
            </Drawer>
        </div>
    )
}

function RuleEditor({ rule, onChange, onDelete }: {
    rule: EditRule
    onChange: (rule: EditRule) => void
    onDelete?: () => void
}) {
    const patch = (p: Partial<EditRule>) => onChange({ ...rule, ...p })
    const repliesText = (rule.replies ?? []).join('\n')
    return (
        <>
            <Row label="匹配文本" desc="正则模式下支持 /abc/i 形式" stack>
                <input
                    className="input-field"
                    value={rule.match}
                    placeholder={rule.matchType === 'regex' ? '例如：^(多少钱|价格)' : '例如：多少钱'}
                    onChange={(e) => patch({ match: e.target.value })}
                />
            </Row>
            <Row label="匹配方式">
                <Segmented
                    value={rule.matchType ?? 'contains'}
                    options={MATCH_TYPES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
                    onChange={(v) => patch({ matchType: v })}
                />
            </Row>
            <Row label="命中动作">
                <Segmented
                    value={rule.action ?? 'reply'}
                    options={ACTIONS.map((a) => ({ value: a.value, label: a.label, hint: a.hint }))}
                    onChange={(v) => patch({ action: v })}
                />
            </Row>
            <Row label="回复内容" desc="回复池为空时发这条" stack>
                <textarea className="input-field min-h-[72px]" value={rule.reply ?? ''} onChange={(e) => patch({ reply: e.target.value })} />
            </Row>
            <Row label="回复池" desc="一行一条；非空时随机挑一条发送，回复内容仅在池空时兜底" stack>
                <textarea
                    className="input-field min-h-[72px]"
                    value={repliesText}
                    placeholder={'在的在的～\n稍等，我看下'}
                    onChange={(e) => patch({ replies: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
                />
            </Row>
            <Row label="附带图片" desc="http(s) 直链 / base64:// / 容器内绝对路径；留空不发" stack>
                <input className="input-field" value={rule.image ?? ''} placeholder="https://... 或 data:image/png;base64,..." onChange={(e) => patch({ image: e.target.value })} />
            </Row>
            <Row label="启用规则" desc="关闭后跳过匹配，配置仍保留">
                <Switch checked={rule.enabled !== false} onChange={(v) => patch({ enabled: v })} />
            </Row>
            <Row label="先问 AI" desc="命中本规则时先问知识库/AI，拿不到再发回复">
                <Switch checked={rule.aiFallback === true} onChange={(v) => patch({ aiFallback: v })} />
            </Row>
            {onDelete && (
                <div className="pt-2">
                    <Btn variant="danger" size="sm" onClick={onDelete}>删除这条规则</Btn>
                </div>
            )}
        </>
    )
}
