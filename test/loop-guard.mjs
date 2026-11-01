/**
 * 防对刷自测（假 ctx，不发真实消息）
 *
 * 覆盖 2026-11-01 派发单：
 *   1) ignoreSenders 命中：不回复、不记冷却、日志带 reason=ignore_sender
 *   2) 自回声：与本目标 60 秒内最后一条已发回复相同 → 丢弃，日志带 reason=self_echo
 *   3) 群内 5 条触发熔断，第 6 条不发送、日志带 reason=loop_breaker；LoopGuard 5 分钟后恢复
 *   4) 正常消息不受影响
 *
 * 用法：node test/loop-guard.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessage, LoopGuard, pluginState, sanitizeConfig } from "../dist/index.mjs";

const SELF = "1457278554";
const BOT_B = "3788767702";
const USER = "2622011721";
const GID = "928013991";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-loop-"));
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
  ignoreSenders: [BOT_B],
  loopGuard: { maxReplies: 5, windowSeconds: 60, pauseSeconds: 300 },
  groupRules: { [GID]: { enabled: true, atOnly: false, aiEnabled: false } },
  keywords: [{ match: "下载", matchType: "contains", reply: "下载地址是 https://x", action: "reply" }],
};
fs.writeFileSync(configPath, JSON.stringify(baseConfig));

const logs = [];
const outbox = [];
const ctx = {
  pluginName: "napcat-plugin-autoreply",
  pluginPath: dir,
  dataPath: path.join(dir, "data"),
  configPath,
  adapterName: "onebot11",
  logger: {
    info: (...args) => { logs.push("[info] " + args.join(" ")); },
    debug: (...args) => { logs.push("[debug] " + args.join(" ")); },
    warn: (...args) => { logs.push("[warn] " + args.join(" ")); },
    error: (...args) => { logs.push("[error] " + args.join(" ")); },
  },
  actions: {
    call: async (action, params) => {
      if (action === "get_login_info") return { user_id: SELF };
      if (action === "send_msg") { outbox.push(params); return { message_id: outbox.length }; }
      return {};
    },
  },
  pluginManager: { config: { self_id: SELF } },
};

pluginState.init(ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));

let messageId = 0;
const nextId = () => "loop-test-" + process.pid + "-" + (++messageId);
const privateEvent = (text, userId = USER) => ({
  post_type: "message",
  message_type: "private",
  user_id: Number(userId),
  sender: { user_id: Number(userId) },
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
  message: [{ type: "text", data: { text } }],
  raw_message: text,
  message_id: nextId(),
});
const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
const textOf = (params) => (params.message || []).map((seg) => seg.data?.text ?? "").join("").trim();

let passed = 0;
function ok(name) {
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// 1) ignoreSenders 命中：不回复、不记冷却
let before = outbox.length;
const cooldownKeysBefore = [...pluginState.replyCooldowns.keys()];
await handleMessage(ctx, privateEvent("下载", BOT_B));
await wait();
assert.equal(outbox.length, before, "忽略的发送者不应回复");
assert.ok(logs.some((l) => l.includes("reason=ignore_sender") && l.includes(BOT_B)), "应记录 ignore_sender 日志");
const cooldownKeysAfter = [...pluginState.replyCooldowns.keys()];
assert.deepEqual(cooldownKeysAfter, cooldownKeysBefore, "忽略的发送者不应记冷却");
ok("ignoreSenders 命中不回复、不记冷却");

// 4) 正常消息不受影响（同时为自回声准备一条已发回复）
pluginState.config.ignoreSenders = [];
before = outbox.length;
await handleMessage(ctx, privateEvent("下载", USER));
await wait();
assert.equal(outbox.length, before + 1, "正常用户应正常回复");
const ourReply = textOf(outbox[outbox.length - 1]);
assert.equal(ourReply, "下载地址是 https://x");
ok("正常消息不受影响");

// 2) 自回声：同一用户复制我们的最后一条回复 → 丢弃
before = outbox.length;
await handleMessage(ctx, privateEvent(ourReply, USER));
await wait();
assert.equal(outbox.length, before, "自回声不应回复");
assert.ok(logs.some((l) => l.includes("reason=self_echo")), "应记录 self_echo 日志");
ok("自回声被丢弃");

// 3) 群内 5 条触发熔断，第 6 条不发送
before = outbox.length;
for (let i = 1; i <= 5; i++) {
  await handleMessage(ctx, groupEvent("下载", 1000 + i));
  await wait();
}
assert.equal(outbox.length, before + 5, "熔断前 5 条都应发出");
await handleMessage(ctx, groupEvent("下载", 1006));
await wait();
assert.equal(outbox.length, before + 5, "第 6 条应被对刷熔断拦下");
assert.ok(logs.some((l) => l.includes("reason=loop_breaker") && l.includes("暂停 300 秒")), "应记录 loop_breaker 日志");
ok("群内 5 条触发熔断，第 6 条不发送");

// 3b) LoopGuard 5 分钟后恢复（注入时钟）
let now = 0;
const guard = new LoopGuard({ maxReplies: 5, windowMs: 60_000, pauseMs: 300_000, echoWindowMs: 60_000, now: () => now });
for (let i = 0; i < 5; i++) {
  assert.equal(guard.allowSend("group:g").allowed, true, `第 ${i + 1} 条应放行`);
  guard.recordSend("group:g", "回复 " + i);
}
const verdict = guard.allowSend("group:g");
assert.equal(verdict.allowed, false);
assert.equal(verdict.justPaused, true, "第 6 条应触发暂停");
assert.equal(guard.allowSend("group:g").allowed, false, "暂停期间不应放行");
now += 300_000;
assert.equal(guard.allowSend("group:g").allowed, true, "5 分钟后应恢复");
ok("对刷熔断 5 分钟后恢复");

// 3c) 自回声窗口：60 秒内命中，超过 60 秒不再命中
now = 0;
guard.recordSend("private:u", "同一句话");
assert.equal(guard.isSelfEcho("private:u", "同一句话"), true);
now += 61_000;
assert.equal(guard.isSelfEcho("private:u", "同一句话"), false);
ok("自回声 60 秒窗口生效");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
