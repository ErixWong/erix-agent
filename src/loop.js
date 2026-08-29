function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function toolResultContent(result) {
  return typeof result === "string" ? result : String(result);
}

function stallError(signature) {
  const error = new Error(`Tool loop stalled on repeated call: ${signature}`);
  error.code = "llm_kit_stalled";
  return error;
}

/**
 * Run the minimum tool-calling loop against an injected provider.
 *
 * @param {{
 *   provider: {chat: (request: object) => Promise<object>},
 *   system?: string,
 *   initialUserMessage?: string,
 *   initialMessages?: object[],
 *   tools?: object[],
 *   executeTool: (name:string, input:object) => Promise<string>,
 *   maxRounds?: number,
 *   stallDetection?: {window?:number}|false,
 *   store?: {appendRound?: Function},
 *   runId?: string,
 *   onRound?: Function,
 *   onToolResult?: Function,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{
 *   finalText:string,
 *   messages:object[],
 *   transcript:object[],
 *   rounds:number,
 *   truncated:boolean,
 *   usage:{input_tokens:number, output_tokens:number}
 * }>}
 */
export async function runToolLoop({
  provider,
  system,
  initialUserMessage,
  initialMessages,
  tools = [],
  executeTool,
  maxRounds = 8,
  stallDetection = { window: 4 },
  store,
  runId,
  onRound,
  onToolResult,
  signal,
}) {
  const messages = initialMessages !== undefined
    ? [...initialMessages]
    : initialUserMessage !== undefined
      ? [{ role: "user", content: [{ type: "text", text: initialUserMessage }] }]
      : [];
  const recentSignatures = [];
  const stallWindow = stallDetection === false
    ? 0
    : Number.isInteger(stallDetection?.window) && stallDetection.window > 0
      ? stallDetection.window
      : 4;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let finalText = "";
  let rounds = 0;

  while (rounds < maxRounds) {
    const round = rounds + 1;
    const roundStart = messages.length;
    const response = await provider.chat({
      system,
      messages,
      tools,
      signal,
    });
    const content = blocksFor(response?.content);

    messages.push({ role: "assistant", content });
    finalText = textFromBlocks(content);
    if (Number.isFinite(response?.usage?.input_tokens)) {
      usage.input_tokens += response.usage.input_tokens;
    }
    if (Number.isFinite(response?.usage?.output_tokens)) {
      usage.output_tokens += response.usage.output_tokens;
    }

    if (response?.stopReason === "tool_use") {
      const toolResults = [];
      for (const block of content) {
        if (block?.type !== "tool_use") continue;

        const signature = `${block.name}${JSON.stringify(block.input)}`;
        if (stallWindow > 0
          && recentSignatures.length >= stallWindow
          && recentSignatures.includes(signature)) {
          throw stallError(signature);
        }
        if (stallWindow > 0) {
          recentSignatures.push(signature);
          if (recentSignatures.length > stallWindow) recentSignatures.shift();
        }

        let result;
        let isError = false;
        try {
          result = await executeTool(block.name, block.input);
        } catch (error) {
          isError = true;
          result = String(error?.message ?? error);
        }
        if (onToolResult) {
          result = await onToolResult(block.name, result);
        }

        const toolResult = {
          type: "tool_result",
          tool_use_id: block.id,
          content: toolResultContent(result),
        };
        if (isError) toolResult.is_error = true;
        toolResults.push(toolResult);
      }
      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }
    }

    const record = {
      round,
      messages: messages.slice(roundStart),
      ts: new Date().toISOString(),
    };
    if (typeof store?.appendRound === "function") {
      try {
        await store.appendRound(runId, record);
      } catch {
        // Transcript persistence is best effort and must not stop the loop.
      }
    }
    if (onRound) await onRound(record);

    rounds = round;
    if (response?.stopReason !== "tool_use") {
      return {
        finalText,
        messages,
        transcript: [...messages],
        rounds,
        truncated: false,
        usage,
      };
    }
  }

  return {
    finalText,
    messages,
    transcript: [...messages],
    rounds,
    truncated: true,
    usage,
  };
}
