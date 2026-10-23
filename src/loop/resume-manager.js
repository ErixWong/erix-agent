import { cloneState } from "./budget.js";
import { blocksFor, mergeToolResultsIntoMessages } from "./messages.js";
import { MESSAGE_ROW_KIND, nextMessageSeqByRound, foldLedgerMessages, foldMessageRows } from "../store/message-rows.js";
import { extractL0Facts } from "../reflection/l0.js";
import { buildTimeline } from "../reflection/judge.js";
import { pendingTailToolUses } from "./pending-tool-result.js";
import { planResumeNotice } from "./resume-notice.js";
import { validateRunState } from "../run-state.js";

const rowKeyOf = (record) => {
  const key = record?.dedupKey ?? record?.roundKey;
  return typeof key === "string" ? key : "";
};

// issue #425：**恢复锚点必须在恢复时现算**，不能信快照里的 `persistedTranscriptLength`——
// 那是 partialPersistence 定时器写快照**那一刻**的采样。之后工具结果行 / 终稿 assistant 行还会
// 继续落盘（写侧「一条消息一成型就落盘」），于是快照里的值比账本少（实测 28/28 次快照当场
// `write === read`，恢复时却少 2）⇒ `slice(0, anchor)` 把已经落盘的正文当成「崩溃之后宿主追加的」
// 尾队列，终稿正文被喂给模型两遍。
//
// 现算口径按**引擎命名空间的行**统计折叠后的逻辑消息条数：
//   · 引擎写的行：`<runId>:engine:…`（种子 / 轮记录 / `:resume` / `:control:` / 事实行）、
//     `<runId>:msg:…`（一条消息一落盘）、老账本的 `<runId>:round:<n>`（早期版本的轮记录，
//     那时引擎自己就写这个键）以及没有任何身份键的远古轮行；
//   · 宿主写的行：`<runId>:input:…`（`src/store/append-user-turn.js`）——它是崩溃**之后**才追加的
//     追问，属于尾队列（补跑结果之后再接回），不属于崩溃现场。
// 只排除**尾部**的宿主行：上一次恢复留下的追问行夹在中间时，它已经在模型的上下文里了，必须计入
// （否则按条数切片会切在一条逻辑消息中间，或者把历史追问挤进尾队列）。
const ENGINE_NAMESPACE_KEY = /:(?:engine|msg|round):/u;

/** 这一行是不是引擎自己写的账本行（见上面 `ENGINE_NAMESPACE_KEY` 的三种形态）。
 * @param {any} record
 * @returns {boolean}
 */
function isEngineNamespaceRow(record) {
  const key = rowKeyOf(record);
  return key === "" || ENGINE_NAMESPACE_KEY.test(key);
}

/**
 * 恢复锚点：账本里「崩溃那一刻**已经落盘**」的折叠逻辑消息条数（issue #425）。
 *
 * 纯函数，单一职责：输入账本行（`store.load()` 的折叠行或原始行都行），输出条数。
 * 口径 = 去掉**尾部**宿主命名空间行之后，按 `foldLedgerMessages` 折出来的逻辑消息数
 * （`partOf` 分片接回它指认的那条消息，分片不加）。
 *
 * 为什么不是「全账本条数」：宿主追问行（`…:input:…`）是崩溃之后才写的，把它算进崩溃现场
 * 会让补跑结果插到它前面（`validateMessages` 当场 `invalid_messages`）。
 * 为什么不是「只数引擎行」：上一次恢复留下的追问行夹在中间，只数引擎行会把条数压小，
 * 切片同样会错位。
 *
 * @param {Array<object>} records
 * @returns {number}
 */
export function countResumeAnchor(records) {
  const rows = Array.isArray(records) ? records : [];
  let end = rows.length;
  while (end > 0 && !isEngineNamespaceRow(rows[end - 1])) end -= 1;
  return foldLedgerMessages(rows.slice(0, end)).length;
}

export async function restoreResume(ctx) {
  if (!ctx.persistenceRequired) return;

  const restoreRunState = (restored) => {
    const validation = validateRunState(restored);
    if (!validation.ok) {
      ctx.runStateAvailability = {
        status: validation.status,
        reason: validation.reason,
      };
      return "invalid";
    }
    applyRestoredRunState(validation.state);
    return "applied";
  };

  const applyRestoredRunState = (restored) => {
    if (!restored || typeof restored !== "object") return;
    ctx.currentRunState = cloneState(restored);
    ctx.runStateVersion = Number.isSafeInteger(restored.stateVersion)
      ? restored.stateVersion
      : 0;
    const deterministic = restored.deterministic ?? {};
    for (const tool of deterministic.tools ?? []) {
      if (typeof tool?.name !== "string") continue;
      ctx.toolStats.set(tool.name, {
        calls: Number.isSafeInteger(tool.calls) ? tool.calls : 0,
        failures: Number.isSafeInteger(tool.failures) ? tool.failures : 0,
      });
    }
    // lowBudgetPrompted 属于“本次预算”类状态：预算轮数每次 runToolLoop 从 0 起算，
    // 续接会话有全新预算，不得继承上一次的“预算将尽”标记（只影响 run-state 报告口径）
    ctx.lowBudgetPrompted = false;
    ctx.foldedRoundCount = deterministic.fold?.foldedRounds ?? 0;
    ctx.navigationRecordCount = deterministic.fold?.navigationRecords ?? 0;
    ctx.toolErrorCount = deterministic.errors?.tool ?? 0;
    ctx.runSnapshotFailureCount = deterministic.errors?.checkpoint ?? 0;
    ctx.compactionStats = deterministic.compactionStats;
    // issue #386 切片 3：guard 补跑的**一次性配额**跨 resume 不重置——它就在上面那句
    // 「预算类状态一律复位」的旁边，语义**相反**：`lowBudgetPrompted` 复位是因为它只描述
    // 「本次预算将尽」（续接会话有全新预算），而这一格是成本闸：已经领过的补跑额度必须跟着
    // 这个 run 走完，否则「跑 → 崩 → resume」每次都能领一份 = 无界成本。
    // 旧档没有 `deterministic.guardExtension`（增量字段）⇒ 读成 `false`，与今天的 run 等价。
    ctx.governorState.guardExtensionUsed = deterministic.guardExtension?.used === true;
    ctx.governorState.filesWritten = Array.isArray(deterministic.filesWritten)
      ? deterministic.filesWritten.map((path) => ({ path }))
      : [];
    ctx.todoState = deterministic.todo;
    ctx.semanticState = restored.semantic;
  };

  const restorePersistedRunState = async () => {
    if (!ctx.resume || ctx.runId === undefined) return "absent";
    if (typeof ctx.store?.loadRunState !== "function") {
      // issue #78 验收修正：resume 想消费 run-state 但 store 缺 loader——
      // 走 orchestrator 的单条去重诊断（与 persist 守卫同一事件通道/语义）。
      ctx.notifyCapabilitySkipped?.("loadRunState");
      return "absent";
    }
    const stored = await ctx.store.loadRunState(ctx.runId);
    if (stored === undefined) return "absent";
    const restored = stored?.runState && typeof stored.runState === "object"
      ? stored.runState
      : stored;
    return restoreRunState(restored);
  };

  const resolveRunStateSource = (persistedResult) => (
    persistedResult === "absent" ? "record" : "independent"
  );

  const markRunState = ctx.markRunState;
  await markRunState("running");
  const persistedRunStateResult = await restorePersistedRunState();
  if (ctx.resume && ctx.store && ctx.runId !== undefined) {
    try {
      // issue #401：宿主自研 store 可能**没折**（`load()` 直接返回落盘行）。再折一次，宿主折不折都能
      // 拿到同一份时间线——守卫在 `foldMessageRows` 里（该轮载体已带这一轮正文 ⇒ 该轮跳过），
      // 所以「两份都留」的宿主也不会让正文翻倍。
      // 只有账本里**还看得见消息行**时才需要折（宿主没折 / 折了又留着原始行）；已折过的账本直接原样用，
      // 不多走一遍折叠（内置 store 这条路因此与今天逐字一致，连一次额外的数组遍历都不添）。
      const loadedRecords = await ctx.store.load(ctx.runId);
      const records = loadedRecords.some((record) => (
        record?.kind === MESSAGE_ROW_KIND && Number.isSafeInteger(record.seq)
      ))
        ? foldMessageRows(loadedRecords)
        : loadedRecords;
      if (records.length === 0) throw new Error("resume: 无可恢复记录");
      // issue #326（wo-C）：**恢复不得重算折叠摘要**——把已入账的那份灌回引擎的复用账本，
      // 于是本次进程里同一折叠输入直接命中，不再调摘要器，也不会重复落账。
      ctx.seedFoldSummaries?.(records);
      if (resolveRunStateSource(persistedRunStateResult) === "record") {
        const latestStateRecord = [...records].reverse().find((record) => (
          record?.runState && typeof record.runState === "object"
        ));
        if (latestStateRecord?.runState !== undefined) {
          restoreRunState(latestStateRecord.runState);
        }
      }
      const ledgerEntries = foldLedgerMessages(records);
      const ledgerMessages = ledgerEntries.map((entry) => entry.message);
      const seedRecords = records.filter((record) => (record.round ?? 0) === 0);
      const seedMessages = seedRecords.flatMap((record) => record.messages ?? []);
      ctx.taskBriefSource = seedRecords.length > 0 ? seedMessages : [];
      // 工单 261021（第三刀·恢复只认账本）：逻辑消息序列是崩溃/续跑上下文的**唯一正文来源**。
      // 口径不是裸 `records.flatMap(record.messages)`，而是 `foldLedgerMessages(records)`：
      // 它与写侧锚点计数（`persistedTranscriptLength`，分片不加）同一条口径，把 `partOf` 分片
      // 接回它指认的那条消息，**与载体行在场无关**（理由见 `src/store/message-rows.js` 里该函数的注释）。
      // 轮号直接带在 `ledgerEntries` 里：切片后的正文是 `cloneState` 的副本，拿身份去查轮号会落空。
      ctx.messages = ledgerMessages;
      ctx.persistedTranscriptLength = ctx.messages.length;
      let pendingTail = pendingTailToolUses(ctx.messages);
      for (const entry of ledgerEntries) {
        ctx.messageRounds.set(entry.message, entry.round);
      }
      for (const record of records) {
        // issue #326（wo-C）：**引擎事实行不进治理历史**。`…:engine:round:<n>:fold:<fp>` /
        // `…:ttl:<fp>` 这类补充记录带轮号但没有轮正文（`messages: []`），照旧走下面的分支就会给同一轮
        // 追加一条 `summary: "missing"` 的历史条目，污染 judge 看到的轮次历史。
        const isEngineFactRow = (record?.messages?.length ?? 0) === 0
          && (record?.foldedSummary !== undefined || record?.ttlDegradations !== undefined);
        if ((record.round ?? 0) > 0 && !isEngineFactRow) {
          const summary = record.summary ?? "missing";
          const l0facts = record.l0facts
            // 无 l0facts 的远古记录：用共享 errorSeen 重新提取（跨记录累计；
            // 随后 restoreErrorSeen 的 Math.max 幂等，不会双计）
            ?? extractL0Facts(record.messages ?? [], {
              seenErrors: ctx.governorState.errorSeen,
            });
          const restoreErrorSeen = ctx.restoreErrorSeen;
          restoreErrorSeen(l0facts);
          const addGovernorHistory = ctx.addGovernorHistory;
          addGovernorHistory(
            record.round,
            summary,
            l0facts,
            record.ts,
            record.wrapup,
            record.judge,
          );
          // `record.messages` 是 `store.load()` 的**折叠后**形状（`src/store/message-rows.js`），不是落盘行形状：
          // 0.23 的正文在 `kind:"message"` 行里，读侧折回轮载体行（issue #353）。判据钉在
          // `test/loop-resume.test.js` 的「#353 resume 从折叠后的账本重建」两条用例。
          const recordedTimeline = buildTimeline(record.messages ?? [], 0, {
            writeToolNames: ctx.resolvedWriteToolNames,
            writeToolPathKeys: ctx.resolvedWriteToolPathKeys,
          });
          if (recordedTimeline.toolCalls.length > 0 || recordedTimeline.outputs.length > 0) {
            ctx.governorState.timeline.push({ round: record.round, ...recordedTimeline });
            ctx.governorState.timeline = ctx.governorState.timeline.slice(-12);
            for (const call of recordedTimeline.toolCalls) {
              if (ctx.resolvedWriteToolNames.has(call.name) && call.arg) {
                ctx.governorState.filesWritten.push({ path: call.arg, round: record.round });
                const trimFilesWritten = ctx.trimFilesWritten;
                trimFilesWritten();
              }
            }
            ctx.recordFileWrites(record.messages ?? [], record.round);
          }
        }
      }
      // 以最大 round 为续跑基数（含 round 0 种子记录时 records.length 会多算一轮）。
      // 双计数器约定（issue #32 #8）：`rounds` 是**身份**轮号，跨 resume 单调递增，
      // 只用于 round 编号 / roundKey / judge 已运行轮数展示 / run snapshot round；
      // 轮**预算**是 orchestrator 里每次 runToolLoop 从 0 起的 `budgetRounds`，
      // resume **不**把历史轮号当预算恢复（否则续接轮轮号已到顶，主循环一次进不了）。
      ctx.rounds = Math.max(...records.map((record) => record.round ?? 0));
      ctx.foldedThrough = Math.max(
        0,
        ...records.map((record) => record.foldedRoundRange?.to ?? 0),
      );
      const loadLatestSnapshot = typeof ctx.store.loadLatestRunSnapshot === "function"
        ? ctx.store.loadLatestRunSnapshot
        : typeof ctx.store.loadLatestCheckpoint === "function"
          ? ctx.store.loadLatestCheckpoint
          : undefined;
      if (loadLatestSnapshot !== undefined) {
        ctx.resumeRunSnapshot = await loadLatestSnapshot.call(ctx.store, ctx.runId);
        // 工单 261021（第三刀·恢复只认账本）：崩溃现场的**正文一律来自账本**，快照只剩
        // 「跑到一半的工具调用/状态」——改造前那套「拿 `snapshot.messages` 当上下文、再按锚点
        // 把账本里『快照没见过的那段』拼回去」的算法整体删除。理由：写侧已改成「一条消息一成型
        // 就落盘」（`orchestrator.js#appendMessageRowToTranscript`），于是本轮的 assistant 正文与
        // 已完成的工具结果**已经在账本里**；快照那份正文副本此时必然**落后于**账本（它写于工具执行
        // 之前），拿它当上下文就是把正文回滚，并把 `resumeTailMessages` 那套「对齐快照与账本」的
        // 匹配逻辑全部作废。锚点仍在（`persistedTranscriptLength`），但口径换成**纯账本口径**：
        // 崩溃时刻账本里已落盘的逻辑消息条数（见下面 `ledgerMessages` 与 `anchor`）。
        const crashToolUses = ctx.resumeRunSnapshot?.pendingToolUses
          ?? (ctx.resumeRunSnapshot?.pendingToolUse ? [ctx.resumeRunSnapshot.pendingToolUse] : []);
        const ledgerToolResultIds = new Set(ledgerMessages
          .flatMap((message) => blocksFor(message?.content))
          .filter((block) => block?.type === "tool_result")
          .map((block) => block.tool_use_id));
        const unfinishedToolUses = crashToolUses.filter((toolUse) => (
          toolUse?.id !== undefined && !ledgerToolResultIds.has(toolUse.id)
        ));
        // 「崩溃现场」的判据：快照里还有账本没结清的在飞工具/半截正文。没有（正常收口后追问）
        // ⇒ 上下文就是完整账本，一条快照正文都不需要。
        const crashSiteRound = unfinishedToolUses.length > 0
          || (ctx.resumeRunSnapshot?.toolResults ?? []).some((entry) => (
            entry?.toolResult?.tool_use_id !== undefined
            && !ledgerToolResultIds.has(entry.toolResult.tool_use_id)
          ))
          || (typeof ctx.resumeRunSnapshot?.partialText === "string"
            && ctx.resumeRunSnapshot.partialText.length > 0);
        if (crashSiteRound) {
          // 工单 261021（第三刀）·issue #425 ·锚点的**现算**口径：`persistedTranscriptLength` 过去
          // 读的是快照里那份**采样**（`saveRunSnapshot` 写出的那一刻 write === read），而 partialPersistence
          // 的定时器在流式正文成型之前就写了快照，之后工具结果行 / 终稿 assistant 行还会继续落盘 ⇒
          // 恢复时锚点比账本少，`slice(0, anchor)` 把**已经落盘的**正文当成尾队列，终稿正文被喂两遍
          // （实测 provider 上下文 4 条 vs 应有 3 条）。现在一律从账本现算：
          // `countResumeAnchor(records)` = 去掉尾部宿主追问行之后折出来的逻辑消息条数。
          // 于是「它之内的正文就是崩溃现场（含本轮已落盘的 assistant 正文与已完成的工具结果），
          // 它之外的行是崩溃**之后**由宿主追加的（`appendUserTurn` 的 `:input:` 行等），
          // 必须延后到补跑结果之后再接回」。
          const anchor = countResumeAnchor(records);
          ctx.messages = ledgerEntries.slice(0, anchor).map((entry) => cloneState(entry.message));
          for (const [index, message] of ctx.messages.entries()) {
            ctx.messageRounds.set(message, ledgerEntries[index].round);
          }
          ctx.resumeTailMessages = ledgerEntries.slice(anchor).map((entry) => ({
            message: cloneState(entry.message),
            round: entry.round,
          }));
          // **升级路径（不是旧逻辑的残留）**：改造前写的账本里，崩溃那一轮的正文**只在快照里**
          // （旧写侧把整轮正文留到轮末才写，而轮行因崩溃 never landed）。对这类旧账本，快照正文副本
          // 仍是它们唯一的正文来源 ⇒ 只在「账本在锚点之后一条都没有」时才拿快照里锚点之后的那段补全。
          // 新账本（逐条入账）永远不满足这个条件：崩溃轮的 assistant 正文/已完成的结果已在锚点之内，
          // 账本要么相等要么领先于快照 ⇒ 一份快照正文也不会多喂。
          const snapshotBody = Array.isArray(ctx.resumeRunSnapshot.messages)
            ? ctx.resumeRunSnapshot.messages : [];
          if (ledgerMessages.length === anchor && snapshotBody.length > anchor) {
            for (const [offset, message] of snapshotBody.slice(anchor).entries()) {
              const cloned = cloneState(message);
              ctx.messages.push(cloned);
              ctx.messageRounds.set(cloned, ctx.resumeRunSnapshot.round);
            }
          }
          // `resumeTranscriptStart` = 锚点（= 已落盘正文的条数）：下面那条 `…:resume` 行只写
          // **锚点之后**的正文（升级补全的那段 + 本次补跑跑出来的结果），已落盘的正文一行也不会重抄。
          ctx.resumeTranscriptStart = anchor;
          // 工单 261021（第三刀）：**补跑出来的工具结果也走「一条消息一成型就落盘」**——它们接在
          // 崩溃轮已落盘的那条聚合消息后面（`partOf` 指认它的首片行），于是下一次恢复折出来的仍是
          // 一条合法的 tool_use/tool_result 配对。两个信息只能从账本拿：本轮下一个可用 `seq`、以及
          // 该轮首片行的 dedupKey（无载体行时消息行原样留在 `load()` 输出里，所以两者都看得见）。
          const crashRound = ctx.resumeRunSnapshot.round;
          // issue #424（守卫事实）：崩溃轮的正文里**是否已有 assistant 行**——判据是**已折叠的账本条目**
          // （`ledgerEntries`，按轮号看），不是 `ctx.messages`：升级路径（旧账本 + 快照补全）会把崩溃轮的
          // assistant 正文从快照补进内存，账本里却没有那一行。本函数只把事实交出去，
          // 写不写由写侧决定（`orchestrator.js#journalResumeUnpersistedToolResults`）。
          ctx.resumeCrashRoundAssistantPersisted = ledgerEntries.some((entry) => (
            entry.round === crashRound && entry.message?.role === "assistant"
          ));
          // 两个只能从账本拿的信息：**本轮下一个可用的 `seq`**（否则重跑/续跑会在同 `(round, seq)`
          // 上携不同正文 ⇒ 去重冲突），以及**该轮首片行的 dedupKey**（无载体行时消息行原样留在
          // `load()` 输出里，所以两者都看得见）。seq 的地板取「该轮已有正文的条数」：折叠过的轮里
          // 消息行已被吸进载体、`seq` 看不见，宁可跳号也不能重号（跳号只是空号，重号是冲突）。
          const seqSeed = nextMessageSeqByRound(records);
          for (const record of records) {
            if (!Number.isSafeInteger(record?.round)) continue;
            const messageCount = (record.messages ?? []).length;
            if (messageCount === 0) continue;
            seqSeed.set(record.round, Math.max(seqSeed.get(record.round) ?? 0, messageCount));
          }
          for (const [round, nextSeq] of seqSeed) {
            ctx.messageSeqByRound.set(round, Math.max(ctx.messageSeqByRound.get(round) ?? 0, nextSeq));
          }
          ctx.resumeToolResultRowKey = records.reduce((found, record) => (
            record?.round === crashRound
            && record?.kind === MESSAGE_ROW_KIND
            && Number.isSafeInteger(record.seq)
            && typeof record.partOf !== "string"
            && (record.messages ?? []).some((message) => blocksFor(message?.content)
              .some((block) => block?.type === "tool_result"))
              ? rowKeyOf(record) : found
          ), undefined);
          // 崩溃现场的轮号：账本里本轮的行可能已落（逐条入账），故取两者的较大值，绝不回退轮号。
          ctx.rounds = Math.max(ctx.rounds, ctx.resumeRunSnapshot.round);
          const partialText = ctx.resumeRunSnapshot.partialText;
          const partialRound = ctx.resumeRunSnapshot.partialRound;
          // 半截正文只补**账本里还没有的那一段**：写侧已在本轮正文一成型就落盘，所以
          // 「快照里带 partialText 而本轮 assistant 行已落」是常见路径（工具执行期崩溃）；
          // 再补一次就是把同一份正文喂给模型两遍。判据：崩溃轮的 assistant 行已在锚点之内 ⇒ 不补。
          // ⚠ 这里必须读**轮号本身**（`ledgerEntries`）而不是拿克隆后的 `ctx.messages` 去查轮号表：
          // `ctx.messages` 是 `cloneState` 的副本，身份对不上，那种写法永远返回 false
          // ⇒ partialText 会被再喂一遗（实测改造前靠「上下文整体取自快照正文」逗着，不暴露这个问题）。
          const crashRoundAssistantPersisted = ledgerEntries
            .slice(0, anchor)
            .some((entry) => entry.message?.role === "assistant"
              && entry.round === ctx.resumeRunSnapshot.round);
          if (typeof partialText === "string" && partialText.length > 0
            && Number.isSafeInteger(partialRound)
            && partialRound === ctx.resumeRunSnapshot.round
            && !crashRoundAssistantPersisted) {
            const partialMessage = {
              role: "assistant",
              content: [{ type: "text", text: partialText }],
            };
            ctx.messages.push(partialMessage);
            ctx.messageRounds.set(partialMessage, partialRound);
          }
          for (const id of ctx.resumeRunSnapshot.executedToolIds ?? []) {
            ctx.resumeExecutedToolIds.add(id);
          }
          ctx.judgeInterceptCount = ctx.resumeExecutedToolIds.size;
          for (const entry of ctx.resumeRunSnapshot.toolResults ?? []) {
            if (entry?.toolUseId !== undefined && entry.toolResult !== undefined) {
              ctx.resumeRunSnapshotResults.set(entry.toolUseId, entry.toolResult);
            }
          }
          // 崩溃前已归档的全量输出回填引擎缓冲，保持证据的字节保真。
          for (const output of ctx.resumeRunSnapshot.toolOutputs ?? []) {
            if (typeof output?.content === "string" && output.content.length > 0) {
              ctx.archivedOutputs.push({
                toolUseId: output.toolUseId,
                name: output.name,
                round: ctx.resumeRunSnapshot.round,
                content: output.content,
              });
            }
          }
          pendingTail = pendingTailToolUses(ctx.messages);
          // 崩溃前已产出、但**没来得及落盘**的结果：账本里没有 ⇒ 从快照接回来。接回的位置很讲究：
          // 它们属于崩溃那一轮的那条聚合消息，必须**合进**账本里已落盘的那条（否则 assistant 的
          // tool_use 与紧随其后的 tool_result 条数对不上，`validateMessages` 当场报 invalid_messages）。
          // issue #420：判据是账本（`ledgerToolResultIds`）不是上下文
          // （`ctx.messages`）：升级路径可能已把结果补进上下文，
          // 账本里却仍没有那一行（合并自己按 id 去重）。
          const replayResults = [...ctx.resumeRunSnapshotResults.values()]
            .filter((toolResult) => !ledgerToolResultIds.has(toolResult.tool_use_id));
          if (replayResults.length > 0) {
            if (mergeToolResultsIntoMessages(ctx.messages, replayResults) === false) {
              const replayMessage = { role: "user", content: replayResults };
              ctx.messages.push(replayMessage);
              ctx.messageRounds.set(replayMessage, ctx.resumeRunSnapshot.round);
            }
            // issue #420：**真实交接**（修前是死字段，注释承诺的入账
            // 全仓无读取方）。`restoreResume` 的 resume 分支只读 transcript 账本；
            // 账本写入一律在 orchestrator（`appendMessageRowToTranscript` / `persist`），
            // 失败语义与 `seq` 计数器只有一处。写入口在 orchestrator 的
            // `journalResumeUnpersistedToolResults`：补跑段之前逐条写成消息行。
            ctx.resumeUnpersistedToolResults = replayResults;
          }
          const pendingTools = ctx.resumeRunSnapshot.pendingToolUses
            ?? (ctx.resumeRunSnapshot.pendingToolUse
              ? [ctx.resumeRunSnapshot.pendingToolUse]
              : []);
          ctx.resumePendingTools = pendingTools.filter((pendingTool) => (
            !ctx.resumeRunSnapshot.executedToolIds?.includes(pendingTool.id)
            && !ctx.resumeRunSnapshotResults.has(pendingTool.id)
            // 账本已经结清的结果不再补跑（逐条入账后，这是「已落盘」的权威口径）。
            && !ledgerToolResultIds.has(pendingTool.id)
          ));
        }
      } else {
        // issue #78 验收修正：resume 想消费 run snapshot 但 store 无任何 loader——
        // 单条去重诊断（loadLatestCheckpoint 旧名也缺才走到这里），跳过崩溃现场恢复。
        ctx.notifyCapabilitySkipped?.("loadLatestRunSnapshot");
      }
      // issue #404：恢复运行要告诉模型这是复活赛（拼装/幂等见 `src/loop/resume-notice.js`）。
      ctx.resumeNotice = planResumeNotice(ctx, records, pendingTail);
    } catch (error) {
      const fail = ctx.fail;
      await fail(error);
    }
  } else if (ctx.store && ctx.runId !== undefined && ctx.messages.length > 0) {
    // 种子记录：初始消息（initialMessages/initialUserMessage）先入档，
    // 否则它们永不在 store 中，fold 后的初始历史将无法用于恢复（ADR-002 档案完整性）。
    const persist = ctx.persist;
    const persisted = await persist("appendRound", ctx.runId, {
      round: 0,
      roundKey: `${String(ctx.runId)}:round:0`,
      // 引擎命名空间：宿主/上一次运行的默认键行不应把本次种子去重没（transcript 完整性）
      dedupKey: `${String(ctx.runId)}:engine:round:0:seed`,
      messages: [...ctx.messages],
      summary: "missing",
      l0facts: extractL0Facts(ctx.messages),
      ts: new Date().toISOString(),
    });
    if (persisted) ctx.persistedTranscriptLength += ctx.messages.length;
  }
}
