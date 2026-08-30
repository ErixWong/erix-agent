// 规范消息模型 + openai<->canonical 转换。

/**
 * A canonical content block.
 *
 * @typedef {(
 *   {type:"text", text:string} |
 *   {type:"image", url?:string, base64?:string, mediaType?:string, [key:string]:any} |
 *   {type:"reasoning", text:string, [key:string]:any} |
 *   {type:"tool_use", id:string, name:string, input:object, [key:string]:any} |
 *   {type:"tool_result", tool_use_id:string, content:string, is_error?:boolean, [key:string]:any} |
 *   {type:"raw", protocol:string, payload:any}
 * )} Block
 */

/**
 * @typedef {Object} CanonicalMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string|Block[]} content
 */

/**
 * @typedef {Object} ToolSchema
 * @property {string} name
 * @property {string} [description]
 * @property {object} inputSchema JSON Schema object accepted by the tool.
 */

/**
 * @typedef {Object} ChatResponse
 * @property {Block[]} content
 * @property {string} stopReason
 * @property {{input_tokens?:number, output_tokens?:number}} [usage]
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function safeJson(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function reasoningText(block) {
  if (block?.type === "reasoning" && typeof block.text === "string") {
    return block.text;
  }
  if (block?.type !== "raw" || !isRecord(block.payload)) return undefined;
  if (block.payload.kind === "reasoning" && typeof block.payload.text === "string") {
    return block.payload.text;
  }
  if (typeof block.payload.reasoning_content === "string") {
    return block.payload.reasoning_content;
  }
  return undefined;
}

function reasoningBlock(text, metadata = {}) {
  const { type: _type, text: _text, thinking: _thinking, ...rest } = metadata;
  return {
    type: "reasoning",
    text,
    ...rest,
  };
}

function dataUrlFromImage(block) {
  const source = isRecord(block?.source) ? block.source : {};
  const sourceData = source.data ?? source.base64;
  const base64 = block?.base64 ?? block?.data ?? sourceData;
  if (typeof base64 !== "string") return undefined;
  if (base64.startsWith("data:")) return base64;
  const mediaType = block?.mediaType
    ?? block?.mimeType
    ?? block?.media_type
    ?? block?.mime_type
    ?? source.media_type
    ?? source.mediaType
    ?? "image/png";
  return `data:${mediaType};base64,${base64}`;
}

function imageUrlFromCanonical(block) {
  const imageUrl = isRecord(block?.image_url) ? block.image_url : {};
  const source = isRecord(block?.source) ? block.source : {};
  return imageUrl.url
    ?? block?.url
    ?? source.url
    ?? dataUrlFromImage(block);
}

function canonicalImageToOpenAI(block) {
  const imageUrl = isRecord(block?.image_url) ? { ...block.image_url } : {};
  const providerImage = isRecord(block?.openai) ? block.openai : {};
  Object.assign(imageUrl, providerImage);
  const url = imageUrlFromCanonical(block);
  if (url !== undefined) imageUrl.url = url;
  if (block?.detail !== undefined && imageUrl.detail === undefined) {
    imageUrl.detail = block.detail;
  }
  return { type: "image_url", image_url: imageUrl };
}

function openAIImageToCanonical(part) {
  const source = isRecord(part?.image_url) ? part.image_url : {};
  const { type: _type, image_url: _imageUrl, ...metadata } = part;
  const image = { type: "image", ...metadata };
  if (source.url !== undefined) image.url = source.url;
  if (source.detail !== undefined) image.detail = source.detail;
  for (const [key, value] of Object.entries(source)) {
    if (key !== "url" && key !== "detail") image[key] = value;
  }
  return image;
}

function rawPayloadBlock(block) {
  if (block?.type !== "raw") return undefined;
  if (block.protocol === "openai" && isRecord(block.payload)) {
    return block.payload;
  }
  return undefined;
}

function rawToolCall(block) {
  const payload = rawPayloadBlock(block);
  return payload?.type === "function" && isRecord(payload.function) ? payload : undefined;
}

function openAIContentPartToCanonical(part) {
  if (!isRecord(part)) {
    return { type: "raw", protocol: "openai", payload: part };
  }
  if (part.type === "text") {
    return { type: "text", text: String(part.text ?? "") };
  }
  if (part.type === "image_url" || part.type === "image") {
    return part.type === "image_url" ? openAIImageToCanonical(part) : { ...part, type: "image" };
  }
  if (part.type === "reasoning" || part.type === "thinking") {
    return reasoningBlock(String(part.text ?? part.thinking ?? ""), {
      ...part,
    });
  }
  return { type: "raw", protocol: "openai", payload: part };
}

function contentPartsToOpenAI(parts, { emptyValue = null, textSeparator = "" } = {}) {
  if (parts.length === 0) return emptyValue;
  const hasNonText = parts.some((part) => part?.type !== "text");
  if (!hasNonText) return parts.map((part) => part.text).join(textSeparator);
  return parts.slice();
}

function appendRawBlocks(target, rawBlocks) {
  if (rawBlocks.length > 0) target.raw_blocks = rawBlocks.slice();
}

function appendReasoning(target, reasoningParts) {
  if (reasoningParts.length > 0) {
    target.reasoning_content = reasoningParts.join("");
  }
}

function assistantToOpenAI(message) {
  const parts = [];
  const toolCalls = [];
  const reasoningParts = [];
  const rawBlocks = [];

  for (const block of asBlocks(message?.content)) {
    if (block?.type === "text") {
      parts.push({ type: "text", text: String(block.text ?? "") });
    } else if (block?.type === "image") {
      parts.push(canonicalImageToOpenAI(block));
    } else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: block.providerType ?? "function",
        function: {
          name: block.name,
          arguments: safeJson(block.input ?? {}),
        },
      });
    } else if (block?.type === "reasoning"
      || (block?.type === "raw" && reasoningText(block) !== undefined)) {
      reasoningParts.push(
        block?.type === "reasoning" ? String(block.text ?? "") : reasoningText(block),
      );
    } else if (block?.type === "raw" && rawToolCall(block) !== undefined) {
      toolCalls.push(rawToolCall(block));
    } else if (block?.type === "raw") {
      const payload = rawPayloadBlock(block);
      if (payload?.type === "text" || payload?.type === "image_url") {
        parts.push(payload.type === "image_url" ? payload : { ...payload });
      } else {
        rawBlocks.push(block);
      }
    }
  }

  const serialized = {
    role: "assistant",
    content: contentPartsToOpenAI(parts, { emptyValue: null }),
  };
  if (toolCalls.length > 0) serialized.tool_calls = toolCalls;
  appendReasoning(serialized, reasoningParts);
  appendRawBlocks(serialized, rawBlocks);
  return serialized;
}

function systemToOpenAI(message) {
  const parts = [];
  const reasoningParts = [];
  const rawBlocks = [];
  for (const block of asBlocks(message?.content)) {
    if (block?.type === "text") parts.push({ type: "text", text: String(block.text ?? "") });
    else if (block?.type === "image") parts.push(canonicalImageToOpenAI(block));
    else if (block?.type === "reasoning"
      || (block?.type === "raw" && reasoningText(block) !== undefined)) {
      reasoningParts.push(
        block?.type === "reasoning" ? String(block.text ?? "") : reasoningText(block),
      );
    }
    else if (block?.type === "raw") rawBlocks.push(block);
  }
  const serialized = {
    role: "system",
    content: contentPartsToOpenAI(parts, { emptyValue: "", textSeparator: "\n" }),
  };
  appendReasoning(serialized, reasoningParts);
  appendRawBlocks(serialized, rawBlocks);
  return serialized;
}

function userToOpenAI(message, out) {
  const blocks = asBlocks(message?.content);
  const parts = [];
  const rawBlocks = [];
  const reasoningParts = [];
  let emitted = false;

  const flush = (force = false) => {
    if (!force && parts.length === 0 && rawBlocks.length === 0 && reasoningParts.length === 0) {
      return;
    }
    const serialized = {
      role: "user",
      content: contentPartsToOpenAI(parts, { emptyValue: "", textSeparator: "\n" }),
    };
    appendReasoning(serialized, reasoningParts);
    appendRawBlocks(serialized, rawBlocks);
    out.push(serialized);
    parts.length = 0;
    rawBlocks.length = 0;
    reasoningParts.length = 0;
    emitted = true;
  };

  for (const block of blocks) {
    if (block?.type === "text") {
      parts.push({ type: "text", text: String(block.text ?? "") });
    } else if (block?.type === "image") {
      parts.push(canonicalImageToOpenAI(block));
    } else if (block?.type === "reasoning" || (block?.type === "raw" && reasoningText(block) !== undefined)) {
      reasoningParts.push(block?.type === "reasoning" ? String(block.text ?? "") : reasoningText(block));
    } else if (block?.type === "tool_result") {
      flush();
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: block.content,
      });
      emitted = true;
    } else if (block?.type === "raw") {
      const payload = rawPayloadBlock(block);
      if (payload?.type === "text" || payload?.type === "image_url") {
        parts.push(payload.type === "image_url" ? payload : { ...payload });
      } else {
        rawBlocks.push(block);
      }
    }
  }

  flush(blocks.length === 0);
  return emitted;
}

/**
 * canonical -> OpenAI chat/completions messages.
 *
 * @param {string|undefined} system
 * @param {CanonicalMessage[]} messages
 * @returns {object[]}
 */
export function canonicalToOpenAIMessages(system, messages) {
  const out = [];
  if (typeof system === "string" && system.length > 0) {
    out.push({ role: "system", content: system });
  }

  for (const message of messages ?? []) {
    if (message?.role === "assistant") {
      out.push(assistantToOpenAI(message));
    } else if (message?.role === "system") {
      out.push(systemToOpenAI(message));
    } else if (message?.role === "user") {
      userToOpenAI(message, out);
    }
  }

  return out;
}

/**
 * 规范 ToolSchema[] -> openai tools[].
 *
 * @param {ToolSchema[]|undefined} tools
 * @returns {object[]}
 */
export function canonicalToolsToOpenAI(tools) {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function responsePreview(response) {
  let serialized;
  try {
    serialized = JSON.stringify(response);
  } catch {
    serialized = String(response);
  }
  if (serialized === undefined) serialized = String(response);
  return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
}

/**
 * OpenAI non-stream response -> canonical ChatResponse.
 *
 * @param {object} json
 * @returns {ChatResponse}
 */
export function openAIResponseToCanonical(json) {
  if (!Array.isArray(json?.choices) || json.choices.length === 0) {
    throw new Error(`OpenAI response is missing choices: ${responsePreview(json)}`);
  }

  const choice = json.choices[0] ?? {};
  const message = choice.message ?? {};
  const content = [];

  if (typeof message.reasoning_content === "string") {
    content.push({ type: "reasoning", text: message.reasoning_content });
  }
  if (typeof message.content === "string") {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) content.push(openAIContentPartToCanonical(part));
  }

  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const rawArguments = toolCall?.function?.arguments;
    let input;
    try {
      input = JSON.parse(rawArguments === undefined ? "{}" : rawArguments);
    } catch {
      input = { _raw: rawArguments };
    }
    content.push({
      type: "tool_use",
      id: toolCall?.id,
      name: toolCall?.function?.name,
      input,
      ...Object.fromEntries(
        Object.entries(toolCall ?? {}).filter(
          ([key]) => !["id", "type", "function"].includes(key),
        ),
      ),
      ...(toolCall?.type !== undefined && toolCall.type !== "function"
        ? { providerType: toolCall.type }
        : {}),
    });
  }

  if (Array.isArray(message.raw_blocks)) {
    content.push(...message.raw_blocks);
  }

  const stopMap = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens" };
  const finishReason = choice.finish_reason;
  const stopReason = finishReason == null ? "unknown" : stopMap[finishReason] ?? finishReason;
  const response = { content, stopReason };

  if (json.usage != null) {
    response.usage = {};
    if (json.usage.prompt_tokens !== undefined) {
      response.usage.input_tokens = json.usage.prompt_tokens;
    }
    if (json.usage.completion_tokens !== undefined) {
      response.usage.output_tokens = json.usage.completion_tokens;
    }
  }

  return response;
}
