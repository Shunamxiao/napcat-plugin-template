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
    /** 当前实例 QQ 号；未取到为 null */
    selfId?: string | null
    /** 当前账号昵称（get_login_info → 服务端 nickname → ""） */
    nickname?: string
    /** 实例名（账号管理插件按 uin 匹配，匹配不到为 ""） */
    instanceName?: string
    /** 当前实例 WebUI 端口；取不到为 null */
    webuiPort?: number | null
    /** 当前配置 revision（本地起跑未同步为 0） */
    configRevision?: number
    /** 配置来源 */
    configSource?: 'server' | 'local'
    /** 构建戳（<commit>-<构建时间>），用于判断页面是否旧版 */
    build?: string
}

/** 账号管理插件实例（/api/peers 的一条） */
export interface PeerInfo {
    uin: string
    name: string
    webuiPort: number | null
    running: boolean
    isLogin: boolean
}

/** 服务端 bot 配置摘要（/api/server-bots 的一条） */
export interface ServerBotSummary {
    uin: string
    nickname: string
    revision: number
    updatedAt?: string
}

/** 账号下拉合并后的一条：服务端 bot 列表 ∪ 插件实例列表 */
export interface AccountEntry {
    uin: string
    name: string
    running: boolean
    isLogin: boolean
    /** 服务端配置 revision；该号还没上服务端为 null */
    revision: number | null
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
    enabled?: boolean
}

export interface PrivateGuideView {
    enabled: boolean
    text: string
    /** 同一用户的引导窗口（秒）；<=0 = 每条消息都引导 */
    windowSeconds: number
}

export interface PrivateConfigView {
    enabled: boolean
    whitelist?: (number | string)[]
    whitelistText?: string
    /** 同一私聊用户连发合并窗口（毫秒）；0 = 关闭 */
    mergeWindowMs?: number
    /** 私聊首条引导 */
    guide?: PrivateGuideView
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
    fallback?: { privateText: string; groupAtText: string }
    aiTrigger?: AiTriggerView
    keywords?: KeywordRuleView[]
    keywordsText?: string
    blacklist?: (number | string)[]
    blacklistText?: string
    /** 转人工追问 */
    collect?: { enabled: boolean; questions: string[] }
    /** 反向下发令牌（Telegram 回流） */
    relay?: { token?: string }
    /** 发送失败熔断 */
    sendGuard?: { failThreshold: number; privateFailThreshold: number; cooldownSeconds: number }
    /** 群内回复对刷熔断 */
    loopGuard?: { maxReplies: number; windowSeconds: number; pauseSeconds: number }
    /** 忽略的发送者（两个机器人同群时填对方） */
    ignoreSenders?: string[]
    ignoreSendersText?: string
    /** 多账号同群去重 */
    crossAccountDedup?: boolean
    /** 账号插件 /instances 凭据（出口已打码） */
    accountAccessKey?: string
    /** 服务端群配置刷新间隔（毫秒） */
    groupConfigRefreshMs?: number
    /** 好友申请自动通过 */
    friendRequest?: { autoAccept: boolean }
    groupRules?: Record<string, Record<string, unknown>>
    [key: string]: unknown
}

/** 群回复模式：off 一律不回；all 响应所有消息；at 仅被 @ 时响应 */
export type GroupMode = 'off' | 'all' | 'at'
/** 未命中关键词时的策略：先问 AI 再兜底 / 直接兜底 / 不回复 */
export type MissPolicy = 'ai_then_fallback' | 'fallback_only' | 'none'

/** /api/groups 的一条 */
export interface GroupRuleEntry {
    groupId: string
    name: string
    mode: GroupMode
    missPolicy: MissPolicy
    /** 仅 mode=at 有意义：被 @ 且未命中、missPolicy=none 时仍回兜底 */
    atForceReply: boolean
    /** 仅 mode=all 有意义：非 @ 命中关键词也回 */
    keywordOutsideAt: boolean
    /** 群级冷却秒数；null = 跟随全局 */
    cooldownSeconds: number | null
    /** 群级兜底文案；null = 跟随全局 */
    fallbackText: string | null
    /** 旧字段：由服务端按 mode/missPolicy 反推，页面只读回显 */
    enabled: boolean
    atOnly: boolean
    aiEnabled: boolean
    welcomeEnabled: boolean
    welcomeTemplate: string | null
    source: 'server' | 'local' | 'default'
}

/** 未配置群（服务端无条目、本地 groupRules 也没有）的默认策略 */
export interface GroupDefaultView {
    mode: GroupMode
    missPolicy: MissPolicy
    atForceReply: boolean
    keywordOutsideAt: boolean
    cooldownSeconds: number | null
    fallbackText: string | null
}

/** /api/groups 响应：群列表 + 全局默认值（页面展示「跟随全局」用） */
export interface GroupsResponse {
    groups: GroupRuleEntry[]
    global: {
        cooldownSeconds: number
        fallbackText: string
        groupDefault?: GroupDefaultView | null
    }
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

/* ========== 看板：服务端按天聚合的流量 ========== */

export interface TrafficThroughput {
    in: number
    privateIn: number
    groupIn: number
    replies: number
    ruleHits: number
    aiReplies: number
    fallbackReplies: number
}

export interface TrafficGroupRow {
    groupId: string
    name: string | null
    in: number
    replies: number
    ruleHits: number
    aiReplies: number
    fallbackReplies: number
    users: number
}

export interface TrafficDay {
    day: string
    throughput?: TrafficThroughput
    rules?: { hits?: number; top?: { match: string; count: number }[] }
    groups?: TrafficGroupRow[]
    hourly?: { hour: string; in: number }[]
}

export interface TrafficResponse {
    days: number
    /** 服务端是否配好（未配置时不发请求，items 全是 null row） */
    configured: boolean
    items: { day: string; row: TrafficDay | null }[]
}

/** 关键词命中统计（本实例内存计数） */
export interface KeywordStatView {
    count: number
    lastAt?: string
}
export type KeywordStatsMap = Record<string, KeywordStatView>

/** 配置快照 */
export interface SnapshotMeta {
    id: string
    ts: string
    size: number
    note: string
}
