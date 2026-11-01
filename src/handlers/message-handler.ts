/**
 * 消息处理器 — QQ 自动回复核心逻辑
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { isBlocked } from '../core/blocklist';
import { pickReply, planReply, resolveSend, type Plan } from '../core/escalation';
import { isGroupConfigured, resolveGroupFallback, resolveGroupPolicy } from '../core/policy';
import { appendHandoffRecord } from '../core/handoff';
import { classifySendError, sendWithRetry } from '../core/send-retry';
import { SendGuard } from '../core/send-guard';
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
import { askService, notifyHandoff } from '../services/kb-client';
import type { KeywordRule } from '../types';
import fs from 'fs';
import path from 'path';

const CLAIM_DIR = '/root/qq-accounts/shared/claims';

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
    if (!config.enabled) return;
    pluginState.incrementProcessed();

    const kind = event.message_type;
    if (kind !== 'private' && kind !== 'group') return;

    const senderId = String(event.sender?.user_id ?? 0);
    // self_id 优先取事件本身，其次取 init 时 get_login_info 的结果。
    // ctx.pluginManager.config 里不保证有 self_id（历史 bug：取不到导致 atBot 恒为 false，群 @ 被静默）。
    const selfId = String(event.self_id || pluginState.selfId || ctx.pluginManager.config?.self_id || '');

    // 不回复自己
    if (senderId === selfId || senderId === '0') return;

    // 黑名单:名单内用户直接跳过,不触发任何回复
    const blacklist = (config.blacklist ?? []).map(String);
    if (blacklist.includes(senderId)) return;

    // ① 服务侧拉黑缓存:命中后任何回复都不发(含兜底与 AI)
    if (isBlocked(senderId, config.blocklist?.users)) return;

    const text = extractText(event);
    if (!text) return;

    // 私聊：必回 —— 命中规则按规则，未命中/服务无答案一律发兜底话术
    if (kind === 'private') {
        if (!config.private.enabled) return;
        if (!checkWhitelist(config.private.whitelist, senderId)) return;
        // 追问中的用户消息优先作为答案消费，不再走关键词/FAQ
        if (await consumeCollectAnswer(ctx, event, collectKey('private', senderId), senderId, undefined, text, 'private')) return;
        const hit = matchKeywords(config.keywords, text);
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
        if (isRuleCooldown(senderId, plan)) return;
        const ask = needsAsk(plan) ? await askKnowledge(text, senderId, undefined, 'private') : null;
        if (plan.kind === 'rule-human') {
            if (startCollect(ctx, event, senderId, undefined, text, plan.rule.match, 'private')) return;
            recordHandoff({ userId: senderId, text, rule: plan.rule.match, kind: 'private' });
            reportHandoff({ userId: senderId, text });
        }
        const out = resolveSend({
            plan,
            ask: ask ? { reply: ask } : null,
            kind: 'private',
            defaultReply: config.fallback?.privateText ?? '',
        });
        if (!out.send || (!out.text && !out.image)) return;
        scheduleReply(ctx, event, { text: out.text || '', image: out.image }, '[私聊] ' + senderId + sourceTag(out.source));
        return;
    }

    // 群聊：只有 groupRules 里配置过的群才处理，未配置群一律静默（含 @）
    if (kind === 'group') {
        const groupId = String(event.group_id ?? '');
        const atBot = isDirectedAtBot(event, selfId);
        // 每个提前返回都留原因码：@ 消息用 info（排障必看），非 @ 用 debug（群消息量大）
        const skip = (reason: string, detail = '') => {
            const line = '[群聊] 跳过 group=' + groupId + ' reason=' + reason + (detail ? ' ' + detail : '');
            if (atBot) pluginState.logger.info(line);
            else pluginState.logger.debug(line);
        };
        if (!config.group.enabled) { skip('群聊总开关关闭'); return; }
        if (!checkWhitelist(config.group.whitelist, groupId)) { skip('群白名单外'); return; }
        const groupRule = config.groupRules?.[groupId];
        if (!isGroupConfigured(config, groupId) || !groupRule) { skip('未配置群'); return; }
        const policy = resolveGroupPolicy(config, groupId);
        if (!policy.enabled.value) { skip('群已禁用'); return; }
        // 追问中的用户消息优先作为答案消费；不要求 @，否则群内无法回答
        if (await consumeCollectAnswer(ctx, event, collectKey('group', senderId, groupId), senderId, groupId, text, 'group')) return;
        if (policy.atOnly.value && !atBot) { skip('未@且该群仅@触发', 'selfId=' + (selfId || '-')); return; }
        // 群专属关键词非空时只按群规则匹配,避免全局规则串群
        const keywords = groupRule.keywords?.length ? groupRule.keywords : config.keywords;
        const hit = matchKeywords(keywords, text);
        const plan = planReply({
            kind: 'group',
            userId: senderId,
            atBot,
            rule: hit,
            blockUsers: config.blocklist?.users,
            kbEnabled: config.kbService?.enabled === true,
            // 群内未 @ 且未命中关键词必须静默：未命中时不允许升级 AI，只有 @ 才走 FAQ/AI
            aiTrigger: { private: config.aiTrigger.private, groupAtOnly: true },
            groupAiEnabled: policy.aiEnabled.value,
        });
        if (plan.kind === 'blocked') { skip('服务侧拉黑'); return; }
        if (isRuleCooldown(senderId, plan)) { skip('规则冷却', 'rule=' + plan.rule.match); return; }
        // 多账号同群去重:规则回复与 AI 回复都只允许一个实例发
        if (!tryClaimReply(String(event.message_id ?? ''), groupId)) { skip('去重命中'); return; }
        const ask = needsAsk(plan) ? await askKnowledge(text, senderId, groupId, 'group_at') : null;
        if (plan.kind === 'rule-human') {
            if (startCollect(ctx, event, senderId, groupId, text, plan.rule.match, 'group')) return;
            recordHandoff({ userId: senderId, groupId, text, rule: plan.rule.match, kind: 'group' });
            reportHandoff({ userId: senderId, groupId, text });
        }
        const fallback = resolveGroupFallback(config, groupId);
        const out = resolveSend({
            plan,
            ask: ask ? { reply: ask } : null,
            kind: 'group',
            atBot,
            groupFallback: fallback.groupAtText,
        });
        if (!out.send || (!out.text && !out.image)) {
            const reason = plan.kind === 'none' && !atBot ? '未@且未命中规则(静默)' : '无可发送内容';
            skip(reason, 'kind=' + plan.kind + ' atBot=' + atBot + ' selfId=' + (selfId || '-') +
                ' 兜底=' + (fallback.groupAtText ? '有' : '空'));
            return;
        }
        scheduleReply(ctx, event, { text: out.text || '', image: out.image }, '[群聊] ' + groupId + sourceTag(out.source));
    }
}

/** 规则类计划共用的冷却键；AI/兜底不占用规则冷却 */
function isRuleCooldown(senderId: string, plan: Plan): boolean {
    if (plan.kind === 'rule' || plan.kind === 'rule-ai' || plan.kind === 'rule-ai-only' || plan.kind === 'rule-human') {
        return isOnCooldown(senderId, plan.rule.match);
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
    const groupActive = kind !== 'group' || (
        isGroupConfigured(pluginState.config, session.groupId ?? '') &&
        resolveGroupPolicy(pluginState.config, session.groupId ?? '').enabled.value
    );
    const fallback = kind === 'private'
        ? pluginState.config.fallback?.privateText ?? ''
        : resolveGroupFallback(pluginState.config, session.groupId ?? '').groupAtText;
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
        scheduleReply(ctx, answerEvent, { text: fallback }, '[转人工] ' + session.userId);
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

/**
 * 问一次知识库/AI；返回非空回复文本。
 * 任何失败(未启用/空文本/超时/非 200/空 reply)都返回 null，由调用方回退，绝不抛异常。
 */
async function askKnowledge(
    text: string,
    userId: string,
    groupId: string | undefined,
    trigger: 'private' | 'group_at',
): Promise<string | null> {
    const cfg = pluginState.config.kbService;
    if (!cfg?.enabled) return null;
    const cleaned = cleanTextForAi(text);
    if (!cleaned) return null;
    const res = await askService(cfg, { text: cleaned, userId, groupId, trigger });
    const tag = trigger + ' user=' + userId + ' group=' + (groupId || '-');
    if (!res) {
        pluginState.logger.debug('[知识库] 调用失败/超时 ' + tag);
        return null;
    }
    pluginState.logger.info('[知识库] ' + tag + ' action=' + res.action + ' score=' + (res.score ?? '-'));
    return res.reply.trim() || null;
}

/** 关键词匹配:prefix=前缀,contains=包含(默认)。返回命中的规则本身,便于以规则为粒度做冷却 */
function matchKeywords(keywords: KeywordRule[], text: string): KeywordRule | null {
    for (const rule of keywords) {
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

/** 同一用户+同一规则的冷却检查;未冷却时记录本次命中时间 */
function isOnCooldown(senderId: string, ruleKey: string): boolean {
    const seconds = pluginState.config.cooldownSeconds ?? 0;
    if (seconds <= 0) return false;
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

/** 群消息是否指向机器人:@ 段目标为自身 QQ,或 reply 段(部分适配器会带原发送者 qq) */
function isDirectedAtBot(event: OB11Message, selfId: string): boolean {
    if (!selfId) return false;
    if (Array.isArray(event.message)) {
        return event.message.some((seg) => {
            const data = seg.data as Record<string, unknown> | undefined;
            if (seg.type === 'at') return String(data?.qq ?? '') === selfId;
            if (seg.type === 'reply') return String(data?.qq ?? '') === selfId;
            return false;
        });
    }
    // 少数适配器把 message 下发成 CQ 字符串，退回 raw_message 匹配，避免 @ 判定失效
    const raw = typeof event.raw_message === 'string' ? event.raw_message : '';
    return new RegExp('\\[CQ:(?:at|reply),qq=' + selfId + '(?:,|\\])').test(raw);
}

/** 按配置的随机延迟安排回复,拟人化防风控;延迟为 0 时立即发送 */
function scheduleReply(ctx: NapCatPluginContext, event: OB11Message, content: { text: string; image?: string }, logTag: string): void {
    const min = Math.max(0, pluginState.config.replyDelayMinMs ?? 0);
    const max = Math.max(min, pluginState.config.replyDelayMaxMs ?? min);
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    if (delay <= 0) {
        void sendReply(ctx, event, content, logTag);
        return;
    }
    const timer = setTimeout(() => {
        pluginState.pendingReplies.delete(timer);
        void sendReply(ctx, event, content, logTag);
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * 发送回复并记录日志。
 * 防风控：熔断冷却期内不尝试发送；QQ 侧拒绝不重试；网络/超时类 2 秒后重试一次。
 */
async function sendReply(ctx: NapCatPluginContext, event: OB11Message, content: { text: string; image?: string }, logTag: string): Promise<void> {
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

/** 校验图片来源:允许 http(s)/base64://;本地路径限制在 /root 下且 <=5MB */
function resolveImageSource(raw: string): string | null {
    const src = String(raw || "").trim();
    if (!src) return null;
    if (/^(https?:\/\/|base64:\/\/)/i.test(src)) return src;
    const local = src.startsWith("file://") ? src.slice(7) : src;
    if (!local.startsWith("/root/")) {
        pluginState.logger.warn("[图片] 本地图片必须位于 /root 下,已跳过: " + local);
        return null;
    }
    try {
        const st = fs.statSync(local);
        if (!st.isFile() || st.size <= 0) return null;
        if (st.size > 5 * 1024 * 1024) { pluginState.logger.warn("[图片] 超过 5MB,已跳过: " + local); return null; }
        return local;
    } catch { return null; }
}
async function replyMessage(ctx: NapCatPluginContext, event: OB11Message, content: { text: string; image?: string }): Promise<void> {
    const segments: Array<Record<string, unknown>> = [];
    // 群聊 @ 回复：at 段后补一个空格，避免正文与 @ 粘连
    let atAdded = false;
    if (event.message_type === "group" && event.group_id && pluginState.config.atReply) {
        const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
        if (senderId && senderId !== '0') {
            segments.push({ type: "at", data: { qq: senderId } });
            atAdded = true;
        }
    }
    if (content.text) {
        segments.push({ type: "text", data: { text: atAdded ? ' ' + content.text : content.text } });
    } else if (atAdded) {
        segments.push({ type: "text", data: { text: " " } });
    }
    if (content.image) {
        const src = resolveImageSource(content.image);
        if (src) segments.push({ type: "image", data: { file: src } });
    }
    if (!segments.length) return;
    const params: Record<string, unknown> = { message: segments };
    if (event.message_type === "group" && event.group_id) {
        params.group_id = String(event.group_id);
        params.message_type = "group";
    } else if (event.user_id) {
        params.user_id = String(event.user_id);
        params.message_type = "private";
    }
    await ctx.actions.call("send_msg", params, ctx.adapterName, ctx.pluginManager.config);
}