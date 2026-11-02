import { useEffect, useRef, useState } from 'react'
import { useAccount } from '../hooks/useAccount'

interface HeaderProps {
    title: string
    description: string
    isScrolled: boolean
}

export default function Header({ title, description, isScrolled }: HeaderProps) {
    const { status, selfId, selectedUin, selectAccount, isCurrent, accounts } = useAccount()
    const [open, setOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    const isEnabled = status?.config?.enabled ?? false
    const current = accounts.find((a) => a.uin === selfId)
    const displayName = status?.nickname || current?.name || selfId || '…'
    const instanceName = status?.instanceName || ''
    const selectedName = accounts.find((a) => a.uin === selectedUin)?.name || selectedUin

    useEffect(() => {
        if (!open) return
        const onClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', onClick)
        return () => document.removeEventListener('mousedown', onClick)
    }, [open])

    return (
        <header
            className={`
                sticky top-0 z-20 flex justify-between items-center px-4 py-4 md:px-10 md:py-5
                bg-[#f8f9fa] dark:bg-[#18191C]
                transition-[border-color,box-shadow,backdrop-filter] duration-300 ease-out
                ${isScrolled
                    ? 'border-b border-gray-200 dark:border-gray-800 shadow-sm backdrop-blur-sm bg-[#f8f9fa]/90 dark:bg-[#18191C]/90'
                    : 'border-b border-transparent'
                }
            `}
        >
            <div className="animate-fade-in-down min-w-0">
                <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">{title}</h2>
                <p className="text-gray-400 text-xs mt-0.5 truncate">{description}</p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
                {/* 身份徽标：常显 昵称 · QQ号 · 实例名，悬停显示 端口 / revision / 来源 */}
                <div
                    className="group relative hidden sm:flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-[#1e1e20] rounded-lg border border-gray-200 dark:border-gray-800"
                    data-testid="identity-badge"
                >
                    <div className={`status-dot ${status ? (isEnabled ? 'online' : 'offline') : ''}`} />
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300 max-w-[280px] truncate">
                        {status ? `${displayName} · ${selfId || '…'}${instanceName ? ' · ' + instanceName : ''}` : '连接中...'}
                    </span>
                    <div className="absolute right-0 top-full mt-1.5 hidden group-hover:block z-30 w-max max-w-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#26262a] shadow-lg px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                        <div>端口：{status?.webuiPort ?? '-'}</div>
                        <div>配置 revision：{status?.configRevision ?? 0}</div>
                        <div>配置来源：{status?.configSource === 'server' ? 'server' : 'local'}</div>
                    </div>
                </div>

                {/* 账号下拉：服务端 bot 列表 ∪ 插件实例；running=false 标灰 */}
                <div className="relative" ref={menuRef}>
                    <button
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                            isCurrent
                                ? 'border-brand-500/60 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400'
                                : 'border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e1e20] text-gray-600 dark:text-gray-300'
                        }`}
                        onClick={() => setOpen((v) => !v)}
                    >
                        <span className="max-w-[180px] truncate">{isCurrent ? displayName : selectedName}（{selectedUin || '…'}）</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>
                    {open && (
                        <div className="absolute right-0 top-full mt-1.5 z-30 min-w-[220px] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#26262a] shadow-lg py-1">
                            {accounts.length === 0 && (
                                <div className="px-3 py-2 text-xs text-gray-400">暂无账号</div>
                            )}
                            {accounts.map((account) => {
                                const active = account.uin === selectedUin
                                const mine = account.uin === selfId
                                return (
                                    <button
                                        key={account.uin}
                                        className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-3 transition-colors ${
                                            active
                                                ? 'bg-brand-500 text-white'
                                                : mine
                                                    ? 'text-brand-700 dark:text-brand-400 hover:bg-gray-100 dark:hover:bg-white/5'
                                                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
                                        } ${account.running ? '' : ' opacity-45'}`}
                                        onClick={() => { selectAccount(account.uin); setOpen(false) }}
                                    >
                                        <span className="truncate">
                                            {account.name}（{account.uin}）{mine ? ' · 本实例' : ''}
                                        </span>
                                        {!account.running && <span className="shrink-0">离线</span>}
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>
        </header>
    )
}
