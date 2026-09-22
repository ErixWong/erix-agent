import { looksLikeCredential } from "./tools/credential-patterns.js";
import {
  COMPACTION_LAYER_IDS,
  normalizeCompactionStats,
} from "./compact/pipeline.js";

const MAX_RENDERED_CHARS = 1600;
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

function safeText(value, maxChars = 120) {
  const text = boundedText(value, maxChars);
  return looksLikeCredential("", text) ? "[redacted]" : text;
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
  const redacted = looksLikeCredential("", sourceText);
  const text = redacted ? "[redacted]" : sourceText;
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
    text,
    semanticStateVersion: Number.isSafeInteger(version) ? version : null,
    ...(redacted ? { redacted: true } : {}),
    ...(Array.from(String(semantic.text ?? "")).length > SEMANTIC_TEXT_MAX_CHARS
      ? { truncated: true }
      : {}),
  };
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function compactStateForSize(state) {
  const compact = structuredClone(state);
  const deterministic = compact.deterministic ?? {};
  deterministic.tools = (deterministic.tools ?? []).slice(0, 16);
  deterministic.filesWritten = (deterministic.filesWritten ?? []).slice(-16);
  deterministic.compactionStats = (deterministic.compactionStats ?? []).slice(-8);
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
  if (state.stateAvailability?.status
    && state.stateAvailability.status !== "available") {
    return {
      ok: false,
      status: "state_unavailable",
      reason: String(state.stateAvailability.reason ?? state.stateAvailability.status),
    };
  }
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
  return { ok: true, status: "available", state };
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
  checkpointFailureCount = 0,
  unpersisted,
  compactionStats,
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
      compactionStats: normalizeCompactionStats(compactionStats),
      termination: { reason: safeText(terminationReason, 48) || "running" },
      errors: {
        tool: safeInteger(toolErrorCount),
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
 * 仅向本次 provider 请求视图追加 run-state，不修改持久消息；
 * 尾部追加保持原前缀不变，实现前缀缓存零失效。
 */
export function appendRunStateToRequestView(messages, rendered) {
  if (!Array.isArray(messages) || typeof rendered !== "string" || rendered === "") {
    return messages;
  }
  return [
    ...messages,
    { role: "user", content: [{ type: "text", text: rendered }] },
  ];
}

export const RUN_STATE_MAX_CHARS = MAX_RENDERED_CHARS;
