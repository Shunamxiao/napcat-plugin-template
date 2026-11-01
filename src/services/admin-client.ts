/**
 * 服务端后台（/admin/*）客户端：HTTP Basic 鉴权
 *
 * 凭据优先级：
 *   1. 进程环境变量 QQBOT_ADMIN_USER / QQBOT_ADMIN_PASSWORD
 *   2. 兼容 ADMIN_USER / ADMIN_PASSWORD
 *   3. 环境变量 QQBOT_ADMIN_ENV_FILE 指向的 env 文件（默认 /root/qq-accounts/shared/admin.env）
 * 凭据只用于请求头，不写日志、不进页面。
 */

import fs from 'fs';
import type { GuardPenaltyPolicy, ServerGroupConfig } from '../types';

export interface AdminCredentials {
    user: string;
    password: string;
}

export type AdminResult<T> =
    | { ok: true; data: T }
    | { ok: false; status: number; error: string };

export const DEFAULT_ADMIN_ENV_FILE = '/root/qq-accounts/shared/admin.env';
const ADMIN_TIMEOUT_MS = 8000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GroupPatch {
    enabled?: boolean;
    atOnly?: boolean;
    aiEnabled?: boolean;
    welcomeEnabled?: boolean;
    welcomeTemplate?: string | null;
}

/** 解析 KEY=VALUE 形式的 env 文件；忽略注释、空行和 export 前缀 */
export function parseEnvFile(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of String(text ?? '').split('\n')) {
        const line = rawLine.trim().replace(/^export\s+/, '');
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) out[key] = value;
    }
    return out;
}

function envCredentials(): AdminCredentials | null {
    const user = String(process.env.QQBOT_ADMIN_USER ?? process.env.ADMIN_USER ?? '').trim();
    const password = String(process.env.QQBOT_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? '');
    if (!user || !password) return null;
    return { user, password };
}

/**
 * 读取后台 Basic 凭据；未配置时返回 null（写接口返回 503 并给出明确提示）。
 * 每次调用都重新读：改 env 文件后无需重载插件。
 */
export function readAdminCredentials(): AdminCredentials | null {
    const fromEnv = envCredentials();
    if (fromEnv) return fromEnv;
    const file = String(process.env.QQBOT_ADMIN_ENV_FILE || DEFAULT_ADMIN_ENV_FILE);
    try {
        const parsed = parseEnvFile(fs.readFileSync(file, 'utf-8'));
        const user = (parsed.QQBOT_ADMIN_USER ?? parsed.ADMIN_USER ?? '').trim();
        const password = parsed.QQBOT_ADMIN_PASSWORD ?? parsed.ADMIN_PASSWORD ?? '';
        if (!user || !password) return null;
        return { user, password };
    } catch {
        return null;
    }
}

function endpoint(baseUrl: string, path: string): string {
    return String(baseUrl || '').trim().replace(/\/+$/, '') + path;
}

async function adminRequest<T>(
    baseUrl: string,
    path: string,
    method: 'GET' | 'PUT',
    body: unknown,
    fetchImpl: FetchLike = fetch,
): Promise<AdminResult<T>> {
    if (!baseUrl) return { ok: false, status: 503, error: '未配置服务地址（kbService.baseUrl）' };
    const creds = readAdminCredentials();
    if (!creds) {
        return {
            ok: false,
            status: 503,
            error: '未配置后台凭据：请在实例环境变量或 ' + DEFAULT_ADMIN_ENV_FILE + ' 中设置 ADMIN_USER / ADMIN_PASSWORD',
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ADMIN_TIMEOUT_MS);
    try {
        const res = await fetchImpl(endpoint(baseUrl, path), {
            method,
            headers: {
                'content-type': 'application/json',
                authorization: 'Basic ' + Buffer.from(creds.user + ':' + creds.password).toString('base64'),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
            let message = text || 'HTTP ' + res.status;
            try {
                const parsed = JSON.parse(text) as { error?: unknown };
                if (typeof parsed?.error === 'string' && parsed.error) message = parsed.error;
            } catch { /* 非 JSON 错误体，保留原文 */ }
            return { ok: false, status: res.status, error: message.slice(0, 300) };
        }
        try {
            return { ok: true, data: JSON.parse(text) as T };
        } catch {
            return { ok: false, status: 502, error: '服务端返回了非 JSON 响应' };
        }
    } catch (e) {
        const aborted = (e as { name?: unknown } | null)?.name === 'AbortError';
        return { ok: false, status: 504, error: aborted ? '后台请求超时' : (e instanceof Error ? e.message : String(e)) };
    } finally {
        clearTimeout(timer);
    }
}

/** PUT /admin/groups/:groupId → 落库后的条目 */
export function putServerGroup(
    baseUrl: string,
    groupId: string,
    patch: GroupPatch,
    fetchImpl: FetchLike = fetch,
): Promise<AdminResult<ServerGroupConfig>> {
    return adminRequest<ServerGroupConfig>(
        baseUrl,
        '/admin/groups/' + encodeURIComponent(groupId),
        'PUT',
        patch,
        fetchImpl,
    );
}

/** PUT /admin/guard-policy → 落库后的策略 */
export function putServerGuardPolicy(
    baseUrl: string,
    policy: GuardPenaltyPolicy,
    fetchImpl: FetchLike = fetch,
): Promise<AdminResult<GuardPenaltyPolicy>> {
    return adminRequest<GuardPenaltyPolicy>(baseUrl, '/admin/guard-policy', 'PUT', policy, fetchImpl);
}

/** GET /admin/guard-policy（排障用；页面读缓存即可） */
export function getServerGuardPolicy(
    baseUrl: string,
    fetchImpl: FetchLike = fetch,
): Promise<AdminResult<GuardPenaltyPolicy>> {
    return adminRequest<GuardPenaltyPolicy>(baseUrl, '/admin/guard-policy', 'GET', undefined, fetchImpl);
}
