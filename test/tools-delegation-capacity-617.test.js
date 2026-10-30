// issue #617（P1a）——派生并发配额租约（`src/tools/delegation/capacity.js`）守门测试。
//
// 覆盖（工单清单）：
//   5. 租约：独占创建抢不到时返回持有者；`release` 幂等；`sweep` 两种分支
//      （谓词说死 / 无谓词但超龄且非本进程）都收到，未超龄的不动。
//   7. 不给的字段（pid）在落盘 JSON 里**不存在该键**。
//
// 卫生：临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp(...)`；全同步实现，零真实进程
// （存活与否全是注入的假谓词）。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { acquire, list, release, sweep } from "../src/tools/delegation/capacity.js";
import { makeTmp } from "./helpers/tmp.js";

const NOW = 1_700_000_000_000;

test("capacity: 独占创建——同 runId 的第二份返回持有者", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  const first = acquire(dir, { runId: "a", pid: 100, now: NOW });
  assert.deepEqual(first, { ok: true, lease: { runId: "a", pid: 100, acquiredAt: NOW } });
  // 同一个 runId 再来抢：文件已存在 = 抢不到，点名持有者。
  const second = acquire(dir, { runId: "a", pid: 200, now: NOW + 1 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "held");
  assert.deepEqual(second.holder, { runId: "a", pid: 100, acquiredAt: NOW }, "点名当前持有者");
  // 不同 runId 不互斥（租约本体是每 runId 一份；配额语义由宿主用目录容量表达）。
  assert.equal(acquire(dir, { runId: "b", now: NOW + 1 }).ok, true);
  release(dir, "a");
  const third = acquire(dir, { runId: "a", pid: 200, now: NOW + 2 });
  assert.equal(third.ok, true, "还掉之后能重新抢");
});

test("capacity: 损坏的持有者文件也点名（corrupt 标记），不静默丢", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  writeFileSync(join(dir, "a.lock"), "{ not json");
  const held = acquire(dir, { runId: "a", now: NOW });
  assert.equal(held.ok, false);
  assert.equal(held.holder.corrupt, true);
  assert.equal(held.holder.runId, "a");
});

test("capacity: release 幂等——不存在也算成功并如实报没删", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  assert.deepEqual(release(dir, "ghost"), { ok: true, released: false });
  acquire(dir, { runId: "a", now: NOW });
  assert.deepEqual(release(dir, "a"), { ok: true, released: true });
  assert.deepEqual(release(dir, "a"), { ok: true, released: false }, "重复还不报错");
});

test("capacity: 不给 pid 时落盘 JSON 不存在该键", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "a", now: NOW });
  const onDisk = JSON.parse(readFileSync(join(dir, "a.lock"), "utf8"));
  assert.deepEqual(onDisk, { runId: "a", acquiredAt: NOW });
  assert.ok(!("pid" in onDisk), "pid 没给就不落键");
});

test("capacity: list 点名损坏租约，不静默丢", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "ok", now: NOW });
  writeFileSync(join(dir, "bad.lock"), `${JSON.stringify({ runId: "别的", acquiredAt: 1 })}\n`);
  const { leases, corrupt } = list(dir);
  assert.deepEqual(leases.map((l) => l.runId), ["ok"]);
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].file, "bad.lock");
  assert.equal(corrupt[0].runId, "bad");
});

test("capacity: sweep 分支 1——谓词说死了 ⇒ 收（pid-dead）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "dead", pid: 100, now: NOW });
  acquire(dir, { runId: "alive", pid: 200, now: NOW });
  acquire(dir, { runId: "nopid", now: NOW });
  const result = sweep(dir, { isProcessAlive: (pid) => pid === 200, now: NOW + 60_000 });
  assert.deepEqual(result.swept.map((s) => [s.runId, s.reason]), [["dead", "pid-dead"]]);
  assert.equal(result.kept, 2, "活着的与没 pid 的都保留");
  assert.deepEqual(list(dir).leases.map((l) => l.runId).sort(), ["alive", "nopid"]);
});

test("capacity: sweep 分支 2——无谓词，超龄且非本进程 ⇒ 收（stale-unowned）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "stale", now: NOW - 10 * 60_000 });
  acquire(dir, { runId: "fresh", now: NOW - 1_000 });
  acquire(dir, { runId: "mine", now: NOW - 10 * 60_000 });
  const result = sweep(dir, { maxAgeMs: 60_000, ownedRunIds: ["mine"], now: NOW });
  assert.deepEqual(result.swept.map((s) => [s.runId, s.reason]), [["stale", "stale-unowned"]]);
  assert.equal(result.kept, 2, "未超龄的不动；本进程拥有的不动");
});

test("capacity: sweep 给了谓词但租约没 pid——两条分支都不收（保守）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  acquire(dir, { runId: "old-nopid", now: NOW - 10 * 60_000 });
  const result = sweep(dir, { isProcessAlive: () => false, maxAgeMs: 60_000, ownedRunIds: [], now: NOW });
  assert.equal(result.swept.length, 0);
  assert.equal(result.kept, 1);
});

test("capacity: sweep 点名损坏租约且不收", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  writeFileSync(join(dir, "bad.lock"), "not json");
  const result = sweep(dir, { maxAgeMs: 1, ownedRunIds: [], now: NOW });
  assert.equal(result.swept.length, 0);
  assert.equal(result.corrupt.length, 1);
  assert.equal(result.corrupt[0].runId, "bad");
});

test("capacity: now 必须由调用方传入（库不硬取时间）", async () => {
  const dir = await makeTmp("delegation-capacity-617-");
  assert.throws(() => acquire(dir, { runId: "a" }), /acquiredAt/u);
  assert.throws(() => sweep(dir, {}), /now/u);
});
