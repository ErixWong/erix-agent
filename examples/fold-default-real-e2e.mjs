// issue #619 真机 e2e：**默认压缩策略**（`fold-llm`）在真上游下的完整形态。
//
// 为什么要有这一条：`check:release:model-e2e` 原来的 5 步（工具事实 / 崩溃续跑 / 跨版本 / pi extension /
// 装后 CLI）**没有一步碰压缩**，而 #611（摘要器提示词加「## 教训与坑」）与 #614（CLI 默认策略从
// `fold-statistical` 换成 `fold-llm`）改的正是这条路径。唯一碰折叠的真机脚本
// `examples/fold-605-real-e2e.mjs` 钉死 `strategy: "fold-statistical"` ⇒ **#614 之后，默认路径
// （fold-llm）在真机上零覆盖**。语义折叠的核心是一次**真实的模型调用**，坏行为只有真模型给得出
// （超时 / 不守分节格式 / 超输出预算 / 空返回 / 摘要没用），脚本化夹具永远给不出 ⇒ 这一条必须真跑。
//
// 用法（闸门与其余真机脚本同一口径，缺省 skip + 分类原因 + exit 0）：
//   ERIX_E2E_MODEL=1 node --test examples/fold-default-real-e2e.mjs
//
// issue #661（破坏性，本文件已跟上）：**摘要器失败不再是降级**。改前失败那一折返回一份统计摘要
// 替代物（块里多一段 `[fold-llm 摘要失败，已降级为统计摘要（原因: …）]`），run 照常 `end_turn`；
// 现在失败即抛 `KitError("summarizer_failed")`，run 以 `termination.reason === "failed"` 收尾，
// 那一折**什么都不应用**（无块、无 `compactionStats` 条目、无 `type:"compaction"` 事件）。所以下面
// 第 ⑤ 条已从「降级臂」反转成「失败臂」：判据是终局错误码，而那条降级标记降为**反向锁**。
//
// ---------------------------------------------------------------------------
// 为什么「预置历史 + 真模型只跑 1 轮」，而不是「10 段逐段翻译让模型自己跑 10 轮」
//
// 折叠的硬前提是**历史必须长到 `keepRounds`（默认 6）之外且超预算**。第一版照 issue 正文的题面
// （10 段逐段翻译 / 预算 10 000）让模型自己跑满 10 轮，实测**两次都不可用**：
//   · 预算 10 000 + keep 6 ⇒ 策略折完 `retained(6×~1.5k) + 摘要(≤1.4k) > 10 000` ⇒ 引擎落进
//     **预算兜底**（`sliding-window` 以 `keepRounds: 0` 把历史清空到 158 token）⇒ 模型看不见做到
//     第几段，重读重做：一次 run 从 11 轮涨到 **33 轮 / 98 257 ↑ / 237 s**，另一次 **40 轮 / 801 s**；
//   · 把预算收到 5 000 + keep 3 之后仍不稳：同一条用例两次跑，一次 11 轮全对，一次模型卡在第 4–6
//     段反复重读（编号行 `[1,2,3,4,2,3,4,5,3,4,5,6,…]`）。
// 结论：那是**在断言模型行为**（「10 段都做完」「按序推进」），而这道题正好踩在「模型会忘事」的
// 边界上——门禁不该建在一个不稳定现象上。改成「历史由测试预置、真模型只跑最后一轮」之后：
// **折叠必然发生**（历史是我们造的）、**run 只花一次主请求 + 一次摘要请求**（~1 分钟）、
// **模型行为方差与判据无关**（判据全落在引擎不变量上：块在不在、语义分节在不在、摘要器被调了几次、
// 机械锚点保没保住被折轮次的 TOK 标记、失败路是不是终局错误）。
//
// 预置历史走的是**文档化的输入通道** `config.input.messages`（= 顶层 `initialMessages`，
// `src/loop/config-namespace.js#CONFIG_LEAF_ALIASES` 里唯一那条别名）：它正是「这次要发什么」，
// 与 `store.load()` 折叠出来的消息流同形。没走 `store` + `run.resume` 是因为那是
// `examples/resume-real-e2e.test.mjs` 的**专有判据**（崩溃点矩阵 / 账本闭合），本文件不需要续跑语义，
// 也不想为了喂历史而在磁盘上落一份账本（本文件**一个字节也不写**）。
//
// ---------------------------------------------------------------------------
// 「默认」从哪里读（**这是本文件最容易写错的一处**）
//
// 库层 `resolveCompactionStrategy(undefined)` 返回 `undefined` = **不折叠**：「默认用哪个策略」是
// **宿主/CLI 的选择**，不是引擎的默认（`src/compact/strategy-resolution.js` 与
// `bin/config.js#DEFAULT_COMPACTION_STRATEGY` 的注释都写死了这条边界）。所以本文件不传
// `strategy: "fold-llm"` 字面量（那只是把「写死一条路径」从 605 挪到这里），而是用 CLI 自己的解析器
// `resolveCompactionStrategyName(undefined)` 取默认值 —— 于是**把 `bin/config.js` 的
// `DEFAULT_COMPACTION_STRATEGY` 改回 `"fold-statistical"`，默认臂的第 ①② 条断言必红**（反向证见报告）。
//
// ---------------------------------------------------------------------------
// 断言各自防什么（issue #619 判据表逐条落地；**测模型的那些已按裁决删掉**）
//
//   ① 折叠块出现，且含 `## 阶段` 或 `## 教训与坑` —— 语义层真的在（#611 第六节没丢）。
//   ② **摘要器请求数 ≥ 1**（包装 provider 计数，按 `SUMMARIZER_PROMPT_GUIDE` 首行认）—— 防
//      「跑成了统计摘要」蒙过关：统计摘要也产块、块里也有锚点节，只看块形状分不出语义与机械。
//      （#661 起失败不再降级，所以这一条的反向证只有第 ④ 条：显式统计策略那臂计数必须是 0。）
//   ③ 折叠块里 **被折轮次的 TOK 标记逐字保留** —— 机械保真层没被语义层挤掉，这是「语义 + 机械
//      两者都做」的回归守卫。**不要求**没被折的轮次（它们还在上下文里，不该出现在块里）。
//   ④ 显式 `strategy: "fold-statistical"` 的第二跑 ⇒ **摘要器 0 次**、块里是统计摘要标记 ——
//      反向证，证明第 ② 条测的是真的（不是「计数永远 ≥1」）。
//   ⑤ 失败路：摘要器超时配成 1ms（`folding.context.summarizerTimeoutMs`，`createProviderSummarizer`
//      的旋钮）⇒ **终局 `summarizer_failed`**（`details.kind === "timeout"`）、run 以 `failed` 收尾、
//      且块里**没有**降级标记 —— 失败路用自己的旋钮构造，不等模型抽风。issue #661 改前这一格断的是
//      「块里出现降级标记 + run 正常 `end_turn`」，那条替代物已被删（见文件头 #661 段）。
//
// 已删除（裁决：测的是模型行为，不是引擎不变量）：~~10 段全译完 / 编号行按序 1..10~~。
//
// ---------------------------------------------------------------------------
// 第 ③ 条为什么把标记长在**路径**里（`notes/TOK-<i>-<rand>.md`）
//
// 机械保真层（`src/compact/anchors.js`）只机械抽取 URL / 路径 / SHA / issue 号 / 错误行——**任意
// token 不在抽取面内**。所以「TOK 标记逐字保留」若指望模型复述，就变成赌模型自由（真机 e2e 赌
// 这个 = 随机假红）；把它放进路径形态，测的才是**产品真有的那一层**：语义摘要之后，机械锚点节
// 是否还在（`appendFoldFidelity` 在 `enforceSummarySize` **之后**追加，预算削不掉它）。
// 离线自检那一条把这个机制钉住（`extractAnchors` 对同一份夹具必须吐出逐字标记）。
//
// 隔离：不给 store（`runToolLoop` 不落盘），只读 `~/.erix` 的配置；唯一的输出是 stdout 上的诊断行与块原文。

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOpenAIProvider, runToolLoop } from "../src/index.js";
import { ANCHOR_SECTION_HEADING, extractAnchors } from "../src/compact/anchors.js";
import { SUMMARIZER_PROMPT_GUIDE } from "../src/compact/fold-llm.js";
import { FOLD_SUMMARY_MARKER } from "../src/compact/fold-statistical.js";
import { DEFAULT_COMPACTION_STRATEGY, resolveCompactionStrategyName } from "../bin/config.js";
import { estimateMessageTokens } from "../src/tokens.js";
import { formatSkip, printableEndpoint, resolveRealUpstream } from "./e2e-real-gate.mjs";

/**
 * 摘要器提示词指南的**首行**：包装 provider 靠它把「摘要器那一发」与「主循环那一发」分开。
 * 从 `src/compact/fold-llm.js` 导入（**不抄字面量**）：指南改一个字，这里的分类跟着改，不会静默失效。
 */
const GUIDE_FIRST_LINE = SUMMARIZER_PROMPT_GUIDE.split("\n")[0];

/**
 * issue #661 **删掉**的那条降级前言的字面形态（`src/compact/fold-llm.js` 里已无此模板，也没有导出
 * 常量 ⇒ 只能按形状匹配）。本文件里它是**反向锁**：失败臂必须证明这条标记**不**出现。
 * 反向锁自己也要有正向对照（见下面离线自检 ⑤），否则「不许出现」可能只是因为正则永远匹配不上。
 */
const DEGRADE_PATTERN = /\[fold-llm 摘要失败，已降级为统计摘要（原因: .+）\]/u;

/** 预置历史的段数（每段 = 2 轮：工具轮 + 译文轮 ⇒ 20 轮 ≫ `keepRounds` 默认 6）。 */
const SEGMENTS = 10;
/**
 * 预算：预置历史实测 ~6.0k token ⇒ 取 5 000（留 20% 余量，诊断行会打出实测值）。
 *
 * 为什么留余量：`estimateMessageTokens` 在引擎里跑的是**同一把尺子**，但 `compactBeforeRound` 会先
 * `normalizeMessages`，贴着预算线（实测差 16 token 那次）就会「测试算超了、引擎算没超」⇒ 不折。
 * 余量 20% 之后折后 ≈ `retained(3 段≈1.8k) + 摘要(≤1.4k) < 5 000`，也不会落进预算兜底。
 */
const BUDGET_TOKENS = 5_000;
/** 真模型只需要跑 1 轮（降级路也一样）；8 是「模型非要调两次工具」的余量，不是让它跑长跑。 */
const MAX_ROUNDS = 8;

// 长任务默认会开 judge（>=16 轮）；本文件只要折叠，把反思整条关掉（显式 config 与 env 各写一遍）。
process.env.ERIX_NO_REFLECTION = "1";

// ---------------------------------------------------------------------------
// 预置历史（内容每段不同 ⇒ 锚点/摘要都不可能靠模板猜出来）
// ---------------------------------------------------------------------------

const THEMES = [
  ["上下文折叠", "长任务", "记忆负担"],
  ["发布清单", "真机验证", "闸门"],
  ["账本写入", "崩溃续跑", "行序"],
  ["工具结果", "降级", "占位符"],
  ["摘要器", "超时", "语义分节"],
  ["锚点索引", "机械抽取", "逐字保留"],
  ["预算", "触发阈值", "保留轮次"],
  ["跨版本", "读窗口", "兼容"],
  ["宿主契约", "端口注入", "能力面"],
  ["文档审计", "命令存在性", "中英成对"],
];
const VARIATIONS = [
  "一个可复现的失败", "一条必须保留的约束", "一次代价很高的试错", "一个被误读的数字",
];

/**
 * 第 index 段中文原文（~350 汉字 ≈ 600 token）：主题、句式、编号都随 index 变。
 *
 * 标记长在路径里（`notes/TOK-<i>-<rand>.md`）—— 理由见文件头「第 ③ 条为什么把标记长在路径里」。
 *
 * @param {number} index 1..SEGMENTS
 * @param {string} marker 该段的唯一标记
 * @returns {string}
 */
function paragraphOf(index, marker) {
  const [topic, concern, symptom] = THEMES[(index - 1) % THEMES.length];
  const parts = [];
  for (let line = 1; line <= 4; line += 1) {
    parts.push(`第 ${index} 段的第 ${line} 句只谈${topic}与${concern}：${symptom}在第 ${line} 次检查里表现为`
      + `${VARIATIONS[(index + line) % VARIATIONS.length]}，`
      + `编号 ${index}${String.fromCharCode(65 + (index % 26))}${line} 的观测要求逐段取回原文再动手，`
      + `不能凭猜测补齐，否则后面的段落会对不上。`);
  }
  return `第 ${index} 段（草稿来源 notes/${marker}.md）：${parts.join("")}`;
}

/** 任务提示词（head 里那条真实 user 消息）：历史已做完，本轮只收尾 ⇒ 模型只跑 1 轮。 */
function headPrompt() {
  return `逐段翻译：第 i 步调用 getParagraph(i) 取第 i 段中文原文，把这一段译成英文，`
    + `然后输出一行「<i>|<英文译文>」，并在行尾原样保留该段里的 TOK 标记（形如 TOK-<i>-<随机数>）。`
    + `不要复述原文、不要合并多段；从 1 到 ${SEGMENTS} 依次做完，最后一行写 DONE。`
    + `（历史里第 1–${SEGMENTS} 段已经逐段取回并译完；本轮不要再调用任何工具，只用一行输出 ALL-DONE。）`;
}

const TOOLS = [{
  name: "getParagraph",
  description: `取回第 index 段中文原文（一次一段，共 ${SEGMENTS} 段）`,
  inputSchema: {
    type: "object",
    properties: { index: { type: "string", description: `段号，1 到 ${SEGMENTS}` } },
    required: ["index"],
  },
}];

/**
 * 造一份「已经跑到第 SEGMENTS 段」的历史：每段 = 工具轮（assistant `tool_use` + user `tool_result`）
 * + 译文轮（assistant 正文）。轮数因此是 `2 × SEGMENTS`，**远多于** `keepRounds` 默认 6 ⇒ 开圈必折。
 *
 * @param {Map<number, string>} markers
 * @returns {object[]}
 */
function buildHistory(markers) {
  const messages = [{ role: "user", content: [{ type: "text", text: headPrompt() }] }];
  for (let index = 1; index <= SEGMENTS; index += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `取第 ${index} 段。` },
        { type: "tool_use", id: `hist-${index}`, name: "getParagraph", input: { index: String(index) } },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `hist-${index}`, content: paragraphOf(index, markers.get(index)) }],
    });
    messages.push({
      role: "assistant",
      content: [{
        type: "text",
        text: `${index}|Paragraph ${index} is about ${THEMES[(index - 1) % THEMES.length][0]}. ${markers.get(index)}`,
      }],
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// 判据用的纯函数（离线自检那一条直接钉它们，防止悄悄退化成「永远为真」）
// ---------------------------------------------------------------------------

const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : []);

/** 真实 user 消息（`tool_result` 载体不算）——折叠摘要被 `prependSummary` 塞进它的 `content[0]`。 */
function isRealUser(message) {
  if (message?.role !== "user") return false;
  const blocks = blocksOf(message);
  return typeof message.content === "string"
    || blocks.length === 0
    || blocks.some((block) => block?.type !== "tool_result");
}

/**
 * 从「折叠后的消息流」里取出折叠块原文。
 *
 * `prependSummary` 把摘要插进第一条真实 user 消息的 `content[0]`，原文退到 `content[1..]`
 * ⇒ `texts[0]` 就是**当前上下文里那一块**。三种「没有块」必须能分开：
 *   · 没折叠 ⇒ content 还是字符串 / `texts[0]` 就是原始提示词 ⇒ 返回 `undefined`；
 *   · 折了但摘要为空 ⇒ 也返回 `undefined`（不许把原文当成摘要块）。
 *
 * @param {object[]} messages
 * @param {string} originalText 原始提示词（用来排除「content[0] 还是它」的情形）
 * @returns {string|undefined}
 */
function foldBlockOf(messages, originalText) {
  const user = (Array.isArray(messages) ? messages : []).find(isRealUser);
  const texts = blocksOf(user)
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""));
  const first = texts[0];
  if (first === undefined || first.trim() === "" || first === originalText) return undefined;
  return first;
}

/** 请求是不是「摘要器那一发」（按指南首行认，不按 `tools` 是否为空猜）。 */
const isSummarizerRequest = (request) => JSON.stringify(request?.messages ?? []).includes(GUIDE_FIRST_LINE);

// ---------------------------------------------------------------------------
// 跑一条臂（真上游；provider 包一层计数，折叠钩子留快照）
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   runId: string,
 *   gate: Awaited<ReturnType<typeof resolveRealUpstream>> & { ok: true },
 *   strategy?: string,
 *   summarizerTimeoutMs?: number,
 * }} options
 */
async function runArm({ runId, gate, strategy, summarizerTimeoutMs }) {
  const markers = new Map();
  for (let index = 1; index <= SEGMENTS; index += 1) {
    markers.set(index, `TOK-${index}-${randomBytes(4).toString("hex")}`);
  }
  const history = buildHistory(markers);
  const originalText = headPrompt();

  const inner = createOpenAIProvider({
    endpoint: gate.endpoint,
    apiKey: gate.apiKey,
    model: gate.slot.model,
    contextWindowTokens: gate.slot.contextWindowTokens,
    maxOutputTokens: gate.slot.maxOutputTokens,
  });
  const counts = { summarizer: 0, main: 0 };
  const provider = {
    ...inner,
    chat: (request) => {
      if (isSummarizerRequest(request)) counts.summarizer += 1;
      else counts.main += 1;
      return inner.chat(request);
    },
  };

  /** 折叠后快照（块原文 + 被折区间）。 */
  const afterFold = [];
  const beforeFold = [];

  const executeTool = async ({ name, input }) => {
    if (name !== "getParagraph") return `unknown tool: ${name}`;
    const index = Number.parseInt(String(input?.index ?? ""), 10);
    if (!Number.isSafeInteger(index) || index < 1 || index > SEGMENTS) {
      return `段号越界：${String(input?.index)}（合法范围 1–${SEGMENTS}；本任务已做完）`;
    }
    return paragraphOf(index, markers.get(index));
  };

  const startedAt = Date.now();
  // issue #661：摘要器失败是**终局错误** ⇒ `runToolLoop` 直接 reject（不再返回降级替代物）。
  // 失败臂要断的正是这个异常，所以在这里接住它，而不是让整条 e2e 以未捕获拒绝崩掉
  // （那样连「哪一条断言红了」都看不出来）。成功臂 `failure === undefined`。
  let result;
  let failure;
  try {
    result = await runToolLoop({
      provider,
      tools: TOOLS,
      executeTool,
      config: {
        input: { messages: history, wrapup: false },
        run: { runId, maxRounds: MAX_ROUNDS, completion: false, reflection: false },
        folding: {
          context: {
            budgetTokens: BUDGET_TOKENS,
            ...(strategy === undefined ? {} : { strategy }),
            ...(summarizerTimeoutMs === undefined ? {} : { summarizerTimeoutMs }),
          },
        },
      },
      capabilities: {
        hooks: {
          onBeforeFold: ({ messages }) => { beforeFold.push(messages); },
          onAfterFold: ({ messages, foldedRoundRange }) => { afterFold.push({ messages, foldedRoundRange }); },
        },
      },
    });
  } catch (error) {
    failure = error;
  }

  const stats = (Array.isArray(result?.compactionStats) ? result.compactionStats : []).map((stat) => ({
    strategy: stat.strategyName,
    foldedRounds: stat.foldedRounds,
    tokensBefore: stat.tokensBefore,
    tokensAfter: stat.tokensAfter,
    // issue #661：这一格改前报 `foldSummary.degradeKind`，那条降级路径删掉后它永远是 `undefined`
    // （一个空格子）。降级事实现在只能随异常走 ⇒ 改报**真实存在**的字段：摘要器那一发的结果状态
    // （`createProviderSummarizer` 的 `onMeta` → 引擎写进 `compactionStats[].foldSummary`，
    // 字段实测为 `finishReason` / `inputTokens` / `outputTokens` / `inputTruncated` / `droppedMessages`）。
    // 口径与契约同源：**无事实 ⇒ 无键**——`fold-statistical` 那臂根本不调摘要器、没有 `foldSummary`，
    // 就不许给它编一个数（那只是把一个空格子换成一个假格子）。
    ...(stat.foldSummary === undefined
      ? {}
      : {
        ...(stat.foldSummary.finishReason === undefined
          ? {}
          : { summarizerFinishReason: stat.foldSummary.finishReason }),
        ...(stat.foldSummary.inputTokens === undefined && stat.foldSummary.outputTokens === undefined
          ? {}
          : { summarizerTokens: `${stat.foldSummary.inputTokens ?? "-"}↑/${stat.foldSummary.outputTokens ?? "-"}↓` }),
      }),
  }));

  return {
    result,
    failure,
    counts,
    markers,
    stats,
    historyTokens: estimateMessageTokens(history),
    elapsedMs: Date.now() - startedAt,
    block: afterFold.length === 0 ? undefined : foldBlockOf(afterFold.at(-1).messages, originalText),
    foldedRoundRange: afterFold.length === 0 ? undefined : afterFold.at(-1).foldedRoundRange,
    folds: afterFold.length,
    beforeFoldRounds: beforeFold.length,
  };
}

/** 每条臂开跑前的固定诊断行（报告要贴的就是这些数字）。失败臂没有 `result`，改打终局异常。 */
function reportArm(label, arm, strategyName) {
  const { result, failure } = arm;
  const termination = result?.termination ?? failure?.termination;
  console.log(`[619] ${label} strategy=${strategyName} 耗时=${(arm.elapsedMs / 1000).toFixed(1)}s`
    + ` termination=${JSON.stringify(termination)} rounds=${result?.rounds ?? 0}`
    + ` ↑${result?.usage?.input_tokens ?? "-"}/↓${result?.usage?.output_tokens ?? "-"}`
    + (failure === undefined
      ? ""
      : ` 终局异常=${failure.code}/${String(failure.details?.kind)}（errorCode=${String(failure.errorCode)}）`));
  console.log(`[619] ${label} 预置历史=${arm.historyTokens} token（预算 ${BUDGET_TOKENS}）`
    + `｜摘要器请求=${arm.counts.summarizer} 主循环请求=${arm.counts.main} 折叠次数=${arm.folds}`
    + `｜被折区间=${JSON.stringify(arm.foldedRoundRange)}`);
  console.log(`[619] ${label} compactionStats=${JSON.stringify(arm.stats)}`);
  console.log(`[619] ${label} 模型终稿=${JSON.stringify(String(result?.finalText ?? "").slice(0, 200))}`);
}

/** 真上游闸门：关着 ⇒ `t.skip` 分类原因（与其余真机脚本同形，`npm test` 必须离线可重复）。 */
async function gateOrSkip(t) {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    t.skip(`真上游不可用/闸门关：${formatSkip(gate)}`);
    return undefined;
  }
  console.log(`[619] 闸门开：model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)}`
    + `｜CLI 默认压缩策略=${DEFAULT_COMPACTION_STRATEGY}`);
  return gate;
}

/** 「块没出现」时的统一诊断：先点名**构造**（预置历史够不够大），别让它退化成「什么都没发生也算过」。 */
function assertBlockPresent(arm, label) {
  assert.notEqual(arm.block, undefined,
    `${label}没折出块。先看构造：预置历史 ${arm.historyTokens} token / 预算 ${BUDGET_TOKENS}`
    + `（要 > 预算才折）、折叠次数=${arm.folds}、compactionStats=${JSON.stringify(arm.stats)}`
    + `、termination=${JSON.stringify(arm.result?.termination)}。构造够大还不折 ⇒ 是产品没折，不是模型没跑。`);
}

// ---------------------------------------------------------------------------
// 离线自检（始终跑，不联网）：钉住判据本身，防止它们悄悄退化成永远为真
// ---------------------------------------------------------------------------

test("断言集自身的不变量：摘要器分类 / 折叠块定位 / 机械锚点保真 / 降级前言反向锁（始终跑，不联网）", () => {
  const marker = "TOK-3-deadbeef";
  const original = headPrompt();

  // ① 摘要器分类：指南首行在场 ⇒ 摘要器；主循环请求（无指南）⇒ 主循环。
  assert.equal(isSummarizerRequest({ messages: [{ role: "user", content: `${GUIDE_FIRST_LINE}\n【被折叠的轮次】…` }] }), true,
    "带摘要器指南首行的请求必须判成摘要器那一发");
  assert.equal(isSummarizerRequest({ messages: [{ role: "user", content: original }] }), false,
    "主循环请求不许被算成摘要器（否则判据 ② 恒真）");

  // ② 折叠块定位：`prependSummary` 的形状（摘要进 content[0]、原文退到后面）要能取出摘要；
  //    没折叠（content 是字符串 / content[0] 还是原文）必须返回 undefined——否则「没折」会被读成「折了」。
  const foldedMessages = [{
    role: "user",
    content: [{ type: "text", text: "## 阶段\n取了第 3 段" }, { type: "text", text: original }],
  }];
  assert.equal(foldBlockOf(foldedMessages, original), "## 阶段\n取了第 3 段", "折叠块必须取 content[0]");
  assert.equal(foldBlockOf([{ role: "user", content: original }], original), undefined, "没折叠时必须返回 undefined");
  assert.equal(foldBlockOf([{ role: "user", content: [{ type: "text", text: original }] }], original), undefined,
    "content[0] 还是原始提示词时不许当成折叠块");

  // ③ 机械保真层真的会保标记：同一份夹具（标记长在路径里）⇒ 锚点节逐字含它。
  //    这条钉的是判据 ③ 的机制本身——锚点抽取面一旦收缩，真机那条会变成赌模型复述。
  const anchors = extractAnchors([
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: paragraphOf(3, marker) }] },
  ]);
  assert.equal(anchors.text.includes(ANCHOR_SECTION_HEADING), true, "锚点节标题必须在场");
  assert.equal(anchors.text.includes(marker), true,
    `锚点节没逐字保住 TOK 标记（判据 ③ 的机制塌了）：${anchors.text}`);

  // ④ 预置历史真的够大：轮数 > keepRounds 默认 6，且估算 token > 预算（判据「折叠必然发生」的前提）。
  const markers = new Map(Array.from({ length: SEGMENTS }, (_, position) => [position + 1, `TOK-${position + 1}-cafebabe`]));
  const history = buildHistory(markers);
  assert.ok(estimateMessageTokens(history) > BUDGET_TOKENS * 1.15,
    `预置历史只有 ${estimateMessageTokens(history)} token，离预算 ${BUDGET_TOKENS} 太近（要 > 1.15 倍）`
    + " ⇒ 引擎侧 normalize 之后可能算不超，折叠就不会发生");
  assert.ok((history.length - 1) / 2 > 6, `预置历史只有 ${(history.length - 1) / 2} 轮，没超过 keepRounds 默认 6`);

  // ⑤ issue #661 降级前言的反向锁：先证明这个正则**真的认得出**那条被删掉的标记，否则失败臂的
  //    「不许出现」可能只是因为正则永远匹配不上（恒真的反向锁比没有锁更坏）。
  assert.equal(DEGRADE_PATTERN.test("[fold-llm 摘要失败，已降级为统计摘要（原因: timeout）]"), true,
    "DEGRADE_PATTERN 认不出 #661 删掉的那条标记 ⇒ 失败臂的反向锁是恒真的");
  assert.equal(DEGRADE_PATTERN.test("## 阶段\n取了第 3 段"), false,
    "DEGRADE_PATTERN 匹配正常摘要 ⇒ 失败臂的反向锁会假红");
});

// ---------------------------------------------------------------------------
// 判据 ①②③：默认策略（`bin/config.js#DEFAULT_COMPACTION_STRATEGY`）那一臂
// ---------------------------------------------------------------------------

test("真上游 e2e（默认策略臂）：默认 fold-llm ⇒ 块在 + 语义分节 + 摘要器请求 ≥1 + 被折轮次标记逐字保留", {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const gate = await gateOrSkip(t);
  if (gate === undefined) return;

  // 「默认」= CLI 的默认（不传 --compaction 时那个值）。**不写字面量**：写死就等于又钉了一条路径。
  const strategyName = resolveCompactionStrategyName(undefined);
  const arm = await runArm({ runId: "fold-default-real-619", gate, strategy: strategyName });
  reportArm("默认臂", arm, strategyName);

  // 判据 ① 折叠块出现，且含语义分节（`## 阶段` 或 `## 教训与坑`）。
  assertBlockPresent(arm, "默认臂");
  console.log("=== 默认臂折叠块原文 ===");
  console.log(arm.block);
  assert.equal(/^## (阶段|教训与坑)/mu.test(arm.block), true,
    `折叠块里没有语义分节（## 阶段 / ## 教训与坑）——语义层没在？块原文：${arm.block.slice(0, 600)}`);

  // 判据 ② 摘要器请求数 ≥ 1：防「降级成统计摘要」蒙过关（降级也产块，块里也有锚点节）。
  assert.ok(arm.counts.summarizer >= 1,
    `摘要器一次都没被调用（默认策略跑成了统计摘要？）：counts=${JSON.stringify(arm.counts)}`
    + ` compactionStats=${JSON.stringify(arm.stats)}`);

  // 判据 ③ 机械保真层没被语义层挤掉：块里（锚点节）逐字保留**被折轮次**的 TOK 标记，且**没有编造**标记。
  assert.equal(arm.block.includes(ANCHOR_SECTION_HEADING), true,
    `折叠块里没有锚点节（机械保真层被语义层挤掉了）：${arm.block.slice(-400)}`);
  const issued = [...arm.markers.values()];
  const inBlock = issued.filter((marker) => arm.block.includes(marker));
  assert.ok(inBlock.length >= 1,
    `折叠块里一个 TOK 标记都没保住（机械保真层失效）：被折区间=${JSON.stringify(arm.foldedRoundRange)}`
    + `｜块尾=${JSON.stringify(arm.block.slice(-400))}`);
  const fabricated = [...arm.block.matchAll(/TOK-\d+-[0-9a-f]+/gu)]
    .map((matched) => matched[0])
    .filter((marker) => !issued.includes(marker));
  assert.deepEqual(fabricated, [], `折叠块里出现了没发过的 TOK 标记（编造）：${fabricated.join(",")}`);

  // 隔离：不给 store ⇒ 真实 `~/.erix/transcripts` 下不许出现本次 runId 的产物。
  const realTranscript = join(process.env.HOME ?? homedir(), ".erix", "transcripts", "fold-default-real-619.jsonl");
  assert.equal(existsSync(realTranscript), false, `真实 ~/.erix/transcripts 下出现了本次 run 的账本：${realTranscript}`);

  console.log(`[619] PASS ① 语义分节在场 ② 摘要器请求=${arm.counts.summarizer}`
    + ` ③ 块里保住被折轮次的标记 ${inBlock.length} 个（${inBlock.join(",")}）`
    + `｜被折区间=${JSON.stringify(arm.foldedRoundRange)}`);
});

// ---------------------------------------------------------------------------
// 判据 ④：显式统计策略那一臂 ⇒ 摘要器 **0** 次（反向证：判据 ② 测的是真的）
// ---------------------------------------------------------------------------

test("真上游 e2e（统计臂反向证）：显式 fold-statistical ⇒ 统计块在但摘要器 0 次", {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const gate = await gateOrSkip(t);
  if (gate === undefined) return;

  const arm = await runArm({ runId: "fold-statistical-real-619", gate, strategy: "fold-statistical" });
  reportArm("统计臂", arm, "fold-statistical");

  assertBlockPresent(arm, "统计臂");
  console.log("=== 统计臂折叠块原文 ===");
  console.log(arm.block);
  assert.equal(arm.block.includes(FOLD_SUMMARY_MARKER), true,
    `统计臂的块里没有统计摘要标记：${arm.block.slice(0, 400)}`);
  assert.equal(arm.counts.summarizer, 0,
    `显式 fold-statistical 竟然调了摘要器 ${arm.counts.summarizer} 次 ⇒ 判据 ② 的计数口径不可信`);
  assert.deepEqual(
    arm.stats.map((stat) => stat.strategy).filter((name) => name !== undefined && name !== "fold-statistical"),
    [],
    `统计臂里混进了别的策略：${JSON.stringify(arm.stats)}`,
  );

  console.log(`[619] PASS ④ 统计臂：统计块在（标记在场）+ 摘要器 0 次 + 折叠 ${arm.folds} 次全走 fold-statistical`);
});

// ---------------------------------------------------------------------------
// 判据 ⑤（issue #661 反转）：摘要器超时 1ms ⇒ 终局 `summarizer_failed`，没有降级替代物
// ---------------------------------------------------------------------------

test("真上游 e2e（失败路）：摘要器超时 1ms ⇒ 终局 summarizer_failed（kind=timeout），块里没有降级标记", {
  timeout: 10 * 60 * 1000,
}, async (t) => {
  const gate = await gateOrSkip(t);
  if (gate === undefined) return;

  const strategyName = resolveCompactionStrategyName(undefined);
  const arm = await runArm({
    runId: "fold-summarizer-failed-real-661",
    gate,
    strategy: strategyName,
    summarizerTimeoutMs: 1,
  });
  reportArm("失败臂", arm, `${strategyName}（summarizerTimeoutMs=1）`);

  // 判据 ⑤-a（#661 反转）：失败是**终局错误**，不是「块里多一段降级标记、run 照常收尾」。
  // 改前这三条断的是 `DEGRADE_PATTERN` 在场 + `termination.reason === "end_turn"` +
  // 账上 `degradeKind === "timeout"`；现在那条替代物不存在，所以方向反过来。
  const failure = arm.failure;
  assert.notEqual(failure, undefined,
    `摘要器超时必须让 run 以异常收尾（issue #661）。实测 termination=${JSON.stringify(arm.result?.termination)}`
    + `、块=${JSON.stringify(String(arm.block ?? "").slice(0, 300))}——块在 = 旋钮没生效或降级路径又回来了。`);
  assert.equal(failure.code, "summarizer_failed",
    `终局异常的 code 必须是 summarizer_failed（实测 ${String(failure.code)}）：${failure.message}`);
  assert.equal(failure.details?.kind, "timeout",
    `超时旋钮（folding.context.summarizerTimeoutMs=1）必须归因到 timeout（实测 ${String(failure.details?.kind)}）`
    + `：${failure.message}`);
  assert.equal(failure.termination?.reason, "failed",
    `摘要器失败必须以 failed 收尾：termination=${JSON.stringify(failure.termination)}`);

  // 判据 ⑤-b（反向锁）：被 #661 删掉的那条降级前言**不许**出现，而且失败的这一折连块都不许折出来
  // （「什么都没应用」）。两条一起断：只断正则不在场，可能只是「块根本没取到」。
  assert.equal(arm.block, undefined,
    `失败那一折不许折出块（#661：无 foldedFacts / 无 compactionStats / 无事件）：${String(arm.block).slice(0, 400)}`);
  assert.equal(DEGRADE_PATTERN.test(arm.block ?? ""), false,
    `块里出现了被删掉的降级标记（#661 后这个形状不存在）：${String(arm.block).slice(0, 400)}`);
  assert.equal(arm.folds, 0,
    `失败的这一折不许走完折叠钩子（实测 folds=${arm.folds}）——说明失败被吞了`);

  console.log(`[619] PASS ⑤ 超时 1ms ⇒ ${failure.code}/${String(failure.details?.kind)}`
    + `（errorCode=${String(failure.errorCode)}）→ termination=${String(failure.termination?.reason)}`
    + `｜块未生成（folds=${arm.folds}）+ 无降级标记`);
});
