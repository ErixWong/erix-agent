// @ts-check
/**
 * 收尾协议（wrap-up envelope）的解析与 LLM 归一化。
 *
 * 本文件有两个出口，分工按 issue #406 设计稿 §4 的「撤件顺序」：
 *   · `tryParseWrapupJson` —— **同步、严格**的第一遍解析（只 `JSON.parse` L0 扫描出的候选，
 *     一个字都不修）。引擎每轮先用它；`src/loop/termination.js` 也用它。
 *   · `normalizeWrapupWithLlm` —— **公开**的 LLM 归一化入口（issue #406 B2-b 起是**薄壳**：
 *     内部转调 `normalizeWrapupText`，与引擎内联那条收尾归一化走**同一个**实现）。
 *
 * 「同一个实现」= 同一份 L2 提示词（`normalizeModelJson` 的 `buildL2Request` + 本文件的
 * `WRAPUP_SHAPE_SCHEMA`）、同一道闸门（`wrapupGate`：`findings` 的每个值必须逐字摘自**原文**）、
 * 同一个「思考恒关」取值（`NORMALIZATION_REASONING_EFFORT`）。删除薄壳属 breaking，不在 B2-b。
 *
 * 零依赖：只用 `node:` 内建与相对路径。
 */

import { normalizeModelJson } from "../normalization/parse-model-json.js";
import { jsonCandidates } from "../text/json-candidates.js";

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
 *
 * @param {any} value
 * @returns {Record<string, string>|undefined}
 */
function normalizeFindings(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  /** @type {Record<string, string>} */
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
 * 这条差异**今天仍然成立**（`test/wrapup.test.js` 拿同一个输入对拍：`parseModelJson` 在
 * 第一个候选上停下，返回 `{"done":"true"}`）。异步那条归一化路径（`normalizeWrapupText`
 * → `normalizeModelJson`）**也**能跳过并续试（`wrapupGate` 逐候选判），但它是**另一层**：
 * 会修结构、会发 L2 请求、恒返回 Promise。本函数是同步、零修复、零请求的那一遍。
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

/**
 * 归一化请求的「不思考」取值——**唯一字面量**（issue #419 ① 后半段）。
 *
 * 为什么要有这个常量：归一化这条路只有**一个**请求构造点（`normalizeModelJson` 的
 * `buildL2Request`，`src/normalization/parse-model-json.js`），但它的两个调用方
 * （引擎内联的收尾归一化与公开入口 `normalizeWrapupWithLlm`）都必须发同一个值。
 * 本常量是那条语义的唯一出处：`parse-model-json.js` 引用它而**不是**字面量。
 *
 * **故意不导出到 `src/index.js`**：这是内部实现细节，不是对外契约（对外签名/选项/返回值一字未改）。
 * 也不加进 `RUN_TOOL_LOOP_OPTION_NAMES`——它不是选项，是语义。
 */
export const NORMALIZATION_REASONING_EFFORT = "none";

/**
 * L2 的「正确形状示例」来源（`exampleToolArguments`，issue #409 的同一个示例器）。
 *
 * 四个键都列进 `required`，示例才是**完整信封**而不是只给 `{"done": false}`：归一化器要抄的
 * 是 `summary` / `output` / `findings` 这三个字段，示例里没有它们等于没给形状。
 */
export const WRAPUP_SHAPE_SCHEMA = Object.freeze({
  type: "object",
  required: ["done", "summary", "output", "findings"],
  properties: {
    done: { type: "boolean" },
    summary: { type: "string" },
    output: { type: "string" },
    findings: { type: "object" },
  },
});

/**
 * 把 findings 按「值必须逐字出现在原文里」分成保留与丢弃两组。
 *
 * 空串一律丢弃（与旧内联 `filterFindingsBySource` 的 `text.length > 0` 同口径）：
 * `"".includes` 恒真，不先挡掉就会让一条**空声明**混进 guard 的核验面。
 *
 * @param {Record<string, string>|undefined} findings
 * @param {string} sourceText agent 的**原文**（不是归一化器的回答）
 * @returns {{kept: Record<string, string>, dropped: string[]}}
 */
function splitFindings(findings, sourceText) {
  const source = typeof sourceText === "string" ? sourceText : "";
  /** @type {Record<string, string>} */
  const kept = {};
  /** @type {string[]} */
  const dropped = [];
  for (const [key, value] of Object.entries(findings ?? {})) {
    if (value.length > 0 && source.includes(value)) kept[key] = value;
    else dropped.push(key);
  }
  return { kept, dropped };
}

/**
 * 收尾归一化的闸门：形状 + 「findings 只许搬运」。
 *
 * **判据永远是 `sourceText`（agent 的原文），不是候选自己的字节。** `normalizeModelJson`
 * 会把「该候选的原始切片」作为第二个参数递进来，但对收尾归一化来说那不是原文：L2 候选的
 * `source` 是**归一化器的回答**，拿它判 `findings` 等于让归一化器自己给自己作证（它改写的值
 * 当然出现在它自己的回答里）。所以这里闭包捕获 agent 原文，第二个参数刻意不用。
 *
 * 不合格的 finding **逐条丢弃**（`dropped`），不是整条信封拒收——与旧内联路径的
 * `filterFindingsBySource` 同语义：归一化器顺手改写一个值，不该把整轮归一化一起废掉。
 *
 * @param {string} sourceText agent 的**原文**
 * @returns {(value: any, source?: string) => {ok: boolean, dropped?: string[]}}
 */
export function wrapupGate(sourceText) {
  return (value) => {
    const normalized = normalizedWrapup(value);
    if (normalized === null) return { ok: false };
    const { dropped } = splitFindings(normalized.findings, sourceText);
    return dropped.length === 0 ? { ok: true } : { ok: true, dropped };
  };
}

/**
 * 过闸后的信封：把 `dropped` 真的落成「不写这个键」。
 *
 * `normalizeModelJson` 的 `dropped` 只是**声明**（它不改 `value`），所以调用方必须自己把
 * 被丢掉的那几条剔掉，否则「闸门判掉了」与「值还在」会同时成立。
 *
 * @param {any} value
 * @param {string} sourceText
 * @returns {{done: boolean, summary: string, output: string, findings?: Record<string, string>}|null}
 */
export function wrapupValue(value, sourceText) {
  const normalized = normalizedWrapup(value);
  if (normalized === null) return null;
  const { kept } = splitFindings(normalized.findings, sourceText);
  return {
    done: normalized.done,
    summary: normalized.summary,
    output: normalized.output,
    ...(Object.keys(kept).length === 0 ? {} : { findings: kept }),
  };
}

/**
 * 收尾归一化的**唯一**实现：引擎内联路径与公开入口都走这里。
 *
 * 一次修掉四件事（设计稿 §4 最后一条）：一份提示词（`normalizeModelJson` 的 `buildL2Request`）、
 * 一道闸门（`wrapupGate`，对 agent 原文判）、思考恒关（`thinking:"none"` ⇒
 * `NORMALIZATION_REASONING_EFFORT`）、失败可见（返回 `{ok:false, error}` 而不是 `null` + 静默）。
 *
 * `temperature` 不是 `normalizeModelJson` 的选项（设计稿 §4：不给宿主七旋钮签名），所以在这里
 * 只对**宿主显式传了**的旧调用补进请求体：公开入口的 `temperature` 选项行为一字未改。
 *
 * @param {string} text agent 的原文
 * @param {{provider?: any, temperature?: number, signal?: any, maxTokens?: number}} [options]
 * @returns {Promise<{ok: boolean, value?: any, error?: string, llmUsed?: true}>}
 */
export async function normalizeWrapupText(text, { provider, temperature, signal, maxTokens } = {}) {
  const target = temperature === undefined
    ? provider
    : {
      chat(request) {
        const call = typeof provider === "function" ? provider : (/** @type {any} */ (provider)).chat.bind(provider);
        return call({ ...request, temperature });
      },
    };
  const result = await normalizeModelJson(text, {
    validate: wrapupGate(text),
    llm: true,
    provider: target,
    thinking: "none",
    schema: WRAPUP_SHAPE_SCHEMA,
    ...(signal === undefined ? {} : { signal }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
  if (result.ok !== true) {
    return {
      ok: false,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.llmUsed === true ? { llmUsed: true } : {}),
    };
  }
  const value = wrapupValue(result.value, text);
  if (value === null) return { ok: false, error: "shape_mismatch" };
  return { ok: true, value, ...(result.llmUsed === true ? { llmUsed: true } : {}) };
}

/**
 * Ask an evaluator to normalize a non-conforming end-of-turn response.
 *
 * **薄壳**（issue #406 B2-b）：内部转调 `normalizeWrapupText`，与引擎内联那条收尾归一化
 * 走同一个实现（同一份提示词 / 同一道闸门 / 同一个「思考恒关」）。保留本函数是因为它是
 * 公开导出 + 契约锚点 + 宿主在用；删除属 0.25.0 的 breaking 批次，不在本单。
 *
 * 对外签名与返回值一字未改：成功返回归一化后的信封，失败（归一化器的回答过不了形状门槛）
 * 返回 `null`；归一化器自己抛错照旧**抛出来**（不折进 `null`）。
 *
 * @param {string} text
 * @param {{chat?: (request: object) => Promise<object>}|((request: object) => Promise<object>)} evaluator
 * @param {{signal?: any, maxTokens?: number, temperature?: number}} [options]
 * @returns {Promise<{done: boolean, summary: string, output: string, findings?: Record<string, string>}|null>}
 */
export async function normalizeWrapupWithLlm(
  text,
  evaluator,
  { signal, maxTokens, temperature } = {},
) {
  const result = await normalizeWrapupText(text, {
    provider: evaluator,
    ...(signal === undefined ? {} : { signal }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
  });
  return result.ok === true ? result.value : null;
}
