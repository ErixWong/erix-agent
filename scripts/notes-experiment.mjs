#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  chmod,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeRunId } from "../src/store/file.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "bin", "cli.js");
const RESULTS_PATH = path.join(REPO_ROOT, "scripts", "notes-experiment-results.json");
const REPORT_PATH = path.join(REPO_ROOT, "docs", "research", "2026-09-13-notes-experiment.md");
export const MODELS = ["kimi-for-coding", "k3"];
export const ARMS = ["A", "B", "C", "D"];
export const ROUND_ROBIN_SEED = "notes-experiment-2026-09-13";
const PROMPT = `请严格按以下步骤完成任务，不要改变顺序，也不要重跑任何命令：
① 只执行一次：exec: echo "一次性密钥=$(head -c 12 /dev/urandom | base64)"
② 执行：exec: seq 1 400
③ 执行：exec: seq 401 800
④ 执行：exec: seq 801 1200
⑤ 最后回答①的一次性密钥，必须原样给出首次执行的值。
如果早期输出已折叠，先读取 note 或归档；禁止用同一命令重跑来恢复一次性值。`;

function parseArgs(args) {
  const options = {
    smokeRuns: 4,
    criticalRuns: 6,
    timeoutMs: 20 * 60 * 1000,
    reportOnly: false,
    dOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--smoke-runs" || argument === "--critical-runs" || argument === "--timeout-ms") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${argument} must be a positive integer`);
      }
      if (argument === "--smoke-runs") options.smokeRuns = value;
      if (argument === "--critical-runs") options.criticalRuns = value;
      if (argument === "--timeout-ms") options.timeoutMs = value;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log("用法：node scripts/notes-experiment.mjs [--smoke-runs 4] [--critical-runs 6] [--timeout-ms 1200000] [--d-only] [--report-only]");
      return null;
    }
    if (argument === "--report-only") {
      options.reportOnly = true;
      continue;
    }
    if (argument === "--d-only") {
      options.dOnly = true;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (options.criticalRuns < options.smokeRuns) {
    throw new Error("--critical-runs must be >= --smoke-runs");
  }
  return options;
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function defaultConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg
    ? path.join(xdg, "erix", "config.json")
    : path.join(homedir(), ".erix", "config.json");
}

async function createModelConfigs(root) {
  const source = await readJsonIfPresent(defaultConfigPath());
  let defaultSlot = source?.slots?.default && typeof source.slots.default === "object"
    ? source.slots.default
    : {};
  if (!defaultSlot.endpoint && !defaultSlot.apiKey && !defaultSlot.apiKeyEnv && !defaultSlot.apiKeyFile) {
    const piModels = await readJsonIfPresent(path.join(homedir(), ".pi", "agent", "models.json"));
    const providers = piModels?.providers && typeof piModels.providers === "object"
      ? Object.values(piModels.providers)
      : [];
    const provider = providers.find((candidate) => (
      candidate && typeof candidate === "object" && Array.isArray(candidate.models)
    ));
    const model = provider?.models?.find((candidate) => (
      candidate && typeof candidate === "object"
      && (candidate.id === "kimi-for-coding" || candidate.id === "k3")
    )) ?? provider?.models?.[0];
    if (provider && model) {
      defaultSlot = {
        endpoint: provider.baseUrl ?? provider.endpoint,
        apiKey: provider.apiKey,
        contextWindowTokens: model.contextWindow,
        maxOutputTokens: model.maxTokens,
      };
    }
  }
  const configPaths = new Map();
  for (const model of MODELS) {
    const namedSlot = source?.slots?.[model];
    const slot = {
      ...defaultSlot,
      ...(namedSlot && typeof namedSlot === "object" ? namedSlot : {}),
      model,
    };
    const configPath = path.join(root, `${model}.config.json`);
    await writeFile(configPath, `${JSON.stringify({ slots: { default: slot } })}\n`, "utf8");
    await chmod(configPath, 0o600);
    configPaths.set(model, configPath);
  }
  return configPaths;
}

function runCli(args, environment, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, error: error.message, timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function blockText(block) {
  if (block?.type === "text" || block?.type === "tool_result") {
    return String(block.text ?? block.content ?? "");
  }
  return "";
}

export function extractValues(text) {
  const values = [];
  const pattern = /(?:一次性密钥|密钥)\s*(?:原样|首次)?\s*(?:是|为|=|:|：)\s*([A-Za-z0-9+/=_-]+)/gu;
  for (const match of String(text ?? "").matchAll(pattern)) {
    if (!values.includes(match[1])) values.push(match[1]);
  }
  return values;
}

function archivePathIn(value) {
  return /(?:^|[/\\])outputs(?:[/\\])/u.test(String(value ?? ""));
}

function toolInput(block) {
  return block?.input && typeof block.input === "object" ? block.input : {};
}

async function readTranscript(transcriptDir, runId) {
  const file = path.join(transcriptDir, `${safeRunId(runId)}.jsonl`);
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

async function readArchiveValues(outputsDir) {
  let entries;
  try {
    entries = await readdir(outputsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const values = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".txt"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const output = await readFile(path.join(outputsDir, entry.name), "utf8");
    for (const value of extractValues(output)) {
      if (!values.includes(value)) values.push(value);
    }
  }
  return values;
}

async function readNoteValues(notesDir, runId) {
  const directory = path.join(notesDir, "run", safeRunId(runId));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const values = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const record = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
    for (const version of record.versions ?? []) {
      if (typeof version.content === "string") {
        for (const value of extractValues(version.content)) {
          if (!values.includes(value)) values.push(value);
        }
      }
      const reference = version.artifactRef;
      if (!reference?.archivePath || !Number.isSafeInteger(reference.locator?.lineStart)) continue;
      try {
        const archived = await readFile(reference.archivePath, "utf8");
        for (const value of extractValues(archived)) {
          if (!values.includes(value)) values.push(value);
        }
      } catch {
        // An absent artifact is recorded as an unverified note, not as a value.
      }
    }
  }
  return values;
}

export function parseFinal(stdout) {
  const output = String(stdout);
  const headings = [...output.matchAll(
    /^=== 终稿(?:（([^）]*)）|\(([^)]*)\))? ===$/gmu,
  )];
  const heading = headings.at(-1);
  const start = heading?.index ?? -1;
  const contentStart = start < 0 ? -1 : start + heading[0].length;
  const end = output.indexOf("\n=== 统计 ===", contentStart);
  const finalText = contentStart < 0
    ? ""
    : output.slice(contentStart, end < 0 ? undefined : end).trim();
  const stats = end < 0 ? "" : output.slice(end);
  const title = heading?.[1] ?? heading?.[2] ?? "";
  const titleRequiresRevision = /未核验|核验错误/u.test(title);
  const termination = titleRequiresRevision
    ? "final_guard_unverified"
    : stats.match(/\btermination=([a-z_]+)/u)?.[1]
      ?? (output.includes("final_guard_unverified") ? "final_guard_unverified" : "unknown");
  return {
    finalText,
    termination,
    guarded: heading !== undefined && (heading[1] !== undefined || heading[2] !== undefined),
  };
}

export function redactedPreview(value) {
  return { prefix: value.slice(0, 4), length: value.length };
}

export function redactText(text, values) {
  let result = String(text ?? "");
  for (const value of new Set(values)) {
    if (!value) continue;
    result = result.replaceAll(value, `${value.slice(0, 4)}…（长度${value.length}）`);
  }
  return result;
}

export function classify(finalText, generatedValues = [], noteValues = []) {
  const generated = [...new Set(generatedValues)];
  const notes = [...new Set(noteValues)];
  const known = [...new Set([...generated, ...notes])];
  const labelMatch = String(finalText).match(
    /(?:一次性密钥|密钥)\s*(?:原样|首次)?\s*(?:是|为|=|:|：)\s*([A-Za-z0-9+/=_-]+)/u,
  );
  const answer = labelMatch?.[1]
    ?? known.find((value) => String(finalText).includes(value))
    ?? null;
  if (!answer) return { category: "no_answer", answer: null };
  // Tool/archive order is authoritative. Notes are a fallback when compaction
  // removed the tool result from the transcript.
  const first = generated[0] ?? notes[0];
  if (answer === first) return { category: "hit_first", answer };
  if (generated.slice(1).includes(answer)) {
    return { category: "rerun_impersonation", answer };
  }
  if (notes.slice(1).includes(answer)) {
    return { category: "rerun_impersonation", answer };
  }
  if (notes.includes(answer)) return { category: "hit_first", answer };
  return { category: "invented", answer };
}

export async function inspectRun({
  runId,
  transcriptDir,
  notesDir,
  stdout,
  stderr,
  arm,
  model,
  durationMs,
  exitCode,
  timedOut,
}) {
  const records = await readTranscript(transcriptDir, runId);
  const outputsDir = path.join(transcriptDir, "outputs", safeRunId(runId));
  const archiveValues = await readArchiveValues(outputsDir);
  const noteValues = await readNoteValues(notesDir, runId);
  const transcriptValues = [];
  for (const record of records) {
    for (const message of record.messages ?? []) {
      for (const block of blocksFor(message.content)) {
        if (block?.type !== "tool_result") continue;
        for (const value of extractValues(blockText(block))) {
          if (!transcriptValues.includes(value)) transcriptValues.push(value);
        }
      }
    }
  }
  // Transcript order is the execution order when it is available. If
  // compaction removed tool results, archive sequence order is the fallback.
  const generatedValues = transcriptValues.length
    ? [...transcriptValues, ...archiveValues.filter((value) => !transcriptValues.includes(value))]
    : archiveValues;

  const toolCalls = [];
  let noteRead = false;
  let archiveRead = false;
  for (const record of records) {
    for (const message of record.messages ?? []) {
      for (const block of blocksFor(message.content)) {
        if (block?.type !== "tool_use") continue;
        const input = toolInput(block);
        const callArchiveRead = block.name === "readFile"
          ? archivePathIn(input.path)
          : block.name === "exec" && archivePathIn(input.command);
        toolCalls.push({
          name: block.name,
          round: record.round,
          archiveRead: callArchiveRead,
        });
        noteRead ||= block.name === "note_read" || block.name === "note_list";
        archiveRead ||= callArchiveRead;
      }
    }
  }
  const final = parseFinal(stdout);
  const classification = classify(final.finalText, generatedValues, noteValues);
  const compaction = records.some((record) => record.folded === true);
  const failClosed = final.termination === "final_guard_unverified"
    || /=== 终稿（未核验，不可信） ===/u.test(stdout);
  const allValues = [...new Set([...generatedValues, ...noteValues])];
  const finalValues = extractValues(final.finalText);
  const redactionValues = [...new Set([...allValues, ...finalValues])];
  const failed = exitCode !== 0 || timedOut || failClosed;
  return {
    id: `${arm}-${model}-${runId}`,
    arm,
    model,
    runId,
    exitCode,
    durationMs,
    timedOut,
    failed,
    termination: final.termination,
    guarded: final.guarded,
    compacted: compaction,
    noteRead,
    archiveRead,
    failClosed,
    toolCalls,
    generatedValues: generatedValues.map(redactedPreview),
    noteValues: noteValues.map(redactedPreview),
    finalText: redactText(final.finalText, redactionValues),
    category: classification.category,
    answer: classification.answer ? redactedPreview(classification.answer) : null,
    stderr: redactText(stderr.slice(-2000), redactionValues),
  };
}

function wilson95(successes, total) {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.959964;
  const p = successes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = (p + (z ** 2) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z ** 2) / (4 * total)) / total) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function aggregate(runs) {
  const grouped = new Map();
  for (const run of runs) {
    const key = `${run.arm}/${run.model}`;
    const failed = run.failed ?? (run.exitCode !== 0 || run.timedOut === true);
    const entry = grouped.get(key) ?? {
      arm: run.arm,
      model: run.model,
      n: 0,
      hitFirst: 0,
      rerunImpersonation: 0,
      invented: 0,
      noAnswer: 0,
      rawNoAnswer: 0,
      failed: 0,
      knownOther: 0,
      completed: 0,
      determinable: 0,
      noteRead: 0,
      archiveRead: 0,
      failClosed: 0,
      compacted: 0,
      durationMs: 0,
    };
    entry.n += 1;
    const determinable = !failed && (
      run.category === "hit_first"
      || run.category === "rerun_impersonation"
      || run.category === "invented"
      || run.category === "no_answer"
    );
    entry.completed += failed ? 0 : 1;
    entry.determinable += determinable ? 1 : 0;
    entry.hitFirst += run.category === "hit_first" ? 1 : 0;
    entry.rerunImpersonation += run.category === "rerun_impersonation" ? 1 : 0;
    entry.invented += run.category === "invented" ? 1 : 0;
    entry.noAnswer += run.category === "no_answer" && determinable ? 1 : 0;
    entry.rawNoAnswer += run.category === "no_answer" ? 1 : 0;
    entry.failed += failed ? 1 : 0;
    entry.knownOther += run.category === "known_other" ? 1 : 0;
    entry.noteRead += run.noteRead ? 1 : 0;
    entry.archiveRead += run.archiveRead ? 1 : 0;
    entry.failClosed += run.failClosed ? 1 : 0;
    entry.compacted += run.compacted ? 1 : 0;
    entry.durationMs += run.durationMs;
    grouped.set(key, entry);
  }
  return [...grouped.values()].map((entry) => {
    const evaluated = entry.determinable;
    const errorCount = runs
      .filter((run) => `${run.arm}/${run.model}` === `${entry.arm}/${entry.model}`)
      .filter((run) => {
        const failed = run.failed ?? (run.exitCode !== 0 || run.timedOut === true);
        return !failed && (
          run.category === "rerun_impersonation" || run.category === "invented"
        );
      }).length;
    return {
      ...entry,
      evaluated,
      errorSpecificCount: errorCount,
      errorSpecificRate: evaluated > 0
        ? errorCount / evaluated
        : null,
      errorSpecificWilson95: evaluated > 0
        ? wilson95(errorCount, evaluated)
        : { low: null, high: null },
      noteReadRate: entry.noteRead / entry.n,
      archiveReadRate: entry.archiveRead / entry.n,
      failClosedRate: entry.failClosed / entry.n,
      averageDurationMs: entry.durationMs / entry.n,
    };
  });
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

export function conclusionFor(aggregateRows) {
  const comparable = aggregateRows
    .filter((entry) => entry.evaluated > 0)
    .map((entry) => (
      `${entry.arm}/${entry.model}=${percent(entry.errorSpecificRate)} `
      + `(可判定 ${entry.evaluated}，命中首次 ${entry.hitFirst}，无答案 ${entry.noAnswer})`
    ));
  if (comparable.length === 0) return "没有完成的 run，无法比较各臂。";
  const failures = aggregateRows
    .filter((entry) => entry.failed > 0)
    .map((entry) => `${entry.arm}/${entry.model} ${entry.failed}/${entry.n}`)
    .join("、");
  const failureNote = failures
    ? `本次还存在运行失败（${failures}）；relay 拒绝、模型排除或超时不应解读为模型行为结果。`
    : "";
  return `${failureNote} 各格并列呈现：${comparable.join("；")}。样本量不足以排序臂或模型，Wilson 区间较宽且可能重叠；失败/排除格也不具可比性，应继续做 100+ 次、交错运行、分模型报告后再评估。`;
}

export function roundRobinOrder({
  arms = ARMS,
  models = MODELS,
  smokeRuns = 4,
  criticalRuns = 6,
  seed = ROUND_ROBIN_SEED,
} = {}) {
  // The seed is recorded as part of the protocol; the explicit order makes
  // reruns reproducible without relying on process-randomized shuffling.
  void seed;
  const jobs = [];
  const maxRuns = Math.max(smokeRuns, criticalRuns);
  for (let index = 1; index <= maxRuns; index += 1) {
    for (const arm of arms) {
      for (const model of models) {
        const targetRuns = arm === "A" || arm === "D" ? criticalRuns : smokeRuns;
        if (index <= targetRuns) jobs.push({ arm, model, index });
      }
    }
  }
  return jobs;
}

export function reportMarkdown(result) {
  const rows = result.aggregate.map((entry) => {
    const interval = entry.errorSpecificWilson95;
    return `| ${entry.arm} | ${entry.model} | ${entry.n} | ${entry.completed} | ${entry.determinable} | ${entry.failed} | ${entry.hitFirst} | ${entry.rerunImpersonation} | ${entry.invented} | ${entry.noAnswer} | ${percent(entry.noteReadRate)} | ${percent(entry.archiveReadRate)} | ${entry.failClosed} | ${percent(entry.errorSpecificRate)} [${percent(interval.low)}, ${percent(interval.high)}] |`;
  }).join("\n");
  const totalDuration = result.runs.reduce((sum, run) => sum + run.durationMs, 0);
  const repaired = result.repairedRerun;
  const repairedSection = repaired
    ? `\n## ${repaired.label ?? "修复后重跑"}\n\n${repaired.status === "completed"
      ? reportMarkdown(repaired)
      : `状态：${repaired.status}。${repaired.reason ?? ""}\n协议：${JSON.stringify(repaired.protocol)}`}\n`
    : "";
  const legacySection = result.legacy
    ? `\n## 修复前旧数据（保留；分类 bug 影响结论）\n\n旧矩阵仍完整保存在 \`scripts/notes-experiment-results.json\` 的 \`legacy\` 字段；旧分类把终稿抽取值混入 generatedValues，可能系统性低估 invented，不能与修复后分类直接比较。\n`
    : "";
  const body = `# Notes 实验矩阵（A/B/C/D）

运行日期：${result.startedAt}。这是按 #63 固定协议驱动真实 \`node bin/cli.js chat\` 的初步 smoke/关键对照结果；每格样本量较小，不能据此下最终结论。**下一步需要 100+ 次才能定论。**

## 协议

- A：\`--no-final-guard --no-notes\`（仅移除 notes，其他 skill 保留）；B：\`--no-final-guard\`；C：\`--no-final-guard --notes-ledger\`；D：默认 provenance gate。
- 每 run 使用独立 transcript、\`ERIX_NOTES_DIR\` 和 session；提示固定执行一次随机密钥命令、三段 \`seq\`，最后原样回答第一次密钥。
- “错误具体值” = 重跑冒充 + 编造。fail-closed（未核验标题或 \`final_guard_unverified\`）按运行失败/排除处理，不进入行为错误率分母；区间分母是**完成且可判定 run**。其他运行失败、模型排除和不可判定记录同样保留在原始计数中，但不计作无答案，也不进入该 CI 分母。“note 读取率”按发生 \`note_list\`/\`note_read\` 的 run 计，“归档读取率”按读取 outputs 目录的 run 计。
- 随机密钥仅在结果 JSON 中保留“前 4 位 + 长度”脱敏摘要，本文不写入明文。

## 矩阵结果

| 臂 | 模型 | n | 完成 | 可判定 | 运行失败 | 命中首次 | 重跑冒充 | 编造 | 无答案 | note 读取率 | 归档读取率 | fail-closed | 错误具体值比例（Wilson 95%） |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

## 初步结论

${result.conclusion}

本次总耗时约 ${(totalDuration / 1000).toFixed(1)} 秒（脚本 wall clock 以运行日志为准）。

## 方法与混杂因素

- 采用固定种子 \`${ROUND_ROBIN_SEED}\` 的轮转顺序，避免先跑完某一模型/臂造成时间与服务状态混杂；样本量仍不足以估计稳定效应。
- \`kimi-for-coding\` 与 \`k3\` 是修复后重跑的目标模型；旧数据中的 deepseek relay 拒绝保留作历史记录并排除出修复后比较，不应解释为模型行为。
- 臂之间同时改变 notes、final guard 和 skills 配置；模型服务负载、上下文压缩、提示协议、工作目录及运行时序都可能混杂。该实验是验证性 smoke/关键对照，不是随机化因果试验。
- 原始计数和失败计数保留；仅完成且可判定记录用于错误比例和 Wilson 区间。敏感值只写入前缀和长度。
${repairedSection}`;
  return `${body}${legacySection}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  if (options.reportOnly) {
    const result = JSON.parse(await readFile(RESULTS_PATH, "utf8"));
    const legacy = result.legacy ?? {
      protocol: result.protocol,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      runs: result.runs,
      aggregate: result.aggregate,
      conclusion: result.conclusion,
    };
    const repairedRerun = {
      status: "not_run",
      reason: "report-only 不会把旧记录冒充修复后重跑；请用默认模式执行固定轮转协议。",
      protocol: {
        seed: ROUND_ROBIN_SEED,
        models: MODELS,
        order: "round-robin",
        armA: "--no-notes",
      },
      runs: [],
      excludedModels: ["deepseek-v4-flash"],
      excludedRuns: (result.runs ?? [])
        .filter((run) => !MODELS.includes(run.model))
        .map((run) => ({ id: run.id, model: run.model, excluded: true })),
      aggregate: [],
    };
    result.legacy = legacy;
    result.repairedRerun = repairedRerun;
    result.aggregate = aggregate(result.runs ?? []);
    result.conclusion = conclusionFor(result.aggregate);
    await writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${reportMarkdown(result)}\n`, "utf8");
    console.log(result.conclusion);
    return;
  }
  const startedAt = new Date().toISOString();
  const previous = await readJsonIfPresent(RESULTS_PATH);
  const legacy = previous?.legacy ?? (previous ? {
    protocol: previous.protocol,
    startedAt: previous.startedAt,
    completedAt: previous.completedAt,
    runs: previous.runs,
    aggregate: previous.aggregate,
    conclusion: previous.conclusion,
  } : undefined);
  const tempRoot = await mkdtemp(path.join(REPO_ROOT, ".notes-experiment-"));
  const runs = [];
  try {
    const configPaths = await createModelConfigs(tempRoot);
    for (const { arm, model, index } of roundRobinOrder({
      arms: options.dOnly ? ["D"] : ARMS,
      smokeRuns: options.smokeRuns,
      criticalRuns: options.criticalRuns,
    })) {
          const runId = `notes-exp-${arm.toLowerCase()}-${model}-${String(index).padStart(2, "0")}`;
          const runRoot = path.join(tempRoot, runId);
          const transcriptDir = path.join(runRoot, "transcripts");
          const notesDir = path.join(runRoot, "notes");
          await mkdir(transcriptDir, { recursive: true });
          await mkdir(notesDir, { recursive: true });
          const args = [
            "chat",
            PROMPT,
            "--config",
            configPaths.get(model),
            "--session",
            runId,
            "--dir",
            transcriptDir,
            "--compact-budget",
            "3000",
            "--max-rounds",
            "12",
            "--idle-timeout",
            "300",
          ];
          if (arm === "A") args.push("--no-final-guard", "--no-notes");
          if (arm === "B") args.push("--no-final-guard");
          if (arm === "C") args.push("--no-final-guard", "--notes-ledger");
          const environment = {
            ...process.env,
            ERIX_NOTES_DIR: notesDir,
          };
          delete environment.ERIX_NOTES_LEDGER;
          delete environment.ERIX_NO_FINAL_GUARD;
          delete environment.LLM_KIT_MODEL;
          if (arm !== "D") environment.ERIX_NO_FINAL_GUARD = "1";

          const started = Date.now();
          const processResult = await runCli(args, environment, options.timeoutMs);
          const durationMs = Date.now() - started;
          const run = await inspectRun({
            runId,
            transcriptDir,
            notesDir,
            stdout: processResult.stdout,
            stderr: processResult.stderr,
            arm,
            model,
            durationMs,
            exitCode: processResult.code,
            timedOut: processResult.timedOut,
          });
          if (processResult.error) {
            run.stderr = `${run.stderr}\n${redactText(
              processResult.error,
              extractValues(processResult.error),
            )}`;
          }
          runs.push(run);
          console.log(
            `${arm}/${model} #${index}: category=${run.category} first=${run.category === "hit_first" ? 1 : 0} `
            + `note=${run.noteRead ? 1 : 0} archive=${run.archiveRead ? 1 : 0} `
            + `failClosed=${run.failClosed ? 1 : 0} termination=${run.termination} `
            + `duration=${(durationMs / 1000).toFixed(1)}s`,
          );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const protocol = {
      prompt: "fixed one-shot secret + seq 1..400/401..800/801..1200",
      compactBudget: 3000,
      maxRounds: 12,
      smokeRuns: options.smokeRuns,
      criticalRuns: options.criticalRuns,
      seed: ROUND_ROBIN_SEED,
      models: MODELS,
      order: "round-robin",
      ...(options.dOnly ? { scope: "D" } : {}),
    };
  const repairedAggregate = aggregate(runs);
  const repairedRerun = {
    status: "completed",
    ...(options.dOnly ? { label: "批次4 重跑（D 臂）" } : {}),
    protocol,
    startedAt,
    completedAt: new Date().toISOString(),
    runs,
    aggregate: repairedAggregate,
  };
  repairedRerun.conclusion = conclusionFor(repairedAggregate);
  const result = {
    ...(options.dOnly && legacy
      ? {
          protocol: previous.protocol,
          startedAt: previous.startedAt,
          runs: previous.runs,
          aggregate: previous.aggregate,
          conclusion: previous.conclusion,
        }
      : {
          protocol,
          startedAt,
          runs,
          aggregate: repairedAggregate,
          conclusion: repairedRerun.conclusion,
        }),
    completedAt: repairedRerun.completedAt,
    ...(legacy ? { legacy } : {}),
    repairedRerun,
    excludedModels: ["deepseek-v4-flash"],
    excludedRuns: (legacy?.runs ?? [])
      .filter((run) => !MODELS.includes(run.model))
      .map((run) => ({ id: run.id, model: run.model, excluded: true })),
  };
  await writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${reportMarkdown(result)}\n`, "utf8");
  console.log("\n=== 聚合 ===");
  for (const entry of options.dOnly ? repairedAggregate : result.aggregate) {
    console.log(
      `${entry.arm}/${entry.model}: n=${entry.n} hit=${entry.hitFirst} rerun=${entry.rerunImpersonation} `
      + `invented=${entry.invented} noAnswer=${entry.noAnswer} failed=${entry.failed} note=${entry.noteRead} `
      + `archive=${entry.archiveRead} failClosed=${entry.failClosed} `
      + `error=${percent(entry.errorSpecificRate)} Wilson95=[${percent(entry.errorSpecificWilson95.low)},${percent(entry.errorSpecificWilson95.high)}]`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
