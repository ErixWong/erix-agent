import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runChat } from "../bin/cli.js";
import { candidateLines, captureToolExecution } from "../bin/auto-capture.js";
import {
  archiveResult,
  buildArchiveNotice,
  createCliTools,
  wrapExecuteTool,
} from "../bin/tools.js";
import { createFinalGuard } from "../bin/final-guard.js";
import * as notes from "../skills/notes/skill.mjs";
import { NOTE_VALUE_MAX_CHARS } from "../skills/notes/skill.mjs";
import { looksLikeCredential } from "../skills/notes/credential-patterns.mjs";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createFileResourceStore } from "../src/store/resource-file.js";

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-notes-autocapture-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withNotes(callback, { runId = "auto-run", graceMs } = {}) {
  return withTempDirectory(async (directory) => {
    const previous = Object.fromEntries(
      ["ERIX_NOTES_DIR", "ERIX_NOTES_GRACE_MS"]
        .map((name) => [name, process.env[name]]),
    );
    process.env.ERIX_NOTES_DIR = directory;
    const previousScope = activeNotesScope;
    activeNotesScope = { runId, notesDir: directory };
    if (graceMs === undefined) delete process.env.ERIX_NOTES_GRACE_MS;
    else process.env.ERIX_NOTES_GRACE_MS = String(graceMs);
    try {
      return await callback(directory);
    } finally {
      activeNotesScope = previousScope;
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }

    }
  });
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

function metadataFor(output, archivePath = "/tmp/artifact.txt") {
  return {
    replayable: false,
    fullOutput: output,
    artifact: {
      artifactId: path.basename(archivePath),
      archivePath,
      digest: createHash("sha256").update(output, "utf8").digest("hex"),
      locator: { lineStart: 1, lineEnd: output.split("\n").length },
      replayable: false,
    },
  };
}

async function readOnlyRecord(directory, runId) {
  const scope = path.join(directory, "run", runId);
  const file = (await readdir(scope)).find((name) => name.endsWith(".json"));
  return JSON.parse(await readFile(path.join(scope, file), "utf8"));
}

test("candidateLines extracts Chinese labels, ordinary labels, and bare tokens uniformly", () => {
  assert.deepEqual(
    candidateLines([
      "一次性密钥=XXX",
      "key=value",
      "label: value",
      "opaque-token-123",
    ].join("\n")),
    [
      { label: "一次性密钥", value: "XXX" },
      { label: "key", value: "value" },
    ],
  );
});

test("candidateLines excludes capture metadata labels from value candidates", () => {
  assert.deepEqual(
    candidateLines([
      "lineStart=1",
      "lineEnd=1",
      "digest=abcdef0123456789",
      "toolUseId=tool-123456",
      "nonce=NCSmGUqbmY48ukg5",
    ].join("\n")),
    [
      { label: "linestart", value: "1" },
      { label: "lineend", value: "1" },
      { label: "digest", value: "abcdef0123456789" },
      { label: "tooluseid", value: "tool-123456" },
      { label: "nonce", value: "NCSmGUqbmY48ukg5" },
    ],
  );
});

test("short non-replayable output is archived with structured metadata", async () => {
  await withTempDirectory(async (cwd) => {
    const archiveDir = path.join(cwd, "outputs");
    const { executeTool, getLastToolMetadata } = createCliTools({
      cwd,
      archiveDir,
      notesScope: { runId: "auto-run", notesDir: cwd },
    });

    const nonReplayable = await executeTool("exec", {
      command: "printf 'short=alpha\\n'; printf %s \"$RANDOM\" >/dev/null",
    });
    const replayable = await executeTool("exec", { command: "printf 'short=beta\\n'" });

    assert.match(nonReplayable, /完整输出已归档/u);
    assert.match(replayable, /short=beta\n/u);
    assert.match(replayable, /完整输出已归档/u);
    const files = await readdir(archiveDir);
    assert.deepEqual(
      files.filter((name) => name.endsWith(".txt")),
      ["001-exec.txt", "002-exec.txt"],
    );
    const metadata = JSON.parse(await readFile(
      path.join(archiveDir, "001-exec.meta.json"),
      "utf8",
    ));
    assert.equal(metadata.replayable, false);
    assert.equal(metadata.status, "ok");
    assert.equal(getLastToolMetadata().replayableSource, "unknown");
    assert.equal(metadata.command, "printf 'short=alpha\\n'; printf %s \"$RANDOM\" >/dev/null");
  });
});

test("ResourceStore-backed CLI artifacts use opaque locators and remain guard-readable", async () => {
  await withTempDirectory(async (cwd) => {
    const archiveDir = path.join(cwd, "outputs");
    const resourceStore = createFileResourceStore({ dir: archiveDir });
    const archived = await archiveResult(archiveDir, "exec", "nonce=opaque-value\n", 1, {
      force: true,
      replayable: false,
      command: "printf opaque",
      resourceStore,
    });

    assert.equal(archived.archivePath, undefined);
    assert.ok(archived.artifact.locator);
    assert.doesNotMatch(archived.artifact.display, /^\//u);
    assert.doesNotMatch(archived.artifact.display, /-exec\.txt$/u);
    assert.doesNotMatch(
      buildArchiveNotice(archiveDir, resourceStore),
      /(?:^|\s)\/(?:[^/\s]+\/)+/u,
    );
    const guard = createFinalGuard({ archiveDir, resourceStore });
    assert.deepEqual(
      await guard({ finalText: "nonce=opaque-value" }),
      { action: "accept" },
    );
  });
});

test("truncated archives hash the bytes on disk and cannot pass provenance guard", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "outputs");
    const output = "x".repeat(1048577);
    const archived = archiveResult(archiveDir, "exec", output, 1, {
      replayable: false,
      command: "synthetic-large-output",
      context: { toolUseId: "large-tool", round: 1 },
    });
    const archivePath = archived.artifact.archivePath;
    const archivedBytes = await readFile(archivePath);
    const sidecar = JSON.parse(await readFile(
      path.join(archiveDir, "001-exec.meta.json"),
      "utf8",
    ));
    const digest = createHash("sha256").update(archivedBytes).digest("hex");
    assert.equal(archived.artifact.digest, digest);
    assert.equal(sidecar.digest, digest);
    assert.equal(archived.artifact.truncated, true);
    assert.equal(archived.artifact.status, "truncated");
    assert.equal(sidecar.truncated, true);
    assert.equal(sidecar.status, "truncated");
    assert.equal(sidecar.originalBytes, 1048577);

    await scopedNotes.recordAutoCapture({
      key: "truncated",
      artifactRef: archived.artifact,
    });
    const guard = createFinalGuard({ runId: "auto-run", archiveDir });
    assert.equal((await guard({ finalText: "任意值" })).action, "revise");
  });
});

test("auto_capture stores short values with their artifact references", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "outputs");
    const tools = createCliTools({
      cwd: directory,
      archiveDir,
      notesScope: { runId: "auto-run", notesDir: directory },
    });
    const executeTool = wrapExecuteTool(tools.executeTool, {
      output: () => {},
      getToolMetadata: tools.getLastToolMetadata,
      notesScope: { runId: "auto-run", notesDir: directory },
    });
    await executeTool({
      id: "tool-1",
      name: "exec",
      input: { command: "printf 'result=alpha\\n'; : \"$RANDOM\"" },
      context: { round: 4 },
    });

    const record = await readOnlyRecord(directory, "auto-run");
    const version = record.current;
    assert.equal(record.pinned, true);
    assert.equal(version.provenance.source, "auto");
    assert.equal(version.provenance.toolUseId, "tool-1");
    assert.equal(version.provenance.round, 4);
    assert.equal(version.provenance.verified, false);
    assert.equal(version.content, "result=alpha\n");
    assert.ok(version.artifactRef.digest);
    assert.deepEqual(version.artifactRef.locator, { lineStart: 1, lineEnd: 1 });
    const read = JSON.parse(await scopedNotes.note_read({ key: record.key }));
    assert.equal(read.status, "found");
    assert.equal(read.value, "result=alpha\n");
    assert.deepEqual(read.artifactRef, version.artifactRef);
  });
});

test("auto_capture keeps only the artifact reference for oversized values", async () => {
  await withNotes(async (directory) => {
    const output = `result=${"x".repeat(NOTE_VALUE_MAX_CHARS + 1)}\n`;
    await captureToolExecution({
      name: "exec",
      toolUseId: "long-value",
      result: output,
      metadata: metadataFor(output, "/tmp/long-value.txt"),
      notesScope: { runId: "auto-run", notesDir: directory },
    });

    const record = await readOnlyRecord(directory, "auto-run");
    const version = record.current;
    assert.equal("content" in version, true);
    assert.ok(version.content.length <= 1000);
    assert.ok(version.artifactRef);
    const read = JSON.parse(await scopedNotes.note_read({ key: record.key }));
    assert.equal(read.status, "found");
    assert.ok(read.artifactRef);
  });
});

test("auto_capture rejects credential-shaped candidates fail-closed", async () => {
  await withNotes(async (directory) => {
    const samples = [
      "token=abcdefghijklmnop",
      "API_KEY=sk-abcdefghijklmnop",
      "token: abcdefghijklmnopqrstuvwxyz123456",
      "Aq7mX2vP9kL4sR8nT1wY6cD3fG5hJ0zQ",
    ];
    for (const [index, output] of samples.entries()) {
      await captureToolExecution({
        name: "exec",
        toolUseId: `credential-${index}`,
        result: output,
        metadata: metadataFor(output, `/tmp/credential-${index}.txt`),
        notesScope: { runId: "auto-run", notesDir: directory },
      });
    }
    const listed = JSON.parse(await scopedNotes.note_list({}));
    assert.equal(listed.total, samples.length);
    for (const entry of listed.notes) {
      const read = JSON.parse(await scopedNotes.note_read({ key: entry.key }));
      assert.equal(read.current.content, undefined);
      assert.ok(read.current.artifactRef);
    }
  });
});

test("note_take and auto_capture share the expanded credential matcher", async () => {
  await withNotes(async (directory) => {
    const samples = ["AWS_SECRET_ACCESS_KEY=example", "DATABASE_URL=******h/db"];
    for (const [index, output] of samples.entries()) {
      assert.equal(looksLikeCredential("", output), true, output);
      const note = JSON.parse(await scopedNotes.note_take({
        key: `shared-${index}`,
        content: output,
      }));
      assert.equal(note.status, "invalid", output);
      await captureToolExecution({
        name: "exec",
        toolUseId: `shared-${index}`,
        result: output,
        metadata: metadataFor(output, `/tmp/shared-${index}.txt`),
        notesScope: { runId: "auto-run", notesDir: directory },
      });
    }
    assert.equal(JSON.parse(await scopedNotes.note_list({})).total, samples.length);
  });
});

test("auto_capture keeps the latest note while every rerun archive remains auditable", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "outputs");
    const tools = createCliTools({
      cwd: directory,
      archiveDir,
      notesScope: { runId: "auto-run", notesDir: directory },
    });
    const executeTool = wrapExecuteTool(tools.executeTool, {
      output: () => {},
      getToolMetadata: tools.getLastToolMetadata,
      notesScope: { runId: "auto-run", notesDir: directory },
    });
    const command = "printf 'result=%s\\n' \"$AUTO_CAPTURE_VALUE\"; : \"$RANDOM\"";
    process.env.AUTO_CAPTURE_VALUE = "first";
    await executeTool({ id: "tool-1", name: "exec", input: { command }, context: { round: 1 } });
    process.env.AUTO_CAPTURE_VALUE = "second";
    await executeTool({ id: "tool-2", name: "exec", input: { command }, context: { round: 2 } });
    await executeTool({ id: "tool-3", name: "exec", input: { command }, context: { round: 3 } });
    delete process.env.AUTO_CAPTURE_VALUE;

    const listed = JSON.parse(await scopedNotes.note_list({}));
    assert.equal(listed.total, 1);
    assert.ok(listed.notes.every((note) => note.key.startsWith("auto-")));
    const values = await Promise.all(listed.notes.map(async (note) => (
      JSON.parse(await scopedNotes.note_read({ key: note.key }))
    )));
    assert.deepEqual(values.map((entry) => entry.value), ["result=second\n"]);
    assert.ok(values[0].superseded.length <= 3);
  });
});

test("non-identical non-replayable executions are allowed without a duplicate warning", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "outputs");
    const runState = { rerunDetected: false };
    const tools = createCliTools({
      cwd: directory,
      archiveDir,
      runState,
      notesScope: { runId: "auto-run", notesDir: directory },
    });
    const first = await tools.executeTool("exec", {
      command: "printf 'nonce=first\\n'; : \"$RANDOM\"",
    });
    const rerun = await tools.executeTool("exec", {
      command: "bash -lc 'printf \"nonce=second\\n\"; : \"$RANDOM\"'",
    });

    assert.match(first, /完整输出已归档/u);
    assert.doesNotMatch(rerun, /重跑警示/u);
    assert.doesNotMatch(rerun, /拦截/u);
    assert.equal(runState.rerunDetected, false);
  });
});

test("GC revokes expired pinned notes and keeps a tombstone with an injected clock", async () => {
  const now = { value: Date.now() };
  await withNotes(async (directory) => {
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      await scopedNotes.note_take({ key: "lifecycle", content: "value", pinned: true });
      await scopedNotes.completeRun();
      assert.equal(JSON.parse(await scopedNotes.note_read({ key: "lifecycle" })).status, "found");
      await scopedNotes.runNotesJanitor();
      const done = JSON.parse(await scopedNotes.note_read({ key: "lifecycle" }));
      assert.equal(done.status, "found");
      assert.equal(done.state, "done");

      now.value += 1001;
      await scopedNotes.runNotesJanitor();
      const revoked = JSON.parse(await scopedNotes.note_read({ key: "lifecycle" }));
      assert.equal(revoked.status, "revoked");
      const tombstone = JSON.parse(await readFile(
        path.join(directory, "run", "auto-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(tombstone.state, "revoked");
      assert.ok(tombstone.gc_at);
    } finally {
      restoreClock();
    }
  }, { graceMs: 1000 });
});

test("runChat captures a non-replayable tool result before completing the run", async () => {
  await withNotes(async (directory) => {
    const transcriptDir = path.join(directory, "transcripts");
    const provider = createFakeProvider([
      {
        content: [{
          type: "tool_use",
          id: "relay-tool-1",
          name: "exec",
          input: { command: "printf 'result=integration\\n'; : \"$RANDOM\"" },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    await runChat({
      prompt: "capture one value",
      session: "integration-run",
      dir: transcriptDir,
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
    });

    const record = await readOnlyRecord(directory, "integration-run");
    assert.equal(record.current.provenance.source, "auto");
    assert.equal(record.state, "done");
    assert.equal(record.current.artifactRef.archivePath, undefined);
    assert.ok(record.current.artifactRef.locator);
    assert.match(record.current.artifactRef.display, /^resource:resource-[0-9a-f-]+$/u);
    assert.equal(record.current.content, "result=integration\n");
  });
});

test("concurrent runChat calls keep explicit note scopes isolated", async () => {
  await withTempDirectory(async (directory) => {
    const previous = {
      notesDir: process.env.ERIX_NOTES_DIR,
    };
    process.env.ERIX_NOTES_DIR = path.join(directory, "sentinel-notes");
    try {
      const run = (runId, value) => runChat({
        prompt: `save ${value}`,
        session: runId,
        dir: path.join(directory, `${runId}-transcripts`),
        notesDir: path.join(directory, `${runId}-notes`),
        provider: createFakeProvider([
          {
            content: [{
              type: "tool_use",
              id: `${runId}-take`,
              name: "note_take",
              input: { key: "answer", content: value },
            }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "done" }] },
        ]),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        finalGuard: false,
        maxRounds: 2,
        idleTimeout: 0,
        toolOutput: () => {},
      });
      await Promise.all([
        run("parallel-a", "value-a"),
        run("parallel-b", "value-b"),
      ]);
      const first = JSON.parse(await readFile(
        path.join(directory, "parallel-a-notes", "run", "parallel-a", "answer.json"),
        "utf8",
      ));
      const second = JSON.parse(await readFile(
        path.join(directory, "parallel-b-notes", "run", "parallel-b", "answer.json"),
        "utf8",
      ));
      assert.equal(first.current.content, "value-a");
      assert.equal(second.current.content, "value-b");
      assert.equal(process.env.ERIX_NOTES_DIR, path.join(directory, "sentinel-notes"));
    } finally {
      if (previous.notesDir === undefined) delete process.env.ERIX_NOTES_DIR;
      else process.env.ERIX_NOTES_DIR = previous.notesDir;
    }
  });
});
