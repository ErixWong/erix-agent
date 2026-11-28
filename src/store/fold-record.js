// @ts-check
// issue 261128-09（切片 1）：今天的 `foldedFacts` 形状 ⇄ ADR-022「第二刀」九列折叠记录的**纯函数适配**。
//
// 为什么单独一个模块：ADR-022 顶部「第二刀（2026-11-28）」把 `folds` 的列集合从「与
// `buildFoldedFacts` 逐键对齐」改成**形状稿九列 + `fold_id`**（幂等键）。本切片**只做形状互转、
// 不接线**——`src/store/*` 的存储实现、`orchestrator.js` 的写点、契约面一处都不动。
//
// 三条不可让的形状口径（都写在 ADR 第二刀的列表与退役表里，这里只复述理由）：
//   ① **无事实不写键**：拿不到的列**缺席**，不用 `0` / `-1` / `""` 顶替——`cut_round = 0` 是一个
//      **假切点**，`title = ""` 会被读成「模型给了空标题」（列的 `NULL` 才是「模型没给」的标记）。
//   ② **不许跨尺子冒充**：`tokens_before` / `tokens_after` 是预算尺子，今天的 `bytes` 是序列化尺子，
//      两者不可互换 ⇒ 入参没给 token 就缺席，绝不拿 `bytes` 填。
//   ③ **退役 ≠ 消失**：`bytes` / `truncated` / `from` / `to` / … 不再是**列**，但它们仍是**契约键**
//      （`docs/host-consumer-contract.md:6962` 逐字列出 `{ text, source, strategy, from, to, rounds,
//      bytes, truncated?, degradeReason?, foldId, seq }`，`onFoldSummary` 整份递给宿主）⇒
//      `fromFoldRecords` 从九列把**能导出的那几格**原样导出，导不出的（`truncated` / `degradeReason`）
//      仍然缺席，不写 `false` / `null` 占位。
//
// 纯函数纪律：不读时钟、不碰 IO、不调模型；只 import `node:` 内置与相对路径（当前一条都不需要）。

/**
 * 九列折叠记录（ADR-022 第二刀的列表，JS 侧驼峰名）。
 *
 * @typedef {object} FoldRecord
 * @property {string} [runId] `run_id`：入参给才有（`foldedFacts` 自己不带 run 身份）
 * @property {number} [seq] `seq`：取 `foldedFacts.seq`（run 内单调，由写入方分配）
 * @property {string} foldId `fold_id`：**幂等键**（UNIQUE(run_id, fold_id)），拿不到即 `TypeError`
 * @property {number} [cutRound] `cut_round`：切点，只能由调用方给（在轮记录上，不在 `foldedFacts` 里）
 * @property {number} [cutMsgSeq] `cut_msg_seq`：同上
 * @property {string} [title] `title`：**模型写的**短标题；`NULL` = 模型没给（不许用正文首行顶替）
 * @property {string} description `description`：not null，拿不到即 `TypeError`
 * @property {number} [tokensBefore] `tokens_before`：入参给才有（今天没有这个值）
 * @property {number} [tokensAfter] `tokens_after`：同上
 * @property {string} [createdAt] `created_at`：信封时刻，入参给才有
 */

/**
 * `toFoldRecord` 的调用方补充：`foldedFacts` 里**结构性不存在**的那几格。
 *
 * @typedef {object} FoldRecordExtras
 * @property {string} [runId]
 * @property {number} [seq] 仅当 `foldedFacts.seq` 缺席时兜底（写入方分配的号）
 * @property {number} [cutRound] 本折切点所在轮（今天的写点在轮记录上：`foldedRoundRange.to`）
 * @property {number} [cutMsgSeq] 该轮的 `msg_seq`
 * @property {number} [tokensBefore]
 * @property {number} [tokensAfter]
 * @property {string} [createdAt]
 */

/**
 * `fromFoldRecords` 的调用方补充：**上一折的切点** + 来源/策略（九列里没有）。它是「本折覆盖区间」的左端，
 * 存在**上一行**里而不是本行（ADR：形状稿「覆盖区间是 `(上一折的切点, 本折的切点]`，由 `seq` 顺序推」，
 * `seq` 连续 ⇒ 上一折恒为 `seq - 1`，但**取哪一行的切点**是调用方（store/读侧）的事）。
 *
 * @typedef {object} FoldFactsExtras
 * @property {number} [previousCutRound]
 * @property {string} [source] 契约键 `source`：**必须由调用方给**（九列里没有来源）。今天引擎里
 *   真值只有 `"llm"`（摘要器，`src/compact/fold-llm.js:459`）与 `"statistical"`（显式统计折）
 * @property {string} [strategy] 契约键 `strategy`：同上，由调用方给
 */

/** 与 `fold-summary-journal.js#foldedFactsEncoder` 同一把尺子（`TextEncoder`，UTF-8 字节数）。 */
const factsEncoder = new TextEncoder();

/** 可用作文本列的值：字符串且**去空白后非空**（返回原值，不 trim——列里存的是逐字副本）。 */
function textColumn(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 可用的整数列值：安全整数且 ≥ `min`（切点/token 数都不是负数）。 */
function intColumn(value, min = 0) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= min
    ? /** @type {number} */ (value)
    : undefined;
}

/**
 * `foldedFacts`（今天 `buildFoldedFacts()` 的返回形状）→ 九列折叠记录。
 *
 * 逐格口径（判据见 `test/store/fold-record-261128.test.js`）：
 * - `foldId`：`foldedFacts.foldId ?? foldedFacts.fingerprint`（ADR：`fingerprint` **并入** `fold_id`，
 *   同一身份不是两个）。两者都没有 ⇒ `TypeError`——它是幂等键，重投去重全靠它。
 * - `description`：`summary ?? text`（`summary` 是摘要器写的三节正文，正是这一列；`text` 是今天
 *   累计正文，也是它的来源）。都没有 ⇒ `TypeError`（not null 列）。
 * - `title`：**只有** `origin === "semantic"` 且 `titleFallback !== true` 才带。`titleFallback === true`
 *   意味着这个 title 是 `buildFoldedFacts` 从**正文首行**派生的兜底（`src/compact/fold-summary-journal.js:691`），
 *   存下它会被当成模型标题 ⇒ 必须缺席（= `NULL`），而不是空串。
 * - `cutRound` / `cutMsgSeq` / `tokensBefore` / `tokensAfter` / `runId` / `createdAt`：`foldedFacts` 里
 *   **结构性没有**，只认入参；拿不到就缺席。
 * - 其余 15 个键（`bytes` / `truncated` / `bytesBefore` / `degradeReason` / `origin` / `source` /
 *   `strategy` / `toolCalls` / `increment` / `from` / `to` / `rounds` / `titleFallback` /
 *   `summaryDropped` / `descriptionTruncated`）**一个都不带**进结果（退役表）。
 *
 * @param {Record<string, unknown>} foldedFacts `buildFoldedFacts()` 的返回值
 * @param {FoldRecordExtras} [extras] 只有调用方能提供的那几格
 * @returns {FoldRecord}
 */
export function toFoldRecord(foldedFacts, extras = {}) {
  const facts = foldedFacts ?? /** @type {Record<string, unknown>} */ ({});

  const foldId = textColumn(facts.foldId) ?? textColumn(facts.fingerprint);
  if (foldId === undefined) {
    throw new TypeError(
      "toFoldRecord: 缺 fold_id（foldedFacts.foldId / fingerprint 都没有）——它是幂等键，重投去重全靠它",
    );
  }

  // **只认本折的正文**：`summary`（模型写的三节）或 `increment.text`（本折增量）。
  // 绝不拿 `facts.text` 顶替——那是**累计**正文，用它当 `description` 就等于「每折把整份累计文本
  // 存一遍」，正是形状稿否掉的那个形状（实测 3.9k → 5.9k → 6.9k token，涨的全是重复）。
  // copilot 复审 #991 抓到的第一处。
  const increment = /** @type {{ text?: unknown }} */ (facts.increment ?? {});
  const description = textColumn(facts.summary) ?? textColumn(increment.text);
  if (description === undefined) {
    throw new TypeError(
      "toFoldRecord: 缺 description（本折既没有 summary 也没有 increment.text）——该列 not null；"
        + "累计 text 不许顶替（那会把整份累计正文按折存 N 份）",
    );
  }

  const seq = intColumn(facts.seq, 1) ?? intColumn(extras.seq, 1);
  const cutRound = intColumn(extras.cutRound);
  const cutMsgSeq = intColumn(extras.cutMsgSeq);
  const runId = textColumn(extras.runId) ?? textColumn(facts.runId);
  const tokensBefore = intColumn(extras.tokensBefore);
  const tokensAfter = intColumn(extras.tokensAfter);
  const createdAt = textColumn(extras.createdAt) ?? textColumn(facts.createdAt);

  // 语义折 + 模型真的给了标题 ⇒ 才是 `title` 列。机械折 / 宿主折的 title 一律是首行派生物。
  const modelTitle = facts.origin === "semantic" && facts.titleFallback !== true
    ? textColumn(facts.title)
    : undefined;

  return {
    ...(runId === undefined ? {} : { runId }),
    ...(seq === undefined ? {} : { seq }),
    foldId,
    ...(cutRound === undefined ? {} : { cutRound }),
    ...(cutMsgSeq === undefined ? {} : { cutMsgSeq }),
    ...(modelTitle === undefined ? {} : { title: modelTitle }),
    description,
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

/**
 * 九列折叠记录 → 兼容用的 `foldedFacts`（只导出**契约面**能从九列导出的那些键）。
 *
 * 逐格口径：
 * - `text` = `description` 本身（ADR：累计正文不是列，它是「按 `seq` 拼接 `description`」这个函数；
 *   单折的 `text` 就是这一行那一份）。
 * - `to` = `cutRound`；`from` = **上一折的切点**（`extras.previousCutRound`，调用方给）；
 *   `rounds` = `to - from`。区间左端是开区间（`(上一折切点, 本折切点]`），`from` 的语义与今天一致：
 *   已折到的水位，不是本折第一轮。上一折切点拿不到 ⇒ `from` / `rounds` **缺席**，不猜 `0`。
 * - `bytes` = `text` 的 UTF-8 字节数（序列化尺子，可从列值确定性重算）。
 * - `source` / `strategy` 是契约键但**不是列** ⇒ 给单一作者的字面值（见两个常量）。
 * - `truncated` / `degradeReason` 是可选契约键、九列里没有 ⇒ **缺席**（不写 `false` / `null`）。
 * - `foldId` / `seq` 直接搬。
 *
 * @param {FoldRecord} record
 * @param {FoldFactsExtras} [extras]
 * @returns {Record<string, unknown>}
 */
export function fromFoldRecords(records, extras = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError("fromFoldRecords: records 必须是非空数组（一次折叠的集合，按 seq 升序）");
  }
  const rows = records.map((record) => {
    if (record === null || typeof record !== "object") {
      throw new TypeError("fromFoldRecords: 每条记录必须是九列记录对象");
    }
    const text = textColumn(record.description);
    if (text === undefined) {
      throw new TypeError("fromFoldRecords: record.description 缺失——契约键 text 由它导出，没有就没有");
    }
    return { record, text };
  });
  // 累计正文**是函数**：`seq ≤ n` 的 `description` 按序拼接（ADR 第二刀）。单条记录反解成一份
  // 「累计 text」是错的——那是把局部当日志用（copilot 复审 #991 抓到的第二处）。
  const text = rows.map((row) => row.text).join("\n\n");
  const last = rows[rows.length - 1];
  const to = intColumn(last.record.cutRound);
  // **`from` 是本折覆盖的**第一轮**（闭区间左端），不是上一折的切点**（261128-12 实测更正）：
  // `buildFoldedFacts({ roundRange: { from: 1, to: 5 } })` 里 `from` = 1，而第一折之前什么都没有。
  // 上一折切点是 `previousCutRound`，所以 `from = previousCutRound + 1`；`rounds = to - from + 1`。
  // 按「from = 上一折切点」算会整体错一位（实测：`覆盖第 0–34 轮` vs 真值 `第 1–34`）。
  const previousCut = intColumn(extras.previousCutRound);
  const from = to !== undefined && previousCut !== undefined && previousCut >= 0
    ? previousCut + 1
    : undefined;
  const rounds = to !== undefined && from !== undefined && to >= from ? to - from + 1 : undefined;
  const foldId = textColumn(last.record.foldId);
  const seq = intColumn(last.record.seq, 1);

  // `source` / `strategy` **必须由调用方给**：九列里没有来源，而引擎今天仍支持显式
  // `fold-statistical`（`src/compact/fold-statistical.js`），写死 `"llm"` / `"fold-llm"` 会把统计折
  // 静默标成 LLM 折（copilot 复审 #991 抓到的第三处）。拿不到 ⇒ 缺席，不猜。
  const source = textColumn(extras.source);
  const strategy = textColumn(extras.strategy);

  return {
    text,
    // `title` 是九列的列之一，而旧形状的读侧（`foldSegmentTitle`）就吃 `record.title` ⇒ 必须导出。
    // 它不在宿主契约那个对象里（`:6962` 列的是 `{ text, source, strategy, from, to, rounds, bytes,
    // truncated?, degradeReason?, foldId, seq }`），所以不影响宿主面。
    ...(textColumn(last.record.title) === undefined ? {} : { title: textColumn(last.record.title) }),
    ...(source === undefined ? {} : { source }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(rounds === undefined ? {} : { rounds }),
    bytes: factsEncoder.encode(text).length,
    ...(foldId === undefined ? {} : { foldId }),
    ...(seq === undefined ? {} : { seq }),
  };
}
