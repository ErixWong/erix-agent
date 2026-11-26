import assert from "node:assert/strict";
import test from "node:test";
// issue #926：本文件原本还有三格钉 Anthropic 缓存断点（system + 首条 user + 滚动尾部三个
// `cacheBoundary` 落点、关旗后的原样形状、宿主自带标记的保留）——那套机制连同适配器一起退役，
// 三格随之删除；`makeContext` 也不再需要 `cacheStablePrefix` 这个入参。
import { callProvider } from "../src/loop/provider-runner.js";

function makeContext({ system = "stable system", messages } = {}) {
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
