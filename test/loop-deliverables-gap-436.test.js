// issue #436：交付物没落地时，**预算类停机**也该有落地动作（#435 只接上了 `judge_done`）。
//
// 病灶（按 #435 的现场）：`termination.js` 的 accept 分支把「判据没过」压成
// `unverified / deliverables_failed`，但 `deliverablesAllPassed` 在控制流里**没有读者**，
// 于是 `finish(reason)` 一路走到底。#435 给 `judge_done`（最省钱的出口）接了一轮补齐动作；
// 本单把**同一套落地动作**接到 `FINAL_GUARD_EXTENDABLE_REASONS`（= `max_rounds_cap` /
// `continuation_exhausted`）——那两格恰恰是「算出来了但没时间写」最常撞上的停机面。
//
// 本文件钉四件事（三格 + 反向证），每一条都对应工单的一个判据：
//   ① `deliverables_failed = 0` ⇒ **不 nudge**：健康的 run 与「没声明判据」的基线**同形**
//      （请求数一样、无 `final_guard_extend` 事件、metrics 里没有 `deliverable_gap_rounds`）。
//      「不许对健康 run 啰嗦」是这条闸门的一半价值——一条会误触发 nudge 的闸门会被宿主关掉。
//   ② 有失败 ∧ reason ∈ 可扩集合 ⇒ **nudge 且只 nudge 一次**：两条出口（stop 分支的
//      `continuation_exhausted`、出圈收尾的 `max_rounds_cap`）都要咬住；配额**复用**
//      `guardExtensionUsed`（进 run-state，resume 不重领），并与 #386 的补跑桥**共用**那一份。
//   ③ 不可扩的 reason（`stall`）⇒ **如实收尾**，不硬扩（stall 的定义就是连续无进展）。
//   ④ 「落盘优先」这句指令必须真的进**被 nudge 那一轮**的请求里（工单正文的原话：提示词侧
//      已经试过一句泛泛的「确保产物可判定」，没用——那两个 run 根本没得到收尾那一轮）。
//
// 反向证（工单 ④）：把机器证据那一行写成 `=== false`（即「判据全过才补」）⇒ ① 与 ② 两格都红；
// 还原 ⇒ 绿。这条变异常驻在 `test/mutation-samples.md`（M12），`check:mutation` 的 `--run` 会
// 逐条真跑「写进真文件 → 捕获者必须红在该条断言上 → 还原 → 必须绿」。
//
// 口径说明：本单**不改写** `termination.reason`（与 #435 同一条契约边界）。补齐轮之后模型真补上
// 了，run 走它本来那条出口（这里是 `end_turn`）并拿到 `verified`；补不上则与从前逐字一致。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { FINAL_GUARD_EXTENDABLE_REASONS } from "../src/loop/termination.js";
import { decideRoundAction } from "../src/reflection/governor.js";

const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

/** 真写盘：交付物判据读的是磁盘事实，不许读模型的嘴。 */
const diskWriteTool = async (call) => {
  mkdirSync(dirname(call.input.path), { recursive: true });
  writeFileSync(call.input.path, call.input.content ?? "");
  return "ok";
};

/** 扩轮参数显式给全：默认 step 是 `max(8, maxRounds/2)`，不显式给的话「抬到多少」会随 maxRounds 漂。 */
const REFLECTION = Object.freeze({
  enabled: true,
  roundJudge: false,
  extensionStep: 2,
  maxExtensions: 2,
  maxRoundsCap: 8,
});

const gapEvents = (events) => events.filter((event) => (
  event.type === "final_guard_extend" && event.reason === "deliverables_failed"
));

/**
 * 「判据要某个文件的内容**等于** `expected`」——比 `existsSync` 更强：补齐轮要真的把内容换掉才算过。
 * 不存在时返回 false（fail-closed，与出厂判据同一个口径）。
 */
const contentEquals = (path, expected) => ({
  name: "answer.txt",
  check: () => existsSync(path) && readFileSync(path, "utf8") === expected,
});

/**
 * 给每一发主请求打上「当时是第几轮」的标签。
 *
 * 为什么要它：断言「落盘优先这句进的是**被 nudge 那一轮**的请求」时，只证明「某个请求里有这句话」
 * 是不够的（注入之后就一直在历史里，后面每一发都有）。所以把 `round_start` 事件记进 `current.round`
 * 再随请求一起存下来，就能精确断言「第一发含补齐指令的请求属于 nudge 的下一轮」。
 */
function createRoundTaggedProvider(script, current) {
  const inner = createFakeProvider(script);
  const requests = [];
  return {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chat(request) {
      const response = await inner.chat(request);
      requests.push({ round: current.round, request: inner.requests.at(-1) });
      return response;
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

/** 跑一格预算类停机；`script` 收到交付物路径。 */
async function runBudgetCell({
  label,
  script,
  deliverables,
  maxRounds = 1,
  reflection = REFLECTION,
  config = {},
  store,
  runId,
  resume = false,
  guard = async () => ({ action: "accept" }),
}) {
  const dir = await makeTmp(`erix-gap-436-${label}-`);
  const target = join(dir, "answer.txt");
  const events = [];
  const current = { round: 0 };
  const provider = createRoundTaggedProvider(script(target), current);
  const result = await runDirect({
    provider,
    initialUserMessage: "把答案写进 answer.txt",
    maxRounds,
    reflection,
    ...(store === undefined ? {} : { store }),
    ...(runId === undefined ? {} : { runId }),
    ...(resume === true ? { resume: true } : {}),
    config: { run: { completion: false, ...(config.run ?? {}) }, ...(config.guard === undefined ? {} : { guard: config.guard }) },
    executeTool: diskWriteTool,
    capabilities: {
      ...(deliverables === undefined ? {} : { checks: { deliverables: deliverables(target) } }),
      hooks: {
        finalGuard: guard,
        onEvent: (event) => {
          if (event.type === "round_start") current.round = event.round;
          events.push(event);
        },
      },
    },
  });
  return { result, events, provider, target };
}

// ── ① 第一格：`deliverables_failed = 0` ⇒ 不 nudge（健康 run 不许被啰嗦）──────────────────
test("#436 ① deliverables_failed = 0 ⇒ 不 nudge：判据全过的撞墙 run 与「没声明判据」逐字同形", async () => {
  // 基线：同一份脚本、不声明判据。判据全过的那一格必须与它同形（请求数 / 无 gap 事件 / 无计数键）。
  const baseline = await runBudgetCell({
    label: "healthy-baseline",
    script: (target) => [
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      text("强制收尾"),
    ],
  });
  assert.equal(baseline.provider.requests.length, 2, "基线：1 轮 + 1 发强制收尾");
  assert.deepEqual(gapEvents(baseline.events), []);

  const healthy = await runBudgetCell({
    label: "healthy",
    script: (target) => [
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      text("强制收尾"),
    ],
    deliverables: (target) => [contentEquals(target, "42")],
  });

  assert.equal(readFileSync(healthy.target, "utf8"), "42", "前提：判据在终局时是通过的");
  assert.equal(healthy.provider.requests.length, baseline.provider.requests.length,
    "判据全过的 run 多发了一次请求 ⇒ 对健康的 run 啰嗦了（本格的核心判据）");
  assert.deepEqual(gapEvents(healthy.events), [], "没有失败就不许发补齐轮事件");
  assert.equal("deliverable_gap_rounds" in healthy.result.verification.metrics, false,
    "没补跑就不许出现 deliverable_gap_rounds 键（与 #435 同一条加法纪律）");
  assert.equal(healthy.result.termination.reason, baseline.result.termination.reason,
    "终局 reason 也必须与基线一致");
  // 与 #392/#435 的既有语义对齐：这一格 guard 判了 accept（`verified` +1），但出圈收尾照旧降级。
  assert.equal(healthy.result.verification.status, "unverified");
  assert.equal(healthy.result.verification.reason, "non_continuable");
  assert.equal(healthy.result.verification.metrics.deliverables_failed, 0);
});

// ── ② 第二格：有失败 ∧ reason ∈ 可扩集合 ⇒ nudge 且只一次 ────────────────────────────────
test("#436 ② max_rounds_cap + 判据失败 + accept ⇒ 补齐轮；「落盘优先」进的是被 nudge 那一轮的请求", async () => {
  const { result, events, provider, target } = await runBudgetCell({
    label: "cap-gap",
    script: (target) => [
      // 第 1 轮：写了占位符（判据不过），轮预算用完 ⇒ 撞墙
      toolUse("w1", "writeFile", { path: target, content: "TBD" }),
      text("强制收尾"),
      // 被补齐指令叫回来之后，模型真的把内容换成真答案
      toolUse("w2", "writeFile", { path: target, content: "42" }),
      text("已写入 42"),
    ],
    deliverables: (target) => [contentEquals(target, "42")],
  });

  assert.equal(readFileSync(target, "utf8"), "42", "本用例的前提是补齐轮真的写了盘");
  const gap = gapEvents(events);
  assert.equal(gap.length, 1, `预算类停机必须补一次（实测 ${gap.length} 次）`);
  assert.equal(gap[0].stop_reason, "max_rounds_cap", "事件必须点名这次是为哪个停机面补的");
  assert.equal(gap[0].guard_extension, false, "它不是 guard 判 revise 那条桥（两者可区分）");
  assert.equal(gap[0].deliverables_failed, 1);
  assert.equal(gap[0].from_max_rounds, 1);
  assert.equal(gap[0].to_max_rounds, 3, "走的是 `applyGovernorExtension`（step=2 抬到 3）");
  assert.equal(result.verification.status, "verified", `补上之后必须 verified（实测 ${JSON.stringify(result.verification)}）`);
  assert.equal(result.verification.metrics.deliverable_gap_rounds, 1, "补齐轮确实发生过一次");
  assert.equal(result.termination.reason, "end_turn", "补齐轮之后走它本来那条出口，不改写 reason");

  // ④「落盘优先」必须真的进**被 nudge 那一轮**的请求里（不是只在源码里存在）。
  const injected = (request) => request.messages
    .filter((message) => message.meta?.source === "judge-control")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) => block?.text ?? "")
    .join("\n");
  const firstCarrying = provider.requests.findIndex(({ request }) => /【交付物补齐】/u.test(injected(request)));
  assert.notEqual(firstCarrying, -1, "补齐指令根本没进任何请求 —— 模型无从知道要补什么");
  assert.equal(provider.requests[firstCarrying].round, gap[0].round + 1,
    `补齐指令必须出现在**被 nudge 那一轮**（第 ${gap[0].round + 1} 轮）的请求里，`
    + `实测在第 ${provider.requests[firstCarrying].round} 轮`);
  assert.equal(provider.requests.slice(0, firstCarrying).some(({ request }) => /【交付物补齐】/u.test(injected(request))), false,
    "nudge 之前就有请求带着补齐指令 ⇒ 事件与注入点对不上");
  const body = injected(provider.requests[firstCarrying].request);
  assert.match(body, /落盘优先/u, "「落盘优先」这句指令没进被 nudge 那一轮的请求（工单 ② 的硬要求）");
  assert.match(body, /answer\.txt/u, "控制文本必须点名失败的判据，模型才知道该补什么");
  assert.match(body, /写进交付物路径/u);
});

test("#436 ② continuation_exhausted 走同一个闭包（两条出口都接上了，不是只接一条）", async () => {
  // `continuation_exhausted` 是 stop 分支那一条出口（出圈收尾那条只可能是 max_rounds_cap）。
  const { result, events } = await runBudgetCell({
    label: "continuation-gap",
    maxRounds: 5,
    config: { run: { maxTokenContinuations: 0 } },
    script: () => [{ times: 12, content: [{ type: "text", text: "被截断" }], stopReason: "max_tokens" }],
    deliverables: () => [{ name: "never.txt", check: () => false }],
  });
  const gap = gapEvents(events);
  assert.equal(gap.length, 1, `continuation_exhausted 也必须补一次（实测 ${gap.length} 次）`);
  assert.equal(gap[0].stop_reason, "continuation_exhausted");
  assert.equal(result.verification.metrics.deliverable_gap_rounds, 1);
  assert.equal(result.verification.status, "unverified", "补不上 ⇒ 照旧 unverified");
  assert.equal(result.verification.reason, "non_continuable");
  assert.equal(result.termination.reason, "final_guard_unverified");
});

// ── ③ 只 nudge 一次：配额复用 `guardExtensionUsed`（落盘），不是第二个计数器 ─────────────────
test("#436 ③ 只补一次：配额写进 run-state，resume 之后不许重领（复用 guardExtensionUsed）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "deliverables-gap-436-quota";
  const alwaysFail = () => [{ name: "never.txt", check: () => false }];

  const first = await runBudgetCell({
    label: "quota-first",
    store,
    runId,
    script: () => [
      toolUse("w1"), text("强制收尾"), toolUse("w2"), toolUse("w3"), text("又一次强制收尾"),
    ],
    deliverables: alwaysFail,
    guard: async () => ({ action: "accept" }),
  });

  assert.equal(gapEvents(first.events).length, 1, "同一个 run 里第二次撞墙不许再补（配额 1）");
  assert.equal(first.result.verification.metrics.deliverable_gap_rounds, 1);
  assert.equal(first.result.verification.status, "unverified", "补不上 ⇒ 照旧 unverified");
  assert.equal(first.result.verification.reason, "non_continuable");
  assert.equal(first.result.termination.reason, "final_guard_unverified");

  // 配额在**共享的那一位**上（不是新造一个计数器）：resume 侧的权威来源是 run-state。
  const state = await store.loadRunState(runId);
  assert.equal(state?.deterministic?.guardExtension?.used, true,
    `配额必须进 state.json（实测 ${JSON.stringify(state?.deterministic?.guardExtension)}）`);

  const second = await runBudgetCell({
    label: "quota-resume",
    store,
    runId,
    resume: true,
    script: () => [toolUse("w1"), text("强制收尾")],
    deliverables: alwaysFail,
    guard: async () => ({ action: "accept" }),
  });
  assert.equal(gapEvents(second.events).length, 0,
    "resume 之后又领到了一份补齐配额 ⇒「跑 → 崩 → resume」会变成无界成本");
  assert.equal("deliverable_gap_rounds" in second.result.verification.metrics, false);
  assert.equal(second.result.verification.reason, "non_continuable");
});

test("#436 ③ 补跑桥先领了配额 ⇒ 补齐轮不许再领（两个触发面共用同一份一次性配额）", async () => {
  let guardCalls = 0;
  const { result, events } = await runBudgetCell({
    label: "quota-shared",
    config: { guard: { finalGuardExtend: true } },
    script: () => [
      toolUse("w1"), text("强制收尾"), toolUse("w2"), toolUse("w3"), text("又一次强制收尾"),
    ],
    deliverables: () => [{ name: "never.txt", check: () => false }],
    // 第一次撞墙：guard 判 revise（opt-in 的补跑桥领走配额）；第二次撞墙：accept + 判据仍失败。
    guard: async () => {
      guardCalls += 1;
      return guardCalls === 1 ? { action: "revise", message: "还差一步" } : { action: "accept" };
    },
  });

  assert.equal(guardCalls, 2, "两次撞墙 ⇒ guard 被问 2 次");
  assert.equal(result.verification.metrics.guard_extensions, 1, "补跑桥用掉了那一份配额");
  assert.equal(gapEvents(events).length, 0, "配额已被补跑桥领走 ⇒ 补齐轮必须被拒（共用一份，不是两份）");
  assert.equal("deliverable_gap_rounds" in result.verification.metrics, false);
  assert.equal(result.verification.reason, "non_continuable");
});

// ── ④ 第三格：不可扩的 reason ⇒ 如实收尾，不硬扩 ──────────────────────────────────────────
test("#436 ④ stall + 判据失败 + accept ⇒ 如实收尾（stall 不在可扩集合里，不许硬扩）", async () => {
  let guardCalls = 0;
  const { result, events } = await runBudgetCell({
    label: "stall",
    // stall 的判据是「同一签名连续 4 次」+ `STALL_STREAK_LIMIT = 3` ⇒ 第 12 轮才停。
    maxRounds: 20,
    reflection: { ...REFLECTION, maxRoundsCap: 40 },
    script: () => Array.from({ length: 19 }, (_unused, index) => toolUse(`stall-${index}`))
      .concat({ times: 8, ...text("cannot recover") }),
    deliverables: () => [{ name: "never.txt", check: () => false }],
    guard: async () => {
      guardCalls += 1;
      return { action: "accept" };
    },
  });

  assert.equal(result.verification.detail, "stall", "本格的停机原因必须是 stall（否则测的不是这条判据）");
  assert.equal(guardCalls, 1, "stall 上不许补跑（guard 只该被问 1 次）");
  assert.deepEqual(gapEvents(events), [], "stall 上不许发补齐轮事件");
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "non_continuable");
  assert.equal(result.termination.reason, "final_guard_unverified");
  assert.equal("deliverable_gap_rounds" in result.verification.metrics, false);
  // 集合本身一个字没改：补齐轮读的就是这个集合，`stall` 不在里面是**结构**保证而不是巧合。
  assert.deepEqual([...FINAL_GUARD_EXTENDABLE_REASONS], ["max_rounds_cap", "continuation_exhausted"]);
  assert.equal(FINAL_GUARD_EXTENDABLE_REASONS.has("stall"), false);
});

// ── ⑤ 顺带做的那句文案：wrapUp nudge 也要点名「先落盘」 ───────────────────────────────────
test("#436 ⑤ wrapUp nudge 的指令点名「落盘优先」（纯文案，零行为）", () => {
  const action = decideRoundAction({
    rounds: 1,
    remainingMs: 5_000,
    elapsedMs: 60_000,
    hasToolUse: true,
    shouldContinue: true,
    wrapUpNudged: false,
  });
  assert.equal(action.kind, "nudge");
  assert.equal(action.reason, "wrapUp");
  assert.match(action.text, /落盘优先/u);
  assert.match(action.text, /交付物路径/u);
});
