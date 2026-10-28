// issue #498（S3）—— `run` 组的垂直切片 **A20**：`runId` 按裁决退役。
//
// 裁决路径：**照 `metadata` 族 / `stream` / `resume` 先例退役**（甲）。判据只有一个：
// **引擎会不会调用它**。实测——不会。`runId` 是**字符串标量**：`src/loop/orchestrator.js`
// 在 `:667` 从入参解构出它，此后全文件**没有任何再赋值**（`grep -nE "runId *=[^=]"` 空），
// 它只被当值往下传（transcript 的 `appendRound(runId, …)`、judge 记录的相关字段、观察者错误
// 归因）。没有 `typeof runId` 的函数判定、没有 `runId()` / `runId.call` / `runId.apply`。
// 于是函数值在那个位置**从来不是行为**：`config` 只装数据，函数本来就被 intake 当场拒。
// 所以本片**不**加校验器、不把 `runId` 搬去能力面（那是 `reflection` 那类「成员真被调用」的
// 处置，不是这里），也**不动**任何读侧代码。
//
// ⚠ 撞名提醒（本片最容易改错的地方）：整词 grep `runId` 在本仓有几百处命中，其中**只有一类**
// 是「`runToolLoop` 的顶层入口选项」。下面这些**全都不是**同一个东西，本片一个都没碰：
//   · transcript / round 行里的 `runId` **字段**（`src/store/*.js` 的 `appendRound(runId, …)`）；
//   · `judge.log` 里每条决策记录带的 `runId` + `model`（#165 的记录形状，`src/loop/judge-record.js`）；
//   · CLI 显示与 `examples/pi-extension` 的 run 句柄 `runId`；
//   · `~/.erix/transcripts/outputs/<runId>/` 目录名。
// 判据：**只有「作为 `runToolLoop` 顶层参数被读」的那一处**算写侧。
//
// 本文件钉七件事（账目全部派生，不手抄条数）：
//   P. 反向拒绝钉：顶层再写 `runId` ⇒ 当场拒，文案**逐字**指向 `config.run.runId`，
//      并且拒在任何宿主端口被调用之前（零请求）。
//   G. 闸口二（数据面）：字符串 / 空串 / 数字 / 布尔 / 对象在规位侧**全 ACCEPT**（真 run，
//      exit 0）、扁平侧**全拒**（名称闸口）。取值面一格都没被收紧。
//   F. 函数值：**两个拼写都被拒**——扁平侧名称闸口、规位侧 `config` 的 intake；两条理由
//      分开钉（这是裁决接受的那条收窄，不许因为「退役了」就把它抹掉）。
//   R. 读侧不动：展开相逐字写回 `effectiveOptions.runId`；真 run 里 `config.run.runId`
//      仍然真的到达 transcript 的键上（账本记录能被 `store.load(<那个 id>)` 取回）。
//   N. 邻接与账目：`run` 组剩余的「配置家」条数由白名单**派生**（不手抄 4 / 3）；叶子仍在
//      schema 的 `run` 组；四向闭合派生。
//   S. 夹具是翻译点：`withSeed` 产物里没有扁平 `runId`，值落在 `config.run.runId`。
//   T. **已退役的顶层名不得在任何拒绝文案里被当成可行建议推荐**（本片修的假话的反向钉；
//      名单由白名单派生，不硬编码键名）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withSeed } from "./helpers/run-direct.js";

/** 本片退役的键（字符串标量；家由 schema 派生）。 */
const KEY = "runId";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.runId`），拒绝文案里点名的那一条。 */
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
  assert.equal(home, "config.run.runId", "家必须仍是 config.run.runId（删扁平键 ≠ 删叶子）");
  const error = await rawError(base({ [KEY]: "a20-flat" }));
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
  const error = await runToolLoop(base({ provider, [KEY]: "a20-early" })).then(() => null, (e) => e);
  assert.equal(error instanceof TypeError, true);
  assert.equal(provider.requests.length, 0, "名称闸口必须早于任何宿主端口被调用");
});

// ================================================================ G. 闸口二（数据面）

test(`G1 闸口二矩阵（${KEY}）：字符串取值规位侧全 ACCEPT，扁平侧全被名称闸口拒`, async () => {
  // 五种「今天可能被传进来」的字符串/标量形态：普通 id、空串、数字、布尔、快照式对象。
  const shapes = ["a20-nested", "", 1, false, { runId: "x" }];
  assert.ok(shapes.length >= 3, `${KEY} 至少要抽查 3 格取值`);
  const nameGate = `unknown runToolLoop option: "${KEY}" (its canonical home is ${homeOf(KEY)};`
    + " the flat spelling is rejected)";
  for (const value of shapes) {
    const label = `${KEY}=${JSON.stringify(value)}`;
    const nested = await exitCode(base({ config: { run: { [KEY]: value } } }));
    assert.equal(nested, 0, `${label}：规位必须可达（exit 0，取值面没被收紧）`);
    const flat = await rawError(base({ [KEY]: value }));
    assert.equal(flat instanceof TypeError, true, `${label}：扁平拼写已退役 ⇒ 必须当场拒`);
    assert.equal(flat.message, nameGate, `${label}：扁平侧拒在名称闸口（逐字）`);
  }
});

test("G2 取值逐字到达 effectiveOptions（引擎既不校验也不改写）", async () => {
  for (const value of ["a20-verbatim", "", 7, false]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: { run: { [KEY]: value } },
    });
    assert.deepEqual(effectiveOptions[KEY], value, `${JSON.stringify(value)} 必须逐字写回`);
  }
});

// ================================================================ F. 函数值（裁决接受的收窄）

test("F1 函数值：扁平侧与规位侧**都**被拒，且两条理由分开钉", async () => {
  // ① 扁平侧：名称闸口。A20 之前它是 **exit 0**（`runId` 没有值校验器，函数被原样收下、
  //    然后只被当值往下传）——这条差异是「退役」本身带来的，与 `config` 无关。
  const flat = await rawError(base({ [KEY]: () => 1 }));
  assert.equal(flat instanceof TypeError, true, "扁平侧：名称闸口（A20 之前它是 exit 0）");
  assert.match(flat.message, new RegExp(`^unknown runToolLoop option: "${KEY}"`, "u"));

  // ② 规位侧：`config` 只装数据（#498 S4a 的约束 4），这条**一个字没动**——A20 之前
  //    `config.run.runId: () => 1` 就已经是当场拒。所以这不是本片新造的限制。
  const nested = await rawError(base({ config: { run: { [KEY]: () => 1 } } }));
  assert.equal(nested instanceof TypeError, true, "规位侧：`config` 只装数据（这条一个字没动）");
  assert.match(nested.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(nested.message, /the config namespace holds data only/u);
});

// ================================================================ R. 读侧不动

test(`R1 真 run：规位 ${KEY} 仍然是账本的键（记录能被同一个 id 取回）`, async () => {
  const store = createMemoryTranscriptStore();
  const result = await runToolLoop(base({
    store,
    config: { run: { [KEY]: "a20-read-side" } },
  }));
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.finalText, "ok");
  const records = await store.load("a20-read-side");
  assert.ok(records.length > 0, "规位拼写必须真的到达 `appendRound(runId, …)`（不是被静默忽略）");
  // 反向：换一个 id 读同一份账本 ⇒ 空。证明上面那条不是「store 对谁都返回记录」。
  assert.deepEqual(await store.load("a20-read-side-other"), []);
});

test(`R2 读侧唯一的读法：解构取值，从不调用（grep 可复现）`, async () => {
  // 出处（本片一行未改）：`src/loop/orchestrator.js` 的 `runId,` 解构（入参对象里的一项），
  // 全文件 `grep -nE "runId *=[^=]"` 为空（没有任何再赋值）。
  // 这里用行为钉住那句话：一个**非字符串**真值（对象）仍然被原样往下传——
  // 退役没有替引擎做类型化，也没有给它加校验器。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { run: { [KEY]: { id: "as-data" } } },
  });
  assert.deepEqual(effectiveOptions[KEY], { id: "as-data" }, "读侧拿到的是宿主原值（本片不替它做类型化）");
});

// ================================================================ N. 邻接与账目

test("N1 四向闭合 + 自检：删键只搬家，不靠条数自证", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向之和逐键等于白名单（不靠条数自证）");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [],
    "每个顶层选项恰好一个家（自检同时反向钉住「`runId` 不许又变成配置面键 + 顶层键两份」）");
});

test("N2 删扁平键 ≠ 删叶子：`runId` 仍在 `config.run` 里", () => {
  const [, leaf] = homeOf(KEY).replace("config.", "").split(".");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(leaf), true, `${leaf} 必须仍在 schema 的 run 组`);
});

test("N3 邻接面没动：`run` 组剩下的大件一件没动，`runId` 也已退役（A20）", () => {
  for (const key of ["completion", "maxRounds", "reflection"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), true, `${key} 仍可扁平写（本片不许收它）`);
  }
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("store"), true, "`store` 是永久顶层面，不许动");
  assert.equal(configPathForOption("runId"), "run.runId", "`runId` 的家一字未动");
});

test("N4 账目派生化：`run` 组还剩几个「配置家」的顶层键（不手抄 4 / 3）", () => {
  // 「config 家」= 仍是顶层选项、且 `configPathForOption` 落在 `run.` 下的键。删 `runId`
  // 之前是 4（`maxRounds` / `reflection` / `completion` / `runId`），删完是 3——
  // 两个数都由白名单派生，**不许**在本文件里写死任何一个。
  const runHomeKeys = RUN_TOOL_LOOP_OPTION_NAMES
    .filter((name) => (configPathForOption(name) ?? "").startsWith("run."));
  assert.deepEqual(runHomeKeys, ["maxRounds", "reflection", "completion"],
    "`run` 组还剩三个配置家键（顺序 = 白名单顺序 = 建议平局优先级，不是集合语义）");
  assert.equal(runHomeKeys.includes(KEY), false, `${KEY} 已经不在其中（这就是本片删掉的那一格）`);
  // 反向证：把 `runId` 塞回白名单，本格当场红（`deepEqual` 多一项）。
  const reinserted = [...RUN_TOOL_LOOP_OPTION_NAMES, KEY];
  assert.notDeepEqual(
    reinserted.filter((name) => (configPathForOption(name) ?? "").startsWith("run.")),
    runHomeKeys,
    "反向证：`runId` 回到白名单就必须让本格红",
  );
});

// ================================================================ S. 夹具是翻译点

test("S1 `withSeed` 把扁平 `runId` 翻译进 `config.run.runId`，产物里没有扁平键", () => {
  const out = withSeed({ [KEY]: "a20-fixture", provider: createFakeProvider(DONE) });
  assert.equal(Object.prototype.hasOwnProperty.call(out, KEY), false, "夹具产物里不许留下扁平键");
  assert.equal(out.config.run[KEY], "a20-fixture", "值必须落在规位");
  // `undefined` 逐字等于「没给」：不许凭空造一个 `config.run.runId`。
  const none = withSeed({ provider: createFakeProvider(DONE) });
  assert.equal(none.config?.run?.[KEY], undefined, "没给就是没给，夹具不补默认值");
});

// ================================================================ T. 拒绝文案不许推荐已退役的顶层名

/** `src/` 下所有 `.js` 的源码文本（拒绝文案都住在这里）。 */
function readSourceTexts() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && entry.name.endsWith(".js")) out.push({ rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") });
    }
  };
  walk("src");
  return out;
}

test("T1 已退役的顶层名不得在任何拒绝文案里被当成可行建议推荐（名单派生）", () => {
  const sources = readSourceTexts();
  assert.ok(sources.length > 0, "探针自证：`src/` 里真的读到了文件（否则本格恒绿）");

  // ① 「已退役的顶层名」= 有 `config` 家、但**不在**白名单里的叶子。名单由白名单与 schema
  //    派生，**不硬编码任何键名**（本片修的那句假话里那个名字也是从这条派生出场的）。
  const retired = Object.values(CONFIG_NAMESPACE_SCHEMA).flat()
    .filter((leaf) => configPathForOption(leaf) !== undefined && !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.ok(retired.includes(KEY), `派生名单必须包含本片退役的 ${KEY}（否则本格测的是空集）`);
  assert.ok(retired.length > 0, "派生名单不许是空集");

  // ② 逐字反向钉：任何 `pass <已退役名> as the top-level option` / `… as a top-level option`
  //    都当场红。这正是 A20 修掉的那句假话的形状（`src/assembly.js` 与
  //    `src/assembly-validators.js` 的 `session.resume` 拒绝文案）。
  for (const name of retired) {
    const bad = new RegExp(`pass\\s+${name}\\s+as\\s+(?:the|a)\\s+top-level option`, "u");
    for (const { rel, text } of sources) {
      const hit = text.match(bad);
      assert.equal(hit, null,
        `${rel} 把已退役的顶层名 ${name} 当成可行建议推荐了（「${hit?.[0]}」）：`
        + "那会把宿主指挥回一条已被名称闸口拒掉的路（A20 修的正是这种假话）");
    }
  }

  // ③ 更宽的一格（覆盖 `pass it as …` 这种不点名的写法）：`src/` 里任何「as the top-level
  //    option」的建议，其被推荐的名字必须是白名单成员（或者代词 `it`——那种写法的名字由
  //    调用点决定，见 `capabilityProblemMessage`，它的候选集就是白名单本身）。
  const recommend = /pass\s+(?:it\s+as\s+|([A-Za-z_$][\w$]*)\s+as\s+)(?:the|a)\s+top-level option/gu;
  let seen = 0;
  for (const { rel, text } of sources) {
    for (const match of text.matchAll(recommend)) {
      seen += 1;
      const named = match[1];
      if (named === undefined) continue;
      assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(named), true,
        `${rel} 推荐把 ${named} 写成顶层选项，但它不在白名单里（已退役的名字不许当建议）`);
    }
  }
  assert.ok(seen > 0, "探针自证：`src/` 里真的还有「as the top-level option」这种建议文案（否则本格恒绿）");
});
