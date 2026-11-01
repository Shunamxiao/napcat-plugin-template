/**
 * handleMessage 端到端自测（假 ctx，不发真实消息）
 *
 * 用构建产物里的 handleMessage + pluginState，模拟 OneBot 事件，验证：
 *   1) 私聊未命中怪问题 → 回私聊兜底
 *   2) 群内未 @ 同一问题 → 无任何回复
 *   3) 群内 @ 同一问题 → 回群兜底
 *   4) 转人工追问：按题收集后回兜底，并写 collected
 *
 * 用法：node test/handle-message.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, pluginState, sanitizeConfig } from "../dist/index.mjs";

const SELF = "1457278554";
const OTHER = "2622011721";
const GID = "928013991";
const QUESTION = "请问客服电话是多少呀";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-msg-"));
const configPath = path.join(dir, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    enabled: true,
    atOnly: false,
    cooldownSeconds: 0,
    replyDelayMinMs: 0,
    replyDelayMaxMs: 0,
    private: { enabled: true, whitelist: [] },
    group: { enabled: true, whitelist: [] },
    fallback: { privateText: "私聊兜底话术", groupAtText: "群@兜底话术" },
    collect: { enabled: false, questions: [] },
    relay: { token: "" },
    // 本文件测的是消息流转，不放行对刷熔断（阈值调大，避免连续用例互相影响）
    loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
    kbService: { enabled: false },
    aiTrigger: { private: true, groupAtOnly: true },
    groupRules: { [GID]: { enabled: true, atOnly: false, aiEnabled: true } },
  }),
);

const outbox = [];
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
        return { message_id: outbox.length };
      }
      return {};
    },
  },
  pluginManager: { config: { self_id: SELF } },
};

pluginState.init(ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;

let messageId = 0;
const RUN = String(Date.now());
const nextMessageId = () => RUN + "-" + (++messageId);
const privateEvent = (text) => ({
  post_type: "message",
  message_type: "private",
  user_id: Number(OTHER),
  sender: { user_id: Number(OTHER) },
  message: [{ type: "text", data: { text } }],
  raw_message: text,
  message_id: nextMessageId(),
});
const groupEvent = (text, at, groupId = GID) => {
  const message = at
    ? [{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: " " + text } }]
    : [{ type: "text", data: { text } }];
  return {
    post_type: "message",
    message_type: "group",
    group_id: Number(groupId),
    user_id: Number(OTHER),
    sender: { user_id: Number(OTHER) },
    message,
    raw_message: at ? "[CQ:at,qq=" + SELF + "] " + text : text,
    message_id: nextMessageId(),
  };
};
const textOf = (params) => (params.message || []).map((seg) => seg.data?.text ?? "").join("").trim();
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

// 1) 私聊未命中 → 私聊兜底
let before = outbox.length;
await handleMessage(ctx, privateEvent(QUESTION));
await wait();
assert.equal(outbox.length, before + 1, "私聊应回复");
assert.equal(textOf(outbox[outbox.length - 1]), "私聊兜底话术");
console.log("ok 1 - 私聊未命中回兜底");

// 2) 群内未 @ 未命中 → 静默
before = outbox.length;
await handleMessage(ctx, groupEvent(QUESTION, false));
await wait();
assert.equal(outbox.length, before, "群内未 @ 不应回复");
console.log("ok 2 - 群内未 @ 未命中静默");

// 3) 群内 @ 未命中 → 群兜底
before = outbox.length;
await handleMessage(ctx, groupEvent(QUESTION, true));
await wait();
assert.equal(outbox.length, before + 1, "群内 @ 应回复");
assert.equal(textOf(outbox[outbox.length - 1]), "群@兜底话术");
console.log("ok 3 - 群内 @ 未命中回群兜底");

// 4) 转人工追问：两题收集后回兜底并留档 collected
pluginState.config = sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  collect: { enabled: true, questions: ["你的QQ号？", "哪个游戏？"] },
  groupRules: {
    [GID]: {
      enabled: true,
      atOnly: false,
      aiEnabled: true,
      keywords: [{ match: "投诉", reply: "转人工", action: "human" }],
    },
  },
});
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;
before = outbox.length;
await handleMessage(ctx, groupEvent("我要投诉", true));
await wait();
assert.equal(outbox.length, before + 1);
assert.equal(textOf(outbox[outbox.length - 1]), "你的QQ号？");
await handleMessage(ctx, groupEvent("123456", false));
await wait();
assert.equal(textOf(outbox[outbox.length - 1]), "哪个游戏？");
await handleMessage(ctx, groupEvent("原神", false));
await wait();
assert.equal(textOf(outbox[outbox.length - 1]), "群@兜底话术");

const handoffFile = path.join(dir, "data", "handoff.jsonl");
const records = fs.readFileSync(handoffFile, "utf-8").trim().split("\n").map(JSON.parse);
const last = records[records.length - 1];
assert.equal(last.reason, "keyword_human");
assert.deepEqual(last.collected, [
  { q: "你的QQ号？", a: "123456" },
  { q: "哪个游戏？", a: "原神" },
]);
console.log("ok 4 - 转人工追问收集 collected 并留档");

// 5) action=human（collect 关闭）→ 上报服务 /handoff，用户仍收到兜底
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: true, json: async () => ({ ok: true }) };
};
const humanConfig = (extra = {}) => sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  kbService: { enabled: true, baseUrl: "https://svc.test", token: "tok", timeoutMs: 1000 },
  collect: { enabled: false, questions: [] },
  groupRules: {
    [GID]: {
      enabled: true,
      atOnly: false,
      aiEnabled: true,
      keywords: [{ match: "投诉", reply: "转人工", action: "human" }],
    },
  },
  ...extra,
});
pluginState.config = humanConfig();
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;
before = outbox.length;
await handleMessage(ctx, groupEvent("我要投诉", true));
await wait(100);
assert.equal(outbox.length, before + 1, "转人工仍应回兜底");
assert.equal(textOf(outbox[outbox.length - 1]), "群@兜底话术");
assert.equal(calls.length, 1, "应上报一次 /handoff");
assert.equal(calls[0].url, "https://svc.test/handoff");
assert.equal(calls[0].init.method, "POST");
assert.equal(calls[0].init.headers["x-bot-token"], "tok");
assert.deepEqual(JSON.parse(calls[0].init.body), {
  userId: OTHER,
  text: "我要投诉",
  reason: "keyword_human",
  groupId: GID,
});
console.log("ok 5 - 转人工上报 /handoff 且不影响兜底回复");

// 6) /handoff 失败只记日志，用户照常收到兜底
calls.length = 0;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
};
before = outbox.length;
await handleMessage(ctx, groupEvent("我也要投诉", true));
await wait(100);
assert.equal(calls.length, 1, "失败也要尝试上报");
assert.equal(outbox.length, before + 1, "上报失败不能吞掉兜底回复");
assert.equal(textOf(outbox[outbox.length - 1]), "群@兜底话术");
console.log("ok 6 - 上报失败不影响兜底回复");

// 7) 追问结果 collected 随 /handoff 一起上报
calls.length = 0;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: true, json: async () => ({ ok: true }) };
};
pluginState.config = humanConfig({ collect: { enabled: true, questions: ["你的QQ号？", "哪个游戏？"] } });
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;
before = outbox.length;
await handleMessage(ctx, groupEvent("我要投诉", true));
await wait();
assert.equal(textOf(outbox[outbox.length - 1]), "你的QQ号？");
assert.equal(calls.length, 0, "追问未完成前不应上报");
await handleMessage(ctx, groupEvent("123456", false));
await wait();
await handleMessage(ctx, groupEvent("原神", false));
await wait(100);
assert.equal(outbox.length, before + 3, "两问 + 兜底");
assert.equal(calls.length, 1, "答完后上报一次");
const collectPayload = JSON.parse(calls[0].init.body);
assert.deepEqual(collectPayload.collected, [
  { q: "你的QQ号？", a: "123456" },
  { q: "哪个游戏？", a: "原神" },
]);
assert.equal(collectPayload.reason, "keyword_human");
console.log("ok 7 - 追问结果 collected 随 /handoff 上报");

// 8) 精确回放 2026-11-01 09:19:50 真机消息（b927073 群 @ 静默回归）
//    生产里 ctx.pluginManager.config 没有 self_id，旧代码据此判 atBot=false → 静默
ctx.pluginManager.config = {};
const realConfig = sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  kbService: { enabled: true, baseUrl: "https://svc.test", token: "tok", timeoutMs: 1000 },
  aiTrigger: { private: true, groupAtOnly: true },
  group: { enabled: true, whitelist: [] },
  groupRules: {
    [GID]: {
      enabled: true,
      atOnly: false,
      aiEnabled: true,
      welcome: { enabled: null },
      keywords: [
        { match: "有人吗", matchType: "contains", reply: "有的", action: "reply", aiFallback: true },
        { match: "下载", matchType: "contains", reply: "注意看群文档", action: "reply", aiFallback: true },
        { match: "你是谁", matchType: "contains", reply: "机器人", action: "reply", aiFallback: true },
      ],
    },
  },
});
pluginState.config = realConfig;
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;
calls.length = 0;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: true, json: async () => ({ reply: "", action: "handoff", score: 0 }) };
};
const realEvent = (over = {}) => ({
  post_type: "message",
  message_type: "group",
  self_id: Number(SELF),
  group_id: Number(GID),
  user_id: 3788767702,
  sender: { user_id: 3788767702 },
  message: [
    { type: "at", data: { qq: SELF } },
    { type: "text", data: { text: "  你好呀测试一下" } },
  ],
  raw_message: "[CQ:at,qq=" + SELF + "]  你好呀测试一下",
  message_id: RUN + "-real-1816586550",
  ...over,
});
before = outbox.length;
await handleMessage(ctx, realEvent());
await wait(100);
assert.equal(outbox.length, before + 1, "@ 未命中规则也必须回群兜底");
assert.equal(textOf(outbox[outbox.length - 1]), "群@兜底话术");
assert.equal(calls.length, 1, "应先走 FAQ/AI 层");
assert.ok(calls[0].url.endsWith("/answer"));
assert.equal(JSON.parse(calls[0].init.body).trigger, "group_at");
console.log("ok 8 - 真机 @ 消息（无 self_id 环境）回群兜底");

// 9) 未 @ 未命中 → 静默（不问服务、不发消息）
calls.length = 0;
before = outbox.length;
await handleMessage(ctx, realEvent({
  message: [{ type: "text", data: { text: "你好呀测试一下" } }],
  raw_message: "你好呀测试一下",
  message_id: RUN + "-real-1816586551",
}));
await wait(100);
assert.equal(outbox.length, before, "未 @ 未命中应静默");
assert.equal(calls.length, 0, "未 @ 未命中不应问服务");
console.log("ok 9 - 未 @ 未命中静默");

// 10) 未配置群 @ → 静默
before = outbox.length;
await handleMessage(ctx, realEvent({
  group_id: 480563774,
  message_id: RUN + "-real-1816586552",
}));
await wait(100);
assert.equal(outbox.length, before, "未配置群 @ 应静默");
console.log("ok 10 - 未配置群 @ 静默");

// 11) 适配器把 message 下发成 CQ 字符串时，@ 判定仍生效
before = outbox.length;
await handleMessage(ctx, realEvent({
  message: "[CQ:at,qq=" + SELF + "]  你好呀测试一下",
  message_id: RUN + "-real-1816586553",
}));
await wait(100);
assert.equal(outbox.length, before + 1, "CQ 字符串形态的 @ 也要回复");
assert.equal(textOf(outbox[outbox.length - 1]), "群@兜底话术");
console.log("ok 11 - CQ 字符串 @ 判定兜底");

// 12) 群发送连续失败达阈值 → 熔断，冷却期内不再调用 send_msg
let sendCalls = 0;
const realCall = ctx.actions.call;
ctx.actions.call = async (action, params) => {
  if (action === "send_msg") {
    sendCalls++;
    throw new Error("Action send_msg failed: EventChecker Failed: NTEvent ... EventRet: result:120");
  }
  return realCall(action, params);
};
const BREAK_GID = 555666777;
pluginState.config = sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  kbService: { enabled: false },
  atReply: false,
  sendGuard: { failThreshold: 3, privateFailThreshold: 5, cooldownSeconds: 600 },
  groupRules: {
    [BREAK_GID]: {
      enabled: true,
      atOnly: false,
      aiEnabled: false,
      keywords: [{ match: "在吗", reply: "在的", action: "reply" }],
    },
  },
});
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;
for (let i = 0; i < 3; i++) {
  await handleMessage(ctx, groupEvent("在吗", true, BREAK_GID));
  await wait(40);
}
assert.equal(sendCalls, 3, "阈值内每次都应尝试发送");
const beforeSilent = sendCalls;
await handleMessage(ctx, groupEvent("在吗", true, BREAK_GID));
await wait(40);
assert.equal(sendCalls, beforeSilent, "熔断后不得再调用 send_msg");
ctx.actions.call = realCall;
console.log("ok 12 - 连续 3 次失败后熔断且不再发送");

// 13) 私聊带图：图文混合 segments 正确
pluginState.config = sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  kbService: { enabled: false },
  private: { enabled: true, whitelist: [] },
  keywords: [{ match: "下载", matchType: "contains", reply: "给你下载地址", action: "reply", image: "https://cdn.example/x.png" }],
});
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;
before = outbox.length;
await handleMessage(ctx, privateEvent("怎么下载"));
await wait();
assert.deepEqual(outbox[outbox.length - 1].message, [
  { type: "text", data: { text: "给你下载地址" } },
  { type: "image", data: { file: "https://cdn.example/x.png" } },
]);
console.log("ok 13 - 私聊带图 segments 正确");

// 14) 群聊带图 + @ 触发者：at / text / image 顺序正确
pluginState.config = sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  kbService: { enabled: false },
  atReply: true,
  groupRules: {
    [GID]: {
      enabled: true,
      atOnly: false,
      aiEnabled: false,
      keywords: [{ match: "下载", reply: "给你看图", action: "reply", image: "base64://iVBORw0KGgo=" }],
    },
  },
});
pluginState.config.replyDelayMinMs = 0;
pluginState.config.replyDelayMaxMs = 0;
before = outbox.length;
await handleMessage(ctx, groupEvent("怎么下载", true));
await wait();
assert.deepEqual(outbox[outbox.length - 1].message, [
  { type: "at", data: { qq: OTHER } },
  { type: "text", data: { text: " 给你看图" } },
  { type: "image", data: { file: "base64://iVBORw0KGgo=" } },
]);
console.log("ok 14 - 群聊带图 + @ 段构造正确（base64 直通）");

// 15) 本地图片 >5MB 被跳过：只发文字
const bigPath = "/root/dev/plugin/test/tmp-big-image.png";
fs.writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1));
try {
  pluginState.config = sanitizeConfig({
    ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
    kbService: { enabled: false },
    private: { enabled: true, whitelist: [] },
    keywords: [{ match: "大图", reply: "只有文字", action: "reply", image: bigPath }],
  });
  pluginState.config.replyDelayMinMs = 0;
  pluginState.config.replyDelayMaxMs = 0;
  before = outbox.length;
  await handleMessage(ctx, privateEvent("大图"));
  await wait();
  assert.deepEqual(outbox[outbox.length - 1].message, [{ type: "text", data: { text: "只有文字" } }]);
  console.log("ok 15 - 超过 5MB 的本地图片被跳过");
} finally {
  fs.rmSync(bigPath, { force: true });
}

globalThis.fetch = originalFetch;

console.log("\nhandle-message tests passed");
