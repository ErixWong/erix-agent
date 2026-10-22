const GUARD_METRIC_KEYS = [
  "verified",
  "skipped",
  "revised",
  "unverified",
  "guard_error",
];
// issue #391 R3：交付物判据的两个计数。引擎**只在声明了 `deliverables` 时**才把它们写进
// `verification.metrics`（`src/loop/orchestrator.js` 的闸门那一段），所以渲染也必须跟着「有值才出现」：
// 未声明判据时这一行逐字不变（`test/cli.test.js` 的那格逐字比的就是它）。
const DELIVERABLE_METRIC_KEYS = ["deliverables_checked", "deliverables_failed"];

export function formatGuardMetrics(verification) {
  if (!verification || verification.reason === "no_final_guard") return "guard=off";

  const metrics = verification?.metrics ?? {};
  const declared = DELIVERABLE_METRIC_KEYS.some((key) => Number.isSafeInteger(metrics[key]));
  const keys = declared ? [...GUARD_METRIC_KEYS, ...DELIVERABLE_METRIC_KEYS] : GUARD_METRIC_KEYS;
  const values = keys.map(
    (key) => `${key}:${Number.isSafeInteger(metrics[key]) ? metrics[key] : 0}`,
  );
  return `guard={${values.join(",")}}`;
}
