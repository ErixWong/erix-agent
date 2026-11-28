import test from "node:test";
import assert from "node:assert/strict";

import {
  createFoldLlmStrategy,
  SUMMARIZER_PROMPT_GUIDE,
} from "../../src/compact/fold-llm.js";
import { estimateMessageTokens, estimateTokens } from "../../src/tokens.js";

function conversation() {
  return [
    { role: "user", content: "initial request" },
    { role: "assistant", content: [{ type: "text", text: "phase one" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [{ type: "text", text: "phase two" }] },
    { role: "user", content: [{ type: "text", text: "continue again" }] },
    { role: "assistant", content: [{ type: "text", text: "phase three" }] },
  ];
}

test("folds old rounds through the injected summarizer and preserves the payload", async () => {
  const calls = [];
  const summary = [
    "## 阶段",
    "完成初始化。",
    "## 已改文件",
    "src/example.js",
    "## 已验证项",
    "node --test",
    "## 下一步",
    "已完成项禁止重做；继续收尾。",
    "## 主题词面包屑",
    "example, tests",
  ].join("\n");
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      calls.push(input);
      return summary;
    },
  });
  const messages = conversation();
  const result = await strategy.compact(messages, { keepRounds: 1 });

  assert.equal(strategy.name, "fold-llm");
  assert.deepEqual(calls[0].messages, messages.slice(1, 5));
  assert.deepEqual(calls[0].roundRange, { from: 1, to: 4 });
  // issue #741：直接调策略 ⇒ 引擎拿不到笔记证据 ⇒ 默认广告语是**显式未知**那一句（不再是「查看持久笔记」）。
  assert.equal(calls[0].recoveryHint, "需要原文请重读文件；无可复原的决策记录（原因：无笔记证据）");
  assert.deepEqual(result.foldedPayload, messages.slice(1, 5));
  assert.equal(result.foldedRounds, 4);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(result.messages[0].content[0].text, new RegExp(summary));
  assert.match(result.messages[0].content[0].text, /需要原文请重读文件；无可复原的决策记录（原因：无笔记证据）/);
  assert.equal(result.tokensBefore, estimateMessageTokens(messages));
  assert.equal(result.tokensAfter, estimateMessageTokens(result.messages));
});

test("uses section priorities when enforcing the summary budget", async () => {
  const summary = [
    "## 阶段",
    "phase ".repeat(60),
    "## 已改文件",
    "files ".repeat(60),
    "## 主题词面包屑",
    "topics ".repeat(60),
    "## 已验证项",
    "verified ".repeat(60),
    "## 下一步",
    "next steps and 已完成项禁止重做 ".repeat(60),
  ].join("\n");
  const result = await createFoldLlmStrategy({
    summarizer: async () => summary,
    maxSummaryTokens: 1500,
  }).compact(conversation(), { keepRounds: 1 });
  const foldedSummary = result.messages[0].content[0].text;
  const [llmPart] = foldedSummary.split("## 用户最新未解决输入");

  assert.match(foldedSummary, /## 已验证项/);
  assert.match(foldedSummary, /## 下一步/);
  assert.match(foldedSummary, /已完成项禁止重做/);
  assert.match(foldedSummary, /\[已修剪\]/);
  // issue #873 修复①：机械保真层现在**在** `maxSummaryTokens` 之内（旧行为：追加在夹断之后，
  // 预算削不掉它）⇒ 上界是**整份**摘要，不只是一段。这条从「llmPart ≤ 1500」收紧成「全体 ≤ 1500」。
  assert.ok(estimateTokens(foldedSummary) <= 1500);
  assert.ok(estimateTokens(llmPart) <= 1500);
  // 预算紧时先让位的是机械保真层（第 5 档，机械可重抽），而不是任何一节合同（留骨架）。
  assert.match(foldedSummary, /^## 用户最新未解决输入[^\n]*\n\[已修剪\]$/mu);
  assert.doesNotMatch(foldedSummary, /^> continue again$/m);
});

test("token truncates an unsectioned summary and marks the truncation", async () => {
  const summary = "unsectioned summary ".repeat(200);
  const maxSummaryTokens = 30;
  const result = await createFoldLlmStrategy({
    summarizer: async () => summary,
    maxSummaryTokens,
  }).compact(conversation(), { keepRounds: 1 });
  const text = result.messages[0].content[0].text;
  const [llmPart] = text.split("## 用户最新未解决输入");

  assert.match(llmPart, /截断|修剪/);
  assert.ok(estimateTokens(llmPart) <= maxSummaryTokens);
  // issue #873 修复①：保真层现在在尺寸截断**之前**拼入，整份摘要（含它）受同一个预算约束
  // ⇒ 预算只有 30 token 时它保不住（旧断言「逐字引用仍在」钉的正是「躲在预算外」这个 bug）。
  assert.ok(estimateTokens(text) <= maxSummaryTokens, "整份摘要（含保真层）必须 ≤ 声明预算");
  assert.doesNotMatch(text, /^> continue again$/m);
});

test("publishes note-first recovery guidance requirements", () => {
  // issue #261127-18（六节 → 四节）：`## 阶段` / `## 已改文件` / `## 已验证项` 合成 `## 行动`，
  // `## 下一步` → `## 遗留`，`## 主题词面包屑` → `## 关键词`。逐节判据见
  // test/compact/fold-summary-lessons-611.test.js（那里还钉着「旧节名一个不剩」）。
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 行动/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 遗留/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /已完成项禁止重做/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 关键词/);
  // issue #261128-05：`## 教训与坑` 已删除 —— 「踩过的坑」住白板（`runs.board` 的 `## 教训`），
  // 白板是现在时、摘要日志是过去时，两边都写就是同一件事说两遍（docs/design/2026-11-27-context-and-fold-shape.md §3.8）。
  // 逐节判据见 test/compact/fold-summary-sections-261128.test.js。
  assert.doesNotMatch(SUMMARIZER_PROMPT_GUIDE, /教训与坑/);
  // issue #741：提示分两种口径 —— 无证据时（默认那份）不得宣称「查看持久笔记」，
  // 有证据时（宿主/引擎给出证据后解析出的那一句）才给 note_* 这条路。
  assert.match(SUMMARIZER_PROMPT_GUIDE, /需要原文请重读文件；无可复原的决策记录（原因：无笔记证据）/);
  assert.doesNotMatch(SUMMARIZER_PROMPT_GUIDE, /查看持久笔记/);
});

test("includes an injected recovery hint in the LLM summary", async () => {
  const hint = "恢复提示：请查看 durable-notes.md";
  const result = await createFoldLlmStrategy({
    recoveryHint: hint,
    summarizer: async ({ promptGuide, recoveryHint }) => {
      assert.match(promptGuide, new RegExp(hint));
      assert.equal(recoveryHint, hint);
      return "## 阶段\n完成工作。";
    },
  }).compact(conversation(), { keepRounds: 1 });

  assert.match(result.messages[0].content[0].text, new RegExp(hint));
});

test("does not call the summarizer when every round is retained", async () => {
  let calls = 0;
  const messages = conversation();
  const result = await createFoldLlmStrategy({
    summarizer: async () => {
      calls += 1;
      return "unexpected";
    },
  }).compact(messages, { keepRounds: 10 });

  assert.equal(calls, 0);
  assert.equal(result.compacted, false);
  assert.deepEqual(result.foldedPayload, []);
  assert.deepEqual(result.messages, messages);
});

function anchorConversation() {
  return [
    { role: "user", content: "initial request" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "git log -1" } }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "1ed3f35 fix src/compact/fold-llm.js:120 (#32) "
          + "https://git.erix.vip/eric/erix-llm-kit/commit/1ed3f35",
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "folded phase" }] },
    { role: "user", content: "取消旧方案，改做锚点索引" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "final request" },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ];
}

test("appends the mechanical fidelity layer after the LLM summary" + " (verbatim user input / reverse signal)", async () => {
  const messages = anchorConversation();
  const paraphrased = [
    "## 阶段",
    "早期工作已完成（提交了某个 commit）。",
    "## 下一步",
    "已完成项禁止重做；继续收尾。",
  ].join("\n");
  const result = await createFoldLlmStrategy({
    summarizer: async () => paraphrased,
  }).compact(messages, { keepRounds: 2 });
  const text = result.messages[0].content[0].text;

  // LLM 复述必然丢失精确值（SHA → "某个 commit"）；逐字引用把被折轮次的原文兜回来。
  assert.match(text, /提交了某个 commit/);
  // 反向锁：折叠摘要不再出现机械锚点节（锚点索引已退役）。
  assert.doesNotMatch(text, /## 锚点索引/u);
  assert.doesNotMatch(text, /^shas: 1ed3f35$/m);
  assert.doesNotMatch(text, /^paths: src\/compact\/fold-llm\.js:120$/m);
  assert.doesNotMatch(text, /^urls: https:\/\/git\.erix\.vip/m);
  // 逐字引用被折轮次里最后一条真实 user 消息，并标注反向信号。
  assert.match(text, /## 用户最新未解决输入（逐字引用，未经 LLM 改写）/);
  assert.match(text, /⚠ 用户曾发出中止\/撤销信号（命中：取消）/);
  assert.match(text, /^> 取消旧方案，改做锚点索引$/m);
  // 保真层整体追加在 LLM 摘要之后。
  assert.ok(text.indexOf(paraphrased) < text.indexOf("## 用户最新未解决输入"));
  assert.ok(text.trimEnd().endsWith("> 取消旧方案，改做锚点索引"));
  // 引用的是"被折轮次里"最后一条真实 user 消息；仍在上下文里的最新 user 输入不重复注入。
  assert.doesNotMatch(text, /^> final request$/m);
  assert.equal(result.foldedRounds, 4);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
});

test("keeps the fidelity layer inside the summary budget when it is tiny (issue #873 fix ①)", async () => {
  const result = await createFoldLlmStrategy({
    summarizer: async () => "unsectioned summary ".repeat(200),
    maxSummaryTokens: 40,
  }).compact(anchorConversation(), { keepRounds: 2 });
  const text = result.messages[0].content[0].text;

  // 旧断言：预算 40 时锚点行与逐字引用仍然全文在场（因为它们躲在预算外）。
  // 新语义（#873 修复①）：保真层先拼、尺寸后管 ⇒ 40 token 的预算就是硬上界，它装不下时
  // 必须被夹断，但夹断必须是**显式**的（截断标记），不能是静默丢内容。
  assert.ok(estimateTokens(text) <= 40, `整份摘要必须 ≤ 声明预算（实测 ${estimateTokens(text)}）`);
  assert.match(text, /截断|修剪/);
  assert.doesNotMatch(text, /^shas: 1ed3f35$/m);
  assert.doesNotMatch(text, /^> 取消旧方案，改做锚点索引$/m);
});

test("adds no mechanical section when the folded payload has nothing to extract", async () => {
  const messages = [
    { role: "user", content: "initial request" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "echo hi" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "plain output" }],
    },
    { role: "assistant", content: [{ type: "text", text: "no precise identifiers" }] },
    { role: "assistant", content: [{ type: "text", text: "recent" }] },
  ];
  const result = await createFoldLlmStrategy({
    summarizer: async () => "## 下一步\n已完成项禁止重做",
  }).compact(messages, { keepRounds: 1 });
  const text = result.messages[0].content[0].text;

  assert.equal(
    text,
    "## 下一步\n已完成项禁止重做\n## 恢复提示\n需要原文请重读文件；无可复原的决策记录（原因：无笔记证据）",
  );
  assert.doesNotMatch(text, /锚点索引|用户最新未解决输入|中止\/撤销/u);
});

test("prunes the fidelity layer into the summary budget when maxSummaryTokens is tiny (issue #873 fix ①)", async () => {
  const result = await createFoldLlmStrategy({
    summarizer: async () => "unsectioned summary ".repeat(200),
    maxSummaryTokens: 50,
  }).compact(anchorConversation(), { keepRounds: 2 });
  const text = result.messages[0].content[0].text;

  // 新语义（#873 修复①）：保真层（逐字引用）也在这个预算**内**，所以 50 token 装不下时它也被夹断；
  // 上界必须成立（选择器拿它当开销上界），且夹断必须显式留记号。锚点节已退役，不得复活。
  assert.ok(estimateTokens(text) <= 50, `整份摘要必须 ≤ 声明预算（实测 ${estimateTokens(text)}）`);
  assert.match(text, /截断|修剪/);
  assert.doesNotMatch(text, /## 锚点索引/u);
  assert.doesNotMatch(text, /^shas: 1ed3f35$/mu);
});

test("constructor parameter errors stay fail-loud (summarizer must be a function)", () => {
  assert.throws(() => createFoldLlmStrategy({ summarizer: "not-a-function" }), {
    name: "TypeError",
    message: "fold-llm summarizer must be a function",
  });
  assert.throws(() => createFoldLlmStrategy(), {
    name: "TypeError",
  });
});

test("summarizer rejects at runtime ⇒ terminal summarizer_failed, never a statistical substitute (issue #661)", async () => {
  // issue #661 语义反转：改前这条断言的是「降级为统计摘要」那块替代物（issue #33 D）；
  // 那条路径已删——摘要器失败现在是**终局错误**。反向锁：messages 里不得再出现任何降级标记。
  const messages = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "npm test" } }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "commit 0c309e6 done src/compact/fold-llm.js:1",
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "keep" },
  ];
  const before = JSON.stringify(messages);
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      throw new Error("LLM provider unavailable: rate limited");
    },
  });
  await assert.rejects(
    () => strategy.compact(messages, { keepRounds: 1 }),
    (error) => {
      assert.equal(error.code, "summarizer_failed");
      assert.equal(error.details.kind, "error");
      assert.equal(error.retryable, false);
      // `errorCode` 与 `termination.errorCode` 同一套口径：取根因自己的 code（取不到即 unknown）。
      assert.equal(error.errorCode, "unknown");
      assert.match(error.message, /LLM provider unavailable: rate limited/u);
      return true;
    },
  );
  // 先失败后应用：失败的这一折连输入都不许改（策略不得就地改写调用方的数组）。
  assert.equal(JSON.stringify(messages), before);
});

test("failed fold leaves no recovery substitute behind (stubs / navigation record / artifact body)", async () => {
  // 改前这一格钉的是「降级摘要不比统计摘要少恢复信息」（stub 行 + 导航记录）。
  // issue #661：失败即抛 ⇒ 那一份替代物根本不存在，改为反向锁：
  // ① 异常里不带被折原文（凭据不进错误消息）；② 抛出的错误上没有 foldedPayload / messages。
  const messages = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "npm test" } }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "credential=must-not-enter-summary",
        artifact: {
          artifactId: "001-exec.txt",
          archivePath: "/tmp/archive/001-exec.txt",
          digest: "a".repeat(64),
          locator: { lineStart: 1, lineEnd: 2 },
        },
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "keep" },
  ];
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      throw new Error("LLM provider unavailable");
    },
    stubFor: () => "[已折叠] 值：nonce=abc123；原文：/tmp/archive/001-exec.txt",
  });
  const error = await strategy.compact(messages, { keepRounds: 1 }).then(
    () => assert.fail("摘要器失败必须抛错（不许返回降级替代物）"),
    (thrown) => thrown,
  );
  assert.equal(error.code, "summarizer_failed");
  assert.equal(error.details.kind, "error");
  const whole = `${error.message}\n${JSON.stringify(error.details)}`;
  assert.doesNotMatch(whole, /credential=must-not-enter-summary/u);
  assert.doesNotMatch(whole, /已降级为统计摘要/u);
  assert.equal(error.foldedPayload, undefined);
  assert.equal(error.messages, undefined);
});

test("a synchronous throw and a non-string return both fail the same way", async () => {
  // issue #661：两种旧降级形状（同步抛 / 非字符串）现在都走同一个出口。
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "keep" },
  ];
  await assert.rejects(
    () => createFoldLlmStrategy({
      summarizer: () => {
        throw new Error("sync blow up");
      },
    }).compact(messages, { keepRounds: 1 }),
    (error) => {
      assert.equal(error.code, "summarizer_failed");
      assert.equal(error.details.kind, "error");
      assert.match(error.message, /sync blow up/u);
      return true;
    },
  );

  await assert.rejects(
    () => createFoldLlmStrategy({
      summarizer: async () => ({ not: "a string" }),
    }).compact(messages, { keepRounds: 1 }),
    (error) => {
      assert.equal(error.code, "summarizer_failed");
      assert.equal(error.details.kind, "error");
      assert.match(error.message, /fold-llm summarizer must return a string/u);
      return true;
    },
  );
});

test("anchors:false does not change the failure shape (no anchor section is invented)", async () => {
  // 改前：降级摘要也要尊重 anchors:false（不造锚点节）。issue #661：失败根本没有正文，
  // 所以这条变成「异常里没有锚点正文」的反向锁。
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "text", text: "old 1ed3f35" }] },
    { role: "user", content: "keep" },
  ];
  const error = await createFoldLlmStrategy({
    summarizer: async () => {
      throw new Error("boom");
    },
    anchors: false,
  }).compact(messages, { keepRounds: 1 }).then(
    () => assert.fail("摘要器失败必须抛错"),
    (thrown) => thrown,
  );
  assert.equal(error.code, "summarizer_failed");
  const whole = `${error.message}\n${JSON.stringify(error.details)}`;
  assert.doesNotMatch(whole, /## 锚点索引/u);
  assert.doesNotMatch(whole, /1ed3f35/u);
});

test("a long failure reason is truncated inside the summarizer_failed message", async () => {
  // issue #661：文案上限（120 字符）从降级标记搬到了异常消息上——超长原因不得把终局
  // 消息撑爆（宿主/日志都读这一句）。
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "keep" },
  ];
  const error = await createFoldLlmStrategy({
    summarizer: async () => {
      throw new Error(`e${"x".repeat(300)}`);
    },
  }).compact(messages, { keepRounds: 1 }).then(
    () => assert.fail("摘要器失败必须抛错"),
    (thrown) => thrown,
  );
  assert.equal(error.code, "summarizer_failed");
  assert.match(error.message, /^fold-llm 摘要失败（error）：ex{1,119}$/u);
  assert.ok(error.message.length < 200, `异常消息必须短（实测 ${error.message.length}）`);
});

// ── issue #261127-18：裁剪优先级表必须跟着节名一起改 ──────────────────────
// copilot 复审抓到的阻塞项：节名从六节改成四节时，`priorityForHeading` 那张按子串匹配的表没跟着改，
// 新节名全部落进兜底档 4 ⇒ 预算紧时先剪 `## 行动`，与契约/CHANGELOG 写的优先级**正好相反**，
// 而当时没有任何测试覆盖这张表（`fold-llm-summary-budget-469` 的夹具用的是手工赋值的 priority）。
//
// 判据取「同尺寸四节 + 只装得下两节的预算」：谁活下来就是谁排在前档。
// 契约写的是 `## 遗留`（0）/ `## 恢复提示`（0）/ `## 关键词`（1）先保，`## 行动`（2）随后 ⇒ 活下来的
// 必须是**遗留 + 关键词**。任何一节掉进兜底档 4 都会把它挤进被剪的那一半，于是这条必红。
test("#261127-18-3 裁剪优先级表覆盖当前三节：紧预算下活下来的是「遗留」+「关键词」", async () => {
  const titles = ["行动", "遗留", "关键词"];
  const summary = titles.map((title) => `## ${title}\n${"字".repeat(200)}`).join("\n");
  const strategy = createFoldLlmStrategy({
    summarizer: async () => summary,
    // 三节 ≈ 1,044 token，单节 ≈ 348，预算 900 ⇒ 装得下两节、装不下三节（保真层先让位，再按档位从高到低剪）。
    maxSummaryTokens: 900,
  });
  const result = await strategy.compact([
    { role: "user", content: `R1-USER ${"x".repeat(400)}` },
    { role: "assistant", content: [{ type: "text", text: "R1-ASSISTANT" }] },
    { role: "user", content: [{ type: "text", text: "RETAINED-LIVE-MARKER" }] },
    { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
  ], { keepRounds: 1 });
  const text = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
  const trimmed = titles.filter((title) => {
    const at = text.indexOf(`## ${title}`);
    assert.ok(at >= 0, `裁剪只剪正文、不删标题：「${title}」的骨架必须还在`);
    const next = text.indexOf("## ", at + 3);
    return text.slice(at, next < 0 ? text.length : next).includes("[已修剪]");
  });
  assert.deepEqual(
    trimmed, ["行动"],
    `被剪的必须是第 2 档的那两节（实得 ${trimmed.join("、")}）——`
    + "掉进兜底档 4 的节会挤到这里来（priorityForHeading 没跟上节名改名）",
  );
});
