import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  const parent = await mkdtemp(join(tmpdir(), "erix-repl-test-"));
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
  const dir = await mkdtemp(join(tmpdir(), "erix-repl-path-test-"));
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
  const dir = await mkdtemp(join(tmpdir(), "erix-repl-atomic-test-"));
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
  const dir = await mkdtemp(join(tmpdir(), "erix-repl-test-"));
  try {
    assert.deepEqual(await loadSession(dir, "missing"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl aborts the active loop on SIGINT and keeps readline open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-repl-sigint-test-"));
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
      ["--session", "repl-sigint", "--dir", dir],
      {
        input,
        output,
        sessionDir: dir,
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
  const dir = await mkdtemp(join(tmpdir(), "erix-repl-store-test-"));
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "first response" }] },
    { content: [{ type: "text", text: "second response" }] },
  ]);
  try {
    const run = runRepl(
      ["--session", "repl-store", "--dir", dir],
      {
        input,
        output,
        sessionDir: dir,
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
  const dir = await mkdtemp(join("/tmp", "erix-repl-recovery-hint-test-"));
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let captured;
  try {
    const run = runRepl(
      ["--session", "repl-recovery", "--dir", dir, "--compact-budget", "100"],
      {
        input,
        output,
        sessionDir: dir,
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
  const dir = await mkdtemp(join(tmpdir(), "erix-assembly-root-test-"));
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
  const dir = await mkdtemp(join("/tmp", "erix-repl-diagnostics-test-"));
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let captured;
  try {
    const run = runRepl(
      ["--session", "repl-diagnostics", "--dir", dir],
      {
        input,
        output,
        errorOutput,
        sessionDir: dir,
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
  const dir = await mkdtemp(join("/tmp", "erix-repl-mcp-error-test-"));
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
  const dir = await mkdtemp(join(tmpdir(), "erix-repl-abort-test-"));
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
      ["--session", session, "--dir", dir],
      {
        input,
        output,
        sessionDir: dir,
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
    assert.deepEqual(
      (await store.load(session)).map((record) => record.round),
      [0, 0, 1, 2],
    );
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat artifacts resume in REPL and pass the final guard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-assembly-e2e-test-"));
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
      provider: chatProvider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      finalGuard: false,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    assert.equal(chatResult.verification.status, "skipped");

    const run = runRepl(
      ["--session", "assembly-e2e", "--dir", dir, "--final-guard"],
      {
        input,
        output,
        sessionDir: dir,
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
