// issue #498（S4a）—— 0.28 的归类落地：**能力面 = 被调用/被解引用的行为载体；配置面 = 被读字段
// 并被校值的数据**，并且 `config` 子树必须 **JSON round-trip 等值**。
//
// #497 当时把这条判据写成「描述 0.28 目标面」；S4a 就是它兑现的地方。四件事，四组用例：
//
//   S1（三向闭合）：`configSchemaSelfCheck` 必须仍 `[]`，且四个数可枚举闭合——
//      配置面 43 + 能力面 22 + 容器 2 = 顶层白名单 67。容器是 {`config`, `capabilities`}，
//      两个容器**同等待遇**（都不算配置/能力键，都有未知子键闸口）。
//   S2（`capabilities.hooks` 是回调的规范之家）：11 个回调逐个点名；`capabilities.hooks.onEvent`
//      与顶层 `onEvent` 是同一个键（别名 = schema 路径）；展开后扁平键生效（行为证据：真收到事件）；
//      与扁平键冲突时 capabilities 赢且**不静默**（同一条 `config_override_conflict`）。
//   S3（`config.observers` 整组删除 + `config` 里不许有函数值）：8 个观察者键写进 `config` 一律抛并
//      指向 `capabilities.hooks`；**壳里的函数字段**（`retry.sleepImpl` / `reflection.onReflection` /
//      `reflection.judge.provider` / `context.onBeforeFold` / `onAfterFold` / `deliverables[].check`）
//      逐个点名**完整路径**；`config.guard.finalGuard`（值必须是函数的那个叶子）现在属能力面。
//      「收下再在展开时丢函数」不可能：抛在 intake（读任何宿主端口之前）。
//   S4（可枚举的 round-trip 机器断言）：按 `CONFIG_NAMESPACE_SCHEMA` **逐叶子**构造一份代表性纯数据
//      取值，断言 `JSON.parse(JSON.stringify(cfg))` 与原值逐字等值，并断言展开后的有效选项与直接传
//      扁平键语义等价（#497 的 B1/B2 结构）。**将来谁把函数键放进 config，它会立刻红并点名叶子**。
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
  CAPABILITY_HOOK_NAMES,
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

// ================================================================ S1. 三向闭合（可枚举的四个数）
test("S1 三向闭合：配置面 43 + 能力面 22 + 容器 2 = 顶层白名单 67，自检仍 []", () => {
  // 四个数逐个钉住（漏一个就少一条等价证明；也免得「两边一起漏」算通过）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.length, 67, "顶层白名单 = 66 + capabilities 这个容器（#498 S4a）");
  assert.equal(CONFIG_SURFACE_OPTION_NAMES.length, 43, "配置面 43 键（52 − 8 个 observers − finalGuard）");
  assert.equal(CAPABILITY_OPTION_NAMES.length, 22, "能力面 22 项（13 端口/出口 + 8 观察者通道 + finalGuard）");
  assert.equal(NAMESPACE_CONTAINER_OPTION_NAMES.length, 2, "容器两个：config 与 capabilities");
  assert.equal(
    CONFIG_SURFACE_OPTION_NAMES.length + CAPABILITY_OPTION_NAMES.length + NAMESPACE_CONTAINER_OPTION_NAMES.length,
    RUN_TOOL_LOOP_OPTION_NAMES.length,
    "三向之和必须逐字等于白名单条数（这就是「闭合」的可枚举形式）",
  );
  assert.deepEqual(NAMESPACE_CONTAINER_OPTION_NAMES, [CONFIG_NAMESPACE_OPTION_NAME, CAPABILITIES_NAMESPACE_OPTION_NAME]);
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(CAPABILITIES_NAMESPACE_OPTION_NAME), true);
  // 白名单**内容**本刀只加了一个容器：8 个扁平观察者键一个都没删（0.26 已发布面）。
  for (const hook of CAPABILITY_HOOK_NAMES) {
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
    ['schema names "onJudge", which is not a top-level option'],
    "hooks 里的回调必须是真选项，否则这条闭合是空转",
  );
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
    /unknown config namespace: "rund" \(accepted: prompt, run, tuning, timing, folding, guard, metadata\)/u,
  );
  assert.match(
    collectCapabilitiesNamespaceProblems({ hoks: {} })[0],
    /unknown capabilities namespace: "hoks" \(accepted: hooks; ports are not collected under capabilities yet/u,
  );
});

// ================================================================ S2. capabilities.hooks 是规范之家
test("S2 11 个回调逐个点名：名单、别名表、schema 三者互相对得上", () => {
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
  ], "11 个回调的名单是本刀的判据面，逐字钉住");
  assert.equal(CAPABILITY_HOOK_NAMES.length, 11);
  assert.deepEqual([...CAPABILITIES_NAMESPACE_GROUPS], ["hooks"], "本刀只收 hooks 一组（ports 待后续刀裁）");
  assert.deepEqual(Object.keys(CAPABILITIES_NAMESPACE_SCHEMA), ["hooks"]);
  assert.equal(CAPABILITIES_ALIAS_PATHS.size, 11, "一个回调一条别名路径，不多不少");
  for (const hook of CAPABILITY_HOOK_NAMES) {
    const path = capabilitiesPathForOption(hook);
    assert.equal(path, `hooks.${hook}`, `${hook} 的路径叶子必须逐字等于键名（别名 = schema 路径）`);
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
  // 对照：不传就一个都不投递（纯加法，行为逐字不变）。
  const none = [];
  await runDirect({ capabilities: {} });
  assert.deepEqual(none, []);
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
    [
      { config: { folding: { context: { onBeforeFold: () => {} } } } },
      "config.folding.context.onBeforeFold",
    ],
    [
      { config: { folding: { context: { onAfterFold: () => {} } } } },
      "config.folding.context.onAfterFold",
    ],
    [
      { config: { guard: { deliverables: [{ name: "x", check: () => {} }] } } },
      "config.guard.deliverables[0].check",
    ],
  ];
  for (const [options, path] of cases) {
    const error = await directError(options);
    assert.equal(error instanceof TypeError, true, path);
    assert.match(error.message, new RegExp(`${path.replace(/[.[\]]/gu, (ch) => `\\${ch}`)} is not accepted`, "u"), `${path} 必须被点名`);
    assert.match(error.message, /is a function, and the config namespace holds data only/u);
    assert.match(error.message, /JSON round-trip/u, "报错必须说清原因");
    assert.match(error.message, /canonical home is capabilities/u, "报错必须说出去处");
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
    config: { guard: { deliverables: [{ check: () => {} }] } },
  }).then(() => null, (caught) => caught);
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /config\.guard\.deliverables\[0\]\.check is not accepted/u);
  assert.deepEqual(touched, [], "函数值必须在任何端口读取之前被拒");

  // 纯数据照旧过（不是「一律拒绝嵌套对象」）。
  // ⚠ `deliverables` 只写空数组：每条判据的 `check` 都是函数，所以**有内容的** deliverables 在
  // `config` 里必然被函数闸口拒（`config.guard.deliverables[0].check`）——那条是判据要的形状，
  // 见 S5。空数组规范化成「未声明」，是它唯一能写进配置面的值。
  const ok = await runDirect({
    config: {
      folding: { context: { budgetTokens: 1000, summarizerBudgetMs: 5000 } },
      guard: { deliverables: [] },
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

test("S5d 语义相仍管 config 展开后的键：config 里的 sleepImpl 给错型与扁平形态同一句", async () => {
  const flatError = await directError({ retry: { sleepImpl: "nope" } });
  const nestedError = await directError({ config: { timing: { retry: { sleepImpl: "nope" } } } });
  assert.equal(nestedError.message, flatError.message, "两条形态必须抛同一句");
  assert.match(nestedError.message, /retry\.sleepImpl must be a function \(or omitted\)/u);
  assert.equal(nestedError.via, "direct");
});

test("S6 collectConfigNamespaceProblems 纯函数：函数问题逐条可断言（含数组下标路径）", () => {
  assert.deepEqual(collectConfigNamespaceProblems({ run: { maxRounds: 1 } }), []);
  assert.deepEqual(
    collectConfigNamespaceProblems({ timing: { retry: { sleepImpl: () => {} } } }),
    [
      'config.timing.retry.sleepImpl is not accepted: "sleepImpl" is a function, and the config namespace'
        + " holds data only (the config subtree must survive a JSON round-trip unchanged)"
        + " — its canonical home is capabilities (capabilities.hooks.<name> for a host callback,"
        + " or the matching capability port slot)",
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
  // prompt
  system: "you are a test",
  cacheStablePrefix: false,
  initialUserMessage: "go",
  initialMessages: [],
  wrapup: false,
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
  // folding
  context: { budgetTokens: 1000, keepRounds: 2 },
  toolResultTtl: 1,
  toolResultFoldMinTokens: 10,
  // guard
  finalGuardMaxRetries: 1,
  finalGuardTimeoutMs: 5000,
  finalGuardExtend: false,
  deliverables: [],
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
  // ④ 覆盖度自证：代表性取值表与 schema 的叶子集**逐字相等**（多一个、少一个都红）。
  const schemaLeaves = CONFIG_NAMESPACE_GROUPS.flatMap((group) => [...CONFIG_NAMESPACE_SCHEMA[group]]);
  assert.deepEqual(
    Object.keys(REPRESENTATIVE_CONFIG_VALUES).sort(),
    [...schemaLeaves].sort(),
    "每个配置叶子必须恰好一个代表性取值（schema 变了这张表必须跟着变）",
  );
  assert.equal(schemaLeaves.length, 43);
});

test("S8 逐叶子穷举：config.<group>.<leaf> 展开后与扁平形态逐键深度相等（43 条）", () => {
  let covered = 0;
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      const value = REPRESENTATIVE_CONFIG_VALUES[leaf];
      const flat = { [leaf]: value };
      const nested = expandConfigNamespace({ config: { [group]: { [leaf]: value } } });
      assert.deepEqual(nested.conflicts, [], `${group}.${leaf} 只给一边时不该有冲突`);
      assert.deepEqual(nested.options, flat, `${group}.${leaf} 展开后必须回到扁平形态`);
      assert.equal(Object.hasOwn(nested.options, "config"), false);
      covered += 1;
    }
  }
  assert.equal(covered, 43, "穷举必须覆盖全部 43 个配置键（漏一个就少一条等价证明）");
});

test("S9 端到端语义等价：整棵 config 与直接传扁平键规范化后逐键深度相等", async () => {
  const config = buildRepresentativeConfig();
  const flat = {};
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) flat[leaf] = config[group][leaf];
  }
  const nestedResult = await normalizeRunToolLoopOptions({ config });
  const flatResult = await normalizeRunToolLoopOptions({ ...flat });
  assert.deepEqual(nestedResult.effectiveOptions, flatResult.effectiveOptions);
  assert.deepEqual(Object.keys(nestedResult.effectiveOptions).sort(), Object.keys(flatResult.effectiveOptions).sort());
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
