// @ts-check
// issue #261127-17：续跑只认账本 ⇒ 调用方这次递进来的 `initialUserMessage` / `initialMessages`
// **不会**进上下文。这是设计（`test/run-state.test.js` 那格的用例名就叫 "ignored on resume"），
// 但修前它**一声不响**：真机评测（`scripts/recall-eval.mjs`）把新问题塞进 `initialUserMessage`
// 再续跑，模型只回应「【恢复运行】」告示、完全看不到那个问题。
// 本组钉住：① 行为不变（问题确实不进请求）；② 但它必须**说出来**（一条 `resume_input_dropped`）。
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

const DONE = [{ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }];

/** 先跑一跑把账本种上（原始问题入账），返回 store 与 runId。 */
async function seed(/** @type {string} */ runId) {
  const store = createMemoryTranscriptStore();
  await runDirect({
    provider: createFakeProvider(DONE),
    initialUserMessage: "原始问题：A 是什么？",
    executeTool: async () => "unused",
    maxRounds: 1,
    config: { input: { wrapup: false } },
    store,
    runId,
  });
  return store;
}

/** 续跑一次，收回事件与最后一发请求。 */
async function resumeOnce(/** @type {any} */ store, /** @type {string} */ runId, /** @type {any} */ extra) {
  const provider = createFakeProvider(DONE);
  /** @type {any[]} */
  const events = [];
  await runDirect({
    provider,
    executeTool: async () => "unused",
    maxRounds: 1,
    config: { input: { wrapup: false }, run: { resume: true, runId } },
    onEvent: (/** @type {any} */ event) => { events.push(event); },
    store,
    ...extra,
  });
  return {
    dropped: events.filter((event) => event.type === "resume_input_dropped"),
    request: JSON.stringify(provider.requests.at(-1)?.messages ?? []),
  };
}

test("#261127-17-1 续跑 + initialUserMessage：问题不进请求（设计），但发一条 resume_input_dropped", async () => {
  const runId = "resume-input-dropped-a";
  const store = await seed(runId);
  const { dropped, request } = await resumeOnce(store, runId, { initialUserMessage: "新问题：B 是什么？" });

  assert.equal(request.includes("新问题"), false, "续跑只认账本：这次递进来的问题不进上下文（行为不变）");
  assert.equal(request.includes("原始问题"), true, "账本里那条原始问题照旧在");
  assert.equal(dropped.length, 1, "被丢掉必须说出来，且只说一次");
  assert.deepEqual(dropped[0].fields, ["initialUserMessage"], "字段名要点名，宿主才知道该改哪一处");
  assert.equal(dropped[0].runId, runId);
});

test("#261127-17-2 续跑不递输入 ⇒ 不发这条事件（不许每跑一次都报一次）", async () => {
  const runId = "resume-input-dropped-b";
  const store = await seed(runId);
  const { dropped } = await resumeOnce(store, runId, {});
  assert.equal(dropped.length, 0);
});

test("#261127-17-3 非续跑 + initialUserMessage ⇒ 不发这条事件（正常路径它就是要用的）", async () => {
  const store = createMemoryTranscriptStore();
  /** @type {any[]} */
  const events = [];
  const provider = createFakeProvider(DONE);
  await runDirect({
    provider,
    initialUserMessage: "首跑的问题",
    executeTool: async () => "unused",
    maxRounds: 1,
    config: { input: { wrapup: false } },
    onEvent: (/** @type {any} */ event) => { events.push(event); },
    store,
    runId: "resume-input-dropped-c",
  });
  assert.equal(events.filter((event) => event.type === "resume_input_dropped").length, 0);
  assert.equal(JSON.stringify(provider.requests.at(-1)?.messages ?? []).includes("首跑的问题"), true);
});

test("#261127-17-4 续跑同时递两种输入 ⇒ 两个字段都点名", async () => {
  const runId = "resume-input-dropped-d";
  const store = await seed(runId);
  // `messages` 的规范家是 `config.input.messages`（扁平 `initialMessages` 已退役，见 #498 S3）
  const { dropped } = await resumeOnce(store, runId, {
    initialUserMessage: "新问题",
    config: {
      input: { wrapup: false, messages: [{ role: "user", content: [{ type: "text", text: "整段历史" }] }] },
      run: { resume: true, runId },
    },
  });
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0].fields, ["initialUserMessage", "initialMessages"]);
});
