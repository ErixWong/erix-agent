import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTranscriptStore, safeRunId } from "../../src/store/file.js";
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

test("file: unsafe runId 与旧 hash 形态合法 id 隔离", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const unsafeRunId = "../constructed-collision";
    const hashedRunId = safeRunId(unsafeRunId);
    const legacyCollisionId = `run-${hashedRunId.slice("run-h-".length)}`;
    const unsafeRecord = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "unsafe" }] }],
    };
    const legalRecord = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "legal" }] }],
    };

    await store.appendRound(unsafeRunId, unsafeRecord);
    await store.appendRound(legacyCollisionId, legalRecord);

    assert.notEqual(hashedRunId, legacyCollisionId);
    assert.deepEqual(await store.load(unsafeRunId), [unsafeRecord]);
    assert.deepEqual(await store.load(legacyCollisionId), [legalRecord]);
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".jsonl")).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: load 保留无尾换行的完整记录", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const record = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "complete" }] }],
    };
    await writeFile(join(root, "run.jsonl"), JSON.stringify(record), "utf8");

    assert.deepEqual(await store.load("run"), [record]);
    assert.equal(await readFile(join(root, "run.jsonl"), "utf8"), `${JSON.stringify(record)}\n`);
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

test("file: markRunState 使用临时文件原子替换", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    await store.markRunState("run", "running");
    await store.markRunState("run", "succeeded");

    assert.equal(await store.loadRunStateStatus("run"), "succeeded");
    assert.deepEqual(await readdir(root), ["run.status.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: loadRunStateStatus 回落旧内嵌终态且 loadRunState 原样透传", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const legacy = {
      runId: "legacy-run",
      state: "failed",
      stateVersion: 2,
      deterministic: { rounds: 3 },
    };
    await writeFile(join(root, "legacy-run.state.json"), JSON.stringify(legacy), "utf8");

    assert.equal(await store.loadRunStateStatus("legacy-run"), "failed");
    assert.deepEqual(await store.loadRunState("legacy-run"), legacy);
    assert.deepEqual(await readdir(root), ["legacy-run.state.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: saveRunState 不把旧快照中的内嵌终态续写到新快照", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    await writeFile(
      join(root, "legacy-run.state.json"),
      JSON.stringify({
        runId: "legacy-run",
        state: "failed",
        stateVersion: 1,
      }),
      "utf8",
    );

    await store.saveRunState("legacy-run", { stateVersion: 2 });

    const snapshot = await store.loadRunState("legacy-run");
    assert.equal(Object.hasOwn(snapshot, "state"), false);
    assert.equal(snapshot.stateVersion, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: 损坏 run state 返回显式 state_unavailable", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    await writeFile(join(root, "run.state.json"), "{not-json", "utf8");
    const state = await store.loadRunState("run");
    assert.equal(state.stateStatus, "state_unavailable");
    assert.equal(state.stateError, "corrupt");
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

test("file: appendRound 隔离非对象 JSON 尾部（null/数组/标量——resume 会崩）", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const complete = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "complete" }] }],
    };
    // 非对象 JSON 尾部（如 null）——不是合法 RoundRecord，resume 访问 record.messages 会崩 → 应隔离
    await writeFile(
      join(root, "run.jsonl"),
      `${JSON.stringify(complete)}\nnull`,
    );

    const appended = {
      round: 2,
      messages: [{ role: "assistant", content: [{ type: "text", text: "appended" }] }],
    };
    await store.appendRound("run", appended);

    assert.deepEqual(await store.load("run"), [complete, appended]);
    const quarantined = (await readdir(root))
      .filter((name) => name.startsWith("run.jsonl.corrupt."));
    assert.equal(quarantined.length, 1, "非对象尾部应被隔离");
    assert.equal(await readFile(join(root, quarantined[0]), "utf8"), "null");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: appendRound 无 LF 尾部同 key 不重复写入（幂等）", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const record = {
      round: 5,
      messages: [{ role: "assistant", content: [{ type: "text", text: "payload" }] }],
    };
    // 文件尾部是完整同 key 记录但缺末尾 \n（上次崩溃残留）
    await writeFile(join(root, "run.jsonl"), JSON.stringify(record));

    await store.appendRound("run", record);

    // 修复补 \n 后 dedup 应发现同 key → 不重复写入
    const loaded = await store.load("run");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].round, 5);
    const transcript = await readFile(join(root, "run.jsonl"), "utf8");
    assert.equal((transcript.match(/"round":5/g) ?? []).length, 1, "不应重复写入同 round");
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

test("file: appendRound 遇中间损坏行抛错不追加（fail-closed）", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const good = {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "good" }] }],
    };
    const appended = {
      round: 2,
      messages: [{ role: "assistant", content: [{ type: "text", text: "appended" }] }],
    };
    // 中间行损坏（非尾部——尾部已 \n 结尾，repair 不处理中间行）
    await writeFile(
      join(root, "run.jsonl"),
      `${JSON.stringify(good)}\n{"round":2,"messages":[broken\n`,
    );

    await assert.rejects(
      store.appendRound("run", appended),
      /malformed line/,
    );
    // 未追加——文件保持原样
    const transcript = await readFile(join(root, "run.jsonl"), "utf8");
    assert.equal(transcript.includes("appended"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- issue #78：run snapshot 更名与新旧后缀兼容 ----

test("file: saveRunSnapshot 写入新后缀 .snapshot.json", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const snapshot = { round: 1, status: "pending", pendingToolUse: { id: "t1" } };
    await store.saveRunSnapshot("run-1", snapshot);

    const files = await readdir(root);
    assert.deepEqual(files, ["run-1.snapshot.json"]);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "run-1.snapshot.json"), "utf8")),
      snapshot,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: loadLatestRunSnapshot 兼容读取旧后缀 .checkpoint.json（不做迁移）", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    // 旧版本引擎写入的 legacy 快照文件，直接手工放置模拟
    const legacy = { round: 7, status: "executed", pendingToolUse: { id: "legacy-tool" } };
    await writeFile(join(root, "run-1.checkpoint.json"), `${JSON.stringify(legacy)}\n`, "utf8");

    assert.deepEqual(await store.loadLatestRunSnapshot("run-1"), legacy);
    // 读取兼容 ≠ 迁移：旧文件原样保留，新后缀文件不产生
    assert.deepEqual(await readdir(root), ["run-1.checkpoint.json"]);

    // 未知 runId：新旧后缀都不存在 → undefined
    assert.equal(await store.loadLatestRunSnapshot("missing"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: 新旧后缀并存时优先读新后缀 .snapshot.json", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    const newer = { round: 2, status: "executed" };
    const older = { round: 1, status: "pending" };
    await writeFile(join(root, "run-1.snapshot.json"), `${JSON.stringify(newer)}\n`, "utf8");
    await writeFile(join(root, "run-1.checkpoint.json"), `${JSON.stringify(older)}\n`, "utf8");

    assert.deepEqual(await store.loadLatestRunSnapshot("run-1"), newer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: deprecated 别名 saveCheckpoint/appendCheckpoint/loadLatestCheckpoint 委托新方法", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    await store.saveCheckpoint("run-1", { round: 1, status: "pending" });
    await store.appendCheckpoint("run-1", { round: 2, status: "executed" });

    // 别名写入也走新后缀
    assert.deepEqual(await readdir(root), ["run-1.snapshot.json"]);
    assert.deepEqual(
      await store.loadLatestCheckpoint("run-1"),
      { round: 2, status: "executed" },
    );
    assert.deepEqual(
      await store.loadLatestRunSnapshot("run-1"),
      { round: 2, status: "executed" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: 新后缀 .snapshot.json 损坏 JSON 显式抛错、不回落旧后缀", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    // 新后缀存在但内容是非法 JSON；旧后缀同时存在一个"合法"旧快照——
    // 必须抛错而不是静默回落到旧文件（回落会拿过期现场冒充最新现场）。
    await writeFile(join(root, "run-1.snapshot.json"), "{not-json\n", "utf8");
    await writeFile(
      join(root, "run-1.checkpoint.json"),
      `${JSON.stringify({ round: 1, status: "pending" })}\n`,
      "utf8",
    );

    await assert.rejects(
      store.loadLatestRunSnapshot("run-1"),
      (error) => error instanceof SyntaxError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file: 旧后缀 .checkpoint.json 损坏 JSON 显式抛错", async () => {
  const root = await makeTempDir();
  try {
    const store = createFileTranscriptStore({ dir: root });
    await writeFile(join(root, "run-1.checkpoint.json"), "{broken\n", "utf8");

    await assert.rejects(
      store.loadLatestRunSnapshot("run-1"),
      (error) => error instanceof SyntaxError,
    );
    // deprecated 旧名读取同样显式失败（内部走同一读取路径）
    await assert.rejects(
      store.loadLatestCheckpoint("run-1"),
      (error) => error instanceof SyntaxError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
