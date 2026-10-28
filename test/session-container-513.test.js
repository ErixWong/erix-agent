// issue #513 —— 顶层 `session` 容器的未知子键在**两条路线**上都静默通过，补齐容器对称性。
//
// 病根（实测，基点 b7cbe8e）：`provider` / `tools` / `store` / `modelConfig` 的成员是**必需方法**，
// 拼错立刻撞 missing-methods；`session` 是**唯一「成员全可选项」的容器**（`initialMessages` 可省），
// 于是拼错不撞任何闸口、只静默丢：
//   runToolLoop({ …, session: { id: "x", bogusSubkey: 1 } })      → end_turn（无人报错）
//   runToolLoop({ …, session: { id: "x", intialMessages: [] } })  → end_turn（少一个 i ⇒ 历史没播）
//   createAssemblyPort({ …, session: { id: "x", bogusSubkey: 1 } }) → 通过
// 同一棵树上 `config` / `capabilities` 的未知子键**都拒**（`unknown capabilities.checks option: "x"
// (accepted: deliverables)`），只有 `session` 有洞。本文件钉住修好之后的形状：
//
//   A. **可接受集合是派生的，不是手抄的**：`SESSION_MEMBER_NAMES`（`src/assembly-validators.js`）是
//      唯一一处声明，A 段把**真相从源码里重新量一遍**——扫 `src/**` 的 `session.<name>` /
//      `session?.<name>` 成员读取（注释与字符串字面量先剥掉），与声明**双向**比对：
//        · 声明里有、源码里没人读 ⇒ 红（"清单里塞了个引擎从不读的名字"）；
//        · 源码里有、声明里没跟上 ⇒ 红（"新增读取点而清单没跟上"）。
//      两个方向都红，这条「accepted 清单」才不会在下一个读取点出现时变成一句谎话。
//      `resume` 是**只读来拒**的退役成员（#498 S4b），单列一表：它必须仍有读取点，否则那条退役规则
//      就是死代码。
//   B. 直连路线（`runToolLoop` 扁平选项）：未知子键 / 拼错子键当场抛，判词点名完整路径
//      `session.<名字>` 并列出可接受集合；数组给**类型判词**（不是 "missing methods"）。
//   C. 装配路线（`createAssemblyPort` 自己就抛，不是等到 runToolLoop）：与直连**同一句**，只差
//      `error.via`；非对象（字符串 / 数组 / 函数 / null）给类型判词。
//   D. **一条闸门两路共用**：两条路线的判词逐字相等，且都等于共用校验函数
//      `collectSessionContainerProblems` 的输出（#538 的教训：只校直连、装配路漏校是这类修复最常见的洞）。
//   E. 判词的「accepted」子句与派生集合同源：逐字钉住整句（删空 / 改错可接受列表 ⇒ 红）。
//
// **不**做的事（本单红线）：`initialMessages` 不改成必需；`provider` / `tools` 不加未知方法检查
// （它们由 missing-methods 覆盖，加两条判词会互相竞争）；直连路线上 `session` 作为**不透明载荷**的
// 拼写（`context.session`，`src/loop/budget.js` 的 `session?: any`）本单一字未动 —— 见 F 段。
//
// **#550 改写了 F 段与 B3/C2 的期望**：那条二义（一个键两种含义）由 #550 裁决为**甲**——顶层
// `session` 只是容器，不透明载荷的家是 `config.folding.context.session`（`toolContextFor` 的
// fallback 链今天就在读它）。所以 F 段从「字符串照旧生效」变成「字符串两条路线同一句拒、并点名
// 新家」；B3 的「initialMessages 在直连路线惰性」边界也被接线抹掉（两条路线都播种子）。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAssemblyPort } from "../src/assembly.js";
import {
  SESSION_MEMBER_NAMES,
  SESSION_MEMBER_READ_POINTS,
  SESSION_RETIRED_MEMBERS,
  collectSessionContainerProblems,
  sessionMemberPaths,
} from "../src/assembly-validators.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 直连路线的最小合法入参（第三站 `executeTool` 必须给：否则测到的是不相干的 missing-methods）。 */
function directOptions(extra = {}) {
  return {
    provider: createFakeProvider(DONE),
    executeTool: async () => "ok",
    config: { run: { completion: false }, input: { initialUserMessage: "go" } },
    ...extra,
  };
}

/** 装配路线的最小合法端口入参。 */
function portInput(extra = {}) {
  return {
    modelConfig: { resolve: async () => ({}) },
    provider: createFakeProvider(DONE),
    tools: { definitions: [], executeTool: async () => "ok" },
    ...extra,
  };
}

const thrown = async (promise) => promise.then(() => null, (error) => error);

// ---------------------------------------------------------------------------------------------------
// A. 可接受集合的派生与守卫
// ---------------------------------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

/** 注释行：整行 `//` / `*` / `/*` 开头（本仓 `src/**` 的注释都这样起行，行尾注释不涉及 session 读取）。 */
function isCommentLine(line) {
  const head = line.trimStart();
  return head.startsWith("//") || head.startsWith("*") || head.startsWith("/*");
}

/**
 * 剥掉字符串字面量（含模板字面量）的**内容**，保留引号位置。
 *
 * 必须有这一步：声明表自己的 `readBy` 是字符串（`"… session.id …"`），判词模板里也有
 * `` `session.${name}` ``。不剥的话，「往表里塞一个假名字」会顺带把那个名字写进 `readBy`，
 * 扫描器就把文档当成读取点、两边自洽 ⇒ 反向证失效（本单反向证② 证的就是这件事）。
 */
function stripStringLiterals(line) {
  let out = "";
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * 从源码**重新量**一遍 `session` 的成员读取点：`name → ["src/x.js:12", …]`。
 *
 * 口径：`session.<name>` / `session?.<name>` 的**成员访问**（`port.session.id` 也算，`\b` 在 `.` 之后成立）；
 * 注释行与字符串字面量先剥掉。`session["id"]` 这种下标写法今天一处都没有，不在口径内。
 */
function deriveSessionMemberReads() {
  const reads = new Map();
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      for (const match of stripStringLiterals(line).matchAll(/\bsession\??\.([A-Za-z_][\w]*)/gu)) {
        const name = match[1];
        if (!reads.has(name)) reads.set(name, []);
        reads.get(name).push(`${rel}:${index + 1}`);
      }
    });
  }
  return reads;
}

test("#513 A：可接受集合由源码里的真实读取点派生（双向）", () => {
  const reads = deriveSessionMemberReads();
  const derived = [...reads.keys()].filter((name) => !SESSION_RETIRED_MEMBERS.includes(name)).sort();
  const declared = [...SESSION_MEMBER_NAMES].sort();

  // ① 声明里不许有引擎从不读的名字（反向证②：往派生集合里塞一个没人读的名字 ⇒ 这条红）。
  const invented = declared.filter((name) => !derived.includes(name));
  assert.deepEqual(
    invented,
    [],
    `这些名字在 session 的可接受集合里，但 src/** 里没有任何读取点：${invented.join(", ")}`,
  );
  // ② 引擎新读了一个成员、清单没跟上 ⇒ 这条红（这是「判词明年还是一句谎话」的机器闸门）。
  const missing = derived.filter((name) => !declared.includes(name));
  assert.deepEqual(
    missing,
    [],
    `引擎读了这些 session 成员但可接受集合没跟上：${missing.map((name) => `${name} (${reads.get(name).join(", ")})`).join("; ")}`,
  );
  // ③ 双向都对上之后，集合本身钉死（今天的真值是三个：id / modelSlot / initialMessages）。
  assert.deepEqual(declared, ["id", "initialMessages", "modelSlot"]);
});

test("#513 A2：每条声明都带读取点来源；退役成员必须仍有读取点（否则那条退役规则是死代码）", () => {
  assert.equal(SESSION_MEMBER_READ_POINTS.length, SESSION_MEMBER_NAMES.length);
  for (const entry of SESSION_MEMBER_READ_POINTS) {
    assert.ok(SESSION_MEMBER_NAMES.includes(entry.name), `声明表里有未登记进名字集合的条目：${entry.name}`);
    assert.equal(typeof entry.readBy, "string");
    assert.ok(entry.readBy.trim().length > 0, `${entry.name} 必须写明读取点来源`);
  }
  const reads = deriveSessionMemberReads();
  for (const name of SESSION_RETIRED_MEMBERS) {
    assert.ok(
      reads.has(name),
      `退役成员 session.${name} 在 src/** 里已经没有读取点 ⇒ 拒绝它的那条规则成了死代码`,
    );
    assert.ok(
      !SESSION_MEMBER_NAMES.includes(name),
      `退役成员 session.${name} 不许同时出现在可接受集合里`,
    );
  }
});

test("#513 A3：判词的 accepted 子句与派生集合同源（没有第二份手抄清单）", () => {
  assert.deepEqual(sessionMemberPaths(), ["session.id", "session.modelSlot", "session.initialMessages"]);
  const problems = collectSessionContainerProblems({ id: "x", bogusSubkey: 1 });
  assert.equal(problems.length, 1);
  for (const fullPath of sessionMemberPaths()) {
    assert.ok(problems[0].includes(fullPath), `判词必须逐条列出可接受集合成员 ${fullPath}：${problems[0]}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// B. 直连路线（runToolLoop 扁平选项）
// ---------------------------------------------------------------------------------------------------

test("#513 B：直连路线——未知子键 / 拼错子键当场拒，判词点名完整路径并列出可接受集合", async () => {
  for (const session of [{ id: "x", bogusSubkey: 1 }, { id: "x", intialMessages: [] }]) {
    const error = await thrown(runToolLoop(directOptions({ session })));
    assert.ok(error instanceof TypeError, `必须抛 TypeError，实际 ${error && error.message}`);
    const key = Object.keys(session).find((name) => name !== "id");
    // 逐字钉：整句与可接受列表都钉住（反向证③：把列表删空或改错 ⇒ 这条红）。
    assert.equal(
      error.message,
      `unknown session option: session.${key} (accepted: session.id, session.modelSlot, session.initialMessages)`,
    );
    assert.equal(error.via, "direct");
  }
});

test("#513 B2：直连路线——数组给类型判词，不是 missing-methods", async () => {
  const error = await thrown(runToolLoop(directOptions({ session: [1, 2] })));
  assert.ok(error instanceof TypeError);
  assert.equal(
    error.message,
    "session must be an object (got an array): the run identity lives in its members"
    + " (session.id, session.modelSlot, session.initialMessages); the opaque payload that reaches"
    + " executeTool as context.session lives in config.folding.context.session",
  );
  assert.equal(error.via, "direct");
});

test("#513 B3：直连路线——合法 session 照旧跑完，`modelSlot` 真的被解析（可接受集合不是死键）", async () => {
  const provider = createFakeProvider(DONE);
  let slot;
  const result = await runToolLoop({
    provider,
    executeTool: async () => "ok",
    // 对象形态的 `session` 是「细粒度端口形态」，`session.id` 必需 ⇒ 模型解析器也得在场。
    modelConfig: { resolve: async (requested) => { slot = requested; return {}; } },
    session: { id: "s-513-legal", modelSlot: "slotA" },
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(slot, "slotA", "session.modelSlot 必须真的传给 modelConfig.resolve");
  // #550 抹掉了原来那条「直连路线惰性」的边界：`session.initialMessages` 现在由**同一个**
  // `sessionDerivedConfigLeaves`（`src/assembly.js`）折进 `config.input.messages`，两条路线都播。
  // 这里只放一条最小前提（本格没给种子 ⇒ 请求里没有它），接线本身由 #550 的格与 C4 证。
  assert.ok(
    !JSON.stringify(provider.requests[0]?.messages ?? []).includes("seed-from-session"),
    "本格没给 session.initialMessages ⇒ 请求里不该有种子（接线格在 #550 的文件里）",
  );
});

// ---------------------------------------------------------------------------------------------------
// C. 装配路线（createAssemblyPort 自己抛，不等 runToolLoop）
// ---------------------------------------------------------------------------------------------------

test("#513 C：装配路线——未知子键 / 拼错子键在构造期就拒，与直连同一句", async () => {
  for (const session of [{ id: "x", bogusSubkey: 1 }, { id: "x", intialMessages: [] }]) {
    const error = await thrown(Promise.resolve().then(() => createAssemblyPort(portInput({ session }))));
    assert.ok(error instanceof TypeError, `必须抛 TypeError，实际 ${error && error.message}`);
    const key = Object.keys(session).find((name) => name !== "id");
    assert.equal(
      error.message,
      `unknown session option: session.${key} (accepted: session.id, session.modelSlot, session.initialMessages)`,
    );
    assert.equal(error.via, "assembly");
  }
});

test("#513 C2：装配路线——非对象 session 给类型判词（不是 missing methods）", () => {
  const cases = [
    ["a string", "x"],
    ["an array", []],
    ["a number", 1],
    ["null", null],
  ];
  for (const [described, session] of cases) {
    assert.throws(
      () => createAssemblyPort(portInput({ session })),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.equal(
          error.message,
          `session must be an object (got ${described}): the run identity lives in its members`
          + " (session.id, session.modelSlot, session.initialMessages); the opaque payload that"
          + " reaches executeTool as context.session lives in config.folding.context.session",
        );
        assert.equal(error.via, "assembly");
        assert.ok(
          !error.message.includes("missing methods"),
          `不许退化成 missing-methods：${error.message}`,
        );
        return true;
      },
    );
  }
  // 工厂形态（`session: () => …`）先被解析再判型：给的是函数、读的是它的返回值。
  assert.throws(
    () => createAssemblyPort(portInput({ session: () => "x" })),
    /session must be an object \(got a string\)/u,
  );
});

test("#513 C3：装配路线——合法端口照旧（id / modelSlot / initialMessages 三个都在时都照旧生效）", async () => {
  let slot;
  const port = createAssemblyPort(portInput({
    modelConfig: { resolve: async (requested) => { slot = requested; return {}; } },
    session: { id: "s-513-port", modelSlot: "slotP", initialMessages: [] },
  }));
  assert.equal(port.session.id, "s-513-port");
  assert.equal(port.session.modelSlot, "slotP");
  assert.deepEqual(port.session.initialMessages, []);
  assert.equal(slot, undefined, "构造期不解析模型槽位（解析发生在 run 里）");
});

test("#513 C4：装配路线——`session.initialMessages` 真的被播（可接受集合里那条读点是活的）", async () => {
  const provider = createFakeProvider(DONE);
  const seed = [{ role: "user", content: [{ type: "text", text: "seed-from-session" }] }];
  const port = createAssemblyPort(portInput({
    provider,
    session: { id: "s-513-seed", initialMessages: seed },
  }));
  const result = await runToolLoop({ assemblyPort: port, executeTool: async () => "ok" });
  assert.equal(result.termination.reason, "end_turn");
  const sent = JSON.stringify(provider.requests[0]?.messages ?? []);
  assert.ok(sent.includes("seed-from-session"), "session.initialMessages 必须真的进入请求");
});

// ---------------------------------------------------------------------------------------------------
// D. 一条闸门两路共用
// ---------------------------------------------------------------------------------------------------

test("#513 D：两条路线抛同一句（只差 via），且都等于共用校验函数的输出", async () => {
  const session = { id: "x", bogusSubkey: 1 };
  const direct = await thrown(runToolLoop(directOptions({ session })));
  const assembly = await thrown(Promise.resolve().then(() => createAssemblyPort(portInput({ session }))));
  const shared = collectSessionContainerProblems(session);
  assert.equal(shared.length, 1);
  assert.equal(direct.message, shared[0], "直连侧的判词必须来自共用校验函数");
  assert.equal(assembly.message, shared[0], "装配侧的判词必须来自共用校验函数");
  assert.equal(direct.message, assembly.message, "两条路线必须逐字同一句");
  assert.equal(direct.via, "direct");
  assert.equal(assembly.via, "assembly");
  // 装配路线的 runToolLoop 入口（`{ assemblyPort }`）同样过不去：构造期就抛，与直接调构造器同一句。
  const viaPort = await thrown(runToolLoop({
    assemblyPort: { ...portInput({ session }) },
    executeTool: async () => "ok",
  }));
  assert.equal(viaPort.message, shared[0]);
  assert.equal(viaPort.via, "assembly");
});

// ---------------------------------------------------------------------------------------------------
// F. 红线：直连路线上 `session` 作为不透明载荷的拼写不许被顺手收紧
// ---------------------------------------------------------------------------------------------------

test("#513 F（#550 改写）：直连路线 `session` 的字符串不再是容器——当场拒，并点名新家", async () => {
  // #550 的甲裁决：顶层 `session` **只是容器**，不透明载荷改名的家是 `config.folding.context.session`
  // （同一个字符串写在那里今天就生效，见下面第二半）。本格从「照旧生效」翻成「两条路线同一句拒」，
  // 是那次裁决的直接后果，不是放宽或收紧判据。
  const error = await thrown(runToolLoop(directOptions({ session: "s-513-opaque" })));
  assert.ok(error instanceof TypeError, `必须抛 TypeError，实际 ${error && error.message}`);
  assert.equal(
    error.message,
    "session must be an object (got a string): the run identity lives in its members"
    + " (session.id, session.modelSlot, session.initialMessages); the opaque payload that reaches"
    + " executeTool as context.session lives in config.folding.context.session",
  );
  assert.equal(error.via, "direct");

  // 迁移后的写法：同一个值、同一个工具上下文键，一行不差。
  let seen;
  const result = await runToolLoop(directOptions({
    config: { run: { completion: false }, folding: { context: { session: "s-513-opaque" } } },
    executeTool: async (options) => {
      seen = options.context;
      return "ok";
    },
    provider: createFakeProvider([
      { content: [{ type: "tool_use", id: "tu_1", name: "echo", input: {} }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]),
  }));
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(seen?.session, "s-513-opaque", "context.session 必须拿到那个字符串（新家）");
});
