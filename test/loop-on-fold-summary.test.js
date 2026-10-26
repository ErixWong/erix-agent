// issue #470-D（P3）—— 折叠替代物强制投递出口 `context.policy.onFoldSummary` 的钩子判据。
//
// 被钉的三条口径（与 `docs/host-consumer-contract{,_cn}.md` 的「折叠替代物投递出口」一节逐字对应，
// 也对应 `src/loop/orchestrator.js` 折叠落账处那段注释的 ①②③）：
//   ① **无 `text` 不调用**：`buildFoldedFacts()` 无文本 ⇒ 整块不发生（不占通道、不造空横幅）；
//   ② 投递失败**不许改写 run 的终局**：经 `reportHostPersistenceFailure` 落
//      `persistence_error{port:"notes", operation:"onFoldSummary", phase:"fold_summary_delivery", fatal:false}`
//      （账本 + `diagnostics.error` + `onPersistenceError`）——**故意不用** `reportObserverError`：
//      它的出口是 `console.error`，而替代物是宿主侧的**数据**，必须进持久化账本（口径同 #109 notes 端口）；
//   ③ 钩子抱错（同步 throw 或 rejected Promise）不能拖死循环，且**不重试**：一次折叠 = 一次调用。
// 另钉投递内容：递的是**落进轮记录的那一份**（克隆隔离，宿主改载荷不得改到账本），不给「更漂亮的副本」。
//
// P3 的另一半 `context.maxFoldedFactsBytes`（夹断上界旋钮）也在这里钉：默认值不变
// （= `FOLDED_FACTS_MAX_BYTES` 2048）、非法值（0 / 负数 / 非整数）由 `buildFoldedFacts` 退回默认
// 而不是静默变成 0 字节的空横幅、且**钩子看到的字节上界 == 账本里那份的上界**（三者同源）。
//
// 入口不对称（实测，不是推测）：`createAssemblyPort`/`createAgent` 对**非函数**值启动期即抛
// （`assembly-validators.js#validateFoldSummaryHook`）；`runToolLoop` 直接入口只把名字收进白名单
// （不报 `unknown_option`），非函数值= 不投递。两格都钉住，免得宿主以为两处都校验。
//
// 零真实 LLM：fake provider + 内置内存 store（AGENTS.md 测试隔离规则：不写真实 `~/.erix`）。
import assert from "node:assert/strict";
import test from "node:test";

import { createAssemblyPort } from "../src/assembly.js";
import {
  FOLDED_FACTS_MAX_BYTES,
  FOLDED_FACTS_RECORD_FIELD,
} from "../src/compact/fold-summary-journal.js";
import { createSlidingWindowStrategy } from "../src/compact/sliding-window.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

// 与 #470 判据②那格同一套 fake provider：先 6 发工具调用把上下文撑起来（折叠必然发生），再收尾。
function makeProvider({ toolTurns = 6 } = {}) {
  let turns = 0;
  const provider = {
    // fake 协议的判别键：缺了它 runToolLoop 不会把这份 provider 当 fake 驱动。
    protocol: "fake",
    model: "fake-model",
    async chat() {
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{ type: "tool_use", id: `tu_${turns}`, name: "echo", input: { text: `R${turns}_${"填充".repeat(300)}` } }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" };
    },
  };
  provider.chatStream = provider.chat;
  return provider;
}

// 折叠必然发生的那条路：`budgetTokens` 很小 + `sliding-window` 策略（零 LLM，机械替代物）。
async function runFolding({ onFoldSummary, context = {}, diagnostics, onPersistenceError } = {}) {
  const store = createMemoryTranscriptStore();
  const runId = "s-470d-fold";
  const run = await runToolLoop({
    provider: makeProvider(),
    runId,
    store,
    initialUserMessage: "开始任务",
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    maxRounds: 20,
    completion: false,
    wrapup: false,
    stallDetection: false,
    onFoldSummary,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(onPersistenceError === undefined ? {} : { onPersistenceError }),
    // 折叠开关住在 `context` 里（`budgetTokens` / `keepRounds` / `strategy`），没有 `compaction` 这个键。
    context: {
      budgetTokens: 300,
      keepRounds: 1,
      strategy: createSlidingWindowStrategy({ keepRounds: 1 }),
      ...context,
    },
  });
  const records = await store.load(runId);
  return {
    run,
    records,
    factRecords: records.filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined),
  };
}

function collectDiagnostics() {
  const events = [];
  return { events, error: (event) => { events.push(event); } };
}

test("①投递：折叠落账处调用钩子，递的就是落进轮记录的那一份（+ round），且是克隆 (#470-D)", async () => {
  const payloads = [];
  const { run, factRecords } = await runFolding({
    onFoldSummary: (payload) => { payloads.push(payload); },
  });
  assert.ok(String(run?.finalText ?? "").includes("收尾结论"), `run 必须正常收尾：${JSON.stringify(run?.termination ?? {})}`);
  assert.ok(factRecords.length > 0, "前提：这条路径必须真的折叠并落账 foldedFacts");
  assert.equal(payloads.length, factRecords.length, "一次折叠落账 = 一次投递（不多投、不漏投）");

  const delivered = payloads[0];
  const {
    round,
    foldedRoundRange,
    foldedThrough,
    foldedRoundCount,
    ...withoutRound
  } = delivered;
  const ledgerRecord = factRecords.find((record) => Number(record.round) === round) ?? factRecords[0];
  const ledger = ledgerRecord[FOLDED_FACTS_RECORD_FIELD];
  assert.ok(Number.isSafeInteger(round), `payload 必须带轮号供宿主归档，实测 ${String(round)}`);
  // 「递的就是那一份」= 除新增的 `round` 外逐字段相等；宿主拿到的不是另算的漂亮副本。
  assert.deepEqual(withoutRound, ledger, "投递载荷必须与轮记录里那份逐字段相等");

  // issue #479：宿主写「折走第 a–b 轮」所需的三个数由引擎算好（宿主侧只能正则解析自己那行中文摘要）。
  // 不写成 `deepEqual(range, {from: ledger.from, to: ledger.to})`：若哪天 `from` 缺失，那条会退化成
  // `{from: undefined}` 的恒真比较（假绿）。这里两侧都先断言是整数，再比。
  assert.ok(Number.isSafeInteger(foldedRoundRange.from) && foldedRoundRange.from >= 1,
    `payload 的区间必须带 from，实测 ${JSON.stringify(foldedRoundRange)}`);
  assert.ok(Number.isSafeInteger(foldedRoundRange.to) && foldedRoundRange.to >= foldedRoundRange.from,
    `payload 的区间必须带 to 且 >= from，实测 ${JSON.stringify(foldedRoundRange)}`);
  assert.equal(foldedRoundRange.from, ledger.from, "from 与账本同一份");
  assert.equal(foldedRoundRange.to, ledger.to, "to 与账本同一份");
  assert.ok(Number.isSafeInteger(foldedThrough), `水位线必须是整数，实测 ${String(foldedThrough)}`);
  assert.ok(Number.isSafeInteger(foldedRoundCount), `累计轮数必须是整数，实测 ${String(foldedRoundCount)}`);
  assert.ok(typeof delivered.text === "string" && delivered.text !== "", "有替代物才谈得上投递");
  assert.equal(delivered.source, "strategy", "零 LLM 的机械替代物不得被标成模型摘要");
  assert.ok(Number.isSafeInteger(delivered.bytes) && delivered.bytes > 0);

  // 克隆隔离：宿主改载荷（station #392 C 片会往里拼 note 引用）不得改到账本。
  const before = JSON.stringify(ledger);
  delivered.text = "宿主改过的";
  delivered.injectedByHost = true;
  assert.equal(JSON.stringify(ledgerRecord[FOLDED_FACTS_RECORD_FIELD]), before,
    "投递的是克隆：宿主改载荷不得改写账本");
});

test("②无替代物不调用：不折叠 ⇒ 钩子 0 次、账本无该键、也不发空横幅 (#470-D)", async () => {
  let calls = 0;
  const diagnostics = collectDiagnostics();
  const store = createMemoryTranscriptStore();
  const runId = "s-470d-nofold";
  const run = await runToolLoop({
    provider: makeProvider({ toolTurns: 1 }),
    runId,
    store,
    initialUserMessage: "开始任务",
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "")}`,
    maxRounds: 10,
    completion: false,
    wrapup: false,
    stallDetection: false,
    onFoldSummary: () => { calls += 1; },
    diagnostics,
    // 预算宽裕 ⇒ 不触发折叠（下面的前提断言负责证明这一点，不让「没折叠」变成假前提）。
    context: { budgetTokens: 200_000, keepRounds: 6 },
  });
  const records = await store.load(runId);
  // 前提必须先成立，否则这格只是在测空气。
  assert.equal(records.filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined).length, 0,
    "前提：这条路径确实没产生替代物");
  assert.ok(run?.compactionStats === undefined || run.compactionStats.every((stat) => !stat.compacted),
    "前提：这条路径确实没折叠");
  assert.equal(calls, 0, "无 `text` ⇒ 不得调用（既不占通道，也不造空横幅）");
  assert.deepEqual(diagnostics.events.filter((event) => event.type === "persistence_error"), [],
    "没投递就不是失败，不得顺手发 persistence_error");
});

test("③投递失败：不改写终局，账本照写，落 persistence_error{port:\"notes\"} (#470-D)", async () => {
  const diagnostics = collectDiagnostics();
  const hostErrors = [];
  const { run, factRecords } = await runFolding({
    onFoldSummary: () => { throw new Error("宿主归档器炸了"); },
    diagnostics,
    onPersistenceError: (error) => { hostErrors.push(error); },
  });

  // 终局一个字都不许被钩子的故障改写（这是「不许改写 run 的终局」的可证伪面）。
  assert.equal(run?.termination?.reason, "end_turn", `终局被改写：${JSON.stringify(run?.termination ?? {})}`);
  assert.equal(run?.termination?.forcedFinal, undefined, "钩子故障不得伪装成强制收尾");
  assert.ok(String(run?.finalText ?? "").includes("收尾结论"), "正文不得因投递失败而丢失");
  assert.ok(factRecords.length > 0, "投递失败不得连累落账：轮记录里的替代物必须还在");

  const events = diagnostics.events.filter((event) => event.type === "persistence_error");
  assert.equal(events.length, factRecords.length, "每次失败的投递各留一条痕（不多记、不漏记）");
  for (const event of events) {
    assert.equal(event.port, "notes", "口径：走持久化账本的 notes 端口，不是 console/观察者通道");
    assert.equal(event.operation, "onFoldSummary");
    assert.equal(event.phase, "fold_summary_delivery");
    assert.equal(event.fatal, false, "非致命：继续跑，不终止 run");
    assert.equal(event.error.message, "宿主归档器炸了", "根因必须透传，不许被兜底词盖掉");
  }
  assert.equal(hostErrors.length, factRecords.length, "onPersistenceError 与 diagnostics.error 同一次故障各送一份");
});

test("③异步 rejected + 不重试：每次折叠恰好一次调用，run 照常终局 (#470-D)", async () => {
  const diagnostics = collectDiagnostics();
  let calls = 0;
  const { run, factRecords } = await runFolding({
    // rejected Promise 与同步 throw 必须走同一记账口（宿主写的是 async 归档器）。
    onFoldSummary: async () => { calls += 1; await Promise.reject(new Error("归档 rejected")); },
    diagnostics,
  });
  assert.ok(String(run?.finalText ?? "").includes("收尾结论"), `run 被 reject 拖死：${JSON.stringify(run?.termination ?? {})}`);
  assert.equal(calls, factRecords.length, "失败后不得重试：一次折叠 = 一次调用（重试会放大宿主侧写入）");
  const events = diagnostics.events.filter((event) => event.type === "persistence_error");
  assert.equal(events.length, factRecords.length);
  assert.ok(events.every((event) => event.port === "notes" && event.phase === "fold_summary_delivery"),
    "异步失败与同步失败同口径");
  assert.equal(run?.termination?.reason, "end_turn");
});

test("④形状校验：assembly 入口对非函数值启动期即抛，undefined 放行 (#470-D)", () => {
  const base = () => ({
    provider: { name: "p", chat: () => {}, chatStream: () => {} },
    tools: { definitions: [], executeTool: async () => "" },
    modelConfig: { resolve: async () => ({ model: "m", maxTokens: 1024, contextWindowTokens: 4096 }) },
    store: { appendRound: async () => {}, load: async () => [] },
    session: { id: "s-470d-assembly" },
  });
  for (const bad of ["notes", {}, 1, null, false]) {
    assert.throws(
      () => createAssemblyPort({ ...base(), policy: { onFoldSummary: bad } }),
      (error) => error instanceof TypeError && /onFoldSummary/.test(error.message),
      "非函数值必须启动期即抛且点名 onFoldSummary",
    );
  }
  // 省略 / 显式 undefined = 未配置 ⇒ 放行，行为与今天逐字一致。
  assert.doesNotThrow(() => createAssemblyPort({ ...base(), policy: { onFoldSummary: undefined } }));
  assert.doesNotThrow(() => createAssemblyPort(base()));
});

test("④直接入口：runToolLoop 认这个名字（不报 unknown_option），非函数值=不投递 (#470-D)", async () => {
  const diagnostics = collectDiagnostics();
  const store = createMemoryTranscriptStore();
  const runId = "s-470d-badhooks";
  // 白名单没收录这个键（P3 漏加）时这里会抛 unknown_option —— 那正是本格要拦的红。
  const run = await runToolLoop({
    provider: makeProvider(),
    runId,
    store,
    initialUserMessage: "开始任务",
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    maxRounds: 20,
    completion: false,
    wrapup: false,
    stallDetection: false,
    onFoldSummary: "notes", // 非函数：直接入口不校验，但绝不当函数调
    diagnostics,
    context: { budgetTokens: 300, keepRounds: 1, strategy: createSlidingWindowStrategy({ keepRounds: 1 }) },
  });
  const records = await store.load(runId);
  assert.ok(String(run?.finalText ?? "").includes("收尾结论"), `非函数值把 run 炸了：${JSON.stringify(run?.termination ?? {})}`);
  assert.ok(records.some((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined),
    "前提：这条路径确实落账了替代物（说明「没炸」不是「没折叠」）");
  assert.deepEqual(diagnostics.events.filter((event) => event.type === "persistence_error"), [],
    "未配置钩子不得发 persistence_error");
});

test("⑤旋钮 context.maxFoldedFactsBytes：夹断生效，且钩子与账本同一份同一上界 (#470-D)", async () => {
  const payloads = [];
  const { factRecords } = await runFolding({
    onFoldSummary: (payload) => { payloads.push(payload); },
    context: { maxFoldedFactsBytes: 120 },
  });
  assert.ok(factRecords.length > 0, "前提：这条路径确实落账了替代物");
  for (const record of factRecords) {
    const fact = record[FOLDED_FACTS_RECORD_FIELD];
    assert.ok(fact.bytes <= 120, `账本那份必须被夹到旋钮值以内，实测 ${fact.bytes}`);
    assert.equal(fact.truncated, true, "超过上界必须如实标 truncated，不许静默截断");
    assert.ok(fact.text !== "", "非法/过小的上界不得把替代物截成空串");
  }
  assert.ok(payloads.length > 0);
  // 三者同源的可测面：宿主在钩子里看到的字节数 = 账本里那一份 = 同一个上界夹出来的。
  assert.deepEqual(payloads.map((payload) => payload.bytes),
    factRecords.map((record) => record[FOLDED_FACTS_RECORD_FIELD].bytes),
    "钩子看到的必须是夹断后的那一份，而不是未夹断的原文");
});

test("⑤旋钮非法值与默认值：非正整数退回 FOLDED_FACTS_MAX_BYTES，不静默变 0 字节 (#470-D)", async () => {
  for (const value of [0, -3, 1.5, "120", null]) {
    const { factRecords } = await runFolding({ context: { maxFoldedFactsBytes: value } });
    assert.ok(factRecords.length > 0, `前提：maxFoldedFactsBytes=${String(value)} 时这条路径仍落账`);
    for (const record of factRecords) {
      const fact = record[FOLDED_FACTS_RECORD_FIELD];
      assert.ok(fact.text !== "", `非法值把替代物截成空串：${String(value)}`);
      assert.ok(fact.bytes <= FOLDED_FACTS_MAX_BYTES,
        `非法值必须退回默认上界 ${FOLDED_FACTS_MAX_BYTES}，实测 ${fact.bytes}（值 ${String(value)}）`);
      assert.equal(fact.truncated, undefined,
        `退回默认后不该标 truncated（值 ${String(value)}）`);
    }
  }
  // 默认（不传旋钮）行为不变：上界 2048，且不因为开了旋钮而多写任何键。
  const { factRecords } = await runFolding();
  for (const record of factRecords) {
    const fact = record[FOLDED_FACTS_RECORD_FIELD];
    assert.ok(fact.bytes <= FOLDED_FACTS_MAX_BYTES);
    assert.ok(!Object.hasOwn(fact, "maxBytesRequested"), "旋钮是输入上界，不是载荷字段");
  }
});

test("④#479：区间/水位线/累计三键在多轮折叠上的口径（水位线取折叠后最大值，累计是各次之和）", async () => {
  const payloads = [];
  const { factRecords } = await runFolding({
    onFoldSummary: (payload) => { payloads.push(payload); },
  });
  assert.ok(payloads.length >= 1, "前提：这条路径必须真的折叠过");
  const roundsOf = (record) => Number(record[FOLDED_FACTS_RECORD_FIELD]?.rounds ?? 0);
  const totalRounds = factRecords.reduce((sum, record) => sum + roundsOf(record), 0);
  const maxTo = Math.max(...factRecords.map((record) => Number(record.foldedRoundRange?.to ?? 0)));

  // 每一条投递都自带三个整数（不必等最后一条才可用）。
  for (const payload of payloads) {
    assert.ok(Number.isSafeInteger(payload.foldedRoundCount) && payload.foldedRoundCount >= 0);
    assert.ok(Number.isSafeInteger(payload.foldedThrough) && payload.foldedThrough >= 0);
    assert.ok(payload.foldedRoundRange === undefined
      || Number.isSafeInteger(payload.foldedRoundRange.from), "带区间就必须带 from");
  }
  // 累计单调不减（run 作用域计数器），最后一条等于账本各次之和。
  const counts = payloads.map((payload) => payload.foldedRoundCount);
  for (let index = 1; index < counts.length; index += 1) {
    assert.ok(counts[index] >= counts[index - 1], `累计轮数不得回退：${counts.join(" → ")}`);
  }
  const last = payloads[payloads.length - 1];
  assert.equal(last.foldedRoundCount, totalRounds, "最后一条的累计 == 账本各次折叠轮数之和");
  // 水位线是**折叠之后**的值：等于账本里出现过的最大 `foldedRoundRange.to`。
  assert.equal(last.foldedThrough, maxTo, "水位线 == 折叠后 run 作用域的最大已折轮号");
  // 与轮记录同源：最后一条的区间逐字段等于最后一次折叠那条记录上的区间。
  const lastRecord = factRecords[factRecords.length - 1];
  if (lastRecord.foldedRoundRange !== undefined) {
    assert.deepEqual(last.foldedRoundRange, lastRecord.foldedRoundRange,
      "区间必须与轮记录那份逐字段相等（同源，不二次推导）");
  }
  // 老宿主兼容：忽略这三个键时，载荷里既有的键一个不少、一个不变。
  const { foldedRoundRange: _r, foldedThrough: _t, foldedRoundCount: _c, round: _round, ...legacy } = last;
  assert.ok(typeof legacy.text === "string" && legacy.text !== "", "既有键 text 仍在");
  assert.ok(typeof legacy.source === "string" && legacy.source !== "", "既有键 source 仍在");
});
