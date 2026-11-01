/**
 * 群守卫服务词表的本地缓存 + 定时刷新
 *
 * 服务侧权威词表在 GET /blocklist 的 words 字段；本地 guard.words 作为叠加兜底，
 * 两处任一命中都会触发既有动作（recall | warn | both）。
 * 拉取失败保留上一次成功缓存，首次失败保持空词表（宁漏勿错）。
 */

import { fetchGuardWords } from '../services/kb-client';
import { pluginState } from './state';

const DEFAULT_REFRESH_MS = 300000;
const MIN_REFRESH_MS = 1000;
const MAX_REFRESH_MS = 86400000;

/**
 * 定时器挂在 globalThis 上：HMR 会重建模块实例，模块级变量清不到旧 timer。
 * 进程内只允许一个词表刷新定时器。
 */
const TIMER_KEY = '__napcatAutoreplyGuardWordsTimer';
type TimerHost = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

function clearSyncTimer(): void {
    const host = globalThis as TimerHost;
    const timer = host[TIMER_KEY];
    if (timer !== undefined) {
        clearInterval(timer);
        host[TIMER_KEY] = undefined;
    }
}

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

/** 刷新间隔：默认 5 分钟，夹在 [1s, 24h]，坏值回退默认 */
function refreshIntervalMs(): number {
    const n = Number(pluginState.config.guard?.wordsRefreshMs);
    if (!Number.isFinite(n)) return DEFAULT_REFRESH_MS;
    return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(n)));
}

/**
 * 立即同步一次服务词表。
 * 未配置地址/令牌时静默跳过；失败保留旧缓存并记一行 warn，绝不抛错。
 */
export async function syncGuardWords(): Promise<void> {
    try {
        const cfg = pluginState.config.kbService;
        if (!cfg?.baseUrl || !cfg.token) {
            pluginState.logger.debug('[守卫] 未配置 kbService 地址/令牌，跳过词表同步');
            return;
        }

        const words = await fetchGuardWords(cfg);
        if (!words) {
            log('warn', '[守卫] 词表同步失败，继续使用缓存 ' + pluginState.serviceGuardWords.length + ' 条');
            return;
        }
        pluginState.serviceGuardWords = words;
        log('info', '[守卫] 词表同步完成，服务词 ' + words.length + ' 条（本地 ' + (pluginState.config.guard.words?.length ?? 0) + ' 条）');
    } catch (err) {
        log('warn', '[守卫] 词表同步异常：' + (err instanceof Error ? err.message : String(err)));
    }
}

/** 启动（含热重载/配置保存）：先清旧 timer，立即同步一次，再建唯一的新 timer */
export function startGuardWordsSync(): void {
    clearSyncTimer();
    void syncGuardWords();

    const timer = setInterval(() => {
        void syncGuardWords();
    }, refreshIntervalMs());
    // 定时器不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
    (globalThis as TimerHost)[TIMER_KEY] = timer;

    log('info', '[守卫] 词表定时刷新已启动（间隔 ' + Math.round(refreshIntervalMs() / 1000) + 's）');
}

/** plugin_cleanup 调用：清掉定时器，热重载不泄漏 */
export function stopGuardWordsSync(): void {
    clearSyncTimer();
}
