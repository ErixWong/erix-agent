const RETRYABLE_CODES = new Set(["timeout", "rate_limited", "server"]);
const MAX_ERROR_MESSAGE_LENGTH = 500;

function defaultRetryable(code) {
  return RETRYABLE_CODES.has(code);
}

function asBodyText(bodyText) {
  if (typeof bodyText === "string") return bodyText;
  if (bodyText == null) return "";
  return String(bodyText);
}

function truncate(text) {
  return asBodyText(text).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function parseBody(bodyText) {
  const text = asBodyText(bodyText);
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value: undefined };
  }
}

export function upstreamErrorMessage(bodyText) {
  const text = asBodyText(bodyText);
  const { value } = parseBody(text);
  const message = value?.error?.message;
  if (typeof message === "string") return message;
  if (message != null) return String(message);
  return truncate(text);
}

export class KitError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?:boolean, status?:number, cause?:any}} [opts]
   */
  constructor(code, message, opts = {}) {
    const errorOptions = opts.cause === undefined ? undefined : { cause: opts.cause };
    super(message, errorOptions);
    this.name = "KitError";
    this.code = code;
    this.retryable = opts.retryable ?? defaultRetryable(code);
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export function classifyHttpError(status, bodyText) {
  let code = "unknown";
  if (status === 429) {
    code = "rate_limited";
  } else if (status === 401 || status === 403) {
    code = "auth";
  } else if (status >= 500 && status <= 599) {
    code = "server";
  }

  return new KitError(code, upstreamErrorMessage(bodyText), {
    retryable: defaultRetryable(code),
    status,
  });
}

function isTimeoutException(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err.code === "ETIMEDOUT" || err.code === "ESOCKETTIMEDOUT") return true;
  return /\b(?:timed?\s*out|timeout|deadline exceeded)\b/i.test(String(err.message ?? ""));
}

export function classifyFetchException(err) {
  if (isTimeoutException(err)) {
    return new KitError("timeout", "Request timed out", {
      retryable: true,
      cause: err,
    });
  }

  const message = typeof err?.message === "string" && err.message
    ? err.message
    : "Network request failed";
  return new KitError("network", message, {
    retryable: false,
    cause: err,
  });
}
