import { KitError } from "../providers/errors.js";
import { computeBudget } from "../compact/budget.js";
import { enforceSize } from "../compact/enforce-size.js";
import { estimateMessageTokens, estimateTokens } from "../tokens.js";
import { groupIntoRounds } from "../messages/rounds.js";
import { blocksFor } from "./block-helpers.js";
// issue #609：截断标记的「别重跑有副作用的命令」那一句从聚合桩那边取（单一措辞之家）。
import { NO_RERUN_SIDE_EFFECT_CLAUSE } from "./aggregate-budget.js";

export function numberOr(value) {
  return Number.isFinite(value) ? value : undefined;
}

export function cloneState(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function isProtectedMessage(message, guard) {
  if (typeof guard === "function") return guard(message) === true;
  if (typeof guard === "string") return message?.role === guard;
  if (Array.isArray(guard)) return guard.includes(message?.role);
  return false;
}

export function normalizeToolNameSet(value, fallback) {
  const names = Array.isArray(value) ? value : fallback;
  return new Set(names.filter((name) => (
    typeof name === "string" && name.trim() !== ""
  )));
}

export function validateBudget(budgetTokens) {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
    throw new KitError(
      "invalid_budget",
      `budgetTokens must be a positive integer (got ${String(budgetTokens)})`,
      { retryable: false },
    );
  }
  return budgetTokens;
}

export function isApiInputOverBudget(apiInputTokens, budgetTokens) {
  return budgetTokens !== undefined
    && Number.isFinite(apiInputTokens)
    && apiInputTokens > budgetTokens;
}

export function projectedApiInputTokens(apiInputTokens, estimatedBefore, estimatedAfter) {
  if (
    !Number.isFinite(apiInputTokens)
    || apiInputTokens <= 0
    || !Number.isFinite(estimatedBefore)
    || estimatedBefore <= 0
  ) {
    return undefined;
  }
  return Math.ceil(apiInputTokens * estimatedAfter / estimatedBefore);
}

export function modelMetadataFor({ modelConfig, modelMetadata, model, provider, context }) {
  const candidates = [modelConfig, modelMetadata, model, provider, context];
  return candidates.find((candidate) => (
    candidate
    && typeof candidate === "object"
    && (
      candidate.contextWindowTokens !== undefined
      || candidate.maxOutputTokens !== undefined
      // issue #682：显式预算也是「这一格带预算元数据」的证据。只带 `budgetTokens` 的载体
      // （例如只配了预算、没配窗口的宿主）以前会被 `modelMetadataFor` 整个跳过。
      || candidate.budgetTokens !== undefined
    )
  ));
}

/**
 * 压缩预算的**引擎侧**唯一裁决点（issue #682）。
 *
 * 优先级一句话写死：**显式值优先于 `computeBudget` 派生**——
 *   · `context.budgetTokens`（宿主/CLI 已经解析过的那一格，含 `--compact-budget` 旗标）最优先；
 *   · 否则 `config.metadata.modelMetadata.budgetTokens`（引擎叶子，`config` 面的持久配置）；
 *   · 否则窗口派生（`computeBudget`，公式本体未动）；
 *   · 否则 `undefined` = 关闭压缩（语义保留；CLI 侧另有一行 stderr 告警，见 `bin/config.js`）。
 *
 * 为什么把裁决收在这里：`modelMetadataFor` 的五个候选（`modelConfig` / `modelMetadata` / `model` /
 * `provider` / `context`）是同一族「模型元数据载体」，加一个已知字段就必须在同一处决定它和派生的
 * 次序，否则「带了 budgetTokens 但缺 maxOutputTokens」会在两处各答一次（#682 的原始缺陷形状）。
 *
 * `source` 是**来源标注**（`flag` / `config` / `derived` / `disabled`）：`flag` / `config` 的前半段
 * 由宿主（CLI）解析，引擎把 `context.budgetSource` 原样带出；引擎自己认的显式预算一律是 `config`。
 * 非法的显式值**不在这里吞掉**——原样返回，交给调用方的 `validateBudget` 抛 `invalid_budget`。
 *
 * @param {{contextBudgetTokens?: number, contextBudgetSource?: "flag"|"config"|"derived"|"disabled", metadata?: *}} input
 * @returns {{budgetTokens: number|undefined, source: "flag"|"config"|"derived"|"disabled"|undefined}}
 */
export function resolveBudgetTokens({ contextBudgetTokens, contextBudgetSource, metadata }) {
  if (contextBudgetTokens !== undefined) {
    return { budgetTokens: contextBudgetTokens, source: contextBudgetSource };
  }
  const explicit = metadata?.budgetTokens;
  if (explicit !== undefined) {
    return { budgetTokens: explicit, source: "config" };
  }
  if (metadata?.contextWindowTokens !== undefined && metadata?.maxOutputTokens !== undefined) {
    return {
      budgetTokens: computeBudget({
        contextWindowTokens: metadata.contextWindowTokens,
        maxOutputTokens: metadata.maxOutputTokens,
      }),
      source: "derived",
    };
  }
  return { budgetTokens: undefined, source: "disabled" };
}

/**
 * The bag handed to `executeTool` (and the judge brief).
 *
 * #550: the `session` term used to be `session !== undefined ? session : context?.session`, i.e. the
 * **top-level** option won. Once `session` became the identity container on both routes (it is an
 * object with `id` / `modelSlot` / `initialMessages`), that term could only do harm: every host that
 * wrote a container had the whole container leak into `context.session`, and the documented opaque
 * payload (`config.folding.context.session`) became unreachable for exactly those hosts. The payload
 * therefore has one reader left — the fold-context shell — and the container has no path into tool
 * context at all.
 */
export function toolContextFor({
  toolContext,
  context,
  expert,
  user,
  task,
  requestId,
}) {
  const result = {
    ...(context?.toolContext && typeof context.toolContext === "object"
      ? context.toolContext
      : {}),
    ...(toolContext && typeof toolContext === "object" ? toolContext : {}),
  };
  for (const [key, value] of Object.entries({
    expert: expert !== undefined ? expert : context?.expert,
    user: user !== undefined ? user : context?.user,
    task: task !== undefined ? task : context?.task,
    session: context?.session,
    requestId: requestId !== undefined ? requestId : context?.requestId,
  })) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * 单条截断标记的**额度**（估算 token，issue #609）。
 *
 * 二分必须在这条额度**之后**剩下的预算上做：先截后贴会让返回值超出 `budgetTokens`，
 * 而 #846 刚把「单条受保护消息超预算 ⇒ 报 `budgetUnreachable`」那一族修成非致命，
 * 超出预算再回来就是把它原样引回去。
 * 标记本体实测 ~290 token；`test/loop-budget-truncation-marker-609.test.js`
 * 钉住 `estimateTokens(truncationMarkerText(...)) <= TRUNCATION_MARKER_RESERVE_TOKENS`，
 * 所以改文案把额度撑爆会当场变红，而不是让预算悄悄超。
 */
export const TRUNCATION_MARKER_RESERVE_TOKENS = 320;

/**
 * 标记的**判据词**（issue #609 复审 ①）：「被截断」这件事必须落在标记**最前面的码点**上。
 *
 * 为什么是位置问题而不是措辞问题：预算小到连标记都装不下时，返回值只能是标记的前缀，
 * 而前缀能带走的**只有开头那几个码点**。旧文案以「[本条内容已超上下文预算，尾部已被引擎
 * 截断」这一长串开头 ⇒ `截断` 二字落在第 20 多个码点（本估算器下要 ~40 token 才看得见），
 * 于是 `budget=1 → "["`、`budget=5 → "[本条"`：模型拿到的仍是「看起来像正常内容」的片段，
 * 正是 #609 要消灭的那个形状。判据词提到第 1～2 个码点后，门槛从 ~40 token 降到 4 token。
 *
 * 下面的数字**由 `estimateTokens` 现算**（估算器变了它跟着变），用例钉的是当前实测值：
 * 一个汉字值 2 token ⇒ 预算 1 连一个字都装不下（物理下限，`G9b` 显式钉住那条取舍）。
 */
export const TRUNCATION_JUDGE_WORD = "截断";

/** 判据词自己的开销：低于它，返回值只能带走判据词的前缀（见 `TRUNCATION_JUDGE_WORD`）。 */
export const TRUNCATION_JUDGE_WORD_TOKENS = estimateTokens(TRUNCATION_JUDGE_WORD);

/**
 * 截断标记里「怎么把剩余部分取回来」那一半（issue #609）。
 *
 * 口径抄 `aggregateStubText()`（被截 + 原始多少 + 怎么续 + 别重跑副作用命令），但
 * **整句只说能力、不说工具名**（复审 ②）：工具面由宿主注入（AGENTS.md §1「`runToolLoop`
 * with `executeTool` injected by the host」），这一层既拿不到装配后的工具面，也拿不到笔记
 * 账本，而 #746 的教训正是「不许指挥模型去调一个可能不在场上的工具」——票面里模型就是
 * 自己去猜了一个不存在的 `note_list`。所以旧文案里点名的 `readFile` / `exec` 一并去掉：
 * 「文件读取**类**工具」是**能力口径**（模型自己对号入座，不指定哪一个），`head`/`tail`/`sed`
 * 是 shell 命令而非工具名，留着服务走命令行那条路——读法是「用这类能力」，不是「必须调某个工具」。
 * 笔记那一支仍是条件式且不带工具名。措辞由 `G2` 钉着：出现工具名就红。
 */
export const TRUNCATION_READ_BACK_CLAUSE =
  "后续需要剩余部分：可用文件读取类工具按 offset/limit 分段读回；"
  + "命令输出则用 head/tail/sed 之类截取指定区间；"
  + "如本 run 写过笔记也可先从笔记取回要点；没写过就按上面方式重读源头。";

/**
 * 单条截断的尾部标记（issue #609）：内容被砍了要让模型看见，并且**报数字**。
 *
 * 排列顺序是判据（复审 ①）：**判据词打头** ⇒ 被截成前缀也仍然说得出「被截断了」；
 * 数字与续读指引排在后面，预算不够时先牺牲它们，绝不牺牲「被截了」这句话本身。
 *
 * 确定性：输出只由这四个数字决定（无时间戳、无随机）⇒ 同一输入两次调用逐字相同，
 * run snapshot / resume 重放因此还能逐字比对。
 *
 * @param {{originalChars: number, originalTokens: number, keptChars: number,
 *   keptTokens: number}} facts 原文与保留部分的字符数 / 估算 token
 * @returns {string}
 */
export function truncationMarkerText({
  originalChars, originalTokens, keptChars, keptTokens,
}) {
  const droppedTokens = Math.max(0, originalTokens - keptTokens);
  // 判据词占住最前面的码点（见 `TRUNCATION_JUDGE_WORD` 那段：这里换顺序就是换判据）。
  return `${TRUNCATION_JUDGE_WORD}[本条内容已超上下文预算，尾部已被引擎截断：`
    + `原文共 ${originalChars} 字符 ≈ ${originalTokens} token，`
    + `此处仅保留前 ${keptChars} 字符 ≈ ${keptTokens} token，被砍掉约 ${droppedTokens} token；`
    + TRUNCATION_READ_BACK_CLAUSE
    + NO_RERUN_SIDE_EFFECT_CLAUSE + "]";
}

/**
 * 在**码点数组**的前缀上二分出「估算 token 不超过 budgetTokens」的最长前缀长度（#609 陷阱 2）。
 *
 * 切点只能落在码点边界：调用方递进来的是 `Array.from(...)` 的结果，所以拼回去永远不会
 * 勬开代理对（旧实现已经如此，本函数只把它从 `truncateTextToBudget` 里抽出来复用三次）。
 *
 * @param {string[]} characters 原文的码点数组
 * @param {number} budgetTokens
 * @returns {number}
 */
function fitCharacterCount(characters, budgetTokens) {
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join("")) <= budgetTokens) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * 截断到预算，并在尾部**留下标记**（issue #609）。
 *
 * 三种「内容丢失」里这是最后一种静默的：字段被修剪会写 `[已修剪]`（`prunedFieldText`，#469），
 * 整条消息被删会写桩（`stubFor`），只有它以前返回裸 slice ⇒ 模型拿着半截工具结果却不知道自己
 * 被砍了（票面实测：119k 字符文档、5 条事实 0 命中，模型还诚实地报「文档约 171771 字符」）。
 *
 * 三条不变量（每条都有用例钉着）：
 *   ① 没被截断的输入**一个字节都不变**（下面那行早退，不加任何前后缀）；
 *   ② `estimateTokens(返回值) <= budgetTokens`：二分在 `budgetTokens - 标记额度` 上做，
 *      预算小到连标记都装不下时整段（含标记）再走一次同一二分 ⇒ 返回值是**标记自己的
 *      前缀**，而标记第一个词就是判据词（复审 ①），所以最坏情况模型仍看得见「截断」，
 *      绝不会拿到一段「看起来像正常内容」的片段；
 *   ③ 同一输入两次调用逐字相同。
 *
 * @param {unknown} text
 * @param {number} budgetTokens
 * @returns {string}
 */
export function truncateTextToBudget(text, budgetTokens) {
  const value = String(text ?? "");
  const originalTokens = estimateTokens(value);
  // 未截断那一支：早退，一个字节都不动（既有用例钉着）。
  if (originalTokens <= budgetTokens) return value;
  const characters = Array.from(value);
  const originalChars = characters.length;
  const reserve = Math.min(
    TRUNCATION_MARKER_RESERVE_TOKENS,
    Math.max(0, budgetTokens - 1),
  );
  const compose = (contentBudget) => {
    const keptChars = fitCharacterCount(characters, contentBudget);
    const kept = characters.slice(0, keptChars).join("");
    return kept + truncationMarkerText({
      originalChars,
      originalTokens,
      keptChars,
      keptTokens: estimateTokens(kept),
    });
  };
  let contentBudget = budgetTokens - reserve;
  let composed = compose(contentBudget);
  // 标记比额度还大（预算只剩几百 token 的极端格）⇒ 从正文里继续让空间，直到整段装得下。
  while (estimateTokens(composed) > budgetTokens && contentBudget > 0) {
    contentBudget = Math.floor(contentBudget / 2);
    composed = compose(contentBudget);
  }
  if (estimateTokens(composed) <= budgetTokens) return composed;
  // 走到这一格，预算连标记本身都装不下：整段（此时正文已让到 0，整段 == 标记）再截一次。
  // 退化阶梯由标记自己的前缀给出：判据词排在最前面 ⇒ 拿得下两个字就说「截断」，只拿得下一个
  // 字就说「截」，物理上连一个字都拿不下（预算 1）才是空串（`G9b` 钉住这条取舍）。
  const whole = Array.from(composed);
  return whole.slice(0, fitCharacterCount(whole, budgetTokens)).join("");
}

export function dropOldestUnprotectedRound(messages, protectedMessage) {
  const { head, rounds } = groupIntoRounds(messages);
  const index = rounds.findIndex((round) => !round.messages.some((message) => (
    isProtectedMessage(message, protectedMessage)
  )));
  if (index < 0) return undefined;
  const start = head.length + rounds
    .slice(0, index)
    .reduce((total, round) => total + round.messages.length, 0);
  const count = rounds[index].messages.length;
  return messages.splice(start, count);
}

export async function safeTruncateMessages(messages, budgetTokens, protectedMessage, stubFor) {
  const result = cloneState(messages);
  const downgraded = new Set();
  const foldedPayload = [];
  const foldedStubs = [];
  const collectStubs = async (removed) => {
    if (typeof stubFor !== "function") return;
    for (const message of removed ?? []) {
      if (!Array.isArray(message?.content) || !message.content.some((block) => (
        block?.type === "tool_result"
      ))) continue;
      const stub = await stubFor(message);
      if (typeof stub !== "string" || stub.trim() === "") continue;
      foldedStubs.push(Array.from(stub).slice(0, 200).join(""));
    }
  };
  let protectedDowngraded = 0;
  const isCurrentlyProtected = (message) => (
    isProtectedMessage(message, protectedMessage) && !downgraded.has(message)
  );
  const downgradeProtected = (message) => {
    if (!isCurrentlyProtected(message)) return false;
    downgraded.add(message);
    protectedDowngraded += 1;
    return true;
  };
  const removeMessages = async (start, count) => {
    const removed = result.slice(start, start + count);
    foldedPayload.push(
      ...removed
        .filter((message) => downgraded.has(message))
        .map((message) => cloneState(message)),
    );
    await collectStubs(removed);
    result.splice(start, count);
  };
  while (estimateMessageTokens(result) > budgetTokens) {
    const removed = dropOldestUnprotectedRound(
      result,
      (message) => isCurrentlyProtected(message),
    );
    if (removed === undefined) break;
    await collectStubs(removed);
    // Remove complete rounds before reducing individual message content.
  }

  const fields = [];
  const references = [];
  result.forEach((message, messageIndex) => {
    const protectedMessageValue = isCurrentlyProtected(message);
    if (typeof message.content === "string") {
      fields.push({
        key: `message-${messageIndex}`,
        text: message.content,
        priority: messageIndex,
        protected: protectedMessageValue,
      });
      references.push({
        fieldIndex: fields.length - 1,
        messageIndex,
        blockIndex: undefined,
      });
      return;
    }
    for (const [blockIndex, block] of (message.content ?? []).entries()) {
      let text;
      let kind;
      if (block?.type === "text" || block?.type === "reasoning") {
        text = block.text;
        kind = "text";
      } else if (block?.type === "tool_result") {
        text = block.content;
        kind = "content";
      }
      if (text === undefined) continue;
      fields.push({
        key: `message-${messageIndex}-block-${blockIndex}`,
        text: String(text),
        priority: messageIndex,
        protected: protectedMessageValue,
      });
      references.push({
        fieldIndex: fields.length - 1,
        messageIndex,
        blockIndex,
        kind,
      });
    }
  });
  const trimmableFields = fields
    .map((field, fieldIndex) => ({ ...field, fieldIndex }))
    .filter((field) => field.protected !== true);
  const enforced = enforceSize(trimmableFields, budgetTokens);
  const enforcedByIndex = new Map(
    enforced.fields.map((field) => [field.fieldIndex, field]),
  );
  // 写回面只有 `truncateTextToBudget` 一个收口（issue #609）：三个出口（整条消息的字符串 content /
  // block.text / block.content）都在下面这一组分支里，所以「被截了」这句话只需在那里补一次。
  // 被 enforceSize 修剪成 `[已修剪]` 的字段很短，落不到截断那一格 ⇒ 不会叠上两个标记。
  for (const reference of references) {
    const enforcedField = enforcedByIndex.get(reference.fieldIndex);
    if (enforcedField === undefined) continue;
    const text = enforcedField.text;
    if (reference.blockIndex === undefined) {
      result[reference.messageIndex].content = truncateTextToBudget(
        text,
        budgetTokens,
      );
    } else if (reference.kind === "text") {
      result[reference.messageIndex].content[reference.blockIndex].text =
        truncateTextToBudget(text, budgetTokens);
    } else {
      result[reference.messageIndex].content[reference.blockIndex].content =
        truncateTextToBudget(text, budgetTokens);
    }
  }

  result.forEach((message) => {
    if (!Array.isArray(message.content)) return;
    message.content = message.content.filter((block) => (
      block?.type !== "image" && block?.type !== "image_url"
    )).map((block) => {
      if (block?.type !== "tool_use") return block;
      return { ...block, input: {} };
    });
  });

  /**
   * @param {"protected_message_exceeds_budget"|"cannot_fit"|undefined} budgetUnreachable
   */
  const finish = (budgetUnreachable) => {
    const uniqueStubs = [...new Set(foldedStubs)];
    if (uniqueStubs.length > 0) {
      const firstUser = result.findIndex((message) => message?.role === "user");
      if (firstUser >= 0) {
        const user = result[firstUser];
        const content = typeof user.content === "string"
          ? [{ type: "text", text: user.content }]
          : Array.isArray(user.content) ? user.content : [];
        result[firstUser] = {
          ...user,
          content: [
            ...content,
            { type: "text", text: uniqueStubs.slice(0, 10).join("\n") },
          ],
        };
      }
    }
    return {
      messages: result,
      tokensAfter: estimateMessageTokens(result),
      enforced,
      foldedPayload,
      foldedStubs: uniqueStubs,
      protectedDowngraded,
      budgetUnreachable,
    };
  };

  for (const message of result) {
    if (isCurrentlyProtected(message) && estimateMessageTokens([message]) > budgetTokens) {
      return finish("protected_message_exceeds_budget");
    }
  }

  while (estimateMessageTokens(result) > budgetTokens) {
    const removableIndex = result.findIndex((message) => (
      !isCurrentlyProtected(message)
    ));
    if (removableIndex < 0) {
      const oldestProtected = result.find((message) => isCurrentlyProtected(message));
      if (oldestProtected === undefined) {
        return finish("cannot_fit");
      }
      downgradeProtected(oldestProtected);
      continue;
    }
    const message = result[removableIndex];
    const uses = blocksFor(message.content).filter((block) => block?.type === "tool_use");
    const results = blocksFor(message.content).filter((block) => block?.type === "tool_result");
    if (uses.length > 0 && result[removableIndex + 1]?.role === "user") {
      if (isCurrentlyProtected(result[removableIndex + 1])) {
        downgradeProtected(result[removableIndex + 1]);
        continue;
      }
      await removeMessages(removableIndex, 2);
    } else if (results.length > 0 && removableIndex > 0
      && result[removableIndex - 1]?.role === "assistant") {
      if (isCurrentlyProtected(result[removableIndex - 1])) {
        downgradeProtected(result[removableIndex - 1]);
        continue;
      }
      await removeMessages(removableIndex - 1, 2);
    } else {
      await removeMessages(removableIndex, 1);
    }
  }
  return finish(undefined);
}
