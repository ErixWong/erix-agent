// 边界 parity（issue #496 更正评论③的口径）：**只附加证明「两条路线等价」**，
// 不代替正确性断言。每条 parity 用例分两段：
//   ① 两条路线**各自**断言「必须抛预期错误」（同类 + 逐字消息）——只比较「两条的错误是否相同」
//      会出现「两条都不抛也算等价」的空比较；
//   ② 再断言等价：同类、同消息、只差 `error.via`（`assembly` | `direct`）。
// 逐条规则的**正例 / 反例**在 `test/loop-option-gate-496.test.js` 里各自成立，不靠本文件代劳。
//
// 本文件**不**随包发布：它是 `node --test` 套件（`*.test.js`），而 `package.json` 的 `files` 是
// **逐个列举** `test/contract/*.js`（不收目录），`npm pack --dry-run --json` 里 `.test.js` 文件数
// = 0。随包的是 `files` 里逐条列出的 `test/contract/*.js`（如 `assembly-port.js` /
// `transcript-store.js`）——那些才是宿主安装后自己跑的契约套件。
// 既然不进 tarball，本文件**不必**回避 `test/helpers/`；但它仍然自足（夹具写在文件内、只依赖
// `src/`），这样 `node --test test/contract/` 单跑也成立，不依赖 `test/` 之外的布局。

import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyPort, assemblyPortOptions } from "../../src/assembly.js";
import { FOLD_SUMMARIZER_CAP_NAMES } from "../../src/assembly-validators.js";
import {
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_SCHEMA,
  NAMESPACE_CONTAINER_OPTION_NAMES,
} from "../../src/loop/config-namespace.js";
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

/** `policy` 的可接受名字（#545）：`config` 的叶子 + 两个容器。派生，不手抄。 */
const CONFIG_LEAF_SET = new Set(CONFIG_NAMESPACE_GROUPS.flatMap((group) => CONFIG_NAMESPACE_SCHEMA[group]));
const CONTAINERS = new Set(NAMESPACE_CONTAINER_OPTION_NAMES);

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
    config: { run: { completion: false } },
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
  const { config, ...rest } = bad ?? {};
  return {
    provider: createValidProvider(),
    executeTool: async () => "unused",
    // #498 S3 A2b: the seed's canonical home is `config.input.initialUserMessage`. It is **merged**
    // into the cell's own `config` (not spread over it, and not spread before it) so the cell keeps
    // testing exactly what it says it tests — a plain `...bad` after this key would replace the whole
    // `config` tree and silently drop the seed.
    config: {
      ...(config ?? {}),
      input: { initialUserMessage: "go" },
      run: { completion: false, ...(config?.run ?? {}) },
    },
    ...rest,
  };
}

/**
 * `policy` 只收**数据 + 两个容器**（issue #545），所以装配口路线的拼写要按名字分派：
 * 配置叶子 / `config` / `capabilities` 进 `policy`，其余名字（能力名、第三站选项）走**显式选项**
 * ——那是它们本来就有的家。两条路线因此仍然吃「同一份配置」，只是装配口这一侧按新裁决拼写。
 *
 * @param {object|undefined} bad
 * @returns {{policy: object, explicit: object}}
 */
function assemblySpelling(bad) {
  const policy = {};
  const explicit = {};
  for (const [key, value] of Object.entries(bad ?? {})) {
    if (CONFIG_LEAF_SET.has(key) || CONTAINERS.has(key)) policy[key] = value;
    else explicit[key] = value;
  }
  return { policy, explicit };
}

/** 两条路线各自抛出的错误（不抛 ⇒ null）。 */
async function errorsOnBothRoutes(bad) {
  const direct = await runToolLoop(directInput(bad)).then(() => null, (error) => error);
  const { policy, explicit } = assemblySpelling(bad);
  let assembly = null;
  try {
    const port = createAssemblyPort(assemblyInput(policy));
    // #498 S3: the assembly route can also reject **after** construction — `config` /
    // `capabilities` expansion runs inside `normalizeRunToolLoopOptions`, so a nested spelling
    // (`config.timing.retry.sleepImpl`) is only judged when the loop actually starts. Running it
    // here keeps the parity claim ("same error, only `via` differs") honest for both shapes; the
    // cells that already throw at construction are unaffected (the catch below).
    assembly = await runToolLoop({ assemblyPort: port, ...explicit }).then(() => null, (error) => error);
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
      bad: { config: { folding: { context: { [typo]: 1024 } } } },
      message: `unknown assembly policy context option: ${JSON.stringify(typo)}`,
    });
  }
});

test("boundary parity: 旋钮的非法值在两条路线上抛同一条错", async () => {
  for (const name of FOLD_SUMMARIZER_CAP_NAMES) {
    await assertGateParity({
      label: `${name}=0`,
      bad: { config: { folding: { context: { [name]: 0 } } } },
      message: `${name} must be a positive integer`,
    });
  }
});

test("boundary parity: 承载宿主回调的字段形状错误在两条路线上同码同构（issue #496）", async () => {
  const cells = [
    ["context-shape", { config: { folding: { context: "not-an-object" } } }, "context must be an object"],
    ["onFoldSummary", { onFoldSummary: "notes" },
      "assembly policy option onFoldSummary must be a function (or omitted)"],
    ["finalGuard", { finalGuard: true }, "finalGuard must be a function (or omitted)"],
    // #498 S3: `retry` moved to `config.timing.retry`, so the parity cell uses the new spelling on
    // both routes (the flat one is now rejected one phase earlier by the name gate).
    ["timing.retry.sleepImpl", { config: { timing: { retry: { sleepImpl: 10 } } } },
      "retry.sleepImpl must be a function (or omitted)"],
    // #530: `reflection` 退役扁平写法 ⇒ 这一格用规位拼写。**非函数**留在数据半边
    // （只有函数值才搬去能力面），所以语义相照旧报同一条文案——这一格测的是形状，不是去处。
    ["reflection.onReflection", { config: { run: { reflection: { onReflection: "cb" } } } },
      "reflection.onReflection must be a function (or omitted)"],
    ["diagnostics.error", { diagnostics: { error: "cb" } },
      "diagnostics.error must be a function (or omitted)"],
    ["context.onBeforeFold", { config: { folding: { context: { onBeforeFold: "hooks" } } } },
      "context.onBeforeFold must be a function (or omitted)"],
    ["context.onAfterFold", { config: { folding: { context: { onAfterFold: {} } } } },
      "context.onAfterFold must be a function (or omitted)"],
  ];
  for (const [label, bad, message] of cells) {
    await assertGateParity({ label, bad, message });
  }
});

test("boundary parity: 合法配置在两条路线上都不抛（防 parity 只在错误路径上成立）", async () => {
  const good = {
    // #545: capability carriers travel in `capabilities` (they are no longer accepted at the top of
    // `policy`); both routes expand them to the same flat options before the semantic phase.
    onFoldSummary: () => {},
    finalGuard: async () => ({ action: "accept" }),
    // #498 S3: data keys go to `config.timing.retry`, the function carrier to `capabilities.ports`.
    config: { folding: { context: {
      budgetTokens: 1000,
      maxSummaryTokens: 900,
                      } }, timing: { retry: { attempts: 1 } },
      // #530: `reflection` 的数据半边在 `config.run.reflection`，回调半边在 `capabilities.hooks`。
      run: { reflection: { enabled: false } } },
    capabilities: { ports: { sleepImpl: async () => {} }, hooks: { onReflection: () => {} } },
    diagnostics: { error: () => {} },
  };
  const { direct, assembly } = await errorsOnBothRoutes(good);
  assert.equal(direct, null, `直连正例不得抛（实测 ${direct?.message}）`);
  assert.equal(assembly, null, `装配口正例不得抛（实测 ${assembly?.message}）`);
});

test("boundary parity: 调用期未知选项名在两条路线上都启动期拒，同名同建议（issue #498 第 1 条）", async () => {
  const sessionId = `parity-override-${process.pid}`;
  // ① 装配口的覆盖通道（`assemblyPortOptions` 的 `overrides`）：`overrides` 的键必须落在
  //    loop 选项闭集内（来源是 `RUN_TOOL_LOOP_OPTION_NAMES`），拼错时给同一条建议。
  const helperError = await assemblyPortOptions(
    {
      modelConfig: createValidModelConfig(),
      provider: createValidProvider(),
      tools: createValidTools(),
      session: { id: sessionId },
    },
    // #498 S3 A21: `maxRound` → `maxRounds` no longer works as the suggestion sample (the candidate
    // pool is the allowlist and `maxRounds` left it). `providr` → `provider` pins the same branch:
    // one character off, so a suggestion is mandatory on **both** routes.
    { providr: 1 },
  ).then(() => null, (error) => error);
  assert.ok(helperError instanceof TypeError, `装配口必须抛 TypeError，实测 ${String(helperError)}`);
  assert.equal(
    helperError.message,
    'unknown assembly port override option: "providr" (did you mean "provider"?)',
  );

  // ② 直连路线：同一条白名单，同一套「did you mean」。
  const directError = await runToolLoop({
    provider: createValidProvider(),
    executeTool: async () => "unused",
    modelConfig: createValidModelConfig(),
    session: { id: sessionId },
    providr: 1,
  }).then(() => null, (error) => error);
  assert.ok(directError instanceof TypeError, `直连必须抛 TypeError，实测 ${String(directError)}`);
  assert.equal(directError.message, 'unknown runToolLoop option: "providr" (did you mean "provider"?)');

  // ③ 等价：同错误类、同被点名的键、同建议；只差路线前缀（两条路线各自说自己的入口）。
  assert.equal(Object.getPrototypeOf(helperError), Object.getPrototypeOf(directError));
  const suggestion = /\(did you mean "([^"]+)"\?\)$/u;
  assert.equal(helperError.message.match(suggestion)[1], "provider");
  assert.equal(directError.message.match(suggestion)[1], "provider");
  assert.ok(helperError.message.includes('"providr"') && directError.message.includes('"providr"'));
});
