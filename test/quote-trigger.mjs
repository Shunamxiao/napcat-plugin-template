/**
 * 引用回复触发自测（假 ctx，不发真实消息）
 *
 * 覆盖：
 *   1) 引用机器人自己发出的消息 → 即使没 @ 也按定向提问回复
 *   2) 引用他人消息 → 不触发（群 atOnly=true 时静默）
 *   3) 群未启用 → 引用机器人也不触发
 *   4) CQ 字符串形态的引用（只有 id）同样生效
 *
 * 用法：node test/quote-trigger.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, pluginState, sanitizeConfig } from "../dist/index.mjs";

const SELF = "1457278554";
const OTHER = "2622011721";
const GID = "928013991";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-quote-"));
const configPath = path.join(dir, "config.json");
const baseConfig = {
  enabled: true,
  atOnly: true,
  atReply: false,
  cooldownSeconds: 0,
  replyDelayMinMs: 0,
  replyDelayMaxMs: 0,
  crossAccountDedup: false,
  private: { enabled: false, whitelist: [], mergeWindowMs: 0 },
  group: { enabled: true, whitelist: [] },
  fallback: { privateText: "私聊兜底", groupAtText: "群兜底" },
  collect: { enabled: false, questions: [] },
  relay: { token: "" },
  kbService: { enabled: false },
  aiTrigger: { private: true, groupAtOnly: true },
  guard: { enabled: false },
  loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
  groupRules: { [GID]: { enabled: true, atOnly: true, aiEnabled: false } },
  keywords: [{ match: "绝不会命中", reply: "x", action: "reply" }],
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
        return { message_id: "sent-" + sentSeq };
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
const nextMessageId = () => "quote-test-" + process.pid + "-" + (++messageId);
const groupEvent = (text, message) => ({
  post_type: "message",
  message_type: "group",
  group_id: Number(GID),
  user_id: Number(OTHER),
  sender: { user_id: Number(OTHER) },
  message,
  raw_message: text,
  message_id: nextMessageId(),
});
const textOf = (params) => (params.message || []).map((seg) => seg.data?.text ?? "").join("").trim();
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// 先让机器人发一条消息，拿到本实例的 message_id
let before = outbox.length;
await handleMessage(ctx, groupEvent("[CQ:at,qq=" + SELF + "] 你好", [
  { type: "at", data: { qq: SELF } },
  { type: "text", data: { text: " 你好" } },
]));
await wait();
assert.equal(outbox.length, before + 1, "先发一条群回复作为被引用对象");
assert.equal(textOf(outbox[outbox.length - 1]), "群兜底");
const botMessageId = "sent-" + sentSeq;
console.log("ok 1 - 机器人发出可被引用的消息 id=" + botMessageId);

// 1) 引用机器人消息，没有 @ → atOnly=true 也应回复
before = outbox.length;
await handleMessage(ctx, groupEvent("[CQ:reply,id=" + botMessageId + "] 这怎么弄", [
  { type: "reply", data: { id: botMessageId } },
  { type: "text", data: { text: " 这怎么弄" } },
]));
await wait();
assert.equal(outbox.length, before + 1, "引用机器人消息应触发回复");
assert.equal(textOf(outbox[outbox.length - 1]), "群兜底");
console.log("ok 2 - 引用机器人消息且未 @ 仍触发");

// 1b) 未配置群默认也允许引用机器人触发
pluginState.config = sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  groupRules: {},
});
before = outbox.length;
await handleMessage(ctx, groupEvent("[CQ:reply,id=" + botMessageId + "] 这怎么弄", [
  { type: "reply", data: { id: botMessageId } },
  { type: "text", data: { text: " 这怎么弄" } },
]));
await wait();
assert.equal(outbox.length, before + 1, "未配置群引用机器人消息仍应触发回复");
assert.equal(textOf(outbox[outbox.length - 1]), "群兜底");
console.log("ok 2b - 未配置群引用机器人消息仍触发");
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));

// 2) 引用他人消息 → 不触发
before = outbox.length;
await handleMessage(ctx, groupEvent("[CQ:reply,id=someone-else] 这怎么弄", [
  { type: "reply", data: { id: "someone-else" } },
  { type: "text", data: { text: " 这怎么弄" } },
]));
await wait();
assert.equal(outbox.length, before, "引用他人消息不应触发");
console.log("ok 3 - 引用他人消息不触发");

// 3) 群未启用 → 引用机器人也不触发
pluginState.config = sanitizeConfig({
  ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
  groupRules: { [GID]: { enabled: false, atOnly: true, aiEnabled: false } },
});
before = outbox.length;
await handleMessage(ctx, groupEvent("[CQ:reply,id=" + botMessageId + "] 这怎么弄", [
  { type: "reply", data: { id: botMessageId } },
  { type: "text", data: { text: " 这怎么弄" } },
]));
await wait();
assert.equal(outbox.length, before, "群未启用时引用机器人也不应回复");
console.log("ok 4 - 群未启用时不触发");

// 4) CQ 字符串形态的引用（只有 id）
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));
before = outbox.length;
await handleMessage(ctx, {
  ...groupEvent("[CQ:reply,id=" + botMessageId + "] 这怎么弄", "[CQ:reply,id=" + botMessageId + "] 这怎么弄"),
  message: "[CQ:reply,id=" + botMessageId + "] 这怎么弄",
});
await wait();
assert.equal(outbox.length, before + 1, "CQ 字符串引用机器人消息也应触发");
console.log("ok 5 - CQ 字符串引用 id 判定生效");

fs.rmSync(dir, { recursive: true, force: true });
console.log("\nquote-trigger tests passed");
