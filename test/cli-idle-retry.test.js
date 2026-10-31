// issue #433 fix 1：idle 判死之后**从账本续跑**（不是整单重跑），预算 + 次数双闸，且必须记账。
//
// 现场（issue 实测，55 个止死 run 逐 run 统计）：27% 的格子被 `idle_timeout` 中止、reward 全 0，
// 对照组（无看门狗）止死 0 格；46/55（83%）该轮一个字节都没回来；这种静默**通常自愈**（未删失窗里
// >300s 静默每 1000 轮 7 次、中位 400s，经历过的 35 个 run 有 18 个最终拿到分），而中转探针显示
// **新请求 3.4–15s 就起流** ⇒ 干等不如重发。但「重发」必须是**从快照续跑**：`#440` 之后判死错误上
// 已经带着 `rounds` / `usage`，整单重跑等于把已付费的 6~19 轮再烧一遍。
//
// 本文件钉四件事：
//   ① **注入静默**：首字节延迟 > idle ⇒ run 以「拿到重试并最终跑完」结束，不是 `idle_timeout`；
//   ② **续跑不是重跑**：第二发请求里真的带着第一轮已落盘的工具结果（同一 runId 的账本被接回来）；
//   ③ **预算用尽**：上游一直静默 ⇒ 落 `idle_timeout` 终局，且 #440 的四件载荷仍在、顶层 `partial` 仍不存在；
//   ④ **记账**：重试次数 / 每次退避 / 累计 usage 从终局载荷（`result.idleRetry` / `error.idleRetry`）
//      与事件流（`judge.log` 的 `type: "idle_retry"`）里读得出来。
//
// 纪律：事件驱动，不断言耗时（idle 窗口与退避是**成因**，断言的是「几次请求 / 什么终局 / 记账里写了什么」）。
// 不写真实 `~/.erix` / `~/.pi`（dir / notesDir / skillsDir / configPath 全部注入 tmp）。
//
// issue #500（本单）：③ 那一格的「预算 1s + idle 1s」曾是一个**零余量**的巧合——预算
// （`1000ms`）恰好等于第一次退避的基档（`IDLE_RETRY_BASE_DELAY_MS = 1000ms`），于是
// `planIdleRetry` 的「退避被剩余预算夹住」那条分支只差 `elapsedMs` 是否等于 0：`markKilled()` 与
// `next()` 之间只要被调度器抢一次（实测全量并发下约 14%），`elapsedMs` 就是 1 ⇒ 记账里的退避
// 变成 999，断言 `backoffMs === [1000]` 红。**改法不是把 sleep/timeout 加大**（那只是把 flake
// 概率挪走）：窗口改成**当场实测派生**（探针走生产同一条代码路径量「`markKilled → next()` 吃掉
// 多少预算」，再按倍数 + 下限 + 上限推出整秒档的 idle 窗口与预算），并照 PR #442 的先例给它装上
// 三条守卫与字面量契约——派生值本身、派生契约（系数/下限/上限）、以及「本次 run 里前提真的成立」
// 三者各自都会红。见下面「③ 的时间余量派生」一段。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runChat } from "../bin/cli.js";
import {
  DEFAULT_IDLE_RETRY_BUDGET_SECONDS,
  IDLE_RETRY_BASE_DELAY_MS,
  IDLE_RETRY_MAX_ATTEMPTS,
  IDLE_RETRY_MAX_DELAY_MS,
  createIdleRetryState,
  idleRetryBackoffMs,
  planIdleRetry,
} from "../bin/idle.js";
import { safeRunId } from "../src/store/file.js";
import { makeTmp } from "./helpers/tmp.js";

async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

const ROUND1_USAGE = Object.freeze({ input_tokens: 300, output_tokens: 30 });
const ROUND2_USAGE = Object.freeze({ input_tokens: 120, output_tokens: 12 });

/**
 * 第 1 发正常（一个工具调用 + usage），第 `hangOn` 发**永不返回**（这就是注入的静默），
 * 之后每一发正常收尾。`calls` / `requests` 让用例能数请求、看第二发带了什么。
 */
function createHangThenResumeProvider({ hangOn = 2 } = {}) {
  const requests = [];
  let calls = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests,
    get calls() {
      return calls;
    },
    async chat(request) {
      requests.push(request);
      calls += 1;
      if (calls === 1) {
        return {
          content: [{ type: "tool_use", id: "retry-1", name: "exec", input: { command: "true" } }],
          stopReason: "tool_use",
          usage: { ...ROUND1_USAGE },
        };
      }
      if (calls === hangOn) return new Promise(() => {});
      // 续跑这一发用**完成信号**收尾（引擎的 `completion.signals` 认它）⇒ run 在第 2 轮结束，
      // 用例才能把「请求次数」钉成一个确定值（否则引擎还要再跑几轮 no-tool 才收尾）。
      return {
        content: [{ type: "text", text: "重试后跑完了，任务已完成" }],
        stopReason: "end_turn",
        usage: { ...ROUND2_USAGE },
      };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  return provider;
}

/** 一直静默的 provider（每一发都不回）。 */
function createAlwaysSilentProvider() {
  const requests = [];
  return {
    protocol: "fake",
    model: "fake-model",
    requests,
    get calls() {
      return requests.length;
    },
    async chat(request) {
      requests.push(request);
      return new Promise(() => {});
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

function readJudgeLog(dir, session) {
  const path = join(dir, "outputs", safeRunId(session), "judge.log");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// ── ① 退避序列与双闸（纯函数，不需要跑 run）───────────────────────────────────────────
test("idle retry policy: exponential backoff with a budget gate and an attempt cap (issue #433 fix 1)", () => {
  // 退避序列：1s、2s、4s…，夹在 30s
  assert.equal(idleRetryBackoffMs(1), IDLE_RETRY_BASE_DELAY_MS);
  assert.equal(idleRetryBackoffMs(2), 2 * IDLE_RETRY_BASE_DELAY_MS);
  assert.equal(idleRetryBackoffMs(3), 4 * IDLE_RETRY_BASE_DELAY_MS);
  assert.equal(idleRetryBackoffMs(10), IDLE_RETRY_MAX_DELAY_MS);
  assert.equal(idleRetryBackoffMs(0), IDLE_RETRY_BASE_DELAY_MS, "非法下标按第一档处理");

  // 预算闸：0 预算 = 不重试（CLI 的 `--idle-retry-budget 0` 就是这个形状）
  assert.deepEqual(
    planIdleRetry({ retries: 0, elapsedMs: 0, budgetMs: 0 }),
    { retry: false, reason: "budget" },
  );
  // 预算用尽（含「刚好等于预算」）
  assert.deepEqual(
    planIdleRetry({ retries: 0, elapsedMs: 900_000, budgetMs: 900_000 }),
    { retry: false, reason: "budget" },
  );
  // 次数闸：与预算无关，先撞次数就停
  assert.deepEqual(
    planIdleRetry({
      retries: IDLE_RETRY_MAX_ATTEMPTS,
      elapsedMs: 0,
      budgetMs: 10 ** 9,
    }),
    { retry: false, reason: "max_attempts" },
  );
  // 正常：第 1 次重试退避 1s
  assert.deepEqual(
    planIdleRetry({ retries: 0, elapsedMs: 0, budgetMs: 900_000 }),
    { retry: true, backoffMs: 1_000, retryIndex: 1 },
  );
  // 剩余预算比指数退避小时，退避被剩余预算夹住（不会为负，也不会吃掉预算）
  assert.deepEqual(
    planIdleRetry({ retries: 3, elapsedMs: 7_400, budgetMs: 10_000 }),
    { retry: true, backoffMs: 2_600, retryIndex: 4 },
  );

  // 记账：次数 / 每次退避 / 累计 usage（被中止的每一发 + 最后成功那发都进总账）
  let clock = 0;
  const state = createIdleRetryState({
    budgetMs: 900_000,
    now: () => clock,
  });
  state.markKilled({ input_tokens: 10, output_tokens: 1 });
  const first = state.next();
  assert.equal(first.retry, true);
  state.recordBackoff(first.backoffMs);
  clock += first.backoffMs;
  state.markKilled({ input_tokens: 20, output_tokens: 2 });
  const second = state.next();
  state.recordBackoff(second.backoffMs);
  state.recordUsage({ input_tokens: 5, output_tokens: 3 });
  assert.deepEqual(state.snapshot(), {
    retries: 2,
    backoffMs: [1_000, 2_000],
    budgetMs: 900_000,
    maxAttempts: IDLE_RETRY_MAX_ATTEMPTS,
    elapsedMs: 1_000,
    usage: { input_tokens: 35, output_tokens: 6 },
  });

  // 默认预算就是 README / help 里那个数（900s）
  assert.equal(DEFAULT_IDLE_RETRY_BUDGET_SECONDS, 900);
});

// ── ② 注入静默 ⇒ 拿到重试并最终跑完；且续跑带着上一轮的账本 ────────────────────────────
test("chat: a silent first byte beyond the idle window is retried from the transcript and the run finishes (issue #433 fix 1)", { timeout: 60_000 }, async () => {
  const dir = await makeTmp("erix-cli-idle-retry-ok-");
  const session = "idle-retry-recovers";
  try {
    const provider = createHangThenResumeProvider({ hangOn: 2 });
    const idleLines = [];
    const result = await runChat({
      prompt: "跑一个工具然后静默",
      session,
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      idleTimeout: 1,
      // 预算给足（默认 900s 也行，这里显式写出来是为了让用例的意图一眼可见）
      idleRetryBudget: 60,
      maxRounds: 5,
      toolOutput: () => {},
      idleLog: (line) => idleLines.push(line),
    });

    // 判据（工单原文）：run 必须以「拿到重试并最终跑完」结束，**不是** `idle_timeout`。
    assert.match(result.finalText, /重试后跑完了/u);
    assert.notEqual(result.termination?.reason, "aborted");
    assert.equal(provider.calls, 3, "1 发工具轮 + 1 发静默（判死）+ 1 发续跑");

    // 续跑**不是**重跑：第二发请求里带着第一轮已落盘的工具结果（同一 runId 的账本被接回来）。
    const resumed = provider.requests[2];
    const toolResultIds = (resumed?.messages ?? [])
      .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result")
      .map((block) => block.tool_use_id);
    assert.ok(
      toolResultIds.includes("retry-1"),
      `续跑必须带着上一轮已落盘的工具结果，实测 tool_result ids=${JSON.stringify(toolResultIds)}`,
    );
    // 轮号是**身份**轮号、跨 resume 单调递增：第一轮真的跑过，续跑从第 2 轮接着来。
    assert.equal(result.rounds, 2);

    // 记账（终局载荷）：重试次数 / 退避 / 累计 usage（两发都算）
    assert.ok(result.idleRetry, "成功路径也必须有重试记账（result.idleRetry）");
    assert.equal(result.idleRetry.retries, 1);
    assert.deepEqual(result.idleRetry.backoffMs, [IDLE_RETRY_BASE_DELAY_MS]);
    assert.equal(result.idleRetry.budgetMs, 60_000);
    assert.deepEqual(result.idleRetry.usage, {
      input_tokens: ROUND1_USAGE.input_tokens + ROUND2_USAGE.input_tokens,
      output_tokens: ROUND1_USAGE.output_tokens + ROUND2_USAGE.output_tokens,
    });
    assert.equal(result.idleRetry.exhausted, undefined);

    // 记账（事件流）：judge.log 里有 backoff 与 recovered 两条 idle_retry 记录
    const retryEvents = readJudgeLog(dir, session).filter((record) => record.type === "idle_retry");
    const backoff = retryEvents.filter((record) => record.phase === "backoff");
    assert.equal(backoff.length, 1, JSON.stringify(retryEvents));
    assert.equal(backoff[0].retryIndex, 1);
    assert.equal(backoff[0].backoffMs, IDLE_RETRY_BASE_DELAY_MS);
    assert.equal(backoff[0].idleSeconds, 1);
    assert.ok(retryEvents.some((record) => record.phase === "recovered"));
    // 退避序列与重试次数从事件里读得出来（验收原文）
    assert.equal(retryEvents.at(-1).retries, 1);
    assert.deepEqual(retryEvents.at(-1).backoffMs, [IDLE_RETRY_BASE_DELAY_MS]);

    // 人可见的那两行（stderr 日志）也在
    assert.ok(
      idleLines.some((line) => /第 1 次重试/u.test(line) && /退避 1000ms/u.test(line)),
      JSON.stringify(idleLines),
    );
    assert.ok(
      idleLines.some((line) => /idle 重试后跑完/u.test(line)),
      JSON.stringify(idleLines),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ③ 的时间余量派生（issue #500）──────────────────────────────────────────────────
//
// 病根（实测）：③ 那一格原本写死「预算 1s + idle 1s」。预算 `1000ms` 与第一次退避的基档
// `IDLE_RETRY_BASE_DELAY_MS = 1000ms` **恰好相等** ⇒ `planIdleRetry` 的
// `backoffMs = min(基档, budgetMs - elapsedMs)` 只剩 0ms 余量：`markKilled()` 与 `next()` 之间
// 被调度器抢一次，`elapsedMs` 就是 1 ⇒ 记账里的退避是 999，`backoffMs === [1000]` 红。
// 实测：72 个 busy loop（2× 36 核）下单文件连跑 4 轮，3 轮红，实测值 997 / 998 / 993；
// 空闲时 2000 次采样只有 5 次 `elapsedMs = 1`（0.25%）。全量并发下约 14%（issue #500 台账）。
//
// 改法（照 PR #442 的先例）：窗口不写死，改成**当场实测派生**——
//   ① 探针走**生产同一条**代码路径（`createIdleRetryState` 默认 `now = Date.now`，与 `runChat`
//      里那一份逐字同形）量「`markKilled()` → `next()` 吃掉多少预算」，1 次 warmup + 5 个样本
//      取**最差**值（尾部才是负载下先坏的那段）；
//   ② 由实测值推出整秒档的窗口：`idleRetryBudget` / `idleTimeout` 在 CLI 上是**整秒**
//      （`parseIntegerOption`），所以派生值也量化到整秒——CLI 能产出的形状才是被测的形状。
//      基档 1s 时最小的「退避不被夹」的整秒预算就是 2s；预算 2s 又要求 idle 窗口也到 2s，
//      否则第二发判死时「已用」还不到预算，停下的原因会从 `budget` 漂成 `max_attempts`。
//      两个数都是量出来的（机器更慢时它们会抬档，抬过头则判红，见守卫②），不是拍出来的。
//   ③ 三条守卫全部是**判红**，不是悄悄放行：
//      守卫①（探针）：探针没量到决策 / 样本不足 ⇒ 红。没有实测就不许派生（0 会让余量塌成 0，
//        也就是本格要根治的那个病）。
//      守卫②（派生值自检）：实测值必须是有限非负数、且派生出来的两个窗口都在上限内——机器慢到
//        整秒断言失去意义时判红，而不是把窗口抬到天上去假装没事。
//        ⚠ 只留**能真变红**的自检：「派生值 ≥ 下限」「派生值 ≥ 系数 × 实测」这种同一对常量同一个
//        表达式写出来的断言是**恒真**的（PR #442 评审实测过：#412 把 ×8 改成 ×1、floor 60 改成
//        floor 1，全套仍绿）⇒ 那条契约改由下面的**字面量用例**钉住（取值写死，改系数/下限就红）。
//      守卫③（本次 run 的前提）：`judge.log` 里那条 `phase: "backoff"` 记账带着**这一次**决策时
//        的 `elapsedMs`，它必须 ≤ 派生出来的余量（`预算 - 基档`）——即「预算真的容得下整个基档退避」
//        这件事在**这一轮**成立，而不只是探针那一轮。这一条是「早就跑过去了」与「压根没余量」的
//        分水岭：余量被吃穿时它点名机器此刻的调度延迟，而不是让下面那条下限断言红成一个谜。
//
// 禁止项（issue #500 写死）：不放宽断言（`backoffMs` 仍逐字等于基档）、不加 `{ timeout }`、不标 skip。

/** 派生余量对实测值的倍数（与 #412 的 RTT 派生同一口径：尾部才是负载下先坏的那段）。 */
const RETRY_WINDOW_SLOP_FACTOR = 8;
/**
 * 派生余量的下限（毫秒）：`Date.now()` 的粒度是 1ms，空转时实测常为 0——下限保证「量到 0」不会
 * 把余量塌成 0（那正是 #500 的病）。250ms = 基档的 1/4，同时 < 1000ms，所以整秒量化不会把它推到下一档。
 */
const RETRY_WINDOW_MARGIN_FLOOR_MS = 250;
/** 派生窗口的上限（秒）：超过它就不是「这台机器此刻的调度延迟」，而是「这台机器做不了整秒断言」⇒ 判红。 */
const RETRY_WINDOW_CEILING_SECONDS = 5;
/** 探针的 warmup / 样本数（与 #412 同形：丢掉冷启动，取 5 个样本的最差值）。 */
const RETRY_WINDOW_PROBE_WARMUPS = 1;
const RETRY_WINDOW_PROBE_SAMPLES = 5;

/**
 * 探针：量「`markKilled()` → `next()`」这一步吃掉多少预算（毫秒），返回**最差的一次**与全部样本。
 *
 * 走的是生产同一条代码路径：`runChat` 里那份 `createIdleRetryState({ budgetMs })` 用的就是默认
 * `now = Date.now`，这里一个参数都不换（换成 `performance.now()` 会量到亚毫秒，那是另一个问题）。
 * 预算给默认值：只要没撞预算，`next()` 就必然返回 `retry: true`，探针才有东西可量。
 *
 * @returns {{worstSlopMs: number, samplesMs: number[]}}
 */
function measureDecisionSlopMs({
  warmups = RETRY_WINDOW_PROBE_WARMUPS,
  samples = RETRY_WINDOW_PROBE_SAMPLES,
} = {}) {
  const measured = [];
  for (let i = 0; i < warmups + samples; i += 1) {
    const state = createIdleRetryState({ budgetMs: DEFAULT_IDLE_RETRY_BUDGET_SECONDS * 1000 });
    // 与 `bin/cli.js` 的调用点同形：判死时把这一发的 usage 记进去，然后问「还能不能再试」。
    state.markKilled({ input_tokens: 1, output_tokens: 1 });
    const decision = state.next();
    // 守卫①：探针自己没量到决策 ⇒ 立刻红。宁可这一格红着并说明「这台机器量不出来」，
    // 也绝不拿一个残缺样本去派生窗口。
    assert.equal(decision.retry, true,
      `窗口探针第 ${i + 1} 次没给出可重试的决策（${JSON.stringify(decision)}）：探针路径断了，量不出调度延迟就不许派生窗口`);
    assert.ok(Number.isFinite(decision.elapsedMs) && decision.elapsedMs >= 0,
      `窗口探针第 ${i + 1} 次量到的 elapsedMs 不是有限非负数（${decision.elapsedMs}）：没有实测就不许派生窗口`);
    if (i >= warmups) measured.push(decision.elapsedMs);
  }
  assert.equal(measured.length, samples,
    `窗口探针只量到 ${measured.length}/${samples} 个样本：样本不足即判红（不允许用残缺样本派生窗口）`);
  return { worstSlopMs: Math.max(...measured), samplesMs: measured };
}

/**
 * 由实测的调度延迟推出③那一格要用的**整秒**窗口（`idleTimeout` 与 `idleRetryBudget`）。
 *
 * 两条前提都由构造保证，而不是由「这台机器此刻恰好有多快」保证：
 *  - P1「第一次退避不被预算夹」：`budgetMs - 实测延迟 ≥ 基档`（余量 = 实测 × 8，下限 250ms）；
 *  - P2「第二发判死后预算一定用尽」：`基档 + idle 窗口 ≥ budgetMs`（否则停下的原因会漂成
 *    `max_attempts`，那一格钉的就不是预算闸了）。
 *
 * 两个数都量化到整秒（CLI 的唯一形状），所以余量里还含有量化带来的那部分——它只会让 P1/P2 更宽，
 * 不会更窄。守卫②在这里：只有**能真变红**的自检才留下（见段首注释）。
 *
 * @param {{worstSlopMs: number, samplesMs: number[]}} measurement
 * @returns {{marginMs: number, budgetSeconds: number, idleSeconds: number}}
 */
function deriveRetryWindow({ worstSlopMs, samplesMs }) {
  assert.ok(Number.isFinite(worstSlopMs) && worstSlopMs >= 0,
    `实测调度延迟不是有限非负数（${worstSlopMs}，样本 ${JSON.stringify(samplesMs)}）：没有实测就不许派生窗口`);
  const marginMs = Math.max(RETRY_WINDOW_MARGIN_FLOOR_MS, Math.ceil(worstSlopMs * RETRY_WINDOW_SLOP_FACTOR));
  const budgetSeconds = Math.ceil((IDLE_RETRY_BASE_DELAY_MS + marginMs) / 1000);
  const idleSeconds = Math.ceil((budgetSeconds * 1000 - IDLE_RETRY_BASE_DELAY_MS + marginMs) / 1000);
  // 守卫②（上界这一半真能变红：机器慢到需要 > 上限的窗口时，整秒断言已经没意义）。
  assert.ok(budgetSeconds <= RETRY_WINDOW_CEILING_SECONDS && idleSeconds <= RETRY_WINDOW_CEILING_SECONDS,
    `派生窗口 ${idleSeconds}s idle / ${budgetSeconds}s 预算超过了上限 ${RETRY_WINDOW_CEILING_SECONDS}s`
    + `（实测调度延迟 ${worstSlopMs}ms，样本 ${JSON.stringify(samplesMs)}）：这台机器此刻慢到整秒断言失去意义，`
    + "判红，而不是把窗口抬上去假装没事");
  return { marginMs, budgetSeconds, idleSeconds };
}

/**
 * 守卫③：**本次 run** 的前提——预算真的容得下整个基档退避（余量没被调度延迟吃穿）。
 *
 * 抽成函数是为了反向证能直接喂坏现场（同一份判据必须能红）；它只证前提，不证结论：
 * 「记账里的退避逐字等于基档」仍由用例本体那条断言钉着。
 *
 * @param {{firstDecisionElapsedMs: number, budgetSeconds: number}} input
 */
function assertRetryHeadroomHeld({ firstDecisionElapsedMs, budgetSeconds }) {
  const headroomMs = budgetSeconds * 1000 - IDLE_RETRY_BASE_DELAY_MS;
  assert.ok(Number.isFinite(firstDecisionElapsedMs) && firstDecisionElapsedMs >= 0,
    `judge.log 里那次退避决策的 elapsedMs 不是有限非负数（${firstDecisionElapsedMs}）：量不到就不算绿`);
  assert.ok(firstDecisionElapsedMs <= headroomMs,
    `第一次退避决策时已用 ${firstDecisionElapsedMs}ms > 派生余量 ${headroomMs}ms（预算 ${budgetSeconds}s − 基档`
    + ` ${IDLE_RETRY_BASE_DELAY_MS}ms）：这台机器此刻的调度延迟已经超出本格前提，`
    + "下面那条「退避逐字等于基档」的断言不再承重（判红，不算绿）");
}

// 守卫②的正身（#500 交付判据）：「× 8 / 下限 250ms / 上限 5s」这条契约用**字面量**钉住。
// 三条都直接调 `deriveRetryWindow`，不经过任何实测值，因此不随常量漂移。
test("派生契约（#500 守卫②）：实测 0ms ⇒ 余量落到下限 250ms ⇒ 2s idle / 2s 预算", () => {
  // 下限若被拿掉（0 × 8 = 0）⇒ 预算塌成 1s、idle 窗口塌成 0s ⇒ 这条红。
  assert.deepEqual(
    deriveRetryWindow({ worstSlopMs: 0, samplesMs: [0, 0, 0, 0, 0] }),
    { marginMs: RETRY_WINDOW_MARGIN_FLOOR_MS, budgetSeconds: 2, idleSeconds: 2 },
  );
});

test("派生契约（#500 守卫②）：实测 200ms ⇒ 余量 1600ms（× 8）⇒ 4s idle / 3s 预算", () => {
  // 倍数若被改成 ×1（余量 = max(250, 200) = 250）⇒ 2s/2s ⇒ 这条红；量化那一步也一并钉住。
  assert.deepEqual(
    deriveRetryWindow({ worstSlopMs: 200, samplesMs: [150, 200, 180, 170, 160] }),
    { marginMs: 1_600, budgetSeconds: 3, idleSeconds: 4 },
  );
});

test("派生契约（#500 守卫②）：实测慢到窗口超过上限 ⇒ 判红（不把窗口抬上去假装没事）", () => {
  assert.throws(
    () => deriveRetryWindow({ worstSlopMs: 1_200, samplesMs: [1_200, 900, 800, 700, 600] }),
    /超过了上限 5s/,
    "机器慢到需要 > 5s 的窗口时仍然返回了一个数：守卫② 的上界没咬住",
  );
});

// 守卫③ 的反向证：同一份前提判据喂给「余量被吃穿」的坏现场，必须红。
test("[反向证] 守卫③：本次 run 的调度延迟吃穿余量时必须红（#500）", () => {
  // 正样本：2s 预算 − 1s 基档 = 1000ms 余量，实测 1ms 远在余量内。
  assertRetryHeadroomHeld({ firstDecisionElapsedMs: 1, budgetSeconds: 2 });
  // 坏现场：同一份判据必须抓住「已用 > 余量」。
  assert.throws(
    () => assertRetryHeadroomHeld({ firstDecisionElapsedMs: 1_001, budgetSeconds: 2 }),
    /调度延迟已经超出本格前提/,
    "前提判据没有抓住「余量被吃穿」——守卫③ 又变回橡皮章了",
  );
});

// ── ③ 预算用尽 ⇒ 落 idle_timeout 终局，且 #440 的四件载荷仍在、顶层 partial 仍不存在 ─────────
test("chat: a permanently silent upstream exhausts the retry budget and still lands on idle_timeout with the payload (issue #433 fix 1)", { timeout: 60_000 }, async (t) => {
  const dir = await makeTmp("erix-cli-idle-retry-budget-");
  const session = "idle-retry-exhausted";
  try {
    // issue #500：窗口**当场实测派生**（探针 → 守卫①② → 整秒窗口），不再写死「1s / 1s」那个
    // 零余量的巧合。派生值随机器走：空闲机器上是 2s idle / 2s 预算（基档 1s 时最小的「退避不被夹」
    // 的整秒档），慢机器上抬档，抬过头则守卫② 判红。
    const measurement = measureDecisionSlopMs();
    const { marginMs, budgetSeconds, idleSeconds } = deriveRetryWindow(measurement);
    const provider = createAlwaysSilentProvider();
    const idleLines = [];
    let error;
    try {
      await runChat({
        prompt: "永不返回",
        session,
        dir,
        notesDir: join(dir, "notes"),
        skillsDir: join(dir, "skills"),
        configPath: await writeEmptyMcpConfig(dir),
        provider,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        idleTimeout: idleSeconds,
        // 预算 = 基档 + 实测余量（整秒档）：第一发判死后退避 1s 仍在预算内（退避**不被夹**，这正是
        // 本格要钉的那件事），续跑那一发再判死时「已用」≈ 基档 + idle 窗口 > 预算 ⇒ 落终局。
        idleRetryBudget: budgetSeconds,
        maxRounds: 3,
        toolOutput: () => {},
        idleLog: (line) => idleLines.push(line),
      });
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, "预算用尽的 run 必须抛错，不许静默返回");
    assert.equal(error.code, "idle_timeout");
    assert.equal(error.name, "IdleTimeoutError");
    // 真的重试过（不是「预算 0」那种直接落终局）：1 次重试 = 2 发
    assert.equal(provider.calls, 2);

    // #440 的四件载荷仍在（预算用尽只是「不再重试」，判别面与载荷面一字不改）
    assert.notEqual(error.termination, undefined);
    assert.notEqual(error.usage, undefined);
    assert.notEqual(error.rounds, undefined);
    assert.notEqual(error.finalText, undefined);
    assert.equal(error.termination.reason, "aborted");
    assert.equal(error.termination.partial, true);
    assert.equal(error.termination.usage, error.usage);
    // 契约里**没有**顶层 `partial`（标记位是 termination.partial）
    assert.equal(Object.prototype.hasOwnProperty.call(error, "partial"), false);

    // 记账：为什么停（budget）、重试了几次、退避多少
    assert.ok(error.idleRetry, "终局也必须带重试记账（error.idleRetry）");
    assert.equal(error.idleRetry.exhausted, "budget");
    assert.equal(error.idleRetry.retries, 1);
    assert.equal(error.idleRetry.budgetMs, budgetSeconds * 1000);
    assert.equal(error.idleRetry.maxAttempts, IDLE_RETRY_MAX_ATTEMPTS);

    // 事件流：exhausted 那条写清了原因
    const retryEvents = readJudgeLog(dir, session).filter((record) => record.type === "idle_retry");
    const exhausted = retryEvents.find((record) => record.phase === "exhausted");
    assert.ok(exhausted, JSON.stringify(retryEvents));
    assert.equal(exhausted.reason, "budget");
    assert.equal(exhausted.retries, 1);

    // 守卫③：**本次 run** 的前提——预算真的容得下整个基档退避。`judge.log` 里那条 backoff 记账
    // 带着这一次决策时的 `elapsedMs`（服务端侧一样的事后事实：记的是当时真的用了多少），它必须落在
    // 派生余量（预算 − 基档）内。余量被吃穿时它点名「机器此刻的调度延迟」，而不是让下面那条断言
    // 红成一个谜（#500 之前的现场就是那样：只看到 999 ≠ 1000）。
    const backoffEvent = retryEvents.find((record) => record.phase === "backoff");
    assert.ok(backoffEvent, `judge.log 里没有 backoff 记账：${JSON.stringify(retryEvents)}`);
    assertRetryHeadroomHeld({ firstDecisionElapsedMs: backoffEvent.elapsedMs, budgetSeconds });
    t.diagnostic(`窗口派生（#500）：探针样本 ${JSON.stringify(measurement.samplesMs)}ms（最差 ${measurement.worstSlopMs}ms）`
      + ` ⇒ 余量 ${marginMs}ms ⇒ idle ${idleSeconds}s / 预算 ${budgetSeconds}s；本次 run 的第一次退避决策`
      + ` elapsedMs=${backoffEvent.elapsedMs}ms（余量 ${budgetSeconds * 1000 - IDLE_RETRY_BASE_DELAY_MS}ms）`
      + ` ⇒ 记账退避 ${error.idleRetry.backoffMs.join(",")}ms`);

    // 主判据（一字未放宽）：预算容得下基档 ⇒ 记账里的退避**逐字等于**基档，不是被夹出来的尾数。
    assert.deepEqual(
      error.idleRetry.backoffMs,
      [IDLE_RETRY_BASE_DELAY_MS],
      `退避被预算夹住了（预算 ${budgetSeconds}s、派生余量 ${marginMs}ms、`
      + `探针样本 ${JSON.stringify(measurement.samplesMs)}ms）：本格钉的是「退避不被夹 + 预算用尽」，`
      + "不是「记账里有个接近 1000 的数」",
    );

    assert.ok(
      idleLines.some((line) => new RegExp(`预算 ${budgetSeconds}s 用尽`, "u").test(line)),
      JSON.stringify(idleLines),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ④ 预算 0 = 完全不重试（既有 #440 行为逐字保留：1 发、idle_timeout） ────────────────────
test("chat: --idle-retry-budget 0 disables the retry path entirely (issue #433 fix 1)", { timeout: 30_000 }, async () => {
  const dir = await makeTmp("erix-cli-idle-retry-off-");
  try {
    const provider = createAlwaysSilentProvider();
    const configPath = await writeEmptyMcpConfig(dir);
    const idleLines = [];
    await assert.rejects(
      () => runChat({
        prompt: "永不返回",
        session: "idle-retry-off",
        dir,
        notesDir: join(dir, "notes"),
        skillsDir: join(dir, "skills"),
        configPath,
        provider,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        idleTimeout: 1,
        idleRetryBudget: 0,
        maxRounds: 2,
        toolOutput: () => {},
        // issue #456：这一格原本传 `idleLog: () => {}`，**结构上观测不到 stderr**——「预算 0 还多打一行」
        // 在这棵树里既断不到也证不伪。换成收集数组，与同文件另外三格同形。
        idleLog: (line) => idleLines.push(line),
      }),
      (error) => {
        assert.equal(error?.code, "idle_timeout");
        assert.equal(error?.idleRetry?.exhausted, "budget");
        assert.equal(error?.idleRetry?.retries, 0);
        return true;
      },
    );
    assert.equal(provider.calls, 1, "预算 0 ⇒ 不重试，只发 1 发");
    // issue #456：逃生阀的形状必须等于 #433 之前——**一行重试行都不打**。
    // 只筛含「重试」的行（不断 stderr 全空）：`idleTimeout: 1` 时 exec 天花板那一格本就有自己的日志。
    assert.deepEqual(
      idleLines.filter((line) => /重试/u.test(line)),
      [],
      JSON.stringify(idleLines),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
