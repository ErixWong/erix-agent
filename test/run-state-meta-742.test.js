// issue #742 第一刀（只做可观测）：`measureRunStateMeta` 的三个形状。
//
// 这一格的全部职责是「让宿主看得见轮记录里那份 run-state 副本有没有超出单状态上限」，
// 它**不减少任何字节**：不改副本、不改 `bounds` 语义、不改轮记录随轮数增长这件事。
//
// 三条判据落在三个形状上（超上限 / 不超 / 拿不到值），外加一格**源码格**钉住
// 「上限从导出常量取」与「truncated 不是常量」——那两条都不是值断言能守住的：写字面 65536
// 在常量今天恰好等于 65536 时与常量写法**同值**，只有扫源码才分得开（本仓今天已为此返工三次）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createDeterministicRunState,
  measureRunStateMeta,
  renderRunState,
  RUN_STATE_MAX_SERIALIZED_BYTES,
  withSemanticRunState,
} from "../src/run-state.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 与实现同一把尺（`Buffer.byteLength(JSON.stringify(v), "utf8")`），由测试**独立**再算一遍。 */
const expectedBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("#742 超上限的形状：truncated 为真、bytes 大于 capBytes、capBytes 取导出常量的实测值", () => {
  const state = { stateVersion: 1, rendered: "x".repeat(RUN_STATE_MAX_SERIALIZED_BYTES + 10) };
  const meta = measureRunStateMeta(state);

  assert.notEqual(meta, undefined);
  assert.equal(meta.capBytes, RUN_STATE_MAX_SERIALIZED_BYTES);
  assert.ok(meta.bytes > meta.capBytes, `bytes=${String(meta.bytes)} 必须大于 capBytes=${String(meta.capBytes)}`);
  assert.equal(meta.truncated, true);
  // 同一把尺：与序列化口径逐字节相等（不是 `> 0` 那种糊过去的断言）。
  assert.equal(meta.bytes, expectedBytes(state));
});

test("#742 不超上限也没夹断章：truncated 为假、bytes 与实际序列化字节逐字节一致", () => {
  // 一份引擎自己产出的状态（不是随手造的字典），再加上写点在夹断**之后**才挂上的 `rendered`。
  const state = withSemanticRunState(createDeterministicRunState({
    runId: "meta-below-cap",
    stateVersion: 2,
    rounds: 3,
    maxRounds: 10,
    toolStats: new Map([["readFile", { calls: 4, failures: 1 }]]),
    filesWritten: ["src/a.js"],
  }), { text: "一条不长的语义摘要", version: 2 });
  state.rendered = renderRunState(state);
  const meta = measureRunStateMeta(state);

  assert.notEqual(meta, undefined);
  assert.equal(meta.capBytes, RUN_STATE_MAX_SERIALIZED_BYTES);
  assert.equal(meta.truncated, false);
  // 「一致」的口径（写进报告）：meta.bytes **逐字节等于** `Buffer.byteLength(JSON.stringify(该副本), "utf8")`
  // —— 与 `boundRunState` 判 `bounds.truncated` 用的是同一句话，两条尺不许各写一份。
  assert.equal(meta.bytes, expectedBytes(state));
  assert.ok(meta.bytes < meta.capBytes);
});

test("#742 副本被引擎夹断过（夹断章在上限内）：truncated 仍要为真", () => {
  // 实测：夹断发生在轮记录写点的**上游**（`boundRunState`），落盘的副本本身反而在上限内
  // （128 工具 / 128 文件 / 64 todo / 1200 字 semantic 的极端轮也只到 28 KB）。
  // 只看 `bytes > capBytes` 会把真被夹断的那一轮报成「没截断」，而夹断章
  // （`bounds.truncated` + `reason: "serialized_size"`）正是现成的那一笔 —— 两个事实取或。
  const state = {
    schemaVersion: 1,
    runId: "clamped-under-cap",
    stateVersion: 3,
    asOfRound: 3,
    stateStatus: "available",
    deterministic: { budget: {}, tools: [], filesWritten: [], fold: {}, termination: { reason: "running" }, errors: {} },
    bounds: { maxSerializedBytes: RUN_STATE_MAX_SERIALIZED_BYTES, truncated: true, reason: "serialized_size", omittedTools: 1 },
  };
  const meta = measureRunStateMeta(state);
  assert.notEqual(meta, undefined);
  assert.ok(meta.bytes < meta.capBytes, "该形状本来就在上限内 ⇒ 这一格走的必须是夹断章那条路");
  assert.equal(meta.truncated, true);
  assert.equal(meta.capBytes, RUN_STATE_MAX_SERIALIZED_BYTES);
});

test("#742 恰好等于上限且无夹断章：算「没截断」，边界不双计", () => {
  // `bytes > capBytes` 才是超出；恰好等于上限是本切片刻意留在「未截断」一侧的边界（`>=` 会双计）。
  // `JSON.stringify({ pad: "x".repeat(n) })` 是 `{"pad":"x…"}` ⇒ `10 + n` 字节（实测 overhead=10，见下格），
  // 取 `n = capBytes - 10` 让总数**恰好**等于上限。
  assert.equal(Buffer.byteLength(JSON.stringify({ pad: "x" }), "utf8"), 11);
  const state = { pad: "x".repeat(RUN_STATE_MAX_SERIALIZED_BYTES - 10) };
  const meta = measureRunStateMeta(state);
  assert.notEqual(meta, undefined);
  assert.equal(meta.bytes, RUN_STATE_MAX_SERIALIZED_BYTES);
  assert.equal(meta.truncated, false);
});

test("#742 拿不到值就返回 undefined：读侧不得伪报 truncated:false", () => {
  // 非普通对象（宿主自己构造的轮记录形状常常是这些）⇒ 没有值，不是「零值」。
  assert.equal(measureRunStateMeta(undefined), undefined);
  assert.equal(measureRunStateMeta(null), undefined);
  assert.equal(measureRunStateMeta("state"), undefined);
  assert.equal(measureRunStateMeta(42), undefined);
  assert.equal(measureRunStateMeta([]), undefined);
  // 序列化不了（循环引用 ⇒ JSON.stringify 抛）同样是不写，而不是写一个假字节数。
  const circular = { stateVersion: 1 };
  circular.self = circular;
  assert.equal(measureRunStateMeta(circular), undefined);
  const bigint = { stateVersion: 1, n: 1n };
  assert.equal(measureRunStateMeta(bigint), undefined);
});

// ── 源码格：两条「同值但不同义」的写法，只有扫源码才分得开 ──────────────────────────────
test("#742 上限必须来自导出常量、truncated 必须是算出来的（源码格）", async () => {
  const source = await readFile(join(here, "..", "src", "run-state.js"), "utf8");
  const start = source.indexOf("export function measureRunStateMeta");
  assert.ok(start >= 0, "measureRunStateMeta 必须导出");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);

  // ① 不许写字面 65536 / 64 * 1024：写了就是把这把尺复制成第二份，常量调整时元数据静默说谎。
  assert.doesNotMatch(body, /\b65536\b/u, "capBytes 不许写死字面 65536");
  assert.doesNotMatch(body, /64\s*\*\s*1024/u, "capBytes 不许写死 64 * 1024");
  assert.match(body, /capBytes:\s*RUN_STATE_MAX_SERIALIZED_BYTES/u);
  assert.match(body, /RUN_STATE_MAX_SERIALIZED_BYTES\b/u);
  // ② truncated 必须是算出来的（两个截断事实取或），不得被写死成 false（写死 ⇒ 观测恒绿）。
  assert.doesNotMatch(body, /truncated:\s*false/u);
  assert.match(body, /truncated:\s*overCap\s*\|\|\s*clamped/u);
  assert.match(body, /const overCap = bytes > RUN_STATE_MAX_SERIALIZED_BYTES/u);
  assert.match(body, /const clamped = state\?\.bounds\?\.truncated === true/u);
  // ③ 字节尺必须复用 `serializedBytes`（`boundRunState` 判 bounds.truncated 用的那一句）。
  assert.match(body, /serializedBytes\(\s*state\s*\)/u, "字节尺必须复用 serializedBytes");
});
