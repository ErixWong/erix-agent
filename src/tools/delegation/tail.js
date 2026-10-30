// @ts-check
/**
 * issue #626（C1）—— 父 run 读「子 run 现在在干什么」：**有界的文件尾读**。
 *
 * 病根（对标实测）：名册（`roster.js`，21 项）只回答「子死没死」——`state` / `endedAt` /
 * `termination` 全是终态词汇。无人在环的宿主对长任务只能盲等：子 run 在跑哪个工具、参数是什么、
 * 最后几行正文写了什么，父 run 一个都问不出来。pi 的对照面（`pi-subagents` 的状态面）有
 * `currentTool` / `currentToolArgs` / `recentTools` / `recentOutput`。
 *
 * 本切片的裁决：**不做事件转发，只做有界的文件尾读**。子 run 的 transcript 本来就落盘，读它比
 * 转发事件便宜，而且**不占父上下文**——父只在自己想问的时候读一次最近几行，事件流却会在父的
 * 上下文里常驻。
 *
 * 但「本来就落盘」不等于「父找得到」（#626 C1 真机实测的教训）：名册里的 `transcriptPath` 是
 * **宿主登记**的字段，库不知道宿主把子 run 写在哪。宿主没接 `createDelegateTool` 的
 * `transcriptPathFor` 时，记录里就**没有**这个字段，`tail` 必须报 `no_transcript_path`（配置缺陷），
 * 而不是与「子还没落第一行」的 `no_transcript`（正常时序）混成一个理由。
 *
 * 三条硬约束（都在代码里兑现，不是文案）：
 *   1. **只读、不修复**：走 `src/store/file.js` 的 `readTranscriptTailLines`（只读句柄 + 反向分块），
 *      绝不走 `createFileTranscriptStore().load()`——后者会 `repairTranscriptTail`，对一个**别的进程
 *      正在追加写**的文件动刀（截断半行、隔离残段）。父读一次子就被截一刀，那不是读。
 *   2. **不另起投影**：原始行交给 `src/store/message-rows.js` 的 `foldLedgerMessages`（与恢复路径
 *      同一个口径：`partOf` 分片接回同一条消息、`kind: "message"` 行与老账本轮行都认）。本模块只做
 *      「一条逻辑消息 → 若干行」这一步投影，不解析 JSONL、不重写折叠规则。
 *   3. **限额是硬的**：行数缺省 8、上限 20；每行正文缺省 300 字符、硬上限 1000。调用方给的超限值
 *      一律**夹住**（不报错、不静默忽略——夹住后的值就是实际生效的值）。
 *
 * 返回行形状（工单钉死，不自创）：`{ seq, round?, kind, role?, tool?, argsDigest?, text }`
 *   · `tool` / `argsDigest` 是本切片存在的理由——「子在跑哪个工具、参数摘要」必须从 `tool_use`
 *     块里取出来，而不是把整段 JSON 当正文倒给父；
 *   · `seq` 是**本次返回里的行号**（1 起、单调），不是档案里的轮内序号；
 *   · `text` 恒为字符串（截断到 `textLimit`，超长时末位是 `…`，长度不会超过上限）。
 *
 * 「不给的字段不写」沿用 #617 的纪律：`round` / `role` / `tool` / `argsDigest` 拿不到就不落键；
 * `partial` 只在真为真时才出现（它不是 `false` 的占位）。
 */

import { foldLedgerMessages } from "../../store/message-rows.js";
import { readTranscriptTailLines } from "../../store/file.js";

/** 行数缺省（与工具 description 里写死的数字同源）。 */
export const TAIL_LIMIT_DEFAULT = 8;
/** 行数硬上限。 */
export const TAIL_LIMIT_MAX = 20;
/** 每行正文缺省长度。 */
export const TAIL_TEXT_LIMIT_DEFAULT = 300;
/** 每行正文硬上限。 */
export const TAIL_TEXT_LIMIT_MAX = 1000;

/** 把任意值收成一个正整数限额：给了合法正整数就用它（再夹上限），否则用缺省值。 */
function clampLimit(value, fallback, max) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, max);
}

/**
 * 截断到 `limit` 个字符。超长时末位换成 `…`，所以**长度恒 ≤ limit**（不给宿主一个「以为没截断」的
 * 长度：上限 1000 就是 1000，不会是 1001）。
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
function bound(value, limit) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}

/** 工具入参的**一行摘要**（`argsDigest` 的来源）：紧凑 JSON，再按 textLimit 夹住。 */
function digestArgs(input, limit) {
  if (input === undefined) return "";
  /** @type {string} */
  let raw;
  try {
    raw = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  } catch {
    raw = String(input);
  }
  return bound(raw, limit);
}

/** 把一个 content block 的「正文」摊平成字符串（tool_result 的 content 可能是字符串或块数组）。 */
function blockText(value, limit) {
  if (typeof value === "string") return bound(value, limit);
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (typeof item === "string") parts.push(item);
      else if (item !== null && typeof item === "object" && typeof (/** @type {any} */ (item).text) === "string") {
        parts.push(/** @type {any} */ (item).text);
      }
    }
    return bound(parts.join("\n"), limit);
  }
  if (value !== null && typeof value === "object" && typeof (/** @type {any} */ (value).text) === "string") {
    return bound(/** @type {any} */ (value).text, limit);
  }
  return "";
}

/** 一条消息的 content 摊平成块数组（字符串正文按一个 text 块算）。 */
function contentBlocks(message) {
  const content = /** @type {any} */ (message)?.content;
  if (Array.isArray(content)) return content;
  if (content === undefined || content === null) return [];
  return [content];
}

/**
 * 一条逻辑消息 → 若干行（每个 content block 一行）。
 * `kind` 用块自己的类型词汇（`text` / `tool_use` / `tool_result` / 其它块类型原样），不另造一套。
 *
 * @param {any} message
 * @param {number|undefined} round
 * @param {number} textLimit
 * @returns {Array<{kind: string, role?: string, tool?: string, argsDigest?: string, text: string}>}
 */
function projectMessage(message, round, textLimit) {
  const role = typeof message?.role === "string" && message.role !== "" ? message.role : undefined;
  /** @type {Array<{kind: string, role?: string, tool?: string, argsDigest?: string, text: string}>} */
  const rows = [];
  for (const block of contentBlocks(message)) {
    if (typeof block === "string") {
      rows.push({ kind: "text", ...(role === undefined ? {} : { role }), text: bound(block, textLimit) });
      continue;
    }
    if (block === null || typeof block !== "object") continue;
    const type = typeof block.type === "string" && block.type !== "" ? block.type : "unknown";
    /** 基础行：`kind` 与 `role` 恒在，`round` 由调用方补。 */
    const base = { kind: type, ...(role === undefined ? {} : { role }) };
    if (type === "tool_use") {
      const tool = typeof block.name === "string" && block.name !== "" ? block.name : undefined;
      const argsDigest = digestArgs(block.input, textLimit);
      // tool_use 的「正文」就是参数摘要：父只读一个字段也能看见「在跑什么、带什么参数」。
      rows.push({
        ...base,
        ...(tool === undefined ? {} : { tool }),
        ...(argsDigest === "" ? {} : { argsDigest }),
        text: argsDigest,
      });
      continue;
    }
    if (type === "tool_result") {
      const tool = typeof block.name === "string" && block.name !== "" ? block.name : undefined;
      rows.push({ ...base, ...(tool === undefined ? {} : { tool }), text: blockText(block.content, textLimit) });
      continue;
    }
    rows.push({ ...base, text: blockText(block.text ?? block.content, textLimit) });
  }
  return rows;
}

/**
 * 读子 run 的 transcript 尾部，回答「它现在在干什么」。
 *
 * @param {Object} options
 * @param {string} options.transcriptPath 子 run 的 transcript 路径。**取自名册记录的
 *   `transcriptPath` 字段**（`roster.js` 的 21 项之一，宿主落盘），不是调用方随手给的路径。
 * @param {number} [options.limit] 返回多少行（缺省 8，上限 20；超限夹住）
 * @param {number} [options.textLimit] 每行正文上限（缺省 300，硬上限 1000；超限夹住）
 * @param {() => number} [options.clock] 宿主时钟（缺省 `Date.now`），只用于 `readAt`
 * @returns {Promise<
 *   { ok: true, transcriptPath: string, rows: Array<{seq: number, round?: number, kind: string,
 *     role?: string, tool?: string, argsDigest?: string, text: string}>,
 *     truncated: boolean, partial?: true, readAt: number }
 *   | { ok: false, reason: "no_transcript_path", transcriptPath: * }
 *   | { ok: false, reason: "no_transcript", transcriptPath: *, detail?: string }>}
 *
 * `truncated: true` 表示**还有更早的行没给**（只回最近 `limit` 行）；`partial: true` 表示尾部有一行
 * 解析不了/不完整（写盘进行中的正常现象）——**两种都不抛、都不丢前面的好行**。
 *
 * 三种失败**必须能分开**（真机现场的直接教训：混成一个理由会把「宿主没接」读成「子没干活」）：
 *   · `not_found`（由 `tool.js` 的 `tail` 动作给）：压根没有这条名册记录；
 *   · `no_transcript_path`：名册记录**没有** `transcriptPath` 字段 ⇒ **配置缺陷**——宿主建了记录却
 *     没登记子 run 的 transcript 落在哪（`createDelegateTool` 的 `transcriptPathFor` 没接上）。
 *     这个理由指向宿主，不指向子 run；
 *   · `no_transcript`：字段在、路径有，但文件不存在 / 打不开 ⇒ **正常时序**——子 run 还没落第一行，
 *     或者档案已经被清理。这时父该看 `state`，而不是怀疑装配。
 *
 * `no_transcript` 那条在「打不开」而非「不存在」时多带一个 `detail`（错误码/文本），因为那种失败
 * 与「子还没写」不同类，值得让宿主看见原因。
 */
export async function tailChildTranscript({ transcriptPath, limit, textLimit, clock } = /** @type {any} */ ({})) {
  const rowLimit = clampLimit(limit, TAIL_LIMIT_DEFAULT, TAIL_LIMIT_MAX);
  const textMax = clampLimit(textLimit, TAIL_TEXT_LIMIT_DEFAULT, TAIL_TEXT_LIMIT_MAX);
  const now = typeof clock === "function" ? clock : () => Date.now();

  // 名册记录里没有 transcriptPath（宿主没登记落盘位置）⇒ 配置缺陷，不是「子没干活」。
  if (typeof transcriptPath !== "string" || transcriptPath === "") {
    return { ok: false, reason: "no_transcript_path", transcriptPath };
  }

  // 多要一行：尾行可能是写盘进行中的半截（会被丢掉），不能因此少给一行好行。
  /** @type {{rows: any[], partial: boolean, hasMore: boolean, missing: boolean}} */
  let read;
  try {
    read = await readTranscriptTailLines(transcriptPath, { lines: rowLimit + 1 });
  } catch (error) {
    // 有路径但打不开（权限 / 目录被当成文件 / 句柄耗尽）：子没留下可读的档案，仍是 no_transcript。
    return {
      ok: false,
      reason: "no_transcript",
      transcriptPath,
      detail: String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error),
    };
  }
  if (read.missing) return { ok: false, reason: "no_transcript", transcriptPath };

  // 投影口径复用恢复路径那一份（`foldLedgerMessages`）：`partOf` 分片接回、消息行与老账本轮行都认。
  const entries = foldLedgerMessages(read.rows);
  /** @type {Array<{round?: number, kind: string, role?: string, tool?: string, argsDigest?: string, text: string}>} */
  const projected = [];
  for (const entry of entries) {
    const round = Number.isSafeInteger(entry.round) ? entry.round : undefined;
    for (const row of projectMessage(entry.message, round, textMax)) {
      projected.push(round === undefined ? row : { round, ...row });
    }
  }

  const truncated = projected.length > rowLimit || read.hasMore;
  const kept = projected.length > rowLimit ? projected.slice(projected.length - rowLimit) : projected;

  return {
    ok: true,
    transcriptPath,
    rows: kept.map((row, index) => ({
      seq: index + 1,
      ...(row.round === undefined ? {} : { round: row.round }),
      kind: row.kind,
      ...(row.role === undefined ? {} : { role: row.role }),
      ...(row.tool === undefined ? {} : { tool: row.tool }),
      ...(row.argsDigest === undefined ? {} : { argsDigest: row.argsDigest }),
      text: row.text,
    })),
    truncated,
    ...(read.partial ? { partial: true } : {}),
    readAt: now(),
  };
}
