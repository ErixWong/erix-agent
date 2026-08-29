import { homedir } from "node:os";
import path from "node:path";

import { createFileTools, createJail, JailError } from "../src/tools/index.js";

const OUTPUT_LIMIT = 4096;
const READ_ONLY_TOOL_NAMES = new Set(["readFile", "rg", "tree"]);

export const CLI_TOOLS_SYSTEM_PROMPT =
  "可用只读文件工具：readFile 读取文本文件（支持行范围），rg 用正则递归搜索文本文件，tree 列出目录树。工具只能读取当前工作目录树；越出当前目录、以及敏感目录（~/.erix、~/.pi、.git）均不可读。";

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
  const tools = fileTools.schemas.filter((schema) => READ_ONLY_TOOL_NAMES.has(schema.name));
  const executors = Object.fromEntries(
    [...READ_ONLY_TOOL_NAMES].map((name) => [name, fileTools.executors[name]]),
  );

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
