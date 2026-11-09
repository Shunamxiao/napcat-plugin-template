/**
 * 写接口同源闸门自测（不连服务）
 *
 * 覆盖 2026-11-09 线上故障：局域网 IP 直连（192.168.1.204:6099）保存插件配置报「跨站写入被拒绝」。
 * 闸门改为按 Sec-Fetch-Site 判定，且 same-origin 时要求 Host 是 IP/localhost（挡 DNS rebinding）。
 *
 * 用法：node test/from-same-origin.mjs（先 pnpm build）
 */

import assert from "node:assert/strict";
import { fromSameOrigin } from "../dist/index.mjs";

const check = (name, headers, expected) => {
    const got = fromSameOrigin({ headers });
    assert.equal(got, expected, `${name}: 期望 ${expected}，实得 ${got}`);
};

// 脚本 / curl：没有 Origin，放行
check("无 Origin", {}, true);
check("空 Origin", { origin: "" }, true);

// 局域网 IP 直连：浏览器标 same-origin，Host 是 IP → 放行（本次故障场景）
check(
    "局域网 IP 同源保存",
    { origin: "http://192.168.1.204:6099", host: "192.168.1.204:6099", "sec-fetch-site": "same-origin" },
    true,
);
check("localhost 同源", { origin: "http://localhost:6099", host: "localhost:6099", "sec-fetch-site": "same-origin" }, true);
check(
    "IPv6 回环同源",
    { origin: "http://[::1]:6099", host: "[::1]:6099", "sec-fetch-site": "same-origin" },
    true,
);

// 跨站写：一律拒绝，与 marker 头无关
check(
    "cross-site 拒绝",
    { origin: "http://evil.example", host: "192.168.1.204:6099", "sec-fetch-site": "cross-site" },
    false,
);
check(
    "same-site 拒绝",
    { origin: "http://a.evil.example", host: "192.168.1.204:6099", "sec-fetch-site": "same-site" },
    false,
);

// DNS rebinding：攻击者域名解析到本机，Sec-Fetch-Site 是 same-origin，但 Host 是域名 → 拒绝
check(
    "rebinding 域名拒绝",
    { origin: "http://evil.example:6099", host: "evil.example:6099", "sec-fetch-site": "same-origin" },
    false,
);

// 老浏览器没有 Sec-Fetch-Site：退回 Origin/Host 比对
check("无 Sec-Fetch 但同源", { origin: "http://192.168.1.204:6099", host: "192.168.1.204:6099" }, true);
check("无 Sec-Fetch 且不同源", { origin: "http://evil.example", host: "192.168.1.204:6099" }, false);

console.log("fromSameOrigin: 9 项通过");
