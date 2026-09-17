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

test("final guard accepts a final value found in an archived artifact", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=Abc123+XYZ789\n");
    const guard = createFinalGuard({ runId: "guard-run", store: storeOf(records) });
    assert.deepEqual(
      await guard({ finalText: "原值 nonce=Abc123+XYZ789" }),
      { action: "accept" },
    );
    assert.equal(
      (await guard({ finalText: "原值 nonce=Abc123+XYZ789，另一个值 Def456+LMN012" })).action,
      "accept",
    );
  });
});

test("final guard enforces the provenance contract (ADR-016)", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=first-value\n", 1);
    await seedCapture(records, directory, "nonce=rerun-value\n", 2);
    const guard = createFinalGuard({ store: storeOf(records) });
    // 归档内任意捕获值可直接使用（不再要求来源指向）
    assert.deepEqual(await guard({ finalText: "nonce=first-value" }), { action: "accept" });
    assert.deepEqual(await guard({ finalText: "nonce 值是 rerun-value" }), { action: "accept" });
    // 归档外的值必须打回
    assert.equal((await guard({ finalText: "nonce=forged-value" })).action, "revise");
    assert.deepEqual(await guard({ finalText: "abc123" }), {
      action: "skip",
      reason: "no_comparable_label",
    });
    assert.deepEqual(await guard({ finalText: "没有可比对内容" }), {
      action: "skip",
      reason: "no_comparable_label",
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

test("final guard ignores archive paths and locator metadata around the verified value", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=NCSmGUqbmY48ukg5\n");
    const guard = createFinalGuard({ runId: "replay", store: storeOf(records) });
    assert.deepEqual(
      await guard({
        finalText: "nonce 值已核实为 NCSmGUqbmY48ukg5。依据：(1) note_read key=nonce 返回 value=NCSmGUqbmY48ukg5；(2) 读取归档文件 001-exec.txt 第 1 行，内容为 nonce=NCSmGUqbmY48ukg5，与笔记值完全一致。（lineStart=1, lineEnd=1；来源已核验）",
      }),
      { action: "accept" },
    );
  });
});

test("final guard skips text without an explicit comparable label", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=NCSmGUqbmY48ukg5\n");
    assert.deepEqual(
      await createFinalGuard({ store: storeOf(records) })({
        finalText: "nonce=NCSmGUqbmY48ukg5",
      }),
      { action: "accept" },
    );
  });
});

test("final guard accepts archive filenames when they are described as filenames", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=NCSmGUqbmY48ukg5\n");
    assert.deepEqual(
      await createFinalGuard({ store: storeOf(records) })({
        finalText: "nonce=NCSmGUqbmY48ukg5 archive filename 001-exec.txt",
      }),
      { action: "accept" },
    );
  });
});

test("final guard extracts Chinese labels without applying the notes credential label filter", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "一次性密钥=t5Vum2Ucy/Y2gEOo\n");
    const result = await createFinalGuard({ store: storeOf(records) })({
      finalText: "一次性密钥=t5Vum2Ucy/Y2gEOo",
    });
    assert.deepEqual(result, { action: "accept" });
  });
});

test("all archived outputs serve as provenance evidence regardless of replayability (ADR-016)", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=Abc123+XYZ789\n");
    records.push(transcriptRecord({
      toolUseId: "plain-tool",
      round: 2,
      output: "1\n2\n3\n",
      command: "seq 1 3",
    }));
    const guard = createFinalGuard({ store: storeOf(records) });
    assert.deepEqual(
      await guard({ finalText: "nonce=Abc123+XYZ789" }),
      { action: "accept" },
    );
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
      await guard({ finalText: "任意终稿" }),
      { action: "skip", reason: "no_extractable_candidates" },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /未抽取到可核验值/u);
  });
});

test("partial candidate extraction verifies available values and warns for empty outputs", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=Abc123+XYZ789\n");
    await seedCapture(records, directory, "plain prose with no opaque candidate\n", 2, {
      command: "printf prose",
    });
    const warnings = [];
    const guard = createFinalGuard({
      store: storeOf(records),
      onWarning: (warning) => warnings.push(warning),
    });
    assert.deepEqual(
      await guard({ finalText: "nonce=Abc123+XYZ789" }),
      { action: "accept" },
    );
    assert.equal(warnings.length, 1);
  });
});

test("different labels without a comparable assignment are skipped", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=Abc123+XYZ789\n");
    const guard = createFinalGuard({ store: storeOf(records) });
    assert.deepEqual(
      await guard({ finalText: "request_id=Def456+LMN012" }),
      { action: "skip", reason: "no_comparable_label" },
    );
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
        ...finalTexts.flatMap((text) => [
          {
            content: [{ type: "text", text }],
            stopReason: "end_turn",
          },
          {
            content: [{
              type: "text",
              text: JSON.stringify({ done: true, summary: "done", output: text }),
            }],
            stopReason: "end_turn",
          },
        ]),
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

test("a transcript capture is trusted without any notes reference", async () => {
  await withNotes(async (directory) => {
    const records = [];
    await seedCapture(records, directory, "nonce=Sidecar123+Value\n");
    assert.deepEqual(
      await createFinalGuard({ store: storeOf(records) })({
        finalText: "原值 nonce=Sidecar123+Value",
      }),
      { action: "accept" },
    );
    assert.equal(JSON.parse(await scopedNotes.note_read({ key: "nonce" })).status, "missing");
  });
});

test("final guard revises a value not found in any capture", async () => {
  await withNotes(async (directory) => {
    const records = [];
    const display = await seedCapture(records, directory, "nonce=Abc123+XYZ789\n");
    const guard = createFinalGuard({ runId: "guard-run", store: storeOf(records) });
    const result = await guard({ finalText: "原值 nonce=Def456+LMN012" });
    assert.equal(result.action, "revise");
    assert.match(result.message, /未对应本 run 的任何捕获值/u);
    // ADR-015 4b：guard 提示指向 transcript 定位符（零路径）
    assert.match(result.message, new RegExp(`来源=归档:${display.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.doesNotMatch(result.message, /\/tmp\//u);
    assert.match(result.message, /不得重跑/u);
  });
});

test("final guard skips a run with no capture evidence", async () => {
  await withNotes(async () => {
    const guard = createFinalGuard({ runId: "guard-run", store: storeOf([]) });
    assert.deepEqual(await guard({ finalText: "任意值 123456789" }), {
      action: "skip",
      reason: "no_capture_evidence",
    });
  });
});

test("CLI and REPL guard switches preserve opt-in behavior", async () => {
  assert.equal(parseChatArgs(["prompt", "--no-final-guard"]).finalGuard, false);
  assert.equal(parseReplArgs(["--no-final-guard"]).finalGuard, false);
  assert.equal(parseChatArgs(["prompt", "--final-guard"]).finalGuard, true);
  assert.equal(parseReplArgs(["--final-guard"]).finalGuard, true);
  await withNotes(async (directory) => {
    const previous = process.env.ERIX_NO_FINAL_GUARD;
    process.env.ERIX_NO_FINAL_GUARD = "1";
    let captured;
    try {
      await runChat({
        prompt: "switch test",
        session: "guard-run",
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

    } finally {
      if (previous === undefined) delete process.env.ERIX_NO_FINAL_GUARD;
      else process.env.ERIX_NO_FINAL_GUARD = previous;
    }
    assert.equal(captured.finalGuard, undefined);
  });
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
