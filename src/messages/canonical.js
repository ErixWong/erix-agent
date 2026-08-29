// 规范消息模型 + openai⇄canonical 转换。
// 契约见 docs/v0.0-contracts.md §②；块格式见 docs/architecture.md §2

/**
 * A canonical content block.
 *
 * @typedef {(
 *   {type:"text", text:string} |
 *   {type:"tool_use", id:string, name:string, input:object} |
 *   {type:"tool_result", tool_use_id:string, content:string, is_error?:boolean} |
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

/**
 * @param {string|Block[]|undefined} content
 * @returns {Block[]}
 */
function asBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/**
 * @param {Block[]} blocks
 * @returns {string[]}
 */
function textBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text);
}

/**
 * @param {unknown} response
 * @returns {string}
 */
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
 * canonical → OpenAI chat/completions messages.
 *
 * Text adjacent to tool results is emitted as separate user messages so the
 * relative order of user and tool messages remains intact.
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
    const blocks = asBlocks(message?.content);

    if (message?.role === "assistant") {
      const texts = textBlocks(blocks);
      const toolCalls = blocks
        .filter((block) => block?.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      const serialized = {
        role: "assistant",
        content: texts.length > 0 ? texts.join("") : null,
      };
      if (toolCalls.length > 0) serialized.tool_calls = toolCalls;
      out.push(serialized);
      continue;
    }

    if (message?.role === "system") {
      const texts = textBlocks(blocks);
      if (texts.length > 0 || blocks.length === 0) {
        out.push({ role: "system", content: texts.join("\n") });
      }
      continue;
    }

    if (message?.role !== "user") continue;

    const hasToolResult = blocks.some((block) => block?.type === "tool_result");
    const texts = [];
    const flushText = () => {
      if (texts.length > 0) {
        out.push({ role: "user", content: texts.join("\n") });
        texts.length = 0;
      }
    };

    for (const block of blocks) {
      if (!block || block.type === "raw") {
        // v0.0 deliberately skips protocol-specific raw blocks; v0.1 will restore them.
        continue;
      }
      if (block.type === "tool_result") {
        flushText();
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    flushText();

    if (!hasToolResult && blocks.length === 0) {
      out.push({ role: "user", content: "" });
    }
  }

  return out;
}

/**
 * 规范 ToolSchema[] → openai tools[].
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

/**
 * OpenAI 非流式响应 → canonical ChatResponse.
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
  if (typeof message.content === "string") {
    content.push({ type: "text", text: message.content });
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
    });
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
