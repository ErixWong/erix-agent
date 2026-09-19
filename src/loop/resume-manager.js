import { cloneState } from "./budget.js";
import { blocksFor } from "./messages.js";
import { extractL0Facts } from "../reflection/l0.js";
import { buildTimeline } from "../reflection/judge.js";
import { validateRunState } from "../run-state.js";

export async function restoreResume(ctx) {
  if (!ctx.persistenceRequired) return;

  const restoreRunState = (restored) => {
    const validation = validateRunState(restored);
    if (!validation.ok) {
      ctx.runStateAvailability = {
        status: validation.status,
        reason: validation.reason,
      };
      return false;
    }
    applyRestoredRunState(validation.state);
    return true;
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
    ctx.nonReplayableCaptureCount = deterministic.fold?.nonReplayableCaptures ?? 0;
    ctx.unrecoverableCaptureCount = deterministic.fold?.unrecoverableCaptures ?? 0;
    ctx.toolErrorCount = deterministic.errors?.tool ?? 0;
    ctx.checkpointFailureCount = deterministic.errors?.checkpoint ?? 0;
    ctx.archiveFailureCount = deterministic.errors?.archive ?? 0;
    ctx.governorState.filesWritten = Array.isArray(deterministic.filesWritten)
      ? deterministic.filesWritten.map((path) => ({ path }))
      : [];
    ctx.todoState = deterministic.todo;
    ctx.semanticState = restored.semantic;
  };

  const restorePersistedRunState = async () => {
    if (!ctx.resume || typeof ctx.store?.loadRunState !== "function"
      || ctx.runId === undefined) return;
    const stored = await ctx.store.loadRunState(ctx.runId);
    if (stored === undefined) return;
    const restored = stored?.runState && typeof stored.runState === "object"
      ? stored.runState
      : stored;
    restoreRunState(restored);
  };

  const markRunState = ctx.markRunState;
  await markRunState("running");
  await restorePersistedRunState();
  if (ctx.resume && ctx.store && ctx.runId !== undefined) {
    try {
      const records = await ctx.store.load(ctx.runId);
      if (records.length === 0) throw new Error("resume: 无可恢复记录");
      if (ctx.currentRunState === undefined) {
        const latestStateRecord = [...records].reverse().find((record) => (
          record?.runState && typeof record.runState === "object"
        ));
        if (latestStateRecord?.runState !== undefined) {
          restoreRunState(latestStateRecord.runState);
        }
      }
      const restoredMessages = records.flatMap((record) => record.messages ?? []);
      const seedRecords = records.filter((record) => (record.round ?? 0) === 0);
      const seedMessages = seedRecords.flatMap((record) => record.messages ?? []);
      ctx.taskBriefSource = seedRecords.length > 0 ? seedMessages : [];
      ctx.messages = restoredMessages;
      ctx.persistedTranscriptLength = ctx.messages.length;
      for (const record of records) {
        for (const message of record.messages ?? []) {
          ctx.messageRounds.set(message, record.round ?? 0);
        }
        if ((record.round ?? 0) > 0) {
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
          }
        }
      }
      // 以最大 round 为续跑基数（含 round 0 种子记录时 records.length 会多算一轮）。
      // 双计数器约定（issue #32 #8）：`rounds` 是**身份**轮号，跨 resume 单调递增，
      // 只用于 round 编号 / roundKey / judge 已运行轮数展示 / checkpoint round；
      // 轮**预算**是 orchestrator 里每次 runToolLoop 从 0 起的 `budgetRounds`，
      // resume **不**把历史轮号当预算恢复（否则续接轮轮号已到顶，主循环一次进不了）。
      ctx.rounds = Math.max(...records.map((record) => record.round ?? 0));
      ctx.foldedThrough = Math.max(
        0,
        ...records.map((record) => record.foldedRoundRange?.to ?? 0),
      );
      if (typeof ctx.store.loadLatestCheckpoint === "function") {
        ctx.resumeCheckpoint = await ctx.store.loadLatestCheckpoint(ctx.runId);
        if (ctx.resumeCheckpoint?.round > ctx.rounds
          && Array.isArray(ctx.resumeCheckpoint.messages)) {
          const recordedEntries = [];
          for (const record of records) {
            for (const message of record.messages ?? []) {
              recordedEntries.push({
                message,
                round: record.round ?? 0,
              });
            }
          }
          const checkpointAnchor = Number.isSafeInteger(
            ctx.resumeCheckpoint.persistedTranscriptLength,
          ) && ctx.resumeCheckpoint.persistedTranscriptLength >= 0
            ? Math.min(ctx.resumeCheckpoint.persistedTranscriptLength, recordedEntries.length)
            : undefined;
          let searchFrom = 0;
          let lastMatchedIndex = -1;
          const checkpointMessageRounds = [];
          const checkpointMessageIndices = [];
          for (const message of ctx.resumeCheckpoint.messages) {
            const key = JSON.stringify(message);
            let matchedIndex = -1;
            for (let index = searchFrom; index < recordedEntries.length; index += 1) {
              if (JSON.stringify(recordedEntries[index].message) === key) {
                matchedIndex = index;
                break;
              }
            }
            if (matchedIndex === -1) {
              checkpointMessageRounds.push(undefined);
              checkpointMessageIndices.push(-1);
              continue;
            }
            searchFrom = matchedIndex + 1;
            lastMatchedIndex = matchedIndex;
            checkpointMessageRounds.push(recordedEntries[matchedIndex].round);
            checkpointMessageIndices.push(matchedIndex);
          }
          ctx.resumeTailMessages = recordedEntries
            .slice(checkpointAnchor ?? lastMatchedIndex + 1)
            .map((entry) => ({
              message: cloneState(entry.message),
              round: entry.round,
            }));
          ctx.messages = cloneState(ctx.resumeCheckpoint.messages);
          ctx.resumeTranscriptStart = ctx.messages.length;
          ctx.resumeCheckpointMessages = ctx.messages.filter((_message, index) => {
            const matchedIndex = checkpointMessageIndices[index];
            const isPersisted = matchedIndex >= 0
              && (checkpointAnchor === undefined || matchedIndex < checkpointAnchor);
            return !isPersisted && blocksFor(_message?.content).some((block) => (
              block?.type === "tool_use" || block?.type === "tool_result"
            ));
          });
          for (const [index, message] of ctx.messages.entries()) {
            ctx.messageRounds.set(
              message,
              checkpointMessageRounds[index] ?? ctx.resumeCheckpoint.round,
            );
          }
          ctx.rounds = ctx.resumeCheckpoint.round;
          for (const id of ctx.resumeCheckpoint.executedToolIds ?? []) {
            ctx.resumeExecutedToolIds.add(id);
          }
          ctx.judgeInterceptCount = ctx.resumeExecutedToolIds.size;
          for (const entry of ctx.resumeCheckpoint.toolResults ?? []) {
            if (entry?.toolUseId !== undefined && entry.toolResult !== undefined) {
              ctx.resumeCheckpointResults.set(entry.toolUseId, entry.toolResult);
            }
          }
          // ADR-015：崩溃前已归档的全量输出回填引擎缓冲（byte fidelity：recall 仍可取回）
          for (const output of ctx.resumeCheckpoint.toolOutputs ?? []) {
            if (typeof output?.content === "string" && output.content.length > 0) {
              ctx.archivedOutputs.push({
                toolUseId: output.toolUseId,
                name: output.name,
                round: ctx.resumeCheckpoint.round,
                content: output.content,
              });
            }
          }
          const recordedIds = new Set(
            ctx.messages.flatMap((message) => blocksFor(message?.content))
              .filter((block) => block?.type === "tool_result")
              .map((block) => block.tool_use_id),
          );
          const replayResults = [...ctx.resumeCheckpointResults.values()]
            .filter((toolResult) => !recordedIds.has(toolResult.tool_use_id));
          if (replayResults.length > 0) {
            const replayMessage = { role: "user", content: replayResults };
            ctx.messages.push(replayMessage);
            ctx.messageRounds.set(replayMessage, ctx.resumeCheckpoint.round);
          }
          const pendingTools = ctx.resumeCheckpoint.pendingToolUses
            ?? (ctx.resumeCheckpoint.pendingToolUse
              ? [ctx.resumeCheckpoint.pendingToolUse]
              : []);
          ctx.resumePendingTools = pendingTools.filter((pendingTool) => (
            !ctx.resumeCheckpoint.executedToolIds?.includes(pendingTool.id)
            && !ctx.resumeCheckpointResults.has(pendingTool.id)
          ));
        }
      }
    } catch (error) {
      const fail = ctx.fail;
      await fail(error);
    }
  } else if (ctx.store && ctx.runId !== undefined && ctx.messages.length > 0) {
    // 种子记录：初始消息（initialMessages/initialUserMessage）先入档，
    // 否则它们永不在 store 中——recall 在 fold 后找不到被折的初始历史（ADR-002 档案完整性）
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
