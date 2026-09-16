import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureToolExecution } from "../bin/auto-capture.js";
import { exitCodeForVerification, parseChatArgs, runChat } from "../bin/cli.js";
import {
  buildCaptureRecoveryHint,
  buildCaptureStub,
  createFinalGuard,
} from "../bin/final-guard.js";
import { parseReplArgs } from "../bin/repl.js";
import { archiveResult } from "../bin/tools.js";
import * as notes from "../skills/notes/skill.mjs";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { createFileResourceStore } from "../src/store/resource-file.js";
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

async function createArtifact(directory, output, sequence = 1) {
  const archived = archiveResult(directory, "exec", output, sequence, {
    force: true,
    replayable: false,
    command: "printf non-replayable",
    context: { toolUseId: `guard-tool-${sequence}`, round: sequence },
  });
  const archivePath = archived.archivePath;
  await captureToolExecution({
    name: "exec",
    input: { command: "printf non-replayable" },
    result: output,
    toolUseId: `guard-tool-${sequence}`,
    metadata: {
      replayable: false,
      fullOutput: output,
      artifact: archived.artifact,
    },
    round: sequence,
    notesScope: { runId: "guard-run", notesDir: directory },
  });
  return archivePath;
}

test("final guard accepts a final value found in a non-replayable artifact", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=Abc123+XYZ789\n");
    const guard = createFinalGuard({ runId: "guard-run", archiveDir: directory });
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

test("final guard enforces the nine-case provenance contract", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=first-value\n", 1);
    await createArtifact(directory, "nonce=rerun-value\n", 2);
    const guard = createFinalGuard({ archiveDir: directory });

    assert.deepEqual(await guard({ finalText: "nonce=first-value" }), { action: "accept" });
    assert.deepEqual(await guard({ finalText: "nonce 值是 first-value" }), { action: "accept" });
    assert.equal((await guard({ finalText: "nonce=forged-value" })).action, "revise");
    assert.deepEqual(await guard({ finalText: "编造的短 token abc123" }), {
      action: "skip",
      reason: "no_comparable_label",
    });

    assert.equal((await guard({ finalText: "nonce=rerun-value" })).action, "revise");
    assert.deepEqual(
      await guard({ finalText: "nonce=rerun-value 来源=归档:002-exec.txt" }),
      { action: "accept", rerunCited: true },
    );
    assert.deepEqual(
      await guard({ finalText: "nonce=first-value 来源=归档:001-exec.txt" }),
      { action: "accept" },
    );
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

test("final guard validates note_read provenance through NotesStore", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=first-value\n", 1);
    await createArtifact(directory, "nonce=rerun-value\n", 2);
    const backing = createFileNotesStore({ dir: directory });
    let reads = 0;
    const notesStore = {
      ...backing,
      read: async (request) => {
        reads += 1;
        return backing.read(request);
      },
    };
    const records = await backing.list({ scope: "run", scopeRef: "guard-run" });
    const rerun = records.find((record) => (
      record.current.artifactRef.archivePath.endsWith("002-exec.txt")
    ));
    const guard = createFinalGuard({
      runId: "guard-run",
      archiveDir: directory,
      notesStore,
    });
    assert.deepEqual(
      await guard({
        finalText: `nonce=rerun-value 来源=note_read:${rerun.key}`,
      }),
      { action: "accept", rerunCited: true },
    );
    assert.ok(reads > 0);

    const rejectingGuard = createFinalGuard({
      runId: "guard-run",
      archiveDir: directory,
      notesStore: {
        ...backing,
        read: async () => undefined,
      },
    });
    assert.equal(
      (await rejectingGuard({
        finalText: `nonce=rerun-value 来源=note_read:${rerun.key}`,
      })).action,
      "revise",
    );
  });
});

test("fold state marker counts captures without exposing values or keys and replaces itself", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=marker-secret-value\n", 1);
    const recoveryHint = (context) => buildCaptureRecoveryHint({
      archiveDir: directory,
      foldedPayload: context.foldedPayload,
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
    assert.match(firstMarker, /\[本 run 状态\] 已折叠 \d+ 条早期输出；其中 1 条为不可重放捕获/u);
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
    assert.match(markers[0].text, /001-exec\.txt ←/u);
    assert.doesNotMatch(markers[0].text, /marker-secret-value/u);
    assert.equal((markers[0].text.match(/归档目录视图（最多 10 条）/gu) ?? []).length, 1);
  });
});

test("ResourceStore recovery hints never expose filesystem paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-opaque-hint-"));
  try {
    const hint = await buildCaptureRecoveryHint({
      archiveDir: directory,
      foldedPayload: [],
      resourceStore: {
        async put() {
          return {
            locator: { id: "resource-1" },
            digest: "a".repeat(64),
            display: "opaque-resource-1",
          };
        },
        async get() {
          return "resource";
        },
      },
    });
    assert.doesNotMatch(hint, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.doesNotMatch(hint, /-exec\.txt/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive recovery index is bounded, value-free, and replaced on each fold", async () => {
  await withNotes(async (directory) => {
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      archiveResult(directory, "exec", `nonce=value-${sequence}\n`, sequence, {
        force: true,
        replayable: false,
        command: `printf nonce=$TOKEN-${sequence}`,
      });
    }
    const hint = await buildCaptureRecoveryHint({
      archiveDir: directory,
      foldedPayload: [],
    });
    assert.equal((hint.match(/-exec\.txt ←/gu) ?? []).length, 10);
    assert.match(hint, /另有 2 条归档/u);
    assert.doesNotMatch(hint, /value-\d+/u);
  });
});

test("capture stubs retain safe labels but never credential values", async () => {
  await withNotes(async (directory) => {
    const archived = archiveResult(
      directory,
      "exec",
      `nonce=abc123\nsafe=${"x".repeat(1000)}\napi_key=sk-secret-value\npassword=hunter2\n`,
      1,
      { force: true, replayable: false, command: "printf nonce=$TOKEN" },
    );
    const stub = await buildCaptureStub({
      content: [{
        type: "tool_result",
        replayable: false,
        artifact: archived.artifact,
      }],
    });
    assert.match(stub, /nonce=abc123/u);
    assert.doesNotMatch(stub, /sk-secret-value|hunter2/u);
    assert.doesNotMatch(stub, /x{201,}/u);
    assert.ok(Array.from(stub).length <= 200);
  });
});

test("ResourceStore capture stubs reread safe values", async () => {
  let gets = 0;
  const resourceStore = {
    async get() {
      gets += 1;
      return "nonce=secret-value\napi_key=sk-secret-value\n";
    },
  };
  const stub = await buildCaptureStub({
    content: [{
      type: "tool_result",
      replayable: false,
      artifact: {
        locator: { id: "resource-1" },
        display: "resource:resource-1",
      },
    }],
  }, resourceStore);

  assert.equal(gets, 1);
  assert.match(stub, /nonce=secret-value/u);
  assert.doesNotMatch(stub, /sk-secret-value/u);
  assert.doesNotMatch(stub, /001-exec\.txt|(?:^|[\s；：])\//u);
});

test("ResourceStore stub read failures fall back and emit diagnostics", async () => {
  const events = [];
  const stub = await buildCaptureStub({
    content: [{
      type: "tool_result",
      replayable: false,
      artifact: {
        locator: { id: "missing-resource" },
        display: "resource:missing-resource",
      },
    }],
  }, {
    async get() {
      throw new Error("missing resource");
    },
  }, {
    error(event) {
      events.push(event);
    },
  });

  assert.equal(stub, "[已折叠] 原文：resource:missing-resource（不可重放）");
  assert.deepEqual(events, [{
    type: "resource_store_error",
    operation: "get",
    phase: "capture_stub",
    fatal: false,
    locator: { id: "missing-resource" },
    error: { name: "Error", message: "missing resource" },
  }]);
});

test("ResourceStore provenance accepts opaque display references for reruns", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "outputs");
    const resourceStore = createFileResourceStore({ dir: archiveDir });
    const first = await archiveResult(archiveDir, "exec", "nonce=first-value\n", 1, {
      force: true,
      replayable: false,
      command: "printf first",
      resourceStore,
    });
    const second = await archiveResult(archiveDir, "exec", "nonce=second-value\n", 2, {
      force: true,
      replayable: false,
      command: "printf second",
      resourceStore,
    });

    assert.notEqual(first.artifact.display, second.artifact.display);
    const guard = createFinalGuard({ archiveDir, resourceStore });
    assert.deepEqual(
      await guard({
        finalText: `nonce=second-value 来源=归档:resource:${second.artifact.display}`,
      }),
      { action: "accept", rerunCited: true },
    );
  });
});

test("final guard ignores archive paths and locator metadata around the verified value", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=NCSmGUqbmY48ukg5\n");
    const guard = createFinalGuard({ runId: "replay", archiveDir: directory });
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
    await createArtifact(directory, "nonce=NCSmGUqbmY48ukg5\n");
    assert.deepEqual(
      await createFinalGuard({ archiveDir: directory })({
        finalText: "nonce=NCSmGUqbmY48ukg5",
      }),
      { action: "accept" },
    );
  });
});

test("final guard accepts archive filenames when they are described as filenames", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=NCSmGUqbmY48ukg5\n");
    assert.deepEqual(
      await createFinalGuard({ archiveDir: directory })({
        finalText: "nonce=NCSmGUqbmY48ukg5 archive filename 001-exec.txt",
      }),
      { action: "accept" },
    );
  });
});

test("final guard extracts Chinese labels without applying the notes credential label filter", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "一次性密钥=t5Vum2Ucy/Y2gEOo\n");
    const result = await createFinalGuard({ archiveDir: directory })({
      finalText: "一次性密钥=t5Vum2Ucy/Y2gEOo",
    });
    assert.deepEqual(result, { action: "accept" });
  });
});

test("replayable artifacts never pollute the provenance value set", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=Abc123+XYZ789\n");
    archiveResult(directory, "exec", "1\n2\n3\n", 2, {
      force: true,
      replayable: true,
      command: "seq 1 3",
    });
    const guard = createFinalGuard({ archiveDir: directory });
    assert.deepEqual(
      await guard({ finalText: "nonce=Abc123+XYZ789" }),
      { action: "accept" },
    );
  });
});

test("an empty readable non-replayable artifact is skipped with a warning", async () => {
  await withNotes(async (directory) => {
    archiveResult(directory, "exec", "plain prose with no opaque candidate\n", 1, {
      force: true,
      replayable: false,
      command: "printf prose",
    });
    const warnings = [];
    const guard = createFinalGuard({
      archiveDir: directory,
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

test("partial candidate extraction verifies available values and warns for empty artifacts", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=Abc123+XYZ789\n");
    archiveResult(directory, "exec", "plain prose with no opaque candidate\n", 2, {
      force: true,
      replayable: false,
      command: "printf prose",
    });
    const warnings = [];
    const guard = createFinalGuard({
      archiveDir: directory,
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
    await createArtifact(directory, "nonce=Abc123+XYZ789\n");
    const guard = createFinalGuard({ archiveDir: directory });
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

test("a valid capture sidecar is trusted without any notes reference", async () => {
  await withNotes(async (directory) => {
    archiveResult(directory, "exec", "nonce=Sidecar123+Value\n", 1, {
      force: true,
      replayable: false,
      command: "printf non-replayable",
    });
    assert.deepEqual(
      await createFinalGuard({ archiveDir: directory })({
        finalText: "原值 nonce=Sidecar123+Value",
      }),
      { action: "accept" },
    );
    assert.equal(JSON.parse(await scopedNotes.note_read({ key: "nonce" })).status, "missing");
  });
});

test("final guard revises a rerun-generated value not found in the artifact", async () => {
  await withNotes(async (directory) => {
    const archivePath = await createArtifact(directory, "nonce=Abc123+XYZ789\n");
    const guard = createFinalGuard({ runId: "guard-run", archiveDir: directory });
    const result = await guard({ finalText: "原值 nonce=Def456+LMN012" });
    assert.equal(result.action, "revise");
    assert.match(result.message, /note_read/u);
    assert.match(result.message, new RegExp(archivePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(result.message, /不得重跑/u);
  });
});

test("final guard skips a run with no capture manifest", async () => {
  await withNotes(async () => {
    const guard = createFinalGuard({ runId: "guard-run" });
    assert.deepEqual(await guard({ finalText: "任意值 123456789" }), {
      action: "skip",
      reason: "no_capture_manifest",
    });
  });
});

test("forged auto notes do not influence final guard trust", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "archive");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(path.join(archiveDir, "inside.txt"), "nonce=known\n", "utf8");
    const base = {
      artifactId: "inside.txt",
      archivePath: path.join(archiveDir, "inside.txt"),
      digest: createHash("sha256").update("nonce=known\n", "utf8").digest("hex"),
      locator: { lineStart: 1, lineEnd: 1 },
      replayable: false,
    };
    await scopedNotes.note_take({
      key: "forged-source",
      artifactRef: { ...base, archivePath: path.join(directory, "outside.txt") },
      provenance: { source: "auto" },
    });
    await scopedNotes.recordAutoCapture({
      key: "outside",
      artifactRef: { ...base, archivePath: path.join(directory, "outside.txt") },
    });
    await scopedNotes.recordAutoCapture({
      key: "missing-digest",
      artifactRef: { ...base, digest: undefined },
    });
    await scopedNotes.recordAutoCapture({
      key: "bad-digest",
      artifactRef: { ...base, digest: "b".repeat(64) },
    });

    const guard = createFinalGuard({ runId: "guard-run", archiveDir });
    assert.deepEqual(await guard({ finalText: "nonce=known" }), {
      action: "skip",
      reason: "no_capture_manifest",
    });
  });
});

test("missing archive referenced by a capture manifest stays unverified", async () => {
  await withNotes(async (directory) => {
    const archivePath = await createArtifact(directory, "nonce=Abc123+XYZ789\n");
    await unlink(archivePath);
    const warnings = [];
    const guard = createFinalGuard({
      runId: "guard-run",
      archiveDir: directory,
      onWarning: (warning) => warnings.push(warning),
    });
    assert.equal((await guard({ finalText: "nonce=Def456+LMN012" })).action, "revise");
    assert.ok(warnings.length > 0);
  });
});

test("missing digest, digest mismatch, and truncation are not trusted", async () => {
  for (const kind of ["missing", "mismatch", "truncated"]) {
    await withNotes(async (directory) => {
      const archivePath = await createArtifact(directory, "nonce=Abc123+XYZ789\n");
      const metadataPath = archivePath.replace(/\.txt$/u, ".meta.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      if (kind === "missing") delete metadata.digest;
      if (kind === "mismatch") metadata.digest = "b".repeat(64);
      if (kind === "truncated") metadata.truncated = true;
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
      const guard = createFinalGuard({ runId: "guard-run", archiveDir: directory });
      assert.equal((await guard({ finalText: "nonce=Abc123+XYZ789" })).action, "revise", kind);
    });
  }
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
