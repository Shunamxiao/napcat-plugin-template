/**
 * 知识库 / AI 服务客户端
 *
 * 约定：网络错误、超时、非 200、响应形状不对一律返回 null，
 * 绝不把异常抛到消息处理链路；token 只放请求头，不写日志。
 */

import type { BlockUser, KbServiceConfig } from '../types';

export interface AskRequest {
    text: string;
    userId: string;
    groupId?: string;
    trigger: 'private' | 'group_at';
}

export interface AskResponse {
    reply: string;
    action: string;
    score?: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 8000;

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function endpoint(baseUrl: string, path: string): string {
    return String(baseUrl || '').trim().replace(/\/+$/, '') + path;
}

function timeoutOf(cfg: KbServiceConfig): number {
    const n = Number(cfg.timeoutMs);
    if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/** 统一的带超时请求；任何失败都收敛成 null。 */
async function requestJson(
    cfg: KbServiceConfig,
    path: string,
    init: RequestInit,
    fetchImpl: FetchLike,
): Promise<unknown> {
    if (!cfg?.baseUrl || !cfg.token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutOf(cfg));
    try {
        const res = await fetchImpl(endpoint(cfg.baseUrl, path), { ...init, signal: controller.signal });
        if (!res.ok) return null;
        return (await res.json()) as unknown;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 问一次知识库服务。
 * 成功且形状正确返回 { reply, action, score }；其余（含空 reply）由调用方按失败处理。
 */
export async function askService(
    cfg: KbServiceConfig,
    req: AskRequest,
    fetchImpl: FetchLike = fetch,
): Promise<AskResponse | null> {
    const body: Record<string, string> = { text: req.text, userId: req.userId, trigger: req.trigger };
    if (req.groupId) body.groupId = req.groupId;

    const data = await requestJson(
        cfg,
        '/answer',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bot-token': String(cfg.token || '') },
            body: JSON.stringify(body),
        },
        fetchImpl,
    );
    if (!isObject(data) || typeof data.reply !== 'string') return null;
    return {
        reply: data.reply,
        action: typeof data.action === 'string' ? data.action : 'unknown',
        score: typeof data.score === 'number' ? data.score : undefined,
    };
}

/**
 * 拉取服务侧拉黑名单。
 * 失败返回 null，调用方保留旧缓存；成功返回逐条校验后的 users。
 */
export async function fetchBlocklist(
    cfg: KbServiceConfig,
    fetchImpl: FetchLike = fetch,
): Promise<BlockUser[] | null> {
    const data = await requestJson(
        cfg,
        '/blocklist',
        { method: 'GET', headers: { 'x-bot-token': String(cfg.token || '') } },
        fetchImpl,
    );
    if (!isObject(data) || !Array.isArray(data.users)) return null;

    const users: BlockUser[] = [];
    for (const item of data.users) {
        if (!isObject(item)) continue;
        const userId = typeof item.userId === 'string' ? item.userId.trim() : '';
        if (!userId) continue;
        const entry: BlockUser = { userId };
        if (typeof item.reason === 'string') entry.reason = item.reason;
        if (typeof item.ts === 'string') entry.ts = item.ts;
        users.push(entry);
    }
    return users;
}
