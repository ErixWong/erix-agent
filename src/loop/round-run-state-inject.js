// @ts-check
// issue #872 验收（阻断修复）：同一轮内的第二次 run-state 注入观测**合并**器（纯函数、零依赖）。
//
// 为什么需要它：`compactBeforeRound` 一轮里会被调两次——轮首（`round_start` 之后那一处）与
// `max_tokens` 续写分支里各一次。两处都可能注入，而观测格 `runLoopState.roundRunStateInject`
// 原先是**直接赋值**：同一轮「先走通道 B、续写再走通道 A」时，圈底 `round_end` 只报最后一次，
// **漏报本轮实际用过的通道**。修法不是「取第一次」（同样漏），而是把两次观测**并起来**。
//
// 本模块只做一件事：给出一个可单测的纯合并函数。注入行为本身（阈值 / 内容 / 轮次 / 两条
// one-shot 门）一个字都不在这里——那仍住在 `orchestrator.js` 的注入决策点。

/**
 * 一轮内一次注入决策产出的观测（注入决策点交进来的形状，`injections` 由本函数维护、调用方不填）。
 *
 * @typedef {{
 *   lowBudget: boolean,
 *   request: boolean,
 *   persist: boolean,
 *   remainingRounds: number,
 *   injections?: number,
 * }} RoundRunStateInjectObservation
 */

/**
 * 合并「本轮已有的注入观测」与「本次注入的观测」。
 *
 * 规则（与验收一致）：
 *   · 布尔三键 `lowBudget` / `request` / `persist` 取 **OR**——本轮只要用过某条通道就记 true，
 *     所以它们是「本轮用过的并集」，不是「最后一次」。
 *   · `injections`：本轮注入发生的次数（当前只会是 1 或 2，未来更多也对）。`prev` 已带累计值，
 *     本次在其基础上 +1；`prev` 缺席（本轮第一次）时记 1。
 *   · `remainingRounds`：同轮内 `effectiveMaxRounds - budgetRounds` 恒定，取最新值即可——理由见下面
 *     返回处注释。
 *
 * 约定：`prev === undefined` ⇒ 返回 `next` 加 `injections: 1`。**两侧都 `undefined` 的调用不该发生**
 * （注入决策点在 `persistInject || requestInject` 为真的分支里调用，`next` 必是具体观测），下面显式
 * 抛错把这条契约钉死，而不是静默返回一个说不清形状的值。
 *
 * @param {RoundRunStateInjectObservation | undefined} prev 本轮已合并的观测；`undefined` = 本轮第一次注入
 * @param {RoundRunStateInjectObservation} next 本次注入决策的观测（不含 `injections`）
 * @returns {RoundRunStateInjectObservation & { injections: number }}
 */
export function mergeRoundRunStateInject(prev, next) {
  if (prev === undefined) {
    if (next === undefined) {
      // 断言：两侧都 undefined 的调用不该发生（调用点契约见函数头）。
      throw new Error("mergeRoundRunStateInject: prev 与 next 同时 undefined 的调用不该发生");
    }
    // 本轮第一次注入：以本次为准，注入次数记 1。
    return { ...next, injections: 1 };
  }
  // `remainingRounds = effectiveMaxRounds - budgetRounds`：`effectiveMaxRounds` 是本轮圈顶定下的
  // 轮次上限、`budgetRounds` 是本轮开始时的已用轮数；注入既不新增轮次预算、也不改已用轮数，
  // 所以**同一轮内两次注入算出的 remainingRounds 恒等** ⇒ 取最新值（next）即可，无需比较。
  return {
    lowBudget: prev.lowBudget || next.lowBudget,
    request: prev.request || next.request,
    persist: prev.persist || next.persist,
    remainingRounds: next.remainingRounds,
    injections: (prev.injections ?? 1) + 1,
  };
}

export default mergeRoundRunStateInject;
