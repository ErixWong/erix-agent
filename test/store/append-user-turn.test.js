import test from "node:test";
import assert from "node:assert/strict";
import { appendUserTurn } from "../../src/store/append-user-turn.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { makeTmp } from "../helpers/tmp.js";

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
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = await makeTmp("erix-append-user-turn-");
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

// —— issue #157：成对可选 capability 快路径（loadByDedupKey / loadMaxRound）——

/** 构造带调用计数的 stub store；caps 控制实现哪些可选探针（成对检测测试用）。 */
function probeStore({ rounds = [], dedupHits = new Map(), caps = "both", maxRound } = {}) {
  const calls = { load: 0, loadByDedupKey: 0, loadMaxRound: 0, appendRound: 0 };
  const store = {
    load: async () => { calls.load += 1; return rounds; },
    appendRound: async (_key, record) => { calls.appendRound += 1; rounds.push(record); },
  };
  if (caps === "both" || caps === "dedup") {
    store.loadByDedupKey = async (_key, dk) => {
      calls.loadByDedupKey += 1;
      return dedupHits.get(dk) ?? null;
    };
  }
  if (caps === "both" || caps === "max") {
    store.loadMaxRound = async () => {
      calls.loadMaxRound += 1;
      return maxRound === undefined ? Math.max(0, ...rounds.map((r) => (Number.isSafeInteger(r.round) ? r.round : 0))) : maxRound;
    };
  }
  return { store, calls };
}

test("appendUserTurn: 快路径①双能力在→走点查且 store.load 零调用（未命中写路径）", async () => {
  const { store, calls } = probeStore({ maxRound: 4 });
  const result = await appendUserTurn(store, { key: "fp-1", text: "hi", messageId: "m-1" });
  assert.equal(calls.load, 0, "快路径全程禁止调用 store.load");
  assert.equal(calls.loadByDedupKey, 1);
  assert.equal(calls.loadMaxRound, 1);
  assert.equal(calls.appendRound, 1);
  assert.equal(result.written, true);
  assert.equal(result.round, 4);
  assert.equal(result.dedupKey, "fp-1:input:m-1");
});

test("appendUserTurn: 快路径②命中路径仅 1 次点查即返回 record（loadMaxRound/load 均未被调）", async () => {
  const existing = {
    round: 9,
    messages: [{ role: "user", content: [{ type: "text", text: "already" }] }],
    dedupKey: "fp-2:input:m-1",
    roundKey: "fp-2:input:m-1",
    ts: "2026-01-01T00:00:00.000Z",
  };
  const { store, calls } = probeStore({ dedupHits: new Map([[existing.dedupKey, existing]]), maxRound: 100 });
  const result = await appendUserTurn(store, { key: "fp-2", text: "dup", messageId: "m-1" });
  assert.equal(calls.loadByDedupKey, 1);
  assert.equal(calls.loadMaxRound, 0, "命中即返回，不调 loadMaxRound");
  assert.equal(calls.load, 0);
  assert.equal(calls.appendRound, 0);
  assert.deepEqual(result, { key: "fp-2", dedupKey: existing.dedupKey, round: 9, written: false, record: existing });
});

test("appendUserTurn: 快路径③未命中经 loadMaxRound 派生 round 后 appendRound（记录形态与全量路径一致）", async () => {
  const rounds = [];
  const { store, calls } = probeStore({ rounds, maxRound: 7 });
  const result = await appendUserTurn(store, { key: "fp-3", text: "new", messageId: "m-9" });
  assert.equal(calls.loadMaxRound, 1);
  assert.equal(calls.load, 0);
  assert.equal(result.round, 7);
  assert.equal(result.written, true);
  // 落盘记录形态与全量路径一致（round/messages/dedupKey/roundKey）
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].round, 7);
  assert.equal(rounds[0].dedupKey, "fp-3:input:m-9");
  assert.equal(rounds[0].roundKey, rounds[0].dedupKey);
  assert.deepEqual(rounds[0].messages, [{ role: "user", content: [{ type: "text", text: "new" }] }]);
  assert.equal(new Date(rounds[0].ts).toISOString(), rounds[0].ts);
});

test("appendUserTurn: 快路径④半能力（只实现其一）→ 回退全量 load 现行为", async () => {
  for (const caps of ["dedup", "max"]) {
    const { store, calls } = probeStore({
      rounds: [{ round: 2, dedupKey: "fp-4:engine:round:2" }],
      caps,
    });
    const result = await appendUserTurn(store, { key: "fp-4", text: "x", messageId: "m" });
    assert.equal(calls.load, 1, `caps=${caps}: 半能力必须回退全量 load`);
    assert.equal(result.round, 2);
    assert.equal(result.written, true);
  }
});

test("appendUserTurn: 快路径⑤探针坏返回值各抛 store 违约 TypeError", async () => {
  // loadByDedupKey 返回字符串
  await assert.rejects(
    () => appendUserTurn({
      load: async () => [], appendRound: async () => {},
      loadByDedupKey: async () => "nope", loadMaxRound: async () => 0,
    }, { key: "fp-5", text: "x", messageId: "m" }),
    (e) => e instanceof TypeError && /store contract violation.*loadByDedupKey/u.test(e.message),
  );
  // loadMaxRound 返回字符串 / 非安全整数
  for (const bad of ["7", 1.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(
      () => appendUserTurn({
        load: async () => [], appendRound: async () => {},
        loadByDedupKey: async () => null, loadMaxRound: async () => bad,
      }, { key: "fp-5", text: "x", messageId: "m" }),
      (e) => e instanceof TypeError && /store contract violation.*loadMaxRound/u.test(e.message),
      `expected TypeError for loadMaxRound() → ${String(bad)}`,
    );
  }
});

test("appendUserTurn: 快路径⑥loadMaxRound null/undefined/负数→round 0；返回 7→round 7", async () => {
  for (const [probed, expected] of [[null, 0], [undefined, 0], [-3, 0], [7, 7], [0, 0]]) {
    const { store } = probeStore({ maxRound: probed });
    const result = await appendUserTurn(store, { key: "fp-6", text: `x-${String(probed)}`, messageId: `m-${String(probed)}` });
    assert.equal(result.round, expected, `loadMaxRound() → ${String(probed)} 应派生 round ${expected}`);
  }
});

test("appendUserTurn: 快路径⑦命中记录 existing.round 非法→回落 loadMaxRound 派生", async () => {
  const existing = { round: "nope", messages: [], dedupKey: "fp-7:input:m", roundKey: "fp-7:input:m" };
  const { store, calls } = probeStore({ dedupHits: new Map([[existing.dedupKey, existing]]), maxRound: 5 });
  const result = await appendUserTurn(store, { key: "fp-7", text: "x", messageId: "m" });
  assert.equal(result.written, false);
  assert.equal(result.round, 5, "existing.round 非法时回落 loadMaxRound 的 Math.max(0,…)");
  assert.equal(calls.loadByDedupKey, 1);
  assert.equal(calls.loadMaxRound, 1);
  assert.equal(calls.load, 0);
  assert.deepEqual(result.record, existing);
});

test("appendUserTurn: 快路径⑧探针返回 null 与 undefined 都算未命中（不报 TypeError）", async () => {
  for (const miss of [null, undefined]) {
    const { store, calls } = probeStore({ maxRound: 1 });
    store.loadByDedupKey = async () => miss;
    const result = await appendUserTurn(store, { key: "fp-8", text: "x", messageId: `m-${String(miss)}` });
    assert.equal(result.written, true);
    assert.equal(calls.load, 0);
  }
});

test("appendUserTurn: 快路径写入的 dedupKey 无 messageId 时同样唯一且零 load", async () => {
  const { store, calls } = probeStore({ maxRound: 0 });
  const a = await appendUserTurn(store, { key: "fp-9", text: "one" });
  const b = await appendUserTurn(store, { key: "fp-9", text: "two" });
  assert.notEqual(a.dedupKey, b.dedupKey);
  assert.match(a.dedupKey, /^fp-9:input:\d+:[0-9a-f-]+$/u);
  assert.equal(calls.load, 0);
  assert.equal(calls.appendRound, 2);
});

// issue #171：锁住快路径与全量路径的同一判据（nullish 而非 OR）。
// 分叉数据：既存 record 同时带有不等值的 dedupKey 与 roundKey，查询值等于它的
// roundKey。?? 判 miss（必须追加），OR 判 hit（快路径直接 written:false，这一轮
// 静默不追加）。0.17.0 升级指南旧 sketch 的 OR 写法会在本用例红。
test("appendUserTurn: 快路径⑩探针按 nullish 判据匹配，dedupKey 存在时绝不按 roundKey 命中（#171）", async () => {
  const stored = {
    round: 3,
    messages: [{ role: "assistant", content: [{ type: "text", text: "engine round" }] }],
    dedupKey: "fp-10:engine:round:3",
    roundKey: "fp-10:input:m-1",
    ts: "2026-01-01T00:00:00.000Z",
  };
  for (const withProbes of [false, true]) {
    const rounds = [stored];
    const store = {
      load: async () => rounds,
      appendRound: async (_key, record) => { rounds.push(record); },
    };
    if (withProbes) {
      store.loadByDedupKey = async (_key, dk) =>
        rounds.find((record) => (record.dedupKey ?? record.roundKey) === dk) ?? null;
      store.loadMaxRound = async () =>
        Math.max(0, ...rounds.map((r) => (Number.isSafeInteger(r.round) ? r.round : 0)));
    }
    const result = await appendUserTurn(store, { key: "fp-10", text: "new turn", messageId: "m-1" });
    assert.equal(result.written, true,
      `withProbes=${String(withProbes)}: ?? 判据下这条 record 不算既存，该轮必须追加`);
    assert.equal(rounds.length, 2, `withProbes=${String(withProbes)}: 两条路径都必须落盘新轮`);
    assert.equal(result.dedupKey, "fp-10:input:m-1");
    assert.equal(result.round, 3, "两条路径均复用既有最大 round");
  }
});
