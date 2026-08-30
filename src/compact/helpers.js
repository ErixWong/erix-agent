function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionValue(callOptions, factoryOptions, key, fallback) {
  if (callOptions && Object.prototype.hasOwnProperty.call(callOptions, key)) {
    return callOptions[key];
  }
  if (factoryOptions && Object.prototype.hasOwnProperty.call(factoryOptions, key)) {
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

export function foldOptions(factoryOptions, callOptions = {}) {
  return {
    summaryRole: optionValue(callOptions, factoryOptions, "summaryRole", "user"),
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
