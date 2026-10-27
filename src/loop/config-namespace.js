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
//   3. **能力/注入面不接受配置覆盖**（母单裁决），而**这条面的判据是行为、不是「引擎不解释」**
//      （#497 复审 R1 更正：旧判据「能力面 = 引擎不解释其值」是**假的**——`session` 的
//      `id`/`modelSlot`/`resume`/`initialMessages` 都被读，`model`/`modelMetadata` 的
//      `contextWindowTokens`/`maxOutputTokens` 数字被拿去算预算，`persistence` 的字面量被校验
//      并决定整条持久化路径。按旧判据分类等于把四个**配置**键锁在配置树外面）。
//      现判据（中英成对地写在契约里，见 `docs/host-consumer-contract{,_cn}.md` 的
//      「config 命名空间 / The `config` namespace」一节）：
//        · **能力面** = 宿主提供的**行为载体**（函数 / 端口对象）与身份/环境注入，引擎**调用或
//          解引用**它（端口方法被调、信号被监听、身份与环境被原样带进事件与 payload）；
//        · **配置面** = 引擎**按已知字段校值并解释**的数据（枚举字面量、数字、布尔、结构已知的
//          对象）。
//      于是 `provider` / `tools` / `store` / `modelConfig` / `signal` / 回调出口 … 这 15 项写进
//      `config` 一律启动即抛，报错点名该键。注意这条**只作用于新命名空间**——显式细粒度选项
//      覆盖装配口同名成员（`resolveAssemblyMember`（`src/assembly.js`））是既有行为，
//      `test/contract/assembly-port.js` 有断言，本单一个字都没改。
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
 * 现表共 **50 键 / 8 组**（草稿的 45 键 + #497 复审 R1 按新判据从能力面移进来的
 * `persistence`（→ `run`）与 `model` / `modelMetadata` / `session`（→ `metadata`））。
 * 现表共 **50 键 / 8 组**（草稿的 45 键 + #497 复审 R1 按新判据从能力面移进来的
 * `persistence`（→ `run`）与 `model` / `modelMetadata` / `session`（→ `metadata`））。
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
  // 轮次与循环控制：跑多久、什么算卡住、什么时候续、什么时候停、中途治理（judge/扩轮）、
  // 以及持久化**模式**（`persistence` 是「这次 run 要不要落盘」的旋钮，与同组的
  // `partialPersistence` / `replayPolicy` 同族；它以前被错归进能力面，见文件头约束 3）。
  run: Object.freeze([
    "maxRounds",
    "maxTokenContinuations",
    "stallDetection",
    "completion",
    "replayPolicy",
    "invalidArguments",
    "partialPersistence",
    "persistence",
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
  // 宿主带来的数据：引擎**按已知字段**读其中的值，其余键原样透传 / 拼进 payload。
  //   · `model` / `modelMetadata`：`contextWindowTokens` / `maxOutputTokens` 两个数字被读
  //     （`modelMetadataFor`（`src/loop/budget.js`）→ 压缩预算与输出卫生的 15% 窗口钳制）；
  //   · `session`：`id` / `modelSlot` / `resume` / `initialMessages` 被读（启动校验、
  //     `modelConfig.resolve(session?.modelSlot)`、续跑与初始消息）；
  //   · `expert` / `user` / `task` / `requestId` / `toolContext`：拼进工具上下文与 judge 简报。
  // 这五个键里的后五个曾经只有「透传」一面，所以本组以前写成「引擎不解释其内部结构」；
  // 按现判据（文件头约束 3）它们同属配置面，描述按实测改。
  metadata: Object.freeze([
    "expert",
    "user",
    "task",
    "requestId",
    "toolContext",
    "model",
    "modelMetadata",
    "session",
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
 * 能力/注入面（15 项）：宿主**递进来**的行为载体与身份/环境注入。
 *
 * 判据（#497 复审 R1 更正后的版本，与文件头约束 3 同一句话）：**能力面 = 宿主提供的行为载体
 * （函数 / 端口对象）与身份/环境注入，引擎调用或解引用它；配置面 = 引擎按已知字段校值并解释
 * 的数据**。所以这里的成员只有三类：
 *   · 适配器 / 端口对象（方法被引擎调用）：`provider`、`tools`、`executeTool`、`store`、
 *     `modelConfig`、`assemblyPort`、`todoStateProvider`、`semanticStateProvider`；
 *   · 身份与环境（原样带进事件 / payload / 端口）：`runId`、`cwd`；
 *   · 中止信号与错误/事件出口（被监听 / 被调用）：`signal`、`onEvent`、`onObserverError`、
 *     `onPersistenceError`、`diagnostics`。
 *
 * 反例（为什么 `persistence` / `model` / `modelMetadata` / `session` **不在**这里）：引擎读它们的
 * 已知字段并据值改行为（`persistence` 的模式字面量被校验并选持久化路径；`model`/`modelMetadata`
 * 的窗口数字被拿去算预算；`session` 的 `id`/`modelSlot`/`resume`/`initialMessages` 被读）——
 * 那是配置，不是行为载体。
 *
 * `config` 里出现其中任何一个 ⇒ 启动即抛（母单裁决）。
 *
 * ⚠ 这条收窄**只作用于新命名空间**：显式细粒度选项覆盖装配口同名成员
 * （`resolveAssemblyMember`（`src/assembly.js`）；`test/contract/assembly-port.js` 的
 * 「显式细粒度 provider 覆盖端口 provider」断言）是既有行为，本单不改。
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_OPTION_NAMES = Object.freeze([
  // 适配器（装配口成员）/ 端口对象：方法被引擎调用
  "assemblyPort",
  "provider",
  "tools",
  "executeTool",
  "store",
  "modelConfig",
  // 身份 / 环境
  "runId",
  "cwd",
  // 中止信号与状态源
  "signal",
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
 * 两个 `config` 源同时在场时的**逐叶冲突**（#497 复审 R4）。
 *
 * 病根：装配口 `policy.config` 与调用级 `config` 是同一棵树的两个来源，而合并规则是
 * 「后写者胜」——调用级的那份**整棵**覆盖 policy 的那份。语义保留（这是既有合并规则的性质，
 * 不是本单发明的），但覆盖以前**零事件**：policy 里写了 `run.maxRounds: 4`、调用级写了 1，
 * 实测 4 轮变 1 轮、`onEvent` 一条都没收到。而「扁平 vs `config`」的冲突是会发
 * `config_override_conflict` 的，于是同一个引擎里出现两套静默度不同的规则。
 *
 * 本函数只做一件事：把两个源里**同一个叶子路径都给了值、且值不同**的那些叶子列出来，
 * 形状与 `expandConfigNamespace` 的 `conflicts` 逐字一致（`{ path, key }`，只带路径与键名——
 * 值可能是函数/大对象，不进事件载荷）。规则也与扁平冲突逐字同口径：
 *   · 只有一边给了值（另一边 `undefined` 或没有这个键）⇒ **不算冲突**；
 *   · 两边深度相等 ⇒ 不算冲突；
 *   · 顺序 = schema 分组顺序 + 组内顺序（确定、可断言）。
 *
 * 注意「整棵覆盖」的另一面：只写在**被覆盖的那棵树**里的叶子会被丢掉（回到默认值）——那是
 * 既有取值语义的一部分，本函数不改它，只在契约里写清（宿主不该把它当逐叶合并用）。
 *
 * @param {unknown} previousConfig 被覆盖的那棵树（装配口 `policy.config`）
 * @param {unknown} nextConfig 胜出的那棵树（调用级 `config`）
 * @returns {Array<{path: string, key: string}>} 逐叶冲突（空 = 没有可报的）
 */
export function collectConfigSourceConflicts(previousConfig, nextConfig) {
  const conflicts = [];
  if (!isConfigObject(previousConfig) || !isConfigObject(nextConfig)) return conflicts;
  const previous = /** @type {Record<string, any>} */ (previousConfig);
  const next = /** @type {Record<string, any>} */ (nextConfig);
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    const previousBag = previous[group];
    const nextBag = next[group];
    if (!isConfigObject(previousBag) || !isConfigObject(nextBag)) continue;
    for (const key of CONFIG_NAMESPACE_SCHEMA[group]) {
      const previousValue = previousBag[key];
      const nextValue = nextBag[key];
      if (previousValue === undefined || nextValue === undefined) continue;
      if (isDeepStrictEqual(previousValue, nextValue)) continue;
      conflicts.push({ path: `${group}.${key}`, key });
    }
  }
  return conflicts;
}

/** `config` 树的一层是否为「普通对象」（`null` / 数组 / 标量都不是）。 */
function isConfigObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
