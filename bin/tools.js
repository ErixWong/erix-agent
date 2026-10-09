import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// 文件工具（readFile/rg/grep/tree/writeFile）的规范实现在 src/tools/file-tools.js，CLI 反过来 import 它
// （issue #184：ADR-005 第二层，先例 src/tools/notes.js）。bin/ 只做装配与呈现。
import { createFileTools, truncateDisplayText } from "../src/tools/file-tools.js";

// ---------------------------------------------------------------------------
// notes 会话时钟维护（ADR-018 D7）：CLI/REPL 作为宿主在收尾时清理过期笔记
// scope——笔记寿命 = 会话寿命 + ERIX_NOTES_RETENTION_MS（默认 30 天）尸检期。
// 每个 scope 的生死由宿主定义的「会话最后活动」判定（chat = transcript
// mtime；repl = 会话存档 mtime；调度型宿主 = 调度器状态，库不猜不问）；
// 找不到会话文件时回退为该 scope 笔记文件的最大 mtime（库内 purge 基线）。
// 纯同步 fs：收尾维护路径，失败静默（下次收尾重试），绝不影响主流程。
// ---------------------------------------------------------------------------

export function notesRetentionMs() {
  for (const name of ["ERIX_NOTES_RETENTION_MS", "ERIX_NOTES_GRACE_MS"]) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return 30 * 24 * 60 * 60 * 1000;
}

export function purgeInactiveNoteScopes({ notesDir, sessionActivityFile }) {
  // 收尾维护路径，契约是「永不影响主流程」：任何失败（只读目录、被占用、
  // 权限变化……）只跳过该 scope 并 console.error 留痕，绝不向外抛出——
  // CLI finally 中抛出会覆盖主异常/结果，REPL saveAndFinish 中会 reject。
  let scopeDirs;
  const runDir = path.join(notesDir, "run");
  try {
    scopeDirs = readdirSync(runDir, { withFileTypes: true });
  } catch {
    return { scanned: 0, purged: 0 };
  }
  const retention = notesRetentionMs();
  let scanned = 0;
  let purged = 0;
  for (const entry of scopeDirs) {
    if (!entry.isDirectory()) continue;
    scanned += 1;
    const scopeDir = path.join(runDir, entry.name);
    try {
      let lastActivityMs = -Infinity;
      try {
        lastActivityMs = statSync(sessionActivityFile(entry.name)).mtimeMs;
      } catch {
        // 无会话文件：回退该 scope 笔记文件的最大 mtime。
        for (const file of readdirSync(scopeDir)) {
          const fileStat = statSync(path.join(scopeDir, file));
          if (fileStat.isFile() && fileStat.mtimeMs > lastActivityMs) {
            lastActivityMs = fileStat.mtimeMs;
          }
        }
      }
      if (Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs > retention) {
        rmSync(scopeDir, { recursive: true, force: true });
        purged += 1;
      }
    } catch (error) {
      // 单 scope 清扫失败（如目录只读/被占用）：留痕后跳过，继续扫下一个。
      console.error(`notes purge skipped (${entry.name}): ${error?.message ?? String(error)}`);
    }
  }
  return { scanned, purged };
}

const OUTPUT_LIMIT = 4096;
// 尾部保留比例（截断时）：结局（报错 / exit / 汇总）留在尾部可见
const TRUNCATE_TAIL_SHARE = 0.25;
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

function normalizeSchema(schema) {
  const result = { ...schema };
  if (result.inputSchema === undefined && result.input_schema !== undefined) {
    result.inputSchema = result.input_schema;
    delete result.input_schema;
  }
  return result;
}

// CLI 自有工具 schema：文件工具五件套的 schema 跟着实现住在 src/tools/file-tools.js（issue #184），
// 这里只留 exec（ADR-005 红线：库不自带会执行的工具）与 todo_*（CLI 会话状态 ~/.erix/todos/）。
const schemas = [
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
  {
    name: "todo_add",
    description: "添加一条待办任务（存 ~/.erix/todos/，按工作目录隔离），返回确认文本",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "任务内容" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_list",
    description: "列出当前工作目录的所有待办任务，可按状态过滤，返回格式化列表文本",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "done"],
          description: "可选过滤状态：pending 或 done",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "todo_done",
    description: "将指定 id 的任务标记为完成",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "任务 id" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "todo_clear",
    description: "清空当前工作目录的全部任务",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
].map(normalizeSchema);

// issue #195：工具清单行新增 `searchText` 并把 `rg`/`grep` 标为已弃用——这是**模型可见面**变更
// （`test/fixtures/cli-golden.json` 内嵌整段提示词，golden 随之变更；这是刻意的，
// 不允许为了 golden 不变而把新工具藏进描述文字）。

// CLI 系统提示拆成「基础段 + todo 段」（issue #69）：
// --no-todo / ERIX_NO_TODO=1 时 todo 段整体消失（工具清单行后缀 + 工具纪律行的 todo 分句），
// 基础段自身是完整句子（工具清单行以「输出。」收尾）。默认路径拼接结果与拆分前逐字节一致。
const CLI_TOOLS_SYSTEM_PROMPT_BASE_HEAD =
  "可用工具：readFile 读取文本文件（支持行范围与 max_bytes 上限），" +
  "searchText 搜索文本文件（mode 必填、无默认值：literal 按字面量、regex 按 JavaScript 正则；" +
  "name_pattern 只匹配文件名、不跨 /；命中按「文件:行号:命中行」返回；截断时给出续读 offset），" +
  "rg 递归搜索文本文件（默认按正则匹配，与 rg 命令一致；传 is_regex=false 按字面量匹配，等价 rg --fixed-strings；" +
  "已弃用，请改用 searchText 并显式传 mode），" +
  "grep 递归搜索文件内容（默认正则，等价 grep -E；传 is_regex=false 按字面量，等价 grep -F；" +
  "支持 glob 文件名过滤（只匹配文件名、不跨 /），结果按文件分组；已弃用，请改用 searchText 并显式传 mode），" +
  "tree 列出目录树，writeFile 写入 UTF-8 文本，exec 执行 shell 命令并返回输出";

// issue #184（ADR-010：默认去噪必须可撤销）：「跳了什么 + 怎么撤销」必须进提示词——
// 模型不知道被排除就无从发起取回。排除账同时写在工具结果尾部。
const CLI_TOOLS_SYSTEM_PROMPT_VENDOR =
  "\n搜索与目录类工具（searchText/rg/grep/tree）默认跳过 node_modules、dist、build、target、vendor 与 . 开头的目录（结果尾部会回报跳过数量）；要一起搜传 include_vendor=true、include_hidden=true";

// todo 段①：工具清单行的 todo 后缀（含句号，接在基础段 HEAD 之后）；vendor 段接其后
const CLI_TOOLS_SYSTEM_PROMPT_TODO_TOOLS =
  "，todo_add 添加待办任务、todo_list 列出待办、todo_done 标记完成、todo_clear 清空（均返回可读文本，数据存 ~/.erix/todos/ 按工作目录隔离）。";

const CLI_TOOLS_SYSTEM_PROMPT_BASE_MIDDLE =
  `

[你的处境]
上下文会被折叠，早期细节你会真的忘记——不是记不清，是没有。
拿到后面还要用的具体值/决定时，立刻 note_take；
需要早期细节而想不起来时，先 note_list 再 note_read，不要猜。
若你决定重读文件而不先查笔记（note_list/note_read），必须在可见输出里用一行说明理由（如「笔记可能过期，需最新行号」），便于审计你的取回决策。
重跑同一命令可能得到不同的值；后续需要精确值时先 note_take 记下，不要凭记忆。
内部思考（reasoning）一律使用英文；对用户的可见输出不受此限，跟随用户语言。
终稿的结束协议 JSON 必须带 findings 字段，只把归档输出中出现过的字面值声明为 label→精确值（如 "findings":{"nonce":"abc123"}）；不要声明计数/次数/引用等派生结论；没有关键值时省略该字段。

[工具纪律]
- 复杂任务先规划并逐步执行`;

// todo 段②：工具纪律行首条 bullet 的 todo 分句（接在基础段「先规划并逐步执行」之后）
const CLI_TOOLS_SYSTEM_PROMPT_TODO_DISCIPLINE =
  "；长任务用 todo_add 记录进度、todo_done 标记完成，随时 todo_list 核对剩余项";

const CLI_TOOLS_SYSTEM_PROMPT_BASE_TAIL =
  `
- 大文件用 readFile 的 offset/limit 分段读取，操作后验证结果
- 具体数值必须来自当前工具返回或 note_read，不得编造
- 不要主动读取密钥、凭据或 .env 文件；只用本次工具返回明确给出的来源
- 任务完成后直接汇报结果，默认使用中文`;

export const CLI_TOOLS_SYSTEM_PROMPT =
  CLI_TOOLS_SYSTEM_PROMPT_BASE_HEAD
  + CLI_TOOLS_SYSTEM_PROMPT_TODO_TOOLS
  + CLI_TOOLS_SYSTEM_PROMPT_VENDOR
  + "。"
  + CLI_TOOLS_SYSTEM_PROMPT_BASE_MIDDLE
  + CLI_TOOLS_SYSTEM_PROMPT_TODO_DISCIPLINE
  + CLI_TOOLS_SYSTEM_PROMPT_BASE_TAIL;

/**
 * --tools 白名单过滤（chat/repl 共用）：对组合后的工具集做 allowlist。
 * 未知工具名 → onUnknown 警告（调用方写 stderr）并忽略；过滤后为空 → 抛错（调用方转 usageError）。
 */
export function filterToolsByAllowlist(tools, allowlist, { onUnknown } = {}) {
  if (allowlist === undefined || allowlist === null) return tools;
  const requested = String(allowlist)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const known = new Set((Array.isArray(tools) ? tools : []).map((tool) => tool?.name));
  for (const name of requested) {
    if (!known.has(name)) onUnknown?.(`警告：--tools 中的工具名 "${name}" 不存在，已忽略`);
  }
  const allowed = new Set(requested);
  const filtered = (Array.isArray(tools) ? tools : []).filter((tool) => allowed.has(tool?.name));
  if (filtered.length === 0) {
    throw new Error("--tools 过滤后没有可用工具，请检查工具名列表");
  }
  return filtered;
}

export function buildCliToolsSystemPrompt({ todo = true } = {}) {
  // ADR-015：ResourceStore 退出模型视野——所有宿主形态同一份提示词，不提 opaque 工件/路径。
  // issue #69：todo=false 时拼接无 todo 段的基础提示（--no-todo / ERIX_NO_TODO）。
  if (todo === false) {
    return `${CLI_TOOLS_SYSTEM_PROMPT_BASE_HEAD}。${CLI_TOOLS_SYSTEM_PROMPT_VENDOR}。${CLI_TOOLS_SYSTEM_PROMPT_BASE_MIDDLE}${CLI_TOOLS_SYSTEM_PROMPT_BASE_TAIL}`;
  }
  return CLI_TOOLS_SYSTEM_PROMPT;
}

export function buildArchiveNotice(archiveDir) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) return "";
  return "\n\n[工具输出归档]\n大输出已由引擎全量归档。后续需要精确值时先用 note_list 查找记录，再用 note_read 读取；若未记录且无法确定性重算，请省略对应 findings 声明，不要凭记忆补值，也不要重跑命令。";
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

/**
 * Head+tail truncation for oversized tool output (host layer).
 *
 * 保留开头（命令上下文 / 第一条结果）与结尾（报错、exit 行、汇总），中间省略并标注字符数。
 * 之前的 head-only 截断会把尾部报错信息整段丢掉（issue #32 #2）。本函数不按工具名分支：
 * exec 结果经它截断；readFile 不经过它（自带 offset/limit 的 head+offset 窗口，行为不变）。
 *
 * @param {string} text
 * @param {number} limit 保留的总字符数上限（head + tail）
 * @param {string} omittedNote
 * @returns {string}
 */
export function headTailTruncate(text, limit, omittedNote) {
  if (text.length <= limit) return text;
  const tailLength = Math.max(1, Math.floor(limit * TRUNCATE_TAIL_SHARE));
  const headLength = Math.max(0, limit - tailLength);
  // 不切碎代理对（CJK 之外的 emoji 会占两个 UTF-16 单元）
  const head = text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/u, "");
  const tail = text.slice(text.length - tailLength).replace(/^[\uDC00-\uDFFF]/u, "");
  const omitted = text.length - head.length - tail.length;
  return `${head}\n[${omittedNote(omitted, text.length)}]\n${tail}`;
}

export function truncateResult(result) {
  const text = String(result ?? "");
  if (/\n\[完整输出(?:已归档|归档失败)：[^\n]+\]$/u.test(text)) return text;
  return headTailTruncate(
    text,
    OUTPUT_LIMIT,
    (omitted, total) => `中间省略 ${omitted} 字符，共 ${total} 字符`,
  );
}

const TOOL_INPUT_LIMIT = 120;
const TOOL_RESULT_LIMIT = 200;
const TOOL_EXEC_RESULT_LIMIT = 4096;
const TOOL_FIELD_LIMIT = 80;

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

  // 与 pi 对齐：终端回显不做内容检测/打码，只按显示宽度截断；
  // 凭据安全由 token hub 等执行侧职责保障（issue #55）
  const serialized = JSON.stringify(input, (key, value) => (typeof value === "string"
    ? truncateDisplayText(value, TOOL_FIELD_LIMIT)
    : value));
  return truncateDisplayText(serialized ?? input, TOOL_INPUT_LIMIT);
}

function summarizeToolResult(name, result) {
  const text = String(result ?? "");
  // exec 输出可能是验证/回归脚本的多行结果，必须完整可见（对齐 exec 内部 4096 截断）
  const limit = name === "exec" ? TOOL_EXEC_RESULT_LIMIT : TOOL_RESULT_LIMIT;
  // exec 日志同用 head+tail：尾部报错/exit 比中段 filler 有价值（issue #32 #2）
  return name === "exec"
    ? headTailTruncate(
      text,
      limit,
      (omitted, total) => `中间省略 ${omitted} 字符，共 ${total} 字符`,
    )
    : truncateDisplayText(text, limit);
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
      ? {
        ...(firstArg.context ?? {}),
        toolUseId: firstArg.id,
        // issue #184：引擎把 signal 放在结构化参数的**顶层**（src/loop/run-snapshot-executor.js:244），
        // 这里不并进来就是「signal 在 CLI 侧被丢的第一次」——工具拿不到中止信号。
        ...(firstArg.signal === undefined ? {} : { signal: firstArg.signal }),
      }
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


const TODO_TOOL_NAMES = new Set(["todo_add", "todo_list", "todo_done", "todo_clear"]);

export function createCliTools({
  cwd = process.cwd(),
  todo = true,
} = {}) {
  const root = path.resolve(cwd);
  const todoEnabled = todo !== false;
  // ADR-016：replayable 分类、重跑检测、auto-capture 全部退役；
  // lastToolMetadata 仅存工具名（元数据通道收窄）。
  let lastToolMetadata;

  // 文件工具五件套（readFile/rg/grep/tree/writeFile）不再在 CLI 里各写一份：直接用
  // src/tools/file-tools.js 的规范实现（issue #184）。边界谓词不传 = 默认 () => true，
  // 与 CLI 历史行为一致（本地信任域，不做 containment；ADR-009 牢笼归宿主）。
  const fileTools = createFileTools({ cwd: root });

  // ---- todo 内置工具（issue #65：自 ~/.erix/skills/todo/skill.mjs 移植）----
  // 数据文件定位与格式与原 skill 完全一致：~/.erix/todos/<basename>-<hash8>.json
  // （basename+cwd 的 sha256 前 8 位，按 cwd 隔离），老数据天然兼容。
  // 内置化后工具返回可读字符串（原 skill 返回对象，由宿主序列化）。

  function todoDataFile() {
    const base = path.basename(root) || "root";
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
    return path.join(homedir(), ".erix", "todos", `${base}-${hash}.json`);
  }

  function loadTodos() {
    const file = todoDataFile();
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveTodos(todos) {
    const file = todoDataFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(todos, null, 2), "utf8");
  }

  function formatTodoList(todos) {
    if (todos.length === 0) return "（无任务）";
    const lines = todos.map((item) => `#${item.id} [${item.status}] ${item.text}`);
    return [`共 ${todos.length} 条任务`, ...lines].join("\n");
  }

  async function todoAdd({ text }) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new TypeError("todo_add text 必须是非空字符串");
    }
    const todos = loadTodos();
    const id = todos.length > 0 ? Math.max(...todos.map((item) => Number(item.id) || 0)) + 1 : 1;
    const item = {
      id,
      text: String(text),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    todos.push(item);
    saveTodos(todos);
    return `已添加任务 #${id}: ${item.text}`;
  }

  async function todoList({ status } = {}) {
    let todos = loadTodos();
    if (status === "pending" || status === "done") {
      todos = todos.filter((item) => item.status === status);
    }
    return formatTodoList(todos);
  }

  async function todoDone({ id }) {
    const todos = loadTodos();
    const item = todos.find((entry) => entry.id === Number(id));
    if (!item) {
      throw new Error(`任务不存在: id=${id}`);
    }
    item.status = "done";
    saveTodos(todos);
    return `已将任务 #${item.id} 标记为完成：${item.text}`;
  }

  async function todoClear() {
    const before = loadTodos().length;
    saveTodos([]);
    return `已清空全部任务（共 ${before} 条）`;
  }

  const executors = {
    exec: (input, context) => executeExecCommand(input, root),
  };
  // 文件工具名以库里的 definitions 为准，避免两处名单漂移。
  for (const { name } of fileTools.definitions) {
    executors[name] = (input, context) => fileTools.executors(name, input, context);
  }
  // issue #69：--no-todo / ERIX_NO_TODO=1 时 todo 四工具不注册（schemas 同步过滤，见 return）。
  if (todoEnabled) {
    executors.todo_add = todoAdd;
    executors.todo_list = todoList;
    executors.todo_done = todoDone;
    executors.todo_clear = todoClear;
  }

  async function executeTool(name, input, context) {
    const executor = executors[name];
    if (typeof executor !== "function") {
      throw new Error(`未知工具：${name}`);
    }
    lastToolMetadata = { name };
    // ADR-016：重跑值错配风险由提示语承担，引擎不做幂等分类/重跑检测/捕值。
    // issue #184：以前这里连 context 都不传（signal 在 CLI 侧被丢的第二次），
    // 库里的遍历/有界读就拿不到中止信号；`~` 展开也已随实现下库。
    return executor(input, context);
  }

  return {
    tools: [...fileTools.definitions, ...schemas]
      .filter((schema) => todoEnabled || !TODO_TOOL_NAMES.has(schema.name))
      .map((schema) => structuredClone(schema)),
    executeTool,
    getLastToolMetadata: () => lastToolMetadata,
    truncateResult,
  };
}
