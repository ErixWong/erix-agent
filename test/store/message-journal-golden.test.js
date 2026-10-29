// 工单 261021 第一刀：金样对撞——「改造前后宿主 `store.load()` 读到的形状逐字一致」。
//
// 夹具（test/fixtures/message-journal-golden.json）**必须**由改造前的基线代码
// （scripts/message-journal-golden.mjs 里的 BASELINE_COMMIT = 2ca60bc）生成：
// 只有拿「基线的输出」当期望值，改后代码的折叠层才是被外部对照检验的。若夹具是拿改后代码
// `--write` 出来的，那就是自己证明自己 ⇒ 下面的 fixtureHasMessageRows 守卫会红。
//
// ⚠ **产出基点（issue #608 起）**：夹具**不再逐字等于 2ca60bc 的输出**——issue #608 给 run-state
// 加了模型可见的 `last=` 一格（`deterministic.lastToolCall` + 渲染行），那是**有意**的格式变更，
// 而基线代码不可能产出它。所以夹具按下面的**机械重放**更新了一次，其余字段仍是 2ca60bc 的产出：
//   · 只改两条路径：每条记录上的 `runState.deterministic.lastToolCall` 与 `runState.rendered`
//     （state.json 那一行同理）；
//   · 取值来源 = 引擎**自己**：`scripts/message-journal-golden.mjs` 的 `capture()`（当前代码跑同一批
//     场景）里同名两条路径，逐条拷贝 —— 不手写 JSON、不猜值；
//   · 因此 diff 可核对：`git diff test/fixtures/message-journal-golden.json` 只有
//     `lastToolCall` / `rendered` 两种行（10 条记录 × 2 处），零其它差异。
// 这条自述是**如实**的：夹具里除那两条路径外的一切仍是基线产出，`fixtureHasMessageRows` 守卫
// 也仍然成立（重放没有掺进 `kind:"message"` 行）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  BASELINE_COMMIT,
  additiveUsageCensus,
  capture,
  diffLines,
  fixtureHasMessageRows,
  readFixture,
  resumeNoticeCensus,
} from "../../scripts/message-journal-golden.mjs";

const committed = await readFixture();
const captured = await capture();

test(`261021 golden: 夹具出自基线 ${BASELINE_COMMIT}（改造前的代码），不是改后代码自证`, () => {
  assert.equal(fixtureHasMessageRows(committed), false,
    "夹具里出现了 kind:\"message\" 行 ⇒ 它是折叠层落地后生成的，请在基线提交上重新 --write");
  assert.equal(committed.generator, "scripts/message-journal-golden.mjs");
  assert.deepEqual(committed.scenarios.map((s) => s.name), ["single-run", "crash-resume"]);
});

test("261021 golden: 两个场景的 store.load() 全量行、模型可见正文序列与终局元数据，与基线夹具逐字一致", () => {
  const differences = diffLines(committed, captured, "$");
  assert.deepEqual(differences.slice(0, 20), [], `与基线夹具存在 ${String(differences.length)} 处差异`);
});

// issue #404：金样是「折叠层逐字一致」的对照，而恢复告示是基线代码**不可能产出**的新事实
// （`2ca60bc` 上没有这条注入）⇒ 捕获侧把它逐条剥掉。这条断言把**豁免面**钉住：
// 只有 crash-resume 那一格允许出现告示，而且**恰好两条**（账本那条 `:control:` 行 + 那次请求里的
// 那条消息）。多一条 = 豁免在替别的漂移打掩护；少一条 = 槽位名/正文标记变了，豁免已失效。
test("261021 golden: 恢复告示的豁免面恰是「crash-resume 的 1 行 + 1 条请求消息」（issue #404）", () => {
  assert.deepEqual(resumeNoticeCensus, [
    { name: "single-run", stripped: 0 },
    { name: "crash-resume", stripped: 2 },
  ]);
});

// issue #438：`record.usage` / `record.engineUsage` 是基线不可能产出的新增事实 ⇒ 捕获侧剥掉。
//
// 这条断言钉的是**逐条明细**，不是总数：只钉总数时，把 `engineUsage` 从 round 2 挪到 round 3
// 总数一模一样（评审实测：照样绿），而「哪个键属于哪一轮」正是本单的分账契约要保证的东西。
// 明细同时钉住三件事——哪些轮带了键（少一条 = 某个键没写）、每轮带了哪几个（多/少一个 = 豁免在
// 替别的漂移打掩护）、以及**归属**（同一组键换一轮就红）。数值本身由
// `test/loop-usage-accounting.test.js` 钉。
//
// 实测口径：带引擎开销的是 **5 条**轮记录（single-run 的 round 2/4/5 + crash-resume 的 round 2/5），
// 其余轮各 1 个 `usage`；合计 8 个键（single-run 5 条轮 × `usage` + 3 个 `engineUsage`）与
// 7 个键（crash-resume 5 × `usage` + 2 个 `engineUsage`）。上一版标题写的「带引擎开销的 4 条」是
// 自述与实现不符（评审点名），本版按实测改成逐条明细。
test("261021 golden: 新增分账键的豁免面逐条钉住「哪一轮剥了哪几个键」（issue #438）", () => {
  assert.deepEqual(additiveUsageCensus, [
    {
      name: "single-run",
      detail: [
        { round: 1, keys: ["usage"] },
        { round: 2, keys: ["usage", "engineUsage"] },
        { round: 3, keys: ["usage"] },
        { round: 4, keys: ["usage", "engineUsage"] },
        { round: 5, keys: ["usage", "engineUsage"] },
      ],
    },
    {
      name: "crash-resume",
      detail: [
        { round: 1, keys: ["usage"] },
        { round: 2, keys: ["usage", "engineUsage"] },
        { round: 3, keys: ["usage"] },
        { round: 4, keys: ["usage"] },
        { round: 5, keys: ["usage", "engineUsage"] },
      ],
    },
  ]);
});

test("261021 golden: 夹具本身是无消息行的老账本形状 ⇒ 折叠层对它是零改写（透传口径的实证）", () => {
  for (const scenario of captured.scenarios) {
    const baseline = committed.scenarios.find((s) => s.name === scenario.name);
    assert.ok(baseline !== undefined);
    assert.ok(baseline.records.length > 0 && baseline.messagesFlat.length > 0);
    for (const record of baseline.records) assert.notEqual(record.kind, "message");
    // 改后代码读出来的行数与正文条数一字不差（折叠层没有多塞/少塞任何行）。
    assert.equal(scenario.records.length, baseline.records.length, scenario.name);
    assert.equal(scenario.messagesFlat.length, baseline.messagesFlat.length, scenario.name);
  }
});
