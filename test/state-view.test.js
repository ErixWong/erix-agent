import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { makeStateView } from "../src/loop/state-view.js";

// issue #246 step 0 的反向证套件：这六条各自钉住 src/loop/state-view.js 的一条设计红线，
// 每条都必须能被对应的单点变异单独打红（变异清单见 REPORT-SV0.md 第 3 节）：
//   1 活引用 ← getter 退化成构造时快照
//   2 getOnly ← getOnly 也定义了 setter
//   3 自定义 setter 保身份 ← set 退化成整对象替换
//   4 计算 getter 每次重算 ← 计算 getter 改成构造时求值一次
//   5 字段面 ← 把整个 state 泄进视图（`{ ...state }` 作落地对象）
//   6 接线姿势（第一刀新增）← 把描述符搬家换成 `Object.assign` / 值快照

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

// 第一刀（#246）的真实接线姿势：`src/loop/orchestrator.js` 的 `runSnapshotContext` 不能整个换成视图
// （它还有几十个非状态成员与方法），所以视图是**挂**到既有 ctx 上的。挂法只有一种是对的：
// `Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(view))` —— 搬的是**描述符**，
// get/set 闭包原样过去，所以活引用不变。`Object.assign` / `{ ...view }` / `{ key: view.key }`
// 都会**调用** getter 把值拷下来（快照化），于是 ctx 上的读-改-写（`ctx.toolErrorCount += 1`）
// 只落在快照上、再也回不到 state。本条钉的就是这个姿势。
test("state-view 接线姿势：视图描述符搬到既有 ctx 上仍是活引用（不是值快照）", () => {
  const state = { count: 0 };
  const ctx = { other: "x" };
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(makeStateView(state, ["count"])));

  state.count = 1; // 整体替换：值快照化的写法会在这里读到 0
  assert.equal(ctx.count, 1, "描述符搬家丢掉了活引用（构造时把值拷下来了）");

  ctx.count += 1; // 与 run-snapshot-executor 的 `ctx.toolErrorCount += 1` 同形（读-改-写）
  assert.equal(state.count, 2, "经 ctx 的读-改-写没有落回 state（快照被改了，state 没动）");

  assert.equal(ctx.other, "x", "既有成员被视图搬家挤掉了");
  assert.deepEqual(Object.keys(ctx), ["other", "count"]);
});

// 第 1 步（`providerContext`）新增：**接线侧的字段清单本身就是白名单**，所以它自己要有一条判据。
// 为什么必须是静态读源码：`providerContext` 是 `runToolLoop` 的闭包局部变量，行为测试够不到它。
// 而本刀那七格里只有 `roundEventDeltas`（`[...ctx.roundEventDeltas]`）与 `usage`
//（`ctx.usage.input_tokens`）的缺失会当场崩；另外五格（`finalText` / `declaredFindings` /
// `roundStopReason` / `latestApi*`）在 `provider-runner` 里只被「写回原值」，漏一项**静默无声**
// ——探针实测：把这五格任一条从清单里拿掉，run 的 JSON 逐字节不变。所以「漏一项」的确定性靠这一格。
test("state-view 接线侧的字段清单：providerContext 的七格是显式白名单（漏一项 / 多一项都红）", () => {
  const source = readFileSync(new URL("../src/loop/orchestrator.js", import.meta.url), "utf8");
  const block = /Object\.defineProperties\(providerContext, Object\.getOwnPropertyDescriptors\(\n {4}makeStateView\(runLoopState, \[\n([\s\S]*?)\n {4}\]\),\n {2}\)\);/u
    .exec(source);
  assert.ok(
    block,
    "orchestrator.js 里找不到 providerContext 的 makeStateView 接线点（接线点改名 / 搬家时这条判据要同步）",
  );
  const keys = [...block[1].matchAll(/"([A-Za-z]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(keys, [
    "roundEventDeltas",
    "finalText",
    "declaredFindings",
    "usage",
    "latestApiInputTokens",
    "latestApiEstimatedTokens",
    "roundStopReason",
  ], "providerContext 的白名单变了：要么是漏了一项（该字段在 ctx 上变 undefined），要么是新加的格子没写进判据");
});
