function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const DEFAULT_RECOVERY_HINT =
  "需要原文请重读文件或查看持久笔记；关键值应当已落盘";

export function resolveRecoveryHint(value) {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : DEFAULT_RECOVERY_HINT;
}

export async function resolveFoldRecoveryHint(value, context) {
  const resolved = typeof value === "function"
    ? await value(context)
    : value;
  return resolveRecoveryHint(resolved);
}

export function optionValue(callOptions, factoryOptions, key, fallback) {
  if (
    callOptions
    && Object.prototype.hasOwnProperty.call(callOptions, key)
    && callOptions[key] !== undefined
  ) {
    return callOptions[key];
  }
  if (
    factoryOptions
    && Object.prototype.hasOwnProperty.call(factoryOptions, key)
    && factoryOptions[key] !== undefined
  ) {
    return factoryOptions[key];
  }
  return fallback;
}

export function isProtectedMessage(message, guard) {
  if (typeof guard === "function") return guard(message) === true;
  if (typeof guard === "string") return message?.role === guard;
  if (Array.isArray(guard)) return guard.includes(message?.role);
  return false;
}

export function isRealUser(message) {
  if (message?.role !== "user") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return typeof message.content === "string"
    || blocks.length === 0
    || blocks.some((block) => block?.type !== "tool_result");
}

export function selectFoldedRounds(rounds, keepRounds, protectedMessage) {
  const target = Math.max(0, rounds.length - keepRounds);
  const folded = [];
  const retained = [];
  const foldedIndexes = [];

  rounds.forEach((round, index) => {
    const protectedRound = round.messages.some((message) => (
      isProtectedMessage(message, protectedMessage)
    ));
    if (folded.length < target && !protectedRound) {
      folded.push(round);
      foldedIndexes.push(index);
    } else {
      retained.push(round);
    }
  });

  return { folded, retained, foldedIndexes };
}

export function roundRangeForIndexes(indexes, roundOffset = 0, roundNumbers) {
  const numbers = indexes.map((index) => (
    Number.isSafeInteger(roundNumbers?.[index])
      ? roundNumbers[index]
      : roundOffset + index + 1
  ));
  if (numbers.length === 0) return undefined;
  return {
    from: Math.min(...numbers),
    to: Math.max(...numbers),
  };
}

function stripMessageImages(message) {
  if (!Array.isArray(message?.content)) return { ...message };
  return {
    ...message,
    content: message.content.filter((block) => (
      block?.type !== "image" && block?.type !== "image_url"
    )),
  };
}

export function stripHistoricalImages(messages) {
  return messages.map(stripMessageImages);
}

export async function runFoldHook(hook, payload) {
  if (typeof hook === "function") await hook(payload);
}

function foldStubMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => (
    Array.isArray(message?.content)
    && message.content.some((block) => (
      block?.type === "tool_result"
    ))
  ));
}

export async function resolveFoldStubs(messages, stubFor) {
  if (typeof stubFor !== "function") return [];
  const stubs = [];
  for (const message of foldStubMessages(messages)) {
    const value = await stubFor(message);
    if (typeof value !== "string" || value.trim() === "") continue;
    const bounded = Array.from(value).slice(0, 200).join("");
    if (bounded !== "") stubs.push(bounded);
  }
  return [...new Set(stubs)];
}

export function appendFoldStubsToHead(head, stubs) {
  if (!Array.isArray(stubs) || stubs.length === 0) return head;
  const userIndex = head.findLastIndex(isRealUser);
  if (userIndex < 0) return head;
  const updatedHead = head.slice();
  const user = updatedHead[userIndex];
  const content = typeof user.content === "string"
    ? [{ type: "text", text: user.content }]
    : Array.isArray(user.content) ? user.content : [];
  const stubPattern = /^\[已折叠\][^\n]*/gmu;
  const existing = content
    .filter((block) => block?.type === "text")
    .flatMap((block) => [...String(block.text ?? "").matchAll(stubPattern)]
      .map((match) => match[0]));
  const merged = [...new Set([...existing, ...stubs])];
  const withoutStubs = content.flatMap((block) => {
    if (block?.type !== "text") return [block];
    const text = String(block.text ?? "").replace(stubPattern, "").trim();
    return text === "" ? [] : [{ ...block, text }];
  });
  updatedHead[userIndex] = {
    ...user,
    content: [...withoutStubs, { type: "text", text: merged.join("\n") }],
  };
  return updatedHead;
}

export function foldOptions(factoryOptions, callOptions = {}) {
  return {
    summaryRole: optionValue(callOptions, factoryOptions, "summaryRole", "user"),
    recoveryHint: optionValue(callOptions, factoryOptions, "recoveryHint"),
    protectedMessage: optionValue(callOptions, factoryOptions, "protectedMessage"),
    stripHistoricalImages: optionValue(
      callOptions,
      factoryOptions,
      "stripHistoricalImages",
      false,
    ) === true,
    onBeforeFold: optionValue(
      callOptions,
      factoryOptions,
      "onBeforeFold",
      optionValue(callOptions, factoryOptions, "beforeFold"),
    ),
    onAfterFold: optionValue(
      callOptions,
      factoryOptions,
      "onAfterFold",
      optionValue(callOptions, factoryOptions, "afterFold"),
    ),
    stubFor: optionValue(callOptions, factoryOptions, "stubFor"),
    roundOffset: Number.isFinite(callOptions.roundOffset)
      ? Math.max(0, Math.floor(callOptions.roundOffset))
      : Number.isFinite(factoryOptions?.roundOffset)
        ? Math.max(0, Math.floor(factoryOptions.roundOffset))
        : 0,
    roundNumbers: Array.isArray(callOptions.roundNumbers)
      ? callOptions.roundNumbers
      : Array.isArray(factoryOptions?.roundNumbers)
        ? factoryOptions.roundNumbers
        : undefined,
  };
}

export function cloneFoldPayload(payload, stripImages) {
  const cloned = payload.map((message) => (
    typeof structuredClone === "function"
      ? structuredClone(message)
      : JSON.parse(JSON.stringify(message))
  ));
  return stripImages ? stripHistoricalImages(cloned) : cloned;
}

export function isCanonicalMessage(value) {
  return isRecord(value) && typeof value.role === "string";
}
