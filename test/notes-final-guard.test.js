import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureToolExecution } from "../bin/auto-capture.js";
import { parseChatArgs, runChat } from "../bin/cli.js";
import { createFinalGuard } from "../bin/final-guard.js";
import { parseReplArgs } from "../bin/repl.js";
import { archiveResult } from "../bin/tools.js";
import * as notes from "../skills/notes/skill.mjs";

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
