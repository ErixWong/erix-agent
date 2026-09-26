import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createFileNotesStore,
  isNoteRecord,
} from "../../src/store/notes.js";
import { notesStoreContract } from "../contract/notes-store.js";
import * as notes from "../../src/tools/notes.js";

async function makeTempDirectory() {
  return mkdtemp(path.join(tmpdir(), "erix-notes-store-"));
}

notesStoreContract("file notes", async () => {
  const dir = await makeTempDirectory();
  return createFileNotesStore({ dir });
});

test("file notes round-trips the existing record format without dropping fields", async () => {
  const root = await makeTempDirectory();
  try {
    const scopeDirectory = path.join(root, "run", "fixture-run");
    const fixture = path.resolve("test/fixtures/notes/answer.json");
    await mkdir(scopeDirectory, { recursive: true });
    await cp(fixture, path.join(scopeDirectory, "answer.json"), { recursive: false });
    const store = createFileNotesStore({ dir: root });
    const record = await store.read({
      scope: "run",
      scopeRef: "fixture-run",
      key: "answer",
    });

    assert.ok(record);
    assert.equal(isNoteRecord(record, { key: "answer", scopeRef: "fixture-run" }), true);
    await store.write({
      scope: "run",
      scopeRef: "fixture-run",
      key: "answer",
      record,
    });
    assert.deepEqual(
      await store.read({ scope: "run", scopeRef: "fixture-run", key: "answer" }),
      record,
    );
    const persisted = JSON.parse(await readFile(
      path.join(scopeDirectory, "answer.json"),
      "utf8",
    ));
    assert.deepEqual(persisted, record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notes skill consumes an injected NotesStore instead of its file path", async () => {
  const root = await makeTempDirectory();
  try {
    const backing = createFileNotesStore({ dir: root });
    const calls = [];
    const notesStore = Object.fromEntries(
      ["write", "read", "list", "complete", "revoke", "janitor", "purge"].map((method) => [
        method,
        async (...args) => {
          calls.push(method);
          return backing[method](...args);
        },
      ]),
    );
    const scope = { runId: "port-run", notesDir: path.join(root, "unused"), notesStore };
    const saved = JSON.parse(await notes.note_take({
      key: "port-value",
      content: "through-port",
      __erix: scope,
    }));
    assert.equal(saved.status, "found");
    assert.equal(
      JSON.parse(await notes.note_read({ key: "port-value", __erix: scope })).value,
      "through-port",
    );
    assert.deepEqual(calls, ["read", "write", "read"]);
    assert.equal(await readFile(
      path.join(root, "run", "port-run", "port-value.json"),
      "utf8",
    ).then((value) => JSON.parse(value).current.content), "through-port");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notes skill passes unsafe scope references to the adapter without pre-canonicalizing", async () => {
  const root = await makeTempDirectory();
  try {
    const backing = createFileNotesStore({ dir: root });
    const scopeRef = "../escape";
    const canonicalScopeRef = `run-h-${createHash("sha256").update(scopeRef).digest("hex").slice(0, 24)}`;
    const seenScopes = [];
    const notesStore = Object.fromEntries(
      ["write", "read", "list", "complete", "revoke", "janitor", "purge"].map((method) => [
        method,
        async (request) => {
          seenScopes.push(request.scopeRef);
          return backing[method](request);
        },
      ]),
    );
    const scope = { runId: scopeRef, notesStore, notesDir: path.join(root, "unused") };

    assert.equal(JSON.parse(await notes.note_take({
      key: "unsafe",
      content: "through-port",
      __erix: scope,
    })).status, "found");
    assert.equal(JSON.parse(await notes.note_read({ key: "unsafe", __erix: scope })).value, "through-port");
    assert.equal(JSON.parse(await notes.note_list({ __erix: scope })).total, 1);
    assert.deepEqual(await notes.completeRun({ __erix: scope }), { status: "found", completed: 1 });
    const janitorResult = await notes.runNotesJanitor({ __erix: scope });
    assert.equal(janitorResult.status, "found");
    assert.equal(janitorResult.revoked, 0);
    assert.equal(janitorResult.nextCursor, null);
    assert.ok(seenScopes.length > 0);
    assert.ok(seenScopes.every((value) => value === scopeRef));
    assert.equal(
      (await readdir(path.join(root, "run")))[0],
      canonicalScopeRef,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withNotesEnv(updates, callback) {
  const names = Object.keys(updates);
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(updates)) process.env[name] = value;
  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function makeRecord(key, scopeRef, overrides = {}) {
  return {
    key,
    scope: "run",
    scopeRef,
    current: { content: "value", provenance: { source: "agent" }, ts: "2026-09-15T00:00:00.000Z" },
    superseded: [],
    folded: 0,
    tags: [],
    relevance: 0.5,
    state: "active",
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

test("janitor never reclaims foreign active notes, even with grace env set to zero", async () => {
  const root = await makeTempDirectory();
  const now = { value: Date.UTC(2026, 8, 27, 0, 0, 0) };
  try {
    await withNotesEnv({ ERIX_NOTES_GRACE_MS: "0" }, async () => {
      const store = createFileNotesStore({ dir: root, clock: () => now.value });
      // 另一个 run 的 active 记录：updated_at 远早于 grace 窗口，按旧启发式必被回收。
      const stale = new Date(now.value - 30 * 24 * 60 * 60 * 1000).toISOString();
      await store.write({
        scope: "run",
        scopeRef: "stale-run",
        key: "orphan",
        record: makeRecord("orphan", "stale-run", { updated_at: stale, created_at: stale }),
      });
      const result = await store.janitor({ scope: "run", scopeRef: "live-run" });
      assert.deepEqual(result, { status: "found", scanned: 1, revoked: 0, nextCursor: null });
      const record = await store.read({ scope: "run", scopeRef: "stale-run", key: "orphan" });
      assert.equal(record.state, "active", "active orphan 清理权归宿主 liveness，janitor 不得回收");
      assert.equal(record.updated_at, stale, "janitor 不得触碰 active 记录");
    });
    assert.equal(process.env.ERIX_NOTES_GRACE_MS, undefined, "env 必须还原，不得污染其他测试");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("janitor revokes expired done notes across scopes with limit/cursor pagination", async () => {
  const root = await makeTempDirectory();
  const now = { value: Date.UTC(2026, 8, 27, 0, 0, 0) };
  try {
    const store = createFileNotesStore({ dir: root, clock: () => now.value });
    const expired = new Date(now.value - 1000).toISOString();
    for (let index = 0; index < 5; index += 1) {
      await store.write({
        scope: "run",
        scopeRef: `done-run-${index}`,
        key: "note",
        record: makeRecord("note", `done-run-${index}`, {
          state: "done",
          expires_at: expired,
        }),
      });
    }
    // 未到期的 done 与 active 记录不处理。
    await store.write({
      scope: "run",
      scopeRef: "fresh-run",
      key: "fresh",
      record: makeRecord("fresh", "fresh-run", {
        state: "done",
        expires_at: new Date(now.value + 60_000).toISOString(),
      }),
    });
    await store.write({
      scope: "run",
      scopeRef: "fresh-run",
      key: "live",
      record: makeRecord("live", "fresh-run"),
    });

    let cursor;
    let totalRevoked = 0;
    const scannedPages = [];
    const cursors = [];
    do {
      const page = await store.janitor({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      scannedPages.push(page.scanned);
      cursors.push(page.nextCursor);
      totalRevoked += page.revoked;
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(scannedPages, [2, 2, 2, 1], "6 条记录 4 页（末页 1 条），fresh 两条也在扫描内");
    assert.deepEqual(cursors, [2, 4, 6, null], "nextCursor 恰好覆盖末尾时为 null");
    assert.equal(totalRevoked, 5, "只有 5 条过期 done 被 revoke");
    for (let index = 0; index < 5; index += 1) {
      assert.equal(
        (await store.read({ scope: "run", scopeRef: `done-run-${index}`, key: "note" })).state,
        "revoked",
      );
    }
    assert.equal(
      (await store.read({ scope: "run", scopeRef: "fresh-run", key: "fresh" })).state,
      "done",
    );
    assert.equal(
      (await store.read({ scope: "run", scopeRef: "fresh-run", key: "live" })).state,
      "active",
    );
    await assert.rejects(store.janitor({ limit: 0 }), /positive safe integer/u);
    await assert.rejects(store.janitor({ cursor: -1 }), /non-negative safe integer/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revoke leaves a changed record untouched (expectedUpdatedAt guard)", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    await store.write({
      scope: "run",
      scopeRef: "guard-run",
      key: "guarded",
      record: makeRecord("guarded", "guard-run"),
    });
    const first = await store.read({ scope: "run", scopeRef: "guard-run", key: "guarded" });
    // 模拟并发：检查之后、revoke 之前记录被写入新值（updated_at 变化）。
    await store.write({
      scope: "run",
      scopeRef: "guard-run",
      key: "guarded",
      record: {
        ...first,
        current: { ...first.current, content: "newer" },
        updated_at: "2026-09-27T00:00:01.000Z",
      },
    });
    const result = await store.revoke({
      scope: "run",
      scopeRef: "guard-run",
      key: "guarded",
      expectedState: "active",
      expectedUpdatedAt: first.updated_at,
    });
    assert.deepEqual(result, { status: "unchanged", revoked: 0 });
    const current = await store.read({ scope: "run", scopeRef: "guard-run", key: "guarded" });
    assert.equal(current.state, "active");
    assert.equal(current.current.content, "newer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired done becomes a tombstone and purge unlinks the file only past retention", async () => {
  const root = await makeTempDirectory();
  const now = { value: Date.UTC(2026, 8, 27, 0, 0, 0) };
  const DAY = 24 * 60 * 60 * 1000;
  try {
    await withNotesEnv({ ERIX_NOTES_DONE_GRACE_MS: "60000" }, async () => {
      const store = createFileNotesStore({ dir: root, clock: () => now.value });
      await store.write({
        scope: "run",
        scopeRef: "retention-run",
        key: "lifecycle",
        record: makeRecord("lifecycle", "retention-run"),
      });
      // active → done：expires = now + 60s（DONE_GRACE_MS）。
      assert.deepEqual(await store.complete({ scope: "run", scopeRef: "retention-run" }), {
        status: "found",
        completed: 1,
      });
      // 过期：janitor 写墓碑（revoked_at = tombstone 起点）。
      now.value += 61_000;
      assert.deepEqual(await store.janitor({}), {
        status: "found",
        scanned: 1,
        revoked: 1,
        nextCursor: null,
      });
      const tombstone = await store.read({
        scope: "run", scopeRef: "retention-run", key: "lifecycle",
      });
      assert.equal(tombstone.state, "revoked");
      assert.ok(tombstone.revoked_at);
      assert.equal(tombstone.revoke_reason, "done_expired");

      // 未到 30 天保留期：文件仍在，purge 不删。
      now.value += 29 * DAY;
      assert.deepEqual(await store.purge({}), {
        status: "found",
        scanned: 1,
        purged: 0,
        nextCursor: null,
      });
      assert.ok(await store.read({ scope: "run", scopeRef: "retention-run", key: "lifecycle" }));

      // before 只能缩小范围：传未来时刻不得放大删除窗口。
      assert.equal(
        (await store.purge({ before: new Date(now.value + DAY).toISOString() })).purged,
        0,
      );

      // 超过保留期：purge 真正 unlink 文件。
      now.value += 2 * DAY;
      assert.deepEqual(await store.purge({}), {
        status: "found",
        scanned: 1,
        purged: 1,
        nextCursor: null,
      });
      assert.equal(
        await store.read({ scope: "run", scopeRef: "retention-run", key: "lifecycle" }),
        undefined,
      );
      assert.deepEqual(await readdir(path.join(root, "run", "retention-run")), []);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("purge paginates with limit/cursor and unlinks only eligible tombstones", async () => {
  const root = await makeTempDirectory();
  const now = { value: Date.UTC(2026, 8, 27, 0, 0, 0) };
  const DAY = 24 * 60 * 60 * 1000;
  try {
    await withNotesEnv({ ERIX_NOTES_TOMBSTONE_RETENTION_MS: String(DAY) }, async () => {
      const store = createFileNotesStore({ dir: root, clock: () => now.value });
      const old = new Date(now.value - 2 * DAY).toISOString();
      for (let index = 0; index < 3; index += 1) {
        await store.write({
          scope: "run",
          scopeRef: `tomb-run-${index}`,
          key: "note",
          record: makeRecord("note", `tomb-run-${index}`, {
            state: "revoked",
            revoked_at: old,
            updated_at: old,
          }),
        });
      }
      // 未到保留期与 active 记录不删。
      const recent = new Date(now.value - 60_000).toISOString();
      await store.write({
        scope: "run",
        scopeRef: "mixed-run",
        key: "recent-tomb",
        record: makeRecord("recent-tomb", "mixed-run", {
          state: "revoked",
          revoked_at: recent,
          updated_at: recent,
        }),
      });
      await store.write({
        scope: "run",
        scopeRef: "mixed-run",
        key: "live",
        record: makeRecord("live", "mixed-run"),
      });

      let cursor;
      let totalPurged = 0;
      const pages = [];
      do {
        const page = await store.purge({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        pages.push([page.scanned, page.purged]);
        totalPurged += page.purged;
        cursor = page.nextCursor;
      } while (cursor !== null);
      // 扫描顺序按 scope 名排序：mixed-run 两条在前（不删），随后三条墓碑逐页删除。
      // purge 的 cursor 是不透明 key：中途 unlink 不会导致后续墓碑被跳过。
      assert.deepEqual(pages, [[2, 0], [2, 2], [1, 1]]);
      assert.equal(totalPurged, 3);
      await assert.rejects(store.purge({ cursor: 3 }), /non-empty string/u);
      await assert.rejects(store.purge({ limit: 0 }), /positive safe integer/u);
      // 未到保留期的墓碑与 active 记录都还在。
      const recentTomb = await store.read({
        scope: "run", scopeRef: "mixed-run", key: "recent-tomb",
      });
      assert.equal(recentTomb.state, "revoked");
      const live = await store.read({ scope: "run", scopeRef: "mixed-run", key: "live" });
      assert.equal(live.state, "active");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
