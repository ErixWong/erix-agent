/**
 * @typedef {import("./canonical.js").Block} Block
 */

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function messageContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content;
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
    content: json.content,
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
 * @param {(delta:string)=>void} [onDelta]
 * @returns {{
 *   push:(eventType:string, data:object|string)=>void,
 *   finish:()=>{content:Block[], stopReason:string, usage?:{input_tokens?:number, output_tokens?:number}}
 * }}
 */
export function createAnthropicStreamAssembler(onDelta) {
  const blockStates = [];
  const usage = {};
  let hasUsage = false;
  let stopReason;
  let nextImplicitIndex = 0;

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
      const type = source.type === "tool_use" ? "tool_use" : source.type;
      const state = ensureState(index, type);

      if (type === "tool_use") {
        state.block = {
          type: "tool_use",
          id: source.id,
          name: source.name,
          input: source.input ?? {},
        };
      } else if (type === "text") {
        state.block = {
          type: "text",
          text: typeof source.text === "string" ? source.text : "",
        };
      } else {
        state.block = { ...source };
      }
      state.type = type;
      return;
    }

    if (eventType === "content_block_delta") {
      const delta = data.delta ?? {};
      const index = blockIndex(data);

      if (delta.type === "text_delta") {
        const state = ensureState(index, "text");
        const text = typeof delta.text === "string" ? delta.text : "";
        state.block.type = "text";
        state.block.text = `${state.block.text ?? ""}${text}`;
        onDelta?.(text);
      } else if (delta.type === "input_json_delta") {
        const state = ensureState(index, "tool_use");
        state.type = "tool_use";
        state.partialJson += typeof delta.partial_json === "string"
          ? delta.partial_json
          : "";
        state.hasJsonDelta = true;
      }
      return;
    }

    if (eventType === "content_block_stop") {
      const index = blockIndex(data);
      const state = blockStates[index];
      if (state?.type === "tool_use" && state.hasJsonDelta) {
        state.block.input = parsedInput(state.partialJson);
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
    const content = blockStates
      .filter((state) => state !== undefined)
      .map((state) => state.block);
    return {
      content,
      stopReason,
      ...(hasUsage ? { usage } : {}),
    };
  }

  return { push, finish };
}
