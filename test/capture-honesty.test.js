// #109 第 2 步：writeNote 存储故障诚实上抛 + finally 不掩盖主结果
// ADR-016：auto-capture 桥与 captureToolExecution 随可重放概念退役，相关测试删除
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { recordAutoCapture } from "../skills/notes/skill.mjs";
import { runChat } from "../bin/cli.js";

test("writeNote classification: storage fault throws, NotesStoreError stays invalid", async () => {
  const notesDir = await mkdtemp(join(tmpdir(), "erix-capture-cls-"));
  try {
    const scope = { __erix: { runId: "classify-run", notesDir, notesStore: {
      write: async () => { throw new Error("EACCES: disk gone"); },
      read: async () => undefined,
      list: async () => [],
      complete: async () => ({ status: "found", completed: 0 }),
      janitor: async () => ({ status: "found", changed: 0, revoked: 0 }),
    } } };

    // 存储故障 → 上抛（不再伪装 invalid）
    await assert.rejects(
      recordAutoCapture({ key: "k1", content: "v", __erix: scope.__erix }),
      /EACCES/,
    );

    // 主动拒绝（NotesStoreError = 输入/记录校验）→ 保持 invalid 返回
    const rejected = await recordAutoCapture({ key: "k2", content: "v", __erix: {
      runId: "classify-run", notesDir, notesStore: {
        write: async () => {
          const error = new Error("invalid record");
          error.name = "NotesStoreError";
          throw error;
        },
        read: async () => undefined,
        list: async () => [],
        complete: async () => ({ status: "found", completed: 0 }),
        janitor: async () => ({ status: "found", changed: 0, revoked: 0 }),
      },
    } });
    // skill 层返回 JSON 字符串（LLM 工具形态），解析后取 status
    assert.equal(JSON.parse(rejected).status, "invalid");
  } finally {
    await rm(notesDir, { recursive: true, force: true });
  }
});

test("runChat finally: completeRun failure lands in completionErrors, main result intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-finally-test-"));
  try {
    const notesStore = {
      write: async () => {},
      read: async () => undefined,
      list: async () => [],
      complete: async () => { throw new Error("complete failed on disk gone"); },
      janitor: async () => ({ status: "found", changed: 0, revoked: 0 }),
    };
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const result = await runChat({
      prompt: "hello",
      session: "finally-run",
      dir,
      notesDir: join(dir, "notes"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
      _assemblyRoot: {
        archiveDir: join(dir, "outputs"),
        diagnostics: { error() {} },
        notesDir: join(dir, "notes"),
        notesStore,
        resourceStore: undefined,
        store: createMemoryTranscriptStore(),
      },
    });
    assert.equal(result.finalText, "done");
    assert.ok(Array.isArray(result.completionErrors) && result.completionErrors.length >= 1);
    assert.match(result.completionErrors[0].error.message, /complete failed/);
    assert.equal(result.completionErrors[0].operation, "notes_complete_run");
    assert.equal(result.completionErrors[0].phase, "cli_completion");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
