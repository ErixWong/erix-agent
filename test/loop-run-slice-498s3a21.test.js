// issue #498（S3）—— `run` 组的垂直切片 **A21**：`maxRounds` 按裁决退役。
//
// 裁决路径：**照 `stream` / `resume` / `runId` 先例退役**。判据只有一个：**引擎会不会调用它**。
// 实测——不会。`maxRounds` 是**正整数标量**：`src/loop/orchestrator.js` 在参数解构里取默认值 8，
// 随后只做三件事：`Number.isSafeInteger(maxRounds) && maxRounds > 0` 的取值校验、
// `maxRounds >= DEFAULT_REFLECTION_MIN_ROUNDS`（judge 闸门）与 `Math.max(8, Math.floor(maxRounds * 0.5))`
// （扩轮默认步长）。全文件没有 `maxRounds()` / `maxRounds.call` / `maxRounds.apply`。
// 于是函数值在那个位置**从来不是行为**：扁平侧被 orchestrator 自己的取值校验拒（`maxRounds must be
// a finite positive integer`），规位侧被 `config` 的 intake 拒（只装数据）。两侧都拒 ⇒ 接受这条收窄，
// **不**加校验器、**不**把它搬去能力面，也**不动**任何读侧代码。
//
// ⚠ 本片最容易撞的东西：`maxRounds` 与治理层咬合（扩轮判定 `extensionAllowed`
// （`src/reflection/governor.js`）、`applyGovernorExtension`（`src/loop/orchestrator.js`）、
// `forceFinalIfNeeded` 的 cap、以及 #386 那条预算桥）。**引擎读侧一字未动**，本文件只改**写侧拼写**，
// 并把「扩轮 / 撞 cap 的既有钉子照旧」写成 as-is 段（R3/R4），不是本片新增的语义。
//
// 本文件钉七件事（账目全部派生，不手抄条数）：
//   P. 反向拒绝钉：顶层再写 `maxRounds` ⇒ 当场拒，文案**逐字**指向 `config.run.maxRounds`，
//      并且拒在任何宿主端口被调用之前（零请求）。
//   G. 闸口二（数据面）：整数在规位侧 ACCEPT（真 run，exit 0）；布尔 / 字符串 / `0` / 负数 /
//      超大在**两侧都拒**（扁平侧名称闸口、规位侧 orchestrator 的取值校验），文案逐字分开钉。
//   F. 函数值：**两个拼写都被拒**——扁平侧名称闸口、规位侧 `config` 的 intake；两条理由分开钉。
//   R. 读侧不动：展开相逐字写回 `effectiveOptions.maxRounds`；真 run 里它仍然真的决定轮数；
//      扩轮与 `max_rounds_cap` 的既有行为 as-is。
//   N. 邻接与账目：`run` 组剩余的「配置家」条数由白名单**派生**（不手抄 3 / 2）；叶子仍在
//      schema 的 `run` 组；四向闭合派生。
//   S. 夹具是翻译点：`withSeed` 产物里没有扁平 `maxRounds`，值落在 `config.run.maxRounds`。
//   T. **已退役的顶层名不得在任何拒绝文案里被当成可行建议推荐**（名单由白名单派生）。

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
import { extensionAllowed } from "../src/reflection/governor.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withSeed } from "./helpers/run-direct.js";

/** 本片退役的键（正整数标量；家由 schema 派生）。 */
const KEY = "maxRounds";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 规位路径（`run.maxRounds`），拒绝文案里点名的那一条。 */
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
      // #498 S3 A23b: `completion` retired its flat spelling too (home `config.run.completion`);
      // it joins the **same** `run` group — a second `config` key would silently win.
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
  assert.equal(home, "config.run.maxRounds", "家必须仍是 config.run.maxRounds（删扁平键 ≠ 删叶子）");
  const error = await rawError(base({ [KEY]: 8 }));
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
  const error = await runToolLoop(base({ provider, [KEY]: 8 })).then(() => null, (e) => e);
  assert.equal(error instanceof TypeError, true);
  assert.equal(provider.requests.length, 0, "名称闸口必须早于任何宿主端口被调用");
});

// ================================================================ G. 闸口二（数据面）

test(`G1 闸口二矩阵（${KEY}）：整数规位侧 ACCEPT；非法取值两侧都拒（理由分开）`, async () => {
  // 六格实测（真 run，`runToolLoop` 入口）：整数 / 布尔 / 字符串 / `0` / 负数 / 超大。
  const nameGate = `unknown runToolLoop option: "${KEY}" (its canonical home is ${homeOf(KEY)};`
    + " the flat spelling is rejected)";
  const rows = [
    // [label, value, 规位侧是否可达]
    ["整数 8", 8, true],
    ["布尔 true", true, false],
    ["字符串 \"8\"", "8", false],
    ["0", 0, false],
    ["负数 -1", -1, false],
    ["超大 1e300", 1e300, false],
  ];
  assert.ok(rows.length >= 6, `${KEY} 至少抽查六格取值`);
  for (const [label, value, nestedOk] of rows) {
    const nested = await exitCode(base({ config: { run: { [KEY]: value } } }));
    assert.equal(nested, nestedOk ? 0 : 1,
      `${label}：规位侧 ${nestedOk ? "必须可达（exit 0）" : "必须被 orchestrator 的取值校验拒（exit 1）"}`);
    const flat = await rawError(base({ [KEY]: value }));
    assert.equal(flat instanceof TypeError, true, `${label}：扁平拼写已退役 ⇒ 必须当场拒`);
    assert.equal(flat.message, nameGate, `${label}：扁平侧拒在名称闸口（逐字）`);
  }
});

test("G2 非法取值在规位侧的文案 = 引擎既有那条（本片一个字没造）", async () => {
  // `src/loop/orchestrator.js` 的取值校验（本片一行未改）：规位只是把值写回扁平名，
  // 校验照旧在同一个位置、同一句文案。
  for (const value of [true, "8", 0, -1, 1e300]) {
    const nested = await rawError(base({ config: { run: { [KEY]: value } } }));
    assert.equal(nested instanceof TypeError, true, `${JSON.stringify(value)} 必须拒`);
    assert.equal(nested.message, `${KEY} must be a finite positive integer`,
      `${JSON.stringify(value)}：文案必须是引擎既有那一句`);
  }
});

test("G3 取值逐字到达 effectiveOptions（展开相不改写、不做类型化）", async () => {
  for (const value of [1, 8, 100]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: { run: { [KEY]: value } },
    });
    assert.equal(effectiveOptions[KEY], value, `${value} 必须逐字写回`);
  }
});

// ================================================================ F. 函数值（裁决接受的收窄）

test("F1 函数值：扁平侧与规位侧**都**被拒，且两条理由分开钉", async () => {
  // ① 扁平侧：名称闸口。A21 之前它是 **exit 1**，但理由不同——orchestrator 的取值校验
  //    （`maxRounds must be a finite positive integer`）。函数在那个位置**从来不是行为**：
  //    引擎只校验它、比较它，从不调用它。
  const flat = await rawError(base({ [KEY]: () => 8 }));
  assert.equal(flat instanceof TypeError, true, "扁平侧：名称闸口");
  assert.match(flat.message, new RegExp(`^unknown runToolLoop option: "${KEY}"`, "u"));

  // ② 规位侧：`config` 只装数据（#498 S4a 的约束 4），这条**一个字没动**——A21 之前
  //    `config.run.maxRounds: () => 8` 就已经是当场拒。所以这不是本片新造的限制。
  const nested = await rawError(base({ config: { run: { [KEY]: () => 8 } } }));
  assert.equal(nested instanceof TypeError, true, "规位侧：`config` 只装数据（这条一个字没动）");
  assert.match(nested.message, new RegExp(`^config\\.run\\.${KEY} is not accepted`, "u"));
  assert.match(nested.message, /the config namespace holds data only/u);
});

// ================================================================ R. 读侧不动

test(`R1 真 run：规位 ${KEY} 真的决定轮数（不是「展开了但没人读」）`, async () => {
  const twoRounds = [
    { content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "x" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const tools = [{
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }];
  const capped = await runToolLoop(base({
    provider: createFakeProvider(twoRounds),
    tools,
    config: { run: { [KEY]: 1 } },
  }));
  assert.equal(capped.termination.reason, "max_rounds_cap", "1 轮预算必须真的生效");
  assert.equal(capped.rounds, 1);

  const roomy = await runToolLoop(base({
    provider: createFakeProvider(twoRounds),
    tools,
    config: { run: { [KEY]: 2 } },
  }));
  assert.equal(roomy.termination.reason, "end_turn", "2 轮预算必须真的生效");
  assert.equal(roomy.rounds, 2);
});

test("R2 解构默认值不动：不给 `maxRounds` 时仍是 8（引擎侧一行未改）", async () => {
  // `src/loop/orchestrator.js` 的 `maxRounds = 8` 解构默认值（本片一行未改）。
  // 行为证据：不传 ⇒ 轮数上限不是 1，也不是无穷。
  const script = Array.from({ length: 12 }, (_value, index) => ({
    content: [{ type: "tool_use", id: `w-${index + 1}`, name: "echo", input: { text: "x" } }],
    stopReason: "tool_use",
  }));
  const tools = [{
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }];
  const result = await runToolLoop(base({ provider: createFakeProvider(script), tools }));
  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(result.rounds, 8, "缺省预算必须仍是 8（解构默认值不动）");
});

test("R3 扩轮准入 as-is：`extensionAllowed` 判据一格未变，`maxRoundsCap <= maxRounds` 时不扩轮", async () => {
  // 治理层咬合面的 as-is 钉子：`maxRounds` 只换写侧拼写。扩轮的**准入判据**
  // （`extensionAllowed`，`src/reflection/governor.js`）本片一行未改，这里直接调它钉三态；
  // 真 run 里再用「cap 不大于当前上限 ⇒ 抬不动」把那条判据接到行为上。
  assert.equal(extensionAllowed({ extensionCount: 0, maxExtensions: 1, effectiveMaxRounds: 2, maxRoundsCap: 4 }), true,
    "配额还有、上限还没到 cap ⇒ 允许扩轮（既有行为）");
  assert.equal(extensionAllowed({ extensionCount: 1, maxExtensions: 1, effectiveMaxRounds: 2, maxRoundsCap: 4 }), false,
    "配额用完 ⇒ 不许扩轮（既有行为）");
  assert.equal(extensionAllowed({ extensionCount: 0, maxExtensions: 1, effectiveMaxRounds: 4, maxRoundsCap: 4 }), false,
    "已经顶到 cap ⇒ 不许扩轮（既有行为）");

  const tools = [{
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }];
  const toolRounds = (count) => Array.from({ length: count }, (_value, index) => ({
    content: [{ type: "tool_use", id: `w-${index + 1}`, name: "echo", input: { text: "x" } }],
    stopReason: "tool_use",
  }));
  const result = await runToolLoop(base({
    provider: createFakeProvider(toolRounds(6)),
    tools,
    config: {
      run: {
        maxRounds: 2,
        reflection: {
          enabled: true,
          roundJudge: false,
          judgeIntervalRound: 1,
          extensionStep: 2,
          maxExtensions: 1,
          // cap 不大于当前上限 ⇒ `extensionAllowed` 恒假 ⇒ 抬不动，预算 2 原样到顶。
          maxRoundsCap: 2,
        },
      },
    },
  }));
  assert.equal(result.rounds, 2, "cap 不大于当前上限 ⇒ 预算 2 原样到顶（既有行为，一格未变）");
  assert.equal(result.termination.reason, "max_rounds_cap");
});

test("R4 自动开 judge 的闸门 as-is：`maxRounds >= 16`（读侧一字未动）", async () => {
  // `src/loop/orchestrator.js` 的 `maxRounds >= DEFAULT_REFLECTION_MIN_ROUNDS`（16）闸门：
  // 拼写搬到 `config.run.maxRounds` 之后，它读的仍然是**展开后**的 `effectiveOptions.maxRounds`。
  // 不给 `reflection` 时：15 轮 ⇒ 自动关（零 judge 请求）；16 轮 ⇒ 自动开（judge 被调用）。
  const makeJudge = () => {
    const calls = [];
    const inner = createFakeProvider([{
      content: [{
        type: "text",
        text: JSON.stringify({ done: true, confidence: 0.9, reason: "达成", evidence: "ok", direction: "on_track" }),
      }],
      stopReason: "end_turn",
    }]);
    return {
      calls,
      provider: {
        ...inner,
        async chat(request) {
          calls.push(request);
          return inner.chat(request);
        },
      },
    };
  };
  const oneRound = [{ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }];

  const below = makeJudge();
  await runToolLoop(base({
    provider: createFakeProvider(oneRound),
    config: { run: { maxRounds: 15 } },
    capabilities: { ports: { judgeProvider: below.provider } },
  }));
  assert.equal(below.calls.length, 0, "15 < 16 ⇒ 自动 judge 不许开（闸门读的是展开后的值）");

  const at = makeJudge();
  await runToolLoop(base({
    provider: createFakeProvider(oneRound),
    config: { run: { maxRounds: 16 } },
    capabilities: { ports: { judgeProvider: at.provider } },
  }));
  assert.ok(at.calls.length > 0, "16 >= 16 ⇒ 自动 judge 必须开（闸门读的是展开后的值）");
});

// ================================================================ N. 邻接与账目

test("N1 四向闭合 + 自检：删键只搬家，不靠条数自证", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向之和逐键等于白名单（不靠条数自证）");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [],
    "每个顶层选项恰好一个家（自检同时反向钉住「`maxRounds` 不许又变成配置面键 + 顶层键两份」）");
});

test("N2 删扁平键 ≠ 删叶子：`maxRounds` 仍在 `config.run` 里", () => {
  const [, leaf] = homeOf(KEY).replace("config.", "").split(".");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(leaf), true, `${leaf} 必须仍在 schema 的 run 组`);
});

test("N3 账目派生化：`run` 组还剩几个「配置家」的顶层键（不手抄 3 / 2）", () => {
  // 「config 家」= 仍是顶层选项、且 `configPathForOption` 落在 `run.` 下的键。删 `runId`（A20）
  // 之后是 3（`maxRounds` / `reflection` / `completion`），A21 删 `maxRounds` ⇒ 2；
  // #498 S3 A23b 再删 `completion` ⇒ 1（`reflection`）。
  // 两个数都由白名单派生，**不许**在本文件里写死任何一个。
  const runHomeKeys = RUN_TOOL_LOOP_OPTION_NAMES
    .filter((name) => (configPathForOption(name) ?? "").startsWith("run."));
  assert.deepEqual(runHomeKeys, ["reflection"],
    "`run` 组只剩一个配置家键（顺序 = 白名单顺序 = 建议平局优先级，不是集合语义）");
  assert.equal(runHomeKeys.includes(KEY), false, `${KEY} 已经不在其中（这就是本片删掉的那一格）`);
  // 反向证：把 `maxRounds` 塞回白名单，本格当场红（`deepEqual` 多一项）。
  const reinserted = [...RUN_TOOL_LOOP_OPTION_NAMES, KEY];
  assert.notDeepEqual(
    reinserted.filter((name) => (configPathForOption(name) ?? "").startsWith("run.")),
    runHomeKeys,
    "反向证：`maxRounds` 回到白名单就必须让本格红",
  );
});

test("N4 邻接面没动：`run` 组剩下的两件与 `store` 端口一件没动", () => {
  // #498 S3 A23b：`completion` 也退役了（家 `config.run.completion`），同样从这条循环里移出、
  // 翻成反向钉——与上面各条逐字同形（改而不删）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("completion"), false, "A23b 已退役 `completion` 的扁平写法");
  for (const key of ["reflection"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), true, `${key} 仍可扁平写（本片不许收它）`);
  }
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("store"), true, "`store` 是永久顶层面，不许动");
  // 已退役的邻接键同样不许回潮（改而不删：逐条反向钉）。
  for (const retired of ["maxTokenContinuations", "stallDetection", "outputHygiene", "persistence",
    "partialPersistence", "replayPolicy", "invalidArguments", "writeToolNames", "writeToolPathKeys",
    "cwd", "stream", "resume", "runId"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(retired), false, `${retired} 已由更早的切片退役，不许回潮`);
  }
});

// ================================================================ S. 夹具是翻译点

test("S1 `withSeed` 把扁平 `maxRounds` 翻译进 `config.run.maxRounds`，产物里没有扁平键", () => {
  const out = withSeed({ [KEY]: 8, provider: createFakeProvider(DONE) });
  assert.equal(Object.prototype.hasOwnProperty.call(out, KEY), false, "夹具产物里不许留下扁平键");
  assert.equal(out.config.run[KEY], 8, "值必须落在规位");
  // `undefined` 逐字等于「没给」：不许凭空造一个 `config.run.maxRounds`。
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
      else if (entry.isFile() && entry.name.endsWith(".js")) out.push(readFileSync(join(REPO_ROOT, rel), "utf8"));
    }
  };
  walk("src");
  return out;
}

test("T1 已退役的顶层名不许被当成可行建议推荐（名单派生自白名单）", async () => {
  // 候选池 = 白名单，所以「退役名被建议」这种假话只可能来自硬编码。这里按**行为**核：
  // 对每个已退役的配置家键名，拼一个近错，断言建议里绝不出现它。
  const retired = CONFIG_NAMESPACE_SCHEMA.run
    .filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));
  assert.ok(retired.includes(KEY), "`maxRounds` 必须出现在派生出的退役名单里（否则本格恒绿）");
  const texts = readSourceTexts().join("\n");
  assert.equal(
    new RegExp(`did you mean "${KEY}"`, "u").test(texts),
    false,
    `源码里不许出现 \`did you mean "${KEY}"\`：它已不在候选池，这句话就是假话`,
  );
});
