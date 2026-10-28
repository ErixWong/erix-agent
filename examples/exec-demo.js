// exec-demo —— v0.0 垂直切片 e2e：真实 LLM + 命令执行工具的多轮工具循环
//
// 红线实证（ADR-005）：库不执行任何东西。exec 工具的执行体、白名单、超时、
// 输出截断全部在本文件（调用方侧）。库只提供 provider + runToolLoop。
//
// LLM 配置直接读 pi 的 ~/.pi/agent/models.json（apiKeyFile 哲学：凭据不落本仓库）。
// provider 槽位名与模型名**都不写死**（AGENTS.md §8：Never hardcode model names）：槽位名随用户配置走，
// 解析顺序见下面的 loadRelayConfig。
//
// 用法：
//   node examples/exec-demo.js ["任务描述"]        # 手动跑
//   LLM_KIT_E2E=1 node examples/exec-demo.test.mjs # 测试形态
// 环境变量（配置解析入口；三个都不设也能在单 provider 机器上跑）：
//   LLM_KIT_RELAY_PROVIDER  models.json 里的 provider 槽位名（按名字取；名字不存在则报错列候选）
//   LLM_KIT_RELAY_URL       relay baseUrl，按同源匹配挑 provider（比较前规范化尾部斜杠）
//   LLM_KIT_MODEL           指定模型 id；未指定 provider 时也能凭它在各 provider 的模型列表里反查
//   三者都没设：models.json 只有一个 provider 就直接用它；多个则抛错并列出候选名与各自模型列表。

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpenAIProvider, runToolLoop, createMemoryTranscriptStore, createFoldStatisticalStrategy } from "../src/index.js";

/**
 * demo 侧的模型偏好表——**只是本 demo 的口味**，不是仓库规则：
 * 按顺序与「已匹配 provider 的 models 列表」逐项求交，第一个命中的才用；
 * 交集为空就抛错列出可用模型，绝不静默回落到列表外的名字（AGENTS.md §8）。
 */
export const DEMO_MODEL_PREFERENCES = ["kimi-for-coding", "k3"];

/** models.json 里一个 provider 条目声明的模型 id 列表（字段名是 id） */
function modelIdsOf(providerEntry) {
  return (providerEntry?.models ?? [])
    .map((model) => String(model?.id ?? ""))
    .filter((id) => id.length > 0);
}

/** baseUrl 同源比较前的规范化：去首尾空白与尾部斜杠（配置写 /v1、环境变量给 /v1/ 必须算同一个） */
function normalizeBaseUrl(url) {
  return String(url ?? "").trim().replace(/\/+$/u, "");
}

function originOf(url) {
  try {
    return new URL(normalizeBaseUrl(url)).origin;
  } catch {
    return "";
  }
}

/** 把可选 provider 连同各自 baseUrl / 模型列表摊开成文本，让报错能让人一眼选（不只给一个死名字） */
function describeProviders(providers) {
  const entries = Object.entries(providers ?? {});
  if (entries.length === 0) return "(models.json 里没有任何 provider)";
  return entries
    .map(([name, entry]) => `  - ${name}: baseUrl=${entry?.baseUrl ?? "(缺)"}; models=[${modelIdsOf(entry).join(", ")}]`)
    .join("\n");
}

/**
 * 按优先级挑 provider，返回 [name, entry]：
 * ①LLM_KIT_RELAY_PROVIDER 按名字 → ②LLM_KIT_RELAY_URL 同源匹配 baseUrl
 * → ③LLM_KIT_MODEL 反查含该模型的 provider → ④只有一个 provider 就用它 → ⑤抛错并列出候选。
 * 显式给出的槽位名/URL 找不到时直接抛错列候选（显式意图不静默换槽位）；
 * 而 LLM_KIT_MODEL 没被任何 provider 声明时往下递到 ④/⑤：单 provider 机器上用户显式指定的
 * 模型照样能用（models.json 可能没登记新模型），多 provider 才报「无法选定」并列候选。
 */
function resolveProvider(providers, env) {
  const names = Object.keys(providers ?? {});
  const candidateHint = () => `可选 provider（LLM_KIT_RELAY_PROVIDER / LLM_KIT_RELAY_URL / LLM_KIT_MODEL 三选一）：\n${describeProviders(providers)}`;

  const wantedName = String(env.LLM_KIT_RELAY_PROVIDER ?? "").trim();
  if (wantedName) {
    if (!providers[wantedName]) {
      throw new Error(`models.json 里没有名为 "${wantedName}" 的 provider（LLM_KIT_RELAY_PROVIDER）。\n${candidateHint()}`);
    }
    return [wantedName, providers[wantedName]];
  }

  const wantedUrl = String(env.LLM_KIT_RELAY_URL ?? "").trim();
  if (wantedUrl) {
    const target = normalizeBaseUrl(wantedUrl);
    const exact = names.find((name) => normalizeBaseUrl(providers[name]?.baseUrl) === target);
    if (exact) return [exact, providers[exact]];
    // 全串不等再退一步比 origin（同源做法）；多个同源 → 歧义，不猜
    const origin = originOf(wantedUrl);
    const sameOrigin = origin ? names.filter((name) => originOf(providers[name]?.baseUrl) === origin) : [];
    if (sameOrigin.length === 1) return [sameOrigin[0], providers[sameOrigin[0]]];
    throw new Error(
      sameOrigin.length > 1
        ? `LLM_KIT_RELAY_URL "${wantedUrl}" 在同源 provider 之间有歧义（${sameOrigin.join(", ")}），请改用 LLM_KIT_RELAY_PROVIDER 指定。\n${candidateHint()}`
        : `models.json 里没有 baseUrl 匹配 "${wantedUrl}" 的 provider（LLM_KIT_RELAY_URL，已忽略尾部斜杠差异）。\n${candidateHint()}`,
    );
  }

  const wantedModel = String(env.LLM_KIT_MODEL ?? "").trim();
  if (wantedModel) {
    const owner = names.find((name) => modelIdsOf(providers[name]).includes(wantedModel));
    if (owner) return [owner, providers[owner]];
    // 没有任何 provider 声明它：不在这里硬失败，递到下面的 ④/⑤（见函数头说明）。
  }

  if (names.length === 1) return [names[0], providers[names[0]]];
  throw new Error(
    `models.json 里有 ${names.length} 个 provider（${names.join(", ")}）`
    + `${wantedModel ? `，且没有哪个声明模型 "${wantedModel}"（LLM_KIT_MODEL）` : ""}`
    + `，无法在不写死名字的前提下选定其一。\n${candidateHint()}`,
  );
}

/** 模型解析：LLM_KIT_MODEL 优先；否则在已匹配 provider 的模型列表里按偏好表求交，交集为空即抛错 */
function resolveModel(providerEntry, env) {
  const explicit = String(env.LLM_KIT_MODEL ?? "").trim();
  if (explicit) return explicit;
  const available = modelIdsOf(providerEntry);
  const picked = DEMO_MODEL_PREFERENCES.find((preference) => available.includes(preference));
  if (!picked) {
    throw new Error(
      `该 provider 的 models 列表里没有 demo 偏好表 [${DEMO_MODEL_PREFERENCES.join(", ")}] 中的任何一个，\n` +
      `可用模型=[${available.join(", ")}]；请设 LLM_KIT_MODEL 从其中挑一个（不在列表里的名字不做静默回落）。`,
    );
  }
  return picked;
}

/**
 * 从 pi models.json 读 relay 配置（单一来源，不复制凭据）。
 * opts.env 默认 process.env，便于用例注入；模型/槽位名一律由解析得出，见文件头「环境变量」。
 */
export async function loadRelayConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const modelsJson = JSON.parse(
    await readFile(join(homedir(), ".pi/agent/models.json"), "utf8"),
  );
  const [providerName, relay] = resolveProvider(modelsJson.providers ?? {}, env);
  const model = resolveModel(relay, env);
  const first = relay.models?.[0];
  if (!first) {
    throw new Error(`provider "${providerName}" 的 models 列表为空，读不出 contextWindow/maxTokens。\n${describeProviders(modelsJson.providers ?? {})}`);
  }
  return {
    provider: providerName,
    endpoint: relay.baseUrl,
    apiKey: relay.apiKey,
    model,
    // 取值来源保持不变（工单 E2EPROV：别顺手改语义）：仍是 models[0] 的 contextWindow，
    // maxOutputTokens 夹到 8192 是 issue #245 钉过的输出预算上限。
    contextWindowTokens: first.contextWindow,
    maxOutputTokens: Math.min(first.maxTokens ?? 8192, 8192),
  };
}

/**
 * 由 relay 配置构造 provider（issue #245 第 3 件）。
 *
 * `maxOutputTokens` 必须真的进到 provider 构造参数里：不传它，relay 就没有输出上限，
 * 真实 LLM e2e 的单轮输出量（以及跑多久）不可控。provider 工厂可注入，
 * 是为了能在**不联网**的条件下断言这个参数确实传到了构造函数上（默认仍是 createOpenAIProvider）。
 */
export function createProviderFromConfig(cfg, createProvider = createOpenAIProvider) {
  return createProvider({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxOutputTokens: cfg.maxOutputTokens,
    timeoutMs: 120_000,
  });
}

// ---- 调用方安全层（示范：白名单 + 超时 + 截断，生产场景应更严）----

const EXEC_WHITELIST = new Set(["ls", "pwd", "echo", "date", "uname", "head", "cat", "wc", "find", "git"]);
const EXEC_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 4096;

const tools = [
  {
    name: "exec",
    description: "在白名单内执行 shell 命令（ls/pwd/echo/date/uname/head/cat/wc/find/git），返回 stdout+stderr",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
  },
];

function truncate(s) {
  return s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) + `\n…[截断，共 ${s.length} 字符]` : s;
}

/** executeTool：库的唯一执行入口，实现在调用方 */
async function executeTool({ name, input }) {
  if (name !== "exec") throw new Error(`未知工具: ${name}`);
  const command = String(input?.command ?? "");
  const bin = command.trim().split(/\s+/)[0];
  if (!EXEC_WHITELIST.has(bin)) {
    return `错误：命令 "${bin}" 不在白名单（${[...EXEC_WHITELIST].join("/")}）`;
  }
  return await new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.killed) return resolve(`错误：命令超时（${EXEC_TIMEOUT_MS}ms）被终止`);
      const out = [stdout, stderr].filter(Boolean).join("");
      resolve(truncate(out || (err ? `退出码 ${err.code}` : "(无输出)")));
    });
  });
}

/** 跑一次 demo，返回 loop 结果（测试与 CLI 共用）。opts.compactBudgetTokens 设小预算可强制触发 fold-statistical 压缩 */
export async function runExecDemo(task = "查看当前目录有哪些文件，并简要总结这个项目", opts = {}) {
  const cfg = await loadRelayConfig();
  const provider = createProviderFromConfig(cfg);
  const store = createMemoryTranscriptStore();
  const runId = `exec-demo-${Date.now()}`;

  // #498 S3 (`input` slice A): the flat `initialMessages` retired — its home is
  // `config.input.messages` (the one registered leaf alias, which expands back to
  // `effectiveOptions.initialMessages`). Built as one object so both optional blocks below
  // (seed history, small compaction budget) share a single `config` key instead of racing.
  const config = {};
  if (opts.initialMessages) config.input = { messages: opts.initialMessages };
  // #498 S3 A2b: the top-level `initialUserMessage` retired too — its home is
  // `config.input.initialUserMessage`. Same object as the seed history above, so the two never race
  // for the `config` key (and `initialMessages` still wins on the read side, unchanged).
  if (!opts.initialMessages) config.input = { ...(config.input ?? {}), initialUserMessage: task };
  // #498 S3: the top-level `context` shell is retired. The bag mixes data with a **behaviour**
  // carrier (the strategy object), so it splits by value shape: numbers/strings go to
  // `config.folding.context`, the strategy object to `capabilities.ports.strategy`.
  if (opts.compactBudgetTokens) {
    config.folding = { context: {
      budgetTokens: opts.compactBudgetTokens,
      keepRounds: opts.keepRounds ?? 1,
    } };
  }

  const result = await runToolLoop({
    provider,
    system: "你是一个命令行助手。用 exec 工具完成用户的查看类任务，然后用中文简要总结。命令必须在白名单内。",
    tools,
    executeTool,
    maxRounds: 8,
    store,
    runId,
    ...(Object.keys(config).length === 0 ? {} : { config }),
    ...(opts.compactBudgetTokens
      ? { capabilities: { ports: { strategy: createFoldStatisticalStrategy() } } }
      : {}),
    onRound: (info) => console.log(`[round ${info.round}] +${info.messages.length} 条消息${info.folded ? "（含折叠）" : ""}`),
  });
  return { result, store, runId, model: cfg.model };
}

// CLI 入口（被 import 时不执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  const { result, store, runId, model } = await runExecDemo(process.argv[2]);
  console.log("\n=== 终稿 ===\n" + result.finalText);
  console.log(`\n=== 统计 === model=${model} rounds=${result.rounds} truncated=${result.truncated} usage=${JSON.stringify(result.usage)}`);
  const transcript = await store.load(runId);
  console.log(`=== transcript === ${transcript.length} 轮已存 memory store`);
}
