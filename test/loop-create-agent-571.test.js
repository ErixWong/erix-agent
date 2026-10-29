// issue #571（片1）：`createAgent` —— 把「初始化一次的配置」与「每一次调用的数据」分成两个位置。
//
// 病根（issue #524，已 by-design 关闭）：0.28 之后 `runToolLoop(一次调用的全部东西)` 是唯一入口、
// **没有 agent 对象**，所以「初始化一次的配置」与「这一次的数据」挤在同一个参数对象里。真实代价：
// 本次输入有两条通道，`config.input.messages` 那条**一传就整棵覆盖**装配口的 `policy.config`
// （折叠 TTL / 上下文预算 / 持久化开关全消失），触发它的动作只是「发一条消息」。
// #571 的解不是改覆盖语义（不做深合并、不加诊断字段），而是给「初始化」一个位置——本文件钉的就是
// 那个位置的**行为**，不是它的实现。
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
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_LEAF_BINDING,
  CONFIG_LEAF_BINDING_VALUES,
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_SCHEMA,
  configLeafNamesForBinding,
  configSchemaSelfCheck,
} from "../src/loop/config-namespace.js";
import { RUN_TOOL_LOOP_OPTION_NAMES } from "../src/loop/option-normalization.js";
import { createAgent, runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
// #574：I 组要一个**真的装配端口**（旋钮写在 `policy.config` 上，不是写在调用级 `config` 里），
// 以及引擎侧规范化入口——反向证要证「修的是包装递不递树，不是引擎的合并规则」。
import { createAssemblyPort } from "../src/assembly.js";
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

test("A1 绑定表覆盖的叶子集合 == schema 的 41 叶集合（不多、不少、拼写逐字一致）", () => {
  const bound = Object.keys(CONFIG_LEAF_BINDING).sort();
  const schema = [...SCHEMA_LEAF_PATHS].sort();
  assert.deepEqual(bound, schema,
    "绑定表与 schema 的叶子集合必须逐字相等：少的 = 加了叶子忘标绑定，多的 = 绑定表里有一条死条目");
  assert.equal(bound.length, 41, `配置面是 41 叶（现测 ${bound.length}）——数字变了就要连这条一起改，别让它空转`);
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

test("I3 #574 差异有名有姓：agent.run({ messages }) 带了 call 叶 ⇒ config 键**在**，端口 policy.config 按既有规则被整棵覆盖", async () => {
  // 这一格不是「I1 的复述」，而是 I1 的**边界**：`messages` 是 `config.input.messages`（call 叶），
  // 它让合并后的树**非空且在场**，于是「整棵覆盖 policy.config」这条既有规则照旧生效。
  // 契约里必须写清这一点，否则「配置只有一个来源、发消息不会顶掉折叠旋钮」对端口路线是半句假话。
  const port = makePort({ policy: portPolicy({ maxRounds: 3 }), script: toolLoopScript(40) });
  const events = [];
  const agent = createAgent({
    assemblyPort: port,
    capabilities: { hooks: { onEvent: (event) => { if (event.type === "config_override_conflict") events.push(event); } } },
  });
  const result = await agent.run({ messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
  // ① call 叶真的到了（否则下面两条断言证的是「什么都没发生」）。
  assert.equal(JSON.stringify(port.provider.requests[0]?.messages ?? []).includes("go"), true,
    "messages 必须真的到达 provider 请求");
  // ② 与 I1 的差别之一：端口给的 maxRounds=3 不再生效，回到引擎缺省 8。
  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(result.rounds, 8,
    `call 叶在场 ⇒ 递出去的是合并后的树 ⇒ 端口 policy.config.run.maxRounds=3 被整棵覆盖、回到缺省 8；`
    + `实测 ${result.rounds} 轮（3 = 端口值生效，与 I1 同结论 ⇒ 本格没证到差别）`);
  // ③ 与 I1 的差别之二：端口 folding.* 同样消失（不折叠）。
  const second = JSON.stringify(port.provider.requests[1]?.messages ?? []);
  assert.equal(second.includes("ORIGINAL-OUTPUT"), true,
    "端口 folding.* 只写在被覆盖的那棵树里 ⇒ 按既有规则消失（这里应看到未折叠的原文）");
  // ④ 而这一格**一条逐叶事件都不发**：`{input.messages}` 与端口的 `{folding.*, run.maxRounds}` 没有
  //    任何叶子被两侧同时赋值。这正是 I1 与 I3 的差别必须写进契约的原因——「发一条消息」在端口路线上
  //    仍会整棵顶掉端口配置，且逐叶事件救不了它（那是既有规则，本单不改）。
  assert.deepEqual(events.map((event) => event.conflicts), [],
    "没有叶子被两侧同时赋值 ⇒ 没有逐叶冲突可报（这是既有规则的可观察后果，不是本格在给静默背书）");
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
