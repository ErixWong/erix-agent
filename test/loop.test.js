import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("returns a single-turn final response", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  assert.equal(result.finalText, "done");
  assert.equal(result.rounds, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
});

test("feeds tool results back to the provider on the next round", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { key: "x" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "found" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "find x",
    executeTool: async ({ name, input }) => `${name}:${input.key}`,
    completion: false,
  });

  assert.equal(result.finalText, "found");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1].messages.at(-1), {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "call-1",
      content: "lookup:x",
      erixRound: 1, // issue #35 年龄标记（TTL 折叠按创建轮判定）
    }],
  });
});

test("returns truncated after maxRounds", async () => {
  const provider = createFakeProvider([
    {
      times: 2,
      content: [{ type: "tool_use", id: "call", name: "step", input: { n: 1 } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "continue",
    maxRounds: 2,
    executeTool: async () => "ok",
    stallDetection: false,
  });

  assert.equal(result.rounds, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.finalText, "cannot recover");
});

test("rejects non-positive, non-finite, and non-integer maxRounds", async () => {
  for (const maxRounds of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    await assert.rejects(
      runToolLoop({
        provider: createFakeProvider([]),
        initialUserMessage: "invalid",
        maxRounds,
        executeTool: async () => "unused",
      }),
      (error) => error instanceof TypeError
        && /maxRounds must be a finite positive integer/.test(error.message),
    );
  }
});

test("rejects unknown runToolLoop options with a close suggestion", async () => {
  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([]),
      initialUserMessage: "invalid option",
      executeTool: async () => "unused",
      maxRound: 1,
    }),
    (error) => error instanceof TypeError
      && error.message === 'unknown runToolLoop option: "maxRound" (did you mean "maxRounds"?)',
  );
});

test("nudges repeated calls before stopping after a consecutive stall streak", async () => {
  const provider = createFakeProvider([
    {
      times: 8,
      content: [{ type: "tool_use", id: "call", name: "same", input: { n: 1 } }],
      stopReason: "tool_use",
    },
      { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "repeat",
    maxRounds: 8,
    executeTool: async () => "ok",
    completion: false,
    stallDetection: { window: 2, mode: "consecutive" },
  });
  assert.equal(result.termination.reason, "stall");
  assert.equal(result.truncated, true);
  assert.equal(provider.requests.length, 8);
  assert.ok(provider.requests.some((request) => (
    request.messages.some((message) => (
      Array.isArray(message.content)
      && message.content.some((block) => /疑似重复调用/.test(block.text ?? ""))
    ))
  )));
});

test("clears the stall streak after a normal tool call", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "a1", name: "same", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "a2", name: "same", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "b1", name: "other", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "b2", name: "other", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "b3", name: "other", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "repeat",
    maxRounds: 6,
    executeTool: async () => "ok",
    completion: false,
    stallDetection: { window: 1, mode: "consecutive" },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.truncated, false);
  assert.equal(provider.requests.length, 6);
});

test("stall detection defaults to consecutive so interleaved re-reads are not stalls", async () => {
  // 真实项目评估 §5.2（R4a）：写报告前回看刚读过的文件被 appear 模式判停滞。
  // 默认改为 consecutive：交替签名（a/b 交替重读同一批文件）不再触发停滞 nudge。
  const readPattern = () => [
    { content: [{ type: "tool_use", id: "a1", name: "readFile", input: { path: "a.txt" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "b1", name: "readFile", input: { path: "b.txt" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "a2", name: "readFile", input: { path: "a.txt" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "b2", name: "readFile", input: { path: "b.txt" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "a3", name: "readFile", input: { path: "a.txt" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "b3", name: "readFile", input: { path: "b.txt" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
  ];
  const run = async (options) => {
    const provider = createFakeProvider(readPattern());
    const result = await runToolLoop({
      provider,
      initialUserMessage: "重读已读文件",
      executeTool: async () => "ok",
      maxRounds: 6,
      completion: false,
      ...options,
    });
    const nudgeRequests = provider.requests.filter((request) => request.messages.some((message) => (
      Array.isArray(message.content)
      && message.content.some((block) => /疑似重复调用/.test(block.text ?? ""))
    ))).length;
    return { result, nudgeRequests };
  };

  // 默认（不传 stallDetection）= consecutive：交替签名不算停滞，无 nudge
  const byDefault = await run({});
  assert.equal(byDefault.result.termination.reason, "max_rounds_cap");
  assert.equal(byDefault.result.rounds, 6);
  assert.equal(byDefault.nudgeRequests, 0, "默认 consecutive 下交替重读不应判停滞");

  // 显式传对象（未指定 mode）维持原有 appear 语义：显式调用方行为不变
  const explicit = await run({ stallDetection: { window: 4 } });
  assert.equal(explicit.result.termination.reason, "max_rounds_cap");
  assert.ok(explicit.nudgeRequests > 0, "显式 {window:4} 仍是 appear 语义");

  // appear 仍可显式选择
  const appear = await run({ stallDetection: { window: 4, mode: "appear" } });
  assert.ok(appear.nudgeRequests > 0, "显式 mode:appear 仍能命中停滞");
});

test("feeds executeTool errors back as is_error and continues", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "bad", name: "fail", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "recovered" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "run",
    executeTool: async () => {
      throw new Error("permission denied");
    },
    completion: false,
  });

  assert.equal(result.finalText, "recovered");
  assert.deepEqual(provider.requests[1].messages.at(-1).content[0], {
    type: "tool_result",
    tool_use_id: "bad",
    content: "permission denied",
    is_error: true,
    erixRound: 1, // issue #35 年龄标记
  });
});

test("onToolResult can rewrite a result before it is fed back", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "secret", name: "read", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "redacted" }], stopReason: "end_turn" },
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "read",
    executeTool: async () => "top secret",
    completion: false,
    onToolResult: async (name, result) => `${name}:${result.replace("top ", "")}`,
  });

  assert.equal(provider.requests[1].messages.at(-1).content[0].content, "read:secret");
});

test("stores each round snapshot and can rebuild the transcript", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "tool-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    runId: "run-1",
    initialUserMessage: "start",
    executeTool: async () => "worked",
    store,
    completion: false,
  });
  const records = await store.load("run-1");

  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.round), [0, 1, 2]);
  assert.deepEqual(records[0].messages, result.messages.slice(0, 1)); // round 0 种子 = 初始消息入档
  assert.equal(records[1].messages.at(-1).content[0].content, "worked");
  assert.equal(records[2].messages[0].content[0].text, "complete");
  assert.deepEqual(result.messages, records.flatMap((record) => record.messages));
});

test("accumulates input and output usage", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "u1", name: "work", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 4, output_tokens: 2 },
    },
    {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "done",
    completion: false,
  });

  assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 5 });
});

test("stall detection can be disabled", async () => {
  const provider = createFakeProvider([
    {
      times: 3,
      content: [{ type: "tool_use", id: "same", name: "same", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "repeat",
    maxRounds: 3,
    executeTool: async () => "ok",
    stallDetection: false,
  });

  assert.equal(result.rounds, 3);
  assert.equal(result.truncated, true);
});

test("stallDetection:false overrides ERIX_STALL_MODE env", async () => {
  const previous = process.env.ERIX_STALL_MODE;
  process.env.ERIX_STALL_MODE = "consecutive";
  try {
    // 显式关闭 stall 检测优先于环境变量——env 不应重新打开（审计阻断项修复）
    // 旧 bug：false 被 env 覆盖成 {window:4} → 第5轮 stalled → nudge 注入
    // 新实现：false → window 0 → 完全不检测 → 无 nudge
    const provider = createFakeProvider([{
      times: 6,
      content: [{ type: "tool_use", id: "call", name: "same", input: { n: 1 } }],
      stopReason: "tool_use",
    }, { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" }]);
    const result = await runToolLoop({
      provider,
      initialUserMessage: "env-ignored",
      maxRounds: 6,
      executeTool: async () => "ok",
      completion: false,
      stallDetection: false,
    });
    assert.equal(result.termination.reason, "max_rounds_cap");
    assert.equal(result.truncated, true);
    // 关键：无任何 stall nudge 注入（旧 bug 会注入）
    const anyNudge = provider.requests.some((request) => (
      request.messages.some((message) => (
        Array.isArray(message.content)
        && message.content.some((block) => /疑似重复调用/.test(block.text ?? ""))
      ))
    ));
    assert.equal(anyNudge, false, "stallDetection:false 时不应有任何 stall nudge");
  } finally {
    if (previous === undefined) delete process.env.ERIX_STALL_MODE;
    else process.env.ERIX_STALL_MODE = previous;
  }
});

test("ERIX_STALL_MODE env overrides stall detection mode", async () => {
  const previous = process.env.ERIX_STALL_MODE;
  process.env.ERIX_STALL_MODE = "consecutive";
  try {
    // appear 模式下（默认），两个相同调用出现在窗口内即 stalled；
    // consecutive 模式下，交替签名不会触发停滞。
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "a1", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "b1", name: "write", input: { n: 2 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a2", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "b2", name: "write", input: { n: 2 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a3", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
    ]);

    const result = await runToolLoop({
      provider,
      initialUserMessage: "env-override",
      maxRounds: 5,
      executeTool: async () => "ok",
      stallDetection: { window: 2 }, // 未指定 mode，应由 ERIX_STALL_MODE 接管
    });
    assert.equal(result.rounds, 5);
    assert.equal(result.truncated, true);
    assert.equal(provider.requests.length, 6);
  } finally {
    if (previous === undefined) {
      delete process.env.ERIX_STALL_MODE;
    } else {
      process.env.ERIX_STALL_MODE = previous;
    }
  }
});

test("final budget round omits tools and finishes with text (no max_rounds_cap truncation)", async () => {
  // 2026-09-20 预算兜底：最后一轮不带 tools，强制模型输出文本终稿
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "call-1", name: "step", input: { n: 1 } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "最终结论：任务完成" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    tools: [{ name: "step", description: "d", inputSchema: { type: "object", properties: {} } }],
    maxRounds: 2,
    completion: false,
    reflection: false,
  });

  assert.equal(provider.requests.length, 2);
  // 第 1 轮（非最后）带 tools；第 2 轮（最后一轮）不带 tools
  assert.equal(Array.isArray(provider.requests[0].tools), true);
  assert.equal("tools" in provider.requests[1], false);
  // 以文本终稿收尾，不是 max_rounds_cap 截断路径
  assert.equal(result.finalText, "最终结论：任务完成");
  assert.equal(result.truncated, false);
  assert.notEqual(result.termination.reason, "max_rounds_cap");
});

test("final budget round skips intercept audit (no tools to judge)", async () => {
  // maxRounds=1 → 唯一一轮即最后一轮：即使审计间隔已到也不调 intercept judge
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "t1", name: "step", input: { n: 1 } }], stopReason: "tool_use" },
    // 循环耗尽预算后 forceFinalIfNeeded 会向主 provider 再要一次强制收尾
    { content: [{ type: "text", text: "强制收尾结论" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    { content: [{ type: "text", text: '{"done":false,"confidence":0.9}' }] },
  ]);
  const executed = [];

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ input }) => {
      executed.push(input.n);
      return "ok";
    },
    maxRounds: 1,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      maxExtensions: 0, // 关掉 near-limit legacy 反射，隔离出 intercept 路径
      judge: { provider: judge },
    },
  });

  // intercept 审计被跳过：judge 零调用，工具照常执行
  assert.equal(judge.requests.length, 0);
  assert.deepEqual(executed, [1]);
  assert.equal(result.rounds, 1);
});

test("tool result TTL fold: placeholder replaces aged large results in later requests (issue #35)", async () => {
  const big = `line: ${"x".repeat(20_000)}`;
  const toolSteps = [1, 2, 3, 4, 5].map((n) => ({
    content: [{
      type: "tool_use",
      id: `call-${n}`,
      name: "scan",
      input: { path: `src/f${n}.js`, offset: 0, limit: 100 },
    }],
    stopReason: "tool_use",
  }));
  const provider = createFakeProvider([
    ...toolSteps,
    { content: [{ type: "text", text: "最终结论：完成" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "scan it",
    executeTool: async () => big,
    maxRounds: 6,
    stallDetection: false,
    completion: false,
  });

  assert.equal(result.truncated, false);
  assert.equal(result.finalText, "最终结论：完成");
  assert.equal(provider.requests.length, 6);

  const resultContentAt = (requestIndex) => {
    const blocks = provider.requests[requestIndex].messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result");
    return blocks.map((block) => block.content);
  };

  // r2 请求：r1 的结果刚产生 1 轮（age=1 < ttl=2），原文在场
  assert.deepEqual(resultContentAt(1), [big]);
  // r3 请求：age=2 >= ttl=2 → 占位符在场
  const foldedViews = resultContentAt(2);
  assert.equal(foldedViews.length, 2);
  assert.match(foldedViews[0], /【已折叠·TTL】scan path/);
  assert.match(foldedViews[0], /recall\(\{fromRound:1/);
  assert.ok(!foldedViews[0].includes("xxxx"));
  // r2 产生的结果 age=1 不折
  assert.equal(foldedViews[1], big);
  // 终稿保护：r6 是 omitTools 终稿轮 → 折叠关闭，原文恢复在场（协议不报错）
  const finalViews = resultContentAt(5);
  assert.equal(finalViews[0], big);

  // ctx.messages 本身始终保留全文（checkpoint/归档语义不受影响）
  const stored = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result");
  assert.ok(stored.length >= 1);
  for (const block of stored) assert.ok(block.content.startsWith(big));
});

test("tool result TTL fold: disabled via ttl=0 keeps originals in every request", async () => {
  const big = "y".repeat(20_000);
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "call-1", name: "scan", input: { n: 1 } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "call-2", name: "scan", input: { n: 2 } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "call-3", name: "scan", input: { n: 3 } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "go",
    executeTool: async () => big,
    maxRounds: 4,
    stallDetection: false,
    completion: false,
    toolResultTtl: 0,
  });

  assert.equal(result.truncated, false);
  for (const request of provider.requests) {
    const blocks = request.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result");
    // 低预算提示可能追加在结果尾部（budgetHintFor），原文必须仍在场
    for (const block of blocks) assert.ok(block.content.startsWith(big));
  }
});
