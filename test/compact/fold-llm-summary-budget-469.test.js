// issue #469 宿主审计 C 片（判据 3 后半）：折叠摘要的「5 节合同」与预算/裁剪口径自洽。
//
// 三件事：
//   ① `maxSummaryTokens` 默认 800 装不下 5 节 × 150 字（实测 1,335 token）⇒ 默认上调到 1,400，
//      让合同在**默认配置**下就成立，而不是「按默认值跑只有 2 节活下来」；
//   ② 裁剪只剪正文、**保留标题**（`## 标题\n[已修剪]`）——骨架消失比内容丢失更难诊断；
//   ③ `## 主题词面包屑` 提到第 1 档（与「下一步」同级）：它是「下次按什么搜回来」的唯一线索，
//      比「已改文件」更不可重建。
//
// 零真实 LLM：策略侧假 summarizer。
import test from "node:test";
import assert from "node:assert/strict";

import { enforceSize } from "../../src/compact/enforce-size.js";
import { DEFAULT_SUMMARY_MAX_TOKENS, createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { estimateTokens } from "../../src/tokens.js";

// issue #261127-18（六节 → 四节）：夹具跟着提示词走。旧五节（阶段 / 已改文件 / 已验证项 / 下一步 /
// 主题词面包屑）已退役——用旧节名做夹具会绕开 `priorityForHeading` 的新映射（copilot 复审抓到的
// 「文档说改了、代码没改」正是这样漏掉的）。
// issue #261128-05：`## 教训与坑` 已删除（「踩过的坑」住白板 `runs.board`），剩三节。
const SECTIONS = ["行动", "遗留", "关键词"];

function summaryOf(charsPerSection) {
  return SECTIONS.map((title) => `## ${title}\n${"字".repeat(charsPerSection)}`).join("\n");
}

function conversation() {
  return [
    { role: "user", content: `R1-USER ${"x".repeat(400)}` },
    { role: "assistant", content: [{ type: "text", text: `R1-ASSISTANT ${"y".repeat(400)}` }] },
    { role: "user", content: [{ type: "text", text: "RETAINED-LIVE-MARKER" }] },
    { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
  ];
}

async function foldWith(summaryText, options = {}) {
  const strategy = createFoldLlmStrategy({
    summarizer: async () => summaryText,
    ...options,
  });
  const result = await strategy.compact(conversation(), { keepRounds: 1 });
  const text = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
  return { result, text };
}

test("#469-C ① 默认预算装得下 3 节 × 200 字 + 恢复提示 + 保真层：全在，一个 [已修剪] 都没有", async () => {
  // issue #873 修复①口径：机械保真层现在**在** `maxSummaryTokens` 之内，所以「默认预算装得下」
  // 这句话的范围从「五节」变成了「五节 + 恢复提示 + 保真层」——本夹具总量 1,386 ≤ 1,400，
  // 三层同时装得下（旧夹具的 150 字/节在旧口径下是 1,335 + 躲在预算外的保真层，不是一回事）。
  // issue #261128-05：只剩三节后 145 字/节 已装不进「旧默认 800 会被剪」这条前提（768 token），
  // 每节加长到 200 字（1,052 ≤ 1,400），前提与结论同时成立。
  const summary = summaryOf(200);
  assert.ok(estimateTokens(summary) > 800, "前提：这一份在旧默认 800 下必须会被剪");
  const { text, result } = await foldWith(summary);
  for (const title of SECTIONS) {
    assert.ok(text.includes(`## ${title}`), `默认配置下「${title}」必须还在`);
  }
  assert.equal(text.includes("[已修剪]"), false, "默认预算下不该有任何一节被剪");
  // 新增（#873 修复①）：保真层也在预算内且这里没被剪 ⇒ 默认预算真的装下了三层。
  assert.match(text, /## 用户最新未解决输入/u);
  // 上界针对**摘要本体**（`text` 含保留轮正文，不是摘要）。
  assert.ok(
    estimateTokens(result.foldSummary.text) <= DEFAULT_SUMMARY_MAX_TOKENS,
    "默认预算是整份摘要的上界",
  );
});

test("#469-C ①b 超默认预算时：机械保真层先让位（留骨架），合同节只在不够时跟着让位，整体 ≤ 预算", async () => {
  // issue #261127-18：四节比五节省 ~450 token，150 字/节 现在装得下（那正是这次改动的收益），
  // 所以这格要**真的超预算**就得把每节撑大 —— 250 字/节：四节 ≈ 1,480，超默认 1,400。
  const summary = summaryOf(250);
  const { text, result } = await foldWith(summary);
  assert.ok(
    /^## 用户最新未解决输入[^\n]*\n\[已修剪\]$/mu.test(text),
    "保真层是第 5 档（机械可重抽），超预算时必须先它让位且留标题骨架",
  );
  // 相对序：第 0 档（遗留）/ 第 1 档（关键词）必须活下来；第 2 档（行动）可以跟着让位
  // ——预算是硬上限，「合同节只在不够时跟着让位」说的就是这一档。
  for (const title of ["遗留", "关键词"]) {
    const at = text.indexOf(`## ${title}`);
    const body = text.slice(at + title.length + 3, text.indexOf("## ", at + 3));
    assert.ok(at >= 0 && !body.includes("[已修剪]"), `「${title}」比保真层优先级高，不该先被剪`);
  }
  for (const title of SECTIONS) {
    assert.ok(text.includes(`## ${title}`), `裁剪只剪正文、不删标题：${title} 的骨架必须还在`);
  }
  assert.ok(
    estimateTokens(result.foldSummary.text) <= DEFAULT_SUMMARY_MAX_TOKENS,
    "剪后摘要本体必须落在预算内",
  );
});

test("#469-C ② 裁剪保留标题：`## 标题\\n[已修剪]`，不把整节连标题抹掉", () => {
  const fields = SECTIONS.map((title, index) => ({
    key: `section-${index}`,
    text: `## ${title}\n${"字".repeat(200)}`,
    priority: title === "行动" ? 3 : index,
  }));
  const enforced = enforceSize(fields, 120);
  assert.deepEqual(enforced.prunedKeys.length > 0, true, "前提：这份输入必须真的触发裁剪");
  for (const field of enforced.fields) {
    if (!enforced.prunedKeys.includes(field.key)) continue;
    assert.match(field.text, /^## .*\n\[已修剪\]$/u, `被剪的节必须保留标题：${JSON.stringify(field.text)}`);
  }
});

test("#469-C ③ 紧预算下先保「遗留」与「关键词」，「行动」先剪且留骨架", async () => {
  const summary = summaryOf(150);
  // issue #873 修复①：保真层进了预算 ⇒ 预算必须选到「让相对优先序完整展开」的那一档。
  // issue #261128-05：只剩三节（150 字/节 合计 768），原 1000 预算已装得下全部三节
  // （没有任何一节被剪 ⇒ 这格测不到优先序）。实测定档 650：遗留/关键词活、行动被剪、保真层让位；
  // 900 起就一个都不剪了。
  const { text } = await foldWith(summary, { maxSummaryTokens: 650 });
  // 正文窗口只取到下一节标题为止（旧实现定长 400 字窗口会邻接读到邻节的 `[已修剪]`，
  // 保真层进了摘要之后那个窗口会误报）。
  const body = (title) => {
    const at = text.indexOf(`## ${title}`);
    assert.ok(at >= 0, `「${title}」的标题必须在（裁剪只剪正文、不删标题）`);
    const next = text.indexOf("## ", at + 3);
    return text.slice(at, next < 0 ? text.length : next);
  };
  assert.equal(body("遗留").includes("[已修剪]"), false, "「遗留」必须优先保（第 0 档）");
  assert.equal(body("关键词").includes("[已修剪]"), false, "「关键词」第 1 档，比「行动」先保");
  assert.equal(body("行动").includes("[已修剪]"), true, "「行动」第 2 档，应当先被剪");
  assert.match(body("行动"), /^## 行动\n\[已修剪\]/u, "剪掉也必须留标题（骨架不消失）");
  // 新增（#873 修复①）：机械保真层现在也在这个预算内，所以它必须让位（且同样留骨架）。
  assert.match(text, /^## 用户最新未解决输入[^\n]*\n\[已修剪\]$/mu, "保真层在预算内 ⇒ 紧预算下先让位");
});

// —— 默认值守护（issue #618 表 1 的「零守护」补口）——
// 双层：名字级（常量逐字相等 ⇒ 改这个数就红）+ 行为级（摘要预算确实由它决定）。
// 落点选本文件：折叠摘要的预算/裁剪夹具全在这里（summaryOf / foldWith 直接复用）。

/** 找到「估算 tokens 刚好 >= target」的最小每节字数，返回那份摘要。 */
function summaryOfAtLeast(targetTokens) {
  let chars = 5;
  while (estimateTokens(summaryOf(chars)) < targetTokens) chars += 5;
  return summaryOf(chars);
}

test("#469-C ④ 默认值守护：DEFAULT_SUMMARY_MAX_TOKENS 逐字 1_400，且超出/未超默认预算的摘要一个被剪一个不被剪", async () => {
  assert.equal(DEFAULT_SUMMARY_MAX_TOKENS, 1_400, "折叠摘要的输出预算默认值（改这个数就该有题红）");

  // 不传 maxSummaryTokens ⇒ 走默认预算。两份样本跨在默认预算两侧。
  const over = summaryOfAtLeast(DEFAULT_SUMMARY_MAX_TOKENS + 300);
  const under = summaryOfAtLeast(DEFAULT_SUMMARY_MAX_TOKENS - 300);
  assert.ok(estimateTokens(over) > DEFAULT_SUMMARY_MAX_TOKENS, "前提：over 必须超出默认预算");
  assert.ok(estimateTokens(under) < DEFAULT_SUMMARY_MAX_TOKENS, "前提：under 必须落在默认预算内");

  const overText = (await foldWith(over)).text;
  assert.equal(overText.includes("[已修剪]"), true, "超出默认预算 ⇒ 必须有节被剪（预算就是这个常量）");
  assert.ok(estimateTokens(overText) <= DEFAULT_SUMMARY_MAX_TOKENS * 1.2, "裁剪后必须落在预算量级");

  const underText = (await foldWith(under)).text;
  assert.equal(underText.includes("[已修剪]"), false, "未超默认预算 ⇒ 一节都不该被剪");
  for (const title of SECTIONS) assert.ok(underText.includes(`## ${title}`), `「${title}」必须还在`);
});
