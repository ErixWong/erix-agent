#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_REFLECTION_MIN_ROUNDS,
  createBuiltinNotesTools,
  createOpenAIProvider,
  resolveNotesDir,
  runToolLoop,
} from "../src/index.js";
import { createCliAssemblyRoot } from "./assembly-root.js";
import { buildCompactionContext, loadCliConfig } from "./config.js";
import {
  closeAllMcpServers,
  createMcpProxyTool,
  loadMcpConfig,
} from "./mcp.js";
import { defaultSessionId, runRepl } from "./repl.js";
import {
  buildCaptureRecoveryHint,
  buildCaptureStub,
  createFinalGuard,
} from "./final-guard.js";
import {
  buildSkillTools,
  discoverSkills,
  loadAllSkills,
  warnBuiltinToolConflicts,
} from "./skills.js";
import {
  buildArchiveNotice,
  buildCliToolsSystemPrompt,
  createCliTools,
  filterToolsByAllowlist,
  wrapExecuteTool,
} from "./tools.js";
import { formatGuardMetrics } from "./guard-metrics.js";

const DEFAULT_MAX_ROUNDS = 64;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

const HELP_TEXT = `用法：
  erix --version, -v
  erix --help, -h
  erix chat "<prompt>" [--stream] [--reflection <on|off>] [--final-guard|--no-final-guard] [--no-notes] [--no-todo] [--timeout <ms>] [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--judge-log <path>] [--error-log <path>] [--tools <逗号分隔工具名>]
  erix repl [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--final-guard|--no-final-guard] [--tools <逗号分隔工具名>]  （交互式模式）
  erix skills [--skills-dir <path>]  列出已发现的技能
  erix mcp [--config <path>]       列出 MCP 配置和连接状态
  （无参数直接进入交互式模式，等同 erix repl）

  --stream              流式输出模型文本
  --session <id>        会话 ID（默认按工作目录自动派生）
  --dir <path>          Transcript 存档目录（chat 默认：~/.erix/transcripts）
  --max-rounds <n>      工具循环最大轮数（默认：64，可用 ERIX_MAX_ROUNDS 覆盖）
  --reflection <on|off> 是否启用反思驱动的自适应预算（默认：max-rounds >= 16 时启用，见 DEFAULT_REFLECTION_MIN_ROUNDS）
  --final-guard         开启终稿 provenance 核验（默认关闭）
  --no-final-guard      兼容别名（默认已关闭，no-op）
  --no-notes            不装配 notes 工厂（note_* 工具不再可用），保留其他 skill
  --no-todo             彻底关闭 todo：内置 todo_* 四工具不注册、系统提示不含 todo、用户级 todo skill 一并排除
  --timeout <毫秒>     任务时间预算（软预算：临近时引导收尾，非硬杀；默认不启用）
  --idle-timeout <秒>   无进展自动中止（chat 默认：300，repl 默认：0=不启用）
  --judge-log <path>   将 round/intercept judge 决策追加写入 JSONL（默认：<归档目录>/judge.log）
  --error-log <path>   将持久化错误事件追加写入 JSONL（默认仅 stderr；也可用 ERIX_ERROR_LOG）
  --tools <名1,名2>    工具白名单：只保留列表内的工具（内置+skill+MCP）；未知名字警告并忽略，过滤后为空则报错

环境变量：
  LLM_KIT_ENDPOINT   OpenAI 兼容 API 地址（必填）
  LLM_KIT_API_KEY    API 密钥（必填）
  LLM_KIT_MODEL      模型名称（必填，除非配置文件或 ERIX_DEFAULT_MODEL 已提供）
  ERIX_DEFAULT_MODEL 无配置模型时使用的显式默认模型（可选）
  ERIX_EXEC_TIMEOUT_MS exec 前台命令超时毫秒数（默认：120000）
  ERIX_NO_TOOL_ROUNDS 模型连续无工具调用几轮后强制完成（默认：3，最小：1）
  ERIX_MAX_ROUNDS     工具循环最大轮数（默认：64，最小：1）
  ERIX_REFLECTION     反思开关（on/off；ERIX_NO_REFLECTION=1 强制关闭）
  ERIX_JUDGE_INTERVAL  intercept judge 审计间隔（每 N 次工具执行审计一次，默认 10）
  ERIX_STALL_MODE      停滞检测模式（appear/consecutive，默认 consecutive；appear=窗口内出现过同一调用即判停滞）
  ERIX_TOOL_RESULT_TTL 工具结果 TTL 折叠存活轮数（默认：2，0=关闭；slot 配置 cacheCapable:true 时默认关闭（0），环境变量显式设置优先。⚠️ 实测不推荐 cacheCapable:TTL=0 在 cache 端点有效成本 +53%（issue #44），保留仅为兼容/观测）
  ERIX_TOOL_RESULT_FOLD_MIN_TOKENS 低于此体积（估算 tokens）的工具结果永不折叠（默认：4000）
  ERIX_FINAL_GUARD=1   开启终稿 provenance 核验
  ERIX_NO_NOTES=1       不装配 notes 工厂（note_* 工具不再可用），保留其他 skill
  ERIX_NO_TODO=1        彻底关闭 todo（同 --no-todo），chat/repl 均生效
  ERIX_JUDGE_LOG      judge 决策 JSONL 路径（默认已写入 run 归档目录，无需设置）

配置文件：
  默认读取 $XDG_CONFIG_HOME/erix/config.json 或 ~/.erix/config.json，可用 --config <path> 指定；环境变量优先于配置文件。
  MCP 配置默认读取当前目录 .mcp.json 或 ~/.erix/mcp.json。
  slots.default.maxOutputTokens 可设置输出 token 上限（默认：16384）。
  slots.default.contextWindowTokens 可启用自动压缩（超预算自动折叠早期轮次）；--compact-budget <值> 可覆盖自动预算。

退出码：
  0  成功（开了 --final-guard 时为 verified）
  2  终稿核验未通过（unverified）
  3  核验过程出错（error）
  4  核验未执行（skipped：没有归档输出或归档里无可核验值）`;

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

// 工具结果 TTL 折叠（issue #35/#44）：环境变量显式设置优先，否则读取 slot 能力声明。
export function resolveToolResultTtl(config = {}) {
  const raw = process.env.ERIX_TOOL_RESULT_TTL?.trim();
  if (raw === undefined || raw === "") {
    return config?.cacheCapable === true ? 0 : undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resolveToolResultFoldMinTokens() {
  const raw = process.env.ERIX_TOOL_RESULT_FOLD_MIN_TOKENS?.trim();
  if (raw === undefined || raw === "") return undefined; // 用引擎默认
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function resolveReflection(reflection, maxRounds) {
  if (process.env.ERIX_NO_REFLECTION?.trim() === "1") return false;
  if (reflection !== undefined) {
    if (reflection === true) return { enabled: true };
    return reflection && typeof reflection === "object" ? reflection : false;
  }
  const raw = process.env.ERIX_REFLECTION?.trim().toLowerCase();
  if (raw === "on") return { enabled: true };
  if (raw === "off") return false;
  return maxRounds >= DEFAULT_REFLECTION_MIN_ROUNDS ? { enabled: true } : false;
}

function resolveFinalGuard(
  finalGuard,
  runId,
  archiveDir,
  notesDir,
  notesStore,
  store,
) {
  if (typeof finalGuard === "function") return finalGuard;
  if (
    finalGuard !== true
    && process.env.ERIX_FINAL_GUARD?.trim() !== "1"
  ) return undefined;
  return createFinalGuard({
    runId,
    archiveDir,
    notesDir,
    notesStore,
    store,
  });
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
    if (argument === "--final-guard" || argument === "--no-final-guard") {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);
      options.finalGuard = argument === "--final-guard";
      continue;
    }
    if (argument === "--no-notes") {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);
      options.noNotes = true;
      continue;
    }
    if (argument === "--no-todo") {
      if (seenOptions.has(argument)) {
        usageError(`参数重复：${argument}`);
      }
      seenOptions.add(argument);
      options.noTodo = true;
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
      || argument === "--judge-log"
      || argument === "--error-log"
      || argument === "--tools"
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
          || argument === "--reflection"
          || argument === "--judge-log"
          || argument === "--error-log"
          || argument === "--tools")
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
      } else if (argument === "--judge-log") {
        if (rawValue.trim() === "") usageError("--judge-log 不能为空");
        options.judgeLog = rawValue;
      } else if (argument === "--error-log") {
        if (rawValue.trim() === "") usageError("--error-log 不能为空");
        options.errorLog = rawValue;
      } else if (argument === "--tools") {
        if (rawValue.trim() === "") usageError("--tools 不能为空");
        options.tools = rawValue;
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

function combineTools(cliTools, skillTools, mcpProxy, notesAssembler) {
  const tools = [
    ...cliTools.tools,
    ...skillTools.tools,
    ...(notesAssembler?.definitions ?? []),
  ];
  if (mcpProxy?.enabled) {
    tools.push(mcpProxy.schema);
  }
  const skillToolNames = new Set(skillTools.tools.map((tool) => tool.name));
  const notesToolNames = new Set(notesAssembler?.definitions.map((tool) => tool.name) ?? []);
  return {
    tools,
    executeTool: async (name, input, context) => {
      if (name === "mcp" && mcpProxy?.enabled) {
        return mcpProxy.execute(input);
      }
      if (skillToolNames.has(name)) {
        return skillTools.executeTool(name, input, context);
      }
      if (notesToolNames.has(name)) {
        return notesAssembler.executors(name, input, context);
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
  if (proxy.error) {
    console.error(`错误：MCP 配置损坏：${proxy.error?.message ?? String(proxy.error)}`);
    process.exitCode = 1;
    return;
  }
  if (!proxy.enabled) {
    console.log("  MCP 配置中没有可用的 server");
    return;
  }
  const status = proxy.status();
  for (const server of proxy.listConfiguredServers()) {
    const state = status[server] ?? "idle";
    console.log(`  - ${server}：${state}`);
  }
}

export async function runChat(options = {}) {
  const runId = options.session ?? defaultSessionId(process.cwd(), { unique: true });
  const notesDir = resolveNotesDir(options.notesDir);
  // Notes scope is explicit throughout the CLI path; avoid mutating process
  // globals so concurrent runChat calls cannot restore each other's env.
  return runChatWithNotes({
    ...options,
    _notesRunId: runId,
    _notesDir: notesDir,
    _notesStore: options.notesStore,
  });
}

async function runChatWithNotes({
  prompt,
  configPath,
  skillsDir,
  compactBudget,
  maxRounds,
  reflection,
  finalGuard,
  finalGuardMaxRetries = 2,
  timeoutMs,
  stream,
  completion,
  idleTimeout = DEFAULT_IDLE_TIMEOUT_SECONDS,
  session,
  sessionExplicit,
  dir = join(homedir(), ".erix", "transcripts"),
  judgeLog,
  errorLog,
  tools: toolsAllowlist,
  noNotes = false,
  noTodo = false,
  provider: providerOverride,
  config: configOverride,
  toolOutput = console.log,
  loop: loopOverride,
  _notesRunId,
  _notesDir,
  _notesStore,
  _assemblyRoot,
}) {
  const cwd = process.cwd();
  const runId = _notesRunId ?? session ?? defaultSessionId(cwd, { unique: true });
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
  const assemblyRoot = _assemblyRoot ?? createCliAssemblyRoot({
    dir,
    runId,
    notesDir: _notesDir,
    notesStore: _notesStore,
    errorLog: errorLog ?? process.env.ERIX_ERROR_LOG,
  });
  const {
    archiveDir,
    diagnostics,
    notesDir,
    notesStore,
    store,
  } = assemblyRoot;
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
  // issue #69：--no-todo / ERIX_NO_TODO=1 —— 彻底关：内置 todo 四工具不注册、
  // 系统提示不再含 todo、用户级 todo skill 经 excludeSkillIds 一并排除。
  const todoDisabled = noTodo === true || process.env.ERIX_NO_TODO?.trim() === "1";
  const cliTools = createCliTools({ cwd, todo: !todoDisabled });
  const notesDisabled = noNotes === true || process.env.ERIX_NO_NOTES?.trim() === "1";
  // 用户级 notes skill 经 excludeSkillIds 排除：notes 装配统一走工厂，否则会出现两套同名 note_* 工具
  // （bundled notes skill 已于 v0.11.0 退役，见 issue #61）。
  // todo 关闭时用户级 todo skill 同样经 excludeSkillIds 排除（内置实现与 skill 不同名共存会双份）。
  const skillTools = await buildSkillTools({
    cwd,
    skillsDir,
    excludeSkillIds: ["notes", ...(todoDisabled ? ["todo"] : [])],
    builtinNames: [...cliTools.tools.map((tool) => tool.name), "mcp", "note_take", "note_read", "note_list", "note_forget"],
  });
  // 同名 skill 工具冲突：内置实现优先，skill 版本被忽略，此处一次性告警（issue #65）。
  warnBuiltinToolConflicts(skillTools.errors);
  // --no-notes / ERIX_NO_NOTES：不装配工厂（用户级 notes skill 仍经 excludeSkillIds 排除，对外行为等价）。
  const notesAssembler = notesDisabled || !notesStore
    ? undefined
    : createBuiltinNotesTools({ runId, notesDir, notesStore });
  await notesAssembler?.lifecycle.onRunStart();
  const mcpProxy = createMcpProxyTool({ mcpConfigPath: configPath, cwd });
  const combinedTools = combineTools(cliTools, skillTools, mcpProxy, notesAssembler);
  // --tools 白名单：未知名字 stderr 警告并忽略；过滤后为空 → usageError
  let tools;
  try {
    tools = {
      ...combinedTools,
      tools: filterToolsByAllowlist(combinedTools.tools, toolsAllowlist, {
        onUnknown: (message) => console.error(message),
      }),
    };
  } catch (error) {
    usageError(error?.message ?? String(error));
  }
  const baseContext = buildCompactionContext(
    config,
    compactBudget,
    compactBudget !== undefined || config.contextWindowTokens
      ? ({ foldedPayload }) => buildCaptureRecoveryHint({
        archiveDir,
        foldedPayload,
        store,
        runId,
      })
      : undefined,
    ({ content }) => buildCaptureStub({ content }),
  );
  const context = baseContext;
  const idle = createIdleTimeout(idleTimeout);
  const executeTool = wrapExecuteTool(tools.executeTool, {
    output: toolOutput,
    getToolMetadata: cliTools.getLastToolMetadata,
    returnMetadata: true,
  });
  const resolvedMaxRounds = resolveMaxRounds(maxRounds);
  const resolvedFinalGuard = resolveFinalGuard(
    finalGuard,
    runId,
    archiveDir,
    notesDir,
    notesStore,
    store,
  );
  // judge 决策日志默认跟随 run 归档（与工具捕获同目录）；--judge-log / ERIX_JUDGE_LOG 可覆盖
  const judgeLogPath = judgeLog ?? process.env.ERIX_JUDGE_LOG ?? path.join(archiveDir, "judge.log");
  let judgeLogWriteFailed = false;
  // judge-log 为同信任域全量审计档案（与 run JSONL/工具捕获同目录，本就明文）：
  // 原始 info 原样落盘，不做脱敏——脱敏是 token hub 职责（ADR-009 信任模型）
  const onJudge = judgeLogPath
    ? (info) => {
      if (judgeLogWriteFailed) return;
      try {
        appendFileSync(
          judgeLogPath,
          `${JSON.stringify({ ts: new Date().toISOString(), ...info })}\n`,
          "utf8",
        );
      } catch (error) {
        judgeLogWriteFailed = true;
        console.error(`Judge log write failed: ${error?.message ?? String(error)}`);
      }
    }
    : undefined;

  let systemPrompt = `你是 erix 编码助手，工作目录 ${cwd}。${buildCliToolsSystemPrompt({ todo: !todoDisabled })}`;
  systemPrompt += buildArchiveNotice(archiveDir);
  if (mcpProxy?.enabled) {
    systemPrompt += `

MCP 代理工具 mcp 可用：action=list 列出所有 MCP 工具；action=search query=关键词 查找工具；action=call server=... tool=... args=... 调用工具。`;
  }
  // 2026-09-20 基准实测：模型直接闷头调工具、计划不可见导致 judge 难判方向——
  // 每轮先一句话声明计划再动手。
  systemPrompt += "\n\n每轮开始先用一句话（≤30字）说明当前计划，再调用工具。";

  const loopOptions = {
    ...(context ? { context } : {}),
    provider,
    system: systemPrompt,
    initialUserMessage: prompt,
    task: prompt,
    store,
    diagnostics,
    runId,
    resume,
    // ADR-015：notes 小抄目录经 semantic 槽位注入 run-state 块（折叠时注入，正好对准失忆点）
    ...(notesAssembler === undefined ? {} : {
      semanticStateProvider: notesAssembler.semanticStateProvider,
    }),
    tools: tools.tools,
    executeTool: async (execution) => {
      const result = await executeTool(execution);
      idle?.touch();
      return result;
    },
    maxRounds: resolvedMaxRounds,
    toolResultTtl: resolveToolResultTtl(config),
    toolResultFoldMinTokens: resolveToolResultFoldMinTokens(),
    reflection: resolveReflection(reflection, resolvedMaxRounds),
    ...(resolvedFinalGuard === undefined
      ? {}
      : {
          finalGuard: resolvedFinalGuard,
          finalGuardMaxRetries,
        }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxTokens,
    retry: {
      attempts: (() => {
        const raw = process.env.ERIX_RETRY_ATTEMPTS?.trim();
        if (raw === undefined || raw === "") return 2;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value >= 0 ? value : 2;
      })(),
    },
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
      // ADR-015 4a：截断/归档退役给引擎（outputHygiene），CLI 不再二次截断
      return result;
    },
    onRound: (info) => {
      idle?.touch();
      console.log(`[round ${info.round}]${info.folded ? "（含折叠）" : ""}`);
    },
    onJudge,
  };

  let loopResult;
  let thrown;
  try {
    const result = await (loopOverride ?? runToolLoop)(loopOptions);
    loopResult = result;
    const compacted = result.compactionStats.some((stat) => stat.compacted === true);
    const protectedDowngraded = result.compactionStats.reduce(
      (total, stat) => total + (Number.isSafeInteger(stat.protectedDowngraded)
        ? stat.protectedDowngraded
        : 0),
      0,
    );
    if (result.verification?.status === "unverified") {
      console.log(`\n=== 终稿（未核验，不可信） ===\n${result.finalText}`);
      console.log("⚠️ 该值未通过来源核验，不可信/需人工核验；本次运行不视为成功结果。");
    } else if (result.verification?.status === "error") {
      console.log(`\n=== 终稿（核验错误，不可信） ===\n${result.finalText}`);
    } else {
      const title = result.verification?.status === "verified"
        ? "=== 终稿（已核验） ==="
        : "=== 终稿 ===";
      console.log(`\n${title}\n${result.finalText}`);
    }
    if (result.verification?.status === "error") {
      console.log(`⚠️ 终稿来源核验${result.verification.reason === "timeout" ? "超时" : "失败"}，不得将其当作已验证事实。`);
    }
    if (protectedDowngraded > 0) {
      console.log(`⚠️ 压缩预算不足：已降级 ${protectedDowngraded} 条最旧 protected 消息；如需保留原文，请提高 compact budget 或减少保护集。`);
    }
    console.log(
      `\n=== 统计 === model=${config.model} rounds=${result.rounds} truncated=${result.truncated} termination=${result.termination?.reason ?? "unknown"} usage=${JSON.stringify(result.usage)} compacted=${compacted} ${formatGuardMetrics(result.verification)}`,
    );
    return result;
  } catch (error) {
    if (idle?.timedOut()) {
      thrown = new IdleTimeoutError(idleTimeout);
      throw thrown;
    }
    thrown = error;
    throw error;
  } finally {
    idle?.dispose();
    // #109 第2步/修正4：收尾失败进 completionErrors[]，不互覆盖、不掩盖主结果；
    // 主结果已异常时原异常仍为主，收尾错误仅 console 留痕（宿主可见）。
    const completionErrors = [];
    try {
      const notesCompletion = await notesAssembler?.lifecycle.onRunComplete();
      for (const failure of notesCompletion?.errors ?? []) {
        completionErrors.push(failure);
      }
    } catch (error) {
      completionErrors.push({ operation: "notes_lifecycle", error });
    }
    try {
      await closeAllMcpServers();
    } catch (error) {
      completionErrors.push({ operation: "mcp_close", error });
    }
    if (completionErrors.length > 0) {
      for (const failure of completionErrors) {
        console.error(`completion error (${failure.operation}): ${failure.error?.message ?? String(failure.error)}`);
      }
      const mapped = completionErrors.map((failure) => ({
        phase: "cli_completion",
        operation: failure.operation,
        error: {
          name: String(failure.error?.name ?? "Error"),
          message: String(failure.error?.message ?? failure.error).slice(0, 500),
        },
      }));
      // 主结果成功 → 挂在 result 上；主结果已异常 → 原异常仍是主，
      // 收尾失败挂到异常对象的 completionErrors（否则异常路径下收尾错误只剩 stderr）
      const carrier = loopResult && typeof loopResult === "object" ? loopResult : thrown;
      if (carrier && typeof carrier === "object") {
        carrier.completionErrors = [
          ...(Array.isArray(carrier.completionErrors) ? carrier.completionErrors : []),
          ...mapped,
        ];
      }
    }
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
  const result = await runChat({
    ...chatArgs,
    sessionExplicit: args.slice(1).includes("--session"),
  });
  const verificationExitCode = exitCodeForVerification(result?.verification);
  if (verificationExitCode !== 0) process.exitCode = verificationExitCode;
  return result;
}

export function exitCodeForVerification(verification) {
  if (verification?.status === "unverified") return 2;
  if (verification?.status === "error") return 3;
  // 核验没执行（没归档输出 / 归档里无可核验值）——不能与 verified 同为 0，
  // 否则调用方分不清"值核过了"和"根本没核"。
  if (verification?.status === "skipped") return 4;
  return 0;
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
