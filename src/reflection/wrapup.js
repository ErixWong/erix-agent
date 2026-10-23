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
 * **不迁**到公共入口 `parseModelJson`（`src/text/parse-model-json.js`，issue #307），
 * 保留对 `jsonCandidates` 的直接调用，因为迁过去会改本函数的现有行为：本文件的形状门槛
 * （`normalizedWrapup`：`done` 必须是字面布尔、出现 `action`/`note` 就退回内联 L1 路径、
 * `summary`/`output` 必须是字符串）比 `requireKeys` 的键存在性判定严，而且**不合格时必须
 * 继续试下一个候选**（例：`{"done":"true"}{"done":true}` 现在返回后者）；公共入口只返回
 * 单个 `value`，拿它就得把「跳过这个候选」改成「整次失败」。扫描仍然只有一份实现。
 *
 * 只产**顶层平衡对象**的理由（issue #30 follow-up，必须继续成立）：宿主自己的结果 JSON
 * 里嵌套一个 `{"done":true,...}` 时，内层残片否则会绕过上面的 mandatory-done 守卫。
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
    // issue #419 ①：归一化只输出一段 JSON，与 judge 同口径——**总是**不思考（这是本函数的
    // 语义，不是选项：对外签名/选项/返回值一字未改）。思考开着的模型上小预算会被思考吃光：
    // 2026-10-23 真上游实测（qwen3.8-flash-next，maxTokens:120、temperature:0、同一段输入）
    // 默认 ⇒ 正文 0 字 / 思考 198 字 / output_tokens 顶格 120 / 本函数返回 null；带
    // reasoning_effort:"none" ⇒ 正文 228 字 / 思考 0 字。写法逐字照
    // `src/loop/orchestrator.js` 的 judge 请求（那里注释写的「统一语义=不思考」）；GLM 系模型
    // 由 provider 载荷层把 "none" 转译成 "low"（见 `src/providers/payload.js`）。
    reasoning_effort: "none",
  };
  if (signal !== undefined) request.signal = signal;
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  if (temperature !== undefined) request.temperature = temperature;
  const response = typeof evaluator === "function"
    ? await evaluator(request)
    : await evaluator.chat(request);
  return tryParseWrapupJson(textFromBlocks(blocksFor(response?.content)));
}
