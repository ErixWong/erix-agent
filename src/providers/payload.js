const PROVIDER_NAMES = new Set(["openai", "anthropic"]);
// 引擎自有 payload 字段：provider 选项表里都有对应入口，宿主经 `extraBody`
// 注入同名字段时一律以引擎值为准（issue #181 红线 3，见 http-shared.js）。
export const CORE_PAYLOAD_KEYS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "max_tokens",
  "temperature",
  "top_p",
  "stream",
  "stream_options",
  "frequency_penalty",
  "presence_penalty",
  "response_format",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSecretKey(key) {
  const normalized = String(key ?? "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  return normalized === "token"
    || normalized === "authorization"
    || normalized.includes("api_key")
    || normalized.includes("api_token")
    || normalized.includes("access_key")
    || normalized.includes("private_key")
    || normalized.includes("credential")
    || normalized.includes("password")
    || normalized.includes("secret")
    || /(?:access|refresh|bearer|auth|session|client|user)_token/.test(normalized)
    || normalized === "token_value";
}

function sanitize(value, key) {
  if (isSecretKey(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
  }
  if (!isRecord(value)) return value;

  const result = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const sanitized = sanitize(entryValue, entryKey);
    if (sanitized !== undefined) result[entryKey] = sanitized;
  }
  return result;
}

function requestValue(request, defaults, key, aliases = []) {
  for (const candidate of [key, ...aliases]) {
    if (hasOwn(request, candidate) && request[candidate] !== undefined) {
      return request[candidate];
    }
  }
  for (const candidate of [key, ...aliases]) {
    if (hasOwn(defaults, candidate) && defaults[candidate] !== undefined) {
      return defaults[candidate];
    }
  }
  return undefined;
}

function providerExtraOptions(providerOptions, provider) {
  if (!isRecord(providerOptions)) return {};
  const hasNamedProvider = Object.keys(providerOptions)
    .some((key) => PROVIDER_NAMES.has(key));
  if (hasNamedProvider) {
    return isRecord(providerOptions[provider]) ? providerOptions[provider] : {};
  }
  return providerOptions;
}

/**
 * Apply optional provider payload fields while omitting all undefined values.
 * Provider options may be either `{openai: {...}}`/`{anthropic: {...}}` or a
 * direct provider-specific object. Secret-looking keys are never copied.
 *
 * @param {object} payload
 * @param {object} request
 * @param {"openai"|"anthropic"} provider
 * @param {object} [defaults]
 * @returns {object}
 */
export function applyProviderPayloadOptions(
  payload,
  request = {},
  provider,
  defaults = {},
) {
  const fields = [
    ["thinking"],
    ["reasoning"],
    ["reasoning_effort"],
    ["enable_thinking"],
    ["chat_template_kwargs"],
    ["frequency_penalty", ["frequencyPenalty"]],
    ["presence_penalty", ["presencePenalty"]],
    ["response_format", ["responseFormat"]],
  ];

  const extras = sanitize(providerExtraOptions(
    requestValue(request, defaults, "providerOptions", ["provider_options"]),
    provider,
  ));
  if (isRecord(extras)) {
    for (const [key, value] of Object.entries(extras)) {
      if (!CORE_PAYLOAD_KEYS.has(key)) payload[key] = value;
    }
  }

  for (const [key, aliases = []] of fields) {
    const value = requestValue(request, defaults, key, aliases);
    if (value !== undefined && value !== null) payload[key] = value;
  }

  // The relay currently treats reasoning_effort:"none" for GLM models as
  // unisolated reasoning, leaking CoT into content; "low" keeps the reasoning
  // isolated while leaving content clean. DeepSeek and other models retain the
  // shared "none" semantics, so this translation is limited to OpenAI GLM
  // payloads. Revisit it if the relay supports the official vLLM
  // chat_template_kwargs:{enable_thinking:false} behavior.
  if (
    provider === "openai"
    && payload.reasoning_effort === "none"
    && /glm/i.test(String(payload.model ?? ""))
  ) {
    payload.reasoning_effort = "low";
  }

  return payload;
}

/**
 * 实发值可观测（issue #785 P1 ②）：把「宿主给的值」与「最终写进请求体的值」分开记一笔。
 *
 * 背暴（2026-11-08 真上游探针）：未知顶层键被上游 **200 静默吞**（正文干净但 usage 显示仍在推理），
 * 未识别的标量值才会 HTTP 400 ⇒ 这类错误不报错，**只有落盘能看见**。而账本里原先没有任何请求参数格子，
 * 「实际发出去的 effort 是多少、有没有被 payload 层翻译过」查不到。
 *
 * 口径：
 * - `hostValue` = **宿主给的原值**（未翻译）。GLM 的 `none→low` 只动 `payload.reasoning_effort`，
 *   绝不把翻译后的 `low` 写成 `hostValue`。
 * - `sentValue` = 最终进入请求体的值（已过 payload 翻译与 `extraBody` 注入）。
 * - `source` = 值来源通道：`request`（调用点覆盖）/ `slotDefault`（槽位默认）/
 *   `providerOptions` / `extraBody`。优先级与 `applyProviderPayloadOptions` + `applyExtraBody` 一致：
 *   request > slot 默认 > providerOptions > extraBody。
 * - **无相关键 ⇒ 返回 `undefined`**（无值不产噪声），与 `runStateMeta` / `engineUsage` 同构：没事实就没键。
 *
 * 边界（写在这里，契约 `Which RoundRecord fields a host may render` 那格里也有一句）：**当前只有引擎自带的
 * OpenAI provider**（`src/providers/openai.js`，`chat` 与 `chatStream` 两条路径）会交这笔账——它的 wire body
 * 由本模块拼装，所以「最终发出去的值」在这里是可证的。**Anthropic provider 与宿主自建 provider 都不交**
 * （前者的载荷走 `canonicalToAnthropicRequest`，本片没把观测点接过去；后者引擎根本看不见它的 body）
 * ⇒ 两种情况下该格都缺席，而缺席读作**「未观测」，绝不是「没发」**。
 *
 * @param {{
 *   payload?: Record<string, any>,
 *   request?: Record<string, any>,
 *   defaults?: Record<string, any>,
 *   provider?: "openai" | "anthropic",
 *   extraBody?: Record<string, unknown>,
 * }} input `payload` 必须是**已应用 extraBody 之后**的最终载荷
 * @returns {{reasoningEffort: {hostValue: any, sentValue: any, source: string, translated?: boolean}}|undefined}
 */
export function observeSentReasoningParams({ payload, request = {}, defaults = {}, provider = "openai", extraBody } = {}) {
  const sentValue = payload?.reasoning_effort;

  let hostValue;
  let source;
  const fromRequest = requestValue(request, defaults, "reasoning_effort");
  if (fromRequest !== undefined && fromRequest !== null) {
    hostValue = fromRequest;
    source = hasOwn(request, "reasoning_effort")
      && request.reasoning_effort !== undefined
      && request.reasoning_effort !== null
      ? "request"
      : "slotDefault";
  } else {
    const extras = providerExtraOptions(
      requestValue(request, defaults, "providerOptions", ["provider_options"]),
      provider,
    );
    if (hasOwn(extras, "reasoning_effort") && extras.reasoning_effort !== undefined) {
      hostValue = extras.reasoning_effort;
      source = "providerOptions";
    } else if (extraBody !== undefined && extraBody !== null
      && hasOwn(extraBody, "reasoning_effort")
      && extraBody.reasoning_effort !== undefined) {
      hostValue = extraBody.reasoning_effort;
      source = "extraBody";
    }
  }

  if (hostValue === undefined && sentValue === undefined) return undefined;

  /** @type {{hostValue: any, sentValue: any, source: string, translated?: boolean}} */
  const entry = {
    hostValue,
    sentValue,
    source: source ?? "unknown",
  };
  if (source !== undefined && hostValue !== sentValue) {
    entry.translated = true;
  }
  return { reasoningEffort: entry };
}

/**
 * Resolve a provider's configured timeout while preserving the old default.
 *
 * @param {number|undefined} timeout
 * @param {number|undefined} timeoutMs
 * @returns {number}
 */
export function resolveProviderTimeout(timeout, timeoutMs) {
  return timeout ?? timeoutMs ?? 120000;
}

function timeoutValue(options, names) {
  const nestedTimeout = options?.timeout !== null
    && typeof options?.timeout === "object"
    ? options.timeout
    : undefined;
  for (const source of [options, options?.timeouts, nestedTimeout]) {
    for (const name of names) {
      if (source?.[name] !== undefined && source[name] !== null) {
        return source[name];
      }
    }
  }
  return undefined;
}

/**
 * Resolve legacy and explicit request/stream timeout settings.
 *
 * `timeout`/`timeoutMs` remain one request-wide deadline. Supplying any
 * phase-specific setting opts into the three-phase stream model.
 */
export function resolveProviderTimeouts(options = {}) {
  const legacy = timeoutValue(options, ["timeout", "timeoutMs"]);
  const phaseValues = [
    "requestTimeoutMs",
    "request_timeout_ms",
    "requestTimeout",
    "request_timeout",
    "request",
    "firstByteTimeoutMs",
    "first_byte_timeout_ms",
    "firstByteTimeout",
    "first_byte_timeout",
    "firstByte",
    "streamIdleTimeoutMs",
    "stream_idle_timeout_ms",
    "streamIdleTimeout",
    "stream_idle_timeout",
    "streamIdle",
    "streamTotalTimeoutMs",
    "stream_total_timeout_ms",
    "streamTotalTimeout",
    "stream_total_timeout",
    "streamTotal",
  ];
  const hasExplicitPhase = phaseValues.some((name) => (
    timeoutValue(options, [name]) !== undefined
  ));
  const requestTimeoutMs = timeoutValue(options, [
    "requestTimeoutMs",
    "request_timeout_ms",
    "requestTimeout",
    "request_timeout",
    "request",
  ]) ?? legacy ?? 120000;
  const firstByteTimeoutMs = timeoutValue(options, [
    "firstByteTimeoutMs",
    "first_byte_timeout_ms",
    "firstByteTimeout",
    "first_byte_timeout",
    "firstByte",
  ]) ?? 120000;
  const streamIdleTimeoutMs = timeoutValue(options, [
    "streamIdleTimeoutMs",
    "stream_idle_timeout_ms",
    "streamIdleTimeout",
    "stream_idle_timeout",
    "streamIdle",
  ]) ?? 120000;
  const streamTotalTimeoutMs = timeoutValue(options, [
    "streamTotalTimeoutMs",
    "stream_total_timeout_ms",
    "streamTotalTimeout",
    "stream_total_timeout",
    "streamTotal",
  ]) ?? 300000;

  return {
    requestTimeoutMs,
    firstByteTimeoutMs,
    streamIdleTimeoutMs,
    streamTotalTimeoutMs,
    legacyTimeoutMs: hasExplicitPhase ? undefined : requestTimeoutMs,
    explicitPhase: hasExplicitPhase,
  };
}
