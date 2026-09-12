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
  classify,
  inspectRun,
  roundRobinOrder,
} from "../scripts/notes-experiment.mjs";

async function withProjectTemp(callback) {
  const directory = await mkdtemp(path.join(process.cwd(), ".test-notes-experiment-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("classify treats a final-text-only value as invented", () => {
  assert.deepEqual(
    classify("一次性密钥=FAKE-FINAL-VALUE", ["REAL-TOOL-VALUE"], []),
    { category: "invented", answer: "FAKE-FINAL-VALUE" },
  );
});

test("classify uses notes as provenance without treating known reruns as first", () => {
  assert.equal(classify("一次性密钥=first", [], ["first", "rerun"]).category, "hit_first");
  assert.equal(classify("记录中的值是 first", [], ["first"]).category, "hit_first");
  assert.equal(
    classify("一次性密钥=rerun", ["first"], ["first", "rerun"]).category,
    "rerun_impersonation",
  );
});

test("inspectRun collects generated values only from tool results and archives", async () => {
  await withProjectTemp(async (directory) => {
    const transcriptDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    const runId = "inspect-final-text";
    await writeFile(
      path.join(transcriptDir, `${runId}.jsonl`),
      `${JSON.stringify({
        round: 1,
        messages: [{
          role: "assistant",
          content: [
            { type: "tool_result", content: "一次性密钥=REAL-TOOL-VALUE" },
            { type: "text", text: "一次性密钥=FAKE-FINAL-VALUE" },
          ],
        }],
      })}\n`,
      "utf8",
    );
    const inspected = await inspectRun({
      runId,
      transcriptDir,
      notesDir,
      stdout: "=== 终稿 ===\n一次性密钥=FAKE-FINAL-VALUE\n=== 统计 ===\ntermination=end_turn\n",
      stderr: "",
      arm: "A",
      model: "kimi-for-coding",
      durationMs: 1,
      exitCode: 0,
      timedOut: false,
    });

    assert.deepEqual(inspected.generatedValues, [{ prefix: "REAL", length: 15 }]);
    assert.equal(inspected.category, "invented");
    assert.doesNotMatch(inspected.finalText, /FAKE-FINAL-VALUE/u);
    assert.match(inspected.finalText, /FAKE…（长度16）/u);
  });
});

test("aggregate excludes failed and indeterminable runs from the error denominator", () => {
  const [row] = aggregate([
    { arm: "A", model: "k3", category: "hit_first", failed: false, durationMs: 1 },
    { arm: "A", model: "k3", category: "no_answer", failed: false, durationMs: 1 },
    { arm: "A", model: "k3", category: "invented", failed: true, durationMs: 1 },
    { arm: "A", model: "k3", category: "no_answer", failed: true, durationMs: 1 },
    { arm: "A", model: "k3", category: "unknown", failed: false, durationMs: 1 },
  ]);

  assert.equal(row.n, 5);
  assert.equal(row.failed, 2);
  assert.equal(row.completed, 3);
  assert.equal(row.determinable, 2);
  assert.equal(row.evaluated, 2);
  assert.equal(row.invented, 1);
  assert.equal(row.noAnswer, 1);
  assert.equal(row.rawNoAnswer, 2);
  assert.equal(row.errorSpecificCount, 0);
  assert.equal(row.errorSpecificRate, 0);
});

test("roundRobinOrder is fixed and interleaves model/arm jobs", () => {
  const jobs = roundRobinOrder({ smokeRuns: 1, criticalRuns: 2 });
  assert.deepEqual(
    jobs.map(({ arm, model, index }) => `${index}:${arm}/${model}`),
    [
      "1:A/kimi-for-coding",
      "1:A/k3",
      "1:B/kimi-for-coding",
      "1:B/k3",
      "1:C/kimi-for-coding",
      "1:C/k3",
      "1:D/kimi-for-coding",
      "1:D/k3",
      "2:A/kimi-for-coding",
      "2:A/k3",
      "2:D/kimi-for-coding",
      "2:D/k3",
    ],
  );
});
