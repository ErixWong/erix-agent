import { randomUUID } from "node:crypto";

/**
 * Pre-write a user turn into a transcript store (upstream issue #97, write side
 * of the multi-turn resume contract in docs/host-consumer-contract.md).
 *
 * Hosts resuming a run must derive the round number, a unique dedupKey, the
 * record shape, and the idempotency rule themselves; this helper owns that
 * derivation so hosts call one function instead of hand-rolling the record.
 *
 * Semantics locked to existing CLI behavior (bin/cli.js / bin/repl.js):
 * - `round` reuses the existing maximum round (NOT max + 1): the engine's
 *   resume continues from `Math.max(round)` and writes its own record at the
 *   next round, so a pre-written row sharing the max round is what the loop
 *   expects. An empty store yields round 0 (seed path).
 * - `dedupKey` is namespaced `"<key>:input:<…>"`; the engine writes its own
 *   rows under `"<runId>:engine:round:<n>"`, so the namespaces never collide.
 * - Record shape: { round, messages: [{ role: "user", content: [{ type:
 *   "text", text }] }], dedupKey, roundKey: dedupKey, ts } with `ts` as an
 *   ISO-8601 string (matches every existing transcript writer).
 *
 * @param {{
 *   load: (key:string) => Promise<object[]>,
 *   appendRound: (key:string, record:object) => Promise<unknown>
 * }} store
 * @param {{
 *   key: string,               // transcript key (runId / session id)
 *   text: string,              // user message text
 *   messageId?: string|number, // stable id → stable dedupKey → idempotent reruns
 *   ts?: string                // ISO timestamp override (defaults to now)
 * }} options
 * @returns {Promise<{
 *   key: string,
 *   dedupKey: string,
 *   round: number,
 *   written: boolean,
 *   record?: object            // existing record when written === false
 * }>}
 */
export async function appendUserTurn(store, { key, text, messageId, ts } = {}) {
  if (store === null || typeof store !== "object"
    || typeof store.load !== "function"
    || typeof store.appendRound !== "function") {
    throw new TypeError("appendUserTurn: store with load/appendRound is required");
  }
  if (typeof key !== "string" || key === "") {
    throw new TypeError("appendUserTurn: key must be a non-empty string");
  }
  if (typeof text !== "string" || text === "") {
    throw new TypeError("appendUserTurn: text must be a non-empty string");
  }
  if (messageId !== undefined && messageId !== null
    && typeof messageId !== "string" && typeof messageId !== "number") {
    throw new TypeError("appendUserTurn: messageId must be a string, a number, or omitted");
  }

  const records = await store.load(key);
  // 与既有 CLI 对齐：round 复用现有最大 round（引擎 resume 从最大 round 续起，
  // 其自身记录落在下一个 round）；空 store 时为 0（种子路径）。
  const round = Math.max(
    0,
    ...(Array.isArray(records) ? records : []).map((record) => (
      Number.isSafeInteger(record?.round) ? record.round : 0
    )),
  );
  const dedupKey = messageId === undefined || messageId === null
    // 无稳定 id：时间戳 + 随机段，保持与既有 CLI 格式兼容（每次调用唯一）。
    ? `${key}:input:${String(Date.now())}:${randomUUID()}`
    // 有稳定 id：dedupKey 稳定 → 崩溃/重跑天然幂等，可重复调用。
    : `${key}:input:${String(messageId)}`;

  const existing = (Array.isArray(records) ? records : []).find(
    (record) => (record?.dedupKey ?? record?.roundKey) === dedupKey,
  );
  if (existing !== undefined) {
    return {
      key,
      dedupKey,
      round: Number.isSafeInteger(existing.round) ? existing.round : round,
      written: false,
      record: existing,
    };
  }

  const record = {
    round,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    dedupKey,
    roundKey: dedupKey,
    ts: ts ?? new Date().toISOString(),
  };
  await store.appendRound(key, record);
  return { key, dedupKey, round, written: true };
}
