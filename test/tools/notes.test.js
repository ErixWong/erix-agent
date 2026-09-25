import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  createBuiltinNotesTools,
  note_read,
  note_take,
  resolveNotesDir,
} from "../../src/tools/notes.js";
import { createFileNotesStore } from "../../src/store/notes.js";

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-builtin-notes-"));
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
      ["write", "read", "list", "complete", "janitor"].map((method) => [
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
    assert.deepEqual([...Object.keys(completion)].sort(), ["completed", "errors", "janitor"]);
    assert.deepEqual(completion.completed, { status: "found", completed: 1 });
    assert.deepEqual(completion.janitor, { status: "found", changed: 0, revoked: 0 });
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

test("assembler lifecycle completes before janitor and collects errors without throwing", async () => {
  await withDirectory(async (directory) => {
    const calls = [];
    const backing = createFileNotesStore({ dir: directory });
    const flakyStore = Object.fromEntries(
      ["read", "write", "list"].map((method) => [
        method,
        (request) => backing[method](request),
      ]),
    );
    flakyStore.complete = async () => {
      calls.push("complete");
      throw new Error("complete boom");
    };
    flakyStore.janitor = async () => {
      calls.push("janitor");
      return { status: "found", revoked: 0 };
    };
    const builtin = createBuiltinNotesTools({
      notesDir: directory,
      notesStore: flakyStore,
      runId: "flaky-run",
    });
    const completion = await builtin.lifecycle.onRunComplete();
    assert.deepEqual(calls, ["complete", "janitor"], "completeRun 抛错后仍须执行 janitor");
    assert.equal(completion.errors.length, 1);
    assert.equal(completion.errors[0].operation, "notes_complete_run");
    assert.match(completion.errors[0].error.message, /complete boom/);
    assert.deepEqual(completion.janitor, { status: "found", revoked: 0 });
    // onRunStart = janitor
    await builtin.lifecycle.onRunStart();
    assert.deepEqual(calls, ["complete", "janitor", "janitor"]);
  });
});

test("assembler reports notes write failures via the host persistence bridge (port=notes)", async () => {
  await withDirectory(async (directory) => {
    const backing = createFileNotesStore({ dir: directory });
    const failingStore = {
      read: backing.read.bind(backing),
      list: backing.list.bind(backing),
      complete: backing.complete.bind(backing),
      janitor: backing.janitor.bind(backing),
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
    assert.match(lines[1], /- note_3 \(★\): value 3/, "pinned 排最前");
    // 其余按 updated_at 倒序：最新（index 24）在 pinned 之后第一行
    assert.match(lines[2], /- note_24: value 24/);
  });
});

test("assembler default notesStore is a single shared file-store instance", async () => {
  await withDirectory(async (directory) => {
    const notesDir = path.join(directory, "default-store");
    const builtin = createBuiltinNotesTools({ notesDir, runId: "default-run" });
    // executeTool 写入 → semanticStateProvider（同一 store + scope）必须能列出
    await builtin.executeTool("note_take", { key: "k", content: "shared" });
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.match(provided.text, /- k: shared/);
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
