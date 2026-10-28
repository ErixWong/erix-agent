// issue #498（S3）—— `run` 组的垂直切片 **A14**：`maxTokenContinuations` 的顶层扁平拼写离开白名单，
// 家是 `config.run.maxTokenContinuations`（`CONFIG_NAMESPACE_SCHEMA.run`，`src/loop/config-namespace.js`）。
//
// 与 A12/A13 的两处不同，写在最前面免得误读：
//   · 本键是**标量**（默认 3），不是「数据壳」；闸口二照旧每键抽查 ≥2 格合法形状（`0` / `3`），
//     结论仍是**纯数据、无回调** ⇒ 无需退回。
//   · 本片**没有新增夹具代码**：`test/helpers/run-direct.js` 的 `withRunFamily`（A12 落的单点翻译夹具）
//     本来就服务整个 `run` 组，本片只是把键加进那张表（`RUN_FAMILY_FIXTURE_KEYS`）。
//     于是「先量后写」的实测是：单删红格 **18**（夹具前）→ **8**（夹具后）→ **0**（迁完）。
//     夹具前后的 10 格差额就是夹具替调用方搬拼写的那些格子；剩下 8 格是**手写点**（内联白名单副本、
//     配置面等价样本、A5 的 P5-a、A11 的 N4、以及 readFile 容量锚点两格——最后两格是白名单删短行
//     推高平均行长带来的副产物，见交付报告）。
//
// ⚠ 撞名提醒（本键最容易被改错的地方）：`maxTokenContinuations` 与 A5 退役的 `maxTokens`
// **不同物**。A5 退的是 `config.tuning.maxTokens`（采样/输出预算），家 `tuning.*`；本键是
// `config.run.maxTokenContinuations`（同轮续写次数上限），家 `run.*`。A5 有专项钉（P5），本片翻它
// 的那一条时**只翻「还在不在白名单」，两条不同物的断言一字未动**。
//
// 本文件钉五件事（全部派生，不手抄键数）：
//   P. 旧名反向拒绝钉：顶层再写这个键 ⇒ 当场拒，文案**逐字**指向 `config.run.maxTokenContinuations`。
//   G. 闸口二矩阵：两格合法形状（`0` / `3`），规位侧 exit 0，扁平侧是名称闸口的拒。
//   F. 规位里给函数值 ⇒ 逐字两句话（`config` 只装数据 + 引擎从没调用过它）。
//   R. 读侧不动：规位里的值展开后逐字到达 `effectiveOptions.maxTokenContinuations`，且**行为**不变
//      （`0` ⇒ 首个 `max_tokens` 即 `continuation_exhausted`；`1` ⇒ 续写一次后 `end_turn`）。
//   N. 邻接：`maxTokens`（A5）不同物；`maxRounds` / `runId` / `resume` / `stream` / `completion` /
//      `reflection` / `cwd` 一件没动；夹具（`withRunFamily`）是翻译点，产物里没有扁平键。
//
// 零真实 LLM（fake provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
  configSchemaSelfCheck,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect, withSeed } from "./helpers/run-direct.js";

/** 本片退役的键（标量；家由 schema 派生）。 */
const KEY = "maxTokenContinuations";

/** 两格**合法形状**（扁平侧曾同样被接受，见 G 段；规位侧必须仍 exit 0）。 */
const LEGAL_SHAPES = [0, 3];

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.maxTokenContinuations`），拒绝文案里点名的那一条。 */
function homeOf(key) {
  const path = configPathForOption(key);
  assert.equal(typeof path, "string", `${key} 失去顶层键之后必须仍有 config 家`);
  return `config.${path}`;
}

/**
 * 最小合法 run：一次 end_turn 就结束。
 *
 * ⚠ **不经过 `runDirect` 夹具**：夹具会把扁平拼写翻译进规位（那正是它存在的理由），于是
 * 「扁平拼写被拒」这一格永远测不到。本文件要测的正是引擎拼写，所以直连 `runToolLoop`，
 * 种子也写成引擎拼写 `config.input.initialUserMessage`。
 */
function base(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    ...extra,
    // #498 S3 A18: `wrapup` left the allowlist, so the fixture-era flat switch is gone; the home is
    // `config.input.wrapup`. The container is **merged** instead of spread over: a call site that
    // passes its own `config` keeps both the seed and the wrap-up switch (a plain `config` key after
    // `...extra` would silently drop one of them).
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", wrapup: false, ...extra.config?.input },
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

test(`P1 扁平拼写已退役：名称闸口当场拒，文案逐字点名 ${KEY} 的新家（零建议）`, async () => {
  const home = homeOf(KEY);
  const error = await rawError(base({ [KEY]: 0 }));
  assert.equal(error instanceof TypeError, true, `${KEY} 的扁平拼写必须当场拒`);
  assert.equal(
    error.message,
    `unknown runToolLoop option: "${KEY}" (its canonical home is ${home}; the flat spelling is rejected)`,
    `${KEY} 的拒绝文案必须逐字点名 ${home}`,
  );
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, `${KEY} 不许还在白名单`);
});

// ================================================================ G. 闸口二

test(`G1 闸口二矩阵（${KEY}）：两个合法形状规位侧 exit 0，扁平侧是名称闸口的拒`, async () => {
  assert.ok(LEGAL_SHAPES.length >= 2, `${KEY} 至少要抽查 2 格合法形状`);
  for (const value of LEGAL_SHAPES) {
    const label = `${KEY}=${JSON.stringify(value)}`;
    const nested = await exitCode(base({
      config: { input: { initialUserMessage: "go" }, run: { [KEY]: value } },
    }));
    const flat = await exitCode(base({ [KEY]: value }));
    assert.equal(nested, 0, `${label}：规位必须可达（exit 0）`);
    assert.equal(flat, 1, `${label}：扁平拼写已退役 ⇒ 必须当场拒（不是静默忽略）`);
  }
});

// ================================================================ F. 函数值

test(`F1 规位里给函数值（${KEY}）：逐字两句话（只装数据 + 引擎从没调用过它）`, async () => {
  const error = await rawError(base({
    config: { input: { initialUserMessage: "go" }, run: { [KEY]: () => 1 } },
  }));
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(error.message, /the config namespace holds data only/u);
  assert.match(error.message, /the engine never calls it, it only forwards the value/u);
});

// ================================================================ R. 读侧不动

test(`R1 展开相逐字写回 effectiveOptions.${KEY}（读侧一行未改）`, async () => {
  for (const value of LEGAL_SHAPES) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { run: { [KEY]: value } } });
    assert.equal(effectiveOptions[KEY], value, `${KEY} 必须逐字到达 effectiveOptions`);
  }
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
});

test(`R2 行为不变：${KEY}=0 ⇒ 首个 max_tokens 即 continuation_exhausted；=1 ⇒ 续写一次后 end_turn`, async () => {
  const script = () => [
    { content: [{ type: "text", text: "partial" }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const exhausted = await runDirect({
    provider: createFakeProvider(script()),
    maxRounds: 4,
    config: { input: { initialUserMessage: "go" }, run: { [KEY]: 0 } },
    completion: false,
    wrapup: false,
    executeTool: async () => "ok",
  });
  assert.equal(exhausted.termination.reason, "continuation_exhausted", "预算 0 ⇒ 首发即用尽");
  const continued = await runDirect({
    provider: createFakeProvider(script()),
    maxRounds: 4,
    config: { input: { initialUserMessage: "go" }, run: { [KEY]: 1 } },
    completion: false,
    wrapup: false,
    executeTool: async () => "ok",
  });
  assert.equal(continued.termination.reason, "end_turn", "预算 1 ⇒ 续写一次后正常收尾");
});

// ================================================================ N. 邻接与账目

test("N1 只点一站：本键的值是纯数据，报错里不出现 `capabilities.` 那一站", async () => {
  const error = await rawError(base({ [KEY]: 0 }));
  assert.equal(error.message.includes("capabilities."), false, "拒绝文案不许提到能力站");
});

test("N2 撞名面没动：`maxTokenContinuations`（run 组）与 A5 退役的 `maxTokens`（tuning 组）不同物", async () => {
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, "本片退役的是它自己的扁平拼写");
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("maxTokens"), false, "`maxTokens` 由 A5 退役（不许回潮）");
  assert.equal(configPathForOption(KEY), "run.maxTokenContinuations");
  assert.equal(configPathForOption("maxTokens"), "tuning.maxTokens", "A5 的家不许被本片改回 run.*");
  assert.notEqual(configPathForOption(KEY), configPathForOption("maxTokens"), "两个键的家不同物");
  // 槽位面 / provider 请求字段的 `maxTokens` 从不经过名称闸口（`src/config/slot-provider.js`、
  // `src/messages/anthropic.js`），所以「本键退役」与它们无关——用真构造而不是「我看过了」由 A5 的
  // P5-b 钉着，本片不重复，只钉「白名单里两个名字都不在、家不同」。
});

test("N3 邻接面没动：`run` 组剩下六个大件一件没动，`maxRounds` / 端口照旧", () => {
  // #498 S3 A15：`cwd` 也退役了扁平写法（家 `config.run.cwd`），所以它从这条循环里移出、
  // 翻成反向钉；其余邻接键的断言一字未动。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("cwd"), false, "A15 已退役 `cwd` 的扁平写法");
  // #498 S3 A16：`stream` 同样退役（家 `config.run.stream`），走同一条「移出循环 + 反向钉」的改法。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("stream"), false, "A16 已退役 `stream` 的扁平写法");
  // #498 S3 A18：`wrapup` 也退役了（家 `config.input.wrapup`），同样从这条循环里移出、翻成反向钉。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("wrapup"), false, "A18 已退役 `wrapup` 的扁平写法");
  // #498 S3 A19：`resume` 也退役了（家 `config.run.resume`），同样从这条循环里移出、翻成反向钉
  // ——与 A15 对 `cwd`、A16 对 `stream`、A18 对 `wrapup` 的改法逐字同形（改而不删）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("resume"), false, "A19 已退役 `resume` 的扁平写法");
  // #498 S3 A20：`runId` 也退役了（家 `config.run.runId`），同样从这条循环里移出、翻成反向钉
  // ——与 A15 对 `cwd`、A16 对 `stream`、A18 对 `wrapup`、A19 对 `resume` 的改法逐字同形（改而不删）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("runId"), false, "A20 已退役 `runId` 的扁平写法");
  // #498 S3 A21：`maxRounds` 也退役了（家 `config.run.maxRounds`），同样从这条循环里移出、
  // 翻成反向钉——与上面五条逐字同形（改而不删）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("maxRounds"), false, "A21 已退役 `maxRounds` 的扁平写法");
  // #498 S3 A23b：`completion` 也退役了（家 `config.run.completion`），同样从这条循环里移出、
  // 翻成反向钉——与上面各条逐字同形（改而不删）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("completion"), false, "A23b 已退役 `completion` 的扁平写法");
  for (const key of ["reflection"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), true, `${key} 仍可扁平写（本片不许收它）`);
  }
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("store"), true, "`store` 是永久顶层面，不许动");
});

test("N4 删扁平键 ≠ 删叶子：`maxTokenContinuations` 仍在 `config.run` 里", () => {
  const [, leaf] = homeOf(KEY).replace("config.", "").split(".");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(leaf), true, `${leaf} 必须仍在 schema 的 run 组`);
});

test("N5 账目派生化：删键只搬家，配置面顶层键 + 孤儿叶子 = 叶子总数（不手抄 9 / 8）", () => {
  const leaves = Object.values(CONFIG_NAMESPACE_SCHEMA).flat();
  const configPlane = RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => configPathForOption(name) !== undefined);
  const orphanLeaves = leaves.filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.equal(configPlane.includes(KEY), false, `${KEY} 已退役 ⇒ 不在配置面顶层键里`);
  assert.equal(configPathForOption(KEY) !== undefined, true, `${KEY} 的叶子仍有家`);
  assert.ok(orphanLeaves.includes(KEY), `${KEY} 必须出现在「失去顶层键的叶子」里`);
  assert.equal(configPlane.length + orphanLeaves.length, leaves.length,
    "配置面顶层键 + 孤儿叶子必须等于叶子总数（删键只搬家，不丢叶子）");
});

test("N6 夹具是翻译点：`withRunFamily` 产物里没有扁平键，值落在 `config.run`", () => {
  const moved = withSeed({ [KEY]: 0, seed: "go" });
  assert.equal(Object.hasOwn(moved, KEY), false, "夹具漏摘扁平键 ⇒ 引擎当场拒（E1 那种反向格）");
  assert.equal(moved.config.run[KEY], 0, "值必须搬进 config.run");
  assert.equal(moved.config.input.initialUserMessage, "go", "种子照旧进 config.input");
  // `undefined` 逐字等于「没给」：不许造出 `run: { maxTokenContinuations: undefined }`。
  const untouched = withSeed({ [KEY]: undefined, seed: "go" });
  assert.equal(untouched.config.run, undefined, "undefined 不许被翻译成一个键");
});
