import { createFakeProvider } from "./test/helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "./src/store/memory.js";
import { groupIntoRounds } from "./src/messages/rounds.js";
import { estimateMessageTokens } from "./src/tokens.js";
import { runDirect } from "./test/helpers/run-direct.js";
import { KitError } from "./src/providers/errors.js";

function createCountingStrategy() {
  const tally = { shouldCompact: [], compact: [] };
  return {
    name: "counting-llm-strategy",
    tally,
    async shouldCompact(_m, budgetTokens) { tally.shouldCompact.push(budgetTokens); return false; },
    async compact(messages, options = {}) {
      tally.compact.push(options.budgetTokens ?? null);
      const tokensBefore = estimateMessageTokens(messages);
      const offset = Number.isSafeInteger(options.roundOffset) ? options.roundOffset : 0;
      const { head, rounds } = groupIntoRounds(messages);
      if (rounds.length === 0) return { messages, compacted: false, foldedRounds: 0, foldedPayload: [], tokensBefore, tokensAfter: tokensBefore };
      const folded = rounds.slice(0, 1);
      const retained = rounds.slice(1);
      const foldedPayload = folded.flatMap((r) => r.messages).map((m) => ({ ...m }));
      const compactedMessages = [...head, ...retained.flatMap((r) => r.messages)];
      return { messages: compactedMessages, compacted: true, foldedRounds: folded.length, foldedPayload, foldedRoundRange: { from: offset + 1, to: offset + folded.length }, tokensBefore, tokensAfter: estimateMessageTokens(compactedMessages) };
    },
  };
}
function seededRoundMessages() {
  return [
    { role: "user", content: [{ type: "text", text: `开工 ${"x".repeat(200)}` }] },
    { role: "assistant", content: [{ type: "tool_use", id: "seed-1", name: "work", input: { i: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "seed-1", content: `结果 ${"y".repeat(200)}` }] },
  ];
}
function cwError(status = 400) { return new KitError("context_window_exceeded", "maximum context length is 8191 tokens", { retryable: true, status }); }

async function run(maxRounds = 6) {
  const strategy = createCountingStrategy();
  const provider = createFakeProvider([
    { throw: cwError(400) },
    { content: [{ type: "text", text: "收尾完成" }], stopReason: "end_turn" },
  ]);
  const options = {
    provider,
    executeTool: async () => "done",
    config: {
      run: { maxRounds, completion: false, reflection: false, stallDetection: false },
      input: { messages: seededRoundMessages() },
      metadata: { modelMetadata: { contextWindowTokens: 4096, maxOutputTokens: 512 } },
      folding: { context: { budgetTokens: 1200, keepRounds: 1 } },
    },
    capabilities: { ports: { strategy } },
    store: createMemoryTranscriptStore(),
    runId: "probe",
  };
  const result = await runDirect(options);
  return { strategy, provider, result };
}

for (const mr of [6, 3]) {
  const { strategy, provider } = await run(mr);
  console.log("=== maxRounds", mr, "===");
  console.log("shouldCompact budgets:", JSON.stringify(strategy.tally.shouldCompact));
  console.log("compact budgets:", JSON.stringify(strategy.tally.compact));
  provider.requests.forEach((r, i) => {
    const txt = JSON.stringify(r.messages);
    console.log(`req[${i}] has "[run state":`, txt.includes("[run state"), "msgs:", r.messages.length, "roles:", r.messages.map((m) => m.role).join(","));
    // show any text blocks containing run state
    for (const m of r.messages) {
      if (Array.isArray(m.content)) for (const b of m.content) if (typeof b?.text === "string" && b.text.includes("[run state")) console.log("   FULL BLOCK:\n" + b.text);
      else if (typeof m.content === "string" && m.content.includes("[run state")) console.log("   FULL STR BLOCK:\n" + m.content);
    }
  });
}
