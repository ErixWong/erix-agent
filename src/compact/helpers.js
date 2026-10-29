// issue #589 —— 「被折轮次的选择」必须认得**引擎注入的续接块**（`src/loop/continuity-block.js`）。
//
// 为什么 compact 这里会 import loop 的一个叶子模块：判据要的是「**所有**折叠策略都不折块」
// （sliding-window / fold-statistical / fold-llm 三个调用点各写一遍 = 下一个策略一定会漏），
// 而块的身份（marker 前缀）只有 `continuity-block.js` 一个权威。这个 import **不成环**：
// `continuity-block.js` 只依赖 `../tokens.js` 与 `./pending-tool-result.js`，两者都不碰 `compact/`。
// 方向也不是「compact 依赖 loop 的编排面」——它是一个**叶子谓词**，与 `isProtectedMessage` 同族。
import { isContinuityMessage } from "../loop/continuity-block.js";

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

export function selectFoldedRounds(rounds, keepRounds, protectedMessage) {
  const target = Math.max(0, rounds.length - keepRounds);
  const folded = [];
  const retained = [];
  const foldedIndexes = [];

  rounds.forEach((round, index) => {
    const protectedRound = roundHoldsContinuityBlock(round)
      || round.messages.some((message) => (
        isProtectedMessage(message, protectedMessage)
      ));
    if (folded.length < target && !protectedRound) {
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
