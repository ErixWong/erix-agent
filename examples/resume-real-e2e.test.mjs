// 真上游崩溃/续跑 e2e（工单 261021-10）：真 relay + 真工具下「跑一半被杀 → 续跑 → 账本闭合」。
//
// 为什么还要这一条：崩溃恢复此前只有**脚本化上游**的用例（`test/loop-message-rows-crash-matrix.test.js`
// 用 `createFakeProvider` + 包一层 store 在第 N 次 `appendRound` 上抛错）。那种注入证明的是
// 「折叠层能重建上下文」，不证明**真进程被 SIGKILL** 之后「同一个 `--session` 再跑一次」能接上：
// 真实进程被杀时账本停在哪一行、run snapshot 与账本谁领先、`repairTranscriptTail` 会不会吃掉
// 已落盘的行、续跑那次会不会把同一段话喂两遍——只有真 CLI 子进程 + 真上游 + 真工具能给。
//
// 用法：ERIX_E2E_REAL=1 node --test examples/resume-real-e2e.test.mjs
// 闸门 / 配置解析 / 模型名来源共用 `examples/e2e-real-gate.mjs`：`ERIX_E2E_REAL=1` 才跑；缺省
// skip 并按分类报原因（gate 缺失 / 配置缺失 / JSON 坏了 / 缺字段 / 凭据引用解不出值 / 端点不可达），
// **不许**变成默认门禁的硬依赖（`npm test` 必须离线可重复）。
//
// ---------------------------------------------------------------------------
// 杀点怎么定（**确定性，不用 sleep 猜**）
//
// 轮询 `--dir` 里的 transcript jsonl，一旦看到**第一条带 `tool_result` 的消息行**（`kind:"message"`
// 且 `messages[*].content[*].type === "tool_result"`）就 `SIGKILL`。选这一行是因为它同时满足两件事：
//   ① 它证明「工具真的执行过、结果已经落盘」（不是模型话术）；
//   ② 它在**轮行之前**落盘（轮记录写在一轮末尾）。
// 判据是账本内容本身，与模型快慢、网络抖动无关：同一条任务重跑多少次，杀点都是同一个语义位置。
// 任务因此刻意让两个调用**一快一慢**（`readFile` + `exec sleep 4`）：工具是顺序执行的，所以
// 第一个结果落盘时第二个必然还在飞 ⇒ 杀点**确定性地**落在崩溃点矩阵里最难的那一格
// 「assistant 正文已写 / 第一个结果已写 / 轮行未写 / 还有挂起调用」。慢工具不是判据（判据仍是账本），
// 它只是把那个窗口撑开到 4 秒，把「杀在轮行之前」从碰运气变成结构性事实。
// 实测记录：杀点会落在哪一格、当时账本有几行，都写进报告的备注里（`[10] 备注：杀点…`）。
//
// ---------------------------------------------------------------------------
// 五条断言各自防什么（本文件的 `[10] A/B/C/D/E`）
//
//   A 账本闭合：`store.load()` 折叠后每条逻辑消息**恰好出现一次**（按内容指纹跨行计数，写「恰好 1」
//     而不是「至少 1」）——防「续跑把同一段话喂两遍」（崩溃恢复最经典的伤：快照正文与账本正文各喂一遍）。
//   B 不丢：被杀之前**已落盘**的工具结果，续跑后仍在折叠输出里，且 `erix.durationMs` / `erix.toolCallKey`
//     逐字原样——防「续跑把已完成的工具结果丢了」（退回改造前「整轮正文等轮末才写」的窗口）。
//   C 不重复执行：同一次工具调用（同一 `toolCallKey`）在账本里只出现**一份**结果——防「续跑把已落盘的
//     结果当没落盘，又补写一份」（#326 之后同 key 异 payload 会抛冲突，同 tool_use_id 两份结果则不会）。
//   D 半行处理：杀点若在写行中途留下半行，续跑后该行被隔离成 `.corrupt.*` 且续跑成功——防
//     「修复尾部把已落盘的行也吃掉」或「半行让续跑直接崩」。本轮自然杀点**没造出**半行时，用一个
//     **确定性注入**（往账本尾部追加一段截断 JSON，模拟写 syscall 被截断）覆盖同一分支，
//     报告里如实标注「自然未命中 / 注入命中」——**不加 sleep 去赌**。
//   E 续跑真的接上了：被杀前的历史必须**原样**是续跑后账本的前缀（不改写、不重编号），续跑那次
//     必须真的产生了新轮（轮号严格前进）且写下了 `:input:` 行（`appendUserTurn`，只有续跑路径才写），
//     并且 `--dir` 里的 `store.load()` 折叠输出包含被杀前的正文——只看退出码不够。
//     模型可见面（终稿里说出被杀前那个 token）只作**旁证**：前提（续跑那次没再读 a.txt）不成立
//     就只记备注，不判红——真上游照不照抄标记是模型自由（同 `scripts/cli-real-smoke.mjs` 的 C2）。
//
// 反向证（报告里贴实测）：把「续跑只从账本重建」破坏掉（临时让 resume 无视账本里已结清的结果，
// 见报告）⇒ A / C 必须红。`src/` 的产品逻辑本单**零改动**。
//
// 隔离纪律（照 `scripts/cli-real-smoke.mjs` 的 C8）：
// - `--dir` 一律指临时目录；真实 `~/.erix` 只**读**（配置）。开跑前取 `~/.erix` 快照 + 选中配置
//   哈希，跑完硬断言「选中配置一字节没变」且「真实 `~/.erix/transcripts` 下没有本次 runId 的任何
//   产物」——后一条有牙齿：`--dir` 若被丢掉，CLI 会把 `<runId>.jsonl` 写进真实目录。
// - 临时目录 `mkdtemp` + `finally` 与 `exit` 钩子双保险删除。
//
// 零依赖：只用 node: 内置 + 仓内相对路径；纯 ESM。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createFileTranscriptStore } from "../src/index.js";
import { foldLedgerMessages, foldMessageRows, MESSAGE_ROW_KIND } from "../src/store/message-rows.js";
import { safeRunId } from "../src/store/file.js";
import {
  formatSkip, printableEndpoint, resolveRealUpstream, TMP_PREFIX,
} from "./e2e-real-gate.mjs";

const CLI = resolve(fileURLToPath(new URL("../bin/cli.js", import.meta.url)));
/** `bin/cli.js` 帮助里承诺的退出码：没有 `--final-guard` 的成功 run 是 4（verification=skipped）。 */
const EXIT_NOT_VERIFIED = 4;
/** 账本主文件名后缀；`.corrupt.*` 隔离文件**不带**它，因此天然不在 `listLedgerFiles()` 名单里。 */
const LEDGER_SUFFIX = ".jsonl";
const CORRUPT_MARK = ".corrupt.";

// ---------------------------------------------------------------------------
// 读账本 / 折叠口径（读侧**不调** store.load：那会先修复尾部，把 D 的分支提前吃掉）
// ---------------------------------------------------------------------------

const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : []);
const messagesOf = (row) => (Array.isArray(row?.messages) ? row.messages : []);

/** 引擎消息行（读侧折叠的两把钥匙之一：`kind:"message"` + 轮内序号 `seq`）。 */
function isEngineMessageRow(row) {
  return row?.kind === MESSAGE_ROW_KIND && Number.isSafeInteger(row?.seq);
}

/** 杀点判据：**带 tool_result 的消息行** = 工具真的执行过、结果已落盘。 */
function isToolResultMessageRow(row) {
  return isEngineMessageRow(row)
    && messagesOf(row).some((message) => blocksOf(message).some((block) => block?.type === "tool_result"));
}

function listLedgerFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(LEDGER_SUFFIX)).sort() : [];
}

function listCorruptFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.includes(CORRUPT_MARK)).sort() : [];
}

/**
 * 原始读账本（**不修复尾部**，只把「完整的行」与「末尾残段」分开）。
 *
 * `partial` 是最后一个 `\n` 之后的那段：干净收尾时是 `""`；被杀在写行中途时是半行残段。
 * 中间行解析失败单独记在 `parseErrors` 里（那是另一种损坏，不该被当成尾部残段放过）。
 */
function readLedger(dir) {
  const files = listLedgerFiles(dir);
  if (files.length === 0) return { file: null, raw: "", rows: [], partial: "", parseErrors: [] };
  if (files.length > 1) throw new Error(`临时 --dir 下出现了多份账本（不该发生）：${files.join(",")}`);
  const file = join(dir, files[0]);
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const partial = lines[lines.length - 1];
  const rows = [];
  const parseErrors = [];
  for (const line of lines.slice(0, -1)) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push(`${line.slice(0, 80)}（${error?.message ?? ""}）`);
    }
  }
  return { file, raw, rows, partial, parseErrors };
}

/** 尾部残段判据：末尾那段既没换行、也不是一个完整 JSON 对象 ⇒ 半行。 */
function isHalfLine(partial) {
  if (partial === "") return false;
  try {
    const parsed = JSON.parse(partial);
    return !(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

/**
 * 逻辑消息指纹（跨行计数用）。
 *
 * 工具块按**配对 id** 认（`use:<id>` / `res:<tool_use_id>`）——同一个 id 出现两次就是真双喂；
 * 正文块按文本认，超长截断只为让失败文案可读。
 */
function fingerprintMessage(message) {
  const parts = blocksOf(message).map((block) => {
    if (block?.type === "tool_use") return `use:${String(block.id)}`;
    if (block?.type === "tool_result") return `res:${String(block.tool_use_id)}`;
    if (block?.type === "text" || block?.type === "reasoning") {
      return `${String(block.type)}:${String(block.text ?? "").slice(0, 200)}`;
    }
    return `${String(block?.type)}:${JSON.stringify(block).slice(0, 200)}`;
  });
  return `${String(message?.role ?? "")}|${parts.join("‖")}`;
}

/**
 * **不用 src 的实现**独立数一遍「应该有几分逻辑消息」：每条非分片消息行贡献 `messages.length`，
 * 分片行（带 `partOf`）接回它指认的那条 ⇒ 贡献 0。与折叠输出对撞：少 = 折叠吞正文，多 = 双喂。
 */
function expectedLogicalCount(rows) {
  let count = 0;
  for (const row of rows) {
    const messages = messagesOf(row);
    if (messages.length === 0) continue;
    if (isEngineMessageRow(row) && typeof row.partOf === "string" && row.partOf !== "") continue;
    count += messages.length;
  }
  return count;
}

/** 折叠输出里的全部 tool_result 块（真上游段与离线自检共用）。 */
function toolResultsIn(messages) {
  return messages
    .flatMap((message) => blocksOf(message))
    .filter((block) => block?.type === "tool_result");
}

function toolUsesIn(messages) {
  return messages
    .flatMap((message) => blocksOf(message))
    .filter((block) => block?.type === "tool_use");
}

/** 折叠输出摊平成「一条逻辑消息一项」（与恢复路径同一个口径）。 */
function logicalMessages(foldedRecords) {
  return foldLedgerMessages(foldedRecords).map((entry) => entry.message);
}

// ---------------------------------------------------------------------------
// 子进程 / 轮询 / 隔离对账
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * 带**可清除**定时器的竞速：`Promise.race([promise, delay(n)])` 会让那个 `setTimeout` 一直挂着，
 * 进程要多活 n 毫秒（实测把 6 秒的用例拖成 6 分钟）。这里超时兑现后立刻 clearTimeout。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {() => T} onTimeout
 * @returns {Promise<T>}
 */
async function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 起一个 CLI 子进程并收集 stdout/stderr；`done` 在退出时兑现（永不 reject）。 */
function startCli({ args, cwd, env }) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collected = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { collected.stdout += chunk; });
  child.stderr.on("data", (chunk) => { collected.stderr += chunk; });
  const done = new Promise((resolveDone) => {
    child.once("error", (error) => resolveDone({
      code: -1, signal: null, ...collected, spawnError: String(error?.message ?? error),
    }));
    child.once("exit", (code, signal) => resolveDone({ code, signal, ...collected }));
  });
  return { child, done };
}

/**
 * 轮询到「第一条 tool_result 消息行」就 SIGKILL。
 *
 * 三个退出条件都要留下证据：命中（正常）、子进程自己先退出（模型没调工具/起跑即错）、超时。
 * 间隔 20ms：判据是**账本内容**，间隔只影响「多快发现」，不影响杀点的语义位置。
 */
async function killAtFirstToolResult({ child, done, dir, timeoutMs = 180_000, intervalMs = 20 }) {
  const started = Date.now();
  let exited;
  done.then((info) => { exited = info; });
  for (;;) {
    const ledger = readLedger(dir);
    if (ledger.rows.some(isToolResultMessageRow)) {
      child.kill("SIGKILL");
      const exitInfo = await done;
      return { hit: true, ledger, elapsedMs: Date.now() - started, exitInfo };
    }
    if (exited !== undefined) {
      return { hit: false, reason: "child_exited", ledger, elapsedMs: Date.now() - started, exitInfo: exited };
    }
    if (Date.now() - started > timeoutMs) {
      child.kill("SIGKILL");
      const exitInfo = await done;
      return { hit: false, reason: "timeout", ledger, elapsedMs: Date.now() - started, exitInfo };
    }
    await delay(intervalMs);
  }
}

/** 真实 `~/.erix` 的快照（**只读**，用于污染对账；与 `scripts/cli-real-smoke.mjs` 同一口径）。 */
function snapshotDir(dir) {
  if (!existsSync(dir)) return { exists: false, files: 0, newest: 0 };
  let files = 0;
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(dir);
  return { exists: true, files, newest };
}

const hashFileIfExists = (file) => (existsSync(file)
  ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)
  : "（不存在）");

/**
 * 把「transcript 文件名」映回 `store.load(runId)` 要的 runId（不安全 id 的文件名是 `run-h-<hash>`，
 * 不可逆）⇒ 先用文件名，再拿同 run 的 `.state.json` / `.status.json` / `.snapshot.json` 里记的
 * `runId` 兜底，最后用「`safeRunId(候选)` 对应的文件确实存在」确认。
 */
function resolveRunIdForTranscript(dir, jsonlName) {
  const base = jsonlName.replace(/\.jsonl$/, "");
  const candidates = [base];
  for (const suffix of [".state.json", ".status.json", ".snapshot.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, `${base}${suffix}`), "utf8"));
      if (typeof parsed?.runId === "string" && parsed.runId !== "") candidates.push(parsed.runId);
    } catch {
      // 这份侧档不存在 / 坏了：不参与候选（不是失败）
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(dir, `${safeRunId(candidate)}.jsonl`))) return candidate;
  }
  throw new Error(`${jsonlName} 的 runId 拿不到（候选：${candidates.join(",")}）`);
}

/** CLI 的统计行（`=== 统计 === model=… rounds=… termination=…`）——判「续跑接上了」的旁证。 */
function parseStats(stdout) {
  const line = stdout.split("\n").reverse().find((entry) => entry.includes("=== 统计 ==="));
  if (line === undefined) return undefined;
  const field = (name) => {
    const matched = new RegExp(`${name}=([^\\s]+)`, "u").exec(line);
    return matched?.[1];
  };
  return {
    line: line.trim(),
    model: field("model"),
    rounds: Number(field("rounds")),
    truncated: field("truncated"),
    termination: field("termination"),
  };
}

// ---------------------------------------------------------------------------
// 离线自检（始终跑，不联网）：钉住本文件的判据本身，防止它们悄悄退化成永远为真
// ---------------------------------------------------------------------------

test("断言集自身的不变量：杀点判据 / 半行判据 / 指纹计数在本文件的用法下真的会响（始终跑，不联网）", () => {
  const runId = "self-check";
  const assistantRow = {
    round: 1, kind: MESSAGE_ROW_KIND, seq: 0, dedupKey: `${runId}:msg:1:0`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "先读两个文件" },
      { type: "tool_use", id: "t1", name: "readFile", input: {} }] }],
  };
  const resultRow = {
    round: 1, kind: MESSAGE_ROW_KIND, seq: 1, dedupKey: `${runId}:msg:1:1`,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "内容" }] }],
  };
  const roundRow = { round: 1, dedupKey: `${runId}:engine:round:1`, messages: [] };
  const seedRow = { round: 0, dedupKey: `${runId}:engine:round:0:seed`, messages: [{ role: "user", content: "任务" }] };

  // ① 杀点判据只认「消息行 + tool_result 块」：轮行（messages 空）与 assistant 行都不许命中。
  assert.equal(isToolResultMessageRow(resultRow), true, "带 tool_result 的消息行必须命中杀点判据");
  assert.equal(isToolResultMessageRow(assistantRow), false, "只有 tool_use 的 assistant 行不是杀点");
  assert.equal(isToolResultMessageRow(roundRow), false, "轮行不是杀点");
  assert.equal(isToolResultMessageRow(seedRow), false, "种子行不是杀点");

  // ② 半行判据：截断 JSON 是半行；干净收尾与「完整 JSON 缺换行」都不是。
  assert.equal(isHalfLine('{"round":2,"kind":"mess'), true, "截断 JSON 必须判成半行");
  assert.equal(isHalfLine(""), false, "以换行收尾的文件没有半行");
  assert.equal(isHalfLine('{"round":2}'), false, "完整 JSON 只缺换行不算半行（repair 补 \\n，不隔离）");

  // ③ 独立计数与折叠输出同口径（无载体行时消息行原样留着，分片接回指认的那条）。
  const rows = [seedRow, assistantRow, resultRow, roundRow];
  assert.equal(expectedLogicalCount(rows), 3, "独立计数：种子 1 + assistant 1 + 结果 1");
  const folded = foldMessageRows(rows);
  assert.equal(logicalMessages(folded).length, 3, "折叠输出应与独立计数一致");

  // ④ 「恰好 1」真的会响：把同一条结果行再写一遍（= 续跑把同一段话喂两遍）⇒ 指纹计数出现 2。
  const duplicated = foldMessageRows([...rows, { ...resultRow, seq: 2, dedupKey: `${runId}:msg:1:2` }]);
  const counts = new Map();
  for (const message of logicalMessages(duplicated)) {
    const key = fingerprintMessage(message);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.ok([...counts.values()].some((count) => count === 2),
    `双写同一份正文必须被指纹计数抓成 2，实际 ${JSON.stringify([...counts.values()])}`);

  // ⑤ 分片接回：`partOf` 指向首片行时，同一条 user 消息里应当有 2 个结果块（不新增逻辑消息）。
  const split = foldMessageRows([seedRow, assistantRow, resultRow, {
    round: 1, kind: MESSAGE_ROW_KIND, seq: 2, dedupKey: `${runId}:msg:1:2`, partOf: `${runId}:msg:1:1`,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "内容2" }] }],
  }, roundRow]);
  assert.equal(logicalMessages(split).length, 3, "分片行不得新增逻辑消息");
  assert.equal(toolResultsIn(logicalMessages(split)).length, 2, "两个结果块必须都看得见");
});

// ---------------------------------------------------------------------------
// 真上游段
// ---------------------------------------------------------------------------

test("真上游 e2e：跑一半 SIGKILL → 同 --session 续跑 → 账本闭合 / 不丢 / 不重复 / 半行 / 接上了", {
  timeout: 15 * 60 * 1000,
}, async (t) => {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    t.skip(`真上游不可用/闸门关：${formatSkip(gate)}`);
    return;
  }
  console.log(`[10] 闸门开：model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)}`);

  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const realErix = join(realHome, ".erix");
  const realTranscripts = join(realErix, "transcripts");
  const configHashBefore = hashFileIfExists(gate.configPath);
  const erixSnapshotBefore = snapshotDir(realErix);

  const root = mkdtempSync(join(tmpdir(), TMP_PREFIX.resumeReal));
  const cleanup = () => { rmSync(root, { recursive: true, force: true }); };
  process.once("exit", cleanup);

  /** 逐条 PASS/FAIL 打点：报告要贴的就是这张表，一条红不掩盖其余结果。 */
  const failures = [];
  const check = (id, fn, detail = "") => {
    try {
      fn();
      console.log(`PASS [10] ${id}${detail ? `  — ${detail}` : ""}`);
    } catch (error) {
      failures.push(id);
      console.log(`FAIL [10] ${id}  — ${String(error?.message ?? error).split("\n")[0]}`
        + (detail ? ` ｜ 现场：${detail}` : ""));
    }
  };
  /** @type {string[]} */ const notes = [];

  try {
    // 每次跑用**全新**的 token：模型不可能先验知道，于是「终稿里出现了被杀前那个 token」只能来自账本。
    const tokenA = `ALPHA-${randomBytes(4).toString("hex")}`;
    const resumeMarker = `RESUME-MARK-${randomBytes(4).toString("hex")}`;
    /**
     * 第二个工具刻意**慢**（4 秒）：工具是**顺序**执行的（实测同一回复里两个调用一个跑完再跑下一个），
     * 所以「第一个结果落盘 → 我们 SIGKILL」之后，第二个工具必然还在飞 ⇒ 杀点**确定性地**落在
     * 「assistant 正文已写 / 第一个结果已写 / 轮行未写 / 还有挂起调用」那一格（崩溃点矩阵里最难的那格）。
     * 这不是拿 sleep 当判据：判据仍是账本内容（第一条 tool_result 行），慢工具只是把那个窗口撑开，
     * 让「杀点落在轮行之前」从碰运气变成结构性事实。
     */
    const slowMarker = "SLOW-DONE";

    const work = join(root, "work");
    const transcripts = join(root, "transcripts");
    mkdirSync(work, { recursive: true });
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(work, "a.txt"), `第一行 token=${tokenA}\n第二行 没有关键字\n`, "utf8");

    const commonArgs = [
      "--config", gate.configPath,
      "--dir", transcripts,
      "--max-rounds", "6",
      "--reflection", "off",
      "--no-notes",
      "--no-todo",
    ];
    const env = { ...process.env };
    // 第一次**不带** `--session`：CLI 的续跑入口要求该 id 已有非空 transcript，
    // 带一个空 id 会直接报「会话不存在」（issue #168）——那是新会话，不是续跑。
    // 两个工具调用写在**同一条回复**里（并行发起），第一个快、第二个慢：杀点因此稳定落在
    // 「第一个结果已落盘、第二个还在飞」的窗口里（理由见上面 `slowMarker` 的注释）。
    const firstPrompt = "严格按顺序做两件事：1) 在**同一次回复里同时**发起两个工具调用："
      + "readFile 读 a.txt，以及 exec 运行 `sleep 4 && echo " + slowMarker + "`；"
      + "2) 然后用一句话同时报出 a.txt 里的 token 与 exec 的输出。";

    const first = startCli({ args: ["chat", firstPrompt, ...commonArgs], cwd: work, env });
    const killed = await killAtFirstToolResult({ child: first.child, done: first.done, dir: transcripts });
    console.log(`[10] 杀点：hit=${killed.hit}${killed.reason ? ` reason=${killed.reason}` : ""}`
      + ` 用了 ${killed.elapsedMs}ms，退出=${JSON.stringify({ code: killed.exitInfo?.code, signal: killed.exitInfo?.signal })}`);

    assert.equal(killed.hit, true,
      `没等到「第一条 tool_result 消息行」就结束了（reason=${killed.reason ?? "?"}，`
      + `退出码=${killed.exitInfo?.code}）。杀点判据要求模型真的调过工具——`
      + `stdout 尾部：${JSON.stringify((killed.exitInfo?.stdout ?? "").slice(-400))}`
      + ` stderr 尾部：${JSON.stringify((killed.exitInfo?.stderr ?? "").slice(-400))}`);
    assert.equal(killed.exitInfo?.signal, "SIGKILL", "子进程必须是被本用例 SIGKILL 掉的（不是自己退出的）");

    const ledgerAfterKill = killed.ledger;
    const runId = resolveRunIdForTranscript(transcripts, ledgerAfterKill.file.split("/").pop());
    const rowsBefore = ledgerAfterKill.rows;
    const preKillResults = toolResultsIn(logicalMessages(foldMessageRows(rowsBefore)));
    const preKillUses = toolUsesIn(logicalMessages(foldMessageRows(rowsBefore)));
    const preKillMaxRound = Math.max(0, ...rowsBefore.map((row) => (Number.isSafeInteger(row?.round) ? row.round : 0)));
    const crashRound = Math.max(0, ...rowsBefore.filter(isToolResultMessageRow)
      .map((row) => (Number.isSafeInteger(row?.round) ? row.round : 0)));
    const crashRoundRowLanded = rowsBefore.some((row) => String(row?.dedupKey ?? "").endsWith(`:round:${String(crashRound)}`)
      && row?.kind !== MESSAGE_ROW_KIND);
    console.log(`[10] runId=${runId}｜杀点账本 ${rowsBefore.length} 行`
      + `（含 tool_result 的调用 ${preKillResults.length} 个，tool_use ${preKillUses.length} 个）`
      + `｜崩溃轮=${crashRound}｜该轮轮行已落=${crashRoundRowLanded}`);
    notes.push(`杀点：${killed.elapsedMs}ms 命中第一条 tool_result 消息行；账本停在 ${rowsBefore.length} 行，`
      + `崩溃轮 ${crashRound} 的轮行${crashRoundRowLanded ? "已" : "未"}落盘`
      + `（= 崩溃点矩阵里「工具结果已写 / 轮行${crashRoundRowLanded ? "已" : "未"}写」那一格）`);

    // ---- 半行：自然杀点没造出来就**确定性注入**一段截断 JSON（不 sleep、不赌）----
    const naturalHalfLine = isHalfLine(ledgerAfterKill.partial);
    const injectedFragment = `{"round":${String(crashRound)},"roundKey":${JSON.stringify(`${runId}:round:${String(crashRound)}`)}`
      + `,"dedupKey":${JSON.stringify(`${runId}:msg:${String(crashRound)}:999`)},"kind":"message","seq":999,`
      + `"messages":[{"role":"assistant","content":[{"type":"text","text":"HALF-LINE-${randomBytes(4).toString("hex")}`;
    if (!naturalHalfLine) {
      writeFileSync(ledgerAfterKill.file, `${ledgerAfterKill.raw}${injectedFragment}`, "utf8");
      notes.push("半行：本轮**自然杀点没命中**（杀点读到的是完整行，SIGKILL 落在 write syscall 之间）；"
        + "为确定性覆盖该分支，向账本尾部追加了一段截断 JSON（模拟写 syscall 被截断），续跑后必须被隔离");
    } else {
      notes.push("半行：本轮**自然命中**（杀点留下了半行残段），续跑必须把它隔离成 .corrupt.*");
    }
    const halfLineFragment = naturalHalfLine ? ledgerAfterKill.partial : injectedFragment;
    const rawBeforeResume = readFileSync(ledgerAfterKill.file, "utf8");
    // 「续跑不许改写已落盘的历史」的基线 = 最后一个换行之前的全部字节（自然半行会被修复截掉）。
    const cleanPrefix = rawBeforeResume.slice(0, rawBeforeResume.lastIndexOf("\n") + 1);
    const corruptBeforeResume = listCorruptFiles(transcripts);

    // ---- 续跑：同一个 --session 再跑一次 ----
    const resumePrompt = `续跑验证 ${resumeMarker}：上一轮进程在第一个工具结果落盘后被 SIGKILL。`
      + `请只用一句话同时报出 a.txt 里的 token 与 exec 的输出（历史里已经有数据的话不要再调用工具）。`;
    const second = startCli({
      args: ["chat", resumePrompt, "--session", runId, ...commonArgs],
      cwd: work,
      env,
    });
    const secondExit = await withTimeout(second.done, 360_000, () => {
      second.child.kill("SIGKILL");
      return { code: -1, signal: "TIMEOUT", stdout: "", stderr: "本用例的 360s 上限到了" };
    });
    const stats = parseStats(secondExit.stdout);
    console.log(`[10] 续跑退出码=${secondExit.code}${secondExit.signal ? ` signal=${secondExit.signal}` : ""}`
      + `｜统计行=${stats === undefined ? "（没有）" : stats.line}`);
    console.log(`[10] 续跑 stdout 尾部：\n${secondExit.stdout.slice(-800).split("\n").map((line) => `      ${line}`).join("\n")}`);
    if (secondExit.stderr.trim() !== "") {
      console.log(`[10] 续跑 stderr 尾部：${secondExit.stderr.slice(-400)}`);
    }

    // ---- 读侧口径：`store.load()` 的折叠输出（宿主可见形状 = 恢复路径重建上下文的输入）----
    const store = createFileTranscriptStore({ dir: transcripts });
    const foldedAfter = await store.load(runId);
    const messagesAfter = logicalMessages(foldedAfter);
    const ledgerAfter = readLedger(transcripts);
    const rowsAfter = ledgerAfter.rows;
    const resultsAfter = toolResultsIn(messagesAfter);
    const corruptAfterResume = listCorruptFiles(transcripts);

    // ================= A 账本闭合 =================
    check("A1 行级：每个 dedupKey 恰好 1 行、消息行 (round,seq) 不重号", () => {
      const keys = rowsAfter.map((row) => String(row?.dedupKey ?? row?.roundKey ?? ""));
      const duplicatedKeys = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
      assert.deepEqual(duplicatedKeys, [], `同一个 dedupKey 落了多行：${duplicatedKeys.join(",")}`);
      const seqs = rowsAfter.filter(isEngineMessageRow)
        .map((row) => `${String(row.round)}:${String(row.seq)}`);
      const duplicatedSeqs = [...new Set(seqs.filter((seq, index) => seqs.indexOf(seq) !== index))];
      assert.deepEqual(duplicatedSeqs, [], `同一 (round,seq) 被两条消息行占用：${duplicatedSeqs.join(",")}`);
      assert.deepEqual(ledgerAfter.parseErrors, [], `账本中间行解析失败：${ledgerAfter.parseErrors.join(" | ")}`);
    }, `账本 ${rowsAfter.length} 行`);

    check("A2 独立计数 = 折叠输出条数（少=折叠吞正文，多=双喂）", () => {
      assert.equal(messagesAfter.length, expectedLogicalCount(rowsAfter),
        `独立计数 ${expectedLogicalCount(rowsAfter)} ≠ 折叠输出 ${messagesAfter.length}`);
      // 护栏：判据不许退化成空跑（本次至少要有 种子 + assistant + 工具结果 + 终稿）。
      assert.ok(messagesAfter.length >= 4, `折叠输出只有 ${messagesAfter.length} 条逻辑消息，判据落空`);
    }, `折叠输出 ${messagesAfter.length} 条逻辑消息（原始行 ${rowsAfter.length} 条）`);

    check("A3 每条逻辑消息按内容指纹**恰好出现 1 次**（不是「至少 1 次」）", () => {
      const counts = new Map();
      for (const message of messagesAfter) {
        const key = fingerprintMessage(message);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const repeated = [...counts.entries()].filter(([, count]) => count !== 1)
        .map(([key, count]) => `${count}× ${key.slice(0, 120)}`);
      assert.deepEqual(repeated, [], `有逻辑消息出现次数不是 1（双喂 / 重复落盘）：${repeated.join(" ｜ ")}`);
    }, `${messagesAfter.length} 条逻辑消息 / ${new Set(messagesAfter.map(fingerprintMessage)).size} 个不同指纹`);

    // ================= B 不丢 =================
    check("B1 被杀前已落盘的每个工具结果仍在折叠输出里，且 toolCallKey / durationMs / content 逐字原样", () => {
      assert.ok(preKillResults.length >= 1, "杀点账本里一个 tool_result 都没有（前置判据落空）");
      const problems = [];
      for (const before of preKillResults) {
        const after = resultsAfter.find((block) => block?.tool_use_id === before?.tool_use_id);
        if (after === undefined) {
          problems.push(`${before?.tool_use_id}: 续跑后折叠输出里没有它了（丢了）`);
          continue;
        }
        if (after?.erix?.toolCallKey !== before?.erix?.toolCallKey) {
          problems.push(`${before?.tool_use_id}: toolCallKey ${String(before?.erix?.toolCallKey)} → ${String(after?.erix?.toolCallKey)}`);
        }
        if (after?.erix?.durationMs !== before?.erix?.durationMs) {
          problems.push(`${before?.tool_use_id}: durationMs ${String(before?.erix?.durationMs)} → ${String(after?.erix?.durationMs)}（不许重算）`);
        }
        if (after?.erix?.success !== before?.erix?.success) {
          problems.push(`${before?.tool_use_id}: success ${String(before?.erix?.success)} → ${String(after?.erix?.success)}`);
        }
        if (String(after?.content) !== String(before?.content)) {
          problems.push(`${before?.tool_use_id}: content 被改写了`);
        }
      }
      assert.deepEqual(problems, [], problems.join(" ｜ "));
    }, `被杀前的 tool_result=${preKillResults.length} 个`
      + `｜${JSON.stringify(preKillResults.map((block) => ({ k: block?.erix?.toolCallKey, d: block?.erix?.durationMs })))}`);

    check("B2 已落盘的历史没被改写：续跑后的账本以杀点账本为**字节前缀**", () => {
      assert.ok(cleanPrefix.length > 0, "杀点账本为空，前缀判据落空");
      assert.equal(ledgerAfter.raw.startsWith(cleanPrefix), true,
        "续跑改写了杀点之前的字节（前缀对不上）——账本只许追加，不许重写");
    }, `前缀 ${cleanPrefix.length} 字节`);

    // ================= C 不重复执行 =================
    check("C1 同一 toolCallKey 在账本里恰好 1 份结果；同一 tool_use_id 恰好 1 份结果", () => {
      const byKey = new Map();
      const byId = new Map();
      for (const block of resultsAfter) {
        const key = block?.erix?.toolCallKey ?? `（无 key）${String(block?.tool_use_id)}`;
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
        byId.set(String(block?.tool_use_id), (byId.get(String(block?.tool_use_id)) ?? 0) + 1);
      }
      const repeatedKeys = [...byKey.entries()].filter(([, count]) => count !== 1);
      const repeatedIds = [...byId.entries()].filter(([, count]) => count !== 1);
      assert.deepEqual(repeatedKeys, [], `同一个 toolCallKey 有多份结果：${JSON.stringify(repeatedKeys)}`);
      assert.deepEqual(repeatedIds, [], `同一个 tool_use_id 有多份结果：${JSON.stringify(repeatedIds)}`);
      assert.ok(resultsAfter.length >= 2,
        `本次任务要求 ≥2 次工具调用，只拿到 ${resultsAfter.length} 次 ⇒ 场景没成立（换模型/提示词，别放宽断言）`);
    }, `结果 ${resultsAfter.length} 个，key 集合 ${new Set(resultsAfter.map((block) => block?.erix?.toolCallKey)).size} 个`);

    check("C2 被杀前的每个 tool_use 续跑后都恰好结清 1 份（挂起的补跑、已完成的复用）", () => {
      const problems = [];
      for (const use of preKillUses) {
        const matched = resultsAfter.filter((block) => block?.tool_use_id === use?.id);
        if (matched.length !== 1) {
          problems.push(`${String(use?.id)}（${String(use?.name)}）: ${matched.length} 份结果`);
          continue;
        }
        if (use?.erix?.toolCallKey !== undefined
          && matched[0]?.erix?.toolCallKey !== use.erix.toolCallKey) {
          problems.push(`${String(use?.id)}: 身份键 ${String(use?.erix?.toolCallKey)} → ${String(matched[0]?.erix?.toolCallKey)}（复放必须沿用已落盘值）`);
        }
      }
      assert.deepEqual(problems, [], problems.join(" ｜ "));
      assert.ok(preKillUses.length >= 1, "杀点账本里一个 tool_use 都没有（前置判据落空）");
    }, `被杀前 tool_use=${preKillUses.length} 个`);

    // ================= D 半行处理 =================
    check("D1 半行被隔离成 .corrupt.*：残段逐字进隔离文件、账本里不再有它、续跑照常成功", () => {
      assert.equal(corruptBeforeResume.length, 0, "续跑前就不该有隔离文件（前置）");
      assert.equal(corruptAfterResume.length, 1,
        `续跑后应恰好有 1 个 .corrupt.* 隔离文件，实际 ${JSON.stringify(corruptAfterResume)}`);
      const quarantined = readFileSync(join(transcripts, corruptAfterResume[0]), "utf8");
      assert.equal(quarantined, halfLineFragment, "隔离文件的内容必须逐字等于那段残段");
      assert.equal(ledgerAfter.raw.includes(halfLineFragment), false, "账本里还留着半行残段（没被截掉）");
      assert.equal(ledgerAfter.partial, "", "续跑后账本必须以换行收尾（尾部残段应已被截断）");
      assert.equal(rowsAfter.some((row) => row?.seq === 999), false, "注入的半行不许变成一条消息行");
      assert.equal(secondExit.code, EXIT_NOT_VERIFIED,
        `续跑退出码 ${secondExit.code}（期望 ${EXIT_NOT_VERIFIED}）——半行不该把续跑弄死`);
    }, `来源=${naturalHalfLine ? "自然（杀点留下）" : "确定性注入（本轮自然未命中）"}`
      + `｜隔离文件=${corruptAfterResume.join(",") || "无"}`);

    // ================= E 续跑真的接上了 =================
    const rowsAdded = rowsAfter.slice(rowsBefore.length);
    check("E1 续跑那次真的产生了新轮：新增行里有 round > 崩溃轮的 assistant 消息，且轮号不回退", () => {
      assert.ok(rowsAdded.length > 0, "续跑一行也没写（根本没接上）");
      const rewound = rowsAfter.filter((row) => Number.isSafeInteger(row?.round) && row.round < 0);
      assert.deepEqual(rewound, [], "出现负轮号");
      const newAssistantRounds = rowsAdded
        .filter((row) => isEngineMessageRow(row)
          && messagesOf(row).some((message) => message?.role === "assistant"))
        .map((row) => row.round);
      assert.ok(newAssistantRounds.some((round) => round > preKillMaxRound),
        `续跑没有产生 round > ${preKillMaxRound} 的 assistant 消息（新增 assistant 轮号：`
        + `${JSON.stringify(newAssistantRounds)}）`);
      const newRowsTooEarly = rowsAdded
        .filter((row) => Number.isSafeInteger(row?.round) && row.round < preKillMaxRound)
        .map((row) => `${String(row.round)}:${String(row.dedupKey)}`);
      assert.deepEqual(newRowsTooEarly, [], `续跑写下了轮号小于杀点最大轮（${preKillMaxRound}）的行：${newRowsTooEarly.join(",")}`);
    }, `杀点最大轮=${preKillMaxRound}｜新增 ${rowsAdded.length} 行`
      + `｜${JSON.stringify(rowsAdded.map((row) => String(row?.dedupKey ?? "").split(":").slice(-3).join(":")))}`);

    check("E2 被杀前的逻辑消息**原样**是续跑后折叠输出的前缀（只许在末尾接新内容）", () => {
      const before = logicalMessages(foldMessageRows(rowsBefore));
      assert.ok(before.length >= 2, `杀点账本只有 ${before.length} 条逻辑消息，前缀判据落空`);
      assert.ok(messagesAfter.length >= before.length,
        `续跑后逻辑消息更少了：${before.length} → ${messagesAfter.length}`);
      const problems = [];
      for (const [index, message] of before.entries()) {
        const actual = messagesAfter[index];
        const expectedFingerprint = fingerprintMessage(message);
        const actualFingerprint = fingerprintMessage(actual);
        if (actualFingerprint === expectedFingerprint) continue;
        // 唯一允许的生长点：杀点那一条聚合 user 消息（被补跑的结果用 `partOf` 接在后面）。
        const expectedBlocks = blocksOf(message);
        const actualBlocks = blocksOf(actual);
        const growsAtTail = index === before.length - 1
          && actualBlocks.length > expectedBlocks.length
          && expectedBlocks.every((block, position) => fingerprintMessage({ role: "x", content: [block] })
            === fingerprintMessage({ role: "x", content: [actualBlocks[position]] }));
        if (!growsAtTail) {
          problems.push(`#${index}: ${expectedFingerprint.slice(0, 80)} ≠ ${actualFingerprint.slice(0, 80)}`);
        }
      }
      assert.deepEqual(problems, [], `续跑改写了被杀前的历史：${problems.join(" ｜ ")}`);
    }, `杀点 ${logicalMessages(foldMessageRows(rowsBefore)).length} 条 → 续跑后 ${messagesAfter.length} 条`);

    check("E3 续跑入口真的走到了：账本里有 appendUserTurn 的 `:input:` 行（只有续跑路径才写）", () => {
      const inputRow = rowsAdded.find((row) => String(row?.dedupKey ?? "").includes(":input:"));
      assert.ok(inputRow !== undefined,
        `新增行里没有 \`:input:\` 行（= 没走 appendUserTurn，可能根本没续跑）：`
        + JSON.stringify(rowsAdded.map((row) => String(row?.dedupKey ?? "").split(":").slice(-3).join(":"))));
      const text = JSON.stringify(messagesOf(inputRow));
      assert.equal(text.includes(resumeMarker), true, `:input: 行里没有本次续跑提示的标记 ${resumeMarker}`);
    }, `新增行键=${JSON.stringify(rowsAdded.map((row) => String(row?.dedupKey ?? "").split(":").slice(-3).join(":")))}`);

    check("E4 续跑那次的模型真的看到了账本历史（终稿里出现被杀前那个 token）", () => {
      // 硬判据在 E1/E2/E3（账本结构）。这一条是**模型可见面**的旁证：被杀前 a.txt 的 token 只在账本里，
      // 续跑进程若**没有**再读 a.txt，模型能说出它就只能是从历史里看到的。
      // 前提不成立（模型又读了一次 a.txt）时不判红，只记备注——`examples/tool-fact-e2e.test.mjs` 与
      // `scripts/cli-real-smoke.mjs` 的 C2 同一条纪律：真上游是否照抄标记是模型自由，拿它判红会把门禁
      // 跑成随机假红。
      const reread = resultsAfter.filter((block) => String(block?.content ?? "").includes(tokenA));
      if (reread.length > 0) {
        notes.push(`E4 旁证不成立：续跑那次又读了 a.txt（${reread.length} 份含 ${tokenA} 的结果），`
          + "模型可见面这条本轮没有判据（结构判据 E1–E3 不受影响）");
        return;
      }
      const newAssistantText = rowsAdded
        .filter((row) => isEngineMessageRow(row))
        .flatMap((row) => messagesOf(row))
        .filter((message) => message?.role === "assistant")
        .map((message) => blocksOf(message).filter((block) => block?.type === "text")
          .map((block) => String(block.text ?? "")).join(""))
        .join("\n");
      assert.equal(newAssistantText.includes(tokenA), true,
        `续跑的 assistant 正文里没有被杀前的 token ${tokenA}（模型没看到历史？）`);
    }, `被杀前 token=${tokenA}｜续跑后含它的新结果块=`
      + `${resultsAfter.filter((block) => String(block?.content ?? "").includes(tokenA)).length}`);

    check("E5 续跑是正常收尾：退出码 4 + 统计行 termination=end_turn、truncated=false", () => {
      assert.equal(secondExit.code, EXIT_NOT_VERIFIED,
        `续跑退出码 ${secondExit.code}${secondExit.signal ? `（signal=${secondExit.signal}）` : ""}，期望 ${EXIT_NOT_VERIFIED}`);
      assert.ok(stats !== undefined, `续跑没有打出统计行：${JSON.stringify(secondExit.stdout.slice(-400))}`);
      assert.equal(stats.truncated, "false", `续跑被截断（truncated=${String(stats.truncated)}）`);
      assert.equal(stats.termination, "end_turn", `续跑终止原因=${String(stats.termination)}`);
    }, stats === undefined ? "统计行缺失" : stats.line);

    // ================= 隔离对账（真实 ~/.erix 一个字节都不许动）=================
    check("Z1 真实 ~/.erix 没被写：选中配置哈希不变 + 真实 transcripts 下没有本次 runId 的产物", () => {
      assert.equal(hashFileIfExists(gate.configPath), configHashBefore,
        `闸门选中的配置 ${gate.configPath} 被改写了（${configHashBefore} → ${hashFileIfExists(gate.configPath)}）`);
      const leaked = [`${safeRunId(runId)}.jsonl`, `${safeRunId(runId)}.snapshot.json`, `${safeRunId(runId)}.status.json`]
        .filter((name) => existsSync(join(realTranscripts, name)));
      assert.deepEqual(leaked, [], `真实 ~/.erix/transcripts 下出现了本次 run 的文件（--dir 没生效？）：${leaked.join(",")}`);
      assert.equal(existsSync(join(realErix, "outputs", safeRunId(runId))), false,
        `真实 ~/.erix/outputs 下出现了本次 run 的归档目录`);
    }, `~/.erix 快照：前=${JSON.stringify(erixSnapshotBefore)} 后=${JSON.stringify(snapshotDir(realErix))}`);

    for (const note of notes) console.log(`[10] 备注：${note}`);
    const erixSnapshotAfter = snapshotDir(realErix);
    if (erixSnapshotAfter.files !== erixSnapshotBefore.files
      || erixSnapshotAfter.newest !== erixSnapshotBefore.newest) {
      // 整棵 ~/.erix 的前后快照只作**备注**：开发者机器上同时可能有别的 session 在写（与本用例无关，
      // 算成污染就是假红）。有牙齿的是 Z1 里那两条精确断言。
      console.log(`[10] 备注：整棵 ~/.erix 的快照变了（可能是别的 session 写的，非本用例所为）：`
        + `前=${JSON.stringify(erixSnapshotBefore)} 后=${JSON.stringify(erixSnapshotAfter)}`);
    }

    assert.deepEqual(failures, [], `真机段失败的断言：${failures.join(", ")}`);
  } finally {
    process.removeListener("exit", cleanup);
    cleanup();
  }
});
