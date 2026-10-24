// issue #433 T0 / #441：idle 看门狗与「静默可重试」的回归钉子。
//
// 覆盖四件事：
//   ① 工具执行期喂表（长命令不再被静默窗口打死）；
//   ② repl 侧的**同型**用例（防只改一处——双实现正是本单要消的缺陷）；
//   ③ 单份实现的语义钉子（`null` 三态、判死单向、abort 无自定义 reason）；
//   ④ **流式静默走可重试通道**（issue #441）：`--stream` 的静默上游不再被 idle 打死，而是落到 provider 的
//      **流式相位截止**上（`KitError("timeout", …, {retryable:true})`）⇒ 真的重试（≥2 发、且**有界**：
//      ≤ attempts+1）⇒ 重试用尽后 `failed` + `errorCode:"timeout"`。
//      另有两格是**有意保留**的反向护栏：① **非流式**静默今天**仍不可重试**（截止保持 legacy，等 #433
//      fix 1）⇒ 1 发 / `idle_timeout`；② 宿主注入的 hang provider **没有任何**可重试截止 ⇒ 看门狗照旧咬。
//      「非流式为什么不派生」的实测因果见 bin/provider-timeouts.js 头注释第 3 条。
//
// 纪律：全部用例**事件驱动**，不写「先 sleep N 毫秒再断言耗时」那种断言——本机可能高负载，
// 固定 sleep 只会变成 flaky。慢的那一侧是**被测行为本身**（一条 1.5s 的命令 / 一个永不返回的
// provider），断言的是「run 有没有被 idle 打死」这个事件。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runChat } from "../bin/cli.js";
import { runRepl } from "../bin/repl.js";
import {
  DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_REPL_IDLE_TIMEOUT_SECONDS,
  EXEC_CEILING_FLOOR_MS,
  EXEC_CEILING_MARGIN_MS,
  createIdleTimeout,
  execCeilingMsForIdle,
  toolHeartbeatCapMs,
  toolHeartbeatIntervalMs,
  withToolHeartbeat,
} from "../bin/idle.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

// issue #81：runChat / runRepl 的 MCP 代理默认解析 ~/.erix/mcp.json（可能配了真实远端 server）。
// 每个用例注入空配置，彻底与真实 home 隔离。
async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

/** 一个**永不返回**的 provider（宿主注入，**没有任何 provider 侧截止**）：用来证明看门狗还咬得住。 */
function createHangingProvider() {
  const calls = [];
  return {
    protocol: "fake",
    model: "fake-model",
    calls,
    async chat(request) {
      calls.push(request);
      return new Promise(() => {});
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

test("idle watchdog keeps its single-shot semantics after moving to bin/idle.js (issue #433 T0)", async () => {
  // 非正整数（含 0 = 不启用）⇒ null：调用方靠 `idle?.` 全套短路，行为与搬迁前一致。
  assert.equal(createIdleTimeout(0), null);
  assert.equal(createIdleTimeout(-3), null);
  assert.equal(createIdleTimeout(1.5), null);
  assert.equal(createIdleTimeout("5"), null);

  const idle = createIdleTimeout(1);
  assert.equal(idle.seconds, 1);
  assert.equal(idle.timedOut(), false);
  // 事件驱动：等 abort 事件，不靠 sleep 断言「1 秒到了」。
  await new Promise((resolve) => {
    idle.controller.signal.addEventListener("abort", resolve, { once: true });
  });
  assert.equal(idle.timedOut(), true);
  // 判死**单向**：置真之后 touch() 不会复活（本刀不改这条；加重试属 #441）。
  idle.touch();
  assert.equal(idle.timedOut(), true);
  // abort 不带自定义 reason（Node 的缺省 DOMException AbortError，不是我们造的对象）。
  assert.equal(idle.controller.signal.reason?.name, "AbortError");
  idle.dispose();
});

test("idle window / exec ceiling / heartbeat intervals are one口径 (issue #433 T0)", () => {
  // 默认值仍是一份：chat 300s、repl 0（不启用）
  assert.equal(DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS, 300);
  assert.equal(DEFAULT_REPL_IDLE_TIMEOUT_SECONDS, 0);

  // 天花板 = idle − 60s，下限 30s；idle 未启用 ⇒ null（不钳）
  assert.equal(execCeilingMsForIdle(300), 300_000 - EXEC_CEILING_MARGIN_MS);
  assert.equal(execCeilingMsForIdle(120), 60_000);
  assert.equal(execCeilingMsForIdle(90), EXEC_CEILING_FLOOR_MS);
  assert.equal(execCeilingMsForIdle(0), null);
  assert.equal(execCeilingMsForIdle(-1), null);

  // 喂表间隔 = idle/4，夹在 [250ms, 30s]
  assert.equal(toolHeartbeatIntervalMs(1), 250);
  assert.equal(toolHeartbeatIntervalMs(2), 500);
  assert.equal(toolHeartbeatIntervalMs(300), 30_000);
  // 喂表上限 = exec 天花板（所以「工具执行期」不是无界静默窗口）
  assert.equal(toolHeartbeatCapMs(300), 240_000);
  assert.equal(toolHeartbeatCapMs(1), EXEC_CEILING_FLOOR_MS);
});

// ①' 喂表是**有界**的（issue #433 fix 3 的另一半，工单只写了「持续喂」）：
// 到上限就停止喂表、静默窗口重新开始计时 ⇒ **永久挂住的工具仍然会被看门狗收掉**。
// 没有这一条，fix 3 会把 fix 1 变成「永不判死」——一个 never-settling 的工具可以让整个 run 永远活着。
//
// 为什么在单元层钉、不跑 31s 的 CLI 级用例：缺省上限是 `toolHeartbeatCapMs(idle.seconds)`，它有
// 30s 下限（`EXEC_CEILING_FLOOR_MS`），`idle=1` 时挂住的工具要 ~31s 才会被收掉——那会让全量套件
// 的墙钟翻倍。所以这里注入 `capMs: 600` 走**同一条**代码路径（上限判据、停喂、日志都在里面）。
//
// ⚠️ 这一格单独**不承重**装配处（issue #433 评审必修 3-B）：把 `bin/idle.js` 装配处的
// `: toolHeartbeatCapMs(idle.seconds)` 改成 `: Infinity` 时，这里注入的显式 `capMs: 600` 走不到
// 缺省分支 ⇒ 本格照旧绿。承重的是下面 T0 的 CLI 级那一格：它在**真实装配**（`idle=1`、不传
// `capMs`）下断言 `[idle-heartbeat] … 上限 …ms` 里的上限 == `toolHeartbeatCapMs(1)`。
// 另一个纪律：本格给 `{ timeout: 5_000 }`——把上限判据（`Date.now() - startedAt >= capMs`）变异成
// `false` 时，工具永不 settle、喂表永不停，**没有超时就会把整个套件钉 300s 挂死**（不是红）。
test("withToolHeartbeat: feeding is bounded, so a tool that never returns is still collected (issue #433 fix 3)", { timeout: 5_000 }, async () => {
  const idle = createIdleTimeout(1);
  const lines = [];
  let touched = 0;
  const observed = {
    seconds: idle.seconds,
    touch: () => {
      touched += 1;
      idle.touch();
    },
  };
  // 工具永久挂住：与被挂住的 exec 一样，这个 promise 永不 settle。
  withToolHeartbeat(observed, () => new Promise(() => {}), {
    label: "exec",
    log: (line) => lines.push(line),
    capMs: 600,
  });
  await new Promise((resolve) => {
    idle.controller.signal.addEventListener("abort", resolve, { once: true });
  });
  assert.equal(
    idle.timedOut(),
    true,
    "喂表到上限后必须停止喂表——否则一个永久挂住的工具会让看门狗永远不响（fix 3 把 fix 1 变成永不判死）",
  );
  assert.ok(touched >= 1, `上限之前必须真的喂过表（实测 ${touched} 次）`);
  assert.ok(
    lines.some((line) => /执行期喂表已到上限 600ms，停止喂表/u.test(line)),
    `必须留下「停止喂表」的可观测证据：${JSON.stringify(lines)}`,
  );
  idle.dispose();
});

// ① 工具执行期喂表：一条**比 idle 窗口长 1.5 倍**的命令不许把 run 打死。
// 先红后绿的方式见工单报告（把 cli.js 的 executeTool 包装还原成「await 之后再 touch」⇒ 本格红）。
test("chat: a tool that outlives the idle window does not kill the run (issue #433 T0)", async () => {
  const dir = await makeTmp("erix-cli-idle-tool-");
  try {
    const provider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "slow-1", name: "exec", input: { command: "sleep 1.5" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
    ]);
    const idleLines = [];
    const result = await runChat({
      prompt: "跑一条慢命令",
      session: "idle-tool-run",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      // 1 秒窗口 vs 1.5 秒工具：修前必然在工具执行期到点打死整个 run（IdleTimeoutError）。
      idleTimeout: 1,
      maxRounds: 2,
      toolOutput: () => {},
      idleLog: (line) => idleLines.push(line),
    });

    // run 跑完了两轮（工具轮 + 终稿轮），没有以 aborted / idle 结束
    assert.equal(provider.requests.length, 2);
    assert.equal(result.rounds, 2);
    assert.notEqual(result.termination?.reason, "aborted");
    // issue #433 fix 3 的验收原文：「日志里能看到工具执行期间喂过计时器的行」。
    // 断言的是**真的喂过**（N > 0 且点名 exec），不是「日志里有 idle-heartbeat 这个词」。
    const heartbeat = idleLines.find((line) => (
      /^\[idle-heartbeat\] exec：执行期喂过 idle 计时器 (\d+) 次/u.test(line)
    ));
    assert.ok(
      heartbeat,
      `工具执行期喂表必须留下可观测证据，实测日志：${JSON.stringify(idleLines)}`,
    );
    assert.ok(
      Number(/喂过 idle 计时器 (\d+) 次/u.exec(heartbeat)[1]) >= 1,
      `喂表次数必须 ≥ 1：${heartbeat}`,
    );
    // issue #433 评审必修 3-B：**接线承重**。这格走的是真实装配（`bin/cli.js` 不传 `capMs` ⇒
    // 缺省分支 `toolHeartbeatCapMs(idle.seconds)`），所以日志里的「上限」必须就是那个值。
    // 把装配处换成 `: Infinity`（或把 `toolHeartbeatCapMs` 改成返回 `Infinity`）⇒ 这里必红；
    // 而注入 `capMs: 600` 的单元格永远看不见缺省分支，钉不住这件事。
    const loggedCap = /上限 (\d+)ms/u.exec(heartbeat);
    assert.ok(loggedCap, `喂表日志必须带上生效的上限（接线证据）：${heartbeat}`);
    assert.equal(
      Number(loggedCap[1]),
      toolHeartbeatCapMs(1),
      `日志里的上限必须等于 toolHeartbeatCapMs(idle.seconds)（idle=1 ⇒ ${toolHeartbeatCapMs(1)}ms），实测：${heartbeat}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ③ repl 侧同型用例：双实现被消掉之后，两边必须是同一份行为（只改 cli 一处会让这条红）。
test("repl: a tool that outlives the idle window does not kill the round (issue #433 T0)", async () => {
  const home = await makeTmp("erix-repl-idle-tool-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  try {
    const session = "repl-idle-window";
    const provider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "slow-1", name: "exec", input: { command: "sleep 1.5" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
    ]);
    const run = runRepl(
      [
        "--config", await writeEmptyMcpConfig(home),
        "--session", session,
        "--idle-timeout", "1",
      ],
      {
        input,
        output,
        home,
        notesDir: join(home, "notes"),
        sessionDir: join(home, ".erix"),
        config: { model: "fake-model", maxOutputTokens: 1000 },
        providerFactory: () => provider,
      },
    );
    input.end("跑一条慢命令\n/exit\n");
    await run;

    const text = chunks.join("");
    // 修前这里是「任务 1 秒无进展，已中止」；修后这一轮正常跑完并落盘
    assert.doesNotMatch(text, /无进展/u);
    assert.equal(provider.calls.length, 2);
    assert.ok(
      existsSync(join(home, ".erix", `${session}.json`)),
      "这一轮应当正常跑完并写会话存档（被打死的轮不会 saveSession）",
    );
  } finally {
    input.destroy();
    output.destroy();
    await rm(home, { recursive: true, force: true });
  }
});

// ④ **流式**静默 → 可重试通道（issue #441）；**非流式**静默 → 仍不可重试（有意，等 #433 fix 1）。
//
// 历史：#433 那条护栏断言「同一条永不返回的上游只发 1 发、终局 `idle_timeout`」。接线后这条断言只对
// **流式**不再成立（`firstByteTimeoutMs = ⌊idle×3/4⌋` 严格小于 idle 窗口 ⇒ 可重试）。非流式**故意保持**
// 原样：非流式的「请求时间」量的是**整段生成时间**，把它的截止派生成 `⌊idle×3/4⌋` 会把默认配置下
// `[225s, 300s)` 这条以前**活的**带变成必死带（评审实测：240s 的健康请求接线前 `end_turn` / 240.29s，
// 派生后 225.21s 被杀成 `failed`+`timeout`）。非流式静默的正解是「判死后重试」（#433 fix 1），不是
// 提前掐死 ⇒ 今天它仍然由 idle 看门狗收尾。因果与实测数见 bin/provider-timeouts.js 头注释第 3 条。
//
// 为什么把 stub 换成「静默的 **fetch 上游**」而不是注入一个 hang provider：相位截止长在
// `createOpenAIProvider` 里（`src/providers/timeout.js`），注入 provider 就把被测的那条装配绕过去了
// （那是接线前那条护栏的形状）。这里让 CLI 自己造 provider，只把 `fetchImpl` 换成一个永不回字节的上游。
//
// 纪律同前：不断言耗时。等待的是**事件**（上游被再次调用 / run 抛错），idle 窗口只作为「不该先响」的背景。
const SILENT_IDLE_SECONDS = 3;
const SILENT_RETRY_ATTEMPTS = "1";
// 「有界」这条性质只能由**实测**证着（评审实测默认 attempts 下 3 发）：所以上界也一起钉住——
// 只写 `>= 2` 的话，「重试通道变成无限重试」这种回归不会被任何用例拦住。
const SILENT_MAX_CALLS = Number(SILENT_RETRY_ATTEMPTS) + 1;

/** 静默上游：`mode` 决定「哪一条截止」该先响。`calls` 记每一次真实请求。 */
function createSilentUpstream({ mode }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body });
    if (mode === "stream") {
      // 响应头立刻回，body 永不出字节、也永不关闭 ⇒ 流式的 firstByte / streamIdle 相位。
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // 连响应头都不回 ⇒ 非流式（`erix chat` 的默认形态）：它的 legacy 截止（默认 300s）与 idle 看门狗
    // 赛跑，而 idle 的起点更早 ⇒ 同值时必然 idle 先响（不可重试）。这就是本节第一格要钉的事实。
    return new Promise(() => {});
  };
  return { fetchImpl, calls };
}

/** 跑一次「静默上游」的 chat，返回抛出的错误。 */
async function runSilentChat({ dir, mode }) {
  const upstream = createSilentUpstream({ mode });
  const previous = process.env.ERIX_RETRY_ATTEMPTS;
  // 重试次数压到 1（= 总共 2 发）：默认 2 次会把这条用例拖到 ~7s，而「有没有走重试通道」在 2 发上
  // 已经可以判定（`attempt` 事件喂表的口径与次数无关）。
  process.env.ERIX_RETRY_ATTEMPTS = SILENT_RETRY_ATTEMPTS;
  let error;
  try {
    await runChat({
      prompt: "永不返回",
      session: `idle-silent-${mode}`,
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      config: {
        model: "fake-model",
        endpoint: "http://silent.invalid/v1",
        apiKey: "test-key",
        fetchImpl: upstream.fetchImpl,
        maxOutputTokens: 1000,
      },
      idleTimeout: SILENT_IDLE_SECONDS,
      // issue #433 fix 1：本文件钉的是「哪些静默落到哪条截止上」——重试会把这些格子的调用次数
      // 与终局形状都改掉，所以这里显式关掉续跑（预算 0 = 不重试）。续跑本身见
      // test/cli-idle-retry.test.js。
      idleRetryBudget: 0,
      maxRounds: 2,
      stream: mode === "stream",
      toolOutput: () => {},
    });
  } catch (thrown) {
    error = thrown;
  } finally {
    if (previous === undefined) delete process.env.ERIX_RETRY_ATTEMPTS;
    else process.env.ERIX_RETRY_ATTEMPTS = previous;
  }
  assert.ok(error, "静默上游的 run 必须抛错，不许静默返回");
  return { error, upstream };
}

test("chat: non-streaming silence still ends on the idle watchdog — intentional (issue #441/#433)", { timeout: 30_000 }, async () => {
  const dir = await makeTmp("erix-cli-silent-retry-");
  try {
    // **这一格是有意的**，别把它改成 `>= 2`：非流式截止保持 legacy（`config.timeout ?? 300_000`），
    // 不派生 ⌊idle×3/4⌋ —— 那条派生会把 `[225s, 300s)` 这条以前成功的带变成必死带（见本节头注释）。
    // 所以「非流式静默」今天仍然只发 1 发、由 idle 看门狗收尾（`idle_timeout`）。
    // issue #440：idle 收尾**不再丢载荷**——这里的 run 一发都没答上来，所以载荷是**零值**
    // （`{input_tokens: 0, output_tokens: 0}` / `rounds: 0` / `finalText: ""`），不是「没有字段」。
    const { error, upstream } = await runSilentChat({ dir, mode: "nonstream" });
    assert.equal(error?.code, "idle_timeout");
    assert.equal(error?.name, "IdleTimeoutError");
    assert.match(error.message, new RegExp(`${SILENT_IDLE_SECONDS} 秒无进展`, "u"));
    assert.equal(error?.termination?.reason, "aborted");
    assert.equal(error?.termination?.partial, true);
    assert.deepEqual(error?.usage, { input_tokens: 0, output_tokens: 0 });
    assert.equal(error?.rounds, 0);
    assert.equal(error?.finalText, "");
    assert.equal(error?.termination?.usage, error?.usage);
    assert.equal(upstream.calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat --stream: a silent stream body is retried on the firstByte deadline (issue #441)", { timeout: 30_000 }, async () => {
  const dir = await makeTmp("erix-cli-silent-retry-stream-");
  try {
    // 流式：响应头回来了但一个正文字节都不出 ⇒ firstByte 相位（不是 idle）。
    const { error, upstream } = await runSilentChat({ dir, mode: "stream" });
    assert.notEqual(error?.code, "idle_timeout");
    assert.equal(error?.code, "timeout");
    assert.equal(error?.termination?.reason, "failed");
    assert.equal(error?.termination?.errorCode, "timeout");
    // 真的走了重试通道（下界），而且**有界**（上界 = attempts + 1）：只钉下界的话，重试退化成
    // 无限重试也不会有用例变红。实测默认 attempts=2 时是 3 发。
    assert.ok(
      upstream.calls.length >= 2,
      `流式静默必须走重试通道（实测只发了 ${upstream.calls.length} 发）`,
    );
    assert.ok(
      upstream.calls.length <= SILENT_MAX_CALLS,
      `重试必须是有界的（attempts=${SILENT_RETRY_ATTEMPTS} ⇒ 上界 ${SILENT_MAX_CALLS} 发，`
      + `实测 ${upstream.calls.length} 发）`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ④' 反向护栏：provider 侧**没有任何可重试截止**时（宿主注入的 hang provider，相位截止根本没接上），
// 看门狗必须照旧咬——#433 的那条不变式不能因为 #441 的接线而被顺手关掉。
test("chat: the idle watchdog still bites when the provider has no retryable deadline (issue #433/#441)", { timeout: 20_000 }, async () => {
  const dir = await makeTmp("erix-cli-idle-silent-");
  try {
    const provider = createHangingProvider();
    const configPath = await writeEmptyMcpConfig(dir);
    await assert.rejects(
      () => runChat({
        prompt: "永不返回",
        session: "idle-silent-run",
        dir,
        notesDir: join(dir, "notes"),
        skillsDir: join(dir, "skills"),
        configPath,
        provider,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        idleTimeout: 1,
        // 预算 0 = 不续跑：这条护栏问的是「看门狗还咬不咬」，重试属 #433 fix 1
        // （见 test/cli-idle-retry.test.js 里「预算用尽」那格）。
        idleRetryBudget: 0,
        maxRounds: 3,
        toolOutput: () => {},
      }),
      (error) => {
        assert.equal(error?.code, "idle_timeout");
        assert.match(error.message, /1 秒无进展/u);
        return true;
      },
    );
    // 没有可重试的截止 ⇒ 没有重试，只发一发。
    assert.equal(provider.calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── issue #433 fix 3 + fix 4 的运行级验收 ───────────────────────────────────────────────
//
// 工单的验收原文是「把 exec 上限设为 idle 的 2 倍跑一个 sleep 装包任务 ⇒ 终局不得是 idle_timeout，
// 且日志能看到 fix 3 的喂证据 + fix 4 的收敛日志」。为什么拆成两格（如实记，不合并冒充）：
// `exec < idle` 这条不变式在 `idle ≤ 30s` 时**物理上不可能**成立（天花板有 30s 下限：
// `execCeilingMsForIdle(idle) = max(30s, idle − 60s)` ⇒ `idle ≤ 30s` 时生效值是 30000ms ≥ idle；
// 而 `idle > 30s` 时天花板严格小于 idle，包括 `idle=31/50/90`），而喂表间隔是
// `idle/4`（长窗口下夹到 30s）——所以「一次 run 里同时看到真收敛与真喂表」需要 `idle > 30s` 且工具
// 跑够 `idle/4`，单格就要 20+ 秒。两格各自钉住承重的那一半：
//   ① exec 上限 = idle 的 2 倍 + 一条比 idle 长的命令 ⇒ 终局不是 idle_timeout，日志有喂表证据；
//   ② exec 上限 ≥ idle ⇒ 真的收敛到 `min(exec, idle − 60s)` 并打 loud 日志，run 照常跑完。
test("chat: exec cap = 2× idle with a long sleep still finishes, and the heartbeat is logged (issue #433 fix 3+4)", async () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  const dir = await makeTmp("erix-cli-idle-exec-suicide-");
  try {
    process.env.ERIX_EXEC_TIMEOUT_MS = "2000"; // exec 上限 = idle(1s) 的 2 倍
    const provider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "install-1", name: "exec", input: { command: "sleep 1.5" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "装好了" }], stopReason: "end_turn" },
    ]);
    const idleLines = [];
    const result = await runChat({
      prompt: "跑一个装包任务",
      session: "idle-exec-suicide",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      idleTimeout: 1,
      maxRounds: 2,
      toolOutput: () => {},
      idleLog: (line) => idleLines.push(line),
    });
    // 判据（工单原文）：终局**不得**是 idle_timeout。runChat 成功返回就说明没走 idle 判死路径。
    assert.notEqual(result.termination?.reason, "aborted");
    assert.equal(result.finalText, "装好了");
    assert.equal(provider.requests.length, 2);
    // fix 3：喂表证据
    assert.ok(
      idleLines.some((line) => /^\[idle-heartbeat\] exec：执行期喂过 idle 计时器 \d+ 次/u.test(line)),
      `缺 fix 3 的喂表日志：${JSON.stringify(idleLines)}`,
    );
    // fix 4：idle 太小、exec < idle 无法成立时也必须说（不静默失效）
    assert.ok(
      idleLines.some((line) => /仍 ≥ idle 窗口/u.test(line)),
      `缺 fix 4 的不变式日志：${JSON.stringify(idleLines)}`,
    );
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat: an explicit exec cap at/above idle is converged to idle − 60s with a loud log (issue #433 fix 4)", async () => {
  const previous = process.env.ERIX_EXEC_TIMEOUT_MS;
  const dir = await makeTmp("erix-cli-idle-exec-ceiling-");
  try {
    // idle=100s ⇒ 天花板 = 40s；显式 200s ≥ 天花板 ⇒ 收敛到 40s（不启动即报错）。
    process.env.ERIX_EXEC_TIMEOUT_MS = "200000";
    const provider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "install-2", name: "exec", input: { command: "sleep 1.5" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "装好了" }], stopReason: "end_turn" },
    ]);
    const idleLines = [];
    const result = await runChat({
      prompt: "跑一个装包任务",
      session: "idle-exec-ceiling",
      dir,
      notesDir: join(dir, "notes"),
      skillsDir: join(dir, "skills"),
      configPath: await writeEmptyMcpConfig(dir),
      provider,
      config: { model: "fake-model", maxOutputTokens: 1000 },
      idleTimeout: 100,
      maxRounds: 2,
      toolOutput: () => {},
      idleLog: (line) => idleLines.push(line),
    });
    assert.notEqual(result.termination?.reason, "aborted");
    assert.equal(result.finalText, "装好了");
    const converged = idleLines.find((line) => /已收敛/u.test(line));
    assert.ok(converged, `缺 fix 4 的收敛日志：${JSON.stringify(idleLines)}`);
    // 收敛到的就是 min(exec, idle − 60s) = min(200000, 40000)
    assert.match(converged, /40000ms/u);
    assert.match(converged, /ERIX_EXEC_TIMEOUT_MS=200000/u);
  } finally {
    if (previous === undefined) delete process.env.ERIX_EXEC_TIMEOUT_MS;
    else process.env.ERIX_EXEC_TIMEOUT_MS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
