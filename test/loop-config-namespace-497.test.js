// issue #497（S2）—— `config: { … }` 嵌套命名空间。
//
// 本文件钉住四件事，对应工单的四条验收判据：
//
//   A. **只有一张表**：`config.<group>.<leaf>` 是顶层扁平键的别名，叶子名逐字等于顶层键名
//      （`CONFIG_ALIAS_PATHS` 从 `CONFIG_NAMESPACE_SCHEMA` 机械派生）。`configSchemaSelfCheck`
//      对着 `RUN_TOOL_LOOP_OPTION_NAMES` 核「每个顶层选项恰好落在配置面或能力面之一」——
//      往白名单加一个键却忘了分类 ⇒ 这里红。
//      **#517 单向化**：这条恒等式只说「每个顶层选项 → 恰好一个家」，不说「每个叶子 ⇔ 一个顶层
//      键」。A3 的方向② 因此从「红」翻成「绿」——一个 `config` 叶子可以没有对应的顶层选项
//      （S3 删完顶层扁平配置键之后的形状）。**#498 S3（`timing` 切片）之后本文件不再手抄任何
//      顶层总数**：四个数全部从符号派生（见 A1）。
//   B. **结构等价**（判据 1）：同一份配置写成扁平形态与 `config` 形态，`effectiveOptions` 逐键
//      深度相等。两层：43 个配置键**逐个**扫一遍（`expandConfigNamespace`，机械穷举），
//      再加一份跨 7 个分组的**端到端** `normalizeRunToolLoopOptions` 对比（走真闸口）。
//      断言一律 `deepStrictEqual` / `assert.equal`，不用 `toBeTruthy` 糊。
//   C. **优先级与冲突**（判据 2）：同名时 `config.*` 赢，且发一条 `config_override_conflict` 事件。
//      优先级不只比对象：真跑一次两轮 run，`maxRounds` 扁平 1 / config 2 ⇒ `end_turn`
//      （扁平赢的话会是 `max_rounds_cap`）。冲突事件在「值相同」「只给一边」时**不发**。
//   D. **能力面不收配置覆盖**（判据 3）：22 个能力键写进 `config`（顶层或组内）⇒ 启动即抛，
//      报错点名该键，`error.via` 按入口路线是 `direct` / `assembly`。**既有「显式细粒度选项覆盖
//      装配口同名成员」语义不动**（`resolveAssemblyMember`（`src/assembly.js`））：
//      `test/contract/assembly-port.js` 的「显式细粒度 provider 覆盖端口 provider」照旧绿。
//      **能力面的判据是行为面不是「引擎不解释」**（#497 复审 R1）：A4 用行为证据钉住按新判据
//      改归的四个键（`persistence` / `model` / `modelMetadata` / `session`）确实被引擎读。
//      `runId` / `cwd` 在**配置面**（`config.run.*`）：第二轮裁决取消了上一轮给判据加的
//      「身份/环境注入」那条腿，理由见 `src/loop/config-namespace.js` 文件头约束 3（判据要机械
//      可检验 + 0.28 的「`config` 子树过 JSON round-trip 等值」要求能力面只剩函数/端口对象）。
//   E. **#496 的语义相闸口吃的是展开后的表示**（判据 5）：`config.folding.context` 里拼错的旋钮名
//      抛的错与扁平 `context` 里拼错的**同一句**，只差 `via` 标签。
//
// mutation 自证（改的是**代码行**不是注释；五个变异的实测红单见交付报告 /tmp/i497-report.md）：
//   · M1 优先级反转（`expanded[key] = value` → `if (flatValue === undefined) …`）⇒ 4 红：
//     B1（含「迁移场景」断言）/ C1 / C2 / G2；
//   · M2 config 值不落地（同一行改成 `void flatValue`）⇒ 8 红：B1 / B2 / C1 / C2 / E1 / E2 / E4 / G2；
//   · M3 顶层能力键分支降级成 `continue` ⇒ 3 红：D1 / D3 / F3；
//   · M4 `assertConfigNamespace` 的 `throw` 降级成 `return` ⇒ 6 红：D1 / D2 / D3 / F1 / F2 / F3；
//   · M5 `notifyConfigOverrideConflicts` 的 `onEvent?.({…})` 整块换成 `void configConflicts`
//     ⇒ 2 红：C2（事件恰一条）/ C4（观察者隔离）。
//
// issue #497 复审的六条必改又加了三个变异（改的同样是**代码行**；实测红单见
// /tmp/i497fix-report.md）：
//   · M6（R1）把能力键 `provider` 偷偷塞回配置面（`CONFIG_NAMESPACE_SCHEMA.run` 首项）
//     ⇒ 5 红：A1 / A2 / A3 / B1 / F1——自检与枚举两侧同时红；
//   · M7（R4）把逐叶事件降级成 `void collectConfigSourceConflicts(…)`（算而不发）
//     ⇒ 1 红：C6（「冲突事件恰一条」实测 0 !== 1）；
//   · M8（R3）把 JSDoc 的 `tuning?:` 改成假组名 `reflection?:` ⇒ `npm run check:release` 第 4 步
//     （真实 TS 宿主）红：宿主 `config.tuning` 报 `TS2353: … 'tuning' does not exist in type …`。
//     **但那条锁以前只在 node 22 那一档跑**（CI 里 `check:release` 只跑一档），`npm test` 与
//     `check:types-build` 都不红；第二轮复审补了 **H1**（默认套件里扫 `config?:` 的 JSDoc 文本，
//     组名集合必须恰等于 `Object.keys(CONFIG_NAMESPACE_SCHEMA)`），同一个变异现在 `npm test` 就红。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAssemblyPort } from "../src/assembly.js";
import {
  CAPABILITY_OPTION_NAMES,
  CONFIG_ALIAS_PATHS,
  CONFIG_LEAF_ALIAS_PATHS,
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_OPTION_NAME,
  CONFIG_NAMESPACE_SCHEMA,
  CONFIG_SURFACE_OPTION_NAMES,
  NAMESPACE_CONTAINER_OPTION_NAMES,
  optionHomeBuckets,
  collectConfigNamespaceProblems,
  collectConfigSourceConflicts,
  configPathForOption,
  configPlaneOptionNames,
  configSchemaSelfCheck,
  expandConfigNamespace,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  assertRunToolLoopOptionNames,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect as sharedRunDirect, withSeed } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

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

/** 直连路线的「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => runDirect(extra).then(() => null, (error) => error);

/** 装配口路线：`policy` 在构造期过闸口，`config` 在合并后过同一道展开。 */
function makePort(policy = {}, { emit } = {}) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: createFakeProvider(DONE),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: `config-497-${process.pid}` },
    ...(emit === undefined ? {} : { emit }),
    policy,
  });
}

/** 装配口路线：跑一次（构造期或合并后抛都算——构造期是同步抛，必须在这里接住）。 */
const assemblyError = async (policy = {}) => {
  let port;
  try {
    port = makePort(policy);
  } catch (error) {
    return error;
  }
  return runToolLoop({ assemblyPort: port }).then(() => null, (error) => error);
};

// ================================================================ A. 只有一张表（派生，不是手抄）
test("A1 schema 自检：白名单被四个面恰好切一遍（配置面 / 能力面 / 第三站 / 容器），自检 []", () => {
  // #498 S3：这里原本手抄四个字面总数（顶层 / 配置面 / 能力面 / 容器）。删掉 `timing` 组的三个
  // 顶层键之后，配置面那一项自动少三个，于是四个数字必须手追——那正是本刀要杀的东西。
  // 现在钉的是**更强的一句**，而且一个总数都不用抄：
  //   ① 四个面的并集与白名单**逐键相等**（不是比条数，是比集合）；
  //   ② 四个面两两不相交（一个键只许有一个家）。
  // 这两条合起来就是「闭合」的全部内容，且与具体条数无关。
  // #527 把「永久顶层面（第三站）」作为第四个桶：`tools` 从配置面拆出后必须落在这里，否则
  // 「配置面 + 能力面 + 容器」只剩 49 个键，第一句就会红。
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(
    new Set(partition).size,
    partition.length,
    "四个面之间不许重叠（同一个键落在两个家里，展开时就会有一个静默盖掉另一个）",
  );
  assert.deepEqual(
    [...partition].sort(),
    [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四面并集必须逐键等于白名单（漏一个、多一个都算红；不靠条数自证）",
  );
  // 配置面那一项 = 叶子总数 − 失去顶层键的叶子（派生；S3 之后这个差非空，这是设计）。
  const orphanLeaves = CONFIG_SURFACE_OPTION_NAMES.filter(
    (name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name),
  );
  assert.equal(
    configPlane.length,
    CONFIG_SURFACE_OPTION_NAMES.length - orphanLeaves.length,
    "configPlaneOptionNames 就是「叶子映射到的键里白名单仍有的那些」，差集是失去顶层键的叶子",
  );
  // #498 S3：失去顶层键的叶子**逐个**核「它还有家、而且拒绝文案点名那个家」。
  // 这一格从「手抄已切片的组名」改成**派生的行为判据**（遍历 `orphanLeaves`，不抄组名、不抄条数）：
  // 切片的验收标准本来就是「旧写法被拒 + 文案指向新家」，而组名/条数只是某一刀的临时记账。
  // 于是下一片（`input` 组的其余键、`system` / `tools` / `wrapup` …）**一行都不用改这里**；
  // 真正会红的是「删了顶层键却没给宿主指路」——那才是宿主升级时唯一的救命索。
  for (const key of orphanLeaves) {
    const home = configPathForOption(key);
    assert.equal(typeof home, "string", `${key} 失去顶层键之后必须仍有 config 家（否则删键 = 丢旋钮）`);
    let rejected;
    try {
      assertRunToolLoopOptionNames({ [key]: null });
    } catch (error) {
      rejected = error;
    }
    assert.equal(rejected instanceof TypeError, true, `${key} 的扁平写法必须被名称闸口当场拒`);
    assert.match(
      rejected.message,
      new RegExp(`its canonical home is config\\.${home.replace(".", "\\.")};`, "u"),
      `${key} 的拒绝文案必须点名 config.${home}（宿主从 0.26 升级时靠它找到新家）`,
    );
  }
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(CONFIG_NAMESPACE_OPTION_NAME), true);
});

test("A2 别名 = schema 路径：每个配置键恰好一条路径，叶子名逐字等于顶层键名（唯一例外见别名表）", () => {
  assert.equal(CONFIG_ALIAS_PATHS.size, CONFIG_SURFACE_OPTION_NAMES.length, "一个配置键一条路径，不多不少");
  for (const key of CONFIG_SURFACE_OPTION_NAMES) {
    const path = configPathForOption(key);
    assert.equal(typeof path, "string", `${key} 必须有 schema 路径`);
    const [group, leaf] = path.split(".");
    // #498 S4b：叶子名逐字等于键名是**规则**，唯一例外是 `input.messages` → `initialMessages`。
    // 例外必须是**显式登记的**那一条（`CONFIG_LEAF_ALIAS_PATHS`），不是「谁都能改名」。
    const registered = CONFIG_LEAF_ALIAS_PATHS[group]?.[leaf];
    if (registered === undefined) {
      assert.equal(leaf, key, `${key} 的路径叶子必须逐字等于键名（不许重命名）`);
    } else {
      assert.equal(registered, key, `${group}.${leaf} 的登记别名必须是 ${key}`);
    }
    assert.equal(CONFIG_ALIAS_PATHS.get(path), key, `${path} 必须展开回 ${key}`);
    // 分组名必须是真的分组，且该组确实声明了这个叶子（派生关系的反向核对）。
    assert.equal(CONFIG_NAMESPACE_GROUPS.includes(group), true, `${group} 必须是已知分组`);
    assert.equal(CONFIG_NAMESPACE_SCHEMA[group].includes(leaf), true, `${group} 必须声明 ${leaf}`);
  }
  // 例外表只有一条（本刀主 agent 裁决的那条）——长成第二张重命名表就不再有「别名 = schema 路径」。
  assert.deepEqual(Object.entries(CONFIG_LEAF_ALIAS_PATHS), [
    ["input", { messages: "initialMessages" }],
  ], "叶子别名表只许有一条记录（`input.messages` → `initialMessages`）");
  // 能力面一个都不在配置面里（交叉核对，不靠「我记得」）。
  const surface = new Set(CONFIG_SURFACE_OPTION_NAMES);
  for (const name of CAPABILITY_OPTION_NAMES) {
    assert.equal(surface.has(name), false, `${name} 是能力键，不能出现在配置面`);
  }
  // 反向（第二轮裁决的落地形状，逐条点名，免得「悄悄移回能力面」也没人红）。
  for (const name of ["runId", "cwd"]) {
    assert.equal(configPathForOption(name), `run.${name}`, `${name} 必须落在 config.run`);
    assert.equal(CAPABILITY_OPTION_NAMES.includes(name), false, `${name} 不得再出现在能力面`);
  }
});

test("A3 自检会咬人：漏分类 / 漏容器必须红；叶子失去顶层键必须绿（#517 单向化）", () => {
  // 方向①：白名单多出一个没分类的键（「加了选项忘了分类」的真实形状）。
  const extra = configSchemaSelfCheck([...RUN_TOOL_LOOP_OPTION_NAMES, "brandNewKnob"]);
  assert.deepEqual(extra, [
    'top-level option "brandNewKnob" is classified nowhere'
      + " (config surface / capability list / top-level surface)",
  ]);
  // 方向②（#517 翻转）：一个真叶子的顶层键从白名单里消失 ⇒ **必须绿**。
  // 这正是 S3 删完顶层扁平配置键之后 `config.run.maxRounds` 的形状：叶子还在、顶层键没了。
  // 以前这一格报两条红（`config.run.maxRounds maps to "maxRounds", which is not a top-level option`
  // + `schema names "maxRounds", which is not a top-level option`），于是「改闸口」与「删键」
  // 被迫塞进同一刀——#498 S4c 已为这个付过一次真实返工。
  const droppedOptionNames = RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => name !== "maxRounds");
  assert.deepEqual(
    configSchemaSelfCheck(droppedOptionNames),
    [],
    "叶子还在、顶层键没了 = S3 的形状，自检必须放行（恒等式只单向：每个顶层选项→恰好一个家）",
  );
  // 放行的那一半由另一条锁兜住，不是「什么都没核」：配置面因此少一格（派生：叶子总数 − 失去
  // 顶层键的叶子），叶子仍在 schema 里（round-trip 覆盖度在 S7 逐叶子核，见
  // test/loop-capabilities-namespace-498.test.js）。
  const configPlane = configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES);
  assert.equal(
    configPlane.length,
    CONFIG_SURFACE_OPTION_NAMES.length
      - CONFIG_SURFACE_OPTION_NAMES.filter((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name)).length,
    "本刀的配置面 = 叶子总数 − 失去顶层键的叶子（派生，不手抄）",
  );
  assert.equal(configPlaneOptionNames(droppedOptionNames).length, configPlane.length - 1, "少掉的就是那一个失去顶层键的叶子");
  assert.equal(
    configPlaneOptionNames(droppedOptionNames).includes("maxRounds"),
    false,
    "configPlaneOptionNames 就是「配置面里真的还是顶层选项的那些键」",
  );
  assert.equal(
    CONFIG_SURFACE_OPTION_NAMES.includes("maxRounds"),
    true,
    "叶子仍在 schema 里（它不是被删掉的叶子，只是丢了顶层键）",
  );
  // 方向③：白名单里没有 `config` 这个容器本身（「把容器当成配置键删掉」）。
  // #498 S4a：容器是复数，两个都要在——`capabilities` 那一条在 `test/loop-capabilities-namespace-498.test.js`
  // 的 S1b 里同形钉住（这里只保留本单自己的那一半）。
  const noContainer = configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => name !== "config"));
  assert.deepEqual(noContainer, [
    'top-level options do not accept "config" (a namespace container)',
  ]);
  // 方向④（#517 新增）：能力面那一半的单向性**没有**跟着松——能力面叶子必须是真顶层选项
  // （S1b 已逐条钉住，这里只锁一句「配置面放行、能力面仍红」的对照，免得哪天把两边一起改成单向）。
  assert.deepEqual(
    configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES.filter((name) => name !== "onJudge")),
    [
      'capabilities.hooks names "onJudge", which is not a top-level option',
      'schema names "onJudge", which is not a top-level option',
    ],
    "能力面叶子没有顶层键仍然必须红（#517 只改配置面那一条方向）",
  );
});

// #498 S4b 复审：自检的**别名表**那一段（「登记了别名的叶子必须真存在」「不许映射到已存在的叶子名」）
// 原先一格测试都没有——把整段删掉，全量仍然 EXIT=0 全绿，而 CHANGELOG 声称「自检双向核它」。
// 这格把它钉住：用自检的注入钩子把三条分支逐条弄成可达的（生产调用不传这个参数，
// 拿到的是真的 `CONFIG_LEAF_ALIASES`），于是删掉那一段 ⇒ 本格红。
test("A3b 自检的别名表那一段会咬人：改名撞到本组已有叶子 / 未知分组 / 不是该组叶子", () => {
  // 方向①（本单声称的那条）：别名把 `input.messages` 改成一个本组**已有**的叶子名（`system`）
  // ⇒ 同一个键会有两个写法，「别名 = schema 路径」退化成重命名表。
  assert.deepEqual(
    configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES, { leafAliases: { input: { messages: "system" } } }),
    ["leaf alias input.messages renames to system, which is already a leaf name"],
  );
  // 方向②：别名表里写了不存在的分组。
  assert.deepEqual(
    configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES, { leafAliases: { nope: { messages: "initialMessages" } } }),
    [
      'leaf alias table names unknown group "nope"',
      "leaf alias nope.messages is not a leaf of that group",
    ],
  );
  // 方向③：别名键不是该组的叶子（「给一个不存在的叶子登记了改名」）。
  assert.deepEqual(
    configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES, { leafAliases: { input: { nope: "initialMessages" } } }),
    ["leaf alias input.nope is not a leaf of that group"],
  );
  // 注入钩子只换表、不换语义：真正的表仍然 []（否则这格就变成了「自检被测试改松了」）。
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
});

// issue #497 复审 R1：能力面的判据从「引擎不解释其值」（**假**）改成「宿主提供的行为载体 /
// 身份环境，引擎调用或解引用它」，于是四个**被引擎读**的键从能力面移回配置面：
// `persistence` → `config.run`（与同族 `partialPersistence` / `replayPolicy` 同组）、
// `model` / `modelMetadata` / `session` → `config.metadata`。下面四条是**行为证据**（不是
// 「展开了但没人读」）：每一条都让引擎因为读了这个键而做出可观测的不同决定。
test("A4 按新判据改归的四个键真被引擎读：persistence / modelMetadata / model / session 的行为证据", async () => {
  // ① `persistence`：字面量被校验，并决定「要不要走 required 的 store 方法校验」这条路径。
  const noneMode = await runDirect({
    store: {},
    config: { run: { persistence: "none" } },
  });
  assert.equal(noneMode.termination.reason, "end_turn", "persistence:none 时不要求 store 有方法");
  const requiredError = await directError({ store: {}, config: { run: { persistence: "required" } } });
  assert.match(requiredError.message, /required persistence store is missing methods: store\.appendRound, store\.load/u);
  const badLiteral = await directError({ config: { run: { persistence: "always" } } });
  assert.match(badLiteral.message, /persistence must be "none" or "required"/u);

  // ② `modelMetadata` / ③ `model`：窗口数字被读去算预算 ⇒ 有它就没有 model_metadata_missing 事件。
  const missingWithout = [];
  await runDirect({ onEvent: (event) => missingWithout.push(event) });
  assert.equal(
    missingWithout.filter((event) => event.type === "model_metadata_missing").length,
    1,
    "样本自证：不给窗口数字时这条诊断事件确实会发",
  );
  for (const key of ["modelMetadata", "model"]) {
    const events = [];
    await runDirect({
      config: { metadata: { [key]: { contextWindowTokens: 100000, maxOutputTokens: 1024 } } },
      onEvent: (event) => events.push(event),
    });
    assert.deepEqual(
      events.filter((event) => event.type === "model_metadata_missing"),
      [],
      `${key} 里的窗口数字被读了（预算推得出来，所以不再告警）`,
    );
  }

  // ④ `session`：已知字段 `id` 被校验、`modelSlot` 被读来解析模型。
  // #531：`session` 是**第三站**成员（顶层选项与装配口成员同一个值），所以写点回到扁平拼写；
  // `config.metadata.session` 现在是未知叶子当场拒（那半由 A9 的 S3 钉住）。
  const sessionWithoutId = await directError({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    session: {},
  });
  assert.match(sessionWithoutId.message, /assembly port is missing methods: session\.id/u);
  const withSession = await runDirect({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    session: { id: `config-497-a4-${process.pid}`, modelSlot: "default" },
  });
  assert.equal(withSession.termination.reason, "end_turn");
});

// 第二轮裁决的落地形状：`runId` / `cwd` 从能力面移到 `config.run`。别名不是死键——这两条是**行为证据**
// （run_outcome 的 `runId` 与 `finalGuard` 载荷的 `cwd` 都来自 config 里写的那份），外加「不给就不写假值」
// 的对照组（与顶层扁平键同口径）。
test("A5 移到配置面的 runId / cwd 真被引擎读：run_outcome 的 runId 与 finalGuard 载荷的 cwd", async () => {
  const events = [];
  let payload;
  const result = await runDirect({
    // #498 S3（`metadata` A8）：预算元数据的写点已搬进规位 `config.metadata.modelMetadata`；
    // 并进**同一个** `config` 容器（第二个 `config` 键会静默盖掉 `run.runId` / `run.cwd`）。
    config: {
      metadata: { modelMetadata: { contextWindowTokens: 100000, maxOutputTokens: 1024 } },
      run: { runId: "config-497-runid", cwd: "/tmp/config-497-cwd" },
    },
    finalGuard: async (captured) => {
      payload = captured;
      return { action: "accept" };
    },
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.termination.reason, "end_turn");
  const outcome = events.filter((event) => event.type === "run_outcome");
  assert.equal(outcome.length, 1, "样本自证：run_outcome 恰一条");
  assert.equal(outcome[0].runId, "config-497-runid", "config.run.runId 被读（不是死别名）");
  assert.equal(payload?.runId, "config-497-runid");
  assert.equal(payload?.cwd, "/tmp/config-497-cwd", "config.run.cwd 进 finalGuard 载荷");

  // 对照：不给这两个键 ⇒ 两个字段都缺省（与扁平键「没给就不编造字段」同口径）。
  const bareEvents = [];
  let barePayload;
  await runDirect({
    config: { metadata: { modelMetadata: { contextWindowTokens: 100000, maxOutputTokens: 1024 } } },
    finalGuard: async (captured) => {
      barePayload = captured;
      return { action: "accept" };
    },
    onEvent: (event) => bareEvents.push(event),
  });
  assert.equal(Object.hasOwn(bareEvents.filter((event) => event.type === "run_outcome")[0], "runId"), false);
  assert.equal(Object.hasOwn(barePayload, "cwd"), false);
});

// ================================================================ B. 结构等价（判据 1）
test("B1 42 个配置键逐个穷举：config.<group>.<leaf> 展开后与扁平形态逐键深度相等", () => {
  let covered = 0;
  for (const key of CONFIG_SURFACE_OPTION_NAMES) {
    const path = configPathForOption(key);
    const [group, leaf] = path.split(".");
    const value = `sweep:${key}`;
    const flat = { [key]: value };
    const nested = { config: { [group]: { [leaf]: value } } };
    const flatExpanded = expandConfigNamespace(flat);
    const nestedExpanded = expandConfigNamespace(nested);
    assert.deepEqual(nestedExpanded.conflicts, [], `${path} 只给一边时不该有冲突`);
    assert.deepEqual(nestedExpanded.options, flatExpanded.options, `${path} 展开后必须与扁平形态逐键相等`);
    assert.deepEqual(nestedExpanded.options, flat, `${path} 展开后必须回到扁平形态`);
    assert.equal(Object.hasOwn(nestedExpanded.options, "config"), false, `${path} 展开后 config 必须消失`);
    // 迁移场景（等价 + 优先级同一条断言）：这个键以前写在扁平、现在挪到 config，其余照旧 ⇒
    // 展开结果必须与「只用扁平新值」逐键相等。优先级反转（让扁平赢）会在这里红。
    const mixed = expandConfigNamespace({ [key]: `stale:${key}`, config: { [group]: { [leaf]: value } } });
    assert.deepEqual(mixed.options, flat, `${path} 混合写法（扁平旧值 + config 新值）必须等于只用扁平新值`);
    assert.deepEqual(mixed.conflicts, [{ path, key }], `${path} 混合写法必须记一条冲突`);
    covered += 1;
  }
  assert.equal(covered, CONFIG_SURFACE_OPTION_NAMES.length, "穷举必须覆盖全部配置叶子（漏一个就少一条等价证明）");
});

/** 跨 7 个分组的代表性配置：同一个 `VALUES` 同时生成扁平形态与 config 形态。 */
const VALUES = {
  // #498 S3 A6：`system` 已退役扁平写法，样本搬到 `RETIRED_FLAT_VALUES`。
  // #498 S3 A2b：`initialUserMessage` 已退役扁平写法，样本搬到 `RETIRED_FLAT_VALUES`。
  wrapup: false,
  // #527：`tools` 已拆出配置面（永久顶层面），不再属于这份配置样本。
  maxRounds: 3,
  maxTokenContinuations: 2,
  stallDetection: false,
  completion: false,
  // #498 S3 (`run` slice A11): `replayPolicy` / `invalidArguments` / `writeToolNames` /
  // `writeToolPathKeys` are no longer flat top-level keys — they moved to `RETIRED_FLAT_VALUES` below
  // (their home is `config.run.*`).
  partialPersistence: false,
  outputHygiene: false,
  resume: false,
  stream: false,
  // #498 S3 (`tuning` slice, segment A5): `maxTokens` / `temperature` / `topP` are no longer flat
  // top-level keys — they moved to `RETIRED_FLAT_VALUES` below (their home is `config.tuning.*`).
  // #498 S3 (`tuning` slice): `cacheCapable` is no longer a flat top-level key — it moved to
  // `RETIRED_FLAT_VALUES` below (its home is `config.tuning.cacheCapable`).
  reflection: false,
  // #498 S3 (`guard` slice): `finalGuardMaxRetries` / `finalGuardTimeoutMs` / `finalGuardExtend` are no
  // longer flat top-level keys — they moved to `RETIRED_FLAT_VALUES` below (their home is
  // `config.guard.*`). `finalGuard` (the hook) stays: its home is `capabilities.hooks.finalGuard`.
  // #498 S3 (`metadata` slice, segment A8): `expert` / `requestId` / `toolContext` /
  // `modelMetadata` are no longer flat top-level keys — they moved to `RETIRED_FLAT_VALUES` below
  // (their home is `config.metadata.*`).
  // #498 S3 A9: `user` and `model` moved there as well (same group, same tree). `task` stays.
  // #531: `session` left `config.metadata` entirely — it is a third-station member (its top-level
  // option and the assembly port's member are the same value), so it has **no** nested home and is
  // therefore not part of the two-shape comparison (see A4 ④ for its behavioural evidence).
  // issue #497 复审 R1：按新判据从能力面移回配置面的四个键（端到端等价也要覆盖它们）；
  // 第二轮又从能力面移入两个字符串标量 `runId` / `cwd`（`config.run.*`）。
  persistence: "none",
  runId: "config-497-run",
  cwd: "/tmp/config-497",
  // #498 S4a：这里曾有 8 个 `on*: () => {}`——`config.observers` 整组删除后它们不再是配置叶子
  // （回调的规范之家是 `capabilities.hooks`，见 `test/loop-capabilities-namespace-498.test.js`）。
};

/**
 * #498 S3：扁平写法已退役的配置键的**代表性取值**（按顶层键名索引）。
 *
 * 与 `VALUES` 的分工：`VALUES` 只装「仍能扁平写」的键，这张表装「只能写在新家里」的键。
 * **哪一批属于后者不由这张表声明**——它从来源符号派生：
 * `CONFIG_SURFACE_OPTION_NAMES` 里已经不在 `RUN_TOOL_LOOP_OPTION_NAMES` 里的那些键
 * （见 `RETIRED_FLAT_KEYS`）。B2 开头断言两边**键集逐字相等**，于是：
 *   · 「删了顶层键却忘了给它一个代表性取值」⇒ 红（不会静默漏测）；
 *   · 下一片垂直切片（`input` / `system` / `tools` …）**不需要改这一段的判断逻辑**，
 *     新退役的键自动进入派生集合，只要补一条取值即可。
 * 这也正是「账目格派生化」的落点：判据比的是符号，不是手抄的组名或条数。
 */
const RETIRED_FLAT_VALUES = {
  // #498 S3（`timing` 片）
  timeoutMs: 1000,
  deadlineMs: 2000,
  retry: false,
  // #498 S3（`folding` 片）
  context: { budgetTokens: 1000, keepRounds: 2 },
  toolResultTtl: 1,
  toolResultFoldMinTokens: 10,
  // #498 S3（`input` 组 A 段）：`cacheStablePrefix` + 唯一那条登记别名 `input.messages`
  cacheStablePrefix: false,
  initialMessages: [],
  // #498 S3（`input` 组 A2b 段）：`initialUserMessage`——种子首轮消息。
  initialUserMessage: "go",
  // #498 S3（`input` 组 A6 段）：`system`——系统提示。标量 ⇒ 扁平写法一退役就只剩
  // `config.input.system` 一个家；展开相仍逐字写回 `effectiveOptions.system`（读侧一行未改）。
  system: "you are a test",
  // #498 S3（`tuning` 片）：`cacheCapable`——缓存友好端点的开关（引擎据此默认关掉工具结果 TTL 折叠）。
  cacheCapable: false,
  // #498 S3（`tuning` 片 A5 段）：三个采样/输出预算旋钮。它们是**标量**，所以扁平写法一退役就只剩
  // `config.tuning.*` 一个家；展开相仍逐字写回 `effectiveOptions.maxTokens` / `.temperature` / `.topP`
  // （引擎请求组装读的就是它们，读侧一行未改）。
  maxTokens: 512,
  temperature: 0.2,
  topP: 0.9,
  // #498 S3（`guard` 片）：强制收尾的三个数据旋钮（hook 本体 `finalGuard` 不在此——它属能力面）。
  finalGuardMaxRetries: 1,
  finalGuardTimeoutMs: 5000,
  finalGuardExtend: false,
  // #498 S3（`metadata` 组 A8 段）：四个小键。`expert` / `requestId` 是标量，`toolContext` /
  // `modelMetadata` 是**结构已知的对象**（`budget.js` 的 `modelMetadataFor` / `toolContextFor`
  // 读的就是它们，读侧一行未改）。扁平写法一退役就只剩 `config.metadata.*` 一个家。
  expert: "expert",
  requestId: "req-497",
  toolContext: { a: 1 },
  modelMetadata: { contextWindowTokens: 100000, maxOutputTokens: 1024 },
  // #498 S3 A9：`user`（不透明身份载荷，`toolContextFor` 只转发、引擎从不调用）。
  user: { id: "user-497" },
  // #498 S3 A9：`model`——`modelMetadataFor`（`budget.js`）仍从展开后的 `effectiveOptions.model`
  // 读窗口数字（读侧一行未改）。
  model: { contextWindowTokens: 100000, maxOutputTokens: 1024 },
  // #498 S3 A9：`task`——judge 简报 / 工具上下文 / `finalGuard` 的 `taskBrief` 都从展开后的
  // `effectiveOptions.task` 读（`task-brief.js` 只做字符串检查），读侧一行未改。
  task: "task-497",
  // #498 S3（`run` 片 A11 段）：`run` 组的小四件。两个**枚举标量**（引擎只认两个字面量）、
  // 两个**名字数组**（`string[]`，元素不是子键）。扁平写法一退役就只剩 `config.run.*` 一个家；
  // 展开相仍逐字写回 `effectiveOptions.replayPolicy` / `.invalidArguments` /
  // `.writeToolNames` / `.writeToolPathKeys`（读侧一行未改：resume 重放分支、引数裁决、
  // judge 的写工具集与路径键优先级）。
  replayPolicy: "per-tool-declaration",
  invalidArguments: "execute",
  writeToolNames: ["writeFile"],
  writeToolPathKeys: ["path"],
};

/** 扁平写法已退役的配置键（**派生**：配置面叶子映射到的顶层键里，已不在白名单的那些）。 */
const RETIRED_FLAT_KEYS = CONFIG_SURFACE_OPTION_NAMES
  .filter((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));

/** 把 `VALUES` 摊成 `config: { … }` 形态（分组/叶子从 schema 派生，不手写）。 */
function nestedConfigShape(values) {
  const config = {};
  for (const [key, value] of Object.entries(values)) {
    const path = configPathForOption(key);
    // #531: a third-station member (`session`) has no nested home by definition, so it is skipped
    // rather than asserted — the assertion that it has none lives in the A9 slice test (S3).
    if (path === undefined) continue;
    assert.equal(typeof path, "string", `${key} 必须有 schema 路径`);
    const [group, leaf] = path.split(".");
    config[group] = { ...(config[group] ?? {}), [leaf]: value };
  }
  return config;
}

test("B2 端到端结构等价：扁平形态与 config 形态规范化后的 effectiveOptions 逐键深度相等", async () => {
  // #498 S3：一批配置键不再有扁平写法，所以对照分两步：
  //   ① 仍可扁平写的那些键：扁平形态 vs config 形态逐键深度相等；
  //   ② 已退役的键：config 形态展开后必须**逐字写回** `effectiveOptions.<扁平名>`（这就是
  //     「删了顶层键、引擎读侧不用改」的机制本身，也是本刀可行性的证据）。
  // 「哪些键已退役」是派生集合（`RETIRED_FLAT_KEYS`），不是手抄的组名：这一片删的是 `input` 组
  // 的两个键，上一片删的是 `timing` / `folding`，判据一字未改。
  assert.deepEqual(
    Object.keys(RETIRED_FLAT_VALUES).sort(),
    [...RETIRED_FLAT_KEYS].sort(),
    "退役键的取值表必须与派生集合逐字相等（删了顶层键却没给取值 ⇒ 这里红，不静默漏测）",
  );
  const nestedConfig = nestedConfigShape({ ...VALUES, ...RETIRED_FLAT_VALUES });
  assert.deepEqual(Object.keys(nestedConfig).sort(), [...CONFIG_NAMESPACE_GROUPS].sort(), "全部分组都被这份样本覆盖");

  const flat = await normalizeRunToolLoopOptions({ ...VALUES });
  const nested = await normalizeRunToolLoopOptions({ config: nestedConfig });

  // ② 退役键：展开相逐字写回扁平名；扁平形态里**没有**它们（写法确实撤了）。
  for (const key of RETIRED_FLAT_KEYS) {
    assert.deepEqual(
      nested.effectiveOptions[key],
      RETIRED_FLAT_VALUES[key],
      `${key}：config 形态展开后必须逐字写回 effectiveOptions.${key}（引擎读侧读的就是它）`,
    );
    assert.equal(
      Object.hasOwn(flat.effectiveOptions, key),
      false,
      `${key} 的扁平写法已退役，扁平形态不该再产生它`,
    );
  }
  // ① 其余键：两种形态逐键深度相等。
  const nestedRest = { ...nested.effectiveOptions };
  for (const key of RETIRED_FLAT_KEYS) delete nestedRest[key];
  assert.deepEqual(nestedRest, flat.effectiveOptions, "除已退役的键以外，两种形态必须逐键深度相等");
  // 逐键再说一遍（deepEqual 之外的可读断言：哪一科不对，报错就点名哪一科）。
  for (const [key, value] of Object.entries(flat.effectiveOptions)) {
    assert.deepEqual(nested.effectiveOptions[key], value, `${key} 两种形态必须逐键相等`);
  }
  assert.equal(Object.hasOwn(nested.effectiveOptions, "config"), false, "config 不得漏进 effectiveOptions");
  assert.equal(Object.hasOwn(nested.explicitOptions, "config"), false, "config 不得漏进 explicitOptions");
  assert.deepEqual(nested.configConflicts, []);
});

test("B3 config 形态真的被引擎读：maxRounds 经 config 生效（不是「展开了但没人读」）", async () => {
  const result = await runDirect({ config: { run: { maxRounds: 1 } } });
  assert.equal(result.rounds, 1);
  assert.equal(result.termination.reason, "end_turn");
});

// ================================================================ C. 优先级与冲突（判据 2）
test("C1 同名时 config 赢，并记一条冲突（规范化层）", async () => {
  const { effectiveOptions, configConflicts } = await normalizeRunToolLoopOptions({
    maxRounds: 9,
    maxTokenContinuations: 2,
    // #498 S3（`tuning` A5）：`temperature` 已退役扁平写法（家 = `config.tuning.temperature`），所以
    // 「同一个值写两边 ⇒ 不记冲突」这条通道换成一个**仍可扁平写**的配置叶子 `maxTokenContinuations`
    // （家 = `config.run.maxTokenContinuations`）。它不属于本刀，所以顺带证明本刀没动它。
    config: { run: { maxRounds: 5, maxTokenContinuations: 2 } },
  });
  assert.equal(effectiveOptions.maxRounds, 5, "config.run.maxRounds 覆盖扁平 maxRounds");
  assert.equal(effectiveOptions.maxTokenContinuations, 2, "值相同时照旧生效");
  assert.deepEqual(configConflicts, [{ path: "run.maxRounds", key: "maxRounds" }], "只有值不同才算冲突");
});

test("C2 优先级的行为证据：扁平 maxRounds=1 + config maxRounds=2 ⇒ 两轮跑完（不是 max_rounds_cap）", async () => {
  const twoRounds = [
    {
      content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "x" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const tools = [{
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }];
  // 先证样本本身有效：扁平 maxRounds=1 撑不到第二轮（这就是「config 赢」的可观测差异）。
  const flatOnly = await runToolLoop(withSeed({
    provider: createFakeProvider(twoRounds),
    executeTool: async () => "ok",
    tools,
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 1,
  }));
  assert.equal(flatOnly.termination.reason, "max_rounds_cap", "样本自证：扁平 1 轮就到顶");

  const events = [];
  const both = await runToolLoop(withSeed({
    provider: createFakeProvider(twoRounds),
    executeTool: async () => "ok",
    tools,
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
    maxRounds: 1,
    config: { run: { maxRounds: 2 } },
    onEvent: (event) => events.push(event),
  }));
  assert.equal(both.termination.reason, "end_turn", "config 的 2 轮必须真的生效");
  const conflicts = events.filter((event) => event.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, "冲突事件恰好一条");
  assert.deepEqual(conflicts[0].conflicts, [{ path: "run.maxRounds", key: "maxRounds" }]);
  assert.equal(typeof conflicts[0].detail, "string");
  assert.equal(conflicts[0].runId, undefined, "没给 runId 时不编造字段");
});

test("C3 冲突事件不发的情况：只给一边、或两边值相同", async () => {
  const events = [];
  await runDirect({ config: { run: { maxRounds: 2 } }, onEvent: (event) => events.push(event) });
  await runDirect({ maxRounds: 2, onEvent: (event) => events.push(event) });
  await runDirect({ maxRounds: 2, config: { run: { maxRounds: 2 } }, onEvent: (event) => events.push(event) });
  assert.deepEqual(
    events.filter((event) => event.type === "config_override_conflict"),
    [],
    "只有「两边都给了且值不同」才发事件",
  );
});

test("C4 冲突事件的观察者抛错被隔离：run 照旧跑完，错误经 onObserverError 记账", async () => {
  const observerErrors = [];
  const result = await runDirect({
    maxRounds: 9,
    config: { run: { maxRounds: 2 } },
    onEvent: (event) => {
      if (event.type === "config_override_conflict") throw new Error("observer boom");
    },
    onObserverError: (error, context) => observerErrors.push({ error, context }),
  });
  assert.equal(result.termination.reason, "end_turn", "观察者抛错不得改变终局");
  assert.equal(observerErrors.length, 1, "恰好记一笔");
  assert.equal(observerErrors[0].context.channel, "onEvent");
  assert.equal(observerErrors[0].context.type, "config_override_conflict");
});

test("C5 config 叶子的 undefined 逐字等于「没给」：不覆盖扁平值、也不算冲突", async () => {
  const { effectiveOptions, configConflicts } = await normalizeRunToolLoopOptions({
    maxRounds: 7,
    config: { run: { maxRounds: undefined } },
  });
  assert.equal(effectiveOptions.maxRounds, 7);
  assert.deepEqual(configConflicts, []);
});

// issue #497 复审 R4：装配口 `policy.config` 与调用级 `config` 同时在场时，取值仍是「后写者胜、
// 整棵覆盖」（既有合并规则，一字未改），但**不许静默**：同一个叶子两边都给了不同的值 ⇒ 逐叶发
// `config_override_conflict`，与「扁平 vs config」同一条事件、同一套字段（`{ path, key }`）。
test("C6 两个 config 源同时在场：后写者胜（4 轮变 1 轮）+ 逐叶事件恰一条、path 集合逐字相等", async () => {
  const twoRounds = [
    {
      content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "x" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const tools = [{
    name: "echo",
    description: "回显",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  }];
  const port = makePort({ config: { run: { maxRounds: 4 }, tuning: { temperature: 0.1 } } });
  const events = [];
  const result = await runToolLoop({
    assemblyPort: port,
    provider: createFakeProvider(twoRounds),
    executeTool: async () => "ok",
    tools,
    completion: false,
    wrapup: false,
    // 调用级 config：`run.maxRounds` 与 policy 不同（1 vs 4）、`tuning.temperature` 与 policy 相同。
    config: { run: { maxRounds: 1 }, tuning: { temperature: 0.1 } },
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.termination.reason, "max_rounds_cap", "调用级 config 整棵覆盖 policy：1 轮就到顶");
  assert.equal(result.rounds, 1);
  const conflicts = events.filter((event) => event.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, "冲突事件恰一条（不是 >= 1）");
  assert.deepEqual(
    conflicts[0].conflicts,
    [{ path: "run.maxRounds", key: "maxRounds" }],
    "path 集合逐字相等：同值的 tuning.temperature 不算冲突",
  );
  assert.equal(typeof conflicts[0].detail, "string");
});

test("C7 两个 config 源同值 / 只给一边 ⇒ 不发事件（判据与扁平冲突同一套）", async () => {
  const events = [];
  const same = await runToolLoop({
    assemblyPort: makePort({ config: { run: { maxRounds: 1 } } }),
    completion: false,
    wrapup: false,
    config: { run: { maxRounds: 1 } },
    onEvent: (event) => events.push(event),
  });
  assert.equal(same.termination.reason, "end_turn");
  await runToolLoop({
    assemblyPort: makePort({ config: { run: { maxRounds: 1 } } }),
    completion: false,
    wrapup: false,
    onEvent: (event) => events.push(event),
  });
  await runToolLoop({
    assemblyPort: makePort({}),
    completion: false,
    wrapup: false,
    config: { run: { maxRounds: 1 } },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(
    events.filter((event) => event.type === "config_override_conflict"),
    [],
    "值相同或只有一边给了 ⇒ 零事件",
  );
});

// ================================================================ D. 能力面不收配置覆盖（判据 3）
test("D1 22 个能力键写进 config 顶层 ⇒ 启动即抛，点名该键，via=direct", async () => {
  assert.equal(CAPABILITY_OPTION_NAMES.length, 22);
  // 逐条枚举（**不是抽样**）：每一条都跑一次真 run，报错点名该键、带能力面文案与 via 标签。
  const enumerated = [];
  for (const name of CAPABILITY_OPTION_NAMES) {
    const error = await directError({ config: { [name]: null } });
    assert.equal(error instanceof TypeError, true, `${name} 必须启动即抛 TypeError`);
    assert.match(error.message, new RegExp(`config\\.${name} is not accepted`, "u"), `${name} 的报错必须点名该键`);
    assert.match(error.message, /capability\/injection option/u, `${name} 的报错必须说明是能力面`);
    assert.match(error.message, /cannot be overridden through the config namespace/u);
    assert.equal(error.via, "direct", `${name} 的路线标签必须是 direct`);
    enumerated.push(name);
  }
  assert.deepEqual(enumerated, [...CAPABILITY_OPTION_NAMES], "逐条枚举的名单必须与导出名单逐字相等（不许漏条）");
});

test("D2 能力键写在分组里 ⇒ 同一套规则（config.<group>.<capability> 也拒）", async () => {
  for (const name of CAPABILITY_OPTION_NAMES) {
    const error = await directError({ config: { run: { [name]: null } } });
    assert.equal(error instanceof TypeError, true, `${name} 在组内也必须抛`);
    assert.match(error.message, new RegExp(`config\\.run\\.${name} is not accepted`, "u"));
    assert.equal(error.via, "direct");
  }
});

test("D3 装配口路线的 policy.config 走同一棵树：能力键 via=assembly，合法叶子照常生效", async () => {
  const error = await assemblyError({ config: { provider: null } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /config\.provider is not accepted/u);
  assert.equal(error.via, "assembly", "装配口路线的路线标签必须是 assembly");
  // 构造期就抛（不必等到 run）：`createAssemblyPort` 直接调用同样抛，via 相同。
  assert.throws(
    () => makePort({ config: { provider: null } }),
    (thrown) => thrown instanceof TypeError
      && /config\.provider is not accepted/u.test(thrown.message)
      && thrown.via === "assembly",
    "policy.config 的名称闸口必须在构造期就抛",
  );

  const port = makePort({ config: { run: { maxRounds: 1 } } });
  const result = await runToolLoop({ assemblyPort: port, completion: false, wrapup: false });
  assert.equal(result.rounds, 1);
  assert.equal(result.termination.reason, "end_turn");
});

test("D4 既有 overrides 语义一字未动：显式 provider 仍能盖端口 provider（契约承诺）", async () => {
  const port = makePort({});
  const result = await runToolLoop({
    assemblyPort: port,
    provider: createFakeProvider([{ content: [{ type: "text", text: "explicit" }], stopReason: "end_turn" }]),
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  assert.equal(result.finalText, "explicit");
});

// ================================================================ E. #496 的闸口吃展开后的表示（判据 5）
test("E1 config 里的 context 拼错旋钮名 ⇒ 抛，且与壳内老槽位（policy.context）同一句（只差 via）", async () => {
  // #498 S3：顶层扁平 `context` 已在**名称闸口**被拒（比语义相更早），所以「两种写法」的另一半
  // 换成壳内老槽位仍然可达的那条路——装配口 `policy.context`。两边的文案必须逐字相同：
  // 语义相的规则表只有一份，路线只贴 `via`。
  const shellError = await assemblyError({ context: { budgetTokens: 1000, summarizeBudgetMs: 5 } });
  const nestedError = await directError({
    config: { folding: { context: { budgetTokens: 1000, summarizeBudgetMs: 5 } } },
  });
  assert.equal(shellError instanceof TypeError, true);
  assert.equal(nestedError instanceof TypeError, true);
  assert.match(nestedError.message, /unknown assembly policy context option: "summarizeBudgetMs"/u);
  assert.equal(nestedError.message, shellError.message, "两条写法必须抛同一句");
  assert.equal(nestedError.via, "direct");
  assert.equal(shellError.via, "assembly");
});

test("E2 装配口路线的 policy.config.folding.context 走同一道语义相（via=assembly）", async () => {
  const error = await assemblyError({ config: { folding: { context: { summarizerBudgetMs: 0 } } } });
  assert.equal(error instanceof TypeError, true);
  assert.match(error.message, /summarizerBudgetMs must be a positive integer/u);
  assert.equal(error.via, "assembly");
});

// #498 S4a 把这条**反过来**了：0.27 里 `config.observers.onFoldSummary` 与
// `config.guard.finalGuard`（函数值）是「合法 config 值」；0.28 起 `config` 只装数据，
// 两者都是能力面，写进 config 一律启动即抛并指出去处。合法的**数据**照旧不被误杀。
test("E3 config 只装数据：context 照旧过，observers 组与 finalGuard 一律抛并指出去处", async () => {
  const result = await runDirect({
    config: { folding: { context: { budgetTokens: 1000, summarizerBudgetMs: 5000 } } },
  });
  assert.equal(result.termination.reason, "end_turn");

  const observersError = await directError({ config: { observers: { onFoldSummary: () => {} } } });
  assert.match(observersError.message, /unknown config namespace: "observers"/u);

  const finalGuardError = await directError({
    config: { guard: { finalGuard: async () => ({ action: "accept" }) } },
  });
  assert.match(finalGuardError.message, /config\.guard\.finalGuard is not accepted/u);
  assert.match(finalGuardError.message, /capability\/injection option/u);
});

// #498 S4a：`config.guard.finalGuard` 已是能力键（见 E3 / S5c），所以这条改用**仍在配置面**的
// 回调字段 `retry.sleepImpl` 做同一件事：非函数值走语义相，同一句文案。
// #498 S3：`retry` 已经没有扁平写法（写了会在**名称闸口**当场拒，比语义相更早），所以这里的
// 「两种写法」变成「config 形态走语义相」+「扁平形态走名称闸口且文案指向新家」。
test("E4 config 里的回调字段给错型 ⇒ 语义相点名叶子路径；扁平写法更早一步被名称闸口拒并指新家", async () => {
  const nestedError = await directError({ config: { timing: { retry: { sleepImpl: "nope" } } } });
  assert.match(nestedError.message, /retry\.sleepImpl must be a function \(or omitted\)/u);
  assert.equal(nestedError.via, "direct");

  const flatError = await directError({ retry: { sleepImpl: "nope" } });
  assert.match(flatError.message, /^unknown runToolLoop option: "retry"/u);
  assert.match(flatError.message, /its canonical home is config\.timing\.retry/u);
});

// ================================================================ F. 名称/形状闸口（早于端口读取）
test("F1 未知分组 / 未知叶子 / 扁平键写进 config / 组内放错位置，四种都点名", async () => {
  const unknownGroup = await directError({ config: { rund: { maxRounds: 1 } } });
  assert.match(unknownGroup.message, /unknown config namespace: "rund"/u);
  assert.match(unknownGroup.message, /accepted: input, run, tuning, timing, folding, guard, metadata/u);
  assert.doesNotMatch(unknownGroup.message, /observers/u, "#498 S4a：observers 组已整组删除");
  assert.doesNotMatch(unknownGroup.message, /prompt/u, "#498 S4b：prompt 组改名 input");

  const unknownLeaf = await directError({ config: { run: { maxRond: 1 } } });
  assert.match(unknownLeaf.message, /unknown config\.run option: "maxRond"/u);
  assert.match(unknownLeaf.message, /accepted: maxRounds, maxTokenContinuations/u);

  const flatInside = await directError({ config: { maxRounds: 1 } });
  assert.match(flatInside.message, /config\.maxRounds: flat option keys are not accepted at the top of config/u);
  assert.match(flatInside.message, /write config\.run\.maxRounds instead/u);

  const misplaced = await directError({ config: { run: { temperature: 0.2 } } });
  assert.match(misplaced.message, /unknown config\.run option: "temperature"/u);
  assert.match(misplaced.message, /"temperature" belongs to config\.tuning\.temperature/u);

  for (const error of [unknownGroup, unknownLeaf, flatInside, misplaced]) {
    assert.equal(error instanceof TypeError, true);
    assert.equal(error.via, "direct");
  }
});

test("F2 config 自己的形状：null / 数组 / 字符串 / 分组不是对象 都抛", async () => {
  const cases = [
    [{ config: null }, /config must be an object \(or omitted\)/u],
    [{ config: [] }, /config must be an object \(or omitted\)/u],
    [{ config: "nested" }, /config must be an object \(or omitted\)/u],
    [{ config: { run: "fast" } }, /config\.run must be an object/u],
    [{ config: { run: null } }, /config\.run must be an object/u],
  ];
  for (const [options, pattern] of cases) {
    const error = await directError(options);
    assert.equal(error instanceof TypeError, true, JSON.stringify(options));
    assert.match(error.message, pattern);
    assert.equal(error.via, "direct");
  }
  // `config: undefined` 逐字等于省略（与既有合并规则同口径）。
  const result = await runDirect({ config: undefined });
  assert.equal(result.termination.reason, "end_turn");
});

test("F3 config 名称错误在读任何宿主端口之前抛（Proxy 钉住端口未被触碰）", async () => {
  const touched = [];
  const proxyPort = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`assembly port was read before the config check: ${String(property)}`);
    },
  });
  const error = await runToolLoop({ assemblyPort: proxyPort, config: { provider: null } })
    .then(() => null, (caught) => caught);
  assert.equal(error instanceof TypeError, true, `实际抛：${error && error.message}`);
  assert.match(error.message, /config\.provider is not accepted/u);
  assert.deepEqual(touched, [], "配置名称错误必须早于任何端口读取");
});

// ================================================================ G. 纯函数契约（不依赖引擎）
test("G1 collectConfigNamespaceProblems 是纯函数：问题清单不抛、可逐条断言", () => {
  assert.deepEqual(collectConfigNamespaceProblems(undefined), ["config must be an object (or omitted)"]);
  assert.deepEqual(collectConfigNamespaceProblems({ run: { maxRounds: 1 } }), []);
  assert.deepEqual(
    collectConfigNamespaceProblems({ run: { provider: null }, tuning: { nope: 1 } }),
    [
      'config.run.provider is not accepted: "provider" is a capability/injection option,'
        + " and the capability surface cannot be overridden through the config namespace"
        + " (pass it as a top-level option or through the assembly port)",
      'unknown config.tuning option: "nope" (accepted: maxTokens, temperature, topP, cacheCapable)',
    ],
  );
});

test("G3 collectConfigSourceConflicts 是纯函数：逐叶、同值不算、顺序按 schema", () => {
  const policy = { run: { maxRounds: 4, stream: true }, tuning: { temperature: 0.1 } };
  const call = { run: { maxRounds: 1, stream: true }, tuning: { temperature: 0.2 }, guard: { finalGuardExtend: true } };
  assert.deepEqual(collectConfigSourceConflicts(policy, call), [
    { path: "run.maxRounds", key: "maxRounds" },
    { path: "tuning.temperature", key: "temperature" },
  ], "同值（stream）与被覆盖树里没有的叶子（finalGuardExtend）都不算冲突；顺序 = 分组顺序");
  // 形状不合法的一侧直接当「没有可报的」，不抛（装配口的 policy.config 已在构造期过闸口）。
  assert.deepEqual(collectConfigSourceConflicts(undefined, call), []);
  assert.deepEqual(collectConfigSourceConflicts("nope", call), []);
  assert.deepEqual(collectConfigSourceConflicts(policy, []), []);
  // 叶子显式 undefined 逐字等于「没给」。
  assert.deepEqual(collectConfigSourceConflicts({ run: { maxRounds: 4 } }, { run: { maxRounds: undefined } }), []);
  // 不改入参。
  assert.deepEqual(policy, { run: { maxRounds: 4, stream: true }, tuning: { temperature: 0.1 } });
});

test("G2 expandConfigNamespace 不改入参：返回新对象，原 options 原样保留", () => {
  const options = { maxRounds: 1, config: { run: { maxRounds: 2 } } };
  const { options: expanded } = expandConfigNamespace(options);
  assert.notEqual(expanded, options);
  assert.equal(expanded.maxRounds, 2);
  assert.equal(options.maxRounds, 1, "入参不得被改写");
  assert.deepEqual(options.config, { run: { maxRounds: 2 } }, "入参的 config 不得被删");
});

// ================================================================ H. 类型面锁进默认套件（第二轮复审 T2）
//
// R3 把 `config` 的 JSDoc 类型面改成八组真名，但那条锁只活在 `check:release` 第 4 步（真实 TS
// 宿主）——CI 里 `check:release` 只在 node 22 一档跑。实测：把 JSDoc 的 `tuning?:` 写成假组名
// `reflection?:`，`npm test` 与 `check:types-build` **都不红**，只有 `check:release` 红。
// H1 把同一条性质搬进默认套件：直接扫 `src/loop/orchestrator.js` 的 `config?:` JSDoc 文本，
// 断言其中出现的组名集合**恰等于** `Object.keys(CONFIG_NAMESPACE_SCHEMA)`（缺组、多组、假组名、
// 重复组名都红，报错点名是哪个名字）。
// **不许手工维护第二份名单**：期望值必须从模块导出派生（`CONFIG_NAMESPACE_SCHEMA` 的键集）。
const ORCHESTRATOR_SOURCE_PATH = new URL("../src/loop/orchestrator.js", import.meta.url);

/** 从 `config?: { … }` 的 JSDoc 类型字面里抽出**组名**（深度 1 上的 `<name>?:`，按出现顺序）。 */
function jsDocConfigGroupNames(source) {
  const marker = "config?: {";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "orchestrator.js 的 JSDoc 里必须还有 `config?: {` 这个类型字面");
  const open = start + marker.length - 1;
  const names = [];
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return names;
      continue;
    }
    if (depth !== 1) continue;
    if (/[\w$]/u.test(source[i - 1] ?? "")) continue;
    const match = /^([A-Za-z_$][\w$]*)\?:/u.exec(source.slice(i, i + 64));
    if (match === null) continue;
    names.push(match[1]);
    i += match[1].length;
  }
  assert.fail("`config?: {` 的类型字面没有闭合——抽不到组名就等于这条锁在空转");
  return names;
}

test("H1 JSDoc 的 config 组名集合恰等于 schema 组名（类型面锁进默认套件）", () => {
  const source = readFileSync(ORCHESTRATOR_SOURCE_PATH, "utf8");
  const jsDocGroups = jsDocConfigGroupNames(source);
  const schemaGroups = Object.keys(CONFIG_NAMESPACE_SCHEMA); // 派生，不手抄
  // 派生自证：这份期望值确实来自模块导出（与分组名单逐字同一份）。
  assert.deepEqual(schemaGroups, [...CONFIG_NAMESPACE_GROUPS], "期望值必须来自 CONFIG_NAMESPACE_SCHEMA 的键集");
  assert.equal(schemaGroups.length, 7, "七组（schema 侧的自证；#498 S4a 删 observers、S4b 把 prompt 改名 input）");

  const duplicated = jsDocGroups.filter((group, index) => jsDocGroups.indexOf(group) !== index);
  const extra = jsDocGroups.filter((group) => !schemaGroups.includes(group));
  const missing = schemaGroups.filter((group) => !jsDocGroups.includes(group));
  assert.deepEqual(duplicated, [], `JSDoc 的 config 类型面重复声明了组名：${duplicated.join(", ")}`);
  assert.deepEqual(
    extra,
    [],
    `JSDoc 的 config 类型面里有 schema 里不存在的组名：${extra.join(", ")}`
      + `（宿主会以为 config.${extra[0] ?? "…"} 合法，而运行时它是未知分组）`,
  );
  assert.deepEqual(
    missing,
    [],
    `JSDoc 的 config 类型面缺组：${missing.join(", ")}（合法分组在类型面上被说成不存在）`,
  );
  assert.deepEqual([...jsDocGroups].sort(), [...schemaGroups].sort(), "组名集合必须与 schema 键集逐字相等");
});

// ================================================================ I. #498 S4b：`input` 组与叶子别名
test("I1 老写法 `config.prompt` 必须报错并指出去处（`config.input.system`），不许静默接受", async () => {
  assert.equal(CONFIG_NAMESPACE_GROUPS.includes("prompt"), false, "prompt 组已改名 input");
  assert.equal(Object.hasOwn(CONFIG_NAMESPACE_SCHEMA, "prompt"), false);
  const error = await directError({ config: { prompt: { system: "you are" } } });
  assert.equal(error instanceof TypeError, true);
  // 报错必须**指出去处**（不是只回一句「未知分组」）：老组名 → 新组名 + 一个具体叶子示例。
  assert.equal(
    error.message,
    'config.prompt: the "prompt" group is now "input"'
      + " (write config.input.<leaf> instead, e.g. config.input.system)",
  );
  assert.equal(error.via, "direct");
  // 叶子写错组同样指出去处（不是含糊的「未知叶子」）。
  const leafError = await directError({ config: { run: { system: "you are" } } });
  assert.match(leafError.message, /"system" belongs to config\.input\.system/u);
  // 装配口路线同一道闸口（构造期就抛，via 不同）。
  const portError = await assemblyError({ config: { prompt: { system: "you are" } } });
  assert.match(portError.message, /config\.prompt: the "prompt" group is now "input"/u);
  assert.match(portError.message, /config\.input\.system/u);
  assert.equal(portError.via, "assembly");
  // 未知分组照旧只回「未知 + 接受名单」（不编造改名）。
  const unknown = await directError({ config: { rund: { maxRounds: 1 } } });
  assert.match(unknown.message, /unknown config namespace: "rund"/u);
});

test("I2 `config.input.messages` 是顶层 `initialMessages` 的嵌套别名（展开 + 冲突 path/key 逐字）", async () => {
  const messages = [{ role: "user", content: "hi" }];
  const expanded = expandConfigNamespace({ config: { input: { messages } } });
  assert.deepEqual(expanded.conflicts, []);
  assert.deepEqual(expanded.options.initialMessages, messages, "展开后回到顶层 initialMessages");
  assert.equal(Object.hasOwn(expanded.options, "messages"), false, "别名叶子本身不许漏进有效选项");

  // 冲突：path 是 schema 路径（`input.messages`），key 是顶层键名（`initialMessages`）。
  const conflict = expandConfigNamespace({
    initialMessages: [],
    config: { input: { messages } },
  });
  assert.deepEqual(conflict.conflicts, [{ path: "input.messages", key: "initialMessages" }]);
  assert.deepEqual(conflict.options.initialMessages, messages, "config 侧赢");

  // 把顶层键名当叶子写 ⇒ 指到正确的叶子（不是「未知叶子」）。
  const wrongLeaf = await directError({ config: { input: { initialMessages: [] } } });
  assert.match(wrongLeaf.message, /unknown config\.input option: "initialMessages"/u);
  assert.match(wrongLeaf.message, /"initialMessages" belongs to config\.input\.messages/u);
  // 把叶子写在 config 顶层 ⇒ 指到它真正的组。
  const flatLeaf = await directError({ config: { messages: [] } });
  assert.match(flatLeaf.message, /config\.messages: leaf names are not accepted at the top of config/u);
  assert.match(flatLeaf.message, /write config\.input\.messages instead/u);
});

test("I3 #527：`config.input.tools` 已拆掉（未知叶子 + 指向顶层第三站），扁平 `tools` 真被引擎读", async () => {
  const tools = [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } }];
  // ① 规位现在是闭门：叶子被拆掉，写它就是未知叶子；文案必须指向永久顶层面。
  const nestedError = await directError({ config: { input: { tools } } });
  assert.equal(nestedError instanceof TypeError, true, "config.input.tools 必须当场拒");
  assert.match(nestedError.message, /unknown config\.input option: "tools"/u);
  assert.match(nestedError.message, /permanent top-level option/u);
  assert.match(nestedError.message, /third station/u, "文案必须指向第三站在顶层");
  // ② 扁平写法一字未动，且引擎真的读它（工具声明真的进了请求、真的被调用）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({ tools });
  assert.deepEqual(effectiveOptions.tools, tools, "扁平 tools 仍是那个键");
  const twoRounds = [
    { content: [{ type: "tool_use", id: "tu_1", name: "echo", input: { text: "x" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  let executed = 0;
  const result = await runToolLoop(withSeed({
    provider: createFakeProvider(twoRounds),
    executeTool: async () => { executed += 1; return "ok"; },
    tools,
    initialUserMessage: "go",
    completion: false,
    wrapup: false,
  }));
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(executed, 1, "扁平 tools 里的工具声明必须真的可用（读侧一行未改）");
});

test("I4 `resume` 归位到 `config.run.resume`：别名路径与顶层扁平键是同一个键", async () => {
  assert.equal(configPathForOption("resume"), "run.resume");
  const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: { run: { resume: true } } });
  assert.equal(effectiveOptions.resume, true, "config.run.resume 展开成顶层 resume");
  // 顶层扁平写法一字未动（纯新增别名，不是迁移）。
  const flat = await normalizeRunToolLoopOptions({ resume: false });
  assert.equal(flat.effectiveOptions.resume, false);
  // 幻影组 `session` 的别名已删（`src/assembly.js`）：`session` 只装数据。
  const { effectiveOptions: withSession } = await normalizeRunToolLoopOptions({
    session: { id: "config-497-i4" },
  });
  assert.equal(Object.hasOwn(withSession, "resume"), false, "session 不再产出 resume（别名已删）");
});
