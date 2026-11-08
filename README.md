# QQ 自动回复（NapCat 插件）

`napcat-plugin-autoreply` 是一个 NapCat / OneBot 11 自动回复插件。它处理私聊、群聊关键词、知识库兜底、群内容守卫、转人工留档和 WebUI 配置。

## 主要能力

### 私聊

- 新安装默认关闭私聊自动回复；在 WebUI 的“私聊与关键词”页开启。
- 支持 QQ 白名单。白名单为空时对所有私聊生效。
- 支持把同一用户短时间内的连续消息合并处理，默认窗口为 3 秒，最多 5 条。
- 关键词、知识库和 AI 都没有结果时使用 `fallback.privateText`。
- 老配置的 `private.defaultReply` 仅在读取时迁移到 `fallback.privateText`，保存时不再写旧字段。
- 可选首条引导 `private.guide`：`enabled` 开关、`text` 引导文案（保存时 trim，空文本等同不引导）、`windowSeconds` 窗口秒数（默认 1800；小于等于 0 表示每条消息都引导）。引导命中时只发文案，不进入关键词、FAQ 或 AI，也不消耗关键词冷却与服务配额；同一用户在窗口内只引导一次，窗口外再次引导。

私聊判定顺序（`src/handlers/message-handler.ts`）：忽略/黑名单 → 服务侧拉黑 → 自回声 → 私聊开关 → 白名单 → 连发合并 → 转人工追问 → 首条引导 → 关键词 → FAQ/AI → 兜底。

### 群聊

每个群的策略按以下优先级解析：

1. 服务端群配置；
2. 本地 `groupRules`；
3. `groupDefault`。

未配置群默认只处理 @ 机器人或引用机器人消息。普通群消息即使命中关键词也不回复。

群模式：

|模式|行为|
|---|---|
|`off`|一律不回复|
|`at`|仅处理 @、引用，或显式允许的非 @ 关键词命中|
|`all`|处理所有消息|

未命中策略：

|策略|行为|
|---|---|
|`ai_then_fallback`|先请求知识库服务，无答案或失败时发兜底|
|`fallback_only`|不请求服务，直接发兜底|
|`none`|保持沉默；被 @ 且 `atForceReply=true` 时仍可发兜底|

已配置群继续兼容旧的 `enabled`、`atOnly`、`aiEnabled` 字段。

### 关键词和转人工

关键词支持 `prefix`、`contains`、`regex` 三种匹配方式，以及文本回复池和 JPG、PNG、WebP、GIF 图片。规则动作：

|动作|行为|
|---|---|
|`reply`|发送规则话术|
|`ai`|直接请求知识库服务，失败时回落到规则话术|
|`human`|按配置追问后转人工，或直接发送兜底并留档|

转人工记录写入插件数据目录的 `handoff.jsonl`。插件启动时及之后每 24 小时原子清理 30 天前的合法记录；30 天内记录和无法解析的行保留。

### 防护和观测

- 群内容守卫支持本地词表与服务端词表叠加，可撤回、警告或两者同时执行。
- 内容守卫和入站流量统计独立于自动回复总开关。关闭自动回复后，守卫仍会执行，入站仍会计数。
- 支持发送失败熔断、群回复对刷熔断、规则冷却、发送者忽略名单和黑名单。
- 命中日志只存内存，最多 200 条；读取和写入都会排除 30 天前记录。
- 关键词计数和流量统计按既有服务接口定时上报。未配置服务时只保留本地行为。

## WebUI

NapCat 设置页和仪表盘使用同一套 React WebUI（单文件产物，hash 路由 `#/页面`）：

| 页面 | 管什么 |
|---|---|
| 概览 `#/overview` | 实例状态、今日处理量、近 7 天流量、Top 关键词、最近命中 |
| 命中日志 `#/logs` | 最近 200 条记录，按渠道/结果筛选、搜索、导出 CSV |
| 回复规则 `#/reply` | 总开关、冷却与延迟、关键词全字段（正则/图片/回复池/动作/AI）、兜底文案、转人工追问 |
| 私聊 `#/private` | 私聊开关、白名单、连发合并、首条引导、是否升级 AI |
| 群规则 `#/groups` | 未配置群默认策略；逐群模式/未命中策略/欢迎语；搜索、批量改、导入导出 JSON |
| 内容守卫 `#/guard` | 屏蔽词、命中动作（撤回/警告/禁言）与处罚阈值 |
| 安全与风控 `#/safety` | 黑名单、忽略发送者、多账号去重、发送熔断、对刷熔断、好友申请 |
| 服务与运维 `#/service` | 知识库/AI 服务与令牌、回流令牌、同步状态、配置快照（创建/回滚/删除） |

页面只提交自己负责的字段（按块合并），令牌以 `****` 打码往返，不会把真实令牌写进页面或覆盖成空。

旧页面（基础回复 / 私聊与关键词 / 群规则旧版）已删除，等价功能分别落在上表的回复规则、私聊、群规则页。

管理写接口使用 NapCat WebUI 登录鉴权：

|方法|路径|用途|
|---|---|---|
|POST|`/api/Plugin/ext/napcat-plugin-autoreply/server-config`|保存指定账号配置|
|POST|`/api/Plugin/ext/napcat-plugin-autoreply/config`|保存当前实例配置|
|POST|`/api/Plugin/ext/napcat-plugin-autoreply/keyword-stats/reset`|重置关键词统计|
|POST|`/api/Plugin/ext/napcat-plugin-autoreply/groups/:id`|保存群配置|
|POST|`/api/Plugin/ext/napcat-plugin-autoreply/guard-policy`|保存守卫处罚策略|

只读 WebUI 接口位于 `/plugin/napcat-plugin-autoreply/api/`。

机器回调 `POST /plugin/napcat-plugin-autoreply/api/relay` 不使用 NapCat 登录鉴权。它要求独立的 `x-relay-token` 请求头；`relay.token` 为空、缺失或不匹配时拒绝请求。该接口支持向私聊或群聊发送文本、图片或图文消息。

## 服务配置

知识库服务配置位于 `kbService`：

- `enabled`：是否启用服务请求；
- `baseUrl`：服务地址；
- `token`：发送为 `x-bot-token`，WebUI 响应会打码；
- `timeoutMs`：请求超时。

群配置和守卫处罚策略写入服务端管理接口时，插件从以下位置读取 Basic 凭据：

1. `QQBOT_ADMIN_USER` / `QQBOT_ADMIN_PASSWORD`；
2. `ADMIN_USER` / `ADMIN_PASSWORD`；
3. `QQBOT_ADMIN_ENV_FILE` 指定的 env 文件。

账号列表转发可读取 `QQBOT_ACCOUNT_ACCESS_KEY`。不要把 token、密码或真实 env 文件提交到仓库。

## 开发

要求 Node.js、pnpm，以及仓库现有依赖。

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test                # vite build 后逐个执行 test/*.mjs，任一失败即退出
```

`pnpm build` 使用 Vite 生成：

```text
dist/
├── index.mjs
├── package.json
└── webui/
    └── index.html
```

WebUI 单独开发：

```bash
pnpm run dev:webui
```

插件后端 watch 构建：

```bash
pnpm run watch
```

## 代码结构

```text
src/
├── index.ts                 生命周期、路由和页面注册
├── config.ts                默认配置和 NapCat 配置 Schema
├── types.ts                 后端配置与服务类型
├── core/                    策略、状态、统计、守卫和留档
├── handlers/                消息与事件处理
├── services/                WebUI API、知识库和管理端客户端
└── webui/src/               React WebUI
```

插件卸载时会停止同步、上报和清理定时器，取消待发送回复与追问会话，并保存当前配置。

## 许可证

MIT
