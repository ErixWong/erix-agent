// issue #716：项目约定文件（AGENTS.md）发现 + 注入 + 留痕行。
//
// 覆盖面（判据逐条对应验收单）：
//   1. 发现函数：存在 / 缺失（不抛）/ 空文件 / 超限截断 / **只读 cwd 一层**（不上溯父目录）；
//   2. 共享装配器 `bin/system-prompt.js`：注入内容与既有段落共存、`--no-agents` 关闭时零注入，
//      chat 与 repl 走同一个函数 ⇒ 这里一次覆盖两条边；
//   3. stderr 留痕行两条分支（已注入 / 未发现），路径与字节数对得上；
//   4. `--no-agents` 旗标在 chat 与 repl 两侧都被认；
//   5. 装配级：`runChat` 真把内容拼进 `config.input.system`（不是只算了个返回值）；
//   6. issue #721：上限抬到 64 KiB（预算闸说合法的正文装得下）+ 截断时**注入正文里**出现声明
//      （全文 / 本次注入 / 丢弃三个字节数 + 被丢弃的小节名），以及「注入上限 ⇄ 字节预算闸」的交叉对账。
//
// 红线：约定文件原文**不进断言**（里面可能有 token / 内网地址），一律用唯一哨兵字符串。
// 临时目录一律 `makeTmp()`（`scripts/test-hygiene-check.mjs` 规则 B）；`home` / `cwd` 全注入，
// 不触达真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// 6. 注入上限与模型可见声明（issue #721）
// ---------------------------------------------------------------------------
//
// 缺陷本体（issue #721 的现测，不是审美）：注入上限曾是 32 KiB，而**字节预算闸**
// （`scripts/agents-directive-scan.mjs` 的 `LENGTH_BUDGETS`）给本仓这一页允许到 33,792 字节，
// 全局那一页允许到 30,720 字节（`pi-tools:scripts/check-agents-budget.sh`）。于是「预算闸判合法
// 的正文，注入面装不下」：热层 AGENTS.md（实测 32,698 字节）再长 71 字节就**静默**切尾，预算闸
// 一路绿——两道闸互不知情。裁决（2026-11-06）：上限抬到 64 KiB，且**截断必须对模型可见**。
//
// 为什么可见性不是点缀：`--no-todo` 的三条断言曾在 112,464 字节的 AGENTS.md 下绿了几个月，只因
// `todo_add` 正好落在旧截断线之外（`test/integration/no-todo-switch.test.js` 收了那次账）。被测量
// 对象不能随「切在哪个字节」而变，所以截断后果必须写进**注入正文**，不是只写 stderr——无人值守侧
// 没人在场看 stderr。
//
// 夹具纪律照旧：一律合成正文 + 哨兵，绝不粘本仓 AGENTS.md 的真句子；临时目录一律 `makeTmp()`。

/** 尾哨兵：只出现在合成文件的**末尾** ⇒「它在不在注入正文里」就是「有没有被切尾」的判据。 */
const TAIL_SENTINEL_721 = "SENTINEL-721-TAIL-DO-NOT-TRUNCATE";

/** 合成夹具里注定被丢弃的两个小节名（断言只点名它们，不粘真文件正文）。 */
const DROPPED_SECTION_ONE = "SECTION-721-DROPPED-BETA";
const DROPPED_SECTION_TWO = "SECTION-721-DROPPED-GAMMA";

/** 注入段里那句声明的段落头（`bin/system-prompt.js` 的模型可见声明）。 */
const DECLARATION_MARKER = "[项目约定已截断]";

/**
 * 造一份**恰好 `bytes` 字节**的合成正文（填充段纯 ASCII ⇒ 字节算术可现核；标题带中文，所以
 * 头尾一律用 `Buffer.byteLength` 折算，不拿字符数冒充字节数）。
 *
 * @param {number} bytes 目标字节数
 * @param {string} [tail] 末尾小节的哨兵名
 * @returns {string}
 */
function syntheticBody(bytes, tail = TAIL_SENTINEL_721) {
  const head = `# 项目约定（合成夹具，不是本仓真文件）\n${SENTINEL}\n`;
  const tailBlock = `\n# ${tail}\n`;
  const filler = bytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tailBlock, "utf8");
  assert.ok(filler > 0, `夹具太小：${bytes} 字节装不下头尾两段`);
  return head + "x".repeat(filler) + tailBlock;
}

/**
 * 带三个小节的合成正文（纯 ASCII 小节名，便于逐字断言「谁被丢了」）。
 *
 * @param {number} [fillerBytes] 每个小节的填充字节数
 * @returns {string}
 */
function sectionedBody(fillerBytes = 400) {
  const section = (/** @type {string} */ name) => `\n## ${name}\n${"y".repeat(fillerBytes)}\n`;
  return `# 项目约定（合成夹具）\n${SENTINEL}\n`
    + section("SECTION-721-KEPT-ALPHA")
    + section(DROPPED_SECTION_ONE)
    + section(DROPPED_SECTION_TWO);
}

/**
 * 从预算闸自己的源码里现读它给某份指令页允许的字节数。
 *
 * 为什么现读而不是抄一个数：本单修的正是「两道闸互不知情」，测试里再手抄一份预算就是把第三个副本
 * 塞进来。（不能 `import` 那份脚本：它**被 import 时也会跑一遍 CLI**，会把测试进程的诊断搅乱。）
 *
 * @param {string} file 预算表里的键（如 `AGENTS.md`）
 * @returns {number}
 */
function budgetGateAllowance(file) {
  const text = readFileSync(new URL("../scripts/agents-directive-scan.mjs", import.meta.url), "utf8");
  const block = text.match(/export const LENGTH_BUDGETS = Object\.freeze\(\{([\s\S]*?)\n\}\);/u);
  assert.ok(block !== null, "预算闸的 LENGTH_BUDGETS 读不到 ⇒ 这道交叉对账在空跑");
  const entry = String(block[1]).match(new RegExp(`"${file}":\\s*(\\d+)`, "u"));
  assert.ok(entry !== null, `预算闸的 LENGTH_BUDGETS 里没有 "${file}" 这一格 ⇒ 交叉对账在空跑`);
  return Number(entry[1]);
}

test("#721 上限 64 KiB：预算闸允许的单页正文必须整份注入，不得切尾", async () => {
  const dir = await makeTmp("erix-721-limit-");
  try {
    // 预算闸给本仓这一页允许的上限（现读，不在这里抄一份）：注入面必须装得下它。
    // 261109 指令面瘦身后这一格从 33,792 降到 18,432（由 `--sync` 从实测推出），所以这里只断链子关系：
    // 「预算闸说合法」⇒「注入面装得下」，反向证把上限改到比允许值小 1 字节（旧上限 32 KiB 那一刀已
    // 被页面瘦身跨过去，不再是可用的反向证）。
    const allowance = budgetGateAllowance(PROJECT_INSTRUCTIONS_FILENAME);
    assert.ok(allowance > 0 && allowance < PROJECT_INSTRUCTIONS_MAX_BYTES,
      `预算闸那一格（${allowance}）必须是止于注入上限的正数：漂了就红，别手改本用例`);
    const body = syntheticBody(allowance);
    assert.equal(Buffer.byteLength(body, "utf8"), allowance, "夹具字节数必须逐字等于预算闸的允许值");
    writeAgents(dir, body);

    assert.equal(PROJECT_INSTRUCTIONS_MAX_BYTES, 64 * 1024, "缺省上限就是 64 KiB = 65,536 字节");
    const discovery = discoverProjectInstructions({ cwd: dir });
    assert.equal(discovery.limit, PROJECT_INSTRUCTIONS_MAX_BYTES);
    assert.equal(discovery.truncated, false, "预算闸说合法的正文，注入面必须装得下");
    assert.equal(discovery.files[0].bytes, allowance);
    assert.equal(discovery.totalBytes, allowance);
    assert.deepEqual(discovery.droppedSections, [], "没截断就没有丢弃的小节");
    const section = buildProjectInstructionsSection(discovery);
    assert.ok(section.includes(TAIL_SENTINEL_721), "尾哨兵不在场 = 被切了尾");
    assert.ok(section.trimEnd().endsWith(TAIL_SENTINEL_721), "整份注入 ⇒ 文件最后一行也在提示末尾");
    assert.ok(!section.includes(DECLARATION_MARKER), "没截断就别往提示词里塞声明");

    // 反向证（这一例不是恒真格）：同一份文件在「比允许值小 4 KiB」的上限下**确实**被切尾（切掉的量必须盖过尾哨兵那一行，否则切尾切不到它）
    // ⇒ 判据考的就是上限本身。
    const legacy = discoverProjectInstructions({ cwd: dir, maxBytes: allowance - 4096 });
    assert.equal(legacy.truncated, true, "反向证失败：旧上限下这份本该被切尾");
    const legacySection = buildProjectInstructionsSection(legacy);
    const legacyAt = legacySection.indexOf(DECLARATION_MARKER);
    assert.ok(legacyAt !== -1, "旧上限下也会被切尾 ⇒ 那半巧合今天不会重现：截断必然留下声明");
    assert.ok(!legacySection.slice(0, legacyAt).includes(TAIL_SENTINEL_721),
      "反向证：旧上限下尾哨兵不在正文里（那正是「静默切尾」的形状）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#721 截断时注入正文里出现声明：三个字节数 + 被丢弃的小节名都在提示词内，不是只在 stderr", async () => {
  const dir = await makeTmp("erix-721-declaration-");
  try {
    const body = sectionedBody();
    const filePath = writeAgents(dir, body);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    // 把上限切在第一个小节之后：后两个小节整段落在丢弃侧（名字纯 ASCII ⇒ 字符下标即字节下标）。
    const cutIndex = body.indexOf(`## ${DROPPED_SECTION_ONE}`);
    assert.ok(cutIndex > 0, "夹具自证：小节标题找不到 ⇒ 本用例在空跑");
    const limit = Buffer.byteLength(body.slice(0, cutIndex), "utf8") - 1;

    const discovery = discoverProjectInstructions({ cwd: dir, maxBytes: limit });
    assert.equal(discovery.truncated, true, "夹具自证：这份夹具在该上限下必须真的被截断");
    assert.deepEqual(discovery.droppedSections, [DROPPED_SECTION_ONE, DROPPED_SECTION_TWO],
      "发现层要报出被丢弃的小节名（顺序 = 文件里的出现顺序）");

    // 判据一：声明在**注入正文**里（`buildProjectInstructionsSection` 的输出直接进 system）。
    const section = buildProjectInstructionsSection(discovery);
    const at = section.indexOf(DECLARATION_MARKER);
    assert.ok(at !== -1, `${DECLARATION_MARKER} 必须出现在注入正文里（删掉它 = 回到静默截断）`);
    const injectedBody = section.slice(0, at);
    const declaration = section.slice(at);

    // 判据二：三个字节数逐字在声明里，且与**磁盘事实 / 注入正文**独立量出的数一致。
    const numbers = [...declaration.matchAll(/全文 (\d+) 字节，本次只注入 (\d+) 字节，丢弃 (\d+) 字节/gu)];
    assert.equal(numbers.length, 1, `声明里必须给出「全文 / 本次注入 / 丢弃」三个字节数：${declaration}`);
    const statedTotal = Number(numbers[0][1]);
    const statedInjected = Number(numbers[0][2]);
    const statedDropped = Number(numbers[0][3]);
    assert.equal(statedTotal, statSync(filePath).size, "全文字节数必须是磁盘上的真大小");
    assert.equal(statedTotal, bodyBytes, "全文字节数必须是夹具写下去的字节数");
    assert.equal(statedInjected, Buffer.byteLength(discovery.files[0].content, "utf8"),
      "声明里的注入字节数必须等于真正进提示词的正文长度");
    assert.equal(statedDropped, statedTotal - statedInjected, "三个数的算术必须闭合（不许各报一套）");
    assert.ok(statedInjected <= limit, "注入字节数不许越过本次生效的上限");
    assert.ok(statedDropped > 0, "报「丢弃 0 字节」就是没说谎但也没说事");

    // 判据三：被丢弃的小节名在**声明之后**，且不在声明之前（否则是正文里本来就有的假阳性）。
    for (const name of [DROPPED_SECTION_ONE, DROPPED_SECTION_TWO]) {
      assert.ok(declaration.includes(name), `声明要点名被丢弃的小节 ${name}`);
      assert.ok(!injectedBody.includes(name), `${name} 没被注入，它只能出现在声明里`);
    }
    assert.ok(injectedBody.includes("SECTION-721-KEPT-ALPHA"), "截断点之前的小节必须真的在场");
    assert.match(declaration, /不要猜测它们的内容/u, "声明要让模型知道「没看见的别猜」");

    // 判据四：这条声明走的是**模型可见**通道（chat / repl 的 system 提示），不是 stderr 的复制品。
    const assembled = buildCliSystemPrompt({ cwd: dir, maxBytes: limit });
    assert.ok(assembled.systemPrompt.includes(DECLARATION_MARKER), "声明必须在交给模型的 system 里");
    assert.ok(assembled.systemPrompt.includes(DROPPED_SECTION_ONE));
    const off = buildCliSystemPrompt({ cwd: dir, maxBytes: limit, agents: false });
    assert.ok(!off.systemPrompt.includes(DECLARATION_MARKER), "--no-agents 时连声明一起关掉（零注入）");

    // 判据五：stderr 留痕行同步带上截断事实（同一份事实，两处不许各说一套）。
    assert.match(String(assembled.notice), /已截断/u);
    assert.match(String(assembled.notice), new RegExp(`全文 ${statedTotal} 字节`, "u"));
    assert.match(String(assembled.notice), new RegExp(`丢弃 ${statedDropped} 字节`, "u"));
    assert.ok(String(assembled.notice).includes(DROPPED_SECTION_ONE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#721 今天两页实测合计（63,197 字节）在上限内 ⇒ truncated=false（抬完之后不再切尾）", async () => {
  const dir = await makeTmp("erix-721-two-pages-");
  try {
    // issue #721 的现测两页：全局页 30,499（`pi-tools:GLOBAL_AGENTS.md`）+ 本仓页 32,698。
    const globalPageToday = 30499;
    const repoPageToday = 32698;
    const both = globalPageToday + repoPageToday;
    assert.equal(both, 63197, "夹具形状必须就是裁决里那天的两页合计");
    assert.ok(both <= PROJECT_INSTRUCTIONS_MAX_BYTES, "今天的两页必须装得进新上限");

    writeAgents(dir, syntheticBody(both));
    const discovery = discoverProjectInstructions({ cwd: dir });
    assert.equal(discovery.truncated, false, "两页合计的形状在新上限下必须整份装下");
    assert.equal(discovery.totalBytes, both);
    assert.ok(buildProjectInstructionsSection(discovery).includes(TAIL_SENTINEL_721));

    // 反向证：旧上限装不下这份形状 ⇒ 这一例在旧值下是红的，不是恒真格。
    assert.equal(discoverProjectInstructions({ cwd: dir, maxBytes: 32 * 1024 }).truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#721 两道闸互相知道：预算闸允许的最坏两页组合装得进注入上限（旧上限装不下 = 缺陷本体）", () => {
  // 全局页那一格在**外仓**（`pi-tools:scripts/check-agents-budget.sh` 的 `BUDGET_BYTES`，
  // 注释逐字写着「预算 30 KB = 30*1024 = 30720 字节」）；干净检出里没有那份脚本，所以现抄并点名坐标。
  const globalPageAllowance = 30720;
  const repoPageAllowance = budgetGateAllowance(PROJECT_INSTRUCTIONS_FILENAME);
  const worstCase = globalPageAllowance + repoPageAllowance;
  assert.ok(worstCase <= PROJECT_INSTRUCTIONS_MAX_BYTES, "最坏组合不得超过注入上限（下面一条把它当缺陷本体报）");
  assert.ok(PROJECT_INSTRUCTIONS_MAX_BYTES >= worstCase,
    `注入上限 ${PROJECT_INSTRUCTIONS_MAX_BYTES} 装不下预算闸允许的最坏组合 ${worstCase}：`
    + "预算闸说合法的正文注入面装不下 = issue #721 的缺陷本体回来了");
  assert.ok(PROJECT_INSTRUCTIONS_MAX_BYTES - worstCase >= 1024,
    "余量不得少于裁决里写的那 1,024 字节（页面瘦身只会把它抬更高，降低 = 预算闸又长长了）");
  assert.ok(32 * 1024 < worstCase, "反向证：旧上限本来就装不下这个组合 ⇒ 本判据不是恒真格");
});
