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
 *   appendRound: (key:string, record:object) => Promise<unknown>,
 *   // 成对可选快路径探针（issue #157，宿主 DB store 用）：两者都是函数时
 *   appendUserTurn 走点查快路径——先算 dedupKey → loadByDedupKey 命中即返回
 *   （不调 loadMaxRound、不调 load）；未命中才 loadMaxRound 派生 round →
 *   appendRound。快路径全程**不调用 store.load**。缺任一方法则回退现行为
 *   （全量 load），成对生效、缺一如缺二。返回形状违约抛 TypeError。
 *   内置 file store 不实现（点查对 JSONL 无意义，#160 已优化）。
 *   loadByDedupKey?: (key:string, dedupKey:string) => Promise<object|null|undefined>,
 *   loadMaxRound?: (key:string) => Promise<number|null|undefined>
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
 *   written: boolean,      // true 表示本次调用执行了 appendRound；不保证并发去重
 *                          // 场景下实际落盘（store 可能吞掉并发重复写）。同 key 的
 *                          // 追加应由宿主串行（或在宿主事务内）发起。
 *   record?: object        // existing record when written === false
 * }>}
 */
/**
 * loadMaxRound 派生源校验（issue #157 快路径）：null/undefined/负数 → 0
 * （与全量路径 Math.max(0, 安全整数 round…) 的空 store/异常语义一致）；
 * 非 number 且非 null/undefined、或非安全整数（1.5/NaN/Infinity）→ TypeError。
 */
async function maxRoundFromProbe(store, key) {
  const probed = await store.loadMaxRound(key);
  if (probed === null || probed === undefined) return 0;
  if (typeof probed !== "number" || !Number.isSafeInteger(probed)) {
    throw new TypeError(
      "appendUserTurn: store contract violation — loadMaxRound(key) must resolve to a safe integer, null, or undefined",
    );
  }
  return Math.max(0, probed);
}

export async function appendUserTurn(store, { key, text, messageId, ts } = {}) {
  if (store === null || typeof store !== "object"
    || typeof store.load !== "function"
    || typeof store.appendRound !== "function") {
    throw new TypeError("appendUserTurn: store with load/appendRound is required");
  }
  if (typeof key !== "string" || key === "") {
    throw new TypeError("appendUserTurn: key must be a non-empty string");
  }
  if (typeof text !== "string" || text.trim() === "") {
    // 仅空白（空格/换行/制表符）同样拒绝；写入记录仍用原文 text。
    throw new TypeError("appendUserTurn: text must be a non-empty string");
  }
  if (messageId !== undefined && messageId !== null
    && typeof messageId !== "string" && typeof messageId !== "number") {
    throw new TypeError("appendUserTurn: messageId must be a string, a number, or omitted");
  }

  // dedupKey 派生不依赖 store，快/慢路径共用（#157：快路径须先于任何读取算出）。
  const dedupKey = messageId === undefined || messageId === null
    // 无稳定 id：时间戳 + 随机段，保持与既有 CLI 格式兼容（每次调用唯一）。
    ? `${key}:input:${String(Date.now())}:${randomUUID()}`
    // 有稳定 id：dedupKey 稳定 → 崩溃/重跑天然幂等，可重复调用。
    : `${key}:input:${String(messageId)}`;

  // 成对可选快路径（#157）：两探针齐备才生效，全程不调 store.load。
  if (typeof store.loadByDedupKey === "function"
    && typeof store.loadMaxRound === "function") {
    const hit = await store.loadByDedupKey(key, dedupKey);
    if (hit !== null && hit !== undefined) {
      if (typeof hit !== "object") {
        throw new TypeError(
          "appendUserTurn: store contract violation — loadByDedupKey(key, dedupKey) must resolve to a record object, null, or undefined",
        );
      }
      // 命中即返回：不调 loadMaxRound、不调 load。existing.round 非法时罕见
      // 回落 loadMaxRound 派生（与全量路径 existing.round 非法回落 max 对齐）。
      return {
        key,
        dedupKey,
        round: Number.isSafeInteger(hit.round) ? hit.round : await maxRoundFromProbe(store, key),
        written: false,
        record: hit,
      };
    }
    // 未命中：loadMaxRound 派生 round → appendRound。
    const probeRound = await maxRoundFromProbe(store, key);
    const probeRecord = {
      round: probeRound,
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      dedupKey,
      roundKey: dedupKey,
      ts: ts ?? new Date().toISOString(),
    };
    await store.appendRound(key, probeRecord);
    return { key, dedupKey, round: probeRound, written: true };
  }

  // 现行为（全量 load）：以下逻辑与 #157 之前逐行一致。
  const records = await store.load(key);
  if (!Array.isArray(records)) {
    throw new TypeError(
      "appendUserTurn: store contract violation — load(key) must resolve to an array of records",
    );
  }
  // 与既有 CLI 对齐：round 复用现有最大 round（引擎 resume 从最大 round 续起，
  // 其自身记录落在下一个 round）；空 store 时为 0（种子路径）。
  const round = Math.max(
    0,
    ...records.map((record) => (
      Number.isSafeInteger(record?.round) ? record.round : 0
    )),
  );
  const existing = records.find(
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
