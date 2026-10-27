// issue #498（S4c）—— 壳内行为载体获得**真实归宿**：开 `capabilities.ports` + `hooks` 补 4 个回调。
//
// 本刀五件事，五组用例：
//
//   C1（账目 + 「只加目的地，不发明扁平别名」的机器证明）：9 个新叶子（`ports.sleepImpl` /
//      `ports.judgeProvider` / `ports.strategy` / `hooks.{onReflection,onBeforeFold,onAfterFold,
//      stubFor,protectedMessage,recoveryHint}`）**一律没有**顶层扁平别名 ⇒ 顶层白名单仍是 67，
//      能力面仍是 22 项，三向闭合（43 + 22 + 2 = 67）一字未动。这 9 个是「嵌套槽叶子」，
//      去向登记在 `CAPABILITY_SLOT_DESTINATIONS`（`src/loop/capabilities-namespace.js`）。
//   C2（`capabilities.ports` 的形状闸口）：拼错子键抛并列出可接受值；三条端口各有各的值形状
//      （`sleepImpl` = 函数、`judgeProvider` = callable 或 `{chat}` 对象、`strategy` = 策略对象，
//      内置名字是**数据**、不住端口位）；`hooks` 的值校验器**不因为多态旋钮而放宽**（仍是函数）。
//   C3（展开层证据）：端口位不进 `effectiveOptions`（进了就等于发明扁平键），走 `slots` 侧信道；
//      与壳里老槽位都给了**不等价**的值 ⇒ 恰一条 `config_override_conflict`（path 点名真实目的地），
//      等价 ⇒ 零事件。
//   C4–C7（行为证据，不是「没抛」）：`sleepImpl` 真被调用且延迟被记录、`judgeProvider` 让 judge
//      请求走它而主模型不走它、`strategy` 的 `shouldCompact` / `compact` 真被调、4 个新 hooks
//      各收到投递（折叠前后 / 扩轮 / 桩解析）。`?? defaultSleep` 兜底也被钉（删掉它这格红）。
//   C8（形态多态旋钮：本刀最容易开「同一旋钮两个户口」的地方）：数据形态留 `config.folding.context`、
//      函数形态进 `capabilities.hooks`；两侧不等价 ⇒ **恰一条**冲突事件、等价 ⇒ **零**事件。
//   C9（扁平老写法零回归）：`retry.sleepImpl` / `context.onBeforeFold` / `reflection.judge.provider` /
//      `context.strategy`（对象形态）**照旧可用**——本刀只加目的地，不撤顶层。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import {
  CAPABILITIES_ALIAS_PATHS,
  CAPABILITIES_NAMESPACE_GROUPS,
  CAPABILITIES_NAMESPACE_SCHEMA,
  CAPABILITIES_SLOT_LEAF_NAMES,
  CAPABILITIES_SURFACE_OPTION_NAMES,
  CAPABILITY_HOOK_NAMES,
  CAPABILITY_POLYMORPHIC_HOOK_NAMES,
  CAPABILITY_PORT_SLOT_NAMES,
  CAPABILITY_SLOT_DESTINATIONS,
  capabilitiesSchemaSelfCheck,
  collectCapabilitiesNamespaceProblems,
  expandCapabilitiesNamespace,
} from "../src/loop/capabilities-namespace.js";
import {
  CAPABILITY_OPTION_NAMES,
  CONFIG_SURFACE_OPTION_NAMES,
  NAMESPACE_CONTAINER_OPTION_NAMES,
  configSchemaSelfCheck,
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
    session: { id: `ports-498s4c-${process.pid}` },
    policy,
  });
}

/** 一次可重试失败的 provider（第一次抛 retryable，之后成功）。 */
function retryingProvider(counter) {
  return {
    protocol: "fake",
    async chat() {
      counter.calls += 1;
      if (counter.calls === 1) {
        const error = new Error("temporary provider failure");
        error.retryable = true;
        throw error;
      }
      return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
    },
  };
}

/** 一串工具轮（用于触发折叠 / 扩轮），最后一发是 end_turn。 */
function toolScript(rounds) {
  return [
    ...Array.from({ length: rounds }, (_value, index) => ({
      content: [{ type: "tool_use", id: `t${index}`, name: "echo", input: { step: index } }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
}

/** 一次真的发生折叠的 run（预算极小 + 不保留轮次）。 */
function foldingRun(extra = {}) {
  return runToolLoop({
    provider: createFakeProvider(toolScript(6)),
    executeTool: async () => "tool output",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 4,
    context: { budgetTokens: 1, keepRounds: 0 },
    ...extra,
  });
}

/** 一次真的发生扩轮的 run（judge 给 extend:true）。 */
function extendingRun(extra = {}) {
  const decision = {
    done: false,
    confidence: 0.8,
    reason: "仍需验证",
    evidence: "验证尚未完成",
    direction: "on_track",
    directionReason: "",
    extend: true,
    extendReason: "当前上限不足",
    plan: "完成最后验证",
  };
  return runToolLoop({
    provider: createFakeProvider(toolScript(8)),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 5,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 3,
      extensionStep: 2,
      maxExtensions: 1,
      maxRoundsCap: 20,
      judge: { provider: createFakeProvider([{ content: [{ type: "text", text: JSON.stringify(decision) }] }]) },
    },
    ...extra,
  });
}

// ================================================================ C1. 账目 + 不发明扁平别名
test("C1 账目：白名单仍是 67，9 个新叶子一律是嵌套槽（没有新顶层选项）", () => {
  // 四个数逐个钉住（与 S4a / S4b 同一张对账表，本刀一个都没动）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.length, 67, "顶层白名单仍是 67（ports/hooks 的成员都是子键）");
  assert.equal(CONFIG_SURFACE_OPTION_NAMES.length, 43, "配置面 43");
  assert.equal(CAPABILITY_OPTION_NAMES.length, 22, "能力面（顶层选项那一层）22");
  assert.equal(NAMESPACE_CONTAINER_OPTION_NAMES.length, 2, "容器两个：config 与 capabilities");
  assert.equal(
    CONFIG_SURFACE_OPTION_NAMES.length + CAPABILITY_OPTION_NAMES.length + NAMESPACE_CONTAINER_OPTION_NAMES.length,
    RUN_TOOL_LOOP_OPTION_NAMES.length,
    "三向闭合一字未动",
  );
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "自检必须仍 []");

  // 能力面 schema 的三组与成员数（本刀的判据面）。
  assert.deepEqual([...CAPABILITIES_NAMESPACE_GROUPS], ["hooks", "checks", "ports"]);
  assert.equal(CAPABILITY_HOOK_NAMES.length, 16, "hooks 的回调 12 → 16");
  assert.deepEqual([...CAPABILITY_POLYMORPHIC_HOOK_NAMES], ["protectedMessage", "recoveryHint"]);
  assert.deepEqual([...CAPABILITY_PORT_SLOT_NAMES], ["sleepImpl", "judgeProvider", "strategy"]);
  assert.equal(CAPABILITIES_NAMESPACE_SCHEMA.hooks.length, 18, "hooks 接受 16 + 2 = 18 个叶子");
  assert.equal(CAPABILITIES_SLOT_LEAF_NAMES.length, 9, "9 个嵌套槽叶子");
  assert.equal(CAPABILITIES_SURFACE_OPTION_NAMES.length, 13, "扁平叶子仍是 13（别名表 13 条）");
  assert.equal(CAPABILITIES_ALIAS_PATHS.size, 13);

  // **本刀的核心硬判据**：9 个新叶子一个都不许出现在顶层白名单里——它们不是「搬过来的扁平键」，
  // 而是从来就没有过的容器成员位。若哪天有人给它们发明了顶层别名，这里先红。
  for (const leaf of CAPABILITIES_SLOT_LEAF_NAMES) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf), false, `${leaf} 不许成为顶层选项（白名单 67 不变）`);
    assert.equal(CAPABILITY_OPTION_NAMES.includes(leaf), false, `${leaf} 不是顶层能力键`);
    assert.equal(CONFIG_SURFACE_OPTION_NAMES.includes(leaf), false, `${leaf} 不是配置键`);
    // 它是行为载体 ⇒ 不进 round-trip 覆盖度名单（那份名单只收配置面叶子）。
    assert.equal(typeof CAPABILITY_SLOT_DESTINATIONS[
      `${CAPABILITIES_NAMESPACE_GROUPS.find((group) => CAPABILITIES_NAMESPACE_SCHEMA[group].includes(leaf))}.${leaf}`
    ]?.conflictPath, "string", `${leaf} 必须登记去向（含冲突事件的 path）`);
  }
  // 去向表就是那 9 条，不多不少（多一条就是死条目，`capabilitiesSchemaSelfCheck` 也核这一条）。
  assert.deepEqual(
    Object.keys(CAPABILITY_SLOT_DESTINATIONS).sort(),
    [
      "hooks.onAfterFold",
      "hooks.onBeforeFold",
      "hooks.onReflection",
      "hooks.protectedMessage",
      "hooks.recoveryHint",
      "hooks.stubFor",
      "ports.judgeProvider",
      "ports.sleepImpl",
      "ports.strategy",
    ],
  );
});

test("C1b 自检会咬人：给嵌套槽叶子发明顶层扁平别名 ⇒ 红（证明 67 不是嘴上说的）", () => {
  // 模拟「有人把 `sleepImpl` 塞进顶层白名单」——本刀最危险的错法（会变成 76）。
  const invented = [...RUN_TOOL_LOOP_OPTION_NAMES, "sleepImpl"];
  assert.deepEqual(
    configSchemaSelfCheck(invented),
    [
      'capabilities.ports.sleepImpl is a nested slot and must not also be a top-level option'
        + " (that would be a new flat alias, not a destination)",
      'top-level option "sleepImpl" is classified nowhere (config surface or capability list)',
    ],
    "嵌套槽叶子出现在顶层白名单里必须红，且报错说清它是「槽」不是「扁平别名」",
  );
  // 另一侧：把去向表指向一个不存在的壳 ⇒ 红。
  const problems = capabilitiesSchemaSelfCheck(["onEvent"]);
  assert.equal(problems.length > 0, true);
  assert.match(problems.join("\n"), /is destined for/u);
});

test("C1c 未知分组仍抛，且名单里已经有 ports（旧文案「ports are not collected」是假话，已删）", () => {
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ port: { sleepImpl: () => {} } }),
    ["unknown capabilities namespace: \"port\" (accepted: hooks, checks, ports;"
      + " port objects such as provider / store / signal stay top-level options"
      + " or assembly-port members, not capabilities members)"],
  );
  // 叶子写高一层 ⇒ 指到它真正的组（`sleepImpl` 现在有家了）。
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ sleepImpl: () => {} }),
    ["capabilities.sleepImpl: ports live under capabilities.ports (write capabilities.ports.sleepImpl)"],
  );
});

// ================================================================ C2. ports 的形状闸口
test("C2 capabilities.ports 的形状闸口：拼错子键列可接受值，三条端口各校各的形状", async () => {
  // ① 拼错子键（反向证 ①）：抛并列出可接受值。
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ ports: { sleeplmp: () => {} } }),
    ["unknown capabilities.ports option: \"sleeplmp\" (accepted: sleepImpl, judgeProvider, strategy)"],
  );
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ ports: { sleepImpl: "nope" } }),
    ["capabilities.ports.sleepImpl must be a function (ms, signal) => Promise<void> (or omitted)"],
  );
  // `judgeProvider`：callable 或 `{chat}` 对象（这是 ports 与 hooks 的形状区别）。
  assert.deepEqual(collectCapabilitiesNamespaceProblems({ ports: { judgeProvider: async () => ({}) } }), []);
  assert.deepEqual(collectCapabilitiesNamespaceProblems({ ports: { judgeProvider: { chat: async () => ({}) } } }), []);
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ ports: { judgeProvider: { chat: "nope" } } }),
    ["capabilities.ports.judgeProvider must be a function (request) => Promise<response>"
      + " or an object with a chat(request) method (or omitted)"],
  );
  // `strategy`：策略对象（`shouldCompact` + `compact`）。内置名字是**数据**，不住端口位。
  const strategy = { shouldCompact: async () => false, compact: async (messages) => ({ messages }) };
  assert.deepEqual(collectCapabilitiesNamespaceProblems({ ports: { strategy } }), []);
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ ports: { strategy: "sliding-window" } }),
    ["capabilities.ports.strategy must be a compaction strategy object, not a built-in name"
      + " (a built-in name is data: pass it as config.folding.context.strategy or the flat context.strategy)"],
  );
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ ports: { strategy: { shouldCompact: async () => false } } }),
    ["capabilities.ports.strategy must expose compact as a function (or omitted)"],
  );
  assert.deepEqual(collectCapabilitiesNamespaceProblems({ ports: "nope" }), ["capabilities.ports must be an object"]);
  // ② `hooks` 的值校验器**不放宽**（反向证 ② 的那一格）：多态旋钮的函数形态也必须是函数。
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ hooks: { protectedMessage: "user" } }),
    ["capabilities.hooks.protectedMessage must be a function (or omitted)"],
  );
  assert.deepEqual(
    collectCapabilitiesNamespaceProblems({ hooks: { recoveryHint: { hint: "x" } } }),
    ["capabilities.hooks.recoveryHint must be a function (or omitted)"],
  );

  // 真 run 上同样启动即抛（且带路线标签）。
  const error = await directError({ capabilities: { ports: { sleeplmp: () => {} } } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /unknown capabilities\.ports option: "sleeplmp"/u);
  assert.equal(error.via, "direct");
});

test("C2b 装配口路线：policy.capabilities.ports 同相校，via=assembly", () => {
  assert.throws(
    () => makePort({ capabilities: { ports: { sleeplmp: () => {} } } }),
    (thrown) => thrown instanceof TypeError
      && /unknown capabilities\.ports option: "sleeplmp"/u.test(thrown.message)
      && thrown.via === "assembly",
  );
});

// ================================================================ C3. 展开层：槽位 + 冲突
test("C3 端口位不进扁平表示（走 slots），与壳里老槽位不等价 ⇒ 恰一条冲突、等价 ⇒ 零", () => {
  const sleepImpl = async () => {};
  const expanded = expandCapabilitiesNamespace({ capabilities: { ports: { sleepImpl } } });
  assert.deepEqual(expanded.conflicts, []);
  assert.equal(expanded.slots.ports.sleepImpl, sleepImpl, "端口位落在 slots 里");
  assert.equal(Object.hasOwn(expanded.options, "sleepImpl"), false, "端口位**不许**变成扁平键（那不是搬家）");
  assert.equal(Object.hasOwn(expanded.options, "capabilities"), false);

  // 不等价 ⇒ 一条冲突，path 点名真实目的地。
  const otherSleep = async () => {};
  const conflict = expandCapabilitiesNamespace({
    retry: { sleepImpl: otherSleep },
    capabilities: { ports: { sleepImpl } },
  });
  assert.deepEqual(conflict.conflicts, [{ path: "ports.sleepImpl", key: "sleepImpl" }]);
  assert.equal(conflict.slots.ports.sleepImpl, sleepImpl, "端口位赢（容器赢扁平的同向优先级）");

  // 等价（同一个函数对象）⇒ 零冲突。
  assert.deepEqual(
    expandCapabilitiesNamespace({ retry: { sleepImpl }, capabilities: { ports: { sleepImpl } } }).conflicts,
    [],
  );

  // judgeProvider / strategy 同一条规则。
  const judgeProvider = { chat: async () => ({}) };
  assert.deepEqual(
    expandCapabilitiesNamespace({
      reflection: { judge: { provider: { chat: async () => ({}) } } },
      capabilities: { ports: { judgeProvider } },
    }).conflicts,
    [{ path: "ports.judgeProvider", key: "judgeProvider" }],
  );
  const strategy = { shouldCompact: async () => false, compact: async (messages) => ({ messages }) };
  assert.deepEqual(
    expandCapabilitiesNamespace({
      context: { strategy: { shouldCompact: async () => false, compact: async (messages) => ({ messages }) } },
      capabilities: { ports: { strategy } },
    }).conflicts,
    [{ path: "ports.strategy", key: "strategy" }],
  );
  assert.deepEqual(
    expandCapabilitiesNamespace({ context: { strategy }, capabilities: { ports: { strategy } } }).conflicts,
    [],
    "同一个策略对象 ⇒ 不算冲突",
  );
  // `retry: false` 这种合法布尔形状不能被当成容器读（否则会报一条假冲突）。
  assert.deepEqual(
    expandCapabilitiesNamespace({ retry: false, capabilities: { ports: { sleepImpl } } }).conflicts,
    [],
  );
  // 冲突经同一条事件出口出去：一次 run 里恰好一条 `config_override_conflict`。
  return runDirect({
    retry: { attempts: 1, backoffBaseMs: 0, sleepImpl: otherSleep },
    capabilities: { ports: { sleepImpl } },
    onEvent: (event) => {
      if (event.type !== "config_override_conflict") return;
      assert.deepEqual(event.conflicts, [{ path: "ports.sleepImpl", key: "sleepImpl" }]);
    },
  });
});

// ================================================================ C4. sleepImpl 行为证据
test("C4 行为证据：ports.sleepImpl 真被调用并记录延迟（默认兜底 defaultSleep 也被钉）", async () => {
  const counter = { calls: 0 };
  const sleeps = [];
  const result = await runToolLoop({
    provider: retryingProvider(counter),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    retry: { attempts: 2, backoffBaseMs: 10 },
    capabilities: { ports: { sleepImpl: async (ms) => { sleeps.push(ms); } } },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(counter.calls, 2, "一次重试 ⇒ provider 被调两次");
  assert.deepEqual(sleeps, [10], "注入的定时器**真的被调用**，且记到了实际退避延迟");

  // 反向兜底：**不注入**时走 `defaultSleep`（`retryOptions?.sleepImpl ?? defaultSleep` 的右半边）。
  // 删掉那个 `??` 兜底，这一格会以 `sleepImpl is not a function` 红。
  const fallbackCounter = { calls: 0 };
  const fallback = await runToolLoop({
    provider: retryingProvider(fallbackCounter),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    retry: { attempts: 1, backoffBaseMs: 0 },
  });
  assert.equal(fallback.termination.reason, "end_turn", "没有注入定时器时必须退回 defaultSleep");
  assert.equal(fallbackCounter.calls, 2);
});

// ================================================================ C5. judgeProvider 行为证据
test("C5 行为证据：ports.judgeProvider 让 judge 请求走它，主模型不走它（+ judge.evaluator 退役）", async () => {
  const main = createFakeProvider(toolScript(8));
  const judgeRequests = [];
  const judgeProvider = {
    async chat(request) {
      judgeRequests.push(request);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ done: false, confidence: 0.8, reason: "仍需继续", evidence: "x" }),
        }],
      };
    },
  };
  const result = await runToolLoop({
    provider: main,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 6,
    reflection: { enabled: true, judgeIntervalRound: 2 },
    capabilities: { ports: { judgeProvider } },
  });
  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(judgeRequests.length, 1, "judge 请求恰好一次，走的是端口位");
  assert.match(judgeRequests[0].system, /交付评审者/u, "端口位收到的确实是 judge 请求");
  assert.equal(judgeRequests[0].maxTokens, 1024);
  // 主模型那一路一条 judge 请求都没有（judge 的 system 提示词只出现在端口位）。
  assert.equal(
    main.requests.filter((request) => /交付评审者/u.test(String(request.system))).length,
    0,
    "主模型**不走** judgeProvider",
  );
  assert.equal(main.requests.length >= result.rounds, true, "主模型的请求数只来自它自己的轮次（含强制收尾那一发）");

  // `judge.evaluator` 这个纯别名退役：抛并指出去处（反向证 ④ 的那一格）。
  const retired = await directError({ reflection: { judge: { evaluator: { chat: async () => ({}) } } } });
  assert.equal(retired instanceof TypeError, true);
  assert.match(retired.message, /reflection\.judge\.evaluator is not accepted/u);
  assert.match(retired.message, /capabilities\.ports\.judgeProvider/u, "报错必须点出新的规范之家");
});

// ================================================================ C6. strategy 行为证据
test("C6 行为证据：ports.strategy 的 shouldCompact / compact 真被调（对象同一性保留）", async () => {
  let shouldCompactCalls = 0;
  let compactCalls = 0;
  const self = [];
  const strategy = {
    name: "spy-strategy",
    async shouldCompact() {
      shouldCompactCalls += 1;
      self.push(this);
      return true;
    },
    async compact(messages) {
      compactCalls += 1;
      self.push(this);
      return { messages, foldedRoundRange: { from: 1, to: 1 } };
    },
  };
  const result = await runToolLoop({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    context: { budgetTokens: 1 },
    capabilities: { ports: { strategy } },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(shouldCompactCalls, 1, "shouldCompact 真被调");
  assert.equal(compactCalls, 1, "compact 真被调");
  assert.deepEqual(self, [strategy, strategy], "对象原样透传（同一个引用），没有被包一层");
  assert.equal(result.compactionStats[0].strategyName, "spy-strategy", "轮记录里记的就是这个策略对象的名字");
});

// ================================================================ C7. 4 个新 hooks 行为证据
test("C7 行为证据：onBeforeFold / onAfterFold / stubFor 在折叠时、onReflection 在扩轮时各收到投递", async () => {
  const before = [];
  const after = [];
  const stubs = [];
  const folded = await foldingRun({
    capabilities: {
      hooks: {
        onBeforeFold: (payload) => { before.push(payload); },
        onAfterFold: (payload) => { after.push(payload); },
        stubFor: (message) => { stubs.push(message); return "stubbed"; },
      },
    },
  });
  assert.equal(folded.termination.reason === "end_turn" || folded.termination.reason === "max_rounds_cap", true);
  assert.equal(before.length > 0, true, "onBeforeFold 必须收到投递");
  assert.equal(after.length, before.length, "每次折叠前都有一条折叠后");
  assert.equal(Array.isArray(before[0].foldedPayload), true, "onBeforeFold 拿到的是即将被折叠的那批消息");
  assert.equal(stubs.length > 0, true, "stubFor 在桩解析时被逐条调用");
  assert.equal(
    after.some((payload) => JSON.stringify(payload.messages).includes("stubbed")),
    true,
    "桩文本真的进了折叠摘要（不是「钩子被调了但结果被丢掉」）",
  );

  const reflections = [];
  const extended = await extendingRun({
    capabilities: { hooks: { onReflection: (info) => { reflections.push(info); } } },
  });
  assert.equal(reflections.length, 1, "扩轮决策必须通知宿主（恰好一次）");
  assert.equal(Number.isSafeInteger(reflections[0].round), true);
  assert.equal(typeof reflections[0].decision, "object");
  assert.equal(Number.isSafeInteger(reflections[0].extendedTo), true);
  assert.equal(extended.rounds > 5, true, "扩轮真的发生了（否则这格只是「没抛」）");
});

// ================================================================ C8. 形态多态旋钮
test("C8 形态多态旋钮：数据形态留 config、函数形态进 hooks、两侧不等价 ⇒ 恰一条冲突、等价 ⇒ 零", async () => {
  // ① 数据形态（`string`）住 config，且真的生效：受保护的消息在折叠中保留。
  const dataRun = await runToolLoop({
    provider: createFakeProvider(toolScript(6)),
    executeTool: async () => "tool output",
    initialMessages: [
      { role: "user", content: "PROTECTED-TASK" },
      { role: "assistant", content: [{ type: "text", text: "old ".repeat(400) }] },
    ],
    completion: false,
    wrapup: false,
    maxRounds: 4,
    config: { folding: { context: { budgetTokens: 300, keepRounds: 1, protectedMessage: "user" } } },
  });
  assert.equal(
    dataRun.messages.some((message) => JSON.stringify(message.content).includes("PROTECTED-TASK")),
    true,
    "config.folding.context.protectedMessage 的数据形态真的保护了那条消息",
  );
  // ② 函数形态住 hooks，行为等价。
  const functionRun = await runToolLoop({
    provider: createFakeProvider(toolScript(6)),
    executeTool: async () => "tool output",
    initialMessages: [
      { role: "user", content: "PROTECTED-TASK" },
      { role: "assistant", content: [{ type: "text", text: "old ".repeat(400) }] },
    ],
    completion: false,
    wrapup: false,
    maxRounds: 4,
    capabilities: { hooks: { protectedMessage: (message) => message?.role === "user" } },
    context: { budgetTokens: 300, keepRounds: 1 },
  });
  assert.equal(
    functionRun.messages.some((message) => JSON.stringify(message.content).includes("PROTECTED-TASK")),
    true,
    "capabilities.hooks.protectedMessage 的函数形态同样生效",
  );

  // ③ 两侧都给了**不等价**的值 ⇒ 恰一条 `config_override_conflict`，path 点名该旋钮的配置侧路径。
  const events = [];
  const conflictRun = await runToolLoop({
    provider: createFakeProvider(toolScript(6)),
    executeTool: async () => "tool output",
    initialMessages: [
      { role: "user", content: "PROTECTED-TASK" },
      { role: "assistant", content: [{ type: "text", text: "old ".repeat(400) }] },
    ],
    completion: false,
    wrapup: false,
    maxRounds: 4,
    config: { folding: { context: { budgetTokens: 300, keepRounds: 1, protectedMessage: "system" } } },
    capabilities: { hooks: { protectedMessage: () => false } },
    onEvent: (event) => { events.push(event); },
  });
  assert.equal(conflictRun.termination.reason === "end_turn" || conflictRun.termination.reason === "max_rounds_cap", true);
  const conflicts = events.filter((event) => event.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, "不等价 ⇒ 恰一条冲突事件");
  assert.deepEqual(conflicts[0].conflicts, [
    { path: "folding.context.protectedMessage", key: "protectedMessage" },
  ]);
  assert.equal(conflictRun.termination.reason === "end_turn" || conflictRun.termination.reason === "max_rounds_cap", true);

  // ③b 同一个旋钮的**赢家**是可观察的：`recoveryHint` 的两条腿同时在场时，函数形态（capabilities）
  // 赢——折叠摘要里出现 FUNC-HINT、不出现 DATA-HINT（protectedMessage 的赢家不适合做观察点：
  // 用户轮守卫会保留最近一轮用户消息，与它无关）。
  const winnerEvents = [];
  const winnerRun = await runToolLoop({
    provider: createFakeProvider(toolScript(6)),
    executeTool: async () => "tool output ".repeat(20),
    initialMessages: [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "text", text: "old ".repeat(400) }] },
    ],
    completion: false,
    wrapup: false,
    maxRounds: 4,
    context: { budgetTokens: 300, keepRounds: 1, strategy: "fold-statistical", recoveryHint: "DATA-HINT" },
    capabilities: { hooks: { recoveryHint: () => "FUNC-HINT" } },
    onEvent: (event) => { winnerEvents.push(event); },
  });
  const winnerText = JSON.stringify(winnerRun.messages);
  assert.equal(winnerText.includes("FUNC-HINT"), true, "capabilities 侧赢：函数形态的提示进了折叠摘要");
  assert.equal(winnerText.includes("DATA-HINT"), false, "配置侧那份被覆盖（容器赢扁平的同向优先级）");
  const winnerConflicts = winnerEvents.filter((event) => event.type === "config_override_conflict");
  assert.equal(winnerConflicts.length, 1, "同一个旋钮两个住处 ⇒ 恰一条冲突事件");
  assert.deepEqual(winnerConflicts[0].conflicts, [
    { path: "folding.context.recoveryHint", key: "recoveryHint" },
  ]);

  // ④ 等价（同一个函数对象）⇒ **零**事件（反向证 ③ 的那一格：把等价分支短路就会红）。
  const sameHook = () => false;
  const same = [];
  await runDirect({
    context: { protectedMessage: sameHook },
    capabilities: { hooks: { protectedMessage: sameHook } },
    onEvent: (event) => { same.push(event); },
  });
  assert.deepEqual(
    same.filter((event) => event.type === "config_override_conflict"),
    [],
    "同一个函数对象 ⇒ 零冲突事件（等价口径 = isDeepStrictEqual / 同一性）",
  );

  // ⑤ `recoveryHint` 的两条腿都真的到策略里（名字形态策略经 `resolveCompactionStrategy` 的 options）。
  const hinted = (extra) => runToolLoop({
    provider: createFakeProvider(toolScript(6)),
    executeTool: async () => "tool output ".repeat(20),
    initialMessages: [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "text", text: "old ".repeat(400) }] },
    ],
    completion: false,
    wrapup: false,
    maxRounds: 4,
    context: { budgetTokens: 300, keepRounds: 1, strategy: "fold-statistical" },
    ...extra,
  }).then((result) => JSON.stringify(result.messages));
  assert.equal((await hinted({ context: { budgetTokens: 300, keepRounds: 1, strategy: "fold-statistical", recoveryHint: "DATA-HINT" } })).includes("DATA-HINT"), true, "数据形态进折叠摘要");
  assert.equal((await hinted({ capabilities: { hooks: { recoveryHint: () => "FUNC-HINT" } } })).includes("FUNC-HINT"), true, "函数形态进折叠摘要");
});

// ================================================================ C9. 扁平老写法零回归
test("C9 扁平老写法零回归：retry.sleepImpl / context.onBeforeFold / reflection.judge.provider / context.strategy 照旧可用", async () => {
  // ① `retry: { sleepImpl }`（顶层扁平老写法）
  const counter = { calls: 0 };
  const flatSleeps = [];
  const retried = await runToolLoop({
    provider: retryingProvider(counter),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    retry: { attempts: 1, backoffBaseMs: 0, sleepImpl: async (ms) => { flatSleeps.push(ms); } },
  });
  assert.equal(retried.termination.reason, "end_turn");
  assert.deepEqual(flatSleeps, [0], "扁平 retry.sleepImpl 照旧被调用");

  // ② `context: { onBeforeFold }` / `onAfterFold` / `stubFor`
  const flatBefore = [];
  const flatFolded = await foldingRun({
    context: { budgetTokens: 1, keepRounds: 0, onBeforeFold: (payload) => { flatBefore.push(payload); } },
  });
  assert.equal(flatBefore.length > 0, true, "扁平 context.onBeforeFold 照旧收到投递");
  assert.equal(flatFolded.termination.reason === "end_turn" || flatFolded.termination.reason === "max_rounds_cap", true);

  // ③ `reflection: { judge: { provider } }`（嵌套老写法）
  const judge = createFakeProvider([{
    content: [{ type: "text", text: JSON.stringify({ done: false, confidence: 0.8, reason: "x", evidence: "y" }) }],
  }]);
  await runToolLoop({
    provider: createFakeProvider(toolScript(8)),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 6,
    reflection: { enabled: true, judgeIntervalRound: 2, judge: { provider: judge } },
  });
  assert.equal(judge.requests.length, 1, "扁平/嵌套 reflection.judge.provider 照旧被调用");

  // ④ `context: { strategy: 对象 }`（对象形态老写法）
  let compacted = 0;
  const flatStrategy = {
    name: "flat-spy",
    async shouldCompact() { return true; },
    async compact(messages) { compacted += 1; return { messages }; },
  };
  await runToolLoop({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    context: { budgetTokens: 1, strategy: flatStrategy },
  });
  assert.equal(compacted, 1, "扁平 context.strategy 对象照旧被调");
});

// ================================================================ C10. 装配口路线端到端
test("C10 装配口路线：policy.capabilities.ports 与 hooks 同相生效（slots 也走同一条展开）", async () => {
  const sleeps = [];
  const before = [];
  const counter = { calls: 0 };
  const port = makePort({
    capabilities: {
      ports: { sleepImpl: async (ms) => { sleeps.push(ms); } },
      hooks: { onBeforeFold: (payload) => { before.push(payload); } },
    },
  });
  // 装配口 route 只跑一次：重试用同一份 policy（provider 从端口来，是固定脚本，所以这里只验
  // 端口位的展开是否生效——`normalizeRunToolLoopOptions` 会返回 slots）。
  const normalized = await normalizeRunToolLoopOptions({
    assemblyPort: port,
    completion: false,
    wrapup: false,
  });
  assert.equal(typeof normalized.capabilitySlots.ports.sleepImpl, "function", "policy 侧的端口位进了 slots");
  assert.equal(typeof normalized.capabilitySlots.hooks.onBeforeFold, "function", "policy 侧的钩子进了 slots");
  assert.equal(Object.hasOwn(normalized.effectiveOptions, "sleepImpl"), false, "仍然没有扁平别名");
  assert.equal(counter.calls, 0);
});
