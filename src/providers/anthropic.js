import {
  KitError,
  classifyFetchException,
  classifyHttpError,
  validateProviderConfig,
  upstreamErrorMessage,
} from "./errors.js";
import {
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  createAnthropicStreamAssembler,
} from "../messages/anthropic.js";
import { resolveProviderTimeouts } from "./payload.js";
import { createProviderTimeoutContext } from "./timeout.js";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function truncateBody(bodyText) {
  return String(bodyText ?? "").slice(0, 500);
}

function parseJson(bodyText) {
  try {
    return { parsed: true, value: JSON.parse(bodyText) };
  } catch {
    return { parsed: false, value: undefined };
  }
}

function timeoutError(cause, { phase = "request", elapsedMs } = {}) {
  return new KitError("timeout", "Request timed out", {
    retryable: true,
    phase,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readResponseBody(response) {
  if (typeof response?.text === "function") return response.text();
  if (typeof response?.json === "function") {
    const value = await response.json();
    return JSON.stringify(value);
  }
  return "";
}

function serverError(bodyText) {
  return new KitError("server", upstreamErrorMessage(bodyText));
}

function parseSseEvent(eventType, dataLines) {
  if (dataLines.length === 0) return undefined;
  const text = dataLines.join("\n");
  if (text === "[DONE]") return undefined;

  const { parsed, value } = parseJson(text);
  if (!parsed || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KitError("server", truncateBody(text));
  }

  const type = eventType || value.type;
  if (type === "error" || value.type === "error") {
    throw serverError(JSON.stringify(value));
  }
  return { type, data: value };
}

async function readSseBody(response, assembler, context, timeouts) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw new KitError("server", "Anthropic response is missing a stream body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let dataLines = [];

  const dispatch = () => {
    const event = parseSseEvent(eventType, dataLines);
    if (event !== undefined) assembler.push(event.type, event.data);
    eventType = "";
    dataLines = [];
  };

  const processLine = (line) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized === "") {
      dispatch();
    } else if (normalized.startsWith(":")) {
      return;
    } else if (normalized.startsWith("event:")) {
      eventType = normalized.slice(6).trim();
    } else if (normalized.startsWith("data:")) {
      const data = normalized.slice(5);
      dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
    }
  };

  let firstByteSeen = false;
  context.beginStream();
  while (true) {
    const streamPhase = firstByteSeen ? "streamIdle" : "firstByte";
    const entries = [{
      phase: streamPhase,
      duration: firstByteSeen
        ? timeouts.streamIdleTimeoutMs
        : timeouts.firstByteTimeoutMs,
    }];
    const totalRemaining = timeouts.streamTotalTimeoutMs === undefined
      ? undefined
      : timeouts.streamTotalTimeoutMs - context.streamElapsedMs();
    if (totalRemaining !== undefined) {
      entries.push({ phase: "streamTotal", duration: Math.max(0, totalRemaining) });
    }
    const result = await context.race(reader.read(), entries);
    if (result.value && result.value.byteLength > 0) firstByteSeen = true;
    const text = decoder.decode(result.value, { stream: !result.done });
    buffer += text;

    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      processLine(buffer.slice(0, lineEnd));
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf("\n");
    }

    if (result.done) break;
  }

  buffer += decoder.decode();
  if (buffer.length > 0) processLine(buffer);
  if (dataLines.length > 0) dispatch();
}

function createRequestContext(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  let externalFailure;
  let timer;
  let removeExternalListener;
  let rejectExternal;
  const abortPromise = new Promise((_, reject) => {
    rejectExternal = reject;
  });
  abortPromise.catch(() => {});

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError(undefined, {
        phase: "request",
        elapsedMs: Date.now() - startedAt,
      }));
    }, timeoutMs);
  });

  if (externalSignal) {
    const abort = () => {
      externalFailure = externalSignal.reason instanceof Error
        ? externalSignal.reason
        : (() => {
            const error = new Error(externalSignal.reason === undefined
              ? "The operation was aborted"
              : String(externalSignal.reason));
            error.name = "AbortError";
            return error;
          })();
      controller.abort(externalFailure);
      rejectExternal(externalFailure);
    };
    if (externalSignal.aborted) {
      abort();
    } else {
      externalSignal.addEventListener("abort", abort, { once: true });
      removeExternalListener = () => externalSignal.removeEventListener("abort", abort);
    }
  }

  return {
    controller,
    timeoutPromise,
    abortPromise,
    didTimeout: () => timedOut,
    didExternalAbort: () => externalFailure !== undefined,
    externalError: () => externalFailure,
    elapsedMs: () => Date.now() - startedAt,
    dispose() {
      clearTimeout(timer);
      removeExternalListener?.();
    },
  };
}

/**
 * @param {{
 *   endpoint:string,
 *   apiKey:string,
 *   model:string,
 *   fetchImpl?:typeof fetch,
 *   timeoutMs?:number,
 * }} options
 * @returns {{protocol:"anthropic", model:string, chat:Function, chatStream:Function}}
 */
export function createAnthropicProvider({
  endpoint,
  apiKey,
  model,
  model_name,
  fetchImpl = fetch,
  timeoutMs,
  timeout: timeoutOption,
  requestTimeoutMs,
  request_timeout_ms,
  requestTimeout: requestTimeoutOption,
  firstByteTimeoutMs,
  first_byte_timeout_ms,
  firstByteTimeout,
  streamIdleTimeoutMs,
  stream_idle_timeout_ms,
  streamIdleTimeout,
  streamTotalTimeoutMs,
  stream_total_timeout_ms,
  streamTotalTimeout,
  timeouts,
  clock,
  maxTokens,
  maxOutputTokens,
  temperature,
  topP,
  thinking,
  reasoning,
  reasoning_effort,
  enable_thinking,
  chat_template_kwargs,
  providerOptions,
  frequency_penalty,
  presence_penalty,
  response_format,
  protocol = "anthropic",
  model_type,
  supports_reasoning,
  thinking_format,
} = {}) {
  const selectedModel = model ?? model_name;
  validateProviderConfig("Anthropic", { endpoint, apiKey, model: selectedModel });
  const providerTimeoutOptions = {
    timeout: timeoutOption,
    timeoutMs,
    requestTimeoutMs,
    request_timeout_ms,
    requestTimeout: requestTimeoutOption,
    firstByteTimeoutMs,
    first_byte_timeout_ms,
    firstByteTimeout,
    streamIdleTimeoutMs,
    stream_idle_timeout_ms,
    streamIdleTimeout,
    streamTotalTimeoutMs,
    stream_total_timeout_ms,
    streamTotalTimeout,
    timeouts,
  };
  const providerTimeouts = resolveProviderTimeouts(providerTimeoutOptions);
  const requestTimeout = providerTimeouts.requestTimeoutMs;
  const requestDefaults = {
    maxTokens: maxTokens ?? maxOutputTokens ?? 4096,
    temperature,
    topP,
    thinking,
    reasoning,
    reasoning_effort,
    enable_thinking,
    chat_template_kwargs,
    providerOptions,
    frequency_penalty,
    presence_penalty,
    response_format,
  };
  const base = String(endpoint).replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  function requestWithDefaults(req, stream = false) {
    const request = { ...requestDefaults };
    for (const [key, value] of Object.entries(req ?? {})) {
      if (value !== undefined) request[key] = value;
    }
    if (req?.maxTokens == null && requestDefaults.maxTokens !== undefined) {
      request.maxTokens = requestDefaults.maxTokens;
    }
    request.model = selectedModel;
    if (stream) request.stream = true;
    return request;
  }

  async function chat(req) {
    const payload = canonicalToAnthropicRequest(requestWithDefaults(req));
    const context = createRequestContext(requestTimeout, req?.signal);

    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: context.controller.signal,
        }),
        context.timeoutPromise,
        context.abortPromise,
      ]);
      if (context.didExternalAbort()) throw context.externalError();
      if (context.didTimeout()) {
        throw timeoutError(undefined, {
          phase: "request",
          elapsedMs: context.elapsedMs(),
        });
      }

      const bodyText = String(await Promise.race([
        readResponseBody(response),
        context.timeoutPromise,
        context.abortPromise,
      ]) ?? "");
      if (context.didExternalAbort()) throw context.externalError();
      if (context.didTimeout()) {
        throw timeoutError(undefined, {
          phase: "request",
          elapsedMs: context.elapsedMs(),
        });
      }

      const { parsed, value } = parseJson(bodyText);
      const status = Number(response?.status);
      if (status < 200 || status >= 300) {
        throw classifyHttpError(status, bodyText, {
          phase: "request",
          elapsedMs: context.elapsedMs(),
        });
      }
      if (
        !parsed
        || value === null
        || typeof value !== "object"
        || Array.isArray(value)
      ) {
        throw new KitError("server", truncateBody(bodyText));
      }
      if (value.type === "error") throw serverError(bodyText);
      if (!hasOwn(value, "content") || !Array.isArray(value.content)) {
        throw new KitError("server", truncateBody(bodyText));
      }

      return anthropicResponseToCanonical(value);
    } catch (err) {
      if (context.didExternalAbort()) throw context.externalError();
      if (err instanceof KitError) throw err;
      if (context.didTimeout()) {
        throw timeoutError(err, {
          phase: "request",
          elapsedMs: context.elapsedMs(),
        });
      }
      throw classifyFetchException(err, { signal: req?.signal });
    } finally {
      context.dispose();
    }
  }

  async function chatStream(req) {
    const payload = canonicalToAnthropicRequest(requestWithDefaults(req, true));
    const requestTimeouts = resolveProviderTimeouts({
      ...providerTimeoutOptions,
      ...req,
    });
    const context = createProviderTimeoutContext({
      timeouts: requestTimeouts,
      externalSignal: req?.signal,
      clock: req?.clock ?? clock,
    });
    let status;
    let streamPhase = "request";

    try {
      context.throwIfAborted();
      const response = await context.race(
        fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: context.controller.signal,
        }),
        [{ phase: "request", duration: requestTimeouts.requestTimeoutMs }],
      );
      context.throwIfAborted();

      status = Number(response?.status);
      if (status < 200 || status >= 300) {
        const bodyText = String(await context.race(
          readResponseBody(response),
          [{ phase: "request", duration: requestTimeouts.requestTimeoutMs }],
        ) ?? "");
        context.throwIfAborted();
        throw classifyHttpError(status, bodyText, {
          phase: "request",
          elapsedMs: context.elapsedMs(),
        });
      }

      const deltas = [];
      const onDelta = typeof req?.onDelta === "function"
        ? req.onDelta
        : (text) => deltas.push(text);
      const assembler = createAnthropicStreamAssembler({
        onDelta,
        onReasoningDelta: req?.onReasoningDelta,
        onToolCall: req?.onToolCall,
        onUsage: req?.onUsage,
        onEvent: req?.onEvent,
      });
      streamPhase = "firstByte";
      await readSseBody(response, assembler, context, requestTimeouts);
      return assembler.finish();
    } catch (err) {
      if (context.didExternalAbort()) throw context.externalError();
      if (context.didTimeout()) throw context.timeoutError();
      if (err instanceof KitError) throw err;
      throw classifyFetchException(err, {
        phase: streamPhase,
        elapsedMs: context.elapsedMs(),
        signal: req?.signal,
        ...(status === undefined ? {} : { status }),
      });
    } finally {
      context.dispose();
    }
  }

  return {
    protocol,
    model: selectedModel,
    chat,
    chatStream,
    ...(model_type === undefined ? {} : { model_type }),
    ...(supports_reasoning === undefined ? {} : { supports_reasoning }),
    ...(thinking_format === undefined ? {} : { thinking_format }),
  };
}
