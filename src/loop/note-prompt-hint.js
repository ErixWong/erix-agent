// @ts-check
// issue #746 —— 「归档/超限提示里那条取回指引」的证据门（#741 口径的推广）。
//
// 病根：#741 把「只有整族 `note_*` 在工具面上、且可见账本里有一条现在还能查的 `note_take` 写入」
// 这套口径只接到了两处（TTL 占位符、折叠替代物）。其余六处模型可见文本（聚合超限桩、run snapshot
// 归档桩、memory-loss 提醒，以及 `bin/` 的三处 CLI 提示）仍**无条件**命令模型「先用 note_list 查找，
// 再用 note_read 读取」——`--no-notes` / `ERIX_NO_NOTES=1` 下那些工具根本不在面上，那句话既指了一条
// 不存在的道路，又把「我不知道有没有记录」伪报成「有记录」。
//
// 本模块**只做措辞选择**，不引入任何笔记机制：判定全部复用 `tool-result-ttl.js`（#741 的证据原点），
// 于是「有没有笔记」这件事在仓库里只有一个口径、一份实现。方向是单向的：`tool-result-ttl.js` 只依赖
// `node:crypto` + `../tokens.js`，不反向 import 本模块，故不成环。
//
// ⚠ `bin/` 可以 import 本模块（`bin/` 是 validator/debugger，依赖方向 src ← bin 是 AGENTS.md §1
// 允许的那一侧）；反过来 `src/` 永远不许为了 `bin/` 的成立而 import `bin/`。
import {
  NOTE_RECALL_REASONS,
  NOTE_RECALL_TOOL_NAMES,
  resolveNoteRecall,
  retrievalCommandFor,
  unverifiedRecallClause,
} from "./tool-result-ttl.js";

/**
 * 有证据时那半句取回指引（模型可见文本）。逐字保留 0.31.0 的措辞：宿主与测试钉的都是这一句，
 * 改它 = 改模型看到的句子。
 */
export const NOTE_RECALL_CLAUSE = "先用 note_list 查找记录，再用 note_read 读取";

/** 证据门的出口（写进返回值只为了让测试能断言「走的是哪一格」，而不是整段原文比对）。 */
export const NOTE_HINT_GATES = Object.freeze({
  /** 工具面 + 账本两条都成立 ⇒ 给 note_* 指引。 */
  noteEvidence: "note-evidence",
  /**
   * 工具面成立、但**这一层根本拿不到账本** ⇒ 只能给条件式（「如本 run 写过笔记…」+ 重读退路）。
   * 这一格是为 #746 新加的，而它**不是**把 #741 放松：见 `noteRecallHint` 的注释——那一层里没有
   * 「有没有写入」这个事实可拿，硬套四格会把「不知道」伪报成「没写过」（与旧文伪报「有记录」同罪）。
   */
  notesAvailable: "notes-available",
  /** 拿不到证据（无笔记工具 / 无笔记写入 / 已撤销 / 无笔记证据）⇒ 只给重读。 */
  noEvidence: "no-evidence",
});

/**
 * 有笔记工具但拿不到账本时的条件式指引。
 *
 * 它与 `NOTE_RECALL_CLAUSE` 的分别是**有意的**：那一句是「先查再用」的动作指令，在有账本的层里
 * 它背后站着「确实有一条还能查的写入」这个事实；本格的处境是没有那个事实可拿，所以话必须停在
 * 「如果写过就查」，并同时给重读退路——既不承诺有记录，也不否认有记录。
 */
export const NOTE_CONDITIONAL_CLAUSE = "如本 run 写过笔记，先用 note_list 查找记录、再用 note_read 读取；没写过就只能重读源文件";

/**
 * 整族笔记工具在不在给定名单上。**名单本身不复制**：唯一真值是
 * `tool-result-ttl.js` 的 `NOTE_RECALL_TOOL_NAMES`（全有或全无的口径也住在那里）。
 *
 * @param {string[] | undefined} [noteTools] 本 run 工具面上的笔记工具名
 * @returns {boolean}
 */
export function hasNoteToolSurface(noteTools) {
  return Array.isArray(noteTools)
    && NOTE_RECALL_TOOL_NAMES.every((name) => noteTools.includes(name));
}

/**
 * 无证据那半句的重读指引。**不含任何 `note_*`**（判据：不许指挥模型去调一个不在场上的工具）。
 * 「改用只读方式复核」保留：聚合桩修的只有「有没有记录」，反幻觉与副作用约束一个字不放松。
 *
 * @param {string | undefined} command `retrievalCommandFor` 真给出的那条命令；没有就是 undefined
 * @returns {string}
 */
export function rereadClause(command) {
  return command === undefined
    ? "请重读源文件或改用只读方式复核"
    : `请重读源文件，或直接执行：${command}`;
}

/**
 * 同一句话的**短版**（issue #746）：语义与 `clause` 同（无证据 ⇒ 重读 + 不伪报有记录），但砍掉 #741
 * 那句完整原因。用在两个**受 `budgetTokens` 预算约束的受保护消息**里（折叠桩、折叠恢复提示）：
 * 那里多出的几十字会直接把 run 顶到 `invalid_budget`（memento S1/S2 实测过）。完整原因在 #741 的
 * TTL 占位符里已经有，不在这两处重复。
 *
 * @param {string | undefined} command
 * @returns {string}
 */
export function rereadClauseShort(command) {
  return command === undefined
    ? "请重读源文件（本场无可复原的笔记记录）"
    : `请重读源文件，或直接执行：${command}`;
}

/**
 * @typedef {object} NoteRecallHint
 * @property {string} gate `NOTE_HINT_GATES` 之一——测试断言走的是哪一格
 * @property {boolean} available 笔记这条路现在能不能查（= 证据门是否成立）
 * @property {string} reason 不能查时的原因文本（`NOTE_RECALL_REASONS` 的值；能查时是空串）
 * @property {string | undefined} command `retrievalCommandFor` 给出的那条命令（拼不出就 undefined）
 * @property {string} clause 取回指引那半句（调用方把它拼进自己那条文案）
 * @property {string} [shortClause] 同一句的短版（仅供**受预算约束的受保护消息**用；有证据时与 `clause` 同）
 */

/**
 * 一条归档/超限提示该给哪种取回指引。
 *
 * 两个事实缺一不可（口径全部来自 #741 的 `resolveNoteRecall`）：
 *   ① 宿主给的完整工具面上有**整族** `note_take` / `note_list` / `note_read`；
 *   ② 可见账本里有一条**现在还能查**的 `note_take` 写入（配对、载荷证实成功、没被后续成功的
 *      `note_forget` 撤销）。
 * 拿不到 ⇒ 只给重读指引，且这一句里**一个 `note_*` 都不出现**，并明说「无可复原的决策记录（原因：…）」。
 * 命令只在 `retrievalCommandFor` **真给出**时才贴（它只认 readFile 那份入参契约；exec / MCP 一律
 * 不给命令）——本模块绝不自己拼 `sed`。
 *
 * @param {{
 *   noteTools?: string[],
 *   messages?: Parameters<typeof resolveNoteRecall>[0]["messages"],
 *   toolName?: string,
 *   toolInput?: unknown,
 * }} [evidence] `toolName` / `toolInput` 是被归档那次调用的工具名与入参（拼重读命令用，可省）
 * @returns {NoteRecallHint}
 */
export function noteRecallHint({ noteTools, messages, toolName, toolInput } = {}) {
  const command = retrievalCommandFor(toolName, toolInput);
  // **账本缺席 ≠ 账本为空**（#746 的新认识，也是本模块唯一一处「不直接照抄 #741 四格」的地方）：
  // 系统提示是 run 开始前拼的、`bin/` 的折叠桩钩子只拿到待折叠的那一条消息，这两层里「没有写入」
  // 不是事实，是**没人在这一层把账本递过来**。硬按四格判 ⇒ 整族在场上也永远走「无笔记写入」，
  // 于是把「我不知道」伪报成「这条 run 没记过笔记」——与旧文把「不知道」伪报成「有记录」同一个形状，
  // 只是方向相反。所以本格只说条件式，并把「能不能查」如实地报成 false。
  if (hasNoteToolSurface(noteTools) && messages === undefined) {
    return {
      gate: NOTE_HINT_GATES.notesAvailable,
      available: false,
      reason: "",
      command,
      clause: command === undefined
        ? NOTE_CONDITIONAL_CLAUSE
        : `${NOTE_CONDITIONAL_CLAUSE}；需要原文也可直接执行：${command}`,
      shortClause: NOTE_CONDITIONAL_CLAUSE,
    };
  }
  const recall = resolveNoteRecall({ noteTools, messages: messages ?? [] });
  if (recall.available) {
    return {
      gate: NOTE_HINT_GATES.noteEvidence,
      available: true,
      reason: "",
      command,
      clause: command === undefined
        ? NOTE_RECALL_CLAUSE
        : `${NOTE_RECALL_CLAUSE}；需要原文也可直接执行：${command}`,
      shortClause: NOTE_RECALL_CLAUSE,
    };
  }
  const reason = typeof recall.reason === "string" && recall.reason !== ""
    ? recall.reason
    : NOTE_RECALL_REASONS.unknown;
  return {
    gate: NOTE_HINT_GATES.noEvidence,
    available: false,
    reason,
    command,
    clause: `${rereadClause(command)}；${unverifiedRecallClause(reason)}`,
    // 受预算约束的受保护消息用这一份（同一个判据，同一侧口径，只是不重复原因全文）。
    shortClause: rereadClauseShort(command),
  };
}
