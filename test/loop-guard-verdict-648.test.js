// issue #648：guard 的非 accept 判定必须在**终局 `verification`** 里留下机器可读的结论。
//
// 病灶（本单要杀的那一格）：`revise` 从前只涨 `metrics.revised` 并发一条 `final_guard` 事件，
// 终局 `verification` 里一个字都没有。宿主因此只看得见「有没有被重写过」这个计数，分不清
//
//   · guard 判过 revise、但重试/预算先耗尽（降级成 `max_retries` / `non_continuable`），与
//   · guard 从来没跑过（`skipped / no_final_guard`）。
//
// 这一组用例钉三件事，缺一条就不算「留下机器证据」：
//   1. **判定**（`action`）与**原因类别**（`reason`）都在 `verification.guardVerdict` 上；
//   2. **点名到具体基点/判据**：`message` 是 guard 自己写的修订文本，`failures` 是宿主声明的
//      交付物判据里没过的那几条（`{name, detail?}`，与 payload 的 `deliverables` 同形）；
//   3. **不可静默**：`metrics.revised > 0` 而 `guardVerdict` 不在场/不是 revise ⇒ 断言红并点名
//      `verification.guardVerdict`（`assertReviseEvidence`，本文件的闸门；把源里的写入点删掉，
//      下面每一条 revise 用例都会红）。
//
// 边界：本单只加**载荷字段**，不改任何裁决语义、重试上限或 exit code。accept / 从未调用 guard
// 的 run 一个字节都不多（最后两条回归锚钉住）。
import assert from "node:assert/strict";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const toolUse = (id) => ({
  content: [{ type: "tool_use", id, name: "noop", input: {} }],
  stopReason: "tool_use",
});

/**
 * 本单的**闸门**（反向证 ②）：guard 判过 revise，终局载荷就必须查得到原因。
 *
 * 它不替代各用例的逐字段断言，而是给「字段被静默抹掉」这一种回归一个**点名到格子**的红：
 * 断言文案里写的是 `verification.guardVerdict`，不是「某个字段」。
 */
function assertReviseEvidence(result, label) {
  const revised = result.verification?.metrics?.revised ?? 0;
  if (revised === 0) return;
  const verdict = result.verification?.guardVerdict;
  assert.ok(
    verdict !== undefined && verdict.action === "revise",
    `${label}：guard 判过 revise（metrics.revised=${revised}），但终局 verification.guardVerdict `
    + "缺失或 action 不是 revise —— revise 的机器证据被抹掉了（#648）",
  );
  assert.equal(typeof verdict.reason, "string", `${label}：verification.guardVerdict.reason 必须是原因类别字符串`);
  assert.ok(verdict.reason.length > 0, `${label}：verification.guardVerdict.reason 不许为空串`);
  assert.ok(
    (typeof verdict.message === "string" && verdict.message.length > 0)
    || (Array.isArray(verdict.failures) && verdict.failures.length > 0),
    `${label}：verification.guardVerdict 必须点名具体原因（message 或 failures 至少一项）`,
  );
}

// ── ① revise 用尽重试：终局是降级 reason，但 revise 的判定/文本仍在 ──────────────────────────
test("#648 revise 重试用尽 ⇒ verification.guardVerdict 带 action/reason/attempt/message", async () => {
  const result = await runDirect({
    provider: createFakeProvider([text("draft-1"), text("draft-2"), text("draft-3")]),
    seed: "写点东西",
    executeTool: async () => "unused",
    config: { guard: { finalGuardMaxRetries: 2 }, run: { completion: false } },
    capabilities: {
      hooks: {
        finalGuard: async () => ({ action: "revise", message: "缺少 ## 基点，请补齐" }),
      },
    },
  });

  assert.deepEqual(result.termination, { reason: "final_guard_unverified" });
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "max_retries");
  // 闸门先跑：字段被抹掉时红的是**点名格子**的断言，而不是一条抽象的 deepEqual 差异。
  assertReviseEvidence(result, "重试用尽");
  assert.deepEqual(result.verification.guardVerdict, {
    action: "revise",
    reason: "unverified",
    attempt: 3,
    message: "缺少 ## 基点，请补齐",
  });
});

// ── ② 本单的现场：revise + 预算类停机（没有收尾预算）⇒ 仍点名 revise 的原因 ──────────────────
test("#648 revise + max_rounds_cap（无补跑 opt-in）⇒ non_continuable 之外仍留下 revise 原因", async () => {
  const result = await runDirect({
    provider: createFakeProvider([toolUse("cap"), text("forced final")]),
    seed: "写点东西",
    config: { run: { maxRounds: 1 } },
    executeTool: async () => "ok",
    capabilities: {
      hooks: {
        finalGuard: async () => ({ action: "revise", message: "预算用完了，但结论还没落盘" }),
      },
    },
  });

  assert.deepEqual(result.termination, { reason: "final_guard_unverified", forcedFinal: true });
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "non_continuable");
  assert.deepEqual(result.verification.guardVerdict, {
    action: "revise",
    reason: "unverified",
    attempt: 1,
    message: "预算用完了，但结论还没落盘",
  });
  assertReviseEvidence(result, "预算类停机");
});

// ── ③ revise 之后 accept：终局 verified，但「曾经 revise 过」这条证据不被覆盖 ─────────────────
test("#648 revise → accept ⇒ verified，guardVerdict 仍保留那次 revise（不被终局状态抹掉）", async () => {
  let calls = 0;
  const result = await runDirect({
    provider: createFakeProvider([text("draft"), text("fixed")]),
    seed: "写点东西",
    executeTool: async () => "unused",
    capabilities: {
      hooks: {
        finalGuard: async () => {
          calls += 1;
          return calls === 1
            ? { action: "revise", message: "请先核实原始值" }
            : { action: "accept" };
        },
      },
    },
  });

  assert.equal(result.verification.status, "verified");
  assert.equal(result.verification.guardVerdict.action, "revise");
  assert.equal(result.verification.guardVerdict.attempt, 1);
  assert.equal(result.verification.guardVerdict.message, "请先核实原始值");
  assertReviseEvidence(result, "revise→accept");
});

// ── ④ 点名到具体判据：宿主声明的 deliverables 失败清单必须随 revise 一起带出 ──────────────────
test("#648 revise + 判据失败 ⇒ guardVerdict.failures 点名判据（name + detail）", async () => {
  const result = await runDirect({
    provider: createFakeProvider([text("draft")]),
    seed: "写点东西",
    executeTool: async () => "unused",
    config: { guard: { finalGuardMaxRetries: 0 }, run: { completion: false } },
    capabilities: {
      checks: {
        deliverables: [
          { name: "answer.txt", check: () => ({ ok: false, detail: "missing" }) },
          { name: "notes.md", check: () => true },
        ],
      },
      hooks: {
        finalGuard: async () => ({ action: "revise", message: "交付物还没落盘" }),
      },
    },
  });

  assert.equal(result.verification.reason, "max_retries");
  assert.deepEqual(result.verification.guardVerdict.failures, [
    { name: "answer.txt", detail: "missing" },
  ]);
  assertReviseEvidence(result, "判据失败");
});

// ── ⑤ skip / error 也是非 accept：判定与原因类别同样留在载荷里 ────────────────────────────────
test("#648 skip / error 两格同样留下 action + reason（error 还带 message）", async () => {
  const skipped = await runDirect({
    provider: createFakeProvider([text("draft")]),
    seed: "写点东西",
    executeTool: async () => "unused",
    config: { run: { completion: false } },
    capabilities: {
      hooks: { finalGuard: async () => ({ action: "skip", reason: "no_capture_evidence" }) },
    },
  });
  assert.deepEqual(skipped.verification.guardVerdict, {
    action: "skip",
    reason: "no_capture_evidence",
    attempt: 1,
  });

  const errored = await runDirect({
    provider: createFakeProvider([text("draft")]),
    seed: "写点东西",
    executeTool: async () => "unused",
    config: { run: { completion: false } },
    capabilities: {
      hooks: { finalGuard: async () => { throw new Error("guard crashed"); } },
    },
  });
  assert.deepEqual(errored.verification.guardVerdict, {
    action: "error",
    reason: "error",
    attempt: 1,
    message: "guard crashed",
  });
});

// ── ⑥ 回归锚：accept / 从未调用 guard 的 run 一个字节都不多 ──────────────────────────────────
test("#648 accept 与「没配 guard」两格不带 guardVerdict（纯加法）", async () => {
  const accepted = await runDirect({
    provider: createFakeProvider([text("done")]),
    seed: "写点东西",
    executeTool: async () => "unused",
    capabilities: { hooks: { finalGuard: async () => ({ action: "accept" }) } },
  });
  assert.equal("guardVerdict" in accepted.verification, false);

  const disabled = await runDirect({
    provider: createFakeProvider([text("done")]),
    seed: "写点东西",
    executeTool: async () => "unused",
  });
  assert.equal(disabled.verification.status, "skipped");
  assert.equal(disabled.verification.reason, "no_final_guard");
  assert.equal("guardVerdict" in disabled.verification, false);
});
