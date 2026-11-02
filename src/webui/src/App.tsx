import { useEffect, useState } from 'react'
import Header from './components/Header'
import ToastContainer from './components/ToastContainer'
import BasicPage from './pages/BasicPage'
import GroupRulesPage from './pages/GroupRulesPage'
import GuardPage from './pages/GuardPage'
import ServicePage from './pages/ServicePage'
import LogsPage from './pages/LogsPage'
import PrivateKeywordsPage from './pages/PrivateKeywordsPage'
import { AccountProvider, useAccount } from './hooks/useAccount'
import { useTheme } from './hooks/useTheme'
import { IconActivity, IconAlert, IconDashboard, IconGroup, IconSettings, IconTerminal } from './components/icons'

export type PageId = 'basic' | 'private' | 'groups' | 'guard' | 'service' | 'logs'

const pageConfig: Record<PageId, { title: string; desc: string }> = {
    basic: { title: '基础回复', desc: '总开关、冷却与回复延迟' },
    private: { title: '私聊与关键词', desc: '私聊开关、白名单、AI 兜底、关键词规则与黑名单' },
    groups: { title: '群规则', desc: '每群回复模式 / 未命中策略 / 兜底与欢迎，服务端为准' },
    guard: { title: '守卫与处罚', desc: '屏蔽词、命中动作与禁言策略' },
    service: { title: '服务与观测', desc: '服务连通、同步时间与 FAQ 命中计数' },
    logs: { title: '命中日志', desc: '最近 50 条命中与未命中记录' }
}

const tabs: { id: PageId; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
    { id: 'basic', label: '基础回复', icon: (p) => <IconDashboard {...p} /> },
    { id: 'private', label: '私聊与关键词', icon: (p) => <IconSettings {...p} /> },
    { id: 'groups', label: '群规则', icon: (p) => <IconGroup {...p} /> },
    { id: 'guard', label: '守卫与处罚', icon: (p) => <IconAlert {...p} /> },
    { id: 'service', label: '服务与观测', icon: (p) => <IconActivity {...p} /> },
    { id: 'logs', label: '命中日志', icon: (p) => <IconTerminal {...p} /> }
]

const NAV_COLLAPSED_KEY = 'autoreply-nav-collapsed'

function Shell() {
    const [currentPage, setCurrentPage] = useState<PageId>('basic')
    const [isScrolled, setIsScrolled] = useState(false)
    const [navCollapsed, setNavCollapsed] = useState(() => {
        try { return localStorage.getItem(NAV_COLLAPSED_KEY) === '1' } catch { return false }
    })
    const { selectedUin, isCurrent, accounts, status } = useAccount()

    useTheme()

    useEffect(() => {
        try { localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? '1' : '0') } catch { /* 忽略 */ }
    }, [navCollapsed])

    const handleScroll = (e: React.UIEvent<HTMLElement>) => {
        setIsScrolled(e.currentTarget.scrollTop > 10)
    }

    const renderPage = () => {
        switch (currentPage) {
            case 'basic': return <BasicPage />
            case 'groups': return <GroupRulesPage />
            case 'guard': return <GuardPage />
            case 'service': return <ServicePage />
            case 'logs': return <LogsPage />
            default: return <BasicPage />
        }
    }

    // 非当前实例编辑态：顶部提示条（契约 §3.3）
    const editingName = accounts.find((a) => a.uin === selectedUin)?.name || selectedUin
    const configSource = status?.configSource === 'server' ? 'server' : 'local'

    return (
        <div className="flex h-screen overflow-hidden bg-[#f8f9fa] dark:bg-[#18191C] text-gray-800 dark:text-gray-200 transition-colors duration-300">
            <ToastContainer />

            {/* 左侧固定导航：≥1024px；可折叠到图标 */}
            <aside
                className={`hidden lg:flex flex-col shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e1e20] transition-[width] duration-200 ${
                    navCollapsed ? 'w-14' : 'w-52'
                }`}
            >
                <div className={`flex items-center gap-2 px-3 py-4 ${navCollapsed ? 'justify-center' : ''}`}>
                    <div className="w-7 h-7 rounded-lg bg-brand-500 text-white flex items-center justify-center text-xs font-bold shrink-0">回</div>
                    {!navCollapsed && <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">QQ 自动回复</span>}
                </div>
                <nav className="flex-1 flex flex-col gap-1 px-2 py-2">
                    {tabs.map((tab) => {
                        const active = currentPage === tab.id
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setCurrentPage(tab.id)}
                                title={tab.label}
                                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                                    active
                                        ? 'bg-brand-500 text-white'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
                                } ${navCollapsed ? 'justify-center' : ''}`}
                            >
                                {tab.icon({ size: 18 })}
                                {!navCollapsed && <span className="truncate">{tab.label}</span>}
                            </button>
                        )
                    })}
                </nav>
                <div className="px-2 pb-3">
                    <button
                        onClick={() => setNavCollapsed((v) => !v)}
                        title={navCollapsed ? '展开导航' : '折叠导航'}
                        className="w-full flex items-center justify-center rounded-lg px-2 py-2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            className={`transition-transform ${navCollapsed ? 'rotate-180' : ''}`}>
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                </div>
            </aside>

            <main className="flex-1 overflow-y-auto min-w-0" onScroll={handleScroll}>
                <Header
                    title={pageConfig[currentPage].title}
                    description={pageConfig[currentPage].desc}
                    isScrolled={isScrolled}
                />

                {/* 窄屏（<1024px）顶部标签栏，不许横向滚动 */}
                <div className="lg:hidden px-4">
                    <nav className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-800 pb-0">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setCurrentPage(tab.id)}
                                className={`whitespace-nowrap px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
                                    currentPage === tab.id
                                        ? 'text-white bg-brand-500'
                                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </nav>
                </div>

                <div className="mx-auto max-w-[1280px] w-full px-4 md:px-10 pt-5 pb-8">
                    {!isCurrent && selectedUin && (
                        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                            <IconAlert size={16} />
                            <span>
                                正在编辑 {selectedUin}（{editingName}）的配置，该号下次同步后生效
                                {configSource === 'local' && '（注意：本实例配置尚未与服务端同步）'}
                            </span>
                        </div>
                    )}
                    {currentPage !== 'private' && (
                        <div key={currentPage} className="page-enter">
                            {renderPage()}
                        </div>
                    )}
                    {/* 常驻挂载：切到其它页签再切回来，未保存的输入不丢 */}
                    <div className={currentPage === 'private' ? 'page-enter' : 'hidden'}>
                        <PrivateKeywordsPage />
                    </div>
                </div>
            </main>
        </div>
    )
}

function App() {
    return (
        <AccountProvider>
            <Shell />
        </AccountProvider>
    )
}

export default App
