import { randomUUID } from "node:crypto";
import { buildUnpersistedToolResultStub } from "../loop/pending-tool-result.js";
import { blocksFor } from "../loop/block-helpers.js";
import { MESSAGE_ROW_KIND, isRoundCarrier, nextMessageSeqByRound } from "./message-rows.js";

// ── issue #765：宿主预写用户轮**落盘之前**先结清账本尾部的悬空 `tool_use`──────────────
//
// 为什么时机必须在**写之前**，而不是让宿主事后补一条原始行：「事后补进去的行位置不对」是折叠口径
// 决定的（`src/store/message-rows.js#attachRoundMessages` 那段：同一轮内按 `seq` 排、跨轮按 round 分桶），
// 而宿主那条纯文本轮一落盘，尾行就变成一条**带正文的 user** ⇒ ① 任何补在它后面的 `user[tool_result]`
// 在折叠视图里都排在它**后面**（出网顺序成 `assistant[TU] → user(text) → user(TR)`，provider 直接 400）；
// ② `pendingTailToolUses` / `resumeMessagesWithUnpersistedToolResults` 的**尾部**判据同时失效（尾行不再是
// 带 `tool_use` 的 assistant），引擎侧再也看不见这笔悬空。结清行自己当尾行则顺序天然正确，不需要事后修补。
//
// 结清行的形状（逐条有出处，不在这里重新发明）：块走唯一构造点 `buildUnpersistedToolResultStub`
// （#421 那一块：`content = UNPERSISTED_TOOL_RESULT_TEXT` + `is_error: true`）；`kind` / `seq` 与引擎写的
// 消息行同口径（`MESSAGE_ROW_KIND` + `nextMessageSeqByRound` 现取：不传 `seq` 就落 `seq: undefined` ⇒
// `foldMessageRows` 里 `undefined < undefined` 为假 ⇒ 多条补行乱序，见 `src/store/message-rows.js:201`）；
// **不写 `roundKey`** —— `isRoundCarrier` 认「无 `dedupKey` 且（无 `seq` 或有 `roundKey`）」，带 `dedupKey` 已
// 不算轮载体，但缺 `seq` 的 store 上一旦多给个 `roundKey` 就会被当成**第二个载体**，R3 守卫随即丢掉我们
// 刚写的这条（静默丢失，比什么都不做更糟）。幂等：`dedupKey = <key>:settle:<round>:<排序后的 id 列表>`
// —— 不含时间戳 / messageId ⇒ 同一本账本反复预写只结清一次，快路径与全量路径写的行逐字相同。

// 拒写成因。**故意不复用** `resume_journal_skipped` 那张表（`src/loop/resume-manager.js` + `docs/host-events.md`）：
// 成因表与事件名都是闭集，`test/loop-resume-abandon-signals-730.test.js:117` 钉了「新成因必须先在 docs 出现」，
// 而 store 层不发事件（它没有 onEvent，发了也没人听）⇒ 原因只能进返回值。字面值与那张表对齐是为了宿主读得懂，
// 同名的 `anchor_probe_absent` 这里叫 `ledger_probe_absent` 是刻意的：探针不是 issue #730 那件东西，
// 共用一个词会让读事件的人以为看到了同一件事。
const SETTLE_REFUSED_LEDGER_PROBE_ABSENT = "ledger_probe_absent";
const SETTLE_REFUSED_ROUND_NOT_SAFE_INTEGER = "round_not_safe_integer";
const SETTLE_REFUSED_ROUND_CARRIER_HAS_BODY = "round_carrier_has_body";
const SETTLE_REFUSED_TOOL_USE_ID_UNUSABLE = "tool_use_id_unusable";

function messagesOfRow(row) {
  return Array.isArray(row?.messages) ? row.messages : [];
}

function allMessages(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap(messagesOfRow);
}

/**
 * 尾部那条「带 `tool_use` 的 assistant」逻辑消息；没有则 null。
 * 口径与 `src/loop/pending-tool-result.js#pendingTrailingToolUses` 同一条（从尾往前第一条带 tool_use 的
 * assistant 消息），差别只在这里扫的是**账本行**而不是 provider 消息：分片行（带 `partOf`）并进它指认的
 * 那条消息、自己不新起一条逻辑消息 ⇒ 不参与「谁是尾行」的判断。
 * @param {object[]} rows
 * @returns {{ row: object, toolUses: object[] }|null}
 */
function trailingToolUseRow(rows) {
  let tail = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.partOf === "string" && row.partOf !== "") continue;
    const messages = messagesOfRow(row);
    if (messages.length === 0) continue;
    const toolUses = blocksFor(messages[messages.length - 1]?.content)
      .filter((block) => block?.type === "tool_use");
    const isTail = messages[messages.length - 1]?.role === "assistant" && toolUses.length > 0;
    tail = isTail ? { row, toolUses } : null;
  }
  return tail;
}

/**
 * 在宿主那条 `user[text]` 行落盘**之前**结清悬空 `tool_use`。返回值的 `status`：
 * - `clean`：账本里没有悬空（调用方**不**把结果放进返回值 ⇒ 今天的返回形状逐字不变）；
 * - `settled`：结清行已落盘（`written: true`），或同 `dedupKey` 的结清行已在账本里（`written: false`）；
 * - `refused`：该结清而没结清，`reason` 点名为什么（调用方原样带在返回值里，不许静默）。
 * @param {{ appendRound: (key:string, record:object)=>Promise<unknown> }} store
 * @param {string} key
 * @param {object[]|undefined} rows 结清用的账本行：全量路径 = 已经拿到的 `load(key)` 结果（不重读）；
 *   探针快路径 = `loadRawRows(key)`，缺探针时为 undefined
 * @param {string|undefined} ts
 */
async function settleUnsettledToolUses(store, key, rows, ts) {
  // 探针缺席（或给了非数组）⇒ 什么都不读、什么都不写。快路径存在的意义就是「不整本读」，
  // 为了结清去整本读一次是把 #157 的优化退回去；宿主补上 `loadRawRows` 即自愈（#714 加这根探针时
  // 就是为同一个形状服务的）。
  if (!Array.isArray(rows)) {
    return { status: "refused", reason: SETTLE_REFUSED_LEDGER_PROBE_ABSENT, toolUseIds: [] };
  }
  const tail = trailingToolUseRow(rows);
  if (tail === null) return { status: "clean", toolUseIds: [] };
  // 「没有任何对应 `tool_result`」的口径 = **整本账本**（与 issue #765 判据同一条）。
  // 不用 `src/messages/rounds.js#collectToolUseIds`：那一份的语义是「最后一条 assistant 的未答 tool_use」
  // ——前缀视图（`pendingTailToolUses` 同款），账本里只要有一条晚一点的 `user[text]` 它就把早先的悬空当已答。
  const settled = new Set(allMessages(rows).flatMap((message) => blocksFor(message?.content))
    .filter((block) => block?.type === "tool_result")
    .map((block) => block?.tool_use_id));
  const dangling = tail.toolUses.map((block) => block?.id).filter((id) => !settled.has(id));
  if (dangling.length === 0) return { status: "clean", toolUseIds: [] };
  // id 不合法（空 / 非字符串）时这张桩在 wire 上也是错的 ⇒ 交给 `validateMessages` 如实报（#421 纪律 ⑤
  // 「不发明第三种兜底」同一口径），这里只把原因说明白。
  if (!dangling.every((id) => typeof id === "string" && id !== "")) {
    return { status: "refused", reason: SETTLE_REFUSED_TOOL_USE_ID_UNUSABLE, round: tail.row?.round, toolUseIds: dangling };
  }
  const round = tail.row?.round;
  if (!Number.isSafeInteger(round)) {
    return { status: "refused", reason: SETTLE_REFUSED_ROUND_NOT_SAFE_INTEGER, round, toolUseIds: dangling };
  }
  // 同轮载体已带正文（引擎崩溃前写过 `assistant[text]` 行）时，折叠会把它当**活载体**（`isRoundCarrier`，
  // 判据里 `messages.length === 0` 那一支），我们这条结清行被并进去之后排在哪由 seq 决定，而 seq 恰恰
  // 是最不可信的那一格（`resume-manager#roundHasBodyCarrier` 那段注释：`nextMessageSeqByRound` 只数消息行）。
  // 这种轮很少见，不值得赌顺序 ⇒ 拒写，把顺序问题留给引擎的续跑复放（`answerPendingMidSequenceToolUses`）。
  if (rows.some((row) => isRoundCarrier(row, round) && messagesOfRow(row).length > 0)) {
    return { status: "refused", reason: SETTLE_REFUSED_ROUND_CARRIER_HAS_BODY, round, toolUseIds: dangling };
  }
  const toolUseIds = [...new Set(dangling)];
  const dedupKey = `${key}:settle:${round}:${[...toolUseIds].sort().join("+")}`;
  const report = { status: "settled", round, toolUseIds, dedupKey };
  // 幂等：同一本账本反复预写（崩溃重跑、宿主重试）同 dedupKey ⇒ 只有一条结清行。
  // 幂等：同一本账本反复预写（崩溃重跑、宿主重试）同 dedupKey ⇒ 只有一条结清行。取行 id 的写法与本文件
  // 下方查 `existing` 那两行逐字同形（`message-rows.js#rowKey` 的口径，但**没有**它那个合成回退）。
  if (rows.some((row) => (row?.dedupKey ?? row?.roundKey) === dedupKey)) return { ...report, written: false };
  const record = {
    round,
    messages: [{ role: "user", content: toolUseIds.map((toolUseId) => buildUnpersistedToolResultStub(toolUseId)) }],
    dedupKey,
    kind: MESSAGE_ROW_KIND,
    // 没有这一行 = `seq: undefined` ⇒ 折叠时排序键退化成 undefined，多条补行相对顺序随写序漂移。
    seq: nextMessageSeqByRound(rows).get(round) ?? 0,
    ts: ts ?? new Date().toISOString(),
  };
  await store.appendRound(key, record);
  return { ...report, written: true, seq: record.seq };
}

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
 * - 成对可选快路径探针（issue #157，宿主 DB store 用）：`loadByDedupKey` 与
 *   `loadMaxRound` 两者都是函数时 appendUserTurn 走点查快路径——先算 dedupKey →
 *   loadByDedupKey 命中即返回（不调 loadMaxRound、不调 load）；未命中才 loadMaxRound
 *   派生 round → appendRound。快路径全程**不调用 store.load**。缺任一方法则回退现行为
 *   （全量 load），成对生效、缺一如缺二。返回形状违约抛 TypeError。
 *   内置 file store 不实现（点查对 JSONL 无意义，#160 已优化）。
 * - `written: true` 表示本次调用执行了 appendRound；不保证并发去重场景下实际落盘
 *   （store 可能吞掉并发重复写）。同 key 的追加应由宿主串行（或在宿主事务内）发起。
 * - 悬空 `tool_use` 的结清（issue #765，本文件顶部那段注释是它的完整口径）：写宿主那条 `user[text]`
 *   行**之前**，若账本尾行是一条带 `tool_use` 的 assistant、且那些 id 在**整本账本**里没有任何对应
 *   `tool_result`，先落一条 `user[tool_result]` 结清行（`kind: "message"` + 现取 `seq`，块 = #421 那张桩）。
 *   没有悬空时不写这一行，返回形状与今天逐字相同；有悬空时返回值多一个 `unsettledToolUses`，
 *   `status` 只有 `settled` / `refused` 两种——**拒写也要出声**（原因在 `reason` 里），本函数不静默。
 *   探针快路径（上条）要读账本只能走 `loadRawRows`；三根探针都没有的宿主 ⇒ `reason:
 *   "ledger_probe_absent"`，既不静默也不退回去整本读一次。
 *
 * ⚠ 两个坑（issue #213 R4 实测，都是**静默**退化）：
 *   1. 本块必须紧贴 `export async function appendUserTurn`——它曾经孤悬在
 *      `maxRoundFromProbe` 的文档块之上，导致 appendUserTurn 在 `.d.ts` 里全是推断值
 *      （`store: any`、`round: any`）而编译一个错也不报；
 *   2. 下面两个内联类型字面量里不得出现**独占一行的 `//` 注释**（TypeScript 的 JSDoc
 *      类型解析器直接放弃整个参数类型），行尾 `//` 才安全。
 *
 * @param {{
 *   load: (key:string) => Promise<object[]>,
 *   appendRound: (key:string, record:object) => Promise<unknown>,
 *   loadByDedupKey?: (key:string, dedupKey:string) => Promise<object|null|undefined>, // 可选快路径探针，issue #157
 *   loadMaxRound?: (key:string) => Promise<number|null|undefined>,                     // 与上者成对生效
 *   loadRawRows?: (key:string) => Promise<object[]>                                    // 可选，仅 #765 结清悬空 tool_use 时读（未折叠行；快路径唯一的账本来源）
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
 *   written: boolean,      // true = 本次调用执行了 appendRound（见上文「并发去重」条）
 *   record?: object,       // existing record when written === false
 *   unsettledToolUses?: {  // 仅当账本里有悬空 `tool_use` 时出现（#765）；没悬空时返回形状与今天逐字相同
 *     status: "settled" | "refused",
 *     written?: boolean,   // settled：true = 本次写了结清行；false = 同 dedupKey 的行已在账本里（幂等重跑）
 *     round?: number,      // 被结清的那一轮（= 悬空 assistant 所在轮）
 *     toolUseIds?: string[],
 *     dedupKey?: string,   // `<key>:settle:<round>:<排序后的 id>`
 *     reason?: string      // refused 的成因，四条取值见文件顶部 SETTLE_REFUSED_*
 *   }
 * }>
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
    // 未命中：loadMaxRound 派生 round → **先结清悬空 `tool_use`**（#765）→ appendRound。
    const probeRound = await maxRoundFromProbe(store, key);
    // 快路径全程不调 `store.load`（#157 的契约，上面文档块里钉着），所以账本行只能来自第三根探针
    // `loadRawRows`（#714 为同一件事加的那根）。探针缺席 ⇒ **拒写并出声**（返回值里点名原因），
    // 绝不退回去整本读一次，也绝不静默把悬空留在账本里。
    const settle = await settleUnsettledToolUses(store, key,
      typeof store.loadRawRows === "function" ? await store.loadRawRows(key) : undefined, ts);
    const probeRecord = {
      round: probeRound,
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      dedupKey,
      roundKey: dedupKey,
      ts: ts ?? new Date().toISOString(),
    };
    await store.appendRound(key, probeRecord);
    return {
      key,
      dedupKey,
      round: probeRound,
      written: true,
      ...(settle.status === "clean" ? {} : { unsettledToolUses: settle }),
    };
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

  // #765：宿主那条 `:input:` 行落盘**之前**先结清。这里复用已经拿到的 `records`，不重读一次 store。
  const settle = await settleUnsettledToolUses(store, key, records, ts);

  const record = {
    round,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    dedupKey,
    roundKey: dedupKey,
    ts: ts ?? new Date().toISOString(),
  };
  await store.appendRound(key, record);
  return { key, dedupKey, round, written: true, ...(settle.status === "clean" ? {} : { unsettledToolUses: settle }) };
}
