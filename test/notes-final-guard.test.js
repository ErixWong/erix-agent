import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { exitCodeForVerification, parseChatArgs, runChat } from "../bin/cli.js";
import {
  buildCaptureRecoveryHint,
  buildCaptureStub,
  createFinalGuard,
} from "../bin/final-guard.js";
import { parseReplArgs } from "../bin/repl.js";
import * as notes from "../skills/notes/skill.mjs";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

async function withNotes(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-final-guard-"));
  const previous = {
    notesDir: process.env.ERIX_NOTES_DIR,
  };
  process.env.ERIX_NOTES_DIR = directory;
  const previousScope = activeNotesScope;
  activeNotesScope = { runId: "guard-run", notesDir: directory };
  try {
    return await callback(directory);
  } finally {
    activeNotesScope = previousScope;
    if (previous.notesDir === undefined) delete process.env.ERIX_NOTES_DIR;
    else process.env.ERIX_NOTES_DIR = previous.notesDir;
    await rm(directory, { recursive: true, force: true });
  }

}

let activeNotesScope;
const scopedNotes = new Proxy(notes, {
  get(target, property) {
    const value = target[property];
    if (typeof value !== "function") return value;
    return (input = {}) => value({
      ...input,
      __erix: input.__erix ?? activeNotesScope,
    });
  },
});

// ADR-016：证据源 = transcript 全部归档输出（不再区分可重放）。
function transcriptRecord({ toolUseId, round, output, command = "printf value" }) {
  return {
    round,
    toolOutputs: [{ toolUseId, name: "exec", content: output }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "exec", input: { command } }] },
      { role: "user", content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: output,
      }] },
    ],
  };
}

function storeOf(records) {
  return { load: async () => records };
}

function transcriptDisplay(round, output) {
  const digest = createHash("sha256").update(output, "utf8").digest("hex");
  return `transcript:round=${round}:${digest.slice(0, 8)}`;
}

async function seedCapture(records, directory, output, sequence = 1, { command = "printf value" } = {}) {
  const toolUseId = `guard-tool-${sequence}`;
  records.push(transcriptRecord({ toolUseId, round: sequence, output, command }));
  return transcriptDisplay(sequence, output);
}

test("final guard verifies declared findings against archived captures", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=gold-4173\n", 1);
    await seedCapture(records, directory, "plain prose with no candidate\n", 2, {
      command: "printf prose",
    });
    const guard = createFinalGuard({ store: storeOf(records) });
    // 声明与捕获一致 → accept（终稿散文随便写，guard 不解析）
    assert.deepEqual(
      await guard({
        finalText: "「TARGET=gold-4173」即为所求（自由排版）",
        findings: { nonce: "gold-4173" },
      }),
      { action: "accept" },
    );
    // 数字/布尔声明照常字符串化
    assert.deepEqual(
      await guard({ finalText: "行数", findings: { nonce: "gold-4173" } }),
      { action: "accept" },
    );
  });
});

test("final guard fail-closes forged values; unknown labels are warned and skipped", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=gold-4173\n", 1);
    const guard = createFinalGuard({ runId: "guard-run", store: storeOf(records) });

    // 值伪造（label 存在、值不符）→ revise
    const forged = await guard({ finalText: "x", findings: { nonce: "FAKE" } });
    assert.equal(forged.action, "revise");
    assert.match(forged.message, /与归档捕获值不符/u);
    assert.match(forged.message, /gold-4173/u);
  });
});

test("unknown labels in findings are warned and skipped, not revised (2026-09-17 实测)", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=gold-4173\n", 1);
    const warnings = [];
    const guard = createFinalGuard({
      store: storeOf(records),
      onWarning: (w) => warnings.push(w),
    });
    // TARGET 是真捕获 ✓；重跑次数是派生结论（归档无此 label）→ 警告+跳过，整体 accept
    assert.deepEqual(
      await guard({
        finalText: "x",
        findings: { nonce: "gold-4173", "gen.sh重跑次数": "0" },
      }),
      { action: "accept" },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /不存在/u);
  });
});

test("final guard revises when captures exist but the envelope declares no findings", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=gold-4173\n", 1);
    const guard = createFinalGuard({ store: storeOf(records) });
    // 有可核验捕获值却一条都不声明 → 不是"本任务没有可核验值"，打回逼它声明
    const missing = await guard({ finalText: "随便写" });
    assert.equal(missing.action, "revise");
    assert.match(missing.message, /没有声明 findings/u);
    assert.match(missing.message, /nonce/u);
    assert.match(missing.message, /recall/u);
    // 显式空 findings 同样不算声明
    const empty = await guard({ finalText: "x", findings: {} });
    assert.equal(empty.action, "revise");
  });
});

test("final guard still skips when the archive has no verifiable value at all", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "plain prose with nothing to verify\n", 1);
    const guard = createFinalGuard({
      store: storeOf(records),
      onWarning: () => {},
    });
    assert.deepEqual(await guard({ finalText: "随便写" }), {
      action: "skip",
      reason: "no_extractable_candidates",
    });
  });
});

test("fold state marker counts captures without exposing values or keys and replaces itself", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=marker-secret-value\n", 1);
    const store = storeOf(records);
    const recoveryHint = (context) => buildCaptureRecoveryHint({
      archiveDir: directory,
      foldedPayload: context.foldedPayload,
      store,
      runId: "guard-run",
    });
    const strategy = createFoldStatisticalStrategy({ recoveryHint });
    const first = await strategy.compact([
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "a", name: "exec", input: {} }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "a",
          content: "nonce=marker-secret-value\n",
        }],
      },
      { role: "assistant", content: "old" },
      { role: "user", content: "keep" },
    ], { keepRounds: 1, budgetTokens: 0 });
    const firstMarker = first.messages[0].content[0].text;
    assert.match(firstMarker, /\[本 run 状态\] 已折叠 \d+ 条早期输出；其中 1 条输出已归档/u);
    assert.doesNotMatch(firstMarker, /marker-secret-value|nonce|auto-[a-f0-9]+/u);

    const second = await strategy.compact([
      ...first.messages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "b", name: "exec", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "b", content: "later" }],
      },
      { role: "assistant", content: "new" },
    ], { keepRounds: 1, budgetTokens: 0 });
    const markers = second.messages[0].content.filter((block) => (
      block.type === "text" && block.text.includes("[本 run 状态]")
    ));
    assert.equal(markers.length, 1);
    assert.match(markers[0].text, /transcript:round=1:[0-9a-f]{8}/u);
    assert.doesNotMatch(markers[0].text, /marker-secret-value/u);
    assert.equal((markers[0].text.match(/捕获目录视图（最多 10 条）/gu) ?? []).length, 1);
  });
});

test("transcript recovery hints never expose filesystem paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-opaque-hint-"));
  try {
    const records = [];
    await seedCapture(records, directory, "nonce=hint-value\n", 1);
    const hint = await buildCaptureRecoveryHint({
      archiveDir: directory,
      foldedPayload: [],
      store: storeOf(records),
      runId: "guard-run",
    });
    assert.doesNotMatch(hint, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.doesNotMatch(hint, /-exec\.txt/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture recovery index is bounded, value-free, and replaced on each fold", async () => {
  await withNotes(async (directory) => {
    const records = [];
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      await seedCapture(records, directory, `nonce=value-${sequence}\n`, sequence, {
        command: `printf nonce=$TOKEN-${sequence}`,
      });
    }
    const hint = await buildCaptureRecoveryHint({
      archiveDir: directory,
      foldedPayload: [],
      store: storeOf(records),
      runId: "guard-run",
    });
    assert.equal((hint.match(/transcript:round=\d+:[0-9a-f]{8}/gu) ?? []).length, 10);
    assert.match(hint, /另有 2 条捕获/u);
    assert.doesNotMatch(hint, /value-\d+/u);
  });
});

test("capture stubs retain safe labels but never credential values", async () => {
  const stub = await buildCaptureStub({
    content: [{
      type: "tool_result",
      tool_use_id: "stub-1",
      // ADR-016：content 即输出，值直接从中抽取（全部 tool_result 同权）
      content: `nonce=abc123\nsafe=${"x".repeat(1000)}\napi_key=sk-secret-value\npassword=hunter2\n`,
    }],
  });
  assert.match(stub, /nonce=abc123/u);
  assert.doesNotMatch(stub, /sk-secret-value|hunter2/u);
  assert.doesNotMatch(stub, /x{201,}/u);
  assert.ok(Array.from(stub).length <= 200);
});

test("label normalization applies to declared findings (CJK labels)", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "一次性密钥=t5Vum2Ucy/Y2gEOo\n");
    const guard = createFinalGuard({ store: storeOf(records) });
    assert.deepEqual(
      await guard({ finalText: "x", findings: { "一次性密钥": "t5Vum2Ucy/Y2gEOo" } }),
      { action: "accept" },
    );
    // 归一化（首尾空白）后仍然命中同一 label；注意内部空格会变成下划线（不拆词）
    assert.deepEqual(
      await guard({ finalText: "x", findings: { " 一次性密钥 ": "t5Vum2Ucy/Y2gEOo" } }),
      { action: "accept" },
    );
  });
});

test("a transcript capture is trusted without any notes reference", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=Sidecar123+Value\n");
    assert.deepEqual(
      await createFinalGuard({ store: storeOf(records) })({
        finalText: "原值 nonce=Sidecar123+Value",
        findings: { nonce: "Sidecar123+Value" },
      }),
      { action: "accept" },
    );
    assert.equal(JSON.parse(await scopedNotes.note_read({ key: "nonce" })).status, "missing");
  });
});

test("an output without candidates is skipped with a warning", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "plain prose with no opaque candidate\n", 1, {
      command: "printf prose",
    });
    const warnings = [];
    const guard = createFinalGuard({
      store: storeOf(records),
      onWarning: (warning) => warnings.push(warning),
    });
    assert.deepEqual(
      await guard({ finalText: "任意终稿", findings: { nonce: "x" } }),
      { action: "skip", reason: "no_extractable_candidates" },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /未抽取到可核验值/u);
  });
});

test("CLI guard verifies the correct answer and fail-closes a fabricated answer", async () => {
  async function runScenario(finalTexts) {
    return withNotes(async (directory) => {
      const transcriptDir = path.join(directory, "transcripts");
      const provider = createFakeProvider([
        {
          content: [{
            type: "tool_use",
            id: "secret-tool",
            name: "exec",
            input: { command: "printf '一次性密钥=XXX\\n'; : \"$RANDOM\"" },
          }],
          stopReason: "tool_use",
        },
        {
          content: [{
            type: "tool_use",
            id: "seq-tool",
            name: "exec",
            input: { command: "seq 1 1200" },
          }],
          stopReason: "tool_use",
        },
        // findings 语义下，模型每次收尾都带信封声明（散文在 output 里自由排版）
        ...finalTexts.map((text) => ({
          content: [{
            type: "text",
            text: JSON.stringify({
              done: true,
              summary: "done",
              output: `一次性密钥=XXX（自由排版 ${text}）`,
              findings: { "一次性密钥": text.includes("FAKE") ? "FAKE" : "XXX" },
            }),
          }],
          stopReason: "end_turn",
        })),
      ]);
      const result = await runChat({
        prompt: "执行一次性命令和 seq，最后回答首次密钥",
        session: `e2e-${finalTexts.length}-${finalTexts[0].includes("FAKE") ? "fake" : "real"}`,
        dir: transcriptDir,
        skillsDir: path.join(directory, "skills"),
        provider,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        finalGuard: true,
        maxRounds: 8,
        idleTimeout: 0,
        toolOutput: () => {},
      });
      return { result, exitCode: exitCodeForVerification(result.verification) };
    });
  }

  const verified = await runScenario(["一次性密钥=XXX"]);
  assert.equal(verified.result.verification.status, "verified");
  assert.equal(verified.exitCode, 0);

  const forged = await runScenario([
    "一次性密钥=FAKE",
    "一次性密钥=FAKE",
    "一次性密钥=FAKE",
  ]);
  assert.equal(forged.result.verification.status, "unverified");
  assert.equal(forged.result.termination.reason, "final_guard_unverified");
  assert.equal(forged.exitCode, 2);
});

test("final guard stays within the ADR-013 size limit", async () => {
  const source = await readFile(new URL("../bin/final-guard.js", import.meta.url), "utf8");
  assert.ok(source.split("\n").length - 1 <= 300);
});

test("chat leaves the final guard disabled by default", async () => {
  await withNotes(async (directory) => {
    let captured;
    await runChat({
      prompt: "default guard",
      session: "guard-default",
      dir: directory,
      skillsDir: path.join(directory, "skills"),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          termination: { reason: "end_turn" },
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
      toolOutput: () => {},
    });
    assert.equal(captured.finalGuard, undefined);
  });
});

test("chat enables the final guard explicitly", async () => {
  await withNotes(async (directory) => {
    let captured;
    await runChat({
      prompt: "explicit guard",
      session: "guard-explicit",
      dir: directory,
      skillsDir: path.join(directory, "skills"),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      finalGuard: true,
      provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          termination: { reason: "end_turn" },
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
      toolOutput: () => {},
    });
    assert.equal(typeof captured.finalGuard, "function");
    assert.equal(captured.finalGuardMaxRetries, 2);
  });
});
