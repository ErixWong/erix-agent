import assert from "node:assert/strict";
import test from "node:test";

import { makeStateView } from "../src/loop/state-view.js";

// issue #246 step 0 的反向证套件：这五条各自钉住 src/loop/state-view.js 的一条设计红线，
// 每条都必须能被对应的单点变异单独打红（变异清单见 REPORT-SV0.md 第 3 节）：
//   1 活引用 ← getter 退化成构造时快照
//   2 getOnly ← getOnly 也定义了 setter
//   3 自定义 setter 保身份 ← set 退化成整对象替换
//   4 计算 getter 每次重算 ← 计算 getter 改成构造时求值一次
//   5 字段面 ← 把整个 state 泄进视图（`{ ...state }` 作落地对象）

test("state-view 活引用：视图构造后整体替换 state 字段读得到，反向写也落得到 state", () => {
  const state = { x: ["v1"], other: 0 };
  const view = makeStateView(state, ["x"]);

  const v2 = ["v2"];
  state.x = v2; // 整体替换（不是改内容）：构造时快照化的实现会在这里读到 v1
  assert.equal(view.x, v2);

  const v3 = ["v3"];
  view.x = v3; // 反向：经视图写必须落到同一个 state 对象
  assert.equal(state.x, v3);
  assert.equal(state.other, 0); // state 本身没被换成副本
});

test("state-view getOnly：返回的数组内容可改（不冻结），整体赋值抛 TypeError", () => {
  const state = { list: [1] };
  const view = makeStateView(state, [{ key: "list", getOnly: true }]);

  view.list.push(2); // getOnly 只拦「整体赋值」，不得冻结返回的数组
  assert.deepEqual(state.list, [1, 2]);
  assert.deepEqual(view.list, [1, 2]);

  assert.throws(
    () => {
      view.list = [9];
    },
    TypeError,
    "getOnly 字段被赋了值却没抛 TypeError（说明 setter 被定义了）",
  );
});

test("state-view 自定义 setter 保数组身份：赋值前后是同一个数组对象", () => {
  const state = { rows: ["old"] };
  const identityBefore = state.rows;
  const view = makeStateView(state, [
    {
      key: "rows",
      set: (value) => {
        state.rows.splice(0, state.rows.length, ...value); // 原地换内容，保身份
      },
    },
  ]);

  view.rows = ["a", "b"];
  assert.equal(state.rows, identityBefore, "自定义 setter 换掉了数组引用，身份没保住");
  assert.deepEqual(state.rows, ["a", "b"]);
  assert.equal(state.rows, view.rows, "视图读到的必须就是那个原数组");
});

test("state-view 计算 getter 每次重算：依赖字段变了，两次读的结果必须不同", () => {
  const state = { a: 1, b: 2 };
  const view = makeStateView(state, ["a", { key: "sum", get: () => state.a + state.b }]);

  const first = view.sum;
  state.a = 10; // 改依赖字段（经视图改也一样：view.a = 10）
  const second = view.sum;

  assert.equal(first, 3);
  assert.equal(second, 12);
  assert.notEqual(second, first, "计算 getter 只在构造时求值了一次");
});

test("state-view 字段面（接线前置不变量）：Object.keys(view) 只含清单里的字段", () => {
  const state = { listed: 1, unlisted: 2, alsoListed: 3 };
  const view = makeStateView(state, ["listed", { key: "alsoListed", getOnly: true }]);

  assert.deepEqual(Object.keys(view), ["listed", "alsoListed"]);
  assert.equal("unlisted" in view, false);
});
