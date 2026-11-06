// --no-todo / ERIX_NO_TODO 开关装配级集成测试（issue #69）
// 镜像 --no-notes 先例：彻底关（内置 todo 四工具不注册 + 系统提示无 todo + 用户级
// todo skill 经 excludeSkillIds 排除）。走 runChat/runRepl 真实装配路径，
// 用 captureLoop 截获模型侧可见的工具表与系统提示；env 注入隔离，测完还原。
//
// issue #716 × #69（合并树红灯）：本文件断言「系统提示不得含 todo 字样」，而 issue #716 起
// `<cwd>/AGENTS.md` 会**默认整份**拼进系统提示（上限 32 KiB）。本文件从前不注入 cwd ⇒ 跑在仓库树里
// ⇒ 把本仓自己的 AGENTS.md 注了进去（它写着 `todo_add` / `~/.erix/todos/`）⇒ 断言撞上注入内容。
// #719 单独跑时是绿的纯属巧合：当时那份 AGENTS.md 有 11 万字节、被 32 KiB 上限截断，todo 字样正好
// 落在截断线之外；#726 把它瘦到 32,698 字节后整份都能注入，交互才现形。
// 修法是**给用例做 cwd 隔离**（AGENTS「Test isolation rule」）：chat 五例显式传 `cwd: <makeTmp 目录>`
// （临时目录里没有 AGENTS.md ⇒ 注入 0 个文件，注入通道仍然开着，交互本身没被绕开）；
// repl 那一例没有 cwd 缝（`runRepl` 的工作目录就是 `process.cwd()`，见 bin/repl.js 的 #391 R1 注释），
// 因此显式传 `--no-agents` 关掉注入——它测的是 `--no-todo`，不是项目约定注入。
// 「注入真的开着时 --no-todo 仍然成立」这条交互由本文件末尾那条新增用例锁住。
//
// 临时目录前缀一律 `erix-switch-…`（不带 `todo` 字样）：系统提示第一句是「工作目录 <cwd>」，
// 而 cwd 就是这层临时目录——前缀写 `erix-no-todo-flag-` 时，那句路径自己就命中 `/todo/i`
// （实测踩过：改成 cwd 隔离之后仍红，红在路径上）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runChat } from "../../bin/cli.js";
import { runRepl } from "../../bin/repl.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { makeTmp } from "../helpers/tmp.js";

// issue #81：注入 notesDir / skillsDir / 空 MCP 配置，避免触达真实 ~/.erix
//（notes 收尾 purge 会扫描真实笔记目录，MCP 缺省解析真实 ~/.erix/mcp.json）。
async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

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

/**
 * issue #498 S5：`bin/` 的 `runToolLoop` 选项按**规位**书写（数据 ⇒ `config.*`）。
 * 本读取器两个方向都断言：规位必须真读到值（`undefined` 就红，防止映射改错退化成恒真格），
 * 且扁平位**不得**同时存在（同一个旋钮两个真相来源 ⇒ `config_override_conflict`）。
 *
 * @param {{options?: Record<string, any>}} ref `captureLoop` 的捕获桶
 * @param {string} path 规位路径
 * @returns {any}
 */
function optionAt(ref, path) {
  const value = path.split(".").reduce(
    (node, key) => (node === undefined || node === null ? undefined : node[key]),
    ref.options,
  );
  assert.notEqual(value, undefined, `规位 ${path} 读不到值（映射断了，或又写回了扁平位）`);
  const flatName = path.split(".").at(-1);
  assert.equal(
    Object.hasOwn(ref.options, flatName),
    false,
    `${flatName} 不得同时出现在扁平位：同一个旋钮两个真相来源 ⇒ config_override_conflict`,
  );
  return value;
}

/** issue #527：`tools` 是永久顶层面（第三站），住在顶层；`config.input.tools` 不得存在。 */
function toolsAt(ref) {
  assert.equal(Array.isArray(ref.options.tools), true, "tools 必须在顶层（永久顶层面，第三站）");
  assert.equal(
    Object.hasOwn(ref.options.config?.input ?? {}, "tools"),
    false,
    "config.input.tools 叶子已被 #527 拆掉：它不得再出现在规位",
  );
  return ref.options.tools;
}

const TODO_NAMES = ["todo_add", "todo_list", "todo_done", "todo_clear"];

function assertNoTodo(ref, label) {
  const names = toolsAt(ref).map((tool) => tool.name);
  for (const name of TODO_NAMES) {
    assert.ok(!names.includes(name), `${label}：工具表不得包含 ${name}`);
  }
  assert.ok(names.includes("exec"), `${label}：非 todo 工具应保持可用`);
  assert.doesNotMatch(optionAt(ref, "config.input.system"), /todo/i, `${label}：系统提示不得含 todo 字样`);
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
  const dir = await makeTmp("erix-switch-on-");
  const ref = {};
  try {
    await runChat({
      prompt: "hi",
      session: "no-todo-on",
      dir,
      cwd: dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills-empty"),
      configPath: await writeEmptyMcpConfig(dir),
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop(ref),
    });
    const names = toolsAt(ref).map((tool) => tool.name);
    for (const name of TODO_NAMES) {
      assert.ok(names.includes(name), `默认路径应包含 ${name}`);
    }
    assert.match(optionAt(ref, "config.input.system"), /todo_add 添加待办任务/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat --no-todo：工具表无 todo_*、系统提示无 todo、用户级 todo skill 被排除且无同名告警", async () => {
  const dir = await makeTmp("erix-switch-flag-");
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
      cwd: dir,
      notesDir: join(dir, "notes"),
      skillsDir,
      configPath: await writeEmptyMcpConfig(dir),
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
    const names = toolsAt(ref).map((tool) => tool.name);
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
  const dir = await makeTmp("erix-switch-allowlist-");
  const ref = {};
  const stderrLines = [];
  const originalError = console.error;
  console.error = (line) => stderrLines.push(String(line));
  try {
    await runChat({
      prompt: "hi",
      session: "no-todo-allowlist",
      dir,
      cwd: dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      noTodo: true,
      tools: "todo_add,exec",
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop(ref),
    });
    assert.deepEqual(toolsAt(ref).map((tool) => tool.name), ["exec"]);
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
  const dir = await makeTmp("erix-switch-env-");
  const ref = {};
  const saved = process.env.ERIX_NO_TODO;
  process.env.ERIX_NO_TODO = "1";
  try {
    await runChat({
      prompt: "hi",
      session: "no-todo-env",
      dir,
      cwd: dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
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
  const dir = await makeTmp("erix-switch-conflict-");
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
      cwd: dir,
      notesDir: join(dir, "notes"),
      skillsDir,
      configPath: await writeEmptyMcpConfig(dir),
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
    const names = toolsAt(ref).map((tool) => tool.name);
    assert.equal(names.filter((name) => name === "todo_add").length, 1, "只保留内置实现");
  } finally {
    console.error = originalError;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRepl ERIX_NO_TODO=1：repl env 路径工具表无 todo_*、系统提示无 todo", async () => {
  const dir = await makeTmp("erix-switch-repl-");
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
    // `--no-agents`：repl 没有 cwd 缝（工作目录恒为 process.cwd()），注入关不掉就会把仓库自己的
    // AGENTS.md 拼进系统提示，撞上下面那条「不得含 todo 字样」。旗标比「改 process.cwd()」诚实：
    // chdir 是全局副作用，会把同文件里其它用例的路径语义一起带走。
    const run = runRepl(
      ["--session", "no-todo-repl", "--dir", dir, "--config", await writeEmptyMcpConfig(dir), "--no-agents"],
      {
        input,
        output,
        sessionDir: dir,
        home: dir,
        notesDir: join(dir, "notes"),
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

// ---------------------------------------------------------------------------
// issue #716 × #69：项目约定注入与 `--no-todo` 的交互（合并树红灯 1 的锁）
// ---------------------------------------------------------------------------
//
// 病：`--no-todo` 的判据原本是「**整段**系统提示不含 todo 字样」。而 issue #716 起
// `<cwd>/AGENTS.md` 默认整份拼进系统提示——只要 cwd 里那份约定写着 todo（本仓自己的就写着
// `todo_add` / `~/.erix/todos/`），这条判据就红，而 `--no-todo` 其实一点没坏。
//
// 本用例把「开关」与「注入」两件事**同时**摆到台面上：
//   ① 注入真的发生了（哨兵在系统提示里）——否则下面的判据是空跑；
//   ② 工具表里一个 todo_* 都没有（注入段不得让 todo 工具复活）；
//   ③ 内置那一段（注入段**之外**）不含 todo 字样（内置提示不得复活）；
//   ④ 整段系统提示**确实**含 todo 字样 —— 这是「判据必须把注入段排除在外」的机器证据：
//      谁把判据改回「整段 /todo/i」，这一例立刻红（不是恒真格）；
//   ⑤ 反向证：同一份 cwd / 同一份 AGENTS.md，只把 `--no-todo` 摘掉 ⇒ 内置 todo 段回来 ⇒
//      ③ 那条判据真的咬得住（判据对「内置 todo 段被注回系统提示」这件事敏感）。

/** 夹具约定文件：形状照抄本仓 AGENTS.md 里那几句（含 `todo_add` / `todos/` 字样）。 */
const AGENTS_FIXTURE = `# 项目约定（夹具，不是本仓真文件）

- 长任务用 todo_add 记录进度、todo_done 标记完成，随时 todo_list 核对剩余项。
- 待办数据落在 ~/.erix/todos/ 下，按 cwd 分目录。
- ${"SENTINEL-716-TODO-INJECTION"}

`;

/** 系统提示里「项目约定」段的起点（bin/system-prompt.js 的段落头，逐字取自那里）。 */
const INJECTED_SECTION_MARKER = "\n\n[项目约定]";

/**
 * 去掉项目约定注入段之后的系统提示 = **内置那一段**。
 *
 * 为什么必须切：注入内容是用户数据，它提到 todo 不代表 todo 功能活着；判据要咬的是内置那一段。
 *
 * @param {string} system `config.input.system`
 * @returns {string}
 */
function builtinPromptPart(system) {
  const at = system.indexOf(INJECTED_SECTION_MARKER);
  return at === -1 ? system : system.slice(0, at);
}

test("runChat --no-todo：cwd 的 AGENTS.md 含 todo 字样时开关仍然成立（注入段不复活 todo）", async () => {
  const dir = await makeTmp("erix-switch-agents-");
  try {
    await writeFile(join(dir, "AGENTS.md"), AGENTS_FIXTURE, "utf8");
    const ref = {};
    await runChat({
      prompt: "hi",
      session: "no-todo-agents",
      dir,
      cwd: dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      noTodo: true,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      noticeLog: () => {},
      loop: captureLoop(ref),
    });
    const system = optionAt(ref, "config.input.system");
    // ② 注入段不得让 todo 工具复活
    const names = toolsAt(ref).map((tool) => tool.name);
    assert.equal(names.filter((name) => name.startsWith("todo_")).length, 0,
      `--no-todo + 注入：工具表里不得出现任何 todo_*（实测 ${names.join(", ")}）`);
    // ① 夹具自证：注入真的发生了（cwd 里那份 AGENTS.md 整份进了系统提示）
    assert.ok(system.includes("SENTINEL-716-TODO-INJECTION"),
      "夹具自证失败：cwd 的 AGENTS.md 没被注入 ⇒ 本用例在空跑");
    // ③ 判据：内置那一段不含 todo 字样
    assert.doesNotMatch(builtinPromptPart(system), /todo/i,
      "--no-todo + 注入：内置系统提示不得含 todo 字样（注入段已排除在判据之外）");
    // ④ 夹具自证二：整段系统提示**确实**含 todo 字样 ⇒「整段 /todo/i」那条旧判据在本夹具下必红
    assert.match(system, /todo/i,
      "夹具自证失败：注入段里没有 todo 字样 ⇒ 这一例证不出「判据必须排除注入段」");

    // ⑤ 反向证：同一份 cwd / AGENTS.md，摘掉 --no-todo ⇒ 内置 todo 段回来 ⇒ ③ 会红
    const controlRef = {};
    await runChat({
      prompt: "hi",
      session: "no-todo-agents-control",
      dir,
      cwd: dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: join(dir, "mcp.json"),
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      noticeLog: () => {},
      loop: captureLoop(controlRef),
    });
    const controlSystem = optionAt(controlRef, "config.input.system");
    assert.match(builtinPromptPart(controlSystem), /todo_add 添加待办任务/u,
      "反向证失败：不传 --no-todo 时内置 todo 段本应出现 —— 它没出现说明 ③ 是恒真格，咬不住「todo 段被注回」");
    assert.ok(toolsAt(controlRef).map((tool) => tool.name).includes("todo_add"),
      "反向证失败：不传 --no-todo 时 todo_add 本应在工具表里");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
