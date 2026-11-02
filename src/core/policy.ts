/**
 * 群级生效口径解析（纯函数）
 *
 * 规则：
 * - 只有出现在 groupRules 里的群才处理（服务端有条目时由 group-config 负责）。
 * - 新口径是 { mode, missPolicy, atForceReply, keywordOutsideAt } 四项；本地老配置
 *   （enabled / atOnly / aiEnabled）按固定规则映射，服务端条目优先。
 * - 兜底话术同样按字段覆盖，null/缺省跟随全局。
 */

import type { FallbackConfig, GroupMode, GroupRule, MissPolicy, PluginConfig } from '../types';

export type PolicySource = 'group' | 'global' | 'server';

export interface PolicyValue<T> {
    value: T;
    source: PolicySource;
}

export interface GroupPolicy {
    mode: PolicyValue<GroupMode>;
    missPolicy: PolicyValue<MissPolicy>;
    /** 仅 mode=at 有意义：被 @ 且未命中、missPolicy=none 时仍回兜底（默认 true） */
    atForceReply: PolicyValue<boolean>;
    /** 仅 mode=all 有意义：非 @ 消息命中关键词也回（默认 true） */
    keywordOutsideAt: PolicyValue<boolean>;
}

export const DEFAULT_AT_FORCE_REPLY = true;
export const DEFAULT_KEYWORD_OUTSIDE_AT = true;

/** 老配置 enabled/atOnly → 新枚举（服务端迁移与插件本地映射共用同一口径） */
export function legacyGroupMode(enabled: boolean, atOnly: boolean): GroupMode {
    if (!enabled) return 'off';
    return atOnly ? 'at' : 'all';
}

/** 老配置 aiEnabled → 未命中策略 */
export function legacyMissPolicy(aiEnabled: boolean): MissPolicy {
    return aiEnabled ? 'ai_then_fallback' : 'fallback_only';
}

/** 群是否已配置：未出现在 groupRules 里的群一律不处理（含被 @） */
export function isGroupConfigured(config: PluginConfig, groupId: string): boolean {
    return config.groupRules?.[groupId] !== undefined;
}

/** 某群的生效口径；未配置的群按全局默认给出（调用方仍需先判断是否已配置） */
export function resolveGroupPolicy(config: PluginConfig, groupId: string): GroupPolicy {
    const rule: GroupRule | undefined = config.groupRules?.[groupId];

    // 老字段逐个：群级显式值优先，否则回落全局
    const enabled = rule?.enabled !== undefined
        ? rule.enabled
        : config.group?.enabled !== false;
    const atOnly = rule?.atOnly !== undefined
        ? rule.atOnly
        : config.atOnly === true;
    const aiEnabled = rule?.aiEnabled !== undefined
        ? rule.aiEnabled
        : true;

    // mode 由 enabled×atOnly 两个字段合成：任一项有群级覆盖就算 group 来源
    const modeFromGroup = rule?.enabled !== undefined || rule?.atOnly !== undefined;
    const missFromGroup = rule?.aiEnabled !== undefined;

    return {
        mode: { value: legacyGroupMode(enabled, atOnly), source: modeFromGroup ? 'group' : 'global' },
        missPolicy: { value: legacyMissPolicy(aiEnabled), source: missFromGroup ? 'group' : 'global' },
        atForceReply: { value: DEFAULT_AT_FORCE_REPLY, source: 'global' },
        keywordOutsideAt: { value: DEFAULT_KEYWORD_OUTSIDE_AT, source: 'global' },
    };
}

/** 兜底话术：群级字段为字符串时覆盖，null/缺省跟随全局 */
export function resolveGroupFallback(config: PluginConfig, groupId: string): FallbackConfig {
    const override = config.groupRules?.[groupId]?.fallback;
    const global = config.fallback ?? { privateText: '', groupAtText: '' };
    const pick = (own: string | null | undefined, inherited: string): string =>
        typeof own === 'string' ? own : inherited;
    return {
        privateText: pick(override?.privateText, global.privateText),
        groupAtText: pick(override?.groupAtText, global.groupAtText),
    };
}

/** 已配置群的生效口径表，供 WebUI 展示「值来自群级还是全局」 */
export function buildGroupPolicies(config: PluginConfig): Record<string, GroupPolicy> {
    const out: Record<string, GroupPolicy> = {};
    for (const groupId of Object.keys(config.groupRules ?? {})) {
        out[groupId] = resolveGroupPolicy(config, groupId);
    }
    return out;
}
