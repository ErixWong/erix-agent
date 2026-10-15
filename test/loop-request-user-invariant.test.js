import test from "node:test";
import assert from "node:assert/strict";

// issue #292：极小 budgetTokens 下，发给上游的 messages 变成空数组（真上游回 400
// 「No user query found in messages」，整个 run failed）。
// 这里用离线假 provider 复刻同一个失败面：假 provider 自己扮演「严格上游」，
// 收到空列表 / 没有 user 轮的请求就抛 invalid_request（引擎把它变成 failed）。
//
// 修前的复现档位（实测）：
//   · budgetTokens=400  + 大历史：视图被压成「没有 user 轮」/空列表
//   · budgetTokens=8    ：同一代码路径（safety 层 safeTruncateMessages 的逐条删除循环
//     从头开始删未保护的消息，连唯一的 user 轮一起删光）在离线估算下必然为空列表
// 真上游的失败面在 (400, 1200] 之间；离线估算系数不同，所以把同一档位的判据下推到 8。
import { runToolLoop } from "../src/loop/orchestrator.js";
import { validateMessages } from "../src/messages/rounds.js";

const filler = (count, char) => char.repeat(count);

// 一个「足够大」的历史：三条真实 user 轮（内容各不相同，便于断言保留了哪一条）
// + 一条 assistant 轮，全部远超极小预算。
function seededHistory() {
  return [
    { role: "user", content: [{ type: "text", text: `oldest-user-turn ${filler(1200, "a")}` }] },
    { role: "assistant", content: [{ type: "text", text: filler(1200, "b") }] },
    { role: "user", content: [{ type: "text", text: `middle-user-turn ${filler(1200, "c")}` }] },
    { role: "assistant", content: [{ type: "text", text: filler(1200, "d") }] },
    { role: "user", content: [{ type: "text", text: `latest-user-turn ${filler(1200, "e")}` }] },
  ];
}

/**
 * 严格上游：messages 必须非空且至少一条 role:"user"，否则抛 400 invalid_request。
 * 返回 { provider, views, requestViews } —— views 记录每次收到的请求视图。
 */
function createStrictUpstream(script, { views } = {}) {
  let index = 0;
  const respond = () => {
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return step;
  };
  const handle = async (request, channel) => {
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const view = {
      channel,
      messages: structuredClone(messages),
      count: messages.length,
      roles: messages.reduce((tally, message) => {
        tally[message?.role] = (tally[message?.role] ?? 0) + 1;
        return tally;
      }, {}),
    };
    views?.push(view);
    if ((view.roles.user ?? 0) === 0) {
      const error = new Error("Provider API error: No user query found in messages.");
      error.code = "invalid_request";
      error.status = 400;
      throw error;
    }
    return respond();
  };
  return {
    protocol: "fake",
    model: "fake-model",
    async chat(request) {
      return handle(request, "chat");
    },
    async chatStream(request) {
      return handle(request, "chatStream");
    },
  };
}

function toolLoopOptions({ budgetTokens, stream, provider, initialMessages }) {
  return {
    provider,
    system: "每轮都必须调用 pad 工具，最后一次直接回答。",
    initialMessages,
    tools: [{
      name: "pad",
      description: "返回一段固定填充文本，用来把每轮 token 量做成确定值",
      inputSchema: { type: "object", properties: { step: { type: "number" } }, required: [] },
    }],
    executeTool: async ({ tool }) => ({
      content: [{ type: "text", text: `${tool}-result ${filler(1500, "f")}` }],
    }),
    maxRounds: 6,
    completion: false,
    stallDetection: false,
    stream,
    toolResultTtl: 1,
    toolResultFoldMinTokens: 1,
    context: {
      strategy: "fold-statistical",
      budgetTokens,
      keepRounds: 2,
      task: "issue #292 复现",
    },
  };
}

const TOOL_CALL_SCRIPT = [
  { content: [{ type: "tool_use", id: "t1", name: "pad", input: { step: 1 } }], stopReason: "tool_use" },
  { content: [{ type: "tool_use", id: "t2", name: "pad", input: { step: 2 } }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "REPRO_DONE" }], stopReason: "end_turn" },
];

function assertEveryRequestHasUserTurn(views) {
  assert.ok(views.length > 0, "至少发出过一次请求");
  for (const view of views) {
    assert.ok(
      view.count > 0,
      `req#${views.indexOf(view) + 1} [${view.channel}] 发给上游的 messages 不得为空数组`,
    );
    assert.ok(
      (view.roles.user ?? 0) > 0,
      `req#${views.indexOf(view) + 1} [${view.channel}] 发给上游的 messages 必须至少一条 role:"user"，实际 roles=${JSON.stringify(view.roles)}`,
    );
  }
}

test("T1 #292 极小预算下发给上游的 messages 不得为空/不得没有 user 轮（chat 通道）", async () => {
  for (const budgetTokens of [400, 8]) {
    const views = [];
    const provider = createStrictUpstream(TOOL_CALL_SCRIPT, { views });
    const result = await runToolLoop(toolLoopOptions({
      budgetTokens,
      stream: false,
      provider,
      initialMessages: seededHistory(),
    }));

    assert.equal(
      result.termination.reason,
      "end_turn",
      `budgetTokens=${budgetTokens} 必须跑完，实际 termination=${JSON.stringify(result.termination)} `
      + `views=${JSON.stringify(views.map((view) => [view.count, view.roles]))}`,
    );
    assertEveryRequestHasUserTurn(views);
  }
});

test("T4 #292 同一条不变量必须同时覆盖 chatStream 通道", async () => {
  for (const budgetTokens of [400, 8]) {
    const views = [];
    const provider = createStrictUpstream(TOOL_CALL_SCRIPT, { views });
    const result = await runToolLoop(toolLoopOptions({
      budgetTokens,
      stream: true,
      provider,
      initialMessages: seededHistory(),
    }));

    assert.ok(
      views.some((view) => view.channel === "chatStream"),
      "stream:true 必须走 chatStream 通道（否则本用例没有覆盖到它）",
    );
    assert.equal(
      result.termination.reason,
      "end_turn",
      `stream budgetTokens=${budgetTokens} 必须跑完，实际 termination=${JSON.stringify(result.termination)}`,
    );
    assertEveryRequestHasUserTurn(views);
  }
});

test("T3 #292 对照：健康预算（1200）下压缩必须照常发生，且每条请求都有 user 轮", async () => {
  const views = [];
  const provider = createStrictUpstream(TOOL_CALL_SCRIPT, { views });
  const result = await runToolLoop(toolLoopOptions({
    budgetTokens: 1200,
    stream: false,
    provider,
    initialMessages: seededHistory(),
  }));

  assert.equal(result.termination.reason, "end_turn");
  assertEveryRequestHasUserTurn(views);

  // 治标判据：不许「预算小就整体不压缩」。健康预算这一档必须真的折过。
  assert.ok(
    result.compactionStats.length > 0,
    "健康预算档位必须触发过压缩评估（compactionStats 非空）",
  );
  const folded = result.compactionStats.filter((stat) => stat.compacted === true);
  assert.ok(
    folded.length > 0,
    `健康预算档位必须有 compactionStats.compacted === true 的记录，实际 ${JSON.stringify(result.compactionStats)}`,
  );
  assert.ok(
    folded.some((stat) => stat.foldedRounds > 0 && stat.tokensAfter < stat.tokensBefore),
    `必须确有内容被折（foldedRounds > 0 且 tokensAfter < tokensBefore），实际 ${JSON.stringify(folded)}`,
  );
  // 视图层面也要能看出「历史被压小过」：请求视图比未压缩历史小
  const seededTokens = JSON.stringify(seededHistory()).length;
  assert.ok(
    views.some((view) => JSON.stringify(view.messages).length < seededTokens),
    "至少一次请求的视图必须小于未压缩历史（压缩确实作用在发给上游的视图上）",
  );
});

test("T2 #292 保底必须保留「最新」那条 user 轮，且视图配对合法", async () => {
  const views = [];
  const provider = createStrictUpstream(TOOL_CALL_SCRIPT, { views });
  const result = await runToolLoop(toolLoopOptions({
    budgetTokens: 8,
    stream: false,
    provider,
    initialMessages: seededHistory(),
  }));
  assert.equal(result.termination.reason, "end_turn");

  // 视图被保底过（存在没有历史在前的紧凑请求）
  const repaired = views.filter((view) => view.count > 0 && view.count <= 2);
  assert.ok(repaired.length > 0, "极小预算档位必须出现过紧凑视图（保底路径被走到）");
  for (const view of repaired) {
    const userTexts = view.messages
      .filter((message) => message?.role === "user")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? ""));
    assert.ok(
      userTexts.some((text) => text.includes("latest-user-turn")),
      `被保留的必须是最新的 user 轮 latest-user-turn，实际 ${JSON.stringify(userTexts.map((text) => text.slice(0, 40)))}`,
    );
    assert.equal(
      userTexts.some((text) => text.includes("oldest-user-turn")),
      false,
      "最旧的 user 轮不许被留下（守卫的变异证「保留最旧」必须能被本用例抓到）",
    );
    assert.doesNotThrow(() => validateMessages(view.messages, { allowPendingToolUse: false }));
    const orphans = view.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result");
    assert.equal(orphans.length, 0, "紧凑视图里不许有孤儿 tool_result");
  }
});
