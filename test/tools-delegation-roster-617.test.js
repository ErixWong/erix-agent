// issue #617（P1a）——派生名册（`src/tools/delegation/roster.js`）守门测试。
//
// 覆盖（工单清单）：
//   1. 原子写：写一条 + 读回等值；`updatedAt` 在时钟回拨时不倒退。
//   2. 文件名与记录 `runId` 不等 ⇒ 进 `corrupt` 并点名，不被当成正常记录。
//   3. 重算三态：本进程所有者不动 / 谓词说活着 ⇒ `foreignOwned` 且不动 / 无人认领 ⇒
//      `interrupted` 且 **endedAt 等于原 updatedAt（不是 now）**。
//   4. 重算幂等。
//   7. 不给的字段在落盘 JSON 里**不存在该键**。
//
// 卫生：临时目录一律走 `test/helpers/tmp.js` 的 `makeTmp(...)`（不裸 mkdtemp——check:tests 门禁）；
// 全同步实现，零真实进程、零网络。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ROSTER_LIVE_STATES,
  ROSTER_STATES,
  listRecords,
  readRecord,
  reconcile,
  removeRecord,
  writeRecord,
} from "../src/tools/delegation/roster.js";
import { makeTmp } from "./helpers/tmp.js";

const NOW = 1_700_000_000_000;

/** 最小合法记录：活态 + 水位，其余字段一律不给。 */
function liveRecord(runId, updatedAt = NOW) {
  return { runId, state: "running", updatedAt, pid: 4242 };
}

test("roster: 封闭 7 态与活态面", () => {
  assert.deepEqual(ROSTER_STATES, ["queued", "running", "completed", "failed", "aborted", "timeout", "interrupted"]);
  assert.deepEqual(ROSTER_LIVE_STATES, ["queued", "running"]);
});

test("roster: 原子写——写一条 + 读回等值", async (t) => {
  const dir = await makeTmp("delegation-roster-617-");
  t.after(() => removeRecord(dir, "r1"));
  const record = { ...liveRecord("r1"), parentRunId: "p1", cwd: "/x", model: "m", createdAt: NOW - 100 };
  const written = writeRecord(dir, record);
  assert.deepEqual(readRecord(dir, "r1"), written);
  // 落盘内容就是读回内容（原子 rename 后的文件，不是临时文件）。
  const onDisk = JSON.parse(readFileSync(join(dir, "r1.json"), "utf8"));
  assert.equal(onDisk.runId, "r1");
  assert.equal(onDisk.parentRunId, "p1");
  // 写完不应留下任何 .tmp- 残留。
  assert.equal(readdirSync(dir).filter((f) => f.includes(".tmp-")).length, 0);
});

test("roster: updatedAt 时钟回拨不倒退（单调水位）", async (t) => {
  const dir = await makeTmp("delegation-roster-617-");
  t.after(() => removeRecord(dir, "r1"));
  writeRecord(dir, liveRecord("r1", 5_000));
  // 回拨时钟：用更低的 updatedAt 再写一次。
  const written = writeRecord(dir, { ...liveRecord("r1", 1_000), state: "completed" });
  assert.equal(written.updatedAt, 5_000, "updatedAt 必须保留更高的旧水位");
  assert.equal(readRecord(dir, "r1").state, "completed", "其余字段照常按本次写更新");
  // 前进方向不受影响：更高的值正常前移。
  assert.equal(writeRecord(dir, liveRecord("r1", 9_000)).updatedAt, 9_000);
});

test("roster: 文件名与记录 runId 不等 ⇒ corrupt 并点名，不当正常记录", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  // 直接往磁盘塞一份「文件名说 r1、记录自己说 r2」的损坏件。
  writeFileSync(join(dir, "r1.json"), `${JSON.stringify({ runId: "r2", state: "running", updatedAt: NOW })}\n`);
  writeFileSync(join(dir, "ok.json"), `${JSON.stringify({ runId: "ok", state: "running", updatedAt: NOW })}\n`);
  const { records, corrupt } = listRecords(dir);
  assert.deepEqual(records.map((r) => r.runId), ["ok"], "损坏件不得混进正常记录");
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].file, "r1.json");
  assert.equal(corrupt[0].runId, "r1", "点名采用文件名身份，不采用记录内自称身份");
  assert.match(corrupt[0].reason, /不符/u);
  // reconcile 同样把损坏件点名出来，且不碰它。
  const result = reconcile(dir, { ownedRunIds: ["ok"], now: NOW + 1 });
  assert.equal(result.corrupt.length, 1);
  assert.equal(result.corrupt[0].file, "r1.json");
  assert.equal(result.interrupted.length, 0);
  assert.equal(result.unchanged, 1, "只有 ok 一条正常记录且归本进程所有");
  // 库不就地改名修复：损坏件原样还在；按 runId 寻址读它会被拒绝（点名损坏，不猜）。
  assert.throws(() => readRecord(dir, "r1"), /损坏/u);
  assert.match(readFileSync(join(dir, "r1.json"), "utf8"), /"runId":"r2"/u, "损坏件逐字节未被改动");
});

test("roster: 损坏的 JSON（解析失败）也进 corrupt 点名", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeFileSync(join(dir, "broken.json"), "{ not json");
  const { records, corrupt } = listRecords(dir);
  assert.equal(records.length, 0);
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].runId, "broken");
  assert.match(corrupt[0].reason, /解析失败/u);
});

test("roster: 重算——本进程所有者不动", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeRecord(dir, liveRecord("mine"));
  const before = readRecord(dir, "mine");
  const result = reconcile(dir, { ownedRunIds: ["mine"], isProcessAlive: () => false, now: NOW + 999 });
  assert.equal(result.interrupted.length, 0);
  assert.equal(result.foreignOwned.length, 0);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(readRecord(dir, "mine"), before, "所有者的记录逐字节不动");
});

test("roster: 重算——谓词说活着 ⇒ foreignOwned 且不动", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeRecord(dir, liveRecord("other-host"));
  const before = readRecord(dir, "other-host");
  const result = reconcile(dir, { ownedRunIds: [], isProcessAlive: (pid) => pid === 4242, now: NOW + 999 });
  assert.equal(result.interrupted.length, 0);
  assert.deepEqual(result.foreignOwned, [
    { runId: "other-host", pid: 4242, reason: result.foreignOwned[0].reason },
  ]);
  assert.match(result.foreignOwned[0].reason, /另一宿主/u);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(readRecord(dir, "other-host"), before, "foreignOwned 只点名，不写记录");
});

test("roster: 重算——无人认领 ⇒ interrupted 且 endedAt = 原 updatedAt（不是 now）", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeRecord(dir, { ...liveRecord("orphan", 1_111), state: "queued" });
  const now = NOW + 999_999;
  const result = reconcile(dir, { ownedRunIds: [], isProcessAlive: () => false, now });
  assert.equal(result.interrupted.length, 1);
  assert.equal(result.interrupted[0].runId, "orphan");
  assert.equal(result.interrupted[0].endedAt, 1_111, "endedAt 是最后一次已知时间，不是探到的 now");
  assert.notEqual(result.interrupted[0].endedAt, now);
  const after = readRecord(dir, "orphan");
  assert.equal(after.state, "interrupted");
  assert.equal(after.endedAt, 1_111, "落盘记录里 endedAt 同样是原 updatedAt");
  assert.equal(after.updatedAt, now, "updatedAt 照常前移到重算时刻");
});

test("roster: 重算——没给谓词、没给 pid 的无人认领记录同样判 interrupted", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeRecord(dir, { runId: "nopid", state: "running", updatedAt: 2_222 });
  const result = reconcile(dir, { ownedRunIds: [], now: NOW });
  assert.deepEqual(result.interrupted.map((e) => e.runId), ["nopid"]);
  assert.equal(result.interrupted[0].endedAt, 2_222);
});

test("roster: 重算幂等——第二次跑不再改、不再产生新的 interrupted", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeRecord(dir, liveRecord("orphan", 3_333));
  const first = reconcile(dir, { ownedRunIds: [], isProcessAlive: () => false, now: NOW });
  assert.equal(first.interrupted.length, 1);
  const snapshot = readRecord(dir, "orphan");
  const second = reconcile(dir, { ownedRunIds: [], isProcessAlive: () => false, now: NOW + 1000 });
  assert.equal(second.interrupted.length, 0, "终态记录不再被重算");
  assert.equal(second.unchanged, 1);
  assert.deepEqual(readRecord(dir, "orphan"), snapshot, "第二次跑逐字节不动");
});

test("roster: 终态记录（completed 等）永不参与重算", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeRecord(dir, { runId: "done", state: "completed", updatedAt: NOW, endedAt: NOW });
  const result = reconcile(dir, { ownedRunIds: [], isProcessAlive: () => false, now: NOW + 1 });
  assert.equal(result.interrupted.length, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(readRecord(dir, "done").state, "completed");
});

test("roster: 不给的字段在落盘 JSON 里不存在该键", async (t) => {
  const dir = await makeTmp("delegation-roster-617-");
  t.after(() => removeRecord(dir, "sparse"));
  writeRecord(dir, { runId: "sparse", state: "running", updatedAt: NOW });
  const onDisk = JSON.parse(readFileSync(join(dir, "sparse.json"), "utf8"));
  const OPTIONAL = [
    "parentRunId", "cwd", "model", "taskDigest", "createdAt", "endedAt", "deadlineAt",
    "timedOut", "termination", "verification", "notifyStatus", "wakeStatus",
    "statusPath", "transcriptPath", "pid",
  ];
  for (const key of OPTIONAL) {
    assert.ok(!(key in onDisk), `落盘 JSON 不得出现未给的键 ${key}`);
  }
  assert.deepEqual(Object.keys(onDisk).sort(), ["runId", "state", "updatedAt"]);
  // opaque 字段给了就原样存、原样取（库不解释，但也不拦）。
  writeRecord(dir, {
    runId: "sparse", state: "failed", updatedAt: NOW + 1,
    termination: { reason: "whatever-host-says" }, verification: { status: "skipped" },
  });
  const roundTrip = readRecord(dir, "sparse");
  assert.deepEqual(roundTrip.termination, { reason: "whatever-host-says" });
  assert.deepEqual(roundTrip.verification, { status: "skipped" });
});

test("roster: 写入校验——state 不在封闭 7 值内当场拒", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  assert.throws(() => writeRecord(dir, { runId: "x", state: "paused", updatedAt: NOW }), /封闭 7 值/u);
  assert.throws(() => writeRecord(dir, { runId: "../escape", state: "running", updatedAt: NOW }), /路径危险/u);
  assert.throws(() => writeRecord(dir, { runId: "x", state: "running", updatedAt: Number.NaN }), /updatedAt/u);
  assert.equal(listRecords(dir).records.length, 0, "被拒的写不落盘");
});

test("roster: removeRecord 幂等", async () => {
  const dir = await makeTmp("delegation-roster-617-");
  writeRecord(dir, liveRecord("r1"));
  assert.equal(removeRecord(dir, "r1"), true);
  assert.equal(removeRecord(dir, "r1"), false, "再删一次算成功且如实报没删");
  assert.equal(readRecord(dir, "r1"), null);
});
