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

- **安全：TLS 证书校验策略失效**：部署脚本与 plugin.json 写入的 `NODE_TLS_REJECT_UNAUTHORIZED=0` 是进程级开关，会关闭 MCP 进程对**所有**地址的证书校验，配置项形同虚设。现改为由客户端按目标地址收敛：环回地址默认跳过（本机自签可用），内网地址需显式配置 `tlsRejectUnauthorized:false`，公网/远程一律强制校验，并主动清除遗留的环境变量。
- **安全：https→http 明文降级**：原先 https 请求失败时无条件降级 http 重试，会把 Bearer token 明文发到网络上；非幂等 POST 还可能被重复执行。现仅环回地址允许降级，且被超时中断的请求不再重试。
- **安全：`send_to_openclaw_agent` 超时失效**：`AbortController` 已创建但 signal 未传入 fetch，`timeoutSec` 参数形同虚设，请求可无限挂起。已修复，超时精确中断。
- **跨进程事件序号冲突**：OpenClaw 侧的 agent session 与 Gateway 是两个进程，各自维护 `lastSeq`，并发写入 `events.jsonl` 时会出现重复 `seq`。修复方式是在分配 `seq` 前先从磁盘同步，并按 `maxSeq` 无条件刷新内存。
- **增量事件接口返回空对象**：`getEventsAfter` 改为 async 后，调用处漏了 `await`，导致解构 Promise 得到 `undefined`。已补上。
- **事件存储路径不固定**：原先路径随插件根目录浮动，多进程读不到同一份文件。已改为固定路径 `~/.openclaw/trae-bridge/events.jsonl`。
- **部署脚本中文注释解析错误**：无 BOM 的 UTF-8 脚本被 PowerShell 5.1 按 GBK 解码时，注释行尾字节可能吞掉换行符导致语法错误。已给 `deploy-trae.ps1` / `deploy-openclaw.ps1` 加 UTF-8 BOM。

### 已知限制

- 插件不会出现在 Trae 插件市场列表中——该列表由服务端 registry 驱动，本地目录无法注册。详见 [README.md](./README.md#已知限制)。
