// 边界 parity（issue #496 更正评论③的口径）：**只附加证明「两条路线等价」**，
// 不代替正确性断言。每条 parity 用例分两段：
//   ① 两条路线**各自**断言「必须抛预期错误」（同类 + 逐字消息）——只比较「两条的错误是否相同」
//      会出现「两条都不抛也算等价」的空比较；
//   ② 再断言等价：同类、同消息、只差 `error.via`（`assembly` | `direct`）。
// 逐条规则的**正例 / 反例**在 `test/loop-option-gate-496.test.js` 里各自成立，不靠本文件代劳。
//
// 本文件随包发布（`files` 收 `test/contract/`），所以**不得** import `test/helpers/`：
// 夹具在本文件内自足，只依赖 `src/`。

import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyPort, assemblyPortOptions } from "../../src/assembly.js";
import { FOLD_SUMMARIZER_CAP_NAMES } from "../../src/assembly-validators.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";

function createValidProvider() {
  return {
    async chat() {
      return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
    },
  };
}

function createValidModelConfig() {
  return { resolve: async () => ({ model: "parity-model" }) };
}

function createValidTools() {
  return { definitions: [], async executeTool() { return "unused"; } };
}

const ASSEMBLY_PREFIX = "assembly port is missing methods: ";
const PERSISTENCE_PREFIX = "required persistence store is missing methods: ";
const PROVIDER_MISSING_MESSAGE = `${ASSEMBLY_PREFIX}provider.chat or provider.chatStream`;

function missingItems(message, prefix) {
  assert.ok(message.startsWith(prefix), `unexpected prefix: ${message}`);
  return message.slice(prefix.length).split(", ");
}

test("boundary parity: missing provider.chat/chatStream reports identically in both shapes", async () => {
  const brokenProvider = { notChat: true };

  // Shape 1: createAssemblyPort / assemblyPortOptions
  assert.throws(
    () => createAssemblyPort({
      modelConfig: createValidModelConfig(),
      provider: brokenProvider,
      tools: createValidTools(),
      session: { id: `parity-provider-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message === PROVIDER_MISSING_MESSAGE,
  );
  await assert.rejects(
    assemblyPortOptions({
      modelConfig: createValidModelConfig(),
      provider: brokenProvider,
      tools: createValidTools(),
      session: { id: `parity-provider-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message === PROVIDER_MISSING_MESSAGE,
  );

  // Shape 2: runToolLoop with fine-grained options
  await assert.rejects(
    runToolLoop({
      provider: brokenProvider,
      executeTool: async () => "unused",
      modelConfig: createValidModelConfig(),
      session: { id: `parity-provider-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message === PROVIDER_MISSING_MESSAGE,
  );
});

test("boundary parity: plain modelConfig without resolve reports identically in both shapes", async () => {
  const plainConfig = { model: "plain" };
  const modelConfigItem = /modelConfig\.resolve \(modelConfig must expose resolve\(slot\); wrap plain config with createModelConfigResolver\(\.\.\.\)\)/u;

  // Shape 1: createAssemblyPort / assemblyPortOptions
  assert.throws(
    () => createAssemblyPort({
      modelConfig: plainConfig,
      provider: createValidProvider(),
      tools: createValidTools(),
      session: { id: `parity-model-config-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && modelConfigItem.test(error.message),
  );
  await assert.rejects(
    assemblyPortOptions({
      modelConfig: plainConfig,
      provider: createValidProvider(),
      tools: createValidTools(),
      session: { id: `parity-model-config-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && modelConfigItem.test(error.message),
  );

  // Shape 2: runToolLoop with fine-grained options (plain config object)
  await assert.rejects(
    runToolLoop({
      provider: createValidProvider(),
      executeTool: async () => "unused",
      modelConfig: plainConfig,
      session: { id: `parity-model-config-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && modelConfigItem.test(error.message),
  );
});

test("boundary parity: incomplete transcript store reports the same missing method list in both shapes", async () => {
  // issue #78：必需方法只有 appendRound/load；这里两者都缺（七个可选方法缺失不算不完整）。
  const brokenStore = {};

  // Capture the createAssemblyPort missing-item list once; every shape below
  // must surface this exact, ordered list under its own error prefix.
  let assemblyItems = null;
  try {
    createAssemblyPort({
      modelConfig: createValidModelConfig(),
      provider: createValidProvider(),
      tools: createValidTools(),
      store: brokenStore,
      session: { id: `parity-store-${process.pid}` },
    });
  } catch (error) {
    assemblyItems = missingItems(error.message, ASSEMBLY_PREFIX);
  }
  assert.ok(Array.isArray(assemblyItems));

  // Shape 1a: createAssemblyPort rejects with the assembly prefix.
  assert.throws(
    () => createAssemblyPort({
      modelConfig: createValidModelConfig(),
      provider: createValidProvider(),
      tools: createValidTools(),
      store: brokenStore,
      session: { id: `parity-store-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && error.message.includes("store.appendRound")
      && error.message.includes("store.load")
      // issue #78：可选 capability（快照/run-state）缺失不得出现在必需缺失清单里。
      && !error.message.includes("saveRunSnapshot")
      && !error.message.includes("markRunState"),
  );

  // Shape 1b: assemblyPortOptions routes through createAssemblyPort, so the
  // same assembly prefix and the same missing-item list must surface.
  await assert.rejects(
    assemblyPortOptions({
      modelConfig: createValidModelConfig(),
      provider: createValidProvider(),
      tools: createValidTools(),
      store: brokenStore,
      session: { id: `parity-store-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && (() => {
        const items = missingItems(error.message, ASSEMBLY_PREFIX);
        assert.deepEqual(items, assemblyItems);
        return true;
      })(),
  );

  // Shape 2: runToolLoop with fine-grained options + required persistence
  // keeps its own prefix but the missing-item list must be identical.
  await assert.rejects(
    runToolLoop({
      provider: createValidProvider(),
      executeTool: async () => "unused",
      modelConfig: createValidModelConfig(),
      store: brokenStore,
      session: { id: `parity-store-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && (() => {
        const items = missingItems(error.message, PERSISTENCE_PREFIX);
        assert.deepEqual(items, assemblyItems);
        return true;
      })(),
  );
});

test("boundary parity: minimal store (required methods only) assembles and runs in both shapes (issue #78)", async () => {
  // 可选 capability（快照/run-state）全部缺失不得阻止组装或运行——两条入口都要验证。
  const appendCalls = [];
  const minimalStore = {
    appendRound: async (runId, record) => {
      appendCalls.push(record);
    },
    load: async () => [],
  };

  // Shape 1a: createAssemblyPort 组装成功（缺可选方法不报错）
  const port = createAssemblyPort({
    modelConfig: createValidModelConfig(),
    provider: createValidProvider(),
    tools: createValidTools(),
    store: minimalStore,
    session: { id: `parity-minimal-${process.pid}` },
  });
  assert.equal(typeof port.store.appendRound, "function");
  assert.equal(typeof port.store.load, "function");

  // Shape 1b: assemblyPortOptions 解析成功且带同一 store
  const options = await assemblyPortOptions({
    modelConfig: createValidModelConfig(),
    provider: createValidProvider(),
    tools: createValidTools(),
    store: minimalStore,
    session: { id: `parity-minimal-${process.pid}` },
  });
  assert.equal(options.store, minimalStore);

  // Shape 2: 细粒度 runToolLoop 全 run 正常完成
  const result = await runToolLoop({
    provider: createValidProvider(),
    executeTool: async () => "unused",
    modelConfig: createValidModelConfig(),
    store: minimalStore,
    session: { id: `parity-minimal-${process.pid}` },
    completion: false,
  });
  assert.equal(result.finalText, "ok");
  assert.ok(appendCalls.length > 0, "transcript appendRound 必须被调用");
});

// ---------------------------------------------------------------- issue #496：语义相 parity
// 两条路线共用同一个闸口（`collectSemanticOptionProblems`，在 `src/assembly-validators.js`），
// 条件与文案只有一份，路线只贴 `error.via` 标签。

/** 装配口的最小合法输入（`policy` 是要被测的那份）。 */
function assemblyInput(policy) {
  return {
    modelConfig: createValidModelConfig(),
    provider: createValidProvider(),
    tools: createValidTools(),
    session: { id: `parity-gate-${process.pid}` },
    policy,
  };
}

/** 直连路线的最小合法输入（只带要测的选项）。 */
function directInput(bad) {
  return {
    provider: createValidProvider(),
    executeTool: async () => "unused",
    initialUserMessage: "go",
    completion: false,
    ...bad,
  };
}

/** 两条路线各自抛出的错误（不抛 ⇒ null）。 */
async function errorsOnBothRoutes(bad) {
  const direct = await runToolLoop(directInput(bad)).then(() => null, (error) => error);
  let assembly = null;
  try {
    createAssemblyPort(assemblyInput(bad));
  } catch (error) {
    assembly = error;
  }
  return { direct, assembly };
}

/**
 * ① 各自断言必须抛预期错误 → ② 再断言等价（同类 / 同消息 / 只差 via）。
 *
 * @param {{bad:object, message:string, label:string}} cell
 */
async function assertGateParity({ bad, message, label }) {
  const { direct, assembly } = await errorsOnBothRoutes(bad);

  // ① 各自成立（缺了这一半，下面的「等价」可能只是「两条都不抛」）。
  assert.ok(direct instanceof TypeError, `${label}: 直连必须抛 TypeError，实测 ${String(direct)}`);
  assert.equal(direct.message, message, `${label}: 直连文案`);
  assert.equal(direct.via, "direct", `${label}: 直连路线标签`);
  assert.ok(assembly instanceof TypeError, `${label}: 装配口必须抛 TypeError，实测 ${String(assembly)}`);
  assert.equal(assembly.message, message, `${label}: 装配口文案`);
  assert.equal(assembly.via, "assembly", `${label}: 装配口路线标签`);

  // ② 等价：同构造器、同消息，只有路线标签不同。
  assert.equal(Object.getPrototypeOf(assembly), Object.getPrototypeOf(direct), `${label}: 同错误类`);
  assert.equal(assembly.message, direct.message, `${label}: 同消息`);
  assert.notEqual(assembly.via, direct.via, `${label}: 只有 via 不同`);
}

test("boundary parity: 每个折叠摘要旋钮名的拼错在两条路线上抛同一条错（派生自 FOLD_SUMMARIZER_CAP_NAMES）", async () => {
  assert.ok(FOLD_SUMMARIZER_CAP_NAMES.length > 0, "前提：旋钮家族非空");
  for (const name of FOLD_SUMMARIZER_CAP_NAMES) {
    const typo = `${name}s`;
    await assertGateParity({
      label: typo,
      bad: { context: { [typo]: 1024 } },
      message: `unknown assembly policy context option: ${JSON.stringify(typo)}`,
    });
  }
});

test("boundary parity: 旋钮的非法值在两条路线上抛同一条错", async () => {
  for (const name of FOLD_SUMMARIZER_CAP_NAMES) {
    await assertGateParity({
      label: `${name}=0`,
      bad: { context: { [name]: 0 } },
      message: `${name} must be a positive integer`,
    });
  }
});

test("boundary parity: 承载宿主回调的字段形状错误在两条路线上同码同构（issue #496）", async () => {
  const cells = [
    ["context-shape", { context: "not-an-object" }, "context must be an object"],
    ["onFoldSummary", { onFoldSummary: "notes" },
      "assembly policy option onFoldSummary must be a function (or omitted)"],
    ["finalGuard", { finalGuard: true }, "finalGuard must be a function (or omitted)"],
    ["retry.sleepImpl", { retry: { sleepImpl: 10 } }, "retry.sleepImpl must be a function (or omitted)"],
    ["reflection.onReflection", { reflection: { onReflection: "cb" } },
      "reflection.onReflection must be a function (or omitted)"],
    ["diagnostics.error", { diagnostics: { error: "cb" } },
      "diagnostics.error must be a function (or omitted)"],
    ["context.onBeforeFold", { context: { onBeforeFold: "hooks" } },
      "context.onBeforeFold must be a function (or omitted)"],
    ["context.onAfterFold", { context: { onAfterFold: {} } },
      "context.onAfterFold must be a function (or omitted)"],
    ["context.onFoldSummary", { context: { onFoldSummary: false } },
      "context.onFoldSummary must be a function (or omitted)"],
  ];
  for (const [label, bad, message] of cells) {
    await assertGateParity({ label, bad, message });
  }
});

test("boundary parity: 合法配置在两条路线上都不抛（防 parity 只在错误路径上成立）", async () => {
  const good = {
    context: {
      budgetTokens: 1000,
      maxSummaryTokens: 900,
      onBeforeFold: () => {},
      onAfterFold: () => {},
      onFoldSummary: () => {},
    },
    onFoldSummary: () => {},
    finalGuard: async () => ({ action: "accept" }),
    retry: { attempts: 1, sleepImpl: async () => {} },
    reflection: { enabled: false, onReflection: () => {} },
    diagnostics: { error: () => {} },
  };
  const { direct, assembly } = await errorsOnBothRoutes(good);
  assert.equal(direct, null, `直连正例不得抛（实测 ${direct?.message}）`);
  assert.equal(assembly, null, `装配口正例不得抛（实测 ${assembly?.message}）`);
});
