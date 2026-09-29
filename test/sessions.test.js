import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { parseChatArgs } from "../bin/cli.js";
import {
  FIRST_USER_TEXT_MAX,
  pickSession,
  readSessionsIndex,
  rebuildSessionsIndex,
  recordChatSession,
  resolveChatSessionSelection,
  resolveContinueSessionId,
  sessionMetaPath,
  sessionsIndexPath,
  truncateFirstUserText,
  upsertSessionIndex,
} from "../bin/sessions.js";

function makeHome() {
  return mkdtemp(join("/tmp", "erix-sessions-test-"));
}

function makeInteractiveInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  return input;
}

test("truncateFirstUserText collapses whitespace and caps at 80 chars", () => {
  assert.equal(truncateFirstUserText("  你好\n\t世界  "), "你好 世界");
  const long = "x".repeat(FIRST_USER_TEXT_MAX + 10);
  const truncated = truncateFirstUserText(long);
  assert.equal(truncated.length, FIRST_USER_TEXT_MAX + 1);
  assert.ok(truncated.endsWith("…"));
  assert.equal(truncateFirstUserText(undefined), "");
});

test("upsertSessionIndex creates the index and overwrites the same sessionId", async () => {
  const home = await makeHome();
  try {
    await upsertSessionIndex({
      home,
      sessionId: "run-a",
      cwd: "/tmp/project-a",
      firstUserText: "first prompt",
    });
    let raw = JSON.parse(await readFile(sessionsIndexPath(home), "utf8"));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].sessionId, "run-a");
    assert.equal(raw[0].cwd, "/tmp/project-a");
    assert.equal(raw[0].firstUserText, "first prompt");

    await upsertSessionIndex({
      home,
      sessionId: "run-b",
      cwd: "/tmp/project-a",
      firstUserText: "second prompt",
    });
    await upsertSessionIndex({
      home,
      sessionId: "run-a",
      cwd: "/tmp/project-a",
      firstUserText: "first prompt again",
    });
    raw = JSON.parse(await readFile(sessionsIndexPath(home), "utf8"));
    // 同 sessionId 覆盖：run-a 仍只有一条，且排在最前（updatedAt 最新）
    assert.equal(raw.length, 2);
    assert.equal(raw[0].sessionId, "run-a");
    assert.equal(raw[0].firstUserText, "first prompt again");
    assert.equal(raw[1].sessionId, "run-b");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("upsertSessionIndex stays silent when the index cannot be written", async () => {
  const home = await makeHome();
  try {
    // .erix 占成普通文件：mkdir 失败 → 写入静默
    await writeFile(join(home, ".erix"), "not a directory");
    await upsertSessionIndex({
      home,
      sessionId: "run-x",
      cwd: "/tmp/project",
      firstUserText: "prompt",
    });
    assert.equal(existsSync(sessionsIndexPath(home)), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("readSessionsIndex rebuilds from transcripts when the index is missing", async () => {
  const home = await makeHome();
  try {
    const transcriptsDir = join(home, ".erix", "transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    await writeFile(
      join(transcriptsDir, "run-a.jsonl"),
      `${JSON.stringify({ round: 0, messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "  帮我看看这段代码\n有什么问题 " }] },
      ] })}\n`,
    );
    // 非 jsonl / 哈希文件名必须被排除
    await writeFile(join(transcriptsDir, "run-a.state.json"), "{}");
    await writeFile(join(transcriptsDir, "run-b.checkpoint.json"), "{}");
    await writeFile(join(transcriptsDir, "run-h-deadbeefcafe0123456789.jsonl"), "x\n");

    const { entries, rebuilt } = await readSessionsIndex({ home, transcriptsDir });
    assert.equal(rebuilt, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sessionId, "run-a");
    assert.equal(entries[0].firstUserText, "帮我看看这段代码 有什么问题");
    // 重建条目无法恢复 cwd
    assert.equal(entries[0].cwd, undefined);
    // 重建结果落盘（缓存重新填充）
    const onDisk = JSON.parse(await readFile(sessionsIndexPath(home), "utf8"));
    assert.equal(onDisk.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("readSessionsIndex rebuilds when the index is corrupt", async () => {
  const home = await makeHome();
  try {
    await mkdir(join(home, ".erix"), { recursive: true });
    await writeFile(sessionsIndexPath(home), "{{{ not json");
    const { entries, rebuilt } = await readSessionsIndex({
      home,
      transcriptsDir: join(home, ".erix", "transcripts"),
    });
    assert.equal(rebuilt, true);
    assert.deepEqual(entries, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveContinueSessionId picks the latest entry for the current cwd", async () => {
  const home = await makeHome();
  try {
    const old = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    await upsertSessionIndex({
      home, sessionId: "run-old", cwd: "/tmp/project", firstUserText: "old",
    });
    await upsertSessionIndex({
      home, sessionId: "run-other", cwd: "/tmp/elsewhere", firstUserText: "other",
    });
    // 手动改写 updatedAt 制造同 cwd 两条记录（upsert 恒写最新，这里直接写文件）
    await writeFile(sessionsIndexPath(home), JSON.stringify([
      { sessionId: "run-new", cwd: "/tmp/project", updatedAt: now, firstUserText: "new" },
      { sessionId: "run-other", cwd: "/tmp/elsewhere", updatedAt: now, firstUserText: "other" },
      { sessionId: "run-old", cwd: "/tmp/project", updatedAt: old, firstUserText: "old" },
    ]));

    const picked = await resolveContinueSessionId({
      home,
      cwd: "/tmp/project",
      transcriptsDir: join(home, ".erix", "transcripts"),
    });
    assert.equal(picked, "run-new");

    const none = await resolveContinueSessionId({
      home,
      cwd: "/tmp/never-seen",
      transcriptsDir: join(home, ".erix", "transcripts"),
    });
    assert.equal(none, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("recordChatSession truncates the prompt and swallows failures", async () => {
  const home = await makeHome();
  try {
    await recordChatSession({
      home,
      sessionId: "run-rec",
      cwd: "/tmp/project",
      prompt: "x".repeat(FIRST_USER_TEXT_MAX + 50),
    });
    const entries = JSON.parse(await readFile(sessionsIndexPath(home), "utf8"));
    assert.equal(entries.length, 1);
    assert.ok(entries[0].firstUserText.endsWith("…"));

    // 空 prompt 直接跳过；损坏 home 也不抛出
    await recordChatSession({ home, sessionId: "run-rec", cwd: "/tmp", prompt: "   " });
    await rm(join(home, ".erix"), { recursive: true, force: true });
    await writeFile(join(home, ".erix"), "blocked");
    await recordChatSession({ home, sessionId: "run-rec", cwd: "/tmp", prompt: "hi" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent upserts do not lose entries (in-process serialization)", async () => {
  const home = await makeHome();
  try {
    const ids = Array.from({ length: 25 }, (_unused, index) => `run-${index}`);
    await Promise.all(ids.map((sessionId) => upsertSessionIndex({
      home,
      sessionId,
      cwd: "/tmp/project",
      firstUserText: `prompt ${sessionId}`,
    })));
    const entries = JSON.parse(await readFile(sessionsIndexPath(home), "utf8"));
    assert.equal(entries.length, ids.length);
    for (const id of ids) {
      assert.ok(entries.some((entry) => entry.sessionId === id), `missing ${id}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rebuildSessionsIndex skips corrupt transcripts but tolerates a trailing fragment", async () => {
  const home = await makeHome();
  try {
    const transcriptsDir = join(home, "transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    const line = (text) => `${JSON.stringify({ round: 1, messages: [
      { role: "user", content: [{ type: "text", text }] },
    ] })}\n`;
    await writeFile(join(transcriptsDir, "run-good.jsonl"), line("good session"));
    // 中间非法 JSON 行：store.load 也会炸，必须整段跳过
    await writeFile(join(transcriptsDir, "run-bad.jsonl"), `${line("bad session")}{ not json\n${line("after bad")}`);
    // 末尾不完整残段（崩溃截断）：file store 读取同样忽略，应容忍收录
    await writeFile(join(transcriptsDir, "run-tail.jsonl"), `${line("tail session")}{ "truncated"`);
    // 以 \n 终止的损坏行：readRecords 会拒绝（不是尾残段），必须整段跳过
    await writeFile(join(transcriptsDir, "run-badline.jsonl"), `${line("badline session")}{not-json}\n`);
    // 无 \n 终止但解析出非对象值（数组）：repairTrailingFragment 语义是隔离截断，拒绝
    await writeFile(join(transcriptsDir, "run-nonobj.jsonl"), `${line("nonobj session")}\n[1,2,3]`);
    // 空文件：load 返回空，无可续内容，不入索引
    await writeFile(join(transcriptsDir, "run-empty.jsonl"), "");

    const entries = await rebuildSessionsIndex({ home, transcriptsDir });
    assert.deepEqual(
      entries.map((entry) => entry.sessionId).sort(),
      ["run-good", "run-tail"],
    );
    assert.equal(entries.find((entry) => entry.sessionId === "run-good").firstUserText, "good session");
    // 损坏会话即使 cwd 匹配也不会被 -c 选中
    const picked = await resolveContinueSessionId({ home, cwd: "/tmp/anywhere", transcriptsDir });
    assert.notEqual(picked, "run-bad");
    assert.notEqual(picked, "run-badline");
    assert.notEqual(picked, "run-nonobj");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("session meta stays aligned with the capped index entry set beyond 500 entries", async () => {
  const home = await makeHome();
  try {
    // INDEX_ENTRY_LIMIT = 500：预置满 500 条索引 + 对齐的 meta，再一次 upsert 触发裁剪
    const old = new Date(Date.now() - 60_000).toISOString();
    const existing = Array.from({ length: 500 }, (_unused, index) => ({
      sessionId: `e${String(index).padStart(3, "0")}`,
      cwd: "/tmp/project",
      updatedAt: old,
      firstUserText: `prompt ${index}`,
    }));
    await mkdir(join(home, ".erix"), { recursive: true });
    await writeFile(sessionsIndexPath(home), JSON.stringify(existing));
    await writeFile(sessionMetaPath(home), JSON.stringify(Object.fromEntries(
      existing.map((entry) => [entry.sessionId, { cwd: entry.cwd }]),
    )));

    await upsertSessionIndex({ home, sessionId: "new", cwd: "/tmp/project", firstUserText: "newest" });

    const indexIds = JSON.parse(await readFile(sessionsIndexPath(home), "utf8"))
      .map((entry) => entry.sessionId);
    const meta = JSON.parse(await readFile(sessionMetaPath(home), "utf8"));
    assert.equal(indexIds.length, 500);
    assert.ok(indexIds.includes("new"));
    // meta 与裁剪后的索引条目集严格一致：不残留被裁掉的 session id
    assert.deepEqual(Object.keys(meta).sort(), [...indexIds].sort());
    for (const id of indexIds) {
      assert.equal(meta[id]?.cwd, "/tmp/project");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("-c keeps working after index loss: record → delete index → rebuild restores cwd", async () => {
  const home = await makeHome();
  try {
    const transcriptsDir = join(home, ".erix", "transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    // 模拟一次真实 chat 运行后的落盘状态：transcript + recordChatSession upsert
    await writeFile(join(transcriptsDir, "run-a.jsonl"), `${JSON.stringify({ round: 1, messages: [
      { role: "user", content: [{ type: "text", text: "hello project" }] },
    ] })}\n`);
    await recordChatSession({ home, sessionId: "run-a", cwd: "/tmp/project", prompt: "hello project" });

    // 索引丢失（session-meta 仍在）→ rebuild 必须恢复 cwd，-c 才能选中当前目录会话
    await unlink(sessionsIndexPath(home));
    const picked = await resolveContinueSessionId({ home, cwd: "/tmp/project", transcriptsDir });
    assert.equal(picked, "run-a");
    // rebuild 结果已落盘，后续读取不再触发重建
    const { entries, rebuilt } = await readSessionsIndex({ home, transcriptsDir });
    assert.equal(rebuilt, false);
    assert.equal(entries[0].cwd, "/tmp/project");

    // 其他目录的 -c 仍不匹配（cwd 恢复不是无脑全匹配）
    await unlink(sessionsIndexPath(home));
    const elsewhere = await resolveContinueSessionId({ home, cwd: "/tmp/elsewhere", transcriptsDir });
    assert.equal(elsewhere, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rebuildSessionsIndex keeps only round-trippable session ids", async () => {
  const home = await makeHome();
  try {
    const transcriptsDir = join(home, "transcripts");
    await mkdir(transcriptsDir, { recursive: true });
    await writeFile(join(transcriptsDir, "safe-session.jsonl"), "{}\n");
    await writeFile(join(transcriptsDir, "run-h-abc123.jsonl"), "{}\n");
    const entries = await rebuildSessionsIndex({ home, transcriptsDir });
    assert.deepEqual(entries.map((entry) => entry.sessionId), ["safe-session"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("parseChatArgs parses -c/--continue/-r and enforces mutual exclusion", () => {
  const cwd = "/tmp/project";
  assert.equal(parseChatArgs(["hello", "-c"], cwd).continueSession, true);
  assert.equal(parseChatArgs(["hello", "--continue"], cwd).continueSession, true);
  assert.equal(parseChatArgs(["hello", "-r"], cwd).resumePicker, true);

  assert.throws(
    () => parseChatArgs(["hello", "-c", "--session", "run-x"], cwd),
    /--session 与 -c\/--continue 互斥/,
  );
  assert.throws(
    () => parseChatArgs(["hello", "--session", "run-x", "--continue"], cwd),
    /--session 与 -c\/--continue 互斥/,
  );
  assert.throws(
    () => parseChatArgs(["hello", "-r", "--session", "run-x"], cwd),
    /--session 与 -r 互斥/,
  );
  assert.throws(
    () => parseChatArgs(["hello", "-c", "-r"], cwd),
    /-c\/--continue 与 -r 互斥/,
  );
  assert.throws(
    () => parseChatArgs(["hello", "-c", "-c"], cwd),
    /参数重复：--continue/,
  );
  assert.throws(
    () => parseChatArgs(["hello", "-r", "-r"], cwd),
    /参数重复：-r/,
  );
});

test("resolveChatSessionSelection: -c resolves the latest cwd session", async () => {
  const home = await makeHome();
  try {
    const now = new Date().toISOString();
    await mkdir(join(home, ".erix"), { recursive: true });
    await writeFile(sessionsIndexPath(home), JSON.stringify([
      { sessionId: "run-latest", cwd: "/tmp/project", updatedAt: now, firstUserText: "latest" },
    ]), { encoding: "utf8" });
    const selection = await resolveChatSessionSelection(
      { continueSession: true, session: "unique-default", sessionExplicit: false, dir: join(home, "t") },
      { home, cwd: "/tmp/project", input: makeInteractiveInput(), output: new PassThrough() },
    );
    assert.deepEqual(selection, { session: "run-latest", sessionExplicit: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveChatSessionSelection: -c without any session reports a clear error", async () => {
  const home = await makeHome();
  try {
    await assert.rejects(
      () => resolveChatSessionSelection(
        { continueSession: true, session: "x", sessionExplicit: false, dir: join(home, "t") },
        { home, cwd: "/tmp/project", input: makeInteractiveInput(), output: new PassThrough() },
      ),
      /没有可接续的会话/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveChatSessionSelection: -r requires an interactive terminal", async () => {
  const home = await makeHome();
  try {
    await mkdir(join(home, ".erix"), { recursive: true });
    await writeFile(sessionsIndexPath(home), JSON.stringify([
      { sessionId: "run-a", cwd: "/tmp/project", updatedAt: new Date().toISOString() },
    ]));
    const nonTty = new PassThrough();
    nonTty.isTTY = false;
    await assert.rejects(
      () => resolveChatSessionSelection(
        { resumePicker: true, session: "x", sessionExplicit: false, dir: join(home, "t") },
        { home, cwd: "/tmp/project", input: nonTty, output: new PassThrough() },
      ),
      /非交互终端不支持 -r/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveChatSessionSelection: picker Enter resumes and Esc cancels", async () => {
  const home = await makeHome();
  try {
    const now = Date.now();
    await mkdir(join(home, ".erix"), { recursive: true });
    await writeFile(sessionsIndexPath(home), JSON.stringify([
      { sessionId: "run-first", cwd: "/tmp/a", updatedAt: new Date(now - 10_000).toISOString(), firstUserText: "较早的会话" },
      { sessionId: "run-second", cwd: "/tmp/b", updatedAt: new Date(now).toISOString(), firstUserText: "最近的会话" },
    ]));

    // Enter 直接选中列表第一条（updatedAt 降序 → run-second）
    {
      const input = makeInteractiveInput();
      const output = new PassThrough();
      const selecting = resolveChatSessionSelection(
        { resumePicker: true, session: "x", sessionExplicit: false, dir: join(home, "t") },
        { home, cwd: "/tmp/project", input, output },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      input.emit("data", Buffer.from("\r"));
      const selection = await selecting;
      assert.deepEqual(selection, { session: "run-second", sessionExplicit: true });
    }

    // ↓ + Enter 选中第二条；Esc 取消返回 cancelled
    {
      const input = makeInteractiveInput();
      const output = new PassThrough();
      const selecting = resolveChatSessionSelection(
        { resumePicker: true, session: "x", sessionExplicit: false, dir: join(home, "t") },
        { home, cwd: "/tmp/project", input, output },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      input.emit("data", Buffer.from("\x1b[B"));
      input.emit("data", Buffer.from("\r"));
      const selection = await selecting;
      assert.deepEqual(selection, { session: "run-first", sessionExplicit: true });
    }
    {
      const input = makeInteractiveInput();
      const output = new PassThrough();
      const selecting = resolveChatSessionSelection(
        { resumePicker: true, session: "x", sessionExplicit: false, dir: join(home, "t") },
        { home, cwd: "/tmp/project", input, output },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      input.emit("data", Buffer.from("\x1b"));
      const selection = await selecting;
      assert.deepEqual(selection, { cancelled: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("pickSession lists sessions newest first and renders previews", async () => {
  const now = Date.now();
  const input = makeInteractiveInput();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += String(chunk);
  });
  const picking = pickSession({
    sessions: [
      { sessionId: "run-old", cwd: "/tmp/a", updatedAt: new Date(now - 60_000).toISOString(), firstUserText: "旧任务" },
      { sessionId: "run-new", cwd: "/tmp/b", updatedAt: new Date(now).toISOString(), firstUserText: "新任务" },
    ],
    input,
    output,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.emit("data", Buffer.from("\x1b[B\x1b[B\r")); // ↓↓（回绕）→ run-new
  const picked = await picking;
  assert.equal(picked, "run-new");
  assert.match(rendered, /较早|新任务/);
  assert.match(rendered, /run-new|❯/);
  assert.match(rendered, /旧任务/);
});
