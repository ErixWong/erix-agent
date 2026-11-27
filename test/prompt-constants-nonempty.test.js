// @ts-check
// 提示词片段的**非空**判据（任务 261126-45）。
//
// 为什么需要这一格：那一轮把 15 处 `assert.match(prompt, /长中文句子/u)` 改成
// `assert.ok(prompt.includes(THE_CONSTANT))`，消除了「改文案要同时改两处」的税。
// 但 `includes("")` **恒为 true**：常量一旦被清空（或只剩空白），断言仍然绿，
// 提示词里那句话却已经没了。实测复现：把 `CLI_TOOLS_SYSTEM_PROMPT_PLAN_BULLET` 改成 `""`，
// `test/tools.test.js` 仍然 exit 0。
//
// 所以这一格补的是**被抽掉的语义下限**，而不是把文案钉回来：
// 它不关心那句话写什么，只要求「它还是一句有内容的句子」。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLI_TOOLS_SYSTEM_PROMPT_PLAN_BULLET,
  CLI_TOOLS_SYSTEM_PROMPT_SOURCE_BULLET_NO_NOTES,
  CLI_TOOLS_SYSTEM_PROMPT_SOURCE_BULLET_NOTES,
  RERUN_VALUE_DRIFT_CLAUSE,
} from "../bin/tools.js";
import { PLAN_DIRECTIVE } from "../bin/system-prompt.js";
import {
  AGGREGATE_STUB_BUDGET_PREFIX,
  ARCHIVED_HEAD,
  ARCHIVED_INFIX,
  ARCHIVED_SUFFIX,
  FINDINGS_OMISSION_CLAUSE,
  NO_RERUN_JUDGE_CLAUSE,
  NO_RERUN_RERUN_CLAUSE,
  NO_RERUN_SIDE_EFFECT_CLAUSE,
} from "../src/loop/aggregate-budget.js";
import { OMIT_UNRECORDED_CLAUSE } from "../src/loop/tool-result-ttl.js";
import { WRAPUP_INSTRUCTION } from "../src/loop/reflection.js";

/** 不是「一句话」而是整段提示词/长文档：它们有别的判据，钉非空没有意义。 */
const EXEMPT = new Set([
  "CLI_TOOLS_SYSTEM_PROMPT_SITUATION_NOTES",
  "CLI_TOOLS_SYSTEM_PROMPT_SITUATION_NO_NOTES",
  "CLI_TOOLS_SYSTEM_PROMPT_BASE_MIDDLE_HEAD",
  "CLI_TOOLS_SYSTEM_PROMPT_BASE_MIDDLE_TAIL",
  "CLI_TOOLS_SYSTEM_PROMPT_TODO_DISCIPLINE",
  "CLI_TOOLS_SYSTEM_PROMPT_BASE_TAIL_HEAD",
  "CLI_TOOLS_SYSTEM_PROMPT_BASE_TAIL_REST",
  "CLI_TOOLS_SYSTEM_PROMPT_VENDOR",
  "FINAL_DRAFT_PROMPT",
  "COMPACTION_DISABLED_WARNING",
  "SENTINEL",
  "BODY",
  "SEED_TEXT",
  "TAIL_SENTINEL_721",
  "DECLARATION_MARKER",
]);

/**
 * 每一个「被测试当作期望值引用的提示词常量」都必须在这里登记一次。
 * 新增一个这样的常量却忘了登记 ⇒ 下面第二条用例会红（用导出面反查，不是手抄名单）。
 */
const CLAUSE_CONSTANTS = Object.freeze({
  "bin/tools.js#CLI_TOOLS_SYSTEM_PROMPT_PLAN_BULLET": CLI_TOOLS_SYSTEM_PROMPT_PLAN_BULLET,
  "bin/tools.js#CLI_TOOLS_SYSTEM_PROMPT_SOURCE_BULLET_NOTES": CLI_TOOLS_SYSTEM_PROMPT_SOURCE_BULLET_NOTES,
  "bin/tools.js#CLI_TOOLS_SYSTEM_PROMPT_SOURCE_BULLET_NO_NOTES": CLI_TOOLS_SYSTEM_PROMPT_SOURCE_BULLET_NO_NOTES,
  "bin/tools.js#RERUN_VALUE_DRIFT_CLAUSE": RERUN_VALUE_DRIFT_CLAUSE,
  "bin/system-prompt.js#PLAN_DIRECTIVE": PLAN_DIRECTIVE,
  "src/loop/aggregate-budget.js#AGGREGATE_STUB_BUDGET_PREFIX": AGGREGATE_STUB_BUDGET_PREFIX,
  "src/loop/aggregate-budget.js#ARCHIVED_HEAD": ARCHIVED_HEAD,
  "src/loop/aggregate-budget.js#ARCHIVED_INFIX": ARCHIVED_INFIX,
  "src/loop/aggregate-budget.js#ARCHIVED_SUFFIX": ARCHIVED_SUFFIX,
  "src/loop/aggregate-budget.js#FINDINGS_OMISSION_CLAUSE": FINDINGS_OMISSION_CLAUSE,
  "src/loop/aggregate-budget.js#NO_RERUN_JUDGE_CLAUSE": NO_RERUN_JUDGE_CLAUSE,
  "src/loop/aggregate-budget.js#NO_RERUN_RERUN_CLAUSE": NO_RERUN_RERUN_CLAUSE,
  "src/loop/aggregate-budget.js#NO_RERUN_SIDE_EFFECT_CLAUSE": NO_RERUN_SIDE_EFFECT_CLAUSE,
  "src/loop/tool-result-ttl.js#OMIT_UNRECORDED_CLAUSE": OMIT_UNRECORDED_CLAUSE,
  "src/loop/reflection.js#WRAPUP_INSTRUCTION": WRAPUP_INSTRUCTION,
});

test("261126-45 提示词常量不许被清空：空串会让 includes() 恒真，断言变假绿", () => {
  for (const [id, value] of Object.entries(CLAUSE_CONSTANTS)) {
    assert.equal(typeof value, "string", `${id}：必须是字符串`);
    // 下限取 2：这些常量里有片段（`ARCHIVED_INFIX` = " 轮，共 "，trim 后 3 字），下限只负责
    // 排除空串与纯空白；「还是一句有内容的句子」由下面的汉字判据负责。
    assert.ok(value.trim().length >= 2, `${id} 被清空或退化成空白：${JSON.stringify(value)}`);
    // 这些句子都是中文；一个汉字都没有 ⇒ 要么被换成了英文占位，要么被改成了别的东西。
    assert.match(value, /[\u4e00-\u9fff]/u, `${id} 里一个汉字都没有：${JSON.stringify(value)}`);
  }
});

test("261126-45 断言里引用的常量必须都在上表登记（漏登记 ⇒ 那条断言的期望值没人守非空）", async () => {
  // 判据面 = **仓内测试文件里被当作期望值用的常量名**（`x.includes(CONST)` / `x.endsWith(CONST)` /
  // 模板里 `${CONST}`）。不是手抄名单，也不扫导出面（导出面里整段提示词太多，噪声大）。
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : (entry.name.endsWith(".test.js") ? [full] : []);
  });
  const registered = new Set(Object.keys(CLAUSE_CONSTANTS).map((id) => id.split("#")[1]));
  const used = new Set();
  for (const file of walk(new URL("../test", import.meta.url).pathname)) {
    const text = readFileSync(file, "utf8");
    for (const re of [/\.includes\(([A-Z][A-Z0-9_]*)\)/gu, /\.endsWith\(([A-Z][A-Z0-9_]*)\)/gu, /\$\{([A-Z][A-Z0-9_]*)\}/gu]) {
      for (const match of text.matchAll(re)) used.add(match[1]);
    }
  }
  // 判据面收窄到**本单那 6 个提示词模块的字符串导出**：其余测试里的常量（`API_KEY`、`BUDGET`…）
  // 与本单无关，扫进来只会把这条判据变成噪声。
  const promptModules = [
    "../bin/tools.js",
    "../bin/system-prompt.js",
    "../src/loop/aggregate-budget.js",
    "../src/loop/tool-result-ttl.js",
    "../src/loop/reflection.js",
  ];
  const promptExports = new Set();
  for (const specifier of promptModules) {
    const mod = await import(specifier);
    for (const [name, value] of Object.entries(mod)) {
      if (/^[A-Z][A-Z0-9_]*$/u.test(name) && typeof value === "string") promptExports.add(name);
    }
  }
  const missing = [...used]
    .filter((name) => promptExports.has(name) && !registered.has(name) && !EXEMPT.has(name))
    .sort();
  assert.deepEqual(missing, [], `这些常量被测试当作期望值，却没在本表登记非空判据：${missing.join(", ")}`);
});
