/**
 * 类型定义 — QQ 自动回复插件
 */

/** 规则命中后的动作 */
export type RuleAction = "reply" | "ai" | "human";

/** 群回复模式：off 一律不回（含 @）；all 响应所有消息；at 仅被 @ 时响应 */
export type GroupMode = "off" | "all" | "at";

/** 未命中关键词时的策略：先问 AI 再兜底 / 直接兜底 / 不回复 */
export type MissPolicy = "ai_then_fallback" | "fallback_only" | "none";

/** 单条关键词规则 */
export interface KeywordRule {
    /** 匹配文本 */
    match: string;
    /** 匹配方式：contains(包含,默认) | prefix(前缀) | regex(正则) */
    matchType?: "contains" | "prefix" | "regex";
    /** 命中后的动作：reply(回话术,默认) | ai(跳过话术直接问服务) | human(转人工,回兜底话术并记日志) */
    action?: RuleAction;
    /** 回复内容；replies 非空时作为兜底 */
    reply: string;
    /** 回复池：非空时随机选一条发送，优先于 reply */
    replies?: string[];
    /** 是否启用（缺省视为启用；false 时跳过匹配，群/私聊共用） */
    enabled?: boolean;
    /** 可选:随回复发送的图片(URL / base64://xxx / 容器内绝对路径) */
    image?: string;
    /** 命中本规则时先问知识库/AI,拿不到答案再退回 reply(默认 false) */
    aiFallback?: boolean;
}

/** 知识库/AI 服务配置 */
export interface KbServiceConfig {
    /** 总开关；关闭后规则 aiFallback 与未命中升级都不调服务 */
    enabled: boolean;
    /** 服务地址，形如 https://qqbot.theworld.codes */
    baseUrl: string;
    /** x-bot-token，页面填写，不写日志 */
    token: string;
    /** 单次请求超时(毫秒) */
    timeoutMs: number;
}

/** 未命中规则时升级 AI 的触发条件 */
export interface AiTriggerConfig {
    /** 私聊未命中时升级 */
    private: boolean;
    /** 群内仅 @机器人/回复机器人时升级；false 时群内任意未命中都升级 */
    groupAtOnly: boolean;
}

/** 服务侧拉黑名单的一条缓存 */
export interface BlockUser {
    userId: string;
    reason?: string;
    ts?: string;
}

/** 服务侧拉黑名单的本地缓存(权威在服务侧) */
export interface BlocklistCacheConfig {
    users: BlockUser[];
    /** 定时同步间隔(秒) */
    syncSeconds: number;
    /** 上次成功同步时间(ISO) */
    lastSyncedAt: string;
}

/** 私聊配置 */
export interface PrivateConfig {
    enabled: boolean;
    /** 未命中关键词时的兜底回复，空 = 不回复 */
    defaultReply: string;
    /** QQ 号白名单，空 = 对所有人生效 */
    whitelist: (number | string)[];
    /** WebUI 编辑用的多行文本形式(每行一个 QQ 号,# 注释,不参与匹配) */
    whitelistText?: string;
    /** 同一私聊用户连续消息合并窗口(毫秒)；3 秒内多条合并成一次问答，最多 5 条；0 = 关闭 */
    mergeWindowMs: number;
}

/** 群聊配置 */
export interface GroupConfig {
    enabled: boolean;
    /** 群号白名单，空 = 对所有群生效 */
    whitelist: (number | string)[];
    /** WebUI 编辑用的多行文本形式(每行一个群号,# 注释,不参与匹配) */
    whitelistText?: string;
}

/**
 * 未配置群（服务端无条目、本地 groupRules 也没有）的默认策略。
 * 老行为是「一律静默」，现改为走这里，默认 at + 关键词命中才回，防刷。
 */
export interface GroupDefaultConfig {
    /** 群模式；默认 at（仅 @ 或命中关键词时响应） */
    mode: GroupMode;
    /** 未命中关键词时的策略；默认 none（不回复） */
    missPolicy: MissPolicy;
    /** 仅 mode=at 有意义：被 @ 且未命中、missPolicy=none 时仍回兜底 */
    atForceReply: boolean;
    /** 非 @ 消息命中关键词是否回复（at / all 两种模式都生效） */
    keywordOutsideAt: boolean;
    /** 冷却秒数；null = 跟随全局 cooldownSeconds */
    cooldownSeconds: number | null;
    /** 兜底文案；null = 跟随全局 fallback.groupAtText */
    fallbackText: string | null;
}

/** 群级规则：未设置的字段沿用全局配置 */
export interface GroupRule {    /** 该群是否启用自动回复，false = 该群完全不回复；未在 groupRules 出现的群一律不处理 */
    enabled?: boolean;
    /** 是否仅 @ 机器人时回复，覆盖全局 atOnly */
    atOnly?: boolean;
    /** 该群专属关键词；非空时替代全局关键词 */
    keywords?: KeywordRule[];
    /** 该群是否允许升级 AI；false = 该群显式禁用(规则 aiFallback 也不调服务)，未设置 = 允许 */
    aiEnabled?: boolean;
    /** 该群入群欢迎覆盖；字段为 null/缺省时跟随全局 groupWelcome */
    welcome?: GroupWelcomeOverride;
    /** 该群兜底话术覆盖；字段为 null/缺省时跟随全局 fallback */
    fallback?: GroupFallbackOverride;
}

/** 群级兜底话术覆盖：null/缺省 = 跟随全局 */
export interface GroupFallbackOverride {
    privateText?: string | null;
    groupAtText?: string | null;
}

/** 群级入群欢迎覆盖：null/缺省 = 跟随全局 */
export interface GroupWelcomeOverride {
    /** true = 本群单独开启，false = 本群关闭，null/缺省 = 跟随全局 */
    enabled?: boolean | null;
    /** 本群欢迎模板；空/null/缺省 = 跟随全局模板 */
    template?: string | null;
}

/** 入群欢迎配置 */
export interface GroupWelcomeConfig {
    /** 是否启用入群欢迎 */
    enabled: boolean;
    /** 欢迎语模板，支持 {group_id} / {user_id} 占位符 */
    template: string;
}

/** 好友申请处理配置 */
export interface FriendRequestConfig {
    /** 是否自动通过好友申请（默认关闭，注意风控） */
    autoAccept: boolean;
}

/** 兜底话术：私聊未命中必回；群内 @ 未命中必回 */
export interface FallbackConfig {
    /** 私聊未命中关键词/FAQ 时的兜底话术；空 = 不回 */
    privateText: string;
    /** 群内被 @ 但未命中关键词/FAQ 时的兜底话术；空 = 不回 */
    groupAtText: string;
}

/** 转人工追问：关闭时直接转人工；开启时按顺序逐条发问再转人工 */
export interface CollectConfig {
    enabled: boolean;
    /** 问题列表，按顺序逐条追问；一行一题 */
    questions: string[];
}

/** 反向下发（Telegram 回流）配置 */
export interface RelayConfig {
    /** x-relay-token；空 = 拒绝 /api/relay */
    token: string;
}

/** 发送失败熔断（防风控）：连续失败达到阈值后暂停该群/该用户的发送 */
export interface SendGuardConfig {
    /** 群连续发送失败阈值，达到即熔断（默认 3） */
    failThreshold: number;
    /** 私聊连续发送失败阈值（默认 5） */
    privateFailThreshold: number;
    /** 熔断冷却秒数，群/私聊共用（默认 600） */
    cooldownSeconds: number;
}

/** 群内回复对刷熔断：窗口内发出达到阈值后暂停该群，防两个机器人互相触发 */
export interface LoopGuardConfig {
    /** 窗口内最多发出条数，达到后暂停该群（默认 5） */
    maxReplies: number;
    /** 统计窗口(秒，默认 60) */
    windowSeconds: number;
    /** 暂停时长(秒，默认 300) */
    pauseSeconds: number;
}

/**
 * 服务端群配置（GET /config/groups 的一条；服务端是群规则真源）
 *
 * enabled/atOnly/aiEnabled 是旧字段，老服务端仍会下发；新服务端由 mode/missPolicy 反推。
 * mode/missPolicy 等新字段在解析时会补全；PUT 返回老服务端条目时可能缺省，读取侧按旧字段兜底。
 */
export interface ServerGroupConfig {
    groupId: string;
    /** 该群是否启用自动回复（旧字段，= mode !== 'off'） */
    enabled: boolean;
    /** 是否仅 @ 时回复（旧字段，= mode === 'at'） */
    atOnly: boolean;
    /** 是否允许升级 AI（旧字段，= missPolicy === 'ai_then_fallback'） */
    aiEnabled: boolean;
    /** 是否启用入群欢迎 */
    welcomeEnabled: boolean;
    /** 入群欢迎模板；空/null 时回落到 groupWelcome.template */
    welcomeTemplate: string | null;
    /** 群回复模式；缺省时由 enabled/atOnly 推导 */
    mode?: GroupMode;
    /** 未命中策略；缺省时由 aiEnabled 推导 */
    missPolicy?: MissPolicy;
    /** 仅 mode=at 有意义：被 @ 且未命中、missPolicy=none 时仍回兜底（默认 true） */
    atForceReply?: boolean;
    /** 仅 mode=all 有意义：非 @ 命中关键词也回（默认 true） */
    keywordOutsideAt?: boolean;
    /** 群级冷却秒数；null/缺省 = 跟随全局 */
    cooldownSeconds?: number | null;
    /** 群级兜底文案；null/缺省 = 跟随全局 */
    fallbackText?: string | null;
}

/** 服务端守卫处罚策略（屏蔽词命中 N 次 → 禁言） */
export interface GuardPenaltyPolicy {
    /** 计数窗口(秒) */
    windowSeconds: number;
    /** 触发禁言的次数 */
    threshold: number;
    /** 禁言时长(秒) */
    muteSeconds: number;
    /** 警告文案 */
    warnText: string;
    /** 禁言提示文案 */
    muteText: string;
}

/** 群内容守卫命中后的动作：撤回 | 警告 | 撤回并警告 */
export type GuardAction = "recall" | "warn" | "both";

/** 群内容守卫：群消息命中屏蔽词时自动撤回（群管理能力，独立开关） */
export interface GuardConfig {
    /** 总开关（默认 false） */
    enabled: boolean;
    /** 生效群号；空 = 所有已启用自动回复的群 */
    groupIds: (number | string)[];
    /** WebUI 编辑用的多行文本形式(每行一个群号,不参与匹配) */
    groupIdsText?: string;
    /** 屏蔽词表；空 = 不撤回任何消息 */
    words: string[];
    /** WebUI 编辑用的多行文本形式(每行一个词,不参与匹配) */
    wordsText?: string;
    /** 命中动作：recall(默认，仅撤回) | warn(仅警告) | both(撤回并警告) */
    action: GuardAction;
    /** action=warn/both 时发送的群提示语 */
    warnText: string;
    /** 服务词表刷新间隔(毫秒，默认 300000)；本地 words 始终叠加生效 */
    wordsRefreshMs: number;
}

export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    keywords: KeywordRule[];
    private: PrivateConfig;
    group: GroupConfig;
    /** 不可回复的 QQ 号（如自己） */
    blacklist: (number | string)[];
    /** 同一用户命中同一规则后的冷却秒数,0 = 关闭 */
    cooldownSeconds: number;
    /** 回复前随机延迟下限(毫秒),拟人防风控 */
    replyDelayMinMs: number;
    /** 回复前随机延迟上限(毫秒) */
    replyDelayMaxMs: number;
    /** 群聊是否仅被 @ 时才回复 */
    atOnly: boolean;
    /** 群聊回复时是否在消息前 @ 触发者（默认 false） */
    atReply?: boolean;
    /** 入群欢迎 */
    groupWelcome?: GroupWelcomeConfig;
    /** 好友申请处理 */
    friendRequest?: FriendRequestConfig;
    /** 兜底话术（私聊必回 / 群内 @ 必回） */
    fallback: FallbackConfig;
    /** 转人工追问 */
    collect: CollectConfig;
    /** 反向下发端点令牌 */
    relay: RelayConfig;
    /** 发送失败熔断 */
    sendGuard: SendGuardConfig;
    /** 忽略的发送者 QQ 号（两个机器人同群时填自己/对方，命中直接丢弃） */
    ignoreSenders: string[];
    /** 忽略发送者的多行文本形式（供配置表单编辑，不参与匹配） */
    ignoreSendersText?: string;
    /** 群内回复对刷熔断 */
    loopGuard: LoopGuardConfig;
    /** 群内容守卫（屏蔽词撤回） */
    guard: GuardConfig;
    /** 各群独立启用配置(群管理页使用) */
    groupConfigs: Record<string, GroupConfig>;
    /** 群级规则：键为群号，未配置的群沿用全局规则 */
    groupRules?: Record<string, GroupRule>;
    /** 未配置群（服务端与本地都没有条目）的默认策略 */
    groupDefault?: GroupDefaultConfig;
    /** 多账号同群时跨实例去重,避免重复回复(默认开启) */
    crossAccountDedup?: boolean;
    /** WebUI 编辑用的多行文本形式(不参与消息匹配) */
    keywordsText?: string;
    /** 群级规则的 JSON 文本形式(供配置表单编辑，不参与消息匹配) */
    groupRulesText?: string;
    /** 黑名单的多行文本形式(每行一个 QQ 号,# 注释) */
    blacklistText?: string;
    /** 知识库/AI 服务(FAQ 直答 + AI 兜底) */
    kbService: KbServiceConfig;
    /** 未命中规则时是否升级 AI */
    aiTrigger: AiTriggerConfig;
    /** 服务侧拉黑名单缓存 */
    blocklist: BlocklistCacheConfig;
    /** 服务端群配置刷新间隔(毫秒)；默认 300000，服务不可用时沿用上次缓存 */
    groupConfigRefreshMs?: number;
    /** 账号插件 /instances 转发凭据（?key=）；默认空串，env QQBOT_ACCOUNT_ACCESS_KEY 兜底；绝不进 /api 出口与日志 */
    accountAccessKey?: string;
}

export interface ApiResponse<T = unknown> {
    code: number;
    message?: string;
    data?: T;
}
