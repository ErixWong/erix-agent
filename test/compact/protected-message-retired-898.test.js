// @ts-check
// issue #898 判据（第一刀）：`protectedMessage` 这条机制**已退役**。
//
// 裁决（已定，不重新论证）：「把消息标记为不可折叠」是坏设计——遗忘是常态，召回才是配套手段。
// 硬前置 `recall_read`（#896，PR #910）已在 main，所以删掉保护不再等于纯丢信息：本文件的
// 第 3 格就是这条前置的**唯一证据**（真跑、逐字比对）。
//
// 三格各自的「在基点 0ff819d4 上为什么红」（实测原文见交付报告）：
//   1. **选项已不存在** —— 基点上 `protectedMessage` 还挂在 `CONTEXT_OPTION_NAMES` 与
//      `CAPABILITY_POLYMORPHIC_HOOK_NAMES` 上 ⇒ 装配口对它**零** `context_unknown_option` 事件、
//      `capabilities.hooks.protectedMessage` 不抛 ⇒ 三处断言全红。
//   2. **没有保护也能折** —— 基点上数据形态 `config.folding.context.protectedMessage: "user"`
//      仍被 `selectFoldedRounds` 读（含 user 消息的轮**不可折**）⇒ 那一轮不进任何
//      `foldedRoundRange`、`compacted` 也不是真 ⇒ 红。这正是本刀的行为改变。
//   3. **召回兜底** —— 同一格的前提（「它真的被折掉了」）在基点上就不成立 ⇒ 红；
//      在退役后：折掉了，`recall_read({round})` 仍从账本**逐字**取回那条真实用户消息。
//
// ⚠ 为什么第 2/3 格用**数据形态**（`config.folding.context`）而不是函数形态：函数形态的规范之家
//   是 `capabilities.hooks.protectedMessage`，而退役后那个名字**直接抛**（第 1 格钉的正是这件事）——
//   拿一个会被闸口拒掉的写法去跑折叠，测的就不是折叠了。数据形态在退役后落「宿主元数据」分支
//   （报一条事件、不抛、无人再读），所以它能同时做到「基点上生效 → 红」与「退役后被忽略 → 绿」。
//
// 零真实 LLM（fake provider）、内存 store、不写盘、不碰真实 `~/.erix`。
import assert from "node:assert/strict";
import test from "node:test";

import { createAssemblyPort } from "../../src/assembly.js";
import {
  CONTEXT_OPTION_NAMES,
  collectUnknownContextOptions,
} from "../../src/assembly-validators.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createBuiltinRecallTools } from "../../src/tools/recall.js";
import { runDirect } from "../helpers/run-direct.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

/** 注入的那条真实用户消息的判别前缀与**逐字尾部**（尾部证明取回的原文没被夹断）。 */
const USER_MARKER = "USERMARKER_REAL_USER_TURN";
const VERBATIM_TAIL = "_TAIL_9F3C_VERBATIM";

const MODEL_METADATA = { contextWindowTokens: 100000, maxOutputTokens: 1024 };

function makeProvider() {
  return createFakeProvider([
    ...Array.from({ length: 12 }, (_unused, index) => ({
      content: [{
        type: "tool_use",
        id: `tu_${index + 1}`,
        name: "echo",
        input: { text: `R${index + 1}_` + "x".repeat(1200) },
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
  ]);
}

function makeModelConfig() {
  return { resolve: async () => ({ ...MODEL_METADATA }) };
}

/**
 * 一条**必然折叠**的 run：预算 3000、`keepRounds: 1`（有效保留下限 5）、内置 `sliding-window`，
 * 并在轮边界注入一条**真实用户消息**（`isRealUser` 天然为真：字符串 content 的 user 消息）。
 *
 * @param {{protectedMessage?: unknown}} [extra] 只多带被测的那一个折叠上下文叶子
 */
async function buildFold(extra = {}) {
  const runId = `retire-898-${Object.keys(extra).join("-") || "plain"}`;
  const store = createMemoryTranscriptStore();
  const provider = makeProvider();
  const result = await runDirect({
    seed: "开始任务 TASKBRIEF",
    provider,
    store,
    runId,
    tools: TOOLS,
    executeTool: async (
      /** @type {any} */ call,
    ) => `ECHO:${String(call?.input?.text ?? "").slice(0, 40)}`,
    completion: false,
    maxRounds: 40,
    wrapup: false,
    stallDetection: false,
    config: {
      run: { maxRounds: 40 },
      input: { cacheStablePrefix: false },
      folding: { context: { budgetTokens: 3000, keepRounds: 1, ...extra } },
    },
    capabilities: {
      ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) },
      hooks: {
        // 第 3 轮注入一条大体积的**真实用户消息**：机制在时这一轮「不可折」，机制退役后它跟
        // 其它轮一样进折叠区间。
        nextUserTurn: (/** @type {any} */ payload) => (payload?.round === 3
          ? `${USER_MARKER}_${"u".repeat(4000)}${VERBATIM_TAIL}`
          : null),
      },
    },
  });
  const rows = await store.load(runId);
  const foldedRange = rows.filter((row) => row.folded === true && row.foldedRoundRange);
  return {
    runId,
    store,
    provider,
    result,
    rows,
    foldedRange,
    /** 那条注入消息实际落在哪一轮（从账本自己认，不硬编码轮号）。 */
    markerRound: () => {
      const hit = rows.find((row) => JSON.stringify(row?.messages ?? "").includes(USER_MARKER));
      return /** @type {number|undefined} */ (hit?.round);
    },
    lastPrompt: () => JSON.stringify(provider.requests.at(-1)?.messages ?? ""),
  };
}

// ─── 格 1：选项已不存在 ──────────────────────────────────────────────────────

test("#898-1 选项已不存在：protectedMessage 不在 context 白名单里 ⇒ 按未知键处理（装配口一条 context_unknown_option、不抛；hooks 形态直接拒）", async () => {
  // 白名单：机制退役后这个键**不再是合法 context 子键**。
  assert.equal(
    CONTEXT_OPTION_NAMES.includes("protectedMessage"),
    false,
    `protectedMessage 必须已从 CONTEXT_OPTION_NAMES 移除，实测名单：${JSON.stringify(CONTEXT_OPTION_NAMES)}`,
  );
  // 引擎对未知 context 键的既有处理方式（不自己发明）：落「宿主元数据」分支 ⇒ 一条事件。
  assert.deepEqual(
    collectUnknownContextOptions({ budgetTokens: 3000, keepRounds: 1, protectedMessage: "user" }),
    ["protectedMessage"],
  );

  const events = [];
  const port = createAssemblyPort({
    modelConfig: makeModelConfig(),
    provider: makeProvider(),
    tools: { definitions: TOOLS, executeTool: async () => "ECHO:ok" },
    session: { id: `retired-898-${process.pid}` },
    emit: (/** @type {string} */ type, /** @type {any} */ event) => events.push({ type, event }),
    policy: {
      context: { budgetTokens: 3000, keepRounds: 1, protectedMessage: "user" },
      capabilities: { ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) } },
    },
  });
  const result = await runDirect({
    assemblyPort: port,
    initialUserMessage: "go",
    completion: false,
    maxRounds: 20,
    wrapup: false,
    stallDetection: false,
  });
  assert.ok(result, "被当成宿主元数据 ⇒ 不抛、run 照旧跑完");
  const unknown = events.filter((entry) => entry.type === "context_unknown_option");
  // 至少一条（构造期与归一化期各可能报一次），且**只能**点名这个键。
  assert.ok(unknown.length >= 1, `必须至少一条 context_unknown_option，实测事件：${JSON.stringify(events.map((e) => e.type))}`);
  for (const entry of unknown) {
    assert.deepEqual(entry.event?.keys, ["protectedMessage"], `事件必须点名 protectedMessage，实测：${JSON.stringify(entry.event)}`);
  }

  // 函数形态的规范之家（`capabilities.hooks.*`）也已经没有这个位置 ⇒ 给了就被拒。
  assert.throws(
    () => createAssemblyPort({
      modelConfig: makeModelConfig(),
      provider: makeProvider(),
      tools: { definitions: TOOLS, executeTool: async () => "ECHO:ok" },
      session: { id: `retired-898-hooks-${process.pid}` },
      emit: () => {},
      policy: { capabilities: { hooks: { protectedMessage: () => true } } },
    }),
    /protectedMessage/,
  );
});

// ─── 格 2：没有保护也能折 ────────────────────────────────────────────────────

test("#898-2 没有保护也能折：带真实用户消息的那一轮在预算压紧时会被折掉（以前它被保护、进不了折叠区间）", async () => {
  const { result, foldedRange, markerRound, lastPrompt } = await buildFold({ protectedMessage: "user" });

  assert.equal(
    (result.compactionStats ?? []).some((stat) => stat.compacted === true),
    true,
    `预算压紧时必须发生折叠，实测 compactionStats：${JSON.stringify(result.compactionStats ?? [])}`,
  );
  const round = markerRound();
  assert.ok(Number.isSafeInteger(round), "注入的真实用户消息必须已落进账本某一轮");
  assert.ok(
    foldedRange.some((row) => row.foldedRoundRange.from <= round
      && round <= row.foldedRoundRange.to),
    `第 ${round} 轮必须落进某次折叠的 from/to 区间（机制在时它被保护、永远进不来），实测区间：${JSON.stringify(foldedRange.map((row) => row.foldedRoundRange))}`,
  );
  // 模型侧的同一件事：那条原文已经不在发给模型的最后一发请求里了。
  assert.ok(
    !lastPrompt().includes(USER_MARKER),
    "被折掉的原文不该再出现在最后一次请求里",
  );
});

// ─── 格 3：召回兜底（删了保护不丢信息的唯一证据）─────────────────────────────

test("#898-3 召回兜底：被折掉之后 recall_read({round}) 仍从账本逐字取回那条真实用户消息", async () => {
  const { store, runId, foldedRange, markerRound, rows } = await buildFold({ protectedMessage: "user" });
  const round = markerRound();
  assert.ok(Number.isSafeInteger(round), "注入的真实用户消息必须已落进账本某一轮");
  assert.ok(
    foldedRange.some((row) => row.foldedRoundRange.from <= round
      && round <= row.foldedRoundRange.to),
    "前提：这一轮确实**被折掉了**（基点上它被 protectedMessage 保护，这一句就红）",
  );

  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  const recalled = JSON.parse(String(await executeTool({ name: "recall_read", input: { round } })));

  assert.equal(recalled.status, "found", `recall_read 必须 found，实测：${JSON.stringify(recalled).slice(0, 200)}`);
  assert.equal(recalled.round, round);

  const joined = JSON.stringify(recalled.messages);
  // 逐字：判别前缀与**尾部**都在（不是截断后的前缀，也不是摘要）。
  assert.ok(joined.includes(USER_MARKER), `取回正文必须含原文前缀，实测头：${joined.slice(0, 120)}`);
  assert.ok(
    joined.includes(`${USER_MARKER}_${"u".repeat(4000)}${VERBATIM_TAIL}`),
    "取回的必须是**逐字**原文（整条消息，含 4000 字正文与尾部判别串）",
  );
  // 只取该轮，不许串轮。
  const ownRowText = JSON.stringify(rows.find((row) => row?.round === round)?.messages ?? "");
  assert.ok(ownRowText.includes(USER_MARKER), "账本里该轮本身就带原文（不是靠相邻轮充数）");
});
