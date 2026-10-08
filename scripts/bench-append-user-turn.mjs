#!/usr/bin/env node
// issue #157 基准：`appendUserTurn` 每次调用的全量 `load` 成本（零依赖、不跑 LLM）。
//
// 档位（对齐 issue #157 上 2026-10-08 定案的基准设计）：
//   a  createMemoryTranscriptStore  —— 下界（数组 push + 全量 structuredClone）
//   b  createFileTranscriptStore    —— 库内置真实实现；同时实测"每轮 2 次全量读"：
//                                     appendUserTurn 一次 load（src/store/append-user-turn.js），
//                                     file store 的 appendRecord 为幂等再读一次全文
//                                     （src/store/file.js `appendRecord`：修复尾部后 readFile 全文做 dedup）
//   c  SQLite 三表适配器            —— node:sqlite DatabaseSync，宿主同构 schema
//                                     （agent_rounds / messages / tool_calls；JOIN 重组 canonical
//                                      messages；ORDER BY round_no, append_seq），逼近宿主成本结构
//   d  CLI 集成检查                 —— 伪造 N 轮 transcript 后走 bin/cli.js 的 resume 预写路径
//                                     （注入 loop 桩，不跑 LLM），证明 CLI 触达同一路径
//
// 语义（重要，避免 off-by-one 误读）：
//   cell(rounds=N) 测的是「在 N 条既有记录上追加第 N+1 条」的成本：
//     - reset() 只灌 N 条（seed = N）；
//     - 一次 appendUserTurn 追加第 N+1 条；
//     - 因此 append 之后 load 必然返回 N+1 条，断言写 N+1（曾经的 bug：这里断言 N，
//       导致 `load 返回 51 条，应为 50 条` 必然失败）。
//   采样顺序上 load-only / 幂等重跑两趟发生在 append 趟之后且不再 reset，故它们面对的是
//   N+1 条状态（比 appendUserTurn 内部那次 load 多 1 条，偏差 ≈ 1/N；已在结果 JSON 的
//   protocol.loadAssertionRecords 中显式声明，勿与宿主 N 条口径直接相减）。
//
// 用法：
//   node scripts/bench-append-user-turn.mjs                        # Node 22（node:sqlite 可用则跑 c/d）
//   node --experimental-sqlite scripts/bench-append-user-turn.mjs  # Node 22 需要 flag 时
//   ~/.local/node24/bin/node scripts/bench-append-user-turn.mjs    # Node 24 免 flag
//
// 选项：--rounds=50,150,300,600 --tiers=a,b,c,d --round-bytes=8192 --min-reps=15 --max-reps=41
//       --sample-budget-ms=400 --warmups=3 --out=<path> --keep-tmp --quiet
//
// 红线：零 npm 依赖（只用 node: 内置 + 仓库内相对路径）、纯 ESM、不跑 LLM/网络、不改 src/。
//
// ⚠️ 关于 fs 计数器：为实测"每轮几次全量读、读走多少字节"，本脚本在导入被测模块之前
// 改写 `require("node:fs").createReadStream` / `require("node:fs/promises").readFile|open` 三个
// CJS builtin 导出（ESM 命名绑定在 facade 创建时快照，所以必须先打补丁、再动态 import）。
// 因此本脚本自身**不得静态 import node:fs / node:fs/promises**，一律走 createRequire。

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cpus, machine, totalmem } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// ── 0. fs 读计数器（必须在任何 node:fs ESM facade 创建之前装上）──────────────
const fsCounters = { createReadStream: 0, open: 0, readFile: 0, bytesRead: 0 };
function installFsCounters() {
  const fsCjs = require("node:fs");
  const fspCjs = require("node:fs/promises");
  const origCreateReadStream = fsCjs.createReadStream;
  fsCjs.createReadStream = function countedCreateReadStream(...args) {
    fsCounters.createReadStream += 1;
    const stream = origCreateReadStream.apply(this, args);
    if (stream && typeof stream.on === "function") {
      stream.on("data", (chunk) => { fsCounters.bytesRead += chunk.length; });
    }
    return stream;
  };
  const origReadFile = fspCjs.readFile;
  fspCjs.readFile = async function countedReadFile(...args) {
    fsCounters.readFile += 1;
    const value = await origReadFile.apply(this, args);
    if (value != null) {
      fsCounters.bytesRead += typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.length;
    }
    return value;
  };
  const origOpen = fspCjs.open;
  fspCjs.open = async function countedOpen(...args) {
    fsCounters.open += 1;
    return origOpen.apply(this, args);
  };
}
function fsSnapshot() {
  return {
    createReadStream: fsCounters.createReadStream,
    open: fsCounters.open,
    readFile: fsCounters.readFile,
    bytesRead: fsCounters.bytesRead,
  };
}
function fsDelta(from) {
  const now = fsSnapshot();
  const createReadStream = now.createReadStream - from.createReadStream;
  const readFile = now.readFile - from.readFile;
  return {
    createReadStreamCalls: createReadStream,
    readFileCalls: readFile,
    openCalls: now.open - from.open,
    fullReadCalls: createReadStream + readFile,
    bytesRead: now.bytesRead - from.bytesRead,
  };
}
installFsCounters();
const fsPromises = require("node:fs/promises");

// ── 1. 被测模块（必须在补丁之后动态导入）────────────────────────────────────
const { appendUserTurn } = await import("../src/store/append-user-turn.js");
const { createMemoryTranscriptStore } = await import("../src/store/memory.js");
const { createFileTranscriptStore, safeRunId } = await import("../src/store/file.js");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = path.join(REPO_ROOT, "scripts", "bench-append-user-turn-results.json");
const DEFAULT_ROUNDS = [50, 150, 300, 600];
const DEFAULT_TIERS = ["a", "b", "c", "d"];
// 宿主（touwaka-mate，自研三表 DB store）在 issue #157 报告的 load 耗时——本基准独立复现后并列对比。
const HOST_REPORT = {
  source: "issue #157 宿主报告值（touwaka-mate 自研三表 DB store；非本机复现）",
  rounds: [50, 150, 300],
  loadMs: [10, 28, 36],
};

// ── 2. 参数 ──────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const options = {
    rounds: [...DEFAULT_ROUNDS],
    tiers: [...DEFAULT_TIERS],
    roundBytes: 8192,
    minReps: 15,
    maxReps: 41,
    sampleBudgetMs: 400,
    warmups: 3,
    out: RESULTS_PATH,
    keepTmp: false,
    quiet: false,
    help: false,
  };
  const positiveList = (value) => String(value).split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
  for (const raw of argv) {
    const splitAt = raw.indexOf("=");
    const flag = splitAt === -1 ? raw : raw.slice(0, splitAt);
    const value = splitAt === -1 ? undefined : raw.slice(splitAt + 1);
    switch (flag) {
      case "--rounds": options.rounds = positiveList(value); break;
      case "--tiers":
        options.tiers = String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
        break;
      case "--round-bytes": options.roundBytes = Number(value); break;
      case "--min-reps": options.minReps = Number(value); break;
      case "--max-reps": options.maxReps = Number(value); break;
      case "--sample-budget-ms": options.sampleBudgetMs = Number(value); break;
      case "--warmups": options.warmups = Number(value); break;
      case "--out": options.out = path.resolve(REPO_ROOT, String(value)); break;
      case "--keep-tmp": options.keepTmp = true; break;
      case "--quiet": options.quiet = true; break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`未知参数：${raw}（--help 查看用法）`);
    }
  }
  if (options.rounds.length === 0) options.rounds = [...DEFAULT_ROUNDS];
  return options;
}

// ── 3. 合成 transcript（确定性 PRNG → 曲线可复现）────────────────────────────
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = [
  "docs", "analysis", "test-audit.md", "src/store/file.js", "round", "payload", "chunk",
  "SELECT", "FROM", "agent_rounds", "WHERE", "run_id", "ORDER", "append_seq", "JOIN",
  "canonical", "messages", "fold", "budget", "tokens", "resume", "snapshot", "compaction",
];
function fillerText(rand, targetBytes) {
  const parts = [];
  let bytes = 0;
  let line = 1;
  while (bytes < targetBytes) {
    const width = 6 + Math.floor(rand() * 8);
    const words = Array.from({ length: width }, () => WORDS[Math.floor(rand() * WORDS.length)]);
    const row = `${String(line).padStart(4, "0")} ${words.join(" ")}`;
    parts.push(row);
    bytes += row.length + 1;
    line += 1;
  }
  return parts.join("\n");
}

/** 一轮引擎写入形状的 RoundRecord（assistant 计划 + tool_use + 大 tool_result + 摘要/L0 字段）。 */
export function makeRoundRecord(runId, round, rand, toolResultBytes) {
  const callId = `call_${round}_${Math.floor(rand() * 1e6).toString(36)}`;
  const key = `${runId}:engine:round:${round}`;
  return {
    round,
    roundKey: key,
    dedupKey: key,
    ts: new Date(Date.UTC(2026, 9, 1, 0, 0, round % 60)).toISOString(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: `第 ${round} 轮计划：读取第 ${round} 批审计清单并汇总。` },
          {
            type: "tool_use",
            id: callId,
            name: "exec",
            input: { command: `sed -n '${round * 20},${round * 20 + 19}p' audit.txt` },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: callId, content: fillerText(rand, toolResultBytes) }],
      },
    ],
    response: {
      content: [{ type: "text", text: `第 ${round} 轮完成。` }],
      stopReason: "tool_use",
      usage: { input_tokens: 1800 + round, output_tokens: 120 + round, cacheRead: 900 },
    },
    textPreview: "",
    toolUses: 1,
    summary: { action: "exec", note: `第 ${round} 轮执行了 1 个命令` },
    l0facts: { files: [`audit-${round}.txt`], lastCommand: "sed", roundSignal: round },
    toolOutputs: [{ name: "exec", truncated: false, bytes: toolResultBytes }],
  };
}

/** @returns {object[]} N 轮确定性 transcript 记录（同一 seed → 同一内容，档位间可比） */
export function buildSeedRecords(runId, rounds, roundBytes) {
  const rand = mulberry32(0x5eed + rounds);
  return Array.from({ length: rounds }, (_, index) => (
    makeRoundRecord(runId, index + 1, rand, Math.max(256, roundBytes - 340))
  ));
}

// ── 4. 统计与 store 调用计数器 ───────────────────────────────────────────────
function round3(value) {
  return Math.round(value * 1000) / 1000;
}
export function quantile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return round3(sorted[low]);
  return round3(sorted[low] + (sorted[high] - sorted[low]) * (index - low));
}
export function summarize(values) {
  if (values.length === 0) return { n: 0, p50: null, p95: null, min: null, max: null, mean: null };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return {
    n: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    min: round3(Math.min(...values)),
    max: round3(Math.max(...values)),
    mean: round3(mean),
  };
}

export function createCallSink() {
  return { calls: [], recordsRead: 0, countBytes: false };
}
/** 包一层计数器：逐次记录 load/appendRound 的耗时、返回记录数、fs 层全量读次数与字节数。 */
export function instrumentStore(store, sink) {
  const wrapped = { ...store };
  const trace = (op) => async (runId, payload) => {
    const fsBefore = fsSnapshot();
    const started = performance.now();
    const result = op === "load" ? await store.load(runId) : await store.appendRound(runId, payload);
    const ms = performance.now() - started;
    const call = {
      op,
      ms: round3(ms),
      records: op === "load" && Array.isArray(result) ? result.length : 1,
      fs: fsDelta(fsBefore),
      ...(op === "load" && store.loadStats ? { storeInternal: { ...store.loadStats } } : {}),
      ...(sink.countBytes && result !== undefined
        ? {
          logicalBytes: Buffer.byteLength(
            JSON.stringify(op === "load" ? result : [payload]),
            "utf8",
          ),
        }
        : {}),
    };
    sink.calls.push(call);
    if (op === "load" && Array.isArray(result)) sink.recordsRead += result.length;
    return result;
  };
  wrapped.load = trace("load");
  wrapped.appendRound = trace("appendRound");
  return wrapped;
}
/** 一次 appendUserTurn 的调用画像（load 次数 / appendRound 次数 / 全量读次数 / 读走字节）。 */
export function profileTurn(calls) {
  const profile = {
    loadCalls: 0, appendRoundCalls: 0, fullReadCalls: 0, readFileCalls: 0,
    createReadStreamCalls: 0, openCalls: 0, fsBytesRead: 0, recordsRead: 0, logicalBytesRead: 0,
    storeInternal: null,
  };
  for (const call of calls) {
    if (call.op === "load") {
      profile.loadCalls += 1;
      profile.recordsRead += call.records;
      profile.fullReadCalls += call.fs.fullReadCalls;
      profile.readFileCalls += call.fs.readFileCalls;
      profile.createReadStreamCalls += call.fs.createReadStreamCalls;
      profile.openCalls += call.fs.openCalls;
      profile.fsBytesRead += call.fs.bytesRead;
      profile.logicalBytesRead += call.logicalBytes ?? 0;
      if (call.storeInternal) profile.storeInternal = call.storeInternal;
    } else {
      profile.appendRoundCalls += 1;
      profile.fullReadCalls += call.fs.fullReadCalls;
      profile.readFileCalls += call.fs.readFileCalls;
      profile.createReadStreamCalls += call.fs.createReadStreamCalls;
      profile.openCalls += call.fs.openCalls;
      profile.fsBytesRead += call.fs.bytesRead;
    }
  }
  return profile;
}

// ── 5. c 档：SQLite 三表适配器（宿主同构 schema，零依赖 node:sqlite）─────────
/** Node 22 需 `--experimental-sqlite`；Node 22.13+/24 免 flag。不可用时优雅降级（跳过 c/d 的 SQL 档）。 */
export async function loadNodeSqlite() {
  try {
    const module = await import("node:sqlite");
    if (typeof module.DatabaseSync !== "function") {
      return { available: false, reason: "node:sqlite 已加载但没有 DatabaseSync" };
    }
    return { available: true, DatabaseSync: module.DatabaseSync, keys: Object.keys(module).sort() };
  } catch (error) {
    return {
      available: false,
      reason: `${error?.code ?? error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    };
  }
}

/**
 * 宿主（touwaka-mate）同构三层拆行 + JOIN 重组：
 * - `agent_rounds(run_id, round_no, append_seq, ts, dedup_key, round_key, record_json)`
 *   —— round 头；round 级杂项（response/textPreview/toolUses/summary/l0facts/toolOutputs）进 record_json
 * - `messages(round_id, seq, role, content_json, meta_json)`
 *   —— 非工具块留在 content_json（带 `__pos` 位置标记），meta 独立列保真
 * - `tool_calls(round_id, message_seq, pos, kind, call_id, tool_name, input_json, result_content, is_error)`
 *   —— tool_use / tool_result 拆行
 * `load` = 一条三表 LEFT JOIN，`ORDER BY round_no, append_seq, msg_seq, pos`（#152 同轮保序），
 * JS 侧重建 canonical content 块顺序。`appendRound` = 三表插入包在一个事务里（宿主"接收消息的事务"同构）。
 */
export function createSqliteThreeTableStore({ DatabaseSync, file }) {
  const db = new DatabaseSync(file);
  const loadStats = { rows: 0, joinedRows: 0, contentBytes: 0, recordBytes: 0 };
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`CREATE TABLE IF NOT EXISTS agent_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    round_no INTEGER NOT NULL,
    append_seq INTEGER NOT NULL,
    ts TEXT,
    dedup_key TEXT,
    round_key TEXT,
    record_json TEXT NOT NULL
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_rounds_order ON agent_rounds(run_id, round_no, append_seq)",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_dedup ON agent_rounds(run_id, dedup_key)",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL REFERENCES agent_rounds(id),
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    meta_json TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_round ON messages(round_id, seq)");
  db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL REFERENCES agent_rounds(id),
    message_seq INTEGER NOT NULL,
    pos INTEGER NOT NULL,
    kind TEXT NOT NULL,
    call_id TEXT,
    tool_name TEXT,
    input_json TEXT,
    result_content TEXT,
    is_error INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_tool_calls_round ON tool_calls(round_id, message_seq, pos)",
  );

  const findDedup = db.prepare("SELECT 1 AS hit FROM agent_rounds WHERE run_id = ? AND dedup_key = ?");
  const nextSeq = db.prepare(
    "SELECT COALESCE(MAX(append_seq), 0) + 1 AS next FROM agent_rounds WHERE run_id = ? AND round_no = ?",
  );
  const insertRound = db.prepare(`INSERT INTO agent_rounds
    (run_id, round_no, append_seq, ts, dedup_key, round_key, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertMessage = db.prepare(
    "INSERT INTO messages (round_id, seq, role, content_json, meta_json) VALUES (?, ?, ?, ?, ?)",
  );
  const insertToolCall = db.prepare(`INSERT INTO tool_calls
    (round_id, message_seq, pos, kind, call_id, tool_name, input_json, result_content, is_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const joinedLoad = db.prepare(`SELECT
      r.id AS round_id, r.round_no AS round_no, r.append_seq AS append_seq,
      r.ts AS ts, r.dedup_key AS dedup_key, r.round_key AS round_key, r.record_json AS record_json,
      m.seq AS msg_seq, m.role AS role, m.content_json AS content_json, m.meta_json AS meta_json,
      t.pos AS pos, t.kind AS kind, t.call_id AS call_id, t.tool_name AS tool_name,
      t.input_json AS input_json, t.result_content AS result_content, t.is_error AS is_error
    FROM agent_rounds r
    LEFT JOIN messages m ON m.round_id = r.id
    LEFT JOIN tool_calls t ON t.round_id = r.id AND t.message_seq = m.seq
    WHERE r.run_id = ?
    ORDER BY r.round_no, r.append_seq, m.seq, t.pos`);

  const roundLevelFields = [
    "folded", "foldedPayload", "response", "textPreview", "toolUses", "summary", "l0facts",
    "toolOutputs", "navigationRecord", "foldedRoundRange", "runState",
  ];

  function splitBlocks(message) {
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: String(message.content ?? "") }];
    const kept = [];
    const toolRows = [];
    blocks.forEach((block, pos) => {
      if (block?.type === "tool_use") {
        toolRows.push([
          block.id ?? null, block.name ?? null, JSON.stringify(block.input ?? {}), null,
          block.is_error === true ? 1 : 0, pos, "tool_use",
        ]);
        for (const [key, value] of Object.entries(block)) {
          if (key === "type" || key === "id" || key === "name" || key === "input") continue;
          kept.push({ ...block, __pos: pos, __extra: key });
          break;
        }
        return;
      }
      if (block?.type === "tool_result") {
        toolRows.push([
          block.tool_use_id ?? null, null, null,
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
          block.is_error === true ? 1 : 0, pos, "tool_result",
        ]);
        return;
      }
      kept.push({ ...block, __pos: pos });
    });
    return { kept, toolRows };
  }

  function toolBlock(row) {
    if (row.kind === "tool_use") {
      const block = { type: "tool_use", id: row.call_id ?? undefined, name: row.tool_name ?? undefined };
      block.input = JSON.parse(row.input_json ?? "{}");
      return block;
    }
    const block = {
      type: "tool_result",
      tool_use_id: row.call_id ?? undefined,
      content: row.result_content ?? "",
    };
    if (row.is_error === 1) block.is_error = true;
    return block;
  }

  function insertOne(runId, record) {
    const dedupKey = record?.dedupKey ?? record?.roundKey ?? null;
    if (dedupKey !== null && findDedup.get(runId, dedupKey) !== undefined) return false;
    const round = Number.isSafeInteger(record?.round) ? record.round : 0;
    const { next } = nextSeq.get(runId, round);
    const extra = {};
    for (const key of roundLevelFields) {
      if (record?.[key] !== undefined) extra[key] = record[key];
    }
    const recordJson = JSON.stringify(extra);
    const { lastInsertRowid } = insertRound.run(
      runId, round, next, record?.ts ?? null, dedupKey, record?.roundKey ?? null, recordJson,
    );
    const roundId = Number(lastInsertRowid);
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const { kept, toolRows } = splitBlocks(message);
      insertMessage.run(
        roundId, index, message?.role ?? "user", JSON.stringify(kept),
        message?.meta === undefined ? null : JSON.stringify(message.meta),
      );
      for (const row of toolRows) {
        const [callId, toolName, inputJson, resultContent, isError, pos, kind] = row;
        insertToolCall.run(
          roundId, index, pos, kind, callId, toolName, inputJson, resultContent, isError,
        );
      }
    }
    return true;
  }

  function withTransaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw error;
    }
  }

  return {
    loadStats,
    db,
    async appendRound(runId, record) {
      return withTransaction(() => insertOne(runId, record));
    },
    /** 基准专用 seeding 助手（非 store 契约）：一个事务灌入 N 轮，避开逐轮提交污染采样。 */
    async bulkSeed(runId, records) {
      return withTransaction(() => records.map((record) => insertOne(runId, record)));
    },
    async load(runId) {
      loadStats.rows = 0; loadStats.joinedRows = 0; loadStats.contentBytes = 0; loadStats.recordBytes = 0;
      const rows = joinedLoad.all(runId);
      loadStats.joinedRows = rows.length;
      const grouped = new Map();
      for (const row of rows) {
        let round = grouped.get(row.round_id);
        if (round === undefined) {
          const extra = JSON.parse(row.record_json ?? "{}");
          loadStats.recordBytes += Buffer.byteLength(row.record_json ?? "", "utf8");
          round = {
            round: Number(row.round_no),
            ts: row.ts ?? undefined,
            dedupKey: row.dedup_key ?? undefined,
            roundKey: row.round_key ?? undefined,
            messages: [],
            ...extra,
          };
          for (const key of roundLevelFields) {
            if (extra[key] === undefined) delete round[key];
          }
          grouped.set(row.round_id, round);
          loadStats.rows += 1;
        }
        if (row.msg_seq === null || row.msg_seq === undefined) continue;
        let message = round.messages[row.msg_seq];
        if (message === undefined) {
          loadStats.contentBytes += Buffer.byteLength(row.content_json ?? "", "utf8");
          message = {
            role: row.role,
            __blocks: JSON.parse(row.content_json ?? "[]"),
            __tools: [],
          };
          if (row.meta_json !== null && row.meta_json !== undefined) {
            message.meta = JSON.parse(row.meta_json);
          }
          round.messages[row.msg_seq] = message;
        }
        if (row.kind !== null && row.kind !== undefined) {
          loadStats.contentBytes += Buffer.byteLength(row.result_content ?? row.input_json ?? "", "utf8");
          message.__tools.push({ pos: Number(row.pos), block: toolBlock(row) });
        }
      }
      return [...grouped.values()].map((round) => ({
        ...round,
        messages: round.messages.map((message) => {
          const blocks = [
            ...message.__blocks.map((block) => {
              const { __pos: pos, __extra: extra, ...rest } = block;
              return extra === undefined
                ? { block: rest, pos }
                : { block: { ...rest, [extra]: rest[extra] }, pos };
            }),
            ...message.__tools.map((entry) => ({ block: entry.block, pos: entry.pos })),
          ].sort((left, right) => left.pos - right.pos).map((entry) => entry.block);
          const cleaned = { role: message.role, content: blocks };
          if (message.meta !== undefined) cleaned.meta = message.meta;
          return cleaned;
        }),
      }));
    },
    close() {
      db.close();
    },
  };
}

// ── 6. 档位 ─────────────────────────────────────────────────────────────────
const TIER_LABELS = {
  a: "a · memory store（createMemoryTranscriptStore，下界）",
  b: "b · file store（createFileTranscriptStore，库内置真实实现）",
  c: "c · SQLite 三表适配器（node:sqlite，宿主同构 schema）",
  d: "d · CLI 集成检查（bin/cli.js resume 预写路径，不跑 LLM）",
};

function transcriptFileOf(dir, runId) {
  return path.join(dir, `${safeRunId(runId)}.jsonl`);
}
function jsonlOf(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/**
 * @param {"a"|"b"|"c"} id
 * @returns {{ id:string, label:string, runId:string, reset:(records:object[])=>Promise<void>,
 *   store:()=>object, bytes:()=>Promise<number|object>, dispose:()=>Promise<void> }}
 */
async function createTierHarness(id, { tmpRoot, rounds, roundBytes, sqlite }) {
  const runId = `bench-${id}-${rounds}`;
  const records = buildSeedRecords(runId, rounds, roundBytes);
  if (id === "a") {
    let store = createMemoryTranscriptStore();
    return {
      id, label: TIER_LABELS.a, runId,
      records,
      seedMs: 0,
      async reset() {
        store = createMemoryTranscriptStore();
        for (const record of records) await store.appendRound(runId, record);
      },
      store: () => store,
      async bytes() {
        return { logicalJsonBytes: Buffer.byteLength(jsonlOf(records), "utf8") };
      },
      async dispose() {},
    };
  }
  if (id === "b") {
    const dir = path.join(tmpRoot, `tier-b-${rounds}`);
    await fsPromises.mkdir(dir, { recursive: true });
    const store = createFileTranscriptStore({ dir });
    const file = transcriptFileOf(dir, runId);
    return {
      id, label: TIER_LABELS.b, runId, records,
      async reset() {
        await fsPromises.writeFile(file, jsonlOf(records), "utf8");
      },
      store: () => store,
      async bytes() {
        try {
          return { transcriptFileBytes: (await fsPromises.stat(file)).size };
        } catch {
          return { transcriptFileBytes: 0 };
        }
      },
      async dispose() {},
    };
  }
  const dir = path.join(tmpRoot, `tier-c-${rounds}`);
  await fsPromises.mkdir(dir, { recursive: true });
  const file = path.join(dir, "host.sqlite");
  let store = createSqliteThreeTableStore({ DatabaseSync: sqlite.DatabaseSync, file });
  return {
    id, label: TIER_LABELS.c, runId, records,
    async reset() {
      store.db.exec("DELETE FROM tool_calls");
      store.db.exec("DELETE FROM messages");
      store.db.exec("DELETE FROM agent_rounds");
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await store.bulkSeed(runId, records);
    },
    store: () => store,
    async bytes() {
      let databaseBytes = 0;
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          databaseBytes += (await fsPromises.stat(`${file}${suffix}`)).size;
        } catch { /* 文件可能尚未创建 */ }
      }
      return { sqliteFileBytes: databaseBytes };
    },
    async dispose() {
      store.close();
    },
  };
}

// ── 7. 单档 × 单轮数测量 ────────────────────────────────────────────────────
async function sampleAppendUserTurn(harness, options, { countBytes, label }) {
  const sink = createCallSink();
  sink.countBytes = countBytes;
  const store = instrumentStore(harness.store(), sink);
  const messageId = `${label}-${sinkSeq}`;
  sinkSeq += 1;
  const started = performance.now();
  const result = await appendUserTurn(store, {
    key: harness.runId,
    text: `续跑第 ${sinkSeq} 次采样：请把审计报告补齐。`,
    messageId,
  });
  const ms = performance.now() - started;
  if (!result.written) {
    throw new Error(`${harness.id}/${harness.runId}: 采样调用未落盘（written=false），计数会失真`);
  }
  return { ms, calls: sink.calls, profile: profileTurn(sink.calls), round: result.round };
}
let sinkSeq = 0;

async function measureCell(harness, options) {
  const rounds = harness.records.length;
  // 预热：让 JIT / page cache 进入稳态（丢弃）
  for (let index = 0; index < options.warmups; index += 1) {
    await harness.reset();
    await sampleAppendUserTurn(harness, options, { countBytes: false, label: `warm-${rounds}` });
  }
  // 计时采样：每次采样前重置为恰好 N 轮（重置成本在计时区之外）
  const samples = [];
  let measuredMs = 0;
  while (samples.length < options.minReps
    || (measuredMs < options.sampleBudgetMs && samples.length < options.maxReps)) {
    await harness.reset();
    const sample = await sampleAppendUserTurn(harness, options, {
      countBytes: false,
      label: `s${rounds}`,
    });
    samples.push(sample);
    measuredMs += sample.ms;
  }
  // 读量画像采样：开 fs 字节统计 + 逻辑字节统计（这两项本身有开销，单独一趟测）
  const profiles = [];
  for (let index = 0; index < 3; index += 1) {
    await harness.reset();
    profiles.push(await sampleAppendUserTurn(harness, options, {
      countBytes: true,
      label: `p${rounds}`,
    }));
  }
  // 纯 load 采样（与 issue #157 宿主报告的"load 耗时"同口径）
  const loadSamples = [];
  const loadReps = Math.max(options.minReps, 15);
  for (let index = 0; index < 3; index += 1) await harness.store().load(harness.runId);
  for (let index = 0; index < loadReps; index += 1) {
    const sink = createCallSink();
    const store = instrumentStore(harness.store(), sink);
    const started = performance.now();
    const loaded = await store.load(harness.runId);
    loadSamples.push(performance.now() - started);
    // seed 是 N 条，但前面的 append 趟已在 seed 之上追加过，故此刻 store 内是 N+1 条。
    if (loaded.length !== rounds + 1) {
      throw new Error(
        `${harness.id}/${rounds}: load 返回 ${loaded.length} 条，应为 ${rounds + 1} 条`
        + `（seed=${rounds} + appendUserTurn 追加的第 ${rounds + 1} 条）`,
      );
    }
  }
  // 幂等重跑采样：同 messageId 命中 dedupKey → written:false（引擎侧只付一次全量 load）
  const idempotentSamples = [];
  const fixedMessageId = `idem-${rounds}`;
  await harness.reset();
  await appendUserTurn(harness.store(), {
    key: harness.runId, text: "幂等首写", messageId: fixedMessageId,
  });
  for (let index = 0; index < loadReps; index += 1) {
    const sink = createCallSink();
    const store = instrumentStore(harness.store(), sink);
    const started = performance.now();
    const result = await appendUserTurn(store, {
      key: harness.runId, text: "幂等重跑", messageId: fixedMessageId,
    });
    idempotentSamples.push(performance.now() - started);
    if (result.written) throw new Error(`${harness.id}/${rounds}: 同 messageId 重跑应 written=false`);
  }
  const bytes = await harness.bytes();
  const profile = profiles[Math.floor(profiles.length / 2)].profile;
  return {
    rounds,
    samples: samples.length,
    appendUserTurnMs: summarize(samples.map((sample) => sample.ms)),
    loadOnlyMs: summarize(loadSamples),
    idempotentRerunMs: summarize(idempotentSamples),
    perTurnCallProfile: {
      loadCalls: profile.loadCalls,
      appendRoundCalls: profile.appendRoundCalls,
      recordsReadPerLoad: profile.recordsRead,
      fullFileReads: profile.fullReadCalls,
      createReadStreamCalls: profile.createReadStreamCalls,
      readFileCalls: profile.readFileCalls,
      openCalls: profile.openCalls,
      fsBytesRead: profile.fsBytesRead,
      logicalBytesRead: profile.logicalBytesRead,
      storeInternal: profile.storeInternal,
    },
    storageBytes: bytes,
    derived: {
      appendUserTurnMsPerRound: rounds > 0
        ? round3((quantile(samples.map((sample) => sample.ms), 0.5) ?? 0) / rounds)
        : null,
      hostReportLoadMs: HOST_REPORT.rounds.includes(rounds)
        ? HOST_REPORT.loadMs[HOST_REPORT.rounds.indexOf(rounds)]
        : null,
    },
  };
}

// ── 8. d 档：CLI 集成检查（伪造 N 轮 + loop 桩，不跑 LLM）───────────────────
/**
 * `bin/cli.js` 的 resume 预写路径（cli.js `runChatWithNotes`）是：
 *   ① `store.load(runId)`（判断 resume）→ ② `appendUserTurn(store, {key, text})`
 * → ③ file store `appendRecord` 内部为幂等再读一次全文。
 * 即 CLI 每轮 resume 预写有 **3 次全量读**（比 issue #157 描述的 2 次还多一次——CLI 自己先 load 一次）。
 * 本档用注入的 loop 桩替代 `runToolLoop`，因此不产生任何 LLM/网络调用。
 */
async function measureCliTier({ tmpRoot, rounds, roundBytes, repeats = 3, quiet }) {
  const { runChat } = await import("../bin/cli.js");
  const { createCliAssemblyRoot } = await import("../bin/assembly-root.js");
  const dir = path.join(tmpRoot, `tier-d-${rounds}`);
  const notesDir = path.join(dir, "notes");
  await fsPromises.mkdir(notesDir, { recursive: true });
  const runId = `bench-d-${rounds}`;
  const records = buildSeedRecords(runId, rounds, roundBytes);
  const transcriptFile = transcriptFileOf(dir, runId);
  const baseAssembly = () => createCliAssemblyRoot({ dir, runId, notesDir });
  const results = [];
  for (let index = 0; index < repeats; index += 1) {
    await fsPromises.writeFile(transcriptFile, jsonlOf(records), "utf8");
    const assembly = baseAssembly();
    const sink = createCallSink();
    sink.countBytes = index === 0;
    const store = instrumentStore(assembly.store, sink);
    const consoleLines = [];
    const originalLog = console.log;
    console.log = (...args) => { consoleLines.push(args.join(" ")); };
    let loopEntered = false;
    try {
      await runChat({
        prompt: "cli 集成检查：把审计清单补齐",
        session: runId,
        sessionExplicit: true,
        dir,
        notesDir,
        configPath: path.join(dir, "missing-config.json"),
        skillsDir: path.join(dir, "empty-skills"),
        config: {
          model: "bench-stub-model",
          endpoint: "http://127.0.0.1:1/v1",
          apiKey: "bench-stub-key",
          maxOutputTokens: 4096,
          timeout: 1000,
        },
        provider: { stream: () => ({ on: () => {} }) },
        noNotes: true,
        noTodo: true,
        _assemblyRoot: { ...assembly, store },
        toolOutput: () => {},
        loop: async () => {
          loopEntered = true;
          return {
            rounds: 0,
            truncated: false,
            termination: { reason: "bench_stub" },
            usage: {},
            compactionStats: [],
            verification: { status: "skipped", reason: "no_final_guard" },
            finalText: "stub",
          };
        },
      });
    } finally {
      console.log = originalLog;
      if (!quiet && consoleLines.length > 0) {
        // cli 的 stdout 全部丢弃，只在非 quiet 时留一行提示
      }
    }
    assert.ok(loopEntered, "d 档：loop 桩未被调用，说明 CLI 未走到 runToolLoop");
    const persisted = await createFileTranscriptStore({ dir }).load(runId);
    const inputRecords = persisted.filter((record) => (record?.dedupKey ?? "").startsWith(`${runId}:input:`));
    assert.equal(inputRecords.length, 1, "d 档：CLI 未写入 :input: 命名空间的 user 轮记录");
    const totalMs = sink.calls.reduce((sum, call) => sum + call.ms, 0);
    results.push({
      ms: round3(totalMs),
      wallMs: null,
      calls: sink.calls.map((call) => ({
        op: call.op, ms: call.ms, records: call.records, fs: call.fs,
      })),
      profile: profileTurn(sink.calls),
      roundsAfter: persisted.length,
    });
  }
  return {
    rounds,
    samples: results.length,
    cliStoreAttributableMs: summarize(results.map((result) => result.ms)),
    perTurnCallProfile: profileTurn(results[0].calls),
    observedOps: results[0].calls.map((call) => call.op),
    callsDetail: results[0].calls,
  };
}

// ── 9. 运行方式 / 环境 ──────────────────────────────────────────────────────
export function describeRun(sqliteInfo) {
  const cpu = cpus()[0] ?? {};
  return {
    nodeVersion: process.version,
    execPath: process.execPath,
    platform: `${process.platform}/${machine()}`,
    cpu: cpu.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    invokedAs: [path.relative(REPO_ROOT, process.execPath) || process.execPath, ...process.execArgv,
      path.relative(REPO_ROOT, fileURLToPath(import.meta.url))],
    execArgv: process.execArgv,
    experimentalSqliteFlag: process.execArgv.some((flag) => flag.includes("experimental-sqlite")),
    nodeSqlite: sqliteInfo.available
      ? { available: true, exports: sqliteInfo.keys }
      : { available: false, reason: sqliteInfo.reason },
    noLlm: true,
  };
}

function renderTable(tiers) {
  const lines = [];
  const pad = (value, width) => String(value).padEnd(width);
  lines.push(pad("tier", 42) + pad("rounds", 8) + pad("p50 ms", 10) + pad("p95 ms", 10)
    + pad("load p50", 10) + pad("fullReads", 10) + "bytes/turn");
  lines.push("-".repeat(100));
  for (const tier of tiers) {
    if (tier.skipped) {
      lines.push(pad(tier.label, 42) + `SKIPPED: ${tier.skipReason}`);
      continue;
    }
    for (const cell of tier.cells) {
      if (tier.id === "d") {
        lines.push(pad(TIER_LABELS.d, 42) + pad(cell.rounds, 8)
          + pad(cell.cliStoreAttributableMs.p50, 10) + pad(cell.cliStoreAttributableMs.p95, 10)
          + pad("-", 10) + pad(cell.perTurnCallProfile.fullReadCalls, 10)
          + cell.perTurnCallProfile.fsBytesRead);
        continue;
      }
      lines.push(pad(tier.label, 42) + pad(cell.rounds, 8)
        + pad(cell.appendUserTurnMs.p50, 10) + pad(cell.appendUserTurnMs.p95, 10)
        + pad(cell.loadOnlyMs.p50, 10) + pad(cell.perTurnCallProfile.fullFileReads, 10)
        + cell.perTurnCallProfile.fsBytesRead);
    }
  }
  return lines.join("\n");
}

// ── 10. 主流程 ──────────────────────────────────────────────────────────────
async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/bench-append-user-turn.mjs "
      + "[--rounds=50,150,300,600] [--tiers=a,b,c,d] [--round-bytes=8192] "
      + "[--min-reps=15] [--max-reps=41] [--sample-budget-ms=400] [--warmups=3] "
      + "[--out=<path>] [--keep-tmp] [--quiet]");
    return 0;
  }
  const startedAt = new Date().toISOString();
  const sqliteInfo = await loadNodeSqlite();
  const tmpRoot = await fsPromises.mkdtemp(path.join(
    require("node:os").tmpdir(), "erix-bench-append-user-turn-",
  ));
  const log = (...args) => { if (!options.quiet) console.log(...args); };
  log(`基准开始：${startedAt}（node ${process.version}，tmp=${tmpRoot}）`);
  if (!sqliteInfo.available) {
    log(`⚠️ node:sqlite 不可用（${sqliteInfo.reason}）→ 跳过 c/d 档。`);
    log("   启用方式：node --experimental-sqlite scripts/bench-append-user-turn.mjs"
      + " 或 ~/.local/node24/bin/node scripts/bench-append-user-turn.mjs");
  }
  const tiers = [];
  const cliCapable = sqliteInfo.available;
  for (const id of options.tiers) {
    if (id === "d" && !cliCapable) {
      tiers.push({
        id, label: TIER_LABELS.d, skipped: true,
        skipReason: "node:sqlite 不可用（d 档依赖 CLI 装配路径可运行；见运行方式说明）",
        cells: [],
      });
      continue;
    }
    if (id === "c" && !sqliteInfo.available) {
      tiers.push({
        id, label: TIER_LABELS.c, skipped: true,
        skipReason: `node:sqlite 不可用：${sqliteInfo.reason}`,
        cells: [],
      });
      continue;
    }
    if (id === "d") {
      const cells = [];
      for (const rounds of options.rounds) {
        log(`· d 档 resume 预写路径检查（${rounds} 轮，loop 桩，无 LLM）…`);
        cells.push(await measureCliTier({ tmpRoot, rounds, roundBytes: options.roundBytes, quiet: options.quiet }));
      }
      tiers.push({ id, label: TIER_LABELS.d, skipped: false, cells });
      continue;
    }
    const cells = [];
    for (const rounds of options.rounds) {
      const harness = await createTierHarness(id, {
        tmpRoot, rounds, roundBytes: options.roundBytes, sqlite: sqliteInfo,
      });
      log(`· ${TIER_LABELS[id]} —— ${rounds} 轮（单轮 ≈ ${options.roundBytes}B）采样中…`);
      const cell = await measureCell(harness, options);
      await harness.dispose();
      cells.push(cell);
    }
    tiers.push({
      id, label: TIER_LABELS[id], skipped: false, cells,
      ...(id === "c" ? { schema: "agent_rounds / messages / tool_calls（JOIN 重组，ORDER BY round_no, append_seq）" } : {}),
    });
  }
  const completedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    kind: "append-user-turn-full-load-benchmark",
    issue: "ErixWong/erix-agent#157",
    protocol: {
      operation: "单次 appendUserTurn 调用（含 store.load + store.appendRound），每次采样前把 store 重置为恰好 N 轮",
      rounds: options.rounds,
      recordShape: "assistant(text+tool_use) + user(tool_result 大输出) + response/summary/l0facts/toolOutputs",
      roundBytesTarget: options.roundBytes,
      warmups: options.warmups,
      repsPolicy: `至少 ${options.minReps} 次，累计计时不足 ${options.sampleBudgetMs}ms 则继续（上限 ${options.maxReps} 次）`,
      quantile: "线性插值百分位（p50/p95）",
      seeding: "确定性 PRNG（mulberry32，种子 = rounds）→ 同一轮数内容固定，档位间可比",
      storeResetPerSample: "计时区外重置，保证每次采样面对恰好 N 轮",
      loadAssertionRecords: "N+1 —— seed 为 N 条，appendUserTurn 追加第 N+1 条；load-only/幂等重跑两趟跑在 append 趟之后且不再 reset，故面对 N+1 条",
      noLlm: true,
      noNetwork: true,
    },
    environment: describeRun(sqliteInfo),
    hostReport: HOST_REPORT,
    metrics: [
      "appendUserTurnMs —— 单次 appendUserTurn 调用端到端耗时（与 issue #157 的\"事务内全量读\"同口径）",
      "loadOnlyMs —— 仅 store.load 的耗时（与宿主报告的\"load 耗时\"同口径）",
      "idempotentRerunMs —— 同 messageId 重跑（written:false，只付 load + 判重，不再 appendRound）",
      "perTurnCallProfile.fullFileReads —— 每轮实际发生的全量读次数（file store：load 1 次 + appendRecord 幂等再读 1 次 = 2）",
      "perTurnCallProfile.fsBytesRead —— 每轮实际从 fs 读走的字节数",
    ],
    startedAt,
    completedAt,
    tiers,
    tmpRoot: options.keepTmp ? tmpRoot : undefined,
    conclusion: "",
  };
  result.conclusion = buildConclusion(tiers, sqliteInfo);
  await fsPromises.writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (!options.quiet) console.log(renderTable(tiers));
  log(`\n结果已写入 ${path.relative(REPO_ROOT, options.out)}`);
  log(result.conclusion);
  if (!options.keepTmp) await fsPromises.rm(tmpRoot, { recursive: true, force: true });
  return 0;
}

function buildConclusion(tiers, sqliteInfo) {
  const lines = ["结论：appendUserTurn 每次调用付 1 次全量 load + 1 次 appendRound 的读侧成本（file store 每轮 2 次全量读）。"];
  for (const tier of tiers) {
    if (tier.skipped) {
      lines.push(`- ${tier.label}：跳过（${tier.skipReason}）`);
      continue;
    }
    if (tier.id === "d") {
      const reads = tier.cells[0]?.perTurnCallProfile.fullReadCalls ?? 0;
      lines.push(`- ${tier.label}：CLI resume 路径每轮 ${reads} 次全量读（CLI 自身 load 1 次 + appendUserTurn load 1 次 + file appendRecord 幂等再读 1 次）`);
      continue;
    }
    const parts = tier.cells.map((cell) => `${cell.rounds}轮 p50=${cell.appendUserTurnMs.p50}ms`);
    lines.push(`- ${tier.label}：${parts.join("，")}`);
  }
  if (!sqliteInfo.available) {
    lines.push("- 本次运行未启用 node:sqlite：SQLite 三表档（c）需 `node --experimental-sqlite` 或 Node 24。");
  }
  return lines.join("\n");
}

if (
  process.argv[1] !== undefined
  && (import.meta.url === pathToFileURL(process.argv[1]).href
    || (require("node:fs").existsSync(process.argv[1])
      && import.meta.url === pathToFileURL(require("node:fs").realpathSync(process.argv[1])).href))
) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`基准失败：${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
