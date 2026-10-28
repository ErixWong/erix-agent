import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createStaticModelConfigProvider } from "../../src/config/static.js";
import { assemblyPortOptions, createAssemblyPort } from "../../src/assembly.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";
import { RUN_TOOL_LOOP_OPTION_SET } from "../../src/loop/option-normalization.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { assemblyPortContract } from "./assembly-port.js";

function createProvider() {
  return {
    async chat() {
      return {
        content: [{ type: "text", text: "assembled" }],
        stopReason: "end_turn",
      };
    },
  };
}

assemblyPortContract("reference", () => ({
  modelConfig: createStaticModelConfigProvider({ model: "contract-model" }),
  provider: createProvider(),
  tools: {
    definitions: [],
    async executeTool() {
      return "unused";
    },
  },
  store: createMemoryTranscriptStore(),
  session: { id: `assembly-contract-${process.pid}` },
}));

test("assembly port supports default and explicit modelConfig paths", async () => {
  let resolveCount = 0;
  const port = createAssemblyPort({
    modelConfig: {
      async resolve() {
        resolveCount += 1;
        return { contextWindowTokens: 100000, maxOutputTokens: 1000 };
      },
    },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    session: { id: `assembly-precedence-${process.pid}` },
    policy: {
      replayPolicy: "per-tool-declaration",
      partialPersistence: { intervalMs: 25, minBytes: 1 },
      stream: true,
    },
  });
  assert.equal((await assemblyPortOptions(port)).replayPolicy, "per-tool-declaration");
  assert.deepEqual(
    (await assemblyPortOptions(port)).partialPersistence,
    { intervalMs: 25, minBytes: 1 },
  );

  // issue #498 第 1 条：`modelConfig` 是**唯一**存活的调用期覆盖通道（它自带
  // `validateModelConfigResolver` 校验，见下一个断言）；其余「构造期给过、调用期又给」一律抛。
  test("assemblyPortOptions keeps the validated modelConfig override channel", async () => {
    const explicitModelConfig = { resolve: async () => ({ model: "explicit" }) };
    const port = createAssemblyPort({
      modelConfig: { resolve: async () => ({ model: "assembly" }) },
      provider: createProvider(),
      tools: { definitions: [], async executeTool() {} },
      store: createMemoryTranscriptStore(),
      session: { id: `assembly-helper-overrides-${process.pid}` },
    });

    const options = await assemblyPortOptions(port, {
      modelConfig: explicitModelConfig,
    });
    assert.equal(options.modelConfig, explicitModelConfig);
    await assert.rejects(
      assemblyPortOptions(port, { modelConfig: { model: "plain" } }),
      (error) => error instanceof TypeError
        && /modelConfig\.resolve/u.test(error.message)
        && /wrap plain config with createModelConfigResolver/u.test(error.message),
    );
  });

  const defaultResult = await runToolLoop({
    assemblyPort: port,
    completion: false,
    config: { input: { wrapup: false } },
    maxRounds: 1,
  });
  assert.equal(defaultResult.termination.reason, "end_turn");
  resolveCount = 0;

  const explicitResult = await runToolLoop({
    assemblyPort: port,
    modelConfig: {
      async resolve() {
        return { contextWindowTokens: 100000, maxOutputTokens: 1000 };
      },
    },
    completion: false,
    config: { input: { wrapup: false } },
    maxRounds: 1,
  });
  assert.equal(explicitResult.termination.reason, "end_turn");
  assert.equal(resolveCount, 0);
});


test("plain explicit modelConfig is rejected with resolver migration guidance", async () => {
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    session: { id: `assembly-plain-model-config-${process.pid}` },
  });
  const plainConfig = { model: "plain-config" };

  assert.throws(
    () => createAssemblyPort({
      ...port,
      modelConfig: plainConfig,
    }),
    (error) => error instanceof TypeError
      && /modelConfig\.resolve/u.test(error.message)
      && /wrap plain config with createModelConfigResolver/u.test(error.message),
  );
  await assert.rejects(
    runToolLoop({
      assemblyPort: port,
      modelConfig: plainConfig,
      completion: false,
      config: { input: { wrapup: false } },
      maxRounds: 1,
    }),
    (error) => error instanceof TypeError
      && /modelConfig\.resolve/u.test(error.message)
      && /wrap plain config with createModelConfigResolver/u.test(error.message),
  );
});

test("fine-grained startup validation rejects incomplete assembly-shaped input", async () => {
  const { runToolLoop } = await import("../../src/loop/orchestrator.js");
  await assert.rejects(
    runToolLoop({
      provider: {},
      session: { id: "fine-invalid" },
      // #498 S3 A13: `persistence` retired its flat spelling (`config.run.persistence`).
      config: { run: { persistence: "none" } },
      maxRounds: 1,
    }),
    (error) => error instanceof TypeError
      && /provider\.chat or provider\.chatStream/u.test(error.message)
      && /executeTool/u.test(error.message)
      && /modelConfig\.resolve/u.test(error.message),
  );
});

test("assembly port without a store runs with no persistence", async () => {
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    session: { id: `assembly-no-store-${process.pid}` },
  });

  const result = await runToolLoop({
    assemblyPort: port,
    completion: false,
    config: { input: { wrapup: false } },
    maxRounds: 1,
  });

  assert.equal(result.finalText, "assembled");
  assert.equal(result.termination.reason, "end_turn");
});

test("assembly port rejects a store missing one of the required methods", () => {
  assert.throws(
    () => createAssemblyPort({
      modelConfig: { resolve: async () => ({}) },
      provider: createProvider(),
      tools: { definitions: [], async executeTool() {} },
      store: { appendRound() {} },
      session: { id: "assembly-incomplete-store" },
    }),
    (error) => error instanceof TypeError && /store\.load/u.test(error.message),
  );
});

// ================================================================ issue #498 第 1 条
// 调用期 capability/port 覆盖不得静默赢（母单 #495 的裁决：能力集在**构造期**定）。
// 三条规则各一格 + 一格正向钉（合法用法没被打死）+ 一格「键集从代码枚举」的自证。
const OVERRIDE_CONFLICT = (key, origin) => `assembly port option override conflicts with the port: ${JSON.stringify(key)}`
  + ` comes from ${origin} (construction) and overrides.${key} (call); pass it in one place only`;

function createOverridePort({ policy, emit } = {}) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    session: { id: `assembly-override-${process.pid}` },
    ...(policy === undefined ? {} : { policy }),
    ...(emit === undefined ? {} : { emit }),
  });
}

test("冲突：构造期有值 + 调用期又给 ⇒ 启动期抛，点名键名与两个来源（issue #498）", async () => {
  const port = createOverridePort({ policy: { maxRounds: 3 } });
  // ① policy 给的键 —— 来源是 `port.policy.<key>`
  await assert.rejects(
    assemblyPortOptions(port, { maxRounds: 1 }),
    (error) => error instanceof TypeError && error.message === OVERRIDE_CONFLICT("maxRounds", "port.policy.maxRounds"),
  );
  // ② 端口派生的键 —— 逐个点名真实来源（这是「两个来源」里构造期那一半）
  const derived = [
    ["provider", "port.provider"],
    ["tools", "port.tools.definitions"],
    ["executeTool", "port.tools.executeTool"],
    ["store", "port.store"],
    ["session", "port.session"],
  ];
  // #498 S3 A20：`runId` 已离开顶层白名单（家 `config.run.runId`）⇒ 调用期覆盖撞的是**名称闸口**
  // 而不是冲突闸口。这里按「改而不删」翻成反向钉：构造期它仍被产出（下面「键集自证」那一格还在
  // 断言），只是覆盖写法没了——闭集派生自 `RUN_TOOL_LOOP_OPTION_NAMES`，不是手抄。
  await assert.rejects(
    assemblyPortOptions(port, { runId: null }),
    (error) => error instanceof TypeError
      && error.message.startsWith("unknown assembly port override option:"),
    "`runId` 已退役扁平写法 ⇒ 覆盖名也不合法（派生：覆盖闭集 = 白名单）",
  );
  for (const [key, origin] of derived) {
    await assert.rejects(
      assemblyPortOptions(port, { [key]: null }),
      (error) => error instanceof TypeError && error.message === OVERRIDE_CONFLICT(key, origin),
      `${key} 的冲突文案必须点名 ${origin}`,
    );
  }
  // ③ `emit` 派生的 `onEvent`：以前是「显式 onEvent 存在就不装」（静默），现在同一条闸口。
  const emitting = createOverridePort({ emit: () => {} });
  await assert.rejects(
    assemblyPortOptions(emitting, { onEvent: () => {} }),
    (error) => error instanceof TypeError && error.message === OVERRIDE_CONFLICT("onEvent", "port.emit"),
  );
  // ④ 冲突闸口在 `modelConfig.resolve` **之前**：会抛的调用不该先调一次宿主回调。
  let resolves = 0;
  const counting = createAssemblyPort({
    modelConfig: {
      async resolve() {
        resolves += 1;
        return {};
      },
    },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    session: { id: `assembly-override-no-resolve-${process.pid}` },
  });
  await assert.rejects(
    assemblyPortOptions(counting, { provider: createProvider() }),
    (error) => error instanceof TypeError && /conflicts with the port/u.test(error.message),
  );
  assert.equal(resolves, 0, "冲突必须在 modelConfig.resolve 之前抛出");
});

test("任意名字：键名必须落在 loop 选项闭集内，否则抛（含 did you mean）", async () => {
  const port = createOverridePort();
  await assert.rejects(
    assemblyPortOptions(port, { maxRound: 1 }),
    (error) => error instanceof TypeError
      && error.message === 'unknown assembly port override option: "maxRound" (did you mean "maxRounds"?)',
  );
  await assert.rejects(
    assemblyPortOptions(port, { bogusKey: 1 }),
    (error) => error instanceof TypeError
      && error.message === 'unknown assembly port override option: "bogusKey"',
  );
  // 闭集**来源自证**：`RUN_TOOL_LOOP_OPTION_NAMES` 里的每一个名字都不是「unknown」——
  // 它们只可能撞上冲突闸口（端口产出的那些）或容器闸口（`config` / `capabilities`）。
  // 这条把「键集从代码枚举」钉成机器可查：实现里换掉这个来源、或手抄一份清单，都会红。
  const { RUN_TOOL_LOOP_OPTION_NAMES, RUN_TOOL_LOOP_OPTION_SET } = await import(
    "../../src/loop/option-normalization.js",
  );
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.length, RUN_TOOL_LOOP_OPTION_SET.size,
    "闭集大小必须与来源符号一致（手抄总数会在删键时假红，#498 S3 口径）");
  for (const name of RUN_TOOL_LOOP_OPTION_NAMES) {
    const error = await assemblyPortOptions(port, { [name]: null }).then(() => null, (caught) => caught);
    assert.equal(
      error !== null && /^unknown assembly port override option/u.test(error.message),
      false,
      `${name} 必须在闭集内（实际抛：${error === null ? "无" : error.message}）`,
    );
  }
});

test("容器整块替换：config / capabilities 一律抛，并把消息指向具体子键", async () => {
  const port = createOverridePort();
  await assert.rejects(
    assemblyPortOptions(port, { config: { run: { maxRounds: 1 } } }),
    (error) => error instanceof TypeError
      && error.message === 'assembly port override must not replace the "config" container:'
        + " pass the specific sub-keys instead (e.g. config.run.maxRounds)",
  );
  await assert.rejects(
    assemblyPortOptions(port, { capabilities: { hooks: { onEvent: async () => {} } } }),
    (error) => error instanceof TypeError
      && error.message === 'assembly port override must not replace the "capabilities" container:'
        + " pass the specific sub-keys instead (e.g. capabilities.hooks.onEvent)",
  );
});

test("正向钉：调用期新键仍然合法（端口没产出的 signal / store 照常生效，值逐字等于传入）", async () => {
  // 端口**不给** store：于是 `store` 是「调用期新键」；`signal` 每轮都换，端口永远不产出。
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    session: { id: `assembly-new-keys-${process.pid}` },
  });
  const controller = new AbortController();
  const store = createMemoryTranscriptStore();
  const options = await assemblyPortOptions(port, { signal: controller.signal, store });
  assert.equal(options.signal, controller.signal);
  assert.equal(options.store, store);
  assert.equal(options.session.id, `assembly-new-keys-${process.pid}`);
  // 这条不是「没抛」：上面三行都在断言**具体值**，而下面证明合法新键真的能被引擎用起来。
  // #498 S3 A18: `wrapup` is retired as a flat key; the switch lives at `config.input.wrapup`.
  // #544：端口的 run identity **不再**以扁平 `runId` 产出，它就在 `config.run.runId` 上（与宿主
  // 能写的拼写同一套合法性）⇒ 端口产物现在可以原样铺进 `runToolLoop`，调用方不必再翻译一次。
  assert.equal(
    options.config.run.runId,
    `assembly-new-keys-${process.pid}`,
    "前提：端口把 session.id 产成了规位拼写 config.run.runId",
  );
  const result = await runToolLoop({
    ...options,
    modelConfig: port.modelConfig,
    completion: false,
    config: { ...options.config, input: { ...options.config.input, wrapup: false } },
  });
  assert.equal(result.termination.reason, "end_turn");
});

test("键集自证：构造期产出的每一个键都在冲突闸口内（从实际产物枚举，不手抄清单）", async () => {
  const port = createOverridePort({
    policy: { maxRounds: 3, maxTokens: 1000, temperature: 0.1, stream: false, replayPolicy: "per-tool-declaration" },
    emit: () => {},
  });
  const produced = Object.keys(await assemblyPortOptions(port));
  // 探针自证：这批键真的是构造期产出的（不是空循环恒绿）。
  // #544：`runId` / `initialMessages` 已不在产物里（它们成为 `config` 树的叶子），所以这里点名
  // `config`——端口自己的拼写就是那个容器，容器里的叶子由 `config` 的名称闸口管。
  for (const expected of ["provider", "tools", "executeTool", "store", "config", "session", "onEvent", "maxRounds", "maxTokens"]) {
    assert.ok(produced.includes(expected), `${expected} 必须出现在构造期产物里`);
  }
  assert.equal(produced.includes("runId"), false, "#544：扁平 runId 不再出现在构造期产物里");
  for (const key of produced) {
    if (key === "modelConfig") continue; // 唯一既有例外：自带校验的覆盖通道
    // #544：`config` 是容器（不是「给一个值」的键）⇒ 覆盖它撞的是容器闸口，不是冲突闸口。
    if (key === "config") {
      await assert.rejects(
        assemblyPortOptions(port, { config: { run: { maxRounds: 1 } } }),
        (error) => error instanceof TypeError
          && error.message.startsWith('assembly port override must not replace the "config" container:'),
        "config 是容器 ⇒ 覆盖它走容器闸口（派生：容器清单在 src/assembly.js）",
      );
      continue;
    }
    // #498 S3（`tuning` A5）：**覆盖**的键名闭集派生自 `RUN_TOOL_LOOP_OPTION_NAMES`（`src/assembly.js`
    // 的规则 2），所以一个键离开顶层白名单之后，它连「调用期覆盖」这个名字都不再合法 —— 撞的是
    // 名称闸口（`unknown assembly port override option`）而不是冲突闸口。判据因此按**派生**跳过，
    // 不手抄名单：`policy.maxTokens` 仍然被构造期产出（上面那格还在断言），只是覆盖写法没了。
    if (!RUN_TOOL_LOOP_OPTION_SET.has(key)) {
      await assert.rejects(
        assemblyPortOptions(port, { [key]: null }),
        (error) => error instanceof TypeError
          && error.message.startsWith("unknown assembly port override option:"),
        `${key} 已不在顶层白名单 ⇒ 覆盖名也不合法（派生：覆盖闭集 = 白名单）`,
      );
      continue;
    }
    await assert.rejects(
      assemblyPortOptions(port, { [key]: null }),
      (error) => error instanceof TypeError
        && error.message.includes(`conflicts with the port: ${JSON.stringify(key)}`),
      `${key} 是构造期产出的键，调用期再给必须抛`,
    );
  }
});
