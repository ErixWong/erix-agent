import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("file: appendRound 修复并隔离无换行结尾的损坏残行", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const complete = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "complete" }] }],
    };
    const appended = {
      round: 2,
      messages: [{ role: "assistant", content: [{ type: "text", text: "appended" }] }],
    };
    await store.appendRound("run", complete);
    await appendFile(join(root, "run.jsonl"), '{"round":2,"messages":[', "utf8");

    await store.appendRound("run", appended);

    assert.deepEqual(await store.load("run"), [complete, appended]);
    const transcript = await readFile(join(root, "run.jsonl"), "utf8");
    assert.doesNotMatch(transcript, /\{"round":2,"messages":\[$/);
    assert.equal(transcript.endsWith("\n"), true);
    const quarantined = (await readdir(root))
      .filter((name) => name.startsWith("run.jsonl.corrupt."));
    assert.equal(quarantined.length, 1);
    assert.equal(
      await readFile(join(root, quarantined[0]), "utf8"),
      '{"round":2,"messages":[',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: appendRound 补完整 JSON 缺末尾换行的尾部（不隔离不丢弃）", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const complete = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "complete" }] }],
    };
    const appended = {
      round: 2,
      messages: [{ role: "assistant", content: [{ type: "text", text: "appended" }] }],
    };
    // 完整 JSON 记录但缺末尾 \n（syscall 截断在 LF 前）——应补 \n，不应当残段隔离
    await writeFile(
      join(root, "run.jsonl"),
      `${JSON.stringify(complete)}\n${JSON.stringify({ round: 99, messages: [] })}`,
    );

    await store.appendRound("run", appended);

    assert.deepEqual(await store.load("run"), [complete, { round: 99, messages: [] }, appended]);
    const transcript = await readFile(join(root, "run.jsonl"), "utf8");
    assert.equal(transcript.endsWith("\n"), true);
    const quarantined = (await readdir(root))
      .filter((name) => name.startsWith("run.jsonl.corrupt."));
    assert.equal(quarantined.length, 0, "完整 JSON 尾部不应被隔离");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: appendRound 按 dedupKey 幂等，重复轮次不重复写入", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const record = {
      round: 3,
      dedupKey: "run:round:3",
      messages: [{ role: "assistant", content: [{ type: "text", text: "once" }] }],
    };
    await store.appendRound("run", record);
    await store.appendRound("run", {
      ...record,
      messages: [{ role: "assistant", content: [{ type: "text", text: "duplicate" }] }],
    });

    assert.deepEqual(await store.load("run"), [record]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
