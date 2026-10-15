// erix_run 终稿核验（finalGuard）谓词的**离线**用例（issue #314 R2/R3 判据 C1–C5）。
// 全程不联网、不打模型：谓词是纯函数，成本计数注入假时钟。
// 跑法：node --test examples/pi-extension/erix-run-final-guard.test.mjs（也在 npm test 的 glob 里）
// 零依赖红线：只用 node: 内置 + 相对路径；纯 ESM。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFinalGuardTally,
  createFinalGuardVerify,
  collectToolResultText,
  ENGINE_FINAL_GUARD_MAX_RETRIES,
  extractDeclaredBases,
  findDerivedConclusionFlags,
  FINAL_DRAFT_PROMPT,
  FINAL_DRAFT_SECTIONS,
  FINAL_GUARD_TIMEOUT_MS,
  FINAL_GUARD_WORST_CASE_MS,
  inspectFinalDraft,
  isBaseTraceable,
  splitFinalDraft,
  summarizeFinalGuard,
} from "./erix-run-final-guard.js";

const SHA = "9c2a41b";
const OTHER_SHA = "deadbeef1234";

/** 一段四件套齐全、基点可溯源的终稿（C2 的「找得到」侧）。 */
function completeDraft({ base = SHA } = {}) {
  return [
    "## 取证边界",
    "- 只读了本仓工作树，跑了 git rev-parse --short HEAD",
    "- 没看 CI 历史",
    "",
    "## 基点",
    `- ${base}`,
    "",
    "## 结论",
    "- guard 谓词在 examples/pi-extension/erix-run-final-guard.js:1 起实现",
    "",
    "## 未验证",
    "- 无",
  ].join("\n");
}

/** 本次 run 的 messages：一条 tool_result 里真的出现过 SHA。 */
function messagesWith(text) {
  return [
    { role: "user", content: [{ type: "text", text: "任务正文" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "git rev-parse HEAD" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: text }],
    },
  ];
}

// ---------------------------------------------------------------------------
// C1 格式/存在性：缺段必须 revise，且文案点名缺的那一段
// ---------------------------------------------------------------------------

test("C1 缺 `## 基点` ⇒ revise，且 revise 文案点名该段（不许 accept）", () => {
  const draft = completeDraft().replace(/## 基点\n- [0-9a-f]+\n\n/u, "");
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise", JSON.stringify(decision));
  assert.ok(decision.message.includes("## 基点"), `文案必须点名缺的段，实际：${decision.message}`);
  assert.deepEqual(decision.missingSections, ["## 基点"]);
});

test("C1 四段全缺 ⇒ revise 文案把四段都点出来（段名与 FINAL_DRAFT_SECTIONS 同源）", () => {
  const decision = inspectFinalDraft({ finalText: "任务已完成，随便改了改。", messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  for (const section of FINAL_DRAFT_SECTIONS) {
    assert.ok(decision.message.includes(section), `文案缺 ${section}：${decision.message}`);
    assert.ok(FINAL_DRAFT_PROMPT.includes(section), `提示词槽位缺 ${section}`);
  }
});

test("C1 只缺 `## 未验证` ⇒ 点名该段且不牵连其它段", () => {
  const draft = completeDraft().replace(/\n\n## 未验证\n- 无$/u, "");
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.missingSections, ["## 未验证"]);
  assert.ok(decision.message.includes("## 未验证"));
});

// ---------------------------------------------------------------------------
// C2 基点溯源 = 唯一硬闸：两个方向都要钉住
// ---------------------------------------------------------------------------

test("C2 基点声明值在 tool_result 里找不到 ⇒ revise（fail closed，绝不 accept）", () => {
  const decision = inspectFinalDraft({
    finalText: completeDraft({ base: OTHER_SHA }),
    messages: messagesWith(`HEAD 现在是 ${SHA}\n`),
  });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.untraceableBases, [OTHER_SHA]);
  assert.ok(decision.message.includes(OTHER_SHA), "文案要点名对不上的那个值");
});

test("C2 基点声明值在 tool_result 里逐字找得到 ⇒ accept（= 引擎侧会写 verified）", () => {
  const decision = inspectFinalDraft({
    finalText: completeDraft({ base: SHA }),
    messages: messagesWith(`On branch main\nHEAD detached at ${SHA}\n`),
  });
  assert.equal(decision.action, "accept", JSON.stringify(decision));
  assert.equal(decision.message, undefined);
  assert.deepEqual(decision.declaredBases, [SHA]);
});

test("C2 只有 `## 基点` 段的值参与溯源；结论段里的文件名不被当基点", () => {
  const { declaredBases } = inspectFinalDraft({
    finalText: completeDraft(),
    messages: messagesWith(SHA),
  });
  assert.deepEqual(declaredBases, [SHA], `结论段的 erix-run-final-guard.js:1 不该进基点清单：${declaredBases}`);
});

test("C2 基点只在 assistant 正文里出现过（不在 tool_result）⇒ 仍然 revise", () => {
  // 模型自己复述过一遍不算证据：来源必须是工具返回。
  const messages = [
    { role: "assistant", content: [{ type: "text", text: `我看到 ${SHA}` }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "无此值" }] },
  ];
  assert.equal(collectToolResultText(messages), "无此值");
  assert.equal(inspectFinalDraft({ finalText: completeDraft(), messages }).action, "revise");
});

test("C2 tool_result 的两种内容形状（字符串 / 块数组）都要能取到文本", () => {
  const blocks = [{
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: `tag v0.21.0` }, { type: "text", text: "另一段" }],
    }],
  }];
  assert.ok(collectToolResultText(blocks).includes("tag v0.21.0"));
  assert.equal(
    inspectFinalDraft({ finalText: completeDraft({ base: "v0.21.0" }), messages: blocks }).action,
    "accept",
  );
});

test("C2 `## 基点` 写了「无」⇒ 没有任何声明值 ⇒ revise（不许当成免检）", () => {
  const draft = completeDraft().replace(`- ${SHA}`, "- 无");
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.declaredBases, []);
  assert.ok(decision.message.includes("基点"), `文案要点名基点段，实际：${decision.message}`);
});

test("C2 多个基点里只要有一条对不上就 revise（逐条核验，不取「多数通过」）", () => {
  const draft = completeDraft().replace(`- ${SHA}`, `- ${SHA}\n- ${OTHER_SHA}`);
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.untraceableBases, [OTHER_SHA]);
});

test("extractDeclaredBases 认反引号 / 裸 SHA / 版本号，去重且顺序稳定", () => {
  const body = "\n- `9c2a41b`\n- 9c2a41b\n- v0.21.0\n- 0.21.0\n";
  assert.deepEqual(extractDeclaredBases(body).map((e) => e.literal), ["9c2a41b", "v0.21.0", "0.21.0"]);
});

test("isBaseTraceable：十六进制忽略大小写，非十六进制逐字（大小写不同就是找不到）", () => {
  assert.equal(isBaseTraceable("9C2A41B", `head at ${SHA}`), true);
  assert.equal(isBaseTraceable("Release-Note", "release-note 出现过"), false);
});

test("splitFinalDraft 取到段正文，缺段进 missing", () => {
  const { found, missing } = splitFinalDraft(completeDraft());
  assert.equal(found["## 基点"].trim(), `- ${SHA}`);
  assert.deepEqual(missing, []);
  assert.deepEqual(splitFinalDraft("## 结论\nx").missing, ["## 取证边界", "## 基点", "## 未验证"]);
});

// ---------------------------------------------------------------------------
// C4 派生结论只提醒，不硬拒
// ---------------------------------------------------------------------------

test("C4 跨口径比值标本（1:N / 百分比 / 总计）仍被 accept，但 flags 里有提醒", () => {
  const draft = `${completeDraft()}\n\n总计：命中 3 条，比例 1:5，覆盖率 33%。`;
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "accept", `提醒不该拦下终稿：${decision.message}`);
  const kinds = decision.ratioFlags.map((flag) => flag.kind);
  for (const kind of ["ratio", "percent", "total"]) {
    assert.ok(kinds.includes(kind), `缺 ${kind} 提醒：${JSON.stringify(decision.ratioFlags)}`);
  }
  assert.ok(decision.ratioFlags.every((flag) => typeof flag.sample === "string" && flag.sample.length > 0));
});

test("C4 没有派生结论时 flags 是空数组（不是 undefined，也不误报）", () => {
  assert.deepEqual(inspectFinalDraft({ finalText: completeDraft(), messages: messagesWith(SHA) }).ratioFlags, []);
});

test("findDerivedConclusionFlags 样本上限 10 条（提醒不该淹掉终局面）", () => {
  const flags = findDerivedConclusionFlags("总计\n".repeat(30));
  assert.ok(flags.length <= 10, `实际 ${flags.length} 条`);
});

// ---------------------------------------------------------------------------
// R3 成本计数：次数 / 累计耗时 / revise 轮数都要留痕（假时钟，不打模型）
// ---------------------------------------------------------------------------

test("createFinalGuardVerify 记 calls / elapsedMs / reviseRounds（注入假时钟）", async () => {
  const tally = createFinalGuardTally();
  let clock = 1_000;
  // 谓词本身耗时 250ms（假时钟在谓词里走），两次调用**之间**的 1_500ms 不得计入 guard 成本。
  const inspect = (payload) => {
    clock += 250;
    return inspectFinalDraft(payload);
  };
  const verify = createFinalGuardVerify({ tally, inspect, now: () => clock });
  const payloads = [
    { finalText: completeDraft(), messages: messagesWith(SHA) },
    { finalText: "缺段", messages: messagesWith(SHA) },
  ];
  const decisions = [];
  for (const payload of payloads) {
    decisions.push(await verify(payload));
    clock += 1_500;
  }
  assert.deepEqual(decisions.map((d) => d.action), ["accept", "revise"]);
  assert.equal(tally.calls, 2);
  assert.equal(tally.accepted, 1);
  assert.equal(tally.reviseRounds, 1);
  assert.equal(tally.elapsedMs, 500, `只该累加谓词自身的墙钟：${tally.elapsedMs}`);
  assert.equal(tally.enabled, true);
  assert.equal(tally.source, "host finalGuard wrapper (erix-run-final-guard.js)");
});

test("谓词抛错 ⇒ revise（fail closed：出错绝不默认 accept），并记 invalidDecisions", async () => {
  const tally = createFinalGuardTally();
  const verify = createFinalGuardVerify({ tally, inspect: () => { throw new Error("boom"); } });
  const decision = await verify({ finalText: completeDraft(), messages: [] });
  assert.equal(decision.action, "revise");
  assert.equal(tally.invalidDecisions, 1);
  assert.equal(tally.accepted, 0);
});

test("谓词返回 undefined ⇒ revise（没有决策就是没有通过）", async () => {
  const verify = createFinalGuardVerify({ inspect: () => undefined });
  assert.equal((await verify({})).action, "revise");
});

test("onObserve 抛错不能把 guard 带死（观测面不参与裁决）", async () => {
  const verify = createFinalGuardVerify({ onObserve: () => { throw new Error("observer down"); } });
  assert.equal((await verify({ finalText: completeDraft(), messages: messagesWith(SHA) })).action, "accept");
});

test("成本行把「最坏多 ≤2 个模型往返 + 3 × finalGuardTimeoutMs 等待」写清，并给出小超时", () => {
  const line = summarizeFinalGuard(createFinalGuardTally());
  assert.match(line, /calls=0/u);
  assert.match(line, /revise=0\/2/u);
  assert.match(line, /最坏额外/u);
  assert.equal(FINAL_GUARD_TIMEOUT_MS, 10_000, "开启时必须显式给小值，别靠引擎默认 30s");
  assert.ok(FINAL_GUARD_TIMEOUT_MS < 30_000);
  assert.equal(ENGINE_FINAL_GUARD_MAX_RETRIES, 2);
  assert.equal(FINAL_GUARD_WORST_CASE_MS, 3 * FINAL_GUARD_TIMEOUT_MS);
});

test("默认关的那一行不含任何「已核验」措辞", () => {
  const line = summarizeFinalGuard(undefined);
  assert.match(line, /disabled/u);
  assert.doesNotMatch(line, /calls=\d+/u);
});

test("谓词是异步的也要 await（真 guard 会读盘/调小模型；交给引擎的必须是决策而不是 Promise）", async () => {
  const verify = createFinalGuardVerify({ inspect: async () => ({ action: "accept" }) });
  const decision = await verify({});
  assert.equal(decision.action, "accept", JSON.stringify(decision));
  assert.notEqual(decision.action, undefined, "把 Promise 当决策交出去 ⇒ 引擎报 invalid decision");
});
