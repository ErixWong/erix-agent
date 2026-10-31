// issue #522：把退役的扁平键从 `runToolLoop` 的**类型面**移除，并把「类型面 ≡ 接受面」钉成判据。
//
// 背景（#522 回帖的实测）：输入面不是 `@typedef`，而是 `src/loop/orchestrator.js` 里 `runToolLoop`
// 上方那一大块**内联 `@param {{ … }}` JSDoc**。`#498 S3` 把 40 个扁平键逐个退役（家搬到
// `config.*` / `capabilities.*`）之后，**白名单**只剩 26 个名字，而 JSDoc 顶层还留着退役拼写——
// `npm run types:build` 生成的 `.d.ts` 里逐字有 `wrapup?: boolean,` / `maxRounds?: number,` /
// `completion?: {…}|false,`，于是宿主 `tsc --strict` **放过**一个运行时**必抛**的写法。
//
// 本文件的判据（派生，不手抄名单）：
//   T1 顶层属性集 **集合相等** `RUN_TOOL_LOOP_OPTION_NAMES`（缺 / 多 / 重复都红，且点名）。
//   T2 嵌套叶子不许被抽成顶层（三个嵌套点人工核对过的抽样证据）。
//   T3 抽取器自测：合成文档块上「该抽的抽到、不该抽的不抽」，防它退化成恒绿。
//   T4 #213 R4 的两种「静默退化成 any」形态各一条锁：类型字面里没有独立 `//` 行、
//      文档块紧贴声明正上方（这两条只有读 `.d.ts` 才发现，源码注释看不出来）。
//
// 为什么深度抽而不用正则逐行：`config` / `capabilities` 是两层容器，里面的叶子名与退役的扁平名
// **同名**（`maxRounds` / `retry` / `context` / `task` / `reflection` …）。正则会把它们一起抽成
// 「顶层」，判据就永远绿——那正是这张单要杀的东西。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RUN_TOOL_LOOP_OPTION_NAMES } from "../src/loop/option-normalization.js";

const ORCHESTRATOR_URL = new URL("../src/loop/orchestrator.js", import.meta.url);
const ORCHESTRATOR_SOURCE = readFileSync(ORCHESTRATOR_URL, "utf8");

/** 顶层选项的**结束**标记：`}} options` 收掉 `@param {{ … }} options` 这个类型字面。 */
const OPTIONS_END = /^\s*\*\s*\}\}\s+options\s*$/mu;

/**
 * 抽出 `@param {{ … }} options` 的类型字面文本（已去掉每行的 JSDoc `* ` 前缀）。
 *
 * 定位方式：先找**唯一**的 `}} options` 收尾，再往前找它的 `@param {{`。不能反过来「从文件头找
 * 第一个 `@param {{`」——本文件里还有别的函数的 `@param {{`，那样抽到的会是别人的块。
 *
 * @param {string} source
 * @returns {{literal: string, blockStart: number, blockEnd: number}}
 */
function optionsTypeLiteral(source) {
  const endMatch = OPTIONS_END.exec(source);
  assert.notEqual(endMatch, null, "orchestrator.js 里必须还有 `}} options` 收尾——抽不到就等于判据在空转");
  const blockEnd = endMatch.index + endMatch[0].length;
  const paramAt = source.lastIndexOf("@param {{", blockEnd);
  assert.notEqual(paramAt, -1, "`}} options` 之前必须还有 `@param {{` 这个内联类型字面");
  const blockStart = source.lastIndexOf("/**", paramAt);
  assert.notEqual(blockStart, -1, "`@param {{` 必须在某个 `/**` 文档块里");
  const body = source.slice(paramAt, blockEnd)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/u, ""))
    .join("\n");
  const open = body.indexOf("{{");
  assert.notEqual(open, -1, "`@param {{` 之后必须还有 `{{` 开始的对象字面量");
  return { literal: body.slice(open), blockStart, blockEnd };
}

/**
 * 从 `{{ … }}` 类型字面里抽**顶层**属性名（花括号深度 2，且不在 `()` / `[]` / 字符串里）。
 *
 * 深度口径：`{{` 的第一个 `{` 是 JSDoc 的类型包裹、第二个 `{` 才是对象字面量，所以**顶层成员
 * 恰好活在深度 2**；深度 3+ 是嵌套值（`config.run.*` / `capabilities.hooks.*` / 函数参数里的
 * 对象字面量），一律不抽。顶层成员之间的分隔是「深度 2 且括号深度 0」上的 `,` 或换行——
 * 函数类型参数里的逗号（`(name: string, result: string)`）在括号里，不能当分隔符。
 * 行尾 `//` 注释先被跳过：它可能含 `{` `}` `(` `)` 甚至撇号（`parser's`），会让深度失步。
 *
 * @param {string} literal
 * @returns {string[]}
 */
function topLevelOptionNames(literal) {
  const names = [];
  let token = "";
  let depth = 0;
  let paren = 0;
  /** @type {string|null} */
  let quote = null;
  const flush = () => {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/u.exec(token);
    if (match !== null) names.push(match[1]);
    token = "";
  };
  for (let i = 0; i < literal.length; i += 1) {
    const ch = literal[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && literal[i + 1] === "/") {
      while (i < literal.length && literal[i] !== "\n") i += 1;
      i -= 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") { depth += 1; if (depth === 2) token = ""; continue; }
    if (ch === "}") { depth -= 1; continue; }
    if (ch === "(" || ch === "[") { paren += 1; continue; }
    if (ch === ")" || ch === "]") { paren -= 1; continue; }
    if (depth !== 2 || paren !== 0) continue;
    token += ch;
    if (ch === "," || ch === "\n") flush();
  }
  return names;
}

const { literal: OPTIONS_LITERAL, blockEnd: OPTIONS_BLOCK_END } = optionsTypeLiteral(ORCHESTRATOR_SOURCE);
const JSDOC_TOP_LEVEL = topLevelOptionNames(OPTIONS_LITERAL);

test("T1 JSDoc 顶层属性集**集合相等** RUN_TOOL_LOOP_OPTION_NAMES（双向，点名差集）", () => {
  // 判据自己的反空转：抽到 0 个名字时下面每一条都会「相等」，那是恒绿。
  assert.ok(JSDOC_TOP_LEVEL.length > 0, "没从 JSDoc 里抽到任何顶层属性名——抽取器坏了，判据等于空转");

  const duplicated = JSDOC_TOP_LEVEL.filter((name, index) => JSDOC_TOP_LEVEL.indexOf(name) !== index);
  assert.deepEqual(duplicated, [], `JSDoc 顶层重复声明了属性：${duplicated.join(", ")}`);

  const extracted = new Set(JSDOC_TOP_LEVEL);
  const allowlist = new Set(RUN_TOOL_LOOP_OPTION_NAMES);

  const retired = [...extracted].filter((name) => !allowlist.has(name)).sort();
  assert.deepEqual(
    retired,
    [],
    `JSDoc 顶层还在声明**退役**的扁平键：${retired.join(", ")}`
      + "（运行时已经在名字闸门拒它们，家搬到了 config.* / capabilities.*；"
      + "留在类型面上等于让宿主 tsc --strict 放过一个必抛的写法——issue #522）",
  );

  const undeclared = [...allowlist].filter((name) => !extracted.has(name)).sort();
  assert.deepEqual(
    undeclared,
    [],
    `JSDoc 顶层**缺**白名单里的名字：${undeclared.join(", ")}`
      + "（运行时接受而类型面没声明 = 反向缺口，宿主只能写 `as any`；缺声明就补声明）",
  );

  assert.deepEqual(
    [...extracted].sort(),
    [...allowlist].sort(),
    "顶层属性集必须与 RUN_TOOL_LOOP_OPTION_NAMES 逐字相等（集合相等是双向的）",
  );
});

test("T2 嵌套叶子不许被抽成顶层（三个嵌套点人工核对过的抽样证据）", () => {
  // 这三个点是**手工核对**过的：它们在 JSDoc 里确实存在，且都在容器**里面**。
  // 抽取器如果把嵌套拍平，它们会立刻出现在 JSDOC_TOP_LEVEL 里，T1 就会红在「退役扁平键」上。
  const nestedPoints = [
    ["config.run.maxRounds", "config"],
    ["config.folding.context", "config"],
    ["capabilities.ports.sleepImpl", "capabilities"],
  ];
  for (const [path, container] of nestedPoints) {
    const leaf = path.slice(path.lastIndexOf(".") + 1);
    // ① 嵌套点真的在类型字面里（否则这条抽样证据是空的）。
    assert.ok(OPTIONS_LITERAL.includes(`${leaf}?:`), `${path} 的叶子不在类型字面里`);
    // ② 容器本身是顶层（说明抽取器确实走到了那一层）。
    assert.ok(JSDOC_TOP_LEVEL.includes(container), `${container} 必须是顶层属性`);
    // ③ 叶子**不是**顶层（这才是深度抽取的意义）。
    assert.equal(JSDOC_TOP_LEVEL.includes(leaf), false, `${path} 的叶子被抽成了顶层——深度口径坏了`);
  }
});

test("T3 抽取器自测：合成类型字面上该抽的抽到、不该抽的不抽（防恒绿）", () => {
  // 形态取自真实类型面里出现过的坑：函数类型参数里的逗号、嵌套对象、行尾 `//` 注释里的撇号、
  // 字符串字面量里的花括号。
  const synthetic = [
    "{{",
    "  provider: {chat?: (request: object) => Promise<object>, chatStream?: (request: object) => Promise<object>},",
    "  executeTool: (options:{id:string, name:string, input:object}) => Promise<string>,",
    "  finalGuard?: (payload:{finalText:string}) => Promise<{action:\"accept\"}|{action:\"skip\",reason:string}>,",
    "  config?: {run?: {maxRounds?: number, mode?: \"appear\"|\"consecutive\"}, other?: {x?: number}},",
    "  diagnostics?: {error:(event:object)=>void|Promise<void>}, // parser's own verdict (see `{is_error}`)",
    "  onRound?: (record:object) => void,",
    "}} options",
  ].join("\n");
  assert.deepEqual(
    topLevelOptionNames(synthetic),
    ["provider", "executeTool", "finalGuard", "config", "diagnostics", "onRound"],
    "抽取器必须只抽顶层（嵌套叶子、函数参数里的逗号、行尾注释都不许影响）",
  );
  // 反向证：往合成字面的顶层加一个名字，抽取结果必须跟着变（证明它读的是这份文本）。
  const mutated = synthetic.replace("  onRound?:", "  wrapup?: boolean,\n  onRound?:");
  assert.deepEqual(
    topLevelOptionNames(mutated),
    ["provider", "executeTool", "finalGuard", "config", "diagnostics", "wrapup", "onRound"],
    "顶层多一个名字时抽取结果必须多一个（否则判据读的不是这份文本）",
  );
});

test("T4 #213 R4 的两种静默退化形态都不许回来（独立 `//` 行 / 文档块不贴声明）", () => {
  // 形态一：内联类型字面里的**独立** `//` 行会让 TypeScript 把整个 `options` 参数退化成 `any`
  // （不报错、只在 `.d.ts` 里看得出来）。行尾 `//` 是安全的。
  const standaloneCommentLines = OPTIONS_LITERAL
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.startsWith("//"));
  assert.deepEqual(
    standaloneCommentLines.map(({ line }) => line),
    [],
    "类型字面里出现了独立的 `//` 行 ⇒ tsc 会把 options 静默退化成 any（把它挪到 `@param` 之前或改成行尾注释）",
  );

  // 形态二：文档块必须紧贴 `runToolLoop` 的声明正上方。
  const blockClose = ORCHESTRATOR_SOURCE.indexOf("*/", OPTIONS_BLOCK_END);
  assert.notEqual(blockClose, -1, "`}} options` 之后必须有 `*/` 收掉文档块");
  const afterBlock = ORCHESTRATOR_SOURCE.slice(blockClose + "*/".length).split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  assert.equal(
    afterBlock[0],
    "export async function runToolLoop(options) {",
    "JSDoc 文档块必须紧贴 `runToolLoop` 的声明正上方，否则 tsc 不认这块注释、参数退化成 any",
  );
});

// issue #519（0.30.0 破坏包）把直连路线的「两边各给一次」变成启动期抛，于是装配口路线
// （`runToolLoop({ assemblyPort, … })`）**只能**在端口那一侧给 `provider` / `executeTool`。
// 类型面若把它们声明成必填，这个唯一合法的调用在 `tsc --strict` 下就编译不过（实测 TS2739），
// 发布出去的声明文件会把合法宿主挡在门外——`check:release` 第 4 步的真 TS 宿主就是撞在这上面。
// T1 只比名字集合、看不见可选性，所以这条单列一格。
test("T5 `provider` / `executeTool` 声明为可选（装配口路线不许在调用点重复给，issue #519）", () => {
  for (const name of ["provider", "executeTool"]) {
    // 反向证：`name:`（必填）不命中，`name?:`（可选）才命中——正则读的就是类型字面本身。
    const optional = new RegExp(`^\\s*${name}\\?:`, "mu");
    assert.match(
      OPTIONS_LITERAL,
      optional,
      `顶层 \`${name}\` 必须是可选属性：装配口路线由 assemblyPort 提供它，而 issue #519 起`
        + "调用点再给一次就是启动期抛；声明成必填会让 tsc --strict 拒绝唯一合法的装配口调用",
    );
  }
  // 防「把两个键整个删掉」也算通过：名字仍在 T1 的集合里，这里再钉一次它们在字面里。
  for (const name of ["provider", "executeTool"]) {
    assert.ok(JSDOC_TOP_LEVEL.includes(name), `\`${name}\` 必须仍声明在类型面上`);
  }
});
