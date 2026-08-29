export const pureTextConversation = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: [{ type: "text", text: "Hi, how can I help?" }] },
  { role: "user", content: "Summarize this project." },
  { role: "assistant", content: [{ type: "text", text: "It is an LLM conversation toolkit." }] },
];

export const singleToolCallRound = [
  { role: "user", content: "What is the current status?" },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "call_status", name: "get_status", input: {} }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call_status", content: "ready" }],
  },
  { role: "assistant", content: [{ type: "text", text: "The project is ready." }] },
];

export const multipleToolCallsRound = [
  { role: "user", content: "Inspect the project." },
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "call_tree", name: "tree", input: { depth: 2 } },
      { type: "tool_use", id: "call_status", name: "get_status", input: {} },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_tree", content: "src/\ntest/" },
      { type: "tool_result", tool_use_id: "call_status", content: "clean" },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "The project tree is clean." }] },
];

export const multiRoundMixedConversation = [
  { role: "user", content: "Start with a summary." },
  { role: "assistant", content: [{ type: "text", text: "I will inspect the project." }] },
  { role: "user", content: "Now inspect its structure and status." },
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "call_tree", name: "tree", input: { depth: 2 } },
      { type: "tool_use", id: "call_status", name: "get_status", input: {} },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_tree", content: "src/\ntest/" },
      { type: "tool_result", tool_use_id: "call_status", content: "clean" },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "The structure and status look good." }] },
];

export const textConversation = pureTextConversation;
export const oneToolCallRound = singleToolCallRound;
export const multiToolCallRound = multipleToolCallsRound;
export const multiRoundMixed = multiRoundMixedConversation;

export default {
  pureTextConversation,
  singleToolCallRound,
  multipleToolCallsRound,
  multiRoundMixedConversation,
};
