// issue #588 —— **续写轮 + 尾部悬空 `tool_use` 撞上压缩 ⇒ `invalid_messages` 打死整个 run**（本单先复现）。
//
// 复现形状（最小，1 格）：`budgetTokens` 极小 + `keepRounds: 0` + 首发响应被 `max_tokens` 截断且
// content 里带 `tool_use`（两个协议都真会吐这个形状：OpenAI `finish_reason:"length"` 带 `tool_calls`、
// Anthropic `stop_reason:"max_tokens"` 带 `tool_use`）。续写循环里那一发 `compactBeforeRound` 走
// `roundNumbersForMessages` → `groupIntoRounds` → `validateMessages`，而尾部正是「`assistant[tool_use]`
// 还没有 `tool_result`」（续写正在进行，结果这一轮还没到）⇒ **零 HTTP 之外的一次本地抛错**：
//
//   KitError code=invalid_messages
//   message=Invalid message at index 1: assistant tool_use has no immediately following user tool_result
//   stack: src/messages/rounds.js#messageError → validateMessages → groupIntoRounds
//          → roundNumbersForMessages (src/loop/orchestrator.js) → compactBeforeRound
//
// 定性（本单的结论，三类里落**第 3 类：其他**）：
//   · **不是**「压缩前没结清悬空 `tool_use`」（#393/#394 那条路在这里不适用）：这条调用不是
//     「永远不会执行」——续写完成后它照常执行，补一条 `[erix] This tool call was never executed`
//     是**假事实**；而且结清会把「截断的 assistant」与「续写内容」隔开（续写只能落进一条新的
//     assistant 消息），同一轮还会出现两个指向同一 id 的 `tool_result`。同一个判断见 #548 对
//     run-state 追加的处置（同一条路线、同一个形状、同样选「跳过而不是说谎」）。
//   · **不是**「`roundNumbersForMessages` 的严格校验把合法形状误判」：形状对**请求**合法（引擎自己以
//     `allowPendingToolUse: true` 发它），对**折叠**不合法——折掉一个没跑完的回合会把半截工具调用
//     写成摘要。校验器没错，错的是「在这一刻试图折叠」。
//   · 所以修法是**推迟这一发压缩**（尾部恢复成合法历史之后，下一轮开圈那次 `compactBeforeRound`
//     自然接手），并把推迟动作记进既有观察者通道（事件 `compaction_deferred`，纯加法）。
//
// 本文件钉五件事：
//   A. 校验器原判词（`invalid_messages` 的原文）——它是复现证据，也是「不能把这份形状交给折叠」的理由；
//   B. 修后：同一夹具不再以 `invalid_messages` 终止，终局形状与**不压缩的基线逐字相同**（推迟是惰性的）；
//   C. 推迟**可见**：`compaction_deferred` 事件带 `runId` / `round` / `reason` / `detail`；
//   D. 闸门**只认形状**：截断响应里没有 `tool_use` 时，续写轮里的压缩照旧执行（不是把这条路关掉）；
//   E. 推迟**不是取消**：续写补齐工具调用 ⇒ 工具真的执行，下一轮的压缩真的折叠（`compacted: true`）。
//
// 零真实 LLM（fake provider）、不写盘、不碰 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { pendingTrailingToolUses, validateMessages } from "../src/messages/rounds.js";

/** 首发响应被 `max_tokens` 截断、且 content 里挂着一条还没结果的 `tool_use`（复现所需的唯一前置）。 */
const truncatedToolUse = (id = "t1") => ({
  content: [{ type: "tool_use", id, name: "noop", input: {} }],
  stopReason: "max_tokens",
});

const textTurn = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

/** 极小预算 + `keepRounds: 0`：续写循环里那一发压缩**必然**进（`estimatedTokens > budgetTokens`）。 */
const tinyBudget = { folding: { context: { budgetTokens: 5, keepRounds: 0 } } };

/** 消息形状的逐条速写（只取 role 与块类型/id，用于「逐字对拍」）。 */
const shapeOf = (messages) => messages.map((message) => `${message.role}[${Array.isArray(message.content)
  ? message.content.map((block) => `${block?.type}${block?.id === undefined ? "" : `:${block.id}`}`).join(",")
  : "text"}]`).join(" | ");

const deferredEvents = (events) => events.filter((event) => event.type === "compaction_deferred");
const compactionEvents = (events) => events.filter((event) => event.type === "compaction");

// ── A. 复现证据：校验器对这份形状的原判词（一字不改地钉住） ───────────────────────────────────
// 这条断言是**报告里的错误原文**的机器版本：它同时说明「为什么不能把这份历史交给折叠」——
// `groupIntoRounds` 的第一步就是这份校验（三个内置策略各自也调它一次），所以拒绝点是确定的，
// 与 provider 无关（那一发请求根本没发出）。
test("#588 A 复现证据：尾部悬空 tool_use 的判词就是 invalid_messages（折叠链的第一步即拒绝）", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "做点事" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }] },
  ];
  assert.throws(
    () => validateMessages(messages),
    (error) => {
      assert.equal(error?.code, "invalid_messages");
      assert.equal(
        error?.message,
        "Invalid message at index 1: assistant tool_use has no immediately following user tool_result",
      );
      return true;
    },
    "严格档必须拒绝这份形状——本单的修法不是让它放行",
  );
  // 同一个形状在**请求**那一档是合法的（续写轮 `allowPendingToolUse: true`）：这就是「合法但不可折叠」。
  assert.doesNotThrow(() => validateMessages(messages, { allowPendingToolUse: true }));
});

// ── B. 修后：同一夹具不再以 invalid_messages 终止，且与「不压缩的基线」逐字相同 ─────────────────
test("#588 B 续写轮 + 尾部悬空 tool_use 撞上压缩 ⇒ run 正常收尾（不再 invalid_messages）", async () => {
  const provider = createFakeProvider([truncatedToolUse(), textTurn("done")]);
  const result = await runDirect({
    provider,
    seed: "做点事",
    maxRounds: 3,
    config: tinyBudget,
    executeTool: async () => "ok",
  });
  // 判据 1：不再以 `invalid_messages` 终止（这里连抛都没有，run 正常返回）。
  assert.deepEqual(result.termination, { reason: "end_turn" },
    `终局必须是 end_turn，实得 ${JSON.stringify(result.termination)}`);
  assert.equal(result.finalText, "done");
  // 续写那一发请求**真的发出去了**：崩溃点在「压缩」而不是「续写」，请求数就是证据。
  assert.equal(provider.requests.length, 2, "1 次首发 + 1 次续写（推迟的压缩没有把这一发吃掉）");
  // 终局形状：截断轮的 `tool_use` 仍在（它与「不压缩」的基线一致，本单不改这条既有形状）。
  assert.equal(pendingTrailingToolUses(result.messages).length, 1,
    "这条 tool_use 的处置不归本单：它照旧留在尾部（既有的 end_turn + tool_use 形状）");
});

test("#588 B2 对拍：同一 script 关掉压缩 ⇒ 终局、终稿、消息形状逐字相同（推迟是惰性的）", async () => {
  const run = async (config) => {
    const provider = createFakeProvider([truncatedToolUse(), textTurn("done")]);
    const result = await runDirect({
      provider,
      seed: "做点事",
      maxRounds: 3,
      ...(config === undefined ? {} : { config }),
      executeTool: async () => "ok",
    });
    return { result, requests: provider.requests.length };
  };
  const budgeted = await run(tinyBudget);
  const baseline = await run(undefined);
  assert.deepEqual(budgeted.result.termination, baseline.result.termination, "终局必须与不压缩基线相同");
  assert.equal(budgeted.result.finalText, baseline.result.finalText, "终稿必须相同");
  assert.equal(shapeOf(budgeted.result.messages), shapeOf(baseline.result.messages),
    "消息形状必须逐字相同（推迟不许改写历史）");
  assert.equal(budgeted.requests, baseline.requests, "请求数必须相同");
});

// ── C. 推迟必须可见（不许静默跳过） ─────────────────────────────────────────────────────────
test("#588 C 推迟动作进诊断：compaction_deferred 带 runId / round / reason / detail", async () => {
  const events = [];
  const provider = createFakeProvider([truncatedToolUse(), textTurn("done")]);
  await runDirect({
    provider,
    seed: "做点事",
    maxRounds: 3,
    runId: "s588-c",
    config: tinyBudget,
    // 观察者通道走**规位** `capabilities.hooks.onEvent`（与顶层 `onEvent` 同一个键的两种写法）：
    // 本文件因此不进清点表的主表（能力面写点 0），只由 `--sync` 补一行附表（`context`×1）。
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    executeTool: async () => "ok",
  });
  const deferred = deferredEvents(events);
  assert.equal(deferred.length, 1, `这一轮只该推迟一次，实测 ${deferred.length}`);
  assert.equal(deferred[0].runId, "s588-c", "诊断必须带 runId（宿主并行多 run 时可归因）");
  assert.equal(deferred[0].round, 1, "推迟发生在第 1 轮的续写循环里");
  assert.equal(deferred[0].reason, "pending_tool_use", "reason 必须点名形状（宿主可据此聚合）");
  assert.ok(
    typeof deferred[0].detail === "string" && deferred[0].detail.includes("tool_use"),
    "detail 必须说清「为什么这一发没压」",
  );
});

// ── D. 闸门只认形状：截断响应里没有 `tool_use` ⇒ 续写轮里的压缩照旧执行 ────────────────────────
// 反证的另一半：如果修法是把「续写轮里的压缩」整个关掉，这一格会红（`compaction` 只出现一次）。
test("#588 D 截断响应不带 tool_use ⇒ 续写轮里的压缩照旧执行（闸门只认形状，不关整条路）", async () => {
  const events = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "半截答案，被 max_tokens 截断在这里" }], stopReason: "max_tokens" },
    textTurn("done"),
  ]);
  const result = await runDirect({
    provider,
    seed: "做点事",
    maxRounds: 3,
    config: tinyBudget,
    // 观察者通道走**规位** `capabilities.hooks.onEvent`（与顶层 `onEvent` 同一个键的两种写法）：
    // 本文件因此不进清点表的主表（能力面写点 0），只由 `--sync` 补一行附表（`context`×1）。
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    executeTool: async () => "ok",
  });
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(deferredEvents(events).length, 0, "尾部没有悬空 tool_use ⇒ 一次都不许推迟");
  const compactions = compactionEvents(events);
  assert.equal(compactions.length, 2, `开圈一次 + 续写轮一次，实测 ${compactions.length}`);
  assert.equal(compactions[1].compaction.compacted, true,
    "续写轮那一发压缩必须真的折了东西（不是空转）");
});

// ── E. 推迟不是取消：续写补齐工具调用 ⇒ 工具执行，下一轮的压缩接手 ─────────────────────────────
test("#588 E 续写补齐工具调用 ⇒ 工具真的执行，下一轮的压缩真的折叠（推迟只是晚一轮）", async () => {
  const events = [];
  const executed = [];
  const provider = createFakeProvider([
    truncatedToolUse("t1"),
    { content: [{ type: "tool_use", id: "t2", name: "noop", input: {} }], stopReason: "tool_use" },
    textTurn("done"),
    textTurn("done"),
    textTurn("done"),
  ]);
  const result = await runDirect({
    provider,
    seed: "做点事",
    maxRounds: 6,
    config: tinyBudget,
    // 观察者通道走**规位** `capabilities.hooks.onEvent`（与顶层 `onEvent` 同一个键的两种写法）：
    // 本文件因此不进清点表的主表（能力面写点 0），只由 `--sync` 补一行附表（`context`×1）。
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    executeTool: async (call) => {
      executed.push(call?.name ?? "unknown");
      return "ok";
    },
  });
  assert.equal(executed.length, 2, `截断那条 + 续写那条都必须执行，实测 ${executed.length}`);
  assert.equal(deferredEvents(events).length, 1, "推迟只发生在第 1 轮（下一轮尾部已合法）");
  assert.equal(deferredEvents(events)[0].round, 1);
  const secondRound = compactionEvents(events).filter((event) => event.round === 2);
  assert.equal(secondRound.length, 1, "第 2 轮开圈必须有一次压缩");
  assert.equal(secondRound[0].compaction.compacted, true,
    "第 2 轮的压缩必须真的折叠了东西（推迟 ≠ 取消）");
  assert.ok(result.messages.every((message) => message.role !== undefined), "夹具自检：终局消息可用");
});
