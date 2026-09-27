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
      /revoke/u,
    );
    assert.throws(
      () => assertNotesStore({
        write() {}, read() {}, list() {}, complete() {}, revoke() {},
      }),
      /purge/u,
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
    // 契约收窄（ADR-018 D3 决策反转）：list 返回朴素数组；不给 limit =
    // 全部匹配记录，给了 limit 钳制最大 200。
    const all = await store.list({ scope: "run", scopeRef: RECORD.scopeRef });
    assert.deepEqual(all, [RECORD]);
    assert.equal(Array.isArray(all), true);
    const limited = await store.list({ scope: "run", scopeRef: RECORD.scopeRef, limit: 5000 });
    assert.deepEqual(limited, [RECORD], "limit 超过 200 钳制后仍是全量结果");
  });

  test(`${label}: missing records are explicit and scopes are isolated`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    assert.equal(
      await store.read({ scope: "run", scopeRef: "contract-run", key: "missing" }),
      undefined,
    );
    const empty = await store.list({ scope: "run", scopeRef: "other-run" });
    assert.deepEqual(empty, []);
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

    // legacy done 记录（expires_at 久远过去）：expires_at 是历史遗留字段，
    // purge 不读它；scope 时钟（最新文件写入）仍在保留期内 → 记录保留。
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
    // purge（ADR-018 D7 scope 时钟）：刚写入的 scope 全部豁免。
    const purged = await store.purge({ scope: "run", scopeRef: "live-scope" });
    assert.equal(purged.status, "found");
    assert.equal(purged.purged, 0, "保留期内的 scope 一条不删（含 legacy done）");
    assert.equal(
      (await store.read({ scope: "run", scopeRef: legacyScopeRef, key: "legacy" }))?.state,
      "done",
    );
    for (const [index] of unsafeScopes.entries()) {
      const read = await store.read({
        scope: "run", scopeRef: `run-h-${createHash("sha256").update(unsafeScopes[index]).digest("hex").slice(0, 24)}`, key: `unsafe-${index}`,
      });
      assert.equal(read.state, "done", "保留期内的 done 记录不被 purge 删除");
    }
    await assert.rejects(
      store.purge({ before: "not-a-date" }),
      /parseable date/u,
    );
  });

  test(`${label}: revoke writes a tombstone with expected-state guards`, async () => {
    const store = await createStore();
    assertNotesStore(store);
    await store.write({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      record: RECORD,
    });
    assert.deepEqual(
      await store.revoke({ scope: "run", scopeRef: RECORD.scopeRef, key: "missing" }),
      { status: "missing", revoked: 0 },
    );
    // expectedState 不匹配 → unchanged，不写入。
    assert.deepEqual(
      await store.revoke({
        scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key, expectedState: "done",
      }),
      { status: "unchanged", revoked: 0 },
    );
    // expectedUpdatedAt 不匹配（检查后被他人改写）→ unchanged，不写入。
    assert.deepEqual(
      await store.revoke({
        scope: "run",
        scopeRef: RECORD.scopeRef,
        key: RECORD.key,
        expectedState: "active",
        expectedUpdatedAt: "2099-01-01T00:00:00.000Z",
      }),
      { status: "unchanged", revoked: 0 },
    );
    assert.equal(
      (await store.read({ scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key })).state,
      "active",
    );
    const revoked = await store.revoke({
      scope: "run",
      scopeRef: RECORD.scopeRef,
      key: RECORD.key,
      reason: "test",
      expectedState: "active",
      expectedUpdatedAt: RECORD.updated_at,
    });
    assert.equal(revoked.status, "found");
    assert.equal(revoked.revoked, 1);
    const tombstone = await store.read({
      scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key,
    });
    assert.equal(tombstone.state, "revoked");
    assert.ok(tombstone.revoked_at);
    // 已是墓碑 → unchanged。
    assert.deepEqual(
      await store.revoke({ scope: "run", scopeRef: RECORD.scopeRef, key: RECORD.key }),
      { status: "unchanged", revoked: 0 },
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
