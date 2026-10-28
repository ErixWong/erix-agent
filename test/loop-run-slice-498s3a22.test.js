// issue #498（S3）—— `run` 组的垂直切片 **A22**：`completion` 的**量尺与退回**。
//
// ⚠ 状态更新（#498 S3 A23b）：`run.completion` **已经退役**——白名单 28 → 27、`config` 家 2 → 1。
// 下面 G2 因此按「改而不删」翻成了反向钉（扁平侧拒 / 规位侧仍可达），G1 的闸口二实测与 R1–R4
// 的读侧钉子原样保留（它们钉的是规位侧的事实，与键在不在白名单无关）。
//
// 本片**当时没有**退役 `run.completion`。按纪律它被**退回**（白名单仍是 28、`config` 家仍是 2），
// 理由是**体量**，不是语义：闸口二逐格实测**没有分歧**（见下面 G1 的规位侧六格），
// 但夹具翻译之后仍有 **180 格**红，越过本仓 `~150 格` 的「才删」门槛
// （A14 的定向测量预估「夹具后 ~180 格量级」，实测正好落在那条线上）。
//
// 于是本片交付的是**下一刀的前置件**：
//   · `test/helpers/run-direct.js` 的 `RUN_FAMILY_FIXTURE_KEYS` 多认一个键（`completion`）——
//     **一行新代码都没有**，与 A19 / A20 / A21 三次加键同一条路、同一个出口；
//   · `test/loop-config-namespace-497.test.js` 的 C4 把冲突样本从 `completion` 换成 `reflection`
//     （夹具一旦翻译 `completion`，扁平与规位就只剩一种写法，那格测不到冲突）；
//   · 剩余红格按文件列成作业单（见交付报告 /tmp/i498s3o-report.md）。
//
// 为什么本文件仍然要落盘（键都退回了，还钉什么）：
//   1. **夹具那一行是承重的、但自身无红可红**。把 `"completion",` 从 `RUN_FAMILY_FIXTURE_KEYS`
//      删掉，全量套件**一格都不红**（键还在白名单里，两种写法都合法）——也就是说没有本文件的 S 组，
//      下一刀的准备件可以被静默删掉。S1 把「夹具真的翻译了它」钉成可执行事实。
//   2. **闸口二的实测结论要留在树上**，不能只留在报告里：下一刀要先证明「没有分歧」才谈体量。
//      G1 用真 `runToolLoop` 跑规位侧六格（数据面全 ACCEPT、函数拒且文案点名 data-only），
//      G2 钉「扁平侧今天仍然接受」（退回状态 = 两种写法都合法）。
//   3. **读侧一字不动**：R1 钉展开相逐字写回 `effectiveOptions.completion`，R2 钉真实行为
//      （`maxNoToolRounds` 仍然真的决定「连续几轮无工具调用算完成」）。
//
// 判据（引擎会不会调用它）：**不会**。`src/loop/` 与 `bin/` 里 `completion` 只有三种读法——
// `completion !== false`、`completion?.signals`、`completion?.maxNoToolRounds`，
// `completion(` / `.call` / `.apply` 零命中（与 `metadata` 族 / `stream` / `wrapup` / `resume` /
// `maxRounds` 同一条先例）。所以「函数值两侧都被拒」不是丢掉能力，是收窄——但那要等下一刀。
//
// 零真实 LLM（fake provider），不写盘、不碰 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
  optionHomeBuckets,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withSeed } from "./helpers/run-direct.js";

const KEY = "completion";
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 直连 `runToolLoop`（**不经过**夹具：夹具会把扁平拼写搬进 `config.run`，那正是本文件要区分的东西）。 */
function base(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    ...extra,
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", wrapup: false, ...extra.config?.input },
      run: { ...extra.config?.run },
    },
  };
}

async function exitCode(options) {
  try {
    await runToolLoop(options);
    return 0;
  } catch {
    return 1;
  }
}

async function rawError(options) {
  return runToolLoop(options).then(() => null, (error) => error);
}

// ================================================================ G. 闸口二（逐格）

test("G1 闸口二（规位侧，真 run）：数据形态全 ACCEPT；函数拒，且文案点名 data-only", async () => {
  // 下一刀要用的那份实测：`false` / `true` / 完整对象 / 部分对象 / 非法成员 / `null` 在
  // `config.run.completion` 上**全部可达**（exit 0）——引擎不校验这个数据壳的内部形状，
  // 这是**既有**读侧语义（本片一个字没动），不是本片放宽出来的。
  const dataRows = [
    ["false", false],
    ["true", true],
    ["完整对象", { signals: ["done"], maxNoToolRounds: 3 }],
    ["部分对象（只有 maxNoToolRounds）", { maxNoToolRounds: 5 }],
    ["部分对象（只有 signals）", { signals: ["done"] }],
    ["空对象", {}],
    ["非法成员（引擎不解释的键）", { bogus: 1 }],
    ["null", null],
  ];
  assert.ok(dataRows.length >= 6, "闸口二至少抽查六格");
  for (const [label, value] of dataRows) {
    assert.equal(
      await exitCode(base({ config: { run: { [KEY]: value } } })),
      0,
      `${label}：规位侧必须可达（数据壳的内部形状引擎不校验，既有语义）`,
    );
  }

  // 函数是**唯一**在规位侧被拒的形态：`config` 只装数据（#498 S4a 约束 4，本片一行未改）。
  const nested = await rawError(base({ config: { run: { [KEY]: () => ({}) } } }));
  assert.equal(nested instanceof TypeError, true, "函数在规位侧必须拒");
  assert.match(nested.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(nested.message, /the config namespace holds data only/u);
});

test("G2 退役状态（#498 S3 A23b）：扁平拼写**当场被拒**，规位侧同一取值照旧可达", async () => {
  // A22 当时钉的是「退回状态 = 两种写法都合法」。A23b 删了白名单键 ⇒ 本格按「改而不删」翻成
  // 反向钉：**扁平侧拒**（文案逐字点名新家）+ **规位侧仍可达**（退役只收写法，不收取值）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, "`completion` 已离开白名单（A23b 退役它）");
  for (const value of [false, true, { signals: ["done"], maxNoToolRounds: 3 }]) {
    const error = await rawError(base({ [KEY]: value }));
    assert.equal(error instanceof TypeError, true, `${JSON.stringify(value)}：扁平拼写必须当场拒`);
    assert.equal(
      error.message,
      `unknown runToolLoop option: "${KEY}" (its canonical home is config.run.${KEY}; the flat spelling is rejected)`,
      `${JSON.stringify(value)}：拒绝文案必须逐字点名新家`,
    );
    assert.equal(
      await exitCode(base({ config: { run: { [KEY]: value } } })),
      0,
      `${JSON.stringify(value)}：规位侧必须仍可达（退役 ≠ 丢能力）`,
    );
  }
  // 反向证：把键塞回白名单，这一格当场红——`includes` 断言的承重面。
  assert.equal([...RUN_TOOL_LOOP_OPTION_NAMES, KEY].filter((name) => name === KEY).length, 1);
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
});

test("R2 真行为：`config.run.completion.maxNoToolRounds` 仍然真的决定「几轮无工具算完成」", async () => {
  // `src/loop/orchestrator.js` 的两处读法（`completion !== false` / `completion?.maxNoToolRounds`）
  // 与 `src/reflection/governor.js` 的 `noToolStreak >= maxNoToolRounds` 一字未改，本格只是把
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

// ================================================================ N. 账目派生

test("N1 四向闭合 + 自检：本片没搬任何键（白名单与配置面都原样）", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(), "四向之和逐键等于白名单");
  assert.equal(configPathForOption(KEY), "run.completion", "`completion` 的家仍是 config.run.completion");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(KEY), true, "叶子仍在 schema 的 run 组");
});

test("N2 账目派生化：`run` 组的配置家键清零（#530；不手抄 0 / 26）", () => {
  const runHomeKeys = RUN_TOOL_LOOP_OPTION_NAMES
    .filter((name) => (configPathForOption(name) ?? "").startsWith("run."));
  // A22 落地时这里还是 `["reflection"]`（`run` 组最后一个配置家顶层键）。#530 把 `reflection`
  // 也退役了（家 `config.run.reflection`），于是这一组清零——判据仍是派生的，不写死任何数字。
  assert.deepEqual(runHomeKeys, [], "`run` 组的配置家顶层键已经清零");
  // 反向证：多塞一个 `run` 家键回白名单，本格当场红。
  for (const reinserted of ["maxRounds", "reflection"]) {
    assert.notDeepEqual(
      [...RUN_TOOL_LOOP_OPTION_NAMES, reinserted]
        .filter((name) => (configPathForOption(name) ?? "").startsWith("run.")),
      runHomeKeys,
      `反向证：${reinserted} 回到白名单就必须让本格红`,
    );
  }
});

// ================================================================ S. 夹具是翻译点（本片唯一的代码改动）

test("S1 夹具真的翻译 `completion`：产物里没有扁平键，值落在 `config.run.completion`", () => {
  for (const value of [false, true, { signals: ["done"], maxNoToolRounds: 5 }]) {
    const out = withSeed({ [KEY]: value, provider: createFakeProvider(DONE) });
    assert.equal(Object.prototype.hasOwnProperty.call(out, KEY), false, "夹具产物里不许留下扁平键");
    assert.deepEqual(out.config.run[KEY], value, "值必须落在规位（`false` 也要落：判据是 `!== undefined`，不是真值）");
  }
  // `undefined` 逐字等于「没给」：夹具不补默认值。
  const none = withSeed({ [KEY]: undefined, provider: createFakeProvider(DONE) });
  assert.equal(Object.prototype.hasOwnProperty.call(none, KEY), false, "没给就是没给");
  assert.equal(none.config?.run?.[KEY], undefined, "不许凭空造一个 `config.run.completion`");
});
