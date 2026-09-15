import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCaptureRecoveryHint, buildCaptureStub } from "../../bin/final-guard.js";
import { createCliTools, wrapExecuteTool } from "../../bin/tools.js";
import { buildCompactionContext } from "../../bin/config.js";
import { runToolLoop } from "../../src/loop.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
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
  const wrappedExecuteTool = wrapExecuteTool(cliTools.executeTool, {
    output: () => {},
    getToolMetadata: cliTools.getLastToolMetadata,
    returnMetadata: true,
  });
  const executeTool = (options) => wrappedExecuteTool(options);
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

test("S3 executes a repeated command and reports first-run provenance", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-memento-s3-"));
  const archiveDir = path.join(directory, "archive");
  const command = `printf 'nonce=s3-deterministic\\n'; head -c 1 /dev/urandom >/dev/null`;
  const provider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "s3-first",
        name: "exec",
        input: { command },
      }],
      stopReason: "tool_use",
    },
    {
      content: [{
        type: "tool_use",
        id: "s3-second",
        name: "exec",
        input: { command },
      }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: "重复命令已执行" }],
      stopReason: "end_turn",
    },
  ]);
  const cliTools = createCliTools({ cwd: directory, archiveDir });
  const wrappedExecuteTool = wrapExecuteTool(cliTools.executeTool, {
    output: () => {},
    getToolMetadata: cliTools.getLastToolMetadata,
    returnMetadata: true,
  });
  const executeTool = (options) => wrappedExecuteTool(options);

  try {
    const result = await runToolLoop({
      provider,
      initialUserMessage: "执行命令两次并报告结果。",
      tools: cliTools.tools,
      executeTool,
      maxRounds: 3,
      completion: false,
      wrapup: false,
      reflection: false,
      runId: "s3-run",
    });

    const toolResults = result.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block?.type === "tool_result");
    const secondResult = toolResults.find((block) => block.tool_use_id === "s3-second");
    assert.ok(secondResult);
    assert.match(secondResult.content, /这是第 2 次执行/u);
    assert.equal(secondResult.rerunOf.artifactId, "001-exec.txt");
    assert.equal(secondResult.rerunOf.round, 1);
    assert.equal(typeof secondResult.rerunOf.digest, "string");
    assert.equal(typeof secondResult.rerunOf.locator, "object");
    assert.equal(secondResult.rerunOf.archivePath, path.join(archiveDir, "001-exec.txt"));
    assert.deepEqual(
      (await readdir(archiveDir)).filter((name) => name.endsWith(".txt")).sort(),
      ["001-exec.txt", "002-exec.txt"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("S4 replaces fold state while preserving unique stubs across two folds", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-memento-s4-"));
  const archiveDir = path.join(directory, "archive");
  const command = `printf 'nonce=s4-deterministic\\n'; head -c 1 /dev/urandom >/dev/null; : "${"x".repeat(5000)}"`;
  const provider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "s4-first",
        name: "exec",
        input: { command },
      }],
      stopReason: "tool_use",
    },
    {
      content: [{
        type: "tool_use",
        id: "s4-rerun",
        name: "exec",
        input: { command },
      }],
      stopReason: "tool_use",
    },
    {
      content: [{
        type: "tool_use",
        id: "s4-write",
        name: "writeFile",
        input: { path: "s4-marker.txt", content: "folded twice ".repeat(400) },
      }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: "两次折叠完成" }],
      stopReason: "end_turn",
    },
  ]);
  const runState = { rerunDetected: false, captureCount: 0 };
  const cliTools = createCliTools({ cwd: directory, archiveDir, runState });
  const wrappedExecuteTool = wrapExecuteTool(cliTools.executeTool, {
    output: () => {},
    getToolMetadata: cliTools.getLastToolMetadata,
    returnMetadata: true,
  });
  const executeTool = (options) => wrappedExecuteTool(options);
  const context = buildCompactionContext(
    {},
    1200,
    ({ foldedPayload }) => buildCaptureRecoveryHint({ archiveDir, foldedPayload }),
    (message) => buildCaptureStub(message),
  );
  context.keepRounds = 0;

  try {
    await runToolLoop({
      provider,
      initialUserMessage: "执行并重复一次非幂等命令，然后写文件。",
      tools: cliTools.tools,
      executeTool,
      maxRounds: 4,
      completion: false,
      wrapup: false,
      reflection: false,
      context,
      runId: "s4-run",
      runState,
    });

    const requestsWithRunState = provider.requests.filter((request) => (
      JSON.stringify(request.messages).includes("[本 run 状态]")
    ));
    assert.ok(requestsWithRunState.length >= 2);
    const finalRequestText = JSON.stringify(provider.requests.at(-1).messages);
    assert.equal(
      (finalRequestText.match(/\[本 run 状态\]/gu) ?? []).length,
      1,
      finalRequestText,
    );
    const stubs = finalRequestText.match(/\[已折叠\][^"]*/gu) ?? [];
    assert.ok(stubs.length >= 1);
    assert.equal(new Set(stubs).size, stubs.length);
    assert.match(JSON.stringify(provider.requests[1].messages), /"rerunOf"/u);
    assert.deepEqual(
      (await readdir(archiveDir)).filter((name) => name.endsWith(".txt")).sort(),
      ["001-exec.txt", "002-exec.txt"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("S5 recalls one run byte-for-byte and rejects invalid or unrecoverable cursors", async () => {
  const runId = "s5-run";
  const original = "memento-recall-原文-0123456789";
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "text", text: original }],
      stopReason: "end_turn",
    },
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "保存一段 bounded recall 测试内容。",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: false,
    store,
    runId,
  });

  const recallOptions = {
    runId,
    fromRound: 1,
    toRound: 1,
    pattern: original,
    limit: 1,
    maxBytes: 7,
  };
  const chunks = [];
  let page = await store.recall(recallOptions);
  assert.equal(page.status, "truncated");
  while (page) {
    chunks.push(page.text);
    if (!page.nextCursor) break;
    page = await store.recall({ ...recallOptions, cursor: page.nextCursor });
  }
  assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "utf8"))).toString("utf8"), original);

  const firstPage = await store.recall(recallOptions);
  const tampered = await store.recall({
    ...recallOptions,
    cursor: `${firstPage.nextCursor}x`,
  });
  assert.equal(tampered.status, "cursor_mismatch");
  assert.equal(tampered.error.code, "cursor_mismatch");
  assert.equal(tampered.text, "");

  const outOfBounds = await store.recall({
    ...recallOptions,
    fromRound: 99,
    toRound: 100,
  });
  assert.equal(outOfBounds.status, "unrecoverable");
  assert.equal(outOfBounds.text, "");
});
