// issue #326 事实①：`appendRound` 的 payload 判据（src/store/transcript-dedup.js）单元测试。
// 契约套件（test/contract/transcript-store.js）钉的是「两个内置 store 给出同一个答案」；
// 这里钉的是**判据本身**——摘要口径为什么不会把本来幂等的重放误判成冲突，以及它没有松到
// 把真冲突也归一掉。误判方向不对称：假冲突会把契约承诺的「可安全重复的预写」变成抛错。
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEDUP_CONFLICT_CODE,
  PAYLOAD_VOLATILE_FIELDS,
  TranscriptDedupConflictError,
  dedupConflictError,
  differingTopLevelFields,
  payloadFingerprint,
  recordKey,
} from "../../src/store/transcript-dedup.js";

const fp = (record) => payloadFingerprint(record);

test("#326 dedup: 摘要形状是带算法前缀的定长指纹", () => {
  assert.match(fp({ round: 1, messages: [] }), /^sha256:[0-9a-f]{24}$/u);
});

test("#326 dedup: 字段顺序不是语义（顶层与嵌套都排序）", () => {
  const a = { round: 1, messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], ts: "t" };
  const b = { messages: [{ content: [{ text: "x", type: "text" }], role: "user" }], ts: "t", round: 1 };

  assert.equal(fp(a), fp(b), "同一份内容换字段顺序必须同摘要（含块内字段）");
});

test("#326 dedup: 数组顺序是语义，不得归一掉", () => {
  const one = { messages: [{ role: "user", content: ["a", "b"] }] };
  const swapped = { messages: [{ role: "user", content: ["b", "a"] }] };

  assert.notEqual(fp(one), fp(swapped));
});

test("#326 dedup: 只有顶层的身份/派生字段是噪声，嵌套层的一律算内容", () => {
  assert.deepEqual([...PAYLOAD_VOLATILE_FIELDS], ["dedupKey", "roundKey", "round", "ts"]);
  const base = { round: 1, ts: "t1", dedupKey: "k", roundKey: "k", messages: [] };

  // 顶层四个字段怎么漂都不改摘要：它们是「这条记录是谁 / 何时写的」，不是 payload。
  for (const field of PAYLOAD_VOLATILE_FIELDS) {
    assert.equal(fp(base), fp({ ...base, [field]: `${field}-drifted` }), `${field} 应当被排除`);
  }

  // 同一个键名嵌在正文里就不再是信封：消息 meta.ts 漂了必须算冲突。
  assert.notEqual(
    fp({ messages: [{ role: "user", meta: { ts: "t1" }, content: [] }] }),
    fp({ messages: [{ role: "user", meta: { ts: "t2" }, content: [] }] }),
    "嵌套 ts 属于内容，不得被顶层排除表吞掉",
  );
  // 引擎 round 记录里的用量/压缩统计同样算内容（只有刻意登记的四个字段是噪声）。
  assert.notEqual(fp({ usage: { input: 1 } }), fp({ usage: { input: 2 } }));
  assert.notEqual(fp({ runState: { rounds: 1 } }), fp({ runState: { rounds: 2 } }));
});

test("#326 dedup: 与 JSON 往返等价（memory 的活对象与 file 读回的同一行同摘要）", () => {
  const live = {
    round: 2,
    dedupKey: "k",
    messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
    emptyField: undefined,
    fn: () => 0,
    when: new Date("2026-08-29T00:00:00.000Z"),
    weird: { nested: undefined, keep: 1 },
    notFinite: Number.NaN,
  };
  const roundTripped = JSON.parse(JSON.stringify({
    round: 2,
    dedupKey: "k",
    messages: live.messages,
    when: "2026-08-29T00:00:00.000Z",
    weird: { keep: 1 },
    notFinite: null,
  }));

  assert.equal(fp(live), fp(roundTripped));
});

test("#326 dedup: 非 JSON 叶子走确定性兜底，不抛错（memory store 允许它们活着）", () => {
  assert.equal(typeof fp({ big: 10n }), "string");
  assert.notEqual(fp({ big: 10n }), fp({ big: 11n }));

  const cyclic = { round: 1, messages: [] };
  cyclic.self = cyclic;
  assert.match(fp(cyclic), /^sha256:[0-9a-f]{24}$/u, "循环引用不得让幂等判定栈溢出");

  assert.equal(typeof fp(undefined), "string");
  assert.equal(typeof fp(null), "string");
  assert.equal(typeof fp("a bare line"), "string");
  assert.equal(fp(undefined), fp(null), "两者都按 JSON 的 null 记账");
});

test("#326 dedup: recordKey 判据是 ??（dedupKey 在位就绝不回退 roundKey）", () => {
  assert.equal(recordKey("r", { dedupKey: "a", roundKey: "b" }), "a");
  assert.equal(recordKey("r", { roundKey: "b" }), "b");
  assert.equal(recordKey("r", { round: 3 }), "r:round:3");
  assert.equal(recordKey("r", null), "r:round:undefined");
});

test("#326 dedup: 冲突错误可判定——code / key / 两份指纹 / 差异字段都在消息里", () => {
  const existing = { round: 1, dedupKey: "k", messages: ["old"], hostLedger: { n: 1 } };
  const incoming = { round: 1, dedupKey: "k", messages: ["new"] };
  const error = dedupConflictError({
    runId: "run-9",
    key: "k",
    existing,
    incoming,
    existingFingerprint: payloadFingerprint(existing),
    incomingFingerprint: payloadFingerprint(incoming),
  });

  assert.ok(error instanceof TranscriptDedupConflictError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "TranscriptDedupConflictError");
  assert.equal(error.code, DEDUP_CONFLICT_CODE);
  assert.equal(DEDUP_CONFLICT_CODE, "dedup_payload_conflict");
  assert.equal(error.runId, "run-9");
  assert.equal(error.key, "k");
  for (const needle of [
    "run-9",
    "k",
    error.existingFingerprint,
    error.incomingFingerprint,
    "messages",
    "hostLedger",
  ]) {
    assert.ok(error.message.includes(needle), `消息里必须能指认出 ${needle}`);
  }
  assert.deepEqual(error.differingFields, ["hostLedger", "messages"], "差异字段按名排序，只算真差异");
});

test("#326 dedup: 既有侧取不到正文时降级成只比指纹，不编造差异字段", () => {
  const incoming = { round: 1, dedupKey: "k", messages: ["new"] };
  const error = dedupConflictError({
    runId: "run-9",
    key: "k",
    existing: undefined,
    incoming,
    existingFingerprint: "sha256:000000000000000000000000",
    incomingFingerprint: payloadFingerprint(incoming),
  });

  assert.deepEqual(error.differingFields, []);
  assert.ok(error.message.includes("sha256:000000000000000000000000"));
});

test("#326 dedup: 差异字段清单排序且有上界（错误消息不得抄完整字段表）", () => {
  const existing = {};
  const incoming = {};
  for (const name of ["zeta", "alpha", "mid", "beta", "kappa", "delta", "gamma", "omega", "theta", "iota"]) {
    existing[name] = "old";
    incoming[name] = "new";
  }

  assert.deepEqual(differingTopLevelFields(existing, incoming), [
    "alpha", "beta", "delta", "gamma", "iota", "kappa", "mid", "omega",
  ]);
});
