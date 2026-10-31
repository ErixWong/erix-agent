// issue #392：机器判据在**任何** guard 裁决下都算数。
//
// 背景（真上游现场）：`erix chat --final-guard --require-deliverable` 且交付物**真的在盘上**
// ⇒ 退出码 4。根因是机器闸门只挂在 `accept` 那一条分支上：guard 一 `skip`，判据全通过换不来
// `verified`（`verification` 仍是 `skipped`），判据失败也不产出 `unverified`（状态说「没验」，
// 而机器其实说了「没过」）。本机 9 条有记录的真 run 里 `verification` 全是 `skipped`。
//
// 这一组用例钉的就是 `test/loop-deliverables.test.js` 头注释里那张四格表的**扩表**（七格）：
//
//   | guard 裁决 | 判据 | 目标 verification |
//   |---|---|---|
//   | accept | 全通过 | verified |
//   | accept | 有失败 | unverified / deliverables_failed |
//   | skip   | 有失败 | unverified / deliverables_failed |
//   | skip   | 全通过 | verified + reason: "machine_only" |
//   | error  | 有失败 | unverified / deliverables_failed |
//   | error  | 全通过 | error（**刻意保留**：guard 崩了是基础设施故障） |
//   | 未声明 | 任意 | 与今天逐字一致（deepEqual 回归锚） |
//
// 三处刻意的写法，改之前请先读完：
//   1. 每一格都用**同一个**天真 guard 家族（accept / skip / 抛错只差这一处），差别只在判据是否
//      声明、以及判据看不看磁盘 ⇒「机器证据压过 guard 意见」是唯一变量。
//   2. 判据一律读**磁盘事实**（`fs.existsSync`），不读 payload 里的自报文本——否则测的是模型嘴。
//   3. `skip` + 全通过那一格断言的是 `reason === "machine_only"`（**可区分**于 guard 验收），
//      `skip` + 失败那一格断言的是 `reason` **不是** skip 串——这两条正面挡住最容易写错的方向。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const wrapup = (object) => ({
  content: [{ type: "text", text: JSON.stringify(object) }],
  stopReason: "end_turn",
});

/** 真写盘：`executeTool` 把 `writeFile` 的 input 落到磁盘（否则「文件存在」不是磁盘事实）。 */
const diskWriteTool = async (call) => {
  mkdirSync(dirname(call.input.path), { recursive: true });
  writeFileSync(call.input.path, call.input.content ?? "");
  return "ok";
};

// 三个天真 guard：它们与「验收」无关，只制造三种裁决。
const guardAccept = async () => ({ action: "accept" });
const guardSkip = async () => ({ action: "skip", reason: "no_capture_evidence" });
const guardThrow = async () => { throw new Error("guard crashed"); };

const GUARD_ERROR_REASON = "error";

/**
 * 跑一格：`mode` 是判据的三种状态（`undefined` = 未声明 / `"pass"` / `"fail"`）。
 * 判据一律以「磁盘上有没有 answer.txt」为准，`mode === "pass"` 时真把文件写下去（不靠嘴）。
 */
async function runCell({ mode, guard }) {
  const dir = await makeTmp("erix-outrank-");
  const target = join(dir, "answer.txt");
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider([
      ...(mode === "pass" ? [toolUse("w1", "writeFile", { path: target, content: "42" })] : []),
      wrapup({ done: true, summary: "s", output: "o" }),
    ]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 4,
    executeTool: diskWriteTool,
    capabilities: {
      // 判据是宿主**行为**（`check` 是函数）⇒ 规位是 `capabilities.checks.deliverables`；两个组必须
      // 落在**同一个** `capabilities` 容器里——并列写两个 `capabilities` 键会静默后者胜（S7b 实测）。
      ...(mode === undefined
        ? {}
        : { checks: { deliverables: [{ name: "answer-file", check: () => existsSync(target) }] } }),
      hooks: {
        finalGuard: guard,
        onEvent: (event) => events.push(event),
      },
    },
  });
  return {
    result,
    target,
    guardEvents: events.filter((event) => event.type === "final_guard"),
  };
}

const FIVE_COUNTERS = { verified: 0, skipped: 0, revised: 0, unverified: 0, guard_error: 0 };

// ── 七格真值表：逐格 deepEqual（`verification` 整包，含 metrics 键集合）────────────────────
test("#392 R2-1 七格真值表逐格：verification（含 metrics 的**键集合**）逐格相等", async () => {
  const cells = [
    {
      label: "accept + 全通过",
      mode: "pass",
      guard: guardAccept,
      expected: {
        status: "verified",
        metrics: { ...FIVE_COUNTERS, verified: 1, deliverables_checked: 1, deliverables_failed: 0 },
      },
    },
    {
      label: "accept + 有失败",
      mode: "fail",
      guard: guardAccept,
      expected: {
        status: "unverified",
        reason: "deliverables_failed",
        metrics: { ...FIVE_COUNTERS, unverified: 1, deliverables_checked: 1, deliverables_failed: 1 },
      },
    },
    {
      label: "skip + 有失败",
      mode: "fail",
      guard: guardSkip,
      expected: {
        status: "unverified",
        reason: "deliverables_failed",
        // issue #648：非 accept 裁决留下机器可读结论（判定 + 原因类别 + 点名到判据的失败清单）。
        guardVerdict: {
          action: "skip",
          reason: "no_capture_evidence",
          attempt: 1,
          failures: [{ name: "answer-file" }],
        },
        metrics: {
          ...FIVE_COUNTERS,
          skipped: 1,
          unverified: 1,
          deliverables_checked: 1,
          deliverables_failed: 1,
        },
      },
    },
    {
      label: "skip + 全通过",
      mode: "pass",
      guard: guardSkip,
      expected: {
        status: "verified",
        reason: "machine_only",
        // issue #648：guard 的 skip 本身仍是一条非 accept 裁决（判据全通过只改变终局 status）。
        guardVerdict: { action: "skip", reason: "no_capture_evidence", attempt: 1 },
        metrics: {
          ...FIVE_COUNTERS,
          skipped: 1,
          deliverables_checked: 1,
          deliverables_failed: 0,
          deliverables_machine_only: 1,
        },
      },
    },
    {
      label: "error + 有失败",
      mode: "fail",
      guard: guardThrow,
      expected: {
        status: "unverified",
        reason: "deliverables_failed",
        guardVerdict: {
          action: "error",
          reason: "error",
          attempt: 1,
          message: "guard crashed",
          failures: [{ name: "answer-file" }],
        },
        metrics: {
          ...FIVE_COUNTERS,
          unverified: 1,
          guard_error: 1,
          deliverables_checked: 1,
          deliverables_failed: 1,
        },
      },
    },
    {
      label: "error + 全通过（刻意保留 error）",
      mode: "pass",
      guard: guardThrow,
      expected: {
        status: "error",
        reason: GUARD_ERROR_REASON,
        detail: "guard crashed",
        guardVerdict: {
          action: "error",
          reason: GUARD_ERROR_REASON,
          attempt: 1,
          message: "guard crashed",
        },
        metrics: {
          ...FIVE_COUNTERS,
          unverified: 1,
          guard_error: 1,
          deliverables_checked: 1,
          deliverables_failed: 0,
        },
      },
    },
    {
      label: "未声明 + skip（回归锚：逐字等于今天）",
      mode: undefined,
      guard: guardSkip,
      expected: {
        status: "skipped",
        reason: "no_capture_evidence",
        guardVerdict: { action: "skip", reason: "no_capture_evidence", attempt: 1 },
        metrics: { ...FIVE_COUNTERS, skipped: 1 },
      },
    },
    {
      label: "未声明 + error（回归锚：逐字等于今天）",
      mode: undefined,
      guard: guardThrow,
      expected: {
        status: "error",
        reason: GUARD_ERROR_REASON,
        detail: "guard crashed",
        guardVerdict: {
          action: "error",
          reason: GUARD_ERROR_REASON,
          attempt: 1,
          message: "guard crashed",
        },
        metrics: { ...FIVE_COUNTERS, unverified: 1, guard_error: 1 },
      },
    },
  ];

  for (const cell of cells) {
    const { result } = await runCell({ mode: cell.mode, guard: cell.guard });
    assert.deepEqual(result.verification, cell.expected, `「${cell.label}」这一格的 verification 与真值表不符`);
    // 每一格都**不新增** termination.reason：机器闸门只改 verification。
    assert.equal(result.termination.reason, "end_turn", `「${cell.label}」改写了 termination.reason`);
  }
});

// ── skip + 全通过：machine_only 是「引擎用宿主判据验收」，不是 guard 验收 ──────────────────
test("#392 R2-2 skip + 全通过 ⇒ verified / reason:\"machine_only\" + metrics.deliverables_machine_only===1", async () => {
  const { result, target, guardEvents } = await runCell({ mode: "pass", guard: guardSkip });

  assert.equal(existsSync(target), true, "本用例的前提是交付物**真的在盘上**（判据必须是磁盘事实）");
  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.reason, "machine_only",
    "machine_only 必须可区分于 guard 验收（缺了 reason，宿主分不清这条 verified 是谁给的）");
  assert.equal(result.verification.metrics.deliverables_machine_only, 1,
    "deliverables_machine_only 是「这条 verified 不是 guard 给的」的可计数凭据");
  assert.equal(result.verification.metrics.verified, 0,
    "guard 没有 accept，`verified` 计数（数的是 guard 裁决）不该涨");
  assert.equal(result.verification.metrics.skipped, 1, "guard 确实 skip 了，`skipped` 计数照旧累加");

  // 事件：既有字段一字不动（action/reason 仍是 skip 那一条），只多一个 machine_only。
  assert.deepEqual(guardEvents, [{
    type: "final_guard",
    round: 2,
    action: "skip",
    reason: "no_capture_evidence",
    deliverables_failed: 0,
    machine_only: true,
  }], `skip + 全通过的事件形状不符（实测 ${JSON.stringify(guardEvents)}）`);
});

// ── skip + 有失败：**最容易写错的一格**（正面挡住 skip 串）────────────────────────────────
test("#392 R2-3 skip + 有失败 ⇒ unverified/deliverables_failed，且 reason **不是** skip reason", async () => {
  const { result, target, guardEvents } = await runCell({ mode: "fail", guard: guardSkip });

  assert.equal(existsSync(target), false, "本用例的前提是交付物**不存在**（判据必须真失败）");
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "deliverables_failed");
  // 这一条是「正面挡」而不是「间接推」：有人把 skip 分支原样保留（只是把 status 改掉）时，
  // `reason` 会留着 `no_capture_evidence`，上面那条 equal 已经红；这里再把 skip 串逐字挡住。
  assert.notEqual(result.verification.reason, "no_capture_evidence");
  assert.notEqual(result.verification.reason, "no_extractable_candidates");
  assert.equal(result.verification.metrics.deliverables_failed, 1);
  // 机器说「没过」时不许留下「skipped」的任何痕迹在 status 上（那是 #392 的现场）。
  assert.notEqual(result.verification.status, "skipped");
  assert.deepEqual(guardEvents, [{
    type: "final_guard",
    round: 1,
    action: "skip",
    reason: "no_capture_evidence",
    deliverables_failed: 1,
  }]);
});

// ── error + 全通过：刻意保留 error（那条取舍要被钉住，不是靠注释自觉）────────────────────
test("#392 R2-4 error + 全通过 ⇒ 仍是 error（刻意不升级成 machine_only），且不带 machine_only 键", async () => {
  const { result } = await runCell({ mode: "pass", guard: guardThrow });

  assert.equal(result.verification.status, "error",
    "guard 崩了/超时是基础设施故障，不许用 machine_only 盖掉（这条取舍是契约里写明的）");
  assert.equal(result.verification.reason, "error");
  assert.equal(result.verification.detail, "guard crashed", "错误 detail 不许被吞（宿主靠它定位故障）");
  assert.equal("deliverables_machine_only" in result.verification.metrics, false,
    "machine_only 的计数漏进了 error 格");
  assert.equal(result.verification.metrics.guard_error, 1);
});

// ── metrics 键集合：三种情况各自**恰好**是哪些键 ────────────────────────────────────────
test("#392 R2-5 metrics 键集合：未声明 / accept / skip 三格各自恰好是哪些键（machine_only 不许漏进别的格）", async () => {
  const keysOf = (metrics) => Object.keys(metrics).sort();
  const BASE = ["guard_error", "revised", "skipped", "unverified", "verified"];
  const DECLARED = [...BASE, "deliverables_checked", "deliverables_failed"].sort();

  const undeclared = await runCell({ mode: undefined, guard: guardAccept });
  assert.deepEqual(keysOf(undeclared.result.verification.metrics), BASE,
    "未声明 deliverables ⇒ metrics 必须与今天逐字一致（多一个键就是回归）");

  const accepted = await runCell({ mode: "pass", guard: guardAccept });
  assert.deepEqual(keysOf(accepted.result.verification.metrics), DECLARED,
    "accept 格只该多出 deliverables_checked / deliverables_failed");

  const acceptedFail = await runCell({ mode: "fail", guard: guardAccept });
  assert.deepEqual(keysOf(acceptedFail.result.verification.metrics), DECLARED,
    "accept + 失败格同样不该出现 deliverables_machine_only");

  const skipped = await runCell({ mode: "pass", guard: guardSkip });
  assert.deepEqual(keysOf(skipped.result.verification.metrics), [...DECLARED, "deliverables_machine_only"].sort(),
    "machine_only 那一格必须**恰好**多出这一个键");

  const skippedFail = await runCell({ mode: "fail", guard: guardSkip });
  assert.deepEqual(keysOf(skippedFail.result.verification.metrics), DECLARED,
    "skip + 失败格不该出现 deliverables_machine_only（机器说没过，不是 machine-only 通过）");

  const errored = await runCell({ mode: "pass", guard: guardThrow });
  assert.deepEqual(keysOf(errored.result.verification.metrics), DECLARED,
    "error 格不该出现 deliverables_machine_only");
});

// ── 未声明 = 纯加法：payload 无相关键、事件形状逐字不变 ───────────────────────────────────
test("#392 R2-6 未声明 deliverables + skip：payload 无判据键、事件形状与今天逐字一致（纯加法）", async () => {
  const dir = await makeTmp("erix-outrank-additive-");
  let payload;
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider([wrapup({ done: true, summary: "s", output: "o" })]),
    initialUserMessage: "x",
    cwd: dir,
    maxRounds: 2,
    executeTool: diskWriteTool,
    capabilities: {
      hooks: {
        finalGuard: async (value) => {
          payload = value;
          return { action: "skip", reason: "no_capture_evidence" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  assert.equal("deliverables" in payload, false, "未声明判据却往 payload 里塞了 deliverables 键");
  assert.equal("deliverablesAllPassed" in payload, false);
  assert.deepEqual(events.filter((event) => event.type === "final_guard"),
    [{ type: "final_guard", round: 1, action: "skip", reason: "no_capture_evidence" }],
    "未声明时事件形状必须逐字不变（新字段只在声明判据时出现）");
  assert.deepEqual(result.verification, {
    status: "skipped",
    reason: "no_capture_evidence",
    guardVerdict: { action: "skip", reason: "no_capture_evidence", attempt: 1 },
    metrics: { ...FIVE_COUNTERS, skipped: 1 },
  });
});

// ── 与 accept 格的分工：机器证据「通过」不再需要 guard 点头，但 guard 的 accept 仍是主路 ────
test("#392 R2-7 同一份磁盘事实：guard accept ⇒ verified（无 reason）/ guard skip ⇒ verified:machine_only（有 reason）", async () => {
  const accepted = await runCell({ mode: "pass", guard: guardAccept });
  const skipped = await runCell({ mode: "pass", guard: guardSkip });

  assert.equal(accepted.result.verification.status, "verified");
  assert.equal("reason" in accepted.result.verification, false,
    "guard 验收那格不带 reason（既有形状不许被 machine_only 污染）");
  assert.equal(skipped.result.verification.status, "verified");
  assert.equal(skipped.result.verification.reason, "machine_only");
  // 两格都 verified，但**可区分**：宿主据此知道自己该收紧判据还是该信任 guard。
  assert.notDeepEqual(accepted.result.verification, skipped.result.verification);
});
