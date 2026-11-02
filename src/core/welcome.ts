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

export type WelcomeMessageSegment =
    | { type: 'at'; data: { qq: string } }
    | { type: 'text'; data: { text: string } };

/** 只认模板开头的 @{nickname}（允许前导空白），其余位置保持纯文本。 */
const LEADING_AT = /^\s*@\{nickname\}/;

/**
 * 把欢迎模板转成 OneBot 消息段：
 * - 开头是 `@{nickname}`：生成真正的 at 段，剩余文本渲染后跟一段 text；
 * - 昵称取不到也照样发 at（qq=userId，QQ 会显示昵称），不报错；
 * - 其它位置的 `@{nickname}` 按渲染后的纯文本输出，避免多点 @ 刷屏。
 * - 模板为空 / 只剩 @ 时返回最短的合法消息段数组。
 */
export function buildWelcomeMessage(
    template: string,
    groupId: string,
    userId: string,
    nickname = '',
    groupName = '',
): WelcomeMessageSegment[] {
    const raw = String(template ?? '');
    const matched = raw.match(LEADING_AT);
    if (!matched) {
        const text = renderWelcomeTemplate(raw, groupId, userId, nickname, groupName).trim();
        return text ? [{ type: 'text', data: { text } }] : [];
    }
    const rest = raw.slice(matched[0].length);
    const text = renderWelcomeTemplate(rest, groupId, userId, nickname, groupName).replace(/^\s+/, '');
    const segments: WelcomeMessageSegment[] = [{ type: 'at', data: { qq: userId } }];
    if (text) segments.push({ type: 'text', data: { text } });
    return segments;
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
