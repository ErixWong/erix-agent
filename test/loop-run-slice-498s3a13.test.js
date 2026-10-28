// issue #498（S3）—— `run` 组的**垂直切片 A13**：把上一批「刻意压住」的三件一起退掉，
// `stallDetection` / `outputHygiene` / `persistence` 的顶层扁平拼写全部离开白名单，
// 家是 `config.run.*`（`CONFIG_NAMESPACE_SCHEMA.run`，`src/loop/config-namespace.js`）。
//
// 为什么这三件能一起做（A12 留下的账）：四件同删牵动 **176 格** ≫ 本仓的夹具级阈值，所以 A12
// 先落**单点翻译夹具**（`test/helpers/run-direct.js` 的 `withRunFamily`，与 #521 的种子夹具同一条
// 纪律），把同一次删除压到 **31 格**，然后只交了 `partialPersistence`。夹具已在树上，本片吃这个
// 红利：**先量后写**，本片实测单删红格（夹具前 → 夹具后）：`stallDetection` 120 → 32、
// `outputHygiene` 29 → 4、`persistence` 待测；三件一起删是 **38**（重叠吃掉一部分），
// 剩下的 38 格逐格是**手写点**（直连 `runToolLoop` 的调用方、白名单镜像、配置面等价样本、
// 契约载荷演示、provenance 示例、两个观察脚本）——本片把它们全部迁完，不靠再扩大夹具。
//
// 闸口二（A12 已对这三件跑过全表 PARITY，本片按纪律**每键至少抽查 2 格合法形状**，
// 扁平 vs 规位各一侧，退出码见 G 段）：结论是**纯数据壳、无回调** ⇒ 无需退回。
//
// 本文件钉五件事（全部派生，不手抄键数）：
//
//   P. 旧名反向拒绝钉：顶层再写这三个键 ⇒ 当场拒，文案**逐字**指向 `config.run.<key>`。
//   G. 闸口二矩阵：每键两个合法形状，规位侧必须 exit 0（扁平侧已退役 ⇒ 名称闸口的拒）。
//   F. 规位里给函数值 ⇒ 逐字两句话（`config` 只装数据 + 引擎从没调用过它）。
//   R. 读侧不动：规位里的值展开后逐字到达 `effectiveOptions.<key>`。
//   N. 邻接：`store`（端口）与 `maxRounds` 都**没动**；`persistence`（模式）与
//      `partialPersistence`（间隔快照）同族不同物，后者由 A12 退、本片**不许把它改回去**；
//      `outputHygiene` 与 A11 退的 `writeToolNames` / `writeToolPathKeys` 同族不同物；
//      `stallDetection` 与 `maxRounds` / 已退役的 `deadlineMs` 不同物。
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
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

/** 本片退役的三个键（每键一格 P/G/F/R；键集是**声明**，家由 schema 派生）。 */
const KEYS = ["stallDetection", "outputHygiene"];

/** 每个键的两个**合法形状**（扁平侧曾同样被接受，见 G 段；规位侧必须仍 exit 0）。 */
const LEGAL_SHAPES = {
  stallDetection: [false, { window: 4, mode: "consecutive" }],
  outputHygiene: [false, { limit: 4096 }],
};

/**
 * 需要**转写存储**才可达的键：`outputHygiene` 的归档落在 round record 里，没有 store 时引擎当场拒
 * （`outputHygiene requires a transcript store`）。两侧给**同一个** store，公平性才成立。
 */
const NEEDS_STORE = new Set(["outputHygiene"]);

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.stallDetection`），拒绝文案里点名的那一条。 */
function homeOf(key) {
  const path = configPathForOption(key);
  assert.equal(typeof path, "string", `${key} 失去顶层键之后必须仍有 config 家`);
  return `config.${path}`;
}

/**
 * 最小合法 run：一次 end_turn 就结束。
 *
 * ⚠ **不经过 `runDirect` 夹具**：夹具会把这三个扁平拼写翻译进规位（那正是它存在的理由），
 * 于是「扁平拼写被拒」这一格永远测不到。本文件要测的正是引擎拼写，所以直连 `runToolLoop`，
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

// ================================================================ P. 反向拒绝

for (const key of KEYS) {
  test(`P1 扁平拼写已退役：名称闸口当场拒，文案逐字点名 ${key} 的新家（零建议）`, async () => {
    const home = homeOf(key);
    const error = await rawError(base({ [key]: false }));
    assert.equal(error instanceof TypeError, true, `${key} 的扁平拼写必须当场拒`);
    assert.equal(
      error.message,
      `unknown runToolLoop option: "${key}" (its canonical home is ${home}; the flat spelling is rejected)`,
      `${key} 的拒绝文案必须逐字点名 ${home}`,
    );
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), false, `${key} 不许还在白名单`);
  });
}

// ================================================================ G. 闸口二

for (const key of KEYS) {
  test(`G1 闸口二矩阵（${key}）：两个合法形状规位侧 exit 0，扁平侧是名称闸口的拒`, async () => {
    const shapes = LEGAL_SHAPES[key];
    assert.ok(Array.isArray(shapes) && shapes.length >= 2, `${key} 至少要抽查 2 格合法形状`);
    for (const value of shapes) {
      const label = `${key}=${JSON.stringify(value)}`;
      const store = NEEDS_STORE.has(key) ? { store: createMemoryTranscriptStore() } : {};
      const nested = await exitCode(base({
        ...store,
        config: { input: { initialUserMessage: "go" }, run: { [key]: value } },
      }));
      const flat = await exitCode(base({ ...store, [key]: value }));
      assert.equal(nested, 0, `${label}：规位必须可达（exit 0）`);
      assert.equal(flat, 1, `${label}：扁平拼写已退役 ⇒ 必须当场拒（不是静默忽略）`);
    }
  });
}

// ================================================================ F. 函数值

for (const key of KEYS) {
  test(`F1 规位里给函数值（${key}）：逐字两句话（只装数据 + 引擎从没调用过它）`, async () => {
    const error = await rawError(base({
      config: { input: { initialUserMessage: "go" }, run: { [key]: () => 1 } },
    }));
    assert.equal(error instanceof TypeError, true);
    assert.match(error.message, new RegExp(`^config\\.run\\.${key} is not accepted`, "u"));
    assert.match(error.message, /the config namespace holds data only/u);
    assert.match(error.message, /the engine never calls it, it only forwards the value/u);
  });
}

// ================================================================ R. 读侧不动

for (const key of KEYS) {
  test(`R1 展开相逐字写回 effectiveOptions.${key}（读侧一行未改）`, async () => {
    const value = LEGAL_SHAPES[key][1];
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { run: { [key]: value } } });
    assert.deepEqual(effectiveOptions[key], value, `${key} 必须逐字到达 effectiveOptions`);
    assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
  });
}

// ================================================================ N. 邻接与账目

test("N1 只点一站：这三件的值是纯数据，报错里不出现 `capabilities.` 那一站", async () => {
  for (const key of KEYS) {
    const error = await rawError(base({ [key]: false }));
    assert.equal(error.message.includes("capabilities."), false, `${key} 的拒绝文案不许提到能力站`);
  }
});

test("N2 邻接面没动：`store` 端口、`maxRounds`、A11 的写工具集、A12 的 partialPersistence", () => {
  // 第三站的 `store` 是端口，`persistence` 是模式 —— 本片只退后者的扁平写法。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("store"), true, "`store` 是永久顶层面，不许动");
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("maxRounds"), true, "`maxRounds` 仍在白名单");
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("partialPersistence"), false, "A12 的退役不许改回去");
  // A11 退的四件同样不许回潮（同族不同物：名字里都有 write/policy，但都不是本片这三件）。
  for (const key of ["writeToolNames", "writeToolPathKeys", "replayPolicy", "invalidArguments"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), false, `${key} 由 A11 退役，不许回潮`);
  }
  // 已退役的 `deadlineMs`（timing 组）与 `stallDetection` 不同物：前者是死线，后者是停顿检测。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("deadlineMs"), false, "`deadlineMs` 由 timing 片退役");
  // 同族不同物的**规位路径**是三条不同的路（不是同一个叶子的三个别名）。
  assert.equal(configPathForOption("persistence"), "run.persistence");
  assert.equal(configPathForOption("partialPersistence"), "run.partialPersistence");
  assert.equal(configPathForOption("stallDetection"), "run.stallDetection");
  assert.equal(configPathForOption("outputHygiene"), "run.outputHygiene");
});

test("N3 删扁平键 ≠ 删叶子：三件的叶子仍留在 `config.run` 里", () => {
  for (const key of KEYS) {
    const [, leaf] = homeOf(key).replace("config.", "").split(".");
    assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(leaf), true, `${leaf} 必须仍在 schema 的 run 组`);
  }
});

test("N4 账目派生化：这三个键都不在白名单，但仍在配置面的叶子表里（条数不手抄）", () => {
  const { configPlane } = RUN_TOOL_LOOP_OPTION_NAMES.reduce((acc, name) => {
    const path = configPathForOption(name);
    if (path !== undefined) acc.configPlane.push(name);
    return acc;
  }, { configPlane: [] });
  for (const key of KEYS) {
    assert.equal(configPlane.includes(key), false, `${key} 已退役 ⇒ 不在配置面顶层键里`);
    assert.equal(configPathForOption(key) !== undefined, true, `${key} 的叶子仍有家`);
  }
  // 三件一起走之后，配置面顶层键 = 叶子总数 − 失去顶层键的叶子（派生，不写死 12 / 9）。
  const leaves = Object.values(CONFIG_NAMESPACE_SCHEMA).flat();
  const orphanLeaves = leaves.filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.ok(orphanLeaves.length >= KEYS.length, "本片至少新增 3 个「失去顶层键的叶子」");
  assert.equal(configPlane.length + orphanLeaves.length, leaves.length,
    "配置面顶层键 + 孤儿叶子必须等于叶子总数（删键只搬家，不丢叶子）");
});
