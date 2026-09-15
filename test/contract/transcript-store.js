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

  test(`${label}: bounded recall 在源头限制并支持无重复续取`, async () => {
    const store = await createStore();
    for (let round = 1; round <= 24; round += 1) {
      await store.appendRound("bounded-run", {
        round,
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

  test(`${label}: bounded recall 显式报告缺失轮次与陈旧游标`, async () => {
    const store = await createStore();
    await store.appendRound("bounded-run", {
      round: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }],
    });
    await store.appendRound("bounded-run", {
      round: 2,
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
      messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }],
    });
    await store.appendRound("gap-run", {
      round: 100001,
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
