// issue #497（S2）—— `config: { … }` 嵌套命名空间。
//
// 本文件钉住四件事，对应工单的四条验收判据：
//
//   A. **只有一张表**：`config.<group>.<leaf>` 是顶层扁平键的别名，叶子名逐字等于顶层键名
//      （`CONFIG_ALIAS_PATHS` 从 `CONFIG_NAMESPACE_SCHEMA` 机械派生）。`configSchemaSelfCheck`
//      对着 `RUN_TOOL_LOOP_OPTION_NAMES` 核「每个顶层选项恰好落在配置面或能力面之一」——
//      往白名单加一个键却忘了分类 ⇒ 这里红。
//   B. **结构等价**（判据 1）：同一份配置写成扁平形态与 `config` 形态，`effectiveOptions` 逐键
//      深度相等。两层：46 个配置键**逐个**扫一遍（`expandConfigNamespace`，机械穷举），
//      再加一份跨 10 个分组的**端到端** `normalizeRunToolLoopOptions` 对比（走真闸口）。
//      断言一律 `deepStrictEqual` / `assert.equal`，不用 `toBeTruthy` 糊。
//   C. **优先级与冲突**（判据 2）：同名时 `config.*` 赢，且发一条 `config_override_conflict` 事件。
//      优先级不只比对象：真跑一次两轮 run，`maxRounds` 扁平 1 / config 2 ⇒ `end_turn`
//      （扁平赢的话会是 `max_rounds_cap`）。冲突事件在「值相同」「只给一边」时**不发**。
//   D. **能力面不收配置覆盖**（判据 3）：19 个能力/注入键写进 `config`（顶层或组内）⇒ 启动即抛，
//      报错点名该键，`error.via` 按入口路线是 `direct` / `assembly`。**既有 overrides 语义不动**：
//      `test/contract/assembly-port.js` 的「显式细粒度 provider 覆盖端口 provider」照旧绿。
//   E. **#496 的语义相闸口吃的是展开后的表示**（判据 5）：`config.folding.context` 里拼错的旋钮名
//      抛的错与扁平 `context` 里拼错的**同一句**，只差 `via` 标签。
//
// mutation 自证（改的是**代码行**不是注释；五个变异的实测红单见交付报告 /tmp/i497-report.md）：
//   · M1 优先级反转（`expanded[key] = value` → `if (flatValue === undefined) …`）⇒ 4 红：
//     B1（含「迁移场景」断言）/ C1 / C2 / G2；
//   · M2 config 值不落地（同一行改成 `void flatValue`）⇒ 8 红：B1 / B2 / C1 / C2 / E1 / E2 / E4 / G2；
//   · M3 顶层能力键分支降级成 `continue` ⇒ 3 红：D1 / D3 / F3；
//   · M4 `assertConfigNamespace` 的 `throw` 降级成 `return` ⇒ 6 红：D1 / D2 / D3 / F1 / F2 / F3；
//   · M5 `notifyConfigOverrideConflicts` 的 `onEvent?.({…})` 整块换成 `void configConflicts`
//     ⇒ 2 红：C2（事件恰一条）/ C4（观察者隔离）。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import {
  CAPABILITY_OPTION_NAMES,
  CONFIG_ALIAS_PATHS,
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_OPTION_NAME,
  CONFIG_NAMESPACE_SCHEMA,
  CONFIG_SURFACE_OPTION_NAMES,
  collectConfigNamespaceProblems,
  configPathForOption,
  configSchemaSelfCheck,
  expandConfigNamespace,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 直连路线的最小合法 run（一次 end_turn 就结束）。 */
function runDirect(extra = {}) {
  return runToolLoop({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    ...extra,
  });
}

/** 直连路线的「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => runDirect(extra).then(() => null, (error) => error);

/** 装配口路线：`policy` 在构造期过闸口，`config` 在合并后过同一道展开。 */
function makePort(policy = {}, { emit } = {}) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: createFakeProvider(DONE),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: `config-497-${process.pid}` },
    ...(emit === undefined ? {} : { emit }),
    policy,
  });
}

/** 装配口路线：跑一次（构造期或合并后抛都算——构造期是同步抛，必须在这里接住）。 */
const assemblyError = async (policy = {}) => {
  let port;
  try {
    port = makePort(policy);
  } catch (error) {
    return error;
  }
  return runToolLoop({ assemblyPort: port }).then(() => null, (error) => error);
};

// ================================================================ A. 只有一张表（派生，不是手抄）
test("A1 schema 自检：65 个顶层选项恰好分成 46 配置面 + 19 能力面，且 config 自己是容器", () => {
  // 样本自证：总数先钉住，免得「两边一起漏」也算通过。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.length, 66, "顶层白名单 = 65 个既有选项 + config");
  assert.equal(CONFIG_SURFACE_OPTION_NAMES.length, 46, "配置面 46 个键");
  assert.equal(CAPABILITY_OPTION_NAMES.length, 19, "能力/注入面 19 项（母单裁决的数字）");
  assert.equal(
    CONFIG_SURFACE_OPTION_NAMES.length + CAPABILITY_OPTION_NAMES.length,
    RUN_TOOL_LOOP_OPTION_NAMES.length - 1,
    "配置面 + 能力面 = 白名单减去 config 这个容器本身",
  );
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(CONFIG_NAMESPACE_OPTION_NAME), true);
});

test("A2 别名 = schema 路径：每个配置键恰好一条路径，叶子名逐字等于顶层键名", () => {
  assert.equal(CONFIG_ALIAS_PATHS.size, CONFIG_SURFACE_OPTION_NAMES.length, "一个配置键一条路径，不多不少");
  for (const key of CONFIG_SURFACE_OPTION_NAMES) {
    const path = configPathForOption(key);
    assert.equal(typeof path, "string", `${key} 必须有 schema 路径`);
    assert.equal(path, `${path.split(".")[0]}.${key}`, `${key} 的路径叶子必须逐字等于键名（不许重命名）`);
    assert.equal(CONFIG_ALIAS_PATHS.get(path), key, `${path} 必须展开回 ${key}`);
    // 分组名必须是真的分组，且该组确实声明了这个叶子（派生关系的反向核对）。
    const [group, leaf] = path.split(".");
    assert.equal(CONFIG_NAMESPACE_GROUPS.includes(group), true, `${group} 必须是已知分组`);
    assert.equal(CONFIG_NAMESPACE_SCHEMA[group].includes(leaf), true, `${group} 必须声明 ${leaf}`);
  }
  // 能力面一个都不在配置面里（交叉核对，不靠「我记得」）。
  const surface = new Set(CONFIG_SURFACE_OPTION_NAMES);
  for (const name of CAPABILITY_OPTION_NAMES) {
    assert.equal(surface.has(name), false, `${name} 是能力/注入键，不能出现在配置面`);
  }
});

test("A3 自检会咬人：漏分类 / 漏白名单两个方向都红", () => {
  // 方向①：白名单多出一个没分类的键（「加了选项忘了分类」的真实形状）。
  const extra = configSchemaSelfCheck([...RUN_TOOL_LOOP_OPTION_NAMES, "brandNewKnob"]);
  assert.deepEqual(extra, [
    'top-level option "brandNewKnob" is classified nowhere (config surface or capability list)',
  ]);
  // 方向②：schema 里有个键已经不在白名单里了（「删了选项忘了删 schema」）。
  const dropped = configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => name !== "maxRounds"));
  assert.deepEqual(dropped, ['schema names "maxRounds", which is not a top-level option']);
});

// ================================================================ B. 结构等价（判据 1）
test("B1 46 个配置键逐个穷举：config.<group>.<leaf> 展开后与扁平形态逐键深度相等", () => {
  let covered = 0;
  for (const key of CONFIG_SURFACE_OPTION_NAMES) {
    const path = configPathForOption(key);
    const [group] = path.split(".");
    const value = `sweep:${key}`;
    const flat = { [key]: value };
    const nested = { config: { [group]: { [key]: value } } };
    const flatExpanded = expandConfigNamespace(flat);
    const nestedExpanded = expandConfigNamespace(nested);
    assert.deepEqual(nestedExpanded.conflicts, [], `${path} 只给一边时不该有冲突`);
    assert.deepEqual(nestedExpanded.options, flatExpanded.options, `${path} 展开后必须与扁平形态逐键相等`);
    assert.deepEqual(nestedExpanded.options, flat, `${path} 展开后必须回到扁平形态`);
    assert.equal(Object.hasOwn(nestedExpanded.options, "config"), false, `${path} 展开后 config 必须消失`);
    // 迁移场景（等价 + 优先级同一条断言）：这个键以前写在扁平、现在挪到 config，其余照旧 ⇒
    // 展开结果必须与「只用扁平新值」逐键相等。优先级反转（让扁平赢）会在这里红。
    const mixed = expandConfigNamespace({ [key]: `stale:${key}`, config: { [group]: { [key]: value } } });
    assert.deepEqual(mixed.options, flat, `${path} 混合写法（扁平旧值 + config 新值）必须等于只用扁平新值`);
    assert.deepEqual(mixed.conflicts, [{ path, key }], `${path} 混合写法必须记一条冲突`);
    covered += 1;
  }
  assert.equal(covered, 46, "穷举必须覆盖全部 46 个配置键（漏一个就少一条等价证明）");
});

/** 跨 10 个分组的代表性配置：同一个 `VALUES` 同时生成扁平形态与 config 形态。 */
const VALUES = {
  system: "you are a test",
  cacheStablePrefix: false,
  initialUserMessage: "go",
  initialMessages: [],
  wrapup: false,
  maxRounds: 3,
  maxTokenContinuations: 2,
  stallDetection: false,
  completion: false,
  replayPolicy: "per-tool-declaration",
  invalidArguments: "execute",
  partialPersistence: false,
  outputHygiene: false,
  writeToolNames: ["writeFile"],
  writeToolPathKeys: ["path"],
  resume: false,
  stream: false,
  maxTokens: 512,
  temperature: 0.2,
  topP: 0.9,
  cacheCapable: false,
  timeoutMs: 1000,
  deadlineMs: 2000,
  context: { budgetTokens: 1000, keepRounds: 2 },
  toolResultTtl: 1,
  toolResultFoldMinTokens: 10,
  reflection: false,
  retry: false,
  finalGuardMaxRetries: 1,
  finalGuardTimeoutMs: 5000,
  finalGuardExtend: false,
  deliverables: [],
  expert: "expert",
  user: "user",
  task: "task",
  requestId: "req-497",
  toolContext: { a: 1 },
  onRound: () => {},
  onJudge: () => {},
  onToolResult: () => {},
  onDelta: () => {},
  onReasoningDelta: () => {},
  onToolCall: () => {},
  onUsage: () => {},
  onFoldSummary: () => {},
};

/** 把 `VALUES` 摊成 `config: { … }` 形态（分组从 schema 派生，不手写）。 */
function nestedConfigShape(values) {
  const config = {};
  for (const [key, value] of Object.entries(values)) {
    const path = configPathForOption(key);
    assert.equal(typeof path, "string", `${key} 必须有 schema 路径`);
    const [group, leaf] = path.split(".");
    assert.equal(leaf, key);
    config[group] = { ...(config[group] ?? {}), [key]: value };
  }
  return config;
}

test("B2 端到端结构等价：扁平形态与 config 形态规范化后的 effectiveOptions 逐键深度相等", async () => {
  const nestedConfig = nestedConfigShape(VALUES);
  assert.deepEqual(Object.keys(nestedConfig).sort(), [...CONFIG_NAMESPACE_GROUPS].sort(), "全部分组都被这份样本覆盖");

  const flat = await normalizeRunToolLoopOptions({ ...VALUES });
  const nested = await normalizeRunToolLoopOptions({ config: nestedConfig });

  assert.deepEqual(nested.effectiveOptions, flat.effectiveOptions);
  // 逐键再说一遍（deepEqual 之外的可读断言：哪一科不对，报错就点名哪一科）。
  assert.deepEqual(Object.keys(nested.effectiveOptions).sort(), Object.keys(flat.effectiveOptions).sort());
  for (const [key, value] of Object.entries(flat.effectiveOptions)) {
    assert.deepEqual(nested.effectiveOptions[key], value, `${key} 两种形态必须逐键相等`);
  }
  assert.equal(Object.hasOwn(nested.effectiveOptions, "config"), false, "config 不得漏进 effectiveOptions");
  assert.equal(Object.hasOwn(nested.explicitOptions, "config"), false, "config 不得漏进 explicitOptions");
  assert.deepEqual(nested.configConflicts, []);
});

test("B3 config 形态真的被引擎读：maxRounds 经 config 生效（不是「展开了但没人读」）", async () => {
  const result = await runDirect({ config: { run: { maxRounds: 1 } } });
  assert.equal(result.rounds, 1);
  assert.equal(result.termination.reason, "end_turn");
});

// ================================================================ C. 优先级与冲突（判据 2）
test("C1 同名时 config 赢，并记一条冲突（规范化层）", async () => {
  const { effectiveOptions, configConflicts } = await normalizeRunToolLoopOptions({
    maxRounds: 9,
    temperature: 0.1,
    config: { run: { maxRounds: 5 }, tuning: { temperature: 0.1 } },
  });
  assert.equal(effectiveOptions.maxRounds, 5, "config.run.maxRounds 覆盖扁平 maxRounds");
  assert.equal(effectiveOptions.temperature, 0.1, "值相同时照旧生效");
  assert.deepEqual(configConflicts, [{ path: "run.maxRounds", key: "maxRounds" }], "只有值不同才算冲突");
});

test("C2 优先级的行为证据：扁平 maxRounds=1 + config maxRounds=2 ⇒ 两轮跑完（不是 max_rounds_cap）", async () => {
  const twoRounds = [
    {
      content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "x" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const tools = [{
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }];
  // 先证样本本身有效：扁平 maxRounds=1 撑不到第二轮（这就是「config 赢」的可观测差异）。
  const flatOnly = await runToolLoop({
    provider: createFakeProvider(twoRounds),
    executeTool: async () => "ok",
    tools,
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  assert.equal(flatOnly.termination.reason, "max_rounds_cap", "样本自证：扁平 1 轮就到顶");

  const events = [];
  const both = await runToolLoop({
    provider: createFakeProvider(twoRounds),
    executeTool: async () => "ok",
    tools,
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 1,
    config: { run: { maxRounds: 2 } },
    onEvent: (event) => events.push(event),
  });
  assert.equal(both.termination.reason, "end_turn", "config 的 2 轮必须真的生效");
  const conflicts = events.filter((event) => event.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, "冲突事件恰好一条");
  assert.deepEqual(conflicts[0].conflicts, [{ path: "run.maxRounds", key: "maxRounds" }]);
  assert.equal(typeof conflicts[0].detail, "string");
  assert.equal(conflicts[0].runId, undefined, "没给 runId 时不编造字段");
});

test("C3 冲突事件不发的情况：只给一边、或两边值相同", async () => {
  const events = [];
  await runDirect({ config: { run: { maxRounds: 2 } }, onEvent: (event) => events.push(event) });
  await runDirect({ maxRounds: 2, onEvent: (event) => events.push(event) });
  await runDirect({ maxRounds: 2, config: { run: { maxRounds: 2 } }, onEvent: (event) => events.push(event) });
  assert.deepEqual(
    events.filter((event) => event.type === "config_override_conflict"),
    [],
    "只有「两边都给了且值不同」才发事件",
  );
});

test("C4 冲突事件的观察者抛错被隔离：run 照旧跑完，错误经 onObserverError 记账", async () => {
  const observerErrors = [];
  const result = await runDirect({
    maxRounds: 9,
    config: { run: { maxRounds: 2 } },
    onEvent: (event) => {
      if (event.type === "config_override_conflict") throw new Error("observer boom");
    },
    onObserverError: (error, context) => observerErrors.push({ error, context }),
  });
  assert.equal(result.termination.reason, "end_turn", "观察者抛错不得改变终局");
  assert.equal(observerErrors.length, 1, "恰好记一笔");
  assert.equal(observerErrors[0].context.channel, "onEvent");
  assert.equal(observerErrors[0].context.type, "config_override_conflict");
});

test("C5 config 叶子的 undefined 逐字等于「没给」：不覆盖扁平值、也不算冲突", async () => {
  const { effectiveOptions, configConflicts } = await normalizeRunToolLoopOptions({
    maxRounds: 7,
    config: { run: { maxRounds: undefined } },
  });
  assert.equal(effectiveOptions.maxRounds, 7);
  assert.deepEqual(configConflicts, []);
});

// ================================================================ D. 能力面不收配置覆盖（判据 3）
test("D1 19 个能力/注入键写进 config 顶层 ⇒ 启动即抛，点名该键，via=direct", async () => {
  assert.equal(CAPABILITY_OPTION_NAMES.length, 19);
  for (const name of CAPABILITY_OPTION_NAMES) {
    const error = await directError({ config: { [name]: null } });
    assert.equal(error instanceof TypeError, true, `${name} 必须启动即抛 TypeError`);
    assert.match(error.message, new RegExp(`config\\.${name} is not accepted`, "u"), `${name} 的报错必须点名该键`);
    assert.match(error.message, /capability\/injection option/u, `${name} 的报错必须说明是能力/注入面`);
    assert.match(error.message, /cannot be overridden through the config namespace/u);
    assert.equal(error.via, "direct", `${name} 的路线标签必须是 direct`);
  }
});

test("D2 能力键写在分组里 ⇒ 同一套规则（config.<group>.<capability> 也拒）", async () => {
  for (const name of CAPABILITY_OPTION_NAMES) {
    const error = await directError({ config: { run: { [name]: null } } });
    assert.equal(error instanceof TypeError, true, `${name} 在组内也必须抛`);
    assert.match(error.message, new RegExp(`config\\.run\\.${name} is not accepted`, "u"));
    assert.equal(error.via, "direct");
  }
});

test("D3 装配口路线的 policy.config 走同一棵树：能力键 via=assembly，合法叶子照常生效", async () => {
  const error = await assemblyError({ config: { provider: null } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /config\.provider is not accepted/u);
  assert.equal(error.via, "assembly", "装配口路线的路线标签必须是 assembly");
  // 构造期就抛（不必等到 run）：`createAssemblyPort` 直接调用同样抛，via 相同。
  assert.throws(
    () => makePort({ config: { provider: null } }),
    (thrown) => thrown instanceof TypeError
      && /config\.provider is not accepted/u.test(thrown.message)
      && thrown.via === "assembly",
    "policy.config 的名称闸口必须在构造期就抛",
  );

  const port = makePort({ config: { run: { maxRounds: 1 } } });
  const result = await runToolLoop({ assemblyPort: port, completion: false, wrapup: false });
  assert.equal(result.rounds, 1);
  assert.equal(result.termination.reason, "end_turn");
});

test("D4 既有 overrides 语义一字未动：显式 provider 仍能盖端口 provider（契约承诺）", async () => {
  const port = makePort({});
  const result = await runToolLoop({
    assemblyPort: port,
    provider: createFakeProvider([{ content: [{ type: "text", text: "explicit" }], stopReason: "end_turn" }]),
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  assert.equal(result.finalText, "explicit");
});

// ================================================================ E. #496 的闸口吃展开后的表示（判据 5）
test("E1 config 里的 context 拼错旋钮名 ⇒ 抛，且与扁平形态同一句（只差 via）", async () => {
  const flatError = await directError({ context: { budgetTokens: 1000, summarizeBudgetMs: 5 } });
  const nestedError = await directError({
    config: { folding: { context: { budgetTokens: 1000, summarizeBudgetMs: 5 } } },
  });
  assert.equal(flatError instanceof TypeError, true);
  assert.equal(nestedError instanceof TypeError, true);
  assert.match(nestedError.message, /unknown assembly policy context option: "summarizeBudgetMs"/u);
  assert.equal(nestedError.message, flatError.message, "两条形态必须抛同一句");
  assert.equal(nestedError.via, "direct");
});

test("E2 装配口路线的 policy.config.folding.context 走同一道语义相（via=assembly）", async () => {
  const error = await assemblyError({ config: { folding: { context: { summarizerBudgetMs: 0 } } } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /summarizerBudgetMs must be a positive integer/u);
  assert.equal(error.via, "assembly");
});

test("E3 合法 config 值不被误杀：context / 回调形状都过", async () => {
  const result = await runDirect({
    config: {
      folding: { context: { budgetTokens: 1000, summarizerBudgetMs: 5000 } },
      guard: { finalGuard: async () => ({ action: "accept" }) },
      observers: { onFoldSummary: () => {} },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
});

test("E4 config 里的回调给错型 ⇒ 与扁平形态同一句（语义相管到 config 展开后的键）", async () => {
  const flatError = await directError({ finalGuard: "nope" });
  const nestedError = await directError({ config: { guard: { finalGuard: "nope" } } });
  assert.equal(nestedError.message, flatError.message);
  assert.match(nestedError.message, /finalGuard must be a function \(or omitted\)/u);
  assert.equal(nestedError.via, "direct");
});

// ================================================================ F. 名称/形状闸口（早于端口读取）
test("F1 未知分组 / 未知叶子 / 扁平键写进 config / 组内放错位置，四种都点名", async () => {
  const unknownGroup = await directError({ config: { rund: { maxRounds: 1 } } });
  assert.match(unknownGroup.message, /unknown config namespace: "rund"/u);
  assert.match(unknownGroup.message, /accepted: prompt, run, tuning, timing, folding, guard, metadata, observers/u);

  const unknownLeaf = await directError({ config: { run: { maxRond: 1 } } });
  assert.match(unknownLeaf.message, /unknown config\.run option: "maxRond"/u);
  assert.match(unknownLeaf.message, /accepted: maxRounds, maxTokenContinuations/u);

  const flatInside = await directError({ config: { maxRounds: 1 } });
  assert.match(flatInside.message, /config\.maxRounds: flat option keys are not accepted at the top of config/u);
  assert.match(flatInside.message, /write config\.run\.maxRounds instead/u);

  const misplaced = await directError({ config: { run: { temperature: 0.2 } } });
  assert.match(misplaced.message, /unknown config\.run option: "temperature"/u);
  assert.match(misplaced.message, /"temperature" belongs to config\.tuning\.temperature/u);

  for (const error of [unknownGroup, unknownLeaf, flatInside, misplaced]) {
    assert.equal(error instanceof TypeError, true);
    assert.equal(error.via, "direct");
  }
});

test("F2 config 自己的形状：null / 数组 / 字符串 / 分组不是对象 都抛", async () => {
  const cases = [
    [{ config: null }, /config must be an object \(or omitted\)/u],
    [{ config: [] }, /config must be an object \(or omitted\)/u],
    [{ config: "nested" }, /config must be an object \(or omitted\)/u],
    [{ config: { run: "fast" } }, /config\.run must be an object/u],
    [{ config: { run: null } }, /config\.run must be an object/u],
  ];
  for (const [options, pattern] of cases) {
    const error = await directError(options);
    assert.equal(error instanceof TypeError, true, JSON.stringify(options));
    assert.match(error.message, pattern);
    assert.equal(error.via, "direct");
  }
  // `config: undefined` 逐字等于省略（与既有合并规则同口径）。
  const result = await runDirect({ config: undefined });
  assert.equal(result.termination.reason, "end_turn");
});

test("F3 config 名称错误在读任何宿主端口之前抛（Proxy 钉住端口未被触碰）", async () => {
  const touched = [];
  const proxyPort = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`assembly port was read before the config check: ${String(property)}`);
    },
  });
  const error = await runToolLoop({ assemblyPort: proxyPort, config: { provider: null } })
    .then(() => null, (caught) => caught);
  assert.equal(error instanceof TypeError, true, `实际抛：${error && error.message}`);
  assert.match(error.message, /config\.provider is not accepted/u);
  assert.deepEqual(touched, [], "配置名称错误必须早于任何端口读取");
});

// ================================================================ G. 纯函数契约（不依赖引擎）
test("G1 collectConfigNamespaceProblems 是纯函数：问题清单不抛、可逐条断言", () => {
  assert.deepEqual(collectConfigNamespaceProblems(undefined), ["config must be an object (or omitted)"]);
  assert.deepEqual(collectConfigNamespaceProblems({ run: { maxRounds: 1 } }), []);
  assert.deepEqual(
    collectConfigNamespaceProblems({ run: { provider: null }, tuning: { nope: 1 } }),
    [
      'config.run.provider is not accepted: "provider" is a capability/injection option,'
        + " and the capability surface cannot be overridden through the config namespace"
        + " (pass it as a top-level option or through the assembly port)",
      'unknown config.tuning option: "nope" (accepted: maxTokens, temperature, topP, cacheCapable)',
    ],
  );
});

test("G2 expandConfigNamespace 不改入参：返回新对象，原 options 原样保留", () => {
  const options = { maxRounds: 1, config: { run: { maxRounds: 2 } } };
  const { options: expanded } = expandConfigNamespace(options);
  assert.notEqual(expanded, options);
  assert.equal(expanded.maxRounds, 2);
  assert.equal(options.maxRounds, 1, "入参不得被改写");
  assert.deepEqual(options.config, { run: { maxRounds: 2 } }, "入参的 config 不得被删");
});
