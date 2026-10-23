// @ts-check
/**
 * 工具引数（tool arguments）的解析与判词（issue #409 需求②）。
 *
 * 病根（本单实测，别重复调查）：`parseOpenAIToolArguments`（`src/messages/openai-normalization.js`）
 * 的 `catch {}` 把**解析器原话整句丢掉**，返回 `{_truncatedArguments, _raw}` 假对象；参数变成假对象
 * 之后**工具照样被执行**，模型看到的错误是「缺 path 参数」这种**二次错误**，而不是「第 37 个字符少
 * 个引号」；宿主也分不出「模型写坏了 JSON」和「工具真的失败了」。Anthropic 侧的孪生逻辑
 * （`src/messages/anthropic.js` 的 `parsedInput`）另写了一遍同款假对象。
 *
 * 本模块把三件事收成一处（L0 严格层 `parseModelJson` 一字未动，那是另一条线）：
 *   1. 先 L0（原文 `JSON.parse`），再 L1 确定性修复（`src/text/repair-json.js`，规则表默认开）；
 *   2. 修完仍解析不出来 ⇒ 产出**判词**（解析器原话 + 位置 + 正确形状示例）；
 *   3. 判词挂到 `tool_use` 块的 `erix.argumentsParseError` 上（不是塞进 `input`：`input` 是要回给
 *      模型看的引数本身，塞进去会变成模型自己的参数，也会让 `invalidArguments: "execute"` 的
 *      「逐字等于今天」失效）。
 *
 * 引数**不走**逐字闸门：设计文档明写「引数是指令不是事实」（`docs/tasks/active/task-261023-406-normalization/DESIGN.md`
 * §2 需求②）。闸门那条不变量约束的是**修复器**（见 `src/text/repair-json.js` 的文件头）。
 *
 * 零依赖：只用 `node:` 内建与相对路径。
 */

import { parseJsonWithRepair } from "../text/repair-json.js";

/**
 * 今天那个假回落对象（**本单不删**：删除是第三张单的活，见 issue #409 裁定 3）。
 *
 * 现名本就误导（它接的不止截断），但它是契约面承诺过的键、有测试钉着，改名/删除要配升级指南。
 *
 * @param {unknown} value
 * @returns {{_truncatedArguments: unknown, _raw: unknown}}
 */
export function legacyArgumentsFallback(value) {
  return {
    _truncatedArguments: value,
    _raw: value,
  };
}

/**
 * 解析一份工具引数：L0 → L1 → 判词。
 *
 * `input` 与今天**逐字兼容**：能解析就是解析结果，不能解析就是那个假对象（`_truncatedArguments` /
 * `_raw`）。`parseError` 是 additive 的（只在失败时出现），执行层据它决定「不执行这个工具」。
 *
 * @param {unknown} rawArguments provider 给的引数原值（OpenAI 是字符串，Anthropic 非流式已是对象）
 * @returns {{input: any, parseError?: {reason: string, message: string, position?: number, text?: string}}}
 */
export function parseToolArguments(rawArguments) {
  const value = rawArguments === undefined ? "{}" : rawArguments;
  if (typeof value !== "string") {
    // 非字符串：与今天逐字一致（`JSON.parse` 会把它转成字符串再抛 ⇒ 落假对象）。这一格不修：
    // 修复层的输入契约是「模型写的**文本**」，把一个对象「修」成可解析不是本层的职责。
    try {
      return { input: JSON.parse(/** @type {any} */ (value)) };
    } catch (error) {
      return {
        input: legacyArgumentsFallback(value),
        parseError: {
          reason: "unparsable",
          message: String(error?.message ?? error),
        },
      };
    }
  }
  const parsed = parseJsonWithRepair(value);
  if (parsed.ok) return { input: parsed.value };
  return { input: legacyArgumentsFallback(value), parseError: parsed.error };
}

/** JSON Schema 的 `type` → 一个「照着写就能过」的占位值。 */
function placeholderFor(schema) {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  switch (type) {
    case "number":
    case "integer":
      return "0";
    case "boolean":
      return "false";
    case "array":
      return "[]";
    case "object":
      return "{}";
    case "null":
      return "null";
    case "string":
    default:
      return "\"\"";
  }
}

/**
 * 从工具自己的 `inputSchema` 生成一份**正确形状示例**（判词里那句「正确形状」）。
 *
 * 为什么用工具的 schema 而不是一句泛泛的 `{...}`：判词的全部价值就是让模型下一轮自己改对；
 * 「readFile 要 `{"path": "", "limit": 0}`」比「要一个 JSON 对象」可执行得多。schema 缺失
 * （宿主没给、或工具没声明）时退回泛化示例，绝不编造字段名。
 *
 * @param {any} schema 工具的 `inputSchema`
 * @returns {string}
 */
export function exampleToolArguments(schema) {
  const properties = schema?.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    const keys = Object.keys(properties);
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const requiredKeys = keys.filter((key) => required.includes(key));
    const picked = (requiredKeys.length > 0 ? requiredKeys : keys).slice(0, 6);
    if (picked.length > 0) {
      return `{${picked
        .map((key) => `${JSON.stringify(key)}: ${placeholderFor(properties[key])}`)
        .join(", ")}}`;
    }
  }
  return "{\"<参数名>\": \"<值>\"}";
}

/** 出错位置前后的一小段原文（判词里「附近」那一截）。 */
function snippetAround(text, position) {
  const radius = 20;
  const from = Math.max(0, position - radius);
  const to = Math.min(text.length, position + radius);
  const head = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  return `${head}${text.slice(from, to)}${tail}`;
}

/**
 * 生成回给模型的判词（`is_error` 的 `tool_result` 正文）。
 *
 * 参照实现是本仓 `parseEditOperations`（`src/tools/file-tools.js`）：错误文案必须带「是什么 +
 * 正确形状示例」。本单把那个工具的私有做法升成通用行为。
 *
 * @param {{toolName?: string, parseError?: {reason?: string, message?: string, position?: number, text?: string}, schema?: any}} input
 * @returns {string}
 */
export function describeToolArgumentsParseError({ toolName, parseError, schema }) {
  const name = String(toolName ?? "");
  const lines = [
    `错误：工具 ${name} 的参数不是合法 JSON，因此这次调用没有执行（引擎没有把它交给工具，工具也没收到任何参数）。`,
  ];
  if (typeof parseError?.message === "string" && parseError.message !== "") {
    lines.push(`解析器原话：${parseError.message}`);
  }
  const raw = typeof parseError?.text === "string" ? parseError.text : undefined;
  if (typeof parseError?.position === "number" && raw !== undefined) {
    lines.push(`出错位置：第 ${parseError.position + 1} 个字符（从 1 开始数），附近：${snippetAround(raw, parseError.position)}`);
  }
  lines.push(`正确形状：${exampleToolArguments(schema)}`
    + "（一个完整的 JSON 对象：成员名用双引号、成员之间用逗号分隔、不要尾逗号、"
    + "不要把整个对象再套一层字符串）");
  lines.push("请只改参数的写法并重发这次调用：不要换工具，也不要凭猜测补内容。");
  return lines.join("\n");
}
