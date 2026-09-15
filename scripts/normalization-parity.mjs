import assert from "node:assert/strict";
import {
  createOpenAIStreamAccumulator,
  normalizeOpenAIUsage,
  parseOpenAIToolArguments,
} from "../src/index.js";

function legacyNormalizeUsage(usage) {
  if (usage == null) return undefined;
  const normalized = {};
  if (usage.prompt_tokens !== undefined) {
    normalized.input_tokens = usage.prompt_tokens;
  }
  if (usage.completion_tokens !== undefined) {
    normalized.output_tokens = usage.completion_tokens;
  }
  return normalized;
}

function legacyParseToolArguments(rawArguments) {
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

function legacyAccumulator() {
  const slots = [];

  function addToolCallDelta(value, fallbackIndex = slots.length) {
    if (value === null || typeof value !== "object") return undefined;
    const requestedIndex = Number(value.index);
    const index = Number.isInteger(requestedIndex) && requestedIndex >= 0
      ? requestedIndex
      : fallbackIndex;
    const slot = slots[index] ?? {
      id: undefined,
      name: undefined,
      arguments: undefined,
    };
    slots[index] = slot;

    if (value.id !== undefined) slot.id = value.id;
    const functionPart = value.function;
    if (functionPart && typeof functionPart === "object") {
      if (functionPart.name !== undefined) slot.name = functionPart.name;
      if (functionPart.arguments !== undefined) {
        slot.arguments = `${slot.arguments ?? ""}${String(functionPart.arguments)}`;
      }
    }

    return {
      index,
      ...(slot.id === undefined ? {} : { id: slot.id }),
      ...(!functionPart || functionPart.name === undefined
        ? {}
        : { name: String(functionPart.name) }),
      ...(!functionPart || functionPart.arguments === undefined
        ? {}
        : { argumentsDelta: String(functionPart.arguments) }),
    };
  }

  function addFunctionCallDelta(value) {
    if (value === null || typeof value !== "object") return undefined;
    return addToolCallDelta({
      index: 0,
      id: slots[0]?.id ?? "call_legacy",
      function: value,
    });
  }

  return {
    addToolCallDelta,
    addFunctionCallDelta,
    getToolCalls() {
      return slots
        .map((slot, index) => (slot ? {
          index,
          ...(slot.id === undefined ? {} : { id: slot.id }),
          ...(slot.name === undefined ? {} : { name: slot.name }),
          ...(slot.arguments === undefined ? {} : { arguments: slot.arguments }),
        } : undefined))
        .filter(Boolean);
    },
    getToolUseBlocks() {
      return slots
        .map((slot) => (slot ? {
          type: "tool_use",
          id: slot.id,
          name: slot.name,
          input: legacyParseToolArguments(slot.arguments),
        } : undefined))
        .filter(Boolean);
    },
  };
}

function serialize(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

const fixtures = [
  {
    name: "usage-empty-object",
    legacy: () => legacyNormalizeUsage({}),
    current: () => normalizeOpenAIUsage({}),
  },
  {
    name: "usage-array",
    legacy: () => legacyNormalizeUsage([]),
    current: () => normalizeOpenAIUsage([]),
  },
  {
    name: "usage-string",
    legacy: () => legacyNormalizeUsage("prompt_tokens"),
    current: () => normalizeOpenAIUsage("prompt_tokens"),
  },
  {
    name: "usage-canonical-fields-only",
    legacy: () => legacyNormalizeUsage({ input_tokens: 3, output_tokens: 4 }),
    current: () => normalizeOpenAIUsage({ input_tokens: 3, output_tokens: 4 }),
  },
  {
    name: "usage-prompt-tokens",
    legacy: () => legacyNormalizeUsage({ prompt_tokens: 12, completion_tokens: 7 }),
    current: () => normalizeOpenAIUsage({ prompt_tokens: 12, completion_tokens: 7 }),
  },
  {
    name: "accumulator-object-arguments",
    legacy: () => {
      const accumulator = legacyAccumulator();
      return {
        fragment: accumulator.addToolCallDelta({
          index: 0,
          id: "call_object",
          function: { arguments: { a: 1 } },
        }),
        calls: accumulator.getToolCalls(),
        blocks: accumulator.getToolUseBlocks(),
      };
    },
    current: () => {
      const accumulator = createOpenAIStreamAccumulator();
      return {
        fragment: accumulator.addToolCallDelta({
          index: 0,
          id: "call_object",
          function: { arguments: { a: 1 } },
        }),
        calls: accumulator.getToolCalls(),
        blocks: accumulator.getToolUseBlocks(),
      };
    },
  },
  {
    name: "accumulator-numeric-name",
    legacy: () => {
      const accumulator = legacyAccumulator();
      accumulator.addToolCallDelta({
        index: 0,
        function: { name: 42 },
      });
      return {
        calls: accumulator.getToolCalls(),
        blocks: accumulator.getToolUseBlocks(),
      };
    },
    current: () => {
      const accumulator = createOpenAIStreamAccumulator();
      accumulator.addToolCallDelta({
        index: 0,
        function: { name: 42 },
      });
      return {
        calls: accumulator.getToolCalls(),
        blocks: accumulator.getToolUseBlocks(),
      };
    },
  },
  {
    name: "accumulator-cross-fragment",
    legacy: () => {
      const accumulator = legacyAccumulator();
      accumulator.addToolCallDelta({
        index: 0,
        function: { arguments: '{"city":' },
      });
      accumulator.addToolCallDelta({
        index: 0,
        function: { arguments: '"Paris"}' },
      });
      return accumulator.getToolUseBlocks();
    },
    current: () => {
      const accumulator = createOpenAIStreamAccumulator();
      accumulator.addToolCallDelta({
        index: 0,
        function: { arguments: '{"city":' },
      });
      accumulator.addToolCallDelta({
        index: 0,
        function: { arguments: '"Paris"}' },
      });
      return accumulator.getToolUseBlocks();
    },
  },
  {
    name: "invalid-json",
    legacy: () => legacyParseToolArguments('{"city":'),
    current: () => parseOpenAIToolArguments('{"city":'),
  },
  {
    name: "legacy-function-call",
    legacy: () => {
      const accumulator = legacyAccumulator();
      return {
        fragment: accumulator.addFunctionCallDelta({
          name: "lookup",
          arguments: "{}",
        }),
        calls: accumulator.getToolCalls(),
        blocks: accumulator.getToolUseBlocks(),
      };
    },
    current: () => {
      const accumulator = createOpenAIStreamAccumulator();
      return {
        fragment: accumulator.addFunctionCallDelta({
          name: "lookup",
          arguments: "{}",
        }),
        calls: accumulator.getToolCalls(),
        blocks: accumulator.getToolUseBlocks(),
      };
    },
  },
];

for (const fixture of fixtures) {
  const legacy = serialize(fixture.legacy());
  const current = serialize(fixture.current());
  assert.equal(current, legacy, `${fixture.name} differs`);
  process.stdout.write(`${fixture.name}: ${legacy} === ${current}\n`);
}

process.stdout.write(`PASS: ${fixtures.length}/${fixtures.length} fixtures byte-identical\n`);
