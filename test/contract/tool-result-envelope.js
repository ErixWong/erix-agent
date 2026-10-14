// 工具事实信封契约套件（工单 261014 T1，上游 issue #284 跨通道身份 / #285 耗时全形态）。
//
// 本套件钉的是**引擎产出的 tool_result / tool_use 事实形状**，不是宿主适配器：
//   · 字段归属：协议字段在顶层（`type`/`tool_use_id`/`content`，条件 `is_error`）、引擎事实只在
//     `erix.*`、宿主扩展在 `metadata.*`（双写期旧的顶层摊平键仍在，见下面的双写断言）；
//   · `TOOL_RESULT_CONTRACT` 是这三条归属的唯一真相，期望字段集合**由常量生成**（常量被削掉一个
//     字段，本套件立即红，而不是文档与测试各自再抄一份清单）；
//   · 存在性矩阵（工单 §5）：成功 / 失败 / judge 拦截 / resume 中断重放 / 已完成结果复放 /
//     未 settle 即中止，逐情形断言，并含反向断言（拦截与中断**没有** durationMs、复放**不重算**、
//     宿主同名键既在顶层也在 `metadata`、provider `id` 未被改写）；
//   · `durationMs` 缺失 = unknown，**不是 0**。
//
// 用法（宿主拿到的是包入口命名空间，与 `engineApiContract` 同一形状）：
//   import { toolResultEnvelopeContract } from "erix-agent/contract-tests";
//   toolResultEnvelopeContract("reference", async () => await import("erix-agent"));
//
// 纪律：零网络、零本机依赖、不依赖仓库树形（`docs/tasks/` 不存在也照样绿）；只用 node: 内置 +
// 注入的入口命名空间，provider stub 自带，不 import test/helpers（未发布）。

import test from "node:test";
import assert from "node:assert/strict";

const TOOL_CALL_KEY_PATTERN = /^tc_[0-9a-f]{12}$/u;
const DONE = { content: [{ type: "text", text: "all done" }], stopReason: "end_turn" };

function toolUseBlock(id, name = "work", input = { n: 1 }) {
  return { type: "tool_use", id, name, input };
}

function toolRound(id, name = "work") {
  return { content: [toolUseBlock(id, name)], stopReason: "tool_use" };
}

/** 脚本化 provider：越界重复最后一项（拦截/收尾 judge 那条路径不关心终局，别把 stub 跑炸）。 */
function scriptedProvider(script) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async chat(request) {
      requests.push(request);
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step?.throw !== undefined) throw step.throw;
      return structuredClone(step);
    },
  };
}

/** 流式 provider：先推 tool-call 片段（OpenAI 那种「arguments 先到、id 后到」的形状），再返回终。 */
function streamingToolCallProvider(id, fragments) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async chatStream(request) {
      requests.push(request);
      if (index === 0) {
        for (const fragment of fragments) request.onToolCall?.(fragment);
      }
      index += 1;
      return index === 1
        ? { content: [toolUseBlock(id)], stopReason: "tool_use" }
        : structuredClone(DONE);
    },
    async chat(request) {
      return this.chatStream(request);
    },
  };
}

function judgeProvider(decisions) {
  let index = 0;
  return {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return {
        content: [{ type: "text", text: JSON.stringify(decision) }],
        stopReason: "end_turn",
      };
    },
  };
}

function blocksOfMessages(messages, type) {
  return (messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === type);
}

/** 模型可见的那一份事实：从**上一次请求**里取（与 `execute-tool.js` 同一观测点，不加私有出口）。 */
function fedBackToolResult(provider, toolUseId) {
  const last = provider.requests.at(-1);
  const blocks = blocksOfMessages(last?.messages, "tool_result")
    .filter((block) => block.tool_use_id === toolUseId);
  assert.equal(blocks.length, 1, `期望恰好一条 ${toolUseId} 的 tool_result，实际 ${blocks.length} 条`);
  return blocks[0];
}

function eventsOfType(events, type) {
  return events.filter((event) => event?.type === type);
}

/**
 * @param {string} label 实现名（测试标题前缀）
 * @param {() => object | Promise<object>} getEntry 包入口命名空间
 *        （需要 `runToolLoop`、`createMemoryTranscriptStore`、`projectTranscriptForDisplay`、
 *         `TOOL_RESULT_CONTRACT`）
 */
export function toolResultEnvelopeContract(label, getEntry) {
  /** @type {any} */
  let contract;

  const entry = async () => {
    const namespace = await getEntry();
    if (contract === undefined) contract = namespace.TOOL_RESULT_CONTRACT;
    return namespace;
  };

  // ── 常量自身（防「三方消费」塌成两方）────────────────────────────────────────
  test(`${label}: TOOL_RESULT_CONTRACT 是导出的常量面且形状如契约`, async () => {
    const { TOOL_RESULT_CONTRACT: constant } = await entry();
    assert.equal(typeof constant, "object");
    assert.deepEqual(constant.protocol.required, ["type", "tool_use_id", "content"]);
    assert.ok(Object.hasOwn(constant.protocol.conditional, "is_error"),
      "is_error 必须作为条件协议字段登记（它在顶层，不在任何命名空间里）");
    assert.equal(constant.engine.ns, "erix");
    assert.equal(constant.host.ns, "metadata");
    assert.deepEqual(
      Object.keys(constant.engine.fields).sort(),
      ["durationMs", "executionStatus", "round", "success", "toolCallKey"],
    );
    for (const [name, spec] of Object.entries(constant.engine.fields)) {
      assert.equal(spec.owner, "engine", `${name} 的 owner 必须是 engine`);
      assert.equal(spec.onWire, false, `${name} 不得上 wire`);
      assert.equal(spec.resumeStable, true, `${name} 必须跨 resume 稳定`);
    }
    assert.equal(constant.engine.fields.durationMs.capturedAt, "executor settle");
    assert.equal(constant.engine.fields.durationMs.recomputedOnReplay, false);
    assert.equal(constant.legacy.retireAt.includes("minor"), true,
      "旧顶层字段的退役节奏必须写在常量里（T2 的 Changed（BREAKING）依据）");
  });

  const expectedEngineFields = (...extra) => ["durationMs", "round", "toolCallKey", ...extra].sort();

  /** 逐情形跑一次 runToolLoop，交回事件流、provider 请求、store 记录三侧的观测点。 */
  async function runCase(executeTool, { script = [toolRound("call-1"), DONE], options = {} } = {}) {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const provider = scriptedProvider(script);
    const events = [];
    const fragments = [];
    const store = createMemoryTranscriptStore();
    const runId = "contract-tool-envelope";
    const { onEvent, onToolCall, ...rest } = options;
    const result = await runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool,
      store,
      runId,
      completion: false,
      ...rest,
      onEvent: (event) => {
        events.push(event);
        onEvent?.(event);
      },
      onToolCall: (fragment) => {
        fragments.push(fragment);
        onToolCall?.(fragment);
      },
    });
    const records = await store.load(runId);
    return {
      provider,
      events,
      fragments,
      result,
      records,
      toolUseFacts: eventsOfType(events, "tool_use").map((event) => event.toolUse),
      toolResultFacts: eventsOfType(events, "tool_result").map((event) => event.toolResult),
    };
  }

  // ── §5 存在性矩阵：成功与失败的全部返回形态 ──────────────────────────────────
  const SUCCESS_FORMS = [
    { name: "string", executor: async () => "plain text", isError: false, declared: false },
    { name: "number", executor: async () => 42, isError: false, declared: false },
    {
      name: "{content,metadata}",
      executor: async () => ({ content: "structured", metadata: { searchHits: 3 }, success: true }),
      isError: false,
      declared: true,
    },
    {
      name: "legacy {data}",
      executor: async () => ({ data: "legacy payload", success: true, toolMessageId: "m-1" }),
      isError: false,
      declared: true,
    },
    {
      name: "returned Error",
      executor: async () => new Error("executor said no"),
      isError: true,
      declared: false,
    },
    {
      name: "thrown non-abort",
      executor: async () => {
        throw new Error("executor threw");
      },
      isError: true,
      declared: false,
    },
  ];

  for (const form of SUCCESS_FORMS) {
    test(`${label}: 返回形态 ${form.name} —— toolCallKey/round/durationMs 齐全，is_error=${form.isError}`, async () => {
      const { toolResultFacts, toolUseFacts } = await runCase(form.executor);
      assert.equal(toolResultFacts.length, 1);
      const fact = toolResultFacts[0];

      // 协议必需字段在顶层（期望集合由常量生成）
      for (const field of contract.protocol.required) {
        assert.ok(Object.hasOwn(fact, field), `协议必需字段 ${field} 必须在顶层`);
      }
      assert.equal(fact.is_error, form.isError ? true : undefined);

      // 引擎事实只在 erix.*，且字段集合恰为矩阵这一行（executor 没声明 success 就不写第四件）
      assert.deepEqual(
        Object.keys(fact.erix).sort(),
        expectedEngineFields(...(form.declared ? ["success"] : [])),
      );
      assert.match(fact.erix.toolCallKey, TOOL_CALL_KEY_PATTERN);
      assert.equal(fact.erix.round, 1);
      assert.equal(typeof fact.erix.durationMs, "number");
      assert.ok(Number.isFinite(fact.erix.durationMs) && fact.erix.durationMs >= 0);
      assert.equal(fact.erix.executionStatus, undefined);
      // 引擎事实不出现在顶层（顶层只剩双写期的旧字段）
      assert.equal(fact.toolCallKey, undefined);
      assert.equal(fact.durationMs, undefined);
      // provider 配对键未被改写
      assert.equal(fact.tool_use_id, "call-1");
      assert.equal(toolUseFacts[0].id, "call-1");
      assert.equal(toolUseFacts[0].erix.toolCallKey, fact.erix.toolCallKey,
        "线 A 的 tool_use 与线 B 的 tool_result 必须带同一个身份键");
    });
  }

  // ── 双写期：宿主键既在顶层（旧）也在 metadata（新），引擎写的键不进 metadata ──
  test(`${label}: 双写期宿主扩展键既在顶层也在 metadata，且 metadata 里没有引擎写的键`, async () => {
    const { provider, toolResultFacts, records } = await runCase(
      async () => ({ content: "structured", metadata: { artifactStatus: "ok" }, success: true }),
    );
    const fact = toolResultFacts[0];
    assert.equal(fact.artifactStatus, "ok", "双写期顶层摊平键必须照写（T2 才停）");
    assert.deepEqual(fact.metadata, { artifactStatus: "ok" },
      "metadata.* 只装宿主自己给的键：引擎写的 duration/success 不许漏进宿主命名空间");
    assert.equal(typeof fact.duration, "number", "旧的顶层 duration 仍按原口径写（结构化路径含 hook 耗时）");
    assert.equal(fact.success, true, "旧的顶层 success 仍按原口径写");
    assert.equal(fact.erix.success, true, "executor 显式声明过 → erix.success 写引擎判定后的布尔值");

    // 线 A ↔ 线 B：已提交的调用，事件里的事实与落盘 block 逐字段相等（同一对象的两个克隆）
    const persisted = blocksOfMessages(records.flatMap((record) => record.messages ?? []), "tool_result");
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], fact);
    assert.equal(fedBackToolResult(provider, "call-1").erix.toolCallKey, fact.erix.toolCallKey);
  });

  test(`${label}: 未显式声明 success 时不写 erix.success（输入/输出不对称）`, async () => {
    const { toolResultFacts } = await runCase(async () => ({ content: "no verdict" }));
    assert.equal(toolResultFacts[0].erix.success, undefined);
    assert.equal(toolResultFacts[0].is_error, undefined);
  });

  test(`${label}: 显式 success:false 同时写 erix.success 与顶层 is_error`, async () => {
    const { toolResultFacts } = await runCase(async () => ({ content: "partial", success: false }));
    assert.equal(toolResultFacts[0].erix.success, false);
    assert.equal(toolResultFacts[0].is_error, true);
    assert.equal(typeof toolResultFacts[0].erix.durationMs, "number");
  });

  // ── 跨通道身份：onToolCall fragment → tool_use → tool_result 同一个值 ────────
  test(`${label}: 流式片段的 toolCallKey 与 tool_use / tool_result 同值，原有片段字段不动`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const provider = streamingToolCallProvider("call_stream", [
      { index: 0, argumentsDelta: "{\"n\": " },
      { index: 0, id: "call_stream", name: "work" },
      { index: 0, argumentsDelta: "1}" },
    ]);
    const fragments = [];
    const events = [];
    await runToolLoop({
      provider,
      stream: true,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      store: createMemoryTranscriptStore(),
      runId: "contract-stream-key",
      completion: false,
      onToolCall: (fragment) => fragments.push(fragment),
      onEvent: (event) => events.push(event),
    });

    assert.ok(fragments.length >= 2, "至少要看到两个片段，否则这条断言没内容");
    for (const fragment of fragments) {
      assert.match(fragment.toolCallKey, TOOL_CALL_KEY_PATTERN);
      assert.equal(typeof fragment.index, "number");
    }
    assert.ok(fragments.some((fragment) => typeof fragment.argumentsDelta === "string"),
      "原有字段 argumentsDelta 必须原样透传（片段形状只增不改）");
    assert.equal(new Set(fragments.map((fragment) => fragment.toolCallKey)).size, 1,
      "同一次调用的所有片段必须共用一个 key（id 迟到的 OpenAI 形状靠 index 桥接）");
    const toolUse = eventsOfType(events, "tool_use")[0].toolUse;
    assert.equal(toolUse.id, "call_stream", "provider id 不得被改写");
    assert.equal(toolUse.erix.toolCallKey, fragments[0].toolCallKey);
    assert.equal(eventsOfType(events, "tool_result")[0].toolResult.erix.toolCallKey,
      fragments[0].toolCallKey);
    // 当前引擎事实：循环**不**把 provider 的流式 `tool_call` 事件转发到 onEvent（宿主拿片段的
    // 通道是 `onToolCall`；provider 自己发的 `tool_call` 只走 `req.onEvent`，而引擎不注入那个回调）。
    // 钉住这条是为了契约文档里「tool_call 在 onEvent 还是 onToolCall」不能被写成两样。
    assert.deepEqual(eventsOfType(events, "tool_call"), []);
  });

  // ── 已完成结果的复放：原值不重算 ─────────────────────────────────────────────
  test(`${label}: 已完成结果复放沿用原 erix 值（durationMs 不重算、executor 不再被调）`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const store = createMemoryTranscriptStore();
    const runId = "contract-replay-recorded";
    // 崩溃前已执行完的调用：run snapshot 里同时带着 tool_use 块与结果块，两者共用一个身份键。
    const recorded = {
      type: "tool_result",
      tool_use_id: "done-1",
      content: "recorded before the crash",
      erixRound: 3,
      erix: { toolCallKey: "tc_1234567890ab", round: 3, durationMs: 777 },
    };
    await store.appendRound(runId, { round: 0, messages: [{ role: "user", content: "task" }] });
    await store.saveCheckpoint(runId, {
      round: 3,
      pendingToolUses: [{ type: "tool_use", id: "done-1", name: "work", input: {} }],
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "done-1",
            name: "work",
            input: {},
            erix: { toolCallKey: "tc_1234567890ab" },
          }],
        },
      ],
      executedToolIds: ["done-1"],
      toolResults: [{ toolUseId: "done-1", toolResult: recorded }],
    });

    let calls = 0;
    const events = [];
    await runToolLoop({
      // 模型把己执行过的调用又发了一遍（复放路径），下一轮自然收尾。
      provider: scriptedProvider([toolRound("done-1"), DONE]),
      resume: true,
      store,
      runId,
      completion: false,
      executeTool: async () => {
        calls += 1;
        return "must not execute again";
      },
      onEvent: (event) => events.push(event),
    });

    assert.equal(calls, 0, "复放路径不得二次执行 executor");
    const replayEvent = eventsOfType(events, "tool_result")
      .find((event) => event.toolResult?.tool_use_id === "done-1");
    assert.ok(replayEvent, "应发出复放的 tool_result 事件");
    const replayed = replayEvent.toolResult;
    assert.equal(replayed.content, "recorded before the crash");
    assert.equal(replayed.erix.durationMs, 777, "原值不重算：沿崩溃前那份耗时");
    assert.equal(replayed.erix.round, 3, "erix.round 是执行轮，不是交付轮");
    assert.equal(replayed.erix.toolCallKey, "tc_1234567890ab");
    // 事件 envelope 的 round 是**交付轮**，与 erix.round（执行轮）不合并（工单 §2）。
    assert.notEqual(replayEvent.round, replayed.erix.round);
    assert.equal(
      eventsOfType(events, "tool_use")
        .find((event) => event.toolUse?.id === "done-1").toolUse.erix.toolCallKey,
      "tc_1234567890ab",
      "同一个 provider id 被模型再发一次也不得换身份",
    );
  });

  // ── judge 拦截：未执行 ⇒ 没有 round、没有 durationMs ──────────────────────────
  test(`${label}: judge 拦截的事实没有 round 与 durationMs（未执行 = 未知，不是 0）`, async () => {
    const judge = judgeProvider([{
      done: false, confidence: 0.8, reason: "方向可能偏", evidence: "证据不足",
    }]);
    const executed = [];
    const { toolResultFacts } = await runCase(
      async ({ id }) => {
        executed.push(id);
        return "ok";
      },
      {
        script: [toolRound("a1"), toolRound("a2"), DONE],
        options: {
          maxRounds: 8,
          reflection: {
            enabled: true, roundJudge: false, judgeIntervalRound: 1, judge: { provider: judge },
          },
        },
      },
    );
    assert.deepEqual(executed, ["a1"], "第二次调用应被拦截（写工具不放行）");
    const intercepted = toolResultFacts.find((fact) => fact.executionStatus === "intercepted");
    assert.ok(intercepted, `应有一条 intercepted 事实，实际：${JSON.stringify(toolResultFacts)}`);
    assert.deepEqual(Object.keys(intercepted.erix).sort(), ["executionStatus", "toolCallKey"]);
    assert.equal(intercepted.erix.executionStatus, "intercepted");
    assert.equal(intercepted.erix.round, undefined, "拦截未执行，不该伪造成交轮");
    assert.equal(intercepted.erix.durationMs, undefined, "拦截未执行，耗时是未知而不是 0");
    assert.equal(intercepted.is_error, undefined);
    assert.equal(intercepted.executionStatus, "intercepted", "双写期顶层旧键照写");
    assert.equal(intercepted.erixRound, undefined);
  });

  // ── resume 的 unsafe 中断重放：有身份、无耗时 ─────────────────────────────────
  test(`${label}: resume 中断重放带身份键与 interrupted，且没有 round 与 durationMs`, async () => {
    const { runToolLoop, createMemoryTranscriptStore } = await entry();
    const store = createMemoryTranscriptStore();
    const runId = "contract-resume-interrupted";
    await store.appendRound(runId, {
      round: 0,
      messages: [{ role: "user", content: "task" }],
    });
    await store.saveCheckpoint(runId, {
      round: 3,
      pendingToolUses: [{ type: "tool_use", id: "pending-1", name: "exec", input: { cmd: "rm -rf" } }],
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "pending-1",
              name: "exec",
              input: { cmd: "rm -rf" },
              erix: { toolCallKey: "tc_deadbeefcafe" },
            },
          ],
        },
      ],
      executedToolIds: [],
      toolResults: [],
    });

    const events = [];
    await runToolLoop({
      provider: scriptedProvider([DONE]),
      resume: true,
      store,
      runId,
      completion: false,
      replayPolicy: "per-tool-declaration",
      executeTool: async () => "should not run",
      onEvent: (event) => events.push(event),
    });

    const resumedToolUse = eventsOfType(events, "tool_use")[0].toolUse;
    assert.equal(resumedToolUse.erix.toolCallKey, "tc_deadbeefcafe",
      "旧快照块上的身份键必须沿用，不重生成");
    const interrupted = eventsOfType(events, "tool_result").map((event) => event.toolResult)
      .find((fact) => fact.executionStatus === "interrupted");
    assert.ok(interrupted, "unsafe 调用应产出 interrupted 的 tool_result");
    assert.deepEqual(Object.keys(interrupted.erix).sort(), ["executionStatus", "toolCallKey"]);
    assert.equal(interrupted.erix.toolCallKey, "tc_deadbeefcafe");
    assert.equal(interrupted.is_error, true);
    assert.equal(interrupted.erix.durationMs, undefined, "重放没跑过，耗时不得伪造");
    assert.equal(interrupted.erix.round, undefined);
    assert.equal(interrupted.executionStatus, "interrupted", "双写期顶层旧键照写");

    const records = await store.load(runId);
    const persisted = blocksOfMessages(records.flatMap((record) => record.messages ?? []), "tool_result")
      .filter((block) => block.tool_use_id === "pending-1");
    assert.ok(persisted.length >= 1, "线 B 必须有这条记录");
    assert.deepEqual(persisted.at(-1).erix, interrupted.erix);
  });

  // ── 投影：B 的派生视图新增两字段，legacy 记录一律缺省 ─────────────────────────
  test(`${label}: 投影带出 toolCallKey 与 durationMs，旧记录（无 erix）两字段缺省`, async () => {
    const { projectTranscriptForDisplay } = await entry();
    const { records } = await runCase(async () => "body");
    const calls = projectTranscriptForDisplay(records)
      .flatMap((turn) => turn.toolCalls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "call-1", "投影仍保留 provider id 作为结果关联键");
    assert.match(calls[0].toolCallKey, TOOL_CALL_KEY_PATTERN);
    assert.equal(typeof calls[0].durationMs, "number");
    assert.equal(typeof calls[0].key, "string", "位置型展示键必须仍然存在（语义未变）");

    const legacy = projectTranscriptForDisplay([{
      round: 9,
      response: { content: [{ type: "tool_use", id: "old-1", name: "work", input: {} }] },
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "old-1", content: "x" }] }],
    }]).flatMap((turn) => turn.toolCalls ?? []);
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].toolCallKey, undefined, "0.19 及更早的记录没有该字段，投影不得造一个");
    assert.equal(legacy[0].durationMs, undefined, "缺失就是缺失，不得渲染成 0");
  });

  // ── 单轮聚合把 content 换成 stub 时，事实字段必须留着 ─────────────────────────
  test(`${label}: 聚合 stub 只换 content，erix 与 metadata 字段原样保留`, async () => {
    const { toolResultFacts } = await runCase(
      async () => ({ content: "巨".repeat(120000), metadata: { artifactStatus: "ok" } }),
      { options: { context: { budgetTokens: 53337 }, outputHygiene: { limit: 1_000_000 } } },
    );
    const fact = toolResultFacts[0];
    assert.notEqual(fact.content, "巨".repeat(120000), "本例必须真的走到 stub 化，否则等于没测");
    assert.match(fact.content, /预算/u);
    assert.equal(fact.metadata.artifactStatus, "ok");
    assert.match(fact.erix.toolCallKey, TOOL_CALL_KEY_PATTERN);
    assert.equal(fact.erix.round, 1);
    assert.equal(typeof fact.erix.durationMs, "number");
  });

  // ── 观察者改写与卫生不改变耗时口径 ────────────────────────────────────────────
  test(`${label}: durationMs 不含 onToolResult 改写耗时（口径 = executor settle）`, async () => {
    const { toolResultFacts } = await runCase(
      async () => ({ content: "fast", metadata: {} }),
      {
        options: {
          onToolResult: async () => {
            const until = Date.now() + 60;
            while (Date.now() < until) { /* 自旋，把 hook 耗时抬到可观测 */ }
            return { content: "rewritten", metadata: {} };
          },
        },
      },
    );
    const fact = toolResultFacts[0];
    assert.equal(fact.content, "rewritten");
    assert.ok(fact.erix.durationMs < 50,
      `erix.durationMs 只该覆盖 executor settle（实测 ${fact.erix.durationMs}ms，hook 自旋了 60ms）`);
    assert.ok(typeof fact.duration === "number" && fact.duration >= 50,
      `双写期的旧顶层 duration 保持历史口径（含 hook 耗时，实测 ${fact.duration}ms）`);
  });
}
