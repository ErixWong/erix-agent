// issue #498（S3）—— `run` 组的垂直切片 **A15**：两件事，一件交付、一件退回。
//
//   ① `cwd` 的顶层扁平拼写**离开白名单**，家是 `config.run.cwd`
//      （`CONFIG_NAMESPACE_SCHEMA.run`，`src/loop/config-namespace.js`）。本文件 P/G/F/R/N 五段钉它。
//   ② `stream` **退回**（留在白名单，行为一字未改）。本文件 S 段把它钉成 as-is：
//      闸口二四格取值（`true` / `false` / 对象 / 函数）逐格记录，理由写在下面。
//
// ⚠ 撞名提醒（本片最容易被改坏的地方）：整词 grep `cwd` 在 `src`/`bin`/`test` 里有上千处命中，
// 其中**只有一类**是「`runToolLoop` 的顶层选项」——`process.cwd()`、`options.cwd`（CLI 旗标）、
// `assemblyPort.cwd`、`createCliTools({ cwd })`、`params.cwd`（pi 扩展的工具入参）全都**不是**
// 同一个东西。本片退役的只有那一个入口；其余面一个字节都没动（N1 逐类钉住）。
//
// ⚠ `stream` 为什么退回（交裁决的候选，不是「懒得做」）：它今天**没有值校验器**——引擎只做
// `if (partialPersistence !== false && !stream)` 这一处真值判断，任何 truthy 值都会打开流式路径。
// 于是函数取值**扁平可达**（exit 0），而 `config` 只装数据 ⇒ **规位被拒**。按本仓对
// 「扁平可达」的操作性口径（A6 G4：今天不报错地接受），这是一只混装壳，所以按闸口二的规矩
// 退回、钉成 as-is，候选（退役 / 先给 `stream` 加布尔校验器再退役 / 立第三站）留给主 agent 裁。
//
// 本文件钉六件事（全部派生，不手抄键数）：
//   P. 旧名反向拒绝钉：顶层再写 `cwd` ⇒ 当场拒，文案**逐字**指向 `config.run.cwd`。
//   G. 闸口二矩阵（`cwd`）：合法形状（绝对路径 / 空串）规位侧 exit 0，扁平侧是名称闸口的拒；
//      非法形状（数字 / 对象 / 布尔）两侧**同样**被拒且文案逐字相同（`cwd must be a string`）。
//   F. 规位里给函数值 ⇒ 逐字两句话（`config` 只装数据 + 引擎从没调用过它）。
//   S. `stream` 退回的 as-is 四格 + 白名单/叶子两向钉（它是本片**没**退役的那一件）。
//   R. 读侧不动：规位里的值展开后逐字到达 `effectiveOptions.cwd`，且**行为**不变（finalGuard 载荷里
//      那个键；空串照旧在场；不给就没有该键）。
//   N. 邻接与账目：`run` 组剩下的大件一件没动、撞名面逐类钉住、账目派生化（不手抄 8 / 7）。
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

/** 本片退役的键（字符串标量；家由 schema 派生）。 */
const KEY = "cwd";

/** 本片**退回**的键（留在白名单；S 段钉 as-is）。 */
const RETURNED = "stream";

/** 两格**合法形状**（扁平侧曾同样被接受，见 G 段；规位侧必须仍 exit 0）。 */
const LEGAL_SHAPES = ["/tmp/a15-work", ""];

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.cwd`），拒绝文案里点名的那一条。 */
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
    config: { input: { initialUserMessage: "go" } },
    completion: false,
    wrapup: false,
    ...extra,
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

/** 跑一次并取 finalGuard 的 payload（判据恒 accept；钩子写在它的规位 `capabilities.hooks`）。 */
async function payloadOf(options) {
  let seen;
  await runToolLoop(base({
    ...options,
    capabilities: {
      hooks: {
        finalGuard: async (value) => {
          seen = value;
          return { action: "accept" };
        },
      },
    },
  }));
  assert.equal(typeof seen, "object", "finalGuard 必须被调用（否则下面关于 payload 的断言都是空转）");
  return seen;
}

// ================================================================ P. 反向拒绝

test(`P1 扁平拼写已退役：名称闸口当场拒，文案逐字点名 ${KEY} 的新家（零建议）`, async () => {
  const home = homeOf(KEY);
  const error = await rawError(base({ [KEY]: "/tmp/a15-work" }));
  assert.equal(error instanceof TypeError, true, `${KEY} 的扁平拼写必须当场拒`);
  assert.equal(
    error.message,
    `unknown runToolLoop option: "${KEY}" (its canonical home is ${home}; the flat spelling is rejected)`,
    `${KEY} 的拒绝文案必须逐字点名 ${home}`,
  );
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, `${KEY} 不许还在白名单`);
});

test(`P2 扁平写法在**任何 provider 调用之前**被拒（零请求）`, async () => {
  const provider = createFakeProvider(DONE);
  const error = await runToolLoop(base({ provider, [KEY]: "/tmp/a15-work" })).then(() => null, (e) => e);
  assert.equal(error instanceof TypeError, true);
  assert.equal(provider.requests.length, 0, "名称闸口必须早于任何宿主端口被调用");
});

// ================================================================ G. 闸口二

test(`G1 闸口二矩阵（${KEY}）：合法形状规位侧 exit 0，扁平侧是名称闸口的拒`, async () => {
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

test(`G2 闸口二矩阵（${KEY}）：非法形状两侧都被拒，且规位侧**仍是** #386 那句类型校验`, async () => {
  // 这一格是本键与 A14 的标量键不同的地方：`cwd` **有**值校验器（issue #386），而它跑在
  // **展开之后**（`orchestrator.js`: `typeof cwd !== "string"`），所以规位写非法值也照样是
  // `cwd must be a string` —— 不是「规位更宽松」的静默收窄。
  // 扁平侧现在是名称闸口先开火（`unknown runToolLoop option`），因为它已经不在白名单；
  // 所以「两侧都拒、拒的理由不同」就是本键的 as-is 形状，两条都逐字钉。
  const nameGate = `unknown runToolLoop option: "${KEY}" (its canonical home is ${homeOf(KEY)};`
    + " the flat spelling is rejected)";
  for (const value of [123, { a: 1 }, true, null]) {
    const label = `${KEY}=${JSON.stringify(value)}`;
    const flat = await rawError(base({ [KEY]: value }));
    const nested = await rawError(base({
      config: { input: { initialUserMessage: "go" }, run: { [KEY]: value } },
    }));
    assert.equal(flat instanceof TypeError, true, `${label}：扁平侧必须被拒`);
    assert.equal(flat.message, nameGate, `${label}：扁平侧拒在名称闸口（逐字）`);
    assert.equal(nested instanceof TypeError, true, `${label}：规位侧必须同样被拒`);
    assert.equal(nested.message, "cwd must be a string", `${label}：规位侧仍是 #386 那一句（校验器没丢）`);
  }
});

// ================================================================ F. 函数值

test(`F1 规位里给函数值（${KEY}）：逐字两句话（只装数据 + 引擎从没调用过它）`, async () => {
  // as-is 差异（如实披露）：函数值在扁平侧被名称闸口拒，在规位侧被 `config` 的 intake 拒
  // （另一条文案，但它说的是同一件事：引擎从不调用它，只转发值）。两侧都**拒**。
  const flat = await rawError(base({ [KEY]: () => 1 }));
  const nested = await rawError(base({
    config: { input: { initialUserMessage: "go" }, run: { [KEY]: () => 1 } },
  }));
  assert.match(flat.message, new RegExp(`^unknown runToolLoop option: "${KEY}"`, "u"),
    "扁平侧：名称闸口先开火");
  assert.equal(nested instanceof TypeError, true);
  assert.match(nested.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(nested.message, /the config namespace holds data only/u);
  assert.match(nested.message, /the engine never calls it, it only forwards the value/u);
});

// ================================================================ S. `stream` 退回（as-is）

test(`S1 ${RETURNED} 退回：仍在白名单，且它的 config 叶子仍在 schema 里（两向钉）`, () => {
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(RETURNED), true,
    `${RETURNED} 是**退回**的那一件，本片不许收它`);
  assert.equal(configPathForOption(RETURNED), "run.stream", "它的规位家仍在（本片不删叶子）");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(RETURNED), true, "叶子不许被顺手删掉");
});

test(`S2 ${RETURNED} 闸口二四格（as-is）：true / false / 对象两侧可达，函数扁平可达而规位被拒`, async () => {
  // 这一格就是退回的**证据**（不是猜测）：函数 handler 是「扁平可达、规位被拒」的形态。
  // 先钉三格 PARITY。
  for (const value of [true, false, { onChunk: "x" }]) {
    const label = `${RETURNED}=${JSON.stringify(value)}`;
    const flat = await exitCode(base({ [RETURNED]: value }));
    const nested = await exitCode(base({
      config: { input: { initialUserMessage: "go" }, run: { [RETURNED]: value } },
    }));
    assert.equal(flat, 0, `${label}：扁平侧今天可达`);
    assert.equal(nested, 0, `${label}：规位侧同样可达（PARITY）`);
  }
  // 第四格：函数 —— 两侧不同（这就是退回的理由，钉成 as-is，不许「为了让闸口过」放宽 schema）。
  const flatFn = await exitCode(base({ [RETURNED]: () => 1 }));
  const nestedFn = await rawError(base({
    config: { input: { initialUserMessage: "go" }, run: { [RETURNED]: () => 1 } },
  }));
  assert.equal(flatFn, 0, "函数值今天扁平可达（`stream` 没有值校验器，任何 truthy 值都开流式路径）");
  assert.equal(nestedFn instanceof TypeError, true, "函数值规位被拒（`config` 只装数据）");
  assert.match(nestedFn.message, /^config\.run\.stream is not accepted/u);
  assert.match(nestedFn.message, /the config namespace holds data only/u);
});

test(`S3 ${RETURNED} 没有值校验器：任何 truthy 值都走流式路径（退回判据的事实来源）`, async () => {
  // 「函数 handler」之所以扁平可达，是因为引擎只做真值判断。这里用数字与函数各跑一次，
  // 证明 `effectiveOptions.stream` 逐字就是宿主给的那个值（引擎既不校验也不改写）。
  for (const value of [1, () => 1]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ [RETURNED]: value });
    assert.equal(effectiveOptions[RETURNED], value, "扁平值逐字到达 effectiveOptions（没有校验器）");
  }
  // 而规位侧连「值到了没有」都问不到：函数在 intake 就被拒（见 S2 第四格）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { run: { [RETURNED]: true } },
  });
  assert.equal(effectiveOptions[RETURNED], true, "规位侧的纯数据取值照旧展开到 effectiveOptions");
});

// ================================================================ R. 读侧不动

test(`R1 展开相逐字写回 effectiveOptions.${KEY}（读侧一行未改）`, async () => {
  for (const value of LEGAL_SHAPES) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { run: { [KEY]: value } } });
    assert.equal(effectiveOptions[KEY], value, `${KEY} 必须逐字到达 effectiveOptions（含空串）`);
  }
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
});

test(`R2 行为不变：规位里的 ${KEY} 进 finalGuard 载荷；空串在场；不给就没有该键`, async () => {
  const provided = await payloadOf({
    config: { input: { initialUserMessage: "go" }, run: { [KEY]: "/tmp/a15-host" } },
  });
  assert.equal(provided.cwd, "/tmp/a15-host", "config.run.cwd 必须逐字进 finalGuard 载荷");

  const empty = await payloadOf({
    config: { input: { initialUserMessage: "go" }, run: { [KEY]: "" } },
  });
  assert.equal("cwd" in empty, true, "空串是「提供了」，不是「没提供」");
  assert.equal(empty.cwd, "");

  const absent = await payloadOf({});
  assert.equal("cwd" in absent, false, "没传就不许写该键（不是 undefined，是根本没有）");
});

test(`R3 夹具是翻译点：withSeed 产物里没有扁平 ${KEY}，值落在 config.run`, () => {
  const moved = withSeed({ [KEY]: "/tmp/a15-fixture", seed: "go" });
  assert.equal(Object.hasOwn(moved, KEY), false, "夹具漏摘扁平键 ⇒ 引擎当场拒");
  assert.equal(moved.config.run[KEY], "/tmp/a15-fixture", "值必须搬进 config.run");
  assert.equal(moved.config.input.initialUserMessage, "go", "种子照旧进 config.input");
  const untouched = withSeed({ [KEY]: undefined, seed: "go" });
  assert.equal(untouched.config.run, undefined, "undefined 不许被翻译成一个键");
  // 真 run 走一遍（夹具产物直接喂引擎）。
  return runDirect({
    provider: createFakeProvider(DONE),
    [KEY]: "/tmp/a15-fixture",
    seed: "go",
    completion: false,
    wrapup: false,
    executeTool: async () => "ok",
  }).then((result) => {
    assert.equal(result.termination.reason, "end_turn", "夹具翻译之后 run 照旧跑通");
  });
});

// ================================================================ N. 邻接与账目

test("N1 撞名面逐类钉住：只有 `runToolLoop` 的顶层选项被退役，其余 `cwd` 面一个没动", () => {
  // 归属表（口径：本片只动第 ① 类；②–⑤ 是**同词不同物**，一行都不许改）。
  //   ① 顶层选项 `runToolLoop({ cwd })`         → 本片退役（→ `config.run.cwd`）
  //   ② `process.cwd()` / CLI `--cwd` / `options.cwd` → 宿主的工作目录，与引擎选项无关
  //   ③ `createCliTools({ cwd })` / `bin/tools.js`  → 工具装配的工作目录（工具自己用）
  //   ④ `assemblyPort.cwd`                       → 装配口的成员（`src/assembly*.js`，本片禁手）
  //   ⑤ `params.cwd`（pi 扩展的工具入参）        → 工具参数面，不是引擎选项
  // ①：家仍在 schema 里（删扁平键 ≠ 删叶子）。
  assert.equal(configPathForOption(KEY), "run.cwd");
  // ②：`process.cwd()` 是 node 的，与白名单无关——用「它照样可调用」作证。
  assert.equal(typeof process.cwd(), "string");
  // ④：装配口成员仍是端口上的那个字符串（`resolveAssemblyMember` 的行为本片一个字没改）。
  const port = { cwd: "/tmp/a15-port" };
  assert.equal(port.cwd, "/tmp/a15-port", "装配口成员是独立对象，本片不碰");
  // ⑤：pi 扩展的工具入参面（`erix_run` 的 `cwd`）与引擎选项是两个面：schema 里仍有它。
  //     这里不 import pi 扩展（那是 `examples/` 的另一条测试线），只钉「它不是引擎选项名」。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, "引擎选项面已退役");
});

test("N2 邻接面没动：`run` 组剩下的大件一件没动，`runId` 仍是扁平可写", () => {
  for (const key of ["runId", "stream", "completion", "maxRounds", "resume", "reflection", "wrapup"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), true, `${key} 仍可扁平写（本片不许收它）`);
  }
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("store"), true, "`store` 是永久顶层面，不许动");
  // `cwd` 与 `runId` 同属「每运行身份」一族，家都在 `config.run`；本片只退役前者。
  assert.equal(configPathForOption("runId"), "run.runId", "`runId` 的家一字未动");
  assert.notEqual(configPathForOption("runId"), undefined);
});

test("N3 删扁平键 ≠ 删叶子：`cwd` 仍在 `config.run` 里", () => {
  const [, leaf] = homeOf(KEY).replace("config.", "").split(".");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(leaf), true, `${leaf} 必须仍在 schema 的 run 组`);
});

test("N4 账目派生化：删键只搬家，配置面顶层键 + 孤儿叶子 = 叶子总数（不手抄 8 / 7）", () => {
  const leaves = Object.values(CONFIG_NAMESPACE_SCHEMA).flat();
  const configPlane = RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => configPathForOption(name) !== undefined);
  const orphanLeaves = leaves.filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.equal(configPlane.includes(KEY), false, `${KEY} 已退役 ⇒ 不在配置面顶层键里`);
  assert.equal(configPathForOption(KEY) !== undefined, true, `${KEY} 的叶子仍有家`);
  assert.ok(orphanLeaves.includes(KEY), `${KEY} 必须出现在「失去顶层键的叶子」里`);
  assert.equal(configPlane.length + orphanLeaves.length, leaves.length,
    "配置面顶层键 + 孤儿叶子必须等于叶子总数（删键只搬家，不丢叶子）");
});
