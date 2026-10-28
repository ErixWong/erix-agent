// issue #498（S3）—— `guard` 组的**垂直切片**：删掉三个顶层扁平数据键
// `finalGuardMaxRetries` / `finalGuardTimeoutMs` / `finalGuardExtend`，它们的规范之家是
// `config.guard.*`（`CONFIG_NAMESPACE_SCHEMA.guard`，`src/loop/config-namespace.js`）。
//
// ⚠ 这一刀**不含** `finalGuard`：它的值必须是函数，家是 `capabilities.hooks.finalGuard`，
// 由 **S9** 退役。`finalGuardVerdict` 是**引擎内部键**（宿主既不许写、也没有配置之家）——
// 两者都由本文件的 **P5** 逐条钉住「没被本刀动过」，防止下一片顺手把它们一起收掉。
//
// 本文件只钉这一刀最容易被做残的五件事：
//
//   P. **旧名反向拒绝钉**：顶层再写这三个名字 ⇒ **当场拒**，且错误文案必须**指向新家**。
//      ⚠ 断言用**逐字相等**（不是 `match`）：文案里少一个 `config.guard.`，0.26 → 0.28 升级的宿主
//      就没了路标——「未知选项 + 接受名单」只能让他自己猜它搬去了哪。
//   P4. **混装壳的第二站：这三个键都不适用，且是机器派生的**（不是散文声明）。三个值都是标量，
//      `capabilityDestinationsForShell(<键>)` 恒为空 ⇒ 报错文案里**不许**出现 `capabilities.` 那一站。
//      对照组（`context`）证明「两站」这条机制仍然咬得住——不是把整段提示删掉也能绿。
//   P5. **专项断言**：`finalGuard`（hook，S9 才退役）与 `finalGuardVerdict`（引擎内部键）
//      **没被本刀动过**。三条一起断言：`finalGuard` 仍被接受且无配置之家；`finalGuardVerdict`
//      仍被拒且**没有**配置之家（所以文案里不许出现 `canonical home`）；`guard` schema 组里
//      只有这三个数据叶子。
//   R. **读侧不变的机制 + 行为证据**：写在 `config.guard.*` 的值，展开相会逐字写回
//      `effectiveOptions.<扁平名>`——这正是「删了顶层键、引擎读侧一行都不用改」的原因。三个键各跑
//      一次**真 run**，证明引擎真的吃到了值（不是「写回了但没人读」）。
//   A. **账目格派生化**：不写手抄的键数，判据全部对着符号算（白名单 = 配置面 ∩ 白名单 + 能力面
//      + 容器，`configSchemaSelfCheck` 为空，`configPathForOption` 指向 `guard.<leaf>`）。
//      `grep -rn 'RUN_TOOL_LOOP_OPTION_NAMES.length, [0-9]' test` 必须为 0 —— 这条口径本身也在
//      本文件里被钉住（A2 扫的是整个 `test/`，含本文件自己）。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。

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
import { runDirect as sharedRunDirect, directError as sharedDirectError } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 本片退役的三个键 → 它们的规范之家（逐字）。表只在这里出现一次，后面全部从它派生。 */
const RETIRED = [
  { key: "finalGuardMaxRetries", home: "guard.finalGuardMaxRetries" },
  { key: "finalGuardTimeoutMs", home: "guard.finalGuardTimeoutMs" },
  { key: "finalGuardExtend", home: "guard.finalGuardExtend" },
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

/** 把一个 `guard.<leaf>` 路径摊成 `config: { guard: { <leaf>: value } }`。 */
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
    assert.equal(
      effectiveOptions[key],
      1,
      `config.${home} 必须写回 effectiveOptions.${key}`,
    );
  });
}

test("P2 三个键的两种取值都走同一条路：拒绝的是拼写，不是值", async () => {
  // 布尔键 `finalGuardExtend` 的两个取值都在新家被接受。
  for (const value of [true, false]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: atHome("guard.finalGuardExtend", value),
    });
    assert.equal(effectiveOptions.finalGuardExtend, value, `config.guard.finalGuardExtend=${value} 必须逐字写回`);
    const error = await directError({ finalGuardExtend: value });
    assert.equal(error instanceof TypeError, true, `扁平 ${value} 也必须被拒`);
  }
  // 数字键：0 也是合法值（`0` 不是「没给」——`undefined` 才是）。
  for (const [key, home] of [["finalGuardMaxRetries", "guard.finalGuardMaxRetries"], ["finalGuardTimeoutMs", "guard.finalGuardTimeoutMs"]]) {
    for (const value of [0, 60_000]) {
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

test("P4 三个 guard 数据键没有行为成员 ⇒ 文案只点一站，且这条判据是派生的", async () => {
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

// ================================================================ P5. 专项：本刀没碰 `finalGuard` / `finalGuardVerdict`

test("P5 专项断言：finalGuard（hook）与 finalGuardVerdict（内部键）都没被本刀动过", async () => {
  // ① `finalGuard` 仍是活选项（顶层扁平照收）：它的值是函数，本刀一个字都不许动它。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("finalGuard"), true, "finalGuard 必须仍在白名单（S9 才退役）");
  assert.equal(
    configPathForOption("finalGuard"),
    undefined,
    "finalGuard 没有配置之家（config 不许有函数值）：它的家是 capabilities.hooks.finalGuard",
  );
  assert.equal(await directError({ finalGuard: async () => ({ action: "accept" }) }), null, "顶层 finalGuard 必须仍被接受");

  // ② `finalGuardVerdict` 是引擎内部键：宿主写了照旧拒，而且**没有**配置之家 ⇒ 文案里不许出现
  //    `canonical home`（有家才指路；没家就别编一个）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("finalGuardVerdict"), false, "finalGuardVerdict 从来不是宿主可写的选项");
  assert.equal(configPathForOption("finalGuardVerdict"), undefined, "finalGuardVerdict 不是配置叶子（不许被顺手迁进来）");
  const verdictError = await directError({ finalGuardVerdict: "verified" });
  assert.equal(verdictError instanceof TypeError, true);
  assert.equal(
    verdictError.message,
    'unknown runToolLoop option: "finalGuardVerdict"',
    "内部键没有配置之家 ⇒ 文案逐字维持旧形（不许指路）",
  );

  // ③ `guard` schema 组里只有这三个数据叶子：`finalGuard` / `finalGuardVerdict` 都不许混进去。
  assert.deepEqual(
    [...CONFIG_NAMESPACE_SCHEMA.guard].sort(),
    RETIRED.map(({ key }) => key).sort(),
    "config.guard 组必须恰好是这三个数据叶子（finalGuard 属能力面、finalGuardVerdict 不是配置面）",
  );
});

// ================================================================ R. 读侧不变（机制 + 行为）
//
// 机制：展开相写回 `effectiveOptions.<扁平名>`；行为：引擎真的按它改了收尾行为。
// 两者缺一都等于「键删了、功能也丢了」，而只有机制断言会漏掉「写回了但没人读」。

test("R1 真 run：config.guard.finalGuardMaxRetries=2 ⇒ guard 被叫 3 次、attempt 1→2→3、guardBudget=2", async () => {
  const seen = [];
  const result = await runDirect({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "draft-1" }], stopReason: "end_turn" },
      { times: 10, content: [{ type: "text", text: "draft-again" }], stopReason: "end_turn" },
    ]),
    maxRounds: 12,
    config: atHome("guard.finalGuardMaxRetries", 2),
    capabilities: {
      hooks: {
        finalGuard: async (payload) => {
          seen.push({ attempt: payload.attempt, budget: payload.guardBudget });
          return { action: "revise", message: "请核实" };
        },
      },
    },
  });
  assert.deepEqual(seen.map((entry) => entry.attempt), [1, 2, 3], "上限 = 1 次原判 + 2 次 revise");
  assert.deepEqual(seen.map((entry) => entry.budget), [2, 2, 2], "guardBudget 必须逐字等于新家里的值");
  assert.equal(result.verification.reason, "max_retries", "耗尽重试后的裁决不变");
});

test("R2 真 run：config.guard.finalGuardTimeoutMs=5 ⇒ guard 卡住时 verification=error/timeout", async () => {
  const result = await runDirect({
    provider: createFakeProvider([{ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }]),
    maxRounds: 2,
    config: atHome("guard.finalGuardTimeoutMs", 5),
    capabilities: { hooks: { finalGuard: async () => new Promise(() => {}) } },
  });
  assert.equal(result.verification.status, "error");
  assert.equal(result.verification.reason, "timeout", "5ms 的预算必须真的生效（不是被默认 30s 吞掉）");
});

test("R3 真 run：config.guard.finalGuardExtend=true ⇒ max_rounds_cap + revise 时补跑一轮并 verified", async () => {
  const events = [];
  const executed = [];
  let guardCalls = 0;
  const result = await runDirect({
    provider: createFakeProvider([
      { content: [{ type: "tool_use", id: "w1", name: "noop", input: {} }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "强制收尾" }], stopReason: "end_turn" },
      { content: [{ type: "tool_use", id: "fix", name: "noop", input: {} }], stopReason: "tool_use" },
      {
        content: [{ type: "text", text: JSON.stringify({ done: true, summary: "已补做", output: "完成" }) }],
        stopReason: "end_turn",
      },
      { times: 12, content: [{ type: "text", text: "idle" }], stopReason: "end_turn" },
    ]),
    maxRounds: 1,
    // 显式给全扩轮参数：默认 step 是 max(8, maxRounds/2)，不显式给的话「抬到多少」会随 maxRounds 漂。
    reflection: { enabled: true, extensionStep: 2, maxExtensions: 2, maxRoundsCap: 8 },
    config: atHome("guard.finalGuardExtend", true),
    executeTool: async (call) => {
      executed.push(call.id);
      return "ok";
    },
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          return guardCalls === 1 ? { action: "revise", message: "还差一步" } : { action: "accept" };
        },
        onEvent: (event) => events.push(event),
      },
    },
  });
  const extendEvents = events.filter((event) => event.type === "final_guard_extend");
  assert.equal(extendEvents.length, 1, "opt-in 必须真的触发了补跑桥（事件是唯一可断言的外部证据）");
  assert.deepEqual(executed, ["w1", "fix"], "模型必须真的补做了那一轮");
  assert.equal(result.verification.status, "verified", "第二次 accept ⇒ verified");
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
