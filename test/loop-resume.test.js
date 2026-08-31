import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const textMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
});

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

test("resumes folded checkpoints from the persisted transcript anchor", async () => {
  for (const keepRounds of [0, 2]) {
    const store = createMemoryTranscriptStore();
    const controller = new AbortController();
    const firstProvider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "c1", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "c2", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "c3", name: "work", input: {} }],
        stopReason: "tool_use",
      },
    ]);
    let calls = 0;
    const strategy = {
      shouldCompact: () => true,
      compact: (messages, options) => createFoldStatisticalStrategy().compact(
        messages,
        { ...options, keepRounds },
      ),
    };

    await assert.rejects(
      runToolLoop({
        provider: firstProvider,
        initialUserMessage: "fold-base-input",
        executeTool: ({ signal }) => {
          calls += 1;
          if (calls === 3) {
            controller.abort();
            return "not reached";
          }
          return `tool-out-${calls}`;
        },
        maxRounds: 6,
        completion: false,
        context: { strategy, budgetTokens: 30 },
        store,
        runId: `fold-${keepRounds}`,
        signal: controller.signal,
      }),
      /aborted|abort/i,
    );

    const checkpoint = await store.loadLatestCheckpoint(`fold-${keepRounds}`);
    assert.equal(checkpoint.persistedTranscriptLength, 5);
    await store.appendRound(`fold-${keepRounds}`, {
      round: 2,
      dedupKey: `fold-${keepRounds}:input`,
      messages: [textMessage("tail-after-fold")],
    });

    const resumedProvider = createFakeProvider([
      { content: [{ type: "text", text: "final" }] },
    ]);
    await runToolLoop({
      provider: resumedProvider,
      resume: true,
      completion: false,
      store,
      runId: `fold-${keepRounds}`,
      executeTool: async () => "resumed-tool",
    });

    const requestMessages = resumedProvider.requests[0].messages;
    const serialized = JSON.stringify(requestMessages);
    assert.equal((serialized.match(/fold-base-input/g) ?? []).length, 1);
    assert.equal(
      requestMessages.at(-1).content[0].text,
      "tail-after-fold",
    );
    assert.ok(requestMessages.findIndex((message) => (
      message.content?.some((block) => block.type === "tool_result")
    )) < requestMessages.length - 1);
  }
});

test("archives replayed tool results without duplicating multiple resume tails", async () => {
  const store = createMemoryTranscriptStore();
  const controller = new AbortController();
  const firstProvider = createFakeProvider([{
    content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
    stopReason: "tool_use",
  }]);

  await assert.rejects(
    runToolLoop({
      provider: firstProvider,
      initialUserMessage: "user-one",
      executeTool: ({ signal }) => {
        controller.abort();
        return signal.reason;
      },
      completion: false,
      store,
      runId: "multi-tail",
      signal: controller.signal,
    }),
    /aborted|abort/i,
  );
  await store.appendRound("multi-tail", {
    round: 0,
    dedupKey: "multi-tail:input:1",
    messages: [textMessage("user-two")],
  });
  await store.appendRound("multi-tail", {
    round: 0,
    dedupKey: "multi-tail:input:2",
    messages: [textMessage("user-three")],
  });

  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "resumed" }] },
  ]);
  await runToolLoop({
    provider: resumedProvider,
    resume: true,
    completion: false,
    store,
    runId: "multi-tail",
    executeTool: async () => "tool-output",
  });

  const requestMessages = resumedProvider.requests[0].messages;
  assert.deepEqual(
    requestMessages.slice(-2).map((message) => message.content[0].text),
    ["user-two", "user-three"],
  );
  const records = await store.load("multi-tail");
  const archived = JSON.stringify(records);
  assert.equal((archived.match(/user-two/g) ?? []).length, 1);
  assert.equal((archived.match(/user-three/g) ?? []).length, 1);
  assert.equal((archived.match(/tool-output/g) ?? []).length, 1);
  const resumedRound = records.find((record) => record.round === 1);
  assert.ok(resumedRound.messages.some((message) => (
    message.content?.some((block) => block.type === "tool_result")
  )));

  const secondProvider = createFakeProvider([
    { content: [{ type: "text", text: "second resume" }] },
  ]);
  await runToolLoop({
    provider: secondProvider,
    resume: true,
    completion: false,
    store,
    runId: "multi-tail",
    executeTool: async () => "unused",
  });
  assert.equal(secondProvider.requests.length, 1);
});
