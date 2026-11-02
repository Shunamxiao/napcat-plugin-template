/**
 * 知识库 / AI 服务客户端
 *
 * 约定：网络错误、超时、非 200、响应形状不对一律返回 null，
 * 绝不把异常抛到消息处理链路；token 只放请求头，不写日志。
 */

import type { BlockUser, GroupMode, GuardPenaltyPolicy, KbServiceConfig, MissPolicy, ServerGroupConfig } from '../types';
import { legacyGroupMode, legacyMissPolicy } from '../core/policy';

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

const GROUP_MODES: readonly string[] = ['off', 'all', 'at'];
const MISS_POLICIES: readonly string[] = ['ai_then_fallback', 'fallback_only', 'none'];

function isGroupMode(v: unknown): v is GroupMode {
    return typeof v === 'string' && GROUP_MODES.includes(v);
}

function isMissPolicy(v: unknown): v is MissPolicy {
    return typeof v === 'string' && MISS_POLICIES.includes(v);
}

/** 群级冷却：null/缺省 = 跟随全局；0..3600 的整数才收，坏值按跟随全局 */
function parseCooldownSeconds(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 3600) return null;
    return v;
}

/** 群级兜底文案：null/缺省 = 跟随全局；空白串同样按跟随全局 */
function parseFallbackText(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return null;
    const text = v.trim();
    return text ? text : null;
}

/**
 * 解析一条服务端群配置。
 * - 新服务端下发 mode/missPolicy；老服务端只有 enabled/atOnly/aiEnabled，按同一口径就地映射；
 * - 输出统一补全成 { mode, missPolicy, atForceReply, keywordOutsideAt, cooldownSeconds, fallbackText }，
 *   调用方不需要再判断服务端版本。
 */
function parseServerGroup(raw: unknown): ServerGroupConfig | null {
    if (!isObject(raw)) return null;
    const groupId = typeof raw.groupId === 'string' ? raw.groupId.trim() : '';
    if (!groupId) return null;
    const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
    const welcomeEnabled = bool(raw.welcomeEnabled);
    if (welcomeEnabled === null) return null;
    let welcomeTemplate: string | null = null;
    if (raw.welcomeTemplate === null || raw.welcomeTemplate === undefined) welcomeTemplate = null;
    else if (typeof raw.welcomeTemplate === 'string') {
        const template = raw.welcomeTemplate.trim();
        welcomeTemplate = template ? template : null;
    } else return null;

    const enabled = bool(raw.enabled);
    const atOnly = bool(raw.atOnly);
    const aiEnabled = bool(raw.aiEnabled);
    // 新字段优先；缺省时用旧字段推导。两者都缺说明条目形状不可用，丢弃。
    const mode: GroupMode | null = isGroupMode(raw.mode)
        ? raw.mode
        : enabled !== null ? legacyGroupMode(enabled, atOnly === true) : null;
    const missPolicy: MissPolicy | null = isMissPolicy(raw.missPolicy)
        ? raw.missPolicy
        : aiEnabled !== null ? legacyMissPolicy(aiEnabled) : null;
    if (mode === null || missPolicy === null) return null;

    return {
        groupId,
        // 旧字段统一由新口径反推，保证运行期只有一套真源
        enabled: mode !== 'off',
        atOnly: mode === 'at',
        aiEnabled: missPolicy === 'ai_then_fallback',
        welcomeEnabled,
        welcomeTemplate,
        mode,
        missPolicy,
        atForceReply: bool(raw.atForceReply) ?? true,
        keywordOutsideAt: bool(raw.keywordOutsideAt) ?? true,
        cooldownSeconds: parseCooldownSeconds(raw.cooldownSeconds),
        fallbackText: parseFallbackText(raw.fallbackText),
    };
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

// ==================== 服务端 bot 配置（/config/bots*，契约 docs/bot-config-contract.md） ====================

/** GET /config/bots 的一条；服务端只存 uin/nickname/config/revision/updatedAt */
export interface ServerBotSummary {
    uin: string;
    nickname: string;
    revision: number;
    updatedAt?: string;
}

/** GET /config/bots/:uin 的解析结果；config 是服务端原样存储的整份插件配置（token 已掩码） */
export interface ServerBotConfigPayload {
    uin: string;
    nickname: string;
    config: Record<string, unknown>;
    revision: number;
}

/** PUT /config/bots/:uin 的结果；409 时带服务端当前 revision */
export interface BotConfigWriteResult {
    ok: boolean;
    status: number;
    revision?: number;
    error?: string;
}

/** GET /config/bots：全部账号的服务端配置摘要；失败返回 null */
export async function listServerBots(
    cfg: KbServiceConfig,
    fetchImpl: FetchLike = fetch,
): Promise<ServerBotSummary[] | null> {
    const data = await requestJson(
        cfg,
        '/config/bots',
        { method: 'GET', headers: { 'x-bot-token': String(cfg.token || '') } },
        fetchImpl,
    );
    if (!Array.isArray(data)) return null;
    const bots: ServerBotSummary[] = [];
    for (const item of data) {
        if (!isObject(item)) continue;
        const uin = typeof item.uin === 'string' ? item.uin.trim() : (typeof item.uin === 'number' ? String(item.uin) : '');
        if (!uin) continue;
        bots.push({
            uin,
            nickname: typeof item.nickname === 'string' ? item.nickname : '',
            revision: typeof item.revision === 'number' ? item.revision : 0,
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
        });
    }
    return bots;
}

/** GET /config/bots/:uin：单个账号配置；无记录/形状不对/网络失败一律 null */
export async function fetchBotConfig(
    cfg: KbServiceConfig,
    uin: string,
    fetchImpl: FetchLike = fetch,
): Promise<ServerBotConfigPayload | null> {
    const data = await requestJson(
        cfg,
        '/config/bots/' + encodeURIComponent(uin),
        { method: 'GET', headers: { 'x-bot-token': String(cfg.token || '') } },
        fetchImpl,
    );
    if (!isObject(data) || !isObject(data.config)) return null;
    const revision = typeof data.revision === 'number' ? data.revision : 0;
    if (revision <= 0) return null;
    return {
        uin: typeof data.uin === 'string' ? data.uin : uin,
        nickname: typeof data.nickname === 'string' ? data.nickname : '',
        config: data.config,
        revision,
    };
}

/**
 * POST /config/bots/:uin/import：以本地配置为种子做幂等导入（服务端仅在没有记录时写入）。
 * 返回 true 只代表服务端 2xx 且响应是 JSON；失败一律 false，绝不抛错。
 */
export async function importBotConfig(
    cfg: KbServiceConfig,
    uin: string,
    config: unknown,
    fetchImpl: FetchLike = fetch,
): Promise<boolean> {
    const data = await requestJson(
        cfg,
        '/config/bots/' + encodeURIComponent(uin) + '/import',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bot-token': String(cfg.token || '') },
            body: JSON.stringify({ config }),
        },
        fetchImpl,
    );
    return isObject(data);
}

/**
 * PUT /config/bots/:uin：写入整份配置（expectedRevision 缺省 = 无条件写）。
 * 2xx 返回 {ok:true, revision}；409 保留服务端当前 revision；其余失败带错误信息。绝不抛错。
 */
export async function putBotConfig(
    cfg: KbServiceConfig,
    uin: string,
    config: unknown,
    expectedRevision?: number,
    fetchImpl: FetchLike = fetch,
): Promise<BotConfigWriteResult> {
    if (!cfg?.baseUrl || !cfg.token) return { ok: false, status: 503, error: '未配置服务地址或令牌' };
    const body: Record<string, unknown> = { config };
    if (typeof expectedRevision === 'number' && Number.isFinite(expectedRevision) && expectedRevision > 0) {
        body.expectedRevision = expectedRevision;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutOf(cfg));
    try {
        const res = await fetchImpl(endpoint(cfg.baseUrl, '/config/bots/' + encodeURIComponent(uin)), {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-bot-token': String(cfg.token || '') },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await res.text();
        let data: unknown = null;
        try {
            data = JSON.parse(text) as unknown;
        } catch { /* 非 JSON 响应体，按原样处理 */ }
        const rec = isObject(data) ? data : {};
        if (!res.ok) {
            return {
                ok: false,
                status: res.status,
                revision: typeof rec.revision === 'number' ? rec.revision : undefined,
                error: typeof rec.error === 'string' && rec.error ? rec.error : 'HTTP ' + res.status,
            };
        }
        if (typeof rec.revision !== 'number') return { ok: false, status: 502, error: '服务端返回缺少 revision' };
        return { ok: true, status: res.status, revision: rec.revision };
    } catch (e) {
        const aborted = (e as { name?: unknown } | null)?.name === 'AbortError';
        return {
            ok: false,
            status: aborted ? 504 : 502,
            error: aborted ? '请求超时' : (e instanceof Error ? e.message : String(e)),
        };
    } finally {
        clearTimeout(timer);
    }
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

/** 流量桶上报条目：字段名与服务端逐字一致（"in" 是保留字，必须带引号） */
export interface TrafficReportItem {
    bucket: string;
    scope: string;
    in: number;
    replies: number;
    ruleHits: number;
    aiReplies: number;
    fallbackReplies: number;
    users: number;
}

export interface TrafficReportPayload {
    items: TrafficReportItem[];
}

/**
 * 上报流量统计（POST /stats/traffic，x-bot-token）。
 * 返回 true 只代表服务端 2xx 且响应是 JSON；网络失败/超时一律 false，绝不抛错。
 */
export async function reportTrafficStats(
    cfg: KbServiceConfig,
    payload: TrafficReportPayload,
    fetchImpl: FetchLike = fetch,
): Promise<boolean> {
    const data = await requestJson(
        cfg,
        '/stats/traffic',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bot-token': String(cfg.token || '') },
            body: JSON.stringify(payload),
        },
        fetchImpl,
    );
    return isObject(data);
}
