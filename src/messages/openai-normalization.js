// Shared OpenAI-compatible protocol normalization primitives.

import { parseToolArguments } from "./tool-arguments.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Normalize OpenAI usage fields to canonical token names.
 *
 * @param {object|undefined|null} usage
 * @returns {{input_tokens?:number, output_tokens?:number, cacheRead?:number}|undefined}
 */
export function normalizeOpenAIUsage(usage) {
  if (usage == null) return undefined;

  const normalized = {};
  if (usage.prompt_tokens !== undefined) {
    normalized.input_tokens = usage.prompt_tokens;
  }
  if (usage.completion_tokens !== undefined) {
    normalized.output_tokens = usage.completion_tokens;
  }
  if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
    normalized.cacheRead = usage.prompt_tokens_details.cached_tokens;
  }
  return normalized;
}

/**
 * Map OpenAI finish reasons to canonical stop reasons.
 *
 * @param {string|null|undefined} reason
 * @param {string} [fallback="unknown"]
 * @returns {string}
 */
export function normalizeOpenAIStopReason(reason, fallback = "unknown") {
  if (reason == null) return fallback;
  return {
    stop: "end_turn",
    tool_calls: "tool_use",
    tool_use: "tool_use",
    function_call: "tool_use",
    length: "max_tokens",
  }[reason] ?? reason;
}

/**
 * Parse an OpenAI tool-call arguments value without losing malformed input.
 *
 * issue #409：解析走共享入口 `parseToolArguments`（`src/messages/tool-arguments.js`）——
 * 先 L0（原文 `JSON.parse`），再 L1 确定性修复（非法转义加倍 / 尾逗号 / 单引号与裸键 /
 * Python 字面量；截断补全默认关），修不出来才落那个假对象。**本函数的返回形状没变**：
 * 能解析就是解析结果，不能解析就是 `{_truncatedArguments, _raw}`（判词挂在 `tool_use` 块的
 * `erix.argumentsParseError` 上，不塞进 `input`）。
 *
 * @param {unknown} rawArguments
 * @returns {any}
 */
export function parseOpenAIToolArguments(rawArguments) {
  return parseToolArguments(rawArguments).input;
}

function argumentFragment(value) {
  return String(value);
}

function toolCallParts(value) {
  if (!isRecord(value)) return undefined;

  const functionPart = isRecord(value.function) ? value.function : undefined;
  const name = value.name ?? functionPart?.name;
  let argumentsValue;
  let hasArguments = false;
  for (const source of [value, functionPart]) {
    if (!source) continue;
    for (const key of ["argumentsDelta", "arguments"]) {
      if (hasOwn(source, key) && source[key] !== undefined) {
        argumentsValue = source[key];
        hasArguments = true;
        break;
      }
    }
    if (hasArguments) break;
  }
  if (!hasArguments && hasOwn(value, "input")) {
    argumentsValue = JSON.stringify(value.input ?? {});
    hasArguments = true;
  }

  return {
    index: value.index,
    id: value.id,
    name,
    argumentsValue,
    hasArguments,
  };
}

/**
 * Create a stateful accumulator for OpenAI-compatible streamed tool-call
 * deltas. It accepts both OpenAI `{function: {arguments}}` deltas and the
 * canonical callback form `{argumentsDelta}`.
 *
 * @returns {{
 *   addToolCallDelta: (delta: object, fallbackIndex?: number) => object|undefined,
 *   addToolCallDeltas: (deltas: object|object[]) => object[],
 *   addFunctionCallDelta: (delta: object) => object|undefined,
 *   getToolCalls: () => object[],
 *   getToolUseBlocks: () => object[],
 * }}
 */
export function createOpenAIStreamAccumulator() {
  const slots = [];

  function addToolCallDelta(value, fallbackIndex = slots.length) {
    const parts = toolCallParts(value);
    if (!parts) return undefined;

    const requestedIndex = Number(parts.index);
    const index = Number.isInteger(requestedIndex) && requestedIndex >= 0
      ? requestedIndex
      : fallbackIndex;
    const slot = slots[index] ?? {
      id: undefined,
      name: undefined,
      arguments: undefined,
    };
    slots[index] = slot;

    if (parts.id !== undefined) slot.id = parts.id;
    if (parts.name !== undefined) slot.name = parts.name;
    if (parts.hasArguments) {
      slot.arguments = `${slot.arguments ?? ""}${argumentFragment(parts.argumentsValue)}`;
    }

    return {
      index,
      ...(slot.id === undefined ? {} : { id: slot.id }),
      ...(parts.name === undefined ? {} : { name: String(parts.name) }),
      ...(parts.hasArguments
        ? { argumentsDelta: argumentFragment(parts.argumentsValue) }
        : {}),
    };
  }

  function addToolCallDeltas(value) {
    const deltas = Array.isArray(value) ? value : [value];
    const fragments = [];
    for (const delta of deltas) {
      const fragment = addToolCallDelta(delta);
      if (fragment) fragments.push(fragment);
    }
    return fragments;
  }

  function addFunctionCallDelta(value) {
    if (!isRecord(value)) return undefined;
    return addToolCallDelta({
      index: 0,
      id: slots[0]?.id ?? "call_legacy",
      name: value.name,
      argumentsDelta: value.arguments,
    });
  }

  function getToolCalls() {
    return slots
      .map((slot, index) => (slot ? {
        index,
        ...(slot.id === undefined ? {} : { id: slot.id }),
        ...(slot.name === undefined ? {} : { name: slot.name }),
        ...(slot.arguments === undefined ? {} : { arguments: slot.arguments }),
      } : undefined))
      .filter(Boolean);
  }

  function getToolUseBlocks() {
    return slots
      .map((slot) => {
        if (!slot) return undefined;
        const { input, parseError } = parseToolArguments(slot.arguments);
        return {
          type: "tool_use",
          id: slot.id,
          name: slot.name,
          input,
          // issue #409：判词挂在块上（additive 可选键），执行层据它决定「不执行这个工具」。
          ...(parseError === undefined ? {} : { erix: { argumentsParseError: parseError } }),
        };
      })
      .filter(Boolean);
  }

  return {
    addToolCallDelta,
    addToolCallDeltas,
    addFunctionCallDelta,
    getToolCalls,
    getToolUseBlocks,
  };
}
