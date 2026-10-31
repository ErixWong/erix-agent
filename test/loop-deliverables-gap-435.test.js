// issue #435：`judge_done` 这条**最省钱的停机路径**不许绕过宿主声明的交付物判据。
//
// 工单正文的核心断言（「`judge_done` 不看交付物状态就停机」）在 #435 的核实评论里被**部分推翻**：
// `FINAL_GUARD_TERMINATION_REASONS` 里本来就有 `judge_done`，`callFinalGuard` 进门先跑
// `runDeliverables`，判据失败会把 `verified` 压成 `unverified / deliverables_failed`。真正成立的
// 缺口是另一件事：**`deliverablesAllPassed` 是一根造好却零读者的信号线**——机器判据只能改
// `verification`，**不能影响控制流**，于是 `finish(reason)` 一路走到底。按 run 口径的实测代价是
// `judge_done` 的 precision 只有 77%（confidence 中位 1.00，很自信地错）。
//
// 本文件钉五件事（前四件是行为，第五件是判据本体）：
//   ① 主格：stub judge 判 done + 判据失败 + guard accept ⇒ **不许一停了之**，注入一条补齐指令再跑
//      一轮；模型真补上之后第二次核验通过 ⇒ `verified`（`deliverable_gap_rounds: 1`）；
//   ② 占位符格：交付物内容是 `TBD`（issue #435 正文点名的真机失败模式：第 1 轮写骨架、再没回去
//      覆盖）⇒ 内容判据不过 ⇒ 同样触发补齐轮；补不上就**不许**以 `verified` 收尾；
//   ③ 一次性配额：补齐轮每 run 最多 1 次（不设限的实测形状是「评审恒 done + 判据恒 false ⇒ 剩余
//      轮次全烧掉」）；
//   ④ 回归锚：未声明 `deliverables` 时逐字不变（不补跑、不多发请求、metrics 键集合不变）；
//      `skip` 裁决那格也不补跑（「没人验收」不该向模型要东西）。
//
// 口径说明（写进交付报告的那一条）：本单**不改写** `termination.reason`——契约明写
// 「the gate changes `verification` only」，而且 #435 的核实评论要求「复用既有机制，别另起一条
// 状态」。所以「不得以 `judge_done` 结束」在这里的落地口径是：**不得以 `verified` 的 `judge_done`
// 结束**，且必须真的花过一轮去补。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";
import {
  PLACEHOLDER_MARKERS,
  createContentDeliverableChecks,
} from "../bin/final-guard.js";

const JUDGE_DONE = {
  done: true,
  confidence: 0.95,
  reason: "任务已完成",
  evidence: "模型说写完了",
  direction: "on_track",
  directionReason: "在推进",
};

const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

/** 真写盘（「文件存在」「内容是什么」都必须是磁盘事实，不许读模型的嘴）。 */
const diskWriteTool = async (call) => {
  mkdirSync(dirname(call.input.path), { recursive: true });
  writeFileSync(call.input.path, call.input.content ?? "");
  return "ok";
};

const judgeScript = (decisions) => createFakeProvider(decisions.map((decision) => ({
  content: [{ type: "text", text: JSON.stringify(decision) }],
})));

/** 跑一格：`guard` 是裁决函数，`deliverables` 未给 = 未声明（回归锚）。 */
async function runCell({
  script,
  judgeDecisions = [JUDGE_DONE],
  deliverables,
  guard = async () => ({ action: "accept" }),
  maxRounds = 6,
}) {
  const events = [];
  const provider = createFakeProvider(script);
  const judge = judgeScript(judgeDecisions);
  const result = await runDirect({
    provider,
    runId: "deliverables-gap-435",
    initialUserMessage: "把答案写进 answer.txt",
    executeTool: diskWriteTool,
    maxRounds,
    // 规位拼写（不是扁平壳）：`completion` / `reflection` 的家是 `config.run.*`，judge provider 是
    // **行为**（函数）⇒ 家是 `capabilities.ports.judgeProvider`。
    config: {
      run: {
        completion: false,
        reflection: {
          enabled: true,
          roundJudge: true,
          // 显式给全：默认 step 是 `max(8, maxRounds/2)`，不显式给的话「抬到多少」会随 maxRounds 漂。
          extensionStep: 2,
          maxExtensions: 2,
          maxRoundsCap: 10,
        },
      },
    },
    capabilities: {
      ...(deliverables === undefined ? {} : { checks: { deliverables } }),
      ports: { judgeProvider: judge },
      hooks: {
        finalGuard: guard,
        onEvent: (event) => events.push(event),
      },
    },
  });
  return { result, events, provider, judge };
}

const gapEvents = (events) => events.filter((event) => (
  event.type === "final_guard_extend" && event.reason === "deliverables_failed"
));

// ── ① 主格：判据失败 + guard accept + judge_done ⇒ 补齐轮，补上之后 verified ────────────
test("#435 ① judge_done + 判据失败 ⇒ 注入补齐指令再跑一轮；模型补上之后 ⇒ verified", async () => {
  const dir = await makeTmp("erix-gap-435-main-");
  const target = join(dir, "answer.txt");
  const { result, events, provider } = await runCell({
    script: [
      text("已完成，答案写在 answer.txt"),
      // 被补齐指令叫回来之后，模型真的写盘
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      text("已写入 42"),
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
    deliverables: [{ name: "answer.txt", check: () => existsSync(target) }],
  });

  assert.equal(existsSync(target), true, "本用例的前提是**最终**真写下去了");
  assert.equal(result.termination.reason, "judge_done", "终局 reason 不被改写（契约边界）");
  assert.equal(result.verification.status, "verified",
    `补上之后必须拿到 verified（实测 ${JSON.stringify(result.verification)}）`);
  assert.equal(result.verification.metrics.deliverables_checked, 2, "两次 guard 调用 ⇒ 核了两遍");
  assert.equal(result.verification.metrics.deliverables_failed, 1, "只有第一次失败");
  assert.equal(result.verification.metrics.deliverable_gap_rounds, 1, "补齐轮确实发生过一次");
  assert.equal(provider.requests.length, 3, "1 发撒谎 + 1 发补写 + 1 发收尾；不许多花");
  const gap = gapEvents(events);
  assert.equal(gap.length, 1, "事件里必须看得见「这次多给一轮是因为交付物没交付」");
  assert.equal(gap[0].guard_extension, false, "它不是 guard 判 revise 那条桥（两者可区分）");
  assert.equal(gap[0].deliverables_failed, 1);
  // 注入的控制文本必须点名判据（模型要知道该补什么），并且是引擎控制文本（judge 不会读回）
  const injected = provider.requests[1].messages.at(-1);
  assert.deepEqual(injected.meta, { source: "judge-control" });
  const body = injected.content.map((block) => block.text).join("");
  assert.match(body, /【交付物补齐】/u);
  assert.match(body, /answer\.txt/u);
});

// ── ② 占位符格：内容判据（`TBD` 骨架）────────────────────────────────────────────────────
test("#435 ② 交付物内容只有 TBD ⇒ 内容判据拦下并触发补齐轮；补不上不许 verified", async () => {
  const dir = await makeTmp("erix-gap-435-placeholder-");
  const target = join(dir, "answer.txt");
  const criteria = createContentDeliverableChecks();

  // ②-a 真机形状：第 1 轮写骨架 `TBD`，之后**再没回去覆盖** ⇒ 终局不得是 verified
  const stuck = await runCell({
    script: [
      toolUse("w1", "writeFile", { path: target, content: "TBD\n" }),
      text("写好了"),
      text("确认写好了"),
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
    deliverables: criteria,
  });
  assert.equal(readFileSync(target, "utf8").trim(), "TBD", "前提：盘上确实只有占位符");
  assert.equal(stuck.result.verification.status, "unverified",
    `占位符不许被当成已交付（实测 ${JSON.stringify(stuck.result.verification)}）`);
  assert.equal(stuck.result.verification.reason, "deliverables_failed");
  assert.equal(stuck.result.verification.metrics.deliverable_gap_rounds, 1, "补齐轮发生过（给过机会）");
  assert.equal(gapEvents(stuck.events).length, 1);

  // ②-b 同一份判据 + 模型把 TBD 覆盖成真内容 ⇒ 第二次核验通过
  const dir2 = await makeTmp("erix-gap-435-placeholder-fixed-");
  const target2 = join(dir2, "answer.txt");
  const fixed = await runCell({
    script: [
      toolUse("w1", "writeFile", { path: target2, content: "TBD" }),
      text("写好了"),
      toolUse("w2", "writeFile", { path: target2, content: "42" }),
      text("覆盖成 42 了"),
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
    deliverables: createContentDeliverableChecks(),
  });
  assert.equal(readFileSync(target2, "utf8"), "42");
  assert.equal(fixed.result.verification.status, "verified",
    `覆盖之后必须 verified（实测 ${JSON.stringify(fixed.result.verification)}）`);
  assert.equal(fixed.result.verification.metrics.deliverables_failed, 1, "只有 TBD 那一次失败");
});

// ── ③ 一次性配额 ───────────────────────────────────────────────────────────────────────
test("#435 ③ 补齐轮每 run 最多 1 次：评审恒 done + 判据恒失败 ⇒ 只补一次就收口", async () => {
  const dir = await makeTmp("erix-gap-435-quota-");
  const target = join(dir, "never.txt");
  const { result, events, provider } = await runCell({
    script: [text("完成了"), text("还是没写"), text("仍然没写")],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE, JUDGE_DONE],
    deliverables: [{ name: "never.txt", check: () => existsSync(target) }],
  });
  assert.equal(existsSync(target), false);
  assert.equal(provider.requests.length, 2, "只多花一轮（配额 1）——不是把剩余轮次全烧掉");
  assert.equal(gapEvents(events).length, 1);
  assert.equal(result.verification.metrics.deliverable_gap_rounds, 1);
  assert.equal(result.termination.reason, "judge_done");
  assert.equal(result.verification.status, "unverified", "配额用完仍失败 ⇒ 照旧 unverified");
  assert.equal(result.verification.reason, "deliverables_failed");
});

// ── ④ 回归锚：未声明判据 / skip 裁决 ────────────────────────────────────────────────────
test("#435 ④ 未声明 deliverables ⇒ 逐字不变（不补跑、不多发、metrics 键集合不变）", async () => {
  const { result, events, provider } = await runCell({
    script: [text("完成了"), text("不该被消费")],
  });
  assert.equal(result.termination.reason, "judge_done");
  assert.equal(provider.requests.length, 1, "没有判据就没有补齐轮");
  assert.equal(gapEvents(events).length, 0);
  assert.deepEqual(result.verification.metrics, {
    verified: 1,
    skipped: 0,
    revised: 0,
    unverified: 0,
    guard_error: 0,
  }, "未声明判据时 metrics 的键集合与今天逐字一致（没有 deliverable_gap_rounds）");
});

test("#435 ④ skip 裁决 + 判据失败 ⇒ 不补跑（「没人验收」不该向模型要东西）", async () => {
  const dir = await makeTmp("erix-gap-435-skip-");
  const target = join(dir, "never.txt");
  const { result, events, provider } = await runCell({
    script: [text("完成了"), text("不该被消费")],
    deliverables: [{ name: "never.txt", check: () => existsSync(target) }],
    guard: async () => ({ action: "skip", reason: "no_capture_evidence" }),
  });
  assert.equal(provider.requests.length, 1);
  assert.equal(gapEvents(events).length, 0);
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "deliverables_failed", "#392 的既有语义一字不动");
});

// ── ⑤ 判据本体：非空且整份不等于占位符 ─────────────────────────────────────────────────
test("#435 ⑤ files_written_content_not_placeholder：占位符/空文件/缺文件不过，含但不等于必须过", () => {
  const [criterion] = createContentDeliverableChecks();
  assert.equal(criterion.name, "files_written_content_not_placeholder");
  const withBody = (body) => createContentDeliverableChecks({
    exists: () => true,
    readFile: () => body,
  })[0].check({ fileWrites: [{ path: "/tmp/x" }] });

  for (const body of ["TBD", "  tbd\n", "## TODO", "`FIXME`", "<placeholder>", "Todo。"]) {
    const outcome = withBody(body);
    assert.equal(outcome.ok, false, `占位符 ${JSON.stringify(body)} 必须判不过`);
    assert.match(outcome.detail, /内容只有占位符/u);
  }
  // 空文件 / 只有空白 ⇒ 不过（「非空」这一半）
  for (const body of ["", "   \n\t"]) {
    const outcome = withBody(body);
    assert.equal(outcome.ok, false, "空文件必须判不过");
    assert.match(outcome.detail, /空文件/u);
  }
  // ⚠ 反向锚：**含但不等于**占位符必须通过。判据一宽就会误杀正常内容，宿主会直接关掉它。
  for (const body of ["TBD: 明天补数据", "TODO 之后跑一遍 npm test", "42", "- TBD 是占位符的例子"]) {
    assert.equal(withBody(body), true, `${JSON.stringify(body)} 是正常内容，不许误杀`);
  }
  // 缺文件 / 读不出来 ⇒ fail-closed（不许当通过）
  const missing = createContentDeliverableChecks({ exists: () => false })[0]
    .check({ fileWrites: [{ path: "/tmp/nope" }] });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /不在盘上/u);
  const unreadable = createContentDeliverableChecks({
    exists: () => true,
    readFile: () => { throw new Error("EISDIR"); },
  })[0].check({ fileWrites: [{ path: "/tmp/dir" }] });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.detail, /读不出来/u);
  // 模型一次写工具都没调 ⇒ 空集合恒真（与裸 `--require-deliverable` 同一个「没撒谎」语义）
  assert.equal(createContentDeliverableChecks()[0].check({}), true);
  assert.deepEqual([...PLACEHOLDER_MARKERS], ["tbd", "todo", "fixme", "<placeholder>"]);
});

// ── ⑥ CLI 面：`--require-deliverable-content` 的解析与前置校验 ────────────────────────────
test("#435 ⑥ CLI 旗标：与 --final-guard 同用才放行，重复报错，且不吞掉 --require-deliverable 的路径", async () => {
  const { parseChatArgs } = await import("../bin/cli.js");
  const ok = parseChatArgs(["hi", "--final-guard", "--require-deliverable-content"]);
  assert.equal(ok.requireDeliverableContent, true);
  assert.equal(ok.finalGuard, true);

  // 没有 guard ⇒ usage error（与 --require-deliverable 同一条「不许静默空转」的口径）
  assert.throws(
    () => parseChatArgs(["hi", "--require-deliverable-content"]),
    /必须与 --final-guard 同用/u,
  );
  // 重复出现 ⇒ usage error
  assert.throws(
    () => parseChatArgs(["hi", "--final-guard", "--require-deliverable-content", "--require-deliverable-content"]),
    /参数重复：--require-deliverable-content/u,
  );
  // ⚠ 前缀撞车：`--require-deliverable-content` 也满足 `startsWith("--require-deliverable")`，
  // 排在后面会被当成「带值写法」而把 `-content` 当路径 ⇒ 三种写法混用必须各就各位。
  const combined = parseChatArgs([
    "hi", "--final-guard", "--require-deliverable", "--require-deliverable-content",
    "--require-deliverable", "a.md",
  ]);
  assert.equal(combined.requireDeliverable, true);
  assert.equal(combined.requireDeliverableContent, true);
  assert.deepEqual(combined.deliverablePaths, ["a.md"]);
});
