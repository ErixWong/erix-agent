// issue #440：idle 看门狗**不许**把引擎的终局载荷丢掉。
//
// 现场（实测，见 CHANGELOG 与工单报告）：引擎在 `reason === "aborted"` 时确实按契约挂了载荷
// （`error.termination` / `error.usage` / `error.rounds` / `error.finalText` 四件齐全，
// 且 `termination.usage === error.usage`），但 `bin/cli.js` 的 idle 看门狗命中时 `new
// IdleTimeoutError(…)` 把整个原始错误顶掉 ⇒ 四个字段全 `undefined`，宿主/bench 只拿得到
// 「超时了」，拿不到「这个 run 死之前烧了多少 token、跑到第几轮、有没有半成品」。
//
// 本文件钉三件事：
//   ① **契约面**：idle 中止的错误上四件载荷可得，且 `termination.usage === error.usage` 这条
//      中英契约逐字成立（判据见 `docs/host-consumer-contract.md` 的 Termination payload 一节）；
//   ② **判别面不变**：`code === "idle_timeout"` / `name === "IdleTimeoutError"` / 消息文案一字不改
//      —— 最外层 catch、repl 的行处理、bench 统计全靠它；
//   ③ **不伪造**：原始错误没有该键时不写 `undefined`、更不写零值。
//
// 纪律：不写真实 `~/.erix` / `~/.pi`（`dir` / `notesDir` / `skillsDir` / `configPath` 全部注入 tmp），
// 事件驱动不断言耗时（这里等待的是「run 抛错」这个事件，idle 窗口只是它的成因）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runChat } from "../bin/cli.js";
import {
  IDLE_TIMEOUT_CODE,
  IdleTimeoutError,
  TERMINATION_PAYLOAD_KEYS,
  idleTimeoutFailure,
} from "../bin/idle.js";
import { makeTmp } from "./helpers/tmp.js";

// issue #81：runChat 的 MCP 代理默认解析 ~/.erix/mcp.json（可能配了真实远端 server）。
// 每个用例注入空配置，彻底与真实 home 隔离。
async function writeEmptyMcpConfig(dir) {
  const configPath = join(dir, "mcp.json");
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf8");
  return configPath;
}

// 第一发正常产出（一个工具调用 + 非零 usage），第二发**永不返回**。
// 这样 idle 打死时 run 真的「烧过 token、跑过轮」，四件载荷都是**真数据**而不是零值——
// 拿零值断言的话，即便载荷根本没搬过来也可能碰巧通过。
const ROUND1_USAGE = Object.freeze({
  input_tokens: 300,
  output_tokens: 30,
  cacheRead: 1400,
  cacheWrite: 6,
});

function createPayloadThenHangProvider() {
  let calls = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    get calls() {
      return calls;
    },
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          content: [{
            type: "tool_use",
            id: "payload-1",
            name: "exec",
            input: { command: "true" },
          }],
          stopReason: "tool_use",
          usage: { ...ROUND1_USAGE },
        };
      }
      return new Promise(() => {});
    },
    async chatStream() {
      return this.chat();
    },
  };
}

test("chat: an idle-timeout kill keeps the engine's termination payload (issue #440)", { timeout: 30_000 }, async () => {
  const dir = await makeTmp("erix-cli-idle-payload-");
  try {
    const provider = createPayloadThenHangProvider();
    let error;
    try {
      await runChat({
        prompt: "跑一个工具然后挂住",
        session: "idle-payload-chat",
        dir,
        notesDir: join(dir, "notes"),
        skillsDir: join(dir, "skills"),
        configPath: await writeEmptyMcpConfig(dir),
        provider,
        config: { model: "fake-model", maxOutputTokens: 1000 },
        idleTimeout: 2,
        maxRounds: 5,
        toolOutput: () => {},
      });
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, "看门狗命中的 run 必须抛错，不许静默返回");
    assert.equal(provider.calls, 2, "第一轮正常跑完、第二轮才是静默的那一发");

    // ② 判别面：一字不变（最外层 catch / repl 行处理 / bench 统计都按它分流）。
    assert.equal(error.code, "idle_timeout");
    assert.equal(error.code, IDLE_TIMEOUT_CODE);
    assert.equal(error.name, "IdleTimeoutError");
    assert.match(error.message, /2 秒无进展/u);

    // ① 契约面：四件载荷逐一非 `undefined`。
    assert.notEqual(error.termination, undefined, "idle 中止必须保留 termination");
    assert.notEqual(error.usage, undefined, "idle 中止必须保留 usage");
    assert.notEqual(error.rounds, undefined, "idle 中止必须保留 rounds");
    assert.notEqual(
      error.finalText,
      undefined,
      "idle 中止必须保留 finalText（无产出时是空串，不是 undefined）",
    );

    // 载荷是**真数据**：第一轮真的花掉了这些 token、真的跑完了 1 轮。
    assert.deepEqual(error.usage, { ...ROUND1_USAGE });
    assert.equal(error.rounds, 1);
    assert.equal(error.finalText, "");
    assert.equal(error.termination.reason, "aborted");
    assert.equal(error.termination.partial, true);

    // 中英契约的原话：`termination.usage === error.usage`（同一个对象，不是等值的两份）。
    assert.equal(
      error.termination.usage,
      error.usage,
      "termination.usage 必须与 error.usage 同一个对象（契约：termination.usage === error.usage）",
    );
    assert.equal(error.termination.rounds, error.rounds);

    // 成因链保留：下游还能拿到引擎原本抛的那个 AbortError。
    assert.equal(error.cause?.name, "AbortError");

    // ③ 不伪造：契约里**没有**顶层 `error.partial`（标记位是 `termination.partial`），
    // 别为了「对齐想象中的形状」凭空造一个。
    assert.equal(
      Object.prototype.hasOwnProperty.call(error, "partial"),
      false,
      "顶层 error.partial 不是契约字段（契约字段是 termination.partial）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idleTimeoutFailure copies the payload verbatim and invents nothing (issue #440)", () => {
  // 载荷键表本身是契约面：四件，`partial` 不在此列。
  assert.deepEqual([...TERMINATION_PAYLOAD_KEYS], ["termination", "usage", "rounds", "finalText"]);

  const usage = { input_tokens: 7, output_tokens: 3 };
  const termination = { reason: "aborted", usage, rounds: 1, partial: true };
  const cause = new Error("The operation was aborted");
  cause.termination = termination;
  cause.usage = usage;
  cause.rounds = 1;
  cause.finalText = "半成品";
  cause.partial = true; // 顶层 partial：不是契约字段，**不该**被搬

  const thrown = idleTimeoutFailure(4, cause);
  assert.ok(thrown instanceof IdleTimeoutError);
  assert.equal(thrown.code, "idle_timeout");
  assert.equal(thrown.name, "IdleTimeoutError");
  assert.match(thrown.message, /4 秒无进展/u);
  // 同一个对象，不是拷贝 ⇒ `termination.usage === usage` 与身份口径都成立。
  assert.equal(thrown.termination, termination);
  assert.equal(thrown.usage, usage);
  assert.equal(thrown.rounds, 1);
  assert.equal(thrown.finalText, "半成品");
  assert.equal(thrown.cause, cause);
  assert.equal(Object.prototype.hasOwnProperty.call(thrown, "partial"), false);

  // 原始错误没有载荷（run 还没进 `fail()`、抛的是别的东西）⇒ 键**不出现**，不写 undefined / 零值。
  const bare = idleTimeoutFailure(4, new Error("别的错误"));
  assert.equal(bare.code, "idle_timeout");
  for (const key of TERMINATION_PAYLOAD_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(bare, key),
      false,
      `原始错误没有 ${key} 时不许凭空造这个键`,
    );
  }
  // 部分存在时只搬存在的那几件（不补零值）。
  const partialPayload = new Error("半截");
  partialPayload.usage = usage;
  const partialThrown = idleTimeoutFailure(4, partialPayload);
  assert.equal(partialThrown.usage, usage);
  assert.equal(Object.prototype.hasOwnProperty.call(partialThrown, "rounds"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(partialThrown, "termination"), false);

  // cause 不是对象（甚至缺省）时判别面照旧成立，不许因为搬运逻辑炸掉。
  for (const odd of [undefined, null, "boom", 42]) {
    const thrownOdd = idleTimeoutFailure(1, odd);
    assert.equal(thrownOdd.code, "idle_timeout");
    assert.equal(thrownOdd.name, "IdleTimeoutError");
    assert.equal(thrownOdd.termination, undefined);
  }
});
