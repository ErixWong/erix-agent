import { execFile, spawn } from "node:child_process";
import {
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
].map(normalizeSchema);

export const CLI_TOOLS_SYSTEM_PROMPT =
  `可用工具：readFile 读取文本文件（支持行范围），rg 用正则递归搜索文本文件，tree 列出目录树，writeFile 写入 UTF-8 文本，exec 执行 shell 命令并返回输出。

[你的处境]
上下文会被折叠，早期细节你会真的忘记——不是记不清，是没有。
拿到后面还要用的具体值/决定时，立刻 note_take；
需要早期细节而想不起来时，先 note_list 再 note_read，不要猜。
重跑同一命令可能得到不同的值；需要早期精确值时用 recall 取回，不要凭记忆。
终稿的结束协议 JSON 必须带 findings 字段，只把归档输出中出现过的字面值声明为 label→精确值（如 "findings":{"nonce":"abc123"}）；不要声明计数/次数/引用等派生结论；没有关键值时省略该字段。

[工具纪律]
- 复杂任务先规划并逐步执行；长任务用 todo 工具记录进度
- 大文件用 readFile 的 offset/limit 分段读取，操作后验证结果
- 具体数值必须来自当前工具返回或 note_read，不得编造
- 不要主动读取密钥、凭据或 .env 文件；只用本次工具返回明确给出的来源
- 任务完成后直接汇报结果，默认使用中文`;

export function buildCliToolsSystemPrompt() {
  // ADR-015：ResourceStore 退出模型视野——所有宿主形态同一份提示词，不提 opaque 工件/路径。
  return CLI_TOOLS_SYSTEM_PROMPT;
}

export function buildArchiveNotice(archiveDir) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) return "";
  return "\n\n[工具输出归档]\n大输出已由引擎全量归档。需要早期原文时用 recall({ pattern: \"关键词\" }) 搜索，或 recall({ fromRound, lineOffset, lineLimit }) 按行直读某段原文；需要精确值时用 note_list/note_read 读取；不要凭记忆补值，不要重跑命令。";
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

export function truncateResult(result) {
  const text = String(result ?? "");
  if (/\n\[完整输出(?:已归档|归档失败)：[^\n]+\]$/u.test(text)) return text;
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n[已截断，共 ${text.length} 字符]`;
}

const TOOL_INPUT_LIMIT = 120;
const TOOL_RESULT_LIMIT = 200;
const TOOL_EXEC_RESULT_LIMIT = 4096;
const TOOL_FIELD_LIMIT = 80;
const SENSITIVE_INPUT_KEY = /(?:api[-_]?key|private[-_]?key|access[-_]?token|token|secret|password|authorization|credential)/iu;

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

  const serialized = JSON.stringify(input, (key, value) => {
    if (key !== "" && SENSITIVE_INPUT_KEY.test(key)) return "[已隐藏]";
    return typeof value === "string"
      ? truncateDisplayText(value, TOOL_FIELD_LIMIT)
      : value;
  });
  return truncateDisplayText(serialized ?? input, TOOL_INPUT_LIMIT);
}

function summarizeToolResult(name, result) {
  const text = String(result ?? "");
  // exec 输出可能是验证/回归脚本的多行结果，必须完整可见（对齐 exec 内部 4096 截断）
  const limit = name === "exec" ? TOOL_EXEC_RESULT_LIMIT : TOOL_RESULT_LIMIT;
  return truncateDisplayText(text, limit);
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

  const executors = {
    readFile,
    rg,
    tree,
    writeFile,
    exec: (input) => executeExecCommand(input, root),
  };

  async function executeTool(name, input, context) {
    const executor = executors[name];
    if (typeof executor !== "function") {
      throw new Error(`未知工具：${name}`);
    }
    const normalizedInput = normalizeToolInput(input);
    lastToolMetadata = { name };
    // ADR-016：重跑值错配风险由提示语一行承担（"重跑可能得到不同的值，需要早期
    // 精确值用 recall 取回"），引擎不再做幂等分类/重跑检测/捕值。
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
