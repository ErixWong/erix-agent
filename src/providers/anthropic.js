import {
  KitError,
  classifyFetchException,
  classifyHttpError,
  upstreamErrorMessage,
} from "./errors.js";
import {
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  createAnthropicStreamAssembler,
} from "../messages/anthropic.js";

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

function timeoutError(cause) {
  return new KitError("timeout", "Request timed out", {
    retryable: true,
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

async function readSseBody(response, assembler, timeoutPromise) {
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

  while (true) {
    const result = await Promise.race([reader.read(), timeoutPromise]);
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
  let timedOut = false;
  let timer;
  let removeExternalListener;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });

  if (externalSignal) {
    const abort = () => controller.abort(externalSignal.reason);
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
    didTimeout: () => timedOut,
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
  fetchImpl = fetch,
  timeoutMs = 120000,
}) {
  const base = String(endpoint).replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  async function chat(req) {
    const payload = canonicalToAnthropicRequest({ ...req, model });
    const context = createRequestContext(timeoutMs, req?.signal);

    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: context.controller.signal,
        }),
        context.timeoutPromise,
      ]);
      if (context.didTimeout()) throw timeoutError();

      const bodyText = String(await Promise.race([
        readResponseBody(response),
        context.timeoutPromise,
      ]) ?? "");
      if (context.didTimeout()) throw timeoutError();

      const { parsed, value } = parseJson(bodyText);
      const status = Number(response?.status);
      if (status < 200 || status >= 300) {
        throw classifyHttpError(status, bodyText);
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
      if (err instanceof KitError) throw err;
      if (context.didTimeout()) throw timeoutError(err);
      throw classifyFetchException(err);
    } finally {
      context.dispose();
    }
  }

  async function chatStream(req) {
    const payload = canonicalToAnthropicRequest({ ...req, model, stream: true });
    const context = createRequestContext(timeoutMs, req?.signal);

    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: context.controller.signal,
        }),
        context.timeoutPromise,
      ]);
      if (context.didTimeout()) throw timeoutError();

      const status = Number(response?.status);
      if (status < 200 || status >= 300) {
        const bodyText = String(await Promise.race([
          readResponseBody(response),
          context.timeoutPromise,
        ]) ?? "");
        if (context.didTimeout()) throw timeoutError();
        throw classifyHttpError(status, bodyText);
      }

      const deltas = [];
      const onDelta = typeof req?.onDelta === "function"
        ? req.onDelta
        : (text) => deltas.push(text);
      const assembler = createAnthropicStreamAssembler(onDelta);
      await readSseBody(response, assembler, context.timeoutPromise);
      return assembler.finish();
    } catch (err) {
      if (err instanceof KitError) throw err;
      if (context.didTimeout()) throw timeoutError(err);
      throw classifyFetchException(err);
    } finally {
      context.dispose();
    }
  }

  return {
    protocol: "anthropic",
    model,
    chat,
    chatStream,
  };
}
