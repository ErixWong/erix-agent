import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createBuiltinNotesTools,
  note_read,
  note_take,
} from "../../src/tools/notes.js";
import * as skillNotes from "../../skills/notes/skill.mjs";
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

test("builtin notes tools expose a provider and sanitize into the host scope", async () => {
  await withDirectory(async (directory) => {
    const notesStore = createFileNotesStore({ dir: directory });
    const builtin = createBuiltinNotesTools({
      notesDir: path.join(directory, "unused"),
      notesStore,
      runId: "builtin-run",
    });

    assert.deepEqual(
      (await builtin.listTools()).map((tool) => tool.name),
      ["note_take", "note_read", "note_list", "note_forget"],
    );
    assert.ok(builtin.provider);
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
    assert.deepEqual(await builtin.notesCompleteRun(), { status: "found", completed: 1 });
    assert.equal(
      JSON.parse(await readFile(path.join(directory, "run", "builtin-run", "answer.json"), "utf8"))
        .state,
      "done",
    );
  });
});

test("bundled skill entry re-exports the source implementation", () => {
  assert.equal(skillNotes.note_take, note_take);
  assert.equal(skillNotes.note_read, note_read);
  assert.equal(typeof skillNotes.getSkillDefinition, "function");
});
