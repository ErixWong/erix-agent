// issue #498（S3）—— `input` 组 A 段的**垂直切片**（第三片）：删掉顶层扁平 `cacheStablePrefix` 与
// `initialMessages`，它们的规范之家是 `config.input.cacheStablePrefix` / `config.input.messages`。
//
// 本文件钉五件事（其余在本刀改过的既有用例里，见交付报告）：
//
//   P. **旧名反向拒绝钉**（两格，一键一格）：顶层再写这两个键 ⇒ **当场拒**，且文案必须指向新家。
//      这是宿主从 0.26 升级到 0.28 时唯一的救命索。两格都用**逐字相等**断言（不是 `match`）。
//      P2 是本片的结构性看点：`initialMessages` 是**唯一**一条登记别名（`CONFIG_LEAF_ALIASES`：
//      `config.input.messages` → `initialMessages`）的顶层键，所以拒绝文案必须指向
//      `config.input.messages`，**不是** `config.input.initialMessages`（后者是「把顶层键名当叶子
//      写」那个最常见的误写，既有 I2 用例专门教它）。
//   A. **别名表没有死条目 / 没有空转**（本片的结构性看点 ①）：
//      · 正向：`config.input.messages` 展开后**逐字**回到 `effectiveOptions.initialMessages`，且
//        `effectiveOptions` 里**没有** `messages`（别名不许漏成一个新的扁平键）；
//      · 反向（自检侧）：别名表里出现一条叶子不存在的记录 ⇒ `configSchemaSelfCheck` 报
//        `leaf alias … is not a leaf of that group`（死条目）。#517 把恒等式单向化之后，
//        「别名指向的顶层键已不在白名单」是**合法**的（本片就是那个形状），所以死条目的判据
//        只能是**叶子**是否存在，不能是顶层键是否存在——这一格就是那条边界的机器证据。
//   S. **schema 自检**：`configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES) === []`（单向恒等式：
//      每个顶层选项恰好一个家；配置叶子可以没有顶层键）。
//   R. **读侧不变的机制证据**：两个键写在新家之后，展开相会把它们逐字写回
//      `effectiveOptions.<扁平名>`——这正是「删了顶层键、引擎读侧一行都不用改」的原因。
//      两条**真 run**（`cacheStablePrefix` 关掉缓存边界标记、`messages` 真的成为种子历史），
//      外加一条**装配口旧路零回归**（`policy.session.initialMessages` 走的是另一条写侧，
//      本刀没动它，也不许它坏）。
//   C. **叶子还在**（本刀删的是**写法**，不是叶子）：`config.input` 组原样保留六个叶子，
//      且逐叶子 round-trip 覆盖名单仍按**叶子名**取到 `messages` 的值（`#498` 的 S7 族）。
//
// 为什么单独一个文件：这三条是「迁移完成」与「只删了键」的分界线。放在任何既有用例里都会被
// 那一格的叙事淹没，而本刀最容易出的错正是「删了键但没给宿主指路」。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_LEAF_ALIAS_PATHS,
  CONFIG_NAMESPACE_SCHEMA,
  configOptionNameForLeaf,
  configSchemaSelfCheck,
  expandConfigNamespace,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  assertRunToolLoopOptionNames,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect as sharedRunDirect, withSeed } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 直连路线的最小合法 run（一次 end_turn 就结束）。 */
function runDirect(extra = {}) {
  return sharedRunDirect({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    seed: "go",
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

// ================================================================ P. 旧名反向拒绝（两格，一键一格）
//
// 每格两段：① 逐字相等的文案（含新家路径）；② 同一个值写在新家里必须**不抛**——
// 「拒旧名」与「收新家」必须同时成立，否则这条钉子只是在说「我把键弄丢了」。

test("P1 顶层 cacheStablePrefix ⇒ 当场拒，文案逐字指向 config.input.cacheStablePrefix", async () => {
  const error = await directError({ cacheStablePrefix: false });
  assert.equal(error instanceof TypeError, true, "旧名必须在名称闸口抛 TypeError（不是静默忽略）");
  assert.equal(
    error.message,
    'unknown runToolLoop option: "cacheStablePrefix" (its canonical home is'
      + " config.input.cacheStablePrefix; the flat spelling is rejected)",
    "文案必须点名新家——少了 config.input.cacheStablePrefix，升级的宿主只能自己猜",
  );
  // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（读侧不变）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { input: { cacheStablePrefix: false } },
  });
  assert.equal(
    effectiveOptions.cacheStablePrefix,
    false,
    "config.input.cacheStablePrefix 必须写回 effectiveOptions.cacheStablePrefix",
  );
});

test("P2 顶层 initialMessages ⇒ 当场拒，文案逐字指向 config.input.messages（不是 config.input.initialMessages）", async () => {
  const messages = [{ role: "user", content: "seed" }];
  const error = await directError({ initialMessages: messages });
  assert.equal(error instanceof TypeError, true);
  // 逐字相等：这一格同时钉四件事——① 文案里必须有新家；② 新家是**叶子名** `messages`；
  // ③ 不许写成 `config.input.initialMessages`（那正是「把顶层键名当叶子」的误写，I2 用例
  // 专门教它写 `config.input.messages`，两处文案必须互相一致）；
  // ④ **不许再带噪声候选** `did you mean "initialUserMessage"?`。
  //
  // #498 S3 A2b 如实改动（本格逐字文案随删键变化，不是为绿而放宽）：
  // `initialUserMessage` 从 `RUN_TOOL_LOOP_OPTION_NAMES` 删掉之后，它不再是建议候选池里的成员，
  // 于是 `optionSuggestion("initialMessages")` 不再指向它（距离 ≤ 阈值的候选已不存在），
  // 那句 `(did you mean …)` 后缀整段消失。删之前它是**噪声**：宿主照着它去写
  // `initialUserMessage`，0.28 之后那已经是被拒的旧拼写。现在文案只剩唯一一条出路（新家），
  // 这是**更强**的断言：④ 把「噪声不许回来」也钉住。
  assert.equal(
    error.message,
    'unknown runToolLoop option: "initialMessages"'
      + " (its canonical home is config.input.messages; the flat spelling is rejected)",
  );
  assert.equal(
    error.message.includes("did you mean"),
    false,
    "候选池里已经没有 `initialUserMessage`，不许再给一个写不出去的「did you mean」",
  );
  assert.equal(
    error.message.includes("config.input.initialMessages"),
    false,
    "文案不得把顶层键名当叶子（那会让宿主写 config.input.initialMessages 再撞第二次）",
  );
  // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回 `effectiveOptions.initialMessages`。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { input: { messages } },
  });
  assert.deepEqual(
    effectiveOptions.initialMessages,
    messages,
    "config.input.messages 必须写回 effectiveOptions.initialMessages（别名表那一跳）",
  );
});

// 旧名**真的**不在白名单里了（不是「拒了但又留着」）。
test("P3 三个旧名都不在白名单里，而 config.input 组原样保留六个叶子", () => {
  // #498 S3 A2b：`initialUserMessage` 是第三个（`input` 组最后一个离开顶层白名单的成员）。
  for (const name of ["cacheStablePrefix", "initialMessages", "initialUserMessage"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(name), false, `${name} 必须已经离开顶层白名单`);
  }
  // 新家还在（本刀删的是**写法**，不是叶子）：否则 P1/P2 的文案会指向一个不存在的组。
  assert.deepEqual(
    [...CONFIG_NAMESPACE_SCHEMA.input].sort(),
    ["cacheStablePrefix", "initialUserMessage", "messages", "system", "tools", "wrapup"],
    "config.input 组必须原样保留六个叶子（它就是新家）",
  );
  // 纯数据键不该被塞「第二站」（它们不是混装壳）：两条文案都是「一句话」形态。
  for (const name of ["cacheStablePrefix", "initialMessages", "initialUserMessage"]) {
    assert.equal(
      gateMessage(name).includes("this shell holds both data and functions"),
      false,
      `${name} 是纯数据键，文案不该出现混装壳的第二站提示`,
    );
  }
});

// #498 S3 A2b 的反向拒绝钉：**扁平 `initialUserMessage` 当场拒，文案逐字指向新家**。
//
// 这一格是本刀「删键」那一半的机器判据：删键之前它是白名单成员（写扁平 = 合法），删之后它必须
// 在**名称闸口**就抛（不是「收下再忽略」，也不是「收下再报别的错」）。文案里的新家路径逐字钉住，
// 因为宿主 0.26 → 0.28 升级时唯一能自己找到出路的线索就是它。
test("P4 顶层 initialUserMessage ⇒ 当场拒，文案逐字指向 config.input.initialUserMessage", async () => {
  // ⚠ 这里**故意**走裸 `runToolLoop`（不是夹具）：本格测的就是「引擎拒收这个拼写」，
  // 走夹具会被翻译成新家、永远不抛——那条断言就变成自说自话。
  // @seed-fixture-exempt: 反向拒绝钉——这一格必须让扁平拼写真的抵达引擎
  const error = await runToolLoop({ initialUserMessage: "go" }).then(() => null, (caught) => caught);
  assert.equal(error instanceof TypeError, true, "扁平拼写必须当场抛 TypeError（不许收下）");
  assert.equal(
    error.message,
    'unknown runToolLoop option: "initialUserMessage"'
      + " (its canonical home is config.input.initialUserMessage; the flat spelling is rejected)",
    "文案必须逐字点名新家（宿主靠这一句自己找到出路）",
  );
  assert.equal(error.via, undefined, "名称闸口抛的错不贴路线标签（它不是语义相）");

  // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（引擎读侧不变）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { input: { initialUserMessage: "go" } },
  });
  assert.equal(
    effectiveOptions.initialUserMessage,
    "go",
    "config.input.initialUserMessage 必须写回 effectiveOptions.initialUserMessage（引擎读的就是它）",
  );
  // 反向：删掉的那条**只**是写法。叶子还在 schema 里，且它没有对应的顶层选项了（#517 的形状）。
  assert.equal(
    CONFIG_NAMESPACE_SCHEMA.input.includes("initialUserMessage"),
    true,
    "叶子必须保留——新家就是它，删叶子等于把家也拆了",
  );
  assert.equal(
    RUN_TOOL_LOOP_OPTION_NAMES.includes("initialUserMessage"),
    false,
    "顶层扁平键必须已经不在白名单里",
  );
});

// ================================================================ A. 别名表：活的、没有死条目
//
// `initialMessages` 是**唯一**那条登记别名（`config.input.messages` → `initialMessages`）的顶层键。
// 它从白名单里消失之后，`config.input.messages` 就是「有叶子、没有顶层键」的形状——正是 #517 把
// 恒等式单向化时放行、并为这个系列等了五刀的第一个真实用例。所以别名表必须仍然**有活干**，
// 而且「死条目」的判据只能是叶子存在与否。

test("A1 config.input.messages 展开后逐字回到 initialMessages，且不产生新的扁平键 messages", async () => {
  const messages = [{ role: "user", content: "seed" }, { role: "assistant", content: "hi" }];
  const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { input: { messages } } });
  assert.deepEqual(effectiveOptions.initialMessages, messages, "别名那一跳必须还在（叶子 → 顶层键名）");
  assert.equal(
    Object.hasOwn(effectiveOptions, "messages"),
    false,
    "别名叶子本身不许漏进 effectiveOptions——漏了就等于凭空发明一个顶层键 `messages`",
  );
  // 纯函数侧再钉一次（不依赖引擎）：展开结果就是那个扁平键。
  const expanded = expandConfigNamespace({ config: { input: { messages } } });
  assert.deepEqual(expanded.options, { initialMessages: messages });
  assert.deepEqual(expanded.conflicts, []);
});

test("A2 别名表只许一条记录，且那条记录的叶子真实存在（死条目判据 = 叶子，不是顶层键）", () => {
  // ① 今天整张表只有一条记录：`input.messages` → `initialMessages`。
  assert.deepEqual(CONFIG_LEAF_ALIAS_PATHS, { input: { messages: "initialMessages" } });
  assert.equal(configOptionNameForLeaf("input", "messages"), "initialMessages");
  // ② 它的**叶子**在 schema 里（这就是「不是死条目」的定义）。注意这里**不**核
  //    「`initialMessages` 还在白名单里」——那一条本片已经合法地不成立了（#517 单向化）。
  assert.equal(CONFIG_NAMESPACE_SCHEMA.input.includes("messages"), true, "别名登记的叶子必须真存在");
  assert.equal(
    RUN_TOOL_LOOP_OPTION_NAMES.includes("initialMessages"),
    false,
    "别名指向的顶层键已经不在白名单里——这正是本片的形状，自检仍须 []",
  );
  // ③ 反向（死条目）：注入一条「叶子不存在」的别名记录 ⇒ 自检必须点名它。
  const deadEntry = configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES, {
    leafAliases: { input: { messages: "initialMessages", ghost: "initialMessages" } },
  });
  assert.deepEqual(
    deadEntry,
    ['leaf alias input.ghost is not a leaf of that group'],
    "别名表里的死条目必须被点名（否则「登记了别名、叶子却没了」会静默）",
  );
  // ④ 反向（空转）：把**唯一那条**别名记录删掉 ⇒ 展开不再回到 `initialMessages`。
  //    这一格用注入的空表证明「别名表不是装饰」：没有它，`messages` 会自己变成一个扁平键。
  assert.equal(
    configOptionNameForLeaf("input", "messages"),
    "initialMessages",
    "正向：有别名时叶子映射到顶层键名",
  );
  // 生产代码里没有注入点（`configOptionNameForLeaf` 读的是常量表），所以这里用**等价形态**证明：
  // 一张不含这条记录的表会让 `input.messages` 映射到 `messages`——那正是「删掉别名 ⇒ 行为变化」
  // 的机制，活体反向证（改源文件）在交付报告里给了退出码。
  const aliasesWithoutMessages = Object.fromEntries(
    Object.entries(CONFIG_LEAF_ALIAS_PATHS).map(([group, table]) => [
      group,
      Object.fromEntries(Object.entries(table).filter(([leaf]) => leaf !== "messages")),
    ]),
  );
  assert.deepEqual(aliasesWithoutMessages, { input: {} }, "删掉那条记录之后别名表就是空表");
});

test("A3 逐叶子 round-trip 覆盖仍按叶子名取到 messages 的值（S7 族，不因顶层键消失而漏测）", () => {
  // `#498` 的 S7 用「代表性纯数据取值表」逐叶子核 round-trip；那张表按**叶子名**索引，
  // 所以 `messages` 在、它的扁平孪生 `initialMessages` 不在。本片删掉顶层键之后，
  // 叶子必须**照旧**被取到值——这一格是「删了顶层键不会顺手造出一个没人摸过的叶子」的机器证据。
  const messages = [{ role: "user", content: "seed" }];
  const leafValue = JSON.parse(JSON.stringify(messages));
  assert.deepEqual(leafValue, messages, "messages 叶子的取值必须过 JSON round-trip 等值");
  // 展开一次：叶子 → 扁平键 → 引擎读的那个字段，三跳都在。
  const { options: effectiveOptions } = expandConfigNamespace({ config: { input: { messages: leafValue } } });
  assert.deepEqual(
    effectiveOptions[configOptionNameForLeaf("input", "messages")],
    leafValue,
    "叶子值必须原样落到它映射到的扁平键上（round-trip 之后一个字节都不变）",
  );
});

// ================================================================ S. schema 自检（单向恒等式）
test("S1 configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES) === []", () => {
  assert.deepEqual(
    configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES),
    [],
    "每个顶层选项必须恰好一个家；配置叶子可以没有顶层键（#517 单向化），但别名死条目仍是红",
  );
});

// ================================================================ R. 读侧不变（真 run 的行为证据）
//
// 「引擎读的是 `effectiveOptions.<扁平名>`」这句话必须用行为证明，不能靠读代码。

test("R1 cacheStablePrefix 经新家生效：缓存边界标记真的消失（真 run）", async () => {
  // 默认 `true` ⇒ system 被包成 `{content, cacheBoundary:true}`、首条消息带 `cacheBoundary`。
  const defaulted = createFakeProvider(DONE);
  await runToolLoop(withSeed({
    provider: defaulted,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    // #498 S3 A6：扁平 `system` 已退役，家是 `config.input.system`（本组同一个容器）。
    config: { input: { system: "SYS" } },
    wrapup: false,
  }));
  assert.equal(defaulted.requests[0].system.cacheBoundary, true, "对照组：默认必须打标记");

  // 经新家关掉 ⇒ 两条标记都必须消失（这就是引擎真的读到了 `effectiveOptions.cacheStablePrefix`）。
  const optedOut = createFakeProvider(DONE);
  await runToolLoop(withSeed({
    provider: optedOut,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    wrapup: false,
    config: { input: { system: "SYS", cacheStablePrefix: false } },
  }));
  assert.equal(optedOut.requests[0].system, "SYS", "config.input.cacheStablePrefix:false 必须真的生效");
  assert.equal("cacheBoundary" in optedOut.requests[0].messages[0], false);
});

test("R2 initialMessages 经新家生效：config.input.messages 真的成为种子历史（真 run）", async () => {
  const seed = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
  ];
  const provider = createFakeProvider(DONE);
  const result = await runToolLoop(withSeed({
    provider,
    executeTool: async () => "ok",
    // 同时给 `initialUserMessage`：种子历史在场时它必须被忽略（既有语义，本刀不改读侧）。
    initialUserMessage: "这条不许出现",
    completion: false,
    wrapup: false,
    config: { input: { messages: seed } },
  }));
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(
    provider.requests[0].messages.map((message) => [message.role, message.content]),
    [["user", "第一问"], ["assistant", "第一答"]],
    "config.input.messages 必须成为种子历史（不是「展开了但没人读」）",
  );
  assert.equal(
    JSON.stringify(provider.requests[0].messages).includes("这条不许出现"),
    false,
    "种子历史在场时 initialUserMessage 仍被忽略（读侧优先级一字未改）",
  );
});

test("R2b 端口写侧与 config 新家同写 ⇒ 恰一条冲突（path = input.messages），config 赢", async () => {
  // `initialMessages` 的扁平拼写从名称闸口消失了，但**合并后的表示**里仍可能带着它：
  // `assemblyPortOptions` 会把 `policy.session.initialMessages` 派生进 `assembledOptions.initialMessages`。
  // 于是「同一个键两种写法」这条既有规则（`config` 赢、冲突不静默）在这一片上依然可达，
  // 而且它现在唯一的扁平来源就是装配口——这一格把那条路走一遍（走规范化，不依赖事件通道）。
  const portSeed = [{ role: "user", content: "端口种子" }];
  const configSeed = [{ role: "user", content: "config 种子" }];
  const { effectiveOptions, configConflicts } = await normalizeRunToolLoopOptions({
    assemblyPort: {
      modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
      provider: createFakeProvider(DONE),
      tools: { definitions: [], executeTool: async () => "ok" },
      session: { id: "input-slice-c3b", initialMessages: portSeed },
    },
    config: { input: { messages: configSeed } },
  });
  assert.deepEqual(
    configConflicts,
    [{ path: "input.messages", key: "initialMessages" }],
    "两种写法给了不同的值 ⇒ 恰一条冲突（path 是 schema 路径、key 是顶层键名）",
  );
  assert.deepEqual(
    effectiveOptions.initialMessages,
    configSeed,
    "config 侧赢（既有优先级一字未改），且赢在 `effectiveOptions.initialMessages` 上",
  );
});

test("R3 装配口旧写侧零回归：policy.session.initialMessages 照旧成为种子历史（真 run）", async () => {
  // `session.initialMessages` 是**另一条写侧**（装配口端口成员，`src/assembly.js`），本刀一个字都没改。
  // 它与顶层扁平键不是同一个东西：端口成员走 `assemblyPortOptions` 的派生键，不进名称闸口。
  const seed = [{ role: "user", content: "端口种子" }];
  const provider = createFakeProvider(DONE);
  const result = await runToolLoop({
    assemblyPort: {
      modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
      provider,
      tools: { definitions: [], executeTool: async () => "ok" },
      session: { id: "input-slice-c3", initialMessages: seed },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(
    provider.requests[0].messages.map((message) => [message.role, message.content]),
    [["user", "端口种子"]],
    "装配口 session.initialMessages 必须照旧生效（本刀只动写侧拼写，不动读侧与端口面）",
  );
});
