/**
 * 服务端机器人配置真源（bot_config）的同步与本地缓存
 *
 * 契约：docs/bot-config-contract.md §2.1/§2.2/§2.6。
 * 启动：读本地 config → POST /config/bots/<selfId>/import（幂等，selfId 取不到就跳过）
 *       → GET /config/bots/<selfId> → 应用并回写本地缓存。
 * 运行中：默认每 300 秒 GET 比对 revision，变了才应用 + 落盘 + 日志。
 * 服务端不可达：完全按本地配置跑（旧行为），只在失败状态变化时打一条 warn，不重试轰炸。
 * 凭据与现有上报链路同源：pluginState.config.kbService。
 */

import type { KbServiceConfig, PluginConfig } from '../types';
import { fetchBotConfig, importBotConfig, putBotConfig } from '../services/kb-client';
import { isTokenPlaceholder, pluginState } from './state';

const DEFAULT_REFRESH_MS = 300000;
const MIN_REFRESH_MS = 30000;
const MAX_REFRESH_MS = 3600000;
/** selfId 是异步取的：启动最多等这么久，等不到就放弃本轮 */
const SELF_ID_WAIT_MS = 30000;

const TIMER_KEY = '__napcatAutoreplyBotConfigTimer';
type TimerHost = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

export interface BotConfigStatus {
    /** 当前生效配置的服务端 revision；从未同步过为 0 */
    revision: number;
    /** server = 已应用服务端版本；local = 按本地配置跑 */
    source: 'server' | 'local';
    /** 最近一次成功同步(ISO) */
    lastSyncAt: string | null;
    /** 最近一次失败原因；null = 最近一次尝试成功 */
    lastError: string | null;
    /** 服务端记录的昵称；页面 nickname 取不到时回退用 */
    serverNickname: string;
}

const status: BotConfigStatus = {
    revision: 0,
    source: 'local',
    lastSyncAt: null,
    lastError: null,
    serverNickname: '',
};

/** 日志兜底：插件上下文未初始化/已卸载时 logger 会抛错，定时任务不能因此中断 */
function log(level: 'info' | 'warn' | 'debug', message: string): void {
    try {
        pluginState.logger[level](message);
    } catch {
        /* eslint-disable no-console */
        if (level === 'warn') console.warn(message);
        else if (level === 'debug') { /* 静默 */ }
        else console.log(message);
        /* eslint-enable no-console */
    }
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function refreshIntervalMs(): number {
    const n = Number(pluginState.config.groupConfigRefreshMs);
    if (!Number.isFinite(n)) return DEFAULT_REFRESH_MS;
    return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(n)));
}

/** /api/status 的 configRevision/configSource 等字段来源 */
export function getBotConfigStatus(): BotConfigStatus {
    return { ...status };
}

/**
 * 把服务端整份配置应用为运行时配置并落盘（回写本地缓存）。
 * 服务端下发的 kbService.token 是掩码：换回本地真值，避免端点保护把同步当未授权改动。
 */
function applyServerConfig(config: Record<string, unknown>, revision: number): boolean {
    const raw = { ...config } as Record<string, unknown>;
    if (isObject(raw.kbService)) {
        const kb = { ...raw.kbService };
        if (isTokenPlaceholder(kb.token)) kb.token = pluginState.config.kbService.token;
        raw.kbService = kb;
    }
    try {
        pluginState.replaceConfig(raw as PluginConfig);
    } catch (err) {
        status.lastError = err instanceof Error ? err.message : String(err);
        log('warn', '[配置] 服务端配置应用失败，按本地配置继续：' + status.lastError);
        return false;
    }
    status.revision = revision;
    status.source = 'server';
    return true;
}

/**
 * 同步一次服务端 bot 配置。
 * @param initial true = 启动首轮，服务端版本无条件应用；false = 定时比对 revision，变了才应用
 */
export async function syncBotConfig(initial = false): Promise<void> {
    const cfg = pluginState.config.kbService;
    // 未配置服务地址/令牌：与旧行为一致，完全按本地配置跑，不打扰
    if (!cfg?.baseUrl || !cfg.token) return;
    // 拿不到 selfId 就跳过，别崩（定时器下一轮还会试）
    const selfId = pluginState.selfId;
    if (!selfId) return;
    try {
        const entry = await fetchBotConfig(cfg, selfId);
        if (!entry) throw new Error('请求失败或响应形状不正确');
        const shouldApply = initial || entry.revision !== status.revision;
        if (shouldApply && !applyServerConfig(entry.config, entry.revision)) {
            throw new Error(status.lastError ?? '服务端配置应用失败');
        }
        if (entry.nickname) status.serverNickname = entry.nickname;
        status.lastSyncAt = new Date().toISOString();
        status.lastError = null;
        if (shouldApply) log('info', '[配置] 从服务端同步 revision=' + entry.revision);
        // 服务端昵称为空而本地有：补写一次（老记录是早期不带昵称的 import 建的）
        if (!entry.nickname && pluginState.nickname) await backfillBotNickname(cfg, selfId);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const firstFailure = status.lastError === null;
        status.lastError = message;
        // 只在失败状态变化时 warn 一条，后续重复失败降级为 debug，不重试轰炸
        if (firstFailure) log('warn', '[配置] 服务端同步失败，按本地配置继续：' + message);
        else log('debug', '[配置] 服务端同步仍失败：' + message);
    }
}

/**
 * 补写服务端昵称：只改 nickname 字段，不动配置内容。
 * 读当前配置 → 原样 PUT，expectedRevision 用刚读到的值防并发覆盖；失败只 warn，下一轮同步再试。
 */
async function backfillBotNickname(cfg: KbServiceConfig, selfId: string): Promise<void> {
    try {
        const entry = await fetchBotConfig(cfg, selfId);
        if (!entry) {
            log('warn', '[配置] 补写服务端昵称失败：读取当前配置失败');
            return;
        }
        if (entry.nickname) return;
        const result = await putBotConfig(cfg, selfId, entry.config, entry.revision, pluginState.nickname);
        if (!result.ok) {
            log('warn', '[配置] 补写服务端昵称失败：' + (result.error ?? 'HTTP ' + result.status));
            return;
        }
        status.serverNickname = pluginState.nickname;
        if (typeof result.revision === 'number') status.revision = result.revision;
        log('info', '[配置] 已补写服务端昵称');
    } catch (err) {
        log('warn', '[配置] 补写服务端昵称异常：' + (err instanceof Error ? err.message : String(err)));
    }
}

/** 启动导入：以本地配置为种子 POST /import（服务端已有记录则原样返回，不覆盖），昵称一并上报 */
async function importLocalConfig(): Promise<void> {
    const cfg = pluginState.config.kbService;
    if (!cfg?.baseUrl || !cfg.token) return;
    const selfId = pluginState.selfId;
    if (!selfId) return;
    try {
        const ok = await importBotConfig(cfg, selfId, pluginState.config, pluginState.nickname);
        if (!ok) log('warn', '[配置] 启动导入失败，继续用本地配置');
    } catch (err) {
        log('warn', '[配置] 启动导入异常：' + (err instanceof Error ? err.message : String(err)));
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearSyncTimer(): void {
    const host = globalThis as TimerHost;
    const timer = host[TIMER_KEY];
    if (timer !== undefined) {
        clearInterval(timer);
        host[TIMER_KEY] = undefined;
    }
}

let generation = 0;

/** 启动（含热重载/配置保存）：先清旧 timer，等 selfId 就绪后导入 + 首轮同步，再建唯一的新 timer */
export function startServerConfigSync(): void {
    clearSyncTimer();
    const gen = ++generation;
    void (async () => {
        const deadline = Date.now() + SELF_ID_WAIT_MS;
        while (!pluginState.selfId && Date.now() < deadline) {
            await sleep(500);
            if (gen !== generation) return;
        }
        if (gen !== generation) return;
        if (pluginState.selfId) {
            await importLocalConfig();
            if (gen !== generation) return;
            await syncBotConfig(true);
            if (gen !== generation) return;
        } else {
            log('warn', '[配置] 未取到 selfId，本轮跳过服务端配置同步');
        }
        const timer = setInterval(() => {
            void syncBotConfig(false);
        }, refreshIntervalMs());
        if (typeof timer.unref === 'function') timer.unref();
        (globalThis as TimerHost)[TIMER_KEY] = timer;
    })();
}

/** plugin_cleanup 调用：清掉定时器，热重载不泄漏 */
export function stopServerConfigSync(): void {
    generation++;
    clearSyncTimer();
}
