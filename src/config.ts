/**
 * 插件配置 — 默认值 + WebUI Schema
 */

import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { KeywordRule, PluginConfig } from './types';


/** 规则数组 → 多行文本(每行: 匹配词|类型|回复) */
export function keywordsToText(kw: KeywordRule[]): string {
    return kw.map((k) => `${k.match}|${k.matchType || 'contains'}|${k.reply}`).join('\n');
}

/** 多行文本 → 规则数组(坏行自动跳过) */
export function textToKeywords(text: string): KeywordRule[] {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
            const parts = line.split('|');
            const match = (parts[0] || '').trim();
            const type = (parts[1] || 'contains').trim() === 'prefix' ? 'prefix' : 'contains';
            const reply = parts.slice(2).join('|').trim();
            if (!match || !reply) return null;
            return { match, matchType: type, reply } as KeywordRule;
        })
        .filter((k): k is KeywordRule => k !== null);
}

export const DEFAULT_CONFIG: PluginConfig = {
    enabled: true,
    debug: false,
    cooldownSeconds: 30,
    replyDelayMinMs: 300,
    replyDelayMaxMs: 1200,
    atOnly: false,
    groupConfigs: {},
    keywords: [
        { match: "有", matchType: "prefix", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
        { match: "下载", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
        { match: "没找到", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
    ],
    private: { enabled: false, defaultReply: "【自动回复】我现在不在，稍后回复你。", whitelist: [] },
    group: { enabled: true, whitelist: [] },
    blacklist: [],
};

/** ID 数组 → 多行文本(每行一个 QQ 号/群号) */
export function idListToText(list: (number | string)[] | undefined): string {
    return (list ?? []).map(String).join('\n');
}

/** 多行文本 → ID 数组(每行一个,# 到行尾视为注释,坏行跳过) */
export function textToIdList(text: string | undefined): (number | string)[] {
    if (!text) return [];
    return text
        .split('\n')
        .map((l) => l.split('#')[0].trim())
        .filter(Boolean);
}

export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
    return ctx.NapCatConfig.combine(
        ctx.NapCatConfig.html('<div style="padding:16px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:20px;color:white;"><h3 style="margin:0 0 6px 0;font-size:18px;font-weight:600;">QQ 自动回复</h3><p style="margin:0;font-size:13px;opacity:0.85;">关键词触发 · 私聊/群聊 · 规则热重载</p></div>'),
        ctx.NapCatConfig.boolean('enabled', '启用自动回复', true, '总开关'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">私聊设置</div>'),
        ctx.NapCatConfig.boolean('private.enabled', '私聊自动回复', false, '开启后私聊消息触发自动回复'),
        ctx.NapCatConfig.text('private.defaultReply', '私聊兜底回复', '【自动回复】我现在不在，稍后回复你。', '未命中关键词时的默认回复'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">关键词规则</div>'),
        ctx.NapCatConfig.text('keywordsText', '关键词规则列表', keywordsToText(DEFAULT_CONFIG.keywords), '每行一条:匹配词|类型|回复。类型 prefix=前缀匹配,contains=包含匹配。回复内容中可含 |'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">群聊设置</div>'),
        ctx.NapCatConfig.boolean('group.enabled', '群聊自动回复', true, '开启后群聊消息触发自动回复'),
        ctx.NapCatConfig.boolean('debug', '调试模式', false, '输出详细日志'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">防护设置</div>'),
        ctx.NapCatConfig.number('cooldownSeconds', '回复冷却(秒)', 30, '同一用户命中同一规则后的冷却秒数,冷却期内不再重复回复。0 = 关闭'),
        ctx.NapCatConfig.number('replyDelayMinMs', '回复延迟下限(毫秒)', 300, '回复前随机延迟下限,拟人化行为,降低风控风险'),
        ctx.NapCatConfig.number('replyDelayMaxMs', '回复延迟上限(毫秒)', 1200, '回复前随机延迟上限,需大于等于下限'),
        ctx.NapCatConfig.boolean('atOnly', '群聊仅被 @ 时回复', false, '开启后群聊只有 @ 机器人的消息才会触发自动回复'),
        ctx.NapCatConfig.text('private.whitelistText', '私聊白名单', idListToText(DEFAULT_CONFIG.private.whitelist), '每行一个 QQ 号,# 开头为注释。留空 = 对所有私聊生效;非空 = 仅名单内用户触发'),
        ctx.NapCatConfig.text('group.whitelistText', '群聊白名单(群号)', idListToText(DEFAULT_CONFIG.group.whitelist), '每行一个群号,# 开头为注释。留空 = 对所有群生效;非空 = 仅名单内群触发'),
        ctx.NapCatConfig.text('blacklistText', '黑名单', idListToText(DEFAULT_CONFIG.blacklist), '每行一个 QQ 号,# 开头为注释。名单内的用户不会触发任何自动回复'),
    );
}
