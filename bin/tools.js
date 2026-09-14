import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { autoCaptureKey, captureToolExecution } from "./auto-capture.js";
import { note_read as notesRead } from "../skills/notes/skill.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 500;
const OUTPUT_LIMIT = 4096;
const ARCHIVE_THRESHOLD = 800;
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const INSTALL_EXEC_TIMEOUT_MS = 300_000; // 安装/编译类命令（apt/pip/make 等）给更长时间
const EXEC_MAX_BUFFER = 1024 * 1024;

// 安装/编译/下载类命令前缀（benchmark 实测 apt-get install 频繁超时）
const INSTALL_COMMAND_PATTERN = /^(?:sudo\s+)?(?:apt-get|apt|pip\d?|pip3|npm|yarn|pnpm|make|cmake|gcc|g\+\+|cc|configure|bash\s+.*\.sh|curl|wget)\b/;

// These commands can produce a different value on every execution. Keep this
// list explicit so the archive policy can grow without changing capture logic.
export const NON_REPLAYABLE_COMMAND_PATTERNS = Object.freeze([
  /\/dev\/urandom\b/iu,
  /\$RANDOM\b/iu,
  /\bopenssl\s+rand\b/iu,
  /\buuidgen\b/iu,
  /\bdate\s+[^;&|]*\+%s%N\b/iu,
  /\bmktemp\b/iu,
  /\bshuf\b/iu,
  /\bhead\s+-c\s+\S+\s+\/dev\/urandom\b/iu,
]);

export function isNonReplayableCommand(command) {
  const text = String(command ?? "");
  return NON_REPLAYABLE_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

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
非幂等命令（/dev/urandom、$RANDOM…）重跑会得到不同的值，
不得重跑"恢复"原值，不得凭记忆给值；确实不可恢复就明说不可恢复。
涉及捕获值时，终稿必须显式写出 label=value（或“label 值是 value”）。
首次捕获值可直接使用；后续重跑值必须附来源=note_read:<key> 或来源=归档:<文件名>。

[工具纪律]
- 复杂任务先规划并逐步执行；长任务用 todo 工具记录进度
- 大文件用 readFile 的 offset/limit 分段读取，操作后验证结果
- 具体数值必须来自当前工具返回或明确的归档文件，不得编造
- 不要主动读取密钥、凭据或 .env 文件；只读取本次工具返回明确给出的归档路径
- 任务完成后直接汇报结果，默认使用中文`;

export function buildArchiveNotice(archiveDir) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) return "";
  return `\n\n[工具输出归档]\n本次运行的归档目录：${path.resolve(archiveDir)}。需要早期原文时读取明确的归档文件或先用 note_list、note_read 恢复记录；禁止遍历归档目录、重跑非幂等命令或凭记忆补值。`;
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
    capture = captureToolExecution,
    notesScope,
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
  if (typeof capture !== "function") {
    throw new TypeError("capture must be a function");
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
      const metadata = getToolMetadata?.();
      await capture({
        name,
        input,
        result,
        metadata,
        toolUseId: context?.toolUseId,
        round: context?.round,
        notesScope,
      });
      output(`← ${name}: ${summarizeToolResult(name, result)}`);
      return result;
    } catch (error) {
      output(`← ${name}: ${summarizeToolResult(name, `错误：${error?.message ?? String(error)}`)}`);
      throw error;
    }
  };
}

function archiveGuidance(archivePath) {
  return `[完整输出已归档：${archivePath}（需要原始内容请用 readFile/cat 读取该路径；不要重跑命令，重跑会得到不同的值）]`;
}

function archiveFailureGuidance(archivePath, error, replayable) {
  if (!replayable) {
    return "[完整输出归档失败：原始输出不可恢复；请勿重跑命令。]";
  }
  const reason = String(error?.message ?? error ?? "未知错误")
    .replaceAll(/\s+/gu, " ")
    .slice(0, 160);
  return `[完整输出归档失败：${archivePath}（${reason}）；请勿重跑命令。]`;
}

export function archiveResult(
  archiveDir,
  name,
  result,
  sequence,
  { force = false, replayable = true, command, context } = {},
) {
  const text = String(result ?? "");
  if (!archiveDir || (!force && text.length <= ARCHIVE_THRESHOLD)) return null;

  const archivePath = path.join(
    archiveDir,
    `${String(sequence).padStart(3, "0")}-${name}.txt`,
  );
  const metadataPath = `${archivePath.slice(0, -".txt".length)}.meta.json`;
  try {
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(text, "utf8");
    let archived = bytes;
    let truncated = false;
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      const marker = Buffer.from(
        `\n[归档仅保留前 ${MAX_ARCHIVE_BYTES} 字节，原始输出共 ${bytes.byteLength} 字节]`,
        "utf8",
      );
      const prefixBudget = Math.max(0, MAX_ARCHIVE_BYTES - marker.byteLength);
      const characters = Array.from(text);
      let low = 0;
      let high = characters.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <= prefixBudget) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      archived = Buffer.concat([
        Buffer.from(characters.slice(0, low).join(""), "utf8"),
        marker,
      ]);
      truncated = true;
    }
    const archivedText = archived.toString("utf8");
    const digest = createHash("sha256").update(archivedText, "utf8").digest("hex");
    const lineParts = archivedText.split(/\r\n|\r|\n/u);
    const lines = Math.max(
      1,
      lineParts.length - (archivedText.endsWith("\n") || archivedText.endsWith("\r") ? 1 : 0),
    );
    const artifact = {
      artifactId: path.basename(archivePath),
      archivePath,
      digest,
      locator: { lineStart: 1, lineEnd: lines },
      replayable,
      truncated,
      originalBytes: bytes.byteLength,
    };
    const metadata = {
      kind: "erix.tool-capture",
      schemaVersion: 1,
      toolUseId: context?.toolUseId ?? null,
      round: context?.round ?? null,
      command: command ?? null,
      replayable,
      digest,
      archivePath,
      locator: artifact.locator,
      truncated,
      originalBytes: bytes.byteLength,
    };
    writeFileSync(archivePath, archivedText, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return {
      text: `${truncateResult(text)}\n${archiveGuidance(archivePath)}`,
      archivePath,
      artifact,
      archivedText,
    };
  } catch (error) {
    for (const target of [archivePath, metadataPath]) {
      try {
        unlinkSync(target);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.cause = cleanupError;
      }
    }
    return {
      text: replayable
        ? `${truncateResult(text)}\n${archiveFailureGuidance(archivePath, error, replayable)}`
        : archiveFailureGuidance(archivePath, error, replayable),
      archivePath: undefined,
      artifact: undefined,
    };
  }
}

function duplicateCommandGuidance({ count, archivePath }) {
  const recovery = archivePath
    ? `原始输出在 ${archivePath}，请读取该文件取回原值，不要把本次输出当作原值。`
    : "原始输出未归档，无法取回；请明确说明不可恢复，不要把本次输出当作原值。";
  return `[注意：该命令本次运行已执行过第 ${count} 次；若其输出是随机值/时间戳/一次性内容，本次结果不是原始值。${recovery}]`;
}

function rerunGuidance(firstCapture) {
  const pointers = [];
  if (firstCapture?.captureKey) pointers.push(`note_read key=${firstCapture.captureKey}`);
  if (firstCapture?.archivePath) pointers.push(`归档 ${firstCapture.archivePath}`);
  const pointer = pointers.length > 0
    ? pointers.join(" / ")
    : "首次值不可恢复，请明确说明不可恢复";
  return `[⚠️ 重跑警示：这是重跑结果，不保证等于本 run 首次执行的值；首次值见 ${pointer}。]`;
}

function normalizeCommand(command) {
  return String(command).replaceAll(/\r\n?/gu, "\n").trim();
}

async function readCapturedValues(commandState, notesScope) {
  if (
    !notesScope
    || typeof notesScope !== "object"
    || !commandState.archivePath
    || typeof commandState.artifactDigest !== "string"
  ) {
    return [];
  }

  if (!commandState.captureKey) return [];
  const key = commandState.captureKey;
  const result = JSON.parse(await notesRead({ key, __erix: notesScope }));
  if (result.status !== "found" || result.current?.provenance?.source !== "auto") return [];
  if (result.artifactRef?.digest !== commandState.artifactDigest) return [];
  return [{
    key,
    ...(typeof result.value === "string" ? { value: result.value } : {}),
  }];
}

function interceptedNonReplayableResult(commandState, values) {
  const lines = [
    "[已拦截重复执行：该命令非幂等、不可重放；重跑会得到不同值。]",
  ];
  for (const item of values) {
    if (typeof item.value === "string") {
      const firstLine = item.value.split(/\r\n|\r|\n/u)[0];
      const assignment = /^\s*[^:=\s][^:=]*=\s*(.*?)\s*$/u.exec(firstLine);
      const displayValue = assignment?.[1] || item.value;
      lines.push(`首次执行捕获到的值（来自首次执行（已捕获））：${displayValue}`);
    }
    lines.push(`note_read key=${item.key}`);
  }
  if (commandState.archivePath) {
    lines.push(`首次执行归档：${commandState.archivePath}`);
  }
  return lines.join("\n");
}

export function createCliTools({
  cwd = process.cwd(),
  archiveDir,
  notesScope,
  runState: runStateOption,
} = {}) {
  const root = path.resolve(cwd);
  if (archiveDir !== undefined && typeof archiveDir !== "string") {
    throw new TypeError("archiveDir must be a string");
  }
  const archiveRoot = archiveDir === undefined ? undefined : path.resolve(archiveDir);
  let archiveSequence = 0;
  const duplicateCommands = archiveRoot ? new Map() : undefined;
  let lastToolMetadata;
  const runState = runStateOption && typeof runStateOption === "object"
    ? runStateOption
    : {};
  let firstCapture;
  let captureCount = 0;

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
    const command = normalizedInput?.command;
    const replayable = name !== "exec" || !isNonReplayableCommand(command);
    const hadCaptureBefore = captureCount > 0;
    lastToolMetadata = { name, replayable };
    let commandState;
    let isFirstCommandExecution = false;
    if (
      duplicateCommands
      && name === "exec"
      && typeof command === "string"
    ) {
      const normalizedCommand = normalizeCommand(command);
      commandState = duplicateCommands.get(normalizedCommand);
      if (commandState) {
        commandState.count += 1;
      } else {
        commandState = {
          count: 1,
          archivePath: undefined,
          artifactDigest: undefined,
          captureKey: undefined,
        };
        duplicateCommands.set(normalizedCommand, commandState);
        isFirstCommandExecution = true;
      }
    }

    if (commandState?.count > 1 && !replayable) {
      const capturedValues = await readCapturedValues(commandState, notesScope);
      if (capturedValues.length > 0) {
        lastToolMetadata = { name, replayable: true, intercepted: true };
        return interceptedNonReplayableResult(commandState, capturedValues);
      }
    }

    const result = await executor(normalizedInput);
    let returnedResult = result;
    const shouldArchive = archiveRoot && (
      String(result ?? "").length > ARCHIVE_THRESHOLD
      || (name === "exec" && !replayable)
    );
    if (shouldArchive) {
      archiveSequence += 1;
      const archived = archiveResult(archiveRoot, name, result, archiveSequence, {
        force: name === "exec" && !replayable,
        replayable,
        command,
        context,
      });
      if (archived !== null) {
        returnedResult = archived.text;
        if (isFirstCommandExecution) {
          commandState.archivePath = archived.archivePath;
          commandState.artifactDigest = archived.artifact?.digest;
          commandState.captureKey = archived.artifact
            ? autoCaptureKey(command, archived.artifact)
            : undefined;
        }
        lastToolMetadata = {
          name,
          replayable,
          fullOutput: archived.archivedText ?? String(result ?? ""),
          artifact: archived.artifact,
        };
        if (name === "exec" && !replayable && archived.artifact) {
          captureCount += 1;
          runState.captureCount = captureCount;
          if (firstCapture === undefined) {
            firstCapture = {
              archivePath: archived.archivePath,
              captureKey: autoCaptureKey(command, archived.artifact),
            };
          }
        }
      }
    }
    if (name === "exec" && !replayable && hadCaptureBefore) {
      runState.rerunDetected = true;
      returnedResult = `${rerunGuidance(firstCapture)}\n${String(returnedResult ?? "")}`;
    }
    const finalResult = name === "exec" ? truncateResult(returnedResult) : returnedResult;
    if (commandState?.count > 1) {
      return `${String(finalResult ?? "")}\n${duplicateCommandGuidance(commandState)}`;
    }
    return finalResult;
  }

  return {
    tools: schemas.map((schema) => structuredClone(schema)),
    executeTool,
    getLastToolMetadata: () => lastToolMetadata,
    getRunState: () => ({
      ...runState,
      captureCount,
      rerunDetected: runState.rerunDetected === true,
    }),
    truncateResult,
  };
}
