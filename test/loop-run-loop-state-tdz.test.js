"use strict";

// 为什么存在：F-2 把两枚治理开关的**初值**留在原声明位置赋值，是因为它们的初值表达式读的
// `:1227` `const reflectionEnabled` / `:1263` 的 `const wrapupEnabled` / `:1222` 的
// `const effectiveReflection` 全在状态对象字面量（`:673`–`:833`）**之后** —— 把初值提进字面量是
// 同步 TDZ `ReferenceError`，不是「取值一致所以不可观察」（这一点与 D / F-1 四格相反）。
// 而「占位 `false` 有没有被覆盖」在关闭配置下**行为上是等价的**（两边都是 `false`），
// 纯行为用例抓不到「占位写错」或「覆盖行被删」，所以本文件除了行为侧一条，另加一条**源码时序断言**：
//   · 字面量里的两格必须是占位 `false`（不能写成 `true`，也不能提前写成真值表达式）；
//   · 真值赋值必须在被读 const 的**下一行之后**（提先 = TDZ）且在两处读点**之前**（晚了 = 首读拿占位）。
// 变异实测：删掉覆盖行 → 本文件红；把占位改成 `true` → 本文件红；把初值表达式提进字面量 →
// `ReferenceError: Cannot access 'reflectionEnabled' before its initialization`（由人工跑一次记录）。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const ON_TRACK = {
  done: true,
  confidence: 0.9,
  reason: "已完成",
  evidence: "验证通过",
  direction: "on_track",
  directionReason: "已接近验证",
};

const textEndTurn = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const judgeJson = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], stopReason: "end_turn" });
const isRoundJudgeRequest = (request) => request.temperature === 0 && request.maxTokens === 1024;

test("F-2 时序（行为侧）：真值赋值早于首读点，开着的配置第一次 end_turn 就走 judge", async () => {
  const judge = createFakeProvider([judgeJson(ON_TRACK)]);
  const provider = createFakeProvider([textEndTurn("最终答案")]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 4,
    completion: false,
    reflection: { enabled: true, roundJudge: true, judgeIntercept: false, judge: { provider: judge } },
  });
  assert.equal(judge.requests.filter(isRoundJudgeRequest).length, 1, "初值必须是被覆盖后的真值，而不是字面量里的占位 false");
  assert.equal(result.termination.reason, "judge_done");
});

test("F-2 时序（源码侧）：两格初值是占位，真值赋值既不能提进字面量也不能拖到读点之后", () => {
  const source = fs.readFileSync(new URL("../src/loop/orchestrator.js", import.meta.url), "utf8");
  const lineOf = (needle, { required = true } = {}) => {
    const index = source.split("\n").findIndex((line) => line.includes(needle));
    if (required) assert.ok(index >= 0, `源码里找不到锚点：${needle}`);
    return index;
  };

  // ① 字面量里的两格是占位 false（真值表达式不能出现在这里）。
  const cellRoundJudge = lineOf("roundJudgeEnabled: false,");
  const cellWrapup = lineOf("wrapupNormalizationEnabled: false,");
  assert.ok(!source.includes("roundJudgeEnabled: reflectionEnabled"), "初值表达式被提进字面量 ⇒ TDZ");
  assert.ok(!source.includes("wrapupNormalizationEnabled: wrapupEnabled"), "初值表达式被提进字面量 ⇒ TDZ");

  // ② 真值赋值在两个被读的 const **之后**（早于它们就是同步 TDZ 抛错）。
  const declareReflection = lineOf("const reflectionEnabled = ");
  const declareWrapup = lineOf("const wrapupEnabled = ");
  const assignRoundJudge = lineOf("runLoopState.roundJudgeEnabled = reflectionEnabled");
  const assignWrapup = lineOf("runLoopState.wrapupNormalizationEnabled = wrapupEnabled");
  assert.ok(assignRoundJudge > cellRoundJudge && assignRoundJudge > declareReflection,
    "roundJudgeEnabled 的真值赋值必须留在 reflectionEnabled 声明之后（占位 + 原位赋真值）");
  assert.ok(assignWrapup > cellWrapup && assignWrapup > declareWrapup,
    "wrapupNormalizationEnabled 的真值赋值必须留在 wrapupEnabled 声明之后（占位 + 原位赋真值）");

  // ③ 真值赋值在两处全文件首读点**之前**（晚了首读拿到的就是占位）。
  // 锚点只取**前缀**：issue #282 在这条首读点上追加了 `&& !signal?.aborted`（已中止就不发起 judge），
  // 逐字比整行会让这条 TDZ 门把「加了中止守卫」误报成「时序被动过」；前缀足够定位唯一首读点。
  const readRoundJudge = lineOf("if (runLoopState.roundJudgeEnabled && isEndTurn");
  const readWrapup = lineOf("&& runLoopState.wrapupNormalizationEnabled");
  assert.ok(assignRoundJudge < readRoundJudge, "真值赋值不能晚于 roundJudgeEnabled 的读点");
  assert.ok(assignWrapup < readWrapup, "真值赋值不能晚于 wrapupNormalizationEnabled 的读点");
});
