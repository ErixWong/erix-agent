import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultSessionId,
  loadSession,
  parseCommand,
  parseReplArgs,
  saveSession,
  sessionPath,
} from "../bin/repl.js";

test("parseReplArgs uses the default session and directory", () => {
  assert.deepEqual(parseReplArgs([]), {
    session: defaultSessionId(process.cwd()),
    dir: join(homedir(), ".erix"),
    maxRounds: 16,
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
  ]), {
    session: "work",
    dir: "/tmp/erix-sessions",
    compactBudget: 1200,
    maxRounds: 3,
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
