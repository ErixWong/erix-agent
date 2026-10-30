// @ts-check
/**
 * issue #617（P1a）——派生（子 run）并发配额租约（**纯簿记**）。
 *
 * 边界与 `roster.js` 同一份裁决：不 fork / 不 spawn / 不等子进程；不解释 opaque 字段；
 * 需要「进程活着吗」这种外部事实时**由宿主注入谓词**（`isProcessAlive`），本模块不碰
 * `/proc`、不碰 `process.kill(pid, 0)`。
 *
 * 原语：`<leaseDir>/<runId>.lock` 用 `open(..., "wx")` **独占创建**当租约——抢不到的唯一
 * 依据就是文件已存在（`EEXIST`），这是文件系统给的原子判据，不需要第二个权威。租约内容
 * 只三本账：`{ runId, pid, acquiredAt }`；`acquiredAt` 取**调用方传入的 `now`**，库不内部
 * 硬取时间（测试才能钉住时钟，宿主才能贯彻自己的时钟 discipline）。
 *
 * 回收（`sweep`）的两条分支是 **OR 语义**（#617 P1b 对 P1a 字面读法的行为修正：谓词是
 * **额外的早收信号**，不是替换——P1a 那版「给了谓词就只按 pid 死活收、年龄分支失效」自己在
 * 风险里点名最容易用错的一格，裁决改掉）：
 *   收 = (给了谓词 且 租约带 `pid` 且 谓词说死)  **或**  (超过 `maxAgeMs` 且 `runId ∉ ownedRunIds`)。
 * 两条各自独立命中即收，逐条给理由：
 *   1. 租约带 `pid` 且宿主给了谓词且谓词说死了 ⇒ 收（理由 `pid-dead`）；
 *   2. 超过 `maxAgeMs` 且 `runId ∉ ownedRunIds` ⇒ 收（理由 `stale-unowned`）——超龄又无主，
 *      不管谓词说活说死都收（谓词说活却超龄无主，恰恰更像「pid 复用的活进程挂着死租约」）；
 *      没给 `maxAgeMs` 则这条不命中。
 * 谓词给了但租约不带 `pid` 的，分支 1 不命中，只能靠分支 2（带了 `maxAgeMs` 时）收——
 * 保守：宁留孤儿，不误杀活租约。
 *
 * 「不给的字段不写」沿用 P0（#617）的纪律：`pid` 没给就不落这个键。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {Object} Lease
 * @property {string} runId      租约身份（同时是文件名）
 * @property {number} [pid]      宿主记下的持约进程号；库只把它递给宿主谓词
 * @property {number} acquiredAt 宿主时钟的获取时刻（调用方传入，库不硬取）
 */

/** @typedef {{ file: string, runId: string, reason: string }} LeaseCorruptEntry */

/** 独占创建用的旗标：wx = 写 + 排他（文件已存在即 EEXIST，不存在则创建）。 */
const EXCLUSIVE_WRITE = "wx";

let tmpCounter = 0;

function assertSafeRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError(`capacity: runId 必须是非空字符串，收到 ${JSON.stringify(runId)}`);
  }
  if (runId.includes("/") || runId.includes("\\") || runId === "." || runId === ".." || runId.includes("..")) {
    throw new TypeError(`capacity: runId 含路径危险字符，拒绝当文件名用: ${JSON.stringify(runId)}`);
  }
}

/**
 * 收敛租约内容为落盘形态：只带 `{ runId, pid, acquiredAt }`，不给的键不写。
 * @param {string} runId
 * @param {number} acquiredAt
 * @param {number} [pid]
 * @returns {Lease}
 */
function cleanLease(runId, acquiredAt, pid) {
  if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) {
    throw new TypeError(`capacity: acquiredAt 必须是有限数字（调用方传入的 now），收到 ${JSON.stringify(acquiredAt)}`);
  }
  /** @type {Lease} */
  const lease = { runId, acquiredAt };
  if (pid !== undefined) lease.pid = pid;
  return lease;
}

/**
 * 抢租约：`<leaseDir>/<runId>.lock` 独占创建。已存在 = 抢不到，返回当前持有者
 * （尽力解析租约文件；解析不出来也点名文件并标 `corrupt`，不静默丢）。
 *
 * @param {string} leaseDir
 * @param {Object} options
 * @param {string} options.runId
 * @param {number} [options.pid]   持约进程号（宿主记；库只存取、不探活）
 * @param {number} options.now     宿主时钟当前值（写入 acquiredAt）
 * @returns {{ ok: true, lease: Lease } | { ok: false, reason: "held", holder: (Lease & {corrupt?: boolean}) | { runId: string, corrupt: true } }}
 */
export function acquire(leaseDir, { runId, pid, now }) {
  assertSafeRunId(runId);
  const lease = cleanLease(runId, now, pid);
  mkdirSync(leaseDir, { recursive: true });
  const file = join(leaseDir, `${runId}.lock`);
  let fd;
  try {
    fd = openSync(file, EXCLUSIVE_WRITE);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") {
      return { ok: false, reason: "held", holder: readHolderBestEffort(file, runId) };
    }
    throw err;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(lease)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  return { ok: true, lease };
}

/** 抢不到时的持有者点名：尽力解析；解析失败返回带 `corrupt` 标记的文件身份。
 * @param {string} file
 * @param {string} runIdFromName
 * @returns {(Lease & {corrupt?: boolean}) | { runId: string, corrupt: true }}
 */
function readHolderBestEffort(file, runIdFromName) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = /** @type {Record<string, *>} */ (parsed);
      /** @type {Record<string, *>} */
      const holder = { runId: typeof raw.runId === "string" ? raw.runId : runIdFromName };
      if (typeof raw.pid === "number") holder.pid = raw.pid;
      if (typeof raw.acquiredAt === "number") holder.acquiredAt = raw.acquiredAt;
      return /** @type {Lease & {corrupt?: boolean}} */ (holder);
    }
  } catch {
    // fallthrough：解析失败按损坏点名。
  }
  return { runId: runIdFromName, corrupt: true };
}

/**
 * 还租约。幂等：文件不存在也算成功（返回 `released: false`），重复还不报错。
 *
 * @param {string} leaseDir
 * @param {string} runId
 * @returns {{ ok: true, released: boolean }}
 */
export function release(leaseDir, runId) {
  assertSafeRunId(runId);
  const file = join(leaseDir, `${runId}.lock`);
  try {
    unlinkSync(file);
    return { ok: true, released: true };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return { ok: true, released: false };
    }
    throw err;
  }
}

/** 读一个租约文件并校核「文件名 == 租约 runId」；不合法返回 null（由调用方点名）。 */
function parseLeaseFile(dir, file) {
  const runIdFromName = file.replace(/\.lock$/u, "");
  /** @type {*} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.runId !== runIdFromName) return null;
  return /** @type {Lease} */ (parsed);
}

/**
 * 当前租约清单。损坏文件逐个进 `corrupt` 点名（**不静默丢**），不参与任何统计。
 *
 * @param {string} leaseDir
 * @returns {{ leases: Array<Lease & {file: string}>, corrupt: LeaseCorruptEntry[] }}
 */
export function list(leaseDir) {
  /** @type {Array<Lease & {file: string}>} */
  const leases = [];
  /** @type {LeaseCorruptEntry[]} */
  const corrupt = [];
  if (!existsSync(leaseDir)) return { leases, corrupt };
  for (const file of readdirSync(leaseDir)) {
    if (!file.endsWith(".lock")) continue;
    const parsed = parseLeaseFile(leaseDir, file);
    if (parsed === null) {
      corrupt.push({ file, runId: file.replace(/\.lock$/u, ""), reason: "JSON 解析失败、非对象或文件名与租约 runId 不符" });
      continue;
    }
    leases.push({ ...parsed, file });
  }
  return { leases, corrupt };
}

/**
 * 回收孤儿租约。**OR 语义**（两条各自独立命中即收，见文件头）：谓词说死（分支 1）**或**
 * 超龄且非本进程（分支 2，不再要求「没给谓词」）。逐条给理由；两条都不命中的保留并计数。
 * 损坏文件进 `corrupt` 点名，不收。
 *
 * @param {string} leaseDir
 * @param {Object} options
 * @param {number} [options.maxAgeMs]        超龄阈值（谓词没给时分支 2 用）
 * @param {string[]} [options.ownedRunIds]   本进程拥有的子 run 集合（宿主注入的事实）
 * @param {(pid: number) => boolean} [options.isProcessAlive] 宿主注入的存活谓词
 * @param {number} options.now               宿主时钟当前值（required）
 * @returns {{ swept: Array<{runId: string, file: string, reason: "pid-dead"|"stale-unowned"}>,
 *             corrupt: LeaseCorruptEntry[],
 *             kept: number }}
 */
export function sweep(leaseDir, { maxAgeMs, ownedRunIds = [], isProcessAlive, now }) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError(`capacity.sweep: now 必须是有限数字（宿主时钟），收到 ${JSON.stringify(now)}`);
  }
  const owned = new Set(ownedRunIds);
  const { leases, corrupt } = list(leaseDir);
  /** @type {Array<{runId: string, file: string, reason: "pid-dead"|"stale-unowned"}>} */
  const swept = [];
  let kept = 0;
  for (const lease of leases) {
    if (
      typeof isProcessAlive === "function" &&
      typeof lease.pid === "number" &&
      !isProcessAlive(lease.pid)
    ) {
      unlinkSync(join(leaseDir, lease.file));
      swept.push({ runId: lease.runId, file: lease.file, reason: "pid-dead" });
      continue;
    }
    // 分支 2（OR 语义，#617 P1b）：超龄且非本进程即收——谓词给没给都不影响这条；谓词说活
    // 但租约超龄又无主，更像 pid 复用的活进程挂着死租约，照样按 stale 收。
    if (
      typeof maxAgeMs === "number" &&
      now - lease.acquiredAt > maxAgeMs &&
      !owned.has(lease.runId)
    ) {
      unlinkSync(join(leaseDir, lease.file));
      swept.push({ runId: lease.runId, file: lease.file, reason: "stale-unowned" });
      continue;
    }
    kept += 1;
  }
  return { swept, corrupt, kept };
}
