// issue #630（S1，H）——CLI 提示词与 `delegate` schema 对齐的**防漂移**测试。
//
// 现场：`DELEGATE_ACTIONS` 早就是六动作（`tail` 是 #626 C1 加的），而 `bin/tools.js` 的短语还写着
// 「action 五选一」且**根本没提 `tail`** ⇒ 模型在系统提示里发现不了那个读面，等于白装。
//
// 这里钉两件事：
//   ① 短语覆盖 `DELEGATE_ACTIONS` 里的**每一个**动作（且不多列不是动作的名字）；
//   ② 短语里那个「N 选一」的 N 与动作数一致（加动作忘了改数 ⇒ 红）。
// 判据靠一个**结构化句式**（不是关键词模糊匹配）：`action <N>选一：` 之后是 `、` 分隔的动作项，
// 每项以动作名（可用 `/` 并列）开头，整体以 `）` 收尾——`bin/tools.js` 的注释里写着这条约定。
//
// 另外钉住 A 的模型可见面：`delegate` 的 description 必须写清 `result` 带回终稿与 4000 字符上限。
import assert from "node:assert/strict";
import test from "node:test";

import { CLI_TOOL_PROMPT_PHRASES, buildCliToolsSystemPrompt } from "../bin/tools.js";
import { DELEGATE_ACTIONS, DELEGATE_DEFINITION, RESULT_TEXT_LIMIT } from "../src/tools/delegation/tool.js";

/** 中文数字：短语里的「N 选一」必须是动作数的中文写法。 */
const CN_NUMERALS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/**
 * 从短语里解析出「action N选一：…」那一段（解析不出返回 null，调用方判红）。
 * 贪婪匹配到**最后一个** `）`：动作项内部允许再嵌括号（`result 取终局并标记已取（带回…）`）。
 */
function parseActionList(phrase) {
  const m = String(phrase).match(/action\s+([一二三四五六七八九十]+)选一：([\s\S]*)）/u);
  if (m === null) return null;
  const names = m[2]
    .split("、")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    // 每项以动作名开头（`status/list` 这种并列写法一并展开）。
    .flatMap((part) => (part.split(/\s+/u)[0] ?? "").split("/"));
  return { numeral: m[1], names };
}

test("（#630 H）delegate 短语覆盖 DELEGATE_ACTIONS 的每一个动作（加动作漏改提示就红）", () => {
  const phrase = CLI_TOOL_PROMPT_PHRASES.delegate.phrase;
  const parsed = parseActionList(phrase);
  assert.ok(parsed !== null, `短语必须保留「action N选一：…）」句式（解析不出来就等于没有清单）：${phrase}`);

  assert.deepEqual(
    [...parsed.names].sort(),
    [...DELEGATE_ACTIONS].sort(),
    `短语里的动作必须与 DELEGATE_ACTIONS 逐字一致（漏一个 = 模型发现不了那个动作）：${JSON.stringify(parsed.names)}`,
  );
  // 「六选一」的六必须等于动作数：只加 schema 不改文案的漂移在这里红。
  assert.equal(
    parsed.numeral,
    CN_NUMERALS[DELEGATE_ACTIONS.length],
    `「${parsed.numeral}选一」与动作数 ${DELEGATE_ACTIONS.length} 不符（${DELEGATE_ACTIONS.join("|")}）`,
  );
});

test("（#630 H）tail 在提示词里有一句话语义（不是只把名字列上）", () => {
  const phrase = CLI_TOOL_PROMPT_PHRASES.delegate.phrase;
  const tailItem = phrase.split("、").find((part) => part.trim().startsWith("tail"));
  assert.ok(tailItem !== undefined, `短语里必须有 tail 那一项：${phrase}`);
  assert.match(tailItem, /transcript|尾部/u, `tail 那一项要说得清它读什么：${tailItem}`);
});

test("（#630 H）清单行里 delegate 那段用的是同一句短语（单一来源，没有手抄副本）", () => {
  const prompt = buildCliToolsSystemPrompt({ delegate: true });
  assert.ok(prompt.includes(CLI_TOOL_PROMPT_PHRASES.delegate.phrase), "系统提示里的 delegate 段必须逐字来自短语表");
  assert.equal(prompt.includes("五选一"), false, "「五选一」是 #630 的现场，不许回来");
});

test("（#630 A 模型可见面）delegate description 写清 result 带回终稿与字符上限", () => {
  const description = DELEGATE_DEFINITION.description;
  assert.match(description, /result/u);
  assert.ok(
    description.includes(String(RESULT_TEXT_LIMIT)),
    `description 必须点名终稿上限 ${RESULT_TEXT_LIMIT} 字符：${description}`,
  );
  assert.match(description, /truncated/u, "description 必须说清超限时带 truncated:true");
});
