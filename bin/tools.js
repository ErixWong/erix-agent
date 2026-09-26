import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 500;
const OUTPUT_LIMIT = 4096;
// grep：单行命中内容展示上限 / max_results 硬上限（2026-09-20 基准：防爆炸输出拖慢主循环）
const GREP_LINE_LIMIT = 200;
const GREP_MAX_RESULTS_HARD_CAP = 200;
// 尾部保留比例（截断时）：结局（报错 / exit / 汇总）留在尾部可见
const TRUNCATE_TAIL_SHARE = 0.25;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const INSTALL_EXEC_TIMEOUT_MS = 300_000; // 安装/编译类命令（apt/pip/make 等）给更长时间
const EXEC_MAX_BUFFER = 1024 * 1024;

// 安装/编译/下载类命令前缀（benchmark 实测 apt-get install 频繁超时）
const INSTALL_COMMAND_PATTERN = /^(?:sudo\s+)?(?:apt-get|apt|pip\d?|pip3|npm|yarn|pnpm|make|cmake|gcc|g\+\+|cc|configure|bash\s+.*\.sh|curl|wget)\b/;

// ERIX_EXEC_TIMEOUT_MS overrides the default timeout for foreground commands.
export function getExecTimeoutMs() {
  const configured = Number(process.env.ERIX_EXEC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_EXEC_TIMEOUT_MS;
}

// 按命令类型选择超时：安装/编译/下载类命令超时更长（默认 300s），其余默认 120s。
export function getCommandTimeoutMs(command) {
  const base = getExecTimeoutMs();
  if (!INSTALL_COMMAND_PATTERN.test(String(command ?? "").trim())) return base;
  // 用户显式设置了全局超时则不放大（尊重显式配置）
  const configured = Number(process.env.ERIX_EXEC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : INSTALL_EXEC_TIMEOUT_MS;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function escapeRegExpLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function normalizeSchema(schema) {
  const result = { ...schema };
  if (result.inputSchema === undefined && result.input_schema !== undefined) {
    result.inputSchema = result.input_schema;
    delete result.input_schema;
  }
  return result;
}

const schemas = [
  {
    name: "readFile",
    description: "Read a text file by line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "rg",
    description: "Recursively search text files with a regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Search file contents with a regex or literal pattern, grouped by file.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        is_regex: { type: "boolean" },
        max_results: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "tree",
    description: "List a directory tree.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        depth: { type: "integer" },
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
  {
    name: "exec",
    description: "Execute any shell command and return its output.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_add",
    description: "添加一条待办任务（存 ~/.erix/todos/，按工作目录隔离），返回确认文本",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "任务内容" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_list",
    description: "列出当前工作目录的所有待办任务，可按状态过滤，返回格式化列表文本",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "done"],
          description: "可选过滤状态：pending 或 done",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "todo_done",
    description: "将指定 id 的任务标记为完成",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "任务 id" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_clear",
    description: "清空当前工作目录的全部任务",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
].map(normalizeSchema);

export const CLI_TOOLS_SYSTEM_PROMPT =
  `可用工具：readFile 读取文本文件（支持行范围），rg 用正则递归搜索文本文件，grep 递归搜索文件内容（支持 glob 文件名过滤、字面量/正则模式，结果按文件分组），tree 列出目录树，writeFile 写入 UTF-8 文本，exec 执行 shell 命令并返回输出，todo_add 添加待办任务、todo_list 列出待办、todo_done 标记完成、todo_clear 清空（均返回可读文本，数据存 ~/.erix/todos/ 按工作目录隔离）。

[你的处境]
上下文会被折叠，早期细节你会真的忘记——不是记不清，是没有。
拿到后面还要用的具体值/决定时，立刻 note_take；
需要早期细节而想不起来时，先 note_list 再 note_read，不要猜。
若你决定重读文件而不先查笔记（note_list/note_read），必须在可见输出里用一行说明理由（如「笔记可能过期，需最新行号」），便于审计你的取回决策。
重跑同一命令可能得到不同的值；后续需要精确值时先 note_take 记下，不要凭记忆。
内部思考（reasoning）一律使用英文；对用户的可见输出不受此限，跟随用户语言。
终稿的结束协议 JSON 必须带 findings 字段，只把归档输出中出现过的字面值声明为 label→精确值（如 "findings":{"nonce":"abc123"}）；不要声明计数/次数/引用等派生结论；没有关键值时省略该字段。

[工具纪律]
- 复杂任务先规划并逐步执行；长任务用 todo_add 记录进度、todo_done 标记完成，随时 todo_list 核对剩余项
- 大文件用 readFile 的 offset/limit 分段读取，操作后验证结果
- 具体数值必须来自当前工具返回或 note_read，不得编造
- 不要主动读取密钥、凭据或 .env 文件；只用本次工具返回明确给出的来源
- 任务完成后直接汇报结果，默认使用中文`;

/**
 * --tools 白名单过滤（chat/repl 共用）：对组合后的工具集做 allowlist。
 * 未知工具名 → onUnknown 警告（调用方写 stderr）并忽略；过滤后为空 → 抛错（调用方转 usageError）。
 */
export function filterToolsByAllowlist(tools, allowlist, { onUnknown } = {}) {
  if (allowlist === undefined || allowlist === null) return tools;
  const requested = String(allowlist)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const known = new Set((Array.isArray(tools) ? tools : []).map((tool) => tool?.name));
  for (const name of requested) {
    if (!known.has(name)) onUnknown?.(`警告：--tools 中的工具名 "${name}" 不存在，已忽略`);
  }
  const allowed = new Set(requested);
  const filtered = (Array.isArray(tools) ? tools : []).filter((tool) => allowed.has(tool?.name));
  if (filtered.length === 0) {
    throw new Error("--tools 过滤后没有可用工具，请检查工具名列表");
  }
  return filtered;
}

export function buildCliToolsSystemPrompt() {
  // ADR-015：ResourceStore 退出模型视野——所有宿主形态同一份提示词，不提 opaque 工件/路径。
  return CLI_TOOLS_SYSTEM_PROMPT;
}

export function buildArchiveNotice(archiveDir) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) return "";
  return "\n\n[工具输出归档]\n大输出已由引擎全量归档。后续需要精确值时先用 note_list 查找记录，再用 note_read 读取；若未记录且无法确定性重算，请省略对应 findings 声明，不要凭记忆补值，也不要重跑命令。";
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

function isBackgroundCommand(command) {
  return command.trim().endsWith("&");
}

function executeExecCommand(input, cwd) {
  const command = input?.command;
  if (typeof command !== "string") {
    return Promise.resolve("错误：命令必须是字符串");
  }

  if (isBackgroundCommand(command)) {
    const child = spawn(
      "/bin/sh",
      ["-c", command],
      { cwd, detached: true, stdio: "ignore" },
    );
    child.unref();
    return Promise.resolve(
      `服务已启动（PID ${child.pid ?? "未知"}）：${truncateDisplayText(command.trim(), 200)}`,
    );
  }

  const timeoutMs = getCommandTimeoutMs(command);
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve("错误：命令输出超过 1MB 上限");
          return;
        }
        if (error?.killed || error?.code === "ETIMEDOUT") {
          resolve(`错误：命令超时（${timeoutMs}ms）被终止`);
          return;
        }

        const output = [stdout, stderr].filter(Boolean).join("");
        if (output) {
          resolve(output);
          return;
        }
        if (error) {
          resolve(`exit ${error.code ?? "未知"}（命令失败）`);
          return;
        }
        resolve("exit 0（无输出）");
      },
    );
  });
}

/**
 * Head+tail truncation for oversized tool output (host layer).
 *
 * 保留开头（命令上下文 / 第一条结果）与结尾（报错、exit 行、汇总），中间省略并标注字符数。
 * 之前的 head-only 截断会把尾部报错信息整段丢掉（issue #32 #2）。本函数不按工具名分支：
 * exec 结果经它截断；readFile 不经过它（自带 offset/limit 的 head+offset 窗口，行为不变）。
 *
 * @param {string} text
 * @param {number} limit 保留的总字符数上限（head + tail）
 * @param {string} omittedNote
 * @returns {string}
 */
export function headTailTruncate(text, limit, omittedNote) {
  if (text.length <= limit) return text;
  const tailLength = Math.max(1, Math.floor(limit * TRUNCATE_TAIL_SHARE));
  const headLength = Math.max(0, limit - tailLength);
  // 不切碎代理对（CJK 之外的 emoji 会占两个 UTF-16 单元）
  const head = text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/u, "");
  const tail = text.slice(text.length - tailLength).replace(/^[\uDC00-\uDFFF]/u, "");
  const omitted = text.length - head.length - tail.length;
  return `${head}\n[${omittedNote(omitted, text.length)}]\n${tail}`;
}

export function truncateResult(result) {
  const text = String(result ?? "");
  if (/\n\[完整输出(?:已归档|归档失败)：[^\n]+\]$/u.test(text)) return text;
  return headTailTruncate(
    text,
    OUTPUT_LIMIT,
    (omitted, total) => `中间省略 ${omitted} 字符，共 ${total} 字符`,
  );
}

const TOOL_INPUT_LIMIT = 120;
const TOOL_RESULT_LIMIT = 200;
const TOOL_EXEC_RESULT_LIMIT = 4096;
const TOOL_FIELD_LIMIT = 80;

function truncateDisplayText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function summarizeToolInput(name, input) {
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && (name === "exec" || name === "readFile" || name === "writeFile")
  ) {
    const primaryField = name === "exec" ? "command" : "path";
    if (typeof input[primaryField] === "string") {
      return truncateDisplayText(input[primaryField], TOOL_INPUT_LIMIT);
    }
  }

  // 与 pi 对齐：终端回显不做内容检测/打码，只按显示宽度截断；
  // 凭据安全由 token hub 等执行侧职责保障（issue #55）
  const serialized = JSON.stringify(input, (key, value) => (typeof value === "string"
    ? truncateDisplayText(value, TOOL_FIELD_LIMIT)
    : value));
  return truncateDisplayText(serialized ?? input, TOOL_INPUT_LIMIT);
}

function summarizeToolResult(name, result) {
  const text = String(result ?? "");
  // exec 输出可能是验证/回归脚本的多行结果，必须完整可见（对齐 exec 内部 4096 截断）
  const limit = name === "exec" ? TOOL_EXEC_RESULT_LIMIT : TOOL_RESULT_LIMIT;
  // exec 日志同用 head+tail：尾部报错/exit 比中段 filler 有价值（issue #32 #2）
  return name === "exec"
    ? headTailTruncate(
      text,
      limit,
      (omitted, total) => `中间省略 ${omitted} 字符，共 ${total} 字符`,
    )
    : truncateDisplayText(text, limit);
}

export function wrapExecuteTool(
  executeTool,
  {
    output = console.log,
    getToolMetadata,
    returnMetadata = false,
  } = {},
) {
  if (typeof executeTool !== "function") {
    throw new TypeError("executeTool must be a function");
  }
  if (typeof output !== "function") {
    throw new TypeError("output must be a function");
  }
  if (getToolMetadata !== undefined && typeof getToolMetadata !== "function") {
    throw new TypeError("getToolMetadata must be a function");
  }

  // A one-argument wrapper makes runToolLoop pass its structured execution
  // context (toolUseId/round) while remaining compatible with direct callers.
  return async function wrappedExecuteTool(firstArg, positionalInput, positionalContext) {
    const structured = firstArg
      && typeof firstArg === "object"
      && !Array.isArray(firstArg)
      && typeof firstArg.name === "string";
    const name = structured ? firstArg.name : firstArg;
    const input = structured ? firstArg.input : positionalInput;
    const context = structured
      ? { ...(firstArg.context ?? {}), toolUseId: firstArg.id }
      : positionalContext;
    output(`→ ${name}: ${summarizeToolInput(name, input)}`);
    try {
      const result = await executeTool(name, input, context);
      output(`← ${name}: ${summarizeToolResult(name, result)}`);
      // ADR-016：replayable/rerunOf 元数据随可重放概念退役
      if (returnMetadata && typeof getToolMetadata === "function") {
        return { data: result };
      }
      return result;
    } catch (error) {
      output(`← ${name}: ${summarizeToolResult(name, `错误：${error?.message ?? String(error)}`)}`);
      throw error;
    }
  };
}

function normalizeCommand(command) {
  return String(command).replaceAll(/\r\n?/gu, "\n").trim();
}


export function createCliTools({
  cwd = process.cwd(),
} = {}) {
  const root = path.resolve(cwd);
  // ADR-016：replayable 分类、重跑检测、auto-capture 全部退役；
  // lastToolMetadata 仅存工具名（元数据通道收窄）。
  let lastToolMetadata;

  async function readFile({ path: filePath, offset = 0, limit = 200 }) {
    const text = readFileSync(resolveToolPath(root, filePath), "utf8");
    const lines = splitLines(text);
    const start = normalizeNonNegativeInteger(offset, 0);
    const count = normalizeNonNegativeInteger(limit, 200);
    const selected = lines
      .slice(start, start + count)
      .map((line, index) => `${start + index + 1}: ${line}`);

    if (start + count < lines.length) {
      selected.push(`[共 ${lines.length} 行，offset=${start + count} 继续]`);
    }
    return selected.join("\n");
  }

  async function rg({ pattern, path: searchPath = ".", maxResults = 50 }) {
    const expression = new RegExp(String(pattern));
    const resultLimit = normalizeNonNegativeInteger(maxResults, 50);
    const resolvedSearchPath = resolveToolPath(root, searchPath);
    const displayBase = root;
    const results = [];
    const visitedDirectories = new Set();

    const displayName = (filePath) => {
      const relative = path.relative(displayBase, filePath);
      return (relative || path.basename(filePath)).split(path.sep).join("/");
    };

    const searchFile = (filePath, stat) => {
      if (results.length >= resultLimit || stat.size > MAX_FILE_BYTES) return;
      const bytes = readFileSync(filePath);
      if (bytes.includes(0)) return;
      const lines = splitLines(bytes.toString("utf8"));
      for (let index = 0; index < lines.length; index += 1) {
        expression.lastIndex = 0;
        if (!expression.test(lines[index])) continue;
        results.push(`${displayName(filePath)}:${index + 1}:${lines[index]}`);
        if (results.length >= resultLimit) return;
      }
    };

    const visit = (currentPath) => {
      if (results.length >= resultLimit) return;
      let stat;
      try {
        stat = statSync(currentPath);
      } catch {
        return; // 无法 stat 的路径（悬空 symlink、权限受限等）直接跳过
      }
      if (stat.isFile()) {
        searchFile(currentPath, stat);
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
        if (results.length >= resultLimit) return;
        if (entry.isSymbolicLink()) continue; // 跳过 symlink，避免跟随到特殊文件/死链
        visit(path.join(currentPath, entry.name));
      }
    };

    visit(resolvedSearchPath);
    return results.join("\n");
  }

  async function grep({
    pattern,
    path: searchPath = ".",
    glob,
    is_regex = true,
    max_results = 50,
  }) {
    if (typeof pattern !== "string" || pattern === "") {
      throw new TypeError("grep pattern must be a non-empty string");
    }
    // max_results 硬上限 200：防爆输出（2026-09-20 基准：无上限搜索曾单次返回数千行）
    const resultLimit = Math.min(
      Math.max(1, normalizeNonNegativeInteger(max_results, 50)),
      GREP_MAX_RESULTS_HARD_CAP,
    );
    let expression;
    try {
      expression = is_regex === false
        ? new RegExp(escapeRegExpLiteral(pattern))
        : new RegExp(String(pattern));
    } catch {
      return `错误：无效正则：${truncateDisplayText(pattern, 80)}`;
    }
    // glob 只支持简单 * 通配（文件名匹配，不跨目录分隔符）
    let globExpression;
    if (typeof glob === "string" && glob.trim() !== "") {
      globExpression = new RegExp(`^${glob.split("*").map(escapeRegExpLiteral).join(".*")}$`);
    }

    const resolvedSearchPath = resolveToolPath(root, searchPath);
    const displayBase = root;
    const visitedDirectories = new Set();
    const grouped = new Map();
    let total = 0;
    let truncated = false;

    const displayName = (filePath) => {
      const relative = path.relative(displayBase, filePath);
      return (relative || path.basename(filePath)).split(path.sep).join("/");
    };

    const searchFile = (filePath, stat) => {
      if (total >= resultLimit || stat.size > MAX_FILE_BYTES) return;
      if (globExpression !== undefined && !globExpression.test(path.basename(filePath))) return;
      let bytes;
      try {
        bytes = readFileSync(filePath);
      } catch {
        return;
      }
      if (bytes.includes(0)) return; // 二进制文件跳过
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

    const visit = (currentPath) => {
      if (total >= resultLimit) return;
      let stat;
      try {
        stat = statSync(currentPath);
      } catch {
        return; // 悬空 symlink / 权限受限：跳过
      }
      if (stat.isFile()) {
        searchFile(currentPath, stat);
        return;
      }
      if (!stat.isDirectory() || visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      let entries;
      try {
        entries = readdirSync(currentPath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch {
        return;
      }
      for (const entry of entries) {
        if (total >= resultLimit) return;
        if (entry.isSymbolicLink()) continue;
        // 跳过 node_modules/.git 及隐藏目录（纯 node 递归 walk，不依赖外部 rg）
        if (entry.isDirectory()
          && (entry.name === "node_modules"
            || entry.name === ".git"
            || entry.name.startsWith("."))) {
          continue;
        }
        visit(path.join(currentPath, entry.name));
      }
    };

    visit(resolvedSearchPath);

    const sections = [];
    for (const [filePath, hits] of grouped) {
      sections.push([displayName(filePath), ...hits].join("\n"));
    }
    if (truncated || total >= resultLimit) {
      sections.push(`[命中过多，已按 max_results=${resultLimit} 截断]`);
    }
    if (sections.length === 0) return "（无命中）";
    return sections.join("\n\n");
  }

  async function tree({ path: treePath = ".", depth = 3 }) {
    const resolvedTreePath = resolveToolPath(root, treePath);
    const maxDepth = normalizeNonNegativeInteger(depth, 3);
    const rootStat = statSync(resolvedTreePath);
    const rootLabel = treePath === "." ? "." : path.basename(resolvedTreePath);
    const lines = [rootLabel + (rootStat.isDirectory() ? "/" : "")];
    const visitedDirectories = new Set();
    let entries = 1;

    const visit = (currentPath, currentDepth) => {
      if (entries >= MAX_TREE_ENTRIES || currentDepth >= maxDepth) return;
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
      for (const child of children) {
        if (entries >= MAX_TREE_ENTRIES) return;
        const childPath = path.join(currentPath, child.name);
        let childStat;
        try {
          childStat = statSync(childPath);
        } catch {
          continue; // 无法 stat 的条目（悬空 symlink 等）跳过
        }
        lines.push(`${"  ".repeat(currentDepth + 1)}${child.name}${childStat.isDirectory() ? "/" : ""}`);
        entries += 1;
        if (childStat.isDirectory()) visit(childPath, currentDepth + 1);
      }
    };

    if (rootStat.isDirectory()) {
      visit(resolvedTreePath, 0);
    }
    return lines.join("\n");
  }

  async function writeFile({ path: filePath, content }) {
    if (typeof content !== "string") {
      throw new TypeError("writeFile content must be a string");
    }
    const target = resolveToolPath(root, filePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return Buffer.byteLength(content, "utf8");
  }

  // ---- todo 内置工具（issue #65：自 ~/.erix/skills/todo/skill.mjs 移植）----
  // 数据文件定位与格式与原 skill 完全一致：~/.erix/todos/<basename>-<hash8>.json
  // （basename+cwd 的 sha256 前 8 位，按 cwd 隔离），老数据天然兼容。
  // 内置化后工具返回可读字符串（原 skill 返回对象，由宿主序列化）。

  function todoDataFile() {
    const base = path.basename(root) || "root";
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
    return path.join(homedir(), ".erix", "todos", `${base}-${hash}.json`);
  }

  function loadTodos() {
    const file = todoDataFile();
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveTodos(todos) {
    const file = todoDataFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(todos, null, 2), "utf8");
  }

  function formatTodoList(todos) {
    if (todos.length === 0) return "（无任务）";
    const lines = todos.map((item) => `#${item.id} [${item.status}] ${item.text}`);
    return [`共 ${todos.length} 条任务`, ...lines].join("\n");
  }

  async function todoAdd({ text }) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new TypeError("todo_add text 必须是非空字符串");
    }
    const todos = loadTodos();
    const id = todos.length > 0 ? Math.max(...todos.map((item) => Number(item.id) || 0)) + 1 : 1;
    const item = {
      id,
      text: String(text),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    todos.push(item);
    saveTodos(todos);
    return `已添加任务 #${id}: ${item.text}`;
  }

  async function todoList({ status } = {}) {
    let todos = loadTodos();
    if (status === "pending" || status === "done") {
      todos = todos.filter((item) => item.status === status);
    }
    return formatTodoList(todos);
  }

  async function todoDone({ id }) {
    const todos = loadTodos();
    const item = todos.find((entry) => entry.id === Number(id));
    if (!item) {
      throw new Error(`任务不存在: id=${id}`);
    }
    item.status = "done";
    saveTodos(todos);
    return `已将任务 #${item.id} 标记为完成：${item.text}`;
  }

  async function todoClear() {
    const before = loadTodos().length;
    saveTodos([]);
    return `已清空全部任务（共 ${before} 条）`;
  }

  const executors = {
    readFile,
    rg,
    grep,
    tree,
    writeFile,
    exec: (input) => executeExecCommand(input, root),
    todo_add: todoAdd,
    todo_list: todoList,
    todo_done: todoDone,
    todo_clear: todoClear,
  };

  async function executeTool(name, input, context) {
    const executor = executors[name];
    if (typeof executor !== "function") {
      throw new Error(`未知工具：${name}`);
    }
    const normalizedInput = normalizeToolInput(input);
    lastToolMetadata = { name };
    // ADR-016：重跑值错配风险由提示语承担，引擎不做幂等分类/重跑检测/捕值。
    const result = await executor(normalizedInput);
    return result;
  }

  return {
    tools: schemas.map((schema) => structuredClone(schema)),
    executeTool,
    getLastToolMetadata: () => lastToolMetadata,
    truncateResult,
  };
}
