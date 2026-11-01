/**
 * 通知 / 请求事件处理 — 入群欢迎、好友申请自动通过
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';
import { pluginState } from '../core/state';
import type { GroupWelcomeConfig, GroupWelcomeOverride } from '../types';

/** OneBot 事件按需读取的宽松结构；不同版本可能存在字段差异 */
type EventLike = Record<string, unknown>;

/**
 * 解析某群的入群欢迎配置：群级有值优先，null/缺省回落到全局。
 * 纯函数，便于单测；空模板同样视为跟随全局。
 */
export function resolveWelcome(
    override: GroupWelcomeOverride | undefined,
    global: GroupWelcomeConfig | undefined,
): { enabled: boolean; template: string } {
    const enabled = override?.enabled != null ? override.enabled : !!global?.enabled;
    const ownTemplate = typeof override?.template === 'string' && override.template.trim() ? override.template : '';
    const template = String(ownTemplate || global?.template || '').trim();
    return { enabled: !!enabled, template };
}

/**
 * 处理非消息事件。
 * 入群欢迎与好友申请自动通过是独立能力，不受自动回复总开关影响。
 */
export async function handleOneBotEvent(ctx: NapCatPluginContext, event: unknown): Promise<void> {
    if (!event || typeof event !== 'object') return;
    const ev = event as EventLike;
    const postType = String(ev.post_type ?? '');
    if (postType === EventType.NOTICE) {
        if (String(ev.notice_type ?? '') === 'group_increase') await handleGroupIncrease(ctx, ev);
        return;
    }
    if (postType === EventType.REQUEST) {
        if (String(ev.request_type ?? '') === 'friend') await handleFriendRequest(ctx, ev);
    }
}

/** 入群欢迎：NapCat 的 group_increase 事件把新成员 QQ 放在 user_id */
async function handleGroupIncrease(ctx: NapCatPluginContext, ev: EventLike): Promise<void> {
    const groupId = String(ev.group_id ?? '');
    const userId = String(ev.user_id ?? '');
    const selfId = String(ev.self_id ?? ctx.pluginManager.config?.self_id ?? '');
    if (!groupId || !userId || userId === '0') return;
    // 机器人自己入群时不发欢迎
    if (selfId && userId === selfId) return;

    // 群级 welcome 覆盖全局；null/缺省 = 跟随全局
    const groupRule = pluginState.config.groupRules?.[groupId];
    const conf = resolveWelcome(groupRule?.welcome, pluginState.config.groupWelcome);
    if (!conf.enabled) return;
    const template = conf.template;
    if (!template) return;

    const text = renderWelcomeTemplate(template, groupId, userId);
    try {
        await ctx.actions.call(
            'send_msg',
            {
                message_type: 'group',
                group_id: groupId,
                message: [{ type: 'text', data: { text } }],
            },
            ctx.adapterName,
            ctx.pluginManager.config,
        );
        pluginState.logger.info('[入群欢迎] 群 ' + groupId + ' 新成员 ' + userId);
    } catch (e) {
        pluginState.logger.error('[入群欢迎] 群 ' + groupId + ' 发送失败:', e);
    }
}

/** 好友申请自动通过：默认关闭，开启后对 request_type=friend 的事件直接 approve */
async function handleFriendRequest(ctx: NapCatPluginContext, ev: EventLike): Promise<void> {
    const conf = pluginState.config.friendRequest;
    if (!conf?.autoAccept) return;

    const flag = String(ev.flag ?? '').trim();
    if (!flag) {
        pluginState.logger.warn('[好友申请] 事件缺少 flag，已跳过');
        return;
    }
    const userId = String(ev.user_id ?? '');
    try {
        await ctx.actions.call(
            'set_friend_add_request',
            { flag, approve: true },
            ctx.adapterName,
            ctx.pluginManager.config,
        );
        pluginState.logger.info('[好友申请] 已自动通过 ' + (userId || '(未知QQ)'));
    } catch (e) {
        pluginState.logger.error('[好友申请] 自动通过失败:', e);
    }
}

/** 渲染欢迎模板；用函数替换避免 id 中的特殊字符被当作替换语法 */
export function renderWelcomeTemplate(template: string, groupId: string, userId: string): string {
    return template
        .replace(/\{group_id\}/g, () => groupId)
        .replace(/\{user_id\}/g, () => userId);
}