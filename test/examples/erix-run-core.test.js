// erix_run core 的单测：全部离线（fake provider / 注入的 fake lib），不触网、不碰 ~/.erix。
//
// 覆盖面（对应任务书的验收点）：
//   1. 参数 → runToolLoop 选项装配
//   2. abort → 结构化终局载荷（#180：读 error.usage/rounds/finalText）
//   3. observer 错误计数
//   4. 配置缺失的报错形状
// 外加：lib 装载回退顺序、超时标注、载荷格式化。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMemoryTranscriptStore, createFileTranscriptStore, createJsonFileModelConfigProvider, runToolLoop } from "../../src/index.js";
import { safeRunId } from "../../src/store/file.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import * as core from "../../examples/pi-extension/erix-run-core.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function tempDir(prefix = "erix-run-core-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function waitUntil(predicate, { timeoutMs = 2_000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function fakeSlot(overrides = {}) {
  return {
    slot: {
      endpoint: "https://relay.example/v1",
      model: "slot-model",
      apiKey: "k",
      contextWindowTokens: 200_000,
      maxOutputTokens: 4_096,
      ...overrides,
    },
    configPath: "/tmp/fake-erix-config.json",
  };
}

function fakeLib(overrides = {}) {
  return {
    source: "fake://lib",
    libEntry: "/fake/src/index.js",
    binToolsEntry: "/fake/bin/tools.js",
    index: {
      runToolLoop,
      createMemoryTranscriptStore,
      // #207 R3：落盘要拿这个造文件 store；fakeDeps 默认不传 sessionDir，所以不会被调到。
      createFileTranscriptStore,
      createJsonFileModelConfigProvider,
      createOpenAIProvider: (config) => ({ ...config, chat: async () => ({ content: [], stopReason: "end_turn" }) }),
    },
    binTools: {
      buildCliToolsSystemPrompt: ({ todo }) => `TOOLS(todo=${todo === false ? "off" : "on"})`,
      createCliTools: () => ({ tools: [], executeTool: async () => "unused", truncateResult: (t) => t }),
      truncateResult: (text) => text,
    },
    ...overrides,
  };
}

/** 组装一个「装配齐活」的 deps：注入 fake lib/slot/provider/assembly/store，真跑 runToolLoop。 */
function makeDeps({ provider, lib = fakeLib(), slot = fakeSlot(), captured, progress, extra = {} }) {
  return {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => lib,
    loadSlot: async () => slot,
    createProvider: () => provider,
    createAssembly: () => ({ tools: [], executeTool: async () => "tool-ok" }),
    createStore: () => createMemoryTranscriptStore(),
    runLoop: (options) => {
      if (captured) captured.options = options;
      return runToolLoop(options);
    },
    ...(progress === undefined ? {} : { onProgress: progress }),
    ...extra,
  };
}

test("parseRunParams：默认值、~ 展开、逐项校验", () => {
  const parsed = core.parseRunParams({ task: "  修好 it  ", cwd: "/tmp" });
  assert.deepEqual(parsed, {
    task: "修好 it",
    cwd: "/tmp",
    maxRounds: core.DEFAULT_MAX_ROUNDS,
    timeoutMs: core.DEFAULT_TIMEOUT_MS,
  });

  const fakeHome = tempDir("erix-run-home-");
  mkdirSync(path.join(fakeHome, "somewhere"));
  const withHome = core.parseRunParams({ task: "t", cwd: "~/somewhere" }, { home: fakeHome });
  assert.equal(withHome.cwd, path.join(fakeHome, "somewhere"));

  const tuned = core.parseRunParams({
    task: "t", cwd: "/tmp", maxRounds: 12, timeoutMs: 5_000, strategy: "fold-llm", model: " other ",
  });
  assert.equal(tuned.maxRounds, 12);
  assert.equal(tuned.timeoutMs, 5_000);
  assert.equal(tuned.strategy, "fold-llm");
  assert.equal(tuned.model, "other");

  for (const [raw, code] of [
    [{ cwd: "/tmp" }, "bad_params"],
    [{ task: "t" }, "bad_params"],
    [{ task: "t", cwd: "relative/dir" }, "bad_params"],
    [{ task: "t", cwd: "/tmp", strategy: "nope" }, "bad_params"],
    [{ task: "t", cwd: "/tmp", maxRounds: 0 }, "bad_params"],
    [{ task: "t", cwd: "/tmp", maxRounds: 9999 }, "bad_params"],
    [{ task: "t", cwd: "/tmp", timeoutMs: -1 }, "bad_params"],
    [{ task: "t", cwd: path.join(tmpdir(), "definitely-not-here-erix-run") }, "bad_cwd"],
  ]) {
    assert.throws(() => core.parseRunParams(raw), (error) => {
      assert.equal(error.name, "ErixRunError");
      assert.equal(error.code, code);
      assert.equal(error.stage, "assembly");
      return true;
    }, `expected ${code} for ${JSON.stringify(raw)}`);
  }
});

test("resolveLibCandidates/loadErixAgent：ERIX_AGENT_LIB 优先，其次裸包名，都失败则 lib_missing", async () => {
  const { entries, tried } = core.resolveLibCandidates({ env: { ERIX_AGENT_LIB: repoRoot } });
  assert.equal(entries[0].libEntry, path.join(repoRoot, "src", "index.js"));
  assert.equal(entries[0].libRoot, repoRoot);
  assert.equal(entries[1].libEntry, "erix-agent");
  assert.deepEqual(tried, [repoRoot, "erix-agent"]);

  const loaded = await core.loadErixAgent({ env: { ERIX_AGENT_LIB: repoRoot } });
  assert.equal(loaded.libRoot, repoRoot);
  assert.equal(loaded.binToolsEntry, path.join(repoRoot, "bin", "tools.js"));
  assert.equal(typeof loaded.index.runToolLoop, "function");
  assert.equal(typeof loaded.index.createOpenAIProvider, "function");
  // 内置工具装配复用 bin/tools.js 的同一个函数，不复制实现
  assert.equal(typeof loaded.binTools.createCliTools, "function");
  assert.equal(typeof loaded.binTools.buildCliToolsSystemPrompt, "function");

  // env 指向不存在的目录 → 回退裸包名（此仓未自装 erix-agent，故两路皆空 → 明确报错而非崩）
  const failures = [];
  await assert.rejects(
    core.loadErixAgent({
      env: { ERIX_AGENT_LIB: path.join(tmpdir(), "no-such-erix-checkout") },
      importModule: async (specifier) => {
        failures.push(specifier);
        throw new Error(`cannot import ${specifier}`);
      },
    }),
    (error) => {
      assert.equal(error.code, "lib_missing");
      assert.match(error.message, /ERIX_AGENT_LIB/u);
      assert.match(error.message, /erix-agent/u);
      assert.ok(error.detail.includes("cannot import erix-agent"));
      return true;
    },
  );
  assert.deepEqual(failures, ["erix-agent"]);
});

test("loadModelSlot：slots.default + apiKeyEnv 落值 + model 覆盖 + 元数据缺失诊断", async () => {
  const dir = tempDir();
  const lib = { createJsonFileModelConfigProvider: core_loadJsonProvider };

  const goodPath = path.join(dir, "good.json");
  writeFileSync(goodPath, JSON.stringify({
    slots: {
      default: {
        endpoint: "https://relay.example/v1",
        model: "slot-model",
        apiKeyEnv: "ERIX_RUN_TEST_KEY",
        contextWindowTokens: 131_072,
        maxOutputTokens: 32_768,
      },
      cheap: { endpoint: "https://other/v1", model: "cheap-model", apiKey: "cheap" },
    },
  }), "utf8");

  process.env.ERIX_RUN_TEST_KEY = "from-env";
  const loaded = await core.loadModelSlot({ lib, configPath: goodPath, modelOverride: "override-model" });
  assert.equal(loaded.slot.model, "override-model");
  assert.equal(loaded.slot.apiKey, "from-env");
  assert.equal(loaded.slot.contextWindowTokens, 131_072);
  assert.equal(loaded.metadataMissing, undefined, "元数据齐全时不给缺失诊断");

  // 预算元数据缺失（#182：compaction 与聚合输出预算整轮关闭）→ 明确诊断，不静默
  const barePath = path.join(dir, "bare.json");
  writeFileSync(barePath, JSON.stringify({
    slots: { default: { endpoint: "https://relay.example/v1", model: "m", apiKey: "k" } },
  }), "utf8");
  const bare = await core.loadModelSlot({ lib, configPath: barePath });
  assert.equal(bare.metadataMissing.source, "config");
  assert.deepEqual(bare.metadataMissing.missingFields, ["contextWindowTokens", "maxOutputTokens"]);
  assert.match(bare.metadataMissing.detail, /compaction and aggregate output budget are disabled/u);

  // 配置缺失：报 config_missing 且消息里带路径（可用 ERIX_CONFIG_PATH 改路径）
  const missing = path.join(dir, "nope.json");
  await assert.rejects(core.loadModelSlot({ lib, configPath: missing }), (error) => {
    assert.equal(error.code, "config_missing");
    assert.ok(error.message.includes(missing));
    assert.match(error.message, /ERIX_CONFIG_PATH/u);
    return true;
  });

  // 槽位不存在 / 必填字段缺失：config_invalid
  const noSlot = path.join(dir, "no-slot.json");
  writeFileSync(noSlot, JSON.stringify({ slots: {} }), "utf8");
  await assert.rejects(core.loadModelSlot({ lib, configPath: noSlot }), (error) => {
    assert.equal(error.code, "config_invalid");
    assert.ok(error.message.includes(noSlot));
    return true;
  });

  const noKey = path.join(dir, "no-key.json");
  writeFileSync(noKey, JSON.stringify({
    slots: { default: { endpoint: "https://relay.example/v1", model: "m" } },
  }), "utf8");
  await assert.rejects(core.loadModelSlot({ lib, configPath: noKey }), (error) => {
    assert.equal(error.code, "config_invalid");
    assert.match(error.message, /apiKey/u);
    return true;
  });

  delete process.env.ERIX_RUN_TEST_KEY;
});

// 直接用库里的 json-file provider（loadModelSlot 只依赖这一个入口）
function core_loadJsonProvider({ path: configPath }) {
  return createJsonFileModelConfigProvider({ path: configPath });
}

test("buildLoopOptions：参数 → runToolLoop 选项装配（策略名/预算元数据/观察者/生命周期）", () => {
  const controller = new AbortController();
  const provider = { chat: async () => ({ content: [], stopReason: "end_turn" }) };
  const store = createMemoryTranscriptStore();
  const assembly = { tools: [{ name: "exec" }], executeTool: async () => "ok" };

  const options = core.buildLoopOptions({
    params: {
      task: "修 bug", cwd: "/work/proj", maxRounds: 9, timeoutMs: 60_000, strategy: "fold-statistical",
    },
    slot: fakeSlot().slot,
    provider,
    tools: assembly,
    store,
    signal: controller.signal,
    runId: "run-1",
    system: "SYS",
    onEvent: () => {},
    onObserverError: () => {},
    diagnostics: { error: () => {} },
    reflection: false,
  });

  assert.equal(options.provider, provider);
  assert.equal(options.system, "SYS");
  assert.equal(options.initialUserMessage, "修 bug");
  assert.equal(options.task, "修 bug", "契约要求显式传 task 作为简报来源");
  assert.equal(options.tools, assembly.tools);
  assert.equal(options.executeTool, assembly.executeTool);
  assert.equal(options.maxRounds, 9);
  assert.equal(options.timeoutMs, 60_000);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.store, store);
  assert.equal(options.runId, "run-1");
  assert.equal(options.wrapup, false, "对话型宿主不收 JSON 信封");
  assert.equal(options.stream, false);
  assert.equal(options.reflection, false);
  assert.equal(options.context.strategy, "fold-statistical", "#167：内置名字交给引擎实例化");
  assert.deepEqual(options.modelMetadata, { contextWindowTokens: 200_000, maxOutputTokens: 4_096 });
  assert.equal(typeof options.onEvent, "function");
  assert.equal(typeof options.onObserverError, "function");
  assert.deepEqual(options.completion.signals.slice(0, 1), ["任务已完成"]);
  assert.equal(options.completion.maxNoToolRounds, 3);

  // 无 strategy / 元数据不齐 → 两个字段都不给（#182：跨候选不合并，缺一个不如不给）
  const bare = core.buildLoopOptions({
    params: { task: "t", cwd: "/w", maxRounds: 8, timeoutMs: 1000 },
    slot: { endpoint: "e", model: "m", apiKey: "k", contextWindowTokens: 100 },
    provider,
    tools: assembly,
    store,
    signal: controller.signal,
    runId: "run-2",
  });
  assert.equal("context" in bare, false);
  assert.equal("modelMetadata" in bare, false);
  assert.equal("reflection" in bare, false, "reflection 未指定时交给引擎缺省");
  assert.equal("onObserverError" in bare, false);
});

test("runErixRun：正常路径产出结构化载荷（finalText/rounds/usage/termination/diagnostics）", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "node -t" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 2 },
    },
    { content: [{ type: "text", text: "任务已完成：修好了 a.js 第 2 行" }], stopReason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } },
  ]);
  const captured = {};
  const progressLines = [];
  const payload = await core.runErixRun(
    { task: "修 bug", cwd: repoRoot, maxRounds: 6, strategy: "sliding-window" },
    makeDeps({
      provider,
      captured,
      progress: (line) => progressLines.push(line),
      extra: { configPath: "/tmp/whatever.json" },
    }),
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.termination.reason, "end_turn");
  assert.equal(payload.truncated, false);
  assert.equal(payload.timeout, false);
  assert.equal(payload.aborted, false);
  assert.match(payload.finalText, /修好了/u);
  assert.equal(payload.rounds, 2);
  assert.equal(payload.rounds, 2);
  assert.deepEqual(payload.usage, { input_tokens: 15, output_tokens: 5 });
  assert.equal(payload.diagnostics.observerErrors.count, 0);
  assert.equal(payload.diagnostics.modelMetadataMissing, null);
  assert.equal(payload.diagnostics.model, "slot-model");
  assert.equal(payload.diagnostics.strategy, "sliding-window");
  assert.equal(payload.diagnostics.libSource, "fake://lib");
  assert.equal(payload.diagnostics.timeoutMs, core.DEFAULT_TIMEOUT_MS);
  assert.equal(payload.diagnostics.compaction.events, 0);

  // 装配确实落到 runToolLoop 手上
  assert.equal(captured.options.maxRounds, 6);
  assert.equal(captured.options.context.strategy, "sliding-window");
  assert.deepEqual(captured.options.modelMetadata, { contextWindowTokens: 200_000, maxOutputTokens: 4_096 });
  assert.match(captured.options.system, /TOOLS\(todo=off\)/u);
  assert.match(captured.options.system, /工作目录 /u);

  // 进度通道拿到了轮次与工具事件
  const joined = progressLines.join("\n");
  assert.match(joined, /erix_run 启动/u);
  assert.match(joined, /round 1 开始/u);
  assert.match(joined, /→ exec/u);
  assert.match(joined, /erix_run 结束：termination=end_turn/u);
});

test("runErixRun：abort → 结构化终局载荷读 #180 抛错载荷（usage/rounds/finalText 不归零）", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      calls += 1;
      if (calls > 1) return new Promise(() => {}); // 第二轮永悬，由 abort 抢输
      return {
        content: [{ type: "tool_use", id: `c${calls}`, name: "exec", input: { command: "sleep 1" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 120, output_tokens: 30 },
      };
    },
  };
  const captured = {};
  const lines = [];
  const run = core.runErixRun(
    { task: "改点什么", cwd: repoRoot },
    { ...makeDeps({ provider, captured }), signal: controller.signal, onProgress: (line) => lines.push(line) },
  );

  await waitUntil(() => calls >= 2);
  controller.abort(new Error("user stopped"));
  const payload = await run;

  assert.equal(payload.ok, false);
  assert.equal(payload.termination.reason, "aborted");
  assert.equal(payload.aborted, true);
  assert.equal(payload.timeout, false);
  assert.equal(payload.termination.partial, true);
  // #180：中止的 run 真的花过 token，用量/轮号必须从抛错载荷里读回来
  assert.equal(payload.usage.input_tokens, 120);
  assert.equal(payload.usage.output_tokens, 30);
  assert.equal(payload.rounds, 1);
  assert.equal(typeof payload.finalText, "string");
  assert.match(lines.join("\n"), /erix_run 终局（抛错路径）：aborted/u);
});

test("runErixRun：timeoutMs 到点硬 abort 并标注 timeout", async () => {
  const provider = {
    async chat() {
      return new Promise(() => {});
    },
  };
  const lines = [];
  const payload = await core.runErixRun(
    { task: "长跑", cwd: repoRoot, timeoutMs: core.MIN_TIMEOUT_MS },
    makeDeps({ provider, progress: (line) => lines.push(line) }),
  );
  assert.equal(payload.timeout, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.termination.reason, "aborted");
  assert.deepEqual(payload.usage, { input_tokens: 0, output_tokens: 0 }, "#180：零值而非缺字段");
  assert.match(lines.join("\n"), new RegExp(`超时 ${core.MIN_TIMEOUT_MS}ms`, "u"));
});

test("runErixRun：观察者抛错只计数不杀 run（进度通道自防 + 引擎错账户入档）", async () => {
  // (a) 进度通道（pi 的 onUpdate）抛错：run 必须跑完，错只进 diagnostics.observerErrors
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "任务已完成：好了" }], stopReason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } },
  ]);
  const captured = {};
  const payload = await core.runErixRun(
    { task: "t", cwd: repoRoot },
    makeDeps({
      provider,
      captured,
      progress: () => {
        throw new Error("onUpdate exploded");
      },
    }),
  );

  assert.equal(payload.ok, true, "观察者抛错不得改变终局");
  assert.equal(payload.termination.reason, "end_turn");
  assert.ok(payload.diagnostics.observerErrors.count >= 1);
  assert.equal(payload.diagnostics.observerErrors.samples[0].channel, "onProgress");
  assert.equal(payload.diagnostics.observerErrors.samples[0].message, "onUpdate exploded");

  // (b) 引擎隔离观察者抛错后经 onObserverError 上报的错，以及持久化错误，同样只能计数
  const engineReported = await core.runErixRun({ task: "t", cwd: repoRoot }, {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => fakeLib(),
    loadSlot: async () => fakeSlot(),
    createProvider: () => createFakeProvider([]),
    createAssembly: () => ({ tools: [], executeTool: async () => "ok" }),
    createStore: () => createMemoryTranscriptStore(),
    runLoop: async (options) => {
      // 模拟引擎的错账户上报（docs/host-consumer-contract.md「Observer callback errors」）
      options.onObserverError(new Error("engine-reported"), { channel: "onJudge", round: 3, type: "judge" });
      options.onPersistenceError(new Error("store down"));
      return {
        finalText: "ok",
        rounds: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
        termination: { reason: "end_turn" },
        verification: { status: "skipped" },
        compactionStats: [],
      };
    },
  });

  assert.equal(engineReported.ok, true);
  assert.equal(engineReported.diagnostics.observerErrors.count, 1);
  assert.deepEqual(
    {
      channel: engineReported.diagnostics.observerErrors.samples[0].channel,
      round: engineReported.diagnostics.observerErrors.samples[0].round,
    },
    { channel: "onJudge", round: 3 },
  );
  assert.equal(engineReported.diagnostics.persistenceErrors.count, 1);
  assert.equal(engineReported.diagnostics.persistenceErrors.samples[0].message, "store down");
});

test("runErixRun：引擎抛错路径同样给出结构化载荷（termination/usage/rounds 齐全）", async () => {
  // fake provider 脚本耗尽 → 引擎在 run 生命周期内抛错
  const provider = createFakeProvider([]);
  const payload = await core.runErixRun(
    { task: "t", cwd: repoRoot },
    makeDeps({ provider }),
  );

  assert.equal(payload.ok, false);
  assert.equal(payload.termination.reason, "failed");
  assert.equal(typeof payload.termination.detail, "string");
  assert.equal(payload.termination.errorCode, "unknown", "#176：错误没带分类时不发明 errorCode");
  assert.deepEqual(payload.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(payload.rounds, 0);
  assert.equal(payload.finalText, "");
  assert.match(payload.error.message, /Fake provider script exhausted/u);
});

test("runErixRun：装配期失败（库缺失 / 配置缺失）不抛给调用方，转成 ok:false + code", async () => {
  const libMissing = await core.runErixRun({ task: "t", cwd: repoRoot }, {
    env: {},
    home: "/tmp/fake-home",
    loadLib: () => {
      throw new core.ErixRunError("lib_missing", "找不到 erix-agent 库");
    },
  });
  assert.equal(libMissing.ok, false);
  assert.equal(libMissing.error.code, "lib_missing");
  assert.equal(libMissing.error.stage, "assembly");
  assert.deepEqual(libMissing.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(libMissing.termination.reason, "failed");

  const configMissing = await core.runErixRun({ task: "t", cwd: repoRoot }, {
    env: {},
    home: "/tmp/fake-home",
    loadLib: async () => fakeLib(),
    // 不注入 loadSlot：走真实 loadModelSlot，指向一个不存在的路径
    configPath: path.join(tmpdir(), "definitely-missing-erix-config.json"),
    createProvider: () => {
      throw new Error("provider 不该被构造");
    },
  });
  assert.equal(configMissing.ok, false);
  assert.equal(configMissing.error.code, "config_missing");
  assert.match(configMissing.error.message, /模型配置不存在/u);
  assert.equal(configMissing.diagnostics.observerErrors.count, 0);

  const badParams = await core.runErixRun({ task: "", cwd: "relative" }, { env: {}, home: "/tmp/fake-home" });
  assert.equal(badParams.ok, false);
  assert.equal(badParams.error.code, "bad_params");
});

/** 组装一个「不注入 store」的 deps：#207 R3 的落盘路径必须走真 createFileTranscriptStore。 */
function makeDepsWithoutStore({ provider, lib = fakeLib(), slot = fakeSlot(), captured, extra = {} }) {
  return {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => lib,
    loadSlot: async () => slot,
    createProvider: () => provider,
    createAssembly: () => ({ tools: [], executeTool: async () => "tool-ok" }),
    runLoop: (options) => {
      if (captured) captured.options = options;
      return runToolLoop(options);
    },
    ...extra,
  };
}

const TWO_ROUND_SCRIPT = [
  {
    content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "node -e 1" } }],
    stopReason: "tool_use",
    usage: { input_tokens: 7, output_tokens: 2 },
  },
  { content: [{ type: "text", text: "任务已完成：落了盘" }], stopReason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } },
];

test("#207 R3：safeRunIdForFile 与引擎 safeRunId 逐字同式（算错就是报一个不存在的路径）", () => {
  for (const runId of [
    "run-1",
    "erix-run-2026-10-11T13-30-00-000Z-a1b2c3",
    "a.b.c",
    ".hidden",
    ".",
    "..",
    "run-h-abc",
    "with space",
    "中文目录",
    "a/b",
    "a\\b",
    "",
    "a\"b",
  ]) {
    assert.equal(core.safeRunIdForFile(runId), safeRunId(runId), `safeRunId 分叉：${JSON.stringify(runId)}`);
  }
  // 本层自己生成的 runId 必然落在「可读不哈希」那一支，否则产物路径会变成 run-h-*
  assert.match(core.safeRunIdForFile("erix-run-2026-10-11T13-30-00-000Z-a1b2c3"), /^erix-run-/u);
});

test("#207 R3：sessionDir / transcript 参数解析（缺省不落盘、file 同义、~ 展开、相对路径 bad_params）", () => {
  const home = tempDir("erix-run-home-");
  // 不传 = 纯内存（现有默认语义）
  assert.equal("sessionDir" in core.parseRunParams({ task: "t", cwd: "/tmp" }, { home }), false);
  assert.equal("sessionDir" in core.parseRunParams({ task: "t", cwd: "/tmp", transcript: "" }, { home }), false);
  // 显式「不落盘」别名
  for (const alias of ["memory", "none", "off", "MEMORY"]) {
    assert.equal("sessionDir" in core.parseRunParams({ task: "t", cwd: "/tmp", transcript: alias }, { home }), false);
  }
  // transcript:"file" 的同义写法 → 缺省目录与 AGENTS.md §6 布局一致
  assert.equal(
    core.parseRunParams({ task: "t", cwd: "/tmp", transcript: "file" }, { home }).sessionDir,
    path.join(home, ".erix", "transcripts"),
  );
  // sessionDir：~ 展开 + 绝对路径直用；两个都给时 sessionDir 赢
  assert.equal(
    core.parseRunParams({ task: "t", cwd: "/tmp", sessionDir: "~/sessions" }, { home }).sessionDir,
    path.join(home, "sessions"),
  );
  assert.equal(
    core.parseRunParams({ task: "t", cwd: "/tmp", sessionDir: "/srv/logs", transcript: "file" }, { home }).sessionDir,
    "/srv/logs",
  );
  // 相对路径直接 bad_params（与 cwd 同口径）
  assert.throws(
    () => core.parseRunParams({ task: "t", cwd: "/tmp", sessionDir: "logs/relative" }, { home }),
    (error) => error.code === "bad_params" && /sessionDir/u.test(error.message),
  );
});

test("#207 R3：不传 sessionDir 时一个字节也不落盘（内存行为逐字不变）", async () => {
  const home = tempDir("erix-run-home-");
  const fileStoreCalls = [];
  const lib = fakeLib();
  lib.index.createFileTranscriptStore = (input) => {
    fileStoreCalls.push(input);
    throw new Error("纯内存模式下不得碰文件 store");
  };
  const captured = {};
  const payload = await core.runErixRun(
    { task: "t", cwd: repoRoot, maxRounds: 6 },
    { ...makeDepsWithoutStore({ provider: createFakeProvider(TWO_ROUND_SCRIPT), lib, captured }), home },
  );

  assert.equal(payload.ok, true, `run 必须跑完：${JSON.stringify(payload.termination)}`);
  assert.deepEqual(fileStoreCalls, [], "没给 sessionDir 就不能去造文件 store");
  assert.equal(typeof captured.options.store.appendRound, "function");
  assert.equal(captured.options.onJudge, undefined, "不落盘时不接 judge 观察者");
  assert.deepEqual(readdirSync(home), [], "缺省路径不能在注入的 home 下建任何东西（不污染 ~/.erix）");
  assert.equal(existsSync(path.join(home, ".erix")), false);
});

test("#207 R3：传 sessionDir 时 transcript 真落盘（文件 store，路径由 sessionDir+runId 推出）", async () => {
  const dir = tempDir("erix-run-session-");
  const sessionDir = path.join(dir, "nested", "transcripts");
  const captured = {};
  const payload = await core.runErixRun(
    { task: "落个盘", cwd: repoRoot, maxRounds: 6, sessionDir },
    makeDepsWithoutStore({ provider: createFakeProvider(TWO_ROUND_SCRIPT), captured }),
  );

  assert.equal(payload.ok, true, JSON.stringify(payload.termination));
  assert.equal(typeof captured.options.onJudge, "function", "落盘时必须接上 judge 写入器");
  const runId = payload.diagnostics.runId;
  const transcriptPath = path.join(sessionDir, `${runId}.jsonl`);
  assert.equal(existsSync(transcriptPath), true, `transcript 应在 ${transcriptPath}`);
  const records = readFileSync(transcriptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  // round 0 是引擎开跑前预落的用户轮（resume 锚点），模型轮从 1 开始
  assert.deepEqual(records.map((record) => record.round), [0, 1, 2]);
  assert.match(JSON.stringify(records.at(-1).response.content), /落了盘/u);
  // 落盘只跟 sessionDir 有关，不往 cwd / home 里渗
  assert.deepEqual(readdirSync(dir), ["nested"]);
  // 未落盘与落盘的差：同一个 deps 不传 sessionDir 时目录根本不会被建
  const untouched = tempDir("erix-run-memory-");
  await core.runErixRun(
    { task: "t", cwd: repoRoot },
    { ...makeDepsWithoutStore({ provider: createFakeProvider(TWO_ROUND_SCRIPT) }), home: untouched },
  );
  assert.deepEqual(readdirSync(untouched), []);
});

test("#207 R3：sessionDir 指到一个已存在的文件 → 归一成 bad_params 终局，不抛给调用方", async () => {
  const dir = tempDir("erix-run-bad-dir-");
  const blocker = path.join(dir, "not-a-dir");
  writeFileSync(blocker, "x", "utf8");
  const payload = await core.runErixRun(
    { task: "t", cwd: repoRoot, sessionDir: blocker },
    makeDepsWithoutStore({ provider: createFakeProvider(TWO_ROUND_SCRIPT) }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "bad_params");
  assert.match(payload.error.message, /sessionDir/u);
  assert.equal(payload.termination.reason, "failed");
});

test("#207 R3：judge 决策与 run_outcome 落进 <sessionDir>/outputs/<runId>/judge.log（形状能分辨「不扩」 vs「缺字段」）", async () => {
  const sessionDir = tempDir("erix-run-judge-");
  const payload = await core.runErixRun({ task: "t", cwd: repoRoot, sessionDir }, {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => fakeLib(),
    loadSlot: async () => fakeSlot(),
    createProvider: () => createFakeProvider([]),
    createAssembly: () => ({ tools: [], executeTool: async () => "ok" }),
    runLoop: async (options) => {
      // 三种引擎真实会发的形状：明确不扩 / 没给 extend 字段（fail-closed）/ parse 失败
      options.onJudge({
        round: 3, kind: "round", action: "decline_extend", runId: options.runId, model: "slot-model",
        decision: { done: false, confidence: 0.5, reason: "", evidence: "", extend: false, extendReason: "够了" },
      });
      options.onJudge({
        round: 4, kind: "round", action: "nudge", runId: options.runId, model: "slot-model",
        decision: { done: false, confidence: 0.5, reason: "", evidence: "" },
      });
      options.onJudge({
        round: 5, kind: "round", action: "degraded", error: "parse", decision: null,
        runId: options.runId, model: "slot-model",
      });
      options.onEvent({
        type: "run_outcome", runId: options.runId, model: "slot-model", rounds: 5, judgeRecordCount: 3,
        termination: { reason: "max_rounds_cap" }, verification: { status: "skipped" },
      });
      return {
        finalText: "任务已完成", rounds: 5,
        usage: { input_tokens: 1, output_tokens: 1 }, termination: { reason: "max_rounds_cap" },
      };
    },
  });

  const runId = payload.diagnostics.runId;
  const judgeLogPath = path.join(sessionDir, "outputs", runId, "judge.log");
  assert.equal(existsSync(judgeLogPath), true, `judge.log 应在 ${judgeLogPath}`);
  const lines = readFileSync(judgeLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 4, "三条决策 + 末行 run_outcome 汇总");
  for (const line of lines) {
    assert.equal(line.runId, runId, "每条带 runId（AGENTS.md §6）");
    assert.equal(line.model, "slot-model", "每条带实际 model");
    assert.equal(line.ts, "2023-11-14T22:13:20.000Z");
  }
  assert.equal(lines.at(-1).type, "run_outcome");
  assert.equal("kind" in lines.at(-1), false, "汇总记录不得伪装成决策记录（契约的判别键）");
  assert.equal(lines.at(-1).termination.reason, "max_rounds_cap");
  assert.equal(lines[0].extendDecision, "no");
  assert.equal(lines[0].decision.extend, false, "引擎原字段一字不动");
  assert.equal(lines[1].extendDecision, "missing");
  assert.equal("extend" in lines[1].decision, false, "「缺字段」不能被写入器掩盖成 false");
  assert.equal("extendDecision" in lines[2], false, "degraded（decision:null）不写判别键");
});

test("#207 R3：judge.log 写不进去只记账，不把已跑完的 run 带成 failed", async () => {
  const dir = tempDir("erix-run-judge-broken-");
  const sessionDir = path.join(dir, "transcripts");
  const payload = await core.runErixRun({ task: "t", cwd: repoRoot, sessionDir }, {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => fakeLib(),
    loadSlot: async () => fakeSlot(),
    createProvider: () => createFakeProvider([]),
    createAssembly: () => ({ tools: [], executeTool: async () => "ok" }),
    runLoop: async (options) => {
      // outputs/<runId>/judge.log 位置上站了一个**目录** → append 必炸（ENOTDIR/EISDIR）
      mkdirSync(path.join(sessionDir, "outputs", options.runId, "judge.log"), { recursive: true });
      options.onJudge({ round: 1, kind: "round", decision: { done: true, confidence: 1 }, runId: options.runId });
      return {
        finalText: "ok", rounds: 1, usage: { input_tokens: 1, output_tokens: 1 },
        termination: { reason: "end_turn" },
      };
    },
  });

  assert.equal(payload.ok, true, "审计面写失败不得改变终局");
  assert.equal(payload.diagnostics.persistenceErrors.count, 1);
  assert.equal(payload.diagnostics.persistenceErrors.samples[0].channel, "judgeLog");
});

test("#207 R4：artifacts / extensionCount / maxExtensions / resumable（不落盘时 null，不编造路径）", async () => {
  // ① 纯内存：两个路径都是 null（而不是“猜一个”），resumable 本单一律 false
  const memory = await core.runErixRun(
    { task: "t", cwd: repoRoot },
    makeDepsWithoutStore({ provider: createFakeProvider(TWO_ROUND_SCRIPT) }),
  );
  assert.equal(memory.ok, true);
  assert.deepEqual(memory.artifacts, { transcriptPath: null, judgeLogPath: null });
  assert.equal(memory.extensionCount, 0);
  assert.equal(memory.maxExtensions, 0, "judge 没开启 = 根本没有扩轮额度");
  assert.equal(memory.resumable, false, "R2 未落地，不得声称可续跑");
  assert.equal(core.RESUMABLE, false);
  // 不落盘也不往 diagnostics 里撒谎
  assert.equal(memory.diagnostics.sessionDir, null);
  assert.deepEqual(memory.diagnostics.reflection, { enabled: false, maxExtensions: 0 });

  // ② 落盘：两个路径都是真文件，且等于由 runId 推出来的那个（不是硬编码）
  const sessionDir = tempDir("erix-run-artifacts-");
  const persisted = await core.runErixRun(
    { task: "t", cwd: repoRoot, sessionDir },
    makeDepsWithoutStore({ provider: createFakeProvider(TWO_ROUND_SCRIPT) }),
  );
  assert.equal(persisted.ok, true);
  const runId = persisted.diagnostics.runId;
  assert.equal(
    persisted.artifacts.transcriptPath,
    path.join(sessionDir, `${runId}.jsonl`),
    "transcriptPath 必须由 sessionDir + runId 推出",
  );
  assert.equal(
    persisted.artifacts.judgeLogPath,
    path.join(sessionDir, "outputs", runId, "judge.log"),
    "judgeLogPath 必须由 sessionDir + runId 推出（AGENTS.md §6 布局）",
  );
  for (const value of [persisted.artifacts.transcriptPath, persisted.artifacts.judgeLogPath]) {
    assert.equal(typeof value, "string");
    assert.equal(existsSync(value), true, `artifacts 里的路径必须在盘上：${value}`);
  }
  assert.equal(persisted.diagnostics.sessionDir, sessionDir);
});

test("#207 R4：judge 没跑过（judge.log 未建）时 judgeLogPath 仍是 null，不拿目录当一个产物", async () => {
  const sessionDir = tempDir("erix-run-nojudge-");
  const payload = await core.runErixRun({ task: "t", cwd: repoRoot, sessionDir }, {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => fakeLib(),
    loadSlot: async () => fakeSlot(),
    createProvider: () => createFakeProvider([]),
    createAssembly: () => ({ tools: [], executeTool: async () => "ok" }),
    runLoop: async () => { throw new Error("引擎在发出任何 judge / run_outcome 之前就炸了"); },
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.error.message, "引擎在发出任何 judge / run_outcome 之前就炸了");
  assert.equal(payload.artifacts.judgeLogPath, null, "没落过盘就没有路径");
  assert.equal(payload.artifacts.transcriptPath, null, "fake runLoop 没写任何轮记录");
  assert.equal(payload.resumable, false);
  assert.equal(payload.extensionCount, 0);
});

test("#207 R4：扩轮余量是从引擎回调里数出来的，不是字面量", async () => {
  const payload = await core.runErixRun({ task: "t", cwd: repoRoot, maxRounds: 20 }, {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => fakeLib(),
    loadSlot: async () => fakeSlot(),
    createProvider: () => createFakeProvider([]),
    createAssembly: () => ({ tools: [], executeTool: async () => "ok" }),
    runLoop: async (options) => {
      // 引擎只在真的扩了轮时调 reflection.onReflection
      options.reflection.onReflection({ round: 16, decision: { extend: true }, extendedTo: 28 });
      options.reflection.onReflection({ round: 28, decision: { extend: true }, extendedTo: 40 });
      return {
        finalText: "任务已完成", rounds: 40,
        usage: { input_tokens: 2, output_tokens: 2 }, termination: { reason: "end_turn" },
      };
    },
  });
  assert.equal(payload.extensionCount, 2, "扩了几轮就报几轮");
  assert.equal(payload.maxExtensions, core.ENGINE_DEFAULT_MAX_EXTENSIONS, "未传时生效上限就是引擎缺省");
  assert.equal(payload.resumable, false);
});

test("#207 R4：formatPayloadForModel 把决策事实也交给模型（artifacts / 扩轮余量 / resumable）", () => {
  const withFacts = core.formatPayloadForModel({
    finalText: "ok", rounds: 3, usage: { input_tokens: 1, output_tokens: 1 },
    termination: { reason: "end_turn" },
    artifacts: { transcriptPath: "/srv/logs/run-1.jsonl", judgeLogPath: "/srv/logs/outputs/run-1/judge.log" },
    extensionCount: 1, maxExtensions: 2, resumable: false,
    diagnostics: { observerErrors: { count: 0 }, persistenceErrors: { count: 0 }, compaction: {} },
  });
  assert.match(withFacts, /\[facts\] transcript=\/srv\/logs\/run-1\.jsonl/u);
  assert.match(withFacts, /judgeLog=\/srv\/logs\/outputs\/run-1\/judge\.log/u);
  assert.match(withFacts, /extensions=1\/2/u);
  assert.match(withFacts, /resumable=false/u);
  // 未落盘时给 none，不编一个看起来真的路径
  const bare = core.formatPayloadForModel({
    finalText: "ok", rounds: 1, usage: {}, termination: { reason: "end_turn" },
  });
  assert.match(bare, /\[facts\] transcript=none judgeLog=none extensions=0\/0 resumable=false/u);
});

test("formatPayloadForModel / toPiUsage：交回模型的文本与 pi 用量形状", () => {
  const payload = core.buildSuccessPayload({
    finalText: "改好了，测试通过",
    rounds: 3,
    truncated: false,
    usage: { input_tokens: 1000, output_tokens: 200, cacheRead: 900 },
    termination: { reason: "end_turn" },
    verification: { status: "skipped", reason: "no_final_guard" },
    compactionStats: [{ compacted: true, foldedRounds: 2, tokensBefore: 100, tokensAfter: 40 }],
  }, {
    timeout: false,
    aborted: false,
    observerErrors: [],
    metadataEvents: [{ detail: "contextWindowTokens/maxOutputTokens unavailable; output limit falls back to 4096" }],
    ledgerErrors: [],
    context: { model: "m", strategy: "fold-llm", cwd: "/w", runId: "r", maxRounds: 8, timeoutMs: 1000, elapsedMs: 5 },
  });

  const text = core.formatPayloadForModel(payload);
  assert.match(text, /^改好了，测试通过/u);
  assert.match(text, /termination=end_turn/u);
  assert.match(text, /usage=↑1000\/↓200 cacheR=900\/cacheW=0/u);
  assert.match(text, /compaction=1\/1/u);
  assert.match(text, /model_metadata_missing=YES/u);
  assert.match(text, /output limit falls back to 4096/u);

  assert.deepEqual(core.toPiUsage({ input_tokens: 4, output_tokens: 2, cacheRead: 1 }), {
    input: 4,
    output: 2,
    cacheRead: 1,
    cacheWrite: 0,
    totalTokens: 7,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.equal(core.toPiUsage(undefined), undefined);
  assert.equal(existsSync(path.join(repoRoot, "examples", "pi-extension", "erix-run-core.js")), true);
});
