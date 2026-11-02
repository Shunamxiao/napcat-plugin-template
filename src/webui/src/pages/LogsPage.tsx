import { useCallback, useEffect, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { HitLogEntry } from '../types'

const RESULT_LABEL: Record<string, { text: string; className: string }> = {
    answered: { text: '已回复', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
    silent: { text: '未命中', className: 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400' },
    guard: { text: '守卫命中', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
    guard_mute: { text: '禁言', className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400' },
    guard_degraded: { text: '禁言失败', className: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400' },
    service_down: { text: '服务降级', className: 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400' }
}

function formatTime(iso: string): string {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

/** 命中日志：最近 50 条命中/未命中记录 */
export default function LogsPage() {
    const [entries, setEntries] = useState<HitLogEntry[]>([])
    const [loading, setLoading] = useState(true)

    const fetchLogs = useCallback(async () => {
        setLoading(true)
        try {
            const res = await noAuthFetch<{ entries: HitLogEntry[]; total: number }>('/logs?limit=50')
            if (res.code === 0 && res.data) setEntries(res.data.entries)
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

    return (
        <div className="space-y-4 mx-auto max-w-5xl">
            <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">最近 {entries.length} 条（内存环形缓冲，最多保留 200 条，重启清空）</p>
                <button className="btn btn-ghost text-xs" onClick={fetchLogs}>刷新</button>
            </div>

            <div className="card overflow-hidden animate-fade-in-up">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-white/[0.02]">
                            <th className="py-2.5 px-4 font-medium whitespace-nowrap">时间</th>
                            <th className="py-2.5 px-4 font-medium">渠道</th>
                            <th className="py-2.5 px-4 font-medium">群</th>
                            <th className="py-2.5 px-4 font-medium">用户</th>
                            <th className="py-2.5 px-4 font-medium">结果</th>
                            <th className="py-2.5 px-4 font-medium">详情</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800/50">
                        {entries.map((entry, index) => {
                            const label = RESULT_LABEL[entry.result] ?? {
                                text: entry.result,
                                className: 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400'
                            }
                            return (
                                <tr key={entry.ts + index} className="hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition-colors">
                                    <td className="py-2.5 px-4 text-xs text-gray-500 whitespace-nowrap">{formatTime(entry.ts)}</td>
                                    <td className="py-2.5 px-4 text-xs text-gray-500">{entry.channel === 'group' ? '群聊' : '私聊'}</td>
                                    <td className="py-2.5 px-4 font-mono text-xs text-gray-500">{entry.groupId || '-'}</td>
                                    <td className="py-2.5 px-4 font-mono text-xs text-gray-500">{entry.userId || '-'}</td>
                                    <td className="py-2.5 px-4">
                                        <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-medium ${label.className}`}>
                                            {label.text}
                                        </span>
                                    </td>
                                    <td className="py-2.5 px-4 text-xs text-gray-500 max-w-[24rem] truncate" title={entry.detail}>
                                        {entry.detail || '-'}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>

                {entries.length === 0 && (
                    <div className="py-12 text-center empty-state">
                        <p className="text-gray-400 text-sm">{loading ? '加载中...' : '暂无命中记录'}</p>
                    </div>
                )}
            </div>
        </div>
    )
}
