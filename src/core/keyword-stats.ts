/**
 * 关键词命中统计 — 纯逻辑 + 文件 IO
 *
 * 结构严格为 {"<match>|<matchType>": {count, lastAt}}，键只按 match+matchType 聚合，
 * 与渠道（私聊/群聊）、所在群无关。首次命中起 30 秒节流落盘，避免高频命中频繁写磁盘；
 * 写盘用临时文件 + rename 原子替换，进程被 kill 时最多丢最近一个节流窗口。
 */

import fs from 'fs';
import path from 'path';
import { pluginState } from './state';
import { recordTrafficRuleHit } from './traffic-stats';
import type { KeywordRule } from '../types';

export interface KeywordStatEntry {
    count: number;
    lastAt: string;
}

export type KeywordStats = Record<string, KeywordStatEntry>;

const DEFAULT_FLUSH_INTERVAL_MS = 30000;

let statsFile: string | null = null;
let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
let stats: KeywordStats = {};
/** 自上次成功落盘后是否有新命中 */
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

/** pluginState 未初始化（单测/极端时机）时退回 console，不影响主流程 */
function logLine(level: 'warn' | 'error', message: string): void {
    try {
        pluginState.logger[level](message);
    } catch {
        console[level](message);
    }
}

/** 统计聚合键：match 去首尾空白，matchType 缺省按 contains */
export function keywordStatKey(rule: Pick<KeywordRule, 'match' | 'matchType'>): string {
    const match = (rule.match || '').trim();
    const matchType = rule.matchType || 'contains';
    return match + '|' + matchType;
}

function cancelFlushTimer(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}

function scheduleFlush(): void {
    // 首次 dirty 起算一个窗口；窗口内的后续命中合并到同一次落盘
    if (flushTimer || !statsFile) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushKeywordStats();
    }, flushIntervalMs);
    // 不阻止进程退出；正常卸载由 shutdownKeywordStats() 兜底
    flushTimer.unref?.();
}

/** 只接受合法结构，坏条目丢弃，避免坏文件把运行时带崩 */
function parseStats(raw: unknown): KeywordStats {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: KeywordStats = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.count !== 'number' || !Number.isFinite(entry.count) || entry.count < 0) continue;
        if (typeof entry.lastAt !== 'string' || !entry.lastAt) continue;
        out[key] = { count: Math.floor(entry.count), lastAt: entry.lastAt };
    }
    return out;
}

function writeStats(): boolean {
    if (!statsFile) return false;
    try {
        const dir = path.dirname(statsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = statsFile + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), 'utf-8');
        fs.renameSync(tmp, statsFile);
        return true;
    } catch (e) {
        logLine('error', '关键词统计写盘失败: ' + statsFile + ' ' + (e instanceof Error ? e.message : String(e)));
        return false;
    }
}

/** 初始化（plugin_init 调用）：读取已有统计；文件缺失/损坏按空表处理 */
export function initKeywordStats(filePath: string, intervalMs = DEFAULT_FLUSH_INTERVAL_MS): void {
    cancelFlushTimer();
    statsFile = filePath;
    flushIntervalMs = Math.max(1, Math.floor(intervalMs));
    dirty = false;
    stats = {};
    try {
        stats = parseStats(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        // 首次运行没有文件是正常情况，不刷 warn
        if (code !== 'ENOENT') {
            logLine('warn', '关键词统计文件读取失败，按空表处理: ' + filePath + ' ' + (e instanceof Error ? e.message : String(e)));
        }
    }
}

/**
 * 命中一次：内存累加并标记 dirty，窗口内合并落盘。
 * scope 非空时同步累加流量统计的 ruleHits —— 两套口径必须同点计数。
 */
export function recordKeywordHit(rule: Pick<KeywordRule, 'match' | 'matchType'>, scope?: string): void {
    const key = keywordStatKey(rule);
    if (key === '|contains') return;
    const prev = stats[key];
    stats[key] = {
        count: (prev?.count ?? 0) + 1,
        lastAt: new Date().toISOString(),
    };
    if (scope) recordTrafficRuleHit(scope);
    dirty = true;
    scheduleFlush();
}

/** 当前统计快照（深拷贝，调用方改动不会污染内存） */
export function snapshotKeywordStats(): KeywordStats {
    const out: KeywordStats = {};
    for (const [key, entry] of Object.entries(stats)) out[key] = { ...entry };
    return out;
}

/**
 * 立即落盘（取消防抖定时器）。
 * retryOnFailure=false 用于卸载路径，避免清理后重新挂定时器。
 */
export function flushKeywordStats(retryOnFailure = true): void {
    cancelFlushTimer();
    if (!dirty || !statsFile) return;
    if (writeStats()) {
        dirty = false;
    } else if (retryOnFailure) {
        scheduleFlush();
    }
}

/** 清空统计并立即写空对象；重置后文件不存在也不会抛 */
export function resetKeywordStats(): KeywordStats {
    stats = {};
    dirty = false;
    cancelFlushTimer();
    if (!statsFile) return {};
    if (!writeStats()) {
        // 写失败时保留 dirty，交给下一个节流窗口重试
        dirty = true;
        scheduleFlush();
    }
    return {};
}

/** 插件卸载：取消防抖并尽量把未落盘数据写完，然后与文件解绑 */
export function shutdownKeywordStats(): void {
    flushKeywordStats(false);
    cancelFlushTimer();
    statsFile = null;
    dirty = false;
}
