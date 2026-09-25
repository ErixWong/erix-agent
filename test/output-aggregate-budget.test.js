// issue #32 #2：单轮聚合输出预算（增量准入，checkpoint 兼容）
//
// 覆盖：聚合临界值（含 framing / stub 开销）、CJK+emoji 归档保真、逐条与聚合两条闸门
// 独立、全 stub 化终止态（不死循环）、resume 一致性、opt-out（outputHygiene:false /
// 无窗口预算）、intercept 不计入、
// 失败结果保留 is_error + 错误片段、下一轮请求看到的是替换后 stub。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { estimateTokens } from "../src/tokens.js";
import {
  AGGREGATE_FRAMING_TOKENS,
  computeAggregateBudgetTokens,
  estimateInlineCost,
} from "../src/loop/aggregate-budget.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// clamp(floor(0.30 × 53337), 16000, 200000) = 16001（刚好不被下限夹到）
const BUDGET_BASE = 53337;
const AGGREGATE_BUDGET = computeAggregateBudgetTokens(BUDGET_BASE);
const BIG_LIMIT = { limit: 100000 }; // 关掉逐条阈值，只考察聚合层

const AGGREGATE_STUB = /本轮工具输出已超单轮聚合预算/u;

/**
 * 生成 estimateTokens() 恰好等于 target 的字符串（CJK 打底省字节 + ASCII 微调），
 * 语义上等价于 `prefix + <filler> + suffix`。
 */
function textWithTokens(target, { prefix = "", suffix = "" } = {}) {
  for (let extra = 0; extra <= 12; extra += 1) {
    const fixedTokens = estimateTokens(`${prefix}${suffix}`);
    const cjkCount = Math.max(0, Math.floor((target - fixedTokens) / 1.725) - extra);
    const head = `${prefix}${"中".repeat(cjkCount)}`;
    const baseTokens = estimateTokens(`${head}${suffix}`);
    if (baseTokens > target) continue;
    let low = 0;
    let high = (target - baseTokens) * 4 + 8;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateTokens(`${head}${"x".repeat(middle)}${suffix}`) >= target) high = middle;
      else low = middle + 1;
    }
    const candidate = `${head}${"x".repeat(low)}${suffix}`;
    if (estimateTokens(candidate) === target) return candidate;
  }
  return null;
}

function textOrFail(target, options) {
  const text = textWithTokens(target, options);
  assert.ok(text, `no text with exactly ${target} estimated tokens`);
  return text;
}

function toolResponseCalls(ids) {
  return {
    content: ids.map((id) => ({ type: "tool_use", id, name: `tool-${id}`, input: {} })),
    stopReason: "tool_use",
  };
}

const DONE = { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };

async function runRound({
  runId,
  outputs = [],
  budgetTokens = BUDGET_BASE,
  outputHygiene = BIG_LIMIT,
  store = createMemoryTranscriptStore(),
  extra = {},
  responses,
  abortOnId,
  controller,
}) {
  const provider = createFakeProvider(responses ?? [
    toolResponseCalls(outputs.map((_output, index) => `c${index + 1}`)),
    DONE,
  ]);
  let sequential = 0;
  const events = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "run tools",
    executeTool: async ({ id }) => {
      const matched = /^c(\d+)$/u.exec(String(id));
      const output = matched
        ? outputs[Number(matched[1]) - 1]
        : outputs[sequential];
      sequential += 1;
      if (abortOnId !== undefined && id === abortOnId) controller.abort();
      return output;
    },
    store,
    runId,
    ...(budgetTokens === undefined || budgetTokens === null
      ? {}
      : { context: { budgetTokens } }),
    ...(outputHygiene === undefined ? {} : { outputHygiene }),
    ...(controller === undefined ? {} : { signal: controller.signal }),
    completion: false,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { result, events, store, provider };
}

function toolResultContents(messages) {
  const map = new Map();
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_result") map.set(block.tool_use_id, String(block.content));
    }
  }
  return map;
}

function toolResultBlocks(messages) {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result");
}

function aggregateEvents(events) {
  return events.filter((event) => event.type === "tool_output_aggregate");
}

function roundToolOutputs(records, round) {
  return records.find((record) => record.round === round)?.toolOutputs ?? [];
}

test("computeAggregateBudgetTokens: 0.30x base with clamp(16000, 200000); undefined without a base", () => {
  assert.equal(computeAggregateBudgetTokens(undefined), undefined);
  assert.equal(computeAggregateBudgetTokens(0), undefined);
  assert.equal(computeAggregateBudgetTokens(-5), undefined);
  assert.equal(computeAggregateBudgetTokens(1.5), undefined);
  assert.equal(computeAggregateBudgetTokens(53333), 16000, "下限夹取");
  assert.equal(computeAggregateBudgetTokens(53337), 16001);
  assert.equal(computeAggregateBudgetTokens(100000), 30000);
  assert.equal(computeAggregateBudgetTokens(700000), 200000, "上限夹取：0.30 × 700000 = 210000");
  assert.equal(computeAggregateBudgetTokens(1000000), 200000);
});

test("aggregate budget boundary: -1 / equal / +1 token, framing counted (issue #32 #2)", async (t) => {
  const first = "HEAD-FIRST-CONTEXT";
  const firstTokens = estimateTokens(first);
  const firstCost = estimateInlineCost(first);
  assert.equal(firstCost, firstTokens + AGGREGATE_FRAMING_TOKENS, "framing 计入成本口径");

  const cases = [
    {
      name: "one token under → both inline",
      target: AGGREGATE_BUDGET - firstCost - AGGREGATE_FRAMING_TOKENS - 1,
      stubbed: false,
    },
    {
      name: "exactly equal → both inline",
      target: AGGREGATE_BUDGET - firstCost - AGGREGATE_FRAMING_TOKENS,
      stubbed: false,
    },
    {
      name: "one token over → second archived + stub",
      target: AGGREGATE_BUDGET - firstCost - AGGREGATE_FRAMING_TOKENS + 1,
      stubbed: true,
    },
    {
      name: "raw token sum equals budget but framing pushes over → second archived",
      target: AGGREGATE_BUDGET - firstTokens,
      stubbed: true,
    },
  ];
  for (const [index, boundary] of cases.entries()) {
    await t.test(boundary.name, async () => {
      const second = textOrFail(boundary.target);
      const runId = `agg-boundary-${index}`;
      const { result, events, store } = await runRound({
        runId,
        outputs: [first, second],
      });
      const contents = toolResultContents(result.messages);
      assert.equal(AGGREGATE_STUB.test(contents.get("c1")), false, "第一条在内，不变");
      assert.equal(AGGREGATE_STUB.test(contents.get("c2")), boundary.stubbed);
      const outputs = roundToolOutputs(await store.load(runId), 1);
      assert.equal(outputs.length, boundary.stubbed ? 1 : 0);
      if (boundary.stubbed) {
        // 归档的是**原文**（不是 stub）；stub 只出现在上下文视图
        assert.equal(outputs[0].content, second);
        assert.equal(outputs[0].toolUseId, "c2");
        assert.deepEqual(
          aggregateEvents(events).map((event) => [event.action, event.reason]),
          [["archived", "aggregate_budget"]],
        );
      } else {
        assert.deepEqual(aggregateEvents(events), []);
      }
    });
  }
});

test("stub overhead is counted against the round budget", async () => {
  const perResult = 5500;
  const outputs = [0, 1, 2].map(() => textOrFail(perResult));
  const runId = "agg-stub-overhead";
  const { result, events, store } = await runRound({ runId, outputs });
  const contents = toolResultContents(result.messages);
  assert.equal(AGGREGATE_STUB.test(String(contents.get("c1"))), false);
  assert.equal(AGGREGATE_STUB.test(String(contents.get("c2"))), false);
  assert.equal(AGGREGATE_STUB.test(String(contents.get("c3"))), true);
  assert.equal(roundToolOutputs(await store.load(runId), 1).length, 1);
  const decided = aggregateEvents(events);
  assert.deepEqual(decided.map((event) => event.toolUseId), ["c3"]);
  // 第 3 条判定时，前两条仍是原文本、第 3 条的 stub 尚未产生 → inlineTokens = 前两条之和
  assert.equal(
    decided[0].inlineTokens,
    estimateInlineCost(outputs[0]) + estimateInlineCost(outputs[1]),
  );
  assert.equal(decided[0].budgetTokens, AGGREGATE_BUDGET);
  assert.ok(estimateInlineCost(contents.get("c3")) > 0, "stub 本身也计入（下一轮判定会看到）");
});

test("CJK + emoji round trip: archived text remains byte-identical", async () => {
  const marker = "尾部锚点🀄️🙂UNIQUE_TAIL";
  const huge = textOrFail(20000, { suffix: marker });
  const runId = "agg-cjk";
  const { store } = await runRound({ runId, outputs: ["small-head", huge] });
  const archived = roundToolOutputs(await store.load(runId), 1);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].content, huge, "归档文本 == 原文（含 CJK/emoji）");
  assert.equal(archived[0].content.includes(marker), true);
});

test("file store: aggregated archive is byte-identical", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-agg-file-"));
  try {
    const store = createFileTranscriptStore({ dir });
    const marker = "文件通道尾部锚点🔎";
    const huge = textOrFail(20000, { suffix: marker });
    await runRound({ runId: "agg-file", outputs: ["small-head", huge], store });
    const records = await store.load("agg-file");
    const archived = roundToolOutputs(records, 1);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].content, huge);
    assert.equal(archived[0].content.includes(marker), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-result limit and aggregate budget are independent (no double replacement)", async () => {
  const huge = textOrFail(20000);
  const runId = "agg-independent";
  const { result, events, store } = await runRound({
    runId,
    outputs: [huge, huge],
    outputHygiene: { limit: 4096 },
  });
  const contents = toolResultContents(result.messages);
  for (const id of ["c1", "c2"]) {
    assert.match(String(contents.get(id)), /完整输出已由引擎归档/u, `${id} 由逐条闸门处理`);
    assert.doesNotMatch(String(contents.get(id)), AGGREGATE_STUB, "聚合层不二次替换");
  }
  assert.equal(roundToolOutputs(await store.load(runId), 1).length, 2, "每条只归档一次");
  assert.deepEqual(aggregateEvents(events), []);
});

test("termination: an all-stub round stops shrinking (no repeated replacement)", async () => {
  // 逐条阈值（60000 字符 ≈ 19700 token）比聚合预算（16001）更宽 → 单条 stub 自己就超聚合预算。
  const huge = "H".repeat(70000);
  const runId = "agg-terminal";
  const { result, events, store } = await runRound({
    runId,
    outputs: [huge, huge],
    outputHygiene: { limit: 60000 },
  });
  const contents = toolResultContents(result.messages);
  for (const id of ["c1", "c2"]) {
    assert.match(String(contents.get(id)), /完整输出已由引擎归档/u);
    assert.doesNotMatch(String(contents.get(id)), AGGREGATE_STUB);
  }
  assert.equal(roundToolOutputs(await store.load(runId), 1).length, 2, "不得重复归档/替换");
  const terminal = aggregateEvents(events);
  assert.deepEqual(
    terminal.map((event) => [event.action, event.reason]),
    [["terminated", "already_stubbed"]],
    "终止态每轮只报一次",
  );
  assert.ok(
    terminal[0].projectedTokens > terminal[0].budgetTokens,
    "终止态确实超预算",
  );
});

test("resume consistency: visible stubs after recovery match the normal path", async () => {
  const outputs = [0, 1, 2].map(() => textOrFail(6000));

  const normal = await runRound({ runId: "agg-resume-normal", outputs });
  const normalContents = toolResultContents(normal.result.messages);
  assert.equal(AGGREGATE_STUB.test(String(normalContents.get("c1"))), false);
  assert.equal(AGGREGATE_STUB.test(String(normalContents.get("c2"))), false);
  assert.equal(AGGREGATE_STUB.test(String(normalContents.get("c3"))), true);

  const store = createMemoryTranscriptStore();
  const controller = new AbortController();
  await assert.rejects(
    runRound({
      runId: "agg-resume-crash",
      outputs,
      store,
      abortOnId: "c3",
      controller,
    }),
    /abort/i,
  );

  const resumed = await runRound({
    runId: "agg-resume-crash",
    outputs,
    store,
    responses: [DONE],
    extra: { resume: true },
  });
  const resumedContents = toolResultContents(resumed.result.messages);
  for (const id of ["c1", "c2", "c3"]) {
    assert.equal(
      resumedContents.get(id),
      normalContents.get(id),
      `resume 后 ${id} 的可见视图必须与正常路径一致`,
    );
  }
  const archived = (await store.load("agg-resume-crash"))
    .flatMap((record) => record.toolOutputs ?? []);
  assert.ok(
    archived.some((entry) => entry.content === outputs[2]),
    "崩溃/续跑后归档仍按字节保真落盘",
  );
});

test("opt-out: outputHygiene:false turns the aggregate layer off too", async () => {
  const huges = [0, 1, 2].map(() => textOrFail(9000));
  const runId = "agg-optout";
  const { result, events, store } = await runRound({
    runId,
    outputs: huges,
    outputHygiene: false,
  });
  const contents = toolResultContents(result.messages);
  huges.forEach((text, index) => {
    assert.equal(contents.get(`c${index + 1}`), text, "全文保留，无 stub");
  });
  assert.deepEqual(roundToolOutputs(await store.load(runId), 1), []);
  assert.deepEqual(aggregateEvents(events), []);
});

test("opt-out: no budgetTokens (no window config) keeps the aggregate layer off", async () => {
  const huges = [0, 1, 2].map(() => textOrFail(9000));
  const runId = "agg-no-budget";
  const { result, events, store } = await runRound({
    runId,
    outputs: huges,
    budgetTokens: null,
  });
  const contents = toolResultContents(result.messages);
  huges.forEach((text, index) => {
    assert.equal(contents.get(`c${index + 1}`), text);
  });
  assert.deepEqual(roundToolOutputs(await store.load(runId), 1), []);
  assert.deepEqual(aggregateEvents(events), []);
});

test("intercepted control results are neither counted nor archived", async (t) => {
  const previous = process.env.ERIX_JUDGE_INTERVAL;
  process.env.ERIX_JUDGE_INTERVAL = "1";
  try {
    const judge = createFakeProvider([{
      content: [{
        type: "text",
        text: JSON.stringify({
          done: false,
          confidence: 0.9,
          reason: "方向偏了",
          evidence: "未创建产物",
        }),
      }],
      stopReason: "end_turn",
    }]);
    // 预算留给后续结果的余量 < intercept 文案自身开销
    const nearFull = textOrFail(AGGREGATE_BUDGET - 20 - AGGREGATE_FRAMING_TOKENS) + "TAIL";
    const nearFullCost = estimateInlineCost(nearFull);
    assert.ok(nearFullCost > AGGREGATE_BUDGET - 30);
    const store = createMemoryTranscriptStore();
    const events = [];
    await runToolLoop({
      provider: createFakeProvider([toolResponseCalls(["i1", "i2", "i3"]), DONE]),
      initialUserMessage: "task",
      executeTool: async ({ id }) => (id === "i1" ? nearFull : "SHORT"),
      store,
      runId: "agg-intercept",
      context: { budgetTokens: BUDGET_BASE },
      outputHygiene: BIG_LIMIT,
      maxRounds: 20,
      completion: false,
      reflection: { enabled: true, roundJudge: false, judge: { provider: judge } },
      onEvent: (event) => events.push(event),
    });
    const records = await store.load("agg-intercept");
    const contents = toolResultContents(records.flatMap((record) => record.messages));
    assert.match(String(contents.get("i2") ?? ""), /审计拦截/u, "i2 被拦截未执行");
    assert.equal(records.flatMap((record) => record.toolOutputs ?? []).length, 0);
    const interceptCost = estimateInlineCost(contents.get("i2"));
    assert.ok(interceptCost > 20, `intercept 文案自身有开销（${interceptCost} token）`);
    // 若把 intercept 结果计入，i3 的 projected 会超预算而被归档；实测不超 → 证明未计入
    assert.ok(nearFullCost + estimateInlineCost("SHORT") <= AGGREGATE_BUDGET);
    assert.ok(nearFullCost + interceptCost + estimateInlineCost("SHORT") > AGGREGATE_BUDGET);
    assert.deepEqual(aggregateEvents(events), []);
    assert.doesNotMatch(String(contents.get("i3")), AGGREGATE_STUB);
  } finally {
    if (previous === undefined) delete process.env.ERIX_JUDGE_INTERVAL;
    else process.env.ERIX_JUDGE_INTERVAL = previous;
  }
});

test("failed results: is_error and the key error snippet survive the stub", async () => {
  const boom = textOrFail(20000, { prefix: "执行失败：", suffix: "boom-marker-at-the-end" });
  const runId = "agg-failure";
  const events = [];
  const provider = createFakeProvider([toolResponseCalls(["f1", "f2"]), DONE]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "run",
    executeTool: async ({ id }) => (id === "f2" ? { content: boom, success: false } : "small-head"),
    store: createMemoryTranscriptStore(),
    runId,
    context: { budgetTokens: BUDGET_BASE },
    outputHygiene: BIG_LIMIT,
    completion: false,
    onEvent: (event) => events.push(event),
  });
  const failed = toolResultBlocks(result.messages)
    .find((block) => block.tool_use_id === "f2");
  assert.equal(failed.is_error, true, "stub 必须保留 is_error（judge/timeline 依赖）");
  assert.match(String(failed.content), AGGREGATE_STUB);
  assert.match(
    String(failed.content),
    /失败摘要：执行失败：中+…/u,
    "stub 必须保留关键错误片段",
  );
  assert.deepEqual(aggregateEvents(events).map((event) => [event.toolUseId, event.action]), [["f2", "archived"]]);
});

test("the next request sees the stub, not the aggregated original", async () => {
  const marker = "ORIGINAL-FULL-MARKER";
  const huge = textOrFail(20000, { suffix: marker });
  const { provider, store } = await runRound({
    runId: "agg-view",
    outputs: ["small-head", huge],
  });
  const secondRequestText = toolResultBlocks(provider.requests[1].messages)
    .map((block) => String(block.content))
    .join("\n");
  assert.match(secondRequestText, AGGREGATE_STUB);
  assert.doesNotMatch(secondRequestText, new RegExp(marker), "上下文里不保留被聚合的原文");
  assert.match(roundToolOutputs(await store.load("agg-view"), 1)[0].content, new RegExp(marker));
});

test("round judge sees the stub (it must not misjudge the replaced original)", async () => {
  const marker = "JUDGE-ORIGINAL-MARKER";
  const huge = textOrFail(20000, { suffix: marker });
  const judge = createFakeProvider([{
    content: [{
      type: "text",
      text: JSON.stringify({
        done: true,
        confidence: 0.9,
        reason: "完成",
        evidence: "已有结论",
      }),
    }],
    stopReason: "end_turn",
  }]);
  const provider = createFakeProvider([
    toolResponseCalls(["c1", "c2"]),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  let call = 0;
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ id }) => {
      call += 1;
      return id === "c2" ? huge : "small-head";
    },
    store: createMemoryTranscriptStore(),
    runId: "agg-judge",
    context: { budgetTokens: BUDGET_BASE },
    outputHygiene: BIG_LIMIT,
    maxRounds: 4,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });
  assert.equal(call, 2);
  const judgePayload = JSON.stringify(judge.requests[0]);
  assert.match(judgePayload, /本轮工具输出已超单轮聚合预算/u, "judge 看到的是替换后 stub");
  assert.doesNotMatch(
    judgePayload,
    new RegExp(marker),
    "judge 不得看到被聚合的原文（防误判成「已有完整证据」）",
  );
});
