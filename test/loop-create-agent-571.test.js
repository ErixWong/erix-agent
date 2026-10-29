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
