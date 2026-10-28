// issue #498（S3）—— `run` 组的垂直切片 **A23b**：`completion` 按裁决退役（白名单 28 → 27）。
//
// 裁决路径：**照 `metadata` 族 / `stream` / `resume` / `maxRounds` 先例退役**（甲）。判据只有一个：
// **引擎会不会调用它**。实测——不会。`src/loop/` 与 `bin/` 里 `completion` 只有三种读法：
// `completion !== false`、`completion?.signals`、`completion?.maxNoToolRounds`
// （`src/loop/orchestrator.js`），`completion(` / `.call` / `.apply` **零命中**。于是函数值在那个
// 位置**从来不是行为**：`config` 只装数据，函数本来就被 intake 当场拒。所以本片**不**加校验器、
// 不把 `completion` 搬去能力面，也**不动**任何读侧代码——它只是把**写侧拼写**收成一处。
//
// 本文件钉五件事（账目全部派生，不手抄条数）：
//   P. 反向拒绝钉：顶层再写 `completion` ⇒ 当场拒，文案**逐字**指向 `config.run.completion`，
//      并且拒在任何宿主端口被调用之前（零请求）。
//   F. 函数值：**两个拼写都被拒**——扁平侧是名称闸口，规位侧是 `config` 的 intake；两条理由
//      分开钉（这是裁决接受的那条收窄，不许因为「退役了」就把它抹成一句）。
//   R. 读侧不动：展开相逐字写回 `effectiveOptions.completion`；真 run 里
//      `config.run.completion.maxNoToolRounds` 仍然真的决定「连续几轮无工具算完成」
//      （`no_tool` 收尾），`false` 仍然整条关掉（收尾回落到 `end_turn`）。
//   N. 邻接与账目：`run` 组剩余的「配置家」条数由白名单**派生**（不手抄 2 / 1）；叶子仍在
//      schema 的 `run` 组；四向闭合与「每个顶层选项恰好一个家」派生自证。
//   S. 夹具是翻译点：`withSeed` 产物里没有扁平 `completion`，值落在 `config.run.completion`
//      （`false` 也要落：判据是 `!== undefined`，不是真值）。
//
// 零真实 LLM（fake provider），不写盘、不碰 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
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

/** 本片退役的键（数据壳 / 字面量 `false`；家由 schema 派生）。 */
const KEY = "completion";
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.completion`），拒绝文案里点名的那一条。 */
function homeOf(key) {
  const path = configPathForOption(key);
  assert.equal(typeof path, "string", `${key} 失去顶层键之后必须仍有 config 家`);
  return `config.${path}`;
}

/**
 * 最小合法 run：一次 end_turn 就结束。
 *
 * **不经过** `runDirect` 夹具——夹具会把扁平拼写翻译进规位，于是「扁平拼写被拒」这一格
 * 永远测不到。本文件要测的正是引擎拼写，所以直连 `runToolLoop`。
 */
function base(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    ...extra,
    // `config` 是**合并**而不是覆盖：`...extra` 之后再写一个字面量 `config` 会把调用方那份
    // 静默顶掉（后者胜）——那正是 `test/loop-seed-fixture-521.test.js` 的 G1 在扫的雷。
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", wrapup: false, ...extra.config?.input },
      // #498 S3 A23b：默认的 `completion: false` 也在这棵 `run` 子树里（同一个容器，绝不造
      // 第二个 `config` 键）。调用方给的 `config.run.completion` 写在后面 ⇒ 它赢。
      run: { completion: false, ...extra.config?.run },
    },
  };
}

/** 直连 `runToolLoop` 的「抛了什么」（不抛返回 null）。 */
function rawError(options) {
  return runToolLoop(options).then(() => null, (error) => error);
}

async function exitCode(options) {
  try {
    await runToolLoop(options);
    return 0;
  } catch {
    return 1;
  }
}

// ================================================================ P. 反向拒绝

test(`P1 扁平拼写已退役：名称闸口当场拒，文案逐字点名 ${KEY} 的新家`, async () => {
  const home = homeOf(KEY);
  assert.equal(home, "config.run.completion", "家必须仍是 config.run.completion（删扁平键 ≠ 删叶子）");
  for (const value of [false, true, { signals: ["done"], maxNoToolRounds: 3 }, { maxNoToolRounds: 0 }]) {
    const label = JSON.stringify(value);
    const error = await rawError(base({ [KEY]: value }));
    assert.equal(error instanceof TypeError, true, `${label}：扁平拼写必须当场拒`);
    assert.equal(
      error.message,
      `unknown runToolLoop option: "${KEY}" (its canonical home is ${home}; the flat spelling is rejected)`,
      `${label}：拒绝文案必须逐字点名 ${home}`,
    );
    // 同一个取值写在规位侧 ⇒ 照旧可达（退役只收写法，不收取值）。
    assert.equal(
      await exitCode(base({ config: { run: { [KEY]: value } } })),
      0,
      `${label}：规位侧必须仍可达（退役 ≠ 丢能力）`,
    );
  }
});

test("P2 拒在任何宿主端口被调用之前：零请求、零工具调用", async () => {
  let providerCalls = 0;
  let executorCalls = 0;
  const error = await rawError({
    provider: {
      async chat() {
        providerCalls += 1;
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
      },
    },
    executeTool: async () => {
      executorCalls += 1;
      return "ok";
    },
    [KEY]: false,
  });
  assert.equal(error instanceof TypeError, true, "名称闸口必须抛");
  assert.equal(providerCalls, 0, "拒绝必须早于 provider.chat");
  assert.equal(executorCalls, 0, "拒绝必须早于 executeTool");
});

// ================================================================ F. 函数值：两个拼写都拒（理由分开）

test("F1 函数值：扁平侧与规位侧**都**被拒，且两条理由分开钉", async () => {
  const marker = () => ({ signals: [], maxNoToolRounds: 1 });
  const home = homeOf(KEY);

  // ① 扁平侧：名称闸口 —— 理由是「这个名字已经不在接受名单里」，与新家在哪。
  const flat = await rawError(base({ [KEY]: marker }));
  assert.equal(flat instanceof TypeError, true, "扁平侧必须拒");
  assert.equal(
    flat.message,
    `unknown runToolLoop option: "${KEY}" (its canonical home is ${home}; the flat spelling is rejected)`,
    "扁平侧的理由 = 名称闸口（逐字）",
  );
  assert.equal(/the config namespace holds data only/u.test(flat.message), false,
    "扁平侧的理由**不是**「config 只装数据」——两条理由不许糊成一句");

  // ② 规位侧：`config` 的 intake —— 理由是「config 子树只装数据」，与「引擎从不调用它」。
  const nested = await rawError(base({ config: { run: { [KEY]: marker } } }));
  assert.equal(nested instanceof TypeError, true, "规位侧必须拒");
  assert.match(nested.message, new RegExp(`^config\\.run\\.${KEY} is not accepted:`, "u"),
    "规位侧的理由 = config intake（逐字开头）");
  assert.match(nested.message, /is a function, and the config namespace holds data only/u,
    "规位侧理由①：config 子树只装数据（过 JSON round-trip 等值）");
  assert.match(nested.message, /the engine never calls it, it only forwards the value/u,
    "规位侧理由②：引擎从不调用它（所以这不是丢能力，是收窄）");
  assert.equal(/unknown runToolLoop option/u.test(nested.message), false,
    "规位侧的理由**不是**名称闸口——两条理由不许糊成一句");
});

// ================================================================ R. 读侧一字不动

test("R1 展开相逐字写回 `effectiveOptions.completion`（不做类型化、不改写）", async () => {
  const values = [
    false,
    true,
    { signals: ["done"], maxNoToolRounds: 3 },
    { maxNoToolRounds: 0 },
  ];
  for (const value of values) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { run: { [KEY]: value } } });
    assert.deepEqual(effectiveOptions[KEY], value, `${JSON.stringify(value)} 必须逐字写回`);
  }
  // 没给就是没给：展开相不许凭空造一个 `completion`。
  const { effectiveOptions: none } = await normalizeRunToolLoopOptions({ config: { run: {} } });
  assert.equal(Object.hasOwn(none, KEY), false, "没给 `config.run.completion` ⇒ 不产生 `effectiveOptions.completion`");
});

test("R2 真行为：`config.run.completion.maxNoToolRounds` 仍然真的决定「几轮无工具算完成」", async () => {
  // `src/loop/orchestrator.js` 的两处读法（`completion !== false` / `completion?.maxNoToolRounds`）
  // 与 `src/reflection/governor.js` 的 `noToolStreak >= maxNoToolRounds` 一字未改；本格只是把
  // **写侧拼写**换成规位之后，把那条行为接回来（第 1 轮真调工具，之后每轮只有文本）。
  const tools = [{
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }];
  const script = [
    { content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }], stopReason: "tool_use" },
    ...Array.from({ length: 5 }, () => ({ content: [{ type: "text", text: "还在想，没动手" }], stopReason: "end_turn" })),
  ];
  const run = (completion) => runToolLoop(base({
    provider: createFakeProvider(script),
    tools,
    config: { run: { [KEY]: completion, maxRounds: 6 } },
  }));

  const one = await run({ maxNoToolRounds: 1 });
  assert.equal(one.rounds, 2, "阈值 1 ⇒ 第 1 轮工具 + 第 1 轮无工具就停（既有语义）");
  assert.equal(one.termination.reason, "no_tool", "停法仍是 `no_tool`（不是本片发明的）");

  const three = await run({ maxNoToolRounds: 3 });
  assert.equal(three.rounds, 4, "阈值 3 ⇒ 第 1 轮工具 + 3 轮无工具才停（阈值真的被读）");
  assert.equal(three.termination.reason, "no_tool");

  // `completion: false` 关掉整条判定（既有语义）：不再由 `maxNoToolRounds` 提前收尾。
  const off = await run(false);
  assert.equal(off.termination.reason, "end_turn", "`false` 关掉判定之后不许再以 `no_tool` 收尾");
  assert.ok(off.rounds < three.rounds, "`false` 必须比阈值 3 更早收尾（判定真的被关掉了）");
});

// ================================================================ N. 邻接与账目（全部派生）

test("N1 四向闭合 + 自检：删键只搬家，不靠条数自证", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向之和逐键等于白名单（不靠条数自证）");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [],
    "每个顶层选项恰好一个家（自检同时反向钉住「`completion` 不许又变成配置面键 + 顶层键两份」）");
});

test("N2 账目派生化：`run` 组的「配置家」顶层键只剩一个（不手抄 2 / 1）", () => {
  // 「config 家」= 仍是顶层选项、且 `configPathForOption` 落在 `run.` 下的键。
  // A22 之前是 3（`maxRounds` / `reflection` / `completion`），A21 删 `maxRounds` ⇒ 2，
  // A23b 删 `completion` ⇒ **1**（`reflection`）。两个数都由白名单派生，不写死。
  const runHomeKeys = RUN_TOOL_LOOP_OPTION_NAMES
    .filter((name) => (configPathForOption(name) ?? "").startsWith("run."));
  assert.deepEqual(runHomeKeys, ["reflection"],
    "`run` 组只剩一个配置家键（顺序 = 白名单顺序 = 建议平局优先级，不是集合语义）");
  assert.equal(runHomeKeys.includes(KEY), false, `${KEY} 已经不在其中（这就是本片删掉的那一格）`);
  // 反向证：把 `completion` 塞回白名单，本格当场红（`deepEqual` 多一项）。
  assert.notDeepEqual(
    [...RUN_TOOL_LOOP_OPTION_NAMES, KEY].filter((name) => (configPathForOption(name) ?? "").startsWith("run.")),
    runHomeKeys,
    "反向证：`completion` 回到白名单就必须让本格红",
  );
});

test("N3 删扁平键 ≠ 删叶子：`completion` 仍在 schema 的 `run` 组，且仍是那一个家", () => {
  const [, leaf] = homeOf(KEY).replace("config.", "").split(".");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(leaf), true, `${leaf} 必须仍在 schema 的 run 组`);
  assert.equal(configPathForOption(KEY), `run.${leaf}`, "别名 = schema 路径（不是第二张映射表）");
});

test("N4 邻接面没动：`reflection` 与 `store` 一件没动，已退役的邻接键不许回潮", () => {
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("reflection"), true, "`reflection` 仍可扁平写（本片不许收它）");
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("store"), true, "`store` 是永久顶层面，不许动");
  for (const retired of ["maxTokenContinuations", "stallDetection", "outputHygiene", "persistence",
    "partialPersistence", "replayPolicy", "invalidArguments", "writeToolNames", "writeToolPathKeys",
    "cwd", "stream", "resume", "runId", "maxRounds"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(retired), false, `${retired} 已由更早的切片退役，不许回潮`);
  }
});

// ================================================================ S. 夹具是翻译点

test("S1 `withSeed` 把扁平 `completion` 翻译进 `config.run.completion`，产物里没有扁平键", () => {
  // 夹具那一行（`RUN_FAMILY_FIXTURE_KEYS` 的 `"completion"`）在活树上只由本格与 A22 的 S1 守着：
  // 删掉它全量套件一格都不红（其它文件的扁平写点还在用它）。`false` 必须真的落下去——
  // 判据是 `!== undefined`，真值判断会把它丢掉。
  for (const value of [false, true, { signals: ["done"], maxNoToolRounds: 5 }]) {
    const out = withSeed({ [KEY]: value, provider: createFakeProvider(DONE) });
    assert.equal(Object.prototype.hasOwnProperty.call(out, KEY), false, "夹具产物里不许留下扁平键");
    assert.deepEqual(out.config.run[KEY], value, "值必须落在规位（`false` 也要落）");
  }
  const none = withSeed({ [KEY]: undefined, provider: createFakeProvider(DONE) });
  assert.equal(Object.prototype.hasOwnProperty.call(none, KEY), false, "没给就是没给");
  assert.equal(none.config?.run?.[KEY], undefined, "夹具不补默认值");
});
