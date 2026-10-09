import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_COMPACTION_STRATEGIES,
  BUILTIN_COMPACTION_STRATEGY_NAMES,
  isBuiltinCompactionStrategyName,
  resolveCompactionStrategy,
} from "../../src/compact/strategy-resolution.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";

test("all three built-in strategy names resolve to usable instances", () => {
  assert.deepEqual(BUILTIN_COMPACTION_STRATEGY_NAMES, [
    "sliding-window",
    "fold-statistical",
    "fold-llm",
  ]);

  const expectedFactories = {
    "sliding-window": createSlidingWindowStrategy,
    "fold-statistical": createFoldStatisticalStrategy,
    "fold-llm": createFoldLlmStrategy,
  };
  assert.deepEqual(
    Object.keys(BUILTIN_COMPACTION_STRATEGIES),
    BUILTIN_COMPACTION_STRATEGY_NAMES,
  );
  for (const [name, factory] of Object.entries(expectedFactories)) {
    assert.equal(BUILTIN_COMPACTION_STRATEGIES[name], factory);
    const strategy = name === "fold-llm"
      ? resolveCompactionStrategy(name, { foldLlmOptions: { summarizer: () => "s" } })
      : resolveCompactionStrategy(name);
    assert.equal(strategy.name, name);
    assert.equal(typeof strategy.shouldCompact, "function");
    assert.equal(typeof strategy.compact, "function");
  }
});

test("name lookup tolerates surrounding whitespace and is case-sensitive", () => {
  assert.equal(resolveCompactionStrategy("  fold-statistical  ").name, "fold-statistical");
  assert.equal(isBuiltinCompactionStrategyName(" sliding-window "), true);
  assert.equal(isBuiltinCompactionStrategyName("Fold-Statistical"), false);
});

test("unknown names throw a startup TypeError listing the legal values", () => {
  for (const value of ["folding", "", "   ", "psyche"]) {
    assert.throws(
      () => resolveCompactionStrategy(value),
      (error) => {
        assert.ok(error instanceof TypeError, `${value} must reject with TypeError`);
        assert.match(error.message, /sliding-window \| fold-statistical \| fold-llm/u);
        return true;
      },
      value,
    );
  }
});

test("non-string, non-object strategies throw the same TypeError", () => {
  for (const value of [42, true, () => ({ compact: () => {} }), Symbol("s")]) {
    assert.throws(
      () => resolveCompactionStrategy(value),
      { name: "TypeError" },
      String(value),
    );
  }
  assert.throws(() => resolveCompactionStrategy(7), /received number/u);
  assert.throws(() => resolveCompactionStrategy(() => {}), /received function/u);
});

test("object strategies pass through by identity and undefined/null stay unset", () => {
  const strategy = createFoldStatisticalStrategy();
  assert.equal(resolveCompactionStrategy(strategy), strategy);
  // Arrays are objects too: the pre-#167 behaviour (fail later on shouldCompact) is kept.
  const list = [];
  assert.equal(resolveCompactionStrategy(list), list);
  assert.equal(resolveCompactionStrategy(undefined), undefined);
  assert.equal(resolveCompactionStrategy(null), null);
});

test("an object-built fold-llm without a summarizer keeps its constructor error", () => {
  // 注入形式是覆盖通道：引擎不得替宿主把缺 summarizer 的对象"修好"。
  assert.throws(() => resolveCompactionStrategy(createFoldLlmStrategy({})), {
    name: "TypeError",
    message: /summarizer must be a function/u,
  });
  assert.throws(
    () => resolveCompactionStrategy("fold-llm"),
    { name: "TypeError", message: /summarizer must be a function/u },
  );
});

test("name resolution forwards context-level factory options", async () => {
  const strategy = resolveCompactionStrategy("fold-statistical", {
    options: { recoveryHint: "归档在 judge.log", keepRounds: 0 },
  });
  assert.equal(strategy.name, "fold-statistical");

  const rounds = [];
  for (let round = 1; round <= 4; round += 1) {
    rounds.push({ role: "user", content: `task ${round} ${"u".repeat(200)}` });
    rounds.push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${round} ${"a".repeat(200)}` }],
    });
  }
  const result = await strategy.compact(rounds, { keepRounds: 0 });
  assert.ok(result.compacted);
  const summary = JSON.stringify(result.messages);
  assert.match(summary, /归档在 judge\.log/u);
});

test("fold-llm name resolution injects the engine summarizer", async () => {
  const seen = [];
  const strategy = resolveCompactionStrategy("fold-llm", {
    foldLlmOptions: {
      summarizer: async (input) => {
        seen.push(input);
        return "## 阶段\ninjected";
      },
    },
  });
  const result = await strategy.compact([
    { role: "user", content: `old task ${"u".repeat(400)}` },
    { role: "assistant", content: [{ type: "text", text: `old answer ${"a".repeat(400)}` }] },
  ], { keepRounds: 0 });

  assert.equal(result.compacted, true);
  assert.equal(seen.length, 1);
  assert.match(JSON.stringify(result.messages), /injected/u);
  assert.deepEqual(seen[0].roundRange, { from: 1, to: 1 });
  assert.ok(Array.isArray(seen[0].messages));
  assert.match(seen[0].promptGuide, /## 主题词面包屑/u);
});
