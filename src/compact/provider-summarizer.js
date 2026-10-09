import { SUMMARIZER_PROMPT_GUIDE } from "./fold-llm.js";

const DEFAULT_SUMMARY_SYSTEM = "你是对话历史压缩器。只输出摘要正文，不要调用工具，不要寒暄。";

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" || block.type === "thinking" || block.type === "reasoning") {
      const text = [block.text, block.thinking, block.reasoning_content]
        .filter((value) => typeof value === "string" && value !== "")
        .join("\n");
      if (text !== "") parts.push(text);
      continue;
    }
    if (block.type === "tool_use") {
      parts.push(`[tool_use ${String(block.name ?? "?")}] ${stringifyInput(block.input)}`);
      continue;
    }
    if (block.type === "tool_result") {
      const inner = textOfContent(block.content);
      parts.push(`[tool_result] ${inner}`);
      continue;
    }
    if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function stringifyInput(input) {
  if (typeof input === "string") return input;
  if (input === undefined || input === null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function roundRangeLabel(roundRange) {
  if (roundRange === undefined || roundRange === null) return "（未知）";
  return `第 ${roundRange.from ?? "?"} 轮 - 第 ${roundRange.to ?? "?"} 轮`;
}

/**
 * Deterministically serialize the folded payload for a summarizing completion.
 * Input size is bounded by what was already in context, so no truncation is applied.
 */
export function serializeFoldedMessages(messages, roundRange) {
  const lines = [`【被折叠的轮次】${roundRangeLabel(roundRange)}`, "【被折叠的消息】"];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === "string" ? message.role : "unknown";
    const body = textOfContent(message?.content);
    lines.push(`[${role}]`, body === "" ? "（空）" : body);
  }
  return lines.join("\n");
}

/**
 * Default `fold-llm` summarizer backed by the run's own provider (issue #167 方案 C).
 *
 * One tool-free completion per compaction: input = summarizer prompt guide + serialized
 * folded messages + round range; output text becomes the summary. Any thrown/rejected
 * error falls through to the pre-existing statistical-summary degradation in
 * `createFoldLlmStrategy`, so a run never dies because the summary call failed.
 *
 * Usage accounting belongs to the caller-supplied `chat` (the engine merges it into the
 * run ledger); `onUsage` is only the host-visible notification.
 *
 * @param {{
 *   chat: (request: { system: string, messages: object[] }) => Promise<object>|object,
 *   onUsage?: (usage: object) => void,
 *   system?: string,
 *   promptGuide?: string,
 * }} config
 * @returns {(input: { messages?: object[], roundRange?: object, promptGuide?: string }) => Promise<string>}
 */
export function createProviderSummarizer({
  chat,
  onUsage,
  system = DEFAULT_SUMMARY_SYSTEM,
  promptGuide = SUMMARIZER_PROMPT_GUIDE,
} = {}) {
  if (typeof chat !== "function") {
    throw new TypeError("createProviderSummarizer requires a chat(request) function");
  }
  return async ({ messages = [], roundRange, promptGuide: perCallGuide } = {}) => {
    const request = {
      system,
      messages: [{
        role: "user",
        content: `${perCallGuide ?? promptGuide}\n\n${serializeFoldedMessages(messages, roundRange)}`,
      }],
    };
    const response = await chat(request);
    const usage = response?.usage;
    if (usage !== undefined && typeof onUsage === "function") {
      try {
        onUsage(usage);
      } catch {
        // Observer failures must not affect compaction.
      }
    }
    const summary = textOfContent(response?.content).trim();
    if (summary === "") {
      throw new TypeError("default fold-llm summarizer returned no text");
    }
    return summary;
  };
}
