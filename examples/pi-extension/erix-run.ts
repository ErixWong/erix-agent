/**
 * erix_run — pi extension：pi 原生工具内嵌 erix-agent 库（「pi 调度 erix 修代码」的正式形态）。
 *
 * 与 ./erix-run-core.js 的分工：本文件只做 pi 侧接线（工具注册、参数 schema、进度通道
 * onUpdate、结果形状、异步派工的 parent-wake 投递）；内层 run 的装载/装配/终局裁决全在 core 里，
 * 异步 job 的注册表/落盘/取消/看门狗在 ./erix-run-jobs.js，唤醒双分支在 ./erix-run-parent-wake.js
 * （三者都不 import pi，`node --test` 可测）。
 *
 * pi API 逐条出处（docs/extensions.md / dist 类型 / 官方示例；没出处的一律没接）：
 *   - 注册与最小工具形状：examples/extensions/hello.ts（defineTool + pi.registerTool）
 *   - execute 签名 (toolCallId, params, signal, onUpdate, ctx)：
 *     dist/core/extensions/types.d.ts:492 ToolDefinition.execute
 *   - 进度通道 onUpdate(partial AgentToolResult)：AgentToolUpdateCallback + examples/extensions/shutdown-command.ts:48
 *   - 失败但不抛：AgentToolResult.isError（docs/extensions.md「return the result with isError: true instead of throwing」）
 *   - 结构化结果：outputSchema + structuredContent（同上，programmatic callers 收 structuredContent）
 *   - 嵌套模型调用的用量：AgentToolResult.usage（docs「include their usage in the result so session totals remain accurate」）
 *   - 取消：execute 的 signal，缺位时回退 ctx.signal（types.d.ts:239 ExtensionContext.signal）
 *   - 并发：executionMode:"sequential"（types.d.ts:490，内层 run 是重活，不并排跑）
 *   - annotations 是提示而非边界（docs「Tool exposure」），权限由宿主扩展决定
 *   - 唤醒父会话：pi.sendMessage(message, {triggerTurn, deliverAs}) types.d.ts:1234 /
 *     pi.sendUserMessage(content, {deliverAs:"steer"}) types.d.ts:1243 /
 *     ctx.isIdle() types.d.ts:236；生命周期 pi.on("session_start"|"agent_start"|"session_shutdown")
 *     types.d.ts:1165/1184/1172（SessionStartEvent.reason 含 "reload"、SessionShutdownEvent 同）
 *   - 机制出处（为什么是双分支 + pending 窗口 + 去重）：
 *     docs/tasks/active/261010-13-erix-run-async/analysis.md（照 pi-subagents 的逐行实现）
 * 待实测项（README 有清单）：onUpdate 在 RPC/print 模式下的可见性、structuredContent 是否被二次校验。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TIMEOUT_MS,
  ENGINE_DEFAULT_MAX_EXTENSIONS,
  MAX_EXTENSION_STEP,
  MAX_MAX_EXTENSIONS,
  MAX_MAX_ROUNDS_CAP,
  MAX_MAX_ROUNDS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  STRATEGY_NAMES,
} from "./erix-run-core.js";
import {
  createAsyncRuntime,
  globalAsyncJobRegistry,
  globalCompletionSendRegistry,
} from "./erix-run-jobs.js";
import {
  formatAsyncResult,
  formatCrashResult,
  formatSyncResult,
} from "./erix-run-format.js";
import { createParentWake } from "./erix-run-parent-wake.js";

/** 进度窗口保留的行数（onUpdate 的 partial 结果整体替换上一次显示）。 */
const PROGRESS_WINDOW = 12;
/** 进度上报的最小间隔（毫秒）：内层事件很密，别把 pi 的渲染刷爆。 */
const PROGRESS_THROTTLE_MS = 150;
/** 完成通知的消息类型（pi 用它挑 renderer；本扩展没注册 renderer，按普通消息显示）。 */
const NOTIFY_CUSTOM_TYPE = "erix-run-notify";
/** `action` 的取值（R2：同一个工具加参数，不另注册工具——理由见 README「为什么是一个工具」）。 */
export const ACTIONS = ["status", "result", "list", "cancel"] as const;

const parameters = Type.Object({
  task: Type.Optional(Type.String({
    description:
      "交给内层 erix run 的自包含任务描述（要改什么、判据是什么）。内层 run 没有本次会话的记忆，必要上下文必须写进 task。"
      + "派工必填；只带 action 的查询/取消调用不用传。",
  })),
  cwd: Type.Optional(Type.String({
    description: "内层 run 的工作目录：已存在的绝对路径（~ 前缀会展开）。内层只在这里读写与执行命令。派工必填。",
  })),
  maxRounds: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_MAX_ROUNDS,
      description: `内层工具循环的轮数预算，默认 ${DEFAULT_MAX_ROUNDS}；≥16 会自动开启 judge（额外模型调用）。`,
    }),
  ),
  strategy: Type.Optional(
    StringEnum([...STRATEGY_NAMES], {
      description:
        "上下文压缩策略（引擎内置名）。不传就走引擎缺省；缺预算元数据时压缩整轮关闭。"
        + "fold-llm 每压缩一次多花一次主力模型调用。",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      description: `硬超时（毫秒），默认 ${DEFAULT_TIMEOUT_MS}（10 分钟）；到点 abort 内层 run 并在返回里标注 timeout:true。`
        + "异步派工时这个定时器归 run 级看门狗持有（派工调用早已返回，到点仍会把终局写成 aborted 并落进 status.json）。",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "覆盖 ~/.erix/config.json slots.default 里的 model 名（endpoint/apiKey 仍走该槽位）。",
    }),
  ),
  sessionDir: Type.Optional(
    Type.String({
      description:
        "过程落盘目录（已存在的或可创建的绝对路径，~ 前缀会展开）：给定了就把内层 transcript 落到 "
        + "<sessionDir>/<runId>.jsonl、judge 决策与终局汇总落到 <sessionDir>/outputs/<runId>/judge.log，"
        + `并在返回的 artifacts 里给出真路径。不传 = 纯内存、不落盘（缺省）。也可写 transcript:"file" 走缺省目录 ~/.erix/transcripts。`
        + "异步派工时强烈建议传：status.json 落在同一棵树的 <sessionDir>/outputs/<runId>/status.json，"
        + "扩展 /reload 之后只有它还查得到这个 run。",
    }),
  ),
  transcript: Type.Optional(
    Type.String({
      description:
        'sessionDir 的同义写法："file" = 用缺省目录 ~/.erix/transcripts；其它非空串按目录路径处理；'
        + '"memory"/"none"/"off" = 显式不落盘。两个都给时 sessionDir 赢。',
    }),
  ),
  maxExtensions: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_MAX_EXTENSIONS,
      description:
        `扩轮上限，直传引擎 reflection.maxExtensions。只在 judge 开启时生效（maxRounds ≥ 16，且未设 ERIX_NO_REFLECTION=1）；`
        + `**0 是有效值，意思是「关掉扩轮」**；不传则用引擎缺省 ${ENGINE_DEFAULT_MAX_EXTENSIONS}。`,
    }),
  ),
  maxRoundsCap: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_MAX_ROUNDS_CAP,
      description:
        "扩轮后的总轮数硬顶，直传引擎 reflection.maxRoundsCap（正整数；引擎会抬到不低于 maxRounds，不传则用引擎缺省 256）。",
    }),
  ),
  extensionStep: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_EXTENSION_STEP,
      description:
        "每次扩轮加的轮数，直传引擎 reflection.extensionStep（正整数；不传则用引擎缺省 max(8, ⌊maxRounds/2⌋）。",
    }),
  ),
  // —— issue #234：异步执行面 ——
  async: Type.Optional(Type.Boolean({
    description:
      "true = 派工即返回句柄 {runId,status,cwd,model,maxRounds,timeoutMs,sessionDir,statusPath}，主会话不阻塞；"
      + "内层 run 在**同进程**后台跑，终局经通知回到本会话。缺省 false = 原有同步语义（等到底才返回）。"
      + "⚠ pi 进程退出 / 扩展 /reload 会杀掉后台 run（跨重启恢复不在本能力面内）。",
  })),
  quiet: Type.Optional(Type.Boolean({
    description:
      "只在 async:true 时有意义：成功的完成**不唤醒**父会话（只落 status.json），失败/中止仍然唤醒。"
      + "一次派一批切片时用它免得把主会话打断成筛子。缺省 false。",
  })),
  action: Type.Optional(
    StringEnum([...ACTIONS], {
      description:
        "查询/控制已派工的 run：status=当前状态与终局四件套；result=完整终局（四件套 + artifacts）；"
        + "list=本进程已知 run 的摘要表；cancel=把 signal 打进内层 run、终局记成 aborted。"
        + "status/result/cancel 要带 runId（list 不用）。",
    }),
  ),
  runId: Type.Optional(Type.String({
    description: 'action 要操作的 run id（就是 async:true 返回的句柄里的 runId）。',
  })),
});

const usageSchema = Type.Object({
  input_tokens: Type.Number(),
  output_tokens: Type.Number(),
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
});

const terminationSchema = Type.Object({
  reason: Type.String(),
  detail: Type.Optional(Type.String()),
  // #176：只有 reason === "failed" 才带 errorCode。
  errorCode: Type.Optional(Type.String()),
});

const artifactsSchema = Type.Object({
  // 未落盘（没传 sessionDir）或文件没真写出来时是 null，不是编造的路径。
  transcriptPath: Type.Union([Type.String(), Type.Null()]),
  judgeLogPath: Type.Union([Type.String(), Type.Null()]),
});

const payloadSchema = Type.Object({
  ok: Type.Boolean(),
  finalText: Type.String(),
  rounds: Type.Integer(),
  truncated: Type.Boolean(),
  usage: usageSchema,
  termination: terminationSchema,
  timeout: Type.Boolean(),
  aborted: Type.Boolean(),
  // issue #207 R4：决策事实。
  artifacts: artifactsSchema,
  extensionCount: Type.Integer(),
  maxExtensions: Type.Integer(),
  resumable: Type.Boolean(),
  diagnostics: Type.Optional(Type.Unknown()),
});

/**
 * 本工具的 `outputSchema` 只描述**同步终局面**（#207/#234 之后的现状，形状与 #207 逐字相同）。
 * 异步派工句柄与 `action` 查询结果的可机读数据放在 `AgentToolResult.details` 里
 * （照 pi-subagents 的 `result.details.progress` 口径），文本面在 `content`。
 * 理由：MCP 的 outputSchema 根节点得是 object，把异步面塞进同一个 schema 要么把 13 个字段
 * 全改 optional（把「同步终局一定有四件套」这条承诺改软），要么上 Union（未验证 pi 会不会二次校验）。
 */

export const erixRunTool = defineTool({
  name: "erix_run",
  label: "Erix run",
  description:
    "把一个自包含的编码任务交给内嵌的 erix-agent headless 运行时执行：它会在给定目录里跑完整的"
    + "多轮工具循环（readFile/rg/grep/tree/writeFile/exec），自己读写文件并执行命令。"
    + "返回结构化终局 {finalText, rounds, usage, termination, artifacts, extensionCount, maxExtensions, resumable, diagnostics, timeout}；"
    + "termination.reason 是引擎裁决（end_turn/judge_done/no_tool/stall/max_rounds_cap/aborted/failed…），"
    + "失败时读 termination.errorCode 再决定重试；artifacts 给出过程产物（transcript / judge.log）的真路径，未落盘为 null。"
    + "async:true 时立即返回句柄 {runId,status,cwd,model,maxRounds,sessionDir,statusPath}（主会话不阻塞），"
    + "之后用 action:\"status\"/\"result\"/\"list\"/\"cancel\" 查与控；完成时终局摘要会作为通知回到本会话。"
    + "每次调用都是一次完整多轮 run，成本不低。",
  promptSnippet: "把自包含的编码子任务交给内嵌 erix-agent 多轮执行（绝对 cwd；async:true 派工即返回）",
  promptGuidelines: [
    "erix_run 的 cwd 必须是绝对路径，task 必须自包含（内层 run 看不到本次会话历史）。",
    "erix_run 每次调用都是一次完整多轮 run（多次模型调用）；只在任务确实需要多轮自主执行时用。",
    "erix_run 返回 ok:false 时先读 termination.reason / termination.errorCode / diagnostics 再决定下一步，别盲目重跑。",
    "要过期内审内层过程时传 sessionDir：返回的 artifacts.transcriptPath / artifacts.judgeLogPath 是真路径（null = 本次没落盘）。",
    "erix_run 的终局不可续跑（resumable 恒 false）；要重试就重跑一次，别期待 resume。扩轮只在 maxRounds ≥ 16 开了 judge 后才会发生。",
    "要「派工即返回、不阻塞主会话」就传 async:true 并带上 sessionDir，拿住返回的 runId；之后用 action:\"status\" 查进度、action:\"result\" 取终局四件套 + artifacts、action:\"cancel\" 取消（终局记成 aborted）。",
    "async:true 的后台 run 与 pi 同进程：pi 退出或 /reload 会杀掉它，status.json 只留下最后一个已知状态（不会自动续跑）。一次派一批且不想被打断时传 quiet:true（成功的完成不唤醒你，失败/中止仍然唤醒）。",
    "收到 [erix_run <runId>] 的完成通知后，用 action:\"result\" 取完整终局再决定下一步；别只凭通知里的一行摘要下结论。",
  ],
  parameters,
  outputSchema: payloadSchema,
  executionMode: "sequential",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    // 内层只动本地工作目录 + 一次 relay 调用，不带外部世界副作用（openWorld 语义按 MCP 口径留给真外部调用）
    openWorldHint: false,
  },

  async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
    const lines: string[] = [];
    let lastEmit = 0;
    const flush = (force: boolean) => {
      if (onUpdate === undefined) return;
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      onUpdate({
        content: [{ type: "text", text: lines.slice(-PROGRESS_WINDOW).join("\n") }],
        details: { progressLines: lines.length, tail: lines.slice(-PROGRESS_WINDOW) },
      });
    };
    const onProgress = (line: string) => {
      lines.push(line);
      // 进度缓冲自身也要封顶，长 run 不能把内存吃穿
      if (lines.length > PROGRESS_WINDOW * 20) lines.splice(0, lines.length - PROGRESS_WINDOW * 20);
      flush(false);
    };

    let outcome;
    try {
      // 分流（同步 / 异步派工 / action 查询）全在 erix-run-jobs 的 runtime 里，本文件只负责形状。
      outcome = await asyncRuntime().dispatch(params ?? {}, {
        // 取消语义：pi 的工具取消信号直连内层 run 的 AbortController；
        // 缺位时回退到当前 run 的 signal（ExtensionContext.signal）。
        // ⚠ async:true 时这个 signal **不接**：它在本次工具调用结束时就失效了，
        //    后台 run 的取消通道是 action:"cancel"。
        signal: signal ?? ctx?.signal,
        onProgress,
      });
    } catch (error) {
      // 兜底：core/jobs 设计上不抛，真抛了也不能把 pi 带崩。
      // details 只放纯数据（#237：宿主序列化 details 时会抛 Converting circular structure to JSON）。
      return formatCrashResult(error instanceof Error ? error.message : String(error));
    }

    if (outcome?.kind !== "sync") {
      return formatAsyncResult(outcome);
    }

    const payload = outcome.payload;
    flush(true);

    const result: AgentToolResult<unknown> = formatSyncResult(payload);
    // 用户主动取消不算工具失败、非采纳终局报 isError：判定在 formatSyncResult 里（与 details 同处）。
    return result;
  },
});

// ---------------------------------------------------------------------------
// pi 侧接线：注册表 / 唤醒 / 生命周期
//
// 生命周期规矩（analysis §6）：**不在 factory 里起定时器/进程/监听**。factory 只 registerTool
// 与 pi.on(...)（pi.on 是扩展的正常机制，pi-subagents 同样在 factory 里挂）；定时器只在真的
// 派工之后由 job 持有，session_shutdown 做幂等清理。
// ---------------------------------------------------------------------------

/** 当前扩展实例的唤醒器与异步运行时（session_start 时绑定 ctx，缺位时首次调用惰性建）。 */
let wake: ReturnType<typeof createParentWake> | undefined;
let runtime: ReturnType<typeof createAsyncRuntime> | undefined;
let piRef: ExtensionAPI | undefined;

function sendNotify(job: object, content: string, options: { triggersTurn: boolean, outcome: string }) {
  const pi = piRef;
  if (pi === undefined) return false;
  const message = { customType: NOTIFY_CUSTOM_TYPE, content, display: true };
  try {
    if (wake === undefined) {
      // 没走过 session_start（例如测试装载器直接调 execute()）：只追加，不硬触发一轮。
      pi.sendMessage(message, { triggerTurn: false });
    } else {
      wake.sendMessage(message, { triggerTurn: options.triggersTurn });
    }
    return true;
  } catch {
    // 投不出去：去重注册表要把它让给下一次重试（照 pi-subagents sendCompletion 的 try/catch 口径）
    return false;
  }
}

function asyncRuntime() {
  if (runtime === undefined) {
    runtime = createAsyncRuntime({
      registry: globalAsyncJobRegistry(),
      sendRegistry: globalCompletionSendRegistry(),
      notify: sendNotify,
    });
  }
  return runtime;
}

/**
 * `action` / 句柄结果 / 同步终局 → `AgentToolResult` 的组装已搬到 `./erix-run-format.js`（#237）：
 * 那里不 import pi，所以每一条返回路径的「details 必须可 JSON 序列化」能被 `node --test` 离线钉住
 * （→ test/examples/erix-run-details.test.js）。本文件只负责接线。
 */

export default function (pi: ExtensionAPI) {
  // 工厂里不起定时器/监听器（生命周期规则）：定时器由 job 在真正派工时创建。
  piRef = pi;
  pi.registerTool(erixRunTool);

  // 唤醒器在 session_start 绑 ctx（不在 factory）：reservation 挂在 Symbol.for + WeakMap，
  // 所以 /reload 之后新建的唤醒器仍拿得到同一个 sessionManager 的 pending 状态。
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    wake = createParentWake(pi);
    wake.bindSession(ctx as never);
    asyncRuntime();
  });

  // 唤醒已经换来一轮 → 清 pending（照 pi-subagents extension/index.js:1031 的同一条）。
  pi.on("agent_start", () => {
    wake?.agentStarted();
  });

  pi.on("session_shutdown", (event) => {
    // 幂等清理：定时器清掉、唤醒 pending 按 reload 与否分别处理；重复调用不抛。
    asyncRuntime().shutdown();
    wake?.sessionShutdown((event as { reason?: string })?.reason);
  });
}
