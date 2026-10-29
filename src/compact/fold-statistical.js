import { groupIntoRounds } from "../messages/rounds.js";
import { summarizeToolCall } from "../loop/tool-result-ttl.js";
import { estimateMessageTokens } from "../tokens.js";
import {
  ANCHOR_SECTION_HEADING,
  clampAnchorSection,
  extractAnchors,
  splitAnchorValues,
} from "./anchors.js";
import {
  cloneFoldPayload,
  collectTtlFoldStubs,
  DEFAULT_RECOVERY_HINT,
  FOLD_STUB_LINE_PATTERN,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  resolveFoldStubs,
  runFoldHook,
  resolveFoldRecoveryHint,
  resolveRecoveryHint,
  selectFoldedRounds,
  isRealUser,
} from "./helpers.js";

export const FOLD_SUMMARY_MARKER = "【上下文折叠·v1·erix-9f6e2c】";

/**
 * 工具调用清单的上界（issue #564 缺口 2）：**最多 8 条 × 每条 ≤80 字符**。
 *
 * 这是清单自己的形状上界，不是**新的字节预算** —— 清单落在既有 `FOLDED_FACTS_MAX_BYTES`
 * （默认 2048，`buildFoldedFacts` 做前缀夹断）之内：它排在区间行之后、锚点节之前，
 * 所以字节夹断削掉的是后面的锚点/提示，而不是清单（见 `formatFoldSummary` 的行序）。
 */
export const MAX_TOOL_INVENTORY_ENTRIES = 8;
export const MAX_TOOL_INVENTORY_CHARS = 80;

// 清单节的标题行：**机械清单 ≠ 执行成功**，措辞不得暗示“已交付/已完成”（#392 的订正结论）。
const TOOL_INVENTORY_HEADING = "工具调用清单（机械摘要，不代表执行成功）：";

const MAX_NAVIGATION_ARTIFACTS = 10;
const MAX_NAVIGATION_CHARS = 400;
const NAVIGATION_STATUSES = new Set(["archived", "truncated", "external", "expired"]);

function normalizedKeepRounds(value) {
  if (value === undefined) return 6;
  if (!Number.isFinite(value)) return 6;
  return Math.max(0, Math.floor(value));
}

function blocksFor(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content;
}

function countToolUses(messages) {
  const counts = new Map();
  for (const message of messages) {
    for (const block of blocksFor(message)) {
      if (block?.type !== "tool_use") continue;
      const name = String(block.name ?? "");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

function toolFootprint(rounds) {
  const counts = countToolUses(rounds.flatMap((round) => round.messages));

  if (counts.size === 0) return "无";

  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}

// 清单条目夹取：先压成单行（防换行拆节），再按**字符**夹到 `MAX_TOOL_INVENTORY_CHARS`
// （超出时末位换成 `…`，于是“≤80 字符”是硬成立而不是“80+省略号”）。
function clampInventoryEntry(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (text === "") return "";
  const characters = Array.from(text);
  if (characters.length <= MAX_TOOL_INVENTORY_CHARS) return text;
  return `${characters.slice(0, MAX_TOOL_INVENTORY_CHARS - 1).join("")}…`;
}

/**
 * 从被折轮次里抽出**工具调用清单**（issue #564 缺口 2）：逐条 `name + 关键入参`。
 *
 * 复用 `summarizeToolCall`（`src/loop/tool-result-ttl.js`）—— 与 TTL 占位符同一个“一次调用长什么样”
 * 口径，不另写一套。数据源是 `tool_use` 块（不是 `tool_result` 正文：正文可再取回，入参才是“跑了什么”）。
 * 同一条重复调用只占一个格（去重后仍受 `MAX_TOOL_INVENTORY_ENTRIES` 夹取）。
 *
 * @param {object[]} messages 被折轮次的消息
 * @returns {string[]} 已夹取的条目（≤8 条 × ≤80 字符）
 */
export function toolCallInventory(messages) {
  const entries = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of blocksFor(message)) {
      if (block?.type !== "tool_use") continue;
      const entry = clampInventoryEntry(summarizeToolCall(block.name, block.input));
      if (entry === "" || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
      if (entries.length >= MAX_TOOL_INVENTORY_ENTRIES) return entries;
    }
  }
  return entries;
}

// 清单节解析（合并多份摘要时用）：标题行之后连续的 `- ` 行就是条目，遇到第一行非条目即止
// （恢复提示 / 锚点节 / stub 行都在它后面，所以不会被误吃）。
//
// issue #565：**导出**给 `buildFoldedFacts`（`fold-summary-journal.js`）复用 —— 结构化 `toolCalls`
// 必须与 `text` 里的这一节逐条相等，所以只许有一个解析器；在那里另写一份正则就是两份实现各自腐烂。
/**
 * @param {string} value
 * @returns {string[]}
 */
export function parseInventorySection(value) {
  const lines = String(value).split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === TOOL_INVENTORY_HEADING);
  if (headingIndex < 0) return [];
  const entries = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (!line.startsWith("- ")) break;
    const entry = line.slice(2).trim();
    if (entry !== "") entries.push(entry);
  }
  return entries;
}

function parseToolFootprint(value) {
  const counts = new Map();
  if (value === "无") return counts;
  for (const match of String(value).matchAll(/([^,]+)×(\d+)/gu)) {
    const name = match[1].trim();
    const count = Number.parseInt(match[2], 10);
    if (name && Number.isSafeInteger(count)) {
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
  }
  return counts;
}

function safeNavigationId(value) {
  return String(value ?? "")
    .replaceAll(/[^\p{L}\p{N}._:-]/gu, "_")
    .slice(0, 80);
}

function boundedNavigationRecord(roundRange, artifacts) {
  if (!roundRange || !Number.isSafeInteger(roundRange.from)
    || !Number.isSafeInteger(roundRange.to) || artifacts.length === 0) {
    return undefined;
  }

  const unique = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") continue;
    if (artifact.locator === undefined) continue;
    const display = typeof artifact.display === "string" && artifact.display.length > 0
      ? artifact.display
      : artifact.id;
    const id = safeNavigationId(artifact.id ?? artifact.archivePath);
    const digest = String(artifact.digest ?? "").slice(0, 128);
    if (!id || !digest) continue;
    const status = artifact.status !== undefined
      ? artifact.status
      : artifact.truncated === true
        ? "truncated"
        : "archived";
    const key = `${id}\u0000${digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      id,
      ...(typeof artifact.display === "string" ? { display: artifact.display } : {}),
      locator: artifact.locator,
      digest,
      status: NAVIGATION_STATUSES.has(status) ? status : "archived",
    });
  }
  if (unique.length === 0) return undefined;

  let visible = unique.slice(0, MAX_NAVIGATION_ARTIFACTS);
  let truncated = visible.length < unique.length;
  const makeRecord = () => ({
    roundFrom: roundRange.from,
    roundTo: roundRange.to,
    artifacts: visible,
    ...(truncated ? { truncated: true } : {}),
  });

  while (JSON.stringify(makeRecord()).length > MAX_NAVIGATION_CHARS && visible.length > 1) {
    visible = visible.slice(0, -1);
    truncated = true;
  }
  if (JSON.stringify(makeRecord()).length > MAX_NAVIGATION_CHARS) {
    visible = visible.map((artifact) => ({
      ...artifact,
      id: artifact.id.slice(0, 32),
      ...(Object.hasOwn(artifact, "display")
        ? { display: artifact.display.slice(0, 32) }
        : {}),
      locator: undefined,
    }));
  }
  if (JSON.stringify(makeRecord()).length > MAX_NAVIGATION_CHARS) {
    visible = [];
    truncated = true;
  }
  return makeRecord();
}

export function buildFoldNavigationRecord(foldedPayload, roundRange) {
  const artifacts = [];
  for (const message of foldedPayload ?? []) {
    for (const block of blocksFor(message)) {
      if (block?.type !== "tool_result" || !block.artifact) continue;
      const artifact = block.artifact;
      artifacts.push({
        id: artifact.artifactId ?? artifact.archivePath ?? artifact.display,
        ...(typeof artifact.display === "string" ? { display: artifact.display } : {}),
        locator: artifact.locator,
        digest: artifact.digest,
        ...(artifact.status === undefined
          ? { status: artifact.truncated === true ? "truncated" : "archived" }
          : { status: artifact.status }),
      });
    }
  }
  return boundedNavigationRecord(roundRange, artifacts);
}

export function mergeFoldNavigationRecords(records, roundRange) {
  return boundedNavigationRecord(
    roundRange,
    records.flatMap((record) => record?.artifacts ?? []),
  );
}

function escapeRegex(value) {
  return String(value).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseMarkedFoldSummary(text) {
  const value = String(text);
  const markedMatch = value.match(
    new RegExp(
      `${escapeRegex(FOLD_SUMMARY_MARKER)}早期第 (\\d+)–(\\d+) 轮（共 (\\d+) 轮）已折叠。工具足迹：(.*?)。`,
      "u",
    ),
  );
  if (!markedMatch) return undefined;
  return parseFoldSummaryMatch(value, markedMatch, false);
}

// 锚点节解析：按 kind 分桶为结构化数据（values 用 splitAnchorValues 还原转义后的渲染格式），
// 参与 mergedFoldSummaryContent 的并集合并——不靠切原文保锚点。
const ANCHOR_KIND_PATTERN = /^(paths|shas|issues|urls|errors): (.*)$/u;

function parseAnchorSection(value) {
  const lines = String(value).split("\n");
  const headingIndex = lines.findIndex((line) => line.includes("## 锚点索引"));
  if (headingIndex < 0) return undefined;
  const byKind = {};
  let found = false;
  for (const line of lines.slice(headingIndex + 1)) {
    const kindMatch = line.match(ANCHOR_KIND_PATTERN);
    if (!kindMatch) continue;
    byKind[kindMatch[1]] = splitAnchorValues(kindMatch[2]).filter((item) => item !== "");
    found = true;
  }
  return found ? byKind : undefined;
}

// 锚点节剥离（fold-llm prependSummary 复用，避免复制实现）：截掉锚点节标题行到节尾
// （下一个 `## ` 标题或文本结束），并收敛残留空行。无锚点节时原样返回。
export function stripAnchorSection(text) {
  const lines = String(text ?? "").split("\n");
  const headingIndex = lines.findIndex((line) => line.includes(ANCHOR_SECTION_HEADING));
  if (headingIndex < 0) return text;
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  const kept = lines.slice(0, headingIndex);
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return [...kept, ...lines.slice(end)].join("\n");
}

function parseFoldSummaryMatch(value, match, legacy) {
  if (!match) return undefined;
  let navigationRecord;
  const navigationMatch = value.match(/^导航记录：(\{.*\})$/mu);
  if (navigationMatch) {
    try {
      const parsed = JSON.parse(navigationMatch[1]);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.artifacts)) {
        navigationRecord = parsed;
      }
    } catch {
      // Ignore malformed navigation from an older or manually edited summary.
    }
  }
  return {
    from: Number.parseInt(match[1], 10),
    to: Number.parseInt(match[2], 10),
    count: Number.parseInt(match[3], 10),
    tools: parseToolFootprint(match[4]),
    // issue #564 缺口 1：双形态 stub（`[已折叠]…` 与 `【已折叠·TTL】…`）都收，
    // 半角形态的匹配结果逐字不变（只是多认了全角那一支）。
    stubs: [...String(value).matchAll(FOLD_STUB_LINE_PATTERN)]
      .map((stub) => stub[0]),
    inventory: parseInventorySection(value),
    navigationRecord,
    anchors: parseAnchorSection(value),
    legacy,
  };
}

function parseFoldSummaries(text) {
  const value = String(text);
  const marker = escapeRegex(FOLD_SUMMARY_MARKER);
  const starts = [...value.matchAll(new RegExp(marker, "gu"))]
    .map((match) => match.index);
  if (starts.length > 0) {
    return starts
      .map((start, index) => parseMarkedFoldSummary(
        value.slice(start, starts[index + 1] ?? value.length),
      ))
      .filter((parsed) => parsed !== undefined);
  }
  const legacy = value.match(
    /^【上下文折叠】早期第 (\d+)–(\d+) 轮（共 (\d+) 轮）已折叠。工具足迹：(.*?)。/u,
  );
  return legacy ? [parseFoldSummaryMatch(value, legacy, true)] : [];
}

function parseFoldSummary(text) {
  return parseFoldSummaries(text)[0];
}

function stripMarkedFoldSummaries(block) {
  if (block?.type !== "text") return [block];
  const text = String(block.text ?? "");
  const markerIndex = text.indexOf(FOLD_SUMMARY_MARKER);
  if (markerIndex < 0) return [block];
  const prefix = text.slice(0, markerIndex).trim();
  return prefix === "" ? [] : [{ ...block, text: prefix }];
}

export function formatFoldSummary({
  from,
  to,
  count,
  tools,
  inventory = [],
  stubs = [],
  navigationRecord,
  recoveryHint = DEFAULT_RECOVERY_HINT,
  anchors,
}) {
  const footprint = tools.size === 0
    ? "无"
    : [...tools.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, count]) => `${name}×${count}`)
      .join(", ");
  const boundedInventory = inventory.slice(0, MAX_TOOL_INVENTORY_ENTRIES);
  const lines = [
    `${FOLD_SUMMARY_MARKER}早期第 ${from}–${to} 轮（共 ${count} 轮）已折叠。`,
    `工具足迹：${footprint}。`,
  ];
  // 行序是硬的（issue #564 判据 5）：区间行 → 工具调用清单 → 导航记录 / stub / 恢复提示 → 锚点节。
  // 字节夹断（`buildFoldedFacts` 的前缀夹断，默认 2048）削掉的是**尾部**，所以清单永远在前面活着。
  if (boundedInventory.length > 0) {
    lines.push(TOOL_INVENTORY_HEADING);
    for (const entry of boundedInventory) lines.push(`- ${entry}`);
  }
  if (navigationRecord) {
    lines.push(`导航记录：${JSON.stringify(navigationRecord)}`);
  }
  lines.push(...stubs.slice(0, 10));
  lines.push(recoveryHint);
  const prefix = lines.slice(0, 2).join("");
  const suffix = lines.slice(2).join("\n");
  const summary = stubs.length > 0 || navigationRecord || boundedInventory.length > 0
    ? `${prefix}\n${suffix}`
    : `${prefix}${suffix}`;
  // 锚点节（A2）固定追加在摘要最末：recoveryHint 之后，整节为机械抽取文本。
  return anchors && anchors.text !== "" ? `${summary}\n\n${anchors.text}` : summary;
}

function mergedFoldSummaryContent(
  originalContent,
  summary,
  recoveryHint,
  anchorClamp = {},
  anchorsEnabled = true,
) {
  const summaries = originalContent
    .filter((block) => block?.type === "text")
    .flatMap((block) => parseFoldSummaries(block.text));
  const current = parseFoldSummary(summary);
  const merged = [...summaries, current].filter((parsed) => parsed !== undefined);
  const mergedStubs = [...new Set(merged.flatMap((parsed) => parsed.stubs ?? []))].slice(0, 10);
  // 清单并集（issue #564）：**最新在前**（旧摘要按内容顺序在前、新折叠在后 ⇒ 反向遍历），
  // 去重后重取 8 条上限。理由：模型最需要的是“刚刚跑过什么”，而更早的轮次已经在区间句里说明。
  const mergedInventory = [];
  for (const parsed of [...merged].reverse()) {
    for (const entry of parsed.inventory ?? []) {
      if (entry !== "" && !mergedInventory.includes(entry)) mergedInventory.push(entry);
    }
  }
  // 锚点并集（A2 关键回归）：旧摘要锚点在前、新折叠锚点按 kind 追加在后，去重后重新夹取上限
  // （MAX_ANCHORS=20 / 1200 字符）——连续折叠锚点不丢、不重复、不超限。
  const unionByKind = {};
  for (const parsed of merged) {
    for (const [kind, values] of Object.entries(parsed.anchors ?? {})) {
      if (!Array.isArray(values)) continue;
      const bucket = (unionByKind[kind] ??= []);
      for (const value of values) {
        if (!bucket.includes(value)) bucket.push(value);
      }
    }
  }
  // anchors:false（评审修复）：旧摘要里解析出的锚点一并丢弃，合并结果不得含锚点节
  // ——否则第 1 次默认折叠产生锚点后，第 2 次 anchors:false 折叠仍会把它带回来。
  const mergedAnchors = anchorsEnabled
    ? clampAnchorSection(unionByKind, anchorClamp)
    : { byKind: {}, text: "" };
  const mergedRange = {
    from: Math.min(...merged.map((parsed) => parsed.from)),
    to: Math.max(...merged.map((parsed) => parsed.to)),
  };
  const mergedNavigation = mergeFoldNavigationRecords(
    merged.map((parsed) => parsed.navigationRecord),
    mergedRange,
  );
  const mergedSummary = merged.length === 0
    ? summary
    : formatFoldSummary({
      from: mergedRange.from,
      to: mergedRange.to,
      count: merged.reduce((total, parsed) => total + parsed.count, 0),
      tools: merged.reduce((counts, parsed) => {
        for (const [name, count] of parsed.tools) {
          counts.set(name, (counts.get(name) ?? 0) + count);
        }
        return counts;
      }, new Map()),
      stubs: mergedStubs,
      inventory: mergedInventory.slice(0, MAX_TOOL_INVENTORY_ENTRIES),
      navigationRecord: mergedNavigation,
      recoveryHint: resolveRecoveryHint(recoveryHint),
      anchors: mergedAnchors,
    });
  const contentWithoutSummaries = originalContent.flatMap((block) => {
    // 旧格式仅兼容读取，保留原块；v1 marker 是专用的可替换区段。
    if (block?.type !== "text" || parseFoldSummary(block.text)?.legacy === true) {
      return [block];
    }
    return stripMarkedFoldSummaries(block);
  });
  return [{
    type: "text",
    text: mergedSummary,
  }, ...contentWithoutSummaries];
}

function prependSummary(
  head,
  summary,
  summaryRole = "user",
  recoveryHint = DEFAULT_RECOVERY_HINT,
  anchorClamp = {},
  anchorsEnabled = true,
) {
  if (summaryRole === "system") {
    const systemIndex = head.findLastIndex((message) => message?.role === "system");
    if (systemIndex < 0) {
      return [{ role: "system", content: [{ type: "text", text: summary }] }, ...head];
    }
    const updatedHead = head.slice();
    const system = updatedHead[systemIndex];
    const content = typeof system.content === "string"
      ? [{ type: "text", text: system.content }]
      : Array.isArray(system.content) ? system.content : [];
    updatedHead[systemIndex] = {
      ...system,
      content: mergedFoldSummaryContent(
        content,
        summary,
        recoveryHint,
        anchorClamp,
        anchorsEnabled,
      ),
    };
    return updatedHead;
  }
  const userIndex = head.findLastIndex(isRealUser);
  if (userIndex < 0) return head;

  const user = head[userIndex];
  const originalContent = typeof user.content === "string"
    ? [{ type: "text", text: user.content }]
    : Array.isArray(user.content)
      ? user.content
      : [];
  const updatedHead = head.slice();
  updatedHead[userIndex] = {
    ...user,
    // 合并后的单段摘要放 content 最前：模型先看到折叠提示，任务原文紧跟其后；
    // （safeTruncate 同消息字段按 index 截断，任务在后可避免被先截成 [已修剪]）
    content: mergedFoldSummaryContent(
      originalContent,
      summary,
      recoveryHint,
      anchorClamp,
      anchorsEnabled,
    ),
  };
  return updatedHead;
}

/**
 * 对给定 foldedPayload 生成统计摘要文本（fold-llm 降级路径复用，避免复制逻辑）。
 * 工具足迹、锚点节、恢复提示与 fold-statistical 的 compact 产物同一套规则。
 *
 * @param {object[]} foldedPayload Raw folded messages.
 * @param {{from?: number, to?: number, count?: number, recoveryHint?: string,
 *   anchors?: {text: string}, stubs?: string[], navigationRecord?: object}} [options]
 * @returns {string}
 */
export function summarizeFoldedPayload(foldedPayload, options = {}) {
  const from = Number.isSafeInteger(options.from) && options.from > 0 ? options.from : 1;
  const to = Number.isSafeInteger(options.to) && options.to >= from ? options.to : from;
  const payload = Array.isArray(foldedPayload) ? foldedPayload : [];
  // issue #564：TTL 句柄直接从被折负载里收（真机形态不传 `stubFor` 也能拿到），
  // 宿主显式给的 stub 接在后面，保持两者同一上限。
  const stubs = [...new Set([
    ...collectTtlFoldStubs(payload),
    ...(Array.isArray(options.stubs) ? options.stubs : []),
  ])];
  return formatFoldSummary({
    from,
    to,
    count: Number.isSafeInteger(options.count) && options.count > 0 ? options.count : to - from + 1,
    tools: countToolUses(payload),
    inventory: toolCallInventory(payload),
    stubs,
    ...(options.navigationRecord === undefined ? {} : { navigationRecord: options.navigationRecord }),
    recoveryHint: resolveRecoveryHint(options.recoveryHint),
    ...(options.anchors === undefined ? {} : { anchors: options.anchors }),
  });
}

/**
 * Create the deterministic statistical folding strategy.
 *
 * @returns {{
 *   name: string,
 *   shouldCompact: (messages: object[], budgetTokens: number) => boolean,
 *   compact: (messages: object[], options?: object) => Promise<object>
 * }}
 */
export function createFoldStatisticalStrategy(options = {}) {
  return {
    name: "fold-statistical",

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
      const { folded, retained, foldedIndexes } = selectFoldedRounds(
        rounds,
        keep,
        settings.protectedMessage,
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
      });
      // issue #564 缺口 1：TTL 句柄（`【已折叠·TTL】…` 首行）从被折负载里自己收，
      // 不依赖宿主传 `stubFor`（真机形态一个钩子都不给）。宿主显式 stub 接在后面。
      const hostStubs = await resolveFoldStubs(foldedPayload, settings.stubFor);
      const foldedStubs = [...new Set([
        ...collectTtlFoldStubs(foldedPayload),
        ...hostStubs,
      ])];
      const navigationRecord = buildFoldNavigationRecord(
        foldedPayload,
        roundRange ?? (folded.length > 0 ? { from: 1, to: folded.length } : undefined),
      );
      await runFoldHook(settings.onBeforeFold, {
        messages,
        folded,
        retained,
        foldedPayload,
        roundRange,
      });

      // 锚点索引（A2）：默认启用，anchors:false 时与 0.7.0 行为完全一致
      // （本轮不抽取，且旧摘要的锚点节在合并时丢弃）。
      const anchorsEnabled = settings.anchors !== false;
      const anchorClamp = settings.anchors === false
        ? {}
        : (settings.anchors && typeof settings.anchors === "object" ? settings.anchors : {});
      const anchors = anchorsEnabled ? extractAnchors(foldedPayload, anchorClamp) : undefined;
      if (anchors?.text !== "") {
        settings.onLayer?.({ layerId: "anchors" });
      }

      let compactedHead = head;
      // issue #470（A1）：本次折叠的**机械替代物**（进账本用，不进消息流）。
      /** @type {{ source: string, text?: string, degradeReason?: string }|undefined} */
      let foldSummary = undefined;
      if (folded.length > 0) {
        const range = roundRange ?? { from: 1, to: folded.length };
        const foldedMessages = folded.flatMap((round) => round.messages);
        const summary = formatFoldSummary({
          from: range.from,
          to: range.to,
          count: folded.length,
          tools: countToolUses(foldedMessages),
          // issue #564 缺口 2：摘要不再只有计数——逐条 `name + 关键入参`（≤8 条 × ≤80 字符）。
          inventory: toolCallInventory(foldedMessages),
          stubs: foldedStubs,
          navigationRecord,
          recoveryHint,
          anchors,
        });
        compactedHead = prependSummary(
          head,
          summary,
          settings.summaryRole,
          recoveryHint,
          anchorClamp,
          anchorsEnabled,
        );
        // 机械摘要本来就在手里，顺手带一份给轮记录（#470-A1）。
        foldSummary = { source: "statistical", text: summary };
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
        ...(navigationRecord === undefined ? {} : { navigationRecord }),
        ...(foldSummary === undefined ? {} : { foldSummary }),
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });
      return result;
    },
  };
}
