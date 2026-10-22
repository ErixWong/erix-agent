// erix_run 的终稿核验（finalGuard）谓词层（issue #314）。
//
// 一句话职责：把「终稿有没有交代取证边界 / 基点 / 结论 / 未验证」以及「声明的基点
// 到底是不是本次 run 的工具返回里真出现过的值」变成引擎 `finalGuard` 回调能用的
// accept / revise 决策（引擎契约见 src/loop/termination.js 的 `callFinalGuard`
// 与 docs/host-consumer-contract.md「Final guard」）。
//
// 分层纪律（工单 R2，别自己加硬闸）：
//   ① 格式/存在性 → 提示词与这里**双写**，缺段就点名缺哪段；
//   ② **基点溯源 = 唯一的硬闸**：只在本次 `messages` 的 `tool_result` 文本里找声明值，
//      找不到 ⇒ revise；任何分支都不许 accept（fail closed）；重试用尽由引擎兜成 unverified；
//   ③ 比值/总量（`1:N`、百分比、「总计」）→ **只提醒**，不硬拒（同口径判定要先有观测基线）；
//   ④ 「至少一条非文件系统探针」不做（一条 `date` 就能糊弄）。
//
// 零依赖红线：只用 node: 内置；纯 ESM；不联网、不读盘。

/** 终稿必须依次出现的四段（顺序即契约；提示词槽位与本常量同源，见 `FINAL_DRAFT_PROMPT`）。 */
export const FINAL_DRAFT_SECTIONS = Object.freeze([
  "## 取证边界",
  "## 基点",
  "## 结论",
  "## 未验证",
]);

/**
 * 开启时**显式**下发给引擎的 guard 等待上限（引擎默认 30_000，见 `src/loop/orchestrator.js`
 * 的 `finalGuardTimeoutMs = 30_000`）。为什么不靠默认：引擎只在**轮边界**检查截止时间
 * （`orchestrator.js` 的 `remainingMs()` 只在轮开头用一次），stop 判定 → guard 之间没有
 * deadline 检查；而宿主扩展自己挂了一根 `setTimeout` 硬 abort 在 `params.timeoutMs` 上
 * （`erix-run-core.js` 的 `runErixRun`）。3 × 30s 的 guard 等待 + ≤2 轮 revise 会被
 * **宿主自己**掐死：钱花了、`verified` 拿不到。所以这里给一个明确的小值。
 */
export const FINAL_GUARD_TIMEOUT_MS = 10_000;

/** 引擎侧 `finalGuardMaxRetries` 的默认值（本层**不下发**，只照抄用于算最坏开销）。 */
export const ENGINE_FINAL_GUARD_MAX_RETRIES = 2;

/** guard 最多被叫几次（1 次原判 + `finalGuardMaxRetries` 次 revise）。 */
const FINAL_GUARD_MAX_CALLS = 1 + ENGINE_FINAL_GUARD_MAX_RETRIES;

/**
 * 交付物判据的单条等待上限（issue #391 R5）：**与 guard 同一个旋钮**——引擎的
 * `runDeliverables` 直接读 `finalGuardTimeoutMs` 当判据超时（`src/loop/deliverables.js`
 * 的 `runOne`，逐条计时），不新增配置项。所以「判据跑在 guard 之前，两者共享同一时间预算」
 * 不是取舍，而是引擎的现状：一次 attempt 的最坏等待 = `判据条数 × 上限 + guard 上限`。
 */
export const DELIVERABLE_CHECK_TIMEOUT_MS = FINAL_GUARD_TIMEOUT_MS;

/**
 * 开启 finalGuard 的**最坏额外开销**：guard 最多被叫 `1 + maxRetries` 次（每次上限
 * `finalGuardTimeoutMs`），外加 ≤2 轮 revise 的模型往返。宿主据此把自己的硬 abort
 * 往后挪，否则就是坑 ①（见 `FINAL_GUARD_TIMEOUT_MS` 的注释）。
 *
 * issue #391 R5：声明了交付物判据时，**每次 attempt 还要先跑一遍判据**（引擎在每次 guard 调用
 * 之前核，`src/loop/termination.js` 的闸门那一段），而判据的超时预算与 guard 共用同一个
 * `finalGuardTimeoutMs` ⇒ 每条判据让每次 attempt 的上限再加一个 `finalGuardTimeoutMs`。
 * 按「1 条默认判据」算就是 3 × (10s + 10s) = **60s**（不声明判据时仍是 30s，常量未变）。
 */
export function finalGuardWorstCaseMs({ deliverableCriteria = 0 } = {}) {
  const perAttempt = FINAL_GUARD_TIMEOUT_MS * (1 + Math.max(0, deliverableCriteria));
  return FINAL_GUARD_MAX_CALLS * perAttempt;
}

/** 未声明交付物判据时的最坏额外开销（既有常量，语义与数值都未变）。 */
export const FINAL_GUARD_WORST_CASE_MS = finalGuardWorstCaseMs();

/** 每段要模型写什么（提示词里的槽位说明；段名才是 guard 的判定对象）。 */
const SECTION_HINTS = {
  "## 取证边界": "本次实际取证的来源与范围（跑了哪些命令/读了哪些文件），以及明确没看的东西",
  "## 基点": "结论所依据的基点，逐字照抄工具返回里出现过的字面值（commit SHA / tag / 版本号），一行一个",
  "## 结论": "每条结论后面附「文件:行」定位；没有定位的结论不要写",
  "## 未验证": "看过但没能证实的点；确实没有就写「无」",
};

/** 写进系统提示词的终稿槽位（与 `FINAL_DRAFT_SECTIONS` 同源；guard 只查段名是否存在）。 */
export const FINAL_DRAFT_PROMPT = `\n\n终稿必须依次包含这四段（段名逐字照抄，缺任一段会被打回重写）：
${FINAL_DRAFT_SECTIONS.map((section, index) => `${index + 1}. ${section}：${SECTION_HINTS[section]}`).join("\n")}`;

/** 「基点」段里的字面值候选：git SHA / 版本号 / 反引号或裸写的 token。 */
const BASE_LITERAL_PATTERNS = [
  // 反引号包裹的值优先（`9c2a41b` / `v0.21.0`）
  /`([^`\n]{3,80})`/gu,
  // 裸写的 7–40 位十六进制（commit SHA）
  /\b[0-9a-f]{7,40}\b/gu,
  // 裸写的版本号（0.21.0 / v1.2.3-rc1）
  /\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?\b/gu,
];

/** 派生结论的提醒模式（③ 只提醒，不硬拒）。 */
const RATIO_PATTERNS = [
  { kind: "ratio", re: /\b\d+(?:\.\d+)?\s*[:：]\s*\d+\b/gu },
  { kind: "percent", re: /\b\d+(?:\.\d+)?\s*%/gu },
  { kind: "total", re: /总计|总量|总数|合计|汇总/gu },
];

/**
 * 按段切终稿：返回每段的正文与缺失清单。段名匹配行首（允许多余空白与 `#` 层级差异不做，
 * 段名就是逐字契约——这是 ① 「格式/存在性双写」的另一半）。
 */
export function splitFinalDraft(finalText) {
  const text = typeof finalText === "string" ? finalText : "";
  const found = {};
  const missing = [];
  FINAL_DRAFT_SECTIONS.forEach((section, index) => {
    const next = FINAL_DRAFT_SECTIONS[index + 1];
    const start = text.indexOf(section);
    if (start < 0) {
      missing.push(section);
      return;
    }
    const body = next === undefined
      ? text.slice(start + section.length)
      : text.slice(start + section.length, indexOfOrEnd(text, next, start + section.length));
    found[section] = body;
  });
  return { found, missing };
}

function indexOfOrEnd(text, needle, from) {
  const at = text.indexOf(needle, from);
  return at < 0 ? text.length : at;
}

/**
 * 从「## 基点」段正文里抠出声明的基点字面值。
 * 返回 `[{ literal, source }]`；顺序稳定、去重，便于 revise 文案点名。
 */
export function extractDeclaredBases(baseSectionBody) {
  const text = typeof baseSectionBody === "string" ? baseSectionBody : "";
  const seen = new Set();
  const literals = [];
  for (const line of text.split(/\r?\n/u)) {
    const stripped = line.replace(/^\s*[-*+]?\s*/, "").trim();
    if (stripped === "" || /^(无|none|n\/a|不适用)[。.\s]*$/iu.test(stripped)) continue;
    const candidates = [];
    for (const pattern of BASE_LITERAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(stripped)) !== null) {
        const raw = match[1] ?? match[0];
        const literal = raw.trim();
        if (literal.length >= 3) candidates.push(literal);
      }
    }
    if (candidates.length === 0 && stripped.length >= 3) {
      // 「基点：main 分支」这类没有可抠 token 的散文行：整行当字面值，找不到就打回
      //（fail closed：宁可多要一次改写，也不放过硬闸）。
      candidates.push(stripped.replace(/[。；;]\s*$/u, ""));
    }
    for (const literal of candidates) {
      if (seen.has(literal)) continue;
      seen.add(literal);
      literals.push({ literal, source: stripped });
    }
  }
  return literals;
}

/**
 * 本次 run 的**取证文本池**：`messages` 里全部 `tool_result` 块的文本。
 * 引擎给的 payload 带全量 messages（`src/loop/termination.js` 的 `cloneState(ctx.messages)`），
 * 这是「基点必须来自本次工具返回」能成立的前提。
 */
export function collectToolResultText(messages) {
  const chunks = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const inner = block.content;
      if (typeof inner === "string") {
        chunks.push(inner);
      } else if (Array.isArray(inner)) {
        for (const part of inner) {
          if (typeof part === "string") chunks.push(part);
          else if (typeof part?.text === "string") chunks.push(part.text);
        }
      }
    }
  }
  return chunks.join("\n");
}

/** 基点声明是否**逐字**出现在本次工具返回里（十六进制值忽略大小写，其余逐字）。 */
export function isBaseTraceable(literal, toolResultText) {
  const haystack = toolResultText ?? "";
  if (haystack.includes(literal)) return true;
  if (/^[0-9a-f]{7,40}$/iu.test(literal)) {
    return haystack.toLowerCase().includes(literal.toLowerCase());
  }
  return false;
}

/** 派生结论（比值 / 百分比 / 「总计」）样本：只用于提醒，永远不参与 accept/revise 判定。 */
export function findDerivedConclusionFlags(finalText) {
  const text = typeof finalText === "string" ? finalText : "";
  const flags = [];
  for (const { kind, re } of RATIO_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const lineEnd = indexOfOrEnd(text, "\n", match.index);
      flags.push({ kind, sample: text.slice(lineStart, lineEnd).trim().slice(0, 120) });
      if (flags.length >= 10) return flags;
    }
  }
  return flags;
}

/**
 * 纯谓词：终稿 + 本次消息 → guard 决策与可观测字段（不做计数，计数在
 * `createFinalGuardVerify`）。
 *
 * @param {{finalText?:unknown, messages?:unknown[]}} payload
 * @returns {{action:"accept"|"revise", message?:string, missingSections:string[],
 *   declaredBases:string[], untraceableBases:string[], ratioFlags:object[]}}
 */
export function inspectFinalDraft({ finalText, messages } = {}) {
  const { found, missing } = splitFinalDraft(finalText);
  const ratioFlags = findDerivedConclusionFlags(finalText);
  const declared = missing.includes("## 基点")
    ? []
    : extractDeclaredBases(found["## 基点"]);
  const declaredBases = declared.map((entry) => entry.literal);
  const base = {
    missingSections: missing,
    declaredBases,
    untraceableBases: [],
    ratioFlags,
  };

  // ① 格式/存在性：缺段先打回，文案点名缺哪段（C1）。
  if (missing.length > 0) {
    return {
      ...base,
      action: "revise",
      message: `终稿缺少必需的段落：${missing.join("、")}。请按顺序补齐这四段（段名逐字照抄）：`
        + `${FINAL_DRAFT_SECTIONS.join("、")}。`,
    };
  }

  // ② 基点溯源 = 唯一硬闸（C2）。
  if (declaredBases.length === 0) {
    return {
      ...base,
      action: "revise",
      message: "终稿的「## 基点」段没有给出任何可核验的基点字面值。"
        + "请逐字照抄本次工具返回里出现过的值（commit SHA / tag / 版本号），一行一个。",
    };
  }
  const toolResultText = collectToolResultText(messages);
  const untraceable = declaredBases.filter((literal) => !isBaseTraceable(literal, toolResultText));
  if (untraceable.length > 0) {
    return {
      ...base,
      untraceableBases: untraceable,
      action: "revise",
      message: `「## 基点」声明的 ${untraceable.join("、")} 在本次 run 的工具返回里**逐字找不到**`
        + `（基点必须来自本次取证，不许凭记忆写）。`
        + `请重跑取基点的命令（如 git rev-parse --short HEAD），并把返回里的字面值原样写进「## 基点」。`,
    };
  }

  // ③ 比值/总量只提醒：出现在 ratioFlags 里，不拦 accept（C4）。
  return { ...base, action: "accept" };
}

/** guard 计数器的初始形状（挂在 diagnostics.finalGuard 上，见 `summarizeFinalGuard`）。 */
export function createFinalGuardTally({
  finalGuardTimeoutMs = FINAL_GUARD_TIMEOUT_MS,
  deliverableCriteria = 0,
} = {}) {
  const timeoutMs = Number.isSafeInteger(finalGuardTimeoutMs) && finalGuardTimeoutMs > 0
    ? finalGuardTimeoutMs
    : FINAL_GUARD_TIMEOUT_MS;
  const criteria = Number.isSafeInteger(deliverableCriteria) && deliverableCriteria > 0
    ? deliverableCriteria
    : 0;
  return {
    enabled: true,
    calls: 0,
    elapsedMs: 0,
    reviseRounds: 0,
    accepted: 0,
    invalidDecisions: 0,
    ratioFlags: [],
    missingSections: [],
    declaredBases: [],
    untraceableBases: [],
    finalGuardTimeoutMs: timeoutMs,
    // #391 R5：判据条数（0 = 没声明 `requireDeliverable`）与据此算出的最坏额外开销。
    deliverableCriteria: criteria,
    worstCaseExtraMs: FINAL_GUARD_MAX_CALLS * timeoutMs * (1 + criteria),
    source: "host finalGuard wrapper (erix-run-final-guard.js)",
  };
}

/**
 * 把纯谓词包成引擎要的回调，并**在这里**记成本（次数、累计耗时、revise 轮数）。
 * 引擎侧另有 `guardMetrics`（`src/loop/orchestrator.js`），本层记的是**宿主视角**的成本，
 * 两者口径不同（引擎记决策次数，本层记墙钟耗时与被打回的轮数），所以各留一份、都写来源。
 *
 * @param {{inspect?:(payload:object)=>object, tally?:object, now?:()=>number, onObserve?:(summary:object)=>void}} deps
 * @returns {(payload:object)=>Promise<{action:string, message?:string, reason?:string}>}
 */
export function createFinalGuardVerify({
  inspect = inspectFinalDraft,
  tally = createFinalGuardTally(),
  now = Date.now,
  onObserve,
} = {}) {
  return async function finalGuardVerify(payload = {}) {
    tally.calls += 1;
    const startedAt = now();
    let decision;
    try {
      // 谓词**允许是异步的**（真 guard 要读盘 / 跑一次小模型调用），这里必须 await：
      // 不 await 就会把一个 Promise 当成决策交给引擎，引擎报「invalid decision」→ 白跑。
      const inspected = (await inspect(payload)) ?? { action: "revise", message: "guard 谓词没返回决策" };
      decision = { action: inspected.action, message: inspected.message, reason: inspected.reason };
      tally.reviseRounds += inspected.action === "revise" ? 1 : 0;
      tally.accepted += inspected.action === "accept" ? 1 : 0;
      tally.ratioFlags = inspected.ratioFlags ?? [];
      tally.missingSections = inspected.missingSections ?? [];
      tally.declaredBases = inspected.declaredBases ?? [];
      tally.untraceableBases = inspected.untraceableBases ?? [];
    } catch {
      // 谓词自己炸了也不要把 accept 当默认值送出去（fail closed）。
      tally.invalidDecisions += 1;
      decision = { action: "revise", message: "finalGuard 谓词抛错，请按四段格式重写终稿" };
    } finally {
      tally.elapsedMs += Math.max(0, now() - startedAt);
    }
    if (typeof onObserve === "function") {
      try {
        onObserve(summarizeFinalGuard(tally));
      } catch {
        // 观测面不许把 run 带死
      }
    }
    return decision;
  };
}

/**
 * 终局面上的一行文本（成本与结论都要看得见；「默认关 ⇒ 整行是 disabled」）。
 * @param {object|undefined|false} tally
 * @returns {string}
 */
export function summarizeFinalGuard(tally) {
  if (!tally || tally.enabled !== true) {
    return "finalGuard=disabled（默认关；开启才会核验终稿，最坏多 ≤2 个模型往返 + 3 × finalGuardTimeoutMs 等待）";
  }
  return `finalGuard calls=${tally.calls ?? 0} 累计等待=${tally.elapsedMs ?? 0}ms`
    + ` revise=${tally.reviseRounds ?? 0}/2（引擎 finalGuardMaxRetries 默认 2）`
    + ` 每次上限=${tally.finalGuardTimeoutMs ?? FINAL_GUARD_TIMEOUT_MS}ms`
    + `（最坏额外 ${tally.worstCaseExtraMs ?? FINAL_GUARD_WORST_CASE_MS}ms`
    // #391 R5：声明了交付物判据时把「判据也吃同一个时间预算」说出来（没声明 ⇒ 这一句不存在，
    // 整行与 #314 逐字一致）。
    + `${tally.deliverableCriteria > 0
      ? `；其中交付物判据 ${tally.deliverableCriteria} 条 × 每次 ${tally.finalGuardTimeoutMs ?? FINAL_GUARD_TIMEOUT_MS}ms，与 guard 共享同一预算`
      : ""}）`
    + ` ｜ 声明基点 ${tally.declaredBases?.length ?? 0} 条 / 逐字对不上 ${(tally.untraceableBases ?? []).length} 条`
    + ` ｜ 派生结论提醒 ${tally.ratioFlags?.length ?? 0} 条（只提醒不硬拒）`
    + ` ｜ 来源 ${tally.source ?? "unknown"}`;
}
