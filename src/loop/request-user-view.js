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
//      ⚠ 「user 轮」不包含引擎注入的续接块（`src/loop/continuity-block.js`，issue #589）：
//      块是状态快照，不是用户查询，复制它会把「上一版状态」当成新消息贴进持久列表。
//   3) 源里也没有可留的 user 轮 → 放弃本次折叠/压缩，改用未折叠视图；
//   4) 连未折叠视图都留不出合法视图 → 原样返回，并把 `unrecoverable`（连同子原因 `reason`）
//      记进统计。这一格**不重新过一遍** `validateMessages`（刻意跳过，理由就地写在下面那一格
//      上方）；它对外的信号是 `user_turn_guard_unrecoverable` 事件（issue #296：在那之前这一格
//      对外零信号，宿主只能看到一个没有 user 轮的请求被上游 400）。
// 前 3 步每一步都用 `validateMessages(..., { allowPendingToolUse: false })` 验一遍，
// 保证回补出来的视图不产生孤儿 tool_result / 缺结果的 tool_use；第 4 步按上面的理由**不重验**。

/**
 * @typedef {import("../messages/canonical.js").CanonicalMessage} CanonicalMessage
 */

import { validateMessages } from "../messages/rounds.js";
import { isContinuityMessage } from "./continuity-block.js";

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
 * **复制格不复制续接块**（issue #589 第二部分，根因）。
 *
 * 这个函数存在的理由只有一个：上游（OpenAI 兼容 relay）对「没有 user 轮的 messages」回
 * `400 No user query found in messages`（#292）—— 所以要回补的是一条**用户查询**。续接块
 * （`src/loop/continuity-block.js`）虽然 `role: "user"`，却是**引擎注入的状态快照**，不是用户
 * 说过的任何话：
 *   · 把它复制回来，等于把「上一版状态」当成新消息贴进持久列表 —— 读者分不清它是历史事实
 *     还是当前状态的旧快照（#564/#589 的病），而且下一轮 `upsertContinuityInMessages` 还得
 *     把它收口（#568 的「至多一条」就是这么来的：**收口在治症状，根因在这里**）；
 *   · 真正的用户查询在源视图里就在它前面（块固定在尾部），选那条既满足不变量、又是**真内容**。
 *
 * 不变量不会因此变弱：若源视图里除了块再没有别的 user 轮，下面的 `latestUserRound` 返回
 * `undefined`，`ensureUserTurnView` 退到既有的第 3 步 `abandoned_fold`（原样返回源视图，块跟着
 * 一起回来）—— 那一步本来就在，判据是 `isPassableview`（块作为 user 消息在那里是合法的）。
 *
 * @param {CanonicalMessage[]} messages
 * @returns {CanonicalMessage[]|undefined}
 */
export function latestUserRound(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const index = source.findLastIndex((message) => (
    isRealUserTurn(message) && !isContinuityMessage(message)
  ));
  if (index < 0) return undefined;
  const user = source[index];
  const previous = source[index - 1];
  if (hasBlock(user, "tool_result") && previous?.role === "assistant" && hasBlock(previous, "tool_use")) {
    return [copyMessage(previous), copyMessage(user)];
  }
  return [copyMessage(user)];
}

function passesValidate(messages, allowPendingToolUse) {
  try {
    validateMessages(messages, { allowPendingToolUse });
    return true;
  } catch {
    return false;
  }
}

/**
 * 「原样放行」那一格用的判据：**容忍尾部 pending `tool_use`**（评审 R1）。
 *
 * `max_tokens` 续写（`orchestrator.js` 里唯一以 `allowPendingToolUse: true` 调 provider 的那处）与
 * 「尾部是 pending tool_use 的续跑」送进来的视图本来就合法，只是最后一条 assistant 的 `tool_use`
 * 还没有结果。按 `false` 判会把它误判成非法，进而摘掉尾巴 + 追加一条**复制的** user 轮
 * （复现探针：`user:text, assistant:tool_use` ⇒ `user:text, user:text`）。这与极小预算无关。
 *
 * @param {CanonicalMessage[]} messages
 * @returns {boolean}
 */
function isPassableview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (!hasUserTurn(messages)) return false;
  return passesValidate(messages, true);
}

/**
 * 「要追加一条纯文本 user 轮」的候选分支用的判据：**不容忍 pending `tool_use`**。
 * 追加前必须先摘掉尾部悬空的 tool_use（`withoutTrailingPendingToolUse`），这正是它存在的理由；
 * 这里放宽就会把悬空的 tool_use 与后补的 user 轮同时留在视图里，配对直接非法。
 *
 * @param {CanonicalMessage[]} messages
 * @returns {boolean}
 */
function isLegalView(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (!hasUserTurn(messages)) return false;
  return passesValidate(messages, false);
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
 * @param {{ action?: string, reason?: string }} [stats] 出参：守卫动作（可观测信号）；
 *   `reason` 只在 `action === "unrecoverable"` 时写，是第 4 格的子原因（issue #296）
 * @returns {CanonicalMessage[]}
 */
export function ensureUserTurnView(view, source, stats = {}) {
  const current = Array.isArray(view) ? view : [];
  // 原样放行按「容忍尾部 pending tool_use」判（见 isPassableview 的注释）；
  // 放行时不写 stats.action——守卫什么都没做，就不该留下可观测信号。
  if (isPassableview(current)) return current;

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

  // 放弃折叠这一格是**原样返回源视图**（不追加任何东西），所以它和放行那一格一样
  // 容忍尾部 pending tool_use：按 false 判只会让本来能用的源视图被拒掉，一路掉进
  // unrecoverable，把「有源可用」误报成「无药可救」。
  if (isPassableview(fallbackSource)) {
    stats.action = "abandoned_fold";
    return fallbackSource.map((message) => copyMessage(message));
  }

  // 第 4 格：**原样返回**，并把「这一格为什么没救」写成 `reason` 交给调用方上报（issue #296）。
  //
  // ⚠ #296 刻意跳过（不是漏了）：这一格**不重新过一遍** `validateMessages`。理由是它拿到的视图
  // 刚刚**就是**被 `isPassableview` 拒掉的那一个，而 `isPassableview` 内部已经跑过
  // `validateMessages(..., { allowPendingToolUse: true })`——再验一遍只会得到同一个必然抛错，
  // 没有一条信息是新的。真要在这里抛，等于把「上游可能照收（宽松 relay / 只吃 assistant 历史的
  // 宿主）」变成「引擎必失败」，那是行为回退，不是修复：这一格能做的最后一件事就是**如实上报**
  // （`provider-runner.js` 把它转成 `user_turn_guard_unrecoverable` 事件），而不是假装修好了、
  // 也不是替宿主决定「这个 run 必须死」。
  // 「跳过是有意的」这件事由 `test/loop-296-user-turn-unrecoverable.test.js` 的 T2 / T2b 钉住：
  // 该格既不抛、也不改视图，且必须带上 `reason`——删掉理由注释、删掉上报、或在这里补一条
  // `validateMessages`，都会变红（三种变异的实测见该单交付报告）。
  stats.action = "unrecoverable";
  stats.reason = unrecoverableReason(current);
  return current;
}

/**
 * 第 4 格的**子原因**：让宿主能从事件里分清「视图空了」「视图没有 user 轮」「视图配对非法」，
 * 而不是只知道「不可恢复」四个字。三格互斥且穷尽：`isPassableview` 为假就只有这三条。
 *
 * @param {CanonicalMessage[]} view
 * @returns {"empty_view"|"no_user_turn"|"invalid_view"}
 */
function unrecoverableReason(view) {
  if (!Array.isArray(view) || view.length === 0) return "empty_view";
  if (!hasUserTurn(view)) return "no_user_turn";
  return "invalid_view";
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
