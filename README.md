# Trae ⇄ OpenClaw Bridge

让 **Trae IDE** 与 **OpenClaw** 双向互通的桥接项目：

- **下行**：在 Trae 里直接列出 OpenClaw agent、查/触发定时任务、与 agent 对话
- **上行**：OpenClaw 的任务完成事件主动回流到 Trae（cron 结束、agent 主动推送通知）

## 架构

```
┌─────────────────────────┐                    ┌──────────────────────────┐
│       Trae IDE          │                    │        OpenClaw          │
│                         │                    │                          │
│  openclaw (MCP server)  │   HTTP + Bearer    │  Gateway  :18789         │
│   6 个工具 ─────────────┼───────────────────▶│   ├ /api/v1/admin/rpc    │
│                         │◀───────────────────┼── ├ /v1/chat/completions  │
│  openclaw (skill)       │   事件增量拉取      │   └ /api/trae/events     │
│  (调用时机说明)          │                    │                          │
│                         │                    │  trae plugin             │
│                         │                    │   ├ cron 钩子            │
│                         │                    │   └ trae_notify 工具     │
└─────────────────────────┘                    └──────────────────────────┘
```

## 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| Windows | — | 安装脚本为 PowerShell |
| Node.js | ≥ 18 | MCP server 运行时 |
| OpenClaw | 已安装并运行 | 需要 Gateway 在监听 |
| Trae IDE / Trae CN | 3.4.x+ | MCP 与技能支持 |

## 安装

```powershell
git clone https://github.com/rookiebug1216/trae-openclaw-bridge.git trae-openclaw
cd trae-openclaw

npm run deploy:openclaw   # 部署 OpenClaw 侧插件
npm run deploy:trae       # 部署 Trae 侧插件 + 技能 + MCP
```

然后**重启 Trae IDE**（MCP 配置变更需重启生效）。

### `deploy:openclaw` 会做什么

1. 复制插件到 `~/.openclaw/extensions/trae/`
2. **备份** `~/.openclaw/openclaw.json`（形如 `openclaw.json.bak-trae-bridge-<时间戳>`）
3. 开启 `trae` / `admin-http-rpc` 插件
4. 把 `trae` **追加**进 `plugins.allow`（先读取你现有列表再追加，不会覆盖其它插件；该字段未配置时跳过）
5. 开启 `gateway.http.endpoints.chatCompletions`
6. 重启 Gateway 并等待就绪
7. 跑一次 `scripts/probe4.mjs` 自检

任何一步失败都会中断且不继续，已备份的 `openclaw.json` 可手工还原。

### `deploy:trae` 会做什么

| 目标 | 路径 |
|---|---|
| 插件包 | `~/.trae-cn/plugins/local/openclaw/<version>/` |
| 技能 | `~/.trae-cn/skills/openclaw/` |
| MCP server | `~/.trae-cn/mcp.json` 与 `%APPDATA%\Trae CN\User\mcp.json`（**合并写入**，保留其它 server） |

技能目录是 Trae 真实扫描的本地通道；MCP 采用显式挂载，因为本地安装的插件不会被市场 registry 登记。

## 验证

```powershell
node scripts/probe4.mjs
```

预期输出：

```
OpenClaw Gateway probe
  url:       https://127.0.0.1:18789
  token:     present (48 chars)
  [OK]   plane 3  GET  /api/trae/health -- {"ok":true,...}
  [OK]   plane 1  RPC  agents.list -- 5 agent(s)
  [OK]   plane 1  RPC  cron.list -- 12 cron job(s)
  [OK]   plane 3  GET  /api/trae/events -- 1 event(s), nextCursor=1
All 4 probes passed.
```

## 提供的工具

| 工具 | 作用 | 副作用 |
|---|---|---|
| `list_openclaw_agents` | 列出所有 agent | 无 |
| `list_openclaw_cron_jobs` | 列出定时任务（可按 agent 过滤） | 无 |
| `get_openclaw_cron_runs` | 查看某任务最近运行记录 | 无 |
| `run_openclaw_cron_job` | **立即触发**一个定时任务 | 有（会真实执行） |
| `send_to_openclaw_agent` | 向 agent 发消息并等回复 | 有 |
| `get_openclaw_notifications` | 拉取增量任务完成通知 | 无（仅推进本地游标） |

## 连接配置

默认**本机零配置**：自动读 `~/.openclaw/openclaw.json` 的 gateway 端口与 token。

远程连接或需要覆盖时，按优先级生效：

| 优先级 | 方式 |
|---|---|
| 1 | 环境变量 `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` |
| 2 | `~/.openclaw/trae-bridge.json` |
| 3 | 本机自动发现（读 `openclaw.json`） |
| 4 | 默认 `https://127.0.0.1:18789` |

```json
// ~/.openclaw/trae-bridge.json
{
  "gatewayUrl": "https://127.0.0.1:18789",
  "gatewayToken": "<your-gateway-token>",
  "tlsRejectUnauthorized": false
}
```

`tlsRejectUnauthorized` 对 `localhost` / `127.0.0.1` / 内网网段默认 `false`（自签证书场景）。公网地址请显式设为 `true`。

## 目录结构

```
packages/
  trae-openclaw-plugin/     Trae 侧：MCP server、插件清单、技能
  openclaw-trae-plugin/     OpenClaw 侧：事件钩子、HTTP 路由、trae_notify 工具
scripts/
  deploy-trae.ps1           Trae 侧一键安装
  deploy-openclaw.ps1       OpenClaw 侧一键安装
  probe4.mjs                三平面连通性自检
```

## 已知限制

- **不会出现在 Trae 插件市场列表。** 该列表由服务端 registry 驱动，本地 `plugins/local/` 目录不会被登记。安装必须走本仓库的脚本。
- **本机场景默认跳过 TLS 校验**（Gateway 使用自签证书）。跨机部署请开启校验并配置正式证书。
- 安装脚本目前仅支持 Windows。

## License

MIT — 见 [packages/trae-openclaw-plugin/package.json](packages/trae-openclaw-plugin/package.json)
