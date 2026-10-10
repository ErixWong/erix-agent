import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  FIRST_USER_TEXT_MAX,
  belongsToCwd,
  defaultTranscriptsDir,
  readFirstUserText,
  resolveContinueSessionId,
  scanSessions,
  sessionScanPrefix,
  truncateFirstUserText,
} from "../bin/session-scan.js";
import { defaultSessionId } from "../bin/repl.js";
import { makeTmp } from "./helpers/tmp.js";

// 测试一律注入 home / cwd / transcriptsDir（AGENTS.md 测试隔离规矩），不碰真实 ~/.erix。
const HOME = "/tmp/erix-scan-home";
const DIR_A = "/tmp/erix-scan-project-a";
const DIR_B = "/tmp/erix-scan-project-b";

const line = (text) => `${JSON.stringify({
  round: 1,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
})}\n`;

async function makeTranscriptsDir() {
  const dir = await makeTmp("erix-scan-test-");
  const transcriptsDir = join(dir, ".erix", "transcripts");
  await mkdir(transcriptsDir, { recursive: true });
  return { dir, transcriptsDir };
}

test("belongsToCwd 精确匹配 *-<hash8>-* 形状（不靠任意位置找哈希）", () => {
  const prefix = sessionScanPrefix(DIR_A);
  assert.equal(belongsToCwd(prefix, DIR_A), true);
  assert.equal(belongsToCwd(`${prefix}-m3k1-1a2b3c4d`, DIR_A), true);
  // 另一目录的会话不可见
  assert.equal(belongsToCwd(defaultSessionId(DIR_B, { unique: true }), DIR_A), false);
  // 非规范 id（用户自取 / 被 safeRunId 哈希掉）对本目录不可见
  assert.equal(belongsToCwd("my-run", DIR_A), false);
  assert.equal(belongsToCwd("run-h-0123456789abcdef01234567", DIR_A), false);
  // 锚定开头而不是「在任意位置找哈希」：另一个目录的会话 id 里恰好带本目录的 8 位哈希段，
  // 也不能被本目录的扫描收走（任意位置匹配就会把它误收进来）
  const hash8 = prefix.slice(prefix.lastIndexOf("-") + 1);
  assert.equal(belongsToCwd(`other-${hash8}-tail`, DIR_A), false);
});

test("scanSessions 只收本目录的 transcript（两个目录互不串）", async () => {
  const { transcriptsDir } = await makeTranscriptsDir();
  try {
    const idA = defaultSessionId(DIR_A, { unique: true });
    const idB = defaultSessionId(DIR_B, { unique: true });
    await writeFile(join(transcriptsDir, `${idA}.jsonl`), line("a 的会话"));
    await writeFile(join(transcriptsDir, `${idB}.jsonl`), line("b 的会话"));
    // repl 的 stable id（无随机后缀）也要能被扫到
    await writeFile(join(transcriptsDir, `${defaultSessionId(DIR_A)}.jsonl`), line("a 的稳定 id"));

    const fromA = await scanSessions({ cwd: DIR_A, transcriptsDir });
    assert.deepEqual(fromA.map((entry) => entry.sessionId).sort(), [
      defaultSessionId(DIR_A),
      idA,
    ].sort());
    const fromB = await scanSessions({ cwd: DIR_B, transcriptsDir });
    assert.deepEqual(fromB.map((entry) => entry.sessionId), [idB]);
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("scanSessions 按 mtime 降序，resolveContinueSessionId 取最新", async () => {
  const { transcriptsDir } = await makeTranscriptsDir();
  try {
    const oldest = `${defaultSessionId(DIR_A)}-old`;
    const middle = `${defaultSessionId(DIR_A)}-mid`;
    const newest = `${defaultSessionId(DIR_A)}-new`;
    for (const id of [oldest, middle, newest]) {
      await writeFile(join(transcriptsDir, `${id}.jsonl`), line(`prompt ${id}`));
    }
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await utimes(join(transcriptsDir, `${newest}.jsonl`), base / 1000, base / 1000);
    await utimes(join(transcriptsDir, `${middle}.jsonl`), (base + 60_000) / 1000, (base + 60_000) / 1000);
    await utimes(join(transcriptsDir, `${oldest}.jsonl`), (base + 120_000) / 1000, (base + 120_000) / 1000);

    const listed = await scanSessions({ cwd: DIR_A, transcriptsDir });
    assert.deepEqual(listed.map((entry) => entry.sessionId), [oldest, middle, newest]);
    assert.ok(listed.every((entry) => entry.size > 0 && Number.isFinite(Date.parse(entry.updatedAt))));
    assert.equal(await resolveContinueSessionId({ cwd: DIR_A, transcriptsDir }), oldest);
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("scanSessions：目录不存在 / 空目录 / 非 transcript 文件 / 0 字节", async () => {
  const { dir, transcriptsDir } = await makeTranscriptsDir();
  try {
    // 目录不存在 → 空列表，不抛
    assert.deepEqual(await scanSessions({ cwd: DIR_A, transcriptsDir: join(dir, "nope") }), []);
    assert.equal(await resolveContinueSessionId({ cwd: DIR_A, transcriptsDir: join(dir, "nope") }), null);
    // 空目录
    assert.deepEqual(await scanSessions({ cwd: DIR_A, transcriptsDir }), []);

    const id = defaultSessionId(DIR_A, { unique: true });
    // 0 字节：store.load 也返回空，不能被选为可续跑会话
    await writeFile(join(transcriptsDir, `${id}.jsonl`), "");
    // 同名的 sidecar 文件不是 transcript
    await writeFile(join(transcriptsDir, `${id}.state.json`), "{}");
    await writeFile(join(transcriptsDir, `${id}.snapshot.json`), "{}");
    await writeFile(join(transcriptsDir, "judge.log"), "not a transcript");
    assert.deepEqual(await scanSessions({ cwd: DIR_A, transcriptsDir }), []);

    await writeFile(join(transcriptsDir, `${id}.jsonl`), line("有内容了"));
    assert.deepEqual((await scanSessions({ cwd: DIR_A, transcriptsDir })).map((e) => e.sessionId), [id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("扫描不可见的 id 依然能用 --session <完整 id> 恢复（文档与错误提示的口径）", async () => {
  const { transcriptsDir } = await makeTranscriptsDir();
  try {
    // 非规范 id：旧版本索引里的形状，或用户自取的 --session my-run
    await writeFile(join(transcriptsDir, "my-run.jsonl"), line("legacy"));
    assert.deepEqual(await scanSessions({ cwd: DIR_A, transcriptsDir }), []);
    // 但它仍然是 store.load 认得的 id（cli 的 --session 路径只认这个）
    const { createFileTranscriptStore } = await import("../src/store/file.js");
    const records = await createFileTranscriptStore({ dir: transcriptsDir }).load("my-run");
    assert.equal(records.length, 1);
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("readFirstUserText 取第一条 user 文本，失败时给空串而不是抛", async () => {
  const { transcriptsDir } = await makeTranscriptsDir();
  try {
    const path = join(transcriptsDir, "p1.jsonl");
    await writeFile(path, line(`  第一段\n第二行  `));
    assert.equal(await readFirstUserText(path), "第一段 第二行");
    const long = join(transcriptsDir, "p2.jsonl");
    await writeFile(long, `${line("x".repeat(FIRST_USER_TEXT_MAX + 40))}`);
    assert.ok((await readFirstUserText(long)).endsWith("…"));
    // 文件不存在 / 首行不是 JSON → 空串
    assert.equal(await readFirstUserText(join(transcriptsDir, "missing.jsonl")), "");
    const broken = join(transcriptsDir, "p3.jsonl");
    await writeFile(broken, "{ not json\n");
    assert.equal(await readFirstUserText(broken), "");
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("truncateFirstUserText collapses whitespace and caps at 80 chars", () => {
  assert.equal(truncateFirstUserText("  你好\n\t世界  "), "你好 世界");
  const long = "x".repeat(FIRST_USER_TEXT_MAX + 10);
  const truncated = truncateFirstUserText(long);
  assert.equal(truncated.length, FIRST_USER_TEXT_MAX + 1);
  assert.ok(truncated.endsWith("…"));
  assert.equal(truncateFirstUserText(undefined), "");
});

test("defaultTranscriptsDir 落在 <home>/.erix/transcripts", () => {
  assert.equal(defaultTranscriptsDir(HOME), join(HOME, ".erix", "transcripts"));
});

test("sessionScanPrefix 就是 <目录名>-<sha256(绝对路径)[:8]>（行为契约，-c 依赖它）", () => {
  // 独立重算一遍公式：实现与文档/其它模块漂移时这里先红
  const expected = (cwd) => {
    const base = cwd.split("/").filter(Boolean).pop() ?? "root";
    return `${base}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
  };
  assert.equal(sessionScanPrefix(DIR_A), expected(DIR_A));
  assert.equal(sessionScanPrefix(DIR_B), expected(DIR_B));
  // 尾斜杠与相对路径按 path.resolve 归一后同值
  assert.equal(sessionScanPrefix(`${DIR_A}/`), sessionScanPrefix(DIR_A));
  // 根目录的目录名是空串 → "root"
  assert.ok(sessionScanPrefix("/").startsWith("root-"));
  // 不同目录必然不同前缀（按目录筛选的地基）
  assert.notEqual(sessionScanPrefix(DIR_A), sessionScanPrefix(DIR_B));
});

test("sessionScanPrefix 与 bin/repl.js / src/tools/notes.js 的实现一致（哈希式是契约）", async () => {
  // bin/repl.js：stable id 必须逐字等于前缀，unique id 必须以前缀 + "-" 开头
  assert.equal(defaultSessionId(DIR_A), sessionScanPrefix(DIR_A));
  assert.ok(defaultSessionId(DIR_A, { unique: true }).startsWith(`${sessionScanPrefix(DIR_A)}-`));
  // src/tools/notes.js 的 currentScopeRef 是同式的第二份实现（库层不能反向 import bin/）。
  // 这里用它的公开行为取真值：不注入 runId 时，semanticStateProvider 的 scopeRef 就是它算的。
  const { createBuiltinNotesTools } = await import("../src/tools/notes.js");
  const captured = [];
  const stubStore = {
    read: async () => null,
    write: async () => ({}),
    list: async (request) => {
      captured.push(request.scopeRef);
      return [];
    },
    complete: async () => ({}),
    revoke: async () => ({}),
    purge: async () => ({ removed: 0 }),
  };
  const notes = createBuiltinNotesTools({ notesStore: stubStore });
  await notes.semanticStateProvider({});
  assert.deepEqual(captured, [sessionScanPrefix(process.cwd())]);
});

test("哈希式只有一份实现，且没有扩大库的公共导出面（issue #168 红线）", async () => {
  const { readFileSync } = await import("node:fs");
  const replSource = readFileSync(new URL("../bin/repl.js", import.meta.url), "utf8");
  // bin/repl.js 必须复用 sessionScanPrefix，而不是再抄一份哈希式（抄第二份就等着漂移）
  assert.match(replSource, /import \{ sessionScanPrefix \} from "\.\/session-scan\.js"/);
  assert.doesNotMatch(replSource, /createHash\("sha256"\)[\s\S]{0,80}slice\(0, 8\)/);

  // src/index.js 不许因为本单新增导出（-c 的实现全在 bin/，库面一字不动）
  const publicSurface = await import("../src/index.js");
  for (const symbol of ["sessionScanPrefix", "belongsToCwd", "scanSessions", "readFirstUserText"]) {
    assert.equal(publicSurface[symbol], undefined, `src/index.js 多了导出 ${symbol}`);
  }
  const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(indexSource, /session-scan|sessionScanPrefix/);
});
