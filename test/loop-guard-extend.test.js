// issue #386 切片 3：预算类停机上的 **guard 补跑桥**（`finalGuardExtend`）。
//
// 这一组用例的职责边界（工单 R4 的八格 + 两条补充）：
//   · R4-1 默认关 ⇒ 逐字不变（本单的**安全底座**：不传就是今天）；
//   · R4-2 opt-in ⇒ 补跑成功（事件 from/to 抬了上限、模型真的补做、第二次 guard accept ⇒ verified）；
//   · R4-3 `stall` + opt-in ⇒ **永远不补**（stall 的定义就是连续无进展）；
//   · R4-4 配额：同一个 run 内第二次撞 cap ⇒ 不再补；
//   · R4-5 跨 resume 不重置：补跑过一次的 run 落账本 → resume → 再撞 cap ⇒ 不能再补；
//   · R4-6 聚合输出预算已撞线 + opt-in ⇒ 拒绝补跑，且预算承诺不被撕（少一次 provider 请求）；
//   · R4-7 `accept` / `skip` / guard 抛异常 三种裁决 + `max_rounds_cap` ⇒ 都不触发桥；
//   · R4-8 选项校验（非布尔 ⇒ TypeError）。
//
// 三处刻意的写法，改之前请先读完：
//   1. 上限一律用**事件里的 `from_max_rounds` / `to_max_rounds`** 断言，不读引擎私有状态——
//      读 `governorState` 会让「事件没发出来」这种情况静默通过。
//   2. 每格都用**新**的 scripted provider（`createFakeProvider` 的脚本是一次性队列）。
//   3. `reflection` 显式给 `extensionStep` / `maxExtensions` / `maxRoundsCap`：默认 step 是
//      `max(8, maxRounds/2)`，不显式给的话「抬到多少」会随 `maxRounds` 漂，断言就不再是判据。
import assert from "node:assert/strict";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { PENDING_TOOL_RESULT_TEXT } from "../src/loop/orchestrator.js";
import { FINAL_GUARD_EXTENDABLE_REASONS, FINAL_GUARD_NON_CONTINUABLE_REASONS } from "../src/loop/termination.js";
import { pendingTrailingToolUses, validateMessages } from "../src/messages/rounds.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const wrapup = (object) => ({
  content: [{ type: "text", text: JSON.stringify(object) }],
  stopReason: "end_turn",
});
const toolUse = (id, name = "noop") => ({
  content: [{ type: "tool_use", id, name, input: {} }],
  stopReason: "tool_use",
});

/** 扩轮参数：显式给全，别让默认 step 随 `maxRounds` 漂（见文件头第 3 条）。 */
const REFLECTION = { enabled: true, extensionStep: 2, maxExtensions: 2, maxRoundsCap: 8 };

const extendEvents = (events) => events.filter((event) => event.type === "final_guard_extend");

/** 「预算类停机 + guard 判 revise」的最小场景：1 轮预算、用完就出圈，收尾后 guard 说还差一步。 */
const capThenRevise = ({ optIn, guard, sink }) => {
  const events = [];
  const executed = [];
  const provider = createFakeProvider([
    toolUse("w1"),
    text("强制收尾"),
    toolUse("fix"),
    wrapup({ done: true, summary: "已补做", output: "完成" }),
    { times: 12, ...text("idle") },
  ]);
  const run = runDirect({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async (call) => {
      executed.push(call.id);
      return "ok";
    },
    ...(optIn === undefined ? {} : { finalGuardExtend: optIn }),
    capabilities: {
      hooks: {
        finalGuard: guard,
        onEvent: sink ?? ((event) => events.push(event)),
      },
    },
  });
  return { run, events, executed, provider };
};

// ── R4-1（回归锚）：默认关 ⇒ 与今天逐字一致 ────────────────────────────────────────
test("#386-3 R4-1 不传 finalGuardExtend：max_rounds_cap + revise ⇒ unverified/non_continuable，verification 与 metrics 逐字等于今天", async () => {
  let guardCalls = 0;
  const { run, events, executed } = capThenRevise({
    optIn: undefined,
    guard: async () => {
      guardCalls += 1;
      return { action: "revise", message: "还差一步" };
    },
  });
  const result = await run;

  assert.equal(guardCalls, 1, "默认关时 guard 只该被调用 1 次（补跑不许发生）");
  assert.deepEqual(executed, ["w1"], "默认关时模型不许被拉回来补做（只跑了第 1 轮那一次）");
  assert.deepEqual(result.termination, { reason: "final_guard_unverified", forcedFinal: true },
    "默认关时终局必须与今天逐字一致");
  // 逐字比：多一个键（比如 `guard_extensions`）就红。
  assert.deepEqual(result.verification, {
    status: "unverified",
    reason: "non_continuable",
    detail: "max_rounds_cap",
    metrics: { verified: 0, skipped: 0, revised: 1, unverified: 1, guard_error: 0 },
  }, "默认关时 verification/metrics 必须与今天逐字一致（`guard_extensions` 不许出现）");
  assert.deepEqual(extendEvents(events), [], "默认关时不许发 final_guard_extend 事件");
  assert.deepEqual(events.filter((event) => event.type === "final_guard").at(-1), {
    type: "final_guard",
    round: 1,
    action: "degraded",
    reason: "non_continuable",
  }, "默认关时 guard 事件的形状也要与今天逐字一致");
});

// ── R4-2：opt-in ⇒ 补跑成功（E4 那一格的正解）────────────────────────────────────────
test("#386-3 R4-2 finalGuardExtend:true：事件抬了上限、模型补做、第二次 accept ⇒ verified", async () => {
  let guardCalls = 0;
  const { run, events, executed } = capThenRevise({
    optIn: true,
    guard: async () => {
      guardCalls += 1;
      return guardCalls === 1
        ? { action: "revise", message: "还差一步：把 fix 做掉" }
        : { action: "accept" };
    },
  });
  const result = await run;

  const extensions = extendEvents(events);
  assert.equal(extensions.length, 1, `必须恰好补跑 1 次（实测 ${extensions.length} 次）`);
  assert.deepEqual(extensions[0], {
    type: "final_guard_extend",
    round: 1,
    from_max_rounds: 1,
    to_max_rounds: 3,
    guard_extension: true,
  }, `事件的 from/to 必须证明上限被抬高（step=2：1 → 3），实测 ${JSON.stringify(extensions[0])}`);
  assert.equal(guardCalls, 2, "补跑之后 guard 必须再被问一次（第二次才可能 accept）");
  assert.deepEqual(executed, ["w1", "fix"], "模型必须真的补做了那一步（不是只在散文里说补了）");
  assert.equal(result.verification.status, "verified", "补跑 + 第二次 accept 之后必须 verified");
  assert.equal(result.verification.metrics.guard_extensions, 1, "metrics.guard_extensions 只在真的补跑过时出现且为 1");
  assert.equal(result.verification.metrics.revised, 1);
  assert.equal(result.termination.reason, "end_turn", "补跑成功后的终局是正常出口，不是 final_guard_unverified");
  // 补跑控制文本确实是 guard 的那句 message（走的是同一个 `meta.source:"judge-control"` 通道）。
  const lastUserText = (extensions.length > 0 ? result.messages : [])
    .filter((message) => message.role === "user")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) => block?.text ?? "")
    .join("\n");
  assert.match(lastUserText, /还差一步：把 fix 做掉/u, "guard 的 revise 文本没有递进补跑那一轮");
});

// ── R4-3：stall 永远不补 ──────────────────────────────────────────────────────────
test("#386-3 R4-3 stall + opt-in ⇒ 不补跑（stall 的定义就是连续无进展，给它轮次是纯烧钱）", async () => {
  const events = [];
  let guardCalls = 0;
  const result = await runDirect({
    // stall 的判据是「同一签名连续 4 次」+ `STALL_STREAK_LIMIT = 3` ⇒ 第 12 轮才停，
    // 所以预算必须给到 20 轮（给 10 轮会先撞 max_rounds_cap，测到的就不是 stall 这条判据）。
    provider: createFakeProvider(
      Array.from({ length: 19 }, (_unused, index) => toolUse(`stall-${index}`))
        .concat({ times: 8, ...text("cannot recover") }),
    ),
    initialUserMessage: "空转",
    maxRounds: 20,
    reflection: { ...REFLECTION, maxRoundsCap: 40 },
    executeTool: async () => "ok",
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return { action: "revise", message: "还差一步" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  assert.equal(result.verification.detail, "stall", "本格的停机原因必须是 stall（否则测的不是这条判据）");
  assert.equal(guardCalls, 1, "stall 上不许补跑（guard 只该被调用 1 次）");
  assert.deepEqual(extendEvents(events), [], "stall 上不许发 final_guard_extend 事件");
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "non_continuable");
  assert.equal(result.termination.reason, "final_guard_unverified");
  assert.equal("guard_extensions" in result.verification.metrics, false, "没补跑就不许出现 guard_extensions 键");
  // 两个集合的内容本单都没改：`stall` 仍在「不可续跑」里、**不在**「可补跑」里。
  assert.equal(FINAL_GUARD_NON_CONTINUABLE_REASONS.has("stall"), true);
  assert.equal(FINAL_GUARD_EXTENDABLE_REASONS.has("stall"), false,
    "`stall` 被塞进了可补跑集合——工单明写「stall 永远不补」");
  assert.deepEqual([...FINAL_GUARD_EXTENDABLE_REASONS], ["max_rounds_cap", "continuation_exhausted"]);
  assert.deepEqual([...FINAL_GUARD_NON_CONTINUABLE_REASONS], ["max_rounds_cap", "stall", "continuation_exhausted"]);
});

// ── R4-4：一次性配额（同 run 内第二次撞 cap 不许再补）──────────────────────────────
test("#386-3 R4-4 同一个 run 内第二次撞 cap ⇒ 不再补（每 run 最多 1 次，即使 governor 还有额度）", async () => {
  const events = [];
  let guardCalls = 0;
  const result = await runDirect({
    // 1 轮预算 + step 2 ⇒ 补跑后上限 3；再跑满 2 轮又撞 cap ⇒ 第二次 guard 仍是 revise。
    provider: createFakeProvider([
      toolUse("w1"),
      text("强制收尾"),
      toolUse("w2"),
      toolUse("w3"),
      text("又一次强制收尾"),
      { times: 12, ...text("idle") },
    ]),
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async () => "ok",
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return { action: "revise", message: "还差一步" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  assert.equal(guardCalls, 2, `两次撞 cap ⇒ guard 被问 2 次，实测 ${guardCalls}`);
  assert.equal(extendEvents(events).length, 1, "配额只允许 1 次补跑（第二次必须被拒）");
  assert.equal(result.verification.metrics.guard_extensions, 1, "guard_extensions 计数封顶 1");
  assert.equal(result.verification.status, "unverified", "第二次撞 cap 且配额用尽 ⇒ 回到今天的降级");
  assert.equal(result.verification.reason, "non_continuable");
  assert.equal(result.termination.reason, "final_guard_unverified");
  // governor 自己还有扩轮额度（maxExtensions=2，只用了 1 次）——这正说明配额是**独立**的成本闸。
  assert.equal(result.rounds, 3, `补跑后上限 3 ⇒ 身份轮号跑到 3，实测 ${result.rounds}`);
});

// ── R4-5：跨 resume 不重置（配额进 journal/state）─────────────────────────────────
test("#386-3 R4-5 补跑过一次的 run 落账本 → resume → 再撞 cap ⇒ 不能再补（配额从账本恢复）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "guard-extend-resume";
  const script = () => [
    toolUse("w1"),
    text("强制收尾"),
    { times: 12, ...text("idle") },
  ];
  const guardAlwaysRevise = () => async () => ({ action: "revise", message: "还差一步" });

  const firstEvents = [];
  let firstCalls = 0;
  const first = await runDirect({
    provider: createFakeProvider(script()),
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async () => "ok",
    store,
    runId,
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          firstCalls += 1;
          return guardAlwaysRevise()();
        },
        onEvent: (event) => firstEvents.push(event),
      },
    },
  });

  assert.equal(firstCalls, 2, "第一段：撞 cap（revise）→ 补跑 → 再撞 cap（revise，被配额拒）");
  assert.equal(extendEvents(firstEvents).length, 1, "第一段用掉了唯一的那份配额");
  assert.equal(first.verification.metrics.guard_extensions, 1);
  assert.equal(first.termination.reason, "final_guard_unverified");

  // 配额**已经进 state**：这是 resume 侧的权威来源（不是内存里的旗标）。
  const state = await store.loadRunState(runId);
  assert.equal(state?.deterministic?.guardExtension?.used, true,
    `补跑配额必须进 state.json（实测 ${JSON.stringify(state?.deterministic?.guardExtension)}）`);

  const secondEvents = [];
  let secondCalls = 0;
  const second = await runDirect({
    provider: createFakeProvider(script()),
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async () => "ok",
    store,
    runId,
    resume: true,
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          secondCalls += 1;
          return guardAlwaysRevise()();
        },
        onEvent: (event) => secondEvents.push(event),
      },
    },
  });

  assert.equal(secondCalls, 1, "resume 之后撞 cap，guard 只该被问 1 次（不许再补跑）");
  assert.deepEqual(extendEvents(secondEvents), [],
    "resume 之后又领到了一份补跑配额 ⇒ 「跑 → 崩 → resume」会变成无界成本");
  assert.equal("guard_extensions" in second.verification.metrics, false, "resume 段没补跑 ⇒ metrics 里不该有这个键");
  assert.equal(second.verification.status, "unverified");
  assert.equal(second.verification.reason, "non_continuable");
  assert.equal(second.termination.reason, "final_guard_unverified");
});

// ── R4-6：预算闸（聚合输出预算已撞线 ⇒ 拒绝补跑，预算承诺不被撕）───────────────────
test("#386-3 R4-6 聚合输出预算已撞线 + opt-in ⇒ 拒绝补跑，且没有多花一次 provider 请求", async () => {
  const store = createMemoryTranscriptStore();
  const events = [];
  let guardCalls = 0;
  const BIG = "x".repeat(60_000); // ≈ 19.7k 估算 token > 聚合预算下限 16k
  const provider = createFakeProvider([
    toolUse("big", "bigTool"),
    text("强制收尾"),
    { times: 12, ...text("idle") },
  ]);
  const result = await runDirect({
    provider,
    initialUserMessage: "输出很多内容",
    maxRounds: 1,
    reflection: REFLECTION,
    // 聚合层要同时具备：store（归档通道）+ budgetTokens（预算基准）+ 逐条上限不先把它 stub 掉。
    store,
    runId: "guard-extend-aggregate",
    outputHygiene: { limit: 200_000 },
    config: { folding: { context: { budgetTokens: 50_000 } } },
    executeTool: async () => BIG,
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return { action: "revise", message: "还差一步" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  assert.ok(
    events.some((event) => event.type === "tool_output_aggregate"),
    "本格的前提是聚合层真的撞了预算（没有 tool_output_aggregate 事件就测不到预算闸）",
  );
  assert.equal(guardCalls, 1, "预算已撞线 ⇒ 不许补跑");
  assert.deepEqual(extendEvents(events), [], "预算已撞线 ⇒ 不许发 final_guard_extend 事件");
  assert.equal(result.verification.reason, "non_continuable");
  // 「预算承诺不被撕」的硬证据：只花了 2 次 provider 请求（第 1 轮 + 强制收尾），
  // 没有因为「补跑」再多买一轮。
  assert.equal(provider.requests.length, 2,
    `补跑被拒时 provider 请求数应保持 2（第 1 轮 + 强制收尾），实测 ${provider.requests.length}`);
  assert.equal("guard_extensions" in result.verification.metrics, false);

  // 对照组（单变量）：同一套选项、同一个 guard，只把工具输出换小 ⇒ 聚合层不撞线 ⇒ 桥照常放行。
  // 没有这一格，上面那格证明不了「拒绝」是预算闸造成的（可能只是别处顺手拦住了）。
  const controlEvents = [];
  const control = await runDirect({
    provider: createFakeProvider([toolUse("small", "bigTool"), text("强制收尾"), { times: 12, ...text("idle") }]),
    initialUserMessage: "输出一点内容",
    maxRounds: 1,
    reflection: REFLECTION,
    store: createMemoryTranscriptStore(),
    runId: "guard-extend-aggregate-control",
    outputHygiene: { limit: 200_000 },
    config: { folding: { context: { budgetTokens: 50_000 } } },
    executeTool: async () => "small",
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => ({ action: "revise", message: "还差一步" }),
        onEvent: (event) => controlEvents.push(event),
      },
    },
  });
  assert.equal(controlEvents.filter((event) => event.type === "tool_output_aggregate").length, 0,
    "对照组的前提是聚合层没撞线");
  assert.equal(extendEvents(controlEvents).length, 1,
    "同一套选项、输出换小之后桥必须放行——否则「预算闸」这个归因就不成立");
  assert.equal(control.verification.metrics.guard_extensions, 1);
});

// ── R4-6b：预算闸的另一半——上下文预算已经撞线（`isApiInputOverBudget`）───────────────
test("#386-3 R4-6b 最近一次真实 API 输入 token 已超 budgetTokens + opt-in ⇒ 拒绝补跑", async () => {
  const runCell = async (inputTokens) => {
    const events = [];
    const provider = createFakeProvider([
      { ...toolUse("w1"), usage: { input_tokens: inputTokens, output_tokens: 5 } },
      { ...text("强制收尾"), usage: { input_tokens: inputTokens, output_tokens: 5 } },
      { times: 12, ...text("idle") },
    ]);
    const result = await runDirect({
      provider,
      initialUserMessage: "做点事",
      maxRounds: 1,
      reflection: REFLECTION,
      config: { folding: { context: { budgetTokens: 10_000 } } },
      executeTool: async () => "ok",
      finalGuardExtend: true,
      capabilities: {
        hooks: {
          finalGuard: async () => ({ action: "revise", message: "还差一步" }),
          onEvent: (event) => events.push(event),
        },
      },
    });
    return { events, result, provider };
  };

  const over = await runCell(50_000); // 50k > budgetTokens 10k ⇒ 上下文已经装不下
  assert.deepEqual(extendEvents(over.events), [], "上下文预算已撞线 ⇒ 不许补跑");
  assert.equal(over.result.verification.reason, "non_continuable");
  assert.equal(over.provider.requests.length, 2, "拒绝补跑 ⇒ 没有多花一次请求（预算承诺不被撕）");

  const under = await runCell(1_000); // 对照组：1k < 10k ⇒ 放行
  assert.equal(extendEvents(under.events).length, 1, "上下文预算没撞线时桥必须放行（否则归因不成立）");
});

// ── R4-7：三种裁决 + max_rounds_cap ⇒ 都不触发桥 ──────────────────────────────────
test("#386-3 R4-7 accept / skip / guard 抛异常 + max_rounds_cap ⇒ 都不触发桥（只有 revise 才服务）", async () => {
  const cells = [
    {
      label: "accept",
      guard: async () => ({ action: "accept" }),
      expectedVerification: { status: "unverified", reason: "non_continuable", detail: "max_rounds_cap" },
      expectedTermination: "final_guard_unverified",
    },
    {
      label: "skip",
      guard: async () => ({ action: "skip", reason: "host says done" }),
      expectedVerification: { status: "skipped", reason: "host says done" },
      expectedTermination: "max_rounds_cap",
    },
    {
      label: "抛异常",
      guard: async () => { throw new Error("verifier crashed"); },
      expectedVerification: { status: "error", reason: "error" },
      expectedTermination: "max_rounds_cap",
    },
  ];
  for (const cell of cells) {
    const events = [];
    const { run, executed } = capThenRevise({
      optIn: true,
      guard: cell.guard,
      extraHooks: {                     capabilities: {
                      hooks: {
                        onEvent: (event) => events.push(event),
                      },
                    }, },
    });
    const result = await run;
    assert.deepEqual(extendEvents(events), [], `${cell.label}：不该触发补跑桥`);
    assert.equal(result.verification.status, cell.expectedVerification.status, `${cell.label}：verification.status 变了`);
    assert.equal(result.verification.reason, cell.expectedVerification.reason, `${cell.label}：verification.reason 变了`);
    if (cell.expectedVerification.detail !== undefined) {
      assert.equal(result.verification.detail, cell.expectedVerification.detail, `${cell.label}：detail 变了`);
    }
    assert.equal(result.termination.reason, cell.expectedTermination, `${cell.label}：终局 reason 变了`);
    assert.equal("guard_extensions" in result.verification.metrics, false, `${cell.label}：没补跑却出现了 guard_extensions`);
    assert.deepEqual(executed, ["w1"], `${cell.label}：模型不该被拉回来补做`);
  }
});

// ── R4-8：选项校验 ────────────────────────────────────────────────────────────────
test("#386-3 R4-8 finalGuardExtend 只接受布尔：null / 数字 / 字符串 ⇒ TypeError（不许当 truthy 静默打开）", async () => {
  for (const value of [null, 1, "true", "false", {}, []]) {
    await assert.rejects(
      () => runDirect({
        provider: createFakeProvider([text("done")]),
        initialUserMessage: "x",
        executeTool: async () => "ok",
        finalGuardExtend: value,
      }),
      (error) => {
        assert.equal(error.constructor, TypeError, `${JSON.stringify(value)}：抛的不是 TypeError`);
        assert.equal(error.message, "finalGuardExtend must be a boolean");
        return true;
      },
      `finalGuardExtend=${JSON.stringify(value)} 没有被拦住`,
    );
  }
  // 放行面：显式 `false` 与不传等价（= 今天）。
  const off = await runDirect({
    provider: createFakeProvider([text("done")]),
    initialUserMessage: "x",
    executeTool: async () => "ok",
    finalGuardExtend: false,
  });
  assert.deepEqual(off.verification, {
    status: "skipped",
    reason: "no_final_guard",
    metrics: { verified: 0, skipped: 0, revised: 0, unverified: 0, guard_error: 0 },
  }, "显式 false 与不传必须等价（= 今天）");
});

// ── 补充格：`continuation_exhausted` 也在可补跑集合里（另一类预算停机）─────────────
test("#386-3 补充 continuation_exhausted + opt-in ⇒ 同样可以补跑一次（不是只有 max_rounds_cap）", async () => {
  const events = [];
  let guardCalls = 0;
  const provider = createFakeProvider([
    // 第 1 轮：模型输出被 max_tokens 截断，且补全预算为 0 ⇒ 治理层 stop cap ⇒ continuation_exhausted。
    { content: [{ type: "text", text: "截断的正文" }], stopReason: "max_tokens" },
    text("强制收尾"),
    toolUse("fix"),
    wrapup({ done: true, summary: "已补做", output: "完成" }),
    { times: 12, ...text("idle") },
  ]);
  const result = await runDirect({
    provider,
    initialUserMessage: "做点事",
    maxRounds: 6,
    maxTokenContinuations: 0,
    reflection: REFLECTION,
    executeTool: async () => "ok",
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return guardCalls === 1 ? { action: "revise", message: "还差一步" } : { action: "accept" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  const extensions = extendEvents(events);
  assert.equal(extensions.length, 1, `continuation_exhausted 上必须也能补跑一次（实测 ${extensions.length} 次）`);
  assert.equal(extensions[0].from_max_rounds, 6);
  assert.equal(extensions[0].to_max_rounds, 8);
  assert.equal(result.verification.status, "verified", "补跑后第二次 accept ⇒ verified");
  assert.equal(result.verification.metrics.guard_extensions, 1);
});

// ── #393：末轮带 `tool_use` 的形状（issue #393）──────────────────────────────────────
//
// 现场：`max_rounds_cap` 掐停之后引擎强制收尾（那次请求 `tools: []`），但模型仍然回了一条
// `tool_use` ⇒ **末条 assistant 带着未被回答的 `tool_use`**。补跑桥原来直接 push 控制文本，
// 于是那条 `tool_use` 与它应有的 `tool_result` 被隔开，下一次 provider 调用以
// `invalid_messages`（`assistant tool_use has no immediately following user tool_result`）
// 拒掉整份历史 ⇒ 宿主收到 `termination: failed`。修法是注入前先按 canonical 判据
// （`pendingTrailingToolUses`）结清尾部，再注入控制文本。
//
// 判据（工单四条）：① 终局不得是 `failed`；② 消息序不变量（`validateMessages` +
// `pendingTrailingToolUses`，都来自 `src/messages/rounds.js`，不另写一套配对规则）；
// ③ 默认关时同形状逐字等于今天；④ 畸形尾巴（id 读不出来）落回 `unverified / non_continuable`。
const pendingTailScript = () => [
  toolUse("w1"),
  // 强制收尾那一轮：模型还在调工具（这就是 #393 的形状）
  toolUse("wrap-tool"),
  toolUse("fix"),
  wrapup({ done: true, summary: "已补做", output: "完成" }),
  { times: 12, ...text("idle") },
];

/** 引擎自写的那条 `tool_result`（按 `tool_use_id` 找），找不到返回 `undefined`。 */
const toolResultFor = (messages, toolUseId) => messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
  .find((block) => block?.type === "tool_result" && block.tool_use_id === toolUseId);

test("#393 末轮带 tool_use + 默认关：同形状下逐字等于今天（标签，不是补跑，更不是 failed）", async () => {
  let guardCalls = 0;
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider(pendingTailScript()),
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async () => "ok",
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return { action: "revise", message: "还差一步" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  assert.notEqual(result.termination.reason, "failed", "默认关时也不许出现 failed（回归锚）");
  assert.equal(result.termination.errorCode, undefined, "终局不许带 errorCode");
  assert.deepEqual(result.termination, { reason: "final_guard_unverified", forcedFinal: true },
    "默认关时终局必须与今天逐字一致");
  assert.deepEqual(result.verification, {
    status: "unverified",
    reason: "non_continuable",
    detail: "max_rounds_cap",
    metrics: { verified: 0, skipped: 0, revised: 1, unverified: 1, guard_error: 0 },
  }, "默认关时 verification/metrics 必须与今天逐字一致（不许出现 guard_extensions）");
  assert.equal(guardCalls, 1, "默认关时 guard 只该被问 1 次");
  assert.deepEqual(extendEvents(events), [], "默认关时不许发 final_guard_extend 事件");
});

test("#393 末轮带 tool_use + opt-in：注入前先结清尾部，终局不是 failed 且消息序合法", async () => {
  let guardCalls = 0;
  const events = [];
  const executed = [];
  const result = await runDirect({
    provider: createFakeProvider(pendingTailScript()),
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async (call) => {
      executed.push(call.id);
      return "ok";
    },
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return guardCalls === 1
            ? { action: "revise", message: "还差一步：把 fix 做掉" }
            : { action: "accept" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  // ① 终局不得是 failed（工单明禁的那一格）
  assert.notEqual(result.termination.reason, "failed", "末轮带工具时补跑不许把 run 打成 failed");
  assert.equal(result.termination.errorCode, undefined, "终局不许带 errorCode（invalid_messages 就是从这里漏出去的）");
  assert.equal(result.termination.reason, "end_turn", "补跑 + 第二次 accept 之后应正常收口");
  assert.equal(result.verification.status, "verified");

  // ② 消息序不变量：判据就是 canonical 那一份，不在这里另写一遍配对规则
  assert.doesNotThrow(() => validateMessages(result.messages),
    "终局消息必须通过 canonical 校验（每个 assistant tool_use 紧跟 user tool_result）");
  assert.deepEqual(pendingTrailingToolUses(result.messages), [],
    "终局不许留下悬空 tool_use（尾部形状判据与 validateMessages 同源）");

  // 引擎自写的那条 `tool_result`：补齐了强制收尾那条 `tool_use`，且**不是**任何工具的真实输出
  const repaired = toolResultFor(result.messages, "wrap-tool");
  assert.ok(repaired !== undefined, "强制收尾那条 tool_use 没有配到 tool_result");
  assert.equal(repaired.is_error, true, "未执行的调用必须标成 is_error（wire 上「没有可用结果」的出口）");
  assert.equal(repaired.content, PENDING_TOOL_RESULT_TEXT,
    "补的正文必须来自唯一来源 PENDING_TOOL_RESULT_TEXT（宿主 / judge 靠 [erix] marker 认出是引擎自写）");
  assert.deepEqual(executed, ["w1", "fix"],
    "补的那条 result 只是事实陈述：它对应的调用不许被执行，补跑那一轮的工具照常执行");
  assert.equal(toolResultFor(result.messages, "fix")?.is_error, undefined,
    "真的执行过的结果不许被顺手标成 is_error");

  // ③ 顺序：assistant(tool_use) → user(tool_result) → user(guard 控制文本)
  const assistantIndex = result.messages.findIndex((message) => (
    message.role === "assistant"
    && (Array.isArray(message.content) ? message.content : [])
      .some((block) => block?.type === "tool_use" && block.id === "wrap-tool")
  ));
  assert.ok(assistantIndex >= 0, "找不到强制收尾那条 assistant tool_use");
  assert.equal(result.messages[assistantIndex + 1]?.content?.[0]?.tool_use_id, "wrap-tool",
    "tool_result 必须紧跟在它的 tool_use 之后（中间不许插进控制文本）");
  assert.match(
    (Array.isArray(result.messages[assistantIndex + 2]?.content)
      ? result.messages[assistantIndex + 2].content : []
    ).map((block) => block?.text ?? "").join(""),
    /还差一步：把 fix 做掉/u,
    "guard 的 revise 文本必须排在 tool_result 之后",
  );
  assert.equal(extendEvents(events).length, 1, "补跑仍要恰好发生 1 次");
  assert.equal(guardCalls, 2);
});

test("#393 末轮带多个 tool_use + opt-in：一条 user 消息补齐全部 id（不许只补第一个）", async () => {
  let guardCalls = 0;
  const result = await runDirect({
    provider: createFakeProvider([
      toolUse("w1"),
      // 强制收尾那一轮回了两个工具调用（一条 assistant 消息里两个 tool_use 块）
      {
        content: [
          { type: "text", text: "还想再调两次" },
          { type: "tool_use", id: "wa", name: "noop", input: {} },
          { type: "tool_use", id: "wb", name: "noop", input: {} },
        ],
        stopReason: "tool_use",
      },
      toolUse("fix"),
      wrapup({ done: true, summary: "已补做", output: "完成" }),
      { times: 12, ...text("idle") },
    ]),
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async () => "ok",
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return guardCalls === 1 ? { action: "revise", message: "还差一步" } : { action: "accept" };
        },
      },
    },
  });

  assert.equal(result.termination.reason, "end_turn");
  assert.doesNotThrow(() => validateMessages(result.messages),
    "多 id 的尾巴只补一部分 ⇒ canonical 校验会以 tool_result ids do not match 报红");
  for (const id of ["wa", "wb"]) {
    assert.equal(toolResultFor(result.messages, id)?.content, PENDING_TOOL_RESULT_TEXT,
      `tool_use ${id} 没有被补齐`);
  }
});

test("#393 畸形尾巴（tool_use 没有 id）：拒绝补跑，落回 unverified/non_continuable（退路 B，不许 failed）", async () => {
  let guardCalls = 0;
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider([
      toolUse("w1"),
      // 非标准响应：tool_use 块没有 id ⇒ 补不出一条合法的 tool_result
      { content: [{ type: "tool_use", name: "noop", input: {} }], stopReason: "tool_use" },
      toolUse("fix"),
      wrapup({ done: true, summary: "已补做", output: "完成" }),
      { times: 12, ...text("idle") },
    ]),
    initialUserMessage: "做点事",
    maxRounds: 1,
    reflection: REFLECTION,
    executeTool: async () => "ok",
    finalGuardExtend: true,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return { action: "revise", message: "还差一步" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });

  assert.notEqual(result.termination.reason, "failed", "补不出合法 tool_result 时也不许留给宿主 failed");
  assert.equal(result.termination.errorCode, undefined);
  assert.deepEqual(extendEvents(events), [], "形状补不出来 ⇒ 不补跑（退路 B）");
  assert.equal(guardCalls, 1);
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "non_continuable");
  assert.equal(result.verification.detail, "max_rounds_cap");
  assert.equal(result.termination.reason, "final_guard_unverified");
  assert.equal("guard_extensions" in result.verification.metrics, false);
});
