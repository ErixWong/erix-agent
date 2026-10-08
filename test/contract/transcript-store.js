// TranscriptStore 契约测试套件（ADR-002，issue #78 分级修订）
// 任何 TranscriptStore 实现（库内置 memory/file、项目侧 MariaDB/PG 适配器）
// 都必须通过同一组断言。用法：
//   import { transcriptStoreContract } from "erix-agent/contract-tests";
//   transcriptStoreContract("mariadb", () => createMariaTranscriptStore(...));
// 实现特有行为（崩溃恢复/连接管理/清理）由实现方自行补充测试，不进契约。
//
// issue #78 capability 分级：必需方法只有 appendRound/load；run snapshot
// （saveRunSnapshot/loadLatestRunSnapshot，latest-only 覆盖写，非多版本 checkpoint）
// 与 run-state（saveRunState/loadRunState/markRunState）为可选 capability。
// issue #157 追加成对可选快路径探针（loadByDedupKey/loadMaxRound）：宿主 store
// 实现时 appendUserTurn 走零 load 点查路径，实现则必须与 load 事实一致（见下）。
// 本套件覆盖完整表面（库内置实现均全量实现）；最小实现（仅必需两方法）的
// 行为由 assembly/persistence 校验测试锁定（缺可选方法不得报错）。

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

  test(`${label}: load 保留同 round 记录的持久化追加顺序`, async () => {
    const store = await createStore();
    const runId = "same-round-order-run";
    const engineKey = `${runId}:engine:round:2`;
    const inputKey = `${runId}:input:m1`;
    await store.appendRound(runId, {
      round: 2,
      dedupKey: engineKey,
      messages: [{ role: "assistant", content: [{ type: "text", text: "engine round" }] }],
    });
    await store.appendRound(runId, {
      round: 2,
      dedupKey: inputKey,
      messages: [{ role: "user", content: [{ type: "text", text: "pre-written user row" }] }],
    });

    const loaded = await store.load(runId);
    assert.deepEqual(loaded.map((record) => record.dedupKey), [engineKey, inputKey]);
    assert.deepEqual(
      loaded.flatMap((record) => record.messages ?? [])
        .map((message) => message.content?.[0]?.text),
      ["engine round", "pre-written user row"],
    );
  });

  test(`${label}: RoundRecord 与 message 未知字段及 source 标记完整往返`, async () => {
    const store = await createStore();
    const record = {
      round: 3,
      ts: "2026-08-29T00:03:00.000Z",
      unknownRoundField: { retained: true },
      messages: [{
        role: "user",
        meta: { source: "judge-control", hostMetadata: { retained: true } },
        content: [{ type: "text", text: "direction hint", unknownBlockField: 1 }],
        unknownMessageField: ["retained"],
      }],
    };

    await store.appendRound("fidelity-run", record);

    assert.deepEqual((await store.load("fidelity-run"))[0], record);
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

  test(`${label}: run snapshot 往返保真与 latest-only 覆盖语义`, async () => {
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
      pendingToolUses: [{
        id: "tool-2",
        name: "write",
        input: { path: "out" },
        replay: "unsafe",
      }],
      toolResults: [{ toolUseId: "tool-2", toolResult: { content: "ok" } }],
    };

    // issue #78：appendCheckpoint 已并入 saveRunSnapshot（两者同为覆盖写），
    // 第二次保存覆盖第一次——latest-only autosave 语义。
    await store.saveRunSnapshot("snapshot-run", first);
    await store.saveRunSnapshot("snapshot-run", latest);

    assert.deepEqual(await store.loadLatestRunSnapshot("snapshot-run"), latest);
  });

  test(`${label}: run snapshot 未知 runId 返回 undefined`, async () => {
    const store = await createStore();
    assert.equal(await store.loadLatestRunSnapshot("missing-snapshot-run"), undefined);
  });

  test(`${label}: run snapshot/run-state 多 runId 隔离`, async () => {
    const store = await createStore();
    await store.saveRunSnapshot("run-a", {
      round: 1,
      ts: "2026-08-29T00:01:00.000Z",
      status: "pending",
      pendingToolUse: { id: "a" },
    });
    await store.saveRunSnapshot("run-b", {
      round: 2,
      ts: "2026-08-29T00:02:00.000Z",
      status: "executed",
      pendingToolUse: { id: "b" },
    });
    await store.saveRunState("run-a", { stateVersion: 1, deterministic: { rounds: 1 } });
    await store.saveRunState("run-b", { stateVersion: 2, deterministic: { rounds: 2 } });
    await store.markRunState("run-a", "failed");
    await store.markRunState("run-b", "succeeded");
    const loadStatus = async (runId) => {
      if (typeof store.loadRunStateStatus === "function") {
        return store.loadRunStateStatus(runId);
      }
      // Legacy path for third-party stores that still embed terminal state in the snapshot.
      return (await store.loadRunState(runId))?.state;
    };

    assert.equal((await store.loadLatestRunSnapshot("run-a")).pendingToolUse.id, "a");
    assert.equal((await store.loadLatestRunSnapshot("run-b")).pendingToolUse.id, "b");
    assert.equal(await loadStatus("run-a"), "failed");
    assert.equal(await loadStatus("run-b"), "succeeded");
    assert.equal((await store.loadRunState("run-a")).stateVersion, 1);
    assert.equal((await store.loadRunState("run-b")).stateVersion, 2);
  });

  test(`${label}: 新写入的 run-state 快照不包含终态 state`, async () => {
    const store = await createStore();
    await store.saveRunState("snapshot-state", {
      stateVersion: 1,
      deterministic: { rounds: 1 },
    });
    await store.markRunState("snapshot-state", "succeeded");

    const snapshot = await store.loadRunState("snapshot-state");
    assert.equal(Object.hasOwn(snapshot, "state"), false);
  });

  test(`${label}: run snapshot/run-state 写失败向上抛出`, async () => {
    const store = await createStore();
    const methods = [
      ["saveRunSnapshot", ["failed-run", { round: 1 }]],
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

  test(`${label}: run-state 快照保真且终态独立读取`, async () => {
    const store = await createStore();
    await store.saveRunState("state-run", {
      stateVersion: 3,
      deterministic: { rounds: 2 },
      semantic: { text: "summary", version: 1 },
    });
    await store.markRunState("state-run", "succeeded");

    const state = await store.loadRunState("state-run");
    assert.equal(state.runId, "state-run");
    const status = typeof store.loadRunStateStatus === "function"
      ? await store.loadRunStateStatus("state-run")
      : state.state; // Legacy path for stores without the host-facing status reader.
    assert.equal(status, "succeeded");
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

  // issue #157 可选快路径探针一致性：appendUserTurn 在宿主 store 实现
  // loadByDedupKey/loadMaxRound 时走点查快路径（全程不调 load）。两者必须
  // 成对实现（缺一如缺二，引擎回退全量 load）；实现则必须与 appendRound/load
  // 的既有事实一致，否则快路径与慢路径会得出不同结论。
  test(`${label}: 可选快路径探针 loadByDedupKey/loadMaxRound 与 load 事实一致（实现时）`, async () => {
    const store = await createStore();
    const hasDedup = typeof store.loadByDedupKey === "function";
    const hasMax = typeof store.loadMaxRound === "function";
    // 成对约束对任何实现都生效（只实现其一是契约违规）。
    assert.equal(hasDedup, hasMax, `${label}: loadByDedupKey/loadMaxRound 必须成对实现（缺一如缺二）`);
    if (!hasDedup) return; // 未实现：回退全量 load，由上方必需用例覆盖。

    // 未命中：返回 null/undefined，不抛错。
    const miss = await store.loadByDedupKey("probe-run", "probe-run:input:none");
    assert.ok(miss === null || miss === undefined, "未命中必须返回 null/undefined");

    // 命中：返回整条已存在记录，与 load 结果逐字段保真（含未知字段）。
    const record = {
      round: 4,
      ts: "2026-08-29T00:04:00.000Z",
      dedupKey: "probe-run:input:m1",
      roundKey: "probe-run:input:m1",
      hostColumn: { retained: true },
      messages: [{ role: "user", content: [{ type: "text", text: "probed" }] }],
    };
    await store.appendRound("probe-run", record);
    assert.deepEqual(await store.loadByDedupKey("probe-run", record.dedupKey), record);
    // dedupKey 缺失时回退 roundKey 匹配（与 appendUserTurn 慢路径判据一致）。
    const roundKeyOnly = { round: 6, roundKey: "probe-run:input:m2", messages: [] };
    await store.appendRound("probe-run", roundKeyOnly);
    assert.deepEqual(await store.loadByDedupKey("probe-run", roundKeyOnly.roundKey), roundKeyOnly);

    // loadMaxRound：与 load 结果的 Math.max(0, 安全整数 round…) 等价。
    assert.equal(await store.loadMaxRound("probe-run"), 6);
    // 空 store：null/undefined/负数（appendUserTurn 均派生 round 0）。
    const empty = await store.loadMaxRound("probe-run-empty");
    assert.ok(empty === null || empty === undefined || (typeof empty === "number" && empty < 0),
      "空 store 的 loadMaxRound 必须返回 null/undefined/负数");
  });
}
