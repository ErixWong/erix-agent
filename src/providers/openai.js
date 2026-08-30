import {
  KitError,
  classifyFetchException,
  classifyHttpError,
  validateProviderConfig,
  upstreamErrorMessage,
} from "./errors.js";
import {
  canonicalToOpenAIMessages,
  canonicalToolsToOpenAI,
  openAIResponseToCanonical,
} from "../messages/canonical.js";
import {
  applyProviderPayloadOptions,
  resolveProviderTimeouts,
} from "./payload.js";
import { createProviderTimeoutContext } from "./timeout.js";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function truncateBody(bodyText) {
  return String(bodyText ?? "").slice(0, 500);
}

async function readResponseBody(response) {
  if (typeof response?.text === "function") {
    return response.text();
  }
  if (typeof response?.json === "function") {
    const value = await response.json();
    return JSON.stringify(value);
  }
  return "";
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

function buildPayload(req = {}, stream = false, model, defaults = {}) {
  const payload = {
    model,
    messages: canonicalToOpenAIMessages(req.system, req.messages),
  };
  if (req.tools?.length) payload.tools = canonicalToolsToOpenAI(req.tools);
  const maxTokens = req.maxTokens !== undefined
    ? req.maxTokens
    : defaults.maxTokens ?? defaults.maxOutputTokens;
  const temperature = req.temperature !== undefined ? req.temperature : defaults.temperature;
  const topP = req.topP !== undefined ? req.topP : defaults.topP;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;
  if (temperature !== undefined) payload.temperature = temperature;
  if (topP !== undefined) payload.top_p = topP;
  applyProviderPayloadOptions(payload, req, "openai", defaults);
  if (stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  return payload;
}

function normalizeFinishReason(finishReason) {
  const stopMap = {
    stop: "end_turn",
    tool_calls: "tool_use",
    length: "max_tokens",
  };
  return finishReason == null ? "unknown" : stopMap[finishReason] ?? finishReason;
}

function eventBoundary(text) {
  const match = /\r?\n\r?\n/.exec(text);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function fetchOptionsWithTransport(options, transport) {
  if (transport === undefined) return options;
  if (typeof transport === "function") {
    const enhanced = transport(options);
    if (enhanced === undefined) return options;
    if (enhanced === null || typeof enhanced !== "object") {
      throw new TypeError("transport fetch-options enhancer must return an object");
    }
    return enhanced;
  }
  return { ...options, dispatcher: transport };
}

export function createOpenAIProvider({
  endpoint,
  apiKey,
  model,
  model_name,
  fetchImpl = fetch,
  transport,
  contextWindowTokens,
  timeoutMs,
  timeout,
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
  protocol = "openai",
  model_type,
  supports_reasoning,
  thinking_format,
} = {}) {
  const selectedModel = model ?? model_name;
  validateProviderConfig("OpenAI", { endpoint, apiKey, model: selectedModel });
  const providerTimeoutOptions = {
    timeout,
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
  const payloadDefaults = {
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
  };
  const base = String(endpoint).replace(/\/+$/, "");
  const url = base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;

  async function chat(req) {
    const payload = buildPayload(req, false, selectedModel, payloadDefaults);

    const controller = new AbortController();
    const signal = req?.signal;
    const startedAt = Date.now();
    let timedOut = false;
    let timer;
    let removeAbortListener;
    let rejectAbort;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError(undefined, {
          phase: "request",
          elapsedMs: Date.now() - startedAt,
        }));
      }, requestTimeout);
    });
    const abortPromise = signal
      ? new Promise((_, reject) => {
        rejectAbort = () => reject(abortReason(signal));
      })
      : undefined;
    abortPromise?.catch(() => {});
    const raceRequest = (promise) => Promise.race([
      promise,
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const reason = abortReason(signal);
      throw reason;
    };

    if (signal) {
      const abort = () => {
        controller.abort(signal.reason);
        rejectAbort?.();
      };
      if (signal.aborted) {
        abort();
      } else if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", abort, { once: true });
        if (typeof signal.removeEventListener === "function") {
          removeAbortListener = () => signal.removeEventListener("abort", abort);
        }
      }
    }

    try {
      throwIfAborted();
      const response = await raceRequest(
        fetchImpl(url, fetchOptionsWithTransport({
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }, transport)),
      );

      throwIfAborted();
      if (timedOut) {
        throw timeoutError(undefined, {
          phase: "request",
          elapsedMs: Date.now() - startedAt,
        });
      }
      const bodyText = String(await raceRequest(
        readResponseBody(response),
      ) ?? "");
      if (timedOut) {
        throw timeoutError(undefined, {
          phase: "request",
          elapsedMs: Date.now() - startedAt,
        });
      }

      const { parsed, value } = parseJson(bodyText);
      const status = Number(response?.status);
      if (status < 200 || status >= 300) {
        throw classifyHttpError(status, bodyText, {
          phase: "request",
          elapsedMs: Date.now() - startedAt,
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
      if (hasOwn(value, "error")) {
        throw new KitError("server", upstreamErrorMessage(bodyText));
      }
      if (!Array.isArray(value.choices) || value.choices.length === 0) {
        throw new KitError("server", truncateBody(bodyText));
      }

      return openAIResponseToCanonical(value);
    } catch (err) {
      if (signal?.aborted) {
        throw classifyFetchException(abortReason(signal), { signal });
      }
      if (err instanceof KitError) throw err;
      if (timedOut) {
        throw timeoutError(err, {
          phase: "request",
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw classifyFetchException(err, { signal });
    } finally {
      removeAbortListener?.();
      clearTimeout(timer);
    }
  }

  async function chatStream(req = {}) {
    const { signal } = req;
    const payload = buildPayload(req, true, selectedModel, payloadDefaults);
    const requestTimeouts = resolveProviderTimeouts({
      ...providerTimeoutOptions,
      ...req,
    });
    const context = createProviderTimeoutContext({
      timeouts: requestTimeouts,
      externalSignal: signal,
      clock: req.clock ?? clock,
    });
    let reader;
    let status;
    let streamPhase = "request";
    try {
      context.throwIfAborted();
      const response = await context.race(fetchImpl(url, fetchOptionsWithTransport({
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: context.controller.signal,
      }, transport)), [{ phase: "request", duration: requestTimeouts.requestTimeoutMs }]);

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

      if (typeof response?.body?.getReader !== "function") {
        const bodyText = String(await context.race(
          readResponseBody(response),
          [{ phase: "request", duration: requestTimeouts.requestTimeoutMs }],
        ) ?? "");
        context.throwIfAborted();
        const { parsed, value } = parseJson(bodyText);
        if (parsed && value && typeof value === "object" && hasOwn(value, "error")) {
          throw new KitError("server", upstreamErrorMessage(bodyText));
        }
        throw new KitError("server", truncateBody(bodyText));
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawBody = "";
      let text = "";
      let reasoning = "";
      let finishReason;
      let lastUsage;
      let sawData = false;
      let streamDone = false;
      const toolSlots = [];
      let firstByteSeen = false;
      context.beginStream();
      streamPhase = "firstByte";

      const emitEvent = (event) => {
        req.onEvent?.(event);
      };

      const processEvent = (eventText) => {
        const dataLines = eventText
          .split("\n")
          .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6));
        if (dataLines.length === 0) return;

        sawData = true;
        const data = dataLines.join("\n");
        if (data === "[DONE]") {
          streamDone = true;
          return;
        }

        const { parsed, value } = parseJson(data);
        if (
          !parsed
          || value === null
          || typeof value !== "object"
          || Array.isArray(value)
        ) {
          throw new KitError("server", truncateBody(data));
        }
        if (hasOwn(value, "error")) {
          throw new KitError("server", upstreamErrorMessage(data));
        }

        if (value.usage != null) lastUsage = value.usage;
        const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
        if (!choice || typeof choice !== "object") return;

        if (choice.finish_reason != null) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta || typeof delta !== "object") return;

        if (typeof delta.content === "string") {
          text += delta.content;
          req.onDelta?.(delta.content);
          emitEvent({ type: "delta", delta: delta.content });
        }

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          reasoning += delta.reasoning_content;
          req.onReasoningDelta?.(delta.reasoning_content);
          emitEvent({ type: "reasoning_delta", delta: delta.reasoning_content });
        }

        if (!Array.isArray(delta.tool_calls)) return;
        for (const toolCall of delta.tool_calls) {
          if (!toolCall || typeof toolCall !== "object") continue;
          const requestedIndex = Number(toolCall.index);
          const index = Number.isInteger(requestedIndex) && requestedIndex >= 0
            ? requestedIndex
            : toolSlots.length;
          const slot = toolSlots[index] ?? {
            id: undefined,
            name: undefined,
            arguments: undefined,
          };
          toolSlots[index] = slot;

          if (toolCall.id !== undefined) slot.id = toolCall.id;
          const functionDelta = toolCall.function;
          if (functionDelta && typeof functionDelta === "object") {
            if (functionDelta.name !== undefined) slot.name = functionDelta.name;
            if (functionDelta.arguments !== undefined) {
              slot.arguments = `${slot.arguments ?? ""}${String(functionDelta.arguments)}`;
            }
          }

          const fragment = {
            index,
            ...(slot.id === undefined ? {} : { id: slot.id }),
            ...(!functionDelta || functionDelta.name === undefined
              ? {}
              : { name: String(functionDelta.name) }),
            ...(!functionDelta || functionDelta.arguments === undefined
              ? {}
              : { argumentsDelta: String(functionDelta.arguments) }),
          };
          req.onToolCall?.(fragment);
          emitEvent({ type: "tool_call", ...fragment });
        }
      };

      const processBuffer = () => {
        let boundary = eventBoundary(buffer);
        while (boundary) {
          const eventText = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          processEvent(eventText);
          if (streamDone) return;
          boundary = eventBoundary(buffer);
        }
      };

      while (!streamDone) {
        streamPhase = firstByteSeen ? "streamIdle" : "firstByte";
        const entries = [{
          phase: streamPhase,
          duration: firstByteSeen
            ? requestTimeouts.streamIdleTimeoutMs
            : requestTimeouts.firstByteTimeoutMs,
        }];
        const totalRemaining = requestTimeouts.streamTotalTimeoutMs === undefined
          ? undefined
          : requestTimeouts.streamTotalTimeoutMs - context.streamElapsedMs();
        if (totalRemaining !== undefined) {
          entries.push({ phase: "streamTotal", duration: Math.max(0, totalRemaining) });
        }
        const result = await context.race(reader.read(), entries);
        if (result.done) break;
        if (result.value && result.value.byteLength > 0) firstByteSeen = true;
        const chunk = decoder.decode(result.value, { stream: true });
        rawBody += chunk;
        buffer += chunk;
        processBuffer();
      }

      if (!streamDone) {
        const tail = decoder.decode();
        rawBody += tail;
        buffer += tail;
        processBuffer();
        if (!streamDone && buffer.length > 0) {
          processEvent(buffer);
          buffer = "";
        }
      }

      if (!sawData && rawBody.length > 0) {
        const { parsed, value } = parseJson(rawBody);
        if (parsed && value && typeof value === "object" && hasOwn(value, "error")) {
          throw new KitError("server", upstreamErrorMessage(rawBody));
        }
        throw new KitError("server", truncateBody(rawBody));
      }

      const content = [];
      if (reasoning.length > 0) content.push({ type: "reasoning", text: reasoning });
      if (text.length > 0) content.push({ type: "text", text });
      for (const slot of toolSlots) {
        if (!slot) continue;
        const rawArguments = slot.arguments === undefined ? "{}" : slot.arguments;
        let input;
        try {
          input = JSON.parse(rawArguments);
        } catch {
          input = {
            _truncatedArguments: rawArguments,
            _raw: rawArguments,
          };
        }
        content.push({
          type: "tool_use",
          id: slot.id,
          name: slot.name,
          input,
        });
      }

      const chatResponse = {
        content,
        stopReason: normalizeFinishReason(finishReason),
      };
      if (lastUsage != null) {
        chatResponse.usage = {};
        if (lastUsage.prompt_tokens !== undefined) {
          chatResponse.usage.input_tokens = lastUsage.prompt_tokens;
        }
        if (lastUsage.completion_tokens !== undefined) {
          chatResponse.usage.output_tokens = lastUsage.completion_tokens;
        }
        req.onUsage?.(lastUsage);
        emitEvent({ type: "usage", usage: lastUsage });
      }
      return chatResponse;
    } catch (err) {
      if (context.didExternalAbort()) throw context.externalError();
      if (context.didTimeout()) throw context.timeoutError();
      if (err instanceof KitError) throw err;
      throw classifyFetchException(err, {
        phase: streamPhase,
        elapsedMs: context.elapsedMs(),
        signal,
        ...(status === undefined ? {} : { status }),
      });
    } finally {
      if (reader) reader.releaseLock();
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
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}
