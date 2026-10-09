// erix_run core 的单测：全部离线（fake provider / 注入的 fake lib），不触网、不碰 ~/.erix。
//
// 覆盖面（对应任务书的验收点）：
//   1. 参数 → runToolLoop 选项装配
//   2. abort → 结构化终局载荷（#180：读 error.usage/rounds/finalText）
//   3. observer 错误计数
//   4. 配置缺失的报错形状
// 外加：lib 装载回退顺序、超时标注、载荷格式化。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMemoryTranscriptStore, createJsonFileModelConfigProvider, runToolLoop } from "../../src/index.js";
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
