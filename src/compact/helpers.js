// issue #589 —— 「被折轮次的选择」必须认得**引擎注入的续接块**（`src/loop/continuity-block.js`）。
//
// 为什么 compact 这里会 import loop 的一个叶子模块：判据要的是「**所有**折叠策略都不折块」
// （sliding-window / fold-statistical / fold-llm 三个调用点各写一遍 = 下一个策略一定会漏），
// 而块的身份（marker 前缀）只有 `continuity-block.js` 一个权威。这个 import **不成环**：
// `continuity-block.js` 只依赖 `../tokens.js` 与 `./pending-tool-result.js`，两者都不碰 `compact/`。
// 方向也不是「compact 依赖 loop 的编排面」——它是一个**叶子谓词**，与 `isProtectedMessage` 同族。
import { isContinuityMessage } from "../loop/continuity-block.js";
import { estimateMessageTokens } from "../tokens.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const DEFAULT_RECOVERY_HINT =
  "需要原文请重读文件或查看持久笔记；关键值应当已落盘";

export function resolveRecoveryHint(value) {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : DEFAULT_RECOVERY_HINT;
}

export async function resolveFoldRecoveryHint(value, context) {
  const resolved = typeof value === "function"
    ? await value(context)
    : value;
  return resolveRecoveryHint(resolved);
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

export function isProtectedMessage(message, guard) {
  if (typeof guard === "function") return guard(message) === true;
  if (typeof guard === "string") return message?.role === guard;
  if (Array.isArray(guard)) return guard.includes(message?.role);
  return false;
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
 * **`keepRounds: 0` 时 `target = rounds.length - keepRounds` 会把包括尾部在内的全部轮次选中**
 * ⇒ 块正文进 `foldedPayload` 归档与 `summarizeFoldedPayload` 摘要。两层后果：
 *   ① **取证面污染** —— 归档/摘要里出现「上一版续接块」的正文，读者分不清那是历史事实还是
 *      当前状态的旧快照（#564/#565/#566 那一轮修的就是这个病）；
 *   ② 体积放大 —— 块按预算可到 1200 token。
 *
 * 修法是「这一轮不可折」，与既有的 `isProtectedMessage` 同一条纪律（不是把块挪出 `messages`：
 * 那会打掉 #568 判据 3 的「块计入本地估算」）。
 *
 * @param {{messages: any[]}} round
 * @returns {boolean}
 */
function roundHoldsContinuityBlock(round) {
  const messages = Array.isArray(round?.messages) ? round.messages : [];
  return messages.some(isContinuityMessage);
}

export function selectFoldedRounds(
  rounds,
  keepRounds,
  protectedMessage,
  workingSetRecentRounds = 0,
) {
  const target = Math.max(0, rounds.length - keepRounds);
  // issue #608：**工作集地板**。最近 `workingSetRecentRounds` 个带 `tool_result` 的轮次是模型
  // 当下正在用的东西（「工作集」），**优先**不折它们——与 #588（悬空 `tool_use` ⇒ 推迟压缩）同族。
  // `0` = 关闭（默认），由引擎在 `compactOptions` 里显式开成 `WORKING_SET_RECENT_ROUNDS`。
  //
  // ⚠ 它是**排序偏好**，不是「永不折工作集」：下面那段「进度保证」保证它不会把折叠锁死。
  // 纯「永不折」的口径会退化成「小预算 run 一次都折不了 ⇒ 安全层整轮丢掉、连摘要都没有」，
  // 信息只会更少（#608 第一版的实测教训）。
  const floorIndex = workingSetFloorIndex(rounds, workingSetRecentRounds);
  const foldable = (round) => !roundHoldsContinuityBlock(round)
    && !round.messages.some((message) => isProtectedMessage(message, protectedMessage));
  const folded = [];
  const retained = [];
  const foldedIndexes = [];

  rounds.forEach((round, index) => {
    if (folded.length < target && index < floorIndex && foldable(round)) {
      folded.push(round);
      foldedIndexes.push(index);
    } else {
      retained.push(round);
    }
  });

  // ── 进度保证（issue #608）：地板是偏好，不是死锁 ──────────────────────────────────────
  // 若地板把**所有**可折轮次都挡住了（`folded` 为空，而调用方确实要求折：`target > 0`）⇒ 照旧折
  // **最老的那一轮**。调用方（引擎）是在「这一发请求已经超预算」时才要求折的，一次都不折等于把
  // 超预算的请求原样发出去，而安全层随后会整轮丢掉——比「折掉工作集」更差（连摘要都没有）。
  // 连续性块 / `protectedMessage` 仍然不在此列：它们不是「地板挡住了」，是**不可折**。
  if (folded.length === 0 && target > 0) {
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
    protectedMessage: optionValue(callOptions, factoryOptions, "protectedMessage"),
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
    // 直接调策略的既有判据（`keepRounds: 0` ⇒ 全折）逐字不变；引擎在 `compactOptions` 里显式
    // 开成 `WORKING_SET_RECENT_ROUNDS`。
    workingSetRecentRounds: optionValue(
      callOptions,
      factoryOptions,
      "workingSetRecentRounds",
      0,
    ),
    // 锚点索引（A2）：默认启用；false 完全关闭（行为与 0.7.0 一致），
    // 对象形式可夹取 { maxPerKind, maxChars }。
    anchors: optionValue(callOptions, factoryOptions, "anchors"),
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
