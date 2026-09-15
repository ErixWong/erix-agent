import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { assertNotesStore } from "../../src/store/notes.js";

const RECORD = {
  key: "answer",
  scope: "run",
  scopeRef: "contract-run",
  current: {
    content: "current",
    provenance: { source: "auto", verified: false },
    ts: "2026-09-15T00:00:00.000Z",
  },
  superseded: [{
    content: "old",
    invalid: true,
    provenance: { source: "agent" },
    ts: "2026-09-14T00:00:00.000Z",
  }],
  folded: 2,
  pinned: true,
  tags: ["value", "auto"],
  relevance: 0.8,
  state: "active",
  created_at: "2026-09-14T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
  extension: { preserved: true },
};

/**
 * @param {string} label implementation name
 * @param {() => object | Promise<object>} createStore clean store factory
 */
export function notesStoreContract(label, createStore) {
  test(`${label}: rejects a port with missing methods`, () => {
    assert.throws(
      () => assertNotesStore({ write() {}, read() {}, list() {}, complete() {} }),
      /janitor/u,
    );
  });

  test(`${label}: rejects malformed records before persistence`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await assert.rejects(
      store.write({
        scope: "run",
        scopeRef: "contract-run",
        key: "answer",
        record: { ...RECORD, current: "not-an-object" },
      }),
      /valid NoteRecord/u,
    );
  });

  test(`${label}: write/read preserves the complete record shape`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await store.write({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      record: RECORD,
    });
    assert.deepEqual(
      await store.read({ scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key }),
      RECORD,
    );
    assert.deepEqual(
      await store.list({ scope: "run", scopeRef: RECORD.scopeRef }),
      [RECORD],
    );
  });

  test(`${label}: missing records are explicit and scopes are isolated`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    assert.equal(
      await store.read({ scope: "run", scopeRef: "contract-run", key: "missing" }),
      undefined,
    );
    assert.deepEqual(
      await store.list({ scope: "run", scopeRef: "other-run" }),
      [],
    );
  });

  test(`${label}: unsafe scopes round-trip through canonical storage and lifecycle`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    const unsafeScopes = ["../escape", "/tmp/absolute", "a%2fb"];
    for (const [index, scopeRef] of unsafeScopes.entries()) {
      const canonicalScopeRef = `run-h-${createHash("sha256").update(scopeRef).digest("hex").slice(0, 24)}`;
      const record = { ...RECORD, key: `unsafe-${index}`, scopeRef };
      await store.write({
        scope: "run",
        scopeRef,
        key: record.key,
        record,
      });
      const read = await store.read({ scope: "run", scopeRef, key: record.key });
      assert.equal(read.scopeRef, canonicalScopeRef);
      assert.deepEqual(
        (await store.list({ scope: "run", scopeRef })).map((entry) => entry.scopeRef),
        [canonicalScopeRef],
      );
      assert.deepEqual(
        (await store.list({ scope: "run", scopeRef: canonicalScopeRef })).map((entry) => entry.scopeRef),
        [canonicalScopeRef],
      );
      assert.deepEqual(
        await store.complete({ scope: "run", scopeRef }),
        { status: "found", completed: 1 },
      );
      assert.equal(
        (await store.read({ scope: "run", scopeRef: canonicalScopeRef, key: record.key })).state,
        "done",
      );
    }

    const legacyScopeRef = `run-h-${createHash("sha256").update("../legacy").digest("hex").slice(0, 24)}`;
    await store.write({
      scope: "run",
      scopeRef: legacyScopeRef,
      key: "legacy",
      record: {
        ...RECORD,
        key: "legacy",
        scopeRef: legacyScopeRef,
        state: "done",
        expires_at: "2020-01-01T00:00:00.000Z",
      },
    });
    assert.equal(
      (await store.list({ scope: "run", scopeRef: legacyScopeRef })).length,
      1,
    );
    assert.deepEqual(
      await store.janitor({ scope: "run", scopeRef: "live-scope" }),
      { status: "found", changed: 1, revoked: 1 },
    );
    assert.equal(
      (await store.read({ scope: "run", scopeRef: legacyScopeRef, key: "legacy" })).state,
      "revoked",
    );
  });

  // This documents the one-writer limitation: concurrent RMW updates are LWW,
  // but must still leave one valid record rather than corrupting the file.
  test(`${label}: concurrent same-key updates are last-write-wins`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await store.write({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      record: RECORD,
    });
    const base = await store.read({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
    });
    const updates = ["left", "right"].map((content) => ({
      ...base,
      current: { ...base.current, content },
      updated_at: `2026-09-15T00:00:0${content === "left" ? "1" : "2"}.000Z`,
    }));
    await Promise.all(updates.map((record) => store.write({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      record,
    })));
    const final = await store.read({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
    });
    assert.ok(["left", "right"].includes(final.current.content));
    assert.equal(final.key, RECORD.key);
  });
}
