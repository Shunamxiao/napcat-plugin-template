/**
 * NapCat 插件模板 - 主入口
 *
 * 导出 PluginModule 接口定义的生命周期函数，NapCat 加载插件时会调用这些函数。
 *
 * 生命周期：
 *   plugin_init        → 插件加载时调用（必选）
 *   plugin_onmessage   → 收到事件时调用（需通过 post_type 判断事件类型）
 *   plugin_onevent     → 收到所有 OneBot 事件时调用
 *   plugin_cleanup     → 插件卸载/重载时调用
 *
 * 配置相关：
 *   plugin_config_ui          → 导出配置 Schema，用于 WebUI 自动生成配置面板
 *   plugin_get_config         → 自定义配置读取
 *   plugin_set_config         → 自定义配置保存
 *   plugin_on_config_change   → 配置变更回调
 *
 * @author Your Name
 * @license MIT
 */

import type {
    PluginModule,
    PluginConfigSchema,
    NapCatPluginContext,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';

import { DEFAULT_CONFIG, buildConfigSchema, groupRulesToText, idListToText, keywordsToText, textToGroupRules, textToIdList, textToKeywords, textToLines, type ConfigSchemaSummary } from './config';
import { maskConfig, pluginState } from './core/state';
import { buildEffectiveGroupPolicies, getGroupConfigStatus, getServerGroupConfigs, resolveEffectiveGroupPolicy, startGroupConfigSync, stopGroupConfigSync } from './core/group-config';
import { clearGuardPenalty } from './core/guard-penalty';
import { startServerConfigSync, stopServerConfigSync } from './core/server-config';
import { hitLog } from './core/hit-log';
import { startHandoffCleanup, stopHandoffCleanup } from './core/handoff';
import { initKeywordStats, shutdownKeywordStats } from './core/keyword-stats';
import { startKeywordReport, stopKeywordReport } from './core/keyword-report';
import { startTrafficReport, stopTrafficReport } from './core/traffic-stats';
import { startBlocklistSync, stopBlocklistSync } from './core/blocklist';
import { startGuardWordsSync, stopGuardWordsSync } from './core/guard-words';
import { clearPrivateGuide, clearPrivateMerge, handleMessage } from './handlers/message-handler';
import { handleOneBotEvent } from './handlers/event-handler';
import { registerApiRoutes } from './services/api-service';
import type { PluginConfig } from './types';

// ==================== 配置 UI Schema ====================

/** NapCat WebUI 读取此导出来展示配置面板 */
export let plugin_config_ui: PluginConfigSchema = [];

// ==================== 生命周期函数 ====================

/**
 * 插件初始化（必选）
 * 加载配置、注册 WebUI 路由和页面
 */
export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
    try {
        // 1. 初始化全局状态（加载配置）
        pluginState.init(ctx);

        ctx.logger.info('插件初始化中...');

        // 关键词命中统计：路径从数据目录解析，日志打出绝对路径便于排障
        const keywordStatsFile = pluginState.getDataFilePath('keyword-stats.json');
        initKeywordStats(keywordStatsFile);
        ctx.logger.info(`关键词命中统计文件: ${keywordStatsFile}`);
        startHandoffCleanup(pluginState.getDataFilePath('handoff.jsonl'));

        // 2. 生成配置 Schema（用于 NapCat WebUI 配置面板）
        // 原生扩展页只保留老字段 + 只读摘要；React 插件页是唯一编辑入口
        plugin_config_ui = buildConfigSchema(ctx, buildSchemaSummary());

        // 3. 注册 WebUI 页面和静态资源
        registerWebUI(ctx);

        // 4. 注册 API 路由
        registerApiRoutes(ctx);

        // 5. 拉黑名单：先拉一次，之后按 syncSeconds 定时拉取
        startBlocklistSync();
        // 6. 服务侧守卫词表：启动拉一次，之后按 guard.wordsRefreshMs 刷新
        startGuardWordsSync();
        // 7. 服务端群配置 + 守卫处罚策略：启动拉一次，之后按 groupConfigRefreshMs 刷新
        startGroupConfigSync();
        // 7.5 服务端 bot 配置（bot_config 真源）：启动导入 + 首轮同步，之后按 groupConfigRefreshMs 比对 revision
        startServerConfigSync();
        // 8. 关键词命中统计：定时上报服务端，供报表统计零命中规则
        startKeywordReport();
        // 9. 流量计数：每 5 分钟批量上报 /stats/traffic
        startTrafficReport();

        // 群配置同步是异步的：同步完成后刷新原生页摘要（模式分布 / 上次同步时间）
        clearTimeout(pluginState.timers.get('schema-summary'));
        const schemaTimer = setTimeout(() => {
            pluginState.timers.delete('schema-summary');
            try {
                plugin_config_ui = buildConfigSchema(ctx, buildSchemaSummary());
            } catch (e) {
                ctx.logger.debug(`刷新配置摘要失败: ${e instanceof Error ? e.message : String(e)}`);
            }
        }, 3000);
        if (typeof schemaTimer.unref === 'function') schemaTimer.unref();
        pluginState.timers.set('schema-summary', schemaTimer);

        ctx.logger.info('插件初始化完成');
    } catch (error) {
        ctx.logger.error('插件初始化失败:', error);
    }
};

/**
 * 消息/事件处理（可选）
 * 收到事件时调用，需通过 post_type 判断是否为消息事件
 */
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    // 仅处理消息事件
    if (event.post_type !== EventType.MESSAGE) return;
    await handleMessage(ctx, event);
};

/**
 * 事件处理（可选）
 * 处理所有 OneBot 事件（通知、请求等）
 */
export const plugin_onevent: PluginModule['plugin_onevent'] = async (ctx, event) => {
    try {
        // 入群欢迎、好友申请自动通过；均由独立配置控制，不受自动回复总开关影响
        await handleOneBotEvent(ctx, event);
    } catch (e) {
        ctx.logger.error('非消息事件处理失败:', e);
    }
};

/**
 * 插件卸载/重载（可选）
 * 必须清理定时器、关闭连接等资源
 */
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        // 先停同步/清理定时器，再清理插件状态（热重载不泄漏）
        stopBlocklistSync();
        stopGuardWordsSync();
        stopGroupConfigSync();
        stopServerConfigSync();
        stopKeywordReport();
        stopTrafficReport();
        stopHandoffCleanup();
        clearGuardPenalty();
        hitLog.clear();
        clearPrivateMerge();
        clearPrivateGuide();
        // 取消防抖并立即落盘，正常卸载不丢最后一个窗口的命中
        shutdownKeywordStats();
        pluginState.cleanup();
        ctx.logger.info('插件已卸载');
    } catch (e) {
        ctx.logger.warn('插件卸载时出错:', e);
    }
};

// ==================== 配置管理钩子 ====================

/** 获取当前配置 */
export const plugin_get_config: PluginModule['plugin_get_config'] = async (_ctx) => {
    // 出口一律打码：真 token 只留在磁盘配置与请求头里，不进任何响应
    const cfg = maskConfig(pluginState.config);
    return {
        ...cfg,
        keywordsText: keywordsToText(cfg.keywords),
        groupRulesText: groupRulesToText(cfg.groupRules),
        groupPolicies: buildEffectiveGroupPolicies({ ...pluginState.config, ...cfg }),
        private: { ...cfg.private, whitelistText: idListToText(cfg.private.whitelist) },
        group: { ...cfg.group, whitelistText: idListToText(cfg.group.whitelist) },
        blacklistText: idListToText(cfg.blacklist),
        guard: {
            ...cfg.guard,
            groupIdsText: idListToText(cfg.guard.groupIds),
            wordsText: (cfg.guard.words ?? []).join('\n'),
        },
    };
};

/** 设置配置（完整替换，由 NapCat WebUI 调用） */
export const plugin_set_config: PluginModule['plugin_set_config'] = async (ctx, config) => {
    const cfg = { ...(config as PluginConfig) };
    if (typeof cfg.keywordsText === 'string' && cfg.keywordsText.trim()) {
        // WebUI 提交了编辑后的规则文本 → 解析回结构化数组
        const parsed = textToKeywords(cfg.keywordsText);
        if (parsed.length > 0) cfg.keywords = parsed;
        else cfg.keywordsText = keywordsToText(Array.isArray(cfg.keywords) ? cfg.keywords : []);
    } else {
        // 文本缺失(如外部 API 直接改 keywords) → 从规则反推文本
        cfg.keywordsText = keywordsToText(Array.isArray(cfg.keywords) ? cfg.keywords : []);
    }
    // 白名单/黑名单:文本存在则解析回数组,否则从数组反推文本(与 keywordsText 同一双向同步模式)
    const syncList = (list: (number | string)[], text: string | undefined): { list: (number | string)[]; text: string } => {
        if (typeof text === 'string' && text.trim()) return { list: textToIdList(text), text };
        return { list, text: idListToText(list) };
    };
    const p = syncList(cfg.private?.whitelist ?? [], cfg.private?.whitelistText);
    const g = syncList(cfg.group?.whitelist ?? [], cfg.group?.whitelistText);
    const b = syncList(cfg.blacklist ?? [], cfg.blacklistText);
    cfg.private = { ...(cfg.private ?? DEFAULT_CONFIG.private), whitelist: p.list, whitelistText: p.text };
    // 原生面板没有引导字段：未提交时沿用当前值，避免一次保存把引导配置重置成默认
    if (!cfg.private.guide) cfg.private.guide = pluginState.config.private.guide;
    cfg.group = { ...(cfg.group ?? DEFAULT_CONFIG.group), whitelist: g.list, whitelistText: g.text };
    cfg.blacklist = b.list;
    cfg.blacklistText = b.text;
    // 忽略发送者：文本存在则解析回数组，否则从数组反推文本
    const ig = syncList(cfg.ignoreSenders ?? pluginState.config.ignoreSenders ?? [], cfg.ignoreSendersText);
    cfg.ignoreSenders = ig.list.map(String);
    cfg.ignoreSendersText = ig.text;

    // 群内容守卫：群号/屏蔽词同样保持「文本优先，否则由数组反推」的双向同步
    if (cfg.guard) {
        const syncLines = (list: unknown, text: unknown): { list: string[]; text: string } => {
            if (typeof text === 'string') return { list: textToLines(text), text };
            const values = Array.isArray(list) ? list.map(String).map((s) => s.trim()).filter(Boolean) : [];
            return { list: values, text: values.join('\n') };
        };
        const gids = syncLines(cfg.guard.groupIds, cfg.guard.groupIdsText);
        const words = syncLines(cfg.guard.words, cfg.guard.wordsText);
        // 老页面没提交刷新间隔时沿用当前值，避免一次保存把 5 分钟重置成默认值
        const refreshMs = cfg.guard.wordsRefreshMs ?? pluginState.config.guard.wordsRefreshMs;
        cfg.guard = { ...cfg.guard, groupIds: gids.list, groupIdsText: gids.text, words: words.list, wordsText: words.text, wordsRefreshMs: refreshMs };
    } else {
        cfg.guard = pluginState.config.guard;
    }

    // 群级规则:合法 JSON 文本覆盖结构化规则;非法文本忽略,且不丢失已有规则
    const parsedGroupRules = textToGroupRules(cfg.groupRulesText);
    if (parsedGroupRules) {
        cfg.groupRules = parsedGroupRules;
    } else if (cfg.groupRules === undefined) {
        cfg.groupRules = pluginState.config.groupRules ?? {};
    }
    cfg.groupRulesText = groupRulesToText(cfg.groupRules);

    // 知识库相关配置块：老页面/原生面板没提交时沿用当前值，避免一次保存把配置清空
    if (!cfg.kbService) cfg.kbService = pluginState.config.kbService;
    // 群默认策略只有 React 页提交；原生面板保存时沿用当前值，不能被重置成默认
    if (!cfg.groupDefault) cfg.groupDefault = pluginState.config.groupDefault;
    if (!cfg.aiTrigger) cfg.aiTrigger = pluginState.config.aiTrigger;
    if (!cfg.blocklist) cfg.blocklist = pluginState.config.blocklist;
    if (!cfg.fallback) cfg.fallback = pluginState.config.fallback;
    if (!cfg.collect) cfg.collect = pluginState.config.collect;
    else if (!Array.isArray(cfg.collect.questions)) cfg.collect.questions = pluginState.config.collect.questions;
    if (!cfg.relay) cfg.relay = pluginState.config.relay;
    if (!cfg.sendGuard) cfg.sendGuard = pluginState.config.sendGuard;
    if (!cfg.loopGuard) cfg.loopGuard = pluginState.config.loopGuard;

    pluginState.replaceConfig(cfg);
    // 原生页摘要可能已变化（关键词条数/模式分布），保存后立即重建
    try {
        plugin_config_ui = buildConfigSchema(ctx, buildSchemaSummary());
    } catch { /* 摘要刷新失败不影响保存 */ }
    // 刷新间隔/服务地址可能刚被改过：重启词表定时器并立即同步一次
    startGuardWordsSync();
    startGroupConfigSync();
    ctx.logger.info('配置已通过 WebUI 更新, 当前规则数:', Array.isArray(cfg.keywords) ? cfg.keywords.length : 0);
};

/**
 * 配置变更回调
 * 当 WebUI 中修改单个配置项时触发（需配置项标记 reactive: true）
 */
export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
    ctx, _ui, key, value, _currentConfig
) => {
    try {
        pluginState.updateConfig({ [key]: value });
        ctx.logger.debug(`配置项 ${key} 已更新`);
    } catch (err) {
        ctx.logger.error(`更新配置项 ${key} 失败:`, err);
    }
};

// ==================== 内部函数 ====================

/** 原生扩展页只读摘要：模式分布 / 关键词条数 / 上次同步时间 */
function buildSchemaSummary(): ConfigSchemaSummary {
    const config = pluginState.config;
    const groupModes = { all: 0, at: 0, off: 0 };
    const ids = new Set<string>();
    for (const entry of getServerGroupConfigs()) ids.add(entry.groupId);
    for (const groupId of Object.keys(config.groupRules ?? {})) ids.add(groupId);
    for (const groupId of ids) {
        groupModes[resolveEffectiveGroupPolicy(config, groupId).mode.value] += 1;
    }
    return {
        groupModes,
        keywordCount: config.keywords?.length ?? 0,
        lastSyncAt: getGroupConfigStatus().lastSyncAt,
    };
}

/**
 * 注册 WebUI 页面和静态资源
 */

function registerWebUI(ctx: NapCatPluginContext): void {
    const router = ctx.router;

    // 托管前端静态资源（构建产物在 webui/ 目录下）
    // 访问路径: /plugin/<plugin-id>/files/static/
    router.static('/static', 'webui');

    // 注册配置页：与 dashboard 共用同一套 React 产物（settings.html 时代已结束）
    // 访问路径: /plugin/<plugin-id>/page/settings
    router.page({
        path: 'settings',
        title: '自动回复配置',
        htmlFile: 'webui/index.html',
        description: '本账号私聊/群聊/关键词规则配置页',
    });

    router.page({
        path: 'dashboard',
        title: '插件仪表盘',
        htmlFile: 'webui/index.html',
        description: '插件管理控制台',
    });

    ctx.logger.debug('WebUI 路由注册完成');
}

// ==================== 纯逻辑导出（仅 test/escalation.mjs 使用） ====================
// 不参与插件生命周期；NapCat 只读取上面约定的钩子。
export { isBlocked, syncBlocklist, startBlocklistSync, stopBlocklistSync } from './core/blocklist';
export { syncGuardWords, startGuardWordsSync, stopGuardWordsSync } from './core/guard-words';
export { pickReply, planReply, resolveSend } from './core/escalation';
export { isGroupConfigured, resolveGroupPolicy, resolveGroupDefaultPolicy, resolveGroupFallback, buildGroupPolicies, legacyGroupMode, legacyMissPolicy, DEFAULT_GROUP_DEFAULT } from './core/policy';
export { GuardPenaltyCounter, applyGuardPenalty, clearGuardPenalty, DEFAULT_GUARD_POLICY, guardPenaltyCounter } from './core/guard-penalty';
export { HitLog, hitLog } from './core/hit-log';
export { resolveGroupWelcome, resolveEffectiveGroupPolicy, resolveEffectiveGroupCooldown, resolveEffectiveGroupFallback, isGroupManaged, buildEffectiveGroupPolicies, getServerGroup, getServerGroupConfigs, applyServerGroupEntry, applyServerGuardPolicy, getServerGuardPolicy, resolveGuardPolicy, syncGroupConfig, startGroupConfigSync, stopGroupConfigSync, getGroupConfigStatus } from './core/group-config';
export { parseEnvFile, readAdminCredentials, putServerGroup, putServerGuardPolicy, getServerGuardPolicy as getServerGuardPolicyRemote } from './services/admin-client';
export { appendHandoffRecord, pruneHandoffFile, startHandoffCleanup, stopHandoffCleanup } from './core/handoff';
export { classifySendError, sendWithRetry, MIN_RETRY_DELAY_MS } from './core/send-retry';
export { SendGuard } from './core/send-guard';
export { LoopGuard } from './core/loop-guard';
export { matchGuardWord, runGroupGuard, guardTargetsGroup, mergeGuardWords } from './core/content-guard';
export { rememberSentMessage, isSentByThisInstance, clearSentMessages } from './core/sent-messages';
export { beginCollect, clearCollect, collectKey, getCollect, stepCollect, COLLECT_TIMEOUT_MS } from './core/collect';
export { keywordsToText, textToKeywords } from './config';
export { initKeywordStats, recordKeywordHit, snapshotKeywordStats, resetKeywordStats, flushKeywordStats, shutdownKeywordStats, keywordStatKey } from './core/keyword-stats';
export { buildKeywordReport, reportKeywordStatsOnce, startKeywordReport, stopKeywordReport } from './core/keyword-report';
export { hourBucket, recordTrafficIncoming, recordTrafficReply, recordTrafficRuleHit, snapshotTraffic, buildTrafficPayload, commitTrafficReport, resetTraffic, reportTrafficOnce, startTrafficReport, stopTrafficReport } from './core/traffic-stats';
export { buildWelcomeMessage, resolveWelcome, renderWelcomeTemplate } from './handlers/event-handler';
export { handleMessage, resolveImageSource, sendRelayMessage, clearPrivateMerge, clearPrivateGuide, SERVICE_DOWN_REPLY } from './handlers/message-handler';
export { registerApiRoutes, fromSameOrigin } from './services/api-service';
export { fetchGroupConfig } from './services/kb-client';
export { notifyHandoff, askServiceOutcome, fetchGuardWords } from './services/kb-client';
export { sanitizeConfig, pluginState, applyConfigPatch } from './core/state';
export { syncBotConfig, startServerConfigSync, stopServerConfigSync, getBotConfigStatus } from './core/server-config';
export { fetchBotConfig, importBotConfig, listServerBots, putBotConfig } from './services/kb-client';
