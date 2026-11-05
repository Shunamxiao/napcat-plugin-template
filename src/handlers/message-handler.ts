/**
 * 消息处理器 — QQ 自动回复核心逻辑
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext, SendMessageSegment, SendMsgParams } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { isBlocked } from '../core/blocklist';
import { pickReply, planReply, resolveSend, type Plan, type SendDecision } from '../core/escalation';
import { resolveEffectiveGroupCooldown, resolveEffectiveGroupFallback, resolveEffectiveGroupPolicy } from '../core/group-config';
import { hitLog } from '../core/hit-log';
import { recordKeywordHit } from '../core/keyword-stats';
import { recordTrafficIncoming, recordTrafficReply, type TrafficReplySource } from '../core/traffic-stats';
import { appendHandoffRecord } from '../core/handoff';
import { classifySendError, sendWithRetry } from '../core/send-retry';
import { SendGuard } from '../core/send-guard';
import { LoopGuard } from '../core/loop-guard';
import { runGroupGuard } from '../core/content-guard';
import { isSentByThisInstance, rememberSentMessage } from '../core/sent-messages';
import {
    beginCollect,
    clearCollect,
    collectKey,
    COLLECT_TIMEOUT_MS,
    getCollect,
    stepCollect,
    type CollectAnswer,
    type CollectSession,
} from '../core/collect';
import { askServiceOutcome, notifyHandoff, type ServiceFailure } from '../services/kb-client';
import type { KeywordRule } from '../types';
import fs from 'fs';
import path from 'path';

const CLAIM_DIR = '/root/qq-accounts/shared/claims';

/** /answer 超时、5xx、连接失败时给用户的一次性降级提示 */
export const SERVICE_DOWN_REPLY = '我这边有点卡，先记下你的问题，稍后再试一次～';
/** 同一用户 10 分钟内最多收到一次服务降级提示，避免连发刷屏 */
export const SERVICE_DOWN_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;

/** 多账号同群防重复:同一群同一条消息只允许一个实例回复(跨实例共享 claim 文件) */
function tryClaimReply(messageId: string, groupId: string): boolean {
    if (pluginState.config.crossAccountDedup === false) return true;
    if (!messageId) return true;
    try {
        fs.mkdirSync(CLAIM_DIR, { recursive: true });
        const file = path.join(CLAIM_DIR, groupId + "_" + messageId + ".claim");
        const fd = fs.openSync(file, "wx");
        try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
        // 顺带清理 10 分钟前的旧 claim,避免目录膨胀
        try {
            for (const f of fs.readdirSync(CLAIM_DIR)) {
                const fp = path.join(CLAIM_DIR, f);
                const st = fs.statSync(fp);
                if (Date.now() - st.mtimeMs > 600000) fs.unlinkSync(fp);
            }
        } catch { /* 清理失败不影响主流程 */ }
        return true;
    } catch (e) {
        // EEXIST = 其他账号已抢先回复
        return (e as any)?.code !== "EEXIST";
    }
}

export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    const config = pluginState.config;

    const kind = event.message_type;
    if (kind !== 'private' && kind !== 'group') return;

    const senderId = String(event.sender?.user_id ?? 0);
    const groupId = kind === 'group' ? String(event.group_id ?? '') : undefined;
    /** 流量统计口径：只允许 private / group:<群号> */
    const trafficScope = kind === 'group' ? 'group:' + (groupId ?? '') : 'private';
    // 收到即计数：黑名单/忽略发送者的消息也算收到，replies 只算真正发出的
    recordTrafficIncoming(trafficScope, senderId);

    const text = extractText(event);
    // 群内容守卫独立于自动回复总开关：命中即撤回/警告并短路，不再走规则与 FAQ
    if (kind === 'group' && await runGroupGuard(ctx, event, text)) return;

    if (!config.enabled) return;
    pluginState.incrementProcessed();

    // self_id 优先取事件本身，其次取 init 时 get_login_info 的结果。
    // ctx.pluginManager.config 里不保证有 self_id（历史 bug：取不到导致 atBot 恒为 false，群 @ 被静默）。
    const selfId = String(event.self_id || pluginState.selfId || ctx.pluginManager.config?.self_id || '');

    const atBot = kind === 'group' ? isDirectedAtBot(event, selfId) : false;

    /**
     * 统一记录「本条不回复」：命中日志页只放英文原因码，中文说明同时写进运行日志。
     * 群内 @ 消息用 info（排障必看），非 @ 群消息与私聊用 debug（量大）。
     */
    const recordSkip = (code: string, zh: string, detail = ''): void => {
        const where = kind === 'group' ? ' group=' + groupId : ' user=' + senderId;
        const line = '[丢弃] ' + (kind === 'group' ? '群聊' : '私聊') + where +
            ' reason=' + code + (detail ? ' ' + detail : '') + '（' + zh + '）';
        if (kind === 'group' && !atBot) pluginState.logger.debug(line);
        else pluginState.logger.info(line);
        hitLog.add({
            ts: new Date().toISOString(),
            channel: kind,
            groupId,
            userId: senderId,
            result: 'silent',
            detail: code + ' ' + zh + (detail ? ' ' + detail : ''),
        });
    };

    // 不回复自己
    if (senderId === selfId || senderId === '0') {
        recordSkip('self_message', '发送者是机器人自己');
        return;
    }

    // 忽略发送者：两个机器人同群时填彼此的号，命中直接丢弃（不记冷却、不回复）
    const ignoreSenders = (config.ignoreSenders ?? []).map(String);
    if (ignoreSenders.includes(senderId)) {
        recordSkip('ignore_sender', '发送者在忽略名单');
        return;
    }

    // 黑名单:名单内用户直接跳过,不触发任何回复
    const blacklist = (config.blacklist ?? []).map(String);
    if (blacklist.includes(senderId)) {
        recordSkip('blacklist', '发送者在黑名单');
        return;
    }

    // ① 服务侧拉黑缓存:命中后任何回复都不发(含兜底与 AI)
    if (isBlocked(senderId, config.blocklist?.users)) {
        recordSkip('service_blocked', '服务侧拉黑命中');
        return;
    }

    if (!text) return;

    // 自回声保护：与本目标 60 秒内最后一条已发回复完全相同 → 丢弃，防被自己/对方复制触发
    if (getLoopGuard().isSelfEcho(replyKey(event), text)) {
        recordSkip('self_echo', '与本目标最近一条回复相同', 'text=' + text.slice(0, 40));
        return;
    }

    // 私聊：必回 —— 命中规则按规则，未命中/服务无答案一律发兜底话术
    if (kind === 'private') {
        if (!config.private.enabled) return;
        if (!checkWhitelist(config.private.whitelist, senderId)) return;
        // 追问中的消息是「答案」，必须逐条立即处理，不能参与连发合并
        if (getCollect(pluginState.collectSessions, collectKey('private', senderId))) {
            await processPrivateMessage(ctx, event, text);
            return;
        }
        queuePrivateMessage(ctx, event, senderId, text);
        return;
    }

    // 群聊：服务端条目 → 本地 groupRules → 全局 groupDefault（未配置群默认防刷口径）
    if (kind === 'group') {
        if (!config.group.enabled) { recordSkip('group_disabled', '群聊总开关关闭'); return; }
        if (!checkWhitelist(config.group.whitelist, groupId ?? '')) {
            recordSkip('group_not_whitelisted', '群不在白名单内');
            return;
        }
        // 生效口径：服务端有条目以服务端为准，否则本地 groupRules，再否则 groupDefault
        const policy = resolveEffectiveGroupPolicy(config, groupId ?? '');
        const mode = policy.mode.value;
        const missPolicy = policy.missPolicy.value;
        if (mode === 'off') { recordSkip('mode_off', '群模式=关闭，一律不回'); return; }
        // 追问中的用户消息优先作为答案消费；不要求 @，否则群内无法回答
        if (await consumeCollectAnswer(ctx, event, collectKey('group', senderId, groupId ?? ''), senderId, groupId, text, 'group')) return;
        const groupRule = config.groupRules?.[groupId ?? ''];
        // 群专属关键词非空时只按群规则匹配,避免全局规则串群
        const keywords = groupRule?.keywords?.length ? groupRule.keywords : config.keywords;
        const hit = matchKeywords(keywords, text);
        if (hit) recordKeywordHit(hit, trafficScope);
        // keywordOutsideAt 对 all / at 两种模式都生效：
        // - all：非 @ 命中关键词是否回；
        // - at：非 @ 只有命中关键词且该开关打开时才回，否则静默。
        const outsideAtAllowed = policy.keywordOutsideAt.value;
        if (!atBot && mode === 'at' && !(hit && outsideAtAllowed)) {
            if (hit) recordSkip('keyword_outside_at_off', '非@消息命中关键词，但「非@命中关键词也回」已关闭', 'rule=' + hit.match);
            else recordSkip('not_at', '群模式=仅@，本条未 @');
            return;
        }
        if (!atBot && mode === 'all' && hit && !outsideAtAllowed) {
            recordSkip('keyword_outside_at_off', '非@消息命中关键词，但「非@命中关键词也回」已关闭', 'rule=' + hit.match);
            return;
        }
        // 群内 AI 能力跟随未命中策略：只有 ai_then_fallback 才允许问服务（含规则 aiFallback）
        const aiAllowed = missPolicy === 'ai_then_fallback';
        const plan = hit
            ? planReply({
                kind: 'group',
                userId: senderId,
                atBot,
                rule: hit,
                blockUsers: config.blocklist?.users,
                kbEnabled: config.kbService?.enabled === true,
                aiTrigger: { private: config.aiTrigger.private, groupAtOnly: true },
                groupAiEnabled: aiAllowed,
            })
            : null;
        if (plan?.kind === 'blocked') { recordSkip('service_blocked', '服务侧拉黑命中'); return; }
        const cooldownSeconds = resolveEffectiveGroupCooldown(config, groupId ?? '');
        if (hit && plan && isRuleCooldown(senderId, plan, cooldownSeconds)) {
            recordSkip('cooldown', '同一用户命中同一规则仍在冷却期', 'rule=' + hit.match);
            return;
        }
        // 多账号同群去重:规则回复与 AI/兜底回复都只允许一个实例发
        if (!tryClaimReply(String(event.message_id ?? ''), groupId ?? '')) {
            recordSkip('dedup', '多实例去重命中');
            return;
        }
        // 命中规则且需要问服务，或未命中且策略要求先问 AI：都走一次 /answer
        const needsService = plan ? needsAsk(plan) : aiAllowed;
        const ask = needsService ? await askKnowledge(text, senderId, groupId, 'group_at') : null;
        if (plan && ask?.failure) {
            // 规则路径保持原行为：只对已定向（@/引用机器人）的群消息回降级提示
            if (atBot) {
                respondServiceDown(ctx, event, senderId, ask.failure, groupId);
                return;
            }
            pluginState.logger.debug('[知识库] 群内未定向，服务失败不降级 group=' + groupId + ' user=' + senderId);
        }
        if (!plan && ask?.failure) {
            // 未命中路径：失败按未命中策略回兜底，不再发服务降级提示
            pluginState.logger.warn(
                '[知识库] reason=service_down status=' + ask.failure.kind +
                (ask.failure.status !== undefined ? ' code=' + ask.failure.status : '') +
                ' → 回群兜底 group=' + groupId + ' user=' + senderId,
            );
        }
        if (plan?.kind === 'rule-human') {
            if (startCollect(ctx, event, senderId, groupId ?? '', text, plan.rule.match, 'group')) return;
            recordHandoff({ userId: senderId, groupId, text, rule: plan.rule.match, kind: 'group' });
            reportHandoff({ userId: senderId, groupId, text });
        }
        const fallbackText = resolveEffectiveGroupFallback(config, groupId ?? '');
        let out: SendDecision;
        if (plan) {
            out = resolveSend({
                plan,
                ask: ask?.reply ? { reply: ask.reply } : null,
                kind: 'group',
                // 能走到这里说明本条已被群模式放行，兜底不受「是否 @」限制
                atBot: true,
                groupFallback: fallbackText,
            });
        } else if (missPolicy === 'none') {
            // 不回复；仅 at 模式下被 @ 且 atForceReply 仍回兜底（老板要的「至少回复兜底」）
            if (mode === 'at' && atBot && policy.atForceReply.value) {
                out = fallbackText
                    ? { send: true, text: fallbackText, source: 'default' }
                    : { send: false, source: 'none' };
            } else {
                recordSkip('miss_policy_none', '未命中关键词且未命中策略=不回复');
                return;
            }
        } else {
            const aiText = ask?.reply?.trim() ?? '';
            if (aiText) out = { send: true, text: aiText, source: 'ai' };
            else if (fallbackText) out = { send: true, text: fallbackText, source: 'default' };
            else out = { send: false, source: 'none' };
        }
        if (!out.send || (!out.text && !out.image)) {
            recordSkip('no_content', '无可发送内容', 'plan=' + (plan?.kind ?? 'none') + ' mode=' + mode +
                ' 兜底=' + (fallbackText ? '有' : '空'));
            return;
        }
        hitLog.add({
            ts: new Date().toISOString(),
            channel: 'group',
            groupId,
            userId: senderId,
            result: 'answered',
            detail: (out.text || (out.image ? '[图片]' : '')).slice(0, 80) +
                ' source=' + out.source + ' mode=' + mode + ' miss=' + missPolicy,
        });
        scheduleReply(ctx, event, { text: out.text || '', image: out.image }, '[群聊] ' + groupId + sourceTag(out.source), out.source);
        return;
    }
}

/** 私聊连发合并：同一个用户窗口内的多条消息用换行拼接，只走一次问答 */
const MAX_MERGED_PRIVATE_MESSAGES = 5;

interface PrivateMergeBuffer {
    texts: string[];
    event: OB11Message;
    timer: ReturnType<typeof setTimeout>;
}

const privateMergeBuffers = new Map<string, PrivateMergeBuffer>();

/** 配置的合并窗口(毫秒)；0/非法值表示关闭，上限 60 秒 */
function privateMergeWindowMs(): number {
    const n = Number(pluginState.config.private?.mergeWindowMs ?? 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(60000, Math.floor(n));
}

/** 入缓冲；窗口内首条消息负责定时，满 5 条立即合并发送 */
function queuePrivateMessage(ctx: NapCatPluginContext, event: OB11Message, senderId: string, text: string): void {
    const windowMs = privateMergeWindowMs();
    if (windowMs <= 0) {
        void processPrivateMessage(ctx, event, text);
        return;
    }
    const existing = privateMergeBuffers.get(senderId);
    if (existing) {
        existing.texts.push(text);
        if (existing.texts.length >= MAX_MERGED_PRIVATE_MESSAGES) flushPrivateMerge(ctx, senderId);
        return;
    }
    const buffer: PrivateMergeBuffer = {
        texts: [text],
        event,
        timer: setTimeout(() => flushPrivateMerge(ctx, senderId), windowMs),
    };
    privateMergeBuffers.set(senderId, buffer);
    pluginState.pendingReplies.add(buffer.timer);
}

/** 合并并处理；用首条消息的事件作为回复目标 */
function flushPrivateMerge(ctx: NapCatPluginContext, senderId: string): void {
    const buffer = privateMergeBuffers.get(senderId);
    if (!buffer) return;
    privateMergeBuffers.delete(senderId);
    clearTimeout(buffer.timer);
    pluginState.pendingReplies.delete(buffer.timer);
    void processPrivateMessage(ctx, buffer.event, buffer.texts.join('\n'));
}

/** 插件卸载时清空未合并的消息，避免卸载后继续触发回复 */
export function clearPrivateMerge(): void {
    for (const buffer of privateMergeBuffers.values()) {
        clearTimeout(buffer.timer);
        pluginState.pendingReplies.delete(buffer.timer);
    }
    privateMergeBuffers.clear();
}

/** 私聊单次问答：合并后的文本也走原有冷却 / 配额 / 防互刷链路 */
async function processPrivateMessage(ctx: NapCatPluginContext, event: OB11Message, text: string): Promise<void> {
    const config = pluginState.config;
    if (!config.private.enabled) return;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? 0);
    if (!senderId || senderId === '0') return;
    // 缓冲期间配置可能被改，发送前再核一次白名单
    if (!checkWhitelist(config.private.whitelist, senderId)) return;
    // 追问中的用户消息优先作为答案消费，不再走关键词/FAQ
    if (await consumeCollectAnswer(ctx, event, collectKey('private', senderId), senderId, undefined, text, 'private')) return;
    const hit = matchKeywords(config.keywords, text);
    if (hit) recordKeywordHit(hit, 'private');
    const plan = planReply({
        kind: 'private',
        userId: senderId,
        atBot: false,
        rule: hit,
        blockUsers: config.blocklist?.users,
        kbEnabled: config.kbService?.enabled === true,
        aiTrigger: config.aiTrigger,
        groupAiEnabled: true,
    });
    // 规则命中(含 aiFallback/action)沿用原冷却粒度,冷却期内整条不发
    if (isRuleCooldown(senderId, plan, pluginState.config.cooldownSeconds ?? 0)) return;
    const ask = needsAsk(plan) ? await askKnowledge(text, senderId, undefined, 'private') : null;
    if (ask?.failure) {
        respondServiceDown(ctx, event, senderId, ask.failure);
        return;
    }
    if (plan.kind === 'rule-human') {
        if (startCollect(ctx, event, senderId, undefined, text, plan.rule.match, 'private')) return;
        recordHandoff({ userId: senderId, text, rule: plan.rule.match, kind: 'private' });
        reportHandoff({ userId: senderId, text });
    }
    const out = resolveSend({
        plan,
        ask: ask?.reply ? { reply: ask.reply } : null,
        kind: 'private',
        defaultReply: config.fallback?.privateText ?? '',
    });
    if (!out.send || (!out.text && !out.image)) {
        hitLog.add({
            ts: new Date().toISOString(),
            channel: 'private',
            userId: senderId,
            result: 'silent',
            detail: '无可发送内容 kind=' + plan.kind,
        });
        return;
    }
    hitLog.add({
        ts: new Date().toISOString(),
        channel: 'private',
        userId: senderId,
        result: 'answered',
        detail: (out.text || (out.image ? '[图片]' : '')).slice(0, 80) + ' source=' + out.source,
    });
    scheduleReply(ctx, event, { text: out.text || '', image: out.image }, '[私聊] ' + senderId + sourceTag(out.source), out.source);
}

/** 规则类计划共用的冷却键；AI/兜底不占用规则冷却。seconds 由调用方按群级/全局口径传入 */
function isRuleCooldown(senderId: string, plan: Plan, seconds: number): boolean {
    if (plan.kind === 'rule' || plan.kind === 'rule-ai' || plan.kind === 'rule-ai-only' || plan.kind === 'rule-human') {
        return isOnCooldown(senderId, plan.rule.match, seconds);
    }
    return false;
}

/**
 * action=human：
 * - collect 关闭（默认）→ 直接发兜底话术并留档
 * - collect 开启 → 先逐条追问，答完/超时后再发兜底话术，collected 一并留档
 * 全程不查 FAQ、不调 AI。
 */
function startCollect(
    ctx: NapCatPluginContext,
    event: OB11Message,
    userId: string,
    groupId: string | undefined,
    triggerText: string,
    rule: string,
    kind: 'private' | 'group',
): boolean {
    const conf = pluginState.config.collect;
    const questions = (conf?.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 10);
    if (!conf?.enabled || questions.length === 0) return false;
    const session = beginCollect(pluginState.collectSessions, collectKey(kind, userId, groupId), {
        userId,
        groupId,
        triggerText,
        rule,
        questions,
    });
    session.event = event;
    armCollectTimer(ctx, session, kind);
    pluginState.logger.info('[转人工追问] ' + kind + ' user=' + userId + (groupId ? ' group=' + groupId : '') + ' 共 ' + questions.length + ' 题');
    scheduleReply(ctx, event, { text: questions[0] }, '[转人工追问] ' + userId);
    return true;
}

/** 追问中的下一条消息作为答案；返回 true 表示已消费，不再走规则/FAQ */
async function consumeCollectAnswer(
    ctx: NapCatPluginContext,
    event: OB11Message,
    key: string,
    userId: string,
    groupId: string | undefined,
    text: string,
    kind: 'private' | 'group',
): Promise<boolean> {
    const session = getCollect(pluginState.collectSessions, key);
    if (!session) return false;
    const step = stepCollect(session, text);
    if (step.done) {
        finalizeCollect(ctx, session, kind, 'keyword_human');
        return true;
    }
    armCollectTimer(ctx, session, kind);
    scheduleReply(ctx, event, { text: step.nextQuestion ?? '' }, '[转人工追问] ' + userId);
    return true;
}

/** 每答一题重置 5 分钟超时；超时按已收集内容转人工 */
function armCollectTimer(ctx: NapCatPluginContext, session: CollectSession, kind: 'private' | 'group'): void {
    if (session.timer) clearTimeout(session.timer);
    const timer = setTimeout(() => {
        if (pluginState.collectSessions.get(session.key) !== session) return;
        session.timer = undefined;
        finalizeCollect(ctx, session, kind, 'collect_timeout');
    }, COLLECT_TIMEOUT_MS);
    session.timer = timer;
}

/** 结束追问：发兜底话术并留档（collected 可能为空） */
function finalizeCollect(
    ctx: NapCatPluginContext,
    session: CollectSession,
    kind: 'private' | 'group',
    reason: 'keyword_human' | 'collect_timeout',
): void {
    const answerEvent = session.event as OB11Message | undefined;
    clearCollect(pluginState.collectSessions, session);
    // 群里被移出白名单/关闭后不再补发，避免配置变更后继续发消息
    const groupActive = kind !== 'group' ||
        (resolveEffectiveGroupPolicy(pluginState.config, session.groupId ?? '')?.mode.value ?? 'off') !== 'off';
    const fallback = kind === 'private'
        ? pluginState.config.fallback?.privateText ?? ''
        : resolveEffectiveGroupFallback(pluginState.config, session.groupId ?? '');
    recordHandoff({
        userId: session.userId,
        groupId: session.groupId,
        text: session.triggerText,
        rule: session.rule,
        kind,
        reply: fallback,
        collected: session.answers,
        reason,
    });
    // 追问结果（可能为空）随转人工一起上报服务侧
    reportHandoff({
        userId: session.userId,
        groupId: session.groupId,
        text: session.triggerText,
        collected: session.answers,
    });
    if (fallback && answerEvent && groupActive) {
        scheduleReply(ctx, answerEvent, { text: fallback }, '[转人工] ' + session.userId, 'default');
    }
}

/** 写一条转人工留档；失败只告警，不影响回复 */
function recordHandoff(args: {
    userId: string;
    groupId?: string;
    text: string;
    rule?: string;
    kind: 'private' | 'group';
    reply?: string;
    collected?: CollectAnswer[];
    reason?: string;
}): void {
    const reason = args.reason ?? 'keyword_human';
    const collected: CollectAnswer[] = args.collected ?? [];
    const file = pluginState.getDataFilePath('handoff.jsonl');
    const ok = appendHandoffRecord(file, {
        ts: new Date().toISOString(),
        userId: args.userId,
        groupId: args.groupId,
        text: args.text,
        reason,
        rule: args.rule,
        reply: args.reply,
        collected,
    });
    pluginState.logger.info(
        '[转人工] reason=' + reason + ' ' + args.kind + ' user=' + args.userId +
        (args.groupId ? ' group=' + args.groupId : '') +
        (args.rule ? ' rule=' + args.rule : '') +
        ' collected=' + JSON.stringify(collected),
    );
    if (!ok) pluginState.logger.warn('[转人工] 留档写入失败: ' + file);
}

/**
 * 把转人工上报到服务侧：服务端留档 + Telegram 通知，人工可在 Telegram 直接回复用户。
 * 不 await —— 通知通道再慢也不能拖住给用户的兜底回复；失败只记日志。
 */
function reportHandoff(args: {
    userId: string;
    groupId?: string;
    text: string;
    collected?: CollectAnswer[];
}): void {
    const cfg = pluginState.config.kbService;
    if (!cfg?.enabled) {
        pluginState.logger.debug('[转人工] kbService 未启用，跳过 /handoff 上报');
        return;
    }
    // 群 @ 的 raw_message 带 CQ 码，去掉后再发给服务和 Telegram，避免通知正文含 [CQ:at,...]
    const text = cleanTextForAi(args.text);
    if (!text) return;
    const where = args.groupId ? 'group=' + args.groupId : 'private';
    void notifyHandoff(cfg, {
        userId: args.userId,
        groupId: args.groupId,
        text,
        collected: args.collected,
        reason: 'keyword_human',
    }).then((ok) => {
        if (!ok) pluginState.logger.warn('[转人工] /handoff 上报失败 ' + where + ' user=' + args.userId);
    });
}

/** 日志后缀:区分规则回复与 AI 回复,便于排查 */
function sourceTag(source: 'rule' | 'ai' | 'default' | 'none'): string {
    if (source === 'ai') return ' AI';
    if (source === 'default') return ' 兜底';
    return '';
}

/** 需要先问服务的计划 */
function needsAsk(plan: Plan): boolean {
    return plan.kind === 'ai' || plan.kind === 'rule-ai' || plan.kind === 'rule-ai-only';
}

/** 升级 AI 前清掉 CQ 码，避免把 [CQ:at,...] 原文发给服务 */
function cleanTextForAi(text: string): string {
    return text.replace(/\[CQ:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface AskKnowledgeResult {
    reply: string | null;
    /** 仅超时 / 5xx / 连接失败等需要用户侧降级的失败；4xx 不降级 */
    failure?: ServiceFailure;
}

/**
 * 问一次知识库/AI；返回可发送文本与失败类型。
 * 未启用/空文本/4xx 返回空 reply，由调用方按原逻辑回退；
 * 超时 / 5xx / 连接失败返回 failure，由调用方决定是否发降级提示。
 * 绝不抛异常。
 */
async function askKnowledge(
    text: string,
    userId: string,
    groupId: string | undefined,
    trigger: 'private' | 'group_at',
): Promise<AskKnowledgeResult> {
    const cfg = pluginState.config.kbService;
    if (!cfg?.enabled) return { reply: null };
    const cleaned = cleanTextForAi(text);
    if (!cleaned) return { reply: null };
    const outcome = await askServiceOutcome(cfg, { text: cleaned, userId, groupId, trigger });
    const tag = trigger + ' user=' + userId + ' group=' + (groupId || '-');
    if (outcome.failure) {
        pluginState.stats.faqMiss += 1;
        // 4xx 通常是配置/令牌问题，不属于「服务卡了」，不进用户降级链路
        if (outcome.failure.kind === 'http' && (outcome.failure.status ?? 0) < 500) {
            pluginState.logger.debug('[知识库] 调用失败 status=http code=' + (outcome.failure.status ?? '-') + ' ' + tag);
            return { reply: null };
        }
        return { reply: null, failure: outcome.failure };
    }
    const res = outcome.response;
    if (!res) {
        pluginState.logger.debug('[知识库] 未发起请求（服务地址/令牌未配置） ' + tag);
        return { reply: null };
    }
    pluginState.logger.info('[知识库] ' + tag + ' action=' + res.action + ' score=' + (res.score ?? '-'));
    const reply = res.reply.trim();
    if (reply) pluginState.stats.faqHit += 1;
    else pluginState.stats.faqMiss += 1;
    return { reply: reply || null };
}

/** 同一用户 10 分钟内只允许一条降级提示；返回 true 表示本次可发 */
function allowServiceDownNotice(userId: string): boolean {
    const now = Date.now();
    const map = pluginState.serviceDownNotified;
    for (const [key, ts] of map) {
        if (now - ts >= SERVICE_DOWN_NOTIFY_INTERVAL_MS) map.delete(key);
    }
    const last = map.get(userId);
    if (last !== undefined && now - last < SERVICE_DOWN_NOTIFY_INTERVAL_MS) return false;
    map.set(userId, now);
    return true;
}

/** 服务降级：记录 reason=service_down status=…，同一用户 10 分钟内只回一次固定文案 */
function respondServiceDown(
    ctx: NapCatPluginContext,
    event: OB11Message,
    senderId: string,
    failure: ServiceFailure,
    groupId?: string,
): void {
    pluginState.logger.warn(
        '[知识库] reason=service_down status=' + failure.kind +
        (failure.status !== undefined ? ' code=' + failure.status : '') +
        ' user=' + senderId + (groupId ? ' group=' + groupId : ''),
    );
    if (!allowServiceDownNotice(senderId)) {
        pluginState.logger.debug('[服务降级] 10 分钟内已提示过，本次静默 user=' + senderId);
        return;
    }
    hitLog.add({
        ts: new Date().toISOString(),
        channel: groupId ? 'group' : 'private',
        groupId,
        userId: senderId,
        result: 'service_down',
        detail: failure.kind + (failure.status !== undefined ? ' ' + failure.status : ''),
    });
    scheduleReply(ctx, event, { text: SERVICE_DOWN_REPLY }, '[服务降级] ' + (groupId ? '群 ' + groupId + ' ' : '私聊 ') + senderId);
}

/** 关键词匹配:prefix=前缀,contains=包含(默认)。返回命中的规则本身,便于以规则为粒度做冷却 */
function matchKeywords(keywords: KeywordRule[], text: string): KeywordRule | null {
    for (const rule of keywords) {
        // 停用规则保留在列表里，但跳过匹配
        if (rule.enabled === false) continue;
        const m = (rule.match || '').trim();
        if (!m) continue;
        let hit = false;
        if (rule.matchType === 'regex') {
            if (m.length <= 300) {
                try { hit = new RegExp(m, 'i').test(text); } catch { hit = false; }
            }
        } else {
            hit = rule.matchType === 'prefix' ? text.startsWith(m) : text.includes(m);
        }
        if (hit) return rule;
    }
    return null;
}

/** 同一用户+同一规则的冷却检查;未冷却时记录本次命中时间。seconds<=0 表示关闭 */
function isOnCooldown(senderId: string, ruleKey: string, seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const now = Date.now();
    const map = pluginState.replyCooldowns;
    // 顺带清理过期条目,防止长期运行时 Map 无限增长
    for (const [key, ts] of map) {
        if (now - ts >= seconds * 1000) map.delete(key);
    }
    const key = senderId + ':' + ruleKey;
    if (map.has(key)) return true;
    map.set(key, now);
    return false;
}

/**
 * 群消息是否指向机器人：
 * - at 段目标为自身 QQ；
 * - reply/引用段指向自身 QQ（部分适配器带 qq）；
 * - reply/引用段的 message_id 是本实例刚发出的消息（OneBot 常见形态，只有 id 没有 qq）。
 */
function isDirectedAtBot(event: OB11Message, selfId: string): boolean {
    if (Array.isArray(event.message)) {
        return event.message.some((seg) => {
            const data = seg.data as Record<string, unknown> | undefined;
            if (seg.type === 'at') return !!selfId && String(data?.qq ?? '') === selfId;
            if (seg.type === 'reply') {
                const replyId = data?.id ?? data?.message_id;
                if (selfId && String(data?.qq ?? '') === selfId) return true;
                return isSentByThisInstance(replyId);
            }
            return false;
        });
    }
    // 少数适配器把 message 下发成 CQ 字符串，退回 raw_message 匹配，避免 @ 判定失效
    const raw = typeof event.raw_message === 'string' ? event.raw_message : '';
    if (selfId && new RegExp('\\[CQ:(?:at|reply),qq=' + selfId + '(?:,|\\])').test(raw)) return true;
    // CQ 字符串里的引用段通常只有 id: [CQ:reply,id=123]
    for (const match of raw.matchAll(/\[CQ:reply,([^\]]*)\]/g)) {
        const rawId = /(?:^|,)id=([^,]+)/.exec(match[1] ?? '')?.[1];
        if (!rawId) continue;
        let id = rawId;
        try { id = decodeURIComponent(rawId); } catch { /* 保留原值 */ }
        if (isSentByThisInstance(id)) return true;
    }
    return false;
}

/** 按配置的随机延迟安排回复,拟人化防风控;延迟为 0 时立即发送 */
function scheduleReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    content: { text: string; image?: string },
    logTag: string,
    source: TrafficReplySource = 'rule',
): void {
    const min = Math.max(0, pluginState.config.replyDelayMinMs ?? 0);
    const max = Math.max(min, pluginState.config.replyDelayMaxMs ?? min);
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    if (delay <= 0) {
        void sendReply(ctx, event, content, logTag, source);
        return;
    }
    const timer = setTimeout(() => {
        pluginState.pendingReplies.delete(timer);
        void sendReply(ctx, event, content, logTag, source);
    }, delay);
    pluginState.pendingReplies.add(timer);
}

/** 发送熔断单例：进程内按群/用户维度累计连续失败 */
let sendGuard: SendGuard | null = null;
function getSendGuard(): SendGuard {
    if (!sendGuard) {
        sendGuard = new SendGuard({
            hooks: {
                onRecover: (key) => pluginState.logger.info('[熔断] 恢复 ' + guardLabel(key) + '，重新尝试发送'),
            },
        });
    }
    return sendGuard;
}

function guardLabel(key: string): string {
    const idx = key.indexOf(':');
    const kind = key.slice(0, idx);
    const id = key.slice(idx + 1);
    return kind === 'group' ? '群 ' + id : '私聊 ' + id;
}

/** 回复目标键：group:<群号> / private:<QQ号>，熔断与自回声共用 */
function replyKey(event: OB11Message): string {
    if (event.message_type === 'group' && event.group_id) return 'group:' + String(event.group_id);
    return 'private:' + String(event.sender?.user_id ?? event.user_id ?? '');
}

/** 流量统计 scope：只允许 private / group:<群号> */
function trafficScopeOf(event: OB11Message): string {
    if (event.message_type === 'group' && event.group_id) return 'group:' + String(event.group_id);
    return 'private';
}

/** 回复对刷防护单例：每次取用都同步最新配置，配置热更新立即生效 */
let loopGuard: LoopGuard | null = null;
function getLoopGuard(): LoopGuard {
    const cfg = pluginState.config.loopGuard ?? { maxReplies: 5, windowSeconds: 60, pauseSeconds: 300 };
    if (!loopGuard) loopGuard = new LoopGuard();
    loopGuard.configure({
        maxReplies: cfg.maxReplies,
        windowMs: cfg.windowSeconds * 1000,
        pauseMs: cfg.pauseSeconds * 1000,
    });
    return loopGuard;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * 发送回复并记录日志。
 * 防风控：熔断冷却期内不尝试发送；QQ 侧拒绝不重试；网络/超时类 2 秒后重试一次。
 */
async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    content: { text: string; image?: string },
    logTag: string,
    source: TrafficReplySource = 'rule',
): Promise<void> {
    const isGroup = event.message_type === 'group' && !!event.group_id;
    const targetId = isGroup
        ? String(event.group_id ?? '')
        : String(event.sender?.user_id ?? event.user_id ?? '');
    const key = (isGroup ? 'group:' : 'private:') + (targetId || 'unknown');
    const guardCfg = pluginState.config.sendGuard ?? { failThreshold: 3, privateFailThreshold: 5, cooldownSeconds: 600 };
    const threshold = isGroup ? guardCfg.failThreshold : guardCfg.privateFailThreshold;
    const cooldownMs = guardCfg.cooldownSeconds * 1000;
    const guard = getSendGuard();

    // 熔断中：消息算已处理但静默，不再尝试发送（不刷错误日志）
    if (guard.isOpen(key)) {
        pluginState.logger.debug('[熔断] ' + guardLabel(key) + ' 冷却中，本条静默');
        return;
    }

    // 群内对刷熔断：窗口内已发出达到阈值 → 暂停该群，期间不发送
    if (isGroup) {
        const verdict = getLoopGuard().allowSend(key);
        if (!verdict.allowed) {
            const loopCfg = pluginState.config.loopGuard;
            if (verdict.justPaused) {
                pluginState.logger.warn(
                    '[丢弃] reason=loop_breaker group=' + targetId + ' 窗口内已发 ' +
                    loopCfg.maxReplies + ' 条，暂停 ' + loopCfg.pauseSeconds + ' 秒',
                );
            } else {
                pluginState.logger.debug(
                    '[丢弃] reason=loop_breaker group=' + targetId + ' 暂停中，剩余 ' +
                    Math.ceil((verdict.remainingMs ?? 0) / 1000) + ' 秒',
                );
            }
            return;
        }
    }

    const result = await sendWithRetry(
        () => replyMessage(ctx, event, content),
        2,
        (error, attempt) => {
            if (attempt === 1 && classifySendError(error) === 'network') {
                pluginState.logger.warn('[发送] ' + guardLabel(key) + ' 网络/超时，2 秒后重试一次: ' + errorMessage(error));
            }
        },
        { shouldRetry: (error) => classifySendError(error) === 'network' },
    );
    if (result.ok) {
        guard.onSuccess(key);
        getLoopGuard().recordSend(key, content.text || '');
        // 只统计真正发出去的回复；失败/熔断/对刷拦截都不计
        recordTrafficReply(trafficScopeOf(event), source);
        const desc = (content.text || "") + (content.image ? " [图片]" : "");
        pluginState.logger.info(logTag + (result.attempts > 1 ? "（重试后成功）" : "") + " → " + desc.slice(0, 60));
        return;
    }

    const kind = result.kind ?? classifySendError(result.errors[result.errors.length - 1]);
    const failure = guard.onFailure(key, threshold, cooldownMs);
    if (failure.opened) {
        pluginState.logger.error(
            '[熔断] ' + guardLabel(key) + ' 连续 ' + failure.failures + ' 次发送失败' +
            (kind === 'qq_reject' ? '（QQ 侧拒绝）' : '') +
            '，冷却 ' + guardCfg.cooldownSeconds + ' 秒: ' + errorMessage(result.errors[result.errors.length - 1]),
        );
        return;
    }
    if (kind === 'qq_reject') {
        // 不重试、不刷屏：逐条只记 debug，达到阈值时才有一条 [熔断]
        pluginState.logger.debug(
            '[发送] ' + guardLabel(key) + ' QQ 侧拒绝，不重试（连续 ' + failure.failures + '/' + threshold + '）: ' +
            errorMessage(result.errors[result.errors.length - 1]),
        );
        return;
    }
    pluginState.logger.error(
        '[发送] ' + guardLabel(key) + ' 重试后仍失败（连续 ' + failure.failures + '/' + threshold + '）: ' +
        errorMessage(result.errors[result.errors.length - 1]),
    );
}
function checkWhitelist(list: (number | string)[], id: string): boolean {
    if (!list || list.length === 0) return true;
    return list.map(String).includes(id);
}

function extractText(event: OB11Message): string {
    if (typeof event.raw_message === 'string') return event.raw_message;
    if (Array.isArray(event.message)) {
        return event.message
            .filter(seg => seg.type === 'text')
            .map(seg => (seg.data as any)?.text ?? '')
            .join('');
    }
    return '';
}

/** QQ 客户端实际能展示的图片格式；avif/bmp/svg/heic 等会发出但用户看不到图 */
const SUPPORTED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** 取 URL/路径的小写扩展名，忽略 query 与 hash */
function imageExtension(src: string): string {
    const pathPart = src.split(/[?#]/)[0] || "";
    return path.extname(pathPart).toLowerCase();
}

/**
 * 校验图片来源与格式：http(s)/base64:// / 本地 /root 下文件且 <=5MB。
 * http(s) 直链与本地文件只放行 jpg/jpeg/png/webp/gif（QQ 不支持 avif 等格式）；
 * base64:// 无法从字符串判断格式，原样放行。非法来源返回 null 并打 warn。
 */
export function resolveImageSource(raw: string): string | null {
    const src = String(raw || "").trim();
    if (!src) return null;
    if (/^base64:\/\//i.test(src)) return src;
    if (/^https?:\/\//i.test(src)) {
        const ext = imageExtension(src);
        if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
            pluginState.logger.warn("[图片] QQ 不支持 " + (ext || "无扩展名") + " 格式,已跳过: " + src);
            return null;
        }
        return src;
    }
    const local = src.startsWith("file://") ? src.slice(7) : src;
    if (!local.startsWith("/root/")) {
        pluginState.logger.warn("[图片] 本地图片必须位于 /root 下,已跳过: " + local);
        return null;
    }
    const ext = imageExtension(local);
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
        pluginState.logger.warn("[图片] QQ 不支持 " + (ext || "无扩展名") + " 格式,已跳过: " + local);
        return null;
    }
    try {
        const st = fs.statSync(local);
        if (!st.isFile() || st.size <= 0) return null;
        if (st.size > 5 * 1024 * 1024) { pluginState.logger.warn("[图片] 超过 5MB,已跳过: " + local); return null; }
        return local;
    } catch { return null; }
}

/** 回复内容 → OneBot segments；atUserId 非空时最前面加 at 段并补空格 */
function buildSegments(content: { text: string; image?: string }, atUserId?: string): SendMessageSegment[] {
    const segments: SendMessageSegment[] = [];
    const atAdded = !!atUserId;
    if (atUserId) segments.push({ type: "at", data: { qq: atUserId } });
    if (content.text) {
        segments.push({ type: "text", data: { text: atAdded ? ' ' + content.text : content.text } });
    } else if (atAdded) {
        segments.push({ type: "text", data: { text: " " } });
    }
    if (content.image) {
        const src = resolveImageSource(content.image);
        if (src) segments.push({ type: "image", data: { file: src } });
    }
    return segments;
}

async function replyMessage(ctx: NapCatPluginContext, event: OB11Message, content: { text: string; image?: string }): Promise<void> {
    // 群聊 @ 回复：at 段后补一个空格，避免正文与 @ 粘连
    let atUserId = '';
    if (event.message_type === "group" && event.group_id && pluginState.config.atReply) {
        const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
        if (senderId && senderId !== '0') atUserId = senderId;
    }
    const segments = buildSegments(content, atUserId || undefined);
    if (!segments.length) return;
    const params: SendMsgParams = { message: segments };
    if (event.message_type === "group" && event.group_id) {
        params.group_id = String(event.group_id);
        params.message_type = "group";
    } else if (event.user_id) {
        params.user_id = String(event.user_id);
        params.message_type = "private";
    }
    const result = await ctx.actions.call("send_msg", params, ctx.adapterName, ctx.pluginManager.config);
    // 记下 message_id：群里有人引用这条回复时，即使没有 @ 也按定向提问处理
    rememberSentMessage(result);
}

/**
 * relay 反向下发：按 userId / groupId 发送 text+image 混合消息。
 * 与规则回复共用 buildSegments + resolveImageSource，不经过 @ 逻辑。
 * 调用方需先校验 image（非法格式应在入口拒绝，避免静默只发文字）。
 */
export async function sendRelayMessage(
    ctx: NapCatPluginContext,
    target: { userId: string; groupId?: string },
    content: { text: string; image?: string },
): Promise<void> {
    const segments = buildSegments(content);
    if (!segments.length) throw new Error("消息内容为空");
    const params: SendMsgParams = target.groupId
        ? { message_type: "group", group_id: target.groupId, message: segments }
        : { message_type: "private", user_id: target.userId, message: segments };
    const result = await ctx.actions.call("send_msg", params, ctx.adapterName, ctx.pluginManager.config);
    rememberSentMessage(result);
}