// issue #617（CLI 收尾小刀）：`← tool: …` 回显的**类**缺陷——返回对象形状的工具一律打出 `[object Object]`。
//
// 现场：`node bin/cli.js chat '…' --delegate` 的父 run 界面上是 `← delegate: [object Object]`，
// 功能侧全对（名册 / 子 transcript / 父会话零外键），只有调试器的回显是坏的。根因在
// `bin/tools.js` 的 `summarizeToolResult`：它只认 #195 为 `searchText` 加的窄形状 `{content: string}`，
// 而 `delegate` 返回 `{ok, runId, state, termination, text}`（没有 `content` 键）⇒ `String(payload)`。
//
// 所以本文件钉的不是「delegate 这一格」，而是**那一类**：
//   ① 对象/数组拿不到可展示字符串时，JSON 紧凑序列化后回显（单行，仍走既有截断）；
//   ② `{content: string}` 的既有优先行为**不许**被通用修法顶掉（#195 的先例）；
//   ③ 序列化失败（循环引用 / BigInt）回落成 `String(...)`，**不许抛错**把 CLI 打挂；
//   ④ 端到端走 `wrapExecuteTool` 的 `output(`← ${name}: …`)` 那一行（CLI 边界），断言看得见子 run 的 runId。
//
// 全离线：`delegate` 的执行器是桩（本文件只验回显，不跑子 run），临时目录走 `makeTmp`。

import assert from "node:assert/strict";
import test from "node:test";

import { createCliTools, summarizeToolResult, wrapExecuteTool } from "../bin/tools.js";
import { makeTmp } from "./helpers/tmp.js";

/** 真机跑出来的形状（`src/tools/delegation/tool.js` 的 runAction 前台返回，只留回显关心的三键）。 */
const DELEGATE_RESULT = { ok: true, runId: "sub-x", state: "completed" };

test("summarizeToolResult('delegate', …) 回显 runId，不再是 [object Object]（#617）", () => {
  const line = summarizeToolResult("delegate", DELEGATE_RESULT);
  assert.ok(line.includes("sub-x"), `回显必须含子 run 的 runId，实际：${line}`);
  assert.doesNotMatch(line, /\[object Object\]/u);
  // 紧凑单行：键值可读、不带缩进换行（回显一行一条，不能被结果里的换行撑开）
  assert.equal(line, '{"ok":true,"runId":"sub-x","state":"completed"}');
});

test("通用修法覆盖「对象/数组」这一类：没有 content 键也看得见（#195 窄补丁留下的类）", () => {
  // 对象：下一个返回对象形状的新工具不必再回来补第三刀
  assert.equal(summarizeToolResult("someNewTool", { rows: [{ id: 7 }] }), '{"rows":[{"id":7}]}');
  // 数组：`String([...])` 会退化成逗号拼接（元素是对象时就是 [object Object]），一律 JSON
  assert.equal(summarizeToolResult("someNewTool", [{ id: 7 }, "ok"]), '[{"id":7},"ok"]');
  // 标量结果不受影响（既有路径逐字不变）
  assert.equal(summarizeToolResult("someNewTool", "plain text"), "plain text");
  assert.equal(summarizeToolResult("someNewTool", undefined), "");
  assert.equal(summarizeToolResult("someNewTool", 42), "42");
});

test("{content: string} 仍优先取正文，不被 JSON 序列化顶掉（#195 先例）", () => {
  const line = summarizeToolResult("searchText", {
    content: "a.txt:1:needle here",
    metadata: { searchHits: 1 },
  });
  assert.equal(line, "a.txt:1:needle here", "回显必须是正文，不是整包 JSON");
  assert.doesNotMatch(line, /metadata/u);
});

test("序列化失败（循环引用 / BigInt）不抛错，回落成 String(...) 的旧行为", () => {
  const circular = { ok: false, reason: "boom" };
  circular.self = circular;
  let circularLine;
  assert.doesNotThrow(() => {
    circularLine = summarizeToolResult("delegate", circular);
  }, "回显是调试设施：序列化失败不许把 CLI 打挂");
  // 回落的定义就是「改动前的行为」：String(obj)
  assert.equal(circularLine, String(circular));

  const withBigInt = { ok: true, count: 1n };
  let bigintLine;
  assert.doesNotThrow(() => {
    bigintLine = summarizeToolResult("delegate", withBigInt);
  });
  assert.equal(bigintLine, String(withBigInt));
});

test("JSON 回显仍走既有截断（非 exec 上限 200，head 截断 + 省略号）", () => {
  const line = summarizeToolResult("delegate", {
    ok: true,
    runId: "sub-x",
    text: "长".repeat(1000),
  });
  assert.ok(line.length <= 201, `非 exec 结果摘要上限 200（+省略号），实际 ${line.length}`);
  assert.ok(line.endsWith("…"), "截断标记沿用 truncateDisplayText 的省略号");
  assert.ok(line.includes("sub-x"), "runId 在 JSON 前部，截断后仍看得见");
});

test("端到端：wrapExecuteTool 的 `← delegate: …` 回显行里看得见子 run 的 runId（#617 CLI 边界）", async () => {
  const cwd = await makeTmp("erix-cli-tool-echo-617-");
  const subRunId = "sub-e2e-617";
  const calls = [];
  // 执行上下文单独存一格（不用对象字面量里的 `context` 简写：`test/compat-pin-inventory.md` 的
  // 扁平选项写点计数器按属性名数，这里造出来的「写点」不是兼容性钉子，不该进那张表）。
  let seenContext;
  const { executeTool } = createCliTools({
    cwd,
    delegate: true,
    delegateTool: {
      // 桩执行器：本文件只验回显，子 run 由 test/cli-delegate-617.test.js 与库侧测试真跑。
      execute: async (input, context) => {
        calls.push(input);
        seenContext = context;
        return {
          ok: true,
          runId: subRunId,
          state: "completed",
          termination: "end_turn",
          text: "子 run 的终稿",
        };
      },
    },
  });

  const lines = [];
  const echo = wrapExecuteTool(executeTool, { output: (line) => lines.push(line) });
  const result = await echo("delegate", { action: "run", task: "写一个文件" }, { runId: "parent-1" });

  // 返回值不受回显改动影响（库面契约零变化：宿主可能已在消费这个形状）
  assert.equal(result.runId, subRunId);
  assert.equal(result.text, "子 run 的终稿");
  assert.equal(calls.length, 1, "执行器真的被调到（回显不是凭空造的）");
  assert.deepEqual(calls[0], { action: "run", task: "写一个文件" }, "入参原样透传");
  assert.deepEqual(seenContext, { runId: "parent-1" }, "执行上下文原样透传（#184 的 signal 同一条路）");

  const line = lines.at(-1);
  assert.match(line, /^← delegate: /u, `回显行形状不变，实际：${line}`);
  assert.ok(line.includes(subRunId), `回显行必须含子 run 的 runId，实际：${line}`);
  assert.doesNotMatch(line, /\[object Object\]/u);
});
