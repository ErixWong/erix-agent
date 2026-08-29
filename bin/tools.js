import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import { createFileTools, createJail, JailError } from "../src/tools/index.js";

const OUTPUT_LIMIT = 4096;
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 1024 * 1024;
const READ_ONLY_TOOL_NAMES = new Set(["readFile", "rg", "tree"]);
const EXEC_WHITELIST = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "ls",
  "pwd",
  "echo",
  "file",
  "stat",
  "which",
  "date",
  "uname",
  "whoami",
  "find",
  "git",
]);
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "remote",
  "ls-files",
  "show",
  "rev-parse",
  "blame",
  "shortlog",
  "grep",
  "describe",
]);
const GIT_BRANCH_READONLY_OPTIONS = new Set(["-a", "-r", "-v", "-vv", "-l"]);
const GIT_BRANCH_WRITE_OPTIONS = new Set(["-d", "-D", "-m", "-M", "-c", "-C"]);
const EXEC_TOOL_SCHEMA = {
  name: "exec",
  description: "执行白名单内的只读 shell 命令并返回输出。白名单：cat head tail grep wc sort uniq cut tr diff ls pwd echo file stat which date uname whoami find git。git 仅支持只读子命令 status/log/diff/remote/ls-files/show/rev-parse/blame/shortlog/grep/describe，branch 仅支持列表选项。禁止管道/重定向/命令替换。",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string", maxLength: 500 } },
    required: ["command"],
    additionalProperties: false,
  },
};

export const CLI_TOOLS_SYSTEM_PROMPT =
  "可用只读文件工具：readFile 读取文本文件（支持行范围），rg 用正则递归搜索文本文件，tree 列出目录树。这些文件工具只能读取当前工作目录树；越出当前目录、以及敏感目录（~/.erix、~/.pi、.git）均不可读。另有 exec 执行白名单内的只读 shell 命令并返回输出，白名单：cat head tail grep wc sort uniq cut tr diff ls pwd echo file stat which date uname whoami find git；git 仅支持只读子命令 status/log/diff/remote/ls-files/show/rev-parse/blame/shortlog/grep/describe，branch 仅支持列表选项；exec 禁止管道、重定向、命令替换和通配。";

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

function readableMaskedPaths(root, extraMaskedPaths) {
  const requestedPaths = [
    path.join(homedir(), ".erix"),
    path.join(homedir(), ".pi"),
    path.join(root, ".git"),
    ...(Array.isArray(extraMaskedPaths) ? extraMaskedPaths : []),
  ];

  return requestedPaths
    .filter((value) => typeof value === "string")
    .map((value) => path.resolve(root, value))
    .filter((value) => isWithin(root, value));
}

function forbiddenPathMessage(input) {
  const value = input && typeof input === "object" ? input.path : undefined;
  const displayPath = typeof value === "string" && value.length > 0
    ? value
    : "该路径";
  return `路径被禁止：${displayPath}`;
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

function unsafeExecSyntax(command) {
  return /[|><;&*`]|[$]\(|[\r\n]/.test(command);
}

function gitCommandError(subcommand) {
  return `错误：git 仅支持只读子命令：${[...GIT_READONLY_SUBCOMMANDS].join("/")}，禁止 ${subcommand}`;
}

function validateGitCommand(tokens) {
  const subcommand = tokens[1];
  if (
    subcommand === undefined
    || subcommand === "--version"
    || subcommand === "--help"
  ) {
    return null;
  }
  if (GIT_READONLY_SUBCOMMANDS.has(subcommand)) return null;

  if (subcommand === "branch") {
    const args = tokens.slice(2);
    const writeOption = args.find((arg) => GIT_BRANCH_WRITE_OPTIONS.has(arg));
    if (writeOption !== undefined) {
      return gitCommandError(`branch ${writeOption}`);
    }
    if (args.length === 0 || args.every((arg) => GIT_BRANCH_READONLY_OPTIONS.has(arg))) {
      return null;
    }
  }

  return gitCommandError(subcommand);
}

function executeExecCommand(input, cwd = process.cwd()) {
  const command = input?.command;
  if (typeof command !== "string") {
    return Promise.resolve("错误：命令必须是字符串");
  }
  if (command.length > 500) {
    return Promise.resolve("错误：命令超过 500 字符");
  }
  if (unsafeExecSyntax(command)) {
    return Promise.resolve("错误：命令含不安全语法");
  }

  const tokens = String(command).trim().split(/\s+/);
  const bin = tokens[0] ?? "";
  if (!EXEC_WHITELIST.has(bin)) {
    return Promise.resolve(
      `错误：命令 "${bin}" 不在白名单（${[...EXEC_WHITELIST].join(" ")}）`,
    );
  }
  if (bin === "git") {
    const gitError = validateGitCommand(tokens);
    if (gitError !== null) return Promise.resolve(gitError);
  }

  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve("错误：命令输出超过 1MB 上限");
          return;
        }
        if (error?.killed || error?.code === "ETIMEDOUT") {
          resolve(`错误：命令超时（${EXEC_TIMEOUT_MS}ms）被终止`);
          return;
        }

        const output = [stdout, stderr].filter(Boolean).join("");
        if (output) {
          resolve(truncateResult(output));
          return;
        }
        if (error) {
          resolve(`错误：命令执行失败（退出码 ${error.code ?? "未知"}）`);
          return;
        }
        resolve("(无输出)");
      },
    );
  });
}

export function truncateResult(result) {
  const text = String(result ?? "");
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n[已截断，共 ${text.length} 字符]`;
}

export function createCliTools({ cwd = process.cwd(), maskedPaths = [] } = {}) {
  const root = path.resolve(cwd);
  const jail = createJail({
    root,
    maskedPaths: readableMaskedPaths(root, maskedPaths),
  });
  const fileTools = createFileTools(jail);
  const tools = [
    ...fileTools.schemas.filter((schema) => READ_ONLY_TOOL_NAMES.has(schema.name)),
    structuredClone(EXEC_TOOL_SCHEMA),
  ];
  const executors = {
    ...Object.fromEntries(
      [...READ_ONLY_TOOL_NAMES].map((name) => [name, fileTools.executors[name]]),
    ),
    exec: (input) => executeExecCommand(input, root),
  };

  async function executeTool(name, input) {
    const executor = executors[name];
    if (typeof executor !== "function") {
      throw new Error(`未知工具：${name}`);
    }

    try {
      return await executor(normalizeToolInput(input));
    } catch (error) {
      if (error instanceof JailError) return forbiddenPathMessage(input);
      throw error;
    }
  }

  return { tools, executeTool, truncateResult };
}
