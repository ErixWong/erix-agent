const MEMORY_LOSS_TEXT = "你的任务仍在进行中。请回顾对话中的任务指令继续执行（必要时可用 recall 工具找回早期上下文）。";
const NO_TOOL_TEXT = "（请继续完成任务）";
export const STALL_STREAK_LIMIT = 3;

function numberOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function estimatedRoundMs(signals = {}) {
  const rounds = numberOr(signals.rounds, signals.round);
  const elapsed = numberOr(signals.elapsedMs);
  return rounds > 0 && elapsed > 0 ? elapsed / rounds : 30_000;
}

export function isStuckOnRepeatedError(signals = {}) {
  return numberOr(signals.errorRepeat) >= 3
    && signals.hasProgress === false
    && signals.shouldContinue === true;
}

function timeGuarded(signals) {
  if (!Number.isFinite(signals?.remainingMs)) return false;
  return signals.remainingMs < estimatedRoundMs(signals) * 2;
}

export function shouldWrapUp(signals = {}) {
  return Number.isFinite(signals.remainingMs)
    && signals.remainingMs < estimatedRoundMs(signals) * 2
    && !signals.wrapUpNudged
    && numberOr(signals.errorRepeat) < 3;
}

function extensionAllowed(signals) {
  const extensionCount = numberOr(signals?.extensionCount);
  const maxExtensions = Number.isFinite(signals?.maxExtensions)
    ? signals.maxExtensions
    : Number.POSITIVE_INFINITY;
  const currentMax = numberOr(signals?.effectiveMaxRounds);
  const cap = Number.isFinite(signals?.maxRoundsCap)
    ? signals.maxRoundsCap
    : Number.POSITIVE_INFINITY;
  return extensionCount < maxExtensions && currentMax < cap;
}

function normalizeEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== "object") return {};
  return {
    continueFlag: evaluation.continueFlag === true
      || evaluation.continue === true
      || evaluation.shouldContinue === true,
    stalled: evaluation.stalled === true,
    reason: String(evaluation.reason ?? ""),
    plan: String(evaluation.plan ?? ""),
    stallPattern: String(evaluation.stallPattern ?? ""),
  };
}

/**
 * Phase one of governance. This function never performs I/O. A reflect action
 * is a request for the loop to obtain an evaluation and call phase two.
 */
export function decideRoundAction(signals = {}) {
  const noToolRound = signals.noToolRound !== false
    && (signals.noToolRound === true || numberOr(signals.noToolStreak) > 0);
  if (signals.continuationExhausted === true) {
    return { kind: "stop", value: "cap", truncated: true };
  }
  if (signals.memoryLoss === true) {
    return {
      kind: "nudge",
      reason: "memoryLoss",
      text: MEMORY_LOSS_TEXT,
      resetNoToolStreak: true,
      continue: true,
    };
  }
  if (signals.hasToolUse !== false && shouldWrapUp(signals)) {
    const remainingSeconds = Math.max(0, Math.ceil(signals.remainingMs / 1000));
    return {
      kind: "nudge",
      reason: "wrapUp",
      text: `外部时间预算将尽（剩余约 ${remainingSeconds} 秒）。请尽快收尾：确保当前产物可判定、运行验证命令并给出最终结论。不要开启新的长任务。`,
      wrapUpNudged: true,
      continue: true,
    };
  }
  if (isStuckOnRepeatedError(signals)) {
    return {
      kind: "nudge",
      reason: "repeatedError",
      text: `检测到同一错误重复出现（第 ${numberOr(signals.errorRepeat)} 次）。请换思路：不要重复已失败的尝试。检查错误根因（可能是依赖缺失/路径/版本），或改用完全不同的方法。`,
      continue: true,
    };
  }
  if (signals.stallSuspicion === true
    && numberOr(signals.stallStreak) < STALL_STREAK_LIMIT) {
    return {
      kind: "nudge",
      reason: "stall",
      text: "检测到疑似重复调用（连续无进展）。若确有新目的（如重跑验证），请明确说明；否则请推进新步骤，不要重复相同动作。",
      resetNoToolStreak: true,
      continue: true,
    };
  }
  if (numberOr(signals.stallStreak) >= STALL_STREAK_LIMIT
    && signals.stallSuspicion === true) {
    return { kind: "stop", value: "stall", truncated: true };
  }
  if (signals.completionSignalDetected === true && signals.shouldContinue === false) {
    return { kind: "stop", value: "completion", truncated: false };
  }
  if (noToolRound
    && signals.noToolStreak >= numberOr(signals.maxNoToolRounds)) {
    return { kind: "stop", value: "noTool", truncated: false };
  }
  if (noToolRound && signals.noToolStreak > 0) {
    return {
      kind: "nudge",
      reason: "noTool",
      text: NO_TOOL_TEXT,
      continue: true,
    };
  }
  if (
    signals.reflectionEnabled === true
    && signals.nearLimit === true
    && !signals.completionSignalDetected
    && extensionAllowed(signals)
  ) {
    return { kind: "reflect" };
  }
  return signals.shouldContinue === true
    ? { kind: "continue" }
    : { kind: "stop", value: "complete", truncated: false };
}

/**
 * Phase two of governance. The evaluator result is plain data supplied by
 * the loop; this function remains deterministic and side-effect free.
 */
export function decideWithEvaluation(signals = {}, evaluation = {}) {
  if (signals.continuationExhausted === true) {
    return { kind: "stop", value: "cap", truncated: true };
  }
  if (signals.memoryLoss === true) {
    return decideRoundAction({ ...signals, reflectionEnabled: false });
  }
  if (signals.completionSignalDetected === true && signals.shouldContinue === false) {
    return { kind: "stop", value: "completion", truncated: false };
  }
  if (signals.noToolRound === true
    || (signals.noToolRound === undefined && numberOr(signals.noToolStreak) > 0)) {
    return decideRoundAction({ ...signals, reflectionEnabled: false });
  }
  if (timeGuarded(signals)) {
    // 临近超时：不扩轮但继续正常跑完剩余轮次（放弃反射建议的扩展）
    return { kind: "continue", timedOut: true };
  }
  if (!extensionAllowed(signals)) {
    return { kind: "stop", value: "cap", truncated: true };
  }

  const decision = normalizeEvaluation(evaluation);
  if (!decision.continueFlag) {
    return {
      kind: "stop",
      value: "reflection-stop",
      truncated: false,
      reason: decision.reason,
    };
  }
  const kind = decision.stalled ? "extend+redirect" : "extend";
  const text = decision.stalled
    ? `检测到可能打转：${decision.stallPattern || decision.reason}。请换思路：${decision.plan}。不要重复已失败的尝试。`
    : `继续执行。反思建议的下一步：${decision.plan}`;
  return {
    kind,
    text,
    reason: decision.reason,
    plan: decision.plan,
    extensionStep: signals.extensionStep,
  };
}

export const decide = decideRoundAction;
