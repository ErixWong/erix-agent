import { markStablePrefix } from "./provider-runner.js";
import { runDeliverables } from "./deliverables.js";
import { tryParseWrapupJson } from "../reflection/wrapup.js";
import { validateMessages } from "../messages/rounds.js";
import { cloneState } from "./budget.js";
import { blocksFor, hasToolUse, textFromBlocks } from "./messages.js";

export const TRUNCATED_TERMINATION_REASONS = new Set([
  "max_rounds_cap",
  "continuation_exhausted",
  "stall",
  "final_guard_unverified",
]);

export const FINAL_GUARD_TERMINATION_REASONS = new Set([
  "end_turn",
  "no_tool",
  "judge_done",
  "max_rounds_cap",
  "stall",
  "continuation_exhausted",
]);

export const FINAL_GUARD_NON_CONTINUABLE_REASONS = new Set([
  "max_rounds_cap",
  "stall",
  "continuation_exhausted",
]);

/**
 * issue #386 切片 3：`FINAL_GUARD_NON_CONTINUABLE_REASONS` 里**允许补跑**的那两类。
 *
 * ⚠ 它不是上面那个集合的改名，也不是它的子集变量：两个集合的**内容都一个字没改**（上面那个仍是
 * 三类，`TRUNCATED_TERMINATION_REASONS` 也不动）。本集合只回答「预算类停机里哪些可以借中途扩轮
 * 的机制再跑一次」，而 `stall` 被**显式排除**——stall 的定义就是「连续无进展」，给它轮次是纯烧钱，
 * 这一条由 `test/loop-guard-extend.test.js` 单独钉住（含 opt-in 下的反向证）。
 *
 * 补跑是否真的发生还取决于另外三个条件（宿主 opt-in / guard 判 `revise` / 扩轮准入与预算闸），
 * 见 `src/loop/orchestrator.js#extendAfterGuard`。
 */
export const FINAL_GUARD_EXTENDABLE_REASONS = new Set([
  "max_rounds_cap",
  "continuation_exhausted",
]);

export function makeTermination(reason, detail) {
  return {
    reason,
    ...(detail === undefined ? {} : { detail: String(detail) }),
  };
}

export function terminationDetailForError(error) {
  return error?.message === undefined ? String(error) : String(error.message);
}

// issue #176：`failed` 终局的根因分类。引擎不解释语义、不维护枚举，只把错误上已有的分类字段
// （`KitError.code`：timeout / rate_limited / auth / server / checkpoint_failed / …）
// 原样透出；没有分类字段时回落到 `unknown`，宿主因此总能在终局里读到该字段。
export function terminationErrorCodeForError(error) {
  const code = error?.code;
  return typeof code === "string" && code.trim() !== ""
    ? code
    : "unknown";
}

// issue #176：additive 字段——只有 `reason === "failed"` 才挂 `errorCode`，
// 其余 reason 的终局形状保持不变（宿主既有 deepEqual 断言不受影响）。
export function withErrorCode(termination, error) {
  if (termination?.reason !== "failed" || termination.errorCode !== undefined) {
    return termination;
  }
  return { ...termination, errorCode: terminationErrorCodeForError(error) };
}

// issue #180（方案 A）：抛错路径同样携带终局载荷。`aborted` 的 run 真花了 token，
// 宿主却只能在 catch 里写 0，因此把已累计量同步进 termination（additive 字段，
// 「abort = 抛错」语义不变）。
export function withTerminationPayload(termination, payload) {
  if (termination?.reason !== "aborted" || termination.usage !== undefined) {
    return termination;
  }
  return {
    ...termination,
    usage: payload.usage,
    rounds: payload.rounds,
    partial: true,
  };
}

export function annotateTermination(error, termination, payload) {
  const target = error && (typeof error === "object" || typeof error === "function")
    ? error
    : (() => {
        const wrapped = new Error(String(error));
        wrapped.cause = error;
        return wrapped;
      })();
  target.termination = termination;
  // issue #180（方案 A）：与 `makeResult` 同一对象口径的 usage/rounds/finalText 挂到
  // 同一个错误对象上（finalText 为已产出的部分终稿，无则为空串）。
  if (payload !== undefined) {
    target.usage = payload.usage;
    target.rounds = payload.rounds;
    target.finalText = payload.finalText ?? "";
  }
  return target;
}

export function terminationReasonForAction(action, continuationExhausted) {
  if (action?.value === "judge_done") return "judge_done";
  if (continuationExhausted) return "continuation_exhausted";
  if (action?.value === "noTool") return "no_tool";
  if (action?.value === "stall") return "stall";
  if (action?.value === "cap") return "max_rounds_cap";
  return "end_turn";
}

// ── issue #386 切片 1：finalGuard payload 的富化（**纯加法**）───────────────────────────────
// 背景：guard 是引擎里唯一**有牙**的复核（它能改写终局），但它从前只拿到 7 个键
// （finalText / findings / messages / round / rounds / signal / termination），验收要用的
// 事实一项都没有，宿主只能去重解析 `messages`（小 run 611 字节，真实 run 几十 KB~MB）。
//
// 纪律（三条，缺一条就退化成假数据）：
//   1. 每个新键都来自引擎**既有**状态（零新采集），现有 7 个键的名字/类型/取值逐字不变；
//   2. 探不到就**不写该键**（不写假值、不写空壳）：`undefined` / 非预期类型一律跳过；
//   3. 每个可变长键都有明确上限，超限时截断并在**同键旁**留一个可判定的 `…Truncated:true`。
// 不改任何裁决语义：本模块只多交事实，accept/skip/revise 的判定与终局 reason 一字未动。

/** 文件台账的**唯一**上限（issue #388）：
 *  `governorState.filesWritten` / `governorState.fileWrites` 的裁剪（orchestrator 的 `trimFilesWritten` /
 *  `trimFileWrites`）与 payload 里对应键的截断（`FINAL_GUARD_PAYLOAD_LIMITS`）都读这一个常量。
 *
 *  为什么必须是共享常量：切片 1 的报告点名过「payload 里一份 50、引擎 `trimFilesWritten` 一份 50」——
 *  改一处就会出现「引擎留着 50 条、payload 只发 30 条」这类隐蔽不一致，而两边都不会报错。
 *  本常量是**台账**口径（条目数），不是字节口径。 */
export const FILE_LEDGER_LIMIT = 50;

/** `finalGuard` payload 各可变长键的上限（超限截断 + 截断标记，见 `buildFinalGuardPayload`）。
 *
 * 上限不是审美：`messages` 才是 payload 的字节大头（30 轮 × 4KB 工具输出 ≈ 130KB），新键必须
 * 小到可以忽略（探针 `scripts/final-guard-probe.mjs` 把「新键总字节 < messages 字节的 2%」
 * 当断言跑）。数值口径：`filesWritten` / `fileWrites` / `toolStats` 取**最新/最活跃**的那一头
 * （旧尾巴丢掉），`taskBrief` / `selfReport` 的文本按 Unicode 码点截断（与 `capTaskBrief` 同口径，
 * 不会切碎代理对）。两个文件台账键的上限都指 `FILE_LEDGER_LIMIT`（同一个数，不是两个 50）。
 */
export const FINAL_GUARD_PAYLOAD_LIMITS = Object.freeze({
  filesWritten: FILE_LEDGER_LIMIT,
  fileWrites: FILE_LEDGER_LIMIT,
  toolStats: 40,
  taskBrief: 2000,
  selfReportText: 2000,
});

/** 按**码点**截断（不按 UTF-16 码元：那会把 emoji/生僻字切成半个）。
 *  @returns {{text:string, truncated:boolean}} */
function capCodePoints(value, limit) {
  const chars = Array.from(String(value ?? ""));
  if (chars.length <= limit) return { text: chars.join(""), truncated: false };
  return { text: chars.slice(0, limit).join(""), truncated: true };
}

/** `Map` → plain object（`JSON.stringify(new Map())` 是 `{}`，宿主会读到空对象）。
 *  保留**调用次数最多**的 `limit` 个工具（calls 降序、同数按名字升序 ⇒ 可复现）；
 *  字段只搬引擎已有的 `calls` / `failures`，不新造统计。
 *  @returns {{stats:Record<string,{calls:number,failures:number}>, truncated:boolean}|null} */
function plainToolStats(toolStats, limit) {
  if (!(toolStats instanceof Map)) return null;
  const rows = [];
  for (const [name, value] of toolStats) {
    rows.push({
      name: String(name),
      calls: Number.isFinite(value?.calls) ? value.calls : 0,
      failures: Number.isFinite(value?.failures) ? value.failures : 0,
    });
  }
  rows.sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const kept = rows.slice(0, limit);
  /** @type {Record<string, {calls:number, failures:number}>} */
  const stats = {};
  for (const row of kept) stats[row.name] = { calls: row.calls, failures: row.failures };
  return { stats, truncated: kept.length < rows.length };
}

/** 写文件台账 → `[{path, round}]`，只留**最后** `limit` 条（= 最新；`governorState.filesWritten`
 *  本来就是 append 顺序）。`round` 缺失时写 `null` 而不是编一个 0（0 是一个合法轮号，编不得）。
 *  @returns {{files:{path:string,round:number|null}[], truncated:boolean}|null} */
function plainFilesWritten(filesWritten, limit) {
  if (!Array.isArray(filesWritten)) return null;
  const rows = [];
  for (const entry of filesWritten) {
    if (entry === null || typeof entry !== "object") continue;
    rows.push({
      path: String(entry.path ?? ""),
      round: Number.isFinite(entry.round) ? entry.round : null,
    });
  }
  const kept = rows.slice(Math.max(0, rows.length - limit));
  return { files: kept, truncated: kept.length < rows.length };
}

/** 原始写路径台账 → `[{path, round, tool}]`（issue #388）。
 *
 *  与 `plainFilesWritten` 的区别只有一处，但那一处是本单的根因：这里的 `path` 是
 *  `tool_use.input[pathKey]` 的**原始值**（逐字，不摘要、不截断），可以直接拿去 `stat()`；
 *  `filesWritten[].path` 是 judge timeline 的 40 码点摘要（`summarizeArgument`，且不带截断标记）。
 *  三个键总是写全（`round` 探不到写 `null`，`tool` 探不到写 `""`）：形状固定，宿主不用判空。
 *
 *  @returns {{files:{path:string,round:number|null,tool:string}[], truncated:boolean}|null}
 */
function plainFileWrites(fileWrites, limit) {
  if (!Array.isArray(fileWrites)) return null;
  const rows = [];
  for (const entry of fileWrites) {
    if (entry === null || typeof entry !== "object") continue;
    rows.push({
      path: String(entry.path ?? ""),
      round: Number.isFinite(entry.round) ? entry.round : null,
      tool: typeof entry.tool === "string" ? entry.tool : "",
    });
  }
  const kept = rows.slice(Math.max(0, rows.length - limit));
  return { files: kept, truncated: kept.length < rows.length };
}

/** run 累计 usage → plain object（只搬引擎自己写的四个计数，不做换算、不补 0）。 */
function plainUsage(usage) {
  if (usage === null || typeof usage !== "object") return undefined;
  const out = {};
  for (const key of ["input_tokens", "output_tokens", "cacheRead", "cacheWrite"]) {
    if (Number.isFinite(usage[key])) out[key] = usage[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 模型最后一次 wrap-up 对象（**已归一化**的那一份，不重新解析）→ JSON-safe 的 `{done,summary,output,findings}`。
 *
 *  `findings` **不是**从这里原样搬的：它取 `ctx.declaredFindings`（即 payload 的 `findings` 键），
 *  两者同源 ⇒ 永远不会出现「`findings` 有值而 `selfReport` 缺该键」的分裂。
 *  @returns {{report:object, summaryTruncated:boolean, outputTruncated:boolean}|null} */
function plainSelfReport(raw, findings, limit) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const summary = capCodePoints(raw.summary, limit);
  const output = capCodePoints(raw.output, limit);
  const report = { done: raw.done === true, summary: summary.text, output: output.text };
  if (findings !== undefined) report.findings = findings;
  return {
    report,
    summaryTruncated: summary.truncated,
    outputTruncated: output.truncated,
  };
}

/**
 * 组装 `finalGuard` 的 payload。
 *
 * 前 7 个键（`finalText` / `findings` / `messages` / `round` / `rounds` / `signal` / `termination`）
 * 是既有契约，名字、类型、取值与顺序**逐字不变**（`test/loop-final-guard.test.js` 钉住）。
 * 其后全是 issue #386 的加法键，每个都「探不到就不写」。
 *
 * @param {object} ctx 引擎侧终局上下文（`createTerminationManager` 的入参）
 * @param {string} reason 终局 reason
 * @param {string|undefined} detail 终局 detail
 * @param {number} attempt 第几次 guard 调用（1 起，单调递增）
 * @returns {object} 可直接 `JSON.stringify` 的 payload（无 Map、无函数、无循环引用、无 Error）
 */
export function buildFinalGuardPayload(ctx, reason, detail, attempt) {
  const payload = {
    finalText: ctx.finalText,
    findings: ctx.declaredFindings,
    messages: cloneState(ctx.messages),
    round: ctx.rounds,
    rounds: ctx.rounds,
    signal: ctx.toolSignal,
    termination: makeTermination(reason, detail),
  };
  // ── 以下为 issue #386 加法键。顺序固定，便于宿主与探针逐键对账。
  if (typeof ctx.cwd === "string") payload.cwd = ctx.cwd;
  if (typeof ctx.runId === "string") payload.runId = ctx.runId;
  const files = plainFilesWritten(ctx.filesWritten, FINAL_GUARD_PAYLOAD_LIMITS.filesWritten);
  if (files !== null) {
    payload.filesWritten = files.files;
    if (files.truncated) payload.filesWrittenTruncated = true;
  }
  // issue #388：原始写路径（可直接 `stat()`）。与 `filesWritten` 的分工写进契约：
  // `filesWritten` = 提示用摘要，`fileWrites` = 机器判据用原值。
  const writes = plainFileWrites(ctx.fileWrites, FINAL_GUARD_PAYLOAD_LIMITS.fileWrites);
  if (writes !== null) {
    payload.fileWrites = writes.files;
    if (writes.truncated) payload.fileWritesTruncated = true;
  }
  const stats = plainToolStats(ctx.toolStats, FINAL_GUARD_PAYLOAD_LIMITS.toolStats);
  if (stats !== null) {
    payload.toolStats = stats.stats;
    if (stats.truncated) payload.toolStatsTruncated = true;
  }
  if (typeof ctx.taskBrief === "string" && ctx.taskBrief !== "") {
    const brief = capCodePoints(ctx.taskBrief, FINAL_GUARD_PAYLOAD_LIMITS.taskBrief);
    payload.taskBrief = brief.text;
    if (brief.truncated) payload.taskBriefTruncated = true;
  }
  const selfReport = plainSelfReport(
    ctx.selfReport,
    ctx.declaredFindings,
    FINAL_GUARD_PAYLOAD_LIMITS.selfReportText,
  );
  if (selfReport !== null) {
    payload.selfReport = selfReport.report;
    if (selfReport.summaryTruncated) payload.selfReportSummaryTruncated = true;
    if (selfReport.outputTruncated) payload.selfReportOutputTruncated = true;
  }
  const usage = plainUsage(ctx.usage);
  if (usage !== undefined) payload.usage = usage;
  if (typeof ctx.elapsedMs === "function") {
    const elapsed = ctx.elapsedMs();
    if (Number.isFinite(elapsed)) payload.elapsedMs = elapsed;
  }
  if (Number.isSafeInteger(attempt) && attempt > 0) payload.attempt = attempt;
  if (Number.isSafeInteger(ctx.finalGuardRetryLimit)) {
    payload.guardBudget = ctx.finalGuardRetryLimit;
  }
  return payload;
}

export function createTerminationManager(ctx) {
  // issue #386：`attempt` 是「这是第几次 guard 调用」（1 起，单调递增）。计数器放在本模块的闭包里
  // 而不是 `guardMetrics`：后者是**结果**计数（verified/skipped/revised/unverified/guard_error），
  // 一个 run 里多次 revise 会让它们分散增长，反推不出调用序号。
  let guardAttempt = 0;
  const callFinalGuard = async (reason, detail) => {
    guardAttempt += 1;
    const payload = buildFinalGuardPayload(ctx, reason, detail, guardAttempt);
    // ── issue #386 切片 2 R2：**每次**调用 guard 之前核一遍宿主声明的交付物判据 ─────────────
    // 「每次」是核心：guard 判 revise → 模型补做 → 下一轮 attempt 的判据自动重算，补做之后才可能
    // 拿到 verified。只核一次（比如只在第一次调用前核）会把「补做后通过」的 run 永久拦在门外。
    //
    // 判据拿到的 `payload` 就是**这次**要交给 guard 的那一份事实（`buildFinalGuardPayload` 的输出，
    // 此时还没挂 `deliverables` 键，所以宿主判据看不到自己的结论——不会出现自我指涉的判据）。
    // 结果随后**写回同一份 payload**：guard 因此能看见机器判据的结论，而不只是模型的自报。
    const deliverables = ctx.deliverables;
    let deliverablesAllPassed = true;
    let deliverablesFailed = 0;
    if (deliverables !== undefined) {
      const outcome = await runDeliverables(deliverables, payload, {
        timeoutMs: ctx.finalGuardTimeout,
      });
      payload.deliverables = outcome.results;
      payload.deliverablesAllPassed = outcome.allPassed;
      ctx.guardMetrics.deliverables_checked += outcome.checked;
      ctx.guardMetrics.deliverables_failed += outcome.failed;
      deliverablesAllPassed = outcome.allPassed;
      deliverablesFailed = outcome.failed;
    }
    let timeoutId;
    try {
      const finalGuard = ctx.finalGuard;
      const guardPromise = Promise.resolve().then(() => finalGuard(payload));
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error("Final guard timed out");
          error.code = "timeout";
          reject(error);
        }, ctx.finalGuardTimeout);
      });
      const awaitWithAbort = ctx.awaitWithAbort;
      const decision = await Promise.race([
        awaitWithAbort(guardPromise),
        timeoutPromise,
      ]);
      if (decision?.action === "accept") {
        const emitEvent = ctx.emitEvent;
        // ── issue #386 切片 2 R3：**机器闸门**。guard 说 accept，但宿主声明的判据没过 ⇒
        // 不许盖 `verified` 章（这就是「橡皮章」的解药：机器证据压过 LLM 意见）。
        // 只改 `verification`，**不动** `termination.reason`：闸门不引入新的停机原因，
        // `final_guard_unverified` 那条既有路径也一字未改（它在 orchestrator 里，不在这里）。
        // 未声明 `deliverables` 时 `deliverablesAllPassed` 恒为 true ⇒ 这条分支永不进入（纯加法）。
        if (!deliverablesAllPassed) {
          ctx.guardMetrics.unverified += 1;
          ctx.verification = { status: "unverified", reason: "deliverables_failed" };
          emitEvent({
            type: "final_guard",
            round: ctx.rounds,
            action: "accept",
            deliverables_failed: deliverablesFailed,
          });
          return { action: "accept", deliverablesAllPassed: false };
        }
        ctx.guardMetrics.verified += 1;
        ctx.verification = { status: "verified" };
        emitEvent({
          type: "final_guard",
          round: ctx.rounds,
          action: "accept",
          // 新增字段只在声明了判据时出现（未声明 ⇒ 事件形状与今天逐字一致）。
          ...(deliverables === undefined ? {} : { deliverables_failed: 0 }),
        });
        return { action: "accept" };
      }
      if (
        decision?.action === "skip"
        && typeof decision.reason === "string"
        && decision.reason.length > 0
      ) {
        ctx.guardMetrics.skipped += 1;
        ctx.verification = { status: "skipped", reason: decision.reason };
        const emitEvent = ctx.emitEvent;
        emitEvent({
          type: "final_guard",
          round: ctx.rounds,
          action: "skip",
          reason: decision.reason,
        });
        return { action: "skip", reason: decision.reason };
      }
      if (
        decision?.action === "revise"
        && typeof decision.message === "string"
        && decision.message.length > 0
      ) {
        ctx.guardMetrics.revised += 1;
        const emitEvent = ctx.emitEvent;
        emitEvent({
          type: "final_guard",
          round: ctx.rounds,
          action: "revise",
          reason: "unverified",
        });
        return { action: "revise", message: decision.message };
      }
      throw new TypeError("finalGuard returned an invalid decision");
    } catch (error) {
      if (ctx.signal?.aborted) {
        const throwIfAborted = ctx.throwIfAborted;
        throwIfAborted(ctx.signal);
      }
      const errorReason = error?.code === "timeout"
        || error?.name === "TimeoutError"
        ? "timeout"
        : "error";
      ctx.guardMetrics.unverified += 1;
      ctx.verification = {
        status: "error",
        reason: errorReason,
        detail: terminationDetailForError(error),
      };
      ctx.guardMetrics.guard_error += 1;
      const emitEvent = ctx.emitEvent;
      emitEvent({
        type: "final_guard",
        round: ctx.rounds,
        action: "error",
        reason: errorReason,
      });
      return { action: "error", reason: errorReason };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const hasFinalDraft = () => (
    ctx.finalText.trim() !== ""
    && ctx.roundStopReason === "end_turn"
    && !hasToolUse(ctx.lastAssistantContent)
  );

  const forceFinalIfNeeded = async (reason) => {
    if (
      ctx.forcedFinal
      || !["max_rounds_cap", "stall", "continuation_exhausted"].includes(reason)
      || hasFinalDraft()
      || process.env.ERIX_NO_FORCED_FINAL?.trim() === "1"
    ) return;

    const instruction = {
      role: "user",
      // issue #323：强制收尾指令是引擎自写的控制文本，打 marker 防 judge 自读回（主模型仍可见）。
      meta: { source: "judge-control" },
      content: [{
        type: "text",
        text: `【强制收尾】循环因 ${reason} 结束。禁止调用任何工具；请立即给出最终结论，或明确声明不可恢复。`,
      }],
    };
    ctx.messages.push(instruction);
    ctx.messageRounds.set(instruction, ctx.rounds);
    validateMessages(ctx.messages, { allowPendingToolUse: true });
    const stablePrefix = ctx.cacheStablePrefix !== false
      ? markStablePrefix(ctx.mainSystem, ctx.messages)
      : { system: ctx.mainSystem, messages: ctx.messages };
    const request = {
      system: stablePrefix.system,
      messages: stablePrefix.messages,
      tools: [],
      signal: ctx.signal,
    };
    if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
    if (ctx.temperature !== undefined) request.temperature = ctx.temperature;
    if (ctx.topP !== undefined) request.topP = ctx.topP;
    const awaitWithAbort = ctx.awaitWithAbort;
    const response = await awaitWithAbort(ctx.provider.chat(request));
    const addUsage = ctx.addUsage;
    const estimateMessageTokens = ctx.estimateMessageTokens;
    addUsage(response, estimateMessageTokens(ctx.messages));
    const content = blocksFor(response?.content);
    const assistant = { role: "assistant", content };
    ctx.messages.push(assistant);
    ctx.messageRounds.set(assistant, ctx.rounds);
    ctx.lastAssistantContent = content;
    ctx.roundStopReason = response?.stopReason;
    const responseText = textFromBlocks(content);
    const wrapup = ctx.wrapupEnabled && response?.stopReason === "end_turn"
      ? tryParseWrapupJson(responseText)
      : null;
    ctx.finalText = wrapup === null
      ? responseText
      : wrapup.output || wrapup.summary;
    ctx.declaredFindings = wrapup?.findings;
    // issue #386：强制收尾同样产出一份 wrap-up（与 `declaredFindings` 同源、同一时刻），
    // 所以自报对象也要跟着换——否则 guard 拿到的是收尾**之前**那份自报，甚至没有。
    ctx.selfReport = wrapup ?? undefined;
    ctx.forcedFinal = true;
    const emitEvent = ctx.emitEvent;
    emitEvent({ type: "forced_final", round: ctx.rounds, reason });
  };

  const makeResult = (reason, detail, error) => {
    // issue #176：成功返回路径上 `failed` 目前不是可达 reason（失败统一走 fail() 抛错），
    // 此处只保持与抛错路径同一口径的字段规则，避免两条终路形状分叉。
    const termination = withErrorCode({
      ...makeTermination(reason, detail),
      ...(ctx.forcedFinal ? { forcedFinal: true } : {}),
    }, error);
    return {
      finalText: ctx.finalText,
      messages: ctx.messages,
      transcript: [...ctx.messages],
      rounds: ctx.rounds,
      truncated: TRUNCATED_TERMINATION_REASONS.has(termination.reason),
      termination,
      verification: { ...ctx.verification, metrics: { ...ctx.guardMetrics } },
      ...(ctx.currentRunState === undefined
        ? {}
        : { runState: cloneState(ctx.currentRunState) }),
      usage: ctx.usage,
      compactionStats: ctx.compactionStats,
      // 错误账单（issue #109 第 1 步）：可靠交付通道之二；默认空数组（schema 冻结）。
      // completionErrors 由第 4 步接线（收尾失败不覆盖主结果）。
      unpersisted: ctx.errorLedger.toUnpersisted(),
      completionErrors: [],
    };
  };

  const finish = async (reason, detail, error) => {
    ctx.currentTerminationReason = reason;
    const refreshRunState = ctx.refreshRunState;
    try {
      await refreshRunState();
      const state = ctx.verification.status === "unverified"
        ? "unverified_error"
        : ctx.verification.status === "error"
          ? "guard_error"
          : "succeeded";
      const markRunState = ctx.markRunState;
      await markRunState(state);
      const result = makeResult(reason, detail, error);
      // issue #165：终局追加一条 run 级 outcome 汇总记录（方案 ①：append-only，**不回写**
      // 已流出的 judge 决策记录，宿主按 `runId` join）。放在 markRunState **之后**：持久化
      // 失败时走 catch → ctx.fail()，由它发唯一一条终局记录（发射口有去重门，不会双发）。
      const emitRunOutcome = ctx.emitRunOutcome;
      if (typeof emitRunOutcome === "function") {
        emitRunOutcome({
          rounds: result.rounds,
          termination: result.termination,
          verification: result.verification,
        });
      }
      return result;
    } catch (error) {
      return ctx.fail(error);
    }
  };

  return {
    callFinalGuard,
    forceFinalIfNeeded,
    finish,
  };
}
