/**
 * 群回复模式真值表 + 老配置兼容映射
 *
 * 覆盖派发单要求的 5 条：
 *   1) off 一律不回（含 @）
 *   2) all 命中关键词按规则回
 *   3) at 非 @ 不回
 *   4) at @ 未命中且 atForceReply → 回兜底
 *   5) 老配置 enabled/atOnly/aiEnabled → mode/missPolicy 映射正确
 *
 * 用法：node test/policy.mjs（先 pnpm build，测试跑 dist/index.mjs）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyServerGroupEntry,
  handleMessage,
  hitLog,
  legacyGroupMode,
  legacyMissPolicy,
  pluginState,
  resolveEffectiveGroupPolicy,
  resolveGroupPolicy,
  sanitizeConfig,
} from "../dist/index.mjs";

const SELF = "1457278554";
const OTHER = "2622011721";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-policy-"));
const configPath = path.join(dir, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    enabled: true,
    atOnly: false,
    cooldownSeconds: 0,
    replyDelayMinMs: 0,
    replyDelayMaxMs: 0,
    private: { enabled: false, whitelist: [], mergeWindowMs: 0 },
    group: { enabled: true, whitelist: [] },
    fallback: { privateText: "私聊兜底", groupAtText: "全局群兜底" },
    collect: { enabled: false, questions: [] },
    relay: { token: "" },
    loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
    kbService: { enabled: false },
    aiTrigger: { private: true, groupAtOnly: true },
    keywords: [{ match: "下载", matchType: "contains", reply: "规则回复", action: "reply" }],
    groupRules: {
      // 1) 关闭
      "100000001": { enabled: false, atOnly: true, aiEnabled: true },
      // 2) 响应所有消息，未命中只回兜底（不调服务）
      "100000002": { enabled: true, atOnly: false, aiEnabled: false },
      // 3) 仅 @
      "100000003": { enabled: true, atOnly: true, aiEnabled: false },
      // 5) 老配置兼容映射用例
      "100000004": { enabled: true, atOnly: false, aiEnabled: true },
      "100000005": { enabled: true, atOnly: true, aiEnabled: false },
    },
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
    info: () => {},
    debug: () => {},
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
const groupEvent = (text, at, groupId) => {
  const message = at
    ? [{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: " " + text } }]
    : [{ type: "text", data: { text } }];
  return {
    post_type: "message",
    message_type: "group",
    group_id: Number(groupId),
    user_id: Number(OTHER),
    sender: { user_id: Number(OTHER) },
    message,
    raw_message: at ? "[CQ:at,qq=" + SELF + "] " + text : text,
    message_id: RUN + "-policy-" + (++messageId),
  };
};
const textOf = (params) => (params.message || []).map((seg) => seg.data?.text ?? "").join("").trim();
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

/** 造一条新服务端的完整条目（老字段由 mode/missPolicy 反推） */
function serverEntry(groupId, mode, missPolicy, extra = {}) {
  return {
    groupId,
    mode,
    missPolicy,
    enabled: mode !== "off",
    atOnly: mode === "at",
    aiEnabled: missPolicy === "ai_then_fallback",
    welcomeEnabled: false,
    welcomeTemplate: null,
    atForceReply: true,
    keywordOutsideAt: true,
    cooldownSeconds: null,
    fallbackText: null,
    ...extra,
  };
}

// 1) off 一律不回（含 @、含命中关键词）
hitLog.clear();
let before = outbox.length;
await handleMessage(ctx, groupEvent("怎么下载", true, "100000001"));
await wait();
assert.equal(outbox.length, before, "mode=off 不应回复");
assert.ok(hitLog.list(10).some((e) => e.detail?.startsWith("mode_off")), "mode_off 要进命中日志");
console.log("ok 1 - off：含 @ 也不回，命中日志 reason=mode_off");

// 2) all：非 @ 命中关键词按规则回
hitLog.clear();
before = outbox.length;
await handleMessage(ctx, groupEvent("怎么下载", false, "100000002"));
await wait();
assert.equal(outbox.length, before + 1, "mode=all 非 @ 命中规则应回复");
assert.equal(textOf(outbox[outbox.length - 1]), "规则回复");
console.log("ok 2 - all：非 @ 命中关键词按规则回");

// 2b) all：非 @ 未命中 → fallback_only 直接回兜底
before = outbox.length;
await handleMessage(ctx, groupEvent("随便聊聊", false, "100000002"));
await wait();
assert.equal(outbox.length, before + 1, "mode=all + fallback_only 未命中应回兜底");
assert.equal(textOf(outbox[outbox.length - 1]), "全局群兜底");
console.log("ok 2b - all + fallback_only：非 @ 未命中回兜底");

// 3) 已配置群显式沿用 keywordOutsideAt=true：非 @ 命中关键词仍回复
hitLog.clear();
before = outbox.length;
await handleMessage(ctx, groupEvent("怎么下载", false, "100000003"));
await wait();
assert.equal(outbox.length, before + 1, "已配置群 keywordOutsideAt=true 时非 @ 命中关键词应回复");
assert.equal(textOf(outbox[outbox.length - 1]), "规则回复");
console.log("ok 3 - 已配置群显式 keywordOutsideAt=true 时非 @ 命中关键词回复");

// 3b) at：非 @ 未命中 → 静默
before = outbox.length;
await handleMessage(ctx, groupEvent("随便聊聊", false, "100000003"));
await wait();
assert.equal(outbox.length, before, "mode=at 非 @ 未命中不应回复");
assert.ok(hitLog.list(10).some((e) => e.detail?.startsWith("not_at")), "not_at 要进命中日志");
console.log("ok 3b - at：非 @ 未命中静默，命中日志 reason=not_at");

// 4) at + @ 未命中 + missPolicy=none + atForceReply=true → 回兜底
applyServerGroupEntry(serverEntry("100000004", "at", "none", { atForceReply: true }));
before = outbox.length;
await handleMessage(ctx, groupEvent("随便问问", true, "100000004"));
await wait();
assert.equal(outbox.length, before + 1, "atForceReply 应回兜底");
assert.equal(textOf(outbox[outbox.length - 1]), "全局群兜底");
console.log("ok 4 - at + @ 未命中 + none + atForceReply：回兜底");

// 4b) atForceReply=false 时同样条件保持沉默
applyServerGroupEntry(serverEntry("100000006", "at", "none", { atForceReply: false }));
before = outbox.length;
await handleMessage(ctx, groupEvent("随便问问", true, "100000006"));
await wait();
assert.equal(outbox.length, before, "atForceReply=false 不应回");
console.log("ok 4b - atForceReply=false：@ 未命中保持沉默");

// 4c) all + keywordOutsideAt=false：非 @ 命中关键词也不回
applyServerGroupEntry(serverEntry("100000007", "all", "fallback_only", { keywordOutsideAt: false }));
hitLog.clear();
before = outbox.length;
await handleMessage(ctx, groupEvent("怎么下载", false, "100000007"));
await wait();
assert.equal(outbox.length, before, "keywordOutsideAt=false 时非 @ 命中关键词不应回");
assert.ok(
  hitLog.list(10).some((e) => e.detail?.startsWith("keyword_outside_at_off")),
  "keyword_outside_at_off 要进命中日志",
);
console.log("ok 4c - all + keywordOutsideAt=false：非 @ 命中关键词不回");

// 4d) 群级兜底文案覆盖全局
applyServerGroupEntry(serverEntry("100000008", "at", "none", { fallbackText: "本群专属兜底" }));
before = outbox.length;
await handleMessage(ctx, groupEvent("随便问问", true, "100000008"));
await wait();
assert.equal(textOf(outbox[outbox.length - 1]), "本群专属兜底");
console.log("ok 4d - 群级 fallbackText 覆盖全局兜底");

// 5) 老配置 enabled/atOnly/aiEnabled → mode/missPolicy 映射
const cfg = pluginState.config;
const p4 = resolveGroupPolicy(cfg, "100000004");
assert.deepEqual(p4.mode, { value: "all", source: "group" });
assert.deepEqual(p4.missPolicy, { value: "ai_then_fallback", source: "group" });
assert.deepEqual(p4.atForceReply, { value: true, source: "global" });
assert.deepEqual(p4.keywordOutsideAt, { value: true, source: "global" });
const p5 = resolveGroupPolicy(cfg, "100000005");
assert.deepEqual(p5.mode, { value: "at", source: "group" });
assert.deepEqual(p5.missPolicy, { value: "fallback_only", source: "group" });
const p1 = resolveGroupPolicy(cfg, "100000001");
assert.deepEqual(p1.mode, { value: "off", source: "group" });
console.log("ok 5 - 老配置映射：enabled/atOnly → mode，aiEnabled → missPolicy");

// 5b) 老服务端条目（只有旧字段）也要就地映射
applyServerGroupEntry({
  groupId: "100000009",
  enabled: true,
  atOnly: true,
  aiEnabled: true,
  welcomeEnabled: false,
  welcomeTemplate: null,
});
const oldServer = resolveEffectiveGroupPolicy(cfg, "100000009");
assert.deepEqual(oldServer.mode, { value: "at", source: "server" });
assert.deepEqual(oldServer.missPolicy, { value: "ai_then_fallback", source: "server" });
console.log("ok 5b - 老服务端条目按旧字段映射成 mode=at / missPolicy=ai_then_fallback");

// ==================== 真实群兼容映射（不需要连设备） ====================
// 设备 mi8 acc-main 的本地 groupRules（2026-11-02 读取，只看策略字段）
const REAL_LOCAL_RULES = {
  "480563774": { enabled: false, atOnly: true, aiEnabled: false },
  "597649304": { enabled: false, atOnly: false, aiEnabled: false },
  "928013991": { enabled: false, atOnly: true, aiEnabled: true },
};
const realCfg = sanitizeConfig({
  group: { enabled: true, whitelist: [] },
  atOnly: false,
  groupRules: REAL_LOCAL_RULES,
});
console.log("\n真实群（本地老配置 → resolveGroupPolicy）：");
for (const groupId of ["480563774", "597649304", "928013991", "301579762"]) {
  const p = resolveGroupPolicy(realCfg, groupId);
  console.log(
    `  ${groupId}: mode=${p.mode.value}(${p.mode.source}) ` +
    `missPolicy=${p.missPolicy.value}(${p.missPolicy.source})`,
  );
}
// 301579762 不在本地 groupRules：走全局默认（enabled=true, atOnly=false → all）
assert.equal(resolveGroupPolicy(realCfg, "301579762").mode.value, "all");
assert.equal(resolveGroupPolicy(realCfg, "480563774").mode.value, "off");
assert.equal(resolveGroupPolicy(realCfg, "928013991").mode.value, "off");

// 服务端迁移前的老字段（2026-11-02 实测值）→ 新口径，应与迁移后一致
const LEGACY_SERVER_ROWS = [
  ["301579762", false, false, false, "off", "fallback_only"],
  ["480563774", true, true, true, "at", "ai_then_fallback"],
  ["597649304", true, false, true, "all", "ai_then_fallback"],
  ["928013991", true, false, true, "all", "ai_then_fallback"],
];
console.log("\n真实群（服务端老字段 → 新口径）：");
for (const [groupId, enabled, atOnly, aiEnabled, wantMode, wantMiss] of LEGACY_SERVER_ROWS) {
  const mode = legacyGroupMode(enabled, atOnly);
  const miss = legacyMissPolicy(aiEnabled);
  console.log(`  ${groupId}: enabled=${enabled} atOnly=${atOnly} aiEnabled=${aiEnabled} → mode=${mode} missPolicy=${miss}`);
  assert.equal(mode, wantMode, groupId + " mode 映射");
  assert.equal(miss, wantMiss, groupId + " missPolicy 映射");
}

console.log("\npolicy tests passed");
