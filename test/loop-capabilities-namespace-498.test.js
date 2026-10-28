// issue #498（S4a）—— 0.28 的归类落地：**能力面 = 被调用/被解引用的行为载体；配置面 = 被读字段
// 并被校值的数据**，并且 `config` 子树必须 **JSON round-trip 等值**。
//
// #497 当时把这条判据写成「描述 0.28 目标面」；S4a 就是它兑现的地方。四件事，四组用例：
//
//   S1（三向闭合）：`configSchemaSelfCheck` 必须仍 `[]`，且四个数可枚举闭合——
//      配置面 43 + 能力面 22 + 容器 2 = 顶层白名单 67。容器是 {`config`, `capabilities`}，
//      两个容器**同等待遇**（都不算配置/能力键，都有未知子键闸口）。#498 S4b 之后两面的**条数
//      都没变、组成变了**：`tools` 归配置面（`config.input.tools`）、`deliverables` 反向搬进
//      能力面（`capabilities.checks.deliverables`），而 `finalGuard` 从散项收进 `hooks`。
//   S2（`capabilities.hooks` 是回调的规范之家）：12 个回调逐个点名；`capabilities.hooks.onEvent`
//      与顶层 `onEvent` 是同一个键（别名 = schema 路径）；展开后扁平键生效（行为证据：真收到事件）；
//      与扁平键冲突时 capabilities 赢且**不静默**（同一条 `config_override_conflict`）。
//   S3（`config.observers` 整组删除 + `config` 里不许有函数值）：8 个观察者键写进 `config` 一律抛并
//      指向 `capabilities.hooks`；**壳里的函数字段**（`retry.sleepImpl` / `reflection.onReflection` /
//      `reflection.judge.provider` / `context.onBeforeFold` / `onAfterFold`）逐个点名**完整路径**；
//      `config.guard.finalGuard` 与 `config.guard.deliverables` 都属能力面（#498 S4b 起
//      `deliverables` 整键搬进 `capabilities.checks`，所以它不再是「只能写 `[]`」的过渡态）。
//      「收下再在展开时丢函数」不可能：抛在 intake（读任何宿主端口之前）。
//   S4（可枚举的 round-trip 机器断言）：按 `CONFIG_NAMESPACE_SCHEMA` **逐叶子**构造一份代表性纯数据
//      取值，断言 `JSON.parse(JSON.stringify(cfg))` 与原值逐字等值，并断言展开后的有效选项与直接传
//      扁平键语义等价（#497 的 B1/B2 结构）。**将来谁把函数键放进 config，它会立刻红并点名叶子**。
//      #517：这条覆盖度断言是**逐叶子**的、与叶子有没有顶层键无关（S7 ④ 还钉了一句「覆盖表按叶子
//      名索引」：`messages` 在、它的扁平孪生 `initialMessages` 不在）——因为自检单向化之后，
//      「叶子失去了顶层键」不再红，round-trip 覆盖是另一条不许偷懒的锁。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import {
  CAPABILITIES_ALIAS_PATHS,
  CAPABILITIES_NAMESPACE_GROUPS,
  CAPABILITIES_NAMESPACE_OPTION_NAME,
  CAPABILITIES_NAMESPACE_SCHEMA,
  CAPABILITIES_SLOT_LEAF_NAMES,
  CAPABILITIES_SURFACE_OPTION_NAMES,
  CAPABILITY_CHECK_NAMES,
  CAPABILITY_HOOK_NAMES,
  CAPABILITY_POLYMORPHIC_HOOK_NAMES,
  CAPABILITY_PORT_SLOT_NAMES,
  CAPABILITY_SLOT_DESTINATIONS,
  capabilitiesPathForOption,
  collectCapabilitiesNamespaceProblems,
  expandCapabilitiesNamespace,
} from "../src/loop/capabilities-namespace.js";
import {
  CAPABILITY_OPTION_NAMES,
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_OPTION_NAME,
  CONFIG_NAMESPACE_SCHEMA,
  CONFIG_SURFACE_OPTION_NAMES,
  NAMESPACE_CONTAINER_OPTION_NAMES,
  collectConfigNamespaceProblems,
  configOptionNameForLeaf,
  configPlaneOptionNames,
  configSchemaSelfCheck,
  configPathForOption,
  expandConfigNamespace,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
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

/** 直连路线的「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => runDirect(extra).then(() => null, (error) => error);

/** 装配口路线：`policy` 在构造期过闸口，`capabilities` 在合并后过同一道展开。 */
function makePort(policy = {}) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: createFakeProvider(DONE),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: `capabilities-498-${process.pid}` },
    policy,
  });
}

const assemblyError = async (policy = {}) => {
  let port;
  try {
    port = makePort(policy);
  } catch (error) {
    return error;
  }
  return runToolLoop({ assemblyPort: port }).then(() => null, (error) => error);
};

/** 一棵子树里所有函数值的完整路径（测试侧独立实现，不复用被测代码）。 */
function functionPathsIn(value, path) {
  if (typeof value === "function") return [path];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => functionPathsIn(item, `${path}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, item]) => functionPathsIn(item, `${path}.${key}`));
}

// ================================================================ S1. 三向闭合（派生，不手抄总数）
test("S1 三向闭合：白名单被配置面 / 能力面 / 容器恰好切一遍，自检仍 []", () => {
  // #498 S3：这里原本手抄四个字面总数。删掉 `timing` 组的三个顶层键之后配置面那一项自动少三个，
  // 于是四个数得手追——本刀把那四个数全部删掉，改成**集合等式**（比条数强，且与条数无关）。
  const configPlane = configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...CAPABILITY_OPTION_NAMES, ...NAMESPACE_CONTAINER_OPTION_NAMES];
  assert.equal(new Set(partition).size, partition.length, "三个面两两不相交（一个键只许有一个家）");
  assert.deepEqual(
    [...partition].sort(),
    [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "三向之和必须逐键等于白名单（这就是「闭合」的可枚举形式，不靠条数自证）",
  );
  assert.deepEqual(NAMESPACE_CONTAINER_OPTION_NAMES, [CONFIG_NAMESPACE_OPTION_NAME, CAPABILITIES_NAMESPACE_OPTION_NAME]);
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(CAPABILITIES_NAMESPACE_OPTION_NAME), true);
  // 白名单**内容**：8 个扁平观察者键一个都没删（0.26 已发布面）。
  // #498 S4c：后 4 个回调**从来不是**顶层选项，所以它们不在名单里（它们不是被删掉的扁平键）。
  for (const hook of CAPABILITY_HOOK_NAMES) {
    if (CAPABILITIES_SLOT_LEAF_NAMES.includes(hook)) continue;
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(hook), true, `${hook} 的顶层扁平写法必须继续在名单里`);
  }
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "自检必须仍 []");
});

test("S1b 自检会咬人：容器漏一个 / hooks 里的回调没分类 / hooks 名不存在，三个方向都红", () => {
  const noCapabilities = configSchemaSelfCheck(
    RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => name !== CAPABILITIES_NAMESPACE_OPTION_NAME),
  );
  assert.deepEqual(noCapabilities, [
    'top-level options do not accept "capabilities" (a namespace container)',
  ]);
  const noConfig = configSchemaSelfCheck(
    RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => name !== CONFIG_NAMESPACE_OPTION_NAME),
  );
  assert.deepEqual(noConfig, [
    'top-level options do not accept "config" (a namespace container)',
  ]);
  // 能力面少列一个回调（模拟「往 hooks 加回调却忘了分类」的落地形状）。
  const optionNames = RUN_TOOL_LOOP_OPTION_NAMES;
  assert.equal(configSchemaSelfCheck(optionNames).length, 0);
  // hooks 里的名字不在顶层白名单里（模拟「schema 写了一个不存在的键」）。
  const dropped = optionNames.filter((name) => name !== "onJudge");
  assert.deepEqual(
    configSchemaSelfCheck(dropped),
    [
      'capabilities.hooks names "onJudge", which is not a top-level option',
      'schema names "onJudge", which is not a top-level option',
    ],
    "hooks 里的回调必须是真选项，否则这条闭合是空转（两条报错都点名同一个键）",
  );
  // #498 S4b：`checks` 组的叶子同一条规矩（`deliverables` 离开白名单 ⇒ 两边都红）。
  const noDeliverables = configSchemaSelfCheck(
    optionNames.filter((name) => name !== "deliverables"),
  );
  assert.deepEqual(noDeliverables, [
    'capabilities.checks names "deliverables", which is not a top-level option',
    'schema names "deliverables", which is not a top-level option',
  ], "checks 组的叶子必须是真选项（#498 S4b）");
});

test("S1c 容器与两面对称：两个容器都不在配置面/能力面里，且都有未知子键闸口", () => {
  for (const container of NAMESPACE_CONTAINER_OPTION_NAMES) {
    assert.equal(CONFIG_SURFACE_OPTION_NAMES.includes(container), false, `${container} 不是配置键`);
    assert.equal(CAPABILITY_OPTION_NAMES.includes(container), false, `${container} 不是能力键`);
    assert.equal(configPathForOption(container), undefined);
    assert.equal(capabilitiesPathForOption(container), undefined);
  }
  // 未知子键闸口：两个容器各抛一条（同一道相位、同一套文案口径）。
  assert.match(
    collectConfigNamespaceProblems({ rund: { maxRounds: 1 } })[0],
    /unknown config namespace: "rund" \(accepted: input, run, tuning, timing, folding, guard, metadata\)/u,
  );
  assert.match(
    collectCapabilitiesNamespaceProblems({ hoks: {} })[0],
    /unknown capabilities namespace: "hoks" \(accepted: hooks, checks, ports;/u,
  );
  // #498 S4b 的两面对称：`capabilities.check`（少一个 s）必须抛，且**列出可接受值**（含 checks）。
  // #498 S4c：名单多了 `ports`，而旧文案里那句「ports are not collected under capabilities」是
  // 现在的**假话**（`capabilities.ports` 就是本刀开的）⇒ 换成「端口对象留在哪里」的真话。
  const singular = collectCapabilitiesNamespaceProblems({ check: { deliverables: [] } });
  assert.deepEqual(singular, [
    'unknown capabilities namespace: "check" (accepted: hooks, checks, ports;'
      + " port objects such as provider / store / signal stay top-level options"
      + " or assembly-port members, not capabilities members)",
  ], "`capabilities.check` 必须抛并列出可接受值（#498 S4b 的闸口对称性）");
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ checks: { check: [] } }),
    ['unknown capabilities.checks option: "check" (accepted: deliverables)'],
    "checks 组的未知叶子点名该层接受的名字",
  );
  // 反向对称：把能力面的**组名**写进 config ⇒ 不是「未知配置分组」，而是指回 capabilities。
  assert.deepEqual(
    collectConfigNamespaceProblems({ checks: { deliverables: [] } }),
    ["config.checks: capabilities.checks is a capability group, not a config group"
      + " (write capabilities.checks.<leaf> at the top level)"],
  );
  // #498 S4b 复审：反向对称必须是**两组**都对称，不是只钉 `checks` 这一格。
  assert.deepEqual(
    collectConfigNamespaceProblems({ hooks: { onRound: () => {} } }),
    ["config.hooks: capabilities.hooks is a capability group, not a config group"
      + " (write capabilities.hooks.<leaf> at the top level)"],
    "`hooks` 与 `checks` 必须同一条反向报错（两组对称）",
  );
  // 叶子写在容器顶层 ⇒ 指到它真正的组（而不是含糊的「未知分组」）。
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ deliverables: [] }),
    ["capabilities.deliverables: checks live under capabilities.checks (write capabilities.checks.deliverables)"],
  );
});

// ================================================================ S2. capabilities.hooks 是规范之家
test("S2 16 个回调逐个点名：名单、别名表、schema 三者互相对得上", () => {
  assert.deepEqual([...CAPABILITY_HOOK_NAMES], [
    "onEvent",
    "onObserverError",
    "onPersistenceError",
    "onRound",
    "onJudge",
    "onToolResult",
    "onDelta",
    "onReasoningDelta",
    "onToolCall",
    "onUsage",
    "onFoldSummary",
    // #498 S4b：第 12 个（值必须是函数，消费点是 `callFinalGuard` 里那行 `finalGuard(payload)`
    // （`src/loop/termination.js`）；`hasFinalDraft()` 是强制收尾的私有判定，与 `finalGuard` 无关）。
    "finalGuard",
    // #498 S4c：四个**壳内**回调（旧住处是嵌套槽，没有顶层扁平别名）。
    "onReflection",
    "onBeforeFold",
    "onAfterFold",
    "stubFor",
  ], "16 个回调的名单是本刀的判据面，逐字钉住");
  assert.equal(CAPABILITY_HOOK_NAMES.length, 16);
  assert.deepEqual(
    [...CAPABILITIES_NAMESPACE_GROUPS],
    ["hooks", "checks", "ports"],
    "三组：hooks（16 回调 + 2 形态多态旋钮）+ checks（1）+ ports（3，#498 S4c）",
  );
  assert.deepEqual(Object.keys(CAPABILITIES_NAMESPACE_SCHEMA), ["hooks", "checks", "ports"]);
  assert.deepEqual([...CAPABILITY_CHECK_NAMES], ["deliverables"], "checks 组只有交付物判据");
  // #498 S4c：`CAPABILITY_HOOK_NAMES` 是**回调**那张表（16），两个形态多态旋钮单列
  // （`CAPABILITY_POLYMORPHIC_HOOK_NAMES`，它们不是回调而是「同一个旋钮的函数形态」）。
  assert.deepEqual([...CAPABILITY_POLYMORPHIC_HOOK_NAMES], ["protectedMessage", "recoveryHint"]);
  assert.deepEqual([...CAPABILITY_PORT_SLOT_NAMES], ["sleepImpl", "judgeProvider", "strategy"]);
  assert.equal(CAPABILITIES_NAMESPACE_SCHEMA.hooks.length, 18, "hooks 接受 16 + 2 = 18 个叶子");
  assert.equal(CAPABILITIES_ALIAS_PATHS.size, 13, "12 个扁平回调 + 1 个 checks 叶子，一条别名路径不多不少");
  assert.equal(CAPABILITIES_SURFACE_OPTION_NAMES.length, 13, "能力面 schema 的**扁平**叶子全集 = 13");
  assert.equal(CAPABILITIES_SLOT_LEAF_NAMES.length, 9, "#498 S4c：9 个嵌套槽叶子（3 ports + 6 hooks）");
  assert.equal(
    CAPABILITIES_SURFACE_OPTION_NAMES.length + CAPABILITIES_SLOT_LEAF_NAMES.length,
    CAPABILITIES_NAMESPACE_GROUPS.reduce((sum, group) => sum + CAPABILITIES_NAMESPACE_SCHEMA[group].length, 0),
    "schema 的叶子恰好分成「扁平 13 + 嵌套槽 9」两半，没有第三个去向",
  );
  assert.equal(capabilitiesPathForOption("deliverables"), "checks.deliverables");
  assert.equal(CAPABILITIES_ALIAS_PATHS.get("checks.deliverables"), "deliverables");
  assert.equal(CAPABILITY_OPTION_NAMES.includes("deliverables"), true, "deliverables 必须在能力面名单里");
  assert.equal(CONFIG_SURFACE_OPTION_NAMES.includes("deliverables"), false, "deliverables 不得再出现在配置面");
  for (const hook of CAPABILITY_HOOK_NAMES) {
    const path = capabilitiesPathForOption(hook);
    assert.equal(path, `hooks.${hook}`, `${hook} 的路径叶子必须逐字等于键名（别名 = schema 路径）`);
    if (CAPABILITIES_SLOT_LEAF_NAMES.includes(hook)) {
      // #498 S4c：嵌套槽叶子**没有**顶层扁平别名 ⇒ 它不在能力面 22 项名单里，也不许出现在
      // 顶层白名单（这条就是「只加目的地、不发明扁平键」的机器证明）。
      assert.equal(CAPABILITIES_ALIAS_PATHS.has(path), false, `${hook} 是嵌套槽叶子，不该有扁平别名`);
      assert.equal(CAPABILITY_OPTION_NAMES.includes(hook), false, `${hook} 不在顶层能力面名单里`);
      assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(hook), false, `${hook} 不许是顶层选项（嵌套槽叶子不发明扁平键）`);
      assert.equal(CONFIG_SURFACE_OPTION_NAMES.includes(hook), false, `${hook} 不得出现在配置面`);
      assert.equal(typeof CAPABILITY_SLOT_DESTINATIONS[path]?.path?.[0], "string", `${hook} 必须登记嵌套槽去向`);
      continue;
    }
    assert.equal(CAPABILITIES_ALIAS_PATHS.get(path), hook);
    assert.equal(CAPABILITY_OPTION_NAMES.includes(hook), true, `${hook} 必须在能力面名单里（三向闭合）`);
    assert.equal(CONFIG_SURFACE_OPTION_NAMES.includes(hook), false, `${hook} 不得再出现在配置面`);
  }
});

test("S2b capabilities.hooks 展开后与顶层扁平键是同一个键（展开层证据）", () => {
  const hook = () => {};
  const { options, conflicts } = expandCapabilitiesNamespace({
    capabilities: { hooks: { onEvent: hook } },
  });
  assert.deepEqual(conflicts, []);
  assert.equal(options.onEvent, hook, "展开后就是顶层 onEvent 那一个函数（同一个引用）");
  assert.equal(Object.hasOwn(options, "capabilities"), false, "capabilities 展开后必须消失");
  // 只给一边不算冲突；两边同值也不算。
  assert.deepEqual(
    expandCapabilitiesNamespace({ onEvent: hook, capabilities: { hooks: { onEvent: hook } } }).conflicts,
    [],
  );
  // 叶子显式 undefined 逐字等于「没给」。
  const skip = expandCapabilitiesNamespace({ onEvent: hook, capabilities: { hooks: { onEvent: undefined } } });
  assert.equal(skip.options.onEvent, hook);
  assert.deepEqual(skip.conflicts, []);
});

test("S2c 行为证据：capabilities.hooks.onEvent / onRound 真的被投递（不是「展开了但没人读」）", async () => {
  const events = [];
  const records = [];
  const result = await runDirect({
    capabilities: {
      hooks: {
        onEvent: (event) => events.push(event),
        onRound: (record) => records.push(record),
      },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.ok(events.length > 0, "onEvent 必须收到事件");
  assert.equal(events.filter((event) => event.type === "run_outcome").length, 1);
  assert.equal(records.length, 1, "onRound 必须收到轮记录");
    // 对照（必改 #8：原来那条 `assert.deepEqual(none, [])` 里的 none 从未被任何回调引用，恒真）。
    // 真对照 = 只传扁平写法时必须照常投递 ⇒ 证明本刀是**加法**，不是搬家。
    const flatOnly = [];
    const flatRun = await runDirect({ onEvent: (event) => flatOnly.push(event) });
    assert.equal(flatRun.termination.reason, "end_turn");
    assert.ok(flatOnly.length > 0, "只传扁平 onEvent 时必须照常投递（纯加法）");
    assert.equal(flatOnly.filter((event) => event.type === "run_outcome").length, 1,
      "扁平写法的 run_outcome 恰一条（与上面 capabilities.hooks 侧同形）");
    assert.equal(flatOnly.filter((event) => event.type === "config_override_conflict").length, 0,
      "只有一侧在场 ⇒ 没有冲突可报");
});

test("S2d capabilities 赢扁平键，且冲突不静默：同一条 config_override_conflict，path = hooks.<name>", async () => {
  const events = [];
  const flatCalls = [];
  const nestedCalls = [];
  const result = await runDirect({
    onEvent: (event) => {
      flatCalls.push(event);
      events.push(event);
    },
    capabilities: {
      hooks: {
        onEvent: (event) => {
          nestedCalls.push(event);
          events.push(event);
        },
      },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(flatCalls, [], "扁平那个回调被 capabilities.hooks 覆盖（容器赢扁平）");
  assert.ok(nestedCalls.length > 0);
  const conflicts = events.filter((event) => event.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, "冲突事件恰一条");
  assert.deepEqual(conflicts[0].conflicts, [{ path: "hooks.onEvent", key: "onEvent" }]);
  assert.equal(typeof conflicts[0].detail, "string");
});

test("S2d2 两个 capabilities 源同时在场：调用级整棵覆盖（后写者胜），逐叶冲突恰一条", async () => {
  const policyCalls = [];
  const callCalls = [];
  const events = [];
  const port = makePort({
    capabilities: { hooks: { onEvent: (event) => policyCalls.push(event) } },
  });
  const result = await runToolLoop({
    assemblyPort: port,
    completion: false,
    wrapup: false,
    capabilities: {
      hooks: {
        onEvent: (event) => {
          callCalls.push(event);
          events.push(event);
        },
      },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(policyCalls, [], "调用级整棵覆盖 ⇒ policy 那个钩子一次都不被调（既有合并规则）");
  assert.ok(callCalls.length > 0);
  const conflicts = events.filter((event) => event.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, "覆盖不许静默：恰一条事件（与 R4 的 config 那一侧同一条出口）");
  assert.deepEqual(conflicts[0].conflicts, [{ path: "hooks.onEvent", key: "onEvent" }]);

  // 只给一边 / 两边同一个函数 ⇒ 零事件。
  const sameHook = () => {};
  const quiet = [];
  await runToolLoop({
    assemblyPort: makePort({ capabilities: { hooks: { onEvent: sameHook } } }),
    completion: false,
    wrapup: false,
    capabilities: { hooks: { onEvent: sameHook } },
    onEvent: (event) => quiet.push(event),
  });
  assert.deepEqual(quiet.filter((event) => event.type === "config_override_conflict"), []);
});

test("S2e 装配口路线：policy.capabilities 同相接受并生效，未知子键 via=assembly", async () => {
  const seen = [];
  const port = makePort({ capabilities: { hooks: { onEvent: (event) => seen.push(event) } } });
  const result = await runToolLoop({ assemblyPort: port, completion: false, wrapup: false });
  assert.equal(result.termination.reason, "end_turn");
  assert.ok(seen.length > 0, "policy.capabilities.hooks.onEvent 必须被投递");

  const error = await assemblyError({ capabilities: { hoks: { onEvent: () => {} } } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /unknown capabilities namespace: "hoks"/u);
  assert.equal(error.via, "assembly", "装配口路线的路线标签必须是 assembly");
  assert.throws(
    () => makePort({ capabilities: { hooks: { onEtent: () => {} } } }),
    (thrown) => thrown instanceof TypeError
      && /unknown capabilities\.hooks option: "onEtent"/u.test(thrown.message)
      && thrown.via === "assembly",
    "policy.capabilities 的子键闸口必须在构造期就抛",
  );
});

test("S3 capabilities 的拼错子键当场抛并点名完整路径（含「回调写在容器顶层」这条最易犯的误写）", async () => {
  const cases = [
    [{ capabilities: { hoks: { onEvent: () => {} } } }, /unknown capabilities namespace: "hoks"/u],
    [{ capabilities: { hooks: { onEtent: () => {} } } }, /unknown capabilities\.hooks option: "onEtent"/u],
    [{ capabilities: { onEvent: () => {} } }, /capabilities\.onEvent: hooks live under capabilities\.hooks/u],
    [{ capabilities: { provider: () => {} } }, /unknown capabilities namespace: "provider"/u],
    [{ capabilities: { hooks: "nope" } }, /capabilities\.hooks must be an object/u],
    [{ capabilities: null }, /capabilities must be an object \(or omitted\)/u],
    [{ capabilities: [] }, /capabilities must be an object \(or omitted\)/u],
    // 叶子给了但不是函数 = 「给了但给错」，与 `undefined` = 未订阅同口径。
    [{ capabilities: { hooks: { onRound: "nope" } } }, /capabilities\.hooks\.onRound must be a function \(or omitted\)/u],
  ];
  for (const [options, pattern] of cases) {
    const error = await directError(options);
    assert.equal(error instanceof TypeError, true, JSON.stringify(options));
    assert.match(error.message, pattern);
    assert.equal(error.via, "direct");
  }
  // `capabilities: undefined` 逐字等于省略。
  const result = await runDirect({ capabilities: undefined });
  assert.equal(result.termination.reason, "end_turn");
});

test("S3b 未知子键的报错必须早于任何宿主端口被读（Proxy 钉住）", async () => {
  const touched = [];
  const proxyPort = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`assembly port was read before the capabilities check: ${String(property)}`);
    },
  });
  const error = await runToolLoop({ assemblyPort: proxyPort, capabilities: { hoks: {} } })
    .then(() => null, (caught) => caught);
  assert.equal(error instanceof TypeError, true, `实际抛：${error && error.message}`);
  assert.match(error.message, /unknown capabilities namespace: "hoks"/u);
  assert.deepEqual(touched, [], "能力面的名称错误必须早于任何端口读取");
});

// ================================================================ S3. config.observers 没了 + config 里不许有函数
test("S4 config.observers 整组删除：写它 = 未知分组，8 个观察者键写进 config = 能力键报错并指向 capabilities.hooks", async () => {
  assert.equal(Object.hasOwn(CONFIG_NAMESPACE_SCHEMA, "observers"), false, "schema 里不许再有 observers 组");
  assert.equal(
    CONFIG_NAMESPACE_GROUPS.includes("observers"),
    false,
    "分组名单里不许再有 observers",
  );
  const groupError = await directError({ config: { observers: { onRound: () => {} } } });
  assert.equal(groupError instanceof TypeError, true);
  assert.match(groupError.message, /unknown config namespace: "observers"/u);

  for (const hook of ["onRound", "onJudge", "onToolResult", "onDelta", "onReasoningDelta", "onToolCall", "onUsage", "onFoldSummary"]) {
    const error = await directError({ config: { observers: { [hook]: () => {} } } });
    assert.match(error.message, /unknown config namespace: "observers"/u, `${hook} 所在的分组已经不在了`);
    // 组没了，但**写进任何组**都还会被能力面闸口点名（不是「未知叶子」那种含糊话）。
    const inGroup = await directError({ config: { run: { [hook]: () => {} } } });
    assert.match(inGroup.message, new RegExp(`config\\.run\\.${hook} is not accepted`, "u"));
    assert.match(inGroup.message, new RegExp(`capabilities\\.hooks\\.${hook}`, "u"), `${hook} 的报错必须说出去处`);
  }
});

test("S5 壳里的函数字段逐个点名完整路径（这些键实测真被当函数用）", async () => {
  const cases = [
    [
      { config: { timing: { retry: { attempts: 2, sleepImpl: () => {} } } } },
      "config.timing.retry.sleepImpl",
    ],
    [
      { config: { run: { reflection: { onReflection: () => {} } } } },
      "config.run.reflection.onReflection",
    ],
    [
      { config: { run: { reflection: { judge: { provider: () => {} } } } } },
      "config.run.reflection.judge.provider",
    ],
    // #498 S3：这一格问的是「壳里的**函数**字段被拒时，报错点名完整路径」。壳 `context` 现在住在
    // `config.folding.context`，函数写进去照样被 intake 拒——所以样本值就是函数本身。
    [
      { config: { folding: { context: { onBeforeFold: () => {} } } } },
      "config.folding.context.onBeforeFold",
    ],
    [
      { config: { folding: { context: { onAfterFold: () => {} } } } },
      "config.folding.context.onAfterFold",
    ],
    // #498 S4b：`config.guard.deliverables` 这个壳**整键不在配置面**了（搬去
    // `capabilities.checks.deliverables`），所以它的函数不再走「函数值」这条报错，
    // 而是走能力键那条（见 S5e）。这里换成仍在配置面的数据键塞函数：`config.input.tools`。
    // 复审：数据键**没有**能力面之家，所以它的尾巴是「there is no capability home for it」，
    // 而不是「its canonical home is none: …」（后者读不通）。
    [
      { config: { input: { tools: () => {} } } },
      "config.input.tools",
      /— there is no capability home for it: "tools" is a data key of the config namespace/u,
    ],
  ];
  for (const [options, path, homePattern = /— its canonical home is/u] of cases) {
    const error = await directError(options);
    assert.equal(error instanceof TypeError, true, path);
    assert.match(error.message, new RegExp(`${path.replace(/[.[\]]/gu, (ch) => `\\${ch}`)} is not accepted`, "u"), `${path} 必须被点名`);
    assert.match(error.message, /is a function, and the config namespace holds data only/u);
    assert.match(error.message, /JSON round-trip/u, "报错必须说清原因");
    assert.match(error.message, homePattern, `报错必须说出去处（${path}）`);
    assert.equal(error.via, "direct");
  }
});

test("S5b 函数拒绝不是「收下再丢」：抛在 intake（任何宿主端口被读之前），且合法数据照旧过", async () => {
  const touched = [];
  const proxyPort = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`assembly port was read before the config function check: ${String(property)}`);
    },
  });
  const error = await runToolLoop({
    assemblyPort: proxyPort,
    config: { folding: { context: { onBeforeFold: () => {} } } },
  }).then(() => null, (caught) => caught);
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /config\.folding\.context\.onBeforeFold is not accepted/u);
  assert.deepEqual(touched, [], "函数值必须在任何端口读取之前被拒");

  // 纯数据照旧过（不是「一律拒绝嵌套对象」）。
  // #498 S4b：`deliverables` 不再能从 `config` 里写（整键搬去 `capabilities.checks`），所以这条
  // 「合法数据」用例换成仍在配置面的 `input.tools` —— 它以前是能力键、写进 config 会抛。
  const ok = await runDirect({
    config: {
      folding: { context: { budgetTokens: 1000, summarizerBudgetMs: 5000 } },
      input: { tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }] },
      metadata: { toolContext: { workspace: "w" } },
    },
  });
  assert.equal(ok.termination.reason, "end_turn");
});

test("S5c finalGuard 属能力面：config.guard.finalGuard 抛，顶层扁平键照旧生效", async () => {
  const error = await directError({ config: { guard: { finalGuard: async () => ({ action: "accept" }) } } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /config\.guard\.finalGuard is not accepted/u);
  assert.match(error.message, /capability\/injection option/u);
  assert.equal(CAPABILITY_OPTION_NAMES.includes("finalGuard"), true, "finalGuard 的值必须是函数 ⇒ 能力面");
  assert.equal(configPathForOption("finalGuard"), undefined, "配置面不许再给它别名");

  let calls = 0;
  const result = await runDirect({
    finalGuard: async () => {
      calls += 1;
      return { action: "accept" };
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(calls, 1, "顶层 finalGuard 一字未动");
});

test("S5d 语义相仍管 config 展开后的键：config 里的 sleepImpl 给错型 ⇒ 语义相点名；扁平写法被名称闸口先拒", async () => {
  // #498 S3：`retry` 已无扁平写法（名称闸口先拒），所以「同一句」不再成立；这里改成两条各自钉住，
  // 反而多了一条升级线索的证据：扁平写法的报错必须**指向新家**。
  const nestedError = await directError({ config: { timing: { retry: { sleepImpl: "nope" } } } });
  assert.match(nestedError.message, /retry\.sleepImpl must be a function \(or omitted\)/u);
  assert.equal(nestedError.via, "direct");

  const flatError = await directError({ retry: { sleepImpl: "nope" } });
  assert.match(flatError.message, /its canonical home is config\.timing\.retry/u);
});

test("S6 collectConfigNamespaceProblems 纯函数：函数问题逐条可断言（含数组下标路径）", () => {
  assert.deepEqual(collectConfigNamespaceProblems({ run: { maxRounds: 1 } }), []);
  assert.deepEqual(
    collectConfigNamespaceProblems({ timing: { retry: { sleepImpl: () => {} } } }),
    [
      // #498 S4c：第三档不再含糊指「能力面端口位」，而是点名**真实目的地** `capabilities.ports.sleepImpl`。
      'config.timing.retry.sleepImpl is not accepted: "sleepImpl" is a function, and the config namespace'
        + " holds data only (the config subtree must survive a JSON round-trip unchanged)"
        + " — its canonical home is capabilities.ports.sleepImpl",
    ],
  );
  // 回调 leaf 的报错逐字点到 capabilities.hooks.<name>。
  assert.deepEqual(
    collectConfigNamespaceProblems({ run: { onRound: () => {} } }),
    [
      'config.run.onRound is not accepted: "onRound" is a capability/injection option,'
        + " and the capability surface cannot be overridden through the config namespace"
        + " (pass it as capabilities.hooks.onRound or as the top-level option)",
    ],
  );
});

// ================================================================ S4. 可枚举的 round-trip 机器断言
/**
 * 每个配置叶子的**代表性纯数据取值**（一叶一个）。
 *
 * 这不是「随便写点值」：它同时被 S7 的 round-trip 与 S8 的等价断言用，所以必须是
 * ① JSON 安全 ② 能过语义相（`persistence` 的字面量、`context` 的旋钮名、`session.id` …）。
 * 覆盖度由 S7 自己核：schema 里每多一个叶子而这里没有，就用**函数哨兵**顶上 ⇒ 那条用例当场红
 * 并点名该叶子（这正是「将来谁把函数键放进 config，它会立刻红」的机制）。
 */
const REPRESENTATIVE_CONFIG_VALUES = {
  // input（#498 S4b：`prompt` 改名 `input`，成员 = system + cacheStablePrefix + initialUserMessage
  // + `messages`（顶层 `initialMessages` 的嵌套别名）+ wrapup + `tools`（顶层 `tools` 的嵌套别名））
  system: "you are a test",
  cacheStablePrefix: false,
  initialUserMessage: "go",
  messages: [],
  wrapup: false,
  tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } }],
  // run
  maxRounds: 3,
  maxTokenContinuations: 2,
  stallDetection: false,
  completion: false,
  replayPolicy: "per-tool-declaration",
  invalidArguments: "execute",
  partialPersistence: false,
  persistence: "none",
  outputHygiene: false,
  writeToolNames: ["writeFile"],
  writeToolPathKeys: ["path"],
  resume: false,
  stream: false,
  reflection: false,
  runId: "config-498-run",
  cwd: "/tmp/config-498",
  // tuning
  maxTokens: 512,
  temperature: 0.2,
  topP: 0.9,
  cacheCapable: false,
  // timing
  timeoutMs: 1000,
  deadlineMs: 2000,
  retry: false,
  // folding（#498 S3 第二片：这三个叶子已经没有顶层扁平键，但**叶子仍在 schema 里**，
  // 所以它们照旧必须被 round-trip 覆盖名单取到值——「删了顶层键」不许让叶子漏测）
  // #498 S4c：两个**形态多态**旋钮的**数据形态**住在这里（`string` / `string[]`），所以它们必须进
  // round-trip 覆盖度名单并过逐字等值；它们的函数形态是 `capabilities.hooks.*`（行为载体，不进）。
  context: {
    budgetTokens: 1000,
    keepRounds: 2,
    protectedMessage: ["system", "user"],
    recoveryHint: "需要原文请重读文件",
  },
  toolResultTtl: 1,
  toolResultFoldMinTokens: 10,
  // guard
  finalGuardMaxRetries: 1,
  finalGuardTimeoutMs: 5000,
  finalGuardExtend: false,
  // metadata
  expert: "expert",
  user: "user",
  task: "task",
  requestId: "req-498",
  toolContext: { a: 1 },
  model: { contextWindowTokens: 100000, maxOutputTokens: 1024 },
  modelMetadata: { contextWindowTokens: 100000, maxOutputTokens: 1024 },
  session: { id: "config-498-b2", modelSlot: "default" },
};

/**
 * 配置叶子的**总数**——派生自 schema（`CONFIG_NAMESPACE_GROUPS` × `CONFIG_NAMESPACE_SCHEMA`），
 * 不手抄。删/加一个叶子时这里自动跟着走，「覆盖度」那条断言仍然可证伪（漏测才会红）。
 *
 * @returns {number}
 */
function configLeafCount() {
  return CONFIG_NAMESPACE_GROUPS.reduce((total, group) => total + CONFIG_NAMESPACE_SCHEMA[group].length, 0);
}

/** 按 schema 逐叶子组装整棵 `config`（分组从 schema 派生，不手写）。 */
function buildRepresentativeConfig() {
  const config = {};
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    config[group] = {};
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      config[group][leaf] = Object.hasOwn(REPRESENTATIVE_CONFIG_VALUES, leaf)
        ? REPRESENTATIVE_CONFIG_VALUES[leaf]
        // 函数哨兵：schema 里出现一个「没有人给它纯数据取值」的叶子 ⇒ 下面那条用例立刻红。
        : () => leaf;
    }
  }
  return config;
}

test("S7 逐叶子构造的 config 子树过 JSON round-trip 等值（函数叶子当场红并点名）", () => {
  const config = buildRepresentativeConfig();
  // ① 整棵树里不许有函数——**这条先跑**，于是「谁把函数键放进 config」报的就是这句并点名完整路径。
  const functionPaths = functionPathsIn(config, "config");
  assert.deepEqual(
    functionPaths,
    [],
    `config 子树里出现函数值（${functionPaths.join(", ")}）：配置面只装数据，`
      + "回调的规范之家是 capabilities.hooks（见 src/loop/capabilities-namespace.js）",
  );
  // ② 逐字等值：`JSON.parse(JSON.stringify(cfg))` 必须与原值深度相等（不是「差不多」）。
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config, "config 子树必须过 JSON round-trip 等值");
  // ③ 逐叶再核一遍（② 的失败信息是一整棵 diff，这里点名到叶子）。
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      const value = config[group][leaf];
      assert.deepEqual(
        JSON.parse(JSON.stringify(value)),
        value,
        `config.${group}.${leaf} 不是 JSON round-trip 安全的值`,
      );
    }
  }
  // ④ 覆盖度自证（#517 改成**逐叶子**核，与叶子有没有顶层键无关）：代表性取值表的键集必须与
  //    schema 的**叶子**集逐字相等（多一个、少一个都红）。这里刻意**不看**
  //    `RUN_TOOL_LOOP_OPTION_NAMES` / `CONFIG_SURFACE_OPTION_NAMES`：叶子需不需要被 round-trip
  //    摸过，与它当下有没有顶层扁平键是两件事——S3 会删掉一批顶层键，叶子一个都不许因此漏测。
  //    （函数哨兵 + ① 负责「当场红并点名」，这一段负责「没人给它纯数据取值」不许静默。）
  const leafPaths = CONFIG_NAMESPACE_GROUPS.flatMap(
    (group) => CONFIG_NAMESPACE_SCHEMA[group].map((leaf) => `${group}.${leaf}`),
  );
  const uncovered = leafPaths.filter((path) => !Object.hasOwn(REPRESENTATIVE_CONFIG_VALUES, path.split(".")[1]));
  assert.deepEqual(
    uncovered,
    [],
    `这些叶子没有代表性纯数据取值（round-trip 没人摸过）：${uncovered.join(", ")}`,
  );
  for (const path of leafPaths) {
    assert.equal(
      Object.hasOwn(REPRESENTATIVE_CONFIG_VALUES, path.split(".")[1]),
      true,
      `config.${path} 缺代表性取值（给 REPRESENTATIVE_CONFIG_VALUES 补一条纯数据）`,
    );
  }
  assert.deepEqual(
    Object.keys(REPRESENTATIVE_CONFIG_VALUES).sort(),
    leafPaths.map((path) => path.split(".")[1]).sort(),
    "每个配置叶子必须恰好一个代表性取值（schema 变了这张表必须跟着变）",
  );
  // 覆盖表按**叶子**索引，不是按顶层键——唯一一条改名的叶子就是机器证据：
  // `messages`（叶子）在表里，`initialMessages`（它的顶层扁平键）不在。
  assert.equal(Object.hasOwn(REPRESENTATIVE_CONFIG_VALUES, "messages"), true, "覆盖度按叶子名索引");
  assert.equal(
    Object.hasOwn(REPRESENTATIVE_CONFIG_VALUES, "initialMessages"),
    false,
    "覆盖度不得改成按顶层键索引（那样 S3 删完顶层键就会漏测叶子）",
  );
  // 条数派生（不手抄）：叶子总数 = schema 各组长度的和。
  assert.equal(leafPaths.length, configLeafCount(), "leafPaths 必须覆盖 schema 的全部叶子");
});

test("S8 逐叶子穷举：config.<group>.<leaf> 展开后与扁平形态逐键深度相等（43 条）", () => {
  let covered = 0;
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      const value = REPRESENTATIVE_CONFIG_VALUES[leaf];
      // 扁平形态用的是**顶层键名**（`input.messages` 的扁平孪生是 `initialMessages`）。
      const flat = { [configOptionNameForLeaf(group, leaf)]: value };
      const nested = expandConfigNamespace({ config: { [group]: { [leaf]: value } } });
      assert.deepEqual(nested.conflicts, [], `${group}.${leaf} 只给一边时不该有冲突`);
      assert.deepEqual(nested.options, flat, `${group}.${leaf} 展开后必须回到扁平形态`);
      assert.equal(Object.hasOwn(nested.options, "config"), false);
      covered += 1;
    }
  }
  assert.equal(covered, configLeafCount(), "穷举必须覆盖 schema 的全部配置叶子（漏一个就少一条等价证明）");
});

test("S9 端到端语义等价：整棵 config 与扁平形态规范化后逐键深度相等（timing 三键走展开写回）", async () => {
  const config = buildRepresentativeConfig();
  const flat = {};
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      flat[configOptionNameForLeaf(group, leaf)] = config[group][leaf];
    }
  }
  // #498 S3：一批配置叶子已经没有扁平写法，所以对照分两步（与 497 的 B2 同形）：
  //   ① 剩下的键：扁平形态 vs config 形态逐键深度相等；
  //   ② 已退役的键：展开相必须逐字写回 `effectiveOptions.<扁平名>`（引擎读侧读的就是它们）。
  // **哪些键已退役是派生集合**（`RETIRED_FLAT_KEYS` = 配置面叶子映射到的键里已不在白名单的那些），
  // 不是手抄的组名：`timing` 片、`folding` 片、本片（`input` 组的 `cacheStablePrefix` +
  // `initialMessages`）跑的是同一条判据，下一片也不需要改这里。
  const RETIRED_FLAT_KEYS = CONFIG_SURFACE_OPTION_NAMES
    .filter((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  const flatWithoutS3 = { ...flat };
  for (const key of RETIRED_FLAT_KEYS) delete flatWithoutS3[key];
  const nestedResult = await normalizeRunToolLoopOptions({ config });
  const flatResult = await normalizeRunToolLoopOptions({ ...flatWithoutS3 });
  const nestedRest = { ...nestedResult.effectiveOptions };
  for (const key of RETIRED_FLAT_KEYS) {
    // ② 展开相逐字写回扁平名——「删了顶层键、引擎读侧一行都不用改」的机制证据。
    assert.deepEqual(
      nestedResult.effectiveOptions[key],
      flat[key],
      `${key}：config 形态展开后必须逐字写回 effectiveOptions.${key}（引擎读侧读的就是它）`,
    );
    assert.equal(
      Object.hasOwn(flatResult.effectiveOptions, key),
      false,
      `${key} 的扁平写法已退役，扁平形态不该再产生它`,
    );
    delete nestedRest[key];
  }
  // ① 其余键逐键深度相等。
  assert.deepEqual(nestedRest, flatResult.effectiveOptions, "除已退役的键以外，两种形态必须逐键深度相等");
  for (const [key, value] of Object.entries(flatResult.effectiveOptions)) {
    assert.deepEqual(nestedResult.effectiveOptions[key], value, `${key} 两种形态必须逐键相等`);
  }
  assert.equal(Object.hasOwn(nestedResult.effectiveOptions, "config"), false, "config 不得漏进 effectiveOptions");
  assert.deepEqual(nestedResult.configConflicts, []);

  // 行为层再钉一次：整棵 config 真的能被引擎跑起来（不是「规范化通过了但一跑就炸」）。
  // `config.metadata.session` 在场 ⇒ 走细粒度端口形状，于是 `modelConfig` 必须能 resolve（与扁平形态同口径）。
  const result = await runDirect({
    config,
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
  });
  assert.equal(result.termination.reason, "end_turn");
});

// ================================================================ S10. `capabilities.checks`（#498 S4b）
//
// 交付物判据是宿主**行为**（`check` 是函数），所以它属能力面。以前它挂在 `config.guard.deliverables`
// 上，而配置面只装数据 ⇒ 能写的只有 `[]`（一个「只能写空数组」的过渡态）。本刀把它整键搬进
// `capabilities.checks.deliverables`，过渡态消失，而顶层扁平 `deliverables` 一字未动。
test("S10 capabilities.checks.deliverables：展开回扁平键、形状逐条校、与扁平键冲突不静默", () => {
  const entry = { name: "report", check: () => true };
  const expanded = expandCapabilitiesNamespace({ capabilities: { checks: { deliverables: [entry] } } });
  assert.deepEqual(expanded.conflicts, []);
  assert.deepEqual(expanded.options.deliverables, [entry], "展开后就是顶层 deliverables 那一个数组");
  assert.equal(Object.hasOwn(expanded.options, "capabilities"), false);

  // 只给一边 / 两边同值 ⇒ 不算冲突；两边不同（不同条目）⇒ 记一条，path/key 逐字。
  assert.deepEqual(
    expandCapabilitiesNamespace({ deliverables: [entry], capabilities: { checks: { deliverables: [entry] } } }).conflicts,
    [],
  );
  const conflict = expandCapabilitiesNamespace({
    deliverables: [entry],
    capabilities: { checks: { deliverables: [{ name: "other", check: () => true }] } },
  });
  assert.deepEqual(conflict.conflicts, [{ path: "checks.deliverables", key: "deliverables" }]);
  // capabilities 侧赢（与 hooks 侧同向优先级）。
  assert.equal(conflict.options.deliverables[0].name, "other");

  // 形状规则复用 `normalizeDeliverables`（不在这里手抄第二份），判词挂在完整路径上。
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ checks: { deliverables: "nope" } }),
    ["capabilities.checks.deliverables is not accepted: deliverables must be an array of { name, check }"],
  );
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ checks: { deliverables: [{ name: "x" }] } }),
    ["capabilities.checks.deliverables is not accepted: deliverables[0].check must be a function"],
  );
  assert.deepEqual(collectCapabilitiesNamespaceProblems({ checks: "nope" }), ["capabilities.checks must be an object"]);
  // 空数组 = 未声明（与扁平 `deliverables: []` 同口径），不是错误。
  assert.deepEqual(collectCapabilitiesNamespaceProblems({ checks: { deliverables: [] } }), []);
});

test("S10b capabilities.checks.deliverables 真被引擎核（不是「展开了但没人读」）", async () => {
  const seen = [];
  const result = await runDirect({
    finalGuard: async () => ({ action: "accept" }),
    capabilities: {
      checks: {
        deliverables: [{
          name: "report",
          check: (facts) => {
            seen.push(facts);
            return true;
          },
        }],
      },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(seen.length, 1, "判据恰好被核一次（guard 调用之前）");
  assert.equal(result.verification.status, "verified", "判据通过 + guard accept ⇒ verified");
  // 对照组：同一份判据写扁平写法必须同形（纯加法，不是搬家）。
  const flatSeen = [];
  const flatRun = await runDirect({
    finalGuard: async () => ({ action: "accept" }),
    deliverables: [{ name: "report", check: () => { flatSeen.push(1); return true; } }],
  });
  assert.equal(flatRun.verification.status, "verified");
  assert.equal(flatSeen.length, 1);
});

test("S10c 能力键那条闸口覆盖 deliverables：写进 config 抛并指向 capabilities.checks", async () => {
  const error = await directError({ config: { guard: { deliverables: [] } } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /config\.guard\.deliverables is not accepted/u);
  assert.match(error.message, /capability\/injection option/u);
  assert.match(error.message, /capabilities\.checks\.deliverables/u, "报错必须点出新家（不是含糊的「能力面」）");
  assert.equal(configPathForOption("deliverables"), undefined, "配置面不许再给它别名");
});

// ================================================================ S11. `capabilities.hooks.finalGuard`（#498 S4b）
test("S11 finalGuard 是 hooks 的第 12 个成员：config.guard.finalGuard 抛，capabilities.hooks.finalGuard 真被调", async () => {
  // 形状闸口：hooks 的叶子给了就必须是函数（与其它 11 个同一条规则）。
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ hooks: { finalGuard: "nope" } }),
    ["capabilities.hooks.finalGuard must be a function (or omitted)"],
  );
  // 配置面里仍然拒绝（值必须是函数 ⇒ 按判据它是行为载体）。
  const error = await directError({ config: { guard: { finalGuard: async () => ({ action: "accept" }) } } });
  assert.match(error.message, /config\.guard\.finalGuard is not accepted/u);
  assert.match(error.message, /capabilities\.hooks\.finalGuard/u, "报错必须点出新家");

  // 行为证据：`capabilities.hooks.finalGuard` 与顶层扁平 `finalGuard` 是同一个键（真被调一次）。
  let calls = 0;
  const result = await runDirect({
    capabilities: {
      hooks: {
        finalGuard: async () => {
          calls += 1;
          return { action: "accept" };
        },
      },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(calls, 1, "capabilities.hooks.finalGuard 必须被调用（消费点 `callFinalGuard` → `finalGuard(payload)`）");
  assert.equal(result.verification.status, "verified");
});
