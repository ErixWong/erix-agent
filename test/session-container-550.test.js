// issue #550 —— 顶层 `session` 一名二义（不透明载荷 vs 容器）的**裁决落地**，外加 `initialMessages`
// 在直连路线上的惰性。
//
// 基点事实（本文件逐条用探针钉住，不引用工单措辞）：
//   ① 路由判定是**入口形状**：`normalizeRunToolLoopOptions` 的 `via = assemblyPort === undefined ?
//      "direct" : "assembly"`（`src/loop/option-normalization.js`）；直连路线里还有一层
//      「细粒度端口形态」（`fineGrainedPortShape`，`src/loop/orchestrator.js`：`session` 是对象 /
//      显式 `modelConfig` / 有 `modelConfig.resolve`）——它让直连也要过装配口的成员契约。
//   ② 于是**同一个形状**在两条路线上曾有两个结论：`session: "x"` 直连当不透明载荷转发给
//      `executeTool({context.session})`，装配口当容器、当场拒（#513 明令不碰这条二义，留给本单）。
//   ③ 容器形状在直连路线上**被逐字校验却不产生行为**：`session.initialMessages` 通过成员闸门
//      （#513 的可接受集合），但只有装配路线把它折进 `config.input.messages`；直连的种子**静默丢失**。
//      `session.id` 同样惰性（直连的 transcript 键是 `undefined`）。
//
// **裁决：甲。** 顶层 `session` **只是容器**（`id` / `modelSlot` / `initialMessages`，全是数据），
// 不透明载荷**改名**——它的家是 `config.folding.context.session`（`toolContextFor` 的 fallback 链
// 今天就在读它，所以这条迁移可以先写新家、再升级引擎）。为什么不是乙（保留二义、只把两路结论对齐）：
// 见报告的「为什么另一种更差」——一句话，容器与载荷**共用一个键**时，宿主写容器就把载荷遮蔽了
// （`budget.js` 的「顶层优先」），对齐结论只能让两边一起**丢掉**载荷或一起**拒掉**容器，二义仍在。
//
// 本文件钉住裁决后的形状：
//   A. 两条路线对**同一形状**给出**同一句**判词（字符串 / 数字 / 布尔 / null / 数组），且判词点名新家；
//   B. 旧拼写（顶层字符串 `session`）当场红（反向证①），迁移后的写法（`config.folding.context.session`）
//      把同一个值送到同一个工具上下文键；
//   C. `session.initialMessages` 在**两条路线**上都真的被播（反向证②：撤掉接线 ⇒ 种子丢失可观测）；
//      并且 `config.input.messages` 赢过它（#544 的 rung 3：派生叶只填洞）；
//   D. `session.id` 在**两条路线**上都进 `config.run.runId`（同一个派生函数，不再只有装配口读）；
//   E. 容器**不**泄进工具上下文（`context.session` 只来自折叠上下文），派生集合的读取点表跟着动
//      （#513 A 的双向扫描仍咬，反向证③用变异跑）。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import {
  SESSION_MEMBER_NAMES,
  SESSION_MEMBER_READ_POINTS,
  collectSessionContainerProblems,
} from "../src/assembly-validators.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

const SEED_TEXT = "seed-from-session-550";
const seed = [{ role: "user", content: [{ type: "text", text: SEED_TEXT }] }];
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const TOOL_ROUND = [
  { content: [{ type: "tool_use", id: "tu_550", name: "echo", input: {} }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
];

/** 直连路线的最小合法入参（第三站 `executeTool` 必须在场，否则测到的是 missing-methods）。 */
function directOptions(extra = {}) {
  return {
    provider: createFakeProvider(TOOL_ROUND),
    executeTool: async () => "ok",
    config: { run: { completion: false }, input: { initialUserMessage: "go" } },
    ...extra,
  };
}

/** 装配路线的最小合法端口入参。 */
function portInput(extra = {}) {
  return {
    modelConfig: { resolve: async () => ({}) },
    provider: createFakeProvider(TOOL_ROUND),
    tools: { definitions: [], executeTool: async () => "ok" },
    ...extra,
  };
}

const thrown = async (promise) => promise.then(() => null, (error) => error);
const sent = (provider) => JSON.stringify(provider.requests?.[0]?.messages ?? []);

// ---------------------------------------------------------------------------------------------------
// A. 两条路线对同一形状给出同一句判词（甲的地基：一个键一个含义）
// ---------------------------------------------------------------------------------------------------

test("#550 A：非容器形状在两条路线上逐字同一句，且点名新家 config.folding.context.session", async () => {
  // 函数在装配路线上是**端口工厂**（先调用再判型），所以那一形状单列在 A2。
  const shapes = [
    ["a string", "s-550"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["an array", [1, 2]],
  ];
  for (const [described, value] of shapes) {
    const expected = `session must be an object (got ${described}): the run identity lives in its`
      + " members (session.id, session.modelSlot, session.initialMessages); the opaque payload that"
      + " reaches executeTool as context.session lives in config.folding.context.session";
    const direct = await thrown(runToolLoop(directOptions({ session: value })));
    const assembly = await thrown(Promise.resolve().then(() => createAssemblyPort(portInput({ session: value }))));
    assert.ok(direct instanceof TypeError, `${described}：直连必须抛 TypeError，实际 ${direct && direct.message}`);
    assert.equal(direct.message, expected, `${described}：直连判词`);
    assert.equal(assembly?.message, expected, `${described}：装配判词（同一句）`);
    assert.equal(direct.via, "direct");
    assert.equal(assembly?.via, "assembly");
    // 判词与共用闸门同源（没有第二份手抄句子）。
    assert.deepEqual(collectSessionContainerProblems(value), [expected]);
  }
});

test("#550 A2：装配路线上的函数是端口工厂——判的是返回值，与直连的「got a function」不是分歧", async () => {
  const direct = await thrown(runToolLoop(directOptions({ session: () => 1 })));
  assert.match(direct.message, /^session must be an object \(got a function\)/u);
  const assembly = await thrown(Promise.resolve()
    .then(() => createAssemblyPort(portInput({ session: () => 1 }))));
  assert.match(assembly.message, /^session must be an object \(got a number\)/u,
    "工厂先被 resolveAssemblyMember 调用，再判返回值的型（#513 C2 的同一条事实）");
});

test("#550 A3：容器形状两条路线都收，且成员闸门仍逐字列可接受集合", async () => {
  for (const session of [{ id: "s-550-ok" }, { id: "s-550-ok", modelSlot: "slotA" }]) {
    assert.deepEqual(collectSessionContainerProblems(session), []);
    assert.deepEqual(collectSessionContainerProblems({ ...session, bogus: 1 }), [
      `unknown session option: session.bogus (accepted: session.id, session.modelSlot, session.initialMessages)`,
    ]);
  }
  // 形状规则也搬进同一个闸门（#550）：两条路线同一句，不再是「assembly port …」。
  assert.deepEqual(
    collectSessionContainerProblems({ id: "s", initialMessages: "nope" }),
    ["session.initialMessages must be an array"],
  );
});

// ---------------------------------------------------------------------------------------------------
// B. 反向证①：旧拼写必须红并点名新家；迁移后的写法行为逐字不变
// ---------------------------------------------------------------------------------------------------

test("#550 B：旧拼写（顶层字符串 session）红并点名新家；config.folding.context.session 等价", async () => {
  const oldSpelling = await thrown(runToolLoop(directOptions({ session: "s-550-opaque" })));
  assert.ok(oldSpelling instanceof TypeError, "旧拼写必须红（0.28 破坏性收窄）");
  assert.ok(
    oldSpelling.message.includes("config.folding.context.session"),
    `判词必须点名新家（宿主迁移的唯一线索）：${oldSpelling.message}`,
  );
  assert.ok(oldSpelling.message.includes("the run identity lives in its members"));

  let seen;
  const result = await runToolLoop(directOptions({
    config: { run: { completion: false }, folding: { context: { session: "s-550-opaque" } } },
    executeTool: async (options) => {
      seen = options.context;
      return "ok";
    },
  }));
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(seen?.session, "s-550-opaque", "新家把同一个值送到同一个工具上下文键");
});

// ---------------------------------------------------------------------------------------------------
// C. 反向证②：initialMessages 接线（两条路线都播），且 config.input.messages 赢
// ---------------------------------------------------------------------------------------------------

test("#550 C：session.initialMessages 在直连与装配两条路线都真的进请求（同一份种子）", async () => {
  const directProvider = createFakeProvider(DONE);
  const directResult = await runToolLoop(directOptions({
    provider: directProvider,
    modelConfig: { resolve: async () => ({}) },
    session: { id: "s-550-seed-direct", initialMessages: seed },
  }));
  assert.equal(directResult.termination.reason, "end_turn");
  assert.ok(sent(directProvider).includes(SEED_TEXT), "直连路线必须播 session.initialMessages");

  const portProvider = createFakeProvider(DONE);
  const port = createAssemblyPort(portInput({
    provider: portProvider,
    session: { id: "s-550-seed-port", initialMessages: seed },
  }));
  // #519：`executeTool` 由端口给，调用点再给一份会抛（以前是静默覆盖）⇒ 只给 `assemblyPort`。
  const portResult = await runToolLoop({ assemblyPort: port });
  assert.equal(portResult.termination.reason, "end_turn");
  assert.ok(sent(portProvider).includes(SEED_TEXT), "装配路线必须播 session.initialMessages");

  assert.equal(
    JSON.stringify(directProvider.requests[0].messages),
    JSON.stringify(portProvider.requests[0].messages),
    "同一个容器 ⇒ 两条路线发出**同一份**请求视图（接线的判据是等价，不是「各自能跑」）",
  );
});

test("#550 C2：config.input.messages 赢过 session.initialMessages（rung 3：派生叶只填洞）", async () => {
  const provider = createFakeProvider(DONE);
  await runToolLoop(directOptions({
    provider,
    modelConfig: { resolve: async () => ({}) },
    session: { id: "s-550-precedence", initialMessages: seed },
    config: {
      run: { completion: false },
      input: { messages: [{ role: "user", content: [{ type: "text", text: "from-config" }] }] },
    },
  }));
  const body = sent(provider);
  assert.ok(body.includes("from-config"), "显式 config.input.messages 必须在场");
  assert.equal(body.includes(SEED_TEXT), false, "派生叶不许覆盖宿主自己写的种子");
});

test("#550 C3：session.initialMessages 不是数组 ⇒ 两条路线同一句（不许被 [...seed] 摊成字符）", async () => {
  const direct = await thrown(runToolLoop(directOptions({
    modelConfig: { resolve: async () => ({}) },
    session: { id: "s", initialMessages: "nope" },
  })));
  assert.equal(direct.message, "session.initialMessages must be an array");
  const assembly = await thrown(Promise.resolve()
    .then(() => createAssemblyPort(portInput({ session: { id: "s", initialMessages: "nope" } }))));
  assert.equal(assembly.message, direct.message);
});

// ---------------------------------------------------------------------------------------------------
// D. session.id 在两条路线都进 config.run.runId（同一个派生函数）
// ---------------------------------------------------------------------------------------------------

test("#550 D：session.id 在直连路线也真的成为 runId（transcript 键不再是 undefined）", async () => {
  const keys = [];
  const store = createMemoryTranscriptStore();
  const appendRound = store.appendRound.bind(store);
  store.appendRound = async (runId, record) => {
    keys.push(runId);
    return appendRound(runId, record);
  };
  const result = await runToolLoop(directOptions({
    provider: createFakeProvider(DONE),
    store,
    modelConfig: { resolve: async () => ({}) },
    session: { id: "s-550-runid" },
  }));
  assert.equal(result.termination.reason, "end_turn");
  assert.ok(keys.length > 0, "必须有落盘行，否则本格测不到键");
  assert.deepEqual([...new Set(keys)], ["s-550-runid"], "session.id 必须成为 transcript 的 runId");
});

// ---------------------------------------------------------------------------------------------------
// E. 容器不泄进工具上下文；派生集合的读取点表跟着动
// ---------------------------------------------------------------------------------------------------

test("#550 E：容器不进 context.session——工具上下文的 session 只来自折叠上下文", async () => {
  const seen = [];
  await runToolLoop(directOptions({
    provider: createFakeProvider(TOOL_ROUND),
    modelConfig: { resolve: async () => ({}) },
    session: { id: "s-550-container", initialMessages: seed },
    executeTool: async (options) => {
      seen.push(options.context);
      return "ok";
    },
  }));
  assert.ok(seen.length > 0);
  for (const context of seen) {
    assert.equal(context.session, undefined,
      "容器（id / initialMessages）不许作为不透明载荷泄进工具上下文");
  }
});

test("#550 E2：SESSION_MEMBER_READ_POINTS 的读取点已指向共享派生函数（清单不许留旧读点）", () => {
  const byName = new Map(SESSION_MEMBER_READ_POINTS.map((entry) => [entry.name, entry.readBy]));
  assert.deepEqual([...byName.keys()].sort(), [...SESSION_MEMBER_NAMES].sort());
  for (const name of ["id", "initialMessages"]) {
    assert.match(byName.get(name), /sessionDerivedConfigLeaves/u,
      `${name} 的读取点必须指向两条路线共用的派生函数（#550 把装配口独占的那份外提了）`);
    assert.match(byName.get(name), /both entry routes/u);
  }
});
