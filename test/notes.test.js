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

import * as notes from "../src/tools/notes.js";
import { createBuiltinNotesTools } from "../src/tools/notes.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { discoverSkills, skillDirectories } from "../bin/skills.js";
import { estimateTokens } from "../src/tokens.js";

const HISTORICAL_TS = "2026-09-15T02:00:00.000Z";

// ADR-016：recordAutoCapture 已删；「历史 auto 记录」由测试直接写 store 构造。
function historicalAutoRecord(key, { content, artifactRef, toolUseId, relevance = 0.8 } = {}) {
  return {
    key,
    scope: "run",
    scopeRef: "notes-test-run",
    current: {
      ...(content === undefined ? {} : { content }),
      ...(artifactRef === undefined ? {} : { artifactRef }),
      provenance: {
        source: "auto",
        verified: true,
        ts: HISTORICAL_TS,
        ...(toolUseId === undefined ? {} : { toolUseId }),
      },
      ts: HISTORICAL_TS,
    },
    superseded: [],
    folded: 0,
    pinned: false,
    tags: [],
    relevance,
    state: "active",
    created_at: HISTORICAL_TS,
    updated_at: HISTORICAL_TS,
  };
}

async function seedHistoricalAutoNote(directory, record) {
  const store = createFileNotesStore({ dir: directory });
  await store.write({
    scope: "run",
    scopeRef: record.scopeRef,
    key: record.key,
    record,
  });
}

const skillPath = fileURLToPath(new URL("../src/tools/notes.js", import.meta.url));

async function withNotes(callback, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-notes-test-"));
  const previous = Object.fromEntries(
    [
      "ERIX_NOTES_DIR",
      "ERIX_NOTES_GRACE_MS",
      "ERIX_NOTES_DONE_GRACE_MS",
      "ERIX_NOTES_TOMBSTONE_RETENTION_MS",
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
  delete process.env.ERIX_NOTES_DONE_GRACE_MS;
  delete process.env.ERIX_NOTES_TOMBSTONE_RETENTION_MS;
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
  // bundled skill 定义（getSkillDefinition）已随 shim 退役；canonical 定义经 assembler 暴露。
  const definitions = createBuiltinNotesTools({ runId: "definition-run" }).definitions;
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    ["note_take", "note_read", "note_list", "note_forget"],
  );
  for (const tool of definitions) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/u);
  }
});

test("notes tool descriptions explain current and superseded recovery usage", () => {
  const tools = Object.fromEntries(
    createBuiltinNotesTools({ runId: "description-run" })
      .definitions.map((tool) => [tool.name, tool.description]),
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
  await withNotes(async (directory) => {
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
    await seedHistoricalAutoNote(directory, historicalAutoRecord("auto", {
      artifactRef: {
        archivePath: "/run/archive/001-exec.txt",
        digest: "a".repeat(64),
        locator: { lineStart: 1, lineEnd: 1 },
      },
    }));

    const listed = parsed(await scopedNotes.note_list({ limit: 2 }));
    assert.equal(listed.count, 2);
    // breaking（issue #67 PR 2）：不再承诺 total；翻页走 nextCursor。
    assert.equal("total" in listed, false);
    assert.equal(typeof listed.nextCursor, "string");
    assert.deepEqual(listed.notes.map((note) => [note.key, note.relevance]), [
      ["high", 0.9],
      ["auto", 0.8],
    ]);
    assert.equal(listed.notes[1].source, "auto");
    const rest = parsed(await scopedNotes.note_list({ cursor: listed.nextCursor }));
    assert.deepEqual(rest.notes.map((note) => note.key), ["low"]);
    assert.equal(rest.nextCursor, null);
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
    assert.equal(listed.count, 1);
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
  await withNotes(async (directory) => {
    await scopedNotes.note_take({ key: "value-note", content: "available" });
    await seedHistoricalAutoNote(directory, historicalAutoRecord("reference-note", {
      artifactRef: {
        archivePath: "/run/archive/001-exec.txt",
        digest: "a".repeat(64),
        locator: { lineStart: 2, lineEnd: 2 },
      },
    }));

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
      parsed(await scopedNotes.note_list({ __erix: scope })).count,
      1,
    );
    assert.deepEqual(await scopedNotes.completeRun({ __erix: scope }), {
      status: "found",
      completed: 1,
    });
    assert.deepEqual(await scopedNotes.runNotesJanitor({ __erix: scope }), {
      status: "found",
      scanned: 1,
      revoked: 0,
      nextCursor: null,
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

test("tool provenance cannot claim auto capture; historical auto records stay readable", async () => {
  await withNotes(async (directory) => {
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
    // 历史 auto 记录（auto-capture 退役前产生，直接写 store 构造）仍完整可读，
    // 且 note_list 的 source 过滤与 @auto 标记等历史读取能力保留。
    await seedHistoricalAutoNote(directory, historicalAutoRecord("auto-written", {
      artifactRef,
      toolUseId: "tool-1",
    }));
    const captured = parsed(await scopedNotes.note_read({ key: "auto-written" }));
    assert.equal(captured.provenance.source, "auto");
    assert.equal(captured.provenance.toolUseId, "tool-1");
    const autoListed = parsed(await scopedNotes.note_list({ source: "auto" }));
    assert.deepEqual(autoListed.notes.map((note) => note.key), ["auto-written"]);
    assert.equal(autoListed.notes[0].source, "auto");
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

test("credential-shaped notes are written and read back unchanged", async () => {
  await withNotes(async () => {
    const samples = [
      ["secret_code", "芝麻开门"],
      ["token-value", "token: abcdefghijklmnop"],
      ["jwt-value", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature"],
      ["github-value", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
    ];
    for (const [key, content] of samples) {
      const saved = parsed(await scopedNotes.note_take({ key, content }));
      assert.equal(saved.status, "found");
      const readBack = parsed(await scopedNotes.note_read({ key }));
      assert.equal(readBack.status, "found");
      assert.equal(readBack.value, content);
    }
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
    // .revision 是 scope metadata（隐藏文件），不是 note 记录。
    assert.ok(entries.filter((name) => !name.startsWith(".")).every((name) => name.endsWith(".json")));
  });
});

test("scope schema is run-only and non-run scopes are invalid (issue #67 PR 3)", async () => {
  // D1：4 个工具的 scope enum 只剩 ["run"]（断言 definitions JSON）。
  const definitions = createBuiltinNotesTools({ runId: "scope-run" }).definitions;
  assert.equal(definitions.length, 4);
  for (const tool of definitions) {
    assert.deepEqual(tool.inputSchema.properties.scope.enum, ["run"]);
    assert.equal(tool.inputSchema.properties.scope.default, "run");
  }
  await withNotes(async () => {
    for (const scope of ["project", "user"]) {
      // project/user 直接 invalid（不再返回 unsupported/「暂不支持」）。
      const take = parsed(await scopedNotes.note_take({ key: "x", content: "y", scope }));
      assert.equal(take.status, "invalid");
      assert.match(take.reason, /当前仅支持 run 作用域/u);
      const read = parsed(await scopedNotes.note_read({ key: "x", scope }));
      assert.equal(read.status, "invalid");
      assert.match(read.reason, /当前仅支持 run 作用域/u);
      const listed = parsed(await scopedNotes.note_list({ scope }));
      assert.equal(listed.status, "invalid");
      assert.match(listed.reason, /当前仅支持 run 作用域/u);
      const forgotten = parsed(await scopedNotes.note_forget({ key: "x", scope }));
      assert.equal(forgotten.status, "invalid");
      assert.match(forgotten.reason, /当前仅支持 run 作用域/u);
      // 「暂不支持」语义已删除：响应文案不再出现。
      for (const response of [take, read, listed, forgotten]) {
        assert.doesNotMatch(JSON.stringify(response), /暂不支持/u);
      }
    }
  });
});

test("recordAutoCapture is no longer exported anywhere (ADR-016, issue #67 PR 3)", async () => {
  const toolsIndex = await import("../src/tools/index.js");
  const agentIndex = await import("../src/index.js");
  assert.equal(notes.recordAutoCapture, undefined);
  assert.equal(toolsIndex.recordAutoCapture, undefined);
  assert.equal(agentIndex.recordAutoCapture, undefined);
});

test("records missing time fields from an injected store stay readable, listable, and renderable", async () => {
  // D3：注入 store 不经过 file adapter 的 readRecord 统一出口，时间字段可能缺失。
  const recordWithoutTimes = (key, relevance) => ({
    key,
    scope: "run",
    scopeRef: "normalize-run",
    current: { content: `v-${key}`, provenance: { source: "agent" } },
    superseded: [],
    folded: 0,
    pinned: false,
    tags: [],
    relevance,
    state: "active",
  });
  const bareStore = {
    write: async () => {},
    read: async ({ key }) => (key === "bare" ? recordWithoutTimes("bare", 0.5) : undefined),
    list: async () => ({
      status: "found",
      records: [recordWithoutTimes("bare-a", 0.2), recordWithoutTimes("bare-b", 0.9)],
      nextCursor: null,
      revision: "bare-revision-1",
    }),
    complete: async () => ({ status: "found", completed: 0 }),
    revoke: async () => ({ status: "missing", revoked: 0 }),
    janitor: async () => ({ status: "found", scanned: 0, revoked: 0, nextCursor: null }),
    purge: async () => ({ status: "found", scanned: 0, purged: 0, nextCursor: null }),
  };
  const tools = createBuiltinNotesTools({ notesStore: bareStore, runId: "normalize-run" });
  const read = parsed(await tools.executeTool("note_read", { key: "bare" }));
  assert.equal(read.status, "found");
  assert.equal(read.value, "v-bare");
  const listed = parsed(await tools.executeTool("note_list", {}));
  assert.equal(listed.status, "found");
  // 排序下沉 store：注入 store 返回什么顺序就是什么顺序；关键是缺时间字段
  // 的记录经防御性 normalize 后 list 元数据完整、不崩。
  assert.deepEqual(listed.notes.map((note) => note.key), ["bare-a", "bare-b"]);
  assert.equal(typeof listed.notes[0].updated_at, "string");
  const semantic = await tools.semanticStateProvider({ state: { stateVersion: 1 } });
  assert.equal(semantic.status, "ok");
  // renderNotesDirectory 的 pinned_updated 排序路径在缺时间字段时不崩。
  assert.match(semantic.text, /bare-a/u);
});

test("run lifecycle transitions active to done and janitor reclaims only expired done", async () => {
  await withNotes(async (directory) => {
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

      // 未过期：janitor 不动 done 记录。
      assert.equal((await scopedNotes.runNotesJanitor()).revoked, 0);
      assert.equal(parsed(await scopedNotes.note_read({ key: "lifecycle" })).state, "done");
      // 过期：janitor 写墓碑（revoked_at + revoke_reason）。
      now.value = Date.parse(completed.expires_at) + 1;
      assert.equal((await scopedNotes.runNotesJanitor()).revoked, 1);
      const tombstone = parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(tombstone.state, "revoked");
      assert.ok(tombstone.revoked_at);
      assert.equal(tombstone.revoke_reason, "done_expired");
      assert.equal(parsed(await scopedNotes.note_read({ key: "lifecycle" })).status, "revoked");
    } finally {
      restoreClock();
    }
  }, { graceMs: 60_000 });
});

test("janitor keeps foreign active notes active (even with grace env zero) and reclaims their expired done", async () => {
  const now = { value: Date.now() };
  await withNotes(async (directory) => {
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      await scopedNotes.note_take({ key: "orphan", content: "value" });
      const foreignJanitor = () => scopedNotes.runNotesJanitor({
        __erix: { runId: "current-run", notesDir: directory },
      });
      const readOrphan = async () => parsed(await readFile(
        path.join(directory, "run", "notes-test-run", "orphan.json"),
        "utf8",
      ));
      // 回归核心：另一 run 的 active 笔记长时间未写，janitor 跑完后仍 active。
      now.value += 30 * 24 * 60 * 60 * 1000;
      assert.equal((await foreignJanitor()).revoked, 0);
      assert.equal((await readOrphan()).state, "active");
      // ERIX_NOTES_GRACE_MS=0 同样不得回收 active：grace 不再含 active 清理语义。
      process.env.ERIX_NOTES_GRACE_MS = "0";
      assert.equal((await foreignJanitor()).revoked, 0);
      assert.equal((await readOrphan()).state, "active");
      process.env.ERIX_NOTES_GRACE_MS = "1000";

      // 该笔记 complete 后过期，janitor 负责回收（过期 done → tombstone）。
      await scopedNotes.completeRun();
      assert.equal((await foreignJanitor()).revoked, 0, "未过期的 done 不得回收");
      assert.equal((await readOrphan()).state, "done");
      now.value += 1001;
      assert.equal((await foreignJanitor()).revoked, 1);
      const tombstone = await readOrphan();
      assert.equal(tombstone.state, "revoked");
      assert.ok(tombstone.revoked_at);
      assert.equal(parsed(await scopedNotes.note_list({ includeInactive: true })).count, 1);
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

test("bundled notes skill is retired and user notes skill remains discoverable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "erix-notes-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "erix-notes-cwd-"));
  try {
    // issue #61：bundled notes skill 已退役（skills/ 目录不再含 notes 子目录），
    // bundled 发现机制本身保留（skills/ 目录仍在发现列表内）。
    const bundled = discoverSkills({ home, cwd }).find((skill) => skill.id === "notes");
    assert.equal(bundled, undefined);
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
    const discovered = discoverSkills({ home, cwd }).find((skill) => skill.id === "notes");
    assert.equal(discovered.dir, userDirectory);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// issue #67 PR 2：note_list 分页（opaque cursor、无 total、cursor_stale 可恢复）
// ---------------------------------------------------------------------------

test("note list paginates via opaque nextCursor and rejects legacy integer cursors", async () => {
  await withNotes(async () => {
    for (let index = 0; index < 3; index += 1) {
      await scopedNotes.note_take({
        key: `paginate-${index}`,
        content: `value-${index}`,
        relevance: 0.9 - index * 0.1,
      });
    }
    const page1 = parsed(await scopedNotes.note_list({ limit: 2 }));
    assert.equal(page1.count, 2);
    assert.equal(typeof page1.nextCursor, "string");
    const page2 = parsed(await scopedNotes.note_list({ limit: 2, cursor: page1.nextCursor }));
    assert.deepEqual(page2.notes.map((note) => note.key), ["paginate-2"]);
    assert.equal(page2.nextCursor, null);

    // breaking：整数 offset cursor 不再合法。
    const legacy = parsed(await scopedNotes.note_list({ cursor: 2 }));
    assert.equal(legacy.status, "invalid");
    assert.match(legacy.reason, /nextCursor/u);
    const malformed = parsed(await scopedNotes.note_list({ cursor: "bogus" }));
    assert.equal(malformed.status, "invalid");
    const badLimit = parsed(await scopedNotes.note_list({ limit: 0 }));
    assert.equal(badLimit.status, "invalid");
    assert.match(badLimit.reason, /limit/u);
  });
});

test("note list surfaces cursor_stale as a recoverable structured result", async () => {
  await withNotes(async () => {
    for (let index = 0; index < 3; index += 1) {
      await scopedNotes.note_take({ key: `stale-${index}`, content: `v${index}` });
    }
    const page1 = parsed(await scopedNotes.note_list({ limit: 1 }));
    assert.equal(typeof page1.nextCursor, "string");
    // 翻页期间记录变更 → 旧游标过期。
    await scopedNotes.note_take({ key: "stale-new", content: "new" });
    const stale = parsed(await scopedNotes.note_list({ limit: 1, cursor: page1.nextCursor }));
    assert.equal(stale.status, "cursor_stale");
    assert.deepEqual(stale.notes, []);
    assert.equal(stale.count, 0);
    assert.equal(stale.nextCursor, null);
    assert.equal(typeof stale.revision, "string");
    assert.match(stale.next, /从头翻页/u);
    // 可恢复：去掉 cursor 从头翻页正常返回。
    const restarted = parsed(await scopedNotes.note_list({ limit: 1 }));
    assert.equal(restarted.status, "found");
    assert.equal(restarted.count, 1);
  });
});
