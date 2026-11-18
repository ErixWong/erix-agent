import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeRoundRunStateInject } from "../src/loop/round-run-state-inject.js";

// issue #872 验收（阻断修复）：`mergeRoundRunStateInject` 纯函数格。
// 断言的是「同一轮内多次注入观测如何合并」，与注入行为本身无关（注入判据仍在 orchestrator 决策点）。

test("mergeRoundRunStateInject：prev=undefined ⇒ 返回 next 并记 injections=1", () => {
  const a = { lowBudget: true, request: true, persist: false, remainingRounds: 5 };
  const merged = mergeRoundRunStateInject(undefined, a);
  assert.deepEqual(merged, {
    lowBudget: true,
    request: true,
    persist: false,
    remainingRounds: 5,
    injections: 1,
  });
});

test("mergeRoundRunStateInject：A+B（B 多开一条通道）⇒ 三键 OR 且 injections=2", () => {
  // 第一次只走通道 B（request），第二次续写走通道 A（persist）：本轮两条通道都用过 ⇒ 并集都 true。
  const first = mergeRoundRunStateInject(undefined, {
    lowBudget: false,
    request: true,
    persist: false,
    remainingRounds: 4,
  });
  const second = mergeRoundRunStateInject(first, {
    lowBudget: false,
    request: false,
    persist: true,
    remainingRounds: 4,
  });
  assert.deepEqual(second, {
    lowBudget: false,
    request: true,
    persist: true,
    remainingRounds: 4,
    injections: 2,
  });
  // 明确：合并的是「本轮用过的并集」，不是「最后一次」——B 的那次没被覆盖掉。
  assert.equal(second.request, true, "第一次的 request 必须保留（并集，不是覆盖）");
  assert.equal(second.persist, true, "第二次的 persist 必须并入");
});

test("mergeRoundRunStateInject：两次同通道 ⇒ injections=2 且布尔不变", () => {
  const first = mergeRoundRunStateInject(undefined, {
    lowBudget: true,
    request: true,
    persist: false,
    remainingRounds: 3,
  });
  const second = mergeRoundRunStateInject(first, {
    lowBudget: true,
    request: true,
    persist: false,
    remainingRounds: 3,
  });
  assert.deepEqual(second, {
    lowBudget: true,
    request: true,
    persist: false,
    remainingRounds: 3,
    injections: 2,
  });
});

test("mergeRoundRunStateInject：三次同轮 ⇒ injections 累加、OR 只增不减", () => {
  let acc = mergeRoundRunStateInject(undefined, { lowBudget: false, request: true, persist: false, remainingRounds: 2 });
  acc = mergeRoundRunStateInject(acc, { lowBudget: false, request: false, persist: true, remainingRounds: 2 });
  acc = mergeRoundRunStateInject(acc, { lowBudget: true, request: false, persist: false, remainingRounds: 2 });
  assert.equal(acc.injections, 3, "未来同轮注入更多次也对");
  assert.deepEqual(
    { lowBudget: acc.lowBudget, request: acc.request, persist: acc.persist },
    { lowBudget: true, request: true, persist: true },
    "三键是历次 OR，只增不减",
  );
});

test("mergeRoundRunStateInject：两侧都 undefined 的调用被断言挡下", () => {
  assert.throws(() => mergeRoundRunStateInject(undefined, undefined), /同时 undefined/);
});
