/**
 * 关键词统计上报自测（不连服务）
 *
 * 覆盖：
 *   1) 命中快照与规则表合并：未命中规则以 count=0 上报
 *   2) 停用规则不上报、重复 key 只出现一次
 *   3) 未配置服务地址/令牌时不发请求
 *
 * 用法：node --test test/keyword-report.mjs（先构建并复制 dist/index.mjs）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildKeywordReport, reportKeywordStatsOnce, pluginState } from "../dist/index.mjs";

test("规则表与命中快照合并：零命中规则 count=0，停用规则不报", () => {
  const config = {
    ...pluginState.config,
    keywords: [
      { match: "下载", reply: "a" },
      { match: "有", matchType: "prefix", reply: "b" },
      { match: "停用词", reply: "c", enabled: false },
    ],
    groupRules: {
      "1": { keywords: [{ match: "进群", matchType: "prefix", reply: "d" }] },
    },
  };
  const items = buildKeywordReport(config, {
    "下载|contains": { count: 3, lastAt: "2026-11-02T00:00:00.000Z" },
  });
  const keyed = Object.fromEntries(items.map((item) => [item.key, item]));

  assert.equal(keyed["下载|contains"].count, 3);
  assert.equal(keyed["有|prefix"].count, 0);
  assert.equal(keyed["有|prefix"].lastAt, "");
  assert.equal(keyed["进群|prefix"].count, 0);
  assert.equal(keyed["停用词|contains"], undefined);
  assert.equal(items.filter((item) => item.key === "下载|contains").length, 1);
});

test("未配置服务地址/令牌时不发请求", async () => {
  const prev = pluginState.config;
  pluginState.config = {
    ...prev,
    kbService: { enabled: false, baseUrl: "", token: "", timeoutMs: 1000 },
  };
  try {
    assert.equal(await reportKeywordStatsOnce(), false);
  } finally {
    pluginState.config = prev;
  }
});
