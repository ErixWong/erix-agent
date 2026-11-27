// @ts-check
// issue #896 §3-C（PR #969 复审①）：`recall_ask` 工具的可达性与端到端判据。
//
// 核心判据（复审①「断线即不通过」）：**用一条真的经过 orchestrator 的测试**证明 recall_ask 能从
// `createRecallAskTool` 工厂拿得到、且 orchestrator 把 `recallProvider` 端口透传进了工具上下文——
// 假 provider、不联网。其余：端到端只装指定轮区间原文（诱饵轮排除）、evidenceRefs 经 recall_read
// 回账本 found 且逐字、改一个字⇒stale、端口不提供⇒unavailable 且不降级到主 provider。
//
// 既有 15 格（evidence 三态 / maxTokens / 单发 / engine 桶 / uncertain）在
// `test/loop/recall-evidence-896c.test.js` 兜，本文件只补复审①③新增的格子。

import test from "node:test";
import assert from "node:assert/strict";

import { createRecallAskTool } from "../../src/tools/recall-ask.js";
import { createBuiltinRecallTools } from "../../src/tools/recall.js";
import { RECALL_MAX_EVIDENCE_BYTES, sha256Hex } from "../../src/loop/recall-runner.js";
import { runDirect } from "../helpers/run-direct.js";

/** 区间内两轮的账本原文（一条消息行 + 一条轮载体行，覆盖 recall_read 的两条口径）。 */
const R1_TEXT = "第1轮原文 R1_MARK 折叠前落盘的内容";
const R2_TEXT = "第2轮原文 R2_MARK 也是被折叠的那几轮";
const BAIT_TEXT = "第9轮诱饵 BAIT_MARK 区间外绝不该出现在请求里";

/** 造账本：round 1（消息行）、round 2（轮载体行）、round 9（区间外诱饵）。 */
function makeLedger() {
  /** @type {any[]} */
  const rows = [
    { kind: "message", round: 1, seq: 0, messages: [{ role: "user", content: R1_TEXT }] },
    // 轮载体行**不带 seq**（照真实写侧：orchestrator 的轮 record 只有 round/roundKey/dedupKey/ts…，
    // 只有消息行带轮内 seq）。evidence 现在按内容寻址（round + textSha256 + occurrence）寻址（PR #973），
    // 不再依赖行身份 ⇒ 载体行有没有 seq 都不影响定位。
    { kind: "round", round: 2, roundKey: "run-ask:round:2", messages: [{ role: "user", content: R2_TEXT }] },
    { kind: "round", round: 9, roundKey: "run-ask:round:9", messages: [{ role: "assistant", content: BAIT_TEXT }] },
  ];
  return { rows, readLedgerRows: () => rows };
}

/** 假回忆 provider：记调用次数、抓最后一次请求、返回可解析 JSON。 */
function makeRecallProvider(payload) {
  /** @type {{calls:number, lastRequest:any}} */
  const state = { calls: 0, lastRequest: null };
  const provider = (/** @type {any} */ request) => {
    state.calls += 1;
    state.lastRequest = request;
    const text = typeof payload === "string"
      ? payload
      : JSON.stringify(payload ?? { answer: "RECALL_ANSWER", pointers: [], uncertain: false });
    return Promise.resolve({
      content: [{ type: "text", text }],
      usage: { input_tokens: 9, output_tokens: 3 },
    });
  };
  return { provider, state };
}

/**
 * 自定义主 provider（记请求、不耗尽）：第 1 次发 recall_ask 的 tool_use，之后发 end_turn 正文。
 * 引擎会对纯文本 end_turn 发「请继续完成任务」的 nudge、多跑几轮才以 no_tool 收尾，故不用有限脚本。
 * @param {{name?: string, question?: string, fromRound?: number, toRound?: number}} toolUseInput
 */
function makeModelProvider(toolUseInput) {
  /** @type {any[]} */
  const requests = [];
  const state = { calls: 0, requests };
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat(/** @type {any} */ request) {
      state.calls += 1;
      requests.push(request);
      const content = state.calls === 1
        ? [{ type: "tool_use", id: "tu1", name: toolUseInput.name ?? "recall_ask", input: toolUseInput }]
        : [{ type: "text", text: "收尾" + state.calls }];
      return { content, stopReason: state.calls === 1 ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  return { provider, state };
}

// ─── 格 1（工厂）：recall_ask 从工厂拿得到、定义形状对 ─────────────────────────
test("#896A-1 createRecallAskTool 可拿到；定义 name=recall_ask、required=question/fromRound/toRound", () => {
  assert.equal(typeof createRecallAskTool, "function");
  const { definitions } = createRecallAskTool({ readLedgerRows: () => [] });
  assert.equal(definitions.length, 1);
  const tool = definitions[0];
  assert.equal(tool.name, "recall_ask");
  assert.deepEqual(tool.inputSchema.required, ["question", "fromRound", "toRound"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.throws(() => createRecallAskTool({}), TypeError, "缺 readLedgerRows ⇒ TypeError");
});

// ─── 格 2（可达性·经过 orchestrator）：recall_ask 能在工具上下文拿到 recallProvider ──
test("#896A-2 可达性：真经 orchestrator，recall_ask 从工具上下文拿到 recallProvider（假 provider，不联网）", async () => {
  const { readLedgerRows } = makeLedger();
  const evidenceSink = [];
  const { definitions, executeTool: recallAskExecute } = createRecallAskTool({
    readLedgerRows,
    recordEvidence: (/** @type {any} */ e) => evidenceSink.push(e),
  });
  const recall = makeRecallProvider({ answer: "RECALL_ANSWER", pointers: [], uncertain: false });
  const main = makeModelProvider({ name: "recall_ask", question: "折叠里写过什么", fromRound: 1, toRound: 2 });

  /** @type {string[]} */
  const toolResults = [];
  const executeTool = async (/** @type {any} */ opts) => {
    if (opts.name === "recall_ask") {
      // 把引擎给的整包（含 context）转给工厂的 executeTool——context.recallProvider 由 orchestrator 注入。
      const out = await recallAskExecute(opts);
      toolResults.push(out);
      return out;
    }
    return "ok";
  };

  await runDirect({
    provider: main.provider,
    tools: definitions,
    executeTool,
    capabilities: { ports: { recallProvider: recall.provider } },
    initialUserMessage: "开始",
    maxRounds: 8,
    maxTokenContinuations: 0,
  });

  // 端口被 recall_ask 真调用了一次 ⇒ orchestrator 把 recallProvider 送进了工具上下文（断线即不通过）。
  assert.equal(recall.state.calls, 1, "recall_ask 必须经 orchestrator 注入的端口真调了一次回忆 provider");
  assert.equal(toolResults.length, 1, "recall_ask 必须被真执行了一次");
  const parsed = JSON.parse(toolResults[0]);
  assert.equal(parsed.status, "found");
  assert.equal(parsed.answer, "RECALL_ANSWER");
  assert.equal(parsed.uncertain, false);
  assert.ok(Array.isArray(parsed.evidenceRefs) && parsed.evidenceRefs.length === 2, "区间内两轮各一片证据");
  assert.equal(evidenceSink.length, 2, "每片经 recordEvidence 落 record.recallEvidence");
  // 请求里只含区间内原文（诱饵轮 9 不出现）。
  const sent = JSON.stringify(recall.state.lastRequest);
  assert.ok(sent.includes("R1_MARK") && sent.includes("R2_MARK"), "区间内两轮原文必须在请求里");
  assert.ok(!sent.includes("BAIT_MARK"), "区间外诱饵轮（round 9）不许出现在请求里");
  // maxTokens 硬顶 / temperature:0（单发纪律）也随请求下去。
  assert.equal(recall.state.lastRequest.maxTokens, 1024);
  assert.equal(recall.state.lastRequest.temperature, 0);
});

// ─── 格 3（不降级）：端口不提供 ⇒ unavailable，且一条 provider 都不调（含主 provider 不降级）──
test("#896A-3 端口不提供 ⇒ unavailable；不降级到主 provider（经 orchestrator）", async () => {
  const { readLedgerRows } = makeLedger();
  const { definitions, executeTool: recallAskExecute } = createRecallAskTool({ readLedgerRows });
  const main = makeModelProvider({ name: "recall_ask", question: "q", fromRound: 1, toRound: 2 });
  /** @type {string[]} */
  const toolResults = [];
  const executeTool = async (/** @type {any} */ opts) => {
    if (opts.name === "recall_ask") {
      const out = await recallAskExecute(opts);
      toolResults.push(out);
      return out;
    }
    return "ok";
  };
  // 关键：capabilities 里**不给** ports.recallProvider。
  await runDirect({
    provider: main.provider,
    tools: definitions,
    executeTool,
    initialUserMessage: "开始",
    maxRounds: 8,
    maxTokenContinuations: 0,
  });
  const parsed = JSON.parse(toolResults[0]);
  assert.equal(parsed.status, "unavailable", "端口缺失 ⇒ unavailable");
  assert.ok(/不可用|未提供/.test(parsed.reason ?? ""), "话术含「不可用/未提供」");
  // 不降级：recall_ask 没拿主 provider 凑数——主 provider 的所有请求里都没有回忆请求（系统提示「回忆检索器」）。
  assert.ok(!main.state.requests.some((/** @type {any} */ r) => JSON.stringify(r).includes("回忆检索器")),
    "recall_ask 不许把回忆请求发给主 provider（不降级）");
});

// ─── 格 4（e2e 单元）：请求只含指定轮区间原文，诱饵轮排除 ─────────────────────
test("#896A-4 e2e：recall_ask 请求里只有指定轮区间的原文（区间外诱饵不出现）", async () => {
  const { readLedgerRows } = makeLedger();
  const recall = makeRecallProvider();
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "REAL_Q", fromRound: 1, toRound: 2 },
    context: { recallProvider: recall.provider },
  }));
  assert.equal(out.status, "found");
  const sent = JSON.stringify(recall.state.lastRequest);
  assert.ok(sent.includes("REAL_Q") && sent.includes("R1_MARK") && sent.includes("R2_MARK"));
  assert.ok(!sent.includes("BAIT_MARK"), "只装 [1,2]，round 9 诱饵不出现");
});

// ─── 格 5（e2e 回账本）：evidenceRefs 拿去 recall_read ⇒ found 且逐字等于账本原文 ──
test("#896A-5 e2e：recall_ask 的 evidenceRefs 经 recall_read({evidenceRef}) ⇒ found 且逐字等于账本原文", async () => {
  const { rows, readLedgerRows } = makeLedger();
  const recall = makeRecallProvider();
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 2 },
    context: { recallProvider: recall.provider },
  }));
  assert.equal(out.evidenceRefs.length, 2);
  const { executeTool: readTool } = createBuiltinRecallTools({ readLedgerRows });
  const expectByRound = { 1: R1_TEXT, 2: R2_TEXT };
  for (const ref of out.evidenceRefs) {
    const back = JSON.parse(await readTool({ name: "recall_read", input: { evidenceRef: ref } }));
    assert.equal(back.status, "found", `ref round=${ref.round} 必须回账本 found`);
    assert.equal(back.text, expectByRound[ref.round], "回验文本必须逐字等于账本原文");
    assert.ok(rows.some((/** @type {any} */ r) => JSON.stringify(r.messages).includes(back.text)), "回验文本必须能在账本里找到");
  }
});

// ─── 格 6（回账本改字⇒stale）：账本原文改了 ⇒ 同一 evidenceRef ⇒ stale ──────
test("#896A-6 把账本原文改一个字 ⇒ 同一 evidenceRef ⇒ stale（绝不回一份差不多的）", async () => {
  const { rows, readLedgerRows } = makeLedger();
  const recall = makeRecallProvider();
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 2 },
    context: { recallProvider: recall.provider },
  }));
  const refOld = out.evidenceRefs.find((/** @type {any} */ r) => r.round === 1);
  assert.ok(refOld, "应有 round 1 的 ref");
  // 账本改一个字（等长替换：原文→原纹）。内容寻址下这条消息**仍能被认出**（拿改后正文的 sha256
  // 仍定位到同轮同正文），但它当初记录的**切片 sha256 是旧正文**的 ⇒ 重算不一致 ⇒ stale（影子对不上原文）。
  const NEW = R1_TEXT.replace("原文", "原纹");
  rows[0].messages[0].content = NEW;
  const ref = { ...refOld, textSha256: sha256Hex(NEW) };
  const { executeTool: readTool } = createBuiltinRecallTools({ readLedgerRows });
  const back = JSON.parse(await readTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(back.status, "stale");
  assert.notEqual(back.actualSha, ref.sha256, "改字后 sha 必须对不上");
});

// ─── 格 7（invalid）：question 空 / 轮区间非法 ⇒ invalid（不调 provider）──────────
test("#896A-7 invalid：question 空 / fromRound>toRound / 非正整数 ⇒ invalid（不调 provider）", async () => {
  const { readLedgerRows } = makeLedger();
  let calls = 0;
  const provider = () => { calls += 1; return Promise.resolve({ content: [{ type: "text", text: "{}" }] }); };
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const emptyQ = JSON.parse(await executeTool({ name: "recall_ask", input: { question: "", fromRound: 1, toRound: 2 }, context: { recallProvider: provider } }));
  assert.equal(emptyQ.status, "invalid");
  const reversed = JSON.parse(await executeTool({ name: "recall_ask", input: { question: "q", fromRound: 5, toRound: 2 }, context: { recallProvider: provider } }));
  assert.equal(reversed.status, "invalid");
  const nonInt = JSON.parse(await executeTool({ name: "recall_ask", input: { question: "q", fromRound: 0, toRound: 2 }, context: { recallProvider: provider } }));
  assert.equal(nonInt.status, "invalid");
  assert.equal(calls, 0, "invalid 输入一条 provider 都不调");
});

// ─── 格 8（单一真相）：验证侧 2 KiB 常量与生成侧同值 ─────────────────────────
test("#896A-8 验证侧 2 KiB 上限与 recall-runner 生成侧同值（单一真相 2048）", () => {
  assert.equal(RECALL_MAX_EVIDENCE_BYTES, 2048);
});

// ─── 格 9 / 10（PR #969 合并后终验的真缺陷）：轮内**位置**漂移不许误报 stale ──────
// 缺陷：evidence 曾用 `(round, messageIndex)` 寻址，而那个下标是「消息行在前、轮载体行在后」当场
// 数出来的 ⇒ 同一轮再落一条消息行（resume 补工具结果、普通工具结果入账）或把消息行折进轮载体，
// 都会把载体行里那条消息的**轮内下标**挪位，而它的文本一个字都没变 ⇒ 重算 sha256 对不上 ⇒ 假 stale。
// 修法（PR #973）：evidence 改**内容寻址** `(round, textSha256, occurrence)`——用那条消息整段正文的
// sha256 定正文、轮内同正文第几次出现区分重复；文本未变则身份不变，位置怎么漂都仍 found。
const CARRIER_TEXT = "载体里的引擎控制正文 CARRIER_MARK";
const TOOL_RESULT_TEXT = "同轮后补的工具结果 TOOLRESULT_MARK 这条比载体那条长，好让切片不越界";
const ABSORBED_TEXT = "被折进轮载体的那条消息行 ABSORB_MARK 也比载体那条长，好让切片不越界";

/**
 * 造一份「轮 1 有一条轮载体行 + 一条消息行」的账本：轮内口径把消息行排在载体行**前面**。
 * 载体行**不带 seq**（照真实写侧：只有消息行带轮内 seq，轮 record 没 seq）。
 */
function makeDriftLedger() {
  /** @type {any[]} */
  const rows = [
    { kind: "round", round: 1, roundKey: "run-ask:round:1", messages: [{ role: "assistant", content: CARRIER_TEXT }] },
    { kind: "message", round: 1, seq: 0, messages: [{ role: "user", content: R1_TEXT }] },
  ];
  return { rows, readLedgerRows: () => rows };
}

/** 对 round 1 发一次 recall_ask，取回**载体那条**的 evidenceRef（按 sha256 认领，不靠位置下标）。 */
async function carrierRefFor(readLedgerRows) {
  const recall = makeRecallProvider();
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 1 },
    context: { recallProvider: recall.provider },
  }));
  const carrierSha = sha256Hex(CARRIER_TEXT);
  const ref = out.evidenceRefs.find((/** @type {any} */ r) => r.sha256 === carrierSha);
  assert.ok(ref, `recall_ask 必须交出载体那条的 ref（实有 ${JSON.stringify(out.evidenceRefs)}）`);
  return ref;
}

test("#896D-1 同轮再落一条消息行（轮内下标漂移、文本未变）⇒ 同一 evidenceRef 仍 found（不许假 stale）", async () => {
  const { rows, readLedgerRows } = makeDriftLedger();
  const ref = await carrierRefFor(readLedgerRows);

  // resume 往**同一轮**追加一条工具结果消息行：账本只追加、既有行的文本一字未动，
  // 但轮内位置口径下载体那条从下标 1 被顶到下标 2（copilot 指的就是这一步）。
  rows.push({ kind: "message", round: 1, seq: 2, messages: [{ role: "user", content: TOOL_RESULT_TEXT }] });

  const { executeTool: readTool } = createBuiltinRecallTools({ readLedgerRows });
  const back = JSON.parse(await readTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(back.status, "found", `文本未变、只是位置挪了 ⇒ 必须仍 found（实得 ${back.status}：${back.reason ?? ""}）`);
  assert.equal(back.text, CARRIER_TEXT, "回验文本必须逐字等于那条没变过的载体正文");
});

test("#896D-2 消息行被折进轮载体（载体留在原行位、文本未变）⇒ 同一 evidenceRef 仍 found", async () => {
  const { rows, readLedgerRows } = makeDriftLedger();
  const ref = await carrierRefFor(readLedgerRows);

  // `foldMessageRows` 的读侧效果：同轮消息行被**吸收**（不再单独出现在 `store.load()` 里），
  // 正文接到轮载体行尾部（载体行留在原来的行位上）⇒ 载体那条的轮内位置下标又变了，文本照旧没变。
  const absorbed = rows.filter((/** @type {any} */ r) => r.kind === "message");
  const carrier = rows.find((/** @type {any} */ r) => r.kind === "round");
  const foldedRows = [{
    ...carrier,
    messages: [...carrier.messages, ...absorbed.map((/** @type {any} */ r) => ({ role: "user", content: ABSORBED_TEXT }))],
  }];
  const { executeTool: readTool } = createBuiltinRecallTools({ readLedgerRows: () => foldedRows });
  const back = JSON.parse(await readTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(back.status, "found", `折进来一条也不会让载体正文变 ⇒ 必须仍 found（实得 ${back.status}：${back.reason ?? ""}）`);
  assert.equal(back.text, CARRIER_TEXT);
});

// ─── 格 11（PR #973 拒 PR #973 的根因）：真实形状账本（轮载体行**无** seq）⇒ found ─────
// 上一版按 `rowSeq` 寻址：轮 record 不带 seq（只有消息行带、且是每轮计数器），而 store.load() 又把
// 消息行折进轮载体 ⇒ 载体行上的 rowSeq 恒 null ⇒ 真实路径上必 invalid、功能整体不可用。本格钉死这一点。
test("#896D-7 真实形状账本（轮载体行**无** seq）⇒ recall_ask 交出的每个 evidenceRef 回账本都 found", async () => {
  const carrierRow = {
    kind: "round", round: 4, roundKey: "run-ask:round:4",
    messages: [
      { role: "assistant", content: CARRIER_TEXT },
      { role: "user", content: TOOL_RESULT_TEXT },
    ],
  };
  assert.ok(!("seq" in carrierRow), "夹具必须是真实形状：轮载体行没有 seq");
  const readLedgerRows = () => [carrierRow];
  const recall = makeRecallProvider();
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 4, toRound: 4 },
    context: { recallProvider: recall.provider },
  }));
  assert.equal(out.status, "found");
  assert.equal(out.evidenceRefs.length, 2, "两条正文各出一个 evidenceRef");
  const expectedBySha = {
    [sha256Hex(CARRIER_TEXT)]: CARRIER_TEXT,
    [sha256Hex(TOOL_RESULT_TEXT)]: TOOL_RESULT_TEXT,
  };
  const { executeTool: readTool } = createBuiltinRecallTools({ readLedgerRows });
  for (const ref of out.evidenceRefs) {
    assert.equal(ref.round, 4, "内容寻址下 round 定位必需");
    assert.ok(!("rowSeq" in ref), "新 ref 不再带 rowSeq");
    assert.ok(!("messageIndex" in ref), "新 ref 不再带 messageIndex");
    const back = JSON.parse(await readTool({ name: "recall_read", input: { evidenceRef: ref } }));
    assert.equal(back.status, "found", `真形状账本的 ref 必须 found（实得 ${back.status}：${back.reason ?? ""}）`);
    assert.equal(back.text, expectedBySha[ref.sha256], "回验文本必须逐字等于账本原文");
  }
});

// ═══ #261127-13：返回形状改造（真机评测：答案拿到了、模型不采纳——56 条指纹淹没答案）═══════
// 判据：① refs 收窄到与 pointers 按 round 重叠的那些；② 落账不受影响（recordEvidence 收全部）；
// ③ 无 pointers 取前 3；④ 上限 5；⑤ nextStep 两态钉字面且非命令式；⑥ 键顺序 answer 在 evidenceRefs 之前。

/** 造 `count` 轮账本：每轮一条消息行 ⇒ 切片数 = count（文本按轮可辨认）。 */
function makeWideLedger(count) {
  /** @type {any[]} */
  const rows = [];
  for (let r = 1; r <= count; r += 1) {
    rows.push({ kind: "message", round: r, seq: 0, messages: [{ role: "user", content: `轮${r}原文 WIDE_${r}_MARK` }] });
  }
  return { rows, readLedgerRows: () => rows };
}

/** 造 pointers（parseRecallDecision 要求 charRange 必须是数组）：每个给定轮一条。 */
function pointersFor(rounds) {
  return rounds.map((round) => ({ round, messageIndex: 0, charRange: [0, 4] }));
}

// ─── 格 12（refs 收窄 + 落账不受影响）：20 片、pointers 指 2 片 ───────────────────
test("#261127-13-1 refs 收窄：20 片切片、pointers 指其中 2 片 ⇒ 返回只 2 条、evidenceCount=20；recordEvidence 仍收 20 条", async () => {
  const { readLedgerRows } = makeWideLedger(20);
  /** @type {any[]} */
  const sink = [];
  const recall = makeRecallProvider({ answer: "WIDE_ANSWER", pointers: pointersFor([3, 7]), uncertain: false });
  const { executeTool } = createRecallAskTool({ readLedgerRows, recordEvidence: (/** @type {any} */ e) => sink.push(e) });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 20 },
    context: { recallProvider: recall.provider },
  }));
  assert.equal(out.status, "found");
  assert.equal(out.evidenceRefs.length, 2, "pointers 只指 2 轮 ⇒ 返回只留 round 重叠的那 2 条（≤5）");
  assert.deepEqual([...out.evidenceRefs.map((/** @type {any} */ r) => r.round)].sort((a, b) => a - b), [3, 7],
    "留下的必须是 pointers 指过的那两轮");
  assert.equal(out.evidenceCount, 20, "evidenceCount = 台账里的指纹总数");
  assert.equal(sink.length, 20, "落账不受收窄影响：recordEvidence 收到全部 20 条，一条不少");
});

// ─── 格 13（无 pointers）：取前 3 条，总数照报 ────────────────────────────
test("#261127-13-2 无 pointers ⇒ 返回前 3 条，evidenceCount 仍是总数 20", async () => {
  const { readLedgerRows } = makeWideLedger(20);
  const recall = makeRecallProvider({ answer: "WIDE_ANSWER", pointers: [], uncertain: false });
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 20 },
    context: { recallProvider: recall.provider },
  }));
  assert.equal(out.evidenceRefs.length, 3, "无 pointers ⇒ 前 3 条");
  assert.deepEqual(out.evidenceRefs.map((/** @type {any} */ r) => r.round), [1, 2, 3], "取的是台账顺序的前 3 轮");
  assert.equal(out.evidenceCount, 20, "refs 被截过 ⇒ 总数由 evidenceCount 告知");
});

// ─── 格 14（上限 5）：pointers 命中 8 片 ⇒ 返回 ≤5 ──────────────────────────
test("#261127-13-3 上限：pointers 命中 8 片 ⇒ 返回 ≤5 条（实为 5），evidenceCount 仍 20", async () => {
  const { readLedgerRows } = makeWideLedger(20);
  const recall = makeRecallProvider({ answer: "WIDE_ANSWER", pointers: pointersFor([1, 2, 3, 4, 5, 6, 7, 8]), uncertain: false });
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 20 },
    context: { recallProvider: recall.provider },
  }));
  assert.ok(out.evidenceRefs.length <= 5, `上限 5 条（实得 ${out.evidenceRefs.length}）`);
  assert.equal(out.evidenceRefs.length, 5, "命中 8 片 ⇒ 截到 5 条");
  assert.equal(out.evidenceCount, 20);
});

// ─── 格 15（nextStep 两态）：钉字面、互不相同、非命令式 ────────────────────
const NEXT_CALM = "uncertain=false 是模型自评（引擎不校验答案内容）；可核对的入口："
  + "recall_read({evidenceRef}) 逐字回账本、recall_read({pattern}) 在账本上检索。";
const NEXT_ASK = "uncertain=true 是模型自评（引擎不校验答案内容）；可核对的入口："
  + "recall_read({pattern}) 在账本上检索、recall_read({evidenceRef}) 逐字回账本。";

/** 「事实陈述」的守卫：既不许命令，也不许替模型背书（引擎不校验答案内容）。 */
function isNonDirective(text) {
  return !/你(必须|务必|不许|禁止|应该|应当)/.test(text)
    && !/直接用它|这就是事实|放心使用|需要.*时用/.test(text);
}

test("#261127-13-4 nextStep 两态：uncertain false/true 各钉一句字面，互不相同且都不是命令式", async () => {
  const { readLedgerRows } = makeWideLedger(3);
  const ask = async (/** @type {boolean} */ uncertain) => {
    const recall = makeRecallProvider({ answer: "A", pointers: [], uncertain });
    const { executeTool } = createRecallAskTool({ readLedgerRows });
    return JSON.parse(await executeTool({
      name: "recall_ask",
      input: { question: "q", fromRound: 1, toRound: 3 },
      context: { recallProvider: recall.provider },
    }));
  };
  const calm = await ask(false);
  const un = await ask(true);
  assert.equal(calm.nextStep, NEXT_CALM, "uncertain:false ⇒ 那句「到此为止」必须逐字对得上");
  assert.equal(un.nextStep, NEXT_ASK, "uncertain:true ⇒ 那句「还能怎么核」必须逐字对得上");
  assert.notEqual(calm.nextStep, un.nextStep, "两态必须互不相同");
  for (const s of [calm.nextStep, un.nextStep]) {
    // 事实陈述 ≠ 命令 ≠ 背书：引擎不校验答案内容，`uncertain` 只是模型自评（copilot 复审点出来的）。
    assert.ok(isNonDirective(s), `nextStep 只许陈述事实：${s}`);
  }
  // 守卫本身要能咬住——否则上面那条断言是空的（用一个已知违规的串自证）。
  assert.ok(!isNonDirective("直接用它就好。"), "守卫必须能咬住「替模型背书」");
  assert.ok(!isNonDirective("需要逐字核对时用 recall_read。"), "守卫必须能咬住「指令式措辞」");
});

// ─── 格 16（键顺序）：answer 在 evidenceRefs 之前 ─────────────────────────
test("#261127-13-5 键顺序：JSON.stringify 里「answer」出现在「evidenceRefs」之前（status 后第一眼就是答案）", async () => {
  const { readLedgerRows } = makeWideLedger(20);
  const recall = makeRecallProvider({ answer: "FIRST_KEY_ANSWER", pointers: [], uncertain: false });
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const raw = await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 20 },
    context: { recallProvider: recall.provider },
  });
  assert.ok(raw.includes('"answer"') && raw.includes('"evidenceRefs"'), "两个键都必须在返回里");
  assert.ok(raw.indexOf('"answer"') < raw.indexOf('"evidenceRefs"'),
    `键顺序就是模型读到的顺序：answer 必须在 evidenceRefs 之前（实得 ${raw.slice(0, 80)}…）`);
  assert.ok(raw.startsWith('{"status":"found","answer":"FIRST_KEY_ANSWER"'), "status 之后第一眼就是 answer");
  assert.ok(raw.indexOf('"evidenceRefs"') > raw.indexOf('"pointers"'), "refs 沉到指针之后");
});

// ─── 格 17（found 新形状全家福）：七键齐备、旧状态面不动 ────────────────────
test("#261127-13-6 found 形状：status/answer/nextStep/uncertain/pointers/evidenceRefs/evidenceCount 齐备；invalid/unavailable 面不变", async () => {
  const { readLedgerRows } = makeWideLedger(4);
  const recall = makeRecallProvider({ answer: "SHAPE", pointers: pointersFor([2]), uncertain: false });
  const { executeTool } = createRecallAskTool({ readLedgerRows });
  const out = JSON.parse(await executeTool({
    name: "recall_ask",
    input: { question: "q", fromRound: 1, toRound: 4 },
    context: { recallProvider: recall.provider },
  }));
  assert.deepEqual(Object.keys(out),
    ["status", "answer", "nextStep", "uncertain", "pointers", "evidenceRefs", "evidenceCount"],
    "found 的键必须按这个顺序齐备");
  assert.equal(out.pointers.length, 1, "pointers 原样透传（不被收窄）");
  // 旧状态面（invalid）一字不变：不带 nextStep / evidenceCount。
  const bad = JSON.parse(await executeTool({
    name: "recall_ask", input: { question: "", fromRound: 1, toRound: 2 }, context: { recallProvider: recall.provider },
  }));
  assert.equal(bad.status, "invalid");
  assert.ok(!("nextStep" in bad) && !("evidenceCount" in bad), "invalid 面保持旧形状不变");
});
