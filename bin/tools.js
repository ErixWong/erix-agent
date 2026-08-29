import { execFile, spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 500;
const OUTPUT_LIMIT = 4096;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER = 1024 * 1024;

// ERIX_EXEC_TIMEOUT_MS overrides the default timeout for foreground commands.
export function getExecTimeoutMs() {
  const configured = Number(process.env.ERIX_EXEC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_EXEC_TIMEOUT_MS;
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

[工作方式]
- 复杂任务先规划：用 tree/readFile 了解项目结构，拆步骤逐步执行
- **长任务（多步、可能跨会话）先用 todo_add 拆解任务清单**（存当前目录 .erix-todo.json）；每完成一步 todo_done 划掉；会话开始时先 todo_list 恢复进度
- 按用户要求直接调用工具完成操作，不要只提供操作说明
- 每次操作后验证结果（读回文件、检查命令退出码），失败则诊断重试，不假装成功
- 输出必须来自工具真实返回，不得编造文件内容或命令结果

[边界]
- 本 CLI 不提供安全边界，运行环境负责隔离；敏感操作（删除、覆盖、网络、安装）先说明要做什么
- 不要主动读取密钥/凭据文件（如 ~/.erix、~/.pi、.env）

[收尾]
- 任务完成或已无需更多工具时，直接输出最终答复，不要空转
- 默认用中文回答；复杂任务结构化汇报：做了什么、结果、遗留问题
- 汇报关键状态声明（如"服务仍在运行"）前，先用工具验证（curl/检查进程），不要凭推断下结论`;

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

  const timeoutMs = getExecTimeoutMs();
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
          resolve(truncateResult(output));
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

export function wrapExecuteTool(executeTool, { output = console.log } = {}) {
  if (typeof executeTool !== "function") {
    throw new TypeError("executeTool must be a function");
  }
  if (typeof output !== "function") {
    throw new TypeError("output must be a function");
  }

  return async (name, input, context) => {
    output(`→ ${name}: ${summarizeToolInput(name, input)}`);
    try {
      const result = await executeTool(name, input, context);
      output(`← ${name}: ${summarizeToolResult(name, result)}`);
      return result;
    } catch (error) {
      output(`← ${name}: ${summarizeToolResult(name, `错误：${error?.message ?? String(error)}`)}`);
      throw error;
    }
  };
}

export function createCliTools({ cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd);

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
      const stat = statSync(currentPath);
      if (stat.isFile()) {
        searchFile(currentPath, stat);
        return;
      }
      if (!stat.isDirectory() || visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      const entries = readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (results.length >= resultLimit) return;
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
      if (!statSync(currentPath).isDirectory()) return;
      if (visitedDirectories.has(currentPath)) return;
      visitedDirectories.add(currentPath);

      const children = readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (entries >= MAX_TREE_ENTRIES) return;
        const childPath = path.join(currentPath, child.name);
        const childStat = statSync(childPath);
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

  async function executeTool(name, input) {
    const executor = executors[name];
    if (typeof executor !== "function") {
      throw new Error(`未知工具：${name}`);
    }
    return executor(normalizeToolInput(input));
  }

  return {
    tools: schemas.map((schema) => structuredClone(schema)),
    executeTool,
    truncateResult,
  };
}
