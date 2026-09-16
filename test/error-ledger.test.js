import assert from "node:assert/strict";
import test from "node:test";

import {
  LEDGER_LIMITS,
  capErrorMessage,
  createErrorLedger,
} from "../src/loop/error-ledger.js";

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
