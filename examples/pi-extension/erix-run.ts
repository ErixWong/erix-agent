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
 *     docs/research/2026-10-13-pi-subagents-async-attribution.md（逐条带 pi-subagents 行号的对照与两侧落点；
 *     本扩展**不 import** pi-subagents，所以是「参考其 UX / 策略自行实现」，不是逐行照搬）
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
  DELIVERABLE_PATHS_LIMIT,
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
  FINAL_GUARD_TIMEOUT_MS,
  FINAL_GUARD_WORST_CASE_MS,
} from "./erix-run-final-guard.js";
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
  finalGuard: Type.Optional(
    Type.Boolean({
      description:
        "**默认关**：终稿核验（finalGuard）。开启时才向 runToolLoop 透传 finalGuard 回调，"
        + "终局 verification 才可能是 verified（默认关时恒 skipped ⇒ end_turn 不是交付证明）。\n"
        + "代价与约束：最坏多 ≤2 个模型往返（引擎 finalGuardMaxRetries 默认 2）+ 最多 3 次 guard 等待；\n"
        + `本层因此**显式**下发 finalGuardTimeoutMs=${FINAL_GUARD_TIMEOUT_MS}（而不是引擎默认的 30_000）：\n`
        + "引擎只在轮边界查截止时间，stop 判定 → guard 之间没有 deadline 检查，默认 30s × 3 会被\n"
        + "本层自己那根挂在 timeoutMs 上的硬 abort 掉 ⇒ 钱花了却拿不到 verified。开启时本层把硬 abort\n"
        + `往后挪 ${FINAL_GUARD_WORST_CASE_MS}ms（= 3 × ${FINAL_GUARD_TIMEOUT_MS}），run 自身截止线不变。\n`
        + "开启后终稿要依次写 ## 取证边界 / ## 基点 / ## 结论 / ## 未验证（提示词里会同步要求），\n"
        + "其中「## 基点」声明的字面值必须在本次工具返回里逐字找得到（唯一的硬闸，对不上就 revise）。",
    }),
  ),
  finalGuardTimeoutMs: Type.Optional(
    Type.Integer({
      minimum: 200,
      maximum: 600_000,
      description:
        `单次 guard 等待上限（毫秒），默认 ${FINAL_GUARD_TIMEOUT_MS}；只在 finalGuard: true 时有意义（没开启时传了会报 bad_params）。`
        + "⚠ 它同时是**交付物判据**的超时（引擎复用同一个旋钮）：一次 attempt 的最坏等待 = 判据条数 × 该上限 + guard 上限。",
    }),
  ),
  // issue #391 R5：交付物机器判据的**命名开关**（不开放宿主自定义 check 函数：跨扩展边界传函数不安全）。
  requireDeliverable: Type.Optional(
    Type.Boolean({
      description:
        "**默认关**：交付物机器判据（`requireDeliverable`）。为 true 时启用一条磁盘事实判据——"
        + "「本次 run 用写工具声明过的每个路径，收尾时都必须真的在盘上」（读 `fileWrites` 原始路径，"
        + "不是 40 码点摘要）。判据跑在 guard **之前**：guard 说 accept 而判据没过 ⇒ `verification` 变成 "
        + "unverified + `reason: \"deliverables_failed\"`（机器证据压过 guard 意见），`termination.reason` 不变。\n"
        + "**必须与 `finalGuard: true` 同用**：判据是拦 guard accept 的闸门，没有 guard 就没有闸门——"
        + "单独开是 bad_params（不静默空转）。\n"
        + "成本：判据与 guard 共享同一个 `finalGuardTimeoutMs` 预算 ⇒ 1 条判据让每次 attempt 的上限多一倍"
        + `（默认 10s ⇒ 最坏额外 ${FINAL_GUARD_WORST_CASE_MS * 2}ms 而不是 ${FINAL_GUARD_WORST_CASE_MS}ms）。\n`
        + "只认真布尔：`\"true\"` / `1` 归 bad_params。本工具**不**接受宿主自定义的 check 函数（跨扩展边界传函数不安全）。\n"
        + "⚠ 它判的是「声明过的写路径还在盘上」，**模型什么都不声明时空集合恒真**（一次工具都没调也能 verified）。"
        + "要「这次必须交付 report.md」请用 `deliverablePaths`——那是另一个问题，不是同一个开关的细化。",
    }),
  ),
  // issue #391 R1：**命名**交付物判据——与上面那个布尔开关是两个不同的问题，两个都要留。
  deliverablePaths: Type.Optional(
    Type.Array(
      Type.String({ minLength: 1 }),
      {
        minItems: 1,
        maxItems: DELIVERABLE_PATHS_LIMIT,
        description:
          "**这次任务必须交付这些文件**（默认关）。每条一个判据：收尾时该路径必须真的在盘上。"
          + "与 `requireDeliverable: true` 的差别是**语义**而不是粒度：布尔那条问「你说过要写的东西还在盘上吗」"
          + "（读 `fileWrites`，模型什么都不声明时空集合恒真 ⇒ 一次工具都没调也能 verified，issue #391 回帖实测）；"
          + "这一条不读模型说了什么，只读你声明的清单 ⇒ 模型啥都没写照样判不过。要「必须交付 report.md」只能用它。\n"
          + "相对路径按本次 run 的 `cwd` 解析（引擎不 join：它把宿主传的 cwd 原样放进 payload，"
          + "没接线时判据拿到 undefined ⇒ 恒 ok:false，见 docs/host-upgrade-guide-0.24.0.md §9）；绝对路径不需要 cwd。\n"
          + `条数 1..${DELIVERABLE_PATHS_LIMIT}（引擎 DELIVERABLES_LIMIT），路径不许重复（判据名 = 路径，引擎要求唯一）；`
          + "非数组 / 空串 / 空数组 / 超限 / 重复均归 bad_params（在宿主侧就挡）。"
          + "**必须与 `finalGuard: true` 同用**（没有 guard 就没有闸门，单独给是 bad_params）。"
          + "判据跑在 guard 之前、与 guard 共享 `finalGuardTimeoutMs` ⇒ 每条判据让每次 attempt 的上限再加一个该上限。",
      },
    ),
  ),
  // issue #322：引擎侧 reflection.judgeDoneAdvisory 的宿主侧口子（与上面的 reflection 三参数同族）。
  judgeDoneAdvisory: Type.Optional(
    Type.Boolean({
      description:
        "**默认关**（引擎缺省也是 false）。开启后，中途治理（judge）判定「目标已达成」时，"
        + "它那句评审意见会作为**一条普通用户文本消息**在下一个安全点递给内层模型（直传引擎 "
        + "reflection.judgeDoneAdvisory），于是模型能知道「为什么说它已经做完了」。\n"
        + "**那是软提示，不是硬停止**：不会打断当前轮、不会拦工具调用、不会提前收尾，"
        + "termination.reason 也不会因此改变（模型收到后继续干活是允许的）。\n"
        + "只在 judge 真的跑了时才生效（maxRounds ≥ 16，且未设 ERIX_NO_REFLECTION=1）；"
        + "judge 没跑时下发里根本不带这个键，终局的 diagnostics.reflection.judgeDoneAdvisory 会写清「没生效」。\n"
        + "只接受 true | false，其他值报 bad_params。",
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
        "查询/控制已派工的 run：status=当前状态与终局四件套；result=完整终局（四件套 + artifacts + diagnostics）；"
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

/**
 * 引擎的验证结论（issue #277：此前只在真值源里、schema 没声明，模型按 schema 读就看不见它）。
 * 形状 = `runToolLoop` 返回的 `verification`（`src/loop/termination.js:271` 处组装：
 * `{...ctx.verification, metrics: {...ctx.guardMetrics}}`），口径见
 * `docs/host-consumer-contract.md`「Final-answer verification」。
 * `status` 是**字符串而不是 enum**：契约现有四值（`verified`/`skipped`/`unverified`/`error`），
 * 但引擎加第五个值时不该让这条已发布承诺反过来变成「视图比 schema 多」的新漂移（本单修的就是这个方向）。
 */
const verificationSchema = Type.Object({
  status: Type.String({
    description:
      "引擎对最终答案的验证结论：verified / skipped / unverified / error（缺 finalGuard 时是 skipped + reason=no_final_guard）。"
      + "end_turn 不是交付证明——只有 verified 才可当已验证事实消费。",
  }),
  reason: Type.Optional(Type.String()),
  detail: Type.Optional(Type.String()),
  // 引擎的 guardMetrics 计数（verified/skipped/revised/unverified/guard_error），键集随引擎演进，故用 Record。
  metrics: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

/**
 * 抛错路径的结构化错误（issue #277：`buildErrorPayload` 一直在给，schema 从来没声明）。
 * 只在**错误路径**出现，成功载荷里没有这个键——所以它是 Optional，而不是「改软」。
 */
const errorPayloadSchema = Type.Object({
  name: Type.String(),
  message: Type.String(),
  code: Type.Optional(Type.String()),
  stage: Type.Optional(Type.String()),
});

const payloadSchema = Type.Object({
  ok: Type.Boolean(),
  finalText: Type.String(),
  rounds: Type.Integer(),
  truncated: Type.Boolean(),
  usage: usageSchema,
  termination: terminationSchema,
  // issue #277：这两个键真值源（core 的 `buildSuccessPayload`/`buildErrorPayload`）一直在给，
  // 异步视图（#276 起从真值源派生）也一直在投，而 schema 漏声明 → 按 schema 读的宿主会看不见。
  // 两个都是 Optional：`verification` 在早退路径上可以是 undefined（JSON 里不落这个键），
  // `error` 只在抛错路径出现——声明在场不等于把缺省语义改软。
  verification: Type.Optional(verificationSchema),
  error: Type.Optional(errorPayloadSchema),
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
 * 本工具的 `outputSchema` 只描述**同步终局面**（#207 定的形状；#234 只加了异步面与参数面，
 * #277 在上面补了真值源一直在给的 `verification` 与 `error`——additive，已有键一字未动）。
 * 异步派工句柄与 `action` 查询结果的可机读数据放在 `AgentToolResult.details` 里
 * （照 pi-subagents 的 `result.details.progress` 口径），文本面在 `content`。
 * 理由：MCP 的 outputSchema 根节点得是 object，把异步面塞进同一个 schema 要么把同步终局的字段
 * 全改 optional（把「同步终局一定有四件套」这条承诺改软），要么上 Union（未验证 pi 会不会二次校验）。
 * issue #277：同步终局面本身是 **15 个键**（含 `verification` 与错误路径的 `error`）——数字写在这里
 * 会过期，真正的看守是 `test/examples/erix-run-pi-load.test.js` 那条「`SYNC_RESULT_FIELDS` ⊆
 * `outputSchema.properties` 的键」锚点（真值源加字段而 schema 不补 → 当场红）。
 */

export const erixRunTool = defineTool({
  name: "erix_run",
  label: "Erix run",
  description:
    "把一个自包含的编码任务交给内嵌的 erix-agent headless 运行时执行：它会在给定目录里跑完整的"
    + "多轮工具循环（readFile/rg/grep/tree/writeFile/exec），自己读写文件并执行命令。"
    + "返回结构化终局 {finalText, rounds, usage, termination, verification, artifacts, extensionCount, maxExtensions, resumable, diagnostics, timeout}；"
    + "termination.reason 是引擎裁决（end_turn/judge_done/no_tool/stall/max_rounds_cap/aborted/failed…），"
    + "失败时读 termination.errorCode 再决定重试；verification.status 是引擎对最终答案的验证结论（只有 verified 可当已验证事实，end_turn 本身不是）；artifacts 给出过程产物（transcript / judge.log）的真路径，未落盘为 null。"
    + "async:true 时立即返回句柄 {runId,status,cwd,model,maxRounds,sessionDir,statusPath}（主会话不阻塞），"
    + "之后用 action:\"status\"/\"result\"/\"list\"/\"cancel\" 查与控；完成时终局摘要会作为通知回到本会话。"
    + "每次调用都是一次完整多轮 run，成本不低。",
  promptSnippet: "把自包含的编码子任务交给内嵌 erix-agent 多轮执行（绝对 cwd；async:true 派工即返回）",
  promptGuidelines: [
    "erix_run 的 cwd 必须是绝对路径，task 必须自包含（内层 run 看不到本次会话历史）。",
    "erix_run 每次调用都是一次完整多轮 run（多次模型调用）；只在任务确实需要多轮自主执行时用。",
    "erix_run 返回 ok:false 时先读 termination.reason / termination.errorCode / diagnostics 再决定下一步，别盲目重跑。",
    "erix_run 的 verification.status 是引擎的验证结论（verified/skipped/unverified/error）：只有 verified 才可当已验证事实消费；缺 finalGuard 时恒为 skipped，end_turn 本身不是交付证明。",
    "要过期内审内层过程时传 sessionDir：返回的 artifacts.transcriptPath / artifacts.judgeLogPath 是真路径（null = 本次没落盘）。",
    "erix_run 的终局不可续跑（resumable 恒 false）；要重试就重跑一次，别期待 resume。扩轮只在 maxRounds ≥ 16 开了 judge 后才会发生。",
    "要「派工即返回、不阻塞主会话」就传 async:true 并带上 sessionDir，拿住返回的 runId；之后用 action:\"status\" 查进度、action:\"result\" 取终局四件套 + artifacts、action:\"cancel\" 取消（终局记成 aborted）。",
    "async:true 的后台 run 与 pi 同进程：pi 退出或 /reload 会杀掉它，status.json 只留下最后一个已知状态（不会自动续跑）。一次派一批且不想被打断时传 quiet:true（成功的完成不唤醒你，失败/中止仍然唤醒）。",
    "收到 [erix_run <runId>] 的完成通知后，用 action:\"result\" 取完整终局再决定下一步；别只凭通知里的一行摘要下结论。",
    // #276：异步终局视图（status/result/status.json）与同步返回同形（含 diagnostics），所以上面那条
    // 「ok:false 先读 termination.errorCode / diagnostics」在异步面同样成立——别拿「那是同步面的字段」当借口。
    "erix_run 的异步终局视图与同步返回同形（syncOnlyFields 为空）：action:\"status\"/\"result\" 与 <sessionDir>/outputs/<runId>/status.json 都带 diagnostics（含 notesLifecycle），/reload 后从盘上读也一样。",
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
