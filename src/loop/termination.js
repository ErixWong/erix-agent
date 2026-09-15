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
  "reflection_stop",
]);

export const FINAL_GUARD_NON_CONTINUABLE_REASONS = new Set([
  "max_rounds_cap",
  "stall",
  "continuation_exhausted",
  "reflection_stop",
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

export function annotateTermination(error, termination) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    error.termination = termination;
    return error;
  }
  const wrapped = new Error(String(error));
  wrapped.cause = error;
  wrapped.termination = termination;
  return wrapped;
}

export function terminationReasonForAction(action, continuationExhausted) {
  if (action?.value === "judge_done") return "judge_done";
  if (continuationExhausted) return "continuation_exhausted";
  if (action?.value === "noTool") return "no_tool";
  if (action?.value === "stall") return "stall";
  if (action?.value === "cap") return "max_rounds_cap";
  if (action?.value === "reflection-stop") return "reflection_stop";
  return "end_turn";
}
