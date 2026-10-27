// @ts-check
// issue #498（S4a）—— `capabilities: { hooks: { … } }`：宿主回调的**规范之家**。
// issue #498（S4b）—— 能力面收成**两组**（`hooks` 12 项 + `checks` 1 项），避免 `hooks` 变成口袋：
//   · `capabilities.hooks.finalGuard`：值必须是函数，消费点是 `src/loop/termination.js` 的
//     `callFinalGuard` 里那一行 `finalGuard(payload)`（装配点在 `src/loop/orchestrator.js` 的
//     `ctx.finalGuard`）；同文件的 `hasFinalDraft()` 是强制收尾的私有判定，**与 `finalGuard` 无关**。
//     它一直按判据属能力面，只是 0.27 的配置树把它关在 `config.guard.finalGuard` 里
//     （`config.guard.deliverables` 同理，见下一组）；
//   · `capabilities.checks.deliverables`：每项 `{ name, check }`，`check` 是函数、`name` 是标签。
//     交付物判据以前挂在 `config.guard.deliverables` 上，而它的每一条都带函数 ⇒ 配置面里能写的
//     只有 `[]`（一个「只能写空数组」的过渡态）。本刀把它整键搬进能力面，过渡态随之消失；
//     顶层扁平 `deliverables` 一字未动（它现在就 work）。
// issue #498（S4c）—— 壳内行为载体获得**真实归宿**，能力面收成**三组**（`hooks` / `checks` / `ports`）：
//   · 开 `capabilities.ports`：成员 = 被引擎**解引用或调用**的基础设施与策略实现，`sleepImpl`
//     （定时器注入点，消费点 `retryOptions?.sleepImpl ?? defaultSleep`）、`judgeProvider`（judge
//     专用评估器，接受 callable 或 `{ chat }` 对象）与 `strategy`（压缩策略对象，
//     `resolveCompactionStrategy` 原样透传，`shouldCompact` / `compact` 被引擎调）。
//     它们以前只能写在壳里（`retry.sleepImpl` / `reflection.judge.provider` / `context.strategy`），
//     而壳本身要过 `config` 子树的 JSON round-trip ⇒ 想要 `retry.sleepImpl` 的宿主连**数据半**都
//     没法用 `config.timing.retry`（扁平 `retry` 带函数会与 config 侧冲突）。开 ports 让那些壳
//     **可迁移**，而不是留一条文档没披露的死路。
//   · `hooks` 补 4 个真回调（12 → 16）：`onReflection`（扩轮决策通知）、`onBeforeFold` /
//     `onAfterFold`（折叠前后通知，消费点 `runFoldHook`（`src/compact/helpers.js`））、`stubFor`
//     （逐条消息的桩判定，消费点 `resolveFoldStubs`（同文件））。
//   · 两个**形态多态**旋钮 `protectedMessage` / `recoveryHint`：数据形态（`string` / `string[]`）
//     留在 `config.folding.context`，函数形态进 `capabilities.hooks`。两侧都给了**不等价**的值 ⇒
//     恰一条 `config_override_conflict`（复用同一个容器冲突机制，不新开一条出口）。
//   ⚠ 本刀的 9 个新叶子**一律不给新的顶层扁平别名**：`sleepImpl` / `judgeProvider` / `strategy` /
//   `onReflection` / `onBeforeFold` / `onAfterFold` / `stubFor` / `protectedMessage` / `recoveryHint`
//   从来不是顶层选项，发明的是**容器成员位**，不是搬家 ⇒ 顶层白名单**仍是 67**。它们的家是
//   `CAPABILITY_SLOT_DESTINATIONS`（下表）里登记的**嵌套槽**（`context.onBeforeFold` 这种），
//   而展开结果里它们不进 `effectiveOptions` 的扁平键，而是走 `slots` 侧信道（见
//   `expandCapabilitiesNamespace`）。
//
// 病根（母单 #495 / #497 复审的第二轮披露②）：0.27.0 把 8 个 `on*` 回调塞进 `config.observers`
// 组里，于是 `config` 子树**过不了 JSON round-trip**——函数进去、`undefined` 出来。那条
// 「`config` 子树必须 JSON round-trip 等值」的 0.28 判据与 `config.observers` 的存在**互斥**：
// 只要还有一个回调住在配置树里，判据就只能开例外，而开了例外的判据不再是判据。
//
// 本模块给出的解法是把**面**分开，而不是把值搬来搬去：
//   · **能力面**（`capabilities`）= 宿主递进来的**行为载体**（函数 / 端口对象），引擎调用或解引用它；
//   · **配置面**（`config`）= 引擎**按已知字段校值并解释**的数据，必须过 JSON round-trip。
// 判据的完整表述与反例在 `src/loop/config-namespace.js` 的文件头（约束 3），两处不各写一份。
//
// 设计约束（与 `config` 容器同构，刻意**对称**——两个容器待遇一致是 #498 S4a 的验收判据之一）：
//   1. **别名 = schema 路径**：`capabilities.hooks.onEvent` 与顶层 `onEvent` 是同一个键的两种写法，
//      叶子名逐字等于顶层键名，没有重命名表。**例外（#498 S4c，显式登记）**：9 个「嵌套槽叶子」
//      没有顶层扁平别名（它们从来不是顶层选项），去向写在 `CAPABILITY_SLOT_DESTINATIONS` 里；
//      自检双向核「有槽的叶子不许是顶层选项 / 顶层叶子必须真是选项」，所以这条例外不会退化成
//      「谁都能发明新扁平键」。
//   2. **只有一张表**：分组表 `CAPABILITIES_NAMESPACE_SCHEMA` 是唯一手写的部分，别名表
//      (`CAPABILITIES_ALIAS_PATHS`) 从它机械派生；`configSchemaSelfCheck`（`config-namespace.js`）
//      对着 `RUN_TOOL_LOOP_OPTION_NAMES` 核「能力面 / 配置面 / 容器三向闭合」。
//   3. **未知子键当场抛**（#498 S4a 复审要求）：`capabilities: { hoks: … }` / `capabilities.hooks.onEtent`
//      一律启动即抛并点名**完整路径**。这是新容器最容易漏的静默面——「传错了子键，引擎当没看见」
//      正是 #497 那类「配了等于没配」的病，不许在新容器里重生。
//   4. **函数值的形状也校**：`hooks` 的叶子给了就必须是函数（`undefined` = 未订阅）；`checks` 的
//      叶子给了就必须是 `{ name, check }` 数组（#498 S4b），规则**复用** `normalizeDeliverables`
//      （`src/loop/deliverables.js`）——不在这里手抄第二份。顶层扁平 `onRound: "x"` 的宽容是 0.26
//      已发布面，本刀不动它；新容器从第一天起就不静默。
//   5. **与扁平键冲突不静默**：`capabilities.hooks.onEvent` 与顶层 `onEvent` 都给了不同的值 ⇒
//      记一条 `{ path: "hooks.onEvent", key: "onEvent" }`，由 orchestrator 经**同一条**
//      `config_override_conflict` 事件发出去（事件类型不新增：它说的就是「一个旋钮两个真相来源」，
//      只是 path 前缀不同）。capabilities 侧赢（与 `config.*` 对扁平键的优先级同向）。
//
// 适配器端口对象（`provider` / `tools` / `store` / `signal` …）**不在** `capabilities.ports` 里：
// `tools` 在 #498 S4b 归到配置面（`config.input.tools`，它是数据），其余留在顶层选项 / 装配口。
// 写 `capabilities.provider` 仍会抛（并说明端口对象留在哪里）——绝不静默放行，也绝不提前把
// 半成品形状发出去。`ports` 这一组收的是**壳内的**基础设施/策略实现（#498 S4c 的三条），
// 不是「所有端口对象的搬家入口」。
//
// 零运行时依赖：只用相对路径。

import { isDeepStrictEqual } from "node:util";

import { tagValidationRoute } from "../assembly-validators.js";
import { normalizeDeliverables } from "./deliverables.js";

/**
 * **16 个宿主回调**的规范名单（issue #498 S4a，S4b 起 12 项，S4c 起 16 项）。
 *
 * 顺序 = 报错文案里的枚举顺序，也 = 文档里那张表的行序。八条观察者通道来自 0.27.0 的
 * `config.observers`（本版整组删除），三条出口（`onEvent` / `onObserverError` /
 * `onPersistenceError`）来自 0.26 已发布的能力面——它们在**顶层**一直可用，现在只是多了一个
 * 规范之家。`finalGuard` 是 #498 S4b 收进来的第 12 个：它的值必须是函数，消费点是
 * `callFinalGuard`（`src/loop/termination.js`）里的 `finalGuard(payload)` 那一行（装配点是
 * `src/loop/orchestrator.js` 的 `ctx.finalGuard`）；`hasFinalDraft()` 是强制收尾的私有判定，
 * **与 `finalGuard` 无关**，别把它当消费点。按判据它是行为载体。搬家的消费者由 S5 / S6 / S7 迁，
 * 顶层扁平键本刀一个都不删。
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_HOOK_NAMES = Object.freeze([
  "onEvent",
  "onObserverError",
  "onPersistenceError",
  "onRound",
  "onJudge",
  "onToolResult",
  "onDelta",
  "onReasoningDelta",
  "onToolCall",
  "onUsage",
  "onFoldSummary",
  // #498 S4b：值必须是函数的那个叶子（`collectSemanticOptionProblems` 里那条
  // `finalGuard must be a function (or omitted)`）⇒ 按判据它是行为载体。顶层扁平键一字未动。
  "finalGuard",
  // #498 S4c：四个**壳内**回调。它们的旧住处是嵌套槽（`reflection.onReflection` /
  // `context.onBeforeFold` / `context.onAfterFold` / `context.stubFor`），**没有**顶层扁平别名——
  // 所以它们的去向登记在 `CAPABILITY_SLOT_DESTINATIONS` 里，展开走 `slots` 侧信道（见文件头）。
  // 消费点：`onReflection` 在 `src/loop/orchestrator.js` 的扩轮分支（`effectiveReflection.onReflection`），
  // 另三个在 `src/compact/{sliding-window,fold-statistical,fold-llm}.js` 经
  // `runFoldHook` / `resolveFoldStubs`（`src/compact/helpers.js`）。
  "onReflection",
  "onBeforeFold",
  "onAfterFold",
  "stubFor",
]);

/**
 * **两个形态多态旋钮**（issue #498 S4c）：函数形态住在 `capabilities.hooks`，数据形态
 * （`string` / `string[]`）住在 `config.folding.context`（或扁平 `context`）。
 *
 * 它们是本刀唯一「同一个旋钮两个户口」风险面：两侧都给了**不等价**的值 ⇒ 恰一条
 * `config_override_conflict`（`path` 点名该旋钮的**配置侧**路径，如 `folding.context.protectedMessage`），
 * 等价（`isDeepStrictEqual`，函数按同一性）⇒ 零事件。校验器与其余 `hooks` 叶子**同一条规则**：
 * 给了就必须是函数——不为迁就对象形态而放宽（放宽正是 C 路线（把它们塞进 `hooks` 当普通成员）
 * 要避免的退化）。
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_POLYMORPHIC_HOOK_NAMES = Object.freeze([
  "protectedMessage",
  "recoveryHint",
]);

/**
 * 住在 `context` 壳里的五个 `hooks` 叶子（`onReflection` 不在其中：它住 `reflection` 壳）。
 *
 * 单列出来是为了让 orchestrator **只**把这五个并进折叠上下文（`compactionContext`）——
 * `onReflection` 不是 `context` 的子键，混进去只会多出一个没人读的键。
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_CONTEXT_HOOK_NAMES = Object.freeze([
  "onBeforeFold",
  "onAfterFold",
  "stubFor",
  "protectedMessage",
  "recoveryHint",
]);

/**
 * `capabilities.ports` 的成员（issue #498 S4c）：被引擎**解引用或调用**的基础设施与策略实现。
 *
 * 三条都对应一个**壳里的老槽位**（下表），于是「同一个旋钮两个住处」这件事从第一天起就被
 * 冲突机制盯住（给了不等价值 ⇒ 一条 `config_override_conflict`，path 形如 `ports.sleepImpl`）。
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_PORT_SLOT_NAMES = Object.freeze([
  "sleepImpl",
  "judgeProvider",
  "strategy",
]);

/**
 * `capabilities.checks` 的成员（issue #498 S4b）。
 *
 * 交付物判据是宿主**行为**（`check` 是函数），所以它属能力面。以前它挂在
 * `config.guard.deliverables` 上，而配置面只装数据 ⇒ 能写的只有 `[]`；整键搬过来之后这个
 * 过渡态消失。形状规则不在这里重复：校验直接调 `normalizeDeliverables`（单一口径）。
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_CHECK_NAMES = Object.freeze(["deliverables"]);

/**
 * 能力面的**唯一手写表**：分组 → 该组接受的叶子名。
 *
 * 叶子名要么逐字等于 `RUN_TOOL_LOOP_OPTION_NAMES` 里的顶层键名（扁平别名，与 `config` 容器同一条
 * 约束），要么在 `CAPABILITY_SLOT_DESTINATIONS` 里登记了一个**嵌套槽**（#498 S4c：`sleepImpl` /
 * `judgeProvider` / `strategy` / `onReflection` / `onBeforeFold` / `onAfterFold` / `stubFor` /
 * `protectedMessage` / `recoveryHint` 从来不是顶层选项，发明的是容器成员位、不是搬家）。
 * 三组各有各的**值形状**（`hooks` = 函数、`checks` = `{name, check}[]`、`ports` = 函数 / `{chat}`
 * 对象 / 策略对象），由 `CAPABILITIES_GROUP_VALIDATORS` 逐组承担——新加一组却忘了给校验器，
 * `configSchemaSelfCheck` 报红。
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CAPABILITIES_NAMESPACE_SCHEMA = Object.freeze({
  hooks: Object.freeze([...CAPABILITY_HOOK_NAMES, ...CAPABILITY_POLYMORPHIC_HOOK_NAMES]),
  checks: CAPABILITY_CHECK_NAMES,
  // #498 S4c：基础设施与策略实现的规范之家。成员是**壳内**行为载体，不是适配器端口对象
  // （`provider` / `store` / `signal` 留在顶层选项 / 装配口，写进 `capabilities` 仍抛）。
  ports: CAPABILITY_PORT_SLOT_NAMES,
});

/**
 * **嵌套槽去向表**（#498 S4c）：没有顶层扁平别名的能力叶子 → 它在扁平表示里的真实位置。
 *
 * 这是本刀唯一新增的「第二张表」，所以刻意做得很小、且被自检双向核：
 *   · 表里的每个键必须是 schema 里真实存在的叶子（组名 + 叶子）；
 *   · 表里的每个叶子**不得**是顶层选项（否则它就是搬家，会改动 67 的账）；
 *   · `path[0]` 必须是顶层选项（壳本身一定在名单里）；
 *   · `conflictPath` 是冲突事件的 `path`——**点名真实目的地**，不是一句含糊的「能力面」。
 *     ports / 普通 hooks 用能力面路径（`ports.sleepImpl` / `hooks.onBeforeFold`）；两个形态多态
 *     旋钮用**配置侧**路径（`folding.context.protectedMessage`）：它们的两侧是「config 里的数据」
 *     对「hooks 里的函数」，path 指到数据侧才能让宿主知道要改哪一边。
 *
 * 为什么不把它们直接写回顶层：那会让白名单从 67 变成 76（发明 9 个从来没有过的顶层选项），
 * 而工单的硬要求是「本刀只加目的地，不发明扁平别名」。
 *
 * @type {Readonly<Record<string, { path: readonly string[], conflictPath: string }>>}
 */
export const CAPABILITY_SLOT_DESTINATIONS = Object.freeze({
  // 扩轮决策通知：旧住处 `reflection.onReflection`（消费点 `effectiveReflection.onReflection`）。
  "hooks.onReflection": Object.freeze({
    path: Object.freeze(["reflection", "onReflection"]),
    conflictPath: "hooks.onReflection",
  }),
  // 折叠前后通知 / 桩判定 / 两个形态多态旋钮：旧住处都在 `context` 壳里。
  ...Object.freeze(Object.fromEntries(CAPABILITY_CONTEXT_HOOK_NAMES.map((name) => [
    `hooks.${name}`,
    Object.freeze({
      path: Object.freeze(["context", name]),
      conflictPath: CAPABILITY_POLYMORPHIC_HOOK_NAMES.includes(name)
        ? `folding.context.${name}`
        : `hooks.${name}`,
    }),
  ]))),
  // 定时器注入点：旧住处 `retry.sleepImpl`（消费点 `retryOptions?.sleepImpl ?? defaultSleep`）。
  "ports.sleepImpl": Object.freeze({
    path: Object.freeze(["retry", "sleepImpl"]),
    conflictPath: "ports.sleepImpl",
  }),
  // judge 专用评估器：旧住处 `reflection.judge.provider`（`judge.evaluator` 这个纯别名本刀退役）。
  "ports.judgeProvider": Object.freeze({
    path: Object.freeze(["reflection", "judge", "provider"]),
    conflictPath: "ports.judgeProvider",
  }),
  // 压缩策略对象：旧住处 `context.strategy`（`resolveCompactionStrategy` 对象形态原样透传）。
  "ports.strategy": Object.freeze({
    path: Object.freeze(["context", "strategy"]),
    conflictPath: "ports.strategy",
  }),
});

/** 能力面的分组名（顺序即报错文案里的枚举顺序）。 */
export const CAPABILITIES_NAMESPACE_GROUPS = Object.freeze(
  Object.keys(CAPABILITIES_NAMESPACE_SCHEMA),
);

/**
 * 容器自己的顶层键名。它与 `config` 同属**容器**：展开后消失，既不算配置面也不算能力键。
 */
export const CAPABILITIES_NAMESPACE_OPTION_NAME = "capabilities";

/**
 * 展开后的**别名表**：`"<group>.<leaf>"` → 顶层键名（机械派生，不是手写映射）。
 *
 * 只收**扁平**叶子（叶子名逐字等于顶层键名）。9 个嵌套槽叶子不在这里——它们的去向是
 * `CAPABILITY_SLOT_DESTINATIONS`，而不是一张「发明出来的扁平键」表。
 *
 * @type {ReadonlyMap<string, string>}
 */
export const CAPABILITIES_ALIAS_PATHS = new Map(
  CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => (
    CAPABILITIES_NAMESPACE_SCHEMA[group]
      .filter((leaf) => CAPABILITY_SLOT_DESTINATIONS[`${group}.${leaf}`] === undefined)
      .map((leaf) => [`${group}.${leaf}`, leaf])
  )),
);

/** 能力面里的**扁平**叶子全集（派生：schema 的扁平并集，顺序 = 分组顺序 + 组内顺序）。 */
export const CAPABILITIES_SURFACE_OPTION_NAMES = Object.freeze(
  CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => (
    CAPABILITIES_NAMESPACE_SCHEMA[group]
      .filter((leaf) => CAPABILITY_SLOT_DESTINATIONS[`${group}.${leaf}`] === undefined)
  )),
);

/** 能力面里的**嵌套槽**叶子全集（派生：#498 S4c 的 9 个，顺序 = 分组顺序 + 组内顺序）。 */
export const CAPABILITIES_SLOT_LEAF_NAMES = Object.freeze(
  CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => (
    CAPABILITIES_NAMESPACE_SCHEMA[group]
      .filter((leaf) => CAPABILITY_SLOT_DESTINATIONS[`${group}.${leaf}`] !== undefined)
  )),
);

const CAPABILITIES_GROUP_SET = new Set(CAPABILITIES_NAMESPACE_GROUPS);

/**
 * 每组的**值形状**校验器：返回问题清单（空 = 通过），`path` 是该叶子的完整路径，`leaf` 是叶子名
 * （#498 S4c：`ports` 的三条槽位各有各的形状，需要叶子名才能分流）。
 *
 * 组名 → 校验器。`configSchemaSelfCheck` 会核「schema 里的每一组都有校验器」，所以新加一组
 * 却忘了给形状规则是红的，而不是「收下、不校、也不生效」。
 *
 * @type {Readonly<Record<string, (value: unknown, path: string, leaf: string) => string[]>>}
 */
const CAPABILITIES_GROUP_VALIDATORS = Object.freeze({
  // 回调：`undefined` = 未订阅；其余必须是函数。**#498 S4c 不放宽**：两个形态多态旋钮的函数形态
  // 也走这一条（“函数或对象”那种放宽正是 C 路线要避免的退化）。
  hooks: (value, path) => (value === undefined || typeof value === "function"
    ? []
    : [`${path} must be a function (or omitted)`]),
  // 交付物判据：形状规则只有一份（`normalizeDeliverables`），这里只把它的判词挂到完整路径上。
  checks: (value, path) => {
    if (value === undefined) return [];
    try {
      normalizeDeliverables(value);
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [`${path} is not accepted: ${message}`];
    }
  },
  // #498 S4c：三条端口槽位各有各的形状，逐条校（“给了就必须是引擎能调的那个形状”）。
  //
  // 为什么 ports 允许对象而 hooks 不允许：端口位装的是**基础设施/策略实现**（`{ chat }` 评估器、
  // 带 `shouldCompact` / `compact` 的策略对象），引擎对它们是“解引用成员再调”；而 `hooks` 装的是
  // **回调本身**，引擎对它是“直接调”。两类形状不合并，否则 `hooks` 会变成口袋。
  ports: (value, path, leaf) => {
    if (value === undefined) return [];
    if (leaf === "sleepImpl") {
      return typeof value === "function"
        ? []
        : [`${path} must be a function (ms, signal) => Promise<void> (or omitted)`];
    }
    if (leaf === "judgeProvider") {
      if (typeof value === "function") return [];
      if (isPlainObject(value) && typeof (/** @type {any} */ (value)).chat === "function") return [];
      return [
        `${path} must be a function (request) => Promise<response>`
        + " or an object with a chat(request) method (or omitted)",
      ];
    }
    // `strategy`：对象形态原样透传给 `resolveCompactionStrategy`（`src/compact/strategy-resolution.js`），
    // 随后引擎无条件调 `shouldCompact(messages, budgetTokens)` 与 `compact(messages, options)`。
    // 名字形态（`"sliding-window"` 等）是**数据**，不在端口位——它的家是
    // `config.folding.context.strategy` / 扁平 `context.strategy`。
    if (typeof value === "string") {
      return [
        `${path} must be a compaction strategy object, not a built-in name`
        + " (a built-in name is data: pass it as config.folding.context.strategy or the flat context.strategy)",
      ];
    }
    if (!isPlainObject(value)) {
      return [`${path} must be a compaction strategy object with shouldCompact() and compact() methods (or omitted)`];
    }
    const missing = ["shouldCompact", "compact"].filter((method) => typeof value[method] !== "function");
    if (missing.length > 0) {
      return [`${path} must expose ${missing.join(" and ")} as a function (or omitted)`];
    }
    return [];
  },
});

/** “普通对象”（`null` / 数组 / 标量都不是）——端口位的对象形态判定。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 某个顶层键在能力面里的 schema 路径（`onEvent` → `"hooks.onEvent"`、`deliverables` →
 * `"checks.deliverables"`、`sleepImpl` → `"ports.sleepImpl"`），不在能力面时 undefined。
 *
 * 嵌套槽叶子也走这一条（#498 S4c）：报错文案靠它点名**真实目的地**，而不是一句「能力面端口位」。
 *
 * @param {string} optionName
 * @returns {string|undefined}
 */
export function capabilitiesPathForOption(optionName) {
  for (const group of CAPABILITIES_NAMESPACE_GROUPS) {
    if (CAPABILITIES_NAMESPACE_SCHEMA[group].includes(optionName)) return `${group}.${optionName}`;
  }
  return undefined;
}

/** 某个叶子名在哪个组里（`deliverables` → `"checks"`）；不在任何组里时 undefined。 */
function capabilitiesGroupForLeaf(leaf) {
  for (const group of CAPABILITIES_NAMESPACE_GROUPS) {
    if (CAPABILITIES_NAMESPACE_SCHEMA[group].includes(leaf)) return group;
  }
  return undefined;
}

/**
 * `capabilities` 命名空间的**名称/形状/取值**问题（纯函数，不抛）。
 *
 * 三类问题分开说，因为修法不同：
 *   · 分组名写错（`hoks` / `check`）⇒ 枚举该层接受的名单；
 *   · 叶子被写在**容器顶层**（`capabilities.onEvent` / `capabilities.deliverables`）⇒ 教他写成
 *     `capabilities.<group>.<leaf>`；
 *   · 叶子写错 / 叶子的值给错型 ⇒ 各自点名（后者是「给了但给错」，与 `undefined` = 未订阅同口径）。
 *
 * @param {unknown} capabilities `capabilities` 的值（调用方已确认它不是 undefined）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function collectCapabilitiesNamespaceProblems(capabilities) {
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return ["capabilities must be an object (or omitted)"];
  }
  const problems = [];
  for (const [group, value] of Object.entries(/** @type {Record<string, unknown>} */ (capabilities))) {
    if (!CAPABILITIES_GROUP_SET.has(group)) {
      // 把叶子写在容器顶层是最常见的误写：它看起来「也是 capabilities.<group> 的意思」。
      const homeGroup = capabilitiesGroupForLeaf(group);
      if (homeGroup !== undefined) {
        problems.push(
          `capabilities.${group}: ${homeGroup} live under capabilities.${homeGroup}`
          + ` (write capabilities.${homeGroup}.${group})`,
        );
        continue;
      }
      problems.push(
        `unknown capabilities namespace: ${JSON.stringify(group)}`
        + ` (accepted: ${CAPABILITIES_NAMESPACE_GROUPS.join(", ")};`
        + " port objects such as provider / store / signal stay top-level options"
        + " or assembly-port members, not capabilities members)",
      );
      continue;
    }
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`capabilities.${group} must be an object`);
      continue;
    }
    const validate = CAPABILITIES_GROUP_VALIDATORS[group];
    for (const [leaf, leafValue] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (!CAPABILITIES_NAMESPACE_SCHEMA[group].includes(leaf)) {
        const misplaced = capabilitiesPathForOption(leaf);
        problems.push(
          `unknown capabilities.${group} option: ${JSON.stringify(leaf)}`
          + (misplaced === undefined
            ? ` (accepted: ${CAPABILITIES_NAMESPACE_SCHEMA[group].join(", ")})`
            : ` (${JSON.stringify(leaf)} belongs to capabilities.${misplaced})`),
        );
        continue;
      }
      problems.push(...validate(leafValue, `capabilities.${group}.${leaf}`, leaf));
    }
  }
  return problems;
}

/**
 * 名称/形状/取值闸口：问题非空就抛 `TypeError`（贴路线标签，与 #496 / #497 同一条口径）。
 *
 * @param {unknown} capabilities
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {void}
 */
export function assertCapabilitiesNamespace(capabilities, route = {}) {
  if (capabilities === undefined) return;
  const problems = collectCapabilitiesNamespaceProblems(capabilities);
  if (problems.length === 0) return;
  throw tagValidationRoute(new TypeError(problems.join("; ")), route.via);
}

/**
 * 两个 `capabilities` 源同时在场时的**逐叶冲突**（与 `collectConfigSourceConflicts` 逐条同构）。
 *
 * 病根与 `config` 那一侧逐字相同（#497 复审 R4）：装配口 `policy.capabilities` 与调用级
 * `capabilities` 是同一个容器的两个来源，而合并规则是「后写者胜、整棵覆盖」。语义保留，但覆盖
 * **不许静默**——两个源里同一个叶子都给了不同的值 ⇒ 记一条 `{ path, key }`，由调用方经同一条
 * `config_override_conflict` 发出去。两个容器同等待遇，这一侧就不该比 `config` 更静默。
 *
 * 比较用 `isDeepStrictEqual`：回调按**同一性**（两个不同的函数对象永不相等），`checks` 的数组
 * 按逐项深度比较（#498 S4b 起这一组不是函数）。
 *
 * @param {unknown} previousCapabilities 被覆盖的那棵树（装配口 `policy.capabilities`）
 * @param {unknown} nextCapabilities 胜出的那棵树（调用级 `capabilities`）
 * @returns {Array<{path: string, key: string}>} 逐叶冲突（空 = 没有可报的）
 */
export function collectCapabilitiesSourceConflicts(previousCapabilities, nextCapabilities) {
  const conflicts = [];
  if (!isCapabilitiesObject(previousCapabilities) || !isCapabilitiesObject(nextCapabilities)) {
    return conflicts;
  }
  const previous = /** @type {Record<string, any>} */ (previousCapabilities);
  const next = /** @type {Record<string, any>} */ (nextCapabilities);
  for (const group of CAPABILITIES_NAMESPACE_GROUPS) {
    const previousBag = previous[group];
    const nextBag = next[group];
    if (!isCapabilitiesObject(previousBag) || !isCapabilitiesObject(nextBag)) continue;
    for (const key of CAPABILITIES_NAMESPACE_SCHEMA[group]) {
      const previousValue = previousBag[key];
      const nextValue = nextBag[key];
      if (previousValue === undefined || nextValue === undefined) continue;
      if (isDeepStrictEqual(previousValue, nextValue)) continue;
      conflicts.push({ path: `${group}.${key}`, key });
    }
  }
  return conflicts;
}

/** `capabilities` 树的一层是否为「普通对象」（`null` / 数组 / 标量都不是）。 */
function isCapabilitiesObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 展开 `capabilities` 命名空间：把每个叶子写回它的顶层扁平键，并记下**冲突**。
 *
 * 规则与 `expandConfigNamespace`（`config-namespace.js`）逐条同构：
 *   · `capabilities.<group>.<leaf>` 与顶层 `<leaf>` 是同一个键 ⇒ 展开后只剩顶层那个键；
 *   · 同名时 **capabilities 赢**（配置面 / 能力面对扁平键的同向优先级）；
 *   · 叶子的 `undefined` 逐字等于「没给」，既不覆盖扁平值、也不算冲突；
 *   · 两边都给了**不同的值** ⇒ 记一条 `{ path, key }`（调用方发事件，不许静默）；
 *   · `capabilities` 本身从展开结果里消失（下游看到的仍是一份扁平表示）。
 *
 * #498 S4c：9 个**嵌套槽**叶子没有扁平键可写（它们从来不是顶层选项），所以它们不进 `options`，
 * 而是落在返回值的 `slots` 里（`{ hooks: { onBeforeFold: fn }, ports: { sleepImpl: fn } }`），
 * 由 orchestrator 在取值处与壳里的老槽位做 `??` 链（端口位赢）。**冲突比较仍然发生**：拿
 * `CAPABILITY_SLOT_DESTINATIONS` 里登记的路径去读当前值（例如 `context.protectedMessage`——
 * config 展开已经先跑过，所以配置侧的数据形态就在那里），不等价就记一条，`path` 是
 * `conflictPath`（真实目的地）。
 *
 * 返回新对象，不改入参。
 *
 * @param {Record<string, any>} options 合并后的选项表示（可能带 `capabilities`）
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {{
 *   options: Record<string, any>,
 *   conflicts: Array<{path: string, key: string}>,
 *   slots: Record<string, Record<string, any>>,
 * }}
 */
export function expandCapabilitiesNamespace(options, route = {}) {
  const capabilities = options.capabilities;
  if (capabilities === undefined) return { options, conflicts: [], slots: {} };
  assertCapabilitiesNamespace(capabilities, route);
  const expanded = { ...options };
  delete expanded.capabilities;
  const conflicts = [];
  /** @type {Record<string, Record<string, any>>} */
  const slots = {};
  for (const group of CAPABILITIES_NAMESPACE_GROUPS) {
    const bag = /** @type {Record<string, any>|undefined} */ (capabilities[group]);
    if (bag === undefined) continue;
    for (const [key, value] of Object.entries(bag)) {
      if (value === undefined) continue;
      const destination = CAPABILITY_SLOT_DESTINATIONS[`${group}.${key}`];
      if (destination === undefined) {
        const flatValue = expanded[key];
        if (flatValue !== undefined && !isDeepStrictEqual(flatValue, value)) {
          conflicts.push({ path: `${group}.${key}`, key });
        }
        expanded[key] = value;
        continue;
      }
      const current = readSlotPath(expanded, destination.path);
      if (current !== undefined && !isDeepStrictEqual(current, value)) {
        conflicts.push({ path: destination.conflictPath, key });
      }
      (slots[group] ??= {})[key] = value;
    }
  }
  return { options: expanded, conflicts, slots };
}

/**
 * 沿嵌套路径读一个已展开的值（`["reflection", "judge", "provider"]`）：中途任何一层不是
 * 普通对象就当作未提供（`retry: false` / `reflection: true` 这两个合法布尔形状不能当容器读）。
 *
 * @param {Record<string, any>} options
 * @param {readonly string[]} path
 * @returns {unknown}
 */
function readSlotPath(options, path) {
  let current = /** @type {any} */ (options);
  for (const key of path) {
    if (!isCapabilitiesObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * schema 自检的**能力面一半**（`configSchemaSelfCheck` 调用）：每组的叶子都必须是真选项、
 * 每组的形状校验器都存在、别名表与 schema 逐字对得上。
 *
 * #498 S4c 把「叶子」分成两半，两半各有一条**反向**的硬约束：
 *   · **扁平**叶子必须在顶层白名单里（否则别名表指向一个不存在的键）；
 *   · **嵌套槽**叶子**不得**在顶层白名单里——它在白名单里就说明有人给它发明了扁平别名，
 *     而本刀的硬要求是「白名单仍是 67」。同时它的 `path[0]`（壳）必须真是顶层选项。
 * 这两条合起来就是「只加目的地、不发明新键」的机器证明。
 *
 * @param {readonly string[]} optionNames 顶层选项白名单
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function capabilitiesSchemaSelfCheck(optionNames) {
  const problems = [];
  for (const group of CAPABILITIES_NAMESPACE_GROUPS) {
    if (typeof CAPABILITIES_GROUP_VALIDATORS[group] !== "function") {
      problems.push(`capabilities group ${JSON.stringify(group)} has no value-shape validator`);
    }
    for (const leaf of CAPABILITIES_NAMESPACE_SCHEMA[group]) {
      if (capabilitiesPathForOption(leaf) !== `${group}.${leaf}`) {
        problems.push(`capabilities alias for ${JSON.stringify(leaf)} is not ${JSON.stringify(`${group}.${leaf}`)}`);
      }
      const destination = CAPABILITY_SLOT_DESTINATIONS[`${group}.${leaf}`];
      if (destination === undefined) {
        if (!optionNames.includes(leaf)) {
          problems.push(`capabilities.${group} names ${JSON.stringify(leaf)}, which is not a top-level option`);
        }
        continue;
      }
      if (optionNames.includes(leaf)) {
        problems.push(
          `capabilities.${group}.${leaf} is a nested slot and must not also be a top-level option`
          + " (that would be a new flat alias, not a destination)",
        );
      }
      if (!optionNames.includes(destination.path[0])) {
        problems.push(
          `capabilities.${group}.${leaf} is destined for ${JSON.stringify(destination.path[0])},`
          + " which is not a top-level option",
        );
      }
    }
  }
  // 去向表里不许出现 schema 里不存在的叶子（否则它就是个没人读的死条目）。
  for (const slotPath of Object.keys(CAPABILITY_SLOT_DESTINATIONS)) {
    const [group, leaf] = slotPath.split(".");
    if (!CAPABILITIES_NAMESPACE_SCHEMA[group]?.includes(leaf)) {
      problems.push(`capability slot destination ${JSON.stringify(slotPath)} names a leaf that is not in the schema`);
    }
  }
  if (CAPABILITIES_ALIAS_PATHS.size !== CAPABILITIES_SURFACE_OPTION_NAMES.length) {
    problems.push(
      `capabilities alias table has ${CAPABILITIES_ALIAS_PATHS.size} paths`
      + ` for ${CAPABILITIES_SURFACE_OPTION_NAMES.length} leaves (a leaf name appears in two groups)`,
    );
  }
  return problems;
}
