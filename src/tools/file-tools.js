// src/tools/file-tools.js — 文件工具规范实现（issue #184；ADR-005 第二层）
//
// 分层：凡「可被 import」的实现放 src/tools/，`bin/` 只做装配与呈现（先例 src/tools/notes.js）。
// 本文件是 readFile/rg/grep/tree/writeFile 的规范实现，CLI 反过来 import 它。
//
// 边界（ADR-009「牢笼归宿主」）：库只暴露 `allowRead`/`allowWrite` 两个布尔谓词，
// 默认 `() => true` —— 与历史 `path.resolve(cwd, value)` 行为完全一致（不做 containment）。
// 库负责把路径 `path.resolve` 归一后把**绝对路径**喂给谓词，并在遍历中**逐条**判定
// （宿主在外面包一层 executeTool 做不到这件事，所以必须在库里挂钩）。
// 越界一律返回「错误：…」**文本结果而非抛**（沿用 bin/tools.js 既有的「错误结果而非异常」口径），
// 库不引入任何错误类型、不做任何安全承诺。
//
// 「静默撒谎」收口（ADR-010「默认去噪合法，但必须可撤销」）：
//   * rg/grep/tree 共用同一套 vendor/隐藏目录跳过逻辑，跳过数量写进结果尾部**排除账** + 开关名；
//   * 无命中统一 `（无命中）`，rg 不再返回空串；
//   * tree 截断必须带 marker + 剩余计数；
//   * readFile 有界读（按块扫行 + 早停），不再整文件 `readFileSync`（几百 MB 会 RangeError/OOM）。
//
// 可中止：遍历每 `ABORT_CHECKPOINT_EVERY` 个条目让出一次事件循环（`setImmediate`）并检查
// `context.signal.aborted`；同步遍历不让出时，宿主的下行中止处理器根本跑不到（纯 node 递归
// walk 同理）。**无 signal 时完全不插入让出**，非中止路径行为与开销零变化。
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

import { throwIfAborted } from "../loop/abort.js";

// 搜索类工具的单文件读取上限（超过即跳过并计入排除账）。
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TREE_ENTRIES = 500;
// 搜索上限硬顶：防爆输出（2026-09-20 基准：无上限搜索曾单次返回数千行拖慢主循环）。
export const GREP_MAX_RESULTS_HARD_CAP = 200;
export const FILE_READ_MAX_BYTES_DEFAULT = 262_144; // 256 KiB；scripts/docs-drift-check.mjs 的真值锚点
const FILE_READ_MAX_BYTES_MIN = 1_024;
const FILE_READ_MAX_BYTES_CEILING = 4 * 1024 * 1024;
// 搜索命中行的行宽上限：`grep` 与 `rg` **共用这一个数**（#184 追加轮 A 收口第三条：此前只有 `grep`
// 截行、`rg` 原样输出，同一个库里两个搜索工具口径相反——与刚修掉的「两个工具默认值相反」同形状）。
// 名字里的 GREP 是历史遗留（这个数最早只有 `grep` 在用），口径唯一，**不要再引入第二个常量**。
// 上限语义：整行 ≤ 上限原样返回；> 上限截到上限 + 尾部一个 `…`。
// 为什么保留截断：真实 `rg`/`grep` 命令**都不截行**（已实测 807 字符的命中行逐字节原样输出），
// 所以这是我们**本实现自己的输出预算**，不是对宿主或对真实命令的模仿——一个超长行（minified
// 文件常见：一行几百 KB）就能独自把一次工具调用撑爆。该偏离写进了两个工具的描述与契约文档。
const GREP_LINE_LIMIT = 500; // 值不动：200 会把正常代码行截成半行，模型看到半行容易误判（#184 追加轮 A）
const ABORT_CHECKPOINT_EVERY = 32;
const READ_BLOCK_BYTES = 64 * 1024;
// 结果尾部 marker 的字节预留：保证「单次返回不超过 max_bytes」对整段文本成立。
const READ_MARKER_RESERVE = 512;
const VENDOR_DIRECTORIES = new Set(["node_modules", "dist", "build", "target", "vendor"]);

// ---------------------------------------------------------------------------
// 通用小工具（原 bin/tools.js 私有 helper，随实现一起下库）
// ---------------------------------------------------------------------------

/** env 三件套（照抄 erix-station runner/lib/shell-tools.js）：非法/越界回退默认，默认值自动钳进区间。 */
function parseIntEnv(raw, defaultValue, { min, max }) {
  const clampedDefault = Math.min(Math.max(defaultValue, min), max);
  const value = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isInteger(value) || value < min || value > max) {
    return clampedDefault;
  }
  return value;
}

/** readFile 单次返回字节上限：`ERIX_FILE_READ_MAX_BYTES` 可覆盖，钳到 [1KiB, 4MiB]。 */
export function resolveFileReadMaxBytes(raw = process.env.ERIX_FILE_READ_MAX_BYTES) {
  return parseIntEnv(raw, FILE_READ_MAX_BYTES_DEFAULT, {
    min: FILE_READ_MAX_BYTES_MIN,
    max: FILE_READ_MAX_BYTES_CEILING,
  });
}

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function escapeRegExpLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncateDisplayText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function resolveToolPath(root, value) {
  return path.resolve(root, value);
}

function expandHomePath(value) {
  if (value === "~") return homedir();
  if (typeof value === "string" && value.startsWith("~/")) {
    return path.resolve(homedir(), value.slice(2));
  }
  return value;
}

function normalizeToolInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (typeof input.path !== "string") return input;
  return { ...input, path: expandHomePath(input.path) };
}

/** 搜索上限：`max_results`（grep 旧名）与 `maxResults`（rg 旧名）都收，钳到 [1, 200]。 */
function searchResultLimit(input, fallback) {
  const requested = input?.max_results ?? input?.maxResults ?? fallback;
  return Math.min(
    Math.max(1, normalizeNonNegativeInteger(requested, fallback)),
    GREP_MAX_RESULTS_HARD_CAP,
  );
}

/** 模式编译：字面量模式走 escapeRegExpLiteral；无效正则返回工具错误结果文本而非抛（grep 既有口径）。 */
function compileSearchPattern(pattern, { literal }) {
  try {
    return {
      expression: literal
        ? new RegExp(escapeRegExpLiteral(pattern))
        : new RegExp(String(pattern)),
    };
  } catch {
    return { error: `错误：无效正则：${truncateDisplayText(pattern, 80)}` };
  }
}

/**
 * `name_pattern` → 仅**文件名**匹配的正则（只支持简单 `*` 通配，**不跨目录分隔符**）。
 *
 * issue #195 R2：这个参数原先叫 `glob`，却只有「简单 `*` + 只匹配 basename」这一子集能力
 * （`**\/*.test.js` 一类完整 glob 模式一律不命中）。顶着 glob 的名字带着一整套 ripgrep
 * `--glob` 的先验，模型按先验写 `**\/*.ts` 就会静默 0 命中——#184 修的那批「静默撒谎」，
 * 只是撒谎主体从输出换成了**参数名**。故 `searchText` 里它叫 `name_pattern`，且描述里写死
 * 「只匹配文件名、不跨 `/`」；`grep` 别名为保持入参形状不变继续吃 `glob`（见 FILE_TOOL_DEFINITIONS）。
 */
function compileNamePattern(namePattern) {
  if (typeof namePattern !== "string" || namePattern.trim() === "") return undefined;
  return new RegExp(`^${namePattern.split("*").map(escapeRegExpLiteral).join(".*")}$`);
}

/**
 * `searchText` 的 `mode` 取值集合（issue #195 R1）：**无默认值**，缺失与非法一律返回错误结果。
 *
 * 为什么不给默认：本工具的存在理由就是「入口名字不带先验，所以不给任何默认」——#184 之前
 * `rg` 字面量 / `grep` 正则两个默认相反就是同一族缺陷，「默认 literal」只是把歧义留给调用方。
 * `scripts/docs-drift-check.mjs` 的「searchText mode 必填」规则以这一行为锚点。
 */
const SEARCH_MODES = new Set(["literal", "regex"]);

/** `mode` 缺失/非法的错误结果文本（**不回落默认**：回落就是本轮要修的谎）。 */
function searchModeError(mode) {
  const shown = mode === undefined ? "未提供" : truncateDisplayText(JSON.stringify(mode) ?? String(mode), 40);
  return `错误：searchText 必须显式给出 mode，取值 ${[...SEARCH_MODES].join(" 或 ")}（无默认值）；实际：${shown}`;
}

/**
 * `rg`/`grep` 别名的 `mode` 映射（issue #195 R3）：入参形状不变，继续吃 `is_regex`。
 * 不传 `is_regex` = 正则（真实 `rg` / `grep -E` 的默认，也是 #184 追加轮 A 定下的口径），
 * `is_regex === false` 才是字面量（`rg --fixed-strings` / `grep -F`）。
 * `scripts/docs-drift-check.mjs` 的「rg 默认搜索模式为正则」规则以这一行为锚点。
 */
function aliasSearchMode(input) {
  return input?.is_regex === false ? "literal" : "regex";
}

function normalizeFlag(value) {
  return value === true;
}

/** vendor / 隐藏目录跳过判定（rg/grep/tree 共用）；返回排除账字段名，未跳过返回 undefined。 */
function directorySkipReason(entry, { includeVendor, includeHidden }) {
  if (!entry.isDirectory()) return undefined;
  if (!includeVendor && VENDOR_DIRECTORIES.has(entry.name)) return "vendorDirectories";
  if (!includeHidden && entry.name.startsWith(".")) return "hiddenDirectories";
  return undefined;
}

function createSkipAccount() {
  return {
    vendorDirectories: 0,
    hiddenDirectories: 0,
    largeFiles: 0,
    binaryFiles: 0,
    deniedPaths: 0,
  };
}

/**
 * 所有「跳过 / 截断 / 空命中」提示文案的**唯一**出口（issue #188 分级预备）。
 *
 * 方括号、分隔与固定措辞只在这里出现一次：工具 executor 只传语义值，不许各自拼字面量。
 * marker 文案属 **Experimental**（改文案/加字段只动这一处 + 同步契约测试）；
 * `allowRead`/`allowWrite` 的形状与「false → 返回错误结果而不抛」属 **Stable**（issue #188）。
 *
 * @param {"skipped"|"noMatch"|"searchTruncated"|"treeEntryCap"|"treeDepthCap"
 *   |"readBytesCap"|"readMoreLines"|"readNotScanned"|"readLineTruncated"} kind
 * @param {Record<string, unknown>} [values] 语义值（计数、上限、offset）
 * @returns {string}
 */
export function toolMarker(kind, values = {}) {
  switch (kind) {
    case "skipped": {
      // 排除账（一次说清，不占多少 token）：模型不知道被排除了就无从发起取回，
      // 退化成不可召回的丢失（ADR-010）。
      const parts = [];
      if (values.directories > 0) parts.push(`node_modules/.git 等 ${values.directories} 个目录`);
      if (values.largeFiles > 0) {
        parts.push(`${values.largeFiles} 个 >${MAX_FILE_BYTES / (1024 * 1024)}MiB 文件`);
      }
      if (values.binaryFiles > 0) parts.push(`${values.binaryFiles} 个二进制文件`);
      if (values.deniedPaths > 0) parts.push(`${values.deniedPaths} 个宿主边界拒绝的路径`);
      const switchHint = values.suggestSwitches === true
        ? "；要一起搜传 include_vendor=true, include_hidden=true"
        : "";
      return `[已跳过 ${parts.join("、")}${switchHint}]`;
    }
    case "noMatch":
      // 无命中统一口径：空串会让模型分不清「没搜到」与「搜了但被静音」
      return "（无命中）";
    case "searchTruncated":
      // 规范入口 `searchText` 总带 `nextOffset`（模型可见承诺，见下方调用处注释）；
      // 别名不传 `offset` 也不开 `emitMetadata` → 拿不到 `nextOffset`，输出逐字不变。
      return values.nextOffset === undefined
        ? `[命中过多，已按 max_results=${values.limit} 截断]`
        : `[命中过多，已按 max_results=${values.limit} 截断；offset=${values.nextOffset} 继续]`;
    case "deprecated":
      // 别名弃用告警（issue #188 三层分级：工具名与入参形状属 Stable → 本轮只加告警不删）。
      // ⚠ 文案里不得出现 `…`：既有的「未触顶的行不得带省略号」断言比对的是整段结果文本。
      return `[已弃用 ${values.name}：它是 searchText 的薄别名，请改用 ${values.replacement}；${values.name} 将在后续 major 版本移除]`;
    case "treeEntryCap":
      return `[另有 ${values.remaining} 条未列出，条目上限 ${MAX_TREE_ENTRIES} 已达；缩小 path 或传 include_vendor=true 查看更多]`;
    case "treeDepthCap":
      return `[另有 ${values.remaining} 个目录未展开，depth=${values.depth} 已到上限；传 depth=${values.depth + 2} 或 include_vendor=true 查看更多]`;
    case "readBytesCap": {
      const total = values.total === undefined ? "" : `，共 ${values.total} 行`;
      return `[本次返回已达 max_bytes=${values.maxBytes} 字节上限${total}；offset=${values.offset} 继续]`;
    }
    case "readMoreLines":
      // 历史 marker 逐字保留（模型侧唯一的通道就是文本）
      return `[共 ${values.total} 行，offset=${values.offset} 继续]`;
    case "readNotScanned":
      return `[文件 ${values.size} 字节 > max_bytes=${values.maxBytes}，行窗口之后的内容未读取；offset=${values.offset} 继续]`;
    case "readLineTruncated":
      return `[单行超过 max_bytes=${values.maxBytes}，超长部分已截断]`;
    default:
      throw new TypeError(`unknown tool marker kind: ${kind}`);
  }
}

/** 排除账 → marker 文本；全零返回 undefined（输出零变化）。文案本身在 toolMarker 里。 */
function skipAccountMarker(account) {
  const directories = account.vendorDirectories + account.hiddenDirectories;
  const total = directories + account.largeFiles + account.binaryFiles + account.deniedPaths;
  if (total === 0) return undefined;
  return toolMarker("skipped", {
    directories,
    largeFiles: account.largeFiles,
    binaryFiles: account.binaryFiles,
    deniedPaths: account.deniedPaths,
    suggestSwitches: directories > 0,
  });
}

/** 无命中结果文本（有排除账时同批给出；空串 = 静默，就是本轮要修的谎）。 */
function noMatchResult(note) {
  const text = toolMarker("noMatch");
  return note === undefined ? text : `${text}\n${note}`;
}

/**
 * 从残段文本里取出完整行（与 splitLines 同口径：CRLF/CR 都是行尾，末尾空段不算一行）。
 * 块末尾孤立的 `\r` 可能是 CRLF 的前半，非末块时留在残段里等下一块再判定。
 */
function takeCompleteLines(text, isFinal) {
  const lines = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n") {
      lines.push(text.slice(cursor, index));
      index += 1;
      cursor = index;
      continue;
    }
    if (char === "\r") {
      if (index + 1 === text.length && !isFinal) break; // 等下一块
      lines.push(text.slice(cursor, index));
      index += text[index + 1] === "\n" ? 2 : 1;
      cursor = index;
      continue;
    }
    index += 1;
  }
  return { lines, rest: text.slice(cursor) };
}

/** 截到 budget 字节以内（不切碎代理对）；确实截了就带省略号。 */
function fitByteBudget(text, budget) {
  if (budget <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

/**
 * 有界行窗口读取：定位读（`openSync` + `readSync(fd, …, position)`）+ 按块扫行 + 早停。
 *
 * 禁止全量 `readFileSync` 再 `split`——几百 MB 的文件会 `RangeError: Invalid string length`
 * 或被 OOM-kill，run 以 transport 错误终态。这里内存上限 = 一个块 + 一个残段。
 *
 * - 文件 ≤ max_bytes：扫到 EOF，行号与 `[共 N 行，offset=… 继续]` marker 与历史逐字节一致。
 * - 文件 > max_bytes：行窗口取满即早停（不再读之后的字节），marker 诚实说明「之后未读取」。
 * - 单个物理行超过 max_bytes：截断成一行并回报，其余内容丢到下一个换行（防单行 OOM）。
 */
function readLineWindow(absolutePath, { start, count, maxBytes }) {
  const size = statSync(absolutePath).size;
  const fd = openSync(absolutePath, "r");
  const decoder = new StringDecoder("utf8");
  const block = Buffer.alloc(READ_BLOCK_BYTES);
  const contentBudget = Math.max(0, maxBytes - READ_MARKER_RESERVE);
  const selected = [];
  let contentBytes = 0;
  let position = 0;
  let pending = "";
  let lineIndex = 0;
  let totalLines; // 只有扫到 EOF 才已知
  let contentCapped = false;
  let lineTruncated = false;
  let skippingToNewline = false;

  const acceptLine = (line, { mayTruncate = false } = {}) => {
    const index = lineIndex;
    lineIndex += 1;
    if (index < start || index >= start + count || contentCapped) return false;
    const separator = selected.length > 0 ? 1 : 0;
    const header = `${index + 1}: `;
    let formatted = `${header}${line}`;
    let bytes = Buffer.byteLength(formatted, "utf8") + separator;
    if (contentBytes + bytes > contentBudget) {
      if (!mayTruncate) {
        contentCapped = true;
        return false;
      }
      // 超长行：按剩余额度截断（额度不够就诚实地报触顶，不假装返回了全文）
      const room = contentBudget - contentBytes - separator - Buffer.byteLength(header, "utf8") - 8;
      const fitted = fitByteBudget(line, room);
      if (fitted === "") {
        contentCapped = true;
        return false;
      }
      formatted = `${header}${fitted}`;
      bytes = Buffer.byteLength(formatted, "utf8") + separator;
    }
    contentBytes += bytes;
    selected.push(formatted);
    return true;
  };

  try {
    for (;;) {
      const read = readSync(fd, block, 0, block.length, position);
      const atEof = read < block.length;
      position += read;
      pending += read > 0 ? decoder.write(block.subarray(0, read)) : "";
      if (atEof) pending += decoder.end();

      if (skippingToNewline) {
        // 上一轮已把超长行截断回报，这一轮的开头仍是那条物理行的尾巴，直接丢
        const newline = pending.indexOf("\n");
        pending = newline === -1 ? "" : pending.slice(newline + 1);
        if (newline !== -1) skippingToNewline = false;
      }

      // 先拆行再判超长：一个块里通常有成百行，先拿 max_bytes 去比整块会误判「单行超长」
      const { lines, rest } = takeCompleteLines(pending, atEof);
      pending = rest;
      for (const line of lines) acceptLine(line);

      if (atEof) {
        if (pending !== "") acceptLine(pending);
        totalLines = lineIndex;
        break;
      }
      if (!skippingToNewline && pending.length > maxBytes) {
        // 拆完行仍未见到换行且已超字节上限 → 这是一条超长物理行：截断成一行并回报，
        // 余下内容丢到下一个换行（内存上限 = 一个块 + 一个残段，不会随文件大小增长）
        const inWindow = lineIndex >= start && lineIndex < start + count && !contentCapped;
        if (inWindow) {
          acceptLine(pending, { mayTruncate: true });
          lineTruncated = true;
        } else {
          lineIndex += 1;
        }
        pending = "";
        skippingToNewline = true;
      }
      const windowFilled = (count > 0 && selected.length >= count) || contentCapped;
      if (windowFilled && size > maxBytes) break; // 早停：大文件不再往后读
    }
  } finally {
    closeSync(fd);
  }

  return { selected, totalLines, contentCapped, lineTruncated, size };
}

function fileReadMarkers(window, { start, count, maxBytes }) {
  const markers = [];
  const nextOffset = start + window.selected.length;
  if (window.contentCapped) {
    markers.push(toolMarker("readBytesCap", { maxBytes, total: window.totalLines, offset: nextOffset }));
  } else if (window.totalLines !== undefined) {
    if (start + count < window.totalLines) {
      markers.push(toolMarker("readMoreLines", { total: window.totalLines, offset: start + count }));
    }
  } else {
    markers.push(toolMarker("readNotScanned", {
      size: window.size,
      maxBytes,
      offset: nextOffset,
    }));
  }
  if (window.lineTruncated) markers.push(toolMarker("readLineTruncated", { maxBytes }));
  return markers;
}

// ---------------------------------------------------------------------------
// 工具 schema（工具名与既有字段保持不变，零迁移；新参数一律 snake_case）
// ---------------------------------------------------------------------------

export const FILE_TOOL_DEFINITIONS = [
  {
    name: "readFile",
    description: "Read a text file by line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
        max_bytes: {
          type: "integer",
          description: "Maximum UTF-8 bytes returned per call (default 262144, clamped to 1024-4194304).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "searchText",
    description: "Search text files for a pattern with an EXPLICIT match mode: `mode` is required and has no default, "
      + "set mode=\"literal\" for fixed-string matching or mode=\"regex\" for JavaScript regular expressions. "
      + "This tool is a pure-Node walk, not a borrowed CLI binary and it carries no capability from any tool name: "
      + "no -i/-A/-B/-C/--type, .gitignore is NOT read, and name_pattern matches the FILE NAME only — it never crosses `/`, "
      + "so `**/*.ts` style glob patterns do not work. "
      + "node_modules/dist/build/target/vendor and dot-directories are skipped by default and reported at the end of the result. "
      + "Hits are returned as `path:line:matched line`, one per line; a matched line is returned whole up to 500 characters "
      + "and a longer line is cut to 500 plus a trailing `\u2026` \u2014 that width cap is this implementation's own output budget. "
      + "Truncated results carry `offset=\u2026 \u7ee7\u7eed` for continuation; skipped entries and truncation are also reported in the "
      + "structured result metadata (the model reads the marker text, not the fields).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        mode: {
          type: "string",
          enum: ["literal", "regex"],
          description: "Required, no default: \"literal\" = match the pattern as a fixed string, \"regex\" = JavaScript regular expression. A missing or unknown mode is an error; nothing is guessed.",
        },
        path: { type: "string" },
        name_pattern: {
          type: "string",
          description: "Filter by FILE NAME only (simple `*` wildcard). It never matches a directory part and never crosses `/`: use `*.test.js`, not `**/*.test.js`.",
        },
        max_results: { type: "integer", description: "Default 50, hard cap 200." },
        maxResults: { type: "integer", description: "Alias of max_results." },
        offset: { type: "integer", description: "Skip this many hits before returning (default 0); a truncated result reports the offset to continue from." },
        include_vendor: { type: "boolean", description: "Default false: skip node_modules/dist/build/target/vendor." },
        include_hidden: { type: "boolean", description: "Default false: skip dot-directories such as .git." },
      },
      required: ["pattern", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "rg",
    description: "Deprecated alias of searchText (issue #195): use searchText instead, passing mode explicitly. "
      + "This alias keeps the borrowed command name and its priors; searchText states its match mode explicitly "
      + "and names its file-name-only filter `name_pattern`. "
      + "Recursively search text files with a regular expression (the ripgrep command's own default). "
      + "Set is_regex=false for literal matching, equivalent to `rg --fixed-strings`. "
      + "Pure-Node subset, not the ripgrep binary: no -i/-A/-B/--type, .gitignore is NOT read; "
      + "node_modules/dist/build/target/vendor and dot-directories are skipped by default and reported at the end of the result. "
      + "A matched line is returned whole up to 500 characters; a longer line is cut to 500 plus a trailing `…` — that width cap is "
      + "this implementation's own output budget (a single minified line can be hundreds of KB); the real `rg` command "
      + "never truncates lines, and the cap is shared verbatim with grep.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "integer" },
        max_results: { type: "integer", description: "Alias of maxResults (default 50, hard cap 200)." },
        is_regex: {
          type: "boolean",
          description: "Default true: the pattern is a regular expression (matches ripgrep and matches this library's grep). Set false for fixed-string literal matching (rg --fixed-strings).",
        },
        include_vendor: { type: "boolean", description: "Default false: skip node_modules/dist/build/target/vendor." },
        include_hidden: { type: "boolean", description: "Default false: skip dot-directories such as .git." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Deprecated alias of searchText (issue #195): use searchText instead, passing mode explicitly. "
      + "This alias keeps the `glob` name for the file-name-only filter, which never crosses `/`. "
      + "Search file contents with a regex or literal pattern, grouped by file. "
      + "is_regex=true (the default) matches as a regular expression, equivalent to `grep -E`; is_regex=false matches the pattern literally, equivalent to `grep -F`. "
      + "Pure-Node subset, not the grep binary: JavaScript regex rather than BRE/ERE, no -i/-A/-B/--include, .gitignore is NOT read; "
      + "node_modules/dist/build/target/vendor and dot-directories are skipped by default and reported at the end of the result. "
      + "A matched line is returned whole up to 500 characters; a longer line is cut to 500 plus a trailing `…` — that width cap is "
      + "this implementation's own output budget (a single minified line can be hundreds of KB); the real `grep` command "
      + "never truncates lines, and the cap is shared verbatim with rg.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: {
          type: "string",
          description: "Matches the FILE NAME only (simple `*` wildcard): it never matches a directory part and never crosses `/`, so use `*.test.js` rather than `**/*.test.js`.",
        },
        is_regex: {
          type: "boolean",
          description: "Default true: regex matching (grep -E). Set false for fixed-string literal matching (grep -F).",
        },
        max_results: { type: "integer" },
        maxResults: { type: "integer", description: "Alias of max_results (default 50, hard cap 200)." },
        include_vendor: { type: "boolean", description: "Default false: skip node_modules/dist/build/target/vendor." },
        include_hidden: { type: "boolean", description: "Default false: skip dot-directories such as .git." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "tree",
    description: "List a directory tree. Skips node_modules/dist/build/target/vendor and dot-directories "
      + "unless include_vendor/include_hidden=true; truncation always carries a marker with the remainder count.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        depth: { type: "integer" },
        include_vendor: { type: "boolean", description: "Default false: skip node_modules/dist/build/target/vendor." },
        include_hidden: { type: "boolean", description: "Default false: skip dot-directories such as .git." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "writeFile",
    description: "Write UTF-8 text to any path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

function assertPredicate(predicate, label) {
  if (typeof predicate !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
  return predicate;
}

/**
 * 创建文件工具集（规范实现，root 与 `erix-agent/tools` 双导出）。
 *
 * @param {object} [options]
 * @param {string} [options.cwd] 相对路径的解析根（默认进程 cwd；测试与宿主必须显式注入）
 * @param {(absolutePath: string) => boolean} [options.allowRead]  读边界谓词，默认恒 true；库以**绝对路径**逐条调用
 * @param {(absolutePath: string) => boolean} [options.allowWrite] 写边界谓词，默认恒 true
 * @returns {{ definitions: object[], executeTool: Function, executors: object }}
 */
export function createFileTools({
  cwd = process.cwd(),
  allowRead = () => true,
  allowWrite = () => true,
} = {}) {
  const root = path.resolve(cwd);
  const canRead = assertPredicate(allowRead, "allowRead");
  const canWrite = assertPredicate(allowWrite, "allowWrite");

  const displayName = (target) => {
    const relative = path.relative(root, target);
    return (relative || path.basename(target)).split(path.sep).join("/");
  };
  const readDenied = (target) => `错误：读取被宿主边界拒绝：${truncateDisplayText(displayName(target), 200)}`;
  const writeDenied = (target) => `错误：写入被宿主边界拒绝：${truncateDisplayText(displayName(target), 200)}`;

  /** 无 signal 时零让出（非中止路径行为与开销不变）；有 signal 时每 32 个条目让出 + 查中止。 */
  const createCheckpoint = (signal) => {
    if (!signal) return async () => {};
    let processed = 0;
    return async () => {
      processed += 1;
      if (processed % ABORT_CHECKPOINT_EVERY !== 0) return;
      await new Promise((resolve) => setImmediate(resolve));
      throwIfAborted(signal);
    };
  };

  /**
   * rg/grep 共用的文件遍历：vendor/隐藏目录跳过 + 逐条 allowRead + 让出 checkpoint。
   * `onFile` 自行判定命中并回报排除账；`isDone()` 为真即早停。
   */
  const collectFiles = async (startPath, {
    signal,
    includeVendor,
    includeHidden,
    account,
    isDone,
    onFile,
  }) => {
    const checkpoint = createCheckpoint(signal);
    if (signal) throwIfAborted(signal);
    const visitedDirectories = new Set();

    const visit = async (currentPath) => {
      if (isDone()) return;
      let stat;
      try {
        stat = statSync(currentPath);
      } catch {
        return; // 悬空 symlink / 权限受限：跳过
      }
      if (stat.isFile()) {
        await onFile(currentPath, stat);
        return;
      }
      if (!stat.isDirectory() || visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      let entries;
      try {
        entries = readdirSync(currentPath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        return; // 目录不可读时跳过
      }
      for (const entry of entries) {
        if (isDone()) return;
        if (entry.isSymbolicLink()) continue; // 跳过 symlink，避免跟随到特殊文件/死链
        const entryPath = path.join(currentPath, entry.name);
        const skipped = directorySkipReason(entry, { includeVendor, includeHidden });
        if (skipped !== undefined) {
          account[skipped] += 1;
          continue;
        }
        if (!canRead(entryPath)) {
          account.deniedPaths += 1;
          continue;
        }
        await checkpoint();
        await visit(entryPath);
      }
    };

    await visit(startPath);
  };

  const readFile = async (input) => {
    const { path: filePath, offset = 0, limit = 200 } = input ?? {};
    const start = normalizeNonNegativeInteger(offset, 0);
    const count = normalizeNonNegativeInteger(limit, 200);
    const maxBytes = parseIntEnv(
      input?.max_bytes ?? process.env.ERIX_FILE_READ_MAX_BYTES,
      FILE_READ_MAX_BYTES_DEFAULT,
      { min: FILE_READ_MAX_BYTES_MIN, max: FILE_READ_MAX_BYTES_CEILING },
    );
    const target = resolveToolPath(root, filePath);
    if (!canRead(target)) return readDenied(target);

    const window = readLineWindow(target, { start, count, maxBytes });
    const parts = [...window.selected];
    parts.push(...fileReadMarkers(window, { start, count, maxBytes }));
    return parts.join("\n");
  };
  /**
   * 搜索的**唯一**实现体（issue #195 R1）：`searchText` 与它的两个薄别名 `rg`/`grep` 共跑这一份代码。
   *
   * 「别名等价」不是靠两处代码写得很像，而是靠**同一段代码**：命中行的取值、行宽截断、跳过账、
   * 无命中口径、截断 marker 全部在这里产出一次，两种 `format` 只是同一个 `hits` 数组的两种排版。
   *
   * @param {object} options
   * @param {RegExp} options.expression      已编译的模式（字面量还是正则由**调用方**定，这里不猜）
   * @param {string} [options.namePattern]   仅匹配文件名的 `*` 通配（不跨 `/`）
   * @param {"flat"|"grouped"} options.format flat = `文件:行号:正文`（rg 口径）/ grouped = 按文件分组（grep 口径）
   * @param {number} [options.offset]        跳过前 N 条命中（只有 `searchText` 会传；别名固定 0 → 行为逐字不变）
   * @param {boolean} [options.emitMetadata] 真则返回 `{content, metadata}`（引擎支持该形状，
   *   见 src/loop/run-snapshot-executor.js:83-121），假则返回历史形状的纯字符串
   */
  const runSearch = async ({
    expression,
    searchPath = ".",
    namePattern,
    resultLimit,
    offset = 0,
    includeVendor,
    includeHidden,
    format,
    emitMetadata,
  }, context) => {
    const resolvedSearchPath = resolveToolPath(root, searchPath);
    if (!canRead(resolvedSearchPath)) return readDenied(resolvedSearchPath);
    const nameExpression = compileNamePattern(namePattern);
    const account = createSkipAccount();
    const hits = [];
    const grouped = new Map();
    let matched = 0;

    const searchFile = (filePath, stat) => {
      if (stat.size > MAX_FILE_BYTES) {
        account.largeFiles += 1;
        return;
      }
      if (nameExpression !== undefined && !nameExpression.test(path.basename(filePath))) return;
      let bytes;
      try {
        bytes = readFileSync(filePath);
      } catch {
        return;
      }
      if (bytes.includes(0)) {
        account.binaryFiles += 1;
        return;
      }
      const lines = splitLines(bytes.toString("utf8"));
      for (let index = 0; index < lines.length; index += 1) {
        expression.lastIndex = 0;
        if (!expression.test(lines[index])) continue;
        matched += 1;
        // offset 只跳过**已命中的行**（不是字节、不是行号）；别名恒 0，故行为与历史逐字一致。
        if (matched <= offset) continue;
        // 行宽上限全库只有一个常量：同一个库里几个搜索工具对同一个超长行必须给出同样长的命中行。
        const hit = { file: filePath, line: index + 1, text: truncateDisplayText(lines[index], GREP_LINE_LIMIT) };
        hits.push(hit);
        const bucket = grouped.get(filePath);
        if (bucket === undefined) grouped.set(filePath, [hit]);
        else bucket.push(hit);
        // 触顶立即停遍历（#184 之后 `rg`/`grep` 的既有口径，逐字保持）。
        if (hits.length >= resultLimit) return;
      }
    };

    await collectFiles(resolvedSearchPath, {
      signal: context?.signal,
      includeVendor,
      includeHidden,
      account,
      isDone: () => hits.length >= resultLimit,
      onFile: (filePath, stat) => { searchFile(filePath, stat); },
    });

    const note = skipAccountMarker(account);
    // 截断判据与历史逐字同口径：命中数 == 上限即报截断（#184 之后 rg 用 `results.length >= limit`、
    // grep 用 `truncated || total >= limit`，两者等价，本轮不改语义）。
    const reachedCap = hits.length >= resultLimit;
    const metadata = {
      // 结构化账目：**进 transcript、不上 wire**（模型侧唯一的通道仍是 marker 文本）。
      searchHits: hits.length,
      searchMatchedLines: matched,
      searchFiles: grouped.size,
      searchLimit: resultLimit,
      searchOffset: offset,
      searchTruncated: reachedCap,
      ...(reachedCap ? { searchNextOffset: offset + hits.length } : {}),
      searchSkipped: {
        vendorDirectories: account.vendorDirectories,
        hiddenDirectories: account.hiddenDirectories,
        largeFiles: account.largeFiles,
        binaryFiles: account.binaryFiles,
        deniedPaths: account.deniedPaths,
      },
    };
    const wrap = (content) => (emitMetadata ? { content, metadata } : content);
    const truncationMarker = toolMarker("searchTruncated", {
      limit: resultLimit,
      // issue #195（主 agent 验收补漏）：CLI 提示词向模型承诺「截断时给出续读 offset」，那这条承诺
      // 必须落在**模型可见**的 marker 上——`metadata` 进 transcript 但不上 wire，首查被截时模型
      // 看不见 offset 只能猜个数。规范入口（`emitMetadata`）无论是否带 offset 都给；
      // 别名不吃 offset，输出逐字不变（issue #188：别名不得被继任入口带跑）。
      ...(emitMetadata || offset > 0 ? { nextOffset: offset + hits.length } : {}),
    });

    if (hits.length === 0) {
      // 无命中统一口径（`rg` 曾返回空串，模型无法区分「没搜到」与「搜了但被静音」）
      return wrap(noMatchResult(note));
    }
    if (format === "grouped") {
      const sections = [];
      for (const [filePath, fileHits] of grouped) {
        sections.push([displayName(filePath), ...fileHits.map((hit) => `${hit.line}: ${hit.text}`)].join("\n"));
      }
      if (reachedCap) sections.push(truncationMarker);
      if (note !== undefined) sections.push(note);
      return wrap(sections.join("\n\n"));
    }
    const lines = hits.map((hit) => `${displayName(hit.file)}:${hit.line}:${hit.text}`);
    if (reachedCap) lines.push(truncationMarker);
    if (note !== undefined) lines.push(note);
    return wrap(lines.join("\n"));
  };

  /** 别名结果尾部挂一行弃用提示（issue #188：Stable 面本轮只加告警、不删）。 */
  const withDeprecation = (result, name, replacement) => (
    typeof result === "string"
      ? `${result}\n${toolMarker("deprecated", { name, replacement })}`
      : { ...result, content: `${result.content}\n${toolMarker("deprecated", { name, replacement })}` }
  );

  /**
   * 单一搜索入口（issue #195）：名字**不借**任何 CLI 命令的先验，所以 `mode` 必填且无默认。
   * 返回 `{ content, metadata }`——跳过账/截断/next_offset 同时有结构化字段（进 transcript、
   * **不上 wire**，模型侧读的仍是 marker 文本）。
   */
  const searchText = async (input, context) => {
    const { pattern, mode, path: searchPath = ".", name_pattern: namePattern } = input ?? {};
    // `glob` 不接受、也不默默忽略：静默吞掉一个「看着能用」的参数，就是本轮要修的那个谎本身。
    if (input !== null && typeof input === "object" && Object.hasOwn(input, "glob")) {
      return "错误：searchText 不认识参数 glob：本实现的名称过滤只匹配文件名、不跨 `/`，请改传 name_pattern（且只支持简单 * 通配，不是完整 glob）";
    }
    if (!SEARCH_MODES.has(mode)) return searchModeError(mode);
    if (typeof pattern !== "string" || pattern === "") {
      return "错误：searchText 的 pattern 必须是非空字符串";
    }
    const compiled = compileSearchPattern(pattern, { literal: mode === "literal" });
    if (compiled.error !== undefined) return compiled.error;
    return runSearch({
      expression: compiled.expression,
      searchPath,
      namePattern,
      resultLimit: searchResultLimit(input, 50),
      offset: normalizeNonNegativeInteger(input?.offset, 0),
      includeVendor: normalizeFlag(input?.include_vendor),
      includeHidden: normalizeFlag(input?.include_hidden),
      format: "flat",
      emitMetadata: true,
    }, context);
  };

  /** `rg` 薄别名（issue #195 R3）：mode 由 `is_regex` 映射，输出形状逐字不变，尾部挂弃用行。 */
  const rg = async (input, context) => {
    const { pattern, path: searchPath = "." } = input ?? {};
    // 别名默认与真实命令一致：ripgrep 默认就是**正则**（字面量要 `--fixed-strings`），
    // 本库的 grep 默认同样是正则——两个搜索工具默认相反才是反常（issue #184 追加轮 A）。
    const compiled = compileSearchPattern(pattern, { literal: aliasSearchMode(input) === "literal" });
    if (compiled.error !== undefined) return compiled.error;
    const result = await runSearch({
      expression: compiled.expression,
      searchPath,
      resultLimit: searchResultLimit(input, 50),
      includeVendor: normalizeFlag(input?.include_vendor),
      includeHidden: normalizeFlag(input?.include_hidden),
      format: "flat",
    }, context);
    return withDeprecation(result, "rg", 'searchText with mode="regex"');
  };

  /** `grep` 薄别名（issue #195 R3）：继续吃 `glob`（语义 = name_pattern），分组形状逐字不变。 */
  const grep = async (input, context) => {
    const {
      pattern,
      path: searchPath = ".",
      glob,
      is_regex = true,
    } = input ?? {};
    if (typeof pattern !== "string" || pattern === "") {
      throw new TypeError("grep pattern must be a non-empty string");
    }
    const compiled = compileSearchPattern(pattern, { literal: is_regex === false });
    if (compiled.error !== undefined) return compiled.error;
    const result = await runSearch({
      expression: compiled.expression,
      searchPath,
      namePattern: glob,
      resultLimit: searchResultLimit(input, 50),
      includeVendor: normalizeFlag(input?.include_vendor),
      includeHidden: normalizeFlag(input?.include_hidden),
      format: "grouped",
    }, context);
    return withDeprecation(result, "grep", 'searchText with mode="regex" and name_pattern');
  };

  const tree = async (input, context) => {
    const { path: treePath = ".", depth = 3 } = input ?? {};
    const includeVendor = normalizeFlag(input?.include_vendor);
    const includeHidden = normalizeFlag(input?.include_hidden);
    const resolvedTreePath = resolveToolPath(root, treePath);
    if (!canRead(resolvedTreePath)) return readDenied(resolvedTreePath);
    const signal = context?.signal;
    if (signal) throwIfAborted(signal);
    const checkpoint = createCheckpoint(signal);
    const maxDepth = normalizeNonNegativeInteger(depth, 3);
    const rootStat = statSync(resolvedTreePath);
    const rootLabel = treePath === "." ? "." : path.basename(resolvedTreePath);
    const lines = [rootLabel + (rootStat.isDirectory() ? "/" : "")];
    const account = createSkipAccount();
    const visitedDirectories = new Set();
    let listed = 1;
    let notListed = 0;      // 条目上限之后被吞掉的同级条目
    let frontierDirectories = 0; // depth 到顶而未展开的目录
    let capped = false;

    const visit = async (currentPath, currentDepth) => {
      if (currentDepth >= maxDepth) {
        frontierDirectories += 1;
        return;
      }
      let stat;
      try {
        stat = statSync(currentPath);
      } catch {
        return;
      }
      if (!stat.isDirectory()) return;
      if (visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      let children;
      try {
        children = readdirSync(currentPath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        return;
      }
      for (let index = 0; index < children.length; index += 1) {
        if (listed >= MAX_TREE_ENTRIES) {
          capped = true;
          notListed += children.length - index;
          return;
        }
        const child = children[index];
        const childPath = path.join(currentPath, child.name);
        const skipped = directorySkipReason(child, { includeVendor, includeHidden });
        if (skipped !== undefined) {
          account[skipped] += 1;
          continue;
        }
        if (!canRead(childPath)) {
          account.deniedPaths += 1;
          continue;
        }
        await checkpoint();
        let childStat;
        try {
          childStat = statSync(childPath);
        } catch {
          continue; // 无法 stat 的条目（悬空 symlink 等）跳过
        }
        lines.push(`${"  ".repeat(currentDepth + 1)}${child.name}${childStat.isDirectory() ? "/" : ""}`);
        listed += 1;
        if (childStat.isDirectory()) await visit(childPath, currentDepth + 1);
      }
    };

    if (rootStat.isDirectory()) await visit(resolvedTreePath, 0);

    const markers = [];
    if (capped) {
      markers.push(toolMarker("treeEntryCap", { remaining: notListed }));
    }
    if (frontierDirectories > 0) {
      markers.push(toolMarker("treeDepthCap", { remaining: frontierDirectories, depth: maxDepth }));
    }
    const note = skipAccountMarker(account);
    if (note !== undefined) markers.push(note);
    if (markers.length > 0) lines.push(...markers);
    return lines.join("\n");
  };

  const writeFile = async (input) => {
    const { path: filePath, content } = input ?? {};
    if (typeof content !== "string") {
      throw new TypeError("writeFile content must be a string");
    }
    const target = resolveToolPath(root, filePath);
    if (!canWrite(target)) return writeDenied(target);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return Buffer.byteLength(content, "utf8");
  };

  const executors = { readFile, searchText, rg, grep, tree, writeFile };

  const runExecutor = async (name, input, context) => {
    const executor = executors[name];
    if (typeof executor !== "function") {
      throw new Error(`未知工具：${name}`);
    }
    return executor(normalizeToolInput(input), context);
  };
  // 结构化形态：兼容 runToolLoop / run-snapshot-executor 的
  // executeTool({id, name, input, context, signal})（signal 在顶层，必须并入 context，
  // 否则库里的遍历拿不到中止信号）；同时保留位置形态 executeTool(name, input, context)。
  const executeTool = async (firstArg, positionalInput, positionalContext) => {
    const structured = firstArg
      && typeof firstArg === "object"
      && !Array.isArray(firstArg)
      && typeof firstArg.name === "string";
    if (!structured) return runExecutor(firstArg, positionalInput, positionalContext);
    const context = {
      ...(firstArg.context ?? {}),
      toolUseId: firstArg.id,
      ...(firstArg.signal === undefined ? {} : { signal: firstArg.signal }),
    };
    return runExecutor(firstArg.name, firstArg.input, context);
  };

  return {
    definitions: FILE_TOOL_DEFINITIONS.map((definition) => structuredClone(definition)),
    executeTool,
    executors: (name, input, context) => runExecutor(name, input, context),
  };
}
