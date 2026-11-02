/**
 * 关键词命中统计上报 — 定时把「命中快照 + 当前规则表」POST 到服务端
 *
 * 上报口径：
 * - 已命中的 key 带真实 count / lastAt；
 * - 当前启用但零命中的规则以 count=0 上报，服务端据此列出「零命中规则」；
 * - 停用规则、群级被覆盖后已不生效的全局规则不参与判断（群级规则按自身表上报）。
 * 失败只记 warn 并等下一轮，不影响消息链路；未配置服务地址/令牌时静默跳过。
 */

import { pluginState } from './state';
import { keywordStatKey, snapshotKeywordStats, type KeywordStats } from './keyword-stats';
import { reportKeywordStats as postKeywordStats } from '../services/kb-client';
import type { KeywordRule, PluginConfig } from '../types';

export interface KeywordReportItem {
    key: string;
    count: number;
    lastAt: string;
}

const REPORT_INTERVAL_MS = 300000;

/**
 * 定时器挂在 globalThis 上：HMR 热重载会重建模块实例，
 * 模块级变量拿不到旧 timer，clearInterval 就会漏掉。
 */
const TIMER_KEY = '__napcatAutoreplyKeywordReportTimer';
type TimerHost = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

/** 同一条失败只刷一次 warn，避免服务端未升级时每 5 分钟刷屏 */
let warned = false;

function log(level: 'info' | 'warn', message: string): void {
    try {
        pluginState.logger[level](message);
    } catch {
        console[level](message);
    }
}

function clearTimer(): void {
    const host = globalThis as TimerHost;
    const timer = host[TIMER_KEY];
    if (timer !== undefined) {
        clearInterval(timer);
        host[TIMER_KEY] = undefined;
    }
}

/** 全局规则 + 各群自身定义的规则（群级非空时替代全局，但两类都算「当前规则表」） */
function collectRules(config: PluginConfig): KeywordRule[] {
    const rules: KeywordRule[] = [...(config.keywords ?? [])];
    for (const rule of Object.values(config.groupRules ?? {})) {
        if (Array.isArray(rule?.keywords) && rule.keywords.length > 0) rules.push(...rule.keywords);
    }
    return rules;
}

/** 合并命中快照与规则表；纯函数，便于单测。 */
export function buildKeywordReport(
    config: PluginConfig,
    stats: KeywordStats = snapshotKeywordStats(),
): KeywordReportItem[] {
    const items: KeywordReportItem[] = [];
    const seen = new Set<string>();
    for (const [key, entry] of Object.entries(stats)) {
        items.push({ key, count: entry.count, lastAt: entry.lastAt });
        seen.add(key);
    }
    for (const rule of collectRules(config)) {
        if (rule.enabled === false) continue;
        const key = keywordStatKey(rule);
        if (key === '|contains' || seen.has(key)) continue;
        items.push({ key, count: 0, lastAt: '' });
        seen.add(key);
    }
    return items;
}

/** 立即上报一次；未配置/无数据/失败返回 false，绝不抛错。 */
export async function reportKeywordStatsOnce(): Promise<boolean> {
    try {
        const cfg = pluginState.config.kbService;
        if (!cfg?.baseUrl || !cfg.token) return false;
        const items = buildKeywordReport(pluginState.config);
        if (items.length === 0) return false;
        const ok = await postKeywordStats(cfg, { items, reportedAt: new Date().toISOString() });
        if (!ok) {
            if (!warned) {
                warned = true;
                log('warn', '[关键词] 上报失败（服务端可能未升级 /stats/keywords），后续仍会定时重试');
            }
            return false;
        }
        warned = false;
        log('info', '[关键词] 上报完成，共 ' + items.length + ' 条');
        return true;
    } catch (err) {
        log('warn', '[关键词] 上报异常：' + (err instanceof Error ? err.message : String(err)));
        return false;
    }
}

/** plugin_init 调用：先清残留定时器，立即上报一次，再建唯一的新定时器。 */
export function startKeywordReport(): void {
    clearTimer();
    void reportKeywordStatsOnce();
    const timer = setInterval(() => {
        void reportKeywordStatsOnce();
    }, REPORT_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    (globalThis as TimerHost)[TIMER_KEY] = timer;
    log('info', '[关键词] 定时上报已启动（间隔 ' + Math.round(REPORT_INTERVAL_MS / 1000) + 's）');
}

/** plugin_cleanup 调用：清定时器，热重载不泄漏。 */
export function stopKeywordReport(): void {
    clearTimer();
}
