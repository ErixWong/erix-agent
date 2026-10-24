// issue #440：repl 侧的同型用例——**防漏修**。
//
// 病根：`bin/cli.js` 与 `bin/repl.js` 各有一份**逐字同构**的 idle 看门狗（#433 T0 把
// `createIdleTimeout` 收成了一份，但「判死之后抛哪个错误」仍是两份），两处都在命中时
// `new IdleTimeoutError(…)` 把引擎刚抛出的、已注解的 aborted 错误整个顶掉。只改 cli 就是漏修一半。
//
// 这条路径上「repl 拿不拿得到载荷」要说清：repl 的轮级 catch 把错误交给 `rl` 的行处理
// （`error.code === "idle_timeout"` ⇒ 打一行文案），错误**不向外抛**，`runRepl` 的返回 Promise
// 只表示会话结束。所以载荷在 repl 侧**不可从外部观测**——本文件因此用三层证据（评审必修 2：
// 前两层曾各自不承重，所以第三层是**真读载荷**的断言，不是又一条正则）：
//   ① **行为层**：真跑一次 repl（注入的 hang provider + `--idle-timeout 1`），断言它**仍然**走
//      idle 判别面（文案逐字不变、没有被 `printError` 兜住）——判别面一旦被改，这格立刻红；
//   ② **结构层（实参形状）**：`bin/` 下 `IdleTimeoutError` 只许有**一处**声明；两个入口都必须走
//      共享构造入口，而且**实参**要钉住（cli 的 `(idleTimeout, error)`、repl 的
//      `throw replIdleFailure(options, error)` 就地构造）。只钉「调用了这个名字」不够：评审实测
//      `idleTimeoutFailure(options.idleTimeout)`（只丢第二个实参）与「构造后 `Object.assign` 抹载荷」
//      两种变异在旧守卫下都是全绿；
//   ③ **观测缝层**：`replIdleFailure(options, cause)`（本文件被测的那个构造缝）喂一份带四件载荷的
//      cause ⇒ 返回的错误四件齐全且 `termination.usage === usage`；再把同一份结果按评审的
//      「事后抹掉」形状处理 ⇒ 该判据**必须红**（这格本身就是「判据读的是载荷，不是源码」的证明）。
//
// 纪律：不写真实 `~/.erix` / `~/.pi`（`home` / `sessionDir` / `notesDir` 全部注入 tmp）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { runRepl, replIdleFailure } from "../bin/repl.js";
import { IDLE_TIMEOUT_CODE, TERMINATION_PAYLOAD_KEYS } from "../bin/idle.js";
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

  // ② 两个入口都必须**调用**共享的构造入口，而且**实参形状**要钉住。
  //    旧守卫只问「这个名字出现过吗」（`/\bidleTimeoutFailure\s*\(/`），评审实测：
  //    `idleTimeoutFailure(options.idleTimeout)`（只丢第二个实参）⇒ 34/34 全绿；
  //    构造之后 `Object.assign(failure, {termination: undefined, …})` ⇒ 43/43 全绿。两条都得红。
  for (const [name, source] of [["bin/cli.js", cliSource], ["bin/repl.js", replSource]]) {
    assert.match(
      source,
      /import\s*\{[^}]*idleTimeoutFailure[^}]*\}\s*from\s*"\.\/idle\.js"/su,
      `${name} 必须从 ./idle.js 引入 idleTimeoutFailure`,
    );
  }
  // ②-a cli 侧：构造处必须两个实参齐全。issue #433 fix 1 之后构造点从「最外层 catch 的赋值」搬到了
  //    重试循环里（`const terminal = idleTimeoutFailure(idleTimeout, error)`，判死后先决定重试还是落终局），
  //    判据跟着搬：仍然要求**这两个实参**，且终局必须**原样**抛这个对象（`throw terminal`）。
  assert.match(
    cliSource,
    /^\s*const terminal = idleTimeoutFailure\(\s*idleTimeout\s*,\s*error\s*\);\s*$/mu,
    "bin/cli.js 必须是 `const terminal = idleTimeoutFailure(idleTimeout, error)`——少一个实参就是把载荷丢掉",
  );
  assert.match(
    cliSource,
    /^\s*throw terminal;\s*$/mu,
    "bin/cli.js 必须原样抛那个 terminal（另造一个错误 = 载荷/重试记账一起丢）",
  );
  // ②-b repl 侧：构造**就地**写在 throw 里（`throw replIdleFailure(options, error);`）。
  //    这样「先赋给变量再改写载荷」的形状根本写不进来（要么改这行、要么多一行）。
  const replCallLines = codeLines(replSource)
    .filter((line) => !/function\s+replIdleFailure\b/u.test(line)) // 声明行不算调用点
    .filter((line) => /\breplIdleFailure\s*\(/u.test(line));
  assert.equal(replCallLines.length, 1, "bin/repl.js 里 replIdleFailure(...) 只许有一处调用（构造缝唯一）");
  assert.match(
    replCallLines[0],
    /^\s*if \(idle\?\.timedOut\(\)\) throw replIdleFailure\(\s*options\s*,\s*error\s*\);\s*$/u,
    "bin/repl.js 的构造必须就地写在 throw 里且实参是 (options, error)——少实参或事后抹载荷都要红",
  );
  // ②-c 构造缝自己的转发也必须两个实参齐全（变异可以落在缝里，不只在调用点）。
  assert.match(
    replSource,
    /^\s*return idleTimeoutFailure\(\s*options\.idleTimeout\s*,\s*cause\s*\);\s*$/mu,
    "replIdleFailure 必须把 (options.idleTimeout, cause) 两个实参原样交给 idleTimeoutFailure",
  );

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

/**
 * 判据本体：四件载荷逐一**非 `undefined`**、且与 `cause` 上是**同一个对象**（不是副本）。
 * 同一个对象这条是契约原文（`termination.usage === error.usage`）⇒ 宿主改一处会改到另一处。
 */
function assertPayloadIntact(failure, cause) {
  for (const key of TERMINATION_PAYLOAD_KEYS) {
    assert.notEqual(failure[key], undefined, `idle 失败上必须保留 cause.${key}`);
    assert.equal(failure[key], cause[key], `${key} 必须是 cause 上的同一个对象，不是副本`);
  }
  assert.equal(failure.termination.usage, failure.usage, "termination.usage === error.usage 必须成立");
}

test("repl: the idle failure it builds keeps the engine's four payload keys (issue #440 review)", () => {
  const usage = { input_tokens: 300, output_tokens: 30 };
  const rounds = 3;
  const finalText = "半成品";
  const cause = Object.assign(new Error("aborted"), {
    termination: { reason: "aborted", partial: true, usage, rounds },
    usage,
    rounds,
    finalText,
  });

  const failure = replIdleFailure({ idleTimeout: 7 }, cause);
  // 判别面逐字不变：人类可见的那一行文案就是从 `message` 来的（`writeLine(output, error.message)`）。
  assert.equal(failure.code, IDLE_TIMEOUT_CODE, "判别面 code 不许变");
  assert.equal(failure.name, "IdleTimeoutError", "判别面 name 不许变");
  assert.equal(failure.message, "任务 7 秒无进展，已中止", "人类可见文案逐字不变");
  assert.equal(failure.cause, cause, "成因链必须保留");
  assertPayloadIntact(failure, cause);

  // 不伪造：原始错误上没有该键 ⇒ 这个键**不出现**（不是 `undefined` 值属性、更不是零值）。
  const bare = replIdleFailure({ idleTimeout: 1 }, new Error("别的错误"));
  for (const key of TERMINATION_PAYLOAD_KEYS) {
    assert.equal(Object.hasOwn(bare, key), false, `cause 上没有 ${key} 时不许凭空造一个`);
  }

  // 反向证（这一格必须**真读载荷**，不是读正则）：把同一份构造结果按评审的 mut4 形状事后抹掉
  // ⇒ 上面的判据必须不成立。只断言源码里出现过某个名字的实现会在这格绿——所以这格就是
  // 「判据读的是载荷」的证明，而不是又一条恒真的结构断言。
  const wiped = replIdleFailure({ idleTimeout: 7 }, cause);
  Object.assign(wiped, { termination: undefined, usage: undefined, rounds: undefined, finalText: undefined });
  assert.throws(
    () => assertPayloadIntact(wiped, cause),
    /cause\.termination/u,
    "构造后抹掉载荷的等价形状必须让这一格红——否则这格是恒真的",
  );
});
