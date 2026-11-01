/**
 * 群级入群欢迎纯逻辑自测（不连服务、不发消息）
 *
 * 覆盖：
 *   1) 群级关闭 > 全局开启
 *   2) 群级模板覆盖全局模板
 *   3) null/缺省跟随全局
 *   4) 全局关、群级单独开
 *   5) sanitize 保留 welcome 字段、旧配置兼容、非法值丢弃
 *
 * 用法：node test/welcome.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import { resolveWelcome, sanitizeConfig } from "../dist/index.mjs";

const GLOBAL_ON = { enabled: true, template: "全局欢迎 {user_id}" };
const GLOBAL_OFF = { enabled: false, template: "全局欢迎 {user_id}" };

// 1) 群级关闭优先于全局开启
assert.deepEqual(
    resolveWelcome({ enabled: false, template: null }, GLOBAL_ON),
    { enabled: false, template: "全局欢迎 {user_id}" },
);

// 2) 群级模板覆盖全局模板
assert.deepEqual(
    resolveWelcome({ enabled: null, template: "本群欢迎 {user_id}" }, GLOBAL_ON),
    { enabled: true, template: "本群欢迎 {user_id}" },
);

// 3) null / 缺省跟随全局
assert.deepEqual(
    resolveWelcome({ enabled: null, template: null }, GLOBAL_ON),
    { enabled: true, template: "全局欢迎 {user_id}" },
);
assert.deepEqual(
    resolveWelcome(undefined, GLOBAL_ON),
    { enabled: true, template: "全局欢迎 {user_id}" },
);

// 4) 全局关、群级单独开（模板回落到全局）
assert.deepEqual(
    resolveWelcome({ enabled: true, template: null }, GLOBAL_OFF),
    { enabled: true, template: "全局欢迎 {user_id}" },
);

// 5) 群级空模板视为跟随全局
assert.deepEqual(
    resolveWelcome({ enabled: true, template: "   " }, GLOBAL_ON),
    { enabled: true, template: "全局欢迎 {user_id}" },
);

// 6) sanitize 保留 welcome，并写回 groupRulesText
const cfg = sanitizeConfig({ groupRules: { "123": { enabled: true, welcome: { enabled: false, template: "群欢迎 {user_id}" } } } });
assert.equal(cfg.groupRules["123"].welcome.enabled, false);
assert.equal(cfg.groupRules["123"].welcome.template, "群欢迎 {user_id}");
assert.ok(cfg.groupRulesText.includes('"welcome"'), "groupRulesText 应包含 welcome");

// 7) 显式 null 保留（表示跟随全局）
const cfgNull = sanitizeConfig({ groupRules: { "9": { welcome: { enabled: null, template: null } } } });
assert.equal(cfgNull.groupRules["9"].welcome.enabled, null);
assert.equal(cfgNull.groupRules["9"].welcome.template, null);

// 8) 旧配置无 welcome：兼容，不新增字段
const legacy = sanitizeConfig({ groupRules: { "7": { enabled: false, atOnly: true } } });
assert.equal(legacy.groupRules["7"].welcome, undefined);
assert.equal(legacy.groupRules["7"].enabled, false);
assert.equal(legacy.groupRules["7"].atOnly, true);

// 9) 非法值丢弃
const bad = sanitizeConfig({ groupRules: { "8": { welcome: { enabled: "yes", template: 42 } } } });
assert.equal(bad.groupRules["8"].welcome, undefined);

console.log("welcome tests passed");
