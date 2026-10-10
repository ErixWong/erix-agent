import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { parseChatArgs } from "../bin/cli.js";
import { PICKER_LIMIT, pickSession, resolveChatSessionSelection } from "../bin/sessions.js";
import { defaultSessionId } from "../bin/repl.js";
import { defaultTranscriptsDir, sessionScanPrefix } from "../bin/session-scan.js";
import { makeTmp } from "./helpers/tmp.js";

// 测试隔离（AGENTS.md）：home / cwd / transcriptsDir 全部注入，不碰真实 ~/.erix。
// cwd 只是哈希输入，不需要真的存在，所以断言里可以直接用字面路径。
const DIR_PROJECT = "/tmp/erix-selection-project";
const DIR_ELSEWHERE = "/tmp/erix-selection-elsewhere";

const line = (text) => `${JSON.stringify({
  round: 1,
  messages: [
    { role: "system", content: [{ type: "text", text: "sys" }] },
    { role: "user", content: [{ type: "text", text }] },
  ],
})}\n`;

function makeInteractiveInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  return input;
}

// 会话 id 用真实派生式造出来（`-c` 的按目录筛选就靠它），不手写字符串
function idOf(cwd, suffix) {
  const base = defaultSessionId(cwd);
  return suffix ? `${base}-${suffix}` : base;
}

async function makeTranscripts() {
  const home = await makeTmp("erix-sessions-test-");
  const transcriptsDir = defaultTranscriptsDir(home);
  await mkdir(transcriptsDir, { recursive: true });
  return { home, transcriptsDir };
}

async function stamp(filePath, epochMs) {
  await utimes(filePath, epochMs / 1000, epochMs / 1000);
}

// picker 挂 keypress 之前要先逐个读预览（53 个文件也可能慢于任何固定 sleep），
// 所以等「界面已经渲染」再按键，而不是赌一个毫秒数。
async function waitUntilRendered(readRendered, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readRendered().includes("选择要接续的会话")) return;
    if (Date.now() > deadline) throw new Error("picker 没有渲染出来");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

test("-c 解析本目录 mtime 最新的会话（现扫现算，不读任何索引）", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    const older = idOf(DIR_PROJECT, "old");
    const newer = idOf(DIR_PROJECT, "new");
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await writeFile(join(transcriptsDir, `${older}.jsonl`), line("较旧"));
    await writeFile(join(transcriptsDir, `${newer}.jsonl`), line("较新"));
    await stamp(join(transcriptsDir, `${older}.jsonl`), base);
    await stamp(join(transcriptsDir, `${newer}.jsonl`), base + 60_000);
    // 另一个目录的会话更晚，但按目录筛选后必须不参与
    const foreign = idOf(DIR_ELSEWHERE, "elsewhere");
    await writeFile(join(transcriptsDir, `${foreign}.jsonl`), line("别处的会话"));
    await stamp(join(transcriptsDir, `${foreign}.jsonl`), base + 120_000);

    const selection = await resolveChatSessionSelection(
      { continueSession: true, session: "unique-default", sessionExplicit: false, dir: transcriptsDir },
      { home, cwd: DIR_PROJECT, input: makeInteractiveInput(), output: new PassThrough() },
    );
    assert.deepEqual(selection, { session: newer, sessionExplicit: true });
    // 磁盘上没被写过任何索引/状态文件
    await assert.rejects(() => import("node:fs/promises").then((fs) => fs.stat(join(home, ".erix", "sessions.json"))));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("-c 的「按本目录」语义保住：换目录后选不到上一个目录的会话", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    const inProject = idOf(DIR_PROJECT, "mine");
    await writeFile(join(transcriptsDir, `${inProject}.jsonl`), line("本目录"));
    const output = new PassThrough();
    const selection = await resolveChatSessionSelection(
      { continueSession: true, session: "unique-default", sessionExplicit: false, dir: transcriptsDir },
      { home, cwd: DIR_ELSEWHERE, input: makeInteractiveInput(), output },
    ).catch((error) => error);
    assert.match(String(selection.message), /没有可接续的会话/);
    // 错误提示带上恢复入口（非规范 id 用 --session <完整 id>）
    assert.match(String(selection.message), /--session <完整 id>/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stale 场景根因消失：transcript 删掉后 -c 不再选中幽灵会话", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    const gone = idOf(DIR_PROJECT, "ghost");
    const filePath = join(transcriptsDir, `${gone}.jsonl`);
    await writeFile(filePath, line("会消失的会话"));
    const selection = async () => resolveChatSessionSelection(
      { continueSession: true, session: "x", sessionExplicit: false, dir: transcriptsDir },
      { home, cwd: DIR_PROJECT, input: makeInteractiveInput(), output: new PassThrough() },
    );
    assert.equal((await selection()).session, gone);
    // 删掉 transcript：同一时刻扫描就看不见它（旧索引会把幽灵记到下次重建为止）
    await rm(filePath);
    assert.match(String(await selection().catch((error) => error)), /没有可接续的会话/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("LLM 失败/空 transcript 不会被 -c 当成可续跑会话", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    // 0 字节（store.load 也返回空）：不可续，跳过；更旧但非空的那条才是答案
    const empty = idOf(DIR_PROJECT, "empty");
    const usable = idOf(DIR_PROJECT, "usable");
    await writeFile(join(transcriptsDir, `${usable}.jsonl`), line("可续"));
    await writeFile(join(transcriptsDir, `${empty}.jsonl`), "");
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await stamp(join(transcriptsDir, `${usable}.jsonl`), base);
    await stamp(join(transcriptsDir, `${empty}.jsonl`), base + 60_000);

    const selection = await resolveChatSessionSelection(
      { continueSession: true, session: "x", sessionExplicit: false, dir: transcriptsDir },
      { home, cwd: DIR_PROJECT, input: makeInteractiveInput(), output: new PassThrough() },
    );
    assert.equal(selection.session, usable);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("退役只停读写不删盘：磁盘上已有的 sessions.json / session-meta.json 原样留下", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    const legacyIndex = join(home, ".erix", "sessions.json");
    const legacyMeta = join(home, ".erix", "session-meta.json");
    // 故意写一份**过期**的旧索引：若实现还在读它，就会选中这个不存在的 id
    await writeFile(legacyIndex, JSON.stringify([{
      sessionId: "ghost-from-old-index",
      cwd: DIR_PROJECT,
      updatedAt: new Date().toISOString(),
    }]));
    await writeFile(legacyMeta, JSON.stringify({ "ghost-from-old-index": { cwd: DIR_PROJECT } }));
    const real = idOf(DIR_PROJECT, "real");
    await writeFile(join(transcriptsDir, `${real}.jsonl`), line("真的会话"));

    const selection = await resolveChatSessionSelection(
      { continueSession: true, session: "x", sessionExplicit: false, dir: transcriptsDir },
      { home, cwd: DIR_PROJECT, input: makeInteractiveInput(), output: new PassThrough() },
    );
    assert.equal(selection.session, real);
    // 文件仍在（停读停写 ≠ 主动清理）
    assert.match(await readFile(legacyIndex, "utf8"), /ghost-from-old-index/);
    assert.match(await readFile(legacyMeta, "utf8"), /ghost-from-old-index/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("-r 需要交互式终端", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    await writeFile(join(transcriptsDir, `${idOf(DIR_PROJECT, "a")}.jsonl`), line("a"));
    const nonTty = new PassThrough();
    nonTty.isTTY = false;
    await assert.rejects(
      () => resolveChatSessionSelection(
        { resumePicker: true, session: "x", sessionExplicit: false, dir: transcriptsDir },
        { home, cwd: DIR_PROJECT, input: nonTty, output: new PassThrough() },
      ),
      /非交互终端不支持 -r/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("-r 与 -c 同源：目录为空给出可操作错误", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    await assert.rejects(
      () => resolveChatSessionSelection(
        { resumePicker: true, session: "x", sessionExplicit: false, dir: transcriptsDir },
        { home, cwd: DIR_PROJECT, input: makeInteractiveInput(), output: new PassThrough() },
      ),
      /没有可接续的会话/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("-r 列本目录会话（新在前 + 完整 id + 预览），Enter 选中、↓ 换选、Esc 取消", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    const older = idOf(DIR_PROJECT, "first");
    const newer = idOf(DIR_PROJECT, "second");
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await writeFile(join(transcriptsDir, `${older}.jsonl`), line("较早的会话"));
    await writeFile(join(transcriptsDir, `${newer}.jsonl`), line("最近的会话"));
    await stamp(join(transcriptsDir, `${older}.jsonl`), base);
    await stamp(join(transcriptsDir, `${newer}.jsonl`), base + 60_000);
    // 别的目录的会话不出现在本目录 picker 里
    await writeFile(join(transcriptsDir, `${idOf(DIR_ELSEWHERE, "x")}.jsonl`), line("别处"));

    const options = { resumePicker: true, session: "x", sessionExplicit: false, dir: transcriptsDir };
    {
      const input = makeInteractiveInput();
      const output = new PassThrough();
      let rendered = "";
      output.on("data", (chunk) => { rendered += String(chunk); });
      const selecting = resolveChatSessionSelection(options, { home, cwd: DIR_PROJECT, input, output });
      await waitUntilRendered(() => rendered);
      input.emit("data", Buffer.from("\r"));
      assert.deepEqual(await selecting, { session: newer, sessionExplicit: true });
      // 行内容：完整 id + 预览（列完整 id 是为了选中后能照抄 --session）
      assert.match(rendered, new RegExp(escapeRegExp(newer)));
      assert.match(rendered, /最近的会话/);
      assert.doesNotMatch(rendered, new RegExp(escapeRegExp(`${idOf(DIR_ELSEWHERE, "x")}`)));
    }
    {
      const input = makeInteractiveInput();
      let sink = "";
      const sinkStream = new PassThrough();
      sinkStream.on("data", (chunk) => { sink += String(chunk); });
      const selecting = resolveChatSessionSelection(options, {
        home, cwd: DIR_PROJECT, input, output: sinkStream,
      });
      await waitUntilRendered(() => sink);
      input.emit("data", Buffer.from("\x1b[B")); // ↓
      input.emit("data", Buffer.from("\r"));
      assert.deepEqual(await selecting, { session: older, sessionExplicit: true });
    }
    {
      const input = makeInteractiveInput();
      let sink = "";
      const sinkStream = new PassThrough();
      sinkStream.on("data", (chunk) => { sink += String(chunk); });
      const selecting = resolveChatSessionSelection(options, {
        home, cwd: DIR_PROJECT, input, output: sinkStream,
      });
      await waitUntilRendered(() => sink);
      input.emit("data", Buffer.from("\x1b")); // Esc
      assert.deepEqual(await selecting, { cancelled: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("picker 行数上限 PICKER_LIMIT：预览要逐个读文件，读取量必须有上界", async () => {
  const { home, transcriptsDir } = await makeTranscripts();
  try {
    const ids = Array.from({ length: PICKER_LIMIT + 3 }, (_unused, index) => (
      idOf(DIR_PROJECT, `s${String(index).padStart(3, "0")}`)
    ));
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (const [index, id] of ids.entries()) {
      const filePath = join(transcriptsDir, `${id}.jsonl`);
      await writeFile(filePath, line(`prompt ${index}`));
      await stamp(filePath, base + index * 1000);
    }

    // 用 Esc 取消，顺带数渲染出来的行数：只列最近 PICKER_LIMIT 条
    const input = makeInteractiveInput();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => { rendered += String(chunk); });
    const selecting = resolveChatSessionSelection(
      { resumePicker: true, session: "x", sessionExplicit: false, dir: transcriptsDir },
      { home, cwd: DIR_PROJECT, input, output },
    );
    await waitUntilRendered(() => rendered);
    input.emit("data", Buffer.from("\x1b")); // Esc 取消
    assert.deepEqual(await selecting, { cancelled: true });

    const rows = rendered.split("\n").filter((row) => /^(?:\u276f| ) \d{4}\//.test(row));
    assert.equal(rows.length, PICKER_LIMIT);
    // 最新的一条在最前（mtime 最大的 id 是最后一个写入的）
    assert.match(rows[0], new RegExp(escapeRegExp(ids[ids.length - 1])));
    // 被截掉的是最旧的那些
    assert.doesNotMatch(rendered, new RegExp(escapeRegExp(ids[0])));
    // 每一行都带得上预览（预览是逐个读文件头部得来的，读不到就空着）
    assert.match(rows[0], /prompt \d+/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function scanForPicker(cwd, transcriptsDir) {
  const { scanSessions } = await import("../bin/session-scan.js");
  return scanSessions({ cwd, transcriptsDir });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
