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
  assert.equal(calls[0].recoveryHint, "需要原文请重读文件或查看持久笔记；关键值应当已落盘");
  assert.deepEqual(result.foldedPayload, messages.slice(1, 5));
  assert.equal(result.foldedRounds, 4);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(result.messages[0].content[0].text, new RegExp(summary));
  assert.match(result.messages[0].content[0].text, /需要原文请重读文件或查看持久笔记；关键值应当已落盘/);
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
  // LLM 摘要受 maxSummaryTokens 约束；机械保真层在其后追加（见 docs/design A2）。
  assert.ok(estimateTokens(llmPart) <= 1500);
  assert.match(foldedSummary, /^> continue again$/m);
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
  // 机械保真层在尺寸截断之后才追加，所以摘要预算削不掉它（A2 的关键行为）。
  assert.match(text, /^> continue again$/m);
});

test("publishes note-first recovery guidance requirements", () => {
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 阶段/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已改文件/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已验证项/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 下一步/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /已完成项禁止重做/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 主题词面包屑/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /需要原文请重读文件或查看持久笔记；关键值应当已落盘/);
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

test("appends the mechanical fidelity layer after the LLM summary" + " (anchor index / verbatim user input / reverse signal)", async () => {
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

  // LLM 复述必然丢失精确值（SHA → "某个 commit"），机械保真层把原文值兜回来。
  assert.match(text, /提交了某个 commit/);
  assert.match(text, /## 锚点索引（机械抽取，未经 LLM 改写）/);
  assert.match(text, /^shas: 1ed3f35$/m);
  assert.match(text, /^paths: src\/compact\/fold-llm\.js:120$/m);
  assert.match(text, /^issues: #32$/m);
  assert.match(text, /^urls: https:\/\/git\.erix\.vip\/eric\/erix-llm-kit\/commit\/1ed3f35$/m);
  // 逐字引用被折轮次里最后一条真实 user 消息，并标注反向信号。
  assert.match(text, /## 用户最新未解决输入（逐字引用，未经 LLM 改写）/);
  assert.match(text, /⚠ 用户曾发出中止\/撤销信号（命中：取消）/);
  assert.match(text, /^> 取消旧方案，改做锚点索引$/m);
  // 保真层整体追加在 LLM 摘要之后，锚点节位于最末。
  assert.ok(text.indexOf(paraphrased) < text.indexOf("## 用户最新未解决输入"));
  assert.ok(text.lastIndexOf("## 锚点索引") > text.indexOf("## 用户最新未解决输入"));
  assert.ok(text.trimEnd().endsWith("https://git.erix.vip/eric/erix-llm-kit/commit/1ed3f35"));
  // 引用的是"被折轮次里"最后一条真实 user 消息；仍在上下文里的最新 user 输入不重复注入。
  assert.doesNotMatch(text, /^> final request$/m);
  assert.equal(result.foldedRounds, 4);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
});

test("keeps the mechanical fidelity layer when the summary budget is tiny", async () => {
  const result = await createFoldLlmStrategy({
    summarizer: async () => "unsectioned summary ".repeat(200),
    maxSummaryTokens: 40,
  }).compact(anchorConversation(), { keepRounds: 2 });
  const text = result.messages[0].content[0].text;
  const [llmPart] = text.split("## 用户最新未解决输入");

  assert.ok(estimateTokens(llmPart) <= 40);
  assert.match(llmPart, /截断|修剪/);
  assert.match(text, /^shas: 1ed3f35$/m);
  assert.match(text, /^> 取消旧方案，改做锚点索引$/m);
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
    "## 下一步\n已完成项禁止重做\n## 恢复提示\n需要原文请重读文件或查看持久笔记；关键值应当已落盘",
  );
  assert.doesNotMatch(text, /锚点索引|用户最新未解决输入|中止\/撤销/u);
});

test("anchors:false strips the stale anchor section from a previous default fold (review fix)", async () => {
  const summarizer = async () => "## 下一步\n已完成项禁止重做";
  const strategy = createFoldLlmStrategy({ summarizer });

  // fold1 默认（anchors 缺省开启）：产生真锚点节。
  const fold1 = await strategy.compact(anchorConversation(), { keepRounds: 2 });
  const fold1Text = fold1.messages[0].content[0].text;
  assert.match(fold1Text, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.match(fold1Text, /^shas: 1ed3f35$/mu);
  assert.match(fold1Text, /^paths: src\/compact\/fold-llm\.js:120$/mu);

  // 模拟对话继续：旧摘要消息留在 head（未被折），且仍有轮次可折。
  const continued = [
    ...fold1.messages,
    { role: "user", content: "second wave request" },
    { role: "assistant", content: [{ type: "text", text: "second wave answer" }] },
  ];

  // fold2 anchors:false：旧锚点节必须从旧 content 清除。
  const fold2 = await strategy.compact(continued, { keepRounds: 2, anchors: false });
  const whole2 = JSON.stringify(fold2.messages);
  // 无锚点节标题、无旧锚点值（「改做锚点索引」是用户原文逐字引用，合法保留）。
  assert.doesNotMatch(whole2, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.doesNotMatch(whole2, /1ed3f35|src\/compact\/fold-llm\.js:120|#32|git\.erix\.vip/u);
  // 旧摘要的非锚点内容保留（只剥锚点节，不动其余）。
  const oldBlock = fold2.messages[0].content[1].text;
  assert.match(oldBlock, /## 下一步\n已完成项禁止重做/u);
  assert.doesNotMatch(oldBlock, /## 锚点索引/u);
  // 其余保真层（逐字引用）在新摘要里照常生成，不受影响。
  const newBlock = fold2.messages[0].content[0].text;
  assert.match(newBlock, /## 用户最新未解决输入/u);
  assert.match(newBlock, /^> final request$/m);

  // call-level 与工厂级 anchors:false 等价。
  const factoryDisabled = await createFoldLlmStrategy({
    summarizer,
    anchors: false,
  }).compact(continued, { keepRounds: 2 });
  assert.deepEqual(factoryDisabled.messages, fold2.messages);

  // fold3 仍 anchors:false：锚点节不复活。
  const fold3 = await strategy.compact(fold2.messages, { keepRounds: 1, anchors: false });
  const whole3 = JSON.stringify(fold3.messages);
  assert.doesNotMatch(whole3, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.doesNotMatch(whole3, /1ed3f35|src\/compact\/fold-llm\.js:120|#32|git\.erix\.vip/u);

  // anchorsEnabled 缺省路径行为不变：旧 content 原样保留（旧锚点节仍在）。
  const foldDefault = await strategy.compact(continued, { keepRounds: 2 });
  const wholeDefault = JSON.stringify(foldDefault.messages);
  assert.match(wholeDefault, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.match(wholeDefault, /1ed3f35/u);
});

test("anchors:false strips the stale anchor section from every head message when the summary lands in system", async () => {
  const summarizer = async () => "## 下一步\n已完成项禁止重做";
  const strategy = createFoldLlmStrategy({ summarizer, summaryRole: "system" });

  // fold1 默认（anchors 缺省开启）：摘要落进 system 消息（无既有 system 则新建），带真锚点节。
  const fold1 = await strategy.compact(anchorConversation(), { keepRounds: 2 });
  assert.equal(fold1.messages[0].role, "system");
  const fold1Text = fold1.messages[0].content[0].text;
  assert.match(fold1Text, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.match(fold1Text, /^shas: 1ed3f35$/mu);

  const continued = [
    ...fold1.messages,
    { role: "user", content: "second wave request" },
    { role: "assistant", content: [{ type: "text", text: "second wave answer" }] },
  ];

  // fold2 anchors:false：旧 system 摘要里的锚点节必须被剥掉（全 head 剥离，不只目标消息）。
  const fold2 = await strategy.compact(continued, { keepRounds: 2, anchors: false });
  const whole2 = JSON.stringify(fold2.messages);
  assert.doesNotMatch(whole2, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.doesNotMatch(whole2, /1ed3f35|src\/compact\/fold-llm\.js:120|#32|git\.erix\.vip/u);
  // 旧摘要的非锚点内容保留，新摘要照常前置到 system 消息（其后是恢复提示与逐字引用层）。
  const systemBlocks = fold2.messages[0].content;
  assert.match(systemBlocks[0].text, /^## 下一步\n已完成项禁止重做/u);
  assert.doesNotMatch(systemBlocks[0].text, /## 锚点索引/u);
});

test("anchors:false leaves no stale anchors when the summary role switches between folds", async () => {
  const summarizer = async () => "## 下一步\n已完成项禁止重做";

  // fold1 默认：摘要落在 user 消息（summaryRole 缺省 user），产生锚点节。
  const strategy = createFoldLlmStrategy({ summarizer });
  const fold1 = await strategy.compact(anchorConversation(), { keepRounds: 2 });
  assert.equal(fold1.messages[0].role, "user");
  assert.match(fold1.messages[0].content[0].text, /## 锚点索引（机械抽取，未经 LLM 改写）/u);

  const continued = [
    ...fold1.messages,
    { role: "user", content: "second wave request" },
    { role: "assistant", content: [{ type: "text", text: "second wave answer" }] },
  ];

  // fold2 切到 system + anchors:false：旧摘要还在 user 消息里，锚点节同样不得残留。
  const fold2 = await createFoldLlmStrategy({
    summarizer,
    summaryRole: "system",
  }).compact(continued, { keepRounds: 2, anchors: false });
  const whole2 = JSON.stringify(fold2.messages);
  assert.doesNotMatch(whole2, /## 锚点索引（机械抽取，未经 LLM 改写）/u);
  assert.doesNotMatch(whole2, /1ed3f35|src\/compact\/fold-llm\.js:120|#32|git\.erix\.vip/u);
  // 新摘要落进新建 system 消息，旧 user 摘要的非锚点内容保留。
  assert.equal(fold2.messages[0].role, "system");
  assert.match(fold2.messages[0].content[0].text, /已完成项禁止重做/u);
  const userSummary = fold2.messages.find((message) => message.role === "user");
  assert.match(userSummary.content[0].text, /## 下一步\n已完成项禁止重做/u);
  assert.doesNotMatch(userSummary.content[0].text, /## 锚点索引/u);
});

test("keeps the anchor section intact when maxSummaryTokens is tiny (A2)", async () => {
  const result = await createFoldLlmStrategy({
    summarizer: async () => "unsectioned summary ".repeat(200),
    maxSummaryTokens: 50,
  }).compact(anchorConversation(), { keepRounds: 2 });
  const text = result.messages[0].content[0].text;
  const [llmPart] = text.split("## 用户最新未解决输入");

  // 摘要本体被削到 50 token 内，但锚点节完整保留（在尺寸截断之后追加）。
  assert.ok(estimateTokens(llmPart) <= 50);
  assert.match(llmPart, /截断|修剪/);
  const anchorSection = text.slice(text.indexOf("## 锚点索引"));
  assert.match(anchorSection, /^shas: 1ed3f35$/mu);
  assert.match(anchorSection, /^paths: src\/compact\/fold-llm\.js:120$/mu);
  assert.match(anchorSection, /^issues: #32$/mu);
  assert.match(anchorSection, /^urls: https:\/\/git\.erix\.vip\/eric\/erix-llm-kit\/commit\/1ed3f35$/mu);
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

test("degrades to a statistical summary when the summarizer rejects at runtime (issue #33 D)", async () => {
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
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      throw new Error("LLM provider unavailable: rate limited");
    },
  });
  const result = await strategy.compact(messages, { keepRounds: 1 });
  const text = result.messages[0].content[0].text;

  // compact 正常返回：降级标记可识别、含截断原因；统计摘要本体（足迹/锚点/恢复提示）齐全。
  assert.match(text, /^\[fold-llm 摘要失败，已降级为统计摘要（原因: LLM provider unavailable: rate limited）\]/u);
  assert.match(text, /【上下文折叠·v1·erix-9f6e2c】早期第 1–2 轮（共 2 轮）已折叠。/u);
  assert.match(text, /工具足迹：exec×1。/u);
  assert.match(text, /需要原文请重读文件或查看持久笔记；关键值应当已落盘/u);
  assert.match(text, /^shas: 0c309e6$/mu);
  assert.match(text, /^paths: src\/compact\/fold-llm\.js:1$/mu);
  // foldedPayload 仍随 transcript 归档。
  assert.deepEqual(result.foldedPayload, messages.slice(1, 4));
  assert.equal(result.compacted, true);
  assert.equal(result.foldedRounds, 2);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
});

test("degraded summary carries stubs and the artifact navigation record (review fix)", async () => {
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
  const result = await strategy.compact(messages, { keepRounds: 1 });
  const text = result.messages[0].content[0].text;

  assert.match(text, /已降级为统计摘要/u);
  // 降级摘要不比原生 statistical 摘要少恢复信息：stub 行 + artifact 导航记录。
  assert.match(text, /^\[已折叠\] 值：nonce=abc123；原文：\/tmp\/archive\/001-exec\.txt$/mu);
  assert.match(text, /^导航记录：\{/mu);
  assert.match(text, /001-exec\.txt/u);
  assert.doesNotMatch(text, /credential=must-not-enter-summary/u);
});

test("degrades when the summarizer throws synchronously or returns a non-string", async () => {
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "keep" },
  ];
  const syncThrow = await createFoldLlmStrategy({
    summarizer: () => {
      throw new Error("sync blow up");
    },
  }).compact(messages, { keepRounds: 1 });
  assert.match(
    syncThrow.messages[0].content[0].text,
    /\[fold-llm 摘要失败，已降级为统计摘要（原因: sync blow up）\]/u,
  );

  const nonString = await createFoldLlmStrategy({
    summarizer: async () => ({ not: "a string" }),
  }).compact(messages, { keepRounds: 1 });
  assert.match(
    nonString.messages[0].content[0].text,
    /\[fold-llm 摘要失败，已降级为统计摘要（原因: fold-llm summarizer must return a string）\]/u,
  );
});

test("degraded summary respects anchors:false exactly like the normal path", async () => {
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "text", text: "old 1ed3f35" }] },
    { role: "user", content: "keep" },
  ];
  const result = await createFoldLlmStrategy({
    summarizer: async () => {
      throw new Error("boom");
    },
    anchors: false,
  }).compact(messages, { keepRounds: 1 });

  const text = result.messages[0].content[0].text;
  assert.match(text, /已降级为统计摘要/u);
  assert.doesNotMatch(text, /## 锚点索引/u);
  assert.doesNotMatch(text, /1ed3f35/u);
});

test("a long failure reason is truncated inside the degradation marker", async () => {
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "keep" },
  ];
  const result = await createFoldLlmStrategy({
    summarizer: async () => {
      throw new Error(`e${"x".repeat(300)}`);
    },
  }).compact(messages, { keepRounds: 1 });

  const text = result.messages[0].content[0].text;
  const marker = text.split("\n")[0];
  assert.match(marker, /已降级为统计摘要（原因: ex{1,119}…?）\]$/u);
  assert.ok(marker.length < 200);
});
