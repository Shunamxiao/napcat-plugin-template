/**
 * 流量计数 + 未配置群默认策略自测（不连服务）
 *
 *   1) 未配置群默认只响应 @ / 引用：普通消息即使命中关键词也不回
 *   2) 流量上报 body 字段逐字一致；同一小时桶 users 去重、上报后清空
 *
 * 用法：node --test test/traffic-stats.mjs（先构建并复制 dist/index.mjs）
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitTrafficReport,
  handleMessage,
  hitLog,
  hourBucket,
  pluginState,
  recordTrafficIncoming,
  recordTrafficReply,
  recordTrafficRuleHit,
  resolveEffectiveGroupPolicy,
  resetTraffic,
  sanitizeConfig,
  snapshotTraffic,
  buildTrafficPayload,
} from "../dist/index.mjs";

const SELF = "1457278554";
const OTHER = "2622011721";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-traffic-"));
const configPath = path.join(dir, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    enabled: true,
    atOnly: false,
    cooldownSeconds: 0,
    replyDelayMinMs: 0,
    replyDelayMaxMs: 0,
    crossAccountDedup: false,
    private: { enabled: false, whitelist: [], mergeWindowMs: 0 },
    group: { enabled: true, whitelist: [] },
    fallback: { privateText: "私聊兜底", groupAtText: "全局群兜底" },
    collect: { enabled: false, questions: [] },
    relay: { token: "" },
    loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
    kbService: { enabled: false },
    aiTrigger: { private: true, groupAtOnly: true },
    keywords: [{ match: "下载", matchType: "contains", reply: "规则回复", action: "reply" }],
    // 刻意留空：未配置群必须走 groupDefault
    groupRules: {},
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
const groupEvent = (text, at, groupId = "999999") => {
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
    message_id: "traffic-" + (++messageId),
  };
};
const textOf = (params) => (params.message || []).map((seg) => seg.data?.text ?? "").join("").trim();
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

test("未配置群默认策略：at / none / atForceReply / keywordOutsideAt=false", () => {
  const policy = resolveEffectiveGroupPolicy(pluginState.config, "999999");
  assert.deepEqual(policy.mode, { value: "at", source: "default" });
  assert.deepEqual(policy.missPolicy, { value: "none", source: "default" });
  assert.deepEqual(policy.atForceReply, { value: true, source: "default" });
  assert.deepEqual(policy.keywordOutsideAt, { value: false, source: "default" });
  console.log("  999999 →", JSON.stringify(policy));
});

test("未配置群：普通消息不回，被 @ 时仍回复", async () => {
  resetTraffic();
  hitLog.clear();

  let before = outbox.length;
  await handleMessage(ctx, groupEvent("怎么下载", false));
  await wait();
  assert.equal(outbox.length, before, "未配置群非 @ 命中关键词也不应回复");

  before = outbox.length;
  await handleMessage(ctx, groupEvent("随便聊聊", false));
  await wait();
  assert.equal(outbox.length, before, "未配置群非 @ 未命中应静默");

  before = outbox.length;
  await handleMessage(ctx, groupEvent("随便问问", true));
  await wait();
  assert.equal(outbox.length, before + 1, "@ 未命中应回兜底");
  assert.equal(textOf(outbox[outbox.length - 1]), "全局群兜底");

  before = outbox.length;
  await handleMessage(ctx, groupEvent("怎么下载", true));
  await wait();
  assert.equal(outbox.length, before + 1, "@ 命中应回规则");
  assert.equal(textOf(outbox[outbox.length - 1]), "规则回复");
});

test("keywordOutsideAt=false 时 at 模式非 @ 命中关键词也不回", async () => {
  const prev = pluginState.config.groupDefault;
  pluginState.config.groupDefault = { ...prev, keywordOutsideAt: false };
  try {
    hitLog.clear();
    const before = outbox.length;
    await handleMessage(ctx, groupEvent("怎么下载", false));
    await wait();
    assert.equal(outbox.length, before, "关闭后非 @ 命中关键词不应回复");
    assert.ok(hitLog.list(10).some((e) => e.detail?.startsWith("keyword_outside_at_off")));
  } finally {
    pluginState.config.groupDefault = prev;
  }
});

test("流量计数：in / replies / ruleHits / AI / 兜底与 users 去重", async () => {
  resetTraffic();
  const fixed = new Date("2026-11-02T08:42:33.000Z");
  recordTrafficIncoming("group:123", "1001", fixed);
  recordTrafficIncoming("group:123", "1001", fixed);
  recordTrafficIncoming("group:123", "1002", fixed);
  recordTrafficRuleHit("group:123", fixed);
  recordTrafficReply("group:123", "ai", fixed);
  recordTrafficReply("group:123", "default", fixed);
  recordTrafficReply("group:123", "rule", fixed);
  recordTrafficIncoming("private", "1002", fixed);

  assert.equal(hourBucket(fixed), "2026-11-02T08:00:00.000Z");
  const items = snapshotTraffic();
  assert.deepEqual(items.find((item) => item.scope === "group:123"), {
    bucket: "2026-11-02T08:00:00.000Z",
    scope: "group:123",
    in: 3,
    replies: 3,
    ruleHits: 1,
    aiReplies: 1,
    fallbackReplies: 1,
    users: 2,
  });
  assert.equal(items.find((item) => item.scope === "private")?.users, 1);

  // 验收 6：打印实际会 POST 的 body（字段顺序与约定一致）
  const payload = buildTrafficPayload();
  console.log("  POST /stats/traffic body:", JSON.stringify(payload));

  // 上报成功后清空：同一小时桶 users 从 0 重新计数
  commitTrafficReport(items);
  assert.deepEqual(snapshotTraffic(), []);
  recordTrafficIncoming("group:123", "1001", fixed);
  assert.equal(snapshotTraffic()[0].users, 1, "上报后 users 应清空重新去重");
});

test("小时桶切分：跨小时各算一桶", () => {
  resetTraffic();
  recordTrafficIncoming("private", "1001", new Date("2026-11-02T08:59:59.000Z"));
  recordTrafficIncoming("private", "1001", new Date("2026-11-02T09:00:00.000Z"));
  const items = snapshotTraffic();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.bucket).sort(), [
    "2026-11-02T08:00:00.000Z",
    "2026-11-02T09:00:00.000Z",
  ]);
});

test("端到端：被 @ 命中关键词时 ruleHits 与 in/replies 同步累加", async () => {
  resetTraffic();
  await handleMessage(ctx, groupEvent("怎么下载", true));
  await wait();
  const item = snapshotTraffic().find((entry) => entry.scope === "group:999999");
  assert.ok(item, "应产生群 999999 的流量桶");
  assert.equal(item.in, 1);
  assert.equal(item.replies, 1);
  assert.equal(item.ruleHits, 1);
  assert.equal(item.users, 1);
  console.log("  端到端桶:", JSON.stringify(item));
});
