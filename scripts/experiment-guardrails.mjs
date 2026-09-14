export const DEFAULT_MAX_CALLS = 40;

function clean(value) {
  const result = typeof value === "string" ? value.trim() : "";
  return result || undefined;
}

export function resolveExperimentModel({
  explicitModel,
  environment = process.env,
  config = {},
} = {}) {
  const explicit = clean(explicitModel);
  if (explicit) return { model: explicit, source: "--model" };

  const environmentModel = clean(environment.ERIX_EXPERIMENT_MODEL);
  if (environmentModel) {
    return { model: environmentModel, source: "ERIX_EXPERIMENT_MODEL" };
  }

  const configModel = clean(config?.slots?.default?.model ?? config?.model);
  if (configModel) {
    return { model: configModel, source: "slots.default.model" };
  }

  throw new Error(
    "未找到实验模型。请在 ~/.erix/config.json 的 slots.default.model 配置 model，"
    + "或用 --model <id> 指定，也可设置 ERIX_EXPERIMENT_MODEL。",
  );
}

export function plannedCallCount({ armCount, runs, modelCount = 1 }) {
  return armCount * runs * modelCount;
}

export function validateCostPlan({
  plannedCalls,
  maxCalls = DEFAULT_MAX_CALLS,
  confirmed = false,
}) {
  if (plannedCalls > maxCalls) {
    throw new Error(
      `计划调用数 ${plannedCalls} 超过 --max-calls ${maxCalls}。`
      + `如确需扩大上限，请显式使用 --max-calls ${plannedCalls}（仍需 --yes 确认）。`,
    );
  }
  return { dryRun: !confirmed };
}

function historicalMaximum(values) {
  const usable = values.filter((value) => Number.isFinite(value) && value >= 0);
  return usable.length === 0
    ? undefined
    : Math.max(...usable);
}

function historicalRows(result) {
  return Array.isArray(result?.aggregate)
    ? result.aggregate
    : Array.isArray(result?.batches)
      ? result.batches.flatMap((batch) => batch.aggregate ?? [])
      : [];
}

export function estimateHistoricalUsage(result, {
  plannedCalls = 0,
  concurrency = 1,
} = {}) {
  const rows = historicalRows(result);
  const inputPerCall = historicalMaximum(rows.map((row) => (
    row?.averages?.inputTokens ?? row?.averageInputTokens
  )));
  const outputPerCall = historicalMaximum(rows.map((row) => (
    row?.averages?.outputTokens ?? row?.averageOutputTokens
  )));
  const durationPerCall = historicalMaximum(rows.map((row) => (
    row?.averages?.wallTimeMs
      ?? row?.averageDurationMs
      ?? row?.averageWallTimeMs
  )));
  const safeConcurrency = Math.max(1, concurrency);
  return {
    inputPerCall,
    outputPerCall,
    durationPerCall,
    basis: "历史最大值（下限）",
    inputTokens: inputPerCall === undefined ? undefined : inputPerCall * plannedCalls,
    outputTokens: outputPerCall === undefined ? undefined : outputPerCall * plannedCalls,
    durationMs: durationPerCall === undefined
      ? undefined
      : durationPerCall * plannedCalls / safeConcurrency,
  };
}

function formatNumber(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "不可用";
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "不可用";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function formatCostPreview({
  model,
  modelSource,
  plannedCalls,
  armCount,
  runs,
  modelCount,
  maxCalls,
  estimate,
  confirmed = false,
}) {
  return [
    "实验成本预览（尚未发起模型调用）",
    `模型：${model}（来源：${modelSource}）`,
    `计划调用数：${plannedCalls}（${armCount} 臂 × ${runs} 次 × ${modelCount} 个模型）`,
    `基于${estimate.basis ?? "历史最大值（下限）"}的 token 预估：input ${formatNumber(estimate.inputTokens)} + output ${formatNumber(estimate.outputTokens)}`,
    `预计时长（下限）：${formatDuration(estimate.durationMs)}`,
    `硬上限：${maxCalls} 次（可用 --max-calls 调高）`,
    ...(!confirmed
      ? ["未提供 --yes，仅 dry-run；如确认成本，请重新加 --yes 执行。"]
      : []),
  ].join("\n");
}

export function summarizeUsage(runs = []) {
  const summary = {
    totalCalls: runs.length,
    successful: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  for (const run of runs) {
    if (run?.failed) summary.failed += 1;
    else summary.successful += 1;
    summary.inputTokens += Number(run?.inputTokens ?? run?.usage?.input_tokens ?? 0);
    summary.outputTokens += Number(run?.outputTokens ?? run?.usage?.output_tokens ?? 0);
  }
  return summary;
}

export function formatUsageSummary(runs) {
  const summary = summarizeUsage(runs);
  return [
    "实际消耗汇总",
    `总调用数：${summary.totalCalls}`,
    `成功：${summary.successful}，失败：${summary.failed}`,
    `input tokens：${summary.inputTokens.toLocaleString("en-US")}`,
    `output tokens：${summary.outputTokens.toLocaleString("en-US")}`,
  ].join("\n");
}

export function isQuotaOrAuthError(value) {
  return /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|quota|usage limit|not supported for current token|rate.?limit)/iu
    .test(String(value ?? ""));
}

export async function runFailFast(jobs, worker, {
  concurrency = 1,
  onResult,
} = {}) {
  const results = new Array(jobs.length);
  let nextIndex = 0;
  let stopped = false;
  let failure;

  async function consume() {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      try {
        const result = await worker(job, index);
        results[index] = result;
        await onResult?.(result, job, index);
        if (result?.failed) {
          stopped = true;
          failure = {
            job,
            result,
            message: result.error ?? result.stderr ?? "模型调用失败",
          };
        }
      } catch (error) {
        stopped = true;
        failure = { job, error, message: error?.message ?? String(error) };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), jobs.length) },
      () => consume(),
    ),
  );
  return {
    results: results.filter((result) => result !== undefined),
    stopped,
    failure,
  };
}
