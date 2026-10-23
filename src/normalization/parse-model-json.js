// @ts-check
/**
 * `normalizeModelJson` —— 模型输出归一化底座（issue #406，设计稿 §1 的 L0 + L1 + L2 + 闸门）。
 *
 * ## 与 `parseModelJson`（`src/text/parse-model-json.js`，issue #307）的分工
 *
 * 两个入口**不许合并成同一个函数**：一个同步、一个异步（`await` 老调用会拿到非 Promise 值，
 * 行为随入参漂移），结果形状也不同（那边是 `{ok, value, via, candidates}`，这边是
 * `{ok, value, repaired?, llmUsed?, dropped?, error?}`）。
 *
 * | 入口 | 层 | 同步性 | 修不修 | 发不发请求 |
 * |---|---|---|---|---|
 * | `parseModelJson` | L0 严格档 | 同步 | **绝不修** | 从不 |
 * | `normalizeModelJson`（本文件） | L1 保字节修复 + 闸门 + L2 兜底 | 异步 | 只修**结构字符**（复用 `src/text/repair-json.js`） | 只有 `llm:true` 且 L1 全败 |
 *
 * `parseModelJson` 那一面（#307 的包根导出、契约三态形状）本文件一个字都没动——B2-a 只新增，
 * 不改名、不撤件；改名属后续的契约破坏批次（B2-b / 公开面清理单）。
 *
 * ## 三态（名字沿用 #307，不新造）
 *
 * - `no_candidate`：没有任何候选可试。两档：**输入为空**（候选数为 0），或**截断**（结构未闭合——
 *   今天的 L0 对截断输入也报 `no_candidate`，本入口与它一字不差）。截断的判定**复用 L1 自己的
 *   `truncation` 规则**（规则会改文本 ⇒ 就是截断形状），不新写一个检测器。
 * - `unparsable`：有候选、每个都解析不出来。
 * - `shape_mismatch`：有候选解析成功，但一个都没过 `validate` 闸门。
 *
 * ## 候选（M6 的正解；D1：**复用 L0 的扫描，不复制**）
 *
 * 候选集 = **整段原文** + 按出现顺序的**每个 ``` 围栏块**（去围栏符）
 * + L0 的平衡对象扫描（`jsonCandidates`，`src/text/json-candidates.js`）扫出的**每个顶层平衡对象**。
 * 每个候选依次交给 `parseJsonWithRepair`（先 L0 的 `JSON.parse`，不行再按规则表修）→ 闸门，
 * **第一个「可解析 + 过闸门」者胜出**。
 *
 * 只加 `push(text)` + `fenceBodies(text)` 是不够的：新入口会比它声称包装的 L0 **更弱**（实测 9 种
 * 真实形状里 7 种 L0 `ok`、本入口 `unparsable`——`好的，结果如下：{"done":true}`、
 * `{"done":true} 以上是结果。`、`{"a":1}}extra{`、`前言 {"outer":{"done":true}} 后语`、`~~~json` 围栏……）。
 * 所以第三档直接调 L0 的 `jsonCandidates`，不另写扫描。
 *
 * `repair.truncateCompletion` 显式开时，
 * 再把每个候选的「补全版」当**额外**候选**追加在末尾**（整段原文的补全版在其中——截断输入的唯一出路；
 * 围栏里的截断也一并救得回来，因为模型最常写的就是围栏）。
 *
 * ## 承重墙：闸门永远对**候选的原始字节**判
 *
 * `validate(value, source)` 的第二个参数是该候选的**原始字节**（`source` 永远是原文切片，
 * **绝不是修后文本**）。写反的后果是静默丢值：`jsonrepair` 式修复把 `http\.request` 改成
 * `http.request`，拿修后文本判 `includes` 就放行一条原文里根本不存在的值。
 * 补全版候选同样受这条约束：它的 `original` 是**补全前**的原文，闸门拿到的就是它（`{"a":` ⇒
 * 闸门看到 `{"a":`，不是 `{"a":null}`）。`test/normalization/parse-model-json.test.js` 里有两格
 * **专门钉它写反就红**的变异级用例：宿主注入一条会改字节的修复规则（闸门必须把那条值判掉）、
 * 以及往补全规则里插一个**伪造字符串值**（`__FABRICATED__`，闸门必须判掉——那一档原先零测试看守）。
 *
 * ## `repaired` 与可信链（D6）
 *
 * 只有真的改了文本才出现 `repaired: {rule, trusted}`：`rule` 是**实际生效**的规则 id 按序用
 * `+` 连接（`applied.join("+")`，顺序即语义）；`trusted` 为 `true` 当且仅当生效的全是引擎自带
 * 规则——`repair.inject` 里宿主注入的修复器一律 `false`（我们替不了宿主证明它的保字节性）。
 *
 * ## L2（`llm:true` 是唯一开关）
 *
 * L1 全败才发请求；请求**恒定**带 `reasoning_effort`（`thinking:"none"` ⇒
 * `NORMALIZATION_REASONING_EFFORT`；`thinking:"inherit"` ⇒ 不发该字段），取值引用
 * `src/reflection/wrapup.js` 的常量而**不是**字面量。L2 的产物**仍过同一道 `validate` 闸门**：
 * 不过就是 `shape_mismatch`，不许静默接受。
 *
 * 零依赖：只用 `node:` 内建与相对路径。
 */

import { createProviderForSlot } from "../config/slot-provider.js";
import { exampleToolArguments } from "../messages/tool-arguments.js";
import { NORMALIZATION_REASONING_EFFORT } from "../reflection/wrapup.js";
import { jsonCandidates } from "../text/json-candidates.js";
import {
  DEFAULT_REPAIR_RULE_IDS,
  REPAIR_RULES,
  parseJsonWithRepair,
  repairJsonText,
} from "../text/repair-json.js";

/** 引擎自带规则的 id 全集（顺序与 `REPAIR_RULES` 一致）。 */
const ENGINE_RULE_IDS = Object.freeze(REPAIR_RULES.map((rule) => rule.id));
const ENGINE_RULE_ID_SET = new Set(ENGINE_RULE_IDS);

/**
 * 截断补全那条规则的 id。`src/text/repair-json.js` 只导出「默认开」「opt-in」两个 id 数组，
 * 没有给单条规则的名字；这里按规则表里的字面 id 取，且**只**用它做两件事：
 * 判定「截断形状」与生成额外候选（都通过 `repairJsonText({rules:[…]})` 走 B1 的实现）。
 */
const TRUNCATION_RULE_ID = "truncation";

/** `thinking` 的两个合法取值（`"none"` 恒定写进请求；`"inherit"` 不发该字段）。 */
const THINKING_NONE = "none";
const THINKING_INHERIT = "inherit";

/**
 * 闸门：`(value, source) => {ok, dropped?}`。
 *
 * `source` 是**该候选的原始字节**（原文切片，绝不是修后文本）——宿主拿它做
 * `source.includes(值)` 这类逐字核验。第二个参数是 additive 的：只写 `(value) => …` 的宿主
 * 照旧可用，但那样它就放弃了「证明值没被改写」的能力（契约里写清了这一点）。
 *
 * @typedef {(value: any, source: string) => {ok: boolean, dropped?: string[]}} ModelJsonGate
 */

/**
 * 归一化入口的返回面。
 *
 * `ok` 是 `boolean`（不是字面量判别联合）：本仓的 `--checkJs` 不带 `strict`，布尔字面量判别在那里
 * 不收窄，写成联合只会让调用点被迫加 `any` 转换（#213 记过这种静默退化）。
 *
 * @typedef {object} NormalizeModelJsonResult
 * @property {boolean} ok
 * @property {any} [value]
 * @property {{rule: string, trusted: boolean}} [repaired]
 * @property {true} [llmUsed]
 * @property {string[]} [dropped]
 * @property {"no_candidate"|"unparsable"|"shape_mismatch"} [error]
 */

/**
 * 一条修复器（与 `REPAIR_RULES` 同形，但 `defaultEnabled` 对宿主注入的规则没有意义）。
 *
 * @typedef {{id: string, apply: (text: string) => string}} InjectedRepairRule
 */

/**
 * @typedef {object} RepairOptions
 * @property {readonly string[]} rules 逐候选启用的**引擎自带**规则 id（顺序即语义）
 * @property {InjectedRepairRule[]} inject 宿主注入的修复器（在引擎规则**之前**跑）
 * @property {boolean} truncateCompletion 是否把「整段原文补全后」当额外候选追加在末尾
 */

/**
 * 候选结果：`hit` 带值，其余两档只说明「为什么没成」。
 *
 * @typedef {object} CandidateOutcome
 * @property {"hit"|"unparsable"|"rejected"} kind
 * @property {any} [value] `kind:"hit"` 时的解析结果（`JSON.parse` 的直接产物）
 * @property {string[]} [applied] 真的改了文本的规则 id（宿主注入的在前，引擎自带的在后）
 * @property {string[]} [dropped] 闸门放行时声明丢掉的条目（原样透传）
 * @property {{message?: string, position?: number}} [failure] 解析失败的原话与位置（L2 提示词用）
 */

/**
 * 剥出每个 ``` 围栏块的**块体**（去掉围栏行本身）。
 *
 * 与 `src/text/repair-json.js` 的 `code-fence` 规则分工不同：那条规则只认「整段就是一段围栏」，
 * 这里认「一段文本里夹着的每一段围栏」。未闭合的围栏不产候选（半截围栏不是候选，是截断，
 * 由 `truncateCompletion` 那一档负责）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function fenceBodies(text) {
  /** @type {string[]} */
  const bodies = [];
  /** @type {string[]|null} */
  let current = null;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}```/.test(line)) {
      if (current === null) {
        current = [];
        continue;
      }
      bodies.push(current.join("\n"));
      current = null;
      continue;
    }
    if (current !== null) current.push(line);
  }
  return bodies;
}

/**
 * 「截断形状」判定：L1 的 `truncation` 规则会不会改这段文本。
 *
 * 为什么用规则本身当检测器：截断的定义（未闭合括号 / 未收尾字符串）与补全动作是同一件事，
 * 分两处写必然漂移。`completeTruncatedJson` 在「补完仍然解析不了」时原样返回，所以
 * 「改了」=「补得出来」，正是我们要的那一档。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isTruncationShaped(text) {
  return repairJsonText(text, { rules: [TRUNCATION_RULE_ID] }).text !== text;
}

/**
 * 一个候选：文本 + 它是不是「补全版」。
 *
 * `completed` 这个位不是装饰：补全发生在**候选生成**这一步（不在逐候选规则里），所以
 * `repaired` 的 provenance 必须由这里带下去，否则「这条值来自截断补全」会被记成「没修过」——
 * 那正是最危险的一类静默。
 *
 * @typedef {object} Candidate
 * @property {string} text
 * @property {boolean} completed
 * @property {string} original 闸门看到的**原文**（补全前；非补全候选就是 `text` 本身）
 */

/**
 * 候选集：整段原文 + 每个围栏块体 + L0 扫出的每个顶层平衡对象
 * + （可选）每个候选的补全版（追加在末尾）。
 *
 * 补全版只加在**末尾**，不挤占原候选的位置：本来就完整的输入仍然由原候选胜出，
 * `repaired` 里也不会凭空出现 `truncation`。
 *
 * @param {string} text
 * @param {RepairOptions} repairOptions
 * @returns {Candidate[]}
 */
function candidatesFor(text, repairOptions) {
  /** @type {Candidate[]} */
  const base = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const push = (value, completed, original = value) => {
    if (value.trim() === "" || seen.has(value)) return;
    seen.add(value);
    base.push({ text: value, completed, original });
  };
  push(text, false);
  for (const body of fenceBodies(text)) push(body, false);
  // D1：候选生成**调 L0 的扫描**（`jsonCandidates`），不复制一份扫描实现。
  for (const object of jsonCandidates(text)) push(object, false);
  if (!repairOptions.truncateCompletion) return base;

  const candidates = [...base];
  for (const candidate of base) {
    const completed = repairJsonText(candidate.text, { rules: [TRUNCATION_RULE_ID] }).text;
    if (completed === candidate.text || completed.trim() === "" || seen.has(completed)) continue;
    seen.add(completed);
    candidates.push({ text: completed, completed: true, original: candidate.text });
  }
  return candidates;
}

/**
 * 校验并规范化 `repair` 选项。
 *
 * 未知规则 id **直接抛**（不静默忽略）：`repair.rules` 里打错一个字，症状会是「修复静默失效」，
 * 而那种症状只在真上游上现形——这是本仓反复交学费的那一类坑。
 *
 * @param {any} repair
 * @returns {RepairOptions}
 */
function normalizeRepair(repair) {
  const options = repair === undefined || repair === null ? {} : repair;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("normalizeModelJson: repair 必须是对象");
  }

  const rules = options.rules === undefined ? DEFAULT_REPAIR_RULE_IDS : options.rules;
  if (!Array.isArray(rules)) throw new TypeError("normalizeModelJson: repair.rules 必须是规则 id 数组");
  for (const id of rules) {
    if (typeof id !== "string" || !ENGINE_RULE_ID_SET.has(id)) {
      throw new TypeError(
        `normalizeModelJson: repair.rules 里有未知规则 id ${JSON.stringify(id)}`
        + `（可选：${ENGINE_RULE_IDS.join(" | ")}）`,
      );
    }
  }

  const inject = options.inject === undefined ? [] : options.inject;
  if (!Array.isArray(inject)) throw new TypeError("normalizeModelJson: repair.inject 必须是规则数组");
  /** @type {InjectedRepairRule[]} */
  const normalized = [];
  const seen = new Set();
  for (const [index, rule] of inject.entries()) {
    const id = typeof rule?.id === "string" && rule.id !== "" ? rule.id : `inject#${index}`;
    if (ENGINE_RULE_ID_SET.has(id) || seen.has(id)) {
      throw new TypeError(`normalizeModelJson: repair.inject 的规则 id 冲突：${JSON.stringify(id)}`);
    }
    if (typeof rule?.apply !== "function") {
      throw new TypeError(`normalizeModelJson: repair.inject 的规则 ${JSON.stringify(id)} 必须带 apply(text)`);
    }
    seen.add(id);
    normalized.push({ id, apply: rule.apply });
  }

  return {
    rules: [...rules],
    inject: normalized,
    truncateCompletion: options.truncateCompletion === true,
  };
}

/**
 * 单候选：宿主注入的修复器 → L0/L1（B1 的 `parseJsonWithRepair`）→ 闸门。
 *
 * 闸门的 `source` 传的是 `candidate.original`（**这个候选补全前的原始字节**），不是 `text`（修后 / 补全后的文本）。
 *
 * @param {Candidate} candidate
 * @param {{gate: ModelJsonGate, repairOptions: RepairOptions}} context
 * @returns {CandidateOutcome}
 */
function attemptCandidate(candidate, { gate, repairOptions }) {
  let text = candidate.text;
  /** @type {string[]} */
  const injected = [];
  for (const rule of repairOptions.inject) {
    const next = rule.apply(text);
    if (typeof next !== "string") {
      throw new TypeError(`normalizeModelJson: repair.inject 的规则 ${rule.id} 必须返回字符串`);
    }
    if (next !== text) {
      injected.push(rule.id);
      text = next;
    }
  }

  const parsed = parseJsonWithRepair(text, { rules: repairOptions.rules });
  if (!parsed.ok) {
    const failure = parsed.error;
    return {
      kind: "unparsable",
      applied: injected,
      ...(failure === undefined ? {} : { failure: { message: failure.message, ...(failure.position === undefined ? {} : { position: failure.position }) } }),
    };
  }

  const applied = [
    ...(candidate.completed ? [TRUNCATION_RULE_ID] : []),
    ...injected,
    ...parsed.applied,
  ];
  const verdict = gate(parsed.value, candidate.original);
  if (verdict === null || typeof verdict !== "object" || typeof verdict.ok !== "boolean") {
    throw new TypeError("normalizeModelJson: validate 必须返回 { ok: boolean, dropped?: string[] }");
  }
  if (verdict.ok !== true) return { kind: "rejected", applied };
  return {
    kind: "hit",
    value: parsed.value,
    applied,
    ...(Array.isArray(verdict.dropped) ? { dropped: verdict.dropped } : {}),
  };
}

/**
 * 逐候选跑一遍，返回第一个命中者与「是否见过解析成功但被闸门拒的候选」。
 *
 * @param {Candidate[]} candidates
 * @param {{gate: ModelJsonGate, repairOptions: RepairOptions}} context
 * @returns {{hit?: CandidateOutcome, sawRejected: boolean, failure?: {message?: string, position?: number}}}
 */
function runCandidates(candidates, context) {
  let sawRejected = false;
  /** @type {{message?: string, position?: number}|undefined} */
  let failure;
  for (const candidate of candidates) {
    const outcome = attemptCandidate(candidate, context);
    if (outcome.kind === "hit") return { hit: outcome, sawRejected, ...(failure === undefined ? {} : { failure }) };
    if (outcome.kind === "rejected") sawRejected = true;
    else if (failure === undefined) failure = outcome.failure;
  }
  return { sawRejected, ...(failure === undefined ? {} : { failure }) };
}

/**
 * `repaired` 事实：没改文本就没有这个键；`trusted` 只认引擎自带规则（D6）。
 *
 * @param {string[]|undefined} applied
 * @returns {{rule: string, trusted: boolean}|undefined}
 */
function repairedFact(applied) {
  if (applied === undefined || applied.length === 0) return undefined;
  return {
    rule: applied.join("+"),
    trusted: applied.every((id) => ENGINE_RULE_ID_SET.has(id)),
  };
}

/**
 * 命中结果。
 *
 * @param {CandidateOutcome} hit
 * @param {boolean} llmUsed
 * @returns {NormalizeModelJsonResult}
 */
function hitResult(hit, llmUsed) {
  const repaired = repairedFact(hit.applied);
  return {
    ok: true,
    value: hit.value,
    ...(repaired === undefined ? {} : { repaired }),
    ...(llmUsed ? { llmUsed: true } : {}),
    ...(hit.dropped === undefined ? {} : { dropped: hit.dropped }),
  };
}

/**
 * 失败结果：**不带 `value` 键**（与 #307 同一条纪律：`if (!result.ok)` 之后手里什么都没有）。
 *
 * @param {{sawRejected: boolean}} outcome
 * @param {Candidate[]} candidates
 * @param {RepairOptions} repairOptions
 * @param {boolean} llmUsed
 * @returns {NormalizeModelJsonResult}
 */
function missResult(outcome, candidates, repairOptions, llmUsed) {
  /** @type {"no_candidate"|"unparsable"|"shape_mismatch"} */
  let error;
  if (candidates.length === 0) {
    error = "no_candidate";
  } else if (outcome.sawRejected) {
    error = "shape_mismatch";
  } else if (!repairOptions.truncateCompletion && candidates.every((candidate) => isTruncationShaped(candidate.text))) {
    // 截断输入：今天 L0 的观察面就是 `no_candidate`（"什么都不产，也不补括号"），本入口不偷偷改口径。
    error = "no_candidate";
  } else {
    error = "unparsable";
  }
  return { ok: false, error, ...(llmUsed ? { llmUsed: true } : {}) };
}

/**
 * 解析 L2 的 chat 入口：`provider`（`{chat}` 或函数）与 `slot` 二选一。
 *
 * @param {{provider?: any, slot?: any}} input
 * @returns {(request: Record<string, any>) => Promise<any>}
 */
function resolveChat({ provider, slot }) {
  if (provider !== undefined && slot !== undefined) {
    throw new TypeError("normalizeModelJson: provider 与 slot 只能给一个");
  }
  const target = provider === undefined
    ? (slot === undefined ? undefined : createProviderForSlot(slot))
    : provider;
  if (target === undefined) {
    throw new TypeError("normalizeModelJson: llm:true 需要 provider 或 slot（L2 的唯一开关就是 llm）");
  }
  if (typeof target === "function") return (request) => target(request);
  if (typeof target.chat === "function") return (request) => target.chat(request);
  throw new TypeError("normalizeModelJson: provider 必须是 { chat(request) } 或一个函数");
}

/**
 * L2 请求：原文 + 解析器判词 +（可选）正确形状示例。
 *
 * 「正确形状示例」只有一份来源：`exampleToolArguments`（`src/messages/tool-arguments.js`，
 * issue #409 落地）——与送回模型的解析器判词共用同一个示例器，不新增第二个。
 * 没有 schema 时**整行省略**，绝不编造形状。
 *
 * @param {{text: string, schema?: any, thinking: string, maxTokens?: number, signal?: any, failure?: {message?: string, position?: number}}} input
 * @returns {Record<string, any>}
 */
function buildL2Request({ text, schema, thinking, maxTokens, signal, failure }) {
  const lines = [
    "把下面模型的原始文本归一化为一个 JSON 值。",
    "只输出 JSON：不要散文、不要代码围栏、不要解释。",
    "只许搬运：每个字符串值必须逐字摘自原文（原样复制，不得改写、规整、补全或翻译）；"
    + "原文里抄不到的值就省略该条，宁可少写。",
  ];
  if (schema !== undefined) lines.push(`正确形状示例：${exampleToolArguments(schema)}`);
  if (typeof failure?.message === "string" && failure.message !== "") {
    lines.push(`上一版解析失败的原因：${failure.message}`);
  }
  lines.push("", "原始文本：", text);

  /** @type {Record<string, any>} */
  const request = {
    system: "你是输出协议归一化器，只输出有效 JSON。",
    messages: [{ role: "user", content: [{ type: "text", text: lines.join("\n") }] }],
  };
  // issue #419 ① / #406 §3：归一化只输出一段 JSON ⇒ **恒定不思考**。取值引用
  // `src/reflection/wrapup.js` 的 `NORMALIZATION_REASONING_EFFORT`（唯一字面量），不在这里再写一遍。
  if (thinking !== THINKING_INHERIT) request.reasoning_effort = NORMALIZATION_REASONING_EFFORT;
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  if (signal !== undefined) request.signal = signal;
  return request;
}

/**
 * 从 canonical 响应里取正文（与 `src/reflection/wrapup.js` 的 `textFromBlocks` 同口径）。
 *
 * @param {any} response
 * @returns {string}
 */
function textFromResponse(response) {
  if (typeof response === "string") return response;
  const content = response?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

/**
 * 模型输出归一化入口（issue #406；包根导出名 `normalizeModelJson`）。
 *
 * @param {string} rawText 模型输出的原始文本（`null` / `undefined` 当空串处理）
 * @param {{
 *   validate?: ModelJsonGate,
 *   provider?: any,
 *   slot?: Record<string, any>,
 *   llm?: boolean,
 *   thinking?: "none" | "inherit",
 *   maxTokens?: number,
 *   signal?: any,
 *   repair?: {rules?: readonly string[], inject?: InjectedRepairRule[], truncateCompletion?: boolean},
 *   schema?: any,
 * }} [options]
 * @returns {Promise<NormalizeModelJsonResult>}
 */
export async function normalizeModelJson(rawText, options = {}) {
  const settings = options === null || options === undefined ? {} : options;
  if (typeof settings !== "object" || Array.isArray(settings)) {
    throw new TypeError("normalizeModelJson: options 必须是对象");
  }
  const {
    validate,
    provider,
    slot,
    llm = false,
    thinking = THINKING_NONE,
    maxTokens,
    signal,
    repair,
    schema,
  } = settings;

  if (thinking !== THINKING_NONE && thinking !== THINKING_INHERIT) {
    throw new TypeError(
      `normalizeModelJson: thinking 只接受 ${JSON.stringify(THINKING_NONE)} 或 ${JSON.stringify(THINKING_INHERIT)}`
      + `（收到 ${JSON.stringify(thinking)}）；"none" 恒定写进请求，"inherit" 表示不发该字段`,
    );
  }
  if (validate !== undefined && typeof validate !== "function") {
    throw new TypeError("normalizeModelJson: validate 必须是函数 (value, source) => { ok, dropped? }");
  }

  /** @type {ModelJsonGate} */
  const gate = validate === undefined ? () => ({ ok: true }) : validate;
  const repairOptions = normalizeRepair(repair);
  const text = typeof rawText === "string" ? rawText : String(rawText ?? "");
  const context = { gate, repairOptions };
  const candidates = candidatesFor(text, repairOptions);

  const first = runCandidates(candidates, context);
  if (first.hit !== undefined) return hitResult(first.hit, false);

  if (llm === true) {
    const chat = resolveChat({ provider, slot });
    const request = buildL2Request({
      text,
      ...(schema === undefined ? {} : { schema }),
      thinking,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(signal === undefined ? {} : { signal }),
      ...(first.failure === undefined ? {} : { failure: first.failure }),
    });
    const response = await chat(request);
    const l2Candidates = candidatesFor(textFromResponse(response), repairOptions);
    const second = runCandidates(l2Candidates, context);
    if (second.hit !== undefined) return hitResult(second.hit, true);
    return missResult(second, l2Candidates, repairOptions, true);
  }

  return missResult(first, candidates, repairOptions, false);
}
