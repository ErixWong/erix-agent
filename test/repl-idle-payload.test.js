// issue #440：repl 侧的同型用例——**防漏修**。
//
// 病根：`bin/cli.js` 与 `bin/repl.js` 各有一份**逐字同构**的 idle 看门狗（#433 T0 把
// `createIdleTimeout` 收成了一份，但「判死之后抛哪个错误」仍是两份），两处都在命中时
// `new IdleTimeoutError(…)` 把引擎刚抛出的、已注解的 aborted 错误整个顶掉。只改 cli 就是漏修一半。
//
// 这条路径上「repl 拿不拿得到载荷」要说清：repl 的轮级 catch 把错误交给 `rl` 的行处理
// （`error.code === "idle_timeout"` ⇒ 打一行文案），错误**不向外抛**，`runRepl` 的返回 Promise
// 只表示会话结束。所以载荷在 repl 侧**不可从外部观测**——本文件因此用两层证据：
//   ① **行为层**：真跑一次 repl（注入的 hang provider + `--idle-timeout 1`），断言它**仍然**走
//      idle 判别面（文案逐字不变、没有被 `printError` 兜住）——判别面一旦被改，这格立刻红；
//   ② **结构层**：`bin/` 下 `IdleTimeoutError` 只许有**一处**声明，两个入口都必须走
//      `idleTimeoutFailure(...)`。谁把 repl 那份复制回去，这格立刻红（这正是「只改一处」的形状）。
//
// 纪律：不写真实 `~/.erix` / `~/.pi`（`home` / `sessionDir` / `notesDir` 全部注入 tmp）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { runRepl } from "../bin/repl.js";
import { makeTmp } from "./helpers/tmp.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** 一个**永不返回**的 provider（宿主注入 ⇒ provider 侧没有任何可重试的相位截止）。 */
function createHangingProvider() {
  let calls = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    get calls() {
      return calls;
    },
    async chat() {
      calls += 1;
      return new Promise(() => {});
    },
    async chatStream() {
      return this.chat();
    },
  };
}

test("repl: an idle-timeout kill still lands on the idle discriminator (issue #440)", { timeout: 30_000 }, async () => {
  const home = await makeTmp("erix-repl-idle-payload-");
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  try {
    const provider = createHangingProvider();
    const run = runRepl(
      ["--idle-timeout", "1"],
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
    input.end("你好\n/exit\n");
    await run;

    const text = chunks.join("");
    // 判别面：走的是 idle 分支（`writeLine(output, error.message)`），不是 `printError` 的「错误：」。
    assert.match(text, /1 秒无进展，已中止/u, "repl 的 idle 中止文案必须逐字不变");
    assert.doesNotMatch(text, /错误：/u, "idle 中止不该落进 printError 分支");
    assert.equal(provider.calls, 1, "没有可重试的截止 ⇒ 只发一发");
  } finally {
    input.destroy();
    output.destroy();
    await rm(home, { recursive: true, force: true });
  }
});

/** 去掉整行注释与块注释行：只对**代码**断言，注释里提名字是正当的。 */
function codeLines(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== ""
        && !trimmed.startsWith("//")
        && !trimmed.startsWith("/*")
        && !trimmed.startsWith("*");
    });
}

test("bin/: the idle abort error has exactly one implementation and both entry points use it (issue #440)", () => {
  const cliSource = readFileSync(join(ROOT, "bin", "cli.js"), "utf8");
  const replSource = readFileSync(join(ROOT, "bin", "repl.js"), "utf8");
  const idleSource = readFileSync(join(ROOT, "bin", "idle.js"), "utf8");

  // ① 两个入口**不许**再各自声明一份错误类（那就是「双实现」本身）。
  for (const [name, source] of [["bin/cli.js", cliSource], ["bin/repl.js", replSource]]) {
    assert.equal(
      codeLines(source).some((line) => /class\s+IdleTimeoutError\b/u.test(line)),
      false,
      `${name} 不许再声明自己的 IdleTimeoutError（issue #440：双实现正是缺陷）`,
    );
    assert.equal(
      codeLines(source).some((line) => /new\s+IdleTimeoutError\s*\(/u.test(line)),
      false,
      `${name} 不许直接 new IdleTimeoutError（必须走 idleTimeoutFailure，否则载荷会丢）`,
    );
  }

  // ② 两个入口都必须**调用**共享的构造入口（不是只 import 摆着）。
  for (const [name, source] of [["bin/cli.js", cliSource], ["bin/repl.js", replSource]]) {
    assert.match(
      source,
      /import\s*\{[^}]*idleTimeoutFailure[^}]*\}\s*from\s*"\.\/idle\.js"/su,
      `${name} 必须从 ./idle.js 引入 idleTimeoutFailure`,
    );
    assert.ok(
      codeLines(source).some((line) => /\bidleTimeoutFailure\s*\(/u.test(line)),
      `${name} 必须在看门狗命中处调用 idleTimeoutFailure(...)`,
    );
  }

  // ③ `bin/` 全目录扫一遍：声明只许有**一处**，且必须在 bin/idle.js。
  const binDir = join(ROOT, "bin");
  const declarers = readdirSync(binDir)
    .filter((file) => file.endsWith(".js"))
    .filter((file) => codeLines(readFileSync(join(binDir, file), "utf8"))
      .some((line) => /class\s+IdleTimeoutError\b/u.test(line)))
    .sort();
  assert.deepEqual(declarers, ["idle.js"], "IdleTimeoutError 的声明必须只有 bin/idle.js 一处");
  assert.match(idleSource, /export\s+class\s+IdleTimeoutError\b/u);
  assert.match(idleSource, /export\s+function\s+idleTimeoutFailure\b/u);
});
