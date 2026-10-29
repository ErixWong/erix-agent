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

/**
 * 近期「给全」的折叠次数（issue #601）：最近这么多次折叠保留
 * `title + 工具足迹 + 清单 + 摘要`，更早的**每条只留一行 title**。
 *
 * 刻意写成**导出常量**而不是 `config.*` 叶子（issue 正文硬约束 3）：新叶会牵动文档与契约面
 * （另一会话正在做 0.29 开版）；将来要可配另开单。写成导出常量是为了让判据能引用它，
 * 而不是在测试里硬编码 `3`（那样改常量时判据不会跟着动）。
 */
export const FOLD_SUMMARY_RECENT_FOLDS = 3;

/** 单次「近期」折叠的渲染上界（字符，issue #601 预算）：超了就削清单尾部、再削摘要尾部。 */
const MAX_RECENT_FOLD_CHARS = 600;

/** 远期 title 行的字符上界（issue #601 预算：每条 ≤80 字符）。 */
const MAX_FOLD_TITLE_LINE_CHARS = 80;

/** 摘要里 stub 的总条数上界（与单折路径 `stubs.slice(0, 10)` 同口径）。 */
const MAX_MERGED_STUBS = 10;

/** 分段块的「近期」小节标题（#601）。 */
const RECENT_FOLDS_HEADING = "近期（最近 ";

/** 分段块的「更早」小节标题（#601）。 */
const OLDER_FOLDS_HEADING = "更早（仅标题，每条一行）：";

/**
 * 分段块里**每一折那一行**（issue #601）：`- 第 120–132 轮（13 轮） · <title>`。
 *
 * 远期那行在 `count === to - from + 1` 时省略 `（N 轮）`（issue 正文的目标形状：`第 40–59 轮 · title`），
 * 计数与区间对不上时**必须写出来**——否则解析回来就是另一条折叠记录（往返不自治）。
 * `- ` 前缀与清单条目同形，所以 `parseInventorySection` 见到这一行就收手（见那里）。
 */
const FOLD_SEGMENT_LINE_PATTERN = /^- 第 (\d+)–(\d+) 轮(?:（(\d+) 轮）)? · (.*)$/u;

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
//
// issue #601：分段块里**每折一个清单节**（近期折叠各自带自己的清单）⇒ 这里改成收**全部**节，
// 按文本顺序（= 最新在前）拼接去重。单节文本的结果与旧实现逐字相同（既有判据不受影响）。
/**
 * @param {string} value
 * @returns {string[]}
 */
export function parseInventorySection(value) {
  const lines = String(value).split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== TOOL_INVENTORY_HEADING) continue;
    for (const line of lines.slice(index + 1)) {
      if (!line.startsWith("- ")) break;
      // issue #601：分段块的折叠记录行也是 `- ` 开头（`- 第 120–132 轮（13 轮）· …`），
      // 它**不是**清单条目；见到它就收手（下一折的清单节在它后面，由外层循环再找）。
      if (FOLD_SEGMENT_LINE_PATTERN.test(line)) break;
      const entry = line.slice(2).trim();
      if (entry !== "" && !entries.includes(entry)) entries.push(entry);
    }
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

function parseNavigationRecord(value) {
  const navigationMatch = String(value).match(/^导航记录：(\{.*\})$/mu);
  if (!navigationMatch) return undefined;
  try {
    const parsed = JSON.parse(navigationMatch[1]);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.artifacts)) {
      return parsed;
    }
  } catch {
    // Ignore malformed navigation from an older or manually edited summary.
  }
  return undefined;
}

function parseFoldSummaryMatch(value, match, legacy) {
  if (!match) return undefined;
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
    navigationRecord: parseNavigationRecord(value),
    anchors: parseAnchorSection(value),
    legacy,
  };
}

/**
 * 新格式（issue #601）的**分段解析**：把一块摘要拆回「一折一条」。
 *
 * 为什么必须能拆回来：`foldedFacts.text` 是**累计替代物**（`resume-fold-trim#pickCoveringFoldSummary`
 * 的取源契约依赖它已含旧摘要），而每次折叠都是「解析上一次的块 → 合并 → 重渲染」⇒
 * 新格式**必须**能被自己读回来，否则第 2 次折叠就把第 1 折的信息丢光。
 *
 * 块级信息（导航记录 / 锚点节）只有一份，挂在**最新那一折**上（并集合并不在乎它挂在哪一折）。
 * 远期那行只剩 title，所以那一折的 `tools`/`inventory`/`stubs` 解析回空 —— 这是**有意的信息降级**
 * （近期给全 / 远期只给 title），不是丢数据：完整的一份在账本 `foldedFacts.increment` 里（#566）。
 *
 * @param {string} value 以 marker 开头的那一段文本
 * @returns {object[]|undefined} 拆不出分段行 ⇒ `undefined`（调用方退回单区间解析）
 */
function parseSegmentedFoldSummary(value) {
  const lines = String(value).split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    if (FOLD_SEGMENT_LINE_PATTERN.test(line)) starts.push(index);
  });
  if (starts.length === 0) return undefined;

  const segments = starts.map((start, position) => {
    const chunk = lines.slice(start, starts[position + 1] ?? lines.length);
    const match = chunk[0].match(FOLD_SEGMENT_LINE_PATTERN);
    const from = Number.parseInt(match[1], 10);
    const to = Number.parseInt(match[2], 10);
    const body = chunk.slice(1).join("\n");
    const footprint = body.match(/^工具足迹：(.*?)。$/mu);
    return {
      from,
      to,
      // 远期那行在 `count === to - from + 1` 时省略计数（见 `FOLD_SEGMENT_LINE_PATTERN`）
      count: match[3] === undefined ? to - from + 1 : Number.parseInt(match[3], 10),
      title: match[4].trim(),
      tools: parseToolFootprint(footprint === null ? "无" : footprint[1]),
      stubs: [...body.matchAll(FOLD_STUB_LINE_PATTERN)].map((stub) => stub[0]),
      inventory: parseInventorySection(body),
      navigationRecord: undefined,
      anchors: undefined,
      legacy: false,
    };
  });
  // 块级节（导航记录 / 锚点索引）挂在最新那一折上：合并时它们走并集，挂在哪一折不影响结果，
  // 但重渲染必须在块级再写一次（否则第 2 次折叠就把导航与锚点弄丢）。
  segments[0].navigationRecord = parseNavigationRecord(value);
  segments[0].anchors = parseAnchorSection(value);
  return segments;
}

function parseFoldSummaries(text) {
  const value = String(text);
  const marker = escapeRegex(FOLD_SUMMARY_MARKER);
  const starts = [...value.matchAll(new RegExp(marker, "gu"))]
    .map((match) => match.index);
  if (starts.length > 0) {
    // 一块里只有一个 marker：新格式的**逐折分段**在块内部，所以一块能拆出 N 条。
    // 拆不出（旧格式单区间行）⇒ 退回原来的单条解析（向后兼容只读）。
    return starts.flatMap((start, index) => {
      const chunk = value.slice(start, starts[index + 1] ?? value.length);
      const segmented = parseSegmentedFoldSummary(chunk);
      if (segmented !== undefined) return segmented;
      const single = parseMarkedFoldSummary(chunk);
      return single === undefined ? [] : [single];
    });
  }
  const legacy = value.match(
    /^【上下文折叠】早期第 (\d+)–(\d+) 轮（共 (\d+) 轮）已折叠。工具足迹：(.*?)。/u,
  );
  return legacy ? [parseFoldSummaryMatch(value, legacy, true)] : [];
}

function parseFoldSummary(text) {
  return parseFoldSummaries(text)[0];
}

/**
 * **账本记录 → 逐折分段**（issue #601 主路径）。
 *
 * 为什么不从块里解析：摘要是被塞进**第一条真实 user 消息的 `content[0]`** 的（`prependSummary`），
 * 下一次折叠往同一条消息里再插一段，就不得不先把旧块解析出来再合并——这是**位置约束带来的历史包袱**，
 * 不是设计需要。而账本（轮记录上的 `foldedFacts`，`orchestrator.js` 落盘的那一份）本来就是**一折一条**：
 * `from`/`to`/`rounds` 是结构化键，`increment.text` 是**这一折自己那份**（#566），`toolCalls` 是结构化清单。
 * 于是渲染只需要这份列表，不需要理解上一块被渲染成了什么形状。
 *
 * 形状不认识（缺 `from`/`to`）⇒ 返回 `undefined`，调用方**整条路放弃**、退回解析块（不猜）。
 *
 * @param {unknown} foldRecords 轮记录上的 `foldedFacts` 列表（顺序不限，这里统一成最新在前）
 * @returns {object[]|undefined}
 */
function foldRecordSegments(foldRecords) {
  if (!Array.isArray(foldRecords) || foldRecords.length === 0) return undefined;
  const segments = [];
  for (const record of foldRecords) {
    if (record === null || typeof record !== "object") return undefined;
    const increment = record.increment !== null && typeof record.increment === "object"
      ? record.increment
      : undefined;
    const from = Number.isSafeInteger(record.from) ? record.from : increment?.from;
    const to = Number.isSafeInteger(record.to) ? record.to : increment?.to;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return undefined;
    const rounds = Number.isSafeInteger(record.rounds) && record.rounds > 0
      ? record.rounds
      : Number.isSafeInteger(increment?.rounds) && increment.rounds > 0
        ? increment.rounds
        : to - from + 1;
    // 明细取自**这一折自己那份**（`increment`）；没有就用父键 `text`（同为单折文本，不是累计体）。
    const detailText = typeof increment?.text === "string" && increment.text !== ""
      ? increment.text
      : typeof record.text === "string" ? record.text : "";
    const detail = parseFoldSummaries(detailText)[0];
    segments.push({
      from,
      to,
      count: rounds,
      // title 不落账（`record.title` 是整条首行，含区间句）⇒ 交给 `foldSegmentTitle` 从清单/足迹派生，
      // 与「从块解析回来的 title」逐字一致（块里的 title 本来就是这么派生的）。
      title: undefined,
      tools: detail?.tools ?? new Map(),
      inventory: detail?.inventory ?? [],
      stubs: detail?.stubs ?? [],
      navigationRecord: undefined,
      anchors: undefined,
      legacy: false,
    });
  }
  // 最新在前（渲染顺序就是这个）：账本按入账序给，这里统一成「`to` 降序」，调用方不必关心顺序。
  segments.sort((left, right) => right.to - left.to);
  return segments;
}

/**
 * 账本是否**覆盖**块里已有的那些折叠（issue #601 的兜底闸门）。
 *
 * 为什么要这道闸门：宿主可以自己恢复消息（不走 `resume-manager`），此时引擎侧的折叠账本是空的，
 * 而块里已经有折过好几轮的记录 ⇒ 直接用账本渲染会**静默丢掉**那些折（信息只减不增）。
 * 判据是「账本条数 ≥ 块里条数」且「账本最新那一折不比块里最新那一折旧」——两条都成立才认账本。
 */
function ledgerCoversBlock(ledgerSegments, blockSegments) {
  if (blockSegments.length === 0) return true;
  if (ledgerSegments.length < blockSegments.length) return false;
  const newestTo = (segments) => segments.reduce(
    (max, segment) => (segment.to > max ? segment.to : max),
    Number.NEGATIVE_INFINITY,
  );
  return newestTo(ledgerSegments) >= newestTo(blockSegments);
}

function stripMarkedFoldSummaries(block) {
  if (block?.type !== "text") return [block];
  const text = String(block.text ?? "");
  const markerIndex = text.indexOf(FOLD_SUMMARY_MARKER);
  if (markerIndex < 0) return [block];
  const prefix = text.slice(0, markerIndex).trim();
  return prefix === "" ? [] : [{ ...block, text: prefix }];
}

/** 工具足迹的一行文本（单折与分段两条渲染路径共用，口径只此一份）。 */
function footprintText(tools) {
  const counts = tools instanceof Map ? tools : new Map();
  if (counts.size === 0) return "无";
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}

/** 按**字符**夹取（超出时末位换成 `…`，所以上界是硬成立而不是「上界 + 省略号」）。 */
function clampChars(value, limit) {
  const characters = Array.from(String(value ?? ""));
  if (characters.length <= limit) return characters.join("");
  if (limit <= 1) return characters.slice(0, Math.max(0, limit)).join("");
  return `${characters.slice(0, limit - 1).join("")}…`;
}

/**
 * 一折的 title（issue #601）：机械路径没有语义标题，用**这一折自己那条最具体的可执行信息**顶。
 *
 * 优先取清单首条（`exec npm test --shard 2`——「这折到底跑了什么」），没清单就用工具足迹，
 * 连调用都没有就是 `无工具调用`。解析回来的分段行自带 `title`，所以重渲染逐字稳定（往返不变形）。
 */
function foldSegmentTitle(segment) {
  if (typeof segment?.title === "string" && segment.title !== "") return segment.title;
  const inventory = Array.isArray(segment?.inventory) ? segment.inventory : [];
  if (inventory.length > 0 && inventory[0] !== "") return inventory[0];
  const footprint = footprintText(segment?.tools);
  return footprint === "无" ? "无工具调用" : `工具足迹：${footprint}`;
}

/**
 * 单次「近期」折叠的渲染行：title 行 + 工具足迹 + 清单 + 摘要，超 `MAX_RECENT_FOLD_CHARS` 时
 * 先削清单尾部、再削摘要尾部（**保留最新那条 stub**：它在本折里的位置最前）。
 */
function recentFoldLines(segment) {
  const titleLine = `- 第 ${segment.from}–${segment.to} 轮（${segment.count} 轮） · ${foldSegmentTitle(segment)}`;
  const footprintLine = `工具足迹：${footprintText(segment.tools)}。`;
  const inventory = (segment.inventory ?? []).slice(0, MAX_TOOL_INVENTORY_ENTRIES);
  const inventoryLines = inventory.length === 0
    ? []
    : [TOOL_INVENTORY_HEADING, ...inventory.map((entry) => `- ${entry}`)];
  // 「摘要」= 这一折自己的 stub（TTL 句柄 / 宿主 stub）：模型要「刚刚跑过什么」的原文入口。
  // 单独成行标题、stub 各自占一行：`FOLD_STUB_LINE_PATTERN` 是行首锚定的，挤成一行就只认第一条。
  let stubLines = (segment.stubs ?? []).length === 0 ? [] : ["摘要：", ...segment.stubs];
  let keptInventory = inventoryLines;
  const rendered = () => [titleLine, footprintLine, ...keptInventory, ...stubLines].join("\n");
  while (Array.from(rendered()).length > MAX_RECENT_FOLD_CHARS) {
    // 清单条目先削（它的首条已经在 title 行里），再削摘要尾部（最新的 stub 在最前，不受影响）。
    if (keptInventory.length > 2) {
      keptInventory = keptInventory.slice(0, -1);
      continue;
    }
    if (stubLines.length > 2) {
      stubLines = stubLines.slice(0, -1);
      continue;
    }
    break;
  }
  return [titleLine, footprintLine, ...keptInventory, ...stubLines];
}

/** 远期折叠只留一行 title（每条 ≤ `MAX_FOLD_TITLE_LINE_CHARS` 字符）。 */
function olderFoldLine(segment) {
  // 计数与区间对不上时必须写出来（否则解析回来是另一条折叠记录，往返不自治）；
  // 对得上时按 issue 正文的目标形状省略（`第 40–59 轮 · title`）。
  const countPart = segment.count === segment.to - segment.from + 1
    ? ""
    : `（${segment.count} 轮）`;
  const prefix = `- 第 ${segment.from}–${segment.to} 轮${countPart} · `;
  const budget = Math.max(4, MAX_FOLD_TITLE_LINE_CHARS - Array.from(prefix).length);
  return `${prefix}${clampChars(foldSegmentTitle(segment), budget)}`;
}

/**
 * 分段块（issue #601）：近期给全 / 远期只给 title，**最新在最前**。
 *
 * 顺序是硬的：字节夹断（`buildFoldedFacts` 的前缀夹断，默认 2048）只削**尾部** ⇒
 * 最新那一折永远在最前面活着；被削掉的是远期 title 行与锚点节，不是最近发生过什么。
 */
function formatSegmentedFoldSummary({ segments, navigationRecord, recoveryHint, anchors }) {
  const recent = segments.slice(0, FOLD_SUMMARY_RECENT_FOLDS);
  const older = segments.slice(FOLD_SUMMARY_RECENT_FOLDS);
  const from = Math.min(...segments.map((segment) => segment.from));
  const to = Math.max(...segments.map((segment) => segment.to));
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const lines = [
    `${FOLD_SUMMARY_MARKER}共折叠 ${segments.length} 次，覆盖第 ${from}–${to} 轮（共 ${total} 轮）。`,
    `${RECENT_FOLDS_HEADING}${recent.length} 次，完整）：`,
  ];
  for (const segment of recent) lines.push(...recentFoldLines(segment));
  if (older.length > 0) {
    lines.push(OLDER_FOLDS_HEADING);
    for (const segment of older) lines.push(olderFoldLine(segment));
    lines.push(`另有 ${older.length} 次更早的已合并（只留标题）。`);
  }
  if (navigationRecord) lines.push(`导航记录：${JSON.stringify(navigationRecord)}`);
  lines.push(recoveryHint);
  const summary = lines.join("\n");
  // 锚点节（A2）固定追加在整块最末（与单折路径同口径）：夹断削的就是它。
  return anchors && anchors.text !== "" ? `${summary}\n\n${anchors.text}` : summary;
}

export function formatFoldSummary({
  from,
  to,
  count,
  tools,
  inventory = [],
  stubs = [],
  segments = undefined,
  navigationRecord,
  recoveryHint = DEFAULT_RECOVERY_HINT,
  anchors,
}) {
  // issue #601：多折 ⇒ 分段渲染；单折（或未给分段）⇒ 与旧实现**逐字相同**的单区间块。
  if (Array.isArray(segments) && segments.length > 1) {
    return formatSegmentedFoldSummary({ segments, navigationRecord, recoveryHint, anchors });
  }
  const footprint = footprintText(tools);
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
  foldRecords = undefined,
) {
  const summaries = originalContent
    .filter((block) => block?.type === "text")
    .flatMap((block) => parseFoldSummaries(block.text));
  const current = parseFoldSummary(summary);
  // issue #601：**账本优先**。列表来自轮记录上的 `foldedFacts`（一折一条），渲染不再依赖「上一块长什么样」；
  // 块解析降为兜底（① 历史 transcript 里的旧格式块；② 拿不到账本 / 账本覆盖不到块时）。
  const ledgerSegments = foldRecordSegments(foldRecords);
  const useLedger = ledgerSegments !== undefined && ledgerCoversBlock(ledgerSegments, summaries);
  const previous = useLedger ? ledgerSegments : summaries;
  if (useLedger && summaries.length > 0) {
    // 块级节（锚点索引 / 导航记录）是**累计**的、只存在于块里（账本不存它们）⇒ 挂到最新那一折上，
    // 并集合并不在乎挂在哪一折；不这么做的话账本路径会把锚点节丢掉。
    previous[0].anchors = summaries[0].anchors;
    previous[0].navigationRecord = summaries[0].navigationRecord;
  }
  // issue #601：**最新在最前**。旧块按自己的渲染顺序已经是「新 → 旧」（分段块）或只有一条（旧格式），
  // 本次折叠排在最前。下面所有“最新优先”的处理都靠这一个不变量。
  const merged = [current, ...previous].filter((parsed) => parsed !== undefined);
  // issue #601 回归修复：stub 与清单**同向**（最新在前）。
  //
  // 旧写法是 `[...new Set(merged.flatMap((p) => p.stubs ?? []))].slice(0, 10)`，而旧 `merged` 是
  // [旧摘要, 本次折叠] ⇒ `slice(0, 10)` 留下的是**最旧的 10 条**、丢掉的恰恰是刚折掉那一段的句柄
  // ——与 #564 定下的“清单最新在前”反向，也与“近期给全 / 远期只给 title”的设计意图反向。
  // 现在改成**从最新那一折开始分配 10 条预算**：旧折先被丢。
  const stubSeen = new Set();
  let stubBudget = MAX_MERGED_STUBS;
  for (const parsed of merged) {
    const kept = [];
    for (const stub of parsed.stubs ?? []) {
      if (stubBudget <= 0) break;
      if (stubSeen.has(stub)) continue;
      stubSeen.add(stub);
      kept.push(stub);
      stubBudget -= 1;
    }
    parsed.stubs = kept;
  }
  // 清单：**每折自己那一份**（issue #601）。不再全局并集 —— 近期那几折各带自己的清单节，
  // 远期那几折只剩 title（清单在它的 title 行里已有一条代表）。
  // 锚点并集（A2 关键回归）：旧摘要锚点在前、新折叠锚点按 kind 追加在后，去重后重新夹取上限
  // （MAX_ANCHORS=20 / 1200 字符）——连续折叠锚点不丢、不重复、不超限。
  /** @type {Record<string, string[]>} */
  const unionByKind = {};
  for (const parsed of [...merged].reverse()) {
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
    [...merged].reverse().map((parsed) => parsed.navigationRecord),
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
      // 单折路径用（`merged.length === 1` 时与分段路径同一份数据）：
      stubs: merged[0]?.stubs ?? [],
      inventory: (merged[0]?.inventory ?? []).slice(0, MAX_TOOL_INVENTORY_ENTRIES),
      // 多折 ⇒ 分段渲染（近期给全 / 远期只给 title）。
      segments: merged,
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
  foldRecords = undefined,
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
        foldRecords,
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
      foldRecords,
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
      // issue #601：引擎把**折叠记录账本**（轮记录 `foldedFacts`，一折一条）线到这里。
      // 非枚举属性（`Object.defineProperty`，与 `roundNumbers` 同口径）⇒ 不进选项键面。
      const foldRecords = Array.isArray(callOptions.foldRecords) ? callOptions.foldRecords : undefined;
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
          foldRecords,
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
