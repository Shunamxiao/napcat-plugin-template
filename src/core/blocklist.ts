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

let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 立即同步一次。
 * 未配置地址/令牌时静默跳过；请求失败保留旧缓存并记 warn，绝不抛错。
 */
export async function syncBlocklist(): Promise<void> {
    const cfg = pluginState.config.kbService;
    if (!cfg?.baseUrl || !cfg.token) return;

    const users = await fetchBlocklist(cfg);
    if (!users) {
        pluginState.logger.warn('[拉黑] 同步失败，继续使用本地缓存 ' + pluginState.config.blocklist.users.length + ' 条');
        return;
    }
    pluginState.setBlocklistCache(sanitizeBlockUsers(users), new Date().toISOString());
    pluginState.logger.info('[拉黑] 同步完成，共 ' + users.length + ' 条');
}

/** plugin_init 调用：先拉一次，再按 syncSeconds 定时拉取 */
export function startBlocklistSync(): void {
    stopBlocklistSync();
    void syncBlocklist();
    const seconds = Math.max(30, Number(pluginState.config.blocklist?.syncSeconds) || 300);
    syncTimer = setInterval(() => {
        void syncBlocklist();
    }, seconds * 1000);
    // 定时器不阻止进程退出
    if (typeof syncTimer.unref === 'function') syncTimer.unref();
}

/** plugin_cleanup 调用：清掉定时器，热重载不泄漏 */
export function stopBlocklistSync(): void {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
}
