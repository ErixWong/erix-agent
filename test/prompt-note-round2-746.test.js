// issue #746 第 2 轮（独立评审的必修 2 / 3 / 4）——三处**接线**的边界断言，全部走真装配或纯函数。
//
// 评审抓的不是措辞（措辞在 `test/prompt-note-evidence-746.test.js` 已经逐处钉过），抓的是**门把事实
// 递到了没有**：
//   必修 2 `bin/delegation.js`：子 run 的提示词以前恒按「有笔记」装配（`notes` 从来没人传），
//          父的 `--tools` 把 `note_*` 滤掉后，子提示词仍在命令模型调三个场上不存在的工具。
//          同一处还埋着一个更硬的坑：`noteToolSurface` 被调用却从未 import ⇒ 子 run 一折叠就
//          `ReferenceError`；而 `childToolNames` 直接当清单行名单用时，白名单点名笔记工具会让
//          短语表核对当场抛错 ⇒ 子 run 直接 `failed`。
//   必修 3 `bin/final-guard.js`：store 缺失 / `store.load()` 抛错都被折成 `messages: []`，于是
//          「账本读不出来」被下游当成**已知**的「没写过笔记」（断言），而不是「这一层不知道」（条件式）。
//   必修 4 `bin/repl.js`：同一轮里折叠钩子拿到的是现推的笔记工具面，`createFinalGuard` 却没拿到 ⇒
//          同一个 REPL 会话里两条取回指引可以各说一套。
//
// 环境纪律：零真实 LLM、全部临时目录、不碰真实 `~/.erix`。
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { buildChildSystemPrompt, createCliDelegation } from "../bin/delegation.js";
import { buildCaptureRecoveryHint, createFinalGuard } from "../bin/final-guard.js";
import { runRepl } from "../bin/repl.js";
import { readRecord } from "../src/tools/delegation/roster.js";
import { makeTmp } from "./helpers/tmp.js";

/** 子 run 的系统提示前缀：父子共用一个假 provider 时按它分流（同 `test/cli-delegate-630.test.js`）。 */
const CHILD_MARKER = "你是 erix 的子 run";

function createRoutingFakeProvider({ childScript = [] }) {
  const seen = { parent: 0, child: 0 };
  const requests = [];
  return {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chat(request) {
      const isChild = JSON.stringify(request ?? {}).includes(CHILD_MARKER);
      const key = isChild ? "child" : "parent";
      requests.push({
        role: key,
        system: String(request?.system?.content ?? request?.system ?? ""),
        toolNames: (Array.isArray(request?.tools) ? request.tools : []).map((tool) => tool?.name),
      });
      const script = isChild ? childScript : [];
      if (seen[key] >= script.length) throw new Error(`fake provider: ${key} 脚本已用尽`);
      const step = script[seen[key]];
      seen[key] += 1;
      return { content: step.content ?? [], stopReason: step.stopReason ?? "end_turn" };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

const DONE = [{ content: [{ type: "text", text: "任务已完成 done" }], stopReason: "end_turn" }];

function toolListLine(prompt) {
  const m = String(prompt).match(/可用工具：[^\n]*/u);
  return m === null ? null : m[0];
}

// ─────────────────── 必修 2：子 run 的提示词跟**子的真工具面** ───────────────────

test("必修 2a：父 allowlist 把笔记滤掉 ⇒ 子提示词一个 note_* 都不出现（清单行 + 处境段 + 归档提示）", async () => {
  const root = await makeTmp("erix-746-r2-filtered-");
  const provider = createRoutingFakeProvider({ childScript: DONE });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: join(root, "roster"),
    maxRounds: 3,
    notify: () => {},
    childToolOutput: () => {},
    toolAllowlist: "readFile,exec",
  });

  const ran = await delegation.execute({ action: "run", task: "只读任务" }, { runId: "parent-746r2" });
  assert.equal(ran.ok, true, `派生应成功：${JSON.stringify(ran)}`);
  const child = provider.requests.find((entry) => entry.role === "child");
  assert.ok(child, "子 run 必须真的被跑起来");
  for (const name of ["note_take", "note_list", "note_read"]) {
    assert.equal(
      child.toolNames.includes(name),
      false,
      `子的工具面没有 ${name}（父的白名单没给）——这正是断言的前提`,
    );
  }
  assert.equal(
    /note_/u.test(child.system),
    false,
    `子的工具面没有笔记工具 ⇒ 子提示词不许命令模型去调不存在的工具（现文片段：${child.system.slice(0, 400)}）`,
  );
  assert.match(child.system, /重读源文件/u, "无笔记工具面时那份处境段必须给重读退路");
  assert.match(child.system, /本场没装配笔记工具/u);
});

test("必修 2b：白名单**点名**笔记工具 ⇒ 子提示词回到 note-first，且清单行不因 note_* 当场抛错", async () => {
  const root = await makeTmp("erix-746-r2-allowed-");
  const provider = createRoutingFakeProvider({ childScript: DONE });
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 1000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: join(root, "roster"),
    maxRounds: 3,
    notify: () => {},
    childToolOutput: () => {},
    toolAllowlist: "readFile,exec,note_take,note_list,note_read,note_forget",
  });

  const ran = await delegation.execute({ action: "run", task: "带笔记任务" }, { runId: "parent-746r2b" });
  assert.equal(ran.ok, true, `派生应成功：${JSON.stringify(ran)}`);
  const record = readRecord(join(root, "roster"), ran.runId);
  assert.equal(
    record.state,
    "completed",
    `白名单点名笔记工具时子 run 必须能跑完（旧形状：清单行短语表核对当场抛错 ⇒ failed；现 ${record.state} / ${record.errorMessage ?? ""}）`,
  );
  const child = provider.requests.find((entry) => entry.role === "child");
  assert.match(child.system, /先 note_list 再 note_read/u, "笔记工具真在子的面上 ⇒ 指引必须回来");
  const line = toolListLine(child.system);
  assert.ok(line !== null);
  assert.equal(line.includes("note_take"), false, "清单行只列有清单文案的注册面工具（笔记工具在处境段里说）");
});

test("必修 2c：allowlist 缺省 ⇒ 子提示词逐字节不变（缺省装配面确实带着整族笔记）", async () => {
  const withNotes = buildChildSystemPrompt({ cwd: "/tmp/x" });
  assert.match(withNotes, /立刻 note_take/u);
  assert.match(withNotes, /先 note_list 再 note_read/u);
  // `notes: false` 那一格：整段处境段与归档提示一起换掉，`note_*` 归零。
  const withoutNotes = buildChildSystemPrompt({ cwd: "/tmp/x", notes: false, archiveDir: "/tmp/arc" });
  assert.equal(/note_/u.test(withoutNotes), false, `notes:false ⇒ 一个 note_* 都不许有（现文：${withoutNotes.slice(0, 300)}）`);
  assert.match(withoutNotes, /重读源文件/u);
});

test("必修 2d：子侧折叠桩不再撞 ReferenceError（noteToolSurface 必须真被 import）", async () => {
  const root = await makeTmp("erix-746-r2-fold-");
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests: [],
    async chat(request) {
      this.requests.push(request);
      if (this.requests.length <= 2) {
        return {
          content: [{ type: "tool_use", id: `c${this.requests.length}`, name: "exec", input: { command: "seq 1 1500" } }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "任务已完成 done" }], stopReason: "end_turn" };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  const delegation = createCliDelegation({
    buildProvider: () => provider,
    config: { model: "fake-model", maxOutputTokens: 200, compaction: "fold-statistical", compactBudgetTokens: 3000 },
    cwd: root,
    todo: false,
    notesDir: join(root, "notes"),
    rosterDir: join(root, "roster"),
    maxRounds: 6,
    notify: () => {},
    childToolOutput: () => {},
    toolAllowlist: "readFile,exec",
  });
  const ran = await delegation.execute(
    { action: "run", task: "短任务：回显两次再收尾" },
    { runId: "parent-746r2-fold" },
  );
  const record = readRecord(join(root, "roster"), ran.runId);
  assert.equal(
    record.state,
    "completed",
    `子 run 必须正常收尾（旧形状：子侧折叠桩里 noteToolSurface 未 import ⇒ ReferenceError ⇒ ${record.state} / ${record.errorMessage ?? ""}）`,
  );
});

// ────────────── 必修 3：guard 不许把「账本读不出来」伪装成空账本 ──────────────

const NOTE_TOOLS = ["note_take", "note_list", "note_read"];

/** 一条能抽出可核验值的捕获（guard 的 `inspectRun` 需要它才走 revise 分支）。 */
function captureRecord(messages = []) {
  return {
    round: 1,
    toolOutputs: [{ toolUseId: "c1", name: "exec", content: "nonce=gold-4173\n" }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "printf x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "nonce=gold-4173\n" }] },
      ...messages,
    ],
  };
}

test("必修 3a：store.load 抛错 / 没有 store ⇒ 条件式；读到且确实为空 ⇒ 才说「没写过」", async () => {
  const throwing = { load: async () => { throw new Error("EIO: disk gone"); } };
  const emptyButReadable = { load: async () => [{ round: 1, messages: [] }] };

  const hintUnknown = await buildCaptureRecoveryHint({
    foldedPayload: [], store: throwing, runId: "r", noteTools: NOTE_TOOLS,
  });
  assert.match(hintUnknown, /如本 run 写过笔记/u, `账本读不出来 ⇒ 只能说条件式（现文：${hintUnknown}）`);
  assert.equal(
    /无笔记写入/u.test(hintUnknown),
    false,
    `读失败不许被伪装成「本场没写过笔记」这条断言（现文：${hintUnknown}）`,
  );

  const hintNoStore = await buildCaptureRecoveryHint({
    foldedPayload: [], runId: "r", noteTools: NOTE_TOOLS,
  });
  assert.match(hintNoStore, /如本 run 写过笔记/u, "本层没有 store 端口 = 不知道，同样走条件档");

  const hintEmpty = await buildCaptureRecoveryHint({
    foldedPayload: [], store: emptyButReadable, runId: "r", noteTools: NOTE_TOOLS,
  });
  assert.equal(
    /如本 run 写过笔记/u.test(hintEmpty),
    false,
    `读成功且账本确实为空 ⇒ 这才是「没写过」，不该再退成条件式（现文：${hintEmpty}）`,
  );
  assert.match(hintEmpty, /重读源文件/u);
});

test("必修 3b：guard 的打回指针同样分「读不出来 / 读到空」，且读失败要留痕", async () => {
  // 捕获从 legacy manifest 来（与账本无关），这样「账本读不出来」与「有捕获可核」能同时成立——
  // 否则 store 一挂就 `readableArtifacts: 0` ⇒ skip，指针那一句根本到不了模型眼前。
  const archiveDir = await makeTmp("erix-746-r2-manifest-");
  const { writeFile } = await import("node:fs/promises");
  const body = "nonce=gold-4173\n";
  const digest = (await import("node:crypto")).createHash("sha256").update(body, "utf8").digest("hex");
  await writeFile(join(archiveDir, "cap.txt"), body, "utf8");
  await writeFile(join(archiveDir, "cap.meta.json"), JSON.stringify({
    kind: "erix.tool-capture",
    schemaVersion: 1,
    truncated: false,
    digest,
    archivePath: join(archiveDir, "cap.txt"),
    locator: { lineStart: 1, lineEnd: 1 },
  }), "utf8");

  const noteWrite = [
    { role: "assistant", content: [{ type: "tool_use", id: "n1", name: "note_take", input: { key: "k-1", content: "nonce=gold-4173" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "n1", content: '{"status":"found","action":"saved","key":"k-1","scope":"run"}' }] },
  ];
  const reviseOf = async (store, warnings = []) => createFinalGuard({
    archiveDir, store, runId: "guard-run", noteTools: NOTE_TOOLS, onWarning: (line) => warnings.push(line),
  })({ finalText: "随便写" });

  // ① 读得到 + 有写入 ⇒ note-first。
  const knownWarnings = [];
  const known = await reviseOf({ load: async () => [captureRecord(noteWrite)] }, knownWarnings);
  assert.equal(known.action, "revise", `有捕获无声明 ⇒ 打回（现文：${JSON.stringify(known)}）`);
  assert.match(known.message, /note_list[\s\S]*note_read/u, "读得到且有写入 ⇒ note-first 指针");

  // ② 同样的捕获，但账本**读不出来** ⇒ 条件式 + 留痕（不许断言「本场没记过笔记」）。
  const unknownWarnings = [];
  const unknown = await reviseOf({ load: async () => { throw new Error("EIO: 盘挂了"); } }, unknownWarnings);
  assert.match(
    unknown.message,
    /如本 run 写过笔记/u,
    `账本读不出来 ⇒ 指针只说条件式（现文：${unknown.message}）`,
  );
  assert.equal(/无笔记写入/u.test(unknown.message), false, "指针不许把读失败伪装成「没写过」");
  assert.ok(
    unknownWarnings.some((line) => /transcript 读取失败/u.test(line)),
    `读失败必须留痕，不许静默降级（warnings：${JSON.stringify(unknownWarnings)}）`,
  );

  // ③ 读得到、确实一条笔记都没写过 ⇒ 这才是「无证据」（重读 + 原因）。
  const emptyLedger = await reviseOf({ load: async () => [captureRecord()] });
  assert.equal(/note_/u.test(emptyLedger.message), false, `读到空账本 ⇒ 无证据那一份（现文：${emptyLedger.message}）`);
  assert.match(emptyLedger.message, /重读源文件/u);
});

// ────────── 必修 4：同一个 REPL 会话里，折叠钩子与 final guard 拿同一份工具面 ──────────

/**
 * 跑一轮 `runRepl`，把每样**宿主递给引擎的事实**抓下来：
 * 工具面（`loopOptions.tools`）、折叠桩后缀、final guard 的打回指针。
 */
async function runReplProbe({ tag, toolsFlag, noteWrite = false }) {
  const home = await makeTmp(`erix-746-r2-${tag}-`);
  const mcpConfigPath = join(home, "mcp.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }), "utf8");

  const records = [{
    round: 1,
    toolOutputs: [{ toolUseId: "c1", name: "exec", content: "nonce=gold-4173\n" }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "printf x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "nonce=gold-4173\n" }] },
      ...(noteWrite ? [
        { role: "assistant", content: [{ type: "tool_use", id: "n1", name: "note_take", input: { key: "k-1", content: "nonce=gold-4173" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "n1", content: '{"status":"found","action":"saved","key":"k-1","scope":"run"}' }] },
      ] : []),
    ],
  }];
  const store = {
    load: async () => records,
    appendRound: async () => {},
    completeRun: async () => {},
  };
  const { createCliAssemblyRoot } = await import("../bin/assembly-root.js");
  const assemblyRoot = createCliAssemblyRoot({ dir: home, runId: "repl-746", cwd: home, notesDir: join(home, "notes") });
  assemblyRoot.store = store;

  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let captured;
  const run = runRepl(
    ["--session", "repl-746", "--dir", home, "--final-guard", "--config", mcpConfigPath, ...toolsFlag],
    {
      input,
      output,
      sessionDir: home,
      home,
      notesDir: join(home, "notes"),
      assemblyRoot,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      providerFactory: () => ({}),
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
    },
  );
  input.end("hi\n/exit\n");
  await run;
  return {
    captured,
    toolNames: (captured.tools ?? []).map((tool) => tool.name),
    stub: await captured.capabilities.hooks.stubFor(
      { content: [{ type: "tool_result", tool_use_id: "c1", content: "nonce=gold-4173\n" }] },
      { round: 2 },
    ),
    guard: captured.capabilities.hooks.finalGuard,
  };
}

test("必修 4：--tools 滤掉笔记 ⇒ 同一个会话里折叠桩与 final guard 一起闭嘴（同一份工具面）", async () => {
  const seen = await runReplProbe({ tag: "repl-filtered", toolsFlag: ["--tools", "readFile,exec"] });
  assert.equal(seen.toolNames.includes("note_take"), false, "前提：这一轮真把笔记工具滤掉了");
  assert.equal(/note_/u.test(seen.stub), false, `折叠桩不提笔记（现文：${seen.stub}）`);
  const verdict = await seen.guard({ finalText: "随便写" });
  assert.equal(verdict.action, "revise", `有捕获无声明 ⇒ 打回（现文：${JSON.stringify(verdict)}）`);
  assert.equal(
    /note_/u.test(verdict.message),
    false,
    `同一会话的打回指针也不许提笔记——它必须和折叠桩用同一份工具面（现文：${verdict.message}）`,
  );
});

test("必修 4 反向：工具面留着笔记且账本有写入 ⇒ 折叠桩与 final guard **都**给 note-first", async () => {
  const seen = await runReplProbe({
    tag: "repl-notes",
    toolsFlag: ["--tools", "readFile,exec,note_take,note_list,note_read,note_forget"],
    noteWrite: true,
  });
  assert.match(seen.stub, /note_list[\s\S]*note_read/u, `折叠桩应给 note-first（现文：${seen.stub}）`);
  const verdict = await seen.guard({ finalText: "随便写" });
  assert.match(verdict.message, /note_list[\s\S]*note_read/u, `final guard 应给同一句（现文：${verdict.message}）`);
});
