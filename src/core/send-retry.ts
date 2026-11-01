/**
 * 发送重试 — 群消息发送失败（EventChecker Failed 等）时只重试一次，避免刷屏。
 * 纯函数式，便于单测；实际发送与日志由调用方注入。
 */

export interface SendAttemptResult {
    ok: boolean;
    attempts: number;
    errors: unknown[];
}

/**
 * @param send        实际发送动作
 * @param maxAttempts 最多尝试次数；上限 2（只允许重试一次）
 * @param onError     每次失败后的回调（attempt 从 1 开始）
 */
export async function sendWithRetry(
    send: () => Promise<void>,
    maxAttempts = 2,
    onError?: (error: unknown, attempt: number) => void,
): Promise<SendAttemptResult> {
    const requested = Number.isFinite(maxAttempts) ? Math.floor(maxAttempts) : 2;
    const limit = Math.min(2, Math.max(1, requested));
    const errors: unknown[] = [];
    for (let attempt = 1; attempt <= limit; attempt++) {
        try {
            await send();
            return { ok: true, attempts: attempt, errors };
        } catch (error) {
            errors.push(error);
            onError?.(error, attempt);
        }
    }
    return { ok: false, attempts: limit, errors };
}
