// 工具执行器（issue #83：原「checkpoint 执行器」统一更名为 run snapshot 执行器）：执行工具块、
// judge 拦截审计、以及工具前后的 run snapshot 落盘。
//
// 本模块有意保留的旧术语（宿主可见契约，改名属破坏性变更，issue #83 不动）：
//   - 错误码 `checkpoint_failed`：docs/host-upgrade-guide-v030*.md / docs/decisions/002-* 已对外文档化
//   - 诊断 phase `checkpoint_before_tool` / `checkpoint_after_tool`：随 `persistence_error` 事件
//     与抛出的 KitError 暴露给宿主（test/persistence-diagnostics.test.js 断言）
//   - 抛出错误的英文 message 文本：宿主日志/正则可能匹配
import { KitError } from "../providers/errors.js";
import { cloneState } from "./budget.js";
import { throwIfAborted } from "./abort.js";
import {
  mergeToolResultsIntoMessages,
  toolResultContent,
  toolResultData,
} from "./messages.js";
import { JUDGE_DONE_CONFIDENCE_THRESHOLD, directionHintText, judgeDoneAdvisoryText } from "./reflection.js";
import { terminationErrorCodeForError } from "./termination.js";
import { buildToolResultFact } from "../tool-fact.js";
import {
  aggregateStubText,
  aggregateUnrecoverableStubText,
  createRoundAggregateGate,
  errorSnippet,
} from "./aggregate-budget.js";

// run snapshot 落盘失败的 fail-closed 收口（issue #174：原先四处 pre/post-tool 检查逐字重复）：
// 计数 +1，并把底层持久化失败明细并入对外的 `checkpoint_failed` KitError（宿主可见契约）。
// phase/sideEffect 由调用点给出（工具是否已执行、是否留下外部副作用），
// operation/persistence/persistenceError 从 lastPersistenceFailure 透传；
// 落盘成功或本次 run 没有 snapshot store 时静默返回（语义与合并前的四段 if 完全一致）。
//
// issue #230：两个出口（run 末尾的 `persistence_failed` 与工具调用点的 `checkpoint_failed`）描述的
// 是同一次底层故障，字段面必须对称——宿主分流「可恢复/要不要重放」时不该去解析 `message` 字符串
// （那正是 #176 要消灭的用法）。对称的不只是**键名**，还有**取值类型**：同名字段两种类型同样等于
// 「宿主只能靠读源码才知道」。因此这里补三个字段，且**不另造口径**：
//   · `cause`       —— **错误对象本身**，与 `persistence_failed.cause` 同型：取链上最深那一环
//                     （`lastPersistenceFailure.cause` 是 store 自己抛的那个错），没有 store 失败明细时
//                     退回本次持久化失败（`lastPersistenceFailure` 本身）；
//   · `errorCode`   —— 字符串，走 `terminationErrorCodeForError`（`error.code`，取不到即 `"unknown"`），
//                     与 `termination.errorCode` 同一个根因分类函数、同一套口径 ⇒ 「只要分类结果的宿主」
//                     仍然一步拿到，不必自己从 `cause` 上摸 `.code`；
//   · `unpersisted` —— 与 `persistence_failed` 同一形状：**原始数组**（`errorLedger.toUnpersisted()`，#109
//                     冻结的 schema）。`{ count, items }` 投影只属于 `state.json` 那条路径
//                     （`run-state.js` 的 `deterministic.errors.unpersisted`），不塞进错误对象。
// 三个字段**无条件写**：缺字段会让「对称」这条契约变成有条件成立。可达性上这也成立——能走到这里的
// 前提是 `ctx.hasRunSnapshotStore`（= `persistenceRequired && snapshotSaveMethod !== undefined`），
// 而 `persist()` 只在同一条件下才可能返回 `false`（方法缺失时它直接返回且不置 `lastPersistenceFailure`），
// 所以 `previous` 恒为本次那次失败的 `persistence_failed`。
// `cause` 经 `KitError` 的 `{ cause }` 选项进构造函数（不是事后赋值）：`Error` 把 `cause` 定义为
// **不可枚举**自有属性，`persistence_failed` 的 `cause` 也是这么来的——字段面要对称就不能一边
// 可枚举一边不可枚举（`Object.keys` / `{ ...error }` 会给出不同形状）。
function assertSnapshotPersisted(ctx, persisted, { phase, sideEffect, message }) {
  if (persisted || !ctx.hasRunSnapshotStore) return;
  ctx.runSnapshotFailureCount += 1;
  const previous = ctx.lastPersistenceFailure;
  const rootCause = previous?.cause ?? previous;
  const failure = new KitError("checkpoint_failed", message, { cause: rootCause });
  if (previous) {
    failure.operation = previous.operation;
    failure.phase = phase;
    failure.sideEffect = sideEffect;
    failure.persistence = previous.persistence;
    failure.persistenceError = previous.persistenceError;
  }
  // `KitError` 的 JSDoc 没声明这两个 additive 字段（改 `providers/errors.js` 的类形状会动公共面）⇒
  // 用 `Object.assign` 写入：`--checkJs` 棘轮因此不多背 TS2339（#214 的「只减不增」）。
  Object.assign(failure, {
    errorCode: terminationErrorCodeForError(rootCause),
    unpersisted: ctx.errorLedger?.toUnpersisted?.() ?? [],
  });
  throw failure;
}

// 只读工具集合（issue #33 C）：拦截 judge 对这类工具放行——只读调用无外部副作用，
// uncertain/off_track 时拦它净收益为负（实测 readFile 被拦后缺陷反而漏出）。
// exec/writeFile/mcp 等写路径不在此列，维持拦截语义不变。
export const READONLY_INTERCEPT_TOOLS = new Set([
  "readFile",
  "tree",
  "rg",
  // issue #195：`searchText` 是搜索的规范入口，`rg` 已经是它的别名。少了这一项就会出现
  // 「别名走只读放行、继任入口被拦」的迁移陷阱——同一件事换个名字，run 的行为就变了。
  "searchText",
  "note_read",
  "note_list",
]);

// judge 原文落盘前的防爆日志截断（2026-09-20）：单条 intercept 记录最多 2000 字符。
const JUDGE_RAW_LOG_LIMIT = 2000;
function truncateJudgeRaw(text) {
  const value = String(text ?? "");
  return value.length > JUDGE_RAW_LOG_LIMIT
    ? `${value.slice(0, JUDGE_RAW_LOG_LIMIT)}…[截断，共 ${value.length} 字符]`
    : value;
}

export function createRunSnapshotExecutor(ctx) {
  // 单轮聚合输出预算（issue #32 #2）：逐条 outputHygiene 之外的「本轮合计」闸门。
  // 预算基准用引擎既有 budgetTokens（无窗口配置 → 聚合层整体关闭，行为不变）。
  const aggregateGate = createRoundAggregateGate({
    // 归档通道不存在（理论上 outputHygiene 已保证，这里只做防御）→ 聚合层关闭，不产生假 stub
    budgetTokens: Array.isArray(ctx.archivedOutputs) ? ctx.aggregateBudgetTokens : undefined,
    archivedOutputs: ctx.archivedOutputs ?? [],
    listRoundResults: () => [...(ctx.snapshotResults?.values() ?? [])],
  });
  // 终止态事件每轮只报一次（诊断用；不参与判定，故无恢复语义）
  const aggregateTerminalRounds = new Set();
  // executor 返回形态 → 执行结果。三个通道的分工（工单 §6.2 的输入/输出不对称）：
  //   · `metadata`       —— 送给 `onToolResult` 改写钩子的那份扩展（历史上也是顶层摊平源），
  //                          含引擎自己写的 `duration`/`success`，口径与改动前逐字相同；
  //   · `hostMetadata`   —— 只装 executor 自己给的扩展键（引擎的 duration/success 不在里面），
  //                          事实面把它写进 `metadata.*` 命名空间；
  //   · `success`       —— 引擎归一化后的成败布尔（工单 261014 T2 §4：顶层停写后它就是
  //                          `erix.success` 的唯一出口，所以**一律写**，不再看宿主声明没声明）。
  const normalizeExecutionResult = (value, startedAt) => {
    if (value instanceof Error) {
      return {
        content: toolResultContent(value.message ?? value),
        metadata: {},
        hostMetadata: {},
        success: false,
      };
    }
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "content")
    ) {
      const hostMetadata = value.metadata
        && typeof value.metadata === "object"
        && !Array.isArray(value.metadata)
        ? { ...value.metadata }
        : {};
      const metadata = { ...hostMetadata };
      const declaredTopLevel = Object.prototype.hasOwnProperty.call(value, "success");
      if (declaredTopLevel) {
        metadata.success = value.success;
      }
      const success = value.success ?? metadata.success ?? true;
      metadata.duration = Date.now() - startedAt;
      return {
        content: toolResultContent(value.content),
        metadata,
        hostMetadata,
        success: success !== false,
      };
    }
    const structured = toolResultData(value);
    if (structured === undefined) {
      return {
        content: toolResultContent(value),
        metadata: {},
        hostMetadata: {},
        success: true,
      };
    }
    const hostMetadata = Object.fromEntries(
      Object.entries(structured).filter(([key]) => (
        !["data", "type", "tool_use_id", "content", "success"].includes(key)
      )),
    );
    const metadata = { ...hostMetadata };
    metadata.success = structured.success ?? true;
    metadata.duration = Date.now() - startedAt;
    return {
      content: toolResultContent(structured.data),
      metadata,
      hostMetadata,
      success: metadata.success !== false,
    };
  };

  // 剩余轮数必须配本次 runToolLoop 的预算计数器（budgetRounds），不能用身份轮号：
  // resume 后身份轮号已到顶，会算出错误的剩余轮数提前催收尾（issue #32 #8）
  const budgetHintFor = () => {
    const remaining = ctx.governorState.effectiveMaxRounds - ctx.budgetRounds;
    if (remaining <= 2) ctx.lowBudgetPrompted = true;
    return remaining <= 2
      ? `[预算] 本轮后仅剩 ${Math.max(0, remaining)} 轮；请立即给出结论，或明确声明不可恢复`
      : "";
  };

  const messagesWithToolResults = (toolResults) => {
    const snapshot = cloneState(ctx.messages);
    if (toolResults.length === 0) return snapshot;
    if (mergeToolResultsIntoMessages(snapshot, toolResults) !== false) return snapshot;
    snapshot.push({ role: "user", content: cloneState(toolResults) });
    return snapshot;
  };

  // 单轮聚合预算（issue #32 #2）：在 onToolResult 改写 + 逐条 outputHygiene 之后、后置 run snapshot
  // **之前**立即判定内联或归档+stub。声明顺序与 tool_use_id 不变、不重排、不做批末回写——
  // 因此已随 run snapshot 落盘的 tool_result 永远不会被回写，resume 语义与改动前一致。
  const applyRoundAggregate = (block, round, toolName, execution, failed) => {
    if (!aggregateGate.enabled) return execution;
    // 聚合层要求稳定的 tool_use id（OpenAI/Anthropic 双协议都强制提供）：归档条目的幂等与
    // 终止态判定都以 toolUseId 为键，缺 id 会让多条结果互相冒充。无 id 的结果维持现状（内联）。
    if (block.id === undefined) return execution;
    const decision = aggregateGate.evaluate({
      round,
      toolUseId: block.id,
      content: execution.content,
    });
    if (decision.action === "inline") return execution;
    const fullText = execution.content;
    const snippet = failed ? errorSnippet(fullText) : undefined;
    const emitAggregate = (action, extra = {}) => {
      const emitEvent = ctx.emitEvent;
      if (typeof emitEvent !== "function") return;
      emitEvent({
        type: "tool_output_aggregate",
        round,
        toolUseId: block.id,
        name: toolName,
        action,
        reason: decision.reason,
        budgetTokens: decision.budgetTokens,
        inlineTokens: decision.inlineTokens,
        costTokens: decision.costTokens,
        projectedTokens: decision.projectedTokens,
        contentLength: fullText.length,
        ...extra,
      });
    };
    if (decision.action === "archive") {
      ctx.archivedOutputs.push({
        toolUseId: block.id,
        name: toolName,
        round,
        content: fullText,
      });
      emitAggregate("archived", { archivedBytes: decision.bytes });
      return {
        ...execution,
        content: aggregateStubText({ round, length: fullText.length, errorSnippet: snippet }),
      };
    }
    if (decision.action === "unrecoverable") {
      // fail-closed：不归档，显式计数 + 事件（宁丢不骗）。
      // main/ADR-016 退役了 run-state 的 `errors.archive` 计数，「没存上」改入错误账本
      // （`deterministic.errors.unpersisted`）——语义同一：这一份原文被丢了。
      ctx.errorLedger?.record?.({
        port: "transcript",
        operation: "archiveToolOutput",
        phase: "tool",
        fatal: false,
        error: new Error(
          `aggregate archive capacity exceeded: round ${round} output of ${fullText.length} chars not archived`,
        ),
      });
      emitAggregate("unrecoverable", { archivedBytes: decision.archivedBytes });
      return {
        ...execution,
        content: aggregateUnrecoverableStubText({
          round,
          length: fullText.length,
          reason: decision.reason,
          errorSnippet: snippet,
        }),
      };
    }
    // stub_kept：已在档（逐条或聚合归档过）→ 不再二次替换；全部 stub 化即终止，每轮只报一次
    if (decision.terminal === true && !aggregateTerminalRounds.has(round)) {
      aggregateTerminalRounds.add(round);
      emitAggregate("terminated");
    }
    return execution;
  };

  const executeToolBlock = async (block, round, toolResults, pendingToolUses = []) => {
    const toolName = String(block.name ?? "");
    const toolStat = ctx.toolStats.get(toolName) ?? { calls: 0, failures: 0 };
    toolStat.calls += 1;
    ctx.toolStats.set(toolName, toolStat);
    const persistRunSnapshot = ctx.persistRunSnapshot;
    const runSnapshotPersisted = await persistRunSnapshot({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
    });
    assertSnapshotPersisted(ctx, runSnapshotPersisted, {
      phase: "checkpoint_before_tool",
      sideEffect: "not_started",
      message: `Checkpoint persistence failed before tool execution (runId=${String(ctx.runId)}, round=${round})`,
    });
    const startedAt = Date.now();
    let execution;
    let isError = false;
    // 引擎事实 `erix.durationMs` 的口径（工单 §6.1，本单把它钉成「settle 时刻捕获一次」）：
    // 从「调用 executor 前」计到「该 promise settle/reject」，**不含** onToolResult 改写、输出卫生与
    // 单轮聚合。旧顶层 `duration` 曾在结构化路径上含 hook 耗时（两者故意不相等），T2 停写后
    // 那个旧键已退役，现在只有一个耗时：`erix.durationMs`。它仍然只经 normalizeExecutionResult 的
    // `metadata.duration` 进入 `onToolResult` 钩子（钩子的入参形状没动）。
    let durationMs;
    try {
      const structuredOptions = {
        id: block.id,
        name: block.name,
        input: block.input,
        context: { ...ctx.baseToolContext, round },
        signal: ctx.toolSignal,
      };
      const executeTool = ctx.executeTool;
      const awaitWithAbort = ctx.awaitWithAbort;
      const result = await awaitWithAbort(
        Promise.resolve().then(() => executeTool(structuredOptions)),
      );
      // `Math.max(0, …)`：`Date.now()` 是墙钟，NTP 校时/手动改时可回拨，于是差值可能为负。
      // 负的「耗时」不是一个可解释的事实，而下游只过 `Number.isFinite`（投影）会照收。
      // 只有引擎事实 `erix.durationMs` 被夹住（顶层旧 `duration` 已在 T2 退役，不再有第二个口径要兼顾）。
      durationMs = Math.max(0, Date.now() - startedAt);
      execution = normalizeExecutionResult(result, startedAt);
    } catch (error) {
      // 抛错（非 abort）同样是「settle」：耗时是一个事实，不是只有成功才有。
      // abort 分支在下面直接抛出 —— 没有结果就没有事实，`durationMs` 随之缺省（宁缺不造）。
      durationMs = Math.max(0, Date.now() - startedAt);   // 同上：墙钟回拨不得造出负耗时
      if (ctx.signal?.aborted) throwIfAborted(ctx.signal);
      isError = true;
      execution = {
        content: String(error?.message ?? error),
        metadata: {},
        hostMetadata: {},
        success: false,
      };
    }
    ctx.markToolExecuted?.();

    if (ctx.onToolResult) {
      const onToolResult = ctx.onToolResult;
      // issue #173 PR-B 边界②：onToolResult 是**改写钩子**（返回值会替换工具结果），不是纯观察者。
      // 业主定的异常 fallback：【保留原始执行结果 + reportObserverError】后 run 继续——宿主的改写/
      // 脱敏逻辑一旦抛错，本轮送给模型的是引擎原始结果（不是部分改写），契约里已要求宿主在 hook 内
      // 自防。ctx.reportObserverError 缺失（手工拼 ctx 的单测）时退到 console，不静默吞。
      try {
        const rewritten = await onToolResult(
          block.name,
          execution.content,
          execution.metadata,
        );
        if (rewritten !== undefined) {
          const normalized = normalizeExecutionResult(rewritten, startedAt);
          execution = {
            ...normalized,
            metadata: { ...execution.metadata, ...normalized.metadata },
            hostMetadata: { ...execution.hostMetadata, ...normalized.hostMetadata },
            success: execution.success && normalized.success,
          };
        }
      } catch (error) {
        const context = { channel: "onToolResult", toolName: block.name, round };
        if (typeof ctx.reportObserverError === "function") {
          ctx.reportObserverError(error, context);
        } else {
          console.error("Observer callback error:", error, context);
        }
      }
    }

    // 输出卫生：超限结果全量入档（round record 的 toolOutputs），上下文视图留可执行的笔记提示。
    // 在 onToolResult 重写之后执行：宿主的改写/脱敏先行，引擎归档的是宿主最终交出的内容。
    if (ctx.outputHygieneEnabled && execution.content.length > ctx.outputHygieneLimit) {
      const fullText = execution.content;
      ctx.archivedOutputs.push({
        toolUseId: block.id,
        name: toolName,
        round,
        content: fullText,
      });
      execution = {
        ...execution,
        content: `${fullText.slice(0, ctx.outputHygieneLimit)}`
          + `\n[完整输出已由引擎归档（第 ${round} 轮，共 ${fullText.length} 字符）。`
          + "后续需要该值：先用 note_list 查找记录，再用 note_read 读取；"
          + "若未记录且无法确定性重算，请省略对应 findings 声明，不要猜测。不要重跑有副作用的命令。"
          + `若原命令有副作用，不要仅凭截断输出判断成败，也不要为补全输出重跑有副作用的命令；`
          + "改用只读方式复核。]",
      };
    }
    // 单轮聚合预算：逐条阈值与聚合阈值**串联且独立**——逐条先跑，聚合再判；
    // 已是 stub 的结果不再被聚合层二次替换（两者叠加不死循环）。
    execution = applyRoundAggregate(
      block,
      round,
      toolName,
      execution,
      isError || execution.success === false,
    );
    const failed = isError || execution.success === false;
    // 年龄标记（issue #35）：TTL 折叠按创建轮判定，现在只住在 `erix.round` 上（T2 停写了顶层
    // `erixRound`）。附加字段穿过 cloneState/协议转换（wire 上被 canonicalToOpenAI/Anthropic 丢弃）
    // /validateMessages 均安全，run snapshot persist/restore 后仍在（resume-manager 原样带回）。
    const budgetHint = budgetHintFor();
    const toolResult = buildToolResultFact({
      toolUseId: block.id,
      content: execution.content,
      isError: failed,
      hostMetadata: execution.hostMetadata,
      engine: {
        // 身份键由调用点（orchestrator 的接受点 / resume 路径）在调用被接受时分配一次；
        // 这里只搬运，绝不重新分配 —— 否则线 A 与线 B 会各拿一个 key。
        toolCallKey: typeof block?.erix?.toolCallKey === "string"
          ? block.erix.toolCallKey
          : undefined,
        round: Number.isFinite(round) ? round : undefined,
        durationMs,
        // 一律写（工单 261014 T2 §4 的主裁定）：顶层 `success` 停写后，这就是「引擎归一化后的
        // 成败」的唯一出口。取值就是旧顶层那个字段的同一表达式（`success !== false`），语义零变化。
        // 旧口径「只在宿主显式声明时才写」在停写后会成为一个新坑：宿主再也没法区分「成功」与
        // 「未声明」。引擎推导出的 false 仍然同时反映在 `is_error` 上（两者不矛盾：一个是事实，一个是 wire）。
        success: execution.success,
      },
    });
    // 预算催收尾追加在**事实构造之后**（旧顶层摊平时宿主的同名 `content` 键会抢先生效，停写后
    // 只剩这一条顺序：催收尾始终追在正文后面）。
    if (budgetHint) toolResult.content = `${toolResult.content}\n${budgetHint}`;
    if (failed) {
      toolStat.failures += 1;
      ctx.toolErrorCount += 1;
    }
    toolResults.push(toolResult);
    if (block.id !== undefined) ctx.executedToolIds.add(block.id);
    ctx.snapshotResults.set(block.id, toolResult);
    const persistRunSnapshotAfter = ctx.persistRunSnapshot;
    const postRunSnapshotPersisted = await persistRunSnapshotAfter({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
      status: "executed",
      messagesOverride: messagesWithToolResults(toolResults),
    });
    assertSnapshotPersisted(ctx, postRunSnapshotPersisted, {
      phase: "checkpoint_after_tool",
      sideEffect: "executed_uncommitted",
      message: `Checkpoint persistence failed after tool execution: tool already executed but result was not persisted (toolUseId=${String(block.id)}, runId=${String(ctx.runId)}, round=${round})`,
    });
    return toolResult;
  };

  const pendingDirectionHints = [];
  // issue #322：达成 advisory 的**单槽**（不是队列，不计数）。同一轮多次 `done:true` 只留最后
  // 一条（覆盖），投递面在 orchestrator 的两处 flush（正常 / resume）共用同一个 `flushJudgeDoneAdvisory`。
  const pendingJudgeDoneAdvisory = { text: undefined };
  // 中途审计判定「目标已达成」（`done === true` 且置信度过 `JUDGE_DONE_CONFIDENCE_THRESHOLD`）时
  // 存下评审意见。开关关闭时本函数直接返回，`pendingJudgeDoneAdvisory` 永远为空 ⇒ 行为逐字节不变。
  const offerJudgeDoneAdvisory = (decision) => {
    if (ctx.judgeDoneAdvisoryEnabled !== true) return;
    if (decision === undefined || decision === null) return;
    if (decision.done !== true) return;
    if (!(decision.confidence >= JUDGE_DONE_CONFIDENCE_THRESHOLD)) return;
    pendingJudgeDoneAdvisory.text = judgeDoneAdvisoryText(decision.reason);
  };
  const executeToolWithIntercept = async (
    block,
    round,
    toolResults,
    pendingToolUses = [],
  ) => {
    // 最后一轮（无 tools 请求）跳过 intercept 审计：无工具可审（2026-09-20 预算兜底修复）。
    // 用 budgetRounds 而非身份轮号：resume 后身份轮号已到顶，会误判剩余轮数（issue #32 #8 同口径）。
    const finalBudgetRound = ctx.budgetRounds >= ctx.governorState.effectiveMaxRounds;
    const interceptEnabled = !finalBudgetRound
      && ctx.judgeInterceptEnabled
      && ctx.judgeInterceptCount >= ctx.judgeIntervalRound;
    if (!interceptEnabled) {
      ctx.judgeInterceptCount += 1;
      return executeToolBlock(block, round, toolResults, pendingToolUses);
    }

    const persistRunSnapshotAfterIntercept = ctx.persistRunSnapshot;
    const runSnapshotPersisted = await persistRunSnapshotAfterIntercept({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
    });
    assertSnapshotPersisted(ctx, runSnapshotPersisted, {
      phase: "checkpoint_before_tool",
      sideEffect: "not_started",
      message: `Checkpoint persistence failed before intercepted tool execution (runId=${String(ctx.runId)}, round=${round})`,
    });
    let decision;
    let judgeUsage;
    let judgeRaw;
    let interceptError;
    let interceptErrorMessage;
    try {
      const callRoundJudge = ctx.callRoundJudge;
      const judged = await callRoundJudge(round, undefined, {
        timeoutMs: ctx.judgeInterceptTimeoutMs,
        conversationBudgetTokens: ctx.judgeInterceptConversationTokens,
      });
      decision = judged?.decision;
      judgeUsage = judged?.usage;
      judgeRaw = judged?.raw;
    } catch (error) {
      if (ctx.signal?.aborted) throwIfAborted(ctx.signal);
      decision = undefined;
      interceptError = error?.code === "judge_intercept_timeout" ? "timeout" : "error";
      // 错误详情落 judge.log（可审计性）：judge 空转/报错需要能看到根因，300 字符截断。
      interceptErrorMessage = String(error?.message ?? String(error)).slice(0, 300);
    }
    ctx.judgeInterceptCount = 0;
    const nearLimit = ctx.budgetRounds >= Math.floor(
      ctx.governorState.effectiveMaxRounds * 0.8,
    );
    const extensionDecision = nearLimit
      && decision !== undefined
      && decision !== null
      && typeof decision.extend === "boolean";
    if (extensionDecision && ctx.interceptJudgeDecision === undefined) {
      ctx.interceptJudgeDecision = decision;
    }

    // 放行规则（issue #32 / 运行时评估 §5）：done:false 只是「任务尚未完成」，与「这次调用该不该执行」正交。
    // 任务中途 done:false 必然成立，若一律拦截就会误杀方向正确的工具调用（实测 39 次）。
    // 因此仅当 judge 明确 direction === "on_track" 时放行；uncertain / off_track / 缺省 direction 维持拦截。
    const onTrackPassThrough = decision !== undefined
      && decision !== null
      && decision.done === false
      && decision.direction === "on_track";
    // 只读放行（issue #33 C）：done:false 且方向非 on_track 时，只读工具照常执行
    // （无外部副作用，拦截净收益为负）；事件 action 仍为 executed，passThrough 标 "readonly"
    // 与 on_track 同构，审计可辨；uncertain/off_track 语义本身不变，写工具维持拦截。
    const readOnlyPassThrough = decision !== undefined
      && decision !== null
      && decision.done === false
      && READONLY_INTERCEPT_TOOLS.has(String(block.name ?? ""));
    const passThrough = onTrackPassThrough
      ? "on_track"
      : (readOnlyPassThrough ? "readonly" : undefined);

    if (decision === undefined || decision === null) {
      const emitJudge = ctx.emitJudge;
      emitJudge({
        kind: "intercept",
        tool: {
          id: block.id,
          name: block.name,
          input: cloneState(block.input),
        },
        decision: null,
        action: "degraded",
        error: decision === undefined ? interceptError : "parse",
        ...(interceptErrorMessage ? { errorDetail: interceptErrorMessage } : {}),
        // parse 失败但 usage 已可取得时同样带出（超时/抛错路径 judgeUsage 为 undefined，
        // 展开为空、字段缺省，行为不变）。
        ...(judgeUsage ? { usage: judgeUsage } : {}),
        // judge 原文落盘（可审计性）：截断 2000 字符防爆日志；超时/无响应时 raw 为空串，缺省。
        ...(typeof judgeRaw === "string" && judgeRaw !== ""
          ? { raw: truncateJudgeRaw(judgeRaw) }
          : {}),
      });
    } else {
      const emitJudge = ctx.emitJudge;
      const extensionAction = decision.extend === true
        ? (decision.direction === "off_track" ? "extend+redirect" : "extend")
        : decision.extend === false
          ? "decline_extend"
          : undefined;
      emitJudge({
        ...(extensionDecision ? { round } : {}),
        kind: extensionDecision ? "round" : "intercept",
        tool: {
          id: block.id,
          name: block.name,
          input: cloneState(block.input),
        },
        decision: {
          done: decision.done,
          confidence: decision.confidence,
          reason: decision.reason,
          evidence: decision.evidence,
          direction: decision.direction,
          directionReason: decision.directionReason,
          ...(decision.extend === undefined ? {} : { extend: decision.extend }),
          ...(decision.extendReason === undefined ? {} : { extendReason: decision.extendReason }),
          ...(decision.plan === undefined ? {} : { plan: decision.plan }),
        },
        action: extensionAction
          ?? (passThrough !== undefined || decision.done !== false ? "executed" : "blocked"),
        ...(passThrough ? { passThrough } : {}),
        // judge 当次调用用量（issue #33 B）：judge.log 对账；超时/出错时缺省。
        ...(judgeUsage ? { usage: judgeUsage } : {}),
        // judge 原文落盘（可审计性）：截断 2000 字符防爆日志。
        ...(typeof judgeRaw === "string" && judgeRaw !== ""
          ? { raw: truncateJudgeRaw(judgeRaw) }
          : {}),
      });
    }

    // on_track / readonly 放行的调用照常执行（judge 已给出方向判断，无需再打断）
    if (onTrackPassThrough || readOnlyPassThrough || decision?.done !== false) {
      offerJudgeDoneAdvisory(decision);
      try {
        const toolResult = await executeToolBlock(block, round, toolResults, pendingToolUses);
        const directionHint = directionHintText(
          decision?.direction,
          decision?.directionReason,
          ctx.judgeDoneAdvisoryEnabled === true,
        );
        if (directionHint) pendingDirectionHints.push(directionHint);
        return toolResult;
      } finally {
        ctx.judgeInterceptCount = 0;
      }
    }

    const reason = decision.reason || "任务方向可能偏离目标";
    const evidence = decision.evidence || "评审未提供更多证据";
    const directionHint = directionHintText(
      decision.direction,
      decision.directionReason,
      ctx.judgeDoneAdvisoryEnabled === true,
    );
    if (directionHint) pendingDirectionHints.push(directionHint);
    const interceptedContent = `【审计拦截】方向可能偏: ${reason}/${evidence}。原工具调用未执行，请重新评估方向后继续。`;
    const budgetHint = budgetHintFor();
    // 被拦截的调用**从未执行**：既不写 `erix.round` 也不写 `erix.durationMs`（工单 §5 存在性矩阵，
    // 「缺失 = unknown，不是 0」），也不写 `erix.success`（没跑过就没有成败可言）。
    const toolResult = buildToolResultFact({
      toolUseId: block.id,
      content: budgetHint
        ? `${interceptedContent}\n${budgetHint}`
        : interceptedContent,
      engine: {
        toolCallKey: typeof block?.erix?.toolCallKey === "string"
          ? block.erix.toolCallKey
          : undefined,
        executionStatus: "intercepted",
      },
    });
    if (block.id !== undefined) ctx.snapshotResults.set(block.id, toolResult);
    toolResults.push(toolResult);
    const overriddenMessages = [
      ...ctx.messages,
      { role: "user", content: cloneState(toolResults) },
    ];
    if (pendingDirectionHints.length > 0) {
      overriddenMessages.push({
        role: "user",
        // issue #323：blocked 路径落快照的方向提示是 judge 自己的控制意见，打 marker 防二次
        // resume 后被 judge 当普通用户输入读回（主模型侧仍可见；tool_result 事实不受影响）。
        meta: { source: "judge-control" },
        content: pendingDirectionHints.map((text) => ({ type: "text", text })),
      });
    }
    const persistRunSnapshotForInterceptResult = ctx.persistRunSnapshot;
    const resultRunSnapshotPersisted = await persistRunSnapshotForInterceptResult({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
      status: "intercepted",
      messagesOverride: overriddenMessages,
    });
    // 被拦截的工具从未执行，因此丢失这份判定/结果没有外部副作用 → not_started。
    assertSnapshotPersisted(ctx, resultRunSnapshotPersisted, {
      phase: "checkpoint_before_tool",
      sideEffect: "not_started",
      message: `Checkpoint persistence failed after intercept result (runId=${String(ctx.runId)}, round=${round})`,
    });
    return toolResult;
  };

  return {
    executeToolBlock,
    executeToolWithIntercept,
    pendingDirectionHints,
    pendingJudgeDoneAdvisory,
  };
}
