import { useConfigDraft } from '../hooks/useConfig'
import { showToast } from '../hooks/useToast'
import { Card, Empty, Loading, Row, SaveBar, Switch } from '../ui/kit'
import { parseIdLines } from '../utils/ids'

/** 安全：黑名单、忽略发送者、跨账号去重、好友申请、发送/对刷熔断、转人工追问 */
export default function SafetyPage() {
    const { draft, update, dirty, save, saving, loading, error } = useConfigDraft()

    if (loading) return <Loading />
    if (error) return <Card title="加载失败"><div className="text-sm text-red-500">{error}</div></Card>
    if (!draft) return <Empty title="没有可编辑的配置" />

    const blacklistText = draft.blacklistText ?? (draft.blacklist ?? []).map(String).join('\n')
    const ignoreText = draft.ignoreSendersText ?? (draft.ignoreSenders ?? []).join('\n')
    const friend = draft.friendRequest ?? { autoAccept: false }
    const sendGuard = draft.sendGuard ?? { failThreshold: 3, privateFailThreshold: 2, cooldownSeconds: 300 }
    const loopGuard = draft.loopGuard ?? { maxReplies: 5, windowSeconds: 60, pauseSeconds: 300 }
    const collect = draft.collect ?? { enabled: false, questions: [] }

    const setFriend = (v: boolean) => update((d) => ({ ...d, friendRequest: { autoAccept: v } }))
    const setSendGuard = (patch: Partial<typeof sendGuard>) => update((d) => ({ ...d, sendGuard: { ...sendGuard, ...patch } }))
    const setLoopGuard = (patch: Partial<typeof loopGuard>) => update((d) => ({ ...d, loopGuard: { ...loopGuard, ...patch } }))
    const setCollect = (patch: Partial<typeof collect>) => update((d) => ({ ...d, collect: { ...collect, ...patch } }))

    const persist = async () => {
        const lines = (text: string) => parseIdLines(text)
        const result = await save({
            blacklist: lines(blacklistText),
            blacklistText,
            ignoreSenders: lines(ignoreText),
            ignoreSendersText: ignoreText,
            crossAccountDedup: draft.crossAccountDedup !== false,
            friendRequest: friend,
            sendGuard,
            loopGuard,
            collect: { enabled: collect.enabled === true, questions: collect.questions ?? [] },
        })
        showToast(result.ok ? result.message : '保存失败：' + result.message, result.ok ? 'success' : 'error')
    }

    return (
        <div className="space-y-4">
            <Card title="黑名单" desc="命中即静默丢弃，不进关键词/AI，也不回任何消息">
                <Row label="拉黑 QQ" desc="一行一个；# 开头是注释" stack>
                    <textarea
                        className="input-field min-h-[96px] font-mono text-xs"
                        value={blacklistText}
                        placeholder={'123456789\n# 刷屏的营销号放这里'}
                        onChange={(e) => update((d) => ({ ...d, blacklistText: e.target.value }))}
                    />
                </Row>
            </Card>

            <Card title="防对刷" desc="两个机器人同群时互相唤醒是最高频事故">
                <Row label="忽略的发送者" desc="一行一个 QQ 号；通常填另一个机器人的号，它发的消息一律不处理" stack>
                    <textarea
                        className="input-field min-h-[72px] font-mono text-xs"
                        value={ignoreText}
                        placeholder={'另一台机器人的 QQ'}
                        onChange={(e) => update((d) => ({ ...d, ignoreSendersText: e.target.value }))}
                    />
                </Row>
                <Row label="多账号同群去重" desc="多个实例在同一个群时只让一个实例回复（同一条消息只回一次）">
                    <Switch checked={draft.crossAccountDedup !== false} onChange={(v) => update((d) => ({ ...d, crossAccountDedup: v }))} />
                </Row>
                <Row label="对刷熔断" desc="同一群在窗口内回太多条就暂停回复，防止两个机器人互相回" stack>
                    <div className="flex items-center gap-2 text-xs">
                        <input className="input-sm w-20 text-right" type="number" value={loopGuard.maxReplies} onChange={(e) => setLoopGuard({ maxReplies: Number(e.target.value) || 0 })} />
                        <span className="text-gray-400">条 /</span>
                        <input className="input-sm w-20 text-right" type="number" value={loopGuard.windowSeconds} onChange={(e) => setLoopGuard({ windowSeconds: Number(e.target.value) || 0 })} />
                        <span className="text-gray-400">秒，暂停</span>
                        <input className="input-sm w-20 text-right" type="number" value={loopGuard.pauseSeconds} onChange={(e) => setLoopGuard({ pauseSeconds: Number(e.target.value) || 0 })} />
                        <span className="text-gray-400">秒</span>
                    </div>
                </Row>
            </Card>

            <Card title="发送熔断" desc="连发失败时自动停手，避免被风控或封号">
                <Row label="群发失败阈值" desc="连续失败达到该次数即暂停">
                    <input className="input-sm w-24 text-right" type="number" value={sendGuard.failThreshold} onChange={(e) => setSendGuard({ failThreshold: Number(e.target.value) || 0 })} />
                </Row>
                <Row label="私聊失败阈值" desc="私聊更容易被限制，默认更低">
                    <input className="input-sm w-24 text-right" type="number" value={sendGuard.privateFailThreshold} onChange={(e) => setSendGuard({ privateFailThreshold: Number(e.target.value) || 0 })} />
                </Row>
                <Row label="暂停时长（秒）">
                    <input className="input-sm w-24 text-right" type="number" value={sendGuard.cooldownSeconds} onChange={(e) => setSendGuard({ cooldownSeconds: Number(e.target.value) || 0 })} />
                </Row>
            </Card>

            <Card title="好友申请" desc="开启后收到好友申请自动通过（有风控风险，账号不稳定时保持关闭）">
                <Row label="自动通过好友申请">
                    <Switch checked={friend.autoAccept === true} onChange={setFriend} />
                </Row>
            </Card>

            <Card title="转人工追问" desc="命中转人工动作时，按顺序追问一条；答案进「转人工待办」">
                <Row label="启用追问">
                    <Switch checked={collect.enabled === true} onChange={(v) => setCollect({ enabled: v })} />
                </Row>
                {collect.enabled && (
                    <Row label="追问内容" desc="一行一条，按顺序追问" stack>
                        <textarea
                            className="input-field min-h-[80px]"
                            value={(collect.questions ?? []).join('\n')}
                            placeholder={'怎么称呼你？\n具体是什么问题？'}
                            onChange={(e) => setCollect({ questions: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
                        />
                    </Row>
                )}
            </Card>

            <SaveBar dirty={dirty} saving={saving} onSave={persist} label="保存并生效" />
        </div>
    )
}
