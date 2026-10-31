
import { assertCapabilitiesNamespace, capabilitiesPathForOption } from "./loop/capabilities-namespace.js";
import {
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_SCHEMA,
  NAMESPACE_CONTAINER_OPTION_NAMES,
  TOP_LEVEL_SURFACE_OPTION_NAMES,
  assertConfigNamespace,
  collectConfigSourceConflicts,
  configPathForOption,
} from "./loop/config-namespace.js";
// issue #498 第 1 条：调用期覆盖的**键名闭集**不另抄一份——`overrides` 的值最终就是喂给
// `runToolLoop` 的选项，而「runToolLoop 接受哪些选项」的唯一来源是 `RUN_TOOL_LOOP_OPTION_NAMES`
// （#496 / #502 立的规矩：接受面 = 白名单，不许有第二张表）。两个符号都只在函数体里用，
// 所以 `assembly.js ↔ loop/option-normalization.js` 这条环在 ESM 下没有 TDZ 问题。
// #544 adds the **merged-representation** name gate here: it is the same allowlist, applied one
// phase later, so it belongs next to the phase-① gate it mirrors (and this module is where the
// names the gate has to judge are actually produced).
import {
  RUN_TOOL_LOOP_OPTION_SET,
  assertRunToolLoopOptionNames,
  levenshteinDistance,
  optionSuggestion,
} from "./loop/option-normalization.js";
import {
  MODEL_CONFIG_RESOLVER_HINT,
  assertSemanticOptionValues,
  collectSessionContainerProblems,
  collectUnknownContextOptions,
  sessionContainerTypeProblem,
  tagValidationRoute,
  validateModelConfigResolver,
  validateProviderBoundary,
  validateTranscriptStore,
} from "./assembly-validators.js";

// Re-exported for existing consumers (loop/orchestrator.js imports the hint
// from this module); the canonical definition lives in assembly-validators.js.
export { MODEL_CONFIG_RESOLVER_HINT };

/**
 * The `policy` plane's accepted names (issue #545): the `config` schema's leaves plus the two
 * containers, and **nothing else**.
 *
 * Derived, never hand-written. The literal this replaces had 46 entries and they were **two surfaces
 * glued into one list**: 29 retired flat config leaves (`maxRounds`, `retry`, `system` …), 15
 * capability names (`onRound`, `finalGuard`, `signal` …) and the 2 containers. Zero junk in it — so
 * it was not a stale list, it was a **second flat spelling surface**, and it was the last one still
 * producing the retired spellings: as long as `policy` accepted them, a name like `runId` crossed the
 * merged-representation gate (`assertMergedOptionNames`) on the `policy` exemption (issue #525).
 *
 * The plane now carries **data only**: every leaf name is translated into its canonical path
 * (`policy.maxRounds` → `config.run.maxRounds`, see `translatedPolicyConfigLeaves`), the two
 * containers keep their real semantics (`policy.config` / `policy.capabilities` are the same trees the
 * call-level containers are), and everything else is refused at construction with a pointer to where
 * it really lives (`policy.capabilities.<group>.<leaf>` for a capability, the port itself for a port
 * member). Refusing port members is deliberate and self-consistent: the port already supplies them,
 * so a second copy under `policy` would be one capability with two sources.
 */
const ASSEMBLY_POLICY_CONFIG_LEAF_NAMES = new Set(
  CONFIG_NAMESPACE_GROUPS.flatMap((group) => CONFIG_NAMESPACE_SCHEMA[group]),
);

/** The two containers `policy` accepts next to the leaves (`config` / `capabilities`). */
const ASSEMBLY_POLICY_CONTAINER_NAMES = new Set(NAMESPACE_CONTAINER_OPTION_NAMES);

/** The third station, as a Set: the names whose only home is the top level (`provider`, `tools` …). */
const ASSEMBLY_TOP_LEVEL_SURFACE_OPTION_SET = new Set(TOP_LEVEL_SURFACE_OPTION_NAMES);

/**
 * The rejection message for a name `policy` does not take, or `undefined` when it takes the name
 * (issue #545). The pointer is the point: a host that follows it changes the spelling once, not twice.
 *
 * Three destinations, all derived from the schema/allowlist tables — no name is hard-coded here:
 *   · a **capability** name (it has a `capabilities.<group>.<leaf>` home) ⇒ `policy.capabilities.<path>`;
 *   · a **port member** / permanent top-level option (`provider`, `tools`, `store`, `session`,
 *     `signal`, `todoStateProvider` …) ⇒ the port itself: these are what the port supplies, and a
 *     second copy under `policy` would be one capability with two sources;
 *   · anything else ⇒ plain "unknown", the pre-existing wording (hosts and tests depend on it).
 *
 * @param {string} name
 * @returns {string|undefined}
 */
function assemblyPolicyNameProblem(name) {
  const capabilityPath = capabilitiesPathForOption(name);
  if (capabilityPath !== undefined) {
    return `unknown assembly policy option: ${JSON.stringify(name)}`
      + ` (policy carries data only: ${JSON.stringify(name)} is a capability,`
      + ` write it as policy.capabilities.${capabilityPath})`;
  }
  if (ASSEMBLY_TOP_LEVEL_SURFACE_OPTION_SET.has(name)) {
    return `unknown assembly policy option: ${JSON.stringify(name)}`
      + ` (policy carries data only: ${JSON.stringify(name)} is supplied by the port itself,`
      + " so a second copy here would be the same capability with two sources)";
  }
  return `unknown assembly policy option: ${JSON.stringify(name)}`;
}

/**
 * 容器类覆盖一律拒绝（issue #498 第 1 条）：`config` / `capabilities` 整块替换会把 #498 刚
 * 分立的两面重新搅混（一个旋钮只有一个家）。它们虽然在 `RUN_TOOL_LOOP_OPTION_NAMES` 里，
 * 但**不**是「给一个值」的选项，而是两棵子树的根——所以单独拦。
 *
 * @type {ReadonlyMap<string, string>}
 */
const ASSEMBLY_OVERRIDE_CONTAINERS = new Map([
  ["config", "e.g. config.run.maxRounds"],
  ["capabilities", "e.g. capabilities.hooks.onEvent"],
]);

/**
 * 端口派生键的**来源**（只用于错误文案：冲突要点名「两个来源」）。
 *
 * 值是**相对来源**，前缀由路线决定：`overrides` 通道说 `port.<suffix>`（issue #498 第 1 条），
 * 直连路线说 `assemblyPort.<suffix>`（issue #519）——同一个事实、两种入口拼写，所以表只有一份。
 * `policy.<key>` 那些不在这里登记，缺省按 `<prefix>.policy.<key>` 说。
 * 这份表只影响措辞，**不是**判定依据——判定用的是实际构造出来的选项对象（见
 * `assemblyPortBaseOptions`），所以表里漏一个键只会让文案变粗，不会放过一次冲突。
 *
 * @type {Readonly<Record<string, string>>}
 */
const ASSEMBLY_DERIVED_ORIGIN_SUFFIXES = Object.freeze({
  modelConfig: "modelConfig",
  provider: "provider",
  tools: "tools.definitions",
  executeTool: "tools.executeTool",
  store: "store",
  // #544: `runId` / `initialMessages` used to be listed here. They are no longer top-level keys
  // at all (see `assemblyPortDerivedConfigLeaves`), so an entry would be dead weight.
  session: "session",
  onEvent: "emit",
});

/**
 * 一个端口派生键的来源拼写（issue #498 第 1 条 / #519 共用）。
 *
 * @param {string} key
 * @param {"port"|"assemblyPort"} prefix 路线的入口拼写
 * @returns {string}
 */
function assemblyDerivedOrigin(key, prefix) {
  const suffix = ASSEMBLY_DERIVED_ORIGIN_SUFFIXES[key];
  return suffix === undefined ? `${prefix}.policy.${key}` : `${prefix}.${suffix}`;
}

/**
 * The config leaves the assembly port contributes itself (issue #544).
 *
 * `session.id` / `session.initialMessages` are the port's spelling of two knobs whose canonical
 * home is the config tree (`config.run.runId` / `config.input.messages`). They used to be emitted
 * as **flat options** (`runId` / `initialMessages`), i.e. the engine produced exactly the spelling
 * the name gate refuses a host for writing: `runToolLoop({ runId })` threw while
 * `runToolLoop({ assemblyPort })` sailed through with the same key in the merged tree. One option
 * tree cannot have two legalities, so the port now speaks the canonical spelling too.
 *
 * The values are unchanged (`session.id` is still the run id, `session.initialMessages` still the
 * seed history): the expansion phase writes both leaves back onto `effectiveOptions.runId` /
 * `.initialMessages`, so no engine read side moves.
 *
 * @param {AssemblyPort} port
 * @returns {Record<string, Record<string, any>>} group → leaf → value
 */
/**
 * The config path a `policy` **leaf name** translates to (issue #545), or `undefined` when the name
 * is not a config leaf.
 *
 * `configPathForOption` is the primary answer: it is derived from the one hand-written table
 * (`CONFIG_NAMESPACE_SCHEMA`), so a leaf that keeps its spelling (`maxRounds` → `run.maxRounds`)
 * needs no table here. The fallback covers the single leaf whose spelling differs from its top-level
 * key (`input.messages`, whose flat name is `initialMessages`): `configPathForOption` answers
 * "where does this *top-level key* live", which is a different question from "is this a *leaf*".
 * No mapping table is written: both answers come from the schema.
 *
 * @param {string} name
 * @returns {string|undefined} e.g. `run.maxRounds`
 */
function configPathForPolicyLeaf(name) {
  const path = configPathForOption(name);
  if (path !== undefined) return path;
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    if (CONFIG_NAMESPACE_SCHEMA[group].includes(name)) return `${group}.${name}`;
  }
  return undefined;
}

/**
 * The `policy` plane's config leaves, translated into a config tree (issue #545).
 *
 * Before this slice `policy` was a **second flat spelling surface**: `policy.maxRounds` entered the
 * merged option tree as a flat `maxRounds`, i.e. exactly the spelling `runToolLoop({ maxRounds })`
 * is refused for. One option tree cannot have two legalities, so every leaf name is now written
 * where it lives (`config.run.maxRounds`), through the schema — never through a rename table.
 *
 * `undefined` still means "not given" (the same `value !== undefined` merge rule as everywhere
 * else), so a host that spreads an options object does not erase a value by accident.
 *
 * @param {Record<string, any>|undefined} policy
 * @returns {Record<string, Record<string, any>>} group → leaf → value
 */
function translatedPolicyConfigLeaves(policy) {
  /** @type {Record<string, Record<string, any>>} */
  const leaves = {};
  for (const [name, value] of Object.entries(policy ?? {})) {
    if (value === undefined) continue;
    const path = configPathForPolicyLeaf(name);
    if (path === undefined) continue;
    const [group, leaf] = path.split(".");
    (leaves[group] ??= {})[leaf] = value;
  }
  return leaves;
}

/**
 * Fold translated `policy` leaves under the port's own `policy.config` tree, per leaf, explicit tree
 * wins (issue #545).
 *
 * Not a new priority: it is the priority the flat spelling had (a flat key and `config.<path>` are
 * the same knob, and the tree wins — `expandConfigNamespace`), moved one phase earlier because the
 * flat spelling no longer exists. A collision is reported, not silenced (see
 * `collectAssemblyPolicyConfigConflicts`).
 *
 * @param {Record<string, Record<string, any>>} translated
 * @param {Record<string, any>|undefined} explicitTree `policy.config`
 * @returns {Record<string, any>}
 */
function mergePolicyConfigTree(translated, explicitTree) {
  const merged = {};
  for (const [group, leaves] of Object.entries(translated)) merged[group] = { ...leaves };
  for (const [group, bag] of Object.entries(explicitTree ?? {})) {
    if (bag === undefined) continue;
    merged[group] = { ...(merged[group] ?? {}), ...bag };
  }
  return merged;
}

/**
 * The `config_override_conflict` rows the `policy` plane owes **against itself** (issue #545):
 * `policy.maxRounds` and `policy.config.run.maxRounds` are the same knob from two sources, so when
 * both carry a value and the values differ the caller gets one event (path `run.maxRounds`), exactly
 * as the flat-vs-`config` rule used to report it. Same event, same `{ path, key }` shape, no silence.
 *
 * @param {AssemblyPort} port
 * @returns {Array<{path: string, key: string}>}
 */
export function collectAssemblyPolicyConfigConflicts(port) {
  return collectConfigSourceConflicts(
    translatedPolicyConfigLeaves(port.policy),
    port.policy?.config,
  );
}

function assemblyPortDerivedConfigLeaves(port) {
  return sessionDerivedConfigLeaves(port.session) ?? {};
}

/**
 * A **copy** of the port's own `policy.config` tree — the seed `createAgent` merges this call's
 * config leaves onto (issue #571 slice 2).
 *
 * Why a copy and not the host's object: `policy` belongs to the host (a frozen `policy`, or a frozen
 * `policy.config` bag, is a normal shape), and the wrapper has to merge a call leaf in without
 * writing to it. The copy is **group-level**, exactly the discipline `mergeConfigLeaves`
 * (`src/loop/orchestrator.js`) and `fillConfigLeafHoles` already use: leaf values travel by
 * reference (that is how both routes read `config.folding.context` and friends today), the bags are
 * new objects.
 *
 * Why the wrapper needs it at all: `runToolLoop`'s merge rule is "a call-level `config` in play
 * replaces `policy.config` wholesale" (unchanged — see `normalizeRunToolLoopOptions`
 * (`src/loop/option-normalization.js`)), and the two fill rungs that survive an override restore only
 * the translated `policy.<leaf>` spellings (`withAssemblyPolicyConfigLeaves`) and the `session`-derived
 * leaves (`withSessionDerivedConfigLeaves`) — **not** the leaves the host wrote under `policy.config`.
 * A wrapper that hands over a tree built from this call alone therefore deletes those leaves
 * silently. Seeding the tree with a copy makes the override a no-op **in content terms**: every
 * seeded leaf keeps its value, and `collectConfigSourceConflicts` stays silent because it reports
 * only leaves whose values **differ** (measured: 0 events for the shape pinned by
 * `test/loop-create-agent-571.test.js` J1 — see that cell for the number and the reasoning).
 *
 * `undefined` when there is no port, no `policy`, or no `policy.config` tree: the caller must not
 * manufacture a tree out of nothing (that is #574's presence rule, and it still is the rule).
 *
 * Factory-shaped `policy` is resolved through the same `resolveAssemblyMember` the port itself uses,
 * so the seed cannot disagree with what `createAssemblyPort` will read. Consequence worth knowing: a
 * **factory-shaped** `policy` is called once here and once more by `createAssemblyPort` on each run
 * (the wrapper cannot see the resolved port). The value must therefore be a pure function of its
 * inputs — which is what "synchronous factory" already meant for the other members.
 *
 * @param {unknown} portInput the raw host input handed to `createAgent({ assemblyPort })`
 * @returns {Record<string, any>|undefined}
 */
export function assemblyPortPolicyConfigSeed(portInput) {
  if (portInput === null || typeof portInput !== "object" || Array.isArray(portInput)) return undefined;
  const policy = resolveAssemblyMember(/** @type {any} */ (portInput).policy, "policy");
  const tree = policy?.config;
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) return undefined;
  /** @type {Record<string, any>} */
  const seed = {};
  for (const [group, bag] of Object.entries(tree)) {
    seed[group] = bag !== null && typeof bag === "object" && !Array.isArray(bag) ? { ...bag } : bag;
  }
  return seed;
}

/**
 * The `session` container's contribution to the option tree, **as a function of the session value**
 * (issue #550).
 *
 * #544 wrote this derivation inside the assembly port only, and the direct route never had it: a
 * direct host that spelled `session: { id, initialMessages }` got the container *validated* (the
 * #513 member gate) and then ignored — the run id never reached `config.run.runId` (transcripts were
 * keyed `undefined`) and the seed never reached the request. One key, two behaviours for one shape is
 * the same defect #513 fixed for unknown members, one level down; #550 adjudicated `session` as
 * **the container only**, so both routes now derive from it through this one function.
 *
 * `undefined` when the value is not a container or carries neither member: the caller must not
 * manufacture an empty `config` tree out of nothing.
 *
 * The member reads are spelled `session.<name>` on purpose: `test/session-container-513.test.js`
 * re-derives the accepted member set by scanning `src/**` for exactly that shape, and this function
 * is the read point the table now points at for both `id` and `initialMessages`. Reading them off an
 * aliased local (`container.id`) would make the derived set report "declared but never read" — the
 * guard biting on a rename is the guard working, so the spelling stays.
 *
 * @param {{id?: unknown, initialMessages?: unknown}|null|undefined} session
 * @returns {Record<string, Record<string, any>>|undefined}
 */
export function sessionDerivedConfigLeaves(session) {
  if (session === null || typeof session !== "object" || Array.isArray(session)) return undefined;
  /** @type {Record<string, Record<string, any>>} */
  const leaves = {};
  if (typeof session.id === "string" && session.id.length > 0) {
    leaves.run = { runId: session.id };
  }
  if (session.initialMessages !== undefined) {
    leaves.input = { messages: session.initialMessages };
  }
  return Object.keys(leaves).length === 0 ? undefined : leaves;
}

/**
 * Fold the container's derived leaves into a config tree, per leaf, only where the tree has no value
 * (issue #550 — the same rung-3 rule #544 applies on the assembly port, now shared).
 *
 * @param {Record<string, any>|undefined} configTree
 * @param {unknown} session
 * @returns {Record<string, any>|undefined}
 */
export function withSessionDerivedConfigLeaves(configTree, session) {
  const leaves = sessionDerivedConfigLeaves(session);
  if (leaves === undefined) return configTree;
  return fillConfigLeafHoles(configTree, leaves);
}

/**
 * Fold the port's own config leaves under a config tree, per leaf, only where that tree has no value
 * (issue #544).
 *
 * Not a new merge rule: the derived values used to be flat options, and `expandConfigNamespace` lets
 * `config.*` win over the flat spelling of the same knob — so "the tree wins, the derived value fills
 * the hole" is the behaviour that was already in force. It is applied twice, on purpose: to the
 * port's `policy.config` when the base options are built, and to a call-level `config` after the
 * wholesale container override (a host that passes `config: { input: { wrapup: false } }` must not
 * lose the port's run identity — the flat spelling never could be erased that way, and this slice
 * moves the spelling, not the durability).
 *
 * A collision between the two sources is still reported (see
 * `collectAssemblyDerivedConfigConflicts`): one knob, two sources, no silence.
 *
 * @param {Record<string, any>|undefined} configTree
 * @param {AssemblyPort} port
 * @returns {Record<string, any>}
 */
export function withAssemblyDerivedConfigLeaves(configTree, port) {
  return fillConfigLeafHoles(configTree, assemblyPortDerivedConfigLeaves(port));
}

/**
 * Per-leaf "fill the hole" fold: every leaf in `leaves` lands under `configTree` **only** where the
 * tree has no value for it (`undefined` counts as "not given", the merge rule used everywhere else).
 *
 * @param {Record<string, any>|undefined} configTree
 * @param {Record<string, Record<string, any>>} leaves group → leaf → value
 * @returns {Record<string, any>}
 */
function fillConfigLeafHoles(configTree, leaves) {
  const merged = { ...(configTree ?? {}) };
  for (const [group, bag] of Object.entries(leaves)) {
    const next = { ...bag };
    for (const [leaf, value] of Object.entries(merged[group] ?? {})) {
      // `undefined` is "not given", so it does not close the hole: spreading it over the fallback
      // would erase the value while looking like it was set (`{ run: { maxRounds: undefined } }`).
      if (value !== undefined) next[leaf] = value;
    }
    merged[group] = next;
  }
  return merged;
}

/**
 * Fold the port's own config leaves — the translated `policy` leaves **and** the derived leaves — into
 * a config tree, per leaf, only where the tree has no value (issue #545).
 *
 * The two rungs, in order, are the priority order, and it is not new:
 *   1. an explicit `policy.config` / call-level `config` value wins (it is already in the tree);
 *   2. a translated `policy.<leaf>` fills the hole — the priority the **flat** spelling had, since a
 *      flat key and `config.<path>` were always the same knob with the tree winning;
 *   3. a #544 derived leaf (`session.id` → `config.run.runId`) fills what is still empty, so a host
 *      that writes `policy.runId` keeps its value (and owes a `config_override_conflict`, see
 *      `collectAssemblyDerivedConfigConflicts`).
 *
 * Rung 2 has to be re-applied after a call-level `config` override for the same reason rung 3 is: the
 * override is **wholesale**, so without this a host that passes `config: { run: { maxRounds: 1 } }`
 * would silently lose every other `policy` leaf — and the flat spelling it replaces never could be
 * erased that way. What the override does win is the leaves it actually names (and `undefined` is
 * "not given", not "erase").
 *
 * @param {Record<string, any>|undefined} configTree
 * @param {AssemblyPort} port
 * @returns {Record<string, any>}
 */
export function withAssemblyPolicyConfigLeaves(configTree, port) {
  return withAssemblyDerivedConfigLeaves(
    fillConfigLeafHoles(configTree, translatedPolicyConfigLeaves(port.policy)),
    port,
  );
}

/**
 * The `config_override_conflict` rows a port-derived config leaf owes against the port's own
 * `policy.config` (issue #544).
 *
 * Before this slice the derived leaves were **flat** options, so a host that wrote the same knob
 * into `policy.config` hit the flat-vs-config rule and got one event (path `run.runId` /
 * `input.messages`). The flat spelling is gone; the two sources are not — so the observation is
 * made here explicitly, with the same path and the same key, and it stays one event (the caller
 * dedupes by path). A factory-shaped `policy` is not resolved at this phase, so its tree is not
 * visible and nothing is compared against it.
 *
 * @param {AssemblyPort} port
 * @returns {Array<{path: string, key: string}>}
 */
export function collectAssemblyDerivedConfigConflicts(port) {
  return collectConfigSourceConflicts(
    assemblyPortDerivedConfigLeaves(port),
    // #545: the tree the derived leaves are folded into is `policy.config` **plus** the translated
    // `policy` leaves — a host that writes `policy.runId` instead of `session.id` collides with the
    // same knob, so it owes the same event.
    mergePolicyConfigTree(
      translatedPolicyConfigLeaves(port.policy),
      port.policy?.config,
    ),
  );
}

/**
 * The name gate on the **merged** representation (issue #544).
 *
 * `assertRunToolLoopOptionNames` runs on the caller's explicit options before any host port is read
 * (that phase stays: a bad name must not cost a host callback). This second pass runs after
 * `assemblyPortOptions` has contributed its own keys, because the seam it closes is the opposite
 * direction: a name the **engine** derives for itself was never checked, so the engine could emit a
 * spelling the host is refused for. `runId` / `initialMessages` survived the A20 / `input`-slice
 * retirements exactly that way — `runToolLoop({ runId })` threw while
 * `runToolLoop({ assemblyPort })` put the very same key in the merged tree and ran.
 *
 * **No plane is exempt** (issue #545). The `policy` exemption that used to live here was the hole
 * itself: `policy` accepted retired flat spellings, so `policy.runId` crossed this gate on it while
 * `runToolLoop({ runId })` threw for the same key. `policy` now carries data only and translates every
 * leaf into its canonical config path (`translatedPolicyConfigLeaves`), so the merged tree it produces
 * holds only legal loop options — `config` / `capabilities` / the port-derived keys — and the gate can
 * judge every key on its own merits. Removing the exemption is the proof the hole is closed, not a
 * side effect: `test/assembly-policy-derivation-525.test.js` (C1) turns red if anything puts a retired
 * flat name back in the merged tree.
 *
 * @param {Record<string, any>} mergedOptions
 * @returns {void}
 */
export function assertMergedOptionNames(mergedOptions) {
  for (const optionName of Object.keys(mergedOptions)) {
    if (RUN_TOOL_LOOP_OPTION_SET.has(optionName)) continue;
    // Canonical rejection (same wording, same `config.<home>` pointer): an offender here is an
    // unknown name in the same tree, whoever wrote it.
    assertRunToolLoopOptionNames({ [optionName]: mergedOptions[optionName] });
  }
}

/**
 * 构造期（`createAssemblyPort` 的产物）能给哪些选项**定值**——单一来源。
 * `assemblyPortOptions` 的返回值就是它的展开（`modelConfig` 那格换成 resolve 的结果），
 * 所以「哪些键是构造期给的」不需要第二份清单：冲突判定直接拿它当事实。
 *
 * `modelConfig` 这里放的是 **resolver 本体**（不是 resolve 结果）：本函数不 await，
 * 才能保证冲突判定早于任何宿主回调。
 *
 * @param {AssemblyPort} port
 * @returns {Record<string, any>}
 */
function assemblyPortBaseOptions(port) {
  const policy = port.policy ?? {};
  return {
    // #545: nothing is spread flat any more. Every accepted `policy` name is either a config leaf
    // (translated into the tree below) or one of the two containers, so the merged tree this
    // function produces contains no retired spelling at all.
    modelConfig: port.modelConfig,
    provider: port.provider,
    tools: port.tools.definitions,
    executeTool: port.tools.executeTool,
    ...(port.store === undefined ? {} : { store: port.store }),
    // #544: the run identity and the seed history are config leaves, not flat options — see
    // `assemblyPortDerivedConfigLeaves`. `policy.config` still wins per leaf, which is exactly the
    // priority the flat spelling had via the expansion phase; #545 adds the translated `policy`
    // leaves to the same tree, one rung below the explicit tree.
    config: withAssemblyDerivedConfigLeaves(
      mergePolicyConfigTree(translatedPolicyConfigLeaves(policy), policy.config),
      port,
    ),
    // #498 S4a: the second container. It used to arrive through the flat spread; it is not a leaf, so
    // it is passed through by name — same tree, same rules as the call-level `capabilities`.
    ...(policy.capabilities === undefined ? {} : { capabilities: policy.capabilities }),
    session: port.session,
    // #498 S4b：这里曾有 `session.resume` → `resume` 的转换（幻影组）。`session` 是纯数据，
    // `resume` 的规范之家是顶层 `resume` / `config.run.resume`；两条路线都已拒绝 `session.resume`
    // （装配期在上面那段校验，直连侧在语义相），所以这里不再需要任何转换。
    // #544: `session.initialMessages` used to be flattened to `initialMessages` right here; it now
    // travels as `config.input.messages` in the `config` tree above.
    // `emit` → `onEvent` 的适配。以前这里是「显式 onEvent 存在就不装」，现在那条分支由
    // 下面的冲突闸口接手：端口给了 `emit` 就等于构造期给了 `onEvent`，调用期再给一个就抛。
    ...(port.emit === undefined ? {} : { onEvent: (event) => port.emit(event.type, event) }),
  };
}

/**
 * 调用期覆盖的**键名/容器**闸口（issue #498 第 1 条）。不读宿主端口：与顶层未知键检查同相。
 *
 * 三条规则：
 *   1. 容器 `config` / `capabilities` 一律拒绝（整块替换会把两面重新搅混）；
 *   2. 任意名字拒绝——键名闭集 = `RUN_TOOL_LOOP_OPTION_NAMES`（从代码枚举，不另抄一份）；
 *   3. `undefined` 仍然等于「没给」（与既有的 `!== undefined` 合并语义同口径，见下）。
 *
 * @param {Record<string, any>} overrides
 * @returns {void}
 */
function assertAssemblyOverrideShape(overrides) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("assembly port overrides must be an object");
  }
  for (const [key, value] of Object.entries(overrides)) {
    // `undefined` 不是「给了」，是「省略」——既有合并语义（`value !== undefined` 才覆盖）逐字保留。
    if (value === undefined) continue;
    const containerHint = ASSEMBLY_OVERRIDE_CONTAINERS.get(key);
    if (containerHint !== undefined) {
      throw new TypeError(
        `assembly port override must not replace the ${JSON.stringify(key)} container:`
        + ` pass the specific sub-keys instead (${containerHint})`,
      );
    }
    if (!RUN_TOOL_LOOP_OPTION_SET.has(key)) {
      const suggestion = optionSuggestion(key);
      throw new TypeError(
        `unknown assembly port override option: ${JSON.stringify(key)}`
        + (suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : ""),
      );
    }
  }
}

/**
 * 「构造期给过、调用期又给」⇒ 启动期硬失败（issue #498 第 1 条；母单 #495 的裁决：
 * 能力集在**构造期**定，运行期不许悄悄换）。
 *
 * 判定用的是 `assemblyPortBaseOptions` 的**实际产物**，不是一份手抄清单：`policy` 里给了值的键、
 * 端口派生的键都在里面，漏掉一个是不可能的。
 *
 * **唯一的例外是 `modelConfig`**：它是 #498 之前就有的、**自带校验**的覆盖通道
 * （`validateModelConfigResolver`，见下面 `assemblyPortOptions`），刻意保留。
 *
 * @param {Record<string, any>} overrides
 * @param {Record<string, any>} base
 * @returns {void}
 */
function assertAssemblyOverrideConflicts(overrides, base) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (key === "modelConfig") continue;
    if (base[key] === undefined) continue;
    const origin = assemblyDerivedOrigin(key, "port");
    throw new TypeError(
      `assembly port option override conflicts with the port: ${JSON.stringify(key)}`
      + ` comes from ${origin} (construction) and overrides.${key} (call);`
      + " pass it in one place only",
    );
  }
}

/**
 * 直连路线上**不**走冲突闸口的键（issue #519 的射程边界，逐条带理由）。
 *
 * 三者都是**既有通道**，各有自己的出口；把它们并进「冲突一律抛」不是本单的裁决：
 *   · `modelConfig` —— `assemblyPortOptions` 的 `overrides` 里唯一被保留的例外（自带
 *     `validateModelConfigResolver` 校验）。直连路线把它原样当 `overrides.modelConfig` 传下去，
 *     所以在这里抛会让 `runToolLoop({ assemblyPort, modelConfig })` 与
 *     `assemblyPortOptions(port, { modelConfig })` 两条路线**不一致**——而 #519 要的正是同一条规则。
 *   · `config` / `capabilities` —— 两个容器的冲突出口是**逐叶事件**
 *     （`config_override_conflict`，#497 / #498 R4 / #545），不是启动期抛：整棵树由调用级赢、
 *     值不同的叶子各记一条。改这条 = 扩大射程，本单不改（登记在 #519 的报告里）。
 *     它们在被 `normalizeRunToolLoopOptions` 解构出去之后**根本到不了**本闸口，所以这两项是
 *     「合并语义」的声明，不是闸口的输入。
 *
 * @type {ReadonlySet<string>}
 */
export const DIRECT_ROUTE_CONFLICT_EXEMPTIONS = new Set(["modelConfig", "config", "capabilities"]);

/**
 * 直连路线的同一个键两边各给一次 ⇒ 启动期硬失败（issue #519，与 #518b 的 `overrides` 通道同一条
 * 规则：来源唯一性本身就是要保的东西）。
 *
 * `runToolLoop({ assemblyPort, provider })`：`provider` 既在端口里（构造期）、又在调用点
 * （`runToolLoop.<x>`）给了一次 —— 以前**静默覆盖**（后写者胜），现在抛，并点名两个来源。
 *
 * 三条边界，逐条对应一格判据：
 *   1. **两边不同值 ⇒ 抛**，点名 `assemblyPort.<x>` 与 `runToolLoop.<x>`；
 *   2. **一边是 `undefined` ⇒ 不抛**（`undefined` = 「没给」，与既有的 `value !== undefined`
 *      合并口径同源；代价：拼错且值恰好 `undefined` 抓不到，记录在案）；
 *   3. **两边同值 ⇒ 也抛**（#518b 的裁决，不引入 deep-equal 豁免）：值相同也意味着两处各写了一次，
 *      其中一处早晚会漂。放宽只需改一行 + 一格断言，但那是**产品决定**，实现者不顺手加。
 *
 * 判定用的是 `assemblyPortOptions` 的**实际产物**（`assembledOptions`），不是一份手抄清单：
 * 端口给了哪些键是构造出来的事实，漏掉一个是不可能的。代价：本闸口跑在 `modelConfig.resolve`
 * **之后**（那份产物要等 resolve 完才有），所以一次注定要抛的调用会先跑一次宿主 resolver——
 * 与 #518b 的「先抛后调」不同，要消掉它得把端口构造拆出来（两处各读一次宿主 getter），不值得。
 *
 * @param {Record<string, any>} assembledOptions `assemblyPortOptions` 的产物
 * @param {Record<string, any>} explicitOptions 调用点给的选项（`assemblyPort` / `config` /
 *   `capabilities` 已被调用方解构出去）
 * @returns {void}
 */
export function assertDirectRouteConflicts(assembledOptions, explicitOptions) {
  for (const [key, value] of Object.entries(explicitOptions)) {
    if (value === undefined) continue;
    if (DIRECT_ROUTE_CONFLICT_EXEMPTIONS.has(key)) continue;
    if (assembledOptions[key] === undefined) continue;
    throw new TypeError(
      `runToolLoop option conflicts with the assembly port: ${JSON.stringify(key)}`
      + ` comes from ${assemblyDerivedOrigin(key, "assemblyPort")} (construction)`
      + ` and runToolLoop.${key} (call); pass it in one place only`,
    );
  }
}

function resolveAssemblyMember(value, name) {
  const resolved = typeof value === "function" ? value() : value;
  if (resolved && typeof resolved.then === "function") {
    throw new TypeError(`assembly port ${name} factory must resolve synchronously`);
  }
  return resolved;
}

function missingAssemblyMethods(port) {
  const missing = [];
  if (!port || typeof port !== "object" || Array.isArray(port)) {
    return ["assemblyPort"];
  }
  missing.push(...validateModelConfigResolver(port.modelConfig));
  missing.push(...validateProviderBoundary(port.provider));
  if (!port.tools || !Array.isArray(port.tools.definitions)) {
    missing.push("tools.definitions");
  }
  if (!port.tools || typeof port.tools.executeTool !== "function") {
    missing.push("tools.executeTool");
  }
  if (port.store !== undefined) {
    if (typeof port.store !== "object" || port.store === null || Array.isArray(port.store)) {
      missing.push("store");
    } else {
      missing.push(...validateTranscriptStore(port.store));
    }
  }
  if (!port.session || typeof port.session !== "object" || Array.isArray(port.session)) {
    missing.push("session");
  } else if (typeof port.session.id !== "string" || port.session.id.length === 0) {
    missing.push("session.id");
  }
  if (port.policy !== undefined
    && (typeof port.policy !== "object" || port.policy === null || Array.isArray(port.policy))) {
    missing.push("policy");
  }
  if (port.emit !== undefined && typeof port.emit !== "function") {
    missing.push("emit");
  }
  return missing;
}

/**
 * @typedef {object} AssemblyPort
 * @property {{resolve:(slot?:string)=>Promise<object>|object}} modelConfig
 *   ModelConfigProvider for the assembled session.
 * @property {{chat:(request:object)=>Promise<object>,chatStream?:Function}} provider
 *   Provider instance. The library never reads credentials from this boundary.
 * @property {{definitions:object[],executeTool:Function,getToolMetadata?:Function}} tools
 *   Tool definitions and the structured ToolExecutor.
 * @property {object} [store]
 *   Optional TranscriptStore. Required: `appendRound`, `load`. Optional
 *   capabilities (issue #78): run snapshot (`saveRunSnapshot`,
 *   `loadLatestRunSnapshot`) and run-state (`markRunState`, `saveRunState`,
 *   `loadRunState`); missing optional methods degrade, they do not fail.
 *   `loadRunStateStatus` is an optional host-facing terminal-status reader;
 *   the engine does not consume or validate it.
 * @property {{id:string,modelSlot?:string,initialMessages?:object[]}} session
 *   Run identity and optional resume seed.
 * @property {object} [policy]
 *   Explicit run options; unknown policy keys are rejected.
 * @property {(event:string,payload:object)=>void|Promise<void>} [emit]
 *   Optional event sink. It is used only when runToolLoop has no explicit onEvent.
 */

/**
 * The **top-level members** of the assembly port, derived from the engine's real read points
 * (issue #556). This table is the **one** place the accepted set is written *and* the one place the
 * members are read: `createAssemblyPort` builds the port by iterating it, so a name that is not in
 * the table can never be a member and a member can never be absent from the table.
 *
 * Why the port needed a gate at all: `runToolLoop`'s direct route takes `config` / `capabilities` as
 * **top-level** containers, while the port route carries the same data plane inside `policy`
 * (`policy.config` / `policy.capabilities`, #545). A host that writes the direct spelling into
 * `createAssemblyPort` therefore got the worst possible answer until #556: no throw, no event, the
 * whole subtree silently dropped, and the run finished `end_turn` with none of the folding / timing
 * configuration it thought it had set. A typo was just as quiet (`{ provder: … }` also vanished).
 *
 * The list is not trusted on its own: `test/assembly-port-member-gate-556.test.js` re-derives the set
 * from this file's `input.<name>` member reads and compares it with the table in **both** directions
 * — a name here with no read point fails, and a new read point missing here fails.
 *
 * `optional: true` = the key is omitted from the port when the host did not supply it (`emit`); every
 * other member is always present, even as `undefined`, which is the shape the port has always had.
 *
 * @type {ReadonlyArray<{
 *   name: string,
 *   read: (input: Record<string, any>) => any,
 *   optional?: true,
 *   readBy: string,
 * }>}
 */
export const ASSEMBLY_PORT_MEMBER_READ_POINTS = Object.freeze([
  {
    name: "modelConfig",
    read: (input) => resolveAssemblyMember(input.modelConfig, "modelConfig"),
    readBy: "createAssemblyPort() → port.modelConfig → assemblyPortOptions() → modelConfig.resolve()",
  },
  {
    name: "provider",
    read: (input) => resolveAssemblyMember(input.provider, "provider"),
    readBy: "createAssemblyPort() → port.provider → assemblyPortBaseOptions() → the loop's provider",
  },
  {
    name: "tools",
    read: (input) => resolveAssemblyMember(input.tools, "tools"),
    readBy: "createAssemblyPort() → port.tools → assemblyPortBaseOptions()"
      + " → tools.definitions / executeTool",
  },
  {
    name: "store",
    read: (input) => resolveAssemblyMember(input.store, "store"),
    readBy: "createAssemblyPort() → port.store → assemblyPortBaseOptions() (optional)",
  },
  {
    name: "session",
    read: (input) => resolveAssemblyMember(input.session, "session"),
    readBy: "createAssemblyPort() → port.session → assemblyPortBaseOptions() / modelConfig.resolve(modelSlot)",
  },
  {
    name: "policy",
    read: (input) => resolveAssemblyMember(input.policy, "policy"),
    readBy: "createAssemblyPort() → port.policy → assemblyPortBaseOptions()"
      + " (data plane: policy.config / policy.capabilities)",
  },
  {
    name: "emit",
    read: (input) => input.emit,
    optional: true,
    readBy: "createAssemblyPort() → port.emit → assemblyPortBaseOptions() → onEvent adapter",
  },
]);

/** The accepted top-level port members, derived from {@link ASSEMBLY_PORT_MEMBER_READ_POINTS}. */
export const ASSEMBLY_PORT_MEMBER_NAMES = ASSEMBLY_PORT_MEMBER_READ_POINTS.map(({ name }) => name);

/** Set form of {@link ASSEMBLY_PORT_MEMBER_NAMES} (the gate's membership test). */
const ASSEMBLY_PORT_MEMBER_NAME_SET = new Set(ASSEMBLY_PORT_MEMBER_NAMES);

/**
 * The two containers that exist on the **direct** route's top level and are *not* port members
 * (issue #556). The port carries the same trees one level down, inside `policy` (#545), so a host
 * that writes them at the top level is not making a spelling mistake — it is using the other
 * route's address. The message therefore names the correct home instead of just closing the door.
 *
 * @type {ReadonlyMap<string, {home: string, plane: string}>}
 */
const ASSEMBLY_PORT_CONTAINER_HOMES = new Map([
  ["config", { home: "policy.config", plane: "data" }],
  ["capabilities", { home: "policy.capabilities", plane: "behaviour" }],
]);

/**
 * The nearest accepted member name, by the same edit-distance rule (and the same threshold
 * `max(2, len/3)`) the direct route's `optionSuggestion` uses. Ties go to the earlier table entry.
 *
 * @param {string} unknownName
 * @returns {string|undefined}
 */
function assemblyPortMemberSuggestion(unknownName) {
  let best;
  for (const memberName of ASSEMBLY_PORT_MEMBER_NAMES) {
    const distance = levenshteinDistance(unknownName, memberName);
    if (best === undefined || distance < best.distance) {
      best = { name: memberName, distance };
    }
  }
  const threshold = Math.max(2, Math.floor(unknownName.length / 3));
  return best?.distance <= threshold ? best.name : undefined;
}

/**
 * The one sentence an unknown top-level port member gets (issue #556).
 *
 * Three clauses, in the order a host needs them: what was refused, the accepted set (interpolated
 * from the derived table — never a second hand-written copy), and — for the two names that are
 * legal on the *other* route — where the value actually belongs.
 *
 * @param {string} name
 * @returns {string}
 */
function assemblyPortUnknownMemberProblem(name) {
  const suggestion = assemblyPortMemberSuggestion(name);
  const container = ASSEMBLY_PORT_CONTAINER_HOMES.get(name);
  return `unknown assembly port option: ${JSON.stringify(name)}`
    + (suggestion === undefined ? "" : ` (did you mean ${JSON.stringify(suggestion)}?)`)
    + ` (accepted: ${ASSEMBLY_PORT_MEMBER_NAMES.join(", ")})`
    + (container === undefined
      ? ""
      : `; its canonical home is ${container.home}: the port keeps the ${container.plane} plane`
        + ` inside policy (write { policy: { ${name}: … } }), while the top-level ${name}`
        + " container is the direct route's spelling");
}

/**
 * How a non-object `createAssemblyPort` input reads in the shape message (`null` / `an array` / `a string`).
 *
 * @param {unknown} value
 * @returns {string}
 */
function describePortInput(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "function") return "a function";
  return `a ${typeof value}`;
}

/**
 * The **top-level name gate** of the assembly port (issue #556).
 *
 * Runs before any member is read, i.e. before any host factory is called — the same ordering promise
 * `assertRunToolLoopOptionNames` keeps on the direct route (`test/loop-option-normalization.test.js`
 * pins it with a `Proxy`): a misspelled name must not cost a host callback.
 *
 * `undefined` still means "not given" (the repo-wide merge rule), so spreading an options object
 * with an optional key set to `undefined` does not turn into an unknown-member report — the same
 * convention `assertAssemblyOverrideShape` and the `policy` allowlist already follow.
 *
 * @param {Record<string, any>} input
 * @returns {void}
 */
export function assertAssemblyPortMemberNames(input) {
  // A non-object input is a *shape* mistake, and it must not be reported as an unknown **member**:
  // `Object.entries("abc")` yields `["0", "a"]`, i.e. the gate would name a member called `"0"`. Same
  // sentence shape as the direct route's `runToolLoop options must be an object`.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`assembly port must be an object (got ${describePortInput(input)})`);
  }
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (ASSEMBLY_PORT_MEMBER_NAME_SET.has(name)) continue;
    throw new TypeError(assemblyPortUnknownMemberProblem(name));
  }
}

/**
 * Read every port member through {@link ASSEMBLY_PORT_MEMBER_READ_POINTS} — the accepted set and the
 * construction are the same table, so neither can drift from the other.
 *
 * @param {Record<string, any>} input
 * @returns {AssemblyPort}
 */
function readAssemblyPortMembers(input) {
  /** @type {Record<string, any>} */
  const port = {};
  for (const { name, read, optional } of ASSEMBLY_PORT_MEMBER_READ_POINTS) {
    const value = read(input);
    if (optional === true && value === undefined) continue;
    port[name] = value;
  }
  return /** @type {AssemblyPort} */ (port);
}

/**
 * Assemble and validate the host boundary once.
 *
 * Required adapter members may be supplied as synchronous factories. This
 * keeps construction at the host composition root while allowing the loop to
 * consume one normalized port object.
 *
 * @param {object} input
 * @returns {AssemblyPort}
 */
export function createAssemblyPort(input = {}) {
  // issue #556: the name gate is the **first** thing that runs. Before it, an unknown top-level
  // member was accepted and silently dropped (the port object simply did not carry it), which is the
  // "configured but inert" shape this gate exists to kill — and the two most likely offenders
  // (`config` / `capabilities`) are exactly the names the direct route *does* take.
  assertAssemblyPortMemberNames(input);
  // `port` is deliberately typed `any` here, exactly as the object literal it replaced was: the
  // members are validated one by one right below (`missingAssemblyMethods`, the `session` container
  // gate, the `policy` allowlist), and one of those checks reads a **retired** member
  // (`port.session.resume`) that the `AssemblyPort` typedef intentionally does not declare —
  // declaring it would document a retired key as legal (#498 S4b).
  const port = /** @type {any} */ (readAssemblyPortMembers(input));
  // issue #513 ④: `session` is the port's identity container by contract, so a non-object value is a
  // *shape* mistake and says so. Without this line it surfaced as `assembly port is missing methods:
  // session` — a sentence about methods for a value that is not a port at all, which is what made
  // `createAssemblyPort({ session: "x" })` unreadable.
  if (port.session !== undefined
    && (port.session === null || typeof port.session !== "object" || Array.isArray(port.session))) {
    throw tagValidationRoute(new TypeError(sessionContainerTypeProblem(port.session)), "assembly");
  }
  const missing = missingAssemblyMethods(port);
  if (missing.length > 0) {
    throw new TypeError(`assembly port is missing methods: ${missing.join(", ")}`);
  }
  // issue #513 ①②: the port member answers to the same allowlist the direct route's semantic phase
  // runs (`collectSessionContainerProblems`) — one function, one message, so the two routes cannot
  // disagree about what a legal `session` is. `session.resume` keeps its own message below (it is a
  // retired member, not an unknown one), so the two rules never compete for the same key.
  const sessionProblems = collectSessionContainerProblems(port.session);
  if (sessionProblems.length > 0) {
    throw tagValidationRoute(new TypeError(sessionProblems.join("; ")), "assembly");
  }
  if (port.session.resume !== undefined) {
    // #498 S4b：幻影组 `session` 的那条别名（`session.resume` → 顶层 `resume`）删掉了。
    // `session` 是**纯数据**（`config.metadata.session`），一个「看起来像旋钮」的键留在里面
    // 只会让宿主以为它生效了——所以拒绝并指出去处，而不是静默忽略。
    // 直连路线（`normalizeRunToolLoopOptions`）由语义相的同一条规则拒绝（
    // `collectSemanticOptionProblems`，`src/assembly-validators.js`）——两条路线都不静默。
    throw new TypeError(
      "assembly port session.resume is not accepted: session is data only"
      + " (pass it as config.run.resume; the flat top-level spelling was retired in 0.28)",
    );
  }
  // #550: the `session.initialMessages` shape rule moved into `collectSessionContainerProblems`
  // (the shared gate above), so both routes say the same sentence — the port no longer owns a second
  // copy of it (`session.initialMessages must be an array`).
  for (const [key, value] of Object.entries(port.policy ?? {})) {
    // `undefined` means "not given" (the repo-wide `value !== undefined` merge rule), so a spread
    // options object (`policy: { <name>: undefined }`) is not read as "a bad name was given".
    if (value === undefined) continue;
    if (ASSEMBLY_POLICY_CONFIG_LEAF_NAMES.has(key) || ASSEMBLY_POLICY_CONTAINER_NAMES.has(key)) continue;
    throw new TypeError(assemblyPolicyNameProblem(key));
  }
  // issue #470-D：`policy.onFoldSummary` 是可选钩子，但**给了就必须是函数**。
  // 不校形状的话，宿主把字符串/对象当钩子递进来会在真正发生折叠那一轮才炸（或默默不投递
  // ——两种都是“跑了很久才知道配错了”），而装配期一条 TypeError 就能说清。
  //
  // issue #496（S1）：`onFoldSummary` 的形状、`context` 的未知子键（#469 / #493 的旋钮家族闭集）、
  // 折叠摘要旋钮的取值（#469 / #493）与**所有承载宿主回调的字段**（`finalGuard` / `retry.sleepImpl` /
  // `reflection.onReflection` / `diagnostics.error` / 顶层 `onFoldSummary` / `context.onBeforeFold` /
  // `context.onAfterFold`）
  // 现在都由**同一个语义相闸口**校：条件与文案只写在 `collectSemanticOptionProblems`
  // （`src/assembly-validators.js`）一处，直连侧（`normalizeRunToolLoopOptions` 合并出
  // `effectiveOptions` 之后）调的是同一个函数。以前这里是「装配口有闭集、直连侧零校验」，
  // 同一份配置走两条路线结论相反（`context.summarizeBudgetMs` 装配口抛、直连静默 `end_turn`）。
  // 路线只贴标签：装配口 `via:"assembly"`，直连 `via:"direct"`。
  // issue #497（S2）：`policy.config` 的**名称/形状**在构造期就校（与上面那条 policy 白名单同相）——
  // 能力键写进 config、未知分组/叶子、把扁平键写在 config 顶层，都在这里抛，`via:"assembly"`。
  // **取值**不在这里校：展开发生在 `normalizeRunToolLoopOptions`（合并之后、语义相之前），
  // 展开后的扁平键由同一道语义相覆盖（`config.folding.context` 的旋钮拼错照样抛）。
  assertConfigNamespace(port.policy?.config, { via: "assembly" });
  // #545: the translated leaves are config leaves, so they answer to the same rule ("`config` holds
  // data only") in the **same phase** — a `policy.context.strategy` / `policy.retry.sleepImpl` is a
  // function in the config tree and is refused here, pointing at `capabilities.ports.*`, instead of
  // surfacing one phase later during expansion.
  assertConfigNamespace(translatedPolicyConfigLeaves(port.policy), { via: "assembly" });
  // issue #498（S4a）：`policy.capabilities` 与调用级 `capabilities` 是同一个容器，构造期同相校。
  assertCapabilitiesNamespace(port.policy?.capabilities, { via: "assembly" });
  assertSemanticOptionValues(port.policy ?? {}, { via: "assembly" });
  // issue #493：非「旋钮家族」的未知 `context` 子键**不抛**——契约允许宿主把私有元数据放这里
  // （`budget.js` 自己也读 `toolContext` / `expert` / `user` / `session` / `requestId`）。
  // 但也不静默：给一条事件，宿主接 `onEvent` / `emit` 就能看见（拼错旋钮名的照旧由上面抛）。
  const toleratedKeys = collectUnknownContextOptions(port.policy?.context);
  if (toleratedKeys.length > 0 && typeof port.emit === "function") {
    try {
      port.emit("context_unknown_option", {
        type: "context_unknown_option",
        keys: toleratedKeys,
        note: "unknown context keys are tolerated as host metadata; summarizer knob typos throw instead",
      });
    } catch {
      // 观察者失败不得影响装配。
    }
  }
  return Object.freeze(port);
}

/**
 * Convert a validated AssemblyPort to the existing fine-grained loop options.
 *
 * issue #498 第 1 条（母单 #495 的裁决：能力集在**构造期**定，运行期不许悄悄换）：
 * `overrides` 通道以前是「构造期给过、调用期再给就静默赢」，且能塞任意名字、能把
 * `config` / `capabilities` 整块换掉。现在三条都是启动期硬失败：
 *   · 同一个键构造期有值、调用期又给 ⇒ 抛（点名键名 + 两个来源）；
 *   · 键名必须落在 `RUN_TOOL_LOOP_OPTION_NAMES`（= 合法 loop 选项）内，否则抛；
 *   · 容器 `config` / `capabilities` 一律抛（指向具体子键）。
 * **调用期新键仍然合法**：端口没产出的键（每轮都换的 `signal`、端口没给的 `store` …）继续生效。
 * `modelConfig` 是唯一的既有例外（它自带 `validateModelConfigResolver` 校验）。
 *
 * @param {AssemblyPort} input
 * @param {object} [overrides]
 * @returns {Promise<object>}
 */
export async function assemblyPortOptions(input, overrides = {}) {
  // 键名/容器闸口在**读任何宿主端口之前**（与顶层未知键检查同相）。
  assertAssemblyOverrideShape(overrides);
  const port = createAssemblyPort(input);
  const base = assemblyPortBaseOptions(port);
  // 冲突闸口在 `modelConfig.resolve` **之前**：会抛的调用不该先调一次宿主回调。
  assertAssemblyOverrideConflicts(overrides, base);
  if (overrides.modelConfig !== undefined) {
    const missing = validateModelConfigResolver(overrides.modelConfig);
    if (missing.length > 0) {
      throw new TypeError(`assembly port is missing methods: ${missing.join(", ")}`);
    }
  }
  const options = {
    ...base,
    modelConfig: overrides.modelConfig === undefined
      ? await port.modelConfig.resolve(port.session.modelSlot)
      : overrides.modelConfig,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) options[key] = value;
  }
  return options;
}
