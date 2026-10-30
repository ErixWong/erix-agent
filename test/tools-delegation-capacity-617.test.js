// issue #617（P1a）/ issue #630 S3 —— 派生并发配额租约（`src/tools/delegation/capacity.js`）基础原语守门测试。
//
// 覆盖（本文件只管**基础原语**，S3 的六条判据与真跨进程证据在
// `test/tools-delegation-capacity-630.test.js`）：
//   · 固定槽位池：`open(..., "wx")` 独占创建 ⇒ 依次占格，占满即 `capacity_full` 并点名持有者；
//   · `release` 幂等、只删自己的槽、且能还掉「池子调小之后」高号槽里的租约；
//   · 读不出内容的槽位按 `corrupt` 点名（不静默丢）；旧的 `<runId>.lock` 不参与；
//   · 入参校验（`now` / `maxConcurrent` / `maxAgeMs`）。
//
// 卫生：临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp(...)`；全同步实现，零真实进程
// （存活与否全是注入的假谓词；真进程那条在 -630 文件里）。
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_LEASE_MAX_AGE_MS, acquire, list, release, sweep } from "../src/tools/delegation/capacity.js";
import { makeTmp } from "./helpers/tmp.js";

const NOW = 1_700_000_000_000;

test("capacity: 固定槽位池——依次占格，占满即 capacity_full 并点名持有者", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  const first = acquire(dir, { runId: "a", pid: 100, now: NOW, maxConcurrent: 2 });
  assert.deepEqual(first, { ok: true, lease: { runId: "a", acquiredAt: NOW, pid: 100, slot: 0 } });
  const second = acquire(dir, { runId: "b", pid: 200, now: NOW + 1, maxConcurrent: 2 });
  assert.deepEqual(second, { ok: true, lease: { runId: "b", acquiredAt: NOW + 1, pid: 200, slot: 1 } });
  // 第三份：两格都有人，点名两个持有者（不是「抢不到但说不出谁占着」）。
  const third = acquire(dir, { runId: "c", now: NOW + 2, maxConcurrent: 2 });
  assert.equal(third.ok, false);
  assert.equal(third.reason, "capacity_full");
  assert.equal(third.maxConcurrent, 2);
  assert.deepEqual(third.holders.map((holder) => [holder.runId, holder.slot]), [["a", 0], ["b", 1]]);
  // 还掉 a 之后 c 能拿到 a 那一格（不是「等整池清空」）。
  assert.deepEqual(release(dir, { runId: "a", maxConcurrent: 2 }), { ok: true, released: true, slot: 0 });
  const fourth = acquire(dir, { runId: "c", now: NOW + 3, maxConcurrent: 2 });
  assert.equal(fourth.ok, true);
  assert.equal(fourth.lease.slot, 0);
});

test("capacity: 租约内容就是 {runId, pid, acquiredAt, slot}；不给 pid 时该键不存在", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "a", now: NOW, maxConcurrent: 1 });
  const onDisk = JSON.parse(readFileSync(join(dir, "slot-0.lock"), "utf8"));
  assert.deepEqual(onDisk, { runId: "a", acquiredAt: NOW, slot: 0 });
  assert.ok(!("pid" in onDisk), "pid 没给就不落键");
});

test("capacity: release 幂等——没有自己的槽也算成功并如实报没删", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  assert.deepEqual(release(dir, { runId: "ghost", maxConcurrent: 2 }), { ok: true, released: false });
  acquire(dir, { runId: "a", now: NOW, maxConcurrent: 2 });
  assert.deepEqual(release(dir, { runId: "a", maxConcurrent: 2 }), { ok: true, released: true, slot: 0 });
  assert.deepEqual(release(dir, { runId: "a", maxConcurrent: 2 }), { ok: true, released: false }, "重复还不报错");
});

test("capacity: release 认得池子调小之后的高号槽（还的是「我的租约在哪」，不是「池子现在多大」）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  // 直接落一个 7 号槽的租约（模拟：宿主上一次跑的时候池子很大，现在把 maxConcurrent 调小了）。
  writeFileSync(join(dir, "slot-7.lock"), `${JSON.stringify({ runId: "old", acquiredAt: NOW, slot: 7 })}\n`);
  assert.deepEqual(release(dir, { runId: "old", maxConcurrent: 2 }), { ok: true, released: true, slot: 7 });
  assert.equal(list(dir, { maxConcurrent: 2 }).leases.length, 0);
});

test("capacity: list 点名读不出内容的槽位，不静默丢；旧的 <runId>.lock 不参与", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "ok", now: NOW, maxConcurrent: 2 });
  writeFileSync(join(dir, "slot-1.lock"), "{ not json");
  writeFileSync(join(dir, "legacy-runid.lock"), `${JSON.stringify({ runId: "legacy-runid", acquiredAt: NOW })}\n`);
  const { leases, corrupt } = list(dir, { maxConcurrent: 2 });
  assert.deepEqual(leases.map((lease) => [lease.runId, lease.slot]), [["ok", 0]]);
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].file, "slot-1.lock");
  assert.equal(corrupt[0].slot, 1);
});

test("capacity: 内容里的 slot 与文件名不符 ⇒ 按 corrupt 点名（不是本模块写的文件）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  writeFileSync(join(dir, "slot-0.lock"), `${JSON.stringify({ runId: "x", acquiredAt: NOW, slot: 3 })}\n`);
  const { leases, corrupt } = list(dir, { maxConcurrent: 2 });
  assert.equal(leases.length, 0);
  assert.equal(corrupt[0].slot, 0);
});

test("capacity: 读不出内容的槽位按 mtime 兜底可回收（否则一次半写就把配额锁死）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  writeFileSync(join(dir, "slot-0.lock"), "");
  const old = new Date(Date.now() - 2 * DEFAULT_LEASE_MAX_AGE_MS);
  utimesSync(join(dir, "slot-0.lock"), old, old);
  const got = acquire(dir, { runId: "a", now: NOW, maxConcurrent: 1 });
  assert.equal(got.ok, true, "超龄的 corrupt 槽位按 mtime 兜底回收");
  assert.equal(got.lease.slot, 0);
});

test("capacity: 刚写一半的槽位（mtime 新鲜）不回收——宁可等，也不删别人正在写的文件", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  writeFileSync(join(dir, "slot-0.lock"), "");
  const blocked = acquire(dir, { runId: "a", now: NOW, maxConcurrent: 1 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "capacity_full");
  assert.equal(blocked.corrupt[0].slot, 0, "点名了读不出内容的那一格");
});

test("capacity: sweep 是显式回收——谓词说死收、本进程拥有的不动、超龄无谓词收", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "dead", pid: 100, now: NOW, maxConcurrent: 3 });
  acquire(dir, { runId: "mine", pid: 200, now: NOW - 10 * 60_000, maxConcurrent: 3 });
  acquire(dir, { runId: "alive", pid: 300, now: NOW - 10 * 60_000, maxConcurrent: 3 });
  const result = sweep(dir, {
    maxConcurrent: 3,
    maxAgeMs: 60_000,
    ownedRunIds: ["mine"],
    isProcessAlive: (pid) => pid === 300,
    now: NOW,
  });
  assert.deepEqual(result.swept.map((s) => [s.runId, s.slot, s.reason]), [["dead", 0, "pid-dead"]]);
  assert.equal(result.kept, 2, "本进程拥有的不动；谓词说活的不动（哪怕超龄）");
  assert.deepEqual(list(dir, { maxConcurrent: 3 }).leases.map((l) => l.runId).sort(), ["alive", "mine"]);
});

test("capacity: 没有谓词时 sweep 走年龄兜底（超龄才收）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "stale", now: NOW - 10 * 60_000, maxConcurrent: 2 });
  acquire(dir, { runId: "fresh", now: NOW - 1_000, maxConcurrent: 2 });
  const result = sweep(dir, { maxConcurrent: 2, maxAgeMs: 60_000, now: NOW });
  assert.deepEqual(result.swept.map((s) => [s.runId, s.reason]), [["stale", "stale"]]);
  assert.equal(result.kept, 1);
});

test("capacity: now 必须由调用方传入（库不硬取时间）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  assert.throws(() => acquire(dir, { runId: "a" }), /acquiredAt/u);
  assert.throws(() => sweep(dir, {}), /now/u);
});

test("capacity: 入参校验——maxConcurrent / maxAgeMs / isProcessAlive / runId", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  assert.throws(() => acquire(dir, { runId: "a", now: NOW, maxConcurrent: 0 }), /maxConcurrent/u);
  assert.throws(() => acquire(dir, { runId: "a", now: NOW, maxAgeMs: 0 }), /maxAgeMs/u);
  assert.throws(() => acquire(dir, { runId: "a", now: NOW, isProcessAlive: true }), /isProcessAlive/u);
  assert.throws(() => acquire(dir, { runId: "../etc", now: NOW }), /runId/u);
  assert.throws(() => release(dir, { runId: "" }), /runId/u);
  assert.equal(DEFAULT_LEASE_MAX_AGE_MS, 30 * 60_000, "兜底阈值是 30 分钟（有据：明显长于子 run 的缺省寿命）");
});
