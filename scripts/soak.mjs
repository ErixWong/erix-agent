#!/usr/bin/env node
// scripts/soak.mjs — 长跑 soak（issue #257 T6 / 工单 261015-02）。
// 定位：**只观察引擎，不修改引擎**。发现缺陷只写进报告（只报不修）。
// 红线：零 npm 运行时依赖（只用 node: 内置 + 相对路径）、纯 ESM、Node 22、
//       绝不写真实 ~/.erix（store 走临时目录）、源码里不出现任何模型名。
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// 中止/重试路径上，被抛弃的 in-flight 请求可能在 run 已经收口之后才拒绝。Node 22 默认
// `--unhandled-rejections=throw` 会**直接把进程打死**（真机 soak 实测：abort 之后报告根本没写出来）。
// 这里先接住并记进报告：soak 的职责是测量它，不是被它杀掉。
const unhandledRejections = [];
process.on("unhandledRejection", (error) => {
  unhandledRejections.push({
    message: String(error?.message ?? error),
    code: error?.code,
    reason: error?.termination?.reason,
  });
});

import {
  createAnthropicProvider,
  createFileTranscriptStore,
  createOpenAIProvider,
  estimateTokens,
  projectTranscriptForDisplay,
  runToolLoop,
} from "../src/index.js";
import { canonicalToAnthropicRequest, canonicalToOpenAIMessages } from "../src/index.js";

// ---------------------------------------------------------------- CLI

const USAGE = `用法：node scripts/soak.mjs [--provider fake|real] [--rounds n] [--store dir]
        [--out file] [--compact-every n] [--abort-at n] [--slot name] [--keep-store]

  --provider      fake = 注入脚本化假上游（不联网，CI/无 key 可用）；real = 真模型（默认）
  --rounds        长轮回放轮数（默认 200）
  --store         transcript store 目录（默认临时目录；绝不写真实 ~/.erix）
  --out           结构化 JSON 报告落盘路径（默认 /tmp/soak-report.json）
  --compact-every 每 n 轮逼一次强制压缩（把 budgetTokens 调到必然触发；默认 25）
  --abort-at      第 n 轮中止（默认 rounds>=4 时取 ceil(rounds/2)，否则 0=跳过）
  --slot          real 路径读 config 的槽位名（默认 default）
  --keep-store    跑完不清理 store 目录（默认清理临时目录）
`;

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
  if (!Number.isInteger(abortAt) || abortAt < 0) throw new Error("--abort-at 必须是 >=0 的整数");
  return {
    provider,
    rounds,
    store: values.store,
    out: values.out ?? "/tmp/soak-report.json",
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

function createEventCounter() {
  const counter = {
    byType: new Map(),
    roundEnds: 0,
    toolResults: 0,
    toolUses: 0,
    compactions: 0,
    persistenceFailures: 0,
    errors: [],
  };
  counter.onEvent = (event) => {
    const type = event?.type ?? "unknown";
    counter.byType.set(type, (counter.byType.get(type) ?? 0) + 1);
    if (type === "round_end") counter.roundEnds += 1;
    if (type === "tool_result") counter.toolResults += 1;
    if (type === "tool_use") counter.toolUses += 1;
    // 引擎事件形状：{type:"compaction", round, compaction:{...}}（src/loop/orchestrator.js:1688），
    // compacted 住在 event.compaction 里；两种位置都容错。
    if (type === "compaction" && (event?.compacted === true || event?.compaction?.compacted === true)) {
      counter.compactions += 1;
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
  const ledger = createLedger();

  const upstream = cli.provider === "fake"
    ? createFakeUpstream({ tokensPerRound: 40 })
    : createRealUpstream(cli.slot);

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
    toolResultTtl: { enabled: true, rounds: 1 },
    toolResultFoldMinTokens: 1,
  };

  // ---------- 阶段 A：长轮回放（含强制压缩）
  if (cli.provider === "fake") upstream.setBudget(cli.rounds);
  const mainRunId = `soak-main-${Date.now().toString(36)}`;
  const counter = createEventCounter();
  let mainResult;
  let mainError;
  try {
    mainResult = await runToolLoop({
      ...common,
      runId: mainRunId,
      maxRounds: cli.rounds,
      initialUserMessage: "soak：开始长轮回放",
      onEvent: counter.onEvent,
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
    ledger.check("long-replay-completes", mainResult.rounds === cli.rounds, {
      rounds: mainResult.rounds,
      expected: cli.rounds,
      truncated: mainResult.truncated,
      terminationReason: mainResult.termination?.reason,
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
      explanation: "jsonl 行数 = 引擎轮记录 + seed（initialUserMessage）那一条；"
        + "round_end 事件数只应等于引擎轮记录数",
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
  for (const { block } of toolResults) {
    const missing = CORE_ERIX.filter((f) => block?.erix?.[f] === undefined);
    for (const f of missing) {
      missingFieldTally[f] = (missingFieldTally[f] ?? 0) + 1;
      if (missingSamples.length < 3) missingSamples.push({ field: f, block: summarizeBlock(block) });
    }
    if (block?.erix?.executionStatus !== undefined) executionStatusPresent += 1;
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
  ledger.check("contract-projection-durationms-equals-disk", durationMismatches.length === 0, {
    projectedWithDuration: projectionDuration.size,
    diskWithDuration: diskDuration.size,
    mismatches: durationMismatches.slice(0, 5),
  });
  const zeroSubstituted = [...projectionDuration].filter(
    ([key, value]) => value === 0 && !diskDuration.has(key),
  );
  ledger.check("contract-projection-missing-duration-not-zero", zeroSubstituted.length === 0, {
    zerosWithoutDiskFact: zeroSubstituted.slice(0, 5),
  });

  // ---------- 阶段 D：压缩后 tool_use/tool_result 配对合法性（过协议转换）
  const foldedMessages = mainResult?.messages ?? [];
  const pairing = checkPairing(foldedMessages);
  ledger.check("pairing-openai-conversion-clean", pairing.openai.ok, {
    foldedMessages: foldedMessages.length,
    ...pairing.openai,
    ...{ orphanResults: pairing.orphanResults, danglingUses: pairing.danglingUses },
  });
  ledger.check("pairing-anthropic-conversion-clean", pairing.anthropic.ok, {
    ...pairing.anthropic,
  });

  // ---------- 阶段 E：中途 abort（观察 #282：reason 是否被写成 judge_done）
  let abortInfo;
  let abortRunId;
  let historyBeforeResume = null;
  let recordsBeforeResume = 0;
  let keysBeforeResume = [];
  if (cli.abortAt > 0) {
    if (cli.provider === "fake") upstream.setBudget(cli.rounds);
    abortRunId = `soak-abort-${Date.now().toString(36)}`;
    const abortCounter = createEventCounter();
    const controller = new AbortController();
    let abortedAtRound = null;
    try {
      const res = await runToolLoop({
        ...common,
        runId: abortRunId,
        maxRounds: cli.rounds,
        initialUserMessage: "soak：abort 与 resume 观察",
        signal: controller.signal,
        onEvent: abortCounter.onEvent,
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
    const resumeCounter = createEventCounter();
    const resumeRunId = abortRunId;
    const snapshotFile = path.join(storeDir, `${resumeRunId}.snapshot.json`);
    try {
      const resumed = await runToolLoop({
        ...common,
        runId: resumeRunId,
        resume: true,
        maxRounds: resumeRounds,
        onEvent: resumeCounter.onEvent,
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

    const staleBlocks = collectBlocksFromRecords(afterRecords)
      .filter(({ block }) => block?.erix?.executionStatus === "stale_attempt_result");
    const staleRead = {
      onDisk: simulateStaleFactRead(collectBlocksFromRecords(afterRecords)),
    };
    ledger.check("resume-stale-attempt-facts-invisible-to-judge-l0",
      staleRead.onDisk.staleWithToolUseId === 0, {
        staleAttemptBlocks: staleBlocks.length,
        staleWithoutToolUseId: staleRead.onDisk.staleWithoutId,
        staleWithToolUseId: staleRead.onDisk.staleWithToolUseId,
        liveToolUseIds: staleRead.onDisk.liveIds,
        note: "judge.js:128 / l0.js:50,68 只按 tool_use_id / 结果列表读 erix.success；"
          + "stale 块无 tool_use_id 即结构上读不到",
        samples: staleBlocks.slice(0, 3).map(({ block }) => summarizeBlock(block)),
      });
  }

  // ---------- 引擎缺陷探针（只观察不改）
  const defects = [];
  // 被抛弃的请求拒绝（宿主可见）：真机曾以「进程被打死 + 报告没写出」的形式出现。
  ledger.check("no-unhandled-rejection-during-abort", unhandledRejections.length === 0, {
    count: unhandledRejections.length,
    samples: unhandledRejections.slice(0, 3),
    note: "非阻断观察项：真因在引擎（provider-runner.js:212 → providers/openai.js:378 → providers/errors.js:174），本单只报不修",
  }, { blocking: false });
  if (unhandledRejections.length > 0) {
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
      evidence: unhandledRejections,
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
    totals: {
      assertions: ledger.assertions.length,
      passed: ledger.assertions.filter((a) => a.pass).length,
      failedBlocking: failing.length,
      observedNonBlocking: ledger.assertions.filter((a) => !a.pass && !a.blocking).length,
    },
    engineDefects: defects,
    unhandledRejections,
  };
  await writeFile(cli.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(`\nsoak 结束：rounds=${report.rounds} compactions=${report.compactions.compactionEvents} `
    + `↑${usage.input_tokens} ↓${usage.output_tokens} `
    + `assertions=${report.totals.passed}/${report.totals.assertions} `
    + `failedBlocking=${report.totals.failedBlocking}\n`);
  process.stdout.write(`报告：${cli.out}\n`);
  if (!cli.keepStore && usedTempStore) {
    process.stdout.write(`store：${storeDir}（临时目录，已保留供排查）\n`);
  }
  process.exitCode = failing.length === 0 ? 0 : 1;
}

const MESSAGE_ROUND_OVERHEAD_TOKENS = 12;
const MIN_BUDGET_TOKENS = 1;

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

// judge/L0 的读取面（src/reflection/judge.js:128、src/reflection/l0.js:50,68）：两边都按
// `tool_use_id` / 结果列表读 `erix.success ?? success`。stale_attempt_result 块**按契约没有
// tool_use_id**，因此在结构上读不到；真读到了（同 id 被 stale 块后写覆盖）就是缺陷。
function simulateStaleFactRead(entries) {
  const statusById = new Map();
  const staleById = new Map();
  const staleWithoutId = [];
  for (const { block } of toList(entries)) {
    if (block.type !== "tool_result") continue;
    const id = block.tool_use_id;
    const stale = block?.erix?.executionStatus === "stale_attempt_result";
    if (id === undefined) {
      if (stale) staleWithoutId.push(block?.erix?.toolCallKey ?? null);
      continue;
    }
    const success = block.erix?.success ?? block.success;
    const status = block.is_error === true || success === false ? "error" : "ok";
    if (stale) {
      staleById.set(id, { status, success: block.erix?.success });
    } else if (staleById.has(id)) {
      // 同 id 已有 stale 块：jud 取后写者，live 块在 stale 之后即安全
      statusById.set(id, { status, fromStale: false });
    } else {
      statusById.set(id, { status, fromStale: false });
    }
  }
  return {
    staleTotal: staleById.size + staleWithoutId.length,
    staleWithToolUseId: staleById.size,
    staleWithoutId: staleWithoutId.length,
    liveIds: statusById.size,
  };
}

function checkPairing(messages) {
  const out = {
    openai: { ok: false },
    anthropic: { ok: false },
    orphanResults: 0,
    danglingUses: 0,
  };
  const useIds = new Set();
  const resultIds = new Set();
  for (const { block } of collectBlocksFromMessages(messages)) {
    if (block.type === "tool_use") useIds.add(block.id ?? block?.erix?.toolCallKey);
    if (block.type === "tool_result") resultIds.add(block.tool_use_id ?? block.id ?? block?.erix?.toolCallKey);
  }
  out.orphanResults = [...resultIds].filter((id) => !useIds.has(id)).length;
  out.danglingUses = [...useIds].filter((id) => !resultIds.has(id)).length;
  try {
    const converted = canonicalToOpenAIMessages("soak", messages);
    out.openai = { ok: true, convertedMessages: toList(converted).length };
  } catch (error) {
    out.openai = { ok: false, error: String(error?.message ?? error), code: error?.code };
  }
  try {
    canonicalToAnthropicRequest({ system: "soak", messages, tools: [SOAK_TOOL], maxTokens: 1024 });
    out.anthropic = { ok: true };
  } catch (error) {
    out.anthropic = { ok: false, error: String(error?.message ?? error), code: error?.code };
  }
  return out;
}

// 入口：CLI 解析/配置读取类错误走干净的拒绝（不泄栈、非 0），不静默给退出码 0。
try {
  await main();
} catch (error) {
  process.stderr.write(`soak 失败：${String(error?.message ?? error)}\n${USAGE}`);
  process.exitCode = 2;
}
