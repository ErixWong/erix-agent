// issue #394：`forceFinalIfNeeded` 在**注入之前**没有结清尾部悬空的 `tool_use`。
//
// 主张（上一轮执行体提的，本轮复现成立）：
//   `src/loop/termination.js#forceFinalIfNeeded` 的顺序是
//     ① `ctx.messages.push({role:"user", meta:{source:"judge-control"}, content:[【强制收尾】…]})`
//     ② `validateMessages(ctx.messages, { allowPendingToolUse: true })`
//   而 `allowPendingToolUse` 容忍的**唯一**形状是「末条 assistant 的 `tool_use` 之后什么都没有」
//   （`src/messages/rounds.js#validateMessages`：`index === messages.length - 1 && next === undefined`）。
//   一旦①先插进一条 user 文本，那条 assistant 就有了 `next`（且没有 `tool_result`）⇒ ②必然抛
//   `invalid_messages: assistant tool_use has no immediately following user tool_result`。
//
// 复现所需的**前置条件**只有一条：调用 `forceFinalIfNeeded` 时 `ctx.messages` 末条是
// `assistant[tool_use]`（尾部悬空）。谁能造出这个形状，见文件末尾「形状清单」那段注释——
// 本文件把最小形状钉住，并给出两组反证（同形状关掉强制收尾 ⇒ 不抛；尾部已结清 ⇒ 不抛）。
//
// ⚠ 本文件的前 3 格在 #394 之前钉的是**修复前的行为**（reject `invalid_messages`）；修法落地时按
//   工单给的目标值翻了过来（`#394` R4）：`continuation_exhausted` + `forcedFinal: true`、请求数
//   2 / 5、尾部 `pendingTrailingToolUses === 0`、`finalText === "收尾"`。它们今天绿着才有意义——
//   红了就说明收尾注入前又没人问过尾部（结清动作被拿掉/被绕过）。第 4-5 格是两条反证，一字未动：
//   关掉强制收尾 ⇒ 尾部仍悬空；尾部本来就已结清 ⇒ 收尾照旧注入。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { pendingTrailingToolUses } from "../src/messages/rounds.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

/** `stopReason: "max_tokens"` + `tool_use` 块：两个协议都真会吐这个形状（见文件末尾清单 ①）。 */
const truncatedToolUse = (id, { text = undefined } = {}) => ({
  content: [
    ...(text === undefined ? [] : [{ type: "text", text }]),
    { type: "tool_use", id, name: "noop", input: {} },
  ],
  stopReason: "max_tokens",
});

const settleWith = (id) => ({
  content: [{ type: "tool_use", id, name: "noop", input: {} }],
  stopReason: "tool_use",
});

const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

/** #394 之后这三格的共同断言：结清 + 收尾都真的发生了（而不是被吞成 failed / 静默降级）。 */
const assertSettledForcedFinal = (result, expectedRequests, provider) => {
  assert.deepEqual(result.termination, { reason: "continuation_exhausted", forcedFinal: true },
    `终局必须是「续写用尽 + 强制收尾」，实得 ${JSON.stringify(result.termination)}`);
  // 没挂 finalGuard ⇒ 核验面与 #394 之前**逐字一致**（修复不改核验语义，只补一条 tool_result）。
  assert.equal(result.verification.status, "skipped");
  assert.equal(result.verification.reason, "no_final_guard");
  assert.equal(result.finalText, "收尾", "终稿必须落到结果里（修复前这一步是丢的）");
  assert.equal(pendingTrailingToolUses(result.messages).length, 0,
    "收尾注入前尾部已结清：结清之后再没有悬空 tool_use");
  assert.equal(provider.requests.length, expectedRequests,
    `请求数必须是 ${expectedRequests}（1 次首发${expectedRequests === 5 ? " + 3 次续写" : ""} + 1 次强制收尾）`);
};

// ── 1（最小形状）：一次响应就够 —— `maxTokenContinuations: 0` ⇒ 立刻 continuation_exhausted ──────
// 为什么这条是「最小」：续写预算为 0 ⇒ 首个响应直接判定用尽，provider 只被调用 **1 次**，
// 于是「崩溃点在收尾注入」这件事可以被请求次数直接证明（不是续写、不是压缩、不是 guard）。
test("#394 R1-1 默认关（不传 finalGuard / finalGuardExtend）：continuation_exhausted + 尾部悬空 tool_use ⇒ 结清后正常收尾（2 次请求）", async () => {
  const provider = createFakeProvider([
    truncatedToolUse("t1"),
    text("收尾"),
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 3,
    maxTokenContinuations: 0,
    executeTool: async () => "ok",
  });
  assertSettledForcedFinal(result, 2, provider);
});

// ── 2（真实形状）：截断的响应里同时有正文与半截工具调用 ────────────────────────────────────
// 真上游最常见的截断形态就是「先说了一句 + 工具参数被截断」（OpenAI `finish_reason:"length"` 带
// `tool_calls`；Anthropic `stop_reason:"max_tokens"` 带 `tool_use`）。正文的存在不影响结论：
// `hasFinalDraft()` 要求 `roundStopReason === "end_turn"`，截断轮永远进不去，收尾照样注入。
test("#394 R1-2 截断轮带正文 + 悬空 tool_use ⇒ 同样结清后收尾（正文不构成终稿，收尾仍会注入）", async () => {
  const provider = createFakeProvider([
    truncatedToolUse("t1", { text: "我先看一眼目录结构，然后" }),
    text("收尾"),
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 3,
    maxTokenContinuations: 0,
    executeTool: async () => "ok",
  });
  assertSettledForcedFinal(result, 2, provider);
  // 截断轮那句正文还在历史里（它没被吞掉，只是不构成终稿）。
  assert.ok(
    result.messages.some((message) => Array.isArray(message.content)
      && message.content.some((block) => block?.type === "text"
        && block.text === "我先看一眼目录结构，然后")),
    "截断轮已经吐出来的正文必须留在历史里",
  );
});

// ── 3（默认续写预算）：`maxTokenContinuations` 用默认 3 ⇒ 续写全截断后同样落在悬空尾部 ─────────
// 续写是把新块**追加进同一条 assistant**（`appendAssistantContent`），所以三轮续写之后尾部仍是
// 一条 `assistant[tool_use]`，仍然没有任何 `tool_result`（工具执行分支的门是
// `response.stopReason === "tool_use"`，截断轮进不去）。
test("#394 R1-3 默认续写预算（3）全截断 ⇒ 同样结清后收尾（5 次请求：1 + 3 续写 + 1 收尾）", async () => {
  const provider = createFakeProvider([
    truncatedToolUse("t1"),
    truncatedToolUse("t2"),
    truncatedToolUse("t3"),
    truncatedToolUse("t4"),
    text("收尾"),
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 3,
    executeTool: async () => "ok",
  });
  assertSettledForcedFinal(result, 5, provider);
});

// ── 4（反证 A）：同一个脚本，只把强制收尾关掉 ⇒ 不抛，终局是 continuation_exhausted ─────────────
// 这条是「谁才是触发器」的判据：悬空尾部**本身**不抛（`runToolLoop` 正常返回），抛的是收尾注入。
// 它同时钉住 reason 真的是 `continuation_exhausted`（不是 max_rounds_cap / stall）。
test("#394 R1-4 反证：同形状 + ERIX_NO_FORCED_FINAL=1 ⇒ 不注入 ⇒ 正常返回 continuation_exhausted，尾部仍悬空", async () => {
  const provider = createFakeProvider([truncatedToolUse("t1"), text("收尾")]);
  const previous = process.env.ERIX_NO_FORCED_FINAL;
  process.env.ERIX_NO_FORCED_FINAL = "1";
  let result;
  try {
    result = await runToolLoop({
      provider,
      initialUserMessage: "做点事",
      maxRounds: 3,
      maxTokenContinuations: 0,
      executeTool: async () => "ok",
    });
  } finally {
    if (previous === undefined) delete process.env.ERIX_NO_FORCED_FINAL;
    else process.env.ERIX_NO_FORCED_FINAL = previous;
  }
  assert.equal(result.termination.reason, "continuation_exhausted");
  assert.equal(result.termination.forcedFinal, undefined, "关掉之后不该有强制收尾");
  assert.equal(pendingTrailingToolUses(result.messages).length, 1,
    "尾部确实是悬空 tool_use：与第 1 格唯一的差别就是「有没有注入收尾指令」");
});

// ── 5（反证 B）：尾部已结清（`stopReason:"tool_use"` ⇒ 工具真跑过 ⇒ 有 tool_result）⇒ 不抛 ──────
// 同一套收尾路径（`max_rounds_cap` + 注入 + 终稿），只有尾部形状不同：结果是 `forcedFinal:true`。
// 这两条反证合起来把「悬空尾部 + 注入」钉成充分条件，而不是把 `continuation_exhausted` 一棍子打死。
test("#394 R1-5 反证：尾部已结清（工具真跑过）⇒ 收尾正常注入，终局 max_rounds_cap + forcedFinal", async () => {
  const provider = createFakeProvider([settleWith("t1"), text("收尾")]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 1,
    executeTool: async () => "ok",
  });
  assert.deepEqual(result.termination, { reason: "max_rounds_cap", forcedFinal: true });
  assert.equal(pendingTrailingToolUses(result.messages).length, 0);
  assert.equal(result.messages.at(-1)?.role, "assistant", "末条是收尾终稿，不是 tool_result");
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// 形状清单（#394 R1 第 1 问的答案，逐条都读自代码；`stall` 与出圈那一处都不在里面）：
//
// ① 截断轮（**唯一的常规生产路径**）：`response.stopReason === "max_tokens"` 且 content 里有
//    `tool_use` 块。工具执行分支的门是 `src/loop/orchestrator.js` 主循环里的
//    `if (response?.stopReason === "tool_use")` ⇒ 截断轮**不进**工具执行 ⇒ 没有 `user[tool_result]`
//    追加，尾部就停在 `assistant[tool_use]`。两个协议都会吐这个形状：
//    `src/messages/openai-normalization.js#normalizeOpenAIStopReason`（`length → max_tokens`，
//    `tool_calls → tool_use` 可以同时成立）、`src/messages/anthropic.js`（`stopReason` 直接取
//    `json.stop_reason`，Anthropic 原生的 `max_tokens` 就带被截断的 `tool_use.input`——
//    连截断参数都有专门的处理：`parseOpenAIToolArguments` 的 `_truncatedArguments` 回落）。
//    之后 `continuationExhausted === true` ⇒ `src/reflection/governor.js#decideRoundAction` 首条判据
//    返回 `{kind:"stop", value:"cap"}` ⇒ `src/loop/termination.js#terminationReasonForAction` 因
//    `continuationExhausted` 返回 `continuation_exhausted` ⇒ 进 `forceFinalIfNeeded` ⇒ 崩。
//
// ② `stopReason === "end_turn"` 但 content 带 `tool_use`（`isEndTurn` 那条注释里点名的非标准边界）。
//    同样不进工具执行 ⇒ 尾部悬空；但 reason 落到 `end_turn` ⇒ `forceFinalIfNeeded` 直接早退
//    ⇒ **不崩**（run 正常返回 `end_turn`，尾部留一条悬空 `tool_use`）。它在**下一处**注入上爆：
//    stop 分支里 finalGuard 判 `revise` 的那条 `messages.push(continuationMessage)` 之后，下一次
//    `src/loop/provider-runner.js#callProvider` 以 `allowPendingToolUse:false` 校验 ⇒
//    `invalid_messages`（实测同一句理由，栈在 `provider-runner.js` 而不是 `termination.js`）。
//    这是 #394 的**兄弟洞**，已并入本刀（R3：同一条共享结清动作），正面断言在
//    `test/loop-pending-tool-result.test.js`。
//
// ③ `stall`：**造不出悬空尾部**。`stallSuspicion` 只在 `stopReason === "tool_use"` 那个分支里
//    （遍历 tool_use 块时）被置位，而那条路径一定会 `messages.push({role:"user", content:toolResults})`
//    ⇒ 尾部必然是 `user[tool_result]`。所以 `stall` 那一档今天不可能撞到本 bug。
//
// ④ 出圈那一处 `forceFinalAndJournal("max_rounds_cap")`（`while (budgetRounds < effectiveMaxRounds)`
//    之后）：只能从 `action.kind === "continue"` 掉出来。三条 continue 路径分别是
//    nudge（push user 文本）、extend（`applyGovernorExtension` 里**已经**先调
//    `answerPendingTailToolUses`）、`{kind:"continue"}`（尾部是工具结果或纯文本）⇒ 都不带悬空尾部。
//    真正带悬空尾部的 `continuation_exhausted` / `end_turn+tool_use` 都在圈内就 stop 了，
//    走的是 `action.kind === "stop"` 那一处（第 1-3 格的栈就落在那里）。
//
// ⑤ 强制收尾**那一次**请求确实传 `tools: []`（`src/loop/termination.js#forceFinalIfNeeded` 的
//    `request.tools = []`），所以「收尾那一轮模型又回了 tool_use」不是本 bug 的来源——那一轮
//    产出的 assistant 消息排在注入之后，它的 `tool_use` 悬空属于**另一个**形状（收尾之后没人再
//    发请求，故今天不报错，只是终稿里留了一条悬空块）。本 bug 的来源是**注入之前**的那条。
// ────────────────────────────────────────────────────────────────────────────────────────────
