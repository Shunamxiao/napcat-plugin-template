import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plugin_cleanup, plugin_init, pluginState } from "../dist/index.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoreply-lifecycle-"));
const configPath = path.join(dir, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  enabled: false,
  private: { enabled: false, whitelist: [], mergeWindowMs: 0 },
  group: { enabled: false, whitelist: [] },
  kbService: { enabled: false },
  guard: { enabled: false },
}));

const noop = () => {};
const field = (key, _title, value) => ({ key, value });
const ctx = {
  pluginName: "napcat-plugin-autoreply",
  pluginPath: dir,
  dataPath: path.join(dir, "data"),
  configPath,
  adapterName: "onebot11",
  logger: { info: noop, debug: noop, warn: noop, error: noop },
  actions: { call: async (action) => action === "get_login_info" ? { user_id: "10000" } : [] },
  pluginManager: { config: { self_id: "10000" } },
  router: {
    get: noop, post: noop, getNoAuth: noop, postNoAuth: noop,
    static: noop, staticOnMem: noop, page: noop,
  },
  NapCatConfig: {
    combine: (...items) => items,
    boolean: field,
    text: field,
    number: field,
    select: field,
    multiSelect: field,
    html: (value) => ({ value }),
    plainText: (value) => ({ value }),
  },
};

await plugin_init(ctx);
assert.ok(pluginState.timers.has("schema-summary"), "初始化应登记 schema-summary timeout");
assert.ok(globalThis.__napcatAutoreplyHandoffCleanupTimer, "初始化应启动 handoff cleanup interval");
await plugin_cleanup(ctx);
assert.equal(pluginState.timers.has("schema-summary"), false, "cleanup 应回收 schema timeout");
assert.equal(globalThis.__napcatAutoreplyHandoffCleanupTimer, undefined, "cleanup 应回收 handoff interval");

fs.rmSync(dir, { recursive: true, force: true });
console.log("lifecycle-cleanup tests passed");
