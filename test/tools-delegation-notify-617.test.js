// issue #617（P1a）——派生完成通知去重与归属（`src/tools/delegation/notify.js`）守门测试。
//
// 覆盖（工单清单）：
//   6. 通知：`(runId, endedAt)` 二元组语义（**同 runId 不同 endedAt 必须判为未消费**）；
//      collected 后不再通知；`interrupted` 仍通知。
//   3. 通知文本：固定前缀（导出的常量，钉死在代码里不进提示词）+ 点名 runId /
//      parentRunId（有则带）/ state / endedAt；opaque 字段不展开。
//
// 纯函数 + 宿主持有的 Set：零落盘、零进程、零网络；不需要临时目录。
import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTIFICATION_PREFIX,
  completionMarkerKey,
  isCollected,
  markCollected,
  notificationText,
  shouldNotify,
} from "../src/tools/delegation/notify.js";

test("notify: 完成标记点名 (runId, endedAt) 二元组", () => {
  const a = { runId: "r1", state: "completed", endedAt: 100 };
  const b = { runId: "r1", state: "completed", endedAt: 200 };
  assert.notEqual(completionMarkerKey(a), completionMarkerKey(b), "同 runId 不同 endedAt 是两个完成事件");
  assert.notEqual(completionMarkerKey(a), completionMarkerKey({ runId: "r2", state: "completed", endedAt: 100 }));
});

test("notify: 同 runId 不同 endedAt 必须判为未消费（resume 复用 runId 的场景）", () => {
  const collected = new Set();
  // 第一次跑完、父取走。
  markCollected(collected, { runId: "r1", state: "completed", endedAt: 100 });
  assert.equal(isCollected(collected, { runId: "r1", state: "completed", endedAt: 100 }), true);
  // 同一个 runId 续跑后再完成：endedAt 变了 ⇒ 是新的完成事件，不得误判已消费。
  assert.equal(isCollected(collected, { runId: "r1", state: "completed", endedAt: 200 }), false);
  // 消费第二次完成后，第一次的标记仍在（二元组互不覆盖）。
  markCollected(collected, { runId: "r1", state: "completed", endedAt: 200 });
  assert.equal(isCollected(collected, { runId: "r1", state: "completed", endedAt: 100 }), true);
  assert.equal(collected.size, 2);
});

test("notify: collected 后不再唤醒；未 collected 才唤醒", () => {
  const collected = new Set();
  const record = { runId: "r1", state: "completed", endedAt: 100 };
  assert.equal(shouldNotify(record, { collected }), true);
  markCollected(collected, record);
  assert.equal(shouldNotify(record, { collected }), false);
});

test("notify: interrupted 必须仍然通知（子凭空消失正是父最需要知道的）", () => {
  const collected = new Set();
  const interrupted = { runId: "r1", state: "interrupted", endedAt: 50 };
  assert.equal(shouldNotify(interrupted, { collected }), true);
  markCollected(collected, { runId: "r1", state: "interrupted", endedAt: 50 });
  assert.equal(shouldNotify(interrupted, { collected }), false, "同一次事件被自取过之后自然不再通知");
  // 但换一个 endedAt（比如重算后被再次点名）又是新事件。
  assert.equal(shouldNotify({ runId: "r1", state: "interrupted", endedAt: 60 }, { collected }), true);
});

test("notify: 通知文本带固定前缀（常量本身被钉死）", () => {
  assert.equal(NOTIFICATION_PREFIX, "【子run完成】");
  const text = notificationText({ runId: "r1", parentRunId: "p1", state: "interrupted", endedAt: 50 });
  assert.ok(text.startsWith(`${NOTIFICATION_PREFIX} `), "前缀必须在文本最前，父侧可靠可 grep");
  assert.ok(text.includes("runId=r1"));
  assert.ok(text.includes("parentRunId=p1"));
  assert.ok(text.includes("state=interrupted"));
  assert.ok(text.includes("endedAt=50"));
  assert.ok(!text.includes("\n"), "一行式：任何字段值里的换行都必须被压平");
});

test("notify: parentRunId 缺省不带该段", () => {
  const text = notificationText({ runId: "r1", state: "completed", endedAt: 50 });
  assert.ok(!text.includes("parentRunId"), "不给的字段不编造");
});

test("notify: opaque 字段（termination/verification）不展开进文本", () => {
  const text = notificationText({
    runId: "r1",
    state: "failed",
    endedAt: 50,
    termination: { reason: "max_rounds", payload: { secret: "x".repeat(200) } },
    verification: { status: "unverified" },
  });
  assert.ok(!text.includes("max_rounds"), "opaque 内容只体现为状态名，不展开");
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("unverified"));
});

test("notify: 缺 runId / 缺 collected 的防御", () => {
  assert.throws(() => completionMarkerKey({}), /runId/u);
  assert.throws(() => markCollected(new Map(), { runId: "r1" }), /Set/u);
  assert.throws(() => isCollected([], { runId: "r1" }), /Set/u);
  assert.throws(() => notificationText({ state: "completed" }), /runId/u);
});
