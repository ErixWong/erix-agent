import {
  KitError,
  classifyFetchException,
  classifyHttpError,
  upstreamErrorMessage,
} from "./errors.js";
import {
  canonicalToOpenAIMessages,
  canonicalToolsToOpenAI,
  openAIResponseToCanonical,
} from "../messages/canonical.js";
import {
  applyProviderPayloadOptions,
  resolveProviderTimeout,
} from "./payload.js";

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

function timeoutError(cause) {
  return new KitError("timeout", "Request timed out", {
    retryable: true,
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

export function createOpenAIProvider({
  endpoint,
  apiKey,
  model,
  model_name,
  fetchImpl = fetch,
  timeoutMs,
  timeout,
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
}) {
  const selectedModel = model ?? model_name;
  const requestTimeout = resolveProviderTimeout(timeout, timeoutMs);
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
  const url = `${String(endpoint).replace(/\/+$/, "")}/chat/completions`;

  async function chat(req) {
    const payload = buildPayload(req, false, selectedModel, payloadDefaults);

    const controller = new AbortController();
    const signal = req?.signal;
    let timedOut = false;
    let timer;
    let removeAbortListener;
    let rejectAbort;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, requestTimeout);
    });
    const abortPromise = signal
      ? new Promise((_, reject) => {
        rejectAbort = () => reject(abortReason(signal));
      })
      : undefined;
    const raceRequest = (promise) => Promise.race([
      promise,
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const reason = abortReason(signal);
      if (reason instanceof KitError) throw reason;
      throw classifyFetchException(reason);
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
        fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
      );

      throwIfAborted();
      if (timedOut) throw timeoutError();
      const bodyText = String(await raceRequest(
        readResponseBody(response),
      ) ?? "");
      if (timedOut) throw timeoutError();

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
      if (hasOwn(value, "error")) {
        throw new KitError("server", upstreamErrorMessage(bodyText));
      }
      if (!Array.isArray(value.choices) || value.choices.length === 0) {
        throw new KitError("server", truncateBody(bodyText));
      }

      return openAIResponseToCanonical(value);
    } catch (err) {
      if (err instanceof KitError) throw err;
      if (timedOut) throw timeoutError(err);
      throw classifyFetchException(err);
    } finally {
      removeAbortListener?.();
      clearTimeout(timer);
    }
  }

  async function chatStream(req = {}) {
    const { onDelta, signal } = req;
    const payload = buildPayload(req, true, selectedModel, payloadDefaults);
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    let removeAbortListener;
    let rejectAbort;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, requestTimeout);
    });
    const abortPromise = signal
      ? new Promise((_, reject) => {
        rejectAbort = () => reject(abortReason(signal));
      })
      : undefined;
    const raceRequest = (promise) => Promise.race([
      promise,
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const reason = abortReason(signal);
      if (reason instanceof KitError) throw reason;
      throw classifyFetchException(reason);
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

    let reader;
    try {
      throwIfAborted();
      const response = await raceRequest(fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }));

      throwIfAborted();
      if (timedOut) throw timeoutError();
      const status = Number(response?.status);
      if (status < 200 || status >= 300) {
        const bodyText = String(await raceRequest(readResponseBody(response)) ?? "");
        if (timedOut) throw timeoutError();
        throw classifyHttpError(status, bodyText);
      }

      if (typeof response?.body?.getReader !== "function") {
        const bodyText = String(await raceRequest(readResponseBody(response)) ?? "");
        if (timedOut) throw timeoutError();
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
      let finishReason;
      let lastUsage;
      let sawData = false;
      let streamDone = false;
      const toolSlots = [];

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
          onDelta?.(delta.content);
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
          if (!functionDelta || typeof functionDelta !== "object") continue;
          if (functionDelta.name !== undefined) slot.name = functionDelta.name;
          if (functionDelta.arguments !== undefined) {
            slot.arguments = `${slot.arguments ?? ""}${String(functionDelta.arguments)}`;
          }
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
        const result = await raceRequest(reader.read());
        if (result.done) break;
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
      if (text.length > 0) content.push({ type: "text", text });
      for (const slot of toolSlots) {
        if (!slot) continue;
        const rawArguments = slot.arguments === undefined ? "{}" : slot.arguments;
        let input;
        try {
          input = JSON.parse(rawArguments);
        } catch {
          input = { _raw: rawArguments };
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
      }
      return chatResponse;
    } catch (err) {
      if (err instanceof KitError) throw err;
      if (timedOut) throw timeoutError(err);
      throw classifyFetchException(err);
    } finally {
      if (reader) reader.releaseLock();
      removeAbortListener?.();
      clearTimeout(timer);
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
