/** WebUI 前端类型定义 */

export interface PluginStatus {
    pluginName: string
    uptime: number
    uptimeFormatted: string
    config: PluginConfigView
    stats: {
        processed: number
        todayProcessed: number
        lastUpdateDay: string
        faqHit?: number
        faqMiss?: number
    }
}

export interface GuardConfigView {
    enabled: boolean
    words: string[]
    wordsText?: string
    action: 'recall' | 'warn' | 'both'
    warnText: string
    groupIds: (number | string)[]
    groupIdsText?: string
    wordsRefreshMs?: number
}

export interface KbServiceView {
    enabled: boolean
    baseUrl: string
    token?: string
    timeoutMs?: number
}

export type KeywordMatchType = 'prefix' | 'contains' | 'regex'

/** 一条本地关键词规则；图片/多回复池/动作由原生配置页维护，这里原样带回 */
export interface KeywordRuleView {
    match: string
    matchType?: KeywordMatchType
    reply: string
    replies?: string[]
    image?: string
    aiFallback?: boolean
    action?: 'reply' | 'ai' | 'human'
}

export interface PrivateConfigView {
    enabled: boolean
    /** 私聊兜底话术（历史字段；运行时兜底实际读 fallback.privateText） */
    defaultReply?: string
    whitelist?: (number | string)[]
    whitelistText?: string
    /** 同一私聊用户连发合并窗口（毫秒）；0 = 关闭 */
    mergeWindowMs?: number
}

export interface AiTriggerView {
    private: boolean
    groupAtOnly: boolean
}

/** 页面只读取这些字段；其它配置原样透传，保存时按块合并 */
export interface PluginConfigView {
    enabled: boolean
    debug?: boolean
    cooldownSeconds: number
    replyDelayMinMs: number
    replyDelayMaxMs: number
    atOnly: boolean
    atReply?: boolean
    guard: GuardConfigView
    kbService: KbServiceView
    groupWelcome?: { enabled: boolean; template: string }
    group?: { enabled: boolean }
    private?: PrivateConfigView
    aiTrigger?: AiTriggerView
    keywords?: KeywordRuleView[]
    keywordsText?: string
    blacklist?: (number | string)[]
    blacklistText?: string
    [key: string]: unknown
}

/** /api/groups 的一条 */
export interface GroupRuleEntry {
    groupId: string
    name: string
    enabled: boolean
    atOnly: boolean
    aiEnabled: boolean
    welcomeEnabled: boolean
    welcomeTemplate: string | null
    source: 'server' | 'local' | 'default'
}

export interface GuardPolicy {
    windowSeconds: number
    threshold: number
    muteSeconds: number
    warnText: string
    muteText: string
    source?: 'server' | 'default'
}

export interface Observability {
    service: {
        baseUrl: string
        enabled: boolean
        tokenConfigured: boolean
        reachable: boolean
        lastAttemptAt: string | null
        lastSyncAt: string | null
        lastError: string | null
    }
    sync: {
        blocklistAt: string | null
        guardWordsAt: string | null
        groupConfigAt: string | null
        groupConfigVersion: string
    }
    faq: { hit: number; miss: number }
    groups: { managed: number }
}

export interface HitLogEntry {
    ts: string
    channel: 'private' | 'group'
    groupId?: string
    userId: string
    result: string
    detail?: string
}

export interface ApiResponse<T = unknown> {
    code: number
    data?: T
    message?: string
}
