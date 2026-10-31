/** WebUI 前端类型定义 */

export interface PluginStatus {
    pluginName: string
    uptime: number
    uptimeFormatted: string
    config: PluginConfig
    stats: {
        processed: number
        todayProcessed: number
        lastUpdateDay: string
    }
}

export interface KeywordRule {
    match: string
    matchType?: 'contains' | 'prefix'
    reply: string
}

export interface PrivateConfig {
    enabled: boolean
    defaultReply: string
    whitelist: (number | string)[]
    whitelistText?: string
}

export interface GroupConfig {
    enabled: boolean
    whitelist: (number | string)[]
    whitelistText?: string
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    keywords: KeywordRule[]
    private: PrivateConfig
    group: GroupConfig
    blacklist: (number | string)[]
    keywordsText?: string
    blacklistText?: string
    cooldownSeconds: number
    replyDelayMinMs: number
    replyDelayMaxMs: number
    atOnly: boolean
    groupConfigs?: Record<string, GroupConfig>
}

export interface GroupInfo {
    group_id: number
    group_name: string
    member_count: number
    max_member_count: number
    enabled: boolean
    /** 定时推送时间（如 '08:30'），null 表示未设置（模板默认不使用，按需扩展） */
    scheduleTime?: string | null
}

export interface ApiResponse<T = unknown> {
    code: number
    data?: T
    message?: string
}
