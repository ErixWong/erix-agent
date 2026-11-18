// @ts-check
import { appendFileSync } from "node:fs";
import { MID_SEQUENCE_REQUEST_VIEW_STUB } from "../src/loop/pending-tool-result.js";

/**
 * One compaction event's immediate stderr line.
 *
 * @param {*} event
 * @returns {string|null}
 */
export function formatCompactionEventLine(event) {
  if (event?.type !== "compaction") return null;
  const stat = event.compaction ?? {};
  const budgetUnreachable = stat.budgetUnreachable === "protected_message_exceeds_budget"
    || stat.budgetUnreachable === "cannot_fit"
    ? stat.budgetUnreachable
    : undefined;
  if (budgetUnreachable !== undefined) {
    const tokensAfter = Number.isFinite(stat.tokensAfter) ? stat.tokensAfter : "unknown";
    const folded = stat.compacted === true
      ? `同时已折叠 ${Number.isSafeInteger(stat.foldedRounds) ? stat.foldedRounds : 0} 轮；`
      : "";
    return `[erix] 压缩没能把请求压进预算（原因=${budgetUnreachable}，实测 ${tokensAfter} tokens）：`
      + `${folded}本次按超预算继续；若超出模型窗口，会由 provider 报错。`;
  }
  if (stat.compacted !== true) return null;
  const strategyName = typeof stat.strategyName === "string" ? stat.strategyName.trim() : "";
  const parts = ["[compaction]"];
  if (event.round !== undefined) parts.push(`round=${event.round}`);
  parts.push(`strategy=${strategyName === "" ? "unknown" : strategyName}`);
  parts.push(`foldedRounds=${Number.isSafeInteger(stat.foldedRounds) ? stat.foldedRounds : 0}`);
  parts.push(`tokensBefore=${Number.isFinite(stat.tokensBefore) ? stat.tokensBefore : "unknown"}`);
  parts.push(`tokensAfter=${Number.isFinite(stat.tokensAfter) ? stat.tokensAfter : "unknown"}`);
  return parts.join(" ");
}

/**
 * The fallback-strategy event's immediate stderr line.
 *
 * @param {*} event
 * @returns {string|null}
 */
export function formatCompactionFallbackEventLine(event) {
  if (event?.type !== "compaction_strategy_fallback") return null;
  const detail = typeof event.detail === "string" && event.detail.trim() !== ""
    ? event.detail.trim().replace(/\s+/gu, " ")
    : "unknown";
  const parts = ["[compaction]", "fallback"];
  if (event.round !== undefined) parts.push(`round=${event.round}`);
  parts.push(`detail=${detail}`);
  return parts.join(" ");
}

/**
 * Format a request-view tool-result stub notice without claiming every run was resumed.
 *
 * @param {*} event
 * @returns {string|null}
 */
export function formatResumeStubNotice(event) {
  if (event?.type !== "resume_journal_skipped") return null;
  if (event?.reason !== MID_SEQUENCE_REQUEST_VIEW_STUB) return null;
  const count = Number.isSafeInteger(event?.count) && event.count > 0 ? event.count : 0;
  if (count === 0) return null;
  const ids = Array.isArray(event?.toolUseIds) ? event.toolUseIds.filter((id) => typeof id === "string") : [];
  const idText = ids.length > 0 ? `（${ids.join(", ")}）` : "";
  const action = event.resumed === true
    ? `本次恢复补了 ${count} 条工具结果桩`
    : `本次 run 为 ${count} 条没有结果的工具调用补了桩`;
  return `[erix] ${action}${idText}：这些调用的结果不可用`
    + "（其中已执行过的不要盲目重发，先勘验现场）。";
}

/**
 * 终稿正文里出现**被文本化的工具调用**（#862）时的一行 stderr 提示。
 * 措辞中性：**这不是失败**——终态（`termination.reason` / 退出码）不因它变，
 * 只是提醒宿主「工具调用可能没真正执行 ⇒ 交付物可能没生成」。与
 * `formatResumeStubNotice` 同一形状（命中⇒一行，否则 null），同一通道（stderr）。
 *
 * @param {*} event
 * @returns {string|null}
 */
export function formatTextualizedToolCallLine(event) {
  if (event?.type !== "final_text_textualized_tool_call") return null;
  const marker = typeof event.marker === "string" && event.marker.trim() !== ""
    ? event.marker.trim()
    : "未知标记";
  const roundText = Number.isSafeInteger(event?.round) ? `（第 ${event.round} 轮）` : "";
  return `[erix] 终局正文里出现了被文本化的工具调用标记 ${marker}${roundText}：`
    + "这不是失败，但工具调用可能没真正执行、交付物可能没生成，建议核对现场。";
}

/**
 * Shared run event handling for chat and REPL: judge-log recording, stderr notices, and idle touches.
 *
 * @param {object} [options]
 * @param {string|undefined} [options.judgeLogPath]
 * @param {() => void} [options.touchIdle]
 * @param {(line: string) => void} [options.writeStderr]
 * @returns {{appendJudgeLogRecord: ((record: any) => void)|undefined, onEvent: (event: any) => void}}
 */
export function createRunEventHandlers({
  judgeLogPath,
  touchIdle = () => {},
  writeStderr = (line) => { process.stderr.write(`${line}\n`); },
} = {}) {
  let judgeLogWriteFailed = false;
  const appendJudgeLogRecord = judgeLogPath
    ? (record) => {
      if (judgeLogWriteFailed) return;
      try {
        appendFileSync(
          judgeLogPath,
          `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
          "utf8",
        );
      } catch (error) {
        judgeLogWriteFailed = true;
        console.error(`Judge log write failed: ${error?.message ?? String(error)}`);
      }
    }
    : undefined;
  const emitStderr = (line) => {
    if (line === null) return;
    try {
      writeStderr(line);
    } catch {
      // Display failures must not turn a completed run into a failure.
    }
  };
  let latestBudgetUnreachableEvent;
  let budgetNoticeEmitted = false;
  const flushBudgetNotice = () => {
    if (budgetNoticeEmitted || latestBudgetUnreachableEvent === undefined) return;
    budgetNoticeEmitted = true;
    emitStderr(formatCompactionEventLine(latestBudgetUnreachableEvent));
    latestBudgetUnreachableEvent = undefined;
  };

  const onEvent = (event) => {
    if (event?.type === "attempt" || event?.type === "recovering") touchIdle();
    if (event?.type === "run_outcome") {
      appendJudgeLogRecord?.(event);
      flushBudgetNotice();
    }
    if (event?.type === "compaction" && (
      event.compaction?.compacted === true
      || event.compaction?.budgetUnreachable !== undefined
    )) {
      appendJudgeLogRecord?.(event);
      const unreachable = event.compaction?.budgetUnreachable;
      if (unreachable === "protected_message_exceeds_budget" || unreachable === "cannot_fit") {
        latestBudgetUnreachableEvent = event;
      } else {
        emitStderr(formatCompactionEventLine(event));
      }
    }
    if (event?.type === "compaction_strategy_fallback") {
      appendJudgeLogRecord?.(event);
      emitStderr(formatCompactionFallbackEventLine(event));
    }
    const stubNotice = formatResumeStubNotice(event);
    if (stubNotice !== null) emitStderr(stubNotice);
    const textualizedLine = formatTextualizedToolCallLine(event);
    if (textualizedLine !== null) emitStderr(textualizedLine);
  };
  return { appendJudgeLogRecord, onEvent };
}
