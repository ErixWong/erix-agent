// 工具结果 TTL 折叠（issue #35）：已消费的大体积 tool_result 在存活 ttl 轮后，
// 从发往 provider 的请求视图里替换为占位符（recall 配方指向 checkpoint 全文档案）。
// 纯函数：返回浅拷贝视图，不改原数组、不改原块对象；ctx.messages 始终保留全文，
// checkpoint/归档/recall 语义不受影响。叠加在既有压缩（fold-statistical 等）之上，
// 互不干扰。

import { estimateTokens } from "../tokens.js";

export const TOOL_RESULT_TTL_DEFAULT = 2;
export const TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT = 4000;

// recall / note_* / todo_* 的结果折叠净收益为负（recall 本身就是取回通道，
// note/todo 是轻量状态读数），永不折叠。
const NEVER_FOLD_NAME = /^(recall|note_|todo_)/i;
// 占位符里允许出现的原文/入参片段上限（防「换皮重发」）。
const SNIPPET_LIMIT = 100;
const COMMAND_SNIPPET_LIMIT = 80;

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

  let foldedCount = 0;
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
      if (age < ttl) continue;
      const text = typeof block.content === "string"
        ? block.content
        : String(block.content ?? "");
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
      const lines = [
        `【已折叠·TTL】${inputSummary}`
          + `（约 ${tokens} tokens，r${block.erixRound} 读取）— ${hint}`
          + `；要点见对话中已有笔记/结论`,
      ];
      const skeleton = jsonSkeleton(text);
      if (skeleton !== undefined) lines.push(skeleton);

      if (nextContent === undefined) nextContent = content.slice();
      nextContent[index] = { ...block, content: lines.join("\n") };
      foldedCount += 1;
    }

    if (nextContent === undefined) return message;
    return { ...message, content: nextContent };
  });

  return foldedCount === 0 ? messages : view;
}
