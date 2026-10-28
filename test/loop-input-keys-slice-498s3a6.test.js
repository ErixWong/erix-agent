// issue #498（S3）—— `input` 组的**收尾刀（A6 段）**，并在 #527 之后继续作为 `tools` 的钉子。
//
// 工单点名三个键：`system` / `wrapup` / `tools`。A6 当时只退役了 `system`（家 =
// `config.input.system`，`CONFIG_NAMESPACE_SCHEMA.input`）；另两个原样退回。**#527 落地了
// `tools` 的裁决**：它不是配置键，是**永久顶层面（第三站）**，所以 `config.input.tools`
// 这个叶子被拆掉。本文件保留并加强 A6 的 G1–G4 as-is 钉，另加 G5「闭门」证据：
//
//   · `tools` —— A6 的**闸口二（函数成员可达性）**实测：条目里带函数成员（`handler` / `validate` /
//     `execute` / `inputSchema` 内的函数）这四族**扁平可达、规位不可达**（`config` 只装数据）。
//     #527 据此拆掉叶子：扁平 `tools` 照旧收下（引擎只校 `replay`、读 `name`/`inputSchema`），
//     写 `config.input.tools` 现在是**未知叶子**当场拒，文案指向「第三站在顶层」。
//   · `wrapup` —— 仍**没做**（时间预算，删键后全量红 189 格）；S 段机器派生「`input` 组只剩它一个
//     扁平孪生」，于是「没做完」是可见的，不靠记忆。
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
  configSchemaSelfCheck,
  optionHomeBuckets,
  NAMESPACE_CONTAINER_OPTION_NAMES,
  TOP_LEVEL_SURFACE_OPTION_NAMES,
} from "../src/loop/config-namespace.js";
import { capabilitiesPathForOption, capabilityDestinationsForShell } from "../src/loop/capabilities-namespace.js";
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

/**
 * 本片**仍可扁平写**的键。
 *
 * #527 之后这里是 `["wrapup"]`；**#498 S3 A18 把它也退役了**，于是这张表为空——空表就是
 * 「`input` 组已收口」这句话的可执行版本（S 段直接拿它与派生集合对账，不手抄条数）。
 */
const RETURNED = [];

/** 直连路线的最小合法 run（一次 end_turn 就结束）。 */
function runDirect(extra = {}) {
  return sharedRunDirect({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    seed: "go",
    completion: false,
    config: { input: { wrapup: false } },
    ...extra,
  });
}

/** 直连路线「抛了什么」（不抛返回 null）。 */
const directError = (extra = {}) => sharedDirectError({
  provider: createFakeProvider(DONE),
  executeTool: async () => "ok",
  seed: "go",
  completion: false,
  config: { input: { wrapup: false } },
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
        + " — there is no capability home for it: \"system\" is a data key of the config namespace"
        // #498 S3 A8：文案补了「引擎从来没调用过它，只把值转发出去」这一句（工单要求说清「这里
        // 不收函数、但也没丢能力」），逐字钉跟着改；主张一字未变，只是把「没丢能力」说出来。
        + " — the engine never calls it, it only forwards the value — so pass plain data"
        + " (host callbacks belong under capabilities.hooks.<name>)",
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

test("P5-c 专项：顶层 wrapup 已退役（#498 S3 A18 收口）；wrapup 组的嵌套容器是另一个东西", async () => {
  // 整词 grep `wrapup` 会把两件东西一起捞出来：
  //   ① 顶层 `wrapup`（布尔，家 `config.input.wrapup`）——#528 退回、**A18 退役**：扁平拼写现在
  //      被名称闸口当场拒，规位照旧生效；
  //   ② 反思收尾的**嵌套容器**：`config.run.reflection.wrapupNormalize`（`run.reflection` 那一带）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("wrapup"), false, "A18 已退役顶层 wrapup");
  assert.equal(configPathForOption("wrapup"), "input.wrapup", "叶子仍在，规位仍是 input.wrapup（删键 ≠ 删叶子）");
  assert.equal(
    CONFIG_NAMESPACE_SCHEMA.input.includes("wrapup"),
    true,
    "`wrapup` 叶子必须留在 CONFIG_NAMESPACE_SCHEMA.input 里",
  );
  assert.equal(
    CONFIG_NAMESPACE_SCHEMA.run.includes("reflection"),
    true,
    "reflection 是 config.run 的叶子（嵌套容器的壳），与顶层 wrapup 无关",
  );
  // 反向钉：扁平拼写当场被拒，文案点名新家（这条就是「退役」的可执行定义）。
  // ⚠ 这一格必须**绕过夹具**：`sharedDirectError` 会把扁平 `wrapup` 翻译进规位（那正是夹具的
  // 职责），于是「扁平拼写被拒」永远测不到。这里走 `normalizeRunToolLoopOptions`（名称闸口的
  // 同一处入口，纯函数、不跑 run）。
  const rejected = await normalizeRunToolLoopOptions({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    wrapup: false,
  }).then(() => null, (error) => error);
  assert.equal(rejected instanceof TypeError, true, `必须当场抛，实际：${rejected}`);
  assert.match(rejected.message, /unknown runToolLoop option: "wrapup"/u);
  assert.match(rejected.message, /config\.input\.wrapup/u, "报错必须点名新家");
  // 行为证据：规位 `config.input.wrapup:false` 仍照旧生效（关掉收尾协议 ⇒ 系统提示里没有那段 JSON 信封）。
  const provider = createFakeProvider(DONE);
  await sharedRunDirect({
    provider,
    executeTool: async () => "ok",
    config: { input: { system: "SYS", cacheStablePrefix: false, wrapup: false } },
  });
  assert.equal(provider.requests[0].system, "SYS", "config.input.wrapup:false ⇒ 系统提示不被追加收尾协议");
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
  // `tools` 这个**词**在三张面上：永久顶层面选项键（#527 之后它**没有**嵌套家）、
  // `erix-agent/tools` 子路径、以及 `createToolRegistry` 这个符号。后两张面本片一个字都没动。
  const registry = createToolRegistry([]);
  assert.equal(typeof registry.executeTool, "function", "工具注册表仍是同一个实现（本片不动能力面）");
  assert.equal(typeof registry.resolveTools, "function");
  assert.equal(configPathForOption("tools"), undefined, "#527 之后 tools 没有配置面之家");
  assert.equal(capabilitiesPathForOption("tools"), undefined, "tools 也不是能力面叶子");
  assert.equal(TOP_LEVEL_SURFACE_OPTION_NAMES.includes("tools"), true, "tools 是永久顶层面（第三站）");
});

// ================================================================ G. `tools`：函数成员可达性 + #527 的闭门
//
// G1–G4 是 A6 的 as-is 钉，**原样保留**：它们证明「条目带函数成员」这一族经扁平 `tools` 可达、
// 且成员是惰性的（两个协议都投影掉）。#527 据此把 `tools` 定为永久顶层面，并拆掉
// `config.input.tools` 叶子——G5 就是「半开的门变成闭门」的证据：同一个值写进那个叶子现在是
// **未知叶子**当场拒，文案指向顶层第三站。

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

test("G2 #527 闭门：同一个形状写进 config.input.tools 现在是未知叶子，文案指向顶层第三站", async () => {
  const error = await directError({
    config: { input: { tools: [{ name: "t", inputSchema: { type: "object" }, handler: () => {} }] } },
  });
  assert.equal(error instanceof TypeError, true, "叶子拆掉后，规位必须当场拒（不是「收下再忽略」）");
  // 文案逐字：**未知叶子** + 指向第三站（顶层），而不是「函数值 + 能力面三档」——后者是叶子还在
  // 时候的形状。`tools` 现在既不是配置叶子也不是能力叶子，所以「未知叶子」才是正确的门。
  assert.equal(
    error.message,
    "unknown config.input option: \"tools\" (\"tools\" is a permanent top-level option — the third station —"
      + " write it at the top level: tools: …)",
    "文案必须点名未知叶子并指向「第三站在顶层」",
  );
  // 行为证据：扁平写法逐字可用，且函数成员照旧原样交给 provider（G1 的同一件事，写在一个 run 里）。
  const provider = createFakeProvider(DONE);
  const flat = await runDirect({ provider, tools: [{ name: "t", inputSchema: { type: "object" }, handler: () => {} }] });
  assert.equal(flat.termination.reason, "end_turn");
  assert.equal(typeof provider.requests[0].tools[0].handler, "function", "扁平写法照旧原样透传函数成员");
});

test("G5 #527 闭门（独立一格）：`config.input.tools` 与 `config.tools` 都被拒，且都指向顶层第三站", async () => {
  // G2 钉的是「同一个函数形状」；G5 钉的是「叶子本身没了」——纯数据、标量、甚至 undefined 都拒。
  // 这就是「半开的门变成闭门」的唯一证据：不是收窄某个形状，而是整条路不再存在。
  for (const value of [[{ name: "t" }], null, "x", 1, true, undefined]) {
    const error = await directError({ config: { input: { tools: value } } });
    assert.equal(error instanceof TypeError, true, `config.input.tools=${JSON.stringify(value)} 必须拒`);
    assert.match(error.message, /unknown config\.input option: "tools"/u);
    assert.match(error.message, /permanent top-level option/u);
    assert.match(error.message, /third station/u);
    assert.match(error.message, /top level/u);
  }
  // 写在 config 顶层也是同一个答案（不是「未知分组 + 接受名单」那种读起来像「tools 消失了」的文案）。
  const topLevel = await directError({ config: { tools: [] } });
  assert.equal(topLevel instanceof TypeError, true);
  assert.match(topLevel.message, /config\.tools: "tools" is a permanent top-level option/u);
  assert.match(topLevel.message, /third station/u);
  // 结构上叶子真的不在 schema 里（反向证会把这个断言打红）。
  assert.equal(CONFIG_NAMESPACE_SCHEMA.input.includes("tools"), false);
  assert.equal(configPathForOption("tools"), undefined);
});

test("G3 as-is：纯数据形状扁平照旧收，而规位（无论纯数据还是函数）一律是未知叶子", async () => {
  const plain = [
    { name: "t", description: "d", inputSchema: { type: "object" } },
    { name: "t2", description: "d", inputSchema: { type: "object" }, replay: "safe" },
    { name: "t3", description: "d", inputSchema: { type: "object" }, extra: { nested: [1, 2] } },
  ];
  const flat = await runDirect({ tools: plain });
  assert.equal(flat.termination.reason, "end_turn", "扁平纯数据形状照旧可用");
  // #527：规位不再收任何形状（叶子没了）——纯数据也不行，这正是「闭门」而不是「收窄」。
  for (const odd of [plain, [null], ["t"], "not-an-array"]) {
    const asConfig = await directError({ config: { input: { tools: odd } } });
    assert.equal(asConfig instanceof TypeError, true, `规位 ${JSON.stringify(odd)} 必须被拒`);
    assert.match(asConfig.message, /unknown config\.input option: "tools"/u, "必须是未知叶子那条文案");
    assert.match(asConfig.message, /permanent top-level option/u, "文案必须指向第三站");
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
    config: { input: { wrapup: false } },
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
  // #527：`tools` 没有嵌套家，但在第三站里；这是 11 → 12 账目的机器口径。
  assert.equal(configPathForOption("tools"), undefined);
  assert.equal(capabilitiesPathForOption("tools"), undefined);
  assert.equal(TOP_LEVEL_SURFACE_OPTION_NAMES.includes("tools"), true);
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

test("S `input` 组已收口（#498 S3 A18）：仍可扁平写的成员为空，派生集合逐字相等", () => {
  // 判据全部从符号派生：组里的叶子 → 顶层键名（含唯一那条别名）→ 是否还在白名单里。
  // 于是「本片少做了一键」不会静默：退回清单必须与派生集合逐字相等，多一个少一个都红。
  const flatTwins = CONFIG_NAMESPACE_SCHEMA.input
    .map((leaf) => configOptionNameForLeaf("input", leaf))
    .filter((name) => RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  assert.deepEqual(
    [...flatTwins].sort(),
    [...RETURNED].sort(),
    "`input` 组已收口：不该再有扁平孪生（#527 拆掉 `tools`、A18 退役 `wrapup`）",
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

test("T 第三站账目（#527 → #531）：两个家都没有的键 11 → 12 → 13，`tools` / `session` 是新增的那两个", () => {
  // 口径逐字来自工单：`configPathForOption(name) === undefined` 且
  // `capabilitiesPathForOption(name) === undefined`。这条**不读**任何手写名单，只读两个 schema。
  const noNestedHome = RUN_TOOL_LOOP_OPTION_NAMES.filter(
    (name) => configPathForOption(name) === undefined && capabilitiesPathForOption(name) === undefined,
  );
  // #531：条数**派生**（第三站 + 两个容器），不手抄——`session` 立为第三站成员后 12 → 13。
  assert.equal(
    noNestedHome.length,
    TOP_LEVEL_SURFACE_OPTION_NAMES.length + NAMESPACE_CONTAINER_OPTION_NAMES.length,
    "「两个家都没有」的键 = 第三站 + 两个容器（#527 起 12，#531 起 13，条数从符号派生）",
  );
  assert.deepEqual(
    [...noNestedHome].sort(),
    [...TOP_LEVEL_SURFACE_OPTION_NAMES, ...NAMESPACE_CONTAINER_OPTION_NAMES].sort(),
    "这些键必须逐字等于第三站 + 两个容器（多一个少一个都红）",
  );
  assert.equal(noNestedHome.includes("tools"), true, "tools 必须在这批里——它就是 11 → 12 的新增成员");
  assert.equal(noNestedHome.includes("session"), true, "session 必须在这批里——它就是 12 → 13 的新增成员（#531）");
  assert.equal(configPathForOption("tools"), undefined, "tools 的配置面之家已拆（这是 12 的算法的一半）");
  assert.equal(capabilitiesPathForOption("tools"), undefined, "tools 也不是能力面叶子（另一半）");
  assert.equal(TOP_LEVEL_SURFACE_OPTION_NAMES.includes("tools"), true, "tools 的所有权分类 = 永久顶层面（第三站）");
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
