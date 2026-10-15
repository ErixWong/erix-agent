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
  --abort-at      第 n 轮中止（默认 rounds>=4 时取 ceil(rounds/2)，否则 0=跳过）
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
  const abortAt = values["abort-at"] === undefined
    ? (rounds >= 4 ? Math.ceil(rounds / 2) : 0)
    : Number.parseInt(values["abort-at"], 10);
  if (values["abort-at"] !== undefined && (!Number.isInteger(abortAt) || abortAt < 0)) {
    throw new Error("--abort-at 必须是 >=0 的整数");
  }
  // 归属校验放在解析阶段：干净拒绝（顶层 catch → exit 2 + USAGE），不是一句 ENOENT 也不是静默照跑。
  const store = values.store === undefined ? undefined : underRealErixHome(values.store, "--store");
  const out = underRealErixHome(values.out ?? "/tmp/soak-report.json", "--out");
  return {
    provider,
    rounds,
    store,
    out,
    compactEvery,
    abortAt: abortAt >= rounds ? 0 : abortAt,
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

  // ---------- 阶段 B：三方对账（落盘行数 / store.load / 事件流）
  const mainRecords = await common.store.load(mainRunId);
  const mainJsonl = await countJsonlLines(storeDir, mainRunId);
  const recordKinds = tallyRecordKinds(mainRecords);
  const responseCopies = tallyResponseCopies(mainRecords);
  ledger.check("store-reconcile-jsonl-vs-load",
    mainJsonl.lines === mainRecords.length, {
      jsonlLines: mainJsonl.lines,
      loadedRoundRecords: mainRecords.length,
      recordKinds,
      responseContentCopies: responseCopies,
      file: path.basename(mainJsonl.file),
    });
  ledger.check("store-reconcile-event-stream",
    counter.roundEnds === recordKinds.engineRounds && counter.toolResults > 0, {
      roundEndEvents: counter.roundEnds,
      engineRoundRecords: recordKinds.engineRounds,
      toolResultEvents: counter.toolResults,
      toolUseEvents: counter.toolUses,
      loadedRoundRecords: mainRecords.length,
      nonEngineRoundRecords: recordKinds.nonRound,
      composition: `jsonlLines=${mainJsonl.lines} = 引擎轮记录 ${recordKinds.engineRounds}`
        + ` + seed 记录 ${recordKinds.nonRound}`,
      compositionMatches: mainJsonl.lines === recordKinds.engineRounds + recordKinds.nonRound,
      explanation: "seed 记录不是某一轮的消息副本，也不是「initialUserMessage 自己占一行」："
        + "initialUserMessage 只进内存消息（src/loop/orchestrator.js:1412-1413），而轮记录写的是"
        + " messages.slice(roundStart)（src/loop/orchestrator.js:2904）。那一行是**非 resume 分支专门归档的"
        + " round=0 种子记录**（src/loop/resume-manager.js:274-289，dedupKey=`<runId>:engine:round:0:seed`，"
        + "内容 = 初始消息，无 response），目的是 ADR-002 的档案完整性（fold 后还能恢复初始历史）。"
        + " round_end 事件只等于引擎轮记录数（seed 不是轮）。",
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
  const SPECIAL_EXECUTION_STATUS = ["intercepted", "interrupted"];
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
  let abortInfo;
  let abortRunId;
  let historyBeforeResume = null;
  let recordsBeforeResume = 0;
  let keysBeforeResume = [];
  if (cli.abortAt > 0) {
    if (cli.provider === "fake") upstream.setBudget(cli.rounds);
    abortRunId = `soak-abort-${Date.now().toString(36)}`;
    track.phase = "abort";
    const abortCounter = createEventCounter({ resultOrigins });
    const controller = new AbortController();
    let abortedAtRound = null;
    try {
      const res = await runToolLoop({
        ...common,
        runId: abortRunId,
        maxRounds: cli.rounds,
        initialUserMessage: "soak：abort 与 resume 观察",
        signal: controller.signal,
        onEvent: onEventFor(abortCounter),
        onRound: ({ round }) => {
          if (round === cli.abortAt && abortedAtRound === null) {
            abortedAtRound = round;
            controller.abort();
          }
        },
      });
      abortInfo = { threw: false, termination: res.termination, rounds: res.rounds };
    } catch (error) {
      abortInfo = {
        threw: true,
        reason: error?.termination?.reason,
        hasUsage: error?.termination?.usage !== undefined,
        hasRounds: error?.termination?.rounds !== undefined,
        partial: error?.termination?.partial,
        message: String(error?.message ?? error),
        code: error?.code,
        abortedAtRound,
      };
    }
    const abortedReason = abortInfo.threw ? abortInfo.reason : abortInfo.termination?.reason;
    ledger.check("abort-termination-reason-is-aborted", abortedReason === "aborted", {
      observedReason: abortedReason ?? null,
      issue282Rewritten: abortedReason === "judge_done",
      abortedAtRound: abortInfo.abortedAtRound ?? cli.abortAt,
    }, { blocking: false, knownIssue: "#282" });
    ledger.check("abort-error-carries-usage-rounds-partial",
      abortInfo.threw === true && abortInfo.hasUsage && abortInfo.hasRounds
      && abortInfo.partial === true, { abortInfo });

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
    // （src/ 只写 interrupted/intercepted），而 fake 的 abort 落在轮间、根本没有在飞调用，
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
    fakeCoverageLimit: "fake 不产生 in-flight 网络拒绝（假上游同步返回、abort 落在轮间），"
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
  if (toolResults.length > 0) {
    defects.push({
      id: "tool-fact-constant-missing-execution-status-presence-condition",
      kind: "常量面缺条件（文档已写对）",
      severity: "minor",
      where: "src/tool-fact.js:70-75（engine.executionStatus 的字段元数据**没标存在条件**）vs "
        + "docs/host-consumer-contract.md:2073 / _cn.md:1635（已写「仅特殊状态 intercepted/interrupted」）",
      why: "宿主只读 TOOL_RESULT_CONTRACT（随包发布）时看不出该字段是条件存在的，会按「每个块都有」写代码（本脚本工单就中了这个招）",
      blocking: false,
      evidence: { toolResultBlocks: toolResults.length, withExecutionStatus: executionStatusPresent },
    });
  }

  // ---------- 报告
  const usage = sumUsage([mainResult, resumeInfo?.usage ? { usage: resumeInfo.usage } : null]);
  const failing = ledger.assertions.filter((a) => !a.pass && a.blocking);
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
    compactions: {
      compactionStats: mainResult?.compactionStats ?? [],
      compactionEvents: counter.compactions,
      budgetTokens,
      perRoundTokens,
    },
    abortRequested: cli.abortAt,
    abortObservedReason: abortInfo?.reason ?? abortInfo?.termination?.reason ?? null,
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
    assertionManifest: ledger.assertions.map((a) => a.name),
    totals: {
      assertions: ledger.assertions.length,
      passed: ledger.assertions.filter((a) => a.pass).length,
      failedBlocking: failing.length,
      observedNonBlocking: ledger.assertions.filter((a) => !a.pass && !a.blocking).length,
    },
    engineDefects: defects,
    unhandledRejections,
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
