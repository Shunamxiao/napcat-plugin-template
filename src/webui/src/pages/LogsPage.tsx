import { useCallback, useEffect, useMemo, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import { Btn, Card, Empty, Loading, Tag } from '../ui/kit'
import type { HitLogEntry } from '../types'

const RESULT_META: Record<string, { text: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = {
    answered: { text: '已回复', tone: 'success' },
    silent: { text: '未回复', tone: 'muted' },
    guard_mute: { text: '禁言', tone: 'danger' },
    service_down: { text: '服务降级', tone: 'warning' },
}

function formatTime(iso: string): string {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function toCsv(rows: HitLogEntry[]): string {
    const head = ['时间', '渠道', '群号', '用户', '结果', '详情']
    const body = rows.map((e) => [
        e.ts,
        e.channel === 'group' ? '群聊' : '私聊',
        e.groupId ?? '',
        e.userId ?? '',
        RESULT_META[e.result]?.text ?? e.result,
        e.detail ?? '',
    ])
    const esc = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)
    return [head, ...body].map((r) => r.map((c) => esc(String(c))).join(',')).join('\n')
}

/** 命中日志：最近 200 条，支持搜索/筛选与 CSV 导出 */
export default function LogsPage() {
    const [entries, setEntries] = useState<HitLogEntry[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(true)
    const [query, setQuery] = useState('')
    const [channel, setChannel] = useState<'all' | 'group' | 'private'>('all')
    const [result, setResult] = useState('all')

    const fetchLogs = useCallback(async () => {
        try {
            const res = await noAuthFetch<{ entries: HitLogEntry[]; total: number }>('/logs?limit=200')
            if (res.code === 0 && res.data) {
                setEntries(res.data.entries ?? [])
                setTotal(res.data.total ?? 0)
            }
        } catch {
            showToast('获取命中日志失败', 'error')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchLogs()
        const timer = setInterval(fetchLogs, 10000)
        return () => clearInterval(timer)
    }, [fetchLogs])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        return entries.filter((e) => {
            if (channel !== 'all' && e.channel !== channel) return false
            if (result !== 'all' && e.result !== result) return false
            if (!q) return true
            return [e.detail, e.userId, e.groupId].some((v) => (v ?? '').toLowerCase().includes(q))
        })
    }, [entries, query, channel, result])

    const exportCsv = () => {
        if (filtered.length === 0) { showToast('当前筛选没有记录', 'error'); return }
        const blob = new Blob(['\ufeff' + toCsv(filtered)], { type: 'text/csv;charset=utf-8' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `hit-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`
        a.click()
        URL.revokeObjectURL(a.href)
    }

    if (loading && entries.length === 0) return <Loading />

    return (
        <div className="space-y-4">
            <Card
                title="命中日志"
                desc={`内存环形缓冲，最多 200 条（当前共 ${total} 条），重启清空`}
                actions={<><Btn size="sm" onClick={fetchLogs}>刷新</Btn><Btn size="sm" onClick={exportCsv}>导出 CSV</Btn></>}
            >
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    <input
                        className="input-sm flex-1 min-w-[180px]"
                        placeholder="搜索详情/QQ/群号..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    <select className="input-sm w-28" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                        <option value="all">全部渠道</option>
                        <option value="group">群聊</option>
                        <option value="private">私聊</option>
                    </select>
                    <select className="input-sm w-28" value={result} onChange={(e) => setResult(e.target.value)}>
                        <option value="all">全部结果</option>
                        {Object.entries(RESULT_META).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}
                    </select>
                    <span className="text-xs text-gray-400">{filtered.length} / {entries.length}</span>
                </div>

                {filtered.length === 0 ? (
                    <Empty title={entries.length === 0 ? '暂无命中记录' : '没有匹配的记录'} />
                ) : (
                    <div className="overflow-x-auto -mx-1">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                                    <th className="py-2 px-1 font-medium whitespace-nowrap">时间</th>
                                    <th className="py-2 px-1 font-medium">渠道</th>
                                    <th className="py-2 px-1 font-medium hidden sm:table-cell">群 / 用户</th>
                                    <th className="py-2 px-1 font-medium">结果</th>
                                    <th className="py-2 px-1 font-medium">详情</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((e, i) => {
                                    const meta = RESULT_META[e.result] ?? { text: e.result, tone: 'muted' as const }
                                    return (
                                        <tr key={e.ts + i} className="row-hover border-b border-gray-50 dark:border-gray-800/50">
                                            <td className="py-2 px-1 text-xs text-gray-500 tabular-nums whitespace-nowrap">{formatTime(e.ts)}</td>
                                            <td className="py-2 px-1 text-xs text-gray-500">{e.channel === 'group' ? '群聊' : '私聊'}</td>
                                            <td className="py-2 px-1 font-mono text-[11px] text-gray-400 hidden sm:table-cell">
                                                {e.groupId ? `群 ${e.groupId}` : '—'} · {e.userId || '-'}
                                            </td>
                                            <td className="py-2 px-1"><Tag tone={meta.tone}>{meta.text}</Tag></td>
                                            <td className="py-2 px-1 text-xs text-gray-500 max-w-[26rem] truncate" title={e.detail}>{e.detail || '-'}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
        </div>
    )
}
