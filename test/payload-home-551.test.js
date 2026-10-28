// issue #551 —— 不透明 per-run 载荷**只有一个家**：`config.folding.context.session`（裁决甲）。
//
// 债务（本文件逐条钉住，不引用工单措辞）：S3 的口径是「不透明载荷进 `config.metadata.*`」
// （`expert` / `requestId` / `toolContext` / `user` / `task` 五件都这么搬，读侧同名进
// `toolContextFor`），而 #550 让 `session` 成为 `config.folding.context` 的**保留键** ⇒
// 「我的每次运行私有数据放哪」有两个答案。
//
// **裁决：甲。** `config.folding.context` 是**自由壳**，`session` 是它的**保留键**（载荷）；
// `config.metadata.*` 装的是引擎**按字段名**读的宿主数据，**不是**载荷的家。
// 为什么不是乙（把 `config.metadata.session` 作为载荷叶搬回来）：0.28 刚把宿主的写法从顶层搬走，
// 名字不许再改第二次；而且 #531 那条「同值 ⇒ 叶冗余」的论据说的是**容器**
// （`assemblyPortOptions(port).session === port.session`），#550 之后容器与载荷已不是一回事，
// 它不能拿来拒绝载荷叶——本条与 0.29 的候选（载荷明确住 metadata）都写在报告里，不在本文件断言。
//
// 本文件钉三件事：
//   A. 反向证①（甲的成立条件）：往 `config.metadata.session` 写载荷必须给出**明确指路判词**——
//      点名 `config.folding.context.session` 与顶层容器，**不许**是 unknown-leaf 的通用话术；
//      而真正的错别字（`sesion`）仍然只配那句通用话术（判词按**具体叶子**分派，不是一律加长）。
//   B. 载荷的家真的到 `executeTool`：`config.folding.context.session` 的值就是 `context.session`
//      （必须发一次 `tool_use`，否则 `executeTool` 压根没被调用）。
//   C. 类型面 ≡ 白名单（#522）：`folding.context` 在 `runToolLoop` 的 JSDoc 里**声明**了 `session`，
//      `metadata` **不再声明**它（声明面不许比运行时更宽松）。
//   D. #545 纪律：`fineGrainedPortShape` 里那条 `typeof session === "object"` 已**删除**（它恒真），
//      证据是「没有任何形状能带着非对象 `session` 走到那个闸口」，而「在场性」判据仍然可分。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createAssemblyPort } from "../src/assembly.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const PAYLOAD = "payload-551-opaque";
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];
const TOOL_ROUND = [
  { content: [{ type: "tool_use", id: "tu_551", name: "echo", input: {} }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
];

/** 直连路线的最小合法入参（`executeTool` 必须在场，否则测到的是 missing-methods）。 */
function directOptions(extra = {}) {
  return {
    provider: createFakeProvider(TOOL_ROUND),
    executeTool: async () => "ok",
    config: { run: { completion: false }, input: { initialUserMessage: "go" } },
    ...extra,
  };
}

const thrown = async (promise) => promise.then(() => null, (error) => error);

/** 甲裁决的那句指路判词（逐字，两处：直连与装配口的 `policy.config`）。 */
const RELOCATED_MESSAGE = "config.metadata.session: the opaque per-run payload's home is"
  + " config.folding.context.session (the fold-context shell's reserved key — the engine hands it to"
  + " executeTool as context.session); the top-level `session` option is the run identity container"
  + " (session.id / session.modelSlot / session.initialMessages), not a payload home";

// ---------------------------------------------------------------------------------------------------
// A. 反向证①：`config.metadata.session` 是**有指路**的闭门，不是 unknown-leaf 的通用话术
// ---------------------------------------------------------------------------------------------------

test("#551 A：往 config.metadata.session 写载荷 ⇒ 判词点名载荷的家（两条路线逐字同一句）", async () => {
  const direct = await thrown(runToolLoop(directOptions({
    config: { run: { completion: false }, metadata: { session: PAYLOAD } },
  })));
  assert.ok(direct instanceof TypeError, `config.metadata.session 必须当场拒，实际 ${direct && direct.message}`);
  assert.equal(direct.message, RELOCATED_MESSAGE);
  assert.equal(direct.via, "direct");

  // 装配口走的是同一道闸口（`policy.config` 与调用级 `config` 是同一棵树）。
  const assembly = await thrown(Promise.resolve().then(() => createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createFakeProvider(DONE),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: "s-551-assembly" },
    policy: { config: { metadata: { session: PAYLOAD } } },
  })));
  assert.ok(assembly instanceof TypeError, `装配口的 policy.config.metadata.session 也必须拒，实际 ${assembly && assembly.message}`);
  assert.equal(assembly.message, RELOCATED_MESSAGE);
  assert.equal(assembly.via, "assembly");
});

test("#551 A2：判词按**具体叶子**分派——错别字 sesion 仍然只配通用话术（没有变成一律加长）", async () => {
  const typo = await thrown(runToolLoop(directOptions({
    config: { run: { completion: false }, metadata: { sesion: PAYLOAD } },
  })));
  assert.equal(
    typo.message,
    'unknown config.metadata option: "sesion" (accepted: expert, user, task, requestId, toolContext, model, modelMetadata)',
    "真·未知名字必须还是那句通用话术（否则这张指路表就是在替所有错字背书）",
  );
  assert.equal(typo.message.includes("config.folding.context.session"), false);
});

test("#551 A3：甲不改变接受面——metadata 仍是那七个叶子，载荷只在折叠壳里", async () => {
  // ① 载荷写进折叠壳 ⇒ 收（这是它的家）。
  const ok = await runToolLoop(directOptions({
    provider: createFakeProvider(DONE),
    config: { run: { completion: false }, folding: { context: { session: PAYLOAD } } },
  }));
  assert.equal(ok.termination.reason, "end_turn", "载荷的家必须真的能写");
  // ② 同一个键写进 metadata ⇒ 拒（门是关的：这张表只换判词，不放宽接受面）。
  const closed = await thrown(runToolLoop(directOptions({
    config: { run: { completion: false }, metadata: { session: PAYLOAD } },
  })));
  assert.ok(closed instanceof TypeError);
});

// ---------------------------------------------------------------------------------------------------
// B. 载荷的家真的到达 executeTool（必须发一次 tool_use：否则 executeTool 压根没被调用）
// ---------------------------------------------------------------------------------------------------

test("#551 B：config.folding.context.session 的值就是 executeTool 的 context.session", async () => {
  const seen = [];
  const result = await runToolLoop(directOptions({
    provider: createFakeProvider(TOOL_ROUND),
    config: { run: { completion: false }, folding: { context: { session: PAYLOAD } } },
    executeTool: async (options) => {
      seen.push(options.context);
      return "ok";
    },
  }));
  assert.equal(result.termination.reason, "end_turn");
  assert.ok(seen.length > 0, "必须真的发生过一次工具调用（否则这格测的是空集）");
  for (const context of seen) assert.equal(context.session, PAYLOAD, "载荷的家把同一个值送到 context.session");
});

test("#551 B2：容器与载荷同时在场 ⇒ context.session 只有载荷（容器不遮蔽、也不泄进工具上下文）", async () => {
  const seen = [];
  await runToolLoop(directOptions({
    provider: createFakeProvider(TOOL_ROUND),
    modelConfig: { resolve: async () => ({}) },
    session: { id: "s-551-container" },
    config: { run: { completion: false }, folding: { context: { session: PAYLOAD } } },
    executeTool: async (options) => {
      seen.push(options.context);
      return "ok";
    },
  }));
  assert.ok(seen.length > 0);
  for (const context of seen) {
    assert.equal(context.session, PAYLOAD, "载荷是 context.session 的唯一来源（#550 撤掉顶层优先读法）");
  }
});

// ---------------------------------------------------------------------------------------------------
// C. 类型面 ≡ 白名单（#522）：声明面必须看得见载荷的家，且不许再声明退役的家
// ---------------------------------------------------------------------------------------------------

const ORCHESTRATOR_SOURCE = readFileSync(new URL("../src/loop/orchestrator.js", import.meta.url), "utf8");

/** 抽出 `@param {{ … }} options` 的类型字面（去掉每行 JSDoc 的 `* ` 前缀）。 */
function optionsTypeLiteral(source) {
  const end = /^\s*\*\s*\}\}\s+options\s*$/mu.exec(source);
  assert.notEqual(end, null, "orchestrator.js 里必须还有 `}} options` 收尾——抽不到就等于判据在空转");
  const paramAt = source.lastIndexOf("@param {{", end.index);
  assert.notEqual(paramAt, -1, "`}} options` 之前必须还有内联类型字面");
  return source.slice(paramAt, end.index)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/u, ""))
    .join("\n");
}

/**
 * `marker` 之后**第一个**对象字面量（按花括号配平切出，含两端）。
 *
 * @param {string} text
 * @param {string} marker
 * @returns {string}
 */
function objectLiteralAfter(text, marker) {
  const at = text.indexOf(marker);
  assert.notEqual(at, -1, `类型字面里找不到 ${marker}`);
  const open = text.indexOf("{", at);
  assert.notEqual(open, -1, `${marker} 之后必须有对象字面量`);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error(`${marker} 的对象字面量没有配平`);
}

/** 某个容器里是否**声明**了 `session`（声明面 = 宿主在 `.d.ts` 里看得见的那一面）。 */
function declaresSession(containerLiteral) {
  return /\bsession\s*\??\s*:/u.test(containerLiteral);
}

test("#551 C：JSDoc 声明面 ≡ 白名单——folding.context 声明 session，metadata 不再声明它", () => {
  const literal = optionsTypeLiteral(ORCHESTRATOR_SOURCE);
  const foldingContext = objectLiteralAfter(objectLiteralAfter(literal, "folding?: {"), "context?: {");
  assert.equal(declaresSession(foldingContext), true,
    "载荷的家必须在类型面里被声明（否则宿主写 config.folding.context.session 会吃到 TS2353）");
  const metadata = objectLiteralAfter(literal, "metadata?: {");
  assert.equal(declaresSession(metadata), false,
    "`config.metadata.session` 运行时必拒 ⇒ 声明面也不许再声明它（#522：类型面不许比运行时宽松）");
});

test("#551 C2：抽取器自测——把 session 挪回 metadata，两条断言必须同时翻面（防恒绿）", () => {
  const synthetic = [
    "@param {{",
    " *   config?: {folding?: {context?: {budgetTokens?: number, session?: any},",
    " *     toolResultTtl?: number},",
    " *     metadata?: {expert?: any, session?: any}},",
    " * }} options",
  ].join("\n");
  const literal = optionsTypeLiteral(synthetic);
  const foldingContext = objectLiteralAfter(objectLiteralAfter(literal, "folding?: {"), "context?: {");
  const metadata = objectLiteralAfter(literal, "metadata?: {");
  assert.equal(declaresSession(foldingContext), true);
  assert.equal(declaresSession(metadata), true, "合成字面里 metadata 声明了 session ⇒ 抽取器必须看得见");
  const flipped = synthetic.replace(", session?: any}}", "}}");
  assert.equal(declaresSession(objectLiteralAfter(optionsTypeLiteral(flipped), "metadata?: {")), false,
    "删掉声明后抽取器必须跟着变（否则它读的不是这份文本）");
});

// ---------------------------------------------------------------------------------------------------
// D. #545 纪律：`fineGrainedPortShape` 里那条恒真的 `typeof session === "object"` 已删除
// ---------------------------------------------------------------------------------------------------

test("#551 D：没有任何形状能带着非对象 session 走到细粒度端口闸口（恒真判据被删的证据）", async () => {
  // 语义相（`collectSessionContainerProblems`）在 `normalizeRunToolLoopOptions` 里先跑，于是
  // `fineGrainedPortShape` 那一行看到的 `session` 只可能是 undefined 或对象——「它是对象」这条
  // 判据永远不会为假。删除后若还有形状能走到那里，报错会变成
  // 「assembly port is missing methods: session.id」（另一种话术）——下面逐形状证明它不会出现。
  const shapes = [
    ["a string", PAYLOAD],
    ["a number", 551],
    ["a boolean", true],
    ["null", null],
    ["an array", [1, 2]],
    ["a function", () => 1],
  ];
  for (const [described, value] of shapes) {
    const error = await thrown(runToolLoop(directOptions({ session: value })));
    assert.ok(error instanceof TypeError, `${described}：必须抛`);
    assert.match(error.message, /^session must be an object \(got /u, `${described}：必须是容器判词`);
    assert.equal(error.message.includes("assembly port is missing methods"), false,
      `${described}：不许走到细粒度端口闸口（那说明 typeof session === "object" 还有活可干）`);
  }
});

test("#551 D2：删掉类型判据之后，「在场性」仍然可分——容器缺 id 照样点名，缺容器则不点名", async () => {
  const missingId = await thrown(runToolLoop(directOptions({
    session: {},
    modelConfig: { resolve: async () => ({}) },
  })));
  assert.equal(missingId.message, "assembly port is missing methods: session.id",
    "session 在场 ⇒ 细粒度端口契约生效（这条证明判据只剩「在场性」而不是恒真）");
  const noSession = await thrown(runToolLoop(directOptions({ provider: createFakeProvider(DONE) })));
  assert.equal(noSession, null, "没有 session ⇒ 不进细粒度端口契约（同一个 run 正常结束）");
});
