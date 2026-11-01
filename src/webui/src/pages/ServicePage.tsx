import { useCallback, useEffect, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import type { Observability } from '../types'

function formatTime(iso: string | null): string {
    if (!iso) return '尚未同步'
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

/** 服务与观测：服务地址/连通状态、同步时间、FAQ 命中计数 */
export default function ServicePage() {
    const [data, setData] = useState<Observability | null>(null)
    const [loading, setLoading] = useState(true)

    const fetchData = useCallback(async () => {
        setLoading(true)
        try {
            const res = await noAuthFetch<Observability>('/observability')
            if (res.code === 0 && res.data) setData(res.data)
        } catch {
            showToast('获取观测数据失败', 'error')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchData()
        const timer = setInterval(fetchData, 15000)
        return () => clearInterval(timer)
    }, [fetchData])

    if (loading && !data) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载观测数据...</div>
                </div>
            </div>
        )
    }

    if (!data) {
        return <div className="py-12 text-center text-gray-400 text-sm">暂无观测数据</div>
    }

    const totalFaq = data.faq.hit + data.faq.miss

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                <button className="btn btn-ghost text-xs" onClick={fetchData}>刷新</button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="card p-5 animate-fade-in-up">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">服务</h3>
                    <div className="space-y-3 text-sm">
                        <Row label="服务地址" value={data.service.baseUrl || '未配置'} mono />
                        <Row label="服务开关" value={data.service.enabled ? '已启用' : '未启用'} />
                        <Row label="访问令牌" value={data.service.tokenConfigured ? '已配置' : '未配置'} />
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-gray-500 dark:text-gray-400">连通状态</span>
                            <span className={`inline-flex items-center gap-2 text-xs font-medium ${data.service.reachable ? 'text-emerald-600' : 'text-red-500'}`}>
                                <span className={`w-2 h-2 rounded-full ${data.service.reachable ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                {data.service.reachable ? '正常' : '异常'}
                            </span>
                        </div>
                        {data.service.lastError && (
                            <div className="text-xs text-red-500 break-all">最近错误：{data.service.lastError}</div>
                        )}
                    </div>
                </div>

                <div className="card p-5 animate-fade-in-up">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">同步状态</h3>
                    <div className="space-y-3 text-sm">
                        <Row label="拉黑名单" value={formatTime(data.sync.blocklistAt)} />
                        <Row label="守卫词表" value={formatTime(data.sync.guardWordsAt)} />
                        <Row label="群配置" value={formatTime(data.sync.groupConfigAt)} />
                        <Row label="群配置版本" value={data.sync.groupConfigVersion || '-'} mono />
                        <Row label="服务端群条目" value={String(data.groups.managed)} />
                    </div>
                </div>

                <div className="card p-5 animate-fade-in-up lg:col-span-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">FAQ 命中</h3>
                    <div className="grid grid-cols-3 gap-4 text-center">
                        <Stat label="命中" value={data.faq.hit} tone="text-emerald-600" />
                        <Stat label="未命中" value={data.faq.miss} tone="text-amber-600" />
                        <Stat label="合计" value={totalFaq} tone="text-gray-700 dark:text-gray-200" />
                    </div>
                    <p className="text-xs text-gray-400 mt-4">统计为本次插件运行期间累计，重启后清零。</p>
                </div>
            </div>
        </div>
    )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="text-gray-500 dark:text-gray-400 flex-shrink-0">{label}</span>
            <span className={`text-gray-800 dark:text-gray-200 text-right break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
        </div>
    )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
    return (
        <div className="rounded-xl bg-gray-50 dark:bg-white/5 py-3">
            <div className={`text-2xl font-bold ${tone}`}>{value}</div>
            <div className="text-xs text-gray-400 mt-1">{label}</div>
        </div>
    )
}
