function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function normalizedWrapup(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // Keep the legacy inline L1 summary object on its existing parsing path.
  if (value.action !== undefined || value.note !== undefined) return null;
  // Require at least one protocol key — arbitrary JSON objects in prose must
  // not be mistaken for a wrap-up marker (e.g. "配置应为 {"timeout":30}").
  if (
    value.done === undefined
    && value.summary === undefined
    && value.output === undefined
  ) return null;
  if (value.done !== undefined && typeof value.done !== "boolean") return null;
  if (value.summary !== undefined && typeof value.summary !== "string") return null;
  if (value.output !== undefined && typeof value.output !== "string") return null;
  return {
    done: value.done ?? false,
    summary: value.summary ?? "",
    output: value.output ?? "",
  };
}

function* jsonCandidates(text) {
  const value = String(text ?? "");
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          yield value.slice(start, index + 1);
          break;
        }
      }
    }
  }
}

/**
 * Parse the end-of-turn JSON protocol while tolerating markdown fences and
 * incidental text around the first JSON object.
 */
export function tryParseWrapupJson(text) {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = normalizedWrapup(JSON.parse(candidate));
      if (parsed !== null) return parsed;
    } catch {
      // Try the next balanced object when surrounding text contains braces.
    }
  }
  return null;
}

const WRAPUP_NORMALIZATION_PROMPT = `请把下面模型的最终文本归一化为结束协议 JSON。
只输出 JSON，不要输出其他文字：
{"done":true|false,"summary":"任务总结或当前进展","output":"给用户的最终结果"}
如果原文表示任务已完成，done 为 true；否则为 false。缺少最终结果时 output 使用空字符串。

原始文本：
`;

/**
 * Ask an evaluator to normalize a non-conforming end-of-turn response.
 * The loop may use this as an optional, low-frequency fallback.
 */
export async function normalizeWrapupWithLlm(
  text,
  evaluator,
  { signal, maxTokens, temperature } = {},
) {
  const request = {
    system: "你是输出协议归一化器，只输出有效 JSON。",
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: `${WRAPUP_NORMALIZATION_PROMPT}${String(text ?? "")}`,
      }],
    }],
  };
  if (signal !== undefined) request.signal = signal;
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  if (temperature !== undefined) request.temperature = temperature;
  const response = typeof evaluator === "function"
    ? await evaluator(request)
    : await evaluator.chat(request);
  return tryParseWrapupJson(textFromBlocks(blocksFor(response?.content)));
}
