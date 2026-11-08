// @ts-check
// issue #769：run snapshot「只有快照载着」那几格的 **append-only 恢复行载体**（#767 退役快照通道的硬前置）。
//
// 为什么是「新增一种账本行」而不是「往既有行上加字段」：
//   · `:control:<slot>` 行（`src/loop/orchestrator.js#appendEngineMessagesToTranscript`）**载着
//     `messages`**，而 `restoreResume`（`src/loop/resume-manager.js`）用 `records.flatMap(record.messages)`
//     重建上下文 ⇒ 把正文塞进那种行就是把同一份正文恢复两遍（工单 261021 的「正文翻倍」老问题）；
//   · `saveRunState` 写的 `.state.json` 是 **latest-only 覆盖写**（`src/store/file.js#saveRunState`），
//     给不了「按事件重放」的语义，也不是账本。
//   ⇒ 本模块的形状取自仓内**已有**先例 `orchestrator.js#appendEngineFactToTranscript`：一条一个事件、
//     `messages: []`（不载正文）、`dedupKey` 带**唯一事件键**（同事件重放幂等、不同事件换键）。
//
// 语义红线（本模块存在的理由，也是契约里那句话的出处）：
//   **「`tool_use` 没有对应 `tool_result`」推不出「工具没执行」**——执行发生在结果行落盘**之前**
//   （`src/loop/run-snapshot-executor.js`：`executedToolIds.add` 在前，结果行更晚），所以
//   「没执行」与「执行了但没入账」在账本里形状相同。⇒「执行过没有」必须由这里的
//   `tool-executed` 行**显式携带** `toolUseId`，不许由「缺结果行」反推。
//
// 宿主可见面：账本 `.jsonl` 里从此多一种 `kind: "recovery"` 的行。它是**新行类型**，
// 契约（`docs/host-consumer-contract.md` / `_cn.md` 的「Ledger recovery rows」一节）写清了形状、
// 写入时机，以及**宿主遇到不认识的 `kind` 该怎么办**——在此之前契约里**没有**「未知 kind 忽略」
// 这句承诺（现查：两份契约里 `unrecognized/未知 kind` 只出现在 provider 槽位 / notes 计数 / JSON 字段三处）。

// 快照侧对应的三格（`executedToolIds` / `partialText` / `partialRound`）在恢复路径上退成兜底（#769）。
// 恢复侧第一顺位读的是本模块这些行（`src/loop/resume-manager.js#restoreResume`）：两轴载荷表把这三格的
// 账本来源钉在上面那一行，改本模块的形状记得同步改 `scripts/cell-axes-anchors.mjs` 的登记。
import { createHash } from "node:crypto";

/** 行类型判别键（宿主过滤账本行时看的就是它）。与 `kind: "message"`（`src/store/message-rows.js`）并列。 */
export const RECOVERY_ROW_KIND = "recovery";

/** 事件：某个 `tool_use` **真的执行过了**（副作用已发生）。一格一条，事件键 = `toolUseId`。 */
export const RECOVERY_EVENT_TOOL_EXECUTED = "tool-executed";

/** 事件：一段**半截 assistant 正文**（`stream: true` + `partialPersistence` 才存在）。事件键 = 正文指纹。 */
export const RECOVERY_EVENT_PARTIAL_TEXT = "partial-text";

/** 本模块认识的恢复事件（**不认识的 `recoveryEvent` 一律忽略**：行类型内部的扩展与行类型本身一样是 add-on）。 */
export const RECOVERY_EVENTS = Object.freeze([
  RECOVERY_EVENT_TOOL_EXECUTED,
  RECOVERY_EVENT_PARTIAL_TEXT,
]);

/** 引擎命名空间前缀：与 `:control:` / `:fold:` / `:ttl:` 同一命名空间风格（issue #326 先例）。 */
const RECOVERY_KEY_SEGMENT = "recovery";

/**
 * 唯一事件键：同一条 run 里「同一个事件」重放必然得到同一个键，「另一个事件」必然换键。
 * `appendRound` 的幂等判据就是它（`src/store/transcript-dedup.js#recordKey`），
 * 而 payload 指纹**不含**顶层 `round`/`ts`（`PAYLOAD_VOLATILE_FIELDS`）⇒ 崩溃重跑同一事件
 * 是「同 key 同 payload」= 幂等跳过，不产生第二行。
 *
 * @param {string} runId
 * @param {number} round
 * @param {string} event
 * @param {string} discriminator `toolUseId`，或半截正文的指纹
 * @returns {string}
 */
export function recoveryEventKey(runId, round, event, discriminator) {
  return `${String(runId)}:engine:round:${String(round)}:${RECOVERY_KEY_SEGMENT}:${String(event)}:${String(discriminator)}`;
}

/** 半截正文的事件键后缀：对**正文**取指纹（`sha256:<24 hex>`，与 `src/store/transcript-dedup.js#digest` 同口径）。
 *  同一段正文重放 = 同键 = 幂等；正文变长 = 换键 = 新事件（append-only 只追加，绝不改写既有行）。
 * @param {string} text
 * @returns {string} */
export function partialTextEventDiscriminator(text) {
  return `sha256:${createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * `tool-executed` 恢复行：一条一个事件，**只带身份不带正文**。
 * @param {{ runId: string, round: number, toolUseId: string, ts?: string }} input
 * @returns {{round:number, roundKey:string, dedupKey:string, kind:string, recoveryEvent:string,
 *   toolUseId:string, messages: object[], ts:string}}
 */
export function buildToolExecutedRecoveryRow({ runId, round, toolUseId, ts }) {
  return {
    round: Number(round),
    roundKey: `${String(runId)}:round:${String(round)}`,
    dedupKey: recoveryEventKey(runId, round, RECOVERY_EVENT_TOOL_EXECUTED, toolUseId),
    kind: RECOVERY_ROW_KIND,
    recoveryEvent: RECOVERY_EVENT_TOOL_EXECUTED,
    toolUseId,
    messages: [],
    ts: ts ?? new Date().toISOString(),
  };
}

/**
 * `partial-text` 恢复行：一条一个事件，**事件键由正文指纹算出**（见 `partialTextEventDiscriminator`）。
 * @param {{ runId: string, round: number, text: string, ts?: string }} input
 * @returns {{round:number, roundKey:string, dedupKey:string, kind:string, recoveryEvent:string,
 *   text:string, messages: object[], ts:string}}
 */
export function buildPartialTextRecoveryRow({ runId, round, text, ts }) {
  return {
    round: Number(round),
    roundKey: `${String(runId)}:round:${String(round)}`,
    dedupKey: recoveryEventKey(
      runId, round, RECOVERY_EVENT_PARTIAL_TEXT, partialTextEventDiscriminator(text),
    ),
    kind: RECOVERY_ROW_KIND,
    recoveryEvent: RECOVERY_EVENT_PARTIAL_TEXT,
    text,
    messages: [],
    ts: ts ?? new Date().toISOString(),
  };
}

/**
 * 是不是一条恢复行（只认 `kind`，**不认事件名**：事件名不认识是「以后新增的事件」，由调用侧忽略）。
 * @param {any} row
 * @returns {boolean}
 */
export function isRecoveryRow(row) {
  return row !== null && typeof row === "object" && !Array.isArray(row)
    && row.kind === RECOVERY_ROW_KIND;
}

/**
 * `tool-executed` 恢复行的**形状判据**（issue #769 R5 M5）：返回**第一个不合的字段名**，全合返 `null`。
 *
 * 为什么不能只查 `toolUseId`（修前就是那样）：一行能解析不等于它能当证据。`round: NaN` 或没有
 * `dedupKey` 的行，写侧根本不可能产出（`buildToolExecutedRecoveryRow` 两者都必写）⇒ 它是宿主手写的、
 * 半截修复的或被截断的行。把这种行的 `toolUseId` 并进「执行过了」集合，等于拿一行的**身份**去坐实
 * 它自己都说不出的一次执行。
 *
 * @param {any} row
 * @returns {string | null}
 */
export function toolExecutedRecoveryRowShapeProblem(row) {
  if (typeof row?.toolUseId !== "string" || row.toolUseId === "") return "toolUseId";
  if (!Number.isSafeInteger(row?.round)) return "round";
  if (typeof row?.dedupKey !== "string" || row.dedupKey === "") return "dedupKey";
  return null;
}

/**
 * 账本侧的「执行过没有」真相：全部 `tool-executed` 恢复行携带的 `toolUseId` 集合。
 * 这是快照 `executedToolIds` 格的**继任来源**；读侧把它当首选、快照格退成兜底。
 *
 * 形状守卫与 `src/store/message-rows.js` 同一口径：不是本事件类型的行**跳过**（那是「以后新增的事件」）。
 * 但 `tool-executed` 行本身形状不合时**不跳过、不猜**（issue #769 R5 M5）：这一行是「工具真的执行过了」
 * 的唯一证据，静默丢掉它就是又一次「唯一证据被当没有」⇒ 抛错，由读侧（`src/loop/resume-manager.js`）
 * 包成契约面那个 `recovery_rows_unreadable`。抛的是普通 `TypeError`：本模块不造宿主可见错误码，
 * 消息里点名**哪个字段不合**（排障要知道的是字段，不是错码）。
 *
 * @param {any[]} records `store.load()` / `loadRawRows()` 的输出（恢复行不带 `messages`，折叠层原样透传，两边同结果）
 * @returns {Set<string>}
 * @throws {TypeError} `tool-executed` 行形状不合（字段清单见 `toolExecutedRecoveryRowShapeProblem`）
 */
export function readExecutedToolIdRecoveryRows(records) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const row of Array.isArray(records) ? records : []) {
    if (!isRecoveryRow(row)) continue;
    if (row.recoveryEvent !== RECOVERY_EVENT_TOOL_EXECUTED) continue;
    const problem = toolExecutedRecoveryRowShapeProblem(row);
    if (problem !== null) {
      throw new TypeError(
        `tool-executed recovery row is malformed on field "${problem}" `
        + `(toolUseId=${JSON.stringify(row.toolUseId ?? null)}, round=${String(row.round)}, `
        + `dedupKey=${JSON.stringify(row.dedupKey ?? null)}): refusing to read a malformed row as "no execution evidence"`,
      );
    }
    ids.add(row.toolUseId);
  }
  return ids;
}

/**
 * 账本里**有** `partial-text` 恢复行的轮号（落盘顺序去重）：读侧用它判断「账本知不知道某一轮跑到一半」，
 * 而不必先把正文全文抓出来。轮号不合法（非安全整数）的行跳过。
 *
 * @param {any[]} records
 * @returns {number[]}
 */
export function readPartialTextRecoveryRounds(records) {
  /** @type {number[]} */
  const rounds = [];
  for (const row of Array.isArray(records) ? records : []) {
    if (!isRecoveryRow(row)) continue;
    if (row.recoveryEvent !== RECOVERY_EVENT_PARTIAL_TEXT) continue;
    if (!Number.isSafeInteger(row.round)) continue;
    if (typeof row.text !== "string" || row.text.length === 0) continue;
    if (!rounds.includes(row.round)) rounds.push(row.round);
  }
  return rounds;
}

/**
 * 账本侧的半截正文：`round` 那一轮**最后**落盘的那条 `partial-text` 行的正文。
 * append-only ⇒ 「最新」= 文件里最后一条，读侧按落盘顺序覆盖，绝不取第一条。
 *
 * @param {any[]} records
 * @param {number} round 崩溃轮（与 `restoreResume` 的 `crashRound` 同值）
 * @returns {{ text: string, round: number } | undefined} 该轮没有任何可用恢复行 ⇒ `undefined`（读侧才允许回落快照）
 */
export function readPartialTextRecoveryRow(records, round) {
  /** @type {{ text: string, round: number } | undefined} */
  let latest;
  for (const row of Array.isArray(records) ? records : []) {
    if (!isRecoveryRow(row)) continue;
    if (row.recoveryEvent !== RECOVERY_EVENT_PARTIAL_TEXT) continue;
    if (!Number.isSafeInteger(row.round) || row.round !== round) continue;
    if (typeof row.text !== "string" || row.text.length === 0) continue;
    latest = { text: row.text, round: row.round };
  }
  return latest;
}
