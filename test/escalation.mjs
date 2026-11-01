/**
 * 三层判定纯逻辑自测（不连服务、不发消息）
 *
 * 直接跑构建产物 dist/index.mjs 里的 planReply / resolveSend / isBlocked，
 * 覆盖派发单要求的五种场景：
 *   1) 拉黑用户任何消息都不回
 *   2) 私聊未命中升级
 *   3) 群内未 @ 不升级
 *   4) 规则 aiFallback=false 时不升级
 *   5) 服务返回 reply='' 时不发消息
 *
 * 用法：node test/escalation.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import { isBlocked, planReply, resolveSend } from "../dist/index.mjs";

const base = {
  atBot: false,
  blockUsers: [],
  kbEnabled: true,
  aiTrigger: { private: true, groupAtOnly: true },
  groupAiEnabled: true,
};

const rule = (over = {}) => ({ match: "下载", matchType: "contains", reply: "规则话术", ...over });

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// 1) 拉黑用户任何消息都不回（规则命中、AI 可用、有兜底话术也一样）
test("拉黑用户任何消息都不回", () => {
  const users = [{ userId: "123456", reason: "spam" }];
  assert.equal(isBlocked("123456", users), true);
  assert.equal(isBlocked("654321", users), false);

  for (const kind of ["private", "group"]) {
    const plan = planReply({ ...base, kind, userId: "123456", atBot: true, rule: rule(), blockUsers: users });
    assert.deepEqual(plan, { kind: "blocked" });
    const out = resolveSend({ plan, ask: { reply: "不该发出的 AI 答案" }, kind, defaultReply: "也不该发的兜底" });
    assert.equal(out.send, false);
    assert.equal(out.text, undefined);
  }
});

// 2) 私聊未命中升级 AI
test("私聊未命中升级", () => {
  const plan = planReply({ ...base, kind: "private", userId: "u1", rule: null });
  assert.equal(plan.kind, "ai");

  const out = resolveSend({ plan, ask: { reply: "AI 答案" }, kind: "private", defaultReply: "兜底" });
  assert.equal(out.send, true);
  assert.equal(out.text, "AI 答案");
  assert.equal(out.source, "ai");
});

// 3) 群内未 @ 不升级（groupAtOnly=true）；@ 了才升级
test("群内未 @ 不升级", () => {
  const plan = planReply({ ...base, kind: "group", userId: "u1", atBot: false, rule: null });
  assert.equal(plan.kind, "none");
  assert.equal(plan.reason, "group_need_at");
  assert.equal(resolveSend({ plan, ask: { reply: "AI 答案" }, kind: "group" }).send, false);

  const atPlan = planReply({ ...base, kind: "group", userId: "u1", atBot: true, rule: null });
  assert.equal(atPlan.kind, "ai");
  assert.equal(resolveSend({ plan: atPlan, ask: { reply: "AI 答案" }, kind: "group" }).text, "AI 答案");
});

// 4) 规则 aiFallback=false 时不升级；=true 才先问服务并支持回退
test("规则 aiFallback=false 时不升级", () => {
  const plan = planReply({ ...base, kind: "private", userId: "u1", rule: rule({ aiFallback: false }) });
  assert.equal(plan.kind, "rule");
  const out = resolveSend({ plan, ask: { reply: "不应被使用" }, kind: "private" });
  assert.equal(out.text, "规则话术");
  assert.equal(out.source, "rule");
});

test("规则 aiFallback=true 先问服务，失败退回规则话术", () => {
  const plan = planReply({ ...base, kind: "private", userId: "u1", rule: rule({ aiFallback: true }) });
  assert.equal(plan.kind, "rule-ai");
  assert.equal(resolveSend({ plan, ask: { reply: "AI 答案" }, kind: "private" }).text, "AI 答案");

  const fallback = resolveSend({ plan, ask: null, kind: "private", defaultReply: "兜底" });
  assert.equal(fallback.send, true);
  assert.equal(fallback.text, "规则话术");
  assert.equal(fallback.source, "rule");
});

// 5) 服务返回 reply='' / 空串 / 无响应时不发消息
test("服务返回 reply='' 时不发消息", () => {
  const plan = { kind: "ai" };
  for (const ask of [{ reply: "" }, { reply: "   " }, null]) {
    const out = resolveSend({ plan, ask, kind: "group" });
    assert.equal(out.send, false);
    assert.equal(out.text, undefined);
  }
  // 私聊此时维持现状：发原兜底话术（与升级前行为一致）
  const priv = resolveSend({ plan, ask: { reply: "" }, kind: "private", defaultReply: "【自动回复】我现在不在" });
  assert.equal(priv.send, true);
  assert.equal(priv.source, "default");
});

// 补充：总开关/群级禁用/私聊触发关闭都不应调服务
test("开关与群级禁用短路", () => {
  assert.equal(planReply({ ...base, kbEnabled: false, kind: "private", userId: "u1", rule: null }).kind, "none");
  assert.equal(
    planReply({ ...base, kind: "group", userId: "u1", atBot: true, rule: null, groupAiEnabled: false }).reason,
    "group_ai_disabled",
  );
  assert.equal(
    planReply({ ...base, kind: "private", userId: "u1", rule: null, aiTrigger: { private: false, groupAtOnly: true } }).reason,
    "private_trigger_off",
  );
  // groupAtOnly=false 时群内任意未命中都升级
  const any = planReply({ ...base, kind: "group", userId: "u1", atBot: false, rule: null, aiTrigger: { private: true, groupAtOnly: false } });
  assert.equal(any.kind, "ai");
});

console.log(`\n${passed} passed`);
