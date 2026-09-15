import { KitError } from "../providers/errors.js";
import { enforceSize } from "../compact/enforce-size.js";
import { estimateMessageTokens, estimateTokens } from "../tokens.js";
import { groupIntoRounds } from "../messages/rounds.js";
import { blocksFor } from "./block-helpers.js";

export function numberOr(value) {
  return Number.isFinite(value) ? value : undefined;
}

export function cloneState(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function isProtectedMessage(message, guard) {
  if (typeof guard === "function") return guard(message) === true;
  if (typeof guard === "string") return message?.role === guard;
  if (Array.isArray(guard)) return guard.includes(message?.role);
  return false;
}

export function normalizeToolNameSet(value, fallback) {
  const names = Array.isArray(value) ? value : fallback;
  return new Set(names.filter((name) => (
    typeof name === "string" && name.trim() !== ""
  )));
}

export function validateBudget(budgetTokens) {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
    throw new KitError(
      "invalid_budget",
      `budgetTokens must be a positive integer (got ${String(budgetTokens)})`,
      { retryable: false },
    );
  }
  return budgetTokens;
}

export function isApiInputOverBudget(apiInputTokens, budgetTokens) {
  return budgetTokens !== undefined
    && Number.isFinite(apiInputTokens)
    && apiInputTokens > budgetTokens;
}

export function projectedApiInputTokens(apiInputTokens, estimatedBefore, estimatedAfter) {
  if (
    !Number.isFinite(apiInputTokens)
    || apiInputTokens <= 0
    || !Number.isFinite(estimatedBefore)
    || estimatedBefore <= 0
  ) {
    return undefined;
  }
  return Math.ceil(apiInputTokens * estimatedAfter / estimatedBefore);
}

export function modelMetadataFor({ modelConfig, modelMetadata, model, provider, context }) {
  const candidates = [modelConfig, modelMetadata, model, provider, context];
  return candidates.find((candidate) => (
    candidate
    && typeof candidate === "object"
    && (
      candidate.contextWindowTokens !== undefined
      || candidate.maxOutputTokens !== undefined
    )
  ));
}

export function toolContextFor({
  toolContext,
  context,
  expert,
  user,
  task,
  session,
  requestId,
}) {
  const result = {
    ...(context?.toolContext && typeof context.toolContext === "object"
      ? context.toolContext
      : {}),
    ...(toolContext && typeof toolContext === "object" ? toolContext : {}),
  };
  for (const [key, value] of Object.entries({
    expert: expert !== undefined ? expert : context?.expert,
    user: user !== undefined ? user : context?.user,
    task: task !== undefined ? task : context?.task,
    session: session !== undefined ? session : context?.session,
    requestId: requestId !== undefined ? requestId : context?.requestId,
  })) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function truncateTextToBudget(text, budgetTokens) {
  const value = String(text ?? "");
  if (estimateTokens(value) <= budgetTokens) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join("")) <= budgetTokens) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

export function dropOldestUnprotectedRound(messages, protectedMessage) {
  const { head, rounds } = groupIntoRounds(messages);
  const index = rounds.findIndex((round) => !round.messages.some((message) => (
    isProtectedMessage(message, protectedMessage)
  )));
  if (index < 0) return undefined;
  const start = head.length + rounds
    .slice(0, index)
    .reduce((total, round) => total + round.messages.length, 0);
  const count = rounds[index].messages.length;
  return messages.splice(start, count);
}

export async function safeTruncateMessages(messages, budgetTokens, protectedMessage, stubFor) {
  const result = cloneState(messages);
  const downgraded = new Set();
  const foldedPayload = [];
  const foldedStubs = [];
  const collectStubs = async (removed) => {
    if (typeof stubFor !== "function") return;
    for (const message of removed ?? []) {
      if (!Array.isArray(message?.content) || !message.content.some((block) => (
        block?.type === "tool_result" && block.replayable === false
      ))) continue;
      const stub = await stubFor(message);
      if (typeof stub !== "string" || stub.trim() === "") continue;
      foldedStubs.push(Array.from(stub).slice(0, 200).join(""));
    }
  };
  let protectedDowngraded = 0;
  const isCurrentlyProtected = (message) => (
    isProtectedMessage(message, protectedMessage) && !downgraded.has(message)
  );
  const downgradeProtected = (message) => {
    if (!isCurrentlyProtected(message)) return false;
    downgraded.add(message);
    protectedDowngraded += 1;
    return true;
  };
  const removeMessages = async (start, count) => {
    const removed = result.slice(start, start + count);
    foldedPayload.push(
      ...removed
        .filter((message) => downgraded.has(message))
        .map((message) => cloneState(message)),
    );
    await collectStubs(removed);
    result.splice(start, count);
  };
  while (estimateMessageTokens(result) > budgetTokens) {
    const removed = dropOldestUnprotectedRound(
      result,
      (message) => isCurrentlyProtected(message),
    );
    if (removed === undefined) break;
    await collectStubs(removed);
    // Remove complete rounds before reducing individual message content.
  }

  const fields = [];
  const references = [];
  result.forEach((message, messageIndex) => {
    const protectedMessageValue = isCurrentlyProtected(message);
    if (typeof message.content === "string") {
      fields.push({
        key: `message-${messageIndex}`,
        text: message.content,
        priority: messageIndex,
        protected: protectedMessageValue,
      });
      references.push({
        fieldIndex: fields.length - 1,
        messageIndex,
        blockIndex: undefined,
      });
      return;
    }
    for (const [blockIndex, block] of (message.content ?? []).entries()) {
      let text;
      let kind;
      if (block?.type === "text" || block?.type === "reasoning") {
        text = block.text;
        kind = "text";
      } else if (block?.type === "tool_result") {
        text = block.content;
        kind = "content";
      }
      if (text === undefined) continue;
      fields.push({
        key: `message-${messageIndex}-block-${blockIndex}`,
        text: String(text),
        priority: messageIndex,
        protected: protectedMessageValue,
      });
      references.push({
        fieldIndex: fields.length - 1,
        messageIndex,
        blockIndex,
        kind,
      });
    }
  });
  const trimmableFields = fields
    .map((field, fieldIndex) => ({ ...field, fieldIndex }))
    .filter((field) => field.protected !== true);
  const enforced = enforceSize(trimmableFields, budgetTokens);
  const enforcedByIndex = new Map(
    enforced.fields.map((field) => [field.fieldIndex, field]),
  );
  for (const reference of references) {
    const enforcedField = enforcedByIndex.get(reference.fieldIndex);
    if (enforcedField === undefined) continue;
    const text = enforcedField.text;
    if (reference.blockIndex === undefined) {
      result[reference.messageIndex].content = truncateTextToBudget(
        text,
        budgetTokens,
      );
    } else if (reference.kind === "text") {
      result[reference.messageIndex].content[reference.blockIndex].text =
        truncateTextToBudget(text, budgetTokens);
    } else {
      result[reference.messageIndex].content[reference.blockIndex].content =
        truncateTextToBudget(text, budgetTokens);
    }
  }

  result.forEach((message) => {
    if (!Array.isArray(message.content)) return;
    message.content = message.content.filter((block) => (
      block?.type !== "image" && block?.type !== "image_url"
    )).map((block) => {
      if (block?.type !== "tool_use") return block;
      return { ...block, input: {} };
    });
  });

  for (const message of result) {
    if (isCurrentlyProtected(message) && estimateMessageTokens([message]) > budgetTokens) {
      throw new KitError(
        "invalid_budget",
        "A single protected message exceeds budgetTokens; increase budgetTokens or reduce the protectedMessage set.",
        { retryable: false },
      );
    }
  }

  while (estimateMessageTokens(result) > budgetTokens) {
    const removableIndex = result.findIndex((message) => (
      !isCurrentlyProtected(message)
    ));
    if (removableIndex < 0) {
      const oldestProtected = result.find((message) => isCurrentlyProtected(message));
      if (oldestProtected === undefined) {
        throw new KitError(
          "invalid_budget",
          "Messages cannot fit within budgetTokens; increase budgetTokens or reduce the protectedMessage set.",
          { retryable: false },
        );
      }
      downgradeProtected(oldestProtected);
      continue;
    }
    const message = result[removableIndex];
    const uses = blocksFor(message.content).filter((block) => block?.type === "tool_use");
    const results = blocksFor(message.content).filter((block) => block?.type === "tool_result");
    if (uses.length > 0 && result[removableIndex + 1]?.role === "user") {
      if (isCurrentlyProtected(result[removableIndex + 1])) {
        downgradeProtected(result[removableIndex + 1]);
        continue;
      }
      await removeMessages(removableIndex, 2);
    } else if (results.length > 0 && removableIndex > 0
      && result[removableIndex - 1]?.role === "assistant") {
      if (isCurrentlyProtected(result[removableIndex - 1])) {
        downgradeProtected(result[removableIndex - 1]);
        continue;
      }
      await removeMessages(removableIndex - 1, 2);
    } else {
      await removeMessages(removableIndex, 1);
    }
  }
  const uniqueStubs = [...new Set(foldedStubs)];
  if (uniqueStubs.length > 0) {
    const firstUser = result.findIndex((message) => message?.role === "user");
    if (firstUser >= 0) {
      const user = result[firstUser];
      const content = typeof user.content === "string"
        ? [{ type: "text", text: user.content }]
        : Array.isArray(user.content) ? user.content : [];
      result[firstUser] = {
        ...user,
        content: [
          ...content,
          { type: "text", text: uniqueStubs.slice(0, 10).join("\n") },
        ],
      };
    }
  }
  return {
    messages: result,
    tokensAfter: estimateMessageTokens(result),
    enforced,
    foldedPayload,
    foldedStubs: uniqueStubs,
    protectedDowngraded,
  };
}
