import { numberOr } from "./budget.js";
import { parseModelJson } from "../text/parse-model-json.js";

export const WRAPUP_INSTRUCTION = `任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：
{"done":true,"summary":"任务总结","output":"给用户的结果"}
若任务尚未完成但需要阶段性说明，可输出 {"done":false,"summary":"当前进展"}。
继续工作时直接调用工具。`;

export const DEFAULT_REFLECTION_MIN_ROUNDS = 16;

export function isLikelyWelcomeResponse(text) {
  const value = String(text ?? "").trim();
  return /^(?:你好|嗨|hello)\s*[!！,，。.]?\s*(?:我是|i\s*(?:am|'m))[\s\S]*(?:助手|assistant)/iu.test(value)
    || /(?:看起来|好像|似乎)[\s\S]{0,40}(?:没有|未)[\s\S]{0,20}(?:输入|收到)[\s\S]{0,20}(?:具体)?(?:任务|task)/iu.test(value)
    || /请[\s\S]{0,10}(?:告诉|输入|描述)[\s\S]{0,10}(?:我)?[\s\S]{0,20}(?:做什么|任务|task)/iu.test(value);
}

export function directionHintText(direction, directionReason) {
  if (direction !== "off_track") return "";
  const reason = typeof directionReason === "string" && directionReason.trim()
    ? directionReason.trim().slice(0, 200)
    : "当前路线可能偏";
  return `（附方向提示：${reason} —— 当前路线可能偏，可考虑换思路/方法）`;
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
