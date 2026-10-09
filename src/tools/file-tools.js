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
const GREP_LINE_LIMIT = 200;
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

/** glob → 仅文件名匹配的正则（只支持简单 `*` 通配，不跨目录分隔符）。 */
function compileGlob(glob) {
  if (typeof glob !== "string" || glob.trim() === "") return undefined;
  return new RegExp(`^${glob.split("*").map(escapeRegExpLiteral).join(".*")}$`);
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
      return `[命中过多，已按 max_results=${values.limit} 截断]`;
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
    name: "rg",
    description: "Recursively search text files. Patterns match literally unless is_regex=true. "
      + "Skips node_modules/dist/build/target/vendor and dot-directories unless include_vendor/include_hidden=true; "
      + "skip counts are reported at the end of the result.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "integer" },
        max_results: { type: "integer", description: "Alias of maxResults (default 50, hard cap 200)." },
        is_regex: { type: "boolean", description: "Default false: treat pattern as a literal string." },
        include_vendor: { type: "boolean", description: "Default false: skip node_modules/dist/build/target/vendor." },
        include_hidden: { type: "boolean", description: "Default false: skip dot-directories such as .git." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Search file contents with a regex or literal pattern, grouped by file. "
      + "Skips node_modules/dist/build/target/vendor and dot-directories unless include_vendor/include_hidden=true; "
      + "skip counts are reported at the end of the result.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        is_regex: { type: "boolean" },
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

  const rg = async (input, context) => {
    const { pattern, path: searchPath = "." } = input ?? {};
    // rg 正则硬化：默认按**字面量**匹配（is_regex=true 才走正则）；无效正则转工具错误结果。
    const compiled = compileSearchPattern(pattern, { literal: input?.is_regex !== true });
    if (compiled.error !== undefined) return compiled.error;
    const { expression } = compiled;
    const includeVendor = normalizeFlag(input?.include_vendor);
    const includeHidden = normalizeFlag(input?.include_hidden);
    const resultLimit = searchResultLimit(input, 50);
    const resolvedSearchPath = resolveToolPath(root, searchPath);
    if (!canRead(resolvedSearchPath)) return readDenied(resolvedSearchPath);
    const account = createSkipAccount();
    const results = [];

    const searchFile = (filePath, stat) => {
      if (stat.size > MAX_FILE_BYTES) {
        account.largeFiles += 1;
        return;
      }
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
        results.push(`${displayName(filePath)}:${index + 1}:${lines[index]}`);
        if (results.length >= resultLimit) return;
      }
    };

    await collectFiles(resolvedSearchPath, {
      signal: context?.signal,
      includeVendor,
      includeHidden,
      account,
      isDone: () => results.length >= resultLimit,
      onFile: (filePath, stat) => { searchFile(filePath, stat); },
    });

    const note = skipAccountMarker(account);
    if (results.length === 0) return noMatchResult(note);
    const lines = [...results];
    if (results.length >= resultLimit) {
      lines.push(toolMarker("searchTruncated", { limit: resultLimit }));
    }
    if (note !== undefined) lines.push(note);
    return lines.join("\n");
  };

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
    const resultLimit = searchResultLimit(input, 50);
    const compiled = compileSearchPattern(pattern, { literal: is_regex === false });
    if (compiled.error !== undefined) return compiled.error;
    const { expression } = compiled;
    const globExpression = compileGlob(glob);
    const includeVendor = normalizeFlag(input?.include_vendor);
    const includeHidden = normalizeFlag(input?.include_hidden);
    const resolvedSearchPath = resolveToolPath(root, searchPath);
    if (!canRead(resolvedSearchPath)) return readDenied(resolvedSearchPath);
    const account = createSkipAccount();
    const grouped = new Map();
    let total = 0;
    let truncated = false;

    const searchFile = (filePath, stat) => {
      if (stat.size > MAX_FILE_BYTES) {
        account.largeFiles += 1;
        return;
      }
      if (globExpression !== undefined && !globExpression.test(path.basename(filePath))) return;
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
      let fileHits = grouped.get(filePath);
      for (let index = 0; index < lines.length; index += 1) {
        if (total >= resultLimit) {
          truncated = true;
          return;
        }
        expression.lastIndex = 0;
        if (!expression.test(lines[index])) continue;
        if (fileHits === undefined) {
          fileHits = [];
          grouped.set(filePath, fileHits);
        }
        fileHits.push(`${index + 1}: ${truncateDisplayText(lines[index], GREP_LINE_LIMIT)}`);
        total += 1;
      }
    };

    await collectFiles(resolvedSearchPath, {
      signal: context?.signal,
      includeVendor,
      includeHidden,
      account,
      isDone: () => total >= resultLimit,
      onFile: (filePath, stat) => { searchFile(filePath, stat); },
    });

    const note = skipAccountMarker(account);
    if (grouped.size === 0) {
      // 无命中统一口径（rg 以前返回空串，模型无法区分「没搜到」与「搜了但被静音」）
      return noMatchResult(note);
    }
    const sections = [];
    for (const [filePath, hits] of grouped) {
      sections.push([displayName(filePath), ...hits].join("\n"));
    }
    if (truncated || total >= resultLimit) {
      sections.push(toolMarker("searchTruncated", { limit: resultLimit }));
    }
    if (note !== undefined) sections.push(note);
    return sections.join("\n\n");
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

  const executors = { readFile, rg, grep, tree, writeFile };

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
