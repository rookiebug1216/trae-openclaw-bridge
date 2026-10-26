// 事件存储：内存 ring buffer（上限 FIFO 淘汰）+ JSONL 追加持久化。
// 本模块不依赖 OpenClaw 宿主，可独立导入测试（scripts/test-event-store.mjs）。
// 事件 Schema：{seq, ts, type, agentId?, jobId?, jobName?, status?, summary?,
//               durationMs?, model?, title?, body?, severity?}
// type 取值只增不改义：当前为 "cron_finished" | "trae_notify"。
import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_EVENTS = 1000;
const READ_CHUNK_BYTES = 64 * 1024;

const EVENT_TYPES = new Set(["cron_finished", "trae_notify"]);
const OPTIONAL_FIELDS = [
  "agentId",
  "jobId",
  "jobName",
  "status",
  "summary",
  "durationMs",
  "model",
  "title",
  "body",
  "severity",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 组装完整事件：填 seq/ts，仅保留合法的可选字段。 */
function buildEvent(seq, partial) {
  const type = isRecord(partial) ? partial.type : undefined;
  if (!EVENT_TYPES.has(type)) {
    throw new Error(`invalid event type: ${String(type)}`);
  }
  const event = { seq, ts: Date.now(), type };
  for (const field of OPTIONAL_FIELDS) {
    const value = partial[field];
    if (value === undefined || value === null) continue;
    if (field === "durationMs") {
      if (typeof value === "number" && Number.isFinite(value)) event.durationMs = value;
    } else if (typeof value === "string" && value !== "") {
      event[field] = value;
    }
  }
  return event;
}

/**
 * 从文件尾部高效读取最多 maxLines 条 JSONL 事件。
 * 文件可能很大：按 64KB 块从后往前读，直到凑够换行数或到达文件头。
 * 返回 {events: 按时间升序的事件数组, maxSeq: 文件中可见的最大 seq}。
 * 容错：跳过损坏行（如崩溃时写入的半行）；UTF-8 多字节字符按整块拼接后一次性解码。
 */
async function readJsonlTail(filePath, maxLines) {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error && error.code === "ENOENT") return { events: [], maxSeq: 0 };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const chunks = [];
    let position = size;
    let newlineCount = 0;
    while (position > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(READ_CHUNK_BYTES, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, position);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 0x0a) newlineCount += 1;
    }
    let text = Buffer.concat(chunks).toString("utf8");
    // 未读到文件头时，最前面一行是被截断的半行，丢弃。
    if (position > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    const events = [];
    let maxSeq = 0;
    for (const line of lines.slice(-maxLines)) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 损坏行：跳过
      }
      if (!isRecord(parsed) || typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq)) continue;
      events.push(parsed);
      if (parsed.seq > maxSeq) maxSeq = parsed.seq;
    }
    return { events, maxSeq };
  } finally {
    await handle.close();
  }
}

export class EventStore {
  #initPromise = null;
  #appendChain = Promise.resolve();

  /**
   * @param {{filePath: string, maxEvents?: number, logger?: {warn?: (m: string) => void, error?: (m: string) => void} | null}} options
   */
  constructor({ filePath, maxEvents = DEFAULT_MAX_EVENTS, logger = null } = {}) {
    if (typeof filePath !== "string" || filePath === "") {
      throw new TypeError("EventStore requires a non-empty filePath");
    }
    this.filePath = filePath;
    this.maxEvents = Math.max(1, Math.floor(maxEvents));
    this.logger = logger;
    this.events = [];
    this.lastSeq = 0;
  }

  get eventCount() {
    return this.events.length;
  }

  /** 幂等初始化：从持久化尾部恢复最近 maxEvents 条事件并续接 seq。 */
  ensureReady() {
    this.#initPromise ??= this.#loadTail();
    return this.#initPromise;
  }

  async #loadTail() {
    try {
      const tail = await readJsonlTail(this.filePath, this.maxEvents);
      this.events = tail.events;
      this.lastSeq = tail.maxSeq;
    } catch (error) {
      this.#log("warn", `failed to restore events from ${this.filePath}: ${errorMessage(error)}`);
    }
  }

  #log(level, message) {
    try {
      this.logger?.[level]?.(message);
    } catch {
      // 日志失败不影响主流程
    }
  }

  /**
   * 统一写入入口：填 seq/ts，入内存（FIFO 淘汰）并追加落盘。
   * 串行化执行以保证 seq 单调递增且文件行有序；返回写入的事件。
   * 落盘失败仅记录日志（内存事件保留，降级不抛错）。
   */
  appendEvent(partial) {
    const append = async () => {
      await this.ensureReady();
      // 多进程安全：分配 seq 前先从磁盘同步（agent session 与 gateway
      // 是不同进程，各自维护 lastSeq，不同步会产生重复 seq）。
      await this.syncFromDisk();
      const seq = this.lastSeq + 1;
      const event = buildEvent(seq, partial);
      this.lastSeq = seq;
      this.events.push(event);
      if (this.events.length > this.maxEvents) {
        this.events.splice(0, this.events.length - this.maxEvents);
      }
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      } catch (error) {
        this.#log("error", `failed to persist event seq=${seq}: ${errorMessage(error)}`);
      }
      return event;
    };
    this.#appendChain = this.#appendChain.then(append, append);
    return this.#appendChain;
  }

  /**
   * 游标拉取：返回 seq > cursor 的事件（升序，最多 limit 条）。
   * 每次调用先从磁盘同步最新事件，解决多进程/多实例内存不一致问题。
   * nextCursor = 返回的最后一条 seq；无新事件时 = max(cursor, lastSeq)。
   */
  async syncFromDisk() {
    try {
      const tail = await readJsonlTail(this.filePath, this.maxEvents);
      // 磁盘是唯一事实来源（append-only JSONL 只增不减）：
      // 无条件用磁盘尾部刷新内存窗口，覆盖"另一进程已写入但 maxSeq
      // 未变化"的场景（如并发产生的重复 seq 行）；lastSeq 只增不减。
      this.events = tail.events;
      if (tail.maxSeq > this.lastSeq) {
        this.lastSeq = tail.maxSeq;
      }
    } catch (error) {
      this.#log("warn", `syncFromDisk failed: ${errorMessage(error)}`);
    }
  }

  async getEventsAfter(cursor, limit = 20) {
    // 多进程/多实例场景：每次读前先同步磁盘最新
    await this.syncFromDisk();
    const start = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
    let max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    max = Math.min(max, 100);
    const events = this.events.filter((event) => event.seq > start).slice(0, max);
    const nextCursor =
      events.length > 0 ? events[events.length - 1].seq : Math.max(start, this.lastSeq);
    return { events, nextCursor };
  }
}

export { DEFAULT_MAX_EVENTS, EVENT_TYPES };
