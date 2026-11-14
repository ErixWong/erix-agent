// @ts-check
// 载体已退役（#838 S2），原 #178 快照写侧分类格与 #735 写侧字段面格随之退役。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

test("用例卫生：run 使用注入的临时 cwd 与内存 store，未改动真实 ~/.erix", async () => {
  const cwd = await makeTmp("erix-cwd-hygiene-");
  const home = homedir();
  const erixHome = home === undefined ? undefined : join(home, ".erix");
  const existedBefore = erixHome === undefined ? undefined : existsSync(erixHome);
  const seen = [];
  const store = createMemoryTranscriptStore();

  const result = await runDirect({
    provider: createFakeProvider([
      { content: [{ type: "tool_use", id: "hygiene-tool", name: "work", input: {} }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    store,
    runId: "cwd-hygiene",
    initialUserMessage: "work",
    tools: [{ name: "work", description: "probe tool", inputSchema: { type: "object", properties: {} } }],
    executeTool: async ({ context }) => {
      seen.push(context?.cwd);
      return "ok";
    },
    config: {
      metadata: { toolContext: { cwd } },
      timing: { retry: { attempts: 0, backoffBaseMs: 0 } },
    },
    completion: false,
    wrapup: false,
    maxRounds: 3,
  });

  assert.equal(result.finalText, "done");
  assert.ok(seen.length > 0, "executeTool must observe the injected cwd via tool context");
  assert.deepEqual([...new Set(seen)], [cwd], "every tool call sees the injected tmp cwd, not the process cwd");
  assert.ok((await store.load("cwd-hygiene")).length > 0,
    "the injected in-memory store is the only persistence target");
  if (erixHome !== undefined) {
    assert.equal(existsSync(erixHome), existedBefore, `real ~/.erix existence changed (${String(erixHome)})`);
  }
});

test("#769 R5（M2）phase 面补格：清盘写失败 ⇒ 事件 / 抛出 / termination 三处同为 clearRecoveryRows + recovery_rows_clear + not_started", async () => {
  const cwd = await makeTmp("erix-769r5-clear-");
  const injected = new Error("injected clearRecoveryRows failure");
  injected.name = "InjectedClearFailure";
  let clearCalls = 0;
  let modelCalls = 0;
  const store = {
    async appendRound() {},
    async load() { return []; },
    async clearRecoveryRows() {
      clearCalls += 1;
      throw injected;
    },
  };
  const provider = {
    async chat() {
      modelCalls += 1;
      return { content: [{ type: "text", text: "clear phase" }], stopReason: "end_turn" };
    },
  };
  const events = [];
  let thrown;
  try {
    await runDirect({
      provider,
      store,
      runId: "clear-phase",
      initialUserMessage: "work",
      executeTool: async () => "ok",
      config: {
        metadata: { toolContext: { cwd } },
        timing: { retry: { attempts: 0, backoffBaseMs: 0 } },
      },
      completion: false,
      wrapup: false,
      maxRounds: 3,
      diagnostics: { error: (event) => events.push(event) },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, "清盘写失败必须让 run 抛出（不是记一条诊断就继续跑）");
  assert.equal(clearCalls, 1, "retry.attempts=0 ⇒ 恰好一次尝试（不掺重试噪声）");
  assert.equal(modelCalls, 0, "终止在第一次模型请求之前 ⇒ run 没有继续跑");
  assert.equal(thrown.code, "persistence_failed", "清盘失败走 persistence_failed 出口");
  assert.equal(thrown.cause, injected, "cause 就是注入的那个 store 错对象");
  assert.equal(thrown.errorCode, "unknown", "根因无 code ⇒ errorCode=unknown");

  const event = events.find((entry) => entry?.operation === "clearRecoveryRows");
  assert.ok(event !== undefined,
    `必须有一条点名 clearRecoveryRows 的 persistence_error 事件，实际 ${JSON.stringify(events.map((entry) => entry?.operation))}`);
  assert.equal(event.type, "persistence_error");
  assert.equal(event.phase, "recovery_rows_clear");
  assert.equal(event.sideEffect, "not_started");
  assert.deepEqual(
    { operation: thrown.operation, phase: thrown.phase, sideEffect: thrown.sideEffect },
    { operation: event.operation, phase: event.phase, sideEffect: event.sideEffect },
    "抛出错误与事件必须报告同一分类",
  );
  assert.equal(thrown.termination?.reason, "persistence_failed");
  assert.deepEqual(
    {
      operation: thrown.termination?.operation,
      phase: thrown.termination?.phase,
      sideEffect: thrown.termination?.sideEffect, // status 快照格已随载体退役（#838 S2）。
    },
    { operation: event.operation, phase: event.phase, sideEffect: event.sideEffect },
    "termination 三值与事件三值同源",
  );
});
