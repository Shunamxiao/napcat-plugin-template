/**
 * 转人工追问会话（纯逻辑，不发消息）
 *
 * 一个「用户 + 会话（私聊/群）」在任一时刻最多一个会话；
 * 答案按问题顺序收集，超时由调用方处理（5 分钟）。
 */

export interface CollectAnswer {
    q: string;
    a: string;
}

export interface CollectSession {
    key: string;
    userId: string;
    groupId?: string;
    /** 触发转人工的原始问题 */
    triggerText: string;
    /** 触发规则 */
    rule?: string;
    questions: string[];
    /** 下一个待问的题号 */
    cursor: number;
    answers: CollectAnswer[];
    startedAt: number;
    /** 超时定时器；调用方负责 arm/clear */
    timer?: ReturnType<typeof setTimeout>;
    /** 超时回发时复用的消息事件 */
    event?: unknown;
}

export type CollectStore = Map<string, CollectSession>;

/** 5 分钟未回答按超时处理 */
export const COLLECT_TIMEOUT_MS = 5 * 60 * 1000;

export function collectKey(kind: 'private' | 'group', userId: string, groupId?: string): string {
    return kind === 'private' ? 'private:' + userId : 'group:' + (groupId ?? '') + ':' + userId;
}

export function beginCollect(
    store: CollectStore,
    key: string,
    init: { userId: string; groupId?: string; triggerText: string; rule?: string; questions: string[] },
): CollectSession {
    const session: CollectSession = {
        key,
        userId: init.userId,
        groupId: init.groupId,
        triggerText: init.triggerText,
        rule: init.rule,
        questions: init.questions,
        cursor: 0,
        answers: [],
        startedAt: Date.now(),
    };
    store.set(key, session);
    return session;
}

/** 记录一条回答；返回是否结束及下一题 */
export function stepCollect(session: CollectSession, answer: string): { done: boolean; nextQuestion?: string } {
    const q = session.questions[session.cursor] ?? '';
    session.answers.push({ q, a: String(answer ?? '').trim() });
    session.cursor += 1;
    if (session.cursor >= session.questions.length) return { done: true };
    return { done: false, nextQuestion: session.questions[session.cursor] };
}

export function clearCollect(store: CollectStore, session: CollectSession): void {
    if (session.timer) {
        clearTimeout(session.timer);
        session.timer = undefined;
    }
    if (store.get(session.key) === session) store.delete(session.key);
}

export function getCollect(store: CollectStore, key: string): CollectSession | undefined {
    return store.get(key);
}
