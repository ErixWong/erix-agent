// issue #652 —— 占格从「先 wx 建空文件、再补内容」改成「整份内容先写进同目录临时文件、再排他发布」。
//
// 本文件是这一刀的判据集。三件事，都不靠 sleep 赌时序：
//   1. **半写窗口**：用注入点 `onBeforePublish`（临时文件已写完、槽位名还没发布的那一刻）让「另一个
//      观察者读这一格」变成**确定性**的一步。断言观察者**永远**看不到空/半截的槽位文件：要么还没有
//      这个文件名，要么内容完整。旧实现（wx 后写）在同一个注入点上是「文件存在、内容空」⇒ 红。
//   2. **最后一格的竞争**：在同一个注入点里把第二个竞争者整段跑完（A 的临时文件已写好、还没发布时
//      B 抢先发布）⇒ 恰好一个成功、另一个走「这一格没抢到」，既不许「两个都赢」（`rename` 覆盖发布
//      会这样），也不许「谁都没占上但文件留着」。
//   3. **崩溃残留**：`slot-<i>.lock.tmp-…` 既不是槽位（不占配额、不进 corrupt 点名），也不会永久留下
//      ——超龄的被 `acquire` 开头静默清掉、被 `sweep` 显式清掉并逐个点名；年轻的（可能是另一个进程
//      正在发布的那一份）一个字节都不动。
//
// 卫生：临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp()`；全同步实现，零真实进程（真跨进程证据在
// `test/tools-delegation-capacity-630.test.js`）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_LEASE_MAX_AGE_MS, acquire, list, sweep } from "../src/tools/delegation/capacity.js";
import { makeTmp } from "./helpers/tmp.js";

const NOW = 1_700_000_000_000;

test("capacity（#652）：内容落地之前，另一个观察者永远看不到空/半截的槽位", async () => {
  const dir = await makeTmp("delegation-capacity-652-halfwrite-");
  const leaseDir = join(dir, "leases");
  /** @type {Array<{ slotExists: boolean, raw: string | null, corrupt: number, leases: number }>} */
  const seen = [];

  const result = acquire(leaseDir, {
    runId: "sub-writer",
    pid: 4242,
    now: NOW,
    maxConcurrent: 1,
    onBeforePublish: ({ slot }) => {
      // 观察者视角：此刻另一个进程读这一格会读到什么。注入点是同步的，所以这就是一个**确定的**交错，
      // 不是「跑一万次碰上一次」。
      const file = join(leaseDir, `slot-${slot}.lock`);
      const { leases, corrupt } = list(leaseDir, { maxConcurrent: 1 });
      seen.push({
        slotExists: existsSync(file),
        raw: existsSync(file) ? readFileSync(file, "utf8") : null,
        corrupt: corrupt.length,
        leases: leases.length,
      });
    },
  });

  assert.equal(result.ok, true, "写者最终抢到了那一格");
  assert.equal(seen.length, 1, "接缝恰好被调用一次（一格、一次发布）");
  console.log(`[#652 半写窗口] 发布之前观察者看到：${JSON.stringify(seen[0])}`);

  // ---- 承诺（与实现手段无关的那条）----
  assert.equal(
    seen[0].corrupt,
    0,
    "观察者看不到读不出持有者的槽位（旧实现：wx 已建好、内容未落 ⇒ 这里会读到 1 格 corrupt）",
  );
  assert.ok(
    seen[0].raw === null || JSON.parse(seen[0].raw).runId === "sub-writer",
    `槽位文件要么还不存在、要么内容完整，实际读到的字节：${JSON.stringify(seen[0].raw)}`,
  );
  // ---- 本次实现的形态（把「为什么」也钉住：内容先待在临时文件里，槽位名还没出现）----
  assert.equal(seen[0].slotExists, false, "发布之前连槽位名都还不存在（不是「存在但空」）");
  assert.equal(seen[0].leases, 0, "也没有可读的持有者：这一格此刻对所有人都是空的");

  // ---- 发布之后：内容完整，且临时文件已被清掉（不留垃圾）----
  assert.deepEqual(JSON.parse(readFileSync(join(leaseDir, "slot-0.lock"), "utf8")), {
    runId: "sub-writer",
    acquiredAt: NOW,
    pid: 4242,
    slot: 0,
  });
  assert.deepEqual(readdirSync(leaseDir), ["slot-0.lock"], "发布完只留下槽位名，临时文件已删");
});

test("capacity（#652）：两个竞争者抢最后一格 ⇒ 恰好一个成功、另一个走「没抢到」，没有无主文件", async () => {
  const dir = await makeTmp("delegation-capacity-652-lastslot-");
  const leaseDir = join(dir, "leases");
  /** @type {ReturnType<typeof acquire> | null} */
  let second = null;

  const first = acquire(leaseDir, {
    runId: "sub-first",
    pid: 1111,
    now: NOW,
    maxConcurrent: 1,
    onBeforePublish: () => {
      if (second !== null) return;
      // 最坏交错：A 的整份内容已经写进临时文件，只差发布；此刻 B 从零开始把同一格抢走。
      second = acquire(leaseDir, { runId: "sub-second", pid: 2222, now: NOW + 1, maxConcurrent: 1 });
    },
  });

  assert.notEqual(second, null, "接缝里的竞争者真的整段跑完了");
  assert.equal(second.ok, true, "先发布的是 sub-second（它抢在 sub-first 的发布之前）");
  assert.equal(first.ok, false, "sub-first 的发布撞上已被占住的槽位 ⇒ 不许覆盖，更不许报成功");
  assert.equal(first.reason, "capacity_full");
  assert.deepEqual(first.holders.map((holder) => [holder.runId, holder.slot]), [["sub-second", 0]],
    "被拒者点名的是那个真持有者");
  assert.equal(
    [first, second].filter((result) => result.ok === true).length,
    1,
    "恰好一个赢家（用 rename 覆盖发布会让这里变成 2）",
  );

  // 盘上恰好一格、内容是赢家的完整租约，且没有残留的临时文件。
  const { leases, corrupt } = list(leaseDir, { maxConcurrent: 1 });
  assert.deepEqual(leases.map((lease) => [lease.runId, lease.slot]), [["sub-second", 0]]);
  assert.deepEqual(corrupt, [], "没有读不出持有者的槽");
  assert.deepEqual(readdirSync(leaseDir), ["slot-0.lock"], "输家的临时文件在 finally 里删掉了，一个不留");

  // 第三个来者仍然被拒：这一格是「有主的」，不是「谁都没占上但文件留着」。
  const third = acquire(leaseDir, { runId: "sub-third", pid: 3333, now: NOW + 2, maxConcurrent: 1 });
  assert.equal(third.ok, false);
  assert.equal(third.reason, "capacity_full");
  assert.deepEqual(third.holders.map((holder) => holder.runId), ["sub-second"]);
});

test("capacity（#652）：崩溃残留的临时文件不是槽位、不占配额，且不会被永久留下", async () => {
  const dir = await makeTmp("delegation-capacity-652-temp-");
  const leaseDir = join(dir, "leases");
  mkdirSync(leaseDir, { recursive: true });
  const staleTemp = join(leaseDir, "slot-0.lock.tmp-999999-1-ab12cd");
  writeFileSync(staleTemp, `${JSON.stringify({ runId: "ghost", acquiredAt: NOW, slot: 0 })}\n`);
  const old = new Date(Date.now() - 2 * DEFAULT_LEASE_MAX_AGE_MS);
  utimesSync(staleTemp, old, old);

  // ① 它不是槽位：只有一格的池子照样抢得到（残留不占额、也不进 corrupt 点名）。
  const got = acquire(leaseDir, { runId: "sub-a", pid: 1, now: NOW, maxConcurrent: 1 });
  assert.equal(got.ok, true, "临时残留不占配额");
  assert.equal(got.lease.slot, 0);
  assert.deepEqual(list(leaseDir, { maxConcurrent: 1 }).corrupt, [], "临时残留不进 corrupt 点名（它不是读不出的槽）");
  // ② 超龄 ⇒ acquire 开头顺手清掉（否则崩溃一次就永久留一份垃圾）。
  assert.equal(existsSync(staleTemp), false, "超龄的临时残留被 acquire 的兜底路径清掉");

  // ③ 年轻的临时文件一个字节都不许动：它可能是另一个进程**正在发布**的那一份。
  const freshTemp = join(leaseDir, "slot-0.lock.tmp-999999-2-ab12ce");
  writeFileSync(freshTemp, `${JSON.stringify({ runId: "inflight", acquiredAt: NOW, slot: 0 })}\n`);
  const sweptFresh = sweep(leaseDir, {
    now: NOW,
    maxConcurrent: 1,
    maxAgeMs: DEFAULT_LEASE_MAX_AGE_MS,
    ownedRunIds: ["sub-a"],
  });
  assert.deepEqual(sweptFresh.temps, [], "年轻的临时文件不动");
  assert.equal(existsSync(freshTemp), true, "宁可留一份垃圾，也不删活着的发布者的临时文件");

  // ④ 超龄 ⇒ sweep 显式清掉并逐个点名（不静默）；它不是租约，所以不进 swept、也不进 kept。
  utimesSync(freshTemp, old, old);
  const sweptOld = sweep(leaseDir, {
    now: NOW,
    maxConcurrent: 1,
    maxAgeMs: DEFAULT_LEASE_MAX_AGE_MS,
    ownedRunIds: ["sub-a"],
  });
  assert.deepEqual(sweptOld.temps, ["slot-0.lock.tmp-999999-2-ab12ce"], "sweep 把清掉的临时文件逐个报出来");
  assert.equal(existsSync(freshTemp), false);
  assert.deepEqual(sweptOld.swept, [], "临时文件不算 swept（它不是租约）");
  assert.equal(sweptOld.kept, 1, "sub-a 的租约还在（ownedRunIds 保护）");
  assert.deepEqual(list(leaseDir, { maxConcurrent: 1 }).leases.map((lease) => lease.runId), ["sub-a"]);

  // ⑤ 接缝不是静音开关：给了非函数就当场拒。
  const other = await makeTmp("delegation-capacity-652-seam-");
  assert.throws(
    () => acquire(other, { runId: "sub-b", now: NOW, onBeforePublish: /** @type {any} */ (true) }),
    /onBeforePublish/u,
  );
});
