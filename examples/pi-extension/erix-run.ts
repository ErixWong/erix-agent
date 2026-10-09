/**
 * erix_run — pi extension：pi 原生工具内嵌 erix-agent 库（「pi 调度 erix 修代码」的正式形态）。
 *
 * 与 ./erix-run-core.js 的分工：本文件只做 pi 侧接线（工具注册、参数 schema、进度通道
 * onUpdate、结果形状）；内层 run 的装载/装配/终局裁决全在 core 里（无 pi 依赖，node --test 可测）。
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
 * 待实测项（README 有清单）：onUpdate 在 RPC/print 模式下的可见性、structuredContent 是否被二次校验。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_ROUNDS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  STRATEGY_NAMES,
  formatPayloadForModel,
  runErixRun,
  toPiUsage,
} from "./erix-run-core.js";

/** 进度窗口保留的行数（onUpdate 的 partial 结果整体替换上一次显示）。 */
const PROGRESS_WINDOW = 12;
/** 进度上报的最小间隔（毫秒）：内层事件很密，别把 pi 的渲染刷爆。 */
const PROGRESS_THROTTLE_MS = 150;

const parameters = Type.Object({
  task: Type.String({
    description:
      "交给内层 erix run 的自包含任务描述（要改什么、判据是什么）。内层 run 没有本次会话的记忆，必要上下文必须写进 task。",
  }),
  cwd: Type.String({
    description: "内层 run 的工作目录：已存在的绝对路径（~ 前缀会展开）。内层只在这里读写与执行命令。",
  }),
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
      description: `硬超时（毫秒），默认 ${DEFAULT_TIMEOUT_MS}（10 分钟）；到点 abort 内层 run 并在返回里标注 timeout:true。`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "覆盖 ~/.erix/config.json slots.default 里的 model 名（endpoint/apiKey 仍走该槽位）。",
    }),
  ),
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

const payloadSchema = Type.Object({
  ok: Type.Boolean(),
  finalText: Type.String(),
  rounds: Type.Integer(),
  truncated: Type.Boolean(),
  usage: usageSchema,
  termination: terminationSchema,
  timeout: Type.Boolean(),
  aborted: Type.Boolean(),
  diagnostics: Type.Optional(Type.Unknown()),
});

export const erixRunTool = defineTool({
  name: "erix_run",
  label: "Erix run",
  description:
    "把一个自包含的编码任务交给内嵌的 erix-agent headless 运行时执行：它会在给定目录里跑完整的"
    + "多轮工具循环（readFile/rg/grep/tree/writeFile/exec），自己读写文件并执行命令。"
    + "返回结构化终局 {finalText, rounds, usage, termination, diagnostics, timeout}；"
    + "termination.reason 是引擎裁决（end_turn/judge_done/no_tool/stall/max_rounds_cap/aborted/failed…），"
    + "失败时读 termination.errorCode 再决定重试。每次调用都是一次完整多轮 run，成本不低。",
  promptSnippet: "把自包含的编码子任务交给内嵌 erix-agent 多轮执行（需要绝对 cwd）",
  promptGuidelines: [
    "erix_run 的 cwd 必须是绝对路径，task 必须自包含（内层 run 看不到本次会话历史）。",
    "erix_run 每次调用都是一次完整多轮 run（多次模型调用）；只在任务确实需要多轮自主执行时用。",
    "erix_run 返回 ok:false 时先读 termination.reason / termination.errorCode / diagnostics 再决定下一步，别盲目重跑。",
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

    let payload;
    try {
      payload = await runErixRun(params, {
        // 取消语义：pi 的工具取消信号直连内层 run 的 AbortController；
        // 缺位时回退到当前 run 的 signal（ExtensionContext.signal）。
        signal: signal ?? ctx?.signal,
        onProgress,
      });
    } catch (error) {
      // 兜底：core 设计上不抛，真抛了也不能把 pi 带崩。
      return {
        content: [{
          type: "text",
          text: `erix_run 内部异常：${error instanceof Error ? error.message : String(error)}`,
        }],
        details: { crashed: true },
        isError: true,
      };
    }

    flush(true);

    const result: AgentToolResult<unknown> = {
      content: [{ type: "text", text: formatPayloadForModel(payload) }],
      details: payload,
      structuredContent: payload,
    };
    // 用户主动取消不算工具失败（那是人的决定）；其余非采纳终局报成 isError，让模型看得见。
    if (payload.ok !== true && payload.aborted !== true) {
      result.isError = true;
    }
    const usage = toPiUsage(payload.usage);
    if (usage !== undefined) result.usage = usage;
    return result;
  },
});

export default function (pi: ExtensionAPI) {
  // 工厂里不起定时器/监听器（生命周期规则）：所有资源都在 execute() 内部创建并在 finally 里释放。
  pi.registerTool(erixRunTool);
}
