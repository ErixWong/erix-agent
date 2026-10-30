// issue #605 真机复跑（**一次性脚本，不是门禁**）：分段折叠块的「近期给全 / title / 头行」三处修复。
//
// ⚠ **本脚本是「统计臂」（`strategy: "fold-statistical"`）的回归，不是默认路径的覆盖。**
// #614 之后 CLI 的默认策略是 `fold-llm`，所以这里钉死 `fold-statistical` 意味着**它验的不再是默认
// 那条路**。默认臂（`fold-llm`）的覆盖在 `examples/fold-default-real-e2e.mjs`（= `check:release:real`
// 第 ⑥ 步，issue #619），那边断言的是「语义分节在场 / 摘要器请求 ≥1 / 被折轮次 TOK 标记逐字保留 /
// 摘要器超时降级」——比这里更贴近默认路径。
//
// 为什么**不**把这里也改成双臂（两个策略各跑一遍 30 段）：
//   · 本脚本的三条断言全是**统计渲染器**的形状（`- 第 a–b 轮 · title` 分段行、`工具足迹`、头行
//     「覆盖第 a–b 轮 / 其中 N 轮未经折叠」）。`fold-llm` 的块是「LLM 摘要 + 机械保真层」，
//     **没有** `FOLD_SUMMARY_MARKER`、也没有分段行 ⇒ 默认臂在这份判据里**无话可说**，加它只会
//     多烧 30 轮真金；
//   · 默认路径的覆盖已经由第 ⑥ 步做得更全（多了摘要器计数与降级路），重复覆盖不产生新信息；
//   · 代价：本脚本本身已是 30 段长跑（实测 40 轮那一档要 800 s），双臂 = 翻倍。
// 于是这里改成**显式标注统计臂**：日志前缀一律带 `[统计臂]`，而「块按 `FOLD_SUMMARY_MARKER`
// 定位」这件事本身就是机械判据——谁把 `strategy` 换成默认的 `fold-llm`，块里就没有那个统计标记，
// 脚本会在 `折叠块根本没出现` 上当场红，而不是「静默变成另一个东西」。
//
// 复现 issue 正文的现场：30 段逐段翻译（每段一次 `getParagraph(i)`）+ `config.folding.context`
// `{ budgetTokens: 4000, strategy: "fold-statistical" }` + `maxRounds: 60` + `ERIX_NO_REFLECTION=1`。
//
// 用法（**只有显式开门才跑**，缺省打印 skip 并退出 0）：
//   ERIX_E2E_REAL=1 ERIX_NO_REFLECTION=1 node examples/fold-605-real-e2e.mjs
//
// 真上游一律走 `examples/e2e-real-gate.mjs#resolveRealUpstream()`：模型名从 `gate.slot.model` 取，
// 源码里不写死任何模型名；缺配置 / 凭据解不出 / 端点不可达分别报分类原因（不伪装成 skipped）。
//
// 三条断言（issue 正文判据 5）：
//   ① 近期每一条都有清单（该折有工具调用时）；
//   ② 任何一折的 title 里都没有恢复提示；
//   ③ 头行的覆盖措辞不撒谎（有空洞就必须显式写出来，且数字与逐折区间算出来的一致）。
//
// 隔离：不写任何 `~/.erix` 产物（不给 store）；唯一的输出是 stdout 上的块原文。

import { createOpenAIProvider, runToolLoop } from "../src/index.js";
import { FOLD_SUMMARY_MARKER } from "../src/compact/fold-statistical.js";
import { formatSkip, printableEndpoint, resolveRealUpstream } from "./e2e-real-gate.mjs";

const SEGMENTS = 30;
const SEGMENT_LINE = /^- 第 (\d+)–(\d+) 轮(?:（(\d+) 轮）)? · (.*)$/u;
const RECOVERY_HINT_MARK = "需要原文请重读";

/** 第 i 段中文原文（约 120 字，内容确定 ⇒ 不靠随机数）。 */
function paragraphOf(index) {
  return `第 ${index} 段：这一段讲的是上下文折叠之后的记忆负担问题，`
    + `作者用三十段彼此独立的说明文字来模拟一次长任务，`
    + `每段都要求逐段翻译，因此模型必须真的把每一段取回来再动手，`
    + `而不能凭猜测补齐内容，否则后面的段落会对不上。`;
}

const TOOLS = [{
  name: "getParagraph",
  description: "取回第 index 段中文原文（一次一段）",
  inputSchema: {
    type: "object",
    properties: { index: { type: "string", description: "段号，1 到 30" } },
    required: ["index"],
  },
}];

const executeTool = async ({ name, input }) => {
  if (name !== "getParagraph") return `unknown tool: ${name}`;
  const index = Number.parseInt(String(input?.index ?? ""), 10);
  if (!Number.isSafeInteger(index) || index < 1 || index > SEGMENTS) {
    return `段号越界：${String(input?.index)}（合法范围 1–${SEGMENTS}）`;
  }
  return paragraphOf(index);
};

/** 块里那三条断言；返回失败清单（空 = 全绿）。 */
function judgeBlock(block) {
  const problems = [];
  const lines = block.split("\n");
  const header = lines[0];
  const segmentLines = lines.filter((line) => SEGMENT_LINE.test(line));
  const segments = segmentLines.map((line) => {
    const match = line.match(SEGMENT_LINE);
    return {
      from: Number.parseInt(match[1], 10),
      to: Number.parseInt(match[2], 10),
      title: match[4],
    };
  });

  // ① 近期每一条都要有清单（该折有工具调用时）。近期小节 = 头两行之后、`更早` 之前。
  const olderIndex = lines.findIndex((line) => line.startsWith("更早（"));
  const recentLines = lines.slice(1, olderIndex < 0 ? lines.length : olderIndex);
  const recentStarts = recentLines
    .map((line, index) => (SEGMENT_LINE.test(line) ? index : -1))
    .filter((index) => index >= 0);
  for (const [position, start] of recentStarts.entries()) {
    const end = recentStarts[position + 1] ?? recentLines.length;
    const body = recentLines.slice(start + 1, end);
    const titleLine = recentLines[start];
    const footprintInTitle = titleLine.includes("工具足迹：") && !titleLine.includes("工具足迹：无");
    const footprintLine = body.some((line) => /^\s*工具足迹：(?!无)/u.test(line));
    const hasCalls = footprintInTitle || footprintLine;
    const hasInventory = body.some((line) => line.trimStart().startsWith("工具调用清单"));
    if (hasCalls && !hasInventory) {
      problems.push(`近期折叠缺清单：${titleLine}`);
    }
  }

  // ② 任何一折的 title 都不得含恢复提示。
  for (const line of segmentLines) {
    if (line.includes(RECOVERY_HINT_MARK)) problems.push(`title 里混进恢复提示：${line}`);
  }

  // ③ 头行措辞诚实：把逐折区间算出来的空洞与头行声明的数字对账。
  const covered = new Set();
  for (const segment of segments) {
    for (let round = segment.from; round <= segment.to; round += 1) covered.add(round);
  }
  const from = Math.min(...segments.map((segment) => segment.from));
  const to = Math.max(...segments.map((segment) => segment.to));
  const missing = [];
  for (let round = from; round <= to; round += 1) if (!covered.has(round)) missing.push(round);
  const declared = header.match(/其中 (\d+) 轮未经折叠/u);
  if (missing.length === 0 && declared !== null) {
    problems.push(`头行声称有空洞，但逐折区间是连续的：${header}`);
  }
  if (missing.length > 0) {
    if (declared === null) problems.push(`头行没有交代 ${missing.length} 轮未经折叠（${missing.join(",")}）：${header}`);
    else if (Number.parseInt(declared[1], 10) !== missing.length) {
      problems.push(`头行说 ${declared[1]} 轮未经折叠，逐折区间算出来是 ${missing.length} 轮：${header}`);
    }
  }
  if (!header.includes(`覆盖第 ${from}–${to} 轮`)) {
    problems.push(`头行的区间端点与逐折记录不一致（逐折 ${from}–${to}）：${header}`);
  }

  return {
    problems,
    summary: {
      segments: segments.length,
      recent: recentStarts.length,
      uncovered: missing.length,
      uncoveredRounds: missing.join(",") || "无",
    },
  };
}

const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
if (!gate.ok) {
  console.log(`[605-real][统计臂] skip：${formatSkip(gate)}`);
  process.exit(0);
}

const providerFields = {
  endpoint: gate.endpoint,
  apiKey: gate.apiKey,
  model: gate.slot.model,
  contextWindowTokens: gate.slot.contextWindowTokens,
  maxOutputTokens: gate.slot.maxOutputTokens,
};
console.log(`[605-real][统计臂] model=${gate.slot.model} endpoint=${printableEndpoint(gate.endpoint)}`
  + `｜strategy=fold-statistical（默认臂 fold-llm 见 examples/fold-default-real-e2e.mjs / #619）`);

const result = await runToolLoop({
  provider: createOpenAIProvider(providerFields),
  tools: TOOLS,
  executeTool,
  config: {
    input: {
      // 与 issue 正文那次探针**同一句话**（从真账本里读回来的原话）：它强制「一轮一段、只输出译文」，
      // 于是轮数真的会堆到 40+ 并折出 9 次左右 —— 这正是要复现的现场形状。
      initialUserMessage: "把源文本逐段翻译成英文：第 i 步调用 getParagraph(i) 取第 i 段，"
        + "然后**只输出这一段**的英文译文，不要复述原文、不要合并多段。"
        + `从 1 到 ${SEGMENTS} 依次做完，最后一行写 DONE。`,
      wrapup: false,
    },
    run: { runId: "fold-605-real", maxRounds: 60, completion: false, reflection: false },
    folding: { context: { budgetTokens: 4_000, strategy: "fold-statistical" } },
  },
});

console.log(`[605-real] termination=${JSON.stringify(result.termination)} rounds=${result.rounds}`
  + ` ↑${result.usage?.input_tokens}/↓${result.usage?.output_tokens}`);

const block = result.messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
  .filter((blockItem) => blockItem?.type === "text")
  .map((blockItem) => String(blockItem.text ?? ""))
  .find((text) => text.includes(FOLD_SUMMARY_MARKER));

if (block === undefined) {
  console.log("[605-real][统计臂] FAIL 折叠块根本没出现（预算没触发折叠？）");
  process.exit(1);
}

const blockText = block.slice(block.indexOf(FOLD_SUMMARY_MARKER));
console.log("=== 块原文 ===");
console.log(blockText);
console.log("=== 判据 ===");
const { problems, summary } = judgeBlock(blockText);
console.log(`[605-real][统计臂] 折叠 ${summary.segments} 次 / 近期 ${summary.recent} 条 / `
  + `空洞 ${summary.uncovered} 轮（${summary.uncoveredRounds}）`);
if (problems.length === 0) {
  console.log("PASS [605-real][统计臂] ① 近期每条都有清单 ② title 无恢复提示 ③ 头行措辞诚实");
  process.exit(0);
}
for (const problem of problems) console.log(`FAIL [605-real][统计臂] ${problem}`);
process.exit(1);
