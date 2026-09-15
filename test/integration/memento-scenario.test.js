import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCaptureRecoveryHint, buildCaptureStub } from "../../bin/final-guard.js";
import { createCliTools, wrapExecuteTool } from "../../bin/tools.js";
import { buildCompactionContext } from "../../bin/config.js";
import { runToolLoop } from "../../src/loop.js";
import { estimateMessageTokens } from "../../src/tokens.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

test("S1 folds a non-replayable value into the provider request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-memento-s1-"));
  const archiveDir = path.join(directory, "archive");
  const value = "deterministic-abc123";
  const command = `printf 'nonce=${value}\\n'; head -c 1 /dev/urandom >/dev/null; : "${"x".repeat(800)}"`;
  const provider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "s1-exec",
        name: "exec",
        input: { command },
      }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: `请复述 nonce=${value}` }],
      stopReason: "end_turn",
    },
  ]);
  const runState = { rerunDetected: false, captureCount: 0 };
  const cliTools = createCliTools({ cwd: directory, archiveDir, runState });
  const executeTool = wrapExecuteTool(cliTools.executeTool, {
    output: () => {},
    getToolMetadata: cliTools.getLastToolMetadata,
    returnMetadata: true,
    notesScope: { runId: "s1-run", notesDir: path.join(directory, "notes") },
  });
  const context = buildCompactionContext(
    {},
    360,
    ({ foldedPayload }) => buildCaptureRecoveryHint({ archiveDir, foldedPayload }),
    (message) => buildCaptureStub(message),
  );
  context.keepRounds = 0;

  try {
    const result = await runToolLoop({
      provider,
      initialUserMessage: "执行非幂等命令，然后复述 nonce。",
      tools: cliTools.tools,
      executeTool,
      maxRounds: 2,
      completion: false,
      wrapup: false,
      reflection: false,
      context,
      runId: "s1-run",
      runState,
    });

    const secondRequestMessages = provider.requests[1]?.messages ?? [];
    const requestText = JSON.stringify(secondRequestMessages);
    assert.match(
      requestText,
      new RegExp(`\\[已折叠\\][^"]*${value}`),
      `provider request messages did not retain folded value: ${requestText}; estimate=${estimateMessageTokens(secondRequestMessages)}; compaction=${JSON.stringify(result.compactionStats)}`,
    );
    assert.equal(result.verification.status, "skipped");
    assert.notEqual(result.verification.status, "verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("S2 keeps credentials out of a folded stub while retaining its archive pointer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-memento-s2-"));
  const archiveDir = path.join(directory, "archive");
  const secret = "sk-deterministic-secret";
  const safeValue = "safe-deterministic-value";
  const command = `printf 'API_KEY=${secret}\\nnonce=${safeValue}\\n'; head -c 1 /dev/urandom >/dev/null; : "${"x".repeat(800)}"`;
  const provider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "s2-exec",
        name: "exec",
        input: { command },
      }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: "继续处理" }],
      stopReason: "end_turn",
    },
  ]);
  const cliTools = createCliTools({ cwd: directory, archiveDir });
  const executeTool = wrapExecuteTool(cliTools.executeTool, {
    output: () => {},
    getToolMetadata: cliTools.getLastToolMetadata,
    returnMetadata: true,
  });
  const context = buildCompactionContext(
    {},
    360,
    ({ foldedPayload }) => buildCaptureRecoveryHint({ archiveDir, foldedPayload }),
    (message) => buildCaptureStub(message),
  );
  context.keepRounds = 0;

  try {
    await runToolLoop({
      provider,
      initialUserMessage: "执行命令并保留安全值。",
      tools: cliTools.tools,
      executeTool,
      maxRounds: 2,
      completion: false,
      wrapup: false,
      reflection: false,
      context,
      runId: "s2-run",
    });

    const requestMessages = provider.requests[1]?.messages ?? [];
    const foldedStub = requestMessages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .map((block) => block?.text)
      .find((text) => typeof text === "string" && text.includes("[已折叠]"));
    assert.equal(typeof foldedStub, "string");
    assert.match(foldedStub, /001-exec\.txt/u);
    assert.match(foldedStub, new RegExp(safeValue));
    assert.doesNotMatch(foldedStub, new RegExp(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
