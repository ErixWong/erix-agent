// 覆盖 final-guard 候选行提取（candidateLines）、notes 作用域隔离与
// run 边界生命周期（onRunComplete + 宿主 purge）。原名 notes-autocapture
// 是 auto-capture 时代的遗留命名（ADR-016 已退役该桥），随 0.12.0 契约收窄改名。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runChat } from "../bin/cli.js";
import { candidateLines } from "../bin/final-guard-support.js";
import {
  buildArchiveNotice,
  createCliTools,
  purgeInactiveNoteScopes,
  wrapExecuteTool,
} from "../bin/tools.js";
import { createFinalGuard } from "../bin/final-guard.js";
import * as notes from "../src/tools/notes.js";
import { NOTE_VALUE_MAX_CHARS } from "../src/tools/notes.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #81：注入空 MCP 配置，避免 runChat 的 MCP 代理解析真实 ~/.erix/mcp.json。
async function writeEmptyMcpConfig(dir) {
  const configPath = path.join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "erix-notes-autocapture-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withNotes(callback, { runId = "auto-run", retentionMs } = {}) {
  return withTempDirectory(async (directory) => {
    const previous = Object.fromEntries(
      [
        "ERIX_NOTES_DIR",
        "ERIX_NOTES_RETENTION_MS",
        "ERIX_NOTES_GRACE_MS",
      ]
        .map((name) => [name, process.env[name]]),
    );
    process.env.ERIX_NOTES_DIR = directory;
    const previousScope = activeNotesScope;
    activeNotesScope = { runId, notesDir: directory };
    // 统一保留期（ADR-018 D7）：retentionMs 直接设权威变量；其余三个是
    // 兼容/deprecated alias，测试前一律清除避免串扰。
    if (retentionMs === undefined) delete process.env.ERIX_NOTES_RETENTION_MS;
    else process.env.ERIX_NOTES_RETENTION_MS = String(retentionMs);
    delete process.env.ERIX_NOTES_GRACE_MS;
    try {
      return await callback(directory);
    } finally {
      activeNotesScope = previousScope;
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }

    }
  });
}

let activeNotesScope;
const scopedNotes = new Proxy(notes, {
  get(target, property) {
    const value = target[property];
    if (typeof value !== "function") return value;
    return (input = {}) => value({
      ...input,
      __erix: input.__erix ?? activeNotesScope,
    });
  },
});

async function readOnlyRecord(directory, runId) {
  const scope = path.join(directory, "run", runId);
  const file = (await readdir(scope)).find((name) => name.endsWith(".json"));
  return JSON.parse(await readFile(path.join(scope, file), "utf8"));
}

test("candidateLines extracts Chinese labels, ordinary labels, and bare tokens uniformly", () => {
  assert.deepEqual(
    candidateLines([
      "一次性密钥=XXX",
      "key=value",
      "label: value",
      "opaque-token-123",
    ].join("\n")),
    [
      { label: "一次性密钥", value: "XXX" },
      { label: "key", value: "value" },
    ],
  );
});

test("candidateLines excludes capture metadata labels from value candidates", () => {
  assert.deepEqual(
    candidateLines([
      "lineStart=1",
      "lineEnd=1",
      "digest=abcdef0123456789",
      "toolUseId=tool-123456",
      "nonce=NCSmGUqbmY48ukg5",
    ].join("\n")),
    [
      { label: "linestart", value: "1" },
      { label: "lineend", value: "1" },
      { label: "digest", value: "abcdef0123456789" },
      { label: "tooluseid", value: "tool-123456" },
      { label: "nonce", value: "NCSmGUqbmY48ukg5" },
    ],
  );
});

test("run completes pinned notes and host purge reclaims the scope past retention", async () => {
  const now = { value: Date.now() };
  await withNotes(async (directory) => {
    const restoreClock = notes.setNotesClock(() => now.value);
    try {
      // ADR-018 D7/D8：lifecycle 只有 onRunComplete（返回形状锁定为
      // {completed, errors}）；保留期清理由宿主显式调度 store.purge。
      const tools = notes.createBuiltinNotesTools({ notesDir: directory, runId: "auto-run" });
      await tools.executors("note_take", { key: "lifecycle", content: "value", pinned: true });
      const completion = await tools.lifecycle.onRunComplete({});
      assert.deepEqual([...Object.keys(completion)].sort(), ["completed", "errors"]);
      assert.deepEqual(completion.completed, { status: "found", completed: 1 });
      assert.deepEqual(completion.errors, []);
      assert.deepEqual(
        Object.keys(tools.lifecycle).sort(),
        ["onRunComplete"],
        "lifecycle 只剩 onRunComplete（ADR-018 D8）",
      );
      assert.equal(
        JSON.parse(await scopedNotes.note_read({ key: "lifecycle" })).status,
        "found",
      );
      const done = JSON.parse(await readFile(
        path.join(directory, "run", "auto-run", "lifecycle.json"),
        "utf8",
      ));
      assert.equal(done.state, "done");
      assert.equal(done.expires_at, undefined, "expires_at 已退役（ADR-018 D7）");

      // 会话时钟在保留期内：文件存在，宿主 purge 不删。
      const store = createFileNotesStore({ dir: directory, clock: () => now.value });
      assert.equal((await store.purge({})).purged, 0);
      // scope 最后写入超过保留期（推进注入时钟模拟）：purge 整本物理删除。
      now.value += 2 * 1000;
      assert.equal((await store.purge({})).purged, 1);
      const revoked = JSON.parse(await scopedNotes.note_read({ key: "lifecycle" }));
      assert.equal(revoked.status, "missing");
      await assert.rejects(readdir(path.join(directory, "run", "auto-run")));
    } finally {
      restoreClock();
    }
  }, { retentionMs: 1000 });
});

// ADR-018 D7 会话时钟：CLI 宿主在收尾时按 transcript 最后活动清理过期笔记
// scope（笔记寿命 = 会话寿命 + 30 天尸检期）；找不到 transcript 回退笔记 mtime。
async function runQuietChat({ transcriptsDir, notesDir, session }) {
  const root = path.dirname(transcriptsDir);
  await runChat({
    prompt: "ping",
    session,
    dir: transcriptsDir,
    notesDir,
    skillsDir: path.join(root, "skills"),
    configPath: await writeEmptyMcpConfig(root),
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }] },
    ]),
    config: { model: "fake-model", maxOutputTokens: 1000 },
    finalGuard: false,
    maxRounds: 1,
    idleTimeout: 0,
    toolOutput: () => {},
  });
}

const DAY = 24 * 60 * 60 * 1000;

// issue #186：chmod 造的「不可删 / 不可扫」不是通用夹具——root 持 DAC_OVERRIDE，部分挂载（vfat/
// 某些 fuse）干脆不强制权限位。所以探针而不是硬编码 getuid()：只用来判定「权限夹具在本环境是否
// 真造得出失败」，主形态一律走与 uid 无关的失败源，不会出现「root 下把真缺陷一并 skip 掉」。
let permissionsEnforced;
async function filePermissionsAreEnforced() {
  if (permissionsEnforced !== undefined) return permissionsEnforced;
  const probeRoot = await mkdtemp(path.join(tmpdir(), "erix-perms-probe-"));
  try {
    const probeDir = path.join(probeRoot, "readonly");
    await mkdir(probeDir, { recursive: true });
    await chmod(probeDir, 0o500);
    try {
      await writeFile(path.join(probeDir, "blocked"), "x", "utf8");
      permissionsEnforced = false; // 写得动：DAC 没在拦（root 或挂载不强制）
    } catch {
      permissionsEnforced = true; // EACCES/EPERM：权限位真生效
    }
    await chmod(probeDir, 0o700);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
  return permissionsEnforced;
}

async function seedDeadScope(notesDir, scopeRef) {
  const store = createFileNotesStore({ dir: notesDir });
  await store.write({
    scope: "run",
    scopeRef,
    key: "remnant",
    record: {
      key: "remnant",
      scope: "run",
      scopeRef,
      current: { content: "old-value", provenance: { source: "agent" }, ts: "x" },
      superseded: [],
      folded: 0,
      pinned: false,
      tags: [],
      relevance: 0.5,
      state: "done",
      created_at: "2026-09-15T00:00:00.000Z",
      updated_at: "2026-09-15T00:00:00.000Z",
    },
  });
}

test("CLI host purge: scope whose transcript aged out is cleaned along with the session", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "dead-run");
    // transcript 40 天无活动 → 本次 chat（另一个 session）收尾时该 scope 被清理。
    await writeFile(path.join(transcriptsDir, "dead-run.jsonl"), "{}\n", "utf8");
    const stale = new Date(Date.now() - 40 * DAY);
    await utimes(path.join(transcriptsDir, "dead-run.jsonl"), stale, stale);
    await runQuietChat({ transcriptsDir, notesDir, session: "live-run" });
    await assert.rejects(
      readFile(path.join(notesDir, "run", "dead-run", "remnant.json"), "utf8"),
    );
    await assert.rejects(readdir(path.join(notesDir, "run", "dead-run")));
  });
});

test("CLI host purge: scope with a live transcript is kept, even with very old notes", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "live-run");
    // transcript 10 天前（保留期内）→ scope 豁免；笔记文件本身 40 天前也无所谓。
    await writeFile(path.join(transcriptsDir, "live-run.jsonl"), "{}\n", "utf8");
    const recent = new Date(Date.now() - 10 * DAY);
    await utimes(path.join(transcriptsDir, "live-run.jsonl"), recent, recent);
    const noteFile = path.join(notesDir, "run", "live-run", "remnant.json");
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(noteFile, old, old);
    await runQuietChat({ transcriptsDir, notesDir, session: "other-run" });
    const kept = JSON.parse(await readFile(noteFile, "utf8"));
    assert.equal(kept.key, "remnant");
  });
});

test("CLI host purge: scope without a transcript falls back to the newest note mtime", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "orphan-run");
    const noteFile = path.join(notesDir, "run", "orphan-run", "remnant.json");
    // 无 transcript：笔记文件 40 天前 → 清理。
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(noteFile, old, old);
    await runQuietChat({ transcriptsDir, notesDir, session: "live-run" });
    await assert.rejects(readFile(noteFile, "utf8"));
  });
});

test("CLI host purge: scope without a transcript and fresh notes is kept", async () => {
  await withTempDirectory(async (directory) => {
    const transcriptsDir = path.join(directory, "transcripts");
    const notesDir = path.join(directory, "notes");
    await mkdir(transcriptsDir, { recursive: true });
    await seedDeadScope(notesDir, "fresh-run");
    await runQuietChat({ transcriptsDir, notesDir, session: "live-run" });
    const kept = JSON.parse(await readFile(
      path.join(notesDir, "run", "fresh-run", "remnant.json"),
      "utf8",
    ));
    assert.equal(kept.key, "remnant");
  });
});

test("concurrent runChat calls keep explicit note scopes isolated", async () => {
  await withTempDirectory(async (directory) => {
    const previous = {
      notesDir: process.env.ERIX_NOTES_DIR,
    };
    process.env.ERIX_NOTES_DIR = path.join(directory, "sentinel-notes");
    try {
      // issue #81：空 MCP 配置在 Promise.all 之前写好，避免并发写同一文件。
      const configPath = await writeEmptyMcpConfig(directory);
      const run = (runId, value) => runChat({
        prompt: `save ${value}`,
        session: runId,
        dir: path.join(directory, `${runId}-transcripts`),
        notesDir: path.join(directory, `${runId}-notes`),
        skillsDir: path.join(directory, "skills"),
        configPath,
        provider: createFakeProvider([
          {
            content: [{
              type: "tool_use",
              id: `${runId}-take`,
              name: "note_take",
              input: { key: "answer", content: value },
            }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "done" }] },
        ]),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        finalGuard: false,
        maxRounds: 2,
        idleTimeout: 0,
        toolOutput: () => {},
      });
      await Promise.all([
        run("parallel-a", "value-a"),
        run("parallel-b", "value-b"),
      ]);
      const first = JSON.parse(await readFile(
        path.join(directory, "parallel-a-notes", "run", "parallel-a", "answer.json"),
        "utf8",
      ));
      const second = JSON.parse(await readFile(
        path.join(directory, "parallel-b-notes", "run", "parallel-b", "answer.json"),
        "utf8",
      ));
      assert.equal(first.current.content, "value-a");
      assert.equal(second.current.content, "value-b");
      assert.equal(process.env.ERIX_NOTES_DIR, path.join(directory, "sentinel-notes"));
    } finally {
      if (previous.notesDir === undefined) delete process.env.ERIX_NOTES_DIR;
      else process.env.ERIX_NOTES_DIR = previous.notesDir;
    }
  });
});

// 验收回归（P1）：清扫路径的失败必须静默——scope 目录扫不动 / 删不掉时，不得覆盖 CLI
// 主异常/结果，也不得让 REPL saveAndFinish reject。
// issue #186：失败源不再靠 chmod 制造（root 持 DAC_OVERRIDE → root 下 rmSync 会成功，「吞错」分支
// 根本没跑到）。改用与调用者 uid 无关的必然失败：该 scope 没有会话活动文件，purge 回退到
// 「取笔记文件最大 mtime」时对目录内条目 statSync，而条目是一个指向不存在路径的 symlink → ENOENT。
// 同时补上原来缺的「可继续」半边：同一轮里另一个判死且可删的 scope 必须真的被清掉。
test("purgeInactiveNoteScopes silently skips an undeletable scope directory", async () => {
    await withTempDirectory(async (directory) => {
      const transcriptsDir = path.join(directory, "transcripts");
      const notesDir = path.join(directory, "notes");
      await mkdir(transcriptsDir, { recursive: true });
      // 扫不动的 scope：无 transcript（走笔记 mtime 回退）+ 悬空 symlink（statSync 必然 ENOENT）。
      await seedDeadScope(notesDir, "stuck-run");
      await symlink(
        path.join(notesDir, "run", "stuck-run", "gone.json"),
        path.join(notesDir, "run", "stuck-run", "orphan.json"),
      );
      // 对照组：transcript 40 天无活动 → 判死且删得掉，用来证明失败不中断后续清扫。
      await seedDeadScope(notesDir, "dead-run");
      await writeFile(path.join(transcriptsDir, "dead-run.jsonl"), "{}\n", "utf8");
      const stale = new Date(Date.now() - 40 * DAY);
      await utimes(path.join(transcriptsDir, "dead-run.jsonl"), stale, stale);

      const skippedLines = [];
      const originalConsoleError = console.error;
      let result;
      let thrown = null;
      try {
        console.error = (message) => { skippedLines.push(String(message)); };
        result = purgeInactiveNoteScopes({
          notesDir,
          sessionActivityFile: (scopeRef) => path.join(transcriptsDir, `${scopeRef}.jsonl`),
        });
      } catch (error) {
        thrown = error;
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(thrown, null, "purging must never throw");
      assert.equal(result.scanned, 2);
      assert.equal(result.purged, 1, "undeletable scope is skipped, not counted as purged");
      // 跳过的必须是被卡住的那个，可删的那个已被清扫（= 失败后确实继续扫下一个）。
      assert.deepEqual(await readdir(path.join(notesDir, "run")), ["stuck-run"]);
      // 留痕本身也是契约的一部分：没有这条日志，「purged 少了 1」无法区分「跳过」与「根本没扫到」。
      assert.equal(skippedLines.filter((line) => line.includes("stuck-run")).length, 1);
    });
  });

// 上一条的补充：只读目录让 rmSync 自己抛错（EACCES）这个具体形态。它只在文件系统真的强制
// DAC 时造得出失败（root 持 DAC_OVERRIDE、部分挂载不强制权限位），故显式 skip 而不是假绿。
// 主形态（上面那条）已与 uid 无关，所以本条 skip 不会把产品真缺陷一起掩盖。
test("purgeInactiveNoteScopes silently skips a read-only scope directory when DAC is enforced", async (t) => {
    if (!(await filePermissionsAreEnforced())) {
      return t.skip("本环境的权限位造不出「删不掉」（root 持 DAC_OVERRIDE 或挂载不强制 DAC）");
    }
    await withTempDirectory(async (directory) => {
      const transcriptsDir = path.join(directory, "transcripts");
      const notesDir = path.join(directory, "notes");
      await mkdir(transcriptsDir, { recursive: true });
      await seedDeadScope(notesDir, "stuck-run");
      // transcript 40 天无活动 → scope 判死、进入删除分支。
      await writeFile(path.join(transcriptsDir, "stuck-run.jsonl"), "{}\n", "utf8");
      const stale = new Date(Date.now() - 40 * DAY);
      await utimes(path.join(transcriptsDir, "stuck-run.jsonl"), stale, stale);
      // 只读目录：内部 unlink 必然 EACCES/EPERM。
      const scopeDir = path.join(notesDir, "run", "stuck-run");
      await chmod(scopeDir, 0o500);
      let result;
      let thrown = null;
      try {
        result = purgeInactiveNoteScopes({
          notesDir,
          sessionActivityFile: (scopeRef) => path.join(transcriptsDir, `${scopeRef}.jsonl`),
        });
      } catch (error) {
        thrown = error;
      } finally {
        // 恢复写权限，保证外层临时目录可以清理。
        await chmod(scopeDir, 0o700);
      }
      assert.equal(thrown, null, "purging must never throw");
      assert.equal(result.scanned, 1);
      assert.equal(result.purged, 0, "undeletable scope is skipped, not counted as purged");
      assert.deepEqual(await readdir(scopeDir), ["remnant.json"], "跳过而非半删");
    });
  });

// issue #186：同样把「删不掉」改成与 uid 无关的形态（无 transcript 的 scope + 悬空 symlink），
// 并补上「CLI 收尾的清扫没被失败打断」：同一轮里另一个判死 scope 必须真被清掉。
test("CLI runChat completes normally when the dead scope cannot be deleted", async () => {
    await withTempDirectory(async (directory) => {
      const transcriptsDir = path.join(directory, "transcripts");
      const notesDir = path.join(directory, "notes");
      await mkdir(transcriptsDir, { recursive: true });
      // 卡住的 scope：无 transcript → 回退到笔记 mtime 探测，目录里的悬空 symlink 让 statSync 必然 ENOENT。
      await seedDeadScope(notesDir, "stuck-run");
      await symlink(
        path.join(notesDir, "run", "stuck-run", "gone.json"),
        path.join(notesDir, "run", "stuck-run", "orphan.json"),
      );
      // 对照组：判死且可删 → 必须被清掉，证明失败后清扫继续跑。
      await seedDeadScope(notesDir, "dead-run");
      await writeFile(path.join(transcriptsDir, "dead-run.jsonl"), "{}\n", "utf8");
      const stale = new Date(Date.now() - 40 * DAY);
      await utimes(path.join(transcriptsDir, "dead-run.jsonl"), stale, stale);
      const scopeDir = path.join(notesDir, "run", "stuck-run");

      // runChat 正常 resolve：清扫失败只 console.error 留痕，不覆盖主异常/结果。
      await runQuietChat({ transcriptsDir, notesDir, session: "live-run" });
      // 卡住的 scope 依旧原样（跳过而非半删）。
      assert.deepEqual(
        (await readdir(scopeDir)).sort(),
        ["orphan.json", "remnant.json"],
        "undeletable scope must stay untouched",
      );
      // 同一轮的另一个判死 scope 已被清掉（= CLI 收尾没因前面的失败而中断）。
      await assert.rejects(readdir(path.join(notesDir, "run", "dead-run")));
    });
  });
