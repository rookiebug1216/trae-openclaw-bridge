// client.mjs — OpenClaw Gateway HTTP 客户端（三平面）
// 实测结论：Gateway 仅 HTTPS，自签证书；Node fetch 需 NODE_TLS_REJECT_UNAUTHORIZED=0
// Node 24 全局 fetch 走 undici，会读取 NODE_TLS_REJECT_UNAUTHORIZED。
// 实测 API 签名见 .trae/documents/trae-openclaw-bridge-plugin.md 第六节。

/**
 * GatewayClient — 三平面 HTTP 客户端
 * @param {{gatewayUrl: string, gatewayToken: string, tlsRejectUnauthorized?: boolean}} config
 */
export class GatewayClient {
  constructor({ gatewayUrl, gatewayToken, tlsRejectUnauthorized = false }) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, "");
    this.gatewayToken = gatewayToken;
    this.tlsRejectUnauthorized = tlsRejectUnauthorized;

    // 本机自签默认跳过 TLS 校验 — 设一次环境变量覆盖全局 fetch
    if (!tlsRejectUnauthorized && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  /** 统一 fetch：https 失败自动降级 http 重试一次。 */
  async #fetchWithFallback(url, options) {
    const headers = {
      Authorization: `Bearer ${this.gatewayToken}`,
      ...(options.headers || {}),
    };
    const fetchOpts = {
      method: options.method || "GET",
      headers,
      body: options.body,
    };

    try {
      return await fetch(url, fetchOpts);
    } catch (firstErr) {
      // https → http 降级（Gateway 实测只支持 https，但兜底处理）
      if (url.startsWith("https")) {
        const httpUrl = url.replace(/^https/, "http");
        try {
          return await fetch(httpUrl, { ...fetchOpts });
        } catch {
          throw firstErr;
        }
      }
      throw firstErr;
    }
  }

  /** 解析 HTTP 错误，区分 401 / 连接失败 / 其他。 */
  async #expectOk(res, label) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Gateway 鉴权失败 (HTTP ${res.status})。请检查 gateway token 配置：` +
        `设置环境变量 OPENCLAW_GATEWAY_TOKEN，或在 ~/.openclaw/trae-bridge.json 中填写 gatewayToken`
      );
    }
    if (res.status >= 500) {
      throw new Error(`Gateway 服务器错误 (HTTP ${res.status}) [${label}]: ${text.slice(0, 200)}`);
    }
    if (res.status >= 400) {
      throw new Error(`Gateway 请求错误 (HTTP ${res.status}) [${label}]: ${text.slice(0, 200)}`);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return json;
  }

  // -----------------------------------------------------------------
  // 平面 1: admin-http-rpc（数据面）
  // -----------------------------------------------------------------
  /**
   * 调用 admin-http-rpc。返回 payload 字段。
   * 实测签名：POST /api/v1/admin/rpc {method, params} → {ok, payload, error?}
   */
  async adminRpc(method, params = {}) {
    const url = `${this.gatewayUrl}/api/v1/admin/rpc`;
    let json;
    try {
      json = await this.#expectOk(
        await this.#fetchWithFallback(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method, params }),
        }),
        `adminRpc ${method}`
      );
    } catch (fetchErr) {
      const msg = fetchErr.message || String(fetchErr);
      if (msg.includes("fetch failed") || msg.includes("UND_ERR_SOCKET") || msg.includes("ECONNREFUSED")) {
        throw new Error(
          `无法连接 OpenClaw Gateway (${this.gatewayUrl})。请确认 Gateway 正在运行：` +
          `执行 openclaw gateway status 或检查 ~/.openclaw/trae-bridge.json 配置`
        );
      }
      throw fetchErr;
    }
    if (!json.ok) {
      throw new Error(`adminRpc ${method} 返回错误: ${json.error || "unknown"}`);
    }
    return json.payload;
  }

  // -----------------------------------------------------------------
  // 平面 2: chatCompletions（聊天面）
  // -----------------------------------------------------------------
  /**
   * 向 agent 发消息，同步返回 agent 回复文本。
   * 实测签名：POST /v1/chat/completions {model: "openclaw/<agentId>", messages, stream:false}
   * 返回: choices[0].message.content
   */
  async chatCompletions(agentId, message, { timeoutSec = 120, sessionKey } = {}) {
    const url = `${this.gatewayUrl}/v1/chat/completions`;
    const messages = Array.isArray(message) ? message : [{ role: "user", content: String(message) }];
    const headers = { "Content-Type": "application/json" };
    if (sessionKey) headers["x-openclaw-session-key"] = sessionKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

    let json;
    try {
      json = await this.#expectOk(
        await this.#fetchWithFallback(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: `openclaw/${agentId}`,
            messages,
            stream: false,
          }),
        }),
        `chatCompletions ${agentId}`
      );
    } catch (fetchErr) {
      const msg = fetchErr.message || String(fetchErr);
      if (msg.includes("fetch failed") || msg.includes("UND_ERR_SOCKET")) {
        throw new Error(
          `无法连接 OpenClaw Gateway (${this.gatewayUrl})。请确认 Gateway 正在运行。`
        );
      }
      if (fetchErr.name === "AbortError") {
        throw new Error(`chatCompletions ${agentId} 超时（${timeoutSec}s）`);
      }
      throw fetchErr;
    } finally {
      clearTimeout(timer);
    }

    const content = json?.choices?.[0]?.message?.content || "";
    return { content, model: json?.model, usage: json?.usage };
  }

  // -----------------------------------------------------------------
  // 平面 3: trae 事件（通知面）
  // -----------------------------------------------------------------
  /**
   * 拉取增量事件。实测签名：GET /api/trae/events?cursor=&limit= → {events, nextCursor}
   */
  async getEvents(cursor = 0, limit = 20) {
    const url = `${this.gatewayUrl}/api/trae/events?cursor=${cursor}&limit=${limit}`;
    let json;
    try {
      json = await this.#expectOk(
        await this.#fetchWithFallback(url, { method: "GET" }),
        "trae events"
      );
    } catch (fetchErr) {
      const msg = fetchErr.message || String(fetchErr);
      if (msg.includes("fetch failed") || msg.includes("UND_ERR_SOCKET")) {
        throw new Error(
          `无法连接 OpenClaw Gateway (${this.gatewayUrl})。请确认 Gateway 正在运行。`
        );
      }
      throw fetchErr;
    }
    return { events: json.events || [], nextCursor: json.nextCursor ?? cursor };
  }

  /** 健康检查（快速连通性验证）。 */
  async health() {
    const url = `${this.gatewayUrl}/api/trae/health`;
    const json = await this.#expectOk(
      await this.#fetchWithFallback(url, { method: "GET" }),
      "trae health"
    );
    return json;
  }
}
