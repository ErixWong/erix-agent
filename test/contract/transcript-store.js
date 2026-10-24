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
      // issue #171：`__` 前缀是宿主保留记账命名空间（引擎不产出也不消费），
      // 但对保真而言它仍是普通未知字段：必须原样往返。
      __hostLedger: { hostWritten: ["unknownRoundField"] },
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

  // ---- issue #401：折叠义务（宿主 store 的 `load()` 必须返回折叠形状）-----------------------
  // 折叠义务在**宿主侧**：引擎写侧一条消息落一行（`kind:"message"` + `seq`，分片带 `partOf`），
  // `load()` 必须在返回前把它们折回轮载体行。在此之前本套件**一格折叠判据都没有**
  // （`grep -c 'kind: "message"' test/contract/transcript-store.js` 当时 = 0），于是 erix-station 那种
  // 「全绿但没折」的自研 store 能安静地过完整个套件，而 resume 侧的时间线从 `[ok]` 掉成 `[pending]`。
  // 实现在包根：`foldMessageRows`（issue #401 R1 导出），宿主可直接用，也可自己重写（口径见契约）。
  const foldRunId = "fold-run";
  const textBlock = (text) => ({ type: "text", text });
  const foldCarrier = (round, messages) => ({
    round,
    ts: "2026-08-29T00:10:00.000Z",
    dedupKey: `${foldRunId}:engine:round:${String(round)}`,
    roundKey: `${foldRunId}:round:${String(round)}`,
    ...(messages === undefined ? {} : { messages }),
  });
  const foldMessageRow = (round, seq, message, extra = {}) => ({
    round,
    ts: "2026-08-29T00:10:00.000Z",
    kind: "message",
    seq,
    dedupKey: `${foldRunId}:msg:${String(round)}:${String(seq)}`,
    messages: [message],
    ...extra,
  });
  // 一轮的真实形状：载体行（只留元数据）+ 三条消息行（assistant 带 tool_use、user 带 tool_result、
  // 第二条 tool_result 是**分片**：`partOf` 指认前一条消息行的 key）。
  // issue #439 A：每条消息行有自己的 `ts`（引擎每条消息落盘时就写），折叠后的每条逻辑消息必须
  // 带上**它自己那一行**的 `ts`（分片折回的那条取**首片**的），否则宿主拿 `load()` 做时间线/延迟
  // 分析时，凡是被折叠过的消息都没有时间戳（载体行自己的 `ts` 是轮行落盘时刻）。
  const foldTs = (second) => `2026-08-29T00:10:${String(second).padStart(2, "0")}.000Z`;
  const foldRound = (round) => {
    const useId = `tool-${String(round)}`;
    const rows = [
      foldCarrier(round),
      foldMessageRow(round, 0, { role: "user", content: [textBlock("inspect files")] }, { ts: foldTs(1) }),
      foldMessageRow(round, 1, {
        role: "assistant",
        content: [{ type: "tool_use", id: useId, name: "list", input: { path: "." } }],
      }, { ts: foldTs(2) }),
      foldMessageRow(round, 2, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: useId, content: "README.md" }],
      }, { ts: foldTs(3) }),
      foldMessageRow(round, 3, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `${useId}-b`, content: "src" }],
      }, { ts: foldTs(4), partOf: `${foldRunId}:msg:${String(round)}:2` }),
    ];
    const expected = [
      { role: "user", content: [textBlock("inspect files")], ts: foldTs(1) },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: useId, name: "list", input: { path: "." } }],
        ts: foldTs(2),
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: useId, content: "README.md" },
          { type: "tool_result", tool_use_id: `${useId}-b`, content: "src" },
        ],
        // 分片折回的那条聚合消息取**首片**（seq 2）的 ts，不是末片（seq 3）的 —— issue #439 A。
        ts: foldTs(3),
      },
    ];
    return { rows, expected };
  };

  test(`${label}: 折叠——消息行按 seq 折回载体行，partOf 分片接进目标消息（issue #401）`, async () => {
    const store = await createStore();
    const { rows, expected } = foldRound(2);
    for (const row of rows) await store.appendRound(foldRunId, row);

    const loaded = await store.load(foldRunId);
    assert.equal(loaded.length, 1,
      `折叠后该轮只剩载体一行（消息行不得以独立行留在数组里）；实测 ${String(loaded.length)} 行：`
      + JSON.stringify(loaded.map((record) => record.dedupKey)));
    assert.equal(loaded[0].dedupKey, `${foldRunId}:engine:round:2`, "正文折回的载体就是那条轮行");
    assert.deepEqual(loaded[0].messages, expected,
      "正文按 `seq` 拼回，且 `partOf` 的分片要**接进目标消息**（同一 content 数组），而不是并列成第二条 user 消息");
  });

  test(`${label}: 折叠幂等——已折叠的账本再读一次逐字一致（issue #401）`, async () => {
    const store = await createStore();
    const { rows, expected } = foldRound(3);
    for (const row of rows) await store.appendRound(foldRunId, row);

    const first = await store.load(foldRunId);
    const second = await store.load(foldRunId);
    assert.deepEqual(first, second, "同一个账本读两次必须逐字相同（折叠层不得带状态）");
    assert.deepEqual(first[0].messages, expected, "两次读都必须是折叠后的形状");
  });

  test(`${label}: 折叠守卫——宿主「两份都留」时正文不得翻倍（issue #401）`, async () => {
    const store = await createStore();
    // 宿主 materializer 自己折了一份（载体行已经带正文），又把原始消息行一起交回去。
    // 按 R3 的规则：该轮载体已有正文 ⇒ 这一轮跳过（消息行当重复副本丢弃），正文条数不得翻倍。
    const { rows, expected } = foldRound(4);
    await store.appendRound(foldRunId, { ...rows[0], messages: expected });
    for (const row of rows.slice(1)) await store.appendRound(foldRunId, row);

    const loaded = await store.load(foldRunId);
    const carrier = loaded.find((record) => record.dedupKey === `${foldRunId}:engine:round:4`);
    assert.ok(carrier !== undefined, "载体行必须在场");
    assert.deepEqual(carrier.messages, expected,
      `「两份都留」再折一遍不得让同一轮正文出现两次（实测过的坏法：r1 = assistant+user+assistant+user）；`
      + `实测：${JSON.stringify(carrier.messages)}`);
    assert.equal(loaded.length, 1, "消息行是重复副本，不得作为独立行留在数组里");
  });

  // issue #458：折叠层的**块类型无关性**。写侧一条消息一行是逐条落盘的，thinking 行与 tool_use 行
  // 和 text 行走的是同一条路；但折叠实现只要偷一下懒（只把带 text 的行当正文），宿主与 resume
  // 侧看到的就是一场“模型见过、档案里拼不出来”：thinking 与工具调用整块消失，而格数看起来还是“对了”。
  // 本仓库没有「墓碑行」这个概念（`deleteMessage` 不在这层的职责里），因此本格只钉“不占行 + 块不丢”两条。
  test(`${label}: 折叠——thinking/tool_use 行同样不占独立行且整块保留（issue #458）`, async () => {
    const store = await createStore();
    const round = 7;
    const useId = `tool-${String(round)}`;
    const rows = [
      foldCarrier(round),
      foldMessageRow(round, 0, { role: "user", content: [textBlock("go")] }, { ts: foldTs(11) }),
      foldMessageRow(round, 1, {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先看一下目录", signature: "sig-1" }],
      }, { ts: foldTs(12) }),
      foldMessageRow(round, 2, {
        role: "assistant",
        content: [{ type: "tool_use", id: useId, name: "list", input: { path: "src" } }],
      }, { ts: foldTs(13) }),
      foldMessageRow(round, 3, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: useId, content: "ok" }],
      }, { ts: foldTs(14) }),
    ];
    const expected = [
      { role: "user", content: [textBlock("go")], ts: foldTs(11) },
      { role: "assistant", content: [{ type: "thinking", thinking: "先看一下目录", signature: "sig-1" }], ts: foldTs(12) },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: useId, name: "list", input: { path: "src" } }],
        ts: foldTs(13),
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: "ok" }], ts: foldTs(14) },
    ];
    for (const row of rows) await store.appendRound(foldRunId, row);

    const loaded = await store.load(foldRunId);
    assert.equal(loaded.length, 1,
      `四条消息行（含只有 thinking 与只有 tool_use 的两条）一律不得作为独立行留在数组里；实测 ${String(loaded.length)} 行：`
      + JSON.stringify(loaded.map((record) => record.dedupKey)));
    assert.deepEqual(loaded[0].messages, expected,
      "thinking / tool_use / tool_result 整块必须按 seq 原样折回（不得只折 text 块、不得改字段形状）");
    const blocks = loaded[0].messages.flatMap((message) => message.content.map((block) => block.type));
    assert.ok(blocks.includes("thinking") && blocks.includes("tool_use"),
      `thinking 与 tool_use 块不得在折叠层被丢掉（实测内容块序列：${blocks.join(" > ")}）`);
    // 引擎与宿主拼时间线用的就是这一个口径：折叠后的总条数必须等于“一条逻辑消息一项”的条数。
    assert.equal(loaded.flatMap((record) => record.messages ?? []).length, expected.length,
      "折叠后 flatMap(record => record.messages) 的条数必须等于消息行数（不新增、不丢失）");
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
    // 非空 store 边界（issue #171）：必须返回 ≥0 的安全整数，
    // 负数/null/undefined 只是空 store 信号，不得作为真实 round 返回。
    const nonEmpty = await store.loadMaxRound("probe-run");
    assert.ok(Number.isSafeInteger(nonEmpty) && nonEmpty >= 0,
      `非空 store 的 loadMaxRound 必须返回 ≥0 的安全整数，实际：${String(nonEmpty)}`);
  });

  // issue #171：loadByDedupKey 的判据必须是 nullish 回退，不是 OR。
  // 分叉数据：同一条 record 同时带有不等值的 dedupKey 与 roundKey。
  //   ?? （契约正文 + src/store/append-user-turn.js 全量路径）：只看 dedupKey，
  //      按 roundKey 的值查询判 miss。
  //   OR （0.17.0 升级指南旧 sketch）：按 roundKey 的值查询判 hit——快路径多
  //      命中会让 appendUserTurn 直接返回 written:false，这一轮静默不追加，
  //      不报错也不降级。本用例永久锁住 nullish 语义：宿主写成 OR 会在这里红。
  test(`${label}: loadByDedupKey 按 nullish 判据匹配（dedupKey 存在时绝不回退 roundKey，#171）`, async () => {
    const store = await createStore();
    if (typeof store.loadByDedupKey !== "function") return; // 未实现快路径：由全量路径覆盖

    const record = {
      round: 8,
      ts: "2026-08-29T00:08:00.000Z",
      dedupKey: "nullish-run:A",
      roundKey: "nullish-run:B",
      messages: [{ role: "user", content: [{ type: "text", text: "two keys" }] }],
    };
    await store.appendRound("nullish-run", record);

    // 按 dedupKey 查：命中并返回完整记录。
    assert.deepEqual(await store.loadByDedupKey("nullish-run", record.dedupKey), record);

    // 按 roundKey 的值查：必须判 miss（?? 不回退）。
    const byRoundKey = await store.loadByDedupKey("nullish-run", record.roundKey);
    assert.ok(byRoundKey === null || byRoundKey === undefined,
      "record 已有 dedupKey 时，按 roundKey 值查询必须判 miss（nullish 判据，非 OR）");

    // 一般化：探针结论逐值等于全量路径的 ?? 判据，两路径不得给出不同答案。
    const records = await store.load("nullish-run");
    const fullPathHit = (probe) => records.find((r) => (r.dedupKey ?? r.roundKey) === probe);
    for (const probe of [record.dedupKey, record.roundKey, "nullish-run:absent"]) {
      const probed = await store.loadByDedupKey("nullish-run", probe);
      assert.deepEqual(probed ?? null, fullPathHit(probe) ?? null,
        `loadByDedupKey(${probe}) 与全量 load 的 ?? 判据结论不一致`);
    }
  });

  // ---- issue #326 事实①：同 key 的幂等/冲突判据 -------------------------------------------
  // 修前：`appendRound` 只看 key——同 key 带不同 payload 也被**静默接受**（第二次的正文既
  // 不落盘也不报错，memory 侧 `records.some(...)` 直接 return、file 侧 `entry.keys.has(key)`
  // 直接 return false）。修后：同 key + 同 payload → 幂等 no-op（与修前一致）；同 key + 异
  // payload → 抛带 key 与两份 payload 指纹的冲突错（`code = "dedup_payload_conflict"`）。
  // 两侧误判方向不是对称的：**把本来幂等的重放误判成冲突比漏判更糟**，所以下面把
  // 「什么不算冲突」（字段顺序、顶层 ts/round）钉得比「什么算冲突」更死。
  const dedupRecord = (overrides) => ({
    round: 4,
    ts: "2026-08-29T00:04:00.000Z",
    dedupKey: "dedup-run:input:m1",
    roundKey: "dedup-run:input:m1",
    messages: [{ role: "user", content: [{ type: "text", text: "同一个输入轮" }] }],
    ...overrides,
  });
  const isDedupConflict = (error) => error?.code === "dedup_payload_conflict"
    && typeof error.key === "string" && error.key.length > 0
    && /^sha256:[0-9a-f]{24}$/u.test(String(error.existingFingerprint))
    && /^sha256:[0-9a-f]{24}$/u.test(String(error.incomingFingerprint))
    && String(error.existingFingerprint) !== String(error.incomingFingerprint)
    && String(error.message).includes(String(error.key));

  test(`${label}: 同 dedupKey 重放同 payload 是幂等 no-op（字段顺序不算差异）`, async () => {
    const store = await createStore();
    const first = dedupRecord();
    await store.appendRound("dedup-run", first);
    // 逐字段同值但插入顺序不同（宿主/另一条代码路径重建同一条记录的真实形状）
    await store.appendRound("dedup-run", {
      messages: first.messages,
      roundKey: first.roundKey,
      dedupKey: first.dedupKey,
      ts: first.ts,
      round: first.round,
    });

    assert.deepEqual(await store.load("dedup-run"), [first]);
  });

  test(`${label}: 崩溃重跑形状（顶层 ts/round 漂了）仍判幂等，不得误判成冲突`, async () => {
    const store = await createStore();
    const first = dedupRecord();
    await store.appendRound("dedup-run", first);
    // appendUserTurn 重跑同一 messageId 时就是这形状：dedupKey 稳、正文稳，
    // 但 ts = new Date() 而 round = store 现有最大 round，两个都会漂。误判成冲突
    // 会把「可安全重复的预写」变成抛错，比静默丢弃更砸契约。
    await store.appendRound("dedup-run", dedupRecord({
      round: 9,
      ts: "2026-09-01T00:00:00.000Z",
    }));

    const loaded = await store.load("dedup-run");
    assert.equal(loaded.length, 1, "幂等重放不得落第二行");
    assert.deepEqual(loaded[0], first, "先落的那条是事实，后到的只被当作重放");
  });

  test(`${label}: 同 dedupKey 异 payload 明确报冲突，既不覆盖也不静默丢弃`, async () => {
    const store = await createStore();
    const first = dedupRecord();
    await store.appendRound("dedup-run", first);

    await assert.rejects(
      store.appendRound("dedup-run", dedupRecord({
        messages: [{ role: "user", content: [{ type: "text", text: "同一 key 却写了另一段正文" }] }],
      })),
      (error) => isDedupConflict(error) && error.differingFields.includes("messages"),
      "冲突错必须可判定：code + key + 两份 payload 指纹 + 差异字段",
    );

    // 不覆盖也不丢：盘上仍是原行，且原行内容一字未改
    assert.deepEqual(await store.load("dedup-run"), [first]);
    // 冲突不污染 store：同 payload 重放照旧幂等，新 key 照旧能写
    await store.appendRound("dedup-run", dedupRecord());
    await store.appendRound("dedup-run", dedupRecord({
      dedupKey: "dedup-run:input:m2",
      roundKey: "dedup-run:input:m2",
    }));
    assert.equal((await store.load("dedup-run")).length, 2);
  });

  test(`${label}: 数组顺序与嵌套字段是 payload 的一部分（顺序换了就是冲突）`, async () => {
    const store = await createStore();
    await store.appendRound("dedup-run", {
      round: 5,
      dedupKey: "dedup-run:engine:round:5",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "先" }] },
        { role: "user", content: [{ type: "text", text: "后" }] },
      ],
    });

    await assert.rejects(
      store.appendRound("dedup-run", {
        round: 5,
        dedupKey: "dedup-run:engine:round:5",
        messages: [
          { role: "user", content: [{ type: "text", text: "后" }] },
          { role: "assistant", content: [{ type: "text", text: "先" }] },
        ],
      }),
      isDedupConflict,
      "消息顺序是语义，不得当作噪声归一掉",
    );
  });

  test(`${label}: 宿主自有未知字段也算 payload（多一个字段就是冲突）`, async () => {
    const store = await createStore();
    await store.appendRound("dedup-run", dedupRecord());

    await assert.rejects(
      store.appendRound("dedup-run", dedupRecord({ hostLedger: { written: true } })),
      (error) => isDedupConflict(error) && error.differingFields.includes("hostLedger"),
    );
  });

  test(`${label}: 回落到 roundKey 与隐式 <runId>:round:<n> 键时判据一致`, async () => {
    const store = await createStore();
    // 只有 roundKey（dedupKey 缺失）——去重键回落到 roundKey，冲突判据不得退场
    await store.appendRound("roundkey-run", { round: 2, roundKey: "roundkey-run:round:2", messages: ["a"] });
    await assert.rejects(
      store.appendRound("roundkey-run", { round: 2, roundKey: "roundkey-run:round:2", messages: ["b"] }),
      (error) => isDedupConflict(error) && error.key === "roundkey-run:round:2",
    );
    // 两个键都缺失——store 自己造的 <runId>:round:<n> 同受约束
    await store.appendRound("implicit-run", { round: 7, messages: [{ role: "user", content: [] }] });
    await store.appendRound("implicit-run", { round: 7, messages: [{ role: "user", content: [] }] });
    assert.equal((await store.load("implicit-run")).length, 1, "隐式键的同 payload 重放仍幂等");
    await assert.rejects(
      store.appendRound("implicit-run", { round: 7, messages: [{ role: "user", content: ["x"] }] }),
      (error) => isDedupConflict(error) && error.key === "implicit-run:round:7",
    );
  });
}
