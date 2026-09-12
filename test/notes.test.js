import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as notes from "../skills/notes/skill.mjs";
import { discoverSkills, skillDirectories } from "../bin/skills.js";

const skillPath = fileURLToPath(new URL("../skills/notes/skill.mjs", import.meta.url));

async function withNotes(callback, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-notes-test-"));
  const previous = Object.fromEntries(
    ["ERIX_NOTES_DIR", "ERIX_RUN_ID", "ERIX_NOTES_GRACE_MS"]
      .map((name) => [name, process.env[name]]),
  );
  process.env.ERIX_NOTES_DIR = directory;
  process.env.ERIX_RUN_ID = options.runId ?? "notes-test-run";
  if (options.graceMs === undefined) delete process.env.ERIX_NOTES_GRACE_MS;
  else process.env.ERIX_NOTES_GRACE_MS = String(options.graceMs);
  try {
    return await callback(directory);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

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

test("take/read/list supports version history and deduplicates identical content", async () => {
  await withNotes(async (directory) => {
    assert.equal(parsed(await notes.note_take({
      key: "answer",
      content: "first",
      tags: ["value"],
      pinned: true,
    })).version, 1);
    const same = parsed(await notes.note_take({
      key: "answer",
      content: "first",
      tags: ["value"],
    }));
    assert.equal(same.status, "updated");
    assert.equal(same.version, 1);

    const updated = parsed(await notes.note_take({
      key: "answer",
      content: "second",
      tags: ["value", "decision"],
      pinned: true,
    }));
    assert.equal(updated.version, 2);
    assert.equal(parsed(await notes.note_read({ key: "answer", version: 1 })).value, "first");
    assert.equal(parsed(await notes.note_read({ key: "answer" })).value, "second");

    const listed = parsed(await notes.note_list({ tag: "decision" }));
    assert.equal(listed.status, "ok");
    assert.equal(listed.total, 1);
    assert.equal(listed.notes[0].preview, "second");
    assert.equal("content" in listed.notes[0], false);
    assert.equal("value" in listed.notes[0], false);

    const record = parsed(await readFile(
      path.join(directory, "run", "notes-test-run", "answer.json"),
      "utf8",
    ));
    assert.equal(record.versions.length, 2);
    assert.equal(record.versions[0].content, "first");
  });
});

test("pinned ledger is scoped, provenance-labeled, and stays under its token budget", async () => {
  await withNotes(async () => {
    await notes.note_take({
      key: "long-value",
      content: "值".repeat(300),
      pinned: true,
    });
    const longLedger = await notes.buildPinnedLedger({ maxEntries: 1, maxTokens: 200 });
    assert.ok(Array.from(longLedger).length <= 160);
    await notes.note_forget({ key: "long-value" });
    await notes.note_take({
      key: "pinned-value",
      content: "short",
      pinned: true,
      provenance: { source: "auto", round: 3, toolUseId: "tool-123" },
    });
    await notes.note_take({ key: "not-pinned", content: "hidden" });

    const ledger = await notes.buildPinnedLedger({ maxEntries: 5, maxTokens: 200 });
    assert.ok(Array.from(ledger).length <= 160);
    assert.match(ledger, /pinned-value/);
    assert.match(ledger, /source=agent round=3 toolUse=tool-123/);
    assert.doesNotMatch(ledger, /not-pinned/);
  });
});

test("tool provenance cannot claim auto capture while the private capture arm can", async () => {
  await withNotes(async () => {
    const artifactRef = {
      artifactId: "001-exec.txt",
      archivePath: "/run/archive/001-exec.txt",
      digest: "a".repeat(64),
      locator: { lineStart: 1, lineEnd: 1 },
      replayable: false,
    };
    await notes.note_take({
      key: "tool-written",
      artifactRef,
      provenance: { source: "auto", verified: false },
    });
    assert.equal(
      parsed(await notes.note_read({ key: "tool-written" })).provenance.source,
      "agent",
    );
    await notes.recordAutoCapture({
      key: "auto-written",
      artifactRef,
      provenance: { source: "auto", toolUseId: "tool-1" },
    });
    const captured = parsed(await notes.note_read({ key: "auto-written" }));
    assert.equal(captured.provenance.source, "auto");
    assert.equal(captured.provenance.toolUseId, "tool-1");
  });
});

test("missing and revoked notes are explicit and retain a tombstone", async () => {
  await withNotes(async (directory) => {
    const missing = parsed(await notes.note_read({ key: "unknown" }));
    assert.equal(missing.status, "missing");
    assert.match(missing.next, /未记录、不可恢复；不得重跑命令、不得凭记忆给值/);

    await notes.note_take({ key: "important-plan", content: "do this" });
    const forgotten = parsed(await notes.note_forget({ key: "important-plan" }));
    assert.equal(forgotten.status, "revoked");
    const revoked = parsed(await notes.note_read({ key: "important-plan" }));
    assert.equal(revoked.status, "revoked");
    assert.match(revoked.next, /撤销/);

    const tombstone = parsed(await readFile(
      path.join(directory, "run", "notes-test-run", "important-plan.json"),
      "utf8",
    ));
    assert.equal(tombstone.state, "revoked");
    assert.ok(tombstone.revoked_at);
    assert.equal(tombstone.versions.length, 1);
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
      const result = parsed(await notes.note_take({ key, content }));
      assert.equal(result.status, "rejected");
      assert.equal(result.reason, "possible-credential");
    }
    await assert.rejects(readdir(path.join(directory, "run", "notes-test-run")));
  });
});

test("records persist across a fresh module import and use restrictive permissions", async () => {
  await withNotes(async (directory) => {
    await notes.note_take({ key: "persisted", content: "still here" });
    const reloaded = await import(`${pathToFileURL(skillPath).href}?reload=${Date.now()}`);
    const result = parsed(await reloaded.note_read({ key: "persisted" }));
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
    await notes.note_take({ key: "broken", content: "ok" });
    await writeFile(path.join(scope, "broken.json"), "{not-json", "utf8");
    assert.equal(parsed(await notes.note_read({ key: "broken" })).status, "corrupt");

    for (const key of ["../../x", "/tmp/absolute", "x".repeat(300)]) {
      assert.equal(parsed(await notes.note_take({ key, content: "safe" })).status, "saved");
      assert.equal(parsed(await notes.note_read({ key })).value, "safe");
    }
    const entries = await readdir(scope);
    assert.equal(entries.some((name) => name === "x.json"), false);
    assert.ok(entries.every((name) => name.endsWith(".json")));
  });
});

test("project and user scopes are explicit unsupported stubs", async () => {
  await withNotes(async () => {
    for (const scope of ["project", "user"]) {
      assert.equal(parsed(await notes.note_take({ key: "x", content: "y", scope })).status, "unsupported");
      assert.equal(parsed(await notes.note_read({ key: "x", scope })).status, "unsupported");
      assert.equal(parsed(await notes.note_list({ scope })).status, "unsupported");
      assert.equal(parsed(await notes.note_forget({ key: "x", scope })).status, "unsupported");
    }
  });
});

test("run lifecycle transitions active to completed to grace and then garbage collects", async () => {
  await withNotes(async (directory, options) => {
    const now = { value: Date.now() };
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      await notes.note_take({ key: "lifecycle", content: "value", pinned: true });
      assert.equal(parsed(await notes.note_list({})).notes[0].state, "active");
      await notes.completeRun();
      const completed = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(completed.state, "completed");
      assert.ok(completed.expires_at);

      await notes.runNotesJanitor();
      const grace = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(grace.state, "grace");

      process.env.ERIX_NOTES_GRACE_MS = "0";
      await notes.note_take({ key: "lifecycle", content: "value", pinned: true });
      const retained = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(retained.state, "grace");
      assert.equal(retained.expires_at, completed.expires_at);
      now.value = Date.parse(completed.expires_at) + 1;
      await notes.completeRun();
      await notes.runNotesJanitor();
      const tombstone = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(tombstone.state, "revoked");
      assert.ok(tombstone.revoked_at);
      assert.equal(parsed(await notes.note_read({ key: "lifecycle" })).status, "revoked");
      void options;
    } finally {
      restoreClock();
    }
  }, { graceMs: 60_000 });
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
