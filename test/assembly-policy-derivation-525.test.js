// issue #525 —— `ASSEMBLY_POLICY_OPTION_NAMES`（`src/assembly.js` 里的模块私有 Set）能不能改成
// **派生式**？本文件是这件事的机器核对。结论：**今天不能**，而下面的断言把「为什么不能」钉成了活的
// 反向证，而不是一段散文。
//
// 病（实测，不是估算）：字面量 46 条里有 29 条是已退役的扁平拼写（`system` / `retry` / `maxTokens` /
// `reflection` …），它们逐条都能在今天的 `CONFIG_NAMESPACE_SCHEMA` 里查到规范之家。也就是说这张表
// **本身就是一份手抄的第二拼写面**，而它正是 #545 的数据来源——这正是本单点名要派生的理由。
//
// 但「派生化」不等于「换成并集」：并集（`RUN_TOOL_LOOP_OPTION_NAMES` ∪ config 叶子 ∪ 能力叶子）是
// 字面量的**严格超集**（实测 76 ⊃ 46），差集 30 条里既有 12 个已退役的 config 叶子（`runId` /
// `resume` / `cwd` / `invalidArguments` …），也有 9 个白名单本来就有、字面量却忘掉的合法选项
// （`provider` / `tools` / `store` …）与 9 个从来没有扁平拼写的**能力槽位**（`onReflection` /
// `sleepImpl` …）。放行退役叶子等于让 `policy.runId` 这种拼写活过来——而 #544 的合并后闸口
// （`assertMergedOptionNames`）收上去的目的恰恰是让「引擎自己产的名字」与「宿主写的名字」受同一套
// 合法性约束。并集会直接把它打开（T4 是这条的反向证）。
//
// 所以本文件钉四件事，判据全部**派生**（不硬编码条数，也不往派生式里塞特例名单）：
//   ① 每个被 policy 接受的名字都在某个面有家（白名单 / `configPathForOption` /
//      `capabilitiesPathForOption`）——这条是防「第二拼写面」重新长出来的那道闸；
//   ② 派生并集逐条包含今天的字面量（改名/删名会让它红），且差集里每个名字都可**分类**：
//      要么是白名单的合法选项，要么是「有家但被严格闸口拒绝」的退役扁平拼写；三族都非空；
//   ③ 反向证：`runId` 在派生并集里、**不在**被接受集合里，且合并后闸口必须仍然拒绝它——
//      谁采纳并集，这一条必红并点名 `runId`（这是本单「行为零变化」那半边的机器证明）；
//   ④ 行为级：真装配端口（`createAssemblyPort` / `assemblyPortOptions`）对集合内名字逐个放行、
//      对集合外乱名逐个拒绝。名称闸口在读任何宿主端口之前，所以这条不需要真模型、很便宜。
//
// 不导出 `ASSEMBLY_POLICY_OPTION_NAMES`：导出会进 `check:exports` 的消费面账目，而「读源码字面量 +
// 行为级探针」已经够用。零真实 LLM、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assemblyPortOptions, assertMergedOptionNames, createAssemblyPort } from "../src/assembly.js";
import {
  CONFIG_NAMESPACE_GROUPS,
  CONFIG_NAMESPACE_SCHEMA,
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
  assertRunToolLoopOptionNames,
} from "../src/loop/option-normalization.js";

// ================================================================ 三个集合，全部派生

/**
 * `src/assembly.js` 里那份字面量的**原样**条目（含顺序与重复）。
 *
 * 为什么读源码而不是导出符号：那个 Set 是模块私有的，导出只为测试会把它推进 `check:exports` 的
 * 消费面账目；而这里要的是「今天这张手抄表到底写了什么」这个**历史快照**，读字面量正好。
 */
function policyLiteralEntries() {
  const source = readFileSync(new URL("../src/assembly.js", import.meta.url), "utf8");
  const block = /const ASSEMBLY_POLICY_OPTION_NAMES = new Set\(\[([\s\S]*?)\]\);/u.exec(source);
  assert.notEqual(block, null, "`src/assembly.js` 里必须还有 `ASSEMBLY_POLICY_OPTION_NAMES` 这个 Set 字面量");
  return [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

const LITERAL_ENTRIES = policyLiteralEntries();
const ACCEPTED = new Set(LITERAL_ENTRIES);

/** 派生式：一个名字能合法存在的三个地方（与工单给的口径逐字相同）。 */
const DERIVED = new Set([
  ...RUN_TOOL_LOOP_OPTION_NAMES,
  ...CONFIG_NAMESPACE_GROUPS.flatMap((group) => CONFIG_NAMESPACE_SCHEMA[group]),
  ...CAPABILITIES_NAMESPACE_GROUPS.flatMap((group) => CAPABILITIES_NAMESPACE_SCHEMA[group]),
]);

/** 差集：派生并集有、今天的字面量没有。 */
const DELTA = [...DERIVED].filter((name) => !ACCEPTED.has(name));

/**
 * 某个名字的**配置面**路径（`"run.maxRounds"`）。两种拼写都算：叶子名逐字（`messages`）与叶子
 * 映射到的顶层键名（`initialMessages`，`CONFIG_LEAF_ALIASES` 的唯一一格）。
 */
function configLeafPath(name) {
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    if (CONFIG_NAMESPACE_SCHEMA[group].includes(name)) return `${group}.${name}`;
  }
  return configPathForOption(name);
}

/** 某个名字的**能力面**路径（`"hooks.onRound"`），同样两种拼写都算。 */
function capabilityLeafPath(name) {
  for (const group of CAPABILITIES_NAMESPACE_GROUPS) {
    if (CAPABILITIES_NAMESPACE_SCHEMA[group].includes(name)) return `${group}.${name}`;
  }
  return capabilitiesPathForOption(name);
}

/** 某个名字的「家」：`"top-level"` / `"config.<group>.<leaf>"` / `"capabilities.<group>.<leaf>"`。 */
function homeOf(name) {
  const configHome = configLeafPath(name);
  if (configHome !== undefined) return `config.${configHome}`;
  const capabilityHome = capabilityLeafPath(name);
  if (capabilityHome !== undefined) return `capabilities.${capabilityHome}`;
  return RUN_TOOL_LOOP_OPTION_SET.has(name) ? "top-level" : undefined;
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

// ================================================================ ① 每个名字都有家

test("A1 字面量本身：无重复条目（Set 字面量里重复 = 手抄表已经烂了的信号）", () => {
  assert.ok(LITERAL_ENTRIES.length > 0, "字面量必须非空（否则本文件的核对对象消失了）");
  assert.equal(new Set(LITERAL_ENTRIES).size, LITERAL_ENTRIES.length, "字面量里不许有重复条目");
});

test("A2 每个被 policy 接受的名字都在某个面有家（防第二拼写面重新长出来）", () => {
  const homeless = [...ACCEPTED].filter((name) => homeOf(name) === undefined);
  assert.deepEqual(
    homeless,
    [],
    `这些名字被 policy 放行却在白名单 / config / capabilities 三面都没有家：${homeless.join(", ")}`,
  );
});

// ================================================================ ② 派生 ⊇ 字面量，且差集可分类

test("B1 派生并集逐条包含今天的字面量（改一个名字就红）", () => {
  const dropped = [...ACCEPTED].filter((name) => !DERIVED.has(name));
  assert.deepEqual(
    dropped,
    [],
    `派生化会**丢掉**这些今天被接受的名字（那就是行为变化）：${dropped.join(", ")}`,
  );
});

test("B2 差集里每个名字都可分类：合法选项 / 有家的退役扁平拼写；三族都非空", () => {
  for (const name of DELTA) {
    assert.notEqual(homeOf(name), undefined, `${name} 在派生并集里却没有家——派生式被污染了`);
    if (RUN_TOOL_LOOP_OPTION_SET.has(name)) continue;
    // 有家、却不是合法顶层选项 ⇒ 它是「退役扁平拼写」。严格闸口必须拒绝它，否则它就不是退役的。
    assert.throws(
      () => assertRunToolLoopOptionNames({ [name]: 1 }),
      (error) => error instanceof TypeError && error.message.startsWith(`unknown runToolLoop option: ${JSON.stringify(name)}`),
      `${name} 既不在白名单又有家，就只可能是退役扁平拼写；严格闸口必须拒绝它`,
    );
  }
  // 三族各自非空：差集不是「只多出某一类」，而是三类都缺（这条才是本单的发现本身）。
  const forgotLegalOption = DELTA.filter((name) => RUN_TOOL_LOOP_OPTION_SET.has(name));
  const retiredConfigLeaf = DELTA.filter((name) => !RUN_TOOL_LOOP_OPTION_SET.has(name)
    && configLeafPath(name) !== undefined);
  const capabilitySlot = DELTA.filter((name) => !RUN_TOOL_LOOP_OPTION_SET.has(name)
    && configLeafPath(name) === undefined && capabilityLeafPath(name) !== undefined);
  assert.ok(
    forgotLegalOption.length > 0,
    "差集里必须有「白名单本来就有、字面量却忘掉」的合法选项（policy.provider 今天会被拒 = 面本身不自洽）",
  );
  assert.ok(retiredConfigLeaf.length > 0, "差集里必须有「有 config 家、字面量没有」的退役扁平拼写");
  assert.ok(capabilitySlot.length > 0, "差集里必须有「只有能力槽位、从来没有扁平拼写」的名字");
});

// ================================================================ ③ 反向证：#544 的闸门挡住并集

test("C1 反向证：`runId` 在派生并集里、不在被接受集合里，合并后闸口必须仍然拒绝它", () => {
  // 派生化 = 放行差集里的退役 config 叶子。`runId` 就是那一族的样板：它有 config 家
  // （`config.run.runId`），严格闸口拒它，而 #544 的合并后闸口收上去就是为了让引擎自己产的名字
  // 也受同一条约束（`assemblyPortBaseOptions` 曾经把 `runId` / `initialMessages` 扁平产出去）。
  assert.equal(DERIVED.has("runId"), true, "派生并集必然包含 runId（它今天仍在 config.run 里）");
  assert.equal(ACCEPTED.has("runId"), false, "今天的 policy 面不放行 runId——采纳派生并集就会放行");
  // ⚠ 这条是「行为零变化」的机器证明：谁把字面量换成并集，这里立刻红并点名 runId。
  assert.throws(
    () => assertMergedOptionNames({ provider: {}, runId: "flat-again" }),
    (error) => error instanceof TypeError
      && error.message === 'unknown runToolLoop option: "runId"'
        + " (its canonical home is config.run.runId; the flat spelling is rejected)",
    "采纳派生并集会让 #544 的合并后闸口放过 runId：那是行为变化，属于 #545 的翻译活，不属于本单",
  );
});

// ================================================================ ④ 行为级：真装配端口

test("D1 集合内每个名字都被装配口接受（真入口 `createAssemblyPort`，不读宿主端口）", () => {
  for (const name of ACCEPTED) {
    assert.doesNotThrow(
      () => createAssemblyPort(portInput({ [name]: undefined })),
      `${name} 是 policy 白名单里的名字，装配口必须放行`,
    );
  }
});

test("D2 集合外乱名逐个被拒，文案逐字（`unknown assembly policy option: \"<name>\"`）", () => {
  // 乱名从**派生并集之外**取，且不写死任何具体名字：拿三个结构性不同的假名。
  const junk = ["definitelyNotAPolicyOption", "maxTokensV2", "systemPrompt"];
  for (const name of junk) {
    assert.equal(DERIVED.has(name), false, `${name} 必须真的在派生并集之外，否则这条探针无效`);
    assert.throws(
      () => createAssemblyPort(portInput({ [name]: 1 })),
      (error) => error instanceof TypeError
        && error.message === `unknown assembly policy option: ${JSON.stringify(name)}`,
      `${name} 不是任何面的名字，必须逐字拒绝`,
    );
  }
});

test("D3 真入口 `assemblyPortOptions(input, {})`：policy 名字进得了合并树，乱名在读端口前就抛", async () => {
  const options = await assemblyPortOptions(portInput({ maxTokens: 1000 }), {});
  assert.equal(options.maxTokens, 1000, "policy.maxTokens 是 policy 面自己的拼写，必须逐字进构造期产物");
  // 乱名必须在**读任何宿主端口之前**抛（所以这里的 `modelConfig.resolve` 不会被调用）。
  let resolved = false;
  const input = portInput({ definitelyNotAPolicyOption: 1 });
  input.modelConfig = { resolve: async () => { resolved = true; return { contextWindowTokens: 1000, maxOutputTokens: 16 }; } };
  await assert.rejects(
    () => assemblyPortOptions(input, {}),
    (error) => error instanceof TypeError
      && error.message === 'unknown assembly policy option: "definitelyNotAPolicyOption"',
    "乱名必须在装配期抛，而不是等到运行期",
  );
  assert.equal(resolved, false, "名称闸口在读宿主端口之前：modelConfig.resolve 一次都不许被调");
});
