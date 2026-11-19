// issue #865（#862 修法 B）：**「被文本化的工具调用」不算交付物** —— 分类轴、机器事实、渲染名额。
//
// 病灶（#862 现场）：上游/网关把 tool call 编进 `content`，那一轮在引擎眼里就是「无 `tool_use` +
// `end_turn` + 正文非空」。修法 A（同一号工单）让引擎**认得出**这种终稿（`result.finalTextShape`），
// 但明确不动判定；于是 `judge_done` 的停门照样被一堆标记撑起来：评审看到「正文块 ≥ 1」就判完成，
// run 绿着交出一堆标记 ⇒ **等于没交报告**（静默降级）。
//
// 本单的修法不是往停门里再加一个 if（那是第四套分类，正是 #473 刚填平的坑），而是**在 #473 那一条
// 分类轴上扩出一格**：`deliverableKindOfBlock` 现在问的是「这段文本算不算被声明为交付物」，而
// `textualized_tool_call` 不算 ⇒ 它自然撑不起停门。分类只有一份实现（渲染器 `renderConversation`、
// 机器事实 `roundDeliverableFacts`、停门 `judgeDoneBlocker` 都读它）。
//
// 本文件钉判据 1 / 2 / 4（判据 3「停门前后对照」的数由 `scripts/probe-865-stopgate-comparison.mjs`
// 量，run 级的 nudge 格在 `test/loop-judge-done-textualized-865.test.js`）：
//   · **A1 判据 1（分类轴）**：五条特征逐个（含两条**零实证**的预防性覆盖）都落
//     `textualized_tool_call`，正常交付 / 自述 / 工具块三格一字未动；
//   · **A2 判据 1（机器事实）**：泄漏那一轮的 `hasDeliverable === false`、`textualizedBlocks >= 1`、
//     `latestDeliverable` 里**没有**那堆标记；混合轮（真交付 + 泄漏）仍是交付物，且
//     `latestDeliverable` 取真交付那一条（两种先后顺序都对）；nudge 文案点名这类正文；
//   · **A3 判据 1（恒等式）**：`deliverableBlocks + textualizedBlocks === base 的 deliverableBlocks`
//     ——「只改分类、不误杀」的机器可检形式，右边是**在 base 树上量出来的** fixture；
//   · **A4 判据 2（不误伤，本单最容易被自己改坏的一格）**：正文在 ``` 围栏 / `行内代码` 里**引用**
//     标记 ⇒ 照旧 `deliverable_text` + `hasDeliverable === true`。`marker_in_fence` 单独钉名；
//     配一条反向锚（同一文本抹掉围栏 ⇒ 必须命中），否则这一格会因为「文本里根本没标记」而恒真；
//   · **A5 判据 4（老路径逐字不变）**：语料里十条**不命中**的消息序列，在 HEAD 上的
//     `roundDeliverableFacts` 读数与 `origin/main` 的 fixture **逐键逐值相同**，键集合只多
//     `textualizedBlocks` 这一个加法键，且它在这些 run 上恒为 0；
//   · **A6 渲染器的 mandatory 名额**：这类正文**照样渲染**（评审要看得见），但不再占
//     「最新一条 assistant 正文 = 交付物」那个名额；而 user 侧那一格**照旧**占
//     「第一条 user 正文 = 任务」的名额（任务正文里裸写一个 `<invoke` 与本单要拦的事无关）。
//
// ⚠ fixture 的纪律：`BASE_FACTS_865` / `BASE_HITTING_865` 是**在 `origin/main`（`9a8df3c4`）的
// worktree 上现跑现取**的（复现命令写在各常量的注释里），不是从 HEAD 抄回来的。A5 的反向锚会把
// 「有人把改动后的读数抄成 fixture」当场打红（base 的读数里**不许**出现 `textualizedBlocks`）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  TEXTUALIZED_TOOL_CALL_LABEL,
  buildJudgePrompt,
  deliverableKindOfBlock,
  judgeDoneBlocker,
  renderConversation,
  roundDeliverableFacts,
} from "../src/reflection/judge.js";
import { DELIVERABLE_FACTS_CORPUS_865 } from "./helpers/deliverable-facts-corpus-865.js";

/** #862 现场里那条真实终稿（一句正常总结 + 被文本化的调用），与修法 A 的夹具同一条。 */
const LEAK = "Tests: 3824 total.\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"exec\">\n"
  + "<｜｜DSML｜｜ parameter name=\"command\">npm test</｜｜DSML｜｜>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
const DELIVER = "已完成：停门补上了交付物这一格，全套 3878 测试全绿。";
/** 五条特征各一条正文（前三条来自宿主 dev 库真实样本，后两条是**预防性覆盖、零实证**）。 */
const MARKER_TEXTS = [
  ["DSML", "结论如下\n<｜｜DSML｜｜ calls>"],
  ["DSML 带空格 + tool_calls", "结论如下\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜ invoke name=\"shell\">"],
  ["tool_call", "结论如下\n<tool_call name=\"exec\">"],
  ["Function 族", "结论如下\n<｜Function=exec>"],
  ["invoke（零实证）", "结论如下\n<invoke name=\"exec\">"],
  ["chatcmpl-tool-（零实证）", "结论如下\nchatcmpl-tool-abc123def456"],
];

const assistantRound = (...blocks) => [{ role: "assistant", content: blocks }];
const textBlock = (text) => ({ type: "text", text });

/** #865 之前 `roundDeliverableFacts` 的**全部**键（加法键的对照基准）。 */
const BASE_KEYS = [
  "deliverableBlocks",
  "deliverableChars",
  "latestDeliverable",
  "reasoningBlocks",
  "reasoningChars",
  "hasDeliverable",
];

// ── base fixture（**量**出来的，不是抄的）───────────────────────────────────────────────────
// 复现（base 树 = `git worktree add /tmp/base-865 origin/main`，`9a8df3c4`）：
//   node --input-type=module -e " … roundDeliverableFacts(messages, 0) 与 (messages, 1) … "
// 语料取自 `test/helpers/deliverable-facts-corpus-865.js`（**两棵树吃同一份**，见那个文件的头注）。
const BASE_FACTS_865 = {
  cjk_delivery: {
    r0: { deliverableBlocks: 1, deliverableChars: 19, latestDeliverable: "交付：实现了 X，3824 测试全绿。", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
    r1: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  },
  ascii_delivery: {
    r0: { deliverableBlocks: 1, deliverableChars: 39, latestDeliverable: "Done. Added the flag and ran the suite.", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
    r1: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  },
  multi_text_blocks: {
    r0: { deliverableBlocks: 3, deliverableChars: 9, latestDeliverable: "第三段", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
    r1: { deliverableBlocks: 1, deliverableChars: 3, latestDeliverable: "第三段", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
  },
  with_reasoning: {
    r0: { deliverableBlocks: 1, deliverableChars: 2, latestDeliverable: "正文", reasoningBlocks: 1, reasoningChars: 6, hasDeliverable: true },
    r1: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  },
  user_task_only: {
    r0: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
    r1: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  },
  blank_text: {
    r0: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
    r1: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  },
  tool_blocks: {
    r0: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
    r1: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  },
  marker_in_fence: {
    r0: { deliverableBlocks: 1, deliverableChars: 35, latestDeliverable: "台账里记着：\n```\n<｜｜DSML｜｜ calls>\n```\n以上。", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
    r1: { deliverableBlocks: 0, deliverableChars: 0, latestDeliverable: "", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  },
  tool_result_round: {
    r0: { deliverableBlocks: 1, deliverableChars: 13, latestDeliverable: "工具结果已核对，交付完成。", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
    r1: { deliverableBlocks: 1, deliverableChars: 13, latestDeliverable: "工具结果已核对，交付完成。", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
  },
  image_and_raw: {
    r0: { deliverableBlocks: 1, deliverableChars: 2, latestDeliverable: "结论", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
    r1: { deliverableBlocks: 1, deliverableChars: 2, latestDeliverable: "结论", reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
  },
};

// 命中面的 base 读数：恒等式 `HEAD.deliverableBlocks + HEAD.textualizedBlocks === base.deliverableBlocks`
// 的右边。同一份消息序列、同一个 `roundDeliverableFacts`，只是跑在**没有 #865 的那棵树**上。
// 复现：把本文件下面 `HITTING_CORPUS_865` 的消息序列喂进 `/tmp/base-865/src/reflection/judge.js`。
const BASE_HITTING_865 = {
  leak_only: { deliverableBlocks: 1, deliverableChars: 157, reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
  leak_then_deliver: { deliverableBlocks: 2, deliverableChars: 186, reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
  deliver_then_leak: { deliverableBlocks: 2, deliverableChars: 186, reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
  two_leaks: { deliverableBlocks: 2, deliverableChars: 314, reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
  leak_with_reasoning: { deliverableBlocks: 1, deliverableChars: 157, reasoningBlocks: 1, reasoningChars: 4, hasDeliverable: true },
  user_leak_task: { deliverableBlocks: 0, deliverableChars: 0, reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: false },
  all_six_markers: { deliverableBlocks: 6, deliverableChars: 182, reasoningBlocks: 0, reasoningChars: 0, hasDeliverable: true },
};

const HITTING_CORPUS_865 = {
  leak_only: assistantRound(textBlock(LEAK)),
  leak_then_deliver: assistantRound(textBlock(LEAK), textBlock(DELIVER)),
  deliver_then_leak: assistantRound(textBlock(DELIVER), textBlock(LEAK)),
  two_leaks: assistantRound(textBlock(LEAK), textBlock(LEAK)),
  leak_with_reasoning: assistantRound({ type: "reasoning", text: "先想一下" }, textBlock(LEAK)),
  user_leak_task: [{ role: "user", content: [textBlock(LEAK)] }],
  all_six_markers: assistantRound(...MARKER_TEXTS.map(([, text]) => textBlock(text))),
};

// ── A1 判据 1：分类轴 ──────────────────────────────────────────────────────────────────────
test("#865 A1 五条特征逐个落进新格 textualized_tool_call，另三格一字未动", () => {
  for (const [name, text] of MARKER_TEXTS) {
    assert.equal(
      deliverableKindOfBlock(textBlock(text)),
      "textualized_tool_call",
      `没落进新格：${name}`,
    );
  }
  // 同一条轴上另外三格没被这次扩容动过（`reasoning` / `other` 的口径与 #473 相同）。
  assert.equal(deliverableKindOfBlock(textBlock(DELIVER)), "deliverable_text");
  assert.equal(deliverableKindOfBlock({ type: "reasoning", text: LEAK }), "reasoning",
    "分类看的是**块类型**，不是正文里有没有标记：reasoning 里写满标记也还是自述");
  assert.equal(deliverableKindOfBlock({ type: "tool_use", name: "exec" }), "other");
  assert.equal(deliverableKindOfBlock({ type: "tool_result", content: "ok" }), "other");
  assert.equal(deliverableKindOfBlock({ type: "image", mediaType: "image/png" }), "other");
  assert.equal(deliverableKindOfBlock(undefined), "other");
  // 空白正文走 #473 已有的「跳过」口径（不是新增一格）：分类仍是 deliverable_text，计数由下游跳过。
  assert.equal(deliverableKindOfBlock(textBlock("   \n\t ")), "deliverable_text");
});

// ── A2 判据 1：机器事实 + nudge 文案 ────────────────────────────────────────────────────────
test("#865 A2 纯泄漏那一轮：hasDeliverable=false、textualizedBlocks>=1、latestDeliverable 不含标记", () => {
  const facts = roundDeliverableFacts(assistantRound(textBlock(LEAK)), 0);
  assert.equal(facts.hasDeliverable, false, "一堆标记撑不起「本轮有交付物」");
  assert.equal(facts.deliverableBlocks, 0);
  assert.equal(facts.deliverableChars, 0);
  assert.ok(facts.textualizedBlocks >= 1, `加法键要数出被排除的那几段，实际 ${facts.textualizedBlocks}`);
  assert.equal(facts.latestDeliverable, "",
    "「最新一条交付物」不许是这堆标记（渲染器据此决定 mandatory 名额，停门据此放行/拦住）");
  assert.ok(!facts.latestDeliverable.includes("<｜｜DSML｜｜"));

  // 混合轮（真交付 + 泄漏）：**两种先后顺序**都仍算交付物，且 latestDeliverable 取真交付那一条。
  for (const name of ["leak_then_deliver", "deliver_then_leak"]) {
    const mixed = roundDeliverableFacts(HITTING_CORPUS_865[name], 0);
    assert.equal(mixed.hasDeliverable, true, `${name}：本轮有真交付，不许被同轮的泄漏拖累`);
    assert.equal(mixed.deliverableBlocks, 1, name);
    assert.equal(mixed.textualizedBlocks, 1, name);
    assert.equal(mixed.latestDeliverable, DELIVER, `${name}：latestDeliverable 必须是真交付正文`);
    assert.ok(!mixed.latestDeliverable.includes("<｜｜DSML｜｜"), name);
  }

  // 停门读的就是这一格：纯泄漏 ⇒ 拦，且 `detail`（就是回去碰模型的那条 nudge）点名这类正文。
  const blocker = judgeDoneBlocker({ facts, selfReport: undefined });
  assert.equal(blocker.code, "no_deliverable_text");
  assert.ok(blocker.detail.includes(TEXTUALIZED_TOOL_CALL_LABEL),
    `nudge 文案必须点名「${TEXTUALIZED_TOOL_CALL_LABEL}」，实际：${blocker.detail}`);
  assert.match(blocker.detail, /另有 1 段/u, "文案要报出段数，否则模型无从知道拦的是什么");
  // 混合轮不拦（这一格同时是「不误杀」的反向锚）。
  assert.equal(judgeDoneBlocker({
    facts: roundDeliverableFacts(HITTING_CORPUS_865.leak_then_deliver, 0),
    selfReport: undefined,
  }), null);

  // 评审提示词同一条纪律：命中才多那一段，计数 0 / 不给键 ⇒ 一个字节都不多（纯加法）。
  const promptFor = (roundDeliverable) => buildJudgePrompt(
    "任务", 3, [], [], [], "", {}, { roundDeliverable, roundStopReason: "end_turn" },
  );
  const hit = promptFor(facts);
  assert.ok(hit.includes(`被文本化的工具调用 ${facts.textualizedBlocks} 段`), hit.slice(0, 400));
  assert.ok(hit.includes("不是交付物，也不是失败"), "绑定规则要写进提示词，不能只报数");
  assert.ok(hit.includes(TEXTUALIZED_TOOL_CALL_LABEL));
  const zeroFacts = { ...facts, deliverableBlocks: 1, hasDeliverable: true, textualizedBlocks: 0 };
  const noKeyFacts = { ...zeroFacts };
  delete noKeyFacts.textualizedBlocks;
  assert.equal(promptFor(zeroFacts), promptFor(noKeyFacts),
    "旧调用方传来的 facts 没有加法键 ⇒ 与计数为 0 逐字相同");
  assert.ok(!promptFor(zeroFacts).includes("被文本化的工具调用"),
    "不命中的 run 递给评审的提示词不许多一个字节");
  // `judgeDoneBlocker` 同一条纪律：没有加法键 ⇒ 文案与 #473 逐字相同（不多不少一句）。
  assert.equal(
    judgeDoneBlocker({ facts: noKeyFacts, selfReport: undefined }),
    null,
  );
  const legacyNoDeliverable = { ...noKeyFacts, deliverableBlocks: 0, hasDeliverable: false };
  assert.ok(!judgeDoneBlocker({ facts: legacyNoDeliverable }).detail.includes(TEXTUALIZED_TOOL_CALL_LABEL),
    "缺加法键时不许凭空冒出那一句");
});

// ── A3 判据 1：恒等式（不误杀 + 只改分类）───────────────────────────────────────────────────
test("#865 A3 恒等式 deliverableBlocks + textualizedBlocks === base 的 deliverableBlocks", () => {
  for (const [name, messages] of Object.entries(HITTING_CORPUS_865)) {
    const base = BASE_HITTING_865[name];
    assert.ok(base, `base fixture 缺这一条：${name}`);
    const facts = roundDeliverableFacts(messages, 0);
    assert.equal(
      facts.deliverableBlocks + facts.textualizedBlocks,
      base.deliverableBlocks,
      `${name}：本单只许把块从 deliverableBlocks **挪进** textualizedBlocks，不许凭空少一段`,
    );
    // reasoning 那一格与 #473 逐字相同（本单没动它）。
    assert.equal(facts.reasoningBlocks, base.reasoningBlocks, name);
    assert.equal(facts.reasoningChars, base.reasoningChars, name);
    // 恒等式两侧都为真 ⇒ 挪动是有方向的：正文里**有**真交付时 hasDeliverable 必须仍为 true。
    if (base.deliverableBlocks > facts.textualizedBlocks) {
      assert.equal(facts.hasDeliverable, true, `${name}：还有真交付，不许判成没交付`);
    } else {
      assert.equal(facts.hasDeliverable, false, `${name}：全是标记 ⇒ 就是没交付`);
    }
  }
  // 角色口径：user 侧的这类正文**不进** `textualizedBlocks`（与 `deliverableBlocks` 同一条角色判据），
  // 于是 `user_leak_task` 那一行两侧都是 0 —— 恒等式对 user 消息同样成立，而不是靠跳过角色蒙对。
  const userFacts = roundDeliverableFacts(HITTING_CORPUS_865.user_leak_task, 0);
  assert.equal(userFacts.textualizedBlocks, 0);
  assert.equal(userFacts.deliverableBlocks, BASE_HITTING_865.user_leak_task.deliverableBlocks);
});

// ── A4 判据 2：代码里引用标记 ⇒ 不误伤 ──────────────────────────────────────────────────────
test("#865 A4 围栏 / 行内码里引用标记仍是 deliverable_text（marker_in_fence 钉名）+ 抹掉围栏必红", () => {
  const FENCE = "```";
  const quoted = {
    fence_plain: `台账里记着：\n${FENCE}\n<｜｜DSML｜｜ calls>\n${FENCE}\n以上。`,
    fence_with_lang: `变更：\n${FENCE}markdown\n<invoke name="exec">\n${FENCE}\n完成。`,
    inline_single: "特征串 `<tool_call` 与 `<invoke` 已入库，判据在 stripCode 之后。",
    inline_pair: "命中 `<｜Function` 即判真；`chatcmpl-tool-` 走长度闸。",
    deliver_then_quote: `${DELIVER}顺带说明：这类标记写作 \`<｜｜DSML｜｜\`。`,
  };
  for (const [name, text] of Object.entries(quoted)) {
    assert.equal(deliverableKindOfBlock(textBlock(text)), "deliverable_text", `误判：${name}`);
    const facts = roundDeliverableFacts(assistantRound(textBlock(text)), 0);
    assert.equal(facts.hasDeliverable, true, `${name}：引用标记的正文就是正常交付物`);
    assert.equal(facts.textualizedBlocks, 0, `${name}：不该被挪进加法键`);
    assert.equal(facts.latestDeliverable, text.trim(), name);
  }

  // `marker_in_fence` 按**语料里那一条**再钉一次（前一版探针的输出里这一格显示过
  // `hasDeliverable:false`——本单最容易被自己改坏的就是它，所以两处都钉）。
  const corpusEntry = DELIVERABLE_FACTS_CORPUS_865.find((entry) => entry.name === "marker_in_fence");
  assert.ok(corpusEntry, "语料里必须还有 marker_in_fence 那一条");
  const fenceFacts = roundDeliverableFacts(corpusEntry.messages, 0);
  assert.equal(fenceFacts.hasDeliverable, true);
  assert.equal(fenceFacts.textualizedBlocks, 0);
  assert.deepEqual(fenceFacts, { ...BASE_FACTS_865.marker_in_fence.r0, textualizedBlocks: 0 },
    "marker_in_fence 在 HEAD 上的读数 = base 读数 + 加法键 0");

  // 反向锚：把围栏与反引号**抹掉**（其余一字不动）⇒ 必须命中新格。
  // 没有这一条，上面的绿就只是「文本里恰好没有标记」，不是「stripCode 起了作用」。
  for (const [name, text] of Object.entries(quoted)) {
    const bare = text.replaceAll(FENCE, "").replaceAll("`", "");
    assert.equal(
      deliverableKindOfBlock(textBlock(bare)),
      "textualized_tool_call",
      `${name}：抹掉代码标记后同一个字面串必须命中 ⇒ 否则上面那格是恒真`,
    );
    assert.equal(roundDeliverableFacts(assistantRound(textBlock(bare)), 0).hasDeliverable, false, name);
  }
});

// ── A5 判据 4：不命中的 run，既有键与 base 逐字相同 ─────────────────────────────────────────
test("#865 A5 不命中的十条语料：既有键与 origin/main 逐键逐值相同，加法键恒 0", () => {
  assert.equal(
    DELIVERABLE_FACTS_CORPUS_865.length,
    Object.keys(BASE_FACTS_865).length,
    "语料与 base fixture 的条目数必须一致（少一条就是有人删了语料没刷 fixture）",
  );
  for (const entry of DELIVERABLE_FACTS_CORPUS_865) {
    const base = BASE_FACTS_865[entry.name];
    assert.ok(base, `base fixture 缺这一条：${entry.name}`);
    for (const [key, roundStart] of [["r0", 0], ["r1", 1]]) {
      const facts = roundDeliverableFacts(entry.messages, roundStart);
      // 值对账：把加法键摘掉之后必须与 base **逐字相同**（deepStrictEqual 连键集合一起比）。
      const withoutAdditive = { ...facts };
      const removed = delete withoutAdditive.textualizedBlocks;
      assert.ok(removed, `${entry.name}/${key}：加法键没出现？`);
      assert.deepEqual(withoutAdditive, base[key], `${entry.name}/${key}：既有键漂了`);
      // 键集合对账：HEAD 的键 = base 的键 + 恰好这一个加法键。
      assert.deepEqual(
        Object.keys(facts).sort(),
        [...BASE_KEYS, "textualizedBlocks"].sort(),
        `${entry.name}/${key}：键集合不再是「base + 一个加法键」`,
      );
      assert.equal(facts.textualizedBlocks, 0, `${entry.name}/${key}：不命中的 run 加法键必须为 0`);
    }
  }

  // 反向锚（fixture 必须是**改动前**的读数）：base 那一份里不许出现 `textualizedBlocks`。
  // 有人把 HEAD 的读数抄成 fixture（或改动后又拿 HEAD 重刷）时，这一格先红。
  for (const [name, perRound] of Object.entries(BASE_FACTS_865)) {
    for (const key of ["r0", "r1"]) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(perRound[key], "textualizedBlocks"),
        `base fixture 的 ${name}/${key} 里有 textualizedBlocks ⇒ 它是改动后的读数，对照当场失效`,
      );
      assert.deepEqual(Object.keys(perRound[key]).sort(), [...BASE_KEYS].sort(), `${name}/${key}`);
    }
  }
});

// ── A6 渲染器的 mandatory 名额 ─────────────────────────────────────────────────────────────
test("#865 A6 这类正文照样渲染（中性标签），但不再占「最新一条交付物」那个名额", () => {
  const messages = [
    { role: "user", content: [textBlock("任务：把停门补上交付物这一格")] },
    { role: "assistant", content: [textBlock(DELIVER)] },
    { role: "assistant", content: [textBlock(LEAK)] },
  ];
  // 宽预算：三段都在，且这类正文的标签是**中性**的（不是失败、也不是结论）。
  const wide = renderConversation(messages, { maxTokens: 2000 });
  assert.ok(wide.includes(`### assistant（${TEXTUALIZED_TOOL_CALL_LABEL}）`),
    "评审要看得见它，否则无从知道为什么没交付");
  assert.ok(wide.includes("### assistant\n" + DELIVER), "真交付照旧并进交付物那一格");
  assert.ok(!wide.includes("### assistant（内部自述"), "它也不是自述：不许复用 #473 那个标签");

  // 紧预算：mandatory 名额只有「第一条 user 正文」+「最新一条 assistant **交付物**」。
  // 泄漏段是 sections 的最后一条，若它还占着 latestAssistantText 就必然被留下 ⇒ 这一格钉的是名额本身。
  const tight = renderConversation(messages, { maxTokens: 40 });
  assert.ok(tight.includes("任务：把停门补上交付物这一格"), "任务永远留下");
  assert.ok(tight.includes(DELIVER), "真交付永远留下（它就是最新一条交付物）");
  assert.ok(!tight.includes("<｜｜DSML｜｜ calls>"),
    "预算紧时可以被省略的必须是这类正文，不是真交付");
});

test("#865 A6 user 侧那格照旧占「第一条 user 正文 = 任务」的名额（任务正文里裸写标记不是泄漏）", () => {
  // 形状：任务正文里**裸写**一个 `<｜｜DSML｜｜`（要求处理这种标记的任务，本仓的工单正文就是这种句子）。
  // 它按分类轴落进 `textualized_tool_call`，但那是**任务**不是交付物 ⇒ 不许被摸掉 mandatory 名额：
  // 摸掉之后预算一紧，评审就连任务都看不见了（与本单要拦的那件事无关，纯误伤）。
  const taskWithMarker = "任务：把 <｜｜DSML｜｜ calls 这类标记的处理补上，判据写在 judge.js 里。";
  assert.equal(deliverableKindOfBlock(textBlock(taskWithMarker)), "textualized_tool_call",
    "前提：它在分类轴上确实落进新格（否则下面两格是恒真）");
  const filler = "中段填充。".repeat(120);
  const messages = [
    { role: "user", content: [textBlock(taskWithMarker)] },
    ...Array.from({ length: 6 }, (_, index) => ({
      role: "assistant",
      content: [textBlock(`${filler} 第 ${index} 段`)],
    })),
  ];
  const tight = renderConversation(messages, { maxTokens: 60 });
  assert.ok(tight.includes("任务：把"),
    "任务正文必须留下（它占着 mandatory 的「任务」名额）");
  assert.ok(tight.includes(TEXTUALIZED_TOOL_CALL_LABEL),
    "留下的那一格仍带中性标签：名额照占，地位不变");
});
