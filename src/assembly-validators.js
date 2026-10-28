/**
 * Shared boundary validators for the assembly port and the fine-grained
 * loop options. Both entry shapes (createAssemblyPort/assemblyPortOptions
 * and runToolLoop with fine-grained options) must report the same missing
 * capability descriptions, so the checks live here as the single source.
 *
 * Internal module: zero runtime dependencies, pure ESM, not re-exported
 * from the public entry point (src/index.js).
 */

export const MODEL_CONFIG_RESOLVER_HINT =
  "modelConfig must expose resolve(slot); wrap plain config with createModelConfigResolver(...)";

/**
 * issue #469：四个折叠摘要上限的键名（装配期校验 + 装配期透传的**同一份**真相）。
 *
 * @type {string[]}
 */
export const FOLD_SUMMARIZER_CAP_NAMES = [
  "summarizerTimeoutMs",
  "summarizerBudgetMs",
  "maxSummarizerInputBytes",
  "maxPriorSummaryBytes",
  // issue #493（下游 fde-station 反馈）：它偏偏是唯一没开的那个 —— 直连路径静默无效、
  // 装配口反倒报错，于是「摘要该写多长」在两条入口上各有各的答案。
  "maxSummaryTokens",
];

/**
 * The required TranscriptStore surface (issue #78): only the transcript
 * append/load pair is mandatory. Everything else — run snapshots and
 * run-state — is an optional capability; a store without those methods
 * still runs, it just cannot resume a crashed run mid-flight.
 */
export const TRANSCRIPT_STORE_METHODS = [
  "appendRound",
  "load",
];

/**
 * Optional run-snapshot capability (issue #78). Semantics are latest-only
 * overwrite — a run snapshot is an autosave of the in-flight run used only
 * for crash resume, not a multi-version checkpoint. `appendCheckpoint` was
 * merged into `saveRunSnapshot` because both were identical overwrite
 * writes. Reference for diagnostics/documentation; NOT enforced by
 * validateTranscriptStore.
 */
export const RUN_SNAPSHOT_STORE_METHODS = [
  "saveRunSnapshot",
  "loadLatestRunSnapshot",
];

/**
 * Optional run-state capability (issue #78). Reference for
 * diagnostics/documentation; NOT enforced by validateTranscriptStore.
 * `loadRunStateStatus` is a separate host-facing reader and is intentionally
 * not part of the engine capability lists.
 */
export const RUN_STATE_STORE_METHODS = [
  "saveRunState",
  "loadRunState",
  "markRunState",
];

/**
 * Full optional surface: run snapshots + run-state. Convenience aggregate
 * of RUN_SNAPSHOT_STORE_METHODS and RUN_STATE_STORE_METHODS.
 */
export const OPTIONAL_TRANSCRIPT_STORE_METHODS = [
  ...RUN_SNAPSHOT_STORE_METHODS,
  ...RUN_STATE_STORE_METHODS,
];

/**
 * Provider capability check: a provider satisfies the boundary when it
 * exposes at least one of chat / chatStream.
 *
 * @param {object} provider
 * @returns {string[]} missing capability descriptions (empty when satisfied)
 */
export function validateProviderBoundary(provider) {
  if (!provider
    || (typeof provider.chat !== "function"
      && typeof provider.chatStream !== "function")) {
    return ["provider.chat or provider.chatStream"];
  }
  return [];
}

/**
 * ModelConfig resolver check. A plain config object is not accepted at the
 * boundary; the message carries the resolver hint.
 *
 * @param {object} modelConfig
 * @returns {string[]} missing capability descriptions (empty when satisfied)
 */
export function validateModelConfigResolver(modelConfig) {
  if (!modelConfig || typeof modelConfig.resolve !== "function") {
    return [`modelConfig.resolve (${MODEL_CONFIG_RESOLVER_HINT})`];
  }
  return [];
}

/**
 * TranscriptStore required-method check (issue #78): only `appendRound` and
 * `load` are required; missing optional capabilities (run snapshot /
 * run-state) are reported by the engine as a one-time diagnostic and the
 * corresponding persistence is skipped. Returns one `store.<method>` entry
 * per missing required method. Callers own the surrounding semantics
 * (optional vs required store, error prefix).
 *
 * @param {object} store
 * @returns {string[]} missing method descriptions (empty when required methods present)
 */
export function validateTranscriptStore(store) {
  return TRANSCRIPT_STORE_METHODS
    .filter((method) => typeof store?.[method] !== "function")
    .map((method) => `store.${method}`);
}

/**
 * Aggregated loop-startup capability check for runToolLoop. Preserves the
 * historical check order so the produced message stays byte-compatible:
 * provider boundary, executeTool, then modelConfig/session for the
 * fine-grained port shape (or an explicit modelConfig override on an
 * assembly port).
 *
 * @param {object} input
 * @param {object} input.provider
 * @param {Function} input.executeTool
 * @param {object} [input.modelConfig]
 * @param {object} [input.session]
 * @param {boolean} [input.fineGrainedPortShape]
 * @param {boolean} [input.hasExplicitModelConfigOverride]
 * @returns {string[]} missing capability descriptions (empty when satisfied)
 */
export function collectLoopCapabilitiesMissing({
  provider,
  executeTool,
  modelConfig,
  session,
  fineGrainedPortShape = false,
  hasExplicitModelConfigOverride = false,
}) {
  const missing = [
    ...validateProviderBoundary(provider),
  ];
  if (typeof executeTool !== "function") missing.push("executeTool");
  if (fineGrainedPortShape) {
    missing.push(...validateModelConfigResolver(modelConfig));
    if (session !== undefined && (!session || typeof session !== "object"
      || Array.isArray(session)
      || typeof session.id !== "string" || session.id.length === 0)) {
      missing.push("session.id");
    }
  } else if (hasExplicitModelConfigOverride) {
    missing.push(...validateModelConfigResolver(modelConfig));
  }
  return missing;
}

/**
 * issue #469（宿主 2026-10-26 审计 + 裁决 B1）：四个折叠摘要上限的**装配期校验**。
 *
 * 为什么要在装配期校：这四个键以前只在工厂选项上生效，写进 `context` 里是
 * **静默无效**（`strategy-resolution.js` 只透传 `recoveryHint` / `stubFor`）——
 * 与 `#331` 那根「没人读的旋钮」同形状。现在它们真的被读，写错（`0` / 负数 / 小数 /
 * 字符串 / `null`）一律在这里 `TypeError`，不等到真发生折叠那一轮才发现。
 *
 * 名字有两层语义，**刻意不下沉成一个键**：
 *   · `summarizerTimeoutMs` —— provider 层**单发**超时（`createProviderSummarizer`）；
 *   · `summarizerBudgetMs` —— 策略层**整条步骤死线**（`fold-llm`：首发 + 超窗自愈共用）。
 *
 * @param {unknown} context
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function validateFoldSummarizerCaps(context) {
  if (context === undefined || context === null || typeof context !== "object") return [];
  const problems = [];
  for (const key of FOLD_SUMMARIZER_CAP_NAMES) {
    const raw = /** @type {Record<string, unknown>} */ (context)[key];
    // 只有省略才退回默认；`null` / `0` / 字符串都是「给了但给错」。
    if (raw === undefined) continue;
    // 先窄化成 number 再比大小：`unknown <= 0` 在 `--checkJs` 下是 TS2365（棘轮只减不增）。
    const value = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isSafeInteger(value) || value <= 0) {
      problems.push(`${key} must be a positive integer`);
    }
  }
  return problems;
}

/**
 * `context` 上被引擎**真的读过**的子键全集（装配期未知键检查用）。
 *
 * 口径：宁可多放（多列一个不存在的键只少报一次错），不可少列——少列一个就是把
 * 宿主合法配置打成 `TypeError`。来源：`orchestrator.js` 对 `compactionContext.*` /
 * `context.*` 的全部读取点 + `compactOptions` 透传名单 + 四个新旋钮。
 *
 * **退役（issue #499）**：`onFoldSummary` 曾在这份名单里，但引擎**从不从 `context` 读它**
 * （真实投递点是顶层 `onFoldSummary` / 装配口 `policy.onFoldSummary`）⇒ 它在名单里只买到
 * 「配了、不生效、连 `context_unknown_option` 事件都没有」的三重静默，比未知键更糟。
 * 现在按处置 2 退役：从名单移除 ⇒ 它落**宿主元数据**分支（装配口报一条事件、直连静默放行、
 * 都不抛——抛是破坏，它与已知旋钮名的编辑距离 > 2，不属于 #493 的旋钮家族）。
 * 红线：退役只动 `context.` 侧；顶层 `onFoldSummary` 仍是活选项（`RUN_TOOL_LOOP_OPTION_NAMES`
 * 里那一个不许动，它有自己的投递路径与次数断言）。
 *
 * **退役（issue #510 / #498 S4b）**：`channel` 曾在这份名单里，而引擎**从不从 `context` 读它**
 * （`orchestrator.js` 里那个 `context?.channel` 是**观察者错账户**的第二参，与 `context` 选项
 * 无关；`persistence_error` 事件上的 `channel` 是引擎自己算的，也不是读这个键）⇒ 它就是
 * 「配了、不生效、连事件都没有」的静默键，比未知键更糟。与 `onFoldSummary` 同一处置：从名单移除
 * ⇒ 落**宿主元数据**分支（装配口报一条 `context_unknown_option`、直连静默放行、都不抛）。
 *
 * @type {string[]}
 */
export const CONTEXT_OPTION_NAMES = [
  "budgetTokens",
  "strategy",
  "keepRounds",
  "protectedMessage",
  "stripHistoricalImages",
  "stubFor",
  "recoveryHint",
  "task",
  "summaryRole",
  "onBeforeFold",
  "onAfterFold",
  // `onFoldSummary` 不在这里：issue #499 退役（见函数头注释）。它只是**看起来**该在这里——
  // 引擎从不从 `context` 读这个键，留在白名单里等于给它发一张「合法」的假证明。
  "maxFoldedPayloadBytes",
  "maxFoldedFactsBytes",
  // issue #493（下游 fde-station 反馈）：这五个键引擎自己在 `budget.js` 里读
  // （`context.toolContext` / `.expert` / `.user` / `.session` / `.requestId`），
  // 而契约第 21-22 行明说「宿主私有元数据放 `toolContext` 或 `context`」——
  // 漏列它们就是「把宿主合法配置打成 TypeError」，白名单少列一个都算事故。
  "toolContext",
  "expert",
  "user",
  "session",
  "requestId",
  // issue #469：四个新旋钮（两层语义见 `validateFoldSummarizerCaps`）。
  "summarizerTimeoutMs",
  "summarizerBudgetMs",
  "maxSummarizerInputBytes",
  "maxPriorSummaryBytes",
  // issue #493 复核：`maxSummaryTokens` 只加进了 `FOLD_SUMMARIZER_CAP_NAMES`、漏在白名单里
  // ⇒ 宿主给对了值仍然被判「未知 context 子键」抛 TypeError，等于把「静默无效」翻成「装配口报错」，
  // 分裂没变。现在两条名单都收，并有 `contextOptionNameSelfCheck()` 交叉核对兜住下一个漏项。
  "maxSummaryTokens",
];

const CONTEXT_OPTION_NAME_SET = new Set(CONTEXT_OPTION_NAMES);

/**
 * issue #493 复核：**每个旋钮都必须同时在 `context` 白名单里**（单条顶五条）。
 *
 * 只往 `FOLD_SUMMARIZER_CAP_NAMES` 加、忘了往 `CONTEXT_OPTION_NAMES` 加，就会出现
 * 「装配期校验认这个键、白名单不认」⇒ 宿主给对了值反而被抛 `TypeError`（#493 现场）。
 * 两个名单本来就是这个模块里的两份手抄，靠人记必漏 ⇒ 用这条自检把漏项钉在测试里。
 *
 * @returns {string[]} 缺在白名单里的旋钮名（空 = 通过）
 */
export function contextOptionNameSelfCheck() {
  return FOLD_SUMMARIZER_CAP_NAMES.filter((name) => !CONTEXT_OPTION_NAME_SET.has(name));
}

/**
 * `context` 的未知子键检查（issue #469，宿主要求「未知键报错」）。
 *
 * 以前写错的键名会被**静默丢弃**——宿主以为配上了，实际用的是默认值（`#331` 的病）。
 * 只做装配期（`createAssemblyPort`）；直接入口 `runToolLoop(options)` 不受影响。
 *
 * @param {unknown} context
 * @returns {string[]}
 */
const KNOB_FAMILY_PATTERN = /summar|PriorSummary/iu;
/** 编辑距离（Levenshtein，带长度剪枝）：判「这个键是不是某个已知旋钮名的手滑」。 */
function editDistanceWithin(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return false;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return false;
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length] <= limit;
}


/**
 * 这个 `context` 子键是否属于「折叠摘要旋钮家族」（#493）。
 *
 * 强校验只对家族生效：写错一个旋钮名（`maxPriorSummaryByte`、`summarizeBudgetMs`）是**明确的事故**，
 * 而宿主往 `context` 里放业务元数据是**契约允许的**（第 21-22 行）。
 * @param {string} key
 * @returns {boolean}
 */
export function isSummarizerKnobKey(key) {
  const needle = String(key ?? "").toLowerCase();
  if (needle === "") return false;
  // 只认「某个已知旋钮名的手滑」（距离 ≤ 2），不在字面上立规矩：`summaryStyle`、
  // `summarizerNote` 这类业务键与任何旋钮名都差得远 ⇒ 不算旋钮（上游现场实测过）。
  return FOLD_SUMMARIZER_CAP_NAMES.some((name) => editDistanceWithin(needle, name.toLowerCase(), 2));
}

/** 未知的 `context` 子键全集（**不**分家族，供 diagnostics 用）。 */
export function collectUnknownContextOptions(context) {
  if (context === undefined || context === null || typeof context !== "object") return [];
  return Object.keys(/** @type {object} */ (context))
    .filter((key) => !CONTEXT_OPTION_NAME_SET.has(key));
}

export function validateContextOptionNames(context) {
  if (context === undefined || context === null || typeof context !== "object") return [];
  const problems = [];
  for (const key of Object.keys(/** @type {object} */ (context))) {
    // 只有「旋钮家族的拼错」才抛（#493）：其余未知键是宿主业务字段，见
    // `collectUnknownContextOptions` 的 diagnostics 口径。
    if (!CONTEXT_OPTION_NAME_SET.has(key) && isSummarizerKnobKey(key)) {
      problems.push(`unknown assembly policy context option: ${JSON.stringify(key)}`);
    }
  }
  return problems;
}

/**
 * issue #470-D：折叠替代物投递钩子 `onFoldSummary` 的形状校验（返回问题列表，空 = 通过）。
 *
 * 口径：`undefined` = 不订阅（逐字等于今天的行为，纯加法）；给了就必须是函数。
 * 只校到这一层——payload 的**形状由引擎写侧唯一产出点 `buildFoldedFacts()` 决定**，
 * 钩子只能读，不能反过来影响投递内容。
 *
 * @param {unknown} hook
 * @returns {string[]}
 */
export function validateFoldSummaryHook(hook) {
  // `undefined` = 未订阅（纯加法，逐字等于今天的行为）；`null` 属于「给了但给错」⇒ 与其余端口
  // （`NotesStore clock must be a function` 等）同口径：只有省略才放行，非函数一律报错。
  if (hook === undefined) return [];
  if (typeof hook !== "function") {
    return ["assembly policy option onFoldSummary must be a function (or omitted)"];
  }
  return [];
}

/**
 * 语义相里承载**宿主回调**的字段（issue #496 / #495 v2）：它们是行为，不是数据。
 *
 * 只列「给了就必须是函数」的那一类；`deliverables[].check` 不在表里——它的形状由
 * `normalizeDeliverables`（`src/loop/deliverables.js`）在 orchestrator 侧校，两条路线都汇到那里，
 * 再抄一份只会多出第二套文案（见 `test/loop-option-gate-496.test.js` 的可达性断言）。
 *
 * #520 removed the `retry.sleepImpl` entry this table used to carry. Its only reader was the
 * `retryOptions?.sleepImpl` term in the orchestrator, and no producer could reach that term (a
 * function inside `config.timing.retry` is refused by the "config holds data only" rule before the
 * loop starts), so the entry was a shape rule for a key nothing reads — which is exactly the
 * "validating it implies it is alive" trap the `context.onFoldSummary` note below warns about.
 * The retry timer's one home is `capabilities.ports.sleepImpl` (shape-checked on the capability
 * surface, `src/loop/capabilities-namespace.js`); writing a function into
 * `config.timing.retry.sleepImpl` is still refused at intake, and that message names the home.
 *
 * @type {Array<[string[], string]>}
 */
const CALLBACK_OPTION_PATHS = [
  [["finalGuard"], "finalGuard"],
  [["reflection", "onReflection"], "reflection.onReflection"],
  [["diagnostics", "error"], "diagnostics.error"],
];

/**
 * issue #496（S1）：**语义相**的规则表——合并出 `effectiveOptions` 之后才跑的取值 / 回调形状规则。
 *
 * 为什么要有这一相：校验以前绑在**入口路线**上。`context` 子键只有 `createAssemblyPort` 校
 * （`validateContextOptionNames` 在 `src/assembly.js` 里被调），直连 `runToolLoop` 一个都不校，
 * 于是同一份配置走装配口抛 `TypeError`、走直连**静默按默认跑**（`context.summarizeBudgetMs`
 * 实测能跑完 `end_turn`）。校验绑在路线上而不是绑在**规范化表示**上，这是病根。
 *
 * 现在条件与文案都只在这里写一份，两条路线都调它：
 *   · 装配口（`createAssemblyPort`）在构造期校 `policy`，`via:"assembly"`；
 *   · 直连在 `normalizeRunToolLoopOptions` 合并出 `effectiveOptions` **之后**校，`via:"direct"`。
 *
 * 两相分工（刻意不重叠，见 #496 的更正评论②）：
 *   · **预检相**（`assertRunToolLoopOptionNames`，在 `src/loop/option-normalization.js`）只管
 *     **顶层名称 / 对象形状**，必须在任何宿主端口被读取之前抛——那条次序承诺被
 *     `test/loop-option-normalization.test.js` 的「次序①」用 `Proxy` 钉住；
 *   · **语义相**（本函数）只管**取值与回调形状**，输入是合并后的表示，不碰任何端口；
 *   · 两条路线都会汇到 `orchestrator` 的取值校验（`maxRounds` / `deliverables` /
 *     `partialPersistence` / `persistence` …）**留在原地不动**：搬进来只增加次序风险，
 *     不增加覆盖（它们本来就不是路线相关的）。
 *
 * @param {unknown} options 合并后的选项表示（`effectiveOptions`），或装配口的 `policy`
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function collectSemanticOptionProblems(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) return [];
  const bag = /** @type {Record<string, any>} */ (options);
  const problems = [];
  // `undefined` = 没配 `context`；`null` 逐字等于「没配」（引擎今天对两者的读取结果相同），
  // 所以只把**非 null 的非对象**当配置错误——那一类今天同样是静默按默认跑（`#331` 的形状）。
  const context = bag.context;
  if (context !== undefined && context !== null) {
    if (typeof context !== "object" || Array.isArray(context)) {
      problems.push("context must be an object");
    } else {
      problems.push(...validateContextOptionNames(context));
      problems.push(...validateFoldSummarizerCaps(context));
      problems.push(...validateContextCallbackShapes(context));
    }
  }
  problems.push(...validateFoldSummaryHook(bag.onFoldSummary));
  // #498 S4b review fix: `session` is data only, so `session.resume` is rejected on **both** entry
  // routes. The assembly port throws in `createAssemblyPort`; without this line the direct route
  // (`normalizeRunToolLoopOptions`) silently dropped the key and ran without resuming — the exact
  // "configured but inert" shape this ticket exists to kill. `config.metadata.session` expands to
  // this same top-level `session`, so the check covers that spelling too.
  if (readOptionPath(bag, ["session", "resume"]) !== undefined) {
    problems.push(
      "session.resume is not accepted: session is data only"
      + " (pass it as config.run.resume; the flat top-level spelling was retired in 0.28)",
    );
  }
  // #498 S4c: `reflection.judge.evaluator` was a pure alias of `reflection.judge.provider`
  // (`judge?.provider ?? judge?.evaluator ?? provider` — the same slot written twice). 0.28 retires
  // it instead of moving it: it throws and names the canonical port. Accepting it silently is the
  // "configured but inert" shape this ticket exists to kill, and the two routes must agree, so the
  // rule lives here (the assembly port calls this same function for its `policy`).
  if (readOptionPath(bag, ["reflection", "judge", "evaluator"]) !== undefined) {
    problems.push(
      "reflection.judge.evaluator is not accepted: it was an alias of reflection.judge.provider"
      + " (pass reflection.judge.provider, or the canonical capabilities.ports.judgeProvider)",
    );
  }
  for (const [path, label] of CALLBACK_OPTION_PATHS) {
    const value = readOptionPath(bag, path);
    // `undefined` = 未订阅（逐字等于今天的行为）；给了就必须是函数。
    if (value !== undefined && typeof value !== "function") {
      problems.push(`${label} must be a function (or omitted)`);
    }
  }
  return problems;
}

/**
 * `context` 上承载回调的两个子键：给了就必须是函数，否则今天会被 `runFoldHook` 的
 * `typeof hook === "function"` 静默跳过——又一根「配了等于没配」的旋钮。
 *
 * 刻意**不含** `context.onFoldSummary`：引擎从不从 `context` 读这个键（真实位置是顶层
 * `onFoldSummary` / 装配口 `policy.onFoldSummary`），给一个没有读取点的键校形状只会反过来暗示它有用。
 * issue #499 起它已从 `CONTEXT_OPTION_NAMES` 退役 ⇒ 落「宿主元数据」分支（装配口报一条
 * `context_unknown_option`、直连静默放行），所以这里更不该有它：一个**被放行的元数据键**
 * 若同时又校形状，就等于用报错把「退役」说成「还活着」。
 *
 * @param {Record<string, any>} context
 * @returns {string[]}
 */
function validateContextCallbackShapes(context) {
  const problems = [];
  for (const key of ["onBeforeFold", "onAfterFold"]) {
    const value = context[key];
    if (value !== undefined && typeof value !== "function") {
      problems.push(`context.${key} must be a function (or omitted)`);
    }
  }
  return problems;
}

/**
 * 沿路径读一个选项（`["reflection", "onReflection"]`）：中途任何一层不是非数组对象就当作未提供。
 *
 * 容器本身的形状（`retry: false` / `reflection: false` 是合法值）归 orchestrator 管，这里只取叶子。
 *
 * @param {Record<string, any>} options
 * @param {string[]} path
 * @returns {unknown}
 */
function readOptionPath(options, path) {
  let current = /** @type {any} */ (options);
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * 校验错误上的**路线标签**（issue #496 裁决④）：只有两个取值，别的地方不许往错误上贴属性。
 *
 * @typedef {{via?: "assembly"|"direct"}} RouteTag
 */

/**
 * 给校验错误贴**路线标签**（issue #496 裁决④）。
 *
 * 只加一个自有属性，**不动消息、不动原型链**：装配口今天那句
 * `unknown assembly policy context option: "…"` 逐字保留，直连侧从此抛**同一句**，
 * 于是宿主按字符串匹配的既有代码不会因为「路线不同」而失效；哪条路线由 `via` 区分。
 *
 * @template {Error} T
 * @param {T} error
 * @param {"assembly"|"direct"|undefined} via
 * @returns {T}
 */
export function tagValidationRoute(error, via) {
  if (error !== null && typeof error === "object" && (via === "assembly" || via === "direct")) {
    // 用 `Object.assign` 而不是 `/** @type {any} */ (error).via = via`：贴标签这一步不该打开
    // 「任何地方都能往任意对象上贴属性」的口子，`RouteTag` 是这条属性的唯一类型来源。
    return /** @type {T & RouteTag} */ (Object.assign(error, { via }));
  }
  return error;
}

/**
 * 语义相的抛错包装：两条路线共用同一份规则与同一条消息，只差 `via` 标签。
 *
 * @param {unknown} options
 * @param {RouteTag} [route]
 * @returns {void}
 */
export function assertSemanticOptionValues(options, route = {}) {
  const problems = collectSemanticOptionProblems(options);
  if (problems.length === 0) return;
  throw tagValidationRoute(new TypeError(problems.join("; ")), route.via);
}
