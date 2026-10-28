// issue #498（S3）—— `metadata` 组的**大四件（A9 段）**：`user` / `model` / `task` 删掉顶层扁平写法，
// 规范之家是 `config.metadata.*`；`session` **经同值判定退回**（本片不删）。
//
// **#531 接手 `session` 那一半**：它不进 `config.metadata`（同值判定说顶层选项与装配口成员是同一个值），
// 而是立为**第三站**（永久顶层面）成员——`TOP_LEVEL_SURFACE_OPTION_NAMES` 10 → 11，`config.metadata.session`
// 从「半开的门」（能写、且是第二个家）变成**闭门**（未知叶子当场拒，文案指向顶层第三站）。
//
// 工单的判据是「先量后动」：逐键只删白名单一项 → 跑全量、数红格。基点树上实测
// **user 6 / model 5 / task 13 / session 19**（和 43，四键同删 29 ⇒ 重叠 14），全部远低于
// 「单键 > ~150 格红 ⇒ 先落 #521 式夹具级翻译点」的阈值 ⇒ 本片**没有**翻译点，直接删键。
//
// `session` 为什么没进 `config.metadata`（工单点名的那条裁决，本文件用机器判据钉住，不靠叙述）：
// 装配口的 `session` 成员与顶层 `session` 选项是**同一个值**——`assemblyPortOptions(port).session`
// 与 `port.session` 是同一个对象引用（S1），冲突文案也把 `port.session` 点成 `session` 这个键的
// 构造期来源（S2）。所以给它一个嵌套家，等于让**一个键有两个家**。
// **#531 的裁决是「两个入口、一个家」**：家 = 第三站（顶层），嵌套拼写 = 未知叶子。
//
// 本文件钉的是七件事（全部派生，不手抄键数/组名）：
//
//   P. 旧名反向拒绝钉：顶层再写这三个名字 ⇒ 当场拒，文案**逐字**指向新家（`assert.equal`）。
//   P2. 新家写回：`config.metadata.<key>` 展开后逐字写回 `effectiveOptions.<key>`——「删的是顶层
//      拼写，不是叶子」的机制证据；`configSchemaSelfCheck(...) === []`。
//   F. **函数差异 as-is**：规位里给函数值必须直说两件事（`config` 只装数据 **且** 引擎从没调用过它）。
//      仍在扁平面上的 `session` 那一半由 A8 的 F1 继续钉（本片不重复）。
//   R. **读侧不动**：三个值用真 run 证明照旧到达工具上下文 / 预算推导 / judge 简报。
//   S. **`session` 的同值判定**：同一个对象引用 + 冲突文案点名 `port.session`。
//   N. **撞名归属**：`user` 的消息 role、`task` 的 `context.task` 壳、`model` 的槽位面各自照旧。
//   A. **账目派生化**：四向闭合 + 「退役键数 = 配置面 − 配置面里仍是顶层选项的那些」，
//      且 `test/` 里不许出现手抄的白名单条数。
//
// 零真实 LLM（fake provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CAPABILITY_OPTION_NAMES,
  CONFIG_NAMESPACE_SCHEMA,
  CONFIG_SURFACE_OPTION_NAMES,
  TOP_LEVEL_SURFACE_OPTION_NAMES,
  configPathForOption,
  configSchemaSelfCheck,
  optionHomeBuckets,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
  optionSuggestion,
} from "../src/loop/option-normalization.js";
import { assemblyPortOptions, createAssemblyPort } from "../src/assembly.js";
import { capabilityDestinationsForShell } from "../src/loop/capabilities-namespace.js";
import { runDirect, directError } from "./helpers/run-direct.js";

// ================================================================ 夹具

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const TOOL_ROUND = [
  { content: [{ type: "tool_use", id: "c1", name: "work", input: {} }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
];
const WORK_TOOL = [{ name: "work", description: "d", inputSchema: { type: "object", properties: {} } }];

function createFakeProvider(script) {
  const requests = [];
  const queue = [...script];
  return {
    requests,
    chat: async (request) => {
      requests.push(request);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  };
}

/**
 * 本片退役的三个键 → 它们的规范之家。**表只在这里出现一次**；后面全部从它派生。
 * 顺序与白名单历史顺序无关，只影响报错信息的可读性。
 */
const RETIRED = [
  { key: "user", home: "metadata.user", value: { id: "user-a9" } },
  { key: "model", home: "metadata.model", value: { contextWindowTokens: 131072, maxOutputTokens: 8192 } },
  { key: "task", home: "metadata.task", value: "a9 任务" },
];

/**
 * `metadata` 组里**仍是顶层扁平选项**的叶子（#531 之后为**空**）。
 *
 * 派生而不是手抄：叶子名逐字等于扁平选项名（`metadata` 组没有重命名），所以「还在白名单里吗」
 * 就是唯一判据。A8 的 P5-c 与本文件的 S3 都读这张表，于是「`metadata` 组收口」不需要手抄组名。
 */
const STILL_FLAT_METADATA = CONFIG_NAMESPACE_SCHEMA.metadata
  .filter((leaf) => RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));

/** 退役的 `metadata` 叶子（派生：schema 里有、白名单里没有）。与 `RETIRED` 的键集必须逐字相等。 */
const RETIRED_METADATA = CONFIG_NAMESPACE_SCHEMA.metadata
  .filter((leaf) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));

/** 直连路线的最小合法 run（一次 end_turn 就结束）。 */
function minimalRun(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    seed: "go",
    completion: false,
    wrapup: false,
    ...extra,
  };
}

// ================================================================ P. 旧名反向拒绝钉（逐字）

test("P1 三个旧扁平名逐字拒收并指向新家，且不给任何建议（精确拼写退役 ⇒ 零建议）", async () => {
  for (const { key, home } of RETIRED) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(key), false, `${key} 必须已离开白名单`);
    assert.equal(configPathForOption(key), home, `${key} 的规位必须是 ${home}`);
    assert.equal(optionSuggestion(key), undefined, `${key} 已不在候选池 ⇒ 不许给出任何建议`);
    const error = await directError({ [key]: 1 });
    assert.equal(error instanceof TypeError, true);
    assert.equal(
      error.message,
      `unknown runToolLoop option: ${JSON.stringify(key)} (its canonical home is config.${home};`
        + " the flat spelling is rejected)",
      `${key}：文案必须逐字点名新家（少一个 config.metadata. 宿主就没了路标）`,
    );
  }
});

test("P2 新家写回：config.metadata.<key> 展开后逐字写回 effectiveOptions.<key>，自检仍 []", async () => {
  // 派生集合装的是**整组已退役**的叶子（含 A8 那四个）；本片那三个必须是它的子集。
  for (const { key } of RETIRED) {
    assert.equal(RETIRED_METADATA.includes(key), true, `${key} 必须出现在「已退役叶子」派生集合里`);
  }
  assert.equal(RETIRED_METADATA.includes("session"), false, "`session` 不是「退役叶子」：它整个离开了 schema（#531）");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.metadata.includes("session"), false, "`config.metadata.session` 叶子已被 #531 拆掉");
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "四向自检必须仍 []");
  for (const { key, value } of RETIRED) {
    const result = await runDirect(minimalRun({ config: { metadata: { [key]: value } } }));
    assert.equal(result.termination.reason, "end_turn", `${key}：新家写法必须能真跑起来`);
  }
});

test("P3 叶子仍在 schema 里：config.metadata.<key> 被接受，删的是顶层拼写不是叶子", async () => {
  for (const { key } of RETIRED) {
    assert.equal(CONFIG_NAMESPACE_SCHEMA.metadata.includes(key), true, `${key} 叶子必须仍在 schema 里`);
    assert.equal(configPathForOption(key), `metadata.${key}`);
  }
  // 拼错叶子 ⇒ 接受名单里三个叶子都在（这就是「叶子没被删」的机器证据）。
  const typo = await directError(minimalRun({ config: { metadata: { usr: 1 } } }));
  assert.match(typo.message, /^unknown config\.metadata option: "usr" \(accepted:/u);
  for (const { key } of RETIRED) {
    assert.match(typo.message, new RegExp(`\\b${key}\\b`, "u"), `接受名单里必须列出 ${key}`);
  }
});

// ================================================================ F. 函数差异 as-is（规位侧）

test("F1 规位里给函数值：逐字两句话（只装数据 + 引擎从没调用过它）", async () => {
  for (const { key } of RETIRED) {
    const error = await directError(minimalRun({ config: { metadata: { [key]: () => 1 } } }));
    assert.equal(error instanceof TypeError, true, `${key}：规位必须拒函数值`);
    assert.match(error.message, new RegExp(`^config\\.metadata\\.${key} is not accepted`, "u"));
    assert.match(error.message, /the config namespace holds data only/u);
    assert.match(
      error.message,
      /the engine never calls it, it only forwards the value/u,
      `${key}：文案必须说清「没丢能力」（A8 钉住的那句话，本片不许改）`,
    );
  }
});

test("P4 三个名字都不是混装壳：文案只点一站（对照 `context` 证明两站机制仍咬得住）", async () => {
  for (const { key } of RETIRED) {
    assert.deepEqual(capabilityDestinationsForShell(key), [], `${key} 没有行为成员 ⇒ 不许有第二站`);
    const error = await directError({ [key]: 1 });
    assert.equal(error.message.includes("capabilities."), false, `${key} 的文案里不许出现 capabilities.* 提示`);
  }
  // 对照组：`context` 是混装壳（数据 + 函数）⇒ 两站同时点名。证明「只点一站」是派生结果，
  // 不是把提示整段删掉也能绿。
  assert.notDeepEqual(capabilityDestinationsForShell("context"), []);
  const control = await directError({ context: {} });
  assert.match(control.message, /this shell holds both data and functions/u);
  assert.match(control.message, /capabilities\.hooks\./u);
});

// ================================================================ R. 读侧不动（真 run）

test("R1 user / task / model 三个值照旧到达工具上下文与预算推导", async () => {
  let seen;
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider(TOOL_ROUND),
    seed: "go",
    executeTool: async ({ context }) => {
      seen = context;
      return "ok";
    },
    tools: WORK_TOOL,
    maxRounds: 2,
    config: {
      metadata: {
        user: { id: "user-a9" },
        task: "a9 任务",
        model: { contextWindowTokens: 131072, maxOutputTokens: 8192 },
      },
    },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    completion: false,
    wrapup: false,
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(seen?.user, { id: "user-a9" }, "toolContextFor 仍转发 user（读侧一行未改）");
  assert.equal(seen?.task, "a9 任务", "toolContextFor 仍转发 task");
  assert.deepEqual(
    events.filter((event) => event.type === "model_metadata_missing"),
    [],
    "modelMetadataFor 仍从 effectiveOptions.model 读到窗口数字（不发缺失诊断）",
  );
});

test("R2 task 仍进 judge 简报（task-brief.js 只做字符串检查，读侧未改）", async () => {
  const judge = createFakeProvider([
    { content: [{ type: "text", text: JSON.stringify({ done: false, confidence: 0.5, reason: "继续", evidence: "e" }) }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    maxRounds: 1,
    config: { metadata: { task: "A9_JUDGE_TASK" } },
    reflection: { enabled: true, judge: { provider: judge } },
  });
  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.match(prompt, /A9_JUDGE_TASK/u, "judge 简报的「任务目标」必须仍取到 config.metadata.task");
});

// ================================================================ S. `session` 的同值判定（退回的机器证据）

function sessionPort(session) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: createFakeProvider(DONE),
    tools: { definitions: [], executeTool: async () => "ok" },
    session,
  });
}

test("S1 顶层 session 选项与装配口 session 成员是**同一个值**（同一对象引用）", async () => {
  const port = sessionPort({ id: "a9-port-session" });
  const derived = await assemblyPortOptions(port, {});
  assert.equal(derived.session, port.session, "assemblyPortOptions(port).session 必须就是 port.session 本体");
  assert.equal(
    derived.session === port.session,
    true,
    "同值判定是**引用相等**，不是 deepEqual：这条裁决问的是「是不是同一个家」",
  );
});

test("S2 冲突文案把 port.session 点成 session 这个键的构造期来源（同一个键，两个来源）", async () => {
  const port = sessionPort({ id: "a9-port-session" });
  const error = await assemblyPortOptions(port, { session: { id: "explicit" } }).then(() => null, (caught) => caught);
  assert.equal(error instanceof TypeError, true);
  assert.match(
    error.message,
    /"session" comes from port\.session \(construction\) and overrides\.session \(call\)/u,
    "构造期来源必须逐字是 port.session ⇒ 顶层 session 选项与端口成员是同一个键",
  );
});

test("S3 #531 闭门：第三站 ⇒ 写顶层；写 `config.metadata.session` 作为未知叶子当场拒，文案逐字指向第三站", async () => {
  // ① 第三站成员：`session` 在表里，且**没有**嵌套家（`configPathForOption` 回答 undefined）。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("session"), true, "`session` 必须仍在白名单");
  assert.equal(TOP_LEVEL_SURFACE_OPTION_NAMES.includes("session"), true, "`session` 必须是第三站成员");
  assert.equal(configPathForOption("session"), undefined, "`session` 不许有任何嵌套家");
  assert.deepEqual(STILL_FLAT_METADATA, [], "`metadata` 组里不再有扁平孪生（组已收口）");
  assert.equal(CONFIG_NAMESPACE_SCHEMA.metadata.includes("session"), false, "schema 里不许再有 session 叶子");
  // ② 顶层照旧收（同一个值、同一个入口）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({ session: { id: "a9-flat-session" } });
  assert.deepEqual(effectiveOptions.session, { id: "a9-flat-session" }, "扁平 `session` 照旧被接受");
  // ③ 闭门：同一个值写进旧规位 ⇒ 当场拒，文案逐字。
  // #551：判词不再是「未知叶子 + 接受名单」那句通用话术，而是**点名载荷的家**（甲裁决：载荷住
  // `config.folding.context.session`，顶层 `session` 只做身份容器）——宿主拿到的是一句指路，
  // 不是一句「没有这个键」。
  const error = await directError({ config: { metadata: { session: { id: "a9-nested" } } } });
  assert.equal(error instanceof TypeError, true, "config.metadata.session 必须当场拒");
  assert.equal(
    error.message,
    "config.metadata.session: the opaque per-run payload's home is config.folding.context.session"
      + " (the fold-context shell's reserved key — the engine hands it to executeTool as"
      + " context.session); the top-level `session` option is the run identity container"
      + " (session.id / session.modelSlot / session.initialMessages), not a payload home",
    "文案必须逐字：点名载荷的家（#551），不是未知叶子的通用话术",
  );
});

// ================================================================ N. 撞名归属（每个名字只碰一张面）

test("N1 `user`：消息 role 语义与 provider 请求体字段都不受本片影响", async () => {
  // role 面：一条 role:"user" 的种子消息照旧进模型请求（本片删的是**选项名**，不是 role）。
  const provider = createFakeProvider(DONE);
  const result = await runDirect({
    provider,
    executeTool: async () => "ok",
    config: { input: { messages: [{ role: "user", content: "N1_ROLE_USER" }] } },
    completion: false,
    wrapup: false,
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(provider.requests[0].messages[0].role, "user", "消息 role 仍是 user（role 面一字未动）");
});

test("N2 `task`：`context.task` 是另一张面，两者并存时按 `resolveTaskBrief` 的既有顺序取", async () => {
  // 实测（`task-brief.js` 的 `resolveTaskBrief`）：显式 task 优先于 `context.task`，`context.task`
  // 优先于消息回退。本片只搬**显式 task 的拼写**（扁平 → `config.metadata.task`），
  // 两条既有优先级一字未改——这张格子把顺序钉住，谁改顺序这里就红。
  const runWith = async (config) => {
    const judge = createFakeProvider([
      { content: [{ type: "text", text: JSON.stringify({ done: false, confidence: 0.5, reason: "继续", evidence: "e" }) }], stopReason: "end_turn" },
    ]);
    await runDirect({
      provider: createFakeProvider(DONE),
      executeTool: async () => "ok",
      maxRounds: 1,
      config,
      reflection: { enabled: true, judge: { provider: judge } },
    });
    return judge.requests[0].messages[0].content[0].text;
  };
  const both = await runWith({
    metadata: { task: "FROM_METADATA" },
    folding: { context: { task: "FROM_CONTEXT" } },
  });
  assert.match(both, /FROM_METADATA/u, "显式 task 优先（as-is：本片只改拼写，不改顺序）");
  assert.doesNotMatch(both, /FROM_CONTEXT/u);
  const contextOnly = await runWith({ folding: { context: { task: "FROM_CONTEXT" } } });
  assert.match(contextOnly, /FROM_CONTEXT/u, "只有 context.task 时它照旧生效（那是另一张面，本片没碰）");
});

test("N3 `model`：槽位面照旧（modelConfig.resolve 仍被调用，modelConfig 端口未动）", async () => {
  const calls = [];
  const result = await runDirect({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    session: { id: "a9-slot", modelSlot: "slotA" },
    modelConfig: {
      resolve: async (slot) => {
        calls.push(slot);
        return { contextWindowTokens: 100000, maxOutputTokens: 1024 };
      },
    },
    completion: false,
    wrapup: false,
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(calls, ["slotA"], "`modelConfig` 端口与槽位面一字未动");
});

// ================================================================ A. 账目派生化

test("A1 四向闭合 + 退役键数是派生差值（不手抄 43 / 18 / 17 这类条数）", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(), "四向之和逐键等于白名单");
  // 退役键 = 配置面名单里已不在白名单的那些（派生）。「配置面少了几个」不用手抄。
  const retiredFlatKeys = CONFIG_SURFACE_OPTION_NAMES.filter((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  assert.equal(
    configPlane.length + retiredFlatKeys.length,
    CONFIG_SURFACE_OPTION_NAMES.length,
    "配置面 = 配置面名单 − 已退役扁平键（账目对得上，且两边都从符号派生）",
  );
  // 本片只动配置面：能力面与第三站的成员集一字未改（从符号派生，不手抄条数）。
  assert.deepEqual(
    capability,
    CAPABILITY_OPTION_NAMES.filter((name) => RUN_TOOL_LOOP_OPTION_NAMES.includes(name)
      && !TOP_LEVEL_SURFACE_OPTION_NAMES.includes(name)),
    "能力面成员集必须仍是派生结果（本片没动它）",
  );
  assert.deepEqual(
    topLevelSurface,
    TOP_LEVEL_SURFACE_OPTION_NAMES.filter((name) => RUN_TOOL_LOOP_OPTION_NAMES.includes(name)),
    "第三站成员集必须仍是派生结果（本片没动它）",
  );
  assert.equal(containers.length, 2);
  assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), []);
});

test("A2 test/ 里不许出现手抄的白名单条数（`RUN_TOOL_LOOP_OPTION_NAMES.length, <数字>`）", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;
      const text = readFileSync(full, "utf8");
      if (/RUN_TOOL_LOOP_OPTION_NAMES\.length\s*,\s*\d/u.test(text)) offenders.push(full);
    }
  };
  walk("test");
  assert.deepEqual(offenders, [], "白名单条数必须派生，不许手抄（A8 的 A2 同一条规矩）");
});
