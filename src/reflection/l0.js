import { createHash } from "node:crypto";

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => block?.text ?? block?.content ?? "")
      .join("");
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

function hashError(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Extract objective facts from the tool results belonging to one round.
 * Tool output is deliberately treated as data; no model-produced fields are
 * accepted here.
 */
export function extractL0Facts(messages, state = { seenErrors: new Map() }) {
  const seenErrors = state?.seenErrors instanceof Map
    ? state.seenErrors
    : new Map();
  const results = (Array.isArray(messages) ? messages : []).flatMap((message) => (
    blocksFor(message?.content).filter((block) => block?.type === "tool_result")
  ));
  const errors = [];
  const seen = new Set();
  let errorRepeat = 0;
  for (const result of results) {
    const isError = result?.is_error === true || result?.success === false;
    if (!isError) continue;
    const fullText = resultText(result.content);
    const text = fullText.slice(0, 500);
    const errorHash = hashError(fullText);
    const previous = seenErrors.get(errorHash);
    const previousCount = Number.isSafeInteger(previous?.count) ? previous.count : 0;
    const count = previousCount + 1;
    seenErrors.set(errorHash, { ...(previous ?? {}), count });
    errorRepeat = Math.max(errorRepeat, count);
    if (seen.has(errorHash)) continue;
    seen.add(errorHash);
    errors.push({ errorHash, errorText: text, count });
  }

  const fact = {
    exitOk: results.every((result) => (
      result?.is_error !== true && result?.success !== false
    )),
  };
  if (errors.length > 0) {
    fact.errorHash = errors[0].errorHash;
    fact.errorText = errors[0].errorText;
    fact.errorRepeat = errorRepeat;
    fact.errorHashes = errors.map((error) => error.errorHash);
    fact.errorTexts = errors.map((error) => error.errorText);
    // 跨轮累计 count（含本轮），供 resume 精确重建 errorSeen
    fact.errorCounts = Object.fromEntries(
      errors.map((error) => [error.errorHash, error.count]),
    );
  }
  return fact;
}

export const extractL0Fact = extractL0Facts;
export const extractL0 = extractL0Facts;

/**
 * Parse and remove the inline L1 summary protocol.
 *
 * A malformed marker is intentionally downgraded to "missing": the model
 * response remains usable and objective L0 facts still drive governance.
 */
export function parseL1Summary(text) {
  const value = String(text ?? "");
  let summary = "missing";
  const markerPattern = /<erix-summary>([\s\S]*?)<\/erix-summary>/gi;
  const match = markerPattern.exec(value);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        summary = {
          action: String(parsed.action ?? "").slice(0, 500),
          note: String(parsed.note ?? "").slice(0, 500),
        };
      }
    } catch {
      // Missing is the documented fallback for malformed model output.
    }
  }
  return {
    summary,
    text: value.replace(markerPattern, ""),
  };
}

export const parseSummary = parseL1Summary;
export const parseReflectionSummary = parseL1Summary;
