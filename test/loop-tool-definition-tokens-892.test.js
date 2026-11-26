// issue #892 —— 工具定义 token 从没被算进估算。本测试钉死「一次算、预算与折叠判据共用同一个数」，
// 以及默认（无工具）逐字不变、反向置 0 必红。
//
// 判据（对应任务表的 4 格）：
//   ① 给了工具 ⇒ toolDefinitionTokens > 0，且等于「工具定义序列化后按 estimateTokens 算出的值」；
//   ② 同一 run 里预算与折叠判据用的是同一个数（捕获 strategy.shouldCompact 收到的 budgetTokens）；
//   ③ 默认 0 ⇒ 逐字不变：不传工具时预算与不传 toolDefinitionTokens 的 computeBudget 字节一致；
//   ④ 反向：工具仍给着，但断言「预算比无工具时少掉恰好一个 toolDefinitionTokens」——若这个数没被
//      消费（人为等价于置 0），差额会是 0 ⇒ 本断言当场变红。
//
// 零真实 LLM：fake provider + 内置内存 store（AGENTS.md 测试隔离规则）。
import assert from "node:assert/strict";
import test from "node:test";

import { computeBudget } from "../src/compact/budget.js";
import { createSlidingWindowStrategy } from "../src/compact/sliding-window.js";
import { canonicalToolsToOpenAI } from "../src/messages/canonical.js";
import { estimateToolDefinitionTokens, estimateTokens } from "../src/tokens.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { runDirect } from "./helpers/run-direct.js";

const CONTEXT_WINDOW = 200_000;
const MAX_OUTPUT = 4_096;

// 一组真实形状的工具定义（name / description / inputSchema）。
const TOOLS = [
  {
    name: "readFile",
    description: "Read a text file by line range; supports offset/limit and a max_bytes cap.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read." },
        offset: { type: "number", description: "0-based first line index." },
        limit: { type: "number", description: "Number of lines to return." },
      },
      required: ["path"],
    },
  },
  {
    name: "searchText",
    description: "Search text files for a pattern with an explicit match mode (literal or regex).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        mode: { enum: ["literal", "regex"] },
        path: { type: "string" },
      },
      required: ["pattern", "mode"],
    },
  },
  {
    name: "edit",
    description: "Apply exact-match text replacements to one file; oldText must match byte for byte.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { oldText: { type: "string" }, newText: { type: "string" } },
          },
        },
      },
      required: ["path", "edits"],
    },
  },
];

// 无副作用 fake provider：每轮都回一小段文本直接收尾，把预算撑不满，折叠不会真的触发；
// 但折叠判据（strategy.shouldCompact）每轮折叠检查点都会被调用，足以捕获 budgetTokens。
function makeQuietProvider() {
  let turns = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      turns += 1;
      return { content: [{ type: "text", text: `turn ${turns}` }], stopReason: "end_turn" };
    },
  };
  provider.chatStream = provider.chat;
  return provider;
}

// 用一层记录代理包住真实策略：把折叠判据收到的 budgetTokens 记下来，再原样委托（不改行为）。
function recordingStrategy(captured) {
  const inner = createSlidingWindowStrategy({ keepRounds: 1 });
  return {
    id: inner.id,
    async shouldCompact(messages, budgetTokens) {
      if (captured.value === undefined) captured.value = budgetTokens;
      // 直接返回 false：保持 run 干净、无折叠副作用；捕获的 budgetTokens 与折叠判据同源。
      return false;
    },
    async compact(messages, options) {
      return inner.compact(messages, options);
    },
  };
}

async function runCapturingBudget({ tools }) {
  const captured = {};
  const runId = `s-892-${tools.length}-tool-def-tokens`;
  const store = createMemoryTranscriptStore();
  await runDirect({
    provider: makeQuietProvider(),
    runId,
    store,
    initialUserMessage: "开始任务",
    tools,
    executeTool: async () => "ok",
    maxRounds: 3,
    completion: false,
    wrapup: false,
    stallDetection: false,
    capabilities: { ports: { strategy: recordingStrategy(captured) } },
    // 派生预算：预算元数据住 `config.metadata.modelMetadata`；folding.context 里**不设**
    // budgetTokens（设了就是显式预算，本单不动它），于是走「派生」这一支。
    config: {
      metadata: { modelMetadata: { contextWindowTokens: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT } },
      folding: { context: { keepRounds: 1 } },
    },
  });
  return captured.value;
}

// —— 格 ①：估算口径 = 序列化后按 estimateTokens 算出的值，且 > 0。
test("#892 ① toolDefinitionTokens>0 且等于「序列化后 estimateTokens」", () => {
  const tdt = estimateToolDefinitionTokens(TOOLS);
  const manual = estimateTokens(JSON.stringify(canonicalToolsToOpenAI(TOOLS)));
  assert.ok(Number.isSafeInteger(tdt) && tdt > 0, `toolDefinitionTokens 必须是正整数，实测 ${tdt}`);
  assert.equal(tdt, manual, "估算必须等于「工具定义序列化后按 estimateTokens 算出的值」");
  // 工具越多 ⇒ 估算越大（issue 机器判据 #2：第二组增量应≈新工具定义估算，不是 0）。
  const more = [...TOOLS,
    { name: "extra1", description: "A tool that does a first extra thing.", inputSchema: { type: "object" } },
    { name: "extra2", description: "A tool that does a second extra thing.", inputSchema: { type: "object" } },
  ];
  assert.ok(estimateToolDefinitionTokens(more) > tdt, "增加工具后定义估算必须变大（不是恒等）");
});

// —— 格 ③：默认 0 ⇒ 逐字不变。
test("#892 ③ 无工具 ⇒ 估算=0，且 computeBudget 逐字不变 / run 预算=未扣值", async () => {
  assert.equal(estimateToolDefinitionTokens([]), 0, "空工具集 ⇒ 0");
  assert.equal(estimateToolDefinitionTokens(undefined), 0, "无工具入参 ⇒ 0");
  // computeBudget 默认（不传 toolDefinitionTokens）与显式传 0 逐字相等。
  assert.equal(
    computeBudget({ contextWindowTokens: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT }),
    computeBudget({ contextWindowTokens: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT, toolDefinitionTokens: 0 }),
    "toolDefinitionTokens=0 必须逐字等于不传",
  );
  // 端到端：不给工具时，折叠判据收到的预算 = 未扣工具的派生预算（与改动前一致）。
  const captured = await runCapturingBudget({ tools: [] });
  assert.equal(
    captured,
    computeBudget({ contextWindowTokens: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT }),
    "无工具时预算必须等于未扣工具的派生预算（逐字不变）",
  );
});

// —— 格 ② + ④：同一 run 里预算与折叠判据共用同一个「已扣工具」的数；反向差额必为 toolDefinitionTokens。
test("#892 ②③④ 折叠判据收到的预算 = computeBudget(含工具) = 未扣值 - toolDefinitionTokens", async () => {
  const tdt = estimateToolDefinitionTokens(TOOLS);
  const fullBudget = computeBudget({ contextWindowTokens: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT });
  const reducedBudget = computeBudget({
    contextWindowTokens: CONTEXT_WINDOW,
    maxOutputTokens: MAX_OUTPUT,
    toolDefinitionTokens: tdt,
  });

  const captured = await runCapturingBudget({ tools: TOOLS });
  assert.ok(captured !== undefined, "折叠判据必须被调用并收到 budgetTokens");
  // 格 ②：预算与折叠判据用的是同一个数 —— 就是「已扣工具」的那一个，不是一处算、另一处仍是未扣值。
  assert.equal(captured, reducedBudget, "折叠判据收到的预算必须等于 computeBudget(含 toolDefinitionTokens)");
  // 格 ③ 的反面确认：这个数确实小于未扣值（不是逐字不变那格）。
  assert.ok(captured < fullBudget, `已扣预算必须小于未扣预算：captured=${captured} full=${fullBudget}`);
  // 格 ④（反向必红）：差额恰好等于 toolDefinitionTokens。若这个数没被消费（等价于人为置 0），
  // 差额会是 0 ⇒ 断言当场变红，证明它真的进了预算与折叠判据。
  assert.equal(
    fullBudget - captured,
    tdt,
    "预算必须比无工具时少掉恰好一个 toolDefinitionTokens（反向证：置 0 则此处变红）",
  );
});
