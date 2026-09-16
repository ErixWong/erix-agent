import assert from "node:assert/strict";
import test from "node:test";

import {
  LEDGER_LIMITS,
  createErrorLedger,
  sanitizeErrorMessage,
} from "../src/loop/error-ledger.js";

test("sanitizeErrorMessage truncates over-long messages with an audit marker", () => {
  const long = "x".repeat(2000);
  const out = sanitizeErrorMessage({ name: "Error", message: long });
  assert.equal(out.length, LEDGER_LIMITS.errorMessageLength + "… [truncated 1500 chars]".length);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.ok(out.includes("[truncated 1500 chars]"));
  assert.equal(sanitizeErrorMessage(undefined), "");
  assert.equal(sanitizeErrorMessage("plain string"), "plain string");
});

test("ledger records sanitized persistence errors and strips stack traces", () => {
  const ledger = createErrorLedger();
  const boom = new Error("disk on fire");
  boom.stack = "Error: disk on fire\n    at /home/sensitive/path/file.js:1:1";
  ledger.record({
    port: "transcript",
    operation: "appendRound",
    phase: "transcript",
    fatal: true,
    error: boom,
  });
  const [entry] = ledger.toUnpersisted();
  assert.equal(entry.kind, "persistence_error");
  assert.equal(entry.port, "transcript");
  assert.equal(entry.operation, "appendRound");
  assert.equal(entry.phase, "transcript");
  assert.equal(entry.fatal, true);
  assert.equal(entry.error.message, "disk on fire");
  assert.equal(entry.error.stack, undefined, "ledger entries must not carry stack traces");
  assert.ok(entry.ts);
});

test("ledger rejects unknown kinds and ports instead of degrading silently", () => {
  const ledger = createErrorLedger();
  assert.throws(
    () => ledger.record({ kind: "mystery", port: "notes", error: new Error("x") }),
    /unknown error ledger entry kind/,
  );
  assert.throws(
    () => ledger.record({ port: "printer", error: new Error("x") }),
    /unknown error ledger port/,
  );
  assert.throws(
    () => ledger.record(null),
    /error ledger entry must be an object/,
  );
});

test("delivery failures are recorded with the failed event identity", () => {
  const ledger = createErrorLedger();
  ledger.recordDeliveryFailure({
    event: { type: "persistence_error", port: "notes", operation: "write", phase: "notes", fatal: false },
    error: new Error("sink exploded"),
  });
  const [entry] = ledger.toUnpersisted();
  assert.equal(entry.kind, "delivery_failure");
  assert.equal(entry.port, "notes");
  assert.equal(entry.operation, "diagnostics.error");
  assert.equal(entry.fatal, false);
  assert.equal(entry.error.message, "sink exploded");
  assert.deepEqual(entry.failedEvent, { type: "persistence_error", operation: "write", phase: "notes" });
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
  assert.ok(out
    .filter((entry) => entry.kind === "persistence_error")
    .every((entry) => !entry.error.message.includes("truncated")));
});

test("toUnpersisted returns a fresh empty array by default", () => {
  const ledger = createErrorLedger();
  const empty = ledger.toUnpersisted();
  assert.deepEqual(empty, []);
  empty.push({ tampered: true });
  assert.deepEqual(ledger.toUnpersisted(), []);
});
