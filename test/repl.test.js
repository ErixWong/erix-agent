import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { runToolLoop } from "../src/loop.js";
import { createFileTranscriptStore } from "../src/store/file.js";
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
  const dir = await mkdtemp(join(tmpdir(), "erix-repl-test-"));
  try {
    const messages = [
      { role: "user", content: [{ type: "text", text: "你好" }] },
      { role: "assistant", content: [{ type: "text", text: "你好！" }] },
    ];
    await saveSession(dir, "round-trip", messages);
    assert.equal(sessionPath(dir, "round-trip"), join(dir, "round-trip.json"));
    assert.deepEqual(await loadSession(dir, "round-trip"), messages);
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

test("runRepl resumes from the transcript store and exposes recall", async () => {
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
    assert.ok(provider.requests[0].tools.some((tool) => tool.name === "recall"));
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
    const abortTimer = setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      runToolLoop({
        provider: firstProvider,
        initialUserMessage: "user-one",
        executeTool: ({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        completion: false,
        store,
        runId: session,
        signal: controller.signal,
      }),
      /aborted|abort/i,
    );
    clearTimeout(abortTimer);

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
