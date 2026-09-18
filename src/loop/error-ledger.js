// 错误清单（issue #109 第 1 步）：把 run 期间"没存上"的事实列成清单，
// 挂在 result.unpersisted 上——持久化失败不再静默。
//
// 刻意保持简单：一个数组包装器 + 错误消息 500 字符上限（防 result 被超长
// 异常消息撑爆，与 run-state 64KB 上限同类）+ 上限溢出申报。不做脱敏仪式、
// 不做防篡改——清单与 result 同属宿主信任域（ADR-009）。

const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_LEDGER_ENTRIES = 100;

export const LEDGER_LIMITS = Object.freeze({
  errorMessageLength: MAX_ERROR_MESSAGE_LENGTH,
  // 真实条目上限；toUnpersisted 输出最多 maxEntries + 1（末尾为 overflow 申报）。
  maxEntries: MAX_LEDGER_ENTRIES,
});

export function capErrorMessage(error) {
  const raw = String(error?.message ?? error ?? "");
  if (raw.length <= MAX_ERROR_MESSAGE_LENGTH) return raw;
  return `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… [truncated ${raw.length - MAX_ERROR_MESSAGE_LENGTH} chars]`;
}

// 错误统一收成 {name, message}：截断 + 去掉 stack（堆栈含本机路径且可能很长）。
function capError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: capErrorMessage(error),
  };
}

export function createErrorLedger() {
  const entries = [];
  const index = new Map();
  let dropped = 0;

  // 去重键：同一端口同一操作反复失败（如每轮都写失败）不刷屏，累计在 repeat 上。
  function dedupKey(entry) {
    return [
      entry.kind,
      entry.port,
      entry.operation,
      entry.phase,
      entry.fatal === true,
      entry.error?.name,
      entry.error?.message,
    ].join("\u0000");
  }

  return {
    /** 记一条“没存上”。错误统一截断；其余字段原样保留（调用方自己的数据）。 */
    record(entry = {}) {
      const record = {
        ts: entry.ts ?? new Date().toISOString(),
        kind: entry.kind ?? "persistence_error",
        ...entry,
        error: capError(entry.error),
      };
      const key = dedupKey(record);
      const existing = index.get(key);
      if (existing !== undefined) {
        // 重复失败：只涨计数与最后发生时间，不新增条目
        existing.repeat += 1;
        existing.lastTs = record.ts;
        return true;
      }
      if (entries.length >= MAX_LEDGER_ENTRIES) {
        dropped += 1;
        return false;
      }
      record.repeat = 1;
      entries.push(record);
      index.set(key, record);
      return true;
    },

    /**
     * 报告通道自身失败（diagnostics.error / onPersistenceError 抛错）：
     * 错误发生了但事件没送出去——这条也必须留痕。
     * port 恒为 "diagnostics"（坏掉的是交付通道）；出事的端口在 failedEvent.port。
     */
    recordDeliveryFailure({ event, error } = {}) {
      return this.record({
        kind: "delivery_failure",
        port: "diagnostics",
        operation: "diagnostics.error",
        fatal: event?.fatal ?? false,
        error,
        ...(event !== undefined
          ? {
              failedEvent: {
                ...(event.type !== undefined ? { type: event.type } : {}),
                ...(event.port !== undefined ? { port: event.port } : {}),
                ...(event.operation !== undefined ? { operation: event.operation } : {}),
                ...(event.phase !== undefined ? { phase: event.phase } : {}),
              },
            }
          : {}),
      });
    },

    /** 序列化为 result.unpersisted；溢出时末尾追加申报条目。 */
    toUnpersisted() {
      const out = entries.map((entry) => ({ ...entry }));
      if (dropped > 0) {
        out.push({ ts: new Date().toISOString(), kind: "ledger_overflow", port: "diagnostics", dropped, fatal: false });
      }
      return out;
    },

    get size() {
      return entries.length;
    },
  };
}
