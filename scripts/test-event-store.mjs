// EventStore 独立测试：验证 seq 单调递增、重启恢复、FIFO 淘汰、
// 游标拉取、并发写入顺序、损坏行容错。
// 运行：node scripts/test-event-store.mjs
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../packages/openclaw-trae-plugin/src/event-store.mjs";

const tempDir = await mkdtemp(path.join(tmpdir(), "trae-event-store-"));
const eventsFile = path.join(tempDir, "data", "events.jsonl");

function step(name) {
  console.log(`[test-event-store] ${name}`);
}

try {
  // --- 1. 新库：追加 3 条，seq 从 1 开始单调递增 ---
  step("1. fresh store: append 3 events");
  const storeA = new EventStore({ filePath: eventsFile });
  await storeA.ensureReady();
  assert.equal(storeA.eventCount, 0);
  assert.equal(storeA.lastSeq, 0);

  await storeA.appendEvent({
    type: "trae_notify",
    agentId: "main",
    title: "t1",
    body: "b1",
    severity: "info",
  });
  await storeA.appendEvent({
    type: "cron_finished",
    jobId: "job-1",
    jobName: "每日摘要",
    agentId: "main",
    status: "ok",
    summary: "完成",
    durationMs: 1234,
    model: "gpt-test",
  });
  await storeA.appendEvent({ type: "trae_notify", title: "t2", body: "b2", severity: "warn" });

  assert.equal(storeA.lastSeq, 3);
  assert.equal(storeA.eventCount, 3);
  assert.deepEqual(
    storeA.events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.ok(storeA.events.every((event) => typeof event.ts === "number"));
  assert.equal(storeA.events[0].title, "t1");
  assert.equal(storeA.events[1].jobName, "每日摘要");
  assert.equal(storeA.events[1].durationMs, 1234);
  // 缺省可选字段不入事件
  assert.equal(storeA.events[2].agentId, undefined);
  assert.equal(storeA.events[2].jobId, undefined);
  console.log("  ok");

  // --- 2. 模拟重启：新实例从持久化恢复，seq 续编 ---
  step("2. restart: restore from events.jsonl, seq continues");
  const storeB = new EventStore({ filePath: eventsFile });
  await storeB.ensureReady();
  assert.equal(storeB.eventCount, 3);
  assert.equal(storeB.lastSeq, 3);
  const ev4 = await storeB.appendEvent({ type: "cron_finished", jobId: "job-2", status: "error" });
  assert.equal(ev4.seq, 4);
  assert.equal(storeB.lastSeq, 4);
  console.log("  ok");

  // --- 3. 游标拉取：分页、nextCursor 推进、无新事件 ---
  step("3. cursor pagination");
  const page1 = storeB.getEventsAfter(0, 2);
  assert.deepEqual(
    page1.events.map((event) => event.seq),
    [1, 2],
  );
  assert.equal(page1.nextCursor, 2);

  const page2 = storeB.getEventsAfter(page1.nextCursor, 20);
  assert.deepEqual(
    page2.events.map((event) => event.seq),
    [3, 4],
  );
  assert.equal(page2.nextCursor, 4);

  const pageEmpty = storeB.getEventsAfter(4, 20);
  assert.equal(pageEmpty.events.length, 0);
  assert.equal(pageEmpty.nextCursor, 4);

  // cursor 超前：nextCursor = max(cursor, lastSeq)
  const pageStale = storeB.getEventsAfter(99, 20);
  assert.equal(pageStale.events.length, 0);
  assert.equal(pageStale.nextCursor, 99);
  console.log("  ok");

  // --- 4. FIFO：内存上限淘汰，但文件全量保留；重启后 seq 续编 ---
  step("4. FIFO eviction + restart continuation");
  const storeC = new EventStore({ filePath: eventsFile, maxEvents: 5 });
  await storeC.ensureReady();
  assert.equal(storeC.eventCount, 4);
  for (let i = 0; i < 10; i += 1) {
    await storeC.appendEvent({ type: "trae_notify", title: `n${i}`, body: "x" });
  }
  assert.equal(storeC.lastSeq, 14);
  assert.equal(storeC.eventCount, 5);
  assert.deepEqual(
    storeC.events.map((event) => event.seq),
    [10, 11, 12, 13, 14],
  );
  const fileText = await readFile(eventsFile, "utf8");
  assert.equal(fileText.trim().split("\n").length, 14);

  const storeD = new EventStore({ filePath: eventsFile, maxEvents: 5 });
  await storeD.ensureReady();
  assert.deepEqual(
    storeD.events.map((event) => event.seq),
    [10, 11, 12, 13, 14],
  );
  assert.equal(storeD.lastSeq, 14);
  const ev15 = await storeD.appendEvent({ type: "cron_finished", jobId: "j" });
  assert.equal(ev15.seq, 15);
  console.log("  ok");

  // --- 5. 并发写入：seq 唯一且有序（串行化队列） ---
  step("5. concurrent appends stay ordered");
  const storeE = new EventStore({ filePath: eventsFile });
  await storeE.ensureReady();
  const pending = [];
  for (let i = 0; i < 20; i += 1) {
    pending.push(storeE.appendEvent({ type: "trae_notify", title: `c${i}`, body: "x" }));
  }
  await Promise.all(pending);
  const seqs = storeE.events.map((event) => event.seq);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(storeE.lastSeq, 35);
  console.log("  ok");

  // --- 6. 非法事件类型被拒绝，状态不受影响 ---
  step("6. invalid event type rejected");
  await assert.rejects(() => storeE.appendEvent({ type: "bogus" }), /invalid event type/);
  assert.equal(storeE.lastSeq, 35);
  console.log("  ok");

  // --- 7. 损坏尾行容错：跳过半行，maxSeq 取自合法行 ---
  step("7. corrupt trailing line tolerated");
  await appendFile(eventsFile, '{"seq": 999, "type": "trae_notify", "title": "半行', "utf8");
  const storeF = new EventStore({ filePath: eventsFile });
  await storeF.ensureReady();
  assert.equal(storeF.lastSeq, 35);
  const ev36 = await storeF.appendEvent({ type: "trae_notify", title: "after-corrupt", body: "x" });
  assert.equal(ev36.seq, 36);
  console.log("  ok");

  console.log("[test-event-store] ALL TESTS PASSED");
} catch (error) {
  console.error("[test-event-store] FAILED:", error);
  process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
