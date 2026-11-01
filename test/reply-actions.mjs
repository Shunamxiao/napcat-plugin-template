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
  beginCollect,
  clearCollect,
  collectKey,
  getCollect,
  isGroupConfigured,
  keywordsToText,
  planReply,
  resolveGroupFallback,
  resolveGroupPolicy,
  resolveSend,
  sanitizeConfig,
  sendWithRetry,
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

test("群级 atOnly 优先于全局，并标明来源", () => {
  const cfg = sanitizeConfig({
    atOnly: true,
    groupRules: { "928013991": { atOnly: false, aiEnabled: true }, "100000": {} },
  });
  const p = resolveGroupPolicy(cfg, "928013991");
  assert.deepEqual(p.atOnly, { value: false, source: "group" });
  assert.deepEqual(p.aiEnabled, { value: true, source: "group" });
  // 未显式配置的字段回落全局
  const q = resolveGroupPolicy(cfg, "100000");
  assert.deepEqual(q.atOnly, { value: true, source: "global" });
  assert.deepEqual(q.aiEnabled, { value: true, source: "global" });
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
  let calls = 0;
  const flaky = await sendWithRetry(async () => {
    calls++;
    if (calls === 1) throw new Error("EventChecker Failed");
  }, 5);
  assert.equal(calls, 2);
  assert.equal(flaky.ok, true);
  assert.equal(flaky.attempts, 2);

  let always = 0;
  const failed = await sendWithRetry(async () => {
    always++;
    throw new Error("EventChecker Failed");
  }, 5);
  assert.equal(always, 2);
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 2);
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
  assert.deepEqual(cfg.fallback, {
    privateText: "这个问题我拿不准，已经转给人工客服了，稍后回复你～",
    groupAtText: "这个问题我帮你转人工，稍后回复～",
  });
});

test("human 留档写入 JSONL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  const file = path.join(dir, "handoff.jsonl");
  const ok = appendHandoffRecord(file, {
    ts: new Date().toISOString(),
    userId: "u1",
    groupId: "928013991",
    text: "我要投诉",
    reason: "keyword_human",
    rule: "投诉",
    collected: [{ q: "哪个游戏？", a: "原神" }],
  });
  assert.equal(ok, true);
  const line = JSON.parse(fs.readFileSync(file, "utf-8").trim());
  assert.equal(line.reason, "keyword_human");
  assert.equal(line.groupId, "928013991");
  assert.deepEqual(line.collected, [{ q: "哪个游戏？", a: "原神" }]);
  fs.unlinkSync(file);
  fs.rmdirSync(dir);
});

for (const [name, fn] of pending) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`\n${passed} passed`);
