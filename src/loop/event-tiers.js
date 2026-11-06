// issue #743：事件流的**「事实 / 流式增量」分级表**（一张纯查表的表，零行为）。
//
// 为什么需要它（现网读数与判据都写在 `docs/host-consumer-contract.md` 的
// 「Event tier table」一节）：宿主把观察者通道的每一条事件落进自己的事件表，而契约此前
// 从没说**哪一类可以清理**。于是唯一有体积压力的那一类（逐字的流式碎片）没人敢删——
// 工单实测：一张 `run_events` 占全库 91.6%，其中 `*_delta` 三类占**行数 99.2%**，
// 而生产代码对它的 `DELETE` 零命中。
//
// 本模块只回答一个问题：**这个事件类型属于哪一档**。它不删任何东西、不发任何事件、
// 不改任何发射点——`src/loop/orchestrator.js` 与 provider 流式那一片**一个字节都没动**
// （另一条分支正在那上面改 resume）。分级是**读侧的一张表**，写侧零变化。
//
// ── 三档的语义（可执行的定义，不是形容词）────────────────────────────────────────
//   `fact`     删了就**丢历史**：这条事件是它所记录的事实唯一的 durable 副本。
//   `stream`   无界碎片：载荷是逐 token / 逐字节的增量，而**成型的那一份在别处有 durable
//              副本**（`round_end.finalText`、账本 `record.messages` 里的 assistant 正文与
//              成型的 `tool_use` 入参），所以「run 已终 + 过了保留窗口」就可以删。
//   `derived`  载荷是别处**已有事实的投影或计数**：宿主可以自己重算，也可以直接丢弃——
//              丢了不丢历史，丢的是「引擎当时怎么算的」，不是「发生了什么」。
//
// 为什么 `derived` 只有三条而绝大多数是 `fact`：这一档的门槛是「**同一件事**在别处还有一份
// 能读到的 durable 副本，且本事件不带那份副本里没有的字段」。诊断类事件（`model_metadata_missing`、
// `persistence_capability_degraded`、`user_turn_guard_unrecoverable`……）虽然小、虽然每 run 至多
// 一条，但事件本身就是**唯一**记录（`user_turn_guard_unrecoverable` 更是契约里明写「刻意不写进
// `compactionStats`」的那一条），所以它们是 `fact`。把 `derived` 写成「不重要所以可丢」会把
// 宿主带到「删了再说」的口径上，而这一档真正的判据是「有没有第二份」。
//
// ── 真值口径（这张表为什么不会与代码漂）─────────────────────────────────────────
// 本表的键必须**恰好等于**引擎真会发出的事件名集合。这件事由
// `test/event-tier-coverage-743.test.js` 从**调用点**现推，不抄本文件的名单、也不抄契约文档的
// 清单：`emitEvent({ type: "…" })`、启动期直调 `onEvent?.({ type: "…" })`、装配端口
// `port.emit("…", …)`、事件装配 helper `runOutcomeRecord`（它的 `type` 写在 helper 的返回值里），
// 以及流式碎片那一族的 `queueEvent({ type: "…" })` / provider 自己的 `onEvent?.({ type: "…" })`。
// 两个方向都对账：少一个键（新增事件类型忘记分级）与多一个键（表里躺着没人发的名字）都红。
// 唯三**不是**引擎发射名的键逐条登记在下面 `HOST_SIDE_EVENT_TYPE_NAMES` 里并写明「它替谁」；
// 没登记的多出来的键同样红。
//
// ⚠ 这张表**不是**授权宿主去删。可删还要同时满足另外两个条件（run 已终 + 过了保留窗口），
// 完整判据与「删完回放退化成什么形状」在契约那一节；本模块把那条判据也实现成
// `streamCleanupEligible()`，这样契约里的谓词与代码是同一份，不是两份散文。

/**
 * The three tiers. `fact` is the only tier that must never be deleted; `stream` is the only
 * tier the cleanup predicate may ever delete; `derived` is the host's to recompute or drop.
 *
 * @typedef {"fact" | "stream" | "derived"} EventTier
 */

/** @type {EventTier} The event is the only durable copy of its fact — deleting it loses history. */
export const EVENT_TIER_FACT = "fact";
/** @type {EventTier} Unbounded per-token fragment; the assembled form has a durable copy elsewhere. */
export const EVENT_TIER_STREAM = "stream";
/** @type {EventTier} A projection or counter over facts already durable elsewhere. */
export const EVENT_TIER_DERIVED = "derived";

/** @type {EventTier[]} The whole value range of `EVENT_TIERS`, in declaration order. */
export const EVENT_TIER_VALUES = Object.freeze([EVENT_TIER_FACT, EVENT_TIER_STREAM, EVENT_TIER_DERIVED]);

/**
 * Event type name → tier. Keys are the names the engine really emits (see the file header for
 * the truth source and `HOST_SIDE_EVENT_TYPE_NAMES` for the three keys that are host-side
 * spellings rather than emission names).
 *
 * Every entry's tier is justified in `docs/host-consumer-contract.md` ("Event tier table");
 * the three `stream` names are the typewriter fragments the ticket measured at 99.2 % of the
 * rows, and `derived` is only ever a projection of a fact that already has a second copy.
 *
 * @type {Readonly<Record<string, EventTier>>}
 */
export const EVENT_TIERS = Object.freeze({
  // ── 轮结构与事实（删了就丢历史）──────────────────────────────────────────────
  round_start: EVENT_TIER_FACT,
  round_end: EVENT_TIER_FACT,
  attempt: EVENT_TIER_FACT,
  usage: EVENT_TIER_FACT,
  tool_use: EVENT_TIER_FACT,
  tool_result: EVENT_TIER_FACT,
  tool_replay_decision_required: EVENT_TIER_FACT,
  compaction: EVENT_TIER_FACT,
  compaction_deferred: EVENT_TIER_FACT,
  // 与 `compaction_deferred` 同理：它一次性地记下「降级到了哪个策略」，没别的副本可回放。
  compaction_strategy_fallback: EVENT_TIER_FACT,
  continuity_injection_skipped: EVENT_TIER_FACT,
  continuity_written: EVENT_TIER_FACT,
  continuity_write_failed: EVENT_TIER_FACT,
  config_override_conflict: EVENT_TIER_FACT,
  context_unknown_option: EVENT_TIER_FACT,
  model_metadata_missing: EVENT_TIER_FACT,
  persistence_capability_degraded: EVENT_TIER_FACT,
  budget_below_working_set: EVENT_TIER_FACT,
  forced_final: EVENT_TIER_FACT,
  final_guard: EVENT_TIER_FACT,
  final_guard_extend: EVENT_TIER_FACT,
  resume_journal_skipped: EVENT_TIER_FACT,
  user_turn_guard_unrecoverable: EVENT_TIER_FACT,
  run_outcome: EVENT_TIER_FACT,
  // 宿主把 `onJudge` 通道的决策记录按 `judge` 这个名字入库（引擎侧那条记录没有 `type` 字段，
  // 见 `HOST_SIDE_EVENT_TYPE_NAMES`）：裁决本身只在这里有一份。
  judge: EVENT_TIER_FACT,
  // ── 投影 / 计数（别处已有那一份事实，本条只是「引擎当时怎么算的」）────────────
  // 载荷恰好是 `{ round, attempt, maxAttempts }`，而这三个量在每次 attempt 开头的 `attempt`
  // 事件与本轮的 `round_end` 里都在 ⇒ 「第几轮重试了几次」可以从 `attempt` 行重算。
  recovering: EVENT_TIER_DERIVED,
  recovered: EVENT_TIER_DERIVED,
  // 契约自己写的口径：这条事件「about content size and never carries fact fields」。
  // 内容尺寸与归档字节从 `tool_result` 与归档文件重算得出来；被折走这件事落在 `tool_result` 上。
  tool_output_aggregate: EVENT_TIER_DERIVED,
  // ── 流式碎片（成型的那一份在别处）────────────────────────────────────────────
  // assistant 正文的逐字碎片。终稿的 durable 副本：`round_end.finalText` + 账本
  // `record.messages` 里的 assistant 正文 + `run_outcome` 所在 run 的结果对象。
  delta: EVENT_TIER_STREAM,
  // 工具入参的逐字碎片。成型入参的 durable 副本：`tool_use` 事件（`toolUse.input`）+ 账本里的
  // `tool_use` 块。引擎把它发给 `onToolCall`，**不**经 `onEvent`（契约的 onEvent 工具事件清单）。
  tool_call: EVENT_TIER_STREAM,
  // 思考正文的逐字碎片。成型副本：账本里那条 assistant 消息的 reasoning/thinking 块
  // （宿主显示面用 `projectTranscriptForDisplay` 的 `reasoning` 字段读它）。
  reasoning_delta: EVENT_TIER_STREAM,
  // ── 宿主入库时的拼写（与上面同档，理由见 `HOST_SIDE_EVENT_TYPE_NAMES`）────────
  assistant_delta: EVENT_TIER_STREAM,
  tool_call_delta: EVENT_TIER_STREAM,
});

/**
 * Names a host may already have written into its own event table that are **not** names the
 * engine emits, with the emission name each one stands for (or the channel it names).
 *
 * They are in `EVENT_TIERS` so a host can look its own `type` column up without a mapping layer
 * of its own, and they are registered here because the coverage guard must otherwise red on a
 * key no emitter produces — an unregistered extra key is exactly the drift this table is not
 * allowed to develop.
 *
 * ⚠ The mapping is derived from the ticket's own wording (`assistant_delta` = 「打字机碎片」
 * for assistant text, `tool_call_delta` = 「工具入参逐字流」), **not** from this repository:
 * `grep -rn "assistant_delta\|tool_call_delta" src/ bin/` is empty, so the engine never emits
 * those two spellings. A host that renamed them owns that rename.
 *
 * @type {Readonly<Record<string, { standsFor: string, channel: string, why: string }>>}
 */
export const HOST_SIDE_EVENT_TYPE_NAMES = Object.freeze({
  assistant_delta: Object.freeze({
    standsFor: "delta",
    channel: "onDelta",
    why: "宿主把 assistant 正文的逐字碎片存成 `assistant_delta`；引擎发的名字是 `delta`（`src/loop/provider-runner.js` 的 `queueEvent`、`src/providers/openai.js`、`src/messages/anthropic.js`）",
  }),
  tool_call_delta: Object.freeze({
    standsFor: "tool_call",
    channel: "onToolCall",
    why: "宿主把工具入参的逐字碎片存成 `tool_call_delta`；引擎发的名字是 `tool_call`，且普通 `runToolLoop` run 根本不把它送进 `onEvent`（契约「onEvent tool event field list」）",
  }),
  judge: Object.freeze({
    standsFor: "judge",
    channel: "onJudge",
    why: "`judge` 事件不是 `LoopEvent` 的一格：引擎经 `onJudge` 通道交出一条决策记录，那条记录**没有** `type` 字段（`src/loop/orchestrator.js` 的 `emitJudge` 铺的是 `{...correlation, ...info}`），宿主按通道名把它存成 `judge`",
  }),
});

/**
 * The run statuses the engine itself writes through `markRunState`, minus `"running"`.
 *
 * These are the names the cleanup predicate's second condition reads — **not** a host database's
 * `status` column: the ticket's `{succeeded, failed, cancelled, expired}` are host-side values and
 * only `succeeded` / `failed` happen to exist on the engine side. Writers, verbatim:
 *   · `"succeeded"` / `"unverified_error"` / `"guard_error"` — `finish()` (`src/loop/termination.js`),
 *     chosen from `verification.status`;
 *   · `"aborted"` / `"failed"` — the throwing path `fail()` (`src/loop/orchestrator.js`);
 *   · `"running"` — the start and every resume (`src/loop/resume-manager.js`), i.e. explicitly **not**
 *     terminal, so an in-flight or crashed-and-not-finished run is never cleaned by this predicate.
 * `persistence_failed` is a `termination.reason` on the throw path, not a `markRunState` value,
 * and the terminal-status reader is the optional `loadRunStateStatus(runId)`.
 *
 * @type {Readonly<string[]>}
 */
export const RUN_TERMINAL_STATUSES = Object.freeze([
  "succeeded",
  "unverified_error",
  "guard_error",
  "aborted",
  "failed",
]);

/**
 * The tier of one event type name, or `undefined` when this table does not know the name.
 *
 * `undefined` is deliberate: a host that treats "unknown" as deletable would delete the next
 * event type this engine grows. The cleanup predicate below only ever accepts `stream`.
 *
 * @param {string} type an event type name — an engine emission name or a host-side spelling
 * @returns {EventTier | undefined}
 */
export function eventTierOf(type) {
  if (typeof type !== "string") return undefined;
  const tier = EVENT_TIERS[canonicalEventTypeName(type)];
  return tier === undefined ? undefined : tier;
}

/**
 * `EVENT_TIERS` 的**载入期不变量自检**（值域 + 别名闭合）。
 *
 * 为什么在载入期判而不是只靠用例：这张表是宿主的清理依据，而它有两个「写错了也不会响」的形状——
 * 值写成 `"streem"`（拼错的档位，谓词从此永不判它可删）、别名的 `standsFor` 指向一个表里没有的
 * 名字（查表静默回落成 `undefined`，宿主读成「不知道 ⇒ 不许删」）。两种都是**安静的**失效，
 * 而宿主侧的代价不对称（前者删错，后者永远删不掉）。载入期一条 `throw` 把它们变成响的。
 * 只读表本身，零 IO、零副作用；`Object.freeze` 之后表与别名表都不可变，所以这条自检的结论
 * 在模块生命周期内恒成立。
 *
 * @param {Record<string, string>} table
 * @param {Record<string, { standsFor: string }>} aliases
 * @param {string[]} allowedTiers
 * @returns {number} 校验过的键数（自检真的跑了的证据；0 是要红的那种「空表恒真」）
 */
function assertTierTable(table, aliases, allowedTiers) {
  const keys = Object.keys(table);
  if (keys.length === 0) {
    throw new TypeError("EVENT_TIERS 是空表 —— 分级面读不到真值，不许当成「没问题」");
  }
  for (const name of keys) {
    if (!allowedTiers.includes(table[name])) {
      throw new TypeError(`EVENT_TIERS.${name} 的档位 ${JSON.stringify(table[name])} 不在值域 ${allowedTiers.join(" / ")} 里`);
    }
  }
  for (const [alias, entry] of Object.entries(aliases)) {
    const target = entry.standsFor;
    if (target === alias) continue; // `judge` 替的是通道，不是另一个事件名
    if (table[target] === undefined || table[target] !== table[alias]) {
      throw new TypeError(`HOST_SIDE_EVENT_TYPE_NAMES.${alias} 指向 ${target}，但两者的档位不一致`);
    }
  }
  return keys.length;
}

/**
 * The engine-side name a host's stored type name stands for (identity for emission names).
 *
 * @param {string} type
 * @returns {string} the key of `EVENT_TIERS` the name resolves to
 */
export function canonicalEventTypeName(type) {
  const alias = typeof type === "string" ? HOST_SIDE_EVENT_TYPE_NAMES[type] : undefined;
  return alias === undefined ? type : alias.standsFor;
}


/**
 * The second and third conditions of the contract's cleanup predicate, executable.
 *
 * The rule, in one line: **`type ∈ stream ∧ run 已终 ∧ ts < now − retention` ⇒ 可删.** The tier
 * check and the terminal-status check live here so the contract sentence and the code cannot
 * drift apart; the retention window is the host's own number and stays the host's argument.
 *
 * Both halves are fail-closed on purpose: an unknown type is never deletable, and a missing or
 * non-terminal status is never deletable (a run whose terminal status was never written — a
 * crash, or a store without `markRunState` — keeps its fragments rather than losing the
 * in-flight replay the host needs to keep watching it).
 *
 * @param {{type?: string, runStatus?: string, ageMs?: number, retentionMs?: number}} input
 * @returns {boolean} true only when all three conditions hold
 */
export function streamCleanupEligible({ type, runStatus, ageMs, retentionMs } = {}) {
  if (eventTierOf(type) !== EVENT_TIER_STREAM) return false;
  if (typeof runStatus !== "string" || !RUN_TERMINAL_STATUSES.includes(runStatus)) return false;
  if (!Number.isFinite(ageMs) || !Number.isFinite(retentionMs)) return false;
  return ageMs > retentionMs;
}

/**
 * 表 ↔ 谓词的一致性自检（同样是载入期，理由同 `assertTierTable`）。
 *
 * 只把档位与终态名单放成两张互不引用的常量，就会出现「表说 `delta` 是 `stream`，而谓词因为
 * 拼错的档位常量永远拒它」这种两边各自绿、宿主永远清不掉的形状。本自检把表里每一个名字都递
 * 给谓词跑一遍（终态取名单的第一格，年龄取「明显过了窗口」的那一档），要求
 * **可清理 ⇔ 档位是 `stream`**，两边对不上当场 `throw`。
 *
 * @returns {number} 交叉校验过的名字数
 */
function assertPredicateAgreesWithTable() {
  const terminal = RUN_TERMINAL_STATUSES[0];
  const checks = Object.keys(EVENT_TIERS).filter((name) => eventTierOf(name) !== undefined);
  for (const name of checks) {
    const deletable = streamCleanupEligible({ type: name, runStatus: terminal, ageMs: 10, retentionMs: 1 });
    if (deletable !== (EVENT_TIERS[name] === EVENT_TIER_STREAM)) {
      throw new TypeError(
        `分级表与清理谓词对「${name}」的结论不一致：档位 ${EVENT_TIERS[name]}，谓词 ${deletable ? "可删" : "不可删"}`,
      );
    }
  }
  return checks.length;
}

assertTierTable(EVENT_TIERS, HOST_SIDE_EVENT_TYPE_NAMES, EVENT_TIER_VALUES);
assertPredicateAgreesWithTable();

