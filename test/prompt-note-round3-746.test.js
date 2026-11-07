// issue #746 第 3 轮（独立评审的必修① + 必修④的反向守卫缺口）——两处**小修**的边界断言。
//
// 第 2 轮那份「子 run 的提示词跟子的工具面」只做到了一半：`bin/delegation.js` 的调用方另外显式
// 传了一份 `notes`，于是 `buildChildSystemPrompt` 自己**从不**从 `toolNames` 推导。评审当场跑出的
// 反证是：`buildChildSystemPrompt({ cwd: "/tmp/x", toolNames: ["readFile"] })` 的输出里仍有
// `note_take` / `note_list` / `note_read` —— 提示词还在命令模型去调三个场上不存在的工具，而集成
// 用例照旧绿（它断言的是结果，看不见哪一份输入被漏）。第 3 轮的修法不是「再补一份输入」，而是把
// 两份输入合成一份：`toolNames` 就是子的真工具面名单，清单行与 `notes` **都**从它现推。
//
// 同一轮的必修④（归档提示的反向变异）落在 `test/prompt-note-coverage-746.test.js` 的 `G1c`：
// 那边的探针以前不带 `archiveDir` ⇒ 归档提示根本不在被扫的文本里 ⇒ 往它里面塞存在断言照样绿。
// 本文件把「窄名单 ⇒ 归档提示那一支也必须闭嘴」这一格也钉住（它是同一处代码的另一支）。
//
// 环境纪律：零真实 LLM、全部临时目录、不碰真实 `~/.erix`；下面没有任何一条需要跑子 run。
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildChildSystemPrompt, createCliDelegation } from "../bin/delegation.js";
import { notesOnToolNames } from "../bin/system-prompt.js";
import { readRecord } from "../src/tools/delegation/roster.js";
import { makeTmp } from "./helpers/tmp.js";

/** 子 run 的系统提示前缀：父子共用一个假 provider 时按它分流（同 `test/cli-delegate-630.test.js`）。 */
const CHILD_MARKER = "你是 erix 的子 run";

const NOTE_FAMILY = ["note_take", "note_list", "note_read", "note_forget"];

function toolListLine(prompt) {
  const m = String(prompt).match(/可用工具：[^\n]*/u);
  return m === null ? null : m[0];
}

// ─────────── 必修① 的直接探针：`toolNames` 是**一份**事实，不是两份 ───────────

test("必修①a：只给 `toolNames`（窄名单）⇒ 子提示词一个 note_* 都不出现（处境段 + 归档提示两支）", () => {
  // 这就是评审跑的那条形：以前它返回的文本里有 note_take / note_list / note_read。
  const narrow = buildChildSystemPrompt({ cwd: "/tmp/x", todo: false, toolNames: ["readFile", "exec"] });
  assert.equal(
    /note_/u.test(narrow),
    false,
    `窄名单里没有整族笔记工具 ⇒ 提示词不许命令模型去调场上不存在的工具（现文：${narrow.slice(0, 500)}）`,
  );
  assert.match(narrow, /本场没装配笔记工具/u, "无笔记工具面那一份处境段必须在");
  assert.match(narrow, /重读源文件/u, "无笔记工具面时必须给「重读源文件」这条真路");

  // 同一处代码的另一支：归档提示。以前 `notes` 缺省为 true，窄名单下它仍教模型「先 note_list」。
  const withArchive = buildChildSystemPrompt({
    cwd: "/tmp/x",
    todo: false,
    toolNames: ["readFile", "exec"],
    archiveDir: "/tmp/erix-746-r3-archive",
  });
  assert.match(withArchive, /\[工具输出归档\]/u, "archiveDir 在场 ⇒ 归档提示必须拼上");
  assert.equal(
    /note_/u.test(withArchive),
    false,
    `窄名单下归档提示也不许提 note_*（现文：${withArchive.slice(-400)}）`,
  );
  assert.match(withArchive, /本场没装配笔记工具/u, "归档提示要走「无笔记工具面」那一支");
});

test("必修①b：`toolNames` 里点名整族笔记 ⇒ 同一条路推回 note-first（同一份名单，两个方向）", () => {
  const wide = buildChildSystemPrompt({
    cwd: "/tmp/x",
    todo: false,
    toolNames: ["readFile", "exec", ...NOTE_FAMILY],
    archiveDir: "/tmp/erix-746-r3-archive",
  });
  assert.match(wide, /立刻 note_take/u, "整族在名单上 ⇒ 处境段回到有笔记那一份");
  assert.match(wide, /先 note_list 再 note_read/u);
  assert.match(wide, /先用 note_list 查找记录，再用 note_read 读取/u, "归档提示也要跟着回到 note-first");
  // 清单行仍只列**有清单文案**的那些名字：`note_*` 不在 CLI 注册面里，塞进去会让短语表核对当场抛。
  const line = toolListLine(wide);
  assert.ok(line !== null);
  for (const name of NOTE_FAMILY) {
    assert.equal(line.includes(name), false, `清单行不许列 ${name}（它们在处境段里说）：${line}`);
  }
  // 整族**缺一角**（只有 note_take）⇒ 全有或全无的口径仍然判「无笔记面」。
  const partial = buildChildSystemPrompt({ cwd: "/tmp/x", todo: false, toolNames: ["readFile", "note_take"] });
  assert.equal(/note_/u.test(partial), false, "整族缺一角不算有笔记面（口径在 src 的 hasNoteToolSurface）");
});

test("必修①c：缺省路径逐字节不变（不传 toolNames / notes ⇒ 缺省装配面「有整族」）", () => {
  const golden = buildChildSystemPrompt({ cwd: "/tmp/x" });
  assert.match(golden, /立刻 note_take/u);
  assert.match(golden, /先 note_list 再 note_read/u);
  assert.match(golden, /具体数值必须来自当前工具返回或 note_read/u);
  // `notes: true` 显式给一遍，必须与缺省逐字节相同（「不表态」与「表态有」在这一位同值）。
  assert.equal(golden, buildChildSystemPrompt({ cwd: "/tmp/x", notes: true }));
  // `notes: false` 仍然是一条**显式覆盖**：即使名单里点名整族，它也压过推导。
  const overridden = buildChildSystemPrompt({
    cwd: "/tmp/x",
    todo: false,
    toolNames: ["readFile", ...NOTE_FAMILY],
    notes: false,
    archiveDir: "/tmp/erix-746-r3-archive",
  });
  assert.equal(/note_/u.test(overridden), false, `notes:false 必须压过 toolNames 推导（现文：${overridden.slice(0, 400)}）`);
});

test("必修①d：「按真装配面给名单」与「不给名单走缺省」必须逐字节同一句（一份事实，两种给法）", async () => {
  // 为什么钉这条：`toolNames` 一旦成了推导的唯一入口，「把子的真面递进来」就不许改变缺省文案。
  // 这一格同时是 golden 的守卫：它红了就说明「为了修窄名单而改了缺省那一份」。
  // 名单不手抄：直接拿子 run 用的那一个装配函数（`createCliTools`）现取。
  const { createCliTools } = await import("../bin/tools.js");
  const surfaceNames = createCliTools({ cwd: "/tmp/erix-746-r3-surface", todo: true, delegate: false })
    .tools
    .map((tool) => tool.name);
  assert.ok(surfaceNames.includes("exec") && surfaceNames.includes("todo_add"), `现取的名单不对：${surfaceNames}`);
  const asNames = buildChildSystemPrompt({
    cwd: "/tmp/x",
    todo: true,
    toolNames: [...surfaceNames, ...NOTE_FAMILY],
  });
  assert.equal(
    asNames,
    buildChildSystemPrompt({ cwd: "/tmp/x", todo: true }),
    "递进真名单 ⇒ 缺省那份提示词一字不许动（golden）",
  );
});

test("必修①e：`notesOnToolNames` 与 `notesOnToolSurface` 是同一把尺（名字侧不许自造口径）", () => {
  const withFamily = [...NOTE_FAMILY, "readFile"];
  assert.equal(notesOnToolNames(withFamily), true);
  assert.equal(notesOnToolNames(["readFile", "exec"]), false);
  // 缺一角 ⇒ false（整族全有或全无，与 `src/loop/note-prompt-hint.js` 同一条口径）。
  assert.equal(notesOnToolNames(["note_take", "note_list"]), false);
  assert.equal(notesOnToolNames(undefined), false, "没有名单 ⇒ 不表态 ⇒ false（「有」是缺省装配面的事实，不是这一层的）");
});

// ────── 必修① 的反向钉子：`bin/` 里不许再出现「另递一份 notes」的那个形状 ──────

test("必修①f：子侧不许再另递一份 `notes`（两个输入 = 漏一份没人红，这是本轮真正的病根）", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(join(root, "bin/delegation.js"), "utf8");
  assert.equal(
    /notes:\s*notesOnToolSurface\(childTools\)/u.test(source),
    false,
    "bin/delegation.js 又把 `notes` 单独递给 builder 了：清单行与处境段重新变成两份输入，"
    + "调用方漏一份就默默回到「有笔记」，而集成用例看不见（第 2 轮的形状）",
  );
  assert.match(
    source,
    /notesOnToolNames\(surfaceNames\)/u,
    "buildChildSystemPrompt 必须自己从名单现推 `notes`（这一位没了，窄名单又回到恒「有笔记」）",
  );
});

// ────── 真装配回归：推导必须在**生产路径**上活着，不只是直接调 builder 时活着 ──────

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

async function runChildWith({ tag, toolAllowlist }) {
  const root = await makeTmp(`erix-746-r3-${tag}-`);
  await mkdir(join(root, "notes"), { recursive: true });
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
    toolAllowlist,
  });
  const ran = await delegation.execute({ action: "run", task: "小修回归" }, { runId: `parent-746r3-${tag}` });
  return { root, ran, child: provider.requests.find((entry) => entry.role === "child") };
}

test("必修① 回归（真装配）：白名单点名笔记工具 ⇒ 子 run 跑完且提示词 note-first（推导在生产路径上）", async () => {
  const { root, ran, child } = await runChildWith({
    tag: "allowed",
    toolAllowlist: `readFile,exec,${NOTE_FAMILY.join(",")}`,
  });
  assert.equal(ran.ok, true, `派生应成功：${JSON.stringify(ran)}`);
  const record = readRecord(join(root, "roster"), ran.runId);
  assert.equal(record.state, "completed", `子 run 必须跑完（现 ${record.state} / ${record.errorMessage ?? ""}）`);
  assert.ok(child.toolNames.includes("note_take"), "前提：笔记工具真在子的面上");
  assert.match(child.system, /先 note_list 再 note_read/u, "子的面上有整族 ⇒ 指引必须在");
  assert.equal(toolListLine(child.system).includes("note_take"), false, "清单行仍不列笔记工具");
});

test("必修① 回归（真装配）：白名单滤掉笔记 ⇒ 子提示词一个 note_* 都没有（含归档提示那一支）", async () => {
  const { root, ran, child } = await runChildWith({ tag: "filtered", toolAllowlist: "readFile,exec" });
  assert.equal(ran.ok, true, `派生应成功：${JSON.stringify(ran)}`);
  assert.equal(child.toolNames.includes("note_take"), false, "前提：子的面上没有笔记工具");
  assert.equal(/note_/u.test(child.system), false, `子提示词不许提场上不存在的工具（现文：${child.system.slice(0, 500)}）`);
  assert.match(child.system, /重读源文件/u);
  // 归档提示那一支：CLI 装配根总是带着 archiveDir，所以这句必须在被扫的文本里（第 2 轮 G1c 漏的那支）。
  assert.match(child.system, /\[工具输出归档\]/u, `子的归档提示必须在场（否则「归档那一支也被修好了」这句话没被观测）：${child.system.slice(-300)}`);
});
