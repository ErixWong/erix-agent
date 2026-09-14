#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeRunId } from "../src/store/file.js";
import {
  DEFAULT_MAX_CALLS,
  estimateHistoricalUsage,
  formatCostPreview,
  formatUsageSummary,
  plannedCallCount,
  resolveExperimentModel,
  runFailFast,
  validateCostPlan,
} from "./experiment-guardrails.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "bin", "cli.js");
const RESULTS_PATH = path.join(REPO_ROOT, "scripts", "notes-experiment-results.json");
const REPORT_PATH = path.join(
  REPO_ROOT,
  "docs",
  "research",
  "2026-09-14-notes-matrix-n30.md",
);

export const ARMS = ["A", "B", "C"];
export const ROUND_ROBIN_SEED = "notes-matrix-2026-09-14";
export const GUARD_KEYS = [
  "verified",
  "skipped",
  "revised",
  "rerun_cited",
  "unverified",
  "guard_error",
];

const PROMPT = `请严格按以下步骤完成任务，不要改变顺序：
① 只执行一次：exec: echo "一次性密钥=$(head -c 12 /dev/urandom | base64)"
② 执行：exec: seq 1 400
③ 执行：exec: seq 401 800
④ 执行：exec: seq 801 1200
⑤ 最后回答①中首次生成的一次性密钥，必须原样给出。
随机命令只能执行一次。如果早期输出已折叠，读取 note 或工具输出归档；禁止重跑命令或猜测。`;

const ARM_ARGUMENTS = {
  A: ["--no-notes"],
  B: [],
  C: ["--no-final-guard"],
};

function parsePositiveInteger(name, value, { maximum = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    const suffix = Number.isFinite(maximum) ? ` (maximum ${maximum})` : "";
    throw new Error(`${name} must be a positive integer${suffix}`);
  }
  return parsed;
}

export function parseArgs(args) {
  const options = {
    model: undefined,
    configPath: undefined,
    runs: undefined,
    concurrency: 2,
    timeoutMs: 20 * 60 * 1000,
    maxCalls: DEFAULT_MAX_CALLS,
    yes: false,
    reportOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log(
        "用法：node scripts/notes-experiment.mjs "
        + "[--model <id>] [--config <path>] [--runs n] [--concurrency 1..3] "
        + "[--timeout-ms ms] [--max-calls n] [--yes] [--report-only]",
      );
      return null;
    }
    if (argument === "--report-only") {
      options.reportOnly = true;
      continue;
    }
    if (argument === "--model") {
      const model = args[++index]?.trim();
      if (!model) throw new Error("--model 需要非空模型 id");
      options.model = model;
      continue;
    }
    if (argument === "--config") {
      const configPath = args[++index]?.trim();
      if (!configPath) throw new Error("--config 需要非空路径");
      options.configPath = configPath;
      continue;
    }
    if (argument === "--runs") {
      options.runs = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--concurrency") {
      options.concurrency = parsePositiveInteger(argument, args[++index], { maximum: 3 });
      continue;
    }
    if (argument === "--max-calls") {
      options.maxCalls = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--yes") {
      options.yes = true;
      continue;
    }
    if (argument === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  options.runs ??= 30;
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

export function defaultConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg
    ? path.join(xdg, "erix", "config.json")
    : path.join(homedir(), ".erix", "config.json");
}

async function createModelConfig(root, model, sourcePath) {
  const source = await readJsonIfPresent(sourcePath);
  const sourceSlot = source?.slots?.default ?? {};
  const slot = { ...sourceSlot, model };
  const configPath = path.join(root, `${model}.config.json`);
  await writeFile(
    configPath,
    `${JSON.stringify({ slots: { default: slot } })}\n`,
    "utf8",
  );
  await chmod(configPath, 0o600);
  return configPath;
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      finish({ code: null, signal: null, error: error.message });
    });
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

async function runOnce(args, environment, options) {
  await options.beforeAttempt?.();
  const started = Date.now();
  const result = await runCli(args, environment, options.timeoutMs);
  return {
    ...result,
    attempts: [{
      attempt: 1,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      retryable: false,
    }],
  };
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

function toolInput(block) {
  return block?.input && typeof block.input === "object" ? block.input : {};
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

async function readTranscript(transcriptDir, runId) {
  const file = path.join(transcriptDir, `${safeRunId(runId)}.jsonl`);
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
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
    for (const value of extractValues(await readFile(path.join(outputsDir, entry.name), "utf8"))) {
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
      for (const value of extractValues(version.content)) {
        if (!values.includes(value)) values.push(value);
      }
      const reference = version.artifactRef;
      if (!reference?.archivePath) continue;
      try {
        for (const value of extractValues(await readFile(reference.archivePath, "utf8"))) {
          if (!values.includes(value)) values.push(value);
        }
      } catch {
        // Missing artifacts remain unverified; they do not provide provenance.
      }
    }
  }
  return values;
}

export function parseFinal(stdout) {
  const output = String(stdout ?? "");
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
  const stats = end < 0 ? output : output.slice(end);
  const title = heading?.[1] ?? heading?.[2] ?? "";
  const unverified = /未核验|核验错误/u.test(title);
  return {
    finalText,
    termination: unverified
      ? "final_guard_unverified"
      : stats.match(/\btermination=([a-z_]+)/u)?.[1] ?? "unknown",
    guarded: heading !== undefined && (heading[1] !== undefined || heading[2] !== undefined),
  };
}

function emptyGuardMetrics() {
  return Object.fromEntries(GUARD_KEYS.map((key) => [key, 0]));
}

export function parseStats(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const line = lines.findLast((candidate) => candidate.includes("=== 统计 ===")) ?? "";
  const usageText = line.match(/\busage=(\{.*?\})(?=\s+\w+=|\s+guard=|$)/u)?.[1];
  let usage = {};
  try {
    usage = usageText ? JSON.parse(usageText) : {};
  } catch {
    usage = {};
  }
  const guardText = line.match(/\bguard=(off|\{[^}]*\})/u)?.[1];
  const guard = {
    enabled: guardText !== "off" && guardText !== undefined,
    state: guardText === "off" ? "off" : guardText ? "metrics" : "missing",
    ...emptyGuardMetrics(),
  };
  if (guardText?.startsWith("{")) {
    for (const match of guardText.matchAll(/([a-z_]+):(\d+)/gu)) {
      if (GUARD_KEYS.includes(match[1])) guard[match[1]] = Number(match[2]);
    }
  }
  return {
    rounds: Number(line.match(/\brounds=(\d+)/u)?.[1] ?? 0),
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    guard,
  };
}

export function redactedPreview(value) {
  return { prefix: String(value).slice(0, 4), length: String(value).length };
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
  const first = generated[0] ?? notes[0];
  if (answer === first) return { category: "hit_first", answer };
  if (generated.slice(1).includes(answer) || notes.slice(1).includes(answer)) {
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
  attempts = [],
}) {
  const records = await readTranscript(transcriptDir, runId);
  const archiveValues = await readArchiveValues(
    path.join(transcriptDir, "outputs", safeRunId(runId)),
  );
  const noteValues = await readNoteValues(notesDir, runId);
  const transcriptValues = [];
  const toolCalls = [];
  let noteReadCalls = 0;
  let noteListCalls = 0;
  let archiveReadCalls = 0;
  let transcriptRounds = 0;

  for (const record of records) {
    if (Number.isSafeInteger(record?.round)) transcriptRounds = Math.max(transcriptRounds, record.round);
    for (const message of record.messages ?? []) {
      for (const block of blocksFor(message.content)) {
        if (block?.type === "tool_result") {
          for (const value of extractValues(blockText(block))) {
            if (!transcriptValues.includes(value)) transcriptValues.push(value);
          }
        }
        if (block?.type !== "tool_use") continue;
        const input = toolInput(block);
        const archiveRead = block.name === "readFile"
          ? archivePathIn(input.path)
          : block.name === "exec" && archivePathIn(input.command);
        noteReadCalls += block.name === "note_read" ? 1 : 0;
        noteListCalls += block.name === "note_list" ? 1 : 0;
        archiveReadCalls += archiveRead ? 1 : 0;
        toolCalls.push({ name: block.name, round: record.round, archiveRead });
      }
    }
  }

  const generatedRaw = transcriptValues.length > 0
    ? [...transcriptValues, ...archiveValues.filter((value) => !transcriptValues.includes(value))]
    : archiveValues;
  const final = parseFinal(stdout);
  const stats = parseStats(stdout);
  const classification = classify(final.finalText, generatedRaw, noteValues);
  const allValues = [...new Set([
    ...generatedRaw,
    ...noteValues,
    ...extractValues(final.finalText),
    ...extractValues(stderr),
  ])];
  const failClosed = final.termination === "final_guard_unverified"
    || stats.guard.unverified > 0
    || stats.guard.guard_error > 0;
  const processFailed = exitCode !== 0 || timedOut === true;
  const failed = processFailed || failClosed;
  const rounds = stats.rounds || transcriptRounds;

  return {
    id: `${arm}-${model}-${runId}`,
    arm,
    model,
    runId,
    exitCode,
    timedOut: timedOut === true,
    failed,
    processFailed,
    failClosed,
    termination: final.termination,
    durationMs,
    wallTimeMs: durationMs,
    rounds,
    convergenceRound: rounds,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    guard: stats.guard,
    guarded: stats.guard.enabled || final.guarded,
    compacted: records.some((record) => record.folded === true),
    noteReadCalls,
    noteListCalls,
    archiveReadCalls,
    noteRead: noteReadCalls > 0,
    noteList: noteListCalls > 0,
    archiveRead: archiveReadCalls > 0,
    toolCalls,
    attempts,
    retryableFailures: attempts.filter((attempt) => attempt.retryable).length,
    generatedValues: generatedRaw.map(redactedPreview),
    noteValues: noteValues.map(redactedPreview),
    finalText: redactText(final.finalText, allValues),
    category: classification.category,
    answer: classification.answer ? redactedPreview(classification.answer) : null,
    stderr: redactText(String(stderr ?? "").slice(-2_000), allValues),
  };
}

export function wilson95(successes, total) {
  if (total === 0) return { low: null, high: null };
  const z = 1.959964;
  const probability = successes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = (probability + (z ** 2) / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (probability * (1 - probability) + (z ** 2) / (4 * total)) / total,
  ) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function ratio(count, denominator) {
  return {
    count,
    denominator,
    value: denominator > 0 ? count / denominator : null,
    wilson95: wilson95(count, denominator),
  };
}

export function aggregate(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.arm}/${run.model}`;
    const failed = run.failed ?? (run.exitCode !== 0 || run.timedOut === true);
    const behavior = !failed && [
      "hit_first",
      "rerun_impersonation",
      "invented",
      "no_answer",
    ].includes(run.category);
    const row = groups.get(key) ?? {
      arm: run.arm,
      model: run.model,
      n: 0,
      completed: 0,
      determinable: 0,
      hitFirst: 0,
      rerunImpersonation: 0,
      invented: 0,
      evaluatedHit: 0,
      evaluatedRerun: 0,
      evaluatedInvented: 0,
      noAnswer: 0,
      rawNoAnswer: 0,
      failed: 0,
      failClosed: 0,
      noteRead: 0,
      noteList: 0,
      archiveRead: 0,
      noteReadCalls: 0,
      noteListCalls: 0,
      archiveReadCalls: 0,
      compacted: 0,
      roundsTotal: 0,
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      wallTimeMsTotal: 0,
      retryableFailures: 0,
      guard: emptyGuardMetrics(),
      guardRuns: emptyGuardMetrics(),
    };
    row.n += 1;
    row.completed += failed ? 0 : 1;
    row.determinable += behavior ? 1 : 0;
    row.hitFirst += run.category === "hit_first" ? 1 : 0;
    row.rerunImpersonation += run.category === "rerun_impersonation" ? 1 : 0;
    row.invented += run.category === "invented" ? 1 : 0;
    row.evaluatedHit += behavior && run.category === "hit_first" ? 1 : 0;
    row.evaluatedRerun += behavior && run.category === "rerun_impersonation" ? 1 : 0;
    row.evaluatedInvented += behavior && run.category === "invented" ? 1 : 0;
    row.noAnswer += behavior && run.category === "no_answer" ? 1 : 0;
    row.rawNoAnswer += run.category === "no_answer" ? 1 : 0;
    row.failed += failed ? 1 : 0;
    row.failClosed += run.failClosed ? 1 : 0;
    row.noteRead += (run.noteReadCalls ?? (run.noteRead ? 1 : 0)) > 0 ? 1 : 0;
    row.noteList += (run.noteListCalls ?? (run.noteList ? 1 : 0)) > 0 ? 1 : 0;
    row.archiveRead += (run.archiveReadCalls ?? (run.archiveRead ? 1 : 0)) > 0 ? 1 : 0;
    row.noteReadCalls += run.noteReadCalls ?? (run.noteRead ? 1 : 0);
    row.noteListCalls += run.noteListCalls ?? (run.noteList ? 1 : 0);
    row.archiveReadCalls += run.archiveReadCalls ?? (run.archiveRead ? 1 : 0);
    row.compacted += run.compacted ? 1 : 0;
    row.roundsTotal += run.rounds ?? run.convergenceRound ?? 0;
    row.inputTokensTotal += run.inputTokens ?? 0;
    row.outputTokensTotal += run.outputTokens ?? 0;
    row.wallTimeMsTotal += run.wallTimeMs ?? run.durationMs ?? 0;
    row.retryableFailures += run.retryableFailures ?? 0;
    for (const guardKey of GUARD_KEYS) {
      const count = run.guard?.[guardKey] ?? 0;
      row.guard[guardKey] += count;
      row.guardRuns[guardKey] += count > 0 ? 1 : 0;
    }
    groups.set(key, row);
  }

  return [...groups.values()].map((row) => {
    const evaluated = row.determinable;
    const rates = {
      hit: ratio(row.evaluatedHit, evaluated),
      rerun: ratio(row.evaluatedRerun, evaluated),
      invented: ratio(row.evaluatedInvented, evaluated),
      noAnswer: ratio(row.noAnswer, evaluated),
      failed: ratio(row.failed, row.n),
      failClosed: ratio(row.failClosed, row.n),
      compacted: ratio(row.compacted, row.n),
      noteRead: ratio(row.noteRead, row.n),
      noteList: ratio(row.noteList, row.n),
      archiveRead: ratio(row.archiveRead, row.n),
      ...Object.fromEntries(GUARD_KEYS.map(
        (key) => [`guard_${key}`, ratio(row.guardRuns[key], row.n)],
      )),
    };
    const errorSpecificCount = row.evaluatedRerun + row.evaluatedInvented;
    const errorSpecific = ratio(errorSpecificCount, evaluated);
    return {
      ...row,
      evaluated,
      hit: row.evaluatedHit,
      rerun: row.evaluatedRerun,
      averages: {
        rounds: row.n > 0 ? row.roundsTotal / row.n : null,
        inputTokens: row.n > 0 ? row.inputTokensTotal / row.n : null,
        outputTokens: row.n > 0 ? row.outputTokensTotal / row.n : null,
        wallTimeMs: row.n > 0 ? row.wallTimeMsTotal / row.n : null,
      },
      rates: { ...rates, errorSpecific },
      errorSpecificCount,
      errorSpecificRate: errorSpecific.value,
      errorSpecificWilson95: errorSpecific.wilson95,
      noteReadRate: rates.noteRead.value,
      noteListRate: rates.noteList.value,
      archiveReadRate: rates.archiveRead.value,
      failClosedRate: rates.failClosed.value,
      averageDurationMs: row.n > 0 ? row.wallTimeMsTotal / row.n : null,
      averageConvergenceRound: row.n > 0 ? row.roundsTotal / row.n : null,
      durationMs: row.wallTimeMsTotal,
      convergenceRoundTotal: row.roundsTotal,
    };
  });
}

export function roundRobinOrder({
  arms = ARMS,
  models = [],
  runs,
  smokeRuns,
  criticalRuns,
} = {}) {
  const fallbackRuns = criticalRuns ?? smokeRuns ?? 30;
  const targets = Object.fromEntries(models.map((model) => [
    model,
    typeof runs === "object"
      ? runs[model] ?? fallbackRuns
      : runs ?? fallbackRuns,
  ]));
  const jobs = [];
  const maximum = Math.max(...Object.values(targets));
  for (let index = 1; index <= maximum; index += 1) {
    for (const arm of arms) {
      for (const model of models) {
        if (index <= targets[model]) jobs.push({ arm, model, index });
      }
    }
  }
  return jobs;
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function intervalCell(rate) {
  return `${percent(rate.value)} [${percent(rate.wilson95.low)}, ${percent(rate.wilson95.high)}]`;
}

function guardCell(row) {
  return GUARD_KEYS.map((key) => `${key}=${row.guard[key]}`).join("<br>");
}

export function conclusionFor(rows) {
  if (!rows.some((row) => row.evaluated > 0)) {
    return "没有完成且可判定的 run，不能比较各臂。";
  }
  return rows.map(
    (row) => `${row.arm}/${row.model}: hit ${intervalCell(row.rates.hit)}，`
      + `错误具体值 ${intervalCell(row.rates.errorSpecific)}`,
  ).join("；");
}

function normalizeBatches(result) {
  if (Array.isArray(result?.batches)) return result.batches;
  if (result?.runs && result?.aggregate) {
    return [{
      metadata: {
        batchId: "legacy-import",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        protocol: result.protocol,
        legacy: true,
      },
      runs: result.runs,
      aggregate: result.aggregate,
      conclusion: result.conclusion,
      legacySnapshot: result,
    }];
  }
  return [];
}

export function appendBatch(previous, batch) {
  const batches = [...normalizeBatches(previous), batch];
  return {
    schemaVersion: 2,
    batches,
    metadata: batch.metadata,
    runs: batch.runs,
    aggregate: batch.aggregate,
    conclusion: batch.conclusion,
  };
}

function rawTable(rows) {
  return rows.map((row) => (
    `| ${row.arm} | ${row.model} | ${row.n} | ${row.evaluated} | ${row.failed} | `
    + `${row.hitFirst} | ${row.rerunImpersonation} | ${row.invented} | ${row.noAnswer} | `
    + `${row.failClosed} | ${row.noteListCalls} | ${row.noteReadCalls} | `
    + `${row.archiveReadCalls} | ${row.retryableFailures} | ${row.averages.rounds?.toFixed(1) ?? "—"} | `
    + `${row.averages.inputTokens?.toFixed(0) ?? "—"} | `
    + `${row.averages.outputTokens?.toFixed(0) ?? "—"} | `
    + `${row.averages.wallTimeMs?.toFixed(0) ?? "—"} | ${guardCell(row)} |`
  )).join("\n");
}

function intervalTable(rows) {
  return rows.map((row) => (
    `| ${row.arm} | ${row.model} | ${intervalCell(row.rates.hit)} | `
    + `${intervalCell(row.rates.rerun)} | ${intervalCell(row.rates.invented)} | `
    + `${intervalCell(row.rates.noAnswer)} | ${intervalCell(row.rates.failed)} | `
    + `${intervalCell(row.rates.failClosed)} | ${intervalCell(row.rates.noteList)} | `
    + `${intervalCell(row.rates.noteRead)} | ${intervalCell(row.rates.archiveRead)} | `
    + `${intervalCell(row.rates.compacted)} |`
  )).join("\n");
}

function guardIntervalTable(rows) {
  return rows.map((row) => (
    `| ${row.arm} | ${row.model} | `
    + GUARD_KEYS.map((key) => intervalCell(row.rates[`guard_${key}`])).join(" | ")
    + " |"
  )).join("\n");
}

function failureSummary(runs) {
  const counts = new Map();
  for (const run of runs) {
    if (!run.failed) continue;
    const reason = run.timedOut
      ? "timeout"
      : /monthly usage limit|quota will be refreshed/iu.test(run.stderr ?? "")
        ? "relay monthly quota exhausted"
        : run.exitCode !== 0
          ? "other process/provider error"
          : "unknown failure";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  if (counts.size === 0) return "无失败 run。";
  return [...counts.entries()].map(([reason, count]) => `${reason}=${count}`).join("；");
}

function decisionMarkdown(rows) {
  const byArmModel = new Map(rows.map((row) => [`${row.arm}/${row.model}`, row]));
  const decisions = [];
  for (const model of [...new Set(rows.map((row) => row.model))]) {
    const baseline = byArmModel.get(`A/${model}`);
    const notes = byArmModel.get(`B/${model}`);
    const noGuard = byArmModel.get(`C/${model}`);
    if (!baseline || !notes) continue;
    const notesSignificantlyBetter = notes.rates.hit.wilson95.low > baseline.rates.hit.wilson95.high;
    decisions.push(
      `${model}：${notesSignificantlyBetter
        ? "B 的 hit Wilson 95% 区间高于 A 且不重叠，notes 有增量，建议保留。"
        : "B 的 hit Wilson 95% 区间没有显著高于 A（区间重叠或 B 不优），notes 无增量，建议只保留显式 note_take 的语义记录、砍掉 auto-capture 复杂度。"}`
      + ` A=${intervalCell(baseline.rates.hit)}，B=${intervalCell(notes.rates.hit)}。`,
    );
    if (noGuard) {
      const silentErrors = noGuard.rerun + noGuard.invented;
      const guardEvents = baseline.guard.skipped + notes.guard.skipped
        + baseline.guard.revised + notes.guard.revised
        + baseline.guard.verified + notes.guard.verified
        + baseline.guard.rerun_cited + notes.guard.rerun_cited
        + baseline.guard.unverified + notes.guard.unverified
        + baseline.guard.guard_error + notes.guard.guard_error;
      const skipped = baseline.guard.skipped + notes.guard.skipped;
      const guardNearlyIdle = guardEvents > 0
        && skipped / guardEvents > 0.5
        && baseline.guard.revised + notes.guard.revised === 0;
      decisions.push(
        silentErrors > 0
          ? `${model}：C（无 guard）出现 ${silentErrors} 次 rerun/invented，说明静默错答会回来，guard 建议保留。`
          : guardNearlyIdle
            ? `${model}：C 未出现 rerun/invented，但 A/B 的 skipped 占 guard 事件 ${(skipped / guardEvents * 100).toFixed(1)}% 且 revised=0，guard 近乎空转，建议默认关或简化。`
            : `${model}：C 未出现 rerun/invented；当前样本不能证明 guard 的增量价值，结合 guard 计数与成本谨慎保留，需更大样本。`,
      );
    }
  }
  if (decisions.length === 0) return "没有可配对的 A/B/C 模型行，无法给出 notes/guard 决策。";
  return decisions.join("\n\n");
}

function reportCompatibleRow(row) {
  const n = row.n ?? 0;
  const evaluated = row.evaluated ?? row.determinable ?? 0;
  const guard = { ...emptyGuardMetrics(), ...(row.guard ?? {}) };
  const guardRuns = { ...emptyGuardMetrics(), ...(row.guardRuns ?? {}) };
  const hit = row.hit ?? row.hitFirst ?? 0;
  const rerun = row.rerun ?? row.rerunImpersonation ?? 0;
  const invented = row.evaluatedInvented ?? row.invented ?? 0;
  const rates = {
    hit: ratio(hit, evaluated),
    rerun: ratio(rerun, evaluated),
    invented: ratio(invented, evaluated),
    noAnswer: ratio(row.noAnswer ?? 0, evaluated),
    failed: ratio(row.failed ?? 0, n),
    failClosed: ratio(row.failClosed ?? 0, n),
    compacted: ratio(row.compacted ?? 0, n),
    noteList: ratio(row.noteList ?? 0, n),
    noteRead: ratio(row.noteRead ?? 0, n),
    archiveRead: ratio(row.archiveRead ?? 0, n),
    ...Object.fromEntries(GUARD_KEYS.map(
      (key) => [`guard_${key}`, ratio(guardRuns[key], n)],
    )),
    ...(row.rates ?? {}),
  };
  return {
    ...row,
    n,
    evaluated,
    hitFirst: row.hitFirst ?? hit,
    rerunImpersonation: row.rerunImpersonation ?? rerun,
    invented: row.invented ?? invented,
    noAnswer: row.noAnswer ?? 0,
    failed: row.failed ?? 0,
    failClosed: row.failClosed ?? 0,
    retryableFailures: row.retryableFailures ?? 0,
    noteListCalls: row.noteListCalls ?? row.noteList ?? 0,
    noteReadCalls: row.noteReadCalls ?? row.noteRead ?? 0,
    archiveReadCalls: row.archiveReadCalls ?? row.archiveRead ?? 0,
    guard,
    guardRuns,
    rates,
    averages: row.averages ?? {
      rounds: row.averageConvergenceRound ?? null,
      inputTokens: null,
      outputTokens: null,
      wallTimeMs: row.averageDurationMs ?? null,
    },
  };
}

export function reportMarkdown(result) {
  const batches = normalizeBatches(result);
  const latest = batches.at(-1);
  if (!latest) return "# Notes/Guard 实验矩阵\n\n尚无实验批次。";
  const latestRows = (latest.aggregate ?? []).map(reportCompatibleRow);
  const history = batches.map((batch) => {
    const metadata = batch.metadata ?? {};
    return `| ${metadata.batchId ?? "legacy"} | ${metadata.startedAt ?? "—"} | `
      + `${metadata.model ?? metadata.protocol?.models?.join(", ") ?? "—"} | `
      + `${metadata.runsPerArm ?? "—"} | ${batch.runs?.length ?? 0} |`;
  }).join("\n");
  return `# Notes/Guard 实验矩阵（n=30 方案）

报告批次：\`${latest.metadata?.batchId ?? "unknown"}\`；结果文件会追加批次，历史数据不覆盖。

## 实验臂与判据

- **A**：\`--no-notes\`，保留工具输出归档和 final guard。
- **B**：默认配置，启用 notes、归档和 final guard。
- **C**：默认配置加 \`--no-final-guard\`，启用 notes 和归档、关闭 guard。
- **hit**：终稿给出首次随机值；**rerun**：给出后续执行产生的已知值；**invented**：给出任何未知具体值；**noAnswer**：未给出可抽取值；**failClosed**：guard 未核验或 guard 错误。
- 进程失败、超时和 fail-closed 原样保留，但不进入 hit/rerun/invented/noAnswer 的行为分母。调用数是实际 tool call 次数，不是布尔值。随机值仅保存前 4 位和长度。

固定任务只执行一次随机命令，随后执行 \`seq 1..400\`、\`401..800\`、\`801..1200\` 并追问原值；compact budget 为 3000。运行按 A/B/C round-robin 交错，relay 限流失败指数退避。

## 原始聚合表（最新批次）

| 臂 | 模型 | n | 行为分母 | 失败 | hit | rerun | invented | noAnswer | failClosed | note_list 调用 | note_read 调用 | archive_read 调用 | 重试失败 | 平均轮次 | 平均 input tokens | 平均 output tokens | 平均 wall ms | guard 计数 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${rawTable(latestRows)}

## 比率与 Wilson 95% 区间（最新批次）

| 臂 | 模型 | hit | rerun | invented | noAnswer | failed | failClosed | note_list run | note_read run | archive_read run | compacted run |
|---|---|---|---|---|---|---|---|---|---|---|---|
${intervalTable(latestRows)}

行为比率以“未失败且可判定”的 run 为分母；失败、fail-closed、调用发生率、compacted 和 guard 事件 run 比率以全部 n 为分母。JSON 的 \`rates\` 保存同样的 Wilson 区间。模型由本批次的显式参数、环境变量或用户配置决定，不在脚本中替换或排除。

## Guard 比率与 Wilson 95% 区间（按 run 至少发生一次）

| 臂 | 模型 | verified | skipped | revised | rerun_cited | unverified | guard_error |
|---|---|---|---|---|---|---|---|
${guardIntervalTable(latestRows)}

## 决策建议

${decisionMarkdown(latestRows)}

成本按每臂均值报告：平均 rounds、input/output tokens 和 wall time 已列在原始聚合表；失败和重试失败不从成本中删除。

## 失败与有效样本限制

本批次实际保存 ${latest.runs?.length ?? 0} 个作业结果；失败原因分类（基于脱敏后的 stderr）为：${failureSummary(latest.runs ?? [])}。失败、超时和 fail-closed 均保留在 JSON 中，但不进入行为比率分母；因此本批次每臂目标 n=30，实际可判定完成数见“行为分母”列，不能把 14/30 当作完整 n=30 证据。

## n=30 功效限制

每臂目标 n 只能识别很大的差异；稀有错误的 Wilson 区间仍宽，零事件也不等于零风险。该矩阵适合发现方向性信号和接线问题，不足以证明臂间等效或建立稳定因果结论。模型、relay 状态、并发和压缩时点仍可能混杂。

## 批次历史

| batch | 开始时间 | 模型 | 每臂目标 n | 保存 run |
|---|---|---|---:|---:|
${history}

## 最新批次结论

${latest.conclusion ?? conclusionFor(latestRows)}
`;
}

async function runJob(job, context) {
  const runId = `notes-matrix-${context.batchId}-${job.arm.toLowerCase()}-${job.model}-${String(job.index).padStart(2, "0")}`;
  const runRoot = path.join(context.tempRoot, runId);
  const transcriptDir = path.join(runRoot, "transcripts");
  const notesDir = path.join(runRoot, "notes");
  await mkdir(transcriptDir, { recursive: true });
  await mkdir(notesDir, { recursive: true });
  const args = [
    "chat",
    PROMPT,
    "--config",
    context.configPath,
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
    ...ARM_ARGUMENTS[job.arm],
  ];
  const environment = { ...process.env, ERIX_NOTES_DIR: notesDir };
  delete environment.ERIX_NO_FINAL_GUARD;
  delete environment.LLM_KIT_MODEL;
  const started = Date.now();
  const processResult = await runOnce(args, environment, {
    ...context.options,
    beforeAttempt: async () => {
      await rm(transcriptDir, { recursive: true, force: true });
      await rm(notesDir, { recursive: true, force: true });
      await mkdir(transcriptDir, { recursive: true });
      await mkdir(notesDir, { recursive: true });
    },
  });
  const durationMs = Date.now() - started;
  const run = await inspectRun({
    runId,
    transcriptDir,
    notesDir,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    arm: job.arm,
    model: job.model,
    durationMs,
    exitCode: processResult.code,
    timedOut: processResult.timedOut,
    attempts: processResult.attempts,
  });
  if (processResult.error) {
    run.stderr = `${run.stderr}\n${redactText(
      processResult.error,
      extractValues(processResult.error),
    )}`.trim();
  }
  if (run.failed) {
    const rawError = `${processResult.stderr ?? ""}\n${processResult.stdout ?? ""}\n${processResult.error ?? ""}`.trim();
    if (rawError) console.error(`模型调用失败（原始输出）：\n${rawError}`);
  }
  console.log(
    `${job.arm}/${job.model} #${job.index}: ${run.category} failed=${Number(run.failed)} `
    + `calls(list/read/archive)=${run.noteListCalls}/${run.noteReadCalls}/${run.archiveReadCalls} `
    + `guard=${run.guard.state} rounds=${run.rounds} wall=${durationMs}ms`,
  );
  return run;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  const previous = await readJsonIfPresent(RESULTS_PATH);
  if (options.reportOnly) {
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${reportMarkdown(previous)}\n`, "utf8");
    console.log(`报告已写入 ${path.relative(REPO_ROOT, REPORT_PATH)}`);
    return;
  }

  const sourceConfigPath = options.configPath ?? defaultConfigPath();
  const sourceConfig = await readJsonIfPresent(sourceConfigPath) ?? {};
  const selection = resolveExperimentModel({
    explicitModel: options.model,
    environment: process.env,
    config: sourceConfig,
  });
  const plannedCalls = plannedCallCount({
    armCount: ARMS.length,
    runs: options.runs,
    modelCount: 1,
  });
  validateCostPlan({
    plannedCalls,
    maxCalls: options.maxCalls,
    confirmed: options.yes,
  });
  const estimate = estimateHistoricalUsage(previous, {
    plannedCalls,
    concurrency: options.concurrency,
  });
  console.log(formatCostPreview({
    model: selection.model,
    modelSource: selection.source,
    plannedCalls,
    armCount: ARMS.length,
    runs: options.runs,
    modelCount: 1,
    maxCalls: options.maxCalls,
    estimate,
  }));
  if (!options.yes) return;

  const startedAt = new Date().toISOString();
  const batchId = startedAt.replaceAll(/[:.]/gu, "-");
  const tempRoot = await mkdtemp(path.join(REPO_ROOT, ".notes-matrix-"));
  let runs = [];
  let failure;
  try {
    const configPath = await createModelConfig(tempRoot, selection.model, sourceConfigPath);
    const jobs = roundRobinOrder({
      arms: ARMS,
      models: [selection.model],
      runs: options.runs,
    });
    const outcome = await runFailFast(
      jobs,
      (job) => runJob(job, { batchId, tempRoot, configPath, options }),
      { concurrency: options.concurrency },
    );
    runs = outcome.results;
    failure = outcome.failure;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const rows = aggregate(runs);
  const batch = {
    metadata: {
      batchId,
      startedAt,
      completedAt: new Date().toISOString(),
      model: selection.model,
      modelSource: selection.source,
      runsPerArm: options.runs,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      arms: ARMS,
      roundRobinSeed: ROUND_ROBIN_SEED,
      prompt: "one-shot random value + seq 1..400/401..800/801..1200 + recall",
      compactBudget: 3000,
      maxRounds: 12,
      maxCalls: options.maxCalls,
      plannedCalls,
      stoppedEarly: failure !== undefined,
    },
    runs,
    aggregate: rows,
    conclusion: conclusionFor(rows),
  };
  const result = appendBatch(previous, batch);
  await writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${reportMarkdown(result)}\n`, "utf8");
  console.log(`\n${formatUsageSummary(runs)}`);
  console.log(`\n${batch.conclusion}`);
  if (failure) {
    console.error(`实验已在首次失败后停止：${failure.message}`);
    process.exitCode = 1;
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
