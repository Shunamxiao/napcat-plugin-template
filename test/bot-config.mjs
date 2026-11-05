/**
 * 服务端 bot 配置（bot_config）同步与保存代理自测（假 ctx + 假 fetch，不发真实请求）
 *
 * 覆盖（派发单验收第 4 条）：
 *   1) 服务端不可达 → 完全按本地配置跑（行为不变、configSource=local），只 warn 一条不轰炸
 *   2) 启动同步 → 应用服务端配置并回写本地缓存；掩码 token 换回本地真值
 *   3) revision 未变不重复应用；变了才应用
 *   4) 保存代理 409 → 提示「配置已被其他端修改，请刷新后重试」且不覆盖本地
 *   5) 保存代理成功 → 整份合并配置 PUT 服务端，当前实例补丁同步落本地
 *   6) /api/peers 转发鉴权（带 key 成功 / 无 key 空列表 / env 兜底 / key 不进出口）
 *      与 /api/status 六个新字段
 *   7) startServerConfigSync / stopServerConfigSync 生命周期无 ReferenceError
 *   8) 端口解析：webui.json 的 port 优先于 Host 头端口（SSH 隧道场景拨真实端口）
 *   9) 启动 import body 带本地 nickname；服务端昵称为空时补一次只改昵称的 PUT（expectedRevision 防覆盖）
 *   10) 本地昵称不可用：import 不带 nickname、不补 PUT
 *   11) init 拿到空昵称、同步阶段重取成功：补写触发
 *
 * 用法：先 pnpm build，再 node --test test/*.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    getBotConfigStatus,
    pluginState,
    registerApiRoutes,
    startServerConfigSync,
    stopServerConfigSync,
    syncBotConfig,
} from "../dist/index.mjs";

const SELF = "1457278554";
const TOKEN = "realsecret";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-bot-config-"));
// 真实布局：configPath 在 <workdir>/config/plugins/<plugin>/ 下，webui.json 在 <workdir>/config/（上两级）
fs.mkdirSync(path.join(dir, "config"), { recursive: true });
const configPath = path.join(dir, "config", "plugins", "napcat-plugin-autoreply", "config.json");
const baseConfig = {
    enabled: true,
    cooldownSeconds: 0,
    replyDelayMinMs: 0,
    replyDelayMaxMs: 0,
    atOnly: false,
    private: { enabled: true, whitelist: [], mergeWindowMs: 0 },
    group: { enabled: true, whitelist: [] },
    fallback: { privateText: "local-v1", groupAtText: "普通群兜底" },
    collect: { enabled: false, questions: [] },
    relay: { token: "" },
    kbService: { enabled: true, baseUrl: "https://svc.test", token: TOKEN, timeoutMs: 500 },
    aiTrigger: { private: true, groupAtOnly: true },
    guard: { enabled: false },
    keywords: [],
};
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(baseConfig));

const logs = [];
const ctx = {
    pluginName: "napcat-plugin-autoreply",
    pluginPath: dir,
    dataPath: path.join(dir, "data"),
    configPath,
    adapterName: "onebot11",
    logger: {
        info: (...args) => { logs.push(args.join(" ")); },
        debug: (...args) => { logs.push(args.join(" ")); },
        warn: (...args) => { logs.push(args.join(" ")); },
        error: (...args) => { logs.push(args.join(" ")); },
    },
    actions: {
        call: async (action) => {
            if (action === "get_login_info") return { user_id: SELF, nickname: "测试昵称" };
            return {};
        },
    },
    pluginManager: { config: { self_id: SELF } },
};

// 假路由器：捕获注册的处理器
const routes = new Map();
ctx.router = {
    get: (p, h) => routes.set("AUTH GET " + p, h),
    post: (p, h) => routes.set("AUTH POST " + p, h),
    getNoAuth: (p, h) => routes.set("GET " + p, h),
    postNoAuth: (p, h) => routes.set("POST " + p, h),
    static: () => {},
    staticOnMem: () => {},
    page: () => {},
};

const makeRes = () => ({
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
});
const call = async (key, req) => {
    const handler = routes.get(key);
    assert.ok(handler, "路由未注册：" + key);
    const res = makeRes();
    await handler({ query: {}, params: {}, headers: {}, body: null, ...req }, res, () => {});
    return res;
};

const originalFetch = globalThis.fetch;
const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status });

// 服务端 mock 状态：GET /config/bots/<SELF> 返回的记录
let serverRecord = null;
let putCalls = [];

globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.includes("/config/bots/" + SELF + "/import")) {
        if (!serverRecord) serverRecord = { uin: SELF, nickname: "", revision: 1, config: JSON.parse(init.body).config };
        return jsonRes({ revision: serverRecord.revision, imported: false });
    }
    if (u.includes("/config/bots/" + SELF) && method === "GET") {
        if (!serverRecord) return new Response("{}", { status: 404 });
        return jsonRes(serverRecord);
    }
    if (u.includes("/config/bots/" + SELF) && method === "PUT") {
        putCalls.push({ url: u, body: JSON.parse(init.body) });
        if (putConflictOnce) return jsonRes({ error: "revision conflict", revision: 7 }, 409);
        return jsonRes({ revision: 5 });
    }
    if (u.includes("/config/bots")) {
        if (method === "GET") {
            return jsonRes(serverRecord ? [serverRecord] : []);
        }
    }
    if (u.includes("/plugin/napcat-plugin-account/api/instances")) {
        if (!u.includes("127.0.0.1:6099/")) throw new TypeError("fetch failed（该端口无账号插件）");
        return jsonRes([
            { uin: Number(SELF), name: "acc-main", webuiPort: 6099, running: true, isLogin: true },
            { uin: 2622011721, name: "acc-second", webuiPort: 6103, running: false, isLogin: false },
        ]);
    }
    throw new TypeError("fetch failed（mock 未覆盖 " + method + " " + u + "）");
};

let putConflictOnce = false;

pluginState.init(ctx);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(pluginState.selfId, SELF, "前置：selfId 应已取得");
const cfg = () => pluginState.config;

// ---------- 1) 服务端不可达 → 本地配置 ----------
serverRecord = null;
putConflictOnce = false;
logs.length = 0;
await syncBotConfig(true);
assert.equal(getBotConfigStatus().source, "local", "不可达时 configSource 应为 local");
assert.equal(getBotConfigStatus().revision, 0, "不可达时 revision 应为 0");
assert.equal(cfg().fallback.privateText, "local-v1", "不可达时应保留本地配置");
assert.ok(getBotConfigStatus().lastError, "不可达时应记录 lastError");
await syncBotConfig(false);
assert.equal(
    logs.filter((l) => l.includes("[配置] 服务端同步失败，按本地配置继续")).length, 1,
    "不可达只应 warn 一条（不重试轰炸）",
);
assert.ok(logs.some((l) => l.includes("[配置] 服务端同步仍失败")), "第二次失败应降级为 debug");
console.log("ok 1 - 服务端不可达：按本地配置跑，只 warn 一条");

// ---------- 2) 启动同步：应用服务端配置 + 回写本地缓存 + 掩码 token 换真值 ----------
serverRecord = {
    uin: SELF,
    nickname: "主号",
    revision: 3,
    config: {
        ...baseConfig,
        cooldownSeconds: 12,
        fallback: { privateText: "server-v1", groupAtText: "普通群兜底" },
        kbService: { enabled: true, baseUrl: "https://svc.test", token: "••••••", timeoutMs: 500 },
    },
};
logs.length = 0;
await syncBotConfig(true);
assert.equal(cfg().fallback.privateText, "server-v1", "应应用服务端配置");
assert.equal(cfg().kbService.token, TOKEN, "掩码 token 应换回本地真值");
assert.equal(getBotConfigStatus().source, "server");
assert.equal(getBotConfigStatus().revision, 3);
assert.ok(logs.some((l) => l.includes("[配置] 从服务端同步 revision=3")), "应打同步日志");
const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
assert.equal(onDisk.fallback.privateText, "server-v1", "应回写本地缓存（落盘）");
assert.equal(getBotConfigStatus().serverNickname, "主号", "应记录服务端 nickname");
console.log("ok 2 - 启动同步应用服务端配置并回写本地缓存");

// 旧/部分服务端配置缺少 kbService 时，保留当前连接配置，但仍应用其他字段
const currentKbService = { ...cfg().kbService };
serverRecord = { ...serverRecord, config: { ...serverRecord.config, cooldownSeconds: 34 } };
delete serverRecord.config.kbService;
await syncBotConfig(true);
assert.equal(cfg().cooldownSeconds, 34, "缺少 kbService 时仍应应用服务端其他字段");
assert.deepEqual(cfg().kbService, currentKbService, "缺少 kbService 时应保留当前服务配置");
serverRecord.config.kbService = { ...baseConfig.kbService, token: "••••••" };
console.log("ok 2a - 服务端缺少 kbService 时保留当前服务配置");

// ---------- 3) revision 未变不重复应用；变了才应用 ----------
pluginState.updateConfig({ cooldownSeconds: 77 });
logs.length = 0;
await syncBotConfig(false);
assert.equal(cfg().cooldownSeconds, 77, "revision 未变不应覆盖本地编辑");
assert.ok(!logs.some((l) => l.includes("[配置] 从服务端同步")), "revision 未变不应打同步日志");

serverRecord = { ...serverRecord, revision: 4, config: { ...serverRecord.config, cooldownSeconds: 55 } };
await syncBotConfig(false);
assert.equal(cfg().cooldownSeconds, 55, "revision 变了应重新应用");
assert.equal(getBotConfigStatus().revision, 4);
console.log("ok 3 - revision 比对生效（变了才应用）");

// ---------- 路由前置：注册 API ----------
registerApiRoutes(ctx);
assert.equal(routes.has("AUTH POST /config"), true, "配置写路由应要求 NapCat 鉴权");
assert.equal(routes.has("AUTH POST /keyword-stats/reset"), true, "统计重置路由应要求 NapCat 鉴权");
assert.equal(routes.has("AUTH POST /groups/:id"), true, "群配置写路由应要求 NapCat 鉴权");
assert.equal(routes.has("AUTH POST /guard-policy"), true, "守卫策略写路由应要求 NapCat 鉴权");
for (const path of ["/config", "/keyword-stats/reset", "/groups/:id", "/guard-policy"]) {
    assert.equal(routes.has("POST " + path), false, path + " 不应注册为 NoAuth");
}
assert.equal(routes.has("POST /relay"), true, "relay 应继续使用 NoAuth 专用令牌路由");
console.log("ok 3a - 四类管理写路由要求 NapCat 鉴权，relay 保持专用路由");

// 服务端只读代理也要迁移旧私聊兜底，避免跨实例页面保存空值覆盖旧文案
const currentServerRecord = serverRecord;
serverRecord = {
    ...serverRecord,
    config: {
        ...baseConfig,
        accountAccessKey: "account-secret",
        private: { ...baseConfig.private, defaultReply: "legacy-peer" },
        fallback: { groupAtText: "群兜底" },
        kbService: { ...baseConfig.kbService, token: "••••••" },
        relay: { token: "relay-secret" },
    },
};
let legacyView = await call("GET /server-config", { query: { uin: SELF } });
assert.equal(legacyView.body.data.config.fallback.privateText, "legacy-peer", "缺少新字段时应迁移旧字段");
assert.equal("defaultReply" in legacyView.body.data.config.private, false);
assert.equal(legacyView.body.data.config.kbService.token, "••••••", "服务令牌必须打码");
assert.equal(legacyView.body.data.config.accountAccessKey, "••••••", "账号插件令牌必须打码");
assert.equal(legacyView.body.data.config.relay.token, "••••••", "回流令牌必须打码");
serverRecord.config.kbService.token = "unique-service-secret";
const realTokenView = await call("GET /server-config", { query: { uin: SELF } });
assert.equal(realTokenView.body.data.config.kbService.token, "••••••", "真实服务令牌必须打码");
assert.ok(!JSON.stringify(realTokenView.body).includes("unique-service-secret"), "响应不得包含真实服务令牌");
serverRecord.config.kbService.token = "••••••";
serverRecord.config.fallback.privateText = "current-peer";
legacyView = await call("GET /server-config", { query: { uin: SELF } });
assert.equal(legacyView.body.data.config.fallback.privateText, "current-peer", "新字段应优先于旧字段");
assert.equal(legacyView.body.data.config.kbService.token, "••••••", "读取后仍应保留服务端令牌占位符");
serverRecord = currentServerRecord;
console.log("ok 3b - 服务端只读代理迁移旧私聊兜底字段");

// ---------- 4) 保存代理 409：提示且不覆盖本地 ----------
putConflictOnce = true;
let res = await call("AUTH POST /server-config", {
    body: { uin: SELF, config: { cooldownSeconds: 99 }, expectedRevision: 4 },
});
assert.equal(res.statusCode, 409, "409 应原样回给页面");
assert.equal(res.body.message, "配置已被其他端修改，请刷新后重试", "409 文案应符合契约");
assert.equal(res.body.data.revision, 7, "409 应带服务端当前 revision");
assert.equal(cfg().cooldownSeconds, 55, "409 时不应覆盖本地配置");
putConflictOnce = false;
putCalls = [];
console.log("ok 4 - 409 提示且不覆盖本地");

// ---------- 5) 保存代理成功：整份合并 PUT + 当前实例落本地 ----------
logs.length = 0;
res = await call("AUTH POST /server-config", {
    body: { uin: SELF, config: { cooldownSeconds: 99 }, expectedRevision: 4 },
});
assert.equal(res.statusCode, 200);
assert.equal(res.body.code, 0);
assert.equal(res.body.data.revision, 5);
assert.equal(cfg().cooldownSeconds, 99, "当前实例保存应立即生效");
assert.equal(putCalls.length, 1, "应恰好 PUT 一次服务端");
assert.equal(putCalls[0].body.config.fallback.privateText, "server-v1", "PUT 应是整份合并配置而非补丁");
assert.equal(putCalls[0].body.expectedRevision, 4, "PUT 应带 expectedRevision");
assert.ok(logs.some((l) => l.includes("[配置] 已保存到服务端 uin=" + SELF)), "应打保存日志");

// 其他实例：以服务端该号配置为基底合并，不动本地
putCalls = [];
serverRecord = {
    uin: "2622011721",
    nickname: "二号",
    revision: 2,
    config: {
        ...baseConfig,
        cooldownSeconds: 8,
        fallback: { privateText: "peer-v1", groupAtText: "x" },
        kbService: { ...baseConfig.kbService, token: "••••••" },
    },
};
globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.includes("/config/bots/2622011721") && method === "GET") return jsonRes(serverRecord);
    if (u.includes("/config/bots/2622011721") && method === "PUT") {
        putCalls.push({ url: u, body: JSON.parse(init.body) });
        return jsonRes({ revision: 3 });
    }
    throw new TypeError("fetch failed（" + method + " " + u + "）");
};
res = await call("AUTH POST /server-config", {
    body: { uin: "2622011721", config: { cooldownSeconds: 20 } },
});
assert.equal(res.statusCode, 200);
assert.equal(cfg().cooldownSeconds, 99, "保存其他实例不应动本地配置");
assert.equal(putCalls[0].body.config.cooldownSeconds, 20, "合并补丁应生效");
assert.equal(putCalls[0].body.config.fallback.privateText, "peer-v1", "应以该号服务端配置为基底");
assert.equal(putCalls[0].body.config.kbService.token, "••••••", "跨实例保存必须保留服务端令牌占位符");
assert.equal(putCalls[0].body.expectedRevision, undefined, "未带 expectedRevision 时应无条件写");
serverRecord = null;
console.log("ok 5 - 保存代理成功链路（当前实例生效 / 其他实例写服务端）");

// ---------- 6) /api/peers 转发鉴权（accountAccessKey）与 /api/status 六字段 ----------
// 账号插件 mock：校验 ?key=；expectedKey 是它当前认可的凭据，null = 认可任何 key（按裸转发处理）
const ACCOUNT_INSTANCES = [
    { uin: Number(SELF), name: "acc-main", webuiPort: 6099, running: true, isLogin: true },
];
let expectedKey = "k-123";
let lastInstancesUrl = "";
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/plugin/napcat-plugin-account/api/instances")) {
        lastInstancesUrl = u;
        // 只有 6091/6092/6093/6099 模拟装了账号插件，其他端口按"插件不在"处理
        if (!/127\.0\.0\.1:60(9[139]|92)\//.test(u)) throw new TypeError("fetch failed（该端口无账号插件）");
        if (expectedKey !== null && !u.includes("key=" + expectedKey)) {
            return jsonRes({ error: "key 无效" });
        }
        return jsonRes(ACCOUNT_INSTANCES);
    }
    throw new TypeError("fetch failed");
};

// 6a) 未配置 key（config 空 + env 空）：裸转发 → 账号插件拒绝 → {peers:[]}
delete process.env.QQBOT_ACCOUNT_ACCESS_KEY;
pluginState.updateConfig({ accountAccessKey: "" });
let peersRes = await call("GET /peers", { headers: { host: "127.0.0.1:6091" } });
assert.deepEqual(peersRes.body.data.peers, [], "无 key 裸调被拒应回 {peers:[]}");
assert.ok(!lastInstancesUrl.includes("key="), "未配置时不应带 key");
console.log("ok 6a - 无 key 转发得空列表");

// 6b) 配置 accountAccessKey → 转发 URL 带 ?key=，转发成功
pluginState.updateConfig({ accountAccessKey: "k-123" });
peersRes = await call("GET /peers", { headers: { host: "127.0.0.1:6092" } });
assert.equal(peersRes.body.data.peers.length, 1, "带 key 应转发成功");
assert.ok(lastInstancesUrl.includes("key=k-123"), "转发 URL 应带 ?key=k-123");
console.log("ok 6b - 带 key 转发成功");

// 6c) config 置空后 env QQBOT_ACCOUNT_ACCESS_KEY 兜底
pluginState.updateConfig({ accountAccessKey: "" });
process.env.QQBOT_ACCOUNT_ACCESS_KEY = "env-key-456";
expectedKey = "env-key-456";
peersRes = await call("GET /peers", { headers: { host: "127.0.0.1:6093" } });
assert.equal(peersRes.body.data.peers.length, 1, "env 兜底 key 应转发成功");
assert.ok(lastInstancesUrl.includes("key=env-key-456"), "env 兜底应拼进转发 URL");
delete process.env.QQBOT_ACCOUNT_ACCESS_KEY;
console.log("ok 6c - env QQBOT_ACCOUNT_ACCESS_KEY 兜底");

// 6d) 账号插件不在的端口 → {peers:[]}
const peersFail = await call("GET /peers", { headers: { host: "127.0.0.1:65535" } });
assert.deepEqual(peersFail.body.data.peers, [], "端口上没有账号插件应回 {peers:[]}");

// 6e) /api/status 六字段 + accountAccessKey 打码
pluginState.updateConfig({ accountAccessKey: "k-123" });
expectedKey = "k-123";
const statusRes = await call("GET /status", { headers: { host: "192.168.1.204:6099" } });
const statusData = statusRes.body.data;
assert.equal(statusData.selfId, SELF, "status.selfId");
assert.equal(statusData.nickname, "测试昵称", "status.nickname 应来自 get_login_info");
assert.equal(statusData.instanceName, "acc-main", "status.instanceName 应按 uin 匹配账号插件");
assert.equal(statusData.webuiPort, 6099, "status.webuiPort 应来自 Host 头");
assert.equal(statusData.configRevision, getBotConfigStatus().revision, "status.configRevision");
assert.ok(["server", "local"].includes(statusData.configSource), "status.configSource 取值");
assert.notEqual(statusData.config.accountAccessKey, "k-123", "accountAccessKey 不得出现在 /api 出口");

const configRes = await call("GET /config", {});
assert.notEqual(configRes.body.data.accountAccessKey, "k-123", "accountAccessKey 不得出现在 /api/config 出口");

const botsRes = await call("GET /server-bots", {});
assert.equal(botsRes.body.code, 0);
assert.deepEqual(botsRes.body.data.bots, [], "服务端未配置时 bots 应回空数组");
console.log("ok 6 - /api/peers 转发鉴权与 /api/status 六字段（含 key 打码）");

// ---------- 7) 生命周期守卫：start/stop 不抛 ReferenceError（防漏 import 再犯） ----------
assert.equal(typeof startServerConfigSync, "function");
assert.equal(typeof stopServerConfigSync, "function");
globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
logs.length = 0;
startServerConfigSync();
await new Promise((resolve) => setTimeout(resolve, 1200));
stopServerConfigSync();
assert.ok(
    logs.some((l) => l.includes("[配置] 服务端同步失败") || l.includes("[配置] 启动导入失败")),
    "startServerConfigSync 应完整走导入+首轮同步流程（fetch 失败仅记 warn 不抛）",
);
console.log("ok 7 - startServerConfigSync/stopServerConfigSync 生命周期无 ReferenceError");

// ---------- 8) 端口解析：webui.json 优先于 Host 头端口（SSH 隧道场景） ----------
fs.writeFileSync(path.join(dir, "config", "webui.json"), JSON.stringify({ port: 7777, token: "x" }));
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/plugin/napcat-plugin-account/api/instances")) {
        lastInstancesUrl = u;
        // 只认可拨到 7777（webui.json 端口）；拨 Host 隧道口 16099 视为插件不在
        if (!u.includes("127.0.0.1:7777/")) throw new TypeError("fetch failed（该端口无账号插件）");
        return jsonRes(ACCOUNT_INSTANCES);
    }
    throw new TypeError("fetch failed");
};
const peersTunnel = await call("GET /peers", { headers: { host: "127.0.0.1:16099" } });
assert.equal(peersTunnel.body.data.peers.length, 1, "隧道 Host 下转发应拨 webui.json 端口");
assert.ok(lastInstancesUrl.includes("127.0.0.1:7777/"), "拨号端口应取 webui.json 的 port 而非 Host 端口 16099");
const statusTunnel = await call("GET /status", { headers: { host: "192.168.1.204:16099" } });
assert.equal(statusTunnel.body.data.webuiPort, 7777, "status.webuiPort 应为 webui.json 端口");
assert.equal(statusTunnel.body.data.instanceName, "acc-main", "隧道场景 instanceName 仍应按 uin 匹配成功");
// webui.json 已随 dir 递归清理
console.log("ok 8 - webui.json 端口优先于 Host 头端口");

// ---------- 9) import 带 nickname；服务端昵称为空时补一次 PUT ----------
let importCalls = [];
putCalls = [];
serverRecord = null;
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (u.includes("/config/bots/" + SELF + "/import") && method === "POST") {
        importCalls.push(JSON.parse(init.body));
        // 模拟服务端已有无昵称的老记录：import 幂等，原样返回不覆盖
        if (!serverRecord) serverRecord = { uin: SELF, nickname: "", revision: 1, config: JSON.parse(init.body).config };
        return jsonRes({ revision: serverRecord.revision, imported: false });
    }
    if (u.includes("/config/bots/" + SELF) && method === "GET") {
        if (!serverRecord) return new Response("{}", { status: 404 });
        return jsonRes(serverRecord);
    }
    if (u.includes("/config/bots/" + SELF) && method === "PUT") {
        const body = JSON.parse(init.body);
        putCalls.push({ url: u, body });
        serverRecord = { ...serverRecord, nickname: body.nickname, revision: serverRecord.revision + 1 };
        return jsonRes({ revision: serverRecord.revision });
    }
    throw new TypeError("fetch failed（mock 未覆盖 " + method + " " + u + "）");
};
logs.length = 0;
startServerConfigSync();
await new Promise((resolve) => setTimeout(resolve, 300));
stopServerConfigSync();
assert.equal(pluginState.nickname, "测试昵称", "前置：本地昵称应来自 get_login_info");
assert.equal(importCalls.length, 1, "启动应恰好 import 一次");
assert.equal(importCalls[0].nickname, "测试昵称", "import body 应带本地昵称");
assert.equal(putCalls.length, 1, "服务端昵称为空应恰好补写一次");
assert.equal(putCalls[0].body.nickname, "测试昵称", "PUT 应带昵称");
assert.equal(putCalls[0].body.expectedRevision, 1, "PUT 应带刚读到的 expectedRevision");
assert.equal(putCalls[0].body.config.cooldownSeconds, cfg().cooldownSeconds, "PUT 只补昵称，配置内容应是刚读到的服务端版本");
assert.ok(logs.some((l) => l.includes("[配置] 已补写服务端昵称")), "补写成功应打日志");
await syncBotConfig(false);
assert.equal(putCalls.length, 1, "补写成功后下一轮同步不应重复 PUT");
console.log("ok 9 - import 带 nickname；服务端昵称为空补一次 PUT（expectedRevision 防覆盖）");

// ---------- 10) 本地昵称不可用：import 不带 nickname，也不补 PUT ----------
pluginState.nickname = "";
const originalCall = ctx.actions.call;
ctx.actions.call = async (action) => {
    if (action === "get_login_info") throw new Error("OneBot 未就绪");
    return originalCall(action);
};
importCalls = [];
putCalls = [];
serverRecord = null;
logs.length = 0;
startServerConfigSync();
await new Promise((resolve) => setTimeout(resolve, 300));
stopServerConfigSync();
ctx.actions.call = originalCall;
pluginState.nickname = "测试昵称";
assert.equal(importCalls.length, 1, "启动应恰好 import 一次");
assert.ok(!("nickname" in importCalls[0]), "本地昵称不可用时 import body 不应带 nickname");
assert.equal(putCalls.length, 0, "本地昵称不可用时不应补写");
assert.ok(logs.some((l) => l.includes("[配置] 本地昵称不可用")), "昵称不可用应有 debug 日志");
console.log("ok 10 - 本地昵称不可用：import 不带 nickname、不补 PUT");

// ---------- 11) init 时昵称为空串、同步时重取成功：补写应触发 ----------
pluginState.nickname = "";
importCalls = [];
putCalls = [];
serverRecord = null;
logs.length = 0;
startServerConfigSync();
await new Promise((resolve) => setTimeout(resolve, 300));
stopServerConfigSync();
assert.equal(pluginState.nickname, "测试昵称", "refreshNickname 应把重取到的昵称缓存回 state");
assert.equal(putCalls.length, 1, "init 拿到空昵称时同步阶段重取成功应补写一次");
assert.equal(putCalls[0].body.nickname, "测试昵称", "补写 PUT 应带重取到的昵称");
assert.equal(putCalls[0].body.expectedRevision, 1, "补写 PUT 应带刚读到的 expectedRevision");
console.log("ok 11 - init 昵称为空串时同步阶段重取并补写");

// ---------- 清理 ----------
stopServerConfigSync();
globalThis.fetch = originalFetch;
fs.rmSync(dir, { recursive: true, force: true });
console.log("\nbot-config tests passed");
