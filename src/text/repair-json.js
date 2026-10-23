// @ts-check
/**
 * L1 确定性修复层（issue #409；设计见 `docs/tasks/active/task-261023-406-normalization/DESIGN.md`）。
 *
 * **承重墙（一条不变量）**：修复产出的**每一个字符串值**，必须仍是原始文本里逐字存在的一段。
 *
 * 它同时是「值可信闸门」的判据与「修复器」的验收标准：任何改动了字节的修复规则自动不合格。
 * 于是「各种场景该默认开还是关」不再是判断题——每条规则都要过同一条机器检查
 * （`test/text/repair-json.test.js` 的「规则 × fixture」通用不变量用例）。
 *
 * 因此本文件的规则只许动**结构字符**：
 *   - 删：代码围栏、尾逗号、未闭合的括号（截断补全那一档，默认关）；
 *   - 插：引号（裸键）、反斜杠（非法转义加倍）、`null`（截断补全）；
 *   - 换：`'` → `"`（单引号串的分隔符）、`True`/`False`/`None` → `true`/`false`/`null`（字面量记号）。
 * 字符串**内容**的字节一个都不动。对照反例（jsonrepair 3.15.0，本机实测）：它处理非法转义是
 * **删反斜杠**——`{"api":"http\.request"}` 修成值 `http.request`，而原文里是 `http\.request`
 * ⇒ 闸门会把这条值整条丢掉 = 静默丢失。本文件的规则是**反斜杠加倍**（`\.` → `\\.`）：只是让它
 * 能被解析，解析结果逐字等于原文，闸门必然放行。
 *
 * ⚠ 反向红线：**先修文本、再拿修后文本做校验**是 bug（会静默丢值）。本模块不做任何校验，
 * 判据永远对**原文**判（`test/text/repair-json.test.js` 的通用用例就是这么断言的）。
 *
 * 本模块是**内部件**（issue #409 裁定：本单一个导出都不加进包根，`src/index.js` 不转出它）；
 * 消费者只有 `src/messages/tool-arguments.js` 与测试。
 *
 * 零依赖：只用 `node:` 内建与相对路径。
 */

/** 标识符起止字符（裸键与 `True`/`False`/`None` 的词法边界用）。 */
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const WHITESPACE = /\s/;

/** JSON 允许的**单字符**转义（`\u` 单独判，因为要带四位十六进制）。 */
const SIMPLE_ESCAPES = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t"]);

/** Python 字面量 → JSON 字面量（issue #409 裁定：实测语料里唯一一条真实需求就是它）。 */
const PYTHON_LITERALS = new Map([
  ["True", "true"],
  ["False", "false"],
  ["None", "null"],
]);

/**
 * 剥掉整段包住的 Markdown 代码围栏（` ```json … ``` `）。
 *
 * 只认「整段就是一段围栏」这一种形状：夹着散文的围栏属于「从模型文本里抠候选」，
 * 那是 L0（`parseModelJson`）与调用方的事，本层不越界。围栏本身不是内容，剥掉不改任何值。
 *
 * @param {string} text
 * @returns {string}
 */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match === null ? text : match[1];
}

/**
 * 删掉对象/数组末尾的多余逗号（`{"a":1,}` / `[1,2,]`）。只删逗号，值一个字节都不动。
 *
 * @param {string} text
 * @returns {string}
 */
function dropTrailingCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      out += character;
      continue;
    }
    if (character === ",") {
      let probe = index + 1;
      while (probe < text.length && WHITESPACE.test(text[probe])) probe += 1;
      if (text[probe] === "}" || text[probe] === "]") continue;
    }
    out += character;
  }
  return out;
}

/**
 * 单引号串体 → 双引号串体的**转义重写**（只插字符：`\` → `\\`、`"` → `\"`）。
 *
 * 这样重写之后解码结果逐字等于单引号里原本的字节（`'a\'b'` → `"a\\'b"` → 值 `a\'b`），
 * 于是不变量成立；代价是 `\'` 这种「本该是一个引号」的写法保真成两个字符——这正是
 * 「修复器只许搬运」的语义：模型写的是什么，值就是什么。
 *
 * @param {string} body
 * @returns {string}
 */
function escapeSingleQuotedBody(body) {
  return body.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * 单引号串 → 双引号串，裸键补引号（`{a: 'b'}` → `{"a": "b"}`）。
 *
 * 只换分隔符/补分隔符，内容按 `escapeSingleQuotedBody` 只插不删。
 *
 * @param {string} text
 * @returns {string}
 */
function quoteSingleQuotedAndBareKeys(text) {
  let out = "";
  let index = 0;
  /** 上一个「结构上有效」的字符（空白与串内容不更新它），用来判裸键位置。 */
  let previous = "";
  while (index < text.length) {
    const character = text[index];
    if (character === "\"") {
      out += character;
      index += 1;
      while (index < text.length) {
        const inner = text[index];
        out += inner;
        index += 1;
        if (inner === "\\" && index < text.length) {
          out += text[index];
          index += 1;
          continue;
        }
        if (inner === "\"") break;
      }
      previous = "\"";
      continue;
    }
    if (character === "'") {
      let body = "";
      index += 1;
      while (index < text.length) {
        const inner = text[index];
        if (inner === "\\" && index + 1 < text.length) {
          body += inner + text[index + 1];
          index += 2;
          continue;
        }
        if (inner === "'") {
          index += 1;
          break;
        }
        body += inner;
        index += 1;
      }
      out += `"${escapeSingleQuotedBody(body)}"`;
      previous = "\"";
      continue;
    }
    if (IDENT_START.test(character) && (previous === "{" || previous === ",")) {
      let end = index;
      while (end < text.length && IDENT_PART.test(text[end])) end += 1;
      let probe = end;
      while (probe < text.length && WHITESPACE.test(text[probe])) probe += 1;
      if (text[probe] === ":") {
        out += `"${text.slice(index, end)}"`;
        index = end;
        previous = "\"";
        continue;
      }
    }
    out += character;
    if (!WHITESPACE.test(character)) previous = character;
    index += 1;
  }
  return out;
}

/**
 * 非法转义**加倍**（`\.` → `\\.`）：只插一个反斜杠，内容字节一个不删。
 *
 * 这是本单最重要的规则，也是与 jsonrepair 的分歧点：它删反斜杠（值从 `http\.request` 变成
 * `http.request`，原文里再也找不到 ⇒ 闸门静默丢值），我们加倍（值仍是 `http\.request`）。
 *
 * @param {string} text
 * @returns {string}
 */
function doubleInvalidEscapes(text) {
  let out = "";
  let inString = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (!inString) {
      out += character;
      if (character === "\"") inString = true;
      index += 1;
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      if (next !== undefined && SIMPLE_ESCAPES.has(next)) {
        out += character + next;
        index += 2;
        continue;
      }
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
        out += character + next;
        index += 2;
        continue;
      }
      out += "\\\\";
      index += 1;
      continue;
    }
    out += character;
    if (character === "\"") inString = false;
    index += 1;
  }
  return out;
}

/**
 * Python 字面量 → JSON 字面量（`True`/`False`/`None`，只在**串外**、只在完整 token 上换）。
 *
 * 换的是记号不是值：`{'done': True}` → `{"done": true}`，字符串值一个字节都不动。
 *
 * @param {string} text
 * @returns {string}
 */
function replacePythonLiterals(text) {
  let out = "";
  let index = 0;
  let quote = "\"";
  let inString = false;
  while (index < text.length) {
    const character = text[index];
    if (inString) {
      out += character;
      if (character === "\\" && index + 1 < text.length) {
        out += text[index + 1];
        index += 2;
        continue;
      }
      if (character === quote) inString = false;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      inString = true;
      quote = character;
      out += character;
      index += 1;
      continue;
    }
    if (IDENT_START.test(character)) {
      let end = index;
      while (end < text.length && IDENT_PART.test(text[end])) end += 1;
      const token = text.slice(index, end);
      out += PYTHON_LITERALS.get(token) ?? token;
      index = end;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * 截断补全（**默认关**，issue #409 裁定：实测 `~/.erix/transcripts` 110 份 / 312 条终答里
 * 截断类需求 = 0 条 ⇒ 默认关的依据是「零需求」，不是「有风险」）。
 *
 * 它补的是**结构**（收尾引号、`null`、闭合括号），不补内容：补完仍过同一条不变量
 * （每个字符串值仍是原文里逐字存在的一段）。补不出来就原样返回，由调用方报解析失败。
 *
 * @param {string} text
 * @returns {string}
 */
function completeTruncatedJson(text) {
  const stack = [];
  let inString = false;
  let quote = "\"";
  let escaped = false;
  /** 下一个记号该是什么：`key` / `colon` / `value` / `separator`。 */
  let expecting = "value";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) {
        inString = false;
        expecting = expecting === "key" ? "colon" : "separator";
      }
      continue;
    }
    if (WHITESPACE.test(character)) continue;
    if (character === "\"" || character === "'") {
      inString = true;
      quote = character;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      expecting = character === "{" ? "key" : "value";
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      expecting = "separator";
      continue;
    }
    if (character === ",") {
      expecting = stack[stack.length - 1] === "{" ? "key" : "value";
      continue;
    }
    if (character === ":") {
      expecting = "value";
      continue;
    }
    if (/[0-9A-Za-z_$+.-]/.test(character)) {
      expecting = "separator";
    }
  }

  let out = text;
  if (inString) {
    // 悬空反斜杠：加倍再收尾（`…"x\` → `…"x\\"`，值 `x\` 仍是原文里逐字存在的一段）。
    if (escaped) out += "\\";
    out += quote;
    expecting = expecting === "key" ? "colon" : "separator";
  }
  out = out.replace(/,(\s*)$/, "$1");
  if (expecting === "colon") out += ":null";
  else if (expecting === "value" && out.trimEnd().endsWith(":")) out += "null";
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    out += stack[depth] === "{" ? "}" : "]";
  }
  if (out === text) return text;
  try {
    JSON.parse(out);
    return out;
  } catch {
    return text;
  }
}

/**
 * 规则表：**顺序即语义**（后一条吃前一条的产出），`defaultEnabled` 就是默认值裁定。
 *
 * 每条规则自己必须满足「不改内容字节」这条不变量；`test/text/repair-json.test.js` 的
 * 「规则 × fixture」通用用例逐条逐 fixture 断言 `原文.includes(每个修后的字符串值)`。
 *
 * @typedef {{ id: string, defaultEnabled: boolean, apply: (text: string) => string }} RepairRule
 * @type {readonly RepairRule[]}
 */
export const REPAIR_RULES = Object.freeze([
  { id: "code-fence", defaultEnabled: true, apply: stripCodeFence },
  { id: "single-quotes", defaultEnabled: true, apply: quoteSingleQuotedAndBareKeys },
  { id: "invalid-escape", defaultEnabled: true, apply: doubleInvalidEscapes },
  { id: "python-literals", defaultEnabled: true, apply: replacePythonLiterals },
  { id: "trailing-comma", defaultEnabled: true, apply: dropTrailingCommas },
  { id: "truncation", defaultEnabled: false, apply: completeTruncatedJson },
]);

/** 默认**开**的规则 id（顺序与 `REPAIR_RULES` 一致）。 */
export const DEFAULT_REPAIR_RULE_IDS = Object.freeze(
  REPAIR_RULES.filter((rule) => rule.defaultEnabled).map((rule) => rule.id),
);

/** 默认**关**、需要显式 opt-in 的规则 id。 */
export const OPT_IN_REPAIR_RULE_IDS = Object.freeze(
  REPAIR_RULES.filter((rule) => !rule.defaultEnabled).map((rule) => rule.id),
);

/**
 * 解析「这次启用哪些规则」：显式 `rules` 覆盖默认值；`truncation: true` 把 opt-in 档打开。
 *
 * @param {{ rules?: readonly string[], truncation?: boolean }} [options]
 * @returns {Set<string>}
 */
function resolveEnabledRules(options) {
  if (Array.isArray(options?.rules)) return new Set(options.rules);
  const enabled = new Set(DEFAULT_REPAIR_RULE_IDS);
  if (options?.truncation === true) {
    for (const id of OPT_IN_REPAIR_RULE_IDS) enabled.add(id);
  }
  return enabled;
}

/**
 * 按规则表顺序把修复跑一遍（不做解析，也不做任何校验）。
 *
 * @param {string} text
 * @param {{ rules?: readonly string[], truncation?: boolean }} [options]
 * @returns {{ text: string, applied: string[] }} `applied` 是**真的改了文本**的规则 id（按序）
 */
export function repairJsonText(text, options) {
  const enabled = resolveEnabledRules(options);
  let repaired = String(text ?? "");
  const applied = [];
  for (const rule of REPAIR_RULES) {
    if (!enabled.has(rule.id)) continue;
    const next = rule.apply(repaired);
    if (next !== repaired) {
      applied.push(rule.id);
      repaired = next;
    }
  }
  return { text: repaired, applied };
}

/**
 * 解析器原话里的出错位置（V8 的 `JSON.parse` 文案形如
 * `Expected ',' or '}' after property value in JSON at position 36 (line 1 column 37)`）。
 *
 * @param {string} message
 * @returns {number|undefined} 0 基字符偏移；抽不到就是 `undefined`（不编造位置）
 */
function parseErrorPosition(message) {
  const match = /at position (\d+)/.exec(String(message ?? ""));
  return match === null ? undefined : Number(match[1]);
}

/**
 * 解析结果：`ok` 时带 `value` 与 `applied`，失败时带 `error`（解析器原话 + 位置）与 `applied`。
 *
 * @typedef {object} RepairParseFailure
 * @property {"unparsable"} reason
 * @property {string} message 解析器原话（逐字，不改写）
 * @property {number} [position] 0 基字符偏移
 * @property {string} text 被判的那份文本（永远是**原文**，不是修后文本）
 *
 * @param {string} text
 * @param {{ rules?: readonly string[], truncation?: boolean }} [options]
 * @returns {{ ok: boolean, applied: string[], value?: any, error?: RepairParseFailure }}
 *   `ok: true` 时只有 `value`，`ok: false` 时只有 `error`。**刻意不写成判别联合**：本仓的
 *   `--checkJs` 不带 `strict`，布尔字面量判别在那里不收窄（实测 `if (parsed.ok)` 之后 `parsed.error`
 *   仍是 TS2339）——写联合只会让调用点被迫加 `any` 转换，而 `parseModelJson` 的公共判别联合
 *   （`ok: true` 字面量，宿主可收窄）不受影响，因为它是 `.d.ts` 里的公共面，本模块是内部件。
 */
export function parseJsonWithRepair(text, options) {
  const original = String(text ?? "");
  // L0 先说话：原文能解析就原样返回，修复层**一次都不跑**（修复永远没有机会把好文本改坏）。
  try {
    return { ok: true, value: JSON.parse(original), applied: [] };
  } catch {
    // 落到 L1
  }
  const { text: repaired, applied } = repairJsonText(original, options);
  try {
    return { ok: true, value: JSON.parse(repaired), applied };
  } catch {
    // 报**原文**的解析器原话：模型写的是原文，位置也只有对原文才有意义
    // （修后文本的偏移是引擎自己造出来的，拿它指路会把模型带偏）。
    let message = "";
    try {
      JSON.parse(original);
    } catch (error) {
      message = String(error?.message ?? error);
    }
    const position = parseErrorPosition(message);
    return {
      ok: false,
      error: {
        reason: "unparsable",
        message,
        ...(position === undefined ? {} : { position }),
        text: original,
      },
      applied,
    };
  }
}
