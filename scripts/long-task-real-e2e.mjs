// @ts-check

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFileTranscriptStore,
  createOpenAIProvider,
  runToolLoop,
  validateMessages,
} from "../src/index.js";
import { computeBudget } from "../src/compact/budget.js";
import { estimateTokens } from "../src/tokens.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";
import { recoveryRowsPath } from "../src/store/file.js";
import { RECOVERY_EVENT_TOOL_EXECUTED } from "../src/store/recovery-rows.js";
import {
  assertGateNotRetired,
  formatSkip,
  printableEndpoint,
  resolveRealUpstream,
} from "../examples/e2e-real-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOOP_DIR = join(ROOT, "src", "loop");
const CONTEXT_WINDOW_TOKENS = 65_536;
const MAX_OUTPUT_TOKENS = 8_192;
const MODEL_CONFIG = Object.freeze({
  contextWindowTokens: CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
});
const DERIVED_BUDGET_TOKENS = computeBudget(MODEL_CONFIG);
const MAX_ROUNDS = 32;
const L1_PROMPT = "把 src/loop/orchestrator.js 的全文读一遍，然后用三句话总结它的主要职责。";
const L2_PROMPT = "分析 src/loop/ 目录：列出每个 .js 文件的一句话职责，指出 orchestrator.js 里最大的三个函数。";
const RESUME_PROMPT = "请继续完成分析并给出结果。";
const ENGINE_ROUND_KEY = /:engine:round:\d+$/u;

function sourcePath(pathValue) {
  if (typeof pathValue !== "string" || pathValue.trim() === "") {
    throw new TypeError("readFile requires a non-empty path");
  }
  const absolute = resolve(ROOT, pathValue);
  const relativePath = relative(ROOT, absolute);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || !relativePath.startsWith(`src${sep}`)
    || !relativePath.endsWith(".js")
  ) {
    throw new Error("readFile only accepts JavaScript files under src/");
  }
  return absolute;
}

function collectLoopFiles(directory = LOOP_DIR, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (
    a.name.localeCompare(b.name)
  ))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectLoopFiles(absolute, output);
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      output.push(relative(ROOT, absolute).split(sep).join("/"));
    }
  }
  return output;
}

const TOOLS = [
  {
    name: "listFiles",
    description: "列出 src/loop/ 下所有 .js 文件的相对路径。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "目录路径；本任务使用 src/loop" } },
      required: ["path"],
    },
  },
  {
    name: "readFile",
    description: "读取 src/ 下一个 .js 文件的全文。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "仓库相对路径，例如 src/loop/orchestrator.js" } },
      required: ["path"],
    },
  },
];

function createTelemetry() {
  return {
    roundNumbers: new Set(),
    compactions: [],
    toolUseEvents: 0,
    providerRequests: 0,
    requestToolResultCounts: [],
  };
}

function observeEvent(telemetry, event) {
  if (event?.type === "round_start" && Number.isSafeInteger(event.round)) {
    telemetry.roundNumbers.add(event.round);
  }
  if (event?.type === "tool_use") telemetry.toolUseEvents += 1;
  if (event?.type === "compaction" && event.compaction !== undefined) {
    telemetry.compactions.push(event.compaction);
  }
}

function countsForBlocks(messages, type, idField) {
  const counts = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type !== type || typeof block[idField] !== "string") continue;
      const id = block[idField];
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function assertClosedMessages(messages, label) {
  validateMessages(messages);
  const uses = countsForBlocks(messages, "tool_use", "id");
  const results = countsForBlocks(messages, "tool_result", "tool_use_id");
  assert.equal(results.size, uses.size, `${label}: tool_use/tool_result id sets differ`);
  for (const [id, count] of uses) {
    assert.equal(count, 1, `${label}: tool_use ${id} is not unique`);
    assert.equal(results.get(id), 1, `${label}: tool_use ${id} must have exactly one tool_result`);
  }
  for (const id of results.keys()) {
    assert.equal(uses.has(id), true, `${label}: tool_result ${id} has no tool_use`);
  }
  return uses;
}

function ledgerMessages(rows) {
  return foldLedgerMessages(rows).map((entry) => entry.message);
}

function readToolExecutedRows(dir, runId) {
  const path = recoveryRowsPath(dir, runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((row) => row?.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED);
}

function assertRunStateRecordShape(rows) {
  const records = rows.filter((row) => ENGINE_ROUND_KEY.test(String(row?.dedupKey ?? "")));
  assert.ok(records.length > 0, "ledger must contain engine round records");
  for (const record of records) {
    assert.equal(Object.hasOwn(record, "runState"), false,
      `engine round ${String(record.round)} must not duplicate runState`);
    assert.equal(Object.hasOwn(record, "runStateMeta"), true,
      `engine round ${String(record.round)} must carry runStateMeta`);
  }
}

function usageFor(value) {
  const usage = value?.usage ?? {};
  return {
    input: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    output: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
  };
}

function roundsFor(result, error, telemetry) {
  if (Number.isSafeInteger(result?.rounds)) return result.rounds;
  if (Number.isSafeInteger(error?.rounds)) return error.rounds;
  return telemetry.roundNumbers.size;
}

function hasBudgetUnreachable(telemetry, result) {
  return telemetry.compactions.some((fact) => (
    fact?.budgetUnreachable === "protected_message_exceeds_budget"
  )) || (Array.isArray(result?.compactionStats) && result.compactionStats.some((stat) => (
    stat?.budgetUnreachable === "protected_message_exceeds_budget"
  )));
}

function logMetrics(label, { result, error, telemetry, elapsedMs, toolCalls = 0, readFileCalls = 0 }) {
  const usage = usageFor(result ?? error);
  const compactionStats = Array.isArray(result?.compactionStats) ? result.compactionStats : [];
  const folds = compactionStats.filter((stat) => stat?.foldedRounds > 0).length;
  const foldedRounds = compactionStats.reduce((sum, stat) => (
    sum + (Number.isSafeInteger(stat?.foldedRounds) ? stat.foldedRounds : 0)
  ), 0);
  console.log(
    `[long-task] ${label} rounds=${roundsFor(result, error, telemetry)}`
      + ` folds=${folds} foldedRounds=${foldedRounds}`
      + ` inputTokens=${usage.input} outputTokens=${usage.output}`
      + ` elapsedMs=${elapsedMs} budgetUnreachable=${hasBudgetUnreachable(telemetry, result)}`
      + ` toolCalls=${toolCalls} readFileCalls=${readFileCalls}`
      + ` providerRequests=${telemetry.providerRequests}`,
  );
}

function errorSummary(error, gate) {
  const name = error?.code ?? error?.name ?? "unknown";
  const message = String(error?.message ?? "")
    .replaceAll(typeof gate?.apiKey === "string" ? gate.apiKey : "\u0000", "[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 240);
  return `${name}${message === "" ? "" : `: ${message}`}`;
}

function makeProvider(gate, telemetry) {
  if (
    typeof gate.endpoint !== "string"
    || typeof gate.apiKey !== "string"
    || typeof gate.model !== "string"
  ) {
    throw new Error("real-model gate passed without resolved endpoint/model/credential");
  }
  const provider = createOpenAIProvider({
    endpoint: gate.endpoint,
    apiKey: gate.apiKey,
    model: gate.model,
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return {
    ...provider,
    chat(request) {
      telemetry.providerRequests += 1;
      telemetry.requestToolResultCounts.push(
        countsForBlocks(request?.messages, "tool_result", "tool_use_id"),
      );
      return provider.chat(request);
    },
  };
}

function makeExecutor(counters) {
  return async ({ name, input }) => {
    counters.toolCalls += 1;
    if (name === "readFile") {
      counters.readFileCalls += 1;
      return readFileSync(sourcePath(input?.path), "utf8");
    }
    if (name === "listFiles") {
      const absolute = resolve(ROOT, String(input?.path ?? ""));
      if (absolute !== LOOP_DIR) {
        throw new Error("listFiles only accepts src/loop");
      }
      return collectLoopFiles().join("\n");
    }
    throw new Error(`unknown tool: ${String(name)}`);
  };
}

async function runL1(gate) {
  const telemetry = createTelemetry();
  const counters = { toolCalls: 0, readFileCalls: 0 };
  const startedAt = Date.now();
  let result;
  let error;
  try {
    result = await runToolLoop({
      provider: makeProvider(gate, telemetry),
      tools: TOOLS,
      executeTool: makeExecutor(counters),
      onEvent: (event) => observeEvent(telemetry, event),
      capabilities: {
        hooks: {
          protectedMessage: (message) => Array.isArray(message?.content)
            && message.content.some((block) => block?.type === "tool_result"),
        },
      },
      config: {
        input: { initialUserMessage: L1_PROMPT, wrapup: false },
        metadata: { modelMetadata: MODEL_CONFIG },
        run: { runId: `long-task-l1-${randomUUID()}`, maxRounds: 8, completion: false, reflection: false },
      },
    });
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Date.now() - startedAt;
  logMetrics("L1", { result, error, telemetry, elapsedMs, ...counters });
  if (error !== undefined) throw error;
  assert.ok(result, "L1 must return a run result");
  assert.notEqual(result.termination?.reason, "failed", "L1 termination must not be failed");
  assert.ok(telemetry.compactions.some((fact) => (
    fact?.budgetUnreachable === "protected_message_exceeds_budget"
  )), "L1 event stream must report protected_message_exceeds_budget");
  assert.ok(typeof result.finalText === "string" && result.finalText.trim() !== "",
    "L1 finalText must be non-empty");
  assert.ok(usageFor(result).input > 0 && usageFor(result).output > 0,
    "L1 must report real provider token usage");
}

async function runL2(gate) {
  const dir = mkdtempSync(join(tmpdir(), "erix-long-task-real-e2e-"));
  const store = createFileTranscriptStore({ dir });
  const counters = { toolCalls: 0, readFileCalls: 0 };
  const initialTelemetry = createTelemetry();
  const runId = `long-task-l2-${randomUUID()}`;
  const startedAt = Date.now();
  let result;
  let error;

  try {
    try {
      result = await runToolLoop({
        provider: makeProvider(gate, initialTelemetry),
        tools: TOOLS,
        executeTool: makeExecutor(counters),
        store,
        onEvent: (event) => observeEvent(initialTelemetry, event),
        config: {
          input: { initialUserMessage: L2_PROMPT, wrapup: false },
          metadata: { modelMetadata: MODEL_CONFIG },
          run: { runId, maxRounds: MAX_ROUNDS, completion: false, reflection: false },
        },
      });
    } catch (caught) {
      error = caught;
    }
    const elapsedMs = Date.now() - startedAt;
    logMetrics("L2", {
      result,
      error,
      telemetry: initialTelemetry,
      elapsedMs,
      ...counters,
    });

    const rounds = roundsFor(result, error, initialTelemetry);
    if (counters.readFileCalls < 5 || rounds < 6) {
      const missing = [
        ...(counters.readFileCalls < 5 ? [`readFile=${counters.readFileCalls}/5`] : []),
        ...(rounds < 6 ? [`rounds=${rounds}/6`] : []),
      ];
      console.log(`[long-task] SKIP L2 scenario_not_established: ${missing.join(", ")}`
        + (error === undefined ? "" : `; executionError=${errorSummary(error, gate)}`));
      return;
    }
    if (error !== undefined) throw error;
    assert.ok(result, "L2 must return a run result after meeting its preconditions");

    const messages = result.messages;
    assertClosedMessages(messages, "L2 run result");
    const rawRows = await store.loadRawRows(runId);
    const beforeResumeMessages = ledgerMessages(rawRows);
    const initialToolUses = assertClosedMessages(beforeResumeMessages, "L2 ledger before resume");
    assert.ok((result.compactionStats ?? []).some((stat) => stat?.foldedRounds > 0),
      "L2 must fold at least one round");
    assertRunStateRecordShape(rawRows);
    assert.equal(counters.toolCalls, initialTelemetry.toolUseEvents,
      "L2 executor calls must match tool_use events");
    assert.equal(readToolExecutedRows(dir, runId).length, initialTelemetry.toolUseEvents,
      ".recovery.jsonl tool-executed rows must match L2 tool calls");

    const resumeTelemetry = createTelemetry();
    const resumeStartedAt = Date.now();
    const callsBeforeResume = counters.toolCalls;
    const readsBeforeResume = counters.readFileCalls;
    let resumed;
    let resumeError;
    try {
      resumed = await runToolLoop({
        provider: makeProvider(gate, resumeTelemetry),
        tools: TOOLS,
        executeTool: makeExecutor(counters),
        store,
        onEvent: (event) => observeEvent(resumeTelemetry, event),
        config: {
          input: { initialUserMessage: RESUME_PROMPT, wrapup: false },
          metadata: { modelMetadata: MODEL_CONFIG },
          run: { runId, resume: true, maxRounds: MAX_ROUNDS, completion: false, reflection: false },
        },
      });
    } catch (caught) {
      resumeError = caught;
    }
    const resumeElapsedMs = Date.now() - resumeStartedAt;
    logMetrics("L2-resume", {
      result: resumed,
      error: resumeError,
      telemetry: resumeTelemetry,
      elapsedMs: resumeElapsedMs,
      toolCalls: counters.toolCalls - callsBeforeResume,
      readFileCalls: counters.readFileCalls - readsBeforeResume,
    });
    if (resumeError !== undefined) throw resumeError;
    assert.ok(resumed, "L2 resume must return a result");
    assert.notEqual(resumed.termination?.reason, "failed", "L2 resume must not fail");
    assert.ok(typeof resumed.finalText === "string" && resumed.finalText.trim() !== "",
      "L2 resume must return non-empty finalText");

    const afterResumeRows = await store.loadRawRows(runId);
    const afterResumeMessages = ledgerMessages(afterResumeRows);
    const afterResumeToolUses = assertClosedMessages(afterResumeMessages, "L2 ledger after resume");
    for (const id of initialToolUses.keys()) {
      assert.equal(countsForBlocks(afterResumeMessages, "tool_result", "tool_use_id").get(id), 1,
        `resume must retain exactly one tool_result for ${id}`);
    }
    for (const requestCounts of resumeTelemetry.requestToolResultCounts) {
      for (const [id, count] of requestCounts) {
        assert.ok(count <= 1, `resume request must not duplicate tool_result ${id}`);
      }
    }
    assertRunStateRecordShape(afterResumeRows);
    assert.equal(counters.toolCalls, initialTelemetry.toolUseEvents + resumeTelemetry.toolUseEvents,
      "all executor calls must match tool_use events across resume");
    assert.equal(readToolExecutedRows(dir, runId).length,
      initialTelemetry.toolUseEvents + resumeTelemetry.toolUseEvents,
      ".recovery.jsonl tool-executed rows must match tool calls after resume");
    assert.ok(afterResumeToolUses.size >= initialToolUses.size,
      "resume must retain the original tool-use ids");
    console.log(`[long-task] PASS L2 ledgerClosed=true roundRecords=${afterResumeRows.filter((row) => (
      ENGINE_ROUND_KEY.test(String(row?.dedupKey ?? ""))
    )).length} toolExecutedRows=${readToolExecutedRows(dir, runId).length}`
      + ` resumeRequests=${resumeTelemetry.providerRequests}`);
    console.log(`[long-task] PASS L2 same-id tool_result count=1 for ${initialToolUses.size} original tool calls`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const l1Only = args.length === 1 && args[0] === "--l1-only";
  if (args.length > 0 && !l1Only) {
    throw new Error("usage: node scripts/long-task-real-e2e.mjs [--l1-only]");
  }
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    assertGateNotRetired(gate);
    console.log(`[long-task] SKIP ${formatSkip(gate)}`);
    return;
  }
  console.log(`[long-task] model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)}`
    + ` contextWindowTokens=${CONTEXT_WINDOW_TOKENS} maxOutputTokens=${MAX_OUTPUT_TOKENS}`
    + ` derivedBudgetTokens=${DERIVED_BUDGET_TOKENS}`);

  const orchestratorPath = join(LOOP_DIR, "orchestrator.js");
  const orchestratorText = readFileSync(orchestratorPath, "utf8");
  const orchestratorBytes = statSync(orchestratorPath).size;
  const orchestratorTokens = estimateTokens(orchestratorText);
  console.log(`[long-task] source orchestratorBytes=${orchestratorBytes}`
    + ` estimatedTokens=${orchestratorTokens} srcLoopJsFiles=${collectLoopFiles().length}`);
  assert.ok(orchestratorTokens > DERIVED_BUDGET_TOKENS,
    "L1 source must exceed the naturally derived context budget");

  const failures = [];
  try {
    await runL1(gate);
    console.log("[long-task] PASS L1");
  } catch (error) {
    failures.push("L1");
    console.error(`[long-task] FAIL L1 error=${errorSummary(error, gate)}`);
  }
  if (!l1Only) {
    try {
      await runL2(gate);
    } catch (error) {
      failures.push("L2");
      console.error(`[long-task] FAIL L2 error=${errorSummary(error, gate)}`);
    }
  }
  if (failures.length > 0) {
    console.error(`[long-task] FAIL arms=${failures.join(",")}`);
    process.exitCode = 1;
    return;
  }
  console.log("[long-task] PASS all requested arms");
}

main().catch((error) => {
  console.error(`[long-task] FAIL error=${error?.code ?? error?.name ?? "unknown"}`
    + `: ${String(error?.message ?? "").slice(0, 240)}`);
  process.exitCode = 1;
});
