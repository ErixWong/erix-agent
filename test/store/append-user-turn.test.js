import test from "node:test";
import assert from "node:assert/strict";
import { appendUserTurn } from "../../src/store/append-user-turn.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

test("appendUserTurn: round 复用现有最大 round（与既有 CLI 行为对齐，非 max+1）", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("run-1", { round: 0, messages: [] });
  await store.appendRound("run-1", { round: 3, messages: [], dedupKey: "run-1:engine:round:3" });
  const result = await appendUserTurn(store, { key: "run-1", text: "next" });
  assert.equal(result.round, 3);
  assert.equal(result.written, true);
  const records = await store.load("run-1");
  assert.equal(records.at(-1).round, 3);
});

test("appendUserTurn: 非法 round 字段按 0 处理", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("run-1", { round: "nope", messages: [], dedupKey: "k-a" });
  const result = await appendUserTurn(store, { key: "run-1", text: "x" });
  assert.equal(result.round, 0);
});

test("appendUserTurn: 空 store 种子路径 round=0 且正常写入", async () => {
  const store = createMemoryTranscriptStore();
  const result = await appendUserTurn(store, { key: "seed-1", text: "start here" });
  assert.deepEqual(result, {
    key: "seed-1",
    dedupKey: result.dedupKey,
    round: 0,
    written: true,
  });
  assert.match(result.dedupKey, /^seed-1:input:\d+:/u);
  const records = await store.load("seed-1");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].messages, [
    { role: "user", content: [{ type: "text", text: "start here" }] },
  ]);
});

test("appendUserTurn: 有 messageId 时 dedupKey 稳定为 <key>:input:<messageId>", async () => {
  const store = createMemoryTranscriptStore();
  const first = await appendUserTurn(store, { key: "run-2", text: "hello", messageId: "msg-42" });
  assert.equal(first.dedupKey, "run-2:input:msg-42");
  assert.equal(first.written, true);
  const second = await appendUserTurn(store, { key: "run-2", text: "hello", messageId: "msg-42" });
  assert.equal(second.dedupKey, "run-2:input:msg-42");
  assert.equal(second.written, false);
  assert.equal(second.record.dedupKey, "run-2:input:msg-42");
  assert.equal(second.round, 0);
  const records = await store.load("run-2");
  assert.equal(records.length, 1);
});

test("appendUserTurn: 无 messageId 时 dedupKey 为时间戳+UUID 段且每次唯一", async () => {
  const store = createMemoryTranscriptStore();
  const a = await appendUserTurn(store, { key: "run-3", text: "one" });
  const b = await appendUserTurn(store, { key: "run-3", text: "two" });
  assert.notEqual(a.dedupKey, b.dedupKey);
  for (const { dedupKey } of [a, b]) {
    const match = /^run-3:input:(\d+):(.+)$/u.exec(dedupKey);
    assert.ok(match, `unexpected dedupKey shape: ${dedupKey}`);
    assert.ok(Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0);
    assert.match(match[2], UUID_RE);
  }
  assert.equal((await store.load("run-3")).length, 2);
});

test("appendUserTurn: 幂等重跑——同 dedupKey 已存在时跳过写入并回传既有记录", async () => {
  const store = createMemoryTranscriptStore();
  const existing = {
    round: 7,
    messages: [{ role: "user", content: [{ type: "text", text: "already" }] }],
    dedupKey: "run-4:input:msg-1",
    roundKey: "run-4:input:msg-1",
    ts: "2026-01-01T00:00:00.000Z",
  };
  await store.appendRound("run-4", existing);
  const result = await appendUserTurn(store, { key: "run-4", text: "duplicate", messageId: "msg-1" });
  assert.equal(result.written, false);
  assert.equal(result.dedupKey, "run-4:input:msg-1");
  assert.equal(result.round, 7);
  assert.deepEqual(result.record, existing);
  const records = await store.load("run-4");
  assert.equal(records.length, 1);
  assert.equal(records[0].messages[0].content[0].text, "already");
});

test("appendUserTurn: 记录形态与既有 CLI 写入字段一致", async () => {
  const store = createMemoryTranscriptStore();
  const result = await appendUserTurn(store, { key: "run-5", text: "shape check", messageId: 9 });
  const [record] = await store.load("run-5");
  assert.equal(record.dedupKey, "run-5:input:9");
  assert.equal(record.roundKey, record.dedupKey);
  assert.deepEqual(record.messages, [
    { role: "user", content: [{ type: "text", text: "shape check" }] },
  ]);
  assert.equal(Number.isSafeInteger(record.round), true);
  // ts 默认 ISO-8601 字符串（与 engine/CLI 现有形态一致）
  assert.equal(typeof record.ts, "string");
  assert.equal(new Date(record.ts).toISOString(), record.ts);
  // 除约定字段外不造多余字段
  assert.deepEqual(Object.keys(record).sort(), ["dedupKey", "messages", "round", "roundKey", "ts"]);
  assert.equal(result.written, true);
});

test("appendUserTurn: ts 由调用方传入时原样落盘", async () => {
  const store = createMemoryTranscriptStore();
  await appendUserTurn(store, {
    key: "run-6",
    text: "with ts",
    messageId: "m",
    ts: "2020-02-02T02:02:02.002Z",
  });
  const [record] = await store.load("run-6");
  assert.equal(record.ts, "2020-02-02T02:02:02.002Z");
});

test("appendUserTurn: 参数校验失败抛 TypeError", async () => {
  const store = createMemoryTranscriptStore();
  await assert.rejects(() => appendUserTurn(store, { key: "", text: "x" }), TypeError);
  await assert.rejects(() => appendUserTurn(store, { key: "k", text: "" }), TypeError);
  await assert.rejects(() => appendUserTurn(store, { key: "k", text: 1 }), TypeError);
  await assert.rejects(
    () => appendUserTurn(store, { key: "k", text: "x", messageId: {} }),
    TypeError,
  );
  await assert.rejects(() => appendUserTurn({}, { key: "k", text: "x" }), TypeError);
  await assert.rejects(() => appendUserTurn(null, { key: "k", text: "x" }), TypeError);
});

test("appendUserTurn: store.load 返回非数组时抛 TypeError（store 违约不当空库）", async () => {
  for (const loaded of [undefined, null, {}, "nope", 7]) {
    const store = {
      load: async () => loaded,
      appendRound: async () => {
        throw new Error("appendRound must not be reached");
      },
    };
    await assert.rejects(
      () => appendUserTurn(store, { key: "bad-load", text: "x" }),
      (error) => error instanceof TypeError && /store contract violation/u.test(error.message),
      `expected TypeError for load() → ${String(loaded)}`,
    );
  }
});

test("appendUserTurn: text 仅空白时拒绝，非空白原文原样落盘（不存 trim 后的）", async () => {
  const store = createMemoryTranscriptStore();
  for (const blank of [" ", "\n", "\t \n ", "\u3000"]) {
    await assert.rejects(
      () => appendUserTurn(store, { key: "blank-key", text: blank }),
      TypeError,
      `expected TypeError for blank text ${JSON.stringify(blank)}`,
    );
  }
  assert.deepEqual(await store.load("blank-key"), []);
  // 含实义字符的前后空白文本：校验通过且落盘保留原文（不 trim）
  await appendUserTurn(store, { key: "blank-key", text: "  padded  ", messageId: "m-pad" });
  const [record] = await store.load("blank-key");
  assert.equal(record.messages[0].content[0].text, "  padded  ");
});

test("appendUserTurn: messageId 为 0 时生成 <key>:input:0 且幂等", async () => {
  const store = createMemoryTranscriptStore();
  const first = await appendUserTurn(store, { key: "run-zero", text: "zero id", messageId: 0 });
  assert.equal(first.dedupKey, "run-zero:input:0");
  assert.equal(first.written, true);
  const second = await appendUserTurn(store, { key: "run-zero", text: "zero id", messageId: 0 });
  assert.equal(second.dedupKey, "run-zero:input:0");
  assert.equal(second.written, false);
  assert.equal(second.record.dedupKey, "run-zero:input:0");
  assert.equal((await store.load("run-zero")).length, 1);
});

test("appendUserTurn: ts 非 ISO 字符串时原样落盘（合法性由调用方负责，不新增校验）", async () => {
  const store = createMemoryTranscriptStore();
  await appendUserTurn(store, {
    key: "run-bads-ts",
    text: "odd ts",
    messageId: "m-odd",
    ts: "not-a-timestamp",
  });
  const [record] = await store.load("run-bads-ts");
  assert.equal(record.ts, "not-a-timestamp");
});

test("appendUserTurn: 与 file store 协作（JSONL 往返 + 跨实例幂等）", async () => {
  const { createFileTranscriptStore } = await import("../../src/store/file.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "erix-append-user-turn-"));
  try {
    const store = createFileTranscriptStore({ dir });
    const first = await appendUserTurn(store, { key: "run-7", text: "persisted", messageId: "m-1" });
    assert.equal(first.written, true);
    // 新实例（模拟进程重启）读同 key 重跑：dedupKey 命中 → 幂等跳过
    const reopened = createFileTranscriptStore({ dir });
    const rerun = await appendUserTurn(reopened, { key: "run-7", text: "persisted", messageId: "m-1" });
    assert.equal(rerun.written, false);
    assert.equal(rerun.dedupKey, "run-7:input:m-1");
    const records = await reopened.load("run-7");
    assert.equal(records.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
