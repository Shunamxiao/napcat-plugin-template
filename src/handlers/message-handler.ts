/**
 * 消息处理器 — QQ 自动回复核心逻辑
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
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

    const text = extractText(event);
    if (!text) return;

    // 私聊
    if (kind === 'private') {
        if (!config.private.enabled) return;
        if (!checkWhitelist(config.private.whitelist, senderId)) return;
        const hit = matchKeywords(config.keywords, text);
        if (hit) {
            if (!isOnCooldown(senderId, hit.match)) {
                scheduleReply(ctx, event, { text: hit.reply, image: hit.image }, '[私聊] ' + senderId);
            }
        } else if (config.private.defaultReply && !isOnCooldown(senderId, DEFAULT_REPLY_RULE_KEY)) {
            scheduleReply(ctx, event, { text: config.private.defaultReply }, '[私聊] ' + senderId + ' 兜底');
        }
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
        const atOnly = groupRule?.atOnly ?? config.atOnly;
        if (atOnly && !isAtSelf(event, selfId)) return;
        // 群专属关键词非空时只按群规则匹配,避免全局规则串群
        const keywords = groupRule?.keywords?.length ? groupRule.keywords : config.keywords;
        const hit = matchKeywords(keywords, text);
        if (hit && !isOnCooldown(senderId, hit.match) && tryClaimReply(String(event.message_id ?? ''), groupId)) {
            scheduleReply(ctx, event, { text: hit.reply, image: hit.image }, '[群聊] ' + groupId);
        }
    }
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

/** 群消息是否 @ 了机器人(at 段目标为自身 QQ) */
function isAtSelf(event: OB11Message, selfId: string): boolean {
    if (!selfId || !Array.isArray(event.message)) return false;
    return event.message.some(
        (seg) => seg.type === 'at' && String((seg.data as Record<string, unknown> | undefined)?.qq ?? '') === selfId,
    );
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
    if (content.text) segments.push({ type: "text", data: { text: content.text } });
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