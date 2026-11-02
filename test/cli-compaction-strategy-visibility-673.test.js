// 工单 #673：**CLI 折叠可见性**（只做展示层，不改引擎事实）。
//
// 现场：#657 已经让 `compactionStats[].strategyName` / `type: "compaction"` 事件说出「实际执行折叠的
// 那一层」，#661 已经让摘要器失败响亮失败——但 CLI 一个字都不显示（`grep -c strategyName bin/cli.js`
// 当时是 `0`）。本片补三件事，三件都要被这一份测试钉住：
//   判据 1  终局 stdout 多一行机器可读的折叠摘要（`=== 折叠 === strategy=… folds=… …`）；
//   判据 2  运行中的即时提示走 **stderr**（不写 stdout，免得污染 `--stream` 的终稿字节流）；
//   判据 3  同一批事件落 `judge.log`（JSONL，`appendJudgeLogRecord` 统一加 `ts`）；
//   判据 4  `compaction_strategy_fallback` 的两条渠道（stderr + judge.log）都接上了；
//   判据 5  **零折叠 ⇒ 输出逐字不变**（stdout / stderr / judge.log 三处都不许多出东西）。
//
// 三条环境纪律（照 `test/cli-compaction-default-614.test.js` 抄，别重新发明）：
//   1. **假 HOME**：`HOME`/`USERPROFILE` 指到一次性临时目录，配置写 `<HOME>/.erix/config.json`
//      （形状从 `fixtures/config-shape.mjs` 拿，端点键名是 `endpoint`）；`XDG_CONFIG_HOME` 必须删掉。
//   2. **不联网**：端点是 `fixtures/upstream.mjs` 起的真 socket 假上游（绑 `127.0.0.1:0`），
//      每条真折叠用例都断言上游真的收到了请求。
//   3. **代理防御**：进出都清代理类变量（`NODE_USE_ENV_PROXY` 会把 `127.0.0.1` 也送给代理）。
//
// 折叠是**逼**出来的（不是靠运气）：靠 `keepRounds`（默认 6）这条边界，**不是**工作集地板
// （#612 之后地板默认 `0` = 关）。预算 `10_000` 与 9 轮 `readFile` 的取值理由、以及「预算不能
// 太小否则永远长不到 keepRounds 以上」的机制推导，逐字见 `cli-compaction-default-614.test.js`
// 的文件头注释（同一套夹具、同一组实测数：8 轮 = 11143 token > 10000 且 8 > 6 ⇒ 折 2 轮）。
//
// 判据 4 为什么是进程内（而不是子进程）：CLI **永远**配置策略（`--compaction` 的槽位默认是
// `fold-llm`），而 `compaction_strategy_fallback` 只在 `context.strategy` **未配置**时才会发 ⇒
// 从 `bin/cli.js` 的入口构造不出这个事件。所以那一格直接钉 `createRunEventHandlers` 这个出口：
// 真写一份临时 `judge.log`、真写 `process.stderr`（spy 住默认写出口），断言两条渠道都接上了。
// 这是行为断言，不是「源码里出现过某个字符串」。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTmp } from "./helpers/tmp.js";
import {
  classifyChatRequest,
  createCompactionAwareScript,
  createScriptedUpstream,
  jsonResponse,
  semanticSummaryText,
} from "../fixtures/upstream.mjs";
import { upstreamFields, writeConfigHome } from "../fixtures/config-shape.mjs";
import {
  createRunEventHandlers,
  formatCompactionEventLine,
  formatCompactionFallbackEventLine,
  formatCompactionFoldSummary,
} from "../bin/cli.js";

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

/** 终局折叠摘要行的固定前缀（与 `bin/cli.js` 的 `FOLD_SUMMARY_PREFIX` 同字面量）。 */
const FOLD_SUMMARY_PREFIX = "=== 折叠 ===";
/** 即时提示行的固定前缀（stderr）。 */
const EVENT_LINE_PREFIX = "[compaction]";

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
 * 跑一次 chat（假 HOME + 真 socket 假上游）。`toolRounds` 决定模型连续读文件几次。
 *
 * @param {import("node:test").TestContext} t
 * @param {{toolRounds: number, compactBudget?: number}} options
 */
async function runScenario(t, options) {
  const root = await makeTmp("erix-673-");
  const home = join(root, "home");
  const project = join(root, "project");
  const judgeLogPath = join(root, "judge.log");
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
        if (round < options.toolRounds) {
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
      // 默认策略 `fold-llm` 的摘要器应答：合法分节（与 #614 同一份夹具）。
      summarizer: () => jsonResponse({
        choices: [{ message: { role: "assistant", content: semanticSummaryText() }, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 60 },
      }),
    })],
  });
  t.after(() => upstream.close());
  const baseUrl = await upstream.listen();
  writeConfigHome({
    dir: home,
    erix: {
      ...upstreamFields(baseUrl).erixSlot,
      apiKey: "t673-key",
      model: "t673-model",
      maxOutputTokens: 4096,
    },
  });

  const args = [
    "chat", "工单 #673：折叠可见性场景",
    "--max-rounds", String(MAX_ROUNDS),
    "--reflection", "off",
    "--no-notes",
    "--no-todo",
    // 显式路径：判据 3 要断言这些记录**必须**进这个文件（而不是只进默认归档路径）。
    "--judge-log", judgeLogPath,
  ];
  if (options.compactBudget !== undefined) {
    args.push("--compact-budget", String(options.compactBudget));
  }

  const run = await runCli({ args, home, cwd: project });
  await upstream.settled();
  const requests = upstream.requests.map((entry) => ({
    kind: classifyChatRequest(entry),
    body: String(entry.bodyText ?? ""),
  }));
  // judge.log 在**这一刻**读成文本：`makeTmp` 的清理钩子挂在当前用例上，跑完这条用例
  // 临时目录就没了，跨用例共享同一次 run 的输出时必须把文件内容先取出来。
  const judgeLogText = existsSync(judgeLogPath) ? readFileSync(judgeLogPath, "utf8") : "";
  return { ...run, requests, judgeLogPath, judgeLogText };
}

/** judge.log 的 JSONL 逐行解析（解析不了 ⇒ 直接红，不许静默跳过）。 */
function readJudgeLog(text, label) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        assert.fail(`judge.log（${label}）第 ${index + 1} 行不是合法 JSON：`
          + `${error?.message ?? String(error)}\n${line}`);
      }
    });
}

/** stderr 里以 `[compaction]` 开头的行（行首可能有别的前缀，所以按「包含」找）。 */
function eventLines(stderr) {
  return stderr.split("\n").filter((line) => line.includes(EVENT_LINE_PREFIX));
}

// ---------------------------------------------------------------------------
// 判据 1/2/3：真折叠 ⇒ stdout 摘要行 + stderr 即时提示 + judge.log 记录
// ---------------------------------------------------------------------------

/** 折叠场景只跑一次（子进程 + 真 socket 不便宜），三条判据共用同一份输出。 */
let sharedFoldRun;

function foldRun(t) {
  sharedFoldRun ??= runScenario(t, {
    toolRounds: TOOL_ROUNDS,
    compactBudget: FOLD_BUDGET_TOKENS,
  });
  return sharedFoldRun;
}

test("#673 判据1：真折叠 ⇒ 终局 stdout 有一行机器可读的折叠摘要，`=== 统计 ===` 仍是最后一行", async (t) => {
  const run = await foldRun(t);

  assert.equal(
    run.code,
    EXIT_NOT_VERIFIED,
    `chat 退出码应为 ${EXIT_NOT_VERIFIED}（skipped 不是失败）`
    + `\nstdout(tail)=${run.stdout.slice(-800)}\nstderr(tail)=${run.stderr.slice(-800)}`,
  );
  // 前提：这一次 chat **真的**折叠过（否则本用例什么都没验到）。
  assert.match(run.stdout, /compacted=true/u, "这一次 chat 必须真的折叠过");
  const summarizerRequests = run.requests.filter(({ kind }) => kind === "summarizer");
  assert.ok(
    summarizerRequests.length >= 1,
    `默认策略必须发出摘要器请求（fold-llm 才有的那一发），实际 0 发；分类结果：`
    + run.requests.map(({ kind }) => kind).join(","),
  );

  const foldLines = run.stdout.split("\n").filter((line) => line.startsWith(FOLD_SUMMARY_PREFIX));
  assert.equal(foldLines.length, 1, `终局必须恰好一行折叠摘要，实际 ${foldLines.length} 行；`
    + `stdout(tail)=${run.stdout.slice(-800)}`);
  const foldLine = foldLines[0];
  // 机器可解析：固定前缀 + `key=value`，且策略名是**实际执行折叠**的那一层（#657 的语义）。
  assert.match(
    foldLine,
    /^=== 折叠 === strategy=fold-llm folds=[1-9]\d* foldedRounds=[1-9]\d* tokens=\d+->\d+$/u,
    `折叠摘要行的形状不对：${foldLine}`,
  );
  // `=== 统计 ===` 仍是最后一行（靠尾行取数的脚本不受影响），且前缀没变。
  const statsLines = run.stdout.split("\n").filter((line) => line.includes("=== 统计 ==="));
  assert.equal(statsLines.length, 1, `\`=== 统计 ===\` 必须恰好一行，实际 ${statsLines.length} 行`);
  assert.ok(
    run.stdout.trimEnd().endsWith(statsLines[0].trimEnd()),
    `\`=== 统计 ===\` 必须仍是最后一行；stdout(tail)=${run.stdout.slice(-400)}`,
  );
  assert.match(statsLines[0], /=== 统计 === model=t673-model /u, "统计行的前缀不许改");

  t.diagnostic(`判据 1 折叠摘要行：${foldLine}`);
});

test("#673 判据2：真折叠 ⇒ stderr 有一行即时提示（strategy / foldedRounds / tokens 都在）", async (t) => {
  const run = await foldRun(t);
  const lines = eventLines(run.stderr);
  const foldLines = lines.filter((line) => !line.includes("fallback"));
  assert.ok(
    foldLines.length >= 1,
    `stderr 必须有一行折叠即时提示，实际 0 行；stderr(tail)=${run.stderr.slice(-800)}`,
  );
  const line = foldLines[0];
  assert.match(
    line,
    /\[compaction\] round=\d+ strategy=fold-llm foldedRounds=\d+ tokensBefore=\d+ tokensAfter=\d+/u,
    `即时提示行的形状不对：${line}`,
  );
  // 反向锁：即时提示**只**走 stderr——stdout 里除了终局摘要行不许出现这个前缀
  // （`--stream` 的终稿字节流不能被污染）。
  assert.ok(
    !run.stdout.includes(EVENT_LINE_PREFIX),
    `stdout 里出现了即时提示前缀（会污染 --stream 的终稿）：${run.stdout.slice(-600)}`,
  );
  t.diagnostic(`判据 2 即时提示行：${line}`);
});

test("#673 判据3：真折叠 ⇒ judge.log 有 `type:\"compaction\"` 记录，带真实 strategyName 与 ts", async (t) => {
  const run = await foldRun(t);
  const records = readJudgeLog(run.judgeLogText, run.judgeLogPath);
  const compactionRecords = records.filter((record) => record.type === "compaction");
  assert.ok(
    compactionRecords.length >= 1,
    `judge.log 里没有 compaction 记录（显式 --judge-log 也必须进那个路径）；`
    + `实际类型：${records.map((record) => record.type).join(",")}`,
  );
  for (const record of compactionRecords) {
    // 记录由 `appendJudgeLogRecord` 统一加 `ts`，payload 本体原样（不改事件形状）。
    assert.equal(typeof record.ts, "string", `compaction 记录缺 ts：${JSON.stringify(record)}`);
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/u, `ts 不是 ISO 时间：${record.ts}`);
    assert.equal(record.compaction?.compacted, true, "进 judge.log 的必须是真折叠");
    assert.equal(
      record.compaction?.strategyName,
      "fold-llm",
      `judge.log 里的策略名必须是**实际执行折叠**的那一层（#657）：${JSON.stringify(record.compaction)}`,
    );
    assert.ok(Number.isSafeInteger(record.round), `记录必须带 round：${JSON.stringify(record)}`);
  }
  // 终局记录照旧在同一份文件里（#165 的 join 键不许被这次改动挤掉）。
  assert.ok(
    records.some((record) => record.type === "run_outcome"),
    `judge.log 缺 run_outcome（#165 的终局记录）：${records.map((record) => record.type).join(",")}`,
  );
  t.diagnostic(`判据 3 judge.log compaction 记录条数：${compactionRecords.length}`);
});

// ---------------------------------------------------------------------------
// 判据 4：`compaction_strategy_fallback` 的两条渠道（stderr + judge.log）
// ---------------------------------------------------------------------------

test("#673 判据4：兜底事件 ⇒ stderr 一行 + judge.log 一条（进程内钉出口，真写盘真写 stderr）", async () => {
  const root = await makeTmp("erix-673-fallback-");
  const judgeLogPath = join(root, "judge.log");
  const stderrChunks = [];
  const realWrite = process.stderr.write;
  // 钉**默认**写出口（不注入 writeStderr）：这一格要证的正是「默认就写 stderr」。
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(String(chunk));
    return realWrite.call(process.stderr, "", ...rest);
  };
  let touched = 0;
  try {
    const { onEvent } = createRunEventHandlers({
      judgeLogPath,
      touchIdle: () => { touched += 1; },
    });
    const fallbackEvent = {
      type: "compaction_strategy_fallback",
      round: 7,
      detail: 'engine compaction fallback in effect: context.strategy is not configured, '
        + 'the library default "sliding-window" strategy folds only the oldest rounds needed '
        + 'to fit the budget and prepends a mechanical summary'
        + "; budgetTokens=10000, estimatedTokens=12000",
    };
    onEvent(fallbackEvent);
    // 同一条出口上的既有行为不许被改坏：`attempt` / `recovering` 照旧喂 idle 表。
    onEvent({ type: "attempt", round: 7 });
    onEvent({ type: "recovering", round: 7 });

    const stderrText = stderrChunks.join("");
    const lines = stderrText.split("\n").filter((line) => line.includes(EVENT_LINE_PREFIX));
    assert.equal(lines.length, 1, `兜底事件必须恰好一行 stderr，实际 ${lines.length} 行：${stderrText}`);
    // 首句是引擎写死的原文（#464 A 的判据锚）——必须原样带上，且带 round。
    assert.match(
      lines[0],
      /\[compaction\] fallback round=7 detail=engine compaction fallback in effect: context\.strategy is not configured,/u,
      `兜底即时提示行不对：${lines[0]}`,
    );
    assert.ok(lines[0].includes("budgetTokens=10000"), `兜底即时提示行丢了预算事实：${lines[0]}`);

    const records = readJudgeLog(readFileSync(judgeLogPath, "utf8"), judgeLogPath);
    const fallbackRecords = records.filter((record) => record.type === "compaction_strategy_fallback");
    assert.equal(fallbackRecords.length, 1, `judge.log 必须恰好一条兜底记录，实际 ${fallbackRecords.length} 条`);
    const [record] = fallbackRecords;
    assert.equal(typeof record.ts, "string", "兜底记录也必须由 appendJudgeLogRecord 加 ts");
    assert.equal(record.round, 7);
    assert.equal(record.detail, fallbackEvent.detail, "payload 本体必须原样落盘（不改事件形状）");
    assert.equal(touched, 2, "attempt / recovering 仍必须喂 idle 表（#441 的行为不许被改坏）");
  } finally {
    process.stderr.write = realWrite;
  }
});

test("#673 判据4b：写 stderr 抛错（EPIPE 之类）不许把已完成的 run 带成 failed", async () => {
  const root = await makeTmp("erix-673-epipe-");
  const judgeLogPath = join(root, "judge.log");
  const { onEvent } = createRunEventHandlers({
    judgeLogPath,
    writeStderr: () => { throw new Error("EPIPE: 展示层写失败（夹具）"); },
  });
  // 不抛 ⇒ 展示层失败被吞；同时 judge.log 那一路仍然写成了（两条渠道互不牵连）。
  onEvent({
    type: "compaction",
    round: 3,
    compaction: { compacted: true, foldedRounds: 2, tokensBefore: 11143, tokensAfter: 8332, strategyName: "fold-llm" },
  });
  const records = readJudgeLog(readFileSync(judgeLogPath, "utf8"), judgeLogPath);
  assert.equal(records.filter((record) => record.type === "compaction").length, 1);
});

// ---------------------------------------------------------------------------
// 判据 5：零折叠 ⇒ stdout / stderr / judge.log 三处逐字不变
// ---------------------------------------------------------------------------

test("#673 判据5：零折叠（不传 --compact-budget）⇒ 三处都不许多出折叠事实", async (t) => {
  const run = await runScenario(t, { toolRounds: 1 });

  assert.equal(
    run.code,
    EXIT_NOT_VERIFIED,
    `chat 退出码应为 ${EXIT_NOT_VERIFIED}\nstdout(tail)=${run.stdout.slice(-800)}`
    + `\nstderr(tail)=${run.stderr.slice(-800)}`,
  );
  // 前提：这一次真的没折（`compacted=false`），否则「零折叠」是假的。
  assert.match(run.stdout, /compacted=false/u, "零折叠场景必须 compacted=false");
  assert.equal(eventLines(run.stderr).length, 0, `零折叠不许有即时提示：${run.stderr}`);
  assert.ok(
    !run.stdout.includes(FOLD_SUMMARY_PREFIX),
    `零折叠不许有终局折叠摘要：${run.stdout.slice(-600)}`,
  );
  // 原有输出一字未动：`=== 统计 ===` 仍在、前缀不变。
  assert.match(run.stdout, /=== 统计 === model=t673-model /u, "统计行不许被这次改动影响");

  const records = readJudgeLog(run.judgeLogText, run.judgeLogPath);
  assert.equal(
    records.filter((record) => record.type === "compaction").length,
    0,
    `零折叠不许往 judge.log 写 compaction 记录：${records.map((record) => record.type).join(",")}`,
  );
  // judge.log 本身照旧（run_outcome 是 #165 的终局记录，不是折叠事实）。
  assert.ok(
    records.some((record) => record.type === "run_outcome"),
    "judge.log 的 run_outcome 记录不许被这次改动影响",
  );
});

// ---------------------------------------------------------------------------
// 纯函数层：三态（null / 精确行 / 多折叠）与「不造数」
// ---------------------------------------------------------------------------

test("#673 纯函数层：折叠摘要行三态（无事实 ⇒ null）、多折叠取首末、顺序不随机", () => {
  // ① 无事实 ⇒ null（调用方据此保持输出逐字不变）。
  assert.equal(formatCompactionFoldSummary(undefined), null, "没有 compactionStats ⇒ null");
  assert.equal(formatCompactionFoldSummary([]), null, "空数组 ⇒ null");
  assert.equal(
    formatCompactionFoldSummary([{ compacted: false, foldedRounds: 0, tokensBefore: 10, tokensAfter: 10 }]),
    null,
    "零折叠 ⇒ null",
  );
  assert.equal(
    formatCompactionFoldSummary([{ compacted: true, foldedRounds: 2, tokensBefore: 10, tokensAfter: 8 }]),
    null,
    "折叠了但引擎说不出策略名 ⇒ null（不许打一行会被读成配置项原文的摘要）",
  );

  // ② 一次折叠 ⇒ 精确一行。
  assert.equal(
    formatCompactionFoldSummary([
      { compacted: true, foldedRounds: 2, tokensBefore: 11143, tokensAfter: 8332, strategyName: "fold-llm" },
    ]),
    "=== 折叠 === strategy=fold-llm folds=1 foldedRounds=2 tokens=11143->8332",
  );

  // ③ 多折叠 / 多策略：策略按首次出现顺序去重（不重排、不随机），
  //    tokens 取**首条**折叠的 before -> **末条**折叠的 after。
  const multi = formatCompactionFoldSummary([
    { compacted: true, foldedRounds: 2, tokensBefore: 11143, tokensAfter: 8332, strategyName: "fold-llm" },
    { compacted: false, foldedRounds: 0, tokensBefore: 8332, tokensAfter: 8332 },
    { compacted: true, foldedRounds: 3, tokensBefore: 12000, tokensAfter: 7000, strategyName: "sliding-window" },
    { compacted: true, foldedRounds: 1, tokensBefore: 7000, tokensAfter: 6000, strategyName: "fold-llm" },
  ]);
  assert.equal(
    multi,
    "=== 折叠 === strategy=fold-llm,sliding-window folds=3 foldedRounds=6 tokens=11143->6000",
  );

  // ④ 拿不到可靠 token 数 ⇒ 少写一个 key，而不是造一个 0。
  assert.equal(
    formatCompactionFoldSummary([
      { compacted: true, foldedRounds: 1, strategyName: "fold-llm" },
    ]),
    "=== 折叠 === strategy=fold-llm folds=1 foldedRounds=1",
  );
});

test("#673 纯函数层：即时提示行只认真折叠，兜底行原样带 detail 首句", () => {
  assert.equal(formatCompactionEventLine({ type: "run_outcome" }), null, "不是 compaction ⇒ null");
  assert.equal(
    formatCompactionEventLine({
      type: "compaction",
      round: 4,
      compaction: { compacted: false, foldedRounds: 0, tokensBefore: 9000, tokensAfter: 9000 },
    }),
    null,
    "有统计但没折叠（user-turn 守卫 / TTL 层那一类）⇒ null，不许多打一行",
  );
  assert.equal(
    formatCompactionEventLine({
      type: "compaction",
      round: 8,
      compaction: { compacted: true, foldedRounds: 2, tokensBefore: 11143, tokensAfter: 8332, strategyName: "fold-llm" },
    }),
    "[compaction] round=8 strategy=fold-llm foldedRounds=2 tokensBefore=11143 tokensAfter=8332",
  );
  assert.equal(
    formatCompactionEventLine({
      type: "compaction",
      round: 8,
      compaction: { compacted: true, foldedRounds: 2, tokensBefore: 11143, tokensAfter: 8332 },
    }),
    "[compaction] round=8 strategy=unknown foldedRounds=2 tokensBefore=11143 tokensAfter=8332",
    "策略名缺省时写 unknown（与引擎兜底名字的占位同口径），不编一个策略名",
  );

  assert.equal(formatCompactionFallbackEventLine({ type: "compaction" }), null, "不是兜底事件 ⇒ null");
  const detail = "engine compaction fallback in effect: context.strategy is not configured,\n"
    + "the library default \"sliding-window\" strategy folds only the oldest rounds needed to fit the budget";
  assert.equal(
    formatCompactionFallbackEventLine({ type: "compaction_strategy_fallback", round: 5, detail }),
    "[compaction] fallback round=5 detail=engine compaction fallback in effect: context.strategy is not configured,"
    + " the library default \"sliding-window\" strategy folds only the oldest rounds needed to fit the budget",
    "detail 原样带上（多行压成单行），不截断",
  );
});
