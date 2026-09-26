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
    // breaking（issue #67 PR 2）：total 移除，用 count + nextCursor。
    const listed = JSON.parse(await notes.note_list({ __erix: scope }));
    assert.equal(listed.count, 1);
    assert.equal(listed.nextCursor, null);
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
      // .revision 是 scope metadata（隐藏文件），purge 后仍保留。
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
// issue #67 PR 2：list 分页、scope revision 与 cursor_stale
// ---------------------------------------------------------------------------

function makeListRecord(key, scopeRef, overrides = {}) {
  return makeRecord(key, scopeRef, {
    relevance: 0.5,
    updated_at: "2026-09-15T00:00:00.000Z",
    created_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  });
}

test("list paginates with limit clamping, filters and both stable sorts", async () => {
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

    // 默认 limit=50：一页装下 5 条 active（done 被 state 过滤排除需显式 filters）。
    const first = await store.list({ scope: "run", scopeRef: "page-run", filters: { state: "active" } });
    assert.equal(first.status, "found");
    assert.equal(first.records.length, 5);
    assert.equal(first.nextCursor, null);

    // limit 翻页到 nextCursor === null；relevance 排序稳定（relevance DESC,
    // updated_at DESC, key ASC）。
    const page1 = await store.list({
      scope: "run", scopeRef: "page-run", limit: 2, filters: { state: "active" },
    });
    assert.equal(page1.records.map((record) => record.key).join(","), "bravo,alpha");
    const page2 = await store.list({
      scope: "run", scopeRef: "page-run", limit: 2, filters: { state: "active" },
      cursor: page1.nextCursor,
    });
    assert.equal(page2.records.map((record) => record.key).join(","), "delta,echo");
    assert.equal(typeof page2.nextCursor, "string");
    const page3 = await store.list({
      scope: "run", scopeRef: "page-run", limit: 2, filters: { state: "active" },
      cursor: page2.nextCursor,
    });
    assert.equal(page3.records.map((record) => record.key).join(","), "charlie");
    assert.equal(page3.nextCursor, null, "恰好覆盖末尾时 nextCursor 为 null");

    // limit 超过 200 钳制到 200（不是报错）：201 条请求一次取回全部。
    const clamped = await store.list({
      scope: "run", scopeRef: "page-run", limit: 5000, filters: { state: ["active", "done"] },
    });
    assert.equal(clamped.records.length, 6);
    assert.equal(clamped.nextCursor, null);
    await assert.rejects(
      store.list({ scope: "run", scopeRef: "page-run", limit: 0 }),
      /positive safe integer/u,
    );

    // 过滤条件：tag / source / minRelevance / state 数组。
    const tagFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active", tag: "keep" },
    });
    assert.equal(tagFiltered.records.length, 4);
    const sourceFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active", source: "auto" },
    });
    assert.deepEqual(sourceFiltered.records.map((record) => record.key), ["bravo"]);
    const relevanceFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active", minRelevance: 0.8 },
    });
    assert.deepEqual(
      relevanceFiltered.records.map((record) => record.key),
      ["bravo", "alpha", "delta"],
    );
    const doneFiltered = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: ["done"] },
    });
    assert.deepEqual(doneFiltered.records.map((record) => record.key), ["done-note"]);

    // pinned_updated：pinned DESC, updated_at DESC, key ASC。
    const pinned = await store.list({
      scope: "run", scopeRef: "page-run", filters: { state: "active" }, sort: "pinned_updated",
    });
    assert.equal(pinned.records[0].key, "delta", "pinned 排最前");
    assert.deepEqual(
      pinned.records.slice(1).map((record) => record.key),
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
    assert.deepEqual(tied.records.map((record) => record.key), ["beta", "zeta"]);

    await assert.rejects(
      store.list({ scope: "run", scopeRef: "page-run", sort: "bogus" }),
      /relevance.*pinned_updated|pinned_updated.*relevance/u,
    );
    await assert.rejects(
      store.list({ scope: "run", scopeRef: "page-run", filters: { state: "bogus" } }),
      /state/u,
    );
    await assert.rejects(
      store.list({ scope: "run", scopeRef: "page-run", cursor: "not-a-cursor" }),
      /opaque list cursor/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list scope revision advances on write/complete/revoke and janitor revoke", async () => {
  const root = await makeTempDirectory();
  const now = { value: Date.UTC(2026, 8, 27, 0, 0, 0) };
  try {
    await withNotesEnv({ ERIX_NOTES_DONE_GRACE_MS: "60000" }, async () => {
      const store = createFileNotesStore({ dir: root, clock: () => now.value });
      const revisionOf = async () => (
        await store.list({ scope: "run", scopeRef: "rev-run" })
      ).revision;

      // 空 scope（目录不存在）：revision 固定为 "0"，不产生写副作用。
      assert.equal(await revisionOf(), "0");
      assert.equal((await revisionOf()), "0");

      await store.write({
        scope: "run", scopeRef: "rev-run", key: "one",
        record: makeListRecord("one", "rev-run"),
      });
      const afterWrite = await revisionOf();
      assert.notEqual(afterWrite, "0");

      await store.write({
        scope: "run", scopeRef: "rev-run", key: "two",
        record: makeListRecord("two", "rev-run"),
      });
      const afterSecondWrite = await revisionOf();
      assert.notEqual(afterSecondWrite, afterWrite, "第二次 write 继续递增");

      // complete：active → done，revision 变化。
      assert.deepEqual(await store.complete({ scope: "run", scopeRef: "rev-run" }), {
        status: "found",
        completed: 2,
      });
      const afterComplete = await revisionOf();
      assert.notEqual(afterComplete, afterSecondWrite);

      // revoke：revision 变化。
      const revoked = await store.revoke({ scope: "run", scopeRef: "rev-run", key: "one" });
      assert.equal(revoked.status, "found");
      const afterRevoke = await revisionOf();
      assert.notEqual(afterRevoke, afterComplete);

      // janitor 的过期 done revoke 同样推进 revision。
      now.value += 61_000;
      const janitor = await store.janitor({});
      assert.equal(janitor.revoked, 1, "two 的 done 已过期，janitor 写墓碑");
      const afterJanitor = await revisionOf();
      assert.notEqual(afterJanitor, afterRevoke);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list cursor stays valid within one revision and goes stale after a change", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    for (let index = 0; index < 4; index += 1) {
      await store.write({
        scope: "run", scopeRef: "stale-run", key: `note-${index}`,
        record: makeListRecord(`note-${index}`, "stale-run", {
          relevance: 0.5 + index * 0.1,
          updated_at: `2026-09-15T0${index}:00:00.000Z`,
        }),
      });
    }
    const page1 = await store.list({ scope: "run", scopeRef: "stale-run", limit: 2 });
    assert.equal(page1.records.length, 2);
    assert.notEqual(page1.nextCursor, null);

    // 同 revision 内翻页一致：再次用同一游标取到同一页。
    const again = await store.list({
      scope: "run", scopeRef: "stale-run", limit: 2, cursor: page1.nextCursor,
    });
    assert.deepEqual(
      again.records.map((record) => record.key),
      (await store.list({
        scope: "run", scopeRef: "stale-run", limit: 2, cursor: page1.nextCursor,
      })).records.map((record) => record.key),
    );

    // 变更后旧游标 stale：结构化空结果 + 当前 revision，不崩溃。
    await store.write({
      scope: "run", scopeRef: "stale-run", key: "note-4",
      record: makeListRecord("note-4", "stale-run"),
    });
    const stale = await store.list({
      scope: "run", scopeRef: "stale-run", limit: 2, cursor: page1.nextCursor,
    });
    assert.equal(stale.status, "cursor_stale");
    assert.deepEqual(stale.records, []);
    assert.equal(stale.nextCursor, null);
    assert.notEqual(stale.revision, page1.revision);
    assert.equal(stale.revision, (await store.list({ scope: "run", scopeRef: "stale-run" })).revision);

    // purge 删除文件同样推进 revision（ Tombstone 路径 ）。
    await store.revoke({ scope: "run", scopeRef: "stale-run", key: "note-0" });
    const beforePurge = (await store.list({ scope: "run", scopeRef: "stale-run" })).revision;
    await withNotesEnv({ ERIX_NOTES_TOMBSTONE_RETENTION_MS: "0" }, async () => {
      const purged = await store.purge({});
      assert.equal(purged.purged, 1);
    });
    const afterPurge = (await store.list({ scope: "run", scopeRef: "stale-run" })).revision;
    assert.notEqual(afterPurge, beforePurge, "purge 删除文件必须让 revision 失效缓存");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list rebuilds a missing or corrupt revision file from directory state", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    const scopeDir = path.join(root, "run", "rebuild-run");
    for (let index = 0; index < 3; index += 1) {
      await store.write({
        scope: "run", scopeRef: "rebuild-run", key: `note-${index}`,
        record: makeListRecord(`note-${index}`, "rebuild-run"),
      });
    }
    assert.equal(typeof (await store.list({ scope: "run", scopeRef: "rebuild-run" })).revision, "string");

    // revision 缓存是 adapter 进程内的：.revision 丢失/损坏由新实例（冷缓存，
    // 模拟进程重启）发现并从目录状态重建。
    await rm(path.join(scopeDir, ".revision"));
    const restarted = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    const rebuilt = await restarted.list({ scope: "run", scopeRef: "rebuild-run" });
    assert.equal(rebuilt.status, "found");
    assert.equal(rebuilt.records.length, 3, "revision 文件缺失绝不当成空 notes");
    assert.equal(typeof rebuilt.revision, "string");
    await restarted.write({
      scope: "run", scopeRef: "rebuild-run", key: "note-3",
      record: makeListRecord("note-3", "rebuild-run"),
    });
    const afterWrite = (await restarted.list({ scope: "run", scopeRef: "rebuild-run" })).revision;
    assert.notEqual(afterWrite, rebuilt.revision, "重建后仍必须递增，不得卡在重建值");

    // 写坏 .revision：新实例同样重建，记录照常列出并自愈落盘。
    const revisionFile = path.join(scopeDir, ".revision");
    const beforeCorrupt = Number.parseInt(await readFile(revisionFile, "utf8"), 10);
    assert.ok(Number.isSafeInteger(beforeCorrupt));
    await writeFile(revisionFile, "{corrupt", "utf8");
    const recoveredStore = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    const recovered = await recoveredStore.list({ scope: "run", scopeRef: "rebuild-run" });
    assert.equal(recovered.records.length, 4, "损坏 revision 文件不得导致空列表");
    // 自愈：损坏文件被重建值覆盖。
    const selfHealed = Number.parseInt(await readFile(revisionFile, "utf8"), 10);
    assert.ok(Number.isSafeInteger(selfHealed));
    assert.ok(selfHealed >= beforeCorrupt, "重建值不得小于已持久化的历史值");
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
    const page = await store.list({ scope: "run", scopeRef: "legacy-run" });
    assert.equal(page.records.length, 3);
    const sorted = await store.list({
      scope: "run", scopeRef: "legacy-run", sort: "pinned_updated",
    });
    assert.deepEqual(
      sorted.records.map((record) => record.key),
      ["created-only", "invalid-time", "legacy"],
      "updated_at 回退后 created-only 最新，legacy（epoch 兜底）最后按 key 稳定",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
