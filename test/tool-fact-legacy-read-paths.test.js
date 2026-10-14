// 退役顶层键的**读路径**（工单 261014 T2 §2）。
//
// 停写之后，引擎写出的 `tool_result` 只有 `erix.*` / `metadata.*`；顶层旧名（`erixRound` /
// `duration` / `executionStatus` / `success`）只剩「升级前落盘的记录里可能仍有」这一个身份。
// 于是每一处**读**这些名字的地方都必须改成「`erix` 优先、顶层只作旧记录回退」，否则会
// 静默失效（不报错、只是判据永远不成立）。
//
// 工单 §2 只列了三处读路径（TTL 折叠 / 投影 / 续跑复放）。本仓实测**另有四处**同样读这批
// 旧名，同一刀里一起改了，本文件把这四处逐个钉住（前两例是反向锁：只带 `erix` 的块必须
// 仍然被认出来；后面是「旧记录一代内仍可读」的正证）：
//   · `src/loop/aggregate-budget.js` —— 「拦截结果不计入本轮聚合预算」的判据；
//   · `src/reflection/judge.js`      —— judge 时间线里的 `intercepted` / `error` 状态与
//                                       「控制事件（该工具调用未执行）」那个标签；
//   · `src/reflection/l0.js`         —— L0 客观事实的 `exitOk` 与错误计数；
//   · `src/loop/messages.js`         —— `hasSuccessfulToolResult`（wrapup/收尾判据）。
// TTL 与投影那两处的反向锁在 `test/tool-result-ttl.test.js` 与 `test/display/projection.test.js`。

import test from "node:test";
import assert from "node:assert/strict";

import { createRoundAggregateGate, estimateInlineCost } from "../src/loop/aggregate-budget.js";
import { hasSuccessfulToolResult } from "../src/loop/messages.js";
import { buildTimeline } from "../src/reflection/judge.js";
import { extractL0Facts } from "../src/reflection/l0.js";

/** 一条工具调用 + 一条结果（结果块的形状由参数决定，其余字段与引擎写出的形状一致）。 */
function conversation(resultBlock) {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "npm test" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "body", ...resultBlock }] },
  ];
}

// ── 1. 聚合预算：拦截结果不计入 ───────────────────────────────────────────────
// 读错方向的后果不是报错，而是**多归档**：被拦截的控制文案（从未执行、不是输出）被算进
// 本轮预算，把本该内联的真结果挤成 stub。
test("聚合预算：拦截结果只带 erix.executionStatus 时同样不计入本轮内联量", () => {
  const interceptOnly = { content: "【审计拦截】方向可能偏".repeat(40), erix: { executionStatus: "intercepted" } };
  const legacyOnly = { content: "【审计拦截】方向可能偏".repeat(40), executionStatus: "intercepted" };
  const gateOf = (result) => createRoundAggregateGate({
    budgetTokens: 53337,           // → 16001 token 的聚合预算
    archivedOutputs: [],
    listRoundResults: () => [result],
  });
  const withErix = gateOf(interceptOnly).evaluate({ round: 1, toolUseId: "next", content: "x" });
  const withLegacy = gateOf(legacyOnly).evaluate({ round: 1, toolUseId: "next", content: "x" });
  assert.equal(withErix.inlineTokens, 0,
    `只带 erix.executionStatus 的拦截结果必须被排除（实测 ${withErix.inlineTokens}）`);
  assert.equal(withLegacy.inlineTokens, 0, "升级前落盘的顶层旧键仍要认得（一代内可读）");
  // 对照组：真结果（没有 executionStatus）确实计入，否则上面那个 0 是假绿。
  const real = gateOf({ content: interceptOnly.content, erix: { round: 1, success: true } })
    .evaluate({ round: 1, toolUseId: "next", content: "x" });
  assert.equal(real.inlineTokens, estimateInlineCost(interceptOnly.content));
});

test("聚合预算：全部 stub 化的终止态判定也读 erix（拦截条目不得被当成还能替换的）", () => {
  // 闸门自己不认识「刚刚归档过谁」——那是从归档通道与本轮已落定的结果里派生的（见 gate 的注释），
  // 所以本例把现场摆成「一条被拦截、一条刚刚被 stub 化」的样子：唯一还能替换的条目已经没了。
  const big = "巨".repeat(60000);
  const gate = createRoundAggregateGate({
    budgetTokens: 53337,
    archivedOutputs: [{ round: 1, toolUseId: "b", name: "exec", content: big }],
    listRoundResults: () => [
      { type: "tool_result", tool_use_id: "a", content: "【审计拦截】方向可能偏", erix: { executionStatus: "intercepted" } },
      { type: "tool_result", tool_use_id: "b", content: "[stub]", erix: { round: 1, success: true } },
    ],
  });
  const decision = gate.evaluate({ round: 1, toolUseId: "b", content: big });
  assert.equal(decision.action, "stub_kept", "已 stub 化的条目不得被反复替换");
  assert.equal(decision.terminal, true,
    "另一条只有 erix.executionStatus 时也要认定「全部已处置」= 终止态（读错方向就永远不终止）");
});

// ── 2. judge 时间线：intercepted / error 状态 ─────────────────────────────────
test("judge 时间线：只带 erix 的块仍然标成 intercepted / error", () => {
  // 注意 roundStart：buildTimeline 的第二参是**消息切片起点**，传 1 会把那条 tool_use 切掉。
  const statuses = (resultBlock) => buildTimeline(conversation(resultBlock)).toolCalls
    .map((call) => call.status);
  assert.deepEqual(statuses({ erix: { executionStatus: "intercepted" } }), ["intercepted"]);
  assert.deepEqual(statuses({ erix: { success: false }, is_error: true }), ["error"]);
  assert.deepEqual(statuses({ erix: { success: true } }), ["ok"]);
  // 旧记录（顶层旧名）仍然认得。
  assert.deepEqual(statuses({ executionStatus: "intercepted" }), ["intercepted"]);
  assert.deepEqual(statuses({ is_error: true }), ["error"]);
});

test("judge 渲染对话时，拦截条目仍然标成「控制事件」而不是普通工具结果", async () => {
  // 那条标签住在 `renderConversation`（src/reflection/judge.js 的正文展开），不是 buildJudgePrompt。
  const { renderConversation } = await import("../src/reflection/judge.js");
  const rendered = (resultBlock) => renderConversation([
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "exec", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "方向可能偏", ...resultBlock }] },
  ]);
  assert.match(rendered({ erix: { executionStatus: "intercepted" } }),
    /控制事件（该工具调用未执行）/u, "只带 erix 的拦截条目被当成了普通工具结果");
  assert.match(rendered({ executionStatus: "intercepted" }),
    /控制事件（该工具调用未执行）/u, "升级前的顶层旧键同样要认得");
  assert.doesNotMatch(rendered({ erix: { success: true } }), /控制事件/u);
});

// ── 3. L0 客观事实：exitOk 与错误计数 ────────────────────────────────────────
test("L0 事实：erix.success:false 仍然算失败（exitOk=false + 错误条目）", () => {
  const fromErix = extractL0Facts(conversation({ erix: { success: false } }));
  assert.equal(fromErix.exitOk, false, "只带 erix.success 的失败不得被读成成功");
  assert.ok(typeof fromErix.errorHash === "string" && fromErix.errorHash.length > 0,
    "失败要进错误计数（errorHash/errorTexts），否则 judge 看不到重复失败");
  // 旧记录（只有顶层 success:false、没有 is_error）本来就是那种「只有 success」的形状。
  const fromLegacy = extractL0Facts(conversation({ success: false }));
  assert.equal(fromLegacy.exitOk, false);
  // 对照：成功形状仍然 exitOk=true（防止把判据改成恒 false 糊过去）。
  assert.equal(extractL0Facts(conversation({ erix: { success: true } })).exitOk, true);
});

// ── 4. wrapup 判据：hasSuccessfulToolResult ──────────────────────────────────
test("hasSuccessfulToolResult：读 erix.success，顶层旧键只作旧记录回退", () => {
  assert.equal(hasSuccessfulToolResult(conversation({ erix: { success: true } })), true);
  assert.equal(hasSuccessfulToolResult(conversation({ erix: { success: false } })), false,
    "只带 erix.success:false 的块不得再被当成成功");
  assert.equal(hasSuccessfulToolResult(conversation({ success: false })), false, "旧记录同样认得");
  assert.equal(hasSuccessfulToolResult(conversation({ is_error: true })), false);
});
