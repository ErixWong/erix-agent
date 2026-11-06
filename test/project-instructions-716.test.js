// issue #716：项目约定文件（AGENTS.md）发现 + 注入 + 留痕行。
//
// 覆盖面（判据逐条对应验收单）：
//   1. 发现函数：存在 / 缺失（不抛）/ 空文件 / 超限截断 / **只读 cwd 一层**（不上溯父目录）；
//   2. 共享装配器 `bin/system-prompt.js`：注入内容与既有段落共存、`--no-agents` 关闭时零注入，
//      chat 与 repl 走同一个函数 ⇒ 这里一次覆盖两条边；
//   3. stderr 留痕行两条分支（已注入 / 未发现），路径与字节数对得上；
//   4. `--no-agents` 旗标在 chat 与 repl 两侧都被认；
//   5. 装配级：`runChat` 真把内容拼进 `config.input.system`（不是只算了个返回值）。
//
// 红线：约定文件原文**不进断言**（里面可能有 token / 内网地址），一律用唯一哨兵字符串。
// 临时目录一律 `makeTmp()`（`scripts/test-hygiene-check.mjs` 规则 B）；`home` / `cwd` 全注入，
// 不触达真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseChatArgs, runChat } from "../bin/cli.js";
import { parseReplArgs } from "../bin/repl.js";
import {
  buildCliSystemPrompt,
  buildProjectInstructionsSection,
  formatProjectInstructionsNotice,
} from "../bin/system-prompt.js";
import { buildCliToolsSystemPrompt } from "../bin/tools.js";
import {
  discoverProjectInstructions,
  PROJECT_INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
} from "../src/project-instructions.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

/** 唯一哨兵：断言只看它，绝不把约定文件原文抄进用例。 */
const SENTINEL = "SENTINEL-716-DO-NOT-INJECT-VERBATIM";

function writeAgents(dir, content) {
  writeFileSync(join(dir, PROJECT_INSTRUCTIONS_FILENAME), content, "utf8");
  return join(dir, PROJECT_INSTRUCTIONS_FILENAME);
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

async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

// ---------------------------------------------------------------------------
// 1. 发现函数
// ---------------------------------------------------------------------------

test("#716 发现函数：<cwd>/AGENTS.md 存在时给出 path / bytes / content", async () => {
  const dir = await makeTmp("erix-716-found-");
  try {
    const body = `# 约定\n${SENTINEL}\n`;
    const path = writeAgents(dir, body);
    const discovery = discoverProjectInstructions({ cwd: dir });
    assert.equal(discovery.files.length, 1);
    assert.equal(discovery.files[0].path, path);
    assert.equal(discovery.files[0].content, body);
    assert.equal(discovery.files[0].bytes, Buffer.byteLength(body, "utf8"));
    assert.equal(discovery.files[0].truncated, false);
    assert.equal(discovery.totalBytes, Buffer.byteLength(body, "utf8"));
    assert.equal(discovery.truncated, false);
    assert.deepEqual(discovery.skipped, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 发现函数：文件不存在 ⇒ 空集合，且不抛（CLI 起不来是比「没注入」更坏的失败）", async () => {
  const dir = await makeTmp("erix-716-missing-");
  try {
    const discovery = discoverProjectInstructions({ cwd: dir });
    assert.deepEqual(discovery.files, []);
    assert.equal(discovery.totalBytes, 0);
    assert.equal(discovery.truncated, false);
    // 连 cwd 本身都不存在也走同一条路（ENOENT），不抛。
    const ghost = discoverProjectInstructions({ cwd: join(dir, "does-not-exist") });
    assert.deepEqual(ghost.files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 发现函数：可读但为空 ⇒ 计入 files、注入 0 字节", async () => {
  const dir = await makeTmp("erix-716-empty-");
  try {
    writeAgents(dir, "");
    const discovery = discoverProjectInstructions({ cwd: dir });
    assert.equal(discovery.files.length, 1, "空文件也是一次「发现」");
    assert.equal(discovery.files[0].bytes, 0);
    assert.equal(discovery.files[0].content, "");
    assert.equal(discovery.totalBytes, 0);
    assert.equal(discovery.truncated, false);
    // 空内容 ⇒ 提示词里一个字节都不多（不塞一句废话）。
    assert.equal(buildProjectInstructionsSection(discovery), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 发现函数：超上限 ⇒ 截断并报 truncated，且不劈开多字节字符", async () => {
  const dir = await makeTmp("erix-716-truncate-");
  try {
    // 每行 3 字节（「中」是 3 字节 UTF-8），让上限恰好落在某个字符中间。
    const body = "中".repeat(100);
    writeAgents(dir, body);
    const limit = 10; // 10 不是 3 的倍数 ⇒ 天真截断会切出半个字符
    const discovery = discoverProjectInstructions({ cwd: dir, maxBytes: limit });
    assert.equal(discovery.files.length, 1);
    assert.equal(discovery.truncated, true);
    assert.equal(discovery.files[0].truncated, true);
    assert.equal(discovery.files[0].originalBytes, Buffer.byteLength(body, "utf8"));
    assert.ok(discovery.files[0].bytes <= limit, `注入字节数 ${discovery.files[0].bytes} 必须 ≤ 上限 ${limit}`);
    assert.equal(discovery.files[0].bytes % 3, 0, "多字节字符要么整段进来、要么整段丢掉");
    assert.equal(discovery.files[0].content, "中".repeat(discovery.files[0].bytes / 3));
    assert.doesNotMatch(discovery.files[0].content, /\uFFFD/u, "截断不许伪造出替换字符");
    assert.equal(discovery.totalBytes, discovery.files[0].bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 发现函数：只读 cwd 这一层，不向上找父目录、不碰 home", async () => {
  const parent = await makeTmp("erix-716-parent-");
  try {
    writeAgents(parent, `# 父目录的约定\n${SENTINEL}\n`);
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    const discovery = discoverProjectInstructions({ cwd: child });
    assert.deepEqual(discovery.files, [], "父目录的 AGENTS.md 不得被上溯捡到（#717 的 home 层也未决）");
    assert.equal(discovery.totalBytes, 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("#716 发现函数：AGENTS.md 是个目录 ⇒ 不抛，留痕行说「不可用」而不是「没有这个文件」", async () => {
  const dir = await makeTmp("erix-716-isdir-");
  try {
    const path = join(dir, PROJECT_INSTRUCTIONS_FILENAME);
    mkdirSync(path, { recursive: true });
    const discovery = discoverProjectInstructions({ cwd: dir });
    assert.deepEqual(discovery.files, []);
    assert.equal(discovery.skipped.length, 1);
    assert.equal(discovery.skipped[0].code, "EISDIR");
    const notice = buildCliSystemPrompt({ cwd: dir }).notice;
    assert.match(String(notice), /^\[项目约定\] 未发现 AGENTS\.md（/u);
    assert.ok(String(notice).includes(path));
    assert.match(String(notice), /不可用：EISDIR/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 发现函数：cwd 必须由调用方显式给（库内不猜路径）", () => {
  assert.throws(() => discoverProjectInstructions({}), /cwd/u);
  assert.throws(() => discoverProjectInstructions({ cwd: "  " }), /cwd/u);
});

// ---------------------------------------------------------------------------
// 2. 共享装配器（chat 与 repl 同一条路 ⇒ 一次覆盖两条边）
// ---------------------------------------------------------------------------

test("#716 装配器：注入段与既有段落共存，且拼在 buildCliToolsSystemPrompt 的结果之外", async () => {
  const dir = await makeTmp("erix-716-assemble-");
  try {
    writeAgents(dir, `# 项目约定\n${SENTINEL}\n`);
    const { systemPrompt, discovery, notice } = buildCliSystemPrompt({
      cwd: dir,
      archiveDir: join(dir, "outputs", "run"),
      mcpEnabled: true,
      planDirective: true,
    });
    // 既有段落一个不少（工具清单 + 归档说明 + MCP 段 + 计划句）。
    assert.ok(systemPrompt.startsWith(`你是 erix 编码助手，工作目录 ${dir}。`));
    assert.ok(systemPrompt.includes(buildCliToolsSystemPrompt({ todo: true, delegate: false })));
    assert.match(systemPrompt, /\[工具输出归档\]/u);
    assert.match(systemPrompt, /MCP 代理工具 mcp 可用/u);
    assert.match(systemPrompt, /每轮开始先用一句话/u);
    // 新增段落：路径 + 哨兵都在，且在最末（与上文冲突时以项目约定为准的读法成立）。
    assert.match(systemPrompt, /\[项目约定\]/u);
    assert.ok(systemPrompt.includes(SENTINEL));
    assert.ok(systemPrompt.trimEnd().endsWith(SENTINEL), "项目约定段拼在系统提示最末");
    assert.equal(discovery?.files.length, 1);
    assert.match(String(notice), /\[项目约定\] 已注入 1 个文件/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 装配器：--no-agents（agents: false）⇒ 零注入、零留痕，提示词与 0.31.0 逐字节一致", async () => {
  const dir = await makeTmp("erix-716-off-");
  try {
    writeAgents(dir, `# 项目约定\n${SENTINEL}\n`);
    const off = buildCliSystemPrompt({ cwd: dir, agents: false, planDirective: true });
    assert.equal(off.discovery, null, "关闭时连发现都不做（null 与「发现了 0 个」区分开）");
    assert.equal(off.notice, null);
    assert.ok(!off.systemPrompt.includes(SENTINEL));
    const legacy = `你是 erix 编码助手，工作目录 ${dir}。${buildCliToolsSystemPrompt({ todo: true, delegate: false })}`
      + "\n\n每轮开始先用一句话（≤30字）说明当前计划，再调用工具。";
    assert.equal(off.systemPrompt, legacy, "关掉注入后必须逐字节回到旧装配");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 装配器：repl 形态（无计划句）与 chat 形态只差那一句", async () => {
  const dir = await makeTmp("erix-716-both-");
  try {
    writeAgents(dir, `# 项目约定\n${SENTINEL}\n`);
    const chat = buildCliSystemPrompt({ cwd: dir, planDirective: true }).systemPrompt;
    const repl = buildCliSystemPrompt({ cwd: dir, planDirective: false }).systemPrompt;
    const directive = "\n\n每轮开始先用一句话（≤30字）说明当前计划，再调用工具。";
    assert.equal((chat.match(/每轮开始先用一句话/gu) ?? []).length, 1);
    assert.equal((repl.match(/每轮开始先用一句话/gu) ?? []).length, 0);
    assert.ok(repl.includes(SENTINEL), "repl 边也必须见到同一份注入内容");
    assert.ok(chat.includes(SENTINEL));
    assert.equal(chat.replace(directive, ""), repl, "两条边只差那计划句");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. 留痕行（两条分支；transcript 不落 system，所以这两行是唯一证据）
// ---------------------------------------------------------------------------

test("#716 留痕行：注入了 ⇒ 文件数 / 字节数 / 路径都对得上", async () => {
  const dir = await makeTmp("erix-716-notice-");
  try {
    const body = `# 项目约定\n${SENTINEL}\n`;
    const path = writeAgents(dir, body);
    const notice = buildCliSystemPrompt({ cwd: dir }).notice;
    const bytes = Buffer.byteLength(body, "utf8");
    assert.equal(notice, `[项目约定] 已注入 1 个文件 / ${bytes} 字节 (${path})`);
    assert.equal(formatProjectInstructionsNotice(discoverProjectInstructions({ cwd: dir })), notice);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 留痕行：一个都没找到 ⇒ 走「未发现」分支且不抛", async () => {
  const dir = await makeTmp("erix-716-notice-missing-");
  try {
    const notice = buildCliSystemPrompt({ cwd: dir }).notice;
    assert.equal(notice, "[项目约定] 未发现 AGENTS.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 留痕行：截断时额外说明（不静默丢内容）", async () => {
  const dir = await makeTmp("erix-716-notice-truncate-");
  try {
    writeAgents(dir, "中".repeat(100));
    const notice = buildCliSystemPrompt({ cwd: dir, maxBytes: 9 }).notice;
    assert.match(String(notice), /^\[项目约定\] 已注入 1 个文件 \/ 9 字节 \(/u);
    assert.match(String(notice), /已截断/u);
    assert.match(String(notice), /超过 9 字节上限/u, "上限取本次生效的那个（可覆盖），不是缺省常量");
    assert.equal(discoverProjectInstructions({ cwd: dir }).limit, PROJECT_INSTRUCTIONS_MAX_BYTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. 旗标（chat / repl 两侧都认）
// ---------------------------------------------------------------------------

test("#716 --no-agents：chat 与 repl 的解析器都认，重复即 usage 错", async () => {
  const dir = await makeTmp("erix-716-flag-");
  try {
    assert.equal(parseChatArgs(["hi", "--no-agents"], dir).noAgents, true);
    assert.equal(parseChatArgs(["hi"], dir).noAgents, undefined, "缺省 = 不做任何关闭");
    assert.throws(() => parseChatArgs(["hi", "--no-agents", "--no-agents"], dir), /参数重复/u);
    assert.equal(parseReplArgs(["--no-agents"], dir, dir).noAgents, true);
    assert.equal(parseReplArgs([], dir, dir).noAgents, undefined);
    assert.throws(() => parseReplArgs(["--no-agents", "--no-agents"], dir, dir), /参数重复/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. 装配级：真进了模型视野 + 留痕行走 stderr 出口
// ---------------------------------------------------------------------------

test("#716 装配级：runChat 把约定拼进 config.input.system，并往 noticeLog 打留痕行", async () => {
  const dir = await makeTmp("erix-716-runchat-");
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const ref = {};
  const notices = [];
  try {
    const path = writeAgents(project, `# 项目约定\n${SENTINEL}\n`);
    await runChat({
      prompt: "hi",
      session: "agents-on",
      cwd: project,
      dir: join(dir, "transcripts"),
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills-empty"),
      configPath: await writeEmptyMcpConfig(dir),
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      noticeLog: (line) => notices.push(line),
      loop: captureLoop(ref),
    });
    const system = ref.options?.config?.input?.system;
    assert.equal(typeof system, "string");
    assert.ok(system.includes(SENTINEL), "注入内容必须真的在交给引擎的 system 里");
    assert.match(system, /\[项目约定\]/u);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^\[项目约定\] 已注入 1 个文件 \/ \d+ 字节 \(/u);
    assert.ok(notices[0].includes(path), `留痕行要点名路径：${notices[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#716 装配级：runChat --no-agents ⇒ 无哨兵、无留痕行（静默关闭）", async () => {
  const dir = await makeTmp("erix-716-runchat-off-");
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const ref = {};
  const notices = [];
  try {
    writeAgents(project, `# 项目约定\n${SENTINEL}\n`);
    await runChat({
      prompt: "hi",
      session: "agents-off",
      cwd: project,
      noAgents: true,
      dir: join(dir, "transcripts"),
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills-empty"),
      configPath: await writeEmptyMcpConfig(dir),
      provider: createFakeProvider([]),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      maxRounds: 2,
      idleTimeout: 0,
      toolOutput: () => {},
      noticeLog: (line) => notices.push(line),
      loop: captureLoop(ref),
    });
    const system = ref.options?.config?.input?.system;
    assert.ok(!system.includes(SENTINEL));
    assert.doesNotMatch(system, /\[项目约定\]/u);
    assert.deepEqual(notices, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
