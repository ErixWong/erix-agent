// @ts-check
/**
 * issue #394：把「结清尾部悬空 `tool_use`」提成**共享实现**（原 #393 的闭包，只活在
 * `src/loop/orchestrator.js` 里、只被 `applyGovernorExtension` 调用过）。
 *
 * 为什么必须提出来：引擎有**两个**往尾部注入 user 控制消息的注入点，而结清动作原先只有**一个**
 * 调用点（中途扩轮 / guard 补跑桥共用的那个闭包）：
 *   1. `src/loop/orchestrator.js#applyGovernorExtension`（中途扩轮 + guard 补跑桥）；
 *   2. `src/loop/termination.js#forceFinalIfNeeded`（强制收尾：【强制收尾】指令注入之前）；
 *   3. 兄弟洞：`src/loop/orchestrator.js` 的 stop 分支里 finalGuard 判 `revise` 那条续跑消息。
 * 2 与 3 都在 #394 之前**没有**结清动作，于是「尾部是 `assistant[tool_use]`」时注入把 `tool_use`
 * 与它应有的 `tool_result` 隔开 ⇒ provider 以 `invalid_messages`
 * （`assistant tool_use has no immediately following user tool_result`）拒掉整份历史，宿主拿到
 * `termination: failed`，终稿丢失。缺口不在判据、不在构造器，而在「只有一个结清点」。
 *
 * 三条纪律（本模块存在的全部理由，改它之前先读）：
 *   - **判据复用既有那一份**：`pendingTrailingToolUses`（`src/messages/rounds.js`，与
 *     `validateMessages` 的配对规则同源）。这里**不**另写一套配对逻辑——第二份判据就是下一个
 *     #394。
 *   - **结果块复用唯一构造点**：`buildToolResultFact`（`src/tool-fact.js`），`isError: true` 打在
 *     块上，正文用 `PENDING_TOOL_RESULT_TEXT`（以 `[erix]` marker 开头）。全仓「造 `is_error`
 *     收尾 `tool_result`」的构造点只有这一处，由 `test/loop-pending-tool-result.test.js` 的
 *     结构判据钉住。
 *   - **入账走 `:control:` 行**（由调用方经 `onMessage` 注入，本模块不碰 store）：**不能**改成
 *     `kind:"message"` 消息行——消息行会被 `foldMessageRows` 折回轮载体行，恢复时插到注入的
 *     控制文本之前，把配对重新打散（#393 的结论）。
 */

import { pendingTrailingToolUses } from "../messages/rounds.js";
import { buildToolResultFact } from "../tool-fact.js";

/**
 * 给「末轮那条**未执行**的 `tool_use`」补的 `tool_result` 正文。
 *
 * 这是引擎自写的**事实陈述**，不是任何工具的输出：那条调用真的没跑（预算掐停 / 强制收尾期间
 * 模型仍回了工具调用），所以下一轮模型可以重新发起。开头的 `[erix]` 是 marker —— 宿主、judge、
 * 审计凭它一眼认出「引擎自写」，不会把这句话当成工具结果。导出只为让测试断言这一份唯一来源，
 * 不属公开契约面（`src/index.js` 不转出）。
 */
export const PENDING_TOOL_RESULT_TEXT = "[erix] This tool call was never executed: the loop stopped "
  + "before it could run (budget-type stop or forced wrap-up), so no result exists for it. "
  + "Re-issue the call if the task still needs it.";

/**
 * `tool_use` 的 id 能不能补出一条**合法**的 `tool_result`（#393 的退路 B 的判据，单点）。
 *
 * canonical 的配对要求（`src/messages/rounds.js#validateMessages`）是「`tool_use` 的 id 必须是非空
 * 字符串」，所以连 id 都读不出来的畸形尾巴补不出合法结果 —— 这一格**不结清**，让今天那条
 * `invalid_messages` 继续如实报（不在这一层发明第三种兜底）。
 *
 * @param {any} block
 * @returns {boolean}
 */
function isUsableToolUseId(block) {
  return typeof block?.id === "string" && block.id !== "";
}

/**
 * 尾部悬空 `tool_use` 是否**补得出**合法的 `tool_result`（`#393` 退路 B 的判据）。
 *
 * 「尾部没有悬空 `tool_use`」也算 answerable（空数组的 `every` 为真）：调用方问的是「能不能继续
 * 往尾部注入 user 消息」，没有悬空块时答案当然是能。`extendAfterGuard` 用的就是这一条。
 *
 * @param {any[]} messages
 * @returns {boolean}
 */
export function pendingTailToolUsesAreAnswerable(messages) {
  return pendingTrailingToolUses(messages).every(isUsableToolUseId);
}

/**
 * 结清尾部悬空 `tool_use`：往 `messages` 尾部追加**一条** user 消息，装齐全部缺失的 `tool_result`。
 *
 * 幂等判据是「尾部形状」本身（结清之后再调一次返回 `false`）：调用方可以在任何注入点之前无条件
 * 调它，不必自己判断尾部。
 *
 * @param {any[]} messages canonical 消息数组（就地追加）
 * @param {{round?: number, messageRounds?: Map<any, any> | WeakMap<any, any>, onMessage?: (message: any, round?: number) => any}} [options]
 *   `messageRounds` 与主循环同一份口径（轮号表——主循环用的是 `WeakMap`，termination 侧原样转交）；`onMessage` 是**入账回调**，由 orchestrator 注入
 *   （本模块不持有 store、不碰 persist —— journal 写入一直是 orchestrator 的职责面）。
 * @returns {Promise<boolean>} true = 真的补了一条 user 消息；false = 尾部没有可结清的悬空块
 *   （含「畸形尾巴补不出合法结果」那一格）
 */
export async function answerPendingTailToolUses(messages, options = {}) {
  const pending = pendingTrailingToolUses(messages);
  if (pending.length === 0) return false;
  if (!pending.every(isUsableToolUseId)) return false;
  const toolResults = pending.map((block) => buildToolResultFact({
    toolUseId: block.id,
    content: PENDING_TOOL_RESULT_TEXT,
    // 这条调用确实没有结果（不是成功，也不是工具自己报的错）：`is_error` 是 wire 上
    // 「这次调用没产出可用结果」的唯一出口，与续跑复放写 `interrupted` 的口径一致。
    isError: true,
  }));
  const message = { role: "user", content: toolResults };
  messages.push(message);
  const { round, messageRounds, onMessage } = options;
  if (messageRounds !== undefined && round !== undefined) messageRounds.set(message, round);
  if (typeof onMessage === "function") await onMessage(message, round);
  return true;
}
