// Trae ⇄ OpenClaw 桥接插件（OpenClaw 侧，id: "trae"，显示名 "Trae"）。
//
// 功能：
//  1. 钩子：订阅 cron_changed（action=finished）→ 产生 cron_finished 事件
//  2. HTTP 路由（gateway 鉴权，由宿主校验 token）：
//     GET /api/trae/health  → {ok, plugin, version, eventCount, lastSeq}
//     GET /api/trae/events  → {events, nextCursor}（seq > cursor 的增量事件）
//  3. 工具：trae_notify（agent 主动推送通知，产生 trae_notify 事件）
//
// 事件流契约见 .trae/specs/add-trae-openclaw-bridge-plugin/spec.md：
//  - seq 全局单调递增，重启后从 data/events.jsonl 恢复续编
//  - 内存 ring buffer 上限 1000 条 FIFO，逐条追加持久化
//  - at-least-once 拉取：消费端按游标幂等
import path from "node:path";
import os from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { EventStore } from "./event-store.mjs";

const PLUGIN_ID = "trae";
const PLUGIN_VERSION = "0.1.0";
// 插件根 = src 的上一级目录（<root>/src/index.mjs → <root>）
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ⚠️ 关键：事件文件不跟随插件路径（OpenClaw 会把插件复制到 tmp/plugin-captures 多个副本）
// 所有副本统一写 ~/.openclaw/trae-bridge/events.jsonl — 单一事实来源
const BRIDGE_DIR = path.join(os.homedir(), ".openclaw", "trae-bridge");
if (!existsSync(BRIDGE_DIR)) { mkdirSync(BRIDGE_DIR, { recursive: true }); }
const EVENTS_FILE = path.join(BRIDGE_DIR, "events.jsonl");

const SEVERITIES = ["info", "warn", "error"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 宽松映射：返回第一个非空字符串候选值。 */
function pickString(...candidates) {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function pickNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 优先用宿主 logger，否则退回 console.error，统一 [trae-plugin] 前缀。 */
function makeLogger(apiLogger) {
  const prefix = "[trae-plugin]";
  if (apiLogger && typeof apiLogger.info === "function") {
    return {
      debug: (message) => apiLogger.debug?.(`${prefix} ${message}`),
      info: (message) => apiLogger.info(`${prefix} ${message}`),
      warn: (message) => apiLogger.warn(`${prefix} ${message}`),
      error: (message) => apiLogger.error(`${prefix} ${message}`),
    };
  }
  return {
    debug: () => {},
    info: (message) => console.error(`${prefix} ${message}`),
    warn: (message) => console.error(`${prefix} [warn] ${message}`),
    error: (message) => console.error(`${prefix} [error] ${message}`),
  };
}

function sendJson(res, statusCode, payload) {
  if (!res || res.writableEnded || res.destroyed) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function isGetRequest(req) {
  return (req?.method ?? "GET").toUpperCase() === "GET";
}

function getRequestQuery(req) {
  try {
    return new URL(req?.url ?? "/", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

// ---------------------------------------------------------------------------
// 钩子：cron_changed(action=finished) → cron_finished 事件
// ---------------------------------------------------------------------------
function createCronChangedHandler(store, logger) {
  return async (event) => {
    try {
      if (!isRecord(event) || event.action !== "finished") return;
      const job = isRecord(event.job) ? event.job : {};
      const jobState = isRecord(job.state) ? job.state : {};
      await store.appendEvent({
        type: "cron_finished",
        jobId: pickString(event.jobId, job.id),
        jobName: pickString(job.name, event.jobName),
        agentId: pickString(event.agentId, job.agentId),
        status: pickString(event.status, event.completionStatus, jobState.lastRunStatus),
        summary: pickString(event.summary),
        durationMs: pickNumber(event.durationMs, jobState.lastDurationMs),
        model: pickString(event.model),
      });
    } catch (error) {
      logger.error(`cron_changed handler failed: ${errorMessage(error)}`);
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------
function createHealthHandler(store, logger) {
  return async (req, res) => {
    try {
      if (!isGetRequest(req)) {
        res?.setHeader?.("Allow", "GET");
        sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "Use GET" });
        return true;
      }
      await store.ensureReady();
      await store.syncFromDisk(); // 多进程同步：磁盘才是 single source of truth
      sendJson(res, 200, {
        ok: true,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        eventCount: store.eventCount,
        lastSeq: store.lastSeq,
      });
    } catch (error) {
      logger.error(`GET /api/trae/health failed: ${errorMessage(error)}`);
      sendJson(res, 500, { ok: false, error: "internal_error" });
    }
    return true;
  };
}

function createEventsHandler(store, logger) {
  return async (req, res) => {
    try {
      if (!isGetRequest(req)) {
        res?.setHeader?.("Allow", "GET");
        sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "Use GET" });
        return true;
      }
      await store.ensureReady();
      const query = getRequestQuery(req);
      const rawCursor = Number(query.get("cursor"));
      const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : 0;
      const rawLimit = Number(query.get("limit"));
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20;
      const { events, nextCursor } = await store.getEventsAfter(cursor, limit);
      sendJson(res, 200, { events, nextCursor });
    } catch (error) {
      logger.error(`GET /api/trae/events failed: ${errorMessage(error)}`);
      sendJson(res, 500, { ok: false, error: "internal_error" });
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// 工具：trae_notify（工厂形式可拿到调用方 agent 上下文）
// ---------------------------------------------------------------------------
function createTraeNotifyTool(store, logger, ctx) {
  return {
    name: "trae_notify",
    label: "Trae Notify",
    description:
      "推送通知到 Trae IDE（用户在 Trae 中查询时可见）。完成任务或需要告知用户时调用",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "通知标题（简短一句话）" },
        body: { type: "string", description: "通知正文（结果摘要或需要用户知晓的内容）" },
        severity: {
          type: "string",
          enum: SEVERITIES,
          description: "严重级别：info（默认）/ warn / error",
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      try {
        const args = isRecord(params) ? params : {};
        const title =
          typeof args.title === "string" && args.title.trim() !== ""
            ? args.title.trim()
            : "(无标题)";
        const body = typeof args.body === "string" ? args.body : "";
        const severity = SEVERITIES.includes(args.severity) ? args.severity : "info";
        const event = await store.appendEvent({
          type: "trae_notify",
          agentId: pickString(ctx?.agentId),
          title,
          body,
          severity,
        });
        return {
          content: [{ type: "text", text: `[trae] 通知已推送（seq=${event.seq}）：${title}` }],
          details: { seq: event.seq, title, severity },
        };
      } catch (error) {
        logger.error(`trae_notify failed: ${errorMessage(error)}`);
        return {
          content: [{ type: "text", text: `[trae] 通知推送失败：${errorMessage(error)}` }],
          details: { delivered: false },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Trae",
  description:
    "Trae IDE bridge: cron-finished event stream, HTTP query routes (/api/trae/health, /api/trae/events), and the trae_notify agent tool.",
  register(api) {
    const logger = makeLogger(api?.logger);
    const store = new EventStore({ filePath: EVENTS_FILE, logger });
    // 尽早恢复持久化事件；失败已在内部记录，不阻塞注册。
    store.ensureReady().catch(() => {});

    // 钩子订阅：当前宿主版本中 cron_changed 属于 typed hook，
    // 必须用 api.on(...)（api.registerHook 对 typed hook 不生效，且要求 opts.name）。
    const onCronChanged = createCronChangedHandler(store, logger);
    if (typeof api?.on === "function") {
      api.on("cron_changed", onCronChanged);
    } else if (typeof api?.registerHook === "function") {
      // 旧宿主兼容回退（registerHook 需要 name，否则抛错）
      api.registerHook("cron_changed", onCronChanged, {
        name: "trae-cron-changed",
        description: "Capture finished cron jobs into the Trae event stream",
      });
    } else {
      logger.warn("no hook registration API available; cron events will not be captured");
    }

    // HTTP 路由（gateway 鉴权：宿主校验 Bearer token，本插件不接触凭据）
    api.registerHttpRoute({
      path: "/api/trae/health",
      auth: "gateway",
      match: "exact",
      handler: createHealthHandler(store, logger),
    });
    api.registerHttpRoute({
      path: "/api/trae/events",
      auth: "gateway",
      match: "exact",
      handler: createEventsHandler(store, logger),
    });

    // agent 工具（manifest contracts.tools 已声明 "trae_notify"）
    api.registerTool((ctx) => createTraeNotifyTool(store, logger, ctx), {
      names: ["trae_notify"],
    });

    logger.info(`registered v${PLUGIN_VERSION} (events: ${EVENTS_FILE})`);
  },
});
