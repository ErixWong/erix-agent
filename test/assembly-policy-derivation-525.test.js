// issue #525 的守卫，**判据已按 #545 收敛**（本文件在 #545 里改写，不是放宽）。
//
// 历史（#525 落地时）：`ASSEMBLY_POLICY_OPTION_NAMES`（`src/assembly.js` 里的模块私有 Set）是一张
// **手抄的 46 条字面量**，而它逐条都能在三个面里找到家 —— 也就是说「policy 接受哪些名字」这张表
// 本身就是一份**第二拼写面**。当时本文件钉的是「派生化会改变行为」，其中 C1 是反向证：
// `runId` 在派生并集里、不在被接受集合里，而 #544 的合并后闸口（`assertMergedOptionNames`）**带着
// policy 豁免**，所以只要 policy 还收退役拼写，`policy.runId` 就借那道豁免穿过闸口。
//
// #545 把那条路封了（本片就是 #525 的前置）：
//   ① 字面量删了 —— 可接受集合**派生**自 schema：`config` 的叶子 + 两个容器
//      （`config` / `capabilities`）。集合里没有任何一条是手写的名字；
//   ② 叶子名**一律翻译**成规范路径（`policy.maxRounds` → `config.run.maxRounds`，路径由
//      schema / `configPathForOption` 派生，不写第二张映射表）；
//   ③ 其余名字当场拒，判词指对家（能力名 → `policy.capabilities.<组>.<叶>`；端口成员 → 端口本体）；
//   ④ `assertMergedOptionNames` 的 **policy 豁免摘掉了**，于是「引擎自己产的名字」与「宿主写的名字」
//      真的受同一条约束（D 段是这件事的机器证明）。
//
// 判据全部**派生**：不硬编码 41 / 46 / 76 之类的条数，也不往派生式里塞特例名单——数变了要么自动跟随，
// 要么在这里红。
//
// 不导出 policy 的可接受集合（`src/assembly.js` 里它是模块私有的派生 Set）：导出会进 `check:exports`
// 的消费面账目，而「行为级探针 + schema 派生」已经够用。零真实 LLM、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";

import {
  assemblyPortOptions,
  assertMergedOptionNames,
  collectAssemblyDerivedConfigConflicts,
  collectAssemblyPolicyConfigConflicts,
  createAssemblyPort,
} from "../src/assembly.js";
import {
  CAPABILITY_OPTION_NAMES,
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_SCHEMA,
  CONFIG_SURFACE_OPTION_NAMES,
  NAMESPACE_CONTAINER_OPTION_NAMES,
  TOP_LEVEL_SURFACE_OPTION_NAMES,
  configPathForOption,
} from "../src/loop/config-namespace.js";
import {
  CAPABILITIES_NAMESPACE_GROUPS,
  CAPABILITIES_NAMESPACE_SCHEMA,
  capabilitiesPathForOption,
} from "../src/loop/capabilities-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  RUN_TOOL_LOOP_OPTION_SET,
} from "../src/loop/option-normalization.js";

// ================================================================ 集合，全部派生

/** `config` 的叶子（顺序 = 分组顺序 + 组内顺序）。 */
const CONFIG_LEAVES = CONFIG_NAMESPACE_GROUPS.flatMap((group) => CONFIG_NAMESPACE_SCHEMA[group]);
const CONFIG_LEAF_SET = new Set(CONFIG_LEAVES);
const CONTAINERS = [...NAMESPACE_CONTAINER_OPTION_NAMES];
const CONTAINER_SET = new Set(CONTAINERS);

/** 能力面的**叶子**名（`hooks.*` / `checks.*` / `ports.*`），派生的，不是手抄。 */
const CAPABILITY_LEAVES = CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => CAPABILITIES_NAMESPACE_SCHEMA[group]);

/**
 * 一张「这个名字在别的面存在」的派生全集：顶层白名单 + 能力选项 + 能力叶子 + schema 会映射到的
 * 扁平名（含 `initialMessages` 这条唯一的别名）+ 第三站。policy 的可接受集合必须与
 * 「它减去叶子再减去容器」**零交集**——这一条就是「policy 只收数据」的机器表述。
 */
const EVERY_OTHER_NAME = [...new Set([
  ...RUN_TOOL_LOOP_OPTION_NAMES,
  ...CAPABILITY_OPTION_NAMES,
  ...CAPABILITY_LEAVES,
  ...CONFIG_SURFACE_OPTION_NAMES,
  ...TOP_LEVEL_SURFACE_OPTION_NAMES,
])].filter((name) => !CONFIG_LEAF_SET.has(name) && !CONTAINER_SET.has(name));

/**
 * 叶子的规范路径（`messages` → `input.messages`）：schema 里它住在哪一组，路径就是哪一组 + 它自己。
 * 与实现的派生同源（都从 `CONFIG_NAMESPACE_SCHEMA` 来），但**不是**照抄实现里的分支。
 */
function leafPath(leaf) {
  const group = CONFIG_NAMESPACE_GROUPS.find((candidate) => CONFIG_NAMESPACE_SCHEMA[candidate].includes(leaf));
  return group === undefined ? undefined : `${group}.${leaf}`;
}

/** 最小合法装配端口输入（`modelConfig.resolve` 是唯一一个会被 await 的成员，这里给纯数据）。 */
function portInput(policy) {
  return {
    modelConfig: { resolve: async () => ({ contextWindowTokens: 1000, maxOutputTokens: 16 }) },
    provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: `policy-derivation-525-${process.pid}` },
    policy,
  };
}

function portError(policy) {
  try {
    createAssemblyPort(portInput(policy));
  } catch (error) {
    return error;
  }
  return null;
}

// ================================================================ A. 可接受集合 = 叶子 + 容器

test("A1 每个 schema 叶子都被接受（全部派生，不硬编码条数）", () => {
  assert.ok(CONFIG_LEAVES.length > 0, "config schema 不能为空（否则本文件的核对对象消失了）");
  assert.equal(CONFIG_LEAF_SET.size, CONFIG_LEAVES.length, "schema 里不许有重复叶子");
  for (const leaf of CONFIG_LEAVES) {
    assert.doesNotThrow(
      () => createAssemblyPort(portInput({ [leaf]: undefined })),
      `${leaf} 是 config 叶子，policy 必须放行`,
    );
  }
});

test("A2 两个容器被接受（`config` / `capabilities` 今天都是真语义）", () => {
  assert.deepEqual(CONTAINERS, ["config", "capabilities"], "容器名单来自 `NAMESPACE_CONTAINER_OPTION_NAMES`");
  for (const container of CONTAINERS) {
    assert.doesNotThrow(
      () => createAssemblyPort(portInput({ [container]: undefined })),
      `${container} 是容器，policy 必须放行`,
    );
  }
});

test("A3 其余名字一律拒：白名单 / 能力名 / 能力叶子 / 退役扁平名（派生全集逐个扫）", () => {
  assert.ok(EVERY_OTHER_NAME.length > 0, "派生全集不能为空（否则这条探针空转）");
  for (const name of EVERY_OTHER_NAME) {
    const error = portError({ [name]: 1 });
    assert.notEqual(error, null, `${name} 不是 config 叶子也不是容器，policy 必须拒绝`);
    assert.ok(error instanceof TypeError, `${name}: 拒绝必须是 TypeError`);
    assert.ok(error.message.startsWith(`unknown assembly policy option: ${JSON.stringify(name)}`),
      `${name}: 判词必须以「unknown assembly policy option: <name>」开头，实测 ${error.message}`);
  }
});

// ================================================================ B. 判词指对家

test("B1 能力名 ⇒ 判词点到 `policy.capabilities.<组>.<叶>`（不是含糊的「未知」）", () => {
  const withCapabilityHome = EVERY_OTHER_NAME.filter((name) => capabilitiesPathForOption(name) !== undefined);
  assert.ok(withCapabilityHome.length > 0, "必须有「有 capabilities 之家」的名字（否则这条判据空转）");
  for (const name of withCapabilityHome) {
    const path = capabilitiesPathForOption(name);
    const error = portError({ [name]: 1 });
    assert.match(error.message, new RegExp(`policy\\.capabilities\\.${path.replaceAll(".", "\\.")}`, "u"),
      `${name} 的判词必须点名 policy.capabilities.${path}，实测 ${error.message}`);
  }
});

test("B2 端口成员 ⇒ 判词点名「端口本体 / 同一能力两个来源」，且**不**指向 capabilities", () => {
  const portMembers = ["provider", "tools", "executeTool", "store", "modelConfig", "assemblyPort", "session", "signal"];
  for (const name of portMembers) {
    // 自证：这八个名字确实都在第三站（永久顶层面），不是本测试凭空点名的。
    assert.ok(TOP_LEVEL_SURFACE_OPTION_NAMES.includes(name), `${name} 必须是第三站成员`);
    const error = portError({ [name]: 1 });
    assert.match(error.message, /supplied by the port itself/u, `${name}: 判词必须说「端口给的」`);
    assert.match(error.message, /same capability with two sources/u, `${name}: 判词必须说「同一能力两个来源」`);
    assert.doesNotMatch(error.message, /policy\.capabilities/u, `${name}: 端口成员不该被指到 capabilities`);
  }
});

test("B3 真·乱名逐字维持旧文案（没有去处就不编造去处）", () => {
  const junk = ["definitelyNotAPolicyOption", "maxTokensV2", "systemPrompt"];
  for (const name of junk) {
    assert.equal(CONFIG_LEAF_SET.has(name), false, `${name} 必须真的不是叶子，否则这条探针无效`);
    assert.equal(capabilitiesPathForOption(name), undefined, `${name} 必须真的没有 capabilities 之家`);
    assert.equal(portError({ [name]: 1 }).message, `unknown assembly policy option: ${JSON.stringify(name)}`);
  }
});

// ================================================================ C. 翻译（路径派生，不写映射表）

test("C1 每个叶子都翻译到 `config.<路径>`（叶名 ≠ 顶层键名时也不落空）", async () => {
  for (const leaf of CONFIG_LEAVES) {
    const path = leafPath(leaf);
    assert.equal(typeof path, "string", `${leaf} 必须住在某个 config 组里`);
    // 派生式的两条腿：叶子名逐字等于顶层键名时由 `configPathForOption` 答，唯一的别名叶子
    // （`input.messages`）由 schema 的叶子名答——两者都不写映射表。
    const byTopLevelKey = configPathForOption(leaf);
    if (byTopLevelKey !== undefined) {
      assert.equal(byTopLevelKey, path, `${leaf}: configPathForOption 与 schema 必须给出同一条路径`);
    }
    const [group, name] = path.split(".");
    // `context` 是唯一一个**值必须是对象**的叶子（语义相 `collectSemanticOptionProblems`），
    // 其余叶子给字符串就够——本格量的是「翻译到哪」，不是「取值校验」（那由别的格子负责）。
    // issue #538：`stream` 有值规则（必须是布尔），所以它取自己的合法值 `true`；给字符串会让
    // 本格红在值规则上，而不是红在它要证明的「翻译到哪」上。
    // issue #598：`handoff` 同一条纪律（三字面量枚举），取默认值 `"off"`。
    const value = leaf === "context"
      ? {}
      : leaf === "stream" ? true : leaf === "handoff" ? "off" : `translated:${leaf}`;
    const options = await assemblyPortOptions(portInput({ [leaf]: value }), {});
    assert.deepEqual(options.config?.[group]?.[name], value, `${leaf} 必须翻译成 config.${path}`);
    assert.equal(Object.hasOwn(options, leaf), false, `${leaf} 不许同时以扁平名出现（那就是第二拼写面）`);
  }
});

test("C2 `policy.config` 与翻译叶撞车：显式树赢，且逐叶报一条 `{ path, key }`", () => {
  const port = createAssemblyPort(portInput({ maxRounds: 3, config: { run: { maxRounds: 5 } } }));
  const conflicts = collectAssemblyPolicyConfigConflicts(port);
  assert.deepEqual(conflicts, [{ path: "run.maxRounds", key: "maxRounds" }], "同一个旋钮两个来源不许静默");
  // 值相同不记冲突（与 #497 的 `isDeepStrictEqual` 口径逐字相同）。
  const same = createAssemblyPort(portInput({ maxRounds: 3, config: { run: { maxRounds: 3 } } }));
  assert.deepEqual(collectAssemblyPolicyConfigConflicts(same), [], "等值不许被报成冲突");
});

test("C3 #544 的派生叶只补洞：`policy.runId` 赢 `session.id`，两者不同则报一条冲突", async () => {
  const port = createAssemblyPort(portInput({ runId: "policy-runid" }));
  assert.deepEqual(collectAssemblyPolicyConfigConflicts(port), [], "policy.runId 与 policy.config 之间没有冲突");
  // 与派生叶（`session.id`）撞车：翻译叶是「树里的值」，派生叶只补洞 ⇒ 翻译叶赢，且不静默。
  assert.deepEqual(collectAssemblyDerivedConfigConflicts(port), [{ path: "run.runId", key: "runId" }],
    "policy.runId 与 session.id 是两个来源，值不同必须报一条");
  const options = await assemblyPortOptions(portInput({ runId: "policy-runid" }), {});
  assert.equal(options.config.run.runId, "policy-runid", "翻译叶赢：派生叶只补洞");
  // 不给 `policy.runId` ⇒ 派生叶照旧补上（#544 的行为没被这一刀碰掉）。
  const derived = await assemblyPortOptions(portInput({}), {});
  assert.equal(derived.config.run.runId, `policy-derivation-525-${process.pid}`);
});

// ================================================================ D. 洞已关闭（豁免摘除）

test("D1 合并后闸口不再给 policy 豁免：退役扁平名在合并树里必红", () => {
  const retired = CONFIG_LEAVES.filter((name) => !RUN_TOOL_LOOP_OPTION_SET.has(name));
  assert.ok(retired.length > 0, "必须有退役扁平名（否则这条反向证空转）");
  for (const name of retired) {
    assert.throws(
      () => assertMergedOptionNames({ provider: {}, [name]: "flat-again" }),
      (error) => error instanceof TypeError
        && error.message.startsWith(`unknown runToolLoop option: ${JSON.stringify(name)}`),
      `${name} 借 policy 豁免穿过合并后闸口 —— 豁免没摘干净`,
    );
  }
});

test("D2 真端口产出的合并树里没有任何退役扁平名（policy 侧不再产旧拼写）", async () => {
  const options = await assemblyPortOptions(portInput({ maxRounds: 3, system: "you are" }), {});
  const retired = CONFIG_LEAVES.filter((name) => !RUN_TOOL_LOOP_OPTION_SET.has(name));
  const leaked = Object.keys(options).filter((key) => retired.includes(key));
  assert.deepEqual(leaked, [], `构造期产物里不该有扁平拼写：${leaked.join(", ")}`);
  assert.equal(options.config.run.maxRounds, 3);
  assert.equal(options.config.input.system, "you are");
  // 闸口对**构造期产物**逐键放行（没有豁免也必须全绿）。
  assert.doesNotThrow(() => assertMergedOptionNames(options), "合法产物不该被闸口拒");
});

// ================================================================ E. 相位：名称闸口在读端口之前

test("E 乱名在**读任何宿主端口之前**抛（`modelConfig.resolve` 一次都不许被调）", async () => {
  let resolved = false;
  const input = portInput({ definitelyNotAPolicyOption: 1 });
  input.modelConfig = {
    resolve: async () => {
      resolved = true;
      return { contextWindowTokens: 1000, maxOutputTokens: 16 };
    },
  };
  await assert.rejects(
    () => assemblyPortOptions(input, {}),
    (error) => error instanceof TypeError
      && error.message === 'unknown assembly policy option: "definitelyNotAPolicyOption"',
  );
  assert.equal(resolved, false, "名称闸口在读宿主端口之前");
});
