/**
 * 全局状态管理模块（单例模式）
 *
 * 封装插件的配置持久化和运行时状态，提供在项目任意位置访问
 * ctx、config、logger 等对象的能力，无需逐层传递参数。
 *
 * 使用方法：
 *   import { pluginState } from '../core/state';
 *   pluginState.config.enabled;       // 读取配置
 *   pluginState.ctx.logger.info(...); // 使用日志
 */

import fs from 'fs';
import path from 'path';
import type { NapCatPluginContext, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin/types';
import { DEFAULT_CONFIG, groupRulesToText, textToGroupRules } from '../config';
import type { BlockUser, KeywordRule, PluginConfig, GroupConfig, GroupRule, RuleAction } from '../types';
import type { CollectSession } from './collect';

// ==================== 配置清洗工具 ====================

/** 配置回显用的令牌占位符；真 token 绝不下发到任何 HTTP 响应 */
export const TOKEN_MASK = "••••••";

/** 空串 / 未提交 / 占位符都表示「保持原令牌」，只有新值才覆盖 */
export function isTokenPlaceholder(value: unknown): boolean {
    return value === undefined || value === null || value === "" || value === TOKEN_MASK;
}

/** 返回配置副本，kbService.token 打码；只在序列化出口使用，不回写运行时状态 */
export function maskConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        kbService: {
            ...config.kbService,
            token: config.kbService?.token ? TOKEN_MASK : "",
        },
    };
}

/**
 * 防外泄：改服务地址（baseUrl）必须同时提交新令牌。
 * 否则拿到地址的人可以把 baseUrl 指向自己的域名，定时同步就会把已存令牌发过去。
 */
function assertEndpointChangeSafe(current: PluginConfig['kbService'], incoming: Partial<PluginConfig['kbService']> | undefined): void {
    if (!incoming) return;
    const nextBase = typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!nextBase || nextBase === current.baseUrl) return;
    if (isTokenPlaceholder(incoming.token)) {
        throw new Error('修改服务地址时必须同时重新填写访问令牌');
    }
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 数字字段落在 [min,max]；非数字/NaN 用 fallback */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** 去重字符串列表：只收 string/number，trim 后保留非空项 */
function uniqueStrings(raw: unknown, maxLen = 200): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string' && typeof item !== 'number') continue;
        const value = String(item).trim().slice(0, maxLen);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

/** 清洗服务侧拉黑缓存：逐条校验 userId、去重；reason/ts 可选 */
export function sanitizeBlockUsers(raw: unknown): BlockUser[] {
    if (!Array.isArray(raw)) return [];
    const out: BlockUser[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!isObject(item)) continue;
        const userId = typeof item.userId === 'string' ? item.userId.trim() : '';
        if (!userId || seen.has(userId)) continue;
        seen.add(userId);
        const entry: BlockUser = { userId };
        if (typeof item.reason === 'string' && item.reason.trim()) entry.reason = item.reason.trim();
        if (typeof item.ts === 'string' && item.ts.trim()) entry.ts = item.ts.trim();
        out.push(entry);
    }
    return out;
}

/** 规则动作白名单，非法值一律回落 reply（旧配置无此字段时同样按 reply） */
export function normalizeRuleAction(raw: unknown): RuleAction {
    return raw === 'ai' ? 'ai' : raw === 'human' ? 'human' : 'reply';
}

/** 清洗单条关键词规则,结构或内容非法时返回 null */
function sanitizeKeywordRule(raw: unknown): KeywordRule | null {
    if (!isObject(raw)) return null;
    if (typeof raw.match !== 'string' || !raw.match.trim()) return null;
    const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
    const replies = Array.isArray(raw.replies)
        ? raw.replies
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    const action = normalizeRuleAction(raw.action);
    // action=ai 不需要文案；其余动作至少要有一句话术（图片不能替代文字）
    if (action !== 'ai' && !reply && replies.length === 0) return null;
    const rule: KeywordRule = {
        match: raw.match,
        matchType: raw.matchType === 'prefix' ? 'prefix' : raw.matchType === 'regex' ? 'regex' : 'contains',
        reply: reply || replies[0] || '',
        action,
    };
    if (replies.length > 0) rule.replies = replies;
    if (typeof raw.image === 'string' && raw.image.trim()) rule.image = raw.image.trim();
    if (raw.aiFallback === true) rule.aiFallback = true;
    return rule;
}

/** 清洗群级规则表:键为群号,逐字段校验,非法条目直接丢弃 */
function sanitizeGroupRules(raw: Record<string, unknown>): Record<string, GroupRule> {
    const out: Record<string, GroupRule> = {};
    for (const [groupId, rule] of Object.entries(raw)) {
        if (!groupId.trim() || !isObject(rule)) continue;
        const item: GroupRule = {};
        if (typeof rule.enabled === 'boolean') item.enabled = rule.enabled;
        if (typeof rule.atOnly === 'boolean') item.atOnly = rule.atOnly;
        if (typeof rule.aiEnabled === 'boolean') item.aiEnabled = rule.aiEnabled;
        // 群级入群欢迎：只保留 boolean/string/null，null 表示跟随全局
        if (isObject(rule.welcome)) {
            const welcome: NonNullable<GroupRule['welcome']> = {};
            if (typeof rule.welcome.enabled === 'boolean') welcome.enabled = rule.welcome.enabled;
            else if (rule.welcome.enabled === null) welcome.enabled = null;
            if (typeof rule.welcome.template === 'string') {
                welcome.template = rule.welcome.template.trim() ? rule.welcome.template : null;
            } else if (rule.welcome.template === null) {
                welcome.template = null;
            }
            if (Object.keys(welcome).length > 0) item.welcome = welcome;
        }
        // 群级兜底话术：只保留 string/null，null 表示跟随全局
        if (isObject(rule.fallback)) {
            const fallback: NonNullable<GroupRule['fallback']> = {};
            if (typeof rule.fallback.privateText === 'string') fallback.privateText = rule.fallback.privateText;
            else if (rule.fallback.privateText === null) fallback.privateText = null;
            if (typeof rule.fallback.groupAtText === 'string') fallback.groupAtText = rule.fallback.groupAtText;
            else if (rule.fallback.groupAtText === null) fallback.groupAtText = null;
            if (Object.keys(fallback).length > 0) item.fallback = fallback;
        }
        if (Array.isArray(rule.keywords)) {
            const keywords = rule.keywords.map(sanitizeKeywordRule).filter((k): k is KeywordRule => k !== null);
            if (keywords.length > 0) item.keywords = keywords;
        }
        out[groupId] = item;
    }
    return out;
}

/**
 * 配置清洗函数
 * 确保从文件读取的配置符合预期类型，防止运行时错误
 */
export function sanitizeConfig(raw: unknown): PluginConfig {
    // 深拷贝默认值,避免嵌套对象共享引用被运行时修改污染
    const out: PluginConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    if (!isObject(raw)) return out;

    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.debug === 'boolean') out.debug = raw.debug;
    if (typeof raw.cooldownSeconds === 'number' && raw.cooldownSeconds >= 0) out.cooldownSeconds = raw.cooldownSeconds;
    if (typeof raw.replyDelayMinMs === 'number' && raw.replyDelayMinMs >= 0) out.replyDelayMinMs = raw.replyDelayMinMs;
    if (typeof raw.replyDelayMaxMs === 'number' && raw.replyDelayMaxMs >= 0) out.replyDelayMaxMs = raw.replyDelayMaxMs;
    if (typeof raw.atOnly === 'boolean') out.atOnly = raw.atOnly;
    if (typeof raw.atReply === 'boolean') out.atReply = raw.atReply;
    if (isObject(raw.groupWelcome)) {
        out.groupWelcome = {
            enabled: typeof raw.groupWelcome.enabled === 'boolean' ? raw.groupWelcome.enabled : (out.groupWelcome?.enabled ?? false),
            template: typeof raw.groupWelcome.template === 'string' ? raw.groupWelcome.template : (out.groupWelcome?.template ?? ''),
        };
    }
    if (isObject(raw.friendRequest)) {
        out.friendRequest = {
            autoAccept: typeof raw.friendRequest.autoAccept === 'boolean' ? raw.friendRequest.autoAccept : (out.friendRequest?.autoAccept ?? false),
        };
    }
    if (isObject(raw.fallback)) {
        out.fallback = {
            privateText: typeof raw.fallback.privateText === 'string' ? raw.fallback.privateText : out.fallback.privateText,
            groupAtText: typeof raw.fallback.groupAtText === 'string' ? raw.fallback.groupAtText : out.fallback.groupAtText,
        };
    }
    if (isObject(raw.collect)) {
        out.collect = {
            enabled: typeof raw.collect.enabled === 'boolean' ? raw.collect.enabled : out.collect.enabled,
            questions: Array.isArray(raw.collect.questions)
                ? raw.collect.questions
                    .filter((item): item is string => typeof item === 'string')
                    .map((item) => item.trim())
                    .filter(Boolean)
                : out.collect.questions,
        };
    }
    if (isObject(raw.relay)) {
        out.relay = {
            token: typeof raw.relay.token === 'string' ? raw.relay.token.trim() : out.relay.token,
        };
    }
    if (isObject(raw.sendGuard)) {
        out.sendGuard = {
            failThreshold: clampInt(raw.sendGuard.failThreshold, 1, 100, out.sendGuard.failThreshold),
            privateFailThreshold: clampInt(raw.sendGuard.privateFailThreshold, 1, 100, out.sendGuard.privateFailThreshold),
            cooldownSeconds: clampInt(raw.sendGuard.cooldownSeconds, 1, 86400, out.sendGuard.cooldownSeconds),
        };
    }
    // 忽略发送者：只保留非空字符串，去重
    if (Array.isArray(raw.ignoreSenders)) {
        const seen = new Set<string>();
        const list: string[] = [];
        for (const item of raw.ignoreSenders) {
            const value = String(item).trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            list.push(value);
        }
        out.ignoreSenders = list;
    }
    if (typeof raw.ignoreSendersText === 'string') out.ignoreSendersText = raw.ignoreSendersText;
    // 群内对刷熔断：阈值/窗口/暂停都受限，防止误配成 0 或巨值失效
    if (isObject(raw.loopGuard)) {
        out.loopGuard = {
            maxReplies: clampInt(raw.loopGuard.maxReplies, 1, 100, out.loopGuard.maxReplies),
            windowSeconds: clampInt(raw.loopGuard.windowSeconds, 1, 3600, out.loopGuard.windowSeconds),
            pauseSeconds: clampInt(raw.loopGuard.pauseSeconds, 1, 86400, out.loopGuard.pauseSeconds),
        };
    }
    // 群内容守卫：开关/群号/词表/动作/警告话术逐项白名单化
    if (isObject(raw.guard)) {
        out.guard = {
            enabled: typeof raw.guard.enabled === 'boolean' ? raw.guard.enabled : out.guard.enabled,
            groupIds: Array.isArray(raw.guard.groupIds) ? uniqueStrings(raw.guard.groupIds, 32) : out.guard.groupIds,
            action: raw.guard.action === 'warn' || raw.guard.action === 'both' ? raw.guard.action : 'recall',
            words: Array.isArray(raw.guard.words) ? uniqueStrings(raw.guard.words) : out.guard.words,
            warnText: typeof raw.guard.warnText === 'string' ? raw.guard.warnText : out.guard.warnText,
            wordsRefreshMs: clampInt(raw.guard.wordsRefreshMs, 1000, 86400000, out.guard.wordsRefreshMs),
        };
        if (typeof raw.guard.groupIdsText === 'string') out.guard.groupIdsText = raw.guard.groupIdsText;
        if (typeof raw.guard.wordsText === 'string') out.guard.wordsText = raw.guard.wordsText;
    }
    if (typeof raw.crossAccountDedup === 'boolean') out.crossAccountDedup = raw.crossAccountDedup;
    if (typeof raw.keywordsText === 'string') out.keywordsText = raw.keywordsText;
    if (typeof raw.blacklistText === 'string') out.blacklistText = raw.blacklistText;

    // 关键词规则清洗:结构与内容合法才保留,防止坏数据进入运行时
    if (Array.isArray(raw.keywords)) {
        const keywords = raw.keywords
            .map(sanitizeKeywordRule)
            .filter((k): k is KeywordRule => k !== null);
        if (keywords.length > 0) out.keywords = keywords;
    }

    // 群级规则清洗:坏条目丢弃,防止非法数据进入运行时
    if (isObject(raw.groupRules)) {
        out.groupRules = sanitizeGroupRules(raw.groupRules);
    }
    // 文本字段始终由结构化规则推导,保证读取与持久化内容一致
    out.groupRulesText = groupRulesToText(out.groupRules);

    if (isObject(raw.private)) {
        if (typeof raw.private.enabled === 'boolean') out.private.enabled = raw.private.enabled;
        if (typeof raw.private.defaultReply === 'string') out.private.defaultReply = raw.private.defaultReply;
        if (Array.isArray(raw.private.whitelist)) out.private.whitelist = raw.private.whitelist.map(String);
        if (typeof raw.private.whitelistText === 'string') out.private.whitelistText = raw.private.whitelistText;
        // 0 表示关闭合并；上限 60 秒，防止误配成超大值导致回复迟迟不发
        out.private.mergeWindowMs = clampInt(raw.private.mergeWindowMs, 0, 60000, out.private.mergeWindowMs);
    }

    if (isObject(raw.group)) {
        if (typeof raw.group.enabled === 'boolean') out.group.enabled = raw.group.enabled;
        if (Array.isArray(raw.group.whitelist)) out.group.whitelist = raw.group.whitelist.map(String);
        if (typeof raw.group.whitelistText === 'string') out.group.whitelistText = raw.group.whitelistText;
    }

    if (Array.isArray(raw.blacklist)) out.blacklist = raw.blacklist.map(String);

    // 知识库/AI 服务：字段逐个白名单化，坏值回退默认，绝不把未知内容带进运行时
    if (isObject(raw.kbService)) {
        const kb = raw.kbService;
        out.kbService = {
            enabled: typeof kb.enabled === 'boolean' ? kb.enabled : out.kbService.enabled,
            baseUrl: typeof kb.baseUrl === 'string' && kb.baseUrl.trim()
                ? kb.baseUrl.trim().replace(/\/+$/, '')
                : out.kbService.baseUrl,
            token: typeof kb.token === 'string' && kb.token.trim() !== TOKEN_MASK ? kb.token.trim() : out.kbService.token,
            timeoutMs: clampInt(kb.timeoutMs, 500, 60000, out.kbService.timeoutMs),
        };
    }
    if (isObject(raw.aiTrigger)) {
        out.aiTrigger = {
            private: typeof raw.aiTrigger.private === 'boolean' ? raw.aiTrigger.private : out.aiTrigger.private,
            groupAtOnly: typeof raw.aiTrigger.groupAtOnly === 'boolean' ? raw.aiTrigger.groupAtOnly : out.aiTrigger.groupAtOnly,
        };
    }
    if (isObject(raw.blocklist)) {
        out.blocklist = {
            users: Array.isArray(raw.blocklist.users) ? sanitizeBlockUsers(raw.blocklist.users) : out.blocklist.users,
            syncSeconds: clampInt(raw.blocklist.syncSeconds, 30, 86400, out.blocklist.syncSeconds),
            lastSyncedAt: typeof raw.blocklist.lastSyncedAt === 'string' ? raw.blocklist.lastSyncedAt : out.blocklist.lastSyncedAt,
        };
    }
    // 服务端群配置刷新间隔：30s ~ 1h，坏值回退默认 5 分钟
    out.groupConfigRefreshMs = clampInt(raw.groupConfigRefreshMs, 30000, 3600000, out.groupConfigRefreshMs ?? 300000);

    // 各群独立启用配置
    if (isObject(raw.groupConfigs)) {
        for (const [groupId, groupConfig] of Object.entries(raw.groupConfigs)) {
            if (isObject(groupConfig) && typeof groupConfig.enabled === 'boolean') {
                out.groupConfigs[groupId] = { enabled: groupConfig.enabled };
            }
        }
    }

    return out;
}

// ==================== 插件全局状态类 ====================

class PluginState {
    /** NapCat 插件上下文（init 后可用） */
    private _ctx: NapCatPluginContext | null = null;

    /** 插件配置 */
    config: PluginConfig = { ...DEFAULT_CONFIG };

    /** 插件启动时间戳 */
    startTime: number = 0;

    /** 机器人自身 QQ 号 */
    selfId: string = '';

    /** 活跃的定时器 Map: jobId -> NodeJS.Timeout */
    timers: Map<string, ReturnType<typeof setInterval>> = new Map();

    /** 回复冷却记录: key = 发送者QQ+规则, value = 上次命中时间戳 */
    replyCooldowns: Map<string, number> = new Map();

    /** 待发送的延迟回复定时器(卸载时取消,避免插件卸载后仍发出回复) */
    pendingReplies: Set<ReturnType<typeof setTimeout>> = new Set();

    /** 转人工追问会话: key = private:qq / group:群号:qq */
    collectSessions: Map<string, CollectSession> = new Map();

    /** 服务侧下发的群守卫词表（仅内存缓存；拉取失败保留上次成功结果） */
    serviceGuardWords: string[] = [];

    /** 服务词表最近一次成功同步时间(ISO)；空串 = 尚未成功 */
    guardWordsSyncedAt: string = '';

    /** 服务降级提示记录: user -> 上次发送时间戳（同一用户 10 分钟只提示一次） */
    serviceDownNotified: Map<string, number> = new Map();

    /** 运行时统计 */
    stats = {
        processed: 0,
        todayProcessed: 0,
        lastUpdateDay: new Date().toDateString(),
        /** FAQ 命中次数（服务返回了非空答案） */
        faqHit: 0,
        /** FAQ 未命中次数（服务失败/空答案） */
        faqMiss: 0,
    };

    /** 获取上下文（确保已初始化） */
    get ctx(): NapCatPluginContext {
        if (!this._ctx) throw new Error('PluginState 尚未初始化，请先调用 init()');
        return this._ctx;
    }

    /** 获取日志器的快捷方式 */
    get logger(): PluginLogger {
        return this.ctx.logger;
    }

    // ==================== 生命周期 ====================

    /**
     * 初始化（在 plugin_init 中调用）
     */
    init(ctx: NapCatPluginContext): void {
        this._ctx = ctx;
        this.startTime = Date.now();
        this.loadConfig();
        this.ensureDataDir();
        void this.fetchSelfId();
    }

    /**
     * 获取机器人自身 QQ 号（异步，init 时自动调用）
     */
    private async fetchSelfId(): Promise<void> {
        try {
            const res = await this.ctx.actions.call(
                'get_login_info', {}, this.ctx.adapterName, this.ctx.pluginManager.config
            ) as { user_id?: number | string };
            if (res?.user_id) {
                this.selfId = String(res.user_id);
                this.logger.debug("(｡·ω·｡) 机器人 QQ: " + this.selfId);
            }
        } catch (e) {
            this.logger.warn("(；′⌒`) 获取机器人 QQ 号失败:", e);
        }
    }

    /**
     * 清理（在 plugin_cleanup 中调用）
     */
    cleanup(): void {
        // 清理所有定时器
        for (const [jobId, timer] of this.timers) {
            clearInterval(timer);
            this.logger.debug(`(｡-ω-) 清理定时器: ${jobId}`);
        }
        this.timers.clear();
        // 取消尚未发送的延迟回复,并清空冷却记录
        for (const timer of this.pendingReplies) clearTimeout(timer);
        this.pendingReplies.clear();
        for (const session of this.collectSessions.values()) {
            if (session.timer) clearTimeout(session.timer);
        }
        this.collectSessions.clear();
        this.replyCooldowns.clear();
        this.serviceDownNotified.clear();
        this.saveConfig();
        this._ctx = null;
    }

    // ==================== 数据目录 ====================

    /** 确保数据目录存在 */
    private ensureDataDir(): void {
        const dataPath = this.ctx.dataPath;
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath, { recursive: true });
        }
    }

    /** 获取数据文件完整路径 */
    getDataFilePath(filename: string): string {
        return path.join(this.ctx.dataPath, filename);
    }

    // ==================== 通用数据文件读写 ====================

    /**
     * 读取 JSON 数据文件
     * 常用于订阅数据、定时任务配置、推送历史等持久化数据
     * @param filename 数据文件名（如 'subscriptions.json'）
     * @param defaultValue 文件不存在或解析失败时的默认值
     */
    loadDataFile<T>(filename: string, defaultValue: T): T {
        const filePath = this.getDataFilePath(filename);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch (e) {
            this.logger.warn("(；′⌒`) 读取数据文件 " + filename + " 失败:", e);
        }
        return defaultValue;
    }

    /**
     * 保存 JSON 数据文件
     * @param filename 数据文件名
     * @param data 要保存的数据
     */
    saveDataFile<T>(filename: string, data: T): void {
        const filePath = this.getDataFilePath(filename);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            this.logger.error("(╥﹏╥) 保存数据文件 " + filename + " 失败:", e);
        }
    }

    // ==================== 配置管理 ====================

    /**
     * 从磁盘加载配置
     */
    loadConfig(): void {
        const configPath = this.ctx.configPath;
        try {
            if (configPath && fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                this.config = sanitizeConfig(raw);
                // 加载统计信息
                if (isObject(raw) && isObject(raw.stats)) {
                    Object.assign(this.stats, raw.stats);
                }
                this.ctx.logger.debug('已加载本地配置');
            } else {
                this.config = sanitizeConfig(undefined);
                this.saveConfig();
                this.ctx.logger.debug('配置文件不存在，已创建默认配置');
            }
        } catch (error) {
            this.ctx.logger.error('加载配置失败，使用默认配置:', error);
            this.config = sanitizeConfig(undefined);
        }
    }

    /**
     * 保存配置到磁盘
     */
    saveConfig(): void {
        if (!this._ctx) return;
        const configPath = this._ctx.configPath;
        try {
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            const data = { ...this.config, stats: this.stats };
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
            this._ctx.logger.error('保存配置失败:', error);
        }
    }

    /**
     * 合并更新配置
     */
    updateConfig(partial: Partial<PluginConfig>): void {
        // 嵌套对象先与旧值合并,防止部分更新时静默丢失未提交字段(如 private.whitelist)
        const merged = { ...this.config, ...partial };
        if (partial.private) merged.private = { ...this.config.private, ...partial.private };
        if (partial.group) merged.group = { ...this.config.group, ...partial.group };
        if (partial.groupWelcome) {
            merged.groupWelcome = {
                enabled: this.config.groupWelcome?.enabled ?? false,
                template: this.config.groupWelcome?.template ?? '',
                ...partial.groupWelcome,
            };
        }
        if (partial.friendRequest) {
            merged.friendRequest = {
                autoAccept: this.config.friendRequest?.autoAccept ?? false,
                ...partial.friendRequest,
            };
        }
        if (partial.fallback) {
            merged.fallback = {
                privateText: this.config.fallback?.privateText ?? '',
                groupAtText: this.config.fallback?.groupAtText ?? '',
                ...partial.fallback,
            };
        }
        if (partial.collect) merged.collect = { ...this.config.collect, ...partial.collect };
        if (partial.relay) merged.relay = { ...this.config.relay, ...partial.relay };
        if (partial.sendGuard) merged.sendGuard = { ...this.config.sendGuard, ...partial.sendGuard };
        if (partial.guard) merged.guard = { ...this.config.guard, ...partial.guard };
        // 群级规则文本:合法 JSON 才覆盖结构化规则,非法文本忽略
        if (typeof partial.groupRulesText === 'string') {
            const parsed = textToGroupRules(partial.groupRulesText);
            if (parsed) merged.groupRules = parsed;
        }
        // 知识库/AI 相关嵌套对象同样先合并旧值，避免部分提交时丢字段
        if (partial.kbService) {
            assertEndpointChangeSafe(this.config.kbService, partial.kbService);
            merged.kbService = { ...this.config.kbService, ...partial.kbService };
            // 空串 / 占位符 / 未提交 = 保持原令牌；只有新值才覆盖
            if (isTokenPlaceholder(partial.kbService.token)) {
                merged.kbService.token = this.config.kbService.token;
            }
        }
        if (partial.aiTrigger) merged.aiTrigger = { ...this.config.aiTrigger, ...partial.aiTrigger };
        if (partial.blocklist) {
            merged.blocklist = {
                ...this.config.blocklist,
                ...partial.blocklist,
                users: Array.isArray(partial.blocklist.users) ? partial.blocklist.users : this.config.blocklist.users,
            };
        }
        this.config = sanitizeConfig(merged);
        this.saveConfig();
    }

    /**
     * 完整替换配置
     */
    replaceConfig(config: PluginConfig): void {
        const next: PluginConfig = { ...config };
        if (!next.kbService) {
            next.kbService = this.config.kbService;
        } else {
            assertEndpointChangeSafe(this.config.kbService, next.kbService);
            if (isTokenPlaceholder(next.kbService.token)) {
                // 页面/原生配置面板回传的是占位符或空串 → 沿用磁盘上的真令牌
                next.kbService = { ...next.kbService, token: this.config.kbService.token };
            }
        }
        this.config = sanitizeConfig(next);
        this.saveConfig();
    }

    /**
     * 更新指定群的配置
     */
    updateGroupConfig(groupId: string, config: Partial<GroupConfig>): void {
        this.config.groupConfigs[groupId] = {
            ...this.config.groupConfigs[groupId],
            ...config,
        };
        this.saveConfig();
    }

    /**
     * 更新服务侧拉黑缓存并落盘（权威在服务侧；同步失败时调用方不会走到这里）
     */
    setBlocklistCache(users: BlockUser[], syncedAt: string): void {
        this.config.blocklist = { ...this.config.blocklist, users, lastSyncedAt: syncedAt };
        this.saveConfig();
    }

    /**
     * 检查群是否启用（默认启用，除非明确设置为 false）
     */
    isGroupEnabled(groupId: string): boolean {
        return this.config.groupConfigs[groupId]?.enabled !== false;
    }

    // ==================== 统计 ====================

    /**
     * 增加处理计数
     */
    incrementProcessed(): void {
        const today = new Date().toDateString();
        if (this.stats.lastUpdateDay !== today) {
            this.stats.todayProcessed = 0;
            this.stats.lastUpdateDay = today;
        }
        this.stats.todayProcessed++;
        this.stats.processed++;
    }

    // ==================== 工具方法 ====================

    /** 获取运行时长（毫秒） */
    getUptime(): number {
        return Date.now() - this.startTime;
    }

    /** 获取格式化的运行时长 */
    getUptimeFormatted(): string {
        const ms = this.getUptime();
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);

        if (d > 0) return `${d}天${h % 24}小时`;
        if (h > 0) return `${h}小时${m % 60}分钟`;
        if (m > 0) return `${m}分钟${s % 60}秒`;
        return `${s}秒`;
    }
}

/** 导出全局单例 */
export const pluginState = new PluginState();
