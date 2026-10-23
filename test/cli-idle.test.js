// issue #433 T0：idle 看门狗的回归钉子。
//
// 覆盖三件事：
//   ① 工具执行期喂表（长命令不再被静默窗口打死）；
//   ② repl 侧的**同型**用例（防只改一处——双实现正是本单要消的缺陷）；
//   ③ 判死仍单向的回归护栏（本刀**不加**重试，重试属 #441）。
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

/** 一个**永不返回**的 provider：用来证明看门狗还咬得住（不是被本刀的喂表关掉了）。 */
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
    });

    // run 跑完了两轮（工具轮 + 终稿轮），没有以 aborted / idle 结束
    assert.equal(provider.requests.length, 2);
    assert.equal(result.rounds, 2);
    assert.notEqual(result.termination?.reason, "aborted");
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

// ④ 回归护栏：静默 stub（永不返回的 provider）+ idleTimeout: 1 ⇒ 看门狗仍然咬，且**只咬一次**。
// 本刀**不加**重试：idle 打死之后 provider 只被调用 1 次。
// 等 #441（判死后的重试/续跑）落地后，这条要改成 `>= 2`——现在就写成 1，是为了让「本刀没加
// 重试」这件事在测试里有据可查，而不是只写在报告里。
test("chat: a silent provider still trips the idle watchdog exactly once (no retry yet, #441)", { timeout: 20_000 }, async () => {
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
        maxRounds: 3,
        toolOutput: () => {},
      }),
      (error) => {
        assert.equal(error?.code, "idle_timeout");
        assert.match(error.message, /1 秒无进展/u);
        return true;
      },
    );
    assert.equal(provider.calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
