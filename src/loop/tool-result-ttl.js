// 工具结果 TTL 折叠（issue #35）：已消费的大体积 tool_result 在存活 ttl 轮后，
// 从发往 provider 的请求视图里替换为占位符。
// 纯函数：返回浅拷贝视图，不改原数组、不改原块对象；ctx.messages 始终保留全文，
// run snapshot/归档语义不受影响。叠加在既有压缩（fold-statistical 等）之上，
// 互不干扰。
//
// 增强（issue #35 探索项，v4 A/B 实测驱动）：
// 1. 预警轮：age === ttl-1（下一轮即折叠）的大结果，content 末尾追加一行预警，
//    提示模型趁全文在场用 note_take 记录要点（拷贝块后追加，绝不动原块）。
// 2. 结构化导航摘要：折叠占位符内嵌确定性 digest（定义行签名 + 行号）。

import { createHash } from "node:crypto";

import { estimateTokens } from "../tokens.js";

export const TOOL_RESULT_TTL_DEFAULT = 2;
export const TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT = 4000;

// ---------------------------------------------------------------------------
// issue #741 —— 笔记断言的**条件式**出口（prompt 级修复，不是机制级）
//
// 病根：TTL 降级占位符与折叠替代物的广告语都**无条件**断言「要点见已有笔记 / 先用 note_list 查」，
// 而引擎既不写笔记（机制级缺口），也不知道宿主到底有没有装配 `note_*`（配置级缺口）。
// 生产证据（run b3eeba0f）：折叠后整场 `note_*` 调用 = 0，模型改用 cat/grep/sed 取回原文。
// 于是那句话同时犯两错：① 指一条不存在的道路；② 把「我不知道有没有记录」伪报成「有记录」。
//
// 本模块只做**引擎真能核实**的两件事，且只用来决定措辞，不引入任何写笔记的机制：
//   · 工具面：宿主传进来的 `tools` 里有没有完整的 `note_take`/`note_list`/`note_read`；
//   · 账本：可见消息里有没有一次**成功**的 `note_take` 写入（有 tool_use 且配对 tool_result 未报错）。
// 拿不到证据 ⇒ 走显式未知口径（「无可复原的决策记录」+ 原因），**不许**伪报知道。
//
// ⚠ 与 `src/loop/orchestrator.js` 里「引擎不认识 notes」那条注释的边界：那条约束的是**诊断投影**
// 不许解析笔记载荷。这里只做**工具名/调用是否发生**的只读判定（不解析笔记内容、不读宿主存储），
// 目的是让模型可见文本不再撒谎 —— 属于 prompt 级，不是把笔记机制搬进引擎。
// ---------------------------------------------------------------------------

/** 笔记召回这条路需要的工具；**缺任何一个**都不给 `note_*` 指引（整族全有或全无）。 */
export const NOTE_RECALL_TOOL_NAMES = Object.freeze(["note_take", "note_list", "note_read"]);

/** 三种「没有笔记可指」的原因；字符串本身就是模型可见文本，改动 = 改模型看到的句子。 */
export const NOTE_RECALL_REASONS = Object.freeze({
  // 三个原因都要短：它们最终出现在**模型可见文本**里，而折叠摘要有字节夹断（#460 尺蠖）。
  /** 工具面上没有完整的笔记工具族 ⇒ 连路都不存在。 */
  noSurface: "无笔记工具",
  /** 工具有，但可见账本里一次成功写入都没有 ⇒ 路在，格子是空的。 */
  emptyNotes: "无笔记写入",
  /** 调用方没给工具面/账本证据 ⇒ 引擎确实不知道。 */
  unknown: "无笔记证据",
});

/** 从宿主给的 `tools` 里挑出笔记工具名（不做前缀猜测，只认这三个确定名）。 */
export function noteToolNamesOnSurface(tools) {
  const found = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (NOTE_RECALL_TOOL_NAMES.includes(name)) found.add(name);
  }
  return [...found];
}

/** 可见账本里是否有过**成功**的 `note_take` 写入（配对的 tool_result 缺席视为未报错：折叠只截内容不删行）。 */
export function hasNoteWriteEvidence(messages) {
  const errored = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of message?.content ?? []) {
      if (block?.type === "tool_result" && block.is_error === true) errored.add(block.tool_use_id);
    }
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of message?.content ?? []) {
      if (block?.type === "tool_use" && block.name === "note_take" && !errored.has(block.id)) return true;
    }
  }
  return false;
}

/**
 * 笔记可用性判定（纯函数，无副作用）。`available: true` 的唯一条件是「整族工具在面上 **且**
 * 账本里有成功写入」—— 两者都是引擎看得见的事实，不是推断。
 *
 * @param {{ noteTools?: string[], messages?: Array<object> }} [evidence]
 * @returns {{ available: boolean, reason: string, surfaceKnown: boolean }}
 */
export function resolveNoteRecall({ noteTools, messages } = {}) {
  if (!Array.isArray(noteTools)) return { available: false, reason: NOTE_RECALL_REASONS.unknown, surfaceKnown: false };
  if (!NOTE_RECALL_TOOL_NAMES.every((name) => noteTools.includes(name))) {
    return { available: false, reason: NOTE_RECALL_REASONS.noSurface, surfaceKnown: true };
  }
  if (!hasNoteWriteEvidence(messages)) return { available: false, reason: NOTE_RECALL_REASONS.emptyNotes, surfaceKnown: true };
  return { available: true, reason: "", surfaceKnown: true };
}

/** 显式未知口径那半句；`reason` 传的就是文本本体（`NOTE_RECALL_REASONS` 的值），空/缺席回退「无证据」。 */
export function unverifiedRecallClause(reason) {
  const text = typeof reason === "string" && reason.trim() !== ""
    ? reason
    : NOTE_RECALL_REASONS.unknown;
  // 判据钉的字面是「无可复原的决策记录」；不带「本区间」这类限定词，省下的都是折叠摘要的字节预算。
  return `无可复原的决策记录（原因：${text}）`;
}

/** 有笔记证据时的取回指引（沿用 #224/#241 的口径：值没记下来就省略，别猜）。 */
const NOTE_RECALL_HINT = "后续需要时先用 note_list 查找，再用 note_read 读取；未记录且无法确定性重算时请省略，不要猜测";

/**
 * 无证据时的取回指引：能给出一条**可直接执行**的重读命令就给（生产里模型本来就在跑 cat/grep/sed），
 * 否则退回「重读源文件」。两种都保留「不要猜测」半句 —— 修的是「有没有记录」，不是放松反幻觉约束。
 */
function unverifiedRetrievalHint(retrievalCommand, reason) {
  // 命令本身另起一行（`取回: …`），那行整行可直接粘进 exec；句子里只留指向，不塞第二份命令。
  const lead = retrievalCommand === undefined
    ? "需要原文请重读源文件（路径见本条工具调用）"
    : "需要原文请执行下方「取回」行那一条命令";
  // 「不要猜测」半句**保留**：本切片修的是「有没有记录」，不是放松反幻觉约束。
  return `${lead}；${unverifiedRecallClause(reason)}；未记录且无法确定性重算时请省略，不要猜测`;
}

/** 有证据时才出现的那半句尾巴（无证据时说「已有笔记」就是假知识）。 */
const NOTE_RECALL_TAIL = "；要点见对话中已有笔记/结论";

/** 入参没给 limit 时的重读窗口（行数）；比 readFile 的默认 200 窄，宁小不许谎称是全文。 */
const RETRIEVAL_WINDOW_LINES = 120;

/** 单引号包住，内部的 `'` 按 shell 规则转义（路径里有空格/引号也不破功）。 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * 拼取回命令的**白名单**：工具名必须逐字命中这里列出的、入参契约已被核实的 readFile 形态。
 * 依据：`src/tools/file-tools.js` 的 `readFile`（工具名 `readFile`）读 `input.path` / `input.offset`
 * （0 基行号）/ `input.limit`（行数）——只有这一种入参形状能逐字翻译成 `sed -n '<from>,<to>p'`。
 *
 * 为什么不靠「有 `path` 就当它是读文件」（评审必修 2）：MCP 工具的 `path`+`limit` 是**它自己的语义**
 * （比如 `mcp__server__search` 的 `limit` 是命中条数、`offset` 是游标），拼成 sed 会指到完全不同的行；
 * exec / 宿主自定义工具同理。宁可退回「重读源文件」那句，也不发一条把模型指到错地方的命令。
 * 宿主若真有 readFile 的别名，在这里加上那个名字（加了就要有对应入参契约的依据）。
 */
export const READFILE_RETRIEVAL_TOOL_NAMES = Object.freeze(["readFile"]);

/**
 * 从**配对的 tool_use 入参**里拼一条可执行的原文取回命令（issue #741）。
 *
 * @param {string} name 工具名；**只认 `READFILE_RETRIEVAL_TOOL_NAMES`**，exec / MCP / 未知工具一律不算
 * @param {unknown} input 该 tool_use 的入参
 * @returns {string|undefined} 形如 `sed -n '1,120p' 'src/x.js'`；不在白名单或入参里没有路径时 undefined
 */
export function retrievalCommandFor(name, input) {
  // 名字先过闸：不在白名单就一个字也不拼（MCP 带 `path` 也算不算）。
  if (!READFILE_RETRIEVAL_TOOL_NAMES.includes(String(name ?? ""))) return undefined;
  const params = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (params.command !== undefined) return undefined;
  const filePath = typeof params.path === "string" ? params.path : "";
  if (filePath === "") return undefined;
  const offset = Number.isSafeInteger(params.offset) && params.offset > 0 ? params.offset : 0;
  const limit = Number.isSafeInteger(params.limit) && params.limit > 0 ? params.limit : RETRIEVAL_WINDOW_LINES;
  const from = offset + 1;
  return `sed -n '${from},${from + limit - 1}p' ${shellQuote(filePath)}`;
}

// note/todo 是轻量状态读数，折叠净收益为负，永不折叠。
const NEVER_FOLD_NAME = /^(note_|todo_)/i;
// 占位符里允许出现的原文/入参片段上限（防「换皮重发」）。
const SNIPPET_LIMIT = 100;
const COMMAND_SNIPPET_LIMIT = 80;
// 折叠占位符总量上限（含 digest 行与 JSON 骨架行）。
const PLACEHOLDER_CHAR_LIMIT = 600;
// 预警轮提示文案（单行，追加在原文末尾）。
const TTL_WARNING_LINE =
  "【TTL 预警】此结果下一轮将折叠为句柄；若后续仍需，请现在用 note_take 记录要点";
// issue #741：笔记工具不在面上时，这句在指挥模型去调一个**不存在的工具**。
// 替代文案里不许出现任何 `note_*`（判据②的字面要求）。
const TTL_WARNING_LINE_NO_NOTES =
  "【TTL 预警】此结果下一轮将折叠为句柄；若后续仍需原文，请现在重读源文件";

function compactSnippet(value, limit = SNIPPET_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

// 工具名 + 关键入参摘要：readFile 类显示 path+offset+limit；exec 类显示 command 前 80 字符；
// 其余 JSON 压缩单行显示。全部限长，占位符整体控制在 ~200 字符量级。
//
// issue #564：折叠摘要的「工具调用清单」**复用本函数**（导出，不再复制一份实现），
// 于是 TTL 占位符与摘要清单对「一次调用长什么样」永远同一个口径。
export function summarizeToolCall(name, input) {
  const toolName = String(name ?? "tool");
  const params = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const keys = Object.keys(params);
  if (params.command !== undefined || /^(exec|bash|sh|run|command)/i.test(toolName)) {
    const command = params.command ?? params.cmd ?? params.script ?? "";
    return `${toolName} ${compactSnippet(command, COMMAND_SNIPPET_LIMIT)}`;
  }
  if (params.path !== undefined || /read|file|cat/i.test(toolName)) {
    const parts = [`path=${String(params.path ?? params.file ?? "?")}`];
    if (params.offset !== undefined) parts.push(`offset=${String(params.offset)}`);
    if (params.limit !== undefined) parts.push(`limit=${String(params.limit)}`);
    return `${toolName} ${compactSnippet(parts.join(" "), SNIPPET_LIMIT)}`;
  }
  if (keys.length === 0) return toolName;
  let serialized;
  try {
    serialized = JSON.stringify(params);
  } catch {
    serialized = String(params);
  }
  return `${toolName} ${compactSnippet(serialized, SNIPPET_LIMIT)}`;
}

// —— 结构化导航摘要 ——
// 从「行号: 内容」格式文本（readFile 类结果）提取定义行：函数/类/def/markdown 标题/
// export 声明。每条取行号 + 签名片段（≤60 字符），供折叠占位符做精确导航。
const DIGEST_FRAG_LIMIT = 60;

function digestFragmentFor(lineText) {
  const text = String(lineText ?? "");
  let match;
  // markdown 标题：`#+ 文本`（取标题文本做片段，总长度 ≤60 字符）。
  if ((match = text.match(/^\s*#{1,6}\s+(.+)$/))) {
    return compactSnippet(match[1], DIGEST_FRAG_LIMIT).slice(0, DIGEST_FRAG_LIMIT);
  }
  // 函数定义（含 export function / async function / 缩进方法）：名 + `(`。
  if ((match = text.match(/(?:^|[^\w$])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/))) {
    return `${match[1]}(`;
  }
  // 无参函数定义（`function name {` / `function name`）：仅名。
  if ((match = text.match(/(?:^|[^\w$])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) {
    return match[1];
  }
  // Python def：`def name(...)`。
  if ((match = text.match(/(?:^|[^\w$])def\s+([A-Za-z_]\w*)\s*\(/))) {
    return `${match[1]}(`;
  }
  // 类定义（含 export class / extends）。
  if ((match = text.match(/(?:^|[^\w$])class\s+([A-Za-z_$][\w$]*)/))) {
    return match[1];
  }
  // export const/let/var 声明（export function/class 已被上面的分支覆盖）。
  if ((match = text.match(/(?:^|[^\w$])export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
    return match[1];
  }
  return undefined;
}

function collectDigestEntries(text, maxEntries) {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text.split("\n");
  // 非「行号: 内容」格式（无一行匹配）→ 空，调用方返回 undefined。
  const numbered = lines.some((line) => /^\s*\d+:\s/.test(line));
  if (!numbered) return [];
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+):\s?(.*)$/);
    if (!match) continue;
    const fragment = digestFragmentFor(match[2]);
    if (fragment === undefined || fragment === "") continue;
    entries.push(`L${match[1]} ${fragment}`);
    if (entries.length >= maxEntries) break;
  }
  return entries;
}

/**
 * 提取「行号: 内容」文本的结构化导航摘要（单行、竖线分隔）。
 * 识别 function/class/def/markdown 标题/export 声明的定义行。
 *
 * @param {unknown} content readFile 类文本结果
 * @param {object} [options]
 * @param {number} [options.maxEntries=12] 最多返回条数
 * @returns {string|undefined} 形如 `L120 handleLogin( | L294 postMessage(`；
 *   非行号格式或提取为空时返回 undefined
 */
export function extractContentDigest(content, { maxEntries = 12 } = {}) {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.floor(maxEntries)
    : 12;
  const entries = collectDigestEntries(content, limit);
  return entries.length === 0 ? undefined : entries.join(" | ");
}

// 折叠占位符：标题行 + 可选 digest 行 + 可选 JSON 骨架行，总量控制在 ~600 字符内
// （digest 不足 maxEntries 条就多少放多少；超限时从尾向前裁剪 digest 条目）。
function buildFoldPlaceholder({ inputSummary, tokens, round, hint, text, skeleton, noteTail, retrievalCommand }) {
  const header = `【已折叠·TTL】${inputSummary}`
    + `（约 ${tokens} tokens，r${round} 读取）— ${hint}`
    + noteTail;
  let entries = collectDigestEntries(text, 12);
  for (;;) {
    const lines = [header];
    // 取回命令单独一行：整行就是一条能直接粘进 exec 的命令，不必从长句里抠。
    if (retrievalCommand !== undefined) lines.push(`取回: ${retrievalCommand}`);
    if (entries.length > 0) lines.push(`导航: ${entries.join(" | ")}`);
    if (skeleton !== undefined) lines.push(skeleton);
    const rendered = lines.join("\n");
    if (rendered.length <= PLACEHOLDER_CHAR_LIMIT || entries.length === 0) return rendered;
    entries = entries.slice(0, -1);
  }
}

// content 形如 {success,data,error} 时，占位符额外保留一行结果骨架（成败/总条数）。
function jsonSkeleton(content) {
  if (typeof content !== "string" || content.trimStart()[0] !== "{") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (!("success" in parsed) && !("data" in parsed) && !("error" in parsed)) {
    return undefined;
  }
  const parts = [];
  if (parsed.success !== undefined) parts.push(`success=${String(parsed.success)}`);
  if (parsed.error !== undefined && parsed.error !== null && parsed.error !== "") {
    parts.push(`error=${compactSnippet(
      typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error),
      60,
    )}`);
  }
  const data = parsed.data;
  if (Array.isArray(data)) parts.push(`共${data.length}条`);
  else if (data && typeof data === "object" && Array.isArray(data.items)) {
    parts.push(`共${data.items.length}条`);
  }
  return parts.length === 0 ? undefined : `骨架: ${parts.join(" · ")}`;
}

function defaultRetrievalHint({ recall, retrievalCommand }) {
  // issue #741：断言前先问证据。`recall.available` 为假时**一句笔记都不提**，
  // 并把「没有可复原的记录」连同原因明说 —— 而不是指一条可能不存在的 note_* 路。
  if (recall?.available !== true) return unverifiedRetrievalHint(retrievalCommand, recall?.reason);
  return NOTE_RECALL_HINT;
}

function shouldNeverFold(block, toolName) {
  if (block?.is_error === true) return true;
  if (block?.noFold === true) return true;
  if (NEVER_FOLD_NAME.test(toolName)) return true;
  return false;
}

/**
 * 年龄标记的读路径（工单 261014 T2 §2.1）：**`erix.round` 优先，顶层 `erixRound` 只作旧记录回退**。
 *
 * 顺序是硬的：本模块先改成读 `erix.round`，引擎才允许停写顶层 `erixRound`（T2 第 3 节）。
 * 反过来的话停写就是**静默失效**——`Number.isFinite(undefined)` 永远假，每个块都 `continue`，
 * 旧结果再也折不掉，而没有任何一处会报错。回退保留一代：升级前落盘的 run snapshot 仍按年龄折叠。
 *
 * @param {any} block canonical `tool_result` 块
 * @returns {unknown} 创建轮号（可能是 undefined / 非数字，由调用处过 `Number.isFinite`）
 */
function readRoundMarker(block) {
  return block.erix?.round ?? block.erixRound;
}

/**
 * 构建请求级折叠视图：年龄达标且体积达标的 tool_result 替换为占位符，
 * 保留 type/tool_use_id/工具名配对（OpenAI 协议要求 tool_use 必有配对结果）。
 *
 * @param {Array<object>} messages canonical messages（不改原数组/原块）
 * @param {object} options
 * @param {number} options.currentRound 即将执行的轮号
 * @param {number} [options.ttl=2] 存活轮数：currentRound - 创建轮 >= ttl 时折叠（创建轮读 `erix.round`，旧记录回退顶层 `erixRound`）
 * @param {number} [options.minTokens=4000] 低于此估算 tokens 的结果永不折叠
 * @param {(info:object)=>string} [options.retrievalHint] 自定义取回提示文本生成
 * @param {string[]} [options.noteTools] 本 run 工具面上的笔记工具名（宿主 `tools` 里 `note_*` 那几个）。
 *   **缺席即未知**：issue #741 之后缺省不再是「有笔记」而是「没证据」⇒ 占位符走显式未知口径。
 *   账本证据（本函数拿到的 `messages`）始终会扫，调用方想关掉只能不传 `noteTools`。
 * @param {{foldedCount?: number, warnedCount?: number, tokensBefore?: number, tokensAfter?: number, degradations?: object[]}} [options.stats]
 *   可选的可变统计出参；只报告实际折叠/预警，不改变请求视图语义。
 *   `degradations`（issue #326 wo-C，additive，**只在真的折叠时出现**）：逐条降级事实，供引擎入账「这条工具结果被降级成了什么」
 *   ——`{ toolUseId, toolName, toolCallKey, createdRound, tokens, tokensAfter, chars, contentFingerprint, placeholder }`；
 *   `placeholder` 是逐字喂给模型的占位（自带原始体积/引用/导航 digest），绝不退化成「（内容已省略）」。
 * @returns {Array<object>} 折叠后的浅拷贝视图（无折叠时返回原数组引用）
 */
export function foldToolResultsForRequest(messages, {
  currentRound,
  ttl = TOOL_RESULT_TTL_DEFAULT,
  minTokens = TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT,
  retrievalHint,
  noteTools,
  stats,
} = {}) {
  const report = stats !== null && typeof stats === "object" && !Array.isArray(stats)
    ? stats
    : undefined;
  if (report !== undefined) {
    report.foldedCount = 0;
    report.warnedCount = 0;
    report.tokensBefore = 0;
    report.tokensAfter = 0;
  }
  if (!Array.isArray(messages)) return messages;
  if (!Number.isFinite(currentRound) || !Number.isFinite(ttl) || !Number.isFinite(minTokens)) {
    return messages;
  }
  // issue #741：一次算定笔记可用性（同一份视图里每个占位符共用同一个判定）。
  const noteRecall = resolveNoteRecall({ noteTools, messages });
  const warningLine = noteRecall.available ? TTL_WARNING_LINE : TTL_WARNING_LINE_NO_NOTES;
  const noteTail = noteRecall.available ? NOTE_RECALL_TAIL : "";
  // ttl=0 / minTokens<=0 = 关闭，no-op（保持引用不变，调用方零成本）。
  if (ttl <= 0 || minTokens <= 0) return messages;

  // 先扫一遍建 tool_use id → {name,input} 映射（配对摘要用）。
  const toolCalls = new Map();
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        toolCalls.set(block.id, { name: block.name, input: block.input });
      }
    }
  }

  let changedCount = 0;
  const view = messages.map((message) => {
    const content = Array.isArray(message?.content) ? message.content : null;
    if (content === null || message?.role !== "user") return message;

    let nextContent;
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (block?.type !== "tool_result") continue;
      const call = toolCalls.get(block.tool_use_id) ?? {};
      const toolName = String(call.name ?? "");
      if (shouldNeverFold(block, toolName)) continue;
      // 年龄标记缺失（旧 run snapshot 恢复的结果）→ 保守不折。
      // 读路径见 `readRoundMarker`：`erix.round` 优先，顶层 `erixRound` 只作旧记录回退（T2 §2.1）。
      const createdRound = readRoundMarker(block);
      if (!Number.isFinite(createdRound)) continue;
      // 上面的 `Number.isFinite` 已经排掉 undefined / 非数字，这里只是把 narrowing 交给类型检查器
      // （`readRoundMarker` 的返回故意是 `unknown`：旧记录里这个位置可能是什么东西）。
      const age = currentRound - /** @type {number} */ (createdRound);
      const text = typeof block.content === "string"
        ? block.content
        : String(block.content ?? "");

      if (age < ttl) {
        // 预警轮：下一轮（age 达 ttl）即折叠，且通过体积门槛 → 末尾追加一行预警。
        // age===ttl-1 且 age>=1 才预警：ttl>=2 才有预警轮，ttl=1 时当轮结果（age=0）
        // 本来就在场，不误伤。视图每次重建、原块不动，天然幂等不重复叠加。
        if (age === ttl - 1 && age >= 1) {
          if (estimateTokens(text) >= minTokens) {
            if (nextContent === undefined) nextContent = content.slice();
            nextContent[index] = { ...block, content: `${text}\n${warningLine}` };
            changedCount += 1;
            if (report !== undefined) report.warnedCount += 1;
          }
        }
        continue;
      }

      const tokens = estimateTokens(text);
      if (tokens < minTokens) continue;

      const inputSummary = summarizeToolCall(call.name, call.input);
      // 能确定性重算的（入参里有路径）就直接给一条可执行命令；exec 类返回 undefined。
      const retrievalCommand = retrievalCommandFor(call.name, call.input);
      const hint = typeof retrievalHint === "function"
        ? retrievalHint({ name: toolName, inputSummary, tokens, round: createdRound, noteRecall: noteRecall })
        : defaultRetrievalHint({
          name: toolName,
          inputSummary,
          tokens,
          round: createdRound,
          recall: noteRecall,
          retrievalCommand,
        });
      const contentSummary = buildFoldPlaceholder({
        inputSummary,
        tokens,
        round: createdRound,
        hint,
        text,
        skeleton: jsonSkeleton(text),
        noteTail,
        ...(noteRecall.available ? {} : { retrievalCommand }),
      });

      if (nextContent === undefined) nextContent = content.slice();
      nextContent[index] = { ...block, content: contentSummary };
      changedCount += 1;
      if (report !== undefined) {
        report.foldedCount += 1;
        report.tokensBefore += tokens;
        report.tokensAfter += estimateTokens(contentSummary);
        // 只在**真的发生降级**时挂上（没折叠时 stats 的形状与改动前逐字一致，既有断言不受扰）。
        if (!Array.isArray(report.degradations)) report.degradations = [];
        report.degradations.push({
          toolUseId: block.tool_use_id,
          toolName,
          ...(typeof block.erix?.toolCallKey === "string"
            ? { toolCallKey: block.erix.toolCallKey }
            : {}),
          createdRound: createdRound,
          tokens,
          tokensAfter: estimateTokens(contentSummary),
          chars: text.length,
          contentFingerprint: `sha256:${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24)}`,
          placeholder: contentSummary,
          // issue #741（additive，**只在真有值时出现**）：宿主能拿到同一条取回命令，不必解析占位符。
          ...(retrievalCommand === undefined ? {} : { retrievalCommand }),
          noteRecall: { available: noteRecall.available, reason: noteRecall.reason },
        });
      }
    }

    if (nextContent === undefined) return message;
    return { ...message, content: nextContent };
  });

  return changedCount === 0 ? messages : view;
}
