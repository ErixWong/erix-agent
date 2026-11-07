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
import { join } from "node:path";
import test from "node:test";

import { buildChildSystemPrompt, createCliDelegation } from "../bin/delegation.js";
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
