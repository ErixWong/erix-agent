// issue #192 —— Anthropic 提示缓存的**尾部滚动断点**。
//
// 裁决（2026-10-31 审计轮，见工单评论）：本单只做「尾部滚动断点」一条；tools 断点与 1h TTL
// 等实测收益再谈（TTL 本轮明确不做，architecture 的缓存小节里写明）。
//
// 本文件钉三件事，按证据强度从强到弱：
//   ① **形状**：真 Anthropic 适配器序列化出来的 payload 里，`cache_control` 落在哪三个块上、
//      一共几处、以及「每轮新建的 run-state 块不许被打标」——这条是**离线可证**的。
//   ② **滚动性**：第 N 轮被打标的尾部，在第 N+1 轮的请求里**逐字仍在同一位置**（内容前缀不变）。
//      这是上游能命中的前提条件，本地只能证到这个前提，不能证命中本身。
//   ③ **usage 对账（模拟上游）**：一个按 Anthropic 文档「断点前缀匹配」语义实现的本地模拟上游，
//      用同一份 payload 算出 cache_read / cache_creation 并回填 usage，验证「payload 形状 →
//      上游缓存 → usage.cacheRead/cacheWrite」这条链是通的，且尾部断点让第 2 轮起的 cacheRead
//      从「只有首条 user 前缀」抬到「整段历史前缀」。
//
// ⚠ **③ 的数字不是真上游命中率**：那是本文件自己按语义算出来的（本机没有 Anthropic 凭据，
// 见报告）。真实命中率必须在真 Anthropic 上游上跑（`usage.cache_read_input_tokens` /
// `cache_creation_input_tokens` 由上游返回，本仓 #40 已把两者映射成 `cacheRead` / `cacheWrite`）。
import assert from "node:assert/strict";
import test from "node:test";

import { callProvider, markStablePrefix } from "../src/loop/provider-runner.js";
import { canonicalToAnthropicRequest } from "../src/messages/anthropic.js";
import { CONTINUITY_BLOCK_START } from "../src/loop/continuity-block.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { estimateTokens } from "../src/tokens.js";

const MODEL = "claude-test";

/** 用真 `createAnthropicProvider` + 假 `fetchImpl`：拿到的是**真序列化**的 wire body。 */
function createWire(usage) {
  const bodies = [];
  const provider = createAnthropicProvider({
    endpoint: "http://127.0.0.1:1",
    apiKey: "scripted-key",
    model: MODEL,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: usage ?? { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { provider, bodies };
}

function makeContext({ provider, messages, ...rest }) {
  return {
    provider,
    mainSystem: "stable system",
    messages,
    signal: undefined,
    stream: false,
    retryOptions: null,
    retryAttempts: 0,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    emitEvent() {},
    reportObserverError() {},
    awaitWithAbort: (promise) => promise,
    waitForRetry: async () => {},
    estimateMessageTokens: () => 1,
    roundEventDeltas: [],
    finalText: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    latestApiInputTokens: undefined,
    latestApiEstimatedTokens: undefined,
    roundStopReason: undefined,
    ...rest,
  };
}

function conversation() {
  return [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "later" }] },
  ];
}

/** payload 里所有带 `cache_control` 的块，按 wire 顺序。 */
function breakpointBlocks(payload) {
  const blocks = [];
  if (Array.isArray(payload.system)) blocks.push(...payload.system);
  else if (typeof payload.system === "string") blocks.push({ type: "text", text: payload.system });
  for (const message of payload.messages) blocks.push(...message.content);
  return blocks.filter((block) => block.cache_control !== undefined);
}

// ================================================================ ① 形状

test("#192 T1：三个断点 = system / 首条 user / 持久历史尾巴；run-state 块不被打标", async () => {
  const { provider, bodies } = createWire();
  const ctx = makeContext({ provider, messages: conversation() });

  await callProvider(ctx, { round: 1, requestStateBlock: "[run state] round=1 budget=1" });

  const [payload] = bodies;
  // 三处，且各自落在预期位置。
  assert.equal(breakpointBlocks(payload).length, 3, "默认必须恰好三处断点（system + 首条 user + 尾部）");
  assert.equal(payload.system.at(-1).cache_control.type, "ephemeral");
  assert.equal(payload.messages[0].content.at(-1).cache_control.type, "ephemeral");
  assert.equal(payload.messages[2].content.at(-1).cache_control.type, "ephemeral");
  // run-state 是**每轮新建**的块：标在它上面等于每轮按 1.25x 写一段永远没人读的前缀。
  const runState = payload.messages.at(-1);
  assert.match(JSON.stringify(runState.content), /run state/u, "前提：run-state 块确实追加在尾部");
  assert.equal(runState.content.some((block) => block.cache_control !== undefined), false,
    "run-state 块不许带 cache_control（否则缓存写全是浪费）");
  // 4 个断点是协议上限，默认形态必须留有余量。
  assert.ok(breakpointBlocks(payload).length <= 4);
});

test("#192 T2：cacheStablePrefix:false ⇒ 一个 cache_control 都不许有", async () => {
  const { provider, bodies } = createWire();
  const ctx = makeContext({ provider, messages: conversation(), cacheStablePrefix: false });

  await callProvider(ctx, { round: 1, requestStateBlock: "[run state]" });

  assert.equal(breakpointBlocks(bodies[0]).length, 0);
});

test("#192 T1b：续接块（#568）被挪到尾部时，尾部断点落在它**之前**那条持久消息上", async () => {
  const { provider, bodies } = createWire();
  const continuity = {
    role: "user",
    content: [{ type: "text", text: `${CONTINUITY_BLOCK_START}\n## contract\n- goal: x\n[/session continuity]` }],
  };
  const messages = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    continuity,
  ];
  const ctx = makeContext({ provider, messages });

  await callProvider(ctx, { round: 2 });

  const [payload] = bodies;
  // 续接块每轮都被挪到尾部 ⇒ 以它结尾的前缀下一轮不会出现在同一位置，不许当断点。
  assert.equal(payload.messages.at(-1).content.some((block) => block.cache_control !== undefined), false,
    "续接块不许带 cache_control");
  assert.equal(payload.messages.at(-2).content.at(-1).cache_control.type, "ephemeral",
    "断点必须落在续接块之前的那条持久消息上");
  assert.equal(breakpointBlocks(payload).length, 3);
});

// ================================================================ ② 滚动性

test("#192 T3：第 N 轮的尾部断点，在第 N+1 轮里逐字仍在同一位置（内容前缀不变）", async () => {
  const { provider, bodies } = createWire();
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done" }] },
  ];
  const ctx = makeContext({ provider, messages });

  await callProvider(ctx, { round: 1, requestStateBlock: "[run state] round=1" });
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "echo", input: {} }] });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "done2" }] });
  await callProvider(ctx, { round: 2, requestStateBlock: "[run state] round=2" });

  const [first, second] = bodies;
  // 前提：两轮里持久历史的条数分别是 3 / 5（run-state 各追加 1 条在最后）。
  assert.equal(first.messages.length, 4);
  assert.equal(second.messages.length, 6);
  // 第 1 轮被打标的是 messages[2]（持久历史尾巴）；第 2 轮同一位置的**内容**逐字相同，
  // 只是标记前移到了 messages[4]。内容相同 = 上游前缀匹配的前提成立。
  assert.equal(first.messages[2].content.at(-1).cache_control.type, "ephemeral");
  assert.equal(second.messages[2].content.some((block) => block.cache_control !== undefined), false);
  assert.equal(second.messages[4].content.at(-1).cache_control.type, "ephemeral");
  const strip = (blocks) => blocks.map((block) => {
    const { cache_control: _cacheControl, ...rest } = block;
    return rest;
  });
  assert.deepEqual(strip(second.messages[2].content), strip(first.messages[2].content));
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(strip(second.messages[index].content), strip(first.messages[index].content),
      `第 ${index + 1} 条持久消息的内容必须逐字不变（否则尾部断点永远命中不了）`);
  }
});

test("#192 T4：TTL 折叠改写中段 ⇒ 尾部断点的前缀**确实**失配（这是已知代价，不是漏做）", async () => {
  const big = "x".repeat(5000);
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "readFile", input: { path: "a" } }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: big, erix: { round: 1, success: true } }],
    },
  ];
  const fold = { ttl: 2, minTokens: 10 };
  const { provider, bodies } = createWire();
  const ctx = makeContext({ provider, messages, toolResultFold: fold });

  // age=1（预警轮）：原文 + 一行预警，仍是原文。
  await callProvider(ctx, { round: 2, requestStateBlock: "[run state] round=2" });
  // age=2（TTL 到）：换成导航摘要。
  await callProvider(ctx, { round: 3, requestStateBlock: "[run state] round=3" });

  const [warned, folded] = bodies;
  const warnedText = warned.messages[2].content[0].content;
  const foldedText = folded.messages[2].content[0].content;
  assert.ok(warnedText.startsWith(big), "前提：预警轮仍是原文（只追加一行预警）");
  assert.notEqual(foldedText, warnedText, "TTL 到点必须换成摘要");
  assert.ok(foldedText.length < 1000, "折叠后必须显著变小");
  // 两轮的尾部断点都落在同一条消息上，但这条消息的**字节**变了 ⇒ 上游在第 2 轮的尾部
  // 断点前缀上匹配不到第 1 轮那份缓存，只能退回 system / 首条 user 两个静态断点。
  assert.equal(warned.messages[2].content.at(-1).cache_control.type, "ephemeral");
  assert.equal(folded.messages[2].content.at(-1).cache_control.type, "ephemeral");
});

// ================================================================ ③ usage 对账（模拟上游）
//
// 一个**按 Anthropic 文档语义**实现的本地模拟上游：断点 = 缓存写入点，命中 = 最长已缓存前缀。
// 它唯一的输入是 payload（和真上游一样），所以能证明「形状 → 缓存 → usage」这条链是通的；
// 但它算出来的数字**不是**真上游命中率（见文件头）。

function stripMarkers(block) {
  const { cache_control: _cacheControl, ...rest } = block;
  return rest;
}

function linearBlocks(payload) {
  const blocks = [];
  if (Array.isArray(payload.system)) blocks.push(...payload.system);
  else if (typeof payload.system === "string") blocks.push({ type: "text", text: payload.system });
  for (const message of payload.messages) blocks.push(...message.content);
  return blocks;
}

function simulateAnthropicCache() {
  const entries = [];   // { serialized, tokens }
  const serialize = (blocks) => blocks.map((block) => JSON.stringify(stripMarkers(block))).join("\n");
  return (payload) => {
    const blocks = linearBlocks(payload);
    const total = estimateTokens(serialize(blocks));
    let hit;
    for (const entry of entries) {
      if (serialize(blocks).startsWith(entry.serialized) && (hit === undefined || entry.tokens > hit.tokens)) {
        hit = entry;
      }
    }
    const cacheRead = hit?.tokens ?? 0;
    // 最后一个断点之前的全部内容按写入计（写入价 1.25x，读价 0.1x —— 这里只对账 token 数，不算钱）。
    let lastBreakpoint = -1;
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].cache_control !== undefined) lastBreakpoint = index;
    }
    const writeTokens = lastBreakpoint < 0 ? 0 : estimateTokens(serialize(blocks.slice(0, lastBreakpoint + 1)));
    const cacheWrite = Math.max(0, writeTokens - cacheRead);
    if (lastBreakpoint >= 0) {
      const serialized = serialize(blocks.slice(0, lastBreakpoint + 1));
      if (!entries.some((entry) => entry.serialized === serialized)) {
        entries.push({ serialized, tokens: writeTokens });
      }
    }
    return {
      input_tokens: Math.max(0, total - writeTokens),
      output_tokens: 2,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    };
  };
}

/** 同一轮请求的「改前」payload：只有 system + 首条 user 两个静态断点（#192 之前的形状）。 */
function staticOnlyPayload(messages) {
  const marked = markStablePrefix("stable system", messages);
  return canonicalToAnthropicRequest({
    model: MODEL,
    system: marked.system,
    messages: marked.messages,
    maxTokens: 256,
  });
}

function growingHistory() {
  const filler = "缓存经济学：前缀复用只覆盖重复前缀。".repeat(20);
  return [
    { role: "user", content: [{ type: "text", text: `任务：${filler}` }] },
    { role: "assistant", content: [{ type: "text", text: "第一轮回复" }] },
    { role: "user", content: [{ type: "text", text: `追加约束：${filler}` }] },
    { role: "assistant", content: [{ type: "text", text: "第二轮回复" }] },
    { role: "user", content: [{ type: "text", text: "继续" }] },
  ];
}

test("#192 T5（模拟上游）：尾部断点让第 2 轮起读到整段历史前缀；改前只读到首条 user 前缀", async () => {
  const upstream = simulateAnthropicCache();
  const { provider, bodies } = createWire();
  // fetchImpl 在 createWire 里回固定 usage；这里换成「按 payload 算」的那一份。
  provider.chat = createAnthropicProvider({
    endpoint: "http://127.0.0.1:1",
    apiKey: "scripted-key",
    model: MODEL,
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      bodies.push(payload);
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: upstream(payload),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  }).chat;

  const ROUNDS = 4;
  const history = growingHistory();
  const after = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const ctx = makeContext({ provider, messages: history.slice(0, 2 * round - 1) });
    const { response } = await callProvider(ctx, { round, requestStateBlock: `[run state] round=${round}` });
    after.push(response.usage);
  }

  // 改前：同样几条请求，但 payload 只有两个静态断点。用同一份模拟上游（同一个缓存），
  // 所以「读到的前缀」差异只来自 payload 形状。
  const beforeUpstream = simulateAnthropicCache();
  const before = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const payload = staticOnlyPayload(history.slice(0, 2 * round - 1));
    before.push(beforeUpstream(payload));
  }

  // 第 1 轮谁都读不到（缓存是空的）。第 2 轮两边的「最长已缓存前缀」都只到首条 user
  // （尾部断点在第 1 轮写的就是那条 user）——差异从第 3 轮开始：上一轮的**整段历史**被写下了。
  assert.equal(after[0].cacheRead, 0);
  assert.equal(before[0].cache_read_input_tokens, 0);
  assert.equal(after[1].cacheRead, before[1].cache_read_input_tokens,
    "第 2 轮两边都只能读到首条 user 前缀（尾部断点在第 1 轮写的就是它）");
  for (const round of [2, 3]) {
    assert.ok(after[round].cacheRead > before[round].cache_read_input_tokens,
      `第 ${round + 1} 轮：尾部断点读到的前缀必须比「只有首条 user 断点」多`
      + `（实测 ${after[round].cacheRead} vs ${before[round].cache_read_input_tokens}）`);
  }
  assert.ok(after[2].cacheRead > after[1].cacheRead, "历史在长，命中前缀必须跟着长（滚动）");
  assert.ok(after[3].cacheRead > after[2].cacheRead, "滚动命中必须继续增长");
  // 写入量对账：尾部断点把「新增的那一段」按写入计，而不是每轮把整段历史重写。
  assert.ok(after[1].cacheWrite > 0, "新增段必须被写入（否则下一轮读不到）");
  assert.ok(after[3].cacheWrite < after[3].cacheRead,
    `稳定态下「写入」必须小于「读到的」（实测写 ${after[3].cacheWrite} / 读 ${after[3].cacheRead}）`);
});
