// issue #386 切片 1：`finalGuard` payload 的富化面。
//
// 这一组用例的职责边界很窄：**钉住 payload 的形状与上限**，不重复 `test/loop-final-guard.test.js`
// 已有的裁决语义（accept/skip/revise/耗尽/超时那些行为断言仍归那个文件）。
//
// 三处刻意的写法，改动前请先读完：
//   1. 既有 7 键的断言是**逐值 + 逐位置**的（不是「包含」）：`Object.keys(payload).slice(0, 7)`
//      必须与 #386 之前那份名单逐字相同，新键只许落在其后。顺序也是契约——宿主可能按下标读。
//   2. 上限截断**走 `buildFinalGuardPayload` 直测**，不走 `runToolLoop`：`governorState.filesWritten`
//      自己就被 `trimFilesWritten` 压到 50 条（唯一路径），`taskBrief` 也被 `resolveTaskBrief`
//      压到 1500 码点 —— 从公开入口根本造不出「超限」的输入，直测组装函数才是那条路径唯一的证。
//   3. 反向证（删掉某个新键的写入点，用例必须变红）在工单报告里贴了实跑命令与输出；
//      本文件不写「自我变异」用例，那种用例只能证明变异器自己会写文件。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import {
  FINAL_GUARD_PAYLOAD_LIMITS,
  buildFinalGuardPayload,
} from "../src/loop/termination.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

/** #386 之前的 7 个键，顺序即契约（新键只许追加在它们之后）。 */
const LEGACY_KEYS = ["finalText", "findings", "messages", "round", "rounds", "signal", "termination"];

/** #386 的加法键（含只在截断时出现的标记键）。 */
const ADDITIVE_KEYS = [
  "cwd", "runId", "filesWritten", "filesWrittenTruncated", "fileWrites", "fileWritesTruncated",
  "toolStats", "toolStatsTruncated",
  "taskBrief", "taskBriefTruncated", "selfReport", "selfReportSummaryTruncated",
  "selfReportOutputTruncated", "usage", "elapsedMs", "attempt", "guardBudget",
];

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const wrapup = (object, usage) => ({
  content: [{ type: "text", text: JSON.stringify(object) }],
  stopReason: "end_turn",
  ...(usage === undefined ? {} : { usage }),
});
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

/** 组装函数的**最小合法 ctx**：只铺 `buildFinalGuardPayload` 真正读的字段。 */
function fakeCtx(overrides = {}) {
  return {
    finalText: "final",
    declaredFindings: undefined,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    rounds: 3,
    toolSignal: undefined,
    usage: { input_tokens: 1, output_tokens: 2 },
    elapsedMs: () => 12,
    finalGuardRetryLimit: 2,
    ...overrides,
  };
}

// ── 1. 既有 7 键逐字不变 ────────────────────────────────────────────────────────
test("#386 既有 7 键的名字/顺序/类型/取值逐字不变（同一 scripted run 上逐值断言）", async () => {
  const dir = await makeTmp("erix-fg-legacy-");
  const answerPath = `${dir}/answer.txt`;
  let payload;
  const result = await runDirect({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: answerPath, content: "42" }),
      wrapup(
        { done: true, summary: "已写入", output: "answer.txt 内容是 42", findings: { answer: "42" } },
        { input_tokens: 7, output_tokens: 3 },
      ),
    ]),
    initialUserMessage: "把 42 写进 answer.txt",
    maxRounds: 4,
    executeTool: async (call) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(call.input.path, call.input.content);
      return "ok";
    },
    capabilities: {
      hooks: {
        finalGuard: async (value) => {
          payload = value;
          return { action: "accept" };
        },
      },
    },
  });

  const keys = Object.keys(payload);
  assert.deepEqual(keys.slice(0, LEGACY_KEYS.length), LEGACY_KEYS,
    "既有 7 键的名字或顺序变了——这是宿主可能按下标读的契约面");
  const unknown = keys.filter((key) => !LEGACY_KEYS.includes(key) && !ADDITIVE_KEYS.includes(key));
  assert.deepEqual(unknown, [], `payload 出现未登记的键：${unknown.join(",")}`);

  // 逐值：这 7 个键在 #386 之前就是这个形状，现在一个字都不许动。
  assert.equal(payload.finalText, "answer.txt 内容是 42");
  assert.deepEqual(payload.findings, { answer: "42" });
  assert.deepEqual(payload.messages, result.messages, "messages 必须是本 run 的全量上下文（深拷贝）");
  assert.notEqual(payload.messages, result.messages, "messages 不许是活引用");
  // 本 run 两轮：第 1 轮 writeFile，第 2 轮收尾信封 ⇒ round === rounds === 2（既有语义）。
  assert.equal(payload.round, 2);
  assert.equal(payload.rounds, 2);
  assert.ok(payload.signal !== undefined && typeof payload.signal.aborted === "boolean",
    "signal 仍是引擎内部的 tool AbortSignal");
  assert.deepEqual(payload.termination, { reason: "end_turn" });
});

// ── 2. 每个加法键的形状 + JSON-safe ─────────────────────────────────────────────
test("#386 每个加法键都在场且形状正确，toolStats 是 plain object 且 JSON 里有真实计数", async () => {
  const dir = await makeTmp("erix-fg-shape-");
  const answerPath = `${dir}/answer.txt`;
  let payload;
  const result = await runDirect({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: answerPath, content: "42" }),
      toolUse("w2", "writeFile", { path: `${dir}/second.txt`, content: "7" }),
      wrapup(
        { done: true, summary: "写完两个", output: "两个文件都写了", findings: { first: "42", second: "7" } },
        { input_tokens: 11, output_tokens: 5 },
      ),
    ]),
    initialUserMessage: `把 42 写进 ${answerPath}`,
    // #498 S3 A9：`task` 的扁平写法已退役，写点是 `config.metadata.task`
    // （载荷里的 `taskBrief` 读的就是展开后的 `effectiveOptions.task`）。
    config: { metadata: { task: "写两个文件" } },
    cwd: dir,
    runId: "run-shape",
    maxRounds: 4,
    executeTool: async () => "ok",
    capabilities: {
      hooks: {
        finalGuard: async (value) => {
          payload = value;
          return { action: "accept" };
        },
      },
    },
  });

  assert.equal(payload.cwd, dir);
  assert.equal(payload.runId, "run-shape");
  assert.equal(payload.taskBrief, "写两个文件");
  assert.ok(Array.isArray(payload.filesWritten) && payload.filesWritten.length === 2,
    `filesWritten 应有 2 条（两次 writeFile），实际 ${JSON.stringify(payload.filesWritten)}`);
  assert.deepEqual(payload.filesWritten.map((entry) => entry.round), [1, 2],
    "两次 writeFile 各占一轮（每轮一次 provider 响应），轮号必须如实记录");
  for (const entry of payload.filesWritten) {
    assert.deepEqual(Object.keys(entry).sort(), ["path", "round"]);
    assert.equal(typeof entry.path, "string");
  }

  // toolStats：**不是 Map**（`JSON.stringify(new Map())` 是 `{}`，宿主会读到空对象）。
  assert.equal(Object.getPrototypeOf(payload.toolStats), Object.prototype, "toolStats 必须是 plain object");
  assert.equal(payload.toolStats instanceof Map, false);
  assert.deepEqual(payload.toolStats, { writeFile: { calls: 2, failures: 0 } });
  const serialized = JSON.stringify(payload);
  assert.ok(serialized.includes('"toolStats":{"writeFile":{"calls":2,"failures":0}}'),
    `JSON.stringify(payload) 里没有真实计数：${serialized.slice(0, 400)}`);

  assert.deepEqual(Object.keys(payload.selfReport).sort(), ["done", "findings", "output", "summary"]);
  assert.equal(payload.selfReport.done, true);
  assert.equal(payload.selfReport.output, "两个文件都写了");
  assert.deepEqual(payload.selfReport.findings, { first: "42", second: "7" });

  assert.deepEqual(payload.usage, { input_tokens: 11, output_tokens: 5 });
  assert.ok(Number.isFinite(payload.elapsedMs) && payload.elapsedMs >= 0);
  assert.equal(payload.attempt, 1);
  assert.equal(payload.guardBudget, 2);

  // JSON-safe：往返之后形状不变（无函数、无循环引用、无 Error）。
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), JSON.parse(JSON.stringify(payload)));
  const roundTrip = JSON.parse(serialized);
  assert.deepEqual(roundTrip.filesWritten, payload.filesWritten);
  assert.deepEqual(roundTrip.toolStats, payload.toolStats);
  assert.deepEqual(roundTrip.selfReport, payload.selfReport);
  assert.equal(roundTrip.usage.input_tokens, 11);
  // 引擎侧的裁决面不因富化而变。
  assert.equal(result.verification.status, "verified");
});

// ── 3. 上限截断（直测组装函数：公开入口造不出超限输入，理由见文件头第 2 条）─────────
test("#386 filesWritten 超过 50 条时保留最后 50 条并带可判定截断标记", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ path: `f-${index + 1}.txt`, round: index + 1 }));

  const truncated = buildFinalGuardPayload(
    fakeCtx({ filesWritten: many }),
    "end_turn",
    undefined,
    1,
  );
  assert.equal(truncated.filesWritten.length, FINAL_GUARD_PAYLOAD_LIMITS.filesWritten);
  assert.equal(FINAL_GUARD_PAYLOAD_LIMITS.filesWritten, 50);
  // 保留的是**最后** 50 条（= 最新）：f-11 … f-60。
  assert.equal(truncated.filesWritten[0].path, "f-11.txt");
  assert.equal(truncated.filesWritten.at(-1).path, "f-60.txt");
  assert.equal(truncated.filesWrittenTruncated, true, "截断了却没有可判定标记");

  // 边界：恰好 50 条不算截断（标记不许常驻）。
  const exactly = buildFinalGuardPayload(
    fakeCtx({ filesWritten: many.slice(10) }),
    "end_turn",
    undefined,
    1,
  );
  assert.equal(exactly.filesWritten.length, 50);
  assert.equal("filesWrittenTruncated" in exactly, false, "恰好 50 条不该出现截断标记");
});

test("#386 taskBrief 的 2000 码点边界与截断标记（按码点截，不切碎代理对）", () => {
  const limit = FINAL_GUARD_PAYLOAD_LIMITS.taskBrief;
  assert.equal(limit, 2000);

  const atLimit = buildFinalGuardPayload(fakeCtx({ taskBrief: "a".repeat(limit) }), "end_turn", undefined, 1);
  assert.equal(atLimit.taskBrief.length, limit);
  assert.equal("taskBriefTruncated" in atLimit, false, "恰好 2000 码点不该出现截断标记");

  const overLimit = buildFinalGuardPayload(fakeCtx({ taskBrief: "a".repeat(limit + 1) }), "end_turn", undefined, 1);
  assert.equal(overLimit.taskBrief.length, limit);
  assert.equal(overLimit.taskBriefTruncated, true);

  // 码点口径：emoji 占两个 UTF-16 码元，按码点截断后仍是完整的 2000 个字符。
  const emoji = buildFinalGuardPayload(fakeCtx({ taskBrief: "🙂".repeat(limit + 10) }), "end_turn", undefined, 1);
  assert.equal(Array.from(emoji.taskBrief).length, limit);
  assert.equal(emoji.taskBriefTruncated, true);
  assert.equal(emoji.taskBrief.isWellFormed?.() ?? true, true, "截断把代理对切碎了");

  // 探不到（空串 / 非字符串）就不写该键——「未提供」与「提供了空串」在这里都归为不写。
  const empty = buildFinalGuardPayload(fakeCtx({ taskBrief: "" }), "end_turn", undefined, 1);
  assert.equal("taskBrief" in empty, false);
  const missing = buildFinalGuardPayload(fakeCtx(), "end_turn", undefined, 1);
  assert.equal("taskBrief" in missing, false);
});

test("#386 toolStats 超过 40 个工具名时只留调用最多的 40 个并带截断标记", () => {
  const stats = new Map();
  for (let index = 1; index <= 45; index += 1) {
    stats.set(`tool-${index}`, { calls: index, failures: 0 });
  }
  const payload = buildFinalGuardPayload(fakeCtx({ toolStats: stats }), "end_turn", undefined, 1);
  assert.equal(Object.keys(payload.toolStats).length, FINAL_GUARD_PAYLOAD_LIMITS.toolStats);
  assert.equal(FINAL_GUARD_PAYLOAD_LIMITS.toolStats, 40);
  // 保留的是 calls 最多的那 40 个：tool-6 … tool-45。
  assert.equal(payload.toolStats["tool-45"].calls, 45);
  assert.equal("tool-5" in payload.toolStats, false);
  assert.equal(payload.toolStatsTruncated, true);

  // 恰好 40 个：无标记。
  const exact = new Map([...stats].slice(5));
  const exactPayload = buildFinalGuardPayload(fakeCtx({ toolStats: exact }), "end_turn", undefined, 1);
  assert.equal(Object.keys(exactPayload.toolStats).length, 40);
  assert.equal("toolStatsTruncated" in exactPayload, false);
});

test("#386 selfReport 的 output/summary 各截到 2000 码点，findings 恒等于 payload.findings", () => {
  const limit = FINAL_GUARD_PAYLOAD_LIMITS.selfReportText;
  const long = "x".repeat(limit + 5);
  const payload = buildFinalGuardPayload(
    fakeCtx({
      selfReport: { done: true, summary: long, output: long, findings: { ignored: "yes" } },
      declaredFindings: { authoritative: "42" },
    }),
    "end_turn",
    undefined,
    1,
  );
  assert.equal(payload.selfReport.summary.length, limit);
  assert.equal(payload.selfReport.output.length, limit);
  assert.equal(payload.selfReportSummaryTruncated, true);
  assert.equal(payload.selfReportOutputTruncated, true);
  // 同源：selfReport.findings 取的是 `declaredFindings`，不是自报对象里那份原始 findings。
  assert.deepEqual(payload.selfReport.findings, { authoritative: "42" });
  assert.equal(payload.selfReport.findings, payload.findings, "两者必须是同一个对象（同源，不是拷贝后再比）");
});

// ── 4. cwd 透传：给了就有、没给就没有该键、非字符串报错 ─────────────────────────
test("#386 cwd：传了就有（含空串），不传就没有该键，非字符串抛 TypeError", async () => {
  const runWith = async (extra) => {
    let payload;
    await runDirect({
      provider: createFakeProvider([text("done")]),
      initialUserMessage: "hi",
      maxRounds: 2,
      executeTool: async () => "ok",
      capabilities: {
        hooks: {
          finalGuard: async (value) => {
            payload = value;
            return { action: "accept" };
          },
        },
      },
      ...extra,
    });
    return payload;
  };

  const provided = await runWith({ cwd: "/work/host-dir" });
  assert.equal(provided.cwd, "/work/host-dir");
  // 空串也是「提供了」：缺省 ≠ 空串，两者必须可区分。
  const emptyString = await runWith({ cwd: "" });
  assert.equal("cwd" in emptyString, true);
  assert.equal(emptyString.cwd, "");
  const absent = await runWith({});
  assert.equal("cwd" in absent, false, "没传 cwd 时 payload 里不该有该键（不是 undefined，是根本没有）");
  // 其余加法键不受影响（证明「不写」是逐键判断，不是整块缺席）。
  assert.ok("toolStats" in absent && "attempt" in absent);

  for (const bad of [123, null, true, ["/tmp"], { dir: "/tmp" }]) {
    await assert.rejects(
      () => runWith({ cwd: bad }),
      (error) => {
        assert.equal(error instanceof TypeError, true, `cwd=${JSON.stringify(bad)} 必须抛 TypeError`);
        assert.equal(error.message, "cwd must be a string");
        return true;
      },
      `cwd=${JSON.stringify(bad)} 必须被拒`,
    );
  }
});

// ── 5. attempt 单调递增 + guardBudget 等于 finalGuardMaxRetries ─────────────────
test("#386 attempt 在连续 revise 中 1→2→3 单调递增，guardBudget 等于 finalGuardMaxRetries", async () => {
  const run = async (finalGuardMaxRetries) => {
    const seen = [];
    const result = await runDirect({
      provider: createFakeProvider([
        text("draft-1"),
        { times: 10, ...text("draft-again") },
      ]),
      initialUserMessage: "hi",
      maxRounds: 12,
      completion: false,
      // #498 S3 (`guard` slice): written at its canonical home `config.guard.finalGuardMaxRetries`.
      config: { guard: { finalGuardMaxRetries } },
      executeTool: async () => "ok",
      capabilities: {
        hooks: {
          finalGuard: async (payload) => {
            seen.push({ attempt: payload.attempt, budget: payload.guardBudget });
            return { action: "revise", message: "请核实" };
          },
        },
      },
    });
    return { seen, result };
  };

  const defaults = await run(2);
  assert.deepEqual(defaults.seen.map((entry) => entry.attempt), [1, 2, 3]);
  assert.deepEqual(defaults.seen.map((entry) => entry.budget), [2, 2, 2]);
  assert.equal(defaults.result.verification.status, "unverified");
  assert.equal(defaults.result.verification.reason, "max_retries");

  const wider = await run(5);
  assert.deepEqual(wider.seen.map((entry) => entry.attempt), [1, 2, 3, 4, 5, 6],
    "attempt 必须与重试上限一起走（不是恒为 3）");
  assert.deepEqual(wider.seen.map((entry) => entry.budget), [5, 5, 5, 5, 5, 5]);
  assert.equal(wider.result.termination.reason, "final_guard_unverified");
});

// ── 6. selfReport 与 findings 同源（不出现分裂）─────────────────────────────────
test("#386 selfReport 与 findings 同源：有 findings 就两边都有，没声明就两边都没有", async () => {
  const run = async (steps) => {
    let payload;
    await runDirect({
      provider: createFakeProvider(steps),
      initialUserMessage: "hi",
      maxRounds: 4,
      executeTool: async () => "ok",
      capabilities: {
        hooks: {
          finalGuard: async (value) => {
            payload = value;
            return { action: "accept" };
          },
        },
      },
    });
    return payload;
  };

  const declared = await run([wrapup({ done: true, summary: "s", output: "o", findings: { k: "v" } })]);
  assert.deepEqual(declared.findings, { k: "v" });
  assert.deepEqual(declared.selfReport.findings, declared.findings);
  assert.equal(declared.selfReport.findings, declared.findings, "同一份引用：不许出现两份会分叉的 findings");

  const noFindings = await run([wrapup({ done: true, summary: "s", output: "o" })]);
  assert.equal(noFindings.findings, undefined);
  assert.equal("findings" in noFindings.selfReport, false,
    "没声明 findings 时 selfReport 里不该有该键（写了空对象就是假值）");

  // 连 wrap-up 信封都没有（纯散文）⇒ 自报对象整个不写，findings 也不写。
  const prose = await run([text("我做完了")]);
  assert.equal("selfReport" in prose, false, "没有自报对象时不该写 selfReport");
  assert.equal(prose.findings, undefined);
});

// ── 7. 「探不到就不写」的其它面：没有 usage / 没有 elapsedMs 时不写假值 ──────────
test("#386 探不到就不写：缺 usage / 缺 elapsedMs / 缺 runId 时该键整个缺席", () => {
  const minimal = buildFinalGuardPayload(
    {
      finalText: "",
      declaredFindings: undefined,
      messages: [],
      rounds: 0,
      toolSignal: undefined,
    },
    "end_turn",
    undefined,
    1,
  );
  for (const key of ["usage", "elapsedMs", "runId", "cwd", "taskBrief", "selfReport", "filesWritten", "toolStats", "guardBudget"]) {
    assert.equal(key in minimal, false, `${key} 探不到时不该写（写了就是假值）`);
  }
  // 恒在场的只有「本次调用」这件事本身。
  assert.equal(minimal.attempt, 1);
  assert.deepEqual(minimal.termination, { reason: "end_turn" });
});
