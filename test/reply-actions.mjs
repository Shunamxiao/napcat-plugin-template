/**
 * 群处理口径 / 规则动作 / 兜底 / 发送重试 自测（不连服务、不发消息）
 *
 * 覆盖 2026-11-01 派发单追加口径：
 *   1) groupRules 是群处理白名单，未配置群不处理
 *   2) 群级 atOnly 优先于全局；enabled/atOnly/aiEnabled 来源可判定
 *   3) action=reply/ai/human 三分支，旧配置默认 reply
 *   4) 私聊必回、群内 @ 必回兜底、群内未 @ 且未命中静默
 *   5) 群消息发送失败只重试一次
 *   6) human 留档写入 JSONL
 *
 * 用法：node test/reply-actions.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendHandoffRecord,
  HitLog,
  beginCollect,
  clearCollect,
  collectKey,
  getCollect,
  isGroupConfigured,
  keywordsToText,
  notifyHandoff,
  pruneHandoffFile,
  planReply,
  SendGuard,
  sendWithRetry,
  classifySendError,
  MIN_RETRY_DELAY_MS,
  resolveGroupFallback,
  resolveGroupPolicy,
  resolveSend,
  startHandoffCleanup,
  stopHandoffCleanup,
  applyConfigPatch,
  plugin_get_config,
  pluginState,
  sanitizeConfig,
  stepCollect,
  textToKeywords,
} from "../dist/index.mjs";

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

const base = {
  atBot: false,
  blockUsers: [],
  kbEnabled: true,
  aiTrigger: { private: true, groupAtOnly: true },
  groupAiEnabled: true,
};
const rule = (over = {}) => ({ match: "下载", matchType: "contains", reply: "规则话术", ...over });

test("groupRules 是白名单：未配置群不处理", () => {
  const cfg = sanitizeConfig({ groupRules: { "928013991": { enabled: true, atOnly: false } } });
  assert.equal(isGroupConfigured(cfg, "928013991"), true);
  assert.equal(isGroupConfigured(cfg, "100000"), false);
});

test("群级老字段映射成 mode/missPolicy，并标明来源", () => {
  const cfg = sanitizeConfig({
    atOnly: true,
    groupRules: { "928013991": { atOnly: false, aiEnabled: true }, "100000": {} },
  });
  const p = resolveGroupPolicy(cfg, "928013991");
  assert.deepEqual(p.mode, { value: "all", source: "group" });
  assert.deepEqual(p.missPolicy, { value: "ai_then_fallback", source: "group" });
  assert.deepEqual(p.atForceReply, { value: true, source: "global" });
  assert.deepEqual(p.keywordOutsideAt, { value: true, source: "global" });
  // 未显式配置的字段回落全局（全局 atOnly=true → at）
  const q = resolveGroupPolicy(cfg, "100000");
  assert.deepEqual(q.mode, { value: "at", source: "global" });
  assert.deepEqual(q.missPolicy, { value: "ai_then_fallback", source: "global" });
});

test("旧配置无 action 字段时默认 reply；ai/human 原样保留", () => {
  const cfg = sanitizeConfig({
    keywords: [
      { match: "旧", reply: "旧话术" },
      { match: "问", reply: "话术", action: "ai" },
      { match: "人", reply: "话术", action: "human" },
    ],
  });
  assert.deepEqual(cfg.keywords.map((k) => k.action), ["reply", "ai", "human"]);
});

test("action=reply：回固定文案", () => {
  const plan = planReply({ ...base, kind: "private", userId: "u1", rule: rule({ action: "reply" }) });
  assert.equal(plan.kind, "rule");
  const out = resolveSend({ plan, ask: { reply: "不该用" }, kind: "private" });
  assert.equal(out.text, "规则话术");
  assert.equal(out.source, "rule");
});

test("action=ai：跳过文案直接问服务，无答案走兜底", () => {
  const plan = planReply({ ...base, kind: "group", userId: "u1", atBot: true, rule: rule({ action: "ai" }) });
  assert.equal(plan.kind, "rule-ai-only");
  const hit = resolveSend({ plan, ask: { reply: "AI 答案" }, kind: "group", atBot: true, groupFallback: "群兜底" });
  assert.equal(hit.text, "AI 答案");
  const miss = resolveSend({ plan, ask: null, kind: "group", atBot: true, groupFallback: "群兜底" });
  assert.equal(miss.text, "群兜底");
  assert.equal(miss.source, "default");

  // AI 总开关关闭时回落规则文案，不静默
  const off = planReply({ ...base, kbEnabled: false, kind: "group", userId: "u1", atBot: true, rule: rule({ action: "ai" }) });
  assert.equal(off.kind, "rule");
});

test("action=human：不查 FAQ、不调 AI，回兜底话术", () => {
  const plan = planReply({ ...base, kind: "group", userId: "u1", atBot: true, rule: rule({ action: "human" }) });
  assert.equal(plan.kind, "rule-human");
  const out = resolveSend({ plan, ask: { reply: "不该调用的 AI" }, kind: "group", atBot: true, groupFallback: "转人工兜底" });
  assert.equal(out.text, "转人工兜底");
  assert.equal(out.source, "default");
});

test("私聊必回：未命中/无 AI 答案都发私聊兜底", () => {
  const plan = planReply({ ...base, kind: "private", userId: "u1", rule: null });
  assert.equal(plan.kind, "ai");
  assert.equal(
    resolveSend({ plan, ask: null, kind: "private", defaultReply: "私聊兜底" }).text,
    "私聊兜底",
  );
  // AI 未启用时甚至不产生 ai 计划，仍要回兜底
  const none = planReply({ ...base, kbEnabled: false, kind: "private", userId: "u1", rule: null });
  assert.equal(none.kind, "none");
  assert.equal(
    resolveSend({ plan: none, ask: null, kind: "private", defaultReply: "私聊兜底" }).text,
    "私聊兜底",
  );
});

test("群内 @ 必回兜底；未被 @ 且未命中静默", () => {
  const plan = planReply({ ...base, kind: "group", userId: "u1", atBot: true, rule: null });
  assert.equal(plan.kind, "ai");
  assert.equal(
    resolveSend({ plan, ask: null, kind: "group", atBot: true, groupFallback: "群兜底" }).text,
    "群兜底",
  );
  const silent = planReply({ ...base, kind: "group", userId: "u1", atBot: false, rule: null });
  assert.equal(silent.kind, "none");
  assert.equal(
    resolveSend({ plan: silent, ask: null, kind: "group", atBot: false, groupFallback: "群兜底" }).send,
    false,
  );
});

test("群级兜底覆盖：字符串覆盖、null 跟随全局", () => {
  const cfg = sanitizeConfig({
    fallback: { privateText: "全局私聊", groupAtText: "全局群@" },
    groupRules: {
      "1": { fallback: { groupAtText: "本群兜底" } },
      "2": { fallback: { privateText: null, groupAtText: null } },
    },
  });
  assert.deepEqual(resolveGroupFallback(cfg, "1"), { privateText: "全局私聊", groupAtText: "本群兜底" });
  assert.deepEqual(resolveGroupFallback(cfg, "2"), { privateText: "全局私聊", groupAtText: "全局群@" });
});

test("发送失败只重试一次", async () => {
  const sleeps = [];
  let calls = 0;
  const flaky = await sendWithRetry(async () => {
    calls++;
    if (calls === 1) throw new Error("ETIMEDOUT");
  }, 5, undefined, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(calls, 2);
  assert.equal(flaky.ok, true);
  assert.equal(flaky.attempts, 2);
  assert.deepEqual(sleeps, [MIN_RETRY_DELAY_MS], "重试间隔不少于 2 秒");

  let always = 0;
  const failed = await sendWithRetry(async () => {
    always++;
    throw new Error("ETIMEDOUT");
  }, 5, undefined, { sleep: async () => {} });
  assert.equal(always, 2, "网络错误最多重试一次，禁止循环打接口");
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 2);
});

test("失败分型：QQ 侧拒绝不重试，网络错误重试一次", async () => {
  const sleeps = [];
  const qqError = new Error("Action send_msg failed: EventChecker Failed: NTEvent ... EventRet: result:120");
  assert.equal(classifySendError(qqError), "qq_reject");
  let qqCalls = 0;
  const qq = await sendWithRetry(async () => {
    qqCalls++;
    throw qqError;
  }, 2, undefined, {
    shouldRetry: (e) => classifySendError(e) === "network",
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(qqCalls, 1, "QQ 侧拒绝不得重试");
  assert.equal(qq.attempts, 1);
  assert.equal(qq.kind, "qq_reject");
  assert.equal(sleeps.length, 0);

  let netCalls = 0;
  const net = await sendWithRetry(async () => {
    netCalls++;
    throw new Error("socket hang up");
  }, 2, undefined, {
    shouldRetry: (e) => classifySendError(e) === "network",
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(netCalls, 2, "网络错误重试一次");
  assert.equal(net.ok, false);
  assert.equal(net.kind, "network");
  assert.deepEqual(sleeps, [2000]);
});

test("熔断：达阈值进入冷却、成功清零、到期恢复", async () => {
  let now = 10_000;
  const events = [];
  const guard = new SendGuard({
    now: () => now,
    hooks: {
      onOpen: (key, failures, cooldownMs) => events.push(["open", key, failures, cooldownMs]),
      onRecover: (key) => events.push(["recover", key]),
    },
  });
  const key = "group:480563774";
  assert.equal(guard.isOpen(key), false);
  assert.equal(guard.onFailure(key, 3, 60_000).opened, false);
  assert.equal(guard.onFailure(key, 3, 60_000).opened, false);
  const third = guard.onFailure(key, 3, 60_000);
  assert.equal(third.opened, true);
  assert.equal(third.failures, 3);
  assert.equal(guard.isOpen(key), true, "冷却期内不再发送");
  assert.deepEqual(events, [["open", key, 3, 60_000]]);

  // 冷却到期自动恢复，且只回调一次
  now += 60_000;
  assert.equal(guard.isOpen(key), false);
  assert.deepEqual(events[1], ["recover", key]);
  assert.equal(guard.failuresOf(key), 0);

  // 成功一次清零连续失败计数
  guard.onFailure(key, 3, 60_000);
  guard.onFailure(key, 3, 60_000);
  guard.onSuccess(key);
  assert.equal(guard.failuresOf(key), 0);
  assert.equal(guard.onFailure(key, 3, 60_000).opened, false, "清零后重新计数");
  guard.reset();
  assert.equal(guard.failuresOf(key), 0);
});

test("keywordsText 往返保留 action", () => {
  const rules = [
    { match: "固定", matchType: "contains", reply: "话术", action: "reply" },
    { match: "问", matchType: "contains", reply: "", action: "ai" },
    { match: "人", matchType: "contains", reply: "转人工", action: "human", image: "https://x/y.avif" },
  ];
  const text = keywordsToText(rules);
  const parsed = textToKeywords(text);
  assert.deepEqual(parsed.map((r) => r.action), ["reply", "ai", "human"]);
  assert.equal(parsed[0].reply, "话术");
  assert.equal(parsed[2].image, "https://x/y.avif");
});

test("转人工追问：按顺序逐题收集，答案结构为 {q,a}", () => {
  const store = new Map();
  const key = collectKey("private", "u1");
  const session = beginCollect(store, key, {
    userId: "u1",
    triggerText: "我要投诉",
    rule: "投诉",
    questions: ["你的QQ号？", "哪个游戏？"],
  });
  assert.equal(getCollect(store, key), session);
  const first = stepCollect(session, "123456");
  assert.deepEqual(first, { done: false, nextQuestion: "哪个游戏？" });
  const second = stepCollect(session, "原神");
  assert.deepEqual(second, { done: true });
  assert.deepEqual(session.answers, [
    { q: "你的QQ号？", a: "123456" },
    { q: "哪个游戏？", a: "原神" },
  ]);
  clearCollect(store, session);
  assert.equal(getCollect(store, key), undefined);
});

test("collect/relay 配置缺省值：关闭追问、无题、relay 令牌为空", () => {
  const cfg = sanitizeConfig({});
  assert.deepEqual(cfg.collect, { enabled: false, questions: [] });
  assert.deepEqual(cfg.relay, { token: "" });
  assert.deepEqual(cfg.sendGuard, { failThreshold: 3, privateFailThreshold: 5, cooldownSeconds: 600 });
  assert.deepEqual(cfg.fallback, {
    privateText: "这个问题我拿不准，已经转给人工客服了，稍后回复你～",
    groupAtText: "这个问题我帮你转人工，稍后回复～",
  });
});

test("私聊兜底统一字段并只读迁移旧字段", () => {
  const fresh = sanitizeConfig({});
  assert.equal(fresh.private.enabled, false);
  const legacy = sanitizeConfig({ private: { defaultReply: "旧私聊兜底" }, fallback: { groupAtText: "群兜底" } });
  assert.equal(legacy.fallback.privateText, "旧私聊兜底");
  assert.equal("defaultReply" in legacy.private, false);
  const current = sanitizeConfig({ private: { defaultReply: "旧值" }, fallback: { privateText: "新值" } });
  assert.equal(current.fallback.privateText, "新值");
});

test("令牌出口打码，relay 占位符保留且空串清除", async () => {
  const original = pluginState.config;
  const current = sanitizeConfig({
    accountAccessKey: "account-secret",
    kbService: { enabled: true, baseUrl: "https://svc.test", token: "service-secret", timeoutMs: 1000 },
    relay: { token: "relay-secret" },
  });
  pluginState.config = current;
  const masked = await plugin_get_config();
  assert.equal(masked.accountAccessKey, "••••••");
  assert.equal(masked.kbService.token, "••••••");
  assert.equal(masked.relay.token, "••••••");
  assert.equal(applyConfigPatch(current, { relay: { token: "••••••" } }).relay.token, "relay-secret");
  assert.equal(applyConfigPatch(current, { relay: { token: "" } }).relay.token, "");
  pluginState.replaceConfig(masked);
  assert.equal(pluginState.config.relay.token, "relay-secret");
  assert.equal(pluginState.config.kbService.token, "service-secret");
  assert.equal(pluginState.config.accountAccessKey, "account-secret");
  pluginState.replaceConfig({ ...masked, relay: { token: "" } });
  assert.equal(pluginState.config.relay.token, "");
  pluginState.config = original;
});

test("命中日志读写均排除 30 天前记录", () => {
  const now = Date.parse("2026-11-05T00:00:00.000Z");
  const log = new HitLog(10, () => now);
  log.add({ ts: "2026-10-05T23:59:59.999Z", channel: "private", userId: "old", result: "answered" });
  log.add({ ts: "2026-10-06T00:00:00.000Z", channel: "private", userId: "kept", result: "answered" });
  assert.deepEqual(log.list().map((entry) => entry.userId), ["kept"]);
});

test("notifyHandoff：上报 /handoff，带 collected 与鉴权头", async () => {
  const calls = [];
  const ok = await notifyHandoff(
    { enabled: true, baseUrl: "https://svc.test", token: "tok", timeoutMs: 1000 },
    {
      userId: "u1",
      groupId: "928013991",
      text: "我要投诉",
      collected: [{ q: "哪个游戏？", a: "原神" }],
      reason: "keyword_human",
    },
    async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  );
  assert.equal(ok, true);
  assert.equal(calls[0].url, "https://svc.test/handoff");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-bot-token"], "tok");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    userId: "u1",
    groupId: "928013991",
    text: "我要投诉",
    reason: "keyword_human",
    collected: [{ q: "哪个游戏？", a: "原神" }],
  });
});

test("notifyHandoff：无 collected 不上传空数组；失败/异常一律 false 不抛", async () => {
  let body;
  const ok = await notifyHandoff(
    { enabled: true, baseUrl: "https://svc.test/", token: "tok", timeoutMs: 1000 },
    { userId: "u2", text: "在吗", reason: "keyword_human" },
    async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  );
  assert.equal(ok, true);
  assert.equal("collected" in body, false);
  assert.equal("groupId" in body, false);

  const denied = await notifyHandoff(
    { enabled: true, baseUrl: "https://svc.test", token: "tok", timeoutMs: 1000 },
    { userId: "u2", text: "在吗", reason: "keyword_human" },
    async () => ({ ok: false, json: async () => ({ error: "unauthorized" }) }),
  );
  assert.equal(denied, false);

  const broken = await notifyHandoff(
    { enabled: true, baseUrl: "https://svc.test", token: "tok", timeoutMs: 1000 },
    { userId: "u2", text: "在吗", reason: "keyword_human" },
    async () => {
      throw new Error("ECONNREFUSED");
    },
  );
  assert.equal(broken, false);

  let called = false;
  const noToken = await notifyHandoff(
    { enabled: true, baseUrl: "https://svc.test", token: "", timeoutMs: 1000 },
    { userId: "u2", text: "在吗", reason: "keyword_human" },
    async () => {
      called = true;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  );
  assert.equal(noToken, false);
  assert.equal(called, false);
});

test("human 留档写入并原子清理 30 天前合法记录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  const file = path.join(dir, "handoff.jsonl");
  const now = Date.parse("2026-11-05T00:00:00.000Z");
  const recent = { ts: "2026-10-06T00:00:00.000Z", userId: "recent", text: "保留", reason: "keyword_human" };
  const old = { ts: "2026-10-05T23:59:59.999Z", userId: "old", text: "删除", reason: "keyword_human" };
  assert.equal(appendHandoffRecord(file, old), true);
  assert.equal(appendHandoffRecord(file, recent), true);
  fs.appendFileSync(file, "坏行保留\n");
  assert.equal(pruneHandoffFile(file, now), true);
  assert.equal(fs.readFileSync(file, "utf-8"), JSON.stringify(recent) + "\n坏行保留\n");

  startHandoffCleanup(file);
  assert.ok(globalThis.__napcatAutoreplyHandoffCleanupTimer);
  stopHandoffCleanup();
  assert.equal(globalThis.__napcatAutoreplyHandoffCleanupTimer, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [name, fn] of pending) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`\n${passed} passed`);
