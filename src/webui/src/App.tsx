import { useState, useEffect } from 'react'
import Header from './components/Header'
import ToastContainer from './components/ToastContainer'
import BasicPage from './pages/BasicPage'
import GroupRulesPage from './pages/GroupRulesPage'
import GuardPage from './pages/GuardPage'
import ServicePage from './pages/ServicePage'
import LogsPage from './pages/LogsPage'
import PrivateKeywordsPage from './pages/PrivateKeywordsPage'
import { useStatus } from './hooks/useStatus'
import { useTheme } from './hooks/useTheme'

export type PageId = 'basic' | 'private' | 'groups' | 'guard' | 'service' | 'logs'

const pageConfig: Record<PageId, { title: string; desc: string }> = {
    basic: { title: '基础回复', desc: '总开关、冷却与回复延迟' },
    private: { title: '私聊与关键词', desc: '私聊开关、白名单、AI 兜底、关键词规则与黑名单' },
    groups: { title: '群规则', desc: '每群回复模式 / 未命中策略 / 兜底与欢迎，服务端为准' },
    guard: { title: '守卫与处罚', desc: '屏蔽词、命中动作与禁言策略' },
    service: { title: '服务与观测', desc: '服务连通、同步时间与 FAQ 命中计数' },
    logs: { title: '命中日志', desc: '最近 50 条命中与未命中记录' }
}

const tabs: { id: PageId; label: string }[] = [
    { id: 'basic', label: '基础回复' },
    { id: 'private', label: '私聊与关键词' },
    { id: 'groups', label: '群规则' },
    { id: 'guard', label: '守卫与处罚' },
    { id: 'service', label: '服务与观测' },
    { id: 'logs', label: '命中日志' }
]

function App() {
    const [currentPage, setCurrentPage] = useState<PageId>('basic')
    const [isScrolled, setIsScrolled] = useState(false)
    const { status, fetchStatus } = useStatus()

    useTheme()

    useEffect(() => {
        fetchStatus()
        const interval = setInterval(fetchStatus, 10000)
        return () => clearInterval(interval)
    }, [fetchStatus])

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

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-[#f8f9fa] dark:bg-[#18191C] text-gray-800 dark:text-gray-200 transition-colors duration-300">
            <ToastContainer />
            <main className="flex-1 overflow-y-auto" onScroll={handleScroll}>
                <Header
                    title={pageConfig[currentPage].title}
                    description={pageConfig[currentPage].desc}
                    isScrolled={isScrolled}
                    status={status}
                />

                {/* tab 导航 */}
                <div className="px-4 md:px-8">
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

                <div className="px-4 md:px-8 pt-5 pb-8">
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

export default App
