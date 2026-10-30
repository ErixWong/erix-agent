// 工单 #614：**CLI 默认压缩策略改为 `fold-llm`**（统计摘要降为降级兜底）。
//
// 为什么需要这一层（进程级 + 真 socket 假上游）：`DEFAULT_COMPACTION_STRATEGY` 是 CLI 的**选择**
// （引擎层 `resolveCompactionStrategy(undefined) → undefined`，即「不折」——库的边界不动）。
// 所以「默认到底走哪条策略」只有在「真子进程 + 真端点 + 真折叠」这条链上才看得见：
//   判据 1  不传 `--compaction` ⇒ 策略 `fold-llm`；折叠块里出现**语义分节**（`## 阶段` / `## 教训与坑`）；
//   判据 2  显式选择仍生效：`--compaction fold-statistical` ⇒ 走统计（零摘要器请求）、
//           `--compaction sliding-window` ⇒ 走滑动窗口；非法值仍在 load 期报错并列合法值；
//   判据 3  摘要器抛错/失败 ⇒ 折叠块里出现**既有降级标记**，且 run **不失败**（termination 正常）；
//   判据 4  离线夹具**两条路都断言**（正常应答 ⇒ 语义块；应答失败 ⇒ 降级块），
//           分流依据见 `fixtures/upstream.mjs#classifyChatRequest` 的注释（摘要器提示词指南首行 vs
//           非空 `tools` / 多轮历史），**不许**「随机 garbage 摘要却仍判绿」。
//
// 三条环境纪律（照 `test/cli-process.test.js` 抄，别重新发明）：
//   1. **假 HOME**：`HOME`/`USERPROFILE` 指到一次性临时目录，配置写 `<HOME>/.erix/config.json`
//      （形状从 `fixtures/config-shape.mjs` 拿，端点键名是 `endpoint`）；`XDG_CONFIG_HOME` 必须删掉。
//   2. **不联网**：端点是 `fixtures/upstream.mjs` 起的真 socket 假上游（绑 `127.0.0.1:0`），
//      每条跑模型的用例都断言上游真的收到了请求。
//   3. **代理防御**：进出都清代理类变量（`NODE_USE_ENV_PROXY` 会把 `127.0.0.1` 也送给代理）。
//
// 折叠是怎么被**逼**出来的（不是靠运气）：靠的是**`keepRounds`（默认 6）这条边界**，**不是**
// 工作集地板（issue #612 之后地板默认 `0` = 关，本测试不得依赖它；显式开成 2 也必须同样绿）。
//
// 机制（`src/compact/helpers.js#selectFoldedRounds` + `src/loop/orchestrator.js`）：
//   ① 折叠只在「这一发请求**已超预算**」时才尝试；
//   ② 策略只能折**`keepRounds` 之外**的轮次（`target = rounds.length - keepRounds`）；
//   ③ 折完仍超预算 ⇒ 引擎再走**预算兜底**（`keepRounds: 0` 的滑动窗口），那一发会把历史整体
//      丢掉（只留头部的任务描述）。
// ⇒ 所以「预算」必须落在这样一格里：**历史长到 `rounds > keepRounds` 时预算才被撞破**。
//    撞破得太早（预算太小）就落到 ③：`rounds <= keepRounds` ⇒ 策略折 0 轮 ⇒ 兜底清空 ⇒
//    历史**永远长不到** `keepRounds` 以上 ⇒ `folded=0` 全程、摘要器一发都不发。
//    （这正是 #614 的测试在 #612 合入后转红的根因：旧值 `5000` 在 4 轮就撞破预算，那时
//     `rounds=4 < keepRounds=6` ⇒ 策略折 0 轮 ⇒ 兜底把历史清到 2 轮 ⇒ 永远到不了 7 轮。
//     合入 #612 之前它之所以绿，只是**靠地板**（`WORKING_SET_RECENT_ROUNDS=2`）让兜底留下 2 轮
//     原文、历史得以继续长到 7 轮——那是间接依赖地板，测试脆，不是引擎行为。）
//
// 预算为什么是 `10_000`（实测，非估算）：夹具文件约 6KB（200 行）⇒ 每轮 `readFile` 结果 ≈1400–1580
// token（干净累积实测：4 轮 = 6325、8 轮 = 11143）。于是：
//   · 5/6/7 轮都 **< 10000**（7 轮 ≈ 9.6k）⇒ 不会提前撞破，历史能安稳长过 `keepRounds`；
//   · **8 轮 = 11143 > 10000 且 8 > 6** ⇒ 策略在 `keepRounds` 边界上折 2 轮（`folded=2`），
//     `tokensAfter≈8332` 仍 < 10000 ⇒ **预算兜底根本不动手**（实测全程零兜底）。
// ⇒ 折叠 + 摘要器那一发已经发生，兜底此后动不动手都不影响本测试要验的东西。
// 地板 0 / 2 两值实测同一结果（`folded=2`、零兜底）：地板只是排序偏好（`index < floorIndex`），
// `target=2` 时折的仍是最老的两轮。
//
// 另一个不能太小/太大的约束：单条工具结果必须低于 `ERIX_TOOL_RESULT_FOLD_MIN_TOKENS`（4000），
// 否则会被 TTL 折叠抢走（那就不是策略折叠了）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";
import {
  classifyChatRequest,
  createCompactionAwareScript,
  createScriptedUpstream,
  jsonResponse,
  SEMANTIC_SUMMARY_MARKER,
  semanticSummaryText,
  textResponse,
} from "../fixtures/upstream.mjs";
import { upstreamFields, writeConfigHome } from "../fixtures/config-shape.mjs";
import {
  buildCompactionContext,
  DEFAULT_COMPACTION_STRATEGY,
  resolveCompactionStrategyName,
} from "../bin/config.js";
import { FOLD_SUMMARY_MARKER } from "../src/compact/fold-statistical.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(ROOT, "bin", "cli.js");

/** `bin/cli.js` 帮助里承诺的退出码：默认不开 `--final-guard` ⇒ 核验 skipped ⇒ 4（**不是**失败）。 */
const EXIT_NOT_VERIFIED = 4;
/** 单条子进程硬超时：卡住的用例必须被杀掉并留下证据，不许拖死整个套件。 */
const CHILD_TIMEOUT_MS = 60_000;

/** 折叠场景的三个数字（理由见文件头注释：靠 `keepRounds` 边界，不靠工作集地板）。 */
const FOLD_BUDGET_TOKENS = 10_000;
const TOOL_ROUNDS = 9;
const MAX_ROUNDS = 14;
const FIXTURE_FILE_LINES = 200;

/**
 * 既有降级标记（`src/compact/fold-llm.js` 的 `[fold-llm 摘要失败，已降级为统计摘要（原因: …）]`）。
 * 不是新加的常量：本单**不许改降级逻辑**，所以这里按既有字面量断言（与
 * `test/compact/fold-llm.test.js` 同一口径）。
 */
const DEGRADE_MARKER = /\[fold-llm 摘要失败，已降级为统计摘要（原因: /u;

const PROXY_VARS = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY",
];

/** 子进程环境：宿主的 `ERIX_*` / `LLM_KIT_*` / 代理 / `XDG_CONFIG_HOME` 一律不带进来。 */
function childEnvironment({ home }) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:ERIX_|LLM_KIT_)/u.test(name)) delete env[name];
  }
  for (const name of PROXY_VARS) delete env[name];
  delete env.XDG_CONFIG_HOME;
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function runCli({ args, home, cwd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: childEnvironment({ home }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CHILD_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === null) {
        rejectPromise(new Error(
          `CLI 子进程被 ${signal ?? "超时"} 终止（args=${JSON.stringify(args)}）`
          + `\nstdout(tail)=${stdout.slice(-600)}\nstderr(tail)=${stderr.slice(-600)}`,
        ));
        return;
      }
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

/**
 * 跑一次「会真的折叠」的 chat。返回子进程输出 + 上游登记项（含每发的分类）。
 *
 * @param {import("node:test").TestContext} t
 * @param {{compaction?: string, summarizerFails?: boolean}} [options]
 */
async function runFoldScenario(t, options = {}) {
  const root = await makeTmp("erix-614-");
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "a.txt"),
    Array.from({ length: FIXTURE_FILE_LINES }, (_, index) => `line ${index} ${"x".repeat(60)}`).join("\n"),
    "utf8",
  );

  let toolRound = 0;
  const upstream = createScriptedUpstream({
    script: [createCompactionAwareScript({
      main: () => {
        const round = toolRound;
        toolRound += 1;
        if (round < TOOL_ROUNDS) {
          return jsonResponse({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: `call-${round}`,
                  type: "function",
                  function: { name: "readFile", arguments: JSON.stringify({ path: "a.txt" }) },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 500, completion_tokens: 20 },
          });
        }
        return jsonResponse({
          choices: [{ message: { role: "assistant", content: "折叠场景结束" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 500, completion_tokens: 5 },
        });
      },
      // 判据 4 的两条路：合法分节应答 / 显式失败（500 + 文本 body）。
      summarizer: () => (options.summarizerFails === true
        ? textResponse("scripted summarizer failure（#614 的失败路夹具）", { status: 500 })
        : jsonResponse({
          choices: [{ message: { role: "assistant", content: semanticSummaryText() }, finish_reason: "stop" }],
          usage: { prompt_tokens: 300, completion_tokens: 60 },
        })),
    })],
  });
  t.after(() => upstream.close());
  const baseUrl = await upstream.listen();
  writeConfigHome({
    dir: home,
    erix: {
      ...upstreamFields(baseUrl).erixSlot,
      apiKey: "t614-key",
      model: "t614-model",
      maxOutputTokens: 4096,
    },
  });

  const args = [
    "chat", "工单 #614：折叠场景",
    "--max-rounds", String(MAX_ROUNDS),
    "--reflection", "off",
    "--compact-budget", String(FOLD_BUDGET_TOKENS),
    "--no-notes",
    "--no-todo",
  ];
  if (options.compaction !== undefined) args.push("--compaction", options.compaction);

  const run = await runCli({ args, home, cwd: project });
  await upstream.settled();
  const requests = upstream.requests.map((entry) => ({
    entry,
    kind: classifyChatRequest(entry),
    body: String(entry.bodyText ?? ""),
  }));
  return { ...run, requests, upstream };
}

/**
 * 第一发**主循环请求**里出现该标记的那段原文（证据）：摘要器自己那发里也带着指南的
 * `## 阶段`（那是提示词，不是摘要），所以断言必须只看主循环请求——否则「指南在、摘要没进
 * 上下文」也会绿。
 *
 * @param {Array<{kind: string, body: string}>} requests
 * @param {string|RegExp} marker
 */
function mainRequestWith(requests, marker) {
  return requests.find(({ kind, body }) => kind === "main"
    && (typeof marker === "string" ? body.includes(marker) : marker.test(body)));
}

/** 报告里要贴的原文片段（`\n` 是 JSON 里的转义，解开一段便于人读）。 */
function excerpt(body, needle, radius = 260) {
  const index = body.indexOf(needle);
  if (index === -1) return "（没找到该标记）";
  return body.slice(Math.max(0, index - radius), index + radius).replaceAll("\\n", "\n");
}

// ---------------------------------------------------------------------------
// 判据 1 / 2（纯函数层）：默认值、显式选择、非法值
// ---------------------------------------------------------------------------

test("#614 判据1/2：默认策略是 fold-llm，显式选择仍生效，非法值仍在 load 期报错", () => {
  assert.equal(DEFAULT_COMPACTION_STRATEGY, "fold-llm", "CLI 默认压缩策略必须是 fold-llm");
  assert.equal(resolveCompactionStrategyName(undefined), "fold-llm", "不传 --compaction ⇒ fold-llm");
  assert.equal(resolveCompactionStrategyName(null), "fold-llm", "null 与 undefined 同口径");
  assert.equal(resolveCompactionStrategyName("fold-statistical"), "fold-statistical", "显式统计仍生效");
  assert.equal(resolveCompactionStrategyName(" sliding-window "), "sliding-window", "显式滑动窗口仍生效");
  assert.equal(resolveCompactionStrategyName("fold-llm"), "fold-llm");

  // `buildCompactionContext` 是 CLI 真正交给引擎的那一格：默认值必须落到 `strategy` 上，
  // 否则「默认 fold-llm」只活在常量里、根本没进 run。
  assert.equal(buildCompactionContext({}, 4000).strategy, "fold-llm", "默认策略必须真的进 context");
  assert.equal(
    buildCompactionContext({ compaction: "fold-statistical" }, 4000).strategy,
    "fold-statistical",
    "config.compaction 显式选择必须盖过默认值",
  );

  // 非法值：load 期报错并列出**全部**合法值（既有行为，本单不许改坏）。
  assert.throws(
    () => resolveCompactionStrategyName("psyche"),
    /未知压缩策略[\s\S]*sliding-window \| fold-statistical \| fold-llm[\s\S]*（默认：fold-llm）/u,
  );
});

// ---------------------------------------------------------------------------
// 判据 1 + 4a：默认走 fold-llm，摘要器给合法分节 ⇒ 折叠块含语义分节
// ---------------------------------------------------------------------------

test("#614 判据1/4a：不传 --compaction ⇒ 摘要器那一发真的发了，且折叠块含 ## 阶段 / ## 教训与坑", async (t) => {
  const run = await runFoldScenario(t);

  assert.equal(run.code, EXIT_NOT_VERIFIED, `chat 退出码应为 ${EXIT_NOT_VERIFIED}（skipped 不是失败）`
    + `\nstdout(tail)=${run.stdout.slice(-800)}\nstderr(tail)=${run.stderr.slice(-800)}`);
  assert.match(run.stdout, /compacted=true/u, "这一次 chat 必须真的折叠过（否则本用例什么都没验到）");

  const summarizerRequests = run.requests.filter(({ kind }) => kind === "summarizer");
  assert.ok(
    summarizerRequests.length >= 1,
    `默认策略必须发出摘要器请求（fold-llm 才有的那一发），实际 0 发；分类结果：`
    + run.requests.map(({ kind }) => kind).join(","),
  );

  const withSemantic = mainRequestWith(run.requests, SEMANTIC_SUMMARY_MARKER);
  assert.ok(
    withSemantic !== undefined,
    `折叠块里没有摘要器应答的指纹（${SEMANTIC_SUMMARY_MARKER}）——默认策略没走 fold-llm，`
    + `或者摘要没进主循环上下文；分类结果：${run.requests.map(({ kind }) => kind).join(",")}`,
  );
  const block = withSemantic.body;
  assert.match(block, /## 阶段/u, "折叠块里没有 `## 阶段`（语义分节之一）");
  assert.match(block, /## 教训与坑/u, "折叠块里没有 `## 教训与坑`（语义分节之二）");
  // 反向：走 fold-llm 就不该出现统计摘要的头部标记。
  assert.ok(
    !block.includes(FOLD_SUMMARY_MARKER),
    `折叠块里出现了统计摘要头部（${FOLD_SUMMARY_MARKER}）——默认策略没走语义那条`,
  );
  t.diagnostic(`判据 1 折叠块原文片段：\n${excerpt(block, SEMANTIC_SUMMARY_MARKER)}`);
});

// ---------------------------------------------------------------------------
// 判据 3 + 4b：摘要器失败 ⇒ 既有降级标记，run 不失败
// ---------------------------------------------------------------------------

test("#614 判据3/4b：摘要器返回错误 ⇒ 折叠块含既有降级标记，run 不失败", async (t) => {
  const run = await runFoldScenario(t, { summarizerFails: true });

  // run 不失败：退出码仍是「核验 skipped」那一个，termination 是正常原因。
  assert.equal(run.code, EXIT_NOT_VERIFIED, `摘要器失败**不许**让 run 失败：退出码 ${run.code}，`
    + `期望 ${EXIT_NOT_VERIFIED}\nstdout(tail)=${run.stdout.slice(-800)}\nstderr(tail)=${run.stderr.slice(-800)}`);
  assert.match(run.stdout, /termination=no_tool/u, "termination 必须仍是正常原因（no_tool）");
  assert.match(run.stdout, /compacted=true/u, "这一次 chat 必须真的折叠过");

  const summarizerRequests = run.requests.filter(({ kind }) => kind === "summarizer");
  assert.ok(summarizerRequests.length >= 1, "失败路也必须真的发过摘要器请求（否则测的是别的东西）");

  const degraded = mainRequestWith(run.requests, DEGRADE_MARKER);
  assert.ok(
    degraded !== undefined,
    "折叠块里没有既有降级标记 `[fold-llm 摘要失败，已降级为统计摘要（原因: …）]`；分类结果："
    + run.requests.map(({ kind }) => kind).join(","),
  );
  // 降级块里必须是**统计摘要**那份（可观测性：降级不是「什么都没有」）。
  assert.ok(degraded.body.includes(FOLD_SUMMARY_MARKER), "降级块里没有统计摘要头部标记");
  // 反向：失败路里**不许**出现摘要器应答的指纹（否则「失败却用了应答」）。
  assert.ok(!degraded.body.includes(SEMANTIC_SUMMARY_MARKER), "摘要器失败了，折叠块里却出现了它的应答");
  t.diagnostic(`判据 3 折叠块原文片段：\n${excerpt(degraded.body, "[fold-llm 摘要失败")}`);
});

// ---------------------------------------------------------------------------
// 判据 2（进程级）：显式 --compaction fold-statistical ⇒ 零摘要器请求
// ---------------------------------------------------------------------------

test("#614 判据2（进程级）：--compaction fold-statistical ⇒ 零摘要器请求，折叠块是统计形态", async (t) => {
  const run = await runFoldScenario(t, { compaction: "fold-statistical" });

  assert.equal(run.code, EXIT_NOT_VERIFIED, `显式统计策略的 chat 退出码 ${run.code}，期望 ${EXIT_NOT_VERIFIED}`
    + `\nstdout(tail)=${run.stdout.slice(-800)}\nstderr(tail)=${run.stderr.slice(-800)}`);
  assert.match(run.stdout, /compacted=true/u, "显式统计策略也必须真的折叠（否则「零摘要器请求」毫无意义）");

  const summarizerRequests = run.requests.filter(({ kind }) => kind === "summarizer");
  assert.equal(
    summarizerRequests.length,
    0,
    `--compaction fold-statistical 是零 LLM 路径，不该有摘要器请求（实际 ${summarizerRequests.length} 发）`,
  );
  const statistical = mainRequestWith(run.requests, FOLD_SUMMARY_MARKER);
  assert.ok(statistical !== undefined, `折叠块里没有统计摘要头部（${FOLD_SUMMARY_MARKER}）`);
  assert.ok(
    !statistical.body.includes(SEMANTIC_SUMMARY_MARKER),
    "显式统计策略的折叠块里出现了语义摘要夹具的指纹（说明默认值偷偷覆盖了显式选择）",
  );
});

// ---------------------------------------------------------------------------
// 分流依据本身：三类正面识别（fixture 的自证，别让「分流」变成一句注释）
// ---------------------------------------------------------------------------

test("#614 分流依据：classifyChatRequest 三类都是**正面**识别（摘要器 / 主循环 / 认不出）", () => {
  const summarizerEntry = {
    json: {
      messages: [{
        role: "user",
        content: "请把被折叠轮次整理成可继续工作的日志，并严格使用以下分节：\n## 阶段\n…",
      }],
    },
  };
  assert.equal(classifyChatRequest(summarizerEntry), "summarizer", "带指南首行 ⇒ 摘要器");

  const mainEntry = {
    json: {
      messages: [{ role: "system", content: "你是 erix 编码助手" }, { role: "user", content: "干活" }],
      tools: [{ type: "function", function: { name: "readFile" } }],
    },
  };
  assert.equal(classifyChatRequest(mainEntry), "main", "带非空 tools ⇒ 主循环");

  const wrapupEntry = {
    json: {
      messages: [
        { role: "system", content: "你是 erix 编码助手" },
        { role: "user", content: "干活" },
        { role: "assistant", content: "做完了" },
      ],
    },
  };
  assert.equal(classifyChatRequest(wrapupEntry), "main", "引擎内部不发 tools 的收尾调用按历史轮数认出");

  // 认不出来 ⇒ `unknown`（脚本化上游会回 500 并点名分类失败）：这**正是**「指南首行被改了、
  // 夹具不再认得摘要器」的形状（摘要器请求就是 system+user 两条、没有 tools）。
  const unknownEntry = {
    json: {
      messages: [{ role: "system", content: "某个新提示词" }, { role: "user", content: "某段正文" }],
    },
  };
  assert.equal(classifyChatRequest(unknownEntry), "unknown", "两条都不成立 ⇒ 认不出（必须红，不许 garbage）");
  assert.equal(classifyChatRequest({ json: undefined }), "unknown", "请求体解析不了同样认不出");
});
