/**
 * 三层判定（纯逻辑，无副作用）
 *
 *   ① 服务侧拉黑命中 → 任何回复都不发
 *   ② 命中关键词规则 → 按原话术回复；规则 aiFallback=true 时先问服务，拿不到再退回规则
 *   ③ 未命中规则 → 满足触发条件时问服务，reply 为空/失败维持现状
 *
 * 消息处理器只负责取参数、调服务、发消息；这里不碰网络与全局状态，便于单测。
 */

import type { BlockUser, KeywordRule } from '../types';
import { isBlocked } from './blocklist';

export type IncomingKind = 'private' | 'group';

export interface AiTriggerLike {
    private: boolean;
    groupAtOnly: boolean;
}

export interface PlanInput {
    kind: IncomingKind;
    userId: string;
    /** 群内是否 @机器人/回复机器人；私聊传 false */
    atBot: boolean;
    /** 命中的关键词规则；未命中为 null */
    rule: KeywordRule | null;
    /** 服务侧拉黑缓存 */
    blockUsers?: BlockUser[];
    /** 知识库/AI 总开关 */
    kbEnabled: boolean;
    aiTrigger: AiTriggerLike;
    /** 群规则是否显式禁用 AI；私聊传 true。false 时该群任何 AI 调用都跳过 */
    groupAiEnabled?: boolean;
}

export type Plan =
    | { kind: 'blocked' }
    | { kind: 'rule'; rule: KeywordRule }
    | { kind: 'rule-ai'; rule: KeywordRule }
    | { kind: 'rule-ai-only'; rule: KeywordRule }
    | { kind: 'rule-human'; rule: KeywordRule }
    | { kind: 'ai' }
    | { kind: 'none'; reason: string };

export interface AskLike {
    reply?: string;
    action?: string;
}

export interface SendDecision {
    send: boolean;
    text?: string;
    image?: string;
    source: 'rule' | 'ai' | 'default' | 'none';
}

/** 从回复池随机取一条；replies 为空时回退到 reply */
export function pickReply(rule: KeywordRule): string {
    if (Array.isArray(rule.replies)) {
        const pool = rule.replies.filter((item) => typeof item === 'string' && item.trim());
        if (pool.length > 0) {
            return pool[Math.floor(Math.random() * pool.length)];
        }
    }
    return rule.reply || '';
}

/** 按三层顺序给出本轮动作；这是唯一决定「要不要问服务」的地方。 */
export function planReply(input: PlanInput): Plan {
    if (isBlocked(input.userId, input.blockUsers)) return { kind: 'blocked' };

    if (input.rule) {
        const action = input.rule.action ?? 'reply';
        // 转人工：不查 FAQ、不调 AI，直接回话术
        if (action === 'human') return { kind: 'rule-human', rule: input.rule };
        // 直接问服务：跳过规则文案；服务不可用时回落到文案，避免静默
        if (action === 'ai') {
            const available = input.kbEnabled && input.groupAiEnabled !== false;
            return available ? { kind: 'rule-ai-only', rule: input.rule } : { kind: 'rule', rule: input.rule };
        }
        const wantsAi = input.rule.aiFallback === true && input.kbEnabled && input.groupAiEnabled !== false;
        return wantsAi ? { kind: 'rule-ai', rule: input.rule } : { kind: 'rule', rule: input.rule };
    }

    if (!input.kbEnabled) return { kind: 'none', reason: 'kb_disabled' };

    if (input.kind === 'private') {
        return input.aiTrigger.private ? { kind: 'ai' } : { kind: 'none', reason: 'private_trigger_off' };
    }

    if (input.groupAiEnabled === false) return { kind: 'none', reason: 'group_ai_disabled' };
    if (input.aiTrigger.groupAtOnly && !input.atBot) return { kind: 'none', reason: 'group_need_at' };
    return { kind: 'ai' };
}

function ruleSend(rule: KeywordRule): SendDecision {
    const text = pickReply(rule);
    if (!text && !rule.image) return { send: false, source: 'none' };
    return { send: true, text, image: rule.image, source: 'rule' };
}

/**
 * 结合服务返回决定最终发什么：
 * - 有非空 AI 回复 → 发 AI 回复（rule-ai / rule-ai-only 命中规则时也一样）
 * - rule-ai 拿不到 → 退回规则原话术
 * - rule-ai-only / ai / none 拿不到 → 走兜底：私聊必回 privateText；群内 @ 必回 groupAtText；群内未 @ 静默
 * - rule-human → 不查 FAQ、不调 AI，直接走兜底话术（转人工）
 * - blocked 用户任何消息都不发
 */
export function resolveSend(args: {
    plan: Plan;
    ask: AskLike | null;
    kind: IncomingKind;
    defaultReply?: string;
    groupFallback?: string;
    atBot?: boolean;
}): SendDecision {
    const { plan, ask, kind } = args;
    if (plan.kind === 'blocked') return { send: false, source: 'none' };
    if (plan.kind === 'rule') return ruleSend(plan.rule);

    // 只有 plan 明确要问服务时才采信 ask；none 计划即使带了 ask 也不能改行为
    const wantsAsk = plan.kind === 'ai' || plan.kind === 'rule-ai' || plan.kind === 'rule-ai-only';
    const aiText = wantsAsk && ask && typeof ask.reply === 'string' ? ask.reply.trim() : '';
    if (aiText) return { send: true, text: aiText, source: 'ai' };

    if (plan.kind === 'rule-ai') return ruleSend(plan.rule);

    // rule-ai-only / rule-human / ai / none：按场景回兜底话术
    const fallback = kind === 'private'
        ? String(args.defaultReply ?? '').trim()
        : (args.atBot === true ? String(args.groupFallback ?? '').trim() : '');
    return fallback ? { send: true, text: fallback, source: 'default' } : { send: false, source: 'none' };
}
