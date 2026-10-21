// 跨版本 e2e（工单 261021-13）：**0.22.0 写的老账本，0.23.0 能不能读、能不能续跑**。
//
// 为什么还要这一条：存储收敛（工单 261021 三刀）改的是**落盘形状**——改造前一轮的正文只在轮行
// （`messages` 挂在 `{round, dedupKey: "<runId>:engine:round:<n>"}` 上）落一次，改造后改成
// 「一条消息一成型就写一条 `kind:"message"` 行」（`dedupKey = <runId>:msg:<round>:<seq>`），
// 轮行只剩元数据。宿主升级到 0.23.0 之后**立刻**会遇到的情形就是：磁盘上躺着一份 0.22.0 写的
// 账本，新代码要读它（宿主可见形状不许变）、还要在它上面续跑（不许重写历史、不许把老正文喂两遍、
// 不许丢）。
//
// 此前只有单测里**手写**的旧形状夹具（`test/store/message-rows*.test.js` 之类）：手写夹具证明的是
// 「折叠层认这个形状」，不证明「0.22.0 真的写成这个形状」——旧 CLI 的写侧一旦与夹具的记忆不同
// （键名、种子行、`runState` 字段、正文块的排布），夹具永远发现不了。这一条用**真旧 CLI**
// （`~/.npm-global/bin/erix` = 0.22.0）产账本、**真新代码**读与续跑，两头都是实物。
//
// 用法：ERIX_E2E_REAL=1 node --test examples/cross-version-real-e2e.test.mjs
//
// 两把闸门，缺席原因**分类**报（一律「skipped」会把「机器坏了」伪装成「没开闸」）：
//   ① 真上游：共用 `examples/e2e-real-gate.mjs`（gate 缺失 / 配置缺失 / JSON 坏了 / 缺字段 /
//      凭据引用解不出值 / 端点不可达）。
//   ② 旧 CLI：本文件自带的 `LEGACY_GAP_CODES`——`legacy_cli_missing`（路径不存在）/
//      `legacy_cli_unusable`（在但跑不起来：EACCES、非 0 退出、版本命令没输出）/
//      `legacy_cli_version_mismatch`（在、能跑，但不是 0.22.0）。
//      **没装旧 CLI 不是红**：这是环境前提，不是被测行为。默认路径 `~/.npm-global/bin/erix`
//      （可用 `ERIX_LEGACY_CLI` 覆盖），期望版本 0.22.0（可用 `ERIX_LEGACY_CLI_VERSION` 覆盖）。
//
// ---------------------------------------------------------------------------
// 老账本怎么产（**不用 `--session`**，与工单里的写法差一步，理由在下面）
//
// `erix chat "<prompt>" --dir <tmp> --session <id>` 在 0.22.0 里是**续跑入口**：该 id 没有非空
// transcript 时直接 `exit 1`（issue #168 之后的既定行为，实测「错误：会话不存在：my-fixed-id」）。
// 所以新建会话只能不带 `--session`，runId 由 CLI 自己生成（`<目录名>-<sha256(cwd)[:8]>-<随机>`），
// 再从 `--dir` 里的文件名反解（`resolveRunIdForTranscript`，与 `examples/resume-real-e2e.test.mjs`
// 同一口径；这里文件名本身就是安全 id，`safeRunId(name) === name` 有硬断言兜住）。
// 续跑那一步才用 `--session <同一个 id>`——那正是宿主升级后要走的入口。
//
// ---------------------------------------------------------------------------
// 三组断言各自防什么
//
//   第 1 组（老账本是 0.22.0 形状）：轮行自带 `messages`、**没有** `kind:"message"` 消息行、
//     没有 `:msg:<round>:<seq>` 键、且真的跑过工具（有 `tool_result` 块）。这一组是**前提**：
//     老账本要是被新写侧产出来的，后两组就什么都没证明。
//   第 2 组（新代码读它）：`createFileTranscriptStore({dir}).load(runId)`
//     R1 老行**原样透传**：逐行 `JSON.stringify` 与直接读原始 JSONL 的对应行**逐字相等**（不复制、
//        不改写、不重排、不丢字段）；
//     R2 折叠**不产生重复**：每条逻辑消息按内容指纹**恰好 1 份**（不是「至少 1」——老正文被折叠层
//        再折一遍就会变成 2 份）；
//     R3 老账本里**没有消息行**不影响读出结果：`record.messages` 仍然在，条数与原始行一致，
//        逻辑条数 = 独立计数（少 = 静默吞正文，多 = 双喂）。
//   第 3 组（新代码续跑它）：`node bin/cli.js chat "…" --dir <同一个> --session <同一个 id>`
//     S1 续跑成功：退出码 4（无 `--final-guard` 的成功 run = verification skipped）+ 统计行
//        `termination=end_turn` / `truncated=false`；
//     S2 **老行是字节前缀**：续跑后的账本以续跑前的账本字节为前缀（账本只许追加，不许重写），
//        且没有 `.corrupt.*` 隔离文件（干净收尾的老账本不该被当成半行）；
//     S3 新追加的行是**新形状**：`kind:"message"` + `dedupKey === "<runId>:msg:<round>:<seq>"`；
//        并且**没有**任何新追加的行是「老形状的正文轮行」（无 `kind`、键以 `:engine:round:<n>` 结尾、
//        且带非空 `messages`）——否则等于新写侧在混写两种形状；
//     S4 折叠后老消息**恰好各 1 份**（不重复喂），且总条数 = 独立计数；
//     S5 续跑那次的**终稿**里出现老账本里的 token。为了让这条有牙齿，续跑前把 `a.txt` **删掉**：
//        token 只存在于账本（与快照）里，模型能说出来就只能是从历史里看到的。
//     S6（旁证加强）**快照缺席也能续跑**：把续跑前的账本原样复制到另一个 `--dir`、只留账本与
//        state/status 侧档（**不带** 0.22.0 的 `.snapshot.json`）再续跑一次，token 仍必须出现——
//        0.23.0 的恢复契约是「正文一律来自账本，快照只剩在飞工具」，这一条把它钉在跨版本场景上。
//   反向证（报告里贴实测）：把折叠层对「老行自带 messages」的**透传分支**破坏掉（`foldable === 0`
//     时强制 `messages: []`）⇒ 第 2 组的 R1（逐字相等）与 R2（恰好 1 份）必须**红**。
//     破坏是**临时**的：`src/store/message-rows.js` 原字节保存在内存里，`finally` + `exit` 双保险
//     还原，并用 md5 **逐字**核对（`md5sum` 口径）。`src/` 的**提交**内容零改动。
//
// 隔离纪律（照 `scripts/cli-real-smoke.mjs` 的 C8 与 `examples/resume-real-e2e.test.mjs`）：
// - 两个 CLI 的 `--dir` 一律指临时目录；真实 `~/.erix` 只**读**（配置）。开跑前取 `~/.erix` 快照
//   + 选中配置哈希，跑完硬断言「选中配置一字节没变」「真实 `~/.erix/transcripts` 下没有本次 runId
//   的任何产物」「真实 `~/.erix/outputs` 下没有本次 run 的归档目录」——后两条有牙齿：`--dir` 若被
//   丢掉，CLI 会把 `<runId>.jsonl` 写进真实目录（`HOME` 就被写了）。
// - 临时目录 `mkdtemp` + `finally` 与 `exit` 钩子双保险删除。
//
// 零依赖：只用 node: 内置 + 仓内相对路径；纯 ESM。判据不用固定 `sleep`（超时只是兜底上限，
// 正常路径从不命中；每次子进程结束都有真实退出事件兜底）。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
/** 折叠层源码（反向证要**临时**破坏它的透传分支，再 md5 逐字还原）。 */
const ROWS_FILE = fileURLToPath(new URL("../src/store/message-rows.js", import.meta.url));
const INDEX_URL = new URL("../src/index.js", import.meta.url).href;
const ROWS_URL = new URL("../src/store/message-rows.js", import.meta.url).href;
/** `bin/cli.js` 帮助里承诺的退出码：没有 `--final-guard` 的成功 run 是 4（verification=skipped）。 */
const EXIT_NOT_VERIFIED = 4;
const LEDGER_SUFFIX = ".jsonl";
const CORRUPT_MARK = ".corrupt.";
/** 旧 CLI 默认位置（不在默认 PATH 里，必须绝对路径）。 */
const LEGACY_CLI_ENV = "ERIX_LEGACY_CLI";
const LEGACY_VERSION_ENV = "ERIX_LEGACY_CLI_VERSION";
const LEGACY_VERSION = "0.22.0";
/** 老形状的正文轮行：键以 `:engine:round:<n>` 结尾且带非空 `messages`（改造前的写侧形状）。 */
const OLD_SHAPE_ROUND_KEY = /:engine:round:\d+$/;

/** 旧 CLI 缺席的稳定代号（进 skip 文案，便于事后 grep 是哪一类）。 */
const LEGACY_GAP_CODES = Object.freeze({
  LEGACY_CLI_MISSING: "legacy_cli_missing",
  LEGACY_CLI_UNUSABLE: "legacy_cli_unusable",
  LEGACY_CLI_VERSION_MISMATCH: "legacy_cli_version_mismatch",
});

// ---------------------------------------------------------------------------
// 判据（**纯函数**：反向证要在子进程里跑同一份逻辑，所以这里不许有闭包）
// ---------------------------------------------------------------------------

const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : []);
const messagesOf = (row) => (Array.isArray(row?.messages) ? row.messages : []);

/**
 * 逻辑消息指纹（跨行/跨状态计数用）。
 * 工具块按**配对 id** 认（`use:<id>` / `res:<tool_use_id>`）；正文块按文本认（超长截断只为让
 * 失败文案可读，前 200 字符相同的两条长消息会被判成同一条——本文件的断言里没有这种场景，
 * 有的话它会让「恰好 1 份」**偏松**，所以下方 R2 额外用条数对撞）。
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
 * 第 2 组的两条硬判据，**一次算完**（同一份逻辑给主用例与反向证的子进程共用）：
 * ① 老行原样透传（逐行 `JSON.stringify` 相等）；② 每条老消息按指纹恰好 1 份。
 * 无闭包依赖（只吃 `blocksOf` / `messagesOf` / `fingerprintMessage` / `foldLedgerMessages`），
 * 所以可以被 `Function.prototype.toString()` 搬进子进程——反向证的「同一组断言必须红」
 * 因此不是另写一份近似判据。
 *
 * @param {any[]} records `store.load()` 的返回值
 * @param {any[]} rawRows 直接读原始 JSONL 得到的行
 */
function legacyReadProbe(records, rawRows) {
  const problems = [];
  const duplicateProblems = [];
  if (records.length !== rawRows.length) {
    problems.push(`行数不一致：store.load() 给出 ${records.length} 条，原始 JSONL ${rawRows.length} 行`
      + "（老账本没有消息行 ⇒ 不该有任何一行被折叠吸走）");
  }
  const limit = Math.min(records.length, rawRows.length);
  for (let index = 0; index < limit; index += 1) {
    const read = JSON.stringify(records[index]);
    const raw = JSON.stringify(rawRows[index]);
    if (read !== raw) {
      problems.push(`第 ${index} 行读出来与原始 JSONL 不逐字相等（读=${read.slice(0, 90)} ｜ 原=${raw.slice(0, 90)}）`);
    }
  }
  const expected = new Map();
  for (const row of rawRows) {
    for (const message of messagesOf(row)) {
      const key = fingerprintMessage(message);
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
  }
  const folded = foldLedgerMessages(records).map((entry) => entry.message);
  const actual = new Map();
  for (const message of folded) {
    const key = fingerprintMessage(message);
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  for (const [key, count] of expected) {
    const got = actual.get(key) ?? 0;
    if (got !== count) duplicateProblems.push(`期望 ${count} 份、实得 ${got} 份：${key.slice(0, 90)}`);
  }
  const readMessages = records.reduce((sum, row) => sum + messagesOf(row).length, 0);
  const rawMessages = rawRows.reduce((sum, row) => sum + messagesOf(row).length, 0);
  if (readMessages !== rawMessages) {
    problems.push(`老行自带 messages 的条数变了：读出来 ${readMessages} 条，原始 JSONL ${rawMessages} 条`);
  }
  return { problems, duplicateProblems, logicalCount: folded.length, readMessages, rawMessages };
}

/**
 * **不用 src 的实现**独立数一遍「应该有几条逻辑消息」：每条非分片行贡献 `messages.length`，
 * 分片行（`partOf` 指认首片）贡献 0（折叠会把它接回首片那条）。与折叠输出对撞：
 * 少 = 折叠吞正文，多 = 双喂。
 */
function independentLogicalCount(rows) {
  let count = 0;
  for (const row of rows) {
    const messages = messagesOf(row);
    if (messages.length === 0) continue;
    if (row?.kind === MESSAGE_ROW_KIND && typeof row.partOf === "string" && row.partOf !== "") continue;
    count += messages.length;
  }
  return count;
}

/** 老形状的正文轮行（改造前的写侧形状：无 `kind`、键 `:engine:round:<n>`、带正文）。 */
function isOldShapeBodyRow(row) {
  if (row?.kind === MESSAGE_ROW_KIND) return false;
  const key = String(row?.dedupKey ?? row?.roundKey ?? "");
  return OLD_SHAPE_ROUND_KEY.test(key) && messagesOf(row).length > 0;
}

/**
 * 新形状的消息行：`kind:"message"` + 轮内序号 `seq` + `dedupKey === "<runId>:msg:<round>:<seq>"`。
 * 键**逐字**比对（不是正则近似）：工单钉的就是这个字面形状。
 */
function isNewShapeMessageRow(row, runId) {
  if (row?.kind !== MESSAGE_ROW_KIND) return false;
  if (!Number.isSafeInteger(row?.seq) || !Number.isSafeInteger(row?.round)) return false;
  return row.dedupKey === `${String(runId)}:msg:${String(row.round)}:${String(row.seq)}`;
}

/** `=== 终稿 ===` 与 `=== 统计 ===` 之间那段（续跑那次的模型可见面）。 */
function finalDraft(stdout) {
  const head = "=== 终稿 ===";
  const start = stdout.indexOf(head);
  if (start === -1) return "";
  const rest = stdout.slice(start + head.length);
  const end = rest.indexOf("=== 统计 ===");
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** CLI 的统计行（`=== 统计 === model=… rounds=… termination=…`）。 */
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
// 旧 CLI 闸门（分类 skip，不许把「没装旧 CLI」写成红）
// ---------------------------------------------------------------------------

/**
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 * @returns {{ ok: true, path: string, version: string }
 *   | { ok: false, code: string, message: string, path?: string }}
 */
export function resolveLegacyCli({ env = process.env, home = homedir() } = {}) {
  const override = env[LEGACY_CLI_ENV];
  const cliPath = typeof override === "string" && override.trim() !== ""
    ? resolve(override.trim())
    : join(home, ".npm-global", "bin", "erix");
  const expected = typeof env[LEGACY_VERSION_ENV] === "string" && env[LEGACY_VERSION_ENV].trim() !== ""
    ? env[LEGACY_VERSION_ENV].trim()
    : LEGACY_VERSION;
  if (!existsSync(cliPath)) {
    return {
      ok: false,
      code: LEGACY_GAP_CODES.LEGACY_CLI_MISSING,
      path: cliPath,
      message: `旧 CLI 不存在：${cliPath}（期望 ${expected}）。跨版本 e2e 需要一份**真的旧写侧**产账本；`
        + `没装不是红，判 skip。装法示例：npm i -g erix-agent@${expected}（或设 ${LEGACY_CLI_ENV} 指到已有的旧 CLI）`,
    };
  }
  const probe = spawnSync(cliPath, ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (probe.error !== undefined && probe.error !== null) {
    return {
      ok: false,
      code: LEGACY_GAP_CODES.LEGACY_CLI_UNUSABLE,
      path: cliPath,
      message: `旧 CLI 在但跑不起来：${cliPath} --version 失败（${probe.error?.code ?? probe.error?.message ?? probe.error}）`
        + " ⇒ 判 skip（不是断言失败）",
    };
  }
  if (probe.status !== 0) {
    return {
      ok: false,
      code: LEGACY_GAP_CODES.LEGACY_CLI_UNUSABLE,
      path: cliPath,
      message: `旧 CLI 在但 --version 退出码 ${String(probe.status)}（stderr 尾部：`
        + `${JSON.stringify(String(probe.stderr ?? "").slice(-200))}）⇒ 判 skip（不是断言失败）`,
    };
  }
  const version = String(probe.stdout ?? "").trim();
  if (version !== expected) {
    return {
      ok: false,
      code: LEGACY_GAP_CODES.LEGACY_CLI_VERSION_MISMATCH,
      path: cliPath,
      message: `旧 CLI 版本是 ${JSON.stringify(version)}，本用例要 ${expected}（${cliPath}）`
        + `——别的版本产出的账本形状不是本用例要验的那一份；要换版本设 ${LEGACY_VERSION_ENV}`,
    };
  }
  return { ok: true, path: cliPath, version };
}

// ---------------------------------------------------------------------------
// 账本读侧（原始读：**不修复尾部**，只把「完整行」与「末尾残段」分开）
// ---------------------------------------------------------------------------

function listLedgerFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(LEDGER_SUFFIX)).sort() : [];
}

function listCorruptFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.includes(CORRUPT_MARK)).sort() : [];
}

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

/**
 * 把 transcript 文件名映回 `store.load(runId)` 要的 runId。旧 CLI 自生成的 id 本身就是安全 id，
 * 所以先直接用文件名，再用「`safeRunId(候选)` 对应的文件确实存在」确认（不安全 id 会被哈希，不可逆）。
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

// ---------------------------------------------------------------------------
// 子进程 / 隔离对账 / 反向证工具
// ---------------------------------------------------------------------------

/**
 * 带**可清除**定时器的竞速（超时只是兜底上限，正常路径从不命中）：
 * `Promise.race([promise, delay(n)])` 会让那个 `setTimeout` 一直挂着，进程要多活 n 毫秒。
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

/** 起一个子进程并收集 stdout/stderr；`done` 在退出时兑现（永不 reject）。 */
function startProcess(command, args, { cwd, env }) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

/** 跑完一个 CLI 子进程（超时兜底；超时也返回结构化结果，由断言报红）。 */
async function runProcess(command, args, options, timeoutMs) {
  const { child, done } = startProcess(command, args, options);
  return withTimeout(done, timeoutMs, () => {
    child.kill("SIGKILL");
    return { code: -1, signal: "TIMEOUT", stdout: "", stderr: `本用例的 ${timeoutMs}ms 上限到了` };
  });
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

const md5Of = (buffer) => createHash("md5").update(buffer).digest("hex");
const hashFileIfExists = (file) => (existsSync(file)
  ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)
  : "（不存在）");

/** 透传分支的原文与「破坏版」——反向证只换这一行（`foldable === 0` 时强制清空 `messages`）。 */
const PASSTHROUGH_LINE = "  if (foldable === 0) return records;";
const BROKEN_PASSTHROUGH_LINE = "  if (foldable === 0) return records.map((record) => ({ ...record, messages: [] }));";

/**
 * 反向证用的子进程脚本：**同一份** `legacyReadProbe`（`toString()` 搬过去）跑在**新进程**里，
 * 于是它能看见被临时破坏的折叠层（主用例进程里的模块早已缓存，改了源码它也不会变）。
 */
function buildProbeScript() {
  return [
    `import { createFileTranscriptStore } from ${JSON.stringify(INDEX_URL)};`,
    `import { foldLedgerMessages } from ${JSON.stringify(ROWS_URL)};`,
    `import { readFileSync } from "node:fs";`,
    `const blocksOf = ${blocksOf.toString()};`,
    `const messagesOf = ${messagesOf.toString()};`,
    `const fingerprintMessage = ${fingerprintMessage.toString()};`,
    `const legacyReadProbe = ${legacyReadProbe.toString()};`,
    `const rawRows = readFileSync(process.env.XV_RAW, "utf8").split("\\n")`,
    `  .filter((line) => line.trim() !== "").map((line) => JSON.parse(line));`,
    `const store = createFileTranscriptStore({ dir: process.env.XV_DIR });`,
    `const records = await store.load(process.env.XV_RUNID);`,
    `process.stdout.write(JSON.stringify({ ...legacyReadProbe(records, rawRows), recordCount: records.length }));`,
  ].join("\n");
}

/** 在子进程里跑一次第 2 组的判据（`dir` / `runId` / 原始 JSONL 路径经环境变量传）。 */
async function probeInChild({ dir, runId, rawPath }) {
  const result = await runProcess(process.execPath, ["--input-type=module", "-e", buildProbeScript()], {
    cwd: dir,
    env: { ...process.env, XV_DIR: dir, XV_RUNID: runId, XV_RAW: rawPath },
  }, 60_000);
  assert.equal(result.code, 0,
    `反向证子进程退出码 ${String(result.code)}（stderr 尾部：${JSON.stringify(result.stderr.slice(-400))}）`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`反向证子进程没吐出 JSON：${String(result.stdout).slice(0, 300)}（${error?.message ?? ""}）`);
  }
}

// ---------------------------------------------------------------------------
// 离线自检（始终跑，不联网）：钉住本文件的判据本身，防止它们悄悄退化成永远为真
// ---------------------------------------------------------------------------

test("断言集自身的不变量：旧形状/新形状判据、原样透传、恰好 1 份、终稿解析都会响（始终跑，不联网）", () => {
  const runId = "self-check";
  const oldSeed = {
    round: 0, roundKey: `${runId}:round:0`, dedupKey: `${runId}:engine:round:0:seed`,
    messages: [{ role: "user", content: [{ type: "text", text: "任务" }] }],
  };
  const oldRound = {
    round: 1, roundKey: `${runId}:round:1`, dedupKey: `${runId}:engine:round:1`,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "先读文件" },
        { type: "tool_use", id: "t1", name: "readFile", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "内容" }] },
    ],
  };
  const newRow = {
    round: 2, kind: MESSAGE_ROW_KIND, seq: 0, dedupKey: `${runId}:msg:2:0`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "终稿" }] }],
  };
  const newRoundRow = { round: 2, dedupKey: `${runId}:engine:round:2`, roundKey: `${runId}:round:2` };
  const inputRow = { round: 1, dedupKey: `${runId}:input:123:abc`, messages: [{ role: "user", content: [{ type: "text", text: "追问" }] }] };

  // ① 老形状判据：老轮行命中；新消息行 / 新轮行（无正文）/ 宿主 `:input:` 行都不许命中。
  assert.equal(isOldShapeBodyRow(oldRound), true, "带正文的 :engine:round:<n> 行必须判成老形状");
  assert.equal(isOldShapeBodyRow(oldSeed), false,
    "种子行的键以 :seed 结尾、不是 :engine:round:<n> ⇒ 不算「老形状正文轮行」（它的正文照样透传，只是不参与这条判据）");
  assert.equal(isOldShapeBodyRow(newRow), false, "kind:message 行不是老形状轮行");
  assert.equal(isOldShapeBodyRow(newRoundRow), false, "没有正文的轮行不是老形状正文行");
  assert.equal(isOldShapeBodyRow(inputRow), false, "宿主 :input: 行不是老形状轮行");

  // ② 新形状判据：键必须逐字等于 <runId>:msg:<round>:<seq>。
  assert.equal(isNewShapeMessageRow(newRow, runId), true, "kind:message + seq + 逐字键 = 新形状");
  assert.equal(isNewShapeMessageRow({ ...newRow, dedupKey: `${runId}:msg:9:0` }, runId), false,
    "键里的轮号对不上就不算新形状（不许用正则近似放过）");
  assert.equal(isNewShapeMessageRow({ ...newRow, seq: undefined }, runId), false, "没有 seq 不算引擎消息行");
  assert.equal(isNewShapeMessageRow(oldRound, runId), false, "老轮行不是新形状");

  // ③ 原样透传 + 恰好 1 份：老账本（无消息行）读出来必须与原始行逐字相等、每条消息 1 份。
  const oldRows = [oldSeed, oldRound];
  const clean = legacyReadProbe(oldRows, oldRows);
  assert.deepEqual(clean.problems, [], `老账本原样透传不该有 problem：${clean.problems.join(" ｜ ")}`);
  assert.deepEqual(clean.duplicateProblems, [], `老账本每条消息应恰好 1 份：${clean.duplicateProblems.join(" ｜ ")}`);
  assert.equal(clean.logicalCount, 3, "种子 1 + assistant 1 + 结果 1 = 3 条逻辑消息");

  // ④ 反向证的**期望红**先在这里钉住（不联网也能证明破坏确实会被抓到）：
  //    「透传分支被破坏」= 老行 messages 被清空 ⇒ 逐字相等红 + 每条消息实得 0 份红。
  const broken = legacyReadProbe(oldRows.map((row) => ({ ...row, messages: [] })), oldRows);
  assert.ok(broken.problems.some((line) => line.includes("不逐字相等")),
    `清空 messages 必须让「原样透传」红，实际 problems=${JSON.stringify(broken.problems)}`);
  assert.equal(broken.duplicateProblems.length, 3,
    `清空 messages 必须让 3 条老消息各报「实得 0 份」，实际 ${JSON.stringify(broken.duplicateProblems)}`);
  //    「折叠层把老正文再折一遍」= 同一条消息出现两次 ⇒ 指纹计数抓到 2。
  const duplicated = legacyReadProbe([oldSeed, oldRound, { ...oldRound, dedupKey: `${runId}:engine:round:9` }],
    [oldSeed, oldRound]);
  assert.ok(duplicated.problems.some((line) => line.includes("行数不一致")),
    "多出来的一行必须被行数判据抓到");
  assert.ok(duplicated.duplicateProblems.some((line) => line.includes("期望 1 份、实得 2 份")),
    `双写同一份正文必须被指纹计数抓成 2，实际 ${JSON.stringify(duplicated.duplicateProblems)}`);

  // ⑤ 独立计数与折叠输出同口径（老账本 3 条；混入新消息行后 4 条；分片行不新增逻辑消息）。
  const mixed = [oldSeed, oldRound, inputRow, newRow, newRoundRow];
  assert.equal(independentLogicalCount(mixed), 5, "独立计数：种子 1 + 轮 1 两条 + :input: 1 + 新消息 1");
  assert.equal(foldLedgerMessages(foldMessageRows(mixed)).length, 5, "折叠输出应与独立计数一致");
  const fragment = { ...newRow, seq: 1, dedupKey: `${runId}:msg:2:1`, partOf: `${runId}:msg:2:0` };
  assert.equal(independentLogicalCount([...mixed, fragment]), 5, "分片行不得新增逻辑消息");
  assert.equal(foldLedgerMessages(foldMessageRows([...mixed, fragment])).length, 5, "折叠也不得新增逻辑消息");

  // ⑥ 终稿解析：只取 `=== 终稿 ===` 与 `=== 统计 ===` 之间那段。
  const stdout = "噪声\n=== 终稿 ===\nTOKEN-1 是答案\n=== 统计 === model=m rounds=1\n";
  assert.equal(finalDraft(stdout), "TOKEN-1 是答案", "终稿解析必须只取正文段");
  assert.equal(finalDraft("没有终稿"), "", "没有终稿时返回空串（不许抛）");
});

// ---------------------------------------------------------------------------
// 真上游 + 真旧 CLI 段
// ---------------------------------------------------------------------------

test("跨版本 e2e：0.22.0 写的账本 → 0.23.0 读（原样透传/恰好一份）→ 同 --session 续跑（字节前缀/新形状/不重复喂）", {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    t.skip(`真上游不可用/闸门关：${formatSkip(gate)}`);
    return;
  }
  const legacy = resolveLegacyCli();
  if (!legacy.ok) {
    t.skip(`旧 CLI 不可用：${formatSkip(legacy)}`);
    return;
  }
  console.log(`[13] 闸门开：model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)}`
    + `｜旧 CLI=${legacy.path} version=${legacy.version}`);

  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const realErix = join(realHome, ".erix");
  const realTranscripts = join(realErix, "transcripts");
  const configHashBefore = hashFileIfExists(gate.configPath);
  const erixSnapshotBefore = snapshotDir(realErix);

  const root = mkdtempSync(join(tmpdir(), TMP_PREFIX.crossVersion));
  const cleanup = () => { rmSync(root, { recursive: true, force: true }); };
  process.once("exit", cleanup);

  /** 逐条 PASS/FAIL 打点：报告要贴的就是这张表，一条红不掩盖其余结果。 */
  const failures = [];
  const check = (id, fn, detail = "") => {
    try {
      fn();
      console.log(`PASS [13] ${id}${detail ? `  — ${detail}` : ""}`);
    } catch (error) {
      failures.push(id);
      console.log(`FAIL [13] ${id}  — ${String(error?.message ?? error).split("\n")[0]}`
        + (detail ? ` ｜ 现场：${detail}` : ""));
    }
  };
  /** @type {string[]} */ const notes = [];
  /** 反向证里临时破坏过的源码必须在任何退出路径上还原。 */
  let pendingRestore;

  try {
    // 每次跑用**全新**的 token：模型不可能先验知道，于是「续跑终稿里出现了它」只能来自历史。
    const tokenA = `ALPHA-${randomBytes(4).toString("hex")}`;
    const betaText = `BETA-${randomBytes(4).toString("hex")}`;

    const work = join(root, "work");
    const transcripts = join(root, "transcripts");
    mkdirSync(work, { recursive: true });
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(work, "a.txt"), `第一行 token=${tokenA}\n第二行 没有关键字\n`, "utf8");
    writeFileSync(join(work, "b.txt"), `${betaText}\n`, "utf8");

    const commonArgs = [
      "--config", gate.configPath,
      "--dir", transcripts,
      "--max-rounds", "6",
      "--reflection", "off",
      "--no-notes",
      "--no-todo",
    ];
    const env = { ...process.env };
    const RUN_TIMEOUT_MS = 300_000;

    // ================= 第 1 组：用**旧 CLI** 产出 0.22.0 形状的老账本 =================
    // 任务要「需要 ≥1 次工具」：两个 readFile（工具真的执行过，账本里才有 tool_result 块）。
    // 不带 `--session`（见文件头：0.22.0 的 `--session` 是续跑入口，新会话会被它挡掉 exit 1）。
    const oldPrompt = "请用 readFile 依次读取 a.txt 与 b.txt，然后用一句话同时报出 a.txt 里的 token"
      + " 与 b.txt 的内容。";
    const legacyExit = await runProcess(legacy.path, ["chat", oldPrompt, ...commonArgs], { cwd: work, env }, RUN_TIMEOUT_MS);
    const legacyStats = parseStats(legacyExit.stdout);
    console.log(`[13] 旧 CLI（${legacy.version}）退出码=${legacyExit.code}`
      + `${legacyExit.signal ? ` signal=${legacyExit.signal}` : ""}`
      + `｜统计行=${legacyStats === undefined ? "（没有）" : legacyStats.line}`);
    console.log(`[13] 旧 CLI stdout 尾部：\n${legacyExit.stdout.slice(-600).split("\n").map((line) => `      ${line}`).join("\n")}`);
    if (legacyExit.stderr.trim() !== "") {
      console.log(`[13] 旧 CLI stderr 尾部：${legacyExit.stderr.slice(-400)}`);
    }

    const oldLedger = readLedger(transcripts);
    assert.notEqual(oldLedger.file, null,
      `旧 CLI 没有在 --dir 里留下账本（退出码 ${String(legacyExit.code)}；`
      + `stderr 尾部：${JSON.stringify(legacyExit.stderr.slice(-400))}）`);
    const oldLedgerName = oldLedger.file.split("/").pop();
    const runId = resolveRunIdForTranscript(transcripts, oldLedgerName);
    const oldRaw = oldLedger.raw;
    const oldRows = oldLedger.rows;
    const oldLogical = foldLedgerMessages(oldRows).map((entry) => entry.message);
    const oldCounts = new Map();
    for (const message of oldLogical) {
      const key = fingerprintMessage(message);
      oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1);
    }
    const oldMaxRound = Math.max(0, ...oldRows.map((row) => (Number.isSafeInteger(row?.round) ? row.round : 0)));
    console.log(`[13] 老账本：runId=${runId}｜${oldRows.length} 行 / ${oldRaw.length} 字节 / `
      + `${oldLogical.length} 条逻辑消息｜最大轮=${oldMaxRound}`);

    check("L1 旧 CLI 正常收尾（退出码 4 = verification skipped，termination=end_turn）", () => {
      assert.equal(legacyExit.code, EXIT_NOT_VERIFIED,
        `旧 CLI 退出码 ${String(legacyExit.code)}${legacyExit.signal ? `（signal=${legacyExit.signal}）` : ""}`
        + `，期望 ${EXIT_NOT_VERIFIED}；stderr 尾部：${JSON.stringify(legacyExit.stderr.slice(-300))}`);
      assert.ok(legacyStats !== undefined, `旧 CLI 没有打出统计行：${JSON.stringify(legacyExit.stdout.slice(-300))}`);
      assert.equal(legacyStats.termination, "end_turn", `旧 CLI 终止原因=${String(legacyStats.termination)}`);
    }, legacyStats === undefined ? "统计行缺失" : legacyStats.line);

    check("L2 老账本是 0.22.0 形状：没有 kind:\"message\" 行、没有 :msg: 键、轮行自带正文", () => {
      assert.deepEqual(oldLedger.parseErrors, [], `老账本中间行解析失败：${oldLedger.parseErrors.join(" | ")}`);
      assert.equal(oldLedger.partial, "", "旧 CLI 干净收尾的账本不该有末尾残段");
      const kindRows = oldRows.filter((row) => row?.kind === MESSAGE_ROW_KIND);
      assert.deepEqual(kindRows.map((row) => row.dedupKey), [], "老账本里不该有 kind:\"message\" 消息行");
      const msgKeys = oldRows.map((row) => String(row?.dedupKey ?? "")).filter((key) => key.includes(":msg:"));
      assert.deepEqual(msgKeys, [], "老账本里不该有 :msg:<round>:<seq> 键");
      assert.ok(oldRows.some(isOldShapeBodyRow),
        `老账本里没有「轮行自带 messages」的行（= 不是改造前的形状）：`
        + JSON.stringify(oldRows.map((row) => ({ k: row?.dedupKey, n: messagesOf(row).length }))));
    }, `${oldRows.length} 行，其中老形状正文行 ${oldRows.filter(isOldShapeBodyRow).length} 行`);

    check("L3 老账本里真的跑过工具（有 tool_result 块，且 ≥1 次调用）", () => {
      const results = oldLogical.flatMap(blocksOf).filter((block) => block?.type === "tool_result");
      assert.ok(results.length >= 1, `老账本里一个 tool_result 都没有 ⇒ 场景没成立（换提示词，别放宽断言）`);
      const uses = oldLogical.flatMap(blocksOf).filter((block) => block?.type === "tool_use");
      assert.ok(uses.length >= 1, "老账本里一个 tool_use 都没有");
      assert.equal(results.map((block) => String(block?.tool_use_id)).sort().join(","),
        uses.map((block) => String(block?.id)).sort().join(","), "tool_use 与 tool_result 的 id 没配对");
    }, `tool_use ${oldLogical.flatMap(blocksOf).filter((block) => block?.type === "tool_use").length} 个`);

    // ================= 第 2 组：新代码读它（store.load 折叠输出）=================
    assert.equal(safeRunId(runId), runId,
      `旧 CLI 生成的 id 不是安全 id（${runId}）⇒ 文件名被哈希、store.load 拿不到它，本用例的映射口径失效`);
    const store = createFileTranscriptStore({ dir: transcripts });
    const readRecords = await store.load(runId);
    const readProbe = legacyReadProbe(readRecords, oldRows);
    console.log(`[13] store.load()：${readRecords.length} 条 record`
      + `（原始 ${oldRows.length} 行）｜折叠 ${readProbe.logicalCount} 条逻辑消息`
      + `｜自带 messages 共 ${readProbe.readMessages} 条`);

    check("R1 老行原样透传：逐行与直接读原始 JSONL 的对应行逐字相等", () => {
      assert.deepEqual(readProbe.problems, [], readProbe.problems.join(" ｜ "));
      assert.ok(readRecords.length >= 3, `store.load() 只给出 ${readRecords.length} 条 record，判据落空`);
    }, `${readRecords.length} 行逐字相等`);

    check("R2 折叠不产生重复：每条逻辑消息按内容指纹**恰好 1 份**", () => {
      assert.deepEqual(readProbe.duplicateProblems, [], readProbe.duplicateProblems.join(" ｜ "));
      assert.ok(readProbe.logicalCount >= 3, `折叠输出只有 ${readProbe.logicalCount} 条逻辑消息，判据落空`);
    }, `${readProbe.logicalCount} 条逻辑消息 / ${new Set(oldLogical.map(fingerprintMessage)).size} 个不同指纹`);

    check("R3 没有消息行不影响读出结果：record.messages 仍在，条数与逻辑条数都对得上", () => {
      assert.equal(readRecords.filter((row) => row?.kind === MESSAGE_ROW_KIND).length, 0,
        "老账本读出来竟然带了 kind:\"message\" 行");
      assert.ok(readRecords.some((row) => messagesOf(row).length > 0), "读出来的 record 一个 messages 都没有");
      assert.equal(readProbe.readMessages, readProbe.rawMessages,
        `自带 messages 条数 ${readProbe.readMessages} ≠ 原始 ${readProbe.rawMessages}`);
      assert.equal(readProbe.logicalCount, independentLogicalCount(oldRows),
        `折叠条数 ${readProbe.logicalCount} ≠ 独立计数 ${independentLogicalCount(oldRows)}`);
    }, `record.messages 共 ${readProbe.readMessages} 条`);

    // ================= 第 3 组：新代码续跑它 =================
    // 续跑前把 a.txt **删掉**：token 只留在账本（与 0.22.0 快照）里，模型能说出来就只能是从历史里看到的。
    // 这一步同时挡住「模型又读了一遍文件」这种假绿（resume-real-e2e 的 E4 只能记备注，这里把它变成判据）。
    rmSync(join(work, "a.txt"), { force: true });
    // 续跑前把侧档（state/status）的原始字节也留一份：S6 的「账本单独」副本要用续跑前的状态。
    const sidecarBefore = {};
    for (const suffix of [".state.json", ".status.json"]) {
      const path = join(transcripts, `${safeRunId(runId)}${suffix}`);
      if (existsSync(path)) sidecarBefore[suffix] = readFileSync(path);
    }

    const resumePrompt = `继续上一轮（${runId}）：请只用一句话同时报出 a.txt 里的 token 与 b.txt 的内容。`
      + "历史里已经有这些数据了，不要再调用工具。";
    const resumeExit = await runProcess(process.execPath,
      [CLI, "chat", resumePrompt, "--session", runId, ...commonArgs], { cwd: work, env }, RUN_TIMEOUT_MS);
    const resumeStats = parseStats(resumeExit.stdout);
    const resumeDraft = finalDraft(resumeExit.stdout);
    console.log(`[13] 续跑退出码=${resumeExit.code}${resumeExit.signal ? ` signal=${resumeExit.signal}` : ""}`
      + `｜统计行=${resumeStats === undefined ? "（没有）" : resumeStats.line}`);
    console.log(`[13] 续跑终稿：${JSON.stringify(resumeDraft)}`);
    if (resumeExit.stderr.trim() !== "") {
      console.log(`[13] 续跑 stderr 尾部：${resumeExit.stderr.slice(-400)}`);
    }

    const afterLedger = readLedger(transcripts);
    const afterRaw = afterLedger.raw;
    const afterRows = afterLedger.rows;
    const appended = afterRows.slice(oldRows.length);
    const appendedNewShape = appended.filter((row) => isNewShapeMessageRow(row, runId));
    const afterFolded = foldLedgerMessages(afterRows).map((entry) => entry.message);
    const afterCounts = new Map();
    for (const message of afterFolded) {
      const key = fingerprintMessage(message);
      afterCounts.set(key, (afterCounts.get(key) ?? 0) + 1);
    }
    console.log(`[13] 续跑后账本：${afterRows.length} 行（新增 ${appended.length} 行）`
      + `｜新形状消息行 ${appendedNewShape.length} 行`
      + `｜新增键=${JSON.stringify(appended.map((row) => String(row?.dedupKey ?? "").split(":").slice(-3).join(":")))}`);

    check("S1 续跑成功：退出码 4 + 统计行 termination=end_turn、truncated=false", () => {
      assert.equal(resumeExit.code, EXIT_NOT_VERIFIED,
        `续跑退出码 ${String(resumeExit.code)}${resumeExit.signal ? `（signal=${resumeExit.signal}）` : ""}，`
        + `期望 ${EXIT_NOT_VERIFIED}；stderr 尾部：${JSON.stringify(resumeExit.stderr.slice(-300))}`);
      assert.ok(resumeStats !== undefined, `续跑没有打出统计行：${JSON.stringify(resumeExit.stdout.slice(-300))}`);
      assert.equal(resumeStats.truncated, "false", `续跑被截断（truncated=${String(resumeStats.truncated)}）`);
      assert.equal(resumeStats.termination, "end_turn", `续跑终止原因=${String(resumeStats.termination)}`);
    }, resumeStats === undefined ? "统计行缺失" : resumeStats.line);

    check("S2 老行是字节前缀（历史没被改写）+ 没有 .corrupt.* 隔离文件", () => {
      assert.ok(oldRaw.length > 0, "老账本为空，前缀判据落空");
      assert.equal(afterRaw.startsWith(oldRaw), true,
        `续跑改写了老账本已落盘的字节（前缀对不上）：老 ${oldRaw.length} 字节 / 续跑后 ${afterRaw.length} 字节`);
      assert.equal(afterLedger.partial, "", "续跑后账本必须以换行收尾（不该有末尾残段）");
      assert.deepEqual(listCorruptFiles(transcripts), [],
        "干净收尾的老账本不该被 repairTranscriptTail 当成半行隔离");
      assert.deepEqual(afterLedger.parseErrors, [], `续跑后账本中间行解析失败：${afterLedger.parseErrors.join(" | ")}`);
    }, `前缀 ${oldRaw.length} 字节 → 共 ${afterRaw.length} 字节`);

    check("S3 新追加的行是新形状：kind:\"message\" + dedupKey=<runId>:msg:<round>:<seq>；且没有老形状正文轮行", () => {
      assert.ok(appended.length > 0, "续跑一行也没写（根本没接上）");
      assert.ok(appendedNewShape.length >= 1,
        `新增行里没有一条新形状消息行：${JSON.stringify(appended.map((row) => ({
          k: row?.dedupKey, kind: row?.kind, seq: row?.seq,
        })))}`);
      const wrongShape = appended.filter((row) => row?.kind === MESSAGE_ROW_KIND && !isNewShapeMessageRow(row, runId));
      assert.deepEqual(wrongShape.map((row) => row.dedupKey), [],
        "有 kind:\"message\" 行的 dedupKey 不是 <runId>:msg:<round>:<seq>");
      const oldShapeBody = appended.filter(isOldShapeBodyRow);
      assert.deepEqual(oldShapeBody.map((row) => row.dedupKey), [],
        "续跑写下了老形状的正文轮行（无 kind + :engine:round:<n> + 带 messages）= 两种形状混写");
      const namespaced = appended.every((row) => String(row?.dedupKey ?? "").startsWith(`${runId}:`));
      assert.equal(namespaced, true, "新增行的 dedupKey 没有落在本 run 的命名空间里");
      const rewound = appended.filter((row) => Number.isSafeInteger(row?.round) && row.round < oldMaxRound);
      assert.deepEqual(rewound.map((row) => `${String(row.round)}:${String(row.dedupKey)}`), [],
        `续跑写下了轮号小于老账本最大轮（${oldMaxRound}）的行`);
    }, `${appended.length} 行新增，其中新形状消息行 ${appendedNewShape.length} 行`);

    check("S4 折叠后老消息**恰好各 1 份**（不重复喂）+ 总条数 = 独立计数", () => {
      const repeated = [];
      for (const [key, count] of oldCounts) {
        const got = afterCounts.get(key) ?? 0;
        if (got !== count) repeated.push(`老消息期望 ${count} 份、续跑后 ${got} 份：${key.slice(0, 90)}`);
      }
      assert.deepEqual(repeated, [], repeated.join(" ｜ "));
      for (const row of appended) {
        if (!isNewShapeMessageRow(row, runId)) continue;
        if (typeof row.partOf === "string" && row.partOf !== "") continue;
        for (const message of messagesOf(row)) {
          const got = afterCounts.get(fingerprintMessage(message)) ?? 0;
          assert.equal(got, 1, `续跑新增的消息在折叠输出里出现 ${got} 次（应恰好 1 次）：`
            + `${fingerprintMessage(message).slice(0, 80)}`);
        }
      }
      assert.equal(afterFolded.length, independentLogicalCount(afterRows),
        `折叠条数 ${afterFolded.length} ≠ 独立计数 ${independentLogicalCount(afterRows)}`
        + "（少 = 折叠吞正文，多 = 双喂）");
      assert.equal(afterFolded.length, oldLogical.length + independentLogicalCount(appended),
        `续跑后的逻辑条数 ${afterFolded.length} ≠ 老 ${oldLogical.length} + 新增 ${independentLogicalCount(appended)}`);
    }, `老 ${oldLogical.length} 条 → 续跑后 ${afterFolded.length} 条`);

    check("S5 续跑那次的终稿里出现老账本里的 token（a.txt 已删 ⇒ 只能来自历史）", () => {
      assert.equal(existsSync(join(work, "a.txt")), false, "续跑前 a.txt 必须已删除（否则这条判据没有牙齿）");
      assert.ok(resumeDraft !== "", `续跑没有终稿段：${JSON.stringify(resumeExit.stdout.slice(-400))}`);
      assert.equal(resumeDraft.includes(tokenA), true,
        `续跑终稿里没有老账本里的 token ${tokenA}（模型没看到历史？）终稿=${JSON.stringify(resumeDraft.slice(0, 300))}`);
      const reread = appended
        .filter((row) => isNewShapeMessageRow(row, runId))
        .flatMap((row) => messagesOf(row))
        .flatMap(blocksOf)
        .filter((block) => block?.type === "tool_result" && String(block?.content ?? "").includes(tokenA));
      assert.deepEqual(reread, [], "续跑那次又「读到」了含 token 的工具结果（a.txt 已删 ⇒ 不该有）");
    }, `token=${tokenA}｜终稿长度 ${resumeDraft.length}`);

    // ================= S6：快照缺席也能续跑（正文一律来自账本）=================
    // 0.23.0 的恢复契约是「正文一律来自账本，快照只剩在飞工具」。跨版本场景要单独钉一次：
    // 把**续跑前**的账本原样搬到另一个 --dir、只留账本与 state/status 侧档（**不带** 0.22.0 的
    // `.snapshot.json`），同一个 --session 再续跑一次 —— 老正文必须还在，token 仍必须出现在终稿里。
    const ledgerOnlyDir = join(root, "transcripts-ledger-only");
    mkdirSync(ledgerOnlyDir, { recursive: true });
    writeFileSync(join(ledgerOnlyDir, `${safeRunId(runId)}${LEDGER_SUFFIX}`), oldRaw, "utf8");
    for (const [suffix, bytes] of Object.entries(sidecarBefore)) {
      writeFileSync(join(ledgerOnlyDir, `${safeRunId(runId)}${suffix}`), bytes);
    }
    assert.equal(existsSync(join(ledgerOnlyDir, `${safeRunId(runId)}.snapshot.json`)), false,
      "S6 的副本里不该有 0.22.0 的 .snapshot.json（这一条要验的就是快照缺席）");

    const ledgerOnlyExit = await runProcess(process.execPath, [
      CLI, "chat", resumePrompt, "--session", runId,
      ...commonArgs.map((arg) => (arg === transcripts ? ledgerOnlyDir : arg)),
    ], { cwd: work, env }, RUN_TIMEOUT_MS);
    const ledgerOnlyStats = parseStats(ledgerOnlyExit.stdout);
    const ledgerOnlyDraft = finalDraft(ledgerOnlyExit.stdout);
    const ledgerOnlyLedger = readLedger(ledgerOnlyDir);
    console.log(`[13] 账本单独续跑（无快照）退出码=${ledgerOnlyExit.code}`
      + `｜统计行=${ledgerOnlyStats === undefined ? "（没有）" : ledgerOnlyStats.line}`);
    console.log(`[13] 账本单独续跑终稿：${JSON.stringify(ledgerOnlyDraft)}`);

    check("S6 只留账本（删掉 0.22.0 快照）也能续跑，token 仍在终稿里（正文来源 = 账本）", () => {
      assert.equal(ledgerOnlyExit.code, EXIT_NOT_VERIFIED,
        `账本单独续跑退出码 ${String(ledgerOnlyExit.code)}；stderr 尾部：${JSON.stringify(ledgerOnlyExit.stderr.slice(-300))}`);
      assert.equal(ledgerOnlyStats?.termination, "end_turn", `终止原因=${String(ledgerOnlyStats?.termination)}`);
      assert.equal(ledgerOnlyLedger.raw.startsWith(oldRaw), true, "账本单独续跑改写了老账本已落盘的字节");
      assert.equal(ledgerOnlyDraft.includes(tokenA), true,
        `账本单独续跑的终稿里没有老 token ${tokenA}：${JSON.stringify(ledgerOnlyDraft.slice(0, 300))}`);
    }, `无快照续跑后账本 ${ledgerOnlyLedger.rows.length} 行`);

    // ================= 第 4 组：反向证（临时破坏透传分支 ⇒ R1/R2 必须红）=================
    // 反向证要在**纯老账本**上做：破坏点 `foldable === 0` 只在「整个数组里没有可折叠消息行」时生效，
    // 而续跑后的账本里已经有新形状消息行（foldable > 0）⇒ 拿它当靶子会让破坏变成空操作（假绿）。
    // 所以把**续跑前**的老账本字节原样放回一个只读靶子目录，probe 只读它。
    const reverseDir = join(root, "transcripts-old-only");
    mkdirSync(reverseDir, { recursive: true });
    const reverseRawPath = join(reverseDir, `${safeRunId(runId)}${LEDGER_SUFFIX}`);
    writeFileSync(reverseRawPath, oldRaw, "utf8");
    const probeArgs = { dir: reverseDir, runId, rawPath: reverseRawPath };
    // 先跑一次**未破坏**的对照：证明子进程这套判据不是「永远红」。
    const controlProbe = await probeInChild(probeArgs);
    const originalBytes = readFileSync(ROWS_FILE);
    const originalMd5 = md5Of(originalBytes);
    let brokenProbe;
    let restoredMd5;
    let restoreError;
    try {
      const text = originalBytes.toString("utf8");
      const hits = text.split(PASSTHROUGH_LINE).length - 1;
      assert.equal(hits, 1,
        `折叠层的透传分支定位失败（命中 ${hits} 次，期望 1 次）——源码变了就要更新本用例的破坏点，`
        + `不许静默跳过反向证：${PASSTHROUGH_LINE}`);
      writeFileSync(ROWS_FILE, text.replace(PASSTHROUGH_LINE, BROKEN_PASSTHROUGH_LINE), "utf8");
      pendingRestore = () => { writeFileSync(ROWS_FILE, originalBytes); };
      process.once("exit", pendingRestore);
      brokenProbe = await probeInChild(probeArgs);
    } finally {
      if (pendingRestore !== undefined) {
        process.removeListener("exit", pendingRestore);
        try {
          pendingRestore();
        } catch (error) {
          restoreError = error;
        }
        pendingRestore = undefined;
      }
      restoredMd5 = md5Of(readFileSync(ROWS_FILE));
    }
    console.log(`[13] 反向证：对照 probe=${JSON.stringify({
      problems: controlProbe.problems.length, duplicates: controlProbe.duplicateProblems.length,
      logical: controlProbe.logicalCount,
    })}｜破坏后 probe=${JSON.stringify({
      problems: brokenProbe?.problems?.length, duplicates: brokenProbe?.duplicateProblems?.length,
      logical: brokenProbe?.logicalCount,
    })}｜md5 前=${originalMd5} 后=${restoredMd5}`);
    console.log(`[13] 反向证红样（破坏后子进程 probe 的第一条 R1 / R2）：\n`
      + `      R1: ${String(brokenProbe?.problems?.[0] ?? "（无）").slice(0, 220)}\n`
      + `      R2: ${String(brokenProbe?.duplicateProblems?.[0] ?? "（无）").slice(0, 220)}`);

    check("X1 对照：未破坏时子进程 probe 全绿（判据不是永远红）", () => {
      assert.deepEqual(controlProbe.problems, [], `对照 probe 报红：${controlProbe.problems.join(" ｜ ")}`);
      assert.deepEqual(controlProbe.duplicateProblems, [], `对照 probe 报重复：${controlProbe.duplicateProblems.join(" ｜ ")}`);
      assert.equal(controlProbe.logicalCount, readProbe.logicalCount,
        `子进程 probe 的逻辑条数 ${controlProbe.logicalCount} 与主进程 ${readProbe.logicalCount} 不一致`);
    }, `problems=0 duplicates=0 logical=${controlProbe.logicalCount}`);

    check("X2 破坏透传分支（foldable===0 时强制 messages: []）⇒ R1「原样透传」与 R2「恰好 1 份」都红", () => {
      assert.ok(brokenProbe.problems.length > 0,
        `破坏后「原样透传」竟然还是绿的（problems 为空）——R1 没有牙齿：${JSON.stringify(brokenProbe)}`);
      assert.ok(brokenProbe.problems.some((line) => line.includes("不逐字相等")),
        `破坏后 R1 的失败文案里没有「不逐字相等」：${JSON.stringify(brokenProbe.problems)}`);
      assert.equal(brokenProbe.duplicateProblems.length, oldCounts.size,
        `破坏后 R2 应报 ${oldCounts.size} 条（每条老消息指纹一条），实得 ${brokenProbe.duplicateProblems.length} 条：`
        + `${JSON.stringify(brokenProbe.duplicateProblems)}`);
      assert.ok(brokenProbe.duplicateProblems.every((line) => line.includes("实得 0 份")),
        `破坏后 R2 应报「实得 0 份」：${JSON.stringify(brokenProbe.duplicateProblems)}`);
    }, `problems=${brokenProbe.problems.length} duplicates=${brokenProbe.duplicateProblems.length}`);

    check("X3 源码 md5 逐字还原（临时破坏不留痕）", () => {
      assert.equal(restoreError, undefined, `还原源码时抛错：${String(restoreError?.message ?? restoreError)}`);
      assert.equal(restoredMd5, originalMd5, `src/store/message-rows.js 的 md5 变了：${originalMd5} → ${restoredMd5}`);
      assert.equal(readFileSync(ROWS_FILE).length, originalBytes.length, "还原后字节数不一致");
    }, `md5=${restoredMd5}（${originalBytes.length} 字节）`);

    // ================= 隔离对账（真实 ~/.erix 一个字节都不许动）=================
    check("Z1 真实 ~/.erix 没被写：选中配置哈希不变 + 真实 transcripts/outputs 下没有本次 run 的产物", () => {
      assert.equal(hashFileIfExists(gate.configPath), configHashBefore,
        `闸门选中的配置 ${gate.configPath} 被改写了（${configHashBefore} → ${hashFileIfExists(gate.configPath)}）`);
      const leaked = [`${safeRunId(runId)}${LEDGER_SUFFIX}`, `${safeRunId(runId)}.snapshot.json`,
        `${safeRunId(runId)}.state.json`, `${safeRunId(runId)}.status.json`]
        .filter((name) => existsSync(join(realTranscripts, name)));
      assert.deepEqual(leaked, [], `真实 ~/.erix/transcripts 下出现了本次 run 的文件（--dir 没生效？）：${leaked.join(",")}`);
      assert.equal(existsSync(join(realErix, "outputs", safeRunId(runId))), false,
        "真实 ~/.erix/outputs 下出现了本次 run 的归档目录");
      assert.equal(existsSync(join(realHome, ".erix", `${safeRunId(runId)}${LEDGER_SUFFIX}`)), false,
        "HOME 下的 ~/.erix 根目录出现了本次账本");
    }, `~/.erix 快照：前=${JSON.stringify(erixSnapshotBefore)} 后=${JSON.stringify(snapshotDir(realErix))}`);

    for (const note of notes) console.log(`[13] 备注：${note}`);
    const erixSnapshotAfter = snapshotDir(realErix);
    if (erixSnapshotAfter.files !== erixSnapshotBefore.files
      || erixSnapshotAfter.newest !== erixSnapshotBefore.newest) {
      // 整棵 ~/.erix 的前后快照只作**备注**：开发者机器上同时可能有别的 session 在写（与本用例无关，
      // 算成污染就是假红）。有牙齿的是 Z1 里那几条精确断言。
      console.log(`[13] 备注：整棵 ~/.erix 的快照变了（可能是别的 session 写的，非本用例所为）：`
        + `前=${JSON.stringify(erixSnapshotBefore)} 后=${JSON.stringify(erixSnapshotAfter)}`);
    }

    assert.deepEqual(failures, [], `真机段失败的断言：${failures.join(", ")}`);
  } finally {
    if (pendingRestore !== undefined) {
      process.removeListener("exit", pendingRestore);
      pendingRestore();
    }
    process.removeListener("exit", cleanup);
    cleanup();
  }
});
