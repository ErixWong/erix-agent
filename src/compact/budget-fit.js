// @ts-check
// issue #643 —— 预算兜底（库层 `sliding-window` 那一发）的两处行为修正。
//
// 病根（0.29.0 实测，issue 正文 §1/§2）：上下文略超预算（14,692 / 12,000 = 1.22）且
// 可折轮数 ≤ `keepRounds`（默认 6）时，配置的策略折 **0** 轮，接着引擎兜底写死
// `keepRounds: 0`（= 把所有可折轮次全折掉）⇒ 14,692 tok 被清成 **150 tok**，而摘要器
// 一次都没被调用（`foldLlm.triggered` 恒 0、`slidingWindow.triggered` 恒 1）。模型手里
// 只剩任务原文 + 一行通用 stub，只好把同一批文件重读一遍又一遍。
//
// 本模块只做两件事，且都发生在**引擎侧**：
//   ① `foldWithinBudget`：兜底的 `keepRounds` 从「数量」退化成**保留上界**——从最老一轮
//      开始逐轮多折，`estimate <= budgetTokens` 即停（= #464 C 档「折到够用就停」）；
//   ② `prependFoldSummary`：把 `sliding-window` **已经算好的**机械摘要（范围句 / 工具足迹 /
//      清单 / stub，`summarizeFoldedPayload` 的产物）prepend 进 head（= #464 B 档
//      「兜底也产摘要」），模型不再只拿到结构骨架。
//
// 四条边界（改之前先读，改错会静默改语义）：
//   · **不改 `sliding-window` 本身**：`test/compact/folded-facts.test.js` 钉着「直接调用时
//     摘要只落账、不进 `compactedMessages`」——那是它自己的契约。拟合与 prepend 都在这里。
//   · **不改默认策略、不改 `keepRounds` 默认值 6**：默认值 6 是宿主语义（#614 只换了默认
//     策略名），本模块只在兜底那一发把它当上界用。
//   · **预算装不下可折内容时不静默清空**：折到 `keepRounds: 0`（= 能折的都折了）即收手，
//     交给引擎既有的显式劣化闸门（#608 `budget_below_working_set`）与安全层——那两处的
//     语义本模块一个字都没动。
//   · 拟合只认**保留轮数**这一个旋钮：`protectedMessage` / 续接块 / 工作集地板都由
//     `selectFoldedRounds` 在策略内部守（本模块不另写一套「哪些轮能折」）。

import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens, estimateTokens } from "../tokens.js";
import { isRealUser } from "./helpers.js";

/**
 * 换 `keepRounds` 而**保住非枚举选项**（`roundNumbers` / `foldRecords` / `workingSetRecentRounds`
 * 都是 `Object.defineProperty` 挂上去的，展开语法会把它们静默丢掉——那等于让兜底看不见
 * 工作集地板与轮号，正是 #608 / #601 花了两单才修好的通道）。
 *
 * @param {Record<string, any>} options
 * @param {number} keepRounds
 * @returns {Record<string, any>}
 */
function withKeepRounds(options, keepRounds) {
  const next = { ...options, keepRounds };
  for (const key of Object.getOwnPropertyNames(options)) {
    if (Object.prototype.propertyIsEnumerable.call(options, key)) continue;
    Object.defineProperty(next, key, Object.getOwnPropertyDescriptor(options, key));
  }
  return next;
}

/**
 * 这一次折叠**要额外占的** token（摘要 prepend 进已有消息 ⇒ 只多一段 text 块，不多一条消息）。
 *
 * @param {{ foldedSummaryText?: string }} result
 * @returns {number}
 */
function summaryTokens(result) {
  const text = result?.foldedSummaryText;
  return typeof text === "string" && text !== "" ? estimateTokens(text) : 0;
}

/**
 * 兜底折叠：从最老一轮开始折，**进入预算即停**。
 *
 * 与 `strategy.compact(messages, { keepRounds: 0 })` 的差别只有一个方向：后者是「折到底」，
 * 这里是「折到够用」。两者在「折到 0 轮仍装不下」时收敛到同一发（全折），随后由引擎的
 * 显式劣化闸门 / 安全层接管——所以本函数**不会**把「预算真的装不下」伪装成「已经装下了」。
 *
 * 起手点用「逐轮估算累减」算一个近似解（`estimateMessageTokens` 是逐消息可加的），再向
 * 两侧各校正一两步：装不下就多折一轮，装得下就试少折一轮。于是常见路径只调 1~3 次
 * `compact()`，不必把每一档 keepRounds 都跑一遍。
 *
 * @param {{ compact: (messages: object[], options?: object) => Promise<any> }} strategy
 * @param {object[]} messages
 * @param {{ budgetTokens?: number } & Record<string, any>} [options]
 * @returns {Promise<any>} 策略的 `compact()` 返回值（与直接调用同形）
 */
export async function foldWithinBudget(strategy, messages, options = {}) {
  const budgetTokens = options?.budgetTokens;
  const { rounds } = groupIntoRounds(messages);
  // 上界是 `rounds.length`（= 一轮都不折）：调用方是「已经超预算」才会进来，但「预算充裕」那一格
  // （库消费者直接调 / 估算器与真实用量有偏差）必须能如实返回「没折」，不许强行折一轮。
  const maxKeep = rounds.length;
  const compact = (keepRounds) => strategy.compact(messages, withKeepRounds(options, keepRounds));
  // 「够用」= 折后的估算 + 摘要块自己的开销都装进预算（摘要也是模型要读的 token）。
  const fits = (result) => !Number.isFinite(budgetTokens)
    || result.tokensAfter + summaryTokens(result) <= budgetTokens;

  // 没有预算（库消费者直接调）⇒ 逐字沿用旧行为（折到底），不在这里发明新语义。
  let keep = Number.isFinite(budgetTokens) ? maxKeep : 0;
  if (Number.isFinite(budgetTokens)) {
    const roundTokens = rounds.map((round) => estimateMessageTokens(round.messages));
    let remaining = estimateMessageTokens(messages);
    let folded = 0;
    while (remaining > budgetTokens && folded < rounds.length) {
      remaining -= roundTokens[folded];
      folded += 1;
    }
    keep = Math.max(0, Math.min(maxKeep, rounds.length - folded));
  }

  let result = await compact(keep);
  // 估算起手点装不下 ⇒ 逐轮多折（最多到 keepRounds: 0）。
  while (!fits(result) && keep > 0) {
    keep -= 1;
    result = await compact(keep);
  }
  // 装得下 ⇒ 逐轮少折，直到「再少一轮就装不下」——这一发才是「够用就停」。
  while (fits(result) && keep < maxKeep) {
    const fewer = await compact(keep + 1);
    if (!fits(fewer)) break;
    keep += 1;
    result = fewer;
  }
  return result;
}

/**
 * 把机械摘要 prepend 进 head（issue #643 B 档）。
 *
 * 落点与 `fold-statistical` / `fold-llm` 的 `prependSummary` 同口径：
 *   · `summaryRole: "system"` ⇒ 拼进**最后一条** system 消息的 `content[0]`；
 *     没有 system 消息时在最前面补一条（`validateMessages` 允许 system 打头）。
 *   · 否则 ⇒ 拼进 head 里**第一条真实 user 消息**的 `content[0]`（`groupIntoRounds` 的 head
 *     定义就是「到第一条真实 user 为止」，所以它一定在 head 里，不会误伤保留轮次里的
 *     `tool_result` 消息）。
 *
 * 空摘要 ⇒ 原样返回（不造空块；与 #470-A2「不写占位字面量」同口径）。
 *
 * @param {object[]} messages
 * @param {string | undefined} summaryText
 * @param {"user" | "system"} [summaryRole]
 * @returns {object[]}
 */
export function prependFoldSummary(messages, summaryText, summaryRole = "user") {
  if (typeof summaryText !== "string" || summaryText.trim() === "") return messages;
  const list = Array.isArray(messages) ? messages : [];
  const block = { type: "text", text: summaryText };

  if (summaryRole === "system") {
    const systemIndex = list.findLastIndex((message) => message?.role === "system");
    if (systemIndex < 0) {
      return [{ role: "system", content: [block] }, ...list];
    }
    const system = list[systemIndex];
    const content = typeof system.content === "string"
      ? [{ type: "text", text: system.content }]
      : Array.isArray(system.content) ? system.content : [];
    const updated = list.slice();
    updated[systemIndex] = { ...system, content: [block, ...content] };
    return updated;
  }

  const userIndex = list.findIndex((message) => isRealUser(message));
  if (userIndex < 0) return list;
  const user = list[userIndex];
  const content = typeof user.content === "string"
    ? [{ type: "text", text: user.content }]
    : Array.isArray(user.content) ? user.content : [];
  const updated = list.slice();
  updated[userIndex] = { ...user, content: [block, ...content] };
  return updated;
}
