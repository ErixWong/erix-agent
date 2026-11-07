// @ts-check
// `erix chat` 与 `erix repl` 的**同一份**系统提示装配（issue #716）。
//
// 病根：这两条边的 system 提示曾经各抄一遍（`bin/cli.js` 与 `bin/repl.js` 各一处同款代码）。
// 两份抄件的唯一差别是 chat 末尾多一句「每轮先声明计划」——于是任何新段落（本单的项目约定注入）
// 都得改两处，漏一处就是「chat 有、repl 没有」的静默漂移。这里收成一条路：两条边都调
// `buildCliSystemPrompt()`，差别只在参数（`planDirective`）。
//
// 拼接位置：项目约定段拼在 `buildCliToolsSystemPrompt()` 的**结果之外**。那个函数的输出被
// `test/tools.test.js` 钉成逐字节 golden（`buildCliToolsSystemPrompt() === CLI_TOOLS_SYSTEM_PROMPT`），
// `examples/pi-extension` 另有一条「缺省清单行逐字节一致」的断言——动函数内部会撞那批 golden，
// 而本单要的只是「多一段」，不是「改一段」。
//
// 留痕行（`notice`）是**交付物**，不是点缀：transcript 不落 `system`（盘上真产物
// `<runId>.jsonl` 第 0 轮 seed 行只有 user 消息），所以「注入真的发生了」在盘上零痕迹。
// 不打印这一行，就没有任何人能给它作证。调用方负责把它写进 stderr（chat / repl 各一处）。
//
// ── issue #746 评审第 2 轮：这一位是**能力陈述**，刻意只接工具面门、不接账本证据门 ──
// 本节（`buildCliToolsSystemPrompt` 的「你的处境」段 + 「具体数值来源」bullet + `buildArchiveNotice`）
// 只问「整族 `note_*` 在不在注册面上」（`notesOnToolSurface` / 名单那一侧的 `notesOnToolNames` ⇒
// 同一个 `hasNoteToolSurface`），**不**问「这个 run 写过笔记没有」。四条理由（两份架构文档的
// 覆盖面段逐条同步，守卫 `G1b` 逐条钉同步 —— 第 3 轮之前 `reason` 只是个没被断言的字符串）：
//   1. 装配发生在 **run 开始之前**（chat 一次、REPL 会话启动一次），那一层没有账本可拿。拿 #741
//      的四格判它，它只能落在「无笔记写入」那一格——那是把「不知道」伪报成「本场没写过」，恰好是
//      本轮在 guard 那一侧刚修掉的同一个错的镜像（见 `bin/final-guard-support.js` 的 `readLedger`）。
//   2. 这些句子是能力陈述（「本场装配了 `note_*`，需要时先查」），真值只依赖装配事实，而那已接门；
//      那几条动作句也不是存在断言，而是**条件式工作流**——触发条件是「需要早期细节而想不起来时」
//      这个模型自己的状态，不是「笔记里有它」。这一条不写下来，下一个读代码的人就会把它们
//      误读成「已在断言笔记里有」，然后顺手把证据门接上。
//   3. 硬接证据门就要给装配层灌 `messages`（chat 无历史、REPL 得逐轮重装配），换来的只有
//      「整族在场却永远说没写过」这一种新谎。
//   4. 缺省那一份文案是被**逐字节 golden** 钉住的（`buildCliToolsSystemPrompt() === CLI_TOOLS_SYSTEM_PROMPT`、
//      `test/fixtures/cli-golden.json`，`examples/pi-extension` 另有一条「缺省清单行逐字节一致」断言）：
//      接账本门必然重写缺省那一份 ⇒ 拿 #741 四格要求这一位，付的是重烤一批 golden，
//      买回来的仍是第 1 条那句假话。
// `bin/delegation.js` 里子 run 的那一份是同一位点的**子侧**（入口是 `notesOnToolNames`），定性相同。
// **红线（`test/prompt-note-coverage-746.test.js` 的 `G1c` 反向守卫）**：这一位永远不许出现**存在
// 断言**（「你已记录的笔记」「笔记里有」「the notes you recorded」这类）——那些句子的真值需要账本，
// 而这里拿不到。要写存在断言，请把它搬到拿得到 `messages` 的取回指引那三处（guard 摘要 / 打回指针 /
// 折叠桩与恢复提示）。守卫的探针**带 `archiveDir`**：不带的话归档提示根本不在被扫的文本里，
// 那一批文案就处于「看起来钉住了、其实没人看」的状态（第 2 轮实测：归档提示的变异 exit 0）。

import {
  discoverProjectInstructions,
  PROJECT_INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
} from "../src/project-instructions.js";
// issue #746：笔记可用性的判定住在 `src/`（#741 的证据原点）。方向是 **bin ← src**（AGENTS.md §1
// 允许的那一侧）：`bin/` 可以 import `src/`，`src/` 永远不许反过来 import `bin/`。
import { hasNoteToolSurface } from "../src/loop/note-prompt-hint.js";
import { noteToolNamesOnSurface } from "../src/loop/tool-result-ttl.js";
import { buildArchiveNotice, buildCliToolsSystemPrompt } from "./tools.js";

/**
 * 从**装配后的真工具面**现推「笔记工具面在不在」（issue #746 B1/B2/B3 的证据入口）。
 *
 * 为什么要现推而不是直接拿 `--no-notes` 这个旗标：笔记工具可能从三个地方消失——
 * `--no-notes` / `ERIX_NO_NOTES=1`（不装配工厂）、`--tools` 白名单滤掉、子 run 的工具面收窄。
 * 只读一个旗标就会漏后两种。把名字交给 `src/` 的整族口径（全有或全无），与引擎侧同一把尺。
 *
 * @param {Array<{ name?: unknown }> | undefined} tools 本次 run **实际**交给模型的工具面
 * @returns {boolean}
 */
export function notesOnToolSurface(tools) {
  return hasNoteToolSurface(noteToolNamesOnSurface(tools));
}

/**
 * 同一件事的**名单**口径（issue #746 第 3 轮，评审必修①）：手上只有工具**名字**名单时的那一侧。
 *
 * 为什么需要它而不是「叫调用方自己传 `notes`」：子 run 的提示词装配点手上拿的就是
 * `childTools.map(t => t.name)` 那一份名单（清单行也要它）。如果 `notes` 只能靠调用方递，
 * 那么「清单行」与「处境段」就是**从两份输入各自推**的——一份漏了就没人抬杠（第 2 轮评审
 * 当场跑出的就是这个形状：`toolNames: ["readFile"]` 直接调仍出 `note_*`）。现在两侧同源。
 *
 * 口径仍是 `src/` 那一份（整族全有或全无），不在 `bin/` 里另写「名字里带 note 就算」。
 *
 * @param {string[] | undefined} toolNames 本次 run **实际**工具面的名字名单
 * @returns {boolean}
 */
export function notesOnToolNames(toolNames) {
  return hasNoteToolSurface((Array.isArray(toolNames) ? toolNames : []).map(String));
}

/**
 * 同一件事的名字口径（issue #746 B2/B3 递给 `src/` 派生器的那个数组）。
 *
 * @param {Array<{ name?: unknown }> | undefined} tools
 * @returns {string[]}
 */
export function noteToolSurface(tools) {
  return noteToolNamesOnSurface(tools);
}

/** MCP 代理工具的说明段（chat / repl 共用，逐字节保持 0.31.0 的文案）。 */
const MCP_PROXY_NOTICE = `

MCP 代理工具 mcp 可用：action=list 列出所有 MCP 工具；action=search query=关键词 查找工具；action=call server=... tool=... args=... 调用工具。`;

/** 截断声明的段落头（注入正文里的那个标记；测试认它，改文案时别动这个形状）。 */
const TRUNCATED_MARKER = "[项目约定已截断]";

/** 截断声明里最多点名几个被丢弃的小节名（再多就把声明本身撑成新的预算大头；总数仍如实报）。 */
const DROPPED_SECTION_NAME_LIMIT = 12;

/** 2026-09-20 基准实测：模型闷头调工具、计划不可见导致 judge 难判方向 ⇒ 每轮先声明计划。 */
const PLAN_DIRECTIVE = "\n\n每轮开始先用一句话（≤30字）说明当前计划，再调用工具。";

/**
 * 截断声明与 stderr 留痕行共用的「截断事实」短语（issue #721）——三个字节数 + 被丢弃的小节名。
 *
 * 只写一份的原因：模型看见的那句与人看见的那句必须同源，否则两者会漂开（那正是本单在修的病的形状：
 * 信息在 `discoverProjectInstructions()` 里一直有，只是从没交给模型）。
 *
 * 名单只点名前 {@link DROPPED_SECTION_NAME_LIMIT} 个：一份被切了一半的大文件可能有几百个小节，
 * 把名单全拼上去会把「声明」本身撑成新的预算大头。总数始细报出，不假装「就是这些」。
 *
 * @param {import("../src/project-instructions.js").ProjectInstructionFile} file 被截断的那份文件
 * @returns {string} 「全文 / 本次注入 / 丢弃」三个字节数 + 被丢弃的小节名
 */
function formatTruncationFacts(file) {
  const droppedBytes = file.originalBytes - file.bytes;
  const listed = file.droppedSections.slice(0, DROPPED_SECTION_NAME_LIMIT);
  const facts = `全文 ${file.originalBytes} 字节，本次只注入 ${file.bytes} 字节，丢弃 ${droppedBytes} 字节`;
  if (file.droppedSections.length === 0) {
    // 没有可点名的标题（文件不用 `#` 分节，或截断点正落在某个标题行中间）：如实说「点名不了」。
    return `${facts}，被丢弃的部分里没有可点名的 Markdown 小节标题`;
  }
  const names = listed.map((title) => `「${title}」`).join("、");
  const more = file.droppedSections.length > listed.length
    ? ` 等，共 ${file.droppedSections.length} 个`
    : `（共 ${file.droppedSections.length} 个）`;
  return `${facts}，被丢弃的小节：${names}${more}`;
}

/**
 * 模型可见的截断声明（issue #721 的那「必须可见」）。未截断 ⇒ 空串（提示词一个字节都不许多）。
 *
 * 为什么在**注入正文里**而非只上 stderr：留痕行只有人在场时才看得见，而这条边的常态是无人值守；
 * 已有事故——`--no-todo` 的三条断言在 112,464 字节的 `AGENTS.md` 下绿了几个月，只因 `todo_add`
 * 正好落在旧 32 KiB 截断线之外（见 `test/integration/no-todo-switch.test.js` 的账）。被测量对象
 * 不能随「切在哪个字节」而变 ⇒ 模型必须能看见「你拿到的不是全文、丢了哪些小节」。
 *
 * @param {import("../src/project-instructions.js").ProjectInstructionFile} file
 * @returns {string}
 */
function buildTruncationDeclaration(file) {
  if (!file.truncated) return "";
  return `\n\n${TRUNCATED_MARKER} ${formatTruncationFacts(file)}。`
    + "上面那行之后的小节不在本提示里，需要时请直接读取该文件，不要猜测它们的内容。";
}

/**
 * 项目约定段（拼在系统提示最末）。空文件（0 字节）⇒ 空串：**提示词一个字节都不许多**
 * （「已注入 0 字节」这件事由 stderr 留痕行说，不靠往提示词里塞一句废话）。
 *
 * 末那句 `buildTruncationDeclaration()` 就是 issue #721 的「截断必须对模型可见」：它拼在注入正文
 * 里（不只在 stderr），删掉那一行 ⇒ `test/project-instructions-716.test.js` 里那条声明用例会红
 * （常驻变异复证，不允许出现「截断了但没人报错」的绿）。
 *
 * @param {import("../src/project-instructions.js").ProjectInstructionsDiscovery} discovery
 * @returns {string}
 */
export function buildProjectInstructionsSection(discovery) {
  const injected = discovery.files.filter((file) => file.content !== "");
  if (injected.length === 0) return "";
  return injected
    .map((file) => "\n\n[项目约定] 以下内容来自项目根目录的 "
      + `${PROJECT_INSTRUCTIONS_FILENAME}（${file.path}）；与上文冲突时以项目约定为准。`
      + `\n\n${file.content}`
      + buildTruncationDeclaration(file))
    .join("");
}

/**
 * stderr 留痕行。两条分支逐字固定（验收判据就钉在这两行上）：
 *   · 注入了：`[项目约定] 已注入 <n> 个文件 / <字节数> 字节 (<路径列表>)`
 *   · 一个都没有：`[项目约定] 未发现 AGENTS.md`
 *
 * 截断时额外附上与注入声明**同源**的截断事实（全文字节 / 丢弃字节 / 被丢弃的小节名，issue #721）：
 * 旧形状只说「已截断」，不说丢了多大一块、丢了什么，人在 stderr 里也查不到后果。
 *
 * @param {import("../src/project-instructions.js").ProjectInstructionsDiscovery} discovery
 * @returns {string}
 */
export function formatProjectInstructionsNotice(discovery) {
  if (discovery.files.length === 0) {
    const base = `[项目约定] 未发现 ${PROJECT_INSTRUCTIONS_FILENAME}`;
    // 路径在、但读不了（目录 / 权限 …）：说清是「不可用」，不是「这个目录没有约定文件」。
    const skipped = discovery.skipped
      .map((entry) => `${entry.path} 不可用：${entry.code}`)
      .join("，");
    return skipped === "" ? base : `${base}（${skipped}）`;
  }
  const paths = discovery.files.map((file) => file.path).join(", ");
  const base = `[项目约定] 已注入 ${discovery.files.length} 个文件 / ${discovery.totalBytes} 字节 (${paths})`;
  if (!discovery.truncated) return base;
  // 与注入段里那句 `[项目约定已截断]` 同一个派生器：两处不能各说一套（issue #721）。
  const truncatedFile = discovery.files.find((file) => file.truncated);
  const facts = truncatedFile === undefined ? "" : `：${formatTruncationFacts(truncatedFile)}`;
  return `${base}（超过 ${discovery.limit} 字节上限，已截断${facts}）`;
}

/**
 * chat / repl 共用的系统提示装配。
 *
 * @param {object} [input] 选项包（`= {}` 默认值让它可以整体省略；`cwd` 见下）。
 * @param {string} [input.cwd] 本次 run 的工作目录（项目约定的根就是它，不向上走）。
 *   JSDoc 写成可选是为了跟 `= {}` 对齐（`--strict` 下默认值必须可赋给参数类型），
 *   **语义上仍是必填**：缺了它，`discoverProjectInstructions` 会抛中文 `TypeError`。
 * @param {boolean} [input.todo] 是否把 todo 段拼进工具清单（`--no-todo`）。
 * @param {boolean} [input.delegate] 是否把 delegate 拼进清单行（`--delegate`）。
 * @param {string} [input.archiveDir] 工具输出归档目录（`buildArchiveNotice` 用）。
 * @param {boolean} [input.mcpEnabled] MCP 代理工具是否可用。
 * @param {boolean} [input.planDirective] 是否追加「每轮先声明计划」（chat 有、repl 没有）。
 * @param {boolean} [input.agents] 是否注入项目约定（`--no-agents` 传 false）。
 * @param {number} [input.maxBytes] 注入字节上限（测试用；缺省常量）。
 * @param {Array<{ name?: unknown }>} [input.tools] 本次 run **实际**的工具面（issue #746）。
 *   给了它，笔记指引就按**面上的事实**决定（整族 `note_*` 在 ⇒ 沿用原文；不在 ⇒ 一个 `note_*` 都
 *   不出现）。没给 = 不表态 ⇒ 缺省按「有」（既有调用方与 golden 逐字节不变）。
 * @returns {{
 *   systemPrompt: string,
 *   discovery: import("../src/project-instructions.js").ProjectInstructionsDiscovery | null,
 *   notice: string | null,
 * }} `discovery`/`notice` 为 null 表示这一轮**没有做发现**（`--no-agents`），与「发现了 0 个」区分开。
 */
export function buildCliSystemPrompt({
  cwd,
  todo = true,
  delegate = false,
  archiveDir,
  mcpEnabled = false,
  planDirective = false,
  agents = true,
  maxBytes = PROJECT_INSTRUCTIONS_MAX_BYTES,
  tools,
} = {}) {
  // issue #746：`tools` 在场 ⇒ 笔记指引跟着真工具面走；缺席 ⇒ 不表态（缺省「有」）。
  const notes = Array.isArray(tools) ? notesOnToolSurface(tools) : true;
  let systemPrompt = `你是 erix 编码助手，工作目录 ${cwd}。${buildCliToolsSystemPrompt({ todo, delegate, notes })}`;
  systemPrompt += buildArchiveNotice(archiveDir, { notes });
  if (mcpEnabled) systemPrompt += MCP_PROXY_NOTICE;
  if (planDirective) systemPrompt += PLAN_DIRECTIVE;

  const discovery = agents === false ? null : discoverProjectInstructions({ cwd, maxBytes });
  if (discovery !== null) systemPrompt += buildProjectInstructionsSection(discovery);
  return {
    systemPrompt,
    discovery,
    notice: discovery === null ? null : formatProjectInstructionsNotice(discovery),
  };
}
