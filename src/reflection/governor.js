const MEMORY_LOSS_TEXT = "你的任务仍在进行中。请回顾对话中的任务指令继续执行（必要时可用 recall 工具找回早期上下文）。";
const NO_TOOL_TEXT = "（请继续完成任务）";

function numberOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function timeGuarded(signals) {
  if (!Number.isFinite(signals?.remainingMs)) return false;
  const rounds = numberOr(signals?.rounds, signals?.round);
  const elapsed = numberOr(signals?.elapsedMs);
  const estimate = rounds > 0 ? elapsed / rounds : 30_000;
  return signals.remainingMs < estimate * 2;
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
