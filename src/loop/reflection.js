import { numberOr } from "./budget.js";
import { jsonCandidates } from "../text/json-candidates.js";

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
 * 把 reflection 模型输出解析成决策对象。
 *
 * JSON 路径走 `jsonCandidates`（`src/text/json-candidates.js`）的**顶层平衡扫描**：
 * 只在括号深度归零处切候选，未闭合的外层不产候选，于是不会把内层残片当决策、也不会被
 * 尾话里的 `{plan}` 带着整坨解析失败（issue #305：解析一失败就落到关键词兜底，
 * 把模型明确写的 `"continue": false` 翻成 `continueFlag: true`）。
 *
 * `via` 只声明来源（`"json"` = 来自可解析的顶层对象；`"prose_fallback"` = 关键词兜底），
 * **不**暗示 schema 已校验：六字段全部可缺省带默认，半集是合法输入。
 *
 * @param {string} text
 */
export function parseReflectionDecision(text) {
  const value = String(text ?? "");
  for (const candidate of jsonCandidates(value)) {
    /** @type {Record<string, unknown>} */
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // 这个顶层候选不是合法 JSON，试下一个
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    // 顶层对象解析成功却搬运不出任何决策字段 —— 按散文兜底处理（issue #305 R2 灰区裁决），
    // 此时关键词兜底才贴近现状语义。
    if (!REFLECTION_DECISION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(parsed, key))) continue;
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
