#!/usr/bin/env node
/**
 * issue #592：压缩收益口径 = 「每任务总输入 + 重复劳动率」，**压缩率不参与判定**。
 *
 * 病根（票面）：压缩的收益是**每请求线性**的，失忆的代价是**阶跃**的——一次用户重述就是一个新 run
 * （全量上下文重建 + 重新探索），抵掉几十次折叠。所以「压缩率从 3.0% 降到 1.4%」不构成优化证据，
 * 它甚至可能是恶化信号。本脚本把评价口径换成三个可复算的数，并把压缩率降级成**附注**。
 *
 * 四个指标（①②③ 参与判定，④ 明确不做）：
 *   ① 每任务总输入 token：该 run 内**所有请求**的 input tokens **累加**（不是峰值、不是压缩率）。
 *      逐轮取 `usage.input_tokens`（issue #438 的轮内全部主循环响应累计），老账本没有这个键时
 *      回落到 `response.usage.input_tokens`（该轮最后一次响应）；轮上带 `engineUsage.input_tokens`
 *      （引擎自发的折叠摘要 / judge / 归一化）时一并累加。
 *   ② 重复读取率：**同一 run 内**同一 `path` 被 `readFile` ≥2 次的比例。
 *      分子 = 重复读的 path 数（出现 ≥2 次的 path 个数），分母 = 被读过的 path 数（去重后的 path 个数）。
 *   ③ 重复执行率：**同一 run 内**同一 `command` 串被 `exec` ≥2 次的比例，分子分母同 ②。
 *   ④ 用户重述次数：**host-side / not-applicable**——跨 run 的语义，一条用户消息 = 一个 run，
 *      引擎侧没有数据源。本脚本**不用任何代理指标冒充它**（不拿 run 数、不拿追问条数、不拿终止原因）。
 *
 * 判定（只允许看 ①②③ 的绝对值/比例变化，见 `decide()`）：
 *   · `worsened`：① 上升 ≥ +5%，或 ②/③ 上升 ≥ +5pp；
 *   · `improved`：① 下降 ≥ 5%，且 ②/③ 都没有上升 ≥ +5pp；
 *   · 其余 `no-significant-change`（含「②下降但①不变」——那不是优化证据）。
 *   `compactionStats`（节省 token / 节省率 / `compacted` 真假 / 层触发次数）**只打印成附注**，
 *   标注「不参与判定」，`decide()` 的入参里根本没有这些字段（`test/compaction-benefit-592.test.js`
 *   用源码守卫 + 变异判定器双向钉住这一条）。
 *
 * 口径（任务 = run，一个 transcript 文件 = 一个 run）：同一侧可以传多个 run（session 口径），
 * 此时先逐 run 算 ①②③，再把分子/分母各自累加——**重复率永远只在单个 run 内成立**。
 *
 * 用法（零依赖，只用 node: 内置）：
 *   node scripts/compaction-benefit-analyzer.mjs <baseline.jsonl> [<candidate.jsonl>]
 *   node scripts/compaction-benefit-analyzer.mjs --baseline a.jsonl --baseline b.jsonl --candidate c.jsonl
 *   node scripts/compaction-benefit-analyzer.mjs <one.jsonl>          # 单侧：只打印三个数，不做判定
 *   node scripts/compaction-benefit-analyzer.mjs --json ...           # 机器可读（同一批事实）
 *
 * 退出码：0 = 跑完（**结论是什么都不影响退出码**——这是观察面，不是门禁）；
 *         2 = 用法/读文件错误（没跑起来，不是「结论不好」）。
 * 只读：脚本不写任何文件，不碰 `~/.erix`（要跑存量数据就把路径传进来）。
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 任务口径（写死，输出里逐字打印）。 */
export const TASK_SCOPE = "run";
/** ① 的显著变化阈值：总输入变化比例 ≥ +5% 算上升，≤ −5% 算下降。 */
export const SIGNIFICANT_INPUT_RATIO = 0.05;
/** ②/③ 的显著变化阈值：百分点（pp）差 ≥ 5pp 算上升。 */
export const SIGNIFICANT_REPEAT_PP = 5;
/** ② 认的工具名与入参键（写死，别留解释空间）。 */
export const READ_TOOL = "readFile";
export const READ_KEY = "path";
/** ③ 认的工具名与入参键。 */
export const EXEC_TOOL = "exec";
export const EXEC_KEY = "command";

export const VERDICT_IMPROVED = "improved";
export const VERDICT_WORSENED = "worsened";
export const VERDICT_UNCHANGED = "no-significant-change";
export const VERDICT_SINGLE_SIDE = "not-applicable";

const finiteNumber = (value) => (Number.isFinite(value) ? value : null);

/** 把一份 `.jsonl` 账本切成记录数组；坏行不抛错，只计数（观察面不该因为一行脏数据整份报废）。 */
export function parseTranscript(text) {
  const records = [];
  let unparsableLines = 0;
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      unparsableLines += 1;
      continue;
    }
    if (record !== null && typeof record === "object" && !Array.isArray(record)) records.push(record);
    else unparsableLines += 1;
  }
  return { records, unparsableLines };
}

/** run id：从 `roundKey` / `dedupKey` 的 `<runId>:round:<n>` 形状里取；取不到就用文件名。 */
export function runIdOf(records, fallbackPath = "") {
  for (const record of records) {
    const key = typeof record?.roundKey === "string"
      ? record.roundKey
      : (typeof record?.dedupKey === "string" ? record.dedupKey : "");
    const at = key.indexOf(":round:");
    if (at > 0) return key.slice(0, at);
  }
  return basename(String(fallbackPath)).replace(/\.jsonl$/u, "");
}

/**
 * 账本里所有 `tool_use` 调用（老账本挂在轮行的 `messages` 上，0.23.0+ 挂在 `kind:"message"` 行上）。
 * 按 `tool_use.id` 去重：resume 预落盘行会带同一批块的副本，同一 id 只算一次调用
 * （没有 id 的块（手写/宿主行）按出现次数算，不做猜测）。
 */
export function collectToolUses(records) {
  const seenIds = new Set();
  const uses = [];
  for (const record of records) {
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    for (const message of messages) {
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (block === null || typeof block !== "object" || block.type !== "tool_use") continue;
        const id = typeof block.id === "string" && block.id !== "" ? block.id : null;
        if (id !== null) {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
        }
        uses.push({
          id,
          name: typeof block.name === "string" ? block.name : "",
          input: block.input !== null && typeof block.input === "object" ? block.input : {},
        });
      }
    }
  }
  return uses;
}

/**
 * ① 每任务总输入 token：**累加**，不是峰值。
 * 逐轮取 `usage.input_tokens`（#438 轮内全部主循环响应），缺失时回落 `response.usage.input_tokens`；
 * `engineUsage.input_tokens`（引擎自发的折叠摘要 / judge / 归一化）有就一并累加。
 */
export function sumInputTokens(records) {
  const perRound = [];
  let modelInput = 0;
  let engineInput = 0;
  let usageRounds = 0;
  for (const record of records) {
    const roundUsage = finiteNumber(record?.usage?.input_tokens);
    const lastResponse = finiteNumber(record?.response?.usage?.input_tokens);
    const model = roundUsage ?? lastResponse;
    const engine = finiteNumber(record?.engineUsage?.input_tokens) ?? 0;
    if (model === null && engine === 0) continue;
    usageRounds += 1;
    modelInput += model ?? 0;
    engineInput += engine;
    perRound.push({
      round: Number.isSafeInteger(record?.round) ? record.round : null,
      model: model ?? 0,
      engine,
      source: roundUsage !== null ? "usage" : (lastResponse !== null ? "response.usage" : "engineUsage"),
    });
  }
  return {
    totalInputTokens: modelInput + engineInput,
    modelInputTokens: modelInput,
    engineInputTokens: engineInput,
    usageRounds,
    perRound,
  };
}

/**
 * ②/③ 的重复率：同一 run 内同一键被同一工具调用 ≥2 次的比例。
 * 分子 = 重复的键数（出现 ≥2 次），分母 = 被用过的键数（去重）；rate = 分子/分母。
 * 缺参调用（`path` / `command` 不是非空字符串）不进分母，单独计数 `missingKeyCalls`。
 */
export function repeatRate(uses, toolName, keyName) {
  const counts = new Map();
  let missingKeyCalls = 0;
  let calls = 0;
  for (const use of uses) {
    if (use.name !== toolName) continue;
    calls += 1;
    const key = use.input?.[keyName];
    if (typeof key !== "string" || key === "") {
      missingKeyCalls += 1;
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const denominator = counts.size;
  let numerator = 0;
  for (const count of counts.values()) if (count >= 2) numerator += 1;
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    calls,
    missingKeyCalls,
    repeatedKeys: [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([key, count]) => ({ key, count })),
  };
}

/**
 * **附注专用**：压缩侧事实（节省量 / 节省率 / `compacted` 真假 / 层触发次数）。
 * 只用于打印，`decide()` 拿不到这些字段——压缩率不参与判定。
 */
export function compactionFacts(records) {
  let entries = 0;
  let compactedTrue = 0;
  let tokensBefore = 0;
  let tokensAfter = 0;
  let triggeredLayers = 0;
  for (const record of records) {
    const stats = Array.isArray(record?.compactionStats) ? record.compactionStats : [];
    for (const stat of stats) {
      if (stat === null || typeof stat !== "object") continue;
      entries += 1;
      if (stat.compacted === true) compactedTrue += 1;
      tokensBefore += finiteNumber(stat.tokensBefore) ?? 0;
      tokensAfter += finiteNumber(stat.tokensAfter) ?? 0;
      const layers = stat.layers !== null && typeof stat.layers === "object" ? stat.layers : {};
      for (const layer of Object.values(layers)) {
        if (finiteNumber(layer?.triggered) > 0) triggeredLayers += 1;
      }
    }
  }
  const savedTokens = tokensBefore - tokensAfter;
  return {
    entries,
    compactedTrue,
    triggeredLayers,
    tokensBefore,
    tokensAfter,
    savedTokens,
    savingsRatio: tokensBefore > 0 ? savedTokens / tokensBefore : null,
  };
}

/** 单份账本 → ①②③ + 附注。 */
export function analyzeTranscript(text, { path = "", label = "" } = {}) {
  const { records, unparsableLines } = parseTranscript(text);
  const uses = collectToolUses(records);
  const input = sumInputTokens(records);
  return {
    label,
    path,
    runId: runIdOf(records, path),
    records: records.length,
    unparsableLines,
    ...input,
    read: repeatRate(uses, READ_TOOL, READ_KEY),
    exec: repeatRate(uses, EXEC_TOOL, EXEC_KEY),
    compaction: compactionFacts(records),
  };
}

/** 单侧（可含多个 run：session 口径）→ 累加后的 ①②③。重复率按 run 先算、再累加分子/分母。 */
export function aggregateSide(runs, label) {
  const read = { numerator: 0, denominator: 0, calls: 0, missingKeyCalls: 0, repeatedKeys: [] };
  const exec = { numerator: 0, denominator: 0, calls: 0, missingKeyCalls: 0, repeatedKeys: [] };
  const compaction = {
    entries: 0, compactedTrue: 0, triggeredLayers: 0,
    tokensBefore: 0, tokensAfter: 0, savedTokens: 0, savingsRatio: null,
  };
  let totalInputTokens = 0;
  let modelInputTokens = 0;
  let engineInputTokens = 0;
  let usageRounds = 0;
  for (const run of runs) {
    totalInputTokens += run.totalInputTokens;
    modelInputTokens += run.modelInputTokens;
    engineInputTokens += run.engineInputTokens;
    usageRounds += run.usageRounds;
    read.numerator += run.read.numerator;
    read.denominator += run.read.denominator;
    read.calls += run.read.calls;
    read.missingKeyCalls += run.read.missingKeyCalls;
    read.repeatedKeys.push(...run.read.repeatedKeys);
    exec.numerator += run.exec.numerator;
    exec.denominator += run.exec.denominator;
    exec.calls += run.exec.calls;
    exec.missingKeyCalls += run.exec.missingKeyCalls;
    exec.repeatedKeys.push(...run.exec.repeatedKeys);
    compaction.entries += run.compaction.entries;
    compaction.compactedTrue += run.compaction.compactedTrue;
    compaction.triggeredLayers += run.compaction.triggeredLayers;
    compaction.tokensBefore += run.compaction.tokensBefore;
    compaction.tokensAfter += run.compaction.tokensAfter;
  }
  read.rate = read.denominator === 0 ? null : read.numerator / read.denominator;
  exec.rate = exec.denominator === 0 ? null : exec.numerator / exec.denominator;
  compaction.savedTokens = compaction.tokensBefore - compaction.tokensAfter;
  compaction.savingsRatio = compaction.tokensBefore > 0
    ? compaction.savedTokens / compaction.tokensBefore
    : null;
  return {
    label,
    runCount: runs.length,
    runIds: runs.map((run) => run.runId),
    totalInputTokens,
    modelInputTokens,
    engineInputTokens,
    usageRounds,
    read,
    exec,
    compaction,
  };
}

const ratioChange = (base, candidate) => {
  if (!Number.isFinite(base) || !Number.isFinite(candidate)) return null;
  if (base === 0) return candidate === 0 ? 0 : Infinity;
  return candidate / base - 1;
};

const ppChange = (base, candidate) => (
  Number.isFinite(base) && Number.isFinite(candidate) ? (candidate - base) * 100 : null
);

/**
 * **判定**：只读 ①②③ 三个量（签名就是这三个），压缩率在这里没有入口。
 *
 * @param {{totalInputTokens:number, read:{rate:number|null}, exec:{rate:number|null}}} baseline
 * @param {{totalInputTokens:number, read:{rate:number|null}, exec:{rate:number|null}}} candidate
 */
export function decide(baseline, candidate) {
  const inputRatio = ratioChange(baseline.totalInputTokens, candidate.totalInputTokens);
  const readPp = ppChange(baseline.read.rate, candidate.read.rate);
  const execPp = ppChange(baseline.exec.rate, candidate.exec.rate);

  const degraded = [];
  const improvedFacts = [];
  const notes = [];

  if (inputRatio !== null && inputRatio >= SIGNIFICANT_INPUT_RATIO) {
    degraded.push(`① 每任务总输入上升 ${(inputRatio * 100).toFixed(1)}%（阈值 +${(SIGNIFICANT_INPUT_RATIO * 100).toFixed(0)}%）`);
  } else if (inputRatio !== null && inputRatio <= -SIGNIFICANT_INPUT_RATIO) {
    improvedFacts.push(`① 每任务总输入下降 ${(Math.abs(inputRatio) * 100).toFixed(1)}%（阈值 −${(SIGNIFICANT_INPUT_RATIO * 100).toFixed(0)}%）`);
  } else if (inputRatio !== null) {
    notes.push(`① 每任务总输入变化 ${(inputRatio * 100).toFixed(1)}%，在 ±${(SIGNIFICANT_INPUT_RATIO * 100).toFixed(0)}% 以内`);
  } else {
    notes.push("① 基线总输入为 0 或不可读 ⇒ 这一维不判定");
  }

  for (const [name, value] of [
    ["② 重复读取率", readPp],
    ["③ 重复执行率", execPp],
  ]) {
    if (value === null) {
      notes.push(`${name} 有一侧没有样本（分母 0）⇒ 这一维不判定`);
    } else if (value >= SIGNIFICANT_REPEAT_PP) {
      degraded.push(`${name}上升 ${value.toFixed(1)}pp（阈值 +${SIGNIFICANT_REPEAT_PP}pp）`);
    } else if (value <= -SIGNIFICANT_REPEAT_PP) {
      improvedFacts.push(`${name}下降 ${Math.abs(value).toFixed(1)}pp`);
    } else {
      notes.push(`${name}变化 ${value.toFixed(1)}pp，在 ±${SIGNIFICANT_REPEAT_PP}pp 以内`);
    }
  }

  let verdict;
  const reasons = [];
  if (degraded.length > 0) {
    verdict = VERDICT_WORSENED;
    reasons.push(...degraded.map((line) => `恶化：${line}`));
    if (improvedFacts.length > 0) {
      reasons.push(`局部改善不改变结论：${improvedFacts.join("；")}（有任一维度显著恶化 ⇒ 宁可说没改善）`);
    }
  } else if (improvedFacts.length > 0 && inputRatio !== null
    && inputRatio <= -SIGNIFICANT_INPUT_RATIO) {
    verdict = VERDICT_IMPROVED;
    reasons.push(...improvedFacts.map((line) => `改善：${line}`));
  } else {
    verdict = VERDICT_UNCHANGED;
    reasons.push("三项都没有达到显著恶化的阈值，且 ① 没有达到显著下降的阈值 ⇒ 不构成优化证据");
    if (improvedFacts.length > 0) {
      reasons.push(`局部改善不算结论：${improvedFacts.join("；")}（① 未显著下降 ⇒ 不是 improved）`);
    }
  }
  reasons.push(...notes);

  return {
    verdict,
    inputRatio,
    readPp,
    execPp,
    degraded,
    improvedFacts,
    notes,
    reasons,
  };
}

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

function formatRate(rate) {
  if (rate.denominator === 0) return "n/a（0/0）";
  return `${rate.numerator}/${rate.denominator} = ${pct(rate.rate)}`;
}

function formatBreakdown(perRound) {
  if (perRound.length === 0) return "（没有任何带 usage 的轮次）";
  const shown = perRound.slice(0, 12).map((entry) => String(entry.model + entry.engine));
  const suffix = perRound.length > 12 ? ` …（共 ${perRound.length} 轮）` : "";
  return `累加 ${shown.join(" + ")}${suffix}`;
}

function formatSide(side, runs) {
  const lines = [];
  lines.push(`【${side.label}】${side.runCount} 个 run`);
  for (const run of runs) {
    lines.push(`  run=${run.runId}  文件=${run.path || "(内存)"}  记录=${run.records} 行`
      + `${run.unparsableLines > 0 ? `（坏行 ${run.unparsableLines} 行已跳过）` : ""}`);
    lines.push(`    ① 每任务总输入 = ${run.totalInputTokens} token（${formatBreakdown(run.perRound)}；`
      + `主循环 ${run.modelInputTokens} + 引擎自发 ${run.engineInputTokens}；${run.usageRounds} 个带 usage 的轮次）`);
    lines.push(`    ② 重复读取率 = ${formatRate(run.read)}（${READ_TOOL} 调用 ${run.read.calls} 次；`
      + `分母 = 去重 path ${run.read.denominator} 个；分子 = 重复 path ${run.read.numerator} 个）`);
    lines.push(`    ③ 重复执行率 = ${formatRate(run.exec)}（${EXEC_TOOL} 调用 ${run.exec.calls} 次；`
      + `分母 = 去重 command ${run.exec.denominator} 个；分子 = 重复 command ${run.exec.numerator} 个）`);
  }
  if (side.runCount > 1) {
    lines.push(`  合计（session 口径：先逐 run 算再累加分子/分母）`);
    lines.push(`    ① 每任务总输入 = ${side.totalInputTokens} token`);
    lines.push(`    ② 重复读取率 = ${formatRate(side.read)}`);
    lines.push(`    ③ 重复执行率 = ${formatRate(side.exec)}`);
  }
  return lines;
}

/** 附注：压缩侧事实。**不参与判定**（`decide()` 的入参里没有这些字段）。 */
function formatAnnotation(side) {
  const facts = side.compaction;
  const ratio = facts.savingsRatio === null ? "n/a" : pct(facts.savingsRatio);
  return `压缩节省 = ${facts.savedTokens} token（节省率 ${ratio}；tokensBefore ${facts.tokensBefore} → `
    + `tokensAfter ${facts.tokensAfter}；compactionStats 条目 ${facts.entries} 条，其中 compacted:true `
    + `${facts.compactedTrue} 条；层触发 ${facts.triggeredLayers} 次）`;
}

export const DEFINITIONS = [
  `口径：任务 = 单个 run（一个 transcript 文件 = 一个 run）。同一侧可传多个 run（session 口径）时，`
  + `先逐 run 算 ①②③，再累加分子/分母。`,
  "① 每任务总输入 token = 该 run 内**所有请求**的 input tokens **累加**（不是峰值、不是压缩率）。",
  `   逐轮取 usage.input_tokens（#438 轮内全部主循环响应），缺失时回落 response.usage.input_tokens；`
  + `轮上带 engineUsage.input_tokens（引擎自发的折叠摘要 / judge / 归一化）时一并累加。`,
  `② 重复读取率 = **同一 run 内**同一 \`${READ_KEY}\` 被 \`${READ_TOOL}\` ≥2 次的比例：`
  + `分子 = 重复读的 path 数（出现 ≥2 次的 path 个数），分母 = 被读过的 path 数（去重后的 path 个数）。`
  + `path 原样比较，不做路径归一化。`,
  `③ 重复执行率 = **同一 run 内**同一 \`${EXEC_KEY}\` 串被 \`${EXEC_TOOL}\` ≥2 次的比例：分子/分母同 ②。`,
  `④ 用户重述次数 = host-side / not-applicable（跨 run 语义：一条用户消息 = 一个 run；引擎侧没有数据源，`
  + `本分析器不用代理指标冒充）。`,
];

export const VERDICT_RULES = [
  `· worsened：① 上升 ≥ +${(SIGNIFICANT_INPUT_RATIO * 100).toFixed(0)}%，或 ②/③ 上升 ≥ +${SIGNIFICANT_REPEAT_PP}pp；`,
  `· improved：① 下降 ≥ ${(SIGNIFICANT_INPUT_RATIO * 100).toFixed(0)}%，且 ②/③ 都没有上升 ≥ +${SIGNIFICANT_REPEAT_PP}pp；`,
  "· no-significant-change：其余（含「②/③ 下降但 ① 不变」——那不是优化证据）；",
  "· 压缩率（compactionStats 的节省量 / compacted 真假 / 层触发次数）不参与判定，只作附注打印。",
];

/** 文本报告（打印给人看；定义与判定规则逐字打印）。 */
export function formatReport(baseline, candidate, decision) {
  const lines = [];
  lines.push("=== 压缩收益口径分析（issue #592：每任务总输入 + 重复劳动率）===");
  lines.push("");
  lines.push("【定义（写死，逐字）】");
  for (const line of DEFINITIONS) lines.push(line);
  lines.push("");
  lines.push("【判定规则（写死，逐字）】");
  for (const line of VERDICT_RULES) lines.push(line);
  lines.push("");
  lines.push(...formatSide(baseline, baseline.runs));
  lines.push("");
  if (candidate === null) {
    lines.push("【结论】not-applicable（只给了一份账本，没有基线可比；本分析器不做单侧判定）");
  } else {
    lines.push(...formatSide(candidate, candidate.runs));
    lines.push("");
    lines.push("【变化（只有 ①②③ 进判定）】");
    lines.push(`  ① 每任务总输入：${baseline.totalInputTokens} → ${candidate.totalInputTokens} token`
      + `（${decision.inputRatio === null ? "n/a" : `${decision.inputRatio >= 0 ? "+" : ""}${(decision.inputRatio * 100).toFixed(1)}%`}）`);
    lines.push(`  ② 重复读取率：${pct(baseline.read.rate)} → ${pct(candidate.read.rate)}`
      + `（${decision.readPp === null ? "n/a" : `${decision.readPp >= 0 ? "+" : ""}${decision.readPp.toFixed(1)}pp`}）`);
    lines.push(`  ③ 重复执行率：${pct(baseline.exec.rate)} → ${pct(candidate.exec.rate)}`
      + `（${decision.execPp === null ? "n/a" : `${decision.execPp >= 0 ? "+" : ""}${decision.execPp.toFixed(1)}pp`}）`);
    lines.push("");
    lines.push(`【结论】${decision.verdict}`);
    for (const reason of decision.reasons) lines.push(`  · ${reason}`);
  }
  lines.push("");
  lines.push("【附注（不参与判定）】压缩侧事实只打印，不进入结论：");
  lines.push(`  基线：${formatAnnotation(baseline)}`);
  if (candidate !== null) lines.push(`  候选：${formatAnnotation(candidate)}`);
  lines.push("  ⚠ 上面这两行是附注：压缩率下降**不构成**优化证据（一次失忆重述 = 新 run = 全量上下文重建）。");
  return lines.join("\n");
}

function readTranscriptFile(path, label) {
  const text = readFileSync(path, "utf8");
  return analyzeTranscript(text, { path, label });
}

/** 一侧（1..N 个账本文件）→ 逐 run 指标 + 累加后的 ①②③（`runs` 保留逐 run 明细供打印）。 */
export function loadSide(paths, label) {
  const runs = paths.map((path) => readTranscriptFile(path, label));
  const side = aggregateSide(runs, label);
  side.runs = runs;
  return side;
}

const HELP = [
  "用法：node scripts/compaction-benefit-analyzer.mjs <baseline.jsonl> [<candidate.jsonl>]",
  "      node scripts/compaction-benefit-analyzer.mjs --baseline a.jsonl [--baseline b.jsonl] --candidate c.jsonl",
  "      node scripts/compaction-benefit-analyzer.mjs <one.jsonl>   # 单侧：只打印三个数",
  "      node scripts/compaction-benefit-analyzer.mjs --json ...    # 机器可读",
  "退出码：0 = 跑完（结论不影响退出码）；2 = 用法/读文件错误。",
].join("\n");

function parseArgs(argv) {
  const options = { baseline: [], candidate: [], json: false, help: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--baseline" || arg === "--candidate") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} 缺少路径`);
      }
      options[arg === "--baseline" ? "baseline" : "candidate"].push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`未知选项：${arg}`);
    positionals.push(arg);
  }
  if (options.baseline.length === 0 && options.candidate.length === 0) {
    if (positionals.length === 0) throw new Error("至少给一份账本路径");
    if (positionals.length > 2) throw new Error("位置参数最多两个（基线、候选）；多 run 请用 --baseline/--candidate");
    options.baseline.push(positionals[0]);
    if (positionals.length === 2) options.candidate.push(positionals[1]);
  } else if (positionals.length > 0) {
    throw new Error("位置参数与 --baseline/--candidate 不能混用");
  }
  if (options.candidate.length > 0 && options.baseline.length === 0) {
    throw new Error("给了 --candidate 就必须给 --baseline");
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`compaction-benefit-analyzer: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  let baseline;
  let candidate = null;
  try {
    baseline = loadSide(options.baseline, "基线");
    if (options.candidate.length > 0) candidate = loadSide(options.candidate, "候选");
  } catch (error) {
    console.error(`compaction-benefit-analyzer: 读账本失败 — ${error.message}`);
    return 2;
  }
  const decision = candidate === null ? null : decide(baseline, candidate);

  if (options.json) {
    const strip = (side) => ({
      label: side.label,
      runCount: side.runCount,
      runIds: side.runIds,
      totalInputTokens: side.totalInputTokens,
      modelInputTokens: side.modelInputTokens,
      engineInputTokens: side.engineInputTokens,
      read: side.read,
      exec: side.exec,
      compactionNotJudged: side.compaction,
      runs: side.runs.map((run) => ({
        runId: run.runId,
        path: run.path,
        records: run.records,
        unparsableLines: run.unparsableLines,
        totalInputTokens: run.totalInputTokens,
        modelInputTokens: run.modelInputTokens,
        engineInputTokens: run.engineInputTokens,
        usageRounds: run.usageRounds,
        perRound: run.perRound,
        read: run.read,
        exec: run.exec,
        compactionNotJudged: run.compaction,
      })),
    });
    console.log(JSON.stringify({
      scope: TASK_SCOPE,
      definitions: DEFINITIONS,
      verdictRules: VERDICT_RULES,
      baseline: strip(baseline),
      candidate: candidate === null ? null : strip(candidate),
      decision,
      userRestatement: "host-side / not-applicable",
    }, null, 2));
    return 0;
  }

  console.log(formatReport(baseline, candidate, decision));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };
