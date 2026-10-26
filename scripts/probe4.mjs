// probe4.mjs — 部署后三平面连通性自检
// 用法：node scripts/probe4.mjs
//
// 探测 4 项（与 client.mjs 的三平面一一对应）：
//   1. plane 3 · GET  /api/trae/health          健康检查
//   2. plane 1 · POST /api/v1/admin/rpc  agents.list
//   3. plane 1 · POST /api/v1/admin/rpc  cron.list
//   4. plane 3 · GET  /api/trae/events          事件流
//
// 连接配置复用 Trae 侧插件的解析链（env > trae-bridge.json > openclaw.json 自动发现 > 默认）。
// 退出码：全部通过 0，任一失败 1。
import { resolveGatewayConfig, describeConfig } from "../packages/trae-openclaw-plugin/mcp/config.mjs";
import { GatewayClient } from "../packages/trae-openclaw-plugin/mcp/client.mjs";

const cfg = resolveGatewayConfig();
const info = describeConfig(cfg);

console.log("OpenClaw Gateway probe");
console.log("  url:       " + info.gatewayUrl);
console.log("  token:     " + (info.tokenPresent ? `present (${info.tokenLength} chars)` : "MISSING"));
console.log("  tlsReject: " + info.tlsRejectUnauthorized);
console.log("");

const client = new GatewayClient(cfg);
let failed = 0;

async function probe(label, fn) {
  try {
    const detail = await fn();
    console.log(`  [OK]   ${label}${detail ? " -- " + detail : ""}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${label} -- ${err.message}`);
  }
}

await probe("plane 3  GET  /api/trae/health", async () => {
  const r = await client.health();
  return JSON.stringify(r).slice(0, 120);
});

await probe("plane 1  RPC  agents.list", async () => {
  const p = await client.adminRpc("agents.list", {});
  return `${(p?.agents || []).length} agent(s)`;
});

await probe("plane 1  RPC  cron.list", async () => {
  const p = await client.adminRpc("cron.list", {});
  return `${(p?.jobs || []).length} cron job(s)`;
});

await probe("plane 3  GET  /api/trae/events", async () => {
  const { events, nextCursor } = await client.getEvents(0, 1);
  return `${events.length} event(s), nextCursor=${nextCursor}`;
});

console.log("");
if (failed === 0) {
  console.log("All 4 probes passed.");
} else {
  console.log(`${failed} probe(s) failed.`);
  process.exitCode = 1;
}
