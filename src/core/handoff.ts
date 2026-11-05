/**
 * 转人工留档 — 规则命中 action=human 时写一条 JSONL。
 * 与服务的 handoff 语义对齐（ts/userId/groupId/text/reason），但完全本地、不发网络请求。
 */

import fs from 'fs';
import path from 'path';

export interface HandoffRecord {
    ts: string;
    userId: string;
    groupId?: string;
    text: string;
    reason: string;
    rule?: string;
    reply?: string;
    /** 转人工追问答案，字段名与服务侧 /answer 对齐 */
    collected?: { q: string; a: string }[];
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMER_KEY = '__napcatAutoreplyHandoffCleanupTimer';
type TimerHost = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

function isExpiredRecord(line: string, cutoff: number): boolean {
    try {
        const record = JSON.parse(line) as { ts?: unknown };
        if (typeof record.ts !== 'string') return false;
        const timestamp = Date.parse(record.ts);
        return Number.isFinite(timestamp) && timestamp < cutoff;
    } catch {
        return false;
    }
}

/** 删除 30 天前的合法记录；无法解析的行原样保留。 */
export function pruneHandoffFile(filePath: string, now = Date.now()): boolean {
    if (!fs.existsSync(filePath)) return true;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const kept = lines.filter((line) => !line || !isExpiredRecord(line, now - RETENTION_MS));
    if (kept.length === lines.length) return true;
    const temporaryPath = filePath + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(temporaryPath, kept.join('\n'), 'utf-8');
        fs.renameSync(temporaryPath, filePath);
        return true;
    } catch {
        try { fs.unlinkSync(temporaryPath); } catch { /* 临时文件可能尚未创建 */ }
        return false;
    }
}

function clearCleanupTimer(): void {
    const host = globalThis as TimerHost;
    const timer = host[TIMER_KEY];
    if (timer !== undefined) {
        clearInterval(timer);
        host[TIMER_KEY] = undefined;
    }
}

/** 启动时清理一次，之后每 24 小时清理。 */
export function startHandoffCleanup(filePath: string): void {
    clearCleanupTimer();
    pruneHandoffFile(filePath);
    const timer = setInterval(() => pruneHandoffFile(filePath), CLEANUP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    (globalThis as TimerHost)[TIMER_KEY] = timer;
}

export function stopHandoffCleanup(): void {
    clearCleanupTimer();
}

/** 追加一条留档；失败返回 false，调用方只记日志，绝不影响发消息 */
export function appendHandoffRecord(filePath: string, record: HandoffRecord): boolean {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
        return true;
    } catch {
        return false;
    }
}
