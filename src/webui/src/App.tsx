import { useEffect, useState } from 'react'
import Header from './components/Header'
import ToastContainer from './components/ToastContainer'
import OverviewPage from './pages/OverviewPage'
import ReplyPage from './pages/ReplyPage'
import PrivatePage from './pages/PrivatePage'
import GroupsPage from './pages/GroupsPage'
import GuardPage from './pages/GuardPage'
import SafetyPage from './pages/SafetyPage'
import ServicePage from './pages/ServicePage'
import LogsPage from './pages/LogsPage'
import { AccountProvider, useAccount } from './hooks/useAccount'
import { useTheme } from './hooks/useTheme'
import { useHashRoute, type PageId } from './router'
import {
    IconActivity, IconAlert, IconDashboard, IconGroup, IconLock, IconSettings, IconShield, IconTerminal,
} from './components/icons'

const META: Record<PageId, { title: string; desc: string }> = {
    overview: { title: '概览', desc: '实例状态、今日处理量与近七天流量' },
    reply: { title: '回复规则', desc: '总开关、关键词、兜底话术与转人工追问' },
    private: { title: '私聊', desc: '私聊开关、白名单、首条引导与连发合并' },
    groups: { title: '群规则', desc: '按群覆盖模式、策略与欢迎语，可批量改和导入导出' },
    guard: { title: '内容守卫', desc: '屏蔽词、命中动作与违规处罚' },
    safety: { title: '安全与风控', desc: '黑名单、发送熔断、对刷熔断与去重' },
    service: { title: '服务与运维', desc: '知识库/AI 服务、同步状态、回流令牌与配置快照' },
    logs: { title: '命中日志', desc: '最近命中记录，可按来源/范围筛选与导出' },
}

const NAV: { group: string; items: { id: PageId; label: string; icon: (p: { size?: number }) => JSX.Element }[] }[] = [
    {
        group: '监控',
        items: [
            { id: 'overview', label: '概览', icon: IconDashboard },
            { id: 'logs', label: '命中日志', icon: IconTerminal },
        ],
    },
    {
        group: '回复',
        items: [
            { id: 'reply', label: '回复规则', icon: IconSettings },
            { id: 'private', label: '私聊', icon: IconLock },
            { id: 'groups', label: '群规则', icon: IconGroup },
        ],
    },
    {
        group: '管理',
        items: [
            { id: 'guard', label: '内容守卫', icon: IconShield },
            { id: 'safety', label: '安全与风控', icon: IconAlert },
        ],
    },
    {
        group: '系统',
        items: [{ id: 'service', label: '服务与运维', icon: IconActivity }],
    },
]

const NAV_COLLAPSED_KEY = 'autoreply-nav-collapsed'

function Shell() {
    const { page, go } = useHashRoute('overview')
    const [isScrolled, setIsScrolled] = useState(false)
    const [navCollapsed, setNavCollapsed] = useState(() => {
        try { return localStorage.getItem(NAV_COLLAPSED_KEY) === '1' } catch { return false }
    })
    const { status } = useAccount()

    useTheme()

    useEffect(() => {
        const onScroll = () => setIsScrolled(window.scrollY > 8)
        const scroller = document.getElementById('page-scroll')
        scroller?.addEventListener('scroll', onScroll, { passive: true })
        return () => scroller?.removeEventListener('scroll', onScroll)
    }, [])

    useEffect(() => {
        try { localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? '1' : '0') } catch { /* 忽略隐私模式 */ }
    }, [navCollapsed])

    const meta = META[page]
    const Body = {
        overview: OverviewPage,
        reply: ReplyPage,
        private: PrivatePage,
        groups: GroupsPage,
        guard: GuardPage,
        safety: SafetyPage,
        service: ServicePage,
        logs: LogsPage,
    }[page]

    return (
        <div className="flex h-screen overflow-hidden">
            {/* 桌面左栏 */}
            <aside
                className={`hidden md:flex flex-col shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1a1a1c] transition-[width] duration-300 ${navCollapsed ? 'w-[68px]' : 'w-56'}`}
            >
                <button
                    className="flex items-center gap-2 px-4 h-16 shrink-0 text-left"
                    onClick={() => setNavCollapsed((v) => !v)}
                    title={navCollapsed ? '展开导航' : '收起导航'}
                >
                    <div className="w-8 h-8 rounded-lg bg-primary text-white flex items-center justify-center font-bold text-sm shrink-0">Q</div>
                    {!navCollapsed && (
                        <div className="min-w-0">
                            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">QQ 自动回复</div>
                            <div className="text-[11px] text-gray-400 truncate">群管理 · 自动回复</div>
                        </div>
                    )}
                </button>

                <nav className="flex-1 overflow-y-auto px-2 pb-3">
                    {NAV.map((g) => (
                        <div key={g.group} className="mt-2">
                            {!navCollapsed && <div className="px-3 py-1 text-[11px] font-medium text-gray-400 tracking-wide">{g.group}</div>}
                            {g.items.map((it) => {
                                const active = page === it.id
                                return (
                                    <button
                                        key={it.id}
                                        onClick={() => go(it.id)}
                                        title={it.label}
                                        aria-current={active ? 'page' : undefined}
                                        className={`sidebar-item w-full ${active ? 'active' : ''} ${navCollapsed ? 'justify-center' : ''}`}
                                    >
                                        <span className="sidebar-icon shrink-0">{it.icon({ size: 18 })}</span>
                                        {!navCollapsed && <span className="truncate">{it.label}</span>}
                                    </button>
                                )
                            })}
                        </div>
                    ))}
                </nav>

                <div className={`px-3 py-2 text-[10px] text-gray-400 ${navCollapsed ? 'text-center' : ''}`} title="构建戳：与服务端 /api/status 的 build 一致">
                    {navCollapsed ? '·' : `构建 ${status?.build ?? '-'}`}
                </div>
            </aside>

            {/* 右栏 */}
            <div className="flex-1 flex flex-col min-w-0">
                <Header title={meta.title} description={meta.desc} isScrolled={isScrolled} />

                {/* 移动端顶部横排导航 */}
                <nav className="md:hidden flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-800 px-3 bg-white dark:bg-[#1a1a1c]">
                    {NAV.flatMap((g) => g.items).map((it) => (
                        <button
                            key={it.id}
                            onClick={() => go(it.id)}
                            className={`px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                                page === it.id
                                    ? 'border-primary text-primary'
                                    : 'border-transparent text-gray-500 dark:text-gray-400'
                            }`}
                        >
                            {it.label}
                        </button>
                    ))}
                </nav>

                <main id="page-scroll" className="flex-1 overflow-y-auto px-4 py-4 md:px-10 md:py-6">
                    <div className="max-w-5xl mx-auto">
                        <Body />
                    </div>
                </main>
            </div>
            <ToastContainer />
        </div>
    )
}

export default function App() {
    return (
        <AccountProvider>
            <Shell />
        </AccountProvider>
    )
}
