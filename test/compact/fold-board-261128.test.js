// @ts-check
// 白板（runs.board）第一刀：折叠时一次调用产出的第三件——「新白板全文」。
// 形状稿 §3.7 / §3.8。判据（8 格，全内存，零真实 LLM）：
//   1. 提示词：出现 `白板：` 行，且写清「整块替换」「≤1500 token」「没东西可写就留空」三条；
//   2. 解析：给了 ⇒ foldSummary.board 逐字等于模型那块；没给 ⇒ boardMissing:"no-line" 且不失败；
//   3. 超限拒收：>1500 token ⇒ 旧板不变 + boardRejected:"over-limit" + 一条 board_rejected 事件；
//   4. 空板拒收：旧板非空 + 模型给空板 ⇒ 旧板不变 + boardRejected:"empty-over-nonempty"；
//   5. 显式清空可行：模型给「（空）」⇒ 允许清空（板变空）；
//   6. 白板进请求：跑一轮，provider 收到的请求里含白板全文；
//   7. 白板不进 foldSummary.text（两者是不同东西）；
//   8. 白板持久化后 resume 能读回（deterministic.board 往返）。

import assert from "node:assert/strict";
import test from "node:test";

import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import {
  RUN_STATE_BOARD_MAX_TOKENS,
  applyBoardUpdate,
  createDeterministicRunState,
  renderRunState,
  validateRunState,
} from "../../src/run-state.js";
import { estimateTokens } from "../../src/tokens.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";

// —— 策略级零件 ——————————————————————————————————————————————
const BOARD_MARK = "白板唯一标记ZQ7";
// ≈ 870 CJK 才是 1500 token（每汉字 ~1.725 token）；取 900 稳过上限。
const OVER_LIMIT_BOARD = "约".repeat(900);
const OK_BOARD = "## 约束\n只改 src 不碰 scripts";

function conversation() {
  return [
    { role: "user", content: "initial request" },
    { role: "assistant", content: [{ type: "text", text: "phase one" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [{ type: "text", text: "phase two" }] },
    { role: "user", content: [{ type: "text", text: "continue again" }] },
    { role: "assistant", content: [{ type: "text", text: "phase three" }] },
  ];
}

/** 造一份带新提示词四节的摘要；boardLine = `白板：` 前缀后的整块文本（null ⇒ 不给这行）。 */
function summaryWithBoard(boardLine, { mark = BOARD_MARK } = {}) {
  const meta = `标题：一个短标题\n描述：一句自解释描述\n${boardLine === null ? "" : `白板：${boardLine}\n`}`;
  return `${meta}## 行动
做了 ${mark} 相关的事。
## 遗留
无
## 关键词
${mark}
## 教训与坑
无`;
}

/** 跑一折（fold-llm），返回 foldSummary。prevBoard 走 callOptions.board（引擎的接线口径）。 */
async function foldOnce(summaryText, prevBoard) {
  const strategy = createFoldLlmStrategy({ summarizer: async () => summaryText });
  const result = await strategy.compact(conversation(), { keepRounds: 1, board: prevBoard ?? "" });
  assert.ok(result.foldSummary, "前置：这一折必须真折了（否则判据是空断言）");
  return result.foldSummary;
}

// —— 判据 1：提示词 ——————————————————————————————————————————
test("判据1 提示词有 `白板：` 行且写清三条", async () => {
  const { SUMMARIZER_PROMPT_GUIDE } = await import("../../src/compact/fold-llm.js");
  assert.match(SUMMARIZER_PROMPT_GUIDE, /白板：/, "提示词必须有 `白板：` 这一行");
  assert.match(SUMMARIZER_PROMPT_GUIDE, /整块替换/, "必须写清「整块替换」");
  assert.match(SUMMARIZER_PROMPT_GUIDE, /≤1500 token/, "必须写清「≤1500 token」");
  assert.match(SUMMARIZER_PROMPT_GUIDE, /没东西可写就留空/, "必须写清「没东西可写就留空」");
});

// —— 判据 2：解析 ————————————————————————————————————————————
test("判据2 给了白板 ⇒ foldSummary.board 逐字等于模型那块；没给 ⇒ boardMissing:no-line 且不失败", async () => {
  const given = await foldOnce(summaryWithBoard(`${BOARD_MARK}\n## 当前阶段\n第一刀`));
  assert.equal(given.board, `${BOARD_MARK}\n## 当前阶段\n第一刀`,
    `board 必须逐字等于模型给的那块，实测 ${JSON.stringify(given.board)}`);
  assert.equal(Object.hasOwn(given, "boardMissing"), false, "拿到了白板 ⇒ 不得出现 boardMissing");
  assert.equal(Object.hasOwn(given, "boardRejected"), false, "正常拿到白板 ⇒ 不得出现 boardRejected");

  const none = await foldOnce(summaryWithBoard(null));
  assert.equal(none.boardMissing, "no-line", "没给白板 ⇒ boardMissing 必须是 no-line");
  assert.equal(Object.hasOwn(none, "board"), false, "没给白板 ⇒ 不写 board");
  // 「没给」不失败：这一折仍然成功产出摘要与 foldSummary。
  assert.equal(typeof none.text, "string");
  assert.ok(none.text.length > 0, "没给白板不能失败，正文仍在");
});

// —— 判据 3：超限拒收（策略报 reason；持久化层保旧板 + 记事件）————————————————
test("判据3 超限拒收：boardRejected:over-limit，持久化保留旧板并记一条 board_rejected 事件", async () => {
  // (a) 策略级：>1500 token ⇒ 只报 over-limit，不交回新板。
  assert.ok(estimateTokens(OVER_LIMIT_BOARD) > RUN_STATE_BOARD_MAX_TOKENS,
    "前置：这条板必须真的超 1500 token");
  const rejected = await foldOnce(summaryWithBoard(OVER_LIMIT_BOARD), "旧板内容");
  assert.equal(rejected.boardRejected, "over-limit");
  assert.equal(Object.hasOwn(rejected, "board"), false, "超限 ⇒ 不交回新板");

  // (b) 持久化层（权威闸）：旧板非空 + 超限 ⇒ 旧板不变 + event。
  const state = { deterministic: { board: "旧板内容" } };
  const upd = applyBoardUpdate(state, { boardRejected: rejected.boardRejected });
  assert.equal(upd.board, "旧板内容", "拒收 ⇒ 旧板不变（不是静默截断）");
  assert.equal(upd.rejected, "over-limit");
  assert.equal(upd.event?.type, "board_rejected");
  assert.equal(upd.event?.detail, "over-limit", "事件理由进 detail");

  // (c) 直接给 createDeterministicRunState 一份超限板 ⇒ 防御性不落（宁当没板，不静默塞）。
  const over = createDeterministicRunState({ runId: "r", board: OVER_LIMIT_BOARD });
  assert.equal(over.deterministic.board, undefined, "超限板不进 deterministic.board");
});

// —— 判据 4：空板拒收 —————————————————————————————————————————
test("判据4 空板拒收：旧板非空 + 模型给空板 ⇒ boardRejected:empty-over-nonempty，旧板不变", async () => {
  const rej = await foldOnce(summaryWithBoard(""), "旧板内容");
  assert.equal(rej.boardRejected, "empty-over-nonempty");
  assert.equal(Object.hasOwn(rej, "board"), false, "空板拒收 ⇒ 不交回新板");

  const upd = applyBoardUpdate({ deterministic: { board: "旧板内容" } },
    { boardRejected: rej.boardRejected });
  assert.equal(upd.board, "旧板内容", "旧板非空时一次解析失误不能抹掉全部现状");
  assert.equal(upd.event?.detail, "empty-over-nonempty");
});

// —— 判据 5：显式清空可行 ————————————————————————————————————
// 选的标记：整块只写一行「（空）」——它是「白板：」前缀后的唯一非空内容，模型明确表达「要清空」，
// 与「整行留空」（= 没东西可写、保留旧板）语义不同；引擎把它解析成空串，允许覆盖非空旧板。
test("判据5 显式清空可行：模型给「（空）」⇒ 允许把非空旧板清成空", async () => {
  const cleared = await foldOnce(summaryWithBoard("（空）"), "旧板内容");
  assert.equal(cleared.board, "", "显式清空 ⇒ board 是空串（不是 missing、不是 rejected）");
  assert.equal(Object.hasOwn(cleared, "boardMissing"), false);
  assert.equal(Object.hasOwn(cleared, "boardRejected"), false);

  // 持久化层：显式清空的空串即便旧板非空也放行。
  const upd = applyBoardUpdate({ deterministic: { board: "旧板内容" } }, { board: "" });
  assert.equal(upd.board, "", "显式清空 ⇒ 落空板，不拒收");
  assert.equal(upd.rejected, undefined);
});

// —— 判据 7：白板不进 foldSummary.text ——————————————————————
test("判据7 白板不进 foldSummary.text（两者是不同东西）", async () => {
  const boardBlock = `## 约束\n${BOARD_MARK} 只在白板上`;
  const fs = await foldOnce(summaryWithBoard(boardBlock, { mark: "正文独有词QQ9" }));
  assert.equal(fs.board, boardBlock);
  assert.ok(!fs.text.includes(BOARD_MARK),
    `foldSummary.text 不得含白板内容，实测含了：${JSON.stringify(fs.text)}`);
  assert.ok(!fs.text.includes("白板："), "正文里不得残留白板前缀");
});

// —— 判据 8：持久化往返 ——————————————————————————————————————
test("判据8 deterministic.board 往返：写进去、过 JSON、validateRunState 仍能读回", async () => {
  const state = createDeterministicRunState({ runId: "board-rt", board: OK_BOARD });
  assert.equal(state.deterministic.board, OK_BOARD);
  const revived = JSON.parse(JSON.stringify(state));
  assert.equal(revived.deterministic.board, OK_BOARD, "序列化往返必须保住白板");
  const validated = validateRunState(revived);
  assert.equal(validated.ok, true);
  // 渲染进上下文（供注入路径断言用）。
  assert.ok(renderRunState(revived).includes(OK_BOARD), "renderRunState 必须把白板整块渲染进去");
});

// —— 判据 6：白板进 provider 请求（e2e，跑一轮）———————————————
const SUMMARY_ANCHOR = "整理成可继续工作的日志";
const E2E_BOARD = "当前阶段：注入验证RUN6";

function makeProvider(summarizeReply, { toolTurns = 8, seen } = {}) {
  let turns = 0;
  const chat = async (request) => {
    const haystack = JSON.stringify(request?.messages ?? "");
    if (seen) seen.push(haystack);
    if (haystack.includes(SUMMARY_ANCHOR)) {
      return { content: [{ type: "text", text: summarizeReply }], stopReason: "end_turn" };
    }
    if (turns < toolTurns) {
      turns += 1;
      return {
        content: [{ type: "tool_use", id: `tu_${turns}`, name: "exec", input: { command: `echo ${turns}` } }],
        stopReason: "tool_use",
      };
    }
    return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" };
  };
  const provider = { protocol: "fake", model: "fake-model", chat };
  provider.chatStream = (request) => chat(request);
  return provider;
}

test("判据6 跑一轮：折叠后 provider 收到的请求里含白板全文", async () => {
  const store = createMemoryTranscriptStore();
  /** @type {string[]} */
  const seen = [];
  await runDirect({
    provider: makeProvider(summaryWithBoard(E2E_BOARD), { seen, toolTurns: 14 }),
    executeTool: async () => `tool output ${"z".repeat(400)}`,
    maxRounds: 20,
    completion: false,
    reflection: false,
    config: { folding: { context: { budgetTokens: 1300, keepRounds: 0 } } },
    store,
    runId: "board-e2e-6",
    seed: `start ${"y".repeat(600)}`,
  });
  const injected = seen.filter((h) => h.includes(SUMMARY_ANCHOR) === false);
  assert.ok(seen.length > 1, "前置：必须跑了多轮（否则无从判断折叠后是否注入）");
  assert.ok(injected.some((h) => h.includes(E2E_BOARD)),
    "折叠后某条 provider 请求必须含白板全文");
});
