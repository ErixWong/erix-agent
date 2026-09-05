import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseChatArgs, runChat } from "../bin/cli.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { runToolLoop } from "../src/loop.js";
import { createRecallTool } from "../src/tools/index.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

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

test("parseChatArgs accepts the reflection switch", () => {
  assert.equal(parseChatArgs(["hello", "--reflection", "on"]).reflection, true);
  assert.equal(parseChatArgs(["hello", "--reflection", "off"]).reflection, false);
  assert.equal(parseChatArgs(["hello", "--timeout", "1500"]).timeoutMs, 1500);
});

test("chat loop wires a file transcript store and recall tool", async () => {
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
      maxRounds: 1,
    });

    assert.ok(provider.requests[0].tools.some((tool) => tool.name === "recall"));
    const records = await createFileTranscriptStore({ dir }).load("chat-wiring");
    assert.deepEqual(records.map((record) => record.round), [0, 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file transcript preserves folded payload for recall", async () => {
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
    const recall = createRecallTool({ store, runId: "fold-file" });
    assert.match(await recall.execute({ pattern: "fold-me" }), /fold-me/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat creates distinct default sessions and recall finds the second prompt", async () => {
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
    const secondRunId = runIds[records.indexOf(secondRun)];
    const recall = createRecallTool({ store, runId: secondRunId });
    assert.match(await recall.execute({ pattern: "second-prompt" }), /second-prompt/);
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
