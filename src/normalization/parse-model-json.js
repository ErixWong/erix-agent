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
 * | `normalizeModelJson`（本文件） | L1 保字节修复 + 闸门 + L2 兜底 | 异步 | 只修**结构字符**（复用 `src/text/repair-json.js`） | 只有 `llm:true` 且候选非空、L1 全败 |
 *
 * `parseModelJson` 那一面（#307 的包根导出、契约三态形状）本文件一个字都没动——B2-a 只新增，
 * 不改名、不撤件；改名属后续的契约破坏批次（B2-b / 公开面清理单）。
 *
 * ## 三态（名字沿用 #307，不新造）
 *
 * - `no_candidate`：没有任何候选可试。两档：**输入为空**（候选数为 0），或**截断**（结构未闭合）。
 *   截断的判定**复用 L1 自己的 `truncation` 规则**（补全规则会改这段文本 ⇒ 就是截断形状），不新写
 *   一个检测器；判据是「**任一**候选是截断形状」（多候选时按**存在**算，不是按「全都」算——
 *   `说明\n```json\n{"a":1\n``` ` 这种形状里整段原文补不出来、围栏块体补得出来，答案必须是 L0 的
 *   `no_candidate`，不是 `unparsable`）。与 L0 的一致面与**已知差异面**见契约，两处差异都是**类**：
 *   ① L0 靠「括号不配对 ⇒ 零候选」认出的**补全规则修不动的截断**在这里是 `unparsable`——候选集里
 *   没有一段能被补全规则改写的片段（扫描器是 L0 那份，不复制）。这是一**类**形状，不是单个特例：
 *   片段前/后夹散文（`前言 {"a":1`、`{"a":1 以上是结果。`）、片段不是对象（`前言 [1,2`）、
 *   围栏内截断之后又夹散文、以及值里带**裸换行**的截断工具引数串（补全得先修非法字符）。
 *   ② **顶层非对象**：`[1,2]` / `123` / `"hello"` / `null` 在这里是 `ok`（值就是它），在 L0 是
 *   `no_candidate`（L0 只可能返回对象）。
 * - `unparsable`：有候选、每个都解析不出来。
 * - `shape_mismatch`：有候选解析成功，但一个都没过 `validate` 闸门。
 *
 * 这三档只回答「有没有可用的 JSON」。第四档 `truncated`（issue #637）只在 L2 出现，回答的是「为什么
 * 没有」——详见下方「第四档」一节。
 *
 * ## 候选（M6 的正解；D1：**复用 L0 的扫描，不复制**）
 *
 * 候选集 = **整段原文** + 按出现顺序的**每个 ``` 围栏块**（去围栏符，**含未闭合围栏剩下的那段块体**）
 * + L0 的平衡对象扫描（`jsonCandidates`，`src/text/json-candidates.js`）扫出的**每个顶层平衡对象**。
 * 每个候选依次交给 `parseJsonWithRepair`（先 L0 的 `JSON.parse`，不行再按规则表修）→ 闸门，
 * **第一个「可解析 + 过闸门」者胜出**。
 *
 * 只加 `push(text)` + `fenceBodies(text)` 是不够的：新入口会比它声称包装的 L0 **更弱**——测试文件
 * `L0_SCAN_ONLY_SHAPES` 表里每个形状都是「整段原文与每一个围栏块体都解析不了」，唯一能胜出的候选
 * 只能来自 L0 的扫描（`好的，结果如下：{"done":true}`、`{"done":true} 以上是结果。`、
 * `{"a":1}}extra{`、`前言 {"outer":{"done":true}} 后语`、`~~~json` 围栏）。所以第三档直接调 L0 的
 * `jsonCandidates`，不另写扫描。**顺序也是语义**：围栏块排在 L0 扫描之前，所以更晚出现的围栏对象会
 * **压过**文本里更早的顶层对象（`{"a":1}` + 装着 `{"b":2}` 的围栏 ⇒ 本入口 `{"b":2}`、L0 `{"a":1}`）。
 *
 * `repair.truncateCompletion` 显式开时，再把每个候选的「补全版」当**额外**候选**追加在末尾**。
 * 补全**与规则表串联**（先跑本档启用的规则，`truncation` 是规则表最后一条），因此救得回：
 *   纯截断（`{"a":1`）、**围栏里的截断**（含**未闭合围栏**：`说明\n```json\n{"a":1`）、
 *   截断 + 结构类缺陷（`{"a":"x\\.y"` ⇒ `invalid-escape` 先加倍、再补 `}`）。
 * 救不回的：**补全规则修不动的截断**（一类，不是单个形状）——片段前/后夹散文、片段不是对象、
 * 字符串里带裸换行（补全得先修非法字符）……补全要求「补完即可 `JSON.parse`」，规则表改不动它们。
 * 这句是实测边界，不是承诺。
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
 * L1 全败**且候选非空**才发请求——候选为空（空输入 / 纯空白）时一次请求都不发：没有原文可交给
 * 模型，发出去只是白烧一次（每次调用最多 1 个请求、无重试，见契约的成本一节）。请求**恒定**带
 * `reasoning_effort`（`thinking:"none"` ⇒
 * `NORMALIZATION_REASONING_EFFORT`；`thinking:"inherit"` ⇒ 不发该字段），取值引用
 * `src/reflection/wrapup.js` 的常量而**不是**字面量。L2 的产物**仍过同一道 `validate` 闸门**：
 * 不过就是 `shape_mismatch`，不许静默接受。
 *
 * ## 第四档：`truncated`（issue #637）
 *
 * 前三档只回答「这段文本里有没有可用的 JSON」，**回答不了「为什么没有」**。而「预算给小了」与
 * 「模型在胡说」是两种病因、两种处置：前者该加 `maxTokens` 或把输出契约与输入解耦（#419 的真机形状
 * 就是这个：输出要求回显原文 ⇒ 输出长度 ≈ 输入长度 ⇒ `maxTokens:120` 下结构上必然截断），后者才该
 * 放弃兜底。所以 L2 的 `stopReason` **不许就地丢弃**：上游明说被 token 上限截断
 * （`max_tokens` / `length`）而回答又没产出可用的值时，结局是 `{ok:false, error:"truncated",
 * stopReason, llmUsed:true}`，不是 `unparsable` / `no_candidate`。
 *
 * 两条优先级是**语义**、不是实现细节：
 *   ① **命中优先**——解析成功且过闸门就是值，`ok:true` 永远先返回（`stopReason` 截断不改变一个已经
 *      拿到的值）；
 *   ② **`shape_mismatch` 优先**——解析成功却过不了 `validate`，那是「形状不对」，加预算解释不了它，
 *      所以截断只升级「一个 JSON 值都没产出」的那两档（`no_candidate` / `unparsable`）。
 * 截断时**不重发请求去猜缺失的字节**（成本一节：每次调用最多 1 个请求、绝不重试），宿主自己决定加
 * 预算还是换契约。取不到 `stopReason`（纯字符串响应 / 宿主没给）⇒ **不声称**截断：不知道就是不知道，
 * 前三档照旧。
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
 * 「被 token 上限截断」的两个拼写（issue #637）：canonical 的 `max_tokens`（OpenAI 的
 * `finish_reason:"length"` 经 `normalizeOpenAIStopReason` 映射后的形态）与**原始** OpenAI 响应里的
 * `length`。只认这两个：别的取值（`end_turn` / `tool_use` / `stop_sequence` / `refusal`…）都表示
 * 模型**说完了**，回答里的毛病属于「垃圾」那一档，不许冒充截断。
 */
const TRUNCATING_STOP_REASONS = Object.freeze(["max_tokens", "length"]);

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
 * @property {"no_candidate"|"unparsable"|"shape_mismatch"|"truncated"} [error]
 * @property {string} [stopReason] L2 响应里的原始 stop reason，**只在 `error:"truncated"` 时出现**（issue #637）
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
 * @property {boolean} truncateCompletion 是否把每个候选的「补全版」（串联规则表）当额外候选追加在末尾
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
 * 这里认「一段文本里夹着的每一段围栏」。**未闭合的围栏照样产候选**：剩下那段就是模型写到
 * 一半的块体（模型最常写的形态就是围栏），它是不是「截断」由三态判据自己算，不在这里先
 * 替它下定论——否则「围栏里的截断也救得回来」就成了空话。
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
  if (current !== null) bodies.push(current.join("\n"));
  return bodies;
}

/**
 * 本档实际要跑的规则链：启用的规则 + `truncation`（表序即语义，`truncation` 永远是最后一条）。
 *
 * 「截断形状」的判定与「补全版候选」的生成共用这一条链——两处各写一份必然漂移。
 *
 * @param {RepairOptions} repairOptions
 * @returns {string[]}
 */
function completionChain(repairOptions) {
  return [...repairOptions.rules.filter((id) => id !== TRUNCATION_RULE_ID), TRUNCATION_RULE_ID];
}

/**
 * 「截断形状」判定：把规则链（含 `truncation`）跑一遍，补全那一步会不会改这段文本。
 *
 * 为什么用规则本身当检测器：截断的定义（未闭合括号 / 未收尾字符串）与补全动作是同一件事，
 * 分两处写必然漂移。`completeTruncatedJson` 在「补完仍然解析不了」时原样返回，所以
 * 「改了」=「补得出来」，正是我们要的那一档。
 *
 * 串上其它规则（而不是只跑 `truncation`）是必要的：`{"a":"x\\.y"` 这种「截断 + 非法转义」的
 * 形状，单跑补全永远补不出来（补完仍解析不了），而 `invalid-escape` 先把转义加倍之后就能补。
 *
 * @param {string} text
 * @param {RepairOptions} repairOptions
 * @returns {boolean}
 */
function isTruncationShaped(text, repairOptions) {
  return repairJsonText(text, { rules: completionChain(repairOptions) }).applied.includes(TRUNCATION_RULE_ID);
}

/**
 * 一个候选：交给 L1 的文本 + **闸门该看到的原文** + 补全那一步真的做了什么。
 *
 * `completionApplied` 不是装饰：补全发生在**候选生成**这一步（不在逐候选规则里），所以
 * `repaired` 的 provenance 必须由这里带下去，否则「这条值来自截断补全」会被记成「没修过」——
 * 那正是最危险的一类静默。`original` 则是同一件事的另一面：补全后的文本里可能有**原文没有的字节**
 * （`{"a":` ⇒ `{"a":null}`），闸门必须拿补全**前**的原文判。
 *
 * @typedef {object} Candidate
 * @property {string} text 交给 `parseJsonWithRepair` 的文本（补全档里是补全后的）
 * @property {string} original 闸门看到的**原文**（补全前；非补全候选就是 `text` 本身）
 * @property {string[]} completionApplied 补全这一步实际生效的规则 id（含 `truncation`；非补全候选为空）
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
  const candidates = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /**
   * @param {string} value
   * @param {string} [original]
   * @param {string[]} [completionApplied]
   */
  const push = (value, original = value, completionApplied = []) => {
    if (value.trim() === "" || seen.has(value)) return;
    seen.add(value);
    candidates.push({ text: value, original, completionApplied });
  };

  push(text);
  for (const body of fenceBodies(text)) push(body);
  // D1：候选生成**调 L0 的扫描**（`jsonCandidates`），不复制一份扫描实现。
  for (const object of jsonCandidates(text)) push(object);
  if (!repairOptions.truncateCompletion) return candidates;

  const chain = completionChain(repairOptions);
  for (const candidate of [...candidates]) {
    const completed = repairJsonText(candidate.text, { rules: chain });
    // 补全那一步没生效 ⇒ 这不是「补全版」，不追加（否则 `repaired` 会凭空多出 `truncation`）。
    if (!completed.applied.includes(TRUNCATION_RULE_ID)) continue;
    if (completed.text.trim() === "" || seen.has(completed.text)) continue;
    push(completed.text, candidate.original, completed.applied);
    // 补全之后才露出平衡对象的形状（散文前缀 + 截断）：照样只认 L0 的扫描，闸门仍看补全前原文。
    for (const object of jsonCandidates(completed.text)) {
      push(object, candidate.original, completed.applied);
    }
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
    ...candidate.completionApplied,
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
  } else if (candidates.some((candidate) => isTruncationShaped(candidate.text, repairOptions))) {
    // 截断输入：L0 的观察面就是 `no_candidate`（“什么都不产，也不补括号”），本入口不偷偷改口径。
    // 判据是**任一**候选是截断形状，不是「全都」：多候选时 `every` 会把
    // `说明\n```json\n{"a":1\n``` `（整段原文补不出、围栏块体补得出）报成 `unparsable`。
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
 * 从响应里取 stop reason（issue #637：以前这条信息在 `textFromResponse` 里被就地丢弃）。
 *
 * 三个拼写都认，canonical 优先：`stopReason`（`ChatResponse` 的字段，`src/messages/canonical.js`）、
 * Anthropic 原始的 `stop_reason`、OpenAI 原始的 `finish_reason`。后两个是**宽容**而不是契约：宿主直接
 * 把原始响应交给 `provider.chat` 时照样能判别截断（`src/compact/provider-summarizer.js` 有同样的先例）。
 * 取不到（字符串响应、字段缺失、非字符串、空串）⇒ `undefined`＝「不知道」，而「不知道」不许被读成
 * 「没截断」以外的任何结论：本函数的返回值只用来决定**要不要声称**截断。
 *
 * @param {any} response
 * @returns {string|undefined}
 */
function stopReasonOf(response) {
  if (response === null || typeof response !== "object") return undefined;
  const raw = response.stopReason ?? response.stop_reason ?? response.finish_reason;
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * 这个 stop reason 是不是「被 token 上限截断」。
 *
 * @param {unknown} reason
 * @returns {reason is string}
 */
function isTruncatingStopReason(reason) {
  return typeof reason === "string" && TRUNCATING_STOP_REASONS.includes(reason);
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

  // 候选为空（空输入 / 纯空白）⇒ 一次请求都不发：没有原文可交给模型，发出去只是白烧一次。
  if (candidates.length === 0) return missResult(first, candidates, repairOptions, false);

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
    const stopReason = stopReasonOf(response);
    const l2Candidates = candidatesFor(textFromResponse(response), repairOptions);
    const second = runCandidates(l2Candidates, context);
    if (second.hit !== undefined) return hitResult(second.hit, true);
    // issue #637：命中优先于截断判别（拿到值就是值）；`shape_mismatch` 也优先——解析成功却过不了闸门
    // 是「形状不对」，加预算解释不了它。截断只升级「一个 JSON 值都没产出」的那两档。
    if (isTruncatingStopReason(stopReason) && !second.sawRejected) {
      return { ok: false, error: "truncated", stopReason, llmUsed: true };
    }
    return missResult(second, l2Candidates, repairOptions, true);
  }

  return missResult(first, candidates, repairOptions, false);
}
