// @ts-check
// issue #798：把 `reasoning_effort` 接到 **CLI 面**（引擎面与观测面在 #785 已齐，缺的只是宿主接线：
// env 不被读、没有 `--effort`、统计行看不见思考分解）。
//
// 判据（工单 #798 三条 + 一条非法值 + 评审附加的防漂移格，逐条对应用例名）：
//   ① env 在场且 slot 未配 ⇒ 轮记录 `sentRequestParams.reasoningEffort.source` 指向**本次覆盖**
//      通道（`request`），**不是** `slotDefault`（裁决 A：值注进请求通道，`src/` 一字未动）；
//   ② 旗标与 env **同时在场且不同** ⇒ 取旗标；env 与 slot **同时在场且不同** ⇒ 取 env。
//      两种组合各一条，并在**真 wire body** 上对账（不信 CLI 自述）；
//   ③ 上游回报 `reasoning_tokens` ⇒ 统计行打得出分解；没回报 ⇒ **该项缺席**
//      （反向证：断言输出里连字段名都不出现，而不是断言它等于 0）；
//   ④ 非法值不在 CLI 崩：CLI 不自己编「值不合法」，上游 4xx 原文透出（#788 parked 的口径）；
//   ⑤ 包装层防漂移：被钉成表的那批 provider 成员一个都不许漏转发（漏一个就红）。
//
// 零真实 LLM 调用：真 `createOpenAIProvider` + `createMockFetch`，这样 `sentRequestParams` 与 wire
// body 都是引擎自己产的事实（观测点在 payload 装配处，宿主自建 provider 交不出那一格）。
// `~/.erix` 与真实 MCP 配置一律注入（`_assemblyRoot` + 空 mcp 的 `configPath`，照 cli.test.js 先例）。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseChatArgs, runChat } from "../bin/cli.js";
import { parseReplArgs } from "../bin/repl.js";
import { loadCliConfig } from "../bin/config.js";
import {
  PROVIDER_MEMBER_SURFACE,
  createReasoningEffortStats,
  resolveReasoningEffort,
  withCliReasoningEffort,
} from "../bin/reasoning-effort.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { makeTmp } from "./helpers/tmp.js";
import { createMockFetch } from "./helpers/mock-fetch.js";

const ENDPOINT = "https://api.example.test/v1";
const QWEN = "qwen3.8-flash-next";
const GLM = "glm-5.3-flash-awq";

/** 上游的一发正常返回；`reasoningTokens === undefined` 就是「上游**没回报**那一格」的那一臂。 */
function okJson(reasoningTokens) {
  return {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      ...(reasoningTokens === undefined
        ? {}
        : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
    },
  };
}

async function sandbox(prefix) {
  const dir = await makeTmp(prefix);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 只在用例期间改 env（`bin/` 读的是 `process.env`；同文件内用例串行，不外溢）。 */
async function withEnv(name, value, run) {
  const had = Object.hasOwn(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (had && previous !== undefined) process.env[name] = previous;
    else delete process.env[name];
  }
}

/**
 * 跑一次真 `runChat`：真引擎循环 + 真 OpenAI provider + mock 上游。
 * 返回抓到的 wire body、落盘的轮记录、终局 `=== 统计 ===` 那一行、以及 stderr 通知行。
 *
 * @param {{model: string, effort?: string, config?: Record<string, any>, reasoningTokens?: number,
 *   status?: number, body?: string}} input
 */
async function chatOnce(input) {
  const { model, effort, config = {}, reasoningTokens, status = 200, body } = input;
  const dir = await sandbox("erix-798-store-");
  const cwd = await sandbox("erix-798-cwd-");
  const mcpConfigPath = join(dir, "mcp.json");
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }), "utf8");
  const notesDir = join(dir, "notes");
  const store = createMemoryTranscriptStore();
  const fetchImpl = createMockFetch([
    body === undefined && status === 200
      ? { json: okJson(reasoningTokens) }
      : { status, body: body ?? "", headers: { "content-type": "application/json" } },
  ]);
  // 宿主注入 provider 时，真 CLI 那边会把 slot 字段交给自己造的 provider；这里把 `config` 里的 slot 值同样交进去，
  // 否则 slot 那一臂根本不在场，"env 压 slot」就变成了「env 压一个不存在的东西」。
  const provider = createOpenAIProvider({
    endpoint: ENDPOINT,
    apiKey: "k",
    model,
    fetchImpl,
    ...(config.reasoning_effort === undefined ? {} : { reasoning_effort: config.reasoning_effort }),
  });
  /** @type {string[]} */
  const notices = [];
  /** @type {string[]} */
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => { logged.push(args.join(" ")); };
  /** @type {any} */
  let result;
  /** @type {any} */
  let thrown;
  try {
    result = await runChat({
      prompt: "say ok",
      session: "t798",
      dir,
      cwd,
      provider,
      configPath: mcpConfigPath,
      config: { endpoint: ENDPOINT, apiKey: "k", model, ...config },
      maxRounds: 1,
      reflection: false,
      idleTimeout: 0,
      effort,
      noticeLog: (line) => notices.push(line),
      toolOutput: () => {},
      _assemblyRoot: {
        archiveDir: join(dir, "outputs"),
        diagnostics: { error() {} },
        notesDir,
        notesStore: createFileNotesStore({ dir: notesDir }),
        store,
      },
    });
  } catch (error) {
    // 判据 ④（上游 4xx）走的就是这条路：终局错误必须来自上游，不是 CLI 自己造的。
    thrown = error;
  } finally {
    console.log = originalLog;
  }
  const stdout = logged.join("\n");
  return {
    result,
    thrown,
    body: fetchImpl.calls[0]?.body,
    rounds: await store.load("t798"),
    stdout,
    statsLine: stdout.split("\n").filter((line) => line.includes("=== 统计 ===")).join("\n"),
    notices: notices.join("\n"),
  };
}

// ───────────────── 判据 ②：优先级写死（两种「同时在场」各一条） ─────────────────

test("#798 判据2a：--effort 与 env 同时在场且不同 ⇒ 取旗标（与 --model 的 env 压旗标故意相反）", () => {
  const resolved = resolveReasoningEffort({
    flag: "high",
    env: { LLM_KIT_REASONING_EFFORT: "minimal" },
    slot: "medium",
  });
  assert.deepEqual(resolved, { value: "high", source: "cliFlag", label: "--effort" });
});

test("#798 判据2b：env 与 slot 同时在场且不同 ⇒ 取 env；三处都空 ⇒ 不产键", () => {
  assert.deepEqual(
    resolveReasoningEffort({ flag: undefined, env: { LLM_KIT_REASONING_EFFORT: "high" }, slot: "medium" }),
    { value: "high", source: "cliEnv", label: "LLM_KIT_REASONING_EFFORT" },
  );
  assert.deepEqual(
    resolveReasoningEffort({ flag: "", env: { LLM_KIT_REASONING_EFFORT: "   " }, slot: "" }),
    { value: undefined, source: undefined, label: undefined },
    "空串/纯空白 = 未提供（不是发一个空串）",
  );
});

test("#798 判据2(wire 对账)：旗标压 env、env 压 slot ⇒ 进请求体的正是裁决出来的那个", async () => {
  await withEnv("LLM_KIT_REASONING_EFFORT", "minimal", async () => {
    const flagWins = await chatOnce({ model: QWEN, effort: "high", config: { reasoning_effort: "medium" } });
    assert.equal(flagWins.body?.reasoning_effort, "high", "旗标必须压过 env（也与 env 压过旗标的 --model 相反）");

    const envWins = await chatOnce({ model: QWEN, config: { reasoning_effort: "medium" } });
    assert.equal(envWins.body?.reasoning_effort, "minimal", "env 必须压过 slots.default.reasoning_effort");
  });
});

// ───────────────── 判据 ①：env 通道在轮记录里可辨 ─────────────────

test("#798 判据1：env 在场且 slot 未配 ⇒ 轮记录 source 是本次覆盖通道（不是 slotDefault）", async () => {
  await withEnv("LLM_KIT_REASONING_EFFORT", "high", async () => {
    // (a) 配置面真的消费了这个 env（此前 `bin/config.js` 一个都不读它）。
    // 配置文件里**没配** `reasoning_effort` —— 这正是工单判据 ① 前半句那个「slot 未配」。
    const cfgDir = await sandbox("erix-798-cfg-");
    const configPath = join(cfgDir, "erix.json");
    await writeFile(configPath, JSON.stringify({
      slots: { default: { endpoint: ENDPOINT, apiKey: "k", model: QWEN } },
    }), "utf8");
    const loaded = await loadCliConfig({ configPath });
    assert.deepEqual(loaded.reasoningEffort, {
      value: "high",
      source: "cliEnv",
      label: "LLM_KIT_REASONING_EFFORT",
    }, "env 必须被读，且通道名指向 env 而不是 slot");
    assert.equal(loaded.reasoning_effort, undefined, "slot 未配 ⇒ 不得把 env 的值伪装成 slot 字段");

    // (b) 请求体里真发了出去；(c) 轮记录那格把通道写清楚
    const run = await chatOnce({ model: QWEN, reasoningTokens: 45 });
    assert.equal(run.body?.reasoning_effort, "high");
    const cell = run.rounds.at(-1)?.sentRequestParams?.reasoningEffort;
    assert.deepEqual(cell, { hostValue: "high", sentValue: "high", source: "request" });
    assert.notEqual(cell?.source, "slotDefault", "本次 CLI 覆盖不许与配置文件默认混成一格");
    // (d) 旋钮名不进引擎观测面（契约值域仍是那四个）⇒ 由 CLI 自己在启动行里点名来源
    assert.match(run.notices, /本次值=high/u);
    assert.match(run.notices, /来源=LLM_KIT_REASONING_EFFORT/u);
  });
});

test("#798 判据1(反证)：只有 slot 配了 ⇒ 那格仍是 slotDefault（覆盖与默认分得开），来源行点名 slot", async () => {
  await withEnv("LLM_KIT_REASONING_EFFORT", undefined, async () => {
    const run = await chatOnce({ model: QWEN, config: { reasoning_effort: "medium" } });
    assert.equal(run.body?.reasoning_effort, "medium");
    assert.equal(run.rounds.at(-1)?.sentRequestParams?.reasoningEffort.source, "slotDefault");
    // 仍打一行来源（旋钮名只活在 CLI 这一侧，不进引擎观测面）
    assert.match(run.notices, /\u6765\u6e90=slots\.default\.reasoning_effort/u);
  });
});

// ───────────── 承重墙：GLM 的 none→low 必须肉眼可见（ADR-017，一字没改） ─────────────

test("#798 承重墙：旗标给 none 且模型是 GLM ⇒ hostValue/sentValue/translated/source 四格同时成立", async () => {
  await withEnv("LLM_KIT_REASONING_EFFORT", undefined, async () => {
    const run = await chatOnce({ model: GLM, effort: "none", reasoningTokens: 0 });
    assert.equal(run.body?.reasoning_effort, "low", "payload 层那条翻译一字没动（裸发 none 上游 400）");
    assert.deepEqual(run.rounds.at(-1)?.sentRequestParams?.reasoningEffort, {
      hostValue: "none",
      sentValue: "low",
      source: "request",
      translated: true,
    });
    assert.match(run.statsLine, /effort=none→low/u, "设的值 → 实际发的值必须肉眼可见");
  });
});

// ───────────────── 判据 ③：有事实才有格 ─────────────────

test("#798 判据3：上游回报 reasoning_tokens=45 ⇒ 统计行打得出分解", async () => {
  await withEnv("LLM_KIT_REASONING_EFFORT", undefined, async () => {
    const run = await chatOnce({ model: QWEN, reasoningTokens: 45 });
    assert.equal(run.rounds.at(-1)?.response?.usage?.reasoningTokens, 45);
    assert.match(run.statsLine, /reasoningTokens=45/u);
    assert.equal(run.stdout.split("\n").filter((l) => l.includes("=== 统计 ===")).length, 1,
      "统计行仍必须恰好一行且是终局输出（靠尾行取数的脚本不受影响）");
  });
});

test("#798 判据3(反向证)：上游没回报 ⇒ 输出里连字段名都不出现（绝不打 0 冒充「没思考」）", async () => {
  await withEnv("LLM_KIT_REASONING_EFFORT", "high", async () => {
    const run = await chatOnce({ model: QWEN, reasoningTokens: undefined });
    assert.equal(
      Object.hasOwn(run.rounds.at(-1)?.response?.usage ?? {}, "reasoningTokens"),
      false,
      "没回报就没有这一格",
    );
    // ⚠ 反向证断言的是**不出现**，不是 `reasoningTokens=0`。
    assert.doesNotMatch(run.stdout, /reasoningTokens/u);
    assert.doesNotMatch(run.stdout, /effort=/u, "没发生翻译就不打 effort=");
    assert.match(run.statsLine, /=== 统计 === model=qwen3\.8-flash-next rounds=/u, "那一行的老形状逐字不变");
  });
});

test("#798 判据3(真 0)：上游回报 0 是真测量，照打不误", async () => {
  await withEnv("LLM_KIT_REASONING_EFFORT", undefined, async () => {
    const run = await chatOnce({ model: QWEN, effort: "low", reasoningTokens: 0 });
    assert.match(run.statsLine, /reasoningTokens=0/u);
  });
});

// ───────────────── 判据 ④：非法值不在 CLI 崩 ─────────────────

test("#798 判据4：非法值不在 CLI 崩——请求照发，上游 4xx 原文透出，CLI 不自己编一句", async () => {
  const upstreamMessage = "unsupported reasoning effort value, ensure that your valid "
    + "reasoning effort is within [none, minimal, low, medium, high]";
  await withEnv("LLM_KIT_REASONING_EFFORT", undefined, async () => {
    // 解析期不挡（没有本地枚举 ⇒ 没有任何一处会抢在上游前面报错）
    assert.equal(parseChatArgs(["p", "--effort", "ultra"]).effort, "ultra");
    assert.equal(parseReplArgs(["--effort", "ultra"]).effort, "ultra");

    const run = await chatOnce({
      model: QWEN,
      effort: "ultra",
      status: 400,
      body: JSON.stringify({ error: { message: upstreamMessage } }),
    });
    assert.equal(run.body?.reasoning_effort, "ultra", "值原样透传：它真的进了 wire body");
    assert.ok(run.thrown !== undefined, "终局是上游的 4xx，而不是 CLI 自己拦下");
    const text = `${run.thrown?.message ?? ""}|${JSON.stringify(run.thrown?.termination ?? "")}|${run.stdout}`;
    assert.match(text, /unsupported reasoning effort value/u, "上游原文必须原样透出来");
    assert.doesNotMatch(text, /不支持的?\s*effort|effort\s*(取值)?不合法|非法\s*effort/u,
      "CLI 不许自己编一句「值不合法」（那会把上游的合法清单抹掉）");
  });
});

// ───────────────── 旗标本身（含 `--effort ""` 的口径） ─────────────────

test("#798 旗标：chat/repl 都收 --effort；--effort \"\" 是「未提供」而不是发空串", () => {
  assert.equal(parseChatArgs(["p", "--effort", "high"]).effort, "high");
  assert.equal(parseReplArgs(["--effort", "high"]).effort, "high");
  assert.equal(
    resolveReasoningEffort({ flag: parseChatArgs(["p", "--effort", ""]).effort }).value,
    undefined,
    "--effort \"\" ⇒ 不发字段",
  );
  assert.throws(() => parseChatArgs(["p", "--effort"]), /缺少数值/u);
  assert.throws(() => parseReplArgs(["--effort"]), /缺少数值/u);
});

// ───────── 评审附加：包装层的防漂移守卫（漏转发就红） ─────────

test("#798 防漂移：被钉表的 provider 成员全部可见，函数成员真转到底层", async () => {
  /** @type {Array<[string, any]>} */
  const invoked = [];
  const underlying = {
    protocol: "openai",
    model: "some-model",
    model_type: "chat",
    supports_reasoning: true,
    thinking_format: "deepseek",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    chat: async (/** @type {any} */ req) => { invoked.push(["chat", req]); return { ok: "chat" }; },
    chatStream: async (/** @type {any} */ req) => { invoked.push(["chatStream", req]); return { ok: "stream" }; },
    // 表里**没登记**的成员：包装层若改成手写逐字段复制，这条就会红（转发层典型的死法）。
    probeStreamUsage: async (/** @type {any} */ req) => { invoked.push(["probeStreamUsage", req]); return 1; },
  };
  // 表本身钉住：将来 provider 长出新成员而没人登记 ⇒ 这条红，逼人来补这一格。
  assert.deepEqual([...PROVIDER_MEMBER_SURFACE].sort(), [
    "chat",
    "chatStream",
    "contextWindowTokens",
    "maxOutputTokens",
    "model",
    "model_type",
    "protocol",
    "supports_reasoning",
    "thinking_format",
  ]);

  const wrapped = withCliReasoningEffort(underlying, "high");
  for (const member of PROVIDER_MEMBER_SURFACE) {
    assert.equal(typeof wrapped[member], typeof underlying[member], `包装层丢了成员 ${member}`);
    if (member === "chat" || member === "chatStream") continue;
    assert.deepEqual(wrapped[member], underlying[member], `成员 ${member} 的值被包装层改了`);
  }
  assert.equal(typeof wrapped.probeStreamUsage, "function");
  assert.equal((await wrapped.chat({ maxTokens: 1 })).ok, "chat");
  assert.equal((await wrapped.chatStream({})).ok, "stream");
  assert.equal(await wrapped.probeStreamUsage({}), 1);
  assert.deepEqual(invoked.map(([name]) => name), ["chat", "chatStream", "probeStreamUsage"]);
  // 注的正是裁决出来的那个值，且不吞掉调用方原有的请求字段
  assert.deepEqual(invoked[0][1], { maxTokens: 1, reasoning_effort: "high" });
  assert.deepEqual(invoked[1][1], { reasoning_effort: "high" });
  // 没给值 ⇒ 原对象原样返回（零行为变化：不配就与接线前逐字一致）
  assert.equal(withCliReasoningEffort(underlying, undefined), underlying);
});

test("#798 统计器口径：没事实就是空串，翻译只记一次", () => {
  const stats = createReasoningEffortStats();
  assert.equal(stats.format(), "", "没事实就是空串（不是 reasoningTokens=0）");
  stats.observe({
    response: { usage: { reasoningTokens: 7 } },
    sentRequestParams: { reasoningEffort: { hostValue: "none", sentValue: "low", source: "request", translated: true } },
  });
  stats.observe({
    response: { usage: {} },
    sentRequestParams: { reasoningEffort: { hostValue: "none", sentValue: "low", source: "request", translated: true } },
  });
  assert.equal(stats.format(), "reasoningTokens=7 effort=none→low");
});
