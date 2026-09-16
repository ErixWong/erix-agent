// 统一错误账本（issue #109 第 1 步：账本与事件协议）。
//
// 职责：
// - 收集 run 期间所有持久化相关失败（含 diagnostics sink 自身失败）为结构化账目
// - 提供 result.unpersisted 的确定性序列化（排序、去重、上限、脱敏）
// - 不做 I/O；可靠性由消费方保证（run-state 持久化在后续步骤接入）
//
// 语义边界（评审裁定，勿回退）：
// - 账单与 diagnostics 事件是**可靠交付通道**；模型可见提示只是 advisory
// - 账单失败条目 ≠ best_effort：条目保证进入 result（run 正常返回时）或挂载在
//   终止异常上（run 异常终止时由后续步骤接线）

const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_LEDGER_ENTRIES = 100;

export const LEDGER_LIMITS = Object.freeze({
  errorMessageLength: MAX_ERROR_MESSAGE_LENGTH,
  maxEntries: MAX_LEDGER_ENTRIES,
});

const KINDS = new Set(["persistence_error", "delivery_failure", "ledger_overflow"]);
const PORTS = new Set(["transcript", "resource", "notes", "diagnostics", "resume"]);

export function sanitizeErrorMessage(error) {
  const raw = String(error?.message ?? error ?? "");
  if (raw.length <= MAX_ERROR_MESSAGE_LENGTH) return raw;
  return `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… [truncated ${raw.length - MAX_ERROR_MESSAGE_LENGTH} chars]`;
}

function sanitizeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: sanitizeErrorMessage(error),
  };
}

// Error 实例必须脱敏（去掉 stack、截断消息）；已是脱敏形状的普通对象原样保留。
function sanitizeErrorInput(error) {
  if (error instanceof Error || typeof error === "string" || error === undefined) {
    return sanitizeError(error);
  }
  if (isPlainObject(error) && typeof error.name === "string" && typeof error.message === "string") {
    return error;
  }
  return sanitizeError(error);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 账目归一化：未知 kind/port 视为编程错误，直接抛出（账本自身不能静默降级）。
function normalizeEntry(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("error ledger entry must be an object");
  }
  const { kind = "persistence_error", port, ...rest } = input;
  if (!KINDS.has(kind)) {
    throw new TypeError(`unknown error ledger entry kind: ${JSON.stringify(kind)}`);
  }
  if (!PORTS.has(port)) {
    throw new TypeError(`unknown error ledger port: ${JSON.stringify(port)}`);
  }
  return {
    kind,
    port,
    ...rest,
  };
}

export function createErrorLedger() {
  const entries = [];
  let dropped = 0;

  return {
    /** 记一条持久化失败。error 会被脱敏（消息截断、不携带 stack）。 */
    record(input) {
      if (!isPlainObject(input)) {
        throw new TypeError("error ledger entry must be an object");
      }
      const entry = normalizeEntry({
        ...input,
        error: sanitizeErrorInput(input?.error),
      });
      if (entries.length >= MAX_LEDGER_ENTRIES) {
        dropped += 1;
        return false;
      }
      const { error, ...rest } = entry;
      entries.push({
        ts: new Date().toISOString(),
        ...rest,
        ...(error !== undefined ? { error } : {}),
      });
      return true;
    },

    /**
     * diagnostics sink 自身失败：错误发生了但结构化事件没送出去。
     * 这是账本存在的核心理由——错误报告通道自己的降级也必须留痕。
     */
    recordDeliveryFailure({ event, error, port }) {
      return this.record({
        kind: "delivery_failure",
        port: port ?? event?.port ?? "diagnostics",
        operation: "diagnostics.error",
        fatal: event?.fatal ?? false,
        error,
        ...(event?.operation !== undefined ? { failedEvent: { type: event.type, operation: event.operation, phase: event.phase } } : {}),
      });
    },

    /** 序列化为 result.unpersisted；超出上限时以合成条目申报丢弃数量。 */
    toUnpersisted() {
      if (entries.length === 0) return [];
      const out = entries.map((entry) => ({ ...entry }));
      if (dropped > 0) {
        out.push({
          kind: "ledger_overflow",
          port: "diagnostics",
          dropped,
          fatal: false,
        });
      }
      return out;
    },

    get size() {
      return entries.length;
    },
  };
}
