// issue #498（S3）—— `tuning` 组的**垂直切片**：删掉顶层扁平 `cacheCapable`，它的规范之家是
// `config.tuning.cacheCapable`（`CONFIG_NAMESPACE_SCHEMA.tuning`，`src/loop/config-namespace.js`）。
//
// 本文件只钉这一刀最容易被做残的四件事：
//
//   P. **旧名反向拒绝钉**：顶层再写 `cacheCapable` ⇒ **当场拒**，且错误文案必须**指向新家**。
//      ⚠ 断言用**逐字相等**（不是 `match`）：文案里少一个 `config.tuning.`，0.26 → 0.28 升级的宿主
//      就没了路标——「未知选项 + 接受名单」只能让他自己猜它搬去了哪。
//   R. **读侧不变的机制证据**：写在 `config.tuning.cacheCapable` 的值，展开相会逐字写回
//      `effectiveOptions.cacheCapable`——这正是「删了顶层键、引擎读侧一行都不用改」的原因。
//      这里既断言 `effectiveOptions` 上的扁平名还在，也用一次**真 run** 证明引擎真的吃到了值
//      （cache-capable 端点默认关掉工具结果 TTL 折叠；非 cache 端点照旧折叠）。
//   S. **混装壳的第二站：本键不适用，且是机器派生的**（不是散文声明）。`cacheCapable` 的值是
//      布尔标量，`capabilityDestinationsForShell("cacheCapable")` 恒为空 ⇒ 报错文案里**不许**
//      出现 `capabilities.` 那一站。将来若有人给它挂上行为成员，这一格会立刻红（而不是让文案
//      悄悄少一站，把宿主送进第二次撞击）。
//   A. **账目格派生化**：不写手抄的键数，判据全部对着符号算（白名单 = 配置面 ∩ 白名单 + 能力面
//      + 容器，`configSchemaSelfCheck` 为空，`configPathForOption` 指向 `tuning.cacheCapable`）。
//      `grep -rn 'RUN_TOOL_LOOP_OPTION_NAMES.length, [0-9]' test` 必须为 0 —— 这条口径本身也在
//      本文件里被钉住（见 A2：它扫的是本文件自己，防「下一片顺手抄个数字进来」）。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configPathForOption,
  configPlaneOptionNames,
  configSchemaSelfCheck,
  CAPABILITY_OPTION_NAMES,
  NAMESPACE_CONTAINER_OPTION_NAMES,
} from "../src/loop/config-namespace.js";
import { capabilityDestinationsForShell } from "../src/loop/capabilities-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
} from "../src/loop/option-normalization.js";
import { runDirect as sharedRunDirect, directError as sharedDirectError } from "./helpers/run-direct.js";
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

/** 直连路线「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => sharedDirectError({
  provider: createFakeProvider(DONE),
  executeTool: async () => "ok",
  seed: "go",
  completion: false,
  wrapup: false,
  ...extra,
});

// ================================================================ P. 旧名反向拒绝（一键一格）
//
// 两段：① 逐字相等的文案（含新家路径）；② 同一个值写在新家里必须**不抛**——「拒旧名」与
// 「收新家」必须同时成立，否则这条钉子只是在说「我把键弄丢了」。

test("P1 顶层 cacheCapable ⇒ 当场拒，文案逐字指向 config.tuning.cacheCapable", async () => {
  const error = await directError({ cacheCapable: true });
  assert.equal(error instanceof TypeError, true, "旧名必须在名称闸口抛 TypeError（不是静默忽略）");
  assert.equal(
    error.message,
    'unknown runToolLoop option: "cacheCapable" (its canonical home is config.tuning.cacheCapable;'
      + " the flat spelling is rejected)",
    "文案必须点名新家——少了 config.tuning.cacheCapable，升级的宿主只能自己猜",
  );
  // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（读侧不变）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { tuning: { cacheCapable: true } },
  });
  assert.equal(effectiveOptions.cacheCapable, true, "config.tuning.cacheCapable 必须写回 effectiveOptions.cacheCapable");
});

test("P2 两个取值都走同一条路：true / false 都在新家被接受（拒绝的是拼写，不是值）", async () => {
  for (const value of [true, false]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: { tuning: { cacheCapable: value } },
    });
    assert.equal(effectiveOptions.cacheCapable, value, `config.tuning.cacheCapable=${value} 必须逐字写回`);
  }
  // 旧名的两种取值同样都被拒（不是只拦 true 那种「顺手写的」）。
  for (const value of [true, false]) {
    const error = await directError({ cacheCapable: value });
    assert.equal(error instanceof TypeError, true, `扁平 ${value} 也必须被拒`);
  }
});

// ================================================================ R. 读侧不变（机制 + 行为）
//
// 机制：展开相写回 `effectiveOptions.<扁平名>`；行为：引擎真的按它改了折叠行为。
// 两者缺一都等于「键删了、功能也丢了」，而只有机制断言会漏掉「写回了但没人读」。

test("R1 真 run：config.tuning.cacheCapable=true ⇒ 工具结果 TTL 折叠默认关闭", async () => {
  const big = "z".repeat(20_000);
  const script = [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({
      content: [{ type: "tool_use", id: `call-${n}`, name: "scan", input: { n } }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const probe = async (config) => {
    const provider = createFakeProvider(script);
    await sharedRunDirect({
      provider,
      executeTool: async () => big,
      maxRounds: 8,
      stallDetection: false,
      completion: false,
      seed: "go",
      ...(config === undefined ? {} : { config }),
    });
    return provider.requests[2].messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result")
      .map((block) => block.content);
  };

  // 样本自证：不配 cacheCapable 时同一轮就折叠（否则「没折叠」不能归因于本键）。
  const withoutKey = await probe(undefined);
  assert.match(withoutKey[0], /【已折叠·TTL】/u, "样本自证：默认配置下第 3 发请求就该看到 TTL 折叠");

  const cacheCapable = await probe({ tuning: { cacheCapable: true } });
  assert.ok(
    cacheCapable.every((content) => content.startsWith(big)),
    "cacheCapable=true 时工具结果必须原样在场（TTL 折叠默认关闭）——这就是引擎真的读到了新家的值",
  );

  const explicitFalse = await probe({ tuning: { cacheCapable: false } });
  assert.match(explicitFalse[0], /【已折叠·TTL】/u, "cacheCapable=false 与不配同形（折叠照旧）");
});

// ================================================================ S. 混装壳：本键不适用（机器派生）
//
// #498 S3 收尾时实测到的缺陷：`context` / `retry` 这类壳同时容得下数据与函数，只指一站会把宿主
// 送进第二次撞击。本键是**布尔标量**，没有行为成员 ⇒ 文案里不许出现第二站。判据不是散文，
// 是 `CAPABILITY_SLOT_DESTINATIONS` 的派生结果：谁给它挂了行为成员，这一格立刻红。

test("S1 cacheCapable 没有行为成员 ⇒ 文案只点一站，且这条判据是派生的", async () => {
  assert.deepEqual(
    capabilityDestinationsForShell("cacheCapable"),
    [],
    "cacheCapable 不许有行为成员：一旦挂上，名称闸口的文案就必须同时点 capabilities.<group>.<leaf>（本格会红）",
  );
  const error = await directError({ cacheCapable: true });
  assert.equal(
    error.message.includes("capabilities."),
    false,
    "没有行为成员 ⇒ 不许在文案里塞第二站（那会把宿主送去做一件不存在的迁移）",
  );
  // 对照组：真正的混装壳仍然一句话点两站（防「把这条提示整段删掉」也能绿）。
  const mixed = await directError({ context: { budgetTokens: 10 } });
  assert.match(mixed.message, /its canonical home is config\.folding\.context/u, "混装壳第一站：数据之家");
  assert.match(mixed.message, /capabilities\./u, "混装壳第二站：行为之家");
});

// ================================================================ A. 账目格派生（不手抄键数）

test("A1 白名单 = 配置面 ∩ 白名单 + 能力面 + 容器，且 schema 自检为空", () => {
  const configPlane = configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES);
  const union = [...configPlane, ...CAPABILITY_OPTION_NAMES, ...NAMESPACE_CONTAINER_OPTION_NAMES];
  assert.deepEqual(
    [...union].sort(),
    [...RUN_TOOL_LOOP_OPTION_NAMES].sort(),
    "三向闭合：每个顶层选项恰好落在一个家里（期望值从符号派生，不抄条数）",
  );
  assert.equal(new Set(union).size, union.length, "三个面不许重叠");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "schema 自检必须为空");
  // 本键已离开白名单，但**叶子仍在 schema 里**（新家）；两边一起断言，防「删键顺手把叶子也删了」。
  assert.equal(
    RUN_TOOL_LOOP_OPTION_NAMES.includes("cacheCapable"),
    false,
    "cacheCapable 必须已离开顶层白名单",
  );
  assert.equal(
    CONFIG_NAMESPACE_SCHEMA.tuning.includes("cacheCapable"),
    true,
    "cacheCapable 必须仍在 CONFIG_NAMESPACE_SCHEMA.tuning 里（删顶层键 ≠ 删叶子）",
  );
  assert.equal(configPathForOption("cacheCapable"), "tuning.cacheCapable", "规位路径逐字为 tuning.cacheCapable");
});

test("A2 本仓库 test/ 里不许再出现手抄的顶层键数（口径：`RUN_TOOL_LOOP_OPTION_NAMES.length, <数字>`）", () => {
  // 判据是「没有这个形状」，所以扫描**本文件自己**也算：下一片顺手抄个数字进来会在这里红。
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const handCopied = /RUN_TOOL_LOOP_OPTION_NAMES\.length,\s*\d/u;
  assert.equal(
    handCopied.test(self),
    false,
    "断言里不许写手抄键数：条数一律从符号派生（`RUN_TOOL_LOOP_OPTION_NAMES.length` 与三个面的并集对账）",
  );
  // 同样的形状也不许出现在断言文案的期望值位置上（`assert.equal(… .length, 57)` 是它的兄弟形态）。
  assert.equal(
    /assert\.(equal|strictEqual)\([^)]*RUN_TOOL_LOOP_OPTION_NAMES\.length\s*,\s*\d/u.test(self),
    false,
    "`assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.length, <数字>)` 同样是手抄键数",
  );
});
