import { useCallback, useEffect, useState } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import { useConfigDraft } from '../hooks/useConfig'
import { Btn, Card, Empty, Loading, Row, SaveBar, Switch, Tag } from '../ui/kit'
import type { Observability, SnapshotMeta } from '../types'

function formatTime(iso: string | null): string {
    if (!iso) return '尚未同步'
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

/** 服务端字段缺失时补默认，避免 undefined.baseUrl 把整页渲染炸成白屏 */
function normalize(obs: Partial<Observability>): Observability {
    return {
        service: { baseUrl: '', enabled: false, tokenConfigured: false, reachable: false, lastAttemptAt: null, lastSyncAt: null, lastError: null, ...(obs.service ?? {}) },
        sync: { blocklistAt: null, guardWordsAt: null, groupConfigAt: null, groupConfigVersion: '', ...(obs.sync ?? {}) },
        faq: { hit: 0, miss: 0, ...(obs.faq ?? {}) },
        groups: { managed: 0, ...(obs.groups ?? {}) },
    }
}

/** 服务与运维：KB/AI 服务配置、连通性与同步、回流令牌、配置快照 */
export default function ServicePage() {
    const { draft, update, dirty, save, saving, loading, reload } = useConfigDraft()
    const [obs, setObs] = useState<Observability | null>(null)
    const [snaps, setSnaps] = useState<SnapshotMeta[]>([])
    const [busyId, setBusyId] = useState('')

    const fetchObs = useCallback(async () => {
        try {
            const res = await noAuthFetch<Observability>('/observability')
            if (res.code === 0 && res.data) setObs(normalize(res.data))
        } catch {
            showToast('获取观测数据失败', 'error')
        }
    }, [])

    const fetchSnaps = useCallback(async () => {
        try {
            const res = await noAuthFetch<{ items: SnapshotMeta[]; max: number }>('/snapshots')
            if (res.code === 0 && res.data) setSnaps(res.data.items ?? [])
        } catch {
            showToast('获取快照列表失败', 'error')
        }
    }, [])

    useEffect(() => {
        fetchObs()
        fetchSnaps()
        const timer = setInterval(fetchObs, 15000)
        return () => clearInterval(timer)
    }, [fetchObs, fetchSnaps])

    const snapshotAction = async (action: 'create' | 'restore' | 'delete', id = '') => {
        setBusyId(action + id)
        try {
            const res = await noAuthFetch<{ id?: string }>('/snapshots', {
                method: 'POST',
                body: JSON.stringify({ action, id, note: action === 'create' ? '手动快照' : '' }),
            })
            if (res.code !== 0) throw new Error(res.message || '操作失败')
            showToast({ create: '已创建快照', restore: '已回滚到该快照', delete: '已删除快照' }[action], 'success')
            if (action === 'restore') await reload()   // 回滚后重新拉配置
            await fetchSnaps()
            await fetchObs()
        } catch (e) {
            showToast('操作失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        } finally {
            setBusyId('')
        }
    }

    if (loading) return <Loading text="加载配置..." />
    if (!draft) return <Empty title="没有可编辑的配置" desc="账号未就绪或配置读取失败" />

    const kb = draft.kbService ?? { enabled: false, baseUrl: '', token: '', timeoutMs: 8000 }
    const relay = draft.relay ?? { token: '' }
    const setKb = (patch: Partial<typeof kb>) => update((d) => ({ ...d, kbService: { ...kb, ...patch } }))
    const setRelay = (patch: Partial<typeof relay>) => update((d) => ({ ...d, relay: { ...relay, ...patch } }))

    const persist = async () => {
        const result = await save({
            kbService: { ...kb, baseUrl: kb.baseUrl.trim(), timeoutMs: Number(kb.timeoutMs) || 8000 },
            relay: { token: relay.token ?? '' },
            accountAccessKey: (draft.accountAccessKey ?? '').trim(),
            groupConfigRefreshMs: Number(draft.groupConfigRefreshMs) || 60000,
        })
        showToast(result.ok ? result.message : '保存失败：' + result.message, result.ok ? 'success' : 'error')
        if (result.ok) await fetchObs()
    }

    return (
        <div className="space-y-4">
            <Card
                title="知识库 / AI 服务"
                desc="关键词未命中时向应答服务要答案；不配则只跑本地关键词与兜底"
                actions={<Tag tone={obs?.service.reachable ? 'success' : obs?.service.enabled ? 'warning' : 'muted'}>{obs?.service.reachable ? '连通' : obs?.service.enabled ? '不可达' : '未启用'}</Tag>}
            >
                <Row label="启用服务">
                    <Switch checked={kb.enabled === true} onChange={(v) => setKb({ enabled: v })} />
                </Row>
                <Row label="服务地址" desc="应答服务根地址，例如 http://127.0.0.1:8787">
                    <input
                        className="input-sm w-72 text-left font-mono"
                        value={kb.baseUrl}
                        placeholder="http://127.0.0.1:8787"
                        onChange={(e) => setKb({ baseUrl: e.target.value })}
                    />
                </Row>
                <Row label="访问令牌" desc="已配置则显示为掩码；留空或不改即保留原值。改地址必须同时填新令牌">
                    <input
                        className="input-sm w-72 text-left font-mono"
                        type="password"
                        value={kb.token ?? ''}
                        placeholder="****"
                        onChange={(e) => setKb({ token: e.target.value })}
                    />
                </Row>
                <Row label="超时（毫秒）">
                    <input
                        className="input-sm w-24 text-right"
                        type="number"
                        value={kb.timeoutMs ?? 8000}
                        onChange={(e) => setKb({ timeoutMs: Number(e.target.value) || 8000 })}
                    />
                </Row>
                {obs?.service.lastError && <div className="text-xs text-red-500 break-all pt-1">最近错误：{obs.service.lastError}</div>}
            </Card>

            <Card title="Telegram 回流" desc="服务侧通过 POST /relay 反向下发消息；令牌为空 = 关闭">
                <Row label="回流令牌" desc="显示掩码表示已配置；清空并保存即关闭回流">
                    <input
                        className="input-sm w-72 text-left font-mono"
                        type="password"
                        value={relay.token ?? ''}
                        placeholder="****"
                        onChange={(e) => setRelay({ token: e.target.value })}
                    />
                </Row>
            </Card>

            <Card title="同步与连接" desc="服务端下发的词表/群配置/黑名单">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
                    <Row label="拉黑名单"><span className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">{formatTime(obs?.sync.blocklistAt ?? null)}</span></Row>
                    <Row label="守卫词表"><span className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">{formatTime(obs?.sync.guardWordsAt ?? null)}</span></Row>
                    <Row label="群配置"><span className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">{formatTime(obs?.sync.groupConfigAt ?? null)}</span></Row>
                    <Row label="群配置版本"><span className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">{obs?.sync.groupConfigVersion || '-'}</span></Row>
                    <Row label="服务端群条目"><span className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">{String(obs?.groups.managed ?? 0)}</span></Row>
                    <Row label="FAQ 命中 / 未命中"><span className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">{`${obs?.faq.hit ?? 0} / ${obs?.faq.miss ?? 0}`}</span></Row>
                    <Row label="群配置刷新间隔"><span className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">{`${Math.round((Number(draft.groupConfigRefreshMs) || 60000) / 1000)} 秒`}</span></Row>
                </div>
            </Card>

            <Card
                title="配置快照"
                desc="改坏了可以回滚；回滚只影响本实例本地配置文件"
                actions={<Btn size="sm" variant="primary" loading={busyId === 'create'} onClick={() => snapshotAction('create')}>创建快照</Btn>}
            >
                {snaps.length === 0 ? (
                    <Empty title="还没有快照" desc="改动前点一次「创建快照」，出问题能一键回来" />
                ) : (
                    <div className="divide-y divide-gray-50 dark:divide-gray-800/50">
                        {snaps.map((s) => (
                            <div key={s.id} className="flex items-center justify-between gap-3 py-2">
                                <div className="min-w-0">
                                    <div className="text-xs text-gray-700 dark:text-gray-300 truncate">{s.note || '（无备注）'}</div>
                                    <div className="text-[11px] text-gray-400 tabular-nums">{formatTime(s.ts)} · {(s.size / 1024).toFixed(1)} KB</div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Btn size="sm" loading={busyId === 'restore' + s.id} onClick={() => snapshotAction('restore', s.id)}>回滚</Btn>
                                    <Btn
                                        size="sm"
                                        variant="danger"
                                        loading={busyId === 'delete' + s.id}
                                        onClick={() => {
                                            if (window.confirm('删除这个快照？删除后无法找回。')) snapshotAction('delete', s.id)
                                        }}
                                    >删除</Btn>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Card>

            <SaveBar dirty={dirty} saving={saving} onSave={persist} label="保存并生效" hint="服务地址/令牌 / 回流令牌 / 刷新间隔" />
        </div>
    )
}
