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
import {
  ensureUserTurnView,
  hasUserTurn,
  isUserTurnGuardAction,
} from "../src/loop/request-user-view.js";

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

  // 同一判据也压到极小档：守卫不许是「预算太小就整体不压缩」那种治标实现。
  // 变异证「预算 < N 就跳过压缩」必须在这里变红，而不是只在 1200 档变红。
  const tinyViews = [];
  const tinyProvider = createStrictUpstream(TOOL_CALL_SCRIPT, { views: tinyViews });
  const tiny = await runToolLoop(toolLoopOptions({
    budgetTokens: 8,
    stream: false,
    provider: tinyProvider,
    initialMessages: seededHistory(),
  }));
  assert.equal(tiny.termination.reason, "end_turn");
  assert.ok(
    tiny.compactionStats.length > 0,
    "极小预算档位也必须继续压缩（「预算小就不压缩」= 治标，本用例专门抓它）",
  );
  assert.ok(
    tiny.compactionStats.some((stat) => stat.compacted === true || stat.foldedRounds > 0),
    `极小预算档位必须仍有压缩发生的证据，实际 ${JSON.stringify(tiny.compactionStats)}`,
  );
  assert.ok(
    tiny.compactionStats.some((stat) => stat.userTurnGuard !== undefined),
    "守卫生效必须留下可观测信号（compactionStats.userTurnGuard）",
  );
  assert.ok(
    tinyViews.every((view) => JSON.stringify(view.messages).length < seededTokens),
    "极小档发给上游的视图必须仍然被压小过（守卫只回补一条 user 轮，不是把整段历史发出去）",
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

test("T5 #292 守卫本体的退让顺序与配对合法性（请求视图那一处的单元面）", async () => {
  const source = [
    { role: "user", content: [{ type: "text", text: "oldest" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "pad", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "r1" }] },
    { role: "user", content: [{ type: "text", text: "latest" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "pad", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "r2" }] },
  ];

  // 1) 视图本来合规 → 原样返回（同一个引用，零行为变化）
  const healthy = structuredClone(source);
  assert.equal(ensureUserTurnView(healthy, source), healthy);

  // 2) 视图非空但没有真 user 轮（只剩 tool_use / tool_result 那一对）→ 补最新的 user 轮
  const stats = {};
  const folded = [structuredClone(source[4]), structuredClone(source[5])];
  const repaired = ensureUserTurnView(folded, source, stats);
  assert.equal(stats.action, "preserved_latest_user_turn");
  assert.equal(repaired.length, 3, "原有折叠视图留得住就留住，尾部补上最新的 user 轮");
  assert.deepEqual(
    repaired.map((message) => message.content[0].text ?? message.content[0].type),
    ["tool_use", "tool_result", "latest"],
  );
  assert.doesNotThrow(() => validateMessages(repaired, { allowPendingToolUse: false }));

  // 3) 视图为空列表（真上游那一枪的形状）→ 只剩最新的 user 轮
  const emptyStats = {};
  const fromEmpty = ensureUserTurnView([], source, emptyStats);
  assert.equal(emptyStats.action, "preserved_latest_user_turn");
  assert.deepEqual(fromEmpty.map((message) => message.content[0].text), ["latest"]);

  // 4) 尾巴上挂着没有结果的 tool_use 时，追加必须不让它悬空
  const danglingStats = {};
  const dangling = ensureUserTurnView([structuredClone(source[4])], source, danglingStats);
  assert.doesNotThrow(() => validateMessages(dangling, { allowPendingToolUse: false }));
  assert.ok(hasUserTurn(dangling));

  // 5) 带 tool_result 的那条 user 轮若正是最新的，回补必须连它的 assistant 配对一起带走
  const pairedStats = {};
  const pairedSource = [
    { role: "user", content: [{ type: "text", text: "oldest" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "pad", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "u1", content: "r1" },
        { type: "text", text: "latest-with-result" },
      ],
    },
  ];
  const paired = ensureUserTurnView([], pairedSource, pairedStats);
  assert.equal(pairedStats.action, "preserved_latest_user_turn");
  assert.equal(paired.length, 2, "必须连 assistant 的 tool_use 一起留下，否则 tool_result 变孤儿");
  assert.deepEqual(paired.map((message) => message.role), ["assistant", "user"]);
  assert.ok(hasUserTurn(paired));
  assert.doesNotThrow(() => validateMessages(paired, { allowPendingToolUse: false }));
  assert.equal(isUserTurnGuardAction(pairedStats.action), true);

  // 6) 源里根本没有 user 轮可留 → 原样返回并标记 unrecoverable（不许假装修好了）
  const hopelessStats = {};
  const hopeless = ensureUserTurnView(
    [{ role: "assistant", content: [{ type: "text", text: "orphan" }] }],
    [{ role: "assistant", content: [{ type: "text", text: "orphan" }] }],
    hopelessStats,
  );
  assert.equal(hopelessStats.action, "unrecoverable");
  assert.equal(hopeless.length, 1);
});

test("T6 #292-R1 尾部带 pending tool_use 的合法视图必须原样放行（不复制 user、不摘尾巴、不记动作）", () => {
  // max_tokens 续写（orchestrator 的 callProvider({allowPendingToolUse:true})）与
  // 「尾部是 pending tool_use 的续跑」都是这个形状：它本来就合法，守卫一个字都不该改。
  const pendingView = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "readFile", input: { path: "a" } }] },
  ];
  const stats = {};
  const out = ensureUserTurnView(structuredClone(pendingView), structuredClone(pendingView), stats);

  assert.deepEqual(out, pendingView, "原样放行：逐条逐字段相等，user 不许被复制，pending tool_use 不许被摘掉");
  assert.equal(out.filter((message) => message.role === "user").length, 1, "user 轮必须恰好 1 条");
  assert.equal(
    out.at(-1)?.content?.some((block) => block?.type === "tool_use"),
    true,
    "尾部那条 pending tool_use 必须还在",
  );
  assert.equal(stats.action, undefined, "真没做事就必须静默，不许记任何守卫动作");
  assert.equal(isUserTurnGuardAction(stats.action), false);
});

test("T7 #292-R1 max_tokens 续写的第二个请求必须还是「1 条 user 轮 + 尾部 pending tool_use」", async () => {
  // 场景照 test/loop-v020.test.js 的「allows a truncated tool response to request its continuation」，
  // 但那条只断言请求次数与终稿文本，没看第二个请求的 messages，所以 R1 的形状漂移没被拦住。
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        return {
          content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
          stopReason: "max_tokens",
        };
      }
      return { content: [{ type: "text", text: "continued" }], stopReason: "end_turn" };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "unused",
    completion: false,
  });

  assert.equal(requests.length, 2);
  assert.equal(result.finalText, "continued");

  const second = requests[1];
  assert.equal(
    second.filter((message) => message.role === "user").length,
    1,
    `续写请求里 user 轮必须恰好 1 条，实际形状 ${JSON.stringify(second.map((m) => `${m.role}:${JSON.stringify((m.content ?? []).map((b) => b.type))}`))}`,
  );
  assert.equal(
    second.at(-1)?.role === "assistant"
      && second.at(-1).content.some((block) => block?.type === "tool_use" && block.id === "call-1"),
    true,
    "续写请求的尾部必须还是那条 partial 的 assistant tool_use（守卫不许摘尾巴再补一条复制的 user 轮）",
  );
  assert.deepEqual(
    second.map((message) => message.role),
    ["user", "assistant"],
  );
});

// T8：续跑侧的回归锁（不是先红后绿的复现锁）。
// 事实：引擎里只有一个地方以 `allowPendingToolUse: true` 调 provider（grep
// `allowPendingToolUse: true` 只命中 orchestrator 的 max_tokens 续写那一处，由 T7 覆盖）；
// 续跑路径会先把 pending 工具重放/中断成 tool_result 再请求上游，所以续跑的第一个请求
// 尾部本来就不是 pending。本用例把这件事钉住：守卫上线后，续跑请求里每条 assistant
// tool_use 都必须仍在、且尾部仍是配好的 tool_result——守卫不许在那里摘尾巴或复制 user 轮。
test("T8 #292-R1 续跑的第一个请求必须保住历史里的每条 tool_use（守卫不在续跑路径上动刀）", async () => {
  const { createMemoryTranscriptStore } = await import("../src/store/memory.js");
  const store = createMemoryTranscriptStore();
  const controller = new AbortController();
  const firstProvider = createStrictUpstream([
    {
      content: [
        { type: "tool_use", id: "r1", name: "pad", input: { step: 1 } },
        { type: "tool_use", id: "r2", name: "pad", input: { step: 2 } },
      ],
      stopReason: "tool_use",
    },
  ]);

  await assert.rejects(
    runToolLoop({
      provider: firstProvider,
      initialUserMessage: "run two tools",
      tools: [{ name: "pad", description: "d", inputSchema: { type: "object", properties: {} } }],
      executeTool: async ({ id }) => {
        if (id === "r2") controller.abort();
        return `done-${id}`;
      },
      maxRounds: 2,
      completion: false,
      stallDetection: false,
      store,
      runId: "i292-resume-tail",
      signal: controller.signal,
    }),
    /abort/i,
  );

  const resumedViews = [];
  const resumedProvider = createStrictUpstream([
    { content: [{ type: "text", text: "resumed-done" }], stopReason: "end_turn" },
  ], { views: resumedViews });
  const result = await runToolLoop({
    provider: resumedProvider,
    resume: true,
    completion: false,
    stallDetection: false,
    store,
    runId: "i292-resume-tail",
    tools: [{ name: "pad", description: "d", inputSchema: { type: "object", properties: {} } }],
    executeTool: async ({ id }) => `resumed-${id}`,
  });

  assert.equal(result.termination.reason, "end_turn");
  assert.equal(resumedViews.length, 1, "续跑必须只发一次上游请求");
  const blocks = resumedViews[0].messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []));
  assert.deepEqual(
    blocks.filter((block) => block?.type === "tool_use").map((block) => block.id),
    ["r1", "r2"],
    "续跑请求里两条 tool_use 必须都在（守卫不许摘掉它们）",
  );
  assert.deepEqual(
    blocks.filter((block) => block?.type === "tool_result").map((block) => block.tool_use_id),
    ["r1", "r2"],
    "每条 tool_use 必须仍配着结果",
  );
  assert.equal(
    resumedViews[0].messages.filter((message) => message.role === "user"
      && (Array.isArray(message.content) ? message.content : [])
        .some((block) => block?.type === "text" && /^run two tools$/u.test(String(block.text ?? ""))))
      .length,
    1,
    "初始那条 user 轮必须只有一份（守卫不许复制 user 轮）",
  );
});
