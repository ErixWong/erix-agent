// issue #391（#386 切片 4）R1：三个宿主把 `cwd` 接到 `runToolLoop` 上，且**升级指南 §9 的配方
// 逐字可用**。
//
// 病（实测，别再怀疑）：`cwd` 是引擎的纯透传选项（只进 finalGuard / deliverables 的事实载荷），
// 三个宿主（`bin/cli.js` 的 loopOptions、`bin/repl.js` 的 loopOptions、
// `examples/pi-extension/erix-run-core.js` 的 buildLoopOptions）都没传。于是指南 §9 那段
// `path.join(cwd, "report.md")` 在宿主里拼成 `"undefined/report.md"` —— 不报错，只是**恒假**：
// 每次 guard 说 accept 都被机器闸门判成 `unverified:deliverables_failed`。
//
// 这一组是**对偶**的：同一段配方，给了 cwd ⇒ verified，不给 cwd ⇒ unverified。只有两格同时在，
// 才证明「绿的来源是 cwd 到位」而不是别的什么。
//
// 第一格**不手抄配方**：它从 `docs/host-upgrade-guide-0.24.0.md` §9 的 ```js 围栏里读源码、
// 用 `new Function` 原样执行（宿主只需注入 `runToolLoop` / `path` / `fs`）。文档改一个字这格就跟着改，
// 「指南写的」与「引擎真收的」之间不存在第二份手抄副本。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runChat, parseChatArgs } from "../bin/cli.js";
import { runRepl } from "../bin/repl.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import * as core from "../examples/pi-extension/erix-run-core.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
// issue #391 R3：出厂判据本体（CLI 与扩展共用同一份，见 bin/final-guard.js）。
import { createNamedDeliverableChecks } from "../bin/final-guard.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

/**
 * issue #498 S5：`bin/` 的选项按**规位**书写（数据 ⇒ `config.*`、回调 ⇒ `capabilities.hooks.*`）。
 * 本读取器两个方向都断言：规位必须真读到值（`undefined` 就红，防止映射改错退化成恒真格），
 * 且扁平位**不得**同时存在（同一个旋钮两个真相来源 ⇒ `config_override_conflict`）。
 *
 * @param {Record<string, any>} captured `loop` 收到的选项对象
 * @param {string} path 规位路径
 * @returns {any}
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
import { makeTmp } from "./helpers/tmp.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUIDE = join(REPO_ROOT, "docs", "host-upgrade-guide-0.24.0.md");

/**
 * 从 0.24.0 升级指南里抠出 §9 那段 `deliverables` 配方（唯一含 `deliverables: [{` 的 js 围栏）。
 * 抠不到就**报错**而不是跳过：抽不到真值 = 检查面失效（#164 口径）。
 */
function guideRecipeSource() {
  const text = readFileSync(GUIDE, "utf8");
  const fences = [...text.matchAll(/```js\n([\s\S]*?)```/gu)].map((m) => m[1]);
  const hit = fences.filter((body) => body.includes("deliverables: [{"));
  assert.equal(hit.length, 1, `§9 的 deliverables 配方应恰好一个 js 围栏，实测 ${hit.length} 个`);
  return hit[0].trim();
}

const RECIPE = guideRecipeSource();

/**
 * **原样执行**指南那段代码：`return <snippet>` 让它成为一个表达式，宿主只注入
 * `runToolLoop` / `path` / `fs` 三个名字（正是配方正文里用到的全部）。
 * 注入的 `runToolLoop` 把配方给的选项合并到本用例的基础选项上，再交给真引擎。
 */
function runGuideRecipe(baseOptions) {
  const factory = new Function("runToolLoop", "path", "fs", `return ${RECIPE}`);
  return factory((options) => runToolLoop({ ...baseOptions, ...options }), path, fs);
}

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
/** 结束协议信封：`done:true` 让引擎当轮收尾（否则纯文本要等连续 3 轮无工具才停）。 */
const wrapup = (object) => text(JSON.stringify(object));

/** 真写盘的工具：`writeFile` 的 input 落到磁盘（否则「文件存在」不是磁盘事实）。 */
const diskWriteTool = async (call) => {
  mkdirSync(dirname(call.input.path), { recursive: true });
  writeFileSync(call.input.path, call.input.content ?? "");
  return "ok";
};

test("#391 R1-a 指南 §9 的配方**逐字**可用：给了 cwd ⇒ 判据在真磁盘上通过 ⇒ verified", async () => {
  const dir = await makeTmp("erix-cwd-recipe-");
  const target = join(dir, "report.md");
  let seenPayload;
  const result = await runGuideRecipe({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      wrapup({ done: true, summary: "写完了", output: "done" }),
    ]),
    initialUserMessage: `把 42 写进 ${target}`,
    // 唯一变量：宿主把 cwd 传下去了（R1 修的就是这三处）。
    cwd: dir,
    maxRounds: 4,
    executeTool: diskWriteTool,
    finalGuard: async (payload) => {
      seenPayload = payload;
      return { action: "accept" };
    },
  });

  assert.equal(existsSync(target), true, "工具没真写到盘上（这一格的判据是磁盘事实）");
  assert.equal(seenPayload.cwd, dir, "引擎没把宿主的 cwd 透传给 guard/判据");
  // ⚠ 配方里的 `detail` 是三元的、**成功时也会带上**（`wrote ? "missing on disk" : "never written"`）。
  // 这是指南那段代码的原文行为，测试不替它美颜：`detail` 只在 `ok:false` 时有意义，成功时它是噪声。
  assert.deepEqual(seenPayload.deliverables, [{ name: "report", ok: true, detail: "missing on disk" }]);
  assert.equal(result.verification.status, "verified", JSON.stringify(result.verification));
  assert.equal(result.verification.metrics.deliverables_checked, 1);
  assert.equal(result.verification.metrics.deliverables_failed, 0);
});

test("#391 R1-b 反证：同一段配方**不传 cwd** ⇒ 判据恒假 ⇒ unverified:deliverables_failed", async () => {
  const dir = await makeTmp("erix-cwd-recipe-nocwd-");
  const target = join(dir, "report.md");
  let seenPayload;
  const result = await runGuideRecipe({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      wrapup({ done: true, summary: "写完了", output: "done" }),
    ]),
    initialUserMessage: `把 42 写进 ${target}`,
    // 没有 cwd：宿主漏接线时的真实形状。
    maxRounds: 4,
    executeTool: diskWriteTool,
    finalGuard: async (payload) => {
      seenPayload = payload;
      return { action: "accept" };
    },
  });

  assert.equal(existsSync(target), true, "文件确实写了——失败的只能是判据，不是交付物");
  assert.equal("cwd" in seenPayload, false, "没传 cwd 时 payload 里根本不该有该键（缺席 ≠ undefined）");
  // 配方正文是 `path.join(cwd, …)`：cwd 缺席时它**抛** TypeError，引擎按 fail-closed 记成 `threw`
  // （不是「静默通过」，也不是「静默忽略」）。这就是「恒假」的具体形状。
  assert.deepEqual(seenPayload.deliverables, [{ name: "report", ok: false, detail: "threw" }]);
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "deliverables_failed");
  assert.equal(result.verification.metrics.deliverables_failed, 1);
});

test("#391 R1-b2 反证（不抛版本）：判据自己挡 cwd 缺席，也一律 ok:false", async () => {
  // 有人会把配方写成「cwd 缺席就返回 false」而不是让它抛——两种写法都必须恒假，不许有一种
  // 因为「没传 cwd 反而更宽松」而放行。
  const dir = await makeTmp("erix-cwd-recipe-defensive-");
  const target = join(dir, "report.md");
  let observed;
  const result = await runToolLoop({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      wrapup({ done: true, summary: "写完了", output: "done" }),
    ]),
    initialUserMessage: "写 report.md",
    maxRounds: 4,
    executeTool: diskWriteTool,
    deliverables: [{
      name: "report",
      check: (facts) => {
        observed = facts.cwd;
        if (typeof facts.cwd !== "string") return { ok: false, detail: "no_cwd" };
        return { ok: existsSync(path.join(facts.cwd, "report.md")), detail: "checked" };
      },
    }],
    finalGuard: async () => ({ action: "accept" }),
  });

  assert.equal(observed, undefined, "没传 cwd ⇒ 判据拿到的就是 undefined（不是 \"\" / \".\" / process.cwd()）");
  assert.equal(result.verification.reason, "deliverables_failed");
});

// ── issue #391 R3：**出厂判据**（不是宿主手写的谓词）的对偶两格 ──────────────────────
//
// 上面 R1-a / R1-b 钉的是指南 §9 那段**宿主手写**的谓词。本仓现在出厂的是**命名判据**
// （`createNamedDeliverableChecks`，CLI 的 `--require-deliverable <path>` 与扩展的
// `deliverablePaths` 都走它），它的 cwd 语义必须与 §9 同一形状：
//   · 宿主接了 cwd ⇒ 相对路径按它解析 ⇒ 文件在盘上就 verified；
//   · 宿主没接 cwd ⇒ **不抛**（工厂自己挡），但一律 `ok:false` 并点名「没把 cwd 交给 runToolLoop」
//     ——这就是 #391 的原始症状，只是这次它说的是人话，而不是一个 TypeError 的 `threw`。
test("#391 R3-a 出厂命名判据 + 宿主接了 cwd ⇒ 按 cwd 解析相对路径 ⇒ verified", async () => {
  const dir = await makeTmp("erix-cwd-named-ok-");
  const target = join(dir, "report.md");
  let seenPayload;
  const result = await runToolLoop({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      wrapup({ done: true, summary: "写完了", output: "done" }),
    ]),
    initialUserMessage: "写 report.md",
    cwd: dir,
    maxRounds: 4,
    executeTool: diskWriteTool,
    // 出厂判据本体：宿主只声明「这次必须交付 report.md」（相对路径），join 由工厂做。
    deliverables: createNamedDeliverableChecks(["report.md"]),
    finalGuard: async (payload) => {
      seenPayload = payload;
      return { action: "accept" };
    },
  });
  assert.equal(existsSync(target), true);
  assert.deepEqual(seenPayload.deliverables, [{ name: "report.md", ok: true }]);
  assert.equal(result.verification.status, "verified", JSON.stringify(result.verification));
});

test("#391 R3-b 出厂命名判据 + 宿主**没接** cwd ⇒ 恒 ok:false（#391 的原始症状，不抛但拦得住）", async () => {
  const dir = await makeTmp("erix-cwd-named-nocwd-");
  const target = join(dir, "report.md");
  let seenPayload;
  const result = await runToolLoop({
    provider: createFakeProvider([
      toolUse("w1", "writeFile", { path: target, content: "42" }),
      wrapup({ done: true, summary: "写完了", output: "done" }),
    ]),
    initialUserMessage: "写 report.md",
    // 没有 cwd：宿主漏接线时的真实形状。
    maxRounds: 4,
    executeTool: diskWriteTool,
    deliverables: createNamedDeliverableChecks(["report.md"]),
    finalGuard: async (payload) => {
      seenPayload = payload;
      return { action: "accept" };
    },
  });
  assert.equal(existsSync(target), true, "文件确实写了——失败的只能是判据");
  assert.equal("cwd" in seenPayload, false, "没传 cwd 时 payload 里根本不该有该键（缺席 ≠ undefined）");
  const [criterion] = seenPayload.deliverables;
  assert.equal(criterion.ok, false, "没有 cwd 时相对路径无从解析 ⇒ 必须 ok:false（不许放行）");
  assert.match(criterion.detail, /没把 cwd 交给 runToolLoop/u, `detail 要说出真正的原因：${criterion.detail}`);
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.reason, "deliverables_failed");
  // 绝对路径不吃 cwd：同一台机器上换一个 cwd 也必须照旧通过（判据判的是路径，不是 cwd 在不在）。
  const absolute = createNamedDeliverableChecks([target])[0];
  assert.equal(absolute.check({}), true, "绝对路径不需要 cwd");
});

// ── 三个宿主的接线（R1 的改动面本身）─────────────────────────────────────────────

test("#391 R1-c `erix chat --cwd <dir>`：解析 → loopOptions.cwd（缺省 = 进程工作目录）", async () => {
  const dir = await makeTmp("erix-cwd-chat-");
  const transcripts = join(dir, "transcripts");
  let captured;
  const loop = async (options) => {
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
  const parsed = parseChatArgs(["hi", "--cwd", dir, "--dir", transcripts], REPO_ROOT);
  assert.equal(parsed.cwd, dir, "--cwd 要解析成绝对路径");
  await runChat({
    ...parsed,
    notesDir: join(dir, "notes"),
    skillsDir: join(dir, "skills"),
    configPath: join(dir, "mcp.json"),
    provider: createFakeProvider([]),
    config: { model: "fake-model", maxOutputTokens: 1000 },
    maxRounds: 1,
    idleTimeout: 0,
    toolOutput: () => {},
    loop,
  });
  assert.equal(canonicalLoopOption(captured, "config.run.cwd"), dir, "chat 的 loopOptions 必须把 --cwd 交给引擎");

  // 不给 --cwd ⇒ 进程工作目录（既有行为逐字不变）
  captured = undefined;
  await runChat({
    ...parseChatArgs(["hi", "--dir", transcripts], REPO_ROOT),
    notesDir: join(dir, "notes"),
    skillsDir: join(dir, "skills"),
    configPath: join(dir, "mcp.json"),
    provider: createFakeProvider([]),
    config: { model: "fake-model", maxOutputTokens: 1000 },
    maxRounds: 1,
    idleTimeout: 0,
    toolOutput: () => {},
    loop,
  });
  assert.equal(canonicalLoopOption(captured, "config.run.cwd"), process.cwd());
});

test("#391 R1-d `erix repl`：loopOptions.cwd = 进程工作目录", async () => {
  const home = await makeTmp("erix-cwd-repl-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let captured;
  try {
    const run = runRepl(["--config", join(home, "mcp.json")], {
      input,
      output,
      home,
      notesDir: join(home, "notes"),
      config: { model: "fake-model", maxOutputTokens: 1000 },
      providerFactory: () => ({}),
      loop: async (options) => {
        captured = options;
        return {
          finalText: "done",
          messages: [],
          rounds: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
          compactionStats: [],
        };
      },
    });
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    input.end("hi\n/exit\n");
    await run;
    assert.equal(canonicalLoopOption(captured, "config.run.cwd"), process.cwd());
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("#391 R1-e `erix_run`：buildLoopOptions 把 params.cwd 透传下去", () => {
  const controller = new AbortController();
  const options = core.buildLoopOptions({
    params: { task: "t", cwd: "/work/proj", maxRounds: 8, timeoutMs: 1000 },
    system: "SYS",
    slot: { endpoint: "e", model: "m", apiKey: "k" },
    provider: {},
    tools: { tools: [], executeTool: async () => "ok" },
    store: createMemoryTranscriptStore(),
    signal: controller.signal,
    runId: "run-cwd",
  });
  // #498 S6：`cwd` 的规位是 `config.run.cwd`（顶层不再留扁平位）——`canonicalLoopOption`
  // 两侧都断：规位读不到值就红，扁平位同时在场也红。
  assert.equal(canonicalLoopOption(options, "config.run.cwd"), "/work/proj");
});
