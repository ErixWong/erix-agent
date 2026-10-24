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

// ── ③ 预算用尽 ⇒ 落 idle_timeout 终局，且 #440 的四件载荷仍在、顶层 partial 仍不存在 ─────────
test("chat: a permanently silent upstream exhausts the retry budget and still lands on idle_timeout with the payload (issue #433 fix 1)", { timeout: 60_000 }, async () => {
  const dir = await makeTmp("erix-cli-idle-retry-budget-");
  const session = "idle-retry-exhausted";
  try {
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
        idleTimeout: 1,
        // 预算 1s、idle 1s ⇒ 第一发判死后退避 1s 就把预算用完 ⇒ 续跑一发、再判死就落终局。
        idleRetryBudget: 1,
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
    assert.deepEqual(error.idleRetry.backoffMs, [IDLE_RETRY_BASE_DELAY_MS]);
    assert.equal(error.idleRetry.budgetMs, 1_000);
    assert.equal(error.idleRetry.maxAttempts, IDLE_RETRY_MAX_ATTEMPTS);

    // 事件流：exhausted 那条写清了原因
    const retryEvents = readJudgeLog(dir, session).filter((record) => record.type === "idle_retry");
    const exhausted = retryEvents.find((record) => record.phase === "exhausted");
    assert.ok(exhausted, JSON.stringify(retryEvents));
    assert.equal(exhausted.reason, "budget");
    assert.equal(exhausted.retries, 1);
    assert.ok(
      idleLines.some((line) => /预算 1s 用尽/u.test(line)),
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
        idleLog: () => {},
      }),
      (error) => {
        assert.equal(error?.code, "idle_timeout");
        assert.equal(error?.idleRetry?.exhausted, "budget");
        assert.equal(error?.idleRetry?.retries, 0);
        return true;
      },
    );
    assert.equal(provider.calls, 1, "预算 0 ⇒ 不重试，只发 1 发");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
