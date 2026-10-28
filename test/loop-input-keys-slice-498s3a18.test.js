// issue #498（S3）—— `input` 组的垂直切片 **A18**：`wrapup` 按裁决退役，`input` 组随之收口。
//
// 裁决（#495 `…8051385`，原文不在此复述）：**退役，接受「函数被拒」这条收窄**。
// 实证分界（三条，都是代码事实而不是口味）：
//   ① `src/loop/orchestrator.js` 里只有 `const wrapupEnabled = wrapup !== false` —— 真值判断；
//   ② 这个键的 JSDoc 声明本来就是 `wrapup?: boolean`；
//   ③ 全树零调用形态：除 `src/reflection/wrapup.js` 的两个入口函数（`normalizeWrapupWithLlm` /
//      `tryParseWrapupJson`，那是**另一个东西**，本片只改调用处拼写）之外，没有任何地方把
//      `effectiveOptions.wrapup` 当函数调。
// ⇒ 函数值过去只是**恰好 truthy**，从不被执行。**与 `reflection`（#530）不同族**——那个的成员
// 真被调用，必须分家，别照它做。所以本片**不放宽 schema**，也**不**加布尔校验器。
//
// `input` 组的历史：A6 交了 `system`、A17(#528) 退回 `wrapup`、#527 拆了从未发布的
// `config.input.tools` 叶子。`wrapup` 是 `input` 组**最后一个扁平孪生**，所以本片做完，
// 这一组就收口了——N1 把这句话写成**派生**判据（不手数叶子、不断言「组里现在有几个叶子」）。
//
// 本文件钉六件事（账目全部派生，不手抄条数）：
//   P. 反向拒绝钉：顶层再写 `wrapup` ⇒ 当场拒，文案**逐字**指向 `config.input.wrapup`，
//      零建议，且拒在任何宿主端口被调用之前（零请求）。
//   G. 闸口二（数据面）：`false` / `true` / 对象 / 字符串在规位侧**全 ACCEPT**、扁平侧**全拒**。
//      这一格里不存在「两侧取值差异」——`wrapup` 没有值校验器，退役不放宽也不收紧取值面。
//   F. 函数值（as-is 差异钉，改而不删）：**扁平侧过去被接受（exit 0，因为它只是恰好 truthy）、
//      规位侧一直被拒**；退役后**扁平当场拒 + 规位仍拒函数**。两个方向都钉，逐字文案。
//   R. 读侧不动：展开相逐字写回 `effectiveOptions.wrapup`；真 run 里 `config.input.wrapup: false`
//      仍关掉整条收尾协议、不给（缺省 true）仍追加。
//   N. `input` 组收口（**派生**）：白名单里不存在任何 `configPathForOption` 落在 `input.*` 的
//      扁平名；叶子仍在 schema 里；四向闭合与「配置面顶层键 + 孤儿叶子 = 叶子总数」照旧成立。
//   S. as-is 形状钉：`config` / `config.input` 的形状拒绝格一个字没动；夹具的翻译点仍然只有一处。
//
// ⚠ 撞名提醒：整词 grep `wrapup` 会捞到 `config.run.reflection.wrapupNormalize`（反思收尾的
// **嵌套容器**）与 `src/reflection/wrapup.js` 的两个函数——它们都**不是**这个顶层选项。
//
// 零真实 LLM（fake provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_NAMESPACE_SCHEMA,
  CONFIG_SURFACE_OPTION_NAMES,
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

/** 本片退役的键。家由 schema 派生（`configPathForOption`），不手抄。 */
const KEY = "wrapup";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`input.wrapup`），拒绝文案里点名的那一条。 */
function homeOf(key) {
  const path = configPathForOption(key);
  assert.equal(typeof path, "string", `${key} 失去顶层键之后必须仍有 config 家`);
  return `config.${path}`;
}

/**
 * 最小合法 run：一次 end_turn 就结束。
 *
 * **不经过** `runDirect` 夹具——夹具会把扁平拼写翻译进规位（那正是它存在的理由），于是
 * 「扁平拼写被拒」这一格永远测不到。本文件要测的正是引擎拼写，所以直连 `runToolLoop`。
 */
function base(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    ...extra,
    // 种子与收尾开关同住 `config.input`；容器**合并**（调用方自带 `config` 时两者都要留下）。
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", ...extra.config?.input },
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
  assert.equal(home, "config.input.wrapup", "家必须仍是 config.input.wrapup（删扁平键 ≠ 删叶子）");
  const error = await rawError(base({ [KEY]: false }));
  assert.equal(error instanceof TypeError, true, `${KEY} 的扁平拼写必须当场拒`);
  assert.equal(
    error.message,
    `unknown runToolLoop option: "${KEY}" (its canonical home is ${home}; the flat spelling is rejected)`,
    `${KEY} 的拒绝文案必须逐字点名 ${home}`,
  );
  assert.equal(error.message.includes("did you mean"), false, "退役键不许再给「你是不是想写」建议");
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, `${KEY} 不许还在白名单`);
});

test(`P2 扁平写法在**任何 provider 调用之前**被拒（零请求）`, async () => {
  const provider = createFakeProvider(DONE);
  const error = await runToolLoop(base({ provider, [KEY]: false })).then(() => null, (e) => e);
  assert.equal(error instanceof TypeError, true);
  assert.equal(provider.requests.length, 0, "名称闸口必须早于任何宿主端口被调用");
});

// ================================================================ G. 闸口二（数据面）

test(`G1 闸口二矩阵（${KEY}）：数据取值规位侧全 ACCEPT，扁平侧全被名称闸口拒`, async () => {
  // ⚠ 这一格里**没有**「两侧取值差异」：数据取值在规位侧一个都不被拒（没有值校验器），
  // 差异只在「拼写」这一维上。别把 as-is 时代那句「两侧都可达」照抄成「两侧都拒」。
  const shapes = [false, true, { enabled: true }, "yes"];
  const nameGate = `unknown runToolLoop option: "${KEY}" (its canonical home is ${homeOf(KEY)};`
    + " the flat spelling is rejected)";
  for (const value of shapes) {
    const label = `${KEY}=${JSON.stringify(value)}`;
    const nested = await exitCode(base({ config: { input: { [KEY]: value } } }));
    assert.equal(nested, 0, `${label}：规位必须可达（exit 0，取值面没被收紧）`);
    const flat = await rawError(base({ [KEY]: value }));
    assert.equal(flat instanceof TypeError, true, `${label}：扁平拼写已退役 ⇒ 必须当场拒`);
    assert.equal(flat.message, nameGate, `${label}：扁平侧拒在名称闸口（逐字）`);
  }
});

test(`G2 取值逐字到达 effectiveOptions（引擎既不校验也不改写）`, async () => {
  for (const value of [false, true, { enabled: true }, "yes"]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: { input: { [KEY]: value } },
    });
    assert.deepEqual(effectiveOptions[KEY], value, `${JSON.stringify(value)} 必须逐字写回`);
  }
});

// ================================================================ F. 函数值（裁决接受的收窄 + as-is 差异）

test(`F1 函数值：扁平侧过去被接受、规位侧一直被拒；退役后扁平当场拒 + 规位仍拒函数`, async () => {
  // as-is 的那一半（**改而不删**）：规位侧拒函数的文案与理由一个字都没动。
  const nested = await rawError(base({ config: { input: { [KEY]: () => 1 } } }));
  assert.equal(nested instanceof TypeError, true, "规位侧：`config` 只装数据（这条一个字没动）");
  assert.match(nested.message, new RegExp(`^config\\.input\\.${KEY} is not accepted`, "u"));
  assert.match(nested.message, /the config namespace holds data only/u);
  assert.match(nested.message, /the engine never calls it, it only forwards the value/u,
    "「引擎从不调用它」是裁决的正当性说明：函数在这个位置从来不是行为");

  // 退役带来的那一半（这就是「收窄」的可执行定义）：扁平侧从 exit 0 变成名称闸口的拒。
  const flat = await rawError(base({ [KEY]: () => 1 }));
  assert.equal(flat instanceof TypeError, true,
    "扁平侧：退役前它是 exit 0（函数只是恰好 truthy），退役后拒在名称闸口");
  assert.match(flat.message, new RegExp(`^unknown runToolLoop option: "${KEY}"`, "u"));
  assert.equal(flat.message.includes("is a function"), false,
    "扁平侧的拒绝理由**不是**「函数不许」，而是「这个拼写没了」——别把两条理由混成一条");

  // 反向证：把键塞回白名单那一侧不成立——这里用「同一份函数值，两个拼写两种理由」钉住差异
  // 确实只来自拼写这一维，而不是被函数形状顺手放大。
  assert.notEqual(flat.message, nested.message, "两条文案必须是两条，不许合并成一条");
});

// ================================================================ R. 读侧不动

test(`R1 展开相逐字写回 effectiveOptions.${KEY}（读侧一行未改）`, async () => {
  for (const value of [false, true]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { input: { [KEY]: value } } });
    assert.equal(effectiveOptions[KEY], value, `${KEY} 必须逐字到达 effectiveOptions`);
  }
});

test("R2 真 run：规位 false 仍关掉整条收尾协议，不给（缺省 true）仍追加", async () => {
  // 判据取系统提示：收尾协议是**追加在系统提示尾部**的那段 JSON 信封说明。
  const off = createFakeProvider(DONE);
  await runToolLoop(base({
    provider: off,
    config: { input: { system: "SYS", cacheStablePrefix: false, [KEY]: false } },
  }));
  assert.equal(off.requests[0].system, "SYS", "config.input.wrapup:false ⇒ 系统提示不被追加收尾协议");

  const on = createFakeProvider(DONE);
  await runToolLoop(base({
    provider: on,
    config: { input: { system: "SYS", cacheStablePrefix: false } },
  }));
  assert.match(on.requests[0].system, /任务完成或需要给出结论时/u, "缺省 wrapup:true 仍追加收尾协议");
});

// ================================================================ N. `input` 组收口（派生）

test("N1 `input` 组已收口（**派生**判据）：白名单里不存在任何落在 `input.*` 的扁平名", () => {
  // 判据不是「组里有几个叶子」（那会被下一次改动打脸），而是：**白名单里每一个名字**去问
  // `configPathForOption`，没有一条答出 `input.` 开头的路径。组里有几个叶子、叫什么都无所谓。
  const flatTwinsInInput = RUN_TOOL_LOOP_OPTION_NAMES
    .map((name) => [name, configPathForOption(name)])
    .filter(([, path]) => typeof path === "string" && path.startsWith("input."));
  assert.deepEqual(
    flatTwinsInInput,
    [],
    "`input` 组收口：不该再有扁平孪生（A6 交 `system`、A2b 交 `initialUserMessage`、"
      + "#527 拆 `tools`、A18 退役 `wrapup`）",
  );
  // 同一条判据的另外两种写法（同源、不同角度，防止某一侧的实现被换成硬编码）：
  const inputLeavesAsOptionNames = CONFIG_NAMESPACE_SCHEMA.input
    .map((leaf) => (leaf === "messages" ? "initialMessages" : leaf));
  assert.deepEqual(
    inputLeavesAsOptionNames.filter((name) => RUN_TOOL_LOOP_OPTION_NAMES.includes(name)),
    [],
    "`input` 组叶子映射出的顶层名一个都不许还在白名单里",
  );
  // 叶子本身一个都没被顺手删掉（删扁平键 ≠ 删叶子）：`wrapup` 仍在，且家仍是 `input.wrapup`。
  assert.equal(CONFIG_NAMESPACE_SCHEMA.input.includes(KEY), true, "`wrapup` 叶子必须留在 schema 里");
  assert.equal(configPathForOption(KEY), "input.wrapup", "规位路径逐字为 input.wrapup");
});

test("N2 账目派生：四向闭合 + 「配置面顶层键 + 孤儿叶子 = 叶子总数」", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向之和逐键等于白名单（不靠条数自证）");
  const leaves = Object.values(CONFIG_NAMESPACE_SCHEMA).flat();
  const orphanLeaves = leaves.filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.equal(configPlane.includes(KEY), false, `${KEY} 已退役 ⇒ 不在配置面顶层键里`);
  assert.ok(orphanLeaves.includes(KEY), `${KEY} 必须出现在「失去顶层键的叶子」里`);
  assert.equal(configPlane.length + orphanLeaves.length, leaves.length,
    "配置面顶层键 + 孤儿叶子必须等于叶子总数（删键只搬家，不丢叶子）");
  assert.equal(configPlane.length + orphanLeaves.length, CONFIG_SURFACE_OPTION_NAMES.length,
    "配置面名单本身没变（本片只动白名单，不动 schema）");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
});

test("N3 撞名面逐类钉住：只有 `runToolLoop` 的顶层选项被退役", () => {
  // 归属表（本片只动第 ① 类）：
  //   ① 顶层选项 `runToolLoop({ wrapup })`              → 本片退役（→ `config.input.wrapup`）
  //   ② `config.run.reflection.wrapupNormalize`          → 反思收尾的嵌套容器（`run.reflection` 那一带）
  //   ③ `src/reflection/wrapup.js` 的两个入口函数        → 归一化实现，本片只改调用处拼写
  //   ④ `ERIX_NO_WRAPUP_INSTRUCTION` 环境变量            → 宿主面开关，与引擎选项无关
  assert.equal(CONFIG_NAMESPACE_SCHEMA.input.includes(KEY), true, "①：叶子不许被顺手删掉");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes("reflection"), true,
    "②：`reflection` 仍是 config.run 的叶子（嵌套容器的壳）");
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("wrapupNormalize"), false,
    "②：`wrapupNormalize` 从来不是引擎选项");
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("normalizeWrapupWithLlm"), false,
    "③：入口函数名从来不是引擎选项");
});

// ================================================================ S. as-is 形状钉

test("S1 as-is：`config` / `config.input` 的形状拒绝格一个字没动", async () => {
  // 这些格子测的是「config 必须是对象」「分组必须是对象」，与本片删的键无关——逐字钉住，
  // 防止有人把 `input` 组收口顺手写成「`config.input` 也一起改形状」。
  const cases = [
    [{ config: null }, /config must be an object \(or omitted\)/u],
    [{ config: [] }, /config must be an object \(or omitted\)/u],
    [{ config: "nested" }, /config must be an object \(or omitted\)/u],
    [{ config: { input: "nested" } }, /config\.input must be an object/u],
    [{ config: { input: null } }, /config\.input must be an object/u],
  ];
  for (const [options, pattern] of cases) {
    const error = await rawError({ provider: createFakeProvider(DONE), executeTool: async () => "ok", ...options });
    assert.equal(error instanceof TypeError, true, JSON.stringify(options));
    assert.match(error.message, pattern);
  }
});

test("S2 as-is：夹具仍是**唯一**翻译点，产物里没有扁平键", () => {
  const moved = withSeed({ [KEY]: false, seed: "go" });
  assert.equal(Object.hasOwn(moved, KEY), false, "夹具漏摘扁平键 ⇒ 引擎当场拒");
  assert.equal(moved.config.input[KEY], false, "值必须搬进 config.input");
  assert.equal(moved.config.input.initialUserMessage, "go", "种子照旧进 config.input");
  // 规位赢扁平（与引擎展开优先级同向）：两者同时在场时保留规位那份。
  const both = withSeed({ [KEY]: false, config: { input: { [KEY]: true } } });
  assert.equal(both.config.input[KEY], true, "规位必须赢扁平");
  assert.equal(Object.hasOwn(both, KEY), false, "扁平键照旧被摘掉");
  // `undefined` 逐字等于「没给」：不许被翻译成一个键。
  const untouched = withSeed({ [KEY]: undefined, seed: "go" });
  assert.equal(Object.hasOwn(untouched.config.input, KEY), false, "undefined 不许被翻译成一个键");
});
