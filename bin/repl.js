import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  createFoldStatisticalStrategy,
  createOpenAIProvider,
  runToolLoop,
} from "../src/index.js";
import { loadCliConfig } from "./config.js";
import { buildSkillTools } from "./skills.js";
import { CLI_TOOLS_SYSTEM_PROMPT, createCliTools } from "./tools.js";

const DEFAULT_MODEL = "kimi-for-coding";
const DEFAULT_MAX_ROUNDS = 8;
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const NON_TTY_MESSAGE =
  'repl 需要交互式终端，单次对话请用：erix chat "<prompt>"';

const REPL_HELP_TEXT = `REPL 用法：
  erix repl [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>]

命令：
  /help                 显示此帮助
  /skills               显示当前技能
  /exit, /quit          保存并退出
  /clear                清屏（保留上下文）
  /reset                清空上下文并删除会话存档
  /tokens               显示累计 input/output tokens
  /model <name>         切换当前模型

环境变量：
  LLM_KIT_ENDPOINT      OpenAI 兼容 API 地址（必填）
  LLM_KIT_API_KEY       API 密钥（必填）
  LLM_KIT_MODEL         初始模型名称（默认：${DEFAULT_MODEL}）

配置文件：
  默认读取 $XDG_CONFIG_HOME/erix/config.json 或 ~/.erix/config.json，可用 --config <path> 指定；环境变量优先于配置文件。`;

class ReplUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplUsageError";
    this.showHelp = true;
  }
}

function usageError(message) {
  throw new ReplUsageError(message);
}

function parseIntegerOption(name, rawValue, minimum) {
  if (!/^\d+$/.test(rawValue)) {
    usageError(`${name} 必须是大于等于 ${minimum} 的整数`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum) {
    usageError(`${name} 必须是大于等于 ${minimum} 的整数`);
  }
  return value;
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usageError(`${option} 缺少数值`);
  }
  return value;
}

export function parseReplArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { showHelp: true };
  }

  const options = {
    session: "default",
    dir: join(homedir(), ".erix"),
  };
  const seenOptions = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === "--session"
      || argument === "--dir"
      || argument === "--config"
      || argument === "--skills-dir"
      || argument === "--compact-budget"
      || argument === "--max-rounds"
    ) {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);

      const rawValue = optionValue(args, index, argument);
      index += 1;
      if (argument === "--session") {
        if (rawValue.trim() === "") usageError("--session 不能为空");
        options.session = rawValue;
      } else if (argument === "--dir") {
        if (rawValue.trim() === "") usageError("--dir 不能为空");
        options.dir = rawValue;
      } else if (argument === "--config") {
        if (rawValue.trim() === "") usageError("--config 不能为空");
        options.configPath = rawValue;
      } else if (argument === "--skills-dir") {
        if (rawValue.trim() === "") usageError("--skills-dir 不能为空");
        options.skillsDir = rawValue;
      } else if (argument === "--compact-budget") {
        options.compactBudget = parseIntegerOption(argument, rawValue, 0);
      } else {
        options.maxRounds = parseIntegerOption(argument, rawValue, 1);
      }
      continue;
    }

    usageError(`未知参数：${argument}`);
  }

  return options;
}

export function parseCommand(line) {
  const text = String(line ?? "");
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { command: null, args: [], text };
  }

  const tokens = trimmed.slice(1).split(/\s+/);
  const name = tokens.shift()?.toLowerCase() ?? "";
  const args = tokens;
  if (name === "help" || name === "skills" || name === "clear" || name === "reset" || name === "tokens") {
    return { command: name, args };
  }
  if (name === "exit" || name === "quit") {
    return { command: "exit", args };
  }
  if (name === "model") {
    return { command: "model", args };
  }
  return { command: "unknown", name, args };
}

export function sessionPath(dir, session) {
  return join(String(dir), `${String(session)}.json`);
}

export async function loadSession(dir, session) {
  const path = sessionPath(dir, session);
  try {
    const content = await readFile(path, "utf8");
    const messages = JSON.parse(content);
    if (!Array.isArray(messages)) {
      throw new TypeError(`会话存档格式无效：${path}`);
    }
    return messages;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function saveSession(dir, session, messages) {
  if (!Array.isArray(messages)) {
    throw new TypeError("messages 必须是数组");
  }
  const path = sessionPath(dir, session);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(messages)}\n`, "utf8");
}

function writeLine(output, text = "") {
  output.write(`${text}\n`);
}

function printError(output, error) {
  writeLine(output, `${RED}错误：${error?.message ?? String(error)}${RESET}`);
}

async function deleteSession(dir, session) {
  try {
    await unlink(sessionPath(dir, session));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function clearReadlineLine(rl) {
  rl.write(null, { ctrl: true, name: "a" });
  rl.write(null, { ctrl: true, name: "k" });
}

function clearScreen(output) {
  if (output === process.stdout) {
    console.clear();
  } else {
    output.write("\x1b[2J\x1b[0f");
  }
}

export async function runRepl(argv, io = {}) {
  const options = parseReplArgs(argv);
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  if (options.showHelp) {
    writeLine(output, REPL_HELP_TEXT);
    return;
  }

  if (input.isTTY !== true) {
    writeLine(output, NON_TTY_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const config = await loadCliConfig({ configPath: options.configPath });
  const cliTools = createCliTools({ cwd: process.cwd() });
  const skillTools = await buildSkillTools({
    cwd: process.cwd(),
    skillsDir: options.skillsDir,
    builtinNames: cliTools.tools.map((tool) => tool.name),
  });
  const skillToolNames = new Set(skillTools.tools.map((tool) => tool.name));
  const executeTool = (name, input, context) => (
    skillToolNames.has(name)
      ? skillTools.executeTool(name, input, context)
      : cliTools.executeTool(name, input, context)
  );
  const archivePath = sessionPath(options.dir, options.session);
  let messages = await loadSession(options.dir, options.session);
  let model = config.model;
  let usage = { input_tokens: 0, output_tokens: 0 };

  if (existsSync(archivePath)) {
    writeLine(output, `已恢复会话 ${options.session}（${messages.length} 条消息）`);
  }

  const rl = createInterface({
    input,
    output,
    prompt: `${GREEN}erix> ${RESET}`,
    terminal: true,
  });

  let processing = Promise.resolve();
  let closeHandled = false;
  let resolveRun;
  let rejectRun;
  const completed = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const handleSigint = () => {
    if (rl.closed) return;
    if (rl.line.length > 0) {
      clearReadlineLine(rl);
      rl.prompt();
      return;
    }
    rl.close();
  };

  const saveAndFinish = async () => {
    await saveSession(options.dir, options.session, messages);
    writeLine(output, `再见（会话已保存到 ${archivePath}）`);
    resolveRun();
  };

  rl.on("close", () => {
    if (closeHandled) return;
    closeHandled = true;
    process.off("SIGINT", handleSigint);
    processing.then(saveAndFinish).catch(rejectRun);
  });

  rl.on("SIGINT", handleSigint);
  process.on("SIGINT", handleSigint);

  const handleCommand = async (command) => {
    if (command.command === "help") {
      writeLine(output, REPL_HELP_TEXT);
      return;
    }
    if (command.command === "skills") {
      if (skillTools.tools.length === 0) {
        writeLine(output, "当前未加载 skill 工具");
      } else {
        writeLine(output, "当前已加载 skill 工具：");
        for (const tool of skillTools.tools) {
          writeLine(output, `  - ${tool.name}`);
        }
      }
      if (skillTools.errors.length === 0) {
        writeLine(output, "技能加载错误：无");
      } else {
        writeLine(output, "技能加载错误：");
        for (const item of skillTools.errors) {
          writeLine(output, `  - ${item.skillId}（${item.dir}）：${item.error}`);
        }
      }
      return;
    }
    if (command.command === "exit") {
      rl.close();
      return;
    }
    if (command.command === "clear") {
      clearScreen(output);
      return;
    }
    if (command.command === "reset") {
      await deleteSession(options.dir, options.session);
      messages = [];
      usage = { input_tokens: 0, output_tokens: 0 };
      writeLine(output, "已开始新会话");
      return;
    }
    if (command.command === "tokens") {
      writeLine(output, `累计 usage=${JSON.stringify(usage)}`);
      return;
    }
    if (command.command === "model") {
      const nextModel = command.args.join(" ").trim();
      if (!nextModel) {
        writeLine(output, "用法：/model <名>");
        return;
      }
      model = nextModel;
      writeLine(output, `当前模型：${model}`);
      return;
    }
    writeLine(output, `未知命令：/${command.name}，输入 /help 查看命令列表`);
  };

  const handleInput = async (rawLine) => {
    const line = rawLine.trim();
    if (line.startsWith("/")) {
      await handleCommand(parseCommand(line));
    } else if (line.length > 0) {
      const provider = createOpenAIProvider({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        model,
        timeoutMs: 120_000,
      });
      const roundMessages = [
        ...messages,
        { role: "user", content: [{ type: "text", text: line }] },
      ];
      const loopOptions = {
        provider,
        system: `你是 erix-llm-kit 的交互式 REPL 助手。${CLI_TOOLS_SYSTEM_PROMPT}`,
        initialMessages: roundMessages,
        initialUserMessage: line,
        maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
        tools: [...cliTools.tools, ...skillTools.tools],
        executeTool,
        onToolResult: (_name, result) => cliTools.truncateResult(result),
        onRound: (info) => writeLine(output, `[round ${info.round}]`),
      };
      if (options.compactBudget !== undefined) {
        loopOptions.context = {
          strategy: createFoldStatisticalStrategy(),
          budgetTokens: options.compactBudget,
        };
      }

      const result = await runToolLoop(loopOptions);
      messages = result.messages;
      usage.input_tokens += Number.isFinite(result.usage?.input_tokens)
        ? result.usage.input_tokens
        : 0;
      usage.output_tokens += Number.isFinite(result.usage?.output_tokens)
        ? result.usage.output_tokens
        : 0;
      const compacted = result.compactionStats.some((stat) => stat.compacted === true);
      writeLine(output, result.finalText);
      writeLine(
        output,
        `[rounds=${result.rounds} usage=${JSON.stringify(result.usage)} compacted=${compacted}]`,
      );
      await saveSession(options.dir, options.session, messages);
    }

    if (!rl.closed) rl.prompt();
  };

  rl.on("line", (line) => {
    processing = processing
      .then(() => handleInput(line))
      .catch((error) => {
        printError(output, error);
        if (!rl.closed) rl.prompt();
      });
  });

  rl.prompt();
  return completed;
}
