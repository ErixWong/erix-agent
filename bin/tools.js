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

import {
  DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS,
  EXEC_CEILING_FLOOR_MS,
  EXEC_CEILING_MARGIN_MS,
  execCeilingMsForIdle,
} from "./idle.js";

// 文件工具（readFile/rg/grep/tree/writeFile）的规范实现在 src/tools/file-tools.js，CLI 反过来 import 它
// （issue #184：ADR-005 第二层，先例 src/tools/notes.js）。bin/ 只做装配与呈现。
import { createFileTools, FILE_TOOL_DEFINITIONS, truncateDisplayText } from "../src/tools/file-tools.js";
// 派生工具的 definition 归库（issue #617 P1b）：CLI 不手抄 schema，只做「装不装」的开关与执行器注入。
import { DELEGATE_DEFINITION } from "../src/tools/delegation/tool.js";

// todo 四件套的名字（issue #69：--no-todo / ERIX_NO_TODO=1 时整体不注册）。
// 住在 `schemas` 之前：注册面单一来源 `cliToolDefinitions` 与提示词装配都要用它，而后者在
// 模块初始化期就要算出 `CLI_TOOLS_SYSTEM_PROMPT`（const 的 TDZ 不允许往后放）。
export const TODO_TOOL_NAMES = new Set(["todo_add", "todo_list", "todo_done", "todo_clear"]);

// 派生工具的名字（issue #617 P2：**默认关闭**，只有 `--delegate` / `ERIX_DELEGATE=1` 才注册）。
// 与 todo 同一条装配路径：注册面单一来源 `cliToolDefinitions` + 提示词短语表，一处改两处同变。
// 为什么默认关：它是 issue #617 的「可运行的示例 + 验证器」，不是 CLI 的新默认能力；关着时
// 提示词、工具面、会话文件位置与 0.28.0 发布时**逐字一致**（`test/fixtures/cli-golden.json` 钉着）。
export const DELEGATE_TOOL_NAMES = new Set(["delegate"]);

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
// 安装/编译类命令（apt/pip/make 等）给更长时间——但**必须短于 chat 的 idle 窗口**（issue #433 T0）：
// idle 的计时起点更早（模型请求期就开始走），同值时 idle 必然先响 ⇒ 这条「命令超时」事实上不可达，
// 一条挂住的安装命令的结局是「整个 run 被打死」而不是「命令超时」。所以它由 idle 默认窗口减去
// `EXEC_CEILING_MARGIN_MS` 现算（300s − 60s = 240s），不是另写一个魔法数：改 idle 默认值时这条关系
// 自动跟着走，不会留下一个「文档没声明、门禁也拦不住」的悬空常量。
const INSTALL_EXEC_TIMEOUT_MS = DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS * 1000 - EXEC_CEILING_MARGIN_MS;
const EXEC_MAX_BUFFER = 1024 * 1024;

// 安装/编译/下载类命令前缀（benchmark 实测 apt-get install 频繁超时）。
// issue #434 T1：这条正则**仍然 `^` 锚定**，但锚在「切段 + 剥前缀之后的**段首**」上，不是整条命令的
// 开头（判定见 `isInstallCommand`）。整条去掉 `^` 会把 `grep 'apt-get install' f`、
// `sed -i 's/apt-get install/x/'`、`node -e "..."`、`cat install.log` 全判成 install 档，白白给 240s。
const INSTALL_COMMAND_PATTERN = /^(?:sudo\s+)?(?:apt-get|apt|pip\d?|pip3|npm|yarn|pnpm|make|cmake|gcc|g\+\+|cc|configure|bash\s+.*\.sh|curl|wget)\b/;

/**
 * 包在真正命令前面的**前缀命令**（issue #434 T1 的表驱动口径）：名字 ⇒ 「要连吃一个参数值」的短选项集合
 * （`sudo -u root` / `timeout -s KILL`）。`command` 故意**不**吃选项：`command -v npm` 只是查存在，
 * 吃了 `-v` 就会把 `npm` 当成段首 ⇒ 假 install 档。
 * 这张表是**反向证的靶子**：清空任一格，对应的正例必须变红。
 */
const SHELL_PREFIX_COMMANDS = new Map([
  ["sudo", new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-D", "-R", "-T"])],
  ["env", new Set(["-u", "-C", "-S"])],
  ["time", new Set(["-f", "-o"])],
  ["nohup", new Set()],
  ["command", new Set()],
  ["exec", new Set(["-a"])],
  ["timeout", new Set(["-s", "-k"])],
]);

/** 段首出现时要跳过的 shell 关键字（`set -e; pip install x`、`then npm ci` 这类连接体）。 */
const SHELL_SEGMENT_KEYWORDS = new Set([
  "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "fi", "done",
]);

/** `VAR=值` 形式的赋值前缀（`NODE_ENV=prod npm install`）。 */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\S*/;
/** 命令的路径前缀（`/usr/local/bin/pip3`、`./mvnw`）——只吃路径本身，段首换成 basename。 */
const PATH_PREFIX = /^(?:\.{1,2}\/|\/)\S*$/;
/** 剥前缀的循环上限（防病态输入把纯函数拖成死循环；正常命令 2–3 轮就到底）。 */
const SEGMENT_PREFIX_STRIP_LIMIT = 24;

/** 按 shell 的命令连接符切段（纯函数）：`&&` / `||` / `;` / `|` / `&` / 换行。
 *  引号内的分隔符**不切**（`grep 'a|b' f` 是一段），引号外的 `\` 转义照 shell 走。 */
function splitCommandSegments(command) {
  const text = String(command ?? "");
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (quote === "'") {
        if (ch === "'") quote = null;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === "&" || ch === "|") && text[i + 1] === ch) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/** 吃掉命令名之后的短选项（`-E` / `-n` …）；`takesArg` 里的选项再连吃一个参数值。 */
function dropShortOptions(text, takesArg) {
  let rest = text.trimStart();
  while (rest.startsWith("-") || rest.startsWith("+")) {
    const option = rest.match(/^\S+/);
    if (!option) break;
    rest = rest.slice(option[0].length).trimStart();
    if (takesArg.has(option[0])) {
      const argument = rest.match(/^\S+/);
      if (argument) rest = rest.slice(argument[0].length).trimStart();
    }
  }
  return rest;
}

/** 剥掉一段的前缀，返回「真正要执行的命令」的段首文本（纯函数）。
 *  剥的次序每轮重来：路径前缀 → `(` → `VAR=值` → `set`/关键字 → 前缀命令（含各自的选项与参数）。 */
function segmentHead(segment) {
  let rest = segment.trim();
  for (let round = 0; round < SEGMENT_PREFIX_STRIP_LIMIT && rest !== ""; round += 1) {
    if (rest.startsWith("(")) {
      rest = rest.slice(1).trimStart();
      continue;
    }
    const assignment = rest.match(ASSIGNMENT_PREFIX);
    if (assignment) {
      rest = rest.slice(assignment[0].length).trimStart();
      continue;
    }
    const head = rest.match(/^\S+/);
    if (!head) break;
    const name = head[0];
    const tail = rest.slice(name.length);
    if (PATH_PREFIX.test(name)) {
      rest = (name.slice(name.lastIndexOf("/") + 1) + tail).trimStart();
      continue;
    }
    if (name === "set") {
      rest = dropShortOptions(tail, new Set(["-o", "+o"]));
      continue;
    }
    if (SHELL_SEGMENT_KEYWORDS.has(name)) {
      rest = tail.trimStart();
      continue;
    }
    if (SHELL_PREFIX_COMMANDS.has(name)) {
      let after = tail;
      if (name === "command") {
        // `command -v npm` 只是查存在，不吃选项（吃了会把 `npm` 顶到段首 ⇒ 假 install 档）。
        after = after.trimStart();
      } else {
        after = dropShortOptions(after, SHELL_PREFIX_COMMANDS.get(name));
      }
      if (name === "timeout") {
        // `timeout 300 npm ci`：选项之后还要吃掉那个时长。
        const duration = after.match(/^\S+/);
        if (duration) after = after.slice(duration[0].length);
      }
      rest = after.trimStart();
      continue;
    }
    break;
  }
  return rest;
}

/**
 * 判定一条命令是否「安装/编译/下载类」（issue #434 T1）。**纯函数、零 IO**：只吃命令字符串，
 * 环境变量/时钟/文件一律不读（`ERIX_EXEC_TIMEOUT_MS` 由调用方处理）。
 *
 * 口径：先按 `&&` / `||` / `;` / `|` / `&` / 换行**切段**（引号内不切），每段剥掉已知前缀
 * （`sudo`/`env`/`time`/`nohup`/`command`/`exec`/`timeout <时长>`、`VAR=值` 赋值、`set -e` 之类
 * shell 关键字、`(`、可选路径前缀），剥完之后的**段首**再跑 `INSTALL_COMMAND_PATTERN`。
 * **任一段落段首命中 ⇒ 放大档**；`echo apt-get`、`grep 'apt-get install' f`、
 * `sed -i 's/apt-get install/x/' f`、`node -e "..."`、`cat install.log` 都保持默认档。
 *
 * 已知不覆盖（如实登记，**不**偷偷扩大范围）：`sh setup.sh` 这类「install 字样只在脚本里面」的写法
 * **不**进放大档——本函数只看命令的段首，不做脚本内容分析（也没打算加脚本白名单）。
 * （`bash xxx.sh` 命中是 `INSTALL_COMMAND_PATTERN` 里的**存量**分支，不是本刀加的，行为一字未改。）
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isInstallCommand(command) {
  return splitCommandSegments(command).some((segment) => INSTALL_COMMAND_PATTERN.test(segmentHead(segment)));
}

/** `ERIX_EXEC_TIMEOUT_MS` 的显式值（未设/非法 ⇒ `null`）。「显式」与「默认」必须能区分：
 *  装配处对两者都按 idle 天花板收口（issue #433 fix 4），区分只用于**日志口径**（“用户显式设的” vs
 *  “install 档默认值”）。 */
function explicitExecTimeoutMs() {
  const configured = Number(process.env.ERIX_EXEC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

// ERIX_EXEC_TIMEOUT_MS overrides the default timeout for foreground commands.
export function getExecTimeoutMs() {
  const explicit = explicitExecTimeoutMs();
  return explicit === null ? DEFAULT_EXEC_TIMEOUT_MS : explicit;
}

/**
 * 按命令类型选择超时：安装/编译/下载类命令超时更长（默认 240s = idle 默认窗口 300s − 60s），
 * 其余默认 120s。哪一类由 `isInstallCommand` 判（issue #434 T1：**按分段后的段首**判，不是整条命令的开头）。
 *
 * `ceilingMs`（issue #433 T0 / fix 4）：装配处按 `--idle-timeout` 算出来的天花板（`execCeilingMsForIdle`）。
 * **两者都按它收口**（`Math.min`）：issue #433 fix 4 的裁定是「启动时校验 exec 上限 < idle；不满足时
 * 自动收敛为 `min(exec, idle − 60s)` 并打一条 loud 日志，**不**启动即报错」（bench 两臂就是 exec==idle，
 * 硬报错会把现成调用打断；判据是「终局不得是 `idle_timeout`」）。因此 T0 时代的「显式配置一字不改」
 * 已被本刀推翻，旧行为只保留在历史注释里。
 *
 * @param {string} command
 * @param {{ ceilingMs?: number | null }} [options]
 * @returns {number} 毫秒
 */
export function getCommandTimeoutMs(command, { ceilingMs } = {}) {
  const explicit = explicitExecTimeoutMs();
  const install = isInstallCommand(command);
  const tier = explicit ?? (install ? INSTALL_EXEC_TIMEOUT_MS : DEFAULT_EXEC_TIMEOUT_MS);
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) return tier;
  return Math.min(tier, ceilingMs);
}

/**
 * 装配处的一次性口径：把 exec 天花板按 idle 算出来（issue #433 T0 / fix 4）。
 *
 * 返回给 `createCliTools({ execCeilingMs })` 的那份值，同时把口径讲清楚：
 *  - idle 未启用 ⇒ `null`（不钳，也不打日志：没有窗口就没有要先响的对象）；
 *  - 天花板 = `max(30s, idle − 60s)`（`execCeilingMsForIdle`），**显式配置也会被它收敛**（fix 4）：
 *    `ERIX_EXEC_TIMEOUT_MS` 高于天花板时打一条 loud 日志并返回天花板——不启动即报错，
 *    因为「exec == idle」正是 bench 两臂的现成配置，硬报错会把调用打断；
 *  - 默认值（install 档）本来就高于天花板时同样钳到天花板并打日志；默认 idle=300s 时天花板恰好
 *    等于 install 档默认值（240s），**钳制没有改变任何取值 ⇒ 不打日志**（每次 chat 都打一行
 *    「钳了但没变」只会是噪声）；
 *  - **天花板压不到窗口以下时也要说**（`idle ≤ 30s` 时下限 30s 压过 `idle − 60s`）：这时
 *    「exec 上限 < idle」这条不变式**物理上不可能**成立，能兑付的是「工具执行期由喂表兜住、
 *    最坏 `30s + idle`」——打一行日志把代价说在前面，而不是默默失效。
 *
 * @param {number} idleSeconds `--idle-timeout` 的秒数
 * @param {{ warn?: (line: string) => void }} [options]
 * @returns {number | null} 毫秒；`null` = 不钳
 */
export function resolveExecCeiling(idleSeconds, { warn = (line) => console.error(line) } = {}) {
  const ceilingMs = execCeilingMsForIdle(idleSeconds);
  if (ceilingMs === null) return null;
  const idleMs = idleSeconds * 1000;
  const explicit = explicitExecTimeoutMs();
  if (explicit !== null && explicit > ceilingMs) {
    warn(
      `⚠️ exec 上限已收敛（issue #433 fix 4）：ERIX_EXEC_TIMEOUT_MS=${explicit}ms ≥ idle 天花板 ${ceilingMs}ms`
      + `（--idle-timeout ${idleSeconds}s − ${EXEC_CEILING_MARGIN_MS / 1000}s）`
      + `⇒ 实际生效 ${ceilingMs}ms = min(exec, idle − ${EXEC_CEILING_MARGIN_MS / 1000}s)。`
      + "同值时 idle 的起点更早，挂住的命令会先打死整个 run，而不是先报「命令超时」。",
    );
  } else if (explicit === null && INSTALL_EXEC_TIMEOUT_MS > ceilingMs) {
    warn(
      `exec 天花板已钳到 ${ceilingMs}ms（install 档默认 ${INSTALL_EXEC_TIMEOUT_MS}ms > `
      + `--idle-timeout ${idleSeconds}s − ${EXEC_CEILING_MARGIN_MS / 1000}s）：`
      + "否则挂住的安装命令会先打死整个 run，而不是先报「命令超时」。",
    );
  }
  // 不变式 `exec < idle` 在 `idle ≤ 下限 + 余量` 时**物理上不可能**成立（天花板有 30s 下限）。
  // 不静默：把能兑付的那半（工具执行期喂表）与最坏代价写在一行里。
  const effectiveMs = Math.min(explicit ?? INSTALL_EXEC_TIMEOUT_MS, ceilingMs);
  if (effectiveMs >= idleMs) {
    warn(
      `⚠️ exec 上限 ${effectiveMs}ms 仍 ≥ idle 窗口 ${idleMs}ms（issue #433 fix 4）：`
      + `--idle-timeout ${idleSeconds}s 低于天花板下限 ${EXEC_CEILING_FLOOR_MS / 1000}s + `
      + `${EXEC_CEILING_MARGIN_MS / 1000}s，exec < idle 这条不变式无法成立。`
      + `能兑付的是「工具执行期喂表」：最坏 ${(EXEC_CEILING_FLOOR_MS + idleMs) / 1000}s，`
      + "而不是整个 run 被 idle 打死。",
    );
  }
  return ceilingMs;
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
// issue #312(b) R2：清单行（原 `CLI_TOOLS_SYSTEM_PROMPT_BASE_HEAD` 与 todo 后缀两个手抄常量）
// 已改成「遍历注册面 ＋ 查短语表」生成，逐字节等价；下面只留**不是清单**的那几段文案。

// ---------------------------------------------------------------------------
// 工具清单单一来源（issue #312(b) R2）：清单行**不再手抄**，由「遍历注册面 definitions ＋ 每个名字查短语表」生成。
//   · 注册面（`cliToolDefinitions`）= 名字的单一来源 ⇒「注册面 ⊆ 提示词」在结构上成立（漏列不可能）；
//   · 短语表（`CLI_TOOL_PROMPT_PHRASES`）= 文案的单一来源 ⇒ 表里出现注册面没有的名字 ⇒ build 时抛错
//     （「提示词 ⊆ 注册面」，治陈旧手抄：删一个工具却忘了删文案，以前是静默的，现在红）。
// 注册面上有名字而短语表没有 ⇒ 同样抛错：宁可炸，也不要在模型视野里静默少一个工具。
// 硬约束：**输出逐字节不变**（`test/fixtures/cli-golden.json` 不重烤就是这条的判据，issue #195 的
// 「新增 searchText / 标弃用 rg·grep」仍然要求清单行点名，文案一个字没动）。
// ---------------------------------------------------------------------------

/** 工具清单行的分段样式：base 段用「，」分隔；todo / delegate 段各自另起一段（「、」分隔 + 组级注释）。 */
const CLI_TOOL_PROMPT_GROUPS = {
  base: { lead: "可用工具：", join: "，" },
  todo: {
    lead: "，",
    join: "、",
    // 组级注释（不是某个工具自己的话术），接在 todo 段末尾；todo_* 四件套同一条数据通路，故合并说。
    note: "（均返回可读文本，数据存 ~/.erix/todos/ 按工作目录隔离）",
  },
  delegate: {
    lead: "，",
    join: "、",
    // issue #617 P2：组级注释把 v1 的两条硬边界写在模型看得见的地方（不是静默）：
    // 父身份不是模型入参；子 run 的工具集不带 delegate（不递归派生）。
    note: "（父 run 身份由宿主从执行上下文给出、不是模型入参；子 run 的工具集不含 delegate，v1 不递归派生）",
  },
};

/**
 * 短语表：工具名 → 清单行里那一句。**只放文案，不放名单**——名单来自注册面。
 * 每个 key 必须在注册面上（否则 `buildCliToolsSystemPrompt` 抛错），反之注册面上的名字
 * 也必须在这里有一句（同上），两侧都由 `assertPromptPhraseTableMatches` 在 build 期双向核对。
 */
export const CLI_TOOL_PROMPT_PHRASES = {
  readFile: { group: "base", phrase: "readFile 读取文本文件（支持行范围与 max_bytes 上限）" },
  searchText: {
    group: "base",
    phrase: "searchText 搜索文本文件（mode 必填、无默认值：literal 按字面量、regex 按 JavaScript 正则；"
      + "name_pattern 只匹配文件名、不跨 /；命中按「文件:行号:命中行」返回；截断时给出续读 offset）",
  },
  rg: {
    group: "base",
    phrase: "rg 递归搜索文本文件（默认按正则匹配，与 rg 命令一致；传 is_regex=false 按字面量匹配，等价 rg --fixed-strings；"
      + "已弃用，请改用 searchText 并显式传 mode）",
  },
  grep: {
    group: "base",
    phrase: "grep 递归搜索文件内容（默认正则，等价 grep -E；传 is_regex=false 按字面量，等价 grep -F；"
      + "支持 glob 文件名过滤（只匹配文件名、不跨 /），结果按文件分组；已弃用，请改用 searchText 并显式传 mode）",
  },
  tree: { group: "base", phrase: "tree 列出目录树" },
  edit: {
    group: "base",
    phrase: "edit 对已存在的文件做精确文本替换（edits 是 [{oldText, newText}]，"
      + "oldText 要与原文逐字符相等且恰好命中 1 次，0 次或多处都是错误结果并告知下一步；不做模糊兜底；返回短 diff）",
  },
  writeFile: { group: "base", phrase: "writeFile 写入 UTF-8 文本" },
  exec: { group: "base", phrase: "exec 执行 shell 命令并返回输出" },
  todo_add: { group: "todo", phrase: "todo_add 添加待办任务" },
  todo_list: { group: "todo", phrase: "todo_list 列出待办" },
  todo_done: { group: "todo", phrase: "todo_done 标记完成" },
  todo_clear: { group: "todo", phrase: "todo_clear 清空" },
  delegate: {
    group: "delegate",
    phrase: "delegate 派生一个子 run（action 五选一：run 起一个子 run、status/list 查名册、"
      + "result 取终局并标记已取、cancel 取消本进程持有的子 run）",
  },
};

/**
 * 注册面的单一来源（issue #312(b) R2）：`createCliTools` 的 `tools` 与提示词清单行都从这里来，
 * 于是一处改、两处同变。文件工具的 definitions 与 `src/tools/file-tools.js` 的 `FILE_TOOL_DEFINITIONS`
 * 同一数组（`createFileTools` 只是 structuredClone 它），这里直接取原数组：清单行为此不需要 cwd。
 */
export function cliToolDefinitions({ todo = true, delegate = false } = {}) {
  const todoEnabled = todo !== false;
  // issue #617 P2：`delegate` 默认**关**（显式开启才注册）。两个开关各自独立过滤，互不牵连——
  // `--no-todo --delegate` 是合法组合。
  const delegateEnabled = delegate === true;
  return [...FILE_TOOL_DEFINITIONS, ...schemas, DELEGATE_DEFINITION]
    .filter((schema) => todoEnabled || !TODO_TOOL_NAMES.has(schema.name))
    .filter((schema) => delegateEnabled || !DELEGATE_TOOL_NAMES.has(schema.name));
}

/**
 * 双向核对（装配期，不是文本扫描）：短语表的 key 集合 ⇄ 注册面的 name 集合。
 * 两侧任一方向不吻合都抛错——这就是「注册面 ⊆ 提示词」（漏列）与「提示词 ⊆ 注册面」（陈旧手抄）。
 */
/**
 * 双向核对（装配期，不是文本扫描）：短语表的 key 集合 ⇄ 注册面的 name 集合。
 * 两侧任一方向不吻合都抛错——这就是「注册面 ⊆ 提示词」（漏列）与「提示词 ⊆ 注册面」（陈旧手抄）。
 * `fullNames` = **全量注册面**（todo=true 那份）：短语表是静态表，todo=false 只是本轮少拼一段，
 * 不能拿它当「陈旧」的依据（否则 todo_* 四条会被误报成手抄残留）。
 */
function assertPromptPhraseTableMatches(names, { phrases = CLI_TOOL_PROMPT_PHRASES, fullNames = names } = {}) {
  const registered = new Set(names);
  const stale = Object.keys(phrases).filter((name) => !new Set(fullNames).has(name));
  if (stale.length > 0) {
    throw new Error(`工具清单短语表里有注册面没有的名字：${stale.join("、")}`
      + "（提示词 ⊄ 注册面：删了工具却留着文案；要么把名字加回注册面，要么删掉这条短语）");
  }
  const missing = [...registered].filter((name) => phrases[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`注册面上的工具没有清单文案：${missing.join("、")}`
      + "（注册面 ⊄ 提示词：宁可抛错，也不要在模型视野里静默少一个工具）");
  }
}

/** 工具清单行：遍历注册面顺序，按分段样式取短语拼接，以「。」收尾（基础段自身是完整句子，issue #69）。 */
function buildCliToolsToolListLine(names, { phrases = CLI_TOOL_PROMPT_PHRASES } = {}) {
  const segments = [];
  let current = null;
  for (const name of names) {
    const entry = phrases[name];
    const style = CLI_TOOL_PROMPT_GROUPS[entry.group];
    if (style === undefined) {
      throw new Error(`工具清单短语表里 "${name}" 的 group "${entry.group}" 不是已知分段`);
    }
    if (current?.group !== entry.group) {
      current = { group: entry.group, parts: [], style };
      segments.push(current);
    }
    current.parts.push(entry.phrase);
  }
  let line = "";
  for (const segment of segments) {
    line += segment.style.lead + segment.parts.join(segment.style.join) + (segment.style.note ?? "");
  }
  return `${line}。`;
}

// ADR-010：「跳了什么 + 怎么撤销」必须进提示词——
// 模型不知道被排除就无从发起取回。排除账同时写在工具结果尾部。
const CLI_TOOLS_SYSTEM_PROMPT_VENDOR =
  "\n搜索与目录类工具（searchText/rg/grep/tree）默认跳过 node_modules、dist、build、target、vendor 与 . 开头的目录（结果尾部会回报跳过数量）；要一起搜传 include_vendor=true、include_hidden=true";

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

/** 默认（含 todo、不含 delegate）注册面上的工具名顺序 = 清单行顺序（issue #312(b)：单一来源）。 */
const CLI_TOOL_NAMES = cliToolDefinitions().map((schema) => schema.name);
const CLI_TOOL_NAMES_NO_TODO = cliToolDefinitions({ todo: false }).map((schema) => schema.name);
const CLI_TOOL_NAMES_DELEGATE = cliToolDefinitions({ delegate: true }).map((schema) => schema.name);
const CLI_TOOL_NAMES_NO_TODO_DELEGATE = cliToolDefinitions({ todo: false, delegate: true })
  .map((schema) => schema.name);
/**
 * **全量注册面**（todo + delegate 都开）——短语表「陈旧」核对的基准集（issue #617 P2）。
 * 短语表是静态表，开关关掉只是本轮少拼一段，不能拿「本轮的面」当陈旧依据；否则 `delegate`
 * 一关就会被误报成手抄残留（与 todo 段同一个坑，见 `assertPromptPhraseTableMatches`）。
 */
const CLI_TOOL_NAMES_FULL = cliToolDefinitions({ todo: true, delegate: true }).map((schema) => schema.name);

export const CLI_TOOLS_SYSTEM_PROMPT = buildCliToolsSystemPrompt();

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

/**
 * 拼 CLI 系统提示（工具清单行由注册面生成，其余段落是固定文案）。
 *
 * @param {boolean} [input.delegate] 是否把 `delegate` 拼进清单行（缺省 false：默认关）。
 * @param {string[]} [input.names] 注册面上的工具名（缺省用真注册面）；测试拿它做变异反证而不动源码。
 * @param {object} [input.phrases] 短语表（缺省 `CLI_TOOL_PROMPT_PHRASES`）。
 * @param {string[]} [input.fullNames] 「陈旧」核对的基准集（缺省 = todo+delegate 全开的全量注册面）。
 */
export function buildCliToolsSystemPrompt({
  todo = true,
  delegate = false,
  names,
  phrases = CLI_TOOL_PROMPT_PHRASES,
  fullNames,
} = {}) {
  // ADR-015：ResourceStore 退出模型视野——所有宿主形态同一份提示词，不提 opaque 工件/路径。
  // issue #69：todo=false 时拼接无 todo 段的基础提示（--no-todo / ERIX_NO_TODO）。
  // issue #617 P2：delegate 默认关 ⇒ 缺省清单行与 0.28.0 发布时**逐字节一致**（golden 钉着）。
  // issue #312(b) R2：清单行由注册面生成（不再手抄），其余段落照旧拼接，输出逐字节不变。
  const todoEnabled = todo !== false;
  const delegateEnabled = delegate === true;
  const effectiveNames = names ?? (todoEnabled
    ? (delegateEnabled ? CLI_TOOL_NAMES_DELEGATE : CLI_TOOL_NAMES)
    : (delegateEnabled ? CLI_TOOL_NAMES_NO_TODO_DELEGATE : CLI_TOOL_NAMES_NO_TODO));
  const effectiveFull = fullNames ?? (names ?? CLI_TOOL_NAMES_FULL);
  assertPromptPhraseTableMatches(effectiveNames, { phrases, fullNames: effectiveFull });
  const list = buildCliToolsToolListLine(effectiveNames, { phrases, fullNames: effectiveFull });
  return list
    + CLI_TOOLS_SYSTEM_PROMPT_VENDOR
    + "。"
    + CLI_TOOLS_SYSTEM_PROMPT_BASE_MIDDLE
    + (todoEnabled ? CLI_TOOLS_SYSTEM_PROMPT_TODO_DISCIPLINE : "")
    + CLI_TOOLS_SYSTEM_PROMPT_BASE_TAIL;
}

export function buildArchiveNotice(archiveDir) {
  if (typeof archiveDir !== "string" || archiveDir.length === 0) return "";
  return "\n\n[工具输出归档]\n大输出已由引擎全量归档。后续需要精确值时先用 note_list 查找记录，再用 note_read 读取；若未记录且无法确定性重算，请省略对应 findings 声明，不要凭记忆补值，也不要重跑命令。";
}




function isBackgroundCommand(command) {
  return command.trim().endsWith("&");
}

function executeExecCommand(input, cwd, execCeilingMs) {
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

  const timeoutMs = getCommandTimeoutMs(command, { ceilingMs: execCeilingMs });
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
    && (name === "exec" || name === "readFile" || name === "writeFile" || name === "edit")
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
  // issue #195：`searchText` 按引擎支持的 `{content, metadata}` 形状返回（跳过账/截断走结构化
  // 字段）。回显取 content，否则终端会打出 `[object Object]`——模型侧不受影响（引擎自己会归一），
  // 但 CLI 是调试器，看不见搜索结果就等于没有。
  const payload = result && typeof result === "object" && !Array.isArray(result)
    && typeof result.content === "string"
    ? result.content
    : result;
  const text = String(payload ?? "");
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


/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {boolean} [options.todo]
 * @param {boolean} [options.delegate] issue #617 P2：是否注册 `delegate`（**默认 false**）。
 *   `true` 时必须同时注入 `delegateTool`——宿主（CLI）用库的 `createDelegateTool` 装配好
 *   `runChild` 再交进来；`bin/` 不自己拼 runChild，也不 import `child_process`。
 * @param {{execute: (input: object, context?: object) => Promise<object>}} [options.delegateTool]
 *   `createDelegateTool(...)` 返回的 `{ definition, execute }`（只取 `execute`：definition 归库，
 *   名字与 schema 从 `cliToolDefinitions` 来，不在两个地方各存一份）。
 * @param {number | null} [options.execCeilingMs] exec 天花板（issue #433 T0）：装配处按 idle 算出的
 *   `execCeilingMsForIdle(...)`；`null`/未传 = 不钳（`getCommandTimeoutMs` 的默认行为）。
 */
export function createCliTools({
  cwd = process.cwd(),
  todo = true,
  delegate = false,
  delegateTool,
  execCeilingMs = null,
} = {}) {
  const root = path.resolve(cwd);
  const todoEnabled = todo !== false;
  const delegateEnabled = delegate === true;
  // 开关与实现必须同侧：一面有工具名、一面没执行器（或反过来）都是「提示词跟注册面各说各话」，
  // 那是装配期错误，宁可当场抛也不要在模型视野里静默少一个工具（issue #312(b) 的同一口径）。
  if (delegateEnabled && (delegateTool === null || typeof delegateTool !== "object"
    || typeof delegateTool.execute !== "function")) {
    throw new TypeError(
      "createCliTools({ delegate: true }) 必须注入 delegateTool（宿主先用 createDelegateTool 装配 runChild）",
    );
  }
  if (!delegateEnabled && delegateTool !== undefined) {
    throw new TypeError("createCliTools 收到 delegateTool 但 delegate !== true：开关与实现必须同侧");
  }
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
    exec: (input, context) => executeExecCommand(input, root, execCeilingMs),
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
  // issue #617 P2：派生工具的执行器由宿主注入（库不 fork / 不 spawn）；本文件只负责把它接进
  // 统一的 `executeTool(name, input, context)` 面，于是 chat 的 combineTools 与 repl 的
  // buildExecuteTool 都不需要为它加分支。
  if (delegateEnabled) {
    executors.delegate = (input, context) => delegateTool.execute(input, context);
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
    // issue #312(b) R2：名字清单走单一来源 `cliToolDefinitions`（与提示词同源）；实现与
    // executor 仍来自 `createFileTools`，这里的 structuredClone 保留（对外形状不得共享引用）。
    tools: cliToolDefinitions({ todo: todoEnabled, delegate: delegateEnabled })
      .map((schema) => structuredClone(schema)),
    executeTool,
    getLastToolMetadata: () => lastToolMetadata,
    truncateResult,
  };
}
