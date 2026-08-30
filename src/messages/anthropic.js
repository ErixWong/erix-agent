/**
 * @typedef {import("./canonical.js").Block} Block
 */

import { applyProviderPayloadOptions } from "../providers/payload.js";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceFromDataUrl(value) {
  if (typeof value !== "string") return undefined;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) return undefined;
  return { type: "base64", media_type: match[1], data: match[2] };
}

function canonicalImageSource(block) {
  const source = isRecord(block?.source) ? { ...block.source } : {};
  if (Object.keys(source).length > 0) return source;

  const imageUrl = isRecord(block?.image_url) ? block.image_url : {};
  const url = imageUrl.url ?? block?.url;
  const dataUrlSource = sourceFromDataUrl(url);
  if (dataUrlSource !== undefined) return dataUrlSource;
  if (url !== undefined) return { type: "url", url };

  const data = block?.base64 ?? block?.data;
  const directDataUrlSource = sourceFromDataUrl(data);
  if (directDataUrlSource !== undefined) return directDataUrlSource;
  if (typeof data === "string") {
    return {
      type: "base64",
      media_type: block?.mediaType
        ?? block?.mimeType
        ?? block?.media_type
        ?? block?.mime_type
        ?? "image/png",
      data: data.startsWith("data:") ? data.replace(/^data:[^;]+;base64,/, "") : data,
    };
  }
  return source;
}

function canonicalReasoningToAnthropic(block) {
  const { type: _type, text, ...metadata } = block;
  return { type: "thinking", thinking: String(text ?? ""), ...metadata };
}

function rawReasoningText(block) {
  if (block?.type !== "raw" || !isRecord(block.payload)) return undefined;
  if (block.payload.kind === "reasoning") return block.payload.text;
  if (typeof block.payload.reasoning_content === "string") {
    return block.payload.reasoning_content;
  }
  return undefined;
}

function canonicalBlockToAnthropic(block) {
  if (block?.type === "text") {
    return { type: "text", text: String(block.text ?? "") };
  }
  if (block?.type === "image") {
    return { type: "image", source: canonicalImageSource(block) };
  }
  if (block?.type === "reasoning") return canonicalReasoningToAnthropic(block);
  if (block?.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    };
  }
  if (block?.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: block.content,
      ...(block.is_error === undefined ? {} : { is_error: Boolean(block.is_error) }),
    };
  }
  if (block?.type === "raw") {
    const reasoning = rawReasoningText(block);
    if (reasoning !== undefined) {
      return { type: "thinking", thinking: String(reasoning) };
    }
    if (block.protocol === "anthropic") return block.payload;
    return block;
  }
  return block;
}

function messageContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content.map(canonicalBlockToAnthropic);
  throw new TypeError("Anthropic message content must be a string or block array");
}

function usageFromResponse(source) {
  if (source == null || typeof source !== "object") return undefined;

  const usage = {};
  if (source.input_tokens !== undefined) usage.input_tokens = source.input_tokens;
  if (source.output_tokens !== undefined) usage.output_tokens = source.output_tokens;
  return usage;
}

/**
 * Convert canonical messages into an Anthropic Messages API request.
 *
 * @param {{
 *   model:string,
 *   system?:string,
 *   messages?:Array<{role:string, content:string|Block[]}>,
 *   tools?:Array<{name:string, description?:string, inputSchema:object}>,
 *   maxTokens:number,
 *   temperature?:number,
 *   topP?:number,
 *   stream?:boolean,
 *   thinking?:object,
 *   reasoning?:object,
 *   reasoning_effort?:string,
 *   enable_thinking?:boolean,
 *   chat_template_kwargs?:object,
 *   providerOptions?:object,
 *   frequency_penalty?:number,
 *   presence_penalty?:number,
 *   response_format?:object,
 * }} request
 * @returns {object}
 */
export function canonicalToAnthropicRequest({
  model,
  system,
  messages = [],
  tools,
  maxTokens,
  temperature,
  topP,
  stream,
  thinking,
  reasoning,
  reasoning_effort,
  enable_thinking,
  chat_template_kwargs,
  providerOptions,
  frequency_penalty,
  presence_penalty,
  response_format,
}) {
  if (maxTokens === undefined || maxTokens === null) {
    throw new TypeError("maxTokens is required for Anthropic requests");
  }
  if (!Array.isArray(messages)) {
    throw new TypeError("Anthropic messages must be an array");
  }
  if (tools !== undefined && !Array.isArray(tools)) {
    throw new TypeError("Anthropic tools must be an array");
  }

  const payload = {
    model,
    messages: messages.map((message) => ({
      role: message?.role,
      content: messageContent(message?.content),
    })),
    max_tokens: maxTokens,
  };

  if (system !== undefined) payload.system = system;
  if (tools?.length) {
    payload.tools = tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.inputSchema,
    }));
  }
  if (temperature !== undefined) payload.temperature = temperature;
  if (topP !== undefined) payload.top_p = topP;
  if (stream !== undefined) payload.stream = stream;
  applyProviderPayloadOptions(payload, {
    thinking,
    reasoning,
    reasoning_effort,
    enable_thinking,
    chat_template_kwargs,
    providerOptions,
    frequency_penalty,
    presence_penalty,
    response_format,
  }, "anthropic");

  return payload;
}

/**
 * Convert an Anthropic Messages API response into the canonical response.
 *
 * @param {object} json
 * @returns {{content:Block[], stopReason:string, usage?:{input_tokens?:number, output_tokens?:number}}}
 */
export function anthropicResponseToCanonical(json) {
  if (!Array.isArray(json?.content)) {
    throw new Error("Anthropic response is missing content");
  }

  const response = {
    content: json.content.map((block) => {
      if (block?.type === "text") {
        return { type: "text", text: String(block.text ?? "") };
      }
      if (block?.type === "thinking") {
        const { type: _type, thinking, ...metadata } = block;
        return {
          type: "reasoning",
          text: String(thinking ?? ""),
          ...metadata,
        };
      }
      if (block?.type === "image") {
        const source = isRecord(block.source) ? block.source : {};
        const { type: _type, source: _source, ...blockMetadata } = block;
        if (source.type === "url" && source.url !== undefined) {
          const { type: _type, url, ...metadata } = source;
          return {
            type: "image",
            url,
            ...metadata,
            ...blockMetadata,
          };
        }
        if (source.type === "base64" && source.data !== undefined) {
          const {
            type: _type,
            data,
            media_type: mediaType,
            ...metadata
          } = source;
          return {
            type: "image",
            base64: data,
            ...(mediaType === undefined ? {} : { mediaType }),
            ...metadata,
            ...blockMetadata,
          };
        }
        return { type: "image", source: block.source, ...blockMetadata };
      }
      if (block?.type === "tool_use") {
        const { type: _type, id, name, input, ...metadata } = block;
        return {
          type: "tool_use",
          id,
          name,
          input: input ?? {},
          ...metadata,
        };
      }
      if (block?.type === "tool_result") {
        const { type: _type, tool_use_id, content, is_error, ...metadata } = block;
        return {
          type: "tool_result",
          tool_use_id,
          content,
          ...(is_error === undefined ? {} : { is_error: Boolean(is_error) }),
          ...metadata,
        };
      }
      return { type: "raw", protocol: "anthropic", payload: block };
    }),
    stopReason: json.stop_reason,
  };
  if (json.usage !== undefined && json.usage !== null) {
    response.usage = usageFromResponse(json.usage);
  }
  return response;
}

function parsedInput(partialJson) {
  try {
    return JSON.parse(partialJson);
  } catch {
    return { _raw: partialJson };
  }
}

/**
 * Assemble Anthropic server-sent events into a canonical response.
 *
 * @param {(delta:string)=>void|{
 *   onDelta?:(delta:string)=>void,
 *   onReasoningDelta?:(delta:string, metadata?:object)=>void,
 *   onToolCall?:(fragment:object)=>void,
 *   onUsage?:(usage:object)=>void,
 *   onEvent?:(event:object)=>void
 * }} [callbacks]
 * @returns {{
 *   push:(eventType:string, data:object|string)=>void,
 *   finish:()=>{content:Block[], stopReason:string, usage?:{input_tokens?:number, output_tokens?:number}}
 * }}
 */
export function createAnthropicStreamAssembler(callbacks) {
  const options = typeof callbacks === "function" ? { onDelta: callbacks } : callbacks ?? {};
  const {
    onDelta,
    onReasoningDelta,
    onToolCall,
    onUsage,
    onEvent,
  } = options;
  const blockStates = [];
  const usage = {};
  let hasUsage = false;
  let stopReason;
  let nextImplicitIndex = 0;
  let usageEmitted = false;

  function addUsage(source) {
    if (source == null || typeof source !== "object") return;
    if (source.input_tokens !== undefined) {
      usage.input_tokens = source.input_tokens;
      hasUsage = true;
    }
    if (source.output_tokens !== undefined) {
      usage.output_tokens = source.output_tokens;
      hasUsage = true;
    }
  }

  function blockIndex(data) {
    if (Number.isInteger(data?.index)) return data.index;
    while (blockStates[nextImplicitIndex] !== undefined) nextImplicitIndex += 1;
    const index = nextImplicitIndex;
    nextImplicitIndex += 1;
    return index;
  }

  function ensureState(index, type) {
    if (blockStates[index] !== undefined) return blockStates[index];

    const block = type === "tool_use"
      ? { type: "tool_use", input: {} }
      : type === "thinking" || type === "reasoning"
        ? { type: "reasoning", text: "" }
        : { type: "text", text: "" };
    const state = {
      block,
      type,
      partialJson: "",
      hasJsonDelta: false,
    };
    blockStates[index] = state;
    return state;
  }

  function push(eventType, rawData) {
    let data = rawData;
    if (typeof data === "string") data = JSON.parse(data);
    if (data == null || typeof data !== "object") return;

    if (eventType === "message_start") {
      addUsage(data.usage);
      addUsage(data.message?.usage);
      return;
    }

    if (eventType === "content_block_start") {
      const source = data.content_block ?? {};
      const index = blockIndex(data);
      const type = source.type === "tool_use"
        ? "tool_use"
        : source.type === "thinking" || source.type === "reasoning"
          ? "reasoning"
          : source.type;
      const state = ensureState(index, type);

      if (type === "tool_use") {
        state.block = {
          type: "tool_use",
          id: source.id,
          name: source.name,
          input: source.input ?? {},
        };
        onToolCall?.({
          index,
          ...(source.id === undefined ? {} : { id: source.id }),
          ...(source.name === undefined ? {} : { name: String(source.name) }),
        });
        onEvent?.({
          type: "tool_call",
          index,
          ...(source.id === undefined ? {} : { id: source.id }),
          ...(source.name === undefined ? {} : { name: String(source.name) }),
        });
      } else if (type === "text") {
        state.block = {
          type: "text",
          text: typeof source.text === "string" ? source.text : "",
        };
      } else if (type === "reasoning") {
        state.block = {
          type: "reasoning",
          text: typeof source.thinking === "string"
            ? source.thinking
            : typeof source.text === "string"
              ? source.text
              : "",
          ...(source.signature === undefined ? {} : { signature: source.signature }),
        };
      } else {
        state.block = { ...source };
      }
      state.type = type;
      return;
    }

    if (
      eventType === "content_block_delta"
      || eventType === "thinking_delta"
      || eventType === "thinking_delta.snapshot"
      || eventType === "signature"
      || eventType === "signature_delta"
    ) {
      const delta = data.delta ?? (
        eventType === "content_block_delta" ? {} : { ...data, type: eventType }
      );
      const index = blockIndex(data);

      if (delta.type === "text_delta") {
        const state = ensureState(index, "text");
        const text = typeof delta.text === "string" ? delta.text : "";
        state.block.type = "text";
        state.block.text = `${state.block.text ?? ""}${text}`;
        onDelta?.(text);
        onEvent?.({ type: "delta", delta: text });
      } else if (
        delta.type === "thinking_delta"
        || delta.type === "thinking_delta.snapshot"
      ) {
        const state = ensureState(index, "reasoning");
        const snapshot = delta.type.endsWith(".snapshot") || delta.snapshot === true;
        const value = typeof delta.thinking === "string"
          ? delta.thinking
          : typeof delta.text === "string"
            ? delta.text
            : typeof delta.snapshot === "string"
              ? delta.snapshot
              : "";
        const previous = String(state.block.text ?? "");
        const fragment = snapshot && value.startsWith(previous)
          ? value.slice(previous.length)
          : value;
        state.type = "reasoning";
        state.block.type = "reasoning";
        state.block.text = snapshot ? value : `${previous}${value}`;
        if (fragment.length > 0) {
          onReasoningDelta?.(fragment);
          onEvent?.({ type: "reasoning_delta", delta: fragment });
        }
      } else if (delta.type === "signature_delta" || delta.type === "signature") {
        const state = ensureState(index, "reasoning");
        const signature = typeof delta.signature === "string" ? delta.signature : "";
        state.type = "reasoning";
        state.block.type = "reasoning";
        if (signature.length > 0) state.block.signature = signature;
        onEvent?.({
          type: "reasoning_delta",
          delta: "",
          ...(signature.length > 0 ? { signature } : {}),
        });
      } else if (delta.type === "input_json_delta") {
        const state = ensureState(index, "tool_use");
        state.type = "tool_use";
        const partial = typeof delta.partial_json === "string" ? delta.partial_json : "";
        state.partialJson += partial;
        state.hasJsonDelta = true;
        const fragment = {
          index,
          ...(state.block.id === undefined ? {} : { id: state.block.id }),
          ...(state.block.name === undefined ? {} : { name: String(state.block.name) }),
          ...(partial.length > 0 ? { argumentsDelta: partial } : {}),
        };
        onToolCall?.(fragment);
        onEvent?.({ type: "tool_call", ...fragment });
      }
      return;
    }

    if (eventType === "content_block_stop") {
      const index = blockIndex(data);
      const state = blockStates[index];
      if (state?.type === "tool_use" && state.hasJsonDelta) {
        state.block.input = parsedInput(state.partialJson);
      }
      if (state?.type === "reasoning" && data.signature !== undefined) {
        state.block.signature = data.signature;
      }
      return;
    }

    if (eventType === "message_delta") {
      const delta = data.delta ?? data;
      if (hasOwn(delta, "stop_reason")) stopReason = delta.stop_reason;
      addUsage(data.usage);
      addUsage(delta.usage);
      return;
    }

    if (eventType === "message_stop") {
      if (hasOwn(data, "stop_reason")) stopReason = data.stop_reason;
      addUsage(data.usage);
    }
  }

  function finish() {
    for (const state of blockStates) {
      if (state?.type === "tool_use" && state.hasJsonDelta) {
        state.block.input = parsedInput(state.partialJson);
      }
    }
    const content = blockStates
      .filter((state) => state !== undefined)
      .map((state) => state.block);
    const response = {
      content,
      stopReason,
      ...(hasUsage ? { usage } : {}),
    };
    if (hasUsage && !usageEmitted) {
      usageEmitted = true;
      onUsage?.(usage);
      onEvent?.({ type: "usage", usage });
    }
    return response;
  }

  return { push, finish };
}
