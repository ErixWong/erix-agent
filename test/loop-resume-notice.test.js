// issue #404（工单 BB「复活赛告示」）：**恢复运行要告诉模型「这是复活赛」**。
//
// 本文件钉五格（工单要求「至少五格」）+ 两格附加事实：
//   1. 上一轮带未回答 `tool_use` 的账本 ⇒ 告示逐条列出那些 `id`，且与 `pendingTrailingToolUses` 一致；
//   2. 尾部已结清的账本 ⇒ 仍然注入（「这是恢复」本身就是要告知的事实），但「未结清」那一节缺席；
//   3. 首次运行（非 resume）⇒ `messages` 与今天**逐字一致**（`deepEqual` 回归锚）；
//   4. 入账形状：走 `:control:` 行（不是 `kind:"message"` 消息行），`load()` 折回来顺序正确、
//      `validateMessages` 通过；
//   5. 幂等：内容相同的告示不重复注入；内容变了（事实变了）各一条、互不顶掉（不同 key 不冲突）。
//   附：告示的尺寸上限（不许膨胀成散文）与「全折叠配置下它会被折进摘要」这条已知边界。
//
// 反向证（工单要求的做法）：把 `src/loop/orchestrator.js` 里那段注入注释掉 ⇒ 本文件第 1 / 2 / 4 / 5
// 格当场红（第 3 格「非 resume 逐字一致」仍绿——那正是它存在的理由：证明注入**只**在恢复时发生）。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { pendingTrailingToolUses, validateMessages } from "../src/messages/rounds.js";
import {
  RESUME_NOTICE_NO_PENDING,
  RESUME_NOTICE_PENDING_HEADER,
  RESUME_NOTICE_SLOT,
  RESUME_NOTICE_TAG,
  RESUME_NOTICE_VERIFY_HEADER,
  buildResumeNotice,
} from "../src/loop/resume-notice.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const textTurn = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const toolTurn = (...ids) => ({
  content: ids.map((id) => ({ type: "tool_use", id, name: "work", input: { step: id } })),
  stopReason: "tool_use",
});
const tools = [{ name: "work", inputSchema: { type: "object" }, replay: "unsafe" }];

const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .map((block) => String(block?.text ?? ""))
  .join("");

/** 告示消息 = 带 `meta.source: "judge-control"` 且正文含标记的那条（宿主/judge 的既有识别口径）。 */
const noticesIn = (messages) => (Array.isArray(messages) ? messages : []).filter((message) => (
  message?.meta?.source === "judge-control" && textOf(message).includes(RESUME_NOTICE_TAG)
));

const noticeRows = (records) => records.filter((record) => (
  String(record?.dedupKey ?? "").includes(`:control:${RESUME_NOTICE_SLOT}`)
));

/** 两个**非确定位**归一化，好让 `deepEqual` 当回归锚用（其余字段逐字比）：
 *  · 随机分配的工具调用身份键 `tc_<12 hex>`；
 *  · **实测墙钟** `erix.durationMs`（`Date.now() - startedAt`，满负载跑全量套件时会从 0 变成 1+）——
 *    与 `scripts/message-journal-golden.mjs` 的 `VOLATILE_KEYS` 同一口径（那里也把 `durationMs` 剥掉）。 */
const stableKeys = (messages) => JSON.parse(
  JSON.stringify(messages)
    .replace(/tc_[0-9a-f]{12}/gu, "tc_stable")
    .replace(/"durationMs":\d+/gu, "\"durationMs\":0"),
);

/** 崩溃一次：第一次工具执行时中止（于是账本尾部是那条带 `tool_use` 的 assistant，结果一条都没落）。 */
async function crashMidTool(store, runId, ids) {
  const controller = new AbortController();
  await assert.rejects(runDirect({
    provider: createFakeProvider([toolTurn(...ids)]),
    initialUserMessage: "跑工具",
    executeTool: async () => {
      controller.abort();
      return "never-recorded";
    },
    maxRounds: 2,
    config: { run: { completion: false } },
    store,
    runId,
    tools,
    signal: controller.signal,
  }), /abort/iu);
}

// ── 1. 未结清的 `tool_use` 逐条列出，且与既有判据一致 ────────────────────────────────
test("#404 格1：恢复时逐条列出崩溃现场未结清的 tool_use（id + 工具名 + 参数摘要）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "bb-pending";
  await crashMidTool(store, runId, ["a", "b"]);

  // 前置：崩溃现场的判据（账本尾部就是那条带 tool_use 的 assistant）——告示必须与它同源。
  const before = await store.load(runId);
  const pendingAtCrash = pendingTrailingToolUses(before.flatMap((record) => record.messages ?? []));
  assert.deepEqual(pendingAtCrash.map((block) => block.id), ["a", "b"],
    "前置：崩溃现场必须有两条未结清的 tool_use（否则这一格测的是空气）");

  const resumedProvider = createFakeProvider([textTurn("续上了")]);
  const result = await runToolLoop({
    provider: resumedProvider,
    config: { run: { resume: true, runId, completion: false } },
    store,
    tools,
    executeTool: async ({ id }) => `resumed-${id}`,
  });
  const resumedRequests = resumedProvider.requests;

  const notices = noticesIn(result.messages);
  assert.equal(notices.length, 1, `恢复运行必须恰注入一条告示，实测 ${String(notices.length)}`);
  const body = textOf(notices[0]);
  assert.ok(body.startsWith(RESUME_NOTICE_TAG), `告示必须带标题标记 ${RESUME_NOTICE_TAG}`);
  assert.match(body, /第 1 轮/u, "告示必须给出「上一段停在第 N 轮」");
  assert.ok(body.includes(RESUME_NOTICE_PENDING_HEADER), "告示必须说清「这些调用没有结果」");
  for (const block of pendingAtCrash) {
    assert.ok(body.includes(`\`${block.id}\`(${block.name}`),
      `告示必须逐条列出 ${block.id}（工具 ${block.name}），实测正文：${body}`);
  }
  assert.ok(body.includes(RESUME_NOTICE_VERIFY_HEADER), "告示必须带「动手前先勘验」那条纪律");
  assert.match(body, /有副作用的调用/u, "告示必须点名「不要直接重发有副作用的调用」");
  // 主模型真的看得到：它进了那次真实请求（不是只进了返回值）。
  assert.equal(noticesIn(resumedRequests.at(-1).messages).length, 1,
    "告示必须真的进过 provider 请求（否则模型永远读不到它）");
});

// ── 2. 尾部已结清 ⇒ 仍然注入，但「未结清」那一节缺席 ────────────────────────────────
test("#404 格2：尾部已结清的账本恢复时仍然注入，但「未结清调用」一节缺席", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "bb-settled";
  await runDirect({
    provider: createFakeProvider([toolTurn("t1"), textTurn("第一段收口")]),
    initialUserMessage: "跑一轮",
    executeTool: async () => "ok",
    maxRounds: 3,
    config: { run: { completion: false } },
    store,
    runId,
    tools,
  });
  const settled = pendingTrailingToolUses((await store.load(runId)).flatMap((record) => record.messages ?? []));
  assert.deepEqual(settled, [], "前置：尾部必须已结清（末条不是带 tool_use 的 assistant）");

  const result = await runToolLoop({
    provider: createFakeProvider([textTurn("接着干")]),
    config: { run: { resume: true, runId, completion: false } },
    store,
    tools,
    executeTool: async () => "ok",
  });

  const notices = noticesIn(result.messages);
  assert.equal(notices.length, 1, "「这是恢复」本身就是要告知的事实 ⇒ 尾部结清也必须注入");
  const body = textOf(notices[0]);
  assert.ok(body.includes(RESUME_NOTICE_NO_PENDING), `尾部件必须换成「已结清」那句，实测：${body}`);
  assert.ok(!body.includes(RESUME_NOTICE_PENDING_HEADER), "已结清的账本不得再声称「这些调用没有结果」");
});

// ── 3. 非 resume ⇒ messages 与今天逐字一致（deepEqual 回归锚）────────────────────────
test("#404 格3：首次运行（非 resume）的 messages 与今天逐字一致（多一个字都算红）", async () => {
  const provider = createFakeProvider([toolTurn("t1"), textTurn("收工")]);
  const result = await runDirect({
    provider,
    initialUserMessage: "干活",
    executeTool: async () => "ok",
    maxRounds: 2,
    config: { run: { completion: false } },
    tools,
  });

  // 逐字锚：这条数组是**今天**（#404 之前）的形状，一个字段都不许变。
  assert.deepEqual(stableKeys(result.messages), [
    { role: "user", content: [{ type: "text", text: "干活" }] },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "t1",
        name: "work",
        input: { step: "t1" },
        erix: { toolCallKey: "tc_stable" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "ok\n[预算] 本轮后仅剩 1 轮；请立即给出结论，或明确声明不可恢复",
        erix: {
          toolCallKey: "tc_stable",
          round: 1,
          durationMs: 0,
          success: true,
        },
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "收工" }] },
  ]);
  // 而且请求视图里也一个字都没有（注入点只在恢复路径）。
  assert.equal(noticesIn(provider.requests[0].messages).length, 0);
  assert.ok(!JSON.stringify(provider.requests).includes(RESUME_NOTICE_TAG),
    "非 resume 的请求里不得出现告示标记");
});

// ── 4. 入账形状：`:control:` 行 + `load()` 折回来顺序正确 ─────────────────────────────
test("#404 格4：入账走 `:control:` 行，`load()` 折回来告示仍在 tool_result 之后，且消息序合法", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "bb-ledger";
  await crashMidTool(store, runId, ["a"]);

  await runToolLoop({
    provider: createFakeProvider([textTurn("续上了")]),
    config: { run: { resume: true, runId, completion: false } },
    store,
    tools,
    executeTool: async ({ id }) => `resumed-${id}`,
  });

  const records = await store.load(runId);
  const rows = noticeRows(records);
  assert.equal(rows.length, 1, `告示必须恰入账一条，实测 ${JSON.stringify(rows.map((row) => row.dedupKey))}`);
  assert.match(String(rows[0].dedupKey), /:engine:round:\d+:control:resume-notice:[0-9a-f]{16}$/u,
    "槽位名必须是 `control:resume-notice:<fp>`（内容指纹后缀：同内容幂等、变了换 key）");
  assert.equal(rows[0].kind, undefined,
    "**不是** `kind:\"message\"` 消息行——消息行会被 foldMessageRows 折回轮载体行，恢复时插错位置把配对打散");
  assert.equal(rows[0].seq, undefined, "`:control:` 行不带轮内序号（不参与折叠，原样透传）");

  // 折回来之后：整份消息序合法，且告示排在「tool_use → tool_result」**之后**。
  const folded = records.flatMap((record) => record.messages ?? []);
  validateMessages(folded);
  const toolUseAt = folded.findIndex((message) => (message?.content ?? [])
    .some((block) => block?.type === "tool_use" && block.id === "a"));
  assert.ok(toolUseAt >= 0, "账本里必须有那条崩溃现场的 tool_use");
  assert.deepEqual(
    folded[toolUseAt + 1].content.map((block) => block.tool_use_id),
    ["a"],
    "紧随 tool_use 的必须是补跑出来的 tool_result（不是告示）",
  );
  const noticeAt = folded.findIndex((message) => noticesIn([message]).length === 1);
  assert.ok(noticeAt > toolUseAt + 1,
    `告示必须排在配对之后（实测 tool_use@${String(toolUseAt)} / 告示@${String(noticeAt)}）`);
});

// ── 5. 幂等：同内容不重复；事实变了各一条 ────────────────────────────────────────────
test("#404 格5a：账本里已有同内容的告示 ⇒ 本次恢复不再注入第二份（同 key 幂等）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "bb-idempotent";
  // 一个「没有工具、尾部已结清」的最小账本 ⇒ 告示的事实完全确定（可预先算出同一个 key）。
  await store.appendRound(runId, {
    round: 0,
    roundKey: `${runId}:round:0`,
    messages: [
      { role: "user", content: [{ type: "text", text: "你好" }] },
      { role: "assistant", content: [{ type: "text", text: "在" }] },
    ],
    ts: "2026-01-01T00:00:00.000Z",
  });
  const expected = buildResumeNotice({ round: 0, stopReason: "running", pendingToolUses: [], filesWritten: [], toolCalls: [] });
  assert.ok(expected !== undefined);
  await store.appendRound(runId, {
    round: 0,
    roundKey: `${runId}:round:0`,
    dedupKey: `${runId}:engine:round:0:control:${expected.slot}`,
    messages: [{ role: "user", meta: { source: "judge-control" }, content: [{ type: "text", text: expected.text }] }],
    ts: "2026-01-01T00:00:01.000Z",
  });

  const result = await runToolLoop({
    provider: createFakeProvider([textTurn("继续")]),
    config: { run: { resume: true, runId, completion: false } },
    store,
    tools,
    executeTool: async () => "ok",
  });

  const notices = noticesIn(result.messages);
  assert.equal(notices.length, 1,
    "同内容的告示已在账本里 ⇒ 本次不得再注入第二份（折回来的那一条就是全部）");
  assert.equal(textOf(notices[0]), expected.text,
    "那一条必须逐字就是账本里那份（不是重新拼了一版）");
  assert.equal(noticeRows(await store.load(runId)).length, 1, "账本里也必须仍只有一条");
});

test("#404 格5b：连续 resume 两次、事实变了 ⇒ 各一条，且不同内容互不顶掉（不同 key 不冲突）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "bb-twice";
  await crashMidTool(store, runId, ["a"]);

  // 第一次恢复：注入告示之后、请求之前就崩（账本里只多出那条 `:control:` 行）。
  await assert.rejects(runToolLoop({
    provider: {
      protocol: "fake",
      model: "fake-model",
      async chat() {
        throw new Error("boom: 第一次恢复的请求炸了");
      },
      async chatStream() {
        throw new Error("boom: 第一次恢复的请求炸了");
      },
    },
    config: { run: { resume: true, runId, completion: false } },
    store,
    tools,
    executeTool: async () => "ok",
  }), /boom: 第一次恢复/u);
  const afterFirst = noticeRows(await store.load(runId));
  assert.equal(afterFirst.length, 1, "第一次恢复必须已经注入并入账");

  // 第二次恢复：事实变了一条（停机原因从「未入账」变成 `failed`——第一次崩溃自己写下的），
  // 所以是**另一条**告示：内容不同、key 不同，`appendRound` 不会判成同 key 异 payload 冲突。
  const second = await runToolLoop({
    provider: createFakeProvider([textTurn("第二次续上了")]),
    config: { run: { resume: true, runId, completion: false } },
    store,
    tools,
    executeTool: async ({ id }) => `resumed-${id}`,
  });
  const notices = noticesIn(second.messages);
  assert.equal(notices.length, 2, "两次恢复、事实不同 ⇒ 各一条（旧那条仍在上下文里，别把它抹掉）");
  assert.notEqual(textOf(notices[0]), textOf(notices[1]), "两条告示的正文必须不同（否则就是重复告示）");
  const rows = noticeRows(await store.load(runId));
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.dedupKey)).size, 2, "两条告示必须落在两个不同的 dedupKey 上");
});

// ── 附加：尺寸上限 + 已知边界 ───────────────────────────────────────────────────────
test("#404 附1：告示是一条消息、一段散文预算之内（不许膨胀成第二份上下文）", () => {
  const notice = buildResumeNotice({
    round: 12,
    stopReason: "max_rounds_cap",
    pendingToolUses: [
      { type: "tool_use", id: "toolu_01abcdef", name: "exec", input: { command: "npm publish --access public" } },
      { type: "tool_use", id: "toolu_02abcdef", name: "writeFile", input: { path: "src/loop/orchestrator.js", content: "x".repeat(4000) } },
    ],
    filesWritten: ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js", "src/f.js"],
    toolCalls: ["exec(npm test)", "writeFile(src/a.js)", "readFile(src/b.js)", "exec(git commit)"],
  });
  assert.ok(notice !== undefined);
  const bytes = Buffer.byteLength(notice.text, "utf8");
  assert.ok(bytes <= 1024, `告示必须 ≤ 1024 字节（实测 ${String(bytes)}）——它每一轮都要占输入 token`);
  assert.equal(notice.text.split("\n").length, 4, "四行：身份 / 未结清调用 / 账本现场 / 勘验纪律");
  // 参数摘要要截断：一个 4000 字节的写文件入参不许原样进上下文。
  assert.ok(!notice.text.includes("x".repeat(200)), "工具入参必须截断（摘要不是全文）");
});

test("#404 附2：已知边界——全折叠配置（keepRounds=0）下告示会在同一轮被折进摘要", async () => {
  // 这条钉的是**限制**，不是承诺：告示是最新的一轮，`keepRounds: 0` 会把整段（含它）折成摘要，
  // 于是模型看到的是摘要而不是告示原文。默认 `keepRounds = 6` 不会发生（告示在保留窗口内）。
  // 这里同时钉住「重算只发生一次」：告示让折叠输入变了 ⇒ 复用落空是**预期**，但不能每轮重算。
  const SUMMARY_SYSTEM = "你是对话历史压缩器";
  const summaryRequests = [];
  let summaryCalls = 0;
  const mainRequests = [];
  const script = [toolTurn("a1"), { throw: new Error("boom: 折叠之后炸了") }];
  let mainIndex = 0;
  const firstProvider = {
    protocol: "fake",
    model: "fake-model",
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaryRequests.push(request);
        summaryCalls += 1;
        return { content: [{ type: "text", text: `## 阶段\nSUMMARY_V${String(summaryCalls)}` }], stopReason: "end_turn" };
      }
      mainRequests.push(request);
      const step = script[Math.min(mainIndex, script.length - 1)];
      mainIndex += 1;
      if (step !== undefined && Object.prototype.hasOwnProperty.call(step, "throw")) throw step.throw;
      return { ...step };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  const store = createMemoryTranscriptStore();
  await assert.rejects(runDirect({
    provider: firstProvider,
    initialUserMessage: `start ${"y".repeat(600)}`,
    executeTool: async ({ id }) => `tool output ${id} ${"z".repeat(400)}`,
    maxRounds: 5,
    reflection: false,
    config: { folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm" } }, run: { completion: false } },
    store,
    runId: "bb-fold-edge",
  }), /boom: 折叠之后炸了/u);

  const resumedRequests = [];
  let resumedSummaries = 0;
  const resumedProvider = {
    protocol: "fake",
    model: "fake-model",
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        resumedSummaries += 1;
        return { content: [{ type: "text", text: `## 阶段\nSUMMARY_RESUME_V${String(resumedSummaries)}` }], stopReason: "end_turn" };
      }
      resumedRequests.push(request);
      return textTurn("续接结论");
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  await runToolLoop({
    provider: resumedProvider,
    // #498 S3 A19：`resume` 退役扁平写法，并进**同一个** `config` 容器（家 `config.run.resume`）。
    // #530: `reflection` 同样并进 `config.run`（家 `config.run.reflection`）。
    config: {
      folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm" } },
      run: { resume: true, runId: "bb-fold-edge", completion: false, reflection: false },
    },
    store,
    executeTool: async () => "ok",
  });

  assert.equal(resumedSummaries, 1, "告示让折叠输入变了 ⇒ 恰重算一次（不是每轮重算）");
  assert.ok(
    !JSON.stringify(resumedRequests).includes(RESUME_NOTICE_TAG),
    "keepRounds=0 下告示被折进摘要 ⇒ 模型看不到原文（已知边界，默认 keepRounds=6 不会这样）",
  );
});
