/**
 * API 服务模块
 * 注册 WebUI API 路由
 *
 * 路由类型说明：
 * ┌─────────────────┬──────────────────────────────────────────────┬─────────────────┐
 * │ 类型            │ 路径前缀                                      │ 注册方法        │
 * ├─────────────────┼──────────────────────────────────────────────┼─────────────────┤
 * │ 需要鉴权 API    │ /api/Plugin/ext/<plugin-id>/                 │ router.get/post │
 * │ 无需鉴权 API    │ /plugin/<plugin-id>/api/                     │ router.getNoAuth│
 * │ 静态文件        │ /plugin/<plugin-id>/files/<urlPath>/         │ router.static   │
 * │ 内存文件        │ /plugin/<plugin-id>/mem/<urlPath>/           │ router.staticOnMem│
 * │ 页面            │ /plugin/<plugin-id>/page/<path>             │ router.page     │
 * └─────────────────┴──────────────────────────────────────────────┴─────────────────┘
 *
 * 一般插件自带的 WebUI 页面使用 NoAuth 路由，因为页面本身已在 NapCat WebUI 内嵌展示。
 */

import type {
    NapCatPluginContext,
    PluginHttpRequest,
    PluginHttpResponse
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { timingSafeEqual } from 'crypto';
import { maskConfig, pluginState } from '../core/state';
import { startGuardWordsSync } from '../core/guard-words';
import { startGroupConfigSync, buildEffectiveGroupPolicies, getGroupConfigStatus, getServerGroup, getServerGroupConfigs, getServerGuardPolicy, resolveEffectiveGroupPolicy, resolveGroupWelcome, resolveGuardPolicy, applyServerGroupEntry, applyServerGuardPolicy } from '../core/group-config';
import { hitLog } from '../core/hit-log';
import { resetKeywordStats, snapshotKeywordStats } from '../core/keyword-stats';
import { putServerGroup, putServerGuardPolicy, type GroupPatch } from './admin-client';
import { resolveImageSource, sendRelayMessage } from '../handlers/message-handler';
import type { GuardPenaltyPolicy, ServerGroupConfig } from '../types';

/** 令牌比较：长度不同直接失败，等长走常量时间比较 */
function tokenMatches(provided: string, expected: string): boolean {
    if (!expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 注册 API 路由
 */
export function registerApiRoutes(ctx: NapCatPluginContext): void {
    const router = ctx.router;

    // ==================== 插件信息（无鉴权）====================

    /** 获取插件状态 */
    router.getNoAuth('/status', (_req, res) => {
        res.json({
            code: 0,
            data: {
                pluginName: ctx.pluginName,
                uptime: pluginState.getUptime(),
                uptimeFormatted: pluginState.getUptimeFormatted(),
                config: maskConfig(pluginState.config),
                stats: pluginState.stats,
            },
        });
    });

    // ==================== 配置管理（无鉴权）====================

    /** 获取配置（令牌打码；真 token 绝不下发） */
    router.getNoAuth('/config', (_req, res) => {
        const config = pluginState.config;
        res.json({
            code: 0,
            data: { ...maskConfig(config), groupPolicies: buildEffectiveGroupPolicies(config) },
        });
    });

    /** 保存配置 */
    router.postNoAuth('/config', async (req, res) => {
        try {
            const body = req.body as Record<string, unknown> | undefined;
            if (!body) {
                return res.status(400).json({ code: -1, message: '请求体为空' });
            }
            pluginState.updateConfig(body as Partial<import('../types').PluginConfig>);
            // 刷新间隔/服务地址可能刚被改过：重启词表定时器并立即同步一次
            if (body.guard !== undefined || body.kbService !== undefined) startGuardWordsSync();
            if (body.kbService !== undefined || body.groupConfigRefreshMs !== undefined) startGroupConfigSync();
            ctx.logger.info('配置已保存');
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('保存配置失败:', err);
            res.status(500).json({ code: -1, message: err instanceof Error ? err.message : String(err) });
        }
    });

    // ==================== 关键词命中统计（无鉴权）====================

    /** 命中统计：{"<match>|<matchType>": {count,lastAt}} */
    router.getNoAuth('/keyword-stats', (_req, res) => {
        res.json({ code: 0, data: snapshotKeywordStats() });
    });

    /** 重置命中统计：清内存并立即写空对象 */
    router.postNoAuth('/keyword-stats/reset', (_req, res) => {
        resetKeywordStats();
        res.json({ code: 0, message: 'ok' });
    });

    // ==================== 反向下发（服务侧 Telegram 回流）====================

    /**
     * POST /relay
     * body: { userId, groupId?, text?, image? }（text 与 image 至少一个）
     * image 与规则图片同规则：http(s) 直链 jpg/jpeg/png/webp/gif、base64://、
     *   /root 下本地文件且 <=5MB；其它格式直接拒绝，避免发出用户看不到的破图。
     * header: x-relay-token（与配置 relay.token 一致；未配置 = 拒绝）
     * 成功 {ok:true,sent:true}；失败返回非 2xx + {ok:false,error}，服务侧按 HTTP 状态判定。
     */
    router.postNoAuth('/relay', async (req, res) => {
        const expected = pluginState.config.relay?.token ?? '';
        if (!expected) {
            return res.status(403).json({ ok: false, error: 'relay 未启用（relay.token 为空）' });
        }
        const rawHeader = req.headers?.['x-relay-token'];
        const provided = Array.isArray(rawHeader) ? rawHeader[0] ?? '' : rawHeader ?? '';
        if (!tokenMatches(String(provided), expected)) {
            return res.status(401).json({ ok: false, error: 'x-relay-token 无效' });
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const userId = body.userId != null ? String(body.userId).trim() : '';
        const groupId = body.groupId != null ? String(body.groupId).trim() : '';
        const text = typeof body.text === 'string' ? body.text : '';
        const image = typeof body.image === 'string' ? body.image.trim() : '';
        if (!userId || (!text.trim() && !image)) {
            return res.status(400).json({ ok: false, error: 'userId 与 (text 或 image) 不能为空' });
        }
        // 与规则图片共用校验：非法格式/不可用文件在此拒绝，不做"静默只发文字"降级
        const imageSrc = image ? resolveImageSource(image) : null;
        if (image && !imageSrc) {
            ctx.logger.warn('[relay] 图片不可用，已拒绝: ' + image.slice(0, 120));
            return res.status(400).json({
                ok: false,
                error: '图片不可用：仅支持 jpg/jpeg/png/webp/gif，http(s) 直链、base64:// 或 /root 下 ≤5MB 本地文件',
            });
        }
        try {
            await sendRelayMessage(
                ctx,
                { userId, groupId },
                { text: text.trim() ? text : '', image: imageSrc ?? undefined },
            );
            ctx.logger.info('[relay] 已下发 user=' + userId + (groupId ? ' group=' + groupId : '') + (imageSrc ? ' [图片]' : ''));
            res.json({ ok: true, sent: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.logger.error('[relay] 下发失败 user=' + userId + (groupId ? ' group=' + groupId : '') + ': ' + message);
            res.status(502).json({ ok: false, error: message });
        }
    });

    // ==================== 群规则 / 守卫策略 / 观测（无鉴权）====================

    /** 群条目：服务端配置优先，其次本地群规则，最后 groupDefault */
    function toGroupEntry(groupId: string, name: string) {
        const server = getServerGroup(groupId);
        const configured = pluginState.config.groupRules?.[groupId] !== undefined;
        const policy = resolveEffectiveGroupPolicy(pluginState.config, groupId);
        const welcome = resolveGroupWelcome(pluginState.config, groupId);
        const mode = policy.mode.value;
        const missPolicy = policy.missPolicy.value;
        return {
            groupId,
            name,
            mode,
            missPolicy,
            atForceReply: policy.atForceReply.value,
            keywordOutsideAt: policy.keywordOutsideAt.value,
            // 群级覆盖原样回显（null = 跟随全局），避免把全局值误存回服务端
            cooldownSeconds: server?.cooldownSeconds ?? null,
            fallbackText: server?.fallbackText ?? null,
            // 旧字段继续下发，老页面/其他调用方仍可用
            enabled: mode !== 'off',
            atOnly: mode === 'at',
            aiEnabled: missPolicy === 'ai_then_fallback',
            welcomeEnabled: welcome.enabled,
            // 服务端条目回显它自己的模板（空 = 跟随全局），避免把全局文案误存回服务端
            welcomeTemplate: server ? server.welcomeTemplate : (welcome.template || null),
            source: server ? 'server' : (configured ? 'local' : 'default'),
        };
    }

    const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const GROUP_MODES = new Set(['off', 'all', 'at']);
    const MISS_POLICIES = new Set(['ai_then_fallback', 'fallback_only', 'none']);
    const GROUP_BOOL_FIELDS = ['enabled', 'atOnly', 'aiEnabled', 'welcomeEnabled', 'atForceReply', 'keywordOutsideAt'] as const;
    const GROUP_FIELDS = new Set<string>([...GROUP_BOOL_FIELDS, 'welcomeTemplate', 'mode', 'missPolicy', 'cooldownSeconds', 'fallbackText']);
    const COOLDOWN_SECONDS_MIN = 0;
    const COOLDOWN_SECONDS_MAX = 3600;
    const MAX_FALLBACK_TEXT = 500;
    const GUARD_INT_LIMITS = {
        threshold: { min: 1, max: 20 },
        windowSeconds: { min: 60, max: 86400 },
        muteSeconds: { min: 60, max: 2592000 },
    } as const;
    const MAX_GUARD_TEXT = 200;
    const MAX_WELCOME_TEMPLATE = 500;

    /** 校验 POST /groups/:id 的 body：只收已知字段，类型不对即 400 */
    function parseGroupPatch(body: unknown): { ok: true; patch: GroupPatch } | { ok: false; error: string } {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '请求体必须是对象' };
        const raw = body as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (!GROUP_FIELDS.has(key)) return { ok: false, error: '未知字段：' + key };
        }
        const patch: GroupPatch = {};
        for (const key of GROUP_BOOL_FIELDS) {
            if (!(key in raw)) continue;
            if (typeof raw[key] !== 'boolean') return { ok: false, error: key + ' 必须是布尔值' };
            patch[key] = raw[key] as boolean;
        }
        if ('mode' in raw) {
            if (typeof raw.mode !== 'string' || !GROUP_MODES.has(raw.mode)) {
                return { ok: false, error: 'mode 必须是 off/all/at 之一' };
            }
            patch.mode = raw.mode as import('../types').GroupMode;
        }
        if ('missPolicy' in raw) {
            if (typeof raw.missPolicy !== 'string' || !MISS_POLICIES.has(raw.missPolicy)) {
                return { ok: false, error: 'missPolicy 必须是 ai_then_fallback/fallback_only/none 之一' };
            }
            patch.missPolicy = raw.missPolicy as import('../types').MissPolicy;
        }
        if ('cooldownSeconds' in raw) {
            const value = raw.cooldownSeconds;
            if (value === null) {
                patch.cooldownSeconds = null;
            } else if (typeof value !== 'number' || !Number.isInteger(value)) {
                return { ok: false, error: 'cooldownSeconds 必须是整数或 null' };
            } else if (value < COOLDOWN_SECONDS_MIN || value > COOLDOWN_SECONDS_MAX) {
                return { ok: false, error: 'cooldownSeconds 必须在 ' + COOLDOWN_SECONDS_MIN + '..' + COOLDOWN_SECONDS_MAX + ' 之间' };
            } else {
                patch.cooldownSeconds = value;
            }
        }
        if ('welcomeTemplate' in raw) {
            const value = raw.welcomeTemplate;
            if (value === null) {
                patch.welcomeTemplate = null;
            } else if (typeof value === 'string') {
                const template = value.trim();
                if ([...template].length > MAX_WELCOME_TEMPLATE) {
                    return { ok: false, error: '欢迎模板最多 ' + MAX_WELCOME_TEMPLATE + ' 字' };
                }
                patch.welcomeTemplate = template || null;
            } else {
                return { ok: false, error: 'welcomeTemplate 必须是字符串或 null' };
            }
        }
        if ('fallbackText' in raw) {
            const value = raw.fallbackText;
            if (value === null) {
                patch.fallbackText = null;
            } else if (typeof value === 'string') {
                const text = value.trim();
                if ([...text].length > MAX_FALLBACK_TEXT) {
                    return { ok: false, error: '兜底文案最多 ' + MAX_FALLBACK_TEXT + ' 字' };
                }
                patch.fallbackText = text || null;
            } else {
                return { ok: false, error: 'fallbackText 必须是字符串或 null' };
            }
        }
        if (Object.keys(patch).length === 0) return { ok: false, error: '至少提交一个字段' };
        return { ok: true, patch };
    }

    /** 校验 POST /guard-policy 的 body：与服务端同一套范围 */
    function parseGuardPolicy(body: unknown): { ok: true; policy: GuardPenaltyPolicy } | { ok: false; error: string } {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '请求体必须是对象' };
        const raw = body as Record<string, unknown>;
        const allowed = new Set(['windowSeconds', 'threshold', 'muteSeconds', 'warnText', 'muteText', 'source']);
        for (const key of Object.keys(raw)) {
            if (!allowed.has(key)) return { ok: false, error: '未知字段：' + key };
        }
        const policy = {} as GuardPenaltyPolicy;
        for (const key of ['threshold', 'windowSeconds', 'muteSeconds'] as const) {
            const { min, max } = GUARD_INT_LIMITS[key];
            const value = raw[key];
            if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: key + ' 必须是整数' };
            if (value < min || value > max) return { ok: false, error: key + ' 必须在 ' + min + '..' + max + ' 之间' };
            policy[key] = value;
        }
        for (const key of ['warnText', 'muteText'] as const) {
            const value = raw[key];
            if (typeof value !== 'string') return { ok: false, error: key + ' 必须是字符串' };
            if ([...value].length > MAX_GUARD_TEXT) return { ok: false, error: key + ' 最多 ' + MAX_GUARD_TEXT + ' 字' };
            policy[key] = value;
        }
        return { ok: true, policy };
    }

    /** 群列表：OneBot 群名 + 服务端条目 + 本地规则，合并成管理页数据 */
    router.getNoAuth('/groups', async (_req, res) => {
        const groups = new Map<string, string>();
        try {
            const list = await ctx.actions.call(
                'get_group_list',
                {},
                ctx.adapterName,
                ctx.pluginManager.config,
            ) as Array<{ group_id: number | string; group_name?: string }>;
            for (const group of list ?? []) {
                groups.set(String(group.group_id), String(group.group_name ?? ''));
            }
        } catch (e) {
            // OneBot 未就绪时仍返回服务端/本地条目，页面不至于整页失败
            ctx.logger.warn('获取群列表失败（仅返回已配置群）:', e);
        }
        for (const entry of getServerGroupConfigs()) {
            if (!groups.has(entry.groupId)) groups.set(entry.groupId, '');
        }
        for (const groupId of Object.keys(pluginState.config.groupRules ?? {})) {
            if (!groups.has(groupId)) groups.set(groupId, '');
        }
        const entries = Array.from(groups.entries()).map(([groupId, name]) => toGroupEntry(groupId, name));
        res.json({
            code: 0,
            data: {
                groups: entries,
                // 页面里「留空 = 跟随全局」要展示当前全局值
                global: {
                    cooldownSeconds: pluginState.config.cooldownSeconds ?? 0,
                    // 全局区只显示全局兜底；groupDefault.fallbackText 只在「群默认」卡片展示
                    fallbackText: pluginState.config.fallback?.groupAtText ?? '',
                    // 未配置群默认策略：页面「群默认」卡片回显用
                    groupDefault: pluginState.config.groupDefault ?? null,
                },
            },
        });
    });

    /** 写单个群的服务端配置：PUT /admin/groups/:groupId（Basic 凭据来自环境） */
    router.postNoAuth('/groups/:id', async (req, res) => {
        const groupId = String(req.params?.id ?? '').trim();
        if (!GROUP_ID_RE.test(groupId)) {
            return res.status(400).json({ code: -1, message: '群号不合法' });
        }
        const parsed = parseGroupPatch(req.body);
        if (!parsed.ok) {
            return res.status(400).json({ code: -1, message: parsed.error });
        }
        const baseUrl = pluginState.config.kbService.baseUrl;
        const result = await putServerGroup(baseUrl, groupId, parsed.patch);
        if (!result.ok) {
            ctx.logger.warn('[群配置] 写入失败 group=' + groupId + ' status=' + result.status + ' error=' + result.error);
            const status = result.status >= 400 && result.status <= 599 ? result.status : 502;
            return res.status(status).json({ code: -1, message: result.error });
        }
        const entry = result.data as ServerGroupConfig;
        if (!entry || !entry.groupId) {
            return res.status(502).json({ code: -1, message: '服务端返回的群条目不可用' });
        }
        applyServerGroupEntry(entry);
        ctx.logger.info('[群配置] 已写入 group=' + groupId);
        res.json({ code: 0, data: toGroupEntry(entry.groupId, '') });
    });

    /** 守卫处罚策略：读缓存（服务端优先，未同步时本地兜底） */
    router.getNoAuth('/guard-policy', (_req, res) => {
        const serverPolicy = getServerGuardPolicy();
        const policy = serverPolicy ?? resolveGuardPolicy(pluginState.config.guard);
        res.json({ code: 0, data: { ...policy, source: serverPolicy ? 'server' : 'default' } });
    });

    /** 守卫处罚策略：写服务端 PUT /admin/guard-policy */
    router.postNoAuth('/guard-policy', async (req, res) => {
        const parsed = parseGuardPolicy(req.body);
        if (!parsed.ok) {
            return res.status(400).json({ code: -1, message: parsed.error });
        }
        const baseUrl = pluginState.config.kbService.baseUrl;
        const result = await putServerGuardPolicy(baseUrl, parsed.policy);
        if (!result.ok) {
            ctx.logger.warn('[守卫策略] 写入失败 status=' + result.status + ' error=' + result.error);
            const status = result.status >= 400 && result.status <= 599 ? result.status : 502;
            return res.status(status).json({ code: -1, message: result.error });
        }
        const saved = result.data && typeof result.data === 'object' ? result.data : parsed.policy;
        applyServerGuardPolicy(saved);
        ctx.logger.info('[守卫策略] 已写入服务端');
        res.json({ code: 0, data: { ...saved, source: 'server' } });
    });

    /** 命中日志：最近 N 条（默认 50，上限 200） */
    router.getNoAuth('/logs', (req, res) => {
        const rawLimit = Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit;
        const limit = Math.max(1, Math.min(200, Number(rawLimit) || 50));
        res.json({ code: 0, data: { entries: hitLog.list(limit), total: hitLog.size() } });
    });

    /** 服务与观测：连通性、最近同步时间、FAQ 计数 */
    router.getNoAuth('/observability', (_req, res) => {
        const cfg = pluginState.config.kbService;
        const status = getGroupConfigStatus();
        res.json({
            code: 0,
            data: {
                service: {
                    baseUrl: cfg?.baseUrl ?? '',
                    enabled: cfg?.enabled === true,
                    tokenConfigured: !!cfg?.token,
                    reachable: status.lastError === null && status.lastSyncAt !== null,
                    lastAttemptAt: status.lastAttemptAt,
                    lastSyncAt: status.lastSyncAt,
                    lastError: status.lastError,
                },
                sync: {
                    blocklistAt: pluginState.config.blocklist?.lastSyncedAt || null,
                    guardWordsAt: pluginState.guardWordsSyncedAt || null,
                    groupConfigAt: status.lastSyncAt,
                    groupConfigVersion: status.version,
                },
                faq: {
                    hit: pluginState.stats.faqHit ?? 0,
                    miss: pluginState.stats.faqMiss ?? 0,
                },
                groups: {
                    managed: status.groupCount,
                },
            },
        });
    });

    ctx.logger.debug('API 路由注册完成');
}
