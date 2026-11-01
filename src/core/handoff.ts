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
