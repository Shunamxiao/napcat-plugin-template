# 契约：机器人配置集中化（bot_config）+ 页面外壳 + 身份切换

> 派发单：`/root/state/dispatch/dev-director-2026-11-02T15-22-39-994Z.md`（老板 2026-11-02 拍板）。
> 本文件是服务端 `qq-bot-service` 与插件 `napcat-plugin-autoreply` 的**唯一契约源**，两仓各存一份、内容逐字一致。
> 字段名与派发单一字不差；冲突以派发单与本文件为准，不许自行发明字段名。
> 总秘书派发单未明确「页面如何拿服务端凭据」——页面拿不到真实 `kbService.token`（NoAuth 出口必须打码，6099 对公网开放），故由开发总监裁定：**页面不直连服务端，服务端读写由插件后端代理**（见 §5）；服务端 CORS 与鉴权仍按下述实现（供 CLI/外部脚本直连）。

## 1. 服务端 `qq-bot-service`

### 1.1 存储新表（同一 SQLite 库，不迁 `data/faq.db` 既有表）

```sql
CREATE TABLE IF NOT EXISTS bot_config (
  uin TEXT PRIMARY KEY,
  nickname TEXT,
  config_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
```

### 1.2 接口

鉴权：`x-bot-token` 或 admin basic auth，与现有 `/stats/*` 一致（`x-bot-token` 对标 `botTokenOk`，basic 对标 `basicOk` + `statsReadOk`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config/bots` | 列表：`[{uin,nickname,revision,updatedAt}]` |
| GET | `/config/bots/:uin` | 单个：`{uin,nickname,config,revision}`，无记录 404 |
| PUT | `/config/bots/:uin` | body `{config, nickname?, expectedRevision?}`；`expectedRevision` 与库里不一致返回 **409** 并回当前 revision；成功 `{revision}` |
| POST | `/config/bots/:uin/import` | body `{config, nickname?}`；**仅当不存在时写入**（幂等），存在则原样返回现有 `{revision, imported:false}` |

### 1.3 语义要求

- `config_json` 原样存整份插件配置（服务端不理解插件字段，只做存储 + 版本号）。
- 写入时 `revision + 1`、更新 `updated_at`（ISO 8601 字符串）。
- **掩码**：任何返回给外部的 config 里，`kbService.token` 必须替换为 `••••••`；真值只在库里。`PUT` 收到 `••••••` 时保留库中原值（禁止把掩码写进库）。
- 首次 `import` 的 `revision` 为 1。
- `PUT` 未带 `expectedRevision` 时无条件写入（revision 仍 +1）。

### 1.4 CORS

- 允许 `Access-Control-Allow-Origin` 来自配置 `CORS_ORIGINS`（逗号分隔，默认 `http://192.168.1.204:6099,http://127.0.0.1:6099,http://127.0.0.1:6103,http://192.168.1.204:6103`）。
- 允许头 `content-type,x-bot-token,authorization`；方法 `GET,POST,PUT,OPTIONS`；`OPTIONS` 直接 **204**。
- 现有路由不要因此变宽（CORS 处理只挂在 `/config/bots*` 上）。

## 2. 插件 `napcat-plugin-autoreply`

### 2.1 启动流程

读本地 `config.json` → `POST /config/bots/<selfId>/import`（拿不到 selfId 就跳过，别崩）→ `GET /config/bots/<selfId>` 拿服务端版本 → 应用并回写本地缓存。

### 2.2 运行中同步

复用现有 300 秒定时器模式（参照 `src/core/group-config.ts` 的 TimerHost 写法，可并列新开一个），`GET /config/bots/<selfId>` 比对 `revision`，变了才应用 + 落盘 + 打日志 `[配置] 从服务端同步 revision=N`。

### 2.3 页面保存流程

先 `PUT /config/bots/<uin>`（带 `expectedRevision`），成功后再落本地；409 时提示「配置已被其他端修改，请刷新后重试」，不要覆盖。

### 2.4 `/api/status` 新增字段

| 字段 | 含义 |
|---|---|
| `selfId` | 当前实例 QQ 号 |
| `nickname` | 当前账号昵称（get_login_info，取不到回退服务端 nickname，再回退 `""`） |
| `instanceName` | 实例名（账号管理插件里按 uin 匹配的 `name`，匹配不到回退 `""`） |
| `webuiPort` | 当前实例 WebUI 端口（取不到回退 `null`） |
| `configRevision` | 当前配置 revision（本地起跑时为服务端 revision 或 0） |
| `configSource` | `server` / `local` |

### 2.5 新增 `/api/peers`

转发同进程账号管理插件的 `/plugin/napcat-plugin-account/api/instances`（取 `name/uin/webuiPort/running/isLogin` 四组字段），失败返回 `{peers:[]}`，不许抛异常。

**总监补充（2026-11-02 实测裁定）**：账号插件 `/instances` 校验 `?key=<accessKey>`（`accessKey` 是账号插件自己的配置）。转发时带上凭据：

- 插件配置新增可选字段 `accountAccessKey`（string，默认 `""`），env `QQBOT_ACCOUNT_ACCESS_KEY` 作为兜底来源；
- 转发 URL 追加 `?key=<accountAccessKey>`（有值才带）；未配置时仍裸转发（会得到空 peers，不报错）；
- `accountAccessKey` 只在插件后端使用，绝不进 `/api/*` 出口与日志。
- **端口解析（总监补充 2026-11-02）**：`/api/peers` 与 `/api/status.webuiPort` 以实例真实 WebUI 端口为准——读 configPath 上两级的 `webui.json` 的 `port`（configPath=`<workdir>/config/plugins/<plugin>/config.json`，webui.json 在 `<workdir>/config/`）；请求 Host 头端口只作回退（经 SSH 隧道访问时 Host 端口是隧道口，不能代表实例端口，转发拨号必须拨真实端口）。

### 2.6 兼容

服务端不可达时**完全按本地配置跑**（旧行为），日志一条 warn，不重试轰炸。

### 2.7 插件后端代理（总监裁定，补派发单缺口）

页面拿不到真实 `kbService.token`（`/api/config` 出口打码），因此页面**不直连**服务端，改由插件后端代理：

| 插件路由 | 鉴权 | 行为 |
|---|---|---|
| `GET /api/server-bots` | NoAuth | 代理 `GET /config/bots`，回 `{bots:[{uin,nickname,revision,updatedAt}]}`；失败回 `{bots:[]}`，不许抛异常 |
| `GET /api/server-config` | NoAuth | 代理 `GET /config/bots/<selfId>`，回 `{config,revision}`（服务端已掩码，原样透传）；失败回 `{error}` + 502 语义 |
| `POST /api/server-config` | NoAuth + 写闸门 | body `{uin, config, expectedRevision?}`；插件后端用真实 `kbService.token` 调 `PUT /config/bots/<uin>`，把 `{revision}` / 409（含当前 revision）原样回给页面 |

**2026-11-08 修订**：本条原写「必须走鉴权路由」。实际页面在 `accessControlMode=none` 时没有 NapCat 凭据，
鉴权路由不可用（59febde 回退）。现行闸门：浏览器请求必须带 `x-napcat-webui: 1` 自定义头且 `Origin`/`Host` 同端口
（自定义头触发预检，本服务不答预检 → DNS rebinding 与跨站写都被拦）；无 `Origin` 的脚本请求放行，
因此 6099 必须只对本机/隧道暴露，不得监听公网。
另：`accountAccessKey` 是宿主本地凭据，上行前替换为掩码，服务端不存真值；当前实例保存不带 `expectedRevision`
（本地 revision 要等同步才更新，带上会连改两页必吃 409）。

服务端 CORS（§1.4）仍按原样实现，页面链路不依赖它。

## 3. 前端（webui）

### 3.1 外壳

- 左侧固定导航（六个页签竖排，可折叠到图标），右侧内容区；整体 `mx-auto max-w-[1280px]`，内容区 `md:px-10`。
- 窄屏（<1024px）退回顶部标签栏，不许出现横向滚动。

### 3.2 顶栏

- 右侧常显徽标：`昵称 · QQ号 · 实例名`，悬停显示 `端口 / 配置 revision / 来源(server|local)`。
- 「账号」下拉：数据 = 服务端 bot 列表（§2.7 `GET /api/server-bots`）∪ 插件 `/api/peers`，显示 `昵称(uin)`，`running=false` 的标灰。

### 3.3 编辑非当前实例

- 切到非当前实例时，页面顶部出现醒目提示条：`正在编辑 1457278554（acc-main）的配置，该号下次同步后生效`（uin 与实例名随所选账号变）。
- 当前实例的徽标用强调色，其他号用中性色，**不允许**两态视觉相同。

### 3.4 保存按钮

- 编辑当前实例 = `保存并立即生效`；编辑其他实例 = `保存到服务端`。

## 4. 边界（两端共同）

- 不改 FAQ 检索、关键词判定、群策略语义；本次只动「配置存放位置 + 页面外壳 + 身份/切换」。
- 服务端不新增依赖；不迁 `data/faq.db`。
- 插件不改消息判定链顺序（`handlers/message-handler.ts` 只允许加日志/读新配置，不改 goto 顺序）。
- 插件不新增 npm 依赖。
- 各仓 commit 分开，message 写清迁移与回滚方式。
