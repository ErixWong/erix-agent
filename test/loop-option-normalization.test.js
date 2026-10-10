// issue #177 刀1（选项规范化）的**前置行为表征测试**：纯新增，`src/` 零改动。
//
// 目的：把 `src/loop/orchestrator.js` 里那段「选项处理」（未知键检查 → assemblyPortOptions →
// 显式值合并 → 能力缺失检查 → modelConfig.resolve → 解构默认值）的**现有语义**钉死，
// 让刀1 的搬迁可以宣称「零行为变化」——搬完之后这批用例必须一条不红。
//
// 全部用例只走公共入口 `runToolLoop`（不 import 任何内部模块），所以将来抽出
// `src/loop/option-normalization.js` 时本文件**不需要改**：它钉的是外部可观察行为，
// 不是内部函数名/文件位置。
//
// 反向证（防「恒绿装饰」）——每条断言都对应一处「顺手就会改错」的写法，实测见 WORK-REPORT：
//   ① 合并改成无条件覆盖（`effectiveOptions[key] = value`）→ 「显式 undefined 不覆盖」用例红
//   ② 阈值改成恒定 2（丢掉 `Math.max` / `⌊len/3⌋`）→ 阈值随长度放大的用例红
//   ③ 能力缺失检查与 `modelConfig.resolve` 换序 → 「检查先于 resolve」用例红
//   ④ 合并改成 `!= null` / truthy 判断 → `null` 覆盖、`false` 覆盖用例红
//   ⑤ 建议平局把 `<` 写成 `<=` → 「平局取白名单在前」用例红
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

// ---------------------------------------------------------------- 测试卫生
// 本文件不写盘（全程用注入的临时 home/cwd，绝不碰真实 `~/.erix`），但依旧把 HOME 与 cwd
// 挪进 os.tmpdir()：一是 AGENTS.md 的测试隔离规矩，二是让「loop 不读 HOME/cwd」这件事
// 本身成为被断言的对象（见文件末的卫生用例）。
// ERIX_STALL_MODE 会覆盖 stallDetection 的 mode，默认值用例必须在一个干净的环境里跑。
//
// home 用 helpers/tmp.js 的 makeTmp（自带 TMPDIR 可写探针）；cwd 沙箱不能同样用 makeTmp：
// 它的清理 `after()` 是在 `before` 里注册的，钩子作用域属于那个钩子而不是整个文件，会在
// 后面的用例还在 chdir 状态时就把目录抽掉（实测 `uv_cwd` ENOENT）。cwd 自己建、自己在
// 文件级 `after` 里删。
const REAL_ERIX_HOME = join(homedir(), ".erix");
const realHomeSnapshot = () => (existsSync(REAL_ERIX_HOME)
  ? { exists: true, mtimeMs: statSync(REAL_ERIX_HOME).mtimeMs }
  : { exists: false, mtimeMs: null });
const homeSnapshotAtStart = realHomeSnapshot();
let sandboxHome;
let sandboxCwd;
let savedHome;
let savedUserProfile;
let savedCwd;
let savedStallMode;

before(async () => {
  sandboxHome = await makeTmp("erix-opt-home-");
  sandboxCwd = await mkdtemp(join(realpathSync(tmpdir()), "erix-opt-cwd-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedCwd = process.cwd();
  savedStallMode = process.env.ERIX_STALL_MODE;
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  delete process.env.ERIX_STALL_MODE;
  process.chdir(sandboxCwd);
});

after(async () => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  if (savedStallMode === undefined) delete process.env.ERIX_STALL_MODE; else process.env.ERIX_STALL_MODE = savedStallMode;
  await rm(sandboxCwd, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------- 夹具
const textStep = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const toolStep = (name = "noop", id = "c", input = { n: 1 }) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const DONE = [textStep("done")];
const REPEATED_TOOL = (times) => [{ times, ...toolStep() }];

/** 计数 chat / chatStream 调用次数的 provider 包装（`stream` 合并语义的可观察通道）。 */
function countingProvider(script) {
  const fake = createFakeProvider(script);
  const calls = { chat: 0, chatStream: 0 };
  return {
    protocol: "fake",
    model: "fake-model",
    requests: fake.requests,
    calls,
    chat: async (request) => {
      calls.chat += 1;
      return fake.chat(request);
    },
    chatStream: async (request) => {
      calls.chatStream += 1;
      return fake.chatStream(request);
    },
  };
}

/** 最小合法 AssemblyPort：policy 是 assembled 值的来源，modelConfig.resolve 自带调用日志。 */
function assemblyPortFixture({ policy = {}, script = DONE, portExtras = {} } = {}) {
  const log = [];
  const provider = countingProvider(script);
  const port = {
    modelConfig: {
      resolve: async (slot) => {
        log.push(`port.resolve:${slot ?? "-"}`);
        return { fromPort: true };
      },
    },
    provider,
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "run-assembled" },
    policy,
    ...portExtras,
  };
  return { port, provider, log };
}

/** 记录调用（含入参）的 modelConfig resolver 间谍。 */
function resolverSpy(label = "explicit", value = { fromExplicit: true }) {
  const calls = [];
  return {
    calls,
    modelConfig: {
      resolve: async (slot) => {
        calls.push(`${label}:${slot ?? "-"}`);
        return value;
      },
    },
  };
}

/** 只带一个未知键时 `runToolLoop` 的抛错文本（未知键检查在函数第一行，无需备齐端口）。 */
async function errorForUnknownKey(key) {
  return runToolLoop({ [key]: 1 }).then(
    () => { throw new Error(`expected a rejection for unknown option key ${JSON.stringify(key)}`); },
    (error) => error,
  );
}

/**
 * 测试侧独立实现的编辑距离：只用来**自证样本表**（下表里每行的 distance/threshold 若与实现
 * 漂移，样本立刻失效并变红），不参与任何被测逻辑。
 */
function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

const suggestionThreshold = (unknownName) => Math.max(2, Math.floor(unknownName.length / 3));

// 白名单 = `RUN_TOOL_LOOP_OPTION_NAMES`（**60 项**，顺序即平局优先级）。这里内联复制而不是
// import：表征测试要能在刀1 之后继续钉住同一份名单——名单被改动时本用例应**主动变红**，
// 逼着改动者确认「建议行为」是否随之变化。
const OPTION_WHITELIST = [
  "assemblyPort",
  "provider",
  "system",
  "cacheStablePrefix",
  "wrapup",
  "initialUserMessage",
  "initialMessages",
  "tools",
  "outputHygiene",
  "writeToolNames",
  "writeToolPathKeys",
  "executeTool",
  "replayPolicy",
  "partialPersistence",
  "maxRounds",
  "cacheCapable",
  "toolResultTtl",
  "toolResultFoldMinTokens",
  "maxTokens",
  "temperature",
  "topP",
  "timeoutMs",
  "deadlineMs",
  "reflection",
  "stallDetection",
  "retry",
  "completion",
  "finalGuard",
  "finalGuardMaxRetries",
  "finalGuardTimeoutMs",
  "maxTokenContinuations",
  "context",
  "todoStateProvider",
  "semanticStateProvider",
  "modelConfig",
  "modelMetadata",
  "model",
  "expert",
  "user",
  "task",
  "session",
  "requestId",
  "toolContext",
  "store",
  "persistence",
  "runId",
  "resume",
  "onRound",
  "onJudge",
  "onToolResult",
  "onPersistenceError",
  "diagnostics",
  "onObserverError",
  "signal",
  "stream",
  "onDelta",
  "onReasoningDelta",
  "onToolCall",
  "onUsage",
  "onEvent",
];

// ================================================================ A. 未知选项建议
// 阈值 = `Math.max(2, Math.floor(未知名长度 / 3))`；下表逐行钉住两个分支与两侧边界。
const SUGGESTION_MATRIX = [
  // ── `Math.max(2, …)` 下限分支：长度 3 → ⌊3/3⌋=1，仍按 2 放行（去掉 Math.max 就会红）
  { key: "too", distance: 2, threshold: 2, suggested: "tools", note: "长度 3：阈值取 Math.max 下限 2" },
  // ── 长度 6/8 → ⌊len/3⌋ 仍是 2
  { key: "maxRondz", distance: 2, threshold: 2, suggested: "maxRounds", note: "长度 8：恰好等于阈值" },
  { key: "zzztem", distance: 3, threshold: 2, suggested: undefined, note: "长度 6：超出阈值 1 → 不建议" },
  // ── `⌊len/3⌋` 分支：阈值随长度放大（阈值恒为 2 就会红）
  { key: "zzzRounds", distance: 3, threshold: 3, suggested: "maxRounds", note: "长度 9：阈值放大到 3" },
  { key: "toolResultTxxx", distance: 3, threshold: 4, suggested: "toolResultTtl", note: "长度 14：阈值 4，距离 3 在阈内" },
  { key: "finalGuardTimout", distance: 3, threshold: 5, suggested: "finalGuardTimeoutMs", note: "长度 16：阈值 5" },
  { key: "zzzzounds", distance: 4, threshold: 3, suggested: undefined, note: "长度 9：距离 4 超出阈值 3" },
  // ── 短到无可建议：`(did you mean …?)` 后缀整段缺席
  { key: "x", distance: 4, threshold: 2, suggested: undefined, note: "长度 1：最小距离 4 > 2" },
];

test("未知选项建议阈值 = Math.max(2, floor(len/3))，两侧边界都钉住", async () => {
  for (const row of SUGGESTION_MATRIX) {
    // 样本自证：距离与阈值按测试侧独立实现复核一遍，表意不符就先红在这里。
    assert.equal(suggestionThreshold(row.key), row.threshold, `${row.key} 的阈值`);
    if (row.suggested !== undefined) {
      assert.equal(editDistance(row.key, row.suggested), row.distance, `${row.key} → ${row.suggested} 的距离`);
    }
    const error = await errorForUnknownKey(row.key);
    const expected = row.suggested === undefined
      ? `unknown runToolLoop option: ${JSON.stringify(row.key)}`
      : `unknown runToolLoop option: ${JSON.stringify(row.key)}`
        + ` (did you mean ${JSON.stringify(row.suggested)}?)`;
    assert.equal(error instanceof TypeError, true, row.note);
    assert.equal(error.message, expected, `${row.note}（长度 ${row.key.length} / 距离 ${row.distance} / 阈值 ${row.threshold}）`);
    assert.equal(error.message.includes("(did you mean"), row.suggested !== undefined, row.note);
  }
});

// 白名单（= 建议候选池）的**顺序**参与决策：`optionSuggestion` 用严格 `<` 比较，
// 所以等距平局时**名单里靠前的那个**赢——既不是字典序，也不是「后出现的覆盖」。
// 下面每一行的两个候选到未知键的距离严格相等。
const TIE_MATRIX = [
  {
    key: "too",
    tied: ["tools", "topP"],
    expected: "tools",
    note: "白名单顺序（tools 在前）压过字典序（topP 更小）",
  },
  {
    key: "writeToolPath",
    tied: ["writeToolNames", "writeToolPathKeys"],
    expected: "writeToolNames",
    note: "最接近真实打错的键名：距离 4，阈值恰为 4",
  },
  {
    key: "strtem",
    tied: ["system", "stream"],
    expected: "system",
    note: "白名单顺序 ≠ 字典序：stream 字典序更小但不是答案",
  },
  {
    key: "onEvund",
    tied: ["onRound", "onEvent"],
    expected: "onRound",
    note: "onEvent 字典序更小，但 onRound 在白名单里更靠前",
  },
];

test("建议平局取白名单顺序在前者（严格 < 比较，非字典序）", async () => {
  for (const row of TIE_MATRIX) {
    const [first, second] = row.tied;
    // 样本自证：两个候选必须**严格等距**且都在阈值内，否则这不是平局。
    const distance = editDistance(row.key, first);
    assert.equal(editDistance(row.key, second), distance, `${row.key} 到 ${first}/${second} 必须等距`);
    assert.equal(distance <= suggestionThreshold(row.key), true, `${row.key} 的平局候选必须在阈值内`);
    assert.ok(
      OPTION_WHITELIST.indexOf(first) < OPTION_WHITELIST.indexOf(second),
      `${first} 必须排在 ${second} 之前`,
    );
    const error = await errorForUnknownKey(row.key);
    assert.equal(
      error.message,
      `unknown runToolLoop option: ${JSON.stringify(row.key)} (did you mean ${JSON.stringify(row.expected)}?)`,
      row.note,
    );
    // 反面对手（字典序在前 / 白名单在后）绝不能被选中。
    const loser = row.expected === first ? second : first;
    assert.equal(error.message.includes(`did you mean ${JSON.stringify(loser)}`), false, `${row.note}：不该建议 ${loser}`);
  }
});


test("白名单恰为 60 项：每一项都被接受，未知键一律被拒", async () => {
  assert.equal(OPTION_WHITELIST.length, 60);
  assert.equal(new Set(OPTION_WHITELIST).size, 60);
  // 平局断言依赖这份顺序，先自证它没被顺手排序成字典序。
  assert.notEqual(
    JSON.stringify(OPTION_WHITELIST),
    JSON.stringify([...OPTION_WHITELIST].sort()),
    "白名单顺序参与平局裁决，不能是字典序",
  );

  for (const name of OPTION_WHITELIST) {
    // provider:{} 故意缺 chat：已知键会一路走到「能力缺失检查」并在那里抛错。
    // 于是「抛的是 unknown runToolLoop option」⇔ 该键不在白名单。
    const error = await runToolLoop({ [name]: null, provider: {}, executeTool: async () => "ok" })
      .then(() => { throw new Error(`expected rejection for ${name}`); }, (caught) => caught);
    assert.equal(
      /^unknown runToolLoop option/.test(error.message),
      false,
      `${name} 应当在白名单内（实际抛：${error.message}）`,
    );
  }

  for (const unknown of ["maxRound", "asemblyPort", "toolResultTl"]) {
    const error = await errorForUnknownKey(unknown);
    assert.match(error.message, /^unknown runToolLoop option/);
  }
});

// ================================================================ B. 合并语义
// `effectiveOptions` 的构造：先铺 assembled（assemblyPortOptions 的结果），再让显式值
// **仅当 `!== undefined` 时**覆盖。⇒ `false` 能覆盖、`null` 能覆盖、`undefined` 不能覆盖。
// 这里刻意不用 `??`/truthy 判断，所以三行都必须被单独钉住。
test("assembled（assemblyPortOptions）值原样生效：作为合并语义的对照组", async () => {
  const { port, provider, log } = assemblyPortFixture({
    policy: { maxTokens: 4096, temperature: 0.5, stream: true },
    script: DONE,
  });
  const result = await runToolLoop({ assemblyPort: port, initialUserMessage: "go" });
  assert.equal(result.rounds, 1);
  assert.deepEqual(log, ["port.resolve:-"]);
  assert.deepEqual(provider.calls, { chat: 0, chatStream: 1 }, "assembled stream:true 应走 chatStream");
  assert.equal(provider.requests[0].maxTokens, 4096);
  assert.equal(provider.requests[0].temperature, 0.5);
});

test("显式值仅当 !== undefined 才覆盖：undefined 保留 assembled 值（改成无条件覆盖必红）", async () => {
  // 通道①：数值 —— assembled maxTokens 必须留在 provider 请求里
  const tokens = assemblyPortFixture({ policy: { maxTokens: 4096 }, script: DONE });
  await runToolLoop({
    assemblyPort: tokens.port,
    initialUserMessage: "go",
    maxTokens: undefined, // 显式存在但值为 undefined：不是「没传」的省略，是「传了 undefined」
  });
  assert.equal("maxTokens" in tokens.provider.requests[0], true, "undefined 不该把 assembled maxTokens 抹掉");
  assert.equal(tokens.provider.requests[0].maxTokens, 4096);

  // 通道②：轮次 —— assembled maxRounds 仍然是生效值（被抹成 undefined 会直接抛校验错）
  const rounds = assemblyPortFixture({
    policy: { maxRounds: 3 },
    script: REPEATED_TOOL(6),
  });
  const result = await runToolLoop({
    assemblyPort: rounds.port,
    initialUserMessage: "go",
    maxRounds: undefined,
  });
  assert.equal(result.rounds, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.termination.reason, "max_rounds_cap");

  // 通道③：布尔真值 —— assembled stream:true 仍走 chatStream
  const stream = assemblyPortFixture({ policy: { stream: true }, script: DONE });
  await runToolLoop({ assemblyPort: stream.port, initialUserMessage: "go", stream: undefined });
  assert.deepEqual(stream.provider.calls, { chat: 0, chatStream: 1 });
});

test("显式 false 覆盖 assembled 真值（改成 truthy 判断必红）", async () => {
  const { port, provider } = assemblyPortFixture({ policy: { stream: true }, script: DONE });
  await runToolLoop({ assemblyPort: port, initialUserMessage: "go", stream: false });
  assert.deepEqual(provider.calls, { chat: 1, chatStream: 0 }, "false 必须覆盖 assembled 的 true");
});

test("显式 null 覆盖 assembled 值（改成 ?? / != null 必红）", async () => {
  // 通道①：null 原样透传到 provider 请求（`??` 会把它退回 assembled 的 4096）
  const tokens = assemblyPortFixture({ policy: { maxTokens: 4096 }, script: DONE });
  await runToolLoop({ assemblyPort: tokens.port, initialUserMessage: "go", maxTokens: null });
  assert.equal("maxTokens" in tokens.provider.requests[0], true);
  assert.equal(tokens.provider.requests[0].maxTokens, null);

  // 通道②：null 触发下游校验 → 证明生效值确实是 null 而不是 assembled 的 3
  const rounds = assemblyPortFixture({ policy: { maxRounds: 3 }, script: DONE });
  await assert.rejects(
    runToolLoop({ assemblyPort: rounds.port, initialUserMessage: "go", maxRounds: null }),
    (error) => error instanceof TypeError
      && error.message === "maxRounds must be a finite positive integer",
  );

  // 通道③：布尔 —— null 是假值，assembled 的 true 被覆盖后走 chat
  const stream = assemblyPortFixture({ policy: { stream: true }, script: DONE });
  await runToolLoop({ assemblyPort: stream.port, initialUserMessage: "go", stream: null });
  assert.deepEqual(stream.provider.calls, { chat: 1, chatStream: 0 });
});

test("显式非 undefined 值覆盖 assembled 值（含 modelConfig 覆盖的透传门）", async () => {
  const tokens = assemblyPortFixture({ policy: { maxTokens: 4096, maxRounds: 3 }, script: REPEATED_TOOL(6) });
  const result = await runToolLoop({
    assemblyPort: tokens.port,
    initialUserMessage: "go",
    maxTokens: 128,
    maxRounds: 2,
  });
  assert.equal(tokens.provider.requests[0].maxTokens, 128);
  assert.equal(result.rounds, 2);

  // assemblyPortOptions 的第二层门：显式 modelConfig **存在**时才作为 overrides 传下去，
  // 此时端口自带的 resolver 一次都不该被调用；显式 undefined 时才回去调端口的。
  const override = resolverSpy("explicit");
  const withOverride = assemblyPortFixture({ script: DONE });
  await runToolLoop({
    assemblyPort: withOverride.port,
    initialUserMessage: "go",
    modelConfig: override.modelConfig,
  });
  assert.deepEqual(withOverride.log, [], "显式 modelConfig 覆盖时端口 resolver 不应被调用");
  assert.deepEqual(override.calls, ["explicit:-"], "显式 modelConfig 应被 runToolLoop 自己 resolve 一次");

  const withUndefined = assemblyPortFixture({ script: DONE });
  await runToolLoop({
    assemblyPort: withUndefined.port,
    initialUserMessage: "go",
    modelConfig: undefined,
  });
  assert.deepEqual(withUndefined.log, ["port.resolve:-"], "显式 undefined 时端口 resolver 应照常调用一次");
});

// ================================================================ C. 校验先后次序
test("次序①：未知键检查早于一切（端口未被触碰、resolver 未被调用、后续校验未执行）", async () => {
  const reads = [];
  const inner = {
    modelConfig: { resolve: async () => ({}) },
    provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "run-order" },
    policy: {},
  };
  const port = new Proxy(inner, {
    get(target, property) {
      reads.push(String(property));
      return target[property];
    },
  });
  const spy = resolverSpy("explicit");
  const error = await runToolLoop({
    assemblyPort: port,
    initialUserMessage: "go",
    modelConfig: spy.modelConfig,
    maxRounds: 0, // 非法值：若未知键检查不在最前，会先报 maxRounds
    bogusKey: 1,
  }).then(() => null, (caught) => caught);
  assert.equal(
    error.message,
    'unknown runToolLoop option: "bogusKey"',
    "未知键错误必须先于 maxRounds 校验与 assemblyPortOptions 抛出",
  );
  assert.deepEqual(reads, [], "选项对象里的端口在未知键检查前不得被读取");
  assert.deepEqual(spy.calls, [], "modelConfig.resolve 不得被调用");
});

test("次序②：assemblyPortOptions 早于 runToolLoop 的能力缺失检查", async () => {
  // 显式选项里没有 provider/executeTool（它们本应由端口提供）：若能力检查抢在
  // assemblyPortOptions 之前，报的会是「missing methods: provider…, executeTool」。
  const error = await runToolLoop({
    assemblyPort: {
      modelConfig: { resolve: async () => ({}) },
      provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
      tools: { definitions: [], executeTool: async () => "ok" },
      session: { id: "run-port-first", resume: "yes" }, // resume 必须是布尔：只有 createAssemblyPort 会这样报
    },
    initialUserMessage: "go",
  }).then(() => null, (caught) => caught);
  assert.equal(error.message, "assembly port session.resume must be a boolean");

  // 对照组：同样缺 provider/executeTool 的细粒度形态，能力检查的措辞完全不同。
  const capabilityError = await runToolLoop({ initialUserMessage: "go" }).then(() => null, (caught) => caught);
  assert.equal(
    capabilityError.message,
    "assembly port is missing methods: provider.chat or provider.chatStream, executeTool",
  );
});

test("次序③：能力缺失检查早于 modelConfig.resolve（换序必红）", async () => {
  const spy = resolverSpy("explicit");
  const error = await runToolLoop({
    provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
    executeTool: async () => "ok",
    initialUserMessage: "go",
    session: { id: "" }, // 细粒度形态 + 非法 session.id ⇒ 能力缺失
    modelConfig: spy.modelConfig,
  }).then(() => null, (caught) => caught);
  assert.equal(error.message, "assembly port is missing methods: session.id");
  assert.deepEqual(spy.calls, [], "能力缺失必须先抛错，不能先 await 宿主的 resolver");

  // 同一夹具去掉缺陷：resolve 必须被调用**恰好一次**且吃到 session.modelSlot
  // ——证明上面的 0 次断言不是「resolver 根本不会被调」造成的恒绿。
  const okSpy = resolverSpy("ok");
  const result = await runToolLoop({
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    initialUserMessage: "go",
    session: { id: "run-resolve", modelSlot: "slotA" },
    modelConfig: okSpy.modelConfig,
  });
  assert.equal(result.rounds, 1);
  assert.deepEqual(okSpy.calls, ["ok:slotA"]);
});

test("次序④：显式 modelConfig 覆盖在 assemblyPortOptions 内部就被校验，端口 resolver 让位", async () => {
  const { port, log } = assemblyPortFixture({ script: DONE });
  const error = await runToolLoop({
    assemblyPort: port,
    initialUserMessage: "go",
    modelConfig: { temperature: 1 }, // 裸配置对象，没有 resolve
  }).then(() => null, (caught) => caught);
  assert.match(error.message, /^assembly port is missing methods: modelConfig\.resolve \(modelConfig must expose resolve\(slot\)/);
  assert.deepEqual(log, [], "覆盖值不合法时端口 resolver 不应被调用");
});

// ================================================================ D. 默认值由解构填充
// 这些默认值写在参数解构里（`maxRounds = 8`），**不是** `?? ` 兜底：语义差别在于
// 「显式传 null / false 不会被默认值吃掉」（B 段已钉），而缺省时默认值本身必须是下表这些。
test("默认值 maxRounds = 8", async () => {
  const provider = createFakeProvider(REPEATED_TOOL(12));
  const result = await runToolLoop({ provider, executeTool: async () => "ok", initialUserMessage: "go" });
  assert.equal(result.rounds, 8);
  assert.equal(result.truncated, true);
  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(provider.requests.length, 9); // 第 9 次请求只为拼出 truncated 终局
});

test("默认值 cacheStablePrefix = true 与 wrapup = true", async () => {
  const defaulted = createFakeProvider(DONE);
  await runToolLoop({ provider: defaulted, executeTool: async () => "ok", initialUserMessage: "go", system: "SYS" });
  const system = defaulted.requests[0].system;
  assert.equal(typeof system, "object", "默认 cacheStablePrefix:true ⇒ system 带 cacheBoundary 包装");
  assert.equal(system.cacheBoundary, true);
  assert.match(system.content, /^SYS\n\n任务完成或需要给出结论时/, "默认 wrapup:true ⇒ 追加 JSON 收尾协议");
  assert.match(system.content, /\{"done":true,"summary":"任务总结","output":"给用户的结果"\}/);
  assert.equal(defaulted.requests[0].messages[0].cacheBoundary, true);

  const optedOut = createFakeProvider(DONE);
  await runToolLoop({
    provider: optedOut,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    system: "SYS",
    cacheStablePrefix: false,
    wrapup: false,
  });
  assert.equal(optedOut.requests[0].system, "SYS", "两个默认值都能被显式 false 关掉");
  assert.equal("cacheBoundary" in optedOut.requests[0].messages[0], false);
});

test("默认值 completion = { signals: [], maxNoToolRounds: 3 }", async () => {
  // 一轮工具之后连续只出文本：默认 signals:[] ⇒ 任何字符串都不算完成信号，
  // 连续 3 轮空转（maxNoToolRounds:3）后才以 no_tool 收尾。
  const provider = createFakeProvider([toolStep(), { times: 6, ...textStep("just talking") }]);
  const result = await runToolLoop({ provider, executeTool: async () => "ok", initialUserMessage: "go" });
  assert.equal(result.termination.reason, "no_tool");
  assert.equal(result.rounds, 4); // 1 轮工具 + 3 轮无工具
  assert.equal(provider.requests.length, 4);

  // 对照组：completion:false ⇒ 第一轮无工具就收尾；signals:["DONE"] ⇒ 命中信号即收尾。
  const off = createFakeProvider([toolStep(), { times: 6, ...textStep("just talking") }]);
  const offResult = await runToolLoop({
    provider: off,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
  });
  assert.equal(offResult.rounds, 2);
  assert.equal(offResult.termination.reason, "end_turn");

  const signaled = createFakeProvider([toolStep(), { times: 6, ...textStep("DONE") }]);
  const signalResult = await runToolLoop({
    provider: signaled,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: { signals: ["DONE"] },
  });
  assert.equal(signalResult.rounds, 2);
  assert.equal(signalResult.termination.reason, "end_turn");
});

test("默认值 stallDetection = { window: 4, mode: \"consecutive\" }", async () => {
  const nudged = (provider) => provider.requests.some((request) => request.messages.some(
    (message) => Array.isArray(message.content)
      && message.content.some((block) => /疑似重复调用/.test(block.text ?? "")),
  ));

  // 恰好 4 次连续相同调用（= window）⇒ 还不算停滞；第 5 次（window+1）⇒ 触发 nudge。
  // 默认值改成 3 或 5 都会让这两条同时变红。
  const atWindow = createFakeProvider([{ times: 4, ...toolStep() }, { times: 4, ...textStep("tail") }]);
  const atWindowResult = await runToolLoop({
    provider: atWindow,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
  });
  assert.equal(atWindowResult.rounds, 5);
  assert.equal(nudged(atWindow), false, "4 次连续相同调用仍在窗口内，不应 nudge");

  const pastWindow = createFakeProvider([{ times: 5, ...toolStep() }, { times: 4, ...textStep("tail") }]);
  const pastWindowResult = await runToolLoop({
    provider: pastWindow,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
  });
  assert.equal(pastWindowResult.rounds, 6);
  assert.equal(nudged(pastWindow), true, "第 5 次连续相同调用应触发停滞 nudge");

  // mode 默认 consecutive：a/b 交替重读同一批文件不是停滞（真实项目评估 §5.2 的 appear 误杀）。
  const alternating = createFakeProvider([
    toolStep("readFile", "a1", { path: "a.txt" }),
    toolStep("readFile", "b1", { path: "b.txt" }),
    toolStep("readFile", "a2", { path: "a.txt" }),
    toolStep("readFile", "b2", { path: "b.txt" }),
    toolStep("readFile", "a3", { path: "a.txt" }),
    toolStep("readFile", "b3", { path: "b.txt" }),
    textStep("done"),
  ]);
  const alternatingResult = await runToolLoop({
    provider: alternating,
    executeTool: async () => "ok",
    initialUserMessage: "go",
    completion: false,
  });
  assert.equal(alternatingResult.rounds, 7);
  assert.equal(alternatingResult.termination.reason, "end_turn");
  assert.equal(nudged(alternating), false, "consecutive 模式不把交替重读判为停滞");
});

// ================================================================ 测试卫生
test("测试卫生：全程只用注入的临时 home/cwd，真实 ~/.erix 未被创建或改写", async () => {
  const provider = createFakeProvider(DONE);
  await runToolLoop({ provider, executeTool: async () => "ok", initialUserMessage: "go" });
  assert.equal(provider.requests.length, 1);
  assert.equal(process.env.HOME, sandboxHome);
  assert.equal(process.cwd(), sandboxCwd);
  assert.notEqual(process.cwd(), savedCwd, "cwd 必须已经落在临时目录里");
  assert.equal(existsSync(join(sandboxHome, ".erix")), false, "临时 home 里不该出现 .erix");
  assert.deepEqual(realHomeSnapshot(), homeSnapshotAtStart, "真实 ~/.erix 必须一个字节都没动");
});
