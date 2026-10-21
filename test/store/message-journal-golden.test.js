// 工单 261021 第一刀：金样对撞——「改造前后宿主 `store.load()` 读到的形状逐字一致」。
//
// 夹具（test/fixtures/message-journal-golden.json）**必须**由改造前的基线代码
// （scripts/message-journal-golden.mjs 里的 BASELINE_COMMIT = 2ca60bc）生成：
// 只有拿「基线的输出」当期望值，改后代码的折叠层才是被外部对照检验的。若夹具是拿改后代码
// `--write` 出来的，那就是自己证明自己 ⇒ 下面的 fixtureHasMessageRows 守卫会红。
import test from "node:test";
import assert from "node:assert/strict";

import {
  BASELINE_COMMIT,
  capture,
  diffLines,
  fixtureHasMessageRows,
  readFixture,
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
