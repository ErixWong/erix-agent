import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as notes from "../skills/notes/skill.mjs";
import { discoverSkills, skillDirectories } from "../bin/skills.js";
import { estimateTokens } from "../src/tokens.js";

const skillPath = fileURLToPath(new URL("../skills/notes/skill.mjs", import.meta.url));

async function withNotes(callback, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-notes-test-"));
  const previous = Object.fromEntries(
    [
      "ERIX_NOTES_DIR",
      "ERIX_NOTES_GRACE_MS",
    ]
      .map((name) => [name, process.env[name]]),
  );
  process.env.ERIX_NOTES_DIR = directory;
  const previousScope = activeNotesScope;
  activeNotesScope = {
    runId: options.runId ?? "notes-test-run",
    notesDir: directory,
  };
  if (options.graceMs === undefined) delete process.env.ERIX_NOTES_GRACE_MS;
  else process.env.ERIX_NOTES_GRACE_MS = String(options.graceMs);
  try {
    return await callback(directory);
  } finally {
    activeNotesScope = previousScope;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

let activeNotesScope;
const scopedNotes = new Proxy(notes, {
  get(target, property) {
    const value = target[property];
    if (
      typeof value !== "function"
      || ![
        "note_take",
        "note_read",
        "note_list",
        "note_forget",
        "recordAutoCapture",
        "completeRun",
        "runNotesJanitor",
      ].includes(property)
    ) return value;
    return (input = {}) => value({
      ...input,
      __erix: input.__erix ?? activeNotesScope,
    });
  },
});

function parsed(value) {
  return JSON.parse(value);
}

test("notes declares four provider-safe tool names", () => {
  const definition = notes.getSkillDefinition();
  assert.equal(definition.schema_version, 1);
  assert.equal(definition.skill.id, "notes");
  assert.deepEqual(
    definition.tools.map((tool) => tool.name),
    ["note_take", "note_read", "note_list", "note_forget"],
  );
  for (const tool of definition.tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
  }
});

test("notes tool descriptions explain current and superseded recovery usage", () => {
  const tools = Object.fromEntries(
    notes.getSkillDefinition().tools.map((tool) => [tool.name, tool.description]),
  );
  for (const description of Object.values(tools)) {
    assert.match(description, /when-to-use/u);
    assert.match(description, /上下文被折叠/u);
    assert.match(description, /先 note_list，再 note_read key=/u);
    assert.match(description, /不要遍历归档目录/u);
  }
  assert.match(tools.note_read, /current/u);
  assert.match(tools.note_read, /superseded/u);
  assert.match(tools.note_read, /folded/u);
});

test("note list exposes keys and tags but never content", async () => {
  await withNotes(async (directory) => {
    await scopedNotes.note_take({
      key: "captured-nonce",
      content: "secret-value-must-not-leak",
      tags: ["value", "auto"],
      relevance: 0.9,
    });
    await scopedNotes.note_take({
      key: "ordinary",
      content: "ordinary-value",
      tags: ["fact"],
    });

    const index = parsed(await scopedNotes.note_list({}));
    assert.equal(index.status, "found");
    assert.deepEqual(index.notes.map(({ key, tags }) => ({ key, tags })), [
      { key: "captured-nonce", tags: ["value", "auto"] },
      { key: "ordinary", tags: ["fact"] },
    ]);
    assert.doesNotMatch(JSON.stringify(index), /secret-value-must-not-leak/u);
  });
});

test("note list sorts by relevance and filters bounded metadata", async () => {
  await withNotes(async () => {
    await scopedNotes.note_take({
      key: "low",
      content: "low",
      relevance: 0.2,
      tags: ["old"],
    });
    await scopedNotes.note_take({
      key: "high",
      content: "high",
      relevance: 0.9,
      tags: ["important"],
    });
    await scopedNotes.recordAutoCapture({
      key: "auto",
      artifactRef: {
        archivePath: "/run/archive/001-exec.txt",
        digest: "a".repeat(64),
        locator: { lineStart: 1, lineEnd: 1 },
      },
      provenance: { source: "auto" },
    });

    const listed = parsed(await scopedNotes.note_list({ limit: 2 }));
    assert.equal(listed.count, 2);
    assert.equal(listed.total, 3);
    assert.deepEqual(listed.notes.map((note) => [note.key, note.relevance]), [
      ["high", 0.9],
      ["auto", 0.8],
    ]);
    assert.equal(listed.notes[1].source, "auto");
    assert.deepEqual(
      parsed(await scopedNotes.note_list({ minRelevance: 0.8 })).notes.map((note) => note.key),
      ["high", "auto"],
    );
    assert.deepEqual(
      parsed(await scopedNotes.note_list({ tag: "old", source: "agent" }))
        .notes.map((note) => note.key),
      ["low"],
    );
  });
});

test("take/read/list supports current, superseded, and folded content", async () => {
  await withNotes(async (directory) => {
    assert.equal(parsed(await scopedNotes.note_take({
      key: "answer",
      content: "first",
      tags: ["value"],
      pinned: true,
    })).status, "found");
    const same = parsed(await scopedNotes.note_take({
      key: "answer",
      content: "first",
      tags: ["value"],
    }));
    assert.equal(same.status, "found");
    assert.equal(same.superseded, 1);

    const updated = parsed(await scopedNotes.note_take({
      key: "answer",
      content: "second",
      tags: ["value", "decision"],
      pinned: true,
    }));
    assert.equal(updated.status, "found");
    assert.equal(updated.superseded, 2);
    const current = parsed(await scopedNotes.note_read({ key: "answer" }));
    assert.equal(current.value, "second");
    assert.equal(current.current.content, "second");
    assert.equal(current.superseded.length, 2);
    assert.equal(current.folded, 0);

    const listed = parsed(await scopedNotes.note_list({ tag: "decision" }));
    assert.equal(listed.status, "found");
    assert.equal(listed.total, 1);
    assert.equal(listed.notes[0].hasContent, true);
    assert.equal("content" in listed.notes[0], false);
    assert.equal("value" in listed.notes[0], false);

    const record = parsed(await readFile(
      path.join(directory, "run", "notes-test-run", "answer.json"),
      "utf8",
    ));
    assert.equal(record.current.content, "second");
    assert.equal(record.superseded.length, 2);
    assert.equal(record.folded, 0);
  });

});

test("list and read make value and reference notes distinguishable", async () => {
  await withNotes(async () => {
    await scopedNotes.note_take({ key: "value-note", content: "available" });
    await scopedNotes.recordAutoCapture({
      key: "reference-note",
      artifactRef: {
        archivePath: "/run/archive/001-exec.txt",
        digest: "a".repeat(64),
        locator: { lineStart: 2, lineEnd: 2 },
      },
      provenance: { verified: false },
    });

    const listed = parsed(await scopedNotes.note_list({}));
    const valueNote = listed.notes.find((note) => note.key === "value-note");
    const referenceNote = listed.notes.find((note) => note.key === "reference-note");
    assert.equal(valueNote.hasContent, true);
    assert.equal(referenceNote.hasArtifactRef, true);

    const read = parsed(await scopedNotes.note_read({ key: "reference-note" }));
    assert.equal(read.status, "found");
    assert.match(read.next, /locator/u);
    assert.equal(read.artifactRef.locator.lineStart, 2);
  });
});

test("per-key writes retain at most three superseded entries and fold older history", async () => {
  await withNotes(async (directory) => {
    for (let index = 0; index < 8; index += 1) {
      await scopedNotes.note_take({ key: "concurrent", content: `value-${index}` });
    }
    const record = parsed(await readFile(
      path.join(directory, "run", "notes-test-run", "concurrent.json"),
      "utf8",
    ));
    assert.equal(record.superseded.length, 3);
    assert.equal(record.folded, 4);
    const current = parsed(await scopedNotes.note_read({ key: "concurrent" }));
    assert.equal(current.value, "value-7");
    assert.equal(current.superseded.length, 3);
  });
});

test("concurrent keys and completion do not overwrite each other", async () => {
  await withNotes(async (directory) => {
    const results = await Promise.all([
      scopedNotes.note_take({ key: "alpha", content: "a" }),
      scopedNotes.note_take({ key: "beta", content: "b" }),
    ]);
    assert.deepEqual(results.map((value) => parsed(value).status), ["found", "found"]);

    await scopedNotes.note_take({ key: "lifecycle", content: "before" });
    await Promise.all([
      scopedNotes.completeRun(),
      scopedNotes.note_take({ key: "lifecycle", content: "after" }),
    ]);
    const record = parsed(await readFile(
      path.join(directory, "run", "notes-test-run", "lifecycle.json"),
      "utf8",
    ));
    assert.equal(record.state, "done");
    assert.equal(record.current.content, "after");
  });
});

test("explicit __erix scope overrides the environment scope", async () => {
  await withNotes(async () => {
    await scopedNotes.note_take({
      key: "explicit",
      content: "isolated",
      __erix: { scope: { type: "run", ref: "explicit-run" } },
    });
    assert.equal(
      parsed(await scopedNotes.note_read({ key: "explicit" })).status,
      "missing",
    );
    assert.equal(
      parsed(await scopedNotes.note_read({
        key: "explicit",
        __erix: { scopeRef: "explicit-run" },
      })).value,
      "isolated",
    );
  });
});

test("unsafe explicit scope round-trips through the skill lifecycle", async () => {
  await withNotes(async (directory) => {
    const scope = { runId: "../escape", notesDir: directory };
    assert.equal(parsed(await scopedNotes.note_take({
      key: "unsafe-scope",
      content: "safe",
      __erix: scope,
    })).status, "found");
    assert.equal(
      parsed(await scopedNotes.note_read({ key: "unsafe-scope", __erix: scope })).value,
      "safe",
    );
    assert.equal(
      parsed(await scopedNotes.note_list({ __erix: scope })).total,
      1,
    );
    assert.deepEqual(await scopedNotes.completeRun({ __erix: scope }), {
      status: "found",
      completed: 1,
    });
    assert.deepEqual(await scopedNotes.runNotesJanitor({ __erix: scope }), {
      status: "found",
      changed: 0,
      revoked: 0,
    });
    const runEntries = await readdir(path.join(directory, "run"));
    assert.equal(runEntries.length, 1);
    assert.match(runEntries[0], /^run-h-[0-9a-f]{24}$/u);
    const stored = JSON.parse(await readFile(
      path.join(directory, "run", runEntries[0], "unsafe-scope.json"),
      "utf8",
    ));
    assert.equal(stored.scopeRef, runEntries[0]);
    assert.equal(stored.state, "done");
  });
});

test("pinned notes are scoped and retain provenance metadata", async () => {
  await withNotes(async () => {
    await scopedNotes.note_take({
      key: "long-value",
      content: "值".repeat(300),
      pinned: true,
    });
    const longRead = parsed(await scopedNotes.note_read({ key: "long-value" }));
    assert.equal(longRead.pinned, true);
    assert.equal(longRead.value.length, 300);
    await scopedNotes.note_forget({ key: "long-value" });
    await scopedNotes.note_take({
      key: "pinned-value",
      content: "short",
      pinned: true,
      provenance: { source: "auto", round: 3, toolUseId: "tool-123" },
    });
    await scopedNotes.note_take({ key: "not-pinned", content: "hidden" });

    const listed = parsed(await scopedNotes.note_list({ includeInactive: true }));
    assert.ok(listed.notes.some((entry) => entry.key === "pinned-value" && entry.pinned));
    assert.ok(!listed.notes.some((entry) => entry.key === "not-pinned" && entry.pinned));
    const read = parsed(await scopedNotes.note_read({ key: "pinned-value" }));
    assert.equal(read.provenance.source, "agent");
    assert.equal(read.provenance.round, 3);
    assert.equal(read.provenance.toolUseId, "tool-123");
  });
});

test("tool provenance cannot claim auto capture while the private capture arm can", async () => {
  await withNotes(async () => {
    const artifactRef = {
      artifactId: "001-exec.txt",
      archivePath: "/run/archive/001-exec.txt",
      digest: "a".repeat(64),
      locator: { lineStart: 1, lineEnd: 1 },
    };
    await scopedNotes.note_take({
      key: "tool-written",
      artifactRef,
      provenance: { source: "auto", verified: false },
    });
    assert.equal(
      parsed(await scopedNotes.note_read({ key: "tool-written" })).provenance.source,
      "agent",
    );
    await scopedNotes.recordAutoCapture({
      key: "auto-written",
      artifactRef,
      provenance: { source: "auto", toolUseId: "tool-1" },
    });
    const captured = parsed(await scopedNotes.note_read({ key: "auto-written" }));
    assert.equal(captured.provenance.source, "auto");
    assert.equal(captured.provenance.toolUseId, "tool-1");
  });
});

test("missing and revoked notes are explicit and retain a tombstone", async () => {
  await withNotes(async (directory) => {
    const missing = parsed(await scopedNotes.note_read({ key: "unknown" }));
    assert.equal(missing.status, "missing");
    assert.match(missing.next, /未记录、不可恢复；不得重跑命令、不得凭记忆给值/);

    await scopedNotes.note_take({ key: "important-plan", content: "do this" });
    const forgotten = parsed(await scopedNotes.note_forget({ key: "important-plan" }));
    assert.equal(forgotten.status, "revoked");
    const revoked = parsed(await scopedNotes.note_read({ key: "important-plan" }));
    assert.equal(revoked.status, "revoked");
    assert.match(revoked.next, /撤销/);

    const tombstone = parsed(await readFile(
      path.join(directory, "run", "notes-test-run", "important-plan.json"),
      "utf8",
    ));
    assert.equal(tombstone.state, "revoked");
    assert.ok(tombstone.revoked_at);
    assert.equal(tombstone.superseded.length, 0);
    assert.equal(tombstone.folded, 0);
  });
});

test("possible credentials are rejected without writing files", async () => {
  await withNotes(async (directory) => {
    const samples = [
      ["token-value", "token: abcdefghijklmnop"],
      ["password-value", "password=not-for-notes"],
      ["bearer-value", "Bearer abcdefghijklmnop"],
      ["jwt-value", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature"],
      ["aws-value", "AKIAIOSFODNN7EXAMPLE"],
      ["github-value", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
      ["postgres-value", "postgres://u:p@h/db"],
      ["aws-secret-value", "AWS_SECRET_ACCESS_KEY=example"],
      ["database-url-value", "DATABASE_URL=postgres://u:p@h/db"],
      ["chinese-secret-value", "访问令牌: example"],
      ["private-body-value", "MIIEowIBAAKCAQEAabcdefghijklmnop"],
      ["short-openai-value", "sk-abc"],
      ["url-parameter-value", "https://example.test/?token=abc"],
    ];
    for (const [key, content] of samples) {
      const result = parsed(await scopedNotes.note_take({ key, content }));
      assert.equal(result.status, "invalid");
      assert.match(result.reason, /凭据/u);
    }
    await assert.rejects(readdir(path.join(directory, "run", "notes-test-run")));
  });
});

test("records persist across a fresh module import and use restrictive permissions", async () => {
  await withNotes(async (directory) => {
    await scopedNotes.note_take({ key: "persisted", content: "still here" });
    const reloaded = await import(`${pathToFileURL(skillPath).href}?reload=${Date.now()}`);
    const result = parsed(await reloaded.note_read({
      key: "persisted",
      __erix: { runId: "notes-test-run", notesDir: directory },
    }));
    assert.equal(result.status, "found");
    assert.equal(result.value, "still here");

    const rootStat = await stat(directory);
    const runStat = await stat(path.join(directory, "run"));
    const scopeStat = await stat(path.join(directory, "run", "notes-test-run"));
    const fileStat = await stat(path.join(directory, "run", "notes-test-run", "persisted.json"));
    assert.equal(rootStat.mode & 0o777, 0o700);
    assert.equal(runStat.mode & 0o777, 0o700);
    assert.equal(scopeStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(path.join(directory, "run", "notes-test-run"))).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

test("corruption is not silently reported as missing and unsafe keys stay inside scope", async () => {
  await withNotes(async (directory) => {
    const scope = path.join(directory, "run", "notes-test-run");
    await scopedNotes.note_take({ key: "broken", content: "ok" });
    await writeFile(path.join(scope, "broken.json"), "{not-json", "utf8");
    assert.equal(parsed(await scopedNotes.note_read({ key: "broken" })).status, "invalid");

    for (const key of ["../../x", "/tmp/absolute", "x".repeat(300)]) {
      assert.equal(parsed(await scopedNotes.note_take({ key, content: "safe" })).status, "found");
      assert.equal(parsed(await scopedNotes.note_read({ key })).value, "safe");
    }
    const entries = await readdir(scope);
    assert.equal(entries.some((name) => name === "x.json"), false);
    assert.ok(entries.every((name) => name.endsWith(".json")));
  });
});

test("project and user scopes are explicit unsupported stubs", async () => {
  await withNotes(async () => {
    for (const scope of ["project", "user"]) {
      assert.equal(parsed(await scopedNotes.note_take({ key: "x", content: "y", scope })).status, "unsupported");
      assert.equal(parsed(await scopedNotes.note_read({ key: "x", scope })).status, "unsupported");
      assert.equal(parsed(await scopedNotes.note_list({ scope })).status, "unsupported");
      assert.equal(parsed(await scopedNotes.note_forget({ key: "x", scope })).status, "unsupported");
    }
  });
});

test("run lifecycle transitions active to done and then revokes expired notes", async () => {
  await withNotes(async (directory, options) => {
    const now = { value: Date.now() };
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      await scopedNotes.note_take({ key: "lifecycle", content: "value", pinned: true });
      assert.equal(parsed(await scopedNotes.note_list({})).notes[0].state, "active");
      await scopedNotes.completeRun();
      const completed = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(completed.state, "done");
      assert.ok(completed.expires_at);

      await scopedNotes.runNotesJanitor();
      process.env.ERIX_NOTES_GRACE_MS = "0";
      now.value = Date.parse(completed.expires_at) + 1;
      await scopedNotes.runNotesJanitor();
      const tombstone = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(tombstone.state, "revoked");
      assert.ok(tombstone.revoked_at);
      assert.equal(parsed(await scopedNotes.note_read({ key: "lifecycle" })).status, "revoked");
      void options;
    } finally {
      restoreClock();
    }
  }, { graceMs: 60_000 });
});

test("janitor revokes expired notes from other sessions and filters inactive notes", async () => {
  const now = { value: Date.now() };
  await withNotes(async (directory) => {
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      await scopedNotes.note_take({ key: "orphan", content: "value" });
      assert.equal(parsed(await scopedNotes.note_list({ __erix: { runId: "current-run", notesDir: directory } })).total, 0);
      assert.equal((await scopedNotes.runNotesJanitor({ __erix: { runId: "current-run", notesDir: directory } })).status, "found");
      let orphan = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "orphan.json"),
        "utf8",
      ));
      assert.equal(orphan.state, "active");
      now.value += 1001;
      await scopedNotes.runNotesJanitor({ __erix: { runId: "current-run", notesDir: directory } });
      orphan = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "orphan.json"),
        "utf8",
      ));
      assert.equal(orphan.state, "revoked");
      assert.equal(parsed(await scopedNotes.note_list({ includeInactive: true })).total, 1);
    } finally {
      restoreClock();
    }
  }, { graceMs: 1000 });
});

test("note writes no longer expose a lock API", async () => {
  await withNotes(async (directory) => {
    await scopedNotes.note_take({ key: "lease", content: "value" });
    assert.equal(parsed(await scopedNotes.note_read({ key: "lease" })).value, "value");
  });
});

test("note files contain no lock sidecars", async () => {
  await withNotes(async (directory) => {
    await scopedNotes.note_take({
      key: "plain-note",
      content: "value",
      __erix: { runId: "notes-test-run", notesDir: directory },
    });
    const files = await readdir(path.join(directory, "run", "notes-test-run"));
    assert.equal(files.some((name) => name.endsWith(".lock")), false);
  });
});

test("completeRun and janitor report the new lifecycle statuses", async () => {
  await withNotes(async (directory) => {
    await scopedNotes.note_take({ key: "busy", content: "value" });
    assert.equal((await scopedNotes.completeRun()).status, "found");
    assert.equal((await scopedNotes.runNotesJanitor()).status, "found");
    assert.equal(parsed(await scopedNotes.note_read({ key: "busy" })).state, "done");
  });
});

test("bundled notes skill is discoverable and user notes skill overrides it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "erix-notes-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "erix-notes-cwd-"));
  try {
    const bundled = discoverSkills({ home, cwd }).find((skill) => skill.id === "notes");
    assert.equal(bundled.dir, path.resolve("skills/notes"));
    assert.ok(skillDirectories({ home, cwd }).includes(path.resolve("skills")));

    const userDirectory = path.join(home, ".erix", "skills", "notes");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(userDirectory, { recursive: true }));
    await writeFile(path.join(userDirectory, "skill.mjs"), `
      export function getSkillDefinition() {
        return {
          schema_version: 1,
          skill: { id: "notes", entrypoint: "skill.mjs" },
          tools: [{ name: "custom_note", inputSchema: { type: "object" } }]
        };
      }
      export function custom_note() { return "user"; }
    `, "utf8");
    const overridden = discoverSkills({ home, cwd }).find((skill) => skill.id === "notes");
    assert.equal(overridden.dir, userDirectory);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
