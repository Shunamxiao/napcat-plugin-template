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

import { DEFAULT_CONFIG, buildConfigSchema, groupRulesToText, idListToText, keywordsToText, textToGroupRules, textToIdList, textToKeywords } from './config';
import { pluginState } from './core/state';
import { handleMessage } from './handlers/message-handler';
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
    // TODO: 在这里处理通知、请求等非消息事件
    // 示例：
    // if (event.post_type === EventType.NOTICE) { ... }
    // if (event.post_type === EventType.REQUEST) { ... }
};

/**
 * 插件卸载/重载（可选）
 * 必须清理定时器、关闭连接等资源
 */
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        // TODO: 在这里清理你的资源（定时器、WebSocket 连接等）
        pluginState.cleanup();
        ctx.logger.info('插件已卸载');
    } catch (e) {
        ctx.logger.warn('插件卸载时出错:', e);
    }
};

// ==================== 配置管理钩子 ====================

/** 获取当前配置 */
export const plugin_get_config: PluginModule['plugin_get_config'] = async (ctx) => {
    const cfg = pluginState.config;
    return {
        ...cfg,
        keywordsText: keywordsToText(cfg.keywords),
        groupRulesText: groupRulesToText(cfg.groupRules),
        private: { ...cfg.private, whitelistText: idListToText(cfg.private.whitelist) },
        group: { ...cfg.group, whitelistText: idListToText(cfg.group.whitelist) },
        blacklistText: idListToText(cfg.blacklist),
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

    // 群级规则:合法 JSON 文本覆盖结构化规则;非法文本忽略,且不丢失已有规则
    const parsedGroupRules = textToGroupRules(cfg.groupRulesText);
    if (parsedGroupRules) {
        cfg.groupRules = parsedGroupRules;
    } else if (cfg.groupRules === undefined) {
        cfg.groupRules = pluginState.config.groupRules ?? {};
    }
    cfg.groupRulesText = groupRulesToText(cfg.groupRules);

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
input[type=text],input[type=number]{padding:7px 9px;border:1px solid #ddd;border-radius:8px;font-size:13px}
input.w-match{width:150px}input.w-reply{flex:1;min-width:220px}
select{padding:7px 6px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff}
textarea{width:100%;box-sizing:border-box;min-height:110px;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:13px;font-family:ui-monospace,monospace}
button{border:0;border-radius:8px;padding:7px 14px;cursor:pointer;background:#4f6ef7;color:#fff;font-size:13px}
button.gray{background:#8a8f9c}button.danger{background:#e5484d}
.kw{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed #eee}
.tag{font-size:12px;padding:2px 8px;border-radius:6px;background:#eef;color:#345}
.muted{color:#888;font-size:12px}
.toast{position:fixed;top:14px;right:14px;background:#222;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;z-index:99}
.toast.err{background:#c0392b}
</style></head><body>
<h1>QQ 自动回复配置</h1>
<div class="card"><h2>总开关</h2><label><input type="checkbox" id="enabled"> 启用自动回复</label><p class="muted">关闭后私聊与群聊都不再自动回复。</p></div>
<div class="card"><h2>私聊</h2><label><input type="checkbox" id="pv-enabled"> 私聊自动回复</label><div class="row"><label>兜底话术</label><input type="text" id="pv-default" class="w-reply" placeholder="未命中关键词时的回复，留空=不回复"></div></div>
<div class="card"><h2>关键词规则</h2><p class="muted">每行一条：匹配词 + 类型（包含/前缀/正则）+ 回复话术。正则示例：^有.+ 或 下载|安装。</p><div id="kw-list"></div><div class="row"><button class="gray" id="kw-add">+ 添加规则</button></div></div>
<div class="card"><h2>群聊</h2><div class="row"><label><input type="checkbox" id="gr-enabled"> 开启群消息自动回复</label><label><input type="checkbox" id="gr-atonly"> 仅被 @ 时回复</label></div><div class="row"><label>冷却（秒）</label><input type="number" id="cooldown" class="w-match" min="0"> <label>延迟(ms)</label><input type="number" id="delay-min" class="w-match" min="0"> ~ <input type="number" id="delay-max" class="w-match" min="0"></div><p class="muted">冷却：同一人触发同一规则的最短间隔；延迟：回复前随机等待，拟人防风控。</p></div>
<div class="card"><h2>群级规则（可选）</h2><p class="muted">JSON：键为群号，值 {enabled, atOnly, keywords}。示例：{"597649304":{"enabled":true,"atOnly":false,"keywords":[{"match":"下载","matchType":"contains","reply":"去 apks.cc 搜"}]}}</p><textarea id="grules" spellcheck="false"></textarea></div>
<div class="row"><button id="save">保存配置</button></div>
<script>
var cfg = null;
function toast(msg, err){ var d=document.createElement('div'); d.className='toast'+(err?' err':''); d.textContent=msg; document.body.appendChild(d); setTimeout(function(){ d.remove(); }, 3000); }
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function rowHtml(k, i){
  var type = k.matchType || 'contains';
  var sel = '<select class="kw-type"><option value="contains"' + (type==='prefix'||type==='regex'?'':' selected') + '>包含</option><option value="prefix"' + (type==='prefix'?' selected':'') + '>前缀</option><option value="regex"' + (type==='regex'?' selected':'') + '>正则</option></select>';
  return '<div class="kw" data-i="' + i + '"><input type="text" class="kw-match w-match" value="' + esc(k.match) + '" placeholder="匹配词/正则">' + sel + '<input type="text" class="kw-reply w-reply" value="' + esc(k.reply) + '" placeholder="回复话术"><button class="danger kw-del">删除</button></div>';
}
function renderKeywords(){
  var host = el('kw-list'); host.innerHTML = '';
  (cfg.keywords||[]).forEach(function(k,i){ host.insertAdjacentHTML('beforeend', rowHtml(k,i)); });
}
function render(){
  el('enabled').checked = !!cfg.enabled;
  el('pv-enabled').checked = !!(cfg.private && cfg.private.enabled);
  el('pv-default').value = (cfg.private && cfg.private.defaultReply) || '';
  el('gr-enabled').checked = !!(cfg.group && cfg.group.enabled);
  el('gr-atonly').checked = !!cfg.atOnly;
  el('cooldown').value = cfg.cooldownSeconds != null ? cfg.cooldownSeconds : 30;
  el('delay-min').value = cfg.replyDelayMinMs != null ? cfg.replyDelayMinMs : 300;
  el('delay-max').value = cfg.replyDelayMaxMs != null ? cfg.replyDelayMaxMs : 1200;
  el('grules').value = JSON.stringify(cfg.groupRules || {}, null, 2);
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
    if (!m || !rep) return;
    if (t === 'regex') { try { new RegExp(m); } catch(e){ throw new Error('正则无效: ' + m); } }
    keywords.push({ match: m, matchType: t, reply: rep });
  });
  if (!keywords.length) throw new Error('至少保留一条关键词规则');
  var grules = {};
  try { grules = JSON.parse(el('grules').value || '{}'); } catch(e){ throw new Error('群级规则 JSON 无效'); }
  var next = Object.assign({}, cfg, {
    enabled: el('enabled').checked,
    keywords: keywords,
    keywordsText: keywords.map(function(k){ return k.match + '|' + k.matchType + '|' + k.reply; }).join(String.fromCharCode(10)),
    private: Object.assign({}, cfg.private, { enabled: el('pv-enabled').checked, defaultReply: el('pv-default').value.trim() }),
    group: Object.assign({}, cfg.group, { enabled: el('gr-enabled').checked }),
    atOnly: el('gr-atonly').checked,
    cooldownSeconds: Number(el('cooldown').value || 0),
    replyDelayMinMs: Number(el('delay-min').value || 0),
    replyDelayMaxMs: Number(el('delay-max').value || 0),
    groupRules: grules
  });
  delete next.groupRulesText;
  return next;
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
});
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
