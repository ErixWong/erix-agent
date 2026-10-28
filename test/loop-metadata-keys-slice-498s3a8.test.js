// issue #498（S3）—— `metadata` 组的**四个小键（A8 段）**：删掉顶层扁平写法
// `modelMetadata` / `requestId` / `toolContext` / `expert`，它们的规范之家是 `config.metadata.*`
// （`CONFIG_NAMESPACE_SCHEMA.metadata`，`src/loop/config-namespace.js`）。
// 同组的大四件（`user` / `task` / `model` / `session`）**不在本刀**：它们的写点要先有夹具级翻译点
// （#528 那种前置风格），本片一个字都没动，P5-c 逐键钉住这条边界。
// **#498 S3 A9 起**：`user` / `model` / `task` 已经退役（实测单删红格 6 / 5 / 13，远低于夹具级阈值
// ⇒ 不需要翻译点），P5-c 改成**派生**边界；`session` 经同值判定退回（见 `...slice-498s3a9.test.js`）。
//
// 本文件钉的是六件事：
//
//   P. **旧名反向拒绝钉**：顶层再写这四个名字 ⇒ 当场拒，文案**逐字**指向新家（`assert.equal`，
//      不是 `match`）。少一个 `config.metadata.`，0.26 → 0.28 升级的宿主就没了路标。
//   P3. **写错位置各有自己的文案**：`config.modelMetadata`（把扁平键写在 config 顶层）与
//      `config.metadata.modelMetada`（拼错叶子）各自点名，且**接受名单里四个叶子都还在**——
//      这就是「删的是顶层拼写，不是叶子」的机器证据。
//   P4. **这四个键都不是混装壳**（`capabilityDestinationsForShell` 恒空 ⇒ 文案只点一站），
//      而写在**新家**里的函数值必须直说两件事：`config` 只装数据，**且引擎从来没调用过它**
//      （`budget.js` 只把值转发进工具上下文 / judge 简报）。对照组 `context` 证明「两站」这条
//      机制仍然咬得住——不是把提示整段删掉也能绿。
//   F. **函数差异 as-is 钉**（本片工单点名的那一格）：扁平写法今天**收**函数（`session: () => 1`
//      通过、`typeof` 一路保持到工具上下文），规位**拒**（`config.metadata.session = () => 1` 当场抛）。
//      把这个**差异本身**钉成 as-is：将来谁放宽了（或谁把扁平也一起收了）这里就会红。
//      （A9 起钉子从 `user` 搬到 `session`：`user` 退役后扁平写法不再收函数。）
//   S. **建议噪声**（本片特有的坑）：`model` 与 `modelMetadata` 是编辑距离很近的兄弟键。退役之后
//      写错 `modelMetadata` 的人**不许**被建议成 `model`（那样他会把预算元数据写成模型名），
//      而要看到规位路径。判据是实测文案，不是「我觉得」；对照组 `modle` 证明建议机制仍在工作。
//   R. **读侧不动**：`modelMetadata`（预算推导）、`toolContext` / `requestId` / `expert`
//      （工具上下文）与 `expert` 的 fallback 链（`budget.js:87` 的 `context?.expert`）都用真 run
//      证明照旧工作——本刀只搬写侧拼写。
//   A. **账目格派生化**：不写手抄的键数。配置面 **25 → 21** 这条账由
//      `CONFIG_SURFACE_OPTION_NAMES ∖ RUN_TOOL_LOOP_OPTION_NAMES` 派生对账；
//      `grep -rn 'RUN_TOOL_LOOP_OPTION_NAMES.length, [0-9]' test` 必须为 0（A2 扫整个 `test/`）。
//
// 零真实 LLM（fake provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_NAMESPACE_SCHEMA,
  CONFIG_SURFACE_OPTION_NAMES,
  NAMESPACE_CONTAINER_OPTION_NAMES,
  configPathForOption,
  configPlaneOptionNames,
  configSchemaSelfCheck,
  optionHomeBuckets,
} from "../src/loop/config-namespace.js";
import { capabilityDestinationsForShell } from "../src/loop/capabilities-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
  optionSuggestion,
} from "../src/loop/option-normalization.js";
import { assemblyPortOptions, createAssemblyPort } from "../src/assembly.js";
import { runDirect as sharedRunDirect, directError as sharedDirectError } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const TOOL_ROUND = [
  { content: [{ type: "tool_use", id: "c1", name: "work", input: {} }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
];
const WORK_TOOL = [{ name: "work", description: "d", inputSchema: { type: "object", properties: {} } }];

/** 本片退役的四个键 → 它们的规范之家（逐字）。表只在这里出现一次，后面全部从它派生。 */
const RETIRED = [
  { key: "modelMetadata", home: "metadata.modelMetadata", value: { contextWindowTokens: 131072, maxOutputTokens: 8192 } },
  { key: "requestId", home: "metadata.requestId", value: "req-a8" },
  { key: "toolContext", home: "metadata.toolContext", value: { tenant: "a8" } },
  { key: "expert", home: "metadata.expert", value: "backend" },
];

/**
 * 本片（A8）**不许**碰的同组大四件（另一片）。
 *
 * #498 S3 A9 起这条边界是**派生**的：叶子仍在 schema 里，而扁平拼写是否仍在白名单由源名单说了算。
 * 于是 A9 每退役一个键（`user` / `model` / `task`），这张表自动变短，不需要改判断逻辑；
 * **#531** 把 `session` 立成第三站成员、拆掉了 `config.metadata.session` 叶子 ⇒ 它不再在这张表里
 * （它也没有嵌套家了，`configPathForOption` 回答 undefined）。
 */
const STILL_FLAT = ["user", "task", "model", "session"]
  .filter((key) => RUN_TOOL_LOOP_OPTION_NAMES.includes(key))
  .filter((key) => configPathForOption(key) !== undefined)
  .map((key) => ({ key, home: configPathForOption(key) }));

/** 直连路线的最小合法 run（一次 end_turn 就结束）。 */
function runDirect(extra = {}) {
  return sharedRunDirect({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    seed: "go",
    completion: false,
    wrapup: false,
    ...extra,
  });
}

/** 直连路线「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => sharedDirectError({
  provider: createFakeProvider(DONE),
  executeTool: async () => "ok",
  seed: "go",
  completion: false,
  wrapup: false,
  ...extra,
});

/** 把一个 `metadata.<leaf>` 路径摊成 `config: { metadata: { <leaf>: value } }`。 */
const atHome = (home, value) => {
  const [group, leaf] = home.split(".");
  return { [group]: { [leaf]: value } };
};

// ================================================================ P. 旧名反向拒绝（一键一格）
//
// 两段：① 逐字相等的文案（含新家路径）；② 同一个值写在新家里必须**不抛**——「拒旧名」与
// 「收新家」必须同时成立，否则这条钉子只是在说「我把键弄丢了」。

for (const { key, home, value } of RETIRED) {
  test(`P 顶层 ${key} ⇒ 当场拒，文案逐字指向 config.${home}`, async () => {
    const error = await directError({ [key]: value });
    assert.equal(error instanceof TypeError, true, "旧名必须在名称闸口抛 TypeError（不是静默忽略）");
    assert.equal(
      error.message,
      `unknown runToolLoop option: ${JSON.stringify(key)} (its canonical home is config.${home};`
        + " the flat spelling is rejected)",
      `文案必须点名新家——少了 config.${home}，升级的宿主只能自己猜`,
    );
    // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（读侧不变）。
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: atHome(home, value) });
    assert.deepEqual(effectiveOptions[key], value, `config.${home} 必须写回 effectiveOptions.${key}`);
  });
}

test("P2 四个键的取值两端都走同一条路：拒绝的是拼写，不是值", async () => {
  // `0` / `false` / `""` 都不是「没给」（`undefined` 才是），所以它们在规位被接受、在扁平被拒。
  const extremes = {
    modelMetadata: [undefined, {}, { contextWindowTokens: 0 }],
    requestId: ["", 0, false],
    toolContext: [{}, [], { nested: { deep: [1, 2] } }],
    expert: ["", 0, false],
  };
  for (const { key, home } of RETIRED) {
    for (const value of extremes[key]) {
      const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: atHome(home, value) });
      assert.deepEqual(effectiveOptions[key], value, `config.${home}=${JSON.stringify(value)} 必须逐字写回`);
      const error = await directError({ [key]: value });
      assert.equal(error instanceof TypeError, true, `扁平 ${key}=${JSON.stringify(value)} 也必须被拒`);
    }
  }
});

// ================================================================ P3. 写错位置各有自己的文案
//
// 「把扁平键写在 config 顶层」与「叶子拼错」是两种病，文案必须分开；后者的接受名单里四个叶子
// **都还在**——这就是「删顶层拼写 ≠ 删叶子」的可读证据（A1 再从符号上核一遍）。

test("P3-a 扁平键写在 config 顶层 ⇒ 点名规位路径（不是「未知分组」）", async () => {
  for (const { key, home } of RETIRED) {
    const error = await directError({ config: { [key]: 1 } });
    assert.equal(error instanceof TypeError, true);
    assert.equal(
      error.message,
      `config.${key}: flat option keys are not accepted at the top of config`
        + ` (write config.${home} instead)`,
      "文案必须把宿主送到规位，而不是让他从分组名单里猜",
    );
  }
});

test("P3-b 叶子拼错 ⇒ 未知叶子 + 接受名单，且四个叶子都还在名单里", async () => {
  const error = await directError({ config: { metadata: { modelMetada: 1 } } });
  assert.equal(
    error.message,
    "unknown config.metadata option: \"modelMetada\""
      + ` (accepted: ${CONFIG_NAMESPACE_SCHEMA.metadata.join(", ")})`,
    "接受名单必须逐字等于 schema（四个叶子都在里面 ⇒ 删的是顶层拼写）",
  );
  for (const { home } of RETIRED) {
    assert.ok(CONFIG_NAMESPACE_SCHEMA.metadata.includes(home.split(".")[1]), `${home} 的叶子必须仍在 schema 里`);
  }
});

// ================================================================ P4. 这四个键都不是混装壳（机器派生）
//
// `context` / `retry` 这类壳同时容得下数据与函数，只指一站会把宿主送进第二次撞击。这四个键
// 没有行为成员 ⇒ 文案里不许出现第二站。判据不是散文，是 `capabilityDestinationsForShell` 的派生
// 结果：谁给它挂了行为成员，这一格立刻红。

test("P4 四个 metadata 数据键没有行为成员 ⇒ 文案只点一站；新家里的函数值直说「引擎没调用过它」", async () => {
  for (const { key, home } of RETIRED) {
    assert.deepEqual(
      capabilityDestinationsForShell(key),
      [],
      `${key} 不许有行为成员：一旦挂上，名称闸口的文案就必须同时点 capabilities.<group>.<leaf>（本格会红）`,
    );
    const error = await directError({ [key]: 1 });
    assert.equal(
      error.message.includes("capabilities."),
      false,
      "没有行为成员 ⇒ 不许在文案里塞第二站（那会把宿主送去做一件不存在的迁移）",
    );
    // 函数值写在新家里：`config` 只装数据，**且**引擎从来没调用过它（只把值转发出去）。
    // 第二句是本片工单的硬义务：别让宿主以为「这里不收函数 ⇒ 我丢了一项能力」。
    const [group, leaf] = home.split(".");
    const fnError = await directError({ config: { [group]: { [leaf]: () => {} } } });
    assert.equal(
      fnError.message,
      `config.${home} is not accepted: ${JSON.stringify(leaf)} is a function, and the config namespace`
        + " holds data only (the config subtree must survive a JSON round-trip unchanged)"
        + ` — there is no capability home for it: ${JSON.stringify(leaf)} is a data key of the config namespace`
        + " — the engine never calls it, it only forwards the value — so pass plain data"
        + " (host callbacks belong under capabilities.hooks.<name>)",
      "数据键里的函数值必须直说「没有能力面之家 + 引擎没调用过它」，不许含糊地指一个不存在的地方",
    );
  }
  // 对照组：真正的混装壳仍然一句话点两站（防「把这条提示整段删掉」也能绿）。
  const mixed = await directError({ context: { budgetTokens: 10 } });
  assert.match(mixed.message, /its canonical home is config\.folding\.context/u, "混装壳第一站：数据之家");
  assert.match(mixed.message, /capabilities\./u, "混装壳第二站：行为之家");
});

// ================================================================ P5. 边界：本刀没碰的面
//
// 三格：装配口 `policy.*`（#525 的面）、`expert` 的 fallback 链（`budget.js:87`）、同组大四件。

test("P5-a 装配口 policy.* 仍收这四个名字（#545 后它们**翻译**进 config 树）：构造期产物 + 真 run 都到", async () => {
  const provider = createFakeProvider(DONE);
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider,
    tools: { definitions: [], async executeTool() {} },
    session: { id: `metadata-a8-assembly-${process.pid}` },
    policy: {
      modelMetadata: { contextWindowTokens: 131072, maxOutputTokens: 8192 },
      expert: "policy-expert",
      requestId: "policy-req",
      toolContext: { tenant: "policy" },
    },
  });
  const policy = {
    modelMetadata: { contextWindowTokens: 131072, maxOutputTokens: 8192 },
    expert: "policy-expert",
    requestId: "policy-req",
    toolContext: { tenant: "policy" },
  };
  const produced = await assemblyPortOptions(port);
  for (const { key } of RETIRED) {
    // #545：`policy` 只收数据，叶子名一律翻译成规范路径（`policy.expert` → `config.metadata.expert`），
    // 于是同一个值仍然到得了引擎，只是不再以扁平名出现（那正是「第二拼写面」被关掉的样子）。
    assert.deepEqual(produced.config?.metadata?.[key], policy[key], `policy.${key} 必须翻译进 config.metadata.${key}`);
    assert.equal(Object.hasOwn(produced, key), false, `policy.${key} 不许再以扁平名出现在构造期产物里`);
  }
  // 真 run：端口交给引擎，预算元数据照旧被 `modelMetadataFor` 读到（不发 model_metadata_missing）。
  const events = [];
  await runDirect({
    provider: undefined,
    assemblyPort: port,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.deepEqual(
    events.filter((event) => event.type === "model_metadata_missing"),
    [],
    "装配口给的窗口数字仍被读（policy 面没被本刀收窄）",
  );
});

test("P5-b expert 的 fallback 链读侧不动：context.expert 仍生效，显式新家仍赢过它", async () => {
  // `budget.js:87` 是 `expert !== undefined ? expert : context?.expert`。本刀只改**写侧拼写**，
  // 所以 `config.folding.context.expert`（context 壳的规位）那条路径必须一字不变地仍然生效。
  let seen;
  await runDirect({
    provider: createFakeProvider(TOOL_ROUND),
    executeTool: async ({ context }) => {
      seen = context;
      return "ok";
    },
    tools: WORK_TOOL,
    maxRounds: 2,
    config: {
      folding: { context: { expert: "ctx-expert", requestId: "ctx-req", toolContext: { tenant: "ctx" } } },
    },
  });
  assert.equal(seen?.expert, "ctx-expert", "context.expert 的 fallback 必须仍然生效（读侧未动）");
  assert.equal(seen?.requestId, "ctx-req");
  assert.equal(seen?.tenant, "ctx");

  // 显式给新家 ⇒ 它赢过 fallback（与 `expert !== undefined ? … : context?.expert` 同口径）。
  let explicit;
  await runDirect({
    provider: createFakeProvider(TOOL_ROUND),
    executeTool: async ({ context }) => {
      explicit = context;
      return "ok";
    },
    tools: WORK_TOOL,
    maxRounds: 2,
    config: {
      metadata: { expert: "cfg-expert", requestId: "cfg-req", toolContext: { tenant: "cfg" } },
      folding: { context: { expert: "ctx-expert", requestId: "ctx-req", toolContext: { tenant: "ctx" } } },
    },
  });
  assert.equal(explicit?.expert, "cfg-expert", "config.metadata.expert 必须赢过 context.expert（同一条链）");
  assert.equal(explicit?.requestId, "cfg-req");
  assert.equal(explicit?.tenant, "cfg", "toolContext 两源合并时显式那一份在后（既有合并顺序）");
});

test("P5-c 同组大四件里仍未退役的那些：扁平写法照旧可用（A9 起派生）", async () => {
  for (const { key, home } of STILL_FLAT) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), true, `${key} 必须仍在白名单（还在等它自己那一片）`);
    assert.equal(configPathForOption(key), home, `${key} 的规位仍是 ${home}`);
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ [key]: "still-flat" });
    assert.equal(effectiveOptions[key], "still-flat", `扁平 ${key} 必须仍被接受`);
  }
  // #531：`session` 已不是「仍在等自己那一片」的键——它是第三站成员，嵌套家已被拆掉。
  assert.equal(STILL_FLAT.some(({ key }) => key === "session"), false, "`session` 不许再留在这张表里");
  assert.equal(configPathForOption("session"), undefined, "`session` 没有嵌套家（第三站）");
});

// ================================================================ F. 函数差异 as-is 钉（工单硬义务 ②）
//
// 事实（实测，不是推断）：**扁平写法今天收函数**（`session: () => 1` 通过、`typeof` 一路保持到工具
// 上下文），**规位拒**（`config.metadata.expert = () => 1` 当场抛）。本刀接受这条收窄，但必须把
// **差异本身**钉住：将来谁放宽了（规位开始收函数）或谁收紧了（扁平也开始拒函数），这一格都会红。
//
// #498 S3 A9：这条钉子原来挂在 `user` 上；`user` 退役后扁平写法不再收函数（名称闸口先抛），
// 所以钉子**原样搬到仍在扁平面上的 `session`**——不是放宽，是同一性质的现役实例。
// **#531**：`session` 仍是扁平（现在是第三站成员），所以「扁平收函数」那一半一字未改；
// 而 `config.metadata.session` 那个叶子被拆掉了，它的拒绝换成了**未知叶子 + 指向第三站**
// （钉在 A9 的 S3）。函数差异的那一半改挂到 `config.metadata.expert`——它仍在配置面、仍是数据键，
// 于是「规位拒函数、且文案说清引擎从没调用过它」这条判据仍有现役实例可钉。

test("F1 as-is：扁平 session 收函数且 typeof 保持到工具上下文，而规位（config.metadata.expert）拒", async () => {
  let seen;
  const result = await runDirect({
    provider: createFakeProvider(TOOL_ROUND),
    executeTool: async ({ context }) => {
      seen = context;
      return "ok";
    },
    tools: WORK_TOOL,
    maxRounds: 2,
    session: () => 1,
  });
  assert.equal(result.termination.reason, "end_turn", "扁平 session 今天必须收下函数值（as-is）");
  assert.equal(typeof seen?.session, "function", "函数值必须原样到达工具上下文（引擎不调用它，只转发）");
  assert.equal(seen.session(), 1, "同一份值仍可被**宿主自己的**工具调用（引擎从不调用它）");

  const rejected = await directError({ config: { metadata: { expert: () => 1 } } });
  assert.equal(rejected instanceof TypeError, true, "规位今天必须拒函数值（这就是那条收窄）");
  assert.match(rejected.message, /^config\.metadata\.expert is not accepted/u);
  assert.match(rejected.message, /the engine never calls it, it only forwards the value/u, "文案必须说清「没丢能力」");
});

test("F2 as-is：四个退役键的两种拒绝来自两道门，语义不重叠", async () => {
  for (const { key, home, value } of RETIRED) {
    // ① 扁平：名称闸口（连标量也拒）——拼写没了，不是值没了。
    const flat = await directError({ [key]: value });
    assert.match(flat.message, /^unknown runToolLoop option:/u, `${key}：扁平走名称闸口`);
    // ② 规位：函数 intake（只拒函数）——同一个值照旧收下。
    const [group, leaf] = home.split(".");
    const fn = await directError({ config: { [group]: { [leaf]: () => {} } } });
    assert.match(fn.message, new RegExp(`^config\\.${home} is not accepted`, "u"), `${key}：规位走函数 intake`);
    const ok = await normalizeRunToolLoopOptions({ config: atHome(home, value) });
    assert.deepEqual(ok.effectiveOptions[key], value, `${key}：规位收下同一个值`);
  }
});

// ================================================================ S. 建议噪声（本片特有的坑）
//
// 候选池 = **现役**白名单。`model` 与 `modelMetadata` 编辑距离很近，退役后如果还在池里，写错
// `modelMetadata` 的宿主会被建议成 `model`——那不是帮他，是把他送去另一个键。所以这一格钉的是
// **实测文案**：精确拼写不许出现 `did you mean`，且必须点名规位。

test("S1 写错 modelMetadata 不会被建议成 model：文案只点名规位（逐字）", async () => {
  for (const { key, home } of RETIRED) {
    assert.equal(optionSuggestion(key), undefined, `${key} 已不在候选池 ⇒ 不许给出任何建议`);
    const error = await directError({ [key]: 1 });
    assert.equal(error.message.includes("did you mean"), false, `${key} 的文案里不许出现建议（尤其不许是 "model"）`);
    assert.equal(
      error.message,
      `unknown runToolLoop option: ${JSON.stringify(key)} (its canonical home is config.${home};`
        + " the flat spelling is rejected)",
    );
  }
  // 对照组：建议机制本身仍在工作（防「整条建议逻辑被删掉」也能绿）。
  // #498 S3 A9：`model` 已退役 ⇒ 不再能拿 `modle` 当对照（候选池 = 现役白名单）；改用一直在池里的
  // `maxRound` → `maxRounds`。这不是放宽 S1 的主张（「精确拼写退役名 ⇒ 零建议」那半句一字未改），
  // 只是对照组换了活着的样本。
  // #498 S3 A21：`maxRounds` 自己也退役了 ⇒ 候选池里再没有它。换 `providr` → `provider`
  // （同样是「差一个字符就给建议」的活样本），主张一字未改。
  assert.equal(optionSuggestion("providr"), "provider", "对照组：`providr` 的近错仍被建议回 `provider`");
});

test("S2 候选池变化的 as-is：modelMetadata 的拼写错误现在没有任何建议，也没有规位可指", async () => {
  // 退役前 `modelMetada` 会被建议成 `modelMetadata`；退役后候选池里没有它，且拼写错误不是规位名
  // ⇒ 只剩「未知选项」原句。**如实钉住**（这是候选池变化的必然后果，不是缺陷）。
  for (const typo of ["modelMetada", "modelmetadata", "modleMetadata"]) {
    assert.equal(optionSuggestion(typo), undefined, `${typo} 不许被建议成任何现役键`);
    assert.equal(configPathForOption(typo), undefined, `${typo} 没有规位（它只是一个拼写错误）`);
    const error = await directError({ [typo]: 1 });
    assert.equal(error.message, `unknown runToolLoop option: ${JSON.stringify(typo)}`, `${typo}：只剩未知选项原句`);
  }
});

// ================================================================ R. 读侧不动（机制 + 行为）

test("R1 真 run：config.metadata.modelMetadata 被 `modelMetadataFor` 读到（不再发缺失诊断）", async () => {
  const events = [];
  await runDirect({
    provider: createFakeProvider(DONE),
    config: { metadata: { modelMetadata: { contextWindowTokens: 131072, maxOutputTokens: 8192 } } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.deepEqual(
    events.filter((event) => event.type === "model_metadata_missing"),
    [],
    "窗口数字被读到了（预算推得出来 ⇒ 不发缺失诊断）——这就是 modelMetadataFor 读侧不动的证据",
  );
  // 反面：不给 ⇒ 一条诊断（证明上一格不是「诊断本来就不发」）。
  const bareEvents = [];
  await runDirect({
    provider: createFakeProvider(DONE),
    capabilities: { hooks: { onEvent: (event) => bareEvents.push(event) } },
  });
  assert.equal(bareEvents.filter((event) => event.type === "model_metadata_missing").length, 1);
});

test("R2 真 run：toolContext / requestId / expert 逐字进入工具上下文", async () => {
  let seen;
  const result = await runDirect({
    provider: createFakeProvider(TOOL_ROUND),
    executeTool: async ({ context }) => {
      seen = context;
      return "ok";
    },
    tools: WORK_TOOL,
    maxRounds: 2,
    config: {
      metadata: {
        toolContext: { tenant: "a8", nested: { deep: [1, 2] } },
        requestId: "req-a8",
        expert: "backend",
      },
    },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(seen?.tenant, "a8", "toolContext 的成员被摊平进工具上下文（既有合并口径）");
  assert.deepEqual(seen?.nested, { deep: [1, 2] }, "嵌套结构逐字保留（只搬拼写，不做规范化）");
  assert.equal(seen?.requestId, "req-a8");
  assert.equal(seen?.expert, "backend");
});

test("R3 真 run：新家不给 ⇒ 工具上下文里没有这三个键（删键不许新造默认值）", async () => {
  let seen;
  await runDirect({
    provider: createFakeProvider(TOOL_ROUND),
    executeTool: async ({ context }) => {
      seen = context;
      return "ok";
    },
    tools: WORK_TOOL,
    maxRounds: 2,
  });
  for (const key of ["requestId", "expert", "tenant"]) {
    assert.equal(Object.hasOwn(seen ?? {}, key), false, `${key} 未给时不许出现（本刀不许新造默认值）`);
  }
});

// ================================================================ A. 账目格派生（不手抄键数）

test("A1 白名单 = 配置面 ∩ 白名单 + 能力面 + 第三站 + 容器，且 schema 自检为空", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const union = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.deepEqual(
    [...union].sort(),
    [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向闭合：每个顶层选项恰好落在一个家里（期望值从符号派生，不抄条数）",
  );
  assert.equal(new Set(union).size, union.length, "四个面不许重叠");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "schema 自检必须为空");
  // 四个键已离开白名单，但**叶子仍在 schema 里**（新家）；两边一起断言，防「删键顺手把叶子也删了」。
  for (const { key, home } of RETIRED) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), false, `${key} 必须已离开顶层白名单`);
    const [group, leaf] = home.split(".");
    assert.equal(
      CONFIG_NAMESPACE_SCHEMA[group].includes(leaf),
      true,
      `${key} 必须仍在 CONFIG_NAMESPACE_SCHEMA.${group} 里（删顶层键 ≠ 删叶子）`,
    );
    assert.equal(configPathForOption(key), home, `规位路径逐字为 ${home}`);
  }
  // 容器面必须是两个（`config` / `capabilities`）——四个键退役不许把容器也带走。
  assert.deepEqual(containers, [...NAMESPACE_CONTAINER_OPTION_NAMES], "两个容器都必须还在白名单里");
});

test("A3 配置面 25 → 21 的账：差集由符号派生，四个键各占一格", () => {
  // 「配置面」= schema 叶子映射到的顶层键里**仍在白名单**的那些（`configPlaneOptionNames`）。
  // 退役键 = schema 叶子 ∖ 白名单。两者相加恒等于 schema 叶子全集——删键只搬家，不删叶子。
  const retiredFlat = CONFIG_SURFACE_OPTION_NAMES.filter((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  const configPlane = configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES);
  assert.deepEqual(
    [...configPlane, ...retiredFlat].sort(),
    [...CONFIG_SURFACE_OPTION_NAMES].sort(),
    "「仍在白名单的配置键」+「已退役的配置键」= schema 叶子全集（一个不多、一个不少）",
  );
  assert.equal(
    configPlane.length + retiredFlat.length,
    CONFIG_SURFACE_OPTION_NAMES.length,
    "两边之和必须等于叶子全集（这就是 25 + 退役数 = 叶子总数的机器版）",
  );
  for (const { key } of RETIRED) {
    assert.ok(retiredFlat.includes(key), `${key} 必须出现在退役差集里（否则它没有真的离开白名单）`);
  }
  // 本片新增的退役键**恰好**是这四个（上一片的退役键仍在集合里，所以判据是「包含」+ 数量对账）。
  assert.deepEqual(
    RETIRED.map(({ key }) => key).filter((key) => !retiredFlat.includes(key)),
    [],
    "四个键都必须落在退役差集里",
  );
});

test("A2 本仓库 test/ 里不许再出现手抄的顶层键数（口径：`RUN_TOOL_LOOP_OPTION_NAMES.length, <数字>`）", () => {
  // 判据是「整个 test/ 里没有这个形状」，所以扫描**本文件自己**也算：下一片顺手抄个数字进来会在这里红。
  const testDir = fileURLToPath(new URL(".", import.meta.url));
  const handCopied = /RUN_TOOL_LOOP_OPTION_NAMES\.length,\s*\d/u;
  const assertHandCopied = /assert\.(equal|strictEqual)\([^)]*RUN_TOOL_LOOP_OPTION_NAMES\.length\s*,\s*\d/u;
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".js") || full.endsWith(".mjs") ? [full] : [];
  });
  const offenders = [];
  for (const file of walk(testDir)) {
    const source = readFileSync(file, "utf8");
    if (handCopied.test(source) || assertHandCopied.test(source)) offenders.push(file.slice(testDir.length));
  }
  assert.deepEqual(
    offenders,
    [],
    "断言里不许写手抄键数：条数一律从符号派生（`RUN_TOOL_LOOP_OPTION_NAMES.length` 与四个面的并集对账）",
  );
});
