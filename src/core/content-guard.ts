/**
 * 群内容守卫 — 群消息命中屏蔽词时自动撤回 / 警告
 *
 * 只在群消息上生效，不踢人、不禁言；撤回失败只记日志，不重试（风控优先）。
 * 命中后返回 true，调用方应立即停止后续自动回复，避免机器人继续接话。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from './state';
import { isGroupConfigured, resolveGroupPolicy } from './policy';
import type { GuardAction, GuardConfig } from '../types';

/** 命中判断：大小写不敏感，返回命中的原词（用于日志），未命中返回 null */
export function matchGuardWord(text: string, words: unknown): string | null {
    const haystack = String(text ?? '').toLowerCase();
    if (!haystack || !Array.isArray(words)) return null;
    for (const item of words) {
        const word = typeof item === 'string' ? item.trim() : '';
        if (!word) continue;
        if (haystack.includes(word.toLowerCase())) return word;
    }
    return null;
}

/**
 * 守卫是否覆盖该群：
 * - groupIds 非空：只处理名单内的群（显式点名可覆盖“未配置群”的限制）；
 * - groupIds 为空：处理所有已配置且启用自动回复的群（与消息处理口径一致）。
 */
export function guardTargetsGroup(config: GuardConfig | undefined, groupId: string): boolean {
    if (!config || !groupId) return false;
    const ids = (config.groupIds ?? []).map(String);
    if (ids.length > 0) return ids.includes(groupId);
    if (pluginState.config.group?.enabled === false) return false;
    return isGroupConfigured(pluginState.config, groupId) &&
        resolveGroupPolicy(pluginState.config, groupId).enabled.value;
}

function normalizeAction(action: GuardAction | undefined): GuardAction {
    return action === 'warn' || action === 'both' ? action : 'recall';
}

/** NapCat 对 delete_msg 成功但无返回值的动作会抛「No data returned」，这是成功而非失败 */
function isNoDataReturned(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /no data returned/i.test(message);
}

/**
 * 执行守卫。返回 true = 本条命中并已处理，调用方应停止自动回复。
 * 配置关闭 / 非群消息 / 未命中时返回 false，不做任何 OneBot 调用。
 */
export async function runGroupGuard(
    ctx: NapCatPluginContext,
    event: OB11Message,
    text: string,
): Promise<boolean> {
    const config = pluginState.config.guard;
    if (!config?.enabled) return false;
    if (event.message_type !== 'group') return false;
    const groupId = String(event.group_id ?? '');
    if (!groupId || !guardTargetsGroup(config, groupId)) return false;

    const word = matchGuardWord(text, config.words);
    if (!word) return false;

    const user = String(event.sender?.user_id ?? event.user_id ?? '');
    const action = normalizeAction(config.action);
    const tag = ' user=' + user + ' rule=' + word + ' group=' + groupId;

    if (action === 'recall' || action === 'both') {
        const messageId = event.message_id;
        if (messageId === undefined || messageId === null || String(messageId) === '') {
            pluginState.logger.warn('[群守卫] reason=guard_recall_failed' + tag + ' error=缺少 message_id');
        } else {
            try {
                await ctx.actions.call(
                    'delete_msg',
                    { message_id: messageId },
                    ctx.adapterName,
                    ctx.pluginManager.config,
                );
                pluginState.logger.info('[群守卫] reason=guard_recall' + tag);
            } catch (e) {
                // NapCat 的 delete_msg 成功时可能没有 data，插件框架会抛 No data returned
                if (isNoDataReturned(e)) {
                    pluginState.logger.info('[群守卫] reason=guard_recall' + tag);
                } else {
                    const message = e instanceof Error ? e.message : String(e ?? '');
                    pluginState.logger.warn('[群守卫] reason=guard_recall_failed' + tag + ' error=' + message);
                }
            }
        }
    }

    if (action === 'warn' || action === 'both') {
        const warnText = String(config.warnText ?? '').trim();
        if (warnText) {
            try {
                await ctx.actions.call(
                    'send_msg',
                    {
                        message_type: 'group',
                        group_id: groupId,
                        message: [{ type: 'text', data: { text: warnText } }],
                    },
                    ctx.adapterName,
                    ctx.pluginManager.config,
                );
                pluginState.logger.info('[群守卫] reason=guard_warn' + tag);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e ?? '');
                pluginState.logger.warn('[群守卫] reason=guard_warn_failed' + tag + ' error=' + message);
            }
        }
    }

    // 命中即短路：即使撤回失败也不继续自动回复
    return true;
}
