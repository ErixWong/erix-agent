// 单轮聚合输出预算（issue #32 #2 / 上下文记忆改进方案 A1「增量准入版」）。
//
// 背景：`outputHygiene.limit` 是**逐条**上限。一轮里 10 个工具各返回 4000 字符即可一次注入
// 4 万字符（≈1.5–2 万 token），这一轮已经付出一次超长请求的代价。本模块在逐条判定之外补一层
// 「本轮所有工具结果合计」预算。
//
// 口径（统一在此声明，调用方不得另起第二套）：
// - 预算基准：引擎既有的可用输入预算 `budgetTokens`（`computeBudget()` 结果或宿主
//   `context.budgetTokens`）——**不引入 contextWindowTokens 第二套口径**。
// - 聚合预算 = `clamp(0.30 × budgetTokens, 16000, 200000)`，单位是**估算 token**
//   （`estimateTokens()` 的保守混合语言口径，含 1.15 安全系数），不是字节、不是字符。
// - 计入内容：本轮内联 tool_result 的**最终文本**（onToolResult 改写 → 逐条 outputHygiene
//   之后的内容），外加每条结果的 framing 开销（`AGGREGATE_FRAMING_TOKENS`，tool_result 块
//   壳与 tool_use_id 的封装成本）。被替换为 stub 的结果计入的是 **stub 文本**本身
//   （stub 开销计入），不是被归档的原文。
// - 不计入：intercept 控制性结果（`executionStatus === "intercepted"`，原调用从未执行）；
//   失败结果（is_error）**计入**预算，但其 stub 必须保留 is_error 与关键错误片段。
// - `budgetTokens` 不存在（宿主未提供窗口配置）时聚合层整体关闭，行为与改动前完全一致。
//
// 终止态：判定是**到达顺序的增量准入**（不重排、不批末回写，因此 checkpoint/resume 语义不变）。
// 因此不做同轮去重、不做按大小重排；已经在档（逐条或聚合归档）的结果不再被二次替换——
// 极端情况（一轮全部结果是 stub 仍超预算）有明确终止态：全部 stub 化即停，并发出可见事件，
// 绝不反复替换。

import { estimateTokens } from "../tokens.js";

/** 聚合预算占可用输入预算的比例。 */
export const AGGREGATE_BUDGET_RATIO = 0.30;
/** 聚合预算夹取下限（估算 token）。 */
export const AGGREGATE_BUDGET_MIN_TOKENS = 16000;
/** 聚合预算夹取上限（估算 token）。 */
export const AGGREGATE_BUDGET_MAX_TOKENS = 200000;
/** 每条 tool_result 的 framing 开销（块壳 + tool_use_id），计入聚合预算。 */
export const AGGREGATE_FRAMING_TOKENS = 8;
/** 失败结果被 stub 化时保留的关键错误片段上限（字符）。 */
export const AGGREGATE_ERROR_SNIPPET_CHARS = 200;

const UNRECOVERABLE_REASONS = Object.freeze({
  invalid_content: "输出内容不是可归档的文本",
});

/**
 * 压平并截断错误文本，作为 stub 里的「关键错误片段」（judge / timeline 依赖 is_error 与错误串）。
 *
 * @param {unknown} content
 * @param {number} limit
 * @returns {string}
 */
export function errorSnippet(content, limit = AGGREGATE_ERROR_SNIPPET_CHARS) {
  const text = String(content ?? "").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/**
 * 计算单轮聚合预算（估算 token）。
 *
 * @param {number|undefined} budgetTokens 引擎既有可用输入预算（computeBudget 结果）
 * @returns {number|undefined} undefined 表示聚合层关闭（无预算基准）
 */
export function computeAggregateBudgetTokens(budgetTokens) {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) return undefined;
  const raw = Math.floor(budgetTokens * AGGREGATE_BUDGET_RATIO);
  return Math.min(
    AGGREGATE_BUDGET_MAX_TOKENS,
    Math.max(AGGREGATE_BUDGET_MIN_TOKENS, raw),
  );
}

/**
 * 单条结果的聚合内联成本（估算 token，含 framing 开销）。
 *
 * @param {unknown} content tool_result 的最终文本
 * @returns {number}
 */
export function estimateInlineCost(content) {
  return estimateTokens(typeof content === "string" ? content : String(content ?? ""))
    + AGGREGATE_FRAMING_TOKENS;
}

/**
 * 聚合归档 stub.
 *
 * 失败结果（is_error）额外保留关键错误片段。
 *
 * @param {{round:number, length:number, errorSnippet?:string}} options
 * @returns {string}
 */
export function aggregateStubText({ round, length, errorSnippet: snippet }) {
  const failed = typeof snippet === "string" && snippet.length > 0
    ? `失败摘要：${snippet}；`
    : "";
  return `[本轮工具输出已超单轮聚合预算：完整输出已由引擎归档（第 ${round} 轮，共 ${length} 字符）。${failed}`
    + "后续需要该值：先用 note_list 查找记录，再用 note_read 读取；"
    + "若未记录且无法确定性重算，请省略对应 findings 声明，不要猜测；"
    + "若原命令有副作用，不要仅凭截断输出判断成败，也不要为补全输出重跑有副作用的命令；"
    + "改用只读方式复核。]";
}

/**
 * 聚合归档 fail-closed stub：**不得**声称原文可恢复。
 *
 * @param {{round:number, length:number, reason:string, errorSnippet?:string}} options
 * @returns {string}
 */
export function aggregateUnrecoverableStubText({ round, length, reason, errorSnippet: snippet }) {
  const detail = UNRECOVERABLE_REASONS[reason] ?? "归档失败";
  const failed = typeof snippet === "string" && snippet.length > 0
    ? `失败摘要：${snippet}；`
    : "";
  return `[本轮工具输出已超单轮聚合预算，且本条完整输出无法归档（原文不可恢复，第 ${round} 轮，`
    + `共 ${length} 字符）：${detail}。${failed}不要重跑有副作用的命令；需要该结果请改用只读方式复核。]`;
}

/**
 * 单轮聚合准入闸门（到达顺序增量准入）。
 *
 * 状态尽量**从既有结构派生**（归档条目 + 本轮既有 tool_result），不引入需要跨 resume 恢复的
 * 计数器：崩溃重跑时，已执行结果已随 checkpoint 落盘（含 stub），派生量与正常路径一致。
 *
 * @param {{
 *   budgetTokens?: number,
 *   archivedOutputs?: object[],      // 既有归档通道（round record 的 toolOutputs 来源）
 *   listRoundResults?: () => object[] // 本轮已落定的 tool_result（声明顺序）
 * }} options
 */
export function createRoundAggregateGate({
  budgetTokens,
  archivedOutputs = [],
  listRoundResults = () => [],
} = {}) {
  const budget = computeAggregateBudgetTokens(budgetTokens);
  // 本进程内被 fail-closed stub 化的 toolUseId（终止态判定用；resume 后重置只影响诊断计数）
  const unrecoverableIds = new Set();

  const evaluate = ({ round, toolUseId, content }) => {
    const text = typeof content === "string" ? content : String(content ?? "");
    const cost = estimateInlineCost(text);
    const entries = archivedOutputs.filter((entry) => entry.round === round);
    const archivedIds = new Set(entries.map((entry) => entry.toolUseId));
    const archivedBytes = entries.reduce(
      (total, entry) => total + utf8Bytes(entry.content),
      0,
    );
    const results = listRoundResults();
    // intercept 控制性结果不计入（原调用未执行，不是「输出」）
    const countedResults = results.filter(
      (result) => result?.executionStatus !== "intercepted",
    );
    const inlineTokens = countedResults
      .reduce((total, result) => total + estimateInlineCost(result?.content), 0);

    if (budget === undefined) {
      return {
        action: "inline",
        reason: "aggregate_disabled",
        budgetTokens: undefined,
        inlineTokens,
        costTokens: cost,
      };
    }

    const projectedTokens = inlineTokens + cost;
    const base = { budgetTokens: budget, inlineTokens, costTokens: cost, projectedTokens };
    const alreadyStubbed = archivedIds.has(toolUseId)
      || unrecoverableIds.has(toolUseId);

    if (projectedTokens <= budget) {
      return {
        ...base,
        action: "inline",
        reason: alreadyStubbed ? "within_budget_after_stub" : "within_budget",
      };
    }
    if (alreadyStubbed) {
      // 已经超预算且结果已是 stub → 不可再替换。全部 stub 化即终止（不许反复替换）。
      const everyPreviousStubbed = results.every((result) => (
        result?.executionStatus === "intercepted"
        || archivedIds.has(result?.tool_use_id)
        || unrecoverableIds.has(result?.tool_use_id)
      ));
      return {
        ...base,
        action: "stub_kept",
        reason: "already_stubbed",
        terminal: everyPreviousStubbed,
      };
    }
    if (text.length === 0) {
      unrecoverableIds.add(toolUseId);
      return { ...base, action: "unrecoverable", reason: "invalid_content" };
    }
    return {
      ...base,
      action: "archive",
      reason: "aggregate_budget",
      archivedBytes,
      bytes: utf8Bytes(text),
    };
  };

  return {
    enabled: budget !== undefined,
    budgetTokens: budget,
    evaluate,
  };
}
