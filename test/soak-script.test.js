// 覆盖 scripts/soak.mjs 的**假上游**路径（工单 261015 T6 / #290 返工 261015-t6fix）。
//
// 定位：这条用例就是工单里的「便宜判据」——假上游、不联网、一次真模型都不打，验的是 soak 脚本
// 自身的不变量：
//   1) 退出码 0，且**每一条断言都 pass===true**（返工第 7 条：以前只断言 failedBlocking，
//      于是「非阻断失败」能一路混过去）；
//   2) 断言**数量与名单逐条相等**（清单是实现的契约，加一条不登记就红，防止静默减项）；
//   3) 三方对账 / 契约事实 / TTL 折叠 / 请求视图配对**真的跑过**（证据值非 0，不是空跑）；
//      三方对账的口径在工单 261021 写侧（「一条消息一成型就落盘」）之后重述过一遍：
//      旧 = 「jsonl 行数 == store.load() 记录数」（一轮一行），新 = 「jsonl 行数 == load() 记录数
//      + 被折进载体行的消息行数」，另加「独立复刻的折叠正文 == store.load() 摊平的正文」逐条相等。
//   4) --store/--out 不许落在真实 ~/.erix 下（红线），默认清理自建的临时 store；
//   5) abort 阶段**真的中止过**（工单 261015-02 小修：旧版把「没发生的中止」报成 #282 真机复现，
//      因为非抛分支不带 abortedAtRound、evidence 又用 `?? cli.abortAt` 兑底）。
// 轮数取 6：更少就压不出 TTL 折叠（引擎 TTL 层要求剩余轮数 > 2，src/compact/pipeline.js:21-27），
// 而「压不出 TTL」正是本脚本存在的理由，所以这里必须给够，短跑会红（那是牙齿，不是抖动）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOAK = path.join("scripts", "soak.mjs");

// 实现里的断言清单（顺序即报告顺序）。**加/删断言必须同时改这里**——这是有意的摩擦：
// soak 的覆盖面是它唯一的产出物，悄悄少一条 = 悄悄少一块回归面。
const EXPECTED_ASSERTIONS = [
  "long-replay-completes",
  "forced-compaction-observed",
  "store-reconcile-jsonl-vs-load",
  "store-reconcile-event-stream",
  "ttl-fold-actually-applied",
  "contract-tool-result-erix-core-fields",
  "contract-execution-status-special-states-only",
  "contract-ordinary-results-omit-execution-status",
  "contract-no-retired-top-level-names",
  "contract-toolcallkey-unique",
  "contract-projection-keysets-bidirectionally-equal",
  "contract-projection-durationms-equals-disk",
  "contract-projection-missing-duration-not-zero",
  "abort-actually-fired",
  "abort-termination-reason-is-aborted",
  "abort-error-carries-usage-rounds-partial",
  "resume-run-succeeds",
  "resume-history-bytes-unchanged",
  "resume-new-toolcallkeys-disjoint-from-history",
  "resume-special-state-facts-not-read-as-success",
  "pairing-request-views-pass-strict-validation",
  "pairing-no-orphan-or-dangling-in-request-views",
  // issue #336：转换器 ok 以前只写在 pairing 那条的 evidence 里（注释说「转换坏也是红」，其实没人判）
  "request-view-protocol-conversion-survives",
  "no-unexpected-unhandled-rejection",
  "unknown-run-tool-loop-option-rejected",
  // 0.20.0（PR #291 R7）之后常量已登记存在条件，这条从「无条件报缺欠」改成活锁断言，跑在最后
  "contract-constant-records-execution-status-presence",
];

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

test("soak 假上游：退出码 0 + 每条断言都过 + 断言名单逐条相等", async () => {
  const dir = await makeTmp("soak-fake-");
  const reportPath = path.join(dir, "report.json");
  const { code, stdout, stderr } = await runSoak([
    "--provider", "fake",
    "--rounds", "6",
    "--store", dir,
    "--out", reportPath,
    "--abort-at", "3",
    "--compact-every", "2",
  ]);
  assert.equal(code, 0, `soak 退出码必须 0；stderr=${stderr.slice(0, 500)}`);

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.provider, "fake");
  assert.equal(report.rounds, 6, stdout.slice(-400));
  assert.ok(Array.isArray(report.assertions), "assertions 必须是数组");

  // (2) 数量与名单**逐条**相等（不是 >=）
  assert.deepEqual(report.assertionManifest, EXPECTED_ASSERTIONS);
  assert.equal(report.assertions.length, EXPECTED_ASSERTIONS.length);

  // (1) 每一条都过：pass===true 且 blocking===true（不许有「非阻断失败」混过去）
  for (const assertion of report.assertions) {
    assert.equal(typeof assertion.name, "string");
    assert.equal(typeof assertion.pass, "boolean");
    assert.notEqual(assertion.evidence, undefined, `${assertion.name} 必须带证据值`);
    assert.equal(assertion.pass, true,
      `${assertion.name} 必须 pass=true，evidence=${JSON.stringify(assertion.evidence).slice(0, 400)}`);
    assert.equal(assertion.blocking, true,
      `${assertion.name} 必须是阻断性断言：fake 路径下没有理由留非阻断观察项`);
  }
  assert.equal(report.totals.failedBlocking, 0);
  assert.equal(report.totals.observedNonBlocking, 0, JSON.stringify(
    report.assertions.filter((a) => !a.pass).map((a) => a.name),
  ));

  // 字段面：工单点名的每一项都要在
  for (const key of [
    "usage", "rounds", "compactions", "abortObservedReason", "abortStage", "abortTrigger", "resume",
    "storeReconcile", "assertions", "engineDefects", "ttl", "requestViews", "assertionManifest", "storeCleanup",
  ]) {
    assert.ok(key in report, `报告缺少字段 ${key}`);
  }
  assert.ok(report.usage.input_tokens > 0 && report.usage.output_tokens > 0);
  assert.ok(report.compactions.compactionStats.length > 0, "强制压缩必须真的进过统计");

  // (3) TTL 折叠不是空跑：引擎 TTL 层与请求视图**两路证据都要有数**
  assert.ok(report.ttl.option === 1, "toolResultTtl 必须是数字（引擎要数字，对象会被原样退回）");
  assert.ok(report.ttl.engineLayerEvents > 0, "引擎必须报出 TTL 层折叠事件");
  assert.ok(report.ttl.engineFoldedResults > 0, "引擎必须真的折过至少一条结果");
  assert.ok(report.requestViews.captured > 0, "必须抓到实际发给上游的请求视图");
  assert.ok(report.requestViews.distinctFoldedResults > 0,
    "实际请求视图里必须能看到被折叠的 tool_result（否则等于没压到 TTL）");
  assert.ok(report.requestViews.tokensBefore > report.requestViews.tokensAfter,
    "折叠必须真的省下 token（前后无变化 = 折叠是假的）");

  // (3) 配对断言喂的是请求视图，且违规计数为 0
  assert.equal(report.requestViews.validationErrors, 0);
  assert.equal(report.requestViews.orphanResults, 0);
  assert.equal(report.requestViews.danglingUses, 0);

  // abort / resume
  assert.equal(report.abortObservedReason, "aborted", "abort 终局 reason 必须可观察（#282 数据源）");
  assert.equal(report.abort.partial, true);
  assert.ok(report.resume && report.resume.ok === true, JSON.stringify(report.resume));

  // (5) abort 阶段必须**真的触发过**：旧版非抛分支不带 abortedAtRound，evidence 又用 `?? cli.abortAt`
  // 兑底，于是真机第 7 轮就 judge_done 收口（根本没中止）的 run 被报成「第 100 轮中止 + #282 复现」。
  assert.equal(report.abortStage.abortFired, true,
    `abort 必须真的触发过，evidence=${JSON.stringify(report.abortStage)}`);
  assert.equal(report.abortStage.abortedAtRound, 3, "显式 --abort-at 3 ⇒ 第 3 轮触发");
  assert.equal(report.abortStage.coverage, "abort-fired");
  assert.equal(report.abortStage.naturalTermination, null, "触发过时 naturalTermination 不得拿中止终局冒充自然终局");
  assert.equal(report.abortTrigger.mode, "round", "显式 --abort-at 保留轮数语义（--help 就是这么写的）");
  const abortFiredAssertion = report.assertions.find((a) => a.name === "abort-actually-fired");
  assert.ok(abortFiredAssertion, "缺少阻断断言 abort-actually-fired");
  assert.equal(abortFiredAssertion.blocking, true, "没触发就是脚本配置问题，必须是阻断项");
  for (const name of ["abort-termination-reason-is-aborted", "abort-error-carries-usage-rounds-partial"]) {
    const assertion = report.assertions.find((a) => a.name === name);
    assert.equal(assertion.evidence.coverage, "abort-fired",
      `${name} 在真的中止过时才判，coverage 必须是 abort-fired`);
  }
  assert.equal(
    report.assertions.find((a) => a.name === "abort-termination-reason-is-aborted").evidence.issue282Rewritten,
    false,
    "本路径观察到的是 aborted，不得把 #282 报成命中",
  );

  // 三方对账（工单 261021 写侧「一条消息一成型就落盘」之后按**新口径**重述）：
  //   旧口径（改造前，一轮一行）：`jsonlLines === loadedRoundRecords`（一轮一条 RoundRecord）。
  //   新口径（一条消息一行 + 轮行只留元数据）：`jsonlLines === loadedRoundRecords + absorbedMessageRows`——
  //     `absorbedMessageRows` 是本用例从**原始 jsonl 行**独立复算的「被读侧折进载体行的消息行数」
  //     （口径见 soak.mjs 里的 foldLedgerFromRawRows，不是 store 自己报的数）。
  //   等式仍然两端都要核：少一行（落盘丢行 / 折叠吞了行）与多一行（同一份正文存两遍）都红。
  //   另钉三条防「空跑」：消息行必须真的写了、必须真的被折回去了、独立复刻与 store.load() 的正文逐条相等。
  const reconcile = report.storeReconcile;
  assert.ok(reconcile.jsonlLines > 0);
  assert.ok(reconcile.messageRows > 0, "0 条消息行 = 写侧的逐条落盘没生效，本用例的口径就是空的");
  assert.ok(reconcile.absorbedMessageRows > 0, "一条消息行都没被折回轮行 = 读侧折叠没跑（宿主面会多出游离行）");
  assert.equal(reconcile.jsonlLines, reconcile.loadedRoundRecords + reconcile.absorbedMessageRows);
  assert.equal(reconcile.standaloneMessageRows, 0, "主 run 不崩 ⇒ 每条消息行都该找到自己的载体行");
  assert.equal(reconcile.foldMismatches.length, 0, JSON.stringify(reconcile.foldMismatches));
  assert.equal(reconcile.independentlyFoldedMessages, reconcile.ledgerMessages);
  assert.equal(reconcile.roundEndEvents, reconcile.recordKinds.engineRounds);
  assert.ok(reconcile.toolResultEvents > 0);

  // 契约事实：key 唯一性/投影对账要有真实计数
  assert.ok(report.contract.toolUseBlocks > 0);
  assert.equal(report.contract.diskKeys, report.contract.projectionKeys);
});

test("soak abort：没真的触发时必须红，且不得把 #282 报成命中（旧版假阳性的回归面）", async () => {
  // `--abort-at 9` 在 `--rounds 6` 的显式轮数触发下根本踩不到（旧版会静默当成「跳过」）。
  // 它就是今天真机那份报告的形状：**没发生的中止**。
  const dir = await makeTmp("soak-miss-");
  const reportPath = path.join(dir, "miss-report.json");
  const { code } = await runSoak([
    "--provider", "fake", "--rounds", "6", "--abort-at", "9", "--compact-every", "2",
    "--out", reportPath,
  ]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));

  assert.notEqual(code, 0, "没触发 = 脚本配置问题，必须非 0 退出");
  assert.equal(report.totals.failedBlocking, 1,
    JSON.stringify(report.assertions.filter((a) => !a.pass).map((a) => `${a.name}:blocking=${a.blocking}`)));
  const byName = Object.fromEntries(report.assertions.map((a) => [a.name, a]));

  assert.equal(byName["abort-actually-fired"].pass, false);
  assert.equal(byName["abort-actually-fired"].blocking, true, "没触发不能让引擎背锅");
  assert.equal(report.abortStage.abortFired, false);
  assert.equal(report.abortStage.abortedAtRound, null, "不得拿 --abort-at 的值兑底成「第 n 轮中止」");
  assert.equal(report.abortStage.coverage, "not-exercised");
  assert.equal(report.abortStage.naturalTermination, "max_rounds_cap", "没触发时这才是自然终局");

  // 两条引擎断言：未触发 → 不算引擎缺陷，但也不是「通过」，而是计入非阻断观察（沿用阶段 F 的 coverage 口径）
  for (const name of ["abort-termination-reason-is-aborted", "abort-error-carries-usage-rounds-partial"]) {
    assert.equal(byName[name].pass, false, `${name} 未触发不得算绿`);
    assert.equal(byName[name].blocking, false, `${name} 未触发不能当阻断项（红由 abort-actually-fired 承担）`);
    assert.equal(byName[name].evidence.coverage, "not-exercised");
  }
  assert.equal(byName["abort-termination-reason-is-aborted"].evidence.issue282Rewritten, false,
    "#282 结论需要 abort 真触发才成立");
  assert.equal(report.totals.observedNonBlocking, 2);
});

test("soak abort：缺省触发点按已落地的 tool_result 事件计数（真机跑不了的路径）", async () => {
  const dir = await makeTmp("soak-default-trigger-");
  const reportPath = path.join(dir, "default-trigger.json");
  const { code } = await runSoak([
    "--provider", "fake", "--rounds", "6", "--compact-every", "2", "--out", reportPath,
  ]);
  assert.equal(code, 0, "缺省事件触发必须真的中止成");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.abortTrigger.mode, "tool_result");
  assert.equal(report.abortTrigger.at, 3, "缺省触发点 = min(ceil(rounds/2), 3)");
  assert.equal(report.abortStage.abortFired, true);
  assert.equal(report.abortStage.abortedAtRound, 3, "第 3 个 tool_result 落在第 3 轮");
  assert.equal(report.abortObservedReason, "aborted");
});

test("soak CLI：非法 --provider 直接非 0 退出并给出可懂的拒绝", async () => {
  const { code, stderr } = await runSoak(["--provider", "definitely-not-a-provider"]);
  assert.notEqual(code, 0);
  assert.match(stderr + "", /--provider/);
});

test("soak CLI：--store / --out 落在真实 ~/.erix 下必须干净拒绝（红线）", async () => {
  const erixHome = path.resolve(os.homedir(), ".erix");
  const storeRun = await runSoak([
    "--provider", "fake", "--rounds", "2",
    "--store", path.join(erixHome, "soak-should-not-be-written"),
    "--out", path.join(await makeTmp("soak-erix-"), "report.json"),
  ]);
  assert.equal(storeRun.code, 2, `--store 命中真实 ~/.erix 必须 exit 2；stderr=${storeRun.stderr.slice(0, 400)}`);
  assert.match(storeRun.stderr, /\.erix/);
  assert.match(storeRun.stderr, /--store/);
  assert.equal(existsSync(path.join(erixHome, "soak-should-not-be-written")), false,
    "拒绝必须发生在任何写入之前（不能先建目录再报错）");

  const outRun = await runSoak([
    "--provider", "fake", "--rounds", "2",
    "--out", path.join(erixHome, "soak-should-not-be-written", "report.json"),
  ]);
  assert.equal(outRun.code, 2, `--out 命中真实 ~/.erix 必须 exit 2；stderr=${outRun.stderr.slice(0, 400)}`);
  assert.match(outRun.stderr, /--out/);
});

test("soak CLI：默认清理自建的临时 store，--keep-store 才保留", async () => {
  const dir = await makeTmp("soak-cleanup-");
  const cleaned = await runSoak([
    "--provider", "fake", "--rounds", "6", "--abort-at", "3", "--compact-every", "2",
    "--out", path.join(dir, "cleaned-report.json"),
  ]);
  assert.equal(cleaned.code, 0, cleaned.stderr.slice(0, 400));
  const cleanedReport = JSON.parse(await readFile(path.join(dir, "cleaned-report.json"), "utf8"));
  assert.equal(cleanedReport.storeCleanup.usedTempStore, true);
  assert.equal(cleanedReport.storeCleanup.removed, true, "默认必须真清理（帮助文案就是这么写的）");
  assert.equal(existsSync(cleanedReport.storeCleanup.dir), false,
    `临时 store 必须已被删除：${cleanedReport.storeCleanup.dir}`);

  const kept = await runSoak([
    "--provider", "fake", "--rounds", "6", "--abort-at", "3", "--compact-every", "2",
    "--keep-store",
    "--out", path.join(dir, "keep-store-report.json"),
  ]);
  assert.equal(kept.code, 0, kept.stderr.slice(0, 400));
  const keptReport = JSON.parse(await readFile(path.join(dir, "keep-store-report.json"), "utf8"));
  assert.equal(keptReport.storeCleanup.removed, false, "--keep-store 必须保留");
  assert.equal(existsSync(keptReport.storeCleanup.dir), true,
    `--keep-store 的目录必须还在：${keptReport.storeCleanup.dir}`);
});
