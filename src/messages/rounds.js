/**
 * @typedef {import("./canonical.js").CanonicalMessage} CanonicalMessage
 * @typedef {{messages: CanonicalMessage[]}} MessageRound
 */

import { KitError } from "../providers/errors.js";

function blocksFor(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content;
}

function toolUses(message) {
  return blocksFor(message).filter((block) => block?.type === "tool_use");
}

function toolResults(message) {
  return blocksFor(message).filter((block) => block?.type === "tool_result");
}

function isRealUser(message) {
  if (message?.role !== "user") return false;
  const blocks = blocksFor(message);
  return typeof message.content === "string"
    || blocks.length === 0
    || blocks.some((block) => block?.type !== "tool_result");
}

function messageError(index, detail) {
  return new KitError(
    "invalid_messages",
    `Invalid message at index ${index}: ${detail}`,
  );
}

/**
 * Validate canonical message roles and adjacent tool-call/result pairs.
 *
 * @param {CanonicalMessage[]} messages
 * @param {{allowPendingToolUse?:boolean}} [options]
 * @returns {void}
 */
export function validateMessages(messages, { allowPendingToolUse = false } = {}) {
  if (!Array.isArray(messages)) {
    throw new KitError("invalid_messages", "Messages must be an array");
  }

  let seenConversationMessage = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = message?.role;
    if (!["system", "user", "assistant"].includes(role)) {
      throw messageError(index, `unsupported role "${String(role)}"`);
    }
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw messageError(index, "content must be a string or block array");
    }
    if (role === "system" && seenConversationMessage) {
      throw messageError(index, "system messages must precede user and assistant messages");
    }
    if (role !== "system") seenConversationMessage = true;

    for (const block of blocksFor(message)) {
      if (block?.type === "tool_use" && role !== "assistant") {
        throw messageError(index, "tool_use is only legal in assistant messages");
      }
      if (block?.type === "tool_result" && role !== "user") {
        throw messageError(index, "tool_result is only legal in user messages");
      }
    }

    const uses = message?.role === "assistant" ? toolUses(message) : [];

    if (uses.length > 0) {
      const next = messages[index + 1];
      const results = toolResults(next);
      if (next?.role !== "user" || results.length === 0) {
        if (allowPendingToolUse && index === messages.length - 1 && next === undefined) {
          continue;
        }
        throw messageError(
          index,
          "assistant tool_use has no immediately following user tool_result",
        );
      }

      const expected = new Map();
      for (const block of uses) {
        expected.set(block.id, (expected.get(block.id) ?? 0) + 1);
      }
      const actual = new Map();
      for (const block of results) {
        actual.set(block.tool_use_id, (actual.get(block.tool_use_id) ?? 0) + 1);
      }

      if (expected.size !== actual.size) {
        throw messageError(index + 1, "tool_result ids do not match assistant tool_use ids");
      }
      for (const [id, count] of expected) {
        if (actual.get(id) !== count) {
          throw messageError(index + 1, "tool_result ids do not match assistant tool_use ids");
        }
      }

      index += 1;
      continue;
    }

    if (message?.role === "user" && toolResults(message).length > 0) {
      throw messageError(index, "user tool_result has no matching assistant tool_use");
    }
  }
}

/**
 * Group canonical messages into indivisible conversation rounds.
 *
 * @param {CanonicalMessage[]} messages
 * @returns {{head: CanonicalMessage[], rounds: MessageRound[]}}
 */
export function groupIntoRounds(messages) {
  const input = Array.isArray(messages) ? messages : [];
  validateMessages(input);

  const firstRealUser = input.findIndex(isRealUser);
  if (firstRealUser < 0) {
    return { head: input.slice(), rounds: [] };
  }

  const head = input.slice(0, firstRealUser + 1);
  const rounds = [];

  for (let index = firstRealUser + 1; index < input.length;) {
    const message = input[index];
    const uses = message?.role === "assistant" ? toolUses(message) : [];

    if (uses.length > 0) {
      rounds.push({ messages: input.slice(index, index + 2) });
      index += 2;
      continue;
    }

    rounds.push({ messages: [message] });
    index += 1;
  }

  return { head, rounds };
}
