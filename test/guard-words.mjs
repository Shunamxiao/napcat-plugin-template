/**
 * 群守卫服务词表自测（假 ctx + 假 fetch，不发真实消息）
 *
 * 覆盖：
 *   1) 首次拉取失败 → 服务词表为空，不撤回
 *   2) 成功拉取 → 服务词命中即撤回
 *   3) 本地 guard.words 与服务词表叠加，两处任一命中
 *   4) 后续失败保留上次成功缓存
 *
 * 用法：node test/guard-words.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, pluginState, sanitizeConfig, syncGuardWords } from "../dist/index.mjs";

const SELF = "1457278554";
const OTHER = "2622011721";
const GID = "928013991";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-guard-words-"));
const configPath = path.join(dir, "config.json");
const baseConfig = {
  enabled: true,
  atOnly: false,
  atReply: false,
  cooldownSeconds: 0,
  replyDelayMinMs: 0,
  replyDelayMaxMs: 0,
  crossAccountDedup: false,
  private: { enabled: false, whitelist: [], mergeWindowMs: 0 },
  group: { enabled: true, whitelist: [] },
  fallback: { privateText: "", groupAtText: "" },
  collect: { enabled: false, questions: [] },
  relay: { token: "" },
  kbService: { enabled: true, baseUrl: "https://service.test", token: "tok", timeoutMs: 1000 },
  aiTrigger: { private: false, groupAtOnly: true },
  loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
  guard: {
    enabled: true,
    groupIds: [],
    words: ["本地词"],
    action: "recall",
    warnText: "",
    wordsRefreshMs: 300000,
  },
  groupRules: { [GID]: { enabled: true, atOnly: false, aiEnabled: false } },
  keywords: [],
};
fs.writeFileSync(configPath, JSON.stringify(baseConfig));

const deletes = [];
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
    call: async (action, params) => {
      if (action === "get_login_info") return { user_id: SELF };
      if (action === "delete_msg") { deletes.push(params); return {}; }
      if (action === "send_msg") return { message_id: "gw-" + deletes.length };
      return {};
    },
  },
  pluginManager: { config: { self_id: SELF } },
};

const originalFetch = globalThis.fetch;
pluginState.init(ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));

const event = (text) => ({
  post_type: "message",
  message_type: "group",
  group_id: Number(GID),
  user_id: Number(OTHER),
  sender: { user_id: Number(OTHER) },
  self_id: Number(SELF),
  message: [{ type: "text", data: { text } }],
  raw_message: text,
  message_id: "guard-words-" + process.pid + "-" + Math.random().toString(16).slice(2),
});
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const deleteCount = () => deletes.length;

// 1) 首次失败：服务词表为空，不撤回，日志保留缓存 0 条
globalThis.fetch = async () => { throw new Error("fetch failed"); };
logs.length = 0;
await syncGuardWords();
assert.equal(pluginState.serviceGuardWords.length, 0, "首次失败应为空词表");
assert.ok(logs.some((l) => l.includes("词表同步失败") && l.includes("缓存 0 条")), "应记录同步失败日志");
let before = deleteCount();
await handleMessage(ctx, event("这条含服务专属词"));
await wait();
assert.equal(deleteCount(), before, "服务词表为空时不应撤回");
console.log("ok 1 - 首次拉取失败保持空词表");

// 2) 成功拉取 → 服务词命中撤回
globalThis.fetch = async () => new Response(JSON.stringify({ users: [], words: ["服务专属词", " 服务专属词 ", "", 42] }), { status: 200 });
logs.length = 0;
await syncGuardWords();
assert.deepEqual(pluginState.serviceGuardWords, ["服务专属词"], "服务词应去重并过滤非字符串/空串");
assert.ok(logs.some((l) => l.includes("词表同步完成") && l.includes("服务词 1 条")), "应记录同步成功日志");
before = deleteCount();
await handleMessage(ctx, event("这条含服务专属词"));
await wait();
assert.equal(deleteCount(), before + 1, "服务词命中应撤回");
console.log("ok 2 - 服务词命中即撤回");

// 3) 本地词表始终叠加
before = deleteCount();
await handleMessage(ctx, event("这条含本地词"));
await wait();
assert.equal(deleteCount(), before + 1, "本地词应继续生效");
console.log("ok 3 - 本地词与服务词叠加生效");

// 4) 后续失败保留上次缓存
globalThis.fetch = async () => { throw new Error("fetch failed"); };
logs.length = 0;
await syncGuardWords();
assert.deepEqual(pluginState.serviceGuardWords, ["服务专属词"], "失败时应保留上次成功缓存");
assert.ok(logs.some((l) => l.includes("词表同步失败") && l.includes("缓存 1 条")), "应记录保留缓存日志");
before = deleteCount();
await handleMessage(ctx, event("这条含服务专属词"));
await wait();
assert.equal(deleteCount(), before + 1, "缓存保留后服务词仍应撤回");
console.log("ok 4 - 后续失败保留上次缓存");

globalThis.fetch = originalFetch;
fs.rmSync(dir, { recursive: true, force: true });
console.log("\nguard-words tests passed");
