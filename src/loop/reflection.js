import { numberOr } from "./budget.js";
import { parseModelJson } from "../text/parse-model-json.js";

export const WRAPUP_INSTRUCTION = `任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：
{"done":true,"summary":"任务总结","output":"给用户的结果"}
若任务尚未完成但需要阶段性说明，可输出 {"done":false,"summary":"当前进展"}。
继续工作时直接调用工具。`;

export const DEFAULT_REFLECTION_MIN_ROUNDS = 16;

/**
 * Confidence threshold for a judge verdict that counts as "the goal looks achieved"
 * (issue #322: it used to be an inline `0.7` written twice inside the orchestrator).
 *
 * One constant feeds three decisions, so no site may write a literal again:
 *   - the `judge_done` stop gate in the orchestrator (the `action` computation on an end-turn round);
 *   - the `emitJudge` `action` classification (`judge_done` / `nudge` / `continue`);
 *   - the advisory gate in `judgeDoneAdvisoryText()`'s caller (`reflection.judgeDoneAdvisory`).
 * The value itself is unchanged: this ticket only collapses two literals into one truth, and the
 * judgement semantics stay byte-for-byte identical.
 */
export const JUDGE_DONE_CONFIDENCE_THRESHOLD = 0.7;

/** Truncation width for the `reason` inside a done-advisory (issue #322, first of two caps). */
export const JUDGE_DONE_ADVISORY_REASON_LIMIT = 200;
/** Cap for the whole done-advisory line (issue #322: one opinion must never push the context out). */
export const JUDGE_DONE_ADVISORY_LIMIT = 400;

/**
 * The **soft advisory** fed back to the main model when an interception audit says "goal achieved"
 * (issue #322).
 *
 * It is an opinion, never a verdict, so the text must state three things at once:
 *   1. this is the evaluator's judgement and it is **not independently verified** by the engine
 *      (the words "已核验/已验证" are forbidden here on purpose);
 *   2. if the requirement really is met, write the delivery summary and **do not add new work**;
 *   3. if something is missing, **only fill in the necessary items** — finishing leftover work is a
 *      legitimate state, nothing here stops the run early.
 * `reason` is cut to `JUDGE_DONE_ADVISORY_REASON_LIMIT`, the whole line to `JUDGE_DONE_ADVISORY_LIMIT`.
 *
 * @param {unknown} reason the judge's own reason (optional; omitted when absent)
 * @returns {string}
 */
export function judgeDoneAdvisoryText(reason) {
  const detail = String(reason ?? "").trim().slice(0, JUDGE_DONE_ADVISORY_REASON_LIMIT);
  const body = "评审认为本任务可能已达成原始目标——这是评审的主观判断，引擎未独立核验，"
    + "请对照用户最初的要求自行确认；若确已满足，只需给出交付总结，不要新增工作；"
    + "若仍有缺项，只补齐必要项后即可。"
    + (detail ? `（评审理由：${detail}）` : "");
  return `（附评审意见：${body}）`.slice(0, JUDGE_DONE_ADVISORY_LIMIT);
}

export function isLikelyWelcomeResponse(text) {
  const value = String(text ?? "").trim();
  return /^(?:你好|嗨|hello)\s*[!！,，。.]?\s*(?:我是|i\s*(?:am|'m))[\s\S]*(?:助手|assistant)/iu.test(value)
    || /(?:看起来|好像|似乎)[\s\S]{0,40}(?:没有|未)[\s\S]{0,20}(?:输入|收到)[\s\S]{0,20}(?:具体)?(?:任务|task)/iu.test(value)
    || /请[\s\S]{0,10}(?:告诉|输入|描述)[\s\S]{0,10}(?:我)?[\s\S]{0,20}(?:做什么|任务|task)/iu.test(value);
}

/** Fallback body of the neutral `uncertain` hint when the judge gave no `directionReason` (issue #322). */
const UNCERTAIN_HINT_FALLBACK = "评审未判定方向，也未判定已达成";

/**
 * The engine's direction-hint text for an audit decision (issue #322).
 *
 * `uncertainNeutral` (ticket ruling B): an `uncertain` verdict used to produce **no text at all**,
 * so emitting the neutral wording unconditionally would silently change the request sequence of
 * hosts that never opted into anything new. It is therefore gated on the same sub-key as the done
 * advisory (`reflection.judgeDoneAdvisory`): off ⇒ `uncertain` keeps returning the empty string,
 * byte-for-byte like before; on ⇒ it gets a neutral wording instead of the `off_track` phrasing
 * ("当前路线可能偏，可考虑换思路"), which reads like an invitation to try another route. The
 * `off_track` text, the `on_track` empty string, the interception rules and the extension logic are
 * untouched either way — only this wording, and only behind the switch.
 *
 * @param {unknown} direction
 * @param {unknown} directionReason
 * @param {boolean} [uncertainNeutral] emit the neutral `uncertain` wording (default off)
 * @returns {string}
 */
export function directionHintText(direction, directionReason, uncertainNeutral = false) {
  const reason = typeof directionReason === "string" && directionReason.trim()
    ? directionReason.trim().slice(0, 200)
    : "";
  if (direction === "uncertain") {
    return uncertainNeutral
      ? `（附方向提示：${reason || UNCERTAIN_HINT_FALLBACK} —— 评审未判定当前路线偏离，无需为此换思路；按你的判断继续。）`
      : "";
  }
  if (direction !== "off_track") return "";
  return `（附方向提示：${reason || "当前路线可能偏"} —— 当前路线可能偏，可考虑换思路/方法）`;
}

const REFLECTION_DECISION_KEYS = [
  "progress", "stalled", "continue", "stallPattern", "reason", "plan",
];

/**
 * reflection 决策对象（issue #305 起带 `via` 来源标记）。
 *
 * `via` 是**字面量联合**而不是 `string`：宿主拿到的是可收窄的两个取值，
 * `"json"` = 值来自可解析的顶层对象、`"prose_fallback"` = 值来自关键词兜底。
 * 它只声明来源，**不**暗示 schema 已校验（六字段全部可缺省带默认）。
 * 注（#213 记录的两个静默退化成 any 的形状）：本注释紧贴自己的 typedef 声明，
 * 且类型字面量里没有夹独立 `//` 行。
 *
 * @typedef {object} ReflectionDecision
 * @property {number | undefined} progress 有限数；模型没写或不是有限数时 undefined
 * @property {boolean} stalled 只有字面 `stalled: true` 才是 true
 * @property {boolean} continueFlag 只有字面 `continue: true` 才是 true
 * @property {string} stallPattern
 * @property {string} reason
 * @property {string} plan
 * @property {"json" | "prose_fallback"} via 来源标记
 */

/**
 * 把 reflection 模型输出解析成决策对象。
 *
 * JSON 抠取走公共入口 `parseModelJson`（`src/text/parse-model-json.js`）的**顶层平衡扫描**
 * （`topOnly` 缺省即顶层档）：只在括号深度归零处切候选，未闭合的外层不产候选，于是不会把
 * 内层残片当决策、也不会被尾话里的 `{plan}` 带着整坨解析失败（issue #305：解析一失败就落到
 * 关键词兜底，把模型明确写的 `"continue": false` 翻成 `continueFlag: true`）。
 * 迁移到公共入口是 issue #307 的事，**行为与 #306 逐字等价**：
 * `requireKeys` 传的就是下面这六个键（any-of —— 六字段全部可缺省，含其一即算决策对象；
 * 一个都不含的顶层对象什么都搬运不过来，按散文兜底，issue #305 R2 灰区裁决），
 * 于是「解析失败 → 下一个候选」「形状不合格 → 下一个候选」「全不合格 → 兜底」三条路径原样保留。
 *
 * `via` 只声明来源（`"json"` = 来自可解析的顶层对象；`"prose_fallback"` = 关键词兜底），
 * **不**暗示 schema 已校验：六字段全部可缺省带默认，半集是合法输入。
 *
 * @param {string} text
 * @returns {ReflectionDecision}
 */
export function parseReflectionDecision(text) {
  const value = String(text ?? "");
  const scanned = parseModelJson(value, { requireKeys: REFLECTION_DECISION_KEYS });
  if (scanned.ok) {
    const parsed = scanned.value;
    return {
      progress: numberOr(parsed.progress),
      stalled: parsed.stalled === true,
      continueFlag: parsed.continue === true,
      stallPattern: String(parsed.stallPattern ?? ""),
      reason: String(parsed.reason ?? ""),
      plan: String(parsed.plan ?? ""),
      via: "json",
    };
  }

  return {
    progress: undefined,
    stalled: /打转|重复|无进展|stalled/i.test(value),
    continueFlag: /继续|值得|continue/i.test(value)
      && !/不值得|放弃|停止/i.test(value),
    stallPattern: "",
    reason: value.slice(0, 200),
    plan: "",
    via: "prose_fallback",
  };
}
