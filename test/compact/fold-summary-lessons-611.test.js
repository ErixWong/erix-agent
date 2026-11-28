// issue #611：折叠摘要器增加「教训与坑」一节 —— 经验优先于细节。
//
// 判据 1–4 全离线（无真实 LLM、无 provider）：只读 `SUMMARIZER_PROMPT_GUIDE` /
// `createSummarizerPromptGuide()`。判据 4 是同一组 checker 上的**反向证**：
// 把新节挪到「主题词面包屑」之前 ⇒ 判据 1 红；删掉「已完成项禁止重做」⇒ 判据 2 红。
// 两个变异都从**出厂常量**的真实文本出发，且先断言变异真的生效，避免反向证空转。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSummarizerPromptGuide,
  SUMMARIZER_PROMPT_GUIDE,
} from "../../src/compact/fold-llm.js";

const LESSONS_TITLE = "## 教训与坑（不要重犯的）";
const LESSONS_BODY = [
  "记录被折轮次里出现过的：①试过但失败或代价高的做法（含为什么失败）；②不可违反的约束；③已确认的坑。",
  "只写原文里确实出现过的，不要推测、不要补充；没有就写「无」。",
];
const LESSONS_BLOCK = [LESSONS_TITLE, ...LESSONS_BODY].join("\n");
// 三条要求各自的可核对片段（①②③ + 「没有就写无」）。
const LESSONS_CLAUSES = [
  "①试过但失败或代价高的做法（含为什么失败）",
  "②不可违反的约束",
  "③已确认的坑",
  "只写原文里确实出现过的",
  "没有就写「无」",
];

// issue #261127-18：六节 → 四节后，原来的「主题词面包屑」改名「关键词」（位置仍是「教训与坑」的锚点：
// 新节必须排在它之后）。正文另加一句「用原文里的字面词」——面包屑的唯一用途是**按字面** grep 回原文，
// 模型把 `recall_ask` 改写成「回忆检索」就再也搜不到了。
const CRUMBS_TITLE = "## 关键词";
const CRUMBS_BODY = "列出后续检索原文所需的项目、文件、工具、错误和未结事项关键词。**用原文里的字面词**（文件名、工具名、报错原文、标识符），不要改写成同义词。";
const RECOVERY_LABEL = "恢复提示：";
const NO_REDO = "已完成项禁止重做";

// issue #261127-18（六节 → 四节）：`## 阶段` / `## 已改文件` / `## 已验证项` 三节合并成 `## 行动`
// （三节都在答「这一折做了什么」，分开写就是同一件事说三遍）；`## 下一步` 改名 `## 遗留`；
// `## 主题词面包屑` 改名 `## 关键词`（见上）；`## 教训与坑` 原样保留。
// 下面两张表钉住**改后**的四节：标题 + 正文逐字相邻、顺序升序。
const EXISTING_SECTIONS = [
  ["## 行动", "实际做了什么、结果如何。**验证结论写在这里**（跑了什么测试 / 检查、结论是什么），不另开一节。\n改到哪些文件就在句子里点出文件名（**不列清单**——Git 才是文件清单的权威）。"],
  ["## 遗留", '只列出尚未完成的动作，并明确写出"已完成项禁止重做"。若这一折只是讨论/设想/没有可执行事务，写「本折无具体事务」，不要编造待办。'],
  [CRUMBS_TITLE, CRUMBS_BODY],
];

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// 判据 1 的 checker：新节在场 + 三条要求在场 + **位置**在「主题词面包屑」之后、「恢复提示」之前。
// 返回问题清单（空数组 = 绿），判据 4 拿同一个函数去判变异体。
function lessonsSectionProblems(guide) {
  const problems = [];
  for (const line of [LESSONS_TITLE, ...LESSONS_BODY]) {
    if (!guide.includes(line)) problems.push(`缺少新节内容：${line.slice(0, 16)}…`);
  }
  for (const clause of LESSONS_CLAUSES) {
    if (!guide.includes(clause)) problems.push(`缺少要求：${clause}`);
  }
  if (countOf(guide, LESSONS_TITLE) > 1) problems.push("新节标题出现了不止一次");
  const lessonsIndex = guide.indexOf(LESSONS_TITLE);
  const crumbsIndex = guide.indexOf(CRUMBS_TITLE);
  const recoveryIndex = guide.indexOf(RECOVERY_LABEL);
  if (crumbsIndex === -1) problems.push("缺少「主题词面包屑」");
  if (recoveryIndex === -1) problems.push(`缺少「${RECOVERY_LABEL}」`);
  if (lessonsIndex !== -1 && crumbsIndex !== -1 && lessonsIndex < crumbsIndex) {
    problems.push("新节在「主题词面包屑」之前（必须在它之后）");
  }
  if (lessonsIndex !== -1 && recoveryIndex !== -1 && lessonsIndex > recoveryIndex) {
    problems.push("新节在「恢复提示」之后（必须在它之前）");
  }
  return problems;
}

// 判据 2 的 checker：既有五节「标题 + 正文」逐字相邻、标题顺序升序、`已完成项禁止重做` 逐字仍在。
// 只看这五节自身，不看新节位置 —— 于是判据 4 的变异 A 只会打红判据 1 那一格。
function existingSectionsProblems(guide) {
  const problems = [];
  let previousIndex = -1;
  for (const [title, body] of EXISTING_SECTIONS) {
    if (!guide.includes(`${title}\n${body}`)) {
      problems.push(`「${title}」的标题/正文不再逐字相邻`);
      continue;
    }
    const index = guide.indexOf(title);
    if (index < previousIndex) problems.push(`「${title}」的顺序被改动`);
    previousIndex = index;
  }
  // #261127-18：`已完成项禁止重做` 从标题括注挪进正文（标题就是 `## 遗留`），所以只要求出现 1 次。
  // 这一格仍在防「删掉那句话」：判据 4B 把整串删掉 ⇒ 这里必红。
  const noRedoCount = countOf(guide, NO_REDO);
  if (noRedoCount < 1) {
    problems.push(`「${NO_REDO}」一次都没出现（它必须在「## 遗留」的正文里），实测 ${noRedoCount} 次`);
  }
  return problems;
}

function assertGreen(problems, label) {
  assert.deepEqual(problems, [], `${label} 应当绿，实际红：${problems.join(" | ")}`);
}

test("#611 判据 1：新节在场、三条要求在场，且位置在「主题词面包屑」之后、「恢复提示」之前", () => {
  assertGreen(lessonsSectionProblems(SUMMARIZER_PROMPT_GUIDE), "判据 1");
  // 位置用 index 比较，不是「只查包含」：三种片段的相对次序都要成立。
  const lessonsIndex = SUMMARIZER_PROMPT_GUIDE.indexOf(LESSONS_TITLE);
  const crumbsIndex = SUMMARIZER_PROMPT_GUIDE.indexOf(CRUMBS_TITLE);
  const recoveryIndex = SUMMARIZER_PROMPT_GUIDE.indexOf(RECOVERY_LABEL);
  assert.ok(crumbsIndex < lessonsIndex, "主题词面包屑 < 教训与坑");
  assert.ok(lessonsIndex < recoveryIndex, "教训与坑 < 恢复提示");
  // 紧贴「主题词面包屑」正文之后（五节之后立刻是新节），且与「恢复提示」之间保留空行。
  assert.ok(
    SUMMARIZER_PROMPT_GUIDE.includes(`${CRUMBS_TITLE}\n${CRUMBS_BODY}\n${LESSONS_BLOCK}`),
    "新节必须紧跟在「主题词面包屑」正文之后（五节之后立刻是新节）",
  );
  // 261128（白板第一刀）：`教训与坑` 之后现在还有**白板块**（整份输出的最后一段），
  // 所以「紧接恢复提示」这条改成「后面确实跟一个空行」——空行纪律不变，中间多不多一段白板由
  // `test/compact/fold-board-261128.test.js` 管。
  assert.ok(
    SUMMARIZER_PROMPT_GUIDE.includes(`${LESSONS_BODY.at(-1)}\n\n`),
    "新节之后必须保留空行",
  );
  assert.ok(
    SUMMARIZER_PROMPT_GUIDE.indexOf(RECOVERY_LABEL) > SUMMARIZER_PROMPT_GUIDE.indexOf(LESSONS_BODY.at(-1)),
    "「恢复提示：」必须在「教训与坑」之后",
  );
});

test("#611 判据 2：既有五节的标题/正文/顺序逐字仍在，`已完成项禁止重做` 逐字仍在", () => {
  assertGreen(existingSectionsProblems(SUMMARIZER_PROMPT_GUIDE), "判据 2");
  assert.ok(
    !SUMMARIZER_PROMPT_GUIDE.includes("## 下一步"),
    "旧节名 `## 下一步` 必须彻底消失（#261127-18 改名 `## 遗留`）",
  );
  assert.ok(
    SUMMARIZER_PROMPT_GUIDE.includes(`并明确写出"${NO_REDO}"。`),
    "正文里那句「并明确写出…」必须逐字保留",
  );
  // 顺序是判据 2 自己的事（与「新节在哪」无关）：五个标题的下标必须升序。
  const titleIndexes = EXISTING_SECTIONS.map(([title]) => SUMMARIZER_PROMPT_GUIDE.indexOf(title));
  assert.deepEqual([...titleIndexes].sort((a, b) => a - b), titleIndexes, "五节顺序必须保持原样");
  assert.equal(new Set(titleIndexes).size, titleIndexes.length, "五个标题各出现一次");
});

test("#611 判据 3：自定义 recoveryHint 仍被插进「恢复提示：」那一行（没被新节挤掉）", () => {
  assert.equal(createSummarizerPromptGuide(), SUMMARIZER_PROMPT_GUIDE, "无参调用必须等于出厂常量");
  const hint = "自定义恢复提示";
  const guide = createSummarizerPromptGuide(hint);
  const lines = guide.split("\n");
  const recoveryLineIndex = lines.findIndex((line) => line.startsWith(RECOVERY_LABEL));
  assert.notEqual(recoveryLineIndex, -1, "必须有「恢复提示：」行");
  assert.equal(lines[recoveryLineIndex], `${RECOVERY_LABEL}${hint}`, "hint 必须整行落在「恢复提示：」之后");
  // 除了那一行，自定义 hint 版与出厂常量逐字相同（新节没有被换掉/丢行）。
  const defaultRecoveryLine = SUMMARIZER_PROMPT_GUIDE
    .split("\n")
    .find((line) => line.startsWith(RECOVERY_LABEL));
  assert.equal(
    guide,
    SUMMARIZER_PROMPT_GUIDE.replace(defaultRecoveryLine, `${RECOVERY_LABEL}${hint}`),
  );
  assert.ok(guide.indexOf(LESSONS_TITLE) < guide.indexOf(`${RECOVERY_LABEL}${hint}`));
  assert.ok(guide.includes("历史工具结果留痕规则："), "尾部留痕规则仍在");
});

test("#611 措辞只在一处定义：`教训与坑` 在 src/ 里只出现在 fold-llm.js 的引导语里", () => {
  const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const hits = [];
  for (const entry of fs.readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const filePath = path.join(entry.parentPath ?? entry.path, entry.name);
    const text = fs.readFileSync(filePath, "utf8");
    if (text.includes("教训与坑")) hits.push(path.relative(srcRoot, filePath));
  }
  assert.deepEqual(hits, [path.join("compact", "fold-llm.js")], "新节措辞只许在 createSummarizerPromptGuide 里定义");
});

// ── 判据 4：反向证 ───────────────────────────────────────────────────────────

// 变异 A：把新节整块挪到「主题词面包屑」之前（五节自身逐字不动）。
function moveLessonsBeforeCrumbs(guide) {
  const crumbsBlock = `${CRUMBS_TITLE}\n${CRUMBS_BODY}`;
  const original = `${crumbsBlock}\n${LESSONS_BLOCK}`;
  assert.ok(guide.includes(original), "前提：新节紧跟「主题词面包屑」");
  const mutated = guide.replace(original, `${LESSONS_BLOCK}\n${crumbsBlock}`);
  assert.notEqual(mutated, guide, "前提：变异 A 必须真的生效");
  assert.ok(
    mutated.indexOf(LESSONS_TITLE) < mutated.indexOf(CRUMBS_TITLE),
    "前提：变异 A 之后新节确实跑到「主题词面包屑」之前",
  );
  return mutated;
}

// 变异 B：删掉「已完成项禁止重做」（标题括注与正文那句一起删）。
function dropNoRedo(guide) {
  const mutated = guide.split(NO_REDO).join("");
  assert.notEqual(mutated, guide, "前提：变异 B 必须真的生效");
  assert.equal(countOf(mutated, NO_REDO), 0, "前提：变异 B 之后该句一次都不剩");
  return mutated;
}

test("#611 判据 4A：新节挪到「主题词面包屑」之前 ⇒ 判据 1 必须红（判据 2 不变）", () => {
  // 反向证的基线：出厂常量上的判据 1 必须先绿，否则这个变异证明不了任何事。
  assertGreen(lessonsSectionProblems(SUMMARIZER_PROMPT_GUIDE), "反向证基线（判据 1）");
  const mutated = moveLessonsBeforeCrumbs(SUMMARIZER_PROMPT_GUIDE);
  const problems = lessonsSectionProblems(mutated);
  assert.ok(problems.length > 0, "判据 1 必须红");
  assert.match(problems.join(" | "), /在「主题词面包屑」之前/u);
  // 差异式：判据 2 的判定结果**一格都没动**（变异只打在判据 1 那一格上）。
  assert.deepEqual(
    existingSectionsProblems(mutated),
    existingSectionsProblems(SUMMARIZER_PROMPT_GUIDE),
    "变异 A 不许影响判据 2",
  );
});

test("#611 判据 4B：删掉「已完成项禁止重做」⇒ 判据 2 必须红（判据 1 不变）", () => {
  assertGreen(existingSectionsProblems(SUMMARIZER_PROMPT_GUIDE), "反向证基线（判据 2）");
  const mutated = dropNoRedo(SUMMARIZER_PROMPT_GUIDE);
  const problems = existingSectionsProblems(mutated);
  assert.ok(problems.length > 0, "判据 2 必须红");
  assert.match(problems.join(" | "), /已完成项禁止重做/u);
  assert.deepEqual(
    lessonsSectionProblems(mutated),
    lessonsSectionProblems(SUMMARIZER_PROMPT_GUIDE),
    "变异 B 不许影响判据 1",
  );
});

test("#611 判据 4C：把新节整块删掉 ⇒ 判据 1 必须红（判据 2 不变）", () => {
  assertGreen(lessonsSectionProblems(SUMMARIZER_PROMPT_GUIDE), "反向证基线（判据 1）");
  const mutated = SUMMARIZER_PROMPT_GUIDE.replace(`${LESSONS_BLOCK}\n`, "");
  assert.notEqual(mutated, SUMMARIZER_PROMPT_GUIDE, "前提：删节必须真的生效");
  const problems = lessonsSectionProblems(mutated);
  assert.ok(problems.length > 0, "判据 1 必须红");
  assert.deepEqual(
    existingSectionsProblems(mutated),
    existingSectionsProblems(SUMMARIZER_PROMPT_GUIDE),
    "删节不许影响判据 2",
  );
});

// ── issue #261127-18：六节 → 四节 ──────────────────────────────────
// 判据是**双向**的：旧节名必须一个不剩（否则模型仍可能照着旧习惯写两遍同一件事），
// 新四节必须按顺序齐备（否则「合并」会变成「悄悄少一节」）。
const RETIRED_SECTION_TITLES = ["## 阶段", "## 已改文件", "## 已验证项", "## 下一步", "## 主题词面包屑"];
const CURRENT_SECTION_TITLES = ["## 行动", "## 遗留", "## 关键词", "## 教训与坑（不要重犯的）"];

test("#261127-18-1 旧节名一个不剩（六节 → 四节）", () => {
  for (const retired of RETIRED_SECTION_TITLES) {
    assert.equal(
      SUMMARIZER_PROMPT_GUIDE.includes(retired), false,
      `旧节名必须彻底消失：${retired}`,
    );
  }
});

test("#261127-18-2 新四节按顺序齐备（行动 → 遗留 → 关键词 → 教训与坑）", () => {
  const indexes = CURRENT_SECTION_TITLES.map((title) => SUMMARIZER_PROMPT_GUIDE.indexOf(title));
  for (const [i, index] of indexes.entries()) {
    assert.notEqual(index, -1, `缺新节：${CURRENT_SECTION_TITLES[i]}`);
  }
  assert.deepEqual(
    [...indexes].sort((a, b) => a - b), indexes,
    `四节顺序必须如此（实得下标 ${indexes.join(",")}）`,
  );
  // copilot 复审：`Set` 判的是「下标互不相同」，而重复标题的 `indexOf` 是同一个下标 ⇒ 抓不到重复。
  // 逐个子串数出现次数才是「各出现一次」。
  for (const title of CURRENT_SECTION_TITLES) {
    assert.equal(countOf(SUMMARIZER_PROMPT_GUIDE, title), 1, `「${title}」必须只出现一次`);
  }
});
