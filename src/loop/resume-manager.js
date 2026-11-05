import { cloneState } from "./budget.js";
import { blocksFor, mergeToolResultsIntoMessages } from "./messages.js";
import { MESSAGE_ROW_KIND, nextMessageSeqByRound, foldLedgerMessages, foldMessageRows } from "../store/message-rows.js";
import { extractL0Facts } from "../reflection/l0.js";
import { buildTimeline } from "../reflection/judge.js";
import { pendingTailToolUses, answerPendingMidSequenceToolUses } from "./pending-tool-result.js";
import { planResumeNotice } from "./resume-notice.js";
import { injectFoldSummaryIntoHead, planFoldedHistoryTrim } from "../compact/resume-fold-trim.js";
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
// 现算口径统计折叠后的逻辑消息条数，**尾部**的宿主追问行不算（它属于尾队列，补跑结果之后再接回）。
// 只排除**尾部**的宿主行：上一次恢复留下的追问行夹在中间时，它已经在模型的上下文里了，必须计入
// （否则按条数切片会切在一条逻辑消息中间，或者把历史追问挤进尾队列）。
//
// 归属判据 = **键 + 形状**两件事实，顺序是「键优先、形状兜底」（issue #425 评审阻塞）：
//   ① 键是引擎**独占**命名空间 = `:engine:`（`<runId>:engine:…`；`:resume` / `:control:` / `:fold:` /
//      `:ttl:` 这些载体**都写在 `:engine:` 下面**）⇒ 引擎行。**必须按键先判**：这些载体的形状**也可能**是
//      「单条 user/text」（`…:engine:round:<n>:control:resume-notice` 带一条真消息就是那一格），形状判据
//      优先就会把引擎自己的载体误判成宿主尾队列。⚠ 独占命名空间**只有** `:engine:`：裸 `:control:` 不是
//      （把它并进来，`myapp:control:x` 这类契约内合法的宿主自定键会被判成引擎行 ⇒ 0 请求 + `invalid_messages`）。
//   ② 键是宿主命名空间（`<runId>:input:…`，`src/store/append-user-turn.js`）或宿主自定键 ⇒ 宿主行。
//   ③ 键**不足以**定归属——`<runId>:round:<n>`（契约 `docs/host-consumer-contract.md` 自己叫它
//      "host default key"，宿主照抄它完全合法）、`<runId>:msg:<round>:<seq>`（引擎逐条消息行用过的
//      命名空间）、以及**根本没有键**的远古行 ⇒ 看**形状**：`appendUserTurn` 的产出形状是
//      `{ round, messages: [user(text)], dedupKey, roundKey, ts }`，即「没有 `kind`、没有安全整数
//      `seq`、恰好一条 `role:"user"` 消息、content 全是 text」⇒ 宿主预写行；其余 ⇒ 引擎行。
//      引擎自己的 `<runId>:msg:` 行**恒带** `kind:"message"` 与安全整数 `seq`，老账本的
//      `<runId>:round:<n>` 轮行带的是整轮正文（assistant / tool_result），两者都落不进那个形状。
//
// 为什么不能只认键（旧口径，`key === "" || /:(?:engine|msg|round):/`）：宿主用引擎形态的键或干脆
// 不写键时，它的追问行被算进**崩溃现场** ⇒ 补跑结果插错位置 ⇒ `invalid_messages` + **零请求**
// （现场已落 1 条结果行时是**静默改序**：宿主追问排到【恢复运行】告示**之前**，与契约的形状相反）。
// 契约只写宿主 **should** 走 `appendUserTurn`（`:1090`），`:964` 还允许 dedup 回落到 store 生成的
// `<runId>:round:<n>`，`orchestrator.js` 的注释也明写「宿主可能已用默认键」——按「必须走
// `appendUserTurn`」立论，就是把 main 上可恢复的现场改成永久不可恢复。
const ENGINE_ONLY_KEY = /:engine:/u;
const AMBIGUOUS_KEY = /:(?:msg|round):/u;

/** `appendUserTurn` 的产出形状（宿主预写行）：没有 `kind` / 安全整数 `seq`，恰好一条 `user` 消息，
 * content 全是 `text` 块。形状判据只回答「像不像宿主预写行」，**不**单独决定归属（见上面的顺序）。
 * @param {any} record
 * @returns {boolean}
 */
function hasHostPreWriteShape(record) {
  if (record?.kind !== undefined) return false;
  if (Number.isSafeInteger(record?.seq)) return false;
  const messages = record?.messages;
  if (!Array.isArray(messages) || messages.length !== 1) return false;
  const [message] = messages;
  if (message?.role !== "user") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.length > 0 && content.every((block) => block?.type === "text");
}

/** 这一行是不是引擎自己写的账本行。判别顺序见上面那段注释：键独占 ⇒ 引擎；宿主命名空间/自定键 ⇒
 * 宿主；**键不足以定归属时**（`:round:` / `:msg:` / 无键）才看形状。
 * 实例（「形状像预写、但按键归引擎」）：`{ dedupKey: "r:engine:round:1:control:resume-notice",
 * messages: [userText("【恢复运行】…")] }` 形状与宿主预写行逐字相同，但键是引擎独占命名空间 ⇒ 引擎行。
 * @param {any} record
 * @returns {boolean}
 */
function isEngineLedgerRow(record) {
  const key = rowKeyOf(record);
  if (ENGINE_ONLY_KEY.test(key)) return true;
  if (key !== "" && !AMBIGUOUS_KEY.test(key)) return false;
  return !hasHostPreWriteShape(record);
}

/**
 * 恢复锚点：账本里「崩溃那一刻**已经落盘**」的折叠逻辑消息条数（issue #425）。
 *
 * 纯函数，单一职责：输入账本行（`store.load()` 的折叠行或原始行都行），输出条数。
 * 口径 = 去掉**尾部**宿主行之后，按 `foldLedgerMessages` 折出来的逻辑消息数
 * （`partOf` 分片接回它指认的那条消息，分片不加）。
 *
 * 为什么不是「全账本条数」：宿主追问行（`…:input:…`，或宿主用默认键 / 无键写的预写行）是崩溃之后
 * 才写的，把它算进崩溃现场会让补跑结果插到它前面（`validateMessages` 当场 `invalid_messages`）。
 * 为什么不是「只数引擎行」：上一次恢复留下的追问行夹在中间，只数引擎行会把条数压小，
 * 切片同样会错位。
 *
 * @param {Array<object>} records
 * @returns {number}
 */
export function countResumeAnchor(records) {
  const rows = Array.isArray(records) ? records : [];
  let end = rows.length;
  // `end > 1`：账本的**第一行**是这个 run 的种子（round 0，引擎在任何请求之前写的），它不是「崩溃之后
  // 宿主追加的」东西，尾队列最多从第二行开始。这一条同时把「无键的远古种子行」从形状判据的歧义里救回来：
  // 它与宿主预写行都是「单条 user/text」形状，区别只在**位置**（种子在最前、追问在末尾）。
  while (end > 1 && !isEngineLedgerRow(rows[end - 1])) end -= 1;
  return foldLedgerMessages(rows.slice(0, end)).length;
}

/**
 * issue #421：把「上下文里那条聚合 `tool_result` user 消息」映射回**账本里承载它的那一行**的 key。
 *
 * 为什么需要：中段补桩要落成一条 `partOf` 指向**该聚合消息首片**的分片行（#430 的纪律：锚点只钉在
 * 首片、分片 key 不是合法的 `partOf` 目标），而折叠后的逻辑消息序列里看不出「这条消息是哪一行落的」。
 * 判据：`kind:"message"` + 安全整数 `seq` + **首片**（无 `partOf`）+ 轮号相同 + user 消息，且**第一个
 * block** 就是那条聚合消息的第一个 `tool_result`（写侧每个结果单独落一行，首片 content 就是
 * `[toolResult]` ⇒ 首个 `tool_use_id` 足以认人）。
 *
 * 找不到 ⇒ 返回 `undefined`，调用方**不入账**、只留内存里的桩。硬写一行会被折叠层当成「该轮多出来的
 * 一条正文」⇒ 桩变成另一条 user 消息（孤立 `tool_result`），比修前更坏。
 *
 * 入参是**落盘行**：`store.load()` 的返回值，或（issue #714）store 提供的可选原始行读口
 * `loadRawRows` 的未折叠行。后者是**已完成轮**那一格的唯一出路：内置两个 store 的 `load()` 都跑
 * `foldMessageRows`，那种轮的消息行已被吸进轮载体 ⇒ 折叠后的行里没有合法的 `partOf` 目标。store
 * 不提供这个读口 ⇒ 这一格退回修前口径（只修本次内存 + `resume_journal_skipped`），那是**缺能力时的
 * 降级**，不是设计终态。
 *
 * 残留风险（有意接受）：provider `id` 不保证 run 内唯一（issue #284），同轮两条聚合消息首个
 * `tool_use_id` 相同时会认到先出现的那一行 ⇒ 桩落进同轮另一条聚合消息（不报错、不丢块，形状不对）。
 *
 * @param {any[]} rows `store.load()` 返回的行
 * @param {any} message 上下文里的那条聚合消息
 * @param {number|undefined} round 该消息的轮号
 * @returns {string|undefined}
 */
function firstSliceRowKeyOf(rows, message, round) {
  const head = blocksFor(message?.content).find((block) => block?.type === "tool_result");
  if (head === undefined || head.tool_use_id === undefined) return undefined;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== MESSAGE_ROW_KIND) continue;
    if (!Number.isSafeInteger(row.seq)) continue;
    if (typeof row.partOf === "string" && row.partOf !== "") continue;
    if (Number.isSafeInteger(round) && Number.isSafeInteger(row.round) && row.round !== round) continue;
    const [only] = Array.isArray(row.messages) ? row.messages : [];
    if (only?.role !== "user") continue;
    const first = blocksFor(only.content)[0];
    if (first?.type === "tool_result" && first.tool_use_id === head.tool_use_id) return rowKeyOf(row);
  }
  return undefined;
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
      // 账本里**已经有结果行**的 `tool_use` id（「已结清」的权威口径，issue #420）。
      // 提到这里（原本在下面快照分支里）是因为 issue #421 的中段兜底也要它，而那条路
      // 与「有没有快照」无关：判据是账本，不是快照。
      const ledgerToolResultIds = new Set(ledgerMessages
        .flatMap((message) => blocksFor(message?.content))
        .filter((block) => block?.type === "tool_result")
        .map((block) => block.tool_use_id));
      const seedRecords = records.filter((record) => (record.round ?? 0) === 0);
      const seedMessages = seedRecords.flatMap((record) => record.messages ?? []);
      ctx.taskBriefSource = seedRecords.length > 0 ? seedMessages : [];
      // 工单 261021（第三刀·恢复只认账本）：逻辑消息序列是崩溃/续跑上下文的**唯一正文来源**。
      // 口径不是裸 `records.flatMap(record.messages)`，而是 `foldLedgerMessages(records)`：
      // 它把 `partOf` 分片接回它指认的那条消息（分片不加一条），**与载体行在场无关**
      // （理由见 `src/store/message-rows.js` 里该函数的注释）。
      // issue #425：折叠口径仍与写侧**同源**，但恢复侧已经**不读**写侧那个计数了——
      // `persistedTranscriptLength` 是快照里的采样（写侧 `+= n` 逐条累加，去重命中时还会多算），
      // 恢复锚点改由 `countResumeAnchor(records)` 在账本上**现算**（多算对它彻底惰性）。
      // 两者共同点只剩「分片不加」这一条折叠规则，不再是一条等价的计数。
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
          // issue #470 判据②：这一格**不再合成字面量** `"missing"`。写侧 `parseL1Summary` 的既定
          // 兜底串（#465 已确认它是 L1 摘要的既定形状）在这里同样归一成「无摘要」⇒ judge 看到的轮次
          // 历史里不会再出现一串它没法判别真假的占位文本。条目**本身**照旧生成：governor 的历史条数
          // 与 `stalled` 的输入逐字不变，上面 `isEngineFactRow`（#326）的守卫也不动。
          const summary = record.summary === "missing" ? undefined : record.summary;
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
        // 匹配逻辑全部作废。锚点仍在（现在是**恢复时现算**的 `countResumeAnchor(records)`，issue #425），
        // 口径是**纯账本口径**：崩溃时刻账本里已落盘的逻辑消息条数（见下面 `ledgerMessages` 与 `anchor`）。
        const crashToolUses = ctx.resumeRunSnapshot?.pendingToolUses
          ?? (ctx.resumeRunSnapshot?.pendingToolUse ? [ctx.resumeRunSnapshot.pendingToolUse] : []);
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
      // ── issue #421：**中段**悬空 `tool_use` 的读侧兜底 ────────────────────────────────────
      // 位置：上下文重建完（含 A 集合的内存合并）之后、**任何模型请求之前**、任何裁剪之前（裁剪只动
      // 上下文，不动账本；桩要跟着它所属的那条聚合消息走）。
      // 判据是**账本**（`ledgerToolResultIds`，#420 口径），再并上**本进程马上要产出真结果**的两批：
      // A 集合（结果已成型、只差入账）与 B 集合（补跑段会重跑并接回同一条聚合消息）。这两批必须排除：
      // 它们的真结果会并进那条聚合消息，而桩已占了同一个 `tool_use_id` ⇒ 同一条消息里出现两个同 id 的
      // `tool_result` ⇒ id 集合对不上（补桩反而把可恢复的现场变成不可恢复）。这不是放宽判据：
      // 能配上对的不得出现桩行。
      const midSequenceSettledIds = new Set(ledgerToolResultIds);
      for (const toolResult of ctx.resumeUnpersistedToolResults) {
        if (toolResult?.tool_use_id !== undefined) midSequenceSettledIds.add(toolResult.tool_use_id);
      }
      for (const pendingTool of ctx.resumePendingTools) {
        if (pendingTool?.id !== undefined) midSequenceSettledIds.add(pendingTool.id);
      }
      // 入账由 orchestrator（`journalResumeMidSequenceToolResults`）用 `partOf` 指向**首片**完成；
      // 这里只交出「补了哪几张、该写向哪一行」。锚点在**落盘行**上找，不是引擎再折一遍的 `records`：
      // 后者里的消息行可能已被吸进载体（没有 `seq`、也就没有 `partOf` 目标）。
      // issue #714：可选原始行读口 `loadRawRows` 交出 `load()` 的**未折叠输入**。内置两个 store 的
      // `load()` 都折叠，**已完成轮**的首片行只剩在原始行里 ⇒ 没有它那一格永远拿不到锚点；提供它时
      // 账本才闭合。缺这个读口 ⇒ 逐字退回修前口径（只修内存 + `resume_journal_skipped`），不抛错。
      const anchorRows = typeof ctx.store.loadRawRows === "function"
        ? await ctx.store.loadRawRows(ctx.runId)
        : loadedRecords;
      const midSequenceStubs = await answerPendingMidSequenceToolUses(ctx.messages, {
        settledIds: midSequenceSettledIds,
        roundOf: (message) => ctx.messageRounds.get(message),
        anchorOf: (message) => firstSliceRowKeyOf(
          anchorRows,
          message,
          ctx.messageRounds.get(message),
        ),
      });
      ctx.resumeMidSequenceToolResults = midSequenceStubs;
      // 真要落账的那几张桩：把所属轮的 `seq` 地板抬到「落盘行里最大 `seq` + 1」。本单是第一个往
      // **已完成轮**写消息行的调用点，而那种轮的消息行在折叠后的行里已被吸进载体 ⇒ 崩溃现场那一段的
      // 「按正文条数」地板会算小，分片行重号 ⇒ `dedup_payload_conflict`（既不覆盖也不静默丢弃，整 run
      // 崩）。地板与锚点**同源**（`anchorRows`：原始行看得见 `seq`）。没有桩要写 ⇒ 一个字节都不碰。
      const journaledRounds = new Set(midSequenceStubs
        .filter((stub) => typeof stub?.partOf === "string" && stub.partOf !== "")
        .map((stub) => stub.round)
        .filter((round) => Number.isSafeInteger(round)));
      if (journaledRounds.size > 0) {
        const rawSeqSeed = nextMessageSeqByRound(anchorRows);
        for (const round of journaledRounds) {
          const floor = rawSeqSeed.get(round);
          if (floor === undefined) continue;
          ctx.messageSeqByRound.set(round, Math.max(ctx.messageSeqByRound.get(round) ?? 0, floor));
        }
      }
      // issue #462：**按折叠水位线裁续跑正文**（#460 只修了写侧，读侧一个字节都没省）。
      // 今天 `ctx.messages` 是整段未折账本 ⇒ 续跑第一次折叠必然从 round 1 重折：摘要器重算
      // （#326 的复用因区间漂移而 miss）、`keepRounds` 被 2× 判据压到 2、`tokensBefore` 虚高。
      // 这里把水位线以下的轮次从上下文里摘掉，并把**模型本来就在看的那份摘要**（#326 落的
      // `record.foldedSummary` 事实）按折叠自己的形状并回头部 ⇒ 续跑形状回到崩溃前那一刻。
      // 挑不出覆盖水位线的摘要事实时**整段原样保留**（判据 3：被误判成未折的区间必须在上下文
      // 里可见，不许档案与上下文两边都静默）。口径与边界见 `src/compact/resume-fold-trim.js`。
      const foldWatermark = ctx.foldedThrough;
      const contextEntries = ctx.messages.map((message) => ({
        message,
        round: ctx.messageRounds.get(message) ?? 0,
      }));
      const foldTrim = planFoldedHistoryTrim({
        ledgerEntries: contextEntries,
        records,
        foldedThrough: foldWatermark,
      });
      if (foldTrim.applied) {
        const keptMessages = foldTrim.messages.map((entry) => entry.message);
        const trimmedMessages = injectFoldSummaryIntoHead(keptMessages, foldTrim.summaryText);
        // 轮号表按**对象身份**查（`orchestrator.js#roundNumbersForMessages`），而注入会换掉那条
        // head 消息的对象（或插一条新的）⇒ 必须把轮号一并搬过去，否则那条 seed 任务的轮号会从
        // 0 掉进兜底分支，把已折区间重新数进轮号。
        const roundByNewMessage = new Map();
        if (trimmedMessages.length === keptMessages.length) {
          for (const [index, message] of trimmedMessages.entries()) {
            roundByNewMessage.set(message, foldTrim.messages[index].round);
          }
        } else {
          // 注入成独立 user 消息（只有 head 里没有真实 user 消息时才走到这里）：那条正文属于
          // 已折区间，按水位线记轮号最贴近它被折走时的身份。
          let cursor = 0;
          for (const message of trimmedMessages) {
            const entry = foldTrim.messages[cursor];
            if (entry !== undefined && entry.message === message) {
              roundByNewMessage.set(message, entry.round);
              cursor += 1;
            } else {
              roundByNewMessage.set(message, foldWatermark);
            }
          }
        }
        for (const entry of foldTrim.dropped) {
          ctx.messageRounds.delete(entry.message);
        }
        for (const [message, round] of roundByNewMessage) {
          ctx.messageRounds.set(message, round);
        }
        ctx.messages = trimmedMessages;
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
