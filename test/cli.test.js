import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { exitCodeForVerification, parseChatArgs, runChat } from "../bin/cli.js";
import { getMcpPoolStatus } from "../bin/mcp.js";
import {
  buildArchiveSystemPrompt,
  buildArchiveRecoveryHint,
  buildValueNotesIndexPrompt,
  CLI_TOOLS_SYSTEM_PROMPT,
} from "../bin/tools.js";
import * as notes from "../skills/notes/skill.mjs";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { runToolLoop } from "../src/loop.js";
import { createRecallTool } from "../src/tools/index.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("CLI prompt constrains provenance of one-shot values", () => {
  assert.match(
    CLI_TOOLS_SYSTEM_PROMPT,
    /一次性生成的值（随机数、时间戳、临时 token、不可复现的命令输出）只能引用首次出现的工具返回/u,
  );
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /不得通过重跑命令“恢复”/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /关键值应在产生时落盘（写文件\/持久笔记）/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /原值已不在上下文且无持久记录时，明确说明不可恢复，不得给出替代值/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /具体数值\/一次性输出，必须来自当前上下文中的工具返回或归档文件；不得凭记忆给出/u);
  assert.match(
    CLI_TOOLS_SYSTEM_PROMPT,
    /工具输出较大或被截断时，返回末尾会给出完整输出的归档路径/u,
  );
  assert.match(
    CLI_TOOLS_SYSTEM_PROMPT,
    /归档路径（例如 ~\/\.erix\/transcripts\/outputs\/\.\.\.，仅指本次运行的工具输出）是例外，可以且应当读取/u,
  );
});

test("CLI uses distinct nonzero exits for unverified and guard errors", () => {
  assert.equal(exitCodeForVerification({ status: "verified" }), 0);
  assert.equal(exitCodeForVerification({ status: "unverified" }), 2);
  assert.equal(exitCodeForVerification({ status: "error" }), 3);
});

test("archive system prompt names the absolute directory only when enabled", () => {
  const prompt = buildArchiveSystemPrompt("relative/archive");
  assert.match(prompt, new RegExp(resolve("relative/archive").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(prompt, /不要重跑命令/u);
  assert.equal(buildArchiveSystemPrompt(undefined), "");
  assert.equal(buildArchiveSystemPrompt(""), "");
});

test("archive recovery hint is actionable and omitted without an archive directory", () => {
  const hint = buildArchiveRecoveryHint("relative/archive");
  assert.match(hint, new RegExp(resolve("relative/archive").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(hint, /优先直接调用 note_read key=<key>/u);
  assert.match(hint, /archivePath \+ locator/u);
  assert.match(hint, /禁止遍历归档目录/u);
  assert.match(hint, /不要重跑命令/u);
  assert.equal(buildArchiveRecoveryHint(undefined), undefined);
  assert.equal(buildArchiveRecoveryHint(""), undefined);
});

test("value note index prompt is absent when empty and never includes values", () => {
  assert.equal(buildValueNotesIndexPrompt([]), "");
  const prompt = buildValueNotesIndexPrompt([
    { key: "nonce", tags: ["value", "auto"] },
  ]);
  assert.match(prompt, /本 run 自动捕获的值/u);
  assert.match(prompt, /nonce（标签：value、auto）/u);
  assert.match(prompt, /note_read key=<key> 一步取回/u);
  assert.doesNotMatch(prompt, /secret-value/u);
});

test("runChat adds the value-note index to the system prompt without content", async () => {
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
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    assert.match(provider.requests[0].system, /captured-nonce（标签：value、auto）/u);
    assert.doesNotMatch(provider.requests[0].system, /secret-value-must-not-leak/u);
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
    assert.doesNotMatch(emptyProvider.requests[0].system, /\[notes value index\]/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat passes the archive recovery hint through loop context", async () => {
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
    assert.match(
      captured.context.recoveryHint,
      new RegExp(`${resolve(join(dir, "outputs", "chat-recovery"))}`.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
    );
    assert.match(captured.context.recoveryHint, /优先直接调用 note_read key=<key>/u);
    assert.match(captured.context.recoveryHint, /禁止遍历归档目录/u);
    assert.match(captured.context.recoveryHint, /不要重跑命令/u);
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

test("parseChatArgs accepts the reflection switch", () => {
  assert.equal(parseChatArgs(["hello", "--reflection", "on"]).reflection, true);
  assert.equal(parseChatArgs(["hello", "--reflection", "off"]).reflection, false);
  assert.equal(parseChatArgs(["hello", "--timeout", "1500"]).timeoutMs, 1500);
});

test("parseChatArgs supports disabling only the notes skill", () => {
  assert.equal(parseChatArgs(["hello", "--no-notes"]).noNotes, true);
});

test("chat loop wires a file transcript store without a recall tool", async () => {
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

    assert.equal(provider.requests[0].tools.some((tool) => tool.name === "recall"), false);
    assert.match(
      provider.requests[0].system,
      new RegExp(`${dir}/outputs/chat-wiring`),
    );
    assert.match(provider.requests[0].system, /不要重跑命令/u);
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
