/**
 * 流量计数与上报 — 内存累计 + 每 5 分钟批量 POST /stats/traffic
 *
 * 口径（与服务端约定，字段逐字一致）：
 * - bucket：UTC 截断到小时，形如 2026-11-02T08:00:00.000Z；
 * - scope：只统计 private 与 group:<群号>；
 * - in：收到的消息条数（黑名单/忽略发送者也算，因为确实收到过）；
 * - replies：实际发出的回复条数（发送成功才计）；
 * - ruleHits：关键词规则命中次数（与 keyword-stats 同一累加点）；
 * - aiReplies：回复内容来自 AI 的次数；
 * - fallbackReplies：回复内容来自兜底话术的次数；
 * - users：该桶内按 QQ 号去重的用户数（只上报数量，不上报号码），上报成功后清空。
 *
 * 失败只记 warn，不重试轰炸；未配置服务地址/令牌时静默跳过。
 */

import { pluginState } from './state';
import { reportTrafficStats, type TrafficReportItem, type TrafficReportPayload } from '../services/kb-client';

export interface TrafficBucket {
    /** 收到消息条数 */
    in: number;
    /** 实际发出的回复条数 */
    replies: number;
    /** 关键词规则命中次数 */
    ruleHits: number;
    /** AI 回复条数 */
    aiReplies: number;
    /** 兜底回复条数 */
    fallbackReplies: number;
    /** 本桶去重用户（只用于计数，上报后清空） */
    users: Set<string>;
}

export type TrafficReplySource = 'rule' | 'ai' | 'default' | 'none';

const REPORT_INTERVAL_MS = 300000;

/**
 * 定时器挂在 globalThis 上：HMR 热重载会重建模块实例，
 * 模块级变量拿不到旧 timer，clearInterval 就会漏掉。
 */
const TIMER_KEY = '__napcatAutoreplyTrafficReportTimer';
type TimerHost = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

/** key = bucket + '|' + scope */
const buckets = new Map<string, TrafficBucket>();

/** 同一条失败只刷一次 warn，避免服务端未升级时每 5 分钟刷屏 */
let warned = false;

function log(level: 'info' | 'warn' | 'debug', message: string): void {
    try {
        pluginState.logger[level](message);
    } catch {
        if (level === 'info') console.log(message);
        else if (level === 'warn') console.warn(message);
        else console.debug(message);
    }
}

/** UTC 小时桶：2026-11-02T08:37:12.345Z → 2026-11-02T08:00:00.000Z */
export function hourBucket(now: Date = new Date()): string {
    return now.toISOString().slice(0, 13) + ':00:00.000Z';
}

function bucketFor(bucket: string, scope: string): TrafficBucket {
    const key = bucket + '|' + scope;
    let entry = buckets.get(key);
    if (!entry) {
        entry = { in: 0, replies: 0, ruleHits: 0, aiReplies: 0, fallbackReplies: 0, users: new Set() };
        buckets.set(key, entry);
    }
    return entry;
}

/** 收到一条消息：黑名单/忽略发送者也照常计数（scope 只收 private / group:<群号>） */
export function recordTrafficIncoming(scope: string, userId: string, now: Date = new Date()): void {
    const entry = bucketFor(hourBucket(now), scope);
    entry.in += 1;
    const user = String(userId);
    if (user && user !== '0') entry.users.add(user);
}

/** 关键词规则命中：与 keyword-stats 的累加点同一处调用 */
export function recordTrafficRuleHit(scope: string, now: Date = new Date()): void {
    bucketFor(hourBucket(now), scope).ruleHits += 1;
}

/** 实际发出的回复：发送成功后调用，source 区分 AI / 兜底 */
export function recordTrafficReply(scope: string, source: TrafficReplySource = 'rule', now: Date = new Date()): void {
    const entry = bucketFor(hourBucket(now), scope);
    entry.replies += 1;
    if (source === 'ai') entry.aiReplies += 1;
    else if (source === 'default') entry.fallbackReplies += 1;
}

/**
 * 当前快照（纯数据，供上报与单测）。
 * 排序按 bucket + scope，保证输出稳定。
 */
export function snapshotTraffic(): TrafficReportItem[] {
    const items: TrafficReportItem[] = [];
    for (const [key, entry] of buckets) {
        const sep = key.indexOf('|');
        const bucket = key.slice(0, sep);
        const scope = key.slice(sep + 1);
        items.push({
            bucket,
            scope,
            in: entry.in,
            replies: entry.replies,
            ruleHits: entry.ruleHits,
            aiReplies: entry.aiReplies,
            fallbackReplies: entry.fallbackReplies,
            users: entry.users.size,
        });
    }
    return items.sort((a, b) => (a.bucket === b.bucket ? a.scope.localeCompare(b.scope) : a.bucket.localeCompare(b.bucket)));
}

/** 上报成功后清空已上报的桶（失败保留，等下一轮再发，避免丢数据） */
export function commitTrafficReport(items: TrafficReportItem[]): void {
    for (const item of items) buckets.delete(item.bucket + '|' + item.scope);
}

/** 构建上报 body；单测直接打印用 */
export function buildTrafficPayload(): TrafficReportPayload {
    return { items: snapshotTraffic() };
}

/** 清空全部计数（单测/极端场景用） */
export function resetTraffic(): void {
    buckets.clear();
}

function clearTimer(): void {
    const host = globalThis as TimerHost;
    const timer = host[TIMER_KEY];
    if (timer !== undefined) {
        clearInterval(timer);
        host[TIMER_KEY] = undefined;
    }
}

/** 立即上报一次；未配置/无数据/失败返回 false，绝不抛错。 */
export async function reportTrafficOnce(): Promise<boolean> {
    try {
        const cfg = pluginState.config.kbService;
        if (!cfg?.baseUrl || !cfg.token) return false;
        const items = snapshotTraffic();
        if (items.length === 0) return false;
        const ok = await reportTrafficStats(cfg, { items });
        if (!ok) {
            if (!warned) {
                warned = true;
                log('warn', '[流量] 上报失败（服务端可能未升级 /stats/traffic），后续仍会定时重试');
            }
            return false;
        }
        warned = false;
        const totalIn = items.reduce((sum, item) => sum + item.in, 0);
        const totalReplies = items.reduce((sum, item) => sum + item.replies, 0);
        log('info', '[流量] 上报完成，' + items.length + ' 个桶，收 ' + totalIn + ' 条 / 回 ' + totalReplies + ' 条');
        commitTrafficReport(items);
        return true;
    } catch (err) {
        log('warn', '[流量] 上报异常：' + (err instanceof Error ? err.message : String(err)));
        return false;
    }
}

/** plugin_init 调用：先清残留定时器，再建唯一的新定时器（首次不空跑）。 */
export function startTrafficReport(): void {
    clearTimer();
    const timer = setInterval(() => {
        void reportTrafficOnce();
    }, REPORT_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    (globalThis as TimerHost)[TIMER_KEY] = timer;
    log('info', '[流量] 定时上报已启动（间隔 ' + Math.round(REPORT_INTERVAL_MS / 1000) + 's）');
}

/** plugin_cleanup 调用：清定时器并尽力 flush 一次（不等待，避免拖慢卸载） */
export function stopTrafficReport(): void {
    clearTimer();
    void reportTrafficOnce();
}
