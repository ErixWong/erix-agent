import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens, estimateTokens } from "../tokens.js";
// issue #661：摘要器失败是**终局错误**，错误码口径与 `termination.errorCode` 同一份实现
//（`src/loop/termination.js#terminationErrorCodeForError`），不在这里另抄一份取 `code` 的逻辑。
import { terminationErrorCodeForError } from "../loop/termination.js";
import { KitError } from "../providers/errors.js";
import { enforceSize } from "./enforce-size.js";
import { buildFoldFidelitySection } from "./fold-fidelity.js";
import {
  buildFoldNavigationRecord,
  summarizeFoldedPayload,
} from "./fold-statistical.js";
import {
  cloneFoldPayload,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  resolveFoldRecoveryHint,
  resolveFoldStubs,
  resolveRecoveryHint,
  runFoldHook,
  selectFoldedRounds,
  FOLD_TARGET_RATIO,
} from "./helpers.js";

export function createSummarizerPromptGuide(recoveryHint) {
  const hint = resolveRecoveryHint(recoveryHint);
  return `请把被折叠轮次整理成可继续工作的日志。在第一个 \`##\` 小节**之前**，先单独输出三行元信息，
每行以固定前缀开头、各占一行、冒号后紧跟内容（不要加空格之外的额外符号、不要写成标题或列表）：
标题：<一句话标题，不超过 60 个字符>
描述：<自解释段落，不超过 500 token（本引擎按 estimateTokens 口径计）。要求：
  • 必须自解释：不出现「上面」「刚才」「该文件」「前面提到的」这类依赖上下文的指代；写清项目名 / 文件路径 / 判据 / 具体动作。
  • 不要用 Markdown 表格语法（| 浪费字符且渲染归宿主）。
  • 只列真实存在的动作，不许推测、不许补充原文没有的东西。>
标题与描述这两行必须写实际内容，不要写「无」或其它占位符；确实无法概括时宁可留空（只写前缀）也不要填「无」。
之后严格使用以下分节：
## 行动
实际做了什么、结果如何。**验证结论写在这里**（跑了什么测试 / 检查、结论是什么），不另开一节。
改到哪些文件就在句子里点出文件名（**不列清单**——Git 才是文件清单的权威）。
## 遗留
只列出尚未完成的动作，并明确写出"已完成项禁止重做"。若这一折只是讨论/设想/没有可执行事务，写「本折无具体事务」，不要编造待办。
## 关键词
列出后续检索原文所需的项目、文件、工具、错误和未结事项关键词。**用原文里的字面词**（文件名、工具名、报错原文、标识符），不要改写成同义词。

最后一段是白板（**必须是整份输出的最后一段**，引擎按它把正文与白板切开）：
白板：<本 run 现状的一整块文本，≤1500 token（本引擎按 estimateTokens 口径计）。规则：
  • 整块替换：这一行交回的是下一版白板的**整块全文**（不是增量指令）——把要保留的旧条目连同新条目重写成完整一块；引擎只校验长度然后整块覆盖，没有「某条被上限挡掉」这回事，装不下是你要取舍的活。
  • 推荐结构（约定，不是 schema，引擎不解析条目）：## 约束 / ## 待办 / ## 教训 / ## 事实 / ## 当前阶段。
  • 没东西可写就留空：整行只写「白板：」前缀、后面什么都不写（不要写「无」）；要显式清空整块白板，则整块只写一行「（空）」。

恢复提示：${hint}

历史工具结果留痕规则：如果被折轮次包含恢复工具结果，记录工具名称、调用轮次、查询词和结论，且所有内容必须来自原文。`;
}

export const SUMMARIZER_PROMPT_GUIDE = createSummarizerPromptGuide();

function withRecoveryHint(summary, recoveryHint) {
  if (summary.includes(recoveryHint)) return summary;
  return `${summary}\n## 恢复提示\n${recoveryHint}`;
}

// 机械保真层（逐字引用 / 反向信号）在尺寸截断**之前**追加（issue #873 修复①）：
// 整份摘要（模型正文 + 恢复提示 + 这一层）随后一起过 `enforceSummarySize(summaryBudget)`，
// 所以声明给选择器的 `summaryOverheadTokens: summaryBudget` 是**真上界**——旧顺序在夹断之后
// 追加，保真层削不掉且让最终摘要**大于**声明值，选择器会过早停折、落点高于 0.65×预算。
// 没有抽到任何内容时不输出空小节。
function appendFoldFidelity(summary, foldedPayload) {
  const fidelity = buildFoldFidelitySection(foldedPayload);
  if (fidelity === undefined) return summary;
  return summary.trim() === "" ? fidelity : `${summary}\n\n${fidelity}`;
}

function normalizedKeepRounds(value) {
  if (value === undefined) return 6;
  if (!Number.isFinite(value)) return 6;
  return Math.max(0, Math.floor(value));
}

function normalizedSummaryTokens(value) {
  if (value === undefined) return 800;
  if (!Number.isFinite(value)) return 800;
  return Math.max(0, Math.floor(value));
}

function blocksFor(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content;
}

function isRealUser(message) {
  if (message?.role !== "user") return false;
  const blocks = blocksFor(message);
  return typeof message.content === "string"
    || blocks.length === 0
    || blocks.some((block) => block?.type !== "tool_result");
}

function prependSummary(head, summary, summaryRole = "user") {
  const strippedHead = head;
  if (summaryRole === "system") {
    const systemIndex = strippedHead.findLastIndex((message) => message?.role === "system");
    if (systemIndex < 0) {
      return [
        { role: "system", content: [{ type: "text", text: summary }] },
        ...strippedHead,
      ];
    }
    const updatedHead = strippedHead.slice();
    const system = updatedHead[systemIndex];
    const content = typeof system.content === "string"
      ? [{ type: "text", text: system.content }]
      : Array.isArray(system.content) ? system.content : [];
    updatedHead[systemIndex] = {
      ...system,
      content: [{ type: "text", text: summary }, ...content],
    };
    return updatedHead;
  }
  const userIndex = strippedHead.findLastIndex(isRealUser);
  if (userIndex < 0) return strippedHead;

  const user = strippedHead[userIndex];
  const originalContent = typeof user.content === "string"
    ? [{ type: "text", text: user.content }]
    : Array.isArray(user.content)
      ? user.content
      : [];
  const updatedHead = strippedHead.slice();
  updatedHead[userIndex] = {
    ...user,
    content: [{ type: "text", text: summary }, ...originalContent],
  };
  return updatedHead;
}

function priorityForHeading(heading) {
  // issue #469（宿主审计 C 片）：关键词必须优先保。它排后档时，预算一紧就先被剪，
  // 而它恰恰是「下次按什么搜回来」的唯一线索（比文件清单更不可重建）。
  //
  // issue #261127-18（六节 → 四节）：**这张表必须跟着节名改**。它按节名子串匹配，节名一改而表不改，
  // 新节名就全部落进兜底档 4 ⇒ 预算紧时先剪 `## 行动`，与契约/CHANGELOG 写的优先级**正好相反**
  //（copilot 复审抓到的阻塞项：文档说已更新，代码没动）。`test/compact/fold-llm.test.js` 的
  // 「priority map covers every section the prompt asks for」那格是这张表的机器判据。
  if (heading.includes("遗留")) return 0;
  if (heading.includes("恢复提示")) return 0;
  if (heading.includes("关键词")) return 1;
  // `## 行动` 是模型写的事实正文（剪了就没了），保真层是机械可重抽的（原文还在归档里）⇒
  // 行动排在保真层**之前**被保。两档之间不再有「已验证项 / 已改文件」这两个更低的档：它们已并入
  // `## 行动`。
  if (heading.includes("行动")) return 2;
  // issue #873 修复① 的配套：机械保真层节（用户逐字引用）现在**在**摘要预算内，
  // 它必须排在合同节**之后**被剪，否则 #469-C ①「默认预算装得下全部合同节」会破防。
  // （锚点索引那一档随 issue #261127-19 删除。）
  if (heading.includes("用户最新未解决输入")) return 5;
  return 4;
}

function sectionsFromSummary(summary) {
  const headings = [...summary.matchAll(/^## .*(?:\r?\n|$)/gm)];
  if (headings.length === 0) return null;

  const fields = [];
  const firstHeading = headings[0].index;
  if (firstHeading > 0 && summary.slice(0, firstHeading).trim().length > 0) {
    fields.push({
      key: "phase-preamble",
      text: summary.slice(0, firstHeading),
      priority: 4,
    });
  }

  headings.forEach((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? summary.length;
    fields.push({
      key: `section-${index}`,
      text: summary.slice(start, end),
      priority: priorityForHeading(heading[0]),
    });
  });

  return fields;
}

function renderFields(fields) {
  let output = "";
  for (const field of fields) {
    if (output.length > 0 && !output.endsWith("\n") && !field.text.startsWith("\n")) {
      output += "\n";
    }
    output += field.text;
  }
  return output;
}

function truncatedMarkerForBudget(budgetTokens) {
  const marker = "[摘要已整体截断]";
  if (estimateTokens(marker) <= budgetTokens) return marker;
  const shorterMarker = "[已截断]";
  if (estimateTokens(shorterMarker) <= budgetTokens) return shorterMarker;
  return marker;
}

function prefixWithinBudget(text, suffix, budgetTokens) {
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  let best = "";

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = characters.slice(0, middle).join("");
    const candidate = prefix.length > 0 ? `${prefix}\n${suffix}` : suffix;
    if (estimateTokens(candidate) <= budgetTokens) {
      best = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function truncateWholeSummary(summary, budgetTokens) {
  if (estimateTokens(summary) <= budgetTokens) return summary;

  const marker = truncatedMarkerForBudget(budgetTokens);
  const prefix = prefixWithinBudget(summary, marker, budgetTokens);
  return prefix.length > 0 ? `${prefix}\n${marker}` : marker;
}

function enforceSummarySize(summary, maxSummaryTokens, onLayer) {
  const tokensBefore = estimateTokens(summary);
  const fields = sectionsFromSummary(summary);
  if (fields === null) {
    const rendered = truncateWholeSummary(summary, maxSummaryTokens);
    onLayer?.({
      layerId: "enforceSize",
      tokensBefore,
      tokensAfter: estimateTokens(rendered),
    });
    return rendered;
  }

  const enforced = enforceSize(fields, maxSummaryTokens);
  const rendered = renderFields(enforced.fields);
  const bounded = truncateWholeSummary(rendered, maxSummaryTokens);
  onLayer?.({
    layerId: "enforceSize",
    tokensBefore,
    tokensAfter: estimateTokens(bounded),
  });
  return bounded;
}

/**
 * Create an LLM-backed whole-round folding strategy.
 *
 * issue #469-②：`maxSummarizerInputTokens` 是交给 summarizer 
 * 的被折消息上限（token），
 * 不传 ⇒ 不裁（旧行为）；超窗失败（网关 400）
 * 无论配不配都会**带更短的输入重试一次**——重试仍失败 ⇒ 抛 `summarizer_failed`
 *（issue #661：不再有「降级为统计摘要」那条替代路径）。
 * 说明写在这里而不是类型字面量内部：JSDoc 
 * 的类型字面量里不能写 `//` 注释行，否则
 * `TS1131` 会把整块类型打断（这条坑在本文件与 `provider-summarizer.js` 
 * 各踩过一次）。
 *
 * @param {{
 *   summarizer: (input: {messages: object[], roundRange: {from:number, to:number}}) => Promise<string>|string,
 *   maxSummaryTokens?: number,
 *   maxSummarizerInputTokens?: number,
 *   summaryRole?: "user"|"system",
 *   recoveryHint?: string,
 *   stripHistoricalImages?: boolean,
 *   onBeforeFold?: Function,
 *   onAfterFold?: Function,
 * }} options
 * @returns {{
 *   name: string,
 *   shouldCompact: (messages: object[], budgetTokens: number) => boolean,
 *   compact: (messages: object[], options?: {keepRounds?: number, budgetTokens?: number, recoveryHint?: string, noteTools?: string[]}) => Promise<object>,
 * }}
 */
export function createFoldLlmStrategy({
  summarizer,
  maxSummaryTokens = DEFAULT_SUMMARY_MAX_TOKENS,
  ...options
} = {}) {
  if (typeof summarizer !== "function") {
    throw new TypeError("fold-llm summarizer must be a function");
  }
  const summaryBudget = normalizedSummaryTokens(maxSummaryTokens);
  // issue #469-③：本实例**上一次真喂进上下文**的折叠摘要（#661 起只可能是 LLM 摘要——
  // 失败那一折会抛，走不到这里），下一次折叠把它当续写基底；宿主 / resume 可用
  // `previousSummary` 覆盖。
  let lastFoldSummaryText;

  return {
    name: "fold-llm",

    shouldCompact(messages, budgetTokens) {
      return estimateMessageTokens(messages) > budgetTokens;
    },

    async compact(messages, callOptions = {}) {
      const tokensBefore = estimateMessageTokens(messages);
      const { head, rounds } = groupIntoRounds(messages);
      const settings = foldOptions(options, callOptions);
      const keep = normalizedKeepRounds(
        optionValue(callOptions, options, "keepRounds", undefined),
      );
      // issue #873：折多少由**预算比例**定（`FOLD_TARGET_RATIO`）；无预算⇒ targetTokens undefined ⇒ 旧行为。
      const budgetTokens = optionValue(callOptions, options, "budgetTokens", undefined);
      const targetTokens = Number.isFinite(budgetTokens) && budgetTokens > 0
        ? budgetTokens * FOLD_TARGET_RATIO
        : undefined;
      const { folded, retained, foldedIndexes } = selectFoldedRounds(
        rounds,
        keep,
        // issue #608：工作集地板（`0` = 关闭，引擎显式开成 `WORKING_SET_RECENT_ROUNDS`）。
        // #614 之后本策略是 CLI 默认 ⇒ 漏传就等于宿主显式开的地板在默认路径上被静默忽略。
        settings.workingSetRecentRounds,
        {
          targetTokens,
          headMessages: head,
          // 摘要开销 = 本策略配置的摘要上限（`maxSummaryTokens` 解析后的 `summaryBudget`）。
          // 依据：`fold-llm` 的摘要是**模型写的**，生成前拿不到长度，但定稿处会把「模型摘要 +
          // 恢复提示 + 机械保真层」**整体**限长到 `summaryBudget`（`enforceSummarySize`，超限即
          // 分节修剪 + `truncateWholeSummary` 夹断）⇒ 实际进消息的摘要 ≤ 该上限，用它作开销
          // **上界**成立（issue #873 验收阻断②：旧版拿机械摘要估会低估；copilot 拦下的第 ① 条：
          // 保真层曾在夹断之后追加，声明值只是下界、不是上界）。
          summaryOverheadTokens: summaryBudget,
        },
      );
      const foldedPayload = cloneFoldPayload(
        folded.flatMap((round) => round.messages),
        settings.stripHistoricalImages,
      );
      const roundRange = roundRangeForIndexes(
        foldedIndexes,
        settings.roundOffset,
        settings.roundNumbers,
      );
      const recoveryHint = await resolveFoldRecoveryHint(settings.recoveryHint, {
        foldedPayload,
        folded,
        retained,
        roundRange,
        // issue #741：同 `fold-statistical` —— 拿不到笔记证据就把广告语换成显式未知口径。
        noteTools: settings.noteTools,
      });
      await runFoldHook(settings.onBeforeFold, {
        messages,
        folded,
        retained,
        foldedPayload,
        roundRange,
      });

      let compactedHead = head;
      // issue #470（A1）：本次折叠的**机械替代物**（进账本用，不进消息流）。
      /** @type {{ source: string, text?: string, increment?: string, incrementOrigin?: string, title?: string, description?: string, titleMissing?: string, descriptionMissing?: string }|undefined} */
      let foldSummary = undefined;
      if (folded.length > 0) {
        const range = roundRange ?? { from: 1, to: folded.length };
        // 机械替代物（stub / 导航记录）与摘要器无关，先算好；它们只是**账本**的一份，
        // 不是摘要失败时的替代物（issue #661 已删掉那条替代路径）。
        const foldedStubs = await resolveFoldStubs(foldedPayload, settings.stubFor);
        const navigationRecord = buildFoldNavigationRecord(foldedPayload, range);
        // issue #661：`callSummarizerWithBound` **失败即抛**（`KitError("summarizer_failed")`）。
        // 改前它返回一份「降级为统计摘要」的替代物（issue #33 D 的旧语义），于是摘要器挂了
        // 的 run 与摘要器正常的 run 在终局上长得一样——用户永远不知道质量掉了。
        // 现在失败就是失败：异常一路穿到 run 的终局（`termination.reason === "failed"`，
        // `errorCode === "summarizer_failed"`）。构造期参数错误（summarizer 非函数）仍在
        // `createFoldLlmStrategy` 里 fail-loud，不经此路径。
        //
        // 「先失败后应用」：下面每一处状态写入（`lastFoldSummaryText` / `foldSummary` /
        // `compactedHead`）都在 `await` **之后** ⇒ 抛出的那一折一个键都不留。
        // issue #469（裁决 A）：取源链 **显式调用参数 > 策略构造参数 > in-run 闭包 > 账本播种**。
        // 账本排最后 ⇒ 非 resume / 挑不出覆盖事实时它为空，行为逐字退回今天的形状（纯加法）。
        const continuationBase = await resolveContinuationBase(
          callOptions,
          options,
          lastFoldSummaryText,
        );
        const prior = normalizePriorSummary(
          continuationBase.text,
          normalizedLimit(
            optionValue(callOptions, options, "maxPriorSummaryBytes", DEFAULT_PRIOR_SUMMARY_MAX_BYTES),
          ),
        );
        const summarizerOutcome = await callSummarizerWithBound({
          summarizer,
          payload: foldedPayload,
          roundRange: range,
          recoveryHint,
          priorSummary: prior.text,
          budgetMs: normalizedLimit(
            optionValue(callOptions, options, "summarizerBudgetMs", DEFAULT_SUMMARIZER_BUDGET_MS),
          ),
          inputBoundBytes: normalizedLimit(
            optionValue(
              callOptions,
              options,
              "maxSummarizerInputBytes",
              DEFAULT_SUMMARIZER_INPUT_MAX_BYTES,
            ),
          ),
          inputBoundTokens: normalizedInputBound(
            optionValue(callOptions, options, "maxSummarizerInputTokens", undefined),
          ),
        });
        // issue #897：先把模型给的两行元信息（title/description）从摘要正文里摘出来，
        // 下面的 withRecoveryHint / enforceSummarySize / appendFoldFidelity 吃的是**剥掉那两行后**的正文。
        const summarizerMeta = parseSummarizerMeta(summarizerOutcome.summary);
        const summary = summarizerMeta.body;
        // 白板：上一版现状由引擎从 run state 递下来（`callOptions.board`）；decideBoard 照
        // title/description 同一口径定出本折要交回的 board / boardMissing / boardRejected。
        const boardOption = optionValue(callOptions, options, "board", "");
        const boardDecision = decideBoard({
          board: summarizerMeta.board,
          boardMissing: summarizerMeta.boardMissing,
          previousBoard: typeof boardOption === "string" ? boardOption : "",
        });
        const droppedInputMessages = summarizerOutcome.droppedMessages;
        // issue #566：本折的机械替代物总是算（零 LLM）。
        // `compactedSummary` 是续写累计体（prior 会被续写进输出），
        // 不是本折增量。
        const mechanicalSummaryText = summarizeFoldedPayload(foldedPayload, {
          from: range.from,
          to: range.to,
          count: folded.length,
          recoveryHint,
          stubs: foldedStubs,
          ...(navigationRecord === undefined ? {} : { navigationRecord }),
        });
        // issue #873（copilot 拦下的第 ① 条）：**保真层先拼、尺寸后管**。最终进消息的摘要
        //（模型正文 + 恢复提示 + 机械保真层）整体受同一个 `summaryBudget` 约束 ⇒ 本函数上面
        // 传给 `selectFoldedRounds` 的 `summaryOverheadTokens: summaryBudget` 是真上界。
        // 旧顺序（先 `enforceSummarySize` 后 `appendFoldFidelity`）让实际进消息的摘要大于声明值
        // ⇒ 选择器过早停折，落点高于 `0.65 × budgetTokens`。
        const compactedSummary = enforceSummarySize(
          appendFoldFidelity(
            withRecoveryHint(summary, recoveryHint),
            foldedPayload,
          ),
          summaryBudget,
          settings.onLayer,
        );
        // ③ 的续写基底：记下这次真进了上下文的那份（下一轮折叠的「上一份」）。
        // issue #661：只有拿到摘要才写 ⇒ 失败那一折不会给下一次折叠留残值。
        lastFoldSummaryText = compactedSummary;
        foldSummary = {
          // issue #661：`fold-llm` 只有一条成功路径（失败即抛），所以 `source` 恒为 `"llm"`。
          // 改前失败分支写 `"statistical"`——那是被删掉的「降级为统计摘要」替代物的自报。
          source: "llm",
          // issue #566：本折那份 = 机械替代物 ⇒ 自报 mechanical。
          increment: mechanicalSummaryText,
          incrementOrigin: "mechanical",
          // #470：`text` 说清「交给模型的那份」是什么。
          // issue #657（缺陷二）：**成功分支也交 `text`** = 已存进 `lastFoldSummaryText` 的累计摘要（不重算）。
          // 改前它不给这个键 ⇒ 引擎落回 `fedSummaryText`（折叠后那条消息**全文** = 摘要 + 原任务正文）
          // ⇒ 账上 54–78% 是模型还在 head 里看着的任务原文，`truncated` 从第 2 折起恒真。
          text: compactedSummary,
          // issue #897：模型给的 title/description 随 foldSummary 向上交（只做加法，
          // 不改既有键）；没拿到时不静默，带一个可读的 `*Missing` 原因。
          ...(summarizerMeta.title !== undefined
            ? { title: summarizerMeta.title }
            : { titleMissing: summarizerMeta.titleMissing }),
          ...(summarizerMeta.description !== undefined
            ? { description: summarizerMeta.description }
            : { descriptionMissing: summarizerMeta.descriptionMissing }),
          ...(summarizerMeta.descriptionTruncated ? { descriptionTruncated: true } : {}),
          // 白板（第一刀）：照 title/description 的**加法**口径。`board` 在场 = 本折要整块覆盖的
          // 新板（含显式清空的空串）；`boardRejected` = 拒收原因（旧板由上层保持）；`boardMissing`
          // = 没提（与「有病」区分）。三者互斥，最多出现一个。
          ...(boardDecision.board !== undefined ? { board: boardDecision.board } : {}),
          ...(boardDecision.boardMissing !== undefined
            ? { boardMissing: boardDecision.boardMissing }
            : {}),
          ...(boardDecision.boardRejected !== undefined
            ? { boardRejected: boardDecision.boardRejected }
            : {}),
          ...(prior.truncated ? { priorSummaryTruncated: true, priorSummaryBytes: prior.bytes } : {}),
          ...(prior.bytes > 0 && !prior.truncated ? { priorSummaryBytes: prior.bytes } : {}),
          // issue #469（裁决 A）：基底从哪来——`"ledger"` = resume 后从账本播的，
          // `"in-run"` = 本 run 攒的（含宿主显式传的）。口径照「无事实不写键」：没基底就不写。
          ...(prior.bytes > 0
            ? { priorSummaryOrigin: continuationBase.origin ?? "in-run" }
            : {}),
          ...(summarizerOutcome.droppedRounds > 0
            ? { droppedRounds: summarizerOutcome.droppedRounds }
            : {}),
          ...(summarizerOutcome.attempts > 1 ? { attempts: summarizerOutcome.attempts } : {}),
          ...(droppedInputMessages > 0
            ? { inputTruncated: true, droppedMessages: droppedInputMessages }
            : {}),
        };
        compactedHead = prependSummary(
          head,
          compactedSummary,
          settings.summaryRole,
        );
      }

      const compactedMessages = [
        ...compactedHead,
        ...retained.flatMap((round) => round.messages),
      ];
      const tokensAfter = estimateMessageTokens(compactedMessages);

      const result = {
        messages: compactedMessages,
        compacted: folded.length > 0,
        foldedRounds: folded.length,
        tokensBefore,
        tokensAfter,
        foldedPayload,
        ...(roundRange === undefined ? {} : { foldedRoundRange: roundRange }),
        ...(foldSummary === undefined ? {} : { foldSummary }),
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });
      return result;
    },
  };
}

/**
 * issue #469-①：摘要器失败的**归因分类**。超时、超窗（网关 400）、普通报错此前塌成
 * 同一条文案，宿主从记录上分不出「这次本可以自愈」还是「摘要器真的挂了」。
 *
 * issue #661：分类结果不再落成 `degradeKind`（那条降级路径已删），而是
 * `summarizer_failed` 异常上的 `details.kind`。四类原值不变：
 * `timeout` / `context_window_exceeded` / `empty_summary` / `error`。
 *
 * @param {*} error 可以是 Error / 带 `code` 的自定义错 / 
 * 字符串（降级路径上什么都会抛上来）
 * @returns {"timeout"|"context_window_exceeded"|"empty_summary"|"error"}
 */
export function classifyFoldDegradeKind(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "summarizer_timeout" || code === "ETIMEDOUT" || code === "TIMEOUT") {
    return "timeout";
  }
  // 缺陷 ②：空串 / 只有空白的摘要是**摘要器没产出**，不是「成功的空摘要」。
  // 单独一类，好让宿主从记录上把它与「摘要器挂了」（`error`）分开。
  if (code === "summarizer_empty_summary") {
    return "empty_summary";
  }
  const message = String(error?.message ?? error ?? "");
  if (/maximum context length|context_length_exceeded|context window|ContextWindowExceeded|is longer than configured context length|input length|too many tokens/i.test(message)) {
    return "context_window_exceeded";
  }
  return "error";
}

const TRIM_NOTE_RESERVE_TOKENS = 48;
const MIN_RETRY_INPUT_TOKENS = 256;
// issue #469-③（宿主裁决 2026-10-26）：喂给摘要器的**窗口**用字节上限 48 KB，
// 超了按**整轮**从旧到新截，绝不截断单轮中部——半条工具输出比没有更容易被误信。
const DEFAULT_SUMMARIZER_INPUT_MAX_BYTES = 48 * 1024;
// 「上一份折叠摘要」是续写基底，单独计预算：24 KB，超了从**头部**截（保留最近部分），
// 且截断事实必须留痕（否则「脉络断了」和「本来就没有」分不开）。
const DEFAULT_PRIOR_SUMMARY_MAX_BYTES = 24 * 1024;
// issue #469-②（宿主裁决）：整个摘要步骤（含超窗自愈那一发）共用一条 30 s 死线；
// 剩余时间不足一个最小尝试窗口就不再重试——30 s 是硬上限，不是每次尝试的上限。
const DEFAULT_SUMMARIZER_BUDGET_MS = 30_000;
const MIN_RETRY_REMAINING_MS = 2_000;

/**
 * issue #493：折叠摘要的输出预算默认值（`createFoldLlmStrategy` 的 `maxSummaryTokens` 默认，
 * 也是 `context.maxSummaryTokens` 不传时的值）。导出给 `orchestrator` 用——摘要那一发的
 * `maxTokens` 必须与这个预算**取小对齐**，否则模型按大预算写满再被剪回来，白烧 token。
 */
export const DEFAULT_SUMMARY_MAX_TOKENS = 1_400;

/**
 * issue #469（宿主裁决 A）：续写基底的**取源链**——显式调用参数 > 策略构造参数 > in-run 闭包 >
 * 账本播种（`ledgerPreviousSummary`，值或异步取值器）。
 *
 * 账本那一档排**最后**：非 resume / 挑不出覆盖水位线的事实 ⇒ 返回空 ⇒ 行为逐字退回今天的形状。
 * 返回值带 `origin`，由 `foldSummary.priorSummaryOrigin` 如实交代（`ledger` / `in-run`）。
 *
 * @param {any} callOptions
 * @param {any} options
 * @param {string|undefined} inRunText 本实例上一次真喂出去的摘要（`lastFoldSummaryText`）
 * @returns {Promise<{ text?: string, origin?: "ledger"|"in-run" }>}
 */
async function resolveContinuationBase(callOptions, options, inRunText) {
  const explicit = optionValue(callOptions, options, "previousSummary", undefined);
  if (typeof explicit === "string" && explicit !== "") return { text: explicit, origin: "in-run" };
  if (typeof inRunText === "string" && inRunText !== "") return { text: inRunText, origin: "in-run" };
  const seed = optionValue(callOptions, options, "ledgerPreviousSummary", undefined);
  const seeded = typeof seed === "function" ? await seed() : seed;
  if (typeof seeded === "string" && seeded !== "") return { text: seeded, origin: "ledger" };
  return { text: undefined, origin: undefined };
}

function normalizedInputBound(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizedLimit(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** * 重试用的上限：配了就配的一半，没配就当前输入的一半；
/** 剩一条以下无从再减 ⇒ 不重试。 */
function retryBoundFor(configuredBound, messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return undefined;
  const current = configuredBound ?? estimateMessageTokens(messages);
  const next = Math.floor(current / 2);
  return next >= MIN_RETRY_INPUT_TOKENS ? next : undefined;
}

function bytesOf(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

/** 窗口正文的字节量：角色开销按 16 字节/条粗算，宁可高估也不低估。 */
function payloadBytes(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const body = typeof message?.content === "string"
      ? message.content
      : JSON.stringify(message?.content ?? "");
    total += 16 + bytesOf(body);
  }
  return total;
}

function omissionNote(droppedRounds, droppedMessages, total) {
  const scope = droppedRounds > 0
    ? `前 ${droppedRounds} 轮最旧消息`
    : `前 ${droppedMessages} 条最旧消息`;
  return {
    role: "user",
    __omissionNote: true,
    content: [{
      type: "text",
      text: `（为守住摘要器输入上限，${scope}已省略，共 ${total} 条）`,
    }],
  };
}

/** 只丢整条消息（token 层、窗口护栏），不加省略注。 */
function trimOldestMessages(list, maxTokens) {
  const target = Math.max(1, maxTokens - TRIM_NOTE_RESERVE_TOKENS);
  let start = 0;
  while (start < list.length - 1 && estimateMessageTokens(list.slice(start)) > target) {
    start += 1;
  }
  return start === 0
    ? { messages: list, dropped: 0 }
    : { messages: list.slice(start), dropped: start };
}

/**
 * issue #469-③：两层裁剪——先按裁决（整轮 / 字节），再按窗口护栏（整条 / token）。
 * 无论哪层丢过东西都要留一条省略注：既裁了又不告诉模型（和人），是最坏的一种。
 */
function trimFoldedPayloadToLimits(payload, limits = {}) {
  const list = Array.isArray(payload) ? payload : [];
  if (list.length === 0) return { messages: list, dropped: 0, droppedRounds: 0 };
  let kept = list;
  let droppedRounds = 0;
  if (Number.isFinite(limits.maxBytes) && limits.maxBytes > 0 && payloadBytes(kept) > limits.maxBytes) {
    const { rounds } = groupIntoRounds(kept);
    let start = 0;
    while (start < rounds.length - 1
      && payloadBytes(rounds.slice(start).flatMap((round) => round.messages)) > limits.maxBytes) {
      start += 1;
    }
    if (start > 0) {
      kept = rounds.slice(start).flatMap((round) => round.messages);
      droppedRounds = start;
    }
  }
  let droppedMessages = list.length - kept.length;
  if (Number.isFinite(limits.maxTokens) && limits.maxTokens > 0
    && estimateMessageTokens(kept) > limits.maxTokens) {
    const tokenTrimmed = trimOldestMessages(kept, limits.maxTokens);
    kept = tokenTrimmed.messages;
    droppedMessages += tokenTrimmed.dropped;
  }
  if (droppedMessages === 0) return { messages: list, dropped: 0, droppedRounds: 0 };
  return {
    messages: [omissionNote(droppedRounds, droppedMessages, list.length), ...kept],
    dropped: droppedMessages,
    droppedRounds,
  };
}

/**
 * issue #469-③：上一份折叠摘要按 24 KB 从**头部**截（保留最近部分），
 * 返回截断后的文本与入账用的事实。
 */
function normalizePriorSummary(value, maxBytes) {
  if (typeof value !== "string" || value.trim() === "") {
    return { text: undefined, bytes: 0, truncated: false };
  }
  const bytes = bytesOf(value);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes <= maxBytes) {
    return { text: value, bytes, truncated: false };
  }
  const marker = "（上一份折叠摘要超出上限，头部已截断，保留最近部分）\n";
  const keep = Math.max(0, Math.floor(maxBytes) - bytesOf(marker));
  const buffer = Buffer.from(value, "utf8");
  const tail = buffer.subarray(Math.max(0, buffer.length - keep)).toString("utf8");
  return { text: `${marker}${tail.replace(/^\uFFFD+/u, "")}`, bytes, truncated: true };
}

/**
 * 缺陷 ②：摘要器的返回值必须**真的是一份摘要**。
 *
 * `typeof "" === "string"` 曾把「模型什么都没写」当成成功 ⇒ 折叠块里只有恢复提示 +
 * 锚点，既无语义内容、也无降级标记（看上去正常，实际是空的）。空串 / 只有空白的串
 * 一律当**失败**：抛错 ⇒ 由 `callSummarizerWithBound` 包成 `summarizer_failed`
 *（issue #661；改前是 #33 D 的「降级为统计摘要」），原因分类为 `empty_summary`
 *（`summarizer_empty_summary`），文案「摘要器返回空内容」。
 *
 * 非字符串的旧口径（`TypeError` + `error` 类）逐字不动。
 *
 * @param {*} summary
 * @returns {string} 可用的摘要文本
 */
function assertUsableSummary(summary) {
  if (typeof summary !== "string") {
    throw new TypeError("fold-llm summarizer must return a string");
  }
  if (summary.trim() === "") {
    const error = new TypeError("摘要器返回空内容");
    Object.assign(error, { code: "summarizer_empty_summary" });
    throw error;
  }
  return summary;
}

/**
 * issue #661：摘要器失败的**唯一**出口。
 *
 * 改前这里是「返回一份降级替代物」（issue #33 D），于是摘要器挂了的 run 与摘要器正常的 run
 * 在终局上长得一样（只有 stdout 里一块 `[fold-llm 摘要失败，已降级为统计摘要（原因: …）]`）。
 * 现在是终局错误：`KitError("summarizer_failed")` 一路穿到 `termination.reason === "failed"`。
 *
 * 三个字段的口径：
 *   · `errorCode` —— **与 `makePersistenceFailure`（`src/loop/orchestrator.js`）取值对称**：
 *     记根因自己的 `code`（`terminationErrorCodeForError`，取不到即 `"unknown"`），
 *     `cause` 仍是底层错误对象；
 *   · `details.kind` —— `classifyFoldDegradeKind` 的四类原值（`timeout` /
 *     `context_window_exceeded` / `empty_summary` / `error`）。刻意**不**叫
 *     `summarizer_unavailable`：`empty_summary` 是「模型返回空串/空白」的确定性故障，
 *     换模型才有用，不叫「不可用」；
 *   · `details` 上的诊断事实（`attempts` / `droppedMessages` / `droppedRounds` /
 *     `budgetExhausted`）—— 异常路径不返回 result，这些事实只能随异常走，否则「为什么失败」
 *     与「试过几次」一起消失。
 *
 * 用 `Object.assign` 写 `errorCode` / `details`：`KitError` 的 JSDoc 没声明这两个 additive
 * 字段，直接赋值会让 `--checkJs` 棘轮多背 TS2339（#214 的「只减不增」）。
 *
 * @param {*} error 底层错误（超时 / 网关 400 / 空摘要 / 任意 reject）
 * @param {{ kind?: "timeout"|"context_window_exceeded"|"empty_summary"|"error",
 *   droppedMessages?: number, droppedRounds?: number, attempts?: number,
 *   budgetExhausted?: boolean }} [facts]
 * @returns {KitError}
 */
function summarizerFailure(error, facts = {}) {
  const kind = facts.kind ?? classifyFoldDegradeKind(error);
  const reason = String(error?.message ?? error).slice(0, 120);
  const failure = new KitError(
    "summarizer_failed",
    `fold-llm 摘要失败（${kind}）：${reason}`,
    { retryable: false, cause: error },
  );
  Object.assign(failure, {
    errorCode: terminationErrorCodeForError(error),
    details: {
      kind,
      ...(facts.droppedMessages > 0 ? { droppedMessages: facts.droppedMessages } : {}),
      ...(facts.droppedRounds > 0 ? { droppedRounds: facts.droppedRounds } : {}),
      ...(facts.attempts > 1 ? { attempts: facts.attempts } : {}),
      ...(facts.budgetExhausted === true ? { budgetExhausted: true } : {}),
    },
  });
  return failure;
}

/**
 * issue #469-①②③：一次折叠的摘要步骤。
 *   · 首发与（仅超窗时允许的）自愈重试共享一条 `budgetMs` 死线；
 *   · **超时绝不重试**（宿主裁决 ②：重试只是把一次卡顿变成两次）；
 *   · **失败即抛** `summarizer_failed`（issue #661：不再返回降级替代物）。
 *
 * 保留「超窗 ⇒ 缩输入重试一次」：那不是降级，是让调用装得下。重试仍失败 ⇒ 同样抛，
 * `details.kind` 保持 `context_window_exceeded`（超窗归因不因重试又失败而被掩盖）。
 */
// issue #897：从摘要正文里摘出模型给的 title / description。
// 出厂提示词要求模型在第一个 `##` 之前先输出两行带固定前缀的元信息；这里把它们解析出来，
// 并从正文里**剥掉**（理由：这两行是给账本的元信息，不是进上下文的日志正文——留着会
// 被 `sectionsFromSummary` 当 phase-preamble 占用优先级 4 的摘要预算，且与五节合同争位）。
// 只扫描第一个 `##` 之前的 preamble，行首锚定固定前缀，不与正文自然句撞车。
// 缺失/空/占位「无」都算**没拿到**（不静默：返回一个可读的 `*Missing` 原因），
// 绝不用正文首行顶上冒充（那正是今天 `## 阶段` 的来源）。
const SUMMARIZER_TITLE_MAX_CHARS = 60;
/** issue #897：description 配额从 200 字符改为 500 token（向量化单元）；title 保持 60 字符不变。 */
export const SUMMARIZER_DESCRIPTION_MAX_TOKENS = 500;
const SUMMARIZER_TITLE_LINE = /^标题：(.*)$/m;
const SUMMARIZER_DESC_LINE = /^描述：(.*)$/m;
/** 白板是一整块文本（`runs.board`），上限与摘要预算同一把尺子（`estimateTokens`）；超了拒收（§3.7）。 */
export const SUMMARIZER_BOARD_MAX_TOKENS = 1500;
const SUMMARIZER_BOARD_LINE = /^白板：(.*)$/m;

/** @param {string} value @param {number} maxChars @returns {string} */
function clampMetaChars(value, maxChars) {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}

/**
 * 按 token 上限夹断一段文本（用引擎自己的 `estimateTokens` 口径）。
 * 返回 `{ text, truncated }`：`truncated` 仅在真发生夹断时为 true。
 * 用二分查找最长前缀使 `estimateTokens(prefix) <= maxTokens`。
 *
 * @param {string} value @param {number} maxTokens @returns {{ text: string, truncated: boolean }}
 */
function clampMetaTokens(value, maxTokens) {
  if (estimateTokens(value) <= maxTokens) return { text: value, truncated: false };
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (estimateTokens(chars.slice(0, mid).join("")) <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { text: chars.slice(0, best).join(""), truncated: true };
}

/** @param {string} raw @returns {string|undefined} */
function normalizeMetaValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "无") return undefined;
  return trimmed;
}

/**
 * 判定白板本折的落地值（§3.7 失败语义，写死不静默）：
 *   · 给了且超 1500 token ⇒ 拒收（`over-limit`），不交回新板（白板由上层保持旧值）。
 *   · 给了（含显式清空的空串）且未超限 ⇒ 交回 `board`（整块覆盖）。
 *   · 没给但旧板非空⇒ 拒收（`empty-over-nonempty`）：一次解析失误不能抹掉全部现状。
 *   · 没给且旧板空 ⇒ 不变（`boardMissing` 原样带上，与「有病」区分）。
 *
 * @param {{ board?: string, boardMissing?: string, previousBoard: string }} input
 * @returns {{ board?: string, boardMissing?: string, boardRejected?: "over-limit" | "empty-over-nonempty" }}
 */
function decideBoard({ board, boardMissing, previousBoard }) {
  if (board !== undefined) {
    if (board !== "" && estimateTokens(board) > SUMMARIZER_BOARD_MAX_TOKENS) {
      return { boardRejected: "over-limit" };
    }
    return { board };
  }
  if (boardMissing === "empty-or-placeholder" && previousBoard !== "") {
    return { boardRejected: "empty-over-nonempty" };
  }
  return boardMissing !== undefined ? { boardMissing } : {};
}

/**
 * 解析摘要正文里模型给的两行元信息。
 * @param {string} summary 摘要器返回的原文
 * @returns {{ body: string,
 *   title?: string, titleMissing?: "no-line" | "empty-or-placeholder",
 *   description?: string, descriptionMissing?: "no-line" | "empty-or-placeholder",
 *   descriptionTruncated?: true }}
 */
export function parseSummarizerMeta(summary) {
  // 白板是**整份输出的最后一段**（261128 第二版，copilot 复审 P2）：旧版把白板夹在 `描述：`
  // 与正文之间，而正文起点是「第一个 `## 行动`/`## 遗留`/…」——白板内部若出现这些标题（模型
  // 完全可能这么写），白板会被从中间切断，剩下的半块还会漏进摘要正文。移到末尾之后，正文与
  // 白板的分界就是**白板行本身**：白板 = 从 `白板：` 到结尾，正文 = 从第一个 `##` 到白板行之前。
  const boardStart = SUMMARIZER_BOARD_LINE.exec(summary);
  const bodyRegionEnd = boardStart ? boardStart.index : summary.length;
  const headingMatch = /^## .*(?:\r?\n|$)/m.exec(summary.slice(0, bodyRegionEnd));
  const bodyStart = headingMatch ? headingMatch.index : bodyRegionEnd;
  const metaRegion = summary.slice(0, bodyStart);

  const titleMatch = SUMMARIZER_TITLE_LINE.exec(metaRegion);
  const descMatch = SUMMARIZER_DESC_LINE.exec(metaRegion);

  const rawTitle = titleMatch ? normalizeMetaValue(titleMatch[1]) : undefined;
  const rawDesc = descMatch ? normalizeMetaValue(descMatch[1]) : undefined;

  // 白板：从 `白板：` 前缀之后一直取到**结尾**（它是最后一段），逐字保留（只裁两端空白）。
  // 显式清空标记「（空）」⇒ value:""（允许覆盖非空旧板）；空/占位「无」⇒ 没拿到。
  /** @type {{ value: string } | { missing: "no-line" | "empty-or-placeholder" }} */
  let boardResult;
  if (!boardStart) {
    boardResult = { missing: "no-line" };
  } else {
    const afterPrefix = summary.slice(boardStart.index + "白板：".length).trim();
    if (afterPrefix === "" || afterPrefix === "无") {
      boardResult = { missing: "empty-or-placeholder" };
    } else if (afterPrefix === "（空）") {
      boardResult = { value: "" };
    } else {
      boardResult = { value: afterPrefix };
    }
  }

  // body：元信息区（剥掉两行前缀，通常为空）+ 正文小节，**止于白板行之前**。
  // 白板在末尾 ⇒ 它不会被拼进正文（判据 7），白板内部写什么都切不到正文。
  const preamble = metaRegion
    .replace(/^标题：.*\r?\n?/m, "")
    .replace(/^描述：.*\r?\n?/m, "");
  const body = `${preamble}${summary.slice(bodyStart, bodyRegionEnd)}`;

  // description 按 token 夹断（issue #897：向量化单元），超了写 descriptionTruncated 标记。
  let descResult;
  let descTruncated = false;
  if (rawDesc !== undefined) {
    descResult = clampMetaTokens(rawDesc, SUMMARIZER_DESCRIPTION_MAX_TOKENS);
    descTruncated = descResult.truncated;
  }

  return {
    body,
    ...(rawTitle !== undefined
      ? { title: clampMetaChars(rawTitle, SUMMARIZER_TITLE_MAX_CHARS) }
      : { titleMissing: titleMatch ? "empty-or-placeholder" : "no-line" }),
    ...(rawDesc !== undefined
      ? { description: descResult.text }
      : { descriptionMissing: descMatch ? "empty-or-placeholder" : "no-line" }),
    ...(descTruncated ? { descriptionTruncated: true } : {}),
    ...("value" in boardResult
      ? { board: boardResult.value }
      : { boardMissing: boardResult.missing }),
  };
}

async function callSummarizerWithBound({
  summarizer,
  payload,
  roundRange,
  recoveryHint,
  inputBoundTokens,
  inputBoundBytes,
  priorSummary,
  budgetMs,
}) {
  const promptGuide = createSummarizerPromptGuide(recoveryHint);
  const deadlineAt = Number.isFinite(budgetMs) && budgetMs > 0 ? Date.now() + budgetMs : undefined;
  const remaining = () => (deadlineAt === undefined ? undefined : deadlineAt - Date.now());
  const invoke = (messages) => {
    const left = remaining();
    return summarizer({
      messages,
      roundRange,
      recoveryHint,
      promptGuide,
      ...(priorSummary === undefined ? {} : { priorSummary }),
      ...(left === undefined ? {} : { timeoutMs: Math.max(1, left) }),
    });
  };
  const fail = (error, droppedMessages, extra = {}) => summarizerFailure(error, {
    droppedMessages,
    ...extra,
  });
  const first = trimFoldedPayloadToLimits(payload, {
    maxBytes: inputBoundBytes,
    maxTokens: inputBoundTokens,
  });
  const limitPart = first.droppedRounds > 0 ? { droppedRounds: first.droppedRounds } : {};
  try {
    const summary = assertUsableSummary(await invoke(first.messages));
    return { summary, droppedMessages: first.dropped, attempts: 1, ...limitPart };
  } catch (error) {
    if (classifyFoldDegradeKind(error) !== "context_window_exceeded") {
      // issue #661：非超窗失败（超时 / 空摘要 / 任意 reject）没有自愈余地 ⇒ 直接终局。
      throw fail(error, first.dropped, limitPart);
    }
    const left = remaining();
    if (left !== undefined && left < MIN_RETRY_REMAINING_MS) {
      // 预算不够一次有意义的尝试：仍抛，但把「不是自愈不了，是没时间」写进 details。
      throw fail(error, first.dropped, { ...limitPart, budgetExhausted: true });
    }
    const retryBound = retryBoundFor(inputBoundTokens, first.messages);
    if (retryBound === undefined) throw fail(error, first.dropped, limitPart);
    const retry = trimBeforeRetry(first.messages, retryBound);
    if (retry.dropped === 0 && retry.collapsed === 0) throw fail(error, first.dropped, limitPart);
    try {
      const retrySummary = assertUsableSummary(await invoke(retry.messages));
      return {
        summary: retrySummary,
        droppedMessages: first.dropped + retry.dropped + retry.collapsed,
        attempts: 2,
        ...limitPart,
      };
    } catch (retryError) {
      // 重试又失败：若仍是普通报错，归因仍记超窗（否则「为什么缩了输入」会被掩盖）；
      // 超时 / 空摘要保留自己的分类（issue #661：`details.kind` 是四类原值）。
      const kind = classifyFoldDegradeKind(retryError);
      throw summarizerFailure(retryError, {
        kind: kind === "error" ? "context_window_exceeded" : kind,
        droppedMessages: first.dropped + retry.dropped + retry.collapsed,
        droppedRounds: first.droppedRounds,
        attempts: 2,
      });
    }
  }
}

/**
 * 重试前再收一次输入：首发加上去的那条省略注先塌掉（`collapsed`），
 * 再按 token 上限丢整条消息（`dropped`）。两个数分开记，
 * 免得把「注变短了」当成「丢了一条消息」。
 */
function trimBeforeRetry(messages, maxTokens) {
  const list = Array.isArray(messages) ? messages : [];
  const hasNote = list.length > 0 && list[0]?.__omissionNote === true;
  const body = hasNote ? list.slice(1) : list;
  const trimmed = trimOldestMessages(body, maxTokens);
  return {
    messages: trimmed.messages,
    dropped: trimmed.dropped,
    collapsed: hasNote ? 1 : 0,
  };
}

