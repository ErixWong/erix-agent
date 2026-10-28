
import { assertCapabilitiesNamespace } from "./loop/capabilities-namespace.js";
import { assertConfigNamespace } from "./loop/config-namespace.js";
// issue #498 第 1 条：调用期覆盖的**键名闭集**不另抄一份——`overrides` 的值最终就是喂给
// `runToolLoop` 的选项，而「runToolLoop 接受哪些选项」的唯一来源是 `RUN_TOOL_LOOP_OPTION_NAMES`
// （#496 / #502 立的规矩：接受面 = 白名单，不许有第二张表）。两个符号都只在函数体里用，
// 所以 `assembly.js ↔ loop/option-normalization.js` 这条环在 ESM 下没有 TDZ 问题。
import { RUN_TOOL_LOOP_OPTION_SET, optionSuggestion } from "./loop/option-normalization.js";
import {
  MODEL_CONFIG_RESOLVER_HINT,
  assertSemanticOptionValues,
  collectUnknownContextOptions,
  validateModelConfigResolver,
  validateProviderBoundary,
  validateTranscriptStore,
} from "./assembly-validators.js";

// Re-exported for existing consumers (loop/orchestrator.js imports the hint
// from this module); the canonical definition lives in assembly-validators.js.
export { MODEL_CONFIG_RESOLVER_HINT };

const ASSEMBLY_POLICY_OPTION_NAMES = new Set([
  "system",
  "wrapup",
  "writeToolNames",
  "writeToolPathKeys",
  "replayPolicy",
  "partialPersistence",
  "maxRounds",
  "maxTokens",
  "temperature",
  "topP",
  "timeoutMs",
  "deadlineMs",
  "reflection",
  "stallDetection",
  "retry",
  "completion",
  "finalGuard",
  "finalGuardMaxRetries",
  "finalGuardTimeoutMs",
  "maxTokenContinuations",
  "context",
  "todoStateProvider",
  "semanticStateProvider",
  "modelMetadata",
  "model",
  "expert",
  "user",
  "task",
  "requestId",
  "toolContext",
  "persistence",
  "onRound",
  "onJudge",
  "onToolResult",
  "onPersistenceError",
  // issue #470-D：折叠替代物 `record.foldedFacts` 的强制投递出口（形状校验见
  // `validateFoldSummaryHook`：给了就必须是函数，给错名字/给错形状都不静默宽容）。
  "onFoldSummary",
  // issue #497（S2）：嵌套命名空间。**装配口也接受**，否则同一份配置换个入口就变成
  // `unknown assembly policy option`，又回到「校验绑在入口路线上」的老病（#496 的病根）。
  // 它的展开与校验都在 `normalizeRunToolLoopOptions`（合并之后、语义相之前）做：装配口这里
  // 只保证名字被放行，于是 `policy.config` 与直连 `config` 走的是**同一棵树、同一套规则**。
  "config",
  // issue #498（S4a）：第二个容器。装配口也接受，理由与 `config` 逐字相同——否则同一份能力面
  // 换个入口就变成 `unknown assembly policy option`，又回到「校验绑在入口路线上」的老病。
  // 名称/形状/取值在构造期校（`assertCapabilitiesNamespace`），展开在
  // `normalizeRunToolLoopOptions`（合并之后、语义相之前）。
  "capabilities",
  "diagnostics",
  "onObserverError",
  "signal",
  "stream",
  "onDelta",
  "onReasoningDelta",
  "onToolCall",
  "onUsage",
]);

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
 * `policy.<key>` 那些不在这里登记，缺省按 `port.policy.<key>` 说。
 * 这份表只影响措辞，**不是**判定依据——判定用的是实际构造出来的选项对象（见
 * `assemblyPortBaseOptions`），所以表里漏一个键只会让文案变粗，不会放过一次冲突。
 *
 * @type {Readonly<Record<string, string>>}
 */
const ASSEMBLY_DERIVED_ORIGINS = Object.freeze({
  modelConfig: "port.modelConfig",
  provider: "port.provider",
  tools: "port.tools.definitions",
  executeTool: "port.tools.executeTool",
  store: "port.store",
  runId: "port.session.id",
  session: "port.session",
  initialMessages: "port.session.initialMessages",
  onEvent: "port.emit",
});

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
  return {
    ...port.policy,
    modelConfig: port.modelConfig,
    provider: port.provider,
    tools: port.tools.definitions,
    executeTool: port.tools.executeTool,
    ...(port.store === undefined ? {} : { store: port.store }),
    runId: port.session.id,
    session: port.session,
    // #498 S4b：这里曾有 `session.resume` → `resume` 的转换（幻影组）。`session` 是纯数据，
    // `resume` 的规范之家是顶层 `resume` / `config.run.resume`；两条路线都已拒绝 `session.resume`
    // （装配期在上面那段校验，直连侧在语义相），所以这里不再需要任何转换。
    ...(port.session.initialMessages === undefined
      ? {}
      : { initialMessages: port.session.initialMessages }),
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
    const origin = ASSEMBLY_DERIVED_ORIGINS[key] ?? `port.policy.${key}`;
    throw new TypeError(
      `assembly port option override conflicts with the port: ${JSON.stringify(key)}`
      + ` comes from ${origin} (construction) and overrides.${key} (call);`
      + " pass it in one place only",
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
  const port = {
    modelConfig: resolveAssemblyMember(input.modelConfig, "modelConfig"),
    provider: resolveAssemblyMember(input.provider, "provider"),
    tools: resolveAssemblyMember(input.tools, "tools"),
    store: resolveAssemblyMember(input.store, "store"),
    session: resolveAssemblyMember(input.session, "session"),
    policy: resolveAssemblyMember(input.policy, "policy"),
    ...(input.emit === undefined ? {} : { emit: input.emit }),
  };
  const missing = missingAssemblyMethods(port);
  if (missing.length > 0) {
    throw new TypeError(`assembly port is missing methods: ${missing.join(", ")}`);
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
  if (port.session.initialMessages !== undefined && !Array.isArray(port.session.initialMessages)) {
    throw new TypeError("assembly port session.initialMessages must be an array");
  }
  for (const key of Object.keys(port.policy ?? {})) {
    if (!ASSEMBLY_POLICY_OPTION_NAMES.has(key)) {
      throw new TypeError(`unknown assembly policy option: ${JSON.stringify(key)}`);
    }
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
