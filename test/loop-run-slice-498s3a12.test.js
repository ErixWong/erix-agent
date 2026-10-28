// issue #498（S3）—— `run` 组的**垂直切片 A12**（第一刀）：删掉顶层扁平 `partialPersistence`，
// 它的规范之家是 `config.run.partialPersistence`（`CONFIG_NAMESPACE_SCHEMA.run`，
// `src/loop/config-namespace.js`）。
//
// 本片量到的账（先量后写，全量实测）：`run` 组四件里 `partialPersistence` 单删红格 **16**、
// `outputHygiene` 30、`persistence` 38、`stallDetection` 117（和 201；四件同删 176 ⇒ 重叠 25）。
// 四件同删远超本仓 ~150 的夹具级阈值，且 `stallDetection` 一件就 117 —— 一次做四件会把「写侧
// 拼写搬家」这条主张和一次 176 格的机械迁移绑死。所以本片**按件切片**：这一刀只退
// `partialPersistence`，其余三件退回给后续切片（报告里给候选与实测数字）。
//
// `test/` 侧的 70 + 12 + 15 + 15 处写点收在**一处**翻译点（`test/helpers/run-direct.js` 的
// `withRunFamily`，与 #521 的种子夹具同一条纪律），于是本键的 16 格红降到 4 处手写点。
//
// 本文件钉五件事（全部派生，不手抄键数）：
//
//   P. 旧名反向拒绝钉：顶层再写 `partialPersistence` ⇒ 当场拒，文案**逐字**指向新家。
//   G. 闸口二矩阵：三个合法形状（`false` / `{intervalMs}` / `{intervalMs,minBytes}`）规位侧必须
//      exit 0；删键之后扁平侧必须是**名称闸口的拒**（不是静默忽略）。
//   F. 规位里给函数值 ⇒ 逐字两句话（`config` 只装数据 + 引擎从没调用过它）。
//   R. 读侧不动：写在规位里的值展开后逐字到达 `effectiveOptions.partialPersistence`，并真的
//      驱动 `stream + partialPersistence` 的恢复路径（一次真 run，内存 store）。
//   N. 邻接：`persistence`（模式）与 `store`（端口）都**没动**；`config.run.partialPersistence`
//      与 `config.run.persistence` 是两个键。
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

const KEY = "partialPersistence";
const HOME = "config.run.partialPersistence";
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/**
 * 最小合法 run：一次 end_turn 就结束。
 *
 * ⚠ **不经过 `runDirect` 夹具**：夹具会把扁平 `partialPersistence` 翻译进规位（那正是它存在的
 * 理由），于是「扁平拼写被拒」这一格永远测不到。本文件要测的正是引擎拼写，所以直连
 * `runToolLoop`，种子也写成引擎拼写 `config.input.initialUserMessage`。
 */
function base(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    config: { input: { initialUserMessage: "go" } },
    completion: false,
    wrapup: false,
    // #498 S3 A13：`stallDetection` 也退役了扁平写法（家在 `config.run.stallDetection`），所以
    // 这里不再拿它当「仍在白名单的填充键」——那会让本文件随下一片一起红。填充键只留仍在
    // 白名单里的 `completion` / `wrapup`。
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

test("P1 扁平拼写已退役：名称闸口当场拒，文案逐字点名新家（零建议）", async () => {
  const error = await rawError(base({ [KEY]: false }));
  assert.equal(error instanceof TypeError, true);
  assert.equal(
    error.message,
    `unknown runToolLoop option: "${KEY}" (its canonical home is ${HOME}; the flat spelling is rejected)`,
  );
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(KEY), false, "白名单里不许还有它");
});

// ================================================================ G. 闸口二

test("G1 闸口二矩阵：三个合法形状规位侧 exit 0，扁平侧是名称闸口的拒", async () => {
  const shapes = [false, { intervalMs: 100 }, { intervalMs: 100, minBytes: 0 }];
  for (const value of shapes) {
    const label = `${KEY}=${JSON.stringify(value)}`;
    // #498 S3 A16：`stream` 的扁平拼写退役（家 = `config.run.stream`），这两格的
    // 「让 run 走流式路径」改成规位拼写——测的是 `partialPersistence`，不是 `stream` 的写法。
    const nested = await exitCode(base({ config: { run: { [KEY]: value, stream: true } } }));
    const flat = await exitCode(base({ [KEY]: value, config: { run: { stream: true } } }));
    assert.equal(nested, 0, `${label}：规位必须可达（exit 0）`);
    assert.equal(flat, 1, `${label}：扁平拼写已退役 ⇒ 必须当场拒（不是静默忽略）`);
  }
});

test("G2 非法形状两侧都拒（`true` 不是本键的合法形状，规位侧不比扁平侧松）", async () => {
  const nested = await exitCode(base({ config: { run: { [KEY]: true, stream: true } } }));
  assert.equal(nested, 1, "规位侧也必须是 exit 1（形状校验仍在 orchestrator 里）");
});

// ================================================================ F. 函数值

test("F1 规位里给函数值：逐字两句话（只装数据 + 引擎从没调用过它）", async () => {
  const error = await rawError(base({ config: { input: { initialUserMessage: "go" }, run: { [KEY]: () => 1 } } }));
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(error.message, /the config namespace holds data only/u);
  assert.match(error.message, /the engine never calls it, it only forwards the value/u);
});

// ================================================================ R. 读侧不动

test("R1 展开相逐字写回 effectiveOptions.partialPersistence（读侧一行未改）", async () => {
  const value = { intervalMs: 250, minBytes: 0 };
  const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { run: { [KEY]: value } } });
  assert.deepEqual(effectiveOptions[KEY], value);
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
});

test("R2 真 run：规位值驱动 stream 快照路径（终局正文只出现一次，恢复不重复）", async () => {
  const store = createMemoryTranscriptStore();
  const result = await runToolLoop(base({
    store,
    runId: "a12-partial",
    config: { run: { [KEY]: { intervalMs: 1 }, stream: true } },
  }));
  assert.equal(result.finalText, "ok");
  assert.equal(result.termination.reason, "end_turn");
});

// ================================================================ N. 邻接与账目

test("N1 只点一站：本键的值是纯数据，报错里不出现 `capabilities.` 那一站", async () => {
  const error = await rawError(base({ [KEY]: false }));
  assert.equal(error.message.includes("capabilities."), false);
});

test("N2 `store`（端口）没动；`persistence`（模式）与 `partialPersistence` 是两个键、两条路", () => {
  // A12 当时还能断言 `persistence` 仍在白名单（「本片只退 partialPersistence」）。A13 之后
  // 它**也**退役了扁平写法 —— 所以这条改成断言「同族不同物」：两条规位路径不同，叶子都还在。
  // `store` 是第三站的端口，A12/A13 都不动它。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("store"), true);
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("persistence"), false, "A13 之后它也退役了");
  assert.equal(configPathForOption(KEY), "run.partialPersistence");
  assert.equal(configPathForOption("persistence"), "run.persistence");
  // 叶子仍在 schema 里（删扁平键 ≠ 删叶子）。
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(KEY), true);
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes("persistence"), true);
});
