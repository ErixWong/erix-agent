// 规范消息模型 + openai⇄canonical 转换（v0.0 脚手架最小版，worker-2 负责硬化与补全测试）
// 契约见 docs/v0.0-contracts.md §②；块格式见 docs/architecture.md §2

/**
 * @typedef {{type:"text",text:string}
 *         | {type:"tool_use",id:string,name:string,input:object}
 *         | {type:"tool_result",tool_use_id:string,content:string,is_error?:boolean}
 *         | {type:"raw",protocol:string,payload:any}} Block
 * @typedef {{role:"system"|"user"|"assistant", content:string|Block[]}} CanonicalMessage
 * @typedef {{name:string, description?:string, inputSchema:object}} ToolSchema
 */

function asBlocks(content) {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** canonical → OpenAI chat/completions messages（脚手架版：覆盖 text/tool_use/tool_result） */
export function canonicalToOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    const blocks = asBlocks(m.content);
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id, type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // user / system：tool_result 逐条拆成 tool 消息，text 合并为 user 消息
    const texts = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
      } else if (b.type === "text") {
        texts.push(b.text);
      }
    }
    if (texts.length || !blocks.some((b) => b.type === "tool_result")) {
      out.push({ role: m.role, content: texts.join("\n") });
    }
  }
  return out;
}

/** 规范 ToolSchema[] → openai tools[] */
export function canonicalToolsToOpenAI(tools) {
  return (tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** OpenAI 非流式响应 → { content, stopReason, usage } */
export function openAIResponseToCanonical(json) {
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input;
    try { input = JSON.parse(tc.function?.arguments ?? "{}"); }
    catch { input = { _raw: tc.function?.arguments }; }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  const stopMap = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens" };
  const stopReason = stopMap[choice?.finish_reason] ?? choice?.finish_reason ?? "unknown";
  const usage = json?.usage
    ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens }
    : undefined;
  return { content, stopReason, usage };
}
