const MAX_RENDERED_CHARS = 400;
const DETERMINISTIC_MARKER = "[run state deterministic v1]";
const SEMANTIC_MARKER = "[run state semantic derived]";
const END_MARKER = "[/run state]";

const CREDENTIAL_PATTERN = /(?:sk-[a-z0-9_-]{8,}|sk_live_[a-z0-9]{16,}|(?:ghp|gho|ghs|ghu|ghr)_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|Bearer\s+[a-z0-9._-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN\s+[A-Z ]+-----)/iu;

function boundedText(value, maxChars) {
  const text = String(value ?? "").replaceAll(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, maxChars).join("");
}

function safeText(value, maxChars = 120) {
  const text = boundedText(value, maxChars);
  return CREDENTIAL_PATTERN.test(text) ? "[redacted]" : text;
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeCountMap(values, keyNames = {}) {
  const entries = values instanceof Map
    ? [...values.entries()]
    : Object.entries(values ?? {});
  return entries
    .map(([name, value]) => {
      const item = value && typeof value === "object" ? value : { calls: value };
      return {
        name: safeText(name, 60),
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
}

function normalizeFiles(files) {
  return [...new Set((files ?? [])
    .map((file) => typeof file === "object" ? file?.path : file)
    .filter((file) => typeof file === "string" && file.trim() !== "")
    .map((file) => safeText(file, 120)))]
    .slice(-50);
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
      .slice(0, 20),
  };
}

function normalizeSemantic(semantic, expectedVersion) {
  if (!semantic) return { status: "absent" };
  const text = safeText(semantic.text, 220);
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
  };
}

function renderLines(lines) {
  const marker = "[run state truncated]";
  const output = [];
  let length = 0;
  for (const line of lines) {
    const separator = output.length === 0 ? 0 : 1;
    if (length + separator + Array.from(line).length + 1 > MAX_RENDERED_CHARS) break;
    output.push(line);
    length += separator + Array.from(line).length;
  }
  if (output.length < lines.length) {
    while (output.length > 0
      && length + (output.length === 0 ? 0 : 1) + Array.from(marker).length
        > MAX_RENDERED_CHARS) {
      const removed = output.pop();
      length -= Array.from(removed).length + (output.length === 0 ? 0 : 1);
    }
    if (length + (output.length === 0 ? 0 : 1) + Array.from(marker).length
      <= MAX_RENDERED_CHARS) {
      output.push(marker);
    }
  }
  return output.join("\n").slice(0, MAX_RENDERED_CHARS);
}

/**
 * Build the engine-known half of a run state. Inputs are structured facts
 * collected by the loop; this function never inspects tool result prose.
 */
export function createDeterministicRunState({
  runId,
  stateVersion = 0,
  rounds = 0,
  maxRounds = 0,
  lowBudgetPrompted = false,
  toolStats,
  filesWritten,
  todo,
  foldedRounds = 0,
  navigationRecords = 0,
  nonReplayableCaptures = 0,
  unrecoverableCaptures = 0,
  terminationReason = "running",
  toolErrorCount = 0,
  checkpointFailureCount = 0,
  archiveFailureCount = 0,
} = {}) {
  const safeRounds = safeInteger(rounds);
  const safeMaxRounds = safeInteger(maxRounds);
  return {
    schemaVersion: 1,
    runId: safeText(runId, 120),
    stateVersion: safeInteger(stateVersion),
    asOfRound: safeRounds,
    deterministic: {
      budget: {
        rounds: safeRounds,
        maxRounds: safeMaxRounds,
        remainingRounds: Math.max(0, safeMaxRounds - safeRounds),
        lowBudgetPrompted: lowBudgetPrompted === true,
      },
      tools: normalizeCountMap(toolStats),
      filesWritten: normalizeFiles(filesWritten),
      ...(normalizeTodo(todo) === undefined ? {} : { todo: normalizeTodo(todo) }),
      fold: {
        foldedRounds: safeInteger(foldedRounds),
        navigationRecords: safeInteger(navigationRecords),
        nonReplayableCaptures: safeInteger(nonReplayableCaptures),
        unrecoverableCaptures: safeInteger(unrecoverableCaptures),
      },
      termination: { reason: safeText(terminationReason, 48) || "running" },
      errors: {
        tool: safeInteger(toolErrorCount),
        checkpoint: safeInteger(checkpointFailureCount),
        archive: safeInteger(archiveFailureCount),
      },
    },
  };
}

export function withSemanticRunState(state, semantic) {
  const normalized = normalizeSemantic(semantic, state?.stateVersion ?? 0);
  return { ...state, semantic: normalized };
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
  const semantic = state.semantic ?? { status: "absent" };
  const lines = [
    DETERMINISTIC_MARKER,
    `run=${safeText(state.runId, 48)} v=${safeInteger(state.stateVersion)} r=${safeInteger(budget.rounds)}/${safeInteger(budget.maxRounds)} left=${safeInteger(budget.remainingRounds)} low=${budget.lowBudgetPrompted === true ? 1 : 0}`,
    `tools=${tools || "-"} files=${files || "-"}`,
    `todo=${todo || safeText(deterministic.todo?.status, 16) || "-"} fold=${safeInteger(fold.foldedRounds)}/${safeInteger(fold.navigationRecords)} nonreplay=${safeInteger(fold.nonReplayableCaptures)}`,
    `termination=${safeText(deterministic.termination?.reason, 32) || "running"} errors=${safeInteger(errors.tool)}/${safeInteger(errors.checkpoint)}/${safeInteger(errors.archive)}`,
    SEMANTIC_MARKER,
    `status=${safeText(semantic.status, 16)} version=${semantic.semanticStateVersion ?? "-"}`,
    ...(semantic.text ? [`text=${safeText(semantic.text, 180)}`] : []),
    END_MARKER,
  ];
  return renderLines(lines);
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

export const RUN_STATE_MAX_CHARS = MAX_RENDERED_CHARS;
