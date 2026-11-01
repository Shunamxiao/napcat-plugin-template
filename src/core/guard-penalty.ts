/**
 * 群内容守卫的处罚计数（纯逻辑 + 可注入依赖，便于单测）
 *
 * 规则：同一 groupId:userId 在 windowSeconds 内命中屏蔽词达到 threshold 次，
 * 调用 set_group_ban 禁言 muteSeconds 秒并发 muteText；禁言失败降级为警告，
 * 只记日志、不重试。计数与策略默认来自服务端，本地只保留兜底默认值。
 */

import type { GuardPenaltyPolicy } from '../types';

/** 本地兜底策略：服务端不可用/尚未同步时使用 */
export const DEFAULT_GUARD_POLICY: GuardPenaltyPolicy = {
    windowSeconds: 600,
    threshold: 3,
    muteSeconds: 600,
    warnText: '请文明发言，违规内容将被撤回。',
    muteText: '因多次触发屏蔽词，已被禁言。',
};

/** 内存计数：key = groupId:userId，value = 窗口内命中时间戳 */
export class GuardPenaltyCounter {
    private hits = new Map<string, number[]>();

    /** 记录一次命中并返回窗口内累计次数（自动丢弃窗口外的旧记录） */
    record(key: string, nowMs: number, windowMs: number): number {
        const cutoff = nowMs - Math.max(0, windowMs);
        const previous = this.hits.get(key) ?? [];
        const kept = previous.filter((ts) => ts > cutoff);
        kept.push(nowMs);
        this.hits.set(key, kept);
        // 长期运行时防止 Map 无限增长：条目过多时顺手清掉所有已过期键
        if (this.hits.size > 5000) this.prune(nowMs, windowMs);
        return kept.length;
    }

    /** 清空某个目标的计数（禁言触发/失败后都清零） */
    reset(key: string): void {
        this.hits.delete(key);
    }

    clear(): void {
        this.hits.clear();
    }

    size(): number {
        return this.hits.size;
    }

    private prune(nowMs: number, windowMs: number): void {
        const cutoff = nowMs - Math.max(0, windowMs);
        for (const [key, times] of this.hits) {
            const kept = times.filter((ts) => ts > cutoff);
            if (kept.length === 0) this.hits.delete(key);
            else this.hits.set(key, kept);
        }
    }
}

/** 进程内单例：插件热重载时由 clearGuardPenalty 清空 */
export const guardPenaltyCounter = new GuardPenaltyCounter();

export interface GuardPenaltyDeps {
    /** 禁言；抛错表示失败（非管理员/权限不足/事件拒绝） */
    setBan: (groupId: string, userId: string, seconds: number) => Promise<unknown>;
    /** 发群消息（警告/禁言提示） */
    sendText: (groupId: string, text: string) => Promise<unknown>;
    log?: (level: 'info' | 'warn', message: string) => void;
    now?: () => number;
    counter?: GuardPenaltyCounter;
}

export interface GuardPenaltyResult {
    /** 本次命中后窗口内的累计次数 */
    count: number;
    /** 是否达到阈值（达到即尝试禁言） */
    reached: boolean;
    /** 禁言是否成功 */
    banned: boolean;
    /** 禁言失败后是否已降级为警告 */
    degraded: boolean;
}

/**
 * 记录一次守卫命中并按策略处罚。
 * 绝不抛异常：所有失败都收敛成 degraded=true 并写 warn 日志。
 */
export async function applyGuardPenalty(args: {
    groupId: string;
    userId: string;
    policy: GuardPenaltyPolicy;
    deps: GuardPenaltyDeps;
}): Promise<GuardPenaltyResult> {
    const { groupId, userId, policy, deps } = args;
    const counter = deps.counter ?? guardPenaltyCounter;
    const now = deps.now ?? Date.now;
    const log = deps.log ?? (() => { /* 调用方未注入日志时静默 */ });
    const key = groupId + ':' + userId;

    const count = counter.record(key, now(), policy.windowSeconds * 1000);
    if (count < policy.threshold) {
        return { count, reached: false, banned: false, degraded: false };
    }

    // 达到阈值：先清零再执行，避免禁言调用卡住时后续消息重复累加
    counter.reset(key);

    try {
        await deps.setBan(groupId, userId, policy.muteSeconds);
        log('info', '[群守卫] reason=guard_mute group=' + groupId + ' user=' + userId + ' seconds=' + policy.muteSeconds);
        const muteText = String(policy.muteText ?? '').trim();
        if (muteText) {
            try {
                await deps.sendText(groupId, muteText);
                log('info', '[群守卫] reason=guard_mute_notice group=' + groupId + ' user=' + userId);
            } catch (e) {
                log('warn', '[群守卫] reason=guard_mute_notice_failed group=' + groupId + ' user=' + userId +
                    ' error=' + errorMessage(e));
            }
        }
        return { count, reached: true, banned: true, degraded: false };
    } catch (e) {
        // 禁言失败：降级为警告，不重试
        log('warn', '[群守卫] reason=guard_mute_failed group=' + groupId + ' user=' + userId +
            ' error=' + errorMessage(e));
        const warnText = String(policy.warnText ?? '').trim();
        if (warnText) {
            try {
                await deps.sendText(groupId, warnText);
            } catch (sendError) {
                log('warn', '[群守卫] reason=guard_warn_failed group=' + groupId + ' user=' + userId +
                    ' error=' + errorMessage(sendError));
            }
        }
        return { count, reached: true, banned: false, degraded: true };
    }
}

/** 插件卸载/热重载：清空处罚计数 */
export function clearGuardPenalty(): void {
    guardPenaltyCounter.clear();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}
