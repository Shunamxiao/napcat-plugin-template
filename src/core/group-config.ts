/**
 * 服务端群配置真源（群规则 + 守卫处罚策略）的本地缓存
 *
 * 数据来自 GET /config/groups（x-bot-token），默认每 groupConfigRefreshMs（300s）刷新一次。
 * 生效规则：服务端有该群条目时，mode/missPolicy/atForceReply/keywordOutsideAt/
 * cooldownSeconds/fallbackText/welcomeEnabled/welcomeTemplate 以服务端为准；
 * 无条目回落到本地 groupRules（老字段映射成新口径）。关键词、私聊兜底、延迟仍用本地配置。
 * 拉取失败沿用上次缓存并记一条 warn，启动即拉一次。
 */

import type { GroupMode, GuardConfig, MissPolicy, PluginConfig, ServerGroupConfig } from '../types';
import { fetchGroupConfig } from '../services/kb-client';
import { DEFAULT_GUARD_POLICY } from './guard-penalty';
import {
    DEFAULT_AT_FORCE_REPLY,
    DEFAULT_KEYWORD_OUTSIDE_AT,
    legacyGroupMode,
    legacyMissPolicy,
    resolveGroupDefaultPolicy,
    resolveGroupFallback,
    resolveGroupPolicy,
    type GroupPolicy,
} from './policy';
import { resolveWelcome } from './welcome';
import { pluginState } from './state';

const DEFAULT_REFRESH_MS = 300000;
const MIN_REFRESH_MS = 30000;
const MAX_REFRESH_MS = 3600000;

const TIMER_KEY = '__napcatAutoreplyGroupConfigTimer';
type TimerHost = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

interface GroupConfigCache {
    /** groupId → 服务端条目 */
    groups: Map<string, ServerGroupConfig>;
    /** 服务端处罚策略；null 表示尚未成功同步过 */
    guard: import('../types').GuardPenaltyPolicy | null;
    version: string;
    /** 最近一次成功同步(ISO) */
    lastSyncAt: string | null;
    /** 最近一次尝试(ISO，含失败) */
    lastAttemptAt: string | null;
    lastError: string | null;
}

const cache: GroupConfigCache = {
    groups: new Map(),
    guard: null,
    version: '',
    lastSyncAt: null,
    lastAttemptAt: null,
    lastError: null,
};

/** 日志兜底：插件上下文未初始化/已卸载时 logger 会抛错，定时任务不能因此中断 */
function log(level: 'info' | 'warn', message: string): void {
    try {
        pluginState.logger[level](message);
    } catch {
        /* eslint-disable no-console */
        if (level === 'warn') console.warn(message);
        else console.log(message);
        /* eslint-enable no-console */
    }
}

function refreshIntervalMs(): number {
    const n = Number(pluginState.config.groupConfigRefreshMs);
    if (!Number.isFinite(n)) return DEFAULT_REFRESH_MS;
    return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(n)));
}

/** 服务端某群条目；没有则 null */
export function getServerGroup(groupId: string): ServerGroupConfig | null {
    return cache.groups.get(String(groupId)) ?? null;
}

/** 全部服务端条目（含机器人未加入的群） */
export function getServerGroupConfigs(): ServerGroupConfig[] {
    return Array.from(cache.groups.values());
}

/** 服务端处罚策略；null 表示尚未成功同步（此时用本地兜底） */
export function getServerGuardPolicy(): import('../types').GuardPenaltyPolicy | null {
    return cache.guard ? { ...cache.guard } : null;
}

/**
 * 守卫处罚策略：服务端同步成功用服务端，否则用本地兜底默认值。
 * 本地 guard.warnText 作为未同步时的警告文案兜底。
 */
export function resolveGuardPolicy(local?: GuardConfig): import('../types').GuardPenaltyPolicy {
    if (cache.guard) return { ...cache.guard };
    return {
        ...DEFAULT_GUARD_POLICY,
        warnText: typeof local?.warnText === 'string' ? local.warnText : DEFAULT_GUARD_POLICY.warnText,
    };
}

/** 该群是否被管理：服务端有条目，或本地 groupRules 里有条目 */
export function isGroupManaged(config: PluginConfig, groupId: string): boolean {
    return cache.groups.has(String(groupId)) || config.groupRules?.[String(groupId)] !== undefined;
}

/**
 * 某群的生效口径：服务端条目 → 本地 groupRules → 全局 groupDefault。
 * 永远返回口径（未配置群走 groupDefault），调用方不再需要判空。
 */
export function resolveEffectiveGroupPolicy(config: PluginConfig, groupId: string): GroupPolicy {
    const id = String(groupId);
    const server = cache.groups.get(id);
    if (server) {
        // 新服务端一定下发 mode/missPolicy；老服务端只有旧字段，按同一套规则在内存里映射。
        const mode: GroupMode = server.mode ?? legacyGroupMode(server.enabled, server.atOnly);
        const missPolicy: MissPolicy = server.missPolicy ?? legacyMissPolicy(server.aiEnabled);
        return {
            mode: { value: mode, source: 'server' },
            missPolicy: { value: missPolicy, source: 'server' },
            atForceReply: { value: server.atForceReply ?? DEFAULT_AT_FORCE_REPLY, source: 'server' },
            keywordOutsideAt: { value: server.keywordOutsideAt ?? DEFAULT_KEYWORD_OUTSIDE_AT, source: 'server' },
        };
    }
    if (config.groupRules?.[id] !== undefined) return resolveGroupPolicy(config, id);
    return resolveGroupDefaultPolicy(config);
}

/**
 * 某群生效的规则冷却秒数：服务端群级值优先；未配置群用 groupDefault.cooldownSeconds；
 * 其余跟随全局。负数/非数字视为未配置，避免坏缓存把冷却关掉。
 */
export function resolveEffectiveGroupCooldown(config: PluginConfig, groupId: string): number {
    const id = String(groupId);
    const value = cache.groups.get(id)?.cooldownSeconds;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    // groupDefault 只对「服务端无条目且本地无群规则」的群生效
    if (!cache.groups.has(id) && config.groupRules?.[id] === undefined) {
        const own = config.groupDefault?.cooldownSeconds;
        if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own;
    }
    const global = Number(config.cooldownSeconds);
    return Number.isFinite(global) && global > 0 ? global : 0;
}

/**
 * 某群生效的兜底文案：服务端 fallbackText（非空）优先，
 * 否则本地群级 → groupDefault（未配置群）→ 全局 fallback.groupAtText。
 */
export function resolveEffectiveGroupFallback(config: PluginConfig, groupId: string): string {
    const id = String(groupId);
    const server = cache.groups.get(id);
    const own = typeof server?.fallbackText === 'string' ? server.fallbackText.trim() : '';
    if (own) return own;
    if (config.groupRules?.[id] !== undefined) {
        return resolveGroupFallback(config, id).groupAtText;
    }
    const fallback = config.groupDefault?.fallbackText;
    if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    return config.fallback?.groupAtText ?? '';
}

export interface EffectiveWelcome {
    enabled: boolean;
    template: string;
    source: 'server' | 'group' | 'global';
}

/**
 * 某群的入群欢迎：服务端条目优先（welcomeEnabled / welcomeTemplate），
 * 否则沿用本地群级覆盖 → 全局配置。模板为空时回落到 groupWelcome.template。
 */
export function resolveGroupWelcome(config: PluginConfig, groupId: string): EffectiveWelcome {
    const id = String(groupId);
    const server = cache.groups.get(id);
    if (server) {
        const fallback = String(config.groupWelcome?.template ?? '').trim();
        return {
            enabled: server.welcomeEnabled,
            template: (server.welcomeTemplate ?? '').trim() || fallback,
            source: 'server',
        };
    }
    const rule = config.groupRules?.[id];
    const resolved = resolveWelcome(rule?.welcome, config.groupWelcome);
    return { ...resolved, source: rule?.welcome ? 'group' : 'global' };
}

/** 已管理群（服务端 + 本地）的生效口径表，供 WebUI 展示值来源 */
export function buildEffectiveGroupPolicies(config: PluginConfig): Record<string, GroupPolicy> {
    const out: Record<string, GroupPolicy> = {};
    for (const groupId of cache.groups.keys()) {
        out[groupId] = resolveEffectiveGroupPolicy(config, groupId) as GroupPolicy;
    }
    for (const groupId of Object.keys(config.groupRules ?? {})) {
        if (!(groupId in out)) {
            out[groupId] = resolveGroupPolicy(config, groupId);
        }
    }
    return out;
}

/** PUT 成功后把服务端返回的条目写进缓存 */
export function applyServerGroupEntry(entry: ServerGroupConfig): void {
    if (!entry?.groupId) return;
    cache.groups.set(String(entry.groupId), { ...entry, groupId: String(entry.groupId) });
}

/** PUT 成功后把服务端返回的策略写进缓存 */
export function applyServerGuardPolicy(policy: import('../types').GuardPenaltyPolicy): void {
    cache.guard = { ...policy };
}

export interface GroupConfigStatus {
    synced: boolean;
    version: string;
    lastSyncAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    groupCount: number;
}

export function getGroupConfigStatus(): GroupConfigStatus {
    return {
        synced: cache.lastSyncAt !== null,
        version: cache.version,
        lastSyncAt: cache.lastSyncAt,
        lastAttemptAt: cache.lastAttemptAt,
        lastError: cache.lastError,
        groupCount: cache.groups.size,
    };
}

/**
 * 立即同步一次服务端群配置。
 * 未配置地址/令牌时静默跳过；失败保留旧缓存并记一行 warn，绝不抛错。
 */
export async function syncGroupConfig(): Promise<void> {
    cache.lastAttemptAt = new Date().toISOString();
    try {
        const cfg = pluginState.config.kbService;
        if (!cfg?.baseUrl || !cfg.token) {
            cache.lastError = '未配置服务地址或令牌';
            pluginState.logger.debug('[群配置] 未配置 kbService 地址/令牌，跳过同步');
            return;
        }
        const payload = await fetchGroupConfig(cfg);
        if (!payload) {
            cache.lastError = '请求失败或响应形状不正确';
            log('warn', '[群配置] 同步失败，继续使用缓存（群 ' + cache.groups.size + ' 条）');
            return;
        }
        const next = new Map<string, ServerGroupConfig>();
        for (const entry of payload.groups) next.set(entry.groupId, entry);
        cache.groups = next;
        if (payload.guard) cache.guard = payload.guard;
        cache.version = payload.version;
        cache.lastSyncAt = new Date().toISOString();
        cache.lastError = null;
        log('info', '[群配置] 同步完成：群 ' + next.size + ' 条，版本 ' + (payload.version || '-'));
    } catch (err) {
        cache.lastError = err instanceof Error ? err.message : String(err);
        log('warn', '[群配置] 同步异常：' + cache.lastError);
    }
}

function clearSyncTimer(): void {
    const host = globalThis as TimerHost;
    const timer = host[TIMER_KEY];
    if (timer !== undefined) {
        clearInterval(timer);
        host[TIMER_KEY] = undefined;
    }
}

/** 启动（含热重载/配置保存）：先清旧 timer，立即同步一次，再建唯一的新 timer */
export function startGroupConfigSync(): void {
    clearSyncTimer();
    void syncGroupConfig();

    const timer = setInterval(() => {
        void syncGroupConfig();
    }, refreshIntervalMs());
    if (typeof timer.unref === 'function') timer.unref();
    (globalThis as TimerHost)[TIMER_KEY] = timer;

    log('info', '[群配置] 定时刷新已启动（间隔 ' + Math.round(refreshIntervalMs() / 1000) + 's）');
}

/** plugin_cleanup 调用：清掉定时器，热重载不泄漏 */
export function stopGroupConfigSync(): void {
    clearSyncTimer();
}
