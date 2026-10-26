# 插件上架申请材料 — OpenClaw for Trae

本文件用于向 Trae 官方提交插件上架申请，可直接作为邮件/工单正文使用。

---

## 0. 先说需求：我们需要知道上架流程

我们已确认 Trae 的插件市场列表由服务端 registry 驱动：

```
GET /extensions/api/-/plugin/registries
GET /extensions/api/-/plugin/list?registry=trae-remote-official&...
GET /extensions/api/-/plugin/detail?plugin_id=<UUID>&registry=trae-remote-official
```

本地 `plugins/local/` 目录不参与注册——即使补齐 `.success` 凭据文件，`plugin` 来源的插件列表仍为 0（已实测）。因此需要一个服务端下发的 `marketplace_plugin_id` 与 `checksum` 才能完成安装。

**请告知：**

1. 第三方插件提交入口（开发者后台 / 仓库 / 表单）在哪里？
2. `registry` 能否自建或申请？还是必须并入 `trae-remote-official`？
3. 包的分发方式：由 Trae 托管下载（`downloadUrl`），还是提交压缩包由官方托管？
4. 是否需要开发者账号认证、签名、或企业主体资质？
5. 审核周期与联系方式？

---

## 1. 插件基本信息

| 字段 | 值 |
|---|---|
| `name` | `openclaw` |
| `version` | `0.1.0` |
| `displayName` | OpenClaw |
| `shortDescription` | OpenClaw agent 与定时任务桥接 |
| `category` | Developer Tools |
| `capabilities` | Interactive, Read, Write |
| `brandColor` | `#FF6A00` |
| `keywords` | openclaw, agent, cron, bridge |
| `license` | MIT |
| 图标 | `assets/icon.svg`（64×64，矢量） |

`defaultPrompt`：

- `openclaw 有哪些 agent？`
- `查看 openclaw main 的定时任务`
- `openclaw 有什么新通知`

---

## 2. 用途与解决的问题

OpenClaw 是一个本地优先的 AI agent 运行时，提供多个长期在线的 agent 与定时任务。用户在 OpenClaw 里跑任务时，需要频繁切回终端才能查看状态。

本插件把 OpenClaw Gateway 桥接进 Trae，让开发者**不离开 IDE** 就能：

- 查看有哪些 agent、各自用什么模型
- 查看定时任务清单、下次执行时间、最近执行结果
- 手动触发一个任务立即执行
- 直接和某个 agent 对话
- 在任务完成时收到通知（包括 agent 主动推送到 Trae 的消息）

全部通过本机回环地址通信，不经过任何第三方服务器。

---

## 3. 功能清单

插件内置一个 stdio MCP server，注册 6 个工具：

| 工具 | 参数 | 行为 | 副作用 |
|---|---|---|---|
| `list_openclaw_agents` | 无 | 列出全部 agent（id / 名称 / 模型） | 只读 |
| `list_openclaw_cron_jobs` | `agentId?` | 列出定时任务（调度、下次执行、启用状态） | 只读 |
| `get_openclaw_cron_runs` | `jobId`, `limit?`(≤50) | 查看任务执行历史（状态、摘要、耗时、错误） | 只读 |
| `run_openclaw_cron_job` | `jobId` | **立即强制触发**任务 | 写：任务真实执行 |
| `send_to_openclaw_agent` | `agentId`, `message`, `sessionKey?`, `timeoutSec?`(10–600) | 向 agent 发消息并等待回复 | 写：消耗模型额度 |
| `get_openclaw_notifications` | `limit?`(≤100) | 增量拉取任务完成 / agent 推送通知 | 只读 |

另含一个技能 `skills/openclaw/SKILL.md`，用于让模型识别 OpenClaw 相关意图。

### 涉及的 OpenClaw Gateway 接口

| 平面 | 接口 |
|---|---|
| 数据面 | `POST /api/v1/admin/rpc`（method: `agents.list` / `cron.list` / `cron.runs` / `cron.run`） |
| 聊天面 | `POST /v1/chat/completions`（`model: openclaw/<agentId>`） |
| 通知面 | `GET /api/trae/health`、`GET /api/trae/events?cursor=&limit=` |

---

## 4. 权限与安全声明

### 网络

- 仅访问用户配置的 Gateway 地址，**默认 `https://127.0.0.1:18789`**（本机回环）
- 鉴权方式：`Authorization: Bearer <token>`
- **不做任何遥测，不访问任何第三方域名**

### 本地文件

| 操作 | 路径 |
|---|---|
| 读 | `~/.openclaw/trae-bridge.json` |
| 读 | `~/.openclaw/openclaw.json` |
| 写 | `<插件根目录>/data/cursor.json`（仅通知游标） |

### 凭据处理

- Gateway token 从配置文件或环境变量读取，**不硬编码、不写入日志、不上传**
- 调试输出仅包含 `tokenPresent`（布尔）与 `tokenLength`（数字）

### TLS

OpenClaw Gateway 使用自签证书。插件设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，但该行为仅在目标主机被判定为回环/内网地址（`127.0.0.1` / `localhost` / `10.x` / `172.16-31.x` / `192.168.x`）时为默认；显式配置公网 URL 时正常校验证书。

### 子进程

无。

---

## 5. 依赖

| 包 | 用途 | 许可 |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP stdio server | MIT |

运行时要求 Node.js ≥ 18（依赖全局 `fetch`）。

---

## 6. 安装与验证步骤

供审核复现：

```powershell
# 1. 安装到本地
npm run deploy:trae

# 2. 重启 Trae

# 3. 验证 MCP：MCP 面板应出现 openclaw，且列出 6 个工具
#    日志中出现：
#    MCPServerManager#listTools Got tools: list_openclaw_agents, ...

# 4. 验证技能：技能列表应出现 openclaw
#    日志中出现：
#    {"scanSource":"local","skillId":"local:openclaw","name":"openclaw", ...}

# 5. 连通性：调用 list_openclaw_agents，应返回本机 agent 列表
```

无 OpenClaw 环境时，第 5 步会返回 `无法连接 OpenClaw Gateway` 的友好错误，属预期行为（插件不因此崩溃）。

---

## 7. 素材清单

| 素材 | 状态 | 路径 |
|---|---|---|
| 图标（64×64 SVG） | 已有 | `assets/icon.svg` |
| 插件说明 | 已有 | `README.md` |
| 版本说明 | 已有 | `CHANGELOG.md` |
| 截图 1：MCP 工具列表 | **待补** | — |
| 截图 2：任务列表查询效果 | **待补** | — |
| 截图 3：通知拉取效果 | **待补** | — |

---

## 8. 联系方式

| 项 | 值 |
|---|---|
| 开发者 | _待填写_ |
| 邮箱 | _待填写_ |
| 仓库 | _待填写_ |
| 官网 | _待填写_ |
