// issue #640 —— 续接块 `reason` 词表：**以前没有任何东西看守「注释里点名的名字」↔「代码里的字面量」**。
//
// 病根（与 #595「契约表 ↔ `LoopEvent.type` 联合」同族，但真值来源与覆盖面都不同，所以是两把闸、
// 不是一个单）：`upsertContinuityInMessages` 的注释写「三种结果」并点名 5 个名字，代码实际发 5 个；
// 而同一族里 `positionContinuityBlock` 还会发注释里**一个字都没提**的 `absent` / `already_tail`。
// 于是「少写一个名字」「多写一个名字」「改了字面量没改注释」三种漂移**全都不红**——直到有人去数。
//
// 本文件钉四件事（每件一条 test，红的时候一眼知道打的是哪一格）：
//   C1 `upsertContinuityInMessages`：**注释里点名的名字集合 == 代码里 `reason` 的字面量集合**
//      （多一个、少一个都红，并点名差集）。抽不到注释块 / 抽不到任何字面量 ⇒ **红**（不许静默绿）。
//   C2 `positionContinuityBlock`：同一把对账（词表本身也要对得上）。
//   C3 `positionContinuityBlock`：**每个** reason 要么有对外可观察出口（caller `placeContinuity` 里
//      被比较后交给 `recordContinuitySkip`），要么在注释里**显式声明「有意静默」并写明理由**。
//      「注释里没写、事件里也不发」的名字不许滑过去；全票「有意静默」也不许（那等于对外零信号，
//      C3 会退化成恒绿）。
//   C4 `upsertContinuityInMessages`：5 个名字在 `test/**/*.test.js` 里各有一条 `.reason` 断言
//      （字面量被改而测试没跟 ⇒ 红）。
//
// C0 是抽取器自测（house 口径同 `test/loop-event-type-surface-595.test.js` 的 C0）：合成源码上
// 「该抽的抽到、注释里的假 `reason:` 不算真出口、三元两支都抽到、`gate.reason` 那种间接层能沿
// `const gate = helper(…)` 解析、解析不动进 problems、空注释/无 JSDoc 触发「读不到真值就红」」。
// 没有 C0，上面四条可以靠「抽取器什么都抽不到 + 断言全空集相等」恒绿。
//
// 零 LLM、零写盘、不碰真实 `~/.erix`：只读三份文本（`src/loop/continuity-block.js`、
// `src/loop/orchestrator.js`、`test/**/*.test.js`）。
//
// 反向证明（实测命令与输出见交付报告；每条只打一格）：
//   · 把注释里 `moved_to_tail` 那一行删掉 ⇒ C1 红并点名 `moved_to_tail`（代码有、注释没点名）；
//   · 往注释里加一行 `· `ghost_reason` —— …` ⇒ C1 红并点名 `ghost_reason`（注释有、代码没有）；
//   · 把 `positionContinuityBlock` 的 `absent` 改名成 `missing`（代码 + 注释一起改）⇒ C2 绿、C3 红
//     （新名字既没有出口、也没声明有意静默）——证明 C3 真的在咬人；
//   · 把注释里的 `**有意静默**` 标记删掉 ⇒ C3 红并点名它；
//   · 把 `test/loop-continuity-block-568.test.js` 里 `moved_to_tail` 的 `.reason` 断言删掉 ⇒ C4 红；
//   · 把注释块整段删掉 / 把 `reason:` 全改成变量 ⇒ 抽取失败，C1/C2 红（不是「空集相等」的绿）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_URL = new URL("../src/loop/continuity-block.js", import.meta.url);
const ORCHESTRATOR_URL = new URL("../src/loop/orchestrator.js", import.meta.url);

/** 注释里声明「这个 reason 有意不给对外信号」的标记；标记后面必须跟 `理由：` 与实质文字。 */
const SILENT_MARKER = "**有意静默**";
const RATIONALE_LABEL = "理由：";
/** 理由正文的最小长度：只贴标签不写理由 = 把豁免退化成静音开关。 */
const RATIONALE_MIN_CHARS = 20;

// ============================================================================================
// 抽取器（纯函数，C0 用合成样本钉住它们；C1/C2/C3/C4 用它们读真树）
// ============================================================================================

/**
 * 去掉 `//` 与 `/* *\/` 注释，**引号感知**（字符串里的 `//` 不当注释）。
 *
 * 为什么必须先去注释：本文件的真值来源是「代码里的 `reason` 字面量」，而注释里恰恰到处是
 * `reason: "…"` 的**说明文字**（例如函数自己的 JSDoc）。不去注释的话，往注释里写一句
 * `reason: "ghost"` 就能让判据把假名字当成真出口 —— 那道闸就白设了（C0 钉这一格）。
 *
 * @param {string} code
 * @returns {string}
 */
function stripComments(code) {
  let out = "";
  let quote = null;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += code[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && code[index + 1] === "/") {
      while (index < code.length && code[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && code[index + 1] === "*") {
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) index += 1;
      index += 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * 从 `openAt`（必须指向 `{`）起找配平的那个 `}`，**引号感知**。
 *
 * @param {string} code
 * @param {number} openAt
 * @returns {number}
 */
function matchingBrace(code, openAt) {
  let depth = 0;
  let quote = null;
  for (let index = openAt; index < code.length; index += 1) {
    const char = code[index];
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
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  assert.fail("函数体的花括号不配平 —— 抽取器坏了（不许把「抽不到」当成绿）");
}

/**
 * 取一个函数的**函数体源码**（含外层 `{}`，不含签名前的 JSDoc）。
 *
 * 两种形状都认：`function name(…) {…}` 与 `const name = (…) => {…}`。后者必须从 `=>` 之后找
 * 函数体——`placeContinuity` 的形参里就带着 `({ round } = {})`，从「第一个 `{`」起算会切进形参。
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function functionBody(source, name) {
  for (const [pattern, kind] of [[`function ${name}(`, "declaration"], [`const ${name} = `, "arrow"]]) {
    const at = source.indexOf(pattern);
    if (at < 0) continue;
    const head = source.slice(at);
    let bodyStart;
    if (kind === "arrow") {
      const arrowAt = head.indexOf("=>");
      assert.notEqual(arrowAt, -1, `\`${name}\` 是 const 箭头函数，但抽不到 \`=>\``);
      bodyStart = at + arrowAt + 2;
      const braceAfterArrow = source.indexOf("{", bodyStart);
      assert.notEqual(braceAfterArrow, -1, `\`${name}\` 的箭头函数体不是块语句（\`{…}\`），抽不动`);
      bodyStart = braceAfterArrow;
    } else {
      const braceAt = head.indexOf("{");
      assert.notEqual(braceAt, -1, `\`${name}\` 的源码里找不到函数体起始 \`{\``);
      bodyStart = at + braceAt;
    }
    return source.slice(bodyStart, matchingBrace(source, bodyStart) + 1);
  }
  assert.fail(`抽不到 \`${name}\` 的源码 —— 函数被改名/搬走了，判据不许在这种时候变绿`);
}

/**
 * 取 `from` 起**一个属性值表达式**的源码：扫到顶层的 `,`（同层下一个属性）或 `}`（对象结束）为止。
 *
 * 为什么不能只用 `reason:\s*"([a-z_]+)"`：真代码里 `reason` 的值有三种形态——直接字面量
 * （`reason: "empty"`）、三元（`? "in_place" : "moved_to_tail"`）、以及**间接层**
 * （`reason: gate.reason`，字面量在 `tailGate` 里）。只认第一种会漏掉 3/5 个真出口，
 * 而「漏掉的出口」正是这道闸存在的理由。
 *
 * @param {string} code
 * @param {number} from
 * @returns {string}
 */
function propertyExpression(code, from) {
  let depth = 0;
  let quote = null;
  let index = from;
  for (; index < code.length; index += 1) {
    const char = code[index];
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
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === "," && depth === 0) break;
  }
  return code.slice(from, index);
}

/**
 * 函数体里每一个 `reason:` 的值表达式（已去注释、已 trim）。
 *
 * @param {string} body
 * @returns {string[]}
 */
function reasonExpressions(body) {
  const code = stripComments(body);
  const found = [];
  for (const match of code.matchAll(/\breason\s*:\s*/gu)) {
    found.push(propertyExpression(code, match.index + match[0].length).trim());
  }
  return found;
}

/**
 * 同函数里 `const <base> = <helper>(…)` 的 `<helper>` 名（间接层的解析依据）。
 *
 * @param {string} body
 * @param {string} base
 * @returns {string|undefined}
 */
function helperNameFor(body, base) {
  const pattern = new RegExp(`(?:const|let)\\s+${base}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "u");
  const match = pattern.exec(stripComments(body));
  return match === null ? undefined : match[1];
}

/**
 * 抽一个函数所有 `reason` 出口的**字面量集合**（递归解析间接层，最多 3 层）。
 *
 * 抽不动的形态（既没有字面量、也不是可解析的标识符链；或间接层解析不到）一律进 `problems` ——
 * 调用方必须让 `problems` 非空就红。「解析器看不见的出口」与「没有那个出口」在结果上是同一个绿，
 * 而前者恰恰是这道闸会漏掉的真名字（#595 C0 的教训）。
 *
 * @param {string} source
 * @param {string} name
 * @param {{depth?: number, trail?: string[]}} [options]
 * @returns {{literals: Set<string>, problems: string[]}}
 */
function reasonLiteralsIn(source, name, { depth = 0, trail = [] } = {}) {
  const body = functionBody(source, name);
  const literals = new Set();
  const problems = [];
  const expressions = reasonExpressions(body);
  if (expressions.length === 0) {
    problems.push(`\`${name}\` 的函数体里一个 \`reason:\` 都抽不到 —— 判据在空转，不许绿`);
    return { literals, problems };
  }
  for (const expression of expressions) {
    const inline = [...expression.matchAll(/"([^"]*)"/gu)].map((match) => match[1]);
    if (inline.length > 0) {
      for (const literal of inline) literals.add(literal);
      continue;
    }
    const chain = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/u.exec(expression);
    if (chain === null) {
      problems.push(
        `\`${name}\`：\`reason:\` 的值既没有字面量、也不是可解析的标识符链（抽不动 ⇒ 不许静默跳过）: \`${expression}\``,
      );
      continue;
    }
    if (depth >= 3) {
      problems.push(`\`${name}\`：reason 的间接层超过 3 层（${[...trail, expression].join(" → ")}）`);
      continue;
    }
    const helper = helperNameFor(body, chain[1]);
    if (helper === undefined) {
      problems.push(
        `\`${name}\`：\`reason: ${expression}\` 的间接层解析不到（同函数里没有 \`const ${chain[1]} = <helper>(…)\`）`,
      );
      continue;
    }
    const resolved = reasonLiteralsIn(source, helper, {
      depth: depth + 1,
      trail: [...trail, `${name}.reason = ${expression}`, `helper ${helper}`],
    });
    problems.push(...resolved.problems);
    if (resolved.literals.size === 0 && resolved.problems.length === 0) {
      problems.push(`\`${name}\`：间接层 \`${expression}\` → \`${helper}\` 里抽不到任何 reason 字面量`);
    }
    for (const literal of resolved.literals) literals.add(literal);
  }
  return { literals, problems };
}

/**
 * 取一个函数**紧邻的 JSDoc 注释块**原文（含 `/**` 与 `*\/`）。
 *
 * 硬约束：JSDoc 与函数之间只允许有 `export`（抽错块 = 拿隔壁函数的注释当真值）。
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function jsdocOf(source, name) {
  const fnAt = source.indexOf(`function ${name}(`);
  assert.notEqual(fnAt, -1, `抽不到 \`${name}\` 的源码 —— 函数被改名/搬走了`);
  const docEnd = source.lastIndexOf("*/", fnAt);
  assert.notEqual(docEnd, -1, `\`${name}\` 前面没有注释块（\`*/\`）—— 抽不到注释就等于判据在空转`);
  const docStart = source.lastIndexOf("/**", docEnd);
  assert.notEqual(docStart, -1, `\`${name}\` 的注释块起点（\`/**\`）抽不到`);
  const between = source.slice(docEnd + 2, fnAt).trim();
  assert.equal(
    between,
    "export",
    `\`${name}\` 与它的 JSDoc 之间只允许有 \`export\`（实际抽到 ${JSON.stringify(between)}）—— 抽错块就白判`,
  );
  return source.slice(docStart, docEnd + 2);
}

/**
 * 抽一个函数注释块里点名的 reason 名（`· \`名字\` —— 说明` 形态的条目）。
 *
 * 形如 `· \`x\`` 但名字不是 snake_case 的行进 `problems`（不是静默跳过）；抽到 0 条由调用方判红
 * （注释格式变了 / 块没了）。
 *
 * @param {string} source
 * @param {string} name
 * @returns {{named: Map<string, string>, problems: string[]}}
 */
function commentNamedReasons(source, name) {
  const doc = jsdocOf(source, name);
  const named = new Map();
  const problems = [];
  for (const line of doc.split("\n")) {
    const bullet = /^\s*\*\s+·\s+`([^`]+)`\s+——\s*(.*)$/u.exec(line);
    if (bullet === null) continue;
    const [, rawName, description] = bullet;
    if (!/^[a-z][a-z0-9_]*$/u.test(rawName)) {
      problems.push(`\`${name}\`：注释里点名的 \`${rawName}\` 不是 snake_case 的 reason 名（抽不动的行不许静默跳过）`);
      continue;
    }
    if (named.has(rawName)) problems.push(`\`${name}\`：注释里 \`${rawName}\` 点名了两次`);
    named.set(rawName, description);
  }
  return { named, problems };
}

/** 取注释点名清单，**取不到就红**。 */
function requireNamedReasons(source, name) {
  const { named, problems } = commentNamedReasons(source, name);
  assert.deepEqual(problems, [], `${name}：注释块里有抽不动的行 —— 判据不许在这种时候变绿`);
  assert.ok(
    named.size > 0,
    `${name}：注释块里一条 \`· \\\`名字\\\` —— …\` 都没抽到（注释格式变了 / 块抽错了）——`
      + " 读不到真值就红，不许静默绿",
  );
  return named;
}

/** 取代码里的 reason 字面量集合，**抽不到/抽不动就红**。 */
function requireReasonLiterals(source, name) {
  const { literals, problems } = reasonLiteralsIn(source, name);
  assert.deepEqual(problems, [], `${name}：reason 字面量抽取有抽不动的出口 —— 不许静默跳过`);
  assert.ok(literals.size > 0, `${name}：一个 reason 字面量都抽不到 —— 判据在空转，不许绿`);
  return literals;
}

/** 注释点名集合 ↔ 代码字面量集合，双向对账（差集点名）。 */
function reconcile(source, name) {
  const named = requireNamedReasons(source, name);
  const literals = requireReasonLiterals(source, name);
  const missingInComment = [...literals].filter((literal) => !named.has(literal)).sort();
  const missingInCode = [...named.keys()].filter((literal) => !literals.has(literal)).sort();
  assert.deepEqual(
    missingInComment,
    [],
    `${name}：代码里有、注释里没点名的 reason: ${missingInComment.join(" / ")}（宿主按 reason 记账，注释是它的说明书）`,
  );
  assert.deepEqual(
    missingInCode,
    [],
    `${name}：注释里点名了、代码里没有的 reason: ${missingInCode.join(" / ")}（注释在描述一个不存在的出口）`,
  );
  return { named, literals };
}

/**
 * 注释里「有意静默」的声明：返回理由正文（没声明 ⇒ `undefined`；声明了但没 `理由：` ⇒ `""`）。
 *
 * @param {string} description
 * @returns {string|undefined}
 */
function silenceRationale(description) {
  const at = description.indexOf(SILENT_MARKER);
  if (at < 0) return undefined;
  const rest = description.slice(at + SILENT_MARKER.length);
  const labelAt = rest.indexOf(RATIONALE_LABEL);
  return labelAt < 0 ? "" : rest.slice(labelAt + RATIONALE_LABEL.length).trim();
}

/**
 * caller `placeContinuity` 给 `positionContinuityBlock` 的结果开出的**对外出口**集合。
 *
 * 口径：`placed.reason === "…"` 比较后交给 `recordContinuitySkip`（⇒ `continuity_injection_skipped`
 * 事件）。抽不到 `recordContinuitySkip(` 调用 ⇒ `problems`（出口通道被删了，判据不许静默绿）。
 *
 * @param {string} orchestratorSource
 * @returns {{reasons: Set<string>, problems: string[]}}
 */
function continuityOutletReasons(orchestratorSource) {
  const body = stripComments(functionBody(orchestratorSource, "placeContinuity"));
  const problems = [];
  if (!body.includes("recordContinuitySkip(")) {
    problems.push("`placeContinuity` 里没有 `recordContinuitySkip(` 调用 —— 这个函数的对外出口抽不到，判据不许静默绿");
  }
  const reasons = new Set(
    [...body.matchAll(/placed\.reason\s*===\s*"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1]),
  );
  return { reasons, problems };
}

/** `test/**\/*.test.js` 的全部路径（**排除本文件**：它自己的合成样本不许满足 C4）。 */
function testCorpus() {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name.endsWith(".test.js")) files.push(path);
    }
  };
  walk(join(ROOT, "test"));
  const selfPath = fileURLToPath(import.meta.url);
  return files.filter((path) => path !== selfPath);
}

// ============================================================================================
// C0 —— 抽取器自测（合成源码，不碰真树）
// ============================================================================================

/**
 * 合成样本：注释点名 `alpha` / `beta`（`beta` 声明有意静默），代码里
 *   · 直接字面量 `alpha`；
 *   · 三元两支 `beta` / `alpha`；
 *   · 间接层 `gate.reason` → `probe` 里的 `beta`；
 *   · 注释里那句 `reason: "ghost"` **不是**真出口（去注释后才抽）。
 */
const SAMPLE_SOURCE = [
  "/**",
  " * 两个结果（`reason` 是给诊断/账本用的可断言字面量）：",
  " *   · `alpha` —— 甲：注入成功；",
  " *   · `beta` —— 乙：**有意静默**。理由：合成样本里的理由，够长够具体，能过最小长度。",
  " * 正文里的 `gamma` 不算点名（没有 `·` 前缀），`reason: \"ghost\"` 也不是真出口。",
  " */",
  "export function sample(messages) {",
  "  // 注释里的 `reason: \"ghost\"` 不许被当成真出口",
  "  const gate = probe(messages);",
  "  if (!gate.ok) return { messages, injected: false, reason: gate.reason };",
  "  if (messages.length === 0) return { messages, injected: true, reason: \"alpha\" };",
  "  return {",
  "    messages,",
  "    injected: true,",
  "    reason: messages.length > 1",
  "      ? \"beta\"",
  "      : \"alpha\",",
  "  };",
  "}",
  "",
  "function probe(messages) {",
  "  if (messages === undefined) return { ok: false, reason: \"beta\" };",
  "  return { ok: true };",
  "}",
  "",
  "function opaque(messages) {",
  "  const whatever = messages.whatever;",
  "  return { messages, injected: false, reason: whatever };",
  "}",
].join("\n");

test("C0 抽取器自测：点名清单只认 `· \\`名字\\` —— ` 行、注释里的 `reason:` 不算出口、三元两支都抽到、间接层能解析、解析不动进 problems、空注释/无 JSDoc 触发「读不到真值就红」", () => {
  // ① 注释点名：只认 `· \`名字\` —— ` 形态；正文里的 `gamma` 不算；重复点名会进 problems。
  const { named, problems } = commentNamedReasons(SAMPLE_SOURCE, "sample");
  assert.deepEqual([...named.keys()], ["alpha", "beta"], "只认 `· `名字` —— ` 形态的条目（`gamma` 那种正文提及不算）");
  assert.deepEqual(problems, [], "合成样本里没有抽不动的行");
  assert.match(named.get("beta") ?? "", /有意静默/u, "条目必须带出说明文字（C3 靠它读「有意静默」声明）");

  // ② 代码字面量：直接字面量 + 三元两支 + 间接层（`gate.reason` → `probe`）；注释里的 `ghost` 不算。
  const { literals, problems: literalProblems } = reasonLiteralsIn(SAMPLE_SOURCE, "sample");
  assert.deepEqual([...literals].sort(), ["alpha", "beta"], "三元的两支与间接层里的字面量都必须抽到");
  assert.deepEqual(literalProblems, [], "合成样本的每个出口都抽得动");
  assert.ok(!literals.has("ghost"), "注释里的 `reason: \"ghost\"` 不是真出口（去注释这一步不许省）");

  // ③ 对账通过（真值本来就一致）。
  assert.doesNotThrow(() => reconcile(SAMPLE_SOURCE, "sample"), "注释与代码一致时不许红");

  // ④ 反向：代码有、注释没点名 ⇒ 点名差集。
  const commentShort = SAMPLE_SOURCE.replace(" *   · `beta` —— 乙：**有意静默**。理由：合成样本里的理由，够长够具体，能过最小长度。\n", "");
  assert.throws(
    () => reconcile(commentShort, "sample"),
    /代码里有、注释里没点名的 reason: beta/u,
    "少一个名字必须红并点名它",
  );

  // ⑤ 反向：注释点名了、代码没有 ⇒ 点名差集。
  const commentExtra = SAMPLE_SOURCE.replace(
    " *   · `alpha` —— 甲：注入成功；\n",
    " *   · `alpha` —— 甲：注入成功；\n *   · `ghost_reason` —— 注释在描述一个不存在的出口；\n",
  );
  assert.throws(
    () => reconcile(commentExtra, "sample"),
    /注释里点名了、代码里没有的 reason: ghost_reason/u,
    "多一个名字必须红并点名它",
  );

  // ⑥ 反向：间接层解析不到（`reason: whatever` 既不是字面量、也没有 `const whatever = helper(`）⇒ problems。
  const opaque = reasonLiteralsIn(SAMPLE_SOURCE, "opaque");
  assert.equal(opaque.literals.size, 0, "解析不动时不许凭空造出字面量");
  assert.equal(opaque.problems.length, 1, "抽不动的出口必须进 problems（静默跳过 = 这道闸漏一个真名字）");
  assert.match(opaque.problems[0], /whatever/u, "problems 必须点名抽不动的那一处");

  // ⑦ 反向：注释块没了 ⇒ 红（不是「空集相等」的绿）。
  assert.throws(
    () => requireNamedReasons(SAMPLE_SOURCE.replace(/\/\*\*[\s\S]*?\*\/\n/u, ""), "sample"),
    /没有注释块|都没抽到/u,
    "抽不到注释块必须红",
  );
  // ⑧ 反向：注释块在、但一条 `·` 条目都没有 ⇒ 红。
  const bulletless = SAMPLE_SOURCE.replace(/ \*   · `[^`]+` —— .*\n/gu, "");
  assert.throws(
    () => requireNamedReasons(bulletless, "sample"),
    /一条 .*都没抽到/u,
    "抽到 0 条点名必须红（注释格式变了就抽不到，静默绿等于放弃这道闸）",
  );
  // ⑨ 反向：函数体里一个 `reason:` 都没有 ⇒ 红。
  const noReason = SAMPLE_SOURCE.replaceAll("reason: ", "note: ");
  assert.throws(
    () => requireReasonLiterals(noReason, "sample"),
    /一个 `reason:` 都抽不到/u,
    "抽不到任何 reason 出口必须红",
  );
});

test("C0b 出口集合抽取器自测：`placed.reason === \"…\"` 抽得到、没有 `recordContinuitySkip(` 就红", () => {
  const sample = [
    "const placeContinuity = ({ round } = {}) => {",
    "  if (state === undefined) return undefined;",
    "  const placed = position(messages);",
    "  messages = placed.messages;",
    "  if (!placed.moved && placed.reason === \"pending_tool_use\") {",
    "    recordContinuitySkip({ round, reason: placed.reason });",
    "  }",
    "  return placed;",
    "};",
  ].join("\n");
  assert.deepEqual([...continuityOutletReasons(sample).reasons], ["pending_tool_use"]);
  assert.deepEqual(continuityOutletReasons(sample).problems, [], "有 `recordContinuitySkip(` 时不许报问题");

  const noRecorder = sample.replace("recordContinuitySkip({ round, reason: placed.reason });", "void placed;");
  assert.equal(continuityOutletReasons(noRecorder).problems.length, 1, "出口通道被删掉必须红，不许静默变成空集合");
  // 箭头函数形参里带 `{`：从「第一个 `{`」起算会切进形参 ⇒ 这里顺带钉住 functionBody 的箭头分支。
  assert.match(
    continuityOutletReasons(sample).problems.join(""),
    /^$/u,
    "形参里的 `{` 不许把函数体切错",
  );
});

// ============================================================================================
// C1 / C2 —— 注释点名集合 ↔ 代码字面量集合
// ============================================================================================

test("C1 `upsertContinuityInMessages`：注释点名的名字集合 == 代码里 `reason` 的字面量集合（多一少一都红并点名差集）", () => {
  const source = readFileSync(SOURCE_URL, "utf8");
  const { named, literals } = reconcile(source, "upsertContinuityInMessages");
  // 前提（防这道闸退化成「两边都空」）：本单主体那五个名字必须真的在两边。
  for (const name of ["empty", "pending_tool_use", "in_place", "moved_to_tail", "inserted"]) {
    assert.ok(literals.has(name), `代码里必须还有 \`${name}\`（实测字面量 ${JSON.stringify([...literals].sort())}）`);
    assert.ok(named.has(name), `注释里必须点名 \`${name}\`（实测点名 ${JSON.stringify([...named.keys()].sort())}）`);
  }
  assert.equal(literals.size, 5, `\`upsertContinuityInMessages\` 的 reason 字面量应恰好 5 个（实测 ${[...literals].sort().join(" / ")}）`);
  // 注释里不许再说「三种结果」：那句措辞与五个名字不自洽（#640 正文 ①）。
  assert.ok(
    !/三种结果/u.test(jsdocOf(source, "upsertContinuityInMessages")),
    "`upsertContinuityInMessages` 的注释里不许再写「三种结果」——按 injected 分组之后是「三个 + 两个」",
  );
});

test("C2 `positionContinuityBlock`：注释点名的名字集合 == 代码里 `reason` 的字面量集合", () => {
  const source = readFileSync(SOURCE_URL, "utf8");
  const { named, literals } = reconcile(source, "positionContinuityBlock");
  for (const name of ["absent", "already_tail", "pending_tool_use", "moved_to_tail"]) {
    assert.ok(literals.has(name), `代码里必须还有 \`${name}\`（实测字面量 ${JSON.stringify([...literals].sort())}）`);
    assert.ok(named.has(name), `注释里必须点名 \`${name}\`（实测点名 ${JSON.stringify([...named.keys()].sort())}）`);
  }
  assert.equal(literals.size, 4, `\`positionContinuityBlock\` 的 reason 字面量应恰好 4 个（实测 ${[...literals].sort().join(" / ")}）`);
});

// ============================================================================================
// C3 —— position 的每个 reason：有对外出口，或显式声明「有意静默」并写明理由
// ============================================================================================

test("C3 `positionContinuityBlock`：每个 reason 要么有对外可观察出口，要么在注释里显式声明「有意静默」并写明理由", () => {
  const source = readFileSync(SOURCE_URL, "utf8");
  // 这一格只看**注释点名的每个名字**有没有着落；「注释 ↔ 代码」的集合对账是 C2 的事——
  // 两格分开才能各自被单独打红（C2 的变异不许顺带把 C3 带红，反之亦然）。
  const named = requireNamedReasons(source, "positionContinuityBlock");
  const outlet = continuityOutletReasons(readFileSync(ORCHESTRATOR_URL, "utf8"));
  assert.deepEqual(outlet.problems, [], "`placeContinuity` 的出口通道抽不到 —— 判据不许静默绿");
  assert.ok(
    outlet.reasons.size > 0,
    "从 `placeContinuity` 里抽不到任何 reason 比较 —— 出口集合为空 ⇒ C3 会退化成恒绿",
  );

  const silent = [];
  const mute = [];
  for (const [name, description] of named) {
    const rationale = silenceRationale(description);
    if (rationale !== undefined) {
      assert.ok(
        rationale.length >= RATIONALE_MIN_CHARS,
        `\`${name}\` 声明了「有意静默」，但理由只有 ${rationale.length} 字（< ${RATIONALE_MIN_CHARS}）：`
          + "只贴标签不写理由 = 把豁免退化成静音开关",
      );
      silent.push(name);
      continue;
    }
    if (!outlet.reasons.has(name)) mute.push(name);
  }

  assert.deepEqual(
    mute,
    [],
    "既没有对外可观察出口、也没在注释里声明「有意静默」的 reason: "
      + `${mute.join(" / ")}（caller \`placeContinuity\` 不比较它 ⇒ 宿主拿不到任何信号，也不会有事件）`,
  );
  assert.ok(
    silent.length < named.size,
    `\`positionContinuityBlock\` 的 ${named.size} 个 reason 全票「有意静默」——那等于这个函数对外零信号，`
      + " C3 退化成恒绿；至少要有名字走 `continuity_injection_skipped` 那条出口",
  );
  // 前提：那条真出口必须还在出口集合里（本单的「有出口」样本就是它）。
  assert.ok(
    outlet.reasons.has("pending_tool_use"),
    `\`placeContinuity\` 里必须还有 \`placed.reason === "pending_tool_use"\` 那处比较（实测 ${JSON.stringify([...outlet.reasons])}）`,
  );
});

// ============================================================================================
// C4 —— upsert 的五个名字各有一条测试断言
// ============================================================================================

test("C4 `upsertContinuityInMessages`：五个 reason 在 `test/**/*.test.js` 里各有一条 `.reason` 断言", () => {
  const source = readFileSync(SOURCE_URL, "utf8");
  const literals = requireReasonLiterals(source, "upsertContinuityInMessages");
  const files = testCorpus();
  assert.ok(files.length > 0, "测试语料一个 `.test.js` 都没找到 —— 语料抽取坏了，判据不许绿");
  assert.ok(
    files.some((path) => path.endsWith("loop-continuity-block-568.test.js")),
    "语料里必须包含续接块主题文件 `test/loop-continuity-block-568.test.js`（断言就在那里）",
  );
  const corpus = files.map((path) => ({ path: path.slice(ROOT.length), text: readFileSync(path, "utf8") }));

  const unasserted = [];
  for (const name of [...literals].sort()) {
    // 只认**断言形态**：`assert.equal(x.reason, "name")` 这类。裸字符串命中不算——
    // `"empty"` 在测试里到处是（临时目录名、runId），拿它当覆盖就是 #640 正文 ③ 点出的那个坑
    // （「absent 命中 11 处」命中的是隔壁函数的 `status`）。
    const pattern = new RegExp(`\\.reason\\s*,\\s*"${name}"`, "u");
    if (!corpus.some(({ text }) => pattern.test(text))) unasserted.push(name);
  }
  assert.deepEqual(
    unasserted,
    [],
    "代码里有、但 `test/**/*.test.js` 里没有一条 `.reason` 断言的理由: "
      + `${unasserted.join(" / ")}（字面量改了而测试没跟 ⇒ 这条出口就是没被钉住的）`,
  );
});
