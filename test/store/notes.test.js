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
  writeFile,
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
    const listed = JSON.parse(await notes.note_list({ __erix: scope }));
    assert.equal(listed.count, 1);
    assert.equal(listed.notes[0].key, "unsafe");
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
      // 隐藏 metadata sidecar（若有）不参与 note 扫描：目录里只剩点文件（若有）。
      assert.deepEqual(
        (await readdir(path.join(root, "run", "retention-run"))).filter((name) => !name.startsWith(".")),
        [],
      );
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

// ---------------------------------------------------------------------------
// 契约收窄（ADR-018 D3 决策反转）：list 返回朴素数组——不给 limit = 全部
// 匹配记录，给了 limit 钳制最大 200；filters/sort 照旧；无 revision/游标协议。
// ---------------------------------------------------------------------------

function makeListRecord(key, scopeRef, overrides = {}) {
  return makeRecord(key, scopeRef, {
    relevance: 0.5,
    updated_at: "2026-09-15T00:00:00.000Z",
    created_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  });
}

test("list returns all matching records without limit and clamps limit to 200, with filters and both stable sorts", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    // 5 条 active + 1 条 done；tag/source/relevance 各异。
    await store.write({
      scope: "run", scopeRef: "page-run", key: "alpha",
      record: makeListRecord("alpha", "page-run", {
        relevance: 0.9, tags: ["keep"], updated_at: "2026-09-15T01:00:00.000Z",
        current: { content: "a", provenance: { source: "agent" }, ts: "2026-09-15T01:00:00.000Z" },
      }),
    });
    await store.write({
      scope: "run", scopeRef: "page-run", key: "bravo",
      record: makeListRecord("bravo", "page-run", {
        relevance: 0.9, tags: ["keep"], updated_at: "2026-09-15T02:00:00.000Z",
        current: { content: "b", provenance: { source: "auto" }, ts: "2026-09-15T02:00:00.000Z" },
      }),
    });
    await store.write({
      scope: "run", scopeRef: "page-run", key: "charlie",
      record: makeListRecord("charlie", "page-run", {
        relevance: 0.3, tags: ["drop"], updated_at: "2026-09-15T03:00:00.000Z",
      }),
    });
    await store.write({
      scope: "run", scopeRef: "page-run", key: "delta",
      record: makeListRecord("delta", "page-run", {
        relevance: 0.9, pinned: true, tags: ["keep"], updated_at: "2026-09-15T00:30:00.000Z",
      }),
    });
    await store.write({
      scope: "run", scopeRef: "page-run", key: "echo",
      record: makeListRecord("echo", "page-run", {
        relevance: 0.7, tags: ["keep"], updated_at: "2026-09-15T01:30:00.000Z",
      }),
    });
    await store.write({
      scope: "run", scopeRef: "page-run", key: "done-note",
      record: makeListRecord("done-note", "page-run", { state: "done" }),
    });

    // 不给 limit：返回全部匹配记录（含 done-note 共 6 条）。
    const all = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: ["active", "done"] },
    });
    assert.equal(Array.isArray(all), true);
    assert.equal(all.length, 6);

    // limit 截断到前 N 条；relevance 排序稳定（relevance DESC, updated_at DESC,
    // key ASC）。
    const top2 = await store.list({
      scope: "run", scopeRef: "page-run", limit: 2, filters: { state: "active" },
    });
    assert.equal(top2.map((record) => record.key).join(","), "bravo,alpha");
    await assert.rejects(
      store.list({ scope: "run", scopeRef: "page-run", limit: 0 }),
      /positive safe integer/u,
    );

    // 过滤条件：tag / source / minRelevance / state 数组。
    const tagFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active", tag: "keep" },
    });
    assert.equal(tagFiltered.length, 4);
    const sourceFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active", source: "auto" },
    });
    assert.deepEqual(sourceFiltered.map((record) => record.key), ["bravo"]);
    const relevanceFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active", minRelevance: 0.8 },
    });
    assert.deepEqual(
      relevanceFiltered.map((record) => record.key),
      ["bravo", "alpha", "delta"],
    );
    const doneFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: ["done"] },
    });
    assert.deepEqual(doneFiltered.map((record) => record.key), ["done-note"]);

    // pinned_updated：pinned DESC, updated_at DESC, key ASC。
    const pinned = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active" }, sort: "pinned_updated",
    });
    assert.equal(pinned[0].key, "delta", "pinned 排最前");
    assert.deepEqual(
      pinned.slice(1).map((record) => record.key),
      ["charlie", "bravo", "echo", "alpha"],
      "其余按 updated_at 倒序",
    );

    // 排序稳定性的 key ASC 兜底：relevance 与 updated_at 全同时按 key 升序。
    await store.write({
      scope: "run", scopeRef: "tie-run", key: "zeta",
      record: makeListRecord("zeta", "tie-run"),
    });
    await store.write({
      scope: "run", scopeRef: "tie-run", key: "beta",
      record: makeListRecord("beta", "tie-run"),
    });
    const tied = await store.list({ scope: "run", scopeRef: "tie-run" });
    assert.deepEqual(tied.map((record) => record.key), ["beta", "zeta"]);

    await assert.rejects(
      store.list({ scope: "run", scopeRef: "page-run", sort: "bogus" }),
      /relevance.*pinned_updated|pinned_updated.*relevance/u,
    );
    await assert.rejects(
      store.list({ scope: "run", scopeRef: "page-run", filters: { state: "bogus" } }),
      /state/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list clamps an explicit limit to 200 even when the scope holds more records", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    // 210 条 active：不给 limit 全量返回；limit=5000 钳到 200。
    for (let index = 0; index < 210; index += 1) {
      await store.write({
        scope: "run", scopeRef: "clamp-run", key: `note-${String(index).padStart(3, "0")}`,
        record: makeListRecord(`note-${String(index).padStart(3, "0")}`, "clamp-run"),
      });
    }
    const all = await store.list({ scope: "run", scopeRef: "clamp-run" });
    assert.equal(all.length, 210, "不给 limit = 全部匹配记录");
    const clamped = await store.list({ scope: "run", scopeRef: "clamp-run", limit: 5000 });
    assert.equal(clamped.length, 200, "limit 超过 200 钳制到 200（不是报错）");
    const exact = await store.list({ scope: "run", scopeRef: "clamp-run", limit: 200 });
    assert.equal(exact.length, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete collects the whole scope internally and is not truncated by the limit clamp", async () => {
  const root = await makeTempDirectory();
  const now = { value: Date.UTC(2026, 8, 27, 0, 0, 0) };
  try {
    await withNotesEnv({ ERIX_NOTES_DONE_GRACE_MS: "60000" }, async () => {
      const store = createFileNotesStore({ dir: root, clock: () => now.value });
      // 210 条 active：complete 走内部全量收集（不走公共 list 的 limit 钳制）。
      for (let index = 0; index < 210; index += 1) {
        await store.write({
          scope: "run", scopeRef: "bulk-run", key: `note-${String(index).padStart(3, "0")}`,
          record: makeListRecord(`note-${String(index).padStart(3, "0")}`, "bulk-run"),
        });
      }
      assert.deepEqual(await store.complete({ scope: "run", scopeRef: "bulk-run" }), {
        status: "found",
        completed: 210,
      });
      const done = await store.list({
        scope: "run", scopeRef: "bulk-run", filters: { state: "done" },
      });
      assert.equal(done.length, 210, "全部 active 逐条置 done，无截断");
      const stillActive = await store.list({
        scope: "run", scopeRef: "bulk-run", filters: { state: "active" },
      });
      assert.equal(stillActive.length, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read/list normalize records missing updated_at and stay sortable", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root });
    const scopeDir = path.join(root, "run", "legacy-run");
    await mkdir(scopeDir, { recursive: true });
    // 外来记录：缺 updated_at、缺 created_at（PR 3 前置 normalize 场景）。
    const legacy = {
      key: "legacy",
      scope: "run",
      scopeRef: "legacy-run",
      current: { content: "old", provenance: { source: "agent" }, ts: "x" },
      superseded: [],
      folded: 0,
      tags: [],
      state: "active",
    };
    await writeFile(path.join(scopeDir, "legacy.json"), `${JSON.stringify(legacy)}\n`, "utf8");

    const read = await store.read({ scope: "run", scopeRef: "legacy-run", key: "legacy" });
    assert.equal(read.updated_at, "1970-01-01T00:00:00.000Z");
    assert.equal(read.created_at, "1970-01-01T00:00:00.000Z");
    // 文件不被回写（normalize 只影响返回值）。
    assert.equal(JSON.parse(await readFile(path.join(scopeDir, "legacy.json"), "utf8")).updated_at, undefined);

    // created_at 有效、updated_at 缺失 → 回退 created_at。
    const withCreated = {
      ...legacy,
      key: "created-only",
      created_at: "2026-09-10T00:00:00.000Z",
    };
    delete withCreated.updated_at;
    await writeFile(
      path.join(scopeDir, "created-only.json"),
      `${JSON.stringify(withCreated)}\n`,
      "utf8",
    );
    const fallback = await store.read({ scope: "run", scopeRef: "legacy-run", key: "created-only" });
    assert.equal(fallback.updated_at, "2026-09-10T00:00:00.000Z");

    // 非法 updated_at 同样回退 created_at。
    const invalid = {
      ...withCreated,
      key: "invalid-time",
      updated_at: "not-a-date",
    };
    await writeFile(
      path.join(scopeDir, "invalid-time.json"),
      `${JSON.stringify(invalid)}\n`,
      "utf8",
    );
    const invalidRead = await store.read({ scope: "run", scopeRef: "legacy-run", key: "invalid-time" });
    assert.equal(invalidRead.updated_at, "2026-09-10T00:00:00.000Z");

    // 列表与排序不崩：非法时间值排最后，其余按规则。
    const listed = await store.list({ scope: "run", scopeRef: "legacy-run" });
    assert.equal(listed.length, 3);
    const sorted = await store.list({
      scope: "run", scopeRef: "legacy-run", sort: "pinned_updated",
    });
    assert.deepEqual(
      sorted.map((record) => record.key),
      ["created-only", "invalid-time", "legacy"],
      "updated_at 回退后 created-only 最新，legacy（epoch 兜底）最后按 key 稳定",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
