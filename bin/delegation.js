// @ts-check
/**
 * issue #617（P2）——CLI 侧的 `delegate` 装配：**可运行的示例 + 验证器**，不是新契约面。
 *
 * 边界（写在文件头上，免得下一个人以为这里可以长成产品面）：
 *   - 库只承担三件事：`config.run.parentRunId`（P0）、簿记三件套（P1a：名册 / 配额租约 / 完成通知
 *     去重）、`createDelegateTool`（P1b：一个工具五个动作；#626 C1 又加了一个**读面** `tail`——
 *     有界地读子 run 的 transcript 尾部，让父看得见「子在干什么」，与 `cancel` 不同：它不看本进程的
 *     `owned` 表，别的进程养的子一样读得到）。**子 run 怎么跑起来、跑在哪、
 *     怎么唤醒父 run，全部归宿主**——本文件就是那个宿主，且只服务 `erix` 这个调试/验证前端。
 *   - 所以这里**不新增任何 `src/` 导出**、不改 `package.json`、不 import `child_process`：
 *     子 run 是**同进程嵌套的 `runToolLoop`**（v1 明确不做子进程 / 守护进程）。理由不是省事：
 *     同进程嵌套让「父 run 的 provider / 凭据 / 工具实现」原样复用，也让 `cancel` 能真的 abort
 *     到子 run 的 signal 上；子进程形态要另外解决凭据传递、孤儿回收、跨进程名册锁——那是另一张票。
 *
 * 三条 v1 硬边界（都写进注释与升级指南，**不静默**）：
 *   1. **子 run 的工具集不含 `delegate`**——v1 禁止递归派生。装配时直接
 *      `createCliTools({ delegate: false })`，并且子 run 的系统提示也走
 *      `buildCliToolsSystemPrompt({ delegate: false })`：工具面与提示词同一侧，不留「提示词说有、
 *      工具面没有」的缝（那会让模型反复调一个不存在的工具）。
 *      **并且子的权限只能等于或小于父**（issue #630 S1）：父的 `--tools` 白名单经 `toolAllowlist`
 *      下传，子工具集套同一个 `filterToolsByAllowlist`；以前子无条件拿全量（含 `exec`），
 *      父收窄权限时子反而扩权。
 *   2. **子 run 落自己的 transcript**：`<rosterDir>/transcripts/`，不是父的 `--dir`。
 *      CLI 的会话 id 由 cwd 派生，父子同 cwd ⇒ **同一个会话文件名**；子 run 若追加进父的会话文件，
 *      父的 `-c` / `-r` 与 resume 账本会被子 run 的轮次污染（`test/cli-delegate-617.test.js` 钉着
 *      「派生一次后父会话文件里不出现子 run 的行」）。**并且这个位置必须登记进名册**（#626 C1 的
 *      真机缺陷）：路径由 `transcriptPath(childTranscriptDir, runId)` 算（store 自己的命名口径，
 *      含 `safeRunId` 哈希，不手拼 `runId + ".jsonl"`），经 `transcriptPathFor` 交给库，由库在
 *      **创建记录的那一次写**里落进 `transcriptPath`。不登记的话父 run 的 `action="tail"` 永远
 *      报 `no_transcript_path`——库不知道宿主把子写在哪，而它不可能猜对。
 *   3. **唤醒 = 宿主回调**（`notify`）：v1 没有「往运行中的父 run 里塞一条 user 消息」的邮箱，
 *      引擎也没有那个能力。后台子 run 完成时库调 `notifyParent(一行式文本)`，CLI 把它打到 stderr；
 *      模型侧靠 `delegate action=result` 自取终局（自取过就不再唤醒，去重归库）。
 *      把这条说清楚比假装有邮箱重要：**没有邮箱就不假装有**。
 *
 * 终止词汇：`runChild` 返回 `termination` 必须是库的词汇（`TERMINATION_TO_STATE` 的 key，
 * 见 `src/tools/delegation/tool.js`）。引擎抛的带 `termination` 的错误在这里**归一成正常返回**——
 * abort / timeout 是「子 run 的结局」，不是宿主的异常。
 *
 * 零运行时依赖：只用 `node:` 内置 + 仓内相对路径；纯 ESM。
 */

import { homedir } from "node:os";
import path from "node:path";

import {
  createBuiltinNotesTools,
  runToolLoop,
} from "../src/index.js";
import { createDelegateTool } from "../src/tools/index.js";
import { transcriptPath } from "../src/store/file.js";
import { createCliAssemblyRoot } from "./assembly-root.js";
import { buildCompactionContext, resolveCompactionBudget, splitCompactionContext } from "./config.js";
import { buildCaptureRecoveryHint, buildCaptureStub } from "./final-guard.js";
// issue #746（评审必修 2 → 第 3 轮必修①）：子的提示词必须跟**子的真工具面**，口径与父侧同一份。
// `notesOnToolSurface`（工具对象）与 `notesOnToolNames`（名字名单）是同一把尺的两张入口，
// 真值都在 `src/loop/note-prompt-hint.js` 的 `hasNoteToolSurface`（整族全有或全无）。
// ⚠ 这一行本来就是**漏掉的**：`noteToolSurface` 在本文件被调用却从未 import，子 run 一折叠就
// `ReferenceError`（守卫与用例见 `test/prompt-note-delegate-ledger-746.test.js`）。
import { noteToolSurface, notesOnToolNames } from "./system-prompt.js";
import {
  buildArchiveNotice,
  buildCliToolsSystemPrompt,
  CLI_TOOL_NAMES_FULL,
  CLI_TOOL_PROMPT_PHRASES,
  createCliTools,
  filterToolsByAllowlist,
  wrapExecuteTool,
} from "./tools.js";

/** 并发配额默认值（与 `createDelegateTool` 的 `maxConcurrent` 缺省一致，两处都是 2）。 */
export const DEFAULT_DELEGATE_MAX_CHILDREN = 2;

/**
 * 单个子 run 的默认时间预算（10 分钟）：透传成 `runChild` 的 `deadlineMs`（**时长**，不是时刻），
 * 再在这里换算成引擎要的绝对死线 `config.timing.deadlineMs`（引擎读的是 epoch 毫秒）。
 */
export const DEFAULT_DELEGATE_TIMEOUT_MS = 600_000;

/** 名册目录的环境变量覆盖口（默认 `~/.erix/delegation/`）。 */
export const DELEGATION_DIR_ENV = "ERIX_DELEGATION_DIR";

/**
 * 宿主侧的**存活谓词**（issue #630 S2 / D）：`createDelegateTool` 的 `isProcessAlive` 端口。
 *
 * 判据（三档，写在明面上）：
 *   · `process.kill(pid, 0)` 成功 ⇒ 活（signal 0 不送信号，只做权限/存在性检查）；
 *   · 抛 `EPERM` ⇒ **活**（进程存在，只是本用户没权限向它发信号）；
 *   · 抛 `ESRCH` ⇒ 死（没有这个进程）；
 *   · 其余错误码（以及非正整数的 pid）⇒ **算活**。最后一条是刻意的 fail-safe：库拿这个谓词判死
 *     并写 `interrupted`，所以只有「确知没有这个进程」（`ESRCH`）才允许说死；一个不认识的错误
 *     码不许变成「别人家的活子被写成死的」的理由（宁可留脏记录）。
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

/**
 * 名册目录解析：显式参数 > `ERIX_DELEGATION_DIR` > `~/.erix/delegation`。
 * 测试必须走显式参数（临时目录），不许污染真实 `~/.erix`。
 *
 * @param {string} [explicit]
 * @returns {string} 绝对路径
 */
export function resolveDelegationDir(explicit) {
  if (typeof explicit === "string" && explicit.trim() !== "") return path.resolve(explicit);
  const fromEnv = process.env[DELEGATION_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(homedir(), ".erix", "delegation");
}

/**
 * 子 run 的 system prompt：与父同一套装配，但 `delegate: false`（v1 不递归派生）。
 *
 * @param {{ cwd: string, todo?: boolean, archiveDir?: string, toolNames?: string[], notes?: boolean }} options
 * @param {string[]} [options.toolNames] 子 run **实际**拿到的工具名（issue #630 S1；第 3 轮起它同时是
 *   这一位**唯一**的工具面事实）。给了它，两件事都从这份名单现推：
 *   ① 清单行只列其中**有清单文案**的那些名字（父的 `--tools` 白名单已把子工具面收窄时，提示词必须
 *   同一侧——否则就是「提示词说有、工具面没有」的缝，模型会反复调一个不存在的工具）；
 *   ② `notes`（整族 `note_*` 在不在面上）。第 2 轮以前 `notes` 缺省写死「有」，于是
 *   `buildChildSystemPrompt({ toolNames: ["readFile"] })` 仍命令模型去调三个场上不存在的工具——
 *   集成用例当时能过，只是因为调用方另外显式传了 `notes`，不是这一位自己推得出来。
 *   不给（缺省）= 旧行为：列 todo+delegate:false 的完整注册面，`notes` 按缺省装配面（有整族笔记），
 *   逐字节不变（golden 钉着）。
 * @param {boolean} [options.notes] 整族 `note_*` 在不在子的工具面上（issue #746，评审必修 2）。
 *   **显式传它 = 覆盖上面那条推导**（调用方手上有比名字名单更全的事实时才用，例如装配后的工具对象）。
 *   缺省时从 `toolNames` 现推（`notesOnToolNames` ⇒ `src/` 的整族口径 `hasNoteToolSurface`，全有或全无），
 *   两个都不给才落回「有」——那是缺省装配面的事实，不是假设。
 *   口径不许自己拼：`--tools` 白名单、`--no-notes`、子面收窄三条路都能让整族消失，只看旗标会漏。
 * @returns {string}
 */
export function buildChildSystemPrompt({ cwd, todo = true, archiveDir, toolNames, notes } = {}) {
  // issue #746 第 3 轮（评审必修①）：`toolNames` 是**一份**事实，不是两份。
  // 名单在场就从它现推 `notes`（窄名单 ⇒ 一个 `note_*` 都不出现），缺席才落回缺省装配面的「有」。
  const surfaceNames = Array.isArray(toolNames) ? toolNames : undefined;
  const hasNotes = notes !== undefined
    ? notes !== false
    : (surfaceNames === undefined ? true : notesOnToolNames(surfaceNames));
  // ⚠ 清单行只列**有清单文案**的那些名字：`note_*` 从来不在 CLI 注册面里（它们由笔记工厂装配，
  // 父侧清单行同样不列它们），把它们塞进 `names` 会让 `assertPromptPhraseTableMatches` 当场抛
  // 「注册面上的工具没有清单文案」——白名单里点名了笔记工具的子 run 会直接 `failed`。
  const listNames = surfaceNames
    ?.filter((name) => CLI_TOOL_PROMPT_PHRASES[name] !== undefined)
    ?? undefined;
  return `你是 erix 的子 run（父 run 派生的一次性任务执行者），工作目录 ${cwd}。`
    + buildCliToolsSystemPrompt({
      todo,
      delegate: false,
      notes: hasNotes,
      // `names` 收窄清单行时 `fullNames` 必须显式给全量注册面：短语表是静态表，
      // 拿收窄后的名单当「陈旧」基准会把没被选中的工具短语误报成手抄残留。
      ...(listNames === undefined ? {} : { names: listNames, fullNames: CLI_TOOL_NAMES_FULL }),
    })
    + buildArchiveNotice(archiveDir, { notes: hasNotes })
    + "\n\n每轮开始先用一句话（≤30字）说明当前计划，再调用工具。";
}

/**
 * 装配 CLI 的 `delegate` 工具。
 *
 * @param {Object} options
 * @param {(model?: string) => object} options.buildProvider 取 provider：`model` 为 undefined 时给
 *   当前这个（父 run 用的），否则按同一个槽位配置另造一个——**模型名永远来自配置**，
 *   这里不出现任何字面模型名（AGENTS §8 红线）。
 * @param {object} options.config CLI 已解析的配置（`maxOutputTokens` / `contextWindowTokens` /
 *   `compaction` 等；子 run 与父同一份槽位）。
 * @param {string} options.cwd 父 run 的工作目录（子 run 未指定 `cwd` 时沿用它）。
 * @param {boolean} [options.todo] 子 run 是否带 todo 四件套（跟随父的 `--no-todo`）。
 * @param {string} [options.notesDir] notes 目录（子 run 的 scope = 子 runId，与父不共享 scope）。
 * @param {string} [options.rosterDir] 名册目录；缺省 `resolveDelegationDir()`。
 * @param {number} [options.maxChildren] 并发配额（缺省 {@link DEFAULT_DELEGATE_MAX_CHILDREN}）。
 * @param {number} [options.defaultDeadlineMs] 模型没给 `deadlineMs` 时的默认预算。
 * @param {number} [options.maxRounds] 子 run 的轮数上限（缺省沿用父的）。
 * @param {(line: string) => void} [options.notify] 后台子 run 完成时的父侧唤醒（缺省 stderr）。
 * @param {(line: string) => void} [options.childToolOutput] 子 run 的工具回显（缺省 stderr）。
 * @param {string} [options.toolAllowlist] 父会话的 `--tools` 白名单（**与 `bin/cli.js` 解析出来的那个
 *   字符串同源**，issue #630 S1）。给了它，子 run 的工具面就套同一个 `filterToolsByAllowlist`
 *   （复用现成函数，不另写过滤），于是一条原则在结构上成立：**子的权限只能等于或小于父**。
 *   不给（缺省）= 旧行为：父子都全量。未知工具名走 `filterToolsByAllowlist` 既有的
 *   `onUnknown` 语义（见 `onUnknownTool`），不另造警告。
 * @param {(line: string) => void} [options.onUnknownTool] `toolAllowlist` 里出现未知工具名时的
 *   告警通道（缺省 stderr；与 `bin/cli.js` 父侧过滤用的是同一条文案）。
 * @param {number} [options.compactBudget] 父侧的**显式**压缩预算（`--compact-budget <tokens>`，issue
 *   #630 S2 / F）：给了它就下传给子 run 的 `buildCompactionContext`（子以前拿的是 `undefined`，
 *   于是父显式给的预算在子那一侧完全丢失，只剩 `config.contextWindowTokens` 推出来的自动值）。
 *   缺省 `undefined` ⇒ 子侧行为与接线前逐字一致。`config` 里 `contextWindowTokens` 等继承关系不动。
 * @param {(pid: number) => boolean} [options.isProcessAlive] 存活谓词（issue #630 S2 / D）：缺省就是
 *   本文件导出的 {@link isProcessAlive}（真 `process.kill(pid, 0)`）。测试可注入假谓词。
 * @param {() => number} [options.clock] 宿主时钟（测试注入；名册时间戳全走它）。
 * @returns {{
 *   definition: object,
 *   execute: (input: object, context?: object) => Promise<object>,
 *   rosterDir: string,
 *   runChild: (request: object) => Promise<{text: string, termination?: *, verification?: *}>,
 * }}
 */
export function createCliDelegation({
  buildProvider,
  config = {},
  cwd,
  todo = true,
  notesDir,
  rosterDir,
  maxChildren = DEFAULT_DELEGATE_MAX_CHILDREN,
  defaultDeadlineMs = DEFAULT_DELEGATE_TIMEOUT_MS,
  maxRounds,
  notify = (line) => console.error(line),
  childToolOutput = (line) => console.error(line),
  toolAllowlist,
  onUnknownTool = (line) => console.error(line),
  compactBudget,
  isProcessAlive: isProcessAliveOption = isProcessAlive,
  clock,
} = {}) {
  if (typeof buildProvider !== "function") {
    throw new TypeError("createCliDelegation: buildProvider 必须是函数（模型名只能来自配置）");
  }
  if (typeof cwd !== "string" || cwd === "") {
    throw new TypeError("createCliDelegation: cwd 必须是非空字符串");
  }
  if (isProcessAliveOption !== undefined && typeof isProcessAliveOption !== "function") {
    throw new TypeError("createCliDelegation: isProcessAlive 必须是函数（宿主提供存活谓词）");
  }
  const resolvedRosterDir = resolveDelegationDir(rosterDir);
  const parentCwd = path.resolve(cwd);
  const todoEnabled = todo !== false;
  const deadlineDefault = Number.isFinite(defaultDeadlineMs) && defaultDeadlineMs > 0
    ? defaultDeadlineMs
    : DEFAULT_DELEGATE_TIMEOUT_MS;

  /**
   * 子 run 的落盘位置：**从名册目录派生**（不是父的 `--dir`）。
   * 父子同 cwd 时 CLI 的会话 id 会一样，共用目录就是互踩；分目录是这条的修法本身。
   */
  const childTranscriptDir = path.join(resolvedRosterDir, "transcripts");

  /**
   * 宿主注入给库的 `runChild`：同进程嵌套的真 `runToolLoop`（v1 不 fork）。
   *
   * @param {{task: string, cwd?: string, parentRunId?: string, runId: string, model?: string,
   *          deadlineMs?: number, signal: AbortSignal}} request
   * @returns {Promise<{text: string, termination?: *, verification?: *}>}
   */
  const runChild = async ({ task, cwd: childCwd, parentRunId, runId, model, deadlineMs, signal }) => {
    // `cwdFor`（宿主端口，issue #630 S1）已经把绝对路径算好、并且**同一个值**写进了名册；
    // 对已经是绝对路径的值 `path.resolve` 是恒等变换，所以「记录的那个」与「执行的那个」逐字相同。
    const root = path.resolve(childCwd ?? parentCwd);
    // 子 run 的端口：transcript / archive / notes store 全部落在自己的 runId 下。
    const assembly = createCliAssemblyRoot({
      dir: childTranscriptDir,
      runId,
      cwd: root,
      notesDir,
    });
    // 工具集：文件工具 + exec + todo（跟随父开关），**不含 delegate**（v1 禁止递归派生）。
    const childCliTools = createCliTools({ cwd: root, todo: todoEnabled, delegate: false });
    const childNotes = createBuiltinNotesTools({
      runId,
      notesDir: assembly.notesDir,
      notesStore: assembly.notesStore,
    });
    /**
     * 子工具面（issue #630 S1，C）：**子的权限只能等于或小于父**。
     * 父的 `--tools` 白名单以前只裁父自己的面，子 run 无条件拿全量（含 `exec`）——
     * 父收窄权限时子反而扩权。修法不是另写一套过滤，而是把同一个 `filterToolsByAllowlist`
     * （`bin/tools.js` 的现成函数，`onUnknown` 语义也照旧）套在子工具集上。
     * `delegate` 先从未集里剔掉再过滤：v1 不递归，它**永远**不下传（即使 allowlist 点名它）。
     * 注意 allowlist 为 undefined 时 `filterToolsByAllowlist` 原样返回 ⇒ 父子都全量（旧行为）。
     * 边界：若 allowlist 把子工具集滤到空（如父只开 `delegate`），`filterToolsByAllowlist`
     * 会按它既有的语义抛错 ⇒ 子 run 落 `failed` 并在 `errorMessage` 里点名原因；
     * 这是诚实的：子拿不到任何工具时不该装作能干活。
     */
    const childToolUniverse = [...childCliTools.tools, ...childNotes.definitions]
      .filter((tool) => tool.name !== "delegate");
    const childTools = filterToolsByAllowlist(childToolUniverse, toolAllowlist, { onUnknown: onUnknownTool });
    const childToolNames = childTools.map((tool) => tool.name);
    const notesToolNames = new Set(childNotes.definitions.map((tool) => tool.name));
    const bridge = async (name, input, context) => (
      notesToolNames.has(name)
        ? childNotes.executors(name, input, context)
        : childCliTools.executeTool(name, input, context)
    );
    const echoTool = wrapExecuteTool(bridge, {
      // 子 run 的工具回显走 stderr 并带前缀：它不该混进父 run 的 stdout 终稿。
      output: (line) => childToolOutput(`[${runId}] ${line}`),
      returnMetadata: true,
    });

    // 压缩口径与父同一份配置（子 run 也可能跑长任务）；恢复提示落在子 run 自己的归档里。
    // issue #630 S2 / F：父的**显式**预算（`--compact-budget`）必须下传——以前这一位写死 `undefined`，
    // 于是父显式给的预算在子侧静默丢失（子的 `buildCompactionContext` 只能看 `config.contextWindowTokens`
    // 推出来的自动值）。
    // issue #682：预算次序与父侧**同一个实现**（`resolveCompactionBudget`：旗标 > 配置叶子 > 派生 > 关闭），
    // 恢复提示的开关也从它派生。子 run 的**记录**带上预算值与来源（`budgetTokens` / `budgetSource`），
    // 于是「父与子的预算为什么不一样」在名册里读得到，不用猜。
    const childBudget = resolveCompactionBudget(config, compactBudget);
    const compaction = buildCompactionContext(
      config,
      compactBudget,
      childBudget.budgetTokens !== undefined
        ? ({ foldedPayload }) => buildCaptureRecoveryHint({
          archiveDir: assembly.archiveDir,
          foldedPayload,
          store: assembly.store,
          runId,
          // issue #746（B2/B3）：子 run 的取回指引跟**子的工具面**走（父的 `--tools` 可能把笔记滤掉）。
          noteTools: noteToolSurface(childTools),
        })
        : undefined,
      ({ content }) => buildCaptureStub({ content }, { noteTools: noteToolSurface(childTools) }),
    );
    const { data: compactionData, hooks: compactionHooks } = splitCompactionContext(compaction);

    /**
     * 子 run 的系统提示（issue #630 S1）：提示词与工具面必须同一侧。白名单收窄了工具集时，
     * 清单行也只列收窄后的名字（`toolNames`），todo 那一句跟着「todo 工具还在不在」走；
     * allowlist 缺省时**不传** `toolNames` ⇒ 旧提示词逐字不变。
     *
     * issue #746（第 2 轮必修 2 → 第 3 轮必修①）：`notes` **不再单独递**。第 2 轮这里另算了一次
     * `notesOnToolSurface(childTools)` 再递进去，于是「清单行用哪份面」与「处境段用哪份面」是
     * **两份输入**：调用方漏一份，builder 就默默回到「有笔记」，而集成用例照旧绿（它只断言结果，
     * 看不见哪份输入被漏）。现在只递**一份**名单（`childToolNames` = 子装配后的真工具面），
     * 清单行与 `notes` 都在 `buildChildSystemPrompt` 里从它现推：一个事实源，两个投影。
     * 子侧折叠桩 / 恢复提示仍走 `noteToolSurface(childTools)`，那是同一份面的工具对象那一侧。
     *
     * ⚠ 这里递的是**未过滤**的 `childToolNames`（含 `note_*`）：「哪些名字进清单行」是提示词
     * 自己的事（`buildChildSystemPrompt` 里按短语表筛）——把筛名单放到调用方，就会连被筛掉的
     * 笔记工具一起递没，`notes` 当场推成 false（笔记工具真的在场时反而说「本场没装配笔记工具」）。
     * 短语表核对（`assertPromptPhraseTableMatches`）只吃有清单文案的名字，否则当场抛错 ⇒ 子 run `failed`。
     */
    const childPromptOptions = {
      cwd: root,
      archiveDir: assembly.archiveDir,
      ...(toolAllowlist === undefined || toolAllowlist === null
        ? { todo: todoEnabled }
        : {
          todo: todoEnabled && childToolNames.some((name) => name.startsWith("todo_")),
          toolNames: childToolNames,
        }),
    };

    // `deadlineMs` 是**时长**（库的 `runChild` 契约，名册里 `deadlineAt = now + deadlineMs`），
    // 引擎读的 `config.timing.deadlineMs` 是**绝对时刻**——这里换一次，不在别处再换。
    const budgetMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : deadlineDefault;

    try {
      const result = await runToolLoop({
        provider: buildProvider(model),
        store: assembly.store,
        diagnostics: assembly.diagnostics,
        executeTool: echoTool,
        signal,
        tools: childTools,
        config: {
          input: {
            system: buildChildSystemPrompt(childPromptOptions),
            initialUserMessage: task,
          },
          run: {
            runId,
            // issue #617 P0 的叶子：子 run 的发起者关联（opaque，引擎只镜像不解释）。
            ...(parentRunId === undefined ? {} : { parentRunId }),
            cwd: root,
            ...(maxRounds === undefined ? {} : { maxRounds }),
            // 子 run 是工人：v1 不跑反思 / judge（省一次主力模型调用，也让终局词汇收敛到 end_turn）。
            reflection: false,
            // 也不套父 run 的「完成信号 / 连续无工具 N 轮」启发式：子 run 的停机判据就是模型自己的
            // end_turn（`completion: false`）。把父的启发式搬进来会让「一次问答」被推着多跑几轮，
            // 而子 run 的轮次预算（`maxRounds`）本来就是硬上限，不需要再加一层软闸。
            completion: false,
          },
          metadata: { task },
          tuning: { maxTokens: config.maxOutputTokens },
          timing: { deadlineMs: Date.now() + budgetMs },
          folding: {
            ...(compactionData === undefined ? {} : { context: compactionData }),
          },
        },
        capabilities: {
          hooks: {
            ...(compactionHooks ?? {}),
          },
        },
      });
      return {
        text: result.finalText,
        termination: result.termination?.reason,
        verification: result.verification,
        // issue #682：子 run 记录里的预算事实（值 + 来源四态）。库只把它当 opaque 字段落名册，
        // 不解释；父的 `delegate action="result"` 因此读得到「子到底按什么预算折」。
        budgetTokens: childBudget.budgetTokens,
        budgetSource: childBudget.source,
      };
    } catch (error) {
      // abort / timeout / 轮数耗尽：引擎抛的错上带 `termination` ⇒ 这是子 run 的**结局**，
      // 归一成正常返回，交给库的映射表落名册（`TERMINATION_TO_STATE`）。没有 `termination` 的
      // 才是宿主异常（provider 崩、磁盘坏），原样上抛 ⇒ 名册落 failed 并带错误文本。
      if (error?.termination?.reason !== undefined) {
        return {
          text: error.finalText ?? "",
          termination: error.termination.reason,
          verification: error.verification,
          budgetTokens: childBudget.budgetTokens,
          budgetSource: childBudget.source,
        };
      }
      throw error;
    }
  };

  const delegate = createDelegateTool({
    runChild,
    rosterDir: resolvedRosterDir,
    maxConcurrent: maxChildren,
    notifyParent: notify,
    // issue #626 C1：把子 run 的落盘位置**登记**进名册（库在创建记录时填 `transcriptPath`），
    // 否则父 run 的 `tail` 恒报 `no_transcript_path`（真机缺陷现场）。路径必须走 store 自己的命名
    // 口径（`safeRunId` 会把不安全 id 哈希成 `run-h-<sha256>`，手拼 `${runId}.jsonl` 对那类 id 恒错）。
    transcriptPathFor: (runId) => transcriptPath(childTranscriptDir, runId),
    // issue #630 S1（B）：名册里的 `cwd` 必须是**实际生效**的那个路径。库不知道宿主把相对路径
    // 解析到哪、也不猜缺省目录是谁，所以策略由宿主给：这里解析成绝对路径（不给 cwd 就用父 cwd），
    // 库用同一个值**既写名册、又交给 `runChild`**。以前名册里 `cwd` 缺省（`null`），而子实际在父树
    // 里跑——真机复现过：不传 cwd 时子把文件写进了父工作树，名册却什么都没说。
    cwdFor: (requested) => path.resolve(requested ?? parentCwd),
    // issue #630 S2 / D：把存活谓词接到库的 `reconcile` 上。不接它，任何「活态 + 不在本进程 owned」
    // 的记录都会被判 `interrupted`——两个并发 CLI 会话共用同一个名册目录（缺省 `~/.erix/delegation/`）
    // 时，B 只要调一次 `status`，A 养着的活子就会被改写成死的（真机复现过）。
    isProcessAlive: isProcessAliveOption,
    ...(clock === undefined ? {} : { clock }),
  });

  return {
    definition: delegate.definition,
    execute: delegate.execute,
    rosterDir: resolvedRosterDir,
    runChild,
  };
}
