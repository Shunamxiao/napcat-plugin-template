/**
 * 回复对刷防护
 *
 * 两个机器人同群共用一套关键词时，A 的回复会触发 B 的规则、B 的回复再触发 A，形成无限对刷。
 * 这里提供三层可独立测试的状态：
 *   1) 自回声：入群/私聊文本与本目标 60 秒内最后一条已发回复完全相同 → 丢弃
 *   2) 群内熔断：同一群窗口内已发出 >= maxReplies 条 → 暂停 pauseMs，期间不发送
 *   3) 忽略发送者由 handleMessage 入口处理（纯配置，无需状态）
 */

export interface LoopGuardOptions {
    /** 窗口内最多发出条数（达到后暂停） */
    maxReplies: number;
    /** 统计窗口(毫秒) */
    windowMs: number;
    /** 暂停时长(毫秒) */
    pauseMs: number;
    /** 自回声比对窗口(毫秒)，默认 60 秒 */
    echoWindowMs?: number;
    /** 可注入的时钟，便于单测 */
    now?: () => number;
}

export interface SendVerdict {
    allowed: boolean;
    /** 本次调用刚好触发熔断（用于只记一行日志） */
    justPaused: boolean;
    /** 仍在暂停中时距离恢复的毫秒数 */
    remainingMs?: number;
}

export class LoopGuard {
    private maxReplies = 5;
    private windowMs = 60_000;
    private pauseMs = 300_000;
    private echoWindowMs = 60_000;
    private now: () => number = Date.now;

    /** key = group:<群号>，只统计群内发出 */
    private sent = new Map<string, number[]>();
    private pausedUntil = new Map<string, number>();
    /** key = group:<群号> / private:<QQ号>，只保留最后一条 */
    private lastReply = new Map<string, { text: string; ts: number }>();

    constructor(options?: Partial<LoopGuardOptions>) {
        this.configure(options);
    }

    /** 配置热更新：每次发送前由调用方同步最新配置 */
    configure(options?: Partial<LoopGuardOptions>): void {
        if (!options) return;
        if (Number.isFinite(options.maxReplies) && options.maxReplies! > 0) this.maxReplies = Math.floor(options.maxReplies!);
        if (Number.isFinite(options.windowMs) && options.windowMs! > 0) this.windowMs = options.windowMs!;
        if (Number.isFinite(options.pauseMs) && options.pauseMs! > 0) this.pauseMs = options.pauseMs!;
        if (Number.isFinite(options.echoWindowMs) && options.echoWindowMs! > 0) this.echoWindowMs = options.echoWindowMs!;
        if (typeof options.now === 'function') this.now = options.now;
    }

    /** 发送前检查：暂停中或窗口内已达阈值都返回 allowed=false */
    allowSend(key: string): SendVerdict {
        const now = this.now();
        const until = this.pausedUntil.get(key);
        if (until !== undefined) {
            if (now < until) return { allowed: false, justPaused: false, remainingMs: until - now };
            // 暂停到期：清空窗口，重新计数
            this.pausedUntil.delete(key);
            this.sent.delete(key);
        }
        const recent = (this.sent.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
        this.sent.set(key, recent);
        if (recent.length >= this.maxReplies) {
            this.pausedUntil.set(key, now + this.pauseMs);
            return { allowed: false, justPaused: true, remainingMs: this.pauseMs };
        }
        return { allowed: true, justPaused: false };
    }

    /** 发送成功后记录：群内计数 + 最后一条回复文本（用于自回声比对） */
    recordSend(key: string, text: string): void {
        const now = this.now();
        if (key.startsWith("group:")) {
            const recent = (this.sent.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
            recent.push(now);
            this.sent.set(key, recent);
        }
        const value = String(text ?? "").trim();
        if (value) this.lastReply.set(key, { text: value, ts: now });
    }

    /** 本条文本是否等于最近 60 秒内本目标最后一条已发回复 */
    isSelfEcho(key: string, text: string): boolean {
        const last = this.lastReply.get(key);
        if (!last) return false;
        if (this.now() - last.ts > this.echoWindowMs) return false;
        return String(text ?? "").trim() === last.text;
    }

    /** 单测/排障用：当前暂停剩余毫秒（未暂停为 0） */
    pausedRemainingMs(key: string): number {
        const until = this.pausedUntil.get(key);
        if (until === undefined) return 0;
        return Math.max(0, until - this.now());
    }
}
