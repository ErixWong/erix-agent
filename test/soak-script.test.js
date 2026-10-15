// 覆盖 scripts/soak.mjs 的**假上游**路径（工单 261015 T6-a / issue #257 T6）。
//
// 定位：这条用例就是工单里的「便宜判据」——假上游、不联网、一次真模型都不打，
// 验的是 soak 脚本自身的三条不变量：
//   1) 退出码 0（阻断性断言全绿）；
//   2) `--out` 落的是合法 JSON，且字段面齐全（assertions/usage/rounds/compactions/
//      abortObservedReason/resume/storeReconcile）；
//   3) 三方对账与契约事实断言**真的跑过**（不是空跑：轮数、落盘行数、key 计数都非 0）。
// 引擎缺陷（soak 只报不修）不在本用例的失败面里：非阻断观察项（pass=false / blocking=false）
// 不参与退出码，本用例也只断言 failedBlocking。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOAK = path.join("scripts", "soak.mjs");

function runSoak(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOAK, ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("soak 假上游：退出码 0 + 报告是合法 JSON + 不变量非空跑", async () => {
  const dir = await makeTmp("soak-fake-");
  const reportPath = path.join(dir, "report.json");
  const { code, stdout, stderr } = await runSoak([
    "--provider", "fake",
    "--rounds", "4",
    "--store", dir,
    "--out", reportPath,
    "--abort-at", "2",
    "--compact-every", "2",
  ]);
  assert.equal(code, 0, `soak 退出码必须 0；stderr=${stderr.slice(0, 500)}`);

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.provider, "fake");
  assert.equal(report.rounds, 4, stdout.slice(-400));
  assert.ok(Array.isArray(report.assertions) && report.assertions.length >= 15);
  for (const assertion of report.assertions) {
    assert.equal(typeof assertion.name, "string");
    assert.equal(typeof assertion.pass, "boolean");
    assert.notEqual(assertion.evidence, undefined, `${assertion.name} 必须带证据值`);
  }
  assert.equal(report.totals.failedBlocking, 0,
    `阻断性断言必须全绿：${JSON.stringify(
      report.assertions.filter((a) => !a.pass && a.blocking).map((a) => a.name),
    )}`);

  // 字段面：工单点名的每一项都要在
  for (const key of [
    "usage", "rounds", "compactions", "abortObservedReason", "resume", "storeReconcile",
    "assertions", "engineDefects",
  ]) {
    assert.ok(key in report, `报告缺少字段 ${key}`);
  }
  assert.ok(report.usage.input_tokens > 0 && report.usage.output_tokens > 0);
  assert.ok(report.compactions.compactionStats.length > 0, "强制压缩必须真的进过统计");
  assert.equal(report.abortObservedReason, "aborted", "abort 终局 reason 必须可观察（#282 数据源）");
  assert.equal(report.abort.partial, true);
  assert.ok(report.resume && report.resume.ok === true, JSON.stringify(report.resume));

  // 三方对账：落盘行数 == store.load() 记录数；轮事件数 == 引擎轮记录数；且都非 0
  const reconcile = report.storeReconcile;
  assert.ok(reconcile.jsonlLines > 0);
  assert.equal(reconcile.jsonlLines, reconcile.loadedRoundRecords);
  assert.equal(reconcile.roundEndEvents, reconcile.recordKinds.engineRounds);
  assert.ok(reconcile.toolResultEvents > 0);

  // 契约事实：key 唯一性/投影对账要有真实计数
  assert.ok(report.contract.toolUseBlocks > 0);
  assert.equal(report.contract.diskKeys, report.contract.projectionKeys);
});

test("soak CLI：非法 --provider 直接非 0 退出并给出可懂的拒绝", async () => {
  const { code, stderr } = await runSoak(["--provider", "definitely-not-a-provider"]);
  assert.notEqual(code, 0);
  assert.match(stderr + "", /--provider/);
});
