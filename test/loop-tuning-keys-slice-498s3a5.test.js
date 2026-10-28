// issue #498（S3）—— `tuning` 组的**第二刀（A5 段）**：删掉三个顶层扁平数据键
// `maxTokens` / `temperature` / `topP`，它们的规范之家是 `config.tuning.*`
// （`CONFIG_NAMESPACE_SCHEMA.tuning`，`src/loop/config-namespace.js`）。同组的 `cacheCapable`
// 已在上一片（A3）退役，钉子文件是 `test/loop-tuning-slice-498s3d.test.js`。
//
// ⚠ 这一刀**只动 `runToolLoop` 那一张面**。同一个词在别的面上照旧存在，一个字都不许动 ——
// 这是本片最容易做残的地方，所以由 **P5** 逐面钉住（下面每一条都有可执行的证据，不是散文）：
//   · `maxTokenContinuations` 是**另一个键**（家在 `config.run`，不在本刀）。整词 grep `maxTokens`
//     会把它一起捞出来；本片不迁它，P5 断言它仍可扁平写、语义一字未变。
//   · 配置文件 / 槽位面 `slots.default.maxTokens`（`src/config/env.js` 读环境变量、`bin/config.js`
//     转发、`bin/cli.js` 与 `createProviderForSlot` 构造 provider）。它从不经过名称闸口 ⇒ P5 用一次
//     真构造证明它照旧把 `max_tokens` 送出门。
//   · provider 请求字段 `maxTokens` / `temperature` / `topP`（`src/loop/provider-runner.js` 与
//     `src/messages/anthropic.js` 的读侧）。展开相把新家写回 `effectiveOptions.<扁平名>`，所以读侧
//     一行未改 ⇒ R1 用真 run 证明值真的到了请求体。
//   · 装配口 `policy.maxTokens`（`src/assembly.js`，由 #525 专管）。它同样不经过名称闸口 ⇒ P5 用
//     一次真装配证明它照旧生效。
//
// 本文件钉的是五件事：
//
//   P. **旧名反向拒绝钉**：顶层再写这三个名字 ⇒ **当场拒**，且错误文案必须**指向新家**。
//      ⚠ 断言用**逐字相等**（不是 `match`）：文案里少一个 `config.tuning.`，0.26 → 0.28 升级的宿主
//      就没了路标——「未知选项 + 接受名单」只能让他自己猜它搬去了哪。
//   P4. **混装壳的第二站：这三个键都不适用，且是机器派生的**。三个值都是标量，
//      `capabilityDestinationsForShell(<键>)` 恒为空 ⇒ 报错文案里**不许**出现 `capabilities.` 那一站。
//      对照组（`context`）证明「两站」这条机制仍然咬得住——不是把整段提示删掉也能绿。
//   P5. **专项断言**（本片工单点名要的那一格）：`maxTokenContinuations` 与**槽位面同名字段**
//      都没被本刀动过，外加装配口 `policy.maxTokens` 与 provider 请求字段两个旁证面。
//   R. **读侧不变的机制 + 行为证据**：写在 `config.tuning.*` 的值，展开相会逐字写回
//      `effectiveOptions.<扁平名>`；再用真 run 证明引擎真的把它们送进了请求体（不是「写回了但没人读」）。
//   A. **账目格派生化**：不写手抄的键数，判据全部对着符号算（白名单 = 配置面 ∩ 白名单 + 能力面
//      + 容器，`configSchemaSelfCheck` 为空，`configPathForOption` 指向 `tuning.<leaf>`）。
//      `grep -rn 'RUN_TOOL_LOOP_OPTION_NAMES.length, [0-9]' test` 必须为 0 —— 这条口径本身也在
//      本文件里被钉住（A2 扫的是整个 `test/`，含本文件自己）。
//
// 零真实 LLM（fake provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
  configPlaneOptionNames,
  optionHomeBuckets,
  configSchemaSelfCheck,
  CAPABILITY_OPTION_NAMES,
  NAMESPACE_CONTAINER_OPTION_NAMES,
} from "../src/loop/config-namespace.js";
import { capabilityDestinationsForShell } from "../src/loop/capabilities-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { assemblyPortOptions, createAssemblyPort } from "../src/assembly.js";
import { createProviderForSlot } from "../src/config/slot-provider.js";
import { runDirect as sharedRunDirect, directError as sharedDirectError } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 本片退役的三个键 → 它们的规范之家（逐字）。表只在这里出现一次，后面全部从它派生。 */
const RETIRED = [
  { key: "maxTokens", home: "tuning.maxTokens" },
  { key: "temperature", home: "tuning.temperature" },
  { key: "topP", home: "tuning.topP" },
];

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

/** 把一个 `tuning.<leaf>` 路径摊成 `config: { tuning: { <leaf>: value } }`。 */
const atHome = (home, value) => {
  const [group, leaf] = home.split(".");
  return { [group]: { [leaf]: value } };
};

// ================================================================ P. 旧名反向拒绝（一键一格）
//
// 两段：① 逐字相等的文案（含新家路径）；② 同一个值写在新家里必须**不抛**——「拒旧名」与
// 「收新家」必须同时成立，否则这条钉子只是在说「我把键弄丢了」。

for (const { key, home } of RETIRED) {
  test(`P 顶层 ${key} ⇒ 当场拒，文案逐字指向 config.${home}`, async () => {
    const error = await directError({ [key]: 1 });
    assert.equal(error instanceof TypeError, true, "旧名必须在名称闸口抛 TypeError（不是静默忽略）");
    assert.equal(
      error.message,
      `unknown runToolLoop option: ${JSON.stringify(key)} (its canonical home is config.${home};`
        + " the flat spelling is rejected)",
      `文案必须点名新家——少了 config.${home}，升级的宿主只能自己猜`,
    );
    // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（读侧不变）。
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: atHome(home, 1) });
    assert.equal(effectiveOptions[key], 1, `config.${home} 必须写回 effectiveOptions.${key}`);
  });
}

test("P2 三个键的取值区间两端都走同一条路：拒绝的是拼写，不是值", async () => {
  // 0 是合法取值（`0` 不是「没给」——`undefined` 才是），大值同理；两端都在新家被接受、扁平被拒。
  const extremes = { maxTokens: [0, 32_768], temperature: [0, 2], topP: [0, 1] };
  for (const { key, home } of RETIRED) {
    for (const value of extremes[key]) {
      const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: atHome(home, value) });
      assert.equal(effectiveOptions[key], value, `config.${home}=${value} 必须逐字写回`);
      const error = await directError({ [key]: value });
      assert.equal(error instanceof TypeError, true, `扁平 ${key}=${value} 也必须被拒`);
    }
  }
});

// ================================================================ P4. 混装壳：这三个键都不适用（机器派生）
//
// `context` / `retry` 这类壳同时容得下数据与函数，只指一站会把宿主送进第二次撞击。这三个键的值
// 都是**标量**，没有行为成员 ⇒ 文案里不许出现第二站。判据不是散文，是
// `capabilityDestinationsForShell` 的派生结果：谁给它挂了行为成员，这一格立刻红。

test("P4 三个 tuning 数据键没有行为成员 ⇒ 文案只点一站，且这条判据是派生的", async () => {
  for (const { key } of RETIRED) {
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
  }
  // 对照组：真正的混装壳仍然一句话点两站（防「把这条提示整段删掉」也能绿）。
  const mixed = await directError({ context: { budgetTokens: 10 } });
  assert.match(mixed.message, /its canonical home is config\.folding\.context/u, "混装壳第一站：数据之家");
  assert.match(mixed.message, /capabilities\./u, "混装壳第二站：行为之家");
});

// ================================================================ P5. 专项：本刀没碰的四个面
//
// 工单点名的专项断言：`maxTokenContinuations`（另一个键）与**槽位面同名字段**都没被本刀动过。
// 另加两个旁证面（装配口 `policy.maxTokens`、provider 请求字段），因为「同一个词四张面」正是
// 这一刀最容易被顺手改错的地方。

test("P5-a 专项：maxTokenContinuations 是另一个键，家在 config.run（A14 退役扁平写法后仍是另一个键）", async () => {
  // ① 名字与家：整词 grep `maxTokens` 会把它捞出来，但它属于 `config.run`，不在本刀。
  // #498 S3 A14：它自己的扁平拼写也退役了（家 = `config.run.maxTokenContinuations`），所以这里从
  // 「仍在白名单」翻成**反向钉**——两条断言仍然钉住「它与 `maxTokens` 不同物」，只是翻了一面。
  assert.equal(
    RUN_TOOL_LOOP_OPTION_NAMES.includes("maxTokenContinuations"),
    false,
    "#498 S3 A14：扁平 maxTokenContinuations 已退役（家 = config.run.maxTokenContinuations）",
  );
  assert.equal(
    RUN_TOOL_LOOP_OPTION_NAMES.includes("maxTokens"),
    false,
    "maxTokens 由 A5 退役（两条都在名单外，但家不同：run.* 与 tuning.*）",
  );
  assert.equal(
    configPathForOption("maxTokenContinuations"),
    "run.maxTokenContinuations",
    "maxTokenContinuations 的规位是 run.maxTokenContinuations（不是 tuning.*）",
  );
  assert.equal(CONFIG_NAMESPACE_SCHEMA.tuning.includes("maxTokenContinuations"), false, "它不许出现在 tuning 组里");

  // ② 规位写法逐字落到 effectiveOptions（A14 之后扁平写法被名称闸口拒，见 A14 切片测试的 P1）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { run: { maxTokenContinuations: 0 } },
  });
  assert.equal(effectiveOptions.maxTokenContinuations, 0, "config.run.maxTokenContinuations 逐字落到 effectiveOptions");

  // ③ 行为证据：预算 0 ⇒ 首个 max_tokens 响应即判用尽；预算 1 ⇒ 还能续写一次。
  //    两个值给出两个不同的终局原因，证明这条通路真的还在工作（不是「名字在、没人读」）。
  const script = [
    { content: [{ type: "text", text: "partial" }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const exhausted = await runDirect({
    provider: createFakeProvider(script),
    maxRounds: 4,
    maxTokenContinuations: 0, // 夹具入参（A14）：翻译进 `config.run.maxTokenContinuations`
  });
  assert.equal(exhausted.termination.reason, "continuation_exhausted", "预算 0 ⇒ 首发即用尽");
  const continued = await runDirect({
    provider: createFakeProvider(script),
    maxRounds: 4,
    maxTokenContinuations: 1,
  });
  assert.equal(continued.termination.reason, "end_turn", "预算 1 ⇒ 续写一次后正常收尾");
});

test("P5-b 专项：槽位面同名字段 slots.default.maxTokens 没被本刀动过（真构造，真请求体）", async () => {
  // 这是**配置文件 / 槽位面**，与 `runToolLoop` 的选项面不是同一张面：它从不经过名称闸口，
  // 所以本刀删顶层键与它无关。判据不是「我看过了」，是一次真构造 + 真请求体。
  const sent = [];
  const fetchImpl = /** @type {any} */ (async (url, options) => {
    sent.push(JSON.parse(String(options?.body ?? "{}")));
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    };
  });
  const slot = {
    endpoint: "https://slot.example.invalid/v1",
    model: "slot-model",
    apiKey: "slot-secret",
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
  };
  // 槽位面只给 maxOutputTokens ⇒ 请求体跟着它走（摊平桥接）。
  const flat = createProviderForSlot({ ...slot, fetchImpl });
  await flat.chat({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(sent[0].max_tokens, 4096, "槽位面的 maxOutputTokens 摊平桥接必须逐字不变");
  // 槽位面显式给 maxTokens ⇒ 它优先（这就是「同名不同面」的另一面：它照旧可写）。
  const explicit = createProviderForSlot({ ...slot, maxTokens: 123, fetchImpl });
  await explicit.chat({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(sent[1].max_tokens, 123, "槽位面 slots.default.maxTokens 必须仍被接受并送出门");
});

test("P5-c 旁证：装配口 policy.maxTokens 仍是另一个面（不经过名称闸口，照旧生效）", async () => {
  const provider = createFakeProvider(DONE);
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100_000, maxOutputTokens: 1024 }) },
    provider,
    tools: { definitions: [], async executeTool() {} },
    session: { id: `tuning-keys-a5-assembly-${process.pid}` },
    policy: { maxTokens: 1000 },
  });
  const options = await assemblyPortOptions(port);
  assert.equal(options.maxTokens, 1000, "装配口 policy.maxTokens 必须仍出现在构造期产物里");
  // ⚠ 走**宿主真实路径**：把端口交给引擎（`assemblyPort: port`），由引擎自己展开 policy ——
  // 把 `options` 摊回调用期反而会撞名称闸口（那是另一张面：调用期覆盖的键名闭集 = 白名单）。
  // `provider: undefined` 逐字等于「没给」（合并口径 `value !== undefined`），于是端口那份生效。
  await runDirect({ provider: undefined, assemblyPort: port });
  assert.equal(
    provider.requests[0].maxTokens,
    1000,
    "装配口给的值必须仍然到达请求体——它是另一张面，本刀一个字都没动它",
  );
});

// ================================================================ R. 读侧不变（机制 + 行为）
//
// 机制：展开相写回 `effectiveOptions.<扁平名>`；行为：引擎真的把三个值送进了请求体。
// 两者缺一都等于「键删了、功能也丢了」，而只有机制断言会漏掉「写回了但没人读」。

test("R1 真 run：config.tuning.* 的三个值逐字到达 provider 请求体", async () => {
  const provider = createFakeProvider(DONE);
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { tuning: { maxTokens: 128, temperature: 0.25, topP: 0.5 } },
  });
  assert.equal(effectiveOptions.maxTokens, 128, "展开相必须写回 effectiveOptions.maxTokens");
  assert.equal(effectiveOptions.temperature, 0.25, "展开相必须写回 effectiveOptions.temperature");
  assert.equal(effectiveOptions.topP, 0.5, "展开相必须写回 effectiveOptions.topP");

  await runDirect({
    provider,
    config: { tuning: { maxTokens: 128, temperature: 0.25, topP: 0.5 } },
  });
  const request = provider.requests[0];
  assert.equal(request.maxTokens, 128, "max_tokens 必须逐字来自 config.tuning.maxTokens");
  assert.equal(request.temperature, 0.25, "temperature 必须逐字来自 config.tuning.temperature");
  assert.equal(request.topP, 0.5, "top_p 必须逐字来自 config.tuning.topP");
});

test("R2 真 run：新家不给 ⇒ 请求体上连这三个键都没有（删键不许新造默认值）", async () => {
  // 这一格是 R1 的反面：本刀只搬**写侧拼写**，读侧的「未给就不写」口径一字未变。
  const provider = createFakeProvider(DONE);
  await runDirect({ provider });
  const request = provider.requests[0];
  for (const { key } of RETIRED) {
    assert.equal(
      Object.hasOwn(request, key),
      false,
      `${key} 未给时请求体不许出现这个键（本刀不许新造默认值）`,
    );
  }
});

// ================================================================ A. 账目格派生（不手抄键数）

test("A1 白名单 = 配置面 ∩ 白名单 + 能力面 + 容器，且 schema 自检为空", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const union = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.deepEqual(
    [...union].sort(),
    [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "四向闭合：每个顶层选项恰好落在一个家里（期望值从符号派生，不抄条数）",
  );
  assert.equal(new Set(union).size, union.length, "三个面不许重叠");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "schema 自检必须为空");
  // 三个键已离开白名单，但**叶子仍在 schema 里**（新家）；两边一起断言，防「删键顺手把叶子也删了」。
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
    "断言里不许写手抄键数：条数一律从符号派生（`RUN_TOOL_LOOP_OPTION_NAMES.length` 与三个面的并集对账）",
  );
});
