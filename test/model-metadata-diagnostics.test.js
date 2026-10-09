// issue #182：预算元数据缺失的一次性诊断事件（model_metadata_missing）。
//
// 背景：宿主不传 contextWindowTokens/maxOutputTokens 时，budgetTokens 推不出来 → 压缩总开关
// 不进入、单轮聚合输出预算（#120）整体关闭、输出截断上限退回 4096，而全链路零告警
// （真机 92 轮 run compaction=0）。本文件锁住「看得见」这件事：
//   无 metadata 装配 → 恰好一条；传齐 metadata → 零条；多轮不重复发。
import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createAssemblyPort } from "../src/assembly.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const EVENT_TYPE = "model_metadata_missing";
// issue #182 约定的 detail 原文（无显式 outputHygiene.limit 时的完整形态）。
const DETAIL = "contextWindowTokens/maxOutputTokens unavailable; compaction and aggregate output"
  + " budget are disabled for this run; output limit falls back to 4096";

function textProvider(text = "done") {
  return createFakeProvider([{ content: [{ type: "text", text }], stopReason: "end_turn" }]);
}

/** 生成 rounds 轮工具调用 + 一轮收尾文本的 provider 脚本。 */
function toolProvider(rounds, idPrefix = "call") {
  return createFakeProvider([
    ...Array.from({ length: rounds }, (_, index) => ({
      content: [{
        type: "tool_use",
        id: `${idPrefix}-${index + 1}`,
        name: "work",
        input: {},
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
}

const noticesOf = (events) => events.filter((event) => event.type === EVENT_TYPE);

test("no model metadata assembly emits exactly one model_metadata_missing (issue #182)", async () => {
  const events = [];
  const result = await runToolLoop({
    provider: textProvider(),
    initialUserMessage: "start",
    executeTool: async () => "unused",
    store: createMemoryTranscriptStore(),
    runId: "metadata-missing-none",
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.finalText, "done");
  const notices = noticesOf(events);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0], {
    type: EVENT_TYPE,
    runId: "metadata-missing-none",
    detail: DETAIL,
  });
  // 诊断事件在启动期发出：宿主在任何轮次事件之前就能拿到它。
  assert.equal(events[0].type, EVENT_TYPE);
});

test("the diagnostic also reaches the assemblyPort emit sink and a store-less run", async () => {
  const emitted = [];
  const port = createAssemblyPort({
    modelConfig: { async resolve() { return { model: "slot-model" }; } },
    provider: textProvider(),
    tools: { definitions: [], executeTool: async () => "unused" },
    session: { id: "metadata-missing-port" },
    emit: (type, payload) => emitted.push({ type, payload }),
  });
  await runToolLoop({ assemblyPort: port, initialUserMessage: "start" });
  assert.deepEqual(emitted.filter((entry) => entry.type === EVENT_TYPE), [{
    type: EVENT_TYPE,
    payload: { type: EVENT_TYPE, runId: "metadata-missing-port", detail: DETAIL },
  }]);

  // 无 store（persistence 全旁路）时元数据缺失同样成立：事件必须照发。
  const events = [];
  await runToolLoop({
    provider: textProvider(),
    initialUserMessage: "start",
    executeTool: async () => "unused",
    runId: "metadata-missing-storeless",
    onEvent: (event) => events.push(event),
  });
  assert.equal(noticesOf(events).length, 1);
});

test("complete model metadata emits zero model_metadata_missing and keeps compaction enabled", async () => {
  const events = [];
  const result = await runToolLoop({
    provider: toolProvider(2),
    initialUserMessage: "start",
    // 小窗口 → budgetTokens = 4096 - 512 - max(2000, 410) = 1584，工具输出足以越预算。
    modelMetadata: { contextWindowTokens: 4096, maxOutputTokens: 512 },
    executeTool: async () => "y".repeat(20000),
    maxRounds: 4,
    completion: false,
    store: createMemoryTranscriptStore(),
    runId: "metadata-missing-complete",
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.finalText, "done");
  assert.equal(noticesOf(events).length, 0);
  // 反向防回归：metadata 齐 → 压缩确实启用（否则本 issue 的"关掉压缩"就无从对照）。
  assert.ok(
    events.some((event) => event.type === "compaction"),
    "budgetTokens derived from metadata must keep compaction running",
  );
});

test("the diagnostic does not repeat across rounds or runs (issue #182)", async () => {
  const events = [];
  const result = await runToolLoop({
    provider: toolProvider(5),
    initialUserMessage: "start",
    executeTool: async () => "x".repeat(200),
    maxRounds: 7,
    completion: false,
    store: createMemoryTranscriptStore(),
    runId: "metadata-missing-multiround",
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.rounds, 6);
  assert.equal(noticesOf(events).length, 1, "多轮运行只允许一条诊断事件");
  assert.equal(events.filter((event) => event.type === "round_start").length, 6);

  // 每个 run 各一条（去重是 run 作用域，不是进程作用域）。
  const second = [];
  await runToolLoop({
    provider: textProvider(),
    initialUserMessage: "again",
    executeTool: async () => "unused",
    store: createMemoryTranscriptStore(),
    runId: "metadata-missing-second-run",
    onEvent: (event) => second.push(event),
  });
  assert.equal(noticesOf(second).length, 1);
  assert.equal(second[0].runId, "metadata-missing-second-run");
});

test("partial metadata still disables the budget and reports the resolved output limit", async () => {
  // 只有 contextWindowTokens：computeBudget 需要两个字段，缺 maxOutputTokens 同样推不出预算。
  const events = [];
  await runToolLoop({
    provider: textProvider(),
    initialUserMessage: "start",
    executeTool: async () => "unused",
    modelMetadata: { contextWindowTokens: 131072 },
    store: createMemoryTranscriptStore(),
    runId: "metadata-missing-partial",
    onEvent: (event) => events.push(event),
  });

  const notices = noticesOf(events);
  assert.equal(notices.length, 1);
  assert.equal(
    notices[0].detail,
    "contextWindowTokens/maxOutputTokens unavailable; compaction and aggregate output budget"
      + " are disabled for this run; output limit resolves to 19660",
    "detail 必须报实际解析上限（floor(0.15 × 131072) = 19660），不得谎报 4096",
  );
});

test("an explicit outputHygiene.limit is reported instead of the 4096 fallback", async () => {
  const events = [];
  await runToolLoop({
    provider: textProvider(),
    initialUserMessage: "start",
    executeTool: async () => "unused",
    outputHygiene: { limit: 1234 },
    store: createMemoryTranscriptStore(),
    runId: "metadata-missing-explicit-limit",
    onEvent: (event) => events.push(event),
  });

  const notices = noticesOf(events);
  assert.equal(notices.length, 1);
  assert.match(notices[0].detail, /^contextWindowTokens\/maxOutputTokens unavailable/u);
  assert.match(notices[0].detail, /output limit resolves to 1234$/u);
  assert.doesNotMatch(notices[0].detail, /falls back to 4096/u);
});

test("no diagnostic when the host supplies its own budgetTokens (compaction stays on)", async () => {
  const events = [];
  await runToolLoop({
    provider: textProvider(),
    initialUserMessage: "start",
    executeTool: async () => "unused",
    context: { budgetTokens: 5000 },
    store: createMemoryTranscriptStore(),
    runId: "metadata-missing-explicit-budget",
    onEvent: (event) => events.push(event),
  });

  assert.equal(noticesOf(events).length, 0);
});

test("complete metadata keeps the derived output limit and budget numbers unchanged", async () => {
  // 防改口径：补上 maxOutputTokens 后，输出截断上限仍是 floor(0.15 × 131072) = 19660（ADR-015），
  // 不得因为走“预算元数据齐备”分支而漂移；同时不得误发诊断事件。
  const store = createMemoryTranscriptStore();
  const events = [];
  const result = await runToolLoop({
    provider: toolProvider(1),
    initialUserMessage: "start",
    modelMetadata: { contextWindowTokens: 131072, maxOutputTokens: 8192 },
    executeTool: async () => "a".repeat(20000),
    maxRounds: 3,
    completion: false,
    store,
    runId: "metadata-missing-hygiene-unchanged",
    onEvent: (event) => events.push(event),
  });

  assert.equal(noticesOf(events).length, 0);
  const stub = String(result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1")?.content);
  assert.ok(stub.startsWith("a".repeat(19660)), "阈值应为 floor(0.15 × 131072) = 19660");
  assert.ok(!stub.startsWith("a".repeat(19661)), "阈值不得大于 19660");
  assert.match(stub, /完整输出已由引擎归档/u);
});

test("metadata reachable through modelConfig or a metadata-carrying context also silences it", async () => {
  for (const [runId, options] of [
    ["metadata-missing-via-model-config", {
      modelConfig: { async resolve() { return { contextWindowTokens: 32768, maxOutputTokens: 1024 }; } },
    }],
    ["metadata-missing-via-context", {
      context: { contextWindowTokens: 32768, maxOutputTokens: 1024 },
    }],
  ]) {
    const events = [];
    await runToolLoop({
      provider: textProvider(),
      initialUserMessage: "start",
      executeTool: async () => "unused",
      store: createMemoryTranscriptStore(),
      runId,
      onEvent: (event) => events.push(event),
      ...options,
    });
    assert.equal(noticesOf(events).length, 0, runId);
  }
});

test("the diagnostic fires before the first provider call, so a host can bail out early", async () => {
  const seen = [];
  const controller = new AbortController();
  const provider = textProvider();
  // issue #173 PR-B：宿主想提前停机只能用 signal.abort()（抛错不再是控制流，见下一条用例）。
  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "start",
      executeTool: async () => "unused",
      store: createMemoryTranscriptStore(),
      runId: "metadata-missing-host-abort",
      signal: controller.signal,
      onEvent: (event) => {
        seen.push(event.type);
        // 宿主看到诊断就停机：证明事件在调 provider 之前就到达。
        if (event.type === EVENT_TYPE) controller.abort();
      },
    }),
  );
  assert.equal(seen[0], EVENT_TYPE);
  assert.equal(provider.requests.length, 0, "诊断事件必须在首次 provider 调用前送达");
});

test("startup diagnostic host-callback throw is isolated and the run continues (issue #173 PR-B)", async () => {
  // PR-A 锁的是「启动期 onEvent 抛错 → 按 fail() 同口径注解终局后抛出」；PR-B 删除了那段：
  // 抛错现在走观察者隔离，run 继续跑完，model_metadata_missing 仍然恰好一条。
  const events = [];
  const observerErrors = [];
  const provider = textProvider();

  const result = await runToolLoop({
    provider,
    initialUserMessage: "go",
    executeTool: async () => "ok",
    persistence: "none",
    completion: false,
    onEvent: (event) => {
      events.push(event);
      throw new Error("host onEvent blew up");
    },
    onObserverError: (error, context) => observerErrors.push({ error, context }),
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" }, "抛错不再是拒绝 run 的机制");
  assert.equal(provider.requests.length, 1, "首次 provider 调用照常发生");
  assert.equal(noticesOf(events).length, 1, "去重语义不受抛错影响：仍然恰好一条");
  // onEvent 每条事件都在抛，因此每个事件各记一笔；这里只取启动诊断那一笔
  const notice = observerErrors.filter((entry) => entry.context.type === EVENT_TYPE);
  assert.equal(notice.length, 1);
  assert.equal(notice[0].error.message, "host onEvent blew up");
  assert.equal(notice[0].context.channel, "onEvent");
  assert.equal(notice[0].context.runId, undefined, "未传 runId 时不编造字段");
});

test("startup diagnostic throw plus abort: the abort is the only thing that ends the run (issue #173/#180)", async () => {
  // PR-B 后的口径：抛错被隔离，run 继续；终局由宿主自己的 abort 决定（不再是「startup throw
  // 注解 failed/aborted」），载荷仍按 #180 携带。
  const controller = new AbortController();
  const observerErrors = [];
  await assert.rejects(
    runToolLoop({
      provider: textProvider(),
      initialUserMessage: "go",
      executeTool: async () => "ok",
      persistence: "none",
      completion: false,
      signal: controller.signal,
      onEvent: () => { controller.abort(); throw new Error("host onEvent blew up"); },
      onObserverError: (error) => observerErrors.push(error),
    }),
    (error) => {
      assert.equal(error.termination.reason, "aborted", "终局来自 abort，不是来自抛错");
      assert.ok(error.usage && typeof error.rounds === "number");
      assert.equal(error.termination.usage, error.usage);
      assert.equal(error.termination.partial, true);
      return true;
    },
  );
  assert.deepEqual(observerErrors.map((error) => error.message), ["host onEvent blew up"]);
});
