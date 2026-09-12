import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureToolExecution } from "../bin/auto-capture.js";
import { exitCodeForVerification, parseChatArgs, runChat } from "../bin/cli.js";
import { createFinalGuard } from "../bin/final-guard.js";
import { parseReplArgs } from "../bin/repl.js";
import { archiveResult } from "../bin/tools.js";
import * as notes from "../skills/notes/skill.mjs";
import { createFakeProvider } from "./helpers/fake-provider.js";

async function withNotes(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-final-guard-"));
  const previous = {
    notesDir: process.env.ERIX_NOTES_DIR,
    runId: process.env.ERIX_RUN_ID,
  };
  process.env.ERIX_NOTES_DIR = directory;
  process.env.ERIX_RUN_ID = "guard-run";
  try {
    return await callback(directory);
  } finally {
    if (previous.notesDir === undefined) delete process.env.ERIX_NOTES_DIR;
    else process.env.ERIX_NOTES_DIR = previous.notesDir;
    if (previous.runId === undefined) delete process.env.ERIX_RUN_ID;
    else process.env.ERIX_RUN_ID = previous.runId;
    await rm(directory, { recursive: true, force: true });
  }
}

async function createArtifact(directory, output) {
  const archived = archiveResult(directory, "exec", output, 1, {
    force: true,
    replayable: false,
    command: "printf non-replayable",
    context: { toolUseId: "guard-tool", round: 1 },
  });
  const archivePath = archived.archivePath;
  await captureToolExecution({
    name: "exec",
    result: output,
    toolUseId: "guard-tool",
    metadata: {
      replayable: false,
      fullOutput: output,
      artifact: archived.artifact,
    },
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
      "revise",
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

test("different labels with the same value shape do not trigger a revision", async () => {
  await withNotes(async (directory) => {
    await createArtifact(directory, "nonce=Abc123+XYZ789\n");
    const guard = createFinalGuard({ archiveDir: directory });
    assert.deepEqual(
      await guard({ finalText: "request_id=Def456+LMN012" }),
      { action: "accept" },
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
    assert.equal(JSON.parse(await notes.note_read({ key: "nonce" })).status, "missing");
  });
});

test("final guard revises a same-shaped value not found in the artifact", async () => {
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

test("final guard accepts a run with no non-replayable artifact", async () => {
  await withNotes(async () => {
    const guard = createFinalGuard({ runId: "guard-run" });
    assert.deepEqual(await guard({ finalText: "任意值 123456789" }), {
      action: "accept",
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
    await notes.note_take({
      key: "forged-source",
      artifactRef: { ...base, archivePath: path.join(directory, "outside.txt") },
      provenance: { source: "auto" },
    });
    await notes.recordAutoCapture({
      key: "outside",
      artifactRef: { ...base, archivePath: path.join(directory, "outside.txt") },
    });
    await notes.recordAutoCapture({
      key: "missing-digest",
      artifactRef: { ...base, digest: undefined },
    });
    await notes.recordAutoCapture({
      key: "bad-digest",
      artifactRef: { ...base, digest: "b".repeat(64) },
    });

    const guard = createFinalGuard({ runId: "guard-run", archiveDir });
    assert.deepEqual(await guard({ finalText: "nonce=known" }), { action: "accept" });
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

test("CLI and REPL switches disable the final guard", async () => {
  assert.equal(parseChatArgs(["prompt", "--no-final-guard"]).finalGuard, false);
  assert.equal(parseReplArgs(["--no-final-guard"]).finalGuard, false);
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

test("chat wires the final guard by default", async () => {
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
    assert.equal(typeof captured.finalGuard, "function");
    assert.equal(captured.finalGuardMaxRetries, 2);
  });
});
