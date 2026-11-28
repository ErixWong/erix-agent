// 折叠摘要的**节表**（issue #261128-05，接 #261127-18 的六节 → 四节）。
//
// 这一刀删掉 `## 教训与坑（不要重犯的）`：「踩过的坑」现在住白板（`runs.board` 的 `## 教训`）。
// 理由不是省 token，是**两种文本的时态**：白板是现在时（现在什么状态），折叠日志是过去时
// （这一折做了什么）。两边都写就是同一件事说两遍，而模型会写成两套不一致的描述
// （docs/design/2026-11-27-context-and-fold-shape.md §3.8）。
//
// 判据是**双向**的：退役节名一个不剩（否则模型仍可能照旧习惯写），当前三节按顺序齐备且各一次
// （否则「删除」会变成「悄悄多/少一节」）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SUMMARIZER_PROMPT_GUIDE } from "../../src/compact/fold-llm.js";

// 历次退役的节名。新增退役项时**追加**，不要删旧项 —— 这条判据防的是「旧名字又长回来」。
const RETIRED_SECTION_TITLES = [
  "## 阶段", // #261127-18：并进 `## 行动`
  "## 已改文件", // #261127-18：并进 `## 行动`（文件清单归 Git）
  "## 已验证项", // #261127-18：并进 `## 行动`（验证结论是行动的结果）
  "## 下一步", // #261127-18：改名 `## 遗留`
  "## 主题词面包屑", // #261127-18：改名 `## 关键词`
  "## 教训与坑", // #261128-05：住白板 `runs.board` 的 `## 教训`
];

const CURRENT_SECTION_TITLES = ["## 行动", "## 遗留", "## 关键词"];

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("#261128-05-1 退役节名一个不剩", () => {
  for (const retired of RETIRED_SECTION_TITLES) {
    assert.equal(
      SUMMARIZER_PROMPT_GUIDE.includes(retired), false,
      `退役节名必须彻底消失：${retired}`,
    );
  }
});

test("#261128-05-2 当前三节按顺序齐备，且各出现一次", () => {
  const indexes = CURRENT_SECTION_TITLES.map((title) => SUMMARIZER_PROMPT_GUIDE.indexOf(title));
  for (const [i, index] of indexes.entries()) {
    assert.notEqual(index, -1, `缺节：${CURRENT_SECTION_TITLES[i]}`);
  }
  assert.deepEqual(
    [...indexes].sort((a, b) => a - b), indexes,
    `三节顺序必须如此（实得下标 ${indexes.join(",")}）`,
  );
  // `Set` 判的是「下标互不相同」，而重复标题的 `indexOf` 是同一个下标 ⇒ 抓不到重复。
  // 逐个子串数出现次数才是「各出现一次」（copilot 复审 #980 抓到的空转点）。
  for (const title of CURRENT_SECTION_TITLES) {
    assert.equal(countOf(SUMMARIZER_PROMPT_GUIDE, title), 1, `「${title}」必须只出现一次`);
  }
});

test("#261128-05-3 三节的两条硬要求仍在（不是只剩标题）", () => {
  // 「已完成项禁止重做」：`## 遗留` 的唯一用途是把「别重做」写死；丢了它，模型会从遗留里
  // 重新开始做已经做完的事（#261127-18 的原判据，删节时不许顺手删掉）。
  assert.equal(countOf(SUMMARIZER_PROMPT_GUIDE, "已完成项禁止重做"), 1,
    "「已完成项禁止重做」必须恰出现一次（在 `## 遗留` 里）");
  // 「用原文里的字面词」：`## 关键词` 是 `recall_read` 的检索面；模型把 `recall_ask` 改写成
  // 「回忆检索」就再也搜不到了。
  assert.ok(SUMMARIZER_PROMPT_GUIDE.includes("**用原文里的字面词**"),
    "`## 关键词` 必须要求用原文里的字面词");
});

test("#261128-05-4 节表措辞只在 `src/compact/fold-llm.js` 定义（别处不许再抄一份）", () => {
  const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const hits = [];
  for (const entry of fs.readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const filePath = path.join(entry.parentPath ?? entry.path, entry.name);
    const text = fs.readFileSync(filePath, "utf8");
    for (const title of CURRENT_SECTION_TITLES) {
      if (text.includes(title)) hits.push(`${path.relative(srcRoot, filePath)}:${title}`);
    }
  }
  assert.deepEqual(
    hits.sort(),
    CURRENT_SECTION_TITLES.map((title) => `${path.join("compact", "fold-llm.js")}:${title}`).sort(),
    "节标题只许在 fold-llm.js 的引导语里定义（别处出现就是又抄了一份节表）",
  );
});

// copilot 复审（#988）：旧文件里「新节与下一段之间保留空行」「恢复提示在最后」这两条位置判据
// 没有跟着搬过来。位置不是装饰：解析器按**第一个 `##`** 切正文、按**白板行**切白板，
// 少一个空行不会坏，但「恢复提示」跑到正文中间会让 `withRecoveryHint` 的幂等检查失效
// （它靠 `summary.includes(recoveryHint)` 判「已经带过」）。
test("#261128-05-5 位置纪律：三节之后是白板段，恢复提示在最后且与前一行为空行", () => {
  const guide = SUMMARIZER_PROMPT_GUIDE;
  const lastSection = guide.indexOf("## 关键词");
  const boardLine = guide.indexOf("白板：");
  const recovery = guide.indexOf("恢复提示：");
  assert.ok(lastSection > 0 && boardLine > lastSection,
    "白板段必须在三节之后（它是整份输出的最后一段）");
  assert.ok(recovery > boardLine, "「恢复提示：」必须排在白板段之后");
  // 换行纪律：每个节标题与白板行都必须**另起一行**（节标题紧跟上文是提示词既有风格，不要求空行）；
  // 「恢复提示：」是例外 —— 它前面必须是空行，否则 `withRecoveryHint` 拼出来的那一句会粘在
  // 白板块的最后一行上，宿主侧按行读提示就分不出来了。
  for (const anchor of ["## 行动", "## 遗留", "## 关键词", "白板：", "恢复提示："]) {
    const at = guide.indexOf(anchor);
    assert.ok(at > 0, `缺「${anchor}」`);
    assert.equal(guide[at - 1], "\n", `「${anchor}」必须另起一行`);
  }
  const recoveryAt = guide.indexOf("恢复提示：");
  assert.equal(guide[recoveryAt - 2], "\n", "「恢复提示：」之前必须有一个空行");
});
