// e2e（**离线，始终跑**，无需 LLM_KIT_E2E）：`delegate` 工具的真嵌套派生流。
//
// 父 `runToolLoop` 挂 `createDelegateTool` 装配的 delegate 工具；`runChild` 是**嵌套的真
// `runToolLoop`**（脚本化假 provider，内联在本文件）；roster / 租约 / 通知全部落在临时目录。
// 不联网（连 globalThis.fetch 都替你关掉）、不读 `~/.erix`、零真实子进程——库不 fork / 不 spawn。
//
// 验收锚点（issue #617 P1b）：
//   ① 子名册记录的 parentRunId 逐字等于父 runId（父身份库从执行上下文自取，schema 无此键）；
//   ② 后台完成唤醒父恰好一次；父 result 自取终局后不再被唤醒；
//   ③ 前台派生等完直接拿子 text；配额满点名持有者不排队。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createDelegateTool } from "../src/tools/delegation/tool.js";

/**
 * 脚本化假 provider（只在本例存活）：按脚本逐条应答，请求全部留痕供断言。
 * @param {Array<object>} script
 */
function createScriptedFakeProvider(script) {
  const requests = [];
  let index = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chat(request) {
      requests.push(request);
      if (index >= script.length) throw new Error("scripted provider exhausted");
      const step = script[index];
      index += 1;
      return {
        content: step.content ?? [],
        stopReason: step.stopReason ?? "end_turn",
      };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

/** 关掉网络：本例不该发任何请求（假 provider 是本地的，这里防的是误配真 provider）。 */
function withNetworkClosed(fn) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("delegate-e2e 是离线用例，不应发任何网络请求");
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = savedFetch;
    });
}

/**
 * 宿主装配的 runChild：嵌套的真 runToolLoop。宿主负责把引擎的终止词（
 * `result.termination.reason`）交回库的映射表词汇（本例逐字同词），abort 时引擎抛错带
 * `termination.reason`，这里收成正常返回——cancel 路径依赖这个归一。
 */
async function runChildNestedLoop({ task, parentRunId, runId, signal }) {
  try {
    const child = await runToolLoop({
      provider: createScriptedFakeProvider([
        { content: [{ type: "text", text: `child(${runId}) done: ${task}` }], stopReason: "end_turn" },
      ]),
      executeTool: async () => "ok",
      tools: [{ name: "noop", description: "probe", inputSchema: { type: "object", properties: {} } }],
      config: {
        run: { runId, ...(parentRunId === undefined ? {} : { parentRunId }), maxRounds: 2, completion: false },
        input: { initialUserMessage: task, wrapup: false },
      },
      signal,
    });
    return { text: child.finalText, termination: child.termination?.reason, verification: child.verification };
  } catch (error) {
    if (error?.termination?.reason !== undefined) {
      return { text: error.finalText ?? "", termination: error.termination.reason };
    }
    throw error;
  }
}

test("delegate e2e（离线）：后台派生 → 完成唤醒恰好一次 → result 自取 → 归属逐字", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delegate-e2e-"));
  try {
    await withNetworkClosed(async () => {
      /** @type {string[]} */
      const notifications = [];
      const delegate = createDelegateTool({
        runChild: runChildNestedLoop,
        rosterDir: dir,
        notifyParent: (text) => notifications.push(text),
      });
      const PARENT_RUN_ID = "delegate-e2e-parent";

      const bridge = ({ name, input, context }) => (
        name === "delegate" ? delegate.execute(input, context) : "ok"
      );
      const parent = await runToolLoop({
        provider: createScriptedFakeProvider([
          {
            content: [{
              type: "tool_use",
              id: "deleg-1",
              name: "delegate",
              input: { action: "run", task: "draft a haiku", background: true },
            }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "parent done" }], stopReason: "end_turn" },
        ]),
        executeTool: bridge,
        tools: [delegate.definition],
        config: {
          run: { runId: PARENT_RUN_ID, maxRounds: 4, completion: false },
          input: { initialUserMessage: "spawn a child", wrapup: false },
        },
      });
      assert.equal(parent.termination?.reason, "end_turn");

      // ① 归属逐字：父身份来自执行上下文，不是模型入参。
      const list = await delegate.execute({ action: "list" });
      assert.equal(list.records.length, 1);
      const child = list.records[0];
      assert.equal(child.parentRunId, PARENT_RUN_ID, "子记录 parentRunId 逐字等于父 runId");

      // ② 唤醒恰好一次；父自取终局后不再唤醒。
      await (async () => {
        const start = Date.now();
        while (notifications.length < 1 && Date.now() - start < 2_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      assert.equal(notifications.length, 1, "后台完成恰好唤醒一次");
      assert.match(notifications[0], /^【子run完成】/u);
      const got = await delegate.execute({ action: "result", runId: child.runId });
      assert.equal(got.ok, true);
      assert.equal(got.state, "completed");
      assert.equal(got.termination, "end_turn");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(notifications.length, 1, "父 result 自取后不再被唤醒");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delegate e2e（离线）：前台派生等完拿子 text；配额满点名持有者不排队", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delegate-e2e-"));
  try {
    await withNetworkClosed(async () => {
      const delegate = createDelegateTool({
        runChild: runChildNestedLoop,
        rosterDir: dir,
        maxConcurrent: 1,
      });
      const sync = await delegate.execute(
        { action: "run", task: "sync job" },
        { runId: "delegate-e2e-sync-parent" },
      );
      assert.equal(sync.ok, true);
      assert.equal(sync.state, "completed");
      assert.equal(sync.text, `child(${sync.runId}) done: sync job`, "前台把子 run 的 text 作为工具结果");

      // 占住唯一配额（后台、永不收尾），第二个 run 必须结构化失败并点名持有者。
      const occupying = await delegate.execute(
        { action: "run", task: "occupy", background: true },
        { runId: "delegate-e2e-sync-parent" },
      );
      const refused = await delegate.execute(
        { action: "run", task: "should not queue" },
        { runId: "delegate-e2e-sync-parent" },
      );
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, "capacity_full");
      assert.ok(
        refused.holders.some((holder) => holder.runId === occupying.runId),
        "配额失败点名当前持有者",
      );
      assert.equal((await delegate.execute({ action: "list" })).records.length, 2, "没有排队产生的第三条记录");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
