// @ts-check
// issue #497（S2）—— `config: { … }` 嵌套命名空间：**别名 = schema 路径**，不是第二张映射表。
//
// 病根（母单 #495）：同一个 run 的配置住在两个命名空间——顶层 65 个选项里的配置键，加上装配口
// `policy` 里仅存的两个。宿主要给「一次 run 的旋钮」时没有一棵可读的树，也没有一个可以整体
// 校验/序列化/文档化的形状。本模块给出那棵树。
//
// 设计约束（本单的验收判据）：
//   1. **别名 = schema 路径**。`config.run.maxRounds` 与顶层 `maxRounds` 是同一个键的两种写法，
//      叶子名**逐字等于**顶层键名 ⇒ 展开就是「去掉路径前缀」，没有重命名表。谁也别想在这里
//      加一条「`config.run.rounds` → `maxRounds`」的别名——那会立刻多出第二套名字。
//   2. **只有一张表**。分组表 `CONFIG_NAMESPACE_SCHEMA` 是唯一手写的部分；展开映射
//      (`CONFIG_ALIAS_PATHS`)、配置面名单 (`CONFIG_SURFACE_OPTION_NAMES`) 都从它机械派生。
//      完整性由 `configSchemaSelfCheck()` 对着 `RUN_TOOL_LOOP_OPTION_NAMES` 核：
//      每个顶层选项必须**恰好**落在「配置面」或「能力/注入面」之一（漏一个、重一个都算问题）。
//      于是「往白名单加一个选项但忘了分类」不会静默——它会让自检报红（见
//      `test/loop-config-namespace-497.test.js`）。
//   3. **能力/注入面不接受配置覆盖**（母单裁决）。`provider` / `tools` / `store` / `session` /
//      `signal` / 回调出口 … 这 19 项是宿主**递进来的东西**，不是引擎解释的值：写进 `config`
//      一律启动即抛，报错点名该键。注意这条**只作用于新命名空间**——既有
//      `overrides` / `withOverrides` 的「显式覆盖能盖 provider」是已发布契约
//      （`test/contract/assembly-port.js` 有断言），本单一个字都没改。
//
// 优先级（范围 2）：同名时 `config.*` 覆盖顶层扁平键；顶层扁平键继续接受、行为一字不变。
// 冲突不静默——`expandConfigNamespace` 把「同一个键两种写法给了不同的值」记进 `conflicts`，
// 由 orchestrator 发一条 `config_override_conflict` 事件（唯一的发射点，与 #469 的
// `context_unknown_option` 同口径：观察者抛错不得影响 run）。
//
// 零运行时依赖：只用相对路径 + `node:` 内置。

import { isDeepStrictEqual } from "node:util";

import { tagValidationRoute } from "../assembly-validators.js";

/**
 * 配置面的**唯一手写表**：分组 → 该组接受的叶子名。
 *
 * 叶子名必须逐字等于 `RUN_TOOL_LOOP_OPTION_NAMES` 里的顶层键名（见文件头约束 1）。
 * 分组的判据是「引擎里由谁消费」：同一子系统/同一生命周期阶段的旋钮放在一起，于是
 * `config.folding.*` 全是压缩与折叠、`config.guard.*` 全是强制收尾、`config.observers.*`
 * 全是宿主观察者回调。分组本身**不参与语义**（展开后一律回到顶层扁平键），它只影响可读性、
 * 报错文案与文档。
 *
 * 45 个配置键的分类草稿在 `docs/delivery/analysis-261023-406-normalization-design.md`
 * （15 run + 10 tuning 核心 + 10 folding + 10 其它）——该文件在本仓库树上**不存在**（`docs/delivery/`
 * 是 gitignore 的本机档案目录），所以这里的分组是照代码实测重新分类的结果，不是照抄草稿。
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CONFIG_NAMESPACE_SCHEMA = Object.freeze({
  // 提示词与输入种子：一次 run 开头就定下来的那几块文本/开关。
  prompt: Object.freeze([
    "system",
    "cacheStablePrefix",
    "initialUserMessage",
    "initialMessages",
    "wrapup",
  ]),
  // 轮次与循环控制：跑多久、什么算卡住、什么时候续、什么时候停、中途治理（judge/扩轮）。
  run: Object.freeze([
    "maxRounds",
    "maxTokenContinuations",
    "stallDetection",
    "completion",
    "replayPolicy",
    "invalidArguments",
    "partialPersistence",
    "outputHygiene",
    "writeToolNames",
    "writeToolPathKeys",
    "resume",
    "stream",
    "reflection",
  ]),
  // 请求侧的取值：每一发模型调用都带上的采样参数与端点能力。
  tuning: Object.freeze([
    "maxTokens",
    "temperature",
    "topP",
    "cacheCapable",
  ]),
  // 时间预算：单发超时、整条 run 的死线、以及失败重试的退避（强制收尾自己的超时在 guard 组）。
  timing: Object.freeze([
    "timeoutMs",
    "deadlineMs",
    "retry",
  ]),
  // 压缩与折叠：预算、策略、工具结果的生命周期。
  folding: Object.freeze([
    "context",
    "toolResultTtl",
    "toolResultFoldMinTokens",
  ]),
  // 强制收尾（final guard）与交付物判据。
  guard: Object.freeze([
    "finalGuard",
    "finalGuardMaxRetries",
    "finalGuardTimeoutMs",
    "finalGuardExtend",
    "deliverables",
  ]),
  // 宿主私有元数据（透传/拼进 payload，引擎不解释其内部结构）。
  metadata: Object.freeze([
    "expert",
    "user",
    "task",
    "requestId",
    "toolContext",
  ]),
  // 宿主观察者回调（纯观察；`onToolResult` 是改写钩子，但它同样是「宿主给的东西」而不是值）。
  observers: Object.freeze([
    "onRound",
    "onJudge",
    "onToolResult",
    "onDelta",
    "onReasoningDelta",
    "onToolCall",
    "onUsage",
    "onFoldSummary",
  ]),
});

/**
 * 能力/注入面（19 项）：宿主**递进来**的适配器、状态源、身份、环境与出口，不是引擎解释的值。
 *
 * 判据（为什么这 19 个、不是别的）：删掉它整个 run 跑不起来（适配器/身份），或者它把**外部世界**
 * 带进引擎（状态源、中止信号、工作目录、持久化模式），或者它是**错误/事件出口**（回调抛错的
 * 记账与投递面）。`config` 里出现其中任何一个 ⇒ 启动即抛（母单裁决）。
 *
 * ⚠ 这条收窄**只作用于新命名空间**：既有 `overrides` / `withOverrides` 的「显式覆盖能盖 provider」
 * 是已发布契约（`test/contract/assembly-port.js` 有断言），本单不改。
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_OPTION_NAMES = Object.freeze([
  // 适配器（装配口成员）
  "assemblyPort",
  "provider",
  "tools",
  "executeTool",
  "store",
  "modelConfig",
  // 身份 / 环境 / 持久化模式
  "session",
  "runId",
  "signal",
  "cwd",
  "persistence",
  // 宿主带来的元数据与状态源
  "model",
  "modelMetadata",
  "todoStateProvider",
  "semanticStateProvider",
  // 错误 / 事件出口
  "onEvent",
  "onObserverError",
  "onPersistenceError",
  "diagnostics",
]);

/** 配置面的分组名（顺序即报错文案里的枚举顺序）。 */
export const CONFIG_NAMESPACE_GROUPS = Object.freeze(Object.keys(CONFIG_NAMESPACE_SCHEMA));

/**
 * 命名空间自己的顶层键名。它是**容器**，不属于配置面也不属于能力面——展开后它就消失了，
 * 所以 `configSchemaSelfCheck` 把它排除在「必须分类」的集合之外（但要求它确实在顶层白名单里）。
 */
export const CONFIG_NAMESPACE_OPTION_NAME = "config";

/**
 * 展开后的**别名表**：`"<group>.<leaf>"` → 顶层键名。
 *
 * 机械派生（叶子名逐字等于顶层键名），不是手写映射：加一个键只需在
 * `CONFIG_NAMESPACE_SCHEMA` 里把它放进某一组，别名自动出现。
 *
 * @type {ReadonlyMap<string, string>}
 */
export const CONFIG_ALIAS_PATHS = new Map(
  CONFIG_NAMESPACE_GROUPS.flatMap((group) => CONFIG_NAMESPACE_SCHEMA[group].map((leaf) => [`${group}.${leaf}`, leaf])),
);

/** 配置面的顶层键全集（派生：schema 的扁平并集，顺序 = 分组顺序 + 组内顺序）。 */
export const CONFIG_SURFACE_OPTION_NAMES = Object.freeze(
  CONFIG_NAMESPACE_GROUPS.flatMap((group) => [...CONFIG_NAMESPACE_SCHEMA[group]]),
);

const CONFIG_SURFACE_OPTION_SET = new Set(CONFIG_SURFACE_OPTION_NAMES);
const CAPABILITY_OPTION_SET = new Set(CAPABILITY_OPTION_NAMES);
const CONFIG_GROUP_SET = new Set(CONFIG_NAMESPACE_GROUPS);

/**
 * 某个顶层配置键的 schema 路径（`maxRounds` → `"run.maxRounds"`），不属配置面时返回 undefined。
 *
 * @param {string} optionName
 * @returns {string|undefined}
 */
export function configPathForOption(optionName) {
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    if (CONFIG_NAMESPACE_SCHEMA[group].includes(optionName)) return `${group}.${optionName}`;
  }
  return undefined;
}

/**
 * schema 自检：每个顶层选项必须**恰好**落在配置面或能力/注入面之一。
 *
 * 这条自检是「只有一张表」的锁：新增一个顶层选项却忘了分类 ⇒ 这里报「未分类」；
 * 同一个键同时出现在两处（或同一组里出现两次）⇒ 这里报「重复」。测试对着
 * `RUN_TOOL_LOOP_OPTION_NAMES` 跑它，于是白名单与 schema 不可能各改各的。
 *
 * @param {readonly string[]} optionNames 顶层选项白名单（`RUN_TOOL_LOOP_OPTION_NAMES`）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function configSchemaSelfCheck(optionNames) {
  const problems = [];
  const seen = new Map();
  for (const name of CONFIG_SURFACE_OPTION_NAMES) {
    const previous = seen.get(name);
    if (previous !== undefined) {
      problems.push(`config surface lists ${JSON.stringify(name)} twice (also in ${JSON.stringify(previous)})`);
      continue;
    }
    seen.set(name, configPathForOption(name));
    if (CAPABILITY_OPTION_SET.has(name)) {
      problems.push(`${JSON.stringify(name)} is both a config surface key and a capability option`);
    }
  }
  const capabilitySeen = new Set();
  for (const name of CAPABILITY_OPTION_NAMES) {
    if (capabilitySeen.has(name)) problems.push(`capability list repeats ${JSON.stringify(name)}`);
    capabilitySeen.add(name);
  }
  for (const name of optionNames) {
    if (name === CONFIG_NAMESPACE_OPTION_NAME) continue;
    if (!CONFIG_SURFACE_OPTION_SET.has(name) && !CAPABILITY_OPTION_SET.has(name)) {
      problems.push(`top-level option ${JSON.stringify(name)} is classified nowhere (config surface or capability list)`);
    }
  }
  if (!optionNames.includes(CONFIG_NAMESPACE_OPTION_NAME)) {
    problems.push(`top-level options do not accept ${JSON.stringify(CONFIG_NAMESPACE_OPTION_NAME)} (the config namespace itself)`);
  }
  for (const name of [...CONFIG_SURFACE_OPTION_NAMES, ...CAPABILITY_OPTION_NAMES]) {
    if (!optionNames.includes(name)) {
      problems.push(`schema names ${JSON.stringify(name)}, which is not a top-level option`);
    }
  }
  return problems;
}

/**
 * `config` 命名空间的**名称/形状**问题（纯函数，不抛）。
 *
 * 三类问题分开说，因为它们的修法不同：
 *   · 能力/注入键 ⇒ 这条路本来就不该走（配置面不接受能力覆盖）；
 *   · 扁平键写进了 config ⇒ 教他写成 `config.<group>.<key>`（路径由 schema 派生）；
 *   · 真·未知的名字 ⇒ 报「未知」并枚举该层接受的名单。
 *
 * @param {unknown} config `config` 的值（调用方已确认它不是 undefined）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function collectConfigNamespaceProblems(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be an object (or omitted)"];
  }
  const problems = [];
  for (const [group, value] of Object.entries(/** @type {Record<string, unknown>} */ (config))) {
    if (CAPABILITY_OPTION_SET.has(group)) {
      problems.push(capabilityProblemMessage(`config.${group}`, group));
      continue;
    }
    const path = configPathForOption(group);
    if (path !== undefined) {
      problems.push(
        `config.${group}: flat option keys are not accepted at the top of config`
        + ` (write config.${path} instead)`,
      );
      continue;
    }
    if (!CONFIG_GROUP_SET.has(group)) {
      problems.push(
        `unknown config namespace: ${JSON.stringify(group)}`
        + ` (accepted: ${CONFIG_NAMESPACE_GROUPS.join(", ")})`,
      );
      continue;
    }
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`config.${group} must be an object`);
      continue;
    }
    for (const leaf of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
      if (CAPABILITY_OPTION_SET.has(leaf)) {
        problems.push(capabilityProblemMessage(`config.${group}.${leaf}`, leaf));
        continue;
      }
      if (!CONFIG_NAMESPACE_SCHEMA[group].includes(leaf)) {
        const misplaced = configPathForOption(leaf);
        problems.push(
          `unknown config.${group} option: ${JSON.stringify(leaf)}`
          + (misplaced === undefined
            ? ` (accepted: ${CONFIG_NAMESPACE_SCHEMA[group].join(", ")})`
            : ` (${JSON.stringify(leaf)} belongs to config.${misplaced})`),
        );
      }
    }
  }
  return problems;
}

/**
 * 能力/注入键的统一文案：点名该键，并说清「能力面不接受配置覆盖」。
 *
 * @param {string} path
 * @param {string} name
 * @returns {string}
 */
function capabilityProblemMessage(path, name) {
  return `${path} is not accepted: ${JSON.stringify(name)} is a capability/injection option,`
    + " and the capability surface cannot be overridden through the config namespace"
    + " (pass it as a top-level option or through the assembly port)";
}

/**
 * 名称/形状闸口：问题非空就抛 `TypeError`（贴路线标签，与 #496 的语义相同一口径）。
 *
 * @param {unknown} config
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {void}
 */
export function assertConfigNamespace(config, route = {}) {
  if (config === undefined) return;
  const problems = collectConfigNamespaceProblems(config);
  if (problems.length === 0) return;
  throw tagValidationRoute(new TypeError(problems.join("; ")), route.via);
}

/**
 * 展开 `config` 命名空间：把每个叶子写回它的顶层扁平键，并记下**冲突**。
 *
 * 展开规则（逐条都是本单的验收判据）：
 *   · `config.<group>.<leaf>` 与顶层 `<leaf>` 是同一个键 ⇒ 展开后只剩顶层那个键；
 *   · 同名时 **config 赢**（范围 2 的优先级），顶层扁平键继续接受、行为不变；
 *   · 叶子的 `undefined` 逐字等于「没给」（与既有合并规则 `value !== undefined` 同口径），
 *     于是它既不覆盖扁平值、也不算冲突；
 *   · 两边都给了**不同的值** ⇒ 记一条冲突（由调用方发事件，不许静默）；
 *   · `config` 本身从展开结果里消失（下游看到的仍是一份扁平表示，#496 的语义相闸口
 *     因此对 config 里写的值一视同仁）。
 *
 * 返回新对象，不改入参。
 *
 * @param {Record<string, any>} options 合并后的选项表示（可能带 `config`）
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {{
 *   options: Record<string, any>,
 *   conflicts: Array<{path: string, key: string}>,
 * }} `conflicts` 里只放路径与键名：值可能是函数/大对象，不进事件载荷。
 */
export function expandConfigNamespace(options, route = {}) {
  const config = options.config;
  if (config === undefined) return { options, conflicts: [] };
  assertConfigNamespace(config, route);
  const expanded = { ...options };
  delete expanded.config;
  const conflicts = [];
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    const bag = /** @type {Record<string, any>|undefined} */ (config[group]);
    if (bag === undefined) continue;
    for (const [key, value] of Object.entries(bag)) {
      if (value === undefined) continue;
      const flatValue = expanded[key];
      if (flatValue !== undefined && !isDeepStrictEqual(flatValue, value)) {
        conflicts.push({ path: `${group}.${key}`, key });
      }
      expanded[key] = value;
    }
  }
  return { options: expanded, conflicts };
}
