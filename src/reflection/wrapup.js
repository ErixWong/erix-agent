import { jsonCandidates } from "../text/json-candidates.js";

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function normalizedWrapup(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // Keep the legacy inline L1 summary object on its existing parsing path.
  if (value.action !== undefined || value.note !== undefined) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "done")
    || typeof value.done !== "boolean") return null;
  if (value.summary !== undefined && typeof value.summary !== "string") return null;
  if (value.output !== undefined && typeof value.output !== "string") return null;
  return {
    done: value.done,
    summary: value.summary ?? "",
    output: value.output ?? "",
    ...(normalizeFindings(value.findings) === undefined
      ? {}
      : { findings: normalizeFindings(value.findings) }),
  };
}

/**
 * ADR-016 后续（2026-09-17 实测裁定）：终稿关键值声明的唯一权威载体是信封的
 * findings 字段（label→原始值字符串）；guard 不再解析散文。值必须是可字符串化的
 * 原始值；非法条目逐条丢弃，全部非法时视为未声明。
 */
function normalizeFindings(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const findings = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (!["string", "number", "boolean"].includes(typeof item)) continue;
    if (!Number.isFinite(item) && typeof item === "number") continue;
    findings[key] = String(item);
    count += 1;
  }
  return count > 0 ? findings : undefined;
}


/**
 * Parse the end-of-turn JSON protocol while tolerating markdown fences and
 * incidental text around the first JSON object.
 *
 * **不经 `parseModelJson`（issue #307 R2 裁定：不迁）**，理由三条：
 *
 * 1. 它是**逐候选拒绝**的：已解析的候选仍可能被 `normalizedWrapup` 打回 `null`
 *    （带 `action`/`note` 的内联 L1 对象、`done` 不是布尔、`summary`/`output` 类型不对），
 *    然后继续试下一个候选；而 `parseModelJson` 的 `value` 语义是「第一个可解析且形状
 *    合格的候选」，拿到手后再拒就会与它自己的返回不一致，只能忽略 `value` 重扫一遍。
 * 2. `requireKeys` 只查**键在场**、不查类型与**排除键**（`action`/`note` 在场即拒），
 *    把本函数能表达的形状收窄不了多少。
 * 3. 迁移只能省下一行 `for` ，代价是给一个已发布行为面加一层间接。
 *
 * 因此本文件继续直接调 `jsonCandidates`（顶层平衡扫描）。**内层对象不当候选**这件事
 * 依旧由它保证：宿主 JSON 里的嵌套对象（`{"summary":...,"meta":{"done":true}}`）不得
 * 被当成 wrap-up 候选——否则那个**内层 `{done,...}` 会绕过 mandatory-done 守卫**
 * （issue #30 follow-up，口径写在 `src/text/json-candidates.js` 与本仓 wrapup 用例里）。
 */
export function tryParseWrapupJson(text) {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = normalizedWrapup(JSON.parse(candidate));
      if (parsed !== null) return parsed;
    } catch {
      // Try the next balanced object when surrounding text contains braces.
    }
  }
  return null;
}

const WRAPUP_NORMALIZATION_PROMPT = `请把下面模型的最终文本归一化为结束协议 JSON。
只输出 JSON，不要输出其他文字：
{"done":true|false,"summary":"任务总结或当前进展","output":"给用户的最终结果","findings":{"label":"value"}}
如果原文表示任务已完成，done 为 true；否则为 false。缺少最终结果时 output 使用空字符串。原文本中的关键值（label=value 形态）逐条搬进 findings。

原始文本：
`;

/**
 * Ask an evaluator to normalize a non-conforming end-of-turn response.
 * The loop may use this as an optional, low-frequency fallback.
 */
export async function normalizeWrapupWithLlm(
  text,
  evaluator,
  { signal, maxTokens, temperature } = {},
) {
  const request = {
    system: "你是输出协议归一化器，只输出有效 JSON。",
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: `${WRAPUP_NORMALIZATION_PROMPT}${String(text ?? "")}`,
      }],
    }],
  };
  if (signal !== undefined) request.signal = signal;
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  if (temperature !== undefined) request.temperature = temperature;
  const response = typeof evaluator === "function"
    ? await evaluator(request)
    : await evaluator.chat(request);
  return tryParseWrapupJson(textFromBlocks(blocksFor(response?.content)));
}
