import test from "node:test";
import assert from "node:assert/strict";

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
}

