// TranscriptStore 契约测试套件（ADR-002）
// 任何 TranscriptStore 实现（库内置 memory/file、项目侧 MariaDB/PG 适配器）
// 都必须通过同一组断言。用法：
//   import { transcriptStoreContract } from "@erix/llm-kit/contract-tests";
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
