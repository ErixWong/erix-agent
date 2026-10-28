// issue #498（S3）—— `run` 组的**小四件（A11 段）**：`invalidArguments` / `replayPolicy` /
// `writeToolNames` / `writeToolPathKeys` 删掉顶层扁平写法，规范之家是 `config.run.*`。
//
// 工单的判据是「先量后动」：逐键只删白名单一项 → 跑全量、数红格。基点树上实测
// **invalidArguments 4 / replayPolicy 9 / writeToolNames 6 / writeToolPathKeys 5**（和 24，
// 四键同删 14 ⇒ 重叠 10），全部远低于「单键 > ~150 格红 ⇒ 先落 #521 式夹具级翻译点」的阈值
// ⇒ 本片**没有**翻译点，直接删键（写侧改拼写：src/bin/examples/test 的写点逐处搬进 `config.run`）。
//
// 闸口二（可达性对照，本仓每片常设）：`tools`（#527）与 `session`（#531）都是在这一步拦下静默
// 收窄的，所以本片对**每个键的每个合法取值形状**各造一例，拿 `runToolLoop` 真入口跑
// 「扁平 vs 规位」并比退出码：
//
//   | 键                   | 合法形状                        | 扁平 | 规位 |
//   | -------------------- | ------------------------------- | ---- | ---- |
//   | `invalidArguments`   | `"reject"` / `"execute"`        | 0/0  | 0/0  |
//   | `replayPolicy`       | `"always-replay"` / `"per-tool-declaration"` | 0/0 | 0/0 |
//   | `writeToolNames`     | `["work"]` / `[]`               | 0/0  | 0/0  |
//   | `writeToolPathKeys`  | `["path","file_path"]` / `[]`   | 0/0  | 0/0  |
//
// 八格全 PARITY ⇒ 四键都是「数据形状」的键（两个枚举标量 + 两个字符串数组），没有混装壳，
// 没有退回。唯一的差异出现在**非法形状**上：数组里夹函数元素时扁平侧被静默过滤
// （`normalizeToolNameSet` 只留字符串）、规位侧当场拒（`config` 只装数据）——这与 A8 为
// `metadata.*` 钉下的「函数值被拒」是同一条既定收窄，不是丢能力（引擎从不调用那些元素），
// 所以它被钉成 as-is（F2），不是退回理由。
//
// 本文件钉的是七件事（全部派生，不手抄键数/组名）：
//
//   P. 旧名反向拒绝钉：顶层再写这四个名字 ⇒ 当场拒，文案**逐字**指向新家（`assert.equal`）。
//   P2. 新家写回：`config.run.<key>` 展开后逐字写回 `effectiveOptions.<key>`——「删的是顶层
//      拼写，不是叶子」的机制证据；`configSchemaSelfCheck(...) === []`。
//   G. **闸口二矩阵**：上表八格逐格真跑，两侧都必须 exit 0（形状可达性不是叙述）。
//   F. **函数差异 as-is**：规位里给函数值必须直说两件事（`config` 只装数据 **且** 引擎从没
//       调用过它）；数组夹函数那一格的差异逐字钉住。
//   R. **读侧不动**：四个值用真 run 证明照旧到达 resume 重放分支 / 引数裁决 / judge 的
//       写工具集与路径键优先级。
//   N. **撞名与邻接**：`writeToolNames` / `writeToolPathKeys` 在 judge 侧是**读侧**（不动）；
//       `replayPolicy` 与 `session.resume` 的既有裁决不混（#531 的闭门钉子原样保留）；
//       `maxTokenContinuations`（`run` 组）与已退役的 `maxTokens`（`tuning` 组）不同物。
//   A. **账目派生化**：四向闭合 + 「配置面少了几个」由符号派生，且 `test/` 里不许手抄白名单条数。
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
  configPlaneOptionNames,
  configSchemaSelfCheck,
  optionHomeBuckets,
} from "../src/loop/config-namespace.js";
import {
  RUN_TOOL_LOOP_OPTION_NAMES,
  normalizeRunToolLoopOptions,
  optionSuggestion,
} from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { capabilityDestinationsForShell } from "../src/loop/capabilities-namespace.js";
import { rawWritePath } from "../src/reflection/judge.js";
import { runDirect, directError } from "./helpers/run-direct.js";

// ================================================================ 夹具

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

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
 * 本片退役的四个键 → 它们的规范之家 + 一个**合法**取值。**表只在这里出现一次**；
 * 后面的拒绝钉、写回钉、闸口二矩阵全部从它派生。
 */
const RETIRED = [
  { key: "invalidArguments", home: "run.invalidArguments", value: "execute" },
  { key: "replayPolicy", home: "run.replayPolicy", value: "per-tool-declaration" },
  { key: "writeToolNames", home: "run.writeToolNames", value: ["work"] },
  { key: "writeToolPathKeys", home: "run.writeToolPathKeys", value: ["path", "file_path"] },
];

/**
 * 闸口二的对照样本：每个键的**每一个**合法取值形状各一条（两个枚举各两档，两个名字数组
 * 各给「非空」与「空」——空数组是「显式关掉」那一档，不能漏）。
 */
const SHAPES = [
  { key: "invalidArguments", value: "reject" },
  { key: "invalidArguments", value: "execute" },
  { key: "replayPolicy", value: "always-replay" },
  { key: "replayPolicy", value: "per-tool-declaration" },
  { key: "writeToolNames", value: ["work"] },
  { key: "writeToolNames", value: [] },
  { key: "writeToolPathKeys", value: ["path", "file_path"] },
  { key: "writeToolPathKeys", value: [] },
];

/** `run` 组里**仍是顶层扁平选项**的叶子（派生；本片收口后应为空）。 */
const STILL_FLAT_RUN = CONFIG_NAMESPACE_SCHEMA.run
  .filter((leaf) => RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf));

/** 退役的 `run` 叶子（派生：schema 里有、白名单里没有）。与 `RETIRED` 的键集必须逐字相等。 */
const RETIRED_RUN = CONFIG_NAMESPACE_SCHEMA.run
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

/** 真入口跑一次，只回退出码（闸口二的判据就是它）。 */
async function exitCode(options) {
  return runToolLoop(options).then(
    (result) => ({ code: 0, reason: result?.termination?.reason }),
    (error) => ({ code: 1, message: error.message }),
  );
}

// ================================================================ P. 旧名反向拒绝钉（逐字）

test("P1 四个旧扁平名逐字拒收并指向新家，且不给任何建议（精确拼写退役 ⇒ 零建议）", async () => {
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
      `${key}：文案必须逐字点名新家（少一个 config.run. 宿主就没了路标）`,
    );
  }
});

test("P2 新家写回：config.run.<key> 展开后逐字写回 effectiveOptions.<key>，自检仍 []", async () => {
  for (const { key } of RETIRED) {
    assert.equal(RETIRED_RUN.includes(key), true, `${key} 必须出现在「已退役叶子」派生集合里`);
    assert.deepEqual(configSchemaSelfCheck(RUN_TOOL_LOOP_OPTION_NAMES), [], "四向自检必须仍 []");
    const { effectiveOptions } = await normalizeRunToolLoopOptions({
      config: { run: { [key]: RETIRED.find((row) => row.key === key).value } },
    });
    assert.deepEqual(
      effectiveOptions[key],
      RETIRED.find((row) => row.key === key).value,
      `${key}：展开相必须逐字写回 effectiveOptions.${key}（这就是读侧不用改的机制本身）`,
    );
    assert.equal(Object.hasOwn(effectiveOptions, "config"), false, "config 容器展开后必须消失");
  }
  // 写回之后引擎真的能跑起来（不是「对象里有个键」而已）。
  for (const { key, value } of RETIRED) {
    const result = await runDirect(minimalRun({ config: { run: { [key]: value } } }));
    assert.equal(result.termination.reason, "end_turn", `${key}：新家写法必须能真跑起来`);
  }
});

test("P3 叶子仍在 schema 里：config.run.<key> 被接受，删的是顶层拼写不是叶子", async () => {
  for (const { key } of RETIRED) {
    assert.equal(CONFIG_NAMESPACE_SCHEMA.run.includes(key), true, `${key} 叶子必须仍在 schema 里`);
    assert.equal(configPathForOption(key), `run.${key}`);
  }
  // 拼错叶子 ⇒ 接受名单里四个叶子都在（这就是「叶子没被删」的机器证据）。
  const typo = await directError(minimalRun({ config: { run: { invaldArguments: "execute" } } }));
  assert.match(typo.message, /^unknown config\.run option: "invaldArguments" \(accepted:/u);
  for (const { key } of RETIRED) {
    assert.match(typo.message, new RegExp(`\\b${key}\\b`, "u"), `接受名单里必须列出 ${key}`);
  }
});

// ================================================================ G. 闸口二矩阵（扁平 vs 规位）

test("G1 八格合法形状：扁平与规位两侧都必须 exit 0（形状可达性，不是叙述）", async () => {
  assert.equal(SHAPES.length, 8, "闸口二的样本数变了 ⇒ 先确认工单要求再改这条断言");
  for (const { key, value } of SHAPES) {
    const label = `${key}=${JSON.stringify(value)}`;
    const flat = await exitCode({
      provider: createFakeProvider(DONE),
      executeTool: async () => "ok",
      config: { input: { initialUserMessage: "go" } },
      completion: false,
      wrapup: false,
      [key]: value,
    });
    const nested = await exitCode({
      provider: createFakeProvider(DONE),
      executeTool: async () => "ok",
      config: { input: { initialUserMessage: "go" }, run: { [key]: value } },
      completion: false,
      wrapup: false,
    });
    // 扁平侧此刻**已经**被拒（键退役了）——闸口二在删键**前**跑过，两侧都是 0；删键之后
    // 扁平侧的期望值就是「拒」。这条断言钉的是**规位侧的可达性**（0）与扁平侧的**确定性**
    // （不是静默忽略），两者都必须成立，否则「删键」这件事本身就不可证。
    assert.equal(nested.code, 0, `${label}：规位必须可达（exit 0）——${nested.message ?? ""}`);
    assert.equal(flat.code, 1, `${label}：扁平拼写已退役 ⇒ 必须当场拒（不是静默忽略）`);
    assert.match(flat.message, /^unknown runToolLoop option:/u, `${label}：拒的理由必须是名称闸口`);
  }
});

test("G2 闸口二的历史值（删键前两侧都 0）由形状本身保证：四个键的值都是纯数据", async () => {
  // 判据：四个键的合法取值形状里**没有一个**能装函数成员——枚举标量两个、字符串数组两个。
  // 这条断言是「为什么闸口二当时两侧都 exit 0」的机器解释：规位拒的只有函数值，而这些形状
  // 里没有函数。反过来，若哪天有人把其中某个键改成对象壳（可能夹函数），这里会红。
  for (const { key, value } of RETIRED) {
    const paths = [];
    const walk = (item, path) => {
      if (typeof item === "function") paths.push(path);
      else if (item !== null && typeof item === "object") {
        for (const [k, v] of Object.entries(item)) walk(v, `${path}.${k}`);
      }
    };
    walk(value, key);
    assert.deepEqual(paths, [], `${key} 的合法形状里不许有函数成员（有 ⇒ 它就是混装壳，闸口二会分叉）`);
  }
});

// ================================================================ F. 函数差异 as-is（规位侧）

test("F1 规位里给函数值：逐字两句话（只装数据 + 引擎从没调用过它）", async () => {
  for (const { key } of RETIRED) {
    const error = await directError(minimalRun({ config: { run: { [key]: () => 1 } } }));
    assert.equal(error instanceof TypeError, true, `${key}：规位必须拒函数值`);
    assert.match(error.message, new RegExp(`^config\\.run\\.${key} is not accepted`, "u"));
    assert.match(error.message, /the config namespace holds data only/u);
    assert.match(
      error.message,
      /the engine never calls it, it only forwards the value/u,
      `${key}：文案必须说清「没丢能力」（A8 钉住的那句话，本片不许改）`,
    );
  }
});

test("F2 数组夹函数：扁平侧静默过滤、规位侧当场拒 —— as-is 钉住（不是退回理由）", async () => {
  // 这一格是闸口二唯一的差异，且差异落在**非法形状**上（`writeToolNames` / `writeToolPathKeys`
  // 的文档形状是 `string[]`）。扁平侧过去靠 `normalizeToolNameSet` 把非字符串元素滤掉，
  // 规位侧按「config 只装数据」拒 —— 与 A8 为 `metadata.*` 钉下的收窄同一条。
  const marker = () => "not-a-tool-name";
  const flat = await exitCode({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    config: { input: { initialUserMessage: "go" } },
    completion: false,
    wrapup: false,
    writeToolNames: ["work", marker],
  });
  assert.equal(flat.code, 1, "扁平拼写已退役 ⇒ 这一格现在也是名称闸口（不再是静默过滤）");
  const nested = await directError(minimalRun({
    config: { run: { writeToolNames: ["work", marker] } },
  }));
  assert.equal(nested instanceof TypeError, true, "规位侧必须拒数组里的函数元素");
  assert.match(nested.message, /^config\.run\.writeToolNames\[1\] is not accepted/u, "路径必须点名下标");
  assert.match(nested.message, /the config subtree must survive a JSON round-trip unchanged/u);
});

// ================================================================ R. 读侧不动（真 run）

test("R1 invalidArguments 仍决定「引数写坏要不要执行」：execute 档照旧执行", async () => {
  const executed = [];
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "c1", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider,
    seed: "go",
    tools: [{ name: "work", description: "d", inputSchema: { type: "object", properties: {} } }],
    executeTool: async (call) => {
      executed.push(call.input);
      return "ok";
    },
    maxRounds: 2,
    completion: false,
    wrapup: false,
    config: { run: { invalidArguments: "execute" } },
  });
  assert.equal(executed.length, 1, "`execute` 档照旧执行工具（裁决读的是展开后的 effectiveOptions）");
});

test("R2 replayPolicy 仍决定 resume 重放：per-tool-declaration 档把 unsafe 调用改写成 interrupted", async () => {
  // 读侧证据走「只跑一次、只看配置是否到达分支」的轻量形态：`run-snapshot-executor` 读的是
  // `ctx.replayPolicy`（由展开后的 `effectiveOptions.replayPolicy` 注入）。这里钉的是**值到达**
  // 与**非法值仍被拒**两件事；完整重放行为由 `test/loop-resume.test.js` 继续钉（本片改的是它的
  // 写侧拼写，不是判据）。
  const rejected = await directError(minimalRun({ config: { run: { replayPolicy: "sometimes" } } }));
  assert.match(
    rejected.message,
    /^replayPolicy must be "always-replay" or "per-tool-declaration"$/u,
    "非法值必须仍由引擎的语义相拒（不是名称闸口）⇒ 值真的到达了读侧",
  );
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { run: { replayPolicy: "per-tool-declaration" } },
  });
  assert.equal(effectiveOptions.replayPolicy, "per-tool-declaration");
});

test("R3 writeToolNames 仍整体替换默认写工具集（judge 的 filesWritten 读侧未改）", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "e1", name: "edit", input: { path: "touched.txt", edits: [] } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    { content: [{ type: "text", text: JSON.stringify({ done: true, confidence: 1, reason: "done", evidence: "e" }) }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider,
    seed: "edit one file",
    executeTool: async () => "已编辑 touched.txt：0 处替换",
    maxRounds: 2,
    completion: false,
    wrapup: false,
    config: { run: { writeToolNames: ["fs_write"] } },
    reflection: { enabled: true, judgeIntercept: false, maxExtensions: 0, judge: { provider: judge } },
  });
  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.doesNotMatch(
    prompt,
    /touched\.txt\(R1\)/u,
    "显式集合整体替换默认集（edit 不再算写工具）——judge 读侧一字未改，读的仍是展开后的值",
  );
});

test("R4 writeToolPathKeys 仍是路径键优先级（judge 摘要按序取第一个非空字符串）", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "w1", name: "fs_write", input: { file_path: "custom.txt", contents: "x" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    { content: [{ type: "text", text: JSON.stringify({ done: true, confidence: 1, reason: "done", evidence: "written" }) }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider,
    seed: "write one file",
    executeTool: async () => "written",
    maxRounds: 2,
    completion: false,
    wrapup: false,
    config: { run: { writeToolNames: ["fs_write"], writeToolPathKeys: ["file_path"] } },
    reflection: { enabled: true, judgeIntercept: false, maxExtensions: 0, judge: { provider: judge } },
  });
  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.match(prompt, /custom\.txt\(R1\)/u, "`writeToolPathKeys` 仍决定摘要取哪个键（读侧未改）");
});

// ================================================================ N. 撞名与邻接（每个名字只碰一张面）

test("N1 四个名字都不是混装壳：文案只点一站（对照 `context` 证明两站机制仍咬得住）", async () => {
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

test("N2 `replayPolicy` 与 `session.resume` 是两张面：#531 的裁决原样保留（本片不碰）", async () => {
  // `session` 仍是第三站成员（顶层家），`config.metadata.session` 仍是闭门——本片只做 `run` 组的
  // 四个写侧拼写，不许把那条裁决的钉子顺手改掉。
  assert.equal(TOP_LEVEL_SURFACE_OPTION_NAMES.includes("session"), true, "`session` 必须仍是第三站成员");
  assert.equal(configPathForOption("session"), undefined, "`session` 不许有任何嵌套家（#531）");
  const closed = await directError(minimalRun({ config: { metadata: { session: { id: "a11" } } } }));
  assert.match(closed.message, /^unknown config\.metadata option: "session"/u, "#531 的闭门钉子原样保留");
  // 而 `resume` 仍是**扁平合法**键（本片没动它），`replayPolicy` 的规位与它各住一处。
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("resume"), true, "`resume` 仍是扁平合法选项");
  assert.equal(configPathForOption("replayPolicy"), "run.replayPolicy", "`replayPolicy` 的家是 config.run");
});

test("N3 `writeToolNames` / `writeToolPathKeys` 在 judge / termination 侧是**读侧**（本片只改拼写）", async () => {
  // 读侧不动的机器证据：judge 的公开入口 `rawWritePath` 收的是**展开后的值**，本片一行未改；
  // 而宿主面唯一变的是「那个值从哪来」（扁平 → `config.run.*`，由展开相写回）。
  const { effectiveOptions } = await normalizeRunToolLoopOptions({
    config: { run: { writeToolNames: ["fs_write"], writeToolPathKeys: ["file_path"] } },
  });
  assert.deepEqual(effectiveOptions.writeToolNames, ["fs_write"]);
  assert.deepEqual(effectiveOptions.writeToolPathKeys, ["file_path"]);
  // `rawWritePath` 的入参形状是 `{ writeToolNames: Set, writeToolPathKeys: string[] }`——那是
  // `resolveWriteOptions` 的产物（引擎内部），不是宿主拼写；这里按引擎实际喂的形状调它。
  assert.equal(
    rawWritePath("fs_write", { file_path: "a.txt" }, {
      writeToolNames: new Set(effectiveOptions.writeToolNames),
      writeToolPathKeys: effectiveOptions.writeToolPathKeys,
    }),
    "a.txt",
    "judge 读侧仍按 `writeToolPathKeys` 的顺序取路径键（一行未改）",
  );
});

test("N4 `maxTokenContinuations`（run 组）与已退役的 `maxTokens`（tuning 组）不同物", async () => {
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("maxTokenContinuations"), true);
  assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes("maxTokens"), false, "`maxTokens` 由 A5 退役");
  assert.equal(configPathForOption("maxTokenContinuations"), "run.maxTokenContinuations");
  assert.equal(configPathForOption("maxTokens"), "tuning.maxTokens");
  assert.notEqual(configPathForOption("maxTokenContinuations"), configPathForOption("maxTokens"));
});

// ================================================================ A. 账目派生化

test("A1 四向闭合 + 配置面差额是派生差值（不手抄 43 / 17 / 13 这类条数）", () => {
  const { configPlane, capability, topLevelSurface, containers } = optionHomeBuckets(RUN_TOOL_LOOP_OPTION_NAMES);
  const partition = [...configPlane, ...capability, ...topLevelSurface, ...containers];
  assert.equal(new Set(partition).size, partition.length, "四个面两两不相交");
  assert.deepEqual([...partition].sort(), [...RUN_TOOL_LOOP_OPTION_NAMES].sort(), "四向之和逐键等于白名单");
  // 配置面 = 配置面名单 − 已退役扁平键（两边都从符号派生，「少了几个」不用手抄）。
  const retiredFlatKeys = CONFIG_SURFACE_OPTION_NAMES.filter((name) => !RUN_TOOL_LOOP_OPTION_NAMES.includes(name));
  assert.equal(
    configPlane.length + retiredFlatKeys.length,
    CONFIG_SURFACE_OPTION_NAMES.length,
    "配置面 = 配置面名单 − 已退役扁平键",
  );
  assert.deepEqual(configPlane, configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES));
  // 本片只动配置面：能力面与第三站的成员集一字未改（派生，不手抄条数）。
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

test("A2 `run` 组**没有**整组收口：四个退役叶子被派生认出，其余扁平孪生照旧", () => {
  // ⚠ 本片只退小四件，`run` 组的 `maxRounds` / `completion` / `reflection` … 仍是**扁平合法**键。
  // 所以这里不写「STILL_FLAT_RUN === []」——那会把「组收口」这个未发生的事写成事实。
  assert.deepEqual(
    [...RETIRED_RUN].sort(),
    RETIRED.map(({ key }) => key).sort(),
    "退役叶子集必须与 RETIRED 的键集逐字相等（删了键却漏登记 ⇒ 这里红）",
  );
  for (const { key } of RETIRED) {
    assert.equal(STILL_FLAT_RUN.includes(key), false, `${key} 不许还在扁平名单里`);
  }
  // 本片**没碰**的 `run` 叶子照旧是扁平选项（每个都派生自查名单，不手抄）。
  for (const leaf of ["maxRounds", "completion", "reflection", "resume", "stream"]) {
    assert.equal(RUN_TOOL_LOOP_OPTION_NAMES.includes(leaf), true, `${leaf} 本片一个字没动`);
  }
  assert.equal(
    STILL_FLAT_RUN.length + RETIRED_RUN.length,
    CONFIG_NAMESPACE_SCHEMA.run.length,
    "`run` 组叶子 = 仍是扁平的 + 已退役的（派生恒等式）",
  );
});

test("A3 test/ 里不许出现手抄的白名单条数（`RUN_TOOL_LOOP_OPTION_NAMES.length, <数字>`）", () => {
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
  assert.deepEqual(offenders, [], "白名单条数必须派生，不许手抄（A8/A9 的同一条规矩）");
});
