#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_REFLECTION_MIN_ROUNDS,
  BUILTIN_COMPACTION_STRATEGY_NAMES,
  appendUserTurn,
  createBuiltinNotesTools,
  createOpenAIProvider,
  resolveNotesDir,
  runToolLoop,
} from "../src/index.js";
import { createCliAssemblyRoot } from "./assembly-root.js";
import { buildCompactionContext, loadCliConfig, normalizeCompactionOption } from "./config.js";
import {
  closeAllMcpServers,
  createMcpProxyTool,
  loadMcpConfig,
} from "./mcp.js";
import { defaultSessionId, runRepl } from "./repl.js";
import {
  buildCaptureRecoveryHint,
  buildCaptureStub,
  createDeliverableChecks,
  createFinalGuard,
  createNamedDeliverableChecks,
  DELIVERABLES_LIMIT,
  normalizeDeliverablePaths,
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
  purgeInactiveNoteScopes,
  wrapExecuteTool,
} from "./tools.js";
import { resolveChatSessionSelection } from "./sessions.js";
import { formatGuardMetrics } from "./guard-metrics.js";

const DEFAULT_MAX_ROUNDS = 64;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

const HELP_TEXT = `用法：
  erix --version, -v
  erix --help, -h
  erix chat "<prompt>" [--stream] [--reflection <on|off>] [--final-guard|--no-final-guard] [--require-deliverable [<path>]] [--no-notes] [--no-todo] [--timeout <ms>] [--cwd <dir>] [--config <path>] [--skills-dir <path>] [--session <id>] [-c|--continue] [-r] [--dir <path>] [--compact-budget <tokens>] [--compaction <name>] [--max-rounds <n>] [--idle-timeout <seconds>] [--judge-log <path>] [--error-log <path>] [--tools <逗号分隔工具名>]
  erix repl [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--compaction <name>] [--max-rounds <n>] [--idle-timeout <seconds>] [--final-guard|--no-final-guard] [--require-deliverable [<path>]] [--tools <逗号分隔工具名>]  （交互式模式）
  erix skills [--skills-dir <path>]  列出已发现的技能
  erix mcp [--config <path>]       列出 MCP 配置和连接状态
  （无参数直接进入交互式模式，等同 erix repl）

  --stream              流式输出模型文本
  --session <id>        会话 ID。chat 里它是**续跑入口**：该 id 没有非空 transcript 时报错退出
                      （exit 1），不再静默开新会话；不带 --session 才是新建（issue #168）
  -c, --continue       接续当前目录最近一次的会话（现扫 transcripts 目录，与 --session 互斥）
  -r                   交互式会话选择器，列出**本目录**可续跑的会话（需 TTY；非交互环境请改用
                      -c 或 --session <完整 id>）
                      ⚠ 会话发现无状态文件：能按目录筛选靠文件名里的 <目录名>-<sha256(cwd)[:8]>
                      前缀；名字不合此形状的 id（自取的名字、目录名含空格/中文而被哈希成 run-h-*）
                      在 -c/-r 里看不见，但仍可用 --session <完整 id> 恢复
  --dir <path>          Transcript 存档目录（chat 默认：~/.erix/transcripts）
  --cwd <dir>           本次 run 的工作目录（默认：进程工作目录；必须是已存在的目录）。它同时是
                       finalGuard / deliverables 判据拿到的 cwd——宿主侧的磁盘判据要靠它拼路径，
                       不接就会拼成 "undefined/report.md"（issue #391）
  --max-rounds <n>      工具循环最大轮数（默认：64，可用 ERIX_MAX_ROUNDS 覆盖）
  --reflection <on|off> 是否启用反思驱动的自适应预算（默认：max-rounds >= 16 时启用，见 DEFAULT_REFLECTION_MIN_ROUNDS）
  --final-guard         开启终稿 provenance 核验（默认关闭）
  --no-final-guard      兼容别名（默认已关闭，no-op）
  --require-deliverable [<path>]  交付物机器判据（默认关闭）。**两种语义**（issue #391）：
                      · 裸用（不带值）：本 run 用写工具**声明过的**每个路径收尾时都必须真的在盘上
                        （读 fileWrites 原始路径，不是 40 码点摘要）。⚠ 模型什么都不声明时集合为空
                        ⇒ 判据恒真，所以它判的是「没撒谎」，不是「做了事」。
                      · 带值（可重复）：**这次任务必须交付这些文件**，每条一个判据（相对路径按
                        --cwd 解析）。模型一次工具都没调也照样判不过——要「必须交付 report.md」
                        只能用这一种。两种写法都收：--require-deliverable report.md 与
                        --require-deliverable=report.md；值是可选的，所以裸用时别让后面紧跟一个
                        非旗标 token（把 prompt 写最前、或把裸旗标放末尾）。
                      判据跑在 guard 之前：guard 说 accept 而判据没过 ⇒ 终局 unverified:deliverables_failed，
                      **exit 2**。条数合计 ≤ 20（引擎 DELIVERABLES_LIMIT），路径不许重复。
                      ⚠ **必须与 --final-guard 同用**（或 ERIX_FINAL_GUARD=1）：判据是拦 guard accept
                      的闸门，没有 guard 就没有闸门——单独给会直接报 usage error（exit 1），
                      不静默空转（issue #391 R2）
  --no-notes            不装配 notes 工厂（note_* 工具不再可用），保留其他 skill
  --no-todo             彻底关闭 todo：内置 todo_* 四工具不注册、系统提示不含 todo、用户级 todo skill 一并排除
  --timeout <毫秒>     任务时间预算（软预算：临近时引导收尾，非硬杀；默认不启用）
  --idle-timeout <秒>   无进展自动中止（chat 默认：300，repl 默认：0=不启用）
  --judge-log <path>   将 round/intercept judge 决策追加写入 JSONL（默认：<归档目录>/judge.log）
  --error-log <path>   将持久化错误事件追加写入 JSONL（默认仅 stderr；也可用 ERIX_ERROR_LOG）
  --tools <名1,名2>    工具白名单：只保留列表内的工具（内置+skill+MCP）；未知名字警告并忽略，过滤后为空则报错
  --compaction <名>   上下文压缩策略：${BUILTIN_COMPACTION_STRATEGY_NAMES.join(" | ")}（默认：fold-statistical）。
                      ⚠ fold-llm 每次压缩会多一次主力模型调用（输入为被折叠的老轮次），其 usage
                      已计入本次 run 总账；也可用 config 字段 compaction 固定（旗标优先）。

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
  slots.default.compaction 可固定压缩策略（sliding-window / fold-statistical / fold-llm，默认 fold-statistical）；--compaction 可覆盖。

退出码：
  0  成功（开了 --final-guard 时为 verified）
  1  用法错误 / 会话不存在（--session 或 -c 找不到可续跑的 transcript）
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

// issue #167：--compaction 只收内置策略名；非法名字直接报 usage 错误（带合法值列表）
function parseCompactionOption(name, rawValue) {
  if (rawValue.trim() === "") usageError(`${name} 不能为空`);
  try {
    return normalizeCompactionOption(rawValue);
  } catch (error) {
    usageError(`${name}：${error?.message ?? String(error)}`);
  }
  return undefined;
}

// issue #391 R1：`--cwd` 必须解析成**已存在的目录**（绝对化之后才算数）。它会被原样交给
// finalGuard / deliverables 判据去拼路径（升级指南 §9 的配方就是 `path.join(cwd, "report.md")`），
// 指到一个不存在/不是目录的地方等于让判据恒假——那正是 #391 报的事故形状（宿主的 cwd 缺席 ⇒
// `"undefined/report.md"`）。所以在这里挡住，而不是让判据在收尾时才默默 `ok:false`。
function parseCwdOption(rawValue) {
  if (rawValue.trim() === "") usageError("--cwd 不能为空");
  const resolved = path.resolve(process.cwd(), rawValue);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    usageError(`--cwd 必须是已存在的目录：${resolved}`);
  }
  if (!stats.isDirectory()) usageError(`--cwd 必须是目录：${resolved}`);
  return resolved;
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
    // issue #391 R2：`--require-deliverable` **可重复**，且值是可选的（裸用 = 布尔判据，现语义）。
    // 两种写法都收：`--require-deliverable <path>`（照本文件既有惯例：空格分隔）与
    // `--require-deliverable=<path>`（可重复的带值旗标用 `=` 更清楚，空值当场报错）。
    if (argument === "--require-deliverable" || argument.startsWith("--require-deliverable=")) {
      let rawValue;
      if (argument.startsWith("--require-deliverable=")) {
        rawValue = argument.slice("--require-deliverable=".length);
        if (rawValue.trim() === "") {
          usageError("--require-deliverable= 后面必须是路径（裸用请直接写 --require-deliverable）");
        }
      } else {
        const next = args[index + 1];
        // 值是可选的：只有后面紧跟「不是旗标」的 token 才当成路径（`--require-deliverable --final-guard`
        // 里的第二个 token 是旗标 ⇒ 走裸用分支）。⚠ 代价：裸用时后面紧跟的 prompt 会被当成路径，
        // 所以帮助文本里要求「prompt 写最前，或裸旗标放末尾」。
        if (next !== undefined && !next.startsWith("-")) {
          rawValue = next;
          index += 1;
        }
      }
      if (rawValue === undefined) {
        if (seenOptions.has(argument)) {
          usageError(`参数重复：${argument}`);
        }
        seenOptions.add(argument);
        options.requireDeliverable = true;
      } else {
        // 重复的**带值**出现是正常的（可重复旗标）；重复的路径由共用校验器挡（判据名 = 路径）。
        try {
          options.deliverablePaths = normalizeDeliverablePaths([...(options.deliverablePaths ?? []), rawValue]);
        } catch (error) {
          usageError(`--require-deliverable：${error?.message ?? String(error)}`);
        }
      }
      continue;
    }
    if (argument === "-c" || argument === "--continue") {
      if (seenOptions.has("--continue")) {
        usageError("参数重复：--continue");
      }
      seenOptions.add("--continue");
      options.continueSession = true;
      continue;
    }
    if (argument === "-r") {
      if (seenOptions.has("-r")) {
        usageError("参数重复：-r");
      }
      seenOptions.add("-r");
      options.resumePicker = true;
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
      || argument === "--cwd"
      || argument === "--dir"
      || argument === "--compact-budget"
      || argument === "--compaction"
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
          || argument === "--cwd"
          || argument === "--dir"
          || argument === "--reflection"
          || argument === "--compaction"
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
      } else if (argument === "--cwd") {
        options.cwd = parseCwdOption(rawValue);
      } else if (argument === "--dir") {
        if (rawValue.trim() === "") usageError("--dir 不能为空");
        options.dir = rawValue;
      } else if (argument === "--compact-budget") {
        options.compactBudget = parseIntegerOption(argument, rawValue, 0);
      } else if (argument === "--compaction") {
        options.compaction = parseCompactionOption(argument, rawValue);
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

  if (seenOptions.has("--session") && options.continueSession === true) {
    usageError("--session 与 -c/--continue 互斥");
  }
  if (seenOptions.has("--session") && options.resumePicker === true) {
    usageError("--session 与 -r 互斥");
  }
  if (options.continueSession === true && options.resumePicker === true) {
    usageError("-c/--continue 与 -r 互斥");
  }

  // issue #391 R1：`--cwd` 就是「本次 run 的工作目录」⇒ 默认会话 id 也按它派生（否则会话前缀
  // 指向进程目录、run 却跑在另一个目录，`-c` 找回的会是「另一棵树」的会话）。显式 `--session`
  // 优先，一个字也不改。
  if (options.cwd !== undefined && !seenOptions.has("--session")) {
    options.session = defaultSessionId(options.cwd, { unique: true });
  }

  // issue #391 R2：`--require-deliverable` 单独用是**空转**——引擎只在
  // `typeof finalGuard === "function"` 时才跑 deliverables 闸门（`src/loop/termination.js`
  // 的 callFinalGuard 入口），没有 guard 就没有闸门。静默空转比报错更坏：用户以为自己已经
  // 要求了交付物，实际一个字都没核（这正是 #391 报的「旗标看起来能用、其实不生效」）。
  // 所以选**显式失败**（exit 1 + 点名两个旗标必须同用），而不是自动替用户装一个天真 guard——
  // 那会把「不带 --final-guard 的一次成功 chat ⇒ exit 4」这个既有承诺面改掉。
  if (
    (options.requireDeliverable === true || (options.deliverablePaths?.length ?? 0) > 0)
    && options.finalGuard !== true
    && process.env.ERIX_FINAL_GUARD?.trim() !== "1"
  ) {
    usageError(
      "--require-deliverable 必须与 --final-guard 同用（或设 ERIX_FINAL_GUARD=1）："
      + "交付物判据是拦 guard accept 的**闸门**，引擎只在 guard 存在时才核它；"
      + "单独用等于什么都不核（静默空转）",
    );
  }
  // issue #391 R2：条数上限是**合计**的（布尔那条也占一个 `deliverables` 槽位，引擎看的是数组长度）。
  // 单条路径在解析时已挡过重复/空串，这里只补「合计超限」这一格。
  if ((options.requireDeliverable === true ? 1 : 0) + (options.deliverablePaths?.length ?? 0) > DELIVERABLES_LIMIT) {
    usageError(
      `--require-deliverable 的判据合计最多 ${DELIVERABLES_LIMIT} 条（引擎 DELIVERABLES_LIMIT）：`
      + `裸用 1 条 + 命名路径 ${options.deliverablePaths?.length ?? 0} 条`,
    );
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
    builtinNames: ["readFile", "rg", "tree", "edit", "writeFile", "exec", "mcp"],
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
  const runId = options.session ?? defaultSessionId(options.cwd ?? process.cwd(), { unique: true });
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
  compaction,
  maxRounds,
  reflection,
  finalGuard,
  finalGuardMaxRetries = 2,
  requireDeliverable,
  deliverablePaths,
  timeoutMs,
  stream,
  completion,
  idleTimeout = DEFAULT_IDLE_TIMEOUT_SECONDS,
  session,
  sessionExplicit,
  cwd: cwdOption,
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
  const cwd = cwdOption ?? process.cwd();
  const runId = _notesRunId ?? session ?? defaultSessionId(cwd, { unique: true });
  const explicitSession = sessionExplicit ?? session !== undefined;
  const loadedConfig = configOverride ?? await loadCliConfig({ configPath });
  // --compaction 覆盖 config.compaction（名字仍往下传字符串，引擎负责实例化）
  const config = compaction === undefined
    ? loadedConfig
    : { ...loadedConfig, compaction };
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
  // issue #168 M1：显式 `--session <id>` 是会话恢复的唯一入口，id 打错时不能静默开新会话——
  // 静默新建会让用户以为在续跑旧会话（实测 0 行提示）。判定用「显式传入的 sessionExplicit」
  // 而不是 `explicitSession` 兜底值：宿主/测试直接给 `session` 而不带该旗标时，命名一个新会话
  // 是正常用法（repl 同理），不在本单收缩范围。
  // issue #326（wo-D）：这里的判据**故意仍是「行数」**而不是「正文条数」。账本里现在有三类
  // 引擎事实行（`:control:` / `:fold:` / `:ttl:`），一份只有事实行的 transcript 也是真会话：
  // 引擎 resume 正是靠这些行重建折叠/TTL 状态，`appendUserTurn` 会把新用户轮接上去（实测不崩）。
  // 把它改成「至少一条正文消息」会让 `-c/--session` 对这种账本报「会话不存在」——假报错。
  // 「多少条消息」的口径在 bin/session-scan.js#conversationMessages，别用这里的行数。
  if (sessionExplicit === true && existingRecords.length === 0) {
    throw new CliError(
      `会话不存在：${runId}（${dir} 下没有它的非空 transcript）。`
      + `\n可用 erix chat -r 列出本目录可续跑的会话，或 --session <完整 id> 传完整 id；`
      + `不带 --session 则是新建会话（默认 id 形如 <目录名>-<sha256(目录)[:8]>-<随机后缀>）。`,
    );
  }
  const resume = explicitSession && existingRecords.length > 0;
  if (resume) {
    // issue #97：预写入 user 轮收敛为引擎能力 appendUserTurn（round 推导、
    // dedupKey 唯一性与幂等判据由引擎负责，宿主不再手搓记录）。
    await appendUserTurn(store, { key: runId, text: prompt });
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
  // ADR-018 D7/D8：lifecycle 只有 onRunComplete；CLI 自身是宿主——收尾后
  // 按会话时钟清理过期笔记 scope（transcript 超 30 天无活动的 session，
  // 其笔记随 transcript 过期一起清理；维护失败静默，不影响主流程）。
  const purgeExpiredNotes = () => {
    if (notesDisabled || !notesStore) return;
    purgeInactiveNoteScopes({
      notesDir,
      sessionActivityFile: (scopeRef) => path.join(dir, `${scopeRef}.jsonl`),
    });
  };
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
  // judge 决策日志默认跟随 run 归档（与工具捕获同目录）；--judge-log / ERIX_JUDGE_LOG 可覆盖。
  // issue #165：注入路径与默认路径共用下面同一个写入器 appendJudgeLogRecord，两类记录
  // （judge 决策 + run 级 outcome 汇总）因此逐字段同形，不存在“走默认路径才多字段”的分叉。
  const judgeLogPath = judgeLog ?? process.env.ERIX_JUDGE_LOG ?? path.join(archiveDir, "judge.log");
  let judgeLogWriteFailed = false;
  // judge-log 为同信任域全量审计档案（与 run JSONL/工具捕获同目录，本就明文）：
  // 原始 info 原样落盘，不做脱敏——脱敏是 token hub 职责（ADR-009 信任模型）
  const appendJudgeLogRecord = judgeLogPath
    ? (record) => {
      if (judgeLogWriteFailed) return;
      try {
        appendFileSync(
          judgeLogPath,
          `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
          "utf8",
        );
      } catch (error) {
        judgeLogWriteFailed = true;
        console.error(`Judge log write failed: ${error?.message ?? String(error)}`);
      }
    }
    : undefined;
  const onJudge = appendJudgeLogRecord;
  // issue #165：run 终局的 `run_outcome` 汇总记录也落同一个 judge.log，使「judge 决策 ↔ run
  // 终局」在同一文件内按 runId join（per-model 校准指标不需第二条档案）。只挑这一条，其余事件
  // 不抄进 judge.log。引擎现状「宿主 onEvent 抛错是 fatal 的」（#173），而写入器内部已吞错，
  // 不会把已跑完的 run 带成 failed。
  const onEvent = appendJudgeLogRecord
    ? (event) => {
      if (event?.type !== "run_outcome") return;
      appendJudgeLogRecord(event);
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
    // issue #391 R1：`cwd` 是引擎的**纯透传**选项（只进 finalGuard/deliverables 的事实载荷）。
    // 不接的后果不是报错而是静默恒假：升级指南 §9 的判据 `path.join(cwd, "report.md")` 会拼成
    // `"undefined/report.md"`，每次 accept 都被闸门判成 `unverified:deliverables_failed`。
    cwd,
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
    // issue #386 切片 2 / #391 R2：`--require-deliverable`（默认关闭）——把机器判据交给引擎，
    // 闸门因此能在 guard 说 accept 之后仍然拒绝盖章。两种语义都留（见帮助文本）：
    //   裸用 ⇒ `createDeliverableChecks()`（「你说过要写的东西还在盘上吗」，读 fileWrites）；
    //   带值 ⇒ `createNamedDeliverableChecks(paths)`（「这次必须交付的这些文件在盘上吗」）。
    // 两个工厂都在 `bin/final-guard.js`，与 pi 扩展复用同一份判据本体。
    ...(() => {
      const criteria = [];
      if (requireDeliverable === true) criteria.push(...createDeliverableChecks());
      if (deliverablePaths !== undefined && deliverablePaths.length > 0) {
        criteria.push(...createNamedDeliverableChecks(deliverablePaths));
      }
      return criteria.length === 0 ? {} : { deliverables: criteria };
    })(),
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
    onEvent,
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
      // issue #391 R2：交付物判据没过时把**原因**说出来（unverified 的两种来源完全不同：
      // guard 打回重试用尽 vs 机器闸门拦下 guard 的 accept）。这句只在 deliverables_failed 时出现，
      // 其它 unverified 形状（max_retries 等）的输出逐字不变。
      if (result.verification?.reason === "deliverables_failed") {
        const failedCount = result.verification?.metrics?.deliverables_failed;
        console.log(
          `⚠️ 交付物判据没过（deliverables_failed${Number.isSafeInteger(failedCount) ? `，失败 ${failedCount} 条` : ""}）：`
          + "宿主声明的交付物不在盘上——guard 说 accept 也被机器闸门拦下，本次运行不视为成功结果。"
          + "（声明方式：--require-deliverable <path> / requireDeliverable / deliverablePaths）",
        );
      } else {
        console.log("⚠️ 该值未通过来源核验，不可信/需人工核验；本次运行不视为成功结果。");
      }
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
    purgeExpiredNotes();
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
  const selection = await resolveChatSessionSelection(
    {
      continueSession: chatArgs.continueSession,
      resumePicker: chatArgs.resumePicker,
      session: chatArgs.session,
      sessionExplicit: args.slice(1).includes("--session"),
      dir: chatArgs.dir,
    },
    {
      home: homedir(),
      // issue #391 R1：`--cwd` 就是「本次 run 的工作目录」——`-c` / `-r` 的会话发现也按它扫，
      // 否则「在 A 目录里列 B 目录的会话」会把选中的 id 拿去跑在另一个目录上。
      cwd: chatArgs.cwd ?? process.cwd(),
      input: process.stdin,
      output: process.stderr,
    },
  );
  if (selection.cancelled === true) return;
  // issue #168 T2：会话发现不再有索引——`-c`/`-r` 的候选由 bin/session-scan.js 现算，
  // 跑完也不再 upsert 任何状态文件（transcript 本身就是名单）。
  const result = await runChat({
    ...chatArgs,
    session: selection.session,
    sessionExplicit: selection.sessionExplicit,
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
