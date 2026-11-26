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

// issue #930：上下文超窗在上游**也是 400**，只是 body 里写着超窗字样。命中它们不再塌成
// 不可重试的 `invalid_request`，而是 `context_window_exceeded`——但**同一个请求本身仍不可重试**
// （`retryable: false`）：错的是这份请求的**大小**，不是网络抖动。能重试的是**压缩之后的那份
// 新请求**，由 orchestrator 的自恢复分支按错误码负责（见 `src/loop/orchestrator.js`）。
//
// 子串清单来源（**不是凭记忆编**）：与本仓既有同源正则逐字一致——
// `src/compact/fold-llm.js` 的 `classifyFoldDegradeKind`（摘要器侧早就在用这一套超窗指纹，
// 归因成 `context_window_exceeded`）。
//
// **真机样本**（三处测试各粘了一份原文，另有源码注释记着现场）：
//   `400 message = input length '16584' is longer than configured context length '16384'`
//   —— 现场记录在 `src/compact/provider-summarizer.js` 的注释里（#469 真机塌点：一次折叠把
//   16 584 token 整坨发给摘要器，网关就这么回的）；同样这行 body 出现在
//   `test/compact/fold-llm-fail-661.test.js` / `fold-llm-ruling-469.test.js` /
//   `fold-llm-degrade-469.test.js` 的夹具里。
//
// `context_length_exceeded` / `maximum context length` 是同族上游（OpenAI/Anthropic）的字样，
// 与上面那条一起写在同一个既有正则里；`prompt is too long`（Anthropic 文案）**本仓无实测样本**，
// 因此**不**纳入——不假装有实测。
//
// 两处清单必须逐字同源，改一处要同步另一处（`test/loop-context-window-self-heal-930.test.js`
// 的最后一格钉这件事）。
const CONTEXT_WINDOW_EXCEEDED_PATTERN = /maximum context length|context_length_exceeded|context window|ContextWindowExceeded|is longer than configured context length|input length|too many tokens/i;

/**
 * issue #930：判定一段上游错误 body 是否为「上下文超窗」指纹（导出给折叠侧/测试复用，
 * 与 `fold-llm.js#classifyFoldDegradeKind` 同一把尺子）。
 *
 * @param {any} bodyText
 * @returns {boolean}
 */
export function isContextWindowExceededBody(bodyText) {
  return CONTEXT_WINDOW_EXCEEDED_PATTERN.test(asBodyText(bodyText));
}

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

export function validateProviderConfig(provider, { endpoint, apiKey, model } = {}) {
  for (const [field, value] of [
    ["endpoint", endpoint],
    ["apiKey", apiKey],
    ["model", model],
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new KitError(
        "provider_config",
        `${provider} provider ${field} must be a non-empty string`,
        { retryable: false },
      );
    }
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

/**
 * Classify a non-2xx provider response into a `KitError`.
 *
 * Status → `code` map (issue #179 A12-A added the last three rows):
 * 408 → `timeout`, 429 → `rate_limited`, 401/403 → `auth`, 500..599 → `server`,
 * 400/422 → `invalid_request`, 404 → `not_found`, 409 → `conflict`,
 * every other status → `unknown`.
 *
 * The added codes are a **host-visible value-surface extension** (semver minor):
 * `classifyHttpError` is a public export, and `code` also reaches hosts through
 * `termination.errorCode` (issue #176). `retryable` is unchanged — none of the
 * three new codes joins `RETRYABLE_CODES`, so they stay non-retryable exactly as
 * `unknown` was. Hosts that branch on `"unknown"` will now see the new codes.
 *
 * @param {number} status
 * @param {any} bodyText
 * @param {{phase?:string, elapsedMs?:number}} [opts]
 * @returns {KitError}
 */
export function classifyHttpError(status, bodyText, opts = {}) {
  let code = "unknown";
  if (status === 408) {
    code = "timeout";
  } else if (status === 429) {
    code = "rate_limited";
  } else if (status === 401 || status === 403) {
    code = "auth";
  } else if (status >= 500 && status <= 599) {
    code = "server";
  } else if (status === 400 || status === 422) {
    // issue #930：400/422 先看 body 子串。命中超窗指纹 ⇒ `context_window_exceeded`；
    // 其余一律仍为不可重试的 `invalid_request`（不吞别的 400）。
    code = isContextWindowExceededBody(bodyText) ? "context_window_exceeded" : "invalid_request";
  } else if (status === 404) {
    code = "not_found";
  } else if (status === 409) {
    code = "conflict";
  }

  return new KitError(code, upstreamErrorMessage(bodyText), {
    // issue #930：`context_window_exceeded` 的 `retryable` 走默认（`RETRYABLE_CODES` 不含它 ⇒ **false**）。
    // 语义：**同一个超大请求不可原样重试**（错的是请求大小，不是网络抖动；原样重发只会把同一坨
    // 再撞一次窗口，白烧钱）。只有**压缩之后的新请求**可重试，那件事由 orchestrator 的自恢复分支
    // 按**错误码** catch 负责（`src/loop/orchestrator.js`），不依赖这个 flag——所以把它置真只会让
    // 轮内 provider 重试（`provider-runner.js` 对 `retryable` 的错重发同一请求）白白重发超窗请求。
    retryable: defaultRetryable(code),
    status,
    ...(opts.phase === undefined ? {} : { phase: opts.phase }),
    ...(opts.elapsedMs === undefined ? {} : { elapsedMs: opts.elapsedMs }),
  });
}

function isTimeoutException(err) {
  if (!err) return false;
  if (err.name === "TimeoutError") return true;
  if (err.code === "ETIMEDOUT" || err.code === "ESOCKETTIMEDOUT") return true;
  return /\b(?:timed?\s*out|timeout|deadline exceeded)\b/i.test(String(err.message ?? ""));
}

function isAbortException(err, signal) {
  return signal?.aborted === true
    || err?.name === "AbortError"
    || err?.code === "ABORT_ERR";
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
 * @param {{phase?:string, elapsedMs?:number, status?:number, signal?:AbortSignal}} [opts]
 * @returns {KitError}
 */
export function classifyFetchException(err, opts = {}) {
  const status = opts.status ?? err?.status;
  const metadata = {
    ...(opts.phase === undefined ? {} : { phase: opts.phase }),
    ...(opts.elapsedMs === undefined ? {} : { elapsedMs: opts.elapsedMs }),
    ...(status === undefined ? {} : { status }),
  };
  if (isAbortException(err, opts.signal)) {
    return new KitError("aborted", err?.message || "Request aborted", {
      retryable: false,
      cause: err,
      ...metadata,
    });
  }
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
