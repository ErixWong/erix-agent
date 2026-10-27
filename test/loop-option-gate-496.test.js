// issue #496（S1）—— 输入校验做成「规范化表示的性质」，不再是「入口路线的性质」。
//
// 病根（实测）：`normalizeRunToolLoopOptions` 只在派生**之前**对原始输入做顶层名称检查，
// 合并出 `effectiveOptions` 之后零校验；`context` 子键只有装配侧有闭集校验。于是同一份配置
// 走装配口抛 `unknown assembly policy context option: "summarizeBudgetMs"`、走直连**静默按默认跑**
// （run 正常 `end_turn`）。本文件钉住修好之后的形状：
//
//   A. 两相分工：预检相（顶层名称/形状，早于一切、不碰端口）在前；语义相（取值 + 回调形状，
//      输入是**合并后**的表示）在后；语义相早于能力缺失检查（所以「配置错」不会被「缺 provider」
//      这种噪声盖掉）。
//   B. 每条闸口规则各自配**正例 + 反例**（不靠 parity 代劳正确性）：反例两条路线都抛**同一句**，
//      只差 `error.via`；正例两条路线都不抛。
//   C. 旋钮家族闭集**派生**：对 `FOLD_SUMMARIZER_CAP_NAMES` 每个键造一次手滑 ⇒ 两条路线都抛；
//      合法键 ⇒ 都不抛；宿主业务键 ⇒ 不抛且留 `context_unknown_option` 事件（#469 的回归）。
//   D. 回调形状：9 个承载宿主回调的字段，省略/给对都照旧工作（旧位置回归），给错则启动即抛。
//   E. 可达性：`maxRounds` / `deliverables` / `partialPersistence` / `persistence` 这类取值校验
//      **仍由 orchestrator 承担**，两条路线都汇到那里（`error.via === undefined` 就是机器判据：
//      闸口抛的错一定带 via 标签，不带标签 ⇒ 不是闸口抛的）。这条用例防的是「以为语义相全权负责，
//      于是把 orchestrator 里的校验删掉，两边都不管」。
//
// mutation 自证（每条规则各一个 target，实测见交付报告；改的是**代码行**不是注释）：
//   · `collectSemanticOptionProblems` 里 `context must be an object` 那支降级成 `return []`
//     ⇒ B 段 context-shape 反例红；
//   · `validateContextOptionNames` 的 `problems.push(...)` 降级成 `console.log`
//     ⇒ C 段「每个旋钮手滑」逐条红；
//   · `validateFoldSummarizerCaps` 的 `problems.push(...)` 降级 ⇒ B 段 knob-value 反例红；
//   · `validateContextCallbackShapes` 的 `problems.push(...)` 降级 ⇒ B 段三个 context 回调反例红；
//   · `CALLBACK_OPTION_PATHS` 的循环体 `problems.push(...)` 降级 ⇒ B 段四个顶层回调反例红；
//   · `assertSemanticOptionValues` 的 `throw` 降级成 `return` ⇒ B 段全部反例红、A 段次序用例红。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import {
  CONTEXT_OPTION_NAMES,
  FOLD_SUMMARIZER_CAP_NAMES,
  isSummarizerKnobKey,
} from "../src/assembly-validators.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const GATE_MESSAGE = /unknown assembly policy context option|must be a function \(or omitted\)|must be an object|must be a positive integer/u;

/** 一次成功的 fake provider（每个 run 一份，脚本不共享）。 */
const providerOnce = () => createFakeProvider(DONE);

/** 直连路线：只带需要被测的那几个选项，其余给到「能跑完一轮」的最小合法集。 */
function runDirect(extra = {}) {
  return runToolLoop({
    provider: providerOnce(),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    ...extra,
  });
}

/** 直连路线的「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => runDirect(extra).then(() => null, (error) => error);

/** 装配口路线的端口（`policy` 在构造期就过闸口）。 */
function makePort(policy = {}, { emit } = {}) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: providerOnce(),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: `gate-496-${process.pid}` },
    ...(emit === undefined ? {} : { emit }),
    policy,
  });
}

/** 装配口路线的「抛了什么」：构造期（policy）或合并后（显式选项）任一处抛都算。 */
const assemblyError = (policy = {}, explicit = {}) => {
  try {
    makePort(policy);
  } catch (error) {
    return Promise.resolve(error);
  }
  return runToolLoop({ assemblyPort: makePort(policy), initialUserMessage: "go", completion: false, ...explicit })
    .then(() => null, (error) => error);
};

/**
 * 闸口规则表（正例 / 反例一一对应）。`bad` 与 `good` 是**同一个字段**的错值与对值——
 * 只给反例会让「闸口把整个字段都拒了」这种过严也算绿。
 */
const GATE_RULES = [
  {
    id: "context-shape",
    bad: { context: "not-an-object" },
    good: { context: { budgetTokens: 1000 } },
    message: "context must be an object",
  },
  {
    id: "context-knob-name",
    bad: { context: { budgetTokens: 1000, summarizeBudgetMs: 5 } },
    good: { context: { budgetTokens: 1000, summarizerBudgetMs: 5 } },
    message: 'unknown assembly policy context option: "summarizeBudgetMs"',
  },
  {
    id: "context-knob-value",
    bad: { context: { maxSummaryTokens: 0 } },
    good: { context: { maxSummaryTokens: 900 } },
    message: "maxSummaryTokens must be a positive integer",
  },
  {
    id: "onFoldSummary-shape",
    bad: { onFoldSummary: "notes" },
    good: { onFoldSummary: () => {} },
    message: "assembly policy option onFoldSummary must be a function (or omitted)",
  },
  {
    id: "context.onBeforeFold-shape",
    bad: { context: { onBeforeFold: "hooks" } },
    good: { context: { onBeforeFold: () => {} } },
    message: "context.onBeforeFold must be a function (or omitted)",
  },
  {
    id: "context.onAfterFold-shape",
    bad: { context: { onAfterFold: {} } },
    good: { context: { onAfterFold: () => {} } },
    message: "context.onAfterFold must be a function (or omitted)",
  },
  {
    id: "finalGuard-shape",
    bad: { finalGuard: true },
    good: { finalGuard: async () => ({ action: "accept" }) },
    message: "finalGuard must be a function (or omitted)",
  },
  {
    id: "retry.sleepImpl-shape",
    bad: { retry: { attempts: 1, sleepImpl: 10 } },
    good: { retry: { attempts: 1, sleepImpl: async () => {} } },
    message: "retry.sleepImpl must be a function (or omitted)",
  },
  {
    id: "reflection.onReflection-shape",
    bad: { reflection: { enabled: false, onReflection: "cb" } },
    good: { reflection: { enabled: false, onReflection: () => {} } },
    message: "reflection.onReflection must be a function (or omitted)",
  },
  {
    id: "diagnostics.error-shape",
    bad: { diagnostics: { error: "cb" } },
    good: { diagnostics: { error: () => {} } },
    message: "diagnostics.error must be a function (or omitted)",
  },
];

// ================================================================ A. 两相分工与次序
test("A① 预检相仍早于一切：顶层未知键压过语义相违规（网关未触碰、resolver 未调用）", async () => {
  const reads = [];
  const inner = {
    modelConfig: { resolve: async () => ({}) },
    provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "gate-order-1" },
    policy: {},
  };
  const port = new Proxy(inner, {
    get(target, property) {
      reads.push(String(property));
      return target[property];
    },
  });
  let resolved = 0;
  const error = await runToolLoop({
    assemblyPort: port,
    initialUserMessage: "go",
    // 语义相会拒的值（`context` 不是对象）与顶层未知键同时存在 ⇒ 必须先报未知键。
    context: "not-an-object",
    modelConfig: { resolve: async () => { resolved += 1; return {}; } },
    bogusKey: 1,
  }).then(() => null, (caught) => caught);
  assert.equal(error.message, 'unknown runToolLoop option: "bogusKey"');
  assert.equal(error.via, undefined, "预检相的错不贴路线标签（它不是闸口抛的）");
  assert.deepEqual(reads, [], "预检相不得读取端口");
  assert.equal(resolved, 0, "预检相不得调用 modelConfig.resolve");
});

test("A② 语义相晚于 assemblyPortOptions、早于能力缺失检查（配置错不被「缺 provider」盖掉）", async () => {
  // 对照组：同样的缺 provider/executeTool，但配置合法 ⇒ 报的是能力缺失。
  const capabilityError = await runToolLoop({ initialUserMessage: "go" }).then(() => null, (caught) => caught);
  assert.equal(
    capabilityError.message,
    "assembly port is missing methods: provider.chat or provider.chatStream, executeTool",
  );

  // 语义相违规 + 缺能力 ⇒ 必须先报语义相（它在能力检查之前）。
  const gateError = await runToolLoop({
    initialUserMessage: "go",
    context: { summarizeBudgetMs: 5 },
  }).then(() => null, (caught) => caught);
  assert.equal(gateError.message, 'unknown assembly policy context option: "summarizeBudgetMs"');
  assert.equal(gateError.via, "direct");
});

test("A③ 语义相吃的是**合并后**的表示：装配口的合法值 + 显式 undefined 不覆盖", async () => {
  // 装配口给合法 `maxSummaryTokens`（正例，防过严）：显式 `context: undefined` 不得把它抹掉。
  const port = makePort({ context: { strategy: "fold-llm", maxSummaryTokens: 900 } });
  const result = await runToolLoop({
    assemblyPort: port,
    initialUserMessage: "go",
    completion: false,
    context: undefined,
  });
  assert.equal(result.termination.reason, "end_turn");

  // 显式值覆盖装配值时，语义相校的是**覆盖后**的那份（装配口合法、显式拼错 ⇒ 抛）。
  const overridden = await runToolLoop({
    assemblyPort: makePort({ context: { budgetTokens: 1000 } }),
    initialUserMessage: "go",
    completion: false,
    context: { budgetTokens: 1000, summarizeBudgetMs: 5 },
  }).then(() => null, (caught) => caught);
  assert.equal(overridden.message, 'unknown assembly policy context option: "summarizeBudgetMs"');
  assert.equal(overridden.via, "assembly", "路线标签取入口形状（这次调的是装配口 API）");
});

// ================================================================ B. 逐规则正例 / 反例
test("B 每条闸口规则：反例两条路线都抛同一句（只差 via），正例两条路线都不抛", async () => {
  for (const rule of GATE_RULES) {
    // ── 反例：直连
    const direct = await directError(rule.bad);
    assert.ok(direct instanceof TypeError, `${rule.id}: 直连必须抛 TypeError，实测 ${String(direct)}`);
    assert.equal(direct.message, rule.message, `${rule.id}: 直连文案`);
    assert.equal(direct.via, "direct", `${rule.id}: 直连路线标签`);

    // ── 反例：装配口（policy 侧 / 显式侧都走同一个闸口）
    const assembly = await assemblyError(rule.bad);
    assert.ok(assembly instanceof TypeError, `${rule.id}: 装配口必须抛 TypeError，实测 ${String(assembly)}`);
    assert.equal(assembly.message, rule.message, `${rule.id}: 两条路线必须同一句文案`);
    assert.equal(assembly.via, "assembly", `${rule.id}: 装配口路线标签`);

    // ── 正例：同一字段给对 ⇒ 两条路线都不抛（防「闸口把整个字段都拒了」的过严）
    const directOk = await directError(rule.good);
    assert.equal(directOk, null, `${rule.id}: 直连正例不得抛（实测 ${directOk?.message}）`);
    const assemblyOk = await assemblyError(rule.good);
    assert.equal(assemblyOk, null, `${rule.id}: 装配口正例不得抛（实测 ${assemblyOk?.message}）`);
  }
});

test("B 多问题合并：同一次调用里的多个问题按规则顺序用「; 」连成一条 TypeError", async () => {
  const error = await directError({
    context: { summarizeBudgetMs: 5, maxSummaryTokens: 0, onBeforeFold: "hooks" },
  });
  assert.equal(
    error.message,
    'unknown assembly policy context option: "summarizeBudgetMs"; '
      + "maxSummaryTokens must be a positive integer; "
      + "context.onBeforeFold must be a function (or omitted)",
  );
  assert.equal(error.via, "direct");
});

// ================================================================ C. 旋钮家族闭集（派生）
test("C① 每个旋钮名的拼错都在两条路线抛：派生自 FOLD_SUMMARIZER_CAP_NAMES", async () => {
  assert.ok(FOLD_SUMMARIZER_CAP_NAMES.length >= 5, "前提：旋钮家族至少五个键");
  for (const name of FOLD_SUMMARIZER_CAP_NAMES) {
    const typo = `${name}s`;
    assert.equal(isSummarizerKnobKey(typo), true, `${typo} 必须被认成旋钮手滑`);
    assert.equal(CONTEXT_OPTION_NAMES.includes(typo), false, `${typo} 不得在白名单里`);
    const direct = await directError({ context: { [typo]: 1024 } });
    assert.equal(direct?.message, `unknown assembly policy context option: ${JSON.stringify(typo)}`, `直连 ${typo}`);
    const assembly = await assemblyError({ context: { [typo]: 1024 } });
    assert.equal(assembly?.message, direct?.message, `两条路线 ${typo} 必须同一句`);
  }
});

test("C② 每个旋钮的合法值都在两条路线放行；非法值（0 / 负数 / 小数 / 字符串 / null）都抛", async () => {
  for (const name of FOLD_SUMMARIZER_CAP_NAMES) {
    const ok = await directError({ context: { [name]: 1024 } });
    assert.equal(ok, null, `${name}=1024 必须放行（实测 ${ok?.message}）`);
    for (const value of [0, -1, 1.5, "1024", null]) {
      const expected = `${name} must be a positive integer`;
      const direct = await directError({ context: { [name]: value } });
      assert.equal(direct?.message, expected, `${name}=${String(value)} 直连`);
      const assembly = await assemblyError({ context: { [name]: value } });
      assert.equal(assembly?.message, expected, `${name}=${String(value)} 装配口`);
    }
  }
});

test("C③ 宿主业务键照旧放行（#469 回归）：不抛，且留一条 context_unknown_option 事件", async () => {
  // 直连侧：业务键不是旋钮家族 ⇒ 语义相不拦；引擎也不发事件（没有 emit 端口），但绝不抛。
  const directOk = await directError({
    context: { budgetTokens: 1000, workspaceName: "fde-station", summaryStyle: "brief" },
  });
  assert.equal(directOk, null, "直连：业务键不得被当成拼错的旋钮");

  // 装配口侧：放行 + 事件（`event.keys` 只含真正未知的那个）。
  const events = [];
  const port = makePort(
    { context: { budgetTokens: 1000, toolContext: { repo: "demo" }, workspaceName: "fde-station" } },
    { emit: (type, event) => events.push({ type, event }) },
  );
  assert.ok(port !== undefined);
  const warning = events.find((entry) => entry.type === "context_unknown_option");
  assert.ok(warning, "未知业务键必须至少留下一条事件（不静默）");
  assert.deepEqual(warning.event.keys, ["workspaceName"], "只报真正未知的那个");
});

// ================================================================ D. 回调形状（旧位置回归 + 新规则）
test("D① 9 个承载宿主回调的字段：省略 = 不订阅，两条路线都照旧跑完（旧位置回归）", async () => {
  const calls = { onBeforeFold: 0, onAfterFold: 0, onFoldSummary: 0, finalGuard: 0, onReflection: 0, error: 0, check: 0 };
  const hooks = {
    onBeforeFold: () => { calls.onBeforeFold += 1; },
    onAfterFold: () => { calls.onAfterFold += 1; },
    onFoldSummary: () => { calls.onFoldSummary += 1; },
  };
  const full = {
    finalGuard: async () => { calls.finalGuard += 1; return { action: "accept" }; },
    deliverables: [{ name: "always", check: async () => { calls.check += 1; return true; } }],
    retry: { attempts: 1, sleepImpl: async () => {} },
    reflection: { enabled: false, onReflection: () => { calls.onReflection += 1; } },
    diagnostics: { error: () => { calls.error += 1; } },
    context: { budgetTokens: 1000, strategy: "sliding-window", ...hooks },
  };

  // 直连：全部给对 ⇒ 不抛，且 guard / deliverables 判据真的被调用（证明「接受」不是「没接线」）。
  const direct = await runDirect(full);
  assert.equal(direct.termination.reason, "end_turn");
  assert.equal(calls.finalGuard, 1, "finalGuard 旧位置必须照旧被调用");
  assert.equal(calls.check, 1, "deliverables[].check 旧位置必须照旧被调用");

  // 装配口：policy 侧给同样的回调 ⇒ 不抛（装配口的 `context` 形状照旧合法）。
  const assemblyOk = await assemblyError({ context: { budgetTokens: 1000, ...hooks } });
  assert.equal(assemblyOk, null, `装配口：合法回调不得抛（实测 ${assemblyOk?.message}）`);

  // 省略全部 ⇒ 同样不抛（缺省不报错）。
  assert.equal(await directError(), null);
});

test("D② 承载回调的字段给错就启动即抛：反例清单逐条（含 null / 数字 / 对象 / 字符串）", async () => {
  const cases = [
    // 顶层 `onFoldSummary` 沿用 #470-D 的既有文案（装配口今天逐字如此，零破坏），其余同范式。
    // `context.onFoldSummary` 刻意**不在**规则表里：引擎从不从 `context` 读它（契约明写「会被忽略」），
    // 给一个被忽略的键校形状只会反过来暗示它有用。
    [{ onFoldSummary: null }, "assembly policy option onFoldSummary must be a function (or omitted)"],
    [{ onFoldSummary: {} }, "assembly policy option onFoldSummary must be a function (or omitted)"],
    [{ finalGuard: null }, "finalGuard must be a function (or omitted)"],
    [{ finalGuard: "accept" }, "finalGuard must be a function (or omitted)"],
    [{ retry: { sleepImpl: null } }, "retry.sleepImpl must be a function (or omitted)"],
    [{ retry: { sleepImpl: {} } }, "retry.sleepImpl must be a function (or omitted)"],
    [{ reflection: { enabled: false, onReflection: 1 } }, "reflection.onReflection must be a function (or omitted)"],
    [{ reflection: { enabled: false, onReflection: null } }, "reflection.onReflection must be a function (or omitted)"],
    [{ diagnostics: { error: [] } }, "diagnostics.error must be a function (or omitted)"],
    [{ context: { onBeforeFold: null } }, "context.onBeforeFold must be a function (or omitted)"],
    [{ context: { onAfterFold: 0 } }, "context.onAfterFold must be a function (or omitted)"],
  ];
  for (const [bad, message] of cases) {
    const label = Object.keys(bad)[0];
    const direct = await directError(bad);
    assert.equal(direct?.message, message, `${label}: 直连文案`);
    const assembly = await assemblyError(bad);
    assert.equal(assembly?.message, message, `${label}: 两条路线必须同一句`);
  }
});

// ================================================================ E. 可达性（语义相不越权）
test("E 取值校验仍由 orchestrator 承担，两条路线都汇到那里（闸口抛的错一定带 via）", async () => {
  const cases = [
    ["maxRounds", { maxRounds: 0 }, "maxRounds must be a finite positive integer"],
    ["deliverables", { deliverables: [{ name: "x" }] }, "deliverables[0].check must be a function"],
    ["partialPersistence", { partialPersistence: true }, "partialPersistence requires stream: true"],
    ["persistence", { persistence: "maybe" }, 'persistence must be "none" or "required"'],
  ];
  for (const [label, bad, message] of cases) {
    const direct = await directError(bad);
    assert.equal(direct?.message, message, `${label}: 直连`);
    // `via` 缺席 = 不是语义相闸口抛的（闸口抛的错必带标签）⇒ 这条规则仍然归 orchestrator。
    assert.equal(direct?.via, undefined, `${label}: 不该由闸口负责`);

    // 装配口路线：这些键走**显式选项**（`deliverables` 不在装配 policy 白名单里，
    // 那条边界本身由 `ASSEMBLY_POLICY_OPTION_NAMES` 负责，不在本单范围内）。
    const assembly = await runToolLoop({
      assemblyPort: makePort(),
      initialUserMessage: "go",
      completion: false,
      ...bad,
    }).then(() => null, (caught) => caught);
    assert.equal(assembly?.message, message, `${label}: 装配口也必须到同一个校验点`);
    assert.equal(assembly?.via, undefined, `${label}: 装配口也不该由闸口负责`);
  }

  // `policy` 侧同样汇到 orchestrator（`maxRounds` 是 policy 允许的键）。
  const policyError = await runToolLoop({
    assemblyPort: makePort({ maxRounds: 0 }),
    initialUserMessage: "go",
    completion: false,
  }).then(() => null, (caught) => caught);
  assert.equal(policyError.message, "maxRounds must be a finite positive integer");
  assert.equal(policyError.via, undefined);
});
