/**
 * 私聊首条引导自测（假 ctx，不发真实消息、不连服务）
 *
 * 覆盖：
 *   0) 默认值与 patch 合并：private.guide 三字段缺省回落默认，部分补丁保留旧值
 *   1) 首次私聊回引导文案，不触发关键词回复，也不调用 /answer
 *   2) 窗口内第二条私聊正常走关键词（引导不消耗关键词冷却）
 *   3) 窗口外再次引导
 *   4) 不同用户互不影响
 *   5) guide.enabled=false 时行为与原来一致
 *   6) 白名单内的号同样收到引导
 *   7) 引导文案为空等同不引导
 *   8) clearPrivateGuide 后窗口记录清空
 *
 * 用法：node test/private-guide.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyConfigPatch, clearPrivateGuide, handleMessage, pluginState, sanitizeConfig } from "../dist/index.mjs";

const SELF = "1457278554";
const USER_A = "2622011721";
const USER_C = "2622011723";
const USER_D = "2622011724";
const USER_E = "2622011725";
const USER_F = "2622011726";
const USER_G = "2622011727";
const USER_W = "2622011728";
const USER_X = "2622011729";
const USER_H = "2622011730";
const USER_J = "2622011731";

const GUIDE_TEXT = "资源都在群公告的群文件和腾讯文档里，先看公告。";
const KEYWORD_REPLY = "关键词回复";
const FALLBACK = "私聊兜底";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-guide-"));
const configPath = path.join(dir, "config.json");

const baseConfig = {
  enabled: true,
  atOnly: false,
  cooldownSeconds: 60,
  replyDelayMinMs: 0,
  replyDelayMaxMs: 0,
  crossAccountDedup: false,
  private: {
    enabled: true,
    whitelist: [],
    mergeWindowMs: 0,
    guide: { enabled: true, text: GUIDE_TEXT, windowSeconds: 1800 },
  },
  group: { enabled: true, whitelist: [] },
  fallback: { privateText: FALLBACK, groupAtText: "群兜底" },
  collect: { enabled: false, questions: [] },
  relay: { token: "" },
  kbService: { enabled: true, baseUrl: "https://svc.test", token: "tok", timeoutMs: 1000 },
  aiTrigger: { private: true, groupAtOnly: true },
  guard: { enabled: false },
  loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
  groupRules: {},
  keywords: [{ match: "有", matchType: "prefix", reply: KEYWORD_REPLY, action: "reply" }],
};
fs.writeFileSync(configPath, JSON.stringify(baseConfig));

const outbox = [];
let sentSeq = 0;
const ctx = {
  pluginName: "napcat-plugin-autoreply",
  pluginPath: dir,
  dataPath: path.join(dir, "data"),
  configPath,
  adapterName: "onebot11",
  logger: {
    info: (...args) => console.log("[info]", ...args),
    debug: (...args) => console.log("[debug]", ...args),
    warn: (...args) => console.warn("[warn]", ...args),
    error: (...args) => console.error("[error]", ...args),
  },
  actions: {
    call: async (action, params) => {
      if (action === "get_login_info") return { user_id: SELF };
      if (action === "send_msg") {
        outbox.push(params);
        sentSeq++;
        return { message_id: "guide-" + sentSeq };
      }
      return {};
    },
  },
  pluginManager: { config: { self_id: SELF } },
};

// 服务调用计数器：引导路径不得产生 /answer
let answerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/answer")) answerCalls++;
  return { ok: true, json: async () => ({ reply: "", action: "unknown", score: 0 }) };
};

pluginState.init(ctx);
await new Promise((resolve) => setTimeout(resolve, 20));

let messageId = 0;
const nextMessageId = () => "guide-test-" + process.pid + "-" + (++messageId);
const privateEvent = (text, userId = USER_A) => ({
  post_type: "message",
  message_type: "private",
  user_id: Number(userId),
  sender: { user_id: Number(userId) },
  message: [{ type: "text", data: { text } }],
  raw_message: text,
  message_id: nextMessageId(),
});
const textOf = (params) => (params.message || []).map((seg) => seg.data?.text ?? "").join("").trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reset = (patch = {}) => {
  const merged = { ...baseConfig, ...patch };
  merged.private = { ...baseConfig.private, ...(patch.private ?? {}) };
  if (patch.private?.guide) {
    merged.private.guide = { ...baseConfig.private.guide, ...patch.private.guide };
  }
  pluginState.config = sanitizeConfig(merged);
  pluginState.config.replyDelayMinMs = 0;
  pluginState.config.replyDelayMaxMs = 0;
};

// 0) 默认值 + patch 合并
const defaults = sanitizeConfig({ private: { enabled: true } });
assert.equal(defaults.private.guide.enabled, false, "guide 默认关闭");
assert.equal(defaults.private.guide.text, GUIDE_TEXT, "guide 默认文案");
assert.equal(defaults.private.guide.windowSeconds, 1800, "guide 默认窗口 30 分钟");
const patched = applyConfigPatch(defaults, { private: { guide: { enabled: true } } });
assert.equal(patched.private.guide.enabled, true, "patch 可更新 enabled");
assert.equal(patched.private.guide.text, GUIDE_TEXT, "部分补丁保留原有文案");
assert.equal(patched.private.guide.windowSeconds, 1800, "部分补丁保留原有窗口");
console.log("ok 0 - guide 默认值与补丁合并");

// 1) 首次私聊：回引导，不命中关键词，不调 /answer
reset();
let before = outbox.length;
answerCalls = 0;
await handleMessage(ctx, privateEvent("有吗", USER_A));
await wait(80);
assert.equal(outbox.length, before + 1, "首次私聊应只回一条");
assert.equal(textOf(outbox[outbox.length - 1]), GUIDE_TEXT, "首次私聊应回引导文案");
assert.equal(answerCalls, 0, "引导不得调用 /answer");
console.log("ok 1 - 首次私聊回引导且不触发关键词/服务");

// 2) 窗口内第二条：正常走关键词（证明引导没消耗关键词冷却）
before = outbox.length;
await handleMessage(ctx, privateEvent("有吗", USER_A));
await wait(80);
assert.equal(outbox.length, before + 1, "窗口内第二条应正常回复");
assert.equal(textOf(outbox[outbox.length - 1]), KEYWORD_REPLY, "窗口内第二条应走关键词");
assert.equal(answerCalls, 0, "关键词回复不需要 /answer");
console.log("ok 2 - 窗口内第二条走关键词");

// 3) 窗口外再次引导
reset({ private: { guide: { windowSeconds: 1 } } });
before = outbox.length;
await handleMessage(ctx, privateEvent("你好", USER_C));
await wait(80);
assert.equal(textOf(outbox[outbox.length - 1]), GUIDE_TEXT, "窗口内首次应引导");
assert.equal(outbox.length, before + 1);
await wait(1100);
await handleMessage(ctx, privateEvent("你好", USER_C));
await wait(80);
assert.equal(outbox.length, before + 2, "窗口外应再次引导");
assert.equal(textOf(outbox[outbox.length - 1]), GUIDE_TEXT, "窗口外再次引导");
console.log("ok 3 - 窗口外再次引导");

// 4) 不同用户互不影响
reset();
before = outbox.length;
await handleMessage(ctx, privateEvent("你好", USER_D));
await wait(80);
await handleMessage(ctx, privateEvent("你好", USER_E));
await wait(80);
assert.equal(outbox.length, before + 2, "两个用户都应各自引导");
assert.deepEqual(outbox.slice(-2).map(textOf), [GUIDE_TEXT, GUIDE_TEXT], "两个用户都收到引导");
console.log("ok 4 - 不同用户互不影响");

// 5) guide.enabled=false：行为与原来一致
reset({ private: { guide: { enabled: false } } });
before = outbox.length;
await handleMessage(ctx, privateEvent("有吗", USER_F));
await wait(80);
assert.equal(textOf(outbox[outbox.length - 1]), KEYWORD_REPLY, "关闭引导后命中关键词照常回复");
await handleMessage(ctx, privateEvent("你好", USER_G));
await wait(80);
assert.equal(textOf(outbox[outbox.length - 1]), FALLBACK, "关闭引导后未命中走兜底");
assert.equal(outbox.length, before + 2);
console.log("ok 5 - guide.enabled=false 行为与原来一致");

// 6) 白名单内的号同样收到引导
reset({ private: { whitelist: [USER_W] } });
before = outbox.length;
await handleMessage(ctx, privateEvent("你好", USER_W));
await wait(80);
assert.equal(outbox.length, before + 1, "白名单内的号应收到引导");
assert.equal(textOf(outbox[outbox.length - 1]), GUIDE_TEXT);
await handleMessage(ctx, privateEvent("你好", USER_X));
await wait(80);
assert.equal(outbox.length, before + 1, "白名单外的号不回复");
console.log("ok 6 - 白名单内的号同样收到引导");

// 7) 引导文案为空：等同不引导
reset({ private: { guide: { text: "   " } } });
before = outbox.length;
await handleMessage(ctx, privateEvent("有吗", USER_H));
await wait(80);
assert.equal(textOf(outbox[outbox.length - 1]), KEYWORD_REPLY, "空文案不引导，照常命中关键词");
assert.equal(outbox.length, before + 1);
console.log("ok 7 - 空引导文案等同不引导");

// 8) clearPrivateGuide 清空窗口记录
reset();
before = outbox.length;
await handleMessage(ctx, privateEvent("你好", USER_J));
await wait(80);
await handleMessage(ctx, privateEvent("你好", USER_J));
await wait(80);
assert.equal(textOf(outbox[outbox.length - 1]), FALLBACK, "窗口内第二条不引导，走兜底");
clearPrivateGuide();
await handleMessage(ctx, privateEvent("你好", USER_J));
await wait(80);
assert.equal(textOf(outbox[outbox.length - 1]), GUIDE_TEXT, "清理后重新引导");
assert.equal(outbox.length, before + 3);
console.log("ok 8 - clearPrivateGuide 清空窗口记录");

globalThis.fetch = originalFetch;
fs.rmSync(dir, { recursive: true, force: true });
console.log("\nprivate-guide tests passed");
