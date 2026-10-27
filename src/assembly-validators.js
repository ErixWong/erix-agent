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
  "channel",
  "task",
  "summaryRole",
  "onBeforeFold",
  "onAfterFold",
  "onFoldSummary",
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
