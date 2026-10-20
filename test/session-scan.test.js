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

// ---------------------------------------------------------------------------
// issue #326（wo-D）：**账本里的三类「引擎事实行」**（`:control:<slot>` / `:fold:<fp>` / `:ttl:<fp>`）
// 出现在 transcript 里之后，CLI 的发现层与预览必须把它们当账本元数据，而不是对话内容：
//   - 预览不得因为首行是事实行就空着（实测改造前：`readFirstUserText` **只看第一行**）；
//   - 预览不得把引擎自说自话（`meta.source === "judge-control"`）当会话正文（实测改造前会把
//     「【Judge 评审意见】…」显示成会话标题）；
//   - `messages` 缺失 / 为空数组 / 为 `null` 一律不得抛（老行与事实行都要兼容）。
// 判据本身在 `src/`（本单不动），这里只钉 CLI 侧「怎么读」。
// ---------------------------------------------------------------------------

const mixedFactRowsHelper = () => import("./helpers/engine-fact-rows.js");

test("#326-D 预览越过引擎事实行：首行是 fold/ttl 事实行也要给出真实用户文本", async () => {
  const { controlRow, foldRow, roundRow, ttlRow, userMessage, writeTranscript } = await mixedFactRowsHelper();
  const { transcriptsDir } = await makeTranscriptsDir();
  const runId = "wo-d-preview-skips-facts";
  const transcriptPath = join(transcriptsDir, `${runId}.jsonl`);
  try {
    await writeTranscript(transcriptPath, [
      foldRow(runId, 2),
      ttlRow(runId, 2),
      controlRow(runId, 2),
      roundRow(runId, 3, [userMessage("真实用户第一句")]),
    ]);
    assert.equal(
      await readFirstUserText(transcriptPath),
      "真实用户第一句",
      "首行是 messages 为空数组的 fold 事实行时，预览不能空着——后面有真实用户轮",
    );
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("#326-D 预览不把引擎自说自话（meta.source=judge-control）当正文", async () => {
  const { controlRow, roundRow, userMessage, writeTranscript } = await mixedFactRowsHelper();
  const { transcriptsDir } = await makeTranscriptsDir();
  const runId = "wo-d-preview-skips-notes";
  const transcriptPath = join(transcriptsDir, `${runId}.jsonl`);
  try {
    await writeTranscript(transcriptPath, [
      controlRow(runId, 1),
      roundRow(runId, 2, [userMessage("真实用户第一句")]),
    ]);
    const preview = await readFirstUserText(transcriptPath);
    assert.equal(preview, "真实用户第一句", `改造前实测给出的是引擎注入文本：${JSON.stringify(preview)}`);
    assert.doesNotMatch(preview, /Judge/u);

    // 整份账本只有引擎提示 ⇒ 宁可不显示，也不把引擎自说自话当会话标题
    const onlyNotes = join(transcriptsDir, "wo-d-only-engine-notes.jsonl");
    await writeTranscript(onlyNotes, [controlRow(runId, 1), controlRow(runId, 2, "extend")]);
    assert.equal(await readFirstUserText(onlyNotes), "");
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("#326-D 事实行的坏形状不崩：messages 缺失 / null / 空数组 / 非 JSON 行 / 空文件", async () => {
  const { roundRow, userMessage, writeTranscript } = await mixedFactRowsHelper();
  const { transcriptsDir } = await makeTranscriptsDir();
  const runId = "wo-d-legacy-shapes";
  const transcriptPath = join(transcriptsDir, `${runId}.jsonl`);
  try {
    // 事实行的三种真实形状（缺 `messages` 的老行、`messages: null`、`messages: []`）+ 一行垃圾
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ round: 1, dedupKey: `${runId}:engine:round:1:fold:aaaa` }),
        "{ not json",
        JSON.stringify({ round: 2, dedupKey: `${runId}:engine:round:2:ttl:bbbb`, messages: null }),
        JSON.stringify(roundRow(runId, 3, [userMessage("坏形状之后的真实用户轮")])),
      ].join("\n"),
      "utf8",
    );
    assert.equal(await readFirstUserText(transcriptPath), "坏形状之后的真实用户轮");

    // 只有坏形状（一行正文都没有）也要给空串，不抛
    const junk = join(transcriptsDir, "wo-d-junk.jsonl");
    await writeTranscript(junk, [{ round: 1, dedupKey: "x:engine:round:1:fold:aaaa", messages: null }]);
    assert.equal(await readFirstUserText(junk), "");
    const empty = join(transcriptsDir, "wo-d-empty.jsonl");
    await writeFile(empty, "", "utf8");
    assert.equal(await readFirstUserText(empty), "");
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("#326-D 事实行不增加扫描条目：一个 transcript 一个候选（行数 ≠ 会话数）", async () => {
  const { mixedFactRows, writeTranscript } = await mixedFactRowsHelper();
  const { transcriptsDir } = await makeTranscriptsDir();
  const cwd = join(transcriptsDir, "wo-d-project");
  const runId = sessionScanPrefix(cwd);
  try {
    await writeTranscript(join(transcriptsDir, `${runId}.jsonl`), mixedFactRows(runId));
    const found = await scanSessions({ cwd, transcriptsDir });
    assert.deepEqual(found.map((entry) => entry.sessionId), [runId]);
    assert.equal(await resolveContinueSessionId({ cwd, transcriptsDir }), runId);
  } finally {
    await rm(join(transcriptsDir, "..", ".."), { recursive: true, force: true });
  }
});

test("#326-D conversationMessages：事实行与引擎提示都不计入正文消息数（改造前实测 9 vs 8）", async () => {
  const { assistantMessage, mixedFactRows, userMessage } = await mixedFactRowsHelper();
  const { conversationMessages, isEngineNoteMessage } = await import("../bin/session-scan.js");
  assert.equal(typeof conversationMessages, "function", "bin/session-scan.js 必须导出 conversationMessages");
  assert.equal(typeof isEngineNoteMessage, "function", "bin/session-scan.js 必须导出 isEngineNoteMessage");

  const runId = "wo-d-count";
  const rows = mixedFactRows(runId);
  // 前置：夹具里确实同时存在三类事实行（否则下面是空断言）
  assert.ok(rows.some((row) => String(row.dedupKey).includes(":fold:")));
  assert.ok(rows.some((row) => String(row.dedupKey).includes(":ttl:")));
  assert.ok(rows.some((row) => String(row.dedupKey).includes(":control:")));

  const flat = rows.flatMap((row) => row.messages ?? []);
  const visible = conversationMessages(rows);
  const bodyTexts = ["把三类事实行写进账本", "先看一眼", "继续", "收尾", "终稿正文"];
  // 正文文本：引擎自写的两条控制文本（judge nudge + 强制收尾指令）不得在内，
  // 但 forced-final 行里那条**终稿 assistant** 是正文，必须在内。
  assert.deepEqual(
    visible.flatMap((message) => (message.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)),
    bodyTexts,
  );
  // 消息数：事实行贡献 0（本来就没消息），引擎自说自话各扣 1 ⇒ 8 行消息只算 6 条正文
  assert.equal(flat.length, 8, "夹具的展平消息数变了，下面的判据要跟着重测");
  assert.equal(visible.length, 6, `改造前实测就是按 flat.length 报的（visible=${visible.length}，flat=${flat.length}）`);
  assert.ok(visible.length < flat.length,
    `正文数必须小于展平后的消息数（实测 visible=${visible.length} flat=${flat.length}），否则引擎自说自话被算成了正文`);
  // 引擎自说自话：judge-control 消息一律判真；真实消息不误伤
  assert.equal(isEngineNoteMessage({ role: "user", content: [], meta: { source: "judge-control" } }), true);
  assert.equal(isEngineNoteMessage(userMessage("用户自己写的")), false);
  assert.equal(isEngineNoteMessage(assistantMessage("模型写的")), false);
  assert.equal(isEngineNoteMessage(undefined), false);
  // 非数组入参不抛（宿主/老行传垃圾也要给空数组而不是崩）
  assert.deepEqual(conversationMessages(undefined), []);
  assert.deepEqual(conversationMessages([null, {}, { messages: null }]), []);
});
