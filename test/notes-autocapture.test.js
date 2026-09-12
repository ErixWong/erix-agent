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
import { captureToolExecution } from "../bin/auto-capture.js";
import { createCliTools, wrapExecuteTool } from "../bin/tools.js";
import * as notes from "../skills/notes/skill.mjs";
import { createFakeProvider } from "./helpers/fake-provider.js";

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
      ["ERIX_NOTES_DIR", "ERIX_RUN_ID", "ERIX_NOTES_GRACE_MS"]
        .map((name) => [name, process.env[name]]),
    );
    process.env.ERIX_NOTES_DIR = directory;
    process.env.ERIX_RUN_ID = runId;
    if (graceMs === undefined) delete process.env.ERIX_NOTES_GRACE_MS;
    else process.env.ERIX_NOTES_GRACE_MS = String(graceMs);
    try {
      return await callback(directory);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}

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

test("short non-replayable output is archived with structured metadata", async () => {
  await withTempDirectory(async (cwd) => {
    const archiveDir = path.join(cwd, "outputs");
    const { executeTool, getLastToolMetadata } = createCliTools({ cwd, archiveDir });
    const nonReplayable = await executeTool("exec", {
      command: "printf 'short=alpha\\n'; printf %s \"$RANDOM\" >/dev/null",
    });
    const replayable = await executeTool("exec", { command: "printf 'short=beta\\n'" });

    assert.match(nonReplayable, /完整输出已归档/u);
    assert.equal(replayable, "short=beta\n");
    const files = await readdir(archiveDir);
    assert.deepEqual(
      files.filter((name) => name.endsWith(".txt")),
      ["001-exec.txt"],
    );
    const metadata = JSON.parse(await readFile(
      path.join(archiveDir, "001-exec.meta.json"),
      "utf8",
    ));
    assert.equal(metadata.replayable, false);
    assert.equal(getLastToolMetadata().replayable, true);
    assert.equal(metadata.command, "printf 'short=alpha\\n'; printf %s \"$RANDOM\" >/dev/null");
  });
});

test("auto_capture stores a reference, not the captured value", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "outputs");
    const tools = createCliTools({ cwd: directory, archiveDir });
    const executeTool = wrapExecuteTool(tools.executeTool, {
      output: () => {},
      getToolMetadata: tools.getLastToolMetadata,
    });
    await executeTool({
      id: "tool-1",
      name: "exec",
      input: { command: "printf 'result=alpha\\n'; : \"$RANDOM\"" },
      context: { round: 4 },
    });

    const record = JSON.parse(await readFile(
      path.join(directory, "run", "auto-run", "result.json"),
      "utf8",
    ));
    const version = record.versions[0];
    assert.equal(record.pinned, true);
    assert.equal(version.provenance.source, "auto");
    assert.equal(version.provenance.toolUseId, "tool-1");
    assert.equal(version.provenance.round, 4);
    assert.equal(version.provenance.verified, false);
    assert.ok(version.artifactRef.digest);
    assert.deepEqual(version.artifactRef.locator, { lineStart: 1, lineEnd: 1 });
    assert.doesNotMatch(JSON.stringify(record), /alpha/u);
    assert.equal(JSON.parse(await notes.note_read({ key: "result" })).status, "unverified");
  });
});

test("auto_capture rejects credential-shaped candidates fail-closed", async () => {
  await withNotes(async (directory) => {
    const samples = [
      "token=abcdefghijklmnop",
      "Bearer abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN PRIVATE KEY-----",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
      "password=not-a-value",
    ];
    for (const [index, output] of samples.entries()) {
      await captureToolExecution({
        name: "exec",
        toolUseId: `credential-${index}`,
        result: output,
        metadata: metadataFor(output, `/tmp/credential-${index}.txt`),
      });
    }
    await assert.rejects(readdir(path.join(directory, "run", "auto-run")));
  });
});

test("auto_capture preserves the first value and deduplicates identical output", async () => {
  await withNotes(async (directory) => {
    const archiveDir = path.join(directory, "outputs");
    const tools = createCliTools({ cwd: directory, archiveDir });
    const executeTool = wrapExecuteTool(tools.executeTool, {
      output: () => {},
      getToolMetadata: tools.getLastToolMetadata,
    });
    const command = "printf 'result=%s\\n' \"$AUTO_CAPTURE_VALUE\"; : \"$RANDOM\"";
    process.env.AUTO_CAPTURE_VALUE = "first";
    await executeTool({ id: "tool-1", name: "exec", input: { command }, context: { round: 1 } });
    process.env.AUTO_CAPTURE_VALUE = "second";
    await executeTool({ id: "tool-2", name: "exec", input: { command }, context: { round: 2 } });
    await executeTool({ id: "tool-3", name: "exec", input: { command }, context: { round: 3 } });
    delete process.env.AUTO_CAPTURE_VALUE;

    const first = JSON.parse(await notes.note_read({ key: "result" }));
    assert.equal(first.status, "unverified");
    assert.equal(first.artifactRef.digest, createHash("sha256").update("result=first\n").digest("hex"));
    const listed = JSON.parse(await notes.note_list({}));
    assert.equal(listed.total, 2);
    assert.ok(listed.notes.some((note) => note.key.startsWith("result:candidate:")));
    assert.doesNotMatch(JSON.stringify(first), /second/u);
  });
});

test("GC revokes expired pinned notes and keeps a tombstone with an injected clock", async () => {
  const now = { value: Date.now() };
  await withNotes(async (directory) => {
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      await notes.note_take({ key: "lifecycle", content: "value", pinned: true });
      await notes.completeRun();
      assert.equal(JSON.parse(await notes.note_read({ key: "lifecycle" })).status, "found");
      await notes.runNotesJanitor();
      const grace = JSON.parse(await notes.note_read({ key: "lifecycle" }));
      assert.equal(grace.status, "found");

      now.value += 1001;
      await notes.runNotesJanitor();
      const revoked = JSON.parse(await notes.note_read({ key: "lifecycle" }));
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
    const record = JSON.parse(await readFile(
      path.join(directory, "run", "integration-run", "result.json"),
      "utf8",
    ));
    assert.equal(record.versions[0].provenance.source, "auto");
    assert.equal(record.state, "grace");
    assert.ok(record.versions[0].artifactRef.archivePath);
    assert.doesNotMatch(JSON.stringify(record), /result=integration/u);
  });
});
