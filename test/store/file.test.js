import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTranscriptStore } from "../../src/store/file.js";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "erix-llm-kit-file-store-"));
}

test("appends and loads records, creating nested directories automatically", async () => {
  const root = await makeTempDir();
  const dir = join(root, "nested", "transcripts");
  try {
    const store = createFileTranscriptStore({ dir });
    const records = [
      {
        round: 1,
        messages: [{ role: "user", content: [{ type: "text", text: "start" }] }],
      },
      {
        round: 2,
        folded: true,
        ts: "2026-08-29T00:00:00.000Z",
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        }],
        foldedPayload: [{ round: 1 }],
      },
    ];

    await store.appendRound("run-1", records[0]);
    await store.appendRound("run-1", records[1]);

    assert.deepEqual(await store.load("run-1"), records);
    assert.deepEqual(await readdir(dir), ["run-1.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates runs and sanitizes run ids into safe filenames", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const unsafeRunId = "../odd run?*";
    const safeFile = ".._odd_run__.jsonl";
    const record = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }],
    };

    await store.appendRound(unsafeRunId, record);
    await store.appendRound("other", {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "two" }] }],
    });

    assert.deepEqual(await store.load(unsafeRunId), [record]);
    assert.deepEqual(await store.load("other"), [{
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "two" }] }],
    }]);
    assert.deepEqual((await readdir(root)).sort(), [safeFile, "other.jsonl"].sort());
    assert.match(safeFile, /^[A-Za-z0-9._-]+\.jsonl$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores an incomplete final JSONL record", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const complete = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "complete" }] }],
    };
    await store.appendRound("run", complete);
    await appendFile(
      join(root, "run.jsonl"),
      '{"round":2,"messages":[{"role":"assistant"',
      "utf8",
    );

    assert.deepEqual(await store.load("run"), [complete]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recalls text using memory-store range, pattern, and empty-result semantics", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    await store.appendRound("run", {
      round: 1,
      messages: [
        { role: "user", content: "inspect files" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            name: "list",
            input: { path: "." },
          }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", content: "README.md" }],
        },
      ],
    });
    await store.appendRound("run", {
      round: 2,
      messages: [{ role: "assistant", content: [{ type: "text", text: "summary" }] }],
    });

    assert.equal(
      await store.recall("run", 1, 1),
      'inspect files\nlist{"path":"."}\nREADME.md',
    );
    assert.equal(await store.recall("run", undefined, undefined, "README"), "README.md");
    assert.equal(await store.recall("run", 2, 2), "summary");
    assert.equal(await store.recall("run", undefined, undefined, "missing"), "");
    assert.equal(await store.recall("missing"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
