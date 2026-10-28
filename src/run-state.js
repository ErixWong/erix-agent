import {
  COMPACTION_LAYER_IDS,
  COMPACTION_STATS_STATE_LIMIT,
  normalizeCompactionStats,
} from "./compact/pipeline.js";
// issue #548: the pairing predicate has exactly one home (`src/loop/pending-tool-result.js`,
// `#394`); this file only reads it through the shared read-side entry.
import { pendingTailToolUses } from "./loop/pending-tool-result.js";

const MAX_RENDERED_CHARS = 1600;
// 序列化超限时的第二道压缩把 compactionStats 再切成最后 8 条（体积约束），窗口账要跟着改口。
const COMPACTION_STATS_SERIALIZED_LIMIT = 8;
export const RUN_STATE_SCHEMA_VERSION = 1;
export const RUN_STATE_MAX_SERIALIZED_BYTES = 64 * 1024;
export const RUN_STATE_MAX_TOOL_ENTRIES = 128;
export const RUN_STATE_MAX_FILE_ENTRIES = 128;
export const RUN_STATE_MAX_TODO_ENTRIES = 64;
export const RUN_STATE_MAX_FIELD_CHARS = 120;
const DETERMINISTIC_MARKER = "[run state deterministic v1]";
const SEMANTIC_MARKER = "[run state semantic derived]";
const END_MARKER = "[/run state]";

function boundedText(value, maxChars) {
  const text = String(value ?? "").replaceAll(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, maxChars).join("");
}

// semantic 文本是多行目录（notes 小抄目录）——不能像单行字段那样把换行压平，
// 否则"多行渲染"退化成一行连写，模型读不出条目边界（2026-09-17 发布前评审）。
function boundedMultilineText(value, maxChars) {
  const text = String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    // 控制字符先删（\v/\f 直接删掉而不是折成空格；含 C1 区 \u0080-\u009f），
    // 再把其余空白（含制表符）压成单个空格；\n 保留
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
    .replaceAll(/[^\S\n]+/gu, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
  return Array.from(text).slice(0, maxChars).join("");
}

// 只负责 bounding，不做凭据启发式判定：防敏感信息到达上游 LLM 是 token hub
// （relay/LiteLLM 网关）的职责（issue #55，ADR-009 层级一致性）。
function safeText(value, maxChars = 120) {
  return boundedText(value, maxChars);
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeCountMap(values, keyNames = {}) {
  const entries = values instanceof Map
    ? [...values.entries()]
    : Object.entries(values ?? {});
  const normalized = entries
    .map(([name, value]) => {
      const item = value && typeof value === "object" ? value : { calls: value };
      return {
        name: safeText(name, RUN_STATE_MAX_FIELD_CHARS),
        calls: safeInteger(item.calls),
        failures: safeInteger(item.failures),
      };
    })
    .filter((item) => item.name !== "")
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => ({
      [keyNames.name ?? "name"]: item.name,
      calls: item.calls,
      failures: item.failures,
    }));
  return {
    items: normalized.slice(0, RUN_STATE_MAX_TOOL_ENTRIES),
    omitted: Math.max(0, normalized.length - RUN_STATE_MAX_TOOL_ENTRIES),
  };
}

function normalizeFiles(files) {
  const normalized = [...new Set((files ?? [])
    .map((file) => typeof file === "object" ? file?.path : file)
    .filter((file) => typeof file === "string" && file.trim() !== "")
    .map((file) => safeText(file, RUN_STATE_MAX_FIELD_CHARS)))];
  return {
    items: normalized.slice(-RUN_STATE_MAX_FILE_ENTRIES),
    omitted: Math.max(0, normalized.length - RUN_STATE_MAX_FILE_ENTRIES),
  };
}

function normalizeTodo(todo) {
  if (todo === undefined || todo === null) return undefined;
  const items = Array.isArray(todo) ? todo : todo.items;
  if (!Array.isArray(items)) {
    return { status: safeText(todo.status ?? "unknown", 24) };
  }
  return {
    status: safeText(todo.status ?? "ok", 24),
    items: items
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: safeText(item.id ?? item.key ?? "", 48),
        status: safeText(item.status ?? "unknown", 24),
      }))
      .filter((item) => item.id !== "")
      .slice(0, RUN_STATE_MAX_TODO_ENTRIES),
    ...(items.length > RUN_STATE_MAX_TODO_ENTRIES
      ? { truncated: true, omitted: items.length - RUN_STATE_MAX_TODO_ENTRIES }
      : {}),
  };
}

const SEMANTIC_TEXT_MAX_CHARS = 1200;
const SEMANTIC_RENDER_MAX_LINES = 16;

function normalizeSemantic(semantic, expectedVersion) {
  if (!semantic) return { status: "absent" };
  // ADR-015：semantic 槽位承载宿主目录（如 notes 小抄目录），220→1200 字符
  const sourceText = boundedMultilineText(semantic.text, SEMANTIC_TEXT_MAX_CHARS);
  const version = semantic.version ?? semantic.semanticStateVersion;
  const versionMatches = Number.isSafeInteger(version)
    && version === expectedVersion;
  const status = versionMatches
    ? (["ok", "truncated", "conflict", "error"].includes(semantic.status)
      ? semantic.status
      : "ok")
    : "stale";
  return {
    status,
    text: sourceText,
    semanticStateVersion: Number.isSafeInteger(version) ? version : null,
    ...(Array.from(String(semantic.text ?? "")).length > SEMANTIC_TEXT_MAX_CHARS
      ? { truncated: true }
      : {}),
  };
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * `deterministic.compactionStatsWindow` 的唯一构造点（issue #315）。
 * `state.json` 里那份 `compactionStats` 是**定长窗口**（只留最后 `limit` 条），字段名本身
 * 说不出来；这个结构化账把「窗口多大 / 丢了几条 / 原本几条」写在同一份文件里，
 * 读者不读源码也能知道手里这份是全量还是尾巴。
 */
function compactionStatsWindow(kept, total, limit) {
  const safeTotal = safeInteger(total);
  const safeKept = Math.min(safeInteger(kept), safeTotal);
  return {
    limit: safeInteger(limit),
    dropped: Math.max(0, safeTotal - safeKept),
    total: safeTotal,
  };
}

function compactStateForSize(state) {
  const compact = structuredClone(state);
  const deterministic = compact.deterministic ?? {};
  deterministic.tools = (deterministic.tools ?? []).slice(0, 16);
  deterministic.filesWritten = (deterministic.filesWritten ?? []).slice(-16);
  // 第二道截断（体积）改的是同一个窗口：`total` 沿用原账里的真值，`dropped` 跟着重算，
  // 否则窗口账会跟实际数组对不上（issue #315）。旧档没有窗口账时只能以现存条数为 total。
  const previousCompactionWindow = deterministic.compactionStatsWindow;
  const previousCompactionStats = deterministic.compactionStats ?? [];
  const compactionTotal = Number.isSafeInteger(previousCompactionWindow?.total)
    ? previousCompactionWindow.total
    : previousCompactionStats.length;
  deterministic.compactionStats = previousCompactionStats
    .slice(-COMPACTION_STATS_SERIALIZED_LIMIT);
  if (previousCompactionWindow !== undefined || compactionTotal > 0) {
    deterministic.compactionStatsWindow = compactionStatsWindow(
      deterministic.compactionStats.length,
      compactionTotal,
      COMPACTION_STATS_SERIALIZED_LIMIT,
    );
  }
  if (deterministic.todo?.items) {
    deterministic.todo = {
      ...deterministic.todo,
      items: deterministic.todo.items.slice(0, 8),
      truncated: true,
    };
  }
  if (compact.semantic?.text) {
    compact.semantic = {
      ...compact.semantic,
      text: `${Array.from(compact.semantic.text).slice(0, 64).join("")}[truncated]`,
      truncated: true,
    };
  }
  compact.deterministic = deterministic;
  compact.bounds = {
    ...(compact.bounds ?? {}),
    maxSerializedBytes: RUN_STATE_MAX_SERIALIZED_BYTES,
    truncated: true,
    reason: "serialized_size",
  };
  return compact;
}

/**
 * Bound the object written to a TranscriptStore. The rendered
 * RUN_STATE_MAX_CHARS-character block is not a substitute for bounding the
 * persisted state itself.
 */
export function boundRunState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("run state must be an object");
  }
  let bounded = structuredClone(state);
  if (serializedBytes(bounded) > RUN_STATE_MAX_SERIALIZED_BYTES) {
    bounded = compactStateForSize(bounded);
  }
  if (serializedBytes(bounded) <= RUN_STATE_MAX_SERIALIZED_BYTES) return bounded;

  const deterministic = bounded.deterministic ?? {};
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: safeText(bounded.runId, RUN_STATE_MAX_FIELD_CHARS),
    stateVersion: safeInteger(bounded.stateVersion),
    asOfRound: safeInteger(bounded.asOfRound),
    stateStatus: "available",
    deterministic: {
      budget: deterministic.budget ?? {},
      tools: [],
      filesWritten: [],
      fold: deterministic.fold ?? {},
      compactionStats: deterministic.compactionStats ?? [],
      ...(deterministic.compactionStatsWindow === undefined
        ? {}
        : { compactionStatsWindow: deterministic.compactionStatsWindow }),
      // issue #386 切片 3：最后一级体积兜底也**不许把配额丢掉**——丢掉就等于「状态被压小过一次」
      // 让同一个 run 又能领一份补跑（无界成本）。它只有一个布尔，留着不占体积。
      ...(deterministic.guardExtension === undefined
        ? {}
        : { guardExtension: deterministic.guardExtension }),
      termination: deterministic.termination ?? { reason: "running" },
      errors: deterministic.errors ?? {},
    },
    bounds: {
      maxSerializedBytes: RUN_STATE_MAX_SERIALIZED_BYTES,
      truncated: true,
      reason: "serialized_size",
    },
  };
}

export function validateRunState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { ok: false, status: "state_unavailable", reason: "missing" };
  }
  if (state.stateStatus && state.stateStatus !== "available") {
    return {
      ok: false,
      status: "state_unavailable",
      reason: String(state.stateStatus),
    };
  }
  // stateAvailability records the current resume observation, not an intrinsic
  // property of the persisted data. Rejecting it here creates a ratchet where
  // one damaged resume makes every later resume reject the same state.
  if (state.schemaVersion !== RUN_STATE_SCHEMA_VERSION) {
    return { ok: false, status: "state_unavailable", reason: "unknown_schema" };
  }
  if (typeof state.runId !== "string"
    || !Number.isSafeInteger(state.stateVersion)
    || !Number.isSafeInteger(state.asOfRound)
    || !state.deterministic
    || typeof state.deterministic !== "object"
    || !state.deterministic.budget
    || !Array.isArray(state.deterministic.tools)
    || !Array.isArray(state.deterministic.filesWritten)
    || !state.deterministic.fold
    || !state.deterministic.termination
    || !state.deterministic.errors) {
    return { ok: false, status: "state_unavailable", reason: "missing_fields" };
  }
  // issue #315：`deterministic.compactionStatsWindow` 是**增量**字段——旧档没有它照旧可读
  // （不判坏档）；只有「有、但形状坏了」才判坏，免得拿半份窗口账去算削减。
  const compactionWindow = state.deterministic.compactionStatsWindow;
  if (compactionWindow !== undefined && !isValidCompactionStatsWindow(compactionWindow)) {
    return { ok: false, status: "state_unavailable", reason: "missing_fields" };
  }
  return { ok: true, status: "available", state };
}

/** 窗口账的形状校验：旧档缺这个字段是正常的（由调用方判 `undefined` 放过），不在这里当成缺字段。 */
function isValidCompactionStatsWindow(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Number.isSafeInteger(value.limit) && value.limit >= 0
    && Number.isSafeInteger(value.dropped) && value.dropped >= 0
    && Number.isSafeInteger(value.total) && value.total >= 0;
}

function renderLines(lines, budget = MAX_RENDERED_CHARS) {
  const marker = "[run state truncated]";
  const output = [];
  let length = 0;
  for (const line of lines) {
    const separator = output.length === 0 ? 0 : 1;
    if (length + separator + Array.from(line).length + 1 > budget) break;
    output.push(line);
    length += separator + Array.from(line).length;
  }
  if (output.length < lines.length) {
    while (output.length > 0
      && length + (output.length === 0 ? 0 : 1) + Array.from(marker).length
        > budget) {
      const removed = output.pop();
      length -= Array.from(removed).length + (output.length === 0 ? 0 : 1);
    }
    if (length + (output.length === 0 ? 0 : 1) + Array.from(marker).length
      <= budget) {
      output.push(marker);
    }
  }
  return output.join("\n").slice(0, budget);
}

/**
 * Build the engine-known half of a run state. Inputs are structured facts
 * collected by the loop; this function never inspects tool result prose.
 */
const RUN_STATE_MAX_UNPERSISTED_ITEMS = 10;

// 未落盘清单在 `state.json` 这条路径上的归一化口径（`deterministic.errors.unpersisted`，形状
// `{ count, items }`）。它**不是**错误对象上的形状：`persistence_failed` 与 `checkpoint_failed` 的
// `unpersisted` 都是 #109 冻结的原始数组（issue #230 起两个出口取值也对称），别把这份投影塞进去。
function normalizeUnpersisted(value) {
  if (!Array.isArray(value) || value.length === 0) return { count: 0, items: [] };
  const items = value.slice(-RUN_STATE_MAX_UNPERSISTED_ITEMS).map((entry) => ({
    ts: safeText(entry?.ts, 32),
    kind: safeText(entry?.kind, 32),
    port: safeText(entry?.port, 32),
    operation: safeText(entry?.operation, 48),
    ...(entry?.phase === undefined ? {} : { phase: safeText(entry.phase, 32) }),
    fatal: entry?.fatal === true,
    ...(Number.isSafeInteger(entry?.repeat) && entry.repeat > 1 ? { repeat: entry.repeat } : {}),
    error: {
      name: safeText(entry?.error?.name, 40),
      message: safeText(entry?.error?.message, 240),
    },
  }));
  return { count: value.length, items };
}

export function createDeterministicRunState({
  runId,
  stateVersion = 0,
  rounds = 0,
  runRounds,
  maxRounds = 0,
  lowBudgetPrompted = false,
  toolStats,
  filesWritten,
  todo,
  foldedRounds = 0,
  navigationRecords = 0,
  terminationReason = "running",
  toolErrorCount = 0,
  // 保留旧名（issue #83）：该参数名即导出 API 的选项键，其值又以 `errors.checkpoint` 落盘
  // 并渲染进模型可见的 run-state 文本行；改名属破坏性变更，故引擎内部机制名统一为
  // run snapshot 时此处键名不动。
  checkpointFailureCount = 0,
  unpersisted,
  compactionStats,
  // issue #386 切片 3：guard 补跑的一次性配额。它**不是**「本次预算」类状态（那一类在 resume 时
  // 全部复位，见 `resume-manager.js` 的 `lowBudgetPrompted = false`）——它是**跨 resume 不许重置**
  // 的成本闸：否则「跑 → 崩 → resume」每次都领一份新配额 = 无界成本。
  guardExtensionUsed = false,
} = {}) {
  const safeRounds = safeInteger(rounds);
  // 双计数器（issue #32 #8）：rounds = 会话累计身份轮号（跨 resume 单调递增）；
  // runRounds = 本次 runToolLoop 消耗的轮数（resume 后从 0 重算，缺省等于 rounds，
  // 保证非 resume 单段调用两者一致）；remainingRounds 以本次预算为准。
  const safeRunRounds = safeInteger(runRounds ?? safeRounds);
  const safeMaxRounds = safeInteger(maxRounds);
  const tools = normalizeCountMap(toolStats);
  const files = normalizeFiles(filesWritten);
  const normalizedTodo = normalizeTodo(todo);
  // issue #315：state.json 里只留最后 `COMPACTION_STATS_STATE_LIMIT` 条（体积约束），
  // 但窗口账必须与数组同时落盘：读者不读源码就知道「这份是尾巴、丢了几条、原本几条」。
  const compactionStatsTotal = Array.isArray(compactionStats) ? compactionStats.length : 0;
  const persistedCompactionStats = normalizeCompactionStats(compactionStats);
  const state = {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: safeText(runId, 120),
    stateVersion: safeInteger(stateVersion),
    asOfRound: safeRounds,
    stateStatus: "available",
    deterministic: {
      budget: {
        rounds: safeRounds,
        runRounds: safeRunRounds,
        maxRounds: safeMaxRounds,
        remainingRounds: Math.max(0, safeMaxRounds - safeRunRounds),
        lowBudgetPrompted: lowBudgetPrompted === true,
      },
      tools: tools.items,
      filesWritten: files.items,
      ...(normalizedTodo === undefined ? {} : { todo: normalizedTodo }),
      fold: {
        foldedRounds: safeInteger(foldedRounds),
        navigationRecords: safeInteger(navigationRecords),
      },
      compactionStats: persistedCompactionStats,
      // 只在本次 run 真的产出过统计时出现：0 条没有可截断的东西，缺席不是歧义
      // （旧版本落的 state 也没这个字段，读侧必须放过）。
      ...(compactionStatsTotal > 0
        ? {
          compactionStatsWindow: compactionStatsWindow(
            persistedCompactionStats.length,
            compactionStatsTotal,
            COMPACTION_STATS_STATE_LIMIT,
          ),
        }
        : {}),
      // issue #386 切片 3：**只在真的用过配额时才出现这个键**（未 opt-in / opt-in 但没补跑的 run
      // 的 state.json 与今天逐字一致，与 `compactionStatsWindow` 同一个「缺席不是歧义」口径）。
      ...(guardExtensionUsed === true ? { guardExtension: { used: true } } : {}),
      termination: { reason: safeText(terminationReason, 48) || "running" },
      errors: {
        tool: safeInteger(toolErrorCount),
        // 持久化 JSON 键 `errors.checkpoint` 保留旧名（issue #83）：已落盘数据形状，改名属破坏性变更。
        checkpoint: safeInteger(checkpointFailureCount),
        // issue #109 修正 4：账单不只放内存——run 中途崩溃时 run-state 里也有账
        unpersisted: normalizeUnpersisted(unpersisted),
      },
    },
    bounds: {
      maxSerializedBytes: RUN_STATE_MAX_SERIALIZED_BYTES,
      truncated: tools.omitted > 0
        || files.omitted > 0
        || normalizedTodo?.truncated === true,
      ...(tools.omitted > 0 ? { omittedTools: tools.omitted } : {}),
      ...(files.omitted > 0 ? { omittedFiles: files.omitted } : {}),
      ...(normalizedTodo?.omitted > 0 ? { omittedTodoItems: normalizedTodo.omitted } : {}),
    },
  };
  return boundRunState(state);
}

export function withSemanticRunState(state, semantic) {
  const normalized = normalizeSemantic(semantic, state?.stateVersion ?? 0);
  return boundRunState({ ...state, semantic: normalized });
}

export function renderRunState(state) {
  const deterministic = state?.deterministic ?? {};
  const budget = deterministic.budget ?? {};
  const fold = deterministic.fold ?? {};
  const errors = deterministic.errors ?? {};
  const tools = (deterministic.tools ?? [])
    .slice(0, 8)
    .map((tool) => `${safeText(tool.name, 24)}=${safeInteger(tool.calls)}/${safeInteger(tool.failures)}`)
    .join(",");
  const files = (deterministic.filesWritten ?? [])
    .slice(-8)
    .map((file) => safeText(file, 50))
    .join(",");
  const todo = deterministic.todo?.items
    ?.slice(0, 6)
    .map((item) => `${safeText(item.id, 18)}:${safeText(item.status, 12)}`)
    .join(",");
  const compaction = deterministic.compactionStats ?? [];
  const compactionLayers = COMPACTION_LAYER_IDS
    .map((id) => {
      const totals = compaction.reduce((result, stat) => {
        const layer = stat?.layers?.[id];
        result.triggered += safeInteger(layer?.triggered);
        result.tokensSaved += safeInteger(layer?.tokensSaved);
        return result;
      }, { triggered: 0, tokensSaved: 0 });
      return `${id}=${totals.triggered}/${totals.tokensSaved}`;
    })
    .join(",");
  const semantic = state.semantic ?? { status: "absent" };
  // 预算行报本次会话的消耗（runRounds），resume 后与累计身份轮号不同时额外标出 session
  const renderedRunRounds = safeInteger(budget.runRounds ?? budget.rounds);
  const renderedSessionRounds = safeInteger(budget.rounds);
  const lines = [
    DETERMINISTIC_MARKER,
    `run=${safeText(state.runId, 48)} v=${safeInteger(state.stateVersion)} r=${renderedRunRounds}/${safeInteger(budget.maxRounds)} left=${safeInteger(budget.remainingRounds)} low=${budget.lowBudgetPrompted === true ? 1 : 0}${
      renderedRunRounds === renderedSessionRounds ? "" : ` session=${renderedSessionRounds}`
    }`,
    `tools=${tools || "-"} files=${files || "-"}`,
    `todo=${todo || safeText(deterministic.todo?.status, 16) || "-"} fold=${safeInteger(fold.foldedRounds)}/${safeInteger(fold.navigationRecords)}`,
    `compact=${compactionLayers || "-"}`,
    // `errors=tool/checkpoint/unpersisted` 中的 `checkpoint` 是模型可见文本（issue #83 保留旧名）。
    `termination=${safeText(deterministic.termination?.reason, 32) || "running"} errors=${safeInteger(errors.tool)}/${safeInteger(errors.checkpoint)}/${safeInteger(errors.unpersisted?.count)}`,
    SEMANTIC_MARKER,
    `status=${safeText(semantic.status, 16)} version=${semantic.semanticStateVersion ?? "-"}`,
    // ADR-015：semantic 文本多行渲染（宿主目录如 notes 小抄目录）；行数封顶防膨胀，
    // 但截断必须可见——模型要能知道目录条目不完整，而不是以为就这几条
    ...(semantic.text
      ? (() => {
          const lines = String(semantic.text).split("\n");
          const visible = lines.slice(0, SEMANTIC_RENDER_MAX_LINES);
          if (lines.length > SEMANTIC_RENDER_MAX_LINES) {
            visible.push(`... (semantic lines truncated: ${lines.length - SEMANTIC_RENDER_MAX_LINES} more)`);
          }
          return visible;
        })()
      : []),
  ];
  // 闭合标记必须存活：若把它当作 lines 的最后一行，超预算时会被截掉，
  // upsertRunStateInMessages 的替换正则（要求 END_MARKER 收尾）就匹配不到旧块。
  // 为它预留空间、渲染后永远追加。
  return `${renderLines(lines, MAX_RENDERED_CHARS - END_MARKER.length - 1)}\n${END_MARKER}`;
}

function runStateBlockPattern() {
  const escape = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `\\n?${escape(DETERMINISTIC_MARKER)}[\\s\\S]*?${escape(END_MARKER)}\\n?`,
    "gu",
  );
}

function blocksForMessage(message) {
  if (typeof message?.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return Array.isArray(message?.content) ? message.content : [];
}

/**
 * Replace the single run-state block in a message list. This is deliberately
 * marker-based so repeated folds and resume cannot append duplicate state.
 */
export function upsertRunStateInMessages(messages, rendered) {
  if (!Array.isArray(messages) || typeof rendered !== "string" || rendered === "") {
    return messages;
  }
  const updated = messages.map((message) => {
    if (!message || message.role !== "user") return message;
    const content = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [];
    let replaced = false;
    const nextContent = content.map((block) => {
      if (block?.type !== "text" || !runStateBlockPattern().test(String(block.text ?? ""))) {
        return block;
      }
      replaced = true;
      return { ...block, text: String(block.text).replace(runStateBlockPattern(), `\n${rendered}\n`) };
    });
    if (!replaced) return message;
    return {
      ...message,
      content: typeof message.content === "string" ? nextContent[0].text : nextContent,
    };
  });
  if (updated.some((message, index) => message !== messages[index])) return updated;

  const index = updated.findLastIndex((message) => (
    message?.role === "user"
      && blocksForMessage(message).some((block) => (
        block?.type === "text"
        && (String(block.text ?? "").includes("上下文折叠")
          || String(block.text ?? "").includes("[本 run 状态]"))
      ))
  ));
  if (index < 0) return updated;
  const message = updated[index];
  const content = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  const stateBlockIndex = content.findIndex((block) => (
    block?.type === "text"
      && (String(block.text ?? "").includes("上下文折叠")
        || String(block.text ?? "").includes("[本 run 状态]"))
  ));
  if (stateBlockIndex < 0) return updated;
  const stateBlock = content[stateBlockIndex];
  const nextContent = content.slice();
  nextContent[stateBlockIndex] = {
    ...stateBlock,
    text: `${rendered}\n${stateBlock.text}`,
  };
  updated[index] = {
    ...message,
    content: typeof message.content === "string" ? nextContent[0].text : nextContent,
  };
  return updated;
}

/**
 * Append the run-state block to **this provider request view only** (never to the persistent
 * messages); appending at the tail keeps the original prefix intact so the prefix cache never
 * goes stale.
 *
 * issue #548 — **the one shape where the append must not happen**: a view whose tail is an
 * assistant message carrying `tool_use` blocks that have no `tool_result` yet. That shape is
 * *deliberately* allowed on the `max_tokens` continuation route (`allowPendingToolUse: true`, the
 * only such call site in the tree, `src/loop/orchestrator.js`), so the append is the intruder, not
 * the shape: a bare `user` text message right behind a dangling `tool_use` breaks the pairing, the
 * request-view guard (`src/loop/request-user-view.js`) can no longer pass the view through and
 * falls back to `preserved_latest_user_turn` — which keeps **only the latest user turn**, i.e. the
 * whole context of the request is dropped (`count=1`).
 *
 * Why skip instead of settling the dangling call first (the discipline the *control-text* injection
 * sites follow, `#393`/`#394`): a synthetic `[erix] This tool call was never executed` result would
 * be a **false fact** here — on a `max_tokens` continuation that call is executed right after the
 * continuation finishes. Settling would also need a third settlement implementation (or an `async`
 * public function), which `#394`'s structural criterion forbids.
 *
 * Skipping costs one round of run-state visibility; the alternative costs the entire history. The
 * predicate is the shared read-side entry `pendingTailToolUses` (`src/loop/pending-tool-result.js`,
 * the same pairing rule as `validateMessages`) — never a second copy of the pairing logic.
 *
 * @param {any[]} messages
 * @param {string} [rendered]
 * @returns {any[]}
 */
export function appendRunStateToRequestView(messages, rendered) {
  if (!Array.isArray(messages) || typeof rendered !== "string" || rendered === "") {
    return messages;
  }
  if (pendingTailToolUses(messages).length > 0) return messages;
  return [
    ...messages,
    { role: "user", content: [{ type: "text", text: rendered }] },
  ];
}

export const RUN_STATE_MAX_CHARS = MAX_RENDERED_CHARS;
