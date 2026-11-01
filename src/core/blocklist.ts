/**
 * 服务侧拉黑名单的本地缓存 + 定时同步
 *
 * 权威在服务侧（GET /blocklist），本地只做缓存：命中的用户在消息处理最前面短路，
 * 不发任何回复。同步失败保留旧缓存，不影响原有自动回复。
 */

import { fetchBlocklist } from '../services/kb-client';
import { pluginState, sanitizeBlockUsers } from './state';

/** 纯函数判定；users 为空时恒 false */
export function isBlocked(userId: string, users: unknown): boolean {
    const id = String(userId ?? '').trim();
    if (!id || !Array.isArray(users)) return false;
    return users.some((u) => {
        const item = u as { userId?: unknown } | null;
        return String(item?.userId ?? '') === id;
    });
}

/**
 * 定时器挂在 globalThis 上，而不是模块级变量：
 * HMR 热重载会重建模块实例，旧实例的模块级变量拿不到，clearInterval 就会漏掉旧 timer。
 * 只有进程退出才会丢，正好符合「进程内只允许一个同步定时器」的要求。
 */
const TIMER_KEY = '__napcatAutoreplyBlocklistTimer';
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

/**
 * 立即同步一次。
 * 未配置地址/令牌时静默跳过；请求失败保留旧缓存并记 warn，绝不抛错。
 */
export async function syncBlocklist(): Promise<void> {
    try {
        const cfg = pluginState.config.kbService;
        if (!cfg?.baseUrl || !cfg.token) return;

        const users = await fetchBlocklist(cfg);
        if (!users) {
            log('warn', '[拉黑] 同步失败，继续使用本地缓存 ' + pluginState.config.blocklist.users.length + ' 条');
            return;
        }
        pluginState.setBlocklistCache(sanitizeBlockUsers(users), new Date().toISOString());
        log('info', '[拉黑] 同步完成，共 ' + users.length + ' 条');
    } catch (err) {
        log('warn', '[拉黑] 同步异常：' + (err instanceof Error ? err.message : String(err)));
    }
}

/** 启动（含热重载）：先清掉可能残留的旧定时器，立即同步一次，再建唯一的新定时器 */
export function startBlocklistSync(): void {
    clearSyncTimer();
    void syncBlocklist();

    const seconds = Math.max(30, Number(pluginState.config.blocklist?.syncSeconds) || 300);
    const timer = setInterval(() => {
        void syncBlocklist();
    }, seconds * 1000);
    // 定时器不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
    (globalThis as TimerHost)[TIMER_KEY] = timer;

    log('info', '[拉黑] 定时同步已启动（间隔 ' + seconds + 's），已立即同步一次');
}

/** plugin_cleanup 调用：清掉定时器，热重载不泄漏 */
export function stopBlocklistSync(): void {
    clearSyncTimer();
}
