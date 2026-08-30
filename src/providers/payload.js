const PROVIDER_NAMES = new Set(["openai", "anthropic"]);

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
  if (isRecord(extras)) Object.assign(payload, extras);

  for (const [key, aliases = []] of fields) {
    const value = requestValue(request, defaults, key, aliases);
    if (value !== undefined && value !== null) payload[key] = value;
  }

  return payload;
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
