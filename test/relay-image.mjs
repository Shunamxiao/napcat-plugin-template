/**
 * relay 图片能力 / 图片格式校验 自测（假 ctx，不发真实消息）
 *
 * 覆盖 2026-11-01 派发单：
 *   1) resolveImageSource：avif 直链跳过并 warn；jpg 直链保留；base64:// 保留；本地 .avif 跳过
 *   2) /api/relay：纯文字（不回归）、纯图片、图文混合、非法格式被拒、text/image 全空报参数错误
 *
 * 用法：node test/relay-image.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginState, registerApiRoutes, resolveImageSource, sanitizeConfig } from "../dist/index.mjs";

const TOKEN = "relay-test-token";
const USER = "2622011721";
const GROUP = "928013991";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-relay-"));
const configPath = path.join(dir, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({ relay: { token: TOKEN }, atReply: true, groupRules: { [GROUP]: { enabled: true } } }),
);

const warns = [];
const outbox = [];
const routes = new Map();
const noop = () => {};
const ctx = {
  pluginName: "napcat-plugin-autoreply",
  pluginPath: dir,
  dataPath: path.join(dir, "data"),
  configPath,
  adapterName: "onebot11",
  logger: {
    info: (...args) => console.log("[info]", ...args),
    debug: noop,
    warn: (...args) => { warns.push(args.join(" ")); },
    error: (...args) => console.error("[error]", ...args),
  },
  router: {
    getNoAuth: (p, h) => routes.set("GET " + p, h),
    postNoAuth: (p, h) => routes.set("POST " + p, h),
    get: (p, h) => routes.set("GET " + p, h),
    post: (p, h) => routes.set("POST " + p, h),
    static: noop,
    staticOnMem: noop,
    page: noop,
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
await new Promise((resolve) => setTimeout(resolve, 20));
pluginState.config = sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));
registerApiRoutes(ctx);

const relay = routes.get("POST /relay");
assert.equal(typeof relay, "function", "/relay 未注册");

function makeRes() {
  const res = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function callRelay(body, token = TOKEN) {
  const res = makeRes();
  await relay({ headers: { "x-relay-token": token }, body }, res);
  return res;
}

let passed = 0;
function ok(name) {
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// ---------- resolveImageSource 格式校验 ----------

const avif = "https://cdn.apks.cc/apkscc/appinn/2026/06/19329daa74a28264f032.avif";
assert.equal(resolveImageSource(avif), null, "avif 直链应被跳过");
assert.ok(warns.some((w) => w.includes(".avif") && w.includes("QQ 不支持")), "avif 应打 warn");
ok("avif 直链被跳过且 warn");

const jpg = "https://cdn.apks.cc/a/b/photo.JPG?x=1#frag";
assert.equal(resolveImageSource(jpg), jpg, "jpg 直链应保留");
ok("jpg 直链保留（大小写/query/hash 不影响）");

const b64 = "base64://iVBORw0KGgoAAAANSUhEUg==";
assert.equal(resolveImageSource(b64), b64, "base64:// 应保留");
ok("base64:// 保留");

const localAvif = `/root/.tmp-relay-image-${process.pid}.avif`;
fs.writeFileSync(localAvif, Buffer.from([0, 0, 0, 24]));
try {
  assert.equal(resolveImageSource(localAvif), null, "本地 .avif 应被跳过");
  assert.ok(warns.some((w) => w.includes(".avif") && w.includes(localAvif)), "本地 avif 应打 warn");
  assert.equal(resolveImageSource(`file://${localAvif}`), null, "file:// 本地 .avif 应被跳过");
} finally {
  fs.unlinkSync(localAvif);
}
ok("本地 .avif 跳过（含 file://）");

// ---------- /api/relay ----------

let before = outbox.length;
let res = await callRelay({ userId: USER, text: "纯文字" });
assert.equal(res.statusCode, 200);
assert.deepEqual(res.body, { ok: true, sent: true });
assert.equal(outbox.length, before + 1);
let sent = outbox[outbox.length - 1];
assert.equal(sent.message_type, "private");
assert.equal(sent.user_id, USER);
assert.deepEqual(sent.message, [{ type: "text", data: { text: "纯文字" } }]);
ok("relay 纯文字不回归");

before = outbox.length;
res = await callRelay({ userId: USER, image: jpg });
assert.equal(res.statusCode, 200);
sent = outbox[outbox.length - 1];
assert.deepEqual(sent.message, [{ type: "image", data: { file: jpg } }]);
ok("relay 纯图片");

before = outbox.length;
res = await callRelay({ userId: USER, text: "看图", image: b64 });
assert.equal(res.statusCode, 200);
sent = outbox[outbox.length - 1];
assert.deepEqual(sent.message, [
  { type: "text", data: { text: "看图" } },
  { type: "image", data: { file: b64 } },
]);
ok("relay 图文混合（text 在前）");

before = outbox.length;
res = await callRelay({ userId: USER, groupId: GROUP, text: "群图文", image: jpg });
assert.equal(res.statusCode, 200);
sent = outbox[outbox.length - 1];
assert.equal(sent.message_type, "group");
assert.equal(sent.group_id, GROUP);
assert.equal(sent.message.length, 2);
ok("relay 群聊按 groupId 发");

before = outbox.length;
const warnsBefore = warns.length;
res = await callRelay({ userId: USER, text: "破图", image: avif });
assert.equal(res.statusCode, 400);
assert.equal(res.body.ok, false);
assert.ok(String(res.body.error).includes("图片不可用"));
assert.equal(outbox.length, before, "非法图片不应发送");
assert.ok(warns.length > warnsBefore, "非法图片应打 warn");
ok("relay 非法格式被拒");

before = outbox.length;
res = await callRelay({ userId: USER, text: "   " });
assert.equal(res.statusCode, 400);
assert.equal(res.body.error, "userId 与 (text 或 image) 不能为空");
res = await callRelay({ userId: USER });
assert.equal(res.statusCode, 400);
assert.equal(res.body.error, "userId 与 (text 或 image) 不能为空");
res = await callRelay({ text: "有文字没 userId" });
assert.equal(res.statusCode, 400);
assert.equal(res.body.error, "userId 与 (text 或 image) 不能为空");
assert.equal(outbox.length, before, "参数错误不应发送");
ok("relay text/image 全空报参数错误");

// token 行为不回归
res = await callRelay({ userId: USER, text: "x" }, "wrong-token");
assert.equal(res.statusCode, 401);
ok("relay 鉴权不回归");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
