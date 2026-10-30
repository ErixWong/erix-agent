// issue #630（S3）——派生并发配额改成**跨进程原子**，并让崩溃槽能被回收。
//
// 本文件是这一片的判据集，重点是**真跨进程证据**（不是同进程的 Promise.all 假并发）：
//   1. 同进程并发：池子 2 格、三份 acquire ⇒ 恰好 2 个 ok、1 个 capacity_full 并点名两个持有者；
//   2. **真跨进程**：`node:child_process` spawn 5 个真 node 子进程，对齐起跑线后同时抢 2 个槽
//      ⇒ 恰好 2 个成功，盘上恰好 2 格，失败者点名两个持有者（本切片的核心证据）；
//   3. 崩溃槽回收：先让一个**真子进程**抢一格然后退出（pid 真死），新 runId 用真谓词抢 ⇒ 拿到那一格，
//      且总量不超过 max；
//   4. 误删防护：A 占槽后，B 的 release 不得删掉 A 的槽；
//   5. 无谓词兜底：`acquiredAt` 超龄可回收、未超龄不回收；
//   6. 旧格式：目录里的 `<runId>.lock` 不影响配额计算，也不被删。
//
// 卫生：临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp(...)`；子进程用 `-e` 内联源码，
// 不在 `test/` 里落任何会被 `node --test` 当成用例捡起来的辅助文件。
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
 * 没有等待（`startAt = 0`）时它就是「抢一格、打印、立刻退出」——用来造一个真死掉的持有者。
 */
const CHILD_SOURCE = `
const [capacityUrl, leaseDir, runId, maxConcurrent, startAt] = process.argv.slice(1);
const { acquire } = await import(capacityUrl);
while (Date.now() < Number(startAt)) { /* 起跑线对齐：让多个进程真的在同一瞬间抢同一格 */ }
const result = acquire(leaseDir, { runId, pid: process.pid, now: Date.now(), maxConcurrent: Number(maxConcurrent) });
process.stdout.write(JSON.stringify({
  runId,
  pid: process.pid,
  ok: result.ok === true,
  reason: result.ok === true ? null : result.reason,
  slot: result.ok === true ? result.lease.slot : null,
  holders: result.ok === true ? [] : result.holders.map((holder) => holder.runId),
}));
`;

/**
 * 起一个真 node 子进程去抢槽，返回它打印的那一行结果。
 * @param {string[]} args `[capacityUrl, leaseDir, runId, maxConcurrent, startAt]`
 * @returns {Promise<{runId: string, pid: number, ok: boolean, reason: string|null, slot: number|null, holders: string[]}>}
 */
function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SOURCE, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`子进程退出码 ${code}（stderr: ${stderr.trim() || "空"}）`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`子进程没打出一行 JSON，实际 stdout: ${JSON.stringify(stdout)}`));
      }
    });
  });
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
  const startAt = String(Date.now() + 500);
  const results = await Promise.all(
    [0, 1, 2, 3, 4].map((index) => runChild([CAPACITY_URL, leaseDir, `sub-xproc-${index}`, "2", startAt])),
  );

  const winners = results.filter((result) => result.ok === true);
  const losers = results.filter((result) => result.ok === false);
  // 实测输出（报告里贴的就是这一行）：
  console.log(
    `[#630 S3 真跨进程] 5 个 node 子进程抢 2 个槽 ⇒ 成功 ${winners.length} / 拒绝 ${losers.length}；`
    + `成功者 ${winners.map((winner) => `${winner.runId}@slot-${winner.slot}(pid ${winner.pid})`).join("、")}；`
    + `拒绝理由 ${[...new Set(losers.map((loser) => loser.reason))].join("、")}`,
  );

  assert.equal(winners.length, 2, `真跨进程下也恰好两份成功，实际 ${winners.length} 份`);
  assert.equal(losers.length, 3);
  assert.deepEqual(winners.map((winner) => winner.slot).sort(), [0, 1], "两个成功者占的是两格不同的槽");
  for (const winner of winners) {
    assert.notEqual(winner.pid, process.pid, "租约里的 pid 是子进程自己的真 pid，不是父进程的");
  }
  assert.equal(new Set(winners.map((winner) => winner.pid)).size, 2, "两个成功者是两个不同的真进程");

  const { leases } = list(leaseDir, { maxConcurrent: 2 });
  assert.deepEqual(
    leases.map((lease) => [lease.slot, lease.runId]).sort((left, right) => left[0] - right[0]),
    winners.map((winner) => [winner.slot, winner.runId]).sort((left, right) => left[0] - right[0]),
    "盘上恰好两格，且持有者就是那两个成功者",
  );
  for (const loser of losers) {
    assert.equal(loser.reason, "capacity_full");
    assert.deepEqual(
      [...loser.holders].sort(),
      winners.map((winner) => winner.runId).sort(),
      "每个被拒的子进程都点名了两个持有者（跨进程看得见别人占的槽）",
    );
  }
});

// ================================================================ 3. 崩溃槽回收（真死 pid）

test("capacity（#630 S3）：崩溃进程留下的槽能被回收——真死 pid 让新 runId 拿到该格，总量不超 max", async () => {
  const dir = await makeTmp("delegation-capacity-630-crash-");
  const leaseDir = join(dir, "leases");
  // 真子进程抢一格然后退出：槽里留下的是它的真 pid，而进程已经没了。
  const dead = await runChild([CAPACITY_URL, leaseDir, "sub-dead", "2", "0"]);
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
