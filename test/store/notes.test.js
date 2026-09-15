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
import * as notes from "../../skills/notes/skill.mjs";

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
      ["write", "read", "list", "complete", "janitor"].map((method) => [
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
      ["write", "read", "list", "complete", "janitor"].map((method) => [
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
    assert.deepEqual(await notes.runNotesJanitor({ __erix: scope }), {
      status: "found",
      changed: 0,
      revoked: 0,
    });
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
