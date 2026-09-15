// Shared OpenAI-compatible protocol normalization primitives.

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
 * @returns {{input_tokens?:number, output_tokens?:number}|undefined}
 */
export function normalizeOpenAIUsage(usage) {
  if (!isRecord(usage)) return undefined;

  const normalized = {};
  const inputTokens = usage.input_tokens !== undefined
    ? usage.input_tokens
    : usage.prompt_tokens;
  const outputTokens = usage.output_tokens !== undefined
    ? usage.output_tokens
    : usage.completion_tokens;
  if (inputTokens !== undefined) normalized.input_tokens = inputTokens;
  if (outputTokens !== undefined) normalized.output_tokens = outputTokens;
  return Object.keys(normalized).length === 0 ? undefined : normalized;
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
 * @param {unknown} rawArguments
 * @returns {any}
 */
export function parseOpenAIToolArguments(rawArguments) {
  const value = rawArguments === undefined ? "{}" : rawArguments;
  try {
    return JSON.parse(value);
  } catch {
    return {
      _truncatedArguments: value,
      _raw: value,
    };
  }
}

function argumentFragment(value) {
  return value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : String(value);
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
    if (parts.name !== undefined) slot.name = String(parts.name);
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
      .map((slot) => (slot ? {
        type: "tool_use",
        id: slot.id,
        name: slot.name,
        input: parseOpenAIToolArguments(slot.arguments),
      } : undefined))
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
