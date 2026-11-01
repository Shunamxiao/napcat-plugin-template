/**
 * NapCat 插件模板 - 主入口
 *
 * 导出 PluginModule 接口定义的生命周期函数，NapCat 加载插件时会调用这些函数。
 *
 * 生命周期：
 *   plugin_init        → 插件加载时调用（必选）
 *   plugin_onmessage   → 收到事件时调用（需通过 post_type 判断事件类型）
 *   plugin_onevent     → 收到所有 OneBot 事件时调用
 *   plugin_cleanup     → 插件卸载/重载时调用
 *
 * 配置相关：
 *   plugin_config_ui          → 导出配置 Schema，用于 WebUI 自动生成配置面板
 *   plugin_get_config         → 自定义配置读取
 *   plugin_set_config         → 自定义配置保存
 *   plugin_on_config_change   → 配置变更回调
 *
 * @author Your Name
 * @license MIT
 */

import type {
    PluginModule,
    PluginConfigSchema,
    PluginConfigUIController,
    NapCatPluginContext,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';
import fs from 'fs';
import path from 'path';

import { DEFAULT_CONFIG, buildConfigSchema, groupRulesToText, idListToText, keywordsToText, textToGroupRules, textToIdList, textToKeywords, textToLines } from './config';
import { maskConfig, pluginState } from './core/state';
import { buildGroupPolicies } from './core/policy';
import { startBlocklistSync, stopBlocklistSync } from './core/blocklist';
import { clearPrivateMerge, handleMessage } from './handlers/message-handler';
import { handleOneBotEvent } from './handlers/event-handler';
import { registerApiRoutes } from './services/api-service';
import type { PluginConfig } from './types';

// ==================== 配置 UI Schema ====================

/** NapCat WebUI 读取此导出来展示配置面板 */
export let plugin_config_ui: PluginConfigSchema = [];

// ==================== 生命周期函数 ====================

/**
 * 插件初始化（必选）
 * 加载配置、注册 WebUI 路由和页面
 */
export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
    try {
        // 1. 初始化全局状态（加载配置）
        pluginState.init(ctx);

        ctx.logger.info('插件初始化中...');

        // 2. 生成配置 Schema（用于 NapCat WebUI 配置面板）
        plugin_config_ui = buildConfigSchema(ctx);

        // 3. 注册 WebUI 页面和静态资源
        registerWebUI(ctx);

        // 4. 注册 API 路由
        registerApiRoutes(ctx);

        // 5. 拉黑名单：先拉一次，之后按 syncSeconds 定时拉取
        startBlocklistSync();

        ctx.logger.info('插件初始化完成');
    } catch (error) {
        ctx.logger.error('插件初始化失败:', error);
    }
};

/**
 * 消息/事件处理（可选）
 * 收到事件时调用，需通过 post_type 判断是否为消息事件
 */
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    // 仅处理消息事件
    if (event.post_type !== EventType.MESSAGE) return;
    // 检查插件是否启用
    if (!pluginState.config.enabled) return;
    // 委托给消息处理器
    await handleMessage(ctx, event);
};

/**
 * 事件处理（可选）
 * 处理所有 OneBot 事件（通知、请求等）
 */
export const plugin_onevent: PluginModule['plugin_onevent'] = async (ctx, event) => {
    try {
        // 入群欢迎、好友申请自动通过；均由独立配置控制，不受自动回复总开关影响
        await handleOneBotEvent(ctx, event);
    } catch (e) {
        ctx.logger.error('非消息事件处理失败:', e);
    }
};

/**
 * 插件卸载/重载（可选）
 * 必须清理定时器、关闭连接等资源
 */
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        // 先停拉黑同步定时器，再清理插件状态（热重载不泄漏）
        stopBlocklistSync();
        clearPrivateMerge();
        pluginState.cleanup();
        ctx.logger.info('插件已卸载');
    } catch (e) {
        ctx.logger.warn('插件卸载时出错:', e);
    }
};

// ==================== 配置管理钩子 ====================

/** 获取当前配置 */
export const plugin_get_config: PluginModule['plugin_get_config'] = async (ctx) => {
    // 出口一律打码：真 token 只留在磁盘配置与请求头里，不进任何响应
    const cfg = maskConfig(pluginState.config);
    return {
        ...cfg,
        keywordsText: keywordsToText(cfg.keywords),
        groupRulesText: groupRulesToText(cfg.groupRules),
        groupPolicies: buildGroupPolicies(cfg),
        private: { ...cfg.private, whitelistText: idListToText(cfg.private.whitelist) },
        group: { ...cfg.group, whitelistText: idListToText(cfg.group.whitelist) },
        blacklistText: idListToText(cfg.blacklist),
        guard: {
            ...cfg.guard,
            groupIdsText: idListToText(cfg.guard.groupIds),
            wordsText: (cfg.guard.words ?? []).join('\n'),
        },
    };
};

/** 设置配置（完整替换，由 NapCat WebUI 调用） */
export const plugin_set_config: PluginModule['plugin_set_config'] = async (ctx, config) => {
    const cfg = { ...(config as PluginConfig) };
    if (typeof cfg.keywordsText === 'string' && cfg.keywordsText.trim()) {
        // WebUI 提交了编辑后的规则文本 → 解析回结构化数组
        const parsed = textToKeywords(cfg.keywordsText);
        if (parsed.length > 0) cfg.keywords = parsed;
        else cfg.keywordsText = keywordsToText(Array.isArray(cfg.keywords) ? cfg.keywords : []);
    } else {
        // 文本缺失(如外部 API 直接改 keywords) → 从规则反推文本
        cfg.keywordsText = keywordsToText(Array.isArray(cfg.keywords) ? cfg.keywords : []);
    }
    // 白名单/黑名单:文本存在则解析回数组,否则从数组反推文本(与 keywordsText 同一双向同步模式)
    const syncList = (list, text) => {
        if (typeof text === 'string' && text.trim()) return { list: textToIdList(text), text };
        return { list, text: idListToText(list) };
    };
    const p = syncList(cfg.private?.whitelist ?? [], cfg.private?.whitelistText);
    const g = syncList(cfg.group?.whitelist ?? [], cfg.group?.whitelistText);
    const b = syncList(cfg.blacklist ?? [], cfg.blacklistText);
    cfg.private = { ...(cfg.private ?? DEFAULT_CONFIG.private), whitelist: p.list, whitelistText: p.text };
    cfg.group = { ...(cfg.group ?? DEFAULT_CONFIG.group), whitelist: g.list, whitelistText: g.text };
    cfg.blacklist = b.list;
    cfg.blacklistText = b.text;
    // 忽略发送者：文本存在则解析回数组，否则从数组反推文本
    const ig = syncList(cfg.ignoreSenders ?? pluginState.config.ignoreSenders ?? [], cfg.ignoreSendersText);
    cfg.ignoreSenders = ig.list.map(String);
    cfg.ignoreSendersText = ig.text;

    // 群内容守卫：群号/屏蔽词同样保持「文本优先，否则由数组反推」的双向同步
    if (!cfg.guard) {
        cfg.guard = pluginState.config.guard;
    } else {
        const syncLines = (list: unknown, text: unknown): { list: string[]; text: string } => {
            if (typeof text === 'string') return { list: textToLines(text), text };
            const values = Array.isArray(list) ? list.map(String).map((s) => s.trim()).filter(Boolean) : [];
            return { list: values, text: values.join('\n') };
        };
        const gids = syncLines(cfg.guard.groupIds, cfg.guard.groupIdsText);
        const words = syncLines(cfg.guard.words, cfg.guard.wordsText);
        cfg.guard = { ...cfg.guard, groupIds: gids.list, groupIdsText: gids.text, words: words.list, wordsText: words.text };
    }

    // 群级规则:合法 JSON 文本覆盖结构化规则;非法文本忽略,且不丢失已有规则
    const parsedGroupRules = textToGroupRules(cfg.groupRulesText);
    if (parsedGroupRules) {
        cfg.groupRules = parsedGroupRules;
    } else if (cfg.groupRules === undefined) {
        cfg.groupRules = pluginState.config.groupRules ?? {};
    }
    cfg.groupRulesText = groupRulesToText(cfg.groupRules);

    // 知识库相关配置块：老页面/原生面板没提交时沿用当前值，避免一次保存把配置清空
    if (!cfg.kbService) cfg.kbService = pluginState.config.kbService;
    if (!cfg.aiTrigger) cfg.aiTrigger = pluginState.config.aiTrigger;
    if (!cfg.blocklist) cfg.blocklist = pluginState.config.blocklist;
    if (!cfg.fallback) cfg.fallback = pluginState.config.fallback;
    if (!cfg.collect) cfg.collect = pluginState.config.collect;
    else if (!Array.isArray(cfg.collect.questions)) cfg.collect.questions = pluginState.config.collect.questions;
    if (!cfg.relay) cfg.relay = pluginState.config.relay;
    if (!cfg.sendGuard) cfg.sendGuard = pluginState.config.sendGuard;
    if (!cfg.loopGuard) cfg.loopGuard = pluginState.config.loopGuard;

    pluginState.replaceConfig(cfg);
    ctx.logger.info('配置已通过 WebUI 更新, 当前规则数:', Array.isArray(cfg.keywords) ? cfg.keywords.length : 0);
};

/**
 * 配置变更回调
 * 当 WebUI 中修改单个配置项时触发（需配置项标记 reactive: true）
 */
export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
    ctx, ui, key, value, currentConfig
) => {
    try {
        pluginState.updateConfig({ [key]: value });
        ctx.logger.debug(`配置项 ${key} 已更新`);
    } catch (err) {
        ctx.logger.error(`更新配置项 ${key} 失败:`, err);
    }
};

// ==================== 内部函数 ====================

/**
 * 注册 WebUI 页面和静态资源
 */

/** 独立配置专页（扩展页面列表中可直达） */
const SETTINGS_PAGE_HTML = String.raw`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自动回复配置</title><style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:16px;background:#f6f7fb;color:#222}
h1{font-size:20px;margin:4px 0 14px}
.card{background:#fff;border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
h2{font-size:15px;margin:0 0 10px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0}
label{font-size:14px;color:#333}
input[type=text],input[type=number],input[type=password]{padding:7px 9px;border:1px solid #ddd;border-radius:8px;font-size:13px}
input.w-match{width:150px}input.w-reply{flex:1;min-width:220px}
select{padding:7px 6px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff}
textarea{width:100%;box-sizing:border-box;min-height:110px;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:ui-monospace,monospace}
button{border:0;border-radius:8px;padding:7px 14px;cursor:pointer;background:#4f6ef7;color:#fff;font-size:13px}
button.gray{background:#8a8f9c}button.danger{background:#e5484d}
.kw{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed #eee}
.grp{border:1px solid #e4e7f2;border-radius:10px;padding:10px 12px;margin:10px 0;background:#fbfcff}
.grp-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.grp-id{font-weight:600;font-size:14px;margin-right:auto}
.gkw{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed #eee}
.tag{font-size:12px;padding:2px 8px;border-radius:6px;background:#eef;color:#345}
.muted{color:#888;font-size:12px}
.policy{margin:6px 0 8px;color:#4a5568;background:#eef2ff;border-radius:8px;padding:5px 9px}
.toast{position:fixed;top:14px;right:14px;background:#222;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;z-index:99}
.toast.err{background:#c0392b}
</style></head><body>
<h1>QQ 自动回复配置</h1>
<div class="card"><h2>总开关</h2><label><input type="checkbox" id="enabled"> 启用自动回复</label><p class="muted">关闭后私聊与群聊都不再自动回复。</p></div>
<div class="card"><h2>私聊</h2><label><input type="checkbox" id="pv-enabled"> 私聊自动回复</label><p class="muted">未命中关键词/FAQ 时回下方「私聊兜底」。同一用户连续发多条时，窗口内的消息合并成一次问答（换行拼接，最多 5 条）；0 = 关闭。</p><div class="row"><label>连发合并(毫秒)</label><input type="number" id="pv-merge" class="w-match" min="0" max="60000"></div></div>
<div class="card"><h2>兜底话术</h2><p class="muted">私聊未命中关键词/FAQ 必回第一句；群内被 @ 但未命中必回第二句；群内未 @ 且未命中静默不回。群级规则可单独覆盖。</p><div class="row"><label>私聊兜底</label><input type="text" id="fb-private" class="w-reply" placeholder="私聊兜底话术"></div><div class="row"><label>群内 @ 兜底</label><input type="text" id="fb-group-at" class="w-reply" placeholder="群内 @ 兜底话术"></div></div>
<div class="card"><h2>转人工追问</h2><p class="muted">仅当关键词动作=「转人工」时生效。关闭 = 直接回兜底话术；开启 = 按顺序逐条发问并等待回答，同一用户 5 分钟未答按超时处理。</p><label><input type="checkbox" id="collect-enabled"> 开启追问</label><textarea id="collect-questions" placeholder="一行一题，例如：&#10;你的 QQ 号是多少？&#10;具体是哪个游戏/资源？"></textarea></div>
<div class="card"><h2>反向下发（relay）</h2><p class="muted">供服务侧 Telegram 回流调用：POST /plugin/napcat-plugin-autoreply/api/relay，请求头 x-relay-token 必须与这里一致；令牌为空时该端点直接拒绝。</p><div class="row"><label>relay 令牌</label><input type="text" id="relay-token" class="w-reply" placeholder="留空 = 禁用 /api/relay"></div></div>
<div class="card"><h2>关键词规则</h2><p class="muted">每条规则一行：匹配词 + 类型（包含/前缀/正则）+ 回复话术。回复可填多条，用 ||| 分隔，命中后随机选一条；正则示例：^有.+ 或 下载|安装。<br>图片只支持 <b>jpg/png/webp/gif</b>（avif 等格式 QQ 不显示，会被跳过）；建议用 CDN 直链，小图可用 base64://。</p><div id="kw-list"></div><div class="row"><button class="gray" id="kw-add">+ 添加规则</button></div></div>
<div class="card"><h2>群聊</h2><div class="row"><label><input type="checkbox" id="gr-enabled"> 开启群消息自动回复</label><label><input type="checkbox" id="gr-atonly"> 仅被 @ 时回复</label></div><div class="row"><label>冷却（秒）</label><input type="number" id="cooldown" class="w-match" min="0"> <label>延迟(ms)</label><input type="number" id="delay-min" class="w-match" min="0"> ~ <input type="number" id="delay-max" class="w-match" min="0"></div><p class="muted">冷却：同一人触发同一规则的最短间隔；延迟：回复前随机等待，拟人防风控。</p></div>
<div class="card"><h2>防对刷</h2><p class="muted">两个机器人同群跑同一套规则时会互相触发。忽略的发送者命中后直接丢弃（不记冷却、不回复）；自回声：消息与本群/本用户 60 秒内最后一条已发回复完全相同也会丢弃；群内对刷熔断：窗口内发出达到阈值即暂停该群。<br><b>两个实例都要填：忽略的发送者 = 1457278554、3788767702。</b></p><div class="row"><label>忽略的 QQ 号</label><textarea id="ignore-senders" rows="3" placeholder="每行一个 QQ 号"></textarea></div><div class="row"><label>熔断阈值(条)</label><input type="number" id="lg-max" class="w-match" min="1" max="100"> <label>窗口(秒)</label><input type="number" id="lg-window" class="w-match" min="1" max="3600"> <label>暂停(秒)</label><input type="number" id="lg-pause" class="w-match" min="1" max="86400"></div></div>
<div class="card"><h2>群内容守卫</h2><p class="muted">群消息正文命中屏蔽词时自动撤回。只处理群消息，不踢人、不禁言；撤回失败只记日志、不重试。词表每行一个（大小写不敏感）；生效群号留空 = 所有已启用自动回复的群。</p><div class="row"><label><input type="checkbox" id="guard-enabled"> 启用群内容守卫</label><label>命中动作</label><select id="guard-action"><option value="recall">仅撤回</option><option value="warn">仅警告</option><option value="both">撤回并警告</option></select></div><div class="row"><label>生效群号</label><textarea id="guard-groups" rows="3" placeholder="每行一个群号；留空 = 所有已启用群"></textarea></div><div class="row"><label>屏蔽词</label><textarea id="guard-words" rows="4" placeholder="每行一个词"></textarea></div><div class="row"><label>警告话术</label><input type="text" id="guard-warn-text" class="w-reply" placeholder="action=警告时发到群里"></div></div>
<div class="card"><h2>群级规则（可选）</h2><p class="muted">按群单独配置（仍受上方群聊总开关控制）。<b>只有列在下面的群才会被处理，未列出的群一律静默（即使被 @ 也不回）。</b>可关闭本群自动回复、设置仅 @ 时回复，或配置本群专属关键词。本群专属关键词留空时沿用全局关键词；回复多条用 ||| 分隔。</p><div id="grp-list"></div><p class="muted" id="grp-empty">尚未添加群级规则。</p><div class="row"><button class="gray" id="grp-add">+ 添加群规则</button></div><div class="row" id="grp-add-row" style="display:none"><input type="text" id="grp-new-id" class="w-match" inputmode="numeric" placeholder="群号（纯数字）"><button id="grp-add-confirm">确定添加</button><button class="gray" id="grp-add-cancel">取消</button></div></div>
<div class="card"><h2>知识库 / AI</h2><p class="muted">开启后：未命中关键词的私聊/群消息会先问知识库服务；命中规则且勾选「允许升级 AI」时也先问服务，拿不到答案再退回规则话术。服务不可用时保持原有自动回复。</p><div class="row"><label><input type="checkbox" id="kb-enabled"> 启用知识库 / AI</label><label>超时(ms)</label><input type="number" id="kb-timeout" class="w-match" min="500" max="60000"></div><div class="row"><label>服务地址</label><input type="text" id="kb-baseurl" class="w-reply" placeholder="https://qqbot.theworld.codes"></div><div class="row"><label>访问令牌</label><input type="password" id="kb-token" class="w-reply" autocomplete="new-password" placeholder="x-bot-token（留空 = 不调用服务）"></div><div class="row"><label><input type="checkbox" id="ai-private"> 私聊未命中升级 AI</label><label><input type="checkbox" id="ai-group-atonly"> 群内仅 @ / 回复机器人时升级 AI</label></div><div class="row"><label>拉黑缓存（只读，权威在服务侧）</label><span class="muted" id="bl-synced">尚未同步</span></div><div id="bl-list" style="max-height:130px;overflow:auto;font-size:13px;line-height:1.6;background:#fbfcff;border:1px solid #e4e7f2;border-radius:8px;padding:8px"></div></div>
<div class="card"><h2>机器人能力</h2><p class="muted">以下能力独立于上方「启用自动回复」总开关，默认全部关闭。</p><div class="row"><label><input type="checkbox" id="at-reply"> 群聊回复时 @ 触发者</label></div><div class="row"><label><input type="checkbox" id="gw-enabled"> 入群欢迎</label><label>模板</label><input type="text" id="gw-template" class="w-reply" placeholder="欢迎 {user_id} 加入本群！支持 {group_id}、{user_id}"></div><div class="row"><label>发送失败熔断：群</label><input type="number" id="sg-group" class="w-match" min="1" max="100"> 次 <label>私聊</label><input type="number" id="sg-private" class="w-match" min="1" max="100"> 次 <label>冷却(秒)</label><input type="number" id="sg-cooldown" class="w-match" min="1" max="86400"></div><p class="muted">同一群/同一用户连续发送失败达阈值即暂停发送，冷却结束自动恢复；QQ 侧拒绝不重试，网络/超时错误间隔 2 秒重试一次。</p><div class="row"><label><input type="checkbox" id="fr-autoaccept"> 自动通过好友申请</label><span class="muted">高风险，建议仅小号开启</span></div></div>
<div class="row"><button id="save">保存配置</button></div>
<script>
var cfg = null;
function toast(msg, err){ var d=document.createElement('div'); d.className='toast'+(err?' err':''); d.textContent=msg; document.body.appendChild(d); setTimeout(function(){ d.remove(); }, 3000); }
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function replyPoolText(k){ return (k && k.replies && k.replies.length) ? k.replies.join('|||') : ((k && k.reply) || ''); }
function actionSelect(cls, action){
  var a = action || 'reply';
  var opts = [['reply','回固定文案'],['ai','直接问 AI'],['human','转人工']];
  var html = '';
  opts.forEach(function(o){ html += '<option value="' + o[0] + '"' + (a === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; });
  return '<select class="' + cls + '">' + html + '</select>';
}
function typeSelect(cls, type){
  return '<select class="' + cls + '"><option value="contains"' + (type==='prefix'||type==='regex'?'':' selected') + '>包含</option><option value="prefix"' + (type==='prefix'?' selected':'') + '>前缀</option><option value="regex"' + (type==='regex'?' selected':'') + '>正则</option></select>';
}
function rowHtml(k, i){
  return '<div class="kw" data-i="' + i + '"><input type="text" class="kw-match w-match" value="' + esc(k.match) + '" placeholder="匹配词/正则">' + typeSelect('kw-type', k.matchType || 'contains') + '<input type="text" class="kw-reply w-reply" value="' + esc(replyPoolText(k)) + '" placeholder="回复话术（多条用 ||| 分隔）">' + actionSelect('kw-action', k.action) + '<label class="muted" style="white-space:nowrap"><input type="checkbox" class="kw-ai"' + (k.aiFallback ? ' checked' : '') + '> 先问 AI 再回文案</label><input type="text" class="kw-img w-match" value="' + esc(k.image || '') + '" placeholder="图片URL/路径(可选)"><button class="danger kw-del">删除</button></div>';
}
function groupKwRowHtml(k){
  k = k || {};
  return '<div class="gkw"><input type="text" class="gkw-match w-match" value="' + esc(k.match) + '" placeholder="匹配词/正则">' + typeSelect('gkw-type', k.matchType || 'contains') + '<input type="text" class="gkw-reply w-reply" value="' + esc(replyPoolText(k)) + '" placeholder="回复话术（多条用 ||| 分隔）">' + actionSelect('gkw-action', k.action) + '<label class="muted" style="white-space:nowrap"><input type="checkbox" class="gkw-ai"' + (k.aiFallback ? ' checked' : '') + '> 先问 AI 再回文案</label><input type="text" class="gkw-img w-match" value="' + esc(k.image || '') + '" placeholder="图片URL/路径(可选)"><button class="danger gkw-del">删除</button></div>';
}
function policyLine(gid, rule){
  var p = (cfg && cfg.groupPolicies && cfg.groupPolicies[gid]) || null;
  var enabled, enabledSrc, atOnly, atOnlySrc, ai, aiSrc;
  if (p) {
    enabled = p.enabled.value; enabledSrc = p.enabled.source === 'group' ? '群级' : '全局';
    atOnly = p.atOnly.value; atOnlySrc = p.atOnly.source === 'group' ? '群级' : '全局';
    ai = p.aiEnabled.value; aiSrc = p.aiEnabled.source === 'group' ? '群级' : '全局';
  } else {
    enabled = rule && rule.enabled != null ? rule.enabled : true; enabledSrc = rule && rule.enabled != null ? '群级' : '全局';
    atOnly = rule && rule.atOnly != null ? rule.atOnly : !!(cfg && cfg.atOnly); atOnlySrc = rule && rule.atOnly != null ? '群级' : '全局';
    ai = rule && rule.aiEnabled != null ? rule.aiEnabled : true; aiSrc = rule && rule.aiEnabled != null ? '群级' : '全局';
  }
  return '<div class="policy">生效口径：启用=' + (enabled ? '是' : '否') + '（' + enabledSrc + '） · 仅@=' + (atOnly ? '是' : '否') + '（' + atOnlySrc + '） · AI=' + (ai ? '允许' : '禁止') + '（' + aiSrc + '）</div>';
}
function groupCardHtml(gid, rule){
  rule = rule || {};
  var atOnly = rule.atOnly != null ? !!rule.atOnly : !!(cfg && cfg.atOnly);
  var kwHtml = (Array.isArray(rule.keywords) ? rule.keywords : []).map(groupKwRowHtml).join('');
  if (!kwHtml) kwHtml = '<p class="muted grp-kw-empty">本群暂无专属关键词，沿用全局关键词。</p>';
  var w = rule.welcome || {};
  var welcomeMode = w.enabled === true ? 'on' : (w.enabled === false ? 'off' : '');
  var welcomeTpl = typeof w.template === 'string' ? w.template : '';
  var welcomeSel = '<select class="grp-welcome-mode"><option value=""' + (welcomeMode === '' ? ' selected' : '') + '>跟随全局</option><option value="on"' + (welcomeMode === 'on' ? ' selected' : '') + '>本群开启</option><option value="off"' + (welcomeMode === 'off' ? ' selected' : '') + '>本群关闭</option></select>';
  var fb = rule.fallback || {};
  var fbPrivate = typeof fb.privateText === 'string' ? fb.privateText : '';
  var fbGroupAt = typeof fb.groupAtText === 'string' ? fb.groupAtText : '';
  return '<div class="grp" data-gid="' + esc(gid) + '"><div class="grp-head"><span class="grp-id">群 ' + esc(gid) + '</span><label><input type="checkbox" class="grp-enabled"' + (rule.enabled !== false ? ' checked' : '') + '> 启用本群自动回复</label><label><input type="checkbox" class="grp-atonly"' + (atOnly ? ' checked' : '') + '> 仅 @ 时回复</label><label><input type="checkbox" class="grp-ai"' + (rule.aiEnabled !== false ? ' checked' : '') + '> 允许 AI 升级</label><button class="danger grp-del">删除群规则</button></div>' + policyLine(gid, rule) + '<div class="row grp-fallback"><label>兜底话术</label><input type="text" class="grp-fb-private w-reply" value="' + esc(fbPrivate) + '" placeholder="私聊兜底（留空跟随全局）"><input type="text" class="grp-fb-group w-reply" value="' + esc(fbGroupAt) + '" placeholder="群@兜底（留空跟随全局）"></div><div class="row grp-welcome"><label>入群欢迎</label>' + welcomeSel + '<input type="text" class="grp-welcome-tpl w-reply" value="' + esc(welcomeTpl) + '" placeholder="欢迎模板，留空跟随全局（支持 {user_id}、{group_id}）"></div><p class="muted">本群专属关键词（留空沿用全局关键词；有内容则只按本群关键词匹配；回复多条用 ||| 分隔）</p><div class="gkw-list">' + kwHtml + '</div><div class="row"><button class="gray grp-kw-add">+ 添加匹配词</button></div></div>';
}
function refreshGrpEmpty(){
  el('grp-empty').style.display = document.querySelectorAll('#grp-list .grp').length ? 'none' : '';
}
function renderGroupRules(){
  var rules = (cfg && cfg.groupRules) || {};
  var host = el('grp-list'); host.innerHTML = '';
  Object.keys(rules).forEach(function(gid){ host.insertAdjacentHTML('beforeend', groupCardHtml(gid, rules[gid])); });
  refreshGrpEmpty();
}
function addGroupRule(){
  var input = el('grp-new-id');
  var gid = input.value.trim();
  if (!/^\d+$/.test(gid)) { toast('群号必须为数字', true); input.focus(); return; }
  var exists = [].slice.call(document.querySelectorAll('#grp-list .grp')).some(function(card){ return card.getAttribute('data-gid') === gid; });
  if (exists) { toast('群号已存在: ' + gid, true); input.focus(); return; }
  el('grp-list').insertAdjacentHTML('beforeend', groupCardHtml(gid, { enabled: true }));
  input.value = '';
  el('grp-add-row').style.display = 'none';
  refreshGrpEmpty();
  toast('已添加群 ' + gid + '，保存后生效');
}
function renderKeywords(){
  var host = el('kw-list'); host.innerHTML = '';
  (cfg.keywords||[]).forEach(function(k,i){ host.insertAdjacentHTML('beforeend', rowHtml(k,i)); });
}
function renderBlocklist(){
  var bl = cfg.blocklist || {};
  var users = Array.isArray(bl.users) ? bl.users : [];
  var host = el('bl-list'); host.innerHTML = '';
  if (!users.length) { host.textContent = '暂无拉黑用户'; }
  users.forEach(function(u){
    var d = document.createElement('div');
    d.textContent = String(u.userId || '') + (u.reason ? ' — ' + u.reason : '') + (u.ts ? '（' + u.ts + '）' : '');
    host.appendChild(d);
  });
  el('bl-synced').textContent = bl.lastSyncedAt ? ('上次同步：' + bl.lastSyncedAt) : '尚未同步（需要填写令牌；服务不可达时保留旧缓存）';
}
function render(){
  el('enabled').checked = !!cfg.enabled;
  el('pv-enabled').checked = !!(cfg.private && cfg.private.enabled);
  el('pv-merge').value = cfg.private && cfg.private.mergeWindowMs != null ? cfg.private.mergeWindowMs : 3000;
  el('gr-enabled').checked = !!(cfg.group && cfg.group.enabled);
  el('gr-atonly').checked = !!cfg.atOnly;
  el('at-reply').checked = !!cfg.atReply;
  el('gw-enabled').checked = !!(cfg.groupWelcome && cfg.groupWelcome.enabled);
  el('gw-template').value = (cfg.groupWelcome && cfg.groupWelcome.template) || '';
  el('fr-autoaccept').checked = !!(cfg.friendRequest && cfg.friendRequest.autoAccept);
  var sg = cfg.sendGuard || {};
  el('sg-group').value = sg.failThreshold != null ? sg.failThreshold : 3;
  el('sg-private').value = sg.privateFailThreshold != null ? sg.privateFailThreshold : 5;
  el('sg-cooldown').value = sg.cooldownSeconds != null ? sg.cooldownSeconds : 600;
  el('ignore-senders').value = Array.isArray(cfg.ignoreSenders) ? cfg.ignoreSenders.join(String.fromCharCode(10)) : '';
  var lg = cfg.loopGuard || {};
  el('lg-max').value = lg.maxReplies != null ? lg.maxReplies : 5;
  el('lg-window').value = lg.windowSeconds != null ? lg.windowSeconds : 60;
  el('lg-pause').value = lg.pauseSeconds != null ? lg.pauseSeconds : 300;
  var gd = cfg.guard || {};
  el('guard-enabled').checked = !!gd.enabled;
  el('guard-action').value = gd.action === 'warn' || gd.action === 'both' ? gd.action : 'recall';
  el('guard-groups').value = Array.isArray(gd.groupIds) ? gd.groupIds.join(String.fromCharCode(10)) : '';
  el('guard-words').value = Array.isArray(gd.words) ? gd.words.join(String.fromCharCode(10)) : '';
  el('guard-warn-text').value = gd.warnText != null ? gd.warnText : '';
  var fb = cfg.fallback || {};
  el('fb-private').value = fb.privateText != null ? fb.privateText : '';
  el('fb-group-at').value = fb.groupAtText != null ? fb.groupAtText : '';
  var collect = cfg.collect || {};
  el('collect-enabled').checked = !!collect.enabled;
  el('collect-questions').value = Array.isArray(collect.questions) ? collect.questions.join(String.fromCharCode(10)) : '';
  el('relay-token').value = (cfg.relay && cfg.relay.token) || '';
  el('cooldown').value = cfg.cooldownSeconds != null ? cfg.cooldownSeconds : 30;
  el('delay-min').value = cfg.replyDelayMinMs != null ? cfg.replyDelayMinMs : 300;
  el('delay-max').value = cfg.replyDelayMaxMs != null ? cfg.replyDelayMaxMs : 1200;
  var kb = cfg.kbService || {};
  el('kb-enabled').checked = !!kb.enabled;
  el('kb-baseurl').value = kb.baseUrl || 'https://qqbot.theworld.codes';
  el('kb-token').value = '';
  el('kb-token').placeholder = kb.token ? '已配置（••••••），留空不修改' : 'x-bot-token（留空 = 不调用服务）';
  el('kb-timeout').value = kb.timeoutMs != null ? kb.timeoutMs : 8000;
  var at = cfg.aiTrigger || {};
  el('ai-private').checked = at.private !== false;
  el('ai-group-atonly').checked = at.groupAtOnly !== false;
  renderBlocklist();
  renderGroupRules();
  renderKeywords();
}
async function load(){
  try { var r = await fetch('/plugin/napcat-plugin-autoreply/api/config'); var j = await r.json(); cfg = j.data || j; render(); }
  catch(e){ toast('加载失败: ' + e, true); }
}
function collect(){
  var rows = [].slice.call(document.querySelectorAll('#kw-list .kw'));
  var keywords = [];
  rows.forEach(function(row){
    var m = row.querySelector('.kw-match').value.trim();
    var t = row.querySelector('.kw-type').value;
    var rep = row.querySelector('.kw-reply').value.trim();
    var act = row.querySelector('.kw-action').value;
    var img = row.querySelector('.kw-img').value.trim();
    var ai = !!row.querySelector('.kw-ai').checked;
    var pool = rep.split('|||').map(function(s){ return s.trim(); }).filter(Boolean);
    if (!m || (act !== 'ai' && !pool.length && !img)) return;
    if (t === 'regex') { try { new RegExp(m); } catch(e){ throw new Error('正则无效: ' + m); } }
    var kw = { match: m, matchType: t, reply: pool[0] || '', action: act };
    if (pool.length > 1) kw.replies = pool;
    if (img) kw.image = img;
    if (ai) kw.aiFallback = true;
    keywords.push(kw);
  });
  if (!keywords.length) throw new Error('至少保留一条关键词规则');
  var grules = collectGroupRules();
  var next = Object.assign({}, cfg, {
    enabled: el('enabled').checked,
    keywords: keywords,
    keywordsText: keywords.map(function(k){
      var act = k.action && k.action !== 'reply' ? k.action : '';
      var extra = [];
      if (k.image) extra.push(k.image); else if (k.aiFallback || act) extra.push('');
      if (k.aiFallback) extra.push('ai'); else if (act) extra.push('');
      if (act) extra.push(act);
      return k.match + '|' + k.matchType + '|' + k.reply + (extra.length ? '|' + extra.join('|') : '');
    }).join(String.fromCharCode(10)),
    private: Object.assign({}, cfg.private, { enabled: el('pv-enabled').checked, mergeWindowMs: Number(el('pv-merge').value || 0) }),
    group: Object.assign({}, cfg.group, { enabled: el('gr-enabled').checked }),
    atOnly: el('gr-atonly').checked,
    atReply: el('at-reply').checked,
    fallback: { privateText: el('fb-private').value.trim(), groupAtText: el('fb-group-at').value.trim() },
    collect: {
      enabled: el('collect-enabled').checked,
      questions: el('collect-questions').value.split(String.fromCharCode(10)).map(function(s){ return s.trim(); }).filter(Boolean)
    },
    relay: { token: el('relay-token').value.trim() },
    sendGuard: {
      failThreshold: Number(el('sg-group').value || 3),
      privateFailThreshold: Number(el('sg-private').value || 5),
      cooldownSeconds: Number(el('sg-cooldown').value || 600)
    },
    ignoreSenders: el('ignore-senders').value.split(String.fromCharCode(10)).map(function(s){ return s.trim(); }).filter(Boolean),
    loopGuard: {
      maxReplies: Number(el('lg-max').value || 5),
      windowSeconds: Number(el('lg-window').value || 60),
      pauseSeconds: Number(el('lg-pause').value || 300)
    },
    guard: {
      enabled: el('guard-enabled').checked,
      groupIds: el('guard-groups').value.split(String.fromCharCode(10)).map(function(s){ return s.trim(); }).filter(Boolean),
      words: el('guard-words').value.split(String.fromCharCode(10)).map(function(s){ return s.trim(); }).filter(Boolean),
      action: el('guard-action').value,
      warnText: el('guard-warn-text').value.trim()
    },
    kbService: { enabled: el('kb-enabled').checked, baseUrl: el('kb-baseurl').value.trim(), token: el('kb-token').value.trim(), timeoutMs: Number(el('kb-timeout').value || 8000) },
    aiTrigger: { private: el('ai-private').checked, groupAtOnly: el('ai-group-atonly').checked },
    groupWelcome: Object.assign({}, cfg.groupWelcome, { enabled: el('gw-enabled').checked, template: el('gw-template').value.trim() }),
    friendRequest: Object.assign({}, cfg.friendRequest, { autoAccept: el('fr-autoaccept').checked }),
    cooldownSeconds: Number(el('cooldown').value || 0),
    replyDelayMinMs: Number(el('delay-min').value || 0),
    replyDelayMaxMs: Number(el('delay-max').value || 0),
    groupRules: grules
  });
  delete next.groupRulesText;
  return next;
}
function collectGroupRules(){
  var result = {};
  [].slice.call(document.querySelectorAll('#grp-list .grp')).forEach(function(card){
    var gid = (card.getAttribute('data-gid') || '').trim();
    if (!/^\d+$/.test(gid)) throw new Error('群号必须为数字: ' + gid);
    if (Object.prototype.hasOwnProperty.call(result, gid)) throw new Error('群号重复: ' + gid);
    var keywords = [];
    [].slice.call(card.querySelectorAll('.gkw')).forEach(function(row){
      var m = row.querySelector('.gkw-match').value.trim();
      var t = row.querySelector('.gkw-type').value;
      var rep = row.querySelector('.gkw-reply').value.trim();
      var act = row.querySelector('.gkw-action').value;
      var img = row.querySelector('.gkw-img').value.trim();
      var ai = !!row.querySelector('.gkw-ai').checked;
      var pool = rep.split('|||').map(function(s){ return s.trim(); }).filter(Boolean);
      if (!m && !rep) return;
      if (!m) throw new Error('群 ' + gid + ' 的关键词不能为空');
      if (act !== 'ai' && !pool.length) throw new Error('群 ' + gid + ' 的回复不能为空（动作=直接问 AI 时可留空）');
      if (t === 'regex') {
        if (m.length > 300) throw new Error('群 ' + gid + ' 的正则过长（最多300字符）');
        try { new RegExp(m); } catch(e){ throw new Error('群 ' + gid + ' 正则无效: ' + m); }
      }
      var gRule = { match: m, matchType: t, reply: pool[0] || '', action: act };
      if (pool.length > 1) gRule.replies = pool;
      if (img) gRule.image = img;
      if (ai) gRule.aiFallback = true;
      keywords.push(gRule);
    });
    var rule = { enabled: card.querySelector('.grp-enabled').checked, atOnly: card.querySelector('.grp-atonly').checked, aiEnabled: !!card.querySelector('.grp-ai').checked };
    var wm = card.querySelector('.grp-welcome-mode').value;
    var wt = card.querySelector('.grp-welcome-tpl').value.trim();
    rule.welcome = { enabled: wm === 'on' ? true : (wm === 'off' ? false : null), template: wt || null };
    var fbPrivate = card.querySelector('.grp-fb-private').value.trim();
    var fbGroupAt = card.querySelector('.grp-fb-group').value.trim();
    rule.fallback = { privateText: fbPrivate || null, groupAtText: fbGroupAt || null };
    if (keywords.length) rule.keywords = keywords;
    result[gid] = rule;
  });
  return result;
}
async function save(){
  try {
    var payload = collect();
    var r = await fetch('/plugin/napcat-plugin-autoreply/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    var j = await r.json();
    if (j.code !== 0 && !j.ok) throw new Error(j.message || '保存失败');
    toast('已保存');
    await load();
  } catch(e){ toast(String(e.message || e), true); }
}
el('save').addEventListener('click', save);
document.addEventListener('click', function(e){
  if (e.target.classList.contains('kw-del')) { var row=e.target.closest('.kw'); var i=Number(row.getAttribute('data-i')); cfg.keywords.splice(i,1); renderKeywords(); }
  if (e.target.id === 'kw-add') { cfg.keywords = cfg.keywords || []; cfg.keywords.push({ match:'', matchType:'contains', reply:'' }); renderKeywords(); }
  if (e.target.id === 'grp-add') { el('grp-add-row').style.display = 'flex'; el('grp-new-id').focus(); }
  if (e.target.id === 'grp-add-confirm') addGroupRule();
  if (e.target.id === 'grp-add-cancel') { el('grp-new-id').value = ''; el('grp-add-row').style.display = 'none'; }
  if (e.target.classList.contains('grp-del')) { var gc=e.target.closest('.grp'); var gid=gc.getAttribute('data-gid'); gc.remove(); refreshGrpEmpty(); toast('已删除群 ' + gid + ' 规则，保存后生效'); }
  if (e.target.classList.contains('grp-kw-add')) { var card=e.target.closest('.grp'); var empty=card.querySelector('.grp-kw-empty'); if (empty) empty.remove(); card.querySelector('.gkw-list').insertAdjacentHTML('beforeend', groupKwRowHtml({})); }
  if (e.target.classList.contains('gkw-del')) { var kwRow=e.target.closest('.gkw'); var gcard=e.target.closest('.grp'); kwRow.remove(); if (!gcard.querySelector('.gkw')) gcard.querySelector('.gkw-list').insertAdjacentHTML('beforeend', '<p class="muted grp-kw-empty">本群暂无专属关键词，沿用全局关键词。</p>'); }
});
el('grp-new-id').addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); addGroupRule(); } });
load();
</script></body></html>`;

function registerWebUI(ctx: NapCatPluginContext): void {
    const router = ctx.router;

    // 托管前端静态资源（构建产物在 webui/ 目录下）
    // 访问路径: /plugin/<plugin-id>/files/static/
    router.static('/static', 'webui');

    // 注册仪表盘页面（显示在 NapCat WebUI 侧边栏）
    // 访问路径: /plugin/<plugin-id>/page/dashboard
    try {
        fs.writeFileSync(path.join(ctx.pluginPath, 'settings.html'), SETTINGS_PAGE_HTML);
        router.page({
            path: 'settings',
            title: '自动回复配置',
            htmlFile: 'settings.html',
            description: '本账号私聊/群聊/关键词规则配置页',
        });
    } catch (e) {
        ctx.logger.warn('注册自动回复配置页失败:', e);
    }

    router.page({
        path: 'dashboard',
        title: '插件仪表盘',
        htmlFile: 'webui/index.html',
        description: '插件管理控制台',
    });

    ctx.logger.debug('WebUI 路由注册完成');
}

// ==================== 纯逻辑导出（仅 test/escalation.mjs 使用） ====================
// 不参与插件生命周期；NapCat 只读取上面约定的钩子。
export { isBlocked, syncBlocklist, startBlocklistSync, stopBlocklistSync } from './core/blocklist';
export { pickReply, planReply, resolveSend } from './core/escalation';
export { isGroupConfigured, resolveGroupPolicy, resolveGroupFallback, buildGroupPolicies } from './core/policy';
export { appendHandoffRecord } from './core/handoff';
export { classifySendError, sendWithRetry, MIN_RETRY_DELAY_MS } from './core/send-retry';
export { SendGuard } from './core/send-guard';
export { LoopGuard } from './core/loop-guard';
export { matchGuardWord, runGroupGuard, guardTargetsGroup } from './core/content-guard';
export { rememberSentMessage, isSentByThisInstance, clearSentMessages } from './core/sent-messages';
export { beginCollect, clearCollect, collectKey, getCollect, stepCollect, COLLECT_TIMEOUT_MS } from './core/collect';
export { keywordsToText, textToKeywords } from './config';
export { resolveWelcome } from './handlers/event-handler';
export { handleMessage, resolveImageSource, sendRelayMessage, clearPrivateMerge } from './handlers/message-handler';
export { registerApiRoutes } from './services/api-service';
export { notifyHandoff } from './services/kb-client';
export { sanitizeConfig, pluginState } from './core/state';
