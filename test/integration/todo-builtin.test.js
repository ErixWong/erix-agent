// todo 内置工具 CLI 装配集成测试（issue #65）
// 走 runChat 真实装配路径（createCliTools + buildSkillTools + combineTools），
// 用注入的 fake provider 触发 todo_add/todo_list 调用，断言模型侧收到的
// tool_result 是可读字符串。HOME 指向临时目录，不触碰真实 ~/.erix/todos/。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";

import { runChat } from "../../bin/cli.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

test("runChat 装配后内置 todo_add/todo_list 返回可读字符串（裸环境无 todo skill）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-todo-integration-"));
  const home = join(dir, "home");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const provider = createFakeProvider([
      {
        content: [{
          type: "tool_use",
          id: "call-add",
          name: "todo_add",
          input: { text: "集成冒烟任务" },
        }],
        stopReason: "tool_use",
      },
      {
        content: [{
          type: "tool_use",
          id: "call-list",
          name: "todo_list",
          input: {},
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    const result = await runChat({
      prompt: "记录并查看待办",
      session: "todo-integration",
      dir: join(dir, "transcripts"),
      notesDir: join(dir, "notes"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      finalGuard: false,
      maxRounds: 3,
      idleTimeout: 0,
    });

    assert.equal(result.finalText, "done");
    assert.equal(provider.requests.length, 3);

    const toolResultContents = (request) => request.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result")
      .map((block) => block.content);
    const secondRound = toolResultContents(provider.requests[1]);
    assert.ok(secondRound.some((content) => (
      typeof content === "string" && /已添加任务 #1: 集成冒烟任务/.test(content)
    )));
    const thirdRound = toolResultContents(provider.requests[2]);
    assert.ok(thirdRound.some((content) => (
      typeof content === "string" && /共 1 条任务/.test(content)
        && /#1 \[pending\] 集成冒烟任务/.test(content)
    )));

    // 数据文件按原 skill 定位规则落在隔离 HOME 下，格式兼容
    const cwd = process.cwd();
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
    const dataPath = join(home, ".erix", "todos", `${basename(cwd)}-${hash}.json`);
    const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].text, "集成冒烟任务");
    assert.equal(onDisk[0].status, "pending");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});
