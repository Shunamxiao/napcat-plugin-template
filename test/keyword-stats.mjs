/**
 * 关键词命中统计 + 关键词规则全字段往返自测
 *
 * 覆盖：
 *   1) 同 key 累加、lastAt 更新；不同 matchType 分开聚合
 *   2) 节流窗口内合并落盘（注入短 interval）与手动 flush
 *   3) reset 后清空内存并写空对象
 *   4) 坏文件初始化不抛、按空表处理
 *   5) sanitizeConfig 保留 enabled:false；keywordsToText/textToKeywords 全字段往返
 *   6) 端到端：handleMessage 命中启用规则计数 +1；enabled:false 不命中不计数
 *
 * 用法：node --test test/keyword-stats.mjs（先构建并复制 dist/index.mjs）
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleMessage,
  pluginState,
  sanitizeConfig,
  initKeywordStats,
  recordKeywordHit,
  snapshotKeywordStats,
  resetKeywordStats,
  flushKeywordStats,
  shutdownKeywordStats,
  keywordsToText,
  textToKeywords,
} from "../dist/index.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempStatsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-stats-"));
  return { dir, file: path.join(dir, "keyword-stats.json") };
}

function readStats(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

test("同 key 累加并更新 lastAt，不同 matchType 分开", async () => {
  const { file } = tempStatsFile();
  initKeywordStats(file);

  recordKeywordHit({ match: "你好", matchType: "prefix" });
  const first = snapshotKeywordStats()["你好|prefix"];
  assert.equal(first.count, 1);
  assert.ok(Number.isFinite(Date.parse(first.lastAt)));

  await sleep(5);
  // match 前后空白按 trim 归一
  recordKeywordHit({ match: " 你好 ", matchType: "prefix" });
  recordKeywordHit({ match: "你好", matchType: "contains" });

  const snap = snapshotKeywordStats();
  assert.equal(snap["你好|prefix"].count, 2);
  assert.equal(snap["你好|contains"].count, 1);
  assert.ok(Date.parse(snap["你好|prefix"].lastAt) >= Date.parse(first.lastAt));

  flushKeywordStats();
  assert.deepEqual(readStats(file), snap);
});

test("节流窗口内合并落盘（注入短 interval）", async () => {
  const { file } = tempStatsFile();
  initKeywordStats(file, 40);

  recordKeywordHit({ match: "节流", matchType: "contains" });
  recordKeywordHit({ match: "节流", matchType: "contains" });
  assert.equal(fs.existsSync(file), false, "窗口未到不应落盘");

  await sleep(150);
  const onDisk = readStats(file);
  assert.equal(onDisk["节流|contains"].count, 2);
  assert.ok(onDisk["节流|contains"].lastAt);
  shutdownKeywordStats();
});

test("flush 立即落盘；reset 清内存并写空对象", () => {
  const { file } = tempStatsFile();
  initKeywordStats(file);
  recordKeywordHit({ match: "立刻", matchType: "contains" });
  flushKeywordStats();
  assert.equal(readStats(file)["立刻|contains"].count, 1);

  resetKeywordStats();
  assert.deepEqual(snapshotKeywordStats(), {});
  assert.deepEqual(readStats(file), {});

  // reset 后再记一次，从 0 开始
  recordKeywordHit({ match: "立刻", matchType: "contains" });
  assert.equal(snapshotKeywordStats()["立刻|contains"].count, 1);
  shutdownKeywordStats();
});

test("坏文件初始化不抛，按空表处理", () => {
  const { file } = tempStatsFile();
  fs.writeFileSync(file, "not-json", "utf-8");
  assert.doesNotThrow(() => initKeywordStats(file));
  assert.deepEqual(snapshotKeywordStats(), {});
  shutdownKeywordStats();
});

test("sanitizeConfig 保留 enabled:false（true 不落盘）", () => {
  const cfg = sanitizeConfig({
    keywords: [
      { match: "停用词", reply: "x", enabled: false },
      { match: "启用词", reply: "y", enabled: true },
    ],
  });
  assert.equal(cfg.keywords[0].enabled, false);
  assert.ok(!("enabled" in cfg.keywords[1]), "enabled:true 应省略");
});

test("keywordsToText/textToKeywords 对 enabled/image/aiFallback/action/regex 往返一致", () => {
  const samples = [
    { match: "普通", matchType: "contains", reply: "hi", action: "reply" },
    { match: "停用", matchType: "contains", reply: "hi", action: "reply", enabled: false },
    {
      match: "^会员$",
      matchType: "regex",
      reply: "会员回复",
      image: "https://cdn.example.com/a.png",
      aiFallback: true,
      action: "human",
    },
    { match: "问AI", matchType: "prefix", reply: "", action: "ai" },
  ];
  const text = keywordsToText(samples);
  assert.deepEqual(textToKeywords(text), samples);

  // 无文案且非 action=ai 的行丢弃；第 7 段 off 生效；action=ai 允许空回复
  assert.equal(textToKeywords("a|contains|").length, 0);
  assert.equal(textToKeywords("a|contains||||ai")[0].action, "ai");
  assert.equal(textToKeywords("a|contains|b||||off")[0].enabled, false);
});

test("端到端：启用规则命中计数，enabled:false 不命中不计数", async () => {
  const { dir, file } = tempStatsFile();
  const configPath = path.join(dir, "config.json");
  const config = {
    enabled: true,
    cooldownSeconds: 0,
    replyDelayMinMs: 0,
    replyDelayMaxMs: 0,
    crossAccountDedup: false,
    private: { enabled: true, whitelist: [], mergeWindowMs: 0 },
    group: { enabled: false, whitelist: [] },
    fallback: { privateText: "私聊兜底", groupAtText: "群兜底" },
    collect: { enabled: false, questions: [] },
    relay: { token: "" },
    kbService: { enabled: false },
    aiTrigger: { private: false, groupAtOnly: true },
    loopGuard: { maxReplies: 100, windowSeconds: 60, pauseSeconds: 300 },
    groupRules: {},
    keywords: [{ match: "统计词", matchType: "contains", reply: "命中", action: "reply" }],
  };
  fs.writeFileSync(configPath, JSON.stringify(config));

  const outbox = [];
  const ctx = {
    pluginName: "napcat-plugin-autoreply",
    pluginPath: dir,
    dataPath: path.join(dir, "data"),
    configPath,
    adapterName: "onebot11",
    logger: {
      info: (...args) => console.log("[info]", ...args),
      debug: () => {},
      warn: (...args) => console.warn("[warn]", ...args),
      error: (...args) => console.error("[error]", ...args),
    },
    actions: {
      call: async (action, params) => {
        if (action === "get_login_info") return { user_id: "1457278554" };
        if (action === "send_msg") {
          outbox.push(params);
          return { message_id: outbox.length };
        }
        return {};
      },
    },
    pluginManager: { config: { self_id: "1457278554" } },
  };

  pluginState.init(ctx);
  await sleep(20);
  pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));
  pluginState.config.replyDelayMinMs = 0;
  pluginState.config.replyDelayMaxMs = 0;
  initKeywordStats(file, 40);

  let seq = 0;
  const privateEvent = (text) => ({
    post_type: "message",
    message_type: "private",
    user_id: 2622011721,
    sender: { user_id: 2622011721 },
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    message_id: "stats-" + (++seq),
  });

  await handleMessage(ctx, privateEvent("来个统计词"));
  await sleep(20);
  assert.equal(snapshotKeywordStats()["统计词|contains"].count, 1);
  assert.equal(outbox.length, 1, "启用规则应正常回复");

  // 停用后同一条规则不再命中，也不再计数
  pluginState.config.keywords[0].enabled = false;
  await handleMessage(ctx, privateEvent("再来个统计词"));
  await sleep(20);
  assert.equal(snapshotKeywordStats()["统计词|contains"].count, 1, "停用规则不应计数");

  shutdownKeywordStats();
});
