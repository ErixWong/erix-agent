// issue #568 —— 会话续接块注入面：**七条判据全部是行为级的**（判据比实现重要，工单原话）。
//
// 病根（`erix-station#392` 及其订正）：模型无法**证明/定位**自己声称交付过什么。本单给引擎一块
// 「受预算约束、落请求尾部、计入本地估算、骨架三段不降采样」的续接块，内容由宿主的
// `capabilities.hooks.continuityProvider` 提供（引擎一行语义内容都不生产）。
//
// 七条判据（每条一个 test，名字里带编号，红的时候一眼知道打的是哪一格）：
//   1. 新 run **首请求**即见最新状态（不依赖「发生过折叠」这个前提）；
//   2. 第 21 折仍保住第 1 折的未完成项（事故原样复现）；
//   3. **估算可见**：块进了 `compactBeforeRound` 的 `estimateMessageTokens(messages)`——
//      边界用例：消息本身在预算内、加上块才超 ⇒ 必须折叠；
//   4. **关掉 provider ⇒ 逐字回到今天**（请求消息流对拍）；
//   5. 超预算有**显式**不完整标记，且骨架三段仍在（不许静默截断、不许删骨架）；
//   6. **不破坏相邻性**：尾部有悬空 `tool_use` 时不插在中间（有格，run 级 + 单元级）；
//   7. **不膨胀**：连续 5 轮，请求里恰好 1 条块消息（同一块就地替换，不新增）。
//
// 四条反向证（**变异实验**，见 DELIVERY.md：每条只打一格）：
//   · 把块塞进 `mainSystem` ⇒ 判据 3 红；
//   · 删掉「run 启动刷新」那一腿 ⇒ 判据 1 红；
//   · 让降采样能吃掉骨架段 ⇒ 判据 5 红；
//   · 改成每轮追加新消息 ⇒ 判据 7 红。
//
// 零真实 LLM：fake provider + 内存 store（AGENTS.md 测试隔离规则：不写真实 `~/.erix`）。

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { estimateTokens } from "../src/tokens.js";
import {
  CONTINUITY_BLOCK_END,
  CONTINUITY_BLOCK_START,
  CONTINUITY_DEFAULT_MAX_TOKENS,
  CONTINUITY_MAX_ENTRY_CHARS,
  CONTINUITY_SECTION_NAMES,
  continuityMessageCount,
  isContinuityMessage,
  normalizeContinuityProvided,
  positionContinuityBlock,
  renderContinuityBlock,
  upsertContinuityInMessages,
} from "../src/loop/continuity-block.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

const executeTool = async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`;

/** 一条块消息的正文（不是块的消息返回 `undefined`）。 */
function blockTextOf(message) {
  if (!isContinuityMessage(message)) return undefined;
  const blocks = typeof message.content === "string"
    ? [message.content]
    : (message.content ?? []).filter((block) => block?.type === "text");
  return blocks.map((block) => (typeof block === "string" ? block : String(block.text ?? ""))).join("");
}

/**
 * 一次请求视图里的块正文（取**最后**一条块；0 条 ⇒ `undefined`）。
 *
 * 「一条请求里只能有一条块」由**判据 7**独占断言（`continuityMessageCount === 1`）——那是
 * 「不膨胀」这条性质的判据，不该在共用夹具里顺手重复一遍（否则每个格子都会替它红，反向证就分不清
 * 是哪一格在咬人）。
 */
function blockTextOfRequest(request) {
  const blocks = request.messages
    .map(blockTextOf)
    .filter((text) => text !== undefined);
  return blocks.at(-1);
}

/** 请求视图去掉续接块之后的那一份（判据 4 / 7 的对拍口径）。 */
function messagesWithoutBlock(request) {
  return request.messages.filter((message) => !isContinuityMessage(message));
}

/**
 * 对拍用的规范化：去掉**跨 run 天然不同**的引擎事实键。
 *
 * `erix.toolCallKey` 是 `randomBytes(6)`（`src/tool-fact.js#allocateToolCallKey`）、
 * `erix.durationMs` 是墙钟 ⇒ 两次 run 永远不相等。这不是本单引入的差异：续接块只增一条 user
 * 消息，其余字节必须逐字相等，所以对拍前把这两个**已知非确定**的键剔掉（其余一个字节都不动）。
 */
function normalizeForParity(messages) {
  return JSON.parse(JSON.stringify(messages, (key, value) => (key === "erix" ? undefined : value)));
}

/**
 * 这条消息是不是 run-state 块（通道 B：`appendRunStateToRequestView` 在**低预算/首折**那几轮
 * 追加到请求视图尾部的那个块）。
 *
 * 它为什么会被算进「块必须停在尾部」的判据：请求视图 = `messages` + 可选的 run-state 块，
 * 于是「续接块是 `messages` 的最后一条」在请求里表现为「续接块之后**只可能**还跟着 run-state 块」。
 */
function isRunStateMessage(message) {
  const texts = typeof message?.content === "string"
    ? [message.content]
    : (Array.isArray(message?.content) ? message.content : [])
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? ""));
  return message?.role === "user" && texts.some((text) => text.trimStart().startsWith("[run state deterministic v1]"));
}

/** 请求视图里最后一条**不是** run-state 块的消息（= `messages` 的尾部）。 */
function persistentTailOf(request) {
  const index = request.messages.findLastIndex((message) => !isRunStateMessage(message));
  return index < 0 ? undefined : request.messages[index];
}

/** 一条固定内容的续接块正文（三段齐全，便于断言骨架）。 */
function fixedContinuityText({ version = 1, item = "u1: 把 #568 的判据跑绿" } = {}) {
  return [
    "[contract]",
    "goal: 会话续接块注入面",
    "must: 不进 mainSystem",
    "[unfinished]",
    item,
    "[evidence]",
    "verified: 判据 1 已实测",
    "claimed: 判据 2 待测",
    "missing: 判据 3",
    `# version=${version}`,
  ].join("\n");
}

/** 跑一次带续接 provider 的 run（共享夹具：内存 store、无真实网络、runId 由调用方给）。 */
function runWithContinuity({
  runId,
  continuityProvider,
  provider,
  config = {},
  maxRounds = 6,
  events,
} = {}) {
  return runDirect({
    provider,
    store: createMemoryTranscriptStore(),
    tools: TOOLS,
    executeTool,
    // 每轮 Judge 是**另一条** provider 请求（提示词里没有会话消息），会把「请求流」的对拍与
    // 「块停在尾部」的断言搅浑 ⇒ 本文件的 run 一律关掉它（与续接块无关的治理面，不属于本单）。
    config: {
      ...config,
      run: {
        runId,
        completion: false,
        maxRounds,
        reflection: { enabled: false },
        ...(config.run ?? {}),
      },
    },
    seed: "开始任务",
    // 两个回调都写在**规范之家** `capabilities.hooks.*`（#498：回调收能力面，不再加顶层扁平键）。
    ...(events === undefined && continuityProvider === undefined
      ? {}
      : {
        capabilities: {
          hooks: {
            ...(continuityProvider === undefined ? {} : { continuityProvider }),
            ...(events === undefined ? {} : { onEvent: (event) => events.push(event) }),
          },
        },
      }),
  });
}

// ================================================================ 判据 1
//
// 新 run 的**第一条模型请求**里就有这块，且 provider 在此之前**已经被调用过一次**。
// 为什么这条必须单独存在：今天的 semantic 槽位只在折叠/低预算点刷新，于是「没有折叠 ⇒ provider
// 0 次调用」——首请求永远看不到最新状态（#568 的病根之一）。这条格把「run 启动刷新」那一腿钉住。

test("判据 1：新 run 首请求即见最新状态（provider 在第一次请求之前就调过，不依赖折叠）", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "收到" }], stopReason: "end_turn" },
  ]);
  const calls = [];
  const run = await runWithContinuity({
    runId: "s568-c1",
    provider,
    continuityProvider: async (payload) => {
      calls.push(payload);
      return { version: 7, text: fixedContinuityText({ version: 7 }) };
    },
  });

  assert.equal(run.termination.reason, "end_turn", "前提不成立：run 没正常收尾");
  assert.equal(provider.requests.length, 1, "前提不成立：本格要的是**第一条**请求");
  assert.equal(calls.length, 1, "run 启动必须刷新一次（无折叠也要调 provider）");

  const first = provider.requests[0];
  const block = blockTextOfRequest(first);
  assert.ok(block !== undefined, "首请求里没有续接块——「run 启动刷新」这一腿断了");
  assert.ok(block.startsWith(CONTINUITY_BLOCK_START), "块必须带起始 marker（否则下次无法就地替换）");
  assert.ok(block.includes("goal: 会话续接块注入面"), "provider 的内容必须原样到达模型");
  assert.ok(isContinuityMessage(persistentTailOf(first)), "块必须落在请求**尾部**（messages 的最后一条）");
  assert.equal(
    JSON.stringify(first.system ?? null).includes(CONTINUITY_BLOCK_START),
    false,
    "块**不许**进 mainSystem（system 在历史之前，改它会让其后整段历史的前缀复用作废）",
  );

  // provider 的入参形状：`{runId, state, previous}`（与 semanticStateProvider 同形）。
  assert.deepEqual(Object.keys(calls[0]).sort(), ["previous", "runId", "state"]);
  assert.equal(calls[0].runId, "s568-c1");
  assert.equal(typeof calls[0].state, "object", "state 必须是本次 run 的确定性状态");
  assert.equal(calls[0].previous, undefined, "第一次调用没有 previous");
});

// ================================================================ 判据 2
//
// 事故原样复现：**第 21 折仍保住第 1 折的未完成项**。
// 构造方式：小预算（`budgetTokens: 40`）+ `keepRounds: 0` + 22 轮合成工具调用 ⇒ 每轮都折叠；
// provider 每次被调用时把「本次新增的未完成项」追加进自己的账本（模拟宿主把第 1 折的条目一直带着），
// 断言最后一发的请求里**第 1 折那条**还在可见块里。

test("判据 2：第 21 折仍保住第 1 折的未完成项（小预算 + keepRounds 0 + 22 轮，每轮折叠）", async () => {
  const TOOL_TURNS = 22;
  const provider = createFakeProvider([
    ...Array.from({ length: TOOL_TURNS }, (_, index) => ({
      content: [{
        type: "tool_use",
        id: `tu_${index + 1}`,
        name: "echo",
        input: { text: `R${index + 1}_${"填充".repeat(400)}` },
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
  ]);
  // 宿主侧的「未完成项账本」：每次被调用就记一条，永远不丢旧的（这就是宿主该做的事）。
  const items = [];
  let calls = 0;
  const events = [];
  const run = await runWithContinuity({
    runId: "s568-c2",
    provider,
    maxRounds: TOOL_TURNS + 3,
    config: {
      folding: { context: { budgetTokens: 40, keepRounds: 0, continuityMaxTokens: 400 } },
    },
    events,
    continuityProvider: async () => {
      calls += 1;
      items.push(`u${calls}: 第 ${calls} 次刷新记下的未完成项`);
      return {
        version: calls,
        text: [
          "[contract]",
          "goal: 21 折之后仍能定位第 1 折的未完成项",
          "[unfinished]",
          ...items,
          "[evidence]",
          "verified: none",
        ].join("\n"),
      };
    },
  });

  const folds = events.filter((event) => event.type === "compaction").length;
  assert.ok(folds >= 21, `前提不成立：只折叠了 ${folds} 次（本格要 ≥ 21 次）`);
  assert.ok(calls >= 22, `刷新次数必须跟得上折叠次数，实测 ${calls}`);
  assert.equal(run.termination.reason, "end_turn", "前提不成立：run 没正常收尾");

  const last = provider.requests.at(-1);
  const block = blockTextOfRequest(last);
  assert.ok(block !== undefined, "最后一发请求里没有续接块——它被折叠吃掉了");
  assert.ok(
    block.includes("u2: 第 2 次刷新记下的未完成项"),
    "**第 1 折**（第 2 次刷新，紧接 run 启动那一次）记下的未完成项必须仍在可见块里",
  );
  assert.ok(block.includes("u1: "), "run 启动那一次的条目也必须仍在");
  assert.ok(block.includes("goal: 21 折之后仍能定位第 1 折的未完成项"), "骨架三段之一（contract）必须仍在");
});

// ================================================================ 判据 3
//
// **估算可见**：块必须进 `compactBeforeRound` 的 `estimateMessageTokens(messages)`。
// 边界构造：消息本身（种子 "开始任务" + 一条固定开销）在预算内，**加上块才超预算** ⇒ 必须折叠。
// 把块塞进 `mainSystem` 的变异会让这条红：`mainSystem` 不在那份估算里，于是不折叠。

test("判据 3：估算看得见块——消息在预算内、加上块才超预算 ⇒ 必须折叠", async () => {
  const BUDGET = 60;
  const events = [];
  const small = await runWithContinuity({
    runId: "s568-c3-small",
    provider: createFakeProvider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]),
    config: { folding: { context: { budgetTokens: BUDGET, keepRounds: 0 } } },
    events,
    // 小到「消息 + 块」仍在预算内 ⇒ 不该折叠（对照组：证明这条判据不是恒真的）。
    continuityProvider: async () => ({ version: 1, text: "[contract]\nx\n[unfinished]\ny\n[evidence]\nz" }),
  });
  const smallFolds = events.filter((event) => event.type === "compaction").length;
  assert.equal(smallFolds, 0, "对照组不成立：小块也折叠了 ⇒ 本格证明不了「块把估算推过线」");
  assert.equal(small.termination.reason, "end_turn");

  // 主格：同一预算、同一条种子，只有块变大 ⇒ 估算越线 ⇒ 必须折叠。
  const bigText = ["[contract]", "goal: 撑大估算", "[unfinished]", ...Array.from({ length: 30 }, (_, index) => `u${index}: ${"填充".repeat(20)}`), "[evidence]", "verified: none"].join("\n");
  assert.ok(estimateTokens(bigText) > BUDGET, "前提不成立：这份块本身没超过预算");
  const bigEvents = [];
  const big = await runWithContinuity({
    runId: "s568-c3-big",
    provider: createFakeProvider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]),
    config: { folding: { context: { budgetTokens: BUDGET, keepRounds: 0, continuityMaxTokens: 2000 } } },
    events: bigEvents,
    continuityProvider: async () => ({ version: 1, text: bigText }),
  });
  const bigFolds = bigEvents.filter((event) => event.type === "compaction").length;
  assert.ok(
    bigFolds > 0,
    "块没有进本地估算：消息本身在预算内、只有加上块才超，却没有折叠（把块塞进 mainSystem 就是这个形状）",
  );
  assert.equal(big.termination.reason, "end_turn");
});

// ================================================================ 判据 4
//
// **关掉 provider ⇒ 行为逐字回到今天**：同一条 provider 脚本跑两遍，一遍带续接 provider、一遍不带，
// 去掉块之后两份请求消息流必须**逐字相等**（对拍，不是「大致一样」）。

test("判据 4：关掉 provider ⇒ 请求消息流逐字回到今天（对拍）", async () => {
  const script = () => [
    { content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "tu_2", name: "echo", input: { text: "b" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
  ];
  const withProvider = createFakeProvider(script());
  const withoutProvider = createFakeProvider(script());
  const on = await runWithContinuity({
    runId: "s568-c4-on",
    provider: withProvider,
    continuityProvider: async () => ({ version: 1, text: fixedContinuityText() }),
  });
  const off = await runWithContinuity({
    runId: "s568-c4-off",
    provider: withoutProvider,
  });

  assert.equal(on.termination.reason, off.termination.reason, "终局必须一致");
  assert.equal(withProvider.requests.length, withoutProvider.requests.length, "请求条数必须一致");
  for (const request of withoutProvider.requests) {
    assert.equal(blockTextOfRequest(request), undefined, "关掉 provider 时不许出现任何续接块");
  }
  for (const [index, request] of withProvider.requests.entries()) {
    const baseline = withoutProvider.requests[index];
    assert.deepEqual(
      normalizeForParity(messagesWithoutBlock(request)),
      normalizeForParity(baseline.messages),
      `第 ${index + 1} 条请求去掉块之后必须与「关掉 provider」的那一份逐字相等`
      + "（只剔掉 toolCallKey / durationMs 这类跨 run 天然不同的引擎事实键）",
    );
    assert.equal(
      JSON.stringify(request.system ?? null),
      JSON.stringify(baseline.system ?? null),
      "system 必须逐字相同（块不进 mainSystem）",
    );
  }
});

// ================================================================ 判据 5
//
// 超预算 ⇒ **显式**不完整标记，且骨架三段仍在。两层：
//   · 渲染层（纯函数，能精确断言字节）：丢条目、每段至少留 1 条、标记里报「丢了几条」；
//   · run 级：`continuityMaxTokens` 生效（配置旋钮真的被读到，而不是只有渲染函数认它）。

test("判据 5：超预算有显式不完整标记，且骨架三段仍在（不许静默截断、不许删骨架）", () => {
  const sections = {
    contract: ["goal: 保骨架", "must: 不许静默截断"],
    unfinished: Array.from({ length: 20 }, (_, index) => `u${index + 1}: 未完成项 ${index + 1}`),
    evidence: ["verified: none", "claimed: 判据 5", "missing: 判据 7"],
  };
  const full = renderContinuityBlock({ sections, version: 3, maxTokens: 100_000 });
  assert.equal(full.incomplete, false, "预算充足时不许出现不完整标记");
  assert.equal(full.droppedEntries, 0);
  assert.ok(!full.text.includes("[continuity incomplete:"), "预算充足时一个字节的标记都不许多写");
  const totalEntries = 2 + 20 + 3;

  // 主格：预算 120 ⇒ 必须丢条目（显式标记），但三段小标题一个都不许少。
  const bounded = renderContinuityBlock({ sections, version: 3, maxTokens: 120 });
  assert.equal(bounded.incomplete, true, "超预算必须标 incomplete");
  assert.ok(bounded.droppedEntries > 0, "超预算必须真的丢条目（否则标记就是假的）");
  assert.ok(
    bounded.text.includes(`[continuity incomplete: dropped ${bounded.droppedEntries} of ${totalEntries} entries`),
    `不完整标记必须说清「丢了几条 / 一共几条」，实测：${bounded.text.split("\n").at(-2)}`,
  );
  for (const name of CONTINUITY_SECTION_NAMES) {
    assert.ok(bounded.text.includes(`## ${name}`), `骨架段 ${name} 被删了——骨架三段永不因超预算被删`);
  }
  assert.ok(bounded.tokens <= 120, `降采样之后必须落回预算内，实测 ${bounded.tokens}`);
  // 「保留可定位条目」：每段至少留一条，且留下的条目逐字可定位。
  assert.ok(bounded.text.includes("- goal: 保骨架"), "contract 的第一条必须保留（可定位条目）");
  assert.ok(/^- u\d+: 未完成项 \d+$/mu.test(bounded.text), "unfinished 至少留一条可定位条目");

  // 病态格：预算小到「每段留 1 条」也装不下 ⇒ 宁可超预算，也不删骨架，并且明说 still over budget。
  const pathological = renderContinuityBlock({ sections, version: 3, maxTokens: 20 });
  assert.equal(pathological.overBudget, true, "装不下时必须标 overBudget，而不是静默截断");
  assert.ok(pathological.text.includes("still over budget"), "装不下时标记必须说清「仍然超预算」");
  for (const name of CONTINUITY_SECTION_NAMES) {
    assert.ok(pathological.text.includes(`## ${name}`), `病态格也不许删骨架段 ${name}`);
  }
  assert.ok(pathological.text.startsWith(CONTINUITY_BLOCK_START));
  assert.ok(pathological.text.endsWith(CONTINUITY_BLOCK_END));
});

test("判据 5b：`config.folding.context.continuityMaxTokens` 真的被引擎读到（run 级，不是只有渲染函数认它）", async () => {
  const longText = [
    "[contract]",
    "goal: 旋钮必须生效",
    "[unfinished]",
    ...Array.from({ length: 40 }, (_, index) => `u${index + 1}: ${"长条目".repeat(10)}`),
    "[evidence]",
    "verified: none",
  ].join("\n");
  const provider = createFakeProvider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]);
  await runWithContinuity({
    runId: "s568-c5b",
    provider,
    config: { folding: { context: { continuityMaxTokens: 150 } } },
    continuityProvider: async () => ({ version: 1, text: longText }),
  });
  const block = blockTextOfRequest(provider.requests[0]);
  assert.ok(block.includes("[continuity incomplete:"), "旋钮没生效：超预算却没有不完整标记");
  for (const name of CONTINUITY_SECTION_NAMES) {
    assert.ok(block.includes(`## ${name}`), `骨架段 ${name} 必须仍在`);
  }
  assert.ok(estimateTokens(block) <= 150, `旋钮没生效：块 ${estimateTokens(block)} tokens 超过 continuityMaxTokens=150`);

  // 默认值兜底：不给旋钮时用 `CONTINUITY_DEFAULT_MAX_TOKENS`（1200，试验值）。
  const defaults = renderContinuityBlock({ sections: { contract: ["x"] } });
  assert.equal(defaults.maxTokens, CONTINUITY_DEFAULT_MAX_TOKENS);
});

// ================================================================ 判据 6
//
// **不破坏相邻性**：尾部正挂着未结清的 `tool_use` 时不许把块插在它与 `tool_result` 之间。
// 单元格钉注入函数，run 格钉「引擎真的走了那条跳过分支并记账」。

test("判据 6a：尾部悬空 tool_use ⇒ 注入函数不插在中间（单元格）", () => {
  const dangling = [
    { role: "user", content: [{ type: "text", text: "开始" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "echo", input: {} }] },
  ];
  const blocked = upsertContinuityInMessages(dangling, fixedContinuityBlock());
  assert.equal(blocked.injected, false, "尾部悬空 tool_use 时**不许**注入");
  assert.equal(blocked.reason, "pending_tool_use");
  assert.equal(blocked.messages, dangling, "messages 必须逐字原样返回（不插、不挪）");

  // 结清之后（tool_result 落地）⇒ 块落在结果**之后**，配对仍然相邻。
  const settled = [
    ...dangling,
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
  ];
  const applied = upsertContinuityInMessages(settled, fixedContinuityBlock());
  assert.equal(applied.injected, true);
  assert.equal(applied.reason, "inserted");
  assert.equal(applied.messages.at(-1).role, "user");
  assert.ok(isContinuityMessage(applied.messages.at(-1)), "块必须落在尾部");
  assert.equal(applied.messages.at(-2), settled.at(-1), "tool_result 必须紧跟在 tool_use 之后（相邻性未破）");

  // 重复的块（`ensureUserTurnView` 的复制格会造出第二条）⇒ 收口成一条，不留两条。
  const duplicated = [
    ...applied.messages.slice(0, -1),
    applied.messages.at(-1),
    { role: "user", content: [{ type: "text", text: fixedContinuityBlock({ version: 9 }) }] },
  ];
  const collapsed = upsertContinuityInMessages(duplicated, fixedContinuityBlock({ version: 3 }));
  assert.equal(continuityMessageCount(collapsed.messages), 1, "重复的块必须收口成一条（每轮至多一条）");
  assert.ok(blockTextOf(collapsed.messages.at(-1)).includes("version=3"), "收口后正文必须是新的那一份");

  // 已在尾部时只换正文（就地替换，条数不变）。
  const inPlace = upsertContinuityInMessages(applied.messages, fixedContinuityBlock({ version: 2 }));
  assert.equal(inPlace.reason, "in_place");
  assert.equal(inPlace.messages.length, applied.messages.length, "就地替换不许改变消息条数");
  assert.ok(blockTextOf(inPlace.messages.at(-1)).includes("version=2"), "正文必须是新的那一份");

  // 被新消息压在后面 ⇒ 挪回尾部（条数仍不变），且悬空 tool_use 时**不挪**。
  const drifted = [
    applied.messages[0],
    applied.messages[1],
    applied.messages[2],
    { role: "assistant", content: [{ type: "text", text: "中间" }] },
    applied.messages[3],
    { role: "assistant", content: [{ type: "text", text: "更后面" }] },
  ];
  const moved = positionContinuityBlock(drifted);
  assert.equal(moved.moved, true);
  assert.ok(isContinuityMessage(moved.messages.at(-1)), "块必须回到尾部");
  // 「挪动不许改变条数」由判据 7 独占断言（不膨胀是那一格的性质；这里只管相邻性）。
  const stillDangling = [
    ...dangling,
    { role: "user", content: [{ type: "text", text: "别的东西" }] },
  ];
  // 尾部是 assistant[tool_use] 时位置函数也不许挪（它会把块挪到 tool_use 与结果之间）。
  const keep = positionContinuityBlock([
    { role: "user", content: [{ type: "text", text: fixedContinuityBlock() }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_9", name: "echo", input: {} }] },
  ]);
  assert.equal(keep.moved, false);
  assert.equal(keep.reason, "pending_tool_use");
  assert.notEqual(stillDangling.length, 0, "夹具自检");
});

test("判据 6b：run 级——尾部悬空 tool_use 上不注入，并把原因记进诊断（onEvent）", async () => {
  // 为什么用「初始消息尾部就是悬空 tool_use」这条形状：引擎里唯一会带着悬空 `tool_use` 走到注入点的
  // 时刻就是**启动刷新**（续写轮那条路上，`roundNumbersForMessages` 的严格校验会先抛——那是本单之外
  // 的既有形状，见 DELIVERY.md「遗留」）。这条形状可达、且判据要的东西全在：闸门真的咬住、原因真的
  // 记进诊断、块**没有**被塞进 `tool_use` 与它的 `tool_result` 之间。
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "不该走到这里" }], stopReason: "end_turn" },
  ]);
  const events = [];
  /** @type {any} */
  let failure;
  try {
    await runWithContinuity({
    runId: "s568-c6b",
    provider,
    config: {
      input: {
        messages: [
          { role: "user", content: [{ type: "text", text: "开始任务" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }] },
        ],
      },
    },
    events,
    continuityProvider: async () => ({ version: 1, text: fixedContinuityText() }),
    });
  } catch (error) {
    failure = error;
  }

  const skips = events.filter((event) => event.type === "continuity_injection_skipped");
  assert.equal(skips.length, 1, "悬空 tool_use 上跳过注入必须记账（不许静默跳过）");
  assert.equal(skips[0].reason, "pending_tool_use");
  assert.equal(skips[0].runId, "s568-c6b", "诊断必须带 runId（宿主并行多 run 时可归因）");
  assert.ok(
    typeof skips[0].detail === "string" && skips[0].detail.includes("tool_use"),
    "detail 必须说清「为什么本轮没注入」",
  );
  // 块**没有**被塞进那一对之间：一条请求都没发出去（悬空 tool_use 的历史本来就不合法，
  // 校验器在请求之前就拒了——那是既有形状，不是本单改的）。
  assert.equal(provider.requests.length, 0, "块不许把悬空 tool_use 的配对挤开（那条请求根本没发）");
  assert.equal(
    failure?.code,
    "invalid_messages",
    "前提：这条历史形状今天就不合法（本库校验器在请求之前就拒；本格只证明闸门与记账，不改那条既有形状）",
  );
});

// ================================================================ 判据 7
//
// **不膨胀**：连续 5 轮，请求里的块消息条数恒为 1，且「去掉块之后的消息条数」与关掉 provider
// 的基线逐轮相等（同一块就地替换 / 挪回尾部，绝不每轮追加一条新的）。

test("判据 7：连续 5 轮不膨胀——每轮恰好 1 条块消息，条数不随轮数增长", async () => {
  const TOOL_TURNS = 5;
  const script = () => [
    ...Array.from({ length: TOOL_TURNS }, (_, index) => ({
      content: [{ type: "tool_use", id: `tu_${index + 1}`, name: "echo", input: { text: `t${index + 1}` } }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
  ];
  const on = createFakeProvider(script());
  const off = createFakeProvider(script());
  await runWithContinuity({
    runId: "s568-c7-on",
    provider: on,
    maxRounds: 8,
    continuityProvider: async ({ previous }) => ({
      version: Number(previous?.version ?? 0) + 1,
      text: fixedContinuityText({ version: Number(previous?.version ?? 0) + 1 }),
    }),
  });
  await runWithContinuity({ runId: "s568-c7-off", provider: off, maxRounds: 8 });

  assert.equal(on.requests.length, TOOL_TURNS + 1, "前提不成立：请求条数不是 5 轮 + 收尾");
  for (const [index, request] of on.requests.entries()) {
    assert.equal(
      continuityMessageCount(request.messages),
      1,
      `第 ${index + 1} 条请求里有 ${continuityMessageCount(request.messages)} 条块消息（必须恰好 1 条：不许每轮追加）`,
    );
    assert.equal(
      request.messages.length,
      off.requests[index].messages.length + 1,
      `第 ${index + 1} 条请求的消息条数 = 基线 + 1（块只占一条，且不随轮数增长）`,
    );
    assert.ok(
      isContinuityMessage(persistentTailOf(request)),
      `第 ${index + 1} 条请求：块必须停在 messages 的尾部（其后最多只跟一条 run-state 块）`,
    );
  }
});

// ================================================================ 附加：缺失即 unknown（issue #568 §2.8）
//
// provider 没给 / 给了空 / 调用抛错 ⇒ 明写 `unknown`，**不拿机械文本冒充语义成功**。
// 与「关掉 provider」是两件事：关掉 ⇒ 整块不注入（判据 4），配了但没内容 ⇒ 块在、三段写 unknown。

test("缺失即 unknown：provider 没给 / 给空 / 抛错三种形状都写 unknown，且块仍带三段骨架", async () => {
  for (const [label, provider] of [
    ["没给（undefined）", async () => undefined],
    ["给空（空字符串）", async () => ({ version: 1, text: "" })],
    ["抛错", async () => { throw new Error("host provider exploded"); }],
  ]) {
    const fake = createFakeProvider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]);
    const run = await runWithContinuity({
      runId: `s568-unknown-${label}`,
      provider: fake,
      continuityProvider: provider,
    });
    assert.equal(run.termination.reason, "end_turn", `${label}：provider 的问题不许改写 run 的终局`);
    const block = blockTextOfRequest(fake.requests[0]);
    assert.ok(block !== undefined, `${label}：块必须仍在（配了 provider 就注入，缺内容标 unknown）`);
    for (const name of CONTINUITY_SECTION_NAMES) {
      assert.ok(block.includes(`## ${name}`), `${label}：骨架段 ${name} 必须仍在`);
    }
    assert.equal(
      (block.match(/^- unknown$/gmu) ?? []).length,
      CONTINUITY_SECTION_NAMES.length,
      `${label}：三段各写一行 unknown（不许用机械文本冒充语义）`,
    );
    assert.ok(block.includes("status=absent") || block.includes("status=empty") || block.includes("status=error"),
      `${label}：状态必须在块头说清楚，实测：${block.split("\n")[1]}`);
  }
});

// ================================================================ 附加：归一化与边界（纯函数）
//
// 不是判据，但它们是判据的地基：`normalizeContinuityProvided` 是「宿主内容 → 三段」的唯一入口。

test("归一化：段标题之外的行落 notes 段（引擎不猜自由文本属于哪一段），条目行有字符上界", () => {
  const normalized = normalizeContinuityProvided({
    version: 2,
    text: "这段在段标题之前\n[contract]\ngoal: g\n[unfinished]\nu1: a\n[evidence]\nverified: none",
  });
  assert.equal(normalized.status, "ok");
  assert.equal(normalized.version, 2);
  assert.deepEqual(normalized.sections.notes, ["这段在段标题之前"]);
  assert.deepEqual(normalized.sections.contract, ["goal: g"]);

  const longLine = "x".repeat(CONTINUITY_MAX_ENTRY_CHARS + 50);
  const rendered = renderContinuityBlock({ sections: { contract: [longLine] } });
  assert.ok(rendered.text.includes("…[cut]"), "单条条目必须有可见的字符上界（夹断不静默）");

  // 结构化形态逐键胜（宿主可以直接给三段，不必写段标题）。
  const structured = normalizeContinuityProvided({
    sections: { unfinished: ["u9: 结构化"] },
    text: "[contract]\ngoal: from text",
  });
  assert.deepEqual(structured.sections.unfinished, ["u9: 结构化"]);
  assert.deepEqual(structured.sections.contract, ["goal: from text"], "没给的那一段仍从 text 取");
});

// ================================================================ 附加：resume（宿主真实路径）
//
// resume 之后消息流里可能已经躺着上一段 run 的块（run snapshot / 账本回放）。启动刷新必须**就地替换**
// 它，而不是再插一条：否则「一个会话跑三段」就会有三条块（判据 7 的同一性质跨 run 的版本）。

test("resume：上一段 run 的块被就地替换，不新增（每条请求仍恰好 1 条）", async () => {
  const store = createMemoryTranscriptStore();
  const continuityProvider = async () => ({
    version: 1,
    text: fixedContinuityText({ version: 1 }),
  });
  const base = {
    store,
    tools: TOOLS,
    executeTool,
    capabilities: { hooks: { continuityProvider } },
  };
  const first = await runDirect({
    ...base,
    provider: createFakeProvider([
      { content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "a" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "第一段收尾" }], stopReason: "end_turn" },
    ]),
    config: { run: { runId: "s568-resume", completion: false, maxRounds: 4, reflection: { enabled: false } } },
    seed: "开始任务",
  });
  assert.equal(first.termination.reason, "end_turn", "前提不成立：第一段没跑完");

  const resumed = createFakeProvider([
    { content: [{ type: "tool_use", id: "tu_2", name: "echo", input: { text: "b" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "第二段收尾" }], stopReason: "end_turn" },
  ]);
  const second = await runDirect({
    ...base,
    provider: resumed,
    config: {
      run: { runId: "s568-resume", completion: false, maxRounds: 4, reflection: { enabled: false }, resume: true },
    },
  });
  assert.equal(second.termination.reason, "end_turn", "resume 之后必须照常收尾");
  assert.ok(resumed.requests.length > 0, "前提不成立：resume 之后一发请求都没发");
  for (const [index, request] of resumed.requests.entries()) {
    assert.equal(
      continuityMessageCount(request.messages),
      1,
      `resume 之后第 ${index + 1} 条请求里有 ${continuityMessageCount(request.messages)} 条块消息（必须恰好 1 条）`,
    );
  }
});

/** 一条固定的块正文（供单元格用）。 */
function fixedContinuityBlock(options) {
  const normalized = normalizeContinuityProvided({ text: fixedContinuityText(options) });
  return renderContinuityBlock({
    sections: normalized.sections,
    version: normalized.version,
  }).text;
}

// ================================================================ 判据 8（issue #640）
//
// 补的是**证据**，不是措辞：`upsertContinuityInMessages` 的五个 `reason` 里，`moved_to_tail` 与
// `empty` 此前在 `test/**/*.test.js` 里**零 `.reason` 断言**，而 `moved_to_tail` 恰恰是 #547/#568
// 「块被新消息压在后面要挪回尾部」那条修复的正主。只断言 `reason` 等于某个字符串不够——那正是今天
// 缺的证据——所以 8a 同时钉三件：**消息条数不变 + 块停在尾部（同一条消息对象）+ 正文已换**。
// 8b/8c 把另外三个此前没被断言的出口（`empty`、`absent`、`already_tail`）也各钉一格。

test("判据 8a（#640）：`moved_to_tail` —— 条数不变 + 停在尾部 + 正文已换，三件同时成立", () => {
  const seeded = upsertContinuityInMessages(
    [
      { role: "user", content: [{ type: "text", text: "开始" }] },
      { role: "assistant", content: [{ type: "text", text: "收到" }] },
    ],
    fixedContinuityBlock({ version: 1 }),
  );
  assert.equal(seeded.reason, "inserted", "夹具自检：先落一条 v1 的块（`inserted` 不是本格要钉的出口）");
  const block = seeded.messages.at(-1);
  const drifted = [
    seeded.messages[0],
    seeded.messages[1],
    block,
    { role: "assistant", content: [{ type: "text", text: "块之后的新消息 A" }] },
    { role: "user", content: [{ type: "text", text: "块之后的新消息 B" }] },
  ];
  assert.notEqual(drifted.at(-1), block, "夹具自检：调用前块**不在**尾部（否则会走到 `in_place` 那支）");
  assert.equal(drifted.indexOf(block), 2, "夹具自检：块在中间");

  const moved = upsertContinuityInMessages(drifted, fixedContinuityBlock({ version: 2 }));
  assert.equal(moved.reason, "moved_to_tail");
  assert.equal(moved.injected, true, "`moved_to_tail` 是「注入了」那一组");
  // ① 消息条数不变：挪不是复制、也不是删。
  assert.equal(
    moved.messages.length,
    drifted.length,
    `挪回尾部不许改变消息条数（${moved.messages.length} ≠ ${drifted.length}）`,
  );
  assert.equal(continuityMessageCount(moved.messages), 1, "挪动不许留下第二条块");
  // ② 块停在尾部，且**是同一条消息对象**（`messageRounds` 以对象为键，换对象 = 轮号丢掉）。
  assert.equal(moved.messages.at(-1), block, "块必须回到尾部，且必须是同一条消息对象（换对象 = 轮号映射丢掉）");
  assert.ok(isContinuityMessage(moved.messages.at(-1)), "尾部那条必须是块消息");
  // ③ 正文已换：版本号是新的，旧正文不残留（不是把旧块挪了个位置）。
  const tailText = blockTextOf(moved.messages.at(-1)) ?? "";
  assert.ok(tailText.includes("version=2"), "正文必须是新的那一份（v2）");
  assert.ok(!tailText.includes("version=1"), "旧正文不许残留");
  // 反向自检：挪动之后，原本压在块后面的两条消息必须仍在块**之前**且相对顺序不变。
  assert.deepEqual(
    moved.messages.map((message) => (isContinuityMessage(message) ? "块" : "非块")),
    ["非块", "非块", "非块", "非块", "块"],
    "挪动只许把块搬到尾部：其余消息的相对顺序不变，块是最后一条",
  );
});

test("判据 8b（#640）：`empty` —— 防御分支（messages 不是数组 / 正文不是非空字符串）不注入且逐字返回", () => {
  const text = fixedContinuityBlock();
  const notArray = upsertContinuityInMessages(undefined, text);
  assert.equal(notArray.injected, false, "非数组入参不许注入");
  assert.equal(notArray.reason, "empty");
  assert.equal(notArray.messages, undefined, "非数组入参必须逐字返回（不许造一个空数组出来）");

  const messages = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  for (const rendered of ["", "   \n\t "]) {
    const blocked = upsertContinuityInMessages(messages, rendered);
    assert.equal(blocked.injected, false, "空正文不许注入");
    assert.equal(blocked.reason, "empty");
    assert.equal(blocked.messages, messages, "空正文必须逐字返回同一份 messages（不插空块、不重建数组）");
  }
  assert.equal(upsertContinuityInMessages(messages, 42).reason, "empty", "非字符串正文同样走防御分支");
});

test("判据 8c（#640）：`positionContinuityBlock` 的 `absent`（没块 / 不是数组）与 `already_tail`（已在尾部且单条）", () => {
  const notArray = positionContinuityBlock("不是数组");
  assert.equal(notArray.moved, false);
  assert.equal(notArray.reason, "absent");
  assert.equal(notArray.messages, "不是数组", "非数组入参必须逐字返回");

  const noBlockMessages = [{ role: "user", content: [{ type: "text", text: "没有块" }] }];
  const noBlock = positionContinuityBlock(noBlockMessages);
  assert.equal(noBlock.moved, false);
  assert.equal(noBlock.reason, "absent");
  assert.equal(noBlock.messages, noBlockMessages, "`absent` 必须逐字返回同一份 messages（不删消息、不重建数组）");

  const atTail = [
    { role: "user", content: [{ type: "text", text: "开始" }] },
    { role: "user", content: [{ type: "text", text: fixedContinuityBlock({ version: 4 }) }] },
  ];
  const keep = positionContinuityBlock(atTail);
  assert.equal(keep.moved, false, "已在尾部 ⇒ 不挪");
  assert.equal(keep.reason, "already_tail");
  assert.equal(keep.messages, atTail, "`already_tail` 必须逐字返回同一份 messages（不重建数组）");
  assert.ok(isContinuityMessage(keep.messages.at(-1)), "前提：块本来就在尾部");
  assert.ok((blockTextOf(keep.messages.at(-1)) ?? "").includes("version=4"), "前提：正文是 v4（本函数不换正文）");

  // 分界：`already_tail` 的口径是「**恰好一条**块 + 它就是最后一条消息」。两条块时（哪怕末尾
  // 那条本来就在尾部）走的是 `moved_to_tail`——本函数只挪最后那条、**不**收口重复块（收口是
  // `upsertContinuityInMessages` 的职责，判据 6a 已钉）。这里把这条分界也钉住，免得两个名字的
  // 边界只能靠读实现猜。
  const doubled = [
    atTail[0],
    { role: "user", content: [{ type: "text", text: fixedContinuityBlock({ version: 3 }) }] },
    atTail[1],
  ];
  const repositioned = positionContinuityBlock(doubled);
  assert.equal(repositioned.reason, "moved_to_tail", "两条块时即便末尾那条已在尾部也不算 `already_tail`（`already_tail` 只认恰好一条块）");
  assert.equal(repositioned.moved, true);
  assert.equal(repositioned.messages.at(-1), doubled.at(-1), "挪的是最后那条块");
  assert.equal(continuityMessageCount(repositioned.messages), 2, "本函数不负责收口重复块（那是 upsert 的职责）");
});
