// issue #589 —— 「被折轮次的选择」必须认得**引擎注入的续接块**（`src/loop/continuity-block.js`）。
//
// 为什么 compact 这里会 import loop 的一个叶子模块：判据要的是「**所有**折叠策略都不折块」
// （sliding-window / fold-statistical / fold-llm 三个调用点各写一遍 = 下一个策略一定会漏），
// 而块的身份（marker 前缀）只有 `continuity-block.js` 一个权威。这个 import **不成环**：
// `continuity-block.js` 只依赖 `../tokens.js` 与 `./pending-tool-result.js`，两者都不碰 `compact/`。
// 方向也不是「compact 依赖 loop 的编排面」——它是一个**叶子谓词**。
import { isContinuityMessage } from "../loop/continuity-block.js";
import { estimateMessageTokens } from "../tokens.js";
// issue #741：笔记可用性的判定住在 TTL 模块（那里是工具面/账本证据的原点），本模块只负责
// 据此选措辞。方向是单向的：`tool-result-ttl.js` 只依赖 `node:crypto` + `../tokens.js`，不反向 import
// compact，所以这条边不成环（与本文件已有的 `../loop/continuity-block.js` 同一类叶依赖）。
import { NOTE_RECALL_REASONS, resolveNoteRecall, unverifiedRecallClause } from "../loop/tool-result-ttl.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 有笔记证据时的广告语（保持原句，宿主/测试钉的都是这一句）。
export const DEFAULT_RECOVERY_HINT =
  "需要原文请重读文件或查看持久笔记；关键值应当已落盘";

/**
 * 无证据时的广告语（issue #741）：不再提「查看持久笔记」，而是明说没有可复原记录并给原因。
 * 三句都是模型可见文本（也是可被宿主编辑的面），改动 = 改模型看到的句子。
 * @param {string | undefined | null} [reason] 证据不足的原因文本（`NOTE_RECALL_REASONS` 的值）
 * @returns {string}
 */
export function unverifiedRecoveryHint(reason) {
  // 与默认句同量级（默认句 24 字，本句 ~35 字）：折叠摘要有字节夹断，长出来的每一个字都在
  // 挤掉正文（#460 尺蠖 / `FOLDED_FACTS_MAX_BYTES`）。TTL 占位符那边才带「不要猜测」半句，
  // 因为广告语从来不含那条约束，硬加进来等于改两个面。
  return `需要原文请重读文件；${unverifiedRecallClause(reason)}`;
}

/**
 * 引擎自己可能渲染出的全部默认广告语。折叠摘要**合并**时要把它们从标题里剔干净（原代码只剔
 * `DEFAULT_RECOVERY_HINT` 一句，现在默认句有三条变体，漏一个就会在合并标题里留半句臃肿）。
 */
export const ENGINE_RECOVERY_HINTS = Object.freeze([
  DEFAULT_RECOVERY_HINT,
  unverifiedRecoveryHint(NOTE_RECALL_REASONS.noSurface),
  unverifiedRecoveryHint(NOTE_RECALL_REASONS.emptyNotes),
  unverifiedRecoveryHint(NOTE_RECALL_REASONS.revoked),
  unverifiedRecoveryHint(NOTE_RECALL_REASONS.unknown),
]);

/**
 * @param {unknown} value 宿主给的提示（字符串或函数返回值）；给了就逐字沿用，引擎不改写
 * @param {{ available?: boolean, reason?: string }} [noteRecall] 笔记可用性证据；**缺席即未知**
 *   ⇒ 走显式未知口径（issue #741：拿不到证据时不许伪报「有笔记」）
 */
export function resolveRecoveryHint(value, noteRecall) {
  if (typeof value === "string" && value.trim() !== "") return value;
  return noteRecall?.available === true
    ? DEFAULT_RECOVERY_HINT
    : unverifiedRecoveryHint(noteRecall?.reason);
}

/** 从折叠上下文自己推证据：工具面由策略透传，账本 = 本次被折负载 + 仍留下的轮次消息。 */
/**
 * @param {Array<Record<string, any>> | undefined} [messages] 可见账本（消息数组）
 * @param {string[] | undefined} [noteTools] 宿主给的工具面上的笔记名
 * @returns {{ available: boolean, reason: string, surfaceKnown: boolean }}
 */
export function noteRecallFromMessages(messages, noteTools) {
  return resolveNoteRecall({
    noteTools,
    messages: Array.isArray(messages) ? messages : [],
  });
}

/**
 * @param {{ foldedPayload?: Array<Record<string, any>> | undefined,
 *   retained?: Array<{ messages?: Array<Record<string, any>> } | undefined> | undefined,
 *   noteTools?: string[] | undefined } | undefined} [context] 折叠上下文
 * @returns {{ available: boolean, reason: string, surfaceKnown: boolean }}
 */
function noteRecallFromFoldContext(context) {
  return noteRecallFromMessages([
    ...(Array.isArray(context?.foldedPayload) ? context.foldedPayload : []),
    ...(Array.isArray(context?.retained) ? context.retained.flatMap((round) => round?.messages ?? []) : []),
  ], context?.noteTools);
}

export async function resolveFoldRecoveryHint(value, context) {
  const resolved = typeof value === "function"
    ? await value(context)
    : value;
  return resolveRecoveryHint(resolved, context?.noteRecall ?? noteRecallFromFoldContext(context));
}

export function optionValue(callOptions, factoryOptions, key, fallback) {
  if (
    callOptions
    && Object.prototype.hasOwnProperty.call(callOptions, key)
    && callOptions[key] !== undefined
  ) {
    return callOptions[key];
  }
  if (
    factoryOptions
    && Object.prototype.hasOwnProperty.call(factoryOptions, key)
    && factoryOptions[key] !== undefined
  ) {
    return factoryOptions[key];
  }
  return fallback;
}

export function isRealUser(message) {
  if (message?.role !== "user") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return typeof message.content === "string"
    || blocks.length === 0
    || blocks.some((block) => block?.type !== "tool_result");
}

/**
 * issue #608：**工作集**取多少轮。
 *
 * 写成导出常量而不是 `config.*` 叶子（issue 正文硬约束）：新叶会牵动文档与契约面，且这个数
 * 是「模型当下手里有几轮原文」的引擎口径，不是宿主旋钮。判据引用它，而不是硬编码 `2`。
 */
export const WORKING_SET_RECENT_ROUNDS = 2;

function roundHoldsToolResult(round) {
  const messages = Array.isArray(round?.messages) ? round.messages : [];
  return messages.some((message) => (
    Array.isArray(message?.content)
    && message.content.some((block) => block?.type === "tool_result")
  ));
}

/**
 * 最近 `limit` 个**带 `tool_result` 的轮次**在 `rounds` 里的下标（升序）。
 *
 * 为什么按「带 tool_result 的轮」数而不是按「最后 N 个轮」数：一轮可能只有 assistant 正文 / 一条
 * 引擎控制文本（judge nudge、方向提示、run-state），它们不携带模型要用的原文 ⇒ 按轮号数会让工作集
 * 悄悄缩成 0 轮。
 *
 * @param {object[]} rounds `groupIntoRounds` 的 `rounds`
 * @param {number} [limit] `0`（或非法值）⇒ 空集（= 地板关闭）
 * @returns {number[]}
 */
export function workingSetRoundIndexes(rounds, limit = WORKING_SET_RECENT_ROUNDS) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  if (safeLimit === 0) return [];
  const list = Array.isArray(rounds) ? rounds : [];
  const indexes = [];
  for (let index = list.length - 1; index >= 0 && indexes.length < safeLimit; index -= 1) {
    if (roundHoldsToolResult(list[index])) indexes.push(index);
  }
  return indexes.reverse();
}

/**
 * 地板下标：`index >= floorIndex` 的轮次**不折**。空集 ⇒ `rounds.length`（无约束）。
 *
 * @param {object[]} rounds
 * @param {number} [limit]
 * @returns {number}
 */
function workingSetFloorIndex(rounds, limit) {
  const indexes = workingSetRoundIndexes(rounds, limit);
  if (indexes.length === 0) return Array.isArray(rounds) ? rounds.length : 0;
  return indexes[0];
}

/**
 * 工作集 token 量（issue #608）：最近 `limit` 个带 `tool_result` 的轮次里，**只算 `tool_result` 块**
 * 的估算值。
 *
 * 口径与引擎其余预算判定同一个估算器（`estimateMessageTokens` / `estimateTokens`，含每条消息的
 * framing overhead）——不另写一套字符→token 换算，否则「工作集超预算」与「请求超预算」会变成
 * 两把尺子，而本单的判据正是拿这两者比大小。
 *
 * @param {object[]} rounds `groupIntoRounds` 的 `rounds`
 * @param {number} [limit]
 * @returns {number}
 */
export function workingSetTokens(rounds, limit = WORKING_SET_RECENT_ROUNDS) {
  const list = Array.isArray(rounds) ? rounds : [];
  let total = 0;
  for (const index of workingSetRoundIndexes(list, limit)) {
    const messages = Array.isArray(list[index]?.messages) ? list[index].messages : [];
    const toolResultMessages = messages
      .map((message) => {
        if (!Array.isArray(message?.content)) return undefined;
        const blocks = message.content.filter((block) => block?.type === "tool_result");
        return blocks.length === 0 ? undefined : { ...message, content: blocks };
      })
      .filter((message) => message !== undefined);
    total += estimateMessageTokens(toolResultMessages);
  }
  return total;
}

/**
 * issue #608：**预算不足的循环判据**——连续这么多次折叠尝试都满足「工作集 > 预算 且折完仍超预算」
 * 才走显式劣化。
 *
 * 为什么不是「第一次就停」：单次「工作集 > 预算」不等于预算配小了——小预算短跑（3–6 轮）也满足
 * 它，而那种 run 照样能收尾（它只是折得狠一点）。真正要拦的是 #607 那种**打转**：64k 现场 389 次
 * 折叠块、400 轮撞 cap。所以判据是「连续 K 次」，K 取 5——实测 soak（`--rounds 6 --compact-every 2`，
 * budgetTokens=248 / perRound=155）只有 4 次 compaction，真实 64k 现场是 389 次，5 次这条线把两者
 * 分得开。写成导出常量是为了让判据引用它，而不是在测试里硬编码 `5`。
 */
export const WORKING_SET_LOOP_ATTEMPTS = 5;

/**
 * 预算不足时给宿主的**建议预算**（issue #608）：工作集 × 1.5，向上取整到最近的 1k。
 *
 * 为什么是 1.5：工作集只是「最近两轮的原文」，模型还需要任务描述、摘要块、run-state 与输出余量；
 * 1.5 是「装得下工作集并且留得下一折摘要」的最小整数比例，且取整到 1k 是为了让宿主看到的是
 * 一个可以直接抄进配置的数，而不是 `9713` 这种从估算器里漏出来的中间值。
 *
 * @param {number} tokens 工作集 token 量
 * @returns {number}
 */
export function suggestedBudgetTokens(tokens) {
  const safe = Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
  if (safe === 0) return 0;
  return Math.ceil((safe * 1.5) / 1000) * 1000;
}

/**
 * 这一轮里有没有**引擎注入的续接块**（issue #589）。
 *
 * 块是 `messages` 里的一条真 user 消息（#568 的实现前提：这样它才天然计入本地估算），
 * 于是它和普通消息一样会落进「被折轮次」的候选范围。`keepRounds >= 1` 时它在尾部、折不到；
 * **旧口径（无正有限目标）下 `keepRounds: 0` 会让 `target = rounds.length - keepRounds` 把包括尾部
 * 在内的全部轮次选中** ⇒ 块正文进 `foldedPayload` 归档与 `summarizeFoldedPayload` 摘要。新口径
 * （issue #873）不受这条影响：有效保留下限是 `max(keepRounds, MIN_KEEP_ROUNDS)`，尾部那几轮永不折。
 * 两层后果：
 *   ① **取证面污染** —— 归档/摘要里出现「上一版续接块」的正文，读者分不清那是历史事实还是
 *      当前状态的旧快照（#564/#565/#566 那一轮修的就是这个病）；
 *   ② 体积放大 —— 块按预算可到 1200 token。
 *
 * 修法是「这一轮不可折」（不是把块挪出 `messages`：
 * 那会打掉 #568 判据 3 的「块计入本地估算」）。
 *
 * @param {{messages: any[]}} round
 * @returns {boolean}
 */
function roundHoldsContinuityBlock(round) {
  const messages = Array.isArray(round?.messages) ? round.messages : [];
  return messages.some(isContinuityMessage);
}

/**
 * 折叠目标占预算的比例（issue #873）。折后**本地估算（含摘要块开销）≤ 预算 × 本比例**。
 *
 * 为什么是 `0.65` 而不是 `0.6` / `0.7`：
 *   · **落点粒度是「一整轮」**，一轮通常占预算 2–5%。取 0.65 让实际落点落在 **60–65%**：
 *     目标定在 0.65 时，最后一次「刚好跨过目标」的那一轮把估算从 0.65 以上拉到 0.65 以下，
 *     落在 0.60–0.65 这一段；若目标定 0.6，落点会更低、信息更少；定 0.7 则常常「折一轮就过头、
 *     不折又超目标」，反复抖动。
 *   · 0.65 还保证**一次折叠至少买回 ~5 轮**：按平均轮大小 ~2.4k / 预算 65k 估算，折到 0.65 释放
 *     ~22.7k ≈ 9 轮的余量；即便按最坏单轮口径也留得下 5 轮不触发下一次折叠，避免「折一次跑两轮又
 *     折」的锯齿。
 *
 * 它**只决定「折多少」**，不决定「什么时候折」（触发口径仍是 `foldAtRatio`，默认 1.0）。
 */
export const FOLD_TARGET_RATIO = 0.65;

/**
 * 保留轮次的**硬下限**（issue #873 用户裁决）：无论 `keepRounds` 给多小（含 `0`），按预算比例
 * 折叠后**至少**保留这么多轮。用户裁决「留 1 轮等于没留」——一次折叠若只剩 1 轮原文，等于把
 * 整段工作历史压成摘要 + 一条尾巴，信息量与「全折光」几乎无差；因此把上一版的「至少留 1 轮」
 * 上提到 5。
 *
 * 有效保留下限 = `max(keepRounds, MIN_KEEP_ROUNDS)`：`keepRounds: 0`（或 1–4）⇒ 实际按 5 算；
 * `keepRounds: 6`（默认）⇒ 仍 6。`rounds.length <=` 有效下限 ⇒ 一轮都不折（没有可折的），交给
 * enforce-size 安全层。`keepRounds: 0` 因此**不再**意味着「折光」。
 */
export const MIN_KEEP_ROUNDS = 5;

/**
 * 选「折哪些轮」。两种口径：
 *
 *   ① **旧口径（没有正的有限 `target.targetTokens`：缺席 / 0 / 负数 / `NaN` / `Infinity`）**：折到只剩 `keepRounds` 轮
 *      （`target = rounds.length - keepRounds`）。库消费者直接调 `compact`（不传 `budgetTokens`）
 *      逐字走这一支——这是 issue #873 的**反向证 A**：没有预算就没有「折到某比例」可言。
 *
 *   ② **新口径（`target.targetTokens` 为正数，issue #873）**：从**最老**一轮开始逐轮加入 folded，
 *      **一旦**「折后估算（head + 保留轮）+ 摘要块开销 ≤ targetTokens」**立刻停**（不许折得比需要
 *      更多）。此时 `keepRounds` 降级为**保留下限**：最近 `keepRounds` 轮永不折（`index >=
 *      rounds.length - keepRounds` ⇒ 不可折），但它**不再是「折到只剩这么多」的目标**。
 *      判据口径与 `budget-fit.js` 的 `fits()` 一致（`估算 + estimateTokens(摘要) <= 阈值`）。
 *      摘要文本这一层还没生成 ⇒ 由调用方**声明**摘要开销上界 `target.summaryOverheadTokens`
 *      （`number | ((foldedCount, foldedIndexes)=>number)`），语义「这次折叠最多带进多少 token 的摘要」；缺席 ⇒
 *      按 `0` 处理（= 调用方声明没有摘要开销）。回调的第二参 `foldedIndexes` 是**此刻实际选中**的轮索引
 *      （升序）：选择器折的不是连续前缀（连续性块 / 工作集地板会被跳过），只给轮数会被回调
 *      当成「前 N 轮」重建摘要 ⇒ 估算对象与实际被折轮次不符（issue #873，PR #893 copilot ②）。
 *      为何改接口而不是在本函数里猜（issue #873
 *      验收阻断②）：三策略摘要来源各不相同（`fold-llm` 是模型写的、生成前拿不到长度；
 *      `fold-statistical` 是机械摘要但还拼 stubs / navigation / recovery hint；
 *      `sliding-window` 不往输入里 prepend 摘要），用「机械摘要」估 `fold-llm` 会**低估**（模型
 *      摘要可能长得多 ⇒ 估算说 ≤ 65%、实际超），故本函数不再自己猜，开销由调用方声明。
 *
 * 目标不可达（可折轮次被 `keepRounds` 硬下限或工作集地板吃满、仍高于目标）⇒ 折到地板为止、
 * **不把所有轮折光**；`budgetUnreachable` 仍由引擎既有的 enforce-size 口径如实上报（本函数不改它）。
 *
 * @param {object[]} rounds
 * @param {number} keepRounds 保留下限（新口径，有效值 = `max(keepRounds, MIN_KEEP_ROUNDS)`，最小 5）/ 保留目标（旧口径）
 * @param {number} [workingSetRecentRounds] 工作集地板（#608）
 * @param {{ targetTokens?: number, headMessages?: any[],
 *   summaryOverheadTokens?: number | ((foldedCount: number, foldedIndexes: number[]) => number) }} [target]
 *   按 token 目标折的入参；`targetTokens` 不是正的有限数 ⇒ 退回旧口径；`summaryOverheadTokens` = 摘要开销上界（缺席 ⇒ `0`；
 *   回调形态拿到的第二参是**实际选中**的轮索引，不是前缀）
 * @returns {{ folded: any[], retained: any[], foldedIndexes: number[] }}
 */
export function selectFoldedRounds(
  rounds,
  keepRounds,
  workingSetRecentRounds = 0,
  target = {},
) {
  // issue #608：**工作集地板**。最近 `workingSetRecentRounds` 个带 `tool_result` 的轮次是模型
  // 当下正在用的东西（「工作集」），**优先**不折它们——与 #588（悬空 `tool_use` ⇒ 推迟压缩）同族。
  // `0` = 关闭（默认），由引擎在 `compactOptions` 里显式开成 `WORKING_SET_RECENT_ROUNDS`。
  //
  // ⚠ 它是**排序偏好**，不是「永不折工作集」：下面那段「进度保证」保证它不会把折叠锁死。
  // 纯「永不折」的口径会退化成「小预算 run 一次都折不了 ⇒ 安全层整轮丢掉、连摘要都没有」，
  // 信息只会更少（#608 第一版的实测教训）。
  const floorIndex = workingSetFloorIndex(rounds, workingSetRecentRounds);
  const foldable = (round) => !roundHoldsContinuityBlock(round);

  const rawTargetTokens = target?.targetTokens;
  const targetTokens = Number.isFinite(rawTargetTokens) && rawTargetTokens > 0
    ? rawTargetTokens
    : undefined;

  if (targetTokens === undefined) {
    // ── ① 旧口径（逐字保留，反向证 A）：折到只剩 keepRounds 轮 ────────────────────────────
    const countTarget = Math.max(0, rounds.length - keepRounds);
    /** @type {any[]} */ const folded = [];
    /** @type {any[]} */ const retained = [];
    /** @type {number[]} */ const foldedIndexes = [];

    rounds.forEach((round, index) => {
      if (folded.length < countTarget && index < floorIndex && foldable(round)) {
        folded.push(round);
        foldedIndexes.push(index);
      } else {
        retained.push(round);
      }
    });

    // ── 进度保证（issue #608）：地板是偏好，不是死锁 ──────────────────────────────────
    // 若地板把**所有**可折轮次都挡住了（`folded` 为空，而调用方确实要求折：`target > 0`）⇒ 照旧折
    // **最老的那一轮**。调用方（引擎）是在「这一发请求已经超预算」时才要求折的，一次都不折等于把
    // 超预算的请求原样发出去，而安全层随后会整轮丢掉——比「折掉工作集」更差（连摘要都没有）。
    // 连续性块仍然不在此列：它不是「地板挡住了」，是**不可折**。
    if (folded.length === 0 && countTarget > 0) {
      const index = rounds.findIndex((round) => foldable(round));
      if (index >= 0) {
        folded.push(rounds[index]);
        foldedIndexes.push(index);
        const retainedIndex = retained.indexOf(rounds[index]);
        if (retainedIndex >= 0) retained.splice(retainedIndex, 1);
      }
    }

    return { folded, retained, foldedIndexes };
  }

  // ── ② 新口径（issue #873）：按 token 目标折，从最老一轮逐轮加入，一旦满足目标立刻停 ──────
  // `keepRounds` 是**保留下限**（最近 keepRounds 轮永不折），不是「折到只剩这么多」。
  //
  // 硬下限是 `MIN_KEEP_ROUNDS`（issue #873 用户裁决「留 1 轮等于没留」）：**有效保留下限 =
  // `max(keepRounds, MIN_KEEP_ROUNDS)`**。`keepRounds: 0`（或 1–4）⇒ 实际按 5 算；`keepRounds: 6`
  // （默认）⇒ 仍 6。`keepFloor = max(0, len - effectiveKeep)` 是「可折轮数」的上界：`rounds.length
  // <= effectiveKeep` ⇒ `keepFloor = 0` ⇒ 一轮都不折（没有可折的），交给 enforce-size 安全层。这条
  // **替代**上一版的「至少留 1 轮」补丁（`min(len-keepRounds, len-1)`）——那版只保证留 1 轮，正是
  // 用户否决的「留 1 轮等于没留」，不再需要 `Math.max(1, …)` 那种收缩。目标不可达时折到 `keepFloor`
  // 为止 ⇒ 恰好留 `effectiveKeep` 轮（`keepRounds: 0` + 10 轮 ⇒ 留 5，不是 1、不是 10）。
  const effectiveKeep = Math.max(keepRounds, MIN_KEEP_ROUNDS);
  const keepFloor = Math.max(0, rounds.length - effectiveKeep);
  /** @type {any[]} */ const headMessages = Array.isArray(target?.headMessages) ? target.headMessages : [];
  // 摘要开销上界由调用方声明（issue #873 验收阻断②）：
  // `number | ((foldedCount: number, foldedIndexes: number[]) => number)`——第二个参数是**实际选中**的
  // 折叠轮索引（升序），回调据此算「真要拼出来的那份摘要」，不要假定它是前 N 轮；
  // 缺席 ⇒ `0`（= 调用方声明这次折叠没有摘要开销）。本函数不再自己调机械摘要去猜。
  const summaryOverheadTokens = target?.summaryOverheadTokens;

  // `estimateMessageTokens` 逐消息可加 ⇒ 折后估算 = 起手总量（head + 全部轮次）逐轮减去被折轮次。
  /** @type {number[]} */ const roundTokens = rounds.map((round) => estimateMessageTokens(round.messages));
  let afterBase = estimateMessageTokens(headMessages);
  for (const tokens of roundTokens) afterBase += tokens;

  /** @type {Set<number>} */ const foldedSet = new Set();
  const foldableToken = (round, index) => index < keepFloor
    && index < floorIndex
    && foldable(round);
  // 进度保证用：只受 keepRounds 硬下限约束、**不受**工作集地板约束的可折判定（与旧口径一致——
  // 旧口径里进度保证也只折 `keepRounds` 之外的轮，工作集地板才是可被它覆盖的偏好）。
  const hardFoldable = (round, index) => index < keepFloor && foldable(round);
  // 摘要开销：按调用方声明的上界取（`foldedCount` 是当前已折轮数）；非函数值直接取数。
  // 缺席 / 非正数 ⇒ `0`。开销只在真有轮被折时才计入（未折 ⇒ 无摘要）。
  // 第二参是**此刻实际选中**的轮索引（issue #873 PR #893 copilot ②）：选中集合在循环里只增不改
  // （`foldedSet.add(index)` 不会改动已选索引），所以按升序重筛一遍 `foldedSet` 就是当前集合；
  // 只传轮数会让回调把它当「前 N 轮」，而中间被保护 / 连续性块那些轮其实被保留了。
  const selectedRoundIndexes = () => {
    /** @type {number[]} */ const indexes = [];
    for (let index = 0; index < rounds.length; index += 1) {
      if (foldedSet.has(index)) indexes.push(index);
    }
    return indexes;
  };
  const summaryOverhead = (count) => {
    if (count <= 0) return 0;
    const value = typeof summaryOverheadTokens === "function"
      ? summaryOverheadTokens(count, selectedRoundIndexes())
      : summaryOverheadTokens;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };

  for (let index = 0; index < rounds.length; index += 1) {
    // 目标已满足 ⇒ 立刻停（不许折得比需要更多）。判据与 `budget-fit.js` 的 `fits()` 同口径。
    if (afterBase + summaryOverhead(foldedSet.size) <= targetTokens) break;
    if (!foldableToken(rounds[index], index)) continue; // 工作集地板 / keepRounds 下限 / 不可折 ⇒ 保留
    foldedSet.add(index);
    afterBase -= roundTokens[index];
  }

  // 进度保证（#608）：什么都没折、却仍高于目标（工作集地板挡住了全部可折轮）⇒ 折最老那一轮，
  // **覆盖工作集地板**，但 `keepRounds` 内的轮是硬下限、永不折。折光可折轮次仍高于目标 ⇒ 不触发
  // 这里（`foldedSet` 非空），保持「折到地板为止」。
  if (foldedSet.size === 0 && afterBase > targetTokens) {
    const index = rounds.findIndex((round, i) => hardFoldable(round, i));
    if (index >= 0) foldedSet.add(index);
  }

  /** @type {any[]} */ const folded = [];
  /** @type {any[]} */ const retained = [];
  /** @type {number[]} */ const foldedIndexes = [];
  rounds.forEach((round, index) => {
    if (foldedSet.has(index)) {
      folded.push(round);
      foldedIndexes.push(index);
    } else {
      retained.push(round);
    }
  });
  return { folded, retained, foldedIndexes };
}

export function roundRangeForIndexes(indexes, roundOffset = 0, roundNumbers) {
  const numbers = indexes.map((index) => (
    Number.isSafeInteger(roundNumbers?.[index])
      ? roundNumbers[index]
      : roundOffset + index + 1
  ));
  if (numbers.length === 0) return undefined;
  return {
    from: Math.min(...numbers),
    to: Math.max(...numbers),
  };
}

function stripMessageImages(message) {
  if (!Array.isArray(message?.content)) return { ...message };
  return {
    ...message,
    content: message.content.filter((block) => (
      block?.type !== "image" && block?.type !== "image_url"
    )),
  };
}

export function stripHistoricalImages(messages) {
  return messages.map(stripMessageImages);
}

export async function runFoldHook(hook, payload) {
  if (typeof hook === "function") await hook(payload);
}

function foldStubMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => (
    Array.isArray(message?.content)
    && message.content.some((block) => (
      block?.type === "tool_result"
    ))
  ));
}

/** 单条 stub 的字符上限（宿主 stubFor 与 TTL 句柄共用同一个上界，不各写一个魔数）。 */
export const FOLD_STUB_CHAR_LIMIT = 200;

/**
 * 折叠 stub 行的**双形态**（issue #564）：
 * - `[已折叠]…` —— 半角，宿主 / CLI（`bin/final-guard-support.js`）的 `stubFor` 产出；
 * - `【已折叠·TTL】…` —— 全角，`src/loop/tool-result-ttl.js` 占位符的首行（工具名 + 关键入参）。
 *
 * 两种形态**整行捕获**，上限沿用调用方既有逻辑（单条 `FOLD_STUB_CHAR_LIMIT` / 摘要最多 10 条）。
 * 既有半角形态的匹配结果逐字不变（只是多认了全角那一支）。
 *
 * ⚠ 这个正则带 `g`：只在 `matchAll` / `replace` 里用（两者都不共享 `lastIndex`），别拿去 `test()`。
 */
export const FOLD_STUB_LINE_PATTERN = /^(?:\[已折叠\]|【已折叠·TTL】)[^\n]*/gmu;

const TTL_STUB_LINE_PATTERN = /^【已折叠·TTL】[^\n]*/gmu;

function toolResultTexts(content, output) {
  if (typeof content === "string") {
    output.push(content);
    return output;
  }
  if (!Array.isArray(content)) return output;
  for (const block of content) {
    if (typeof block === "string") output.push(block);
    else if (block?.type === "text" && typeof block.text === "string") output.push(block.text);
  }
  return output;
}

/**
 * 从被折负载里收集 **TTL 句柄**（issue #564 缺口 1）。
 *
 * 这些行本来就躺在 `tool_result` 的正文里（`foldToolResultsForRequest` 把大结果替换成了
 * `【已折叠·TTL】<工具名 + 关键入参>…` 占位符），不需要宿主传 `stubFor` —— 所以**真机形态**
 * （宿主一个钩子都不给）也能把它们收进折叠摘要，而旧实现只看 `stubFor` ⇒ 一条 stub 都没有。
 *
 * @param {object[]} messages 被折轮次的消息（`foldedPayload`）
 * @returns {string[]} 去重后的句柄行（每条 ≤ `FOLD_STUB_CHAR_LIMIT`）
 */
export function collectTtlFoldStubs(messages) {
  const stubs = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "tool_result") continue;
      for (const text of toolResultTexts(block.content, [])) {
        for (const match of text.matchAll(TTL_STUB_LINE_PATTERN)) {
          const bounded = Array.from(match[0]).slice(0, FOLD_STUB_CHAR_LIMIT).join("");
          if (bounded !== "") stubs.push(bounded);
        }
      }
    }
  }
  return [...new Set(stubs)];
}

export async function resolveFoldStubs(messages, stubFor) {
  if (typeof stubFor !== "function") return [];
  const stubs = [];
  for (const message of foldStubMessages(messages)) {
    const value = await stubFor(message);
    if (typeof value !== "string" || value.trim() === "") continue;
    const bounded = Array.from(value).slice(0, FOLD_STUB_CHAR_LIMIT).join("");
    if (bounded !== "") stubs.push(bounded);
  }
  return [...new Set(stubs)];
}

export function appendFoldStubsToHead(head, stubs) {
  if (!Array.isArray(stubs) || stubs.length === 0) return head;
  const userIndex = head.findLastIndex(isRealUser);
  if (userIndex < 0) return head;
  const updatedHead = head.slice();
  const user = updatedHead[userIndex];
  const content = typeof user.content === "string"
    ? [{ type: "text", text: user.content }]
    : Array.isArray(user.content) ? user.content : [];
  // 这里**故意只认半角** `[已折叠]`（与 #564 之前逐字一致）：这个函数的职责是“把宿主 stub 从文本块
  // 里收起来再统一重排”，而 TTL 句柄（`【已折叠·TTL】…`）从不以文本块形式出现在 head 里——它躺在
  // `tool_result` 正文内（本函数对非 text 块原样返回），收进摘要是 `parseFoldSummaryMatch` 那条路。
  // 两边共用双形态正则的话，一份已折叠摘要里的 TTL 行会被“搬出”摘要正文，下一次合并就看不到它们了。
  const stubPattern = /^\[已折叠\][^\n]*/gmu;
  const existing = content
    .filter((block) => block?.type === "text")
    .flatMap((block) => [...String(block.text ?? "").matchAll(stubPattern)]
      .map((match) => match[0]));
  const merged = [...new Set([...existing, ...stubs])];
  const withoutStubs = content.flatMap((block) => {
    if (block?.type !== "text") return [block];
    const text = String(block.text ?? "").replace(stubPattern, "").trim();
    return text === "" ? [] : [{ ...block, text }];
  });
  updatedHead[userIndex] = {
    ...user,
    content: [...withoutStubs, { type: "text", text: merged.join("\n") }],
  };
  return updatedHead;
}

export function foldOptions(factoryOptions, callOptions = {}) {
  return {
    summaryRole: optionValue(callOptions, factoryOptions, "summaryRole", "user"),
    recoveryHint: optionValue(callOptions, factoryOptions, "recoveryHint"),
    // issue #741：本 run 工具面上的笔记工具名（引擎在 `compactOptions` 里显式传；不传 ⇒ 证据缺席
    // ⇒ 默认广告语走显式未知口径）。它只决定措辞，不决定任何机制。名字清单住在 TTL 模块。
    noteTools: optionValue(callOptions, factoryOptions, "noteTools"),
    stripHistoricalImages: optionValue(
      callOptions,
      factoryOptions,
      "stripHistoricalImages",
      false,
    ) === true,
    onBeforeFold: optionValue(
      callOptions,
      factoryOptions,
      "onBeforeFold",
      optionValue(callOptions, factoryOptions, "beforeFold"),
    ),
    onAfterFold: optionValue(
      callOptions,
      factoryOptions,
      "onAfterFold",
      optionValue(callOptions, factoryOptions, "afterFold"),
    ),
    stubFor: optionValue(callOptions, factoryOptions, "stubFor"),
    onLayer: optionValue(callOptions, factoryOptions, "onLayer"),
    // issue #608：工作集地板（最近 N 个带 `tool_result` 的轮次不折）。默认 `0` = 关闭：
    // 直接调策略的既有判据逐字不变（旧口径下 `keepRounds: 0` ⇒ 全折；issue #873 的新口径另有
    // `MIN_KEEP_ROUNDS` 硬下限，与本地板无关）；引擎在 `compactOptions` 里显式
    // 开成 `WORKING_SET_RECENT_ROUNDS`。
    workingSetRecentRounds: optionValue(
      callOptions,
      factoryOptions,
      "workingSetRecentRounds",
      0,
    ),
    roundOffset: Number.isFinite(callOptions.roundOffset)
      ? Math.max(0, Math.floor(callOptions.roundOffset))
      : Number.isFinite(factoryOptions?.roundOffset)
        ? Math.max(0, Math.floor(factoryOptions.roundOffset))
        : 0,
    roundNumbers: Array.isArray(callOptions.roundNumbers)
      ? callOptions.roundNumbers
      : Array.isArray(factoryOptions?.roundNumbers)
        ? factoryOptions.roundNumbers
        : undefined,
  };
}

export function cloneFoldPayload(payload, stripImages) {
  const cloned = payload.map((message) => (
    typeof structuredClone === "function"
      ? structuredClone(message)
      : JSON.parse(JSON.stringify(message))
  ));
  return stripImages ? stripHistoricalImages(cloned) : cloned;
}

export function isCanonicalMessage(value) {
  return isRecord(value) && typeof value.role === "string";
}
