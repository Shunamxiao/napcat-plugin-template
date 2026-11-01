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
const groupEvent = (text, at) => {
  const message = at
    ? [{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: " " + text } }]
    : [{ type: "text", data: { text } }];
  return {
    post_type: "message",
    message_type: "group",
    group_id: Number(GID),
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

console.log("\nhandle-message tests passed");
