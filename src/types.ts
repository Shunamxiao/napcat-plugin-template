/**
 * 类型定义 — QQ 自动回复插件
 */

/** 单条关键词规则 */
export interface KeywordRule {
    /** 匹配文本 */
    match: string;
    /** 匹配方式：contains(包含,默认) | prefix(前缀) | regex(正则) */
    matchType?: "contains" | "prefix" | "regex";
    /** 回复内容；replies 非空时作为兜底 */
    reply: string;
    /** 回复池：非空时随机选一条发送，优先于 reply */
    replies?: string[];
    /** 可选:随回复发送的图片(URL / base64://xxx / 容器内绝对路径) */
    image?: string;
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
}

/** 群聊配置 */
export interface GroupConfig {
    enabled: boolean;
    /** 群号白名单，空 = 对所有群生效 */
    whitelist: (number | string)[];
    /** WebUI 编辑用的多行文本形式(每行一个群号,# 注释,不参与匹配) */
    whitelistText?: string;
}

/** 群级规则：未设置的字段沿用全局配置 */
export interface GroupRule {
    /** 该群是否启用自动回复，false = 该群完全不回复 */
    enabled?: boolean;
    /** 是否仅 @ 机器人时回复，覆盖全局 atOnly */
    atOnly?: boolean;
    /** 该群专属关键词；非空时替代全局关键词 */
    keywords?: KeywordRule[];
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
    /** 各群独立启用配置(群管理页使用) */
    groupConfigs: Record<string, GroupConfig>;
    /** 群级规则：键为群号，未配置的群沿用全局规则 */
    groupRules?: Record<string, GroupRule>;
    /** 多账号同群时跨实例去重,避免重复回复(默认开启) */
    crossAccountDedup?: boolean;
    /** WebUI 编辑用的多行文本形式(不参与消息匹配) */
    keywordsText?: string;
    /** 群级规则的 JSON 文本形式(供配置表单编辑，不参与消息匹配) */
    groupRulesText?: string;
    /** 黑名单的多行文本形式(每行一个 QQ 号,# 注释) */
    blacklistText?: string;
}

export interface ApiResponse<T = unknown> {
    code: number;
    message?: string;
    data?: T;
}
