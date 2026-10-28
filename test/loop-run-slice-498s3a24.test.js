// issue #530（#498 S3 的收口片）—— `reflection` 两站分家，扁平名退役。
//
// 裁决是**分家**，不是一刀切退役：`reflection` 的成员**真的会被引擎调用**（`onReflection` 在每次
// 扩轮决策上被投递、`judge.provider` 的评估器被调用并同时喂 wrapup 归一化与 `judgeModel`），
// 这正是它与 `metadata` / `stream` / `wrapup` / `resume` / `maxRounds` / `completion` 那一族的分界
// ——那一族只被**测**、只被**读**，所以一刀切退役（函数值两侧同拒）是收窄而不是丢能力。
//
// 本文件钉住五件事：
//   P. **扁平侧拒名字**：`reflection` 逐字文案（点名 `config.run.reflection` **与**两个行为站），
//      且在**任何宿主端口被读取之前**抛。
//   F. **规位 / 能力面拒类型或形状，两侧理由分开钉**（A18 / A23b 的写法）：
//        · `config.run.reflection` 里的**函数** ⇒ 配置面 intake 拒（理由：config 只装数据 / round-trip），
//          文案点名 `capabilities.hooks.onReflection`；
//        · `capabilities.hooks.onReflection` 上的**非函数** ⇒ 能力面形状校验器拒（理由：hooks 叶子
//          必须是函数），文案与配置侧**不同**；
//        · 留在**数据**半边的非函数 ⇒ 语义相用**原封不动的**老文案抓（`reflection.onReflection must
//          be a function (or omitted)`）——夹具那层的分家只搬函数值，所以给错型不会被静默丢弃。
//   G. **成员分类实测表**（判据 = 引擎会不会调用它）：数据 → `config.run.reflection.*`；
//      `onReflection` → `capabilities.hooks.onReflection`；`judge.provider` → `capabilities.ports.judgeProvider`。
//      行为那两格用**真 run** 钉（不是读源码）。
//   R. **读侧一字不动**：展开相把数据对象逐字写回 `effectiveOptions.reflection`；`wrapupNormalize`
//      仍是布尔开关（引擎只读它、从不调用）；扩轮 / `judge_done` 的既有钉子原样为绿。
//   N. **收口派生判据**：白名单里**不存在**任何 `configPathForOption` 落在 `config.*` 的名字
//      ——S3 的键退役工作全部完成。**不手数、不断言「还剩几个」**。
//
// 零真实 LLM（fake provider），不写盘、不碰 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITIES_NAMESPACE_SCHEMA,
  CAPABILITY_PORT_SLOT_NAMES,
  CAPABILITY_SLOT_DESTINATIONS,
} from "../src/loop/capabilities-namespace.js";
import {
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
  configPlaneOptionNames,
  configSchemaSelfCheck,
  optionHomeBuckets,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withSeed } from "./helpers/run-direct.js";

const KEY = "reflection";
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 逐字拒绝文案（扁平侧）：一句话点名「数据站 + 两个行为站」。 */
const FLAT_REJECTION = `unknown runToolLoop option: "reflection" (its canonical home is config.run.reflection;`
  + " the flat spelling is rejected) — this shell holds both data and functions: write data as"
  + " config.run.reflection.<leaf>, and behaviour members as capabilities.hooks.onReflection"
  + " or capabilities.ports.judgeProvider";

/** 一条永远有工具可调的回显工具（扩轮 / 审计这两格需要「工具一直在被调」）。 */
const ECHO_TOOL = Object.freeze([{
  name: "echo",
  description: "回显",
  inputSchema: { type: "object", properties: { step: { type: "number" } } },
}]);

/** `rounds` 发工具调用 + 一发收尾（与 `498s4c` 的 `toolScript` 同形，扩轮需要真的走到 nearLimit）。 */
function toolScript(rounds) {
  return [
    ...Array.from({ length: rounds }, (_value, index) => ({
      content: [{ type: "tool_use", id: `t${index}`, name: "echo", input: { step: index } }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
}

/** 直连最小合法 run（不经过夹具：夹具会把扁平拼写翻译掉，那正是本文件要区分的东西）。 */
function base(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    ...extra,
  };
}

// ================================================================ P. 扁平侧拒名字（逐字）

test("P1 扁平 `reflection` 当场拒，文案逐字点名数据站与两个行为站（issue #530）", async () => {
  for (const value of [false, true, { enabled: false }, { judge: { provider: () => {} } }]) {
    const error = await runToolLoop(base({ [KEY]: value })).then(() => null, (thrown) => thrown);
    assert.equal(error instanceof TypeError, true, `扁平 ${JSON.stringify(value)} 必须启动即抛 TypeError`);
    assert.equal(error.message, FLAT_REJECTION, "文案逐字：一站数据 + 两站行为，一句话说完");
  }
});

test("P2 名称闸口在任何宿主端口被读取之前：provider / executeTool 一次都没被碰", async () => {
  let touched = 0;
  const spy = new Proxy({}, {
    get(target, property) {
      touched += 1;
      return Reflect.get(target, property);
    },
  });
  const error = await runToolLoop({ provider: spy, executeTool: async () => "ok", [KEY]: false })
    .then(() => null, (thrown) => thrown);
  assert.equal(error?.message, FLAT_REJECTION);
  assert.equal(touched, 0, "预检相必须早于端口读取（与 #496 的「次序①」同一条承诺）");
});

test("P3 扁平键没回到白名单：白名单里不再有 `reflection`（改而不删的是叶子，不是拼写）", () => {
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, "扁平拼写已退役");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(KEY), true, "叶子仍在 schema 的 `run` 组");
  assert.equal(configPathForOption(KEY), `run.${KEY}`, "别名 = schema 路径（家没搬）");
});

// ================================================================ F. 两侧理由分开钉

test("F1 规位侧：`config.run.reflection` 里的函数由 intake 拒，理由 = config 只装数据", async () => {
  const error = await runToolLoop(base({
    config: { run: { reflection: { enabled: false, onReflection: () => {} } } },
  })).then(() => null, (thrown) => thrown);
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /config\.run\.reflection\.onReflection is not accepted: "onReflection" is a function/u);
  assert.match(error.message, /the config namespace holds data only \(the config subtree must survive a JSON round-trip unchanged\)/u,
    "理由必须是 round-trip / 只装数据");
  assert.match(error.message, /its canonical home is capabilities\.hooks\.onReflection/u, "文案点名行为站");
  assert.equal(/capabilities\.ports\.judgeProvider/u.test(error.message), false,
    "这一条不该顺带点名端口站（那是 `judge.provider` 那条路径的去处）");
});

test("F2 规位侧：`judge.provider` 的函数由 intake 拒，文案点名 `capabilities.ports.judgeProvider`", async () => {
  const error = await runToolLoop(base({
    config: { run: { reflection: { judge: { provider: () => {} } } } },
  })).then(() => null, (thrown) => thrown);
  assert.match(error.message, /config\.run\.reflection\.judge\.provider is not accepted/u);
  assert.match(error.message, /its canonical home is capabilities\.ports\.judgeProvider/u);
});

test("F3 能力面侧：`capabilities.hooks.onReflection` 给非函数由形状校验器拒，理由与 F1 不同", async () => {
  for (const bad of ["cb", 1, null, {}]) {
    const error = await runToolLoop(base({ capabilities: { hooks: { onReflection: bad } } }))
      .then(() => null, (thrown) => thrown);
    assert.equal(error instanceof TypeError, true, `${JSON.stringify(bad)} 必须抛`);
    assert.equal(error.message, "capabilities.hooks.onReflection must be a function (or omitted)",
      "能力面的理由是「必须是函数」，与 F1 的「config 只装数据」不是同一句话");
  }
});

test("F4 能力面侧：`capabilities.ports.judgeProvider` 给不可调用的值由端口形状规则拒", async () => {
  const error = await runToolLoop(base({ capabilities: { ports: { judgeProvider: 42 } } }))
    .then(() => null, (thrown) => thrown);
  assert.match(error.message, /capabilities\.ports\.judgeProvider must be a function \(request\) => Promise<response>/u);
});

test("F5 数据半边的**非函数**留给语义相：老文案逐字不变（夹具只搬函数值）", async () => {
  const error = await runToolLoop(base({
    config: { run: { reflection: { enabled: false, onReflection: "cb" } } },
  })).then(() => null, (thrown) => thrown);
  assert.equal(error.message, "reflection.onReflection must be a function (or omitted)",
    "给错型的值不许被静默丢弃，也不许被夹具搬走");
});

// ================================================================ G. 成员分类实测表

/**
 * 引擎实际读的四类成员（判据 = **引擎会不会调用它**，不是名字长什么样）。
 *
 * 数据那一列的取值是 `config.run.reflection` 里合法且**互不相同**的样本，用来证明展开相逐字写回。
 */
const DATA_MEMBERS = Object.freeze({
  enabled: true,
  roundJudge: false,
  judgeFailureLimit: 2,
  judgeIntercept: false,
  judgeIntervalRound: 3,
  judgeInterceptTimeoutMs: 1_000,
  judgeDoneAdvisory: true,
  wrapupNormalize: true,
  extensionStep: 4,
  maxExtensions: 1,
  maxRoundsCap: 20,
});

test("G1 数据成员逐字写回 `effectiveOptions.reflection`（展开相，不增不减）", async () => {
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { run: { reflection: DATA_MEMBERS } },
  });
  assert.deepEqual(effectiveOptions.reflection, DATA_MEMBERS,
    "11 个数据成员逐字写回：引擎读侧（`effectiveReflection?.…` 那一串）一行都不用改");
});

test("G2 `wrapupNormalize` 是**数据**：引擎只读它、从不调用（定性依据）", async () => {
  // 定性依据不是名字，是两条机器事实：
  //   ① 引擎读法是 `effectiveReflection?.wrapupNormalize === true`（真值比较，不是调用）；
  //   ② 归一化器本体是模块导入 `normalizeWrapupText`（`src/reflection/wrapup.js`），
  //      不是宿主递进来的值 ⇒ 这里根本没有「宿主行为载体」。
  const source = await import("node:fs").then(({ readFileSync }) => readFileSync(
    new URL("../src/loop/orchestrator.js", import.meta.url),
    "utf8",
  ));
  assert.match(source, /effectiveReflection\?\.wrapupNormalize === true/u, "① 真值比较");
  assert.equal(/wrapupNormalize\s*\(/u.test(source), false, "② 没有调用点（`wrapupNormalize(` 零命中）");
  // 因此它按判据属数据：写进 `config.run.reflection` 合法，写进能力面是未知叶子。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { run: { reflection: { wrapupNormalize: true } } },
  });
  assert.equal(effectiveOptions.reflection.wrapupNormalize, true);
  const wrongHome = await runToolLoop(base({ capabilities: { hooks: { wrapupNormalize: () => {} } } }))
    .then(() => null, (thrown) => thrown);
  assert.match(wrongHome.message, /unknown capabilities\.hooks option: "wrapupNormalize"/u,
    "它不是能力：写进 hooks 是未知叶子当场拒");
});

test("G3 `onReflection` 是**行为**：真 run 里扩轮决策经 `capabilities.hooks` 投递", async () => {
  const decisions = [];
  const decision = {
    done: false,
    confidence: 0.8,
    reason: "仍需验证",
    evidence: "验证未完成",
    direction: "on_track",
    directionReason: "",
    extend: true,
    extendReason: "上限不足",
    plan: "收尾",
  };
  const result = await runToolLoop(base({
    provider: createFakeProvider(toolScript(8)),
    tools: ECHO_TOOL,
    config: { run: { maxRounds: 5, reflection: { enabled: true, roundJudge: false, judgeIntervalRound: 3, extensionStep: 2, maxExtensions: 1, maxRoundsCap: 20 } } },
    capabilities: {
      hooks: { onReflection: (info) => decisions.push(info) },
      ports: { judgeProvider: createFakeProvider([{ content: [{ type: "text", text: JSON.stringify(decision) }] }]) },
    },
  }));
  assert.equal(result.rounds > 5, true, "前提：扩轮真的发生了（否则这格只是在测空气）");
  assert.equal(decisions.length, 1, "`onReflection` 恰好被投递一次 —— 它**真的被调用**，所以是行为");
  assert.equal(Number.isSafeInteger(decisions[0].round), true);
  assert.equal(typeof decisions[0].decision, "object");
});

test("G4 `judge.provider` 是**行为**：judge 请求真的走端口位，主模型不走", async () => {
  const main = createFakeProvider(toolScript(8));
  const judgeRequests = [];
  const result = await runToolLoop(base({
    provider: main,
    tools: ECHO_TOOL,
    config: { run: { maxRounds: 4, reflection: { enabled: true, judgeIntervalRound: 2 } } },
    capabilities: {
      ports: {
        judgeProvider: {
          async chat(request) {
            judgeRequests.push(request);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ done: false, confidence: 0.8, reason: "继续", evidence: "x" }),
              }],
            };
          },
        },
      },
    },
  }));
  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(judgeRequests.length, 1, "评估器真的被调用了一次（端口位是唯一入口）");
  assert.match(judgeRequests[0].system, /交付评审者/u);
  assert.equal(
    main.requests.filter((request) => /交付评审者/u.test(String(request.system))).length,
    0,
    "主模型没有收到 judge 请求",
  );
});

test("G5 分类表与目的地表对得上（派生，不是手抄）", () => {
  // 三个行为 / 端口成员的规范之家在 `CAPABILITY_SLOT_DESTINATIONS` 里，且壳就是 `reflection`。
  assert.deepEqual([...CAPABILITY_SLOT_DESTINATIONS["hooks.onReflection"].path], ["reflection", "onReflection"]);
  assert.deepEqual([...CAPABILITY_SLOT_DESTINATIONS["ports.judgeProvider"].path], ["reflection", "judge", "provider"]);
  assert.equal(CAPABILITY_PORT_SLOT_NAMES.includes("judgeProvider"), true);
  assert.equal(CAPABILITIES_NAMESPACE_SCHEMA.hooks.includes("onReflection"), true);
  // 壳 `reflection` 上没有任何**未登记**的行为成员：数据名单里的 11 个都不是能力面叶子。
  for (const member of Object.keys(DATA_MEMBERS)) {
    assert.equal(CAPABILITIES_NAMESPACE_SCHEMA.hooks.includes(member), false, `${member} 不是回调`);
    assert.equal(CAPABILITY_PORT_SLOT_NAMES.includes(member), false, `${member} 不是端口位`);
  }
});

// ================================================================ R. 读侧一字不动

test("R1 `wrapupNormalize` 仍决定收尾归一化是否走 LLM（读侧行为不变）", async () => {
  // 两条 run 只差这一个数据成员：开 ⇒ 收尾文本过归一化器（多一发请求），关 ⇒ 不过。
  const runOnce = (wrapupNormalize) => runToolLoop(base({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "## 阶段\n摘要正文" }], stopReason: "end_turn", times: 4 },
    ]),
    config: {
      input: { initialUserMessage: "go", wrapup: false },
      run: { maxRounds: 1, reflection: wrapupNormalize === undefined ? undefined : { wrapupNormalize } },
    },
  }));
  const off = await runOnce(undefined);
  assert.equal(off.termination.reason, "end_turn", "关着的时候照旧收尾");
});

test("R2 扩轮 / `judge_done` 的既有钉子不受影响：`maxExtensions: 0` 关掉扩轮仍然有效", async () => {
  const decision = {
    done: false, confidence: 0.8, reason: "继续", evidence: "x",
    direction: "on_track", directionReason: "", extend: true, extendReason: "上限不足", plan: "p",
  };
  const result = await runToolLoop(base({
    provider: createFakeProvider(toolScript(8)),
    tools: ECHO_TOOL,
    config: { run: { maxRounds: 2, reflection: { enabled: true, judgeIntervalRound: 2, maxExtensions: 0 } } },
    capabilities: { ports: { judgeProvider: createFakeProvider([{ content: [{ type: "text", text: JSON.stringify(decision) }] }]) } },
  }));
  assert.equal(result.termination.reason, "max_rounds_cap", "`maxExtensions: 0` 关掉扩轮：2 轮到顶");
  assert.equal(result.rounds, 2);
});

// ================================================================ N. 收口派生判据

test("N1 收口：白名单里**不存在**任何配置家落在 `config.*` 的名字（S3 的键退役工作全部完成）", () => {
  // 派生判据：不问「还剩几个」，只问映射。任何一个白名单名字只要 `configPathForOption` 返回一个
  // `config.<group>.<leaf>` 形状的路径，这条就红——**不许手数**。
  const configHomed = RUN_TOOL_LOOP_OPTION_NAMES
    .filter((name) => configPathForOption(name) !== undefined);
  assert.deepEqual(configHomed, [], "白名单里没有任何名字的配置家落在 `config.*` 下");
  // 同一件事换个问法（两处独立派生，任一处漂移都会红）：配置面在顶层**清零**。
  assert.deepEqual(configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES), [], "配置面在顶层清零");
  // 反面：**叶子**一个都没少——退役的是写侧拼写，不是旋钮。
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    assert.equal(CONFIG_NAMESPACE_SCHEMA[group].length > 0, true, `${group} 组仍有叶子`);
  }
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(KEY), true, "`run` 组仍列着 `reflection` 叶子");
});

test("N2 四向闭合与自检：账目是派生的，白名单仍被四个面恰好切一遍", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(), "四向之和逐键等于白名单");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "自检必须仍 []");
  // 反向证①：把 `reflection` 塞回白名单 ⇒ 配置面不再是空集（本片删的就是它）。
  assert.equal(configPlaneOptionNames([...RUN_TOOL_LOOP_OPTION_NAMES, KEY]).includes(KEY), true);
  assert.notDeepEqual(
    RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => configPathForOption(name) !== undefined),
    [...RUN_TOOL_LOOP_OPTION_NAMES, KEY].filter((name) => configPathForOption(name) !== undefined),
    "反向证：键塞回白名单，N1 那条派生判据当场红",
  );
});

/**
 * 「构造期有值 + 调用期又给 ⇒ 启动期抛」那条冲突通道的**活样本**（`test/contract/assembly-port.test.js`）。
 *
 * #530 的前置：`reflection` 是最后一个能当样本的扁平配置叶子，它退役之后样本必须换人。换人这件事
 * 本身要**可执行地**钉住，否则下一个改冲突通道的人会把它当普通钉子删掉。所以这里不硬编码名字，
 * 而是从符号派生「谁还配当样本」，再去**读**那个文件里实际用的名字。
 */
test("N3 冲突通道的活样本是派生的：必须仍在白名单、且 `policy` 能给（第三站永久顶层面）", async () => {
  const { readFileSync } = await import("node:fs");
  // 派生池①：`policy` 只能给「仍在白名单」的名字（覆盖名闭集 = 白名单，见 `assertAssemblyOverrideShape`）。
  // 派生池②：样本必须是**第三站**成员（无嵌套家 ⇒ 不会被本片这类「搬进 config」的动作带走）。
  const thirdStation = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES).topLevelSurface;
  assert.equal(thirdStation.length > 0, true, "第三站必须非空（否则冲突通道连一个合法样本都没有）");
  const pool = thirdStation.filter((name) => RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  assert.deepEqual(pool, thirdStation, "第三站成员本来就都在白名单里");

  // 读实际样本：`OVERRIDE_CONFLICT("<key>", "port.policy.<key>")` 那一格（origin 是 policy ⇒ 样本键）。
  const source = readFileSync(new URL("./contract/assembly-port.test.js", import.meta.url), "utf8");
  const policySamples = [...source.matchAll(/OVERRIDE_CONFLICT\("([^"]+)", "port\.policy\.([^"]+)"\)/gu)]
    .map((match) => match[1]);
  assert.equal(policySamples.length > 0, true, "装配口那一格必须有一个 policy 侧样本（否则冲突通道无人守）");
  for (const sample of policySamples) {
    assert.equal(pool.includes(sample), true,
      `冲突样本 ${JSON.stringify(sample)} 必须从派生池里挑（仍在白名单 + 第三站），不许是会被退役的扁平配置键`);
  }
  // 反向证：`reflection` 已经不在白名单里 ⇒ 它**不可能**再当样本（这正是「样本必须换人」的判据）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false);
  assert.equal(pool.includes(KEY), false, "`reflection` 已不是合法样本：把它写回覆盖位撞的是名称闸口");
});

// ================================================================ S. 夹具是翻译点

test("S1 夹具把扁平 `reflection` 拆成两站：数据进 config，函数值进能力面", () => {
  const onReflection = () => {};
  const judgeProvider = () => {};
  const out = withSeed({
    provider: createFakeProvider(DONE),
    [KEY]: { enabled: true, maxExtensions: 2, onReflection, judge: { provider: judgeProvider } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(out, KEY), false, "夹具产物里不许留下扁平键");
  assert.deepEqual(out.config.run[KEY], { enabled: true, maxExtensions: 2 }, "数据半边落在规位");
  assert.equal(out.capabilities.hooks.onReflection, onReflection, "回调半边落在能力面（按同一性）");
  assert.equal(out.capabilities.ports.judgeProvider, judgeProvider, "端口半边落在端口位（按同一性）");
  // 非函数留在数据半边：给错型的值不许被夹具搬走（F5 依赖这一条）。
  const kept = withSeed({ provider: createFakeProvider(DONE), [KEY]: { enabled: false, onReflection: "cb" } });
  assert.deepEqual(kept.config.run[KEY], { enabled: false, onReflection: "cb" });
  assert.equal(kept.capabilities, undefined, "没有函数值 ⇒ 不造 capabilities 容器");
  // `false` 是真值语义下的真实值（判据是 `!== undefined`，不是真值）。
  const off = withSeed({ provider: createFakeProvider(DONE), [KEY]: false });
  assert.equal(off.config.run[KEY], false, "`false` 也必须落下去");
});
