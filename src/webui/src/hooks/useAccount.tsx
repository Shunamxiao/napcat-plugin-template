import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { noAuthFetch } from '../utils/api'
import type { AccountEntry, PeerInfo, PluginStatus, ServerBotSummary } from '../types'
import { useStatus } from './useStatus'

interface AccountContextValue {
    status: PluginStatus | null
    /** 当前实例 QQ 号；未就绪为空串 */
    selfId: string
    /** 正在编辑的账号 uin；默认跟随当前实例 */
    selectedUin: string
    selectAccount: (uin: string) => void
    /** 正在编辑的是否是当前实例（selfId 未就绪时按当前实例处理，避免提示条闪烁） */
    isCurrent: boolean
    /** 服务端 bot 列表 ∪ 插件实例列表，账号下拉数据源 */
    accounts: AccountEntry[]
    /** 当前实例的服务端 revision；从未同步过为 null（保存时不带 expectedRevision） */
    configRevision: number | null
    refreshStatus: () => Promise<void>
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function AccountProvider({ children }: { children: ReactNode }) {
    const { status, fetchStatus } = useStatus()
    const [bots, setBots] = useState<ServerBotSummary[]>([])
    const [peers, setPeers] = useState<PeerInfo[]>([])
    const [selected, setSelected] = useState('')

    const selfId = status?.selfId ?? ''
    const selectAccount = useCallback((uin: string) => setSelected(uin), [])

    useEffect(() => {
        fetchStatus()
        const timer = setInterval(fetchStatus, 10000)
        return () => clearInterval(timer)
    }, [fetchStatus])

    const fetchAccounts = useCallback(async () => {
        try {
            const [botsRes, peersRes] = await Promise.all([
                noAuthFetch<{ bots: ServerBotSummary[] }>('/server-bots'),
                noAuthFetch<{ peers: PeerInfo[] }>('/peers')
            ])
            if (botsRes.code === 0 && botsRes.data) setBots(botsRes.data.bots ?? [])
            if (peersRes.code === 0 && peersRes.data) setPeers(peersRes.data.peers ?? [])
        } catch {
            // 服务端未配置/账号插件不在：下拉仍至少显示当前实例
        }
    }, [])

    useEffect(() => {
        fetchAccounts()
        const timer = setInterval(fetchAccounts, 15000)
        return () => clearInterval(timer)
    }, [fetchAccounts])

    const accounts = useMemo<AccountEntry[]>(() => {
        const map = new Map<string, AccountEntry>()
        for (const bot of bots) {
            map.set(bot.uin, { uin: bot.uin, name: bot.nickname || bot.uin, running: true, isLogin: true, revision: bot.revision || null })
        }
        for (const peer of peers) {
            const existing = map.get(peer.uin)
            if (existing) {
                existing.name = peer.name || existing.name
                existing.running = peer.running
                existing.isLogin = peer.isLogin
            } else {
                map.set(peer.uin, { uin: peer.uin, name: peer.name || peer.uin, running: peer.running, isLogin: peer.isLogin, revision: null })
            }
        }
        // 服务端/账号插件都不可用时，下拉仍至少有自己
        if (selfId && !map.has(selfId)) {
            map.set(selfId, {
                uin: selfId,
                name: status?.nickname || selfId,
                running: true,
                isLogin: true,
                revision: status?.configRevision || null
            })
        }
        return Array.from(map.values()).sort((a, b) => (a.uin === selfId ? -1 : b.uin === selfId ? 1 : a.uin.localeCompare(b.uin)))
    }, [bots, peers, selfId, status?.nickname, status?.configRevision])

    const selectedUin = selected || selfId
    const isCurrent = !selfId || selectedUin === selfId

    return (
        <AccountContext.Provider value={{
            status,
            selfId,
            selectedUin,
            selectAccount,
            isCurrent,
            accounts,
            configRevision: status?.configRevision ?? null,
            refreshStatus: fetchStatus
        }}>
            {children}
        </AccountContext.Provider>
    )
}

export function useAccount(): AccountContextValue {
    const ctx = useContext(AccountContext)
    if (!ctx) throw new Error('useAccount 必须在 AccountProvider 内使用')
    return ctx
}
