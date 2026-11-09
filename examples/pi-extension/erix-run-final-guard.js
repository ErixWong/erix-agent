// erix_run 的终稿核验（finalGuard）谓词层（issue #314）。
//
// 一句话职责：把「终稿有没有交代取证边界 / 基点 / 结论 / 未验证」以及「声明的基点
// 到底是不是本次 run 的工具返回里真出现过的值」变成引擎 `finalGuard` 回调能用的
// accept / revise 决策（引擎契约见 src/loop/termination.js 的 `callFinalGuard`
// 与 docs/host-consumer-contract.md「Final guard」）。
//
// 分层纪律（工单 R2，别自己加硬闸）：
//   ① 格式/存在性 → 提示词与这里**双写**，缺段就点名缺哪段；
//   ② **基点溯源 = 唯一的硬闸**：在本次 `messages` 的 `tool_result` 文本里找声明值，找不到再看
//      **本次 run 的账本**（issue #797：`payload.messages` 就是被上下文压缩改写的那一份，
//      只看存活窗口会把「取证在折叠前」的真基点误判成凭记忆写的）；两处都没有 ⇒ revise；
//      任何分支都不许 accept（fail closed）；重试用尽由引擎兜成 unverified（#797 之后：
//      账本读全且观察到压缩时，宿主把那一格的 `reason` 改写成 `not_in_ledger`，见
//      `honestVerificationReason`）；assistant 自己复述一遍不算取证——**只看 `tool_result`，
//      这条纪律不因换了证据面而松动**；
//   ③ 比值/总量（`1:N`、百分比、「总计」）→ **只提醒**，不硬拒（同口径判定要先有观测基线）；
//   ④ 「至少一条非文件系统探针」不做（一条 `date` 就能糊弄）。
//
// 已知局限（不在本层解决）：谓词没有**出处链**——账本里那条含字面值的 `tool_result` 很可能只是
// 对自家报告的 grep（自指回显也算「可溯源」）。修出处链要另开单：改判据会动摇 #787 钉下的文档口径。
//
// 零依赖红线：只用 node: 内置；纯 ESM；不联网、不读盘。#797 没有破这条线：账本的**读**在宿主
// （`erix-run-core.js` 的 `readLedgerEvidence`，只递 store 这个注入端口），本层只收纯数据。

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

/**
 * issue #797：账本证据面的**行数上限**（照 #386 的纪律：每个可变长键都有上限，超限打截断标记）。
 *
 * 为什么要有它：账本是**整份转录**（一轮一行，长 run 几千行），而 guard 的等待预算只有
 * `finalGuardTimeoutMs`。超限时**只留最新的 N 行**（基点取证绝大多数在尾部），并且把
 * `truncated` 如实报出去——账本被截断 ⇒ 「全账本 0 命中」这个结论就下不了（见 `buildLedgerEvidence`）。
 */
export const LEDGER_EVIDENCE_ROW_LIMIT = 4000;

/**
 * issue #797：`diagnostics` 里**逐字面值出处清单**的条数上限（超限打 `literalsTruncated`）。
 * 这是观测面（给人看的清单），不是判定面：判定永远扫全部声明值。
 */
export const LEDGER_LITERAL_LIMIT = 20;

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
 * issue #797：把**宿主读好的**账本行折成谓词能用的证据面（本函数不读盘、不联网，只做整理）。
 *
 * 为什么需要它（缺陷一句话）：引擎给 guard 的 `payload.messages` 是 `cloneState(ctx.messages)`，
 * 也就是**被上下文压缩改写的那一份** ⇒ 「取证发生在折叠之前」的长 run，声明的字面值明明逐字
 * 入账过，谓词却看不见 ⇒ `revise` 到重试用尽 ⇒ `unverified / max_retries`。修法是证据面换成
 * 「存活窗口 ∪ 账本」：账本（`store.loadRawRows` 的原始行，#714）里每条 `tool_result` 都在。
 *
 * 折叠事实**只从账本推**（不引第二份来源）：
 *   · `foldRows` = 带 `foldedRoundRange` 的行数；
 *   · `foldCeiling` = `max(foldedRoundRange.to)` = 最后一次压缩折到了哪一轮；
 *   · 没有折叠行 ⇒ `foldCeiling = null` = **本次没观察到压缩**（不是 0，也不是「折到第 0 轮」）。
 *
 * 完整性纪律（宁可留今天的 `max_retries`，也不造新假话）：读失败 / 探针缺席 / 行数截断
 * 任一成立 ⇒ `ledgerComplete = false` ⇒ 谓词**不许**下 `not_in_ledger` 结论。
 *
 * **这个函数是元数据的唯一生产者**（R2 F1）：宿主读口把任何来源（store 探针、注入的数组、
 * 注入的「成形证据」对象）都只当成**行数据**递进来，`truncated` / `readFailed` / `foldCeiling` /
 * `foldRows` / `ledgerComplete` 一律在这里重算，**不读调用方自报的那一份** ⇒ 没人能拿一份
 * 自称完整的证据面把上面那条完整性纪律饶过去。脏行（`null` 一类）在这里就被安全化。
 * 上限的次序也只有一种：先保留**最新的 N 条原始行**（`slice`），再由这些行构造证据面。
 *
 * @param {Array<{round?:number, messages?:unknown[], foldedRoundRange?:{from?:number,to?:number}}>|undefined|null} rows
 * @param {{source?:string, rowLimit?:number, readFailed?:boolean, readError?:string}} [options]
 * @returns {{rows:Array<{round:number|null,text:string}>, foldRows:number, foldCeiling:number|null,
 *   truncated:boolean, readFailed:boolean, source:string, readError:string|null, ledgerComplete:boolean,
 *   rowLimit:number}}
 */
export function buildLedgerEvidence(rows, { source = "unknown", rowLimit = LEDGER_EVIDENCE_ROW_LIMIT, readFailed = false, readError } = {}) {
  const limit = Number.isSafeInteger(rowLimit) && rowLimit > 0 ? rowLimit : LEDGER_EVIDENCE_ROW_LIMIT;
  const given = Array.isArray(rows) ? rows : [];
  // 非数组（store 的探针返回了 undefined / 抛错被上层吞掉）＝**没读到**，与「读到 0 行」不同：
  // 后者是账本真的空，前者是读口没给出事实，两者都必须能区分（`not_read`）。
  const notRead = !Array.isArray(rows);
  const truncated = given.length > limit;
  const kept = truncated ? given.slice(given.length - limit) : given;
  let foldRows = 0;
  let foldCeiling = null;
  const shaped = [];
  for (const row of kept) {
    const range = row?.foldedRoundRange;
    if (range !== null && typeof range === "object") {
      foldRows += 1;
      const to = Number.isSafeInteger(range.to) ? range.to : null;
      if (to !== null && (foldCeiling === null || to > foldCeiling)) foldCeiling = to;
    }
    shaped.push({
      round: Number.isSafeInteger(row?.round) ? row.round : null,
      text: collectToolResultText(row?.messages),
    });
  }
  const failed = readFailed === true || notRead;
  // **0 行的账本不是证据面**（R2 F1）：从空账本推不出「全账本 0 命中」，所以它**不许**撑起
  // `not_in_ledger`。注意这与「没读到」仍是两件事：读到空仍然是**读到**，`source` 与
  // `ledgerRows:0` 就是这件事的记录（尾巴上会写「账本 0 行 … 账本不完整」）；而调用方自报的
  // `ledgerComplete:true` 不算数（上面那段：完整性只从 rows 推）。
  const emptyLedger = shaped.length === 0;
  return {
    rows: shaped,
    foldRows,
    foldCeiling,
    truncated,
    readFailed: failed,
    source: notRead && source === "unknown" ? "not_read" : source,
    readError: readError ?? (notRead
      ? "账本读口没返回数组 ⇒ 本次没有账本可读"
      : (emptyLedger ? "账本读到 0 行 ⇒ 没有可引用的取证，推不出「全账本 0 命中」" : null)),
    ledgerComplete: !failed && !truncated && !emptyLedger,
    rowLimit: limit,
  };
}

/**
 * 逐字面值定位：存活窗口（`payload.messages` 的 `tool_result`）优先，其次账本。
 * 命中判定复用 `isBaseTraceable`——**不新开第二套匹配口径**（十六进制忽大小写，其余逐字）。
 *
 * **为什么闸门是「折叠后还剩没剩一处」而不是「首次出现在哪一轮」（R2 F4，主会话已判审计的
 * 「必须按首次出现轮判」不成立）**：issue 判据 ② 的**判据本体**是「最后一次压缩与 guard 首轮之间
 * 还留有被引用的 `tool_result`」，「首次出现所在的轮」只是它建议的判法。按首次出现判会在真机样本
 * （`/tmp/762/segment-09`：那个值在 r23/r59/r61 与 r67 都有）上得出错的答案——它会判「没有存活
 * 证据」，而 r67 > 水位 62 确实还留有一处；它还与 issue 自己的反向证（取证在折叠前、终稿在折叠后
 * ⇒ 修后必须 `accept`）直接冲突。所以 `accept` / `revise` 的判定一个字不改，`firstRound` **只是诊断项**：
 * 它让人看得见「首次命中已被折叠、只剩重复命中」这个自指回显风险（出处链本单不修）。
 *
 * @param {string} literal
 * @param {string} toolResultText 存活窗口的取证文本池
 * @param {object|undefined} ledger `buildLedgerEvidence` 的输出；`undefined` = 没有账本
 * @returns {{literal:string, source:"messages"|"ledger"|"none", round?:number|null,
 *   firstRound?:number|null, lastRound?:number|null, survivesLastCompaction?:boolean|null}}
 */
function locateLiteral(literal, toolResultText, ledger) {
  if (isBaseTraceable(literal, toolResultText)) return { literal, source: "messages" };
  if (ledger === undefined) return { literal, source: "none" };
  let firstRound = null;
  let lastRound = null;
  let found = false;
  for (const row of ledger.rows ?? []) {
    // 脏行（`rows:[null]` 一类）只能当「没文本」，不许把谓词炸掉（R2 F1/P10：fail closed 而不是 TypeError）。
    const text = row?.text ?? "";
    if (text === "" || !isBaseTraceable(literal, text)) continue;
    found = true;
    const round = Number.isSafeInteger(row?.round) ? row.round : null;
    if (round === null) continue;
    // 多次命中：`lastRound` 取**最新**那次（判据 ② 要的是「最后一次压缩之后还剩没留有可引用的
    // `tool_result`」），`firstRound` 取最早那次（只当诊断，不当闸门）。
    if (firstRound === null || round < firstRound) firstRound = round;
    if (lastRound === null || round > lastRound) lastRound = round;
  }
  if (!found) return { literal, source: "none" };
  return {
    literal,
    source: "ledger",
    // `round` 保持 = `lastRound`（向后兼容：既有 P1b 钉的是「取最新」，这个键的语义不许动）。
    round: lastRound,
    firstRound,
    lastRound,
    survivesLastCompaction: lastRound === null || ledger.foldCeiling === null
      ? null
      : lastRound > ledger.foldCeiling,
  };
}

/**
 * 纯谓词：终稿 + 本次消息（+ issue #797 的账本证据面）→ guard 决策与可观测字段。
 *
 * `ledger` **不给 ⇒ 判定与今天逐字一致**（回归锚，`P6`）：既不许多改判据，也不许多出 `evidence` 键。
 *
 * @param {{finalText?:unknown, messages?:unknown[], ledger?:object}} payload
 * @returns {{action:"accept"|"revise", message?:string, missingSections:string[],
 *   declaredBases:string[], untraceableBases:string[], ratioFlags:object[], evidence?:object}}
 */
export function inspectFinalDraft({ finalText, messages, ledger } = {}) {
  const { found, missing } = splitFinalDraft(finalText);
  const ratioFlags = findDerivedConclusionFlags(finalText);
  const declared = missing.includes("## 基点")
    ? []
    : extractDeclaredBases(found["## 基点"]);
  const declaredBases = declared.map((entry) => entry.literal);
  const toolResultText = collectToolResultText(messages);
  const hasLedger = ledger !== undefined;
  const located = declaredBases.map((literal) => locateLiteral(literal, toolResultText, ledger));
  const untraceable = located.filter((entry) => entry.source === "none").map((entry) => entry.literal);
  // 账本不完整（读失败 / 探针缺席 / 截断）⇒ 一条 `not_in_ledger` 也不下。
  const notInLedger = hasLedger && ledger.ledgerComplete === true ? untraceable : [];
  const base = {
    missingSections: missing,
    declaredBases,
    untraceableBases: untraceable,
    ratioFlags,
    ...(hasLedger ? { evidence: buildEvidenceReport(located, notInLedger, ledger) } : {}),
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

  // ② 基点溯源 = 唯一硬闸（C2）。证据面 = 存活窗口 ∪ 账本（issue #797）。
  if (declaredBases.length === 0) {
    return {
      ...base,
      action: "revise",
      message: "终稿的「## 基点」段没有给出任何可核验的基点字面值。"
        + "请逐字照抄本次工具返回里出现过的值（commit SHA / tag / 版本号），一行一个。",
    };
  }
  // 取证文本池只在这里摄一次：`locateLiteral` 与旧口径共用同一份 `collectToolResultText`。
  const ledgerRoute = notInLedger.length > 0
    // 只在**账本完整**时才给这条出路（上面已挡：不完整 ⇒ notInLedger 恒空）。
    ? `上述值在本次 run 的**全部账本**里 0 命中：要么重跑取基点的命令把返回原文取回，`
      + `要么把它从「## 基点」删掉、写进「## 未验证」。`
    : "";
  if (untraceable.length > 0) {
    return {
      ...base,
      untraceableBases: untraceable,
      action: "revise",
      message: `「## 基点」声明的 ${untraceable.join("、")} 在本次 run 的工具返回里**逐字找不到**`
        + `（基点必须来自本次取证，不许凭记忆写）。`
        + `请重跑取基点的命令（如 git rev-parse --short HEAD），并把返回里的字面值原样写进「## 基点」。`
        + ledgerRoute,
    };
  }

  // ③ 比值/总量只提醒：出现在 ratioFlags 里，不拦 accept（C4）。
  return { ...base, action: "accept" };
}

/** `diagnostics` 里的证据面报告（只加键不改键；清单有小上限，判定不受上限影响）。 */
function buildEvidenceReport(located, notInLedger, ledger) {
  const basesTruncated = located.length > LEDGER_LITERAL_LIMIT;
  const notInLedgerCapped = notInLedger.slice(0, LEDGER_LITERAL_LIMIT);
  return {
    bases: located.slice(0, LEDGER_LITERAL_LIMIT),
    notInLedger: notInLedgerCapped,
    ...(basesTruncated || notInLedger.length > notInLedgerCapped.length ? { literalsTruncated: true } : {}),
    foldCeiling: ledger.foldCeiling ?? null,
    foldRows: ledger.foldRows ?? 0,
    ledgerRows: (ledger.rows ?? []).length,
    ledgerComplete: ledger.ledgerComplete === true,
    ledgerSource: ledger.source ?? "unknown",
    ...(ledger.truncated === true ? { ledgerTruncated: true } : {}),
    ...(ledger.readFailed === true ? { ledgerReadFailed: true } : {}),
    ...(ledger.readError ? { ledgerReadError: ledger.readError } : {}),
  };
}

/**
 * issue #797 判据 ①：把「重试用尽」这一格改写成**诚实的**原因——纯函数，便于单测（`P5`）。
 *
 * 返回 `"not_in_ledger"` 当且仅当四条**同时**成立（一条不成立就返回 `null`，载荷逐字回到今天）：
 *   1. `verification.status === "unverified"` 且 `verification.reason === "max_retries"`（引擎原话）；
 *   2. 末次 attempt 记下了**非空**的 `notInLedgerBases`；
 *   3. `ledgerComplete === true`（账本读全了：探针在、没读失败、没截断）；
 *   4. `compactionObserved === true`（账本里有折叠行 ⇒ 判据 ① 的「触发过压缩」）。
 *
 * 只改 `reason` 一个键：`status` 的取值集合（`verified|skipped|unverified|error`）一个字没动，
 * 也不新增事件类型；引擎原值由调用方留在 `verification.engineReason`（可审计）。
 *
 * @param {{verification?:object, tally?:object}} input
 * @returns {"not_in_ledger"|null}
 */
export function honestVerificationReason({ verification, tally } = {}) {
  if (verification?.status !== "unverified" || verification?.reason !== "max_retries") return null;
  if (tally === null || typeof tally !== "object") return null;
  if (!Array.isArray(tally.notInLedgerBases) || tally.notInLedgerBases.length === 0) return null;
  if (tally.ledgerComplete !== true) return null;
  if (tally.compactionObserved !== true) return null;
  return "not_in_ledger";
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
    // issue #797：证据面（存活窗口 ∪ 账本）的末次 attempt 事实。**没建账本管道时一个键也不添**
    // （下面 `createFinalGuardVerify` 只在看到 `inspected.evidence` 时才写这些键）。
    evidence: undefined,
    notInLedgerBases: [],
    ledgerComplete: false,
    compactionObserved: false,
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
 * issue #797：**读账本发生在本回调内部**（本函数已经是 async、已经 `await inspect`，天然放得下）。
 * `readLedger` 是宿主递进来的读口（见 `erix-run-core.js` 的 `deps.finalGuardLedger`）：它返回
 * `buildLedgerEvidence(...)` 的纯数据，或 `undefined`（没建管道）。没建 ⇒ 谓词一条行为也不变。
 *
 * @param {{inspect?:(payload:object)=>object, tally?:object, now?:()=>number, onObserve?:(summary:object)=>void,
 *   readLedger?:undefined|((payload:object)=>Promise<object|undefined>|object|undefined)}} deps
 * @returns {(payload:object)=>Promise<{action:string, message?:string, reason?:string}>}
 */
export function createFinalGuardVerify({
  inspect = inspectFinalDraft,
  tally = createFinalGuardTally(),
  now = Date.now,
  onObserve,
  readLedger,
} = {}) {
  return async function finalGuardVerify(payload = {}) {
    tally.calls += 1;
    const startedAt = now();
    let decision;
    try {
      // 读账本失败**不能**把 guard 带死：退化成「没有账本」⇒ 行为逐字回到今天（宁可留 max_retries）。
      let ledger;
      if (typeof readLedger === "function") {
        try {
          ledger = await readLedger(payload);
        } catch (error) {
          ledger = undefined;
          tally.ledgerReadError = error?.message === undefined ? String(error) : error.message;
        }
      }
      // 谓词**允许是异步的**（真 guard 要读盘 / 跑一次小模型调用），这里必须 await：
      // 不 await 就会把一个 Promise 当成决策交给引擎，引擎报「invalid decision」→ 白跑。
      const inspected = (await inspect(ledger === undefined ? payload : { ...payload, ledger }))
        ?? { action: "revise", message: "guard 谓词没返回决策" };
      decision = { action: inspected.action, message: inspected.message, reason: inspected.reason };
      tally.reviseRounds += inspected.action === "revise" ? 1 : 0;
      tally.accepted += inspected.action === "accept" ? 1 : 0;
      tally.ratioFlags = inspected.ratioFlags ?? [];
      tally.missingSections = inspected.missingSections ?? [];
      tally.declaredBases = inspected.declaredBases ?? [];
      tally.untraceableBases = inspected.untraceableBases ?? [];
      applyEvidenceToTally(tally, inspected.evidence);
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
 * 把谓词给出的证据面事实挂到 tally 上（**末次 attempt 覆盖前一次**，与 `untraceableBases` 同口径）。
 * `honestVerificationReason` 读的就是这里的 `notInLedgerBases` / `ledgerComplete` / `compactionObserved`。
 */
function applyEvidenceToTally(tally, evidence) {
  if (evidence === undefined || evidence === null) {
    // 没看到证据面（没建管道 / 注入的谓词不报证据）⇒ 不把一堆空值当成「看过账本」。
    tally.evidence = undefined;
    tally.notInLedgerBases = [];
    tally.ledgerComplete = false;
    tally.compactionObserved = false;
    tally.ledgerSource = undefined;
    return;
  }
  tally.evidence = evidence;
  tally.notInLedgerBases = evidence.notInLedger ?? [];
  tally.ledgerComplete = evidence.ledgerComplete === true;
  // 账本读口是哪个（`loadRawRows` / `load` / `no_probe` / `xxx:error` / `injected`）——审计要看得见。
  tally.ledgerSource = evidence.ledgerSource ?? "unknown";
  // 「观察到压缩」= 账本里有折叠行（判据 ① 的第 4 条）；foldCeiling 为 null 就是本次没压缩。
  tally.compactionObserved = evidence.foldCeiling !== null && evidence.foldCeiling !== undefined;
  tally.ledgerReadError = evidence.ledgerReadError ?? tally.ledgerReadError;
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
    + ` ｜ 来源 ${tally.source ?? "unknown"}`
    // issue #797：**只在真有证据面时**追加这一段（没证据面时整行与今天逐字一致，
    // 既有断言 `/calls=0/`、`/revise=0\/2/`、`disabled` 那几条不受影响）。
    + summarizeEvidenceFace(tally);
}

/** 证据面那一段尾巴（`evidence` 缺席时是空串 ⇒ 前面的行与 #314 逐字一致）。 */
function summarizeEvidenceFace(tally) {
  const evidence = tally.evidence;
  if (evidence === undefined || evidence === null) return "";
  const fromLedger = (evidence.bases ?? []).filter((entry) => entry.source === "ledger").length;
  // R2 F4：首次命中与最后一次命中不在同一侧（首次 ≤ 水位、最后 > 水位）时写进尾巴——
  // 这是「只剩重复命中」的自指回显风险信号。它是**诊断**，不是闸门（`accept` / `revise` 不读它）。
  const ceiling = evidence.foldCeiling;
  const repeats = (evidence.bases ?? []).filter((entry) => entry.source === "ledger"
    && Number.isSafeInteger(entry.firstRound) && Number.isSafeInteger(entry.lastRound)
    && entry.firstRound !== entry.lastRound);
  const repeatNote = repeats.length === 0 ? "" : repeats.map((entry) => `，首次命中第 ${entry.firstRound} 轮`
    + `${Number.isSafeInteger(ceiling) && entry.firstRound <= ceiling ? "（≤ 水位）" : ""}`
    + `／最后一次第 ${entry.lastRound} 轮（闸门按最后一次，首次命中只当诊断）`).join("");
  return ` ｜ 证据面=存活窗口∪账本（来源 ${evidence.ledgerSource ?? "unknown"}`
    + `，账本 ${evidence.ledgerRows ?? 0} 行，折叠 ${evidence.foldRows ?? 0} 层`
    + `，最后一次压缩≤第 ${evidence.foldCeiling ?? "?"} 轮`
    + `，账本捞回 ${fromLedger} 条 / 全账本 0 命中 ${(evidence.notInLedger ?? []).length} 条`
    + repeatNote
    + (evidence.ledgerComplete === true
      ? "，账本完整）"
      : `，账本不完整⇒不下 not_in_ledger 结论${evidence.ledgerTruncated === true ? "（已截断）" : ""}${evidence.ledgerReadError ? `：${evidence.ledgerReadError}` : ""}）`);
}
