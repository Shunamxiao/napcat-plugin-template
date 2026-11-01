/**
 * 私聊连发合并自测（假 ctx，不发真实消息）
 *
 * 覆盖：
 *   1) 窗口内 3 条合并成一次问答，只发一条回复（换行拼接后命中关键词）
 *   2) 超出窗口的消息分开处理
 *   3) mergeWindowMs=0 时行为不变（逐条回复）
 *   4) 最多合并 5 条
 *
 * 用法：node test/private-merge.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, pluginState, sanitizeConfig } from "../dist/index.mjs";

const SELF = "1457278554";
const USER_A = "2622011721";
const USER_B = "2622011722";
const USER_C = "2622011723";
const USER_D = "2622011724";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-merge-"));
const configPath = path.join(dir, "config.json");
const baseConfig = {
  enabled: true,
  atOnly: false,
  atReply: false,
  cooldownSeconds: 0,
  replyDelayMinMs: 0,
  replyDelayMaxMs: 0,
  crossAccountDedup: false,
  private: { enabled: true, whitelist: [], mergeWindowMs: 80 },
  group: { enabled: true, whitelist: [] },
  fallback: { privateText: "私聊兜底", groupAtText: "群兜底" },
  collect: { enabled: false, questions: [] },
  relay: { token: "" },
  kbService: { enabled: false },
  aiTrigger: { private: false, groupAtOnly: true },
  guard: { enabled: false },
  loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
  groupRules: {},
  keywords: [{ match: "合并", reply: "合并命中", action: "reply" }],
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
        return { message_id: "merge-" + sentSeq };
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
const nextMessageId = () => "merge-test-" + process.pid + "-" + (++messageId);
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
const reset = (patch) => {
  pluginState.config = sanitizeConfig({
    ...JSON.parse(fs.readFileSync(configPath, "utf-8")),
    ...patch,
  });
};

// 1) 窗口内 3 条 → 合并后只发一条；第三条命中关键词，证明是合并后的文本
let before = outbox.length;
await handleMessage(ctx, privateEvent("第一句", USER_A));
await handleMessage(ctx, privateEvent("第二句", USER_A));
await handleMessage(ctx, privateEvent("我想合并一下", USER_A));
await wait(200);
assert.equal(outbox.length, before + 1, "窗口内 3 条应只回一次");
assert.equal(textOf(outbox[outbox.length - 1]), "合并命中", "应使用合并后的文本匹配关键词");
console.log("ok 1 - 窗口内 3 条合并成一次问答");

// 2) 超出窗口 → 分开处理
before = outbox.length;
await handleMessage(ctx, privateEvent("甲", USER_B));
await wait(150);
await handleMessage(ctx, privateEvent("乙", USER_B));
await wait(150);
assert.equal(outbox.length, before + 2, "超出窗口的消息应各自回复");
assert.deepEqual(outbox.slice(-2).map(textOf), ["私聊兜底", "私聊兜底"]);
console.log("ok 2 - 超出窗口分开处理");

// 3) mergeWindowMs=0 → 逐条立即回复，行为不变
reset({ private: { enabled: true, whitelist: [], mergeWindowMs: 0 } });
before = outbox.length;
await handleMessage(ctx, privateEvent("一", USER_C));
await handleMessage(ctx, privateEvent("二", USER_C));
await handleMessage(ctx, privateEvent("三", USER_C));
await wait(50);
assert.equal(outbox.length, before + 3, "窗口为 0 时应逐条回复");
console.log("ok 3 - mergeWindowMs=0 行为不变");

// 4) 最多合并 5 条：第 5 条立即合并发送，第 6 条进入下一批
reset({ private: { enabled: true, whitelist: [], mergeWindowMs: 100 } });
before = outbox.length;
for (let i = 1; i <= 5; i++) await handleMessage(ctx, privateEvent("第" + i + "条", USER_D));
await wait(30);
assert.equal(outbox.length, before + 1, "第 5 条应立即合并发送");
await handleMessage(ctx, privateEvent("第6条", USER_D));
await wait(160);
assert.equal(outbox.length, before + 2, "第 6 条应作为下一批发送");
console.log("ok 4 - 最多合并 5 条");

fs.rmSync(dir, { recursive: true, force: true });
console.log("\nprivate-merge tests passed");
