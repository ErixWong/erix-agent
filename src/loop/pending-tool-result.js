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
 * 与它应有的 `tool_result` 隔开 ⇒ **本库自己的消息校验器**在任何请求发出**之前**就本地抛
 * `invalid_messages`
 * （`assistant tool_use has no immediately following user tool_result`）拒掉整份历史，宿主拿到
 * `termination: failed`，终稿丢失。缺口不在判据、不在构造器，而在「只有一个结清点」。
 * 归因（2026-10-22 实测更正，别写回「provider 拒」）：那次失败**零 HTTP**，栈落在
 * `src/messages/rounds.js#validateMessages`；规矩按本库说的两协议里**最严的那一档**立
 * （Anthropic 形状对这个形状回 400），而实跑的 OpenAI 兼容中转会回 **200** 并让模型**自己编**一个结局。
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
import { blocksFor } from "./block-helpers.js";
import { mergeToolResultsIntoAssistantNextMessage } from "./messages.js";

/**
 * 尾部悬空 `tool_use` 的**读侧**入口（issue #404）：内容就是 `pendingTrailingToolUses` 那一份，
 * 这里只是把它挂到共享实现的出口上。为什么需要这一层：`src/` 里**除本文件外**不许再引用判据符号
 * （`test/loop-pending-tool-result.test.js` 的结构判据钉着——任何别处再写一遍配对逻辑就是下一个
 * #394），而恢复路径也要读一眼尾部形状（告示里要列「哪些调用没结果」）。
 *
 * 只读、不结清、不碰 `messages`：结清仍然只有 `answerPendingTailToolUses` 一条路。
 *
 * @param {any[]} messages
 * @returns {object[]} 末条 assistant 消息里的 `tool_use` 块（可能为空数组）
 */
export function pendingTailToolUses(messages) {
  return pendingTrailingToolUses(messages);
}

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

// ── issue #421：**中段**悬空 `tool_use` 的读侧兜底 ────────────────────────────────────────────
//
// 病根（宿主 erix-station 真机撞过两次，第 25 / 56 轮）：一条 assistant 消息里的 `tool_use` 必须由
// **紧接其后**的那条 user 消息（引擎叫「聚合消息」）以 `tool_result` 结清，且 id 集合必须**一模一样**
// （`src/messages/rounds.js#validateMessages`）。违反 ⇒ 本地 `KitError("invalid_messages")`、**0 次
// HTTP**、run 直接 `failed`，而且这个 runId **永久起不来**（账本里那个形状不会自己变）。
// 写侧（A 集合入账 #414/#420/#424/#430）与**尾部**悬空（`answerPendingTailToolUses` #394）都修过了，
// 缺的正是「**中段**（非尾部）悬空、账本里也没有任何一行结清过它」这一格。
//
// 本函数做的事：给每个这样的 `tool_use` 补一张「这次调用的结果没有落盘」的 `tool_result`，**并进它所属
// 那条 assistant 紧接的下一条 user 消息**（同页合并，不插页），并把桩交给调用方入账。
// 效果：`invalid_messages` 从**不可恢复**降级成**可见的丢失**（模型看得见「这次调用的结果没了」，
// 可以重发调用；宿主/judge/审计凭 `[erix]` marker 一眼认出这不是工具输出）。
//
// 五条纪律（改这里之前先读）：
//   ① **判据不另写一套**：入口就是本文件的 `pendingMidSequenceToolUses`，配对口径与
//      `validateMessages` 同源（`tool_use` 的 id 必须出现在紧跟的那条 user 消息的 `tool_result` 里）。
//      任何别处再写一遍配对就是下一个 #394。
//   ② **判据逐对，与 `validateMessages` 同粒度**（issue #730 收窄）：一条 `tool_use` 结没结清，只看
//      **它自己那一对**——紧接的那条聚合消息里有没有同 id 的 `tool_result`（`missing` 算的就是它）。
//      这里以前并的是**全 run** 的账本 id 集合（调用方交进来的 `settledIds`），于是「别的轮结清过同一个
//      id」会被当成这一对也结清了：provider 的 `tool_use_id` 不保证 run 内唯一（issue #284 实测过 id
//      复用），那种现场补不出桩 ⇒ 每轮请求出网前被本地校验器拒掉，而这个 runId 永久起不来。幂等不受
//      影响：桩落的那一页**就是**这条聚合消息（`mergeToolResultsIntoAssistantNextMessage` 只改它），
//      下一次恢复时这一对已带着它 ⇒ 判据自己不再返回它。调用方现在经 `pendingResultIds` 只交
//      「**本进程马上会产出真结果**」那两批 id（A 集合 + B 集合），它们与「哪一对」无关 ⇒ 一律不补桩。
//   ③ **结果块只由 `buildToolResultFact` 构造**（全仓唯一构造点），正文是本文件自己的常量
//      `UNPERSISTED_TOOL_RESULT_TEXT` —— **不复用** `PENDING_TOOL_RESULT_TEXT`：那句说的是「从未执行」，
//      这里说的是「执行过、结果没落盘」，两件事不能共用一句话。
//   ④ **只做同页合并**：紧接的那条 user 消息必须**已经有** `tool_result`（形状 1/2/3）。相邻的
//      assistant 各带一单（需要在两条 assistant 之间**插页**）是**非目标**，本函数返回空、不发明形状。
//   ⑤ **不掩盖真错误**：能配上对的不得出现桩行；`id` 读不出来的畸形块**不补**（沿用
//      `isUsableToolUseId` 那一格，不发明第三种兜底）——让今天那条 `invalid_messages` 继续如实报。

/**
 * 「结果**没有落盘**」的桩正文（与 `PENDING_TOOL_RESULT_TEXT` 的语义不同，别合并成一句）。
 *
 * 那条调用**跑过**（工具真的执行了、副作用可能已经发生），但它的 `tool_result` 从没进账本 —— 引擎无法
 * 凭账本复述结果，于是只能把「结果丢了」这件事实如实说给模型听。开头的 `[erix]` 是 marker（引擎自写，
 * 不是工具输出），与尾部那句同一个约定。导出只为让测试断言这一份唯一来源，不属公开契约面。
 */
export const UNPERSISTED_TOOL_RESULT_TEXT = "[erix] The result of this tool call is not available: "
  + "the call was made, but its tool_result was never persisted to the transcript ledger, so the "
  + "engine cannot replay it. Treat the outcome as unknown (it may have had side effects) and "
  + "re-issue the call if the task still needs it.";

// ── issue #730：「引擎放弃了这一格」的**成因名**（宿主可读面，中英契约逐条对齐）───────────────
//
// 它们都贴在既有事件 `resume_journal_skipped`（#743 分级表里的 `fact`，不可删）上：本单**不新增
// 事件类型**，只把原来只在「锚点缺失」那一格发的 `reason` 补全（新 `reason` + `detail` 细分）。
// 守卫：`test/loop-resume-abandon-signals-730.test.js`（源码 ↔ 中英两份契约，两个方向都判）。

/** 普查判它缺结果，而同页合并自己拒了（那条聚合消息里已有不属于这一单的 `tool_result`）。 */
export const MID_SEQUENCE_ABANDON_MERGE_REFUSED = "mid_sequence_merge_refused";
/** 悬空是真的悬空，但形状不是同页合并那一种（需要插页）——具体哪一种是 `detail` 说的。 */
export const MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED = "mid_sequence_shape_not_supported";
/** 有锚点、该落账，但写侧返回 `undefined`（轮号不是安全整数 / 写被跳过）——在 orchestrator 那一侧发。 */
export const MID_SEQUENCE_ABANDON_ROW_WRITE_REFUSED = "mid_sequence_stub_row_write_refused";

/** `mid_sequence_shape_not_supported`：紧接的那条消息不是 `user`（相邻两条 assistant）。 */
export const MID_SEQUENCE_ABANDON_DETAIL_NEXT_NOT_USER = "next_message_is_not_user";
/** `mid_sequence_shape_not_supported`：紧接的 user 一条 `tool_result` 都没有（需要插页）。 */
export const MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT = "aggregate_has_no_tool_result";
/** `mid_sequence_merge_refused`：聚合消息里混进了别的单的结果 id。 */
export const MID_SEQUENCE_ABANDON_DETAIL_FOREIGN_IDS = "aggregate_carries_foreign_result_ids";

// 同一个通道上那两条既有成因的 `detail`（issue #730：`mid_sequence_aggregate_row_not_in_ledger`
// 原来混着**两件不同的事**——「账本里真没有那一行」与「宿主没给 `loadRawRows` 探针」，而后者
// 是「宿主补上探针就能闭合」那一格，只读 reason 分不出来）。

/** `mid_sequence_aggregate_row_not_in_ledger`：store 没提供 `loadRawRows` ⇒ 只能在折叠后的行上找。 */
export const RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT = "anchor_probe_absent";
/** `mid_sequence_aggregate_row_not_in_ledger`：该轮载体已带正文（#729）⇒ 有行也不给用。 */
export const RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY = "round_carrier_has_body";
/** `mid_sequence_aggregate_row_not_in_ledger`：探针给了、轮也干净，账本里确实没有那条首片行。 */
export const RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER = "aggregate_row_not_in_ledger";
/** `mid_sequence_stub_row_write_refused`：桩所属轮的轮号不是安全整数 ⇒ 写侧直接退回去。 */
export const RESUME_JOURNAL_SKIP_DETAIL_ROUND_NOT_SAFE_INTEGER = "round_not_safe_integer";
/** `mid_sequence_stub_row_write_refused`：轮号合法，但 `appendRound` 这一写被返回 `false`。 */
export const RESUME_JOURNAL_SKIP_DETAIL_APPEND_SKIPPED = "append_row_not_persisted";

/**
 * 「普查」那一份实现（issue #730）：一趟扫描同时分出两类，**配对判据只有这一份**（纪律 ①）：
 *   · `answerable` = 可同页合并的那些组（`pendingMidSequenceToolUses` 的逐字返回值）；
 *   · `unanswerable` = 确实悬空、但形状不是同页合并那一种（紧接的不是 user / 紧接的 user 一条
 *     `tool_result` 都没有）。修前它们从不出现在任何返回值里 ⇒ 引擎放弃了这一格而无人知道。
 *
 * @param {any[]} messages
 * @returns {{answerable: Array<{assistantIndex: number, resultIndex: number, missing: object[]}>,
 *            unanswerable: Array<{assistantIndex: number, detail: string, unsettled: object[]}>}}
 */
function scanMidSequence(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const answerable = [];
  const unanswerable = [];
  for (let index = 0; index < list.length - 1; index += 1) {
    const assistant = list[index];
    if (assistant?.role !== "assistant") continue;
    const uses = blocksFor(assistant.content).filter((block) => block?.type === "tool_use");
    if (uses.length === 0) continue;
    const next = list[index + 1];
    if (next?.role !== "user") {
      // 相邻两条 assistant（要在那两条之间**插页**）——非目标形状，但今天它同样让整份历史被拒。
      unanswerable.push({ assistantIndex: index, detail: MID_SEQUENCE_ABANDON_DETAIL_NEXT_NOT_USER, unsettled: uses });
      continue;
    }
    const results = blocksFor(next.content).filter((block) => block?.type === "tool_result");
    // 一条结果都没有 ⇒ 需要**插页**（非目标）；`validateMessages` 会以另一句如实报错。
    if (results.length === 0) {
      unanswerable.push({
        assistantIndex: index,
        detail: MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
        unsettled: uses,
      });
      continue;
    }
    const settled = new Set(results.map((block) => block?.tool_use_id));
    const missing = uses.filter((block) => !settled.has(block.id));
    if (missing.length === 0) continue;
    answerable.push({ assistantIndex: index, resultIndex: index + 1, missing });
  }
  return { answerable, unanswerable };
}

/**
 * **中段**悬空 `tool_use` 的读侧判据（issue #421）：返回「紧跟的那条 user 消息没结清它」的每一组。
 *
 * 只认**同页合并**这一支（纪律 ④）：assistant 的下一条必须是一条**已经有 `tool_result`** 的 user
 * 消息，缺的 id 才补得进去。下一条不是 user / 没有任何 `tool_result`（那需要在中间插一条消息）⇒
 * 本函数不返回它，交由 `validateMessages` 如实报错（而 issue #730 之后它不再是**无声**的：那一格在
 * `scanMidSequence().unanswerable` 里，由 `answerPendingMidSequenceToolUses` 经 `onAbandon` 报出）。
 *
 * 只读、不结清、不碰 `messages`。
 *
 * @param {any[]} messages canonical 消息数组
 * @returns {Array<{assistantIndex: number, resultIndex: number, missing: object[]}>}
 *   `missing` = 该 assistant 里「紧跟的 user 消息没有对应 `tool_result`」的 `tool_use` 块
 */
export function pendingMidSequenceToolUses(messages) {
  return scanMidSequence(messages).answerable;
}

/**
 * 结清**中段**悬空 `tool_use`（issue #421）：把每个缺失的结果桩**并进**它所属 assistant 紧接的那条
 * user 消息，并把「补了哪几张桩、该往账本哪一行写」交给调用方。
 *
 * 幂等：合并之后再调一次，`pendingMidSequenceToolUses` 返回空（那条 user 消息现在带着桩），
 * 所以本函数可以在恢复路径上无条件调用。账本侧的幂等**同样**由这条逐对讲据保证：桩落账后折回来就在
 * 那条聚合消息里（issue #730 之前靠调用方交进来的全 run id 集合，见纪律 ②）。
 *
 * @param {any[]} messages canonical 消息数组（就地合并，消息对象身份不变 ⇒ 轮号表仍然查得到）
 * @param {{
 *   pendingResultIds?: Set<any>,
 *   onStub?: (entry: {toolResult: object, target: object, round: any, partOf: any}, context: {assistantIndex: number}) => any,
 *   onAbandon?: (entry: {reason: string, detail: string|undefined, round: any, toolUseIds: any[], assistantIndex: number}) => any,
 *   roundOf?: (message: any) => any,
 *   anchorOf?: (message: any) => any,
 * }} [options]
 *   `pendingResultIds` = **本进程马上会产出真结果**的 `tool_use` id（A 集合：结果已成型、只差入账；
 *   B 集合：补跑段会重跑）——与「哪一对」无关，一律不补桩（#421 的排除集）；
 *   `onStub` = 入账回调（本模块不持有 store、不碰 persist——账本写入一直是调用方的职责面），
 *   参数带 `partOf`（= 那条聚合消息**首片**行的 key，`undefined` = 账本里找不到可接的锚点）；
 *   `onAbandon` = **放弃这一格**的回调（issue #730：普查判它悬空，而引擎补不出合法桩）。本模块只
 *   交出事实，发事件归调用方（事件面一直在 orchestrator）；
 *   `roundOf` / `anchorOf` 由调用方提供：本模块不认识轮号表，也不认识落盘行。
 * @returns {Promise<Array<{toolResult: object, target: object, round: any, partOf: any}>>}
 *   本次真的补进去的桩（空数组 = 没有可补的，或补不出合法结果）
 */
export async function answerPendingMidSequenceToolUses(messages, options = {}) {
  const census = scanMidSequence(messages);
  if (census.answerable.length === 0 && census.unanswerable.length === 0) return [];
  const { pendingResultIds, onStub, onAbandon, roundOf, anchorOf } = options;
  const inFlight = pendingResultIds instanceof Set ? pendingResultIds : undefined;
  const added = [];
  // issue #730 第 3 格：「非目标形状」那一格今天一声不响（紧接的不是 user / 紧接的 user 一条结果
  // 都没有 ⇒ 需要插页）。它们同样让整份历史在出网前被本地校验器拒掉、0 次 HTTP，而宿主读不出是
  // 哪一格被放弃。畸形 id 那一格仍然不报（纪律 ⑤：不掩盖真错误）。
  for (const group of census.unanswerable) {
    const abandoned = group.unsettled.filter((block) => isUsableToolUseId(block)
      && !(inFlight !== undefined && inFlight.has(block.id)));
    if (abandoned.length === 0) continue;
    if (typeof onAbandon === "function") {
      await onAbandon({
        reason: MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
        detail: group.detail,
        round: typeof roundOf === "function" ? roundOf(messages[group.assistantIndex]) : undefined,
        toolUseIds: abandoned.map((block) => block.id),
        assistantIndex: group.assistantIndex,
      });
    }
  }
  for (const group of census.answerable) {
    // issue #730 第 1 格：**逐对**判结清——`group.missing` 已经是「这一对的聚合消息里没有该 id 的
    // 结果块」，全 run 的账本 id 集合不再参与排除（别的轮结清过同一个 id 不算这一对结清）。
    const usable = group.missing.filter((block) => isUsableToolUseId(block)
      && !(inFlight !== undefined && inFlight.has(block.id)));
    if (usable.length === 0) continue;
    const toolResults = usable.map((block) => buildToolResultFact({
      toolUseId: block.id,
      content: UNPERSISTED_TOOL_RESULT_TEXT,
      // 这次调用**跑过**、但结果没落盘：wire 上「没产出可用结果」的唯一出口就是 `is_error`
      // （与尾部结清、续跑复放的 `interrupted` 同一个口径）。**不写 `executionStatus`**：
      // 那是闭集 `intercepted / interrupted / rejected`（`src/tool-fact.js#TOOL_RESULT_CONTRACT`），
      // 为这一格新增第四个值要动中英两份契约 + `test/contract/tool-result-envelope.js`，另开单。
      isError: true,
    }));
    // 定位由调用方点名（`group.assistantIndex`），**不是**「从后往前找最后一条带 tool_use 的
    // assistant」（那是 `mergeToolResultsIntoMessages` 的尾部定位，中段场景会找错目标）。
    const merged = mergeToolResultsIntoAssistantNextMessage(messages, group.assistantIndex, toolResults);
    if (merged === false) {
      // issue #730 第 2 格：普查判它缺结果，而合并自己拒了（那条聚合消息里已有**不属于这一单**的
      // `tool_result` ⇒ 串味）。修前这里直接 `continue`：宿主只读到下一次请求前的 `invalid_messages`，
      // 0 次 HTTP，永远不知道是哪一格、哪几个 id 被放弃。
      if (typeof onAbandon === "function") {
        await onAbandon({
          reason: MID_SEQUENCE_ABANDON_MERGE_REFUSED,
          detail: MID_SEQUENCE_ABANDON_DETAIL_FOREIGN_IDS,
          round: typeof roundOf === "function" ? roundOf(messages[group.assistantIndex]) : undefined,
          toolUseIds: usable.map((block) => block.id),
          assistantIndex: group.assistantIndex,
        });
      }
      continue;
    }
    const target = messages[group.resultIndex];
    const round = typeof roundOf === "function" ? roundOf(target) : undefined;
    const partOf = typeof anchorOf === "function" ? anchorOf(target) : undefined;
    for (const toolResult of toolResults) {
      const entry = { toolResult, target, round, partOf };
      added.push(entry);
      if (typeof onStub === "function") await onStub(entry, { assistantIndex: group.assistantIndex });
    }
  }
  return added;
}
