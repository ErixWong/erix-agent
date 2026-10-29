import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  MAX_SUMMARY_LENGTH,
  createBuiltinNotesTools,
  note_list,
  note_read,
  note_take,
  resolveNotesDir,
} from "../../src/tools/notes.js";
import { createFileNotesStore, normalizeNoteRecord } from "../../src/store/notes.js";
import { makeTmp } from "../helpers/tmp.js";

async function withDirectory(callback) {
  const directory = await makeTmp("erix-builtin-notes-");
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("notes source implementation uses the injected NotesStore and scope", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    const calls = [];
    const notesStore = Object.fromEntries(
      ["write", "read", "list", "complete", "revoke", "purge"].map((method) => [
        method,
        async (request) => {
          calls.push({ method, request });
          return backing[method](request);
        },
      ]),
    );
    const scope = { runId: "source-run", notesDir: path.join(directory, "ignored"), notesStore };

    assert.equal(
      JSON.parse(await note_take({ key: "answer", content: "value", __erix: scope })).status,
      "found",
    );
    assert.equal(
      JSON.parse(await note_read({ key: "answer", __erix: scope })).value,
      "value",
    );
    assert.deepEqual(calls.map(({ method }) => method), ["read", "write", "read"]);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "run", "source-run", "answer.json"), "utf8"))
        .current.content,
      "value",
    );
  });
});

test("builtin notes tools expose canonical definitions and sanitize into the host scope", async () => {
  await withDirectory(async (directory) => {
    const notesStore = createFileNotesStore({ dir: directory });
    const builtin = createBuiltinNotesTools({
      notesDir: path.join(directory, "unused"),
      notesStore,
      runId: "builtin-run",
    });

    assert.deepEqual(
      builtin.definitions.map((tool) => tool.name),
      ["note_take", "note_read", "note_list", "note_forget"],
    );
    const result = JSON.parse(await builtin.executeTool("note_take", {
      key: "answer",
      content: "from-builtin",
      unknown: "discard",
      __erix: { runId: "forged-run", notesDir: "/forged" },
    }));
    assert.equal(result.status, "found");
    assert.equal(
      JSON.parse(await builtin.executeTool("note_read", { key: "answer" })).value,
      "from-builtin",
    );
    const completion = await builtin.lifecycle.onRunComplete({});
    assert.deepEqual([...Object.keys(completion)].sort(), ["completed", "errors"]);
    assert.deepEqual(completion.completed, { status: "found", completed: 1 });
    assert.deepEqual(completion.errors, []);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "run", "builtin-run", "answer.json"), "utf8"))
        .state,
      "done",
    );
  });
});

test("assembler dual views agree on the same input (executors vs structured executeTool)", async () => {
  await withDirectory(async (directory) => {
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      runId: "dual-view-run",
    });
    // 两个 key 各由一种视图首次写入；随后两种视图交叉读取，结果必须字节一致。
    await builtin.executors("note_take", {
      key: "via-executors",
      content: "same-value",
      unknown: "discard",
    }, {});
    await builtin.executeTool({
      id: "toolu_1",
      name: "note_take",
      input: { key: "via-structured", content: "same-value", unknown: "discard" },
      context: { round: 1 },
    });
    for (const key of ["via-executors", "via-structured"]) {
      const readPositional = await builtin.executors("note_read", { key }, {});
      const readStructured = await builtin.executeTool({
        id: "toolu_2",
        name: "note_read",
        input: { key },
        context: {},
      });
      assert.equal(readStructured, readPositional);
      assert.equal(JSON.parse(readStructured).value, "same-value");
    }
    // 未知工具两种视图同样报 unknown
    assert.equal(await builtin.executors("nope", {}, {}), "Unknown tool: nope");
    assert.equal(
      await builtin.executeTool({ id: "x", name: "nope", input: {}, context: {} }),
      "Unknown tool: nope",
    );
  });
});

test("assembler lifecycle forcibly overrides a forged __erix scope", async () => {
  await withDirectory(async (directory) => {
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      runId: "bound-run",
    });
    await builtin.executeTool("note_take", { key: "k", content: "v" });
    const forged = {
      __erix: {
        runId: "forged-run",
        notesDir: path.join(directory, "forged"),
        notesStore: createFileNotesStore({ dir: path.join(directory, "forged") }),
      },
    };
    const completion = await builtin.lifecycle.onRunComplete(forged);
    assert.deepEqual(completion.errors, []);
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "run", "bound-run", "k.json"), "utf8")).state,
      "done",
    );
    await assert.rejects(
      readFile(path.join(directory, "run", "forged-run", "k.json"), "utf8"),
    );
  });
});

test("assembler binds run scope at creation time (cross-run isolation)", async () => {
  await withDirectory(async (directory) => {
    const runA = createBuiltinNotesTools({ notesDir: directory, runId: "run-a" });
    const runB = createBuiltinNotesTools({ notesDir: directory, runId: "run-b" });
    await runA.executeTool("note_take", { key: "finding", content: "from-a" });
    await runB.executeTool("note_take", { key: "finding", content: "from-b" });
    assert.equal(
      JSON.parse(await runA.executeTool("note_read", { key: "finding" })).value,
      "from-a",
    );
    assert.equal(
      JSON.parse(await runB.executeTool("note_read", { key: "finding" })).value,
      "from-b",
    );
  });
});

test("assembler lifecycle: onRunComplete only completes active → done", async () => {
  await withDirectory(async (directory) => {
    const calls = [];
    const backing = createFileNotesStore({ dir: directory });
    const spyStore = Object.fromEntries(
      ["read", "write", "list", "revoke", "purge"].map((method) => [
        method,
        async (request) => {
          calls.push(method);
          return backing[method](request);
        },
      ]),
    );
    spyStore.complete = async (request) => {
      calls.push("complete");
      return backing.complete(request);
    };
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: spyStore,
      runId: "lifecycle-run",
    });
    await builtin.executeTool("note_take", { key: "k", content: "v" });
    calls.length = 0;
    const completion = await builtin.lifecycle.onRunComplete();
    assert.deepEqual(calls, ["complete"], "onRunComplete 只调 completeRun，不再跑任何维护");
    assert.deepEqual([...Object.keys(completion)].sort(), ["completed", "errors"]);
    assert.deepEqual(completion.completed, { status: "found", completed: 1 });
    assert.deepEqual(completion.errors, []);
    assert.deepEqual(Object.keys(builtin.lifecycle).sort(), ["onRunComplete"], "lifecycle 只剩 onRunComplete（ADR-018 D8）");
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "run", "lifecycle-run", "k.json"), "utf8")).state,
      "done",
    );
  });
});

test("assembler onRunComplete collects completeRun errors without throwing", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    const flakyStore = {
      read: (request) => backing.read(request),
      write: (request) => backing.write(request),
      list: (request) => backing.list(request),
      revoke: (request) => backing.revoke(request),
      purge: (request) => backing.purge(request),
      complete: async () => {
        throw new Error("complete boom");
      },
    };
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: flakyStore,
      runId: "flaky-run",
    });
    const completion = await builtin.lifecycle.onRunComplete();
    assert.equal(completion.completed, undefined);
    assert.equal(completion.errors.length, 1);
    assert.equal(completion.errors[0].operation, "notes_complete_run");
    assert.match(completion.errors[0].error.message, /complete boom/);
  });
});

test("assembler reports notes write failures via the host persistence bridge (port=notes)", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    const failingStore = {
      read: backing.read.bind(backing),
      list: backing.list.bind(backing),
      complete: backing.complete.bind(backing),
      revoke: backing.revoke.bind(backing),
      purge: backing.purge.bind(backing),
      write: async () => {
        const error = new Error("disk full");
        error.name = "NotesStoreError";
        throw error;
      },
    };
    const reports = [];
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: failingStore,
      runId: "report-run",
    });
    const result = JSON.parse(await builtin.executors("note_take", { key: "k", content: "v" }, {
      reportPersistenceFailure: async (info) => {
        reports.push(info);
      },
    }));
    assert.equal(result.status, "invalid");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].port, "notes");
    assert.equal(reports[0].operation, "write");
    assert.match(reports[0].error.message, /disk full/);
  });
});

test("assembler lifecycle binds reporter from lifecycle input and classifies complete/revoke as write side effects", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    const failingStore = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      list: backing.list.bind(backing),
      revoke: backing.revoke.bind(backing),
      purge: backing.purge.bind(backing),
      complete: async () => {
        throw new Error("complete write boom");
      },
    };
    const reports = [];
    const reporter = async (info) => {
      reports.push(info);
    };
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: failingStore,
      runId: "lifecycle-report-run",
    });
    const completion = await builtin.lifecycle.onRunComplete({ reportPersistenceFailure: reporter });
    assert.equal(completion.errors.length, 1);
    assert.equal(reports.length, 1, "complete 失败必须经桥上报");
    assert.equal(reports[0].operation, "complete");
    assert.equal(reports[0].port, "notes");
    assert.equal(reports[0].phase, "write", "complete 真实写文件，不得报 read");
    assert.equal(reports[0].sideEffect, "executed_uncommitted");
    // revoke 失败（note_forget 路径）：同样是写副作用，分类一致
    reports.length = 0;
    const failingRevoke = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      list: backing.list.bind(backing),
      revoke: async () => {
        throw new Error("revoke write boom");
      },
      purge: backing.purge.bind(backing),
      complete: backing.complete.bind(backing),
    };
    const forgetBuiltin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: failingRevoke,
      runId: "lifecycle-report-run",
    });
    await forgetBuiltin.executors("note_take", { key: "k", content: "v" }, {});
    await forgetBuiltin.executors("note_forget", { key: "k" }, {
      reportPersistenceFailure: reporter,
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].operation, "revoke");
    assert.equal(reports[0].phase, "write");
    assert.equal(reports[0].sideEffect, "executed_uncommitted");
    // restore：lifecycle 之后 reporter 不得泄漏到无 reporter 的调用
    reports.length = 0;
    await builtin.lifecycle.onRunComplete();
    assert.equal(reports.length, 0, "未注入 reporter 的 lifecycle 调用不得上报");
  });
});

test("assembler reports distinct operations separately even when they share one Error object", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    const shared = new Error("shared boom");
    const failingStore = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      list: backing.list.bind(backing),
      // complete 与 revoke 复用同一 Error 对象：去重粒度是 (error, operation)，
      // 两个 operation 必须各报一次，第二次不得被吞。
      complete: async () => { throw shared; },
      revoke: async () => { throw shared; },
      purge: async () => ({ status: "found", scanned: 0, purged: 0 }),
    };
    const reports = [];
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: failingStore,
      runId: "shared-error-run",
    });
    await builtin.executors("note_take", { key: "k", content: "v" }, {});
    await builtin.lifecycle.onRunComplete({
      reportPersistenceFailure: (info) => reports.push(info),
    });
    await builtin.executors("note_forget", { key: "k" }, {
      reportPersistenceFailure: (info) => reports.push(info),
    });
    assert.equal(reports.length, 2);
    assert.deepEqual(
      reports.map((report) => report.operation).sort(),
      ["complete", "revoke"],
    );
  });
});

test("assembler semanticStateProvider reports list failure only when a reporter is injected", async () => {
  await withDirectory(async (directory) => {
    const failingStore = {
      read: async () => undefined,
      write: async () => {},
      list: async () => { throw new Error("list boom"); },
      complete: async () => ({ status: "found", completed: 0 }),
      revoke: async () => ({ status: "missing", revoked: 0 }),
      purge: async () => ({ status: "found", scanned: 0, purged: 0 }),
    };
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: failingStore,
      runId: "sem-fail-run",
    });
    // 未注入 reporter（fold 点真实形态）：静默返回 undefined，不装懂也不上报
    const silent = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.equal(silent, undefined);
    // 显式注入：对外仍返回 undefined，但补发一条可观察诊断
    const reports = [];
    const reported = await builtin.semanticStateProvider({
      state: { stateVersion: 1 },
      reportPersistenceFailure: (info) => reports.push(info),
    });
    assert.equal(reported, undefined);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].port, "notes");
    assert.equal(reports[0].operation, "list");
    assert.equal(reports[0].phase, "read");
    assert.equal(reports[0].sideEffect, "not_started");
  });
});

test("assembler semanticStateProvider sorts, caps at 20, and echoes stateVersion", async () => {
  await withDirectory(async (directory) => {
    const builtin = createBuiltinNotesTools({ notesDir: directory, runId: "sem-run" });
    const store = createFileNotesStore({ dir: directory });
    const timestamp = (index) => new Date(Date.UTC(2026, 8, 16, 0, index)).toISOString();
    for (let index = 0; index < 25; index += 1) {
      await store.write({
        scopeRef: "sem-run",
        key: `note_${index}`,
        record: {
          key: `note_${index}`,
          scope: "run",
          scopeRef: "sem-run",
          current: { content: `value ${index}` },
          superseded: [],
          folded: 0,
          pinned: index === 3,
          tags: [],
          relevance: 0.5,
          state: "active",
          created_at: timestamp(index),
          updated_at: timestamp(index),
        },
      });
    }
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 9 } });
    assert.equal(provided.version, 9);
    assert.equal(provided.status, "ok");
    const lines = provided.text.split("\n");
    assert.equal(lines.length, 21, "标题 + 20 条封顶");
    assert.match(lines[1], /- note_3 \(★ @agent\): value 3/, "pinned 排最前");
    // 其余按 updated_at 倒序：最新（index 24）在 pinned 之后第一行
    assert.match(lines[2], /- note_24 \(@agent\): value 24/);
  });
});

test("assembler default notesStore is a single shared file-store instance", async () => {
  await withDirectory(async (directory) => {
    const notesDir = path.join(directory, "default-store");
    const builtin = createBuiltinNotesTools({ notesDir, runId: "default-run" });
    // executeTool 写入 → semanticStateProvider（同一 store + scope）必须能列出
    await builtin.executeTool("note_take", { key: "k", content: "shared" });
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.match(provided.text, /- k \(@agent\): shared/);
    // lifecycle（同一 store）complete 后落盘在 notesDir 下
    await builtin.lifecycle.onRunComplete();
    assert.equal(
      JSON.parse(await readFile(path.join(notesDir, "run", "default-run", "k.json"), "utf8")).state,
      "done",
    );
  });
});

test("resolveNotesDir honors explicit value, ERIX_NOTES_DIR, then the home default", () => {
  const saved = process.env.ERIX_NOTES_DIR;
  try {
    delete process.env.ERIX_NOTES_DIR;
    assert.equal(resolveNotesDir("/explicit/dir"), "/explicit/dir");
    assert.equal(resolveNotesDir(), path.join(homedir(), ".erix", "notes"));
    process.env.ERIX_NOTES_DIR = "/env/dir";
    assert.equal(resolveNotesDir(), "/env/dir");
    assert.equal(resolveNotesDir("/explicit/dir"), "/explicit/dir");
  } finally {
    if (saved === undefined) delete process.env.ERIX_NOTES_DIR;
    else process.env.ERIX_NOTES_DIR = saved;
  }
});

test("assembler creation throws TypeError when the store lacks revoke or purge", async () => {
  await withDirectory(async (directory) => {
    assert.throws(
      () => createBuiltinNotesTools({
        notesDir: directory,
        notesStore: { write() {}, read() {}, list() {}, complete() {} },
        runId: "incomplete-run",
      }),
      /revoke/u,
    );
    assert.throws(
      () => createBuiltinNotesTools({
        notesDir: directory,
        notesStore: {
          write() {}, read() {}, list() {}, complete() {}, revoke() {},
        },
        runId: "incomplete-run",
      }),
      /purge/u,
    );
  });
});

// ADR-018 D8：liveness 端口已整体删除——宿主拿着公开 store.list + store.revoke
// 原语自建清理循环（生死判定的知识本来就在宿主：调度器状态/进程表/最后心跳）。
// 这两条例测试就是宿主侧循环的参考实现。
async function hostSweepInactiveScopes(store, { scopeRefs, reason } = {}) {
  let revoked = 0;
  let skipped = 0;
  const errors = [];
  for (const scopeRef of scopeRefs) {
    let records;
    try {
      records = (await store.list({ scope: "run", scopeRef, filters: { state: "active" } }))
        .map((record) => normalizeNoteRecord(record));
    } catch (error) {
      errors.push({ operation: "notes_host_sweep", scopeRef, error });
      continue;
    }
    for (const record of records) {
      if (record.state !== "active") continue;
      try {
        const result = await store.revoke({
          scope: "run",
          scopeRef,
          key: record.key,
          reason: reason ?? "scope_inactive",
          expectedState: "active",
          expectedUpdatedAt: record.updated_at,
        });
        if (result.status === "found") revoked += 1;
        else skipped += 1;
      } catch (error) {
        errors.push({ operation: "notes_host_sweep", scopeRef, key: record.key, error });
      }
    }
  }
  return { revoked, skipped, ...(errors.length > 0 ? { errors } : {}) };
}

test("host-built orphan cleanup loop revokes only the scopes the host judges dead", async () => {
  await withDirectory(async (directory) => {
    const store = createFileNotesStore({ dir: directory });
    await note_take({ key: "a", content: "va", __erix: { runId: "live-scope", notesDir: directory } });
    await note_take({ key: "b", content: "vb", __erix: { runId: "dead-scope", notesDir: directory } });
    // 宿主的生死判定（等价于已删除的 liveness.isAlive）：只扫自己判死的 scope。
    const hostJudgedDead = (scopeRef) => scopeRef === "dead-scope";
    const deadScopes = ["live-scope", "dead-scope"].filter(hostJudgedDead);
    const result = await hostSweepInactiveScopes(store, { scopeRefs: deadScopes });
    assert.deepEqual(result, { revoked: 1, skipped: 0 });
    assert.equal(
      JSON.parse(await note_read({ key: "a", __erix: { runId: "live-scope", notesDir: directory } })).state,
      "active",
    );
    assert.equal(
      JSON.parse(await note_read({ key: "b", __erix: { runId: "dead-scope", notesDir: directory } })).status,
      "revoked",
    );
    const tombstone = JSON.parse(await readFile(
      path.join(directory, "run", "dead-scope", "b.json"),
      "utf8",
    ));
    assert.equal(tombstone.state, "revoked");
    assert.equal(tombstone.revoke_reason, "scope_inactive");
  });
});

test("host-built cleanup loop: expected-state guard turns racy revokes into unchanged", async () => {
  await withDirectory(async (directory) => {
    await note_take({ key: "racy", content: "v", __erix: { runId: "racy-scope", notesDir: directory } });
    const backing = createFileNotesStore({ dir: directory });
    const racingStore = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      list: backing.list.bind(backing),
      complete: backing.complete.bind(backing),
      revoke: backing.revoke.bind(backing),
      purge: backing.purge.bind(backing),
    };
    // 模拟并发：宿主读取与 revoke 之间记录被改写（陈旧读）——
    // expectedUpdatedAt 护栏命中，unchanged，不覆盖新值。
    const originalRevoke = racingStore.revoke;
    racingStore.revoke = async (request) => (
      request.key === "racy"
        ? { status: "unchanged", revoked: 0 }
        : originalRevoke(request)
    );
    const result = await hostSweepInactiveScopes(racingStore, { scopeRefs: ["racy-scope"] });
    assert.deepEqual(result, { revoked: 0, skipped: 1 });
    assert.equal(
      JSON.parse(await note_read({ key: "racy", __erix: { runId: "racy-scope", notesDir: directory } })).state,
      "active",
    );
  });
});

// ---------------------------------------------------------------------------
// 契约收窄（ADR-018 D3 决策反转）：semanticStateProvider 进程内缓存退化为
// 纯 epoch 短路——无写入时零 list 调用，写入后重渲染，list 失败返回 undefined。
// ---------------------------------------------------------------------------

test("assembler semanticStateProvider reuses cached text within one epoch without relisting", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    let listCalls = 0;
    const spyStore = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      complete: backing.complete.bind(backing),
      revoke: backing.revoke.bind(backing),
      purge: backing.purge.bind(backing),
      list: async (request) => {
        listCalls += 1;
        return backing.list(request);
      },
    };
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: spyStore,
      runId: "sem-cache-run",
    });
    await builtin.executeTool("note_take", { key: "cached", content: "cached-value" });
    listCalls = 0;

    const first = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.match(first.text, /- cached \(@agent\): cached-value/);
    assert.equal(listCalls, 1);

    // 同 epoch：直接复用缓存文本，不再调 list（也就不读任何记录文件）。
    const second = await builtin.semanticStateProvider({ state: { stateVersion: 2 } });
    assert.equal(second.text, first.text);
    assert.equal(second.version, 2, "version 仍回声当前 stateVersion（stale 语义不变）");
    assert.equal(listCalls, 1, "同 epoch 内不得重复 list");
  });
});

test("assembler semanticStateProvider rerenders after a write advances the epoch", async () => {
  await withDirectory(async (directory) => {
    const builtin = createBuiltinNotesTools({ notesDir: directory, runId: "sem-rev-run" });
    await builtin.executeTool("note_take", { key: "before", content: "first-value" });
    const first = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.match(first.text, /before/);

    // 新写入推进 epoch → 目录更新，缓存替换。
    await builtin.executeTool("note_take", { key: "after", content: "second-value" });
    const second = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.match(second.text, /after \(@agent\): second-value/);
    assert.equal(second.text.includes("second-value"), true);

    // note_forget 经 store.revoke 推进 epoch → 目录重渲染，墓碑不进目录。
    await builtin.executeTool("note_take", { key: "keep", content: "kept" });
    await builtin.executeTool("note_forget", { key: "before" });
    const third = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.equal(third.text.includes("before"), false, "revoked 记录不进目录");
    assert.match(third.text, /after \(@agent\): second-value/);
    assert.match(third.text, /keep \(@agent\): kept/);

    // complete（active → done）同样推进 epoch；全部 done 后目录为空 →
    // 返回 undefined（不装懂），旧缓存不得冒充最新。
    await builtin.lifecycle.onRunComplete();
    const emptied = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.equal(emptied, undefined, "无 active 记录时目录为 undefined");
  });
});

test("assembler semanticStateProvider list failure returns undefined and never serves stale cache", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    let failLists = false;
    const flakyStore = {
      read: backing.read.bind(backing),
      write: backing.write.bind(backing),
      complete: backing.complete.bind(backing),
      revoke: backing.revoke.bind(backing),
      purge: backing.purge.bind(backing),
      list: async (request) => {
        if (failLists) throw new Error("list transient boom");
        return backing.list(request);
      },
    };
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: flakyStore,
      runId: "sem-stale-run",
    });
    await builtin.executeTool("note_take", { key: "k", content: "v" });
    const cached = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.match(cached.text, /- k \(@agent\): v/);

    // list 失败：重验证路径（先有一次推进 epoch 的写入）上 list 抛错 →
    // 返回 undefined 并上报，绝不拿旧 cache 冒充最新。
    failLists = true;
    await builtin.executeTool("note_take", { key: "k-mutation", content: "v" });
    const reports = [];
    const failed = await builtin.semanticStateProvider({
      state: { stateVersion: 2 },
      reportPersistenceFailure: (info) => reports.push(info),
    });
    assert.equal(failed, undefined);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].operation, "list");
    assert.equal(reports[0].phase, "read");

    // 恢复后重新渲染（缓存未被错误地保留为“最新”）。
    failLists = false;
    await builtin.executeTool("note_take", { key: "k2", content: "v2" });
    const recovered = await builtin.semanticStateProvider({ state: { stateVersion: 3 } });
    assert.match(recovered.text, /k2 \(@agent\): v2/);
    assert.match(recovered.text, /k-mutation \(@agent\): v/);
  });
});

// ---------------------------------------------------------------------------
// issue #570：note_take 补 summary 写入口。
// 目录（renderNotesDirectory）一直读 current.summary，但工具面没有这个入参——
// 读侧有槽、写侧无门。下面每一格钉住贯穿链上的一环：schema → 落盘 → 读回 →
// 清单 → 目录；另有一格钉住「不传 summary 时老记录形状逐字不变」。
// ---------------------------------------------------------------------------

// 真机形态的正文：首行 107 字符，60 字符窗口被 uuid 与时刻占满，主题在窗口之外。
const FOLDING_CONTENT = "折走存档：第 12 次折叠（run 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b，"
  + "2026-10-29T03:14:15.926Z）：主题=note_take 补 summary 写入口";
const FOLDING_SUMMARY = "第 12 次折叠：note_take 补 summary 写入口";

test("note_take declares summary (≤120) and writes it into current.summary", async () => {
  const definition = createBuiltinNotesTools({ runId: "summary-schema-run" })
    .definitions.find((tool) => tool.name === "note_take");
  assert.deepEqual(definition.inputSchema.properties.summary, {
    type: "string",
    maxLength: MAX_SUMMARY_LENGTH,
  });
  assert.equal(MAX_SUMMARY_LENGTH, 120);
  assert.equal(definition.inputSchema.required.includes("summary"), false, "summary 可选");

  await withDirectory(async (directory) => {
    const scope = { runId: "summary-schema-run", notesDir: directory };
    const saved = JSON.parse(await note_take({
      key: "fold_12",
      content: FOLDING_CONTENT,
      summary: FOLDING_SUMMARY,
      __erix: scope,
    }));
    assert.equal(saved.status, "found");
    assert.equal(saved.action, "saved");
    const onDisk = JSON.parse(await readFile(
      path.join(directory, "run", "summary-schema-run", "fold_12.json"),
      "utf8",
    ));
    // 目录读的是 current.summary：落在别处（例如 artifactRef.summary）等于没写。
    assert.equal(onDisk.current.summary, FOLDING_SUMMARY);
    assert.equal(onDisk.current.content, FOLDING_CONTENT);
  });
});

test("note_read and note_list both carry summary (issue #570 读回投影)", async () => {
  await withDirectory(async (directory) => {
    const scope = { runId: "summary-read-run", notesDir: directory };
    await note_take({
      key: "fold_12",
      content: FOLDING_CONTENT,
      summary: FOLDING_SUMMARY,
      tags: ["decision"],
      __erix: scope,
    });
    const read = JSON.parse(await note_read({ key: "fold_12", __erix: scope }));
    assert.equal(read.current.summary, FOLDING_SUMMARY, "note_read 的 current 投影带 summary");
    assert.equal(read.value, FOLDING_CONTENT);

    const listed = JSON.parse(await note_list({ __erix: scope }));
    assert.equal(listed.count, 1);
    assert.equal(listed.notes[0].summary, FOLDING_SUMMARY, "note_list 的 listEntry 带 summary");
    // 清单仍不泄露正文（既有边界不变）。
    assert.equal(listed.notes[0].hasContent, true);
    assert.equal("content" in listed.notes[0], false);
  });
});

test("same-key rewrite moves the old summary into the superseded chain", async () => {
  await withDirectory(async (directory) => {
    const scope = { runId: "summary-supersede-run", notesDir: directory };
    await note_take({
      key: "fold",
      content: "第一次折叠的正文",
      summary: "第一次折叠：旧主题",
      __erix: scope,
    });
    const updated = JSON.parse(await note_take({
      key: "fold",
      content: "第二次折叠的正文",
      summary: "第二次折叠：新主题",
      __erix: scope,
    }));
    assert.equal(updated.action, "updated");
    assert.equal(updated.superseded, 1);

    const read = JSON.parse(await note_read({ key: "fold", __erix: scope }));
    assert.equal(read.current.summary, "第二次折叠：新主题");
    assert.equal(read.superseded.length, 1);
    assert.equal(read.superseded[0].summary, "第一次折叠：旧主题", "旧 summary 随旧 current 进 superseded");
    assert.equal(read.superseded[0].content, "第一次折叠的正文");
    assert.equal(read.superseded[0].invalid, true);

    // MAX_SUPERSEDED 语义不变：第 4 次写入后仍是 3 条、folded 不涨；第 5 次写入
    // 把最老的一条折进 folded（旧 summary 跟着被折走的那条一起走）。
    await note_take({ key: "fold", content: "第三次", summary: "第三次", __erix: scope });
    await note_take({ key: "fold", content: "第四次", summary: "第四次", __erix: scope });
    const capped = JSON.parse(await note_read({ key: "fold", __erix: scope }));
    assert.equal(capped.superseded.length, 3);
    assert.equal(capped.folded, 0);
    assert.deepEqual(
      capped.superseded.map((entry) => entry.summary),
      ["第一次折叠：旧主题", "第二次折叠：新主题", "第三次"],
    );

    // 更新时不传 summary：新 current 不得凭空长出 summary 键（老形状逐字不变），
    // 而旧 summary 已经在 superseded 里留档。
    await note_take({ key: "fold", content: "第五次", __erix: scope });
    const withoutSummary = JSON.parse(await note_read({ key: "fold", __erix: scope }));
    assert.deepEqual(Object.keys(withoutSummary.current).sort(), ["content", "provenance", "ts"]);
    assert.equal(withoutSummary.folded, 1, "MAX_SUPERSEDED 语义不变");
    assert.deepEqual(
      withoutSummary.superseded.map((entry) => entry.summary),
      ["第二次折叠：新主题", "第三次", "第四次"],
    );
  });
});

test("note_take without summary keeps the record shape byte-identical", async () => {
  await withDirectory(async (directory) => {
    const scope = { runId: "no-summary-run", notesDir: directory };
    await note_take({ key: "plain", content: "纯正文", __erix: scope });
    const onDisk = JSON.parse(await readFile(
      path.join(directory, "run", "no-summary-run", "plain.json"),
      "utf8",
    ));
    assert.deepEqual(Object.keys(onDisk.current).sort(), ["content", "provenance", "ts"]);
    assert.equal("summary" in onDisk.current, false);
    const read = JSON.parse(await note_read({ key: "plain", __erix: scope }));
    assert.deepEqual(Object.keys(read.current).sort(), ["content", "provenance", "ts"]);
    const listed = JSON.parse(await note_list({ __erix: scope }));
    assert.equal("summary" in listed.notes[0], false);
    assert.equal(JSON.stringify(listed).includes("summary"), false);
    // 空白串按「未提供」处理：不写这个键，目录行不会被空摘要清空。
    await note_take({ key: "blank-summary", content: "正文首行", summary: "   ", __erix: scope });
    const blank = JSON.parse(await readFile(
      path.join(directory, "run", "no-summary-run", "blank-summary.json"),
      "utf8",
    ));
    assert.equal("summary" in blank.current, false);
  });
});

test("summary over 120 chars returns the existing invalid shape (never throws, never truncates)", async () => {
  await withDirectory(async (directory) => {
    const scope = { runId: "summary-invalid-run", notesDir: directory };
    const tooLong = JSON.parse(await note_take({
      key: "too-long",
      content: "正文",
      summary: "x".repeat(MAX_SUMMARY_LENGTH + 1),
      __erix: scope,
    }));
    assert.equal(tooLong.status, "invalid");
    assert.equal(tooLong.key, "too-long");
    assert.match(tooLong.reason, /summary 不得超过 120 个字符/u);
    assert.equal(typeof tooLong.next, "string");
    // 不是静默截断：什么都没落盘。
    assert.equal(
      JSON.parse(await note_read({ key: "too-long", __erix: scope })).status,
      "missing",
    );
    // 非字符串同样是既有 invalid 形状。
    const notString = JSON.parse(await note_take({
      key: "not-string",
      content: "正文",
      summary: 42,
      __erix: scope,
    }));
    assert.equal(notString.status, "invalid");
    assert.match(notString.reason, /summary 必须是字符串/u);
    // 边界：正好 120 字符合法。
    const boundary = JSON.parse(await note_take({
      key: "boundary",
      content: "正文",
      summary: "y".repeat(MAX_SUMMARY_LENGTH),
      __erix: scope,
    }));
    assert.equal(boundary.status, "found");
    assert.equal(
      JSON.parse(await note_read({ key: "boundary", __erix: scope })).current.summary.length,
      MAX_SUMMARY_LENGTH,
    );
  });
});

test("summary over 120 chars through the tool registry is a schema violation, not a throw", async () => {
  await withDirectory(async (directory) => {
    const builtin = createBuiltinNotesTools({ notesDir: directory, runId: "summary-registry-run" });
    const rejected = await builtin.executeTool("note_take", {
      key: "too-long",
      content: "正文",
      summary: "x".repeat(MAX_SUMMARY_LENGTH + 1),
    });
    // 与 content 越界同一条既有口径（registry 的 schema 校验，不是异常）。
    assert.equal(typeof rejected, "string");
    assert.match(rejected, /field "summary" exceeds maxLength 120/u);
    assert.equal(
      JSON.parse(await builtin.executeTool("note_read", { key: "too-long" })).status,
      "missing",
    );
  });
});
