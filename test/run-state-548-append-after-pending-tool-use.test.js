// issue #548 —— run-state 请求视图追加**不看尾部形状**：尾部悬空 `tool_use` 后面接一条 user 文本
// ⇒ 配对断裂 ⇒ `ensureUserTurnView` 退到「只留最新 user 轮」⇒ 请求视图被压成 1 条、前面上下文整条丢。
//
// 缺陷坐标（#547 取证时挖出的真缺陷，不是测试钉子问题）：
//   · 追加点 `src/run-state.js#appendRunStateToRequestView`，唯一调用点
//     `src/loop/provider-runner.js:92`；
//   · 触发组合 = `max_tokens` 续写（`allowPendingToolUse: true`，全树唯一这样的调用点）
//     × 低预算 `requestInject`（`compactBeforeRound` → `requestStateBlock`，跨续写循环保留）；
//   · 视图变成 `[…, assistant(tool_use 悬空), user(注入文本)]` ⇒ 配对断裂 ⇒ 守卫落到
//     `preserved_latest_user_turn` ⇒ **视图压成 `count=1`**。
//   · 因果对照（同一 provider、无注入）：`guardStats=0`、视图 `count>=5` ⇒ 触发者是**注入**。
//   · 与既有纪律冲突：控制文本注入侧（`orchestrator.js`，#393/#394）是「先结清悬空 `tool_use`
//     再注入」，追加侧没有这一步。
//
// 修法（本单选定乙案：**跳过追加**，不是结清）：尾部是悬空 `tool_use` 时 run-state 追加整体不做。
// 理由（论证见 `/tmp/i548-report.md`，这里只留结论）：
//   · 这个形状是续写路线**刻意允许**的（`allowPendingToolUse: true` 的唯一调用点），追加才是外来破坏者；
//   · 甲案（结清）要在请求视图里补一条 `[erix] This tool call was never executed` 的
//     `tool_result`——而这条调用**接下来就会真的执行**（续写只是为了把被 max_tokens 截断的
//     assistant 正文补完），那是一条假事实，还会诱导模型重复发起同一个调用；
//   · 甲案还要么把公开同步函数 `appendRunStateToRequestView` 改成 async，要么新造第三套结清逻辑，
//     两条都越界（#394 的结构判据把结清实现与调用点钉死成一份 / 两个）。
//
// 本文件钉五面：
//   R1 最小复现（集成）：低预算注入 × 尾部悬空 `tool_use` ⇒ 视图**一条都不许被压成 1 条**，
//      守卫在请求视图那一处**一次都不记账**；同一次 run 里非悬空尾部的请求仍然拿到 run-state 块
//      （注入没有被整体关掉）。
//   U1/U2/U3/U4 追加函数的单元面：悬空尾部跳过；健康尾部照旧追加；多条 / 混排悬空同样跳过；
//      跳过时**不碰输入数组**（请求视图与持久列表是两份东西）。
//   R2 反向证：把「跳过」改回「照旧追加」⇒ U1/R1 必须红（本文件就是那条钉子）。
//
// 零真实 LLM（脚本化 provider）、不写盘、不碰 `~/.erix`（run-state 用内存 store）。

import test from "node:test";
import assert from "node:assert/strict";

import { appendRunStateToRequestView, renderRunState } from "../src/run-state.js";
import { validateMessages } from "../src/messages/rounds.js";
import { runToolLoop } from "../src/loop/orchestrator.js";

const filler = (count, char) => char.repeat(count);
const MARKER = "[run state deterministic v1]";

const PAD_TOOL = {
  name: "pad",
  description: "returns deterministic filler",
  inputSchema: { type: "object", properties: { step: { type: "number" } }, required: [] },
};

const executeTool = async () => ({
  content: [{ type: "text", text: `pad-result ${filler(1500, "f")}` }],
});

/** 一份真的 run-state 渲染文本（用生产渲染器，不手搓字符串）。 */
function renderedState() {
  return renderRunState({
    runId: "issue-548",
    stateVersion: 1,
    deterministic: {
      budget: { runRounds: 1, rounds: 1, maxRounds: 3, remainingRounds: 2 },
      tools: [{ name: "pad", calls: 1, failures: 0 }],
      filesWritten: [],
      termination: { reason: "running" },
      errors: { tool: 0, checkpoint: 0, unpersisted: { count: 0 } },
    },
  });
}

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.map((block) => String(block?.text ?? "")).join("")
  : String(message?.content ?? ""));

const seededHistory = () => [
  { role: "user", content: [{ type: "text", text: `oldest-user-turn ${filler(1200, "a")}` }] },
  { role: "assistant", content: [{ type: "text", text: filler(1200, "b") }] },
  { role: "user", content: [{ type: "text", text: `middle-user-turn ${filler(1200, "c")}` }] },
  { role: "assistant", content: [{ type: "text", text: filler(1200, "d") }] },
  { role: "user", content: [{ type: "text", text: `latest-user-turn ${filler(1200, "e")}` }] },
];

/** 脚本化 provider：记录每次请求视图（条数 / 是否带 run-state 块 / 尾部角色）。 */
function scriptedProvider(steps) {
  const views = [];
  let index = 0;
  const handle = async (request, channel) => {
    const messages = request.messages ?? [];
    views.push({
      channel,
      count: messages.length,
      users: messages.filter((message) => message?.role === "user").length,
      tailRole: messages.at(-1)?.role,
      tailTypes: Array.isArray(messages.at(-1)?.content)
        ? messages.at(-1).content.map((block) => block?.type)
        : [],
      hasRunState: messages.some((message) => textOf(message).includes(MARKER)),
    });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return typeof step === "function" ? step(request) : step;
  };
  return {
    views,
    protocol: "fake",
    model: "fake-model",
    async chat(request) { return handle(request, "chat"); },
    async chatStream(request) { return handle(request, "chatStream"); },
  };
}

/** 截断在 tool_use 上（每次一个新 id：续写会把内容并进同一条 assistant，重复 id 会被校验器拒）。 */
function truncatingProvider() {
  let counter = 0;
  return scriptedProvider([() => {
    counter += 1;
    return {
      content: [{ type: "tool_use", id: `t${counter}`, name: "pad", input: { step: counter } }],
      stopReason: "max_tokens",
    };
  }]);
}

function baseOptions({ provider, budgetTokens = 400000, maxRounds = 3, stream = false, messages }) {
  return {
    provider,
    tools: [PAD_TOOL],
    executeTool,
    config: {
      run: { maxRounds, completion: false, stallDetection: false, stream },
      input: { system: "call pad each round, then answer", messages },
      folding: {
        toolResultTtl: 1,
        toolResultFoldMinTokens: 1,
        context: { strategy: "fold-statistical", budgetTokens, keepRounds: 2, task: "issue #548" },
      },
    },
  };
}

const guardStats = (result) => (result.compactionStats ?? []).filter((stat) => stat.userTurnGuard !== undefined);
const requestViewChannels = (result) => guardStats(result)
  .map((stat) => stat.userTurnGuardChannel)
  .filter((channel) => channel === "chat" || channel === "chatStream");

// ─────────────────────────────────────────── U1-U4 追加函数的单元面

test("U1 #548 尾部是悬空 tool_use ⇒ 跳过追加（视图原样返回，同一个引用）", () => {
  const view = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "pad", input: { step: 1 } }] },
  ];
  const rendered = renderedState();
  const result = appendRunStateToRequestView(view, rendered);

  assert.equal(result, view, "跳过追加必须原样返回（不许复制、不许摘尾巴）");
  assert.equal(result.length, 2, "视图不许被压成 1 条：悬空 tool_use 后面不许出现 user 文本");
  assert.equal(result.at(-1).role, "assistant");
  // 跳过之后视图仍然是「续写路线刻意允许」的形状：allowPendingToolUse 放行。
  assert.doesNotThrow(() => validateMessages(result, { allowPendingToolUse: true }));
  // 而追加过的形状（今天的缺陷）恰恰不合法 —— 这条断言是「为什么必须跳过」的机器证据。
  assert.throws(
    () => validateMessages([
      ...view,
      { role: "user", content: [{ type: "text", text: rendered }] },
    ], { allowPendingToolUse: true }),
    /assistant tool_use has no immediately following user tool_result/u,
  );
});

test("U2 #548 健康尾部照旧追加（注入没有被整体关掉）", () => {
  const rendered = renderedState();
  const afterAssistantText = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "thinking" }] },
  ];
  const a = appendRunStateToRequestView(afterAssistantText, rendered);
  assert.equal(a.length, 3);
  assert.equal(a.at(-1).role, "user");
  assert.equal(textOf(a.at(-1)), rendered);
  assert.equal(afterAssistantText.length, 2, "追加不许改输入（持久列表是另一份东西）");

  const afterUser = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "pad", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r1" }] },
  ];
  const b = appendRunStateToRequestView(afterUser, rendered);
  assert.equal(b.length, 4, "配对已结清（tool_result 在场）⇒ 追加合法，照旧做");
  assert.equal(b.at(-1).role, "user");
  assert.equal(textOf(b.at(-1)), rendered);

  const empty = appendRunStateToRequestView([], rendered);
  assert.equal(empty.length, 1, "空视图照旧追加（守卫 I1 依赖这条 user 轮）");
});

test("U3 #548 多条悬空 tool_use / 文本+tool_use 混排的尾部同样跳过", () => {
  const rendered = renderedState();
  const multi = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "pad", input: {} },
        { type: "tool_use", id: "t2", name: "pad", input: {} },
      ],
    },
  ];
  assert.equal(appendRunStateToRequestView(multi, rendered), multi, "两条悬空同样跳过");

  const mixed = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "partial answer" },
        { type: "tool_use", id: "t1", name: "pad", input: {} },
      ],
    },
  ];
  assert.equal(appendRunStateToRequestView(mixed, rendered), mixed, "文本+tool_use 混排的尾部同样是悬空");

  const noTail = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "pad", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r1" }] },
  ];
  assert.equal(appendRunStateToRequestView(noTail, rendered).length, 4, "悬空块不在尾部 ⇒ 不算悬空");
});

test("U4 #548 跳过与追加都不改输入数组与块对象（视图 ≠ 持久列表）", () => {
  const rendered = renderedState();
  const view = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "pad", input: { step: 1 } }] },
  ];
  const before = structuredClone(view);
  appendRunStateToRequestView(view, rendered);
  assert.deepEqual(view, before, "跳过这一格必须零副作用");

  const healthy = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
  ];
  const healthyBefore = structuredClone(healthy);
  const appended = appendRunStateToRequestView(healthy, rendered);
  assert.deepEqual(healthy, healthyBefore, "追加这一格也只返回新数组，不改持久消息");
  assert.notEqual(appended, healthy);
});

// ─────────────────────────────────────────── R1 最小复现（集成）

for (const stream of [false, true]) {
  test(`R1 #548 最小复现 stream=${stream}：低预算注入 × 尾部悬空 tool_use 不许把视图压成 1 条`, async () => {
    // 生产者形状（#547 那一条，现在要按新事实钉住）：
    // maxRounds 3 ⇒ 首轮 remainingRounds=2 ⇒ 低预算 ⇒ requestStateBlock 非空；
    // provider 把 max_tokens 截断在 tool_use 上 ⇒ 续写调用 allowPendingToolUse: true。
    const provider = truncatingProvider();
    const result = await runToolLoop(baseOptions({
      provider,
      budgetTokens: 400000,
      maxRounds: 3,
      stream,
      messages: seededHistory(),
    }));

    assert.equal(result.termination.reason, "continuation_exhausted", "前提：必须真的走进续写循环");
    assert.ok(provider.views.length >= 2, `前提：至少两次请求（首轮 + 续写），实际 ${provider.views.length}`);

    // ① 今天的事实（缺陷）：某次请求视图被压成 1 条（只剩最新 user 轮），前面上下文全丢。
    assert.deepEqual(
      provider.views.filter((view) => view.count <= 1),
      [],
      `任何一次请求视图都不许被压成 1 条（缺陷现场：preserved_latest_user_turn 把整段上下文摘掉）。实际 ${JSON.stringify(provider.views)}`,
    );
    assert.ok(
      provider.views.every((view) => view.count >= 5),
      `每次请求视图都必须保住种子历史的 5 条，实际 ${JSON.stringify(provider.views)}`,
    );

    // ② 守卫在请求视图那一处一次都不该记账（它没有被触发，就没有可观测信号）。
    assert.deepEqual(guardStats(result), [], "尾部悬空 tool_use 不是「视图缺 user 轮」，守卫无事可做");
    assert.deepEqual(requestViewChannels(result), [], "请求视图那一处的通道名没有生产者了（见 #548 报告）");

    // ③ 注入没有被整体关掉：非悬空尾部的请求（首轮）照旧拿到 run-state 块。
    assert.equal(provider.views[0].hasRunState, true,
      `首轮尾部是 user 轮，run-state 注入必须照旧生效，实际 ${JSON.stringify(provider.views[0])}`);
    // ④ 悬空尾部的续写请求：跳过注入、尾巴仍是那条悬空 assistant（不是被摘掉后补 user）。
    const danglingTailViews = provider.views.filter((view) => view.tailRole === "assistant");
    assert.ok(danglingTailViews.length >= 2,
      `前提：续写循环必须真的产生多次「尾部是 assistant」的请求，实际 ${JSON.stringify(provider.views)}`);
    for (const view of danglingTailViews) {
      assert.ok(view.tailTypes.includes("tool_use"),
        `续写请求的尾巴必须仍是那条悬空的 tool_use（跳过追加，不摘尾巴），实际 ${JSON.stringify(view)}`);
      assert.equal(view.hasRunState, false, `悬空尾部这一格必须真的跳过注入，实际 ${JSON.stringify(view)}`);
    }
  });
}
