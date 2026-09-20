import assert from "node:assert/strict";
import test from "node:test";
import { callProvider } from "../src/loop/provider-runner.js";

function makeContext({ system = "stable system", messages, cacheStablePrefix } = {}) {
  let request;
  return {
    context: {
      provider: {
        async chat(value) {
          request = value;
          return { content: [], stopReason: "end_turn" };
        },
      },
      mainSystem: system,
      ...(cacheStablePrefix === undefined ? {} : { cacheStablePrefix }),
      messages,
      signal: undefined,
      stream: false,
      retryOptions: null,
      retryAttempts: 0,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      emitEvent() {},
      reportObserverError() {},
      awaitWithAbort: (promise) => promise,
      waitForRetry: async () => {},
      estimateMessageTokens: () => 1,
      roundEventDeltas: [],
      finalText: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      latestApiInputTokens: undefined,
      latestApiEstimatedTokens: undefined,
      roundStopReason: undefined,
    },
    getRequest: () => request,
  };
}

function conversation() {
  return [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "later" }] },
  ];
}

test("provider runner marks system and first user stable prefix by default", async () => {
  const messages = conversation();
  const fixture = makeContext({ messages });

  await callProvider(fixture.context, { round: 1 });

  const request = fixture.getRequest();
  assert.deepEqual(request.system, {
    content: "stable system",
    cacheBoundary: true,
  });
  assert.equal(request.messages[0].cacheBoundary, true);
  assert.equal("cacheBoundary" in request.messages[1], false);
  assert.equal("cacheBoundary" in request.messages[2], false);
  assert.equal("cacheBoundary" in messages[0], false);
});

test("provider runner leaves request shape unchanged when stable prefix caching is disabled", async () => {
  const messages = conversation();
  const fixture = makeContext({ messages, cacheStablePrefix: false });

  await callProvider(fixture.context, { round: 1 });

  const request = fixture.getRequest();
  assert.equal(request.system, "stable system");
  assert.strictEqual(request.messages, messages);
  assert.equal("cacheBoundary" in request.messages[0], false);
});

test("provider runner preserves host cache markers while adding stable prefix markers", async () => {
  const messages = [
    {
      role: "user",
      cacheBoundary: true,
      content: [{ type: "text", text: "first", cache: true }],
    },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
  ];
  const fixture = makeContext({
    system: { content: "stable system", cacheBoundary: true, host: "marker" },
    messages,
  });

  await callProvider(fixture.context, { round: 1 });

  const request = fixture.getRequest();
  assert.deepEqual(request.system, {
    content: "stable system",
    cacheBoundary: true,
    host: "marker",
  });
  assert.equal(request.messages[0].cacheBoundary, true);
  assert.equal(request.messages[0].content[0].cache, true);
  assert.equal("cacheBoundary" in request.messages[1], false);
});
