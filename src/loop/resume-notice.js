// @ts-check
/**
 * issue #398（工单 BB「复活赛告示」）：**恢复运行要告诉模型「这是复活赛」**。
 *
 * 背景：引擎恢复一个崩溃的 run 时，重建上下文、补跑未结清的 `tool_use`、然后继续——全程**不告诉
 * 模型中间断过一次**。模型以为自己连着在讲，于是把「引擎替它补跑/标注出来的结果」当成自己那次
 * 调用的输出，或者干脆重发一遍有副作用的调用（`git commit` / `npm publish` / `POST` / 覆盖写）。
 * 本模块造的就是那条告示：一条引擎控制消息，内容只有三件**既有事实**：
 *
 *   1. 这是崩溃后的恢复运行、上一段停在第 N 轮（停机原因若账本里有）；
 *   2. 崩溃时哪些 `tool_use` 还没有结果（判据 = `pendingTrailingToolUses`，`src/messages/rounds.js`；
 *      **不另写配对逻辑**，理由同 `src/loop/pending-tool-result.js` 的三条纪律）；
 *   3. 账本记录过写过哪些文件 / 最近调过哪些工具（`runState.deterministic.filesWritten` 与
 *      `governorState.timeline`），以及「动手前先勘验、别直接重发有副作用的调用」这条纪律。
 *
 * 三条设计约束（都是今晚踩过的坑）：
 *   - **只在真恢复时注入**：本模块只被 `restoreResume`（`src/loop/resume-manager.js`）在
 *     `resume: true` 的账本分支里调用一次；非 resume 的首次运行拿不到告示 ⇒ `messages` 与今天
 *     逐字一致（回归锚在 `test/loop-resume-notice.test.js`）。
 *   - **不新造事实、不加 payload 键**：本模块不碰 `finalGuard` payload（余量只剩 ≈360 B），
 *     只把账本里已有的事实拼成一句话。
 *   - **不碰 store**：入账由调用方经既有的 `:control:` 行做（`src/loop/orchestrator.js` 的
 *     `appendEngineMessagesToTranscript`），本模块只返回 `{ text, slot }`。**不能**改成
 *     `kind:"message"` 消息行——消息行会被 `foldMessageRows` 折回轮载体行，恢复时插到
 *     `tool_use` 之前把配对重新打散（#393 的结论）。
 *
 * 文案是给人读的中文，但**判据只钉片段**：下面这几个 `export const` 是测试断言的那几段，
 * 散文部分可以改，常量所代表的语义不能悄悄消失。
 */

import { createHash } from "node:crypto";

/** 告示的标题标记（`grep -rhoE "【[^】]{2,12}】"` 里的第八种注入控制文本）。 */
export const RESUME_NOTICE_TAG = "【恢复运行】";

/** 「未结清调用」那一节的开头（后面逐条列 `id` + 工具名 + 参数摘要）。 */
export const RESUME_NOTICE_PENDING_HEADER = "崩溃时这些 tool_use 还没有结果";

/** 尾部已结清时的替代句（仍然注入——「这是恢复」本身就是要告知的事实）。 */
export const RESUME_NOTICE_NO_PENDING = "崩溃时尾部没有未结清的 tool_use（上一次请求与结果已成对落账）";

/** 第三条内容要求的开头：动手前先勘验、别重发有副作用的调用。 */
export const RESUME_NOTICE_VERIFY_HEADER = "动手前先勘验";

/** 入账槽位名（`:control:<slot>` 的 `slot` 前缀；后缀是内容指纹，见 `buildResumeNotice`）。 */
export const RESUME_NOTICE_SLOT = "resume-notice";

const ARG_LIMIT = 40;
const FILES_LIMIT = 5;
const CALLS_LIMIT = 3;

/** 单行化 + 截断：告示是**一条**消息，任何一段都不许把它撑成一篇散文。 */
function truncate(value, limit) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * `tool_use` 入参的**摘要**（不是新事实：它就是把模型自己写下的入参压成一行）。
 * `exec` 这类「命令」形状优先取 `command`，其余按 JSON 压平——与 judge 的
 * `summarizeArgument`（`src/reflection/judge.js`）同一取舍方向，但不共用实现：
 * 那边按工具名白名单决定取哪个键，这边只需要一行可读摘要。
 * @param {any} input
 * @returns {string}
 */
function summarizeInput(input) {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncate(input, ARG_LIMIT);
  if (typeof input.command === "string") return truncate(input.command, ARG_LIMIT);
  try {
    const serialized = JSON.stringify(input);
    return serialized === "{}" ? "" : truncate(serialized, ARG_LIMIT);
  } catch {
    return "";
  }
}

/**
 * 未结清的 `tool_use` → 一行一条 `id`(工具名: 参数摘要)。
 * @param {any[]} pendingToolUses
 * @returns {string}
 */
function pendingLine(pendingToolUses) {
  const items = pendingToolUses.map((block) => {
    const id = String(block?.id ?? "");
    const name = String(block?.name ?? "");
    const arg = summarizeInput(block?.input);
    return arg === "" ? `\`${id}\`(${name})` : `\`${id}\`(${name}: ${arg})`;
  });
  return `${RESUME_NOTICE_PENDING_HEADER}，引擎已按重放策略补跑或标注（结果在紧随其后的 `
    + `tool_result 里，别当成崩溃前那一次的输出）：${items.join("、")}。`;
}

/**
 * 账本里的现场事实：写过哪些文件、最近调过哪些工具。两段都可能为空 ⇒ 整段缺席。
 * @param {string[]} files 去重后的路径
 * @param {string[]} calls 最近调过的工具（`name(arg)`）
 * @returns {string}
 */
function ledgerLine(files, calls) {
  const parts = [];
  if (files.length > 0) {
    const shown = files.slice(0, FILES_LIMIT);
    const rest = files.length - shown.length;
    parts.push(`写过 ${files.length} 个文件（${shown.join("、")}${rest > 0 ? ` 等 ${files.length} 个` : ""}）`);
  }
  if (calls.length > 0) {
    parts.push(`最近调过的工具 ${calls.slice(0, CALLS_LIMIT).join("、")}`);
  }
  if (parts.length === 0) return "";
  return `账本记录：${parts.join("；")}。`;
}

/**
 * `governorState.timeline` → 最近一轮「调过哪些工具」的一行摘要（`name(arg)`）。
 * 时间线是**既有**事实（`buildTimeline`，`src/reflection/judge.js`），这里只负责压成一行；
 * `arg` 已经是 judge 侧的参数摘要（`exec` 取命令、写工具取路径）。
 * @param {any[]} timeline
 * @returns {string[]}
 */
export function recentToolCalls(timeline) {
  const last = Array.isArray(timeline) ? timeline[timeline.length - 1] : undefined;
  const calls = Array.isArray(last?.toolCalls) ? last.toolCalls : [];
  return calls
    .map((call) => {
      const name = String(call?.name ?? "");
      const arg = truncate(call?.arg ?? "", ARG_LIMIT);
      if (name === "") return "";
      return arg === "" ? name : `${name}(${arg})`;
    })
    .filter((line) => line !== "");
}

/**
 * 造一条恢复告示。
 *
 * @param {{
 *   round?: number,
 *   stopReason?: string,
 *   pendingToolUses?: any[],
 *   filesWritten?: string[],
 *   toolCalls?: string[]
 * }} facts 全部来自既有事实：轮号（`runLoopState.rounds`）、`runState.deterministic.termination.reason`、
 *   `pendingTrailingToolUses(messages)`、`runState.deterministic.filesWritten`、`governorState.timeline`。
 * @returns {{ text: string, slot: string } | undefined} 轮号不合法时返回 `undefined`（造不出「停在第 N 轮」）
 */
export function buildResumeNotice(facts = {}) {
  const round = facts.round;
  if (!Number.isSafeInteger(round) || round < 0) return undefined;
  const reason = typeof facts.stopReason === "string" && facts.stopReason !== ""
    ? facts.stopReason
    : "running";
  // `running` = 账本里最后一次 run-state 仍是「跑着」⇒ 进程被终止/崩溃，**没有**入账的停机原因。
  // 这一格必须如实说「未入账」而不是编一个原因出来。
  const reasonText = reason === "running"
    ? "停机原因未入账（进程被终止或崩溃）"
    : `停机原因「${reason}」`;
  const pendingToolUses = Array.isArray(facts.pendingToolUses) ? facts.pendingToolUses : [];
  const files = [...new Set((Array.isArray(facts.filesWritten) ? facts.filesWritten : [])
    .filter((path) => typeof path === "string" && path !== ""))];
  const calls = (Array.isArray(facts.toolCalls) ? facts.toolCalls : [])
    .filter((call) => typeof call === "string" && call !== "");

  const lines = [
    `${RESUME_NOTICE_TAG}这是一次崩溃后的恢复运行，不是连续会话：上一段停在第 ${round} 轮；${reasonText}。`,
    pendingToolUses.length > 0 ? pendingLine(pendingToolUses) : `${RESUME_NOTICE_NO_PENDING}。`,
    ledgerLine(files, calls),
    `${RESUME_NOTICE_VERIFY_HEADER}：账本记的是「当时」，盘上现在可能已被别的进程改过。`
      + "先 `ls` / `cat` / `git status` 之类核一眼，不要直接重发有副作用的调用"
      + "（`git commit` / `npm publish` / HTTP `POST` / 覆盖写 / 建 PR）。",
  ].filter((line) => line !== "");

  const text = lines.join("\n");
  // 槽位名带**内容指纹**（沿用 `:fold:<fp>` 的命名先例）：同一份事实崩溃重跑幂等（同 key 同 payload
  // = 不写第二行），事实变了则换 key（不同 key 不会触发 #326 的「同 key 异 payload」冲突）。
  // 调用方另按这个 key 在账本里查一遍：已经有一条同内容的告示 ⇒ 本次不再重复注入。
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return { text, slot: `${RESUME_NOTICE_SLOT}:${fingerprint}` };
}

/**
 * 恢复路径的**准入 + 幂等判据**（`restoreResume` 的唯一调用点）。
 *
 * 三件事，全部只读：从 `restoreResume` 的 ctx 取既有事实 → 造告示 → 按 dedupKey 查一遍账本。
 * 账本里已经有一条**同内容**的告示（同一条 run 连续 resume 两次、且两次事实一模一样）⇒ 返回
 * `undefined`：那份告示已经在 `store.load()` 折回来的上下文里，再注入一份就是同一件事说两遍。
 *
 * 为什么直接吃 ctx：本函数只读 `runId` / `rounds` / `currentRunState` / `governorState` 四个字段，
 * 而 `restoreResume` 的文件体量被 `test/tools/file-tools.test.js` 的 #271 字节锚钉着（±2%）——
 * 把四个字段的传递搬到这里，那边就只剩一行调用。
 *
 * @param {any} ctx `restoreResume` 的入参（只读上面那四个字段）
 * @param {any[]} records `store.load()` 的原始记录（幂等查账用；不折叠也能查：`:control:` 行不被折叠）
 * @param {any[]} pendingToolUses 崩溃现场的未结清 `tool_use`（**补跑之前**取自 `pendingTrailingToolUses`）
 * @returns {{ text: string, slot: string, round: number } | undefined}
 */
export function planResumeNotice(ctx, records, pendingToolUses) {
  const round = ctx?.rounds;
  const notice = buildResumeNotice({
    round,
    stopReason: ctx?.currentRunState?.deterministic?.termination?.reason,
    pendingToolUses,
    filesWritten: (ctx?.governorState?.filesWritten ?? []).map((entry) => entry?.path),
    toolCalls: recentToolCalls(ctx?.governorState?.timeline),
  });
  if (notice === undefined) return undefined;
  const dedupKey = `${String(ctx?.runId)}:engine:round:${String(round)}:control:${notice.slot}`;
  const already = (Array.isArray(records) ? records : []).some((record) => (
    (record?.dedupKey ?? record?.roundKey) === dedupKey
  ));
  return already ? undefined : { text: notice.text, slot: notice.slot, round };
}
