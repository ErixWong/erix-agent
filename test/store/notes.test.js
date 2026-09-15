import assert from "node:assert/strict";
import test from "node:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
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
