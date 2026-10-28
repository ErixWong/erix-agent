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
    // issue #409（6b604e7，2026-10-23）**晚于本脚本的冻结参照**（919eeca，2026-09-16）：
    // `getToolUseBlocks` 现在把引数解析判词挂在 `tool_use.erix.argumentsParseError` 上（additive
    // 可选键，执行层 `run-snapshot-executor` 据它决定「不执行这个工具」，契约面因此多了
    // `executionStatus: "rejected"`）。`legacyAccumulator` 是本脚本手抄的 **#409 之前**那一份，
    // 它不可能凭空长出这个键 ⇒ 这一格的 `blocks[].erix` 是**有意**不同，不是回归。
    // 钉法（比原断言更强，不是放宽）：`fragment` / `calls` / `blocks` 除 `erix` 外仍**逐字节**
    // 相同，另外把判词按字面量逐字钉住——判词消失、`reason` 变、`text` 变、`message` 不再
    // 是字符串都当场红。
    documentedDelta: ({ current, legacy }) => {
      assert.equal(serialize(current.fragment), serialize(legacy.fragment),
        "accumulator-object-arguments: fragment 必须逐字节相同");
      assert.equal(serialize(current.calls), serialize(legacy.calls),
        "accumulator-object-arguments: calls 必须逐字节相同");
      const [currentBlock] = current.blocks;
      const [legacyBlock] = legacy.blocks;
      assert.ok(currentBlock?.erix?.argumentsParseError !== undefined,
        "accumulator-object-arguments: #409 判词不见了（blocks[].erix.argumentsParseError）");
      const { erix, ...currentWithoutErix } = currentBlock;
      assert.equal(serialize(currentWithoutErix), serialize(legacyBlock),
        "accumulator-object-arguments: 除 erix 外 blocks 必须逐字节相同（#409 只加了这一个键）");
      assert.deepEqual(erix, {
        argumentsParseError: {
          reason: "unparsable",
          message: erix.argumentsParseError.message,
          text: "[object Object]",
        },
      }, "accumulator-object-arguments: #409 判词形状变了");
      assert.equal(typeof erix.argumentsParseError.message, "string",
        "accumulator-object-arguments: 判词里的解析器原话必须是字符串");
      assert.ok(erix.argumentsParseError.message.includes("[object Object]"),
        `accumulator-object-arguments: 判词里没带出错的那段文本（实测 ${JSON.stringify(erix.argumentsParseError.message)}）`);
    },
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
  const legacyValue = fixture.legacy();
  const currentValue = fixture.current();
  const legacy = serialize(legacyValue);
  const current = serialize(currentValue);
  if (fixture.documentedDelta === undefined) {
    assert.equal(current, legacy, `${fixture.name} differs`);
    process.stdout.write(`${fixture.name}: ${legacy} === ${current}\n`);
    continue;
  }
  // 有已登记的有意差异：除了登记的那一面之外仍然逐字节比对，登记面按字面量钉死。
  fixture.documentedDelta({ current: currentValue, legacy: legacyValue });
  process.stdout.write(`${fixture.name}: parity outside the documented #409 delta + delta pinned\n`);
}

const deltaCount = fixtures.filter((fixture) => fixture.documentedDelta !== undefined).length;
process.stdout.write(`PASS: ${fixtures.length}/${fixtures.length} fixtures compared`
  + ` (${fixtures.length - deltaCount} byte-identical, ${deltaCount} with a documented #409 delta)\n`);
