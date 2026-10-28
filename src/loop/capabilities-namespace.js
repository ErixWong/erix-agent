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
// issue #498 (S4c) — behaviour carriers that live *inside* a shell get a real destination, and the
// capability surface therefore has **three groups** (`hooks` / `checks` / `ports`):
//   · `capabilities.ports` opens. Its members are the infrastructure / strategy implementations the
//     engine **dereferences or calls**: `sleepImpl` (the timer injection point, consumed as
//     `retryOptions?.sleepImpl ?? defaultSleep`), `judgeProvider` (the judge-only evaluator; accepts
//     a callable or a `{ chat }` object) and `strategy` (a compaction strategy object that
//     `resolveCompactionStrategy` passes through verbatim; `shouldCompact` / `compact` are called).
//     They used to be writable only inside a shell (`retry.sleepImpl` / `reflection.judge.provider` /
//     `context.strategy`), and a shell has to survive the `config` subtree's JSON round-trip — so a
//     host that wanted `retry.sleepImpl` could not even use the **data half** through
//     `config.timing.retry` (a flat `retry` carrying a function collides with the config side).
//     Opening `ports` makes those shells **migratable** instead of leaving an undisclosed dead end.
//   · `hooks` gains 4 real callbacks (12 → 16): `onReflection` (extension-decision notification),
//     `onBeforeFold` / `onAfterFold` (fold notifications, consumed by `runFoldHook`
//     (`src/compact/helpers.js`)) and `stubFor` (the per-message stub decision, consumed by
//     `resolveFoldStubs` in the same file).
//   · Two **polymorphic** knobs, `protectedMessage` / `recoveryHint`: the data form (`string` /
//     `string[]`) stays in `config.folding.context`, the function form moves to `capabilities.hooks`.
//     Both sides set to **inequivalent** values ⇒ exactly one `config_override_conflict` (the same
//     container-conflict machinery, no new outlet).
//   ⚠ The nine new leaves of this slice get **no new top-level flat alias**: `sleepImpl` /
//   `judgeProvider` / `strategy` / `onReflection` / `onBeforeFold` / `onAfterFold` / `stubFor` /
//   `protectedMessage` / `recoveryHint` never were top-level options, so what is invented here is a
//   **container member slot**, not a move ⇒ the top-level allowlist **stays at 67**. Their home is the
//   **nested slot** registered in `CAPABILITY_SLOT_DESTINATIONS` (below; `context.onBeforeFold` and
//   friends), and expansion does not write them into `effectiveOptions` as flat keys — it hands them
//   over on the `slots` side channel (see `expandCapabilitiesNamespace`).
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
//      the leaf name is verbatim the top-level key, with no rename table. **One exception (issue
//      #498 S4c, explicitly registered)**: the nine "nested slot" leaves have no top-level flat alias
//      (they never were top-level options); their destinations live in
//      `CAPABILITY_SLOT_DESTINATIONS`, and the self-check verifies both directions ("a slotted leaf
//      must not be a top-level option / a flat leaf must really be one"), so the exception cannot
//      degrade into "anyone may invent a new flat key".
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
// Adapter port objects (`provider` / `store` / `signal` …) are **not** members of `capabilities.ports`:
// `tools` is a **permanent top-level option** (the third station since issue #527 — its entries may
// carry function members, so it can live neither in the data-only `config` subtree nor in the
// capability surface, which is for behaviour carriers the engine calls), the rest stay top-level
// options / assembly-port members. Writing `capabilities.provider`
// still throws (and says where port objects live) — nothing is silently accepted, and no half-baked
// shape is published early. The `ports` group holds the **in-shell** infrastructure / strategy
// implementations (the three from #498 S4c), not "the migration entry point for every port object".
//
// 零运行时依赖：只用相对路径。

import { isDeepStrictEqual } from "node:util";

import { tagValidationRoute } from "../assembly-validators.js";
import { normalizeDeliverables } from "./deliverables.js";

/**
 * The canonical list of the **16 host callbacks** (issue #498 S4a; 12 since S4b, 16 since S4c).
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
  // #498 S4c: four **in-shell** callbacks. Their legacy homes are nested slots
  // (`reflection.onReflection` / `context.onBeforeFold` / `context.onAfterFold` / `context.stubFor`)
  // and they have **no** top-level flat alias — so their destinations are registered in
  // `CAPABILITY_SLOT_DESTINATIONS` and expansion delivers them on the `slots` side channel (see the
  // file header). Consumers: `onReflection` in the extension branch of `src/loop/orchestrator.js`
  // (`effectiveReflection.onReflection`); the other three in
  // `src/compact/{sliding-window,fold-statistical,fold-llm}.js` through `runFoldHook` /
  // `resolveFoldStubs` (`src/compact/helpers.js`).
  "onReflection",
  "onBeforeFold",
  "onAfterFold",
  "stubFor",
]);

/**
 * The **two polymorphic knobs** (issue #498 S4c): the function form lives in `capabilities.hooks`,
 * the data form (`string` / `string[]`) in `config.folding.context` (or the flat `context`).
 *
 * They are the one "same knob, two homes" risk of this slice: both sides set to **inequivalent**
 * values ⇒ exactly one `config_override_conflict` (`path` names the knob's **config-side** path, e.g.
 * `folding.context.protectedMessage`); equivalent (`isDeepStrictEqual`, functions by identity) ⇒ zero
 * events. The value validator keeps the **same rule** as every other `hooks` leaf: given ⇒ it must be
 * a function — it is deliberately *not* relaxed to "function or object" (that relaxation is the
 * degradation route C would have introduced by stuffing these into `hooks` as ordinary members).
 *
 * @type {readonly string[]}
 */
export const CAPABILITY_POLYMORPHIC_HOOK_NAMES = Object.freeze([
  "protectedMessage",
  "recoveryHint",
]);

/**
 * The five `hooks` leaves whose shell is `context` (`onReflection` is not one of them: it lives in the
 * `reflection` shell).
 *
 * They are listed separately so the orchestrator merges **exactly these five** into the folding
 * context (`compactionContext`) — `onReflection` is not a `context` sub-key, and spreading it in
 * would only add a key nobody reads.
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
 * The members of `capabilities.ports` (issue #498 S4c): the infrastructure / strategy
 * implementations the engine **dereferences or calls**.
 *
 * Each of the three maps onto an **old slot inside a shell** (see the table below), so "the same knob
 * has two homes" is watched by the conflict machinery from day one (inequivalent values ⇒ one
 * `config_override_conflict`, path shaped like `ports.sleepImpl`).
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
 * The capability surface's **single hand-written table**: group → the leaf names that group accepts.
 *
 * A leaf name either is verbatim a top-level key in `RUN_TOOL_LOOP_OPTION_NAMES` (a flat alias, the
 * same constraint the `config` container follows), or it registers a **nested slot** in
 * `CAPABILITY_SLOT_DESTINATIONS` (issue #498 S4c: `sleepImpl` / `judgeProvider` / `strategy` /
 * `onReflection` / `onBeforeFold` / `onAfterFold` / `stubFor` / `protectedMessage` / `recoveryHint`
 * never were top-level options, so what is invented is a container member slot, not a move).
 * Each group has its own **value shape** (`hooks` = functions, `checks` = `{name, check}[]`,
 * `ports` = a function / a `{chat}` object / a strategy object), carried by
 * `CAPABILITIES_GROUP_VALIDATORS` group by group — a new group without a validator is red in
 * `configSchemaSelfCheck`.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CAPABILITIES_NAMESPACE_SCHEMA = Object.freeze({
  hooks: Object.freeze([...CAPABILITY_HOOK_NAMES, ...CAPABILITY_POLYMORPHIC_HOOK_NAMES]),
  checks: CAPABILITY_CHECK_NAMES,
  // #498 S4c: the canonical home of infrastructure / strategy implementations. Its members are
  // **in-shell** behaviour carriers, not adapter port objects (`provider` / `store` / `signal` stay
  // top-level options / assembly-port members; writing them under `capabilities` still throws).
  ports: CAPABILITY_PORT_SLOT_NAMES,
});

/**
 * The **nested-slot destination table** (issue #498 S4c): a capability leaf with no top-level flat
 * alias → its real position in the flat representation.
 *
 * This is the only "second table" this slice adds, so it is deliberately small and checked in both
 * directions by the self-check:
 *   · every key must be a leaf that really exists in the schema (group + leaf);
 *   · every such leaf **must not** be a top-level option (otherwise it would be a move and would
 *     change the 67 accounting);
 *   · `path[0]` must be a top-level option (a shell always is on the allowlist);
 *   · `conflictPath` is the `path` of the conflict event — it **names the real destination**, not a
 *     vague "capability surface". Ports and ordinary hooks use the capability path
 *     (`ports.sleepImpl` / `hooks.onBeforeFold`); the two polymorphic knobs use their **config-side**
 *     path (`folding.context.protectedMessage`), because their two sides are "data in `config`"
 *     versus "a function in `hooks`" and the host has to know which side to change.
 *
 * Why not write them back as top-level keys: that would take the allowlist from 67 to 76 (inventing
 * nine top-level options that never existed), while the hard requirement of this slice is "only add
 * destinations, do not invent flat aliases".
 *
 * @type {Readonly<Record<string, { path: readonly string[], conflictPath: string }>>}
 */
export const CAPABILITY_SLOT_DESTINATIONS = Object.freeze({
  // Extension-decision notification: legacy home `reflection.onReflection` (consumed as
  // `effectiveReflection.onReflection`).
  "hooks.onReflection": Object.freeze({
    path: Object.freeze(["reflection", "onReflection"]),
    conflictPath: "hooks.onReflection",
  }),
  // Fold notifications / stub decision / the two polymorphic knobs: all legacy homes are in the
  // `context` shell.
  ...Object.freeze(Object.fromEntries(CAPABILITY_CONTEXT_HOOK_NAMES.map((name) => [
    `hooks.${name}`,
    Object.freeze({
      path: Object.freeze(["context", name]),
      conflictPath: CAPABILITY_POLYMORPHIC_HOOK_NAMES.includes(name)
        ? `folding.context.${name}`
        : `hooks.${name}`,
    }),
  ]))),
  // Timer injection point: legacy home `retry.sleepImpl` (consumed as
  // `retryOptions?.sleepImpl ?? defaultSleep`).
  "ports.sleepImpl": Object.freeze({
    path: Object.freeze(["retry", "sleepImpl"]),
    conflictPath: "ports.sleepImpl",
  }),
  // Judge-only evaluator: legacy home `reflection.judge.provider` (the pure alias `judge.evaluator`
  // is retired by this slice).
  "ports.judgeProvider": Object.freeze({
    path: Object.freeze(["reflection", "judge", "provider"]),
    conflictPath: "ports.judgeProvider",
  }),
  // Compaction strategy object: legacy home `context.strategy` (`resolveCompactionStrategy` passes an
  // object through verbatim).
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
 * The derived **alias table**: `"<group>.<leaf>"` → top-level key (mechanically derived, not a
 * hand-written mapping).
 *
 * It only holds **flat** leaves (leaf name verbatim the top-level key). The nine nested-slot leaves
 * are not here — their destination is `CAPABILITY_SLOT_DESTINATIONS`, not a table of "invented flat
 * keys".
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

/** The full set of **flat** capability leaves (derived: flat union of the schema, group then leaf order). */
export const CAPABILITIES_SURFACE_OPTION_NAMES = Object.freeze(
  CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => (
    CAPABILITIES_NAMESPACE_SCHEMA[group]
      .filter((leaf) => CAPABILITY_SLOT_DESTINATIONS[`${group}.${leaf}`] === undefined)
  )),
);

/** The full set of **nested-slot** capability leaves (derived: the nine from #498 S4c, group then leaf order). */
export const CAPABILITIES_SLOT_LEAF_NAMES = Object.freeze(
  CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => (
    CAPABILITIES_NAMESPACE_SCHEMA[group]
      .filter((leaf) => CAPABILITY_SLOT_DESTINATIONS[`${group}.${leaf}`] !== undefined)
  )),
);

const CAPABILITIES_GROUP_SET = new Set(CAPABILITIES_NAMESPACE_GROUPS);

/**
 * Per-group **value-shape** validators: they return a problem list (empty = pass), `path` is the
 * leaf's full path and `leaf` is the leaf name (#498 S4c: the three `ports` slots each have their own
 * shape, so the leaf name is needed to dispatch).
 *
 * 组名 → 校验器。`configSchemaSelfCheck` 会核「schema 里的每一组都有校验器」，所以新加一组
 * 却忘了给形状规则是红的，而不是「收下、不校、也不生效」。
 *
 * @type {Readonly<Record<string, (value: unknown, path: string, leaf: string) => string[]>>}
 */
const CAPABILITIES_GROUP_VALIDATORS = Object.freeze({
  // Callbacks: `undefined` = not subscribed; anything else must be a function. **Not relaxed by
  // #498 S4c**: the function form of the two polymorphic knobs goes through this same rule (a
  // "function or object" relaxation is exactly the degradation route C would have introduced).
  hooks: (value, path) => (value === undefined || typeof value === "function"
    ? []
    : [`${path} must be a function (or omitted)`]),
  // Deliverables checks: the shape rule has exactly one source (`normalizeDeliverables`); this only
  // hangs its verdict on the full path.
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
  // #498 S4c: the three port slots each have their own shape, checked one by one ("given ⇒ it must
  // have the shape the engine can call").
  //
  // Why `ports` accepts objects while `hooks` does not: a port slot holds an **infrastructure /
  // strategy implementation** (a `{ chat }` evaluator, a strategy object with `shouldCompact` /
  // `compact`) and the engine "dereferences a member and calls it"; a `hooks` leaf holds the
  // **callback itself**, which the engine calls directly. The two shapes are not merged, otherwise
  // `hooks` would turn into a pocket.
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
    // `strategy`: an object is passed through verbatim to `resolveCompactionStrategy`
    // (`src/compact/strategy-resolution.js`), after which the engine unconditionally calls
    // `shouldCompact(messages, budgetTokens)` and `compact(messages, options)`. A built-in **name**
    // (`"sliding-window"`, …) is data and therefore not a port value — its home is
    // `config.folding.context.strategy` / the flat `context.strategy`.
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

/** A "plain object" (`null` / arrays / scalars are not) — the object-form test for a port slot. */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The capability schema path of a leaf (`onEvent` → `"hooks.onEvent"`, `deliverables` →
 * `"checks.deliverables"`, `sleepImpl` → `"ports.sleepImpl"`); undefined when the name is not on the
 * capability surface.
 *
 * Nested-slot leaves go through this same lookup (#498 S4c): the error text uses it to name the
 * **real destination** instead of a vague "capability port slot".
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
 * Every **nested-slot destination** whose shell is `shellName` (`"context"` → the five `hooks` leaves
 * plus `ports.strategy`; `"retry"` → `ports.sleepImpl`).
 *
 * Why this is a function and not a table: a shell can hold **both** data and behaviour members
 * (`context` = `budgetTokens` … plus `onBeforeFold` …), so "the shell moved to `config.folding.context`"
 * is only half a signpost — a host that follows it with a function in hand is rejected a second time by
 * the config namespace (which holds data only) and only *then* learns about `capabilities.hooks`.
 * The rejection at the top-level name gate must therefore name **both** stations in one sentence, and it
 * has to derive them from the destination table so a new shell cannot be forgotten (#498 S3).
 *
 * @param {string} shellName a top-level option name that used to be a shell (`context` / `retry` / …)
 * @returns {Array<{capabilityPath: string, group: string, leaf: string}>} empty when the shell carries
 *   no behaviour members (then the single-station message is already complete)
 */
export function capabilityDestinationsForShell(shellName) {
  const found = [];
  for (const [capabilityPath, destination] of Object.entries(CAPABILITY_SLOT_DESTINATIONS)) {
    if (destination.path[0] !== shellName) continue;
    const [group, ...rest] = capabilityPath.split(".");
    found.push({ capabilityPath, group, leaf: rest.join(".") });
  }
  return found;
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
      // Writing a leaf at the container top level is the most common slip: it looks like it "also
      // means capabilities.<group>".
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
      // #498 S4c: the path is the leaf's **destination** — the same rule `expandCapabilitiesNamespace`
      // uses, so one knob never shows up under two different paths depending on which pair of sources
      // disagreed (a port slot stays `ports.<slot>`, a polymorphic knob names its config-side path).
      const destination = CAPABILITY_SLOT_DESTINATIONS[`${group}.${key}`];
      conflicts.push({ path: destination?.conflictPath ?? `${group}.${key}`, key });
    }
  }
  return conflicts;
}

/** `capabilities` 树的一层是否为「普通对象」（`null` / 数组 / 标量都不是）。 */
function isCapabilitiesObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Expand the `capabilities` namespace: write every leaf back to its top-level flat key and record
 * **conflicts**.
 *
 * The rules are isomorphic to `expandConfigNamespace` (`config-namespace.js`), item by item:
 *   · `capabilities.<group>.<leaf>` and the top-level `<leaf>` are the same key ⇒ only the top-level
 *     key survives expansion;
 *   · on a name clash **capabilities wins** (the same direction as the config surface / capability
 *     surface precedence over flat keys);
 *   · a leaf's `undefined` is verbatim "not given": it neither overrides a flat value nor counts as a
 *     conflict;
 *   · both sides set to **different** values ⇒ record one `{ path, key }` (the caller emits the event;
 *     silence is not allowed);
 *   · `capabilities` itself disappears from the expansion result (downstream still sees a flat
 *     representation).
 *
 * #498 S4c: the nine **nested-slot** leaves have no flat key to write to (they never were top-level
 * options), so they do not enter `options`; they land in the returned `slots`
 * (`{ hooks: { onBeforeFold: fn }, ports: { sleepImpl: fn } }`) and the orchestrator resolves them
 * against the shell's old slot with a `??` chain (the port wins). **The conflict comparison still
 * happens**: the path registered in `CAPABILITY_SLOT_DESTINATIONS` is used to read the current value
 * (e.g. `context.protectedMessage` — config expansion already ran, so the config-side data form is
 * right there); if it is not deeply equal, one conflict is recorded with `path` = `conflictPath`
 * (the real destination).
 *
 * Returns a new object; the input is not mutated.
 *
 * @param {Record<string, any>} options the merged option representation (may carry `capabilities`)
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
 * Read an already-expanded value along a nested path (`["reflection", "judge", "provider"]`): if any
 * intermediate layer is not a plain object it counts as "not given" (`retry: false` and
 * `reflection: true` are legal boolean shapes and must not be read as containers).
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
 * The **capability half** of the schema self-check (called by `configSchemaSelfCheck`): every leaf
 * must be a real option, every group must have a value-shape validator, and the alias table must
 * match the schema verbatim.
 *
 * #498 S4c splits "leaves" into two halves, each with its own **opposite** hard constraint:
 *   · a **flat** leaf must be on the top-level allowlist (otherwise the alias table points at a key
 *     that does not exist);
 *   · a **nested-slot** leaf **must not** be on the top-level allowlist — being there would mean
 *     somebody invented a flat alias for it, while this slice's hard requirement is "the allowlist
 *     stays at 67". Its `path[0]` (the shell) must really exist as a key the engine still reads.
 * Together they are the machine proof of "only add destinations, do not invent new keys".
 *
 * #498 S3: "the shell must exist" stopped being the same question as "the shell is a top-level
 * option". The `ports.sleepImpl` shell is `retry`, which this slice moved to `config.timing.retry`;
 * the expansion phase still writes it back to `effectiveOptions.retry` (that is why `path` stays
 * `["retry", "sleepImpl"]` — it is the **flat** read path, not a write spelling). So the caller may
 * pass `shellIsKnown`, which is exactly "this name still resolves to something the engine reads".
 * `configSchemaSelfCheck` passes a resolver that also accepts config leaves that lost their
 * top-level key; called without it, the behaviour is the old `optionNames.includes` one.
 *
 * @param {readonly string[]} optionNames 顶层选项白名单
 * @param {{shellIsKnown?: (name: string) => boolean}} [overrides] S3 hook: see above.
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function capabilitiesSchemaSelfCheck(optionNames, { shellIsKnown } = {}) {
  const isKnownShell = shellIsKnown ?? ((name) => optionNames.includes(name));
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
      if (!isKnownShell(destination.path[0])) {
        problems.push(
          `capabilities.${group}.${leaf} is destined for ${JSON.stringify(destination.path[0])},`
          + " which is not a top-level option",
        );
      }
    }
  }
  // The destination table must not name a leaf the schema does not have (that would be a dead entry
  // nobody reads).
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
