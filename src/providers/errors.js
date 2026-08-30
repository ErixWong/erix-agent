const RETRYABLE_CODES = new Set(["timeout", "rate_limited", "server", "disconnect"]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
]);
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
   * @param {{
   *   retryable?:boolean,
   *   status?:number,
   *   phase?:string,
   *   elapsedMs?:number,
   *   cause?:any
   * }} [opts]
   */
  constructor(code, message, opts = {}) {
    const errorOptions = opts.cause === undefined ? undefined : { cause: opts.cause };
    super(message, errorOptions);
    this.name = "KitError";
    this.code = code;
    this.retryable = opts.retryable ?? defaultRetryable(code);
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.phase !== undefined) this.phase = opts.phase;
    if (opts.elapsedMs !== undefined) this.elapsedMs = opts.elapsedMs;
  }
}

export function classifyHttpError(status, bodyText, opts = {}) {
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
    ...(opts.phase === undefined ? {} : { phase: opts.phase }),
    ...(opts.elapsedMs === undefined ? {} : { elapsedMs: opts.elapsedMs }),
  });
}

function isTimeoutException(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err.code === "ETIMEDOUT" || err.code === "ESOCKETTIMEDOUT") return true;
  return /\b(?:timed?\s*out|timeout|deadline exceeded)\b/i.test(String(err.message ?? ""));
}

function errorCode(err) {
  return err?.code ?? err?.cause?.code;
}

function isRetryableNetworkException(err) {
  if ([502, 503, 504].includes(err?.status)) return true;
  const code = errorCode(err);
  if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return true;

  const message = String(err?.message ?? "");
  return /socket hang up|connection reset|broken pipe|\bEOF\b|do request failed|连接重置|连接被对端关闭/i
    .test(message)
    || /\b(?:HTTP\s+)?(?:502|503|504)\b/i.test(message);
}

/**
 * Classify a fetch failure without losing stream/request timing metadata.
 *
 * @param {any} err
 * @param {{phase?:string, elapsedMs?:number, status?:number}} [opts]
 * @returns {KitError}
 */
export function classifyFetchException(err, opts = {}) {
  const status = opts.status ?? err?.status;
  const metadata = {
    ...(opts.phase === undefined ? {} : { phase: opts.phase }),
    ...(opts.elapsedMs === undefined ? {} : { elapsedMs: opts.elapsedMs }),
    ...(status === undefined ? {} : { status }),
  };
  if (isTimeoutException(err)) {
    return new KitError("timeout", "Request timed out", {
      retryable: true,
      cause: err,
      ...metadata,
    });
  }

  const message = typeof err?.message === "string" && err.message
    ? err.message
    : "Network request failed";
  const code = "network";
  const retryable = isRetryableNetworkException(err);
  return new KitError(code, message, {
    retryable,
    cause: err,
    ...metadata,
  });
}
