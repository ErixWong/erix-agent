import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveCompactionStrategy,
} from "../../src/compact/strategy-resolution.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";

// issue #261127-12：折叠策略的**名字形态已删除**。`context.strategy` 只接受策略对象；
// `undefined` / `null` ⇒ 引擎内置 fold-llm（永不为空）；名字/标量 ⇒ 启动期 TypeError。
// 旧的 `BUILTIN_COMPACTION_STRATEGIES` / `BUILTIN_COMPACTION_STRATEGY_NAMES` /
// `isBuiltinCompactionStrategyName` 三个导出随名字形态一并删除（BREAKING）——本文件从入口
// 形状的角度钉住「它们不在了」（判据 6）。

test("the name-form public exports are gone from the entry surface (issue #261127-12, BREAKING)", async () => {
  // 判据 6：包入口与模块都不再导出这三个符号。动态 import 里对缺失具名导出取到 `undefined`
  // （不是抛错），所以用 `hasOwn`/`in` 直接查导出对象的形状，把「它不在了」钉死。
  const mod = await import("../../src/compact/strategy-resolution.js");
  for (const gone of [
    "BUILTIN_COMPACTION_STRATEGIES",
    "BUILTIN_COMPACTION_STRATEGY_NAMES",
    "isBuiltinCompactionStrategyName",
  ]) {
    assert.equal(Object.hasOwn(mod, gone), false, `${gone} must no longer be exported`);
  }
  // `resolveCompactionStrategy` 仍在（对象解析器 + 缺省内置的工厂仍从这里出）。
  assert.equal(typeof mod.resolveCompactionStrategy, "function");
});

test("unconfigured strategy resolves to the built-in fold-llm (never empty)", () => {
  for (const value of [undefined, null]) {
    const strategy = resolveCompactionStrategy(value, { foldLlmOptions: { summarizer: () => "s" } });
    assert.equal(strategy.name, "fold-llm");
    assert.equal(typeof strategy.shouldCompact, "function");
    assert.equal(typeof strategy.compact, "function");
  }
});

test("the built-in fold-llm default consumes foldLlmOptions (engine summarizer)", async () => {
  const seen = [];
  const strategy = resolveCompactionStrategy(undefined, {
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

test("the built-in default forwards context-level factory options", async () => {
  const strategy = resolveCompactionStrategy(null, {
    options: { recoveryHint: "归档在 judge.log", keepRounds: 0 },
    foldLlmOptions: { summarizer: () => "injected summary" },
  });
  assert.equal(strategy.name, "fold-llm");

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
  assert.match(JSON.stringify(result.messages), /归档在 judge\.log/u);
});

test("object strategies pass through by identity (arrays included)", () => {
  const strategy = createFoldStatisticalStrategy();
  assert.equal(resolveCompactionStrategy(strategy), strategy);
  // Arrays are objects too: the pre-#167 behaviour (fail later on shouldCompact) is kept.
  const list = [];
  assert.equal(resolveCompactionStrategy(list), list);
});

test("an object-built fold-llm without a summarizer keeps its constructor error", () => {
  // 注入形式是覆盖通道：引擎不得替宿主把缺 summarizer 的对象"修好"。
  assert.throws(() => resolveCompactionStrategy(createFoldLlmStrategy({})), {
    name: "TypeError",
    message: /summarizer must be a function/u,
  });
});

test("the former strategy-name form is now a startup TypeError naming the object-only rule", () => {
  // 判据 3：`context.strategy: "fold-llm"` ⇒ TypeError，文案说清「只接受策略对象」。
  for (const value of ["fold-llm", "  fold-llm  ", "sliding-window", "fold-statistical", "psyche", "", "   "]) {
    assert.throws(
      () => resolveCompactionStrategy(value, { foldLlmOptions: { summarizer: () => "s" } }),
      (error) => {
        assert.ok(error instanceof TypeError, `${value} must reject with TypeError`);
        assert.match(error.message, /strategy object/u);
        assert.match(error.message, /name/u);
        return true;
      },
      value,
    );
  }
});

test("non-object, non-nullish strategies throw the same TypeError", () => {
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
