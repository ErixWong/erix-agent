// issue #556 —— `createAssemblyPort` 的**顶层未知成员**是「接受 + 静默丢掉」，补齐端口顶层的名称闸。
//
// 病根（实测，基点 aba4c9e）：端口只按名字读六个成员 + `emit`，多出来的顶层成员既不抛也不报，
// 只是没进返回的端口对象：
//   createAssemblyPort({ …, bogusMember: 1 })                        → 不抛；端口键 = modelConfig,provider,
//                                                                      tools,store,session,policy（bogus 不见）
//   createAssemblyPort({ …, config: { input: { … } } })              → 不抛；**数据面整棵被丢**
//   createAssemblyPort({ …, capabilities: { hooks: {} } })           → 不抛；同上
// 为什么这条特别坑：`config` / `capabilities` 是**直连路线**（`runToolLoop({config, capabilities})`）
// 的顶层容器名，而装配口那一路的数据面住在 `policy` 里（`policy.config` / `policy.capabilities`，#545）。
// 宿主照直连的直觉写装配口，得到零反馈 + 零效果：折叠/计时策略一个字没吃进去，run 正常 `end_turn`。
//
// 本文件钉五件事：
//   A. **可接受集合是派生的，不是手抄的**：`ASSEMBLY_PORT_MEMBER_READ_POINTS`（`src/assembly.js`）
//      是唯一一处声明，A 段把真相从源码里**重新量一遍**——扫 `src/assembly.js` 里 `input.<name>` /
//      `input?.<name>` 的成员读取（注释与字符串字面量先剥掉），与声明**双向**比对：
//        · 声明里有、源码里没人读 ⇒ 红（"清单里塞了个引擎从不读的名字"）；
//        · 源码里有、声明里没跟上 ⇒ 红（"新增读取点而清单没跟上"）。
//   A2. 声明表同时是**构造表**：端口键集必须逐字等于表里的名字（多一个 / 少一个都红），所以
//      「表」不可能与真实构造漂移。
//   B. `config` / `capabilities` 放顶层 ⇒ 当场抛，且判词**点名正确住所**（`policy.config` /
//      `policy.capabilities`）——本单的全部价值就在这里，只报 "unknown option" 不算做到。
//   C. 任意未知成员 ⇒ 抛，判词列出可接受集合（与派生集合同源），拼写相近给建议。
//   D. 闸口在**读任何宿主端口之前**（工厂一次都不许被调）：与直连路线 `assertRunToolLoopOptionNames`
//      同一条次序承诺。
//   E. **零误伤**：合法端口（工厂 + `policy` + `emit`）照旧构造、照旧跑完 `end_turn`，键集与顺序不变；
//      `undefined` 仍是「没给」（spread 一个带 `undefined` 的选项对象不变成未知成员报告）。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSEMBLY_PORT_MEMBER_NAMES,
  ASSEMBLY_PORT_MEMBER_READ_POINTS,
  assemblyPortOptions,
  assertAssemblyPortMemberNames,
  createAssemblyPort,
} from "../src/assembly.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(HERE, "..", "src");
const ASSEMBLY_SOURCE = path.join(SRC_ROOT, "assembly.js");
const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 最小合法端口入参；成员都是**同步工厂**（端口契约允许），这样 `emit` / 工厂两条路径都被走到。 */
function portInput(extra = {}) {
  return {
    modelConfig: () => ({ resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) }),
    provider: () => createFakeProvider(DONE),
    tools: () => ({ definitions: [], executeTool: async () => "ok" }),
    session: { id: "port-556" },
    ...extra,
  };
}

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// 派生口径：剥掉注释行与字符串字面量，再扫 `input.<name>` 成员访问。
// ---------------------------------------------------------------------------------------------------

/** 注释行整行跳过（`//` / `*` / `/*` 开头）；行内注释不剥——本文件的口径只需要「锚点是代码」。 */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * 剥掉字符串字面量（含模板字面量）的**内容**，保留引号位置。
 *
 * 必须有这一步：声明表自己的 `readBy` 是字符串（`"createAssemblyPort() → port.modelConfig …"`），
 * 判词模板里也有 `` `unknown assembly port option: …` ``。不剥的话「往表里塞一个假名字」会顺带
 * 把那个名字写进 `readBy`，扫描器就把文档当成读取点、两边自洽 ⇒ 反向证失效。
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
 * 从 `src/assembly.js` **重新量**一遍端口顶层成员的读取点：`name → ["assembly.js:12", …]`。
 *
 * 口径：`input.<name>` / `input?.<name>` 的**成员访问**。前置字符不许是 `.` 或标识符字符，
 * 否则 `CONFIG_NAMESPACE_SCHEMA.input.messages` 这类**别的对象的** `.input` 会被误当成端口读取点。
 * 只扫 `src/assembly.js`：`input` 是 `createAssemblyPort` 的形参名，别处的 `input` 是无关形参。
 * `input["name"]` 这种下标写法今天一处都没有，不在口径内。
 */
function derivePortMemberReads() {
  const reads = new Map();
  const lines = fs.readFileSync(ASSEMBLY_SOURCE, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    const code = stripStringLiterals(line);
    for (const match of code.matchAll(/(?<![.\w$])input\??\.([A-Za-z_$][\w$]*)/gu)) {
      const name = match[1];
      if (!reads.has(name)) reads.set(name, []);
      reads.get(name).push(`src/assembly.js:${index + 1}`);
    }
  });
  return reads;
}

// ================================================================ A. 派生 + 双向守卫

test("#556 A：可接受集合由源码里的真实读取点派生（双向）", () => {
  const reads = derivePortMemberReads();
  const derived = [...reads.keys()].sort();
  const declared = [...ASSEMBLY_PORT_MEMBER_NAMES].sort();

  // ① 声明里不许有引擎从不读的名字（反向证①：往表里塞一个没人读的名字 ⇒ 这条红）。
  const invented = declared.filter((name) => !derived.includes(name));
  assert.deepEqual(
    invented,
    [],
    `这些名字在端口可接受集合里，但 src/assembly.js 里没有任何 input.<name> 读取点：${invented.join(", ")}`,
  );
  // ② 引擎新读了一个顶层成员、清单没跟上 ⇒ 这条红（反向证③：新增一个读取点 ⇒ 这条红）。
  const missing = derived.filter((name) => !declared.includes(name));
  assert.deepEqual(
    missing,
    [],
    `引擎读了这些端口顶层成员但可接受集合没跟上：${missing.map((name) => `${name} (${reads.get(name).join(", ")})`).join("; ")}`,
  );
  // ③ 双向都对上之后，集合本身钉死（今天的真值是七个：六个数据/能力成员 + emit）。
  assert.deepEqual(declared, ["emit", "modelConfig", "policy", "provider", "session", "store", "tools"]);
});

test("#556 A2：声明表就是构造表——端口键集逐字等于表里的名字（含顺序）", () => {
  assert.equal(ASSEMBLY_PORT_MEMBER_READ_POINTS.length, ASSEMBLY_PORT_MEMBER_NAMES.length);
  for (const entry of ASSEMBLY_PORT_MEMBER_READ_POINTS) {
    assert.equal(typeof entry.read, "function", `${entry.name} 必须带读取函数（表就是构造表）`);
    assert.equal(typeof entry.readBy, "string");
    assert.ok(entry.readBy.trim().length > 0, `${entry.name} 必须写明读取点来源`);
  }
  // 不带 `emit`：端口键集是表里非 optional 的那部分（历史形状：六个键，值可以是 undefined）。
  const withoutEmit = createAssemblyPort(portInput());
  assert.deepEqual(
    Object.keys(withoutEmit),
    ASSEMBLY_PORT_MEMBER_NAMES.filter((name) => name !== "emit"),
  );
  // 带 `emit`：可选成员排在最后，键集 = 整张表。
  const withEmit = createAssemblyPort(portInput({ emit: () => {} }));
  assert.deepEqual(Object.keys(withEmit), [...ASSEMBLY_PORT_MEMBER_NAMES]);
});

// ================================================================ B. 两个「直连直觉」写法

test("#556 B：顶层 config / capabilities ⇒ 拒，且判词点名正确住所 policy.<name>", () => {
  const cases = [
    { name: "config", value: { input: { initialUserMessage: "X" } }, home: "policy.config", plane: "data" },
    { name: "capabilities", value: { hooks: {} }, home: "policy.capabilities", plane: "behaviour" },
  ];
  for (const { name, value, home, plane } of cases) {
    const error = thrown(() => createAssemblyPort(portInput({ [name]: value })));
    assert.ok(error instanceof TypeError, `顶层 ${name} 必须抛 TypeError，实际 ${error && error.message}`);
    assert.ok(
      error.message.includes(`unknown assembly port option: ${JSON.stringify(name)}`),
      `判词必须点名被拒的名字：${error.message}`,
    );
    // 本单的全部价值：只报 "unknown option" 不算做到，必须指出去处。
    assert.ok(error.message.includes(home), `判词必须点名正确住所 ${home}：${error.message}`);
    assert.ok(
      error.message.includes(`{ policy: { ${name}: `),
      `判词必须给出可照抄的写法（policy.${name}）：${error.message}`,
    );
    assert.ok(error.message.includes(plane), `判词必须说清这是哪个面（${plane}）：${error.message}`);
    // 可接受集合逐条在场（与派生集合同源）。
    for (const member of ASSEMBLY_PORT_MEMBER_NAMES) {
      assert.ok(error.message.includes(member), `判词必须列出可接受成员 ${member}：${error.message}`);
    }
  }
});

test("#556 B2：整句逐字钉死（改判词 / 删住所 / 改集合 ⇒ 红）", () => {
  const accepted = ASSEMBLY_PORT_MEMBER_NAMES.join(", ");
  assert.equal(
    thrown(() => createAssemblyPort(portInput({ config: { run: { completion: false } } }))).message,
    `unknown assembly port option: "config" (accepted: ${accepted});`
      + " its canonical home is policy.config: the port keeps the data plane inside policy"
      + " (write { policy: { config: … } }), while the top-level config container is the direct"
      + " route's spelling",
  );
  assert.equal(
    thrown(() => createAssemblyPort(portInput({ capabilities: { hooks: {} } }))).message,
    `unknown assembly port option: "capabilities" (accepted: ${accepted});`
      + " its canonical home is policy.capabilities: the port keeps the behaviour plane inside policy"
      + " (write { policy: { capabilities: … } }), while the top-level capabilities container is the"
      + " direct route's spelling",
  );
});

// ================================================================ C. 任意未知成员 + 建议

test("#556 C：任意未知成员 ⇒ 拒，判词列可接受集合；拼写相近给建议", () => {
  const plain = thrown(() => createAssemblyPort(portInput({ bogusMember: 1 })));
  assert.ok(plain instanceof TypeError);
  assert.equal(
    plain.message,
    `unknown assembly port option: "bogusMember" (accepted: ${ASSEMBLY_PORT_MEMBER_NAMES.join(", ")})`,
  );
  // 拼写建议复用 `optionSuggestion` 那一套（同一份 levenshtein + 同一档阈值）。
  assert.equal(
    thrown(() => createAssemblyPort(portInput({ provder: {} }))).message,
    `unknown assembly port option: "provder" (did you mean "provider"?)`
      + ` (accepted: ${ASSEMBLY_PORT_MEMBER_NAMES.join(", ")})`,
  );
  assert.ok(
    thrown(() => createAssemblyPort(portInput({ sessoin: { id: "x" } }))).message
      .includes(`(did you mean "session"?)`),
  );
  // 闸口函数本身也是公开的（与 `assertRunToolLoopOptionNames` 对称），并且只校名字、不读值。
  assert.equal(thrown(() => assertAssemblyPortMemberNames({ modelConfig: 1 })), undefined);
  assert.ok(thrown(() => assertAssemblyPortMemberNames({ nope: 1 })) instanceof TypeError);
});

test("#556 C2：非对象入参给形状判词，不冒充成「未知成员」", () => {
  // `Object.entries("abc")` 会产出 `["0","a"]`——没有这条形状判词，闸口会点名一个叫 `"0"` 的成员。
  const cases = [
    [null, "null"],
    [[], "an array"],
    ["abc", "a string"],
    [7, "a number"],
  ];
  for (const [value, described] of cases) {
    const error = thrown(() => createAssemblyPort(value));
    assert.ok(error instanceof TypeError, `${JSON.stringify(value)} 必须抛 TypeError`);
    assert.equal(error.message, `assembly port must be an object (got ${described})`);
  }
});

// ================================================================ D. 次序：先闸口，后宿主

test("#556 D：闸口在读任何宿主端口之前——坏名字一次宿主回调都不许花", () => {
  let calls = 0;
  const input = portInput({
    modelConfig: () => {
      calls += 1;
      return { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) };
    },
    config: { run: { completion: false } },
  });
  const error = thrown(() => createAssemblyPort(input));
  assert.ok(error instanceof TypeError);
  assert.equal(calls, 0, "名字闸口必须在任何工厂被调用之前抛出");
});

// ================================================================ E. 零误伤

test("#556 E：合法端口零误伤——键集/顺序不变，`undefined` 仍是「没给」", () => {
  const port = createAssemblyPort(portInput({
    policy: { config: { folding: { context: { strategy: "truncate" } } }, capabilities: { hooks: {} } },
    emit: () => {},
  }));
  assert.deepEqual(Object.keys(port), ["modelConfig", "provider", "tools", "store", "session", "policy", "emit"]);
  assert.equal(port.store, undefined);
  assert.deepEqual(port.policy, { config: { folding: { context: { strategy: "truncate" } } }, capabilities: { hooks: {} } });
  assert.equal(typeof port.emit, "function");
  // spread 一个带 `undefined` 的选项对象不变成未知成员报告（仓库通行的 `value !== undefined` 口径）。
  assert.equal(
    thrown(() => createAssemblyPort({ ...portInput(), bogusMember: undefined, config: undefined })),
    undefined,
  );
});

test("#556 E2：合法端口照旧跑通 end_turn，装配选项照旧产出（零效果面未被碰）", async () => {
  const port = createAssemblyPort(portInput({ emit: () => {} }));
  const options = await assemblyPortOptions(port);
  assert.deepEqual(
    Object.keys(options).sort(),
    ["config", "executeTool", "modelConfig", "onEvent", "provider", "session", "tools"],
  );
  const result = await runToolLoop({ assemblyPort: port, config: { run: { completion: false } } });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.messages.at(-1).content[0].text, "ok");
});
