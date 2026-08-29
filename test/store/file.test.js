import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTranscriptStore } from "../../src/store/file.js";
import { transcriptStoreContract } from "../contract/transcript-store.js";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "erix-llm-kit-file-store-"));
}

// 通用行为：契约套件（每次给干净目录 = 干净 store）
transcriptStoreContract("file", async () => {
  const dir = await makeTempDir();
  return createFileTranscriptStore({ dir });
});

// ---- 以下为 file 实现特有行为（不进契约）----

test("file: 自动创建嵌套目录", async () => {
  const root = await makeTempDir();
  const dir = join(root, "nested", "transcripts");
  try {
    const store = createFileTranscriptStore({ dir });
    await store.appendRound("run-1", {
      round: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "start" }] }],
    });
    assert.deepEqual(await readdir(dir), ["run-1.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: runId 安全化为合法文件名", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const unsafeRunId = "../odd run?*";
    await store.appendRound(unsafeRunId, {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }],
    });

    const files = await readdir(root);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[A-Za-z0-9._-]+\.jsonl$/);
    assert.equal((await store.load(unsafeRunId)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: 崩溃安全——容忍末行写一半（残段丢弃）", async () => {
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
