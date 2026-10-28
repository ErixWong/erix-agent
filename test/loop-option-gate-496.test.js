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
//      合法键 ⇒ 都不抛；宿主业务键 ⇒ 两条路线都不抛；`context_unknown_option` 事件只在装配口有（直连从不发）（#469 的回归）。
//   D. 回调形状：语义相管 **7** 个承载宿主回调的字段（`finalGuard` / `retry.sleepImpl` /
//      `reflection.onReflection` / `diagnostics.error` / 顶层 `onFoldSummary` / `context.onBeforeFold` /
//      `context.onAfterFold`），另加闸口之外的 `deliverables[].check`；给错则启动即抛。给对时**逐格分开说**：
//      六格在 D① 里**真跑一次**并断言投递次数（`context.onBeforeFold` / `context.onAfterFold` /
//      顶层 `onFoldSummary` / `retry.sleepImpl` / `finalGuard` / `deliverables[].check`），
//      `diagnostics.error` 用「投递失败落持久化账本」这个真条件触发并断言；
//      `reflection.onReflection` 的投递条件是 judge 扩轮（要跑到 nearLimit），本格只把它当**形状正例**，
//      **不声称**被断言过（以前那个计数器写了不断言，等于装样子）。
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
//   · `assertSemanticOptionValues` 的 `throw` 降级成 `return` ⇒ B 段全部反例红、A 段次序用例红；
//   · 语义相挪到**合并之前**（只看 assembled 值）⇒ A③ 与 B 段「policy 给对值 + 显式给错值」逐条红；
//   · `collectSemanticOptionProblems` 把 `context: null` 也当错误 ⇒ `B(null)` 红；
//   · `orchestrator.js` 的 `compactOptions` 透传名单里删掉 `"onBeforeFold"` ⇒ D① 的
//     `context.onBeforeFold` 那格红（这是本单新加抛错面的投递路径，必须有锁）。
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
import { createSlidingWindowStrategy } from "../src/compact/sliding-window.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect as sharedRunDirect, withSeed } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const GATE_MESSAGE = /unknown assembly policy context option|must be a function \(or omitted\)|must be an object|must be a positive integer/u;

/** 一次成功的 fake provider（每个 run 一份，脚本不共享）。 */
const providerOnce = () => createFakeProvider(DONE);

/** 直连路线：只带需要被测的那几个选项，其余给到「能跑完一轮」的最小合法集。 */
function runDirect(extra = {}) {
  return sharedRunDirect({
    provider: providerOnce(),
    executeTool: async () => "ok",
    seed: "go",
    ...extra,
    // #498 S3 A23a：并进**同一个** `config` 容器，且写在 `...extra` 之后（否则 `extra.config`
    // 会静默顶掉这一行——对象字面量重复键，后者胜）。
    config: { ...(extra.config ?? {}), run: { ...(extra.config?.run ?? {}), completion: false } },
  });
}

/** 直连路线的「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => runDirect(extra).then(() => null, (error) => error);

/**
 * 一条**必然折叠**的直连 run（issue #496 必改4：旧位置投递必须有真跑的夹具）。
 *
 * 与 `test/loop-on-fold-summary.test.js` 的 `runFolding` 同形：预算压到 300 token + `keepRounds: 1`，
 * 先 6 发工具调用把上下文撑过预算，再收尾 ⇒ `sliding-window`（零 LLM）机械折叠必然发生。
 * 首步是一次**可重试**失败，用来让 `retry.sleepImpl` 也真的被走一遍。
 */
const FOLD_TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

function foldingProvider() {
  const retryable = new Error("temporary failure");
  retryable.retryable = true;
  const toolTurns = Array.from({ length: 6 }, (_unused, index) => ({
    content: [{
      type: "tool_use",
      id: `tu_${index + 1}`,
      name: "echo",
      input: { text: `R${index + 1}_${"填充".repeat(300)}` },
    }],
    stopReason: "tool_use",
  }));
  return createFakeProvider([
    { throw: retryable },
    ...toolTurns,
    { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
  ]);
}

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
  // #498 S3 A2b：种子的规位家是 `config.input.initialUserMessage`，而**调用级 `config` 会整棵覆盖
  // `policy.config`**（既有合并规则，不是新规矩）。所以种子必须放进 policy 自己的配置树——写成显式
  // `config` 会把本格要测的那个坏值一起顶掉，于是「装配口也必须抛」变成假绿。
  const policyInput = policy.config?.input;
  const seeded = {
    ...policy,
    config: {
      ...(policy.config ?? {}),
      input: { ...(policyInput ?? {}), initialUserMessage: "go" },
    },
  };
  try {
    makePort(seeded);
  } catch (error) {
    return Promise.resolve(error);
  }
  // #498 S3 A23a：默认的 `completion: false` 从扁平拼写搬进规位家 `config.run.completion`。
  // 这里有一个**本文件特有**的陷阱：调用级 `config` 会**整棵覆盖** `policy.config`（既有合并规则），
  // 所以「往调用级 config 里补一个默认值」等于把 policy 侧那棵配置树整个顶掉——B 段那些
  // 「policy 侧坏值必须抛」的反例格会变成假绿。于是默认值的落点按 explicit 的形状分三种：
  //   · `explicit.config` 是对象 ⇒ 并进**同一个** `config` 容器（不造第二个键）；
  //   · `explicit.config` 省略 ⇒ 默认值并进 **policy 侧**那棵树（调用级不出现 `config` 键）；
  //   · `explicit.config` / `.run` 是**非对象**（本文件的形状拒绝格）⇒ 原样透传，什么都不补。
  const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const explicitConfig = explicit.config;
  const runIsMergeable = explicitConfig === undefined || (isPlainObject(explicitConfig)
    && (explicitConfig.run === undefined || isPlainObject(explicitConfig.run)));
  let port = makePort(seeded);
  const callOptions = { ...explicit };
  if (!runIsMergeable) {
    // 形状拒绝格：原样透传（补任何东西都会把那一格的拒绝换成另一条红）。
  } else if (explicitConfig !== undefined) {
    callOptions.config = {
      ...explicitConfig,
      run: { ...explicitConfig.run, completion: false },
    };
  } else if (isPlainObject(seeded.config) && (seeded.config.run === undefined || isPlainObject(seeded.config.run))) {
    port = makePort({ ...seeded, config: { ...seeded.config, run: { ...seeded.config.run, completion: false } } });
  }
  return runToolLoop({ assemblyPort: port, ...callOptions })
    .then(() => null, (error) => error);
};

/**
 * 闸口规则表（正例 / 反例一一对应）。`bad` 与 `good` 是**同一个字段**的错值与对值——
 * 只给反例会让「闸口把整个字段都拒了」这种过严也算绿。
 */
const GATE_RULES = [
  // #498 S3: the flat `context` option is retired, so every `context` cell below writes the nested
  // spelling (`config.folding.context`). The expansion phase writes it back to
  // `effectiveOptions.context`, which is why the semantic-phase rules and their wording are unchanged.
  {
    id: "context-shape",
    bad: { config: { folding: { context: "not-an-object" } } },
    good: { config: { folding: { context: { budgetTokens: 1000 } } } },
    message: "context must be an object",
  },
  {
    id: "context-knob-name",
    bad: { config: { folding: { context: { budgetTokens: 1000, summarizeBudgetMs: 5 } } } },
    good: { config: { folding: { context: { budgetTokens: 1000, summarizerBudgetMs: 5 } } } },
    message: 'unknown assembly policy context option: "summarizeBudgetMs"',
  },
  {
    id: "context-knob-value",
    bad: { config: { folding: { context: { maxSummaryTokens: 0 } } } },
    good: { config: { folding: { context: { maxSummaryTokens: 900 } } } },
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
    bad: { config: { folding: { context: { onBeforeFold: "hooks" } } } },
    // The positive case stays **data-only** for the same reason as the `retry.sleepImpl` cell above: a
    // function inside `config` is rejected by the namespace gate (#498 S4a constraint 4). The function
    // carrier's canonical home is `capabilities.hooks.onBeforeFold` (covered in D① below).
    good: { config: { folding: { context: { budgetTokens: 1000 } } } },
    message: "context.onBeforeFold must be a function (or omitted)",
  },
  {
    id: "context.onAfterFold-shape",
    bad: { config: { folding: { context: { onAfterFold: {} } } } },
    good: { config: { folding: { context: { budgetTokens: 1000 } } } },
    message: "context.onAfterFold must be a function (or omitted)",
  },
  {
    id: "finalGuard-shape",
    bad: { finalGuard: true },
    good: { finalGuard: async () => ({ action: "accept" }) },
    message: "finalGuard must be a function (or omitted)",
  },
  {
    // #498 S3: `retry` moved to `config.timing.retry` (data keys) — the flat spelling is rejected one
    // phase earlier by the name gate, so the semantic-phase cell uses the nested spelling.
    id: "timing.retry.sleepImpl-shape",
    bad: { config: { timing: { retry: { attempts: 1, sleepImpl: 10 } } } },
    // The positive case is data-only: a function inside `config` is rejected by the namespace gate
    // (#498 S4a constraint 4), which is a *different* rule than this cell's. The function carrier's
    // canonical home (`capabilities.ports.sleepImpl`) is covered in
    // `test/loop-capabilities-ports-hooks-498s4c.test.js`.
    good: { config: { timing: { retry: { attempts: 1 } } } },
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
  const error = await runToolLoop(withSeed({
    assemblyPort: port,
    initialUserMessage: "go",
    // 语义相会拒的值（`context` 不是对象）与顶层未知键同时存在 ⇒ 必须先报未知键。
    config: { folding: { context: "not-an-object" } },
    modelConfig: { resolve: async () => { resolved += 1; return {}; } },
    bogusKey: 1,
  })).then(() => null, (caught) => caught);
  assert.equal(error.message, 'unknown runToolLoop option: "bogusKey"');
  assert.equal(error.via, undefined, "预检相的错不贴路线标签（它不是闸口抛的）");
  assert.deepEqual(reads, [], "预检相不得读取端口");
  assert.equal(resolved, 0, "预检相不得调用 modelConfig.resolve");
});

test("A② 语义相晚于 assemblyPortOptions、早于能力缺失检查（配置错不被「缺 provider」盖掉）", async () => {
  // 对照组：同样的缺 provider/executeTool，但配置合法 ⇒ 报的是能力缺失。
  const capabilityError = await runToolLoop(withSeed({ initialUserMessage: "go" })).then(() => null, (caught) => caught);
  assert.equal(
    capabilityError.message,
    "assembly port is missing methods: provider.chat or provider.chatStream, executeTool",
  );

  // 语义相违规 + 缺能力 ⇒ 必须先报语义相（它在能力检查之前）。
  const gateError = await runToolLoop(withSeed({
    initialUserMessage: "go",
    config: { folding: { context: { summarizeBudgetMs: 5 } } },
  })).then(() => null, (caught) => caught);
  assert.equal(gateError.message, 'unknown assembly policy context option: "summarizeBudgetMs"');
  assert.equal(gateError.via, "direct");
});

test("A③ 语义相吃的是**合并后**的表示：装配口的合法值 + 显式 undefined 不覆盖", async () => {
  // 装配口给合法 `maxSummaryTokens`（正例，防过严）：显式 `context: undefined` 不得把它抹掉。
  const port = makePort({ context: { strategy: "fold-llm", maxSummaryTokens: 900 } });
  const result = await runToolLoop(withSeed({
    assemblyPort: port,
    initialUserMessage: "go",
    config: { folding: { context: undefined }, run: { completion: false } },
  }));
  assert.equal(result.termination.reason, "end_turn");

  // 显式值覆盖装配值时，语义相校的是**覆盖后**的那份（装配口合法、显式拼错 ⇒ 抛）。
  const overridden = await runToolLoop(withSeed({
    assemblyPort: makePort({ context: { budgetTokens: 1000 } }),
    initialUserMessage: "go",
    config: { folding: { context: { budgetTokens: 1000, summarizeBudgetMs: 5 } }, run: { completion: false } },
  })).then(() => null, (caught) => caught);
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

    // ── 合并后：装配口给**对值**、显式选项给**错值** ⇒ 必须抛。
    // 这条锁的是「语义相吃的是**合并后**的表示」：闸口若跑在合并之前（只看 assembled 值），
    // 每条规则这里都会变成 null。以前这条性质只有 A③ 一格独锁，现在两条路线都有锁。
    const overridden = await assemblyError(rule.good, rule.bad);
    assert.ok(overridden instanceof TypeError, `${rule.id}: 显式覆盖 policy 值后必须被校，实测 ${String(overridden)}`);
    assert.equal(overridden.message, rule.message, `${rule.id}: 覆盖后的文案必须与直连同一句`);
    assert.equal(overridden.via, "assembly", `${rule.id}: 覆盖后的路线标签`);
  }
});

test("B 多问题合并：同一次调用里的多个问题按规则顺序用「; 」连成一条 TypeError", async () => {
  const error = await directError({
    config: { folding: { context: { summarizeBudgetMs: 5, maxSummaryTokens: 0, onBeforeFold: "hooks" } } },
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
    const direct = await directError({ config: { folding: { context: { [typo]: 1024 } } } });
    assert.equal(direct?.message, `unknown assembly policy context option: ${JSON.stringify(typo)}`, `直连 ${typo}`);
    const assembly = await assemblyError({ context: { [typo]: 1024 } });
    assert.equal(assembly?.message, direct?.message, `两条路线 ${typo} 必须同一句`);
  }
});

test("C② 每个旋钮的合法值都在两条路线放行；非法值（0 / 负数 / 小数 / 字符串 / null）都抛", async () => {
  for (const name of FOLD_SUMMARIZER_CAP_NAMES) {
    const ok = await directError({ config: { folding: { context: { [name]: 1024 } } } });
    assert.equal(ok, null, `${name}=1024 必须放行（实测 ${ok?.message}）`);
    for (const value of [0, -1, 1.5, "1024", null]) {
      const expected = `${name} must be a positive integer`;
      const direct = await directError({ config: { folding: { context: { [name]: value } } } });
      assert.equal(direct?.message, expected, `${name}=${String(value)} 直连`);
      const assembly = await assemblyError({ context: { [name]: value } });
      assert.equal(assembly?.message, expected, `${name}=${String(value)} 装配口`);
    }
  }
});

test("B(null) `context: null` 逐字等于省略：两条路线都不抛，且直连结果与省略逐字相同", async () => {
  // 契约明写「省略或 `null` = 没配」。这条放行口以前**零断言**（把它改成抛错，全量测试 0 红），
  // 而它是本单唯一一处「非函数 / 非对象值仍放行」的例外，最容易被下一轮「收紧 context 形状」静默破掉。
  const omitted = await runDirect();
  // #498 S3: the flat `context` is retired; the nested spelling carries the same "null = omitted"
  // meaning (expansion writes `effectiveOptions.context = null`, the semantic phase skips it).
  const nulled = await runDirect({ config: { folding: { context: null } } });
  assert.equal(nulled.termination.reason, omitted.termination.reason, "`context: null` 必须与省略同一终局");
  assert.equal(nulled.termination.reason, "end_turn");
  assert.equal(nulled.rounds, omitted.rounds, "`context: null` 必须与省略同轮数");
  assert.equal(nulled.finalText, omitted.finalText, "`context: null` 必须与省略同一终文");
  assert.deepEqual(
    nulled.compactionStats ?? [],
    omitted.compactionStats ?? [],
    "`context: null` 必须与省略同一压缩记录（两条都是「没配」）",
  );

  // 装配口：`policy.context: null` 同样放行（构造期不抛）。
  assert.doesNotThrow(() => makePort({ context: null }), "`policy.context: null` 不得在构造期抛");
  const viaPort = await runToolLoop(withSeed({
    assemblyPort: makePort({ context: null }),
    initialUserMessage: "go",
    config: { run: { completion: false } },
  }));
  assert.equal(viaPort.termination.reason, "end_turn", "装配口 `context: null` 的 run 必须照旧跑完");
});

test("C③ 宿主业务键照旧放行（#469 回归）：两条路线都不抛；事件只有装配口路线发（直连从不发）", async () => {
  // 直连侧：业务键不是旋钮家族 ⇒ 语义相不拦；引擎也不发事件（没有 emit 端口），但绝不抛。
  const directOk = await directError({
    config: { folding: { context: { budgetTokens: 1000, workspaceName: "fde-station", summaryStyle: "brief" } } },
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

// ================================================================ D. 回调形状（旧位置投递 + 新规则）
test("D① 承载宿主回调的字段：省略 = 不订阅，给对就**真的被投递**（折叠 / 重试 / 终局 / 交付物四处各断言一次，外加投递失败落 `diagnostics.error`）", async () => {
  // 这一格以前只断言 `finalGuard` 与 `deliverables[].check`，其余 5 个计数器**写了不断言** ⇒
  // 删掉 orchestrator 里 `context.onBeforeFold` 的透传，全量测试 0 红。现在改成**真跑一次折叠**：
  // `budgetTokens: 300` + `keepRounds: 1` + `sliding-window`（零 LLM）⇒ 6 发工具调用后必然折叠，
  // `context.onBeforeFold` / `context.onAfterFold` / 顶层 `onFoldSummary` 三格都必须 >= 1。
  // 另两格**不在这里装样子**（它们的触发条件不在本格射程内，硬塞只会再造一格假绿）：
  //   · `reflection.onReflection` 只在 judge 扩轮时调用（要跑到 nearLimit + reflection 扩展），
  //     本格给的是一个**不被计数**的真函数，只用来证明「形状对 ⇒ 不抛」；
  //   · `diagnostics.error` 由本格的真条件触发：`onFoldSummary` 抱错 ⇒ `persistence_error{port:"notes"}`
  //     ⇒ `diagnostics.error` 真的被调一次（不是空计数器）。
  const calls = { onBeforeFold: 0, onAfterFold: 0, onFoldSummary: 0, finalGuard: 0, check: 0, sleepImpl: 0, error: 0 };
  const sleeps = [];
  const persistenceEvents = [];

  const direct = await runDirect({
    provider: foldingProvider(),
    tools: FOLD_TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    maxRounds: 20,
    wrapup: false,
    stallDetection: false,
    finalGuard: async () => { calls.finalGuard += 1; return { action: "accept" }; },
    deliverables: [{ name: "always", check: async () => { calls.check += 1; return true; } }],
    // 首步是一次可重试失败 ⇒ 重试闸口必须真的走一遍 `sleepImpl`（否则这一格又是死计数器）。
    config: { folding: { context: {
      budgetTokens: 300,
      keepRounds: 1,
    } }, timing: { retry: { attempts: 2 } } },
    // #498 S3: `context.strategy` (an **object**) and `context.onBeforeFold` / `.onAfterFold`
    // (functions) are behaviour carriers — their canonical homes are `capabilities.ports.strategy`
    // and `capabilities.hooks.*`. The config namespace rejects them by name, so the split here is by
    // value shape, and the counters below still prove the old in-shell slots are really delivered.
    capabilities: {
      ports: {
        sleepImpl: async (ms) => { calls.sleepImpl += 1; sleeps.push(ms); },
        strategy: createSlidingWindowStrategy({ keepRounds: 1 }),
      },
      hooks: {
        onBeforeFold: () => { calls.onBeforeFold += 1; },
        onAfterFold: () => { calls.onAfterFold += 1; },
      },
    },
    reflection: { enabled: false, onReflection: () => {} },
    diagnostics: { error: (event) => { calls.error += 1; persistenceEvents.push(event); } },
    // 钩子**先计数再抛**：投递真的发生了（计数 >= 1），失败走持久化账本（`diagnostics.error` 真的被调）。
    onFoldSummary: () => { calls.onFoldSummary += 1; throw new Error("宿主归档器炸了"); },
  });

  // 前提：这条路径确实折叠了 —— 否则下面三格只是在测空气。
  assert.ok(
    (direct.compactionStats ?? []).some((stat) => stat.compacted === true),
    `前提：这条路径必须真的折叠，实测 ${JSON.stringify(direct.compactionStats ?? [])}`,
  );
  assert.equal(direct.termination.reason, "end_turn", "钩子抱错不得改写终局");

  // 旧位置投递：六个计数器各断言一次（这才是「行为逐字不变」的可证伪面）。
  assert.ok(calls.onBeforeFold >= 1, `context.onBeforeFold 必须被投递，实测 ${calls.onBeforeFold} 次`);
  assert.ok(calls.onAfterFold >= 1, `context.onAfterFold 必须被投递，实测 ${calls.onAfterFold} 次`);
  assert.equal(calls.onAfterFold, calls.onBeforeFold, "同一次折叠的 before/after 必须成对（不多不少）");
  assert.ok(calls.onFoldSummary >= 1, `顶层 onFoldSummary 必须被投递，实测 ${calls.onFoldSummary} 次`);
  assert.equal(calls.sleepImpl, 1, `retry.sleepImpl 必须被重试闸口调一次，实测 ${calls.sleepImpl} 次`);
  assert.deepEqual(sleeps, [1500], "重试退避起点沿用既有口径");
  assert.equal(calls.finalGuard, 1, "finalGuard 旧位置必须照旧被调用");
  assert.equal(calls.check, 1, "deliverables[].check 旧位置必须照旧被调用");
  assert.ok(calls.error >= 1, `投递失败必须落到 diagnostics.error，实测 ${calls.error} 次`);
  assert.ok(
    persistenceEvents.every((event) => event.port === "notes" && event.operation === "onFoldSummary"),
    `diagnostics.error 收到的必须是 onFoldSummary 的持久化事件，实测 ${JSON.stringify(persistenceEvents)}`,
  );

  // 装配口：policy 侧给同样的回调 ⇒ 不抛（装配口的 `context` 形状照旧合法）。
  const assemblyOk = await assemblyError({ capabilities: { hooks: { onBeforeFold: () => {}, onAfterFold: () => {} } },
    config: { folding: { context: {
      budgetTokens: 1000,
                } } },
    onFoldSummary: () => {},
  });
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
    // #498 S3: `retry` is `config.timing.retry` now; the flat spelling is rejected one phase earlier.
    [{ config: { timing: { retry: { sleepImpl: null } } } }, "retry.sleepImpl must be a function (or omitted)"],
    [{ config: { timing: { retry: { sleepImpl: {} } } } }, "retry.sleepImpl must be a function (or omitted)"],
    [{ reflection: { enabled: false, onReflection: 1 } }, "reflection.onReflection must be a function (or omitted)"],
    [{ reflection: { enabled: false, onReflection: null } }, "reflection.onReflection must be a function (or omitted)"],
    [{ diagnostics: { error: [] } }, "diagnostics.error must be a function (or omitted)"],
    [{ config: { folding: { context: { onBeforeFold: null } } } }, "context.onBeforeFold must be a function (or omitted)"],
    [{ config: { folding: { context: { onAfterFold: 0 } } } }, "context.onAfterFold must be a function (or omitted)"],
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
    const assembly = await runToolLoop(withSeed({
      assemblyPort: makePort(),
      initialUserMessage: "go",
      config: { run: { completion: false } },
      ...bad,
    })).then(() => null, (caught) => caught);
    assert.equal(assembly?.message, message, `${label}: 装配口也必须到同一个校验点`);
    assert.equal(assembly?.via, undefined, `${label}: 装配口也不该由闸口负责`);
  }

  // `policy` 侧同样汇到 orchestrator（`maxRounds` 是 policy 允许的键）。
  const policyError = await runToolLoop(withSeed({
    assemblyPort: makePort({ maxRounds: 0 }),
    initialUserMessage: "go",
    config: { run: { completion: false } },
  })).then(() => null, (caught) => caught);
  assert.equal(policyError.message, "maxRounds must be a finite positive integer");
  assert.equal(policyError.via, undefined);
});
