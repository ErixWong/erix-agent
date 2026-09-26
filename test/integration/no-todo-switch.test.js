// --no-todo / ERIX_NO_TODO 开关装配级集成测试（issue #69）
// 镜像 --no-notes 先例：彻底关（内置 todo 四工具不注册 + 系统提示无 todo + 用户级
// todo skill 经 excludeSkillIds 排除）。走 runChat/runRepl 真实装配路径，
// 用 captureLoop 截获模型侧可见的工具表与系统提示；env 注入隔离，测完还原。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runChat } from "../../bin/cli.js";
import { runRepl } from "../../bin/repl.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

function captureLoop(ref) {
  return async (options) => {
    ref.options = options;
    return {
      finalText: "done",
      messages: [],
      rounds: 1,
      truncated: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      compactionStats: [],
    };
  };
}

const TODO_NAMES = ["todo_add", "todo_list", "todo_done", "todo_clear"];

function assertNoTodo(ref, label) {
  const names = ref.options.tools.map((tool) => tool.name);
  for (const name of TODO_NAMES) {
    assert.ok(!names.includes(name), `${label}：工具表不得包含 ${name}`);
  }
  assert.ok(names.includes("exec"), `${label}：非 todo 工具应保持可用`);
  assert.doesNotMatch(ref.options.system, /todo/i, `${label}：系统提示不得含 todo 字样`);
}

async function writeTodoSkill(skillsDir) {
  const directory = join(skillsDir, "todo");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "skill.mjs"),
    `export function getSkillDefinition() {
  return {
    schema_version: 1,
    skill: { id: "todo", entrypoint: "skill.mjs" },
    tools: [
      { name: "todo_add", description: "用户级 todo_add", inputSchema: { type: "object" } },
      { name: "todo_list", description: "用户级 todo_list", inputSchema: { type: "object" } },
    ],
  };
}
export async function todo_add() { return "skill todo_add"; }
export async function todo_list() { return "skill todo_list"; }
`,
    "utf8",
  );
  return directory;
}

test("runChat 默认路径：todo 四工具在模型工具表中（回归）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-no-todo-on-"));
  const ref = {};
  try {
    await runChat({
      prompt: "hi",
      session: "no-todo-on",
      dir,
      skillsDir: join(dir, "skills-empty"),
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop(ref),
    });
    const names = ref.options.tools.map((tool) => tool.name);
    for (const name of TODO_NAMES) {
      assert.ok(names.includes(name), `默认路径应包含 ${name}`);
    }
    assert.match(ref.options.system, /todo_add 添加待办任务/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat --no-todo：工具表无 todo_*、系统提示无 todo、用户级 todo skill 被排除且无同名告警", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-no-todo-flag-"));
  const ref = {};
  const skillsDir = join(dir, "skills");
  const stderrLines = [];
  const originalError = console.error;
  console.error = (line) => stderrLines.push(String(line));
  try {
    await writeTodoSkill(skillsDir);
    await runChat({
      prompt: "hi",
      session: "no-todo-flag",
      dir,
      skillsDir,
      noTodo: true,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop(ref),
    });
    assertNoTodo(ref, "--no-todo");
    // 用户级 todo skill 经 excludeSkillIds 排除：不得出现任何 todo_* 实现（含 skill 版）
    const names = ref.options.tools.map((tool) => tool.name);
    assert.equal(names.filter((name) => name.startsWith("todo_")).length, 0);
    // 排除后不存在同名冲突，warnBuiltinToolConflicts 不得产生告警噪音
    assert.equal(
      stderrLines.filter((line) => /同名|冲突|冲突/u.test(line)).length,
      0,
      `不得出现同名工具告警：${stderrLines.join(" | ")}`,
    );
  } finally {
    console.error = originalError;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat --no-todo 与 --tools 白名单正交：先关 todo 再过白名单（issue #69）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-no-todo-allowlist-"));
  const ref = {};
  const stderrLines = [];
  const originalError = console.error;
  console.error = (line) => stderrLines.push(String(line));
  try {
    await runChat({
      prompt: "hi",
      session: "no-todo-allowlist",
      dir,
      noTodo: true,
      tools: "todo_add,exec",
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop(ref),
    });
    assert.deepEqual(ref.options.tools.map((tool) => tool.name), ["exec"]);
    assert.ok(
      stderrLines.some((line) => line.includes("todo_add") && line.includes("不存在")),
      `todo_add 已被 --no-todo 移除，出现在 --tools 里应警告不存在：${stderrLines.join(" | ")}`,
    );
  } finally {
    console.error = originalError;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat ERIX_NO_TODO=1：env 路径与 --no-todo 等价（env 隔离注入、测完还原）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-no-todo-env-"));
  const ref = {};
  const saved = process.env.ERIX_NO_TODO;
  process.env.ERIX_NO_TODO = "1";
  try {
    await runChat({
      prompt: "hi",
      session: "no-todo-env",
      dir,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop(ref),
    });
    assertNoTodo(ref, "ERIX_NO_TODO=1");
  } finally {
    if (saved === undefined) delete process.env.ERIX_NO_TODO;
    else process.env.ERIX_NO_TODO = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat 用户级 todo skill 默认路径产生同名冲突告警（issue #65 行为对照）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-no-todo-conflict-"));
  const ref = {};
  const skillsDir = join(dir, "skills");
  const stderrLines = [];
  const originalError = console.error;
  console.error = (line) => stderrLines.push(String(line));
  try {
    await writeTodoSkill(skillsDir);
    await runChat({
      prompt: "hi",
      session: "no-todo-conflict",
      dir,
      skillsDir,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop(ref),
    });
    // 默认路径：内置 todo_* 在 builtinNames 里，用户级 todo skill 应被告警并忽略
    assert.ok(
      stderrLines.some((line) => /同名/u.test(line) && /todo/u.test(line)),
      `默认路径应保留同名告警：${stderrLines.join(" | ")}`,
    );
    const names = ref.options.tools.map((tool) => tool.name);
    assert.equal(names.filter((name) => name === "todo_add").length, 1, "只保留内置实现");
  } finally {
    console.error = originalError;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl ERIX_NO_TODO=1：repl env 路径工具表无 todo_*、系统提示无 todo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-no-todo-repl-"));
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = false;
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "hi there" }] },
  ]);
  const saved = process.env.ERIX_NO_TODO;
  process.env.ERIX_NO_TODO = "1";
  try {
    const run = runRepl(
      ["--session", "no-todo-repl", "--dir", dir],
      {
        input,
        output,
        sessionDir: dir,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => provider,
      },
    );
    input.write("hi\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    input.write("/exit\n");
    await run;

    assert.equal(provider.requests.length, 1);
    const request = provider.requests[0];
    const names = (request.tools ?? []).map((tool) => tool.name);
    for (const name of TODO_NAMES) {
      assert.ok(!names.includes(name), `repl：工具表不得包含 ${name}`);
    }
    assert.ok(names.includes("exec"), "repl：非 todo 工具应保持可用");
    const systemText = typeof request.system === "string"
      ? request.system
      : JSON.stringify(request.system ?? {});
    assert.doesNotMatch(systemText, /todo/i, "repl：系统提示不得含 todo 字样");
  } finally {
    if (saved === undefined) delete process.env.ERIX_NO_TODO;
    else process.env.ERIX_NO_TODO = saved;
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
