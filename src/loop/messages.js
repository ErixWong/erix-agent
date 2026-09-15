import { cloneState } from "./budget.js";
import { blocksFor } from "./block-helpers.js";

export { blocksFor };

export function mergeToolResultsIntoMessages(messages, toolResults) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return false;

  let assistantIndex = -1;
  let assistantUses;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const uses = blocksFor(message?.content)
      .filter((block) => block?.type === "tool_use");
    if (message?.role === "assistant" && uses.length > 0) {
      assistantIndex = index;
      assistantUses = uses;
      break;
    }
  }
  if (assistantIndex < 0) return false;

  const target = messages[assistantIndex + 1];
  const existingBlocks = blocksFor(target?.content);
  const existingResults = existingBlocks
    .filter((block) => block?.type === "tool_result");
  if (target?.role !== "user" || existingResults.length === 0) return false;

  const expectedIds = new Set(assistantUses.map((block) => block.id));
  if (existingResults.some((block) => !expectedIds.has(block.tool_use_id))
    || toolResults.some((block) => !expectedIds.has(block?.tool_use_id))) {
    return false;
  }

  const existingIds = new Set(existingResults.map((block) => block.tool_use_id));
  const additions = toolResults.filter((block) => !existingIds.has(block.tool_use_id));
  target.content = [...existingBlocks, ...cloneState(additions)];
  return target;
}

export function textFromBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

export function textFromUserMessage(message) {
  return textFromBlocks(blocksFor(message?.content));
}

export function toolResultContent(result) {
  return typeof result === "string" ? result : String(result);
}

export function toolResultData(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "data")
    ? value
    : undefined;
}

export function normalizeMessages(messages) {
  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (previous?.role !== "assistant" || current?.role !== "assistant") continue;

    messages[index - 1] = {
      ...previous,
      content: [
        ...blocksFor(previous.content),
        ...blocksFor(current.content),
      ],
    };
    messages.splice(index, 1);
    index -= 1;
  }
  return messages;
}

export function appendAssistantContent(existing, continuation) {
  const combined = blocksFor(existing).map((block) => ({ ...block }));
  for (const block of continuation) {
    const previous = combined.at(-1);
    if (block?.type === "text" && previous?.type === "text") {
      previous.text = `${String(previous.text ?? "")}${String(block.text ?? "")}`;
    } else {
      combined.push(block);
    }
  }
  return combined;
}

export function hasToolUse(content) {
  return content.some((block) => block?.type === "tool_use");
}

export function hasToolUseInMessages(messages) {
  return messages.some((message) => hasToolUse(blocksFor(message?.content)));
}

export function hasSuccessfulToolResult(messages) {
  return messages.some((message) => blocksFor(message?.content).some((block) => (
    block?.type === "tool_result"
      && block?.is_error !== true
      && block?.success !== false
  )));
}
