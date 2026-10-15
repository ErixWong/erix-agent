// @ts-check
// issue #292：发给上游的请求视图不得丢掉「user 轮」。
//
// 真上游（OpenAI 兼容 relay）对没有 user 轮的 messages 直接回 400 invalid_request
// 「No user query found in messages」，整个 run 变成 failed。极小 budgetTokens 下这是确定性的：
// 压缩阶段的 safety 层（`safeTruncateMessages` 的逐条删除循环）从头删未保护的消息，
// 预算小到连一条消息都装不下时，会把唯一的 user 轮（甚至整个列表）一起删空；
// TTL 折叠与以后任何新增折叠层同样可能在**请求视图**上抹掉 user 轮。
//
// 因此不变量的执行点不是某个压缩策略内部（那只能管住它自己那一层），而是
// 「视图定稿处」：请求视图组装完成、即将交给 chat / chatStream 的那一刻
// （`src/loop/provider-runner.js`，两条通道共用同一个 request 对象），
// 外加压缩结果写回持久消息列表的那一处（`src/loop/orchestrator.js`）——
// 后者是前者的前提：若持久列表本身已经没有 user 轮，请求视图就没有可回补的源。
//
// 退让顺序（工单 I2）：
//   1) 视图本来就合规 → 原样返回（健康预算下零行为变化，不许「预算小就不压缩」）；
//   2) 不合规 → 从**未折叠 / 未压缩的源视图**里保底保留**最新**一条 user 轮
//      （连同它必需的 assistant 配对），拼在原视图尾部；拼不上就单独保留这一轮；
//   3) 源里也没有可留的 user 轮 → 放弃本次折叠/压缩，改用未折叠视图；
//   4) 连未折叠视图都留不出合法视图 → 原样返回，并把 `unrecoverable` 记进统计。
// 每一步都用 `validateMessages(..., { allowPendingToolUse: false })` 验一遍，
// 保证回补出来的视图不产生孤儿 tool_result / 缺结果的 tool_use。

/**
 * @typedef {import("../messages/canonical.js").CanonicalMessage} CanonicalMessage
 */

import { validateMessages } from "../messages/rounds.js";

function blocksFor(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

function hasBlock(message, type) {
  return blocksFor(message).some((block) => block?.type === type);
}

/**
 * 「真 user 轮」：role 为 user 且不是纯 tool_result 载体。
 * 纯 tool_result 的 user 消息在 OpenAI 协议里被转换成 role:"tool"，
 * 上游据此判定「没有 user query」，所以它不满足不变量。
 *
 * @param {CanonicalMessage|undefined} message
 * @returns {boolean}
 */
export function isRealUserTurn(message) {
  if (message?.role !== "user") return false;
  return typeof message.content === "string"
    || blocksFor(message).length === 0
    || blocksFor(message).some((block) => block?.type !== "tool_result");
}

/**
 * @param {CanonicalMessage[]} messages
 * @returns {boolean}
 */
export function hasUserTurn(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => isRealUserTurn(message));
}

/**
 * 复制一条消息（含块），避免回补视图与源视图共享对象。
 *
 * @param {CanonicalMessage} message
 * @returns {CanonicalMessage}
 */
function copyMessage(message) {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
  };
}

/**
 * 源视图里**最新**的一条 user 轮（连同它必需的 assistant 配对）。
 *
 * @param {CanonicalMessage[]} messages
 * @returns {CanonicalMessage[]|undefined}
 */
export function latestUserRound(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const index = source.findLastIndex((message) => isRealUserTurn(message));
  if (index < 0) return undefined;
  const user = source[index];
  const previous = source[index - 1];
  if (hasBlock(user, "tool_result") && previous?.role === "assistant" && hasBlock(previous, "tool_use")) {
    return [copyMessage(previous), copyMessage(user)];
  }
  return [copyMessage(user)];
}

/**
 * @param {CanonicalMessage[]} messages
 * @returns {boolean}
 */
function isLegalView(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (!hasUserTurn(messages)) return false;
  try {
    validateMessages(messages, { allowPendingToolUse: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * 丢掉尾部「带 tool_use 却没有结果」的 assistant 尾巴——追加一条纯文本 user 轮会让它悬空。
 *
 * @param {CanonicalMessage[]} messages
 * @returns {CanonicalMessage[]}
 */
function withoutTrailingPendingToolUse(messages) {
  const result = messages.map((message) => copyMessage(message));
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last?.role === "assistant" && hasBlock(last, "tool_use")) {
      result.pop();
      continue;
    }
    break;
  }
  return result;
}

/**
 * I1 不变量：视图非空且至少一条真 user 轮。违反时按 I2 的退让顺序修复。
 *
 * @param {CanonicalMessage[]} view 即将发给上游（或写回持久列表）的视图
 * @param {CanonicalMessage[]} source 未折叠 / 未压缩的源视图（回补来源）
 * @param {{ action?: string }} [stats] 出参：守卫动作（可观测信号）
 * @returns {CanonicalMessage[]}
 */
export function ensureUserTurnView(view, source, stats = {}) {
  const current = Array.isArray(view) ? view : [];
  if (isLegalView(current)) return current;

  const fallbackSource = Array.isArray(source) ? source : [];
  const round = latestUserRound(fallbackSource);
  if (round !== undefined) {
    const candidates = [
      withoutTrailingPendingToolUse(current).concat(round),
      round,
    ];
    for (const candidate of candidates) {
      if (isLegalView(candidate)) {
        stats.action = "preserved_latest_user_turn";
        return candidate;
      }
    }
  }

  if (isLegalView(fallbackSource)) {
    stats.action = "abandoned_fold";
    return fallbackSource.map((message) => copyMessage(message));
  }

  stats.action = "unrecoverable";
  return current;
}

/**
 * 守卫是否真的改了视图（`unrecoverable` 不改，不计入可观测信号）。
 *
 * @param {string|undefined} action
 * @returns {boolean}
 */
export function isUserTurnGuardAction(action) {
  return action === "preserved_latest_user_turn" || action === "abandoned_fold";
}
