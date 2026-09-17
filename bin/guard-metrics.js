const GUARD_METRIC_KEYS = [
  "verified",
  "skipped",
  "revised",
  "unverified",
  "guard_error",
];

export function formatGuardMetrics(verification) {
  if (!verification || verification.reason === "no_final_guard") return "guard=off";

  const metrics = verification?.metrics ?? {};
  const values = GUARD_METRIC_KEYS.map(
    (key) => `${key}:${Number.isSafeInteger(metrics[key]) ? metrics[key] : 0}`,
  );
  return `guard={${values.join(",")}}`;
}
