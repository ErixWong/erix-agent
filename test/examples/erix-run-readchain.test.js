// issue 261013「erix_run 内层读取链路」的回归面：宿主层不得再截工具结果（R1）、
// note_* 必须真在内层工具面里（R2）、readFile 的续读 marker 带文件真实大小（R3）。
//
// 全离线：真 lib（src/index.js + bin/tools.js）+ 临时 cwd，不触网；
// 唯一碰真实 home 的用例是「不传 sessionDir 时 ~/.erix 不得多出文件」——它只**读** home。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as binTools from "../../bin/tools.js";
import * as libIndex from "../../src/index.js";
import * as core from "../../examples/pi-extension/erix-run-core.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function tempDir(prefix = "erix-run-readchain-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** 真 lib 形状（与 loadErixAgent 的返回同构：index + binTools）。 */
function realLib() {
  return { source: "file://real-lib", libEntry: path.join(repoRoot, "src/index.js"), index: libIndex, binTools };
}

/** bin/tools.js 的 executor 可能返回字符串或 {content}，两种形状都收成文本。 */
function textOf(result) {
  if (result && typeof result === "object" && !Array.isArray(result) && "content" in result) {
    return String(result.content ?? "");
  }
  return typeof result === "string" ? result : String(result ?? "");
}

/** 造一个「行数够多、总字符数远超 4096、中段埋着哨兵」的文件。 */
function writeLongFile(dir, { lines = 300, width = 40 } = {}) {
  const file = path.join(dir, "long.txt");
  const body = Array.from({ length: lines }, (_, index) => {
    const text = `line ${index}`;
    return text + ".".repeat(Math.max(0, width - text.length));
  });
  body[150] = "SENTINEL-MIDDLE-9e1f " + "s".repeat(width - 21);
  writeFileSync(file, `${body.join("\n")}\n`, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// R1：宿主层不得再对任何工具结果做 head+tail 截断
// ---------------------------------------------------------------------------

test("R1①：executeTool 把 readFile 的结果原样交回（>4096 字符、中段哨兵在场）", async () => {
  const cwd = tempDir();
  writeLongFile(cwd);
  const tools = core.createInnerTools({ lib: realLib(), cwd, runId: "r1-read", sessionDir: tempDir() });

  const viaHost = textOf(await tools.executeTool({
    id: "t1", name: "readFile", input: { path: "long.txt", offset: 0, limit: 200 },
  }));
  // 工具自己的原样输出（不经本层的第二条腿，作为对照真值）
  const viaTool = textOf(await binTools.createCliTools({ cwd }).executeTool(
    "readFile", { path: "long.txt", offset: 0, limit: 200 }, {},
  ));

  assert.ok(viaTool.length > 4_096, `前提：工具输出必须超过旧的 4096 上限，实测 ${viaTool.length}`);
  assert.match(viaHost, /SENTINEL-MIDDLE-9e1f/u, "中段哨兵必须在场：head+tail 截断会把中段整段丢掉");
  assert.equal(viaHost.length, viaTool.length, "宿主层不得改变结果长度（截断加回来这里就红）");
  assert.equal(viaHost, viaTool, "必须逐字等于工具原样输出");
  assert.doesNotMatch(viaHost, /中间省略 \d+ 字符/u, "不得出现 bin/tools.js 的 head+tail 截断标记");
  // 200 行的请求就要拿到 200 行（行窗口契约，不是被截后的 66+19 行）
  assert.match(viaHost, /^1: line 0/mu);
  assert.match(viaHost, /^200: line 199/mu);
});

test("R1②：exec 的结果同样原样返回（本层不再截）", async () => {
  const cwd = tempDir();
  const tools = core.createInnerTools({ lib: realLib(), cwd, runId: "r1-exec", sessionDir: tempDir() });
  const command = "node -e \"process.stdout.write('y'.repeat(6000))\"";

  const viaHost = textOf(await tools.executeTool({ id: "t1", name: "exec", input: { command } }));
  const viaTool = textOf(await binTools.createCliTools({ cwd }).executeTool("exec", { command }, {}));

  assert.ok(viaTool.length > 4_096, `前提：exec 输出必须超过旧的 4096 上限，实测 ${viaTool.length}`);
  assert.equal(viaHost, viaTool, "exec 结果也必须逐字相等（护栏归引擎 + exec 自己的 maxBuffer）");
  assert.doesNotMatch(viaHost, /中间省略 \d+ 字符/u);
});

test("R1：宿主截断的旧常量与形参已随之删除（不留死代码）", () => {
  // TOOL_RESULT_LIMIT 只被那次截断用过；截断了就不得留下没人引用的导出。
  assert.equal(core.TOOL_RESULT_LIMIT, undefined, "TOOL_RESULT_LIMIT 应已删除（无任何引用方）");
  // 形参也不留：createInnerTools 不再接受 resultLimit（传了也只会被忽略，不该再存在于签名里）
  assert.equal(
    core.createInnerTools.length >= 0,
    true,
    "createInnerTools 仍在导出面上（形参清单见源码：{lib, cwd, todo, runId, sessionDir, notesStore, notes, onToolEvent}）",
  );
  const source = readdirSync(path.join(repoRoot, "examples/pi-extension")).join("\n");
  assert.match(source, /erix-run-core\.js/u);
  const coreSource = readFileSync(path.join(repoRoot, "examples/pi-extension/erix-run-core.js"), "utf8");
  assert.doesNotMatch(coreSource, /resultLimit/u, "resultLimit 形参与其引用必须一并删除");
  assert.doesNotMatch(coreSource, /truncateResult/u, "本层不再引用 bin/tools.js 的 truncateResult");
});

// ---------------------------------------------------------------------------
// R2：note_* 必须在内层工具面里（TTL 预警/折叠占位符点名的就是它们）
// ---------------------------------------------------------------------------

const NOTE_TOOLS = ["note_take", "note_read", "note_list", "note_forget"];

test("R2③：内层工具面里有 note_*，且真的可执行（take → read → list）", async () => {
  const cwd = tempDir();
  const tools = core.createInnerTools({ lib: realLib(), cwd, runId: "r2-notes", sessionDir: tempDir() });
  const names = tools.tools.map((tool) => tool.name);
  for (const name of NOTE_TOOLS) {
    assert.ok(names.includes(name), `内层工具面必须含 ${name}（TTL 文案点名它）：${names.join(",")}`);
  }

  const taken = textOf(await tools.executeTool({
    id: "n1", name: "note_take", input: { key: "readchain-key", content: "nonce=note-261013" },
  }));
  assert.match(taken, /readchain-key/u, taken);

  const read = textOf(await tools.executeTool({ id: "n2", name: "note_read", input: { key: "readchain-key" } }));
  assert.match(read, /nonce=note-261013/u, "note_read 必须取回刚记下的值：note_* 不是摆设");

  const listed = textOf(await tools.executeTool({ id: "n3", name: "note_list", input: {} }));
  assert.match(listed, /readchain-key/u, listed);
});

test("R2④：不传 sessionDir 时 notes 走内存，真实 ~/.erix 不得多出文件", async () => {
  const home = homedir();
  const root = path.join(home, ".erix");
  const snapshot = () => (existsSync(root) ? readdirSync(root, { recursive: true }) : []);
  const before = snapshot();

  const cwd = tempDir();
  const tools = core.createInnerTools({ lib: realLib(), cwd, runId: "r2-no-sessiondir" });
  await tools.executeTool({ id: "n1", name: "note_take", input: { key: "home-probe", content: "不落盘" } });
  await tools.executeTool({ id: "n2", name: "note_list", input: {} });

  const after = snapshot();
  const added = after.filter((entry) => !before.includes(entry));
  assert.deepEqual(added, [], `不传 sessionDir 时不得写真实 ~/.erix（多出：${added.join(", ")}）`);
});

test("R2：传了 sessionDir 时 notes 落在 <sessionDir>/notes 之下（与 transcript 同根）", async () => {
  const sessionDir = tempDir("erix-run-readchain-session-");
  mkdirSync(sessionDir, { recursive: true });
  const cwd = tempDir();
  const tools = core.createInnerTools({ lib: realLib(), cwd, runId: "r2-scoped", sessionDir });
  await tools.executeTool({ id: "n1", name: "note_take", input: { key: "scoped", content: "跟着 sessionDir" } });

  const notesRoot = path.join(sessionDir, "notes");
  assert.ok(existsSync(notesRoot), `notes 必须落在 ${notesRoot}`);
  const entries = readdirSync(notesRoot, { recursive: true }).map(String);
  assert.ok(
    entries.some((entry) => entry.includes(path.join("run", "r2-scoped"))),
    `scope 目录必须按 runId 分：${entries.join(", ")}`,
  );
});

test("R2：内存 notes store 用的是引擎导出（#265 删了本层手抄），且满足 NotesStore 端口", async () => {
  // 手抄实现已删：本层导出必须**就是**引擎导出（同一函数对象），不再是平行实现。
  assert.equal(typeof libIndex.createMemoryNotesStore, "function", "前提：引擎导出在位");
  assert.equal(
    core.createMemoryNotesStore,
    libIndex.createMemoryNotesStore,
    "仓内布局下 core 的导出必须是引擎导出本身（手抄版被删的证据）",
  );
  const store = core.createMemoryNotesStore();
  assert.doesNotThrow(() => libIndex.assertNotesStore(store));
  await store.write({
    scope: "run",
    scopeRef: "s1",
    key: "k",
    record: {
      key: "k", scope: "run", scopeRef: "s1", state: "active", tags: [], folded: 0,
      superseded: [], current: { content: "v" }, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.equal((await store.read({ scope: "run", scopeRef: "s1", key: "k" })).key, "k");
  assert.equal((await store.list({ scope: "run", scopeRef: "s1" })).length, 1);
  assert.equal((await store.complete({ scope: "run", scopeRef: "s1" })).completed, 1);
  assert.equal((await store.list({ scope: "run", scopeRef: "s1", filters: { state: "active" } })).length, 0);
  assert.deepEqual(await store.list({ scope: "run", scopeRef: "other" }), [], "scope 之间必须隔离");
  // 引擎语义（手抄版量不通的两条，这里必须通）：端口语义在 src/store/notes-port.js
  // 只有一份，两个 adapter 共用——记录校验与保留期豁免都不得静默放宽。
  await assert.rejects(
    store.write({ scope: "run", scopeRef: "s1", key: "bad", record: { key: "bad", current: "not-an-object" } }),
    /valid NoteRecord/u,
  );
  assert.equal((await store.purge({ scope: "run" })).purged, 0, "刚写入的 scope 豁免保留期");
});

test("R2：无 sessionDir 时真注入到 createBuiltinNotesTools 的就是引擎内存 store（spy 捕获）", async () => {
  let captured;
  const spyLib = {
    ...realLib(),
    index: {
      ...libIndex,
      createBuiltinNotesTools: (options) => {
        captured = options.notesStore;
        return libIndex.createBuiltinNotesTools(options);
      },
    },
  };
  const tools = core.createInnerTools({ lib: spyLib, cwd: tempDir(), runId: "r2-spy" });
  assert.ok(tools, "前提：工具装配成功");
  assert.ok(captured, "前提：无 sessionDir 时确实注入了 notesStore");
  assert.doesNotThrow(() => libIndex.assertNotesStore(captured));
  // 端口语义也必须是引擎那一份：非法 filter 抛 TypeError（手抄版静默不过滤）。
  await assert.rejects(
    captured.list({ scope: "run", scopeRef: "spy", filters: { state: [] } }),
    (error) => error instanceof TypeError && /filters\.state/u.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// R3：续读 marker 带文件真实大小（走 formatSize 的可读单位）
// ---------------------------------------------------------------------------

test("R3⑤：readMoreLines marker 含 formatSize 形态的文件大小", async () => {
  const cwd = tempDir();
  const file = path.join(cwd, "sized.txt");
  const rows = Array.from({ length: 40 }, (_, index) => `row ${index} ${"z".repeat(40)}`).join("\n");
  writeFileSync(file, `${rows}\n`, "utf8");
  const size = 1910; // 10 行 ×46 + 30 行 ×47 + 40 个换行 = 1910B → formatSize 的 2KB 档
  assert.equal(statSync(file).size, size, "fixture 体积变了这条前提就要一起改");

  const tools = core.createInnerTools({ lib: realLib(), cwd, runId: "r3-marker", sessionDir: tempDir() });
  const output = textOf(await tools.executeTool({ id: "t1", name: "readFile", input: { path: "sized.txt", limit: 5 } }));
  const marker = output.split("\n").find((line) => line.includes("共 40 行")) ?? "";
  assert.match(marker, /文件 \d+(B|KB|MB|GB|TB)/u, `marker 必须带可读大小：${marker}`);
  assert.match(marker, /文件 2KB/u, "1910B 必须渲染成 2KB（formatSize 的 KB 档）");
  assert.doesNotMatch(marker, /1910B/u, "同一结果里不得并排裸字节数（#196 R2）");
  assert.match(marker, /readFile 传 offset=5 继续/u, "旧的续读出口必须留着");
});
