import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("resumes after three rounds without replaying paid provider calls", async () => {
  const store = createMemoryTranscriptStore();
  const firstProvider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "work", input: { step: 1 } }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "call-2", name: "work", input: { step: 2 } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "paused" }], stopReason: "end_turn" },
  ]);

  const firstResult = await runToolLoop({
    provider: firstProvider,
    initialUserMessage: "start",
    executeTool: async (_name, input) => `completed-${input.step}`,
    maxRounds: 3,
    completion: false,
    store,
    runId: "resume-run",
  });
  const beforeResume = await store.load("resume-run");
  const storedMessages = beforeResume.flatMap((record) => record.messages);

  assert.equal(firstResult.rounds, 3);
  assert.deepEqual(firstResult.messages, storedMessages); // 种子记录后档案 = 完整消息
  assert.equal(firstProvider.requests.length, 3);

  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "round four" }], stopReason: "end_turn" },
  ]);
  const resumedResult = await runToolLoop({
    provider: resumedProvider,
    initialUserMessage: "must be ignored",
    initialMessages: [{ role: "user", content: "must also be ignored" }],
    executeTool: async () => "unused",
    maxRounds: 4,
    completion: false,
    store,
    runId: "resume-run",
    resume: true,
  });

  assert.equal(resumedProvider.requests.length, 1);
  assert.deepEqual(resumedProvider.requests[0].messages, storedMessages);
  assert.equal(resumedResult.rounds, 4);
  assert.equal(resumedResult.finalText, "round four");
  assert.deepEqual(
    (await store.load("resume-run")).map((record) => record.round),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(resumedResult.messages, [
    ...storedMessages,
    { role: "assistant", content: [{ type: "text", text: "round four" }] },
  ]);
});

test("resume rejects an empty transcript", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "ignored",
      executeTool: async () => "unused",
      store,
      runId: "empty",
      resume: true,
    }),
    (error) => error?.message === "resume: 无可恢复记录",
  );
  assert.equal(provider.requests.length, 0);
});
