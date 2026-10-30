// issue #571（片1）：`createAgent` —— 把「初始化一次的配置」与「每一次调用的数据」分成两个位置。
//
// 病根（issue #524，已 by-design 关闭）：0.28 之后 `runToolLoop(一次调用的全部东西)` 是唯一入口、
// **没有 agent 对象**，所以「初始化一次的配置」与「这一次的数据」挤在同一个参数对象里。真实代价：
// 本次输入有两条通道，`config.input.messages` 那条**一传就整棵覆盖**装配口的 `policy.config`
// （折叠 TTL / 上下文预算 / 持久化开关全消失），触发它的动作只是「发一条消息」。
// #571 的解不是改覆盖语义（不做深合并、不加诊断字段），而是给「初始化」一个位置——本文件钉的就是
// 那个位置的**行为**，不是它的实现。
//
// **片2（J 组）把那个代价翻面**：片1 + #574 之后仍漏的形状是「旋钮只写在端口 `policy.config` 上 +
// `agent.run({ messages })`」——`messages` 是 `call` 叶 ⇒ 树在场 ⇒ 整棵顶掉端口那棵，而覆盖后的两道
// 填充补不回宿主写在 `policy.config` 里的叶子。片2 在**包装层**给那棵树一个与端口那棵**内容等价**的
// 种子（端口 `policy.config` 的拷贝），引擎的覆盖语义与逐叶事件一个字没改。
//
// 四格（工单点名的四格 + 顺手的三格）：
//   A. 绑定表与 `CONFIG_NAMESPACE_SCHEMA` 的 **41 叶**逐字对账（集合相等，不多不少不拼错），且
//      引擎侧自检把同一条恒等式钉成红/绿（加叶子忘标绑定 = 当场红）。
//   B. **#524 场景的正向断言**：初始化时配 `folding.toolResultTtl`，`agent.run({ messages })` 之后
//      该旋钮**仍然生效**（真 run：第二发请求里第一轮的工具结果已被 TTL 折叠）。
//   C. **两个方向**的绑定冲突各硬拒并指名新家（`init` 叶写在 `run(input)` / `call` 叶写在
//      `createAgent`），一个字都不许静默忽略。
//   D. 初始化时的坏值在 `createAgent()` **当场失败**（不是等到 `run()`）。
//
// 另外三格防「看起来实现了其实空转」：`run(input)` 递不进第二个 `config`（#524 的结构性封口）、
// 同一 agent 两次调用里 `call` 叶逐次不同而 init 树不动、以及「包装不是第二套引擎」——同样的选项
// 走 `runToolLoop` 与走 `createAgent` + `run` 必须逐字同结果。
//
// 片2 的六格（J 组，工单 §4）：
//   J1. **I3 翻面**：§0 那段形状（只发一条消息）⇒ 折叠生效 + `run.maxRounds` 仍按端口值 + 消息到达
//       provider + 事件条数 = 0（坑 1 的实测结论，见格子里的理由）。
//   J2. 种子是**拷贝**：`run()` 前后 `assemblyPort.policy` 逐字相同（含深冻结的宿主树）。
//   J3. 两跳收成一条：顶层扁平 `initialMessages` 一次调用即指名最终家 `agent.run({ messages })`。
//   J4. 旁路载体口径：`session.initialMessages` / `session.id` 是**端口级 feeder**，`config.input.messages`
//       是**唯一叶**（同时给 ⇒ 叶赢 + 恰一条事件）。
//   J5. init 级 `signal` 的语义裁定（有意：agent 级取消；`run({ signal })` 只覆盖本次）。
//   J6. 完整性证据：逐个入口点名（`config` 树 / `session` 容器 / 顶层扁平退役名）。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_ALIAS_PATHS,
  CONFIG_LEAF_BINDING,
  CONFIG_LEAF_BINDING_VALUES,
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_SCHEMA,
  configLeafNamesForBinding,
  configSchemaSelfCheck,
} from "../src/loop/config-namespace.js";
import { RUN_TOOL_LOOP_OPTION_NAMES, RUN_TOOL_LOOP_OPTION_SET } from "../src/loop/option-normalization.js";
import { createAgent, runToolLoop } from "../src/loop/orchestrator.js";
import { assemblyPortPolicyConfigSeed } from "../src/assembly.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
// #574：I 组要一个**真的装配端口**（旋钮写在 `policy.config` 上，不是写在调用级 `config` 里），
// 以及引擎侧规范化入口——反向证要证「修的是包装递不递树，不是引擎的合并规则」。
// #571 片2：J4/J6 还要 `sessionDerivedConfigLeaves`（`session` 容器的派生叶是**唯一**口径）。
import { createAssemblyPort, sessionDerivedConfigLeaves } from "../src/assembly.js";
import { normalizeRunToolLoopOptions } from "../src/loop/option-normalization.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** schema 里的全部叶子路径（`"<group>.<leaf>"`，分组顺序 + 组内顺序）——**派生，不手抄**。 */
const SCHEMA_LEAF_PATHS = CONFIG_NAMESPACE_GROUPS.flatMap(
  (group) => CONFIG_NAMESPACE_SCHEMA[group].map((leaf) => `${group}.${leaf}`),
);

/** 初始化时那一份「不写就等默认」的最小行为面（`wrapup` / `completion` 关掉，一次 end_turn 就结束）。 */
const QUIET = { input: { wrapup: false }, run: { completion: false } };

/** 一个只回一句话的 provider（每次调用换一个实例，脚本长度按需）。 */
function provider(script = DONE) {
  return createFakeProvider(script.map((step) => ({ ...step })));
}

/** `createAgent` 的最小合法 init（`config` 可覆盖：容器是**合并**进去的，不是整体顶掉）。 */
function init(extra = {}) {
  const { config, ...rest } = extra;
  return {
    provider: provider(),
    executeTool: async () => "ok",
    config: { ...QUIET, ...config },
    ...rest,
  };
}

// ================================================================ A. 绑定表 × 41 叶对账
//
// 这一格是「只有一张表」的锁：判据两侧都从真值派生（叶子集合来自 `CONFIG_NAMESPACE_SCHEMA`，
// 键集合来自 `CONFIG_LEAF_BINDING`），所以**没有第二份手写清单**可以跟它各改各的。
// 加一个叶子却忘了标绑定 ⇒ 这里少一条（集合不等）；删一个叶子却留着绑定 ⇒ 这里多一条。

test("A1 绑定表覆盖的叶子集合 == schema 的 43 叶集合（不多、不少、拼写逐字一致）", () => {
  const bound = Object.keys(CONFIG_LEAF_BINDING).sort();
  const schema = [...SCHEMA_LEAF_PATHS].sort();
  assert.deepEqual(bound, schema,
    "绑定表与 schema 的叶子集合必须逐字相等：少的 = 加了叶子忘标绑定，多的 = 绑定表里有一条死条目");
  // issue #617（P0）：`run.parentRunId` 入表 ⇒ 42 → 43。
  assert.equal(bound.length, 43, `配置面是 43 叶（现测 ${bound.length}）——数字变了就要连这条一起改，别让它空转`);
  assert.equal(new Set(bound).size, bound.length, "绑定表的键不许重复（重复 = 一张表被写成了两张）");
});

test("A2 两档都真被用到、叶子名在组之间唯一（`agent.run` 的键不歧义），且引擎侧自检与它对账", () => {
  for (const binding of CONFIG_LEAF_BINDING_VALUES) {
    assert.ok(configLeafNamesForBinding(binding).length > 0,
      `没有任何叶子被标成 ${JSON.stringify(binding)}：这一档退化成死值，绑定表也就不再是判据`);
  }
  for (const value of Object.values(CONFIG_LEAF_BINDING)) {
    assert.ok(CONFIG_LEAF_BINDING_VALUES.includes(value),
      `绑定只有 ${CONFIG_LEAF_BINDING_VALUES.join(" / ")} 两档，实测 ${JSON.stringify(value)}`);
  }
  // `agent.run({ … })` 按**叶子名**寻址，所以「两个组撞同一个叶子名」会让那个键有歧义。
  const names = [...configLeafNamesForBinding("init"), ...configLeafNamesForBinding("call")];
  assert.equal(new Set(names).size, names.length, "叶子名在组之间必须唯一（agent.run 用叶子名做键）");
  // 引擎侧的同一条恒等式：`configSchemaSelfCheck` 把「少一条绑定 / 多一条死条目 / 值不是两档 /
  // 叶子名重复」全报成问题 ⇒ 上面那条集合相等不是本文件自说自话。
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [],
    "绑定表与 schema 的对账在引擎侧也必须是绿的（它才是「加叶子忘标 = 当场红」那道闸）");
});

// ================================================================ B. #524 的正向断言
//
// 这一格是整张单的靶心：**同一个 agent**，配置里写了 `folding.toolResultTtl`，然后只是「发一条消息」
// （`run({ messages })`）。修前那条通道会把整棵 `config` 顶掉，TTL 随之消失（折叠一次都不跑）；
// 修后 TTL 仍然生效——判据不看实现，看第二发请求里第一轮的工具结果是不是已经被折叠。

test("B1 #524 正向：初始化配的 folding.toolResultTtl 在 agent.run({ messages }) 之后仍然生效", async () => {
  // ⚠ 轮数预算必须留够：TTL 层在「剩余轮数 ≤ 2」时按既有口径关闭，3 轮的 run 里它一次都不会开，
  // 那条断言就变成「测空气」（口径与 test/loop-folding-slice-498s3b.test.js 的 R2 同一句）。
  const script = Array.from({ length: 6 }, (_unused, index) => ({
    content: [{ type: "tool_use", id: `t${index}`, name: "work", input: {} }],
    stopReason: "tool_use",
  }));
  script.push({ content: [{ type: "text", text: "done" }], stopReason: "end_turn" });
  const fake = provider(script);
  const agent = createAgent({
    provider: fake,
    executeTool: async () => `ORIGINAL-OUTPUT ${"y".repeat(300)}`,
    config: {
      input: { wrapup: false },
      run: { completion: false, maxRounds: 8 },
      folding: { toolResultTtl: 1, toolResultFoldMinTokens: 1 },
    },
  });
  // 这一次调用**只给数据**：种子消息走 `call` 通道（`config.input.messages`），正是 #524 里
  // 「一传就整棵覆盖」的那条通道。
  const result = await agent.run({
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  });
  const second = JSON.stringify(fake.requests[1]?.messages ?? []);
  assert.equal(second.includes("ORIGINAL-OUTPUT"), false,
    "初始化配的 toolResultTtl=1 必须让上一条工具结果被折叠——这里还看到原文，说明 run(input) 把整棵 "
    + `config 顶掉了（#524 回来了）；实测 ${second.slice(0, 400)}`);
  assert.equal(second.includes("已折叠·TTL"), true, "折叠必须走 TTL 占位符（而不是被别的层顺手删掉）");
  assert.equal(result.termination.reason, "end_turn");
});

test("B2 #524 的结构性封口：run(input) 递不进第二个 config（配置只有一个来源）", () => {
  const agent = createAgent(init());
  assert.throws(() => agent.run({ config: { folding: { toolResultTtl: 1 } } }), (error) => {
    assert.equal(error instanceof TypeError, true);
    assert.equal(
      error.message,
      'agent.run({ config: … }): config is an initialization option — pass it to createAgent({ … })'
        + " instead (issue #571)",
      "整棵覆盖在这个形状下不是「被禁止」，而是**递不进去**——判词必须把去处说清（createAgent）",
    );
    return true;
  });
});

// ================================================================ C. 两个方向的绑定冲突
//
// 工单要求：两个方向都硬拒 + **指名新家**，一个字都不许静默忽略。判词用逐字相等断言——
// 宿主靠这两句话改代码，措辞漂了就没人能照着改。

test("C1 call 叶写在 createAgent({ config }) ⇒ 硬拒，判词指名 agent.run({ <leaf> })", () => {
  for (const [group, leaf] of [
    ["input", "messages"],
    ["input", "initialUserMessage"],
    ["run", "runId"],
    ["run", "resume"],
    ["metadata", "task"],
  ]) {
    assert.throws(
      () => createAgent(init({ config: { [group]: { [leaf]: "x" } } })),
      (error) => {
        assert.equal(error instanceof TypeError, true, `${group}.${leaf} 必须抛 TypeError`);
        assert.equal(
          error.message,
          `createAgent({ config: { ${group}: { ${leaf}: … } } }): config.${group}.${leaf} is per-call`
            + ` data — write it in agent.run({ ${leaf}: … }) instead (issue #571: the config tree is`
            + " fixed at initialization and is the agent's single config source)",
          `${group}.${leaf} 是 call 叶：判词必须点名它在 agent.run 里的写法，否则宿主只会换个位置再撞一次`,
        );
        return true;
      },
    );
  }
});

test("C2 init 叶写在 agent.run(input) ⇒ 硬拒，判词指名 createAgent({ config: { <group>: { <leaf> } } })", () => {
  const agent = createAgent(init());
  for (const [leaf, group] of [
    ["maxRounds", "run"],
    ["toolResultTtl", "folding"],
    ["system", "input"],
    ["temperature", "tuning"],
    ["cwd", "run"],
  ]) {
    assert.throws(() => agent.run({ [leaf]: 1 }), (error) => {
      assert.equal(error instanceof TypeError, true, `${leaf} 必须抛 TypeError`);
      assert.equal(
        error.message,
        `agent.run({ ${leaf}: … }): ${leaf} is an initialization knob (config.${group}.${leaf}) —`
          + ` write it in createAgent({ config: { ${group}: { ${leaf}: … } } }) instead (issue #571)`,
        `${leaf} 是 init 叶：判词必须点名它的配置路径与 createAgent 里的写法`,
      );
      return true;
    });
  }
});

// ================================================================ D. 初始化时就失败
//
// 「在初始化时把校验做完」的可观察形态：坏值在 `createAgent()` 那一刻抛，而不是等第一次 run。
// 用的都是**既有**闸口（名称/形状/函数值/未知叶子），本片没有新增逐叶类型规则——那是后续单。

test("D1 初始化时的坏值在 createAgent() 当场失败（不等 run()）", () => {
  const cases = [
    // 未知键：与 runToolLoop 同一道名称闸口（同一个白名单、同一句判词）。
    [{ provider: provider(), executeTool: async () => "ok", notAnOption: 1 },
      /^unknown runToolLoop option: "notAnOption"/u],
    // `config` 里出现函数值：`config` 只装数据（round-trip 判据），判词点名能力面。
    [init({ config: { input: { system: () => "SYS" } } }), /config\.input\.system is not accepted/u],
    // 未知配置组 / 未知叶子：配置面的名称闸口在初始化时跑。
    [init({ config: { nope: {} } }), /^unknown config namespace: "nope"/u],
    [init({ config: { input: { systemPropmt: "SYS" } } }), /^unknown config\.input option: "systemPropmt"/u],
    // `capabilities` 的名称/形状闸口同样在初始化时跑。
    [init({ capabilities: { nope: {} } }), /^unknown capabilities namespace: "nope"/u],
  ];
  for (const [options, expected] of cases) {
    assert.throws(() => createAgent(options), (error) => {
      assert.equal(error instanceof TypeError, true);
      assert.match(error.message, expected);
      return true;
    });
  }
  // 同一个坏值走 `runToolLoop` 是在**调用时**（异步）才抛的——两处是同一条规则，只是相位不同。
  // 这条对账保证「createAgent 提前抛」不是因为它另有一套判词，而是因为它在初始化时就把同一道闸口跑了。
  return assert.rejects(
    runToolLoop({ provider: provider(), executeTool: async () => "ok", config: { nope: {} } }),
    /^TypeError: unknown config namespace: "nope"/u,
  );
});

// ================================================================ E–H. 反空转 / 边界
//
// 这四格防的是「看起来实现了其实空转」：接受名单必须从绑定表派生（不是硬编码一句安慰话）、
// call 叶逐次真的生效（不是被吞掉）、包装不是第二套引擎、call 叶仍走引擎自己的逐叶值规则。

test("E1 run(input) 的未知键：接受名单从绑定表派生（call 叶 + signal），不是硬编码", () => {
  const agent = createAgent(init());
  const accepted = `${configLeafNamesForBinding("call").join(", ")}, signal`;
  assert.throws(() => agent.run({ nope: 1 }), (error) => {
    assert.equal(error instanceof TypeError, true);
    assert.equal(
      error.message,
      `unknown agent.run option: "nope" (accepted: ${accepted})`,
      "接受名单必须与 CONFIG_LEAF_BINDING 的 call 档逐字一致（硬编码一句就会与表各改各的）",
    );
    return true;
  });
  // 顶层行为面写进 run 也指名去处（不是「未知」，而是「属初始化」）。
  assert.throws(() => agent.run({ provider: null }), /provider is an initialization option/u);
  // `signal` 是每次调用的东西，必须收下（这里只证「收下」：中止语义归引擎，本片不碰）。
  return agent.run({ signal: new AbortController().signal });
});

test("F1 同一个 agent 两次调用：call 叶逐次不同，init 那棵树不动（finalGuard 载荷的 runId 证据）", async () => {
  const seen = [];
  const agent = createAgent({
    provider: provider([...DONE, ...DONE]),
    executeTool: async () => "ok",
    config: QUIET,
    capabilities: {
      hooks: {
        finalGuard: async (payload) => {
          seen.push(payload);
          return { action: "accept" };
        },
      },
    },
  });
  await agent.run({ runId: "run-a" });
  await agent.run({ runId: "run-b" });
  assert.deepEqual(seen.map((payload) => payload.runId), ["run-a", "run-b"],
    "runId 是 call 叶：同一个 agent 连着两次调用必须给出两个不同的身份（且都真的到了引擎）");
});

test("G1 包装不是第二套引擎：同样的选项走 runToolLoop 与走 createAgent + run，终局与请求数逐字相同", async () => {
  const seed = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const base = { executeTool: async () => "ok" };
  // 直连路线：种子消息写在它的规范位置（`config.input.messages`，唯一登记在案的叶子别名）。
  const direct = provider();
  const directResult = await runToolLoop({
    ...base,
    provider: direct,
    config: { ...QUIET, folding: { toolResultTtl: 1 }, input: { ...QUIET.input, messages: seed } },
  });
  // 包装路线：同一棵树写在初始化里，种子消息走 `call` 通道（`run({ messages })`）。
  const wrapped = provider();
  const agent = createAgent({
    ...base,
    provider: wrapped,
    config: { ...QUIET, folding: { toolResultTtl: 1 } },
  });
  const wrappedResult = await agent.run({ messages: seed });

  assert.deepEqual(wrappedResult.termination, directResult.termination,
    "同一条链路的终局必须逐字相同——`createAgent` 是包装，不是第二套引擎");
  assert.equal(wrappedResult.rounds, directResult.rounds);
  assert.equal(wrapped.requests.length, direct.requests.length);
  assert.deepEqual(wrapped.requests, direct.requests,
    "call 叶的落点必须与宿主手写 config.input.messages 完全一样（否则「包装」就换了一套语义）");
});

test("H1 call 叶写进 run(input) 之后仍走引擎自己的逐叶值规则（config.run.stream 必须是布尔）", async () => {
  const agent = createAgent(init());
  // ⚠ 逐叶值规则住在引擎的展开相里（`assertConfigNamespace`），所以它是**异步**抛的：`run()` 只做
  // 绑定/未知键那两道同步闸口，值规则与 `runToolLoop` 同一相位。
  await assert.rejects(agent.run({ stream: 1 }), (error) => {
    assert.equal(error instanceof TypeError, true);
    // 判词来自 `CONFIG_LEAF_VALUE_RULES`（issue #538 那一条），本片没有另造一套。
    assert.match(error.message, /config\.run\.stream must be a boolean \(received: number\)/u);
    return true;
  });
});

// ================================================================ I. #574：没有东西要传就不带 `config` 键
//
// 病根（issue #574，已机器复现）：`run(input)` 以前**无条件**递 `config: call.config`。而
// `runToolLoop` 的合并规则是「调用级 `config` 在场 ⇒ 整棵顶掉端口 `policy.config`」，随后
// `withAssemblyPolicyConfigLeaves` 只逐叶填「平移自扁平 `policy.*` 的洞 + session 派生叶」——
// **不含宿主写在 `policy.config` 里的值**。于是「旋钮只写在端口 `policy.config` 上」的宿主
// （0.28 之后推荐的位置）每调一次就被递进一棵 `{}`：整棵顶掉、`{}` 一个叶都不设 ⇒ 逐叶冲突
// 事件也不发 ⇒ **旋钮全丢且零诊断**。
//
// 修法（本单）：判据是**在场性**，不是「内容非空」——
//   · 初始化没写 `config`、本次调用也没有任何 `call` 叶 ⇒ 递给 `runToolLoop` 的对象里**不带** `config` 键；
//   · 只要有一侧真给了（初始化写了 `config`，哪怕写的是 `{}`；或本次带了 `call` 叶）⇒ 照旧带合并后的树。
// 覆盖语义与逐叶事件**一个字都没改**（I2 是这条的护栏：别为了修 I1 把覆盖语义也一并改掉）。
//
// 三格（工单点名）+ 一格在场性判据的护栏。断言全部是**行为**：折叠真的发生了没有、run 真的跑了几轮、
// 事件真的发了几条——不看实现。

/** 端口 `policy.config` 上的一组旋钮：折叠 TTL（小到第一轮工具结果就过期）+ 一个轮数上限。 */
function portPolicy({ maxRounds, folding = true }) {
  return {
    config: {
      ...(folding ? { folding: { toolResultTtl: 1, toolResultFoldMinTokens: 1 } } : {}),
      run: { completion: false, maxRounds },
    },
  };
}

/** 最小合法装配端口（provider / tools / session 都是真的，只有模型是 fake）。 */
function makePort({ policy, script }) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: provider(script),
    tools: {
      definitions: [{ name: "work", description: "w", inputSchema: { type: "object", properties: {} } }],
      executeTool: async () => `ORIGINAL-OUTPUT ${"y".repeat(300)}`,
    },
    session: { id: "create-agent-574" },
    policy,
  });
}

/** `count` 轮「再调一次工具」+ 一句终答（轮数上限那两格要用它把 run 顶到上限）。 */
function toolLoopScript(count = 40) {
  return Array.from({ length: count }, (_unused, index) => ({
    content: [{ type: "tool_use", id: `t${index}`, name: "work", input: {} }],
    stopReason: "tool_use",
  }));
}

test("I1 #574 靶心：只把旋钮写在端口 policy.config 上、agent.run({}) 不带 call 叶 ⇒ 旋钮全在（折叠 + 轮数上限两断言）", async () => {
  // ① 折叠旋钮：TTL 小到第一轮的工具结果就该过期。⚠ 轮数预算要留够——TTL 层在「剩余轮数 ≤ 2」时
  //    按既有口径关闭（与 B1 同一句），所以这里给 8 轮。
  const foldPort = makePort({
    policy: portPolicy({ maxRounds: 8 }),
    script: [
      ...Array.from({ length: 6 }, (_unused, index) => ({
        content: [{ type: "tool_use", id: `t${index}`, name: "work", input: {} }],
        stopReason: "tool_use",
      })),
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ],
  });
  // 这一次调用**什么都没带**（连 messages 都没有）——正是「初始化没写 config + 本次没有 call 叶」那个形状。
  const foldResult = await createAgent({ assemblyPort: foldPort }).run({});
  const second = JSON.stringify(foldPort.provider.requests[1]?.messages ?? []);
  assert.equal(second.includes("ORIGINAL-OUTPUT"), false,
    "端口 policy.config 上的 folding.toolResultTtl=1 必须生效（上一条工具结果被折叠）——这里还看到原文，"
    + "说明递给 runToolLoop 的对象里**带着** `config` 键，端口那棵树被整棵顶掉了（#574 复发）；"
    + `实测 ${second.slice(0, 400)}`);
  assert.equal(second.includes("已折叠·TTL"), true, "折叠必须走 TTL 占位符（而不是被别的层顺手删掉）");
  assert.equal(foldResult.termination.reason, "end_turn");

  // ② 轮数上限：端口的 run.maxRounds=3 必须真的是这个 run 的轮数上限（引擎缺省是 8）。
  const loopPort = makePort({ policy: portPolicy({ maxRounds: 3, folding: false }), script: toolLoopScript(40) });
  const loopResult = await createAgent({ assemblyPort: loopPort }).run({});
  assert.equal(loopResult.termination.reason, "max_rounds_cap",
    "轮数上限必须来自端口 policy.config.run.maxRounds=3（引擎缺省 8 会把 provider 脚本耗光而不是给出 max_rounds_cap）");
  assert.equal(loopResult.rounds, 3,
    `端口给的 maxRounds=3 必须生效，实测跑了 ${loopResult.rounds} 轮（8 = 引擎缺省 ⇒ 端口那棵树被顶掉了）`);
  assert.equal(loopPort.provider.requests.length, 4,
    "3 轮上限 + 收尾那次请求 = 4 次 provider 调用（多一次 = 上限没生效）");
});

test("I2 #574 护栏：初始化真给了 config ⇒ 它照旧整棵覆盖端口 policy.config（逐叶事件仍发，覆盖语义一字未改）", async () => {
  const port = makePort({ policy: portPolicy({ maxRounds: 33 }), script: toolLoopScript(40) });
  const events = [];
  const agent = createAgent({
    assemblyPort: port,
    // 宿主只关心一个叶子，却整棵交出了 `config`——既有语义：整棵覆盖 `policy.config`。
    config: { run: { maxRounds: 8 } },
    // 观察事件用**规位**写法（`capabilities.hooks.onEvent`，不是扁平 `onEvent`）：本格测的是配置树的
    // 覆盖语义，不是回调的扁平拼写，所以不给兼容钉子清单添一个与本格无关的写点。
    capabilities: { hooks: { onEvent: (event) => { if (event.type === "config_override_conflict") events.push(event); } } },
  });
  const result = await agent.run({});
  // ① 宿主的值赢。
  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(result.rounds, 8, `初始化给的 maxRounds=8 必须赢（端口写的是 33），实测 ${result.rounds} 轮`);
  // ② 端口那棵树按**既有**整棵覆盖语义消失：folding.* 只在被覆盖的那棵树里 ⇒ 回到默认值（不折叠）。
  const second = JSON.stringify(port.provider.requests[1]?.messages ?? []);
  assert.equal(second.includes("ORIGINAL-OUTPUT"), true,
    "整棵覆盖的既有语义：只写在端口 policy.config 里的 folding.* 必须**消失**（这里应看到未折叠的原文）——"
    + "本条是 I1 的护栏：修 I1 不许把覆盖语义也一并改掉");
  assert.equal(second.includes("已折叠·TTL"), false, "端口 TTL 已随整棵覆盖消失，不该还有 TTL 占位符");
  // ③ 逐叶冲突事件仍发（同一个叶子两侧都给了不同值 ⇒ 恰好一条，载荷只带 path / key）。
  assert.equal(events.length, 1,
    `两侧都给 run.maxRounds 且值不同 ⇒ 恰好一条 config_override_conflict，实测 ${events.length} 条`);
  assert.deepEqual(events[0].conflicts, [{ path: "run.maxRounds", key: "maxRounds" }],
    "冲突载荷必须逐字是 { path, key }（覆盖不许静默，也不许加字段）");
});

// ================================================================ J. #571 片2：把「发一条消息顺带顶掉部署级配置」翻面
//
// 病根（片1 + #574 之后仍漏的那一格）：`createAgent({ assemblyPort })` + `agent.run({ messages })`。
// `messages` 是 `call` 叶 ⇒ 递给 `runToolLoop` 的树**在场** ⇒ 既有规则整棵顶掉 `policy.config`；
// 覆盖之后那两道填充只补「平移自扁平 `policy.*` 的叶」与「`session` 派生叶」，**补不回宿主写在
// `policy.config` 里的叶**。于是最常见的动作（发一条消息）静默丢掉折叠 TTL / 上下文预算 / 轮数上限，
// 而且两侧没有共同叶子 ⇒ 连一条 `config_override_conflict` 都不发。I3 曾把这个行为钉成事实。
//
// 片2 的修法在**包装层**：没有初始化 `config` 时，把端口 `policy.config` **拷一份**当种子，再逐叶并进
// 本次的 `call` 叶。引擎那两条语义（整棵覆盖 + 逐叶事件）一个字都没动，只是那棵树与端口那棵
// **内容等价**。三个要点各有一格：种子是拷贝（J2）、事件不增加（J1 ③）、一次调用就指到最终家（J3）。
//
// 通道收敛的结论（J4，已写进中英契约）：`config.input.messages`（B）是**唯一叶**，
// `session.initialMessages`（A）是**端口级 feeder**——只在叶没值时填，叶赢时它不赢、也不发事件。

test("J1 #571 片2 靶心（I3 翻面）：agent.run({ messages }) 之后端口 policy.config 的旋钮全在、消息真的到达、事件条数 = 0", async () => {
  // ① 折叠旋钮：TTL 小到第一轮的工具结果就该过期。⚠ 轮数预算要留够——TTL 层在「剩余轮数 ≤ 2」时
  //    按既有口径关闭（与 B1 / I1 同一句），所以这里给 8 轮；脚本比预算长，run 一定停在 max_rounds_cap。
  //    ⚠ 8 与引擎缺省同值 ⇒ 这一半**不**充当「轮数上限取自端口」的证据（判别力在 ②：3 ≠ 8），
  //    它只负责把 run 顶到预算、让折叠有足够的轮次生效。
  const foldEvents = [];
  const foldPort = makePort({ policy: portPolicy({ maxRounds: 8 }), script: toolLoopScript(20) });
  // 这就是 §0 那段形状：**只发一条消息**，别的一个字都不给。
  const foldResult = await createAgent({
    assemblyPort: foldPort,
    capabilities: { hooks: { onEvent: (event) => { if (event.type === "config_override_conflict") foldEvents.push(event); } } },
  }).run({ messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
  assert.equal(foldResult.termination.reason, "max_rounds_cap",
    `端口给的 maxRounds=8 必须是这个 run 的上限（实测 ${foldResult.termination.reason} / ${foldResult.rounds} 轮）`);
  assert.equal(foldResult.rounds, 8, `端口给的 maxRounds=8 必须生效，实测 ${foldResult.rounds} 轮`);
  assert.equal(JSON.stringify(foldPort.provider.requests[0]?.messages ?? []).includes("go"), true,
    "messages 必须真的到达 provider 请求（否则下面两条证的是「什么都没发生」）");
  const second = JSON.stringify(foldPort.provider.requests[1]?.messages ?? []);
  assert.equal(second.includes("ORIGINAL-OUTPUT"), false,
    "端口 policy.config 上的 folding.toolResultTtl=1 必须生效（上一条工具结果被折叠）——这里还看到原文，"
    + `说明「发一条消息」又把端口那棵树顶掉了（I3 的老行为回来了）；实测 ${second.slice(0, 400)}`);
  assert.equal(second.includes("已折叠·TTL"), true, "折叠必须走 TTL 占位符（而不是被别的层顺手删掉）");

  // ② 轮数上限：端口的 run.maxRounds=3 必须真的是这个 run 的上限（引擎缺省 8）——与 I1 同一句断言，
  //    差别只在本次调用**带了** `messages`。
  const capEvents = [];
  const capPort = makePort({ policy: portPolicy({ maxRounds: 3, folding: false }), script: toolLoopScript(40) });
  const capResult = await createAgent({
    assemblyPort: capPort,
    capabilities: { hooks: { onEvent: (event) => { if (event.type === "config_override_conflict") capEvents.push(event); } } },
  }).run({ messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
  assert.equal(capResult.termination.reason, "max_rounds_cap",
    "轮数上限必须来自端口 policy.config.run.maxRounds=3（缺省 8 会把 provider 脚本耗光）");
  assert.equal(capResult.rounds, 3,
    `端口给的 maxRounds=3 必须生效，实测跑了 ${capResult.rounds} 轮（8 = 引擎缺省 ⇒ 端口那棵树被顶掉了）`);
  assert.equal(capPort.provider.requests.length, 4, "3 轮上限 + 收尾那次请求 = 4 次 provider 调用");

  // ③ 事件条数 = 0，这是**实测结论**，不是「没数」。
  //
  // 工单 §2 坑 1 担心的是「种子把整棵 policy.config 搬过去 ⇒ 每个叶都变成『两侧都设』⇒ 几十条噪声」。
  // 实测不成立，因为判据本身比那个担心更细：`collectConfigSourceConflicts`
  // （`src/loop/config-namespace.js`）只报「两侧都有值 **且值不同**」的叶子，种子与端口那棵逐叶等值
  // ⇒ 一条都不发。真正会发事件的只有一种情况，而且是既有语义：本次调用把某个端口叶子**改成别的值**
  // （一个旋钮两个来源，值不同 ⇒ 恰一条；J4 ② 把它钉住）。所以这里的期望值是 0，理由写在注释里，
  // 而不是「0 或某个小数字」。
  assert.deepEqual(foldEvents.map((event) => event.conflicts), [],
    `本形状下不许有逐叶冲突事件（种子与端口那棵逐叶等值），实测 ${foldEvents.length} 条`);
  assert.deepEqual(capEvents.map((event) => event.conflicts), [],
    `同上（带 messages + 只改轮数上限的端口）：实测 ${capEvents.length} 条`);
});

test("J2 种子是拷贝：run() 前后 assemblyPort.policy 逐字相同（含深冻结的宿主树）", async () => {
  // 端口对象属于宿主，`Object.freeze` 过的也不少见。包装层只新建**组级浅拷贝**的对象、从不写宿主的树
  // ——所以这里既断言「值没变」，也断言「深冻结的树照样能跑」（写进去会当场 TypeError）。
  const policy = {
    config: {
      input: { wrapup: false },
      folding: Object.freeze({ toolResultTtl: 1, toolResultFoldMinTokens: 1 }),
      run: Object.freeze({ completion: false, maxRounds: 3 }),
    },
  };
  Object.freeze(policy.config.input);
  Object.freeze(policy.config);
  Object.freeze(policy);
  const port = makePort({ policy, script: toolLoopScript(40) });
  // 标题说「种子是拷贝」，就得让这句真被测试：种子函数的返回值必须是**新建的组对象**，不是宿主那一个。
  // （主 agent 复验时发现：只断言「端到端宿主树没被改」抓不到它——把种子改成共享宿主组对象后，
  //   `mergeConfigLeaves` 自己会拷，20 格仍全绿 ⇒ 判别力必须落在下面这三句。）
  const seed = assemblyPortPolicyConfigSeed(port);
  assert.notEqual(seed.folding, policy.config.folding, "种子的 folding 组必须是新对象，不是宿主那个");
  assert.notEqual(seed.run, policy.config.run, "种子的 run 组必须是新对象，不是宿主那个");
  assert.deepEqual(seed, policy.config, "但值必须逐字等于宿主的 policy.config（种子只拷，不改值）");
  const before = JSON.parse(JSON.stringify(port.policy));
  const result = await createAgent({ assemblyPort: port })
    .run({ messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
  assert.equal(result.termination.reason, "max_rounds_cap",
    "深冻结的宿主树必须照常生效（写进去会抛 TypeError ⇒ 那说明种子不是拷贝）");
  assert.equal(result.rounds, 3, `冻结的 run.maxRounds=3 必须生效，实测 ${result.rounds} 轮`);
  assert.deepEqual(port.policy, before, "run() 前后端口 policy 必须逐字相同（宿主对象不被污染）");
  assert.equal(JSON.stringify(port.policy), JSON.stringify(before),
    "逐字比较：任何一处就地写入（哪怕写的是同一个值）都会让这一条失去意义");
  assert.equal(Object.isFrozen(port.policy.config.run), true, "宿主的冻结必须还在（包装层不复制成可变副本）");
  assert.equal("messages" in port.policy.config.input, false,
    "本次调用的 messages 属于这一次，绝不许漏进宿主写在端口上的那棵树");
});

test("J3 两跳收成一条：顶层扁平 call 叶一次调用即指名最终家 agent.run({ <leaf> })", async () => {
  // 两跳的样子（本片修掉）：`createAgent({ initialMessages })` 先被名称闸口送去
  // `config.input.messages`，宿主照着写 `createAgent({ config: { input: { messages } } })`，又被绑定闸口
  // 送去 `agent.run({ messages })`——同一个错误吃两次才找对位置。
  // 判据从**表**派生：call 叶的扁平拼写 = `CONFIG_ALIAS_PATHS` 里那些路径，去处 = 路径的第二段。
  const flatCallNames = [...CONFIG_ALIAS_PATHS]
    .filter(([path]) => CONFIG_LEAF_BINDING[path] === "call");
  assert.ok(flatCallNames.length > 0, "没有 call 叶的扁平名 ⇒ 本格退化成恒真");
  for (const [path, flatName] of flatCallNames) {
    const leaf = path.split(".")[1];
    assert.throws(() => createAgent({ [flatName]: 1 }), (error) => {
      assert.equal(error instanceof TypeError, true, `${flatName} 必须抛 TypeError`);
      assert.equal(
        error.message,
        `createAgent({ ${flatName}: … }): ${flatName} is per-call data —`
          + ` write it in agent.run({ ${leaf}: … }) instead (issue #571: the config tree is fixed at`
          + " initialization and is the agent's single config source)",
        `${flatName} 是退役扁平名且属 call 叶：判词必须**一次**就指到 agent.run（两跳会让宿主吃两次错）`,
      );
      // 反向证：旧的第一跳判词（canonical home）在这个形状里不许再出现——它正是「两跳」的第一站。
      assert.equal(error.message.includes("its canonical home is"), false,
        `${flatName} 的判词里还留着中间站（canonical home）⇒ 宿主仍要走两跳`);
      return true;
    });
  }
  // 直连路线**一字未改**（§1：不许改引擎语义/接受面）：那里 `config.input.messages` 就是终点，
  // 所以它照旧只有一站，而且那一站是它自己的判词。它是**异步**抛的（与 runToolLoop 的相位一致）。
  await assert.rejects(
    runToolLoop({ provider: provider(), executeTool: async () => "ok", initialMessages: [] }),
    (error) => {
      assert.match(error.message, /its canonical home is config\.input\.messages/u,
        "runToolLoop 上没有 agent.run 可指，所以它的判词必须还是「去 config.input.messages」");
      return true;
    },
  );
});

test("J4 旁路载体口径：session.initialMessages 是 feeder、config.input.messages 是唯一叶（同时给 ⇒ 叶赢 + 恰一条事件）", async () => {
  // 结论（中英契约同一句）：B = `config.input.messages` 是那份数据的**唯一叶**；
  // A = `session.initialMessages` 是**端口级 feeder**——经 `withSessionDerivedConfigLeaves`
  // 逐叶填洞，只在叶没值时生效。它不是第二个叶，也不退役（#513/#544/#550 把它定为容器的成员）。
  const seedA = [{ role: "user", content: [{ type: "text", text: "SEED-A" }] }];
  const callB = [{ role: "user", content: [{ type: "text", text: "CALL-B" }] }];

  // ① A 单独给（端口 session，本次调用没有叶子）⇒ feeder 真的生效，且一条事件都不发。
  const feederEvents = [];
  // 一次 end_turn 就结束的脚本：本格测的是「种子有没有到达」，不是轮数。
  const seededPort = createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: provider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "j4-feeder", initialMessages: seedA },
    policy: portPolicy({ maxRounds: 3, folding: false }),
  });
  const feederResult = await createAgent({
    assemblyPort: seededPort,
    capabilities: { hooks: { onEvent: (event) => { if (event.type === "config_override_conflict") feederEvents.push(event); } } },
  }).run({});
  assert.equal(feederResult.termination.reason, "end_turn");
  assert.equal(JSON.stringify(seededPort.provider.requests[0]?.messages ?? []).includes("SEED-A"), true,
    "session.initialMessages 必须真的到达 provider（feeder 不是死路）");
  assert.deepEqual(feederEvents.map((event) => event.conflicts), [],
    "feeder 单独生效时没有第二个来源 ⇒ 0 条事件");

  // ② A 与 B 同时给、值不同 ⇒ **叶（B）赢**、A 一个字节都不泄漏；并且恰一条 `config_override_conflict`：
  //    端口派生叶 `input.messages` 与本次调用的叶是两个来源、值不同 ⇒ 既有语义报一条（不静默）。
  const bothEvents = [];
  const bothProvider = provider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]);
  const bothPort = createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: bothProvider,
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "j4-both", initialMessages: seedA },
    policy: portPolicy({ maxRounds: 3, folding: false }),
  });
  const bothResult = await createAgent({
    assemblyPort: bothPort,
    capabilities: { hooks: { onEvent: (event) => { if (event.type === "config_override_conflict") bothEvents.push(event); } } },
  }).run({ messages: callB });
  assert.equal(bothResult.termination.reason, "end_turn");
  const bothRequest = JSON.stringify(bothPort.provider.requests[0]?.messages ?? []);
  assert.equal(bothRequest.includes("CALL-B"), true, "B（config.input.messages）是唯一叶 ⇒ 它必须赢");
  assert.equal(bothRequest.includes("SEED-A"), false, "A 是 feeder ⇒ 叶在场时它不许出现（也不许两条都发）");
  assert.equal(bothEvents.length, 1,
    `两个来源、值不同 ⇒ 恰一条逐叶事件，实测 ${bothEvents.length} 条：`
    + `${JSON.stringify(bothEvents.map((event) => event.conflicts))}`);
  assert.deepEqual(bothEvents[0].conflicts, [{ path: "input.messages", key: "initialMessages" }],
    "载荷必须逐字是 { path, key }（与既有 config_override_conflict 同一套字段）");

  // ③ `session.id` 是同一个容器的另一个成员，派生到 `config.run.runId`（绑定表里也是 call 叶）——
  //    按 §3 的结论：容器成员**允许**在构造时写，前提是「它派生到哪个叶」有名有姓。
  const seen = [];
  const idPort = createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: provider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "j4-run-id" },
    policy: portPolicy({ maxRounds: 3, folding: false }),
  });
  await createAgent({
    assemblyPort: idPort,
    capabilities: { hooks: { finalGuard: async (payload) => { seen.push(payload); return { action: "accept" }; } } },
  }).run({ messages: callB });
  assert.equal(seen[0]?.runId, "j4-run-id", "session.id ⇒ config.run.runId 必须真的到引擎（finalGuard 载荷为证）");
});

test("J5 init 级 signal 的语义裁定：**有意**——它是 agent 级取消，run({ signal }) 只覆盖本次", async () => {
  // 裁定（本片给出结论，不留空）：init 的 `signal` 是**整个 agent 的取消开关**——同一个 agent 的每一次
  // `run()` 都共用它，所以它一 abort，此后每一次调用都当场取消（provider 一次都不会被调）。
  // 这不是遗漏，是「一个 agent 一个生命周期」的自然读法：`createAgent` 拿住的那些东西就是「只定一次」
  // 的，取消信号同族；每次调用想用别的信号，就在 `run({ signal })` 里给——它只覆盖那一次。
  const controller = new AbortController();
  const fake = provider([{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }]);
  const agent = createAgent({
    provider: fake,
    executeTool: async () => "ok",
    config: QUIET,
    signal: controller.signal,
  });
  // ① abort 之前：照常跑完（否则下面证的是「一开始就取消」）。
  const first = await agent.run({});
  assert.equal(first.termination.reason, "end_turn");
  assert.equal(fake.requests.length, 1);

  // ② abort 之后：同一个 agent 连着两次调用都被取消（取消是 agent 级的，不随 run 重置）。
  controller.abort();
  for (const label of ["第一次", "第二次"]) {
    await assert.rejects(agent.run({}), (error) => {
      assert.equal(error.termination?.reason, "aborted",
        `${label}调用必须被取消（init signal 是 agent 级开关）；实测 ${JSON.stringify(error.termination)}`);
      return true;
    });
  }
  assert.equal(fake.requests.length, 1, "被取消的两次调用不许碰 provider");

  // ③ `run({ signal })` 覆盖 init 的 signal，而且**只影响本次**：给它一个干净的 signal ⇒ 这一次跑完；
  //    下一次不给 ⇒ 回到那个已 abort 的 init signal ⇒ 又被取消。
  const perCall = new AbortController();
  const third = await agent.run({ signal: perCall.signal });
  assert.equal(third.termination.reason, "end_turn", "per-call signal 必须覆盖 init signal（只覆盖本次）");
  assert.equal(fake.requests.length, 2);
  await assert.rejects(agent.run({}), (error) => {
    assert.equal(error.termination?.reason, "aborted",
      "per-call signal 不许改到 init 那个（否则第二次调用会意外活下来）");
    return true;
  });
});

test("J6 完整性证据：逐个入口点名——config 树 / session 容器 / 顶层扁平退役名，三处都由绑定闸口查过", () => {
  // 工单 §4.6：「绑定表覆盖 41 叶」**不许**再充当完整性证据——它只证表是全的，不证**每个入口**都被
  // 绑定闸口查过。这一格逐个入口点名，三处的名单全部从表派生（不手抄），写不满就在报告里说。
  const callLeaves = [...CONFIG_ALIAS_PATHS].filter(([path]) => CONFIG_LEAF_BINDING[path] === "call");
  assert.ok(callLeaves.length > 0, "没有 call 叶 ⇒ 本格退化成恒真");

  // 入口 ①：`config` 树。每个 call 叶写进 `createAgent({ config })` 都必须硬拒并点名 `agent.run`。
  for (const [path, flatName] of callLeaves) {
    const [group, leaf] = path.split(".");
    assert.throws(() => createAgent(init({ config: { [group]: { [leaf]: 1 } } })), (error) => {
      assert.match(error.message,
        new RegExp(`^createAgent\\(\\{ config: \\{ ${group}: \\{ ${leaf}: … \\} \\} \\}\\): config\\.${group}\\.${leaf} is per-call data`, "u"),
        `config.${path} 是 call 叶（扁平名 ${flatName}）：写进 createAgent({ config }) 必须硬拒`);
      assert.match(error.message, new RegExp(`write it in agent\\.run\\(\\{ ${leaf}: … \\}\\)`, "u"));
      return true;
    });
  }

  // 入口 ②：`session` 容器。它能写两个 call 叶（`input.messages` / `run.runId`），这是**允许的**
  // （§3 的结论：feeder 不是第二个叶），所以判据不是「硬拒」而是「派生到哪个叶有名有姓」：
  // 成员集合由 `sessionDerivedConfigLeaves` 给，落点必须在绑定表里且两档都是 `call`；
  // 并且容器**没有后门**——把叶名直接写进 session（`session.messages`）会被成员闸口拒。
  const derived = sessionDerivedConfigLeaves({ id: "j6", initialMessages: [] });
  assert.deepEqual(Object.keys(derived).sort(), ["input", "run"], "session 容器的派生叶只该落在两组");
  const derivedPaths = Object.entries(derived).map(([group, bag]) => `${group}.${Object.keys(bag)[0]}`);
  assert.deepEqual(derivedPaths.sort(), ["input.messages", "run.runId"],
    `session 容器能写的叶必须逐字是这两个，实测 ${JSON.stringify(derivedPaths)}`);
  for (const path of derivedPaths) {
    assert.equal(CONFIG_LEAF_BINDING[path], "call",
      `${path} 必须登记在绑定表里（否则容器就是一个绕过绑定闸口的入口）`);
  }
  assert.throws(() => createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 1, maxOutputTokens: 1 }) },
    provider: provider(),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "j6", messages: [] },
  }), /unknown session option: session\.messages/u,
  "容器成员是闭集：叶名（messages）不是容器成员，只有 initialMessages 是");

  // 入口 ③：顶层扁平退役名。每个 call 叶的扁平拼写都必须被硬拒（J3 逐字断言判词，这里断言**覆盖**：
  // 没有一个是「还被白名单收着」的，否则预闸口可以被绕过）。
  for (const [path, flatName] of callLeaves) {
    const leaf = path.split(".")[1];
    assert.equal(RUN_TOOL_LOOP_OPTION_SET.has(flatName), false,
      `${flatName} 仍是顶层白名单成员 ⇒ 它绕过了「扁平名 ⇒ agent.run」那道闸口`);
    assert.throws(() => createAgent({ [flatName]: 1 }),
      new RegExp(`write it in agent\\.run\\(\\{ ${leaf}: … \\}\\)`, "u"),
      `顶层扁平 ${flatName} 必须一次就指到 agent.run({ ${leaf} })`);
  }
});

test("I4 判据是在场性、不是内容非空：createAgent({ config: {} }) 仍算「给了」；而引擎的整棵覆盖语义一字未改", async () => {
  // 判据的一半：初始化**写了** `config`（哪怕写的是 `{}`）⇒ 带树 ⇒ 端口那棵被覆盖。
  const port = makePort({ policy: portPolicy({ maxRounds: 3, folding: false }), script: toolLoopScript(40) });
  const result = await createAgent({ assemblyPort: port, config: {} }).run({});
  assert.equal(result.rounds, 8,
    `createAgent({ config: {} }) 是「宿主写了 config」⇒ 判据是在场性 ⇒ 端口 maxRounds=3 被覆盖（实测 ${result.rounds} 轮）`);

  // 判据的另一半（反向证）：修的是**包装递不递树**，不是引擎的合并规则。
  // 同一棵树、同一个端口，只差 `config` 这个键在不在：在 ⇒ 端口值全丢；不在 ⇒ 端口值全在。
  const { effectiveOptions: overridden } = await normalizeRunToolLoopOptions({
    assemblyPort: makePort({ policy: portPolicy({ maxRounds: 3 }), script: toolLoopScript(1) }),
    config: {},
  });
  assert.equal(overridden.maxRounds, undefined, "`config: {}` 在场 ⇒ 端口 maxRounds 不生效（既有整棵覆盖语义）");
  assert.equal(overridden.toolResultTtl, undefined, "同上：端口 folding.toolResultTtl 也不生效");
  const { effectiveOptions: kept } = await normalizeRunToolLoopOptions({
    assemblyPort: makePort({ policy: portPolicy({ maxRounds: 3 }), script: toolLoopScript(1) }),
  });
  assert.equal(kept.maxRounds, 3, "不带 `config` 键 ⇒ 端口 maxRounds 生效（#574 依赖的既有语义）");
  assert.equal(kept.toolResultTtl, 1, "不带 `config` 键 ⇒ 端口 folding.toolResultTtl 生效");
});
