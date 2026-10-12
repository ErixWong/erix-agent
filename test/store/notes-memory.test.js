// createMemoryNotesStore（issue #265）的回归面。
//
// 结构与 test/store/notes.test.js 同构：先让**通用契约套件**对内存适配器跑一遍
// （table-driven：与文件版、物理删除版共用同一组用例名，输出里三套 label 并列即
// 「两个 adapter 各跑一遍」的证明），再补内存适配器专属断言——重点是注入 clock
// 驱动的 purge 保留期语义（文件版靠 mtime + utimes，这里靠 clock，语义同一份
// src/store/notes-port.js）。
import assert from "node:assert/strict";
import test from "node:test";

import * as libIndex from "../../src/index.js";
import { assertNotesStore } from "../../src/store/notes.js";
import { createMemoryNotesStore } from "../../src/store/notes-memory.js";
import { notesStoreCasContract, notesStoreContract } from "../contract/notes-store.js";

// table-driven：与 test/store/notes.test.js（"file notes"）、
// test/store/notes-store-forms.test.js（"physical-delete notes"/"cas-conflict notes"）
// 同一组套件，adapter label 换成 "memory notes"。
notesStoreContract("memory notes", () => createMemoryNotesStore());
notesStoreCasContract("memory notes", () => createMemoryNotesStore());

const DAY = 24 * 60 * 60 * 1000;

function makeRecord(key, scopeRef, overrides = {}) {
  return {
    key,
    scope: "run",
    scopeRef,
    current: { content: "value", provenance: { source: "agent" }, ts: "2026-09-15T00:00:00.000Z" },
    superseded: [],
    folded: 0,
    tags: [],
    relevance: 0.5,
    state: "active",
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

function withNotesEnv(name, value, callback) {
  const previous = process.env[name];
  process.env[name] = value;
  const restore = () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
  return Promise.resolve()
    .then(callback)
    .finally(restore);
}

test("memory notes: 从包根导出且端口完整（与 createFileNotesStore 并列的公共面）", () => {
  assert.equal(typeof libIndex.createMemoryNotesStore, "function");
  assert.equal(libIndex.createMemoryNotesStore, createMemoryNotesStore, "index 再导出与实现同一函数");
  assert.doesNotThrow(() => assertNotesStore(createMemoryNotesStore()));
});

test("memory notes: clock 非函数直接抛 TypeError（与文件版构造同语义）", () => {
  assert.throws(() => createMemoryNotesStore({ clock: 42 }), /clock must be a function/u);
});

test("memory notes: purge 保留期由注入 clock 驱动——过期 scope 整本删、活 scope 豁免、复活续命", async () => {
  let now = Date.UTC(2026, 8, 1);
  const store = createMemoryNotesStore({ clock: () => now });
  await store.write({ scope: "run", scopeRef: "old-run", key: "a", record: makeRecord("a", "old-run") });
  await store.write({ scope: "run", scopeRef: "old-run", key: "b", record: makeRecord("b", "old-run", { state: "done" }) });
  await store.write({ scope: "run", scopeRef: "live-run", key: "c", record: makeRecord("c", "live-run") });
  // 推进 31 天后仅再写 live-run：old-run 时钟停在 T0（>30 天），live-run 续命。
  now += 31 * DAY;
  await store.write({ scope: "run", scopeRef: "live-run", key: "d", record: makeRecord("d", "live-run") });
  assert.deepEqual(
    await store.purge({ scope: "run" }),
    { status: "found", scanned: 2, purged: 2 },
    "scanned = scope 数；过期 scope 整本删除（done 也删，单时钟 ADR-018 D7）",
  );
  assert.equal(await store.read({ scope: "run", scopeRef: "old-run", key: "a" }), undefined);
  assert.equal((await store.read({ scope: "run", scopeRef: "live-run", key: "c" })).state, "active");
  // 复活续命：31 天后再写一笔，整个 scope 重新豁免。
  await store.write({ scope: "run", scopeRef: "live-run", key: "e", record: makeRecord("e", "live-run") });
  assert.equal((await store.purge({ scope: "run" })).purged, 0);
});

test("memory notes: purge 的 before 只能缩小窗口；ERIX_NOTES_RETENTION_MS 同文件版生效", async () => {
  const T0 = Date.UTC(2026, 8, 1);
  await withNotesEnv("ERIX_NOTES_RETENTION_MS", String(60_000), async () => {
    let envNow = T0;
    const store = createMemoryNotesStore({ clock: () => envNow });
    await store.write({ scope: "run", scopeRef: "env-run", key: "x", record: makeRecord("x", "env-run") });
    // 写入时钟 = T0，真实 clock 推到 T0+120s：自然 cutoff（T0+60s）已过 → 该删。
    envNow = T0 + 120_000;
    assert.equal((await store.purge({ scope: "run" })).purged, 1, "env 保留期 60s 生效");
  });
  let now = T0;
  const store = createMemoryNotesStore({ clock: () => now });
  await store.write({ scope: "run", scopeRef: "before-run", key: "x", record: makeRecord("x", "before-run") });
  now = T0 + 31 * DAY;
  assert.equal(
    (await store.purge({ before: new Date(T0).toISOString() })).purged,
    0,
    "before 恰等于最后写入时刻 → >= 豁免（窗口被缩小到不删）",
  );
  assert.equal((await store.purge({ scope: "run" })).purged, 1, "自然 cutoff 下该删的照删");
  await assert.rejects(
    store.purge({ before: "not-a-date" }),
    (error) => error instanceof TypeError && /parseable date/u.test(error.message),
  );
});

test("memory notes: source 过滤与 revoke 字段落盘与文件版逐字同语义", async () => {
  const T = Date.UTC(2026, 8, 27);
  const store = createMemoryNotesStore({ clock: () => T });
  await store.write({
    scope: "run", scopeRef: "src-run", key: "auto-note",
    record: makeRecord("auto-note", "src-run", {
      current: { content: "a", provenance: { source: "auto" }, ts: "2026-09-15T00:00:00.000Z" },
    }),
  });
  await store.write({ scope: "run", scopeRef: "src-run", key: "plain-note", record: makeRecord("plain-note", "src-run") });
  assert.deepEqual(
    (await store.list({ scope: "run", scopeRef: "src-run", filters: { source: "auto" } }))
      .map((record) => record.key),
    ["auto-note"],
  );
  assert.deepEqual(
    (await store.list({ scope: "run", scopeRef: "src-run", filters: { source: "agent" } }))
      .map((record) => record.key),
    ["plain-note"],
    "无 provenance.source 的记录归 agent（与文件版判定式同）",
  );
  await store.revoke({ scope: "run", scopeRef: "src-run", key: "plain-note", reason: "cleanup" });
  const tombstone = await store.read({ scope: "run", scopeRef: "src-run", key: "plain-note" });
  assert.equal(tombstone.state, "revoked");
  assert.equal(tombstone.revoked_at, new Date(T).toISOString(), "注入 clock 必须进 revoked_at（与文件版同）");
  assert.equal(tombstone.revoke_reason, "cleanup");
});

test("memory notes: 返回值不得是内部引用（mutate 出口值不得渗进 store）", async () => {
  const store = createMemoryNotesStore();
  const record = makeRecord("iso", "iso-run", { tags: ["keep"], current: { content: "v" } });
  await store.write({ scope: "run", scopeRef: "iso-run", key: "iso", record });
  // 写入后 mutate 调用方的 record，store 里必须原样（JSON 快照语义，同文件版落盘）。
  record.current.content = "mutated-after-write";
  record.tags.push("sneaked");
  const read = await store.read({ scope: "run", scopeRef: "iso-run", key: "iso" });
  assert.equal(read.current.content, "v");
  assert.deepEqual(read.tags, ["keep"]);
  read.current.content = "mutated-at-exit";
  assert.equal((await store.read({ scope: "run", scopeRef: "iso-run", key: "iso" })).current.content, "v");
  assert.equal((await store.list({ scope: "run", scopeRef: "iso-run" }))[0].current.content, "v");
});

test("memory notes: scopeRef canonicalize 不改记录公开 key（unsafe ↔ run-h 双入口）", async () => {
  const store = createMemoryNotesStore();
  const unsafe = "../escape";
  await store.write({ scope: "run", scopeRef: unsafe, key: "k", record: makeRecord("k", unsafe) });
  const canonical = await store.read({ scope: "run", scopeRef: unsafe, key: "k" });
  assert.match(canonical.scopeRef, /^run-h-[0-9a-f]{24}$/u);
  assert.equal(canonical.key, "k", "公开 key 不被文件名 sanitize 改写");
  assert.equal((await store.list({ scope: "run", scopeRef: canonical.scopeRef })).length, 1);
});

test("memory notes: complete/revoke 走共享守卫——done 不动、护栏不符 unchanged", async () => {
  const store = createMemoryNotesStore();
  await store.write({ scope: "run", scopeRef: "g-run", key: "k", record: makeRecord("k", "g-run", { state: "done" }) });
  assert.deepEqual(await store.complete({ scope: "run", scopeRef: "g-run" }), { status: "found", completed: 0 });
  await store.write({ scope: "run", scopeRef: "g-run", key: "a", record: makeRecord("a", "g-run") });
  assert.deepEqual(
    await store.revoke({ scope: "run", scopeRef: "g-run", key: "a", expectedState: "done" }),
    { status: "unchanged", revoked: 0 },
  );
  assert.deepEqual(await store.complete({ scope: "run", scopeRef: "g-run" }), { status: "found", completed: 1 });
  assert.deepEqual(await store.complete({ scope: "run", scopeRef: "no-such-run" }), { status: "found", completed: 0 });
});
