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
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createFileNotesStore,
  isNoteRecord,
} from "../../src/store/notes.js";
import { notesStoreCasContract, notesStoreContract } from "../contract/notes-store.js";
import * as notes from "../../src/tools/notes.js";

async function makeTempDirectory() {
  return mkdtemp(path.join(tmpdir(), "erix-notes-store-"));
}

notesStoreContract("file notes", async () => {
  const dir = await makeTempDirectory();
  return createFileNotesStore({ dir });
});

// 可选 CAS 子套件（issue #183 裁决 2）：文件适配器不是 CAS store，但子套件的断言
// 比一写者 LWW 弱（并发双写都成功也算兑现），所以这里一并注册：它同时证明这个
// 新导出的子套件能接宿主实现跑绿（宿主侧漂移哨兵与上游自身回归共用一份断言）。
notesStoreCasContract("file notes", async () => {
  const dir = await makeTempDirectory();
  return createFileNotesStore({ dir });
});

// ---------------------------------------------------------------------------
// 文件适配器专属断言（issue #183 裁决 2 / 3B：从通用契约套件里移过来）
//
// 这两条只适用于内置文件适配器，不再是通用 NotesStore 契约：
//   * 并发 LWW：一写者模型下两个并发读-改-写都不得报错（CAS 型 store 可以拒一个，
//     所以通用套件已不再这么要求）；
//   * 墓碑形态：文件适配器选的是「墓碑」而不是物理删除（通用套件只承诺可观察消失）。
// ---------------------------------------------------------------------------

test("file notes: concurrent same-key updates are last-write-wins (one-writer limitation)", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    await store.write({
      scope: "run", scopeRef: "lww-run", key: "answer",
      record: makeRecord("answer", "lww-run"),
    });
    const base = await store.read({ scope: "run", scopeRef: "lww-run", key: "answer" });
    const updates = ["left", "right"].map((content) => ({
      ...base,
      current: { ...base.current, content },
      updated_at: `2026-09-15T00:00:0${content === "left" ? "1" : "2"}.000Z`,
    }));
    // 一写者模型不拒绝任何一个并发写：两个都必须成功。
    await Promise.all(updates.map((record) => store.write({
      scope: "run", scopeRef: "lww-run", key: "answer", record,
    })));
    const final = await store.read({ scope: "run", scopeRef: "lww-run", key: "answer" });
    assert.ok(["left", "right"].includes(final.current.content));
    assert.equal(final.key, "answer");
    assert.equal(
      isNoteRecord(final, { key: "answer", scopeRef: "lww-run" }),
      true,
      "并发后必须只剩一条合法记录，而不是写坏文件",
    );
    // scope 目录里只能有一条记录文件（没有半截 .tmp 残留被当成记录）。
    const files = (await readdir(path.join(root, "run", "lww-run"))).filter((name) => name.endsWith(".json"));
    assert.deepEqual(files, ["answer.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file notes: revoke leaves a revoked tombstone with revoked_at and revoke_reason", async () => {
  const root = await makeTempDirectory();
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
    await store.write({
      scope: "run", scopeRef: "tombstone-run", key: "gone",
      record: makeRecord("gone", "tombstone-run"),
    });
    assert.deepEqual(await store.revoke({
      scope: "run", scopeRef: "tombstone-run", key: "gone", reason: "cleanup",
    }), { status: "found", revoked: 1 });
    const tombstone = await store.read({ scope: "run", scopeRef: "tombstone-run", key: "gone" });
    assert.equal(tombstone.state, "revoked");
    assert.equal(tombstone.revoked_at, new Date(Date.UTC(2026, 8, 27)).toISOString());
    assert.equal(tombstone.revoke_reason, "cleanup");
    // 已是墓碑 → unchanged（文件适配器不物理删除，所以不是 missing）。
    assert.deepEqual(
      await store.revoke({ scope: "run", scopeRef: "tombstone-run", key: "gone" }),
      { status: "unchanged", revoked: 0 },
    );
    // 墓碑仍在盘上（可观察消失的沉淀形态，不是物理删除）。
    assert.equal(
      isNoteRecord(JSON.parse(await readFile(
        path.join(root, "run", "tombstone-run", "gone.json"), "utf8",
      )), { key: "gone", scopeRef: "tombstone-run" }),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      ["write", "read", "list", "complete", "revoke", "purge"].map((method) => [
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
      ["write", "read", "list", "complete", "revoke", "purge"].map((method) => [
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

// 把 scope 目录下全部记录文件的 mtime 统一拨到 ms 毫秒前（真实时钟基准）。
// purge 的 scope 时钟看的是文件 mtime，不是记录里的 updated_at 字段。
async function ageScopeFiles(root, scopeRef, ms) {
  const directory = path.join(root, "run", scopeRef);
  const stamp = new Date(Date.now() - ms);
  for (const name of await readdir(directory)) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    await utimes(path.join(directory, name), stamp, stamp);
  }
}

test("purge shoots the whole scope past retention and spares live scopes (scope-level clock)", async () => {
  const root = await makeTempDirectory();
  const DAY = 24 * 60 * 60 * 1000;
  try {
    await withNotesEnv({ ERIX_NOTES_RETENTION_MS: String(30 * DAY) }, async () => {
      const store = createFileNotesStore({ dir: root });
      // scope A：active/done/revoked 混合，最新写入 40 天前 → 整本删除（含 active）。
      await store.write({
        scope: "run", scopeRef: "scope-a", key: "alive",
        record: makeRecord("alive", "scope-a"),
      });
      await store.write({
        scope: "run", scopeRef: "scope-a", key: "finished",
        record: makeRecord("finished", "scope-a", { state: "done" }),
      });
      await store.write({
        scope: "run", scopeRef: "scope-a", key: "killed",
        record: makeRecord("killed", "scope-a", {
          state: "revoked", revoked_at: "2026-09-01T00:00:00.000Z",
        }),
      });
      await ageScopeFiles(root, "scope-a", 40 * DAY);
      // scope B：最新写入 10 天前，但其中有一条 40 天前的老笔记 → 整体豁免
      //（会话活着，笔记本整体保留）。
      await store.write({
        scope: "run", scopeRef: "scope-b", key: "old-note",
        record: makeRecord("old-note", "scope-b"),
      });
      await store.write({
        scope: "run", scopeRef: "scope-b", key: "recent-note",
        record: makeRecord("recent-note", "scope-b"),
      });
      await ageScopeFiles(root, "scope-b", 40 * DAY);
      const stamp10d = new Date(Date.now() - 10 * DAY);
      await utimes(path.join(root, "run", "scope-b", "recent-note.json"), stamp10d, stamp10d);
      // scope C：空目录。c-old 目录自身 40 天前 → 移除；c-fresh 保留。
      await mkdir(path.join(root, "run", "scope-c-old"), { recursive: true });
      await mkdir(path.join(root, "run", "scope-c-fresh"), { recursive: true });
      const stamp40d = new Date(Date.now() - 40 * DAY);
      await utimes(path.join(root, "run", "scope-c-old"), stamp40d, stamp40d);

      assert.deepEqual(await store.purge({}), { status: "found", scanned: 4, purged: 3 });
      assert.equal(
        await store.read({ scope: "run", scopeRef: "scope-a", key: "alive" }),
        undefined,
      );
      assert.deepEqual(
        (await readdir(path.join(root, "run"))).sort(),
        ["scope-b", "scope-c-fresh"],
        "死 scope 目录移除；活 scope 与新鲜空目录保留",
      );
      assert.equal(
        (await store.read({ scope: "run", scopeRef: "scope-b", key: "old-note" })).state,
        "active",
        "40 天前的老笔记随活 scope 豁免",
      );

      // before 只能缩小范围（取更早的 cutoff，绝不放大删除窗口）。
      await store.write({
        scope: "run", scopeRef: "scope-d", key: "x",
        record: makeRecord("x", "scope-d"),
      });
      await ageScopeFiles(root, "scope-d", 40 * DAY);
      assert.equal(
        (await store.purge({ before: new Date(Date.now() - 45 * DAY).toISOString() })).purged,
        0,
        "45 天前的 before 把 40 天死的 scope 也豁免",
      );
      assert.equal((await store.purge({})).purged, 1, "自然 cutoff 下 scope-d 被删");
      assert.equal(
        await store.read({ scope: "run", scopeRef: "scope-d", key: "x" }),
        undefined,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete flips active to done without expires_at; done records die with their scope", async () => {
  const root = await makeTempDirectory();
  const DAY = 24 * 60 * 60 * 1000;
  try {
    const store = createFileNotesStore({ dir: root });
    await store.write({
      scope: "run", scopeRef: "done-run", key: "note",
      record: makeRecord("note", "done-run"),
    });
    assert.deepEqual(await store.complete({ scope: "run", scopeRef: "done-run" }), {
      status: "found",
      completed: 1,
    });
    const done = await store.read({ scope: "run", scopeRef: "done-run", key: "note" });
    assert.equal(done.state, "done");
    assert.equal(done.expires_at, undefined, "expires_at 已退役（ADR-018 D7）");
    // 会话仍在保留期内：done 文件存在，purge 不删。
    assert.deepEqual(await store.purge({}), { status: "found", scanned: 1, purged: 0 });
    // 整个 scope 最后写入超过保留期：done 记录随本一起删除（含目录移除）。
    await ageScopeFiles(root, "done-run", 31 * DAY);
    assert.deepEqual(await store.purge({}), { status: "found", scanned: 1, purged: 1 });
    assert.equal(
      await store.read({ scope: "run", scopeRef: "done-run", key: "note" }),
      undefined,
    );
    assert.deepEqual(await readdir(path.join(root, "run")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention env: ERIX_NOTES_RETENTION_MS wins, ERIX_NOTES_GRACE_MS is the only deprecated alias, dead names are ignored", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const MINUTE = 60_000;
  // ERIX_NOTES_GRACE_MS（0.11.0 发布过的 deprecated alias）→ 映射到统一保留期。
  const graceRoot = await makeTempDirectory();
  await withNotesEnv({ ERIX_NOTES_GRACE_MS: String(MINUTE) }, async () => {
    const store = createFileNotesStore({ dir: graceRoot });
    await store.write({
      scope: "run", scopeRef: "alias-run", key: "grace",
      record: makeRecord("grace", "alias-run"),
    });
    await ageScopeFiles(graceRoot, "alias-run", 2 * MINUTE);
    assert.deepEqual(await store.purge({}), { status: "found", scanned: 1, purged: 1 });
  });
  await rm(graceRoot, { recursive: true, force: true });
  // 并存时以 ERIX_NOTES_RETENTION_MS 为准。
  const precedenceRoot = await makeTempDirectory();
  await withNotesEnv({
    ERIX_NOTES_RETENTION_MS: String(30 * DAY),
    ERIX_NOTES_GRACE_MS: String(MINUTE),
  }, async () => {
    const store = createFileNotesStore({ dir: precedenceRoot });
    await store.write({
      scope: "run", scopeRef: "alias-run", key: "precedence",
      record: makeRecord("precedence", "alias-run"),
    });
    await ageScopeFiles(precedenceRoot, "alias-run", 2 * MINUTE);
    assert.equal((await store.purge({})).purged, 0, "新变量优先，2 分钟远未超 30 天");
  });
  await rm(precedenceRoot, { recursive: true, force: true });
  // ERIX_NOTES_DONE_GRACE_MS / ERIX_NOTES_TOMBSTONE_RETENTION_MS 从未随 0.12.0
  // 发布：即使被设置也完全不读，按默认 30 天处理（审计 F 项）。
  const deadRoot = await makeTempDirectory();
  await withNotesEnv({
    ERIX_NOTES_DONE_GRACE_MS: String(MINUTE),
    ERIX_NOTES_TOMBSTONE_RETENTION_MS: String(MINUTE),
  }, async () => {
    const store = createFileNotesStore({ dir: deadRoot });
    await store.write({
      scope: "run", scopeRef: "alias-run", key: "a",
      record: makeRecord("a", "alias-run"),
    });
    await store.write({
      scope: "run", scopeRef: "alias-run", key: "b",
      record: makeRecord("b", "alias-run"),
    });
    await ageScopeFiles(deadRoot, "alias-run", 20 * DAY);
    assert.equal(
      (await store.purge({})).purged,
      0,
      "假兼容名被无视：20 天未超默认 30 天，不删",
    );
    await ageScopeFiles(deadRoot, "alias-run", 40 * DAY);
    assert.equal((await store.purge({})).purged, 2, "默认 30 天到期即删");
  });
  await rm(deadRoot, { recursive: true, force: true });
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
  try {
    const store = createFileNotesStore({ dir: root, clock: () => Date.UTC(2026, 8, 27) });
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
