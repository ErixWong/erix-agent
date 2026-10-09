// issue #165：judge 记录关联字段的单一权威处（模型标识 + run 级 outcome 汇总记录形状）。
//
// 为什么需要它：judge 决策要成为 per-model 常设校准指标（blocked 率 / 误拦率 / extend ROI），
// 记录就必须能回答两个问题——**这条决策是哪个模型跑出来的**、**这个 run 最后怎么样了**。
// 此前 judge 记录里两者都没有：跨 run 无法按模型分组归因，blocked 的调用后来被证明是对是错
// 只能人工考古。
//
// 两条硬约束：
// 1. **additive**：只在既有 judge 记录上增字段，旧字段与语义一律不动（记录形状是宿主消费面，
//    AGENTS.md §6 已声明 judge.log 含 judge 决策字段）。
// 2. **不写假值**：模型名一律从 run 选项 / provider 配置里解析，探不到就**不写该字段**——
//    写 `"unknown"` 会让「没配模型」与「配了个叫 unknown 的模型」在账面上无法区分。
//
// outcome 采用 append-only 方案（①）：judge 决策是流式产生、终局才知道 outcome，若收尾时
// 回写该 run 的全部记录（方案 ②）就破掉了 JSONL 的 append-only 语义（宿主可能已在读）。
// 故每条决策记录带 `runId` 作 join 键，终局**追加**一条 run 级汇总记录，宿主按 `runId` join。

const MODEL_NAME_KEYS = ["model", "model_name"];
// 与 modelMetadataFor()（src/loop/budget.js:59-69）同一候选顺序：首个命中不合并。
const MODEL_NAME_SOURCES = ["modelConfig", "modelMetadata", "model", "provider", "context"];

function usableName(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 从一个「模型身份载体」（provider 实例、modelConfig 槽位、metadata 对象、裸模型名字符串）
 * 里取出实际模型标识。键顺序 `model` → `model_name`，与 provider 构造侧
 * `model ?? model_name`（src/providers/openai.js:154、anthropic.js:334）同口径。
 * 宿主自定义对象的 getter 抛错时按「探不到」处理——观测面绝不因日志字段而抛。
 * @param {unknown} source
 * @returns {string | undefined}
 */
export function resolveModelName(source) {
  const direct = usableName(source);
  if (direct !== undefined) return direct;
  if (source === null || typeof source !== "object") return undefined;
  for (const key of MODEL_NAME_KEYS) {
    try {
      const name = usableName(source[key]);
      if (name !== undefined) return name;
    } catch {
      // getter 抛错：当作该键不可用，继续下一个候选。
    }
  }
  return undefined;
}

/**
 * run 实际使用的模型标识：按 `modelMetadataFor()` 的候选顺序
 * （modelConfig → modelMetadata → model → provider → context）探测，首个探到非空模型名的
 * 候选胜出且**不合并**（与已文档化的 duck-type 口径一致，避免两处漂移）。
 * @param {{modelConfig?:unknown, modelMetadata?:unknown, model?:unknown, provider?:unknown, context?:unknown}} sources
 * @returns {string | undefined}
 */
export function resolveRunModelName(sources = {}) {
  for (const key of MODEL_NAME_SOURCES) {
    let name;
    try {
      name = resolveModelName(sources?.[key]);
    } catch {
      name = undefined;
    }
    if (name !== undefined) return name;
  }
  return undefined;
}

function identityField(key, value) {
  const name = usableName(value);
  return name === undefined ? {} : { [key]: name };
}

/**
 * 每条 judge 记录上的关联字段（additive）：
 * - `runId`：把流式决策与 run 级 outcome 汇总记录 join 起来的键（宿主没给 runId 就不写）；
 * - `model`：被评决策发生时 run 实际使用的模型标识（探不到就不写）；
 * - `judgeModel`：仅当 judge 走了**另一个** evaluator 模型时出现——per-model 校准要能区分
 *   「被评的模型」与「评它的那个模型」；与 run 模型同名时缺省，避免冗余字段。
 * @param {{runId?:unknown, model?:unknown, judgeModel?:unknown}} input
 * @returns {Record<string, string>}
 */
export function judgeRecordFields({ runId, model, judgeModel } = {}) {
  const runModel = usableName(model);
  const evaluatorModel = usableName(judgeModel);
  return {
    ...identityField("runId", runId),
    ...identityField("model", runModel),
    ...(evaluatorModel === undefined || evaluatorModel === runModel
      ? {}
      : identityField("judgeModel", evaluatorModel)),
  };
}

/**
 * run 级 outcome 汇总记录（方案 ①：追加而非回写）。判别键：judge 决策记录带 `kind`
 * （`round`/`intercept`），本记录带 `type: "run_outcome"` 且**不带** `kind`/`action`——
 * 宿主与聚合脚本据此把两类记录分流，决策流的计数语义不受影响。
 *
 * 载荷刻意克制：只交付「这个 run 的终局裁决」，run 级 usage/成本仍走 `result.usage`
 * 与宿主自己的账务通道，不在日志里制造第二套口径。
 * @param {{runId?:unknown, model?:unknown, judgeModel?:unknown, rounds?:unknown,
 *   judgeRecordCount?:unknown, termination?:object, verification?:object}} input
 */
export function runOutcomeRecord(input = {}) {
  const { termination, verification, rounds, judgeRecordCount } = input;
  return {
    type: "run_outcome",
    ...judgeRecordFields(input),
    ...(Number.isSafeInteger(rounds) ? { rounds } : {}),
    ...(Number.isSafeInteger(judgeRecordCount) ? { judgeRecordCount } : {}),
    // 终局对象原样带出（reason/detail/errorCode/forcedFinal/operation 等按既有口径存在与否）。
    ...(termination && typeof termination === "object" && !Array.isArray(termination)
      ? { termination: { ...termination } }
      : {}),
    ...(verification && typeof verification === "object" && !Array.isArray(verification)
      ? { verification: { ...verification } }
      : {}),
  };
}
