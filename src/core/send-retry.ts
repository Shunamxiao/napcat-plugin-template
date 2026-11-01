/**
 * 发送重试与失败分型 — 避免短时反复打 send_msg 触发风控。
 *
 * - QQ 侧拒绝（EventChecker Failed / result:120 / 被禁言 / 被移出群等）：不重试。
 * - 网络/超时类错误：最多重试 1 次，且两次尝试之间至少间隔 2 秒。
 * 纯函数式，便于单测；实际发送、等待与日志由调用方注入。
 */

export type SendErrorKind = 'qq_reject' | 'network';

/** 失败分型：QQ 客户端侧拒绝 vs 网络/超时 */
export function classifySendError(error: unknown): SendErrorKind {
    const text = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : String((error as Record<string, unknown> | null)?.message ?? error ?? '');
    if (/EventChecker Failed|result\s*[:=]?\s*120\b|你已被移出|被禁言|禁言中|权限不足|not allowed to send/i.test(text)) {
        return 'qq_reject';
    }
    return 'network';
}

export interface SendAttemptResult {
    ok: boolean;
    attempts: number;
    errors: unknown[];
    /** 最后一次失败的分型；成功时为 undefined */
    kind?: SendErrorKind;
}

export interface SendRetryOptions {
    /** 重试间隔毫秒，生产强制不小于 2000（默认 2000） */
    retryDelayMs?: number;
    /** 自定义等待函数（单测注入，避免真等） */
    sleep?: (ms: number) => Promise<void>;
    /** 是否允许重试这次失败；默认允许（调用方按 classifySendError 传入） */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export const MIN_RETRY_DELAY_MS = 2000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param send        实际发送动作
 * @param maxAttempts 最多尝试次数；上限 2（只允许重试一次）
 * @param onError     每次失败后的回调（attempt 从 1 开始）
 * @param options     重试间隔 / 等待实现 / 重试判定
 */
export async function sendWithRetry(
    send: () => Promise<void>,
    maxAttempts = 2,
    onError?: (error: unknown, attempt: number) => void,
    options: SendRetryOptions = {},
): Promise<SendAttemptResult> {
    const requested = Number.isFinite(maxAttempts) ? Math.floor(maxAttempts) : 2;
    const limit = Math.min(2, Math.max(1, requested));
    const errors: unknown[] = [];
    const sleep = options.sleep ?? defaultSleep;
    const delay = Math.max(MIN_RETRY_DELAY_MS, options.retryDelayMs ?? MIN_RETRY_DELAY_MS);
    for (let attempt = 1; attempt <= limit; attempt++) {
        try {
            await send();
            return { ok: true, attempts: attempt, errors };
        } catch (error) {
            errors.push(error);
            onError?.(error, attempt);
            if (attempt >= limit) break;
            if (options.shouldRetry && !options.shouldRetry(error, attempt)) break;
            await sleep(delay);
        }
    }
    const last = errors[errors.length - 1];
    return { ok: false, attempts: errors.length, errors, kind: classifySendError(last) };
}
