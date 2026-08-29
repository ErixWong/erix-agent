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

export function createOpenAIProvider({
  endpoint,
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 120000,
}) {
  const url = `${String(endpoint).replace(/\/+$/, "")}/chat/completions`;

  async function chat(req) {
    const payload = {
      model,
      messages: canonicalToOpenAIMessages(req.system, req.messages),
    };
    if (req.tools?.length) payload.tools = canonicalToolsToOpenAI(req.tools);
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.topP !== undefined) payload.top_p = req.topP;

    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, timeoutMs);
    });

    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);

      if (timedOut) throw timeoutError();
      const bodyText = String(await Promise.race([
        readResponseBody(response),
        timeoutPromise,
      ]) ?? "");
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
      clearTimeout(timer);
    }
  }

  return {
    protocol: "openai",
    model,
    chat,
    async chatStream() {
      throw new KitError("unknown", "chatStream 未实现（v0.1）");
    },
  };
}
