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
import { buildGroupPolicies } from '../core/policy';
import { resolveImageSource, sendRelayMessage } from '../handlers/message-handler';

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
            data: { ...maskConfig(config), groupPolicies: buildGroupPolicies(config) },
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
            ctx.logger.info('配置已保存');
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('保存配置失败:', err);
            res.status(500).json({ code: -1, message: err instanceof Error ? err.message : String(err) });
        }
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

    // ==================== 群管理（无鉴权）====================

    /** 获取群列表（附带各群启用状态） */
    router.getNoAuth('/groups', async (_req, res) => {
        try {
            const groups = await ctx.actions.call(
                'get_group_list',
                {},
                ctx.adapterName,
                ctx.pluginManager.config
            ) as Array<{ group_id: number; group_name: string; member_count: number; max_member_count: number }>;

            const groupsWithConfig = (groups || []).map((group) => {
                const groupId = String(group.group_id);
                return {
                    group_id: group.group_id,
                    group_name: group.group_name,
                    member_count: group.member_count,
                    max_member_count: group.max_member_count,
                    enabled: pluginState.isGroupEnabled(groupId),
                };
            });

            res.json({ code: 0, data: groupsWithConfig });
        } catch (e) {
            ctx.logger.error('获取群列表失败:', e);
            res.status(500).json({ code: -1, message: String(e) });
        }
    });

    /** 更新单个群配置 */
    router.postNoAuth('/groups/:id/config', async (req, res) => {
        try {
            const groupId = req.params?.id;
            if (!groupId) {
                return res.status(400).json({ code: -1, message: '缺少群 ID' });
            }

            const body = req.body as Record<string, unknown> | undefined;
            const enabled = body?.enabled;
            pluginState.updateGroupConfig(groupId, { enabled: Boolean(enabled) });
            ctx.logger.info(`群 ${groupId} 配置已更新: enabled=${enabled}`);
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('更新群配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });

    /** 批量更新群配置 */
    router.postNoAuth('/groups/bulk-config', async (req, res) => {
        try {
            const body = req.body as Record<string, unknown> | undefined;
            const { enabled, groupIds } = body || {};

            if (typeof enabled !== 'boolean' || !Array.isArray(groupIds)) {
                return res.status(400).json({ code: -1, message: '参数错误' });
            }

            for (const groupId of groupIds) {
                pluginState.updateGroupConfig(String(groupId), { enabled });
            }

            ctx.logger.info(`批量更新群配置完成 | 数量: ${groupIds.length}, enabled=${enabled}`);
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('批量更新群配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });

    // TODO: 在这里添加你的自定义 API 路由

    ctx.logger.debug('API 路由注册完成');
}
