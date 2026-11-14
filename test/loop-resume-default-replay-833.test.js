import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { NO_EVIDENCE_TOOL_RESULT_TEXT } from "../src/loop/pending-tool-result.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { buildToolExecutedRecoveryRow } from "../src/store/recovery-rows.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #833：**崩溃续跑的默认语义**——不再由引擎替宿主补跑工具。
//
// 这条判据存在的理由（三条，写在 issue 上）：引擎无法判断重跑安不安全（工具定义里没有
// `readOnly` 元数据）；它的判据是「没有 `tool-executed` 行」，而崩溃破坏的正是记录 ⇒
// 缺席不等于未发生；决定权该在模型手里，而账本缺证时只能给「未知」桩。
//
// 这一格专测**默认**：不传 `config.run.replayPolicy` 时的行为。其余续跑测试都显式钉
// `always-replay`（它们测的是补跑机制本身），所以「默认档」只有这里覆盖。

const textMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });

/** 崩溃现场：账本里有 seed 和一条没结清的 `tool_use`（不声明 `replay`）。 */
async function seedCrashSite(runId, { completedPrefix = false } = {}) {
  const store = createMemoryTranscriptStore();
  const toolUses = [
    ...(completedPrefix ? [{
      type: "tool_use",
      id: "call-0",
      name: "work",
      input: { action: "inspect" },
    }] : []),
    {
      type: "tool_use",
      id: "call-1",
      name: "work",
      input: { action: "publish" },
    },
  ];
  await store.appendRound(runId, { round: 0, messages: [textMessage("跑一下工具")] });
  await store.appendRound(runId, {
    round: 1,
    roundKey: `${runId}:round:1`,
    dedupKey: `${runId}:msg:1:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "assistant", content: toolUses }],
    ts: new Date().toISOString(),
  });
  if (completedPrefix) {
    await store.appendRecoveryRow(runId, buildToolExecutedRecoveryRow({
      runId,
      round: 1,
      toolUseId: "call-0",
    }));
  }
  return store;
}

function crashRunOptions(store, runId, extraConfig, onExecute) {
  return {
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    config: { run: { resume: true, runId, completion: false, ...extraConfig } },
    tools: [{ name: "work", inputSchema: { type: "object" } }],
    store,
    executeTool: async () => {
      onExecute();
      return "explicitly replayed";
    },
  };
}

test("#833 默认档：崩溃时没结清的工具**不由引擎补跑**，只补一条桩让模型自己决定", async () => {
  const runId = "resume-default-replay";
  const store = await seedCrashSite(runId);
  let executions = 0;
  const result = await runToolLoop(crashRunOptions(store, runId, {}, () => {
    executions += 1;
  }));

  assert.equal(executions, 0, "默认档下引擎一次都不许执行（这正是这一刀的全部意义）");
  const stub = result.messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1");
  assert.ok(stub, "缺结果的 tool_use 必须补上一条 tool_result（否则配对断了，请求会被拒）");
  assert.equal(stub.is_error, true, "桩必须是错误结果：它的内容是「没跑/结果未知」");
  assert.equal(Object.hasOwn(stub.erix ?? {}, "executionStatus"), false,
    "无执行证据不能编造 interrupted 执行状态");
  assert.equal(stub.content, NO_EVIDENCE_TOOL_RESULT_TEXT,
    "无任何执行或结果证据必须如实标成未知，不能断言 never executed");
});

test("#833 显式 opt-in：`always-replay` 仍然补跑（默认改了不等于把这条路拆掉）", async () => {
  const runId = "resume-always-replay-optin";
  const store = await seedCrashSite(runId, { completedPrefix: true });
  let executions = 0;
  const result = await runToolLoop(crashRunOptions(store, runId,
    { replayPolicy: "always-replay" }, () => { executions += 1; }));

  assert.equal(executions, 1, "显式要旧档的宿主照旧拿到补跑");
  const toolResult = result.messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1");
  assert.equal(toolResult.content, "explicitly replayed", "拿到的是真结果，不是桩");
});
