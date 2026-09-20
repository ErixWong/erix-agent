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
