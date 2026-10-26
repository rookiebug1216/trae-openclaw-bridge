# OpenClaw for Trae

在 Trae IDE 里直接操作本机的 [OpenClaw](https://openclaw.ai) Gateway：查看 agent 和定时任务、手动触发任务、向 agent 发消息、接收任务完成通知。

这是一个 `.trae-plugin` 形态的插件，内置一个 stdio MCP server（6 个工具）和一个 `openclaw` 技能。

---

## 前置条件

| 项 | 要求 |
|---|---|
| Trae IDE | 3.4.x 及以上 |
| Node.js | ≥ 18（MCP server 用 `node` 启动，需在 PATH 中） |
| OpenClaw Gateway | 本机运行中，默认 `https://127.0.0.1:18789` |

Gateway 未启动时插件仍能加载，但调用工具会返回明确的连接错误提示，不会崩溃。

---

## 安装

### 方式一：一键脚本（推荐）

在项目根目录执行：

```powershell
npm run deploy:trae
```

脚本会做三件事：

1. 把插件包复制到 `%USERPROFILE%\.trae-cn\plugins\local\openclaw\<version>\`
2. 把技能复制到 `%USERPROFILE%\.trae-cn\skills\openclaw\`
3. 把 MCP server 条目**合并**写入 `%USERPROFILE%\.trae-cn\mcp.json` 和 `%APPDATA%\Trae CN\User\mcp.json`（已有其它 server 会被保留）

完成后**重启 Trae**。

### 方式二：手动配置 MCP

只想要 MCP 工具、不需要技能时，在 Trae 的 MCP 配置里添加：

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "node",
      "args": ["<插件根目录>/mcp/index.mjs"],
      "env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" }
    }
  }
}
```

---

## 配置

连接参数按以下优先级解析，取第一个命中的：

1. 环境变量 `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`
2. `~/.openclaw/trae-bridge.json`
   ```json
   {
     "gatewayUrl": "https://127.0.0.1:18789",
     "gatewayToken": "<token>",
     "tlsRejectUnauthorized": false
   }
   ```
3. 自动发现：从 `~/.openclaw/openclaw.json` 读取 `gateway.port` 和 `gateway.auth.token`
4. 默认：`https://127.0.0.1:18789`

**token 从不硬编码，也从不打日志。** 只有 `tokenPresent` / `tokenLength` 会出现在调试输出里。

### 关于 TLS

OpenClaw Gateway 使用自签证书，因此插件会设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。这个设置**只影响本插件的进程**，且只有在目标主机被判定为回环/内网地址（`127.0.0.1` / `localhost` / `10.x` / `172.16-31.x` / `192.168.x`）时才是默认行为。如果显式配置了公网 URL，会正常校验证书。

---

## 工具

| 工具 | 作用 | 是否产生副作用 |
|---|---|---|
| `list_openclaw_agents` | 列出所有 agent（id、名称、模型） | 只读 |
| `list_openclaw_cron_jobs` | 列出定时任务，可按 `agentId` 过滤 | 只读 |
| `get_openclaw_cron_runs` | 查看某个任务的最近执行历史（状态、摘要、耗时、错误） | 只读 |
| `run_openclaw_cron_job` | 立即触发指定任务（强制运行） | **写**：会让任务真实执行 |
| `send_to_openclaw_agent` | 向 agent 发消息并等待回复（同步，默认 120s 超时） | **写**：会消耗 agent 的模型额度 |
| `get_openclaw_notifications` | 拉取增量通知（任务完成 / `trae_notify` 推送） | 只读 |

### 调用示例

```
openclaw 有哪些 agent？
查看 openclaw main 的定时任务
openclaw 有什么新通知
```

`get_openclaw_notifications` 使用本地游标做增量拉取，游标存在 `<插件根目录>/data/cursor.json`，每次调用只返回上次之后的新事件。

---

## 权限与网络行为

- **网络**：只访问配置的 Gateway 地址（默认本机回环），使用 `Authorization: Bearer <token>`。不访问任何第三方服务，不做遥测。
- **本地文件读**：`~/.openclaw/trae-bridge.json`、`~/.openclaw/openclaw.json`
- **本地文件写**：仅 `<插件根目录>/data/cursor.json`
- **子进程**：无

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Gateway 鉴权失败 (HTTP 401/403)` | token 不对或没读到 | 检查 `~/.openclaw/trae-bridge.json` 或设 `OPENCLAW_GATEWAY_TOKEN` |
| `无法连接 OpenClaw Gateway` | Gateway 没起来 | 执行 `openclaw gateway status` 确认 |
| `chatCompletions 超时` | agent 执行时间超过 `timeoutSec` | 调大 `send_to_openclaw_agent` 的 `timeoutSec`（上限 600） |
| MCP 面板里没有 `openclaw` | Trae 未重启 / mcp.json 路径不对 | 重启 Trae，确认 `args` 指向真实存在的 `mcp/index.mjs` |

---

## 已知限制

**本插件不会出现在 Trae 的插件市场列表里。**

Trae 的插件市场列表由服务端 registry API 驱动（`plugin/registries` → `plugin/list` → `plugin/detail`），本地目录不具备注册能力。因此 `plugins/local/` 下的插件包只作为分发载体，实际生效的是：

- **MCP 工具** — 通过 `mcp.json` 挂载
- **技能** — 通过 `~/.trae-cn/skills/` 被本地扫描加载

要让插件进入市场列表，需要向 Trae 官方提交上架，见 [SUBMISSION.md](./SUBMISSION.md)。

---

## 许可

MIT
