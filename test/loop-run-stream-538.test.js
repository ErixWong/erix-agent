// issue #538 —— `config.run.stream` 加**值规则** + 两处流式判断合一（消除同一次运行里的自相矛盾）。
//
// 病根（实测，基点 main `0f0feb5`）：
//   `src/loop/provider-runner.js:72`   `channel: ctx.stream === true ? "chatStream" : "chat"`  ← 严格 true
//   `src/loop/provider-runner.js:152`  `ctx.stream && typeof ctx.provider.chatStream === "function"` ← truthy
// 同一个开关被两处用两种真值判断读，于是 `config.run.stream: 1` 让**同一次运行**里「记下的通道名」
// 说 `chat`、「实际调用的方法」是 `chatStream`。这又是 #522 那类问题发生在**值**上：
// JSDoc 写 `stream?: boolean`（`orchestrator.js:376`）让 `tsc --strict` 拒 `stream: 1`，运行时却接受。
//
// 本文件钉三面（每条对应一处「顺手就会改错」的写法，反向证实测见 WORK-REPORT）：
//   ① **值规则**：`config.run.stream` 必须是布尔；非布尔**启动即抛**，判词点名完整路径
//      `config.run.stream` 与实测收到的类型。两条路线各钉一遍——直连
//      `runToolLoop({ config: { run: { stream: 1 } } })` 与装配口 `policy: { stream: 1 }`
//      （#545 起 policy 叶子翻译成 `config.run.stream`）。**装配路单独成格**：漏校这条路线是这类
//      修复最常见的漏洞。
//   ② **读法合一**：两处（通道名 / provider 方法分支）共用**同一个派生值**，不许各写各的
//      `=== true` / truthy。行为面用「谁被调用」的矩阵钉，结构面用「全文件只有一处 `ctx.stream`
//      读取，且两个引用点都用派生标识符」钉——两者合起来才能证明「二者不可分叉」。
//   ③ **`partialPersistence` 那条既有判词**在修后**只对「省略 / false」说话**：非布尔再也走不到它，
//      所以留一条反向钉说明它的现行语义，而不是把它删掉。
//
// 零真实 LLM（脚本化 provider）、不写盘、不碰真实 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createAssemblyPort } from "../src/assembly.js";
import { runToolLoop } from "../src/loop/orchestrator.js";

const PROVIDER_RUNNER = fileURLToPath(new URL("../src/loop/provider-runner.js", import.meta.url));

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 直连路线的最小合法 run（**不经过** `runDirect` 夹具：夹具会翻译扁平拼写，本文件测引擎拼写）。 */
function base(extra = {}) {
  return {
    provider: scriptedProvider({ chat: true, chatStream: true }),
    executeTool: async () => "ok",
    ...extra,
    config: {
      ...extra.config,
      input: { initialUserMessage: "go", wrapup: false, ...extra.config?.input },
      run: { completion: false, ...extra.config?.run },
    },
  };
}

/**
 * 脚本化 provider：按 `{ chat, chatStream }` 决定实现哪些方法，并记下每个方法被调用几次。
 * 只实现一个通道的 provider 是真实存在的能力面形状（`chatStream`-only 就是其中之一）。
 */
function scriptedProvider({ chat = false, chatStream = false } = {}) {
  const calls = { chat: 0, chatStream: 0 };
  const answer = () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" });
  const provider = { protocol: "fake", model: "fake-model", calls };
  if (chat) {
    provider.chat = async () => {
      calls.chat += 1;
      return answer();
    };
  }
  if (chatStream) {
    provider.chatStream = async () => {
      calls.chatStream += 1;
      return answer();
    };
  }
  return provider;
}

/** 装配口最小合法 port（#545 之后 `policy` 只装数据，叶子名一律翻译进 `config.*`）。 */
function portInput(policy) {
  return {
    modelConfig: { resolve: async () => ({ contextWindowTokens: 1000, maxOutputTokens: 16 }) },
    provider: scriptedProvider({ chat: true, chatStream: true }),
    tools: { definitions: [], executeTool: async () => "ok" },
    session: { id: `run-stream-538-${process.pid}` },
    policy,
  };
}

function portError(policy) {
  try {
    createAssemblyPort(portInput(policy));
  } catch (error) {
    return error;
  }
  return null;
}

async function directError(options) {
  try {
    await runToolLoop(options);
  } catch (error) {
    return error;
  }
  return null;
}

// ================================================================ ① 值规则（直连路线）

test("V1 直连路线：非布尔 `config.run.stream` 启动即抛，判词点名完整路径与实测类型", async () => {
  // 判词必须逐字点名 `config.run.stream`（不是扁平的 `stream`），且报**实测收到的类型**——
  // 宿主照着这一句就能改。类型名的四种形状都要能区分：number / string / null / array / object。
  const shapes = [
    [1, "number"],
    ["yes", "string"],
    [null, "null"],
    [[], "array"],
    [{}, "object"],
    [0, "number"],
    ["false", "string"],
  ];
  for (const [value, type] of shapes) {
    const error = await directError(base({ config: { run: { stream: value } } }));
    assert.equal(error instanceof TypeError, true, `stream=${JSON.stringify(value)} 必须当场抛 TypeError`);
    assert.equal(
      error.message,
      `config.run.stream must be a boolean (received: ${type})`,
      `stream=${JSON.stringify(value)} 的判词必须点名完整路径与实测类型`,
    );
  }
});

test("V2 直连路线：布尔照旧（`true` / `false` / 省略都不许被误伤）", async () => {
  for (const value of [true, false, undefined]) {
    const provider = scriptedProvider({ chat: true, chatStream: true });
    const result = await runToolLoop(base({
      provider,
      config: { run: { stream: value } },
    }));
    assert.equal(result.termination.reason, "end_turn", `stream=${String(value)} 必须跑通`);
    assert.equal(provider.calls.chat + provider.calls.chatStream, 1, "恰一发请求");
  }
});

// ================================================================ ① 值规则（装配路线）

test("V3 装配路线 `policy.stream`：非布尔在**构造期**抛，判词点名 config.run.stream", () => {
  // #545 之后 `policy.stream` 是 `config.run.stream` 的翻译源，所以这条路线必须与直连同口径。
  // 构造期就抛（不是等到 run 起来）：宿主的装配期一条 TypeError 说清，比跑很久才发现好。
  for (const [value, type] of [[1, "number"], ["yes", "string"], [null, "null"]]) {
    const error = portError({ stream: value });
    assert.equal(error instanceof TypeError, true, `policy.stream=${JSON.stringify(value)} 必须抛`);
    assert.equal(
      error.message,
      `config.run.stream must be a boolean (received: ${type})`,
      `policy.stream=${JSON.stringify(value)}：翻译后的路径必须逐字点名 config.run.stream`,
    );
  }
  // 合法取值不被误伤：装配期照旧构造成功。
  assert.equal(portError({ stream: true }), null, "policy.stream: true 必须照旧装配");
  assert.equal(portError({ stream: false }), null, "policy.stream: false 必须照旧装配");
});

test("V4 装配路线 `policy.config.run.stream`：显式树里写非布尔同样在构造期抛", () => {
  // 装配口有**两个**写入口：`policy.stream`（翻译叶）与 `policy.config.run.stream`（显式树）。
  // 只钉前者会漏掉后者——那是「装配路漏校」的第二种形状。
  const error = portError({ config: { run: { stream: 1 } } });
  assert.equal(error instanceof TypeError, true, "policy.config.run.stream: 1 必须抛");
  assert.equal(error.message, "config.run.stream must be a boolean (received: number)");
  assert.equal(portError({ config: { run: { stream: true } } }), null, "显式树里的布尔照旧装配");
});

// ================================================================ ② 读法合一（行为面）

test("U1 派生值的语义矩阵：谁被调用由「provider 能力 × 开关」共同决定", async () => {
  // 这是「两处共用一个派生值」的行为面证据。四格都是真实形状：
  //   · 双能力 + true  → 流式（开关说了算）
  //   · 双能力 + 省略  → 批式（缺省 false）
  //   · 只实现 chatStream + true → 流式（**没有别的通道可调**，这是原有语义，保留）
  //   · 只实现 chatStream + 省略 → 仍然流式：开关关不掉唯一可用的通道（原语义）
  const cases = [
    { label: "双能力 + stream:true", caps: { chat: true, chatStream: true }, stream: true, expect: { chat: 0, chatStream: 1 } },
    { label: "双能力 + stream:false", caps: { chat: true, chatStream: true }, stream: false, expect: { chat: 1, chatStream: 0 } },
    { label: "双能力 + 省略", caps: { chat: true, chatStream: true }, stream: undefined, expect: { chat: 1, chatStream: 0 } },
    { label: "只 chatStream + stream:true", caps: { chatStream: true }, stream: true, expect: { chat: 0, chatStream: 1 } },
    { label: "只 chatStream + 省略", caps: { chatStream: true }, stream: undefined, expect: { chat: 0, chatStream: 1 } },
    { label: "只 chat + stream:true", caps: { chat: true }, stream: true, expect: { chat: 1, chatStream: 0 } },
  ];
  for (const item of cases) {
    const provider = scriptedProvider(item.caps);
    const result = await runToolLoop(base({
      provider,
      config: { run: { stream: item.stream } },
    }));
    assert.equal(result.termination.reason, "end_turn", `${item.label}：必须跑通`);
    assert.deepEqual(provider.calls, item.expect, `${item.label}：走错通道`);
  }
});

// ================================================================ ② 读法合一（结构面）

test("U2 全文件只有**一处**读 `ctx.stream`，两个引用点都用同一个派生值（不可分叉）", () => {
  // 行为面只能证明「走对通道」；「两处读的是同一个值」是**结构**主张，所以这里钉结构：
  //   · `src/loop/provider-runner.js` 里读 `ctx.stream` 的**代码行**恰好一行，且它在派生函数里；
  //   · 通道名那处与 provider 方法分支那处都引用派生标识符，不各自写 `ctx.stream` 判断。
  // 反向证：把任一处改回原本各自的写法（`ctx.stream === true ? …` / `ctx.stream && …`）⇒
  // 代码行里的 `ctx.stream` 变成两行 ⇒ 本格红。注释里的叙述不算代码行（按行首 `*` / `//` 剔除）。
  const source = readFileSync(PROVIDER_RUNNER, "utf8");
  const codeLines = source.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  });
  const reads = codeLines.filter((line) => line.includes("ctx.stream"));
  assert.equal(reads.length, 1, `读 ctx.stream 的代码行必须恰好一行，实际：${JSON.stringify(reads)}`);
  assert.match(reads[0], /^\s*return ctx\.stream === true && hasChatStream;$|^\s*return ctx\.stream === true/u,
    "唯一那处读法必须是严格比较（值规则保证布尔；truthy 写法会在未来的非布尔上重新分叉）");

  // 派生值只算一次、两处引用。
  const computed = codeLines.filter((line) => /const streaming = /.test(line));
  assert.equal(computed.length, 1, "派生值必须只算一次（每次调用一个值，不是一个引用点一个值）");
  const channelSite = codeLines.filter((line) => line.includes('"chatStream" : "chat"'));
  assert.equal(channelSite.length, 1, "通道名只该有一处");
  assert.match(channelSite[0], /channel: streaming \?/, "通道名必须由派生值决定");
  const branchSite = codeLines.filter((line) => /^\s*if \(streaming\) \{$/u.test(line));
  assert.equal(branchSite.length, 1, "provider 方法分支必须由**同一个**派生值决定");
  // 而「派生值来自 ctx.stream」这条边只有一条：`streamsThisRun(ctx)` 的调用点恰好一处。
  const resolverCalls = codeLines.filter((line) => line.includes("streamsThisRun(ctx)")
    && !line.includes("function "));
  assert.equal(resolverCalls.length, 1, "派生函数必须只在一个地方被调用（多一处就多一个可能分叉的输入）");
});

// ================================================================ ③ `partialPersistence` 的现行语义

test("P1 `partialPersistence requires stream: true` 只对「省略 / false」说话（非布尔走不到它）", async () => {
  // 修前：`stream: 1` 能让这条判词**沉默**（`!1` 是 false ⇒ 不抛），然后在 provider-runner 里
  // 按「不流式」走 `chat`——判词与行为各自成立、彼此矛盾。修后非布尔在展开相就被值规则拒，
  // 所以这条判词现在**只**对两种形状说话：`stream` 省略（缺省 false）与 `stream: false`。
  for (const stream of [undefined, false]) {
    const error = await directError(base({
      config: { run: { partialPersistence: { intervalMs: 10 }, stream } },
    }));
    assert.equal(error instanceof TypeError, true, `stream=${String(stream)}：必须仍被这条判词拒`);
    assert.equal(error.message, "partialPersistence requires stream: true", "判词逐字不变（不是删掉它）");
  }
  // 非布尔：走不到这条判词，先撞值规则（判词不同 ⇒ 本格同时证明「谁先开火」）。
  const nonBoolean = await directError(base({
    config: { run: { partialPersistence: { intervalMs: 10 }, stream: 1 } },
  }));
  assert.equal(nonBoolean instanceof TypeError, true);
  assert.equal(nonBoolean.message, "config.run.stream must be a boolean (received: number)",
    "非布尔必须先撞值规则，而不是让 partialPersistence 那条判词沉默地放过它");
  // 合法组合照旧跑通。
  const ok = await runToolLoop(base({
    config: { run: { partialPersistence: { intervalMs: 10 }, stream: true } },
  }));
  assert.equal(ok.termination.reason, "end_turn");
});
