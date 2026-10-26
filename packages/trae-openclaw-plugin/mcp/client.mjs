// client.mjs — OpenClaw Gateway HTTP 客户端（三平面）
// Node 24 全局 fetch 走 undici，读取 NODE_TLS_REJECT_UNAUTHORIZED（进程级开关）。
// 安全策略（高危修复 1）：跳过证书校验默认仅对环回地址生效；
// 内网地址需要显式配置 tlsRejectUnauthorized:false；公网/远程一律强制校验。
// 实测 API 签名见 .trae/documents/trae-openclaw-bridge-plugin.md 第六节。

/**
 * GatewayClient — 三平面 HTTP 客户端
 * @param {{gatewayUrl: string, gatewayToken: string, tlsRejectUnauthorized?: boolean, tlsExplicit?: boolean}} config
 */
export class GatewayClient {
  constructor({ gatewayUrl, gatewayToken, tlsRejectUnauthorized = false, tlsExplicit = false }) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, "");
    this.gatewayToken = gatewayToken;
    this.tlsRejectUnauthorized = tlsRejectUnauthorized;
    this.tlsExplicit = tlsExplicit;
    this.#applyTlsPolicy();
  }

  /** 目标地址分类：loopback（环回）/ private（内网）/ remote（公网或远程）。 */
  #targetZone() {
    try {
      const host = new URL(this.gatewayUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "loopback";
      const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
      }
      return "remote";
    } catch {
      return "remote"; // URL 无法解析时按远程处理（保守：不跳过校验、不降级）
    }
  }

  /**
   * TLS 校验策略。NODE_TLS_REJECT_UNAUTHORIZED 是进程级开关：undici 读到 "0"
   * 就关闭本进程所有请求的证书校验，无法按目标地址区分。因此：
   *   - 允许跳过的场景（环回；或内网且显式配置）设为 "0"
   *   - 其余场景强制设为 "1"，主动清除部署脚本或旧配置遗留的 "0"
   */
  #applyTlsPolicy() {
    const zone = this.#targetZone();
    const skip =
      !this.tlsRejectUnauthorized &&
      (zone === "loopback" || (zone === "private" && this.tlsExplicit));
    if (skip) {
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    }
  }

  /** 统一 fetch：仅环回地址允许 https→http 降级；超时中断不重试。 */
  async #fetchWithFallback(url, options) {
    const headers = {
      Authorization: `Bearer ${this.gatewayToken}`,
      ...(options.headers || {}),
    };
    const fetchOpts = {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: options.signal, // 超时控制：由调用方传入 AbortSignal（高危修复 3）
    };

    try {
      return await fetch(url, fetchOpts);
    } catch (firstErr) {
      // https → http 降级（高危修复 2）：仅限环回地址 — 远程地址降级会把
      // Bearer token 明文发到网络上；被超时中断（AbortError）的请求也不重试。
      if (
        url.startsWith("https") &&
        this.#targetZone() === "loopback" &&
        firstErr?.name !== "AbortError"
      ) {
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
          signal: controller.signal, // 高危修复 3：超时真正中断请求
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
