// issue #469：折叠摘要调用的四条缺口 —— 限时 / 输入有界 / 看结果状态 / 降级原因不隐身。
// 全部零真实 LLM：provider 侧用假 chat，策略侧用假 summarizer。
import test from "node:test";
import assert from "node:assert/strict";

import {
  createFoldLlmStrategy,
  classifyFoldDegradeKind,
} from "../../src/compact/fold-llm.js";
import {
  createProviderSummarizer,
  serializeFoldedMessages,
} from "../../src/compact/provider-summarizer.js";
import { createCompactionStat } from "../../src/compact/pipeline.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";

// 足够长的早期消息：让折叠输入进到「还能再裁一半」的量级（重试下限 256 token）。
const BULK = "alpha ".repeat(2000);

function conversation(bulky = false) {
  return [
    { role: "user", content: bulky ? BULK : "initial request" },
    { role: "assistant", content: [{ type: "text", text: bulky ? BULK : "phase one" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [{ type: "text", text: "phase two" }] },
    { role: "user", content: [{ type: "text", text: "continue again" }] },
    { role: "assistant", content: [{ type: "text", text: "phase three" }] },
  ];
}

const SUMMARY = [
  "## 阶段", "完成初始化。",
  "## 已改文件", "src/example.js",
  "## 已验证项", "node --test",
  "## 下一步", "已完成项禁止重做；继续收尾。",
  "## 主题词面包屑", "example, tests",
].join("\n");

function keepalive() {
  // 摘要器超时用的定时器是 unref 的：测试里必须另留一个 handle，否则事件循环可能提前空转退出。
  const timer = setInterval(() => {}, 1000);
  return () => clearInterval(timer);
}

test("#469-① 摘要专属超时：只中断这一发，不连坐 run；原因分类为 timeout", async () => {
  const parent = new AbortController();
  const release = keepalive();
  try {
    const summarizer = createProviderSummarizer({
      chat: () => new Promise(() => {}), // 永不返回
      summarizerTimeoutMs: 25,
      signal: parent.signal,
    });
    const error = await summarizer({ messages: conversation() }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error, "挂起的摘要调用必须按时失败");
    assert.equal(error.code, "summarizer_timeout");
    assert.equal(classifyFoldDegradeKind(error), "timeout");
    // 关键：run 的 signal 没被这条超时牵连（否则一次摘要超时 = 整轮任务死）。
    assert.equal(parent.signal.aborted, false);
  } finally {
    release();
  }
});

test("#469-①④ 摘要器超时 ⇒ 终局 summarizer_failed（details.kind=timeout），不重试", async () => {
  // issue #661 语义反转：改前这一格断言「折叠照常完成，degradeKind 落进 foldSummary」
  // （#33 D 的降级路径）。那条路径已删 ⇒ 摘要器超时是**终局错误**，
  // 分类从 `foldSummary.degradeKind` 搬到异常的 `details.kind`。
  let calls = 0;
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      calls += 1;
      const error = new Error("fold summarizer timed out after 25ms");
      error.code = "summarizer_timeout";
      throw error;
    },
  });
  const error = await strategy.compact(conversation(), { keepRounds: 1 }).then(
    () => assert.fail("摘要器超时必须抛错（不许返回降级替代物）"),
    (thrown) => thrown,
  );
  assert.equal(calls, 1, "超时不是超窗，不做重试");
  assert.equal(error.code, "summarizer_failed");
  assert.equal(error.details.kind, "timeout");
  // `errorCode` 取根因自己的 code（与 `terminationErrorCodeForError` 同一口径）。
  assert.equal(error.errorCode, "summarizer_timeout");
  assert.equal(error.retryable, false);
  assert.match(error.message, /timed out/u);
});

test("#469-② 超窗（网关 400）：带更短的输入重试一次并成功，不再静默降级", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      if (seen.length === 1) {
        throw new Error(
          "400 message = input length `16584` is longer than configured context length `16384`.",
        );
      }
      return SUMMARY;
    },
  });
  const result = await strategy.compact(conversation(true), { keepRounds: 1 });
  assert.equal(seen.length, 2, "超窗必须重试一次");
  // 裁掉整条消息时，开头会多一条「已省略」注占住一个位置 ⇒ **消息条数可以不变**，
  // 真正变小的是序列化后的输入。拿条数当断言会得到假阳性。
  const inputChars = seen.map((input) => JSON.stringify(input.messages).length);
  assert.ok(
    inputChars[1] < inputChars[0],
    `重试输入必须更短：${inputChars[0]} → ${inputChars[1]} 字符`,
  );
  assert.equal(result.foldSummary.source, "llm", "重试成功 ⇒ 不是降级");
  assert.equal(result.foldSummary.degradeKind, undefined);
  assert.equal(result.foldSummary.inputTruncated, true);
  assert.ok(result.foldSummary.droppedMessages > 0);
});

test("#469-③④ 结果状态入账：finish_reason 与 token 进 compactionStats.foldSummary", async () => {
  const metas = [];
  const summarizer = createProviderSummarizer({
    chat: async () => ({
      content: [{ type: "text", text: "## 阶段\n截断在半截" }],
      usage: { input_tokens: 16584, output_tokens: 800 },
      finish_reason: "length",
    }),
    onMeta: (meta) => metas.push(meta),
  });
  const summary = await summarizer({ messages: conversation() });
  assert.equal(summary, "## 阶段\n截断在半截");
  assert.equal(metas.length, 1);
  assert.equal(metas[0].finishReason, "length");
  assert.equal(metas[0].inputTokens, 16584);
  assert.equal(metas[0].outputTokens, 800);

  const stat = createCompactionStat({
    compacted: true,
    foldSummary: { ...metas[0], degradeKind: "timeout", text: "不该进账的正文" },
  });
  assert.deepEqual(stat.foldSummary, {
    degradeKind: "timeout",
    finishReason: "length",
    inputTokens: 16584,
    outputTokens: 800,
  });
  // 无事发生 ⇒ 无键：既有读取形状逐字不变。
  assert.equal("foldSummary" in createCompactionStat({ compacted: true }), false);
  assert.equal("foldSummary" in createCompactionStat({ compacted: true, foldSummary: {} }), false);
});

test("#469-② 输入上限：从最旧侧整条丢弃并留省略注；不传则逐字不变", async () => {
  const messages = [
    { role: "user", content: "OLDEST-UNIQUE" },
    { role: "assistant", content: "middle message body" },
    { role: "user", content: "NEWEST-UNIQUE" },
  ];
  const unbounded = serializeFoldedMessages(messages, { from: 1, to: 3 });
  assert.ok(unbounded.includes("OLDEST-UNIQUE") && unbounded.includes("NEWEST-UNIQUE"));
  assert.ok(!unbounded.includes("已省略"));

  const bounded = serializeFoldedMessages(messages, { from: 1, to: 3 }, { maxTokens: 20 });
  assert.ok(!bounded.includes("OLDEST-UNIQUE"), "最旧一条应被丢弃");
  assert.ok(bounded.includes("NEWEST-UNIQUE"), "尾部必须保留（最近性）");
  assert.match(bounded, /前 \d+ 条最旧消息已省略/u);
});

// issue #486 P1-A：归因按「死线是否已到」，不按「哪个 promise 先 reject」。
// 旧形状的盲区就在这个假 provider 上——它会**尊重 signal**（真 provider 恰恰如此）：
// 死线一到 `controller.abort()` ⇒ 它同步 reject `code="aborted"`，`Promise.race` 当场定型，
// 带 `summarizer_timeout` 的那条腿晚一拍落地、无人认领。
function abortableFakeChat(request) {
  return new Promise((_, reject) => {
    const fail = () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      error.code = "aborted";
      reject(error);
    };
    if (request?.signal?.aborted === true) fail();
    else request?.signal?.addEventListener("abort", fail, { once: true });
  });
}

test("#486 P1-A 会尊重 signal 的假 provider：死线到点仍记成 timeout，不是 error", async () => {
  const release = keepalive();
  try {
    const summarizer = createProviderSummarizer({
      chat: abortableFakeChat,
      summarizerTimeoutMs: 25,
    });
    const error = await summarizer({ messages: conversation() }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error, "挂起的摘要调用必须按时失败");
    assert.equal(error.code, "summarizer_timeout", "归因必须按死线，不按谁先 reject");
    assert.equal(classifyFoldDegradeKind(error), "timeout");
  } finally {
    release();
  }
});

test("#486 P1-A 宿主 abort 不是超时：不许被改写成 summarizer_timeout", async () => {
  const parent = new AbortController();
  const release = keepalive();
  try {
    const summarizer = createProviderSummarizer({
      chat: abortableFakeChat,
      summarizerTimeoutMs: 30_000,
      signal: parent.signal,
    });
    const pending = summarizer({ messages: conversation() }).then(
      () => null,
      (err) => err,
    );
    parent.abort();
    const error = await pending;
    assert.ok(error, "宿主 abort 必须让这一发收工");
    assert.notEqual(error.code, "summarizer_timeout", "宿主主动 abort 属于 error，不是超时");
  } finally {
    release();
  }
});

// ── 缺陷 ②：空串摘要不是「成功的空摘要」──────────────────────────────────────────────
//
// `typeof "" === "string"` 曾让「模型什么都没写」算成功 ⇒ 折叠块里只有恢复提示 + 锚点，
// 既无语义内容、也无降级标记（看上去正常，实际是空的）。
// 口径：空串 / 只有空白的串 = **失败** ⇒ 走既有的 #33 D 降级路径（降级标记 + 统计摘要），
// 原因分类 `empty_summary`、文案「摘要器返回空内容」。
//
// 变异实验：把 `assertUsableSummary` 的 `trim() === ""` 分支删掉（退回旧的
// `typeof !== "string"` 判断）⇒ 本格两条全红（`source` 变 `llm`、无降级标记、`degradeKind` 变 `undefined`）。

// issue #661：这三格原来的口径是「空摘要 = 失败 ⇒ 走 #33 D 降级路径」。降级路径已删，
// 失败仍然是失败，只是出口从「降级替代物」变成 `summarizer_failed` 终局错误；
// `empty_summary` 这个分类**逐字保留**（它回答的是「模型没产出」，不是「不可用」）。
const expectSummarizerFailure = async (strategy) => strategy
  .compact(conversation(), { keepRounds: 1 })
  .then(
    () => assert.fail("摘要器返回空内容必须抛错（不许返回降级替代物）"),
    (thrown) => thrown,
  );

test("#469-② 空串摘要 ⇒ 终局 summarizer_failed（details.kind=empty_summary）", async () => {
  const error = await expectSummarizerFailure(createFoldLlmStrategy({ summarizer: async () => "" }));
  assert.equal(error.code, "summarizer_failed");
  assert.equal(error.details.kind, "empty_summary",
    `失败原因必须可分辨（实测 ${String(error.details.kind)}）`);
  assert.equal(error.errorCode, "summarizer_empty_summary");
  assert.match(error.message, /摘要器返回空内容/u);
});

test("#469-② 只有空白的摘要同样算失败（`trim()` 口径，不是只判空串）", async () => {
  const error = await expectSummarizerFailure(
    createFoldLlmStrategy({ summarizer: async () => "  \n\t \n " }),
  );
  assert.equal(error.code, "summarizer_failed");
  assert.equal(error.details.kind, "empty_summary", "只有空白的摘要不是内容");
});

test("#469-② 真引擎（fold-llm + 空串摘要器）：run 以 summarizer_failed 终局，且失败那一折什么都没应用", async () => {
  // issue #661 语义反转：改前这一格断言「run 正常收尾 + 折叠块是降级形状」。
  // 现在摘要是终局错误 ⇒ run 以 `failed` 收尾；而「先失败后应用」要求失败的这一折
  // 在账上不留任何痕迹（下面逐条断言，见 issue #661 判据 2 / 3）。
  const store = createMemoryTranscriptStore();
  const runId = "s-469-empty-summary";
  let turns = 0;
  const provider = {
    // fake 协议的判别键：缺了它 runToolLoop 不会把这份 provider 当 fake 驱动。
    protocol: "fake",
    model: "fake-model",
    async chat() {
      if (turns < 6) {
        turns += 1;
        return {
          content: [{
            type: "tool_use",
            id: `tu_${turns}`,
            name: "echo",
            input: { text: `R${turns}` },
          }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" };
    },
  };
  provider.chatStream = provider.chat;

  const events = [];
  const failure = await runDirect({
    capabilities: { ports: { strategy: createFoldLlmStrategy({ summarizer: async () => "" }) } },
    provider,
    runId,
    store,
    initialUserMessage: "开始任务",
    tools: [{
      name: "echo",
      description: "回显输入",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    // 正文放在 **tool_result** 里（不在 `tool_use.input` 里）：这样「工作集」才有量级，
    // 折叠决策才会在有多轮可折时发生。
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "")}_${"填充".repeat(300)}`,
    onEvent: (event) => { events.push(event); },
    maxRounds: 20,
    completion: false,
    wrapup: false,
    stallDetection: false,
    config: { folding: { context: { budgetTokens: 300, keepRounds: 0 } } },
  }).then(
    () => assert.fail("摘要器失败必须让 run 以 failed 终局（不许静默跑完）"),
    (error) => error,
  );

  assert.equal(failure.code, "summarizer_failed");
  assert.equal(failure.details.kind, "empty_summary");
  assert.equal(failure.termination?.reason, "failed",
    `终局必须是 failed（实测 ${String(failure.termination?.reason)}）`);
  assert.equal(failure.termination?.errorCode, "summarizer_failed");

  // 判据 2：失败的 run 里既没有折叠块，也没有那条被删掉的降级标记。
  const records = await store.load(runId);
  const whole = JSON.stringify(records);
  assert.ok(records.length > 0, "前提：run 必须真的落了轮记录");
  assert.ok(!whole.includes("【上下文折叠·"), "失败那一折不许留下折叠块");
  assert.ok(!whole.includes("[fold-llm 摘要失败"), "降级标记已被删除，不许再出现");

  // 判据 3-①：一个 `foldedFacts` 键都不许出现。
  assert.deepEqual(
    records.map((record) => record.foldedFacts).filter((fact) => fact !== undefined),
    [],
  );
  // 判据 3-②：没有 compaction stat，也没有 `type: "compaction"` 事件。
  assert.deepEqual(events.filter((event) => event?.type === "compaction"), []);
  const runState = await store.loadRunState(runId);
  assert.deepEqual(runState?.deterministic?.compactionStats ?? [], []);
  assert.equal(runState?.deterministic?.fold?.foldedRounds ?? 0, 0);
  // 判据 3-③：水位线没动（resume 的 `foldedThrough` 从轮记录推导 ⇒ 这里没有任何可推导的区间）。
  assert.deepEqual(
    records.map((record) => record.foldedRoundRange).filter((range) => range !== undefined),
    [],
  );
});
