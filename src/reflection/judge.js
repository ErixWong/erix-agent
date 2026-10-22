import { extractL0Facts } from "./l0.js";
import { estimateTokens } from "../tokens.js";
import { parseModelJson } from "../text/parse-model-json.js";

const MAX_COMMAND_LENGTH = 40;

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (
      block?.text ?? block?.content ?? ""
    )).join("");
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

function truncate(value, length) {
  return Array.from(String(value ?? "")).slice(0, length).join("");
}

/** 从工具的 `input` 里选出它声明要写的那个路径键（按 `writeToolPathKeys` 顺序取第一个非空字符串）。
 *  `readFile` 的摘要参数与写工具的原始路径共用这一份解析口径（issue #191 的「一个可改点」纪律）。
 *
 *  @param {any} input
 *  @param {string[]|undefined} writeToolPathKeys
 *  @returns {string|undefined} 命中的键名（不是路径值）
 */
function resolvePathKey(input, writeToolPathKeys) {
  return writeToolPathKeys?.find((key) => (
    typeof input?.[key] === "string" && input[key].trim() !== ""
  ));
}

/** 写工具 → 它声明要写的那个路径的**原始值**（不摘要、不截断、不裁斜杠）；不是写工具或没带
 *  可解析的路径键 ⇒ `undefined`。
 *
 *  为什么与 `summarizeArgument` 分开而不是加个参数：两者的**契约方向相反**——摘要参数是给人/模型
 *  看的提示（`MAX_COMMAND_LENGTH = 40` 且**不带截断标记**，见 issue #388 的实测），原始路径是给
 *  `stat()` 用的判据（必须逐字相等）。塞进同一个函数就会有人顺手把上限套到原始值上。
 *
 *  @param {string} name
 *  @param {any} input
 *  @param {{writeToolNames?: Set<string>, writeToolPathKeys?: string[]}} [options]
 *  @returns {string|undefined}
 */
export function rawWritePath(name, input, { writeToolNames, writeToolPathKeys } = {}) {
  if (!writeToolNames?.has(name)) return undefined;
  const pathKey = resolvePathKey(input, writeToolPathKeys);
  return pathKey === undefined ? undefined : input[pathKey];
}

function summarizeArgument(name, input, { writeToolNames, writeToolPathKeys } = {}) {
  if (name === "exec") return truncate(input?.command, MAX_COMMAND_LENGTH);
  if (name === "readFile" || writeToolNames?.has(name)) {
    const pathKey = resolvePathKey(input, writeToolPathKeys);
    if (pathKey !== undefined) return truncate(input[pathKey], MAX_COMMAND_LENGTH);
    return "";
  }
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncate(input, MAX_COMMAND_LENGTH);
  try {
    return truncate(JSON.stringify(input), MAX_COMMAND_LENGTH);
  } catch {
    return "";
  }
}

/**
 * judge 的默认写工具集（issue #191）。
 *
 * 为什么只有一处：`writeToolNames` 的默认值在三个地方被读到（本文件的 timeline 回退、
 * `orchestrator.js` 的参数默认值、`normalizeToolNameSet` 的回退），此前它们是三份相同的字面量——
 * 新增一个写工具时漏改任一处，judge 的 `filesWritten` 就会**静默少报**（不是错报，是“没看见”）。
 * 共享常量后只有一个可改点；`scripts/docs-drift-check.mjs` 的默认值锚点也从这里抽真值。
 * 宿主显式传入时仍以宿主为准（本常量只做缺省）。
 */
export const DEFAULT_WRITE_TOOL_NAMES = ["writeFile", "edit"];

/**
 * Extract a compact index from the messages added in a round.
 * Tool output is deliberately omitted because the full conversation is the
 * authoritative source; the timeline only helps the judge locate tool work.
 */
export function buildTimeline(messages, roundStart = 0, options = {}) {
  const selected = Array.isArray(messages)
    ? messages.slice(Math.max(0, Number.isSafeInteger(roundStart) ? roundStart : 0))
    : [];
  const { writeToolNames, writeToolPathKeys } = resolveWriteOptions(options);
  const toolCalls = [];
  const statusById = new Map();

  for (const message of selected) {
    for (const block of blocksFor(message?.content)) {
      if (block?.type === "tool_use") {
        toolCalls.push({
          name: String(block.name ?? ""),
          arg: summarizeArgument(block.name, block.input, {
            writeToolNames,
            writeToolPathKeys,
          }),
          repeatKey: (() => {
            try {
              return JSON.stringify([block.name, block.input]);
            } catch {
              return `${String(block.name ?? "")}\u0000${summarizeArgument(block.name, block.input, {
                writeToolNames,
                writeToolPathKeys,
              })}`;
            }
          })(),
          _toolUseId: block.id,
        });
      } else if (block?.type === "tool_result") {
        if (block.tool_use_id !== undefined) {
          const result = textFromContent(block.content);
          // 读路径（工单 261014 T2）：状态与成败现在住在 `erix.*`，顶层旧同名键只作升级前记录的回退。
          const success = block.erix?.success ?? block.success;
          const intercepted = (block.erix?.executionStatus ?? block.executionStatus) === "intercepted"
            || result.startsWith("【审计拦截】");
          statusById.set(
            block.tool_use_id,
            intercepted
              ? "intercepted"
              : block.is_error === true || success === false
                ? "error"
                : "ok",
          );
        }
      }
    }
  }

  const errorCounts = new Map();
  let errorRepeat = 0;
  const paired = toolCalls.map((call) => {
    const status = call._toolUseId !== undefined
      ? statusById.get(call._toolUseId) ?? "pending"
      : "pending";
    let repeat = 0;
    if (status === "error") {
      repeat = (errorCounts.get(call.repeatKey) ?? 0) + 1;
      errorCounts.set(call.repeatKey, repeat);
      errorRepeat = Math.max(errorRepeat, repeat);
    }
    const clean = {
      name: call.name,
      arg: call.arg,
      status,
    };
    return clean;
  });

  const l0facts = extractL0Facts(selected);
  return {
    toolCalls: paired,
    outputs: [],
    exitOk: l0facts.exitOk,
    errors: l0facts.errorTexts ?? [],
    errorRepeat,
  };
}

/** `writeToolNames` / `writeToolPathKeys` 的缺省口径（issue #191 的「一个可改点」）：
 *  `buildTimeline`（摘要参数）与 `rawWritePaths`（原始路径）读同一份，不各写一遍。
 *
 *  @param {{writeToolNames?: Set<string>|string[], writeToolPathKeys?: string[]}} options
 *  @returns {{writeToolNames: Set<string>, writeToolPathKeys: string[]}}
 */
function resolveWriteOptions(options) {
  const writeToolNames = options.writeToolNames instanceof Set
    ? options.writeToolNames
    : new Set(Array.isArray(options.writeToolNames) ? options.writeToolNames : DEFAULT_WRITE_TOOL_NAMES);
  const writeToolPathKeys = Array.isArray(options.writeToolPathKeys)
    ? options.writeToolPathKeys
    : ["path", "file_path"];
  return { writeToolNames, writeToolPathKeys };
}

/** 一轮（或若干条）消息里写工具声明要写的**原始路径**（issue #388），按出现顺序。
 *
 *  为什么是**另一个**导出而不是 `buildTimeline` 的一格：`buildTimeline` 的返回形状是 judge 提示面的
 *  既有契约（`toolCalls: [{name, arg, status}]`，测试逐字深比），本单不需要动它；台账要的只是
 *  「哪个工具、写了哪个原值路径」两件事。两者共用 `resolveWriteOptions` / `rawWritePath`，
 *  所以「哪个键算路径」「哪个工具算写工具」只有一份口径。
 *
 *  @param {object[]} messages
 *  @param {number} [roundStart]
 *  @param {{writeToolNames?: Set<string>|string[], writeToolPathKeys?: string[]}} [options]
 *  @returns {{name:string, path:string}[]}
 */
export function rawWritePaths(messages, roundStart = 0, options = {}) {
  const selected = Array.isArray(messages)
    ? messages.slice(Math.max(0, Number.isSafeInteger(roundStart) ? roundStart : 0))
    : [];
  const { writeToolNames, writeToolPathKeys } = resolveWriteOptions(options);
  const writes = [];
  for (const message of selected) {
    for (const block of blocksFor(message?.content)) {
      if (block?.type !== "tool_use") continue;
      const path = rawWritePath(block.name, block.input, { writeToolNames, writeToolPathKeys });
      if (path !== undefined) writes.push({ name: String(block.name ?? ""), path });
    }
  }
  return writes;
}

function formatTimeline(timeline) {
  const entries = Array.isArray(timeline) ? timeline : [];
  const indexed = [];
  for (const entry of [...entries].reverse()) {
    for (const call of entry?.toolCalls ?? []) {
      indexed.push({ entry, call });
    }
  }

  const errorCounts = new Map();
  for (const item of indexed) {
    if (item.call?.status !== "error") continue;
    const key = `${item.call.name}\u0000${item.call.arg}`;
    const repeat = (errorCounts.get(key) ?? 0) + 1;
    errorCounts.set(key, repeat);
    item.repeat = repeat;
  }

  const lines = [];
  for (const item of indexed.reverse()) {
    const entry = item.entry;
    const call = item.call;
    const round = entry?.round ?? "?";
    const status = ["ok", "error", "intercepted", "pending"].includes(call?.status)
      ? call.status
      : "pending";
    const entryErrorCount = (entry?.toolCalls ?? [])
      .filter((entryCall) => entryCall?.status === "error")
      .length;
    const entryRepeat = Number.isSafeInteger(entry?.errorRepeat)
      ? entry.errorRepeat
      : 0;
    const repeat = status === "error"
      ? entryErrorCount === 1
        ? Math.max(item.repeat ?? 0, entryRepeat)
        : item.repeat
      : undefined;
    const repeatText = repeat >= 2 ? `，重复第${repeat}次` : "";
    lines.push(`R${round}: ${call?.name ?? ""} ${call?.arg ?? ""} [${status}${repeatText}]`.trim());
  }
  return lines.join("\n") || "（暂无工具足迹）";
}

function formatFiles(filesWritten) {
  if (Array.isArray(filesWritten)) {
    return filesWritten.map((file) => {
      if (file && typeof file === "object") {
        return `${file.path ?? file.name ?? ""}${file.round === undefined ? "" : `(R${file.round})`}`;
      }
      return String(file);
    }).filter(Boolean).join(", ") || "（无）";
  }
  return String(filesWritten ?? "（无）");
}

function formatErrors(recentErrors) {
  if (Array.isArray(recentErrors)) {
    return recentErrors.map((error) => {
      if (error && typeof error === "object") {
        return error.errorText ?? error.error ?? JSON.stringify(error);
      }
      return String(error);
    }).filter(Boolean).join("\n") || "无";
  }
  return String(recentErrors ?? "无");
}

// 完整对话的 token 预算：round judge 给全量，intercept 只取最新的一段（成本/延迟更省）。
const JUDGE_CONVERSATION_TOKENS = 100_000;
// intercept 审计只取最近进展。2026-09-20 基准实测：relay prefill ~700-900 tok/s，
// 40k prefill 需 45-60s 必超 judgeInterceptTimeoutMs 默认 30s（实测 6/7 次审计超时），
// 每次阻塞主循环 30s；6k prefill ~8s 可稳进 30s 超时内。
export const INTERCEPT_CONVERSATION_TOKENS = 6_000;

function jsonish(value) {
  if (value === undefined || value === null) return "（无）";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function blocksOf(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (message?.content === undefined || message?.content === null) return [];
  return [{ type: "text", text: String(message.content) }];
}

function resultContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return String(block.text ?? "");
        if (block?.type === "image") return "[图片内容未内联]";
        return jsonish(block);
      })
      .filter((part) => part !== "")
      .join("\n");
  }
  return jsonish(content);
}

/**
 * Render the conversation as plain text for the judge, without the 60/200-char
 * projection used for the timeline. Notes:
 * - messages marked `meta.source === "judge-control"` (direction hints) are excluded
 *   so the judge's own earlier advice cannot feed back as evidence;
 * - tool_use without a matching tool_result is labelled as not-yet-executed;
 * - intercepted results are labelled as control events, not as tool output;
 * - the first user text (task) and the latest assistant text (deliverable) are always
 *   kept; the rest is filled from newest to oldest within the token budget.
 */
export function renderConversation(messages, { maxTokens = JUDGE_CONVERSATION_TOKENS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const visible = list.filter((message) => message?.meta?.source !== "judge-control");
  const resolvedToolUseIds = new Set();
  for (const message of visible) {
    for (const block of blocksOf(message)) {
      if (block?.type === "tool_result" && block.tool_use_id !== undefined) {
        resolvedToolUseIds.add(block.tool_use_id);
      }
    }
  }

  const sections = [];
  let firstUserText = -1;
  let latestAssistantText = -1;
  for (const message of visible) {
    const role = String(message?.role ?? "?");
    for (const block of blocksOf(message)) {
      const type = block?.type;
      let text = "";
      if (type === "text") {
        const body = String(block?.text ?? "").trim();
        if (body === "") continue;
        text = `### ${role}\n${body}`;
        if (role === "user" && firstUserText < 0) firstUserText = sections.length;
        else if (role === "assistant") latestAssistantText = sections.length;
      } else if (type === "reasoning") {
        const body = String(block?.text ?? block?.content ?? "").trim();
        if (body === "") continue;
        text = `### ${role}（内部自述，不可作为事实依据）\n${body}`;
      } else if (type === "tool_use") {
        const pending = block?.id !== undefined && !resolvedToolUseIds.has(block.id);
        const status = pending ? "（本轮尚未执行，等待结果）" : "";
        text = `### ${role} 计划调用工具 ${String(block?.name ?? "")}${status}\n入参：${jsonish(block?.input)}`;
      } else if (type === "tool_result") {
        const body = resultContentText(block?.content);
        // 同上：`erix` 优先，顶层旧同名键只作旧记录回退。
        const intercepted = (block?.erix?.executionStatus ?? block?.executionStatus) === "intercepted"
          || body.startsWith("【审计拦截】");
        const label = intercepted
          ? "控制事件（该工具调用未执行）"
          : block?.is_error === true ? "工具结果（错误）" : "工具结果";
        text = `### ${label}\n${body}`;
      } else if (type === "image") {
        text = `### ${role} 图片（内容未内联，类型=${String(block?.mediaType ?? "unknown")}）`;
      } else if (type === "raw") {
        text = `### ${role} 原始块（协议=${String(block?.protocol ?? "unknown")}，内容未展开）`;
      } else if (type !== undefined) {
        text = `### ${role} 未知块类型 ${String(type)}`;
      }
      if (text.trim() === "") continue;
      sections.push({ text, tokens: estimateTokens(text) });
    }
  }

  const mandatory = new Set();
  if (firstUserText >= 0) mandatory.add(firstUserText);
  if (latestAssistantText >= 0) mandatory.add(latestAssistantText);
  let budget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : Number.POSITIVE_INFINITY;
  for (const index of mandatory) budget -= sections[index].tokens;
  const keep = new Set(mandatory);
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (keep.has(index)) continue;
    if (sections[index].tokens > budget) continue;
    keep.add(index);
    budget -= sections[index].tokens;
  }

  const out = [];
  let omitted = 0;
  for (let index = 0; index < sections.length; index += 1) {
    if (!keep.has(index)) {
      omitted += 1;
      continue;
    }
    if (omitted > 0) {
      out.push(`…（此处省略 ${omitted} 段较早内容）…`);
      omitted = 0;
    }
    out.push(sections[index].text);
  }
  if (omitted > 0) out.push(`…（末尾省略 ${omitted} 段）…`);
  return out.join("\n\n");
}

/**
 * Build the independent judge's prompt from objective round footprints plus the
 * full conversation when the caller supplies it.
 */
export function buildJudgePrompt(
  taskBrief,
  rounds,
  timeline = [],
  filesWritten = [],
  recentErrors = [],
  conversationText = "",
  budget = {},
) {
  const entries = Array.isArray(timeline)
    ? timeline
    : timeline && typeof timeline === "object"
      ? [timeline]
      : [];
  const recent = entries.slice(-12).reverse();
  const outputLines = conversationText ? "（详见完整对话记录）" : "无";
  const hasBudget = Number.isFinite(budget?.budgetRounds)
    && Number.isFinite(budget?.effectiveMaxRounds);
  const nearLimit = budget?.nearLimit === true
    || (hasBudget && budget.budgetRounds >= Math.floor(budget.effectiveMaxRounds * 0.8));
  const budgetLine = hasBudget
    ? `预算事实：当前预算轮 r=${budget.budgetRounds}/${budget.effectiveMaxRounds}；扩轮次数 ${Number.isFinite(budget.extensionCount) ? budget.extensionCount : 0}/${Number.isFinite(budget.maxExtensions) ? budget.maxExtensions : "∞"}`
    : "";
  const extensionInstruction = nearLimit
    ? `当前已进入 nearLimit 扩轮评估窗口。必须额外判断是否需要扩轮：
- extend=true 仅表示任务尚未完成且当前上限不足以可靠完成；extend=false 表示无需扩轮、应尽快收敛。
- extendReason 填写扩轮判断依据；plan 填写扩轮后下一步具体动作。
`
    : "";
  const decisionSchema = nearLimit
    ? '{"done":true|false,"confidence":0-1,"reason":"一句话","evidence":"支撑事实","direction":"on_track|uncertain|off_track","directionReason":"路线判断一句话（可选）","extend":true|false,"extendReason":"扩轮判断依据","plan":"下一步具体动作"}'
    : '{"done":true|false,"confidence":0-1,"reason":"一句话","evidence":"支撑事实","direction":"on_track|uncertain|off_track","directionReason":"路线判断一句话（可选）"}';
  return `【每轮 Judge】你是交付评审者，独立判断任务是否完成。不要执行工具，不要相信模型自报。

任务目标：${Array.from(String(taskBrief ?? "")).slice(0, 2000).join("") || "（未提供）"}
已运行轮数：${Number.isFinite(rounds) ? rounds : 0}
${budgetLine}
时间线（最新在前）：
${formatTimeline(recent)}
写过的文件：${formatFiles(filesWritten)}
最近验证输出：
${outputLines || "无"}
最近错误：
${formatErrors(recentErrors)}
${
    conversationText
      ? `完整对话记录（原始材料；模型自己写的文字是它的自述与计划，不是已核实的事实）：

${conversationText}

判断是否已经满足原始任务目标。上面的时间线只是索引，完整对话记录才是原始依据；如果任务只在对话文本里交付（没有写文件），这属于正常交付，不能因为“没有写过文件”判 done=false；请依据对话中的实际交付内容判断。若方向错误、关键产物缺失或验证输出不符合目标，done 必须为 false。
`
      : "判断是否已经满足原始任务目标。若方向错误、关键产物缺失或验证输出不符合目标，done 必须为 false。\n"
  }
额外判断方向（direction）：看时间线模型是否在合理推进（尝试新方法、接近验证、产物渐进），还是深陷单一实现细节反复调试。direction 只是提示，不影响 done。
${extensionInstruction}
只输出 JSON，不要输出其他文字：
${decisionSchema}`;
}

/**
 * Parse a judge response while tolerating code fences and incidental prose.
 *
 * 候选扫描从本刀的私有 `jsonCandidates` 改成复用公共入口 `parseModelJson`（issue #307），
 * 并显式传 `topOnly: false` —— 那正是本文件原来那一档「每个 `{` 起扫一次」，
 * **语义一字未改**：外层对象未闭合时照样先拿到内层残片（实测
 * `{"outer":{"done":true,"confidence":0.5,"reason":"..."}` 仍返回那个内层决策），
 * 把它改成只认顶层对象是行为变更，留给 issue #309。
 *
 * 为什么只用它的 `candidates` 而不用它的 `value`：本函数的门槛比 `requireKeys` 的键存在性
 * 判定严（`done` 必须是字面布尔、`confidence` 必须是 [0,1] 的有限数……），而**不合格时必须
 * 继续试下一个候选**；公共入口只返回单个 `value`，拿它就等于把「跳过这个候选」改成
 * 「整次失败」——那是行为变更，不在本单范围。
 */
export function parseJudgeDecision(text) {
  for (const candidate of parseModelJson(text, { topOnly: false }).candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (typeof parsed.done !== "boolean") continue;
      if (!Number.isFinite(parsed.confidence)
        || parsed.confidence < 0
        || parsed.confidence > 1) continue;
      if (parsed.reason !== undefined && typeof parsed.reason !== "string") continue;
      if (parsed.evidence !== undefined && typeof parsed.evidence !== "string") continue;
      if (parsed.extend !== undefined && typeof parsed.extend !== "boolean") continue;
      if (parsed.extendReason !== undefined && typeof parsed.extendReason !== "string") continue;
      if (parsed.plan !== undefined && typeof parsed.plan !== "string") continue;
      const decision = {
        done: parsed.done,
        confidence: parsed.confidence,
        reason: String(parsed.reason ?? ""),
        evidence: String(parsed.evidence ?? ""),
        direction: parsed.direction === "on_track"
          || parsed.direction === "uncertain"
          || parsed.direction === "off_track"
          ? parsed.direction
          : undefined,
        directionReason: typeof parsed.directionReason === "string"
          ? parsed.directionReason
          : "",
      };
      if (parsed.extend !== undefined) decision.extend = parsed.extend;
      if (parsed.extendReason !== undefined) decision.extendReason = parsed.extendReason;
      if (parsed.plan !== undefined) decision.plan = parsed.plan;
      return decision;
    } catch {
      // Try the next balanced object in surrounding provider text.
    }
  }
  return null;
}
