/**
 * 守卫处罚自测（纯逻辑，不发真实消息）
 *
 * 覆盖：
 *   1) 窗口内 3 次命中 → 禁言一次 + 发禁言提示，计数清零
 *   2) 窗口过期后不触发禁言（旧记录被丢弃）
 *   3) 禁言失败 → 降级为警告，只记 warn 日志、不重试
 *
 * 用法：node test/guard-penalty.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import { GuardPenaltyCounter, applyGuardPenalty } from "../dist/index.mjs";

const POLICY = {
  windowSeconds: 60,
  threshold: 3,
  muteSeconds: 600,
  warnText: "请文明发言",
  muteText: "已被禁言",
};

function harness(nowRef, banImpl) {
  const bans = [];
  const texts = [];
  const logs = [];
  const deps = {
    now: () => nowRef.t,
    counter: new GuardPenaltyCounter(),
    setBan: async (groupId, userId, seconds) => {
      bans.push({ groupId, userId, seconds });
      return banImpl ? banImpl(groupId, userId, seconds) : {};
    },
    sendText: async (groupId, text) => { texts.push({ groupId, text }); },
    log: (level, message) => { logs.push(level + " " + message); },
  };
  return { bans, texts, logs, deps };
}

// 1) 窗口内 3 次 → 第 3 次禁言，随后计数清零
{
  const now = { t: 1_000_000 };
  const h = harness(now);
  const run = () => applyGuardPenalty({ groupId: "123", userId: "456", policy: POLICY, deps: h.deps });

  let r = await run();
  assert.equal(r.count, 1, "第 1 次命中计数为 1");
  assert.equal(r.banned, false);
  now.t += 1000;
  r = await run();
  assert.equal(r.count, 2);
  now.t += 1000;
  r = await run();
  assert.equal(r.count, 3);
  assert.equal(r.reached, true, "第 3 次应达到阈值");
  assert.equal(r.banned, true, "第 3 次应禁言成功");
  assert.deepEqual(h.bans, [{ groupId: "123", userId: "456", seconds: 600 }], "应只禁言一次");
  assert.deepEqual(h.texts, [{ groupId: "123", text: "已被禁言" }], "应发送禁言提示");
  assert.ok(h.logs.some((l) => l.includes("reason=guard_mute")), "应记录 guard_mute 日志");

  // 清零后第 4 次重新从 1 开始
  now.t += 1000;
  r = await run();
  assert.equal(r.count, 1, "禁言后计数应清零");
  assert.equal(r.banned, false);
  console.log("ok 1 - 窗口内 3 次触发禁言并清零");
}

// 2) 窗口过期：旧命中不计入
{
  const now = { t: 2_000_000 };
  const h = harness(now);
  const run = () => applyGuardPenalty({ groupId: "123", userId: "456", policy: POLICY, deps: h.deps });

  await run();
  now.t += 1000;
  await run();
  now.t += 61_000; // 超过 60 秒窗口，前两条过期
  const r = await run();
  assert.equal(r.count, 1, "窗口过期后应从 1 重新计数");
  assert.equal(r.banned, false, "窗口过期不应触发禁言");
  assert.equal(h.bans.length, 0);
  console.log("ok 2 - 窗口过期不触发禁言");
}

// 3) 禁言失败 → 降级警告，不重试
{
  const now = { t: 3_000_000 };
  let attempts = 0;
  const h = harness(now, () => {
    attempts += 1;
    throw new Error("权限不足");
  });
  const run = () => applyGuardPenalty({ groupId: "123", userId: "456", policy: POLICY, deps: h.deps });

  await run();
  now.t += 1000;
  await run();
  now.t += 1000;
  const r = await run();
  assert.equal(r.reached, true);
  assert.equal(r.banned, false, "禁言失败不应标记为成功");
  assert.equal(r.degraded, true, "禁言失败应标记为降级");
  assert.equal(attempts, 1, "禁言失败只尝试一次，不重试");
  assert.deepEqual(h.texts, [{ groupId: "123", text: "请文明发言" }], "应发送警告文案");
  assert.ok(
    h.logs.some((l) => l.includes("reason=guard_mute_failed") && l.includes("权限不足")),
    "应记录禁言失败原因",
  );
  console.log("ok 3 - 禁言失败降级为警告且不重试");
}

// 4) 本地兜底策略字段完整
{
  const { DEFAULT_GUARD_POLICY } = await import("../dist/index.mjs");
  assert.equal(DEFAULT_GUARD_POLICY.threshold, 3);
  assert.equal(DEFAULT_GUARD_POLICY.windowSeconds, 600);
  assert.equal(DEFAULT_GUARD_POLICY.muteSeconds, 600);
  assert.ok(DEFAULT_GUARD_POLICY.muteText.length > 0);
  console.log("ok 4 - 本地兜底策略完整");
}

console.log("\nguard-penalty tests passed");
