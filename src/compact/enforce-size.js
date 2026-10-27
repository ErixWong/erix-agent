import { estimateTokens } from "../tokens.js";

function allText(fields) {
  return fields
    .map((field) => String(field?.text ?? ""))
    .join("");
}

function priorityOrder(fields) {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((left, right) => {
      const priorityDifference = Number(right.field?.priority) - Number(left.field?.priority);
      return Number.isNaN(priorityDifference)
        ? left.index - right.index
        : priorityDifference || left.index - right.index;
    })
    .map(({ index }) => index);
}

/**
 * issue #469（宿主审计 C 片）：被修剪的节**保留标题**。
 *
 * 旧形状是把整节（含 `## 标题`）换成一行 `[已修剪]` ⇒ 读的人（以及下一次折叠的摘要器）
 * 连「曾经有这一节」都看不出来，五节合同的**骨架**也跟着消失。现在只剪正文，
 * 输出 `## 标题\n[已修剪]`：骨架仍在，内容丢了也看得见。
 *
 * @param {unknown} text
 * @returns {string}
 */
function prunedFieldText(text) {
  const raw = String(text ?? "");
  const heading = /^## .*(?:\r?\n|$)/u.exec(raw);
  if (heading === null) return "[已修剪]";
  const headingLine = heading[0].endsWith("\n") ? heading[0] : `${heading[0]}\n`;
  return `${headingLine}[已修剪]`;
}

/**
 * Deterministically trim the lowest-priority fields to a token budget.
 *
 * @param {{key:string, text:string, priority:number}[]} fields
 * @param {number} budgetTokens
 * @returns {{fields: object[], prunedKeys: string[], tokensBefore:number, tokensAfter:number}}
 */
export function enforceSize(fields, budgetTokens) {
  const result = (Array.isArray(fields) ? fields : []).map((field) => ({ ...field }));
  const tokensBefore = estimateTokens(allText(result));
  let tokensAfter = tokensBefore;
  const prunedKeys = [];

  for (const index of priorityOrder(result)) {
    if (tokensAfter <= budgetTokens) break;
    result[index] = { ...result[index], text: prunedFieldText(result[index].text) };
    prunedKeys.push(result[index].key);
    tokensAfter = estimateTokens(allText(result));
  }

  return { fields: result, prunedKeys, tokensBefore, tokensAfter };
}
