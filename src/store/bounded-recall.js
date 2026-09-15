import { createHash } from "node:crypto";

const CURSOR_VERSION = 1;

function result(text = "", status = "empty", extra = {}) {
  return {
    text,
    truncated: status === "truncated",
    status,
    ...extra,
  };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBound(value, name) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    return { error: `${name} must be a non-negative integer` };
  }
  return value;
}

function normalizeCap(value, name) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    return { error: `${name} must be a non-negative integer` };
  }
  return value;
}

function blockText(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") return String(block.text ?? "");
  if (block.type === "tool_use") return `${block.name ?? ""}${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") return String(block.content ?? "");
  return null;
}

function* recordFragments(record) {
  const messages = [
    ...(Array.isArray(record?.messages) ? record.messages : []),
    ...(Array.isArray(record?.foldedPayload) ? record.foldedPayload : []),
  ];
  for (const message of messages) {
    const content = typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      const text = blockText(block);
      if (text !== null) yield text;
    }
  }
}

function sourceDigest(sourceVersion) {
  return createHash("sha256")
    .update(String(sourceVersion ?? ""), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function utf8Prefix(buffer, start, maxBytes) {
  const available = buffer.length - start;
  if (available <= 0 || maxBytes <= 0) return { text: "", bytes: 0 };
  let end = Math.min(buffer.length, start + maxBytes);
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end === start) return { text: "", bytes: 0 };
  const slice = buffer.subarray(start, end);
  return { text: slice.toString("utf8"), bytes: slice.length };
}

function rangeStatus(rounds, fromRound, toRound) {
  if (rounds.size === 0) return "unrecoverable";
  if (fromRound === undefined && toRound === undefined) return undefined;

  const values = [...rounds].sort((left, right) => left - right);
  const first = fromRound ?? values[0];
  const last = toRound ?? values.at(-1);
  if (first > last || values[0] > first || values.at(-1) < last) return "unrecoverable";
  if (Number.isSafeInteger(last - first) && last - first <= 100_000) {
    for (let round = first; round <= last; round += 1) {
      if (!rounds.has(round)) return "unrecoverable";
    }
  }
  return undefined;
}

/**
 * Read matching transcript fragments without ever constructing the complete
 * range as one string. The cursor is opaque to callers and bound to all
 * request parameters plus the source version.
 */
export async function boundedRecall({
  runId,
  fromRound,
  toRound,
  pattern,
  limit,
  cursor,
  maxBytes,
  sourceVersion,
  records,
}) {
  if (typeof runId !== "string" || runId.length === 0) {
    return result("", "error", { error: { code: "invalid_run_id", message: "runId is required" } });
  }

  const from = normalizeBound(fromRound, "fromRound");
  const to = normalizeBound(toRound, "toRound");
  const itemLimit = normalizeCap(limit, "limit");
  const byteLimit = normalizeCap(maxBytes, "maxBytes");
  const invalid = [from, to, itemLimit, byteLimit].find((value) => value?.error);
  if (invalid || (typeof from === "number" && typeof to === "number" && from > to)) {
    return result("", "error", {
      error: { code: "invalid_range", message: invalid?.error ?? "fromRound must not exceed toRound" },
    });
  }

  const decodedCursor = decodeCursor(cursor);
  if (cursor !== undefined && !decodedCursor) {
    return result("", "cursor_mismatch", {
      error: { code: "cursor_mismatch", message: "cursor is invalid" },
    });
  }
  const cursorShape = {
    version: CURSOR_VERSION,
    runId,
    fromRound: from ?? null,
    toRound: to ?? null,
    pattern: pattern === undefined ? null : String(pattern),
    sourceVersion: sourceDigest(sourceVersion),
  };
  if (decodedCursor && (
    decodedCursor.version !== cursorShape.version
    || decodedCursor.runId !== cursorShape.runId
    || decodedCursor.fromRound !== cursorShape.fromRound
    || decodedCursor.toRound !== cursorShape.toRound
    || decodedCursor.pattern !== cursorShape.pattern
    || decodedCursor.sourceVersion !== cursorShape.sourceVersion
  )) {
    return result("", "stale", {
      error: { code: "cursor_mismatch", message: "cursor no longer matches this source or range" },
    });
  }

  const startIndex = decodedCursor?.fragmentIndex ?? 0;
  const startByteOffset = decodedCursor?.byteOffset ?? 0;
  const rounds = new Set();
  const parts = [];
  let outputBytes = 0;
  let selectedIndex = 0;
  let returnedItems = 0;
  let matched = false;
  let truncated = false;
  let nextPosition;
  let limitPosition;
  let sawRecord = false;
  const itemCap = itemLimit ?? Number.POSITIVE_INFINITY;
  const bytesCap = byteLimit ?? Number.POSITIVE_INFINITY;

  for await (const record of records()) {
    sawRecord = true;
    if (Number.isSafeInteger(record?.round)) rounds.add(record.round);
    if (truncated) continue;
    if (from !== undefined && record.round < from) continue;
    if (to !== undefined && record.round > to) continue;

    for (const fragment of recordFragments(record)) {
      if (pattern !== undefined && !fragment.includes(String(pattern))) continue;
      matched = true;
      const fragmentIndex = selectedIndex;
      selectedIndex += 1;
      if (fragmentIndex < startIndex) continue;
      if (limitPosition) {
        truncated = true;
        nextPosition = { fragmentIndex, byteOffset: 0 };
        break;
      }

      const buffer = Buffer.from(fragment, "utf8");
      let byteOffset = fragmentIndex === startIndex ? startByteOffset : 0;
      if (byteOffset > buffer.length) {
        return result("", "stale", {
          error: { code: "cursor_mismatch", message: "cursor points past a source fragment" },
        });
      }
      if (returnedItems >= itemCap) {
        truncated = true;
        nextPosition = { fragmentIndex, byteOffset };
        break;
      }

      const separatorBytes = parts.length === 0 ? 0 : 1;
      const remaining = bytesCap - outputBytes - separatorBytes;
      if (remaining <= 0) {
        truncated = true;
        nextPosition = { fragmentIndex, byteOffset };
        break;
      }
      const chunk = utf8Prefix(buffer, byteOffset, remaining);
      if (chunk.bytes === 0) {
        truncated = true;
        nextPosition = { fragmentIndex, byteOffset: Math.min(buffer.length, byteOffset + 1) };
        break;
      }
      if (separatorBytes > 0) {
        parts.push("\n");
        outputBytes += 1;
      }
      parts.push(chunk.text);
      outputBytes += chunk.bytes;
      returnedItems += 1;
      const nextByteOffset = byteOffset + chunk.bytes;
      if (nextByteOffset < buffer.length) {
        truncated = true;
        nextPosition = { fragmentIndex, byteOffset: nextByteOffset };
        break;
      }
      if (returnedItems >= itemCap) {
        limitPosition = { fragmentIndex: fragmentIndex + 1, byteOffset: 0 };
      }
    }
  }

  if (!sawRecord) return result("", "unrecoverable");
  const missingStatus = rangeStatus(rounds, from, to);
  if (missingStatus) return result("", missingStatus);
  if (!matched) return result("", "empty");
  if (truncated) {
    return result(parts.join(""), "truncated", {
      nextCursor: encodeCursor({ ...cursorShape, ...nextPosition }),
    });
  }
  return result(parts.join(""), "ok");
}
