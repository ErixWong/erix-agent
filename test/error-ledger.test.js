import assert from "node:assert/strict";
import test from "node:test";

import {
  LEDGER_LIMITS,
  capErrorMessage,
  createErrorLedger,
} from "../src/loop/error-ledger.js";
import { KitError } from "../src/providers/errors.js";

test("capErrorMessage truncates over-long messages with an audit marker", () => {
  const out = capErrorMessage({ message: "x".repeat(2000) });
  assert.equal(out.length, LEDGER_LIMITS.errorMessageLength + "… [truncated 1500 chars]".length);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.ok(out.includes("[truncated 1500 chars]"));
  assert.equal(capErrorMessage(undefined), "");
  assert.equal(capErrorMessage("plain string"), "plain string");
});

test("record caps the error uniformly: Error instances and plain objects both get {name, message}", () => {
  const ledger = createErrorLedger();
  const boom = new Error("disk on fire");
  boom.stack = "Error: disk on fire\n    at /home/some/path/file.js:1:1";
  ledger.record({ port: "transcript", operation: "appendRound", fatal: true, error: boom });
  ledger.record({
    port: "transcript",
    operation: "appendRound",
    fatal: true,
    error: { name: "Error", message: "y".repeat(600), stack: "forged stack" },
  });
  const [first, second] = ledger.toUnpersisted();
  assert.equal(first.error.message, "disk on fire");
  assert.equal(first.error.stack, undefined);
  assert.equal(second.error.message.length, LEDGER_LIMITS.errorMessageLength + "… [truncated 100 chars]".length);
  assert.equal(second.error.stack, undefined);
});

test("delivery failures are recorded with the failed event identity", () => {
  const ledger = createErrorLedger();
  ledger.recordDeliveryFailure({
    event: { type: "persistence_error", port: "notes", operation: "write", phase: "notes", fatal: false },
    error: new Error("sink exploded"),
  });
  const [entry] = ledger.toUnpersisted();
  assert.equal(entry.kind, "delivery_failure");
  assert.equal(entry.port, "diagnostics", "port 恒为交付通道");
  assert.equal(entry.operation, "diagnostics.error");
  assert.equal(entry.fatal, false);
  assert.equal(entry.error.message, "sink exploded");
  assert.deepEqual(entry.failedEvent, {
    type: "persistence_error",
    port: "notes",
    operation: "write",
    phase: "notes",
  });
});

test("repeated identical failures are counted on one entry, not duplicated (issue #109 修正 4)", () => {
  const ledger = createErrorLedger();
  for (let index = 0; index < 30; index += 1) {
    ledger.record({
      port: "notes",
      operation: "note_write",
      phase: "tool",
      error: new Error("disk full"),
    });
  }
  const entries = ledger.toUnpersisted();
  assert.equal(entries.length, 1, "同一失败只占一条");
  assert.equal(entries[0].repeat, 30);
  assert.equal(entries[0].error.message, "disk full");
  assert.ok(entries[0].lastTs >= entries[0].ts);

  // 不同操作/端口/错误消息各自成条
  ledger.record({ port: "notes", operation: "note_read", error: new Error("disk full") });
  ledger.record({ port: "notes", operation: "note_write", error: new Error("permission denied") });
  assert.equal(ledger.toUnpersisted().length, 3);
});

test("ledger caps entries and reports the overflow explicitly", () => {
  const ledger = createErrorLedger();
  for (let i = 0; i < LEDGER_LIMITS.maxEntries + 5; i += 1) {
    const accepted = ledger.record({ port: "notes", operation: `op-${i}`, fatal: false, error: new Error(`e${i}`) });
    assert.equal(accepted, i < LEDGER_LIMITS.maxEntries);
  }
  assert.equal(ledger.size, LEDGER_LIMITS.maxEntries);
  const out = ledger.toUnpersisted();
  assert.equal(out.length, LEDGER_LIMITS.maxEntries + 1);
  const overflow = out.at(-1);
  assert.equal(overflow.kind, "ledger_overflow");
  assert.equal(overflow.dropped, 5);
});

test("toUnpersisted returns an empty array by default and never hands out the internal array", () => {
  const ledger = createErrorLedger();
  const empty = ledger.toUnpersisted();
  assert.deepEqual(empty, []);
  empty.push({ junk: true }); // 基本封装：外部拿到的不是内部数组本身
  assert.deepEqual(ledger.toUnpersisted(), []);
});

// ── issue #439 B：错误账保留错误对象自带的 `phase` ────────────────────────────────
//
// 病根：`capError` 把错误统一收成 `{name, message}`，而 provider 错误（`KitError`）上本来就带
// `phase`（`"request"` / `"stream"`，见 `src/providers/errors.js` 与 `src/providers/timeout.js`）⇒
// 「请求没发出去」与「流中间断了」在账本里长得一模一样，而这两类可重试性不同（#441）。
// 口径：`phase` 从 `error.phase` 取，取不到就**缺键**（不写 `undefined`、不猜 `unknown` 以外的值）。
test("#439 record: 错误对象自带 `phase` 时账本条目保留它（request / stream 可分）", () => {
  const ledger = createErrorLedger();
  ledger.record({
    port: "transcript",
    operation: "appendRound",
    phase: "transcript",
    fatal: true,
    error: new KitError("timeout", "request timed out", { phase: "request" }),
  });
  const [entry] = ledger.toUnpersisted();
  assert.equal(entry.error.phase, "request", "provider 错误上的 phase 不得在归一化时丢掉");
  assert.equal(entry.phase, "transcript", "条目级 phase（持久化阶段）语义不变，不被 error.phase 覆盖");
  assert.deepEqual(Object.keys(entry.error).sort(), ["message", "name", "phase"]);
});

test("#439 record: 错误对象没有 `phase` ⇒ 条目 `error` 缺键（不写 undefined、不猜值）", () => {
  const ledger = createErrorLedger();
  ledger.record({ port: "notes", operation: "note_write", fatal: false, error: new Error("disk full") });
  ledger.record({
    port: "notes",
    operation: "note_read",
    fatal: false,
    error: { name: "Error", message: "permission denied", phase: "" },
  });
  const [plain, emptyPhase] = ledger.toUnpersisted();
  assert.deepEqual(Object.keys(plain.error), ["name", "message"], "无 phase ⇒ 只有既有两键");
  assert.equal(Object.hasOwn(plain.error, "phase"), false, "不得写 `phase: undefined`");
  assert.equal(Object.hasOwn(emptyPhase.error, "phase"), false, "空串不是 phase（缺键，不猜 unknown）");
});

test("#439 record: 去重身份包含 error.phase —— 同消息不同阶段是两条账", () => {
  const ledger = createErrorLedger();
  for (const phase of ["request", "stream", "request"]) {
    ledger.record({
      port: "transcript",
      operation: "appendRound",
      phase: "transcript",
      fatal: true,
      error: new KitError("disconnect", "socket closed", { phase }),
    });
  }
  const entries = ledger.toUnpersisted();
  assert.equal(entries.length, 2, "同 message 不同 error.phase 不得被去重成一条（可重试性不同）");
  assert.deepEqual(entries.map((entry) => [entry.error.phase, entry.repeat]), [["request", 2], ["stream", 1]]);
});

// issue #439 评审退回项：`phase` 是本单**新增**的读取面。抛异常的 getter 若把 `record()` 顶出去，
// 错误账本自己就成了新的失败源（记一条失败反而让调用方崩）。兜住它 ⇒ 缺键，风险面与改动前一样大。
test("#439 record: `error.phase` 的 getter 抛异常 ⇒ 条目仍入账、`error` 缺 `phase`（不把 record 顶出去）", () => {
  const ledger = createErrorLedger();
  const hostile = {
    name: "Error",
    message: "disk full",
    get phase() {
      throw new Error("getter exploded");
    },
  };
  assert.equal(ledger.record({ port: "notes", operation: "note_write", fatal: false, error: hostile }), true,
    "抛异常的 getter 不得让 record() 抛出或拒收这条账");
  const [entry] = ledger.toUnpersisted();
  assert.equal(entry.error.message, "disk full");
  assert.equal(Object.hasOwn(entry.error, "phase"), false, "取不到 phase ⇒ 缺键，不猜值");
});

// issue #439 第二轮评审退回项：契约把 `error.phase` 的**对外口径**写成「压平空白、截到 32 字符」，
// 但当时这三条只有契约文字、没有判据（评审把 `MAX_ERROR_PHASE_LENGTH` 32 → 33，全量 2082 / 零红）。
// 下面三格把契约的每一句都钉住——对外数字、压平、以及「取不到就完全没有这个键」。
test("#439 record: `error.phase` 截到 32 字符（对外口径；评审把常量改成 33 时这一格必须红）", () => {
  const ledger = createErrorLedger();
  ledger.record({
    port: "transcript",
    operation: "appendRound",
    fatal: true,
    error: { name: "KitError", message: "boom", phase: "p".repeat(33) },
  });
  const [entry] = ledger.toUnpersisted();
  assert.equal(entry.error.phase.length, 32, "契约写的上限就是 32 字符");
  assert.equal(entry.error.phase, "p".repeat(32), "截的是尾部，不是随机 32 个字符");
});

test("#439 record: `error.phase` 里的换行/连续空白压平成单空格（`stream\\nrequest` ⇒ `stream request`）", () => {
  const ledger = createErrorLedger();
  ledger.record({
    port: "transcript",
    operation: "appendRound",
    fatal: true,
    error: new KitError("timeout", "stream timed out", { phase: "stream\nrequest" }),
  });
  ledger.record({
    port: "transcript",
    operation: "appendRound",
    fatal: false,
    error: { name: "KitError", message: "stream timed out", phase: "  stream \n\t request  " },
  });
  const [crlf, padded] = ledger.toUnpersisted();
  assert.equal(crlf.error.phase, "stream request", "换行必须压成单空格（否则宿主拿去分类会漏）");
  assert.equal(padded.error.phase, "stream request", "首尾空白与连续空白都压平");
  assert.equal(padded.repeat, 1, "压平后两条的 error.phase 相同、但 fatal 不同 ⇒ 仍是两条账");
});

test("#439 record: `42` / `null` / 缺键的 `error.phase` ⇒ 完全没有 `phase` 键（不写 `phase: undefined`）", () => {
  const ledger = createErrorLedger();
  // 三条必须各自成账（operation 不同），否则去重会把它们并成一条，后两条就看不见了。
  ledger.record({ port: "notes", operation: "note_write", fatal: false, error: { name: "Error", message: "boom", phase: 42 } });
  ledger.record({ port: "notes", operation: "note_read", fatal: false, error: { name: "Error", message: "boom", phase: null } });
  ledger.record({ port: "notes", operation: "note_purge", fatal: false, error: { name: "Error", message: "boom" } });
  const entries = ledger.toUnpersisted();
  assert.equal(entries.length, 3, "三格必须各自入账（否则这一格测不到全部三条路径）");
  for (const entry of entries) {
    assert.equal(Object.hasOwn(entry.error, "phase"), false,
      `非字符串 / null / 缺键都不许产出 phase 键，实测 ${JSON.stringify(entry.error)}`);
    assert.equal("phase" in entry.error, false, "连 `phase: undefined` 都不许出现（宿主会把它当「有阶段」）");
    assert.deepEqual(Object.keys(entry.error).sort(), ["message", "name"], "只有既有两键");
  }
});

// 顺手登记（契约里已写明）：32 字符这个上限**不是** `LEDGER_LIMITS` 的成员 ⇒ 宿主读不到它。
// 谁要是把它加进去（或把 `errorMessageLength` / `maxEntries` 改名），这一格先红——那是对外口径的变更，
// 不是内部重构。
test("#439 LEDGER_LIMITS 只有 `errorMessageLength` / `maxEntries`（phase 的 32 字符上限刻意不在里面）", () => {
  assert.deepEqual(Object.keys(LEDGER_LIMITS).sort(), ["errorMessageLength", "maxEntries"],
    "`error.phase` 的上限是契约口径，不是宿主可读的常量");
});
