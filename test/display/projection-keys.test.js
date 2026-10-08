import test from "node:test";
import assert from "node:assert/strict";
import { projectTranscriptForDisplay } from "../../src/display/projection.js";

function allKeys(turns) {
  return turns.flatMap((turn) => [
    turn.key,
    ...(turn.toolCalls ?? []).map((call) => call.key),
  ]);
}

test("turn and tool-call keys are non-empty, globally unique and use record indices", () => {
  const turns = projectTranscriptForDisplay([
    {
      round: 4,
      messages: [{ role: "user", content: "pre-written input" }],
    },
    {
      round: 4,
      response: {
        content: [{ type: "tool_use", id: "call-1", name: "read" }],
      },
    },
    {
      round: 4,
      response: { content: [{ type: "text", text: "engine answer" }] },
    },
  ]);
  const keys = allKeys(turns);

  assert.deepEqual(keys, ["4#0:0", "4#1:0", "4#1:0:t0", "4#2:0"]);
  assert.ok(keys.every((key) => typeof key === "string" && key !== ""));
  assert.equal(new Set(keys).size, keys.length);
});

test("records without a usable round use the question-mark token and remain unique", () => {
  const turns = projectTranscriptForDisplay([
    { response: { content: [{ type: "text", text: "first" }] } },
    { round: "not-a-round", response: { content: [{ type: "text", text: "second" }] } },
  ]);

  assert.deepEqual(turns.map((turn) => turn.key), ["?#0:0", "?#1:0"]);
  assert.equal(new Set(allKeys(turns)).size, allKeys(turns).length);
});

test("folded, textPreview fallback and wrapup turns receive turn keys", () => {
  const turns = projectTranscriptForDisplay([
    {
      round: 7,
      folded: true,
      foldedRoundRange: { from: 1, to: 5 },
      messages: [{ role: "user", content: "task" }],
      response: { content: [{ type: "text", text: "answer" }] },
    },
    { round: 8, textPreview: "legacy preview" },
    { round: 9, messages: [], wrapup: { summary: "wrapped up" } },
  ]);

  assert.deepEqual(turns.map((turn) => turn.key), [
    "7#0:0", "7#0:1", "7#0:2", "8#1:0", "9#2:0",
  ]);
  assert.equal(turns[0].folded, true);
  assert.equal(turns[3].meta.source, "textPreview");
  assert.equal(turns[4].meta.source, "wrapup");
});

test("the same input array produces the same turn and tool-call key sequence", () => {
  const records = [
    {
      round: 2,
      folded: true,
      foldedRoundRange: { from: 1, to: 1 },
      messages: [{ role: "user", content: "task" }],
      response: {
        content: [{ type: "tool_use", id: "call-1", name: "work" }],
      },
    },
    { round: 1, response: { content: [{ type: "text", text: "earlier" }] } },
  ];

  assert.deepEqual(
    allKeys(projectTranscriptForDisplay(records)),
    allKeys(projectTranscriptForDisplay(records)),
  );
});

test("tool-call key exists independently of missing provider id or empty name", () => {
  const [turn] = projectTranscriptForDisplay([{
    round: 3,
    response: {
      content: [{ type: "tool_use" }],
    },
  }]);
  const [call] = turn.toolCalls;

  assert.equal(turn.key, "3#0:0");
  assert.equal(call.key, "3#0:0:t0");
  assert.equal(call.name, "");
  assert.equal(Object.hasOwn(call, "id"), false);
});

test("duplicate tool_use_id results use the last result for every matching call", () => {
  const [turn] = projectTranscriptForDisplay([{
    round: 5,
    messages: [{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "reused", content: "first result" },
        { type: "tool_result", tool_use_id: "reused", content: "last result", is_error: true },
      ],
    }],
    response: {
      content: [
        { type: "tool_use", id: "reused", name: "first call" },
        { type: "tool_use", id: "reused", name: "second call" },
      ],
    },
  }]);

  assert.deepEqual(
    turn.toolCalls.map(({ resultPreview, isError }) => ({ resultPreview, isError })),
    [
      { resultPreview: "last result", isError: true },
      { resultPreview: "last result", isError: true },
    ],
  );
  assert.deepEqual(turn.toolCalls.map((call) => call.key), ["5#0:0:t0", "5#0:0:t1"]);
});
