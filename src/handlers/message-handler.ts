/**
 * 消息处理器 — QQ 自动回复核心逻辑
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { isBlocked } from '../core/blocklist';
import { pickReply, planReply, resolveSend, type Plan } from '../core/escalation';
import { askService } from '../services/kb-client';
import type { KeywordRule } from '../types';
import fs from 'fs';
import path from 'path';

/** 私聊兜底回复在冷却记录中的规则键 */
const DEFAULT_REPLY_RULE_KEY = 'default-reply';

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
    const selfId = String(ctx.pluginManager.config?.self_id ?? '');

    // 不回复自己
    if (senderId === selfId || senderId === '0') return;

    // 黑名单:名单内用户直接跳过,不触发任何回复
    const blacklist = (config.blacklist ?? []).map(String);
    if (blacklist.includes(senderId)) return;

    // ① 服务侧拉黑缓存:命中后任何回复都不发(含兜底与 AI)
    if (isBlocked(senderId, config.blocklist?.users)) return;

    const text = extractText(event);
    if (!text) return;

    // 私聊
    if (kind === 'private') {
        if (!config.private.enabled) return;
        if (!checkWhitelist(config.private.whitelist, senderId)) return;
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
        // 规则命中(含 aiFallback)沿用原冷却粒度,冷却期内整条不发
        if ((plan.kind === 'rule' || plan.kind === 'rule-ai') && isOnCooldown(senderId, plan.rule.match)) return;
        const ask = needsAsk(plan) ? await askKnowledge(text, senderId, undefined, 'private') : null;
        const out = resolveSend({ plan, ask: ask ? { reply: ask } : null, kind: 'private', defaultReply: config.private.defaultReply });
        if (!out.send) return;
        // 私聊兜底话术沿用原来的冷却键
        if (out.source === 'default' && isOnCooldown(senderId, DEFAULT_REPLY_RULE_KEY)) return;
        scheduleReply(ctx, event, { text: out.text || '', image: out.image }, '[私聊] ' + senderId + sourceTag(out.source));
        return;
    }

    // 群聊
    if (kind === 'group') {
        if (!config.group.enabled) return;
        const groupId = String(event.group_id ?? '');
        if (!checkWhitelist(config.group.whitelist, groupId)) return;
        // 群级规则优先:enabled=false 整群跳过,未设置的字段沿用全局
        const groupRule = config.groupRules?.[groupId];
        if (groupRule?.enabled === false) return;
        const atBot = isDirectedAtBot(event, selfId);
        const atOnly = groupRule?.atOnly ?? config.atOnly;
        if (atOnly && !atBot) return;
        // 群专属关键词非空时只按群规则匹配,避免全局规则串群
        const keywords = groupRule?.keywords?.length ? groupRule.keywords : config.keywords;
        const hit = matchKeywords(keywords, text);
        const plan = planReply({
            kind: 'group',
            userId: senderId,
            atBot,
            rule: hit,
            blockUsers: config.blocklist?.users,
            kbEnabled: config.kbService?.enabled === true,
            aiTrigger: config.aiTrigger,
            groupAiEnabled: groupRule?.aiEnabled !== false,
        });
        if (plan.kind === 'none' || plan.kind === 'blocked') return;
        if ((plan.kind === 'rule' || plan.kind === 'rule-ai') && isOnCooldown(senderId, plan.rule.match)) return;
        // 多账号同群去重:规则回复与 AI 回复都只允许一个实例发
        if (!tryClaimReply(String(event.message_id ?? ''), groupId)) return;
        const ask = needsAsk(plan) ? await askKnowledge(text, senderId, groupId, 'group_at') : null;
        const out = resolveSend({ plan, ask: ask ? { reply: ask } : null, kind: 'group' });
        if (!out.send || (!out.text && !out.image)) return;
        scheduleReply(ctx, event, { text: out.text || '', image: out.image }, '[群聊] ' + groupId + sourceTag(out.source));
    }
}

/** 日志后缀:区分规则回复与 AI 回复,便于排查 */
function sourceTag(source: 'rule' | 'ai' | 'default' | 'none'): string {
    if (source === 'ai') return ' AI';
    if (source === 'default') return ' 兜底';
    return '';
}

/** 需要先问服务的计划 */
function needsAsk(plan: Plan): boolean {
    return plan.kind === 'ai' || plan.kind === 'rule-ai';
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
    if (!selfId || !Array.isArray(event.message)) return false;
    return event.message.some((seg) => {
        const data = seg.data as Record<string, unknown> | undefined;
        if (seg.type === 'at') return String(data?.qq ?? '') === selfId;
        if (seg.type === 'reply') return String(data?.qq ?? '') === selfId;
        return false;
    });
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

/** 发送回复并记录日志,失败可定位不静默 */
async function sendReply(ctx: NapCatPluginContext, event: OB11Message, content: { text: string; image?: string }, logTag: string): Promise<void> {
    try {
        await replyMessage(ctx, event, content);
        const desc = (content.text || "") + (content.image ? " [图片]" : "");
        pluginState.logger.info(logTag + " → " + desc.slice(0, 60));
    } catch (e) {
        pluginState.logger.error(logTag + " 回复发送失败:", e);
    }
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