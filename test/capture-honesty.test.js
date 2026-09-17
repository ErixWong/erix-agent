// #109 第 2 步：auto-capture 诚实上报 + 通用持久化失败报告桥 + finally 不掩盖
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { recordAutoCapture } from "../skills/notes/skill.mjs";
import { captureToolExecution } from "../bin/auto-capture.js";
import { createCliTools, wrapExecuteTool } from "../bin/tools.js";
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

const ARTIFACT_METADATA = () => ({
  name: "exec",
  replayable: false,
  replayableSource: "declared",
  artifact: {
    artifactId: "001-exec.txt",
    digest: "",
    locator: { lineStart: 1, lineEnd: 1 },
    round: 1,
    status: "ok",
    replayable: false,
  },
});

test("auto-capture storage fault: status error + bridge records event port:notes + bill", async () => {
  const notesStore = {
    write: async () => { throw new Error("ENOSPC: no space"); },
    read: async () => undefined,
    list: async () => [],
    complete: async () => ({ status: "found", completed: 0 }),
    janitor: async () => ({ status: "found", changed: 0, revoked: 0 }),
  };
  const result = "nonce=abc123\n";
  const digest = (await import("node:crypto")).createHash("sha256").update(result, "utf8").digest("hex");
  const metadata = ARTIFACT_METADATA();
  metadata.artifact.digest = digest;
  metadata.fullOutput = result;

  const reported = [];
  const captureResult = await captureToolExecution({
    name: "exec",
    input: { command: "printf nonce" },
    command: "printf nonce",
    result,
    metadata,
    toolUseId: "t1",
    round: 1,
    notesScope: { runId: "capture-run", notesDir: "/tmp", notesStore },
  });
  assert.equal(captureResult.status, "error", "存储故障不再伪装 invalid");
  assert.equal(captureResult.count, 0);
  assert.equal(reported.length, 0);
});

test("auto-capture input rejection keeps status invalid (主动拒绝不冒充故障)", async () => {
  const notesStore = {
    write: async () => {
      const error = new Error("invalid record");
      error.name = "NotesStoreError";
      throw error;
    },
    read: async () => undefined,
    list: async () => [],
    complete: async () => ({ status: "found", completed: 0 }),
    janitor: async () => ({ status: "found", changed: 0, revoked: 0 }),
  };
  const result = "nonce=abc123\n";
  const digest = (await import("node:crypto")).createHash("sha256").update(result, "utf8").digest("hex");
  const metadata = ARTIFACT_METADATA();
  metadata.fullOutput = result;
  metadata.artifact.digest = digest;

  const captureResult = await captureToolExecution({
    name: "exec",
    input: { command: "printf nonce" },
    command: "printf nonce",
    result,
    metadata,
    toolUseId: "t1",
    round: 1,
    notesScope: { runId: "capture-run", notesDir: "/tmp", notesStore },
  });
  assert.equal(captureResult.status, "invalid");
});

test("end-to-end: capture fault flows through engine bridge into event + unpersisted bill", async () => {
  const store = createMemoryTranscriptStore();
  const notesStore = {
    write: async () => { throw new Error("ENOSPC: no space"); },
    read: async () => undefined,
    list: async () => [],
    complete: async () => ({ status: "found", completed: 0 }),
    janitor: async () => ({ status: "found", changed: 0, revoked: 0 }),
  };
  const notesDir = await mkdtemp(join(tmpdir(), "erix-capture-e2e-"));
  const cliTools = createCliTools({
    cwd: notesDir,
    archiveDir: join(notesDir, "outputs"),
    notesScope: { runId: "bridge-run", notesDir, notesStore },
  });
  const executeTool = wrapExecuteTool(cliTools.executeTool, {
    output: () => {},
    getToolMetadata: cliTools.getLastToolMetadata,
    returnMetadata: true,
    notesScope: { runId: "bridge-run", notesDir, notesStore },
  });
  const events = [];
  const provider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "cap-1",
        name: "exec",
        input: { command: "printf 'nonce=e2e\\n'; : \"$RANDOM\"" },
      }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  try {
    const result = await runToolLoop({
      provider,
      initialUserMessage: "run",
      executeTool,
      store,
      runId: "bridge-run",
      completion: false,
      wrapup: false,
      reflection: false,
      diagnostics: { error: async (event) => events.push(event) },
    });

    const noteEvents = events.filter((event) => event.port === "notes");
    assert.ok(noteEvents.length >= 1, "persistence_error event with port:notes");
    assert.equal(noteEvents[0].fatal, false);
    assert.equal(noteEvents[0].type, "persistence_error");
    assert.match(noteEvents[0].error.message, /ENOSPC/);
    const billEntry = result.unpersisted.find((entry) => entry.port === "notes");
    assert.ok(billEntry, "账单含 port:notes 条目");
    assert.equal(billEntry.kind, "persistence_error");
    // 主流程继续：exec 结果完好
    const toolResult = result.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block?.type === "tool_result" && block.tool_use_id === "cap-1");
    assert.match(String(toolResult?.content), /nonce=e2e/);
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
        runState: { rerunDetected: false, captureCount: 0 },
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
