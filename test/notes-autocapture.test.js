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
import { candidateLines } from "../bin/final-guard-support.js";
import {
  buildArchiveNotice,
  createCliTools,
  wrapExecuteTool,
} from "../bin/tools.js";
import { createFinalGuard } from "../bin/final-guard.js";
import * as notes from "../src/tools/notes.js";
import { NOTE_VALUE_MAX_CHARS } from "../src/tools/notes.js";
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
// 模块级导出无 lifecycle 视图；此处按 assembler 的 canonical 形态补一个
// lifecycle.onRunStart（语义 = 带当前 scope 的 runNotesJanitor），供测试走 canonical API。
const scopedWithLifecycle = {
  ...notes,
  lifecycle: {
    onRunStart: (input = {}) => notes.runNotesJanitor({
      ...input,
      __erix: input.__erix ?? activeNotesScope,
    }),
  },
};
const scopedNotes = new Proxy(scopedWithLifecycle, {
  get(target, property) {
    const value = target[property];
    if (typeof value !== "function") return value;
    return (input = {}) => value({
      ...input,
      __erix: input.__erix ?? activeNotesScope,
    });
  },
});

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

test("GC revokes expired pinned notes and keeps a tombstone with an injected clock", async () => {
  const now = { value: Date.now() };
  await withNotes(async (directory) => {
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      await scopedNotes.note_take({ key: "lifecycle", content: "value", pinned: true });
      await scopedNotes.completeRun();
      assert.equal(JSON.parse(await scopedNotes.note_read({ key: "lifecycle" })).status, "found");
      await scopedNotes.lifecycle.onRunStart({});
      const done = JSON.parse(await scopedNotes.note_read({ key: "lifecycle" }));
      assert.equal(done.status, "found");
      assert.equal(done.state, "done");

      now.value += 1001;
      await scopedNotes.lifecycle.onRunStart({});
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
