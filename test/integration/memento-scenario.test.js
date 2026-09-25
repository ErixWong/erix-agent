import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCaptureRecoveryHint, buildCaptureStub } from "../../bin/final-guard.js";
import { createCliTools, wrapExecuteTool } from "../../bin/tools.js";
import { buildCompactionContext } from "../../bin/config.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { estimateMessageTokens } from "../../src/tokens.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

test("S1 folds an early value into the provider request", async () => {
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
  const cliTools = createCliTools({ cwd: directory });
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

test("S2 folds a stub verbatim (no agent-side credential filter, #55) while retaining its archive pointer", async () => {
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
  const cliTools = createCliTools({ cwd: directory });
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
    // ADR-016：stub 值直接取自 tool_result 内容，后续恢复走 note-first 提示（零路径）
    assert.match(foldedStub, /note_list|note_read/u);
    assert.match(foldedStub, new RegExp(safeValue));
    // issue #55：折叠锚点不再凭据过滤——凭据样式的值原样保留；
    // 防敏感信息到达上游 LLM 是 token hub（relay/LiteLLM 网关）的职责。
    assert.match(foldedStub, new RegExp(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("S3 executes a repeated command and returns fresh output (ADR-016)", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-memento-s3-"));
  const command = `printf 'nonce=s3-deterministic\n'; head -c 1 /dev/urandom >/dev/null`;
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
  const cliTools = createCliTools({ cwd: directory });
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
    assert.match(secondResult.content, /nonce=s3-deterministic/u);
    assert.doesNotMatch(secondResult.content, /这是第/u);
    assert.equal(secondResult.rerunOf, undefined);
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
  const cliTools = createCliTools({ cwd: directory });
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
    // ADR-016：重跑原样返回（无 rerunOf 标记）；折叠 unique stub 语义不变
    assert.doesNotMatch(finalRequestText, /"rerunOf"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
