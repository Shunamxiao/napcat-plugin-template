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
 * 读接口按用途使用 NoAuth；写接口同样走 NoAuth —— 页面拿不到 NapCat 凭据（accessControlMode=none 时
 * WebUI 不登录、localStorage 里没有 token），走鉴权路由永远是 {"code":-1,"message":"Unauthorized"}。
 * 写接口统一加 fromSameOrigin 闸门（按 Sec-Fetch-Site 判同源）挡跨站 CSRF；能直连 6099 的人本来
 */

// 由 vite.config.ts 的 define 注入（<commit>-<构建时间>）；未注入时（如测试直跑源码）显示 dev
declare const __BUILD_ID__: string | undefined;
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

import type {
    NapCatPluginContext,
    PluginHttpRequest
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { applyConfigPatch, isTokenPlaceholder, maskConfig, pluginState, sanitizeConfig, TOKEN_MASK } from '../core/state';
import { startGuardWordsSync } from '../core/guard-words';
import { startGroupConfigSync, buildEffectiveGroupPolicies, getGroupConfigStatus, getServerGroup, getServerGroupConfigs, getServerGuardPolicy, resolveEffectiveGroupPolicy, resolveGroupWelcome, resolveGuardPolicy, applyServerGroupEntry, applyServerGuardPolicy } from '../core/group-config';
import { getBotConfigStatus } from '../core/server-config';
import { hitLog } from '../core/hit-log';
import { resetKeywordStats, snapshotKeywordStats } from '../core/keyword-stats';
import { fetchBotConfig, fetchTrafficDay, listServerBots, putBotConfig, type ServerBotSummary } from './kb-client';
import { MAX_SNAPSHOTS, createSnapshot, deleteSnapshot, listSnapshots, readSnapshot } from '../core/config-snapshots';
import { putServerGroup, putServerGuardPolicy, type GroupPatch } from './admin-client';
import { resolveImageSource, sendRelayMessage } from '../handlers/message-handler';
import type { GuardPenaltyPolicy, PluginConfig, ServerGroupConfig } from '../types';

/** 令牌比较：长度不同直接失败，等长走常量时间比较 */
function tokenMatches(provided: string, expected: string): boolean {
    if (!expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Host 是 IP 字面量或 localhost（含端口）。DNS rebinding 必须借攻击者域名，域名进不了这条。 */
const IP_OR_LOCALHOST = /^(localhost|\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/i;

/**
 * 写接口同源闸门：无 Origin（脚本 / curl）放行，浏览器请求要求同源。
 *
 * 不拿「Origin 主机 === Host」当主判据：反代改写 Host、端口差异、浏览器缓存旧页面都会误伤，
 * 而 DNS rebinding 下两者同为攻击者域名，这个比较本来也拦不住。
 * 改看 Sec-Fetch-Site（浏览器强制设置，页面脚本改不了）：明确 cross-site/same-site 一律拒绝；
 * 标 same-origin 时再要求 Host 是 IP 字面量或 localhost——rebinding 只能借域名，走不通。
 * 闸门在服务端，规则改完即生效，浏览器缓存的旧页面也能保存。
 */
export function fromSameOrigin(req: PluginHttpRequest): boolean {
    const { origin, host, 'sec-fetch-site': fetchSite } = req.headers ?? {};
    if (typeof origin !== 'string' || origin === '') return true;
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false;
    const hostHeader = (Array.isArray(host) ? host[0] : host) ?? '';
    if (fetchSite === 'same-origin') return IP_OR_LOCALHOST.test(hostHeader);
    try {
        return new URL(origin).host === hostHeader;
    } catch {
        return false;
    }
}

/** 清洗服务端配置，但保留其令牌占位符供读写往返。 */
function sanitizeServerConfig(raw: unknown): PluginConfig {
    const config = sanitizeConfig(raw);
    if (isObject(raw) && isObject(raw.kbService) && raw.kbService.token === TOKEN_MASK) {
        config.kbService.token = TOKEN_MASK;
    }
    return config;
}

/** 账号管理插件（同进程）的实例条目；字段名与契约 §2.5 一致 */
interface PeerInfo {
    uin: string;
    name: string;
    webuiPort: number | null;
    running: boolean;
    isLogin: boolean;
}

/**
 * 实例真实 WebUI 端口（契约 §2.5 端口解析）：读 configPath 上两级的 webui.json 的 port
 * （configPath=<workdir>/config/plugins/<plugin>/config.json，webui.json 在 <workdir>/config/）。
 * 经 SSH 隧道访问时请求 Host 端口是隧道口而非实例口，转发拨号必须拨真实端口。
 * webui.json 缺文件/坏 JSON/无合法 port 时返回 null（不再回退 Host 头端口：
 * 那等于让外部请求决定本机拨哪个端口，还会把 accountAccessKey 送到那个端口上）。
 */
function resolveWebuiPort(ctx: NapCatPluginContext, _req: PluginHttpRequest): number | null {
    try {
        const file = path.resolve(path.dirname(ctx.configPath), '..', '..', 'webui.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { port?: unknown };
        const port = Number(raw?.port);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch { /* 无 webui.json：不给端口，peers 走空列表 */ }
    return null;
}

/** 账号插件实例列表缓存（按端口）：/status 每 10 秒被页面轮询，回源别跟着打满 */
const peersCache = new Map<number, { at: number; peers: PeerInfo[] }>();

const PEERS_TIMEOUT_MS = 4000;
const PEERS_CACHE_MS = 10000;

/**
 * 账号插件 /instances 转发凭据：配置 accountAccessKey 优先，env QQBOT_ACCOUNT_ACCESS_KEY 兜底。
 * 只用于转发 URL 的 ?key=，绝不进任何 /api 出口与日志（契约 §2.5 总监补充）。
 */
function resolveAccountAccessKey(): string {
    const fromConfig = String(pluginState.config.accountAccessKey ?? '').trim();
    if (fromConfig) return fromConfig;
    return String(process.env.QQBOT_ACCOUNT_ACCESS_KEY ?? '').trim();
}

/**
 * 转发同进程账号管理插件的 /plugin/napcat-plugin-account/api/instances。
 * 只回源到本机回环地址的 WebUI 端口（从请求 Host 头解析），失败/超时一律空列表，绝不抛异常。
 * 账号插件校验 ?key=<accessKey>：配置了 accountAccessKey 才带上，未配置时裸转发（会得到空 peers）。
 */
async function fetchPeers(ctx: NapCatPluginContext, req: PluginHttpRequest): Promise<PeerInfo[]> {
    const port = resolveWebuiPort(ctx, req);
    if (!port || !Number.isInteger(port)) return [];
    const now = Date.now();
    const cached = peersCache.get(port);
    if (cached && now - cached.at < PEERS_CACHE_MS) return cached.peers;
    const peers: PeerInfo[] = [];
    try {
        // 只回源本机回环：主机是字面量，端口是校验过的整数，key 走 encodeURIComponent
        const key = resolveAccountAccessKey();
        const query = key ? `?key=${encodeURIComponent(key)}` : '';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PEERS_TIMEOUT_MS);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/plugin/napcat-plugin-account/api/instances${query}`, {
                signal: controller.signal,
            });
            if (res.ok) {
                const data = (await res.json()) as unknown;
                const list = Array.isArray(data)
                    ? data
                    : (isObject(data) && Array.isArray(data.data) ? data.data : []);
                for (const item of list) {
                    if (!isObject(item)) continue;
                    const uin = typeof item.uin === 'string' ? item.uin.trim()
                        : (typeof item.uin === 'number' ? String(item.uin) : '');
                    if (!uin) continue;
                    peers.push({
                        uin,
                        name: typeof item.name === 'string' ? item.name : '',
                        webuiPort: typeof item.webuiPort === 'number' ? item.webuiPort : null,
                        running: item.running === true,
                        isLogin: item.isLogin === true,
                    });
                }
            }
        } finally {
            clearTimeout(timer);
        }
        peersCache.set(port, { at: now, peers });
    } catch {
        // 账号插件不在/未就绪：按空列表处理，且不缓存失败结果（下次轮询重试）
    }
    return peers;
}

/**
 * 注册 API 路由
 */
export function registerApiRoutes(ctx: NapCatPluginContext): void {
    const router = ctx.router;

    // ==================== 插件信息（无鉴权）====================

    /** 获取插件状态（含身份/配置来源六字段，契约 §2.4） */
    router.getNoAuth('/status', async (req, res) => {
        const botStatus = getBotConfigStatus();
        // 昵称：get_login_info → 服务端 nickname → ""
        let nickname = '';
        try {
            const info = await ctx.actions.call(
                'get_login_info', {}, ctx.adapterName, ctx.pluginManager.config
            );
            if (typeof info?.nickname === 'string') nickname = info.nickname;
        } catch { /* OneBot 未就绪时走回退 */ }
        if (!nickname) nickname = botStatus.serverNickname;
        // 实例名：账号管理插件里按 uin 匹配的 name，匹配不到回退 ""
        const selfId = pluginState.selfId;
        const peers = await fetchPeers(ctx, req);
        const selfPeer = selfId ? peers.find((p) => p.uin === selfId) : undefined;
        res.json({
            code: 0,
            data: {
                pluginName: ctx.pluginName,
                uptime: pluginState.getUptime(),
                uptimeFormatted: pluginState.getUptimeFormatted(),
                config: maskConfig(pluginState.config),
                stats: pluginState.stats,
                selfId: selfId || null,
                nickname,
                instanceName: selfPeer?.name ?? '',
                webuiPort: resolveWebuiPort(ctx, req),
                configRevision: botStatus.revision,
                configSource: botStatus.source,
                // 部署校验用：与本地 git HEAD 对比即可判断设备上是否跑的最新构建
                build: BUILD_ID,
            },
        });
    });

    // ==================== 多账号 / 服务端 bot 配置 ====================

    /** 同进程账号管理插件实例列表；失败回 {peers:[]}（契约 §2.5） */
    router.getNoAuth('/peers', async (req, res) => {
        const peers = await fetchPeers(ctx, req);
        res.json({ code: 0, data: { peers } });
    });

    /** 服务端 bot 列表（只读）；未配置/失败回 {bots:[]}（契约 §2.7） */
    router.getNoAuth('/server-bots', async (_req, res) => {
        const cfg = pluginState.config.kbService;
        let bots: ServerBotSummary[] = [];
        if (cfg?.baseUrl && cfg.token) {
            try {
                bots = (await listServerBots(cfg)) ?? [];
            } catch (e) {
                ctx.logger.warn('[配置] 服务端 bot 列表读取失败:', e);
                bots = [];
            }
        }
        res.json({ code: 0, data: { bots } });
    });

    /** 读服务端整份配置（只读代理；先迁移旧字段再打码回显）；支持 ?uin= 编辑其他实例，缺省=selfId */
    router.getNoAuth('/server-config', async (req, res) => {
        const rawUin = req.query?.uin;
        const qUin = Array.isArray(rawUin) ? rawUin[0] : rawUin;
        const uin = String(qUin || pluginState.selfId || '').trim();
        if (!uin) {
            return res.status(502).json({ code: -1, error: '未获取到 selfId，无法读取服务端配置' });
        }
        const cfg = pluginState.config.kbService;
        if (!cfg?.baseUrl || !cfg.token) {
            return res.status(502).json({ code: -1, error: '未配置服务地址或令牌' });
        }
        const entry = await fetchBotConfig(cfg, uin);
        if (!entry) {
            return res.status(502).json({ code: -1, error: '服务端配置读取失败（未同步或服务不可达）' });
        }
        res.json({ code: 0, data: { config: maskConfig(sanitizeServerConfig(entry.config)), revision: entry.revision } });
    });

    /**
     * 保存配置（写代理；NoAuth + 同源闸门，页面没有 NapCat 凭据）。
     * body: {uin, config, expectedRevision?}；config 是页面补丁，与目标实例现有配置合并后整份 PUT。
     * 当前实例：PUT 成功后补丁同步落本地（保存并立即生效）；其他实例：只写服务端，不动本地。
     * 409 原样回给页面（含服务端当前 revision），不覆盖本地。
     */
    router.postNoAuth('/server-config', async (req, res) => {
        if (!fromSameOrigin(req)) return res.status(403).json({ code: -1, message: '跨站写入被拒绝' });
        const body = isObject(req.body) ? req.body : {};
        const uin = typeof body.uin === 'string' ? body.uin.trim() : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(uin)) {
            return res.status(400).json({ code: -1, message: 'uin 不合法' });
        }
        if (!isObject(body.config)) {
            return res.status(400).json({ code: -1, message: 'config 必须是对象' });
        }
        const cfg = pluginState.config.kbService;
        const isSelf = uin === pluginState.selfId;
        // 本实例的配置只落本地就够了：没配服务端的机器也必须能改配置，
        // 否则全新安装的 WebUI 所有保存都返回 503
        if (!cfg?.baseUrl || !cfg.token) {
            if (isSelf) {
                pluginState.updateConfig(body.config as Partial<PluginConfig>);
                return res.json({ code: 0, data: { revision: null, local: true } });
            }
            return res.status(503).json({ code: -1, message: '未配置服务地址或令牌' });
        }
        const expectedRevision = typeof body.expectedRevision === 'number'
            && Number.isInteger(body.expectedRevision) && body.expectedRevision > 0
            ? body.expectedRevision
            : undefined;
        const patch = body.config as Partial<PluginConfig>;
        try {
            let merged: PluginConfig;
            if (uin === pluginState.selfId) {
                merged = applyConfigPatch(pluginState.config, patch);
            } else {
                // 其他实例：以服务端该号现有配置为基底合并，绝不把本实例配置写过去
                const remote = await fetchBotConfig(cfg, uin);
                if (!remote) {
                    return res.status(404).json({ code: -1, message: '服务端尚无该号的配置记录，无法合并保存' });
                }
                const remoteConfig = sanitizeServerConfig(remote.config);
                merged = applyConfigPatch(remoteConfig, patch);
                if (remoteConfig.kbService.token === TOKEN_MASK && isTokenPlaceholder(patch.kbService?.token)) {
                    merged.kbService.token = TOKEN_MASK;
                }
            }
            // accountAccessKey 是宿主本地凭据（契约 §2.5：不进 /api 出口、不该进服务端库）：
            // 上行前换成掩码，远端同步时按「占位符 = 保留本地真值」处理，既不上传也不清空别处
            const upload: PluginConfig = merged.accountAccessKey
                ? { ...merged, accountAccessKey: TOKEN_MASK }
                : merged;
            const result = await putBotConfig(cfg, uin, upload, expectedRevision);
            if (!result.ok) {
                if (result.status === 409) {
                    ctx.logger.warn('[配置] 保存冲突 uin=' + uin + ' 服务端 revision=' + (result.revision ?? '?'));
                    return res.status(409).json({
                        code: 409,
                        message: '配置已被其他端修改，请刷新后重试',
                        data: { revision: result.revision ?? null },
                    });
                }
                const status = result.status >= 400 && result.status <= 599 ? result.status : 502;
                return res.status(status).json({ code: -1, message: result.error ?? '保存失败' });
            }
            if (uin === pluginState.selfId) {
                pluginState.updateConfig(patch);
            }
            ctx.logger.info('[配置] 已保存到服务端 uin=' + uin + ' revision=' + result.revision);
            res.json({ code: 0, data: { revision: result.revision } });
        } catch (err) {
            ctx.logger.error('[配置] 保存失败 uin=' + uin + ':', err);
            res.status(500).json({ code: -1, message: err instanceof Error ? err.message : String(err) });
        }
    });

    // ==================== 配置管理 =====================

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
        if (!fromSameOrigin(req)) return res.status(403).json({ code: -1, message: '跨站写入被拒绝' });
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

    // ==================== 关键词命中统计 =====================

    /** 命中统计：{"<match>|<matchType>": {count,lastAt}} */
    router.getNoAuth('/keyword-stats', (_req, res) => {
        res.json({ code: 0, data: snapshotKeywordStats() });
    });

    /** 重置命中统计：清内存并立即写空对象 */
    router.postNoAuth('/keyword-stats/reset', (req, res) => {
        if (!fromSameOrigin(req)) return res.status(403).json({ code: -1, message: '跨站写入被拒绝' });
        resetKeywordStats();
        res.json({ code: 0, message: 'ok' });
    });

    // ==================== 看板：近 N 天流量（读服务端聚合）====================

    /** 每页 7 天要发 7 个请求：60 秒内复用，避免多开页面把服务端打满 */
    const trafficCache = new Map<string, { at: number; row: unknown }>();
    const TRAFFIC_TTL_MS = 60_000;

    /**
     * GET /traffic?days=7
     * 服务端按 UTC 天聚合（/stats/traffic?day=），这里并发取 N 天拼成一条响应。
     * 服务未配置或不可用时不报错：对应天的 row 为 null，页面按空数据画。
     */
    router.getNoAuth('/traffic', async (req, res) => {
        const raw = Array.isArray(req.query?.days) ? req.query.days[0] : req.query?.days;
        const days = Math.max(1, Math.min(14, Number(raw) || 7));
        const cfg = pluginState.config.kbService;
        const now = Date.now();
        const jobs: Promise<{ day: string; row: unknown }>[] = [];
        for (let i = days - 1; i >= 0; i--) {
            const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
            const hit = trafficCache.get(day);
            if (hit && now - hit.at < TRAFFIC_TTL_MS) {
                jobs.push(Promise.resolve({ day, row: hit.row }));
                continue;
            }
            jobs.push(fetchTrafficDay(cfg, day).then((row) => {
                // 未配置服务时不缓存 null，配好之后下一次刷新就能拿到数据
                if (row) trafficCache.set(day, { at: Date.now(), row });
                return { day, row };
            }));
        }
        const items = await Promise.all(jobs);
        res.json({
            code: 0,
            data: { days, configured: !!(cfg?.baseUrl && cfg?.token), items },
        });
    });

    // ==================== 配置快照（本地文件，改坏了一键回滚）====================

    router.getNoAuth('/snapshots', (_req, res) => {
        res.json({ code: 0, data: { items: listSnapshots(ctx.configPath), max: MAX_SNAPSHOTS } });
    });

    router.postNoAuth('/snapshots', (req, res) => {
        if (!fromSameOrigin(req)) return res.status(403).json({ code: -1, message: '跨站写入被拒绝' });
        const body = (req.body ?? {}) as { action?: unknown; id?: unknown; note?: unknown };
        const action = typeof body.action === 'string' ? body.action : '';
        const id = typeof body.id === 'string' ? body.id : '';
        try {
            if (action === 'create') {
                const note = typeof body.note === 'string' ? body.note : '';
                const meta = createSnapshot(ctx.configPath, pluginState.config, note);
                return res.json({ code: 0, data: meta });
            }
            if (action === 'restore') {
                const snap = readSnapshot(ctx.configPath, id);
                if (!snap) return res.status(404).json({ code: -1, message: '快照不存在' });
                // 用完整替换而不是补丁合并：快照里为空的关键词/群规则也要按快照回滚
                pluginState.replaceConfig(sanitizeConfig(snap.config));
                startGuardWordsSync();
                startGroupConfigSync();
                return res.json({ code: 0, data: { id: snap.id, ts: snap.ts } });
            }
            if (action === 'delete') {
                const removed = deleteSnapshot(ctx.configPath, id);
                return res.json(removed ? { code: 0, message: 'ok' } : { code: -1, message: '快照不存在' });
            }
            return res.status(400).json({ code: -1, message: 'action 必须是 create/restore/delete' });
        } catch (err) {
            ctx.logger.error('快照操作失败:', err);
            return res.status(500).json({ code: -1, message: err instanceof Error ? err.message : String(err) });
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
        // 号码直接进 send_msg：形状不对一律拒绝，别把任意字符串送给协议层
        if (!/^\d{5,12}$/.test(userId) || (groupId && !/^\d{5,12}$/.test(groupId))) {
            return res.status(400).json({ ok: false, error: 'userId / groupId 必须是 5-12 位数字' });
        }
        if (text.length > 4000) {
            return res.status(400).json({ ok: false, error: 'text 超过 4000 字' });
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
            );
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
        if (!fromSameOrigin(req)) return res.status(403).json({ code: -1, message: '跨站写入被拒绝' });
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
        if (!fromSameOrigin(req)) return res.status(403).json({ code: -1, message: '跨站写入被拒绝' });
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
