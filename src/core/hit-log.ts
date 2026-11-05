/**
 * 命中日志环形缓冲（只存内存，进程重启即清空）
 *
 * 记录每条消息的命中/未命中结果，供 WebUI「命中日志」tab 展示最近 N 条。
 * 不写磁盘：日志只用于现场排查，避免长期运行把磁盘写满。
 */

export interface HitLogEntry {
    /** ISO 时间 */
    ts: string;
    /** 渠道：private 私聊 / group 群聊 */
    channel: 'private' | 'group';
    groupId?: string;
    userId: string;
    /** 结果码：answered / silent / cooldown / guard / service_down … */
    result: string;
    /** 补充说明（命中规则、跳过原因、来源 rule/ai/default） */
    detail?: string;
}

export class HitLog {
    private entries: HitLogEntry[] = [];

    constructor(
        private readonly capacity = 200,
        private readonly now: () => number = Date.now,
    ) { }

    add(entry: HitLogEntry): void {
        this.removeExpired();
        if (this.isExpired(entry)) return;
        this.entries.push(entry);
        if (this.entries.length > this.capacity) {
            this.entries.splice(0, this.entries.length - this.capacity);
        }
    }

    /** 最近 limit 条，新的在前 */
    list(limit = 50): HitLogEntry[] {
        this.removeExpired();
        const n = Math.max(1, Math.min(this.capacity, Math.floor(limit)));
        return this.entries.slice(-n).reverse();
    }

    clear(): void {
        this.entries = [];
    }

    size(): number {
        this.removeExpired();
        return this.entries.length;
    }

    private isExpired(entry: HitLogEntry): boolean {
        const timestamp = Date.parse(entry.ts);
        return Number.isFinite(timestamp) && timestamp < this.now() - 30 * 24 * 60 * 60 * 1000;
    }

    private removeExpired(): void {
        this.entries = this.entries.filter((entry) => !this.isExpired(entry));
    }
}

/** 进程内单例：所有消息处理路径共用 */
export const hitLog = new HitLog();
