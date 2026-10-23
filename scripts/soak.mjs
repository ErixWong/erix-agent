#!/usr/bin/env node
// scripts/soak.mjs — 长跑 soak（issue #257 T6 / 工单 261015-02）。
// 定位：**只观察引擎，不修改引擎**。发现缺陷只写进报告（只报不修）。
// 红线：零 npm 运行时依赖（只用 node: 内置 + 相对路径）、纯 ESM、Node 22、
//       绝不写真实 ~/.erix（store 走临时目录）、源码里不出现任何模型名。
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  buildTimeline,
  canonicalToAnthropicRequest,
  canonicalToOpenAIMessages,
  createAnthropicProvider,
  createFileTranscriptStore,
  createOpenAIProvider,
  estimateTokens,
  extractL0Facts,
  KitError,
  projectTranscriptForDisplay,
  runToolLoop,
  TOOL_RESULT_CONTRACT,
  validateMessages,
} from "../src/index.js";

// 中止/重试路径上，被抛弃的 in-flight 请求可能在 run 已经收口之后才拒绝。Node 22 默认
// `--unhandled-rejections=throw` 会**直接把进程打死**（真机 soak 实测：abort 之后报告根本没写出来）。
// 这里先接住并记进报告：soak 的职责是测量它，不是被它杀掉。
// 记账必须留够**形态**信息（工单 #290 返工第 4 条）：只有已知的「被抛弃请求 = KitError(code:"aborted")」
// 才算引擎观察项，其余未处理拒绝一律算 soak 自己的阻断性缺陷（不能再一律 blocking:false）。
const unhandledRejections = [];
process.on("unhandledRejection", (error) => {
  unhandledRejections.push({
    message: String(error?.message ?? error),
    name: error?.name,
    code: error?.code,
    isKitError: error instanceof KitError,
    phase: error?.phase,
    status: error?.status,
    reason: error?.termination?.reason,
  });
});

// 白名单（工单 #290 返工第 4 条）：只认「被抛弃的 in-flight 请求在 abort 之后拒绝」这一种已知形态，
// 它的正身是 provider 分类路径产出的 KitError("aborted")（src/providers/errors.js:174，
// 由 src/loop/provider-runner.js 的 abort 竞态抛到进程顶层）。
function isKnownAbandonedRequestRejection(entry) {
  return entry?.isKitError === true
    && entry?.name === "KitError"
    && entry?.code === "aborted";
}

// ---------------------------------------------------------------- CLI

const USAGE = `用法：node scripts/soak.mjs [--provider fake|real] [--rounds n] [--store dir]
        [--out file] [--compact-every n] [--abort-at n] [--slot name] [--keep-store]

  --provider      fake = 注入脚本化假上游（不联网，CI/无 key 可用）；real = 真模型（默认）
  --rounds        长轮回放轮数（默认 200）
  --store         transcript store 目录（默认临时目录；**绝不写真实 ~/.erix**：落在它下面或等于它一律拒绝）
  --out           结构化 JSON 报告落盘路径（默认 /tmp/soak-report.json；同样不得落在真实 ~/.erix 下）
  --compact-every 每 n 轮逼一次强制压缩（把 budgetTokens 调到必然触发；默认 25）
  --abort-at      中止阶段开关与触发点（0=跳过；默认 rounds>=4 时启用，rounds<4 时跳过）：
                  不给本参数 = 在**第 min(ceil(rounds/2),3) 个已落地的 tool_result 事件**之后立刻 abort
                    （按事件触发：真模型会在任意早的轮次自然 end_turn/judge_done，按轮触发永远可能扑空）；
                  显式 --abort-at n = 改回**第 n 轮**触发（轮数语义，n>=rounds 也照跑不静默跳过）；
                    真没中止成时 abort-actually-fired 会判红，而不是把「没发生的中止」报成引擎缺陷
  --slot          real 路径读 config 的槽位名（默认 default）
  --keep-store    跑完**保留**临时 store 目录（默认真清理；显式 --store 指定的目录永远不动，
                  那是宿主自己的地盘，soak 只清理自己 mkdtemp 出来的那一个）
`;

// 红线：绝不写真实 `~/.erix`（工单 #290 返工第 3 条）。前一版对 --store/--out 没有任何归属校验，
// `--store ~/.erix/soak` 会把 soak 的 jsonl/snapshot 直接写进用户的真实档案里。
// 判定用**解析后的绝对路径**（相对路径、`..`、符号链接前的字面路径都先规范化），
// 且「等于」与「在其之下」都算命中。
function realErixHome() {
  const home = process.env.HOME ?? os.homedir();
  return path.resolve(home, ".erix");
}

function underRealErixHome(raw, label) {
  const resolved = path.resolve(raw);
  const erixHome = realErixHome();
  if (resolved === erixHome || resolved.startsWith(erixHome + path.sep)) {
    throw new Error(
      `${label} 不能落在真实 ~/.erix 之下（红线：soak 绝不写用户档案）：` 
      + `${label}=${raw} → ${resolved}，erixHome=${erixHome}；换一个临时目录`,
    );
  }
  return resolved;
}

function parseCli() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      provider: { type: "string" },
      rounds: { type: "string" },
      store: { type: "string" },
      out: { type: "string" },
      "compact-every": { type: "string" },
      "abort-at": { type: "string" },
      slot: { type: "string" },
      help: { type: "boolean", default: false },
      "keep-store": { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const rounds = Number.parseInt(values.rounds ?? "200", 10);
  const compactEvery = Number.parseInt(values["compact-every"] ?? "25", 10);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds 必须是 >=1 的整数");
  if (!Number.isInteger(compactEvery) || compactEvery < 1) {
    throw new Error("--compact-every 必须是 >=1 的整数");
  }
  const provider = values.provider ?? "real";
  if (provider !== "fake" && provider !== "real") {
    throw new Error('--provider 只接受 "fake" 或 "real"');
  }
  const abortAtExplicit = values["abort-at"] !== undefined;
  const abortAt = abortAtExplicit
    ? Number.parseInt(values["abort-at"], 10)
    : (rounds >= 4 ? Math.ceil(rounds / 2) : 0);
  if (abortAtExplicit && (!Number.isInteger(abortAt) || abortAt < 0)) {
    throw new Error("--abort-at 必须是 >=0 的整数");
  }
  // 归属校验放在解析阶段：干净拒绝（顶层 catch → exit 2 + USAGE），不是一句 ENOENT 也不是静默照跑。
  const store = values.store === undefined ? undefined : underRealErixHome(values.store, "--store");
  const out = underRealErixHome(values.out ?? "/tmp/soak-report.json", "--out");
  // 中止触发点的形状（工单 261015-02 小修）：
  // - **默认**（不给 --abort-at）：第 `min(abortAt, 3)` 个**已落地的 tool_result 事件**之后立刻 abort。
  //   按事件而不是按轮：真模型会在任意早的轮次自然 `end_turn`/`judge_done`，「第 abortAt 轮」这种
  //   轮数触发在大 rounds 下永远可能扑空（实测 `--rounds 200 --abort-at 100` 的那份报告第 7 轮就收口，
  //   abort 从未发生，却被旧版的 `?? cli.abortAt` 兑底报成「第 100 轮中止 + #282 复现」）。
  // - **显式 `--abort-at n`**：保留轮数语义（第 n 轮的 `onRound` 里 abort），给需要精确形状的宿主。
  //   `n >= rounds` 不再静默当成「跳过」（那等于要验的东西根本没验），而是照跑；真没踩到就让
  //   `abort-actually-fired` 判红。只有显式 `--abort-at 0` 才是跳过。
  const effectiveAbortAt = abortAtExplicit ? abortAt : (abortAt >= rounds ? 0 : abortAt);
  const abortTrigger = effectiveAbortAt === 0
    ? { mode: "none", at: 0 }
    : (abortAtExplicit
      ? { mode: "round", at: effectiveAbortAt }
      : { mode: "tool_result", at: Math.min(effectiveAbortAt, 3) });
  return {
    provider,
    rounds,
    store,
    out,
    compactEvery,
    abortAt: effectiveAbortAt,
    abortAtExplicit,
    abortTrigger,
    slot: values.slot ?? "default",
    keepStore: values["keep-store"] === true,
  };
}

// ------------------------------------------------- real 上游（读 config 槽位）

// 模型/端点/凭据全部来自 config 的 slots.<name>；源码里不出现任何模型名。
function resolveConfigPath() {
  const home = process.env.HOME ?? os.homedir();
  // 显式指定的路径**不回落**（指错了就该错，不能静默跑到另一个配置上）。
  const explicit = process.env.ERIX_E2E_CONFIG ?? process.env.ERIX_CONFIG_PATH;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`ERIX_E2E_CONFIG/ERIX_CONFIG_PATH 指向的文件不存在：${explicit}`);
    }
    return explicit;
  }
  // 回落链：XDG → erix 的真实家目录（AGENTS §6：~/.erix/config.json）。前一版只试 XDG，
  // 于是本机（配置在 ~/.erix）跑 `--provider real` 直接报「未找到模型配置」。
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const candidates = [path.join(xdg, "erix", "config.json"), path.join(home, ".erix", "config.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`未找到模型配置文件（依次试过：${candidates.join(" , ")}；可用 ERIX_E2E_CONFIG 指定）`);
}

function readSlotConfig(slotName) {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`未找到模型配置文件：${configPath}（可用 ERIX_E2E_CONFIG 指定）`);
  }
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const slot = parsed?.slots?.[slotName];
  if (!slot || typeof slot !== "object") {
    throw new Error(`配置文件 ${configPath} 缺少 slots.${slotName}`);
  }
  return { configPath, slot };
}

function createRealUpstream(slotName) {
  const { configPath, slot } = readSlotConfig(slotName);
  const endpoint = slot.endpoint ?? slot.baseURL ?? slot.baseUrl;
  const model = slot.model ?? slot.model_name;
  const apiKey = slot.apiKey
    ?? (slot.apiKeyEnv ? process.env[slot.apiKeyEnv] : undefined)
    ?? (slot.api_key_env ? process.env[slot.api_key_env] : undefined);
  if (!endpoint || !model || !apiKey) {
    throw new Error(`slots.${slotName} 缺少 endpoint/model/apiKey（或 apiKeyEnv）其中之一`);
  }
  // 协议选择必须与引擎一致：**缺省 = openai**。bin/config.js:110-112 只是转发 `slots.protocol`
  // （或环境变量），没写就不是 anthropic；本仓自己的 ~/.erix/config.json 也没这个字段。
  // 前一版默认 anthropic → 本机（relay 只供 OpenAI 兼容路径）打出 POST /v1/messages → 404 Invalid URL，
  // real 路径整段空转（rounds=0、↑0↓0，而断言会当成 9 条红）。
  const kind = String(slot.protocol ?? process.env.ERIX_PROTOCOL ?? process.env.LLM_KIT_PROTOCOL
    ?? slot.provider ?? "openai").toLowerCase();
  const common = {
    endpoint,
    apiKey,
    model,
    ...(slot.contextWindowTokens ?? slot.maxInputTokens
      ? { contextWindowTokens: slot.contextWindowTokens ?? slot.maxInputTokens } : {}),
    ...(slot.maxOutputTokens ?? slot.maxTokens
      ? { maxOutputTokens: slot.maxOutputTokens ?? slot.maxTokens } : {}),
  };
  const provider = kind.includes("anthropic")
    ? createAnthropicProvider(common)
    : createOpenAIProvider(common);
  return {
    provider,
    // 预算元数据：real 用 config 里的窗口值（缺一个就推不出 budgetTokens，压缩整体不进）
    modelMetadata: {
      ...(common.contextWindowTokens ? { contextWindowTokens: common.contextWindowTokens } : {}),
      ...(common.maxOutputTokens ? { maxOutputTokens: common.maxOutputTokens } : {}),
    },
    describe: { source: configPath, slot: slotName, kind, model },
  };
}

// -------------------------------------------------------- fake 上游（不联网）

const FAKE_MODEL_ID = "soak-scripted-upstream"; // 假上游标识，不是真实模型名
const RESULT_PADDING_UNIT = "soakchunk ";       // 用于把每轮 token 量做成确定值

function padText(marker, units) {
  return `${marker} ${RESULT_PADDING_UNIT.repeat(Math.max(0, units))}`.trim();
}

// 脚本化上游：在预算内永远先要一个工具调用（把 run 推到 maxRounds），预算用尽给最终文本。
// 走 src/index.js 暴露的 provider 接口（chat / chatStream，返回 canonical response）。
function createFakeUpstream({ tokensPerRound = 40 } = {}) {
  // 驱动量取**自身的上游调用次数**，不取历史里的 tool_result 计数：强制压缩 + TTL 折叠会把
  // 老的 tool_result 折掉，用历史计数会让假上游提前收尾（长跑跑不满 --rounds）。
  const state = { calls: 0, toolSteps: 0, maxToolCalls: Number.POSITIVE_INFINITY };
  const respond = () => {
    state.calls += 1;
    const content = [];
    if (state.toolSteps < state.maxToolCalls) {
      state.toolSteps += 1;
      const marker = `r${String(state.toolSteps)}s${String(state.calls)}`;
      content.push({ type: "text", text: `soak step ${marker}` });
      content.push({
        type: "tool_use",
        id: `fake-toolu-${String(state.toolSteps)}-${String(state.calls)}`,
        name: "soak_touch",
        input: { step: state.toolSteps, marker },
      });
      return {
        content,
        stopReason: "tool_use",
        usage: { input_tokens: 120 + state.toolSteps, output_tokens: 40 },
      };
    }
    content.push({ type: "text", text: padText("soak final", 4) });
    return {
      content,
      stopReason: "end_turn",
      usage: { input_tokens: 120 + state.toolSteps, output_tokens: 24 },
    };
  };
  // 返回**上游句柄**（不是 provider 本体），与 createRealUpstream 同形：
  // main() 只认 { provider, modelMetadata, describe, state, setBudget }。
  const provider = {
    protocol: "fake",
    model: FAKE_MODEL_ID,
    async chat(request) {
      return respond();
    },
    async chatStream(request) {
      const response = respond();
      for (const block of response.content) {
        if (block.type === "text") request.onDelta?.(block.text);
        if (block.type === "tool_use") {
          request.onToolCall?.({
            id: block.id,
            name: block.name,
            input: block.input,
            inputJson: JSON.stringify(block.input),
          });
        }
      }
      request.onUsage?.(response.usage);
      return response;
    },
  };
  return {
    provider,
    // fake 不给预算元数据：强制压缩走 context.budgetTokens（显式预算优先）
    modelMetadata: {},
    state,
    // 每个阶段开始前重设「还要发多少次工具调用」，让阶段可控（不依赖引擎内部状态）
    setBudget(toolCalls) {
      // 相对量：每个阶段从**当前已发次数**再往上加，否则上一阶段用尽的预算会让假上游立即收尾
      state.maxToolCalls = state.toolSteps + toolCalls;
    },
    describe: { source: "in-process", kind: "fake", model: FAKE_MODEL_ID, tokensPerRound },
  };
}

function toBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content === undefined || content === null) return [];
  return [content];
}

const SOAK_TOOL = Object.freeze({
  name: "soak_touch",
  description: "soak 专用假工具：写出确定体积的结果文本，把上下文推过压缩预算。",
  input_schema: {
    type: "object",
    properties: { step: { type: "number" }, marker: { type: "string" } },
  },
});

function makeExecuteTool({ tokensPerRound }) {
  return async function executeTool(request) {
    const step = Number(request?.toolInput?.step ?? request?.input?.step ?? 0);
    const text = padText(`soak-result-step-${String(step)}`, tokensPerRound);
    return { content: [{ type: "text", text }] };
  };
}

// ------------------------------------------------------------- 事件流累计

function createEventCounter({ resultOrigins } = {}) {
  const counter = {
    byType: new Map(),
    roundEnds: 0,
    toolResults: 0,
    toolUses: 0,
    compactions: 0,
    persistenceFailures: 0,
    errors: [],
    // TTL 层的引擎自记账（src/loop/provider-runner.js:63-70 → orchestrator.js:1844-1866）：
    // 折叠只在**请求视图**发生，引擎把它作为一层 compaction 统计报出来（compacted=false，
    // layers.ttl.triggered = 本轮被折的结果数）——这是「TTL 真的跑了」最权威的一路证据。
    ttlFolds: [],
    // 每个 tool_result 的**未折叠原文**（事件形状 = 入档前的完整事实），
    // 供请求视图探针比对「本轮请求里这条结果被换掉了没有」。三个阶段共用同一张表（由 main 传入），
    // 否则 abort/resume 阶段的原块查不到原文，会被当成「没折叠」。
    resultOrigins: resultOrigins ?? new Map(),
    currentRound: null,
  };
  counter.onEvent = (event) => {
    const type = event?.type ?? "unknown";
    counter.byType.set(type, (counter.byType.get(type) ?? 0) + 1);
    // 轮号推进：round_start 总在 callProvider 之前发（src/loop/orchestrator.js:2901），
    // 所以捕获到的请求视图可以打上「当时 currentRound」。
    if (type === "round_start" && Number.isFinite(event?.round)) counter.currentRound = event.round;    if (type === "round_end") counter.roundEnds += 1;
    if (type === "tool_result") {
      counter.toolResults += 1;
      const block = event?.toolResult;
      const id = block?.tool_use_id;
      if (typeof id === "string" && !counter.resultOrigins.has(id)) {
        counter.resultOrigins.set(id, {
          text: blockText(block?.content),
          round: block?.erix?.round,
          toolCallKey: block?.erix?.toolCallKey,
        });
      }
    }
    if (type === "tool_use") counter.toolUses += 1;
    // 引擎事件形状：{type:"compaction", round, compaction:{...}}（src/loop/orchestrator.js:1688），
    // compacted 住在 event.compaction 里；两种位置都容错。
    if (type === "compaction") {
      const stat = event?.compaction ?? event;
      if (stat?.compacted === true) counter.compactions += 1;
      const ttlLayer = stat?.layers?.ttl;
      if (Number.isFinite(ttlLayer?.triggered) && ttlLayer.triggered > 0) {
        counter.ttlFolds.push({
          round: event?.round,
          foldedResults: ttlLayer.triggered,
          tokensSaved: ttlLayer.tokensSaved,
          tokensBefore: stat?.tokensBefore,
          tokensAfter: stat?.tokensAfter,
        });
      }
    }
    if (type === "persistence_failure" || type === "persistence_capability_degraded") {
      counter.persistenceFailures += 1;
    }
    if (type === "error" || type === "persistence_failure") {
      if (counter.errors.length < 10) {
        counter.errors.push({ type, round: event?.round, code: event?.error?.code ?? event?.code });
      }
    }
  };
  return counter;
}

// tool_result.content 可能是 string 或块数组：统一成可比较的纯文本。
function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : String(block?.text ?? "")))
      .join("");
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

// ------------------------------------------- 实际上游请求视图探针
//
// 为什么必须抓请求视图（工单 #290 返工第 2 条）：TTL 折叠与 run-state 追加只作用于**发往上游的
// 请求副本**（src/loop/provider-runner.js:51-57），`runToolLoop` 返回的 `messages` 是未折叠的
// `ctx.messages`。拿 mainResult.messages 当「折叠后视图」等于什也没看。
// 做法：包一层注入的 provider，把每次 chat/chatStream 收到的 request.messages 抓下来，
// 在**抓取当场**完成配对校验与折叠判定（不存全部视图，200 轮长跑不吃内存）。
function createRequestViewProbe(upstream, resultOrigins) {
  const inner = upstream.provider;
  const probe = {
    requests: 0,
    foldedRequests: 0,
    distinctFolded: new Set(),
    foldedInstances: 0,
    warningOnly: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    foldedSamples: [],
    validationErrors: [],
    validationErrorCount: 0,
    orphanResults: 0,
    danglingUses: 0,
    pairViolationSamples: [],
    conversion: { openai: { ok: true, requests: 0 }, anthropic: { ok: true, requests: 0 } },
  };
  // track = main 与本探针共享的可变状态：当前阶段名 + 当时轮号（由 main 的 onEvent 包装推轮号，
  // round_start 总在 callProvider 之前发，src/loop/orchestrator.js:2901）。
  const track = { phase: "main", round: null };
  // 三个阶段共用同一张 resultOrigins（见 createEventCounter），否则 abort/resume 阶段的原块查不到原文。
  const findOrigin = (id) => resultOrigins.get(id);

  const capture = (request) => {
    probe.requests += 1;
    const view = Array.isArray(request?.messages) ? request.messages : [];
    const tag = { phase: track.phase, round: track.round, request: probe.requests };
    // (a) 仓里既有的严格校验器作为通过条件（src/messages/rounds.js:43）：
    //     转换器本身不校验配对，「没抛错」是空断言。
    try {
      validateMessages(view, { allowPendingToolUse: false });
    } catch (error) {
      probe.validationErrorCount += 1;
      if (probe.validationErrors.length < 3) {
        probe.validationErrors.push({
          ...tag,
          error: String(error?.message ?? error),
          code: error?.code,
        });
      }
    }
    const blocks = collectBlocksFromMessages(view);
    // (b) 配对计数直接进通过条件（不再是只进 evidence 的装饰品）。
    const useIds = new Set();
    const resultIds = new Set();
    let foldedThisView = 0;
    for (const { block } of blocks) {
      if (block.type === "tool_use") useIds.add(block.id ?? block?.erix?.toolCallKey);
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id ?? block.id ?? block?.erix?.toolCallKey;
      resultIds.add(id);
      // (c) 折叠判定：拿引擎事件里的**未折叠原文**比对本视图里的同一条。
      const origin = typeof id === "string" ? findOrigin(id) : undefined;
      if (origin === undefined) continue;
      const text = blockText(block.content);
      if (text === origin.text) continue;
      if (text.startsWith(origin.text)) {
        // TTL 预警行（原文开头不变 + 末尾追加）：不是折叠，分开数。
        probe.warningOnly += 1;
        continue;
      }
      foldedThisView += 1;
      probe.foldedInstances += 1;
      probe.distinctFolded.add(id);
      const before = estimateTokens(origin.text);
      const after = estimateTokens(text);
      probe.tokensBefore += before;
      probe.tokensAfter += after;
      const markerRound = Number.isFinite(block?.erix?.round) ? block.erix.round : null;
      const createdRound = markerRound ?? parsePlaceholderRound(text);
      if (probe.foldedSamples.length < 5) {
        probe.foldedSamples.push({
          ...tag,
          toolUseId: id,
          createdRound,
          erixRoundOnBlock: block?.erix?.round,
          originEventRound: origin.round,
          age: Number.isFinite(track.round) && Number.isFinite(createdRound)
            ? track.round - createdRound
            : null,
          tokensBefore: before,
          tokensAfter: after,
          placeholderHead: text.slice(0, 70),
        });
      }
    }
    if (foldedThisView > 0) probe.foldedRequests += 1;
    const orphans = [...resultIds].filter((id) => !useIds.has(id));
    const dangling = [...useIds].filter((id) => !resultIds.has(id));
    probe.orphanResults += orphans.length;
    probe.danglingUses += dangling.length;
    if ((orphans.length > 0 || dangling.length > 0) && probe.pairViolationSamples.length < 5) {
      probe.pairViolationSamples.push({
        ...tag,
        orphanResults: orphans.slice(0, 3),
        danglingUses: dangling.slice(0, 3),
        messagesInView: view.length,
      });
    }
    // 协议转换仍然跑（它是转换不坏的证据），但它**不再是配对断言的通过条件**。
    // 出错后计数与错误分开存（requests 不会因覆盖而变 NaN），ok=false 粘住不回头。
    try {
      canonicalToOpenAIMessages("soak", view);
      probe.conversion.openai.requests += 1;
    } catch (error) {
      probe.conversion.openai = {
        ok: false,
        requests: probe.conversion.openai.requests,
        error: String(error?.message ?? error),
        code: error?.code,
      };
    }
    try {
      canonicalToAnthropicRequest({ system: "soak", messages: view, tools: [SOAK_TOOL], maxTokens: 1024 });
      probe.conversion.anthropic.requests += 1;
    } catch (error) {
      probe.conversion.anthropic = {
        ok: false,
        requests: probe.conversion.anthropic.requests,
        error: String(error?.message ?? error),
        code: error?.code,
      };
    }
  };

  // 只覆盖真存在的入口：否则给一个只有 chat() 的上游添上 chatStream 会把引擎的选路带偏
  // （provider-runner.js:136-140 先按「有没有 chat」再按 stream 选chat/chatStream）。
  const provider = Object.create(inner);
  if (typeof inner?.chat === "function") {
    provider.chat = (request) => {
      capture(request);
      return inner.chat(request);
    };
  }
  if (typeof inner?.chatStream === "function") {
    provider.chatStream = (request) => {
      capture(request);
      return inner.chatStream(request);
    };
  }
  return { provider, probe, track };
}

// 折叠占位符里带着创建轮（`… r<round> 读取 …`，src/loop/tool-result-ttl.js:133-136）；
// 块上 `erix.round` 缺席时用它做回退证据。
function parsePlaceholderRound(text) {
  const match = /r(\d+) 读取/.exec(String(text ?? ""));
  return match === null ? null : Number.parseInt(match[1], 10);
}

// ------------------------------------------------------------ 落盘与契约

function collectBlocksFromMessages(messages) {
  const blocks = [];
  for (const message of toList(messages)) {
    for (const block of toBlocks(message?.content)) {
      if (block && typeof block === "object" && typeof block.type === "string") {
        blocks.push({ role: message?.role, block });
      }
    }
  }
  return blocks;
}

// 从 store 记录里摊平正文消息（**只扫 record.messages**，与 collectBlocksFromRecords 同口径：
// RoundRecord.response 是副本，两边一起扫会把同一批块数两次）。
function collectMessagesFromRecords(records) {
  const messages = [];
  for (const record of toList(records)) {
    if (Array.isArray(record?.messages)) messages.push(...record.messages);
  }
  return messages;
}

function toList(value) {
  return Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
}

// 从 store 记录里摊平消息。**只扫 record.messages**：RoundRecord.response.content 是同一批
// assistant 块的副本，两边一起扫会把同一个 toolCallKey 数两次（假撞键）。
function collectBlocksFromRecords(records) {
  const blocks = [];
  for (const record of toList(records)) {
    for (const { role, block } of collectBlocksFromMessages(record?.messages)) {
      blocks.push({ round: record?.round, role, block });
    }
  }
  return blocks;
}

// response.content 副本的量级，只作为证据报出来，不参与契约断言
function tallyResponseCopies(records) {
  let toolUseCopies = 0;
  let recordsWithResponse = 0;
  for (const record of toList(records)) {
    const blocks = collectBlocksFromMessages([record?.response]);
    if (record?.response) recordsWithResponse += 1;
    toolUseCopies += blocks.filter(({ block }) => block.type === "tool_use").length;
  }
  return { recordsWithResponse, toolUseCopies };
}

function collectProjectionEntries(projection) {
  return Array.isArray(projection)
    ? projection
    : toList(projection?.entries ?? projection?.messages);
}

function collectProjectionKeys(projection) {
  const keys = new Set();
  for (const entry of collectProjectionEntries(projection)) {
    for (const call of toList(entry?.toolCalls)) {
      if (typeof call?.toolCallKey === "string") keys.add(call.toolCallKey);
    }
  }
  return keys;
}

function collectProjectionDuration(projection) {
  const byKey = new Map();
  for (const entry of collectProjectionEntries(projection)) {
    for (const call of toList(entry?.toolCalls)) {
      if (typeof call?.toolCallKey === "string" && "durationMs" in call) {
        byKey.set(call.toolCallKey, call.durationMs);
      }
    }
  }
  return byKey;
}

async function countJsonlLines(storeDir, runId) {
  const file = path.join(storeDir, `${runId}.jsonl`);
  if (!existsSync(file)) return { file, lines: -1, bytes: -1, text: "" };
  const text = await readFile(file, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "").length;
  return { file, lines, bytes: Buffer.byteLength(text, "utf8"), text };
}

function parseJsonlRecords(text) {
  return (text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { __unparsable: true, line: line.slice(0, 120) };
      }
    });
}

// ---------- 账本行的**独立复刻**（工单 261021 写侧「一条消息一落盘」之后的对账新口径）
//
// 旧口径（改造前）：一轮 = 一行 ⇒ 「jsonl 行数 == store.load() 记录数」就是「落盘不丢不重」。
// 新口径（工单 261021）：一条消息一行（`kind:"message"` + 轮内 `seq`），轮行只留元数据，
// `store.load()` 再把消息行**折回轮行**（`src/store/message-rows.js#foldMessageRows`）。
// 于是行数与记录数不再相等（实测 6 轮：21 行 / 9 条），旧等式不再表达「不丢不重」——
// 它只表达「有没有消息行」，那是个恒真的形状差异，不是不变量。
// 所以这里不写 src 的实现，而是**照读侧口径自己独立折一遍**（分轮按 `seq` 升序、`partOf` 接回
// 它指认的那条消息、有载体行的轮才吸、正文挪到载体行的位置上），再把折出来的正文序列与
// `store.load()` 摊平的序列**逐条比对**：少一条 = 折叠丢了正文，多一条 = 同一份正文喂两遍
// （正是第三刀要销掉的双喂），顺序错位 = 模型会看到与改造前不同的历史。
const MESSAGE_ROW_KIND_LITERAL = "message";

function independentRowKey(record) {
  const key = record?.dedupKey ?? record?.roundKey;
  return typeof key === "string" ? key : "";
}

function independentIsMessageRow(record) {
  return record?.kind === MESSAGE_ROW_KIND_LITERAL
    && Number.isSafeInteger(record.seq)
    && Array.isArray(record.messages)
    && record.messages.length > 0;
}

function independentIsCarrier(record, round) {
  const key = independentRowKey(record);
  return key !== ""
    && (key.endsWith(`:round:${String(round)}`) || key.endsWith(`:round:${String(round)}:resume`));
}

function independentMergePart(target, part) {
  const targetContent = Array.isArray(target?.content) ? [...target.content] : [target?.content];
  const partContent = Array.isArray(part?.content) ? [...part.content] : [part?.content];
  return { ...target, content: [...targetContent, ...partContent] };
}

/**
 * 从**原始行**独立折出「模型该看到的正文序列」与行分类计数（不调用 src 的实现）。
 * @param {any[]} rawRecords
 */
function foldLedgerFromRawRows(rawRecords) {
  const rows = toList(rawRecords);
  /** @type {Map<number, { carrier: number, rows: number[] }>} */
  const groups = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const round = Number.isSafeInteger(rows[index]?.round) ? rows[index].round : undefined;
    if (round === undefined) continue;
    if (!groups.has(round)) groups.set(round, { carrier: -1, rows: [] });
    const group = groups.get(round);
    if (independentIsMessageRow(rows[index])) {
      group.rows.push(index);
    } else if (group.carrier === -1 && independentIsCarrier(rows[index], round)) {
      group.carrier = index;
    }
  }

  /** @type {Map<number, object[]>} 载体行下标 → 折回的正文 */
  const attached = new Map();
  const absorbed = new Set();
  let standaloneMessageRows = 0;
  let partOfMerges = 0;
  for (const [round, group] of groups) {
    if (group.rows.length === 0) continue;
    if (group.carrier === -1) {
      standaloneMessageRows += group.rows.length;
      continue;
    }
    const ordered = [...group.rows].sort((left, right) => (
      (rows[left].seq ?? 0) - (rows[right].seq ?? 0) || left - right
    ));
    const messages = [];
    /** @type {Map<string, number>} */
    const parts = new Map();
    for (const index of ordered) {
      absorbed.add(index);
      const row = rows[index];
      const partOf = typeof row.partOf === "string" ? row.partOf : "";
      const targetIndex = partOf === "" ? -1 : (parts.get(partOf) ?? -1);
      if (targetIndex >= 0 && row.messages.length === 1) {
        messages[targetIndex] = independentMergePart(messages[targetIndex], row.messages[0]);
        partOfMerges += 1;
        continue;
      }
      const key = independentRowKey(row);
      if (key !== "") parts.set(key, messages.length);
      messages.push(...row.messages.map((message) => independentStampRowTs(message, row)));
    }
    attached.set(group.carrier, messages);
    void round;
  }

  const orderedMessages = [];
  let engineRoundRows = 0;
  let seedRows = 0;
  let factRows = 0;
  let messageRows = 0;
  let otherRows = 0;
  let unparsable = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.__unparsable === true) unparsable += 1;
    if (row?.kind === MESSAGE_ROW_KIND_LITERAL) messageRows += 1;
    else if (row?.response) engineRoundRows += 1;
    else if (independentRowKey(row).endsWith(":seed")) seedRows += 1;
    else if (Number.isSafeInteger(row?.round)) factRows += 1;
    else otherRows += 1;
    if (absorbed.has(index)) continue;
    const own = Array.isArray(row?.messages) ? row.messages : [];
    orderedMessages.push(...own);
    const extra = attached.get(index);
    if (extra !== undefined) orderedMessages.push(...extra);
  }
  return {
    orderedMessages,
    counts: {
      rows: rows.length,
      messageRows,
      absorbedMessageRows: absorbed.size,
      standaloneMessageRows,
      partOfMerges,
      engineRoundRows,
      seedRows,
      factRows,
      otherRows,
      unparsable,
    },
  };
}

/**
 * 对账用的**独立第二实现**：给折出来的消息补上它那一行的 `ts`（issue #439 A）。
 *
 * 口径与引擎侧（`src/store/message-rows.js#stampRowTs`）逐字一致：`ts` = 该逻辑消息**首片行**的
 * `ts`；分片合并只加 content、不改首片已经写上的；行上没有 `ts` ⇒ 缺键。
 * 这是对账（`store-reconcile-jsonl-vs-load` 的 `foldCompare.equal`）必须跟上的地方：引擎给每条
 * 逻辑消息补了 `ts` 而这里不补，两边的 `JSON.stringify` 就会条条不等（实测 3 处 mismatch）。
 * @param {any} message
 * @param {any} row
 * @returns {any}
 */
function independentStampRowTs(message, row) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return message;
  if (typeof message.ts === "string" && message.ts !== "") return message;
  const ts = typeof row?.ts === "string" ? row.ts : "";
  return ts === "" ? message : { ...message, ts };
}

// 逐条比对两条正文序列（JSON 文本口径，与 `resume-history-bytes-unchanged` 同一个比较口径）。
function compareMessageSequences(left, right) {
  const mismatches = [];
  const total = Math.max(left.length, right.length);
  for (let index = 0; index < total; index += 1) {
    const a = JSON.stringify(left[index]);
    const b = JSON.stringify(right[index]);
    if (a !== b) {
      mismatches.push({
        index,
        left: a === undefined ? "MISSING" : a.slice(0, 120),
        right: b === undefined ? "MISSING" : b.slice(0, 120),
      });
      if (mismatches.length >= 3) break;
    }
  }
  return { equal: mismatches.length === 0 && left.length === right.length, mismatches };
}

// -------------------------------------------------- 事实键分类守卫（issue #336）
//
// 病根：`store-reconcile-event-stream` 的 `compositionMatches` 算得很认真、打得很显眼，却
// **不在通过条件里**——一条写得像在核对事实的断言，无论真假都不会让用例红。同类键在 848 行
// 的脚本里绝不止一处，靠人眼盘不住。
//
// 口径（**每个事实键只有两种状态，没有第三种**）：
//   ① 参与通过条件（机械判定：它的取值表达式在条件表达式里出现，或它的名字在条件里出现）；
//   ② 显式登记为诊断键（`EVIDENCE_DIAGNOSTICS` / `REPORT_KEY_CLASSES`），并且**写清理由**：
//      为什么它不该决定红绿。
// 剩下的键一律让 `evidence-keys-classified` 判红，提示就一句话：这个键要么进条件，要么登记成诊断。
//
// 为什么要读自己的源码：条件表达式在 run 完之后就不存在了（只有 pass/evidence 留在台账里），
// 想机械判定「这个键进没进条件」只能回到源码文本上比对。这不是新的依赖面——
// `scripts/docs-drift-check.mjs` 早就从自己的文本里读回 SYMBOL_ANCHOR_MIN_UNIQUE 等锚点。
const KEY_AUDIT_ASSERTION = "evidence-keys-classified";
const REPORT_AUDIT_ASSERTION = "report-fact-keys-classified";
const SELF_SOURCE = new URL(import.meta.url);
const TEST_SOURCE = new URL("../test/soak-script.test.js", import.meta.url);

// 表现层形状：**字面量文本 / 样本截断 / 路径渲染**，不可能是判定值（布尔或计数都写不成这几种形状）。
// 只把「可能是事实」的键交给登记表，避免把 note/rule/样本当事实键批量登记（那样登记表会
// 膨胀到没人读，守卫就退化成噪声）。
function isPresentationShape(expression) {
  const withoutStrings = expression
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  // 注意 `?.`（可选链）不是三元运算符：`String(mainError?.message)` 是纯渲染，不该被当成判定。
  const hasOperator = /===|!==|>=|<=|>|<|&&|\|\||\s\?\s/.test(withoutStrings);
  if (/^\s*(""|''|``)(\s*\+\s*(""|''|``))*\s*$/.test(withoutStrings)) return true;
  if (hasOperator) return false;
  return /^String\(/.test(expression)
    || /^path\.basename\(/.test(expression)
    || /\.(slice|map|filter)\(/.test(expression);
}

// 诊断键登记表：断言名 → [{ keys, reason }]。key 用 `...(spread)` 表示该断言里的展开项。
// 每条 reason 必须回答「为什么它不该决定红绿」，不是「它是诊断」这种同义反复。
//
// 判据：一个键被判成诊断，只能因为**把它放进条件会让断言变错**（脆弱 / 重复判红 / 判的不是同一件事），
// 不能因为「加上去会红」就登记成诊断——那是把守卫改成橡皮图章。
const EVIDENCE_DIAGNOSTICS = {
  "long-replay-completes": [
    {
      keys: ["code", "termination"],
      reason: "失败分支的诊断：走到这个分支时条件已因 mainError 判红，这两键只说明红在哪一步（错误码 / 终局对象），再进条件只是重复判红",
    },
    {
      keys: ["maxRounds"],
      reason: "输入回显（cli.rounds）：条件是「达成的轮数 >= minRounds」，上限只给宿主对照，比上限等于把测试输入当成被测事实",
    },
    {
      keys: ["terminationReason"],
      reason: "条件通过 CLEAN_STOPS.includes(mainResult.termination?.reason) 读同一个值，本键是它渲染出来的形态（可选链 vs 数组包含，文本链接器认不出），不是第二个判据",
    },
  ],
  "forced-compaction-observed": [
    {
      keys: ["ideal", "budgetTokens", "perRoundTokens", "compactEvery", "effectiveEvery"],
      reason: "预算/输入回显：条件是「压缩次数 >= expectedCompactions」，这几个键是让人手算「该压几次」的输入（budget 与每轮 token 量），比它们等于在断言自己配的参数",
    },
    {
      keys: ["foldedRounds"],
      reason: "样本：从 compactionStats 里取第一条已压缩记录的 foldedRounds 给人看，条件已经按条数比过同一批记录",
    },
  ],
  "store-reconcile-jsonl-vs-load": [
    {
      keys: ["standaloneMessageRows", "partOfMerges", "ledgerMessages", "independentlyFoldedMessages", "foldMismatches"],
      reason: "对账口径的计数面/样本面：条件由 foldCompare.equal（正文逐条相等）与行级闭合等式决定，相等时这几个数必然为 0/相等；把它们也写进条件只会让红的原因变模糊",
    },
    {
      keys: ["recordKinds", "responseContentCopies"],
      reason: "结构旁证（行分类计数、response 副本量）：行级闭合已由 jsonlLines == 记录数 + 被折消息行数决定，这两个对象只是给宿主看落盘形状",
    },
  ],
  "store-reconcile-event-stream": [
    {
      keys: ["toolUseEvents", "loadedRoundRecords", "nonEngineRoundRecords"],
      reason: "计数面：条件是「round_end 事件数 == 引擎轮行数 且 有 tool_result 且 行级成分等式成立」，这三个数说明另外三类行/事件各有多少，判红判绿不靠它们",
    },
  ],
  "ttl-fold-actually-applied": [
    {
      keys: ["toolResultTtlOption", "engineTtlLayerEvents", "engineTtlTokensSaved", "observedUpstreamRequests", "requestsWithFoldedBlock", "warningOnlyViews", "ageThreshold"],
      reason: "证据面：条件已由 engineTtlFolded / foldedInstances / distinctFolded / tokensBefore>tokensAfter / ageOkSamples 决定；这几个是「传进去的是什么值」「折了几次、省了多少」的量，token 省量在 fake 上游下与 padding 绑定，拿它当条件就是脆弱断言",
    },
  ],
  "contract-tool-result-erix-core-fields": [
    {
      keys: ["required", "missingSamples"],
      reason: "常量回显 + 缺失样本：条件是 missingFieldTally 为空（一个字段名都不缺），required 是被比对的字段清单本身，样本只给定位用",
    },
  ],
  "contract-execution-status-special-states-only": [
    {
      keys: ["withExecutionStatus", "withoutExecutionStatus", "allowed"],
      reason: "计数面 + 白名单回显：条件是 unexpectedStatus 为空（取值都在白名单里），两个计数只说明「有几个块带了这个键」，allowed 是被比对的白名单本身",
    },
  ],
  "contract-no-retired-top-level-names": [
    {
      keys: ["scannedBlocks"],
      reason: "扫描面计数：条件是 retiredHits 为空，这个数说明「真的扫过东西」（防空跑靠的是它非 0 的可读性，而空扫已在 toolResults/diskBlocks 那一层被别的断言盯住）",
    },
  ],
  "contract-toolcallkey-unique": [
    {
      keys: ["toolUseBlocks"],
      reason: "计数面：条件是「有键 且 无重复键」（diskKeys.length > 0 && duplicateKeys 为空），这个数只是 tool_use 块总数",
    },
  ],
  "contract-projection-keysets-bidirectionally-equal": [
    {
      keys: ["projectionKeyCount", "diskKeyCount"],
      reason: "计数面：条件是两侧键集合的双向差为空，只比 size 会漏掉「换了一个键但总数不变」，所以 size 只能当旁证不能当条件",
    },
  ],
  "contract-projection-durationms-equals-disk": [
    {
      keys: ["projectedWithDuration", "diskWithDuration"],
      reason: "计数面：条件是「值逐条相等 + 两侧 duration 键集合双向相等」，两个 size 是它的旁证（同上：size 相等不等于键集合相等）",
    },
  ],
  "abort-actually-fired": [
    {
      keys: ["coverage", "trigger", "abortedAtRound", "naturalTermination", "toolResultsLanded", "threw", "rounds", "...(spread)"],
      reason: "条件只有 abortFired 一个布尔（它由 abortedAtRound !== null 派生，见 abortStage 构造）；其余键把「为什么触发 / 为什么没触发」摊开给宿主，其中 naturalTermination 与 toolResultsLanded 只在没触发时有意义——那时本断言已经红了",
    },
  ],
  "abort-termination-reason-is-aborted": [
    {
      keys: ["observedReason", "issue282Rewritten", "abortedAtRound", "naturalTermination"],
      reason: "本条是非阻断观察（blocking:false，红由 abort-actually-fired 承担）：observedReason 就是被观察的值（条件比的是 abortedReason），issue282Rewritten 是给宿主读的结论位——把结论位写进条件等于用结论证明结论",
    },
  ],
  "resume-run-succeeds": [
    {
      keys: ["snapshotPresent", "...(spread)"],
      reason: "旁证 + 运行摘要：条件是 resumeInfo.ok === true（续跑能从 jsonl 恢复，snapshot 在不在不是判据）；展开项是 rounds/usage/terminationReason 这些宿主面的运行摘要",
    },
  ],
  "resume-history-bytes-unchanged": [
    {
      keys: ["beforeLines", "afterLines"],
      reason: "渲染口径：条件比的是行数组本身（rewritten 为空 + 行数不减），这两个「非空行数」是同一事实的第二种算法，写进条件等于把同一件事比两遍",
    },
  ],
  "resume-new-toolcallkeys-disjoint-from-history": [
    {
      keys: ["newToolUseBlocks", "newKeys"],
      reason: "计数面：条件是 collided 为空（新键与历史键不相交），两个计数只是「真的续跑出新调用了」的旁证",
    },
  ],
  "resume-special-state-facts-not-read-as-success": [
    {
      keys: ["coverage", "engineSpecialStateBlocks", "engineSamples", "engineWritesOnly"],
      reason: "样本/白名单回显：条件是 read.asExpected 且「引擎样本里没有一个带 success 事实」，这几个键说明本次有没有引擎样本、白名单是哪两个值——样本数写进条件会让「引擎没产出特殊块」变成红（那是覆盖度，不是缺陷）",
    },
  ],
  "pairing-request-views-pass-strict-validation": [
    {
      keys: ["samples", "conversion", "contrastWithPreviousVersion"],
      reason: "错误样本 + 转换细节 + 对照叙述：条件是 requests>0 且 validationErrorCount===0；转换器 ok 由 request-view-protocol-conversion-survives 单独判（issue #336 补的），对照块是给人读的历史说明",
    },
  ],
  "pairing-no-orphan-or-dangling-in-request-views": [
    {
      keys: ["violations"],
      reason: "违规样本：条件是 orphanResults / danglingUses 两个计数为 0，样本只给定位用",
    },
  ],
  "no-unexpected-unhandled-rejection": [
    {
      keys: ["total", "whitelistedKnownAborted"],
      reason: "总账：条件是 unexpected 为空（白名单外的未处理拒绝一条都不许有）；total/whitelisted 说明白名单接住了几条——白名单接住的正是已知引擎形态，把它写进条件会让已知形态判红",
    },
  ],
  "unknown-run-tool-loop-option-rejected": [
    {
      keys: ["evidence"],
      reason: "拒绝原文：条件是 accepted === false，本键是探针拿到的拒绝消息（判定依据的出处，不是第二个判据）",
    },
  ],
  "contract-constant-records-execution-status-presence": [
    {
      keys: ["writtenFor", "presentValues"],
      reason: "被检值原文：条件读的是 presenceRecorded（由这两个键参与计算出来的布尔），再单独比一遍等于把同一事实写两遍",
    },
  ],
};

// 报告顶层键登记表：key → { assertion, expr }（条件证明）| { testExpr }（测试文件里断言的证明）| { reason }。
// 粒度：顶层键（28 个）。子键不单列的原因：它们的值面已被 evidence 层的同一个值守过一次，
// 再按 195 个叶子节点列一遍只会把登记表变成噪声；容器类的 reason 里点名「由哪条断言/测试守」。
const REPORT_KEY_CLASSES = {
  tool: { reason: "报告身份位（写死 soak），由 test 的字段面清单与 schemaVersion 一起守" },
  schemaVersion: { reason: "报告格式版本：格式变了就该由消费方（test 与宿主）而不是 soak 自己判红" },
  generatedAt: { reason: "运行元数据（时间戳），无真值可言" },
  durationMs: { reason: "运行元数据（时长）：长跑的时长本来就随机器与上游浮动，拿它当条件必然抖" },
  node: { reason: "运行环境元数据（node 版本），CI 矩阵管它，soak 不管" },
  cli: { reason: "调用参数回显（宿主复算用）：--store/--out 的红线由 CLI 拒绝路径（exit 2）+ test 里的两条用例守" },
  upstream: {
    reason: "上游身份（模型/端点来源）：soak 的条件里**不允许**写死模型名（AGENTS §8），所以它只能是诊断面",
  },
  provider: { reason: "cli.provider 的回显（fake/real）：分支选择已由 test 分别跑两条路径覆盖" },
  rounds: { assertion: "long-replay-completes", expr: "mainResult.rounds >= minRounds" },
  usage: { testExpr: "report.usage.input_tokens > 0" },
  usageParts: {
    reason: "分阶段用量明细（main/abort/resume）：总和由 usage 守住；拆开只是给宿主看哪个阶段烧了 token",
  },
  compactions: { testExpr: "report.compactions.compactionStats.length > 0" },
  abortRequested: { reason: "输入回显（cli.abortAt）：把宿主要求的触发点写回报告，防的是「报了中止但没说要中止」" },
  abortTrigger: { testExpr: "report.abortTrigger.mode" },
  abortObservedReason: { testExpr: "report.abortObservedReason, \"aborted\"" },
  abortStage: { testExpr: "report.abortStage.abortFired" },
  abort: { testExpr: "report.abort.partial" },
  resume: { testExpr: "report.resume.ok === true" },
  ttl: { testExpr: "report.ttl.engineLayerEvents > 0" },
  requestViews: { testExpr: "report.requestViews.validationErrors, 0" },
  storeCleanup: { testExpr: "storeCleanup.removed, true" },
  storeReconcile: { testExpr: "reconcile.jsonlLines, reconcile.loadedRoundRecords + reconcile.absorbedMessageRows" },
  contract: { testExpr: "report.contract.diskKeys, report.contract.projectionKeys" },
  assertions: { testExpr: "report.assertions.length, EXPECTED_ASSERTIONS.length" },
  assertionManifest: { testExpr: "report.assertionManifest, EXPECTED_ASSERTIONS" },
  totals: { testExpr: "report.totals.failedBlocking, 0" },
  engineDefects: {
    reason: "只报不修的缺陷清单：红绿由各断言与 no-unexpected-unhandled-rejection 决定，本键是宿主读的登记面（缺陷条目没有真值可言）",
  },
  unhandledRejections: {
    reason: "未处理拒绝的原文清单：红绿由 no-unexpected-unhandled-rejection（白名单外的计数为空）决定，原文只给定位用",
  },
};

// 行内 `//` 的位置：**字符串里的 `//` 不算注释**（evidence 里全是 URL / 路径 / 正则字样），
// 所以这里按引号状态走一遍，而不是拿正则硬切。
function lineCommentIndex(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote !== "") {
      if (char === "\\") { i += 1; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

function stripCodeComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const index = lineCommentIndex(line);
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n")
    .trim();
}

// 从 `openIdx`（指向 `(`/`[`/`{`）开始找配对的闭合符，跳过字符串/模板/注释。
function matchDelimiter(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(source, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < to) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < to && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start, to));
  return parts;
}

function topLevelColon(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) return i;
  }
  return -1;
}

// 字面量（true/false/null/undefined/this）不算「取值表达式」：它们出现在条件里纯属巧合
// （例如未覆盖分支的条件就是 `false`），把它们当链接会把登记表判成过期。
const SIMPLE_PATH = /^(?!(?:true|false|null|undefined|this)$)[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/**
 * 从源码里读出每一次 `ledger.check(name, condition, evidence)`：条件表达式文本 + evidence 的键值对。
 * @param {string} source
 */
function parseAssertionCalls(source) {
  // 注释里也会出现 `ledger.check(...)` 这种字样（本文件的说明文字就是），扫描必须先做一张
  // 「这个位置在不在注释里」的掩码，否则会把注释当成第 29、30 条断言。
  const inComment = new Uint8Array(source.length);
  {
    let i = 0;
    while (i < source.length) {
      const char = source[i];
      if (char === '"' || char === "'" || char === "`") {
        const quote = char;
        i += 1;
        while (i < source.length) {
          if (source[i] === "\\") { i += 2; continue; }
          if (source[i] === quote) break;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (char === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") { inComment[i] = 1; i += 1; }
        continue;
      }
      if (char === "/" && source[i + 1] === "*") {
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) { inComment[i] = 1; i += 1; }
        inComment[i] = 1;
        if (i + 1 < source.length) inComment[i + 1] = 1;
        i += 2;
        continue;
      }
      i += 1;
    }
  }
  const calls = [];
  let cursor = 0;
  while ((cursor = source.indexOf("ledger.check(", cursor)) !== -1) {
    if (inComment[cursor] === 1) { cursor += 1; continue; }
    const open = cursor + "ledger.check".length;
    const close = matchDelimiter(source, open);
    if (close === -1) throw new Error(`ledger.check 调用没闭合（源码偏移 ${cursor}）`);
    const args = splitTopLevel(source, open + 1, close);
    const name = stripCodeComments(args[0] ?? "").replace(/^["']|["']$/g, "");
    const condition = stripCodeComments(args[1] ?? "");
    const evidenceText = (args[2] ?? "").trim();
    const entries = [];
    if (evidenceText.startsWith("{")) {
      const braces = matchDelimiter(evidenceText, 0);
      for (const part of splitTopLevel(evidenceText, 1, braces)) {
        const text = stripCodeComments(part);
        if (text === "") continue;
        if (text.startsWith("...")) { entries.push({ key: "...(spread)", value: text }); continue; }
        const colon = topLevelColon(text);
        if (colon === -1) { entries.push({ key: text, value: text }); continue; } // 简写属性
        entries.push({
          key: text.slice(0, colon).trim().replace(/^["']|["']$/g, ""),
          value: text.slice(colon + 1).trim(),
        });
      }
    }
    calls.push({ name, condition, entries });
    cursor = close;
  }
  return calls;
}

function registeredDiagnostics(assertionName) {
  const groups = EVIDENCE_DIAGNOSTICS[assertionName] ?? [];
  const table = new Map();
  for (const group of groups) {
    for (const key of group.keys) table.set(key, group.reason);
  }
  return table;
}

/**
 * 事实键守卫：evidence 里每一个键，要么在条件里，要么在登记表里（并写了理由）。
 * @param {string} source
 */
// 同名断言会有多个分支（例如 long-replay-completes 的失败分支与正常分支）：按名字合并，
// 条件文本取并集（任一分支持有这个键就算「在条件里」），evidence 键也取并集。
function groupAssertionCalls(source) {
  const grouped = new Map();
  for (const call of parseAssertionCalls(source)) {
    if (!grouped.has(call.name)) grouped.set(call.name, { name: call.name, condition: "", entries: [] });
    const group = grouped.get(call.name);
    group.condition += `\n${call.condition}`;
    group.entries.push(...call.entries);
  }
  return grouped;
}

function auditEvidenceKeys(source) {
  const calls = [...groupAssertionCalls(source).values()].filter((call) => call.name !== KEY_AUDIT_ASSERTION
    && call.name !== REPORT_AUDIT_ASSERTION);
  const unclassified = [];
  const stale = [];
  const unreasoned = [];
  let linked = 0;
  let presentation = 0;
  let diagnostic = 0;
  for (const call of calls) {
    const table = registeredDiagnostics(call.name);
    const seen = new Set();
    for (const entry of call.entries) {
      seen.add(entry.key);
      // 链接判据只看**取值表达式**在不在条件里：拿键名做子串匹配太松（键 `rounds` 会被
      // `mainResult.rounds` 命中），那等于给守卫开后门。
      const inCondition = SIMPLE_PATH.test(entry.value) && call.condition.includes(entry.value);
      if (inCondition) {
        linked += 1;
        // 登记了却在条件里 = 登记表过期（留着会让人以为它没被守住），也判红。
        if (table.has(entry.key)) stale.push(`${call.name}.${entry.key}`);
        continue;
      }
      if (isPresentationShape(entry.value)) { presentation += 1; continue; }
      const reason = table.get(entry.key);
      if (reason === undefined) {
        unclassified.push(`${call.name}.${entry.key} = ${entry.value.slice(0, 60)}`);
        continue;
      }
      if (reason.trim().length < 12) unreasoned.push(`${call.name}.${entry.key}（理由太短，等于没写）`);
      else diagnostic += 1;
    }
    for (const key of table.keys()) {
      if (!seen.has(key)) unclassified.push(`${call.name}.${key}（登记了但 evidence 里没有这个键 = 死登记）`);
    }
  }
  for (const name of Object.keys(EVIDENCE_DIAGNOSTICS)) {
    if (!calls.some((call) => call.name === name)) {
      unclassified.push(`${name}（登记表里的断言名不存在）`);
    }
  }
  return {
    ok: unclassified.length === 0 && stale.length === 0 && unreasoned.length === 0,
    assertions: calls.length,
    linked,
    presentation,
    diagnostic,
    unclassified,
    stale,
    unreasoned,
    hint: "这个键要么进通过条件，要么在 EVIDENCE_DIAGNOSTICS 里登记成诊断键并写清「为什么它不该决定红绿」",
  };
}

/**
 * 报告顶层键守卫：报告里每个键，要么有断言/测试在守它，要么登记为诊断（写理由）。
 * @param {Record<string, unknown>} report
 * @param {string} soakSource
 * @param {string} testSource
 */
function auditReportKeys(report, soakSource, testSource) {
  const calls = [...groupAssertionCalls(soakSource).values()];
  const unclassified = [];
  const unproven = [];
  const unreasoned = [];
  const keys = Object.keys(report).filter((key) => key !== REPORT_AUDIT_ASSERTION);
  for (const key of keys) {
    const entry = REPORT_KEY_CLASSES[key];
    if (entry === undefined) {
      unclassified.push(key);
      continue;
    }
    if (typeof entry.reason === "string") {
      if (entry.reason.trim().length < 12) unreasoned.push(key);
      continue;
    }
    if (typeof entry.testExpr === "string") {
      if (!testSource.includes(entry.testExpr)) unproven.push(`${key}（test 里找不到 ${entry.testExpr}）`);
      continue;
    }
    const call = calls.find((candidate) => candidate.name === entry.assertion);
    if (!call) { unproven.push(`${key}（断言 ${entry.assertion} 不存在）`); continue; }
    if (!call.condition.includes(entry.expr)) unproven.push(`${key}（${entry.assertion} 的条件里找不到 ${entry.expr}）`);
  }
  for (const key of Object.keys(REPORT_KEY_CLASSES)) {
    if (!keys.includes(key)) unclassified.push(`${key}（登记了但报告里没有这个键 = 死登记）`);
  }
  return {
    ok: unclassified.length === 0 && unproven.length === 0 && unreasoned.length === 0,
    keys: keys.length,
    unclassified,
    unproven,
    unreasoned,
    hint: "报告的每个顶层键要么有断言/测试在守（写 assertion+expr 或 testExpr），要么登记成诊断键并写理由",
  };
}

// --------------------------------------------------------------- 断言台账

function createLedger() {
  const assertions = [];
  return {
    assertions,
    check(name, pass, evidence, { blocking = true, knownIssue } = {}) {
      assertions.push({
        name,
        pass: pass === true,
        blocking: pass === true ? true : blocking,
        ...(knownIssue ? { knownIssue } : {}),
        evidence,
      });
      const mark = pass ? "PASS" : (blocking ? "FAIL" : "OBS");
      process.stdout.write(`  [${mark}] ${name} :: ${JSON.stringify(evidence).slice(0, 300)}\n`);
    },
  };
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const cli = parseCli();
  const startedAt = Date.now();
  const storeDir = cli.store ?? await mkdtemp(path.join(os.tmpdir(), "erix-soak-store-"));
  const usedTempStore = cli.store === undefined;
  if (usedTempStore) underRealErixHome(storeDir, "默认临时 store");
  const ledger = createLedger();

  const rawUpstream = cli.provider === "fake"
    ? createFakeUpstream({ tokensPerRound: 40 })
    : createRealUpstream(cli.slot);
  // 三个阶段共享同一张「未折叠原文」表（探针用它识别哪些 tool_result 被 TTL 换了）。
  const resultOrigins = new Map();
  const mainCounter = createEventCounter({ resultOrigins });
  // 注入一层请求视图探针：拿到的 provider 与上游同形，但每次真请求都会被观察。
  const { provider, probe, track } = createRequestViewProbe(rawUpstream, resultOrigins);
  const upstream = { ...rawUpstream, provider };
  // 事件入口包装：阶段计数器自己跑 + 把轮号同步给探针（所有阶段都走这一个入口）。
  const onEventFor = (counter) => (event) => {
    counter.onEvent(event);
    if (event?.type === "round_start" && Number.isFinite(event?.round)) track.round = event.round;
  };

  process.stdout.write(`soak 开始：provider=${cli.provider} rounds=${cli.rounds} `
    + `compactEvery=${cli.compactEvery} abortAt=${cli.abortAt} store=${storeDir}\n`);
  process.stdout.write(`上游：${JSON.stringify(upstream.describe)}\n`);

  // 强制压缩：把每轮 token 量做成确定值，再把 budgetTokens 压到 effectiveEvery 轮的量级，
  // 让压缩**必然**触发（不指望自然触发）。rounds < compact-every 时按 rounds/2 收紧，
  // 否则短跑根本走不到一个压缩周期。
  const perRoundTokens = estimateTokens(padText("soak-result-step-1", 40))
    + estimateTokens("soak step r1s1") + MESSAGE_ROUND_OVERHEAD_TOKENS;
  const effectiveEvery = Math.min(cli.compactEvery, Math.max(1, Math.floor(cli.rounds / 2)));
  const budgetTokens = Math.max(
    MIN_BUDGET_TOKENS,
    Math.round(perRoundTokens * effectiveEvery * 0.8),
  );
  const idealCompactions = Math.floor(cli.rounds / effectiveEvery);
  const expectedCompactions = Math.max(1, idealCompactions - 1);
  const common = {
    provider: upstream.provider,
    ...(upstream.modelMetadata && Object.keys(upstream.modelMetadata).length > 0
      ? { modelMetadata: upstream.modelMetadata }
      : {}),
    system: "soak：长跑一致性观察（工具循环、压缩、落盘）",
    tools: [SOAK_TOOL],
    executeTool: makeExecuteTool({ tokensPerRound: 40 }),
    // 注：文档写的 governor 选项**不在** src/loop/option-normalization.js:36-97 的白名单里
    // （传入即 unknown runToolLoop option），soak 只观察不改：见报告 engineDefects。
    stallDetection: false,
    store: createFileTranscriptStore({ dir: storeDir }),
    persistence: "required",
    context: {
      strategy: "fold-statistical",
      budgetTokens,
      keepRounds: 2,
      task: "soak 观察",
    },
    // 引擎要的是**数字**（src/loop/orchestrator.js:321 `toolResultTtl?: number`）。
    // 传对象会被 src/loop/tool-result-ttl.js:231-234 的 `!Number.isFinite(ttl)` 当场返回原消息，
    // 即 TTL 折叠一次都没跑（前一版就是这里空的）。ttl=1 ⇒ 下一条请求就能折上一条结果。
    toolResultTtl: TOOL_RESULT_TTL,
    toolResultFoldMinTokens: 1,
  };

  // ---------- 阶段 A：长轮回放（含强制压缩）
  if (cli.provider === "fake") upstream.setBudget(cli.rounds);
  const mainRunId = `soak-main-${Date.now().toString(36)}`;
  const counter = mainCounter;
  let mainResult;
  let mainError;
  try {
    mainResult = await runToolLoop({
      ...common,
      runId: mainRunId,
      maxRounds: cli.rounds,
      initialUserMessage: "soak：开始长轮回放",
      onEvent: onEventFor(counter),
      onRound: ({ round }) => {
        if (round % Math.max(1, Math.floor(cli.rounds / 10)) === 0) {
          process.stdout.write(`  进度：round=${round}/${String(cli.rounds)} `
            + `compactions=${counter.compactions} toolResults=${counter.toolResults}\n`);
        }
      },
    });
  } catch (error) {
    mainError = error;
  }
  if (mainError) {
    ledger.check("long-replay-completes", false, {
      error: String(mainError?.message ?? mainError),
      code: mainError?.code,
      termination: mainError?.termination,
    });
  } else {
    // 真模型**可以提前宣告完成**（end_turn / judge_done）——那不是缺陷。判据应是「干净收口 + 轮数够逼出压缩」，
    // 不是「轮数必须等于 --rounds」（只有假上游会跑满；前一版把真模型的正常提前收尾判成了红）。
    // `no_tool` **不是**干净收口（工单 #290 返工第 6 条）：它是 prose 停滞被治理层撑住后的停局
    // （src/loop/orchestrator.js:3147-3156 的 noToolRound/noToolStreak、src/reflection/governor.js:112-113），
    // 长跑里它是「模型不干活」而不是「任务做完了」。
    const CLEAN_STOPS = ["end_turn", "judge_done", "max_rounds_cap"];
    const minRounds = Math.max(2, Math.min(cli.compactEvery, Math.floor(cli.rounds / 2)));
    ledger.check("long-replay-completes",
      CLEAN_STOPS.includes(mainResult.termination?.reason)
        && (mainResult.truncated !== true || mainResult.termination?.reason === "max_rounds_cap")
        && mainResult.rounds >= minRounds, {
      rounds: mainResult.rounds,
      maxRounds: cli.rounds,
      minRounds,
      truncated: mainResult.truncated,
      truncationNote: "truncated=true 只在 max_rounds_cap 下可接受（引擎对该原因的截断标记是正确行为）",
      terminationReason: mainResult.termination?.reason,
      cleanStopReasons: CLEAN_STOPS,
    });
  }
  const observedCompactions = mainResult?.compactionStats?.filter((s) => s.compacted)?.length ?? 0;
  ledger.check("forced-compaction-observed",
    observedCompactions >= expectedCompactions || counter.compactions >= expectedCompactions, {
      compactionStatsCompacted: observedCompactions,
      compactionEvents: counter.compactions,
      expectedMin: expectedCompactions,
      ideal: idealCompactions,
      budgetTokens,
      perRoundTokens,
      compactEvery: cli.compactEvery,
      effectiveEvery,
      foldedRounds: mainResult?.compactionStats?.find?.((s) => s.compacted)?.foldedRounds,
    });

  // ---------- 阶段 B：三方对账（落盘原始行 / store.load / 事件流）
  const mainRecords = await common.store.load(mainRunId);
  const mainJsonl = await countJsonlLines(storeDir, mainRunId);
  const journal = foldLedgerFromRawRows(parseJsonlRecords(mainJsonl.text));
  const loadedMessages = collectMessagesFromRecords(mainRecords);
  const foldCompare = compareMessageSequences(journal.orderedMessages, loadedMessages);
  const recordKinds = tallyRecordKinds(mainRecords);
  const responseCopies = tallyResponseCopies(mainRecords);
  // 旧断言是 `jsonlLines === store.load().length`（改造前一轮一行，两者相等）。
  // 逐条落盘后那个等式只能表达「本次没写消息行」，牙齿全无 ⇒ 换成两条真不变量：
  //   ① **行级闭合**：每一行要么原样出现在 load() 里，要么作为消息行被折进载体行；
  //      所发 `jsonlLines === loadedRecords + absorbedMessageRows`（相等 = 不丢行也不多行，
  //      任何一行被静默丢弃 / 重复暴露都会红）；
  //   ② **正文闭合**：本脚本独立复刻的折叠结果与 `store.load()` 摊平的正文**逐条相等**
  //      （少一条 = 折叠吞了正文；多一条 = 同一份正文存了两遍；错位 = 顺序变了）。
  // 并且钉住「本次真的逐条落盘了」（messageRows > 0），否则两条新不变量都会退化成空跑。
  ledger.check("store-reconcile-jsonl-vs-load",
    mainJsonl.lines > 0
      && journal.counts.unparsable === 0
      && journal.counts.messageRows > 0
      && journal.counts.engineRoundRows > 0
      && mainJsonl.lines === mainRecords.length + journal.counts.absorbedMessageRows
      && foldCompare.equal, {
      jsonlLines: mainJsonl.lines,
      loadedRoundRecords: mainRecords.length,
      // 新口径的三个计数：旧等式的「行数 == 记录数」就是这两个数的合一（absorbed = 0 时退化回旧形状）。
      messageRows: journal.counts.messageRows,
      absorbedMessageRows: journal.counts.absorbedMessageRows,
      standaloneMessageRows: journal.counts.standaloneMessageRows,
      partOfMerges: journal.counts.partOfMerges,
      ledgerMessages: loadedMessages.length,
      independentlyFoldedMessages: journal.orderedMessages.length,
      foldMismatches: foldCompare.mismatches,
      accounting: `jsonlLines=${mainJsonl.lines} == load() 返回 ${mainRecords.length} 条 + 被折进载体行的消息行 ${journal.counts.absorbedMessageRows} 条`,
      recordKinds,
      responseContentCopies: responseCopies,
      file: path.basename(mainJsonl.file),
    });
  // issue #336：这个「行级成分等式」以前只算进 evidence（`compositionMatches`），**不在条件里**——
  // 于是它算得再认真也决定不了红绿（实测那条断言在 compositionMatches=false 的年份也是绿的）。
  // 现在把它提成条件本身：行分类加起来必须等于 jsonl 行数（少一类 / 多一类都红）。
  const compositionBalanced = mainJsonl.lines === journal.counts.engineRoundRows
    + journal.counts.messageRows + journal.counts.seedRows
    + journal.counts.factRows + journal.counts.otherRows;
  ledger.check("store-reconcile-event-stream",
    counter.roundEnds === recordKinds.engineRounds && counter.toolResults > 0 && compositionBalanced, {
      roundEndEvents: counter.roundEnds,
      engineRoundRecords: recordKinds.engineRounds,
      toolResultEvents: counter.toolResults,
      toolUseEvents: counter.toolUses,
      loadedRoundRecords: mainRecords.length,
      nonEngineRoundRecords: recordKinds.nonRound,
      composition: `jsonlLines=${mainJsonl.lines} = 引擎轮行 ${journal.counts.engineRoundRows}`
        + ` + 消息行 ${journal.counts.messageRows}`
        + ` + seed 行 ${journal.counts.seedRows} + 事实/控制行 ${journal.counts.factRows + journal.counts.otherRows}`,
      compositionMatches: compositionBalanced,
      explanation: "seed 行不是某一轮的消息副本，也不是「initialUserMessage 自己占一行」："
        + "initialUserMessage 只进内存消息（src/loop/orchestrator.js 的 initialUserMessage 入 ctx.messages），"
        + "而轮行从工单 261021 起**只留元数据**（正文逐条写进 `…:msg:<round>:<seq>` 消息行，"
        + "读侧由 src/store/message-rows.js#foldMessageRows 折回轮行）。那一行是**非 resume 分支专门归档的 "
        + "round=0 种子行**（src/loop/resume-manager.js，dedupKey=`<runId>:engine:round:0:seed`，"
        + "内容 = 初始消息，无 response），目的是 ADR-002 的档案完整性（fold 后还能恢复初始历史）。"
        + " round_end 事件只等于引擎轮行数（seed 不是轮，消息行也不是轮）。",
    });

  // ---------- 阶段 B2：TTL 折叠真的发生了（工单 #290 返工第 1 条）
  // 两路独立证据：引擎自己的 TTL 层记账（事件流）+ 探针在**实际请求视图**里看到的占位符。
  // 只要一边有就能报出数，但通过条件要两边同时成立且年龄算得对——否则「ttl 传错」仍然能绿。
  const ttlEngineFolded = counter.ttlFolds.reduce((sum, f) => sum + f.foldedResults, 0);
  const ttlEngineTokensSaved = counter.ttlFolds.reduce((sum, f) => sum + (f.tokensSaved ?? 0), 0);
  const ageOkSamples = probe.foldedSamples.filter((s) => Number.isFinite(s.age) && s.age >= TOOL_RESULT_TTL);
  ledger.check("ttl-fold-actually-applied",
    ttlEngineFolded > 0
      && probe.foldedInstances > 0
      && probe.distinctFolded.size > 0
      && probe.tokensBefore > probe.tokensAfter
      && probe.foldedSamples.length > 0
      && ageOkSamples.length === probe.foldedSamples.length, {
      // 报**真正传给引擎的那个值**（不是常量名）：变异时它必须跟着变，否则证据会说谎。
      toolResultTtlOption: common.toolResultTtl,
      engineTtlLayerEvents: counter.ttlFolds.length,
      engineTtlFoldedResults: ttlEngineFolded,
      engineTtlTokensSaved: ttlEngineTokensSaved,
      engineTtlFirstEvents: counter.ttlFolds.slice(0, 3),
      observedUpstreamRequests: probe.requests,
      requestsWithFoldedBlock: probe.foldedRequests,
      distinctFoldedResults: probe.distinctFolded.size,
      foldedBlockInstances: probe.foldedInstances,
      tokensBefore: probe.tokensBefore,
      tokensAfter: probe.tokensAfter,
      warningOnlyViews: probe.warningOnly,
      // 被折叠块的创建轮 vs 当时请求的 currentRound：这就是 TTL 的年龄来源 `erix.round`。
      foldedSamples: probe.foldedSamples,
      ageThreshold: TOOL_RESULT_TTL,
      samplesWithLegalAge: ageOkSamples.length,
      note: "证据必须同时来自引擎 TTL 层记账与实际请求视图；"
        + "只抽一边时「ttl 传了非数字（引擎原样返回消息）」与「视图取错了（拿未折叠历史冒充）」都能假绿",
    });

  // ---------- 阶段 C：契约事实（长跑后仍成立）
  const diskBlocks = collectBlocksFromRecords(mainRecords);
  const toolResults = diskBlocks.filter(({ block }) => block.type === "tool_result");
  const toolUses = diskBlocks.filter(({ block }) => block.type === "tool_use");
  const projection = projectTranscriptForDisplay(mainRecords);

  const CORE_ERIX = ["toolCallKey", "round", "durationMs", "success"];
  const missingFieldTally = {};
  const missingSamples = [];
  let executionStatusPresent = 0;
  // 普通块 = **写了成败事实**的块（`erix.success` 对每个真正执行过的结果都写，见 src/tool-fact.js
  // 的 `writtenFor: "every executed result"`），而两个特殊状态（interrupted/intercepted）**刻意不写 success**
  // （没跑完就没有成败，src/loop/orchestrator.js:2776-2790 / src/loop/run-snapshot-executor.js:578-591）。
  // 因此「有 success」与「有 executionStatus」必须互斥——这才是能抵住「成功块也被抹上 interrupted」的条件。
  const ordinaryWithStatus = [];
  let ordinaryBlocks = 0;
  for (const { block } of toolResults) {
    const missing = CORE_ERIX.filter((f) => block?.erix?.[f] === undefined);
    for (const f of missing) {
      missingFieldTally[f] = (missingFieldTally[f] ?? 0) + 1;
      if (missingSamples.length < 3) missingSamples.push({ field: f, block: summarizeBlock(block) });
    }
    const erix = block?.erix ?? {};
    const hasStatus = Object.hasOwn(erix, "executionStatus");
    if (hasStatus) executionStatusPresent += 1;
    if (Object.hasOwn(erix, "success")) {
      ordinaryBlocks += 1;
      if (hasStatus) ordinaryWithStatus.push({ status: erix.executionStatus, block: summarizeBlock(block) });
    }
  }
  ledger.check("contract-tool-result-erix-core-fields", toolResults.length > 0
    && Object.keys(missingFieldTally).length === 0, {
      toolResultBlocks: toolResults.length,
      required: CORE_ERIX,
      missingFieldTally,
      missingSamples,
    });
  // 契约真相：`erix.executionStatus` **只在特殊状态出现**（docs/host-consumer-contract.md:2073「special states only」、
  // _cn.md:1635「仅特殊状态」；引擎写入点 src/loop/orchestrator.js:2787 / :2816 与 src/loop/run-snapshot-executor.js:589）。
  // 「每个结果块都该带 executionStatus」是**错的断言**（本脚本前一版就这么错过，错因在主 agent 的工单）。
  // issue #409 追加第三档 `rejected`（引数解析失败 ⇒ 工具从未执行，判词经 `is_error` 的 tool_result 回给模型）。
  const SPECIAL_EXECUTION_STATUS = ["intercepted", "interrupted", "rejected"];
  const unexpectedStatus = [];
  for (const { block } of diskBlocks) {
    const value = block?.erix?.executionStatus;
    if (value !== undefined && !SPECIAL_EXECUTION_STATUS.includes(value)) {
      unexpectedStatus.push({ value, block: summarizeBlock(block) });
    }
  }
  ledger.check("contract-execution-status-special-states-only",
    toolResults.length > 0 && unexpectedStatus.length === 0, {
      toolResultBlocks: toolResults.length,
      withExecutionStatus: executionStatusPresent,
      withoutExecutionStatus: toolResults.length - executionStatusPresent,
      allowed: SPECIAL_EXECUTION_STATUS,
      unexpectedStatus,
      note: "本条只查「已有值是否在白名单」，它单独挡不住「普通成功块也多写了一个 executionStatus」"
        + "（那是另一个缺陷：存在性错而不是取值错）——所以下面还有一条无条件存在性断言",
    });
  // 无条件存在性断言（工单 #290 返工第 5a 条）：上一条只查值在白名单内，**允许**普通成功块带
  // `interrupted` 也能绿。契约说特殊状态与「已执行的块」互斥，所以有 `erix.success` 的块必须
  // **根本没有** `executionStatus` 这个键（不是值为 undefined，是键不存在）。
  ledger.check("contract-ordinary-results-omit-execution-status",
    toolResults.length > 0 && ordinaryBlocks > 0 && ordinaryWithStatus.length === 0, {
      toolResultBlocks: toolResults.length,
      ordinaryBlocks, // 带 erix.success 的块（真正执行过的，含成功与失败）
      ordinaryWithExecutionStatus: ordinaryWithStatus.length,
      samples: ordinaryWithStatus.slice(0, 3),
      rule: "Object.hasOwn(erix,\"success\") 与 Object.hasOwn(erix,\"executionStatus\") 必须互斥："
        + "两个特殊状态（interrupted/intercepted）工单上都不写 success（没跑完 = 无成败）",
    });

  const RETIRED_TOP_LEVEL = ["erixRound", "duration", "executionStatus", "success"];
  const retiredHits = [];
  for (const { block } of diskBlocks) {
    for (const name of RETIRED_TOP_LEVEL) {
      if (Object.prototype.hasOwnProperty.call(block ?? {}, name)) {
        retiredHits.push({ name, type: block.type });
      }
    }
  }
  ledger.check("contract-no-retired-top-level-names", retiredHits.length === 0, {
    scannedBlocks: diskBlocks.length,
    retiredHits: retiredHits.slice(0, 5),
  });

  const diskKeys = toolUses
    .map(({ block }) => block?.erix?.toolCallKey)
    .filter((k) => typeof k === "string");
  const duplicateKeys = [...new Set(diskKeys.filter((k, i) => diskKeys.indexOf(k) !== i))];
  ledger.check("contract-toolcallkey-unique", diskKeys.length > 0 && duplicateKeys.length === 0, {
    toolUseBlocks: toolUses.length,
    keysWithErixKey: diskKeys.length,
    duplicates: duplicateKeys.slice(0, 5),
  });

  const projectionKeys = collectProjectionKeys(projection);
  const diskKeySet = new Set(diskKeys);
  const onlyInProjection = [...projectionKeys].filter((k) => !diskKeySet.has(k)).slice(0, 5);
  const onlyOnDisk = [...diskKeySet].filter((k) => !projectionKeys.has(k)).slice(0, 5);
  ledger.check("contract-projection-keysets-bidirectionally-equal",
    onlyInProjection.length === 0 && onlyOnDisk.length === 0, {
      projectionKeyCount: projectionKeys.size,
      diskKeyCount: diskKeySet.size,
      onlyInProjection,
      onlyOnDisk,
    });

  const projectionDuration = collectProjectionDuration(projection);
  const diskDuration = new Map();
  for (const { block } of toolResults) {
    const key = block?.erix?.toolCallKey;
    if (typeof key === "string" && block?.erix?.durationMs !== undefined) {
      diskDuration.set(key, block.erix.durationMs);
    }
  }
  const durationMismatches = [];
  for (const [key, value] of projectionDuration) {
    if (!diskDuration.has(key)) {
      durationMismatches.push({ key, projected: value, disk: "missing" });
    } else if (diskDuration.get(key) !== value) {
      durationMismatches.push({ key, projected: value, disk: diskDuration.get(key) });
    }
  }
  // 键集合必须**双向**相等（工单 #290 返工第 5b 条）：只遍历「投影里已有的 duration」会让
  // 投影整条漏掉也照样绿（盘上有、投影无 = 丢事实，不是无中生有，但同样是契约缺口）。
  const diskOnlyDurationKeys = [...diskDuration.keys()].filter((k) => !projectionDuration.has(k));
  const projectionOnlyDurationKeys = [...projectionDuration.keys()].filter((k) => !diskDuration.has(k));
  ledger.check("contract-projection-durationms-equals-disk",
    durationMismatches.length === 0
      && diskOnlyDurationKeys.length === 0
      && projectionOnlyDurationKeys.length === 0, {
      projectedWithDuration: projectionDuration.size,
      diskWithDuration: diskDuration.size,
      valueMismatches: durationMismatches.slice(0, 5),
      onlyOnDisk: diskOnlyDurationKeys.slice(0, 5),
      onlyInProjection: projectionOnlyDurationKeys.slice(0, 5),
      rule: "disk 与 projection 的 duration 键集合双向相等（缺哪边都红），且已有值逐条相等",
    });
  const zeroSubstituted = [...projectionDuration].filter(
    ([key, value]) => value === 0 && !diskDuration.has(key),
  );
  ledger.check("contract-projection-missing-duration-not-zero", zeroSubstituted.length === 0, {
    zerosWithoutDiskFact: zeroSubstituted.slice(0, 5),
  });

  // ---------- 阶段 D：压缩/TTL 折叠后的 tool_use/tool_result 配对合法性
  // 断言本身放在 F 之后（视图是边跑边采的，三个阶段都要覆盖），这里只先把「上一版喂错了什么」量下来。
  const unfoldedFinalMessages = mainResult?.messages ?? [];

  // ---------- 阶段 E：中途 abort（观察 #282：reason 是否被写成 judge_done）
  // 触发点（工单 261015-02 小修）：默认在第 min(abortAt,3) 个**已落地的 tool_result 事件**之后立刻 abort。
  // 旧实现按「第 abortAt 轮」触发：真模型会在任意早的轮次自然 end_turn/judge_done，按轮次触发永远可能
  // 扑空。实测 `--provider real --rounds 200 --abort-at 100` 那份报告里 run 第 7 轮就 judge_done 收口，
  // abort **一次都没发生**，但 evidence 的兑底值 `?? cli.abortAt` 把它写成 `abortedAtRound: 100` +
  // `issue282Rewritten: true` —— #282 被假阳性地宣告成「真机一手复现」。
  // 所以本阶段的顺序是：**先确认 abort 真的触发过**（`abort-actually-fired`，阻断），再让引擎断言说话。
  let abortInfo;
  let abortRunId;
  let historyBeforeResume = null;
  let recordsBeforeResume = 0;
  let keysBeforeResume = [];
  // 报告面的 abort 结论（字段形状固定：abortFired / abortedAtRound / naturalTermination / coverage）。
  let abortStage = {
    abortFired: false,
    abortedAtRound: null,
    naturalTermination: null,
    coverage: "stage-skipped",
    trigger: cli.abortTrigger,
    observedReason: null,
    threw: null,
    note: "abort 阶段未运行（--abort-at 0 或 rounds < 4）：中止路径本次没被覆盖",
  };
  if (cli.abortAt > 0) {
    if (cli.provider === "fake") upstream.setBudget(cli.rounds);
    abortRunId = `soak-abort-${Date.now().toString(36)}`;
    track.phase = "abort";
    const abortCounter = createEventCounter({ resultOrigins });
    const onAbortEvent = onEventFor(abortCounter);
    const controller = new AbortController();
    const trigger = cli.abortTrigger;
    let abortedAtRound = null;
    const fireAbort = (round) => {
      if (abortedAtRound !== null) return;
      abortedAtRound = Number.isInteger(round) ? round : null;
      controller.abort();
    };
    try {
      const res = await runToolLoop({
        ...common,
        runId: abortRunId,
        maxRounds: cli.rounds,
        initialUserMessage: "soak：abort 与 resume 观察",
        signal: controller.signal,
        // 事件计数触发：第 trigger.at 个 tool_result **落地后**立刻 abort（默认路径，真机跑不了）。
        onEvent: (event) => {
          onAbortEvent(event);
          if (trigger.mode === "tool_result"
            && event?.type === "tool_result"
            && abortCounter.toolResults >= trigger.at) {
            fireAbort(event?.round ?? abortCounter.currentRound);
          }
        },
        // 轮次触发：只给显式 `--abort-at n`（宿主显式要这个形状时才用）。
        ...(trigger.mode === "round"
          ? {
            onRound: ({ round }) => {
              if (round === trigger.at) fireAbort(round);
            },
          }
          : {}),
      });
      // 非抛分支也带上**真实**的 abortedAtRound（外层变量）；null 就是没触发，不兑底。
      abortInfo = {
        threw: false,
        termination: res.termination,
        rounds: res.rounds,
        usage: res.usage,
        // 真实的中止轮号（外层变量）；null 就是没触发，**不拿 cli.abortAt 兑底**。
        abortedAtRound,
      };
    } catch (error) {
      abortInfo = {
        threw: true,
        reason: error?.termination?.reason,
        hasUsage: error?.termination?.usage !== undefined,
        hasRounds: error?.termination?.rounds !== undefined,
        partial: error?.termination?.partial,
        rounds: error?.termination?.rounds,
        usage: error?.termination?.usage,
        message: String(error?.message ?? error),
        code: error?.code,
        abortedAtRound,
      };
    }
    const abortedReason = abortInfo.threw ? abortInfo.reason : abortInfo.termination?.reason;
    const abortFired = abortInfo.abortedAtRound !== null && abortInfo.abortedAtRound !== undefined;
    abortStage = {
      abortFired,
      abortedAtRound: abortInfo.abortedAtRound ?? null,
      // 只有没触发时，这个 reason 才是「自然终局」；触发过它就是中止终局。
      naturalTermination: abortFired ? null : (abortedReason ?? null),
      coverage: abortFired ? "abort-fired" : "not-exercised",
      trigger,
      observedReason: abortedReason ?? null,
      threw: abortInfo.threw,
    };
    // 阻断：没触发就是**脚本自己的配置问题**，不能让引擎背锅（旧版在这里把没发生的中止报成 #282 复现）。
    // 但没触发的**根因**要分开写清楚：触发点不可达（脚本配置） vs 上游在触发点之前就挂了（不是脚本的锅）。
    const unfiredDiagnosis = abortFired ? null : (abortInfo.threw
      ? `中止 run 在触发点之前就抛错收口（reason=${abortedReason ?? "?"}，tool_result 落地 ${abortCounter.toolResults}/${trigger.at}）：上游或引擎提前失败，本阶段本次没被覆盖`
      : `中止 run 自然收口于 ${abortedReason ?? "?"}（tool_result 落地 ${abortCounter.toolResults}/${trigger.at}）：触发点没踩到`);
    ledger.check("abort-actually-fired", abortFired, {
      coverage: abortStage.coverage,
      trigger,
      abortedAtRound: abortStage.abortedAtRound,
      naturalTermination: abortStage.naturalTermination,
      toolResultsLanded: abortCounter.toolResults,
      threw: abortInfo.threw,
      // 抛错分支的轮数在 error.termination.rounds 上（issue #180），非抛分支在 res.rounds 上。
      rounds: abortInfo.rounds ?? abortInfo.termination?.rounds ?? null,
      ...(unfiredDiagnosis ? { unfiredDiagnosis } : {}),
      ...(abortFired ? {} : { upstreamMessage: abortInfo.message ?? null, upstreamCode: abortInfo.code ?? null }),
      note: "只有真的中止过，下面的引擎断言才有意义；没触发时它们一律记 coverage:\"not-exercised\" 的非阻断观察",
    });
    if (abortFired) {
      ledger.check("abort-termination-reason-is-aborted", abortedReason === "aborted", {
        coverage: "abort-fired",
        observedReason: abortedReason ?? null,
        // #282 结论只在 abort 真的触发过时成立（工单 261015-02 小修第 4 条）。
        issue282Rewritten: abortedReason === "judge_done",
        abortedAtRound: abortInfo.abortedAtRound,
      }, { blocking: false, knownIssue: "#282" });
      ledger.check("abort-error-carries-usage-rounds-partial",
        abortInfo.threw === true && abortInfo.hasUsage && abortInfo.hasRounds
        && abortInfo.partial === true, { coverage: "abort-fired", abortInfo });
    } else {
      // 沿用阶段 F 的 coverage 口径：没踩到执行面就不是「通过」，也不是引擎缺陷，而是**未覆盖**。
      ledger.check("abort-termination-reason-is-aborted", false, {
        coverage: "not-exercised",
        whyNotJudged: "abort 从未触发（见阻断断言 abort-actually-fired），无法观察引擎会把中止写成什么 reason",
        naturalTermination: abortStage.naturalTermination,
        // 关键：没触发就**不得**宣告 #282（这就是旧版的假阳性）。
        issue282Rewritten: false,
        abortedAtRound: null,
      }, { blocking: false });
      ledger.check("abort-error-carries-usage-rounds-partial", false, {
        coverage: "not-exercised",
        whyNotJudged: "没有中止就没有「中止错误带 usage/rounds/partial」这回事",
        abortInfo,
      }, { blocking: false });
    }

    // resume 前的历史快照：逐字节比对的基准
    const beforeJsonl = await countJsonlLines(storeDir, abortRunId);
    historyBeforeResume = beforeJsonl.text;
    recordsBeforeResume = (await common.store.load(abortRunId)).length;
    keysBeforeResume = collectBlocksFromRecords(await common.store.load(abortRunId))
      .filter(({ block }) => block.type === "tool_use")
      .map(({ block }) => block?.erix?.toolCallKey)
      .filter((k) => typeof k === "string");
  }

  // ---------- 阶段 F：resumeRunSnapshot 续跑
  let resumeInfo;
  if (abortRunId) {
    const resumeRounds = Math.max(2, cli.rounds - cli.abortAt);
    if (cli.provider === "fake") upstream.setBudget(resumeRounds);
    track.phase = "resume";
    const resumeCounter = createEventCounter({ resultOrigins });
    const resumeRunId = abortRunId;
    const snapshotFile = path.join(storeDir, `${resumeRunId}.snapshot.json`);
    try {
      const resumed = await runToolLoop({
        ...common,
        runId: resumeRunId,
        resume: true,
        maxRounds: resumeRounds,
        onEvent: onEventFor(resumeCounter),
      });
      resumeInfo = {
        ok: true,
        rounds: resumed.rounds,
        usage: resumed.usage,
        terminationReason: resumed.termination?.reason,
        compactions: (resumed.compactionStats ?? []).filter((s) => s.compacted).length,
        events: { roundEnds: resumeCounter.roundEnds, toolResults: resumeCounter.toolResults },
      };
    } catch (error) {
      resumeInfo = {
        ok: false,
        message: String(error?.message ?? error),
        code: error?.code,
        terminationReason: error?.termination?.reason,
      };
    }
    const snapshotExisted = existsSync(snapshotFile);
    ledger.check("resume-run-succeeds", resumeInfo.ok === true, {
      snapshotFile: path.basename(snapshotFile),
      snapshotPresent: snapshotExisted,
      ...resumeInfo,
    });

    const afterJsonl = await countJsonlLines(storeDir, resumeRunId);
    const beforeLines = historyBeforeResume === "" ? [] : historyBeforeResume.split("\n");
    const afterLines = afterJsonl.text === "" ? [] : afterJsonl.text.split("\n");
    const rewritten = [];
    for (let i = 0; i < beforeLines.length; i += 1) {
      if (beforeLines[i].trim() !== "" && beforeLines[i] !== afterLines[i]) {
        rewritten.push({ line: i + 1, before: beforeLines[i].slice(0, 120), after: (afterLines[i] ?? "").slice(0, 120) });
        if (rewritten.length >= 3) break;
      }
    }
    ledger.check("resume-history-bytes-unchanged",
      rewritten.length === 0 && afterLines.length >= beforeLines.length, {
        beforeLines: beforeLines.filter((l) => l.trim() !== "").length,
        afterLines: afterLines.filter((l) => l.trim() !== "").length,
        rewrittenCount: rewritten.length,
        rewrittenSamples: rewritten,
      });

    const afterRecords = await common.store.load(resumeRunId);
    const newBlocks = collectBlocksFromRecords(afterRecords.slice(recordsBeforeResume))
      .filter(({ block }) => block.type === "tool_use");
    const newKeys = newBlocks.map(({ block }) => block?.erix?.toolCallKey)
      .filter((k) => typeof k === "string");
    const collided = newKeys.filter((k) => keysBeforeResume.includes(k));
    ledger.check("resume-new-toolcallkeys-disjoint-from-history",
      resumeInfo.ok === true && collided.length === 0, {
        newToolUseBlocks: newBlocks.length,
        newKeys: newKeys.length,
        collided: collided.slice(0, 5),
      });

    // 本阶段真实样本：abort/resume 路径产出的特殊状态块（引擎只写 interrupted / intercepted）。
    const specialBlocks = collectBlocksFromRecords(afterRecords)
      .filter(({ block }) => block?.type === "tool_result"
        && SPECIAL_EXECUTION_STATUS.includes(block?.erix?.executionStatus));
    const specialWithSuccessFact = specialBlocks
      .filter(({ block }) => Object.hasOwn(block?.erix ?? {}, "success"));
    // 确定性场景（工单 #290 返工「无样本别当通过」）：`stale_attempt_result` 这个值**仓里 grep 不到**
    // （src/ 只写 interrupted/intercepted），而 fake 的 abort 落在 tool_result 之后、根本没有在飞调用，
    // 所以旧断言的样本数永远 = 0——它是结构性空跑。这里另搭一个同构的确定性场景，
    // **读取面用仓里真代码**（judge.buildTimeline / l0.extractL0Facts，两边都从 src/index.js 导出），
    // 并带一个正控制样本：同样形状换成普通成功块时必须读成 ok——读面如果是死的，本断言就红。
    const read = probeSpecialStateReadSurface();
    ledger.check("resume-special-state-facts-not-read-as-success",
      read.asExpected && specialWithSuccessFact.length === 0, {
        coverage: specialBlocks.length > 0 ? "engine-samples+deterministic-scenario" : "deterministic-scenario-only",
        engineSpecialStateBlocks: specialBlocks.length,
        engineSpecialBlocksWithSuccessFact: specialWithSuccessFact.length,
        engineSamples: specialBlocks.slice(0, 3).map(({ block }) => summarizeBlock(block)),
        // 旧断言查的 `stale_attempt_result` 在仓里不存在（只能 grep 到 interrupted/intercepted），
        // 这就是它“永远没样本也算绿”的原因；现在名字改成引擎真写的两个值。
        engineWritesOnly: SPECIAL_EXECUTION_STATUS,
        deterministicScenario: read,
        note: "judge.js:128 只按 tool_use_id 读块，状态取 erix.executionStatus/erix.success/is_error；"
          + "l0.js:50,68 同样只读 erix.success ?? success（顶层同名键只作旧记录回退）。"
          + "两个特殊状态都不写 erix.success（没跑完 = 无成败），所以它们不得被读成 ok。",
      });
  }

  // ---------- 阶段 D2（在 E/F 之后跑，才能覆盖三个阶段的真实请求）：配对合法性
  // 喂进去的是**实际发给上游的消息视图**（探针在 provider 入口抓的 request.messages），
  // 不是 mainResult.messages：后者是未折叠的 ctx.messages（TTL 只改请求副本，
  // src/loop/provider-runner.js:51-57），拿它当折叠视图 = 根没看过折叠后的序列。
  // 通过条件也不再是「协议转换没抛错」：两个转换器**本身不校验配对**，那是空断言；
  // 现在用仓里既有的严格校验器 src/messages/rounds.js:43 validateMessages，并把
  // orphanResults/danglingUses 归零写进条件。
  ledger.check("pairing-request-views-pass-strict-validation",
    probe.requests > 0 && probe.validationErrorCount === 0, {
      observedUpstreamRequests: probe.requests,
      validationErrors: probe.validationErrorCount,
      samples: probe.validationErrors,
      validator: "src/messages/rounds.js:43 validateMessages(messages, {allowPendingToolUse:false})",
      // 转换仍然跑（转换坏也是红），但它只是附加证据，不是配对判据。
      conversion: probe.conversion,
      contrastWithPreviousVersion: {
        fedPreviously: "mainResult.messages（未折叠的 ctx.messages）",
        finalMessages: unfoldedFinalMessages.length,
        finalToolResults: collectBlocksFromMessages(unfoldedFinalMessages)
          .filter(({ block }) => block.type === "tool_result").length,
        note: "该序列里没有 TTL 占位符（未折叠），所以它不能证明折叠后的配对仍合法",
      },
    });
  ledger.check("pairing-no-orphan-or-dangling-in-request-views",
    probe.requests > 0 && probe.orphanResults === 0 && probe.danglingUses === 0, {
      observedUpstreamRequests: probe.requests,
      orphanResults: probe.orphanResults,
      danglingUses: probe.danglingUses,
      violations: probe.pairViolationSamples,
      note: "这两个计数以前只进 evidence 不进条件（所以转换器不报错也能绿），现在就是通过条件本身",
    });
  // issue #336：`probe.conversion.*.ok` 是**算出来的布尔**，以前只写进 evidence，而旁边的注释还写着
  // 「转换坏也是红」——那是假的：没有任何条件读它（同一个病：写得像核对事实，真假都不红）。
  // 现在它有自己的一条断言：两个协议转换器在**每一个真实请求视图**上都不许抛错。
  ledger.check("request-view-protocol-conversion-survives",
    probe.requests > 0 && probe.conversion.openai.ok === true && probe.conversion.anthropic.ok === true, {
      observedUpstreamRequests: probe.requests,
      openai: probe.conversion.openai,
      anthropic: probe.conversion.anthropic,
      note: "转换器本身不校验配对（那是 pairing-* 两条的事）；本条只管「转换不抛错」。"
        + "两者以前混在同一条 evidence 里，结果谁都没判",
    });

  // ---------- 引擎缺陷探针（只观察不改）
  const defects = [];
  // 被抛弃的请求拒绝（宿主可见）：真机曾以「进程被打死 + 报告没写出」的形式出现。
  // 白名单以外的未处理拒绝 = soak 自己的 bug（把自己的脚本打死的不是引擎），必须红且非 0 退出。
  const whitelistedRejections = unhandledRejections.filter(isKnownAbandonedRequestRejection);
  const unexpectedRejections = unhandledRejections.filter((e) => !isKnownAbandonedRequestRejection(e));
  ledger.check("no-unexpected-unhandled-rejection", unexpectedRejections.length === 0, {
    total: unhandledRejections.length,
    whitelistedKnownAborted: whitelistedRejections.length,
    unexpected: unexpectedRejections.length,
    unexpectedSamples: unexpectedRejections.slice(0, 3),
    whitelistedSamples: whitelistedRejections.slice(0, 3),
    whitelist: "KitError 且 code===\"aborted\"（src/providers/errors.js:174 的分类路径产出）；"
      + "其余一律算阻断性 soak 缺陷（以前一律 blocking:false，会把脚本自己的 bug 全吞掉）",
    fakeCoverageLimit: "fake 不产生 in-flight 网络拒绝（假上游同步返回，abort 落在 tool_result 之后、"
      + "没有在飞请求），"
      + "所以本条在 fake 路径下近乎恒真；真实覆盖靠 --provider real 的长跑（带 abort-at）。",
  });
  if (whitelistedRejections.length > 0) {
    defects.push({
      id: "abandoned-request-rejection-unhandled",
      kind: "宿主可见的 unhandledRejection（能把进程打死）",
      severity: "major",
      where: "src/loop/provider-runner.js:212 → src/providers/openai.js:378 → src/providers/errors.js:174"
        + "（中止后 in-flight 请求的拒绝没人接）",
      why: "Node 22 默认 --unhandled-rejections=throw；宿主若在 abort 后自己还活着只是运气（或装了 handler）。"
        + "最小复现（本地永不响应的 HTTP + 真 createOpenAIProvider + 中途 abort）**不重现**，"
        + "说明触发面比「abort + in-flight」更窄（真机是 rounds=12/compact-every=4/abort-at=6 的长跑组合）",
      blocking: false,
      evidence: whitelistedRejections,
    });
  }
  if (unexpectedRejections.length > 0) {
    defects.push({
      id: "unknown-unhandled-rejection",
      kind: "白名单外的未处理拒绝（soak 自己的缺陷）",
      severity: "major",
      where: "scripts/soak.mjs（未进入已知 KitError(aborted) 形态的 rejection）",
      why: "不能归到已知引擎缺陷上的 rejection 只能有两个源头：soak 脚本自己的 bug，"
        + "或一个需要新白名单条目的未知引擎形态；两种都不能当观察项抹平",
      blocking: true,
      evidence: unexpectedRejections,
    });
  }
  // 未知选项必须被拒（白名单见 src/loop/option-normalization.js:36-97）。文档里的 `governor` 全部是
  // src/reflection/governor.js 的**代码引用**，不是 runToolLoop 选项名——探针的正解是「必须拒」，
  // 不是「文档漂移」（本脚本前一版把它报成漂移，是假阳性）。
  const governorProbe = await probeRunToolLoopOption("governor");
  ledger.check("unknown-run-tool-loop-option-rejected", governorProbe.accepted === false, {
    probedOption: "governor",
    accepted: governorProbe.accepted,
    evidence: governorProbe.evidence,
  });
  // 常量面必须登记 `erix.executionStatus` 的存在条件（issue #286 追加项，已在 0.20.0 的 PR #291 R7 落地）。
  // 前一版这里是**无条件**把「常量缺条件」推成引擎缺陷：0.20.0 之后常量已登记，那条观察项就变成假阳性。
  // 现在改成活锁断言：谁把 `writtenFor` / `presentValues` 删掉或改错，soak 当场红。
  const esFieldContract = TOOL_RESULT_CONTRACT?.engine?.fields?.executionStatus ?? {};
  const presenceRecorded = esFieldContract.writtenFor === "special states only"
    && Array.isArray(esFieldContract.presentValues)
    && [...esFieldContract.presentValues].sort().join(",") === "intercepted,interrupted,rejected";
  ledger.check("contract-constant-records-execution-status-presence", presenceRecorded, {
    writtenFor: esFieldContract.writtenFor ?? null,
    presentValues: esFieldContract.presentValues ?? null,
    source: "TOOL_RESULT_CONTRACT.engine.fields.executionStatus（src/tool-fact.js）",
  });
  if (!presenceRecorded) {
    defects.push({
      id: "tool-fact-constant-missing-execution-status-presence-condition",
      kind: "常量面缺条件（文档已写对）",
      severity: "minor",
      where: "TOOL_RESULT_CONTRACT.engine.fields.executionStatus 没标存在条件（字段元数据在 src/tool-fact.js）vs "
        + "docs/host-consumer-contract.md / _cn.md 的字段表（已写「仅特殊状态 intercepted / interrupted / rejected」）",
      why: "宿主只读 TOOL_RESULT_CONTRACT（随包发布）时看不出该字段是条件存在的，会按「每个块都有」写代码（本脚本工单就中了这个招）",
      blocking: false,
      evidence: { toolResultBlocks: toolResults.length, withExecutionStatus: executionStatusPresent },
    });
  }

  // ---------- 报告
  // 用量口径：abort 阶段的 run 也真的烧过 token（issue #180：aborted 的终局带 usage），
  // 只加 main+resume 会让「主 run 提前失败 + abort 真的跑过」的真机报告报成 0/0。
  const usage = sumUsage([
    mainResult,
    abortInfo?.usage ? { usage: abortInfo.usage } : null,
    resumeInfo?.usage ? { usage: resumeInfo.usage } : null,
  ]);
  const cleanupStore = usedTempStore && !cli.keepStore;
  const report = {
    tool: "soak",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    node: process.version,
    cli: { ...cli, store: storeDir },
    upstream: upstream.describe,
    provider: cli.provider,
    rounds: mainResult?.rounds ?? 0,
    usage,
    usageParts: {
      main: mainResult?.usage ?? null,
      abort: abortInfo?.usage ?? null,
      resume: resumeInfo?.usage ?? null,
    },
    compactions: {
      compactionStats: mainResult?.compactionStats ?? [],
      compactionEvents: counter.compactions,
      budgetTokens,
      perRoundTokens,
    },
    abortRequested: cli.abortAt,
    abortTrigger: cli.abortTrigger,
    abortObservedReason: abortInfo?.reason ?? abortInfo?.termination?.reason ?? null,
    // abort 阶段的结论面（工单 261015-02 小修）：**issue282Rewritten 只在 abortFired 为真时才可能是 true**。
    abortStage,
    abort: abortInfo ?? null,
    resume: resumeInfo ?? null,
    // TTL 与请求视图：这两块是返工后新增的「脚本真的压到了什么」的测量面。
    ttl: {
      option: TOOL_RESULT_TTL,
      engineLayerEvents: counter.ttlFolds.length,
      engineFoldedResults: ttlEngineFolded,
      engineTokensSaved: ttlEngineTokensSaved,
      events: counter.ttlFolds,
    },
    requestViews: {
      captured: probe.requests,
      validationErrors: probe.validationErrorCount,
      orphanResults: probe.orphanResults,
      danglingUses: probe.danglingUses,
      requestsWithFoldedBlock: probe.foldedRequests,
      distinctFoldedResults: probe.distinctFolded.size,
      foldedBlockInstances: probe.foldedInstances,
      tokensBefore: probe.tokensBefore,
      tokensAfter: probe.tokensAfter,
      conversion: probe.conversion,
    },
    storeCleanup: {
      usedTempStore,
      keepStore: cli.keepStore,
      removed: cleanupStore,
      dir: cleanupStore ? storeDir : storeDir,
    },
    storeReconcile: {
      storeDir,
      jsonlLines: mainJsonl.lines,
      jsonlBytes: mainJsonl.bytes,
      loadedRoundRecords: mainRecords.length,
      // 工单 261021 写侧后的新对账口径（行级闭合 + 正文闭合），旧口径是 `jsonlLines == loadedRoundRecords`。
      messageRows: journal.counts.messageRows,
      absorbedMessageRows: journal.counts.absorbedMessageRows,
      standaloneMessageRows: journal.counts.standaloneMessageRows,
      partOfMerges: journal.counts.partOfMerges,
      ledgerMessages: loadedMessages.length,
      independentlyFoldedMessages: journal.orderedMessages.length,
      foldMismatches: foldCompare.mismatches,
      roundEndEvents: counter.roundEnds,
      toolResultEvents: counter.toolResults,
      toolUseEvents: counter.toolUses,
      recordKinds,
      responseContentCopies: responseCopies,
      eventTypes: Object.fromEntries([...counter.byType.entries()].sort()),
    },
    contract: {
      toolResultBlocks: toolResults.length,
      toolUseBlocks: toolUses.length,
      diskKeys: diskKeySet.size,
      projectionKeys: projectionKeys.size,
    },
    assertions: ledger.assertions,
    // 清单/合计在下面两条「事实键分类守卫」跑完之后再补算一次（守卫自己也是断言，要在清单里）
    assertionManifest: [],
    totals: { assertions: 0, passed: 0, failedBlocking: 0, observedNonBlocking: 0 },
    engineDefects: defects,
    unhandledRejections,
  };
  // ---------- 事实键分类守卫（issue #336，故意跑在报告成型之后：它盘的就是报告与台账本身）
  const soakSource = readFileSync(SELF_SOURCE, "utf8");
  const testSource = readFileSync(TEST_SOURCE, "utf8");
  const evidenceAudit = auditEvidenceKeys(soakSource);
  ledger.check(KEY_AUDIT_ASSERTION, evidenceAudit.ok, evidenceAudit);
  const reportAudit = auditReportKeys(report, soakSource, testSource);
  ledger.check(REPORT_AUDIT_ASSERTION, reportAudit.ok, reportAudit);
  report.assertionManifest = ledger.assertions.map((a) => a.name);
  const failing = ledger.assertions.filter((a) => !a.pass && a.blocking);
  report.totals = {
    assertions: ledger.assertions.length,
    passed: ledger.assertions.filter((a) => a.pass).length,
    failedBlocking: failing.length,
    observedNonBlocking: ledger.assertions.filter((a) => !a.pass && !a.blocking).length,
  };
  if (cleanupStore) {
    // --keep-store 与帮助文案得对上（以前帮助说默认清理、实现是保留）：默认真的删，
    // 而且只删自己 mkdtemp 出来的那一个（显式 --store 是宿主的地盘，soak 无权收）。
    await rm(storeDir, { recursive: true, force: true });
  }
  await writeFile(cli.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(`\nsoak 结束：rounds=${report.rounds} compactions=${report.compactions.compactionEvents} `
    + `↑${usage.input_tokens} ↓${usage.output_tokens} `
    + `assertions=${report.totals.passed}/${report.totals.assertions} `
    + `failedBlocking=${report.totals.failedBlocking}\n`);
  process.stdout.write(`报告：${cli.out}\n`);
  process.stdout.write(cleanupStore
    ? `store：${storeDir}（临时目录，已清理；--keep-store 可保留）\n`
    : `store：${storeDir}（已保留）\n`);
  process.exitCode = failing.length === 0 ? 0 : 1;
}

const MESSAGE_ROUND_OVERHEAD_TOKENS = 12;
const MIN_BUDGET_TOKENS = 1;
// TTL 存活轮数（必须是数字，见 common.toolResultTtl 处的注释）。
const TOOL_RESULT_TTL = 1;


// judge / L0 的读取面对**特殊状态块**的读法（确定性场景，不依赖 abort 竞态能不能碰上）。
// 块形状拄引擎自己的写入点：intercepted 见 src/loop/run-snapshot-executor.js:580-591（不写
// is_error/success/round/durationMs），interrupted 见 src/loop/orchestrator.js:2778-2790（is_error 在
// 顶层，erix 只有 toolCallKey+executionStatus）。读取面用仓里真函数：judge.js:90 buildTimeline
// 与 l0.js:35 extractL0Facts（src/index.js 都重导了）。
function probeSpecialStateReadSurface() {
  const fixtureMessages = (results) => ([
    {
      role: "assistant",
      content: results.map((r, i) => ({
        type: "tool_use",
        id: `fixture-id-${String(i)}`,
        name: "soak_touch",
        input: { step: i },
        erix: { toolCallKey: `fixture-key-${String(i)}` },
      })),
    },
    {
      role: "user",
      content: results.map((r, i) => ({ ...r, tool_use_id: `fixture-id-${String(i)}` })),
    },
  ]);
  const statusesFor = (results) => {
    const timeline = buildTimeline(fixtureMessages(results));
    return (timeline.toolCalls ?? []).map((call) => call.status);
  };
  const contractResults = [
    {
      type: "tool_result",
      content: "【审计拦截】方向可能偏: soak 固定场景。原工具调用未执行，请重新评估方向后继续。",
      erix: { toolCallKey: "fixture-key-0", executionStatus: "intercepted" },
    },
    {
      type: "tool_result",
      content: "The previous execution was interrupted before its outcome could be recorded.",
      is_error: true,
      erix: { toolCallKey: "fixture-key-1", executionStatus: "interrupted" },
    },
  ];
  // 正控制（牙齿）：同样两个位置换成普通成功块，必须读成 ok。
  // 如果读面是死的（全 pending / 全 ok），这里就会红而不是“没样本也算绿”。
  const controlResults = contractResults.map((block) => ({
    type: "tool_result",
    content: "soak normal result",
    erix: { toolCallKey: block.erix.toolCallKey, round: 1, durationMs: 1, success: true },
  }));
  const contractStatuses = statusesFor(contractResults);
  const controlStatuses = statusesFor(controlResults);
  const l0 = extractL0Facts(fixtureMessages(contractResults));
  const out = {
    contractStatuses,
    controlStatuses,
    contractExitOk: l0.exitOk,
    contractHasErrorFact: (l0.errorTexts ?? []).length > 0,
  };
  out.asExpected = contractStatuses[0] === "intercepted"
    && contractStatuses[1] === "error"
    && controlStatuses.length === 2
    && controlStatuses.every((status) => status === "ok")
    && out.contractExitOk === false
    && out.contractHasErrorFact === true;
  return out;
}

// 只读探针：拿一个选项名去撞白名单检查（选项验证在任何宿主端口被读之前就先抛），
// 因此不会真跑一个 run，也不联网。
async function probeRunToolLoopOption(name) {
  try {
    await runToolLoop({ [name]: false });
    return { name, accepted: true, evidence: "no unknown-option rejection" };
  } catch (error) {
    const message = String(error?.message ?? error);
    return { name, accepted: !message.includes("unknown runToolLoop option"), evidence: message };
  }
}

function tallyRecordKinds(records) {
  const tally = {};
  const list = toList(records);
  for (const record of list) {
    // 引擎轮记录带 response；initialUserMessage 那一条是 seed（round 0，无 response）
    const kind = record?.response
      ? (record?.folded ? "engineRoundFolded" : "engineRound")
      : (typeof record?.round === "number" ? "seedOrHostAppend" : "other");
    tally[kind] = (tally[kind] ?? 0) + 1;
  }
  tally.total = list.length;
  tally.engineRounds = (tally.engineRound ?? 0) + (tally.engineRoundFolded ?? 0);
  tally.nonRound = tally.total - tally.engineRounds;
  return tally;
}

function summarizeBlock(block) {
  return {
    type: block?.type,
    id: block?.id,
    erixKeys: Object.keys(block?.erix ?? {}),
    toolCallKey: block?.erix?.toolCallKey,
    executionStatus: block?.erix?.executionStatus,
    durationMs: block?.erix?.durationMs,
  };
}

function sumUsage(results) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const result of results) {
    if (!result?.usage) continue;
    usage.input_tokens += Number(result.usage.input_tokens ?? 0);
    usage.output_tokens += Number(result.usage.output_tokens ?? 0);
  }
  return usage;
}

// judge / L0 的读路径（已上面的 probeSpecialStateReadSurface 用真函数跑过）：
// src/reflection/judge.js:128 与 src/reflection/l0.js:50,68 都只读 `erix.success ?? success`，
// 顶层旧同名键只作升级前记录的回退（所以旧实现手抄一个假读面自己算自己，现在改成真函数）。

// 入口：CLI 解析/配置读取类错误走干净的拒绝（不泄栈、非 0），不静默给退出码 0。
try {
  await main();
} catch (error) {
  process.stderr.write(`soak 失败：${String(error?.message ?? error)}\n${USAGE}`);
  process.exitCode = 2;
}
