/**
 * 插件配置 — 默认值 + WebUI Schema
 */

import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { GroupRule, KeywordRule, PluginConfig } from './types';


/** 规则数组 → 多行文本(每行: 匹配词|类型|回复|图片(可选)|ai(可选)|动作(可选))；多回复池只在扩展配置页维护 */
export function keywordsToText(kw: KeywordRule[]): string {
    return kw.map((k) => {
        const action = k.action && k.action !== 'reply' ? k.action : '';
        // 图片/AI 标记/动作缺省时必须保留空段，避免解析错位
        const extra: string[] = [];
        if (k.image) extra.push(k.image);
        else if (k.aiFallback || action) extra.push('');
        if (k.aiFallback) extra.push('ai');
        else if (action) extra.push('');
        if (action) extra.push(action);
        return `${k.match}|${k.matchType || 'contains'}|${k.reply}${extra.length ? '|' + extra.join('|') : ''}`;
    }).join('\n');
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
            // 第4段为可选图片(URL/base64:///路径)，第5段为可选 AI 升级标记，第6段为可选动作
            const reply = (parts[2] || '').trim();
            const image = (parts[3] || '').trim();
            const aiFlag = (parts[4] || '').trim().toLowerCase();
            const rawAction = (parts[5] || '').trim().toLowerCase();
            const action = rawAction === 'ai' ? 'ai' : rawAction === 'human' ? 'human' : 'reply';
            if (!match || (!reply && !image && action !== 'ai')) return null;
            const rule: KeywordRule = { match, matchType: type, reply, action };
            if (image) rule.image = image;
            if (aiFlag === 'ai' || aiFlag === '1' || aiFlag === 'true') rule.aiFallback = true;
            return rule;
        })
        .filter((k): k is KeywordRule => k !== null);
}

/** 群级规则 → JSON 文本(供配置表单编辑) */
export function groupRulesToText(rules: Record<string, GroupRule> | undefined): string {
    return JSON.stringify(rules ?? {}, null, 2);
}

/** JSON 文本 → 群级规则;解析失败或顶层非对象返回 null,表示忽略本次文本 */
export function textToGroupRules(text: string | undefined): Record<string, GroupRule> | null {
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, GroupRule>;
    } catch {
        return null;
    }
}

export const DEFAULT_CONFIG: PluginConfig = {
    enabled: true,
    debug: false,
    cooldownSeconds: 30,
    replyDelayMinMs: 300,
    replyDelayMaxMs: 1200,
    atOnly: false,
    atReply: false,
    groupWelcome: { enabled: false, template: "欢迎 {user_id} 加入本群！" },
    friendRequest: { autoAccept: false },
    fallback: {
        privateText: "这个问题我拿不准，已经转给人工客服了，稍后回复你～",
        groupAtText: "这个问题我帮你转人工，稍后回复～",
    },
    collect: { enabled: false, questions: [] },
    relay: { token: "" },
    sendGuard: { failThreshold: 3, privateFailThreshold: 5, cooldownSeconds: 600 },
    ignoreSenders: [],
    loopGuard: { maxReplies: 5, windowSeconds: 60, pauseSeconds: 300 },
    guard: {
        enabled: false,
        groupIds: [],
        words: [],
        action: "recall",
        warnText: "请文明发言，违规内容将被撤回。",
    },
    groupConfigs: {},
    groupRules: {},
    keywords: [
        { match: "有", matchType: "prefix", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
        { match: "下载", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
        { match: "没找到", reply: "群里没有找到吗，先直接去https://apks.cc搜索下载下，这个是群里小伙伴给我的，下载后使用uu安装更新都行" },
    ],
    private: { enabled: false, defaultReply: "【自动回复】我现在不在，稍后回复你。", whitelist: [], mergeWindowMs: 3000 },
    group: { enabled: true, whitelist: [] },
    blacklist: [],
    crossAccountDedup: true,
    kbService: {
        enabled: false,
        baseUrl: "https://qqbot.theworld.codes",
        token: "",
        timeoutMs: 8000,
    },
    aiTrigger: { private: true, groupAtOnly: true },
    blocklist: { users: [], syncSeconds: 300, lastSyncedAt: "" },
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

/** 多行文本 → 词条数组(每行一个,不把 # 当注释,保留词里的 # 号) */
export function textToLines(text: string | undefined): string[] {
    if (!text) return [];
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
}

export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
    return ctx.NapCatConfig.combine(
        ctx.NapCatConfig.html('<div style="padding:16px;background:linear-gradient(135deg,#667eea,#764ba2);border-radius:12px;margin-bottom:20px;color:white;"><h3 style="margin:0 0 6px 0;font-size:18px;font-weight:600;">QQ 自动回复</h3><p style="margin:0;font-size:13px;opacity:0.85;">关键词触发 · 私聊/群聊 · 规则热重载</p></div>'),
        ctx.NapCatConfig.boolean('enabled', '启用自动回复', true, '总开关'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">私聊设置</div>'),
        ctx.NapCatConfig.boolean('private.enabled', '私聊自动回复', false, '开启后私聊消息触发自动回复'),
        ctx.NapCatConfig.number('private.mergeWindowMs', '私聊连发合并窗口(毫秒)', 3000, '同一私聊用户在窗口内连发的消息合并成一次问答（换行拼接，最多 5 条）；0 = 关闭'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">关键词规则</div>'),
        ctx.NapCatConfig.text('keywordsText', '关键词规则列表', keywordsToText(DEFAULT_CONFIG.keywords), '每行一条:匹配词|类型|回复|图片URL或路径(第4段可选)|ai(第5段可选)|动作(第6段可选:reply/ai/human)。类型 prefix/contains/regex。多回复池请在扩展配置页用 ||| 分隔编辑。图片只支持 jpg/png/webp/gif，建议 CDN 直链，小图可用 base64://'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">群聊设置</div>'),
        ctx.NapCatConfig.boolean('group.enabled', '群聊自动回复', true, '开启后群聊消息触发自动回复'),
        ctx.NapCatConfig.boolean('debug', '调试模式', false, '输出详细日志'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">防护设置</div>'),
        ctx.NapCatConfig.number('cooldownSeconds', '回复冷却(秒)', 30, '同一用户命中同一规则后的冷却秒数,冷却期内不再重复回复。0 = 关闭'),
        ctx.NapCatConfig.number('replyDelayMinMs', '回复延迟下限(毫秒)', 300, '回复前随机延迟下限,拟人化行为,降低风控风险'),
        ctx.NapCatConfig.number('replyDelayMaxMs', '回复延迟上限(毫秒)', 1200, '回复前随机延迟上限,需大于等于下限'),
        ctx.NapCatConfig.boolean('atOnly', '群聊仅被 @ 时回复', false, '开启后群聊只有 @ 机器人的消息才会触发自动回复'),
        ctx.NapCatConfig.text('groupRulesText', '群级规则(JSON)', groupRulesToText(DEFAULT_CONFIG.groupRules), 'JSON 对象，键为群号；只有列在这里的群才会被处理，未列出的群一律静默。值 {enabled,atOnly,aiEnabled,welcome:{enabled,template},fallback:{privateText,groupAtText},keywords:[{match,matchType,reply,replies?,action?}]}。enabled=false 该群不回复；atOnly 覆盖全局；welcome/fallback 的字段为 null 或缺省时跟随全局；keywords 非空时替代全局关键词。action=reply(默认)回文案、ai=直接问服务、human=转人工。格式错误将被忽略'),
        ctx.NapCatConfig.html('<div style="margin:12px 0 4px;font-weight:600;font-size:14px;">机器人能力</div>'),
        ctx.NapCatConfig.boolean('atReply', '群聊回复时 @ 触发者', false, '开启后群聊自动回复会在消息前 @ 触发者；私聊不受影响'),
        ctx.NapCatConfig.boolean('groupWelcome.enabled', '入群欢迎', false, '新成员入群时发送欢迎语；独立于自动回复总开关'),
        ctx.NapCatConfig.text('groupWelcome.template', '入群欢迎模板', DEFAULT_CONFIG.groupWelcome?.template ?? '', '支持 {group_id} 和 {user_id} 占位符'),
        ctx.NapCatConfig.number('sendGuard.failThreshold', '群发送失败熔断阈值(次)', 3, '同一群连续发送失败达到该次数即进入冷却，期间不再尝试发送（默认 3）'),
        ctx.NapCatConfig.number('sendGuard.privateFailThreshold', '私聊发送失败熔断阈值(次)', 5, '同一用户私聊连续发送失败达到该次数即进入冷却（默认 5）'),
        ctx.NapCatConfig.number('sendGuard.cooldownSeconds', '熔断冷却(秒)', 600, '熔断后暂停发送的时长，到期自动恢复（默认 600）'),
        ctx.NapCatConfig.text('ignoreSendersText', '忽略的发送者', idListToText(DEFAULT_CONFIG.ignoreSenders), '每行一个 QQ 号,# 开头为注释。两个机器人同群时填彼此的号，命中直接丢弃（不记冷却、不回复）'),
        ctx.NapCatConfig.number('loopGuard.maxReplies', '对刷熔断阈值(条)', 5, '同一群在统计窗口内发出回复达到该条数即暂停该群（默认 5）'),
        ctx.NapCatConfig.number('loopGuard.windowSeconds', '对刷统计窗口(秒)', 60, '对刷熔断的统计窗口（默认 60）'),
        ctx.NapCatConfig.number('loopGuard.pauseSeconds', '对刷暂停时长(秒)', 300, '达到阈值后该群暂停发送的时长（默认 300）'),
        ctx.NapCatConfig.boolean('guard.enabled', '群内容守卫', false, '群消息命中屏蔽词时自动撤回；只处理群消息，不踢人、不禁言'),
        ctx.NapCatConfig.text('guard.groupIdsText', '守卫生效群号', idListToText(DEFAULT_CONFIG.guard.groupIds), '每行一个群号；留空 = 所有已启用自动回复的群'),
        ctx.NapCatConfig.text('guard.wordsText', '守卫屏蔽词', idListToText(DEFAULT_CONFIG.guard.words), '每行一个词，大小写不敏感；留空 = 不撤回任何消息'),
        ctx.NapCatConfig.text('guard.action', '守卫命中动作', DEFAULT_CONFIG.guard.action, 'recall(仅撤回) / warn(仅警告) / both(撤回并警告)'),
        ctx.NapCatConfig.text('guard.warnText', '守卫警告话术', DEFAULT_CONFIG.guard.warnText, 'action=warn/both 时发到群里的提示语'),
        ctx.NapCatConfig.text('fallback.privateText', '私聊兜底话术', DEFAULT_CONFIG.fallback.privateText, '私聊未命中关键词/FAQ 时必回这句；留空 = 不回'),
        ctx.NapCatConfig.text('fallback.groupAtText', '群内 @ 兜底话术', DEFAULT_CONFIG.fallback.groupAtText, '群内被 @ 但未命中关键词/FAQ 时必回这句；留空 = 不回'),
        ctx.NapCatConfig.boolean('collect.enabled', '转人工追问', false, '关键词动作=转人工时：关闭=直接回兜底；开启=按配置问题逐条追问，5 分钟未答按超时处理'),
        ctx.NapCatConfig.boolean('friendRequest.autoAccept', '自动通过好友申请', false, '高风险：开启后所有好友申请都会被自动同意，建议仅在小号使用'),
        ctx.NapCatConfig.text('private.whitelistText', '私聊白名单', idListToText(DEFAULT_CONFIG.private.whitelist), '每行一个 QQ 号,# 开头为注释。留空 = 对所有私聊生效;非空 = 仅名单内用户触发'),
        ctx.NapCatConfig.text('group.whitelistText', '群聊白名单(群号)', idListToText(DEFAULT_CONFIG.group.whitelist), '每行一个群号,# 开头为注释。留空 = 对所有群生效;非空 = 仅名单内群触发'),
        ctx.NapCatConfig.text('blacklistText', '黑名单', idListToText(DEFAULT_CONFIG.blacklist), '每行一个 QQ 号,# 开头为注释。名单内的用户不会触发任何自动回复'),
    );
}
