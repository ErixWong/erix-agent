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

/**
 * issue #421：按**调用方点名的 assistant**（下标）把 `tool_result` 合进它紧接的那条 user 消息。
 *
 * 为什么需要第二个入口（而不是把上面那个改宽）：上面那个的定位是「从后往前找**最后一条**带
 * `tool_use` 的 assistant」—— 那是**尾部**定位（`appendToolResultsToTranscript` / 续跑复放用它，
 * 语义正确且一个字都不动）。中段场景（issue #421：账本里一条较早的 assistant 缺结果）用它就会
 * 合到**错的那条**消息上；两条 assistant 相邻（各带一单）时它还会直接返回 `false`。所以这里把
 * 「定位」和「合并」拆开：定位由调用方点名，合并规则与上面那个逐条同源。
 *
 * 判据（与上面那个同形，一处也没有放宽）：
 *   · 目标下标必须真的是一条带 `tool_use` 的 assistant，且紧跟一条 `user` 消息；
 *   · 那条 user 消息必须**已经有**至少一条 `tool_result`（否则要么是「需要在中间插一条消息」的
 *     形状，要么根本不是聚合消息——两种都不在合并入口的职责里）；
 *   · 已有的结果与要并进去的结果，id 都必须是这条 assistant 的 `tool_use` id（不允许把别人的结果
 *     塞进来，也不允许在一条已经串味的消息上继续加工）；
 *   · 已经在场的结果不重复追加（按 id 去重），一条新增都没有 ⇒ 返回 `false`（没合并任何东西）。
 *
 * @param {any[]} messages
 * @param {number} assistantIndex 目标 assistant 在 `messages` 里的下标
 * @param {object[]} toolResults 要并进去的 `tool_result` 块
 * @returns {false | object} `false` = 没合并；否则是那条被就地改写的 user 消息
 */
export function mergeToolResultsIntoAssistantNextMessage(messages, assistantIndex, toolResults) {
  if (!Array.isArray(messages)) return false;
  if (!Array.isArray(toolResults) || toolResults.length === 0) return false;
  if (!Number.isInteger(assistantIndex) || assistantIndex < 0) return false;
  const assistant = messages[assistantIndex];
  if (assistant?.role !== "assistant") return false;
  const assistantUses = blocksFor(assistant.content)
    .filter((block) => block?.type === "tool_use");
  if (assistantUses.length === 0) return false;

  const target = messages[assistantIndex + 1];
  if (target?.role !== "user") return false;
  const existingBlocks = blocksFor(target.content);
  const existingResults = existingBlocks
    .filter((block) => block?.type === "tool_result");
  if (existingResults.length === 0) return false;

  const expectedIds = new Set(assistantUses.map((block) => block.id));
  if (existingResults.some((block) => !expectedIds.has(block.tool_use_id))
    || toolResults.some((block) => !expectedIds.has(block?.tool_use_id))) {
    return false;
  }

  const existingIds = new Set(existingResults.map((block) => block.tool_use_id));
  const additions = toolResults.filter((block) => !existingIds.has(block.tool_use_id));
  if (additions.length === 0) return false;
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
  if (typeof result === "string") return result;
  // 非字符串结果（裸对象/数组路径）：结构化序列化为可读的 JSON 文本；
  // 循环引用等 stringify 失败场景回退 String()（issue #65）。
  // 注意：{ data, content } 结构化结果由 run-snapshot-executor 前置拆解，
  // 落入这里的裸对象不含该协议形态，序列化它们不会遮蔽 data 通道。
  try {
    const serialized = JSON.stringify(result, null, 2);
    if (typeof serialized === "string") return serialized;
  } catch {
    // stringify 失败（循环引用等）→ 回退 String()
  }
  return String(result);
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
      // 读路径（工单 261014 T2）：成败住在 `erix.success`，顶层旧同名键只作旧记录回退。
      && (block?.erix?.success ?? block?.success) !== false
  )));
}
