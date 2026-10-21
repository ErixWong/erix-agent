import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  defaultSessionId,
  loadSession,
  parseCommand,
  parseReplArgs,
  runRepl,
  saveSession,
  sessionPath,
} from "../bin/repl.js";
import { createCliAssemblyRoot } from "../bin/assembly-root.js";
import { runChat } from "../bin/cli.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFileTranscriptStore, safeRunId } from "../src/store/file.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

// issue #81：runRepl 的 notesDir 缺省解析真实 ~/.erix/notes（收尾 purge 会扫描甚至删除
// 真实笔记），MCP 配置缺省解析真实 ~/.erix/mcp.json（可能配了真实远端 server）。
// 每个用例注入 notesDir 与空 MCP 配置，彻底隔离真实 home。
async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

test("parseReplArgs uses the default session and directory", () => {
  assert.deepEqual(parseReplArgs([]), {
    session: defaultSessionId(process.cwd()),
    dir: join(homedir(), ".erix", "transcripts"),
    maxRounds: 32,
    idleTimeout: 0,
  });
});

test("defaultSessionId is stable, path-specific, and includes the basename", () => {
  const first = defaultSessionId("/tmp/workspace-one/project");
  const same = defaultSessionId("/tmp/workspace-one/project");
  const second = defaultSessionId("/tmp/workspace-two/project");

  assert.equal(first, same);
  assert.notEqual(first, second);
  assert.match(first, /^project-[a-f0-9]{8}$/);
});

test("parseReplArgs derives the default --dir from the injected home", () => {
  const home = join(tmpdir(), "erix-fake-home");
  const options = parseReplArgs([], "/tmp/project", home);
  assert.equal(options.dir, join(home, ".erix", "transcripts"));
  // 不传 home 时保持真实 homedir 默认（生产行为不变）
  assert.equal(parseReplArgs([]).dir, join(homedir(), ".erix", "transcripts"));
});

test("runRepl routes default session/transcripts dirs into the injected home", async () => {
  const home = await makeTmp("erix-repl-home-default-test-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  try {
    const session = defaultSessionId(process.cwd());
    const mcpConfigPath = await writeEmptyMcpConfig(home);
    const run = runRepl(
      ["--config", mcpConfigPath],
      {
        input,
        output,
        home,
        notesDir: join(home, "notes"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => ({}),
        loop: async () => ({
          finalText: "done",
          messages: [],
          rounds: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        }),
      },
    );
    input.end("hi\n/exit\n");
    await run;

    // 默认 sessionDir（会话存档）与默认 --dir（transcripts/outputs）都落在注入 home 下
    assert.ok(existsSync(join(home, ".erix", `${session}.json`)));
    assert.ok(existsSync(join(home, ".erix", "transcripts", "outputs", session)));
    // 不碰真实 ~/.erix：真实目录里不存在本会话的存档
    assert.equal(existsSync(join(homedir(), ".erix", `${session}.json`)), false);
  } finally {
    input.destroy();
    output.destroy();
    await rm(home, { recursive: true, force: true });
  }
});

test("parseReplArgs accepts session and directory overrides", () => {
  assert.deepEqual(parseReplArgs([
    "--session",
    "work",
    "--dir",
    "/tmp/erix-sessions",
    "--compact-budget",
    "1200",
    "--max-rounds",
    "3",
    "--idle-timeout",
    "5",
  ]), {
    session: "work",
    dir: "/tmp/erix-sessions",
    compactBudget: 1200,
    maxRounds: 3,
    idleTimeout: 5,
  });
  assert.equal(parseReplArgs(["--session", "work"], "/tmp/other").session, "work");
});

test("parseReplArgs accepts a tools allowlist", () => {
  assert.deepEqual(
    parseReplArgs(["--tools", "readFile,exec"]),
    {
      session: defaultSessionId(process.cwd()),
      dir: join(homedir(), ".erix", "transcripts"),
      maxRounds: 32,
      idleTimeout: 0,
      tools: "readFile,exec",
    },
  );
  assert.throws(
    () => parseReplArgs(["--tools"]),
    /--tools 缺少数值/,
  );
  assert.throws(
    () => parseReplArgs(["--tools", " "]),
    /--tools 不能为空/,
  );
});

test("parseReplArgs rejects an invalid compact budget", () => {
  assert.throws(
    () => parseReplArgs(["--compact-budget", "-1"]),
    /--compact-budget 必须是大于等于 0 的整数/,
  );
});

test("parseReplArgs rejects an invalid max rounds value", () => {
  assert.throws(
    () => parseReplArgs(["--max-rounds", "0"]),
    /--max-rounds 必须是大于等于 1 的整数/,
  );
});

test("parseReplArgs rejects unknown parameters", () => {
  assert.throws(
    () => parseReplArgs(["--wat"]),
    /未知参数：--wat/,
  );
});

test("parseCommand recognizes help and exit commands", () => {
  assert.deepEqual(parseCommand("/help"), { command: "help", args: [] });
  assert.deepEqual(parseCommand("/exit"), { command: "exit", args: [] });
});

test("parseCommand recognizes model arguments and missing arguments", () => {
  assert.deepEqual(parseCommand("/model kimi-for-coding"), {
    command: "model",
    args: ["kimi-for-coding"],
  });
  assert.deepEqual(parseCommand("/model"), { command: "model", args: [] });
});

test("parseCommand marks unknown commands", () => {
  assert.deepEqual(parseCommand("/unknown arg"), {
    command: "unknown",
    name: "unknown",
    args: ["arg"],
  });
});

test("saveSession and loadSession round-trip messages", async () => {
  const parent = await makeTmp("erix-repl-test-");
  const dir = join(parent, "sessions");
  try {
    const messages = [
      { role: "user", content: [{ type: "text", text: "你好" }] },
      { role: "assistant", content: [{ type: "text", text: "你好！" }] },
    ];
    await saveSession(dir, "round-trip", messages);
    assert.equal(sessionPath(dir, "round-trip"), join(dir, "round-trip.json"));
    assert.deepEqual(await loadSession(dir, "round-trip"), messages);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(sessionPath(dir, "round-trip"))).mode & 0o777, 0o600);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("session paths map traversal IDs inside the session directory", async () => {
  const dir = await makeTmp("erix-repl-path-test-");
  const session = "../../erix-repl-path-target";
  try {
    assert.equal(sessionPath(dir, session), join(
      dir,
      `${safeRunId(session)}.json`,
    ));
    await saveSession(dir, session, [{ role: "user" }]);
    assert.deepEqual(await loadSession(dir, session), [{ role: "user" }]);
    assert.equal(sessionPath(dir, session).startsWith(`${dir}/`), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSession replaces the archive atomically without leaving temporary files", async () => {
  const dir = await makeTmp("erix-repl-atomic-test-");
  try {
    await saveSession(dir, "atomic", [{ version: 1 }]);
    const path = sessionPath(dir, "atomic");
    const first = await stat(path);
    await saveSession(dir, "atomic", [{ version: 2 }]);
    const second = await stat(path);

    assert.notEqual(first.ino, second.ino);
    assert.deepEqual(await loadSession(dir, "atomic"), [{ version: 2 }]);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSession returns an empty array for a missing file", async () => {
  const dir = await makeTmp("erix-repl-test-");
  try {
    assert.deepEqual(await loadSession(dir, "missing"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl aborts the active loop on SIGINT and keeps readline open", async () => {
  const dir = await makeTmp("erix-repl-sigint-test-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  let abortedResolve;
  const aborted = new Promise((resolve) => {
    abortedResolve = resolve;
  });
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chatStream(request) {
      startedResolve(request.signal);
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          abortedResolve();
          reject(new Error("provider aborted"));
        }, { once: true });
      });
    },
  };

  try {
    const run = runRepl(
      ["--session", "repl-sigint", "--dir", dir, "--config", await writeEmptyMcpConfig(dir)],
      {
        input,
        output,
        sessionDir: dir,
        home: dir,
        notesDir: join(dir, "notes"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => provider,
      },
    );
    input.write("long task\n");
    const signal = await started;
    assert.equal(signal.aborted, false);
    process.emit("SIGINT");
    await aborted;
    assert.equal(signal.aborted, true);
    input.end("/exit\n");
    await run;
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl resumes from the transcript store without an engine-owned retrieval tool", async () => {
  const dir = await makeTmp("erix-repl-store-test-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "first response" }] },
    { content: [{ type: "text", text: "second response" }] },
  ]);
  try {
    const run = runRepl(
      ["--session", "repl-store", "--dir", dir, "--config", await writeEmptyMcpConfig(dir)],
      {
        input,
        output,
        sessionDir: dir,
        home: dir,
        notesDir: join(dir, "notes"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => provider,
      },
    );
    input.end("first\nsecond\n/exit\n");
    await run;

    assert.equal(provider.requests.length, 2);
    // ADR-015 4a：归档提示零路径、不提 ResourceStore
    const system = provider.requests[0].system?.content ?? provider.requests[0].system;
    assert.match(system, /大输出已由引擎全量归档/u);
    assert.doesNotMatch(system, new RegExp(`${dir}/outputs/repl-store`));
    assert.doesNotMatch(system, /ResourceStore/u);
    assert.doesNotMatch(system, /幂等/u);
    assert.ok(provider.requests[1].messages.some((message) => (
      message.role === "user"
      && message.content?.some((block) => block.text === "second")
    )));

    const records = await createFileTranscriptStore({ dir }).load("repl-store");
    assert.deepEqual(records.map((record) => record.round), [0, 1, 1, 2]);
    assert.ok(records.some((record) => record.dedupKey?.includes(":input:")));
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl injects archive status at fold time instead of into loop context", async () => {
  const dir = await makeTmp("erix-repl-recovery-hint-test-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let captured;
  try {
    const run = runRepl(
      ["--session", "repl-recovery", "--dir", dir, "--compact-budget", "100", "--config", await writeEmptyMcpConfig(dir)],
      {
        input,
        output,
        sessionDir: dir,
        home: dir,
        notesDir: join(dir, "notes"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => ({}),
        loop: async (options) => {
          captured = options;
          return {
            finalText: "done",
            messages: [],
            rounds: 1,
            usage: { input_tokens: 0, output_tokens: 0 },
            compactionStats: [],
          };
        },
      },
    );
    input.end("capture\n/exit\n");
    await run;

    assert.ok(captured);
    assert.equal(typeof captured.context.recoveryHint, "function");
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI assembly root provides transcript and notes stores", async () => {
  const dir = await makeTmp("erix-assembly-root-test-");
  try {
    const root = createCliAssemblyRoot({
      dir,
      runId: "assembly-root",
      notesDir: join(dir, "notes"),
    });
    assert.equal(typeof root.store.appendRound, "function");
    assert.equal(typeof root.notesStore.read, "function");
    assert.equal(typeof root.diagnostics.error, "function");
    assert.equal(root.archiveDir, join(dir, "outputs", "assembly-root"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl wires persistence diagnostics to stderr", async () => {
  const dir = await makeTmp("erix-repl-diagnostics-test-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let captured;
  try {
    const run = runRepl(
      ["--session", "repl-diagnostics", "--dir", dir, "--config", await writeEmptyMcpConfig(dir)],
      {
        input,
        output,
        errorOutput,
        sessionDir: dir,
        home: dir,
        notesDir: join(dir, "notes"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => ({}),
        loop: async (options) => {
          captured = options;
          return {
            finalText: "done",
            messages: [],
            rounds: 1,
            usage: { input_tokens: 0, output_tokens: 0 },
            compactionStats: [],
          };
        },
      },
    );
    input.end("diagnostics\n/exit\n");
    await run;

    captured.diagnostics.error({
      operation: "saveCheckpoint",
      phase: "checkpoint_before_tool",
      runId: "repl-diagnostics",
    });
    assert.match(String(errorOutput.read()), /Persistence error: saveCheckpoint during checkpoint_before_tool/);
  } finally {
    input.destroy();
    output.destroy();
    errorOutput.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl reports a damaged MCP config instead of treating it as absent", async () => {
  const dir = await makeTmp("erix-repl-mcp-error-test-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const configPath = join(dir, "broken-mcp.json");
  try {
    await writeFile(configPath, "{ not json", "utf8");
    const run = runRepl(
      ["--config", configPath, "--session", "repl-mcp-error"],
      {
        input,
        output,
        sessionDir: dir,
        home: dir,
        notesDir: join(dir, "notes"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
      },
    );
    input.end("/mcp\n/exit\n");
    await run;
    assert.match(String(output.read()), /MCP 配置损坏/);
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl preserves new input when resuming an aborted tool", async () => {
  const dir = await makeTmp("erix-repl-abort-test-");
  const session = "repl-abort";
  const store = createFileTranscriptStore({ dir });
  const controller = new AbortController();
  const firstProvider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
  ]);
  const resumeProvider = createFakeProvider([
    { content: [{ type: "text", text: "resumed" }] },
  ]);
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();

  try {
    await assert.rejects(
      runToolLoop({
        provider: firstProvider,
        initialUserMessage: "user-one",
        executeTool: () => {
          controller.abort();
          return "not reached";
        },
        completion: false,
        store,
        runId: session,
        signal: controller.signal,
      }),
      /aborted|abort/i,
    );

    const run = runRepl(
      ["--session", session, "--dir", dir, "--config", await writeEmptyMcpConfig(dir)],
      {
        input,
        output,
        sessionDir: dir,
        home: dir,
        notesDir: join(dir, "notes"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => resumeProvider,
      },
    );
    input.end("user-two\n/exit\n");
    await run;

    assert.ok(resumeProvider.requests[0].messages.some((message) => (
      message.role === "user"
      && message.content?.some((block) => block.text === "user-two")
    )));
    // 账本形状：种子行(0) · 本轮崩溃时已入账的 assistant 行 · 宿主那条追问 · 补跑轮行 · 终稿轮行。
    // 工单 261021 写侧之后两个变化（都不是丢行、也不是重复行，行数与改造前相同）：
    //   1. `msg:1:0`（崩溃轮的 assistant 正文）已单独成行 ⇒ `appendUserTurn` 派生的 round =
    //      账本里的最大轮号（它定死的口径），从改造前的 0 变成崩溃轮的 1；
    //   2. 那行随后被 `…:round:1:resume` 载体行折进去（读侧不再单独暴露）。
    // ⇒ 逐轮号序列从 `[0, 0, 1, 2]` 变成 `[0, 1, 1, 2]`，仍是 4 行且一行不多一行不少。
    assert.deepEqual(
      (await store.load(session)).map((record) => record.round),
      [0, 1, 1, 2],
    );
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat artifacts resume in REPL and pass the final guard", async () => {
  const dir = await makeTmp("erix-assembly-e2e-test-");
  const notesDir = join(dir, "notes");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const chatProvider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "e2e-capture",
        name: "exec",
        input: { command: "printf 'nonce=e2e-value\\n'; : \"$RANDOM\"" },
      }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "nonce=e2e-value" }] },
  ]);
  const replProvider = createFakeProvider([
    {
      content: [{
        type: "text",
        text: JSON.stringify({
          done: true,
          summary: "done",
          output: "nonce=e2e-value",
          findings: { nonce: "e2e-value" },
        }),
      }],
    },
  ]);
  try {
    const chatResult = await runChat({
      prompt: "capture a value",
      session: "assembly-e2e",
      dir,
      notesDir,
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      provider: chatProvider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      finalGuard: false,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    assert.equal(chatResult.verification.status, "skipped");

    const run = runRepl(
      ["--session", "assembly-e2e", "--dir", dir, "--final-guard", "--config", join(dir, "mcp.json")],
      {
        input,
        output,
        sessionDir: dir,
        home: dir,
        notesDir,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        maxRounds: 3,
        providerFactory: () => replProvider,
      },
    );
    input.end("resume\n/exit\n");
    await run;

    const outputText = String(output.read());
    assert.match(outputText, /guard=\{verified:1/u);
    assert.ok(replProvider.requests[0].messages.some((message) => (
      JSON.stringify(message).includes("nonce=e2e-value")
    )));
    const system = replProvider.requests[0].system?.content ?? replProvider.requests[0].system;
    assert.doesNotMatch(system, new RegExp(`${dir}/outputs/assembly-e2e`));
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseReplArgs accepts --compaction and rejects unknown strategy names (#167)", () => {
  assert.equal(parseReplArgs(["--compaction", "fold-llm"]).compaction, "fold-llm");
  assert.equal(parseReplArgs([]).compaction, undefined);
  assert.throws(
    () => parseReplArgs(["--compaction", "fold-lm"]),
    /--compaction[\s\S]*sliding-window \| fold-statistical \| fold-llm/u,
  );
  assert.throws(() => parseReplArgs(["--compaction", " "]), /--compaction 不能为空/u);
  assert.throws(() => parseReplArgs(["--compaction"]), /--compaction 缺少数值/u);
});

// ---------------------------------------------------------------------------
// issue #326（wo-D）：`已恢复会话 X（N 条消息）` 这个 N 以前是
// `storedRecords.flatMap(record => record.messages ?? [])` 的长度——#326 之后账本里多了
// 三类引擎事实行与带 `meta.source === "judge-control"` 的控制文本，那个数开始**虚高**
// （改造前实测：真跑一份 fold + TTL + forced-final 的 transcript，报 9 条，正文其实只有 8 条）。// 现在 N 必须是「正文消息数」，被隐藏的引擎提示单独说明；`messages` 缺失/空数组不得崩。
// ---------------------------------------------------------------------------

async function runRestoreLine({ tag, session, rows }) {
  const { writeTranscript } = await import("./helpers/engine-fact-rows.js");
  const home = await makeTmp(`erix-repl-${tag}-`);
  try {
    const transcriptsDir = join(home, "transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    await writeTranscript(join(transcriptsDir, `${session}.jsonl`), rows);
    const mcpConfigPath = await writeEmptyMcpConfig(home);
    const input = new PassThrough();
    input.isTTY = true;
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => { rendered += String(chunk); });
    const run = runRepl(["--session", session, "--dir", transcriptsDir, "--config", mcpConfigPath], {
      input,
      output,
      home,
      notesDir: join(home, "notes"),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      providerFactory: () => ({}),
      loop: async () => ({
        finalText: "done",
        messages: [],
        rounds: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
        compactionStats: [],
      }),
    });
    input.end("/exit\n");
    await run;
    return rendered;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("#326-D 恢复行的消息数不含引擎事实行与自说自话（改造前实测 9 vs 8）", async () => {
  const { mixedFactRows } = await import("./helpers/engine-fact-rows.js");
  const session = "wo-d-repl-facts";
  const rows = mixedFactRows(session);
  const flat = rows.flatMap((row) => row.messages ?? []).length;
  const rendered = await runRestoreLine({ tag: "wo-d-facts", session, rows });

  const line = rendered.split("\n").find((row) => row.includes("已恢复会话"));
  assert.ok(line !== undefined, `没有恢复行：${JSON.stringify(rendered)}`);
  // 夹具：8 条展平消息，其中 2 条是引擎自写的控制文本 ⇒ 正文 6 条
  assert.equal(flat, 8, "夹具的展平消息数变了，下面的判据要跟着重测");
  assert.match(line, /（6 条消息/u, `改造前这里报的是展平数 8：${JSON.stringify(line)}`);
  assert.doesNotMatch(line, /（8 条消息/u);
  assert.match(line, /2 条引擎提示/u, "被隐藏的引擎提示要单独说明，不能静默吞掉");
});

test("#326-D 只有事实行的账本：恢复行报 0 条正文而不崩", async () => {
  const { controlRow, foldRow, ttlRow } = await import("./helpers/engine-fact-rows.js");
  const session = "wo-d-repl-onlyfacts";
  const rendered = await runRestoreLine({
    tag: "wo-d-repl-only",
    session,
    rows: [
      foldRow(session, 2),
      ttlRow(session, 2),
      { round: 3, roundKey: `${session}:round:3` }, // 老行：连 messages 字段都没有
      controlRow(session, 3, "extend"),
    ],
  });
  const line = rendered.split("\n").find((row) => row.includes("已恢复会话"));
  assert.ok(line !== undefined, `没有恢复行：${JSON.stringify(rendered)}`);
  assert.match(line, /（0 条消息/u);
  assert.match(line, /1 条引擎提示/u);
});
