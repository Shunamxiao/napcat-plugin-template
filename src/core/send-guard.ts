/**
 * 发送熔断 — 同一群/同一用户连续发送失败达阈值后暂停发送，冷却到期自动恢复。
 *
 * - 计数在内存里按 key（group:<群号> / private:<QQ号>）维度保存；
 * - 成功一次即清零；
 * - 进入熔断时只记一条日志，冷却结束（定时器或下次访问时）记一条恢复日志；
 * - 纯类实现，时钟与定时器可注入，便于单测。
 */

export interface SendGuardHooks {
    /** 进入熔断时回调（阈值次失败之后调用一次） */
    onOpen?: (key: string, failures: number, cooldownMs: number) => void;
    /** 冷却到期恢复时回调一次 */
    onRecover?: (key: string) => void;
}

export interface SendGuardOptions {
    hooks?: SendGuardHooks;
    /** 注入时钟（单测用），默认 Date.now */
    now?: () => number;
}

interface GuardEntry {
    failures: number;
    /** 0 = 未熔断；否则为冷却结束时间戳 */
    openUntil: number;
    timer?: ReturnType<typeof setTimeout>;
}

export interface FailureResult {
    /** 本次失败是否触发了熔断 */
    opened: boolean;
    /** 当前连续失败次数（触发熔断时为阈值） */
    failures: number;
    /** 熔断结束时间戳；未熔断为 0 */
    openUntil: number;
}

export class SendGuard {
    private readonly entries = new Map<string, GuardEntry>();
    private readonly hooks: SendGuardHooks;
    private readonly now: () => number;

    constructor(options: SendGuardOptions = {}) {
        this.hooks = options.hooks ?? {};
        this.now = options.now ?? Date.now;
    }

    /** 当前是否处于冷却中（到期会自动恢复并触发 onRecover） */
    isOpen(key: string): boolean {
        const entry = this.entries.get(key);
        if (!entry || !entry.openUntil) return false;
        if (this.now() < entry.openUntil) return true;
        this.recover(key, entry);
        return false;
    }

    /** 发送成功：连续失败清零，并解除熔断（正常情况下熔断中不会发送） */
    onSuccess(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
        }
        entry.failures = 0;
        entry.openUntil = 0;
        this.entries.delete(key);
    }

    /** 发送失败：累计连续失败，达到阈值即熔断 */
    onFailure(key: string, threshold: number, cooldownMs: number): FailureResult {
        const entry = this.entryOf(key);
        // 已在熔断中（理论不会走到这里，防御性处理）
        if (entry.openUntil && this.now() < entry.openUntil) {
            return { opened: false, failures: entry.failures, openUntil: entry.openUntil };
        }
        entry.failures += 1;
        if (entry.failures < threshold) {
            return { opened: false, failures: entry.failures, openUntil: 0 };
        }
        const cooldown = Math.max(1, Math.round(cooldownMs));
        entry.openUntil = this.now() + cooldown;
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            if (entry.openUntil && this.now() >= entry.openUntil) this.recover(key, entry);
        }, cooldown);
        // 不因熔断定时器拖住进程退出
        (entry.timer as { unref?: () => void }).unref?.();
        this.hooks.onOpen?.(key, entry.failures, cooldown);
        return { opened: true, failures: entry.failures, openUntil: entry.openUntil };
    }

    /** 清空所有状态（配置重载/插件卸载用） */
    reset(): void {
        for (const entry of this.entries.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        this.entries.clear();
    }

    /** 当前连续失败次数（只读，排障用） */
    failuresOf(key: string): number {
        return this.entries.get(key)?.failures ?? 0;
    }

    private entryOf(key: string): GuardEntry {
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { failures: 0, openUntil: 0 };
            this.entries.set(key, entry);
        }
        return entry;
    }

    private recover(key: string, entry: GuardEntry): void {
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
        }
        entry.failures = 0;
        entry.openUntil = 0;
        this.entries.delete(key);
        this.hooks.onRecover?.(key);
    }
}
