import { useCallback, useEffect, useMemo, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { useAccount } from '../hooks/useAccount'
import { Bars, Card, Empty, Loading, Row, Stat, Tag } from '../ui/kit'
import type { HitLogEntry, KeywordStatsMap, Observability, TrafficResponse } from '../types'
import { resultMeta } from '../utils/results'

/** 概览：实例状态、今日计数、近七天流量、Top 关键词与最近命中 */
export default function OverviewPage() {
    const { status, selfId, accounts } = useAccount()
    const [traffic, setTraffic] = useState<TrafficResponse | null>(null)
    const [keywordStats, setKeywordStats] = useState<KeywordStatsMap>({})
    const [logs, setLogs] = useState<HitLogEntry[]>([])
    const [obs, setObs] = useState<Observability | null>(null)
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        const [t, k, l, o] = await Promise.allSettled([
            noAuthFetch<TrafficResponse>('/traffic?days=7'),
            noAuthFetch<KeywordStatsMap>('/keyword-stats'),
            noAuthFetch<{ entries: HitLogEntry[] }>('/logs?limit=50'),
            noAuthFetch<Observability>('/observability'),
        ])
        if (t.status === 'fulfilled' && t.value.data) setTraffic(t.value.data)
        if (k.status === 'fulfilled' && k.value.data) setKeywordStats(k.value.data)
        if (l.status === 'fulfilled' && l.value.data) setLogs(l.value.data.entries ?? [])
        if (o.status === 'fulfilled' && o.value.data) setObs(o.value.data)
        setLoading(false)
    }, [])

    useEffect(() => {
        load()
        const timer = setInterval(load, 30000)
        return () => clearInterval(timer)
    }, [load])

    const days = traffic?.items ?? []
    const inSeries = days.map((d) => ({ label: d.day.slice(5), value: d.row?.throughput?.in ?? 0 }))
    const replySeries = days.map((d) => ({ label: d.day.slice(5), value: d.row?.throughput?.replies ?? 0 }))
    const weekTotals = days.reduce(
        (acc, d) => {
            const t = d.row?.throughput
            acc.in += t?.in ?? 0
            acc.replies += t?.replies ?? 0
            acc.ai += t?.aiReplies ?? 0
            acc.rules += t?.ruleHits ?? 0
            acc.fallback += t?.fallbackReplies ?? 0
            return acc
        },
        { in: 0, replies: 0, ai: 0, rules: 0, fallback: 0 },
    )

    const topKeywords = useMemo(() => {
        const fromServer = days[days.length - 1]?.row?.rules?.top ?? []
        if (fromServer.length > 0) return fromServer.slice(0, 5).map((r) => ({ match: r.match, count: r.count }))
        return Object.entries(keywordStats)
            .map(([key, v]) => ({ match: key.split('|')[0], count: v.count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
    }, [days, keywordStats])

    const recent = logs.slice(0, 6)
    const instanceName = status?.instanceName || ''
    const account = accounts.find((a) => a.uin === selfId)

    if (loading) return <Loading />

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="今日处理" value={status?.stats?.todayProcessed ?? 0} hint={`累计 ${status?.stats?.processed ?? 0}`} tone="primary" />
                <Stat label="近 7 天接收" value={weekTotals.in} hint={`回复 ${weekTotals.replies} 条`} />
                <Stat label="命中方式" value={`${weekTotals.rules} / ${weekTotals.ai}`} hint="关键词 / AI" />
                <Stat label="兜底回复" value={weekTotals.fallback} hint="未命中走兜底" />
            </div>

            <Card title="实例" desc="当前正在编辑的账号；数据每 10 秒刷新">
                <Row label="账号" desc={instanceName ? `实例名 ${instanceName}` : '实例名未配置'}>
                    <span className="text-sm text-gray-700 dark:text-gray-200">
                        {status?.nickname || account?.name || '未就绪'} · {selfId || '…'}
                    </span>
                </Row>
                <Row label="自动回复" desc="总开关状态">
                    <Tag tone={status?.config?.enabled ? 'success' : 'danger'}>{status?.config?.enabled ? '已启用' : '已停用'}</Tag>
                </Row>
                <Row label="知识库 / AI 服务" desc={obs?.service?.baseUrl || '未配置'}>
                    <Tag tone={obs?.service?.reachable ? 'success' : obs?.service?.enabled ? 'warning' : 'muted'}>
                        {obs?.service?.reachable ? '连通' : obs?.service?.enabled ? '不可达' : '未启用'}
                    </Tag>
                </Row>
                <Row label="运行时长" desc="插件进程本次启动以来">
                    <span className="text-sm text-gray-600 dark:text-gray-300 tabular-nums">{status?.uptimeFormatted ?? '-'}</span>
                </Row>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card title="近 7 天接收" desc={traffic?.configured ? '数据来自服务端按天聚合（UTC）' : '服务端未配置，暂无聚合数据'}>
                    {traffic?.configured ? <Bars data={inSeries} unit="条" /> : <Empty title="服务端未配置" desc="在「服务与运维」里填好服务地址与令牌后即可看到流量" />}
                </Card>
                <Card title="近 7 天回复" desc="含关键词命中、AI 与兜底">
                    {traffic?.configured ? <Bars data={replySeries} height={120} tone="success" unit="条" /> : <Empty title="暂无数据" />}
                </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Top 关键词" desc={traffic?.configured ? '服务端累计命中次数' : '本实例内存计数'}>
                    {topKeywords.length === 0 ? (
                        <Empty title="还没有命中记录" desc="加几条关键词规则，命中后这里会按次数排序" />
                    ) : (
                        <div className="space-y-2">
                            {topKeywords.map((k, i) => (
                                <div key={k.match + i} className="flex items-center gap-3">
                                    <span className="text-xs text-gray-400 w-4 tabular-nums">{i + 1}</span>
                                    <span className="text-sm text-gray-700 dark:text-gray-200 truncate flex-1">{k.match || '（空）'}</span>
                                    <span className="text-xs font-medium text-primary tabular-nums">{k.count}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>

                <Card title="最近命中" desc="最多 6 条；完整记录在「命中日志」">
                    {recent.length === 0 ? (
                        <Empty title="暂无记录" />
                    ) : (
                        <div className="space-y-2">
                            {recent.map((e, i) => (
                                <div key={(e.ts ?? '') + i} className="text-xs">
                                    <div className="flex items-center gap-2">
                                        <Tag tone={resultMeta(e.result).tone}>{resultMeta(e.result).text}</Tag>
                                        <span className="text-gray-400 tabular-nums">{(e.ts || '').slice(11, 19)}</span>
                                        <span className="text-gray-500 dark:text-gray-400 truncate">
                                            {e.channel === 'group' ? `群 ${e.groupId ?? ''}` : '私聊'} · {e.userId}
                                        </span>
                                    </div>
                                    <div className="text-gray-600 dark:text-gray-300 mt-0.5 truncate">{e.detail || '-'}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>
        </div>
    )
}


