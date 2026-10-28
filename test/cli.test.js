import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_REFLECTION_MIN_ROUNDS } from "../src/index.js";
import {
  exitCodeForVerification,
  resolveToolResultTtl,
  resolveReflection,
  parseChatArgs,
  runChat,
} from "../bin/cli.js";
import { formatGuardMetrics } from "../bin/guard-metrics.js";
import { getMcpPoolStatus } from "../bin/mcp.js";
import {
  CLI_TOOLS_SYSTEM_PROMPT,
} from "../bin/tools.js";
import * as notes from "../src/tools/notes.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

// issue #81：runChat 的 MCP 代理默认解析 ~/.erix/mcp.json（可能配了真实远端 server），
// 每个用例必须注入空配置，彻底与真实 home 隔离。
async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

/**
 * issue #498 S5：`bin/` 的 `runToolLoop` 选项现在按**规位**书写（数据 ⇒ `config.*`、宿主回调 ⇒
 * `capabilities.hooks.*`、交付物判据 ⇒ `capabilities.checks.deliverables`、壳内端口 ⇒
 * `capabilities.ports.*`）。本读取器把「同一个旋钮现在从规位读到同一个值」变成**两个方向的断言**：
 *   ① 规位必须真读到值——`undefined` 就报错，否则「映射改错」会退化成两边都 `undefined` 的恒真格；
 *   ② 扁平位**不得**同时存在——同一个旋钮两个真相来源会让引擎记一条 `config_override_conflict`
 *      （迁移前那种写法），所以「改回扁平」或「两边都写」都必须红。
 *
 * @param {Record<string, any>} captured `loop` 收到的选项对象
 * @param {string} path 规位路径，例如 `config.run.cwd`
 * @returns {any} 规位上的值
 */
function canonicalLoopOption(captured, path) {
  const value = path.split(".").reduce(
    (node, key) => (node === undefined || node === null ? undefined : node[key]),
    captured,
  );
  assert.notEqual(value, undefined, `规位 ${path} 读不到值（映射断了，或又写回了扁平位）`);
  const flatName = path.split(".").at(-1);
  assert.equal(
    Object.hasOwn(captured, flatName),
    false,
    `${flatName} 不得同时出现在扁平位：同一个旋钮两个真相来源 ⇒ config_override_conflict`,
  );
  return value;
}

function normalizeGoldenEnvironment(value, cwd, fixtureCwd, goldenDirs = []) {
  // issue #185：落盘目录不再钉死在 /tmp，比较前把「实际临时目录」与「fixture 里记录的 dir」
  // 都归一化成同一个占位符，golden 断言因此与 TMPDIR 无关（长串先替换，避免前缀互吃）。
  const substitutions = [
    [fixtureCwd, "<cwd>"],
    [cwd, "<cwd>"],
    ...goldenDirs.map((from) => [from, "<dir>"]),
  ]
    .filter(([from]) => typeof from === "string" && from.length > 0)
    .sort(([a], [b]) => b.length - a.length);
  const text = (input) => substitutions.reduce(
    (acc, [from, to]) => acc.split(from).join(to),
    input,
  );
  if (typeof value === "string") {
    return text(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeGoldenEnvironment(entry, cwd, fixtureCwd, goldenDirs));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeGoldenEnvironment(entry, cwd, fixtureCwd, goldenDirs),
      ]),
    );
  }
  return value;
}

test("CLI prompt constrains provenance of one-shot values", () => {
  // ADR-016：重跑风险降为提示语一行（不再提幂等分类）
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /重跑同一命令可能得到不同的值/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /后续需要精确值时先 note_take 记下/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /具体数值必须来自当前工具返回或 note_read/u);
  assert.match(CLI_TOOLS_SYSTEM_PROMPT, /不要主动读取密钥、凭据或 \.env/u);
});

test("CLI fake-provider golden keeps model-visible prompt, stub, and notice stable", async () => {
  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/cli-golden.json", import.meta.url),
    "utf8",
  ));
  // issue #185：fixture 里记录的 dir 是钉死的 /tmp/erix-cli-golden，只作为比较占位；
  // 实际落盘改从 os.tmpdir() 取（前缀不复用 fixture 目录名，避免字符串前缀互相命中）。
  const dir = await makeTmp("erix-golden-run-");
  const goldenDirs = [dir, fixture.input.dir];
  const notesDir = join(dir, "notes");
  const mcpConfigPath = await writeEmptyMcpConfig(dir);
  const provider = createFakeProvider([
    { content: [{ type: "text", text: fixture.modelVisible.output }], stopReason: "end_turn" },
  ]);
  const root = {
    archiveDir: join(dir, "outputs", "golden"),
    diagnostics: { error() {} },
    notesDir,
    notesStore: createFileNotesStore({ dir: notesDir }),
    store: createMemoryTranscriptStore(),
  };
  try {
    const result = await runChat({
      ...fixture.input,
      dir,
      provider,
      configPath: mcpConfigPath,
      idleTimeout: 0,
      toolOutput: () => {},
      _assemblyRoot: root,
    });
    const fixtureCwd = fixture.modelVisible.system.match(/工作目录 (.+?)。/u)?.[1];
    assert.ok(fixtureCwd, "golden fixture must contain its recorded cwd");
    const requestSystem = provider.requests[0].system;
    const actualModelVisible = {
      system: typeof requestSystem === "string" ? requestSystem : requestSystem.content,
      messages: provider.requests[0].messages.map(({ cacheBoundary: _cacheBoundary, ...message }) => message),
      output: result.finalText,
    };
    assert.deepEqual(
      normalizeGoldenEnvironment(actualModelVisible, resolve(process.cwd()), fixtureCwd, goldenDirs),
      normalizeGoldenEnvironment(fixture.modelVisible, resolve(process.cwd()), fixtureCwd, goldenDirs),
    );
    assert.match(fixture.modelVisible.system, /\[工具输出归档\]/u);
    assert.match(fixture.modelVisible.output, /^stub=/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reflection default threshold comes from the library constant (issue #127)", () => {
  const saved = {
    ERIX_REFLECTION: process.env.ERIX_REFLECTION,
    ERIX_NO_REFLECTION: process.env.ERIX_NO_REFLECTION,
  };
  delete process.env.ERIX_REFLECTION;
  delete process.env.ERIX_NO_REFLECTION;
  try {
    // 「库写 16、CLI 写 32」的漂移被消掉后，两边必须是同一个数
    assert.equal(resolveReflection(undefined, DEFAULT_REFLECTION_MIN_ROUNDS - 1), false);
    assert.deepEqual(
      resolveReflection(undefined, DEFAULT_REFLECTION_MIN_ROUNDS),
      { enabled: true },
    );
    assert.equal(resolveReflection(true, 4)?.enabled, true);
    assert.equal(resolveReflection(false, 64), false);
    assert.equal(resolveReflection(undefined, 64)?.enabled, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("CLI tool result TTL honors explicit environment and cacheCapable config", () => {
  const previous = process.env.ERIX_TOOL_RESULT_TTL;
  try {
    process.env.ERIX_TOOL_RESULT_TTL = "3";
    assert.equal(resolveToolResultTtl({ cacheCapable: true }), 3);

    delete process.env.ERIX_TOOL_RESULT_TTL;
    assert.equal(resolveToolResultTtl({ cacheCapable: true }), 0);
    assert.equal(resolveToolResultTtl({ cacheCapable: false }), undefined);
    assert.equal(resolveToolResultTtl({}), undefined);
  } finally {
    if (previous === undefined) delete process.env.ERIX_TOOL_RESULT_TTL;
    else process.env.ERIX_TOOL_RESULT_TTL = previous;
  }
});

test("CLI uses distinct nonzero exits for unverified, guard errors, and skipped verification", () => {
  assert.equal(exitCodeForVerification({ status: "verified" }), 0);
  assert.equal(exitCodeForVerification({ status: "unverified" }), 2);
  assert.equal(exitCodeForVerification({ status: "error" }), 3);
  // skipped 不能与 verified 同为 0：调用方必须能区分"核过了"和"根本没核"
  assert.equal(exitCodeForVerification({ status: "skipped", reason: "no_capture_evidence" }), 4);
  assert.notEqual(
    exitCodeForVerification({ status: "skipped" }),
    exitCodeForVerification({ status: "verified" }),
  );
});

test("CLI formats guard metrics and shows disabled guards explicitly", () => {
  assert.equal(
    formatGuardMetrics({
      status: "verified",
      metrics: {
        verified: 1,
        skipped: 0,
        revised: 1,
        unverified: 0,
        guard_error: 0,
      },
    }),
    "guard={verified:1,skipped:0,revised:1,unverified:0,guard_error:0}",
  );
  assert.equal(
    formatGuardMetrics({ status: "skipped", reason: "no_final_guard" }),
    "guard=off",
  );
  // issue #391 R3：声明了交付物判据时（引擎才写这两个计数）多渲染两个键。
  assert.equal(
    formatGuardMetrics({
      status: "unverified",
      reason: "deliverables_failed",
      metrics: {
        verified: 0,
        skipped: 0,
        revised: 0,
        unverified: 1,
        guard_error: 0,
        deliverables_checked: 1,
        deliverables_failed: 1,
      },
    }),
    "guard={verified:0,skipped:0,revised:0,unverified:1,guard_error:0,deliverables_checked:1,deliverables_failed:1}",
  );
  // 未声明判据时那一行**逐字不变**（既有五个键、同序、无多余尾巴）——上面第一条就是这一格的锁。
  assert.equal(
    formatGuardMetrics({
      status: "verified",
      metrics: { verified: 1, skipped: 0, revised: 0, unverified: 0, guard_error: 0 },
    }),
    "guard={verified:1,skipped:0,revised:0,unverified:0,guard_error:0}",
  );
});

test("archive guidance is present once in the system prompt", async () => {
  const dir = await makeTmp("erix-cli-archive-guidance-test-");
  try {
    const provider = createFakeProvider([{ content: [{ type: "text", text: "done" }] }]);
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "answer",
      session: "archive-guidance-run",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    const system = provider.requests[0].system?.content ?? provider.requests[0].system;
    // ADR-015 4a：归档提示单次出现、零路径、不提 ResourceStore/opaque 工件
    assert.equal((system.match(/\[工具输出归档\]/u) ?? []).length, 1);
    assert.match(system, /大输出已由引擎全量归档/u);
    assert.match(system, /先用 note_list 查找记录，再用 note_read 读取/u);
    assert.doesNotMatch(system, new RegExp(`${dir}/outputs/archive-guidance-run`));
    assert.doesNotMatch(system, /ResourceStore|opaque 工件|明确的归档文件|归档目录：/u);
    assert.doesNotMatch(system, /幂等/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat does not add a value-note index to the system prompt", async () => {
  const dir = await makeTmp("erix-cli-value-index-test-");
  const notesDir = join(dir, "notes");
  const configPath = await writeEmptyMcpConfig(dir);
  try {
    await notes.note_take({
      key: "captured-nonce",
      content: "secret-value-must-not-leak",
      tags: ["value", "auto"],
      __erix: { runId: "value-index-run", notesDir },
    });
    const provider = createFakeProvider([{ content: [{ type: "text", text: "done" }] }]);
    await runChat({
      prompt: "answer",
      session: "value-index-run",
      dir: join(dir, "transcripts"),
      notesDir,
      skillsDir: join(dir, "skills"),
      configPath,
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      // maxRounds: 2 —— maxRounds:1 时本轮即最后一轮，按预算兜底规则不带 tools（C3）
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    const system = provider.requests[0].system?.content ?? provider.requests[0].system;
    assert.doesNotMatch(system, /\[notes value index\]/u);
    assert.doesNotMatch(system, /secret-value-must-not-leak/u);
    assert.deepEqual(
      provider.requests[0].tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("note_")),
      ["note_take", "note_read", "note_list", "note_forget"],
    );

    const emptyProvider = createFakeProvider([{ content: [{ type: "text", text: "done" }] }]);
    await runChat({
      prompt: "answer",
      session: "empty-value-index-run",
      dir: join(dir, "empty-transcripts"),
      notesDir: join(dir, "empty-notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: emptyProvider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    const emptySystem = emptyProvider.requests[0].system?.content ?? emptyProvider.requests[0].system;
    assert.doesNotMatch(emptySystem, /\[notes value index\]/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat injects archive status at fold time instead of into loop context", async () => {
  const dir = await makeTmp("erix-cli-recovery-hint-test-");
  let captured;
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "capture compaction context",
      session: "chat-recovery",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      compactBudget: 100,
      provider: createFakeProvider([]),
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
      toolOutput: () => {},
    });

    assert.ok(captured);
    // issue #498 S5：折叠回调归 `capabilities.hooks`（函数），数据侧 `config.folding.context` 只装数据——
    // 「两侧各归各位」在这里两侧都断言：函数在能力面，数据侧的同名键**不存在**。
    assert.equal(typeof canonicalLoopOption(captured, "capabilities.hooks.recoveryHint"), "function");
    assert.equal(typeof captured.capabilities.hooks.stubFor, "function");
    assert.equal(
      captured.config.folding.context?.recoveryHint,
      undefined,
      "函数值不得留在配置面（config 子树必须过 JSON round-trip）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("splitReflectionShell: 函数形态的 onReflection 落到 capabilities.hooks，扁平位不同时在场（#498 S7b 补格）", async () => {
  // #498 S5 的耐久缺口：`bin/cli.js` 的 `splitReflectionShell` 按**值的形态**拆 `reflection` 壳——
  // 函数值 ⇒ `capabilities.hooks.<name>`、数据 ⇒ `config.run.reflection`。当时只有一次性 /tmp 脚本
  // 证据，仓库里没有断言格。这里把它钉成真断言：读到的必须是**同一个函数引用**，且两侧不同时在场。
  // ⚠ 不是「没抛」——`canonicalLoopOption` 双向读（规位必须有值 / 扁平位必须不存在），
  // 再加值身份断言，映射改错（例如把 onReflection 漏出 hooks、或写回扁平位）必红。
  const dir = await makeTmp("erix-cli-reflection-shell-test-");
  let captured;
  const seen = [];
  const onReflection = (decision) => seen.push(decision);
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "capture reflection shell",
      session: "chat-reflection-shell",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      compactBudget: 100,
      // 宿主把回调放在 `reflection` 壳里（0.27 的写法），CLI 必须按形态拆开、不留第二真相来源。
      reflection: { enabled: true, onReflection },
      provider: createFakeProvider([]),
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
      toolOutput: () => {},
    });

    assert.ok(captured);
    assert.equal(
      canonicalLoopOption(captured, "capabilities.hooks.onReflection"),
      onReflection,
      "函数形态的 onReflection 必须原样出现在 capabilities.hooks.onReflection（同一个引用）",
    );
    // 数据侧不得留下同名函数（`config` 子树必须过 JSON round-trip ⇒ intake 会当场拒）。
    assert.equal(
      captured.config.run.reflection?.onReflection,
      undefined,
      "onReflection 不得留在配置面：config 子树必须过 JSON round-trip",
    );
    assert.equal(captured.config.run.reflection?.enabled, true, "其余数据照旧归 config.run.reflection");
    // 壳本身不许再以顶层扁平键出现（`reflection` 是 S3 要删的那类壳）。
    assert.equal(
      Object.hasOwn(captured, "reflection"),
      false,
      "reflection 壳不得留在顶层扁平位：同一个旋钮两个真相来源 ⇒ config_override_conflict",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseChatArgs parses --no-todo (issue #69)", () => {
  const options = parseChatArgs(["hello", "--no-todo"], "/tmp/project");
  assert.equal(options.noTodo, true);
  assert.equal(parseChatArgs(["hello"], "/tmp/project").noTodo, undefined);
  assert.throws(
    () => parseChatArgs(["hello", "--no-todo", "--no-todo"], "/tmp/project"),
    /参数重复/u,
  );
});

test("parseChatArgs accepts session and transcript directory overrides", () => {
  const options = parseChatArgs([
    "hello",
    "--session",
    "chat-run",
    "--dir",
    "/tmp/erix-transcripts",
  ], "/tmp/project");

  assert.deepEqual(options, {
    prompt: "hello",
    idleTimeout: 300,
    // issue #433 fix 1：新增的续跑预算旗标，缺省 900s（预算从第一次判死起算）
    idleRetryBudget: 900,
    session: "chat-run",
    dir: "/tmp/erix-transcripts",
  });
  assert.equal(
    parseChatArgs([], "/tmp/project").dir,
    join(homedir(), ".erix", "transcripts"),
  );
  assert.notEqual(
    parseChatArgs(["hello"], "/tmp/project").session,
    parseChatArgs(["hello"], "/tmp/project").session,
  );
});

test("parseChatArgs accepts the persistence error log override", () => {
  assert.equal(
    parseChatArgs(["hello", "--error-log", "/tmp/erix-error.log"]).errorLog,
    "/tmp/erix-error.log",
  );
});

test("parseChatArgs accepts the reflection switch", () => {
  assert.equal(parseChatArgs(["hello", "--reflection", "on"]).reflection, true);
  assert.equal(parseChatArgs(["hello", "--reflection", "off"]).reflection, false);
  assert.equal(parseChatArgs(["hello", "--timeout", "1500"]).timeoutMs, 1500);
});

test("parseChatArgs supports disabling only the notes skill", () => {
  assert.equal(parseChatArgs(["hello", "--no-notes"]).noNotes, true);
});

test("parseChatArgs accepts a tools allowlist", () => {
  const options = parseChatArgs(
    ["hello", "--tools", "readFile, tree"],
    "/tmp/project",
  );
  assert.equal(options.tools, "readFile, tree");
  assert.throws(
    () => parseChatArgs(["hello", "--tools"], "/tmp/project"),
    /缺少数值/,
  );
  assert.throws(
    () => parseChatArgs(["hello", "--tools", "  "], "/tmp/project"),
    /--tools 不能为空/,
  );
  assert.throws(
    () => parseChatArgs(
      ["hello", "--tools", "a", "--tools", "b"],
      "/tmp/project",
    ),
    /参数重复/,
  );
});

test("runChat filters tools via --tools allowlist and warns on unknown names", async () => {
  const dir = await makeTmp("erix-cli-tools-flag-");
  let captured;
  const warnings = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "hi",
      session: "tools-allowlist",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      tools: "readFile, tree, bogus_tool",
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
    });
  } finally {
    process.stderr.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  }

  assert.ok(captured);
  const names = canonicalLoopOption(captured, "config.input.tools").map((tool) => tool.name);
  assert.ok(names.includes("readFile"));
  assert.ok(names.includes("tree"));
  assert.ok(!names.includes("exec"));
  assert.ok(!names.includes("bogus_tool"));
  // 未知名字 stderr 警告
  assert.ok(warnings.some((line) => line.includes("bogus_tool")));
});

test("runChat assembles note tools via the factory and --no-notes removes them", async () => {
  const dir = await makeTmp("erix-cli-no-notes-");
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    let captured;
    const captureLoop = async (options) => {
      captured = options;
      return {
        finalText: "done",
        messages: [],
        rounds: 1,
        truncated: false,
        usage: { input_tokens: 0, output_tokens: 0 },
        compactionStats: [],
      };
    };
    await runChat({
      prompt: "hi",
      session: "notes-on",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop,
    });
    const noteNamesOn = canonicalLoopOption(captured, "config.input.tools")
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("note_"));
    assert.deepEqual(noteNamesOn, ["note_take", "note_read", "note_list", "note_forget"]);
    assert.equal(typeof captured.semanticStateProvider, "function");
    const takeResult = await captured.executeTool({
      id: "t1",
      name: "note_take",
      input: { key: "greeting", content: "hello world", __erix: { runId: "forged" } },
      context: {},
    });
    // wrapExecuteTool(returnMetadata) 包裹后结果在 .data 里
    assert.equal(JSON.parse(takeResult.data).status, "found");

    captured = undefined;
    await runChat({
      prompt: "hi",
      session: "notes-off",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      noNotes: true,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop,
    });
    assert.equal(
      canonicalLoopOption(captured, "config.input.tools")
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("note_"))
        .length,
      0,
      "--no-notes 后不得再装配 note_* 工具",
    );
    assert.equal(captured.semanticStateProvider, undefined);

    captured = undefined;
    const saved = process.env.ERIX_NO_NOTES;
    process.env.ERIX_NO_NOTES = "1";
    try {
      await runChat({
        prompt: "hi",
        session: "notes-env-off",
        dir,
        notesDir: join(dir, "notes"),
        skillsDir: join(dir, "skills"),
        configPath,
        provider: createFakeProvider([]),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        maxRounds: 2,
        idleTimeout: 0,
        toolOutput: () => {},
        loop: captureLoop,
      });
    } finally {
      if (saved === undefined) delete process.env.ERIX_NO_NOTES;
      else process.env.ERIX_NO_NOTES = saved;
    }
    assert.equal(
      canonicalLoopOption(captured, "config.input.tools")
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("note_"))
        .length,
      0,
      "ERIX_NO_NOTES=1 后不得再装配 note_* 工具",
    );
    assert.equal(captured.semanticStateProvider, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat --tools allowlist also applies to factory note tools", async () => {
  const dir = await makeTmp("erix-cli-notes-allowlist-");
  let captured;
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "hi",
      session: "notes-allowlist",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      tools: "note_take, exec",
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
    });
    assert.deepEqual(canonicalLoopOption(captured, "config.input.tools").map((tool) => tool.name).sort(), ["exec", "note_take"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat rejects a --tools allowlist that filters out every tool", async () => {
  const dir = await makeTmp("erix-cli-tools-empty-");
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    await assert.rejects(
      runChat({
        prompt: "hi",
        session: "tools-empty",
        dir,
        notesDir: join(dir, "notes"),
        skillsDir: join(dir, "skills"),
        configPath,
        provider: createFakeProvider([]),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        maxRounds: 2,
        idleTimeout: 0,
        toolOutput: () => {},
        tools: "only_bogus_tool",
        loop: async () => {
          throw new Error("loop must not run when allowlist is empty");
        },
      }),
      /--tools 过滤后没有可用工具/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat loop wires a file transcript store without an engine-owned retrieval tool", async () => {
  const dir = await makeTmp("erix-cli-test-");
  try {
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }] },
    ]);
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "remember this",
      session: "chat-wiring",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      // maxRounds: 2 —— maxRounds:1 时本轮即最后一轮，按预算兜底规则不带 tools（C3）
      maxRounds: 2,
    });

    const system = provider.requests[0].system?.content ?? provider.requests[0].system;
    assert.match(system, /大输出已由引擎全量归档/u);
    assert.doesNotMatch(system, /ResourceStore/u);
    assert.doesNotMatch(system, new RegExp(`${dir}/outputs/chat-wiring`));
    assert.doesNotMatch(system, /幂等/u);
    const records = await createFileTranscriptStore({ dir }).load("chat-wiring");
    assert.deepEqual(records.map((record) => record.round), [0, 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChat closes MCP connections when used as a module", async () => {
  const dir = await makeTmp("erix-cli-mcp-cleanup-test-");
  const mcpConfigPath = join(dir, "mcp.json");
  try {
    await writeFile(mcpConfigPath, JSON.stringify({
      mcpServers: {
        mock: {
          command: "node",
          args: [join(process.cwd(), "fixtures/mock-mcp-server.mjs")],
        },
      },
    }), "utf8");
    const provider = createFakeProvider([
      {
        content: [{
          type: "tool_use",
          id: "mcp-list",
          name: "mcp",
          input: { action: "list" },
        }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    await runChat({
      prompt: "use mcp",
      configPath: mcpConfigPath,
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
    });
    assert.deepEqual(getMcpPoolStatus(), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file transcript preserves folded payload", async () => {
  const dir = await makeTmp("erix-cli-fold-test-");
  try {
    const store = createFileTranscriptStore({ dir });
    const provider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "finished" }] },
    ]);
    const strategy = {
      shouldCompact: () => true,
      async compact(messages, options) {
        return createFoldStatisticalStrategy().compact(messages, {
          ...options,
          keepRounds: 0,
        });
      },
    };

    await runToolLoop({
      provider,
      initialUserMessage: "fold-me initial context",
      executeTool: async () => "fold-me tool result",
      maxRounds: 2,
      completion: false,
      context: { strategy, budgetTokens: 30 },
      store,
      runId: "fold-file",
    });

    const records = await store.load("fold-file");
    assert.ok(records.some((record) => Array.isArray(record.foldedPayload)));
    assert.match(JSON.stringify(records), /fold-me/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat --session <不存在的 id> 报错退出而不是静默开新会话（issue #168 M1）", async () => {
  const dir = await makeTmp("erix-cli-missing-session-test-");
  try {
    const config = { model: "fake-model", maxOutputTokens: 1000 };
    const configPath = await writeEmptyMcpConfig(dir);
    const provider = createFakeProvider([{ content: [{ type: "text", text: "should not run" }] }]);
    await assert.rejects(
      () => runChat({
        prompt: "resume-me",
        session: "typoed-session-id",
        // 只有 CLI 真实传入 `--session` 时才是「用户显式要求续跑」；
        // 不带该旗标时给 session 命名一个新会话仍是正常用法。
        sessionExplicit: true,
        dir,
        notesDir: join(dir, "notes"),
        skillsDir: join(dir, "skills"),
        configPath,
        provider,
        config,
        maxRounds: 1,
        idleTimeout: 0,
      }),
      /会话不存在：typoed-session-id/,
    );
    // 不跑 provider，也不落新 transcript
    assert.equal(provider.requests.length, 0);
    const transcripts = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    assert.deepEqual(transcripts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat 用 --session 命名新会话时（未声明 sessionExplicit）仍照旧新建", async () => {
  // M1 的报错门只给「显式 --session」；宿主/测试给 session 而不带旗标时不得变红。
  const dir = await makeTmp("erix-cli-named-session-test-");
  try {
    const config = { model: "fake-model", maxOutputTokens: 1000 };
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "name-a-fresh-run",
      session: "fresh-named-run",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([{ content: [{ type: "text", text: "ok" }] }]),
      config,
      maxRounds: 1,
      idleTimeout: 0,
    });
    assert.ok(existsSync(join(dir, "fresh-named-run.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat creates distinct default sessions and preserves the second prompt", async () => {
  const dir = await makeTmp("erix-cli-default-session-test-");
  try {
    const config = { model: "fake-model", maxOutputTokens: 1000 };
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "first-prompt",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([{ content: [{ type: "text", text: "first" }] }]),
      config,
      maxRounds: 1,
      idleTimeout: 0,
    });
    await runChat({
      prompt: "second-prompt",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([{ content: [{ type: "text", text: "second" }] }]),
      config,
      maxRounds: 1,
      idleTimeout: 0,
    });

    const runIds = (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
    assert.equal(runIds.length, 2);
    const store = createFileTranscriptStore({ dir });
    const records = await Promise.all(runIds.map((runId) => store.load(runId)));
    assert.deepEqual(records.map((run) => run.map((record) => record.round)), [[0, 1], [0, 1]]);

    const secondRun = records.find((run) => run.some((record) => (
      JSON.stringify(record).includes("second-prompt")
    )));
    assert.ok(secondRun);
    assert.match(JSON.stringify(secondRun), /second-prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat reuses an explicitly selected session and keeps the new prompt", async () => {
  const dir = await makeTmp("erix-cli-explicit-session-test-");
  try {
    const config = { model: "fake-model", maxOutputTokens: 1000 };
    const configPath = await writeEmptyMcpConfig(dir);
    await runChat({
      prompt: "explicit-first",
      session: "explicit-run",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([{ content: [{ type: "text", text: "first" }] }]),
      config,
      maxRounds: 1,
      idleTimeout: 0,
    });
    const secondProvider = createFakeProvider([
      { content: [{ type: "text", text: "second" }] },
    ]);
    await runChat({
      prompt: "explicit-second",
      session: "explicit-run",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: secondProvider,
      config,
      maxRounds: 2,
      idleTimeout: 0,
    });

    assert.ok(secondProvider.requests[0].messages.some((message) => (
      message.role === "user"
      && message.content?.some((block) => block.text === "explicit-second")
    )));
    assert.deepEqual(
      (await createFileTranscriptStore({ dir }).load("explicit-run"))
        .map((record) => record.round),
      // issue #404：中间多出的那条 round 1 是恢复告示（`…:control:resume-notice:<fp>`）——
      // 宿主看到行数多于轮数，这是 `:control:` 行的既有口径，不是多出来的一轮。
      [0, 1, 1, 1, 2],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat resume 路径预写 :input: 记录且复用最大 round（issue #97 写侧契约 CLI 端）", async () => {
  // 参照 test/repl.test.js 两轮集成断言：第二轮走 resume，预写行由
  // appendUserTurn 落入 transcript：存在 <key>:input: 记录，round 序列
  // [0, 1, 1, 2]——预写行复用既有最大 round（1），引擎自身行落在下一个 round（2）。
  const dir = await makeTmp("erix-cli-resume-prewrite-test-");
  try {
    const config = { model: "fake-model", maxOutputTokens: 1000 };
    const configPath = await writeEmptyMcpConfig(dir);
    const firstRun = {
      prompt: "resume-first",
      session: "resume-prewrite",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      config,
      maxRounds: 1,
      idleTimeout: 0,
    };
    await runChat({
      ...firstRun,
      provider: createFakeProvider([{ content: [{ type: "text", text: "first" }] }]),
    });
    const secondProvider = createFakeProvider([
      { content: [{ type: "text", text: "second" }] },
    ]);
    await runChat({
      ...firstRun,
      prompt: "resume-second",
      provider: secondProvider,
      maxRounds: 2,
    });

    // resume 成功重建上下文：新 prompt 经预写行达到模型
    assert.ok(secondProvider.requests[0].messages.some((message) => (
      message.role === "user"
      && message.content?.some((block) => block.text === "resume-second")
    )));

    const records = await createFileTranscriptStore({ dir }).load("resume-prewrite");
    // 预写行存在且命名空间正确，内容为新一轮 user 消息
    const prewritten = records.filter((record) => (
      typeof record.dedupKey === "string" && record.dedupKey.startsWith("resume-prewrite:input:")
    ));
    assert.equal(prewritten.length, 1);
    assert.deepEqual(prewritten[0].messages, [
      { role: "user", content: [{ type: "text", text: "resume-second" }] },
    ]);
    assert.equal(prewritten[0].roundKey, prewritten[0].dedupKey);
    // 预写复用最大 round：[0, 1]（首轮）+ [1（预写复用）, 2（引擎续轮）]
    // issue #404：另有一条 round 1 的恢复告示行（`…:control:resume-notice:<fp>`）。
    assert.deepEqual(records.map((record) => record.round), [0, 1, 1, 1, 2]);
    assert.equal(prewritten[0].round, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat continues after text-only rounds (maxNoToolRounds default 3)", async () => {
  const dir = await makeTmp("erix-cli-notool-test-");
  try {
    // 模型先用工具干活（exec 是 CLI 真实工具），然后输出文本（无工具调用）——
    // 之前 maxNoToolRounds=1 会立即判定完成；默认 3 应追加"请继续"并保持循环。
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "act1", name: "exec", input: { command: "echo hi" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "已处理，接下来总结" }], stopReason: "end_turn" },
      { content: [{ type: "tool_use", id: "act2", name: "exec", input: { command: "echo done" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
    ]);

    await runChat({
      prompt: "continue-after-text",
      session: "notool-continue",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 4,
      idleTimeout: 0,
      toolOutput: () => {}, // 静默工具日志，避免污染 node --test 的 IPC
    });

    // 至少 3 次请求：工具轮 → 文本轮 → 追问后继续工具轮
    assert.ok(provider.requests.length >= 3);
    // 某个请求里应包含"请继续"追问（maxNoToolRounds>1 时文本轮后追加）
    assert.ok(provider.requests.some((request) => (
      request.messages.some((message) => (
        message.role === "user"
        && message.content?.some((block) => block.text === "（请继续完成任务）")
      ))
    )));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("judge log defaults into the run archive directory", async () => {
  const dir = await makeTmp("erix-judgelog-default-");
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const judge = createFakeProvider([
      { content: [{ type: "text", text: JSON.stringify({ done: true, confidence: 0.9, reason: "ok", evidence: "done", direction: "on_track" }) }], stopReason: "end_turn" },
    ]);
    await runChat({
      prompt: "finish",
      session: "judgelog-default",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
      reflection: {
        enabled: true,
        roundJudge: true,
        judge: { provider: judge },
      },
    });

    const defaultLog = join(dir, "outputs", "judgelog-default", "judge.log");
    const content = readFileSync(defaultLog, "utf8");
    assert.ok(content.includes('"round"'), "默认 judge.log 应存在且含 round 记录");
    // issue #165（additive）：默认路径同样带关联字段与终局汇总（与注入路径同形状）。
    const records = readJudgeLog(defaultLog);
    const decisions = records.filter((record) => record.kind !== undefined);
    assert.ok(decisions.length > 0, "应有 judge 决策记录");
    for (const record of decisions) {
      assert.equal(record.runId, "judgelog-default");
      assert.equal(record.model, "fake-model");
    }
    assert.deepEqual(records.at(-1).type, "run_outcome", "末条必为 run 级 outcome 汇总");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── issue #165：judge.log 记录形状（模型标识 + run 级 outcome 关联）───────────────────

function readJudgeLog(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const judgeDoneResponse = () => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      done: true,
      confidence: 0.9,
      reason: "ok",
      evidence: "done",
      direction: "on_track",
    }),
  }],
  stopReason: "end_turn",
});

// 同一套脚本与配置跑一次 run（注入 judgeLog 与走默认归档路径只差一个参数），
// 用于比较两条路径落盘的记录形状。
async function runJudgeChat({ dir, session, judgeLog, provider, judge, config }) {
  await runChat({
    prompt: "finish",
    session,
    dir,
    notesDir: join(dir, `notes-${session}`),
    skillsDir: join(dir, "skills"),
    configPath: await writeEmptyMcpConfig(dir),
    provider,
    config,
    maxRounds: 1,
    idleTimeout: 0,
    toolOutput: () => {},
    ...(judgeLog === undefined ? {} : { judgeLog }),
    reflection: { enabled: true, roundJudge: true, judge: { provider: judge } },
  });
}

test("judge.log carries runId + model per decision and a run-level outcome record (#165)", async () => {
  const dir = await makeTmp("erix-judgelog-shape-");
  const judgeLogPath = join(dir, "judge.log");
  try {
    await runJudgeChat({
      dir,
      session: "judgelog-shape",
      judgeLog: judgeLogPath,
      provider: createFakeProvider([
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      ]),
      judge: createFakeProvider([judgeDoneResponse()]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
    });

    const records = readJudgeLog(judgeLogPath);
    const decisions = records.filter((record) => record.kind !== undefined);
    const outcomes = records.filter((record) => record.type === "run_outcome");

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].kind, "round");
    assert.equal(decisions[0].action, "judge_done", "旧字段照旧（additive）");
    assert.equal(decisions[0].runId, "judgelog-shape");
    assert.equal(decisions[0].model, "fake-model");
    assert.ok(!("judgeModel" in decisions[0]), "judge 与 run 同模型时不写冗余字段");

    // outcome 汇总：一次 run 恰好一条，且是末条（append-only，不回头改写）。
    assert.equal(outcomes.length, 1);
    assert.equal(records.at(-1), outcomes[0]);
    assert.equal(outcomes[0].runId, "judgelog-shape");
    assert.equal(outcomes[0].model, "fake-model");
    assert.equal(outcomes[0].termination.reason, "judge_done");
    assert.ok(outcomes[0].verification.status, "终局 verification.status 必在");
    assert.equal(outcomes[0].judgeRecordCount, decisions.length);
    assert.equal(outcomes[0].rounds, 1);
    // 两类记录同构的 ts 前缀（同一个写入器）。
    for (const record of records) {
      assert.ok(Number.isFinite(Date.parse(record.ts)), `每条记录带 ts：${JSON.stringify(record)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("injected --judge-log path and default archive path write identical record shapes (#165)", async () => {
  const dir = await makeTmp("erix-judgelog-parity-");
  const injectedPath = join(dir, "injected-judge.log");
  try {
    await runJudgeChat({
      dir,
      session: "judgelog-injected",
      judgeLog: injectedPath,
      provider: createFakeProvider([
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      ]),
      judge: createFakeProvider([judgeDoneResponse()]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
    });
    await runJudgeChat({
      dir,
      session: "judgelog-default-path",
      provider: createFakeProvider([
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      ]),
      judge: createFakeProvider([judgeDoneResponse()]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
    });

    const injected = readJudgeLog(injectedPath);
    const fallback = readJudgeLog(join(dir, "outputs", "judgelog-default-path", "judge.log"));
    assert.ok(injected.length > 1 && fallback.length > 1);
    // 键集合逐条一致（同一个写入器，不存在“走默认路径才多字段”的分叉）。
    assert.deepEqual(
      injected.map((record) => Object.keys(record).sort()),
      fallback.map((record) => Object.keys(record).sort()),
    );
    // 除 ts 与 run 标识外，outcome 汇总逐字段相同。
    const strip = (record) => {
      const { ts, runId, ...rest } = record;
      return rest;
    };
    assert.deepEqual(
      strip(injected.find((record) => record.type === "run_outcome")),
      strip(fallback.find((record) => record.type === "run_outcome")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("judge.log omits the model field instead of writing a placeholder (#165)", async () => {
  const dir = await makeTmp("erix-judgelog-nomodel-");
  const judgeLogPath = join(dir, "judge.log");
  try {
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    delete provider.model;
    const judge = createFakeProvider([judgeDoneResponse()]);
    delete judge.model;

    await runJudgeChat({
      dir,
      session: "judgelog-nomodel",
      judgeLog: judgeLogPath,
      provider,
      judge,
      // 宿主没给模型名：既不写 provider 探不到的值，也不写 "unknown" 之类的假值。
      config: { maxOutputTokens: 1000 },
    });

    const records = readJudgeLog(judgeLogPath);
    assert.ok(records.length > 1);
    for (const record of records) {
      assert.ok(!("model" in record), `不该写假模型名：${JSON.stringify(record)}`);
      assert.ok(!("judgeModel" in record));
      assert.equal(record.runId, "judgelog-nomodel", "runId 照旧在");
    }
    assert.ok(records.some((record) => record.kind !== undefined));
    assert.ok(records.some((record) => record.type === "run_outcome"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("judge-log persists raw tool input and judge reason verbatim (redaction retired, #55)", async () => {
  const dir = await makeTmp("erix-judgelog-");
  const judgeLogPath = join(dir, "judge.log");
  try {
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "curl -H 'Authorization: Bearer sk-abcdef1234567890' http://x" } }], stopReason: "tool_use" },
      // 被拦截后模型转向：发安全命令
      { content: [{ type: "tool_use", id: "t2", name: "exec", input: { command: "ls" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    // judge: intercept 审计该 exec（含密钥命令），reason 复述凭据；judgeIntervalRound=1 每次工具都审计
    const judge = createFakeProvider([
      { content: [{ type: "text", text: JSON.stringify({ done: false, confidence: 0.9, reason: "命令含 Authorization: Bearer sk-abcdef1234567890 需检查", evidence: "输入含凭据", direction: "uncertain" }) }], stopReason: "end_turn" },
      { content: [{ type: "text", text: JSON.stringify({ done: true, confidence: 0.9, reason: "ok", evidence: "安全", direction: "on_track" }) }], stopReason: "end_turn" },
    ]);
    await runChat({
      prompt: "run command",
      session: "judgelog-redact",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 3,
      idleTimeout: 0,
      judgeLog: judgeLogPath,
      toolOutput: () => {},
      reflection: {
        enabled: true,
        roundJudge: false,
        judgeIntervalRound: 1,
        judge: { provider: judge },
      },
    });

    const content = readFileSync(judgeLogPath, "utf8");
    assert.ok(content.length > 0, "judge.log 应生成");
    // 脱敏退役（#55）：judge.log 与 run 全量档案同目录同信任域，原始字段原样落盘
    assert.ok(content.includes("sk-abcdef1234567890"), "工具输入中的密钥应原样落盘");
    assert.ok(content.includes("Bearer sk-abcdef1234567890"), "reason 复述的凭据应原样落盘");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseChatArgs accepts --compaction with the built-in strategy names (#167)", () => {
  assert.equal(
    parseChatArgs(["hello", "--compaction", "fold-llm"], "/tmp/project").compaction,
    "fold-llm",
  );
  assert.equal(
    parseChatArgs(["hello", "--compaction", " sliding-window "], "/tmp/project").compaction,
    "sliding-window",
  );
  assert.equal(parseChatArgs(["hello"], "/tmp/project").compaction, undefined);
});

test("parseChatArgs rejects unknown or missing --compaction values (#167)", () => {
  assert.throws(
    () => parseChatArgs(["hello", "--compaction", "psyche"], "/tmp/project"),
    /--compaction[\s\S]*sliding-window \| fold-statistical \| fold-llm/u,
  );
  assert.throws(() => parseChatArgs(["hello", "--compaction", ""], "/tmp/project"), /不能为空/u);
  assert.throws(() => parseChatArgs(["hello", "--compaction"], "/tmp/project"), /缺少数值/u);
  assert.throws(
    () => parseChatArgs(["hello", "--compaction", "--stream"], "/tmp/project"),
    /缺少数值/u,
  );
  assert.throws(
    () => parseChatArgs(
      ["hello", "--compaction", "fold-llm", "--compaction", "fold-llm"],
      "/tmp/project",
    ),
    /参数重复/u,
  );
});

test("runChat keeps the default compaction strategy and forwards an explicit name (#167)", async () => {
  const dir = await makeTmp("erix-cli-compaction-test-");
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    const captureLoop = async (options) => {
      return {
        finalText: "done",
        messages: [],
        rounds: 1,
        truncated: false,
        usage: { input_tokens: 0, output_tokens: 0 },
        compactionStats: [],
        _context: options.config?.folding?.context,
      };
    };
    const shared = {
      prompt: "compaction strategy wiring",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      config: { model: "fake-model", maxOutputTokens: 1000, contextWindowTokens: 20000 },
      provider: createFakeProvider([]),
      loop: captureLoop,
      toolOutput: () => {},
      idleTimeout: 0,
    };

    const defaulted = await runChat({ ...shared, session: "compaction-default" });
    assert.equal(defaulted._context.strategy, "fold-statistical");

    const named = await runChat({
      ...shared,
      session: "compaction-named",
      compaction: "fold-llm",
    });
    assert.equal(named._context.strategy, "fold-llm");

    const fromConfig = await runChat({
      ...shared,
      session: "compaction-config",
      config: {
        model: "fake-model",
        maxOutputTokens: 1000,
        contextWindowTokens: 20000,
        compaction: "sliding-window",
      },
    });
    assert.equal(fromConfig._context.strategy, "sliding-window");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// issue #326（wo-D）：`-c/--session` 续跑一份**含引擎事实行**的账本。
// CLI 侧的判据只有两处（`bin/cli.js` 的 `store.load(runId)` 长度：M1「会话不存在」与 `resume`），
// 本单**刻意不改**它：只有事实行的账本也是真会话（引擎 resume 靠这些事实行重建折叠/TTL 状态），
// 说「会话不存在」是假报错。这里钉住三件事：不崩、事实行不被改写或复制、用户轮仍照常入账。
// ---------------------------------------------------------------------------

async function resumeWithFactRows({ tag, rows, session }) {
  const dir = await makeTmp(`erix-cli-${tag}-`);
  const { writeTranscript } = await import("./helpers/engine-fact-rows.js");
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    await writeTranscript(join(dir, `${session}.jsonl`), rows);
    const notesDir = join(dir, "notes");
    const store = createFileTranscriptStore({ dir });
    const provider = createFakeProvider([{ content: [{ type: "text", text: "续跑结论" }], stopReason: "end_turn" }]);
    const result = await runChat({
      prompt: "续跑的新问题",
      session,
      sessionExplicit: true,
      dir,
      notesDir,
      skillsDir: join(dir, "skills"),
      configPath,
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 1,
      idleTimeout: 0,
      toolOutput: () => {},
      _assemblyRoot: {
        archiveDir: join(dir, "outputs", session),
        diagnostics: { error() {} },
        notesDir,
        notesStore: createFileNotesStore({ dir: notesDir }),
        store,
      },
    });
    return { result, provider, records: await store.load(session) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("#326-D 续跑含三类事实行的账本：不崩、事实行原样保留、新用户轮恰有一条", async () => {
  const { mixedFactRows } = await import("./helpers/engine-fact-rows.js");
  const session = "wo-d-cli-resume";
  const ledger = mixedFactRows(session);
  const { result, provider, records } = await resumeWithFactRows({ tag: "wo-d-resume", rows: ledger, session });

  assert.equal(result.finalText, "续跑结论");
  assert.ok(provider.requests.length >= 1, "续跑必须真的打到模型");
  const texts = (index) => (provider.requests[index]?.messages ?? []).flatMap((message) => (
    (Array.isArray(message?.content) ? message.content : []).map((block) => String(block?.text ?? ""))
  )).join("\n");
  assert.match(texts(0), /把三类事实行写进账本/u, "既有正文必须在模型上下文里");
  assert.match(texts(0), /续跑的新问题/u, "新一轮的用户问题必须在模型上下文里");

  // 事实行一条不少、一条不多：CLI 不重写、不复制别人的行
  // 原账本里每条事实行都还在、且只有一条（续跑自己新产生的事实行允许追加）
  for (const row of factRowsOf(ledger)) {
    assert.equal(
      factRowsOf(records).filter((entry) => entry.dedupKey === row.dedupKey).length,
      1,
      `事实行 ${row.dedupKey} 必须原样在位一条`,
    );
  }
  const foldKept = records.find((entry) => String(entry.dedupKey).includes(":fold:"));
  assert.deepEqual(foldKept.foldedSummary, ledger.find((entry) => entry.foldedSummary).foldedSummary);
  const ttlKept = records.find((entry) => String(entry.dedupKey).includes(":ttl:"));
  assert.deepEqual(ttlKept.ttlDegradations, ledger.find((entry) => entry.ttlDegradations).ttlDegradations);
  // 新写入的用户轮（宿主 `:input:` 命名空间）恰有一条，且不与引擎命名空间碰撞
  const inputRows = records.filter((entry) => String(entry.dedupKey ?? "").includes(":input:"));
  assert.equal(inputRows.length, 1, `实测 ${JSON.stringify(records.map((entry) => entry.dedupKey ?? entry.roundKey))}`);
  assert.match(JSON.stringify(inputRows[0].messages), /续跑的新问题/u);
});

test("#326-D 只有事实行的账本仍算「会话存在」：M1 不误报，用户轮照常接上", async () => {
  const { controlRow, foldRow, ttlRow } = await import("./helpers/engine-fact-rows.js");
  const session = "wo-d-cli-only-facts";
  const { result, provider, records } = await resumeWithFactRows({
    tag: "wo-d-onlyfacts",
    session,
    rows: [foldRow(session, 2), ttlRow(session, 2), controlRow(session, 2, "extend")],
  });

  assert.equal(result.finalText, "续跑结论");
  assert.match((provider.requests[0]?.messages ?? []).flatMap((message) => (
    (Array.isArray(message?.content) ? message.content : []).map((block) => String(block?.text ?? ""))
  )).join("\n"), /续跑的新问题/u);
  assert.equal(records.filter((entry) => String(entry.dedupKey ?? "").includes(":input:")).length, 1);
  // issue #404：恢复告示本身也是一条 `:control:` 事实行 ⇒ 4 条；其中「告示恰一条」单独点名，
  // 不靠总数蒙（总数多了是复制、少了是吞掉）。
  assert.equal(
    factRowsOf(records).filter((entry) => String(entry.dedupKey ?? "").includes(":control:resume-notice")).length,
    1,
    "恢复告示必须恰有一条 `…:control:resume-notice:<fp>` 行",
  );
  assert.equal(factRowsOf(records).length, 4, "事实行既没被吞掉也没被复制");
});

// 事实行的独立口径（不依赖被测实现）：引擎命名空间里带槽位后缀的那几类
// （`:fold:<fp>` / `:ttl:<fp>` / `:control:<slot>`）；引擎自己的轮记录 `<runId>:engine:round:<n>`
// 没有槽位后缀，不算事实行。
function isFactLedgerRow(record) {
  return /:engine:round:\d+:(?:fold|ttl|control):/u.test(String(record?.dedupKey ?? ""));
}

function factRowsOf(records) {
  return records.filter(isFactLedgerRow);
}

test("#326-D 账本里有 messages 缺失/为 null 的老行时续跑也不崩", async () => {
  const { roundRow, userMessage } = await import("./helpers/engine-fact-rows.js");
  const session = "wo-d-cli-legacy";
  const rows = [
    { round: 1, roundKey: `${session}:round:1` }, // 老行：完全没有 messages 字段
    { round: 2, roundKey: `${session}:round:2`, messages: null },
    roundRow(session, 3, [userMessage("老账本里的真实用户轮")]),
  ];
  const { result, records } = await resumeWithFactRows({ tag: "wo-d-legacy", rows, session });
  assert.equal(result.finalText, "续跑结论");
  // 三行老账本原样在位（`messages` 缺失/为 null 的行没被洗掉或复制）
  assert.deepEqual(
    records.slice(0, rows.length).map((entry) => entry.roundKey ?? entry.dedupKey),
    rows.map((entry) => entry.roundKey ?? entry.dedupKey),
  );
  assert.ok(records.length > rows.length, "续跑至少要留下用户轮与引擎轮记录");
});

// issue #386 切片 2：CLI 侧**默认关闭**的交付物判据（`--require-deliverable`）。
// issue #391 R2：它必须与 `--final-guard` 同用——单独给是 usage error（不是静默空转）。
test("parseChatArgs parses --require-deliverable, and it is off by default (issue #386 slice 2)", () => {
  assert.equal(parseChatArgs(["hello"], "/tmp/project").requireDeliverable, undefined,
    "默认必须关闭：开了它会改掉「成功 + 无 --final-guard ⇒ exit 4」的既有退出码承诺");
  // #391 R2：这一格从「单独给也能解析」改成「必须与 --final-guard 同用」——**不是放宽**：
  // 单独给的那一格现在由下面那条 assert.throws 钉着（闸门跑在 guard 之内，没有 guard 就没有闸门，
  // 旧行为是静默空转：用户以为在要求交付物，实际一个字都没核）。
  assert.equal(
    parseChatArgs(["hello", "--final-guard", "--require-deliverable"], "/tmp/project").requireDeliverable,
    true,
  );
  assert.throws(
    () => parseChatArgs(["hello", "--require-deliverable"], "/tmp/project"),
    /--require-deliverable 必须与 --final-guard 同用/u,
  );
  assert.throws(
    () => parseChatArgs(["hello", "--require-deliverable", "--require-deliverable"], "/tmp/project"),
    /参数重复/u,
  );
});

test("createDeliverableChecks 判的是原始写路径的磁盘事实（fileWrites，不是 40 码点摘要）", async () => {
  const { createDeliverableChecks } = await import("../bin/final-guard.js");
  const dir = await makeTmp("erix-cli-deliverable-");
  const written = `${dir}/nested/artifact-with-a-very-long-name.txt`;
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(written, "42");

  const [criterion] = createDeliverableChecks();
  assert.equal(criterion.name, "files_written_exist");
  // 全部在盘上 ⇒ 通过（返回 `true`，与契约里「true ⇒ ok:true」那一格一致）。
  assert.equal(criterion.check({ fileWrites: [{ path: written, round: 1, tool: "writeFile" }] }), true);
  // 一条不在盘上 ⇒ 失败并点名那条路径（`detail` 是宿主可见的，必须能直接定位）。
  const missing = `${dir}/never-written.txt`;
  const failed = criterion.check({
    fileWrites: [{ path: written, round: 1, tool: "writeFile" }, { path: missing, round: 2, tool: "writeFile" }],
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.detail.includes(missing), `detail 没点名缺失的路径：${failed.detail}`);
  // 没写过任何文件 ⇒ 通过（「这个 run 没声明写文件」不是「交付物缺失」）。
  assert.equal(criterion.check({}), true);
  assert.equal(criterion.check({ fileWrites: [] }), true);
});

// issue #391 R1：**命名**交付物判据（`--require-deliverable <path>` / `deliverablePaths`）。
// 与上面那条布尔判据是两个不同的问题：布尔那条在模型什么都不声明时空集合恒真（一次工具都没调也通过），
// 命名这条只读宿主声明的清单 ⇒ 模型啥都没写照样判不过。
test("createNamedDeliverableChecks：每条一个判据、name = 声明路径、相对路径按 facts.cwd 解析", async () => {
  const { createNamedDeliverableChecks, DELIVERABLES_LIMIT } = await import("../bin/final-guard.js");
  const { DELIVERABLES_LIMIT: ENGINE_LIMIT } = await import("../src/loop/deliverables.js");
  // 宿主侧前置挡用的上限必须是引擎那个数（不是自己发明的第二个数）
  assert.equal(DELIVERABLES_LIMIT, ENGINE_LIMIT);

  const dir = await makeTmp("erix-cli-named-deliverable-");
  const relative = "report.md";
  const absolute = `${dir}/nested/absolute.txt`;
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(join(dir, relative), "42");

  const criteria = createNamedDeliverableChecks([relative, absolute]);
  assert.deepEqual(criteria.map((entry) => entry.name), [relative, absolute], "判据名就是声明的路径本身");
  // 相对路径：按 facts.cwd 解析（引擎不 join，它把宿主传的 cwd 原样放进 payload）
  assert.equal(criteria[0].check({ cwd: dir }), true);
  const otherDir = await makeTmp("erix-cli-named-other-");
  const notThere = criteria[0].check({ cwd: otherDir });
  assert.equal(notThere.ok, false);
  assert.ok(notThere.detail.includes(join(otherDir, relative)), `detail 没点名解析后的绝对路径：${notThere.detail}`);
  // 没有 cwd ⇒ 相对路径 fail-closed（#391 的原始症状：宿主没接线就不许判通过）
  const noCwd = criteria[0].check({});
  assert.equal(noCwd.ok, false);
  assert.match(noCwd.detail, /没把 cwd 交给 runToolLoop/u);
  // 绝对路径不需要 cwd，且判的是磁盘事实（不是「文件被写过」的台账）
  await writeFile(absolute, "1");
  assert.equal(criteria[1].check({}), true);
  assert.equal(criteria[1].check({ cwd: dir }), true);
  // 空清单 ⇒ 空数组（不抛、也不伪造一条「恒真」判据；宿主侧负责把空清单挡在门外）
  assert.deepEqual(createNamedDeliverableChecks([]), []);
  assert.deepEqual(createNamedDeliverableChecks(undefined), []);
});

// issue #391 R2：`--require-deliverable <path>`（可重复）＝**命名**交付物判据。
// 裸用保持现语义（布尔判据），带值 = 「这次任务必须交付这些文件」——两种语义在 CLI 层也分开。
test("parseChatArgs：--require-deliverable 带值 = 命名路径（可重复，空格与 = 两种写法都收）", () => {
  const parse = (args) => parseChatArgs(["hello", "--final-guard", ...args], "/tmp/project");
  // 默认：既没有布尔开关，也没有命名清单
  const bare = parseChatArgs(["hello"], "/tmp/project");
  assert.equal(bare.requireDeliverable, undefined);
  assert.equal(bare.deliverablePaths, undefined);
  // 裸用 ⇒ 现语义（布尔那条），deliverablePaths 不出现
  const flagOnly = parse(["--require-deliverable"]);
  assert.equal(flagOnly.requireDeliverable, true);
  assert.equal(flagOnly.deliverablePaths, undefined);
  // 空格写法（本文件既有惯例）
  assert.deepEqual(parse(["--require-deliverable", "report.md"]).deliverablePaths, ["report.md"]);
  // `=` 写法（可重复的带值旗标用 = 更清楚）
  assert.deepEqual(parse(["--require-deliverable=report.md"]).deliverablePaths, ["report.md"]);
  // 可重复：两种写法混用也行，顺序即声明顺序
  const repeated = parse(["--require-deliverable=a.md", "--require-deliverable", "b.md"]);
  assert.deepEqual(repeated.deliverablePaths, ["a.md", "b.md"]);
  assert.equal(repeated.requireDeliverable, undefined, "带值不该顺手把布尔那条也打开");
  // 两种语义可以同时声明（条数相加，判据两条都跑）
  const both = parse(["--require-deliverable", "--require-deliverable", "a.md"]);
  assert.equal(both.requireDeliverable, true);
  assert.deepEqual(both.deliverablePaths, ["a.md"]);
});

test("parseChatArgs：--require-deliverable 的坏值逐格报 usage error（空值 / 重复 / 超限 / 缺 guard）", () => {
  const code = (args) => {
    try {
      parseChatArgs(["hello", "--final-guard", ...args], "/tmp/project");
      return "no-throw";
    } catch (error) {
      return error.message;
    }
  };
  assert.match(code(["--require-deliverable="]), /必须是路径/u);
  assert.match(code(["--require-deliverable=   "]), /必须是路径/u);
  assert.match(code(["--require-deliverable=a.md", "--require-deliverable=a.md"]), /路径重复/u);
  const tooMany = Array.from({ length: 21 }, (_, index) => `f${index}.md`);
  assert.match(code(tooMany.flatMap((name) => ["--require-deliverable", name])), /最多 20 条/u);
  // 合计上限：布尔那条也占一个槽位（20 条命名 + 裸用 = 21）
  const full = Array.from({ length: 20 }, (_, index) => `f${index}.md`);
  assert.match(
    code(["--require-deliverable", ...full.flatMap((name) => ["--require-deliverable", name])]),
    /合计最多 20 条/u,
  );
  // 命名路径同样必须与 --final-guard 同用（闸门在 guard 之内）
  assert.throws(
    () => parseChatArgs(["hello", "--require-deliverable", "report.md"], "/tmp/project"),
    /--require-deliverable 必须与 --final-guard 同用/u,
  );
  // 裸旗标重复仍然报重复（既有断言不动）
  assert.throws(
    () => parseChatArgs(["hello", "--final-guard", "--require-deliverable", "--require-deliverable"], "/tmp/project"),
    /参数重复/u,
  );
});

test("runChat：--require-deliverable <path> ⇒ 命名判据真的交给引擎，且默认路径一个键都不多", async () => {
  const dir = await makeTmp("erix-cli-named-wire-");
  let captured;
  const captureLoop = async (options) => {
    captured = options;
    return {
      finalText: "done",
      messages: [],
      rounds: 1,
      truncated: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      compactionStats: [],
    };
  };
  try {
    const configPath = await writeEmptyMcpConfig(dir);
    const base = {
      prompt: "hi",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath,
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      loop: captureLoop,
    };
    // ① 默认：没有 deliverables 键（引擎「未声明 ⇒ 逐字不变」的回归锚）
    await runChat({ ...base, session: "named-wire-0" });
    assert.equal("deliverables" in captured, false, "没声明判据时不许出现 deliverables 键");
    assert.equal(captured.capabilities.checks, undefined, "连 capabilities.checks 整组都不该出现");
    // ② 命名路径 ⇒ 一条判据，name = 声明的路径；判据拿到的 cwd 就是本次 run 的 cwd
    await runChat({ ...base, session: "named-wire-1", finalGuard: true, deliverablePaths: ["report.md"], cwd: dir });
    const named1 = canonicalLoopOption(captured, "capabilities.checks.deliverables");
    assert.deepEqual(named1.map((entry) => entry.name), ["report.md"]);
    assert.equal(typeof named1[0].check, "function");
    assert.equal(canonicalLoopOption(captured, "config.run.cwd"), dir, "cwd 必须原样交给引擎（判据靠它拼路径）");
    assert.equal(named1[0].check({ cwd: captured.config.run.cwd }).ok, false, "盘上没有 report.md ⇒ 判据必须 ok:false");
    // ③ 两种语义同时声明 ⇒ 两条判据（布尔那条在前，与扩展侧同一顺序）
    await runChat({
      ...base,
      session: "named-wire-2",
      finalGuard: true,
      requireDeliverable: true,
      deliverablePaths: ["a.md", "b.md"],
      cwd: dir,
    });
    assert.deepEqual(
      canonicalLoopOption(captured, "capabilities.checks.deliverables").map((entry) => entry.name),
      ["files_written_exist", "a.md", "b.md"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
