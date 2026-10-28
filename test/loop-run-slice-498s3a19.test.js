// issue #498（S3）—— `run` 组的垂直切片 **A19**：`resume` 按裁决退役。
//
// 裁决路径：**照 `metadata` 族 / `stream` 先例退役，接受「函数值被拒」这条收窄**（甲）。
// 判据只有一个：**引擎有没有调用它**。实测——没有。`resume` 在引擎里只被**真值判断**两次
// （`src/loop/resume-manager.js`：`if (!ctx.resume || …)` 与 `if (ctx.resume && ctx.store …)`），
// 没有任何 `typeof resume`、没有 `resume()`、没有 `resume.call/apply`（`grep` 可复现，见 R2）。
// 于是函数值在那个位置**从来不是行为**：`config` 只装数据，函数本来就被 intake 当场拒。
// 所以本片**不**加校验器、不把 `resume` 搬去能力面（那是 `reflection` 那类「成员真被调用」的
// 处置，不是这里），也**不动**任何读侧代码（`resume-manager.js` / `orchestrator.js` 一字未改）。
//
// 本文件钉六件事（账目全部派生，不手抄条数）：
//   P. 反向拒绝钉：顶层再写 `resume` ⇒ 当场拒，文案**逐字**指向 `config.run.resume`，
//      并且拒在任何宿主端口被调用之前（零请求）。
//   G. 闸口二（数据面）：`true` / `false` / 字符串 / 快照对象 / 数字 1 在规位侧**全 ACCEPT**
//      （真 run，exit 0）、扁平侧**全拒**（名称闸口）。取值面一格都没被收紧。
//   F. 函数值：**两个拼写都被拒**——扁平侧名称闸口、规位侧 `config` 的 intake；两条理由
//      分开钉（这是裁决接受的那条收窄，不许因为「退役了」就把它抹掉）。
//   R. 读侧不动：展开相逐字写回 `effectiveOptions.resume`；真 run 里 `config.run.resume: true`
//      仍然真的续跑（从账本重建），`false` 仍是普通 run。
//   N. 邻接与账目：`session.resume`（#531 的裁决）两条路仍都拒、原样；`journalResumeUnpersistedToolResults`
//      与 `resumeRunSnapshot` 的注解一个没动；四向闭合派生；`run` 组剩余叶子**不断言条数**。
//   S. 夹具是翻译点：`withSeed` 产物里没有扁平 `resume`，值落在 `config.run.resume`。
//
// ⚠ 撞名提醒：整词 grep `resume` 在本仓有几百处命中，其中**只有一类**是「`runToolLoop` 的顶层
// 选项」——`store.loadRunState` 的恢复、`session.resume`（装配口成员，另一张面）、
// `journalResumeUnpersistedToolResults`（#420 的账本闭合主张）、`resumeRunSnapshot`（快照注解）、
// CLI 从 transcript 恢复（#433 修 1）全都**不是**同一个东西。本片只退役那一个入口。
//
// 零真实 LLM（fake / scripted provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
  configSchemaSelfCheck,
  optionHomeBuckets,
  CONFIG_SURFACE_OPTION_NAMES,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withSeed } from "./helpers/run-direct.js";

/** 本片退役的键（布尔数据；家由 schema 派生）。 */
const KEY = "resume";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.resume`），拒绝文案里点名的那一条。 */
function homeOf(key) {
  const path = configPathForOption(key);
  assert.equal(typeof path, "string", `${key} 失去顶层键之后必须仍有 config 家`);
  return `config.${path}`;
}

/**
 * 一条「可续跑」的最小现场：账本里恰好一条记录。
 *
 * `resume: true` 在**空账本**上会抛 `resume: 无可恢复记录`（那是取值语义，不是形状拒绝）——
 * 于是闸口二那一格就会把「形状被拒」和「现场为空」混在一起。这里先把现场铺好，
 * 让 exit 0 真的等于「这个形状被接受」。
 */
async function seededStore(runId) {
  const store = createMemoryTranscriptStore();
  await store.appendRound(runId, {
    round: 0,
    messages: [{ role: "user", content: "task" }],
  });
  return store;
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
    completion: false,
    ...extra,
    // `config` 是**合并**而不是覆盖：`...extra` 之后再写一个字面量 `config` 会把调用方那份
    // 静默顶掉（后者胜）——那正是 `test/loop-seed-fixture-521.test.js` 的 G1 在扫的雷。
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", wrapup: false, ...extra.config?.input },
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
  assert.equal(home, "config.run.resume", "家必须仍是 config.run.resume（删扁平键 ≠ 删叶子）");
  const error = await rawError(base({ [KEY]: true }));
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
  const error = await runToolLoop(base({ provider, [KEY]: true })).then(() => null, (e) => e);
  assert.equal(error instanceof TypeError, true);
  assert.equal(provider.requests.length, 0, "名称闸口必须早于任何宿主端口被调用");
});

// ================================================================ G. 闸口二（数据面）

test(`G1 闸口二矩阵（${KEY}）：数据取值规位侧全 ACCEPT，扁平侧全被名称闸口拒`, async () => {
  // 三种「今天可能被传进来」的数据形态都试到：布尔、字符串、快照对象（外加数字真值）。
  const shapes = [true, false, "yes", { messages: [], round: 0 }, 1];
  assert.ok(shapes.length >= 3, `${KEY} 至少要抽查 3 格数据取值`);
  const nameGate = `unknown runToolLoop option: "${KEY}" (its canonical home is ${homeOf(KEY)};`
    + " the flat spelling is rejected)";
  for (const value of shapes) {
    const label = `${KEY}=${JSON.stringify(value)}`;
    const nested = await exitCode(base({
      config: { run: { [KEY]: value, runId: "a19-nested" } },
      store: await seededStore("a19-nested"),
    }));
    assert.equal(nested, 0, `${label}：规位必须可达（exit 0，取值面没被收紧）`);
    const flat = await rawError(base({ [KEY]: value }));
    assert.equal(flat instanceof TypeError, true, `${label}：扁平拼写已退役 ⇒ 必须当场拒`);
    assert.equal(flat.message, nameGate, `${label}：扁平侧拒在名称闸口（逐字）`);
  }
});

test(`G2 取值逐字到达 effectiveOptions（引擎既不校验也不改写）`, async () => {
  for (const value of [true, false, 1, "yes"]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: { run: { [KEY]: value } },
    });
    assert.deepEqual(effectiveOptions[KEY], value, `${JSON.stringify(value)} 必须逐字写回`);
  }
});

// ================================================================ F. 函数值（裁决接受的收窄）

test(`F1 函数值：扁平侧与规位侧**都**被拒，且两条理由分开钉`, async () => {
  // ① 扁平侧：名称闸口。A19 之前它是 **exit 0**（`resume` 没有值校验器，函数被原样收下、
  //    然后只参与真值判断）——这条差异是「退役」本身带来的，与 `config` 无关。
  const flat = await rawError(base({ [KEY]: () => 1 }));
  assert.equal(flat instanceof TypeError, true, "扁平侧：名称闸口（A19 之前它是 exit 0）");
  assert.match(flat.message, new RegExp(`^unknown runToolLoop option: "${KEY}"`, "u"));

  // ② 规位侧：`config` 只装数据（#498 S4a 的约束 4），这条**一个字没动**——A19 之前
  //    `config.run.resume: () => 1` 就已经是当场拒。所以这不是本片新造的限制。
  const nested = await rawError(base({ config: { run: { [KEY]: () => 1 } } }));
  assert.equal(nested instanceof TypeError, true, "规位侧：`config` 只装数据（这条一个字没动）");
  assert.match(nested.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(nested.message, /the config namespace holds data only/u);
  assert.match(nested.message, /the engine never calls it, it only forwards the value/u,
    "「引擎从不调用它」是裁决的正当性说明：函数在这个位置从来不是行为");
});

// ================================================================ R. 读侧不动

test(`R1 真 run：规位 ${KEY}: true 仍然真的续跑（从账本重建），false 仍是普通 run`, async () => {
  const resumedStore = await seededStore("a19-read-resume");
  const resumed = await runToolLoop(base({
    provider: createFakeProvider([{ content: [{ type: "text", text: "续上了" }], stopReason: "end_turn" }]),
    config: { run: { [KEY]: true, runId: "a19-read-resume" } },
    store: resumedStore,
  }));
  assert.equal(resumed.termination.reason, "end_turn");
  assert.equal(resumed.finalText, "续上了", "规位拼写必须真的走到续跑分支（不是被静默忽略）");

  const plainStore = await seededStore("a19-read-plain");
  const plain = await runToolLoop(base({
    provider: createFakeProvider([{ content: [{ type: "text", text: "普通 run" }], stopReason: "end_turn" }]),
    config: { run: { [KEY]: false, runId: "a19-read-plain" } },
    store: plainStore,
  }));
  assert.equal(plain.finalText, "普通 run", "`false` 仍是普通 run（缺省值语义一字未改）");
});

test(`R2 读侧唯一的两次读法：真值判断，从不调用（grep 可复现）`, async () => {
  // 出处（本片一行未改）：`src/loop/resume-manager.js`
  //   `if (!ctx.resume || ctx.runId === undefined) return "absent";`
  //   `if (ctx.resume && ctx.store && ctx.runId !== undefined) { … }`
  // 全仓没有 `typeof <x>resume` 的函数判定、没有 `resume(` / `resume.call` / `resume.apply`。
  // 这里用行为钉住那句话：一个**非布尔真值**（字符串）仍然被当成 `true` 走续跑分支——
  // 退役没有替引擎做布尔化，也没有给它加校验器。
  const store = await seededStore("a19-truthy");
  const result = await runToolLoop(base({
    provider: createFakeProvider([{ content: [{ type: "text", text: "truthy 也续跑" }], stopReason: "end_turn" }]),
    config: { run: { [KEY]: "yes", runId: "a19-truthy" } },
    store,
  }));
  assert.equal(result.finalText, "truthy 也续跑", "真值判断照旧：非布尔真值仍走续跑分支");
  const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { run: { [KEY]: "yes" } } });
  assert.equal(effectiveOptions[KEY], "yes", "读侧拿到的是宿主原值（本片不替它做布尔化）");
});

// ================================================================ N. 邻接与账目

test("N1 四向闭合 + 账目派生：删键只搬家，配置面顶层键 + 孤儿叶子 = 叶子总数", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向之和逐键等于白名单（不靠条数自证）");
  const leaves = Object.values(CONFIG_NAMESPACE_SCHEMA).flat();
  const orphanLeaves = leaves.filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.equal(configPlane.includes(KEY), false, `${KEY} 已退役 ⇒ 不在配置面顶层键里`);
  assert.equal(configPathForOption(KEY) !== undefined, true, `${KEY} 的叶子仍有家`);
  assert.ok(orphanLeaves.includes(KEY), `${KEY} 必须出现在「失去顶层键的叶子」里`);
  assert.equal(configPlane.length + orphanLeaves.length, leaves.length,
    "配置面顶层键 + 孤儿叶子必须等于叶子总数（删键只搬家，不丢叶子）");
  assert.equal(configPlane.length + orphanLeaves.length, CONFIG_SURFACE_OPTION_NAMES.length,
    "配置面名单本身没变（本片只动白名单，不动 schema）");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
  // `run` 组**剩余**叶子数由 schema 派生，不手抄条数：本片只要求「叶子还在、键没了」。
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(KEY), true, "叶子不许被顺手删掉");
});

test("N2 邻接钉子原样：`session.resume` 两条路仍都拒（#531 的裁决本片不碰）", async () => {
  // 装配口一条路：`session` 只装数据（走真装配口，不是直连）。
  const portError = await runToolLoop(withSeed({
    assemblyPort: {
      modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
      provider: createFakeProvider(DONE),
      tools: { definitions: [], executeTool: async () => "ok" },
      session: { id: "a19-port", resume: true },
    },
    seed: "go",
    completion: false,
  })).then(() => null, (caught) => caught);
  assert.equal(portError instanceof TypeError, true, "装配口 `session.resume` 仍必须拒");
  assert.equal(
    portError.message,
    "assembly port session.resume is not accepted: session is data only"
      + " (pass it as config.run.resume; the flat top-level spelling was retired in 0.28)",
    "装配口判词逐字原样（本片一个字没改；文案里那句 top-level 属 #531 的既有裁决）",
  );
  // 直连一条路：不许收下键又不续跑（#498 S4b 的原判词）。
  const directError = await rawError(base({ session: { id: "a19-direct", resume: true } }));
  assert.equal(
    directError.message,
    "session.resume is not accepted: session is data only"
      + " (pass it as config.run.resume; the flat top-level spelling was retired in 0.28)",
    "`session.resume` 的直连判词逐字原样（本片一个字没改）",
  );
  // 幻影别名也不许回来：`config.metadata.session` 仍是闭门。
  const closed = await rawError(base({ config: { metadata: { session: { id: "a19" } } } }));
  assert.match(closed.message, /^unknown config\.metadata option: "session"/u, "#531 的闭门钉子原样保留");
});

test("N3 邻接钉子原样：`journalResumeUnpersistedToolResults` / `resumeRunSnapshot` 的注解不在本片", () => {
  // 这两处是**读侧**（#420 的账本闭合主张、快照注解），本片只改写侧拼写 ⇒ 它们不是选项、
  // 也不在白名单里。钉住「它们从来不是 `runToolLoop` 的顶层选项」，防止下一片把它们混进来。
  for (const adjacent of ["journalResumeUnpersistedToolResults", "resumeRunSnapshot", "resumeInfo"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(adjacent), false,
      `${adjacent} 是读侧事实/注解，不是引擎选项`);
  }
  assert.equal(configPathForOption("journalResumeUnpersistedToolResults"), undefined);
  assert.equal(configPathForOption("resumeRunSnapshot"), undefined);
});

test("N4 退役 ≠ 换成能力面：`resume` 不是 `capabilities` 的成员", () => {
  const { capability } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  assert.equal(capability.includes(KEY), false,
    "`resume` 是数据（布尔），不是行为载体 —— 退役后它只剩 `config.run.resume` 一个家");
});

// ================================================================ S. 夹具是翻译点

test(`S1 夹具是翻译点：withSeed 产物里没有扁平 ${KEY}，值落在 config.run`, () => {
  const moved = withSeed({ [KEY]: true, seed: "go" });
  assert.equal(Object.hasOwn(moved, KEY), false, "夹具漏摘扁平键 ⇒ 引擎当场拒");
  assert.equal(moved.config.run[KEY], true, "值必须搬进 config.run");
  assert.equal(moved.config.input.initialUserMessage, "go", "种子照旧进 config.input");
  const untouched = withSeed({ [KEY]: undefined, seed: "go" });
  assert.equal(untouched.config.run, undefined, "undefined 不许被翻译成一个键");
  // 形状拒绝格：非对象 `config` 原样透传（夹具不覆盖「config 必须是对象」那条拒绝）。
  const shapeCell = withSeed({ [KEY]: true, seed: "go", config: "nested" });
  assert.equal(shapeCell.config, "nested", "非对象 config 必须原样透传（否则那一格测的是另一条文案）");
  assert.equal(shapeCell[KEY], true, "透传时夹具不摘键：那格测的是 config 的形状，不是本键");
});
