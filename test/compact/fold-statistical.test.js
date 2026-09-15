import test from "node:test";
import assert from "node:assert/strict";

import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import {
  createDeterministicRunState,
  renderRunState,
  upsertRunStateInMessages,
} from "../../src/run-state.js";

test("prepends a deterministic tool-footprint summary before the head user task", async () => {
  const messages = [
    { role: "user", content: "initial request" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "writeFile", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "written" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "b", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "b", content: "ran" }],
    },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const strategy = createFoldStatisticalStrategy();
  const result = await strategy.compact(messages, { keepRounds: 1, budgetTokens: 0 });
  const summary =
    "【上下文折叠·v1·erix-9f6e2c】早期第 1–2 轮（共 2 轮）已折叠。工具足迹：exec×1, writeFile×1。需要原文请重读文件或查看持久笔记；关键值应当已落盘";

  assert.equal(strategy.name, "fold-statistical");
  assert.deepEqual(result.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: summary },
        { type: "text", text: "initial request" },
      ],
    },
    messages[5],
  ]);
  assert.deepEqual(result.foldedPayload, messages.slice(1, 5));
  assert.equal(result.foldedRounds, 2);
  assert.equal(result.compacted, true);
  assert.equal(JSON.stringify(result), JSON.stringify(
    await strategy.compact(messages, { keepRounds: 1, budgetTokens: 0 }),
  ));
});

test("appends a summary to array user content without adding a message", async () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "request" }] },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "assistant", content: [{ type: "text", text: "new" }] },
  ];
  const result = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(result.messages[0].content[0].text, /工具足迹：无/);
  assert.deepEqual(result.messages[0].content[1], messages[0].content[0]);
  assert.equal(result.messages[0].content.length, 2);
});

test("omits recall from the default summary and accepts an injected recovery hint", async () => {
  const messages = [
    { role: "user", content: "request" },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "recent" },
  ];
  const defaultResult = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 });
  const defaultSummary = defaultResult.messages[0].content[0].text;
  assert.doesNotMatch(defaultSummary, /recall/i);

  const hint = "恢复提示：请查看 durable-notes.md";
  const customResult = await createFoldStatisticalStrategy({ recoveryHint: hint })
    .compact(messages, { keepRounds: 1 });
  assert.match(customResult.messages[0].content[0].text, new RegExp(hint));
});

test("includes an archive path in a deterministic recovery hint", async () => {
  const archiveDir = "/tmp/erix-archive-recovery";
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: "request" },
    { role: "assistant", content: "old" },
    { role: "user", content: "recent" },
  ], {
    keepRounds: 1,
    recoveryHint: `早期轮次的工具输出原文已归档到 ${archiveDir}。必须先读取归档；不要重跑命令。`,
  });

  assert.match(result.messages[0].content[0].text, new RegExp(archiveDir));
  assert.match(result.messages[0].content[0].text, /必须先读取归档/u);
  assert.match(result.messages[0].content[0].text, /不要重跑命令/u);
});

test("merges consecutive fold summaries into one block before the task", async () => {
  const firstMessages = [
    { role: "user", content: "keep this task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "done" }],
    },
    { role: "assistant", content: [{ type: "text", text: "phase one" }] },
  ];
  const strategy = createFoldStatisticalStrategy();
  const first = await strategy.compact(firstMessages, {
    keepRounds: 1,
    roundNumbers: [1, 2],
  });
  const second = await strategy.compact([
    ...first.messages,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "b", name: "writeFile", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "b", content: "written" }],
    },
    { role: "assistant", content: [{ type: "text", text: "phase two" }] },
  ], {
    keepRounds: 1,
    roundNumbers: [2, 3, 4],
  });

  const task = second.messages[0];
  const summaries = task.content.filter((block) => (
    block.type === "text" && block.text.startsWith("【上下文折叠·v1·erix-9f6e2c】")
  ));
  assert.equal(summaries.length, 1);
  assert.match(task.content[0].text, /【上下文折叠·v1·erix-9f6e2c】/); // 摘要在 content 最前
  assert.ok(task.content.some((block) => block.text === "keep this task")); // 任务原文仍保留
  assert.match(summaries[0].text, /早期第 1–3 轮（共 3 轮）已折叠/);
  assert.match(summaries[0].text, /exec×1, writeFile×1/);
  assert.equal(second.messages.length, 2);
});

test("call-level undefined does not clear factory options", async () => {
  const result = await createFoldStatisticalStrategy({ summaryRole: "system" }).compact([
    { role: "user", content: "task" },
    { role: "assistant", content: "old" },
    { role: "user", content: "recent" },
  ], { keepRounds: 1, summaryRole: undefined });
  assert.equal(result.messages[0].role, "system");
});

test("legacy fold summaries are read but never removed from user content", async () => {
  const legacy = "【上下文折叠】早期第 1–1 轮（共 1 轮）已折叠。工具足迹：无。可用 recall(pattern: \"关键词\") 搜回细节，或 recall(fromRound: 1, toRound: 1) 取原文（大段可能截断，优先关键词）。";
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: legacy },
    { role: "assistant", content: "old" },
    { role: "user", content: "recent" },
  ], { keepRounds: 1 });
  assert.ok(result.messages[0].content.some((block) => block.text === legacy));
});

test("retains an injected stub for a folded non-replayable tool result", async () => {
  const messages = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "capture", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "capture",
        replayable: false,
        artifact: { archivePath: "/tmp/001-exec.txt" },
        content: "nonce=hidden",
      }],
    },
    { role: "assistant", content: "old" },
    { role: "user", content: "keep" },
  ];
  const result = await createFoldStatisticalStrategy().compact(messages, {
    keepRounds: 1,
    stubFor: () => "[已折叠] 本命令不可重放；值：nonce=abc123；原文：/tmp/001-exec.txt",
  });
  const summary = result.messages[0].content[0].text;
  assert.match(summary, /nonce=abc123/u);
  assert.doesNotMatch(summary, /nonce=hidden/u);
});

test("does not change folding when no stub hook is injected", async () => {
  const messages = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "capture", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "capture",
        replayable: false,
        content: "hidden",
      }],
    },
    { role: "assistant", content: "old" },
    { role: "user", content: "keep" },
  ];
  const result = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 });
  assert.doesNotMatch(JSON.stringify(result.messages), /hidden/u);
});

test("records bounded navigation without values and preserves archive digests", async () => {
  const messages = [{ role: "user", content: "task" }];
  const artifacts = [];
  for (let index = 1; index <= 12; index += 1) {
    const digest = String(index.toString(16)).repeat(64).slice(0, 64);
    const artifact = {
      artifactId: `${String(index).padStart(3, "0")}-exec.txt`,
      archivePath: `/tmp/archive/${index}-exec.txt`,
      digest,
      locator: { lineStart: 1, lineEnd: 2 },
    };
    artifacts.push(artifact);
    messages.push(
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: `use-${index}`,
          name: "exec",
          input: {},
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: `use-${index}`,
          replayable: false,
          artifact,
          content: `credential=must-not-enter-summary-${index}`,
        }],
      },
    );
  }
  messages.push({ role: "user", content: "keep" });

  const result = await createFoldStatisticalStrategy().compact(messages, {
    keepRounds: 1,
    roundNumbers: Array.from({ length: 25 }, (_, index) => index + 1),
    stubFor: () => "[已折叠] 原文：/tmp/archive/001-exec.txt（不可重放）",
  });

  assert.deepEqual(result.foldedRoundRange, { from: 1, to: 12 });
  assert.equal(result.navigationRecord.roundFrom, 1);
  assert.equal(result.navigationRecord.roundTo, 12);
  assert.ok(result.navigationRecord.artifacts.length <= 10);
  assert.ok(result.navigationRecord.artifacts.length > 0);
  assert.equal(result.navigationRecord.truncated, true);
  assert.ok(JSON.stringify(result.navigationRecord).length <= 400);
  assert.deepEqual(
    result.navigationRecord.artifacts[0],
    {
      id: "001-exec.txt",
      locator: { lineStart: 1, lineEnd: 2 },
      digest: artifacts[0].digest,
      status: "archived",
    },
  );
  const summary = result.messages[0].content[0].text;
  assert.match(summary, /导航记录：/u);
  assert.doesNotMatch(summary, /must-not-enter-summary/u);
  assert.match(summary, /\[已折叠\]/u);
});

test("keeps opaque resource locators and host display strings unchanged", async () => {
  const locator = { bucket: "archives", key: "opaque/001" };
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "opaque", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "opaque",
        replayable: false,
        artifact: {
          locator,
          display: "db://archives/opaque/001",
          digest: "b".repeat(64),
        },
        content: "opaque content",
      }],
    },
    { role: "user", content: "keep" },
  ], { keepRounds: 1 });

  assert.deepEqual(result.navigationRecord.artifacts[0].locator, locator);
  assert.equal(result.navigationRecord.artifacts[0].display, "db://archives/opaque/001");
  assert.equal(result.navigationRecord.artifacts[0].id, "db:__archives_opaque_001");
});

test("preserves legacy archive identifiers and explicit navigation statuses", async () => {
  for (const status of ["archived", "external", "expired"]) {
    const artifact = {
      archivePath: `/tmp/archive/${status}.txt`,
      locator: { lineStart: 1, lineEnd: 1 },
      digest: "e".repeat(64),
      status,
    };
    const result = await createFoldStatisticalStrategy().compact([
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_use", id: status, name: "exec", input: {} }] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: status,
          replayable: false,
          artifact,
          content: "hidden",
        }],
      },
      { role: "user", content: "keep" },
    ], { keepRounds: 1 });
    assert.equal(
      result.navigationRecord.artifacts[0].id,
      artifact.archivePath.replaceAll(/[^\p{L}\p{N}._:-]/gu, "_").slice(0, 80),
    );
    assert.equal(result.navigationRecord.artifacts[0].status, status);
  }
});

test("no-artifact-id keeps the legacy navigation record byte-identical", async () => {
  const baseArtifact = {
    archivePath: "/tmp/archive/no-id.txt",
    locator: { lineStart: 1, lineEnd: 1 },
    digest: "f".repeat(64),
  };
  const messages = (artifact) => [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "tool_use", id: "no-id", name: "exec", input: {} }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "no-id",
        replayable: false,
        artifact,
        content: "hidden",
      }],
    },
    { role: "user", content: "keep" },
  ];
  const withoutId = await createFoldStatisticalStrategy().compact(messages(baseArtifact), {
    keepRounds: 1,
  });
  const withFallbackId = await createFoldStatisticalStrategy().compact(
    messages({ artifactId: baseArtifact.archivePath, ...baseArtifact }),
    { keepRounds: 1 },
  );
  assert.equal(
    JSON.stringify(withoutId.navigationRecord),
    JSON.stringify(withFallbackId.navigationRecord),
  );
});

test("materializes fold resources through ResourceStore before rendering stubs", async () => {
  const calls = [];
  const result = await createFoldStatisticalStrategy({
    resourceStore: {
      async put(resource) {
        calls.push(resource);
        return {
          locator: { token: "opaque-token" },
          digest: "c".repeat(64),
          display: "object://bucket/resource-1",
        };
      },
      async get() {
        return "resource";
      },
    },
  }).compact([
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "resource", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "resource",
        replayable: false,
        artifact: { resource: "archive bytes" },
        content: "archive bytes",
      }],
    },
    { role: "user", content: "keep" },
  ], {
    keepRounds: 1,
    stubFor: (message) => `display=${message.content[0].artifact.display}`,
  });

  assert.deepEqual(calls, ["archive bytes"]);
  assert.match(result.messages[0].content[0].text, /object:\/\/bucket\/resource-1/u);
  assert.deepEqual(result.navigationRecord.artifacts[0].locator, { token: "opaque-token" });
});

test("replaces summaries, navigation, and stubs across two and three folds", async () => {
  const strategy = createFoldStatisticalStrategy();
  const artifact = (id) => ({
    artifactId: id,
    digest: id.replace(/\D/gu, "a").repeat(64).slice(0, 64),
    locator: { lineStart: 1, lineEnd: 1 },
  });
  const first = await strategy.compact([
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "exec", input: {} }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "a",
        replayable: false,
        artifact: artifact("001-exec.txt"),
        content: "first-secret",
      }],
    },
    { role: "assistant", content: "old" },
    { role: "user", content: "keep" },
  ], {
    keepRounds: 1,
    roundNumbers: [1, 2, 3, 4, 5],
    stubFor: () => "[已折叠] first-pointer",
  });
  const firstWithState = upsertRunStateInMessages(
    first.messages,
    renderRunState(createDeterministicRunState({
      runId: "fold-regression",
      stateVersion: 1,
      rounds: 1,
      maxRounds: 3,
    })),
  );
  const second = await strategy.compact([
    ...firstWithState,
    { role: "assistant", content: [{ type: "tool_use", id: "b", name: "exec", input: {} }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "b",
        replayable: false,
        artifact: artifact("002-exec.txt"),
        content: "second-secret",
      }],
    },
    { role: "user", content: "keep again" },
  ], {
    keepRounds: 1,
    roundNumbers: [2, 3, 4, 5, 6],
    stubFor: (message) => message.content[0].tool_use_id === "b"
      ? "[已折叠] second-pointer"
      : "[已折叠] first-pointer",
  });

  const secondWithState = upsertRunStateInMessages(
    second.messages,
    renderRunState(createDeterministicRunState({
      runId: "fold-regression",
      stateVersion: 2,
      rounds: 2,
      maxRounds: 3,
    })),
  );
  const secondText = secondWithState[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal((secondText.match(/上下文折叠/gu) ?? []).length, 1);
  assert.equal((secondText.match(/导航记录：/gu) ?? []).length, 1);
  assert.equal((secondText.match(/\[已折叠\]/gu) ?? []).length, 2);
  assert.equal((secondText.match(/\[run state deterministic v1\]/gu) ?? []).length, 1);
  const third = await strategy.compact([
    ...secondWithState,
    { role: "assistant", content: [{ type: "tool_use", id: "c", name: "exec", input: {} }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "c",
        replayable: false,
        artifact: artifact("003-exec.txt"),
        content: "third-secret",
      }],
    },
    { role: "user", content: "keep final" },
  ], {
    keepRounds: 1,
    roundNumbers: [3, 4, 5, 6, 7],
    stubFor: (message) => {
      const id = message.content[0].tool_use_id;
      return `[已折叠] ${id === "c" ? "third" : id === "b" ? "second" : "first"}-pointer`;
    },
  });
  const thirdWithState = upsertRunStateInMessages(
    third.messages,
    renderRunState(createDeterministicRunState({
      runId: "fold-regression",
      stateVersion: 3,
      rounds: 3,
      maxRounds: 3,
    })),
  );
  const text = thirdWithState[0].content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.equal((text.match(/导航记录：/gu) ?? []).length, 1);
  assert.equal((text.match(new RegExp("上下文折叠", "gu")) ?? []).length, 1);
  assert.equal((text.match(/\[已折叠\]/gu) ?? []).length, 3);
  assert.equal((text.match(/first-pointer/gu) ?? []).length, 1);
  assert.equal((text.match(/second-pointer/gu) ?? []).length, 1);
  assert.equal((text.match(/third-pointer/gu) ?? []).length, 1);
  assert.equal((text.match(/\[run state deterministic v1\]/gu) ?? []).length, 1);
  assert.doesNotMatch(text, /first-secret|second-secret|third-secret/u);
});
