// issue #742 切片 A 的端到端面：`runStateMeta` 必须出现在**真轮记录**上，且三格的值与盘上事实一致。
//
// 为什么端到端还要单独一格：`measureRunStateMeta` 的单测只证明纯函数算得对；写点接错（量错对象、
// 无值时写了零值、把键写进 `runState` 里面）都只有从 store 读回真轮记录才看得见。
//
// 实测口径（写进报告，也写在这里，因为它是判据里最容易误解的一条）：
//   * `bytes` 逐字节等于 `Buffer.byteLength(JSON.stringify(record.runState), "utf8")` —— 量的是
//     **真正落盘的那一份副本**，不是夹断前的候选。
//   * 夹断发生在写点**上游**的 `boundRunState`，所以「被夹断那一轮」落盘的副本反而**在上限之内**
//     （现测极端轮：128 工具 / 128 文件 / 64 条 todo / 1200 字 semantic ⇒ 副本 64 893 B，只比上限低 643 B）。
//     判据里 `bytes > capBytes` 那一半是**夹断前的候选**才成立的事实，它由
//     `test/run-state-meta-742.test.js` 的超上限形状钉住；轮记录这一格必须靠引擎自己盖的夹断章
//     （`runState.bounds.truncated`）才报得真，否则真实 run 里 `truncated` 永远是 false。
import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { RUN_STATE_MAX_SERIALIZED_BYTES } from "../src/run-state.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

// 与实现同一把尺，由测试独立再算一遍（口径不一致就红）。
const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

async function runRoundRecords(options) {
  const store = createMemoryTranscriptStore();
  await runDirect({
    initialUserMessage: "work",
    executeTool: async () => ({ success: true, data: "ok" }),
    maxRounds: 2,
    config: { run: { completion: false } },
    store,
    runId: "runstate-meta-742",
    ...options,
  });
  const rows = await store.load("runstate-meta-742");
  // 引擎轮记录（`onRound` 收到的那一格与 store 里的这一行同源）：按引擎命名空间的 dedupKey 挑出来。
  return rows.filter((row) => /:engine:round:\d+$/u.test(String(row.dedupKey ?? "")));
}

test("#742 未截断的真实轮：三格都在、bytes 与盘上副本逐字节一致、truncated 为假", async () => {
  const records = await runRoundRecords({
    provider: createFakeProvider([
      { content: [{ type: "tool_use", id: "t1", name: "readFile", input: { path: "src/a.js" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
  });
  assert.ok(records.length >= 1, "至少要有一轮");
  for (const record of records) {
    const meta = record.runStateMeta;
    assert.notEqual(meta, undefined, `round ${String(record.round)} 的轮记录没有 runStateMeta`);
    assert.deepEqual(Object.keys(meta).sort(), ["bytes", "capBytes", "truncated"]);
    assert.equal(meta.bytes, serializedBytes(record.runState));
    assert.equal(meta.capBytes, RUN_STATE_MAX_SERIALIZED_BYTES);
    assert.equal(meta.truncated, false);
    // `false` 必须是「确实没被夹断」而不是猜的：这一轮自己也没有夹断章。
    assert.notEqual(record.runState?.bounds?.truncated, true);
  }
});

test("#742 真被夹断的那一轮：truncated 为真，且假只来自引擎盖的夹断章", async () => {
  const CJK = "\u4e2d";
  const toolBlocks = Array.from({ length: 128 }, (_unused, i) => ({
    type: "tool_use", id: `w${String(i)}`, name: `w${String(i)}_${CJK.repeat(100)}`, input: {},
  }));
  const fileBlocks = Array.from({ length: 128 }, (_unused, i) => ({
    type: "tool_use", id: `f${String(i)}`, name: "writeFile",
    input: { path: `src/f${String(i)}_${CJK.repeat(110)}` },
  }));
  const records = await runRoundRecords({
    provider: createFakeProvider([
      { content: [...toolBlocks, ...fileBlocks], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    todoStateProvider: () => ({
      status: "ok",
      items: Array.from({ length: 64 }, (_unused, i) => ({
        id: `todo-${String(i)}-${CJK.repeat(38)}`, subject: CJK.repeat(48), activeForm: CJK.repeat(48),
        status: "pending", priority: "high",
      })),
    }),
    semanticStateProvider: () => ({ text: CJK.repeat(1200), version: 99 }),
  });

  const clamped = records.filter((row) => row.runState?.bounds?.truncated === true);
  assert.ok(clamped.length >= 1, "这个夹具必须真的把 run-state 夹断（否则这一格什么都没测）");
  for (const record of clamped) {
    const meta = record.runStateMeta;
    assert.notEqual(meta, undefined);
    assert.equal(meta.truncated, true, "引擎盖了夹断章，元数据就不许报「没截断」");
    assert.equal(meta.bytes, serializedBytes(record.runState));
    assert.equal(meta.capBytes, RUN_STATE_MAX_SERIALIZED_BYTES);
    // 两个事实没被揉成一个数：字节数仍然如实报（夹断后的副本在上限内），「为什么夹断」仍由
    // `bounds` 自己说（条目窗口削的带 `omittedTools`，序列化超限的带 `reason: "serialized_size"`，
    // 两条路只共享 `truncated: true` 这一个章）。
    assert.ok(meta.bytes <= meta.capBytes);
    assert.ok(record.runState.bounds.omittedTools > 0 || record.runState.bounds.reason === "serialized_size",
      "夹断章必须带得上「为什么被夹断」的那一笔");
  }
});

test("#742 无值不写键：宿主自己构造的轮记录形状不会凭空多出 truncated:false", async () => {
  const store = createMemoryTranscriptStore();
  // 宿主侧的轮记录形状：没有 run-state 副本（`undefined`），也没写元数据。
  await store.appendRound("host-shaped", { round: 1, roundKey: "host-shaped:round:1", dedupKey: "host-shaped:round:1" });
  await store.appendRound("host-shaped", {
    round: 2, roundKey: "host-shaped:round:2", dedupKey: "host-shaped:round:2", runState: null,
  });
  await store.appendRound("host-shaped", {
    round: 3, roundKey: "host-shaped:round:3", dedupKey: "host-shaped:round:3", runState: [],
  });
  const rows = await store.load("host-shaped");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    // 「伪报」的形状是 `{ bytes: 0, capBytes: 65536, truncated: false }` 或至少一个 `truncated: false`；
    // 判据只认**键不存在**，这样读侧拿到的是「不知道」而不是「没截断」。
    assert.equal(Object.hasOwn(row, "runStateMeta"), false, `round ${String(row.round)} 凭空多出了 runStateMeta`);
  }
});

test("#742 写点源码格：量的是落盘那一份，且无值走的是「不写键」而不是零值", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(here, "..", "src", "loop", "orchestrator.js"), "utf8");

  // ① 必须量 `cloneState` 之后那一份（量原件会报出盘上不存在的字节数）。
  assert.match(source, /const roundRunStateCopy = cloneState\(roundRunState\);/u);
  assert.match(source, /const runStateMeta = measureRunStateMeta\(roundRunStateCopy\);/u);
  assert.match(source, /runState: roundRunStateCopy,/u);
  // ② 无值 ⇒ 整个键缺席；不许出现「零值兜底」的写法。
  assert.match(source, /\.\.\.\(runStateMeta === undefined \? \{\} : \{ runStateMeta \}\),/u);
  assert.doesNotMatch(source, /runStateMeta\s*\?\?/u, "零值兜底会把「不知道」写成「没截断」");
  assert.doesNotMatch(source, /runStateMeta:\s*\{[^}]*truncated:\s*false/u);
});
