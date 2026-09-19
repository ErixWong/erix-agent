// TranscriptStore 契约测试套件（ADR-002）
// 任何 TranscriptStore 实现（库内置 memory/file、项目侧 MariaDB/PG 适配器）
// 都必须通过同一组断言。用法：
//   import { transcriptStoreContract } from "erix-agent/contract-tests";
//   transcriptStoreContract("mariadb", () => createMariaTranscriptStore(...));
// 实现特有行为（崩溃恢复/连接管理/清理）由实现方自行补充测试，不进契约。

import test from "node:test";
import assert from "node:assert/strict";

const ROUND_1 = {
  round: 1,
  ts: "2026-08-29T00:00:00.000Z",
  messages: [
    { role: "user", content: [{ type: "text", text: "inspect files" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "list", input: { path: "." } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "README.md" }] },
  ],
};
const ROUND_2 = {
  round: 2,
  ts: "2026-08-29T00:01:00.000Z",
  messages: [{ role: "assistant", content: [{ type: "text", text: "summary" }] }],
};

function decodeCursorForTest(cursor) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

function encodeCursorForTest(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * @param {string} label 实现名（测试标题前缀）
 * @param {() => object | Promise<object>} createStore 每次调用返回干净的新 store
 */
export function transcriptStoreContract(label, createStore) {
  test(`${label}: append/load 往返保真（块结构与元数据）`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", ROUND_1);
    await store.appendRound("run-1", ROUND_2);

    const loaded = await store.load("run-1");
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded[0].messages, ROUND_1.messages);
    assert.deepEqual(loaded[1].messages, ROUND_2.messages);
    assert.equal(loaded[0].round, 1);
    assert.equal(loaded[0].ts, ROUND_1.ts);
  });

  test(`${label}: load 未知 runId 返回空数组`, async () => {
    const store = await createStore();
    assert.deepEqual(await store.load("nonexistent-run"), []);
  });

  test(`${label}: 多 runId 隔离`, async () => {
    const store = await createStore();
    await store.appendRound("run-a", ROUND_1);
    await store.appendRound("run-b", ROUND_2);

    assert.equal((await store.load("run-a")).length, 1);
    assert.equal((await store.load("run-b")).length, 1);
    assert.equal((await store.load("run-a"))[0].round, 1);
    assert.equal((await store.load("run-b"))[0].round, 2);
  });

  test(`${label}: recall 范围过滤与文本化规则`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", ROUND_1);
    await store.appendRound("run-1", ROUND_2);

    // 文本化：text 取 text；tool_use 取 name+JSON.stringify(input)；tool_result 取 content；换行连接
    assert.equal(
      await store.recall("run-1", 1, 1),
      'inspect files\nlist{"path":"."}\nREADME.md',
    );
    assert.equal(await store.recall("run-1", 2, 2), "summary");
    assert.equal(await store.recall("run-1", 3, 9), "");
  });

  test(`${label}: recall pattern 子串过滤`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", ROUND_1);
    await store.appendRound("run-1", ROUND_2);

    assert.equal(await store.recall("run-1", undefined, undefined, "README"), "README.md");
    assert.equal(await store.recall("run-1", undefined, undefined, "不存在的关键词"), "");
    assert.equal(await store.recall("missing-run", undefined, undefined, "README"), "");
  });

  test(`${label}: checkpoint 三件套往返保真与追加语义`, async () => {
    const store = await createStore();
    const first = {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      status: "pending",
      pendingToolUse: { id: "tool-1", name: "inspect", input: { path: "." } },
      messages: [{ role: "assistant", content: "before" }],
    };
    const latest = {
      round: 2,
      status: "executed",
      pendingToolUse: { id: "tool-2", name: "write", input: { path: "out" } },
      toolResults: [{ toolUseId: "tool-2", toolResult: { content: "ok" } }],
    };

    await store.saveCheckpoint("checkpoint-run", first);
    await store.appendCheckpoint("checkpoint-run", latest);

    assert.deepEqual(await store.loadLatestCheckpoint("checkpoint-run"), latest);
  });

  test(`${label}: checkpoint 未知 runId 返回 undefined`, async () => {
    const store = await createStore();
    assert.equal(await store.loadLatestCheckpoint("missing-checkpoint-run"), undefined);
  });

  test(`${label}: checkpoint/run-state 多 runId 隔离`, async () => {
    const store = await createStore();
    await store.saveCheckpoint("run-a", {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      status: "pending",
      pendingToolUse: { id: "a" },
    });
    await store.appendCheckpoint("run-b", {
      round: 2,
      ts: "2026-08-29T00:02:00.000Z",
      status: "executed",
      pendingToolUse: { id: "b" },
    });
    await store.saveRunState("run-a", { stateVersion: 1, deterministic: { rounds: 1 } });
    await store.saveRunState("run-b", { stateVersion: 2, deterministic: { rounds: 2 } });
    await store.markRunState("run-a", "failed");
    await store.markRunState("run-b", "succeeded");

    assert.equal((await store.loadLatestCheckpoint("run-a")).pendingToolUse.id, "a");
    assert.equal((await store.loadLatestCheckpoint("run-b")).pendingToolUse.id, "b");
    assert.equal((await store.loadRunState("run-a")).state, "failed");
    assert.equal((await store.loadRunState("run-b")).state, "succeeded");
    assert.equal((await store.loadRunState("run-a")).stateVersion, 1);
    assert.equal((await store.loadRunState("run-b")).stateVersion, 2);
  });

  test(`${label}: checkpoint/run-state 写失败向上抛出`, async () => {
    const store = await createStore();
    const methods = [
      ["saveCheckpoint", ["failed-run", { round: 1 }]],
      ["appendCheckpoint", ["failed-run", { round: 1 }]],
      ["saveRunState", ["failed-run", { stateVersion: 1 }]],
      ["markRunState", ["failed-run", "failed"]],
    ];

    for (const [method, args] of methods) {
      const expected = new Error(`${method} unavailable`);
      store[method] = async () => {
        throw expected;
      };
      await assert.rejects(
        store[method](...args),
        (error) => error === expected,
      );
    }
  });

  test(`${label}: run-state 三件套往返保真与 mark 合并语义`, async () => {
    const store = await createStore();
    await store.saveRunState("state-run", {
      stateVersion: 3,
      deterministic: { rounds: 2 },
      semantic: { text: "summary", version: 1 },
    });
    await store.markRunState("state-run", "succeeded");

    const state = await store.loadRunState("state-run");
    assert.equal(state.runId, "state-run");
    assert.equal(state.state, "succeeded");
    assert.equal(state.stateVersion, 3);
    assert.deepEqual(state.deterministic, { rounds: 2 });
    assert.deepEqual(state.semantic, { text: "summary", version: 1 });
  });

  test(`${label}: run-state 未知 runId 返回 undefined`, async () => {
    const store = await createStore();
    assert.equal(await store.loadRunState("missing-state-run"), undefined);
  });

  test(`${label}: bounded recall 在源头限制并支持无重复续取`, async () => {
    const store = await createStore();
    for (let round = 1; round <= 24; round += 1) {
      await store.appendRound("bounded-run", {
        round,
        ts: "2026-08-29T00:00:00.000Z",
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: `round-${round}-${"x".repeat(120)}` }],
        }],
      });
    }

    const chunks = [];
    let page = await store.recall({
      runId: "bounded-run",
      fromRound: 1,
      toRound: 24,
      limit: 2,
      maxBytes: 256,
    });
    assert.equal(page.status, "truncated");
    assert.equal(page.truncated, true);
    assert.ok(Buffer.byteLength(page.text, "utf8") <= 256);
    chunks.push(page.text);
    while (page.nextCursor) {
      page = await store.recall({
        runId: "bounded-run",
        fromRound: 1,
        toRound: 24,
        limit: 2,
        maxBytes: 256,
        cursor: page.nextCursor,
      });
      assert.ok(Buffer.byteLength(page.text, "utf8") <= 256);
      chunks.push(page.text);
    }
    const combined = chunks.join("");
    assert.equal((combined.match(/round-/gu) ?? []).length, 24);
    for (let round = 1; round <= 24; round += 1) {
      assert.equal((combined.match(new RegExp(`round-${round}-`, "g")) ?? []).length, 1);
    }
  });

  test(`${label}: bounded recall 篡改游标字段即拒绝且不返回正文`, async () => {
    const store = await createStore();
    await store.appendRound("integrity-run", {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "needle-first-content" }],
      }],
    });
    await store.appendRound("integrity-run", {
      round: 2,
      ts: "2026-08-29T00:02:00.000Z",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "needle-second-content" }],
      }],
    });

    const first = await store.recall({
      runId: "integrity-run",
      fromRound: 1,
      toRound: 2,
      pattern: "needle",
      limit: 2,
      maxBytes: 7,
    });
    assert.equal(first.status, "truncated");
    assert.ok(first.nextCursor);
    const cursor = decodeCursorForTest(first.nextCursor);
    const mutations = {
      byteOffset: cursor.byteOffset + 1,
      recordIndex: cursor.recordIndex + 1,
      runId: "other-run",
      fromRound: 0,
      toRound: 1,
      pattern: "other",
      limit: 1,
      maxBytes: 8,
    };

    for (const [field, value] of Object.entries(mutations)) {
      const tampered = { ...cursor, [field]: value };
      const result = await store.recall({
        runId: "integrity-run",
        fromRound: 1,
        toRound: 2,
        pattern: "needle",
        limit: 2,
        maxBytes: 7,
        cursor: encodeCursorForTest(tampered),
      });
      assert.equal(result.status, "cursor_mismatch", field);
      assert.equal(result.text, "", field);
      assert.equal(result.error.code, "cursor_mismatch", field);
    }
  });

  test(`${label}: bounded recall 合法游标可跨记录按 pattern 无重不漏续取`, async () => {
    const store = await createStore();
    for (let round = 1; round <= 3; round += 1) {
      await store.appendRound("pattern-run", {
        round,
        ts: "2026-08-29T00:00:00.000Z",
        messages: [{
          role: "assistant",
          content: [
            { type: "text", text: `needle-${round}` },
            { type: "text", text: `noise-${round}` },
          ],
        }],
      });
    }

    const chunks = [];
    let page = await store.recall({
      runId: "pattern-run",
      fromRound: 1,
      toRound: 3,
      pattern: "needle",
      maxBytes: 8,
    });
    chunks.push(page.text);
    while (page.nextCursor) {
      page = await store.recall({
        runId: "pattern-run",
        fromRound: 1,
        toRound: 3,
        pattern: "needle",
        maxBytes: 8,
        cursor: page.nextCursor,
      });
      chunks.push(page.text);
    }
    const combined = chunks.join("");
    assert.equal(combined, "needle-1needle-2needle-3");
    for (let round = 1; round <= 3; round += 1) {
      assert.equal((combined.match(new RegExp(`needle-${round}`, "g")) ?? []).length, 1);
      assert.equal(combined.includes(`noise-${round}`), false);
    }
  });

  test(`${label}: bounded recall 拒绝未知版本、非法 base64、非 JSON 与空游标`, async () => {
    const store = await createStore();
    await store.appendRound("invalid-cursor-run", {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "visible" }] }],
    });
    const first = await store.recall({
      runId: "invalid-cursor-run",
      maxBytes: 3,
    });
    assert.equal(first.status, "truncated");
    const decoded = decodeCursorForTest(first.nextCursor);
    const invalidCursors = [
      "",
      "not-base64!",
      Buffer.from("not json", "utf8").toString("base64url"),
      encodeCursorForTest({ ...decoded, v: 99 }),
    ];

    for (const cursor of invalidCursors) {
      const result = await store.recall({
        runId: "invalid-cursor-run",
        maxBytes: 3,
        cursor,
      });
      assert.equal(result.status, "cursor_mismatch");
      assert.equal(result.text, "");
      assert.equal(result.error.code, "cursor_mismatch");
    }
  });

  test(`${label}: bounded recall 显式报告缺失轮次与陈旧游标`, async () => {
    const store = await createStore();
    await store.appendRound("bounded-run", {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }],
    });
    await store.appendRound("bounded-run", {
      round: 2,
      ts: "2026-08-29T00:02:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "two" }] }],
    });

    const first = await store.recall({
      runId: "bounded-run",
      fromRound: 1,
      toRound: 2,
      limit: 1,
      maxBytes: 10,
    });
    assert.equal(first.status, "truncated");
    await store.appendRound("bounded-run", {
      round: 3,
      ts: "2026-08-29T00:03:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "three" }] }],
    });
    const stale = await store.recall({
      runId: "bounded-run",
      fromRound: 1,
      toRound: 2,
      limit: 1,
      maxBytes: 10,
      cursor: first.nextCursor,
    });
    assert.equal(stale.status, "stale");

    const missing = await store.recall({
      runId: "bounded-run",
      fromRound: 9,
      toRound: 9,
    });
    assert.equal(missing.status, "unrecoverable");
  });

  test(`${label}: bounded recall 绑定 limit/maxBytes/artifactRef 并拒绝零上限`, async () => {
    const store = await createStore();
    await store.appendRound("artifact-run", {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      messages: [{
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "first-artifact",
            artifact: { artifactId: "first.txt", digest: "digest-first" },
          },
          {
            type: "tool_result",
            content: "second-artifact",
            artifact: { artifactId: "second.txt", digest: "digest-second" },
          },
        ],
      }],
    });

    const first = await store.recall({
      runId: "artifact-run",
      artifactRef: "first.txt",
      limit: 1,
      maxBytes: 5,
    });
    assert.equal(first.status, "truncated");
    assert.equal(first.text, "first");
    const mismatch = await store.recall({
      runId: "artifact-run",
      artifactRef: "first.txt",
      limit: 2,
      maxBytes: 5,
      cursor: first.nextCursor,
    });
    assert.equal(mismatch.status, "stale");

    const zeroBytes = await store.recall({
      runId: "artifact-run",
      limit: 1,
      maxBytes: 0,
    });
    assert.equal(zeroBytes.status, "error");
    assert.equal(zeroBytes.nextCursor, undefined);
    const zeroItems = await store.recall({
      runId: "artifact-run",
      limit: 0,
      maxBytes: 64,
    });
    assert.equal(zeroItems.status, "error");
    assert.equal(zeroItems.nextCursor, undefined);
  });

  test(`${label}: bounded recall detects large internal range gaps`, async () => {
    const store = await createStore();
    await store.appendRound("gap-run", {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }],
    });
    await store.appendRound("gap-run", {
      round: 100001,
      ts: "2026-08-29T00:41:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "last" }] }],
    });
    const result = await store.recall({
      runId: "gap-run",
      fromRound: 1,
      toRound: 100001,
      maxBytes: 64,
    });
    assert.equal(result.status, "unrecoverable");
  });

  test(`${label}: recall 覆盖 foldedPayload（折叠原文同属档案）`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", {
      round: 2,
      folded: true,
      ts: "2026-08-29T00:02:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "当轮消息" }] }],
      foldedPayload: [
        { role: "user", content: [{ type: "text", text: "折叠原文中的阈值 42.5" }] },
      ],
    });

    const byPattern = await store.recall("run-1", undefined, undefined, "42.5");
    assert.ok(byPattern.includes("42.5"), "pattern 应命中 foldedPayload");
    const byRange = await store.recall("run-1", 2, 2);
    assert.ok(byRange.includes("42.5"), "范围查询应含 foldedPayload");
    assert.ok(byRange.includes("当轮消息"), "范围查询也应含当轮消息");
  });

  test(`${label}: round 0 种子记录与保序（初始消息入档，loop resume 依赖）`, async () => {
    const store = await createStore();
    await store.appendRound("run-1", {
      round: 0,
      ts: "2026-08-29T00:00:00.000Z",
      messages: [{ role: "user", content: [{ type: "text", text: "seed initial context" }] }],
    });
    await store.appendRound("run-1", ROUND_1);
    await store.appendRound("run-1", ROUND_2);

    const loaded = await store.load("run-1");
    assert.deepEqual(loaded.map((r) => r.round), [0, 1, 2]);
    assert.ok((await store.recall("run-1", 0, 0)).includes("seed initial context"));
  });

  test(`${label}: folded/foldedPayload 元数据往返`, async () => {
    const store = await createStore();
    const payload = [
      { role: "user", content: [{ type: "text", text: "early" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ];
    await store.appendRound("run-1", {
      round: 5, folded: true, ts: "2026-08-29T00:05:00.000Z", messages: ROUND_2.messages, foldedPayload: payload,
    });

    const loaded = await store.load("run-1");
    assert.equal(loaded[0].folded, true);
    assert.deepEqual(loaded[0].foldedPayload, payload);
  });
}
