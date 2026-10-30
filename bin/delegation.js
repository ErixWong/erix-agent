// @ts-check
/**
 * issue #617（P2）——CLI 侧的 `delegate` 装配：**可运行的示例 + 验证器**，不是新契约面。
 *
 * 边界（写在文件头上，免得下一个人以为这里可以长成产品面）：
 *   - 库只承担三件事：`config.run.parentRunId`（P0）、簿记三件套（P1a：名册 / 配额租约 / 完成通知
 *     去重）、`createDelegateTool`（P1b：一个工具五个动作）。**子 run 怎么跑起来、跑在哪、
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
 *   2. **子 run 落自己的 transcript**：`<rosterDir>/transcripts/`，不是父的 `--dir`。
 *      CLI 的会话 id 由 cwd 派生，父子同 cwd ⇒ **同一个会话文件名**；子 run 若追加进父的会话文件，
 *      父的 `-c` / `-r` 与 resume 账本会被子 run 的轮次污染（`test/cli-delegate-617.test.js` 钉着
 *      「派生一次后父会话文件里不出现子 run 的行」）。
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
import { createCliAssemblyRoot } from "./assembly-root.js";
import { buildCompactionContext, splitCompactionContext } from "./config.js";
import { buildCaptureRecoveryHint, buildCaptureStub } from "./final-guard.js";
import { buildArchiveNotice, buildCliToolsSystemPrompt, createCliTools, wrapExecuteTool } from "./tools.js";

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
 * @param {{ cwd: string, todo?: boolean, archiveDir?: string }} options
 * @returns {string}
 */
export function buildChildSystemPrompt({ cwd, todo = true, archiveDir } = {}) {
  return `你是 erix 的子 run（父 run 派生的一次性任务执行者），工作目录 ${cwd}。`
    + buildCliToolsSystemPrompt({ todo, delegate: false })
    + buildArchiveNotice(archiveDir)
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
  clock,
} = {}) {
  if (typeof buildProvider !== "function") {
    throw new TypeError("createCliDelegation: buildProvider 必须是函数（模型名只能来自配置）");
  }
  if (typeof cwd !== "string" || cwd === "") {
    throw new TypeError("createCliDelegation: cwd 必须是非空字符串");
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
    const compaction = buildCompactionContext(
      config,
      undefined,
      config.contextWindowTokens
        ? ({ foldedPayload }) => buildCaptureRecoveryHint({
          archiveDir: assembly.archiveDir,
          foldedPayload,
          store: assembly.store,
          runId,
        })
        : undefined,
      ({ content }) => buildCaptureStub({ content }),
    );
    const { data: compactionData, hooks: compactionHooks } = splitCompactionContext(compaction);

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
        tools: [...childCliTools.tools, ...childNotes.definitions],
        config: {
          input: {
            system: buildChildSystemPrompt({ cwd: root, todo: todoEnabled, archiveDir: assembly.archiveDir }),
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
    ...(clock === undefined ? {} : { clock }),
  });

  return {
    definition: delegate.definition,
    execute: delegate.execute,
    rosterDir: resolvedRosterDir,
    runChild,
  };
}
