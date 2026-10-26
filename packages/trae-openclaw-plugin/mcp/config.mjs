// config.mjs — Gateway 连接配置解析链
// 优先级：env > ~/.openclaw/trae-bridge.json > 本机 openclaw.json 自动发现 > 默认
// 安全红线：代码中绝不硬编码 token；日志/输出中绝不打印 token。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const BRIDGE_FILE = path.join(OPENCLAW_HOME, "trae-bridge.json");
const OPENCLAW_JSON = path.join(OPENCLAW_HOME, "openclaw.json");

const DEFAULT_PORT = 18789;
const DEFAULT_PROTO = "https";

/** 宽松 JSON5 解析（openclaw.json 有注释和尾逗号）。 */
function parseJson5Loose(text) {
  // 1. 移除 // 行注释和 /* */ 块注释
  // 2. 移除 JSON 字符串值之外的尾逗号（,}] → }]）
  // 简单实现足够覆盖 openclaw.json 常见格式
  let cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, "")          // block comments
    .replace(/(^|\n)\s*\/\/[^\n]*/g, "")      // line comments
    .replace(/,\s*([}\]])/g, "$1");            // trailing commas
  return JSON.parse(cleaned);
}

/** 从 openclaw.json 宽松提取字段。token 做 __OPENCLAW_REDACTED__ 占位。 */
function readOpenClawConfig() {
  if (!existsSync(OPENCLAW_JSON)) return null;
  try {
    const raw = readFileSync(OPENCLAW_JSON, "utf8");
    const obj = parseJson5Loose(raw);
    return obj;
  } catch {
    return null;
  }
}

/** 内网/回环地址判断（决定 TLS 是否跳过校验）。 */
function isLocalOrPrivate(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  // 10.x.x.x / 172.16-31.x.x / 192.168.x.x
  const ipMatch = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipMatch) return false;
  const [, a, b] = ipMatch.map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 解析连接配置。优先级：env > bridge.json > openclaw.json 自动发现 > 默认。
 * 返回 { gatewayUrl, gatewayToken, tlsRejectUnauthorized }。
 * token 可能为空字符串（本机模式自动发现失败时），由 client.mjs 按需报错。
 */
export function resolveGatewayConfig() {
  const envUrl = process.env.OPENCLAW_GATEWAY_URL?.trim() || "";
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || "";

  let bridgeUrl = "";
  let bridgeToken = "";
  let bridgeTls = undefined;
  if (existsSync(BRIDGE_FILE)) {
    try {
      const raw = readFileSync(BRIDGE_FILE, "utf8");
      const obj = JSON.parse(raw);
      bridgeUrl = (obj.gatewayUrl || obj.gateway_url || "").trim();
      bridgeToken = (obj.gatewayToken || obj.gateway_token || "").trim();
      bridgeTls = obj.tlsRejectUnauthorized;
    } catch {
      // 桥接文件损坏，忽略
    }
  }

  let discoveredUrl = "";
  let discoveredToken = "";
  let discoveredTls = false;
  const oc = readOpenClawConfig();
  if (oc) {
    const g = oc.gateway || {};
    const port = g.port || DEFAULT_PORT;
    const tls = g.tls?.enabled !== false;
    const proto = tls ? "https" : "http";
    const bind = g.bind || "lan";
    // bind=lan 时 gateway 接受所有接口；本机访问用 127.0.0.1
    const host = "127.0.0.1";
    discoveredUrl = `${proto}://${host}:${port}`;
    discoveredToken = g.auth?.token || "";
    discoveredTls = !isLocalOrPrivate(host); // 本机自签默认跳过
  }

  // 优先级解析
  const gatewayUrl = envUrl || bridgeUrl || discoveredUrl || `${DEFAULT_PROTO}://127.0.0.1:${DEFAULT_PORT}`;
  const gatewayToken = envToken || bridgeToken || discoveredToken || "";
  const tlsRejectUnauthorized =
    bridgeTls !== undefined ? !!bridgeTls :
    envUrl ? !isLocalOrPrivate(new URL(envUrl).hostname) :
    discoveredTls;

  return { gatewayUrl, gatewayToken, tlsRejectUnauthorized };
}

/** 运行时可读的连接描述（不含 token）。 */
export function describeConfig(cfg) {
  return {
    gatewayUrl: cfg.gatewayUrl,
    tokenPresent: cfg.gatewayToken.length > 0,
    tokenLength: cfg.gatewayToken.length,
    tlsRejectUnauthorized: cfg.tlsRejectUnauthorized,
  };
}
