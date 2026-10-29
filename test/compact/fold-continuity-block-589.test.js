// issue #589 —— 续接块（#568）**不被折叠吞进去** + `ensureUserTurnView` 复制格的根因。
//
// 前提（主 agent 在合并后的 main 上实测，见工单第一条评论，不在这里重推）：
//   · 块是 `messages` 里的**一条真消息**，固定在尾部（`positionContinuityBlock` 每轮挪回去）；
//   · `keepRounds >= 1` 时 `selectFoldedRounds` 只折最老的轮 ⇒ 块在尾部，折不到（安全）；
//   · **`keepRounds: 0` 会中招**：`target = rounds.length - keepRounds` 把包括尾部在内的**全部**
//     轮次选中 ⇒ 块正文进 `foldedPayload` 归档与 `summarizeFoldedPayload` 摘要。
//   后果两层：① **取证面污染**（归档/摘要里出现「上一版续接块」的正文，读者分不清历史事实与
//   当前状态的旧快照）；② 体积放大（块可到 1200 token）。
//
// 四格判据（每格一个 test，名字带编号，红的时候一眼知道打的是哪一格）：
//   1. **`keepRounds: 0` 下块不进 `foldedPayload`、也不进摘要文本**（本单核心；单元格三个策略各一遍
//      + 一格真引擎落盘记录）；
//   2. **正常形态不变**：`keepRounds >= 1` 时被折轮次集合与今天**逐字相同**（期望值是字面数组）；
//   3. **块仍在 `messages` 里**且仍计入本地估算（#568 判据 3 的前提原样成立）；
//   4. **复制格**：压缩后「一条 user 轮都不剩」时消息流**恰好一条**块；且（根因修法）复制格
//      复制的是**真用户查询**，不是块。
//
// 两条反向证（变异实验，见 DELIVERY.md；每条只打一格）：
//   · 去掉「排除块消息所在轮」⇒ 判据 1 红（单元格 + 真引擎格同时红）；
//   · 把块挪出 `messages`（`upsertContinuityInMessages` 不把块放进消息流）⇒ 判据 3 红
//     —— 这就是工单那条**硬禁令**的牙。
//
// 零真实 LLM、零网络、零 `~/.erix`：fake provider + 内存 store（AGENTS.md 测试隔离规则）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUITY_BLOCK_START,
  continuityMessageCount,
  isContinuityMessage,
  renderContinuityBlock,
  upsertContinuityInMessages,
} from "../../src/loop/continuity-block.js";
import { ensureUserTurnView, latestUserRound } from "../../src/loop/request-user-view.js";
import { selectFoldedRounds } from "../../src/compact/helpers.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { estimateMessageTokens } from "../../src/tokens.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

const executeTool = async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`;

/** 块正文里**只属于块**的语义内容（用它当「块正文进没进归档/摘要」的探针）。 */
const BLOCK_GOAL = "goal: #589 折叠不许吞掉续接块";
const BLOCK_UNFINISHED = "u1: 未完成项-块专用标记";

/** 一份固定内容的续接块正文（三段骨架齐全，便于断言「块本体」而不是碰巧含 marker 的文本）。 */
function continuityText({ version = 1 } = {}) {
  return [
    "[contract]",
    BLOCK_GOAL,
    "must: 不进 foldedPayload",
    "[unfinished]",
    BLOCK_UNFINISHED,
    "[evidence]",
    "verified: keepRounds 0 已实测",
    `# version=${version}`,
  ].join("\n");
}

/** 渲染好的块（`upsertContinuityInMessages` 的入参形态）。 */
function continuityBlock({ version = 1 } = {}) {
  return renderContinuityBlock({ sections: {
    contract: [BLOCK_GOAL, "must: 不进 foldedPayload"],
    unfinished: [BLOCK_UNFINISHED],
    evidence: ["verified: keepRounds 0 已实测"],
  }, version });
}

/**
 * 折叠夹具：`rounds` 条 user/assistant 轮（每条一轮，`groupIntoRounds` 的口径），
 * 尾部按 `withBlock` 决定有没有续接块。
 */
function conversation({ rounds = 4, withBlock = true, padding = "" } = {}) {
  const messages = [];
  for (let index = 1; index <= rounds; index += 1) {
    messages.push({
      role: index % 2 === 1 ? "user" : "assistant",
      content: [{ type: "text", text: `第 ${index} 轮正文${padding}` }],
    });
  }
  if (!withBlock) return messages;
  const applied = upsertContinuityInMessages(messages, continuityBlock().text);
  assert.equal(applied.injected, true, "夹具自检：块必须注入成功");
  return applied.messages;
}

/** 一条消息里所有 text 块拼起来（探针用）。 */
function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .map((block) => String(block?.text ?? block?.content ?? ""))
    .join("\n");
}

/** 一段消息/负载里有没有**块正文**（不是 marker 字面量：marker 也可能被摘要引用）。 */
function holdsBlockBody(messages) {
  return (Array.isArray(messages) ? messages : [])
    .some((message) => textOf(message).includes(BLOCK_UNFINISHED));
}

/** 三个真实策略的「同一份折叠夹具」跑一遍（判据 1 的核心单元格对三个策略各来一次）。 */
async function compactWithEveryStrategy(messages, keepRounds) {
  const summarizer = async () => "LLM 摘要（不含块正文）";
  const strategies = [
    ["sliding-window", createSlidingWindowStrategy(), (result) => result.foldedSummaryText],
    ["fold-statistical", createFoldStatisticalStrategy(), (result) => result.foldSummary?.text],
    ["fold-llm", createFoldLlmStrategy({ summarizer }), (result) => (
      result.foldSummary?.increment ?? result.foldSummary?.text
    )],
  ];
  const results = [];
  for (const [name, strategy, summaryOf] of strategies) {
    const result = await strategy.compact(structuredClone(messages), { keepRounds });
    results.push({ name, result, summary: summaryOf(result) });
  }
  return results;
}

// ================================================================ 判据 1
//
// **核心断言**：`keepRounds: 0` 下块不进 `foldedPayload`，也不进摘要文本。
// 两格：① 单元格（三个策略各一遍，直接看 `foldedPayload` / 摘要产物）；
//      ② 真引擎（跑一次带折叠的 run，看**落盘记录**里的 `foldedPayload`）。
// 为什么两格都要：单元格钉的是「策略自己的选择」，真引擎格钉的是「引擎真的把这份选择写进了账本」
// —— 中间还有归档夹断 / 去重 / 记账三跳，只钉单元格会漏掉它们。

test("判据 1a：keepRounds 0 下块不进 foldedPayload、也不进摘要文本（三个策略各一遍）", async () => {
  const messages = conversation({ rounds: 4, withBlock: true });

  // 单元格：轮次选择本身就不许选中块所在轮。
  const rounds = messages.map((message, index) => ({ messages: [message], round: index + 1 }));
  const selection = selectFoldedRounds(rounds, 0);
  assert.equal(selection.folded.length, rounds.length - 1, "keepRounds 0 必须折掉除块那一轮以外的全部轮次");
  assert.equal(
    selection.folded.some((round) => round.messages.some(isContinuityMessage)),
    false,
    "块所在轮不许出现在被折轮次里",
  );
  assert.ok(selection.retained.some((round) => round.messages.some(isContinuityMessage)), "块那一轮必须留在 retained");

  for (const { name, result, summary } of await compactWithEveryStrategy(messages, 0)) {
    assert.ok(result.compacted, `${name}：前提不成立（keepRounds 0 应该折了东西）`);
    assert.equal(
      holdsBlockBody(result.foldedPayload),
      false,
      `${name}：块正文进了 foldedPayload 归档（取证面污染 + 体积放大）`,
    );
    assert.equal(
      String(summary ?? "").includes(BLOCK_UNFINISHED),
      false,
      `${name}：块正文进了摘要文本（读者分不清历史事实与当前状态的旧快照）`,
    );
    assert.equal(
      JSON.stringify(result.foldedPayload ?? []).includes(CONTINUITY_BLOCK_START),
      false,
      `${name}：归档里连块 marker 都不许出现`,
    );
    // 同一格的下半句：「没被折」的另一面就是「还在 messages 里」（恰好一条，不重不丢）。
    assert.equal(
      continuityMessageCount(result.messages),
      1,
      `${name}：keepRounds 0 折完，消息流里必须仍有**恰好一条**块`,
    );
    assert.ok(isContinuityMessage(result.messages.at(-1)), `${name}：块必须仍在尾部`);
  }
});

test("判据 1b：真引擎（fold-statistical + keepRounds 0）落盘记录里没有任何一条归档含块正文", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 4 }, (unused, index) => ({
      content: [{
        type: "tool_use",
        id: `tu_${index + 1}`,
        name: "echo",
        // 填充体只为了让小预算真的折叠（不填的话 4 轮小消息根本超不了预算）。
        input: { text: `R${index + 1}_${"填充".repeat(200)}` },
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
  ]);
  const store = createMemoryTranscriptStore();
  const run = await runWithContinuity({
    runId: "s589-fold",
    provider,
    store,
    budgetTokens: 400,
    keepRounds: 0,
  });

  assert.equal(run.termination.reason, "end_turn", "前提不成立：run 没正常收尾");
  const records = await store.load("s589-fold");
  const folded = records.filter((record) => (record.foldedPayload ?? []).length > 0);
  assert.ok(folded.length > 0, "前提不成立：这次 run 一次都没折叠（本格要的是折叠发生了、块没进去）");
  for (const record of folded) {
    assert.equal(
      holdsBlockBody(record.foldedPayload),
      false,
      `第 ${record.round} 轮的归档里出现了块正文（keepRounds 0 把尾部那块折进去了）`,
    );
  }
});

// ================================================================ 判据 2
//
// **正常形态不变**：`keepRounds >= 1` 时被折轮次集合与今天**逐字相同**。
// 期望值是字面数组（不是「跑一遍看它输出什么」）：块固定在尾部，`keepRounds >= 1` 时它永远在
// `retained` 里，所以折走的正好是「除块那一轮之外最老的 keep 之外的那些」。

test("判据 2：keepRounds >= 1 时被折轮次集合逐字不变（字面期望值）", () => {
  const withBlock = conversation({ rounds: 4, withBlock: true });
  const rounds = withBlock.map((message, index) => ({ messages: [message], round: index + 1 }));
  assert.equal(rounds.length, 5, "夹具自检：4 轮正文 + 1 轮块");

  // 块在 index 4；keepRounds 1/2/3/4 ⇒ 折 4/3/2/1 轮，块那一轮永远不在里面。
  // 这些字面值就是「加块之前」的值：块在尾部，`target = rounds.length - keep` 永远到不了它。
  const expected = new Map([
    [1, [0, 1, 2, 3]],
    [2, [0, 1, 2]],
    [3, [0, 1]],
    [4, [0]],
  ]);
  for (const [keepRounds, foldedIndexes] of expected) {
    const selection = selectFoldedRounds(rounds, keepRounds);
    assert.deepEqual(selection.foldedIndexes, foldedIndexes, `keepRounds=${keepRounds} 的被折轮次集合变了`);
    assert.equal(
      selection.folded.some((round) => round.messages.some(isContinuityMessage)),
      false,
      `keepRounds=${keepRounds}：块那一轮不该被折`,
    );
  }

  // 不含块的同一份夹具（绝大多数会话的形状）：期望值仍是「前 target 轮」——本单不改这条路径。
  const bareRounds = conversation({ rounds: 4, withBlock: false })
    .map((message, index) => ({ messages: [message], round: index + 1 }));
  const bareExpected = new Map([[1, [0, 1, 2]], [2, [0, 1]], [3, [0]], [4, []]]);
  for (const [keepRounds, foldedIndexes] of bareExpected) {
    assert.deepEqual(
      selectFoldedRounds(bareRounds, keepRounds).foldedIndexes,
      foldedIndexes,
      `keepRounds=${keepRounds}：无块会话的被折轮次集合变了（正常形态必须逐字不变）`,
    );
  }
});

// ================================================================ 判据 3
//
// **块仍在 `messages` 里**（工单硬禁令：不许用「把块挪出 messages」来绕）+ 仍计入本地估算
// （#568 判据 3 的实现前提）。`estimateMessageTokens` 是 `compactBeforeRound` 用的那把尺子。
//
// 这一格**刻意不依赖折叠选择那一步**：它钉的是「块是 `messages` 里的一条真消息」这条不变量本身
// （注入面 + 正常形态的折叠都不许把它挪走）。反向证是「把块挪出 `messages`」⇒ 本格红；
// 「去掉排除块所在轮」那一刀只会打判据 1，不会顺带把本格拖红（两条反向证各打一格）。

test("判据 3：块是 messages 里的真消息，且 estimateMessageTokens 看得见它（正常形态折叠后仍是恰好一条）", async () => {
  const bare = conversation({ rounds: 4, withBlock: false });
  const messages = conversation({ rounds: 4, withBlock: true });
  assert.equal(continuityMessageCount(messages), 1, "注入后恰好一条块");
  assert.ok(isContinuityMessage(messages.at(-1)), "块必须落在 messages 尾部");
  assert.ok(
    estimateMessageTokens(messages) > estimateMessageTokens(bare),
    "块必须计入本地估算（它是 messages 里的一条真消息，不是 mainSystem 的附加文本）",
  );

  // 正常形态（keepRounds >= 1）：折叠不改块的归属 —— 恰好一条、仍在尾部、估算里仍看得见。
  for (const { name, result } of await compactWithEveryStrategy(messages, 2)) {
    assert.equal(
      continuityMessageCount(result.messages),
      1,
      `${name}：正常形态折叠后消息流里必须**恰好一条**块（既不许被挪走，也不许被复制成两条）`,
    );
    assert.ok(isContinuityMessage(result.messages.at(-1)), `${name}：块必须仍在尾部`);
    assert.ok(
      estimateMessageTokens(result.messages) > estimateMessageTokens(
        result.messages.filter((message) => !isContinuityMessage(message)),
      ),
      `${name}：折叠结果的估算里必须看得见块`,
    );
  }
});

// ================================================================ 判据 4
//
// **复制格**（`src/loop/request-user-view.js`）：压缩后「一条 user 轮都不剩」时，消息流里
// **恰好一条**块（#568 的「至多一条」收口在这里仍然成立），且（本单修的根因）复制格复制的是
// **真用户查询**，不是块。

test("判据 4a：压缩后一条 user 轮都不剩 ⇒ 真引擎消息流恰好一条块，且保住真用户查询", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "R1" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
  ]);
  const events = [];
  const run = await runWithContinuity({
    runId: "s589-copy",
    provider,
    events,
    budgetTokens: 99,
    keepRounds: 4,
    // 这条策略就是「压缩后一条 user 轮都不剩」的形状：结果只剩一条 assistant 消息。
    strategy: {
      shouldCompact() {
        return this.calls++ === 0;
      },
      calls: 0,
      async compact() {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "压缩后只剩 assistant" }] }],
          compacted: true,
          foldedRounds: 1,
          tokensBefore: 120,
          tokensAfter: 12,
          foldedPayload: [],
        };
      },
    },
  });

  assert.equal(run.termination.reason, "end_turn", "前提不成立：run 没正常收尾");
  const compaction = events.find((event) => event.type === "compaction");
  assert.equal(
    compaction?.compaction?.userTurnGuard,
    "preserved_latest_user_turn",
    "前提不成立：这一格要的是复制格真的动手了（守卫没动作就测不到根因）",
  );

  const last = provider.requests.at(-1);
  assert.equal(continuityMessageCount(last.messages), 1, "消息流里必须**恰好一条**块（不许出现第二条）");
  assert.ok(
    last.messages.some((message) => textOf(message) === "开始任务"),
    "复制格必须把**真用户查询**贴回来——贴块正文等于把上一版状态当成新消息（#589 的根因）",
  );
  assert.equal(
    last.messages.filter((message) => isContinuityMessage(message)).length,
    1,
    "块只能有一条，且它是引擎自己那一份（不是复制出来的）",
  );
});

test("判据 4b：复制格（单元格）不复制块消息——真用户轮优先，块只在「源里只有块」时随 abandoned_fold 回来", () => {
  const source = conversation({ rounds: 2, withBlock: true });
  assert.ok(isContinuityMessage(source.at(-1)), "夹具自检：源视图尾部是块");

  // 根因：`latestUserRound` 不许把块当成「最新 user 轮」。
  const round = latestUserRound(source);
  assert.ok(round !== undefined, "源里有一条真 user 轮，必须选它");
  assert.equal(round.length, 1);
  assert.equal(round[0].role, "user");
  assert.equal(
    isContinuityMessage(round[0]),
    false,
    "`latestUserRound` 复制了块消息——这就是「压缩后又出现一条块」的根因",
  );
  assert.equal(textOf(round[0]), "第 1 轮正文");

  // 视图空 ⇒ 守卫回补的是那条真 user 轮，产物里**没有**块。
  const stats = {};
  const repaired = ensureUserTurnView([], source, stats);
  assert.equal(stats.action, "preserved_latest_user_turn");
  assert.equal(continuityMessageCount(repaired), 0, "复制格产物里不许有块消息");
  assert.equal(textOf(repaired.at(-1)), "第 1 轮正文");

  // 退化形态（源里除了块再没有 user 轮）：不变量不许因此变弱 —— 既有的 `abandoned_fold`
  // 原样返回源视图，块跟着回来（它是合法的 user 消息），块数仍是 1。
  const blockOnly = [source.at(-1)];
  const fallbackStats = {};
  const fallback = ensureUserTurnView([], blockOnly, fallbackStats);
  assert.equal(fallbackStats.action, "abandoned_fold");
  assert.equal(continuityMessageCount(fallback), 1, "源里只有块时，abandoned_fold 必须把它带回来（不是丢光）");
});

/**
 * 跑一次带续接 provider 的 run（本文件的共享夹具：内存 store、无网络、run 级治理面全关）。
 *
 * 两个回调写在规范之家 `capabilities.hooks.*`，配置写在 `config.*`（#498 的容器口径）。
 * `strategy` 走 `capabilities.ports.strategy`（宿主注入压缩策略的既有口子）。
 */
function runWithContinuity({
  runId,
  provider,
  store,
  events,
  budgetTokens,
  keepRounds,
  strategy,
} = {}) {
  return runDirect({
    provider,
    store,
    tools: TOOLS,
    executeTool,
    seed: "开始任务",
    config: {
      folding: { context: { budgetTokens, keepRounds } },
      run: { runId, completion: false, maxRounds: 8, reflection: { enabled: false } },
    },
    capabilities: {
      ...(strategy === undefined ? {} : { ports: { strategy } }),
      hooks: {
        continuityProvider: async () => ({ version: 1, text: continuityText() }),
        ...(events === undefined ? {} : { onEvent: (event) => events.push(event) }),
      },
    },
  });
}
