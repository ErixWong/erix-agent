import { extractL0Facts } from "./l0.js";

const MAX_COMMAND_LENGTH = 60;
const MAX_OUTPUT_LENGTH = 200;

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (
      block?.text ?? block?.content ?? ""
    )).join("");
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

function truncate(value, length) {
  return Array.from(String(value ?? "")).slice(0, length).join("");
}

function summarizeArgument(name, input) {
  if (name === "exec") return truncate(input?.command, MAX_COMMAND_LENGTH);
  if (name === "writeFile" || name === "readFile") return truncate(input?.path, MAX_COMMAND_LENGTH);
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncate(input, MAX_COMMAND_LENGTH);
  try {
    return truncate(JSON.stringify(input), MAX_COMMAND_LENGTH);
  } catch {
    return "";
  }
}

function resultText(block) {
  return truncate(textFromContent(block?.content), MAX_OUTPUT_LENGTH);
}

function jsonCandidates(text) {
  const value = String(text ?? "");
  const candidates = [];
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
      if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(value.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

/**
 * Extract an objective, compact footprint from the messages added in a round.
 * Tool results are paired with their tool_use ids so verification output keeps
 * the command that produced it.
 */
export function buildTimeline(messages, roundStart = 0) {
  const selected = Array.isArray(messages)
    ? messages.slice(Math.max(0, Number.isSafeInteger(roundStart) ? roundStart : 0))
    : [];
  const toolCalls = [];
  const outputById = new Map();

  for (const message of selected) {
    for (const block of blocksFor(message?.content)) {
      if (block?.type === "tool_use") {
        toolCalls.push({
          name: String(block.name ?? ""),
          arg: summarizeArgument(block.name, block.input),
          _toolUseId: block.id,
        });
      } else if (block?.type === "tool_result") {
        if (block.tool_use_id !== undefined) {
          outputById.set(block.tool_use_id, resultText(block));
        }
      }
    }
  }

  // 按 tool_use_id 把输出内联到对应调用（多工具乱序/跨块不丢配对）
  const paired = toolCalls.map((call) => {
    const output = call._toolUseId !== undefined
      ? outputById.get(call._toolUseId)
      : undefined;
    const clean = { name: call.name, arg: call.arg };
    return output !== undefined
      ? { ...clean, output }
      : clean;
  });

  const l0facts = extractL0Facts(selected);
  return {
    toolCalls: paired,
    outputs: [],
    exitOk: l0facts.exitOk,
    errors: l0facts.errorTexts ?? [],
    errorRepeat: l0facts.errorRepeat ?? 0,
  };
}

function formatTimeline(timeline) {
  const entries = Array.isArray(timeline) ? timeline : [];
  const lines = [];
  for (const entry of entries) {
    const round = entry?.round ?? "?";
    for (const call of entry?.toolCalls ?? []) {
      const outputText = call?.output ? `; 输出: ${call.output}` : "";
      lines.push(`R${round}: ${call.name} ${call.arg}${outputText}`.trim());
    }
  }
  return lines.join("\n") || "（暂无工具足迹）";
}

function formatFiles(filesWritten) {
  if (Array.isArray(filesWritten)) {
    return filesWritten.map((file) => {
      if (file && typeof file === "object") {
        return `${file.path ?? file.name ?? ""}${file.round === undefined ? "" : `(R${file.round})`}`;
      }
      return String(file);
    }).filter(Boolean).join(", ") || "（无）";
  }
  return String(filesWritten ?? "（无）");
}

function formatErrors(recentErrors) {
  if (Array.isArray(recentErrors)) {
    return recentErrors.map((error) => {
      if (error && typeof error === "object") {
        return error.errorText ?? error.error ?? JSON.stringify(error);
      }
      return String(error);
    }).filter(Boolean).join("\n") || "无";
  }
  return String(recentErrors ?? "无");
}

/**
 * Build the independent judge's prompt from objective round footprints.
 */
export function buildJudgePrompt(
  taskBrief,
  rounds,
  timeline = [],
  filesWritten = [],
  recentErrors = [],
) {
  const entries = Array.isArray(timeline)
    ? timeline
    : timeline && typeof timeline === "object"
      ? [timeline]
      : [];
  const recent = entries.slice(-12).reverse();
  // 验证输出已内联到 toolCalls（buildTimeline 按 tool_use_id 配对）
  const outputLines = recent
    .flatMap((entry) => entry?.toolCalls ?? [])
    .filter((call) => call?.output)
    .map((call) => `${call.arg || call.name || "tool"} → ${call.output}`)
    .slice(0, 5)
    .join("\n");
  return `【每轮 Judge】你是交付评审者，独立判断任务是否完成。不要执行工具，不要相信模型自报。

任务目标：${String(taskBrief ?? "").slice(0, 500) || "（未提供）"}
已运行轮数：${Number.isFinite(rounds) ? rounds : 0}
时间线（最新在前）：
${formatTimeline(recent)}
写过的文件：${formatFiles(filesWritten)}
最近验证输出：
${outputLines || "无"}
最近错误：
${formatErrors(recentErrors)}

判断是否已经满足原始任务目标。若方向错误、关键产物缺失或验证输出不符合目标，done 必须为 false。
只输出 JSON，不要输出其他文字：
{"done":true|false,"confidence":0-1,"reason":"一句话","evidence":"支撑事实"}`;
}

/**
 * Parse a judge response while tolerating code fences and incidental prose.
 */
export function parseJudgeDecision(text) {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (typeof parsed.done !== "boolean") continue;
      if (!Number.isFinite(parsed.confidence)
        || parsed.confidence < 0
        || parsed.confidence > 1) continue;
      if (parsed.reason !== undefined && typeof parsed.reason !== "string") continue;
      if (parsed.evidence !== undefined && typeof parsed.evidence !== "string") continue;
      return {
        done: parsed.done,
        confidence: parsed.confidence,
        reason: String(parsed.reason ?? ""),
        evidence: String(parsed.evidence ?? ""),
      };
    } catch {
      // Try the next balanced object in surrounding provider text.
    }
  }
  return null;
}
