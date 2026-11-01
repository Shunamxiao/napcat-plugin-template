/**
 * 群内容守卫自测（假 ctx，不发真实消息）
 *
 * 覆盖：
 *   1) 群消息命中屏蔽词 → delete_msg 撤回，日志带 reason=guard_recall user=… rule=…
 *   2) 未命中 → 不调用 delete_msg
 *   3) guard.enabled=false → 零撤销调用
 *   4) 私聊消息即使命中也不撤回
 *   5) groupIds 指定范围生效
 *   6) 撤回失败不影响短路（不继续自动回复）
 *
 * 用法：node test/content-guard.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, pluginState, sanitizeConfig } from "../dist/index.mjs";

const SELF = "1457278554";
const OTHER = "2622011721";
const GID = "928013991";
const OTHER_GID = "555666777";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-guard-"));
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
  fallback: { privateText: "私聊兜底", groupAtText: "群兜底" },
  collect: { enabled: false, questions: [] },
  relay: { token: "" },
  kbService: { enabled: false },
  aiTrigger: { private: false, groupAtOnly: true },
  loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
  guard: {
    enabled: true,
    groupIds: [],
    words: ["加微信", "代刷"],
    action: "recall",
    warnText: "请文明发言，违规内容将被撤回。",
  },
  groupRules: {
    [GID]: { enabled: true, atOnly: false, aiEnabled: false },
    [OTHER_GID]: { enabled: true, atOnly: false, aiEnabled: false },
  },
  // 命中屏蔽词时若守卫没短路，这条规则会让机器人回话（用于证明短路）
  keywords: [{ match: "加微信", reply: "不要加微信", action: "reply" }],
};
fs.writeFileSync(configPath, JSON.stringify(baseConfig));

const outbox = [];
const deletes = [];
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
        return { message_id: "msg-" + sentSeq };
      }
      if (action === "delete_msg") {
        deletes.push(params);
        return {};
      }
      return {};
    },
  },
  pluginManager: { config: { self_id: SELF } },
};

pluginState.init(ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));

let messageId = 0;
const nextMessageId = () => "guard-test-" + process.pid + "-" + (++messageId);
const event = (kind, text, groupId = GID, id = nextMessageId()) => ({
  post_type: "message",
  message_type: kind,
  group_id: kind === "group" ? Number(groupId) : undefined,
  user_id: Number(OTHER),
  sender: { user_id: Number(OTHER) },
  message: [{ type: "text", data: { text } }],
  raw_message: text,
  message_id: id,
});
const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
const reset = (patch) => {
  pluginState.config = sanitizeConfig({
    ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
    ...patch,
  });
};

// 1) 命中即撤回，且不再走自动回复
let outboxBefore = outbox.length;
let deletesBefore = deletes.length;
const hitEvent = event("group", "请加微信 abc123");
await handleMessage(ctx, hitEvent);
await wait();
assert.equal(deletes.length, deletesBefore + 1, "命中屏蔽词应调用一次 delete_msg");
assert.deepEqual(deletes[deletes.length - 1], { message_id: hitEvent.message_id });
assert.equal(outbox.length, outboxBefore, "守卫命中后不应继续自动回复");
assert.ok(logs.some((l) => l.includes("reason=guard_recall") && l.includes("user=" + OTHER) && l.includes("rule=加微信")), "应记录 guard_recall 日志");
console.log("ok 1 - 命中屏蔽词即撤回并短路");

// 2) 未命中不动
outboxBefore = outbox.length;
deletesBefore = deletes.length;
await handleMessage(ctx, event("group", "正常聊天内容"));
await wait();
assert.equal(deletes.length, deletesBefore, "未命中不应调用 delete_msg");
assert.equal(outbox.length, outboxBefore, "未命中且无规则命中时应静默");
console.log("ok 2 - 未命中不撤回");

// 3) 开关关闭 → 零撤销调用（关键词规则照常回复）
reset({ guard: { enabled: false, words: ["加微信"], action: "recall", groupIds: [] } });
deletesBefore = deletes.length;
outboxBefore = outbox.length;
await handleMessage(ctx, event("group", "请加微信 abc123"));
await wait();
assert.equal(deletes.length, deletesBefore, "guard.enabled=false 时不应调用 delete_msg");
assert.equal(outbox.length, outboxBefore + 1, "守卫关闭后自动回复照常");
console.log("ok 3 - guard.enabled=false 时零撤销调用");

// 4) 私聊命中也不撤回
reset({});
deletesBefore = deletes.length;
await handleMessage(ctx, event("private", "请加微信 abc123"));
await wait();
assert.equal(deletes.length, deletesBefore, "私聊消息不应被撤回");
console.log("ok 4 - 私聊消息不撤回");

// 5) groupIds 指定范围：不在名单内不撤回，名单内才撤回
reset({
  guard: { enabled: true, groupIds: [OTHER_GID], words: ["加微信"], action: "recall", warnText: "" },
});
deletesBefore = deletes.length;
await handleMessage(ctx, event("group", "请加微信 abc123", GID));
await wait();
assert.equal(deletes.length, deletesBefore, "不在守卫群名单内不应撤回");
reset({
  guard: { enabled: true, groupIds: [GID], words: ["加微信"], action: "recall", warnText: "" },
});
deletesBefore = deletes.length;
await handleMessage(ctx, event("group", "请加微信 abc123", GID));
await wait();
assert.equal(deletes.length, deletesBefore + 1, "名单内群应撤回");
console.log("ok 5 - groupIds 生效范围正确");

// 6) 撤回失败只记日志，不重试，也不继续自动回复
reset({});
const originalCall = ctx.actions.call;
let deleteAttempts = 0;
ctx.actions.call = async (action, params) => {
  if (action === "delete_msg") {
    deleteAttempts++;
    throw new Error("delete not allowed");
  }
  return originalCall(action, params);
};
outboxBefore = outbox.length;
await handleMessage(ctx, event("group", "请加微信 abc123"));
await wait();
assert.equal(deleteAttempts, 1, "撤回失败只尝试一次，不重试");
assert.equal(outbox.length, outboxBefore, "撤回失败也不能继续自动回复");
assert.ok(logs.some((l) => l.includes("reason=guard_recall_failed")), "应记录 guard_recall_failed 日志");
ctx.actions.call = originalCall;
console.log("ok 6 - 撤回失败不重试且仍短路");

// 7) NapCat 对 delete_msg 成功但无返回值会抛 No data returned → 视为成功
ctx.actions.call = async (action, params) => {
  if (action === "delete_msg") throw new Error("Action delete_msg failed: No data returned");
  return originalCall(action, params);
};
logs.length = 0;
await handleMessage(ctx, event("group", "请加微信 abc123"));
await wait();
assert.ok(logs.some((l) => l.includes("reason=guard_recall")), "No data returned 应记为撤回成功");
assert.ok(!logs.some((l) => l.includes("reason=guard_recall_failed")), "不应误记为撤回失败");
ctx.actions.call = originalCall;
console.log("ok 7 - delete_msg 无返回值按成功处理");

fs.rmSync(dir, { recursive: true, force: true });
console.log("\ncontent-guard tests passed");
