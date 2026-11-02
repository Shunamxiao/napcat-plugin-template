/**
 * 知识库 / AI 服务客户端
 *
 * 约定：网络错误、超时、非 200、响应形状不对一律返回 null，
 * 绝不把异常抛到消息处理链路；token 只放请求头，不写日志。
 */

import type { BlockUser, GuardPenaltyPolicy, KbServiceConfig, ServerGroupConfig } from '../types';

export interface AskRequest {
    text: string;
    userId: string;
    groupId?: string;
    trigger: 'private' | 'group_at';
    /** 转人工追问答案；与服务侧字段名统一为 collected */
    collected?: { q: string; a: string }[];
}

export interface AskResponse {
    reply: string;
    action: string;
    score?: number;
}

/** /answer 失败类型：http 非 2xx、timeout 超时、err 连接/解析失败 */
export type ServiceFailureKind = 'http' | 'timeout' | 'err';

export interface ServiceFailure {
    kind: ServiceFailureKind;
    /** kind=http 时的 HTTP 状态码 */
    status?: number;
}

/** 问服务的结果：response 与 failure 至多一个非空；未配置时两者都为空 */
export interface AskOutcome {
    response: AskResponse | null;
    failure: ServiceFailure | null;
}

export interface HandoffRequest {
    userId: string;
    groupId?: string;
    text: string;
    /** 转人工追问答案；非空时才随请求上传 */
    collected?: { q: string; a: string }[];
    /** 转人工原因，默认 keyword_human */
    reason: string;
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

type JsonOutcome =
    | { ok: true; data: unknown }
    | { ok: false; failure: ServiceFailure };

function isAbortError(error: unknown, controller: AbortController): boolean {
    if (controller.signal.aborted) return true;
    const name = error instanceof Error ? error.name : (error as { name?: unknown } | null)?.name;
    return String(name ?? '') === 'AbortError';
}

/** 统一的带超时请求；把失败拆成 timeout / http / err，供调用方决定是否降级 */
async function requestJsonOutcome(
    cfg: KbServiceConfig,
    path: string,
    init: RequestInit,
    fetchImpl: FetchLike,
): Promise<JsonOutcome> {
    if (!cfg?.baseUrl || !cfg.token) return { ok: false, failure: { kind: 'err' } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutOf(cfg));
    try {
        const res = await fetchImpl(endpoint(cfg.baseUrl, path), { ...init, signal: controller.signal });
        if (!res.ok) return { ok: false, failure: { kind: 'http', status: res.status } };
        try {
            return { ok: true, data: (await res.json()) as unknown };
        } catch {
            return { ok: false, failure: { kind: 'err' } };
        }
    } catch (error) {
        return { ok: false, failure: { kind: isAbortError(error, controller) ? 'timeout' : 'err' } };
    } finally {
        clearTimeout(timer);
    }
}

/** 统一请求的兼容包装；失败一律收敛成 null。 */
async function requestJson(
    cfg: KbServiceConfig,
    path: string,
    init: RequestInit,
    fetchImpl: FetchLike,
): Promise<unknown> {
    const outcome = await requestJsonOutcome(cfg, path, init, fetchImpl);
    return outcome.ok ? outcome.data : null;
}

/**
 * 问一次知识库服务，并保留失败类型。
 * - 未配置 baseUrl/token：response/failure 都为空（不发起请求，也不触发降级）；
 * - 超时 / 5xx / 连接失败 / 响应形状错误：failure 非空；
 * - 200 且 reply 是字符串（含空串）：response 非空。
 */
export async function askServiceOutcome(
    cfg: KbServiceConfig,
    req: AskRequest,
    fetchImpl: FetchLike = fetch,
): Promise<AskOutcome> {
    if (!cfg?.baseUrl || !cfg.token) return { response: null, failure: null };

    const body: Record<string, unknown> = { text: req.text, userId: req.userId, trigger: req.trigger };
    if (req.groupId) body.groupId = req.groupId;
    if (req.collected && req.collected.length > 0) body.collected = req.collected;

    const outcome = await requestJsonOutcome(
        cfg,
        '/answer',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bot-token': String(cfg.token || '') },
            body: JSON.stringify(body),
        },
        fetchImpl,
    );
    if (!outcome.ok) return { response: null, failure: outcome.failure };
    const data = outcome.data;
    if (!isObject(data) || typeof data.reply !== 'string') {
        return { response: null, failure: { kind: 'err' } };
    }
    return {
        response: {
            reply: data.reply,
            action: typeof data.action === 'string' ? data.action : 'unknown',
            score: typeof data.score === 'number' ? data.score : undefined,
        },
        failure: null,
    };
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
    return (await askServiceOutcome(cfg, req, fetchImpl)).response;
}

/**
 * 上报一次转人工给服务侧（服务端 JSONL 留档 + Telegram 通知）。
 * 成功返回 true；未配置(缺 baseUrl/token)、网络失败、非 2xx、响应非 JSON 一律 false。
 * 绝不抛异常：调用方按「失败只记日志、不影响给用户回话」处理。
 */
export async function notifyHandoff(
    cfg: KbServiceConfig,
    req: HandoffRequest,
    fetchImpl: FetchLike = fetch,
): Promise<boolean> {
    const body: Record<string, unknown> = {
        userId: req.userId,
        text: req.text,
        reason: req.reason,
    };
    if (req.groupId) body.groupId = req.groupId;
    if (req.collected && req.collected.length > 0) body.collected = req.collected;

    const data = await requestJson(
        cfg,
        '/handoff',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bot-token': String(cfg.token || '') },
            body: JSON.stringify(body),
        },
        fetchImpl,
    );
    return data !== null;
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

/** GET /config/groups 的解析结果 */
export interface GroupConfigPayload {
    groups: ServerGroupConfig[];
    /** 服务端未下发合法策略时为 null，调用方沿用上次缓存 */
    guard: GuardPenaltyPolicy | null;
    version: string;
}

function parseServerGroup(raw: unknown): ServerGroupConfig | null {
    if (!isObject(raw)) return null;
    const groupId = typeof raw.groupId === 'string' ? raw.groupId.trim() : '';
    if (!groupId) return null;
    const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
    const enabled = bool(raw.enabled);
    const atOnly = bool(raw.atOnly);
    const aiEnabled = bool(raw.aiEnabled);
    const welcomeEnabled = bool(raw.welcomeEnabled);
    if (enabled === null || atOnly === null || aiEnabled === null || welcomeEnabled === null) return null;
    let welcomeTemplate: string | null = null;
    if (raw.welcomeTemplate === null || raw.welcomeTemplate === undefined) welcomeTemplate = null;
    else if (typeof raw.welcomeTemplate === 'string') {
        const template = raw.welcomeTemplate.trim();
        welcomeTemplate = template ? template : null;
    } else return null;
    return { groupId, enabled, atOnly, aiEnabled, welcomeEnabled, welcomeTemplate };
}

function intInRange(v: unknown, min: number, max: number): number | null {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return null;
    return v;
}

/** 校验 /config/groups 的 guard 块；任何一个字段非法即整块丢弃 */
function parseGuardPolicy(raw: unknown): GuardPenaltyPolicy | null {
    if (!isObject(raw)) return null;
    const threshold = intInRange(raw.threshold, 1, 20);
    const windowSeconds = intInRange(raw.windowSeconds, 60, 86400);
    const muteSeconds = intInRange(raw.muteSeconds, 60, 2592000);
    if (threshold === null || windowSeconds === null || muteSeconds === null) return null;
    if (typeof raw.warnText !== 'string' || typeof raw.muteText !== 'string') return null;
    return {
        threshold,
        windowSeconds,
        muteSeconds,
        warnText: raw.warnText,
        muteText: raw.muteText,
    };
}

/**
 * 拉取服务端群配置 + 守卫处罚策略（GET /config/groups，x-bot-token）。
 * 请求失败、形状不对一律返回 null，调用方保留上次缓存。
 */
export async function fetchGroupConfig(
    cfg: KbServiceConfig,
    fetchImpl: FetchLike = fetch,
): Promise<GroupConfigPayload | null> {
    const data = await requestJson(
        cfg,
        '/config/groups',
        { method: 'GET', headers: { 'x-bot-token': String(cfg.token || '') } },
        fetchImpl,
    );
    if (!isObject(data) || !Array.isArray(data.groups)) return null;
    const groups: ServerGroupConfig[] = [];
    for (const item of data.groups) {
        const parsed = parseServerGroup(item);
        if (parsed) groups.push(parsed);
    }
    return {
        groups,
        guard: parseGuardPolicy(data.guard),
        version: typeof data.version === 'string' ? data.version : '',
    };
}

/**
 * 拉取服务侧群守卫词表（GET /blocklist 的 words 字段）。
 * - 请求失败返回 null，调用方保留上一次缓存；
 * - 老版本服务只返回 users、没有 words：按成功且无服务词处理，避免滚动升级期间刷失败日志；
 * - 成功返回去重后的非空字符串数组（可能为空）。
 */
export async function fetchGuardWords(
    cfg: KbServiceConfig,
    fetchImpl: FetchLike = fetch,
): Promise<string[] | null> {
    const data = await requestJson(
        cfg,
        '/blocklist',
        { method: 'GET', headers: { 'x-bot-token': String(cfg.token || '') } },
        fetchImpl,
    );
    if (!isObject(data)) return null;
    if (!Array.isArray(data.words)) {
        return Array.isArray(data.users) ? [] : null;
    }
    const seen = new Set<string>();
    const words: string[] = [];
    for (const item of data.words) {
        if (typeof item !== 'string') continue;
        const word = item.trim();
        if (!word || seen.has(word)) continue;
        seen.add(word);
        words.push(word);
    }
    return words;
}

export interface KeywordReportItem {
    key: string;
    count: number;
    lastAt: string;
}

export interface KeywordReportPayload {
    items: KeywordReportItem[];
    reportedAt: string;
}

/**
 * 上报关键词命中统计（POST /stats/keywords，x-bot-token）。
 * 返回 true 只代表服务端 2xx 且响应是 JSON；网络失败/超时一律 false，绝不抛错。
 */
export async function reportKeywordStats(
    cfg: KbServiceConfig,
    payload: KeywordReportPayload,
    fetchImpl: FetchLike = fetch,
): Promise<boolean> {
    const data = await requestJson(
        cfg,
        '/stats/keywords',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bot-token': String(cfg.token || '') },
            body: JSON.stringify(payload),
        },
        fetchImpl,
    );
    return isObject(data);
}
