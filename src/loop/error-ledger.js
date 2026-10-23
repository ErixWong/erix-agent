// 错误清单（issue #109 第 1 步）：把 run 期间"没存上"的事实列成清单，
// 挂在 result.unpersisted 上——持久化失败不再静默。
//
// 刻意保持简单：一个数组包装器 + 错误消息 500 字符上限（防 result 被超长
// 异常消息撑爆，与 run-state 64KB 上限同类）+ 上限溢出申报。不做脱敏仪式、
// 不做防篡改——清单与 result 同属宿主信任域（ADR-009）。

const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_LEDGER_ENTRIES = 100;
// issue #439：`error.phase` 的长度上限。口径与 run-state 的 `safeText(entry.phase, 32)` 相同
// （`src/run-state.js`）：宿主的错误对象也进这条通道，不许一条异常把 result 撑大。
//
// ⚠ 本文件是 `test/tools/file-tools.test.js` 的 #271 行容量写死样本。下面这两处注释按该测试
// 自己的口径复测后，样本中位从 7,117 掉到 6,952（−2.3%，越过 ±2%）——连带按仓内既定口径刷新了
// `readFile` 的模型可见描述（`src/tools/file-tools.js` 的 `median` 档）与 #271 的 `median` 记录值
// （`src/tools/registry.js` → `src/tools/notes.js`）。下次再改本文件，同样先看那条断言。
const MAX_ERROR_PHASE_LENGTH = 32;

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

// 错误统一收成 {name, message}（+ issue #439 的加法键 phase）：截断 + 去掉 stack（堆栈含本机路径
// 且可能很长）。
//
// issue #439（加法面）：`error.phase` **原样保留**。provider 的错误对象（`KitError`，
// `src/providers/errors.js`）上本来就带 `phase`（`"request"` / `"stream"` / `"streamTotal"`，
// 由 `src/providers/timeout.js` 与两个协议适配器打上），而归一化到 `{name, message}` 时它被丢了 ⇒
// 宿主在账本里无法区分「请求没发出去」与「流中间断了」，而这两类可重试性不同（#441 依赖这个判断）。
// 口径：取不到（无键 / 非字符串 / 空串）就**缺键**——不写 `phase: undefined`，不猜值。
function capError(error) {
  const raw = phaseOf(error);
  return {
    name: String(error?.name ?? "Error"),
    message: capErrorMessage(error),
    ...(raw === "" ? {} : { phase: Array.from(raw).slice(0, MAX_ERROR_PHASE_LENGTH).join("") }),
  };
}

/**
 * 读 `error.phase`（issue #439）。
 *
 * 抛异常的 getter 不许把 `record()` 顶出去：`phase` 是本单**新增**的读取面，兜住它，风险面就与
 * 改动前一样大（`name` / `message` 那两处既有读取一字未动，它们本来就会读 getter）。
 * @param {any} error
 * @returns {string} 压平空白后的 phase；取不到就是空串
 */
function phaseOf(error) {
  let value;
  try {
    value = error?.phase;
  } catch {
    return "";
  }
  return typeof value === "string" ? value.replaceAll(/\s+/gu, " ").trim() : "";
}

export function createErrorLedger() {
  const entries = [];
  const index = new Map();
  let dropped = 0;

  // 去重键：同一端口同一操作反复失败（如每轮都写失败）不刷屏，累计在 repeat 上。
  // delivery_failure 还要把 failedEvent 身份入键：同一错误消息、不同出事事件
  // 是两条不同的账（2026-09-18 全面评审 m6）。
  function dedupKey(entry) {
    return [
      entry.kind,
      entry.port,
      entry.operation,
      entry.phase,
      entry.fatal === true,
      entry.error?.name,
      entry.error?.message,
      // issue #439：错误自身的阶段也是身份的一部分——同消息、同持久化阶段，但一次是「请求没发出去」、
      // 一次是「流中间断了」，不是同一个失败（可重试性不同）。既有条目里这个位置恒为空串
      // （`capError` 在此之前丢掉了 `error.phase`）⇒ 对**已有**去重结果零影响。
      entry.error?.phase,
      entry.failedEvent
        ? [entry.failedEvent.type, entry.failedEvent.port, entry.failedEvent.operation, entry.failedEvent.phase].join("\u0000")
        : "",
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
