// issue #630（S3）——派生并发配额改成**跨进程原子**，并让崩溃槽能被回收。
//
// 本文件是这一片的判据集，重点是**真跨进程证据**（不是同进程的 Promise.all 假并发）：
//   1. 同进程并发：池子 2 格、三份 acquire ⇒ 恰好 2 个 ok、1 个 capacity_full 并点名两个持有者；
//   2. **真跨进程**：`node:child_process` spawn 5 个真 node 子进程，对齐起跑线后同时抢 2 个槽
//      ⇒ 恰好 2 个成功，盘上恰好 2 格；赢家**持有租约到所有兄弟都尝试过**（#651），
//      稳定观察点上的被拒者点名两个持有者（本切片的核心证据）；
//   3. 崩溃槽回收：先让一个**真子进程**抢一格然后退出（pid 真死），新 runId 用真谓词抢 ⇒ 拿到那一格，
//      且总量不超过 max；
//   4. 误删防护：A 占槽后，B 的 release 不得删掉 A 的槽；
//   5. 无谓词兜底：`acquiredAt` 超龄可回收、未超龄不回收；
//   6. 旧格式：目录里的 `<runId>.lock` 不影响配额计算，也不被删。
//
// 卫生：临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp()`；子进程用 `-e` 内联源码，
// 不在 `test/` 里落任何会被 `node --test` 当成用例捡起来的辅助文件。
//
// ## 第 2 条用例为什么在 #651 改了观察点（放弃的是什么，写在这里免得下一个人再踩）
//
// 旧版把「每个被拒者都点名了两个持有者」当成硬判据，它**与环境有关**：那时 `acquire` 占一格是
// `open(path, "wx")` **之后**才写内容，赢家在 open→write 那几十微秒里留下的是一份「存在但
// 读不出持有者」的空文件——那正是 `capacity.js` 的 corrupt 通道。输家此刻去读，那一格不进
// holders（只进 corrupt），于是它只点名另一个已经写完整的槽。CI 的 2 核机器上 5 个 node 子进程
// 抢 2 格，这个窗口会被撞上（issue #651）；开发机核多、平时只跑一个用例，几乎撞不上（把 8 个
// 实例同时钉在 2 核上就跑得出来），所以这条红只在 CI 出现。
//
// **issue #652 之后那个窗口不存在了**：占格改成「整份内容先写进临时文件、再 `link(2)` 排他发布」，
// 所以跨进程观察者要么看不到这一格的名字、要么看到完整内容（确定性用例在
// `test/tools-delegation-capacity-652.test.js`）。本文件保留的判据不变，因为它们在两种实现下都
// 必须成立：`holders + corrupt` 覆盖两格、holders 里不可能有幽灵；corrupt 通道本身也仍然存在
// （手改 / 外来文件）。
//
// 修法取 #630 的 A 形态：**赢家把租约持有到所有兄弟都尝试过**（子进程抢到后不退出、等父进程
// 开闸），于是「恰好 2 个成功」这条硬判据保留，而「跨进程看得见别人占的槽」挪到**稳定观察点**
// （5 个孩子都尝试过、赢家仍活着、两格内容都已写完整）再断言——那里没有 mid-write 窗口，
// 所以是确定性的。**放弃的是**「被拒者那一刻的快照里必须有两个持有者」这条更硬的表述：它描述
// 的是瞬时竞态，不是产品不变式。保留的替代判据见用例里的两条：holders 只可能是真赢家、
// 且每一格都必须被点名（读得出来进 holders、读不出来进 corrupt）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { acquire, list, release } from "../src/tools/delegation/capacity.js";
import { makeTmp } from "./helpers/tmp.js";

/** 被测模块的绝对 file:// URL：子进程要 `import()` 的就是这一份（不是拷贝）。 */
const CAPACITY_URL = new URL("../src/tools/delegation/capacity.js", import.meta.url).href;

const NOW = 1_700_000_000_000;

/**
 * 真谓词（与 CLI 同一套口径）：`process.kill(pid, 0)` 成功 ⇒ 活；`EPERM` ⇒ 进程存在但没权限发信号
 * ⇒ 也算活；`ESRCH` ⇒ 死。
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * 子进程源码：等到达 `startAt` 这个墙钟时刻（起跑线）再抢一格，然后把结果打成一行 JSON。
 *
 * `holdGate`（第 6 个参数）：非空时，抢到之后**先打印结果、再等父进程把闸门文件写出来才退出**
 * ——这就是 #651 的 A 形态「赢家持有租约到所有兄弟都尝试过」：整个争抢窗口里赢家都是活进程，
 * 它那一格不是「死主留下的孤儿槽」。空串时没有闸门，它就是「抢一格、打印、立刻退出」——
 * 第 3 条用例正是用它造一个真死掉的持有者。
 *
 * `corrupt` 也一并报出来：手改 / 外来文件会落进 corrupt 通道（#652 之后本模块自己的写路径不再产生
 * 半写槽，所以正常争抢里它应该恒为空——留着它是为了把异常形状报出来而不是静默吞）。
 */
const CHILD_SOURCE = `
const [capacityUrl, leaseDir, runId, maxConcurrent, startAt, holdGate] = process.argv.slice(1);
const { acquire } = await import(capacityUrl);
const { existsSync } = await import("node:fs");
while (Date.now() < Number(startAt)) { /* 起跑线对齐：让多个进程真的在同一瞬间抢同一格 */ }
const result = acquire(leaseDir, { runId, pid: process.pid, now: Date.now(), maxConcurrent: Number(maxConcurrent) });
process.stdout.write(JSON.stringify({
  runId,
  pid: process.pid,
  ok: result.ok === true,
  reason: result.ok === true ? null : result.reason,
  slot: result.ok === true ? result.lease.slot : null,
  holders: result.ok === true ? [] : result.holders.map((holder) => holder.runId),
  corrupt: result.ok === true ? [] : (result.corrupt ?? []).map((entry) => entry.slot),
}) + "\\n");
if (holdGate) {
  const deadline = Date.now() + 15000;
  while (!existsSync(holdGate) && Date.now() < deadline) { /* 持有：等所有同龄人都尝试过 */ }
}
`;

/**
 * 起一个真 node 子进程去抢槽。
 *
 * 两个 promise 分开：#651 之后赢家会**一直持有**（等闸门），所以不能在它退出时才拿结果。
 * `result` 在子进程打出那一行 JSON 时就兑现（不等它退出），`done` 在它退出时兑现。
 *
 * @param {string[]} args `[capacityUrl, leaseDir, runId, maxConcurrent, startAt, holdGate]`
 * @returns {{ result: Promise<{runId: string, pid: number, ok: boolean, reason: string|null,
 *   slot: number|null, holders: string[], corrupt: number[]}>, done: Promise<number> }}
 */
function runChild(args) {
  /** @type {(value: any) => void} */
  let settle;
  /** @type {(reason: any) => void} */
  let fail;
  const result = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  let settled = false;
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SOURCE, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (settled) return;
    const newline = stdout.indexOf("\n");
    if (newline === -1) return;
    settled = true;
    try {
      settle(JSON.parse(stdout.slice(0, newline)));
    } catch {
      fail(new Error(`子进程没打出一行 JSON，实际 stdout: ${JSON.stringify(stdout)}`));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    fail(err);
  });
  const done = new Promise((resolve) => {
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        fail(new Error(`子进程退出码 ${code}，没打出结果（stderr: ${stderr.trim() || "空"}）`));
      }
      resolve(code ?? -1);
    });
  });
  return { result, done };
}

// ================================================================ 1. 同进程并发

test("capacity（#630 S3）：同进程三份 acquire、池子 2 格 ⇒ 恰好 2 个 ok、1 个 capacity_full 并点名持有者", async () => {
  const dir = await makeTmp("delegation-capacity-630-");
  const leaseDir = join(dir, "leases");
  const [a, b, c] = await Promise.all([
    Promise.resolve().then(() => acquire(leaseDir, { runId: "sub-a", pid: 11, now: NOW, maxConcurrent: 2 })),
    Promise.resolve().then(() => acquire(leaseDir, { runId: "sub-b", pid: 22, now: NOW, maxConcurrent: 2 })),
    Promise.resolve().then(() => acquire(leaseDir, { runId: "sub-c", pid: 33, now: NOW, maxConcurrent: 2 })),
  ]);
  const results = [a, b, c];
  const winners = results.filter((result) => result.ok === true);
  const losers = results.filter((result) => result.ok === false);
  assert.equal(winners.length, 2, "恰好两份抢到（不是三份，也不是一份）");
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, "capacity_full");
  assert.deepEqual(
    losers[0].holders.map((holder) => holder.runId).sort(),
    winners.map((winner) => winner.lease.runId).sort(),
    "失败者点名的持有者就是那两个成功者",
  );
  assert.deepEqual(winners.map((winner) => winner.lease.slot).sort(), [0, 1], "两个成功者占的是两格不同的槽");
});

// ================================================================ 2. 真跨进程（核心证据）

test("capacity（#630 S3 核心证据）：5 个真 node 子进程同时抢 2 个槽 ⇒ 恰好 2 个成功", async () => {
  const dir = await makeTmp("delegation-capacity-630-xproc-");
  const leaseDir = join(dir, "leases");
  // 闸门：赢家抢到后不退出，一直持有到下面把它写出来（A 形态：持有租约到所有兄弟都尝试过）。
  const holdGate = join(dir, "release-winners.gate");
  const startAt = String(Date.now() + 500);
  const handles = [0, 1, 2, 3, 4].map((index) =>
    runChild([CAPACITY_URL, leaseDir, `sub-xproc-${index}`, "2", startAt, holdGate]));
  try {
    const results = await Promise.all(handles.map((handle) => handle.result));
    const winners = results.filter((result) => result.ok === true);
    const losers = results.filter((result) => result.ok === false);
    // 实测输出（报告里贴的就是这一行）：
    console.log(
      `[#630 S3 真跨进程] 5 个 node 子进程抢 2 个槽 ⇒ 成功 ${winners.length} / 拒绝 ${losers.length}；`
      + `成功者 ${winners.map((winner) => `${winner.runId}@slot-${winner.slot}(pid ${winner.pid})`).join("、")}；`
      + `拒绝理由 ${[...new Set(losers.map((loser) => loser.reason))].join("、")}`,
    );

    // ---- 硬判据（与环境无关）：跨进程 wx 抢占只发出两格 ----
    assert.equal(winners.length, 2, `真跨进程下也恰好两份成功，实际 ${winners.length} 份`);
    assert.equal(losers.length, 3);
    assert.deepEqual(winners.map((winner) => winner.slot).sort(), [0, 1], "两个成功者占的是两格不同的槽");
    for (const winner of winners) {
      assert.notEqual(winner.pid, process.pid, "租约里的 pid 是子进程自己的真 pid，不是父进程的");
    }
    assert.equal(new Set(winners.map((winner) => winner.pid)).size, 2, "两个成功者是两个不同的真进程");

    // ---- A 形态：赢家把租约持有到所有兄弟都尝试过（#651）----
    // 此刻 5 个孩子都已经把结果打出来了（3 个已撞墙、2 个还活着并在等闸门），所以「争抢窗口」
    // 已经结束。赢家仍然活着 ⇒ 它那一格是**活租约**，不是死主留下的孤儿槽。
    for (const winner of winners) {
      assert.equal(
        isProcessAlive(winner.pid),
        true,
        `赢家 ${winner.runId} 在争抢窗口结束时仍然活着（持有租约到所有兄弟都尝试过）`,
      );
    }

    // ---- 稳定观察点（确定性）：两格都已写完整、持有者就是那两个赢家 ----
    const { leases, corrupt } = list(leaseDir, { maxConcurrent: 2 });
    assert.deepEqual(
      leases.map((lease) => [lease.slot, lease.runId]).sort((left, right) => left[0] - right[0]),
      winners.map((winner) => [winner.slot, winner.runId]).sort((left, right) => left[0] - right[0]),
      "盘上恰好两格，且持有者就是那两个成功者",
    );
    assert.deepEqual(corrupt, [], "稳定观察点上没有读不出持有者的槽（赢家早就把内容写完了）");

    // ---- 稳定观察点：跨进程看得见别人占的槽（被拒者点名两个持有者）----
    const probe = acquire(leaseDir, { runId: "sub-xproc-probe", pid: process.pid, now: Date.now(), maxConcurrent: 2 });
    assert.equal(probe.ok, false, "两格都被真占着 ⇒ 第六个来者也同样被拒");
    assert.equal(probe.reason, "capacity_full");
    assert.deepEqual(
      probe.holders.map((holder) => holder.runId).sort(),
      winners.map((winner) => winner.runId).sort(),
      "稳定观察点上的被拒者点名两个持有者（跨进程看得见别人占的槽）",
    );

    // ---- 每个被拒者：只可能点名真赢家，且两格都必须被点名 ----
    // 这里**不再**要求「那一刻的快照里就有两个持有者」：输家可能在赢家 open→write 之间读到那一格，
    // 生产代码把它点名在 corrupt 通道而不是 holders 里（见文件头）。所以判据拆成两条确定的：
    //   a) holders 里不可能出现幽灵（每个都是真赢家）；
    //   b) holders + corrupt 恰好覆盖两格（没有进程会 unlink：本用例既无谓词、也无超龄租约、也无 release）。
    for (const loser of losers) {
      assert.equal(loser.reason, "capacity_full");
      const named = [...loser.holders].sort();
      assert.deepEqual(
        named,
        named.filter((runId) => winners.some((winner) => winner.runId === runId)),
        "被拒者点名的持有者只可能是真赢家，不会点名幽灵",
      );
      assert.equal(
        loser.holders.length + loser.corrupt.length,
        2,
        `被拒者把两格都点名了（读得出来的进 holders、正被写的进 corrupt），实际 holders=${JSON.stringify(loser.holders)} corrupt=${JSON.stringify(loser.corrupt)}`,
      );
    }
  } finally {
    // 开闸：赢家看到这个文件才退出（断言红了也照开，不让子进程挂到 15 秒超时）。
    writeFileSync(holdGate, "");
    await Promise.all(handles.map((handle) => handle.done));
  }
});

// ================================================================ 3. 崩溃槽回收（真死 pid）

test("capacity（#630 S3）：崩溃进程留下的槽能被回收——真死 pid 让新 runId 拿到该格，总量不超 max", async () => {
  const dir = await makeTmp("delegation-capacity-630-crash-");
  const leaseDir = join(dir, "leases");
  // 真子进程抢一格然后退出：槽里留下的是它的真 pid，而进程已经没了。
  // 闸门给空串 ⇒ 没有持有：它抢到、打印、立刻退出（本用例要的就是一个真死掉的持有者）。
  const deadHandle = runChild([CAPACITY_URL, leaseDir, "sub-dead", "2", "0", ""]);
  const dead = await deadHandle.result;
  assert.equal(await deadHandle.done, 0, "那个子进程正常退出（退出码 0）");
  assert.equal(dead.ok, true, "崩溃前的子进程确实抢到了槽");
  assert.equal(dead.slot, 0);
  assert.equal(isProcessAlive(dead.pid), false, "子进程已经退出 ⇒ 真谓词说死");
  // 第二格由本进程（活的）占着：回收只该动死掉的那一格。
  const live = acquire(leaseDir, { runId: "sub-live", pid: process.pid, now: Date.now(), maxConcurrent: 2 });
  assert.equal(live.ok, true);
  assert.equal(live.lease.slot, 1);
  // 新来者：谓词说死 ⇒ 回收 slot-0（不是「池满 ⇒ 直接失败」）。
  const taken = acquire(leaseDir, {
    runId: "sub-new",
    pid: process.pid,
    now: Date.now(),
    maxConcurrent: 2,
    isProcessAlive,
  });
  assert.equal(taken.ok, true, "死掉的持有者不再永久占着配额");
  assert.equal(taken.lease.slot, 0, "回收的是死掉的那一格");
  const { leases } = list(leaseDir, { maxConcurrent: 2 });
  assert.ok(leases.length <= 2, `总占用量不超过 max，实际 ${leases.length}`);
  assert.deepEqual(leases.map((lease) => lease.runId).sort(), ["sub-live", "sub-new"]);
});

// ================================================================ 4. 误删防护

test("capacity（#630 S3）：别人的槽一个字节都不许动——B 的 release 删不掉 A 的槽", async () => {
  const dir = await makeTmp("delegation-capacity-630-release-");
  const leaseDir = join(dir, "leases");
  const held = acquire(leaseDir, { runId: "sub-a", pid: 4242, now: NOW, maxConcurrent: 2 });
  assert.equal(held.ok, true);
  // B 拿 A 的 runId 去还（不管是搞错了还是恶意的）：不许成功，更不许删。
  assert.deepEqual(release(leaseDir, { runId: "sub-a-but-not-really", maxConcurrent: 2 }), {
    ok: true,
    released: false,
  });
  assert.equal(list(leaseDir, { maxConcurrent: 2 }).leases.length, 1, "A 的槽还在");
  assert.equal(list(leaseDir, { maxConcurrent: 2 }).leases[0].runId, "sub-a");
  // 正主来还才删。
  assert.deepEqual(release(leaseDir, { runId: "sub-a", maxConcurrent: 2 }), { ok: true, released: true, slot: 0 });
  assert.equal(list(leaseDir, { maxConcurrent: 2 }).leases.length, 0);
});

// ================================================================ 5. 无谓词兜底（maxAgeMs）

test("capacity（#630 S3）：不传 isProcessAlive 时按 maxAgeMs 兜底——超龄可回收、未超龄不回收", async () => {
  const dir = await makeTmp("delegation-capacity-630-age-");
  const leaseDir = join(dir, "leases");
  const maxAgeMs = 30 * 60_000;
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(
    join(leaseDir, "slot-0.lock"),
    `${JSON.stringify({ runId: "sub-old", pid: 999_999, acquiredAt: NOW - maxAgeMs - 1, slot: 0 })}\n`,
  );
  const reclaimed = acquire(leaseDir, { runId: "sub-new", now: NOW, maxConcurrent: 1, maxAgeMs });
  assert.equal(reclaimed.ok, true, "超龄的槽在没有谓词时可以被回收（否则崩溃的租约永远锁死配额）");
  assert.equal(reclaimed.lease.slot, 0);

  // 未超龄：不回收，配额照旧算满。
  writeFileSync(
    join(leaseDir, "slot-0.lock"),
    `${JSON.stringify({ runId: "sub-young", pid: 999_999, acquiredAt: NOW - 1_000, slot: 0 })}\n`,
  );
  const blocked = acquire(leaseDir, { runId: "sub-other", now: NOW, maxConcurrent: 1, maxAgeMs });
  assert.equal(blocked.ok, false, "未超龄的槽不许收（宁可等，也不误杀）");
  assert.equal(blocked.reason, "capacity_full");
  assert.deepEqual(blocked.holders.map((holder) => holder.runId), ["sub-young"]);
});

// ================================================================ 6. 旧格式

test("capacity（#630 S3）：旧的 <runId>.lock 既不占额、也不被删", async () => {
  const dir = await makeTmp("delegation-capacity-630-legacy-");
  const leaseDir = join(dir, "leases");
  const legacy = join(leaseDir, "legacy-runid.lock");
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(legacy, `${JSON.stringify({ runId: "legacy-runid", pid: 1, acquiredAt: NOW })}\n`);
  const first = acquire(leaseDir, { runId: "sub-a", now: NOW, maxConcurrent: 2 });
  const second = acquire(leaseDir, { runId: "sub-b", now: NOW, maxConcurrent: 2 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true, "旧锁文件不占配额：两格都还能抢");
  assert.deepEqual(first.lease.slot, 0);
  assert.deepEqual(second.lease.slot, 1);
  assert.equal(list(leaseDir, { maxConcurrent: 2 }).leases.length, 2, "list 只数槽位，不数旧锁文件");
  assert.equal(list(leaseDir, { maxConcurrent: 2 }).corrupt.length, 0, "旧锁文件也不进 corrupt 点名");
  release(leaseDir, { runId: "sub-a", maxConcurrent: 2 });
  release(leaseDir, { runId: "sub-b", maxConcurrent: 2 });
  assert.equal(existsSync(legacy), true, "旧锁文件不会被主动删（短命文件，留着无害）");
});
