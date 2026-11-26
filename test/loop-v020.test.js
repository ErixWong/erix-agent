import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { KitError } from "../src/providers/errors.js";

test("rejects invalid initial message pairs before the first provider call", async () => {
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      return { content: [{ type: "text", text: "unexpected" }], stopReason: "end_turn" };
    },
  };

  await assert.rejects(
    runToolLoop({
      provider,
      // #498 S3 (`input` slice A): the flat `initialMessages` retired; `config.input.messages` is
      // the one registered leaf alias and expands back to `effectiveOptions.initialMessages`.
      config: { input: { messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan", content: "bad" }],
      }] } },
      executeTool: async () => "unused",
    }),
    (error) => error instanceof KitError && error.code === "invalid_messages",
  );
  assert.equal(calls, 0);
});

test("the request view handed to the provider is a snapshot: a push cannot pollute the history", async () => {
  // issue #926 之前，这一格钉的是「每轮 provider 轮之前重新校验消息」：它靠
  // `config.input.cacheStablePrefix: false` **故意关掉**请求视图的拷贝，让 provider 拿到的
  // `request.messages` 与 `ctx.messages` 同一个数组引用，于是 provider 里 push 一条孤儿
  // `tool_result` 就能污染历史，第二轮由 `validateMessages` 拒掉。
  //
  // 那个旋钮随 Anthropic 断点机制一起退役（#926），而请求视图的拷贝现在**无条件**存在
  // （`provider-runner.js` 里 `messages: requestMessages.slice()`），所以那条污染通道已经关闭。
  // 逐轮重新校验本身仍在（`validateMessages(requestView.messages)` 在每次 attempt 之前跑），
  // 它现在守的是「宿主直接写账本 / 恢复时账本已经脏」那一类入口——那几格在 resume 测试里。
  //
  // 本格因此钉**更强的那条**：provider 拿到的是本次请求的快照，push 既不回流，也不会出现在
  // 下一轮请求里。
  const seen = [];
  let calls = 0;
  const provider = {
    async chat(request) {
      calls += 1;
      if (calls === 1) {
        request.messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "orphan", content: "bad" }],
        });
        return {
          content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
          stopReason: "tool_use",
        };
      }
      seen.push(request.messages.map((m) => JSON.stringify(m)));
      return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
    },
  };

  const result = await runDirect({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "done",
    completion: false,
    // #498 S3 (`input` slice A): the flat spelling retired; the home is config.input.*.
    config: { input: {} },
  });

  assert.equal(calls, 2, "第二轮必须真的发生（污染不该把 run 打死）");
  assert.equal(result.termination?.reason, "end_turn");
  const second = seen[0] ?? [];
  assert.ok(
    !second.some((line) => line.includes("orphan")),
    "provider 在上一轮往快照里 push 的那条孤儿不许出现在下一轮请求里",
  );
});

test("allows a truncated tool response to request its continuation", async () => {
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
          stopReason: "max_tokens",
        };
      }
      return {
        content: [{ type: "text", text: "continued" }],
        stopReason: "end_turn",
      };
    },
  };

  const result = await runDirect({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "unused",
    completion: false,
  });

  assert.equal(requests.length, 2);
  assert.equal(result.finalText, "continued");
});

test("compacts over-budget messages during max_tokens continuation", async () => {
  // reasoning 模型单次响应常因推理过长触发 max_tokens 截断；
  // 若 messages 已超预算，补全循环内应先压缩再继续（Issue #11）
  let compactedCalls = 0;
  let requests = 0;
  const strategy = {
    async shouldCompact() {
      return true;
    },
    async compact(messages, options) {
      compactedCalls += 1;
      return { messages: [{ role: "user", content: [{ type: "text", text: "[折叠摘要]" }] }], compacted: true };
    },
  };
  const provider = {
    async chat(request) {
      requests += 1;
      if (requests === 1) {
        // 首次响应 max_tokens 截断且无工具调用
        return { content: [{ type: "text", text: "long reasoning..." }], stopReason: "max_tokens" };
      }
      return { content: [{ type: "text", text: "最终答复" }], stopReason: "end_turn" };
    },
  };

  const result = await runDirect({ capabilities: { ports: { strategy: strategy } },
    provider,
    initialUserMessage: "start",
    executeTool: async () => "unused",
    completion: false,
    config: { folding: { context: { budgetTokens: 10 } } }, // 小预算确保超限
  });

  assert.ok(compactedCalls >= 1, "补全循环内应触发至少一次压缩");
  // 压缩后 messages 被折叠摘要替换，最终答复包含折叠后的内容
  assert.ok(result.finalText.includes("最终答复") || result.finalText.includes("折叠"));
});
