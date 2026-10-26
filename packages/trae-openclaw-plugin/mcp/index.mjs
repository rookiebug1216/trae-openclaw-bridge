// index.mjs — Trae ⇄ OpenClaw MCP Server（stdio）
// 6 个工具：list_openclaw_agents, list_openclaw_cron_jobs, get_openclaw_cron_runs,
//           run_openclaw_cron_job, send_to_openclaw_agent, get_openclaw_notifications
//
// 运行：node mcp/index.mjs
// 调试：npx @modelcontextprotocol/inspector node mcp/index.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

import { resolveGatewayConfig } from "./config.mjs";
import { GatewayClient } from "./client.mjs";

// ---------- 游标持久化 ----------
// 插件根 = mcp/ 的上一级（<root>/mcp/index.mjs → <root>）
const MCP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(MCP_ROOT, "data");
const CURSOR_FILE = path.join(DATA_DIR, "cursor.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}
function readCursor() {
  try {
    if (existsSync(CURSOR_FILE)) {
      const raw = readFileSync(CURSOR_FILE, "utf8");
      const obj = JSON.parse(raw);
      return Number.isFinite(obj.cursor) && obj.cursor >= 0 ? obj.cursor : 0;
    }
  } catch {}
  // 首启回看 24h — 但我们没有时间戳游标，OpenClaw 侧事件按 seq 存
  // 所以首启从 seq=0 开始拉（会拉到所有历史事件）
  return 0;
}
function writeCursor(seq) {
  ensureDataDir();
  writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: seq, updatedAt: Date.now() }, null, 2), "utf8");
}

// ---------- 客户端懒加载 ----------
let client = null;
let gatewayConfig = null;

function getClient() {
  if (!client) {
    gatewayConfig = resolveGatewayConfig();
    client = new GatewayClient(gatewayConfig);
  }
  return client;
}

function formatClientError(err) {
  const msg = err?.message || String(err);
  // 去掉原始 Error 包装，返回用户可读的 MCP 错误
  return {
    content: [{ type: "text", text: `⚠ OpenClaw Gateway 连接失败：${msg}` }],
    isError: true,
  };
}

// ---------- 启动 MCP Server ----------
const server = new McpServer({
  name: "openclaw",
  version: "0.1.0",
  description: "Connect to OpenClaw Gateway: query agents/cron jobs, trigger tasks, chat with agents, and receive task-completion notifications.",
});

// ============ 工具 1: list_openclaw_agents ============
server.tool(
  "list_openclaw_agents",
  "List all OpenClaw agents (id, name, model, enabled status). No parameters needed.",
  {},
  async () => {
    try {
      const payload = await getClient().adminRpc("agents.list", {});
      const agents = payload?.agents || [];
      const summary = agents.map((a) => {
        // OpenClaw agent model 配置字段：单数 model.primary / model 或复数 models.primary
        const model =
          a.model?.primary || a.model ||
          a.models?.primary || a.models?.default ||
          "(none)";
        return `- id: ${a.id}${a.displayName ? ` / ${a.displayName}` : ""}, model: ${model}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `Found ${agents.length} agent(s):\n${summary.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return formatClientError(err);
    }
  }
);

// ============ 工具 2: list_openclaw_cron_jobs ============
server.tool(
  "list_openclaw_cron_jobs",
  "List scheduled cron jobs in OpenClaw, optionally filtered by agentId. Returns schedule, next run time, enabled status.",
  {
    agentId: z.string().optional().describe("Filter jobs by agent ID (e.g. 'main')"),
  },
  async ({ agentId }) => {
    try {
      const payload = await getClient().adminRpc("cron.list", {});
      let jobs = payload?.jobs || [];
      if (agentId) jobs = jobs.filter((j) => j.agentId === agentId);

      const lines = jobs.map((j) => {
        const sched = j.schedule || {};
        const schedStr =
          sched.kind === "every"
            ? `每 ${sched.everyMs / 60000} 分钟`
            : sched.kind === "cron"
            ? `cron: ${sched.expression}`
            : JSON.stringify(sched);
        return [
          `- [${j.enabled ? "✓" : "✗"}] ${j.displayName || j.name}`,
          `  id: ${j.id}`,
          `  agent: ${j.agentId}`,
          `  schedule: ${schedStr}`,
          `  next run: ${j.nextRunAtMs ? new Date(j.nextRunAtMs).toLocaleString("zh-CN") : "?"}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: jobs.length > 0
              ? `Found ${jobs.length} cron job(s)${agentId ? ` for agent '${agentId}'` : ""}:\n\n${lines.join("\n\n")}`
              : `No cron jobs found${agentId ? ` for agent '${agentId}'` : ""}.`,
          },
        ],
      };
    } catch (err) {
      return formatClientError(err);
    }
  }
);

// ============ 工具 3: get_openclaw_cron_runs ============
server.tool(
  "get_openclaw_cron_runs",
  "Get recent run history for a specific cron job. Returns status, summary, duration, and error messages.",
  {
    jobId: z.string().describe("Cron job ID (from list_openclaw_cron_jobs)"),
    limit: z.number().int().min(1).max(50).default(10).describe("Number of recent runs to fetch (default 10, max 50)"),
  },
  async ({ jobId, limit }) => {
    try {
      const payload = await getClient().adminRpc("cron.runs", { jobId, limit });
      const entries = payload?.entries || [];

      const lines = entries.map((e) => {
        const time = e.runAtMs ? new Date(e.runAtMs).toLocaleString("zh-CN") : "?";
        const dur = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : "?";
        const statusIcon = e.status === "ok" ? "✓" : e.status === "error" ? "✗" : e.status === "skipped" ? "⊘" : "○";
        const statusText = e.status || e.completionStatus || "?";
        const err = e.error ? `\n  error: ${e.error}` : "";
        return [
          `- [${statusIcon}] ${time} — ${dur}`,
          `  status: ${statusText}${err}`,
        ].join("\n");
      });

      const total = payload?.total ?? entries.length;
      return {
        content: [
          {
            type: "text",
            text: entries.length > 0
              ? `Cron job run history (${entries.length}/${total} shown):\n\n${lines.join("\n\n")}`
              : `No run history found for job ${jobId}.`,
          },
        ],
      };
    } catch (err) {
      return formatClientError(err);
    }
  }
);

// ============ 工具 4: run_openclaw_cron_job ============
server.tool(
  "run_openclaw_cron_job",
  "Immediately trigger a cron job (force run). Returns enqueue confirmation. Check get_openclaw_cron_runs later for results.",
  {
    jobId: z.string().describe("Cron job ID to run immediately"),
  },
  async ({ jobId }) => {
    try {
      const payload = await getClient().adminRpc("cron.run", { jobId, mode: "force" });
      return {
        content: [
          {
            type: "text",
            text: payload?.ok
              ? `✅ Cron job ${jobId} 已触发（runId: ${payload.runId}）。稍后可用 get_openclaw_cron_runs 查看结果。`
              : `⚠ 触发失败: ${JSON.stringify(payload)}`,
          },
        ],
      };
    } catch (err) {
      return formatClientError(err);
    }
  }
);

// ============ 工具 5: send_to_openclaw_agent ============
server.tool(
  "send_to_openclaw_agent",
  "Send a message to an OpenClaw agent and wait for its reply (synchronous, up to timeoutSec seconds).",
  {
    agentId: z.string().describe("Target agent ID (e.g. 'main')"),
    message: z.string().describe("Message to send to the agent"),
    sessionKey: z.string().optional().describe("Optional session key to maintain conversation context"),
    timeoutSec: z.number().int().min(10).max(600).default(120).describe("Timeout in seconds (default 120)"),
  },
  async ({ agentId, message, sessionKey, timeoutSec }) => {
    try {
      const result = await getClient().chatCompletions(agentId, message, { timeoutSec, sessionKey });
      const content = result.content || "(no response)";
      return {
        content: [
          {
            type: "text",
            text: `【OpenClaw/${agentId}】\n\n${content}`,
          },
        ],
      };
    } catch (err) {
      return formatClientError(err);
    }
  }
);

// ============ 工具 6: get_openclaw_notifications ============
server.tool(
  "get_openclaw_notifications",
  "Fetch new task-completion notifications from OpenClaw (cron job finished, or agent trae_notify push). Cursor persisted locally — each call returns incremental events.",
  {
    limit: z.number().int().min(1).max(100).default(20).describe("Max events to fetch (default 20)"),
  },
  async ({ limit }) => {
    try {
      const cursor = readCursor();
      const { events, nextCursor } = await getClient().getEvents(cursor, limit);

      // 推进游标
      if (nextCursor > cursor) {
        writeCursor(nextCursor);
      }

      if (!events || events.length === 0) {
        return {
          content: [
            { type: "text", text: "📭 暂无新通知。下次查询会继续拉取增量事件。" },
          ],
        };
      }

      const formatted = events.map((e) => {
        const ts = e.ts ? new Date(e.ts).toLocaleString("zh-CN") : "?";
        if (e.type === "cron_finished") {
          const dur = e.durationMs ? `，耗时 ${(e.durationMs / 1000).toFixed(1)}s` : "";
          const statusIcon = e.status === "ok" || e.status === "success" ? "✅" : e.status === "error" ? "❌" : "ℹ️";
          const summary = e.summary ? `\n  摘要：${e.summary}` : "";
          return `${statusIcon} [cron] ${ts} — ${e.jobName || e.jobId}${dur}${summary}`;
        } else if (e.type === "trae_notify") {
          const severityMap = { info: "💬", warn: "⚠️", error: "🚨" };
          const icon = severityMap[e.severity] || "💬";
          return `${icon} [trae_notify] ${ts} — ${e.agentId || "?"}：${e.title || "(无标题)"}${e.body ? `\n  ${e.body}` : ""}`;
        } else {
          return `[${e.type}] ${ts} — ${JSON.stringify(e).slice(0, 200)}`;
        }
      });

      return {
        content: [
          {
            type: "text",
            text: `📬 OpenClaw 新通知 (${events.length} 条，cursor: ${cursor} → ${nextCursor}):\n\n${formatted.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return formatClientError(err);
    }
  }
);

// ---------- 启动 ----------
async function main() {
  // MCP stdio transport
  const transport = new StdioServerTransport();

  try {
    // 先验证 Gateway 连通性（用 logging channel 通知）
    try {
      const cfg = resolveGatewayConfig();
      const client = new GatewayClient(cfg);
      const health = await client.health();
      // health 成功 — 连接正常
    } catch (healthErr) {
      // 连接失败不阻止 server 启动 — Trae 启动 MCP server 时 Gateway 可能还没起来
      // 用户在实际调用工具时会收到明确错误提示
    }

    await server.connect(transport);
    // 日志走 stderr（不干扰 stdio 协议）
    console.error("[openclaw MCP] server started (stdio)");
  } catch (err) {
    console.error("[openclaw MCP] startup failed:", err?.message || err);
    process.exit(1);
  }
}

main();
