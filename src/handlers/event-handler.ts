/**
 * 通知 / 请求事件处理 — 入群欢迎、好友申请自动通过
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';
import { pluginState } from '../core/state';
import { rememberSentMessage } from '../core/sent-messages';
import { resolveGroupWelcome } from '../core/group-config';
import { renderWelcomeTemplate, resolveWelcome } from '../core/welcome';

// 保持既有导出面（test/welcome.mjs 从入口导出 resolveWelcome）
export { resolveWelcome, renderWelcomeTemplate };

/** OneBot 事件按需读取的宽松结构；不同版本可能存在字段差异 */
type EventLike = Record<string, unknown>;

/**
 * 解析某群的入群欢迎配置：服务端条目优先，其次群级覆盖，最后全局。
 * 保留导出名 resolveWelcome 供既有调用方/测试使用（实现在 core/welcome）。
 */

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

    // 服务端条目优先（welcomeEnabled/welcomeTemplate），否则群级覆盖 → 全局
    const conf = resolveGroupWelcome(pluginState.config, groupId);
    if (!conf.enabled) return;
    const template = conf.template;
    if (!template) return;

    // 只取模板真正用到的占位符，少打两次 OneBot 调用
    const needNickname = template.includes('{nickname}');
    const needGroupName = template.includes('{group_name}');
    const [nickname, groupName] = await Promise.all([
        needNickname ? fetchNickname(ctx, groupId, userId) : Promise.resolve(''),
        needGroupName ? fetchGroupName(ctx, groupId) : Promise.resolve(''),
    ]);
    const text = renderWelcomeTemplate(template, groupId, userId, nickname, groupName);
    try {
        const result = await ctx.actions.call(
            'send_msg',
            {
                message_type: 'group',
                group_id: groupId,
                message: [{ type: 'text', data: { text } }],
            },
            ctx.adapterName,
            ctx.pluginManager.config,
        );
        rememberSentMessage(result);
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

/** 取群成员昵称（优先群名片）；失败返回空串，不影响欢迎语发送 */
async function fetchNickname(ctx: NapCatPluginContext, groupId: string, userId: string): Promise<string> {
    try {
        const info = await ctx.actions.call(
            'get_group_member_info',
            { group_id: groupId, user_id: userId, no_cache: false },
            ctx.adapterName,
            ctx.pluginManager.config,
        ) as { card?: unknown; nickname?: unknown } | null;
        const card = typeof info?.card === 'string' ? info.card.trim() : '';
        if (card) return card;
        return typeof info?.nickname === 'string' ? info.nickname.trim() : '';
    } catch (e) {
        pluginState.logger.debug('[入群欢迎] 取昵称失败:', e);
        return '';
    }
}

/** 取群名；失败返回空串，不影响欢迎语发送 */
async function fetchGroupName(ctx: NapCatPluginContext, groupId: string): Promise<string> {
    try {
        const info = await ctx.actions.call(
            'get_group_info',
            { group_id: groupId, no_cache: false },
            ctx.adapterName,
            ctx.pluginManager.config,
        ) as { group_name?: unknown } | null;
        return typeof info?.group_name === 'string' ? info.group_name.trim() : '';
    } catch (e) {
        pluginState.logger.debug('[入群欢迎] 取群名失败:', e);
        return '';
    }
}