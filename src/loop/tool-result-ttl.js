// 工具结果 TTL 折叠（issue #35）：已消费的大体积 tool_result 在存活 ttl 轮后，
// 从发往 provider 的请求视图里替换为占位符（recall 配方指向 checkpoint 全文档案）。
// 纯函数：返回浅拷贝视图，不改原数组、不改原块对象；ctx.messages 始终保留全文，
// checkpoint/归档/recall 语义不受影响。叠加在既有压缩（fold-statistical 等）之上，
// 互不干扰。
//
// 增强（issue #35 探索项，v4 A/B 实测驱动）：
// 1. 预警轮：age === ttl-1（下一轮即折叠）的大结果，content 末尾追加一行预警，
//    提示模型趁全文在场用 note_take 记录要点（拷贝块后追加，绝不动原块）。
// 2. 结构化导航摘要：折叠占位符内嵌确定性 digest（定义行签名 + 行号），
//    recall 从全文重读升级为精确取段。

import { estimateTokens } from "../tokens.js";

export const TOOL_RESULT_TTL_DEFAULT = 2;
export const TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT = 4000;

// recall / note_* / todo_* 的结果折叠净收益为负（recall 本身就是取回通道，
// note/todo 是轻量状态读数），永不折叠。
const NEVER_FOLD_NAME = /^(recall|note_|todo_)/i;
// 占位符里允许出现的原文/入参片段上限（防「换皮重发」）。
const SNIPPET_LIMIT = 100;
const COMMAND_SNIPPET_LIMIT = 80;
// 折叠占位符总量上限（含 digest 行与 JSON 骨架行）。
const PLACEHOLDER_CHAR_LIMIT = 600;
// 预警轮提示文案（单行，追加在原文末尾）。
const TTL_WARNING_LINE =
  "【TTL 预警】此结果下一轮将折叠为句柄；若后续仍需，请现在用 note_take 记录要点";

function compactSnippet(value, limit = SNIPPET_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

// 工具名 + 关键入参摘要：readFile 类显示 path+offset+limit；exec 类显示 command 前 80 字符；
// 其余 JSON 压缩单行显示。全部限长，占位符整体控制在 ~200 字符量级。
function summarizeToolCall(name, input) {
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
function buildFoldPlaceholder({ inputSummary, tokens, round, hint, text, skeleton }) {
  const header = `【已折叠·TTL】${inputSummary}`
    + `（约 ${tokens} tokens，r${round} 读取）— ${hint}`
    + `；要点见对话中已有笔记/结论`;
  let entries = collectDigestEntries(text, 12);
  for (;;) {
    const lines = [header];
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

function defaultRecallHint({ round }) {
  // recall 签名（src/tools/recall.js）：fromRound/toRound/pattern/offset/lineOffset/lineLimit。
  // fromRound 取结果创建轮：rangeText 按轮取回归档原文。
  return `原文已归档，recall({fromRound:${round}, pattern:"关键词"}) 可取回`;
}

function shouldNeverFold(block, toolName) {
  if (block?.is_error === true) return true;
  if (block?.noFold === true) return true;
  if (NEVER_FOLD_NAME.test(toolName)) return true;
  return false;
}

/**
 * 构建请求级折叠视图：年龄达标且体积达标的 tool_result 替换为占位符，
 * 保留 type/tool_use_id/工具名配对（OpenAI 协议要求 tool_use 必有配对结果）。
 *
 * @param {Array<object>} messages canonical messages（不改原数组/原块）
 * @param {object} options
 * @param {number} options.currentRound 即将执行的轮号
 * @param {number} [options.ttl=2] 存活轮数：currentRound - erixRound >= ttl 时折叠
 * @param {number} [options.minTokens=4000] 低于此估算 tokens 的结果永不折叠
 * @param {(info:object)=>string} [options.recallHint] 自定义 recall 句柄文本生成
 * @returns {Array<object>} 折叠后的浅拷贝视图（无折叠时返回原数组引用）
 */
export function foldToolResultsForRequest(messages, {
  currentRound,
  ttl = TOOL_RESULT_TTL_DEFAULT,
  minTokens = TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT,
  recallHint,
} = {}) {
  if (!Array.isArray(messages)) return messages;
  if (!Number.isFinite(currentRound) || !Number.isFinite(ttl) || !Number.isFinite(minTokens)) {
    return messages;
  }
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
      // 年龄标记缺失（旧 checkpoint 恢复的结果）→ 保守不折。
      if (!Number.isFinite(block.erixRound)) continue;
      const age = currentRound - block.erixRound;
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
            nextContent[index] = { ...block, content: `${text}\n${TTL_WARNING_LINE}` };
            changedCount += 1;
          }
        }
        continue;
      }

      const tokens = estimateTokens(text);
      if (tokens < minTokens) continue;

      const inputSummary = summarizeToolCall(call.name, call.input);
      const hint = typeof recallHint === "function"
        ? recallHint({ name: toolName, inputSummary, tokens, round: block.erixRound })
        : defaultRecallHint({
          name: toolName,
          inputSummary,
          tokens,
          round: block.erixRound,
        });
      const contentSummary = buildFoldPlaceholder({
        inputSummary,
        tokens,
        round: block.erixRound,
        hint,
        text,
        skeleton: jsonSkeleton(text),
      });

      if (nextContent === undefined) nextContent = content.slice();
      nextContent[index] = { ...block, content: contentSummary };
      changedCount += 1;
    }

    if (nextContent === undefined) return message;
    return { ...message, content: nextContent };
  });

  return changedCount === 0 ? messages : view;
}
