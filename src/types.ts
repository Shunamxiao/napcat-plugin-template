/**
 * 类型定义 — QQ 自动回复插件
 */

/** 单条关键词规则 */
export interface KeywordRule {
    /** 匹配文本 */
    match: string;
    /** 匹配方式：contains(包含,默认) | prefix(前缀) */
    matchType?: "contains" | "prefix";
    /** 回复内容 */
    reply: string;
}

/** 私聊配置 */
export interface PrivateConfig {
    enabled: boolean;
    /** 未命中关键词时的兜底回复，空 = 不回复 */
    defaultReply: string;
    /** QQ 号白名单，空 = 对所有人生效 */
    whitelist: (number | string)[];
}

/** 群聊配置 */
export interface GroupConfig {
    enabled: boolean;
    /** 群号白名单，空 = 对所有群生效 */
    whitelist: (number | string)[];
}

export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    keywords: KeywordRule[];
    private: PrivateConfig;
    group: GroupConfig;
    /** 不可回复的 QQ 号（如自己） */
    blacklist: (number | string)[];
    /** WebUI 编辑用的多行文本形式(不参与消息匹配) */
    keywordsText?: string;
}

export interface ApiResponse<T = unknown> {
    code: number;
    message?: string;
    data?: T;
}
