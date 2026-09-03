#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createOpenAIProvider,
  createFileTranscriptStore,
  runToolLoop,
} from "../src/index.js";
import { createRecallTool } from "../src/tools/index.js";
import { buildCompactionContext, loadCliConfig } from "./config.js";
import {
  closeAllMcpServers,
  createMcpProxyTool,
  loadMcpConfig,
} from "./mcp.js";
import { defaultSessionId, runRepl } from "./repl.js";
import { buildSkillTools, discoverSkills, loadAllSkills } from "./skills.js";
import {
  CLI_TOOLS_SYSTEM_PROMPT,
  createCliTools,
  wrapExecuteTool,
} from "./tools.js";

const DEFAULT_MAX_ROUNDS = 64;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

const HELP_TEXT = `用法：
  erix --version, -v
  erix --help, -h
  erix chat "<prompt>" [--stream] [--reflection <on|off>] [--timeout <ms>] [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>]
  erix repl [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>]  （交互式模式）
  erix skills [--skills-dir <path>]  列出已发现的技能
  erix mcp [--config <path>]       列出 MCP 配置和连接状态
  （无参数直接进入交互式模式，等同 erix repl）

  --stream              流式输出模型文本
  --session <id>        会话 ID（默认按工作目录自动派生）
  --dir <path>          Transcript 存档目录（chat 默认：~/.erix/transcripts）
  --max-rounds <n>      工具循环最大轮数（默认：64，可用 ERIX_MAX_ROUNDS 覆盖）
  --reflection <on|off> 是否启用反思驱动的自适应预算（默认：max-rounds >= 32 时启用）
  --timeout <毫秒>     任务时间预算（软预算：临近时引导收尾，非硬杀；默认不启用）
  --idle-timeout <秒>   无进展自动中止（chat 默认：300，repl 默认：0=不启用）

环境变量：
  LLM_KIT_ENDPOINT   OpenAI 兼容 API 地址（必填）
  LLM_KIT_API_KEY    API 密钥（必填）
  LLM_KIT_MODEL      模型名称（默认：kimi-for-coding）
  ERIX_EXEC_TIMEOUT_MS exec 前台命令超时毫秒数（默认：120000）
  ERIX_NO_TOOL_ROUNDS 模型连续无工具调用几轮后强制完成（默认：3，最小：1）
  ERIX_MAX_ROUNDS     工具循环最大轮数（默认：64，最小：1）
  ERIX_REFLECTION     反思开关（on/off；ERIX_NO_REFLECTION=1 强制关闭）

配置文件：
  默认读取 $XDG_CONFIG_HOME/erix/config.json 或 ~/.erix/config.json，可用 --config <path> 指定；环境变量优先于配置文件。
  MCP 配置默认读取当前目录 .mcp.json 或 ~/.erix/mcp.json。
  slots.default.maxOutputTokens 可设置输出 token 上限（默认：16384）。
  slots.default.contextWindowTokens 可启用自动压缩（超预算自动折叠早期轮次）；--compact-budget <值> 可覆盖自动预算。`;

const MCP_HELP_TEXT = `用法：
  erix mcp [--config <path>]

列出 ~/.erix/mcp.json 或当前目录 .mcp.json 中配置的 MCP server 及连接状态。`;

class CliError extends Error {
  constructor(message, { showHelp = false } = {}) {
    super(message);
    this.name = "CliError";
    this.showHelp = showHelp;
  }
}

class IdleTimeoutError extends Error {
  constructor(seconds) {
    super(`任务 ${seconds} 秒无进展，已中止`);
    this.name = "IdleTimeoutError";
    this.code = "idle_timeout";
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

function parseReflectionOption(rawValue) {
  if (rawValue !== "on" && rawValue !== "off") {
    usageError("--reflection 必须是 on 或 off");
  }
  return rawValue === "on";
}

function resolveMaxRounds(maxRounds) {
  if (maxRounds !== undefined) return maxRounds;
  const raw = process.env.ERIX_MAX_ROUNDS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_ROUNDS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_ROUNDS;
}

function resolveReflection(reflection, maxRounds) {
  if (process.env.ERIX_NO_REFLECTION?.trim() === "1") return false;
  if (reflection !== undefined) {
    if (reflection === true) return { enabled: true };
    return reflection && typeof reflection === "object" ? reflection : false;
  }
  const raw = process.env.ERIX_REFLECTION?.trim().toLowerCase();
  if (raw === "on") return { enabled: true };
  if (raw === "off") return false;
  return maxRounds >= 32 ? { enabled: true } : false;
}

function createIdleTimeout(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const touch = () => {
    if (timedOut) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, seconds * 1000);
  };
  touch();
  return {
    controller,
    timedOut: () => timedOut,
    touch,
    dispose: () => clearTimeout(timer),
  };
}

export function parseChatArgs(args, cwd = process.cwd()) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { showHelp: true };
  }

  let prompt;
  const options = {
    idleTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
    session: defaultSessionId(cwd, { unique: true }),
    dir: join(homedir(), ".erix", "transcripts"),
  };
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
      || argument === "--session"
      || argument === "--dir"
      || argument === "--compact-budget"
      || argument === "--max-rounds"
      || argument === "--reflection"
      || argument === "--timeout"
      || argument === "--idle-timeout"
    ) {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);

      const rawValue = args[index + 1];
      if (rawValue === undefined || (
        (argument === "--config"
          || argument === "--skills-dir"
          || argument === "--session"
          || argument === "--dir"
          || argument === "--reflection")
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
      } else if (argument === "--session") {
        if (rawValue.trim() === "") usageError("--session 不能为空");
        options.session = rawValue;
      } else if (argument === "--dir") {
        if (rawValue.trim() === "") usageError("--dir 不能为空");
        options.dir = rawValue;
      } else if (argument === "--compact-budget") {
        options.compactBudget = parseIntegerOption(argument, rawValue, 0);
      } else if (argument === "--max-rounds") {
        options.maxRounds = parseIntegerOption(argument, rawValue, 1);
      } else if (argument === "--reflection") {
        options.reflection = parseReflectionOption(rawValue);
      } else if (argument === "--timeout") {
        options.timeoutMs = parseIntegerOption(argument, rawValue, 1);
      } else {
        options.idleTimeout = parseIntegerOption(argument, rawValue, 0);
      }
      continue;
    }

    if (argument.startsWith("--")) {
      usageError(`未知参数：${argument}`);
    }
    if (prompt === undefined) {
      prompt = argument;
    } else {
      prompt = `${prompt} ${argument}`;
    }
  }

  return { prompt, ...options };
}

function parseSkillsArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { showHelp: true };
  }

  const options = {};
  const seenOptions = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skills-dir") {
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
      continue;
    }
    if (argument.startsWith("--")) {
      usageError(`未知参数：${argument}`);
    }
    usageError(`未知参数：${argument}`);
  }
  return options;
}

function parseMcpArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { showHelp: true };
  }
  const options = {};
  const seenOptions = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        usageError(`${argument} 缺少数值`);
      }
      if (rawValue.trim() === "") usageError("--config 不能为空");
      options.configPath = rawValue;
      index += 1;
      continue;
    }
    usageError(`未知参数：${argument}`);
  }
  return options;
}

function combineTools(cliTools, skillTools, mcpProxy, recallTool) {
  const tools = [...cliTools.tools];
  if (recallTool !== undefined) {
    tools.push(recallTool.schema);
  }
  if (mcpProxy?.enabled) {
    tools.push(mcpProxy.schema);
  }
  const skillToolNames = new Set(skillTools.tools.map((tool) => tool.name));
  return {
    tools,
    executeTool: async (name, input, context) => {
      if (name === "mcp" && mcpProxy?.enabled) {
        return mcpProxy.execute(input);
      }
      if (name === "recall" && recallTool !== undefined) {
        return recallTool.execute(input);
      }
      if (skillToolNames.has(name)) {
        return skillTools.executeTool(name, input, context);
      }
      return cliTools.executeTool(name, input, context);
    },
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
    builtinNames: ["readFile", "rg", "tree", "writeFile", "exec", "mcp"],
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

async function runMcp({ configPath }) {
  let config;
  try {
    config = loadMcpConfig(configPath, process.cwd());
  } catch (error) {
    console.error(`错误：${error?.message ?? String(error)}`);
    process.exitCode = 1;
    return;
  }
  if (!config) {
    console.log("未找到 MCP 配置文件（~/.erix/mcp.json 或当前目录 .mcp.json）");
    return;
  }

  console.log("MCP server 配置：");
  const proxy = createMcpProxyTool({ mcpConfigPath: configPath, cwd: process.cwd() });
  if (!proxy.enabled) {
    console.log("  配置文件无效或没有可用的 server");
    return;
  }
  const status = proxy.status();
  for (const server of proxy.listConfiguredServers()) {
    const state = status[server] ?? "idle";
    console.log(`  - ${server}：${state}`);
  }
}

export async function runChat({
  prompt,
  configPath,
  skillsDir,
  compactBudget,
  maxRounds,
  reflection,
  timeoutMs,
  stream,
  completion,
  idleTimeout = DEFAULT_IDLE_TIMEOUT_SECONDS,
  session,
  sessionExplicit,
  dir = join(homedir(), ".erix", "transcripts"),
  provider: providerOverride,
  config: configOverride,
  toolOutput = console.log,
}) {
  const cwd = process.cwd();
  const runId = session ?? defaultSessionId(cwd, { unique: true });
  const explicitSession = sessionExplicit ?? session !== undefined;
  const config = configOverride ?? await loadCliConfig({ configPath });
  const maxTokens = config.maxOutputTokens;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new CliError("chat 需要提供 prompt，例如：erix chat \"你好\"");
  }

  const provider = providerOverride ?? createOpenAIProvider({
    ...config,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeout ?? 300_000,
    maxTokens,
  });
  const store = createFileTranscriptStore({ dir });
  const existingRecords = await store.load(runId);
  const resume = explicitSession && existingRecords.length > 0;
  if (resume) {
    const latestRound = Math.max(
      0,
      ...existingRecords.map((record) => (
        Number.isSafeInteger(record?.round) ? record.round : 0
      )),
    );
    const dedupKey = `${String(runId)}:input:${Date.now()}:${randomUUID()}`;
    await store.appendRound(runId, {
      round: latestRound,
      roundKey: dedupKey,
      dedupKey,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      ts: new Date().toISOString(),
    });
  }
  const recallTool = createRecallTool({ store, runId });
  const cliTools = createCliTools({ cwd });
  const skillTools = await buildSkillTools({
    cwd,
    skillsDir,
    builtinNames: [...cliTools.tools.map((tool) => tool.name), "mcp", "recall"],
  });
  const mcpProxy = createMcpProxyTool({ mcpConfigPath: configPath, cwd });
  const tools = combineTools(cliTools, skillTools, mcpProxy, recallTool);
  const context = buildCompactionContext(config, compactBudget);
  const idle = createIdleTimeout(idleTimeout);
  const executeTool = wrapExecuteTool(tools.executeTool, { output: toolOutput });
  const resolvedMaxRounds = resolveMaxRounds(maxRounds);

  let systemPrompt = `你是 erix 编码助手，工作目录 ${cwd}。${CLI_TOOLS_SYSTEM_PROMPT}`;
  if (mcpProxy?.enabled) {
    systemPrompt += `

MCP 代理工具 mcp 可用：action=list 列出所有 MCP 工具；action=search query=关键词 查找工具；action=call server=... tool=... args=... 调用工具。`;
  }

  const loopOptions = {
    ...(context ? { context } : {}),
    provider,
    system: systemPrompt,
    initialUserMessage: prompt,
    store,
    runId,
    resume,
    tools: tools.tools,
    executeTool: async (name, input, toolContext) => {
      const result = await executeTool(name, input, toolContext);
      idle?.touch();
      return result;
    },
    maxRounds: resolvedMaxRounds,
    reflection: resolveReflection(reflection, resolvedMaxRounds),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxTokens,
    completion: completion === false ? false : {
      signals: [
        "任务已完成",
        "已完成",
        "全部完成",
        "无需继续",
        "任务结束",
        "没有更多步骤",
        ...(Array.isArray(completion?.signals) ? completion.signals : []),
      ],
      // 模型连续 N 轮无工具调用才强制完成（默认 3）；
      // 之前写死 1 导致模型思考一轮没动手就被判定完成（benchmark 实测 9 个任务过早放弃）
      maxNoToolRounds: (() => {
        if (Number.isSafeInteger(completion?.maxNoToolRounds)
          && completion.maxNoToolRounds > 0) {
          return completion.maxNoToolRounds;
        }
        const raw = process.env.ERIX_NO_TOOL_ROUNDS?.trim();
        if (raw === undefined || raw === "") return 3;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value > 0 ? value : 3;
      })(),
    },
    stream,
    signal: idle?.controller.signal,
    onDelta: stream
      ? (chunk) => {
        idle?.touch();
        process.stdout.write(chunk);
      }
      : undefined,
    onToolResult: (_name, result) => {
      idle?.touch();
      return cliTools.truncateResult(result);
    },
    onRound: (info) => {
      idle?.touch();
      console.log(`[round ${info.round}]${info.folded ? "（含折叠）" : ""}`);
    },
  };

  try {
    const result = await runToolLoop(loopOptions);
    const compacted = result.compactionStats.some((stat) => stat.compacted === true);
    console.log(`\n=== 终稿 ===\n${result.finalText}`);
    console.log(
      `\n=== 统计 === model=${config.model} rounds=${result.rounds} truncated=${result.truncated} usage=${JSON.stringify(result.usage)} compacted=${compacted}`,
    );
    return result;
  } catch (error) {
    if (idle?.timedOut()) throw new IdleTimeoutError(idleTimeout);
    throw error;
  } finally {
    idle?.dispose();
  }
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
    if (skillsArgs.showHelp) {
      printHelp();
      return;
    }
    await runSkills(skillsArgs);
    return;
  }
  if (command === "mcp") {
    const mcpArgs = parseMcpArgs(args.slice(1));
    if (mcpArgs.showHelp) {
      console.log(MCP_HELP_TEXT);
      return;
    }
    await runMcp(mcpArgs);
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
  await runChat({
    ...chatArgs,
    sessionExplicit: args.slice(1).includes("--session"),
  });
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
    if (error?.code === "idle_timeout") {
      console.error(error.message);
    } else {
      console.error(`错误：${error?.message ?? String(error)}`);
    }
    if (error?.showHelp) console.error(`\n${HELP_TEXT}`);
    process.exitCode = 1;
  } finally {
    await closeAllMcpServers();
  }
}
