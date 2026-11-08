import { useConfigDraft } from '../hooks/useConfig'
import { showToast } from '../hooks/useToast'
import { Card, Empty, Loading, Row, SaveBar, Switch } from '../ui/kit'
import { idListToText, parseIdLines } from '../utils/ids'

/** 私聊：开关、白名单、连发合并、首条引导、是否升级 AI */
export default function PrivatePage() {
    const { draft, update, dirty, save, saving, loading, error } = useConfigDraft()

    if (loading) return <Loading />
    if (error) return <Card title="加载失败"><div className="text-sm text-red-500">{error}</div></Card>
    if (!draft) return <Empty title="没有可编辑的配置" />

    const priv = draft.private ?? { enabled: false }
    const guide = priv.guide ?? { enabled: false, text: '', windowSeconds: 1800 }
    const setPrivate = (patch: Partial<typeof priv>) => update((d) => ({ ...d, private: { ...(d.private ?? { enabled: false }), ...patch } }))
    const setGuide = (patch: Partial<typeof guide>) => setPrivate({ guide: { ...guide, ...patch } })

    const persist = async () => {
        const result = await save({
            private: {
                ...priv,
                // 与后端 textToIdList 同规则解析（井号注释不进口名单），
                // 且配置里只有数组没有派生文本时以数组为准，别把白名单写空成「对所有人生效」
                whitelist: parseIdLines(priv.whitelistText ?? idListToText(priv.whitelist)),
            },
            aiTrigger: draft.aiTrigger,
        })
        showToast(result.ok ? result.message : '保存失败：' + result.message, result.ok ? 'success' : 'error')
    }

    return (
        <div className="space-y-4">
            <Card title="私聊" desc="默认关闭；白名单为空时对所有私聊生效">
                <Row label="启用私聊自动回复" desc="关闭后私聊一律不回，群聊不受影响">
                    <Switch checked={priv.enabled} onChange={(v) => setPrivate({ enabled: v })} />
                </Row>
                <Row label="连发合并（毫秒）" desc="同一用户在该窗口内的多条消息合并处理，0 = 关闭">
                    <input
                        className="input-sm w-28 text-right"
                        type="number"
                        value={priv.mergeWindowMs ?? 0}
                        onChange={(e) => setPrivate({ mergeWindowMs: Number(e.target.value) || 0 })}
                    />
                </Row>
                <Row label="允许升级 AI" desc="私聊未命中关键词时是否问知识库/AI（关闭则直接走兜底）">
                    <Switch
                        checked={draft.aiTrigger?.private !== false}
                        onChange={(v) => update((d) => ({ ...d, aiTrigger: { private: v, groupAtOnly: d.aiTrigger?.groupAtOnly ?? true } }))}
                    />
                </Row>
                <Row label="白名单 QQ" desc="一行一个；留空 = 所有私聊。命中黑名单的号始终不回" stack>
                    <textarea
                        className="input-field min-h-[96px] font-mono text-xs"
                        value={priv.whitelistText ?? (priv.whitelist ?? []).join('\n')}
                        placeholder={'123456789\n# 井号开头的行是注释'}
                        onChange={(e) => setPrivate({ whitelistText: e.target.value })}
                    />
                </Row>
            </Card>

            <Card title="首条引导" desc="用户第一次私聊时先发引导文案（比如让他看群公告），不进入关键词/AI">
                <Row label="启用引导">
                    <Switch checked={guide.enabled === true} onChange={(v) => setGuide({ enabled: v })} />
                </Row>
                {guide.enabled && (
                    <>
                        <Row label="引导文案" stack>
                            <textarea
                                className="input-field min-h-[64px]"
                                value={guide.text ?? ''}
                                placeholder="例如：先看下群公告里的安装说明，再来问会快很多～"
                                onChange={(e) => setGuide({ text: e.target.value })}
                            />
                        </Row>
                        <Row label="窗口（秒）" desc="同一用户在该窗口内只引导一次；≤0 = 每条消息都引导">
                            <input
                                className="input-sm w-28 text-right"
                                type="number"
                                value={guide.windowSeconds ?? 1800}
                                onChange={(e) => setGuide({ windowSeconds: Number(e.target.value) || 0 })}
                            />
                        </Row>
                    </>
                )}
            </Card>

            <SaveBar dirty={dirty} saving={saving} onSave={persist} label="保存并生效" />
        </div>
    )
}
