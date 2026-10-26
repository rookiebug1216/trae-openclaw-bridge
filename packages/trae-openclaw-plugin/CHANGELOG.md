# Changelog

本文件记录 OpenClaw for Trae 插件的版本变更。

## 0.1.0

首个版本。

### 新增

- stdio MCP server，提供 6 个工具：
  - `list_openclaw_agents`
  - `list_openclaw_cron_jobs`
  - `get_openclaw_cron_runs`
  - `run_openclaw_cron_job`
  - `send_to_openclaw_agent`
  - `get_openclaw_notifications`
- `openclaw` 技能（`skills/openclaw/SKILL.md`），供 Trae 识别 OpenClaw 相关意图
- 连接配置四级解析链：环境变量 → `~/.openclaw/trae-bridge.json` → `~/.openclaw/openclaw.json` 自动发现 → 默认回环地址
- 增量通知拉取：本地游标持久化（`data/cursor.json`），每次调用只返回新事件
- 一键安装脚本 `scripts/deploy-trae.ps1`：插件包 + 技能 + MCP 配置三处一次铺开

### 修复

- **跨进程事件序号冲突**：OpenClaw 侧的 agent session 与 Gateway 是两个进程，各自维护 `lastSeq`，并发写入 `events.jsonl` 时会出现重复 `seq`。修复方式是在分配 `seq` 前先从磁盘同步，并按 `maxSeq` 无条件刷新内存。
- **增量事件接口返回空对象**：`getEventsAfter` 改为 async 后，调用处漏了 `await`，导致解构 Promise 得到 `undefined`。已补上。
- **事件存储路径不固定**：原先路径随插件根目录浮动，多进程读不到同一份文件。已改为固定路径 `~/.openclaw/trae-bridge/events.jsonl`。

### 已知限制

- 插件不会出现在 Trae 插件市场列表中——该列表由服务端 registry 驱动，本地目录无法注册。详见 [README.md](./README.md#已知限制)。
