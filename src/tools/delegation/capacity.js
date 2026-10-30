// @ts-check
/**
 * issue #617（P1a）/ issue #630 S3 —— 派生（子 run）并发配额租约（**纯簿记**）。
 *
 * 边界与 `roster.js` 同一份裁决：不 fork / 不 spawn / 不等子进程；不解释 opaque 字段；
 * 需要「进程活着吗」这种外部事实时**由宿主注入谓词**（`isProcessAlive`），本模块不碰
 * `/proc`、不碰 `process.kill(pid, 0)`。
 *
 * ## 为什么从「每 runId 一份锁」改成「固定槽位池」（issue #630 S3）
 *
 * 旧实现是**先数后建**：`list()` 数一遍目录里的 `<runId>.lock`，数到 `maxConcurrent` 就拒，
 * 否则再 `acquire`。两个进程可以同时读到 `max-1` 然后各自建锁 ⇒ **超发**；而且崩溃进程留下的
 * 锁没有任何人回收（工厂只调 `acquire` / `list` / `release`，从不调 `sweep`）。
 *
 * 新原语是**固定槽位池**：租约目录里放 `slot-<i>.lock`（`i ∈ [0, maxConcurrent)`）。
 * 抢占 = 依次对每一格 `open(path, "wx")`：
 *
 *   - 成功 ⇒ 立刻写入租约内容 `{ runId, pid, acquiredAt, slot }` 并返回 `{ ok: true, lease }`；
 *   - `EEXIST` ⇒ 读这一格的持有者，判定它是否可回收（见下）；可回收就**回收后重试本格一次**，
 *     不可回收就去看下一格；
 *   - 全部格子都被活租约占着 ⇒ `{ ok: false, reason: "capacity_full", holders: [...] }`。
 *
 * **原子性由 `wx` 保证**：同一个槽位文件同一时刻只能被一个进程创建成功，所以「判定配额」与
 * 「占住配额」是**同一次系统调用**，不存在「两个进程都数到 max-1」的窗口。这是本模块唯一的
 * 权威判据，不要在这里重新引入任何「先数后建」。
 *
 * ## 回收判据：谓词优先，`maxAgeMs` 只是没有谓词时的兜底
 *
 *   - 宿主给了 `isProcessAlive` **且**租约里记了 `pid` ⇒ **以谓词为准**：说死才收，说活就一个
 *     字节都不动（哪怕它已经超龄——pid 复用的活进程挂着死租约，宁可留孤儿也不误杀活租约）；
 *   - 没有谓词（或租约里没有 `pid`，谓词无从判定）⇒ `now - acquiredAt > maxAgeMs` 才收。
 *     `maxAgeMs` 缺省 {@link DEFAULT_LEASE_MAX_AGE_MS}（30 分钟）——**这是兜底判据，不是权威判据**：
 *     它的作用是「宿主没接谓词时，崩溃的租约不会永远占着配额」，不是「到点就没收」。
 *     所以子 run 的时间预算（CLI 的 `--delegate-timeout-ms`，缺省 10 分钟）应当**小于**它。
 *
 * 回收只发生在**抢占失败**这条路径上（没有守护进程、没有定时清理）：没有进程抢格子，就没有人
 * 回收，代价是崩溃租约可能一直占着配额，直到下一次有人抢同一个格子。
 *
 * ## 回收为什么不会误删（读—判定—再确认后 unlink）
 *
 * 槽位文件**只以 `wx` 创建、创建后内容一次写成、此后永不改写** ⇒ 对某个 inode 来说，内容字节
 * 就是持有者身份的稳定指纹。于是回收走三步，绝不「直接 unlink 再重试」：
 *
 *   1. `snapshotSlot()` 用**同一个 fd** 做 `fstat` + `read`（不是两次独立读取拼起来的），拿到
 *      「inode 号 + 内容字节」这一份一致的快照，并据此判定持有者死活；
 *   2. 判定可回收之后**再快照一次**，只有 `ino` 与字节**逐字节相同**才继续——不一致说明这期间
 *      有人接管了这一格（旧持有者已被别人回收、新持有者刚写进去），此时**放弃回收**，一个字节
 *      都不删；
 *   3. 确认之后才 `unlink`，紧接着 `open(wx)` 抢回来；抢不到（`EEXIST`）说明这一格在
 *      「删完 → 重建」之间被别人合法抢走了，本进程**退让**去看下一格。
 *
 * 因此 unlink 的目标只可能是第 1 步读到、第 2 步确认仍然在盘上的那个持有者。残余窗口是第 2 步
 * 与第 3 步之间的几微秒：要落进去，必须**两个进程同时对同一格判定同一个死持有者**。它没有在
 * 本切片里闭合（Node 核心没有 flock / 条件 unlink 这类原语），代价与触发条件写在
 * `docs/host-consumer-contract.md` 的「崩溃槽回收」一节里，不在这里假装没有。
 *
 * 内容读不出来（半写、手改）的格子按 `corrupt` 点名，并且**只按文件系统自己的 mtime 判龄**
 * （`Date.now()` 对 `mtimeMs`，两侧都是文件系统的时钟；调用方传入的 `now` 描述的是宿主租约时钟，
 * 与一个读不出内容的文件无关）——这是本模块里唯一一处硬读时钟，理由是「一个读不出内容的槽位
 * 否则就永远锁死配额」，而创建与写入之间的窗口只有几微秒，所以正常路径永远不会命中它。
 *
 * ## 旧格式兼容（`<runId>.lock`）
 *
 * 老版本留下的 `<runId>.lock` **不再参与配额**（新方案只看 `slot-<i>.lock`），也**不会被主动
 * 删除**：它们是短命文件（进程退出前 `release` 就删了），留在目录里既不影响判定也不占额。
 * 本模块的所有入口（`acquire` / `list` / `release` / `sweep`）都只认 `slot-<i>.lock` 这一种形状，
 * 别的 `.lock` 文件看都不看。
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {Object} Lease
 * @property {string} runId      租约身份（持有者）
 * @property {number} slot       槽位号（= 文件名里的 i；配额池的第几格）
 * @property {number} [pid]      宿主记下的持约进程号；库只把它递给宿主谓词
 * @property {number} acquiredAt 宿主时钟的获取时刻（调用方传入，库不硬取）
 */

/** @typedef {{ file: string, slot?: number, runId?: string, reason: string }} LeaseCorruptEntry */

/** 独占创建用的旗标：wx = 写 + 排他（文件已存在即 EEXIST，不存在则创建）。 */
const EXCLUSIVE_WRITE = "wx";

/** 配额池的缺省大小（与 `createDelegateTool` 的 `maxConcurrent` 缺省一致，两处都是 2）。 */
const DEFAULT_MAX_CONCURRENT = 2;

/**
 * 没有谓词时判定「崩溃槽」的兜底阈值：30 分钟。
 *
 * 选 30 分钟的依据是它必须**明显长于一个子 run 的正常寿命**（CLI 的
 * `--delegate-timeout-ms` 缺省 10 分钟），否则会误收还在干活的租约。它**不是**权威判据——
 * 权威判据是宿主注入的 `isProcessAlive`，这里只是「宿主没接谓词时配额还能自愈」的兜底。
 */
export const DEFAULT_LEASE_MAX_AGE_MS = 30 * 60_000;

/** 槽位文件名的唯一合法形状：`slot-<非负整数>.lock`（别的 `.lock` 一律不认）。 */
const SLOT_FILE_PATTERN = /^slot-(0|[1-9][0-9]*)\.lock$/u;

/** 读不出内容的槽位文件的点名理由（`corrupt` 通道）。 */
const CORRUPT_REASON = "槽位文件读不出持有者（JSON 解析失败 / 非对象 / 缺 runId 或 acquiredAt / 内容里的 slot 与文件名不符）";

/** @param {number} index @returns {string} 第 index 格的文件名 */
function slotFileName(index) {
  return `slot-${index}.lock`;
}

/** @param {*} maxConcurrent @returns {number} */
function assertMaxConcurrent(maxConcurrent) {
  if (!Number.isInteger(maxConcurrent) || /** @type {number} */ (maxConcurrent) < 1) {
    throw new TypeError(`capacity: maxConcurrent 必须是 ≥1 的整数，收到 ${JSON.stringify(maxConcurrent)}`);
  }
  return /** @type {number} */ (maxConcurrent);
}

/** @param {*} maxAgeMs @returns {number} */
function assertMaxAgeMs(maxAgeMs) {
  if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError(`capacity: maxAgeMs 必须是正的有限数字，收到 ${JSON.stringify(maxAgeMs)}`);
  }
  return maxAgeMs;
}

/** @param {*} now @returns {number} */
function assertNow(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError(`capacity: now 必须是有限数字（宿主时钟），收到 ${JSON.stringify(now)}`);
  }
  return now;
}

/** @param {*} runId @returns {string} */
function assertSafeRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError(`capacity: runId 必须是非空字符串，收到 ${JSON.stringify(runId)}`);
  }
  if (runId.includes("/") || runId.includes("\\") || runId === "." || runId === ".." || runId.includes("..")) {
    throw new TypeError(`capacity: runId 含路径危险字符，拒绝当文件名用: ${JSON.stringify(runId)}`);
  }
  return runId;
}

/**
 * 收敛租约内容为落盘形态：只带 `{ runId, acquiredAt, pid }`，不给的键不写。
 * @param {string} runId
 * @param {number} acquiredAt
 * @param {number} [pid]
 * @returns {{ runId: string, acquiredAt: number, pid?: number }}
 */
function cleanLease(runId, acquiredAt, pid) {
  if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) {
    throw new TypeError(`capacity: acquiredAt 必须是有限数字（调用方传入的 now），收到 ${JSON.stringify(acquiredAt)}`);
  }
  /** @type {{ runId: string, acquiredAt: number, pid?: number }} */
  const lease = { runId, acquiredAt };
  if (pid !== undefined) lease.pid = pid;
  return lease;
}

/**
 * 从槽位文件的字节里解析持有者。返回 `null` 表示「读不出持有者」（按 `corrupt` 点名）：
 * 解析失败、不是对象、缺 `runId` / `acquiredAt`、或内容里的 `slot` 与文件名不符（不是本模块写的）。
 * @param {string} bytes
 * @param {number} index 文件名里的槽位号（权威来源）
 * @returns {Lease | null}
 */
function parseHolder(bytes, index) {
  /** @type {*} */
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = /** @type {Record<string, *>} */ (parsed);
  if (typeof raw.runId !== "string" || raw.runId === "") return null;
  if (typeof raw.acquiredAt !== "number" || !Number.isFinite(raw.acquiredAt)) return null;
  if (raw.slot !== undefined && raw.slot !== index) return null;
  /** @type {Lease} */
  const holder = { runId: raw.runId, slot: index, acquiredAt: raw.acquiredAt };
  if (typeof raw.pid === "number" && Number.isFinite(raw.pid)) holder.pid = raw.pid;
  return holder;
}

/**
 * 读一格槽位的**一致性快照**：`open` → `fstat` → `read` 全在**同一个 fd** 上完成，所以
 * 「inode 身份」与「内容字节」描述的是同一个文件版本（不是两次独立读取拼起来的，那种拼法会
 * 把「旧内容的判定」配到「新文件的 inode」上，回收判据就假了）。
 *
 * @param {string} file
 * @param {number} index
 * @returns {{ kind: "absent" }
 *   | { kind: "corrupt", ino: number, mtimeMs: number, bytes: string }
 *   | { kind: "holder", ino: number, mtimeMs: number, bytes: string, holder: Lease }}
 */
function snapshotSlot(file, index) {
  /** @type {number} */
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    const bytes = readFileSync(fd, "utf8");
    const holder = parseHolder(bytes, index);
    if (holder === null) return { kind: "corrupt", ino: stat.ino, mtimeMs: stat.mtimeMs, bytes };
    return { kind: "holder", ino: stat.ino, mtimeMs: stat.mtimeMs, bytes, holder };
  } finally {
    closeSync(fd);
  }
}

/**
 * 判定一份**读得出来**的租约是否可回收（返回回收理由；`null` = 保留）。
 *
 * 谓词优先：宿主给了谓词且租约记了 pid ⇒ 只有谓词明确说死才收（`pid-dead`）；
 * 否则退回年龄兜底（`stale`）。谓词返回非布尔值一律按「活着」处理（保守）。
 *
 * @param {Lease} holder
 * @param {{ isProcessAlive?: (pid: number) => boolean, maxAgeMs: number, now: number }} ctx
 * @returns {"pid-dead" | "stale" | null}
 */
function reclaimReason(holder, { isProcessAlive, maxAgeMs, now }) {
  if (typeof isProcessAlive === "function" && typeof holder.pid === "number") {
    return isProcessAlive(holder.pid) === false ? "pid-dead" : null;
  }
  return now - holder.acquiredAt > maxAgeMs ? "stale" : null;
}

/**
 * 判定一份**读不出来**的槽位是否可回收：只看文件系统自己的 mtime（见文件头的例外说明）。
 * @param {{ mtimeMs: number }} snap
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
function judgeCorruptReclaimable(snap, maxAgeMs) {
  return Date.now() - snap.mtimeMs > maxAgeMs;
}

/**
 * 本模块要看哪些槽位号：`[0, maxConcurrent)` **并上**目录里实际存在的 `slot-<i>.lock`。
 *
 * 为什么要并集：宿主把 `maxConcurrent` 调小之后，高号槽里的租约仍然是某些 run 的（它们必须还
 * 得掉），而一个已经收窄的池子不该假装那些文件不存在。返回升序，保证判定顺序稳定。
 *
 * @param {string} leaseDir
 * @param {number} maxConcurrent
 * @returns {number[]}
 */
function slotIndexesIn(leaseDir, maxConcurrent) {
  /** @type {Set<number>} */
  const indexes = new Set();
  for (let index = 0; index < maxConcurrent; index += 1) indexes.add(index);
  /** @type {string[]} */
  let entries = [];
  try {
    entries = readdirSync(leaseDir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
  }
  for (const name of entries) {
    const match = SLOT_FILE_PATTERN.exec(name);
    if (match !== null) indexes.add(Number(match[1]));
  }
  return [...indexes].sort((a, b) => a - b);
}

/**
 * 抢一个槽位：`open(..., "wx")` 成功即写内容并返回 `true`；已存在返回 `false`（交给调用方判定）。
 * @param {string} file
 * @param {Lease} lease
 * @returns {boolean}
 */
function writeSlot(file, lease) {
  /** @type {number} */
  let fd;
  try {
    fd = openSync(file, EXCLUSIVE_WRITE);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(lease)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * 抢占配额：依次 `open(..., "wx")` 每一格槽位，成功即占住并返回租约。
 *
 * **这一个调用既判额又占位**（`wx` 是原子判据）：调用方不该在它之前再数一遍目录——那正是
 * issue #630 S3 要修的缺陷（两个进程同时读到 `max-1` 然后各自建锁 ⇒ 超发）。
 *
 * 回收路径（`EEXIST` 之后）：读快照 → 判定 → **再快照确认同一 inode 同一字节** → `unlink` →
 * 重试本格一次；确认不一致就放弃回收去看下一格。为什么这样不会误删别人刚抢到的槽，见文件头。
 *
 * @param {string} leaseDir
 * @param {Object} options
 * @param {string} options.runId
 * @param {number} [options.pid]   持约进程号（宿主记；库只存取、不探活）
 * @param {number} options.now     宿主时钟当前值（写入 acquiredAt）
 * @param {number} [options.maxConcurrent] 配额池大小（缺省 2）
 * @param {(pid: number) => boolean} [options.isProcessAlive] 宿主注入的存活谓词（回收的权威判据）
 * @param {number} [options.maxAgeMs] 没有谓词时的兜底阈值（缺省 30 分钟）
 * @returns {{ ok: true, lease: Lease }
 *   | { ok: false, reason: "capacity_full", maxConcurrent: number, holders: Lease[], corrupt?: LeaseCorruptEntry[] }}
 */
export function acquire(leaseDir, {
  runId,
  pid,
  now,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  isProcessAlive,
  maxAgeMs = DEFAULT_LEASE_MAX_AGE_MS,
}) {
  const safeRunId = assertSafeRunId(runId);
  const base = cleanLease(safeRunId, now, pid);
  const max = assertMaxConcurrent(maxConcurrent);
  const maxAge = assertMaxAgeMs(maxAgeMs);
  if (isProcessAlive !== undefined && typeof isProcessAlive !== "function") {
    throw new TypeError("capacity: isProcessAlive 必须是函数（宿主提供存活谓词；库不自己探 pid）");
  }
  mkdirSync(leaseDir, { recursive: true });
  const ctx = { isProcessAlive, maxAgeMs: maxAge, now: /** @type {number} */ (now) };
  /** @type {Lease[]} */
  const holders = [];
  /** @type {LeaseCorruptEntry[]} */
  const corrupt = [];

  for (let index = 0; index < max; index += 1) {
    const file = join(leaseDir, slotFileName(index));
    /** @type {Lease} */
    const lease = { ...base, slot: index };
    if (writeSlot(file, lease)) return { ok: true, lease };

    // 这一格有人占着（或刚被人抢走）。每格最多两轮：第一轮判定/回收，第二轮是「回收后重试本格一次」。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snap = snapshotSlot(file, index);
      if (snap.kind === "absent") {
        // 读之前刚好被别人释放了：直接再抢一次，不用回收任何东西。
        if (writeSlot(file, lease)) return { ok: true, lease };
        continue;
      }
      const reclaimable = snap.kind === "corrupt"
        ? judgeCorruptReclaimable(snap, maxAge)
        : reclaimReason(snap.holder, ctx) !== null;
      if (!reclaimable) break;
      // 回收前再确认：同一 inode + 同一字节才动手（见文件头「为什么不会误删」）。
      const confirm = snapshotSlot(file, index);
      const sameFile = confirm.kind === snap.kind && confirm.ino === snap.ino && confirm.bytes === snap.bytes;
      if (!sameFile) continue; // 期间有人接管了这一格：一个字节都不删，下一轮重新判定
      unlinkSync(file);
      if (writeSlot(file, lease)) return { ok: true, lease };
      // 刚删完就被别人合法抢走了：这一格归别人，退让去看下一格。
      break;
    }

    // 没抢到：把这一格**现在**的持有者点名（不是判定时的旧快照——期间可能已经换人）。
    const current = snapshotSlot(file, index);
    if (current.kind === "holder") holders.push(current.holder);
    else if (current.kind === "corrupt") {
      corrupt.push({ file: slotFileName(index), slot: index, reason: CORRUPT_REASON });
    }
  }

  return {
    ok: false,
    reason: "capacity_full",
    maxConcurrent: max,
    holders,
    ...(corrupt.length === 0 ? {} : { corrupt }),
  };
}

/**
 * 还租约：**只删自己的槽**（槽内 `runId` 与调用方一致才 `unlink`，别人的槽一个字节都不许动）。
 * 幂等：没有自己的槽也算成功（返回 `released: false`），重复还不报错。
 *
 * 定位不看 `maxConcurrent` 的边界而看目录（`slotIndexesIn` 的并集）：宿主把池子调小之后，
 * 高号槽里的租约仍然是我们的，必须还得掉。
 *
 * @param {string} leaseDir
 * @param {Object} options
 * @param {string} options.runId
 * @param {number} [options.maxConcurrent] 配额池大小（缺省 2；只用于把池子范围并进候选集合）
 * @returns {{ ok: true, released: boolean, slot?: number }}
 */
export function release(leaseDir, { runId, maxConcurrent = DEFAULT_MAX_CONCURRENT } = {}) {
  const safeRunId = assertSafeRunId(runId);
  const max = assertMaxConcurrent(maxConcurrent);
  /** @type {number | undefined} */
  let releasedSlot;
  for (const index of slotIndexesIn(leaseDir, max)) {
    const file = join(leaseDir, slotFileName(index));
    const snap = snapshotSlot(file, index);
    if (snap.kind !== "holder" || snap.holder.runId !== safeRunId) continue;
    // 再确认一次才删：只删「刚才读到的那一份」，期间换过人就不动。
    const confirm = snapshotSlot(file, index);
    if (confirm.kind !== "holder" || confirm.ino !== snap.ino || confirm.bytes !== snap.bytes) continue;
    unlinkSync(file);
    if (releasedSlot === undefined) releasedSlot = index;
  }
  return releasedSlot === undefined
    ? { ok: true, released: false }
    : { ok: true, released: true, slot: releasedSlot };
}

/**
 * 当前租约清单（槽位池视角）。`corrupt` 的格子逐个点名（**不静默丢**），不参与任何统计。
 *
 * 看的是 `[0, maxConcurrent)` 与目录里实际存在的 `slot-<i>.lock` 的并集；旧的 `<runId>.lock`
 * 不参与配额，这里也不点名（它们既不影响判定，也不会被本模块删除）。
 *
 * @param {string} leaseDir
 * @param {{ maxConcurrent?: number }} [options]
 * @returns {{ leases: Lease[], corrupt: LeaseCorruptEntry[] }}
 */
export function list(leaseDir, { maxConcurrent = DEFAULT_MAX_CONCURRENT } = {}) {
  const max = assertMaxConcurrent(maxConcurrent);
  /** @type {Lease[]} */
  const leases = [];
  /** @type {LeaseCorruptEntry[]} */
  const corrupt = [];
  if (!existsSync(leaseDir)) return { leases, corrupt };
  for (const index of slotIndexesIn(leaseDir, max)) {
    const snap = snapshotSlot(join(leaseDir, slotFileName(index)), index);
    if (snap.kind === "absent") continue;
    if (snap.kind === "corrupt") {
      corrupt.push({ file: slotFileName(index), slot: index, reason: CORRUPT_REASON });
      continue;
    }
    leases.push(snap.holder);
  }
  return { leases, corrupt };
}

/**
 * 显式回收孤儿槽位（**宿主主动调用**才发生；库自己不排任何定时清理，自动回收只走
 * `acquire` 的抢占失败路径）。
 *
 * 判据与 `acquire` 同一份（`reclaimReason`）：谓词优先，`maxAgeMs` 兜底；`ownedRunIds` 里的
 * 一律不动（本进程自己养着的子 run 即便超龄也不许收——那正是「误杀活租约」）。读不出内容的
 * 格子进 `corrupt` 点名，不在这里收（`acquire` 的兜底路径才会按 mtime 收）。
 *
 * 旧的 `<runId>.lock` 不参与（既不收也不点名）：它们不再属于配额。
 *
 * @param {string} leaseDir
 * @param {Object} options
 * @param {number} options.now               宿主时钟当前值（required）
 * @param {number} [options.maxConcurrent]   配额池大小（缺省 2）
 * @param {number} [options.maxAgeMs]        没有谓词时的兜底阈值（缺省 30 分钟）
 * @param {string[]} [options.ownedRunIds]   本进程拥有的子 run 集合（宿主注入的事实）
 * @param {(pid: number) => boolean} [options.isProcessAlive] 宿主注入的存活谓词
 * @returns {{ swept: Array<{ runId: string, file: string, slot: number, reason: "pid-dead" | "stale" }>,
 *             corrupt: LeaseCorruptEntry[],
 *             kept: number }}
 */
export function sweep(leaseDir, {
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxAgeMs = DEFAULT_LEASE_MAX_AGE_MS,
  ownedRunIds = [],
  isProcessAlive,
  now,
} = {}) {
  const clock = assertNow(now);
  const max = assertMaxConcurrent(maxConcurrent);
  const maxAge = assertMaxAgeMs(maxAgeMs);
  if (isProcessAlive !== undefined && typeof isProcessAlive !== "function") {
    throw new TypeError("capacity: isProcessAlive 必须是函数（宿主提供存活谓词；库不自己探 pid）");
  }
  const owned = new Set(ownedRunIds);
  /** @type {Array<{ runId: string, file: string, slot: number, reason: "pid-dead" | "stale" }>} */
  const swept = [];
  /** @type {LeaseCorruptEntry[]} */
  const corrupt = [];
  let kept = 0;
  if (!existsSync(leaseDir)) return { swept, corrupt, kept };
  for (const index of slotIndexesIn(leaseDir, max)) {
    const file = join(leaseDir, slotFileName(index));
    const snap = snapshotSlot(file, index);
    if (snap.kind === "absent") continue;
    if (snap.kind === "corrupt") {
      corrupt.push({ file: slotFileName(index), slot: index, reason: CORRUPT_REASON });
      kept += 1;
      continue;
    }
    const holder = snap.holder;
    if (owned.has(holder.runId)) {
      kept += 1;
      continue;
    }
    const reason = reclaimReason(holder, { isProcessAlive, maxAgeMs: maxAge, now: clock });
    if (reason === null) {
      kept += 1;
      continue;
    }
    const confirm = snapshotSlot(file, index);
    if (confirm.kind !== "holder" || confirm.ino !== snap.ino || confirm.bytes !== snap.bytes) {
      kept += 1;
      continue;
    }
    unlinkSync(file);
    swept.push({ runId: holder.runId, file: slotFileName(index), slot: index, reason });
  }
  return { swept, corrupt, kept };
}
