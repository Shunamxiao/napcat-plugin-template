/**
 * 服务降级提示自测（假 ctx + 假 fetch，不发真实消息）
 *
 * 覆盖：
 *   1) /answer 超时 → 私聊回一次 SERVICE_DOWN_REPLY，日志 reason=service_down status=timeout
 *   2) 同一用户 10 分钟内第二次失败 → 不再回任何消息
 *   3) FAQ 正常路径不受影响
 *   4) 5xx / 连接失败 → status=http / err
 *   5) 群内已定向（@机器人）未命中失败 → 按未命中策略回群兜底（不再发降级提示）
 *
 * 用法：node test/service-down.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, pluginState, sanitizeConfig, SERVICE_DOWN_REPLY } from "../dist/index.mjs";

const SELF = "1457278554";
const USER_A = "2622011721";
const USER_B = "2622011722";
const USER_C = "2622011723";
const USER_D = "2622011724";
const USER_E = "2622011725";
const GID = "928013991";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-service-down-"));
const configPath = path.join(dir, "config.json");
const baseConfig = {
  enabled: true,
  atOnly: false,
  atReply: false,
  cooldownSeconds: 0,
  replyDelayMinMs: 0,
  replyDelayMaxMs: 0,
  crossAccountDedup: false,
  private: { enabled: true, whitelist: [], mergeWindowMs: 0 },
  group: { enabled: true, whitelist: [] },
  fallback: { privateText: "普通私聊兜底", groupAtText: "普通群兜底" },
  collect: { enabled: false, questions: [] },
  relay: { token: "" },
  kbService: { enabled: true, baseUrl: "https://service.test", token: "tok", timeoutMs: 500 },
  aiTrigger: { private: true, groupAtOnly: true },
  loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
  guard: { enabled: false },
  groupRules: { [GID]: { enabled: true, atOnly: false, aiEnabled: true } },
  keywords: [],
};
fs.writeFileSync(configPath, JSON.stringify(baseConfig));

const outbox = [];
const logs = [];
let sentSeq = 0;
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
      if (action === "send_msg") {
        outbox.push(params);
        sentSeq++;
        return { message_id: "sd-" + sentSeq };
      }
      if (action === "delete_msg") return {};
      return {};
    },
  },
  pluginManager: { config: { self_id: SELF } },
};

const originalFetch = globalThis.fetch;
pluginState.init(ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));

let messageId = 0;
const nextId = () => "sd-test-" + process.pid + "-" + (++messageId);
const privateEvent = (text, userId) => ({
  post_type: "message",
  message_type: "private",
  user_id: Number(userId),
  sender: { user_id: Number(userId) },
  self_id: Number(SELF),
  message: [{ type: "text", data: { text } }],
  raw_message: text,
  message_id: nextId(),
});
const groupEvent = (text, userId) => ({
  post_type: "message",
  message_type: "group",
  group_id: Number(GID),
  user_id: Number(userId),
  sender: { user_id: Number(userId) },
  self_id: Number(SELF),
  message: [
    { type: "at", data: { qq: SELF } },
    { type: "text", data: { text: " " + text } },
  ],
  raw_message: "[CQ:at,qq=" + SELF + "] " + text,
  message_id: nextId(),
});
const textOf = (params) => (params.message || []).map((seg) => seg.data?.text ?? "").join("").trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timeoutFetch = (_url, init) => new Promise((_resolve, reject) => {
  const signal = init?.signal;
  const fail = () => {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    reject(error);
  };
  if (signal?.aborted) fail();
  else if (signal) signal.addEventListener("abort", fail, { once: true });
});

// 1) 超时 → 仅一次降级提示
globalThis.fetch = timeoutFetch;
let before = outbox.length;
logs.length = 0;
await handleMessage(ctx, privateEvent("在吗", USER_A));
await wait(700);
assert.equal(outbox.length, before + 1, "超时应回一次降级提示");
assert.equal(textOf(outbox[outbox.length - 1]), SERVICE_DOWN_REPLY, "应发送固定降级文案");
assert.ok(
  logs.some((l) => l.includes("reason=service_down") && l.includes("status=timeout") && l.includes("user=" + USER_A)),
  "应记录 reason=service_down status=timeout",
);
console.log("ok 1 - 超时只回一次降级提示");

// 2) 10 分钟内第二次失败 → 不再回
before = outbox.length;
await handleMessage(ctx, privateEvent("还在吗", USER_A));
await wait(700);
assert.equal(outbox.length, before, "同一用户 10 分钟内不应再回");
assert.ok(logs.some((l) => l.includes("reason=service_down") && l.includes("user=" + USER_A)), "失败仍应记录日志");
console.log("ok 2 - 10 分钟内第二次不再回");

// 3) FAQ 正常路径不受影响
globalThis.fetch = async () => new Response(JSON.stringify({ reply: "FAQ 正常答案", action: "answer" }), { status: 200 });
before = outbox.length;
await handleMessage(ctx, privateEvent("正常问题", USER_B));
await wait(100);
assert.equal(outbox.length, before + 1, "FAQ 正常应回一次");
assert.equal(textOf(outbox[outbox.length - 1]), "FAQ 正常答案", "FAQ 正常应回服务答案");
console.log("ok 3 - FAQ 正常路径不受影响");

// 4) 5xx / 连接失败 → 各自降级并记录 status
globalThis.fetch = async () => new Response("{}", { status: 503 });
before = outbox.length;
logs.length = 0;
await handleMessage(ctx, privateEvent("五零三", USER_C));
await wait(100);
assert.equal(outbox.length, before + 1, "5xx 应回降级提示");
assert.equal(textOf(outbox[outbox.length - 1]), SERVICE_DOWN_REPLY, "5xx 应回固定降级文案");
assert.ok(logs.some((l) => l.includes("reason=service_down") && l.includes("status=http") && l.includes("code=503")), "5xx 应记录 status=http");

globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
before = outbox.length;
logs.length = 0;
await handleMessage(ctx, privateEvent("连接失败", USER_D));
await wait(100);
assert.equal(outbox.length, before + 1, "连接失败应回降级提示");
assert.ok(logs.some((l) => l.includes("reason=service_down") && l.includes("status=err")), "连接失败应记录 status=err");
console.log("ok 4 - 5xx / 连接失败分别降级");

// 5) 群内已定向失败 → 未命中策略 ai_then_fallback 回群兜底
globalThis.fetch = timeoutFetch;
before = outbox.length;
logs.length = 0;
await handleMessage(ctx, groupEvent("群里的问题", USER_E));
await wait(700);
assert.equal(outbox.length, before + 1, "群内 @ 机器人失败应回一次兜底");
assert.equal(textOf(outbox[outbox.length - 1]), "普通群兜底", "未命中失败应按策略回群兜底");
assert.equal(outbox[outbox.length - 1].group_id, GID, "兜底回复应发到原群");
assert.ok(logs.some((l) => l.includes("reason=service_down") && l.includes("status=timeout") && l.includes("group=" + GID)), "群失败应记录 service_down");
console.log("ok 5 - 群内定向未命中失败回群兜底");

globalThis.fetch = originalFetch;
fs.rmSync(dir, { recursive: true, force: true });
console.log("\nservice-down tests passed");
