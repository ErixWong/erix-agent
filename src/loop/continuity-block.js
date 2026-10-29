// @ts-check
// issue #568 —— **会话续接块**（session continuity block）：一块受预算约束、落在请求尾部、
// 内容由宿主提供的注入面。
//
// 病根（`erix-station#392` 及其订正）：模型不是「忘了意图」，而是**无法证明/定位自己声称交付过什么**。
// 今天模型可见的「会话续接」只有两个又窄又错的槽：
//   · semantic 槽位（`src/run-state.js#normalizeSemantic`）只在折叠/低预算点刷新（无折叠 ⇒ 0 次调用），
//     resume 时恢复的是上一份快照，`status=stale` 仍照渲染 ⇒ 静默陈旧；
//   · run-state 整块（`MAX_RENDERED_CHARS` = 1600）装的是计数器（`fold=7/0`、`ttl=…`），不是内容。
// 本模块的**上半部分**（issue #568）只做**三件引擎该做的事**：注入、记账、降采样纪律。
// 内容生产者有两条路，且只有两条：宿主的 `capabilities.hooks.continuityProvider`
// （`src/loop/capabilities-namespace.js`，**override**）与**引擎默认写者**（issue #598，文件末尾那一段：
// 模型在同一个响应里顺手写 `<handoff>` → 引擎解析 / 落盘 / 下次 run 召回，默认关）。
// ⚠ 两条路都**不产生语义**：一条把宿主给的段文本原样渲染，另一条把模型写的段文本原样搬运；
// 缺东西就写 `unknown`，不用机械文本冒充。
//
// 四条纪律（改它之前先读）：
//
//   1. **落点是请求尾部，不是 `mainSystem`。** `markStablePrefix`（`src/loop/provider-runner.js`）
//      把 system 放在历史**之前**，改 system ⇒ 其后 100k–200k 历史的前缀复用全部作废。续接块是
//      「每请求付一次的小块」，代价写在明处（issue #568 的风险节），而不是拿整段历史去换。
//   2. **不膨胀历史。** 块是**一条**带 marker 的消息：刷新时按 marker 找到它、**就地换正文**，
//      再把它挪到尾部（`upsertContinuityInMessages`）。每轮**不新增**一条消息——这是与
//      `upsertRunStateInMessages`（`src/run-state.js`，同样是 marker + 就地替换）同一条纪律。
//      挪到尾部是必须的：留在原地就等于「块停在第 1 条消息后面」，每次改它都会让**整段历史**
//      的前缀失效；停在尾部时只失效「上一次请求之后新长出来的那几条」。
//   3. **骨架三段不降采样。** `contract`（当前契约：目标 / 不可违反约束）、`unfinished`（未完成项）、
//      `evidence`（证据状态：已验证 / 仅声称 / 缺失）三段的小标题**永不因超预算被删**；超预算时
//      从各段**条目**里降采样（每段至少留 1 条），并**显式**写出不完整标记（丢了 N 条 / 超预算）。
//      「静默截断」是被本模块的判据排除的：只要降过采样，`[continuity incomplete: …]` 就在块里。
//   4. **缺失即 unknown。** provider 没给 / 给了空 / 调用抛错 ⇒ 三段各写一行 `unknown`，**不**拿
//      机械文本冒充语义成功（与 #565 的 `origin` 同口径）。⚠ 与「关掉 provider」是两件事：没配
//      provider（`undefined`）时引擎**整块都不注入**，行为逐字回到 #568 之前。
//
// 内容形态：`continuityProvider({runId, state, previous}) → {text, version}`（可 async），
// `text` 用三个段标题分段：
//
//     [contract]
//     goal: …
//     must: …
//     [unfinished]
//     u1: …
//     [evidence]
//     verified: …
//     claimed: …
//     missing: …
//
// 段标题之外的行落 `notes` 段（**非骨架**、最先被降采样）：它们是宿主的自由文本，引擎不猜它属于
// 哪一段（猜错就是把「未验证」写成「已验证」）。也可以直接给结构化形态
// `{sections: {contract, unfinished, evidence, notes}, version}`——两种形态同时给时结构化逐键胜。
//
// 零运行时依赖：只用 `node:` 内置（写者那一段要用 crypto / fs / os / path）+ 相对路径。

// issue #598 的写者那一段（本文件末尾）用到的 `node:` 内置：文件介质、project-key 派生、默认目录。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { estimateTokens } from "../tokens.js";
import { pendingTailToolUses } from "./pending-tool-result.js";

/** 块起始 marker（`upsertContinuityInMessages` 的定位依据）。 */
export const CONTINUITY_BLOCK_START = "[session continuity v1]";

/** 块闭合 marker。与 run-state 同理：它必须存活，否则「就地替换」的定位会失效。 */
export const CONTINUITY_BLOCK_END = "[/session continuity]";

/**
 * 骨架三段的段名（顺序即渲染顺序，也即报错/断言里的枚举顺序）。
 *
 * 三段**永不因超预算被删**（issue #568 判据 5）：① 当前契约（目标 / 不可违反约束）
 * ② 未完成项 ③ 证据状态（已验证 / 仅声称 / 缺失）。
 *
 * @type {readonly string[]}
 */
export const CONTINUITY_SECTION_NAMES = Object.freeze(["contract", "unfinished", "evidence"]);

/**
 * 非骨架段：段标题之外的自由文本。它是**最先**被降采样的那一段（可以被丢光），
 * 因为「丢了宿主自由文本」是显式记账的，而「把未验证写成已验证」不是。
 */
export const CONTINUITY_NOTES_SECTION = "notes";

/**
 * 独立 token 预算的默认值（`config.folding.context.continuityMaxTokens` 不传时的值）。
 *
 * ⚠ **试验值**（issue #568 原文：起步 1–2k）：1200 与 semantic 槽位的 1200 **字符**上限不是
 * 一个量纲——这里量的是 `estimateTokens`（保守混合语言估算），不是字符数。它的用途是「有界」，
 * 不是「精确」；调它是产品决策，不是修 bug。
 */
export const CONTINUITY_DEFAULT_MAX_TOKENS = 1200;

/**
 * 单条条目的字符上限。
 *
 * 为什么需要它：预算是「整块」的，一条病态长行能让「降到只剩骨架」也仍然超预算 ⇒ 预算就失去意义。
 * 夹断是**可见**的（行尾 `…[cut]`），不静默。
 */
export const CONTINUITY_MAX_ENTRY_CHARS = 400;

const SECTION_HEADER_PATTERN = /^\[(contract|unfinished|evidence|notes)\]$/iu;

/** 一条文本块的内容（`string` 与 `[{type:"text"}]` 两种形状都收）。 */
function textBlocksOf(message) {
  if (typeof message?.content === "string") return [message.content];
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => String(block?.text ?? ""));
}

/** 行拆分：CRLF 归一、行尾空白去掉、空行丢掉（条目按行定位，空行只是排版）。 */
function splitEntryLines(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitEntryLines(item));
  if (typeof value !== "string") return [];
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

/** 条目行的字符夹断（可见标记，不静默）。 */
function boundEntryLine(line) {
  const characters = Array.from(String(line));
  if (characters.length <= CONTINUITY_MAX_ENTRY_CHARS) return String(line);
  return `${characters.slice(0, CONTINUITY_MAX_ENTRY_CHARS).join("")}…[cut]`;
}

/**
 * 空的分段集合（四个段都在，值都是空数组）。
 *
 * @returns {Record<string, string[]>}
 */
function emptySections() {
  return {
    contract: [],
    unfinished: [],
    evidence: [],
    [CONTINUITY_NOTES_SECTION]: [],
  };
}

/**
 * 把宿主的 `text` 按段标题切成四段。
 *
 * 段标题之前的行（以及没有段标题时的全部行）落 `notes` 段：引擎**不猜**自由文本属于哪一段。
 *
 * @param {unknown} text
 * @returns {Record<string, string[]>}
 */
export function parseContinuityText(text) {
  const sections = emptySections();
  let current = CONTINUITY_NOTES_SECTION;
  for (const line of splitEntryLines(text)) {
    const header = SECTION_HEADER_PATTERN.exec(line.trim());
    if (header !== null) {
      current = header[1].toLowerCase();
      continue;
    }
    sections[current].push(line);
  }
  return sections;
}

/**
 * 归一化 provider 的返回值（纯函数，不抛）。
 *
 * 三种状态分开说，因为修法不同：
 *   · `absent` —— 没给（`undefined` / `null` / 空对象 / 空字符串）：三段各写 `unknown`；
 *   · `empty`  —— 给了，但归一化之后一条条目都没有：三段各写 `unknown`（与 `absent` 同渲染，
 *     但状态不同——宿主能分清「我的 provider 没被调用」与「我的 provider 返回了空」）；
 *   · `error`  —— 调用抛错：三段各写 `unknown`，`status=error`（调用方负责把原因记进诊断）。
 * 其余一律 `ok`。
 *
 * @param {unknown} provided
 * @param {{status?: string}} [options] `status: "error"` 由调用方在 provider 抛错时传入
 * @returns {{status: string, version: number|undefined, sections: Record<string, string[]>}}
 */
export function normalizeContinuityProvided(provided, { status } = {}) {
  if (status === "error") {
    return { status: "error", version: undefined, sections: emptySections() };
  }
  if (provided === undefined || provided === null) {
    return { status: "absent", version: undefined, sections: emptySections() };
  }
  const record = typeof provided === "object" && !Array.isArray(provided)
    ? /** @type {Record<string, any>} */ (provided)
    : { text: provided };
  const sections = parseContinuityText(record.text);
  const structured = record.sections;
  if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
    for (const name of [...CONTINUITY_SECTION_NAMES, CONTINUITY_NOTES_SECTION]) {
      const value = /** @type {Record<string, any>} */ (structured)[name];
      if (value === undefined) continue;
      sections[name] = splitEntryLines(value);
    }
  }
  const version = Number.isSafeInteger(record.version) ? record.version : undefined;
  const hasContent = Object.values(sections).some((entries) => entries.length > 0);
  return { status: hasContent ? "ok" : "empty", version, sections };
}

/** 一段的渲染行：段标题 + 条目（空段写一行 `unknown`）。 */
function renderSection(name, entries) {
  const lines = [`## ${name}`];
  if (entries.length === 0) {
    lines.push("- unknown");
    return lines;
  }
  for (const entry of entries) {
    const trimmed = String(entry).trimStart();
    lines.push(/^[-*•]/u.test(trimmed) ? `- ${trimmed.replace(/^[-*•]\s*/u, "")}` : `- ${trimmed}`);
  }
  return lines;
}

/** 整块渲染（`entries` 已经是「要渲染的那一份」）。 */
function renderContinuityLines({ entries, version, status, droppedEntries, totalEntries, overBudget }) {
  const head = [
    CONTINUITY_BLOCK_START,
    `version=${version === undefined ? "-" : version} status=${status}`,
  ];
  const body = [
    ...renderSection("contract", entries.contract),
    ...renderSection("unfinished", entries.unfinished),
    ...renderSection("evidence", entries.evidence),
    ...(entries[CONTINUITY_NOTES_SECTION].length > 0
      ? renderSection(CONTINUITY_NOTES_SECTION, entries[CONTINUITY_NOTES_SECTION])
      : []),
  ];
  // 不完整标记：**只有降过采样 / 仍然超预算时才出现**（没降过就一个字节都不多写）。
  const tail = droppedEntries > 0 || overBudget
    ? [
      `[continuity incomplete: ${droppedEntries > 0
        ? `dropped ${droppedEntries} of ${totalEntries} entries`
        : "budget too small for the entries"}${overBudget ? "; still over budget" : ""};`
      + ` kept sections: ${CONTINUITY_SECTION_NAMES.join(" / ")}]`,
    ]
    : [];
  return [...head, ...body, ...tail, CONTINUITY_BLOCK_END];
}

/**
 * 渲染续接块（**纯函数**：同样的入参给同样的字节，不读时钟、不读配置）。
 *
 * 降采样纪律（issue #568 判据 5，别改坏）：
 *   · 三段的小标题**永不删**；
 *   · 超预算时从**条目最多**的那一段丢条目（`notes` 优先被丢光），每段**至少留 1 条**；
 *   · 只要丢过一条，块里就有 `[continuity incomplete: …]`——**不许静默截断**；
 *   · 连「每段留 1 条」都还超预算 ⇒ 保留全部剩余条目并标 `still over budget`（宁可超预算，
 *     也不删骨架：预算的作用是「有界」，不是「把未完成项吃掉」）。
 *
 * @param {{
 *   sections?: Record<string, string[]>,
 *   version?: number,
 *   status?: string,
 *   maxTokens?: number,
 * }} [options]
 * @returns {{
 *   text: string,
 *   tokens: number,
 *   maxTokens: number,
 *   incomplete: boolean,
 *   droppedEntries: number,
 *   totalEntries: number,
 *   keptSections: readonly string[],
 *   overBudget: boolean,
 * }}
 */
export function renderContinuityBlock({
  sections,
  version,
  status = "ok",
  maxTokens,
} = {}) {
  const budget = Number.isSafeInteger(maxTokens) && maxTokens > 0
    ? maxTokens
    : CONTINUITY_DEFAULT_MAX_TOKENS;
  /** @type {Record<string, string[]>} */
  const entries = emptySections();
  for (const name of [...CONTINUITY_SECTION_NAMES, CONTINUITY_NOTES_SECTION]) {
    entries[name] = (sections?.[name] ?? []).map((line) => boundEntryLine(line));
  }
  const totalEntries = Object.values(entries).reduce((total, list) => total + list.length, 0);
  const floorFor = (name) => (name === CONTINUITY_NOTES_SECTION
    ? 0
    : Math.min(1, entries[name].length));
  const order = [CONTINUITY_NOTES_SECTION, "evidence", "unfinished", "contract"];
  let droppedEntries = 0;
  let lines = renderContinuityLines({
    entries, version, status, droppedEntries, totalEntries, overBudget: false,
  });
  let overBudget = false;
  while (estimateTokens(lines.join("\n")) > budget) {
    // 受害者 = 条目最多、且还能丢的那一段（平局按 `order` 靠前者先丢）。
    let victim;
    for (const name of order) {
      const droppable = entries[name].length - floorFor(name);
      if (droppable <= 0) continue;
      if (victim === undefined || entries[name].length > entries[victim].length) victim = name;
    }
    if (victim === undefined) {
      overBudget = true;
      break;
    }
    entries[victim] = entries[victim].slice(0, -1);
    droppedEntries += 1;
    lines = renderContinuityLines({
      entries, version, status, droppedEntries, totalEntries, overBudget: false,
    });
  }
  const text = renderContinuityLines({
    entries, version, status, droppedEntries, totalEntries, overBudget,
  }).join("\n");
  return {
    text,
    tokens: estimateTokens(text),
    maxTokens: budget,
    incomplete: droppedEntries > 0 || overBudget,
    droppedEntries,
    totalEntries,
    keptSections: CONTINUITY_SECTION_NAMES,
    overBudget,
  };
}

/**
 * 这条消息是不是**本模块注入的续接块**（而不是碰巧含这些字的别的消息）。
 *
 * 判据刻意收紧到「正文**以**起始 marker 开头」：折叠摘要/控制文本里也可能引用了块里的字，
 * 把那种消息当成块挪到尾部会把摘要整条搬走（比不注入更糟）。
 *
 * @param {any} message
 * @returns {boolean}
 */
export function isContinuityMessage(message) {
  if (message?.role !== "user") return false;
  return textBlocksOf(message).some((text) => text.trimStart().startsWith(CONTINUITY_BLOCK_START));
}

/** 消息列表里续接块的条数（判据用：每轮都必须恰好 1 条，且不随轮数增长）。 */
export function continuityMessageCount(messages) {
  return (Array.isArray(messages) ? messages : []).filter(isContinuityMessage).length;
}

/**
 * 尾部悬空 `tool_use` 的闸门（issue #568 硬约束，判据 6）。
 *
 * 尾部正挂着未结清的 `tool_use` 时**不许**把块插到它与 `tool_result` 之间：那会让
 * `mergeToolResultsIntoMessages`（`src/loop/messages.js`）认不出配对、把结果写成第二条
 * `tool_result` 消息，`validateMessages` 随即以「多余的结果」拒掉整份历史——本库自己的校验器
 * 在请求发出**之前**就抛（#548 的现场）。
 *
 * 与 `appendRunStateToRequestView`（`src/run-state.js`）同一个判据、同一条纪律：**本轮不注入**，
 * 并把原因交给调用方记进诊断（不是静默跳过）。
 *
 * @param {any[]} messages
 * @returns {{ok: boolean, reason?: string}}
 */
function tailGate(messages) {
  if (pendingTailToolUses(messages).length === 0) return { ok: true };
  return { ok: false, reason: "pending_tool_use" };
}

/**
 * 刷新（或首次插入）续接块：marker + **就地替换** + 挪到尾部。**每轮不新增一条消息**。
 *
 * 三种结果（`reason` 是给诊断/账本用的可断言字面量）：
 *   · `in_place` —— 已有块且本来就在尾部，只换正文；
 *   · `moved_to_tail` —— 已有块但被新消息压在后面：换正文并挪到尾部（消息条数不变）；
 *   · `inserted` —— 首次注入（run 启动那一次）；
 *   · `pending_tool_use` / `empty` —— **没注入**，`messages` 逐字返回（调用方必须记账）。
 *
 * ⚠ 就地替换用的是**同一条消息对象**（改 `content`、不换对象）：`messageRounds`（轮号映射）
 * 以消息对象为键，换对象等于把轮号丢掉。
 *
 * @param {any[]} messages
 * @param {string} rendered
 * @returns {{messages: any[], injected: boolean, reason: string}}
 */
export function upsertContinuityInMessages(messages, rendered) {
  if (!Array.isArray(messages) || typeof rendered !== "string" || rendered.trim() === "") {
    return { messages, injected: false, reason: "empty" };
  }
  // **所有**块消息都收掉、只留最后一条（identity 保留最后那条：`messageRounds` 以对象为键）。
  // 为什么不是只处理 `findLastIndex` 那一条：`ensureUserTurnView`（`src/loop/request-user-view.js`）
  // 在「压缩后的视图一条 user 轮都不剩」那格会从压缩前的源里**复制**最新一条 user 轮贴回来。
  // #589 已经修了那个复制格的**根因**（`latestUserRound` 不再把块当 user 轮复制），这里仍然是
  // 「至多一条」的**结构性最后一道**：不变量由本函数实现，而不是靠调用方记得每轮只刷一次。
  // 两道并存的理由：根因那一侧只修了一个调用点（复制格），而消息流可能从 resume / 宿主注入 /
  // 旧 transcript 里带来第二条块——那一路没有复制格，只有这里能收。
  const indices = [];
  for (const [index, message] of messages.entries()) {
    if (isContinuityMessage(message)) indices.push(index);
  }
  const existingIndex = indices.at(-1) ?? -1;
  const dropped = new Set(indices.slice(0, -1));
  const rest = dropped.size === 0
    ? messages
    : messages.filter((_, index) => !dropped.has(index));
  const gate = tailGate(existingIndex < 0 ? rest : rest.filter((_, index) => index !== existingIndex));
  if (!gate.ok) return { messages, injected: false, reason: gate.reason };
  if (existingIndex < 0) {
    return {
      messages: [...messages, { role: "user", content: [{ type: "text", text: rendered }] }],
      injected: true,
      reason: "inserted",
    };
  }
  const message = rest.find(isContinuityMessage);
  message.content = [{ type: "text", text: rendered }];
  const without = rest.filter((candidate) => candidate !== message);
  return {
    messages: [...without, message],
    injected: true,
    reason: existingIndex === messages.length - 1 && dropped.size === 0
      ? "in_place"
      : "moved_to_tail",
  };
}

/**
 * 只**定位**（不刷新内容）：把已有的块挪回尾部。内容没变时也调用它——块必须停在请求尾部，
 * 否则它留在历史中间，改一次就让整段历史的前缀复用作废（见文件头纪律 2）。
 *
 * @param {any[]} messages
 * @returns {{messages: any[], moved: boolean, reason: string}}
 */
export function positionContinuityBlock(messages) {
  if (!Array.isArray(messages)) return { messages, moved: false, reason: "absent" };
  const indices = [];
  for (const [index, message] of messages.entries()) {
    if (isContinuityMessage(message)) indices.push(index);
  }
  if (indices.length === 0) return { messages, moved: false, reason: "absent" };
  const last = messages[indices.at(-1)];
  const duplicates = indices.length - 1;
  if (duplicates === 0 && indices[0] === messages.length - 1) {
    return { messages, moved: false, reason: "already_tail" };
  }
  const rest = messages.filter((message) => message !== last);
  const gate = tailGate(rest);
  if (!gate.ok) return { messages, moved: false, reason: gate.reason };
  return {
    messages: [...rest, last],
    moved: true,
    reason: "moved_to_tail",
  };
}

// ============================================================================================
// issue #598 —— 续接块的**默认写者**（引擎侧）：模型在**同一次响应**里顺手写 `<handoff>`，
// 引擎负责「注入指令 → 解析 → 落盘 → 下次 run 启动召回」。
//
// 为什么这一半在引擎里（#598 正文的病根）：`#568` 只给了插座（`capabilities.hooks.continuityProvider`），
// 没有默认实现 ⇒ 钩子空着等于什么都不注入，于是「续接块里写什么」被推给了宿主。可压缩、折叠、
// TTL、预算、渲染、注入引擎早就在做，持久化抽象 `src/store/` 也自带，「让模型停下来时顺手写一段
// 交接」和 judge nudge / 扩轮续跑提示 / 强制收尾是**同一类动作**。`continuityProvider` 因此保留为
// **override**（宿主确实知道模型不知道的事，如「CI 红了」），默认写者补在下面这一段里。
//
// ⚠ **为什么与渲染面同处一个文件**（#598 落地时的实际约束，不是疏忽）：`npm run check:docs` 的
// modulemap 规则要求 `src/` 下每个 `.js` 都出现在两份 README 的模块地图里，而 #598 的改动面
// 明确不含 README。把写者放进已经登记过的本模块是唯一「不新增文件又不改文档」的落法。
// 将来谁有权动 README，可以把它整段切到 `src/loop/continuity-writer.js`：下面这段**只依赖**
// `node:` 内置与本文件的 `CONTINUITY_SECTION_NAMES`，没有一处反向依赖渲染逻辑。
//
// 四条纪律（改它之前先读）：
//
//   1. **只认 marker，不解析散文。** 交接段只从 `<handoff>` … `</handoff>` 之间取；散文里出现
//      `contract` 三个字**不是**交接段（判据 6 的第一条变异就打在这一点上：把解析键退化成「全文搜
//      contract」⇒ 夹具必须红）。段名 `contract` / `unfinished` / `evidence`，大小写不敏感，容忍
//      全角 `：` 与半角 `:`。
//   2. **原文照抄，绝不代写。** 段内容逐字进 store（引擎不润色、不总结、不改写），缺段 / 缺整块
//      ⇒ 该段 `unknown`。**绝不用机械文本冒充语义**：`unknown` 是「我不知道」，不是「没有未完成项」。
//   3. **引擎只搬运、不背书。** 模型在 `<handoff>` 里写 `evidence: 已验证` 而根本没跑测试时，
//      store 与块里就是「已验证」——它**不是**引擎的 `verification`（那套东西由 finalGuard /
//      deliverables 产生，两套不许混）。
//   4. **默认关 = 零行为变更。** `config.continuity.handoff` 默认 `"off"`：指令不注入、store 不读
//      不写、块一个字节都不变（判据 1 的对拍就是这条红线）。
//
// 依赖：`node:` 内置（crypto / fs / os / path）+ 本文件的段名常量。

/** 交接块的起始 marker（模型写的那个，逐字来自注入的指令）。 */
export const HANDOFF_MARKER_START = "<handoff>";

/** 交接块的闭合 marker。 */
export const HANDOFF_MARKER_END = "</handoff>";

/**
 * 骨架三段（顺序即注入指令里的顺序，也即 store / 块里的顺序）。
 *
 * 段名逐字等于 `#568` 续接块的三段（`src/loop/continuity-block.js#CONTINUITY_SECTION_NAMES`）——
 * 两份必须同名，否则召回时 `parseContinuityText` 认不出这些段标题。
 *
 * @type {readonly string[]}
 */
export const HANDOFF_SECTION_NAMES = Object.freeze(["contract", "unfinished", "evidence"]);

/**
 * 「这一段我不知道」的唯一字面量。
 *
 * 它**必须可见**（判据 3 / 判据 6 的第二条变异）：缺失降级成空串或整段省略都让夹具红。
 */
export const HANDOFF_UNKNOWN = "unknown";

/**
 * 开关的三个取值（`config.continuity.handoff`）。第一个是默认值。
 *
 * 名字里的 `WRITE` 说的是**写者**的三档模式（写不写交接、缺了要不要补一次），不是叶名：
 * 叶名是名词 `handoff`（见 `src/loop/config-namespace.js` 的 schema 注释：动词 `write` 会污染
 * `scripts/retired-spelling-scan.mjs` 的退役拼写判据）。
 *
 * @type {readonly string[]}
 */
export const CONTINUITY_WRITE_MODES = Object.freeze(["off", "prompt", "prompt-and-fallback"]);

/** 默认值（`config.continuity.handoff` 不传时的值，issue #598 §6：默认关）。 */
export const CONTINUITY_WRITE_DEFAULT = "off";

/**
 * 请求尾部注入的指令（**措辞只在这里定义一次**，issue #598 §1）。
 *
 * 两条性质：
 *   · 短（≤80 token 量级）：它是「每请求付一次」的小块，不是第二个 system；
 *   · **只在开关打开时出现**：`off` 时请求里逐字不含它（判据 1 的红线）。
 */
export const HANDOFF_INSTRUCTION = [
  "停下来之前，在正文末尾附一段（缺哪段就写 unknown，不要编）：",
  HANDOFF_MARKER_START,
  "contract: <目标与不可违反的约束>",
  "unfinished: <还欠什么>",
  "evidence: <哪些已验证、哪些只是声称>",
  HANDOFF_MARKER_END,
].join("\n");

/**
 * 兜底那一次调用（`prompt-and-fallback`）要模型只输出交接块时的指令。
 *
 * 与 `HANDOFF_INSTRUCTION` 分开写：前者的语境是「正常收尾」，后者是「你已经收尾了，只补这一段」。
 */
export const HANDOFF_FALLBACK_INSTRUCTION = [
  "只输出下面这一段，不要任何其它文字（缺哪段就写 unknown，不要编）：",
  HANDOFF_MARKER_START,
  "contract: <目标与不可违反的约束>",
  "unfinished: <还欠什么>",
  "evidence: <哪些已验证、哪些只是声称>",
  HANDOFF_MARKER_END,
].join("\n");

/** 交接块本体（取**最后**一个：模型可能先把指令抄了一遍）。`i` + `u`：大小写不敏感。 */
const HANDOFF_BLOCK_PATTERN = /<handoff>([\s\S]*?)<\/handoff>/giu;

/**
 * 兜底那一次调用的**输入上限**（字符）：终稿尾部与上一份交接各自夹断到这个长度。
 *
 * 为什么是字符而不是 token：这里只需要「有界」这一个性质（issue #598 §3 原话「输入有界」），
 * 不参与预算算术（那是 `renderContinuityBlock` 的活）；1200 与 `#568` 的默认块预算同量级，
 * 读起来只有一份数字要记。
 */
export const HANDOFF_FALLBACK_TAIL_CHARS = 1200;

/** 段标题行：`contract: …` / `unfinished：…`（全角冒号也收，大小写不敏感）。 */
const HANDOFF_SECTION_PATTERN = /^(contract|unfinished|evidence)\s*[:：]\s*(.*)$/iu;

/**
 * 归一化开关取值（读侧，**不抛**）。
 *
 * intake 的枚举校验由 `CONFIG_LEAF_VALUE_RULES["continuity.handoff"]`（`src/loop/config-namespace.js`）
 * 负责；这里只回答「读到的东西算不算开着」，于是「没写 / 写了个别的字符串」一律落到默认的 `off`，
 * 而不是把非法值当半个开关（那是「配了等于没配」的静默形状）。
 *
 * @param {unknown} value
 * @returns {"off"|"prompt"|"prompt-and-fallback"}
 */
export function normalizeContinuityWriteMode(value) {
  return value === "prompt" || value === "prompt-and-fallback"
    ? /** @type {"prompt"|"prompt-and-fallback"} */ (value)
    : "off";
}

/** 一段的取值（非空字符串 ⇒ 原文；否则 `unknown`）。 */
function sectionValue(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? HANDOFF_UNKNOWN : text;
}

/**
 * 解析一段模型输出里的交接块（**纯函数**，不读时钟、不读配置）。
 *
 * 三种输入分开说，因为修法不同：
 *   · 没有 marker（散文里出现 `contract` 也算这一类）⇒ `found: false` + 三段 `unknown`；
 *   · 有 marker 但缺段 / 段空 ⇒ 该段 `unknown`（其余段照抄）；
 *   · 段内容里的多行原样保留（引擎不猜哪一行属于哪一段，只认段标题）。
 *
 * @param {unknown} text
 * @returns {{found: boolean, sections: {contract: string, unfinished: string, evidence: string}}}
 */
export function parseHandoff(text) {
  /** @type {{contract: string, unfinished: string, evidence: string}} */
  const sections = {
    contract: HANDOFF_UNKNOWN,
    unfinished: HANDOFF_UNKNOWN,
    evidence: HANDOFF_UNKNOWN,
  };
  const source = typeof text === "string" ? text : "";
  const blocks = [...source.matchAll(HANDOFF_BLOCK_PATTERN)];
  if (blocks.length === 0) return { found: false, sections };
  const body = blocks.at(-1)?.[1] ?? "";
  /** @type {Record<string, string[]>} */
  const buffers = { contract: [], unfinished: [], evidence: [] };
  let current = "";
  for (const rawLine of body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const header = HANDOFF_SECTION_PATTERN.exec(line);
    if (header !== null) {
      current = header[1].toLowerCase();
      const rest = header[2].trim();
      if (rest !== "") buffers[current].push(rest);
      continue;
    }
    // 段标题之前的散文（模型在块里写了句废话）不属于任何一段：引擎**不猜**它属于哪一段。
    if (current === "") continue;
    buffers[current].push(line);
  }
  for (const name of HANDOFF_SECTION_NAMES) {
    sections[/** @type {"contract"|"unfinished"|"evidence"} */ (name)] = sectionValue(buffers[name].join("\n"));
  }
  return { found: true, sections };
}

/**
 * 一份 store 记录 → `#568` 续接块认得的段文本（`[contract]` / `[unfinished]` / `[evidence]`）。
 *
 * 这是「默认写者」与「#568 渲染面」之间**唯一**的接口：本模块只生产这段文本，
 * 渲染 / 预算 / 骨架一律由 `renderContinuityBlock` 负责（本单不改渲染逻辑）。
 *
 * @param {{contract?: string, unfinished?: string, evidence?: string}|undefined} sections
 * @returns {string}
 */
export function handoffSectionsText(sections) {
  return HANDOFF_SECTION_NAMES
    .map((name) => `[${name}]\n${sectionValue(sections?.[name])}`)
    .join("\n");
}

/**
 * store 记录的版本号（形状变更时 +1，读到不认识的版本按「没有记录」处理）。
 *
 * `source` 回答「这一段是谁写的」：`model`（同一次响应里顺手写）/ `fallback`（兜底那一次补调用）/
 * `unknown`（模型没写，两段路都没拿到）。⚠ 它**不是** `#565` 的 `origin`（`mechanical|semantic|host`
 * 是折叠事实的来源口径），两套不许混。
 */
export const CONTINUITY_RECORD_VERSION = 1;

/**
 * `project-key`：**与 session id 同一套 cwd 派生规则**（issue #598 §4：不另造一套）。
 *
 * 规则本身是行为契约，唯一实现住在 `bin/session-scan.js#sessionScanPrefix`（`bin/repl.js` 反过来
 * import 它，`src/tools/notes.js#currentScopeRef` 是同式的第二份——库层不能反向 import `bin/`）。
 * 本模块是库层的第三份，**逐字同式**：`<basename || "root">-<sha256(path.resolve(cwd)) 前 8 位>`，
 * 由 `test/loop-continuity-writer-598.test.js` 的哈希契约用例与 `sessionScanPrefix` 对拍钉住
 * （与 `test/session-scan.test.js` 钉 notes 那份是同一条纪律）。
 *
 * @param {unknown} cwd
 * @returns {string}
 */
export function continuityProjectKey(cwd) {
  const normalizedCwd = path.resolve(String(cwd));
  const baseName = path.basename(normalizedCwd) || "root";
  const hash8 = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 8);
  return `${baseName}-${hash8}`;
}

/**
 * store 目录：显式 `dir` 赢，其次 `ERIX_CONTINUITY_DIR`（与 `src/tools/notes.js` 的
 * `ERIX_NOTES_DIR` 同一条纪律：库层的默认目录必须能被调用方/测试注入，否则测试会写真实 `~/.erix`），
 * 最后才是 `~/.erix/continuity`。
 *
 * @param {{home?: string, dir?: string}} [options]
 * @returns {string}
 */
export function resolveContinuityDir({ home, dir } = {}) {
  if (typeof dir === "string" && dir.trim() !== "") return dir;
  const fromEnv = process.env.ERIX_CONTINUITY_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return path.join(home ?? homedir(), ".erix", "continuity");
}

/**
 * 校验一份读回来的记录（形状不对就当没有——**不许**把半份记录渲染成「已验证」）。
 *
 * @param {unknown} value
 * @param {string} projectKey
 * @returns {{version: number, projectKey: string, cwd: string|undefined, writtenAt: string|undefined, source: string, sections: {contract: string, unfinished: string, evidence: string}}|undefined}
 */
function normalizeContinuityRecord(value, projectKey) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = /** @type {Record<string, any>} */ (value);
  if (record.version !== CONTINUITY_RECORD_VERSION) return undefined;
  if (record.projectKey !== projectKey) return undefined;
  const sections = record.sections;
  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) return undefined;
  /** @type {{contract: string, unfinished: string, evidence: string}} */
  const normalized = {
    contract: HANDOFF_UNKNOWN,
    unfinished: HANDOFF_UNKNOWN,
    evidence: HANDOFF_UNKNOWN,
  };
  for (const name of HANDOFF_SECTION_NAMES) {
    const section = /** @type {Record<string, any>} */ (sections)[name];
    if (typeof section !== "string") return undefined;
    normalized[/** @type {"contract"|"unfinished"|"evidence"} */ (name)] = sectionValue(section);
  }
  return {
    version: CONTINUITY_RECORD_VERSION,
    projectKey,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    writtenAt: typeof record.writtenAt === "string" ? record.writtenAt : undefined,
    source: typeof record.source === "string" ? record.source : HANDOFF_UNKNOWN,
    sections: normalized,
  };
}

/**
 * 文件介质的续接 store：`<dir>/<project-key>.json`，**只保留最近一份**（append 历史不是本单目标）。
 *
 * 三个注入点（仓库纪律：测试不许碰真实 `~/.erix`）：`home` / `cwd` / `dir`。`clock` 只为测试可断言。
 *
 * 读写口径：
 *   · `read()` —— 文件缺失 / 坏 JSON / 形状不对 / 版本不认识 ⇒ `undefined`（**不抛**：召回失败不许
 *     杀掉一次 run）；其它 I/O 错误照抛，由调用方记账后吞掉。
 *   · `write(record)` —— `mkdir -p`（`0o700`）+ 临时文件 + `rename`（半份文件不许被读到）。
 *
 * @param {{home?: string, cwd?: unknown, dir?: string, clock?: () => Date}} [options]
 * @returns {{
 *   projectKey: string,
 *   dir: string,
 *   path: string,
 *   read: () => Promise<ReturnType<typeof normalizeContinuityRecord>>,
 *   write: (record: {source?: string, sections?: {contract?: string, unfinished?: string, evidence?: string}}) => Promise<ReturnType<typeof normalizeContinuityRecord>>,
 * }}
 */
export function createFileContinuityStore({ home, cwd, dir, clock } = {}) {
  const projectKey = continuityProjectKey(cwd ?? process.cwd());
  const root = resolveContinuityDir({ home, dir });
  const filePath = path.join(root, `${projectKey}.json`);
  return {
    projectKey,
    dir: root,
    path: filePath,
    async read() {
      let raw;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "ENOENT") return undefined;
        throw error;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 坏 JSON = 「没有记录」：召回面不许因为一个半截文件把整次 run 弄红。
        return undefined;
      }
      return normalizeContinuityRecord(parsed, projectKey);
    },
    async write(record) {
      const normalized = {
        version: CONTINUITY_RECORD_VERSION,
        projectKey,
        ...(cwd === undefined ? {} : { cwd: String(cwd) }),
        writtenAt: (clock?.() ?? new Date()).toISOString(),
        source: typeof record?.source === "string" ? record.source : HANDOFF_UNKNOWN,
        sections: {
          contract: sectionValue(record?.sections?.contract),
          unfinished: sectionValue(record?.sections?.unfinished),
          evidence: sectionValue(record?.sections?.evidence),
        },
      };
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
      return normalizeContinuityRecord(normalized, projectKey);
    },
  };
}
