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
const MODELS = ["kimi-for-coding", "deepseek-v4-flash"];
const ARMS = ["A", "B", "C", "D"];
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
      console.log("用法：node scripts/notes-experiment.mjs [--smoke-runs 4] [--critical-runs 6] [--timeout-ms 1200000] [--report-only]");
      return null;
    }
    if (argument === "--report-only") {
      options.reportOnly = true;
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
      && (candidate.id === "kimi-for-coding" || candidate.id === "deepseek-v4-flash")
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

function extractValues(text) {
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

function parseFinal(stdout) {
  const start = stdout.lastIndexOf("=== 终稿 ===");
  const end = stdout.indexOf("\n=== 统计 ===", start);
  const finalText = start < 0
    ? ""
    : stdout.slice(start + "=== 终稿 ===".length, end < 0 ? undefined : end).trim();
  const stats = end < 0 ? "" : stdout.slice(end);
  const termination = stats.match(/\btermination=([a-z_]+)/u)?.[1]
    ?? (stdout.includes("final_guard_unverified") ? "final_guard_unverified" : "unknown");
  return { finalText, termination };
}

function redactedPreview(value) {
  return { prefix: value.slice(0, 4), length: value.length };
}

function redactText(text, values) {
  let result = String(text ?? "");
  for (const value of values) {
    result = result.replaceAll(value, `${value.slice(0, 4)}…（长度${value.length}）`);
  }
  return result;
}

function classify(finalText, generatedValues, noteValues) {
  const labelMatch = String(finalText).match(
    /(?:一次性密钥|密钥)\s*(?:原样|首次)?\s*(?:是|为|=|:|：)\s*([A-Za-z0-9+/=_-]+)/u,
  );
  const answer = labelMatch?.[1]
    ?? generatedValues.find((value) => String(finalText).includes(value))
    ?? null;
  if (!answer) return { category: "no_answer", answer: null };
  if (answer === generatedValues[0]) return { category: "hit_first", answer };
  if (generatedValues.slice(1).includes(answer)) {
    return { category: "rerun_impersonation", answer };
  }
  if (noteValues.includes(answer) || generatedValues.includes(answer)) {
    return { category: "known_other", answer };
  }
  return { category: "invented", answer };
}

async function inspectRun({
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
  const generatedValues = [...archiveValues];
  for (const record of records) {
    for (const message of record.messages ?? []) {
      for (const block of blocksFor(message.content)) {
        for (const value of extractValues(blockText(block))) {
          if (!generatedValues.includes(value)) generatedValues.push(value);
        }
      }
    }
  }

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
  const failClosed = final.termination === "final_guard_unverified";
  const allValues = [...new Set([...generatedValues, ...noteValues])];
  const failed = exitCode !== 0 || timedOut;
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
    compacted: compaction,
    noteRead,
    archiveRead,
    failClosed,
    toolCalls,
    generatedValues: generatedValues.map(redactedPreview),
    noteValues: noteValues.map(redactedPreview),
    finalText: redactText(final.finalText, allValues),
    category: classification.category,
    answer: classification.answer ? redactedPreview(classification.answer) : null,
    stderr: redactText(stderr.slice(-2000), allValues),
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

function aggregate(runs) {
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
      failed: 0,
      knownOther: 0,
      noteRead: 0,
      archiveRead: 0,
      failClosed: 0,
      compacted: 0,
      durationMs: 0,
    };
    entry.n += 1;
    entry.hitFirst += run.category === "hit_first" ? 1 : 0;
    entry.rerunImpersonation += run.category === "rerun_impersonation" ? 1 : 0;
    entry.invented += run.category === "invented" ? 1 : 0;
    entry.noAnswer += run.category === "no_answer" && !failed ? 1 : 0;
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
    const evaluated = entry.n - entry.failed;
    return {
      ...entry,
      evaluated,
      errorSpecificRate: evaluated > 0
        ? (entry.rerunImpersonation + entry.invented) / evaluated
        : null,
      errorSpecificWilson95: evaluated > 0
        ? wilson95(entry.rerunImpersonation + entry.invented, evaluated)
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

function conclusionFor(aggregateRows) {
  const comparable = aggregateRows
    .filter((entry) => entry.evaluated > 0)
    .sort((left, right) => (
      left.errorSpecificRate - right.errorSpecificRate
      || right.hitFirst - left.hitFirst
      || left.noAnswer - right.noAnswer
    ));
  if (comparable.length === 0) return "没有完成的 run，无法比较各臂。";
  const best = comparable[0];
  const failures = aggregateRows
    .filter((entry) => entry.failed > 0)
    .map((entry) => `${entry.arm}/${entry.model} ${entry.failed}/${entry.n}`)
    .join("、");
  const failureNote = failures
    ? `本次还存在运行失败（${failures}），其中 deepseek 的 relay 拒绝不应解读为模型行为结果。`
    : "";
  return `${failureNote} 按错误具体值比例的点估计，当前最优格为 **${best.arm}/${best.model}**（${percent(best.errorSpecificRate)}，${best.evaluated} 个可判定 run；命中首次 ${best.hitFirst}，无答案 ${best.noAnswer}）。该排序只是初步证据，Wilson 区间较宽且不同格之间可能重叠；应继续做 100+ 次、交错运行、分模型报告后再决定默认方案。`;
}

function reportMarkdown(result) {
  const rows = result.aggregate.map((entry) => {
    const interval = entry.errorSpecificWilson95;
    return `| ${entry.arm} | ${entry.model} | ${entry.n} | ${entry.failed} | ${entry.hitFirst} | ${entry.rerunImpersonation} | ${entry.invented} | ${entry.noAnswer} | ${percent(entry.noteReadRate)} | ${percent(entry.archiveReadRate)} | ${entry.failClosed} | ${percent(entry.errorSpecificRate)} [${percent(interval.low)}, ${percent(interval.high)}] |`;
  }).join("\n");
  const totalDuration = result.runs.reduce((sum, run) => sum + run.durationMs, 0);
  return `# Notes 实验矩阵（A/B/C/D）

运行日期：${result.startedAt}。这是按 #63 固定协议驱动真实 \`node bin/cli.js chat\` 的初步 smoke/关键对照结果；每格样本量较小，不能据此下最终结论。**下一步需要 100+ 次才能定论。**

## 协议

- A：\`--no-final-guard --skills-dir <空目录>\`；B：\`--no-final-guard\`；C：\`--no-final-guard --notes-ledger\`；D：默认 provenance gate。
- 每 run 使用独立 transcript、\`ERIX_NOTES_DIR\` 和 session；提示固定执行一次随机密钥命令、三段 \`seq\`，最后原样回答第一次密钥。
- “错误具体值” = 重跑冒充 + 编造。区间为**完成且可判定 run**中该比例的 Wilson 95% 区间；relay 拒绝、超时等“运行失败”不计作无答案，也不进入该 CI 分母。“note 读取率”按发生 \`note_list\`/\`note_read\` 的 run 计，“归档读取率”按读取 outputs 目录的 run 计。
- 随机密钥仅在结果 JSON 中保留“前 4 位 + 长度”脱敏摘要，本文不写入明文。

## 矩阵结果

| 臂 | 模型 | n | 运行失败 | 命中首次 | 重跑冒充 | 编造 | 无答案 | note 读取率 | 归档读取率 | fail-closed | 错误具体值比例（Wilson 95%） |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

## 初步结论与局限

${result.conclusion}

本次总耗时约 ${(totalDuration / 1000).toFixed(1)} 秒（脚本 wall clock 以运行日志为准）。限制包括：模型服务状态、样本量、单一提示协议和单一工作目录；“known_other”不会伪装成命中首次，报告表中单独的四类判定仍按协议统计。`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  if (options.reportOnly) {
    const result = JSON.parse(await readFile(RESULTS_PATH, "utf8"));
    result.runs = result.runs.map((run) => {
      const failed = run.failed ?? (run.exitCode !== 0 || run.timedOut === true);
      return {
        ...run,
        failed,
        ...(failed ? { category: "failed" } : {}),
      };
    });
    result.aggregate = aggregate(result.runs);
    result.conclusion = conclusionFor(result.aggregate);
    await writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${reportMarkdown(result)}\n`, "utf8");
    console.log(result.conclusion);
    return;
  }
  const startedAt = new Date().toISOString();
  const tempRoot = await mkdtemp(path.join("/tmp", "erix-notes-experiment-"));
  const runs = [];
  try {
    const configPaths = await createModelConfigs(tempRoot);
    const emptySkills = path.join(tempRoot, "empty-skills");
    await mkdir(emptySkills, { recursive: true });
    for (const arm of ARMS) {
      for (const model of MODELS) {
        const targetRuns = arm === "A" || arm === "D"
          ? options.criticalRuns
          : options.smokeRuns;
        for (let index = 1; index <= targetRuns; index += 1) {
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
          if (arm === "A") args.push("--no-final-guard", "--skills-dir", emptySkills);
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
          if (processResult.error) run.stderr = `${run.stderr}\n${processResult.error}`;
          runs.push(run);
          console.log(
            `${arm}/${model} #${index}: category=${run.category} first=${run.category === "hit_first" ? 1 : 0} `
            + `note=${run.noteRead ? 1 : 0} archive=${run.archiveRead ? 1 : 0} `
            + `failClosed=${run.failClosed ? 1 : 0} termination=${run.termination} `
            + `duration=${(durationMs / 1000).toFixed(1)}s`,
          );
        }
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const result = {
    protocol: {
      prompt: "fixed one-shot secret + seq 1..400/401..800/801..1200",
      compactBudget: 3000,
      maxRounds: 12,
      smokeRuns: options.smokeRuns,
      criticalRuns: options.criticalRuns,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    runs,
    aggregate: aggregate(runs),
  };
  result.conclusion = conclusionFor(result.aggregate);
  await writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${reportMarkdown(result)}\n`, "utf8");
  console.log("\n=== 聚合 ===");
  for (const entry of result.aggregate) {
    console.log(
      `${entry.arm}/${entry.model}: n=${entry.n} hit=${entry.hitFirst} rerun=${entry.rerunImpersonation} `
      + `invented=${entry.invented} noAnswer=${entry.noAnswer} failed=${entry.failed} note=${entry.noteRead} `
      + `archive=${entry.archiveRead} failClosed=${entry.failClosed} `
      + `error=${percent(entry.errorSpecificRate)} Wilson95=[${percent(entry.errorSpecificWilson95.low)},${percent(entry.errorSpecificWilson95.high)}]`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}
