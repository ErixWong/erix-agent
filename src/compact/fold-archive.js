// issue #460：折叠归档（`record.foldedPayload`）的写侧边界。
//
// 旧形状：每次折叠把「被折走的原文整包」全量写进那一条轮记录。真机（erix-station v0.1.32，
// 会话 9e0c8a17）实测单轮记录 569 KB → 743 KB → 961 KB → 1.13 MB **随会话长度线性增长**，
// 而它对同轮模型上下文的贡献是 0 字节（`resume-manager.js` 从不回读 `record.foldedPayload`，
// 唯一的 record 级消费者是 `record.foldedSummary`），内容又是账本已有行的逐字节复制
// （round 137：归档 940 278 B vs `round ≤ 133` 那些行自己的 `messages` 合计 941 379 B，差 0.1%）。
// 于是任何对「单条记录」定界的宿主（本站 1 MB）一旦被越过，宿主正当的 400 就被换算成
// `persistence_failed` 整 run 终局 —— 一条咨询性归档没存下，升级成任务失败。
//
// 本模块把写进轮记录的那一份改成**有界差分**，三件事：
//   ① 去重：同一份正文在**同一会话**里只归档一次。指纹按消息算（sha256），run 内记账；
//      resume 过的会话（`foldedThrough > 0`）额外从 `store.load()` 把此前各轮已归档的正文
//      预先入账 —— 这正是真机那条放大链：resume 把整段账本重灌回上下文，于是每次折叠
//      都把「整段历史」重新归档一遍（差分总量 O(n²)，而理论只需一份）。
//   ② 上限：按 UTF-8 字节夹断，默认 256 KiB，`context.maxFoldedPayloadBytes` 或环境变量
//      `ERIX_FOLD_ARCHIVE_MAX_BYTES` 可调（`0` = 只留指针不写正文）。超限时保尾丢头 ——
//      最近折走的原文对锚定最有用，最老那些正文在账本里各有一行。
//   ③ 留痕：丢掉的条数/字节数写进 `record.foldedPayloadMeta`，否则「被夹断」与「没折过」
//      在账本上同形。
//
// ⚠ 口径边界：本模块只管**落进轮记录**的那一份。策略返回值 `result.foldedPayload` 是「被折轮
// 原文」的权威口径，也是宿主的 `onAfterFold` / `recoveryHint` / stub 解析吃的那一份内存全量，
// 本模块不改它、也不拿别的东西去替换它的内容（曾按「折叠前后对象身份」反推 ⇒ 被原地改写的
// 保留消息被误判成折走，`test/loop-fr2.test.js` 当场转红）。
import { cloneFoldPayload } from "./helpers.js";
import { createHash } from "node:crypto";

const encoder = new TextEncoder();

// 契约里宿主有权对单条记录定界（erix-station 现值 1 MB）。真机实测非归档部分稳定 ≈ 20 425 B，
// 所以归档这一份夹到 256 KiB 后，整条记录离闸还有一个数量级以上的余量。
export const DEFAULT_FOLD_ARCHIVE_MAX_BYTES = 262_144;
export const FOLD_ARCHIVE_MAX_BYTES_ENV = "ERIX_FOLD_ARCHIVE_MAX_BYTES";

/**
 * UTF-8 字节数（与宿主的 `octet_length` /「请求体超过 1MB」同一口径）。
 *
 * @param {unknown} value JSON-serializable value.
 * @returns {number}
 */
export function payloadByteLength(value) {
  if (value === undefined || value === null) return 0;
  try {
    return encoder.encode(JSON.stringify(value)).length;
  } catch {
    // 不可序列化（循环引用 / BigInt）：按 0 计 ⇒ 宁可多留原文，也不因为量不出来就丢数据。
    return 0;
  }
}

/**
 * 归档字节上限：显式配置 > 环境变量 > 默认值。
 *
 * @param {unknown} explicit `context.maxFoldedPayloadBytes`.
 * @returns {number}
 */
export function resolveFoldArchiveMaxBytes(explicit) {
  for (const candidate of [explicit, process.env[FOLD_ARCHIVE_MAX_BYTES_ENV]]) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const parsed = typeof candidate === "number" ? candidate : Number(String(candidate).trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) continue;
    return parsed;
  }
  return DEFAULT_FOLD_ARCHIVE_MAX_BYTES;
}

/**
 * 一条被折原文的指纹：规范化 JSON 的 sha256。
 * 键序不是语义（逐层排序），数组序是语义（消息顺序保留），与 `fold-summary-journal` 同一口径。
 *
 * @param {unknown} message Canonical message.
 * @returns {string}
 */
export function foldMessageFingerprint(message) {
  return createHash("sha256")
    .update(canonicalJson(message), "utf8")
    .digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return "null";
}

/**
 * 一次 run 的归档去重账本（同一份正文只归档一次）。
 *
 * @param {{ store?: { load?: (runId: string) => Promise<object[]> }, runId?: string }} [options]
 *   resume 过的会话用它把「此前各轮已经归档过的正文」预先入账；端口缺 `load` 时静默跳过。
 * @returns {{
 *   seedFromRecords: (records: object[]) => number,
 *   ensureSeeded: (beforeRound?: number) => Promise<void>,
 *   selectUnarchived: (messages: object[]) => { kept: object[], dedupedMessages: number, dedupedBytes: number },
 *   seenCount: () => number,
 * }}
 */
export function createFoldArchiveLedger(options = {}) {
  const seen = new Set();
  let seeded = false;

  const seedFromRecords = (records) => {
    let added = 0;
    for (const record of Array.isArray(records) ? records : []) {
      for (const message of Array.isArray(record?.foldedPayload) ? record.foldedPayload : []) {
        const fingerprint = foldMessageFingerprint(message);
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          added += 1;
        }
      }
    }
    return added;
  };

  return {
    seedFromRecords,
    async ensureSeeded(beforeRound) {
      if (seeded) return;
      seeded = true;
      if (typeof options.store?.load !== "function" || options.runId === undefined) return;
      let records = [];
      try {
        records = await options.store.load(options.runId);
      } catch {
        // 读侧失败不影响折叠：最坏退化成「本 run 内去重」，仍有上限与留痕兜着。
        return;
      }
      // ⚠ 只预入**早于本轮**那些轮的归档（`record.round < beforeRound`）。本记录自己的去重
      // 判据把「同 key 换 payload」报成 `dedup_payload_conflict`（`src/store/transcript-dedup.js`），
      // 而崩溃重跑同一个折叠轮时，上一次尝试自己写的那份归档就落在**同一轮**上：把它算进
      // 去重集 ⇒ 本次选出的 payload 会从 `[...]` 变成 `[]` ⇒ 同 key 不同 payload ⇒ 误判成冲突
      //（契约明写「误判成冲突比漏判更糟」）。排除本轮后，同一次折叠的重跑与首次尝试选出同一个
      // payload（去重集只取决于 `< beforeRound` 那段不变的前缀），`foldedPayloadMeta` 也不再漂。
      const scoped = Number.isSafeInteger(beforeRound)
        ? records.filter((record) => !(
          Number.isSafeInteger(record?.round) && record.round >= beforeRound
        ))
        : records;
      seedFromRecords(scoped);
    },
    selectUnarchived(messages) {
      const kept = [];
      let dedupedMessages = 0;
      let dedupedBytes = 0;
      for (const message of Array.isArray(messages) ? messages : []) {
        const fingerprint = foldMessageFingerprint(message);
        if (seen.has(fingerprint)) {
          dedupedMessages += 1;
          dedupedBytes += payloadByteLength(message);
          continue;
        }
        seen.add(fingerprint);
        kept.push(message);
      }
      return { kept, dedupedMessages, dedupedBytes };
    },
    seenCount: () => seen.size,
  };
}

/**
 * 构造要写进轮记录的折叠归档：去重 → 字节夹断 → 留痕。
 *
 * @param {object} options
 * @param {object[]} [options.foldedPayload] 策略给出的被折原文（权威内容源）。
 * @param {boolean} [options.stripHistoricalImages] 内容源未剥历史图片时在这里剥（同策略口径）。
 * @param {number} [options.maxBytes] 显式上限（否则环境变量 / 默认值）。
 * @param {{ selectUnarchived: (messages: object[]) => { kept: object[], dedupedMessages: number, dedupedBytes: number } }} [options.ledger]
 *   会话级去重账本；缺省时不去重。
 * @returns {{ payload: object[], meta: Record<string, number> }}
 */
export function buildFoldedRecordArchive(options = {}) {
  const capBytes = resolveFoldArchiveMaxBytes(options.maxBytes);
  const cloned = cloneFoldPayload(
    Array.isArray(options.foldedPayload) ? options.foldedPayload : [],
    options.stripHistoricalImages,
  );

  let payload = cloned;
  let dedupedMessages = 0;
  let dedupedBytes = 0;
  if (options.ledger !== undefined) {
    const { kept, dedupedMessages: messages, dedupedBytes: bytes } = options.ledger
      .selectUnarchived(payload);
    payload = kept;
    dedupedMessages = messages;
    dedupedBytes = bytes;
  }

  const sourceBytes = payloadByteLength(payload);
  let droppedMessages = 0;
  if (capBytes === 0) {
    // `0` 是合法上限：只留指针不写正文。
    droppedMessages = payload.length;
    payload = [];
  } else if (payloadByteLength(payload) > capBytes) {
    const kept = [];
    let keptBytes = 2; // "[]"
    for (let index = payload.length - 1; index >= 0; index -= 1) {
      const itemBytes = payloadByteLength([payload[index]]);
      if (kept.length > 0 && keptBytes + itemBytes > capBytes) break;
      kept.unshift(payload[index]);
      keptBytes += itemBytes;
    }
    droppedMessages = payload.length - kept.length;
    payload = kept;
  }
  const bytes = payloadByteLength(payload);

  return {
    payload,
    meta: {
      messages: payload.length,
      bytes,
      capBytes,
      // 只描述「折走了但没进这份归档」的部分，供宿主/取证核对丢了哪些、丢多少。
      droppedMessages,
      // `sourceBytes` 已是去重后的口径 ⇒ 不能再减 `dedupedBytes`（那会把夹断量双扣一次）。
      droppedBytes: Math.max(0, sourceBytes - bytes),
      dedupedMessages,
      dedupedBytes,
    },
  };
}
