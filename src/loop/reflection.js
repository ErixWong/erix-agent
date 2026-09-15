import { numberOr } from "./budget.js";

export const WRAPUP_INSTRUCTION = `任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：
{"done":true,"summary":"任务总结","output":"给用户的结果"}
若任务尚未完成但需要阶段性说明，可输出 {"done":false,"summary":"当前进展"}。
继续工作时直接调用工具。`;

export const DEFAULT_REFLECTION_MIN_ROUNDS = 16;

export function reflectionPrompt({ rounds, taskBrief, runningLog, l0Facts, errorText }) {
  return `【进度反思】你是严格的独立评审者，不是执行者。请根据客观事实判断是否值得继续：

任务原始目标：${taskBrief || "（未提供）"}
已运行轮数：${rounds}
L0 客观事实链：${JSON.stringify(l0Facts).slice(0, 4000)}
L1 增量日志链：${JSON.stringify(runningLog).slice(0, 4000)}
最近 distinct 错误摘录：${errorText || "无"}

只输出 JSON（不要其他文字）：
{"progress":0-100,"stalled":true/false,"continue":true/false,"stallPattern":"描述或空","reason":"一句话","plan":"下一步具体动作"}`;
}

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

export function parseReflectionDecision(text) {
  const value = String(text ?? "");
  const jsonMatch = value.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        progress: numberOr(parsed.progress),
        stalled: parsed.stalled === true,
        continueFlag: parsed.continue === true || parsed["continue"] === true,
        stallPattern: String(parsed.stallPattern ?? ""),
        reason: String(parsed.reason ?? ""),
        plan: String(parsed.plan ?? ""),
      };
    } catch {
      // Fall through to the text interpretation below.
    }

  }

  return {
    progress: undefined,
    stalled: /打转|重复|无进展|stalled/i.test(value),
    continueFlag: /继续|值得|continue/i.test(value)
      && !/不值得|放弃|停止/i.test(value),
    stallPattern: "",
    reason: value.slice(0, 200),
    plan: "",
  };
}
