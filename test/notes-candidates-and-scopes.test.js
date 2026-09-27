// 覆盖 final-guard 候选行提取（candidateLines）、notes 作用域隔离与
// run 边界生命周期（onRunComplete + 宿主 purge）。原名 notes-autocapture
// 是 auto-capture 时代的遗留命名（ADR-016 已退役该桥），随 0.12.0 契约收窄改名。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
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
import { createFileNotesStore } from "../src/store/notes.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-notes-autocapture-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withNotes(callback, { runId = "auto-run", retentionMs } = {}) {
  return withTempDirectory(async (directory) => {
    const previous = Object.fromEntries(
      [
        "ERIX_NOTES_DIR",
        "ERIX_NOTES_RETENTION_MS",
        "ERIX_NOTES_GRACE_MS",
      ]
        .map((name) => [name, process.env[name]]),
    );
    process.env.ERIX_NOTES_DIR = directory;
    const previousScope = activeNotesScope;
    activeNotesScope = { runId, notesDir: directory };
    // 统一保留期（ADR-018 D7）：retentionMs 直接设权威变量；其余三个是
    // 兼容/deprecated alias，测试前一律清除避免串扰。
    if (retentionMs === undefined) delete process.env.ERIX_NOTES_RETENTION_MS;
    else process.env.ERIX_NOTES_RETENTION_MS = String(retentionMs);
    delete process.env.ERIX_NOTES_GRACE_MS;
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

test("run completes pinned notes and host purge reclaims the scope past retention", async () => {
  const now = { value: Date.now() };
  await withNotes(async (directory) => {
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      // ADR-018 D7/D8：lifecycle 只有 onRunComplete（返回形状锁定为
      // {completed, errors}）；保留期清理由宿主显式调度 store.purge。
      const tools = notes.createBuiltinNotesTools({ notesDir: directory, runId: "auto-run" });
      await tools.executors("note_take", { key: "lifecycle", content: "value", pinned: true });
      const completion = await tools.lifecycle.onRunComplete({});
      assert.deepEqual([...Object.keys(completion)].sort(), ["completed", "errors"]);
      assert.deepEqual(completion.completed, { status: "found", completed: 1 });
      assert.deepEqual(completion.errors, []);
      assert.deepEqual(
        Object.keys(tools.lifecycle).sort(),
        ["onRunComplete"],
        "lifecycle 只剩 onRunComplete（ADR-018 D8）",
      );
      assert.equal(
        JSON.parse(await scopedNotes.note_read({ key: "lifecycle" })).status,
        "found",
      );
      const done = JSON.parse(await readFile(
        path.join(directory, "run", "auto-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(done.state, "done");
      assert.equal(done.expires_at, undefined, "expires_at 已退役（ADR-018 D7）");

      // 会话时钟在保留期内：文件存在，宿主 purge 不删。
      const store = createFileNotesStore({ dir: directory, clock: () => now.value });
      assert.equal((await store.purge({})).purged, 0);
      // scope 最后写入超过保留期（推进注入时钟模拟）：purge 整本物理删除。
      now.value += 2 * 1000;
      assert.equal((await store.purge({})).purged, 1);
      const revoked = JSON.parse(await scopedNotes.note_read({ key: "lifecycle" }));
      assert.equal(revoked.status, "missing");
      await assert.rejects(readdir(path.join(directory, "run", "auto-run")));
    } finally {
      restoreClock();
    }
  }, { retentionMs: 1000 });
});

// ADR-018 D7 会话时钟：CLI 宿主在收尾时按 transcript 最后活动清理过期笔记
// scope（笔记寿命 = 会话寿命 + 30 天尸检期）；找不到 transcript 回退笔记 mtime。
async function runQuietChat({ transcriptsDir, notesDir, session }) {
  await runChat({
    prompt: "ping",
    session,
    dir: transcriptsDir,
    notesDir,
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }] },
    ]),
    config: { model: "fake-model", maxOutputTokens: 1000 },
    finalGuard: false,
    maxRounds: 1,
    idleTimeout: 0,
    toolOutput: () => {},
  });
}

const DAY = 24 * 60 * 60 * 1000;

async function seedDeadScope(notesDir, scopeRef) {
  const store = createFileNotesStore({ dir: notesDir });
  await store.write({
    scope: "run",
    scopeRef,
    key: "remnant",
    record: {
      key: "remnant",
      scope: "run",
      scopeRef,
      current: { content: "old-value", provenance: { source: "agent" }, ts: "x" },
      superseded: [],
      folded: 0,
      pinned: false,
      tags: [],
      relevance: 0.5,
      state: "done",
      created_at: "2026-09-15T00:00:00.000Z",
      updated_at: "2026-09-15T00:00:00.000Z",
    },
  });
}

test("CLI host purge: scope whose transcript aged out is cleaned along with the session", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "dead-run");
    // transcript 40 天无活动 → 本次 chat（另一个 session）收尾时该 scope 被清理。
    await writeFile(path.join(transcriptsDir, "dead-run.jsonl"), "{}\n", "utf8");
    const stale = new Date(Date.now() - 40 * DAY);
    await utimes(path.join(transcriptsDir, "dead-run.jsonl"), stale, stale);
    await runQuietChat({ transcriptsDir, notesDir, session: "live-run" });
    await assert.rejects(
      readFile(path.join(notesDir, "run", "dead-run", "remnant.json"), "utf8"),
    );
    await assert.rejects(readdir(path.join(notesDir, "run", "dead-run")));
  });
});

test("CLI host purge: scope with a live transcript is kept, even with very old notes", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "live-run");
    // transcript 10 天前（保留期内）→ scope 豁免；笔记文件本身 40 天前也无所谓。
    await writeFile(path.join(transcriptsDir, "live-run.jsonl"), "{}\n", "utf8");
    const recent = new Date(Date.now() - 10 * DAY);
    await utimes(path.join(transcriptsDir, "live-run.jsonl"), recent, recent);
    const noteFile = path.join(notesDir, "run", "live-run", "remnant.json");
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(noteFile, old, old);
    await runQuietChat({ transcriptsDir, notesDir, session: "other-run" });
    const kept = JSON.parse(await readFile(noteFile, "utf8"));
    assert.equal(kept.key, "remnant");
  });
});

test("CLI host purge: scope without a transcript falls back to the newest note mtime", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "orphan-run");
    const noteFile = path.join(notesDir, "run", "orphan-run", "remnant.json");
    // 无 transcript：笔记文件 40 天前 → 清理。
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(noteFile, old, old);
    await runQuietChat({ transcriptsDir, notesDir, session: "live-run" });
    await assert.rejects(readFile(noteFile, "utf8"));
  });
});

test("CLI host purge: scope without a transcript and fresh notes is kept", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "fresh-run");
    await runQuietChat({ transcriptsDir, notesDir, session: "live-run" });
    const kept = JSON.parse(await readFile(
      path.join(notesDir, "run", "fresh-run", "remnant.json"),
      "utf8",
    ));
    assert.equal(kept.key, "remnant");
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
