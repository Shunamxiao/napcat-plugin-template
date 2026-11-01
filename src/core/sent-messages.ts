/**
 * 本实例已发送消息的 message_id 登记表
 *
 * 用途：群里有人引用机器人自己的消息追问时，即使没有 @ 也视为定向提问。
 * 部分 OneBot 实现的 reply 段只带 id、不带原发送者 qq，因此必须自己记下发出过的 id。
 * 只保留最近 24 小时、最多 2000 条，避免长期运行内存膨胀；进程重启后旧 id 丢失，
 * 这符合“引用追问通常发生在近期消息”的实际使用场景。
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

/** message_id -> 发送时间戳；Map 的插入顺序用于 LRU/过期清理 */
const sent = new Map<string, number>();

/** 从 send_msg 返回值里取 message_id（兼容对象、数组、direct 值） */
function pickMessageId(result: unknown): string {
    if (Array.isArray(result)) {
        for (const item of result) {
            const id = pickMessageId(item);
            if (id) return id;
        }
        return '';
    }
    if (result === null || result === undefined) return '';
    if (typeof result === 'string' || typeof result === 'number') return String(result).trim();
    if (typeof result !== 'object') return '';
    const obj = result as Record<string, unknown>;
    const raw = obj.message_id ?? (obj.data as Record<string, unknown> | undefined)?.message_id;
    if (raw === null || raw === undefined) return '';
    return String(raw).trim();
}

function prune(now: number): void {
    for (const [id, ts] of sent) {
        if (now - ts <= TTL_MS && sent.size <= MAX_ENTRIES) break;
        sent.delete(id);
    }
}

/** 发送成功后调用：登记本实例发出的 message_id（空 / 0 不记） */
export function rememberSentMessage(result: unknown): void {
    const id = pickMessageId(result);
    if (!id || id === '0') return;
    sent.delete(id);
    sent.set(id, Date.now());
    prune(Date.now());
}

/** 该 message_id 是否由本实例发出（且在有效期内） */
export function isSentByThisInstance(id: unknown): boolean {
    const key = typeof id === 'string' || typeof id === 'number' ? String(id).trim() : '';
    if (!key) return false;
    const ts = sent.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > TTL_MS) {
        sent.delete(key);
        return false;
    }
    return true;
}

/** 测试 / 插件卸载用：清空登记表 */
export function clearSentMessages(): void {
    sent.clear();
}
