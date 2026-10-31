// @ts-check
// issue #177 刀4：judge **调用单元**（请求组装 → 超时/中止接线 → 响应 → 用量带出 → 判词解析）。
//
// 从 `src/loop/orchestrator.js` 同名 `callRoundJudge` 搬出的只是**实现**，不是语义：判词提示词、请求
// 载荷（`maxTokens: 1024` / `temperature: 0` / `reasoning_effort: "none"`）、超时错误码
// `judge_intercept_timeout`、用量记账口径（`trackLatest: false` + `account: "engine"`：judge 是引擎
// 自发起的调用 ⇒ 只进 engine 桶、不进模型轮账）与返回形状 `{decision, usage, raw}` 全部逐字未动。
//
// 两条不变量：
//   · **不反向 import orchestrator**：run 作用域的东西（`governorState` / `provider` /
//     `judgeProviderPort` / `taskBrief` / `signal` / `addUsage` / `awaitWithAbort`）与两个可变闭包
//     `messages` / `budgetRounds` 全部由调用方**每次调用**经 `deps` 显式传入——后两个必须在**调用点**
//     取值，创建时快照会读到旧值；
//   · **不是公共导出面**：不被 `src/index.js` 再导出，只被 orchestrator 内部 import。

import {
  buildJudgePrompt,
  parseJudgeDecision,
  renderConversation,
} from "../reflection/judge.js";
import { blocksFor, textFromBlocks } from "./messages.js";

/**
 * run 作用域依赖。全部在**调用点**读（`messages` / `budgetRounds` 是可变闭包）。
 * @param {{governorState: any, effectiveReflection: any, judgeProviderPort: any, provider: any,
 *   taskBrief: any, reflectionMaxExtensions: number, messages: any[], budgetRounds: number,
 *   signal: any, addUsage: any, awaitWithAbort: any}} deps
 * @param {number} round
 * @param {object} currentL0
 * @param {{timeoutMs?: number, conversationBudgetTokens?: number,
 *   roundFacts?: {roundDeliverable?: object, roundStopReason?: string}}} [options]
 * @returns {Promise<{decision: any, usage: any, raw: string}>}
 */
export async function callRoundJudge(deps, round, currentL0, {
  timeoutMs,
  conversationBudgetTokens,
  roundFacts,
} = {}) {
  const {
    governorState,
    effectiveReflection,
    judgeProviderPort,
    provider,
    taskBrief,
    reflectionMaxExtensions,
    messages,
    budgetRounds,
    signal,
    addUsage,
    awaitWithAbort,
  } = deps;
  const l0Facts = [...governorState.l0Facts, { round, ...currentL0 }];
  const recentErrors = l0Facts
    .flatMap((fact) => fact.errorTexts ?? (fact.errorText ? [fact.errorText] : []))
    .filter((text, index, values) => values.indexOf(text) === index)
    .slice(-5);
  const judge = effectiveReflection?.judge;
  // #498 S4c: port first, then the legacy nested slot, then the run's main provider. `evaluator`
  // (the old alias of `judge.provider`) is retired — the semantic phase throws on it.
  const evaluator = judgeProviderPort ?? judge?.provider ?? provider;
  const nearLimit = budgetRounds >= Math.floor(
    governorState.effectiveMaxRounds * 0.8,
  );
  const request = {
    system: "你是交付评审者，独立判断任务是否完成。只输出 JSON。",
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: buildJudgePrompt(
          taskBrief,
          budgetRounds,
          governorState.timeline,
          governorState.filesWritten,
          recentErrors,
          renderConversation(messages, {
            maxTokens: Number.isFinite(conversationBudgetTokens)
              ? conversationBudgetTokens
              : undefined,
          }),
          {
            budgetRounds,
            effectiveMaxRounds: governorState.effectiveMaxRounds,
            extensionCount: governorState.extensionCount,
            maxExtensions: reflectionMaxExtensions,
            nearLimit,
          },
          // issue #473：把「本轮这段文本是不是被声明为交付物」作为判据的**输入**交给评审。
          // 口径来自 `roundDeliverableFacts`（与渲染器同一个 `deliverableKindOfBlock`），
          // 本文件不重算、也不造第三套分类。
          roundFacts,
        ),
      }],
    }],
    // 2026-09-20 基准实测：judge 只输出一段 JSON，8000 上限纯浪费（输出越长漂移越大）；
    // 但 512 实测会被 glm 冗长 JSON 截断致 parse 失败 → 1024。
    maxTokens: 1024,
    temperature: 0,
    // judge 继续发送 reasoning_effort:"none"（统一语义=不思考）；OpenAI provider
    // 的 payload 层会将 GLM 系模型自动转译为 "low"（见
    // src/providers/payload.js 的 OpenAI 载荷组装出口），因为该 relay 把 GLM 的
    // "none" 处理成思考漏进 content。deepseek/qwen 在同一 relay 上语义正确，不受影响。
    reasoning_effort: "none",
  };
  let timeoutController;
  let timeoutId;
  let removeParentAbort;
  if (timeoutMs !== undefined) {
    timeoutController = new AbortController();
    request.signal = timeoutController.signal;
    if (signal !== undefined) {
      const onParentAbort = () => timeoutController.abort(signal.reason);
      if (signal.aborted) onParentAbort();
      else signal.addEventListener("abort", onParentAbort, { once: true });
      removeParentAbort = () => signal.removeEventListener("abort", onParentAbort);
    }
  } else if (signal !== undefined) {
    request.signal = signal;
  }
  const responsePromise = Promise.resolve().then(() => (
    typeof evaluator === "function"
      ? evaluator(request)
      : evaluator.chat(request)
  ));
  let response;
  try {
    if (timeoutMs === undefined) {
      response = await awaitWithAbort(responsePromise);
    } else {
      response = await Promise.race([
        awaitWithAbort(responsePromise),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timeoutController.abort(new Error("Judge interception timed out"));
            /** @type {Error & {code?: string}} */
            const error = new Error("Judge interception timed out");
            error.code = "judge_intercept_timeout";
            reject(error);
          }, timeoutMs);
        }),
      ]);
    }
  } finally {
    clearTimeout(timeoutId);
    removeParentAbort?.();
  }
  // issue #438：judge 是引擎自发起的调用 ⇒ 只进 engine 桶（不进模型轮账）。
  addUsage(response, undefined, { trackLatest: false, account: "engine" });
  // 带出当次 judge 调用的用量（issue #33 B）：judge.log / 逐轮 transcript 可对账；
  // 超时/出错路径 response 为 undefined，usage 缺省（调用方不设置该字段）。
  const inputTokens = response?.usage?.input_tokens;
  const outputTokens = response?.usage?.output_tokens;
  const judgeUsage = Number.isFinite(inputTokens) || Number.isFinite(outputTokens)
    ? {
      ...(Number.isFinite(inputTokens) ? { input_tokens: inputTokens } : {}),
      ...(Number.isFinite(outputTokens) ? { output_tokens: outputTokens } : {}),
    }
    : undefined;
  // 原始输出未截断带出（可审计性）：intercept 落 judge.log 时截断由调用方负责。
  const rawText = textFromBlocks(blocksFor(response?.content));
  return {
    decision: parseJudgeDecision(rawText),
    usage: judgeUsage,
    raw: rawText,
  };
}
