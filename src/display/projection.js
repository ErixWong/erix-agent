import { FOLD_SUMMARY_MARKER } from "../compact/fold-statistical.js";

/**
 * Host display projection (issue #95).
 *
 * Pure, host-agnostic, side-effect-free view of `RoundRecord[]` (the raw result
 * of `TranscriptStore.load`). The engine's model-context contract keeps the
 * transcript byte-faithful; this module is the sanctioned *read side* view for
 * human-readable UI, so hosts do not have to invent a second lossy message
 * table. See `docs/host-consumer-contract.md` → "Host display projection".
 *
 * @typedef {{
 *   role: "user"|"assistant"|"system",
 *   text: string,
 *   blocks: object[],
 *   toolCalls?: { name:string, id?:string, argsSummary?:string,
 *     resultPreview?:string, isError?:boolean, executionStatus?:string }[],
 *   reasoning?: string,
 *   folded?: boolean,
 *   round?: number,
 *   ts?: string,
 *   meta: object
 * }} DisplayTurn
 */

/** Bounded one-line summary of the key tool arguments. */
const MAX_ARGS_PREVIEW = 120;
/** Bounded tool-result preview attached to a tool call. */
const MAX_RESULT_PREVIEW = 400;
/** Bounded fold-summary text rendered for a folded round. */
const MAX_FOLD_TEXT = 1200;
/** Preferred argument keys rendered first in a tool-call summary. */
const PREFERRED_ARG_KEYS = [
  "path", "file_path", "filepath", "file", "command", "cmd", "pattern",
  "query", "url", "dir", "directory", "name", "id", "content", "text",
];

const SYNTHETIC_TEXT_SOURCES = [
  { prefix: "【审计拦截】", source: "audit-intercept" },
  { prefix: "（附方向提示", source: "direction-hint" },
  { prefix: "方向提示：", source: "direction-hint" },
];

function isObject(value) {
  return value !== null && typeof value === "object";
}

function blocksOf(content) {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function isReasoningBlock(block) {
  if (!isObject(block)) return false;
  if (block.type === "reasoning" || block.type === "thinking") return true;
  return isObject(block.payload) && block.payload.kind === "reasoning";
}

function reasoningBlockText(block) {
  if (!isReasoningBlock(block)) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  if (isObject(block.payload)) {
    if (typeof block.payload.text === "string") return block.payload.text;
    if (typeof block.payload.reasoning_content === "string") {
      return block.payload.reasoning_content;
    }
  }
  return "";
}

function joinBlocks(blocks, predicate, map) {
  return blocks
    .filter((block) => isObject(block) && predicate(block))
    .map((block) => String(map(block) ?? ""))
    .filter((value) => value !== "")
    .join("\n");
}

function textOf(blocks) {
  return joinBlocks(blocks, (block) => !isReasoningBlock(block)
    && (block.type === "text" || typeof block.text === "string"
      || typeof block.thinking === "string"),
  (block) => (block.type === "text" || typeof block.text === "string"
    ? block.text
    : block.thinking));
}

function reasoningOf(blocks) {
  const joined = joinBlocks(blocks, isReasoningBlock, reasoningBlockText);
  return joined === "" ? undefined : joined;
}

function truncated(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function summarizeArgs(input) {
  if (!isObject(input)) {
    const raw = input === undefined || input === null ? "" : safeStringify(input);
    return raw === "" ? undefined : truncated(raw, MAX_ARGS_PREVIEW);
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return undefined;
  const preferred = PREFERRED_ARG_KEYS.filter((key) => keys.includes(key));
  const rest = keys.filter((key) => !preferred.includes(key));
  const parts = [];
  for (const key of [...preferred, ...rest]) {
    if (parts.join(", ").length >= MAX_ARGS_PREVIEW) break;
    const value = input[key];
    const rendered = typeof value === "string"
      ? value
      : value === undefined || value === null ? "" : safeStringify(value);
    if (rendered === "") continue;
    parts.push(`${key}=${truncated(rendered, 60)}`);
  }
  if (parts.length === 0) return undefined;
  return truncated(parts.join(", "), MAX_ARGS_PREVIEW);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function toolCallsOf(blocks) {
  const calls = blocks
    .filter((block) => isObject(block) && block.type === "tool_use")
    .map((block) => {
      const argsSummary = summarizeArgs(block.input);
      return {
        name: String(block.name ?? ""),
        ...(block.id === undefined ? {} : { id: String(block.id) }),
        ...(argsSummary === undefined ? {} : { argsSummary }),
      };
    });
  return calls.length > 0 ? calls : undefined;
}

function toolResultsOf(messages) {
  const results = new Map();
  for (const message of messages) {
    for (const block of blocksOf(message?.content)) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      if (typeof block.tool_use_id !== "string") continue;
      const preview = truncated(toolResultText(block), MAX_RESULT_PREVIEW);
      results.set(block.tool_use_id, {
        ...(preview === "" ? {} : { resultPreview: preview }),
        ...(block.is_error === undefined ? {} : { isError: block.is_error === true }),
        ...(typeof block.executionStatus === "string"
          ? { executionStatus: block.executionStatus }
          : {}),
      });
    }
  }
  return results;
}

function toolResultText(block) {
  const content = block?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => isObject(item) && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
  }
  return isObject(content) ? safeStringify(content) : String(content ?? "");
}

function syntheticInfo(message, text) {
  const meta = isObject(message?.meta) ? message.meta : undefined;
  if (typeof meta?.source === "string" && meta.source !== "") {
    return { synthetic: true, source: meta.source };
  }
  for (const { prefix, source } of SYNTHETIC_TEXT_SOURCES) {
    if (typeof text === "string" && text.startsWith(prefix)) {
      return { synthetic: true, source };
    }
  }
  if (message?.role === "system") return { synthetic: true, source: "system" };
  return { synthetic: false };
}

/**
 * The fold summary is prepended as its own text block at the head of the task
 * message (see `mergedFoldSummaryContent`), so a resumed seed record carries it
 * inside a `user` message. Keep it out of the user bubble and surface it as its
 * own system line instead. Legacy single-block shapes (marker inline with the
 * task text) are split at the marker.
 */
function splitFoldBlocks(blocks) {
  const foldParts = [];
  const contentBlocks = [];
  for (const block of blocks) {
    const text = typeof block?.text === "string" ? block.text : undefined;
    const index = text === undefined ? -1 : text.indexOf(FOLD_SUMMARY_MARKER);
    if (index < 0) {
      contentBlocks.push(block);
      continue;
    }
    const afterMarker = text.slice(index);
    // A block that starts with the marker is the engine's fold-summary block: keep
    // its whole body (marker line, footprint, navigation, stubs, recovery hint,
    // anchor index). Inline legacy shapes end the section at the first blank line.
    const boundary = index === 0 ? -1 : afterMarker.indexOf("\n\n");
    const foldRaw = boundary < 0 ? afterMarker : afterMarker.slice(0, boundary);
    const tail = boundary < 0 ? "" : afterMarker.slice(boundary + 2);
    const foldText = foldRaw.split("\n").slice(0, 20).join("\n");
    if (foldText.trim() !== "") foldParts.push(truncated(foldText, MAX_FOLD_TEXT));
    const head = `${text.slice(0, index).trim()}
${tail.trim()}`.trim();
    if (head !== "") contentBlocks.push({ ...block, text: head });
  }
  return {
    foldText: foldParts.length > 0 ? foldParts.join("\n") : undefined,
    blocks: contentBlocks,
  };
}

function markedFoldSummaryText(record) {
  const sources = [
    ...(Array.isArray(record?.messages) ? record.messages : []),
    ...(Array.isArray(record?.foldedPayload) ? record.foldedPayload : []),
  ];
  for (const message of sources) {
    const { foldText } = splitFoldBlocks(blocksOf(message?.content));
    if (foldText !== undefined) return foldText;
  }
  return undefined;
}

function composedFoldText(record) {
  const range = isObject(record?.foldedRoundRange) ? record.foldedRoundRange : undefined;
  const parts = [];
  if (range !== undefined
    && Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to)) {
    parts.push(`早期第 ${range.from}–${range.to} 轮已折叠。`);
  } else {
    parts.push("更早的轮次已折叠。");
  }
  const summary = record?.summary;
  if (isObject(summary)) {
    const action = typeof summary.action === "string" ? summary.action : "";
    const note = typeof summary.note === "string" ? summary.note : "";
    const line = [action, note].filter((part) => part !== "").join("：");
    if (line !== "") parts.push(`轮次摘要：${line}`);
  }
  const navigation = isObject(record?.navigationRecord) ? record.navigationRecord : undefined;
  if (navigation !== undefined) {
    const artifacts = Array.isArray(navigation.artifacts) ? navigation.artifacts : [];
    parts.push(
      `导航记录：${artifacts.length} 个归档产物${navigation.truncated === true ? "（已截断）" : ""}。`,
    );
  }
  return truncated(parts.join("\n"), MAX_FOLD_TEXT);
}

function roundOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function recordBase(record) {
  const round = roundOf(record?.round);
  return {
    ...(round === undefined ? {} : { round }),
    ...(typeof record?.ts === "string" ? { ts: record.ts } : {}),
  };
}

function recordMeta(record, extra = {}) {
  const meta = { ...extra };
  if (isObject(record?.response)) {
    if (typeof record.response.stopReason === "string") {
      meta.stopReason = record.response.stopReason;
    }
    if (isObject(record.response.usage)) meta.usage = record.response.usage;
  }
  if (Number.isFinite(Number(record?.toolUses))) meta.toolUses = Number(record.toolUses);
  if (record?.summary !== undefined) meta.summary = record.summary;
  if (isObject(record?.judge)) meta.judge = record.judge;
  if (isObject(record?.wrapup)) meta.wrapup = record.wrapup;
  if (typeof record?.dedupKey === "string") meta.dedupKey = record.dedupKey;
  return meta;
}

function projectRecord(record) {
  const entries = [];
  if (!isObject(record)) return entries;

  const messages = Array.isArray(record.messages)
    ? record.messages.filter(isObject)
    : [];
  const base = recordBase(record);
  const assistantBlocks = blocksOf(record?.response?.content);
  const hasResponse = record?.response !== undefined && record?.response !== null;

  const emittedFoldTexts = new Set();
  const pushFoldEntry = (text, extraMeta = {}) => {
    const value = truncated(String(text ?? ""), MAX_FOLD_TEXT);
    if (value === "" || emittedFoldTexts.has(value)) return;
    emittedFoldTexts.add(value);
    entries.push({
      role: "system",
      text: value,
      blocks: [],
      folded: true,
      ...base,
      meta: recordMeta(record, { synthetic: true, source: "fold-summary", ...extraMeta }),
    });
  };

  if (record.folded === true) {
    const range = isObject(record.foldedRoundRange) ? record.foldedRoundRange : undefined;
    const navigation = isObject(record.navigationRecord) ? record.navigationRecord : undefined;
    pushFoldEntry(markedFoldSummaryText(record) ?? composedFoldText(record), {
      ...(range === undefined ? {} : { foldedRoundRange: range }),
      ...(navigation === undefined ? {} : { navigationRecord: navigation }),
      ...(Array.isArray(record.foldedPayload)
        ? { foldedPayloadMessages: record.foldedPayload.length }
        : {}),
    });
  }

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "system") continue;
    const split = splitFoldBlocks(blocksOf(message.content));
    const blocks = split.blocks;
    if (split.foldText !== undefined) pushFoldEntry(split.foldText);
    const text = textOf(blocks);
    if (text === "") continue; // tool-result-only messages are model plumbing
    const synthetic = syntheticInfo(message, text);
    const messageSource = isObject(message.meta) ? message.meta.source : undefined;
    entries.push({
      role: message.role === "system" ? "system" : "user",
      text,
      blocks,
      ...base,
      meta: recordMeta(record, {
        synthetic: synthetic.synthetic,
        ...(typeof messageSource === "string" && messageSource !== ""
          ? { source: messageSource }
          : (synthetic.source === undefined ? {} : { source: synthetic.source })),
      }),
    });
  }

  let assistantEntry;
  if (hasResponse && assistantBlocks.length > 0) {
    const toolCalls = toolCallsOf(assistantBlocks);
    const reasoning = reasoningOf(assistantBlocks);
    assistantEntry = {
      role: "assistant",
      text: textOf(assistantBlocks),
      blocks: assistantBlocks,
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...base,
      meta: recordMeta(record, { synthetic: false }),
    };
  } else {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const blocks = blocksOf(message.content);
      if (blocks.length === 0) continue;
      const toolCalls = toolCallsOf(blocks);
      const reasoning = reasoningOf(blocks);
      entries.push({
        role: "assistant",
        text: textOf(blocks),
        blocks,
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...base,
        meta: recordMeta(record, { synthetic: false }),
      });
    }
    const fallbackText = typeof record.textPreview === "string" ? record.textPreview : "";
    if (entries.at(-1)?.role !== "assistant" && fallbackText !== "") {
      assistantEntry = {
        role: "assistant",
        text: fallbackText,
        blocks: [],
        ...base,
        meta: recordMeta(record, { synthetic: false, source: "textPreview" }),
      };
    }
  }
  if (assistantEntry !== undefined) entries.push(assistantEntry);

  if (!hasResponse && isObject(record.wrapup)
    && !entries.some((entry) => entry.role === "assistant")) {
    entries.push({
      role: "system",
      text: truncated(String(record.wrapup.summary ?? ""), MAX_FOLD_TEXT),
      blocks: [],
      ...base,
      meta: recordMeta(record, { synthetic: true, source: "wrapup" }),
    });
  }

  const results = toolResultsOf(messages);
  for (const entry of entries) {
    for (const call of entry.toolCalls ?? []) {
      const result = call.id === undefined ? undefined : results.get(call.id);
      if (result !== undefined) Object.assign(call, result);
    }
  }
  return entries;
}

/**
 * Project transcript records into host-facing display turns.
 *
 * - Deterministic and side-effect free; input records are never mutated.
 * - Accepts any subset of `RoundRecord[]` (e.g. `load()` output, or a filtered
 *   slice); tolerates missing `ts`, missing `response`, missing `messages`,
 *   missing `round`, string content, and non-object records without throwing.
 * - Output is ordered by `round` ascending; records without a usable `round`
 *   keep their input order and sort last (stable).
 *
 * @param {object[]} records
 * @returns {DisplayTurn[]}
 */
export function projectTranscriptForDisplay(records) {
  if (!Array.isArray(records)) return [];
  const decorated = records
    .map((record, index) => ({
      record,
      index,
      round: roundOf(record?.round) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => (left.round - right.round) || (left.index - right.index));
  return decorated.flatMap(({ record }) => projectRecord(record));
}
