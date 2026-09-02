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
export function extractL0Facts(messages) {
  const results = (Array.isArray(messages) ? messages : []).flatMap((message) => (
    blocksFor(message?.content).filter((block) => block?.type === "tool_result")
  ));
  const errors = [];
  const seen = new Set();
  for (const result of results) {
    const isError = result?.is_error === true || result?.success === false;
    if (!isError) continue;
    const fullText = resultText(result.content);
    const text = fullText.slice(0, 500);
    const errorHash = hashError(fullText);
    if (seen.has(errorHash)) continue;
    seen.add(errorHash);
    errors.push({ errorHash, errorText: text });
  }

  const fact = {
    exitOk: results.every((result) => (
      result?.is_error !== true && result?.success !== false
    )),
  };
  if (errors.length > 0) {
    fact.errorHash = errors[0].errorHash;
    fact.errorText = errors[0].errorText;
    fact.errorHashes = errors.map((error) => error.errorHash);
    fact.errorTexts = errors.map((error) => error.errorText);
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
