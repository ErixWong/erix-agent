import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_REFLECTION_MIN_ROUNDS } from "../src/index.js";
import {
  exitCodeForVerification,
  resolveToolResultTtl,
  resolveReflection,
  parseChatArgs,
  runChat,
} from "../bin/cli.js";
import { formatGuardMetrics } from "../bin/guard-metrics.js";
import { getMcpPoolStatus } from "../bin/mcp.js";
import {
  CLI_TOOLS_SYSTEM_PROMPT,
} from "../bin/tools.js";
import * as notes from "../skills/notes/skill.mjs";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { runToolLoop } from "../src/loop.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

function normalizeGoldenEnvironment(value, cwd, fixtureCwd) {
  if (typeof value === "string") {
    return value
      .split(fixtureCwd).join("<cwd>")
      .split(cwd).join("<cwd>");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeGoldenEnvironment(entry, cwd, fixtureCwd));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeGoldenEnvironment(entry, cwd, fixtureCwd),
      ]),
    );
  }
  return value;
}

test("CLI prompt constrains provenance of one-shot values", () => {
  // ADR-016：重跑风险降为提示语一行（不再提幂等分类）
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /重跑同一命令可能得到不同的值/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /后续需要精确值时先 note_take 记下/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /具体数值必须来自当前工具返回或 note_read/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /不要主动读取密钥、凭据或 \.env/u);
});

test("CLI fake-provider golden keeps model-visible prompt, stub, and notice stable", async () => {
  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/cli-golden.json", import.meta.url),
    "utf8",
  ));
  await rm(fixture.input.dir, { recursive: true, force: true });
  const notesDir = join(fixture.input.dir, "notes");
  const provider = createFakeProvider([
    { content: [{ type: "text", text: fixture.modelVisible.output }], stopReason: "end_turn" },
  ]);
  const root = {
    archiveDir: join(fixture.input.dir, "outputs", "golden"),
    diagnostics: { error() {} },
    notesDir,
    notesStore: createFileNotesStore({ dir: notesDir }),
    store: createMemoryTranscriptStore(),
  };
  try {
    const result = await runChat({
      ...fixture.input,
      provider,
      idleTimeout: 0,
      toolOutput: () => {},
      _assemblyRoot: root,
    });
    const fixtureCwd = fixture.modelVisible.system.match(/工作目录 (.+?)。/u)?.[1];
    assert.ok(fixtureCwd, "golden fixture must contain its recorded cwd");
    const requestSystem = provider.requests[0].system;
    const actualModelVisible = {
      system: typeof requestSystem === "string" ? requestSystem : requestSystem.content,
      messages: provider.requests[0].messages.map(({ cacheBoundary: _cacheBoundary, ...message }) => message),
      output: result.finalText,
    };
    assert.deepEqual(
      normalizeGoldenEnvironment(actualModelVisible, resolve(process.cwd()), fixtureCwd),
      normalizeGoldenEnvironment(fixture.modelVisible, resolve(process.cwd()), fixtureCwd),
    );
    assert.match(fixture.modelVisible.system, /\[工具输出归档\]/u);
    assert.match(fixture.modelVisible.output, /^stub=/u);
  } finally {
    await rm(fixture.input.dir, { recursive: true, force: true });
  }
});

test("reflection default threshold comes from the library constant (issue #127)", () => {
  const saved = {
    ERIX_REFLECTION: process.env.ERIX_REFLECTION,
    ERIX_NO_REFLECTION: process.env.ERIX_NO_REFLECTION,
  };
  delete process.env.ERIX_REFLECTION;
  delete process.env.ERIX_NO_REFLECTION;
  try {
    // 「库写 16、CLI 写 32」的漂移被消掉后，两边必须是同一个数
    assert.equal(resolveReflection(undefined, DEFAULT_REFLECTION_MIN_ROUNDS - 1), false);
    assert.deepEqual(
      resolveReflection(undefined, DEFAULT_REFLECTION_MIN_ROUNDS),
      { enabled: true },
    );
    assert.equal(resolveReflection(true, 4)?.enabled, true);
    assert.equal(resolveReflection(false, 64), false);
    assert.equal(resolveReflection(undefined, 64)?.enabled, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("CLI tool result TTL honors explicit environment and cacheCapable config", () => {
  const previous = process.env.ERIX_TOOL_RESULT_TTL;
  try {
    process.env.ERIX_TOOL_RESULT_TTL = "3";
    assert.equal(resolveToolResultTtl({ cacheCapable: true }), 3);

    delete process.env.ERIX_TOOL_RESULT_TTL;
    assert.equal(resolveToolResultTtl({ cacheCapable: true }), 0);
    assert.equal(resolveToolResultTtl({ cacheCapable: false }), undefined);
    assert.equal(resolveToolResultTtl({}), undefined);
  } finally {
    if (previous === undefined) delete process.env.ERIX_TOOL_RESULT_TTL;
    else process.env.ERIX_TOOL_RESULT_TTL = previous;
  }
});

test("CLI uses distinct nonzero exits for unverified, guard errors, and skipped verification", () => {
  assert.equal(exitCodeForVerification({ status: "verified" }), 0);
  assert.equal(exitCodeForVerification({ status: "unverified" }), 2);
  assert.equal(exitCodeForVerification({ status: "error" }), 3);
  // skipped 不能与 verified 同为 0：调用方必须能区分"核过了"和"根本没核"
  assert.equal(exitCodeForVerification({ status: "skipped", reason: "no_capture_evidence" }), 4);
  assert.notEqual(
    exitCodeForVerification({ status: "skipped" }),
    exitCodeForVerification({ status: "verified" }),
  );
});

test("CLI formats guard metrics and shows disabled guards explicitly", () => {
  assert.equal(
    formatGuardMetrics({
      status: "verified",
      metrics: {
        verified: 1,
        skipped: 0,
        revised: 1,
        unverified: 0,
        guard_error: 0,
      },
    }),
    "guard={verified:1,skipped:0,revised:1,unverified:0,guard_error:0}",
  );
  assert.equal(
    formatGuardMetrics({ status: "skipped", reason: "no_final_guard" }),
    "guard=off",
  );
});

test("archive guidance is present once in the system prompt", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-archive-guidance-test-"));
  try {
    const provider = createFakeProvider([{ content: [{ type: "text", text: "done" }] }]);
    await runChat({
      prompt: "answer",
      session: "archive-guidance-run",
      dir,
      notesDir: join(dir, "notes"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    const system = provider.requests[0].system?.content ?? provider.requests[0].system;
    // ADR-015 4a：归档提示单次出现、零路径、不提 ResourceStore/opaque 工件
    assert.equal((system.match(/\[工具输出归档\]/u) ?? []).length, 1);
    assert.match(system, /大输出已由引擎全量归档/u);
    assert.match(system, /先用 note_list 查找记录，再用 note_read 读取/u);
    assert.doesNotMatch(system, new RegExp(`${dir}/outputs/archive-guidance-run`));
    assert.doesNotMatch(system, /ResourceStore|opaque 工件|明确的归档文件|归档目录：/u);
    assert.doesNotMatch(system, /幂等/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat does not add a value-note index to the system prompt", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-value-index-test-"));
  const notesDir = join(dir, "notes");
  try {
    await notes.note_take({
      key: "captured-nonce",
      content: "secret-value-must-not-leak",
      tags: ["value", "auto"],
      __erix: { runId: "value-index-run", notesDir },
    });
    const provider = createFakeProvider([{ content: [{ type: "text", text: "done" }] }]);
    await runChat({
      prompt: "answer",
      session: "value-index-run",
      dir: join(dir, "transcripts"),
      notesDir,
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      // maxRounds: 2 —— maxRounds:1 时本轮即最后一轮，按预算兜底规则不带 tools（C3）
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    const system = provider.requests[0].system?.content ?? provider.requests[0].system;
    assert.doesNotMatch(system, /\[notes value index\]/u);
    assert.doesNotMatch(system, /secret-value-must-not-leak/u);
    assert.deepEqual(
      provider.requests[0].tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("note_")),
      ["note_take", "note_read", "note_list", "note_forget"],
    );

    const emptyProvider = createFakeProvider([{ content: [{ type: "text", text: "done" }] }]);
    await runChat({
      prompt: "answer",
      session: "empty-value-index-run",
      dir: join(dir, "empty-transcripts"),
      notesDir: join(dir, "empty-notes"),
      provider: emptyProvider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    const emptySystem = emptyProvider.requests[0].system?.content ?? emptyProvider.requests[0].system;
    assert.doesNotMatch(emptySystem, /\[notes value index\]/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat injects archive status at fold time instead of into loop context", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-recovery-hint-test-"));
  let captured;
  try {
    await runChat({
      prompt: "capture compaction context",
      session: "chat-recovery",
      dir,
      skillsDir: join(dir, "skills"),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      compactBudget: 100,
      provider: createFakeProvider([]),
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
      toolOutput: () => {},
    });

    assert.ok(captured);
    assert.equal(typeof captured.context.recoveryHint, "function");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseChatArgs accepts session and transcript directory overrides", () => {
  const options = parseChatArgs([
    "hello",
    "--session",
    "chat-run",
    "--dir",
    "/tmp/erix-transcripts",
  ], "/tmp/project");

  assert.deepEqual(options, {
    prompt: "hello",
    idleTimeout: 300,
    session: "chat-run",
    dir: "/tmp/erix-transcripts",
  });
  assert.equal(
    parseChatArgs([], "/tmp/project").dir,
    join(homedir(), ".erix", "transcripts"),
  );
  assert.notEqual(
    parseChatArgs(["hello"], "/tmp/project").session,
    parseChatArgs(["hello"], "/tmp/project").session,
  );
});

test("parseChatArgs accepts the persistence error log override", () => {
  assert.equal(
    parseChatArgs(["hello", "--error-log", "/tmp/erix-error.log"]).errorLog,
    "/tmp/erix-error.log",
  );
});

test("parseChatArgs accepts the reflection switch", () => {
  assert.equal(parseChatArgs(["hello", "--reflection", "on"]).reflection, true);
  assert.equal(parseChatArgs(["hello", "--reflection", "off"]).reflection, false);
  assert.equal(parseChatArgs(["hello", "--timeout", "1500"]).timeoutMs, 1500);
});

test("parseChatArgs supports disabling only the notes skill", () => {
  assert.equal(parseChatArgs(["hello", "--no-notes"]).noNotes, true);
});

test("parseChatArgs accepts a tools allowlist", () => {
  const options = parseChatArgs(
    ["hello", "--tools", "readFile, tree"],
    "/tmp/project",
  );
  assert.equal(options.tools, "readFile, tree");
  assert.throws(
    () => parseChatArgs(["hello", "--tools"], "/tmp/project"),
    /缺少数值/,
  );
  assert.throws(
    () => parseChatArgs(["hello", "--tools", "  "], "/tmp/project"),
    /--tools 不能为空/,
  );
  assert.throws(
    () => parseChatArgs(
      ["hello", "--tools", "a", "--tools", "b"],
      "/tmp/project",
    ),
    /参数重复/,
  );
});

test("runChat filters tools via --tools allowlist and warns on unknown names", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-tools-flag-"));
  let captured;
  const warnings = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    await runChat({
      prompt: "hi",
      session: "tools-allowlist",
      dir,
      skillsDir: join(dir, "skills"),
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      tools: "readFile, tree, bogus_tool",
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
    });
  } finally {
    process.stderr.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  }

  assert.ok(captured);
  const names = captured.tools.map((tool) => tool.name);
  assert.ok(names.includes("readFile"));
  assert.ok(names.includes("tree"));
  assert.ok(!names.includes("exec"));
  assert.ok(!names.includes("bogus_tool"));
  // 未知名字 stderr 警告
  assert.ok(warnings.some((line) => line.includes("bogus_tool")));
});

test("runChat assembles note tools via the factory and --no-notes removes them", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-no-notes-"));
  try {
    let captured;
    const captureLoop = async (options) => {
      captured = options;
      return {
        finalText: "done",
        messages: [],
        rounds: 1,
        truncated: false,
        usage: { input_tokens: 0, output_tokens: 0 },
        compactionStats: [],
      };
    };
    await runChat({
      prompt: "hi",
      session: "notes-on",
      dir,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop,
    });
    const noteNamesOn = captured.tools.map((tool) => tool.name).filter((name) => name.startsWith("note_"));
    assert.deepEqual(noteNamesOn, ["note_take", "note_read", "note_list", "note_forget"]);
    assert.equal(typeof captured.semanticStateProvider, "function");
    const takeResult = await captured.executeTool({
      id: "t1",
      name: "note_take",
      input: { key: "greeting", content: "hello world", __erix: { runId: "forged" } },
      context: {},
    });
    // wrapExecuteTool(returnMetadata) 包裹后结果在 .data 里
    assert.equal(JSON.parse(takeResult.data).status, "found");

    captured = undefined;
    await runChat({
      prompt: "hi",
      session: "notes-off",
      dir,
      noNotes: true,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop,
    });
    assert.equal(
      captured.tools.map((tool) => tool.name).filter((name) => name.startsWith("note_")).length,
      0,
      "--no-notes 后不得再装配 note_* 工具",
    );
    assert.equal(captured.semanticStateProvider, undefined);

    captured = undefined;
    const saved = process.env.ERIX_NO_NOTES;
    process.env.ERIX_NO_NOTES = "1";
    try {
      await runChat({
        prompt: "hi",
        session: "notes-env-off",
        dir,
        provider: createFakeProvider([]),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        maxRounds: 2,
        idleTimeout: 0,
        toolOutput: () => {},
        loop: captureLoop,
      });
    } finally {
      if (saved === undefined) delete process.env.ERIX_NO_NOTES;
      else process.env.ERIX_NO_NOTES = saved;
    }
    assert.equal(
      captured.tools.map((tool) => tool.name).filter((name) => name.startsWith("note_")).length,
      0,
      "ERIX_NO_NOTES=1 后不得再装配 note_* 工具",
    );
    assert.equal(captured.semanticStateProvider, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat --tools allowlist also applies to factory note tools", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-notes-allowlist-"));
  let captured;
  try {
    await runChat({
      prompt: "hi",
      session: "notes-allowlist",
      dir,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      tools: "note_take, exec",
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
    });
    assert.deepEqual(captured.tools.map((tool) => tool.name).sort(), ["exec", "note_take"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat rejects a --tools allowlist that filters out every tool", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-tools-empty-"));
  try {
    await assert.rejects(
      runChat({
        prompt: "hi",
        session: "tools-empty",
        dir,
        skillsDir: join(dir, "skills"),
        provider: createFakeProvider([]),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        maxRounds: 2,
        idleTimeout: 0,
        toolOutput: () => {},
        tools: "only_bogus_tool",
        loop: async () => {
          throw new Error("loop must not run when allowlist is empty");
        },
      }),
      /--tools 过滤后没有可用工具/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat loop wires a file transcript store without an engine-owned retrieval tool", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-test-"));
  try {
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }] },
    ]);
    await runChat({
      prompt: "remember this",
      session: "chat-wiring",
      dir,
      skillsDir: join(dir, "skills"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      // maxRounds: 2 —— maxRounds:1 时本轮即最后一轮，按预算兜底规则不带 tools（C3）
      maxRounds: 2,
    });

    const system = provider.requests[0].system?.content ?? provider.requests[0].system;
    assert.match(system, /大输出已由引擎全量归档/u);
    assert.doesNotMatch(system, /ResourceStore/u);
    assert.doesNotMatch(system, new RegExp(`${dir}/outputs/chat-wiring`));
    assert.doesNotMatch(system, /幂等/u);
    const records = await createFileTranscriptStore({ dir }).load("chat-wiring");
    assert.deepEqual(records.map((record) => record.round), [0, 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat closes MCP connections when used as a module", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-mcp-cleanup-test-"));
  const mcpConfigPath = join(dir, "mcp.json");
  try {
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        mock: {
          command: "node",
          args: [join(process.cwd(), "fixtures/mock-mcp-server.mjs")],
        },
      },
    }), "utf8");
    const provider = createFakeProvider([
      {
        content: [{
          type: "tool_use",
          id: "mcp-list",
          name: "mcp",
          input: { action: "list" },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    await runChat({
      prompt: "use mcp",
      configPath: mcpConfigPath,
      dir,
      skillsDir: join(dir, "skills"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    assert.deepEqual(getMcpPoolStatus(), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file transcript preserves folded payload", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-fold-test-"));
  try {
    const store = createFileTranscriptStore({ dir });
    const provider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "finished" }] },
    ]);
    const strategy = {
      shouldCompact: () => true,
      async compact(messages, options) {
        return createFoldStatisticalStrategy().compact(messages, {
          ...options,
          keepRounds: 0,
        });
      },
    };

    await runToolLoop({
      provider,
      initialUserMessage: "fold-me initial context",
      executeTool: async () => "fold-me tool result",
      maxRounds: 2,
      completion: false,
      context: { strategy, budgetTokens: 30 },
      store,
      runId: "fold-file",
    });

    const records = await store.load("fold-file");
    assert.ok(records.some((record) => Array.isArray(record.foldedPayload)));
    assert.match(JSON.stringify(records), /fold-me/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat creates distinct default sessions and preserves the second prompt", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-default-session-test-"));
  try {
    const config = { model: "fake-model", maxOutputTokens: 1000 };
    await runChat({
      prompt: "first-prompt",
      dir,
      skillsDir: join(dir, "skills"),
      provider: createFakeProvider([{ content: [{ type: "text", text: "first" }] }]),
      config,
      maxRounds: 1,
      idleTimeout: 0,
    });
    await runChat({
      prompt: "second-prompt",
      dir,
      skillsDir: join(dir, "skills"),
      provider: createFakeProvider([{ content: [{ type: "text", text: "second" }] }]),
      config,
      maxRounds: 1,
      idleTimeout: 0,
    });

    const runIds = (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
    assert.equal(runIds.length, 2);
    const store = createFileTranscriptStore({ dir });
    const records = await Promise.all(runIds.map((runId) => store.load(runId)));
    assert.deepEqual(records.map((run) => run.map((record) => record.round)), [[0, 1], [0, 1]]);

    const secondRun = records.find((run) => run.some((record) => (
      JSON.stringify(record).includes("second-prompt")
    )));
    assert.ok(secondRun);
    assert.match(JSON.stringify(secondRun), /second-prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat reuses an explicitly selected session and keeps the new prompt", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-explicit-session-test-"));
  try {
    const config = { model: "fake-model", maxOutputTokens: 1000 };
    await runChat({
      prompt: "explicit-first",
      session: "explicit-run",
      dir,
      skillsDir: join(dir, "skills"),
      provider: createFakeProvider([{ content: [{ type: "text", text: "first" }] }]),
      config,
      maxRounds: 1,
      idleTimeout: 0,
    });
    const secondProvider = createFakeProvider([
      { content: [{ type: "text", text: "second" }] },
    ]);
    await runChat({
      prompt: "explicit-second",
      session: "explicit-run",
      dir,
      skillsDir: join(dir, "skills"),
      provider: secondProvider,
      config,
      maxRounds: 2,
      idleTimeout: 0,
    });

    assert.ok(secondProvider.requests[0].messages.some((message) => (
      message.role === "user"
      && message.content?.some((block) => block.text === "explicit-second")
    )));
    assert.deepEqual(
      (await createFileTranscriptStore({ dir }).load("explicit-run"))
        .map((record) => record.round),
      [0, 1, 1, 2],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat continues after text-only rounds (maxNoToolRounds default 3)", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-cli-notool-test-"));
  try {
    // 模型先用工具干活（exec 是 CLI 真实工具），然后输出文本（无工具调用）——
    // 之前 maxNoToolRounds=1 会立即判定完成；默认 3 应追加"请继续"并保持循环。
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "act1", name: "exec", input: { command: "echo hi" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "已处理，接下来总结" }], stopReason: "end_turn" },
      { content: [{ type: "tool_use", id: "act2", name: "exec", input: { command: "echo done" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
    ]);

    await runChat({
      prompt: "continue-after-text",
      session: "notool-continue",
      dir,
      skillsDir: join(dir, "skills"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 4,
      idleTimeout: 0,
      toolOutput: () => {}, // 静默工具日志，避免污染 node --test 的 IPC
    });

    // 至少 3 次请求：工具轮 → 文本轮 → 追问后继续工具轮
    assert.ok(provider.requests.length >= 3);
    // 某个请求里应包含"请继续"追问（maxNoToolRounds>1 时文本轮后追加）
    assert.ok(provider.requests.some((request) => (
      request.messages.some((message) => (
        message.role === "user"
        && message.content?.some((block) => block.text === "（请继续完成任务）")
      ))
    )));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("judge log defaults into the run archive directory", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-judgelog-default-"));
  try {
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const judge = createFakeProvider([
      { content: [{ type: "text", text: JSON.stringify({ done: true, confidence: 0.9, reason: "ok", evidence: "done", direction: "on_track" }) }], stopReason: "end_turn" },
    ]);
    await runChat({
      prompt: "finish",
      session: "judgelog-default",
      dir,
      skillsDir: join(dir, "skills"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
      reflection: {
        enabled: true,
        roundJudge: true,
        judge: { provider: judge },
      },
    });

    const defaultLog = join(dir, "outputs", "judgelog-default", "judge.log");
    const content = readFileSync(defaultLog, "utf8");
    assert.ok(content.includes('"round"'), "默认 judge.log 应存在且含 round 记录");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("judge-log redacts credentials from tool input and judge reason", async () => {
  const dir = await mkdtemp(join("/tmp", "erix-judgelog-"));
  const judgeLogPath = join(dir, "judge.log");
  try {
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "curl -H 'Authorization: Bearer sk-abcdef1234567890' http://x" } }], stopReason: "tool_use" },
      // 被拦截后模型转向：发安全命令
      { content: [{ type: "tool_use", id: "t2", name: "exec", input: { command: "ls" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    // judge: intercept 审计该 exec（含密钥命令），reason 复述凭据；judgeIntervalRound=1 每次工具都审计
    const judge = createFakeProvider([
      { content: [{ type: "text", text: JSON.stringify({ done: false, confidence: 0.9, reason: "命令含 Authorization: Bearer sk-abcdef1234567890 需检查", evidence: "输入含凭据", direction: "uncertain" }) }], stopReason: "end_turn" },
      { content: [{ type: "text", text: JSON.stringify({ done: true, confidence: 0.9, reason: "ok", evidence: "安全", direction: "on_track" }) }], stopReason: "end_turn" },
    ]);
    await runChat({
      prompt: "run command",
      session: "judgelog-redact",
      dir,
      skillsDir: join(dir, "skills"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 3,
      idleTimeout: 0,
      judgeLog: judgeLogPath,
      toolOutput: () => {},
      reflection: {
        enabled: true,
        roundJudge: false,
        judgeIntervalRound: 1,
        judge: { provider: judge },
      },
    });

    const content = readFileSync(judgeLogPath, "utf8");
    assert.ok(content.length > 0, "judge.log 应生成");
    assert.ok(!content.includes("sk-abcdef1234567890"), "工具输入中的密钥不应落盘");
    assert.ok(!content.includes("Bearer sk-"), "reason 复述的凭据不应落盘");
    assert.ok(content.includes("[含"), "应有脱敏标记");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
