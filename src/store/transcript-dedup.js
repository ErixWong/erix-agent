// @ts-check
// TranscriptStore 去重的 **payload 判据**（issue #326 事实①，引擎内部模块，不发公共面）。
//
// 为什么存在：`appendRound` 的幂等判据一直只看 key（`dedupKey ?? roundKey ?? <runId>:round:<n>`），
// 于是**同 key 换 payload 也被静默接受**——第二次的 payload 既不落盘也不报错（memory 侧
// `records.some(...)` 直接 return、file 侧 `entry.keys.has(key)` 直接 return false），
// 宿主与引擎都拿不到任何信号。本模块把「同 key 时这两份 payload 算不算同一份」抽成一份实现，
// `createMemoryTranscriptStore` 与 `createFileTranscriptStore` 共用，杜绝「两个内置 store 各抄
// 一套判据再各自漂」。先例：`src/assembly-validators.js`、`src/store/notes-port.js`。
//
// 介质特有物不在这里：缓存/戳/文件修复（file 版）、Map 与克隆（memory 版）——它们只负责
// 「这条 key 在不在」，在不在之后「payload 一不一样」一律回到本模块判。
//
// ── 判定口径（可解释性写在文档里，这里只留实现要点）────────────────────────
// · **摘要 = sha256(规范化 JSON of 记录减去身份/派生字段)**，前缀 `sha256:`、取前 24 位十六进制
//   （与 `src/store/notes-port.js#digest` 同口径，够做比较与日志指认，不当作密码学承诺）。
// · 规范化：对象**逐层排序键**（字段顺序不是语义）、数组**保序**（消息顺序是语义）、
//   `undefined`/函数/symbol 作为对象成员被丢弃、`NaN`/`Infinity` 记成 `null`——全部照
//   `JSON.stringify` 的取舍，保证「内存里的记录」与「file store 读回来的同一行」摘要相等。
// · 排除的是**顶层**四个字段：`dedupKey`/`roundKey`（它们就是 key 本身，比过一遍了）与
//   `round`/`ts`（写盘时派生/墙钟：`appendUserTurn` 的 round 取 store 现有最大 round、`ts` 取
//   `new Date()`，崩溃重跑必然漂）。嵌套字段一律参与摘要——消息正文里的 `ts` 是内容不是信封。
// · 非 JSON 叶子的确定性兜底：`bigint` 记成十进制字符串字面量（`JSON.stringify` 会直接抛，
//   而 memory store 允许它活着）；循环引用记成 `"[Circular]"`（同上，file store 根本存不下）。

import { createHash } from "node:crypto";

/** 可判定的错误码：宿主不必 `instanceof` 也能分流（`error.code === DEDUP_CONFLICT_CODE`）。 */
export const DEDUP_CONFLICT_CODE = "dedup_payload_conflict";

/**
 * 顶层「身份 / 派生 / 墙钟」字段：它们说明这条记录是谁、什么时候写的，**不**属于 payload。
 * 只排除顶层同名键，嵌套层级照常参与摘要。
 */
export const PAYLOAD_VOLATILE_FIELDS = Object.freeze(["dedupKey", "roundKey", "round", "ts"]);

const VOLATILE = new Set(PAYLOAD_VOLATILE_FIELDS);

/**
 * 同 key 携带不同 payload 时抛出的错误（两个内置 store 抛的是同一份实现产出的同一形状）。
 * `code` 是公开判据，`name` 与 `NotesStoreError`（`src/store/notes-port.js`）同风格。
 */
export class TranscriptDedupConflictError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   runId?: string,
   *   key?: string,
   *   existingFingerprint?: string,
   *   incomingFingerprint?: string,
   *   differingFields?: string[]
   * }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "TranscriptDedupConflictError";
    this.code = DEDUP_CONFLICT_CODE;
    this.runId = details.runId;
    this.key = details.key;
    this.existingFingerprint = details.existingFingerprint;
    this.incomingFingerprint = details.incomingFingerprint;
    this.differingFields = details.differingFields ?? [];
  }
}

/**
 * 去重键（与两个内置 store 历史上的两份实现逐字同式；抽到这里就是为了不再各抄一遍）。
 * @param {string} runId
 * @param {any} record
 * @returns {string}
 */
export function recordKey(runId, record) {
  return record?.dedupKey
    ?? record?.roundKey
    ?? `${String(runId)}:round:${String(record?.round)}`;
}

/** @param {any} value @param {WeakSet<object>} seen @returns {string} */
function canonicalJson(value, seen) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "undefined" || type === "function" || type === "symbol") return "null";
  if (type === "bigint") return JSON.stringify(String(value));
  if (type !== "object") return JSON.stringify(value) ?? "null";
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  try {
    const toJSON = /** @type {{ toJSON?: () => any }} */ (value).toJSON;
    if (typeof toJSON === "function") return canonicalJson(toJSON.call(value), seen);
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      const childType = typeof child;
      // 与 JSON.stringify 同取舍：对象成员里的 undefined/函数/symbol 整个丢掉。
      if (childType === "undefined" || childType === "function" || childType === "symbol") continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(child, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * 参与摘要的那一份：顶层身份/派生字段剥掉，其余原样。
 * @param {any} record
 * @returns {any}
 */
function payloadOf(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return record;
  const kept = {};
  for (const [field, value] of Object.entries(record)) {
    if (VOLATILE.has(field)) continue;
    kept[field] = value;
  }
  return kept;
}

/** @param {any} value @returns {string} */
function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value, new WeakSet())).digest("hex").slice(0, 24)}`;
}

/**
 * payload 摘要（幂等/冲突的唯一判据）。同 key 的两份记录摘要相等 ⇒ 同一份 payload ⇒ 幂等跳过；
 * 不等 ⇒ 明确冲突。
 * @param {any} record
 * @returns {string} 形如 `sha256:<24 hex>`
 */
export function payloadFingerprint(record) {
  return digest(payloadOf(record));
}

/**
 * 冲突错误：消息里带 runId、key、两份 payload 指纹，以及（拿得出发散点时）顶层差异字段名清单。
 * `existing` 传 `undefined` 表示「既有 payload 取不到正文，只能比指纹」。
 * @param {{
 *   runId: string,
 *   key: string,
 *   existing: any,
 *   incoming: any,
 *   existingFingerprint: string,
 *   incomingFingerprint: string
 * }} input
 * @returns {TranscriptDedupConflictError}
 */
export function dedupConflictError({
  runId,
  key,
  existing,
  incoming,
  existingFingerprint,
  incomingFingerprint,
}) {
  const differingFields = differingTopLevelFields(existing, incoming);
  const where = differingFields.length > 0
    ? ` differing top-level fields: ${differingFields.join(", ")}.`
    : "";
  return new TranscriptDedupConflictError(
    `transcript appendRound dedup conflict (runId=${runId}, key=${key}):`
      + ` a record with this key is already persisted but its payload differs`
      + ` (existingFingerprint=${existingFingerprint}, incomingFingerprint=${incomingFingerprint}).`
      + ` Same-key append with a different payload is rejected — no overwrite, no silent drop;`
      + ` the stored record stays as-is.${where}`
      + ` Payload fingerprint = sha256 over the canonical JSON of the record with the top-level`
      + ` identity/volatile fields (${PAYLOAD_VOLATILE_FIELDS.join(", ")}) removed;`
      + ` object keys are sorted, array order is kept.`,
    {
      runId,
      key,
      existingFingerprint,
      incomingFingerprint,
      differingFields,
    },
  );
}

/**
 * 诊断用：两份记录的顶层差异字段名（含只在一侧出现的字段）。既有侧取不到正文时返回空数组。
 * 名字排序后取前 8 个，避免一条错误消息把整个字段表抄完。
 * @param {any} existing
 * @param {any} incoming
 * @returns {string[]}
 */
export function differingTopLevelFields(existing, incoming) {
  if (!isPlainLike(existing) || !isPlainLike(incoming)) return [];
  const names = new Set([...Object.keys(payloadOf(existing)), ...Object.keys(payloadOf(incoming))]);
  const differing = [];
  for (const name of [...names].sort()) {
    if (digest(payloadOf(existing)[name]) !== digest(payloadOf(incoming)[name])) {
      differing.push(name);
    }
  }
  return differing.slice(0, 8);
}

/** @param {any} value @returns {boolean} */
function isPlainLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
