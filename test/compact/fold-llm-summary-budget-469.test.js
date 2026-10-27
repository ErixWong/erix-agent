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
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { estimateTokens } from "../../src/tokens.js";

const SECTIONS = ["阶段", "已改文件", "已验证项", "下一步", "主题词面包屑"];

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

test("#469-C ① 默认预算装得下 5 节 × 150 字：五节全在，一个 [已修剪] 都没有", async () => {
  const summary = summaryOf(150);
  assert.ok(estimateTokens(summary) > 800, "前提：这一份在旧默认 800 下必须会被剪");
  const { text } = await foldWith(summary);
  for (const title of SECTIONS) {
    assert.ok(text.includes(`## ${title}`), `默认配置下「${title}」必须还在`);
  }
  assert.equal(text.includes("[已修剪]"), false, "默认预算下不该有任何一节被剪");
});

test("#469-C ② 裁剪保留标题：`## 标题\\n[已修剪]`，不把整节连标题抹掉", () => {
  const fields = SECTIONS.map((title, index) => ({
    key: `section-${index}`,
    text: `## ${title}\n${"字".repeat(200)}`,
    priority: title === "已改文件" ? 3 : index,
  }));
  const enforced = enforceSize(fields, 120);
  assert.deepEqual(enforced.prunedKeys.length > 0, true, "前提：这份输入必须真的触发裁剪");
  for (const field of enforced.fields) {
    if (!enforced.prunedKeys.includes(field.key)) continue;
    assert.match(field.text, /^## .*\n\[已修剪\]$/u, `被剪的节必须保留标题：${JSON.stringify(field.text)}`);
  }
});

test("#469-C ③ 紧预算下先保「下一步」与「主题词」，「已改文件」先剪且留骨架", async () => {
  const summary = summaryOf(150);
  const { text } = await foldWith(summary, { maxSummaryTokens: 900 });
  const body = (title) => text.slice(text.indexOf(`## ${title}`), text.indexOf(`## ${title}`) + 400);
  assert.equal(body("下一步").includes("[已修剪]"), false, "「下一步」必须优先保");
  assert.equal(body("主题词面包屑").includes("[已修剪]"), false, "「主题词面包屑」必须与「下一步」同档");
  assert.equal(body("已改文件").includes("[已修剪]"), true, "「已改文件」应当先被剪");
  assert.match(body("已改文件"), /^## 已改文件\n\[已修剪\]/u, "剪掉也必须留标题（骨架不消失）");
});
