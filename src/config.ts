/**
 * 插件配置 — 默认值 + WebUI Schema
 */

import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from './types';

export const DEFAULT_CONFIG: PluginConfig = {
    enabled: true,
    debug: false,
    keywords: [
        { match: "有", matchType: "prefix", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
        { match: "下载", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
        { match: "没找到", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
    ],
    private: { enabled: false, defaultReply: "【自动回复】我现在不在，稍后回复你。", whitelist: [] },
    group: { enabled: true, whitelist: [] },
    blacklist: [],
};

export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
    return ctx.NapCatConfig.combine(
        ctx.NapCatConfig.html('<div style="padding:16px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:20px;color:white;"><h3 style="margin:0 0 6px 0;font-size:18px;font-weight:600;">QQ 自动回复</h3><p style="margin:0;font-size:13px;opacity:0.85;">关键词触发 · 私聊/群聊 · 规则热重载</p></div>'),
        ctx.NapCatConfig.boolean('enabled', '启用自动回复', true, '总开关'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">私聊设置</div>'),
        ctx.NapCatConfig.boolean('private.enabled', '私聊自动回复', false, '开启后私聊消息触发自动回复'),
        ctx.NapCatConfig.text('private.defaultReply', '私聊兜底回复', '【自动回复】我现在不在，稍后回复你。', '未命中关键词时的默认回复'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">群聊设置</div>'),
        ctx.NapCatConfig.boolean('group.enabled', '群聊自动回复', true, '开启后群聊消息触发自动回复'),
        ctx.NapCatConfig.boolean('debug', '调试模式', false, '输出详细日志'),
    );
}
