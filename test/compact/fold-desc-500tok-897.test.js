// issue #897：description 配额从 200 字符改为 500 token（向量化单元），
// 总预算 2048→4096，超了可检测（descriptionTruncated），「本折无具体事务」不被当占位符。
//
// 五格判据：
//   1. token 配额生效：~500 token ⇒ 落账 summary 的 estimateTokens ≤ 500
//   2. 超了可检测：~800 token ⇒ 夹到 ≤500 且 descriptionTruncated: true
//   3. 不超时不出现该标记：~200 token ⇒ descriptionTruncated 键缺席
//   4. 总预算 4096 生效：description + 正文都很大 ⇒ 总字节 ≤4096 且正文 >0
//   5.「本折无具体事务」不被当占位符：summary 在场且等于它；恰好「无」⇒ descriptionMissing

import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokens } from "../../src/tokens.js";
import { parseSummarizerMeta, SUMMARIZER_DESCRIPTION_MAX_TOKENS } from "../../src/compact/fold-llm.js";
import {
  FOLDED_FACTS_MAX_BYTES,
  buildFoldedFacts,
} from "../../src/compact/fold-summary-journal.js";

const encoder = new TextEncoder();
const bytesOf = (v) => encoder.encode(String(v ?? "")).length;

/**
 * 生成一段 estimateTokens() 约等于 target 的 CJK 文本。
 * 不保证逐字精确（测试只断言 ≤ 或 > 范围），够用即可。
 */
function cjkTextApproxTokens(target) {
  // CJK: 1.5 tokens/char * 1.15 margin = 1.725 tokens/char
  const charCount = Math.ceil(target / 1.725);
  return "测".repeat(charCount);
}

/** 组装一份带标题+描述的摘要器原文。 */
function summarizerOutput(title, description) {
  return `标题：${title}\n描述：${description}\n## 阶段\n正文内容\n`;
}

// ---------- 格 1：token 配额生效 ----------

test("#897-1 token 配额生效：~500 token 的 description 落账后 estimateTokens ≤ 500", () => {
  const desc = cjkTextApproxTokens(SUMMARIZER_DESCRIPTION_MAX_TOKENS);
  const descTokens = estimateTokens(desc);
  // 前置：确认真的接近 500 token（允许上下浮动）
  assert.ok(descTokens >= 400, `前置：测试夹具 token 数应接近 500，实测 ${descTokens}`);
  assert.ok(descTokens <= 600, `前置：测试夹具 token 数应接近 500，实测 ${descTokens}`);

  const input = summarizerOutput("测试标题", desc);
  const meta = parseSummarizerMeta(input);

  assert.ok(meta.description !== undefined, "description 应被解析出来");
  const resultTokens = estimateTokens(meta.description);
  assert.ok(resultTokens <= SUMMARIZER_DESCRIPTION_MAX_TOKENS,
    `落账 description 的 estimateTokens 应 ≤ ${SUMMARIZER_DESCRIPTION_MAX_TOKENS}，实测 ${resultTokens}`);
});

// ---------- 格 2：超了可检测 ----------

test("#897-2 超了可检测：~800 token 被夹到 ≤500 且 descriptionTruncated: true 在场", () => {
  const desc = cjkTextApproxTokens(800);
  const descTokens = estimateTokens(desc);
  assert.ok(descTokens > SUMMARIZER_DESCRIPTION_MAX_TOKENS,
    `前置：输入 token 数应超过 ${SUMMARIZER_DESCRIPTION_MAX_TOKENS}，实测 ${descTokens}`);

  const input = summarizerOutput("测试标题", desc);
  const meta = parseSummarizerMeta(input);

  assert.ok(meta.description !== undefined, "description 应被解析出来");
  const resultTokens = estimateTokens(meta.description);
  assert.ok(resultTokens <= SUMMARIZER_DESCRIPTION_MAX_TOKENS,
    `夹断后 estimateTokens 应 ≤ ${SUMMARIZER_DESCRIPTION_MAX_TOKENS}，实测 ${resultTokens}`);
  assert.equal(meta.descriptionTruncated, true,
    "descriptionTruncated 必须为 true（真夹断了）");
});

// ---------- 格 3：不超时不出现该标记 ----------

test("#897-3 不超时不出现 descriptionTruncated：~200 token 时该键缺席", () => {
  const desc = cjkTextApproxTokens(200);
  const descTokens = estimateTokens(desc);
  assert.ok(descTokens <= SUMMARIZER_DESCRIPTION_MAX_TOKENS,
    `前置：输入 token 数应 ≤ ${SUMMARIZER_DESCRIPTION_MAX_TOKENS}，实测 ${descTokens}`);

  const input = summarizerOutput("测试标题", desc);
  const meta = parseSummarizerMeta(input);

  assert.ok(meta.description !== undefined, "description 应被解析出来");
  assert.ok(!("descriptionTruncated" in meta),
    "descriptionTruncated 键不应出现（没被夹断）");

  // 与格 2 的落账形状不等（deepStrictEqual 对照）：
  const desc2 = cjkTextApproxTokens(800);
  const meta2 = parseSummarizerMeta(summarizerOutput("测试标题", desc2));
  // meta 没有 descriptionTruncated，meta2 有
  assert.notDeepEqual(
    Object.keys(meta).sort(),
    Object.keys(meta2).sort(),
    "格 2 和格 3 的落账键形状必须不同",
  );
});

// ---------- 格 4：总预算 4096 生效 ----------

test("#897-4 总预算 4096 生效：description + 正文都很大 ⇒ 总字节 ≤4096 且正文 >0", () => {
  // description 接近 500 token CJK ≈ ~1000 bytes
  const desc = cjkTextApproxTokens(480);
  const descBytes = bytesOf(desc);
  // 正文 3000 ASCII 字符（远小于 4096 - descBytes）
  const body = "A".repeat(3000);

  const facts = buildFoldedFacts({
    text: body,
    summary: desc,
    source: "llm",
    strategy: "llm",
    origin: "semantic",
  });

  assert.ok(facts !== undefined, "应产出 foldedFacts");
  assert.ok(facts.bytes <= FOLDED_FACTS_MAX_BYTES,
    `总字节应 ≤ ${FOLDED_FACTS_MAX_BYTES}，实测 ${facts.bytes}`);
  assert.equal(FOLDED_FACTS_MAX_BYTES, 4096, "FOLDED_FACTS_MAX_BYTES 应为 4096");
  // 正文没被挤没：text 长度 > 0
  assert.ok(facts.text.length > 0, "正文长度应 > 0（description 先占后仍有空间给正文）");
  // summary 在场
  assert.ok(facts.summary !== undefined && facts.summary.length > 0,
    "description 应落进 summary 键");
});

// ---------- 格 5：「本折无具体事务」不被当占位符 ----------

test("#897-5「本折无具体事务」不被当占位符：description 在场且等于它", () => {
  const desc = "本折无具体事务";
  const input = summarizerOutput("讨论型折叠", desc);
  const meta = parseSummarizerMeta(input);

  assert.ok(meta.description !== undefined,
    "「本折无具体事务」不应被当占位符拒掉");
  assert.equal(meta.description, desc,
    "description 应逐字等于「本折无具体事务」");

  // 对照：恰好 "无" 应被拒（descriptionMissing）
  const inputWu = summarizerOutput("讨论型折叠", "无");
  const metaWu = parseSummarizerMeta(inputWu);
  assert.ok(metaWu.description === undefined,
    "恰好「无」应被当占位符拒掉");
  assert.equal(metaWu.descriptionMissing, "empty-or-placeholder",
    "恰好「无」应给出 descriptionMissing: empty-or-placeholder");
});
