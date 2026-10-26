---
name: openclaw
description: 与 OpenClaw Gateway 交互：查询 agent / 定时任务、触发 cron、chat completions、拉取任务完成通知
---

# OpenClaw Bridge — 使用指南

## 何时调用

当用户提到以下场景时，使用本技能的对应 MCP 工具：

| 用户说的 | 调用工具 |
|---|---|
| openclaw 有哪些 agent / 查看 agent 列表 | `list_openclaw_agents` |
| openclaw 的定时任务 / 某 agent 的 cron / 查看 cron job | `list_openclaw_cron_jobs` |
| 查看 cron 运行历史 / 任务执行结果 | `get_openclaw_cron_runs` |
| 立即触发某个定时任务 / 手动跑一下 cron | `run_openclaw_cron_job` |
| 让 openclaw agent 做事 / 向 agent 发消息 | `send_to_openclaw_agent` |
| 有什么新通知 / 看看任务完成没 / 查新通知 | `get_openclaw_notifications` |

## 工具用法

### list_openclaw_agents
无参数。返回 OpenClaw 所有 agent 列表。

### list_openclaw_cron_jobs
- `agentId`（可选）：按 agent 过滤。不传则返回全部。

### get_openclaw_cron_runs
- `jobId`（必填）：从 list_openclaw_cron_jobs 拿到的 id。
- `limit`（可选，默认 10）：返回多少条最近运行记录。

### run_openclaw_cron_job
- `jobId`（必填）：要触发的任务 id。触发后立即返回，结果稍后可用 get_openclaw_cron_runs 或 get_openclaw_notifications 观察。

### send_to_openclaw_agent
- `agentId`（必填）：目标 agent。
- `message`（必填）：发送的消息。
- `timeoutSec`（可选，默认 120）：等待超时秒数。
- `sessionKey`（可选）：保持会话上下文的 key。

### get_openclaw_notifications
- `limit`（可选，默认 20）：拉取上限。
- **游标自动管理**：首次调用回看全部历史事件，之后每次只拉增量。进程重启后游标持久化在插件 data/cursor.json。

## 通知机制

OpenClaw 侧 trae 插件在两个时机产生事件：
1. **cron_finished**：任意定时任务完成时（agent 正常完成、跳过、报错都会触发）
2. **trae_notify**：OpenClaw agent 在执行中主动调用 `trae_notify` 工具推送通知

事件存在 OpenClaw 侧插件目录 data/events.jsonl，MCP 按游标增量拉取。

## 连接配置

默认**本机零配置**：自动读 ~/.openclaw/openclaw.json 的 gateway URL + token。

远程连接或手动覆盖时，按优先级生效：

| 优先级 | 配置方式 |
|---|---|
| 1 | 环境变量 `OPENCLAW_GATEWAY_URL` 和 `OPENCLAW_GATEWAY_TOKEN` |
| 2 | 文件 `~/.openclaw/trae-bridge.json`（`{"gatewayUrl": "...", "gatewayToken": "..."}`） |
| 3 | 本机自动发现（读 openclaw.json） |
| 4 | 默认 `https://127.0.0.1:18789` |

自签证书的 HTTPS（localhost / 内网 IP）默认跳过 TLS 校验。可在 trae-bridge.json 设 `"tlsRejectUnauthorized": true` 收紧。

## 错误处理

| 错误表现 | 可能原因 | 用户指引 |
|---|---|---|
| "鉴权失败 (HTTP 401/403)" | gateway token 错误 | 检查 trae-bridge.json 或环境变量 |
| "无法连接 Gateway" | Gateway 未启动或 URL 错误 | `openclaw gateway status` 检查状态 |
| "chatCompletions 超时" | agent 思考时间过长 | 可增大 timeoutSec 或换个简单请求 |
