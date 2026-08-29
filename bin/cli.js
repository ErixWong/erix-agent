#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createOpenAIProvider,
  runToolLoop,
} from "../src/index.js";
import { buildCompactionContext, loadCliConfig } from "./config.js";
import { runRepl } from "./repl.js";
import { buildSkillTools, discoverSkills, loadAllSkills } from "./skills.js";
import {
  CLI_TOOLS_SYSTEM_PROMPT,
  createCliTools,
  wrapExecuteTool,
} from "./tools.js";

const DEFAULT_MAX_ROUNDS = 16;

const HELP_TEXT = `用法：
  erix --version, -v
  erix --help, -h
  erix chat "<prompt>" [--stream] [--config <path>] [--skills-dir <path>] [--compact-budget <tokens>] [--max-rounds <n>]
  erix repl [--config <path>] [--skills-dir <path>] [--session <id>] [--compact-budget <tokens>] [--max-rounds <n>]  （交互式模式）
  erix skills [--skills-dir <path>]  列出已发现的技能
  （无参数直接进入交互式模式，等同 erix repl）

  --stream              流式输出模型文本
  --session <id>        REPL 会话 ID（默认按工作目录自动派生）
  --max-rounds <n>      工具循环最大轮数（默认：16）

环境变量：
  LLM_KIT_ENDPOINT   OpenAI 兼容 API 地址（必填）
  LLM_KIT_API_KEY    API 密钥（必填）
  LLM_KIT_MODEL      模型名称（默认：kimi-for-coding）
  ERIX_EXEC_TIMEOUT_MS exec 前台命令超时毫秒数（默认：120000）

配置文件：
  默认读取 $XDG_CONFIG_HOME/erix/config.json 或 ~/.erix/config.json，可用 --config <path> 指定；环境变量优先于配置文件。
  slots.default.maxOutputTokens 可设置输出 token 上限（默认：16384）。
 slots.default.contextWindowTokens 可启用自动压缩（超预算自动折叠早期轮次）；--compact-budget <值> 可覆盖自动预算。`;

class CliError extends Error {
  constructor(message, { showHelp = false } = {}) {
    super(message);
    this.name = "CliError";
    this.showHelp = showHelp;
  }
}

function printHelp() {
  console.log(HELP_TEXT);
}

function usageError(message) {
  throw new CliError(message, { showHelp: true });
}

function readVersion() {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  return packageJson.version;
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

function parseChatArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { showHelp: true };
  }

  let prompt;
  const options = {};
  const seenOptions = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stream") {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);
      options.stream = true;
      continue;
    }
    if (
      argument === "--config"
      || argument === "--skills-dir"
      || argument === "--compact-budget"
      || argument === "--max-rounds"
    ) {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);

      const rawValue = args[index + 1];
      if (rawValue === undefined || (
        (argument === "--config" || argument === "--skills-dir")
        && rawValue.startsWith("--")
      )) {
        usageError(`${argument} 缺少数值`);
      }
      index += 1;

      if (argument === "--config") {
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

    if (argument.startsWith("-")) {
      usageError(`未知参数：${argument}`);
    }
    if (prompt !== undefined) {
      usageError(`只能提供一个 prompt，收到多余参数：${argument}`);
    }
    prompt = argument;
  }

  return { prompt, ...options };
}

function parseSkillsArgs(args) {
  const options = {};
  const seenOptions = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--skills-dir") {
      usageError(`未知参数：${argument}`);
    }
    if (seenOptions.has(argument)) {
      usageError(`参数重复：${argument}`);
    }
    seenOptions.add(argument);
    const rawValue = args[index + 1];
    if (rawValue === undefined || rawValue.startsWith("--")) {
      usageError(`${argument} 缺少数值`);
    }
    if (rawValue.trim() === "") usageError("--skills-dir 不能为空");
    options.skillsDir = rawValue;
    index += 1;
  }
  return options;
}

function combineTools(cliTools, skillTools) {
  const skillToolNames = new Set(skillTools.tools.map((tool) => tool.name));
  return {
    tools: [...cliTools.tools, ...skillTools.tools],
    executeTool: (name, input, context) => (
      skillToolNames.has(name)
        ? skillTools.executeTool(name, input, context)
        : cliTools.executeTool(name, input, context)
    ),
  };
}

function skillDirectoryLabels(skillsDir) {
  if (skillsDir !== undefined) {
    return [path.resolve(process.cwd(), skillsDir)];
  }
  return [
    path.join(homedir(), ".erix", "skills"),
    path.join(process.cwd(), ".erix", "skills"),
  ];
}

async function runSkills({ skillsDir }) {
  const options = { cwd: process.cwd(), skillsDir };
  const discovered = discoverSkills(options);
  const loaded = await loadAllSkills(options);
  const built = await buildSkillTools({
    ...options,
    builtinNames: ["readFile", "rg", "tree", "writeFile", "exec"],
  });
  const errorsByDir = new Map(built.errors.map((item) => [item.dir, item]));
  const skillsByDir = new Map(loaded.skills.map((skill) => [skill.dir, skill]));

  console.log("技能目录：");
  for (const directory of skillDirectoryLabels(skillsDir)) {
    console.log(`  - ${directory}`);
  }
  console.log("发现的 skill：");
  if (discovered.length === 0) {
    console.log("  （无）");
  } else {
    for (const candidate of discovered) {
      const skill = skillsByDir.get(candidate.dir);
      const error = errorsByDir.get(candidate.dir);
      if (error) {
        console.log(`  - ${candidate.id}（${candidate.dir}）：加载失败`);
      } else {
        console.log(
          `  - ${skill.skillId}（${candidate.dir}）：工具 ${skill.tools.length}`,
        );
      }
    }
  }

  console.log("errors：");
  if (built.errors.length === 0) {
    console.log("  （无）");
  } else {
    for (const item of built.errors) {
      console.log(`  - ${item.skillId}（${item.dir}）：${item.error}`);
    }
  }
}

async function runChat({
  prompt,
  configPath,
  skillsDir,
  compactBudget,
  maxRounds,
  stream,
}) {
  const config = await loadCliConfig({ configPath });
  const maxTokens = config.maxOutputTokens;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new CliError("chat 需要提供 prompt，例如：erix chat \"你好\"");
  }

  const provider = createOpenAIProvider({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: 120_000,
    maxTokens,
  });
  const cliTools = createCliTools({ cwd: process.cwd() });
  const skillTools = await buildSkillTools({
    cwd: process.cwd(),
    skillsDir,
    builtinNames: cliTools.tools.map((tool) => tool.name),
  });
  const tools = combineTools(cliTools, skillTools);
  const context = buildCompactionContext(config, compactBudget);
  const loopOptions = {
    ...(context ? { context } : {}),
    provider,
    system: `你是 erix-llm-kit 的对话循环引擎演示。${CLI_TOOLS_SYSTEM_PROMPT}任务完成或已无需更多工具时，直接输出最终答复，不要空转。`,
    initialUserMessage: prompt,
    tools: tools.tools,
    executeTool: wrapExecuteTool(tools.executeTool),
    maxRounds: maxRounds ?? DEFAULT_MAX_ROUNDS,
    maxTokens,
    completion: { maxNoToolRounds: 1 },
    stream,
    onDelta: stream ? (chunk) => process.stdout.write(chunk) : undefined,
    onToolResult: (_name, result) => cliTools.truncateResult(result),
    onRound: (info) => console.log(
      `[round ${info.round}]${info.folded ? "（含折叠）" : ""}`,
    ),
  };

  const result = await runToolLoop(loopOptions);
  const compacted = result.compactionStats.some((stat) => stat.compacted === true);
  console.log(`\n=== 终稿 ===\n${result.finalText}`);
  console.log(
    `\n=== 统计 === model=${config.model} rounds=${result.rounds} truncated=${result.truncated} usage=${JSON.stringify(result.usage)} compacted=${compacted}`,
  );
}

async function main(args) {
  if (args.length === 0) {
    await runRepl([]);
    return;
  }

  const command = args[0];
  if (command === "--version" || command === "-v") {
    if (args.length !== 1) usageError(`未知参数：${args[1]}`);
    console.log(readVersion());
    return;
  }
  if (command === "--help" || command === "-h") {
    if (args.length !== 1) usageError(`未知参数：${args[1]}`);
    printHelp();
    return;
  }
  if (command === "repl") {
    await runRepl(args.slice(1));
    return;
  }
  if (command === "skills") {
    const skillsArgs = parseSkillsArgs(args.slice(1));
    await runSkills(skillsArgs);
    return;
  }
  if (command !== "chat") {
    usageError(`未知子命令：${command}`);
  }

  const chatArgs = parseChatArgs(args.slice(1));
  if (chatArgs.showHelp) {
    printHelp();
    return;
  }
  await runChat(chatArgs);
}

if (
  import.meta.url === `file://${process.argv[1]}`
  || (
    process.argv[1] !== undefined
    && existsSync(process.argv[1])
    && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  )
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`错误：${error?.message ?? String(error)}`);
    if (error?.showHelp) console.error(`\n${HELP_TEXT}`);
    process.exitCode = 1;
  }
}
