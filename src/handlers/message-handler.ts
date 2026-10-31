/**
 * 消息处理器 — QQ 自动回复核心逻辑
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';

export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    const config = pluginState.config;
    if (!config.enabled) return;

    const kind = event.message_type;
    if (kind !== 'private' && kind !== 'group') return;

    const senderId = String(event.sender?.user_id ?? 0);
    const selfId = String(ctx.pluginManager.config?.self_id ?? '');

    // 不回复自己
    if (senderId === selfId || senderId === '0') return;

    // 黑名单
    const blacklist = (config.blacklist ?? []).map(String);
    if (blacklist.includes(senderId)) return;

    const text = extractText(event);
    if (!text) return;

    // 私聊
    if (kind === 'private') {
        if (!config.private.enabled) return;
        if (!checkWhitelist(config.private.whitelist, senderId)) return;
        const reply = matchKeywords(config.keywords, text);
        if (reply) {
            await replyMessage(ctx, event, reply);
            pluginState.logger.info(`[私聊] ${senderId} → ${reply.slice(0, 40)}`);
        } else if (config.private.defaultReply) {
            await replyMessage(ctx, event, config.private.defaultReply);
            pluginState.logger.info(`[私聊] ${senderId} → 兜底回复`);
        }
        return;
    }

    // 群聊
    if (kind === 'group') {
        if (!config.group.enabled) return;
        if (!checkWhitelist(config.group.whitelist, String(event.group_id ?? ''))) return;
        const reply = matchKeywords(config.keywords, text);
        if (reply) {
            await replyMessage(ctx, event, reply);
            pluginState.logger.info(`[群聊] ${event.group_id} → ${reply.slice(0, 40)}`);
        }
    }
}

function matchKeywords(keywords: { match: string; matchType?: string; reply: string }[], text: string): string | null {
    for (const rule of keywords) {
        const m = (rule.match || '').trim();
        if (!m) continue;
        const hit = rule.matchType === 'prefix' ? text.startsWith(m) : text.includes(m);
        if (hit) return rule.reply;
    }
    return null;
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

async function replyMessage(ctx: NapCatPluginContext, event: OB11Message, text: string): Promise<void> {
    const params: Record<string, unknown> = {
        message: [{ type: 'text', data: { text } }],
    };
    if (event.message_type === 'group' && event.group_id) {
        params.group_id = String(event.group_id);
        params.message_type = 'group';
    } else if (event.user_id) {
        params.user_id = String(event.user_id);
        params.message_type = 'private';
    }
    await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
}
