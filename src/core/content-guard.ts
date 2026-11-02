/**
 * 群内容守卫 — 群消息命中屏蔽词时自动撤回 / 警告
 *
 * 只在群消息上生效，不踢人、不禁言；撤回失败只记日志，不重试（风控优先）。
 * 命中后返回 true，调用方应立即停止后续自动回复，避免机器人继续接话。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from './state';
import { isGroupManaged, resolveEffectiveGroupPolicy, resolveGuardPolicy } from './group-config';
import { applyGuardPenalty } from './guard-penalty';
import { hitLog } from './hit-log';
import type { GuardAction, GuardConfig } from '../types';

/** 本地词表 + 服务词表叠加；本地优先，去重后返回（任一命中即触发） */
export function mergeGuardWords(local: unknown, remote: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const source of [local, remote]) {
        if (!Array.isArray(source)) continue;
        for (const item of source) {
            if (typeof item !== 'string') continue;
            const word = item.trim();
            if (!word || seen.has(word)) continue;
            seen.add(word);
            out.push(word);
        }
    }
    return out;
}

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
    return isGroupManaged(pluginState.config, groupId) &&
        (resolveEffectiveGroupPolicy(pluginState.config, groupId)?.mode.value ?? 'off') !== 'off';
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

    const word = matchGuardWord(text, mergeGuardWords(config.words, pluginState.serviceGuardWords));
    if (!word) return false;

    const user = String(event.sender?.user_id ?? event.user_id ?? '');
    const action = normalizeAction(config.action);
    const policy = resolveGuardPolicy(config);
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

    // 计数与处罚：达到阈值 → 禁言 + muteText；禁言失败 → 降级警告（不重试）
    const penalty = await applyGuardPenalty({
        groupId,
        userId: user,
        policy,
        deps: {
            setBan: (gid, uid, seconds) => ctx.actions.call(
                'set_group_ban',
                { group_id: gid, user_id: uid, duration: seconds },
                ctx.adapterName,
                ctx.pluginManager.config,
            ),
            sendText: (gid, text) => sendGroupText(ctx, gid, text),
            log: (level, message) => pluginState.logger[level](message),
        },
    });

    if (penalty.banned) {
        hitLog.add({
            ts: new Date().toISOString(),
            channel: 'group',
            groupId,
            userId: user,
            result: 'guard_mute',
            detail: '命中「' + word + '」' + penalty.count + ' 次，禁言 ' + policy.muteSeconds + 's',
        });
        return true;
    }

    // 警告：命中动作要求 warn/both，或禁言失败后的降级
    const warnText = String(policy.warnText ?? '').trim();
    if ((action === 'warn' || action === 'both' || penalty.degraded) && warnText) {
        try {
            await sendGroupText(ctx, groupId, warnText);
            pluginState.logger.info('[群守卫] reason=guard_warn' + tag);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e ?? '');
            pluginState.logger.warn('[群守卫] reason=guard_warn_failed' + tag + ' error=' + message);
        }
    }

    hitLog.add({
        ts: new Date().toISOString(),
        channel: 'group',
        groupId,
        userId: user,
        result: penalty.degraded ? 'guard_degraded' : 'guard',
        detail: '命中「' + word + '」' + penalty.count + '/' + policy.threshold,
    });

    // 命中即短路：即使撤回失败也不继续自动回复
    return true;
}

/** 发一条群文本；供警告/禁言提示复用 */
async function sendGroupText(ctx: NapCatPluginContext, groupId: string, text: string): Promise<void> {
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
}
