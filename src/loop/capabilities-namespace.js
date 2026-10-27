// @ts-check
// issue #498（S4a）—— `capabilities: { hooks: { … } }`：宿主回调的**规范之家**。
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
//      叶子名逐字等于顶层键名，没有重命名表。
//   2. **只有一张表**：分组表 `CAPABILITIES_NAMESPACE_SCHEMA` 是唯一手写的部分，别名表
//      (`CAPABILITIES_ALIAS_PATHS`) 从它机械派生；`configSchemaSelfCheck`（`config-namespace.js`）
//      对着 `RUN_TOOL_LOOP_OPTION_NAMES` 核「能力面 / 配置面 / 容器三向闭合」。
//   3. **未知子键当场抛**（#498 S4a 复审要求）：`capabilities: { hoks: … }` / `capabilities.hooks.onEtent`
//      一律启动即抛并点名**完整路径**。这是新容器最容易漏的静默面——「传错了子键，引擎当没看见」
//      正是 #497 那类「配了等于没配」的病，不许在新容器里重生。
//   4. **函数值的形状也校**：`hooks` 的叶子给了就必须是函数（`undefined` = 未订阅）。顶层扁平
//      `onRound: "x"` 的宽容是 0.26 已发布面，本刀不动它；新容器从第一天起就不静默。
//   5. **与扁平键冲突不静默**：`capabilities.hooks.onEvent` 与顶层 `onEvent` 都给了不同的值 ⇒
//      记一条 `{ path: "hooks.onEvent", key: "onEvent" }`，由 orchestrator 经**同一条**
//      `config_override_conflict` 事件发出去（事件类型不新增：它说的就是「一个旋钮两个真相来源」，
//      只是 path 前缀不同）。capabilities 侧赢（与 `config.*` 对扁平键的优先级同向）。
//
// 本刀**只**收回调（`hooks` 一组）。端口对象（`provider` / `tools` / `store` / `signal` …）要不要
// 也搬进 `capabilities.ports`，是 S4b / 后续刀的裁决；现在写 `capabilities.provider` 会抛并说明
// 「ports 还没收」——绝不静默放行，也绝不提前把半成品形状发出去。
//
// 零运行时依赖：只用相对路径。

import { tagValidationRoute } from "../assembly-validators.js";

/**
 * 11 个宿主回调的**规范名单**（issue #498 S4a）。
 *
 * 顺序 = 报错文案里的枚举顺序，也 = 文档里那张表的行序。八条观察者通道来自 0.27.0 的
 * `config.observers`（本版整组删除），三条出口（`onEvent` / `onObserverError` /
 * `onPersistenceError`）来自 0.26 已发布的能力面——它们在**顶层**一直可用，现在只是多了一个
 * 规范之家。搬家的消费者由 S5 / S6 / S7 迁，顶层扁平键本刀一个都不删。
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
]);

/**
 * 能力面的**唯一手写表**：分组 → 该组接受的叶子名。
 *
 * 叶子名必须逐字等于 `RUN_TOOL_LOOP_OPTION_NAMES` 里的顶层键名（与 `config` 容器同一条约束）。
 * 今天只有一组 `hooks`；`ports` 是后续刀的裁决项，不在这里预留空组——空组会变成一张
 * 「写了没反应」的假许可。
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CAPABILITIES_NAMESPACE_SCHEMA = Object.freeze({
  hooks: CAPABILITY_HOOK_NAMES,
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
 * @type {ReadonlyMap<string, string>}
 */
export const CAPABILITIES_ALIAS_PATHS = new Map(
  CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => (
    CAPABILITIES_NAMESPACE_SCHEMA[group].map((leaf) => [`${group}.${leaf}`, leaf])
  )),
);

/** 能力面的叶子全集（派生：schema 的扁平并集，顺序 = 分组顺序 + 组内顺序）。 */
export const CAPABILITIES_SURFACE_OPTION_NAMES = Object.freeze(
  CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => [...CAPABILITIES_NAMESPACE_SCHEMA[group]]),
);

const CAPABILITIES_GROUP_SET = new Set(CAPABILITIES_NAMESPACE_GROUPS);
const CAPABILITY_HOOK_SET = new Set(CAPABILITY_HOOK_NAMES);

/**
 * 某个顶层回调键在能力面里的 schema 路径（`onEvent` → `"hooks.onEvent"`），不在能力面时 undefined。
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

/**
 * `capabilities` 命名空间的**名称/形状/取值**问题（纯函数，不抛）。
 *
 * 三类问题分开说，因为修法不同：
 *   · 分组名写错（`hoks`）⇒ 枚举该层接受的名单；
 *   · 回调被写在**顶层**（`capabilities.onEvent`）⇒ 教他写成 `capabilities.hooks.onEvent`；
 *   · 叶子写错 / 叶子不是函数 ⇒ 各自点名（后者是「给了但给错」，与 `undefined` = 未订阅同口径）。
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
      // 把回调写在容器顶层是最常见的误写：它看起来「也是 capabilities.hooks 的意思」。
      if (CAPABILITY_HOOK_SET.has(group)) {
        problems.push(
          `capabilities.${group}: hooks live under capabilities.hooks`
          + ` (write capabilities.hooks.${group})`,
        );
        continue;
      }
      problems.push(
        `unknown capabilities namespace: ${JSON.stringify(group)}`
        + ` (accepted: ${CAPABILITIES_NAMESPACE_GROUPS.join(", ")};`
        + " ports are not collected under capabilities yet — pass them as top-level options"
        + " or through the assembly port)",
      );
      continue;
    }
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`capabilities.${group} must be an object`);
      continue;
    }
    for (const [leaf, hook] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (!CAPABILITIES_NAMESPACE_SCHEMA[group].includes(leaf)) {
        problems.push(
          `unknown capabilities.${group} option: ${JSON.stringify(leaf)}`
          + ` (accepted: ${CAPABILITIES_NAMESPACE_SCHEMA[group].join(", ")})`,
        );
        continue;
      }
      // `undefined` 逐字等于「未订阅」；其余非函数一律「给了但给错」。
      if (hook === undefined) continue;
      if (typeof hook !== "function") {
        problems.push(`capabilities.${group}.${leaf} must be a function (or omitted)`);
      }
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
 * 展开 `capabilities` 命名空间：把每个钩子写回它的顶层扁平键，并记下**冲突**。
 *
 * 规则与 `expandConfigNamespace`（`config-namespace.js`）逐条同构：
 *   · `capabilities.hooks.<leaf>` 与顶层 `<leaf>` 是同一个键 ⇒ 展开后只剩顶层那个键；
 *   · 同名时 **capabilities 赢**（配置面 / 能力面对扁平键的同向优先级）；
 *   · 叶子的 `undefined` 逐字等于「没给」，既不覆盖扁平值、也不算冲突；
 *   · 两边都给了**不同的值** ⇒ 记一条 `{ path: "hooks.<leaf>", key }`（调用方发事件，不许静默）；
 *   · `capabilities` 本身从展开结果里消失（下游看到的仍是一份扁平表示）。
 *
 * 返回新对象，不改入参。
 *
 * @param {Record<string, any>} options 合并后的选项表示（可能带 `capabilities`）
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {{options: Record<string, any>, conflicts: Array<{path: string, key: string}>}}
 */
export function expandCapabilitiesNamespace(options, route = {}) {
  const capabilities = options.capabilities;
  if (capabilities === undefined) return { options, conflicts: [] };
  assertCapabilitiesNamespace(capabilities, route);
  const expanded = { ...options };
  delete expanded.capabilities;
  const conflicts = [];
  for (const group of CAPABILITIES_NAMESPACE_GROUPS) {
    const bag = /** @type {Record<string, any>|undefined} */ (capabilities[group]);
    if (bag === undefined) continue;
    for (const [key, value] of Object.entries(bag)) {
      if (value === undefined) continue;
      const flatValue = expanded[key];
      if (flatValue !== undefined && flatValue !== value) {
        conflicts.push({ path: `${group}.${key}`, key });
      }
      expanded[key] = value;
    }
  }
  return { options: expanded, conflicts };
}
