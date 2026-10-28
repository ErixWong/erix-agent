// issue #498（S3）—— `folding` 组的**垂直切片**（第二片）：删掉顶层扁平 `context` /
// `toolResultTtl` / `toolResultFoldMinTokens`，它们的规范之家是 `config.folding.*`。
//
// 本文件钉四件事（其余在本刀改过的既有用例里，见交付报告）：
//
//   P. **旧名反向拒绝钉**（三格，一键一格）：顶层再写这三个键 ⇒ **当场拒**，且文案必须指向新家。
//      这条是宿主从 0.26 升级到 0.28 时唯一的救命索——「未知选项 + 接受名单」会让宿主自己猜它
//      搬去了哪。⚠ 三格都用**逐字相等**断言（不是 `match`）。
//   Q. **两站文案**（本片修掉的那条缺陷）：`context` 是**混装壳**——同时容得下数据成员与函数成员，
//      而 `config` 只装数据。所以顶层 `context` 被拒时，文案必须**一次**把两站都点名：
//      数据 ⇒ `config.folding.context.<leaf>`，函数 ⇒ `capabilities.hooks.<name>`。
//      只指一站 = 宿主照做再撞第二次，第二次的文案才告诉他函数去哪（#498 S3 收尾实测到的真缺陷）。
//      实现是通用的（从 `CAPABILITY_SLOT_DESTINATIONS` 派生「这个壳有没有行为成员」），所以
//      `retry` 也自动带上 `capabilities.ports.sleepImpl` —— Q2 把这条通用性钉住。
//   S. **schema 自检**：`configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES) === []`（三向闭合）。
//   R. **读侧不变的机制证据**：三个键写在新家之后，展开相会把它们逐字写回
//      `effectiveOptions.<扁平名>`——这正是「删了顶层键、引擎读侧一行都不用改」的原因。
//      三个键各一条**真 run**（`toolResultTtl` / `toolResultFoldMinTokens` 真的让工具结果被折叠、
//      `context` 真的驱动压缩）。
//
// 为什么单独一个文件：这三条是「迁移完成」与「只删了键」的分界线。放在任何既有用例里都会被
// 那一格的叙事淹没，而本刀最容易出的错正是「删了键但没给宿主指路」。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configSchemaSelfCheck,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  assertRunToolLoopOptionNames,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 直连路线的最小合法 run（一次 end_turn 就结束）。 */
function runDirect(extra = {}) {
  return runToolLoop({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    ...extra,
  });
}

/** 直连路线「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => runDirect(extra).then(() => null, (error) => error);

/** 名称闸口的原文（不跑 run，直接问闸口——这条错必须在任何端口被读之前出现）。 */
function gateMessage(optionName) {
  try {
    assertRunToolLoopOptionNames({ [optionName]: 1 });
  } catch (error) {
    return error.message;
  }
  throw new Error(`名称闸口没有拒绝 ${optionName}`);
}

// ================================================================ P. 旧名反向拒绝（三格，一键一格）
//
// 每格两段：① 逐字相等的文案（含新家路径）；② 同一个值写在新家里必须**不抛**——
// 「拒旧名」与「收新家」必须同时成立，否则这条钉子只是在说「我把键弄丢了」。

test("P1 顶层 context ⇒ 当场拒，文案逐字指向 config.folding.context", async () => {
  const error = await directError({ context: { budgetTokens: 1000 } });
  assert.equal(error instanceof TypeError, true, "旧名必须在名称闸口抛 TypeError（不是静默忽略）");
  assert.equal(
    error.message,
    'unknown runToolLoop option: "context" (its canonical home is config.folding.context;'
      + " the flat spelling is rejected)"
      + " — this shell holds both data and functions: write data as config.folding.context.<leaf>,"
      + " and behaviour members as capabilities.hooks.<name>"
      + " (onBeforeFold / onAfterFold / stubFor / protectedMessage / recoveryHint)"
      + " or capabilities.ports.strategy",
    "文案必须一次点名**两站**——少了 config.folding.context 宿主找不到数据之家，"
      + "少了 capabilities.hooks.* 宿主把函数写进 config 会撞第二次",
  );
  // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（读侧不变）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { folding: { context: { budgetTokens: 1000 } } },
  });
  assert.deepEqual(
    effectiveOptions.context,
    { budgetTokens: 1000 },
    "config.folding.context 必须写回 effectiveOptions.context",
  );
});

test("P2 顶层 toolResultTtl ⇒ 当场拒，文案逐字指向 config.folding.toolResultTtl", async () => {
  const error = await directError({ toolResultTtl: 2 });
  assert.equal(error instanceof TypeError, true);
  assert.equal(
    error.message,
    'unknown runToolLoop option: "toolResultTtl" (its canonical home is config.folding.toolResultTtl;'
      + " the flat spelling is rejected)",
    "文案必须点名新家——少了 config.folding.toolResultTtl，升级的宿主只能自己猜",
  );
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { folding: { toolResultTtl: 2 } },
  });
  assert.equal(effectiveOptions.toolResultTtl, 2, "config.folding.toolResultTtl 必须写回扁平名");
});

test("P3 顶层 toolResultFoldMinTokens ⇒ 当场拒，文案逐字指向 config.folding.toolResultFoldMinTokens", async () => {
  const error = await directError({ toolResultFoldMinTokens: 10 });
  assert.equal(error instanceof TypeError, true);
  assert.equal(
    error.message,
    'unknown runToolLoop option: "toolResultFoldMinTokens"'
      + " (its canonical home is config.folding.toolResultFoldMinTokens; the flat spelling is rejected)",
  );
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { folding: { toolResultFoldMinTokens: 10 } },
  });
  assert.equal(
    effectiveOptions.toolResultFoldMinTokens,
    10,
    "config.folding.toolResultFoldMinTokens 必须写回扁平名",
  );
});

// ================================================================ Q. 混装壳：一次点名两站（本片修掉的缺陷）
//
// 病根：`configPathForOption("context")` 回答的是「**整个键**搬去了哪」，而 `context` 里混着两类
// 成员——数据（`budgetTokens`）与行为（`onBeforeFold` / `strategy` 对象）。只回一句
// 「canonical home is config.folding.context」等于把宿主送到一个**只收数据**的家：函数照做会撞
// 第二次（`config.folding.context.onBeforeFold is not accepted … capabilities.hooks.onBeforeFold`）。
// 那条路要走两步才到得了目的地，而升级宿主唯一的线索就是这两句话。

test("Q1 顶层 context 的拒绝文案同时含两站：数据 config.folding.context.<leaf> / 函数 capabilities.hooks.*", () => {
  const message = gateMessage("context");
  assert.match(message, /its canonical home is config\.folding\.context/u, "第一站：数据之家");
  assert.match(
    message,
    /write data as config\.folding\.context\.<leaf>/u,
    "第一站必须说到**叶子**层级（`config.folding.context` 只是壳，宿主要知道叶子写在哪）",
  );
  assert.match(message, /capabilities\.hooks\./u, "第二站：函数之家（少这一句 = 宿主撞第二次）");
  // 五个 `context` 壳内的回调一个都不许漏（从 schema 派生，不是手抄名单）。
  for (const hook of ["onBeforeFold", "onAfterFold", "stubFor", "protectedMessage", "recoveryHint"]) {
    assert.match(message, new RegExp(`\\b${hook}\\b`, "u"), `文案必须点名 capabilities.hooks.${hook}`);
  }
  // `context.strategy` 是**对象**形态的行为载体 ⇒ 它也有第二站（`capabilities.ports.strategy`）。
  assert.match(message, /capabilities\.ports\.strategy/u, "对象形态的 strategy 也必须被指到端口位");
});

test("Q2 两站文案是**通用**的（不是为 context 写的特例）：retry 壳同样点名 capabilities.ports.sleepImpl", () => {
  // `retry` 也是混装壳（数据 `attempts` + 行为 `sleepImpl`），S3 第一片把它搬去了 `config.timing.retry`。
  // 这条同时是「实现通用」的机器判据：如果文案是给 `context` 写的 if-else，这里会缺第二站。
  const message = gateMessage("retry");
  assert.match(message, /its canonical home is config\.timing\.retry/u);
  assert.match(message, /write data as config\.timing\.retry\.<leaf>/u);
  assert.match(message, /capabilities\.ports\.sleepImpl/u, "retry 的第二站必须被点名");
  // 反面：**不混装**的壳不该被塞第二站（`timeoutMs` 全是数据 ⇒ 一句话就够，多说不等于更清楚）。
  const plain = gateMessage("timeoutMs");
  assert.equal(
    plain,
    'unknown runToolLoop option: "timeoutMs" (its canonical home is config.timing.timeoutMs;'
      + " the flat spelling is rejected)",
    "纯数据键的文案必须逐字维持原样（宿主与既有测试都依赖那句原文）",
  );
});

test("Q3 两站的目的地都是真的：照着文案写，两条路都不抛", async () => {
  // 第一站：数据。
  const data = await runDirect({ config: { folding: { context: { budgetTokens: 1000 } } } });
  assert.equal(data.termination.reason, "end_turn");
  // 第二站：函数（文案里点名的五个回调 + 端口位）。
  const hooks = Object.fromEntries(
    ["onBeforeFold", "onAfterFold", "stubFor", "protectedMessage", "recoveryHint"].map((name) => [name, () => {}]),
  );
  const fn = await runDirect({ capabilities: { hooks } });
  assert.equal(fn.termination.reason, "end_turn", "文案指的第二站必须真的收得下函数");
});

// 三个旧名**真的**不在白名单里了（不是「拒了但又留着」）。
test("P4 三个旧名都不在白名单里，而 config.folding 的三个叶子都在 schema 里", () => {
  for (const name of ["context", "toolResultTtl", "toolResultFoldMinTokens"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(name), false, `${name} 必须已经离开顶层白名单`);
  }
  // 新家还在（本刀删的是**写法**，不是叶子）：否则 P1–P3 的文案会指向一个不存在的组。
  assert.deepEqual(
    [...CONFIG_NAMESPACE_SCHEMA.folding].sort(),
    ["context", "toolResultFoldMinTokens", "toolResultTtl"],
    "config.folding 组必须原样保留三个叶子（它就是新家）",
  );
});

// ================================================================ S. schema 自检（三向闭合）
test("S1 configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES) === []", () => {
  assert.deepEqual(
    configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES),
    [],
    "白名单必须被「配置面 / 能力面 / 容器」恰好切一遍——漏分类、重复、容器缺登记都算红",
  );
});

// ================================================================ R. 读侧不变（真 run 的行为证据）
//
// 「引擎读的是 `effectiveOptions.<扁平名>`」这句话必须用行为证明，不能靠读代码。

test("R1 context 经新家生效：小预算真的驱动压缩（真 run）", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "one", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "two", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "go",
    executeTool: async () => `result ${"x".repeat(400)}`,
    maxRounds: 3,
    completion: false,
    wrapup: false,
    config: { folding: { context: { budgetTokens: 200, keepRounds: 0, strategy: "sliding-window" } } },
  });
  assert.ok(
    (result.compactionStats ?? []).some((stat) => stat.compacted === true),
    `config.folding.context 的预算必须真的驱动压缩，实测 ${JSON.stringify(result.compactionStats ?? [])}`,
  );
});

test("R2 toolResultTtl 经新家生效：第 2 轮的工具结果被折叠（真 run）", async () => {
  // ⚠ 轮数预算必须**留够**：TTL 层在「剩余轮数 ≤ 2」时按既有口径关闭（收尾阶段模型常要回看早期证据），
  // 所以 3 轮的 run 里这一层一次都不会开——那会让这条断言变成「测空气」。
  const script = Array.from({ length: 6 }, (_unused, index) => ({
    content: [{ type: "tool_use", id: `t${index}`, name: "work", input: {} }],
    stopReason: "tool_use",
  }));
  script.push({ content: [{ type: "text", text: "done" }], stopReason: "end_turn" });
  const provider = createFakeProvider(script);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "go",
    executeTool: async () => `ORIGINAL-OUTPUT ${"y".repeat(300)}`,
    maxRounds: 8,
    completion: false,
    wrapup: false,
    config: { folding: { toolResultTtl: 1, toolResultFoldMinTokens: 1 } },
  });
  // 第 2 发请求里，第 1 轮的工具结果必须已经被 TTL 折叠（不再是原文）。
  const second = JSON.stringify(provider.requests[1]?.messages ?? []);
  assert.equal(
    second.includes("ORIGINAL-OUTPUT"),
    false,
    `toolResultTtl=1 必须让上一条工具结果被折叠（TTL 折叠一次都没跑时这里会看到原文）；实测 ${second.slice(0, 400)}`,
  );
  assert.equal(second.includes("已折叠·TTL"), true, "折叠必须走 TTL 占位符（而不是被别的层顺手删掉）");
  assert.equal(result.termination.reason, "end_turn");
});

test("R3 默认（不写这三个键）行为不变：没有 TTL 折叠，也不因为删键而多出任何扁平键", async () => {
  const result = await runDirect();
  assert.equal(result.termination.reason, "end_turn");
  const { effectiveOptions } = await normalizeRunToolLoopOptions({});
  for (const name of ["context", "toolResultTtl", "toolResultFoldMinTokens"]) {
    assert.equal(
      Object.hasOwn(effectiveOptions, name),
      false,
      `${name} 不写时不得凭空出现在 effectiveOptions 里（缺省值由 orchestrator 的解构默认值负责）`,
    );
  }
});
