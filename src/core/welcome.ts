/**
 * 入群欢迎的纯逻辑：群级覆盖解析 + 模板渲染
 *
 * 单独成模块，避免 event-handler ↔ group-config 互相 import 形成环。
 */

import type { GroupWelcomeConfig, GroupWelcomeOverride } from '../types';

export interface WelcomeConfig {
    enabled: boolean;
    template: string;
}

/**
 * 解析某群的入群欢迎配置：群级有值优先，null/缺省回落到全局。
 * 纯函数，便于单测；空模板同样视为跟随全局。
 */
export function resolveWelcome(
    override: GroupWelcomeOverride | undefined,
    global: GroupWelcomeConfig | undefined,
): WelcomeConfig {
    const enabled = override?.enabled != null ? override.enabled : !!global?.enabled;
    const ownTemplate = typeof override?.template === 'string' && override.template.trim() ? override.template : '';
    const template = String(ownTemplate || global?.template || '').trim();
    return { enabled: !!enabled, template };
}

/** 渲染欢迎模板；用函数替换避免 id 中的特殊字符被当作替换语法 */
export function renderWelcomeTemplate(
    template: string,
    groupId: string,
    userId: string,
    nickname = '',
    groupName = '',
): string {
    return template
        .replace(/\{group_id\}/g, () => groupId)
        .replace(/\{user_id\}/g, () => userId)
        .replace(/\{nickname\}/g, () => nickname)
        .replace(/\{group_name\}/g, () => groupName);
}
