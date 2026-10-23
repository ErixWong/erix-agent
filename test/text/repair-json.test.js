// L1 确定性修复层（`src/text/repair-json.js`）的单测 —— issue #409。
//
// 本文件的核心不是「每条规则能修出什么」，而是那条**不变量**：
//   **修复产出的每一个字符串值，必须仍是原始文本里逐字存在的一段。**
// 通用用例（`规则 × fixture`）逐条逐 fixture 断言 `原文.includes(每个修后的字符串值)`；
// 反向证（本单在交付报告里贴了命令与输出）：把 `invalid-escape` 改成「删反斜杠」那种
// 改字节的实现 ⇒ 通用用例变红。所以这条断言不是装饰，它是修复器唯一的验收标准。

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REPAIR_RULE_IDS,
  OPT_IN_REPAIR_RULE_IDS,
  REPAIR_RULES,
  parseJsonWithRepair,
  repairJsonText,
} from "../../src/text/repair-json.js";

const RULE_IDS = REPAIR_RULES.map((rule) => rule.id);

/**
 * fixture 语料：每条都标注**最小规则集**（`rules`）与修好之后的期望值。
 * `onlyParses` 用来证明「这条规则单独就够」——通用用例据此逐格断言不变量。
 */
const FIXTURES = [
  {
    name: "code-fence",
    rules: ["code-fence"],
    text: "```json\n{\"path\": \"a.txt\"}\n```",
    expected: { path: "a.txt" },
  },
  {
    name: "trailing-comma",
    rules: ["trailing-comma"],
    text: "{\"path\": \"a.txt\",}",
    expected: { path: "a.txt" },
  },
  {
    name: "nested-trailing-comma",
    rules: ["trailing-comma"],
    text: "{\"items\": [1, 2,], \"meta\": {\"ok\": true,},}",
    expected: { items: [1, 2], meta: { ok: true } },
  },
  {
    name: "single-quotes-and-bare-keys",
    rules: ["single-quotes"],
    text: "{path: 'a.txt', mode: 'read'}",
    expected: { path: "a.txt", mode: "read" },
  },
  {
    name: "single-quotes-escaped-body",
    rules: ["single-quotes"],
    text: "{note: 'it\\'s \"quoted\"'}",
    // 单引号串体**逐字保真**：`\'` 保留成反斜杠 + 引号两个字符（不替模型决定它想写什么）。
    expected: { note: "it\\'s \"quoted\"" },
  },
  {
    name: "invalid-escape",
    rules: ["invalid-escape"],
    text: "{\"re\": \"\\d+\", \"api\": \"http\\.request\"}",
    expected: { re: "\\d+", api: "http\\.request" },
  },
  {
    name: "python-literals",
    rules: ["python-literals"],
    text: "{\"done\": True, \"ratio\": False, \"note\": None}",
    expected: { done: true, ratio: false, note: null },
  },
  {
    name: "python-literals-and-single-quotes",
    rules: ["single-quotes", "python-literals"],
    // #406 语料里唯一一条真实需求：单引号 + `True` 同时出现。
    text: "{'done': True, 'summary': '计算 17×23', 'output': '391'}",
    expected: { done: true, summary: "计算 17×23", output: "391" },
  },
  {
    name: "truncation-unterminated-string",
    rules: ["truncation"],
    text: "{\"path\": \"a.txt\", \"body\": \"hel",
    expected: { path: "a.txt", body: "hel" },
  },
  {
    name: "truncation-open-array",
    rules: ["truncation"],
    text: "{\"items\": [1, 2",
    expected: { items: [1, 2] },
  },
];

/** 递归收集一个解析结果里的**每一个字符串值**（含对象键：键也是字符串值）。 */
function stringValues(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringValues(entry, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      stringValues(entry, out);
    }
  }
  return out;
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

test("规则表：默认开的五条 + 默认关的一条（截断补全），顺序即语义", () => {
  assert.deepEqual(RULE_IDS, [
    "code-fence",
    "single-quotes",
    "invalid-escape",
    "python-literals",
    "trailing-comma",
    "truncation",
  ]);
  assert.deepEqual([...DEFAULT_REPAIR_RULE_IDS], [
    "code-fence",
    "single-quotes",
    "invalid-escape",
    "python-literals",
    "trailing-comma",
  ]);
  // 默认关的依据是「零需求」而不是「有风险」（issue #409 裁定 1）：
  // 实测 110 份 transcript / 312 条真实终答里截断类需求 = 0 条。
  assert.deepEqual([...OPT_IN_REPAIR_RULE_IDS], ["truncation"]);
});

test("通用不变量：每一条规则 × 每一个 fixture，修出的每个字符串值都逐字出现在原文里", () => {
  const covered = new Set();
  for (const rule of REPAIR_RULES) {
    for (const fixture of FIXTURES) {
      // 「只开这一条规则」——矩阵的意义是逐规则验，不是只看整条流水线的结果。
      const { text } = repairJsonText(fixture.text, { rules: [rule.id] });
      const parsed = tryParse(text);
      if (!parsed.ok) continue;
      if (text !== fixture.text) covered.add(rule.id);
      for (const value of stringValues(parsed.value)) {
        assert.ok(
          fixture.text.includes(value),
          `规则 ${rule.id} 在 fixture「${fixture.name}」上改动了内容字节：`
          + `值 ${JSON.stringify(value)} 不在原文 ${JSON.stringify(fixture.text)} 里`,
        );
      }
    }
  }
  // 覆盖面守门：每条规则都必须在至少一个 fixture 上真的改过文本，否则上面那层断言是空转。
  assert.deepEqual([...covered].sort(), [...RULE_IDS].sort(),
    `这些规则在 fixture 语料里一次都没生效（矩阵空转）：${RULE_IDS.filter((id) => !covered.has(id)).join(" / ")}`);
});

test("通用不变量：整条流水线（默认规则）修出的每个字符串值也逐字出现在原文里", () => {
  for (const fixture of FIXTURES) {
    const parsed = parseJsonWithRepair(fixture.text);
    if (!parsed.ok) continue;
    for (const value of stringValues(parsed.value)) {
      assert.ok(
        fixture.text.includes(value),
        `fixture「${fixture.name}」的流水线结果改动了内容字节：${JSON.stringify(value)}`,
      );
    }
  }
});

test("每个 fixture 都在它标注的最小规则集下可解析，且值等于期望", () => {
  for (const fixture of FIXTURES) {
    const { text } = repairJsonText(fixture.text, { rules: fixture.rules });
    const parsed = tryParse(text);
    assert.equal(parsed.ok, true,
      `fixture「${fixture.name}」应该靠规则 ${fixture.rules.join("+")} 解析成功，实际文本：${JSON.stringify(text)}`);
    assert.deepEqual(parsed.value, fixture.expected, `fixture「${fixture.name}」的值`);
  }
});

test("默认规则集就能解析全部「默认开」那一档的 fixture（含 #406 那条真实语料）", () => {
  for (const fixture of FIXTURES) {
    const parsed = parseJsonWithRepair(fixture.text);
    if (fixture.rules.includes("truncation")) {
      assert.equal(parsed.ok, false, `截断类 fixture「${fixture.name}」默认不该被补全`);
      continue;
    }
    assert.equal(parsed.ok, true, `fixture「${fixture.name}」默认规则集应该解析成功`);
    assert.deepEqual(parsed.value, fixture.expected);
  }
});

test("非法转义加倍（不是删反斜杠）：值仍是原文里逐字存在的那一段，闸门必然放行", () => {
  const original = "{\"api\": \"http\\.request\"}";
  const parsed = parseJsonWithRepair(original);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.applied, ["invalid-escape"]);
  // jsonrepair 3.15.0 在这里会给出 `http.request`（删反斜杠）⇒ 原文.includes(值) = false
  // ⇒ 闸门整条丢掉 = 静默丢失。我们加倍，解析结果逐字等于原文。
  assert.equal(parsed.value.api, "http\\.request");
  assert.equal(original.includes(parsed.value.api), true);
  assert.equal(original.includes("http.request"), false, "删反斜杠的实现会产出这个值（本行是它的反向证）");
});

test("截断补全：开 ⇒ 能补上并解析；关 ⇒ 文本逐字不变（等于今天的行为）", () => {
  const original = "{\"path\": \"a.txt\", \"body\": \"hel";
  const off = parseJsonWithRepair(original);
  assert.equal(off.ok, false);
  assert.equal(off.applied.length, 0, "默认规则集一次都不该改这段文本");
  assert.deepEqual(repairJsonText(original).text, original, "关 = 逐字等于今天：文本一个字节都不动");
  assert.equal(off.error.reason, "unparsable");
  assert.match(off.error.message, /Unterminated string/);
  assert.equal(off.error.text, original, "报错文本永远是**原文**（不是修后文本）");

  const on = parseJsonWithRepair(original, { truncation: true });
  assert.equal(on.ok, true);
  assert.deepEqual(on.applied, ["truncation"]);
  assert.deepEqual(on.value, { path: "a.txt", body: "hel" });
  assert.equal(original.includes(on.value.body), true);
});

test("L0 先说话：原文能解析时修复层一次都不跑（applied 为空）", () => {
  const original = "{\"a\": \"it's\", \"b\": \"line\\nbreak\"}";
  const parsed = parseJsonWithRepair(original);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.applied, []);
  assert.deepEqual(parsed.value, { a: "it's", b: "line\nbreak" });
});

test("规则只动结构字符：引号内的 Python 字面量与单引号一律不碰", () => {
  const text = "{\"note\": \"True and None and 'x'\", \"done\": True}";
  const parsed = parseJsonWithRepair(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { note: "True and None and 'x'", done: true });
  assert.deepEqual(parsed.applied, ["python-literals"]);
});

test("修不出来就如实失败：解析器原话 + 位置都来自**原文**", () => {
  const original = "{\"path\": Paris}";
  const parsed = parseJsonWithRepair(original);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.reason, "unparsable");
  assert.equal(parsed.error.text, original);
  assert.equal(typeof parsed.error.message, "string");
  assert.ok(parsed.error.message.length > 0);
});

test("显式 rules 覆盖默认值：只开一条时其余规则一条都不跑", () => {
  const text = "```json\n{\"a\": 1,}\n```";
  const { applied } = repairJsonText(text, { rules: ["code-fence"] });
  assert.deepEqual(applied, ["code-fence"]);
  assert.equal(parseJsonWithRepair(text, { rules: ["code-fence"] }).ok, false,
    "只剥围栏、不删尾逗号 ⇒ 仍解析不出来");
  assert.equal(parseJsonWithRepair(text).ok, true, "默认两条都开 ⇒ 能解析");
});
