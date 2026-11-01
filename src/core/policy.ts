/**
 * 群级生效口径解析（纯函数）
 *
 * 规则：
 * - 只有出现在 groupRules 里的群才处理；未配置的群一律静默。
 * - enabled/atOnly/aiEnabled 逐个字段：群级显式值优先，否则回落全局。
 * - 兜底话术同样按字段覆盖，null/缺省跟随全局。
 */

import type { FallbackConfig, GroupRule, PluginConfig } from '../types';

export type PolicySource = 'group' | 'global';

export interface PolicyValue<T> {
    value: T;
    source: PolicySource;
}

export interface GroupPolicy {
    enabled: PolicyValue<boolean>;
    atOnly: PolicyValue<boolean>;
    aiEnabled: PolicyValue<boolean>;
}

/** 群是否已配置：未出现在 groupRules 里的群一律不处理（含被 @） */
export function isGroupConfigured(config: PluginConfig, groupId: string): boolean {
    return config.groupRules?.[groupId] !== undefined;
}

/** 某群的生效口径；未配置的群按全局默认给出（调用方仍需先判断是否已配置） */
export function resolveGroupPolicy(config: PluginConfig, groupId: string): GroupPolicy {
    const rule: GroupRule | undefined = config.groupRules?.[groupId];

    const enabled = rule?.enabled !== undefined
        ? { value: rule.enabled, source: 'group' as const }
        : { value: config.group?.enabled !== false, source: 'global' as const };

    const atOnly = rule?.atOnly !== undefined
        ? { value: rule.atOnly, source: 'group' as const }
        : { value: config.atOnly === true, source: 'global' as const };

    const aiEnabled = rule?.aiEnabled !== undefined
        ? { value: rule.aiEnabled, source: 'group' as const }
        : { value: true, source: 'global' as const };

    return { enabled, atOnly, aiEnabled };
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
