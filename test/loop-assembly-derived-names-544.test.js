// issue #544 —— 装配面不再产已被 S3 退役的扁平名，并把名称闸口收到「合并后表示」。
//
// 病根（实测）：`assemblyPortBaseOptions`（`src/assembly.js`）仍产两个已退役的扁平名——
// `runId: port.session.id`（A20 从白名单删掉）与 `initialMessages: port.session.initialMessages`
// （S3 第一片就退役了）。而名称闸口只校**宿主显式写的**选项：于是同一份选项树有两种合法性——
// 宿主写 `{ runId: "x" }` 当场抛，走 `assemblyPort` 时引擎自己往树里塞同一个键却照跑。
//
// 裁决（甲）：装配面只产规范面的键。乙（先收闸口）会让引擎自己成为非法拼写的生产者而直接跑
// 不起来，所以收闸口只能**当验收**：改完之后把闸口从 explicitOptions 收到合并后的表示。
//
// 本文件钉六件事（账目全部派生，不手抄键名）：
//   A. 真端口实跑：装配路线跑通（`end_turn`），端口种子历史真的进了 provider 请求，端口 run
//      identity 真的到达账本的键上（`store.load(id)` 取回记录）。
//   B. 合并后表示的**名称面**：从 `assemblyPortOptions` 产物 + 显式选项派生出的每个名字都在
//      `RUN_TOOL_LOOP_OPTION_NAMES` 里——不硬编码 `runId` / `initialMessages`。
//   C. 闸口真的收在合并后表示上：把退役的扁平名塞进合并树 ⇒ 同一条拒绝文案（并点名新家）。
//   D. 调用级 `config` 整棵覆盖**不许**抹掉端口的身份叶（`runId` 的耐久性与扁平时代一致）。
//   E. `config_source_override` 事件数不增：端口叶与 `policy.config` 撞车仍然恰好一条。
//   F. 反向证：把 `runId` 改回扁平产出，B / C 两条派生断言必然红（变异实验，见报告）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  assemblyPortOptions,
  assertMergedOptionNames,
  collectAssemblyDerivedConfigConflicts,
  createAssemblyPort,
} from "../src/assembly.js";
import { configPathForOption } from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  RUN_TOOL_LOOP_OPTION_SET,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const SEED = [{ role: "user", content: "端口种子" }];

/** 最小合法装配端口（`session.id` / `session.initialMessages` 是本片的两条派生叶）。 */
function makePort(extra = {}) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: createFakeProvider(DONE),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "derived-544", initialMessages: SEED },
    ...extra,
  });
}

/** 端口产物的**写侧拼写**键集（= 合并后表示里引擎贡献的那一半）。 */
async function producedNames(port) {
  return Object.keys(await assemblyPortOptions(port));
}

// ================================================================ A. 真端口实跑

test("A1 装配路线真跑：end_turn + 端口种子历史到达 provider 请求", async () => {
  const port = makePort();
  // #498 S3 A23a：`completion` 的规位家是 `config.run.completion`（扁平拼写仍可写，但本片在搬家）。
  const result = await runToolLoop({ assemblyPort: port, config: { run: { completion: false } } });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.finalText, "ok");
  assert.deepEqual(
    port.provider.requests[0].messages.map((message) => [message.role, message.content]),
    [["user", "端口种子"]],
    "session.initialMessages 必须照旧成为种子历史（拼写搬家，读侧一字未动）",
  );
});

test("A2 端口的 run identity 真的到达账本的键上（config.run.runId 不是「展开了没人读」）", async () => {
  const store = createMemoryTranscriptStore();
  const port = makePort({ store });
  const result = await runToolLoop({ assemblyPort: port, config: { run: { completion: false } } });
  assert.equal(result.termination.reason, "end_turn");
  const records = await store.load("derived-544");
  assert.ok(records.length > 0, "session.id 必须真的到 `appendRound(runId, …)`");
  assert.deepEqual(await store.load("derived-544-other"), [], "反向：换个 id 读同一份账本必须是空");
});

// ================================================================ B. 合并后表示的名称面

test("B1 合并后表示里没有任何不在白名单内的名字（键集从 RUN_TOOL_LOOP_OPTION_NAMES 派生）", async () => {
  const port = makePort();
  const produced = await producedNames(port);
  // 探针自证：产物不是空的，而且本片搬走的两个键**确实**不在其中（这条用名字，因为它就在断言
  // 「搬走了」；下一条的判据则完全派生，不许点名）。
  assert.ok(produced.length >= 5, `端口产物至少五件（实测 ${produced.join(",")}）`);
  for (const retired of ["runId", "initialMessages"]) {
    assert.equal(produced.includes(retired), false, `#544：装配面不许再产扁平 ${retired}`);
  }
  // 判据（派生，不点名）：合并后表示的每个名字都是合法 loop 选项名。
  const illegal = produced.filter((name) => !RUN_TOOL_LOOP_OPTION_SET.has(name));
  assert.deepEqual(
    illegal,
    [],
    `装配面产出的名字必须都在 RUN_TOOL_LOOP_OPTION_NAMES 里（越界：${illegal.join(", ")}）`,
  );
  // 同一份树走一遍真规范化：装配路线 + 调用级显式键都算在内，闸口不许抛。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    assemblyPort: port,
    // #498 S3 A21: `maxRounds` retired its flat spelling (home `config.run.maxRounds`).
    // #498 S3 A23a: `completion` joins the same `config.run` subtree.
    config: { run: { maxRounds: 1, completion: false } },
  });
  // 反向那半边：展开相**确实**把两条叶写回成扁平键（读侧不变的证据），所以上面那条判据如果
  // 直接套在 `effectiveOptions` 上会红——这正是它必须校**展开前**的合并树的原因。
  assert.deepEqual(effectiveOptions.initialMessages, SEED);
  assert.equal(effectiveOptions.runId, "derived-544");
});

test("B2 白名单里没有任何退役名回流（派生：两个键都不在白名单，且它们在 config 里仍有家）", () => {
  for (const retired of ["runId", "initialMessages"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(retired), false, `${retired} 不许回到白名单`);
    const home = configPathForOption(retired);
    assert.equal(typeof home, "string", `${retired} 必须仍有 config 家（删扁平拼写 ≠ 删叶子）`);
  }
});

// ================================================================ C. 闸口收在合并后表示上

test("C1 合并树里出现退役扁平名 ⇒ 当场拒，文案点名它的新家（同一条 canonical 拒绝）", () => {
  // 这条就是「把 runId 改回扁平产出」会撞上的那道闸——它现在在**合并后**的表示上跑，
  // 所以引擎自己产的名字与宿主写的名字受同一套合法性约束。
  assert.throws(
    () => assertMergedOptionNames({ provider: {}, runId: "flat-again" }),
    (error) => error instanceof TypeError
      && error.message === 'unknown runToolLoop option: "runId"'
        + ` (its canonical home is config.${configPathForOption("runId")}; the flat spelling is rejected)`,
  );
  assert.throws(
    () => assertMergedOptionNames({ initialMessages: SEED }),
    (error) => error instanceof TypeError
      && error.message.startsWith('unknown runToolLoop option: "initialMessages"'),
  );
  // 正向：合法名一个都不拦（含容器与端口派生的那几个）。
  assert.doesNotThrow(() => assertMergedOptionNames({ config: {}, session: {}, provider: {} }));
  // #545：`policy` 面的豁免**摘掉了**——它不再携带退役扁平名（叶子名一律翻译进 `config`），
  // 所以这道闸对合并树里的每一个名字一视同仁。这一格是本单「洞已关闭」的直接反向证：
  assert.throws(
    () => assertMergedOptionNames({ maxTokens: 100 }),
    (error) => error instanceof TypeError
      && error.message.startsWith('unknown runToolLoop option: "maxTokens"'),
    "policy 的豁免没了：合并树里的退役扁平名必须被拒（哪怕它来自 policy）",
  );
});

test("C2 闸口相位：显式拼写仍然在任何端口被读之前抛（phase ① 没被搬走）", async () => {
  let touched = false;
  const port = new Proxy(makePort(), {
    get(target, key) {
      touched = true;
      return target[key];
    },
  });
  await assert.rejects(
    runToolLoop({ assemblyPort: port, runId: "flat-again" }),
    (error) => error instanceof TypeError && error.message.startsWith('unknown runToolLoop option: "runId"'),
  );
  assert.equal(touched, false, "名称闸口必须先于任何宿主端口被读");
});

// ================================================================ D. 覆盖耐久性

test("D1 调用级 config 整棵覆盖不许抹掉端口的身份叶（扁平时代的耐久性逐字保留）", async () => {
  const store = createMemoryTranscriptStore();
  const port = makePort({ store });
  const result = await runToolLoop({
    assemblyPort: port,
    // 宿主只关心一个叶子，却整棵交出了 `config`（既有语义：整棵覆盖 policy.config）。
    config: { input: { wrapup: false }, run: { completion: false } },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.ok((await store.load("derived-544")).length > 0, "runId 必须活过整棵覆盖（以前扁平键就是这么活下来的）");
  assert.deepEqual(
    port.provider.requests[0].messages.map((message) => message.content),
    ["端口种子"],
    "种子历史同样必须活过整棵覆盖",
  );
});

test("D2 宿主自己的值仍然赢（per leaf）：config.input.messages 覆盖端口种子", async () => {
  const hostSeed = [{ role: "user", content: "宿主种子" }];
  const port = makePort();
  const result = await runToolLoop({
    assemblyPort: port,
    config: { input: { messages: hostSeed }, run: { completion: false } },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(
    port.provider.requests[0].messages.map((message) => message.content),
    ["宿主种子"],
    "优先级一字未动：config 侧赢端口派生值",
  );
});

// ================================================================ E. 事件数不增

test("E1 端口叶与 policy.config 撞车 ⇒ 恰好一条冲突（path / key 与扁平时代逐字相同）", async () => {
  const port = makePort({ policy: { config: { input: { messages: [{ role: "user", content: "policy 种子" }] } } } });
  assert.deepEqual(
    collectAssemblyDerivedConfigConflicts(port),
    [{ path: "input.messages", key: "initialMessages" }],
    "一个旋钮两个来源 ⇒ 一条冲突（不是两条、不是零条）",
  );
  // 同值不算冲突（`undefined` / 等值都逐字等于「没冲突」）。
  const same = makePort({ policy: { config: { input: { messages: SEED } } } });
  assert.deepEqual(collectAssemblyDerivedConfigConflicts(same), [], "等值不许被报成冲突");
  // 真规范化：事件清单里那一条仍然只出现一次（按 path 去重）。
  const { configConflicts } = await normalizeRunToolLoopOptions({
    assemblyPort: port,
    config: { input: { messages: [{ role: "user", content: "调用级种子" }] }, run: { completion: false } },
  });
  assert.deepEqual(configConflicts, [{ path: "input.messages", key: "initialMessages" }]);
});

test("E2 没撞车时一条冲突都不发（不许多发事件）", async () => {
  const { configConflicts } = await normalizeRunToolLoopOptions({ assemblyPort: makePort(), config: { run: { completion: false } } });
  assert.deepEqual(configConflicts, [], "端口单方面给值不是冲突");
});
