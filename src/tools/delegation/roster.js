// @ts-check
/**
 * issue #617（P1a）——派生（子 run）名册：状态记录 + 原子落盘 + 陈旧重算（**纯簿记**）。
 *
 * 库/宿主边界（本刀的裁决，写在每个模块头上）：
 *   - **不 fork / 不 spawn / 不等子进程**——子 run 怎么跑起来归宿主；本模块只提供一个宿主
 *     可以调用的簿记面（记录、读回、重算）。
 *   - **不解释 opaque 字段**：`termination`、`verification` 等原样存、原样取，库绝不根据
 *     它们改状态。唯一例外是 `state`（封闭 7 值，见 `ROSTER_STATES`），且库只负责
 *     「活态 → `interrupted`」这一种重算方向。
 *   - 需要外部事实（进程活着吗）时**由宿主注入谓词**（`isProcessAlive`）；本模块不碰
 *     `/proc`、不碰 `process.kill(pid, 0)`。
 *
 * 设计判据（照两个真实实现的面，不带它们的宿主语义进来）：
 *   - 记录面参考 pi-subagents 的 `AsyncStatus`（字段名沿用同一套词汇：runId / parentRunId /
 *     state / cwd / model / createdAt / updatedAt / endedAt / deadlineAt / timedOut / pid …），
 *     但收敛到工单钉死的 **21 项**（#630 S1 由 18 项 +3：`resultText` / `resultTruncated` /
 *     `errorMessage`——后台子 run 的终稿与失败原因必须能从名册里取回，见 `tool.js` 的
 *     `finishRun`）；除 `state` 外全部 opaque。
 *   - 落盘一条记录一个文件 `<rosterDir>/<runId>.json`，写必须**原子**（同目录临时文件 +
 *     `rename`）——半写出的 JSON 比没有更糟（重算会把它当损坏或更糟，当活态）。
 *   - **文件名不是身份来源**：记录内的 `runId` 必须等于文件名；不等 ⇒ 视为损坏，点名报出
 *     （`listRecords` 的 `corrupt` / `reconcile` 的 `corrupt`），**不猜、不就地改名修复**。
 *   - **`updatedAt` 单调**（时钟回拨不许让它倒退）：写路径只在新值 ≥ 磁盘旧值时前移，
 *     等价于保留更高者。
 *   - 陈旧重算的「无人认领 ⇒ `interrupted`」依据 pi-web 的判据：**状态文件说活态，但没有任何
 *     活着的所有者** ⇒ 判 interrupted（子凭空消失，父最需要知道）。本进程是不是所有者由宿主
 *     显式给 `ownedRunIds`；跨宿主同目录的存活子 run 由宿主谓词 `isProcessAlive(pid)` 兜底，
 *     命中则列 `foreignOwned`、不动记录。
 *   - 重算**幂等**：活态才会被改；`interrupted` 之后再跑一万次也不会再动它。
 *
 * 「不给的字段不写」沿用 P0（#617）的纪律：undefined / 空串占位一律不落盘。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * @typedef {Object} RosterRecord
 * @property {string} runId                 子 run 身份（同时是文件名；两者必须相等）
 * @property {string} [parentRunId]         父 run 身份（`config.run.parentRunId` 同一口径；opaque）
 * @property {"queued"|"running"|"completed"|"failed"|"aborted"|"timeout"|"interrupted"} state
 * @property {string} [cwd]                 opaque
 * @property {string} [model]               opaque
 * @property {string} [taskDigest]          opaque
 * @property {number} createdAt             opaque（宿主时钟；库只比较不解释）
 * @property {number} updatedAt             单调递增水位（写路径保证不回退）
 * @property {number} [endedAt]             opaque
 * @property {number} [deadlineAt]          opaque
 * @property {boolean} [timedOut]           opaque
 * @property {*} [termination]              opaque：原样存取，库不解释
 * @property {*} [verification]             opaque：原样存取，库不解释
 * @property {*} [notifyStatus]             opaque：原样存取，库不解释
 * @property {*} [wakeStatus]               opaque：原样存取，库不解释
 * @property {string} [statusPath]          opaque
 * @property {string} [transcriptPath]      opaque
 * @property {number} [pid]                 宿主记下的进程号；库只把它递给宿主谓词
 * @property {string} [resultText]          子 run 的终稿（issue #630 S1；写侧由 `tool.js` 截到
 *                                          `RESULT_TEXT_LIMIT` = 4000 字符，名册只存不算）
 * @property {boolean} [resultTruncated]    `resultText` 被截断过 ⇒ 恰好写 `true`（没截断就不写这个键）
 * @property {string} [errorMessage]        子 run 抛错时的错误文本（issue #630 S1；写侧截到
 *                                          `ERROR_MESSAGE_LIMIT` = 1000 字符），正常结束不写
 */

/** 名册 `state` 的封闭取值（工单钉死 7 个；其余一律不得写进名册）。 */
export const ROSTER_STATES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
  "timeout",
  "interrupted",
]);

const STATE_SET = new Set(ROSTER_STATES);

/** 活态：只有这两种 `state` 会参与陈旧重算；终态记录永不重算（幂等的根基）。 */
export const ROSTER_LIVE_STATES = Object.freeze(["queued", "running"]);

/** 一条损坏记录的点名片面（`corrupt` 数组的元素）。 */
/**
 * @typedef {Object} CorruptEntry
 * @property {string} file   损坏文件（相对名册目录的文件名）
 * @property {string} runId  文件名推出来的身份（仅作点名用，不采用）
 * @property {string} reason 损坏依据
 */

/** 记录里除身份/状态/水位外，原样搬运的可选字段白名单（「不给的字段不写」）。 */
const OPTIONAL_KEYS = [
  "parentRunId",
  "cwd",
  "model",
  "taskDigest",
  "createdAt",
  "endedAt",
  "deadlineAt",
  "timedOut",
  "termination",
  "verification",
  "notifyStatus",
  "wakeStatus",
  "statusPath",
  "transcriptPath",
  "pid",
  // issue #630 S1：后台子 run 的终稿 / 截断标记 / 失败原因（`result` 动作要带回它们，
  // 所以它们必须和终态**同一次写**落盘——不是事后补写第二遍）。
  "resultText",
  "resultTruncated",
  "errorMessage",
];

let tmpCounter = 0;

/** runId 必须能安全当文件名用：拒路径分隔符与 `..`（不拒就等于是给路径穿越开门）。 */
function assertSafeRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError(`roster: runId 必须是非空字符串，收到 ${JSON.stringify(runId)}`);
  }
  if (runId.includes("/") || runId.includes("\\") || runId === "." || runId === ".." || runId.includes("..")) {
    throw new TypeError(`roster: runId 含路径危险字符，拒绝当文件名用: ${JSON.stringify(runId)}`);
  }
}

/**
 * 把调用方给的记录收敛成落盘形态：只带 21 项里的已给字段，undefined / 空串一律不写。
 * @param {RosterRecord} record
 * @returns {RosterRecord}
 */
function cleanRecord(record) {
  assertSafeRunId(record.runId);
  if (!STATE_SET.has(record.state)) {
    throw new TypeError(
      `roster: state 必须是封闭 7 值之一（${ROSTER_STATES.join("|")}），收到 ${JSON.stringify(record.state)}`
    );
  }
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) {
    throw new TypeError(`roster: updatedAt 必须是有限数字（单调水位的比较对象），收到 ${JSON.stringify(record.updatedAt)}`);
  }
  /** @type {Record<string, *>} */
  const out = { runId: record.runId, state: record.state, updatedAt: record.updatedAt };
  for (const key of OPTIONAL_KEYS) {
    const value = record[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return /** @type {RosterRecord} */ (out);
}

/** 原子写：同目录临时文件 + rename（rename 同目录内是原子的；跨目录不是，所以临时文件必须落在名册目录里）。 */
function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** 读一个名册文件并做「文件名 == 记录 runId」的损坏校核；不合法返回 null（由调用方点名）。 */
function parseRosterFile(dir, file) {
  const runIdFromName = file.replace(/\.json$/u, "");
  /** @type {*} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.runId !== runIdFromName) return null;
  return /** @type {RosterRecord} */ (parsed);
}

/**
 * 原子写（或覆盖）一条名册记录。`updatedAt` 单调：磁盘上已有更高水位时保留旧值（时钟回拨
 * 不许让记录的水位倒退），其余字段按本次调用收敛后的形态落盘。
 *
 * @param {string} rosterDir 名册目录
 * @param {RosterRecord} record 记录（21 项面；未给的可选字段不落盘）
 * @returns {RosterRecord} 实际落盘的记录（`updatedAt` 可能因单调规则高于入参）
 */
export function writeRecord(rosterDir, record) {
  const next = cleanRecord(record);
  const file = join(rosterDir, `${next.runId}.json`);
  const existing = existsSync(file) ? parseRosterFile(rosterDir, `${next.runId}.json`) : null;
  if (existing && existing.updatedAt > next.updatedAt) {
    next.updatedAt = existing.updatedAt;
  }
  atomicWriteJson(file, next);
  return next;
}

/**
 * 按 runId 读回一条记录。文件损坏（解析失败或身份不符）抛带文件名的错——按 runId 寻址时
 * 没有「跳过」的余地，调用方必须知道它点名要的记录不可信。
 *
 * @param {string} rosterDir
 * @param {string} runId
 * @returns {RosterRecord | null} 不存在返回 null
 */
export function readRecord(rosterDir, runId) {
  assertSafeRunId(runId);
  const file = `${runId}.json`;
  if (!existsSync(join(rosterDir, file))) return null;
  const parsed = parseRosterFile(rosterDir, file);
  if (parsed === null) {
    throw new Error(`roster: 记录文件损坏（解析失败或文件名与记录 runId 不符）: ${join(rosterDir, file)}`);
  }
  return parsed;
}

/**
 * 遍历名册：好记录进 `records`，损坏文件逐个进 `corrupt` 点名（**不猜、不修复、不静默丢**）。
 *
 * @param {string} rosterDir
 * @returns {{ records: RosterRecord[], corrupt: CorruptEntry[] }}
 */
export function listRecords(rosterDir) {
  /** @type {RosterRecord[]} */
  const records = [];
  /** @type {CorruptEntry[]} */
  const corrupt = [];
  if (!existsSync(rosterDir)) return { records, corrupt };
  for (const file of readdirSync(rosterDir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = parseRosterFile(rosterDir, file);
    if (parsed === null) {
      let reason = "JSON 解析失败或非对象";
      try {
        const raw = JSON.parse(readFileSync(join(rosterDir, file), "utf8"));
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof raw.runId === "string") {
          reason = `文件名身份 ${JSON.stringify(file.replace(/\.json$/u, ""))} 与记录 runId ${JSON.stringify(raw.runId)} 不符`;
        }
      } catch {
        // 解析失败已是 reason 的默认值，无需补充。
      }
      corrupt.push({ file, runId: file.replace(/\.json$/u, ""), reason });
      continue;
    }
    records.push(parsed);
  }
  return { records, corrupt };
}

/**
 * 删一条名册记录（终态归档由宿主决定何时删；库只提供幂等的删除原语）。
 * @param {string} rosterDir
 * @param {string} runId
 * @returns {boolean} 是否真删了文件
 */
export function removeRecord(rosterDir, runId) {
  assertSafeRunId(runId);
  const file = join(rosterDir, `${runId}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/**
 * 陈旧重算（本模块的核心，判据照 pi-web：状态文件说活态但没有活的所有者 ⇒ interrupted）。
 *
 * 对每条**活态**（`queued` / `running`）记录：
 *   1. `runId ∈ ownedRunIds`（本进程确实是它的所有者）⇒ 不动；
 *   2. 给了 `isProcessAlive` 且记录带 `pid` 且谓词说活着 ⇒ **不动**，但列进 `foreignOwned`
 *      （可能是另一宿主在同一目录里的子 run——点名让宿主看见，不替宿主裁决）；
 *   3. 否则 ⇒ 写成 `interrupted`。 **`endedAt` = 该记录原来的 `updatedAt`，不是 `now`**——
 *      依据：没有任何东西把它做完，所以最后一次已知时间才是事实；探到「它没了」的这个
 *      时刻不是结束时刻（pi-web 的完成标记同样只认记录自己声明的时间）。`updatedAt` 照常
 *      前移到 `now`（单调规则保证不回退）。
 *
 * 幂等：终态记录永不进入上面三条，第二次跑不会再改、不会再产生新的 `interrupted`。
 * 损坏文件原样进 `corrupt` 点名，不参与重算也不计入 `unchanged`。
 *
 * @param {string} rosterDir
 * @param {Object} options
 * @param {string[]} [options.ownedRunIds] 本进程拥有的子 run 集合（宿主注入的事实）
 * @param {(pid: number) => boolean} [options.isProcessAlive] 宿主注入的存活谓词；库不自己探 pid
 * @param {number} options.now 宿主时钟当前值（required；库不内部硬取时间，便于测试与时钟 discipline）
 * @returns {{ interrupted: Array<{runId: string, endedAt: number, previousUpdatedAt: number, reason: string}>,
 *             foreignOwned: Array<{runId: string, pid: number, reason: string}>,
 *             corrupt: CorruptEntry[],
 *             unchanged: number }}
 */
export function reconcile(rosterDir, { ownedRunIds = [], isProcessAlive, now }) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError(`roster.reconcile: now 必须是有限数字（宿主时钟），收到 ${JSON.stringify(now)}`);
  }
  const owned = new Set(ownedRunIds);
  const { records, corrupt } = listRecords(rosterDir);
  /** @type {Array<{runId: string, endedAt: number, previousUpdatedAt: number, reason: string}>} */
  const interrupted = [];
  /** @type {Array<{runId: string, pid: number, reason: string}>} */
  const foreignOwned = [];
  let unchanged = 0;
  for (const record of records) {
    if (!ROSTER_LIVE_STATES.includes(record.state)) {
      unchanged += 1;
      continue;
    }
    if (owned.has(record.runId)) {
      unchanged += 1;
      continue;
    }
    if (typeof isProcessAlive === "function" && typeof record.pid === "number" && isProcessAlive(record.pid)) {
      foreignOwned.push({
        runId: record.runId,
        pid: record.pid,
        reason: "isProcessAlive(pid) 为真：可能是另一宿主在同一目录里的子 run，不动记录",
      });
      unchanged += 1;
      continue;
    }
    // 无人认领 ⇒ interrupted；endedAt 取**原记录的 updatedAt**（最后一次已知时间），不是 now。
    const endedAt = record.updatedAt;
    writeRecord(rosterDir, { ...record, state: "interrupted", endedAt, updatedAt: now });
    interrupted.push({
      runId: record.runId,
      endedAt,
      previousUpdatedAt: record.updatedAt,
      reason: "活态记录既不在 ownedRunIds 内、也无存活谓词兜底：没有任何东西把它做完",
    });
  }
  return { interrupted, foreignOwned, corrupt, unchanged };
}
