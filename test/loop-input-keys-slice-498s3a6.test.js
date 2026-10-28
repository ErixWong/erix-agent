// issue #498（S3）—— `input` 组的**收尾刀（A6 段）**。
//
// 工单点名三个键：`system` / `wrapup` / `tools`。本片**只退役了 `system`**（家 =
// `config.input.system`，`CONFIG_NAMESPACE_SCHEMA.input`），另两个**原样退回**，理由都在下面
// 用可执行的证据钉住，不是散文：
//
//   · `tools` —— **闸口二（函数成员可达性）没过**。宿主今天经扁平 `tools` 能交进去的每一种形状里，
//     「条目带函数成员」（`handler` / `validate` / `execute` / 甚至 `inputSchema` 里的函数）这一族
//     **扁平可达、规位不可达**：`config` 只装数据（`collectFunctionPaths`，见
//     `src/loop/config-namespace.js` 文件头约束 4），函数值 intake 当场拒。这就是 #520 同类的
//     **静默收窄**（`timing` 那刀发现 `retry.sleepImpl` 宿主根本不可达，最后开了 #520）。按工单裁决
//     `tools` **退回不删**，本文件把「现在是什么样」逐字钉住（G 段）——将来谁要删它，先过这一格。
//   · `wrapup` —— 本片**没做**（时间预算）。它的写点摊在 ~35 个测试文件 / ~106 处 `wrapup: false`
//     夹具写点上（删键后全量红 **189** 格），一次改拼写等于重演 #521 的 475 写点问题；正确做法是先
//     落一条「夹具级翻译」的前置刀（`test/helpers/run-direct.js` 的 `withSeed` 就是那样收口的），
//     再删键。S 段把「`input` 组还剩哪两个扁平孪生」机器派生出来，于是「没做完」是可见的，不靠记忆。
//
// ⚠ 这一刀**只动 `runToolLoop` 那一张面**。同一个词在别的面上照旧存在，一个字都不许动 —— 由 P5
// 逐面钉住（每条都有可执行证据）：
//   · `systemPrompt` / `systemPromptMode` / `systemPromptFile`：**独立选项**（#505 那两片），
//     不是 `runToolLoop` 的顶层键，也不在本刀；
//   · provider 请求字段 `system`（`src/messages/anthropic.js`）与消息转换入参
//     `canonicalToAnthropicRequest({ system })`：不是选项面，从不经过名称闸口；
//   · `wrapup` 组的**嵌套容器**（`config.run.reflection.wrapupNormalize` 那一带）与顶层 `wrapup`
//     是两个东西；顶层 `wrapup` 本片退回、仍是活选项；
//   · `./tools` 子路径导出 / `createToolRegistry` / 槽位面同名字段：都不是顶层选项。
//
// 零真实 LLM（fake provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_NAMESPACE_SCHEMA,
  configOptionNameForLeaf,
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
import { canonicalToOpenAIMessages, canonicalToolsToOpenAI } from "../src/messages/canonical.js";
import { canonicalToAnthropicRequest } from "../src/messages/anthropic.js";
import { createToolRegistry } from "../src/tools/index.js";
import { runDirect as sharedRunDirect, directError as sharedDirectError } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 本片退役的键 → 规范之家（逐字）。表只在这里出现一次，后面全部从它派生。 */
const RETIRED = [{ key: "system", home: "input.system" }];

/** 本片**退回不删**的键（理由见文件头；S / G 两段把它们钉住）。 */
const RETURNED = ["wrapup", "tools"];

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

/** 把一个 `input.<leaf>` 路径摊成 `config: { input: { <leaf>: value } }`。 */
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
    const error = await directError({ [key]: "SYS" });
    assert.equal(error instanceof TypeError, true, "旧名必须在名称闸口抛 TypeError（不是静默忽略）");
    assert.equal(
      error.message,
      `unknown runToolLoop option: ${JSON.stringify(key)} (its canonical home is config.${home};`
        + " the flat spelling is rejected)",
      `文案必须点名新家——少了 config.${home}，升级的宿主只能自己猜`,
    );
    // 同一个值写在新家里 ⇒ 不抛，且展开相把它写回扁平名（读侧不变）。
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: atHome(home, "SYS") });
    assert.equal(effectiveOptions[key], "SYS", `config.${home} 必须写回 effectiveOptions.${key}`);
  });
}

test("P2 取值区间两端都走同一条路：拒绝的是拼写，不是值", async () => {
  // `""` 是合法取值（空系统提示 ≠ 「没给」——`undefined` 才是），长文本同理：两端都在新家被接受、
  // 扁平被拒。少这一格，最容易漏的是「空串被当成没给」。
  for (const value of ["", "x".repeat(20_000)]) {
    const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: atHome("input.system", value) });
    assert.equal(effectiveOptions.system, value, `config.input.system 必须逐字写回（长度 ${value.length}）`);
    const error = await directError({ system: value });
    assert.equal(error instanceof TypeError, true, `扁平 system（长度 ${value.length}）也必须被拒`);
  }
  // `undefined` 不是「没给」的逃生口：键名不在白名单里，写 `system: undefined` 照样拒。
  const undefinedError = await directError({ system: undefined });
  assert.equal(undefinedError instanceof TypeError, true, "system: undefined 也必须被拒（键名闸口只看名字）");
});

test("P3 写错位置各有自己的文案：config 顶层 / 未知叶子", async () => {
  // 把扁平键写在 `config` 顶层（`config.system`）是最常见的误写之一，它有自己的文案，且指向规位。
  const topLevel = await directError({ config: { system: "SYS" } });
  assert.equal(
    topLevel.message,
    "config.system: flat option keys are not accepted at the top of config"
      + " (write config.input.system instead)",
    "写在 config 顶层必须被教成 config.input.system",
  );
  // 未知叶子：报未知 + 枚举该组接受名单（`system` 已在名单里，这里用一个真不存在的名字）。
  const unknownLeaf = await directError({ config: { input: { systemPropmt: "SYS" } } });
  assert.match(unknownLeaf.message, /unknown config\.input option: "systemPropmt"/u, "未知叶子必须点名");
  assert.match(unknownLeaf.message, /accepted: system, cacheStablePrefix/u, "必须枚举该组接受名单");
});

// ================================================================ P4. 混装壳：这个键不适用（机器派生）
//
// `context` / `retry` 这类壳同时容得下数据与函数，只指一站会把宿主送进第二次撞击。`system` 的值是
// **标量**，没有行为成员 ⇒ 文案里不许出现第二站。判据不是散文，是 `capabilityDestinationsForShell`
// 的派生结果：谁给它挂了行为成员，这一格立刻红。

test("P4 system 没有行为成员 ⇒ 文案只点一站，且这条判据是派生的", async () => {
  for (const { key } of RETIRED) {
    assert.deepEqual(
      capabilityDestinationsForShell(key),
      [],
      `${key} 不许有行为成员：一旦挂上，名称闸口的文案就必须同时点 capabilities.<group>.<leaf>（本格会红）`,
    );
    const error = await directError({ [key]: "SYS" });
    assert.equal(
      error.message.includes("capabilities."),
      false,
      "没有行为成员 ⇒ 不许在文案里塞第二站（那会把宿主送去做一件不存在的迁移）",
    );
    // 函数值写在新家里同样**只点一站**：`system` 是配置面的数据键，没有能力面之家，文案直说这件事。
    const fnError = await directError({ config: atHome("input.system", () => {}) });
    assert.equal(
      fnError.message,
      "config.input.system is not accepted: \"system\" is a function, and the config namespace"
        + " holds data only (the config subtree must survive a JSON round-trip unchanged)"
        + " — there is no capability home for it: \"system\" is a data key of the config namespace,"
        + " so pass plain data (host callbacks belong under capabilities.hooks.<name>)",
      "数据键里的函数值必须直说「没有能力面之家」，不许含糊地指一个不存在的地方",
    );
  }
  // 对照组：真正的混装壳仍然一句话点两站（防「把这条提示整段删掉」也能绿）。
  const mixed = await directError({ context: { budgetTokens: 10 } });
  assert.match(mixed.message, /its canonical home is config\.folding\.context/u, "混装壳第一站：数据之家");
  assert.match(mixed.message, /capabilities\./u, "混装壳第二站：行为之家");
});

// ================================================================ P5. 专项：本刀没碰的四个面
//
// 工单点名：`systemPrompt` / `system` 文案常量、`tools` 的 `./tools` 子路径导出、`createToolRegistry`、
// 槽位面同名字段、`wrapup` 的嵌套容器 —— 都不是 `runToolLoop` 的顶层选项。整词 grep 会把它们一起
// 捞出来，所以逐面钉。

test("P5-a 专项：systemPrompt / systemPromptMode / systemPromptFile 是独立选项，不在本刀", async () => {
  // #505 那两片（`systemPromptMode` / `systemPromptFile`）是**独立选项**，从来不是本刀的对象：
  // 它们既没有配置面之家，也不是白名单成员——本刀删 `system` 不许顺手碰到它们的存在性判断。
  for (const name of ["systemPrompt", "systemPromptMode", "systemPromptFile"]) {
    assert.equal(configPathForOption(name), undefined, `${name} 不许有配置面之家（它不是本组的叶子）`);
    assert.equal(
      CONFIG_NAMESPACE_SCHEMA.input.includes(name),
      false,
      `${name} 不许被塞进 input 组——它是独立选项，不是 system 的别名`,
    );
  }
  // 反面：`system` 本尊的规位仍是 `input.system`，且叶子名逐字等于顶层键名（无重命名）。
  assert.equal(configPathForOption("system"), "input.system");
  assert.equal(configOptionNameForLeaf("input", "system"), "system", "叶子名逐字等于顶层键名");
});

test("P5-b 专项：provider 请求字段 system 与消息转换入参没被本刀动过（真构造）", async () => {
  // 这是**协议面**，不是选项面：它从不经过名称闸口，所以删顶层键与它无关。判据不是「我看过了」，
  // 是一次真构造 + 真 payload。
  const anthropic = canonicalToAnthropicRequest({
    system: "SYS",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 16,
  });
  assert.equal(anthropic.system, "SYS", "Anthropic 的 system 字段必须仍是那个字符串");
  // OpenAI 侧没有顶层 `system` 字段：它是 messages 里的一条 `role:"system"`。同一句话证明
  // 「词在别的面上」不靠记忆——这里只钉本片没碰它（入参形状与输出形状都不变）。
  const openaiMessages = canonicalToOpenAIMessages("SYS", [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  assert.equal(openaiMessages[0].role, "system", "OpenAI 侧仍是 messages 里的一条 role:system");
  assert.equal(openaiMessages[0].content, "SYS");
});

test("P5-c 专项：顶层 wrapup 仍是活选项；wrapup 组的嵌套容器是另一个东西", async () => {
  // 整词 grep `wrapup` 会把两件东西一起捞出来：
  //   ① 顶层 `wrapup`（布尔，家 `config.input.wrapup`）——本片**退回不删**，仍是活选项；
  //   ② 反思收尾的**嵌套容器**：`config.run.reflection.wrapupNormalize`（`run.reflection` 那一带）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("wrapup"), true, "顶层 wrapup 本片退回 ⇒ 必须仍在白名单");
  assert.equal(configPathForOption("wrapup"), "input.wrapup", "顶层 wrapup 的规位在 input 组");
  assert.equal(
    CONFIG_NAMESPACE_SCHEMA.run.includes("reflection"),
    true,
    "reflection 是 config.run 的叶子（嵌套容器的壳），与顶层 wrapup 无关",
  );
  // 行为证据：扁平 `wrapup:false` 仍照旧生效（关掉收尾协议 ⇒ 系统提示里没有那段 JSON 信封）。
  const provider = createFakeProvider(DONE);
  await runDirect({ provider, wrapup: false, config: { input: { system: "SYS", cacheStablePrefix: false } } });
  assert.equal(provider.requests[0].system, "SYS", "wrapup:false ⇒ 系统提示不被追加收尾协议");
  // 同一份 run 开回默认（`wrapup` 未给 = true）⇒ 收尾协议回来。两个方向都在，才叫「仍是活选项」。
  const withWrapup = createFakeProvider(DONE);
  await sharedRunDirect({
    provider: withWrapup,
    executeTool: async () => "ok",
    seed: "go",
    completion: false,
    config: { input: { system: "SYS", cacheStablePrefix: false } },
  });
  assert.match(withWrapup.requests[0].system, /任务完成或需要给出结论时/u, "默认 wrapup:true 仍追加收尾协议");
});

test("P5-d 专项：./tools 子路径导出与 createToolRegistry 不是顶层选项", async () => {
  // `tools` 这个**词**在三张面上：顶层选项键（`config.input.tools`）、`erix-agent/tools` 子路径、
  // 以及 `createToolRegistry` 这个符号。后两张面本片一个字都没动。
  const registry = createToolRegistry([]);
  assert.equal(typeof registry.executeTool, "function", "工具注册表仍是同一个实现（本片不动能力面）");
  assert.equal(typeof registry.resolveTools, "function");
  assert.equal(
    configPathForOption("tools"),
    "input.tools",
    "顶层 tools 的规位仍是 input.tools（本片退回，不删）",
  );
});

// ================================================================ G. 闸口二：`tools` 的函数成员可达性（as-is 钉）
//
// **这是本片最重要的钉子**：它把「现在是什么样」逐字钉住，而不是钉「应该是什么样」。
// 结论（逐例实测，见报告 §闸口二）：条目里带函数成员的形状**扁平可达、规位不可达** ⇒ `tools`
// 退回不删。谁要删它，必须先让这一格变绿——要么放宽该叶子（`config.input.tools` 豁免函数值），
// 要么把该成员移到能力面（`capabilities.ports.*`），两条都是裁决，不是实现细节。

test("G1 as-is：扁平 tools 收下带函数成员的条目（引擎不校成员类型，只校 replay）", async () => {
  const shapes = [
    { label: "handler", entry: { name: "t", description: "d", inputSchema: { type: "object" }, handler: () => {} } },
    { label: "validate", entry: { name: "t", description: "d", inputSchema: { type: "object" }, validate: () => {} } },
    { label: "execute", entry: { name: "t", description: "d", inputSchema: { type: "object" }, execute: () => {} } },
    { label: "inputSchema 内的函数", entry: { name: "t", description: "d", inputSchema: { type: "object", validate: () => {} } } },
  ];
  for (const { label, entry } of shapes) {
    const provider = createFakeProvider(DONE);
    const result = await runDirect({ provider, tools: [entry] });
    assert.equal(result.termination.reason, "end_turn", `${label}：扁平 tools 今天必须收下这一形状`);
    // 引擎把整条声明**原样**交给 provider（不剥成员）——这一句也是 as-is 的一部分。
    const sent = provider.requests[0].tools[0];
    const member = sent.handler ?? sent.validate ?? sent.execute ?? sent.inputSchema?.validate;
    assert.equal(typeof member, "function", `${label}：引擎今天把函数成员原样透传给 provider（不剥、不拒）`);
  }
});

test("G2 as-is：同一个形状写进 config.input.tools 被当场拒（数据面只装数据）", async () => {
  const error = await directError({
    config: { input: { tools: [{ name: "t", inputSchema: { type: "object" }, handler: () => {} }] } },
  });
  assert.equal(error instanceof TypeError, true, "规位必须当场拒（这就是「扁平可达、规位不可达」）");
  // 文案逐字：**完整路径**（含数组下标）+ 理由（round-trip）+ 去向（能力面三档里命中的那一档）。
  // 注意命中的是第三档（叶子名 `handler` 本身不在能力面 schema 上），所以它枚举真正存在的三个端口槽，
  // 而不是含糊地说「去能力面」——这正是 #498 S4c 把那句话从「指个方向」改成「点名目的地」的地方。
  assert.equal(
    error.message,
    "config.input.tools[0].handler is not accepted: \"handler\" is a function, and the config namespace"
      + " holds data only (the config subtree must survive a JSON round-trip unchanged)"
      + " — its canonical home is capabilities (capabilities.hooks.<name> for a host callback,"
      + " capabilities.ports.<slot> for a port implementation — the accepted slots are"
      + " sleepImpl, judgeProvider, strategy)",
    "文案必须点名完整路径（含数组下标）并给出可执行的去向",
  );
});

test("G3 as-is：纯数据形状两边都收（对照格——收窄只发生在函数成员上）", async () => {
  const plain = [
    { name: "t", description: "d", inputSchema: { type: "object" } },
    { name: "t2", description: "d", inputSchema: { type: "object" }, replay: "safe" },
    { name: "t3", description: "d", inputSchema: { type: "object" }, extra: { nested: [1, 2] } },
  ];
  const flat = await runDirect({ tools: plain });
  assert.equal(flat.termination.reason, "end_turn", "扁平纯数据形状照旧可用");
  const atCanonicalHome = await runDirect({ config: { input: { tools: plain } } });
  assert.equal(atCanonicalHome.termination.reason, "end_turn", "规位纯数据形状必须可用（对照组）");
  // 非对象条目 / 非数组值：两边都照旧收（引擎对 `tools` 只做 `Array.isArray` 与 `replay` 两件事）。
  for (const odd of [[null], ["t"], "not-an-array"]) {
    const asFlat = await runDirect({ tools: odd });
    assert.equal(asFlat.termination.reason, "end_turn", `扁平 ${JSON.stringify(odd)} 照旧收`);
    const asConfig = await runDirect({ config: { input: { tools: odd } } });
    assert.equal(asConfig.termination.reason, "end_turn", `规位 ${JSON.stringify(odd)} 照旧收`);
  }
});

test("G4 as-is：函数成员在两个协议适配器上都被投影掉（所以它是惰性的，不是「能用」）", async () => {
  // 这条是给裁决用的证据：成员既不进 OpenAI 的 `function` 体，也不进 Anthropic 的 tool 体。
  // 于是「扁平可达」的含义是「今天不报错地接受一个惰性成员」，不是「引擎会调用它」。
  const tools = [{ name: "t", description: "d", inputSchema: { type: "object" }, handler: () => {} }];
  const openai = canonicalToolsToOpenAI(tools);
  assert.deepEqual(openai, [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }]);
  const anthropic = canonicalToAnthropicRequest({
    system: "S",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools,
    maxTokens: 16,
  });
  assert.deepEqual(anthropic.tools, [{ name: "t", description: "d", input_schema: { type: "object" } }]);
  assert.equal(
    JSON.stringify(openai).includes("handler"),
    false,
    "两个协议都不带函数成员 ⇒ 收窄的是「写点」，不是「能力」",
  );
});

// ================================================================ R. 读侧不变（机制 + 行为）
//
// 机制：展开相写回 `effectiveOptions.system`；行为：引擎真的把它送进了请求体、并照旧在它后面
// 拼收尾协议。两者缺一都等于「键删了、功能也丢了」。

test("R1 真 run：config.input.system 逐字到达 provider，收尾协议仍拼在它后面", async () => {
  const { effectiveOptions } = await normalizeRunToolLoopOptions({ config: atHome("input.system", "SYS") });
  assert.equal(effectiveOptions.system, "SYS", "展开相必须写回 effectiveOptions.system");

  // ① 关掉收尾协议 + 关掉缓存边界 ⇒ 请求体里的 system 就是那句字符串本身（逐字）。
  const plain = createFakeProvider(DONE);
  await runDirect({ provider: plain, wrapup: false, config: { input: { system: "SYS", cacheStablePrefix: false } } });
  assert.equal(plain.requests[0].system, "SYS", "system 必须逐字来自 config.input.system");

  // ② 默认（wrapup:true / cacheStablePrefix:true）⇒ 同一句话被包成 `{content, cacheBoundary}`，
  //    且收尾协议拼在后面。这一格证明**读侧那两段装配**（`mainSystem`）一行未改。
  const wrapped = createFakeProvider(DONE);
  await runDirect({ provider: wrapped, wrapup: true, config: { input: { system: "SYS" } } });
  const system = wrapped.requests[0].system;
  assert.equal(typeof system, "object", "默认 cacheStablePrefix:true ⇒ system 带缓存边界包装");
  assert.equal(system.cacheBoundary, true);
  assert.match(system.content, /^SYS\n\n任务完成或需要给出结论时/u, "system 仍拼在收尾协议之前，逐字");
});

test("R2 真 run：扁平 system 在**任何 provider 调用之前**就被拒（零请求）", async () => {
  const provider = createFakeProvider(DONE);
  const error = await sharedDirectError({
    provider,
    executeTool: async () => "ok",
    seed: "go",
    completion: false,
    wrapup: false,
    system: "SYS",
  });
  assert.equal(error instanceof TypeError, true);
  assert.equal(provider.requests.length, 0, "名称闸口必须早于任何宿主端口被调用");
});

test("R3 真 run：新家不给 ⇒ 请求体上连 system 键都没有（删键不许新造默认值）", async () => {
  const provider = createFakeProvider(DONE);
  await runDirect({ provider, wrapup: false });
  // 「未给」的口径是**值**不是键的存在性：请求对象上 `system` 这个槽位一直在（协议层既有形状），
  // 本刀不许给它填任何默认值。
  assert.equal(
    provider.requests[0].system,
    undefined,
    "system 未给且收尾协议关掉时，它的值必须是 undefined（本刀不许新造默认值）",
  );
});

// ================================================================ A / S. 账目格派生（不手抄键数）
//
// 「`input` 组收口了吗」不是一句话，是一个派生集合：组里还剩哪些叶子仍有顶层扁平孪生。

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
  // 键已离开白名单，但**叶子仍在 schema 里**（新家）；两边一起断言，防「删键顺手把叶子也删了」。
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

test("S `input` 组**没有**收口：仍可扁平写的成员逐字等于本片退回的那两个键（机器派生）", () => {
  // 判据全部从符号派生：组里的叶子 → 顶层键名（含唯一那条别名）→ 是否还在白名单里。
  // 于是「本片少做了一键」不会静默：退回清单必须与派生集合逐字相等，多一个少一个都红。
  const flatTwins = CONFIG_NAMESPACE_SCHEMA.input
    .map((leaf) => configOptionNameForLeaf("input", leaf))
    .filter((name) => RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  assert.deepEqual(
    [...flatTwins].sort(),
    [...RETURNED].sort(),
    "`input` 组仍未收口：只剩这两个键还有扁平孪生（本片退回 `tools`（闸口二）/ `wrapup`（预算））",
  );
  // 其余成员都已是「只在 config.input.* 里」的形状——本片与前三片合起来就是这句话的证据。
  const nestedOnly = CONFIG_NAMESPACE_SCHEMA.input
    .map((leaf) => configOptionNameForLeaf("input", leaf))
    .filter((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  assert.equal(
    nestedOnly.includes("system"),
    true,
    "system 必须已进入「只在 config.input.* 里」的那一半",
  );
  assert.equal(nestedOnly.length + flatTwins.length, CONFIG_NAMESPACE_SCHEMA.input.length, "两半必须恰好覆盖整组");
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
