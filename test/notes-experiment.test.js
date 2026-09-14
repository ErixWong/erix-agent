import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  aggregate,
  appendBatch,
  ARMS,
  classify,
  inspectRun,
  parseArgs,
  parseFinal,
  parseStats,
  reportMarkdown,
  roundRobinOrder,
} from "../scripts/notes-experiment.mjs";
import {
  estimateHistoricalUsage,
  formatCostPreview,
  formatUsageSummary,
  isQuotaOrAuthError,
  resolveExperimentModel,
  runFailFast,
  summarizeUsage,
  validateCostPlan,
} from "../scripts/experiment-guardrails.mjs";
import { createFakeProvider } from "./helpers/fake-provider.js";

async function withProjectTemp(callback) {
  const directory = await mkdtemp(path.join(process.cwd(), ".test-notes-experiment-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("matrix defaults to A/B/C without assuming a model", () => {
  assert.deepEqual(ARMS, ["A", "B", "C"]);
  assert.equal(parseArgs([]).model, undefined);
  assert.equal(parseArgs([]).runs, 30);
  assert.equal(parseArgs(["--model", "configured-model"]).runs, 30);
  assert.equal(parseArgs(["--model", "configured-model", "--runs", "7"]).runs, 7);
  assert.equal(parseArgs(["--max-calls", "9", "--yes"]).maxCalls, 9);
  assert.equal(parseArgs(["--max-calls", "9", "--yes"]).yes, true);
  assert.throws(() => parseArgs(["--concurrency", "4"]), /maximum 3/u);
});

test("experiment model precedence is explicit model, environment, then config", () => {
  const config = { slots: { default: { model: "config-model" } } };
  assert.deepEqual(resolveExperimentModel({
    explicitModel: "cli-model",
    environment: { ERIX_EXPERIMENT_MODEL: "env-model" },
    config,
  }), { model: "cli-model", source: "--model" });
  assert.deepEqual(resolveExperimentModel({
    environment: { ERIX_EXPERIMENT_MODEL: "env-model" },
    config,
  }), { model: "env-model", source: "ERIX_EXPERIMENT_MODEL" });
  assert.deepEqual(resolveExperimentModel({
    environment: {},
    config,
  }), { model: "config-model", source: "slots.default.model" });
  assert.throws(
    () => resolveExperimentModel({ environment: {}, config: {} }),
    /slots\.default\.model.*--model.*ERIX_EXPERIMENT_MODEL/u,
  );
});

test("cost gate rejects over-budget plans and dry-runs without confirmation", () => {
  assert.throws(
    () => validateCostPlan({ plannedCalls: 41, maxCalls: 40, confirmed: true }),
    /--max-calls 40/u,
  );
  assert.deepEqual(
    validateCostPlan({ plannedCalls: 3, maxCalls: 40, confirmed: false }),
    { dryRun: true },
  );
  assert.match(formatCostPreview({
    model: "fake-model",
    modelSource: "--model",
    plannedCalls: 3,
    armCount: 3,
    runs: 1,
    modelCount: 1,
    maxCalls: 40,
    estimate: estimateHistoricalUsage({
      aggregate: [{
        averages: { inputTokens: 10, outputTokens: 5, wallTimeMs: 1000 },
      }],
    }, { plannedCalls: 3 }),
  }), /尚未发起模型调用.*计划调用数：3.*dry-run/us);
});

test("provider authentication failure stops the remaining jobs", async () => {
  const provider = createFakeProvider([
    { throw: new Error("401 not supported for current token") },
    { content: [{ type: "text", text: "must not run" }] },
  ]);
  const outcome = await runFailFast(
    [{ id: 1 }, { id: 2 }],
    async () => {
      try {
        await provider.chat({ messages: [] });
        return { failed: false };
      } catch (error) {
        return { failed: true, error: error.message };
      }
    },
  );
  assert.equal(provider.calls.length, 1);
  assert.equal(outcome.results.length, 1);
  assert.match(outcome.failure.message, /401 not supported/u);
  assert.equal(isQuotaOrAuthError("403 quota exceeded"), true);
});

test("usage summary counts calls and token totals", () => {
  assert.deepEqual(summarizeUsage([
    { failed: false, inputTokens: 10, outputTokens: 2 },
    { failed: true, usage: { input_tokens: 3, output_tokens: 1 } },
  ]), {
    totalCalls: 2,
    successful: 1,
    failed: 1,
    inputTokens: 13,
    outputTokens: 3,
  });
  assert.match(formatUsageSummary([
    { failed: false, inputTokens: 10, outputTokens: 2 },
  ]), /实际消耗汇总.*总调用数：1.*input tokens：10.*output tokens：2/us);
});

test("classify preserves legacy categories and treats final-only values as invented", () => {
  assert.deepEqual(
    classify("一次性密钥=FAKE-FINAL-VALUE", ["REAL-TOOL-VALUE"], []),
    { category: "invented", answer: "FAKE-FINAL-VALUE" },
  );
  assert.equal(classify("一次性密钥=first", [], ["first", "rerun"]).category, "hit_first");
  assert.equal(
    classify("一次性密钥=rerun", ["first"], ["first", "rerun"]).category,
    "rerun_impersonation",
  );
});

test("parseFinal and parseStats read final guard metrics and usage", () => {
  const stdout = [
    "=== 终稿（已核验） ===",
    "ok",
    "=== 统计 === model=fake-model rounds=9 termination=end_turn "
      + 'usage={"input_tokens":1234,"output_tokens":56} compacted=true '
      + "guard={verified:1,skipped:2,revised:3,rerun_cited:4,unverified:0,guard_error:0}",
  ].join("\n");
  assert.deepEqual(parseFinal(stdout), {
    finalText: "ok",
    termination: "end_turn",
    guarded: true,
  });
  assert.deepEqual(parseStats(stdout), {
    rounds: 9,
    inputTokens: 1234,
    outputTokens: 56,
    guard: {
      enabled: true,
      state: "metrics",
      verified: 1,
      skipped: 2,
      revised: 3,
      rerun_cited: 4,
      unverified: 0,
      guard_error: 0,
    },
  });
  assert.equal(parseStats("=== 统计 === rounds=1 usage={} guard=off").guard.state, "off");
});

test("inspectRun counts note/archive calls and stores only redacted values", async () => {
  await withProjectTemp(async (directory) => {
    const transcriptDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    const outputsDir = path.join(transcriptDir, "outputs", "inspect-run");
    await mkdir(outputsDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    await writeFile(
      path.join(outputsDir, "0001.txt"),
      "一次性密钥=REAL-TOOL-VALUE\n",
      "utf8",
    );
    await writeFile(
      path.join(transcriptDir, "inspect-run.jsonl"),
      `${JSON.stringify({
        round: 7,
        folded: true,
        messages: [{
          role: "assistant",
          content: [
            { type: "tool_use", name: "note_list", input: {} },
            { type: "tool_use", name: "note_list", input: {} },
            { type: "tool_use", name: "note_read", input: { key: "x" } },
            { type: "tool_use", name: "readFile", input: { path: path.join(outputsDir, "0001.txt") } },
            { type: "tool_result", content: "一次性密钥=REAL-TOOL-VALUE" },
          ],
        }],
      })}\n`,
      "utf8",
    );
    const stdout = [
      "=== 终稿（已核验） ===",
      "一次性密钥=REAL-TOOL-VALUE",
      "=== 统计 === rounds=8 termination=end_turn "
        + 'usage={"input_tokens":100,"output_tokens":20} '
        + "guard={verified:1,skipped:0,revised:0,rerun_cited:0,unverified:0,guard_error:0}",
    ].join("\n");
    const inspected = await inspectRun({
      runId: "inspect-run",
      transcriptDir,
      notesDir,
      stdout,
      stderr: "",
      arm: "B",
      model: "configured-model",
      durationMs: 321,
      exitCode: 0,
      timedOut: false,
    });

    assert.equal(inspected.noteListCalls, 2);
    assert.equal(inspected.noteReadCalls, 1);
    assert.equal(inspected.archiveReadCalls, 1);
    assert.equal(inspected.rounds, 8);
    assert.equal(inspected.inputTokens, 100);
    assert.equal(inspected.outputTokens, 20);
    assert.equal(inspected.wallTimeMs, 321);
    assert.deepEqual(inspected.generatedValues, [{ prefix: "REAL", length: 15 }]);
    assert.equal(inspected.answer.prefix, "REAL");
    assert.doesNotMatch(JSON.stringify(inspected), /REAL-TOOL-VALUE/u);
  });
});

test("aggregate excludes failures from behavior denominator and exposes Wilson rates", () => {
  const [row] = aggregate([
    {
      arm: "A", model: "fake-model", category: "hit_first", failed: false,
      durationMs: 100, rounds: 2, inputTokens: 10, outputTokens: 5,
      noteListCalls: 2, noteReadCalls: 1, archiveReadCalls: 0,
      guard: { verified: 1 },
    },
    {
      arm: "A", model: "fake-model", category: "no_answer", failed: false,
      durationMs: 300, rounds: 4, inputTokens: 30, outputTokens: 15,
      noteListCalls: 0, noteReadCalls: 0, archiveReadCalls: 2,
      guard: { skipped: 1 },
    },
    {
      arm: "A", model: "fake-model", category: "invented", failed: true,
      failClosed: true, durationMs: 500, guard: { unverified: 1 },
    },
  ]);

  assert.equal(row.n, 3);
  assert.equal(row.failed, 1);
  assert.equal(row.completed, 2);
  assert.equal(row.determinable, 2);
  assert.equal(row.evaluated, 2);
  assert.equal(row.hitFirst, 1);
  assert.equal(row.invented, 1);
  assert.equal(row.evaluatedInvented, 0);
  assert.equal(row.noAnswer, 1);
  assert.equal(row.noteListCalls, 2);
  assert.equal(row.noteReadCalls, 1);
  assert.equal(row.archiveReadCalls, 2);
  assert.equal(row.guard.verified, 1);
  assert.equal(row.guard.unverified, 1);
  assert.equal(row.averages.inputTokens, 40 / 3);
  assert.equal(row.averageDurationMs, 300);
  assert.equal(row.rates.hit.denominator, 2);
  assert.equal(row.rates.failed.denominator, 3);
  assert.ok(row.rates.hit.wilson95.low < 0.5);
  assert.ok(row.rates.hit.wilson95.high > 0.5);
  assert.equal(row.errorSpecificCount, 0);
  assert.equal(row.errorSpecificRate, 0);
});

test("roundRobinOrder interleaves A/B/C and keeps legacy arguments usable", () => {
  assert.deepEqual(
    roundRobinOrder({ models: ["fake-model"], runs: 2 })
      .map(({ arm, model, index }) => `${index}:${arm}/${model}`),
    [
      "1:A/fake-model",
      "1:B/fake-model",
      "1:C/fake-model",
      "2:A/fake-model",
      "2:B/fake-model",
      "2:C/fake-model",
    ],
  );
  assert.equal(roundRobinOrder({
    models: ["fake-model"],
    smokeRuns: 1,
    criticalRuns: 2,
  }).length, 6);
});

test("appendBatch preserves history and report states criteria and power limits", () => {
  const legacy = {
    startedAt: "old",
    runs: [{ id: "old" }],
    aggregate: [],
    conclusion: "old result",
  };
  const batch = {
    metadata: {
      batchId: "new",
      startedAt: "now",
      model: "configured-model",
      runsPerArm: 30,
    },
    runs: [],
    aggregate: [],
    conclusion: "new result",
  };
  const result = appendBatch(legacy, batch);
  assert.equal(result.batches.length, 2);
  assert.equal(result.batches[0].runs[0].id, "old");
  assert.equal(result.batches[0].legacySnapshot.conclusion, "old result");
  assert.equal(result.metadata.batchId, "new");
  const report = reportMarkdown(result);
  assert.match(report, /A.*--no-notes/u);
  assert.match(report, /B.*默认配置/u);
  assert.match(report, /C.*--no-final-guard/u);
  assert.match(report, /Wilson 95%/u);
  assert.match(report, /n=30 功效限制/u);
});
