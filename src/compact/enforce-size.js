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
    result[index] = { ...result[index], text: "[已修剪]" };
    prunedKeys.push(result[index].key);
    tokensAfter = estimateTokens(allText(result));
  }

  return { fields: result, prunedKeys, tokensBefore, tokensAfter };
}
