import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
