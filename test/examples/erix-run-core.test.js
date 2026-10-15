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
// #313：层 id 与观测器直取引擎声明（`COMPACTION_LAYER_IDS` 由 `COMPACTION_PIPELINE` 的 id 派生），
// 单测用它钉住「终局面不许自创层名」。
import { COMPACTION_LAYER_IDS, createEmptyCompactionLayers, observeCompactionLayer } from "../../src/compact/pipeline.js";
import { safeRunId } from "../../src/store/file.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import * as core from "../../examples/pi-extension/erix-run-core.js";
import {
  ENGINE_FINAL_GUARD_MAX_RETRIES,
  FINAL_DRAFT_SECTIONS,
  FINAL_GUARD_TIMEOUT_MS,
} from "../../examples/pi-extension/erix-run-final-guard.js";

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
  assert.deepEqual(memory.diagnostics.reflection, {
    enabled: false, requested: {}, maxExtensions: 0,
  });

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
  const payload = await core.runErixRun({ task: "t", cwd: repoRoot, maxRounds: 20, maxExtensions: 3 }, {
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
  assert.equal(payload.maxExtensions, 3, "maxExtensions 是生效上限，不是已用次数");
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
  // 传了扩轮参数但 judge 没开 → 明说没生效
  const inert = core.formatPayloadForModel({
    finalText: "ok", termination: { reason: "end_turn" }, usage: {},
    diagnostics: { reflection: { enabled: false, requested: { maxExtensions: 5 }, maxExtensions: 0 } },
  });
  assert.match(inert, /扩轮参数未生效/u);
  assert.match(inert, /"maxExtensions":5/u);
});

test("#207 R1：maxExtensions 允许 0（引擎是 >=0 判断，0 = 关掉扩轮是有效配置），其余两个是正整数", () => {
  const tuned = core.parseRunParams({
    task: "t", cwd: "/tmp", maxExtensions: 0, maxRoundsCap: 24, extensionStep: 2,
  });
  assert.equal(tuned.maxExtensions, 0, "0 必须原样保留，不能被当「没传」回落");
  assert.equal(tuned.maxRoundsCap, 24);
  assert.equal(tuned.extensionStep, 2);
  // 不传 = 不往 reflection 里写这三个键（引擎默认值一个不动）
  const bare = core.parseRunParams({ task: "t", cwd: "/tmp" });
  for (const key of core.EXTENSION_PARAM_NAMES) {
    assert.equal(key in bare, false, `不传时不得凭空出现 ${key}`);
  }
  // 非法值一律 bad_params（抛在 parse 层，由 runErixRun 归一成终局）
  for (const raw of [
    { maxExtensions: -1 },
    { maxExtensions: 1.5 },
    { maxExtensions: "abc" },
    { maxExtensions: core.MAX_MAX_EXTENSIONS + 1 },
    { maxRoundsCap: 0 },
    { maxRoundsCap: -2 },
    { extensionStep: 0 },
    { extensionStep: Number.MAX_SAFE_INTEGER + 10 },
  ]) {
    assert.throws(
      () => core.parseRunParams({ task: "t", cwd: "/tmp", ...raw }),
      (error) => error.code === "bad_params" && error.name === "ErixRunError",
      `应当 bad_params：${JSON.stringify(raw)}`,
    );
  }
});

test("#207 R1：三个扩轮参数直传引擎 reflection（含 maxExtensions:0），judge 闸门关着时整体不下发并如实报", async () => {
  const captured = {};
  const zero = await core.runErixRun(
    { task: "t", cwd: repoRoot, maxRounds: 20, maxExtensions: 0, maxRoundsCap: 24, extensionStep: 2 },
    makeDepsWithoutStore({ provider: createFakeProvider([]), captured }),
  );
  assert.deepEqual(
    Object.keys(captured.options.reflection).sort(),
    ["enabled", "extensionStep", "maxExtensions", "maxRoundsCap", "onReflection"],
  );
  assert.equal(captured.options.reflection.maxExtensions, 0, "0 必须真的传给引擎");
  assert.equal(captured.options.reflection.maxRoundsCap, 24);
  assert.equal(captured.options.reflection.extensionStep, 2);
  assert.equal(zero.maxExtensions, 0);
  assert.deepEqual(zero.diagnostics.reflection, {
    enabled: true,
    requested: { maxExtensions: 0, maxRoundsCap: 24, extensionStep: 2 },
    maxExtensions: 0,
  });

  // 不传 → reflection 里只有 enabled + onReflection，引擎默认值一个不覆盖
  const untouched = await core.runErixRun(
    { task: "t", cwd: repoRoot, maxRounds: 20 },
    makeDepsWithoutStore({ provider: createFakeProvider([]), captured }),
  );
  assert.deepEqual(Object.keys(untouched ? captured.options.reflection : {}), ["enabled", "onReflection"]);
  assert.equal(captured.options.reflection.maxExtensions, undefined, "未传不得替引擎填默认值");
  assert.equal(untouched.maxExtensions, core.ENGINE_DEFAULT_MAX_EXTENSIONS, "返回面报的是生效上限（引擎缺省 2）");

  // 闸门关着（maxRounds < 16）→ 三个参数整体不下发，但 diagnostics/模型文本里要说清「没生效」
  const gated = await core.runErixRun(
    { task: "t", cwd: repoRoot, maxExtensions: 5 },
    makeDepsWithoutStore({ provider: createFakeProvider(TWO_ROUND_SCRIPT), captured }),
  );
  assert.equal(captured.options.reflection, false);
  assert.equal(gated.maxExtensions, 0);
  assert.deepEqual(gated.diagnostics.reflection.requested, { maxExtensions: 5 });
  assert.match(core.formatPayloadForModel(gated), /扩轮参数未生效/u);

  // ERIX_NO_REFLECTION=1 仍优先（与改动前同口径）
  await core.runErixRun(
    { task: "t", cwd: repoRoot, maxRounds: 20, maxExtensions: 1 },
    makeDepsWithoutStore({
      provider: createFakeProvider([]), captured, extra: { env: { ERIX_NO_REFLECTION: "1" } },
    }),
  );
  assert.equal(captured.options.reflection, false, "ERIX_NO_REFLECTION=1 依旧把整个 reflection 关掉");
});

test("#207 R1：非法扩轮参数在 runErixRun 里归一成 bad_params 终局（不抛异常、不跑模型）", async () => {
  let providerCalls = 0;
  const provider = {
    async chat() { providerCalls += 1; return { content: [], stopReason: "end_turn" }; },
  };
  for (const raw of [{ maxExtensions: -1 }, { maxRoundsCap: 0 }, { extensionStep: -3 }]) {
    const payload = await core.runErixRun(
      { task: "t", cwd: repoRoot, ...raw },
      makeDepsWithoutStore({ provider }),
    );
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "bad_params", JSON.stringify(raw));
    assert.equal(payload.error.stage, "assembly");
    assert.equal(payload.termination.reason, "failed");
    assert.equal(payload.artifacts.transcriptPath, null);
    assert.equal(payload.resumable, false);
  }
  assert.equal(providerCalls, 0, "参数不合法就不该花模型钱");
});

test("#207 R1：真引擎实测 maxExtensions=0 真的关掉扩轮，maxExtensions=1 真的扩了轮（离线 fake provider）", async () => {
  // 不传 sessionDir，只看终局：同一个 provider 脚本，唯一变量是 maxExtensions。
  const runWith = async (maxExtensions) => {
    const state = { mainCalls: 0, judgePrompts: [] };
    const provider = {
      protocol: "fake",
      model: "fake-model",
      async chat(request) {
        const prompt = request?.messages?.[0]?.content?.[0]?.text ?? "";
        if (prompt.includes('"done":true|false') || prompt.includes("extend=true")) {
          state.judgePrompts.push(prompt);
          const usedOne = prompt.includes("扩轮次数 1/");
          const decision = !prompt.includes("nearLimit 扩轮评估窗口")
            // 未进扩轮窗口：不回答 extend（引擎 fail-closed 不扩）
            ? { done: false, confidence: 0.4, reason: "还有活", evidence: "e", direction: "on_track" }
            : usedOne
              ? { done: true, confidence: 0.9, reason: "做完了", evidence: "e" }
              : { done: false, confidence: 0.5, reason: "没做完", evidence: "e", direction: "on_track", extend: true, extendReason: "上限不够", plan: "继续" };
          return {
            content: [{ type: "text", text: JSON.stringify(decision) }],
            stopReason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        }
        state.mainCalls += 1;
        // 前 15 轮工具有动作，第 16 轮起只出文本（不带完成词，让治理层而非 completion 词表说话）
        return state.mainCalls <= 15
          ? {
            // 命令每轮不同：重复命令会被治理层当成打转（stall），会在扩轮评估之前就收口
            content: [{ type: "tool_use", id: `c${state.mainCalls}`, name: "exec", input: { command: `node -e ${state.mainCalls}` } }],
            stopReason: "tool_use",
            usage: { input_tokens: 50, output_tokens: 5 },
          }
          : {
            content: [{ type: "text", text: "还没收尾，再看一眼日志" }],
            stopReason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 5 },
          };
      },
    };
    const payload = await core.runErixRun(
      { task: "扩轮实测", cwd: repoRoot, maxRounds: 16, maxExtensions, extensionStep: 2, maxRoundsCap: 18 },
      makeDepsWithoutStore({
        provider,
        // 内层工具集要真含 exec（否则 tool_use 会被当未知工具，治理层提前收口，测不到扩轮）
        extra: { createAssembly: () => ({ tools: [{ name: "exec", description: "exec", input_schema: {} }], executeTool: async () => "ok" }) },
      }),
    );
    return { payload, state };
  };

  const blocked = await runWith(0);
  assert.ok(
    blocked.state.judgePrompts.some((prompt) => prompt.includes("扩轮次数 0/0")),
    "maxExtensions=0 必须出现在引擎真的 judge prompt 里（预算行），否则就是没传到",
  );
  assert.equal(blocked.payload.extensionCount, 0, "0 = 一次也不能扩");
  assert.equal(blocked.payload.rounds, 16, "没扩轮就停在原上限");
  assert.equal(blocked.payload.termination.reason, "max_rounds_cap");

  const extended = await runWith(1);
  assert.ok(
    extended.state.judgePrompts.some((prompt) => prompt.includes("扩轮次数 0/1")),
    "maxExtensions=1 同样要出现在真 judge prompt 里",
  );
  assert.ok(
    extended.state.judgePrompts.some((prompt) => prompt.includes("扩轮次数 1/")),
    "扩轮后引擎应当把已用次数记给 judge",
  );
  assert.equal(extended.payload.extensionCount, 1, "扩了一次，extensionCount 从 onReflection 数出来");
  assert.equal(extended.payload.maxExtensions, 1);
  assert.equal(extended.payload.rounds, 17, "16 + extensionStep 2 封顶到 18，judge 在 17 轮判完");
  assert.equal(extended.payload.termination.reason, "judge_done");
  assert.equal(extended.payload.ok, true);
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

// ---------------------------------------------------------------------------
// #234 R0（前置补测）：主 agent 变异实测出两处覆盖缺口，这里把安全网织上。
// 两条断言都刻意钉**字面值**而不是回读同一个常量：回读常量的断言在常量被改错时永远绿，
// 等于没测（反向证见 WORK-REPORT-234.md）。
// ---------------------------------------------------------------------------

test("#234 R0：judge 开着但没传 maxExtensions 时生效上限 = 引擎缺省 2（钉字面值 + 与引擎 prompt 对账）", async () => {
  assert.equal(core.ENGINE_DEFAULT_MAX_EXTENSIONS, 2, "引擎缺省被改就得重新核对 src/loop/orchestrator.js 的 reflectionMaxExtensions");

  // (a) 装配层：闸门开着、三个扩轮参数一个不传 → 生效上限是字面 2，且**不往下发**（不覆盖引擎默认）
  const captured = {};
  const reported = await core.runErixRun({ task: "t", cwd: repoRoot, maxRounds: 20 }, {
    ...makeDepsWithoutStore({ provider: createFakeProvider([]), captured }),
    home: mkdtempSync(path.join(tmpdir(), "erix-run-r0-home-")),
  });
  assert.equal(captured.options.reflection.maxExtensions, undefined, "未传就不得替引擎填默认值");
  assert.equal(
    reported.maxExtensions,
    2,
    "生效上限 = 引擎缺省 2（把 ENGINE_DEFAULT_MAX_EXTENSIONS 改成 0 必须在这里变红）",
  );
  assert.deepEqual(reported.diagnostics.reflection, { enabled: true, requested: {}, maxExtensions: 2 });

  // (b) 引擎侧：与 #207 那条 0/1 vs 1/1 用例同一脚本形状，唯一变量是「不传 maxExtensions」。
  //     judge prompt 的预算行必须写 0/2 —— 钉的是**引擎自己的**缺省，与 (a) 合起来才是一致性
  //     对账，而不是「本层引用一个自己编的常量」。
  const state = { mainCalls: 0, judgePrompts: [], nearLimitAsks: 0 };
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat(request) {
      const prompt = request?.messages?.[0]?.content?.[0]?.text ?? "";
      if (prompt.includes('"done":true|false') || prompt.includes("extend=true")) {
        state.judgePrompts.push(prompt);
        const nearLimit = prompt.includes("nearLimit 扩轮评估窗口");
        if (nearLimit) state.nearLimitAsks += 1;
        // 第一次进扩轮窗口要求扩；之后再问就收（与 #207 那条 0/1 vs 1/1 用例同一脚本形状）
        const decision = !nearLimit
          ? { done: false, confidence: 0.4, reason: "还有活", evidence: "e", direction: "on_track" }
          : state.nearLimitAsks === 1
            ? { done: false, confidence: 0.5, reason: "没做完", evidence: "e", direction: "on_track", extend: true, extendReason: "上限不够", plan: "继续" }
            : { done: true, confidence: 0.9, reason: "做完了", evidence: "e" };
        return {
          content: [{ type: "text", text: JSON.stringify(decision) }],
          stopReason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        };
      }
      state.mainCalls += 1;
      return state.mainCalls <= 15
        ? {
          content: [{ type: "tool_use", id: `c${state.mainCalls}`, name: "exec", input: { command: `node -e ${state.mainCalls}` } }],
          stopReason: "tool_use",
          usage: { input_tokens: 50, output_tokens: 5 },
        }
        : {
          content: [{ type: "text", text: "还没收尾，再看一眼日志" }],
          stopReason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 5 },
        };
    },
  };
  const engineSide = await core.runErixRun(
    { task: "扩轮缺省实测", cwd: repoRoot, maxRounds: 16, extensionStep: 2, maxRoundsCap: 18 },
    makeDepsWithoutStore({
      provider,
      // 内层工具集要真含 exec，否则 tool_use 被当未知工具、治理层在扩轮评估之前就收口
      extra: { createAssembly: () => ({ tools: [{ name: "exec", description: "exec", input_schema: {} }], executeTool: async () => "ok" }) },
    }),
  );
  // home 用 /tmp/fake-home（字符串占位，从不落盘）：这两条用例都不碰真实 ~/.erix
  assert.ok(
    state.judgePrompts.some((prompt) => prompt.includes("扩轮次数 0/2")),
    `引擎自己的缺省就是 2，judge prompt 的预算行必须写 0/2；实际：`
    + JSON.stringify(state.judgePrompts.map((p) => (p.match(/扩轮次数 \S+/gu) ?? ["?"])[0])),
  );
  assert.equal(engineSide.maxExtensions, 2, "引擎用缺省 2 时返回面也必须报 2");
  assert.equal(engineSide.extensionCount, 1, "第一次进扩轮窗口要求扩 → 真的扩了");
  assert.equal(engineSide.termination.reason, "judge_done");
});

test("#234 R0：reflection.onReflection 里注入抛错不得杀 run（契约：它不在观察者隔离名单里）", async () => {
  // 改动前没有任何测试往这条回调里注入过抛错，那条 try/catch 是纯文档承诺。
  // 引擎侧事实：onReflection 只在真的执行了 extend / extend+redirect 时被调，且**不在**
  // docs/host-consumer-contract.md 的观察者隔离名单里 → 抛出去就是杀 run，本层必须自防。
  const seen = [];
  const escaped = [];
  const payload = await core.runErixRun({ task: "t", cwd: repoRoot, maxRounds: 20, maxExtensions: 2 }, {
    ...makeDepsWithoutStore({ provider: createFakeProvider([]) }),
    runLoop: async (options) => {
      // 四个探针：正常 / info 的 getter 抛（模板求值在 try 之内）/ 缺参数 / null
      for (const info of [
        { round: 16, extendedTo: 28 },
        { get round() { throw new Error("info.round exploded"); } },
        undefined,
        null,
      ]) {
        try {
          options.reflection.onReflection(info);
        } catch (error) {
          escaped.push(error?.message ?? String(error));
        }
      }
      return {
        finalText: "任务已完成", rounds: 28,
        usage: { input_tokens: 2, output_tokens: 2 }, termination: { reason: "end_turn" },
      };
    },
    onProgress: (line) => seen.push(line),
  });

  assert.deepEqual(escaped, [], "onReflection 必须一句抛错都不漏出去（漏出去就是杀 run）");
  assert.equal(payload.ok, true, "观察者抛错不得改变终局");
  assert.equal(payload.termination.reason, "end_turn");
  assert.equal(payload.extensionCount, 4, "四次调用都算扩轮：计数不能被播报抛错带走");
  const lines = seen.join("\n");
  assert.match(lines, /↻ 扩轮 1\/2：round 16 → 上限 28/u, "进度播报本身也要发出去");
  // 计数在播报**之前**（钉 try 里的次序）：第一行不能是 0/2
  assert.doesNotMatch(lines, /↻ 扩轮 0\/2/u, "计数必须先于播报，否则抛错那次就丢了一轮计数");
  // 抛错那次只丢它自己那一行播报：第 2 次调用把 round getter 抛掉了 → 直接跳到 3/2
  assert.doesNotMatch(lines, /↻ 扩轮 2\/2/u, "抛错那次不该有播报行");
  assert.match(lines, /↻ 扩轮 3\/2/u, "抛错那次仍然计了数（所以第三次报的是 3/2）");
});

// ---------------------------------------------------------------------------
// #313：erix_run 终局面暴露**分层削减**与 notes 计数（additive，判定语义一律不动）。
// 事故现场：一条 run 里 `ttl` 层折叠 69 次、省下 650,581 tok，而终局面只有
// `compaction=0/1` 这一对比数 ⇒ 宿主把它读成「压缩没生效」，整层收益在终局面上看不见。
// 判据 C3：下面全部是**新增**用例，上面既有的 `compaction=1/1`、`model_metadata_missing=YES`
// 等断言一条没改（`compacted` / `foldedRounds` 的含义与取值不变）。

test("#313 C1：foldedRounds=0 但 ttl 层真削减过 ⇒ 结构与文本里都看得到该层的 triggered/tokensSaved", () => {
  const layers = createEmptyCompactionLayers();
  observeCompactionLayer(layers, "ttl", { triggered: 69, tokensBefore: 700_000, tokensAfter: 49_419 });
  const payload = core.buildSuccessPayload({
    finalText: "任务已完成",
    rounds: 30,
    usage: { input_tokens: 9, output_tokens: 9 },
    termination: { reason: "end_turn" },
    compactionStats: [
      { compacted: false, foldedRounds: 0, tokensBefore: 120_000, tokensAfter: 118_000, layers },
      { compacted: false, foldedRounds: 0, tokensBefore: 130_000, tokensAfter: 130_000, layers: createEmptyCompactionLayers() },
    ],
  }, {
    timeout: false,
    aborted: false,
    observerErrors: [],
    metadataEvents: [],
    ledgerErrors: [],
    context: { model: "m", cwd: "/w", runId: "r" },
  });

  // 判定语义不变：既有三个数还是原来那几个（additive 只在它们旁边加 layers）
  const compaction = payload.diagnostics.compaction;
  assert.equal(compaction.events, 2);
  assert.equal(compaction.compactedRounds, 0);
  assert.equal(compaction.foldedRounds, 0);

  // R1：每个层 id 的 triggered/tokensSaved + 评估条目数 + tokensBefore 峰值
  const summary = compaction.layers;
  assert.equal(summary.byLayerId.ttl.triggered, 69);
  assert.equal(summary.byLayerId.ttl.tokensSaved, 650_581);
  assert.equal(summary.roundsObserved, 2);
  assert.equal(summary.tokensBeforePeak, 130_000);
  // 层 id 一律是引擎声明里的真值：既不自创，也不漏层
  assert.deepEqual(Object.keys(summary.byLayerId).sort(), [...COMPACTION_LAYER_IDS].sort());
  for (const role of summary.roles) {
    assert.deepEqual(role.layerIds.filter((id) => COMPACTION_LAYER_IDS.includes(id)), role.layerIds,
      `归组表出现了不在 COMPACTION_LAYER_IDS 里的层名：${role.key}`);
  }
  assert.equal(summary.roles.find((role) => role.key === "ttlResultFold").triggered, 69);
  assert.equal(summary.roles.find((role) => role.key === "ttlResultFold").tokensSaved, 650_581);
  assert.deepEqual(summary.unattributed, []);

  // R2：整轮折叠 / 逐条 TTL 削减 / 输出钳制**分别命名分别渲染**
  const text = core.formatPayloadForModel(payload);
  assert.match(text, /逐条TTL削减（ttl）=69 次\/650581 tok/u);
  assert.match(text, /整轮折叠（slidingWindow\+foldStatistical\+foldLlm）=0 次\/0 tok/u);
  assert.match(text, /输出钳制（enforceSize）=0 次\/0 tok/u);
  assert.match(text, /tokensBefore 峰值 130000/u);
  // 那个比数不许再被当成结论读
  assert.match(text, /compaction=0\/2（=compactedRounds\/events，不等于「压缩没生效」）/u);

  // #313 追加：终局面自报数据源——汇总读的是 run 返回值那份全量 compactionStats，
  // 而 state.json 那份被 normalizeCompactionStats(value, limit=32) 截尾（issue #315，本单不修）。
  assert.equal(summary.source, core.COMPACTION_STATS_SOURCE);
  assert.match(summary.truncationNote, /normalizeCompactionStats\(value, limit=32\)/u);
  assert.match(summary.truncationNote, /最后 32 条/u);
  assert.match(text, /↳ 来源 runResult\.compactionStats（全量）；若改读 state\.json：/u);
});

test("#313 R1：引擎新增的未知层 id 进 unattributed 并单独渲染，不会被归组表吞掉", () => {
  const summary = core.summarizeCompactionLayers([
    { compacted: false, foldedRounds: 0, tokensBefore: 10, tokensAfter: 5, layers: { futureLayer: { triggered: 3, tokensSaved: 42 } } },
  ]);
  assert.deepEqual(summary.unattributed, [{ layerId: "futureLayer", triggered: 3, tokensSaved: 42 }]);
  assert.equal(summary.roles.find((role) => role.key === "ttlResultFold").triggered, 0);
  assert.match(core.formatCompactionLayerSummary(summary), /futureLayer（未归组层 id）=3 次\/42 tok/u);
});

test("#313 R1/R3：拿不到分层与事件流（老条目 / 装配期就失败）时渲染 unknown，不假称 0", () => {
  const payload = core.buildSuccessPayload({
    finalText: "x",
    rounds: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    termination: { reason: "end_turn" },
    // 0.19 及更早的条目形状：没有 layers 字段
    compactionStats: [{ compacted: true, foldedRounds: 2, tokensBefore: 100, tokensAfter: 40 }],
  }, {
    timeout: false, aborted: false, observerErrors: [], metadataEvents: [], ledgerErrors: [], context: {},
  });

  assert.equal(payload.diagnostics.compaction.layers.roundsObserved, 0);
  assert.equal(payload.diagnostics.notes.observed, false);
  assert.equal(payload.diagnostics.modelMetadataMissingEvents.observed, false);
  const text = core.formatPayloadForModel(payload);
  assert.match(text, /分层削减=unknown（拿到的 compactionStats 条目没有 layers 字段）/u);
  assert.match(text, /notes 写\/读=unknown\/unknown（事件流未建立，没有 tool_use 可数）/u);
  assert.match(text, /model_metadata_missing=no events=unknown/u);
  // 数据源声明与「有没有 layers」无关，unknown 分支也要自报
  assert.match(text, /unknown（拿到的 compactionStats 条目没有 layers 字段）\n  ↳ 来源 runResult\.compactionStats（全量）/u);
});

test("#313 R3：notes 写/读与 model_metadata_missing 事件数从**事件流**取，并进终局面文本", async () => {
  const payload = await core.runErixRun({ task: "t", cwd: repoRoot, maxRounds: 4 }, makeDeps({
    provider: createFakeProvider([]),
    captured: undefined,
    extra: {
      runLoop: async (options) => {
        for (const event of [
          { type: "model_metadata_missing", detail: "no window metadata" },
          { type: "tool_use", toolUse: { name: "note_take" } },
          { type: "tool_use", toolUse: { name: "note_list" } },
          { type: "tool_use", toolUse: { name: "note_read" } },
          { type: "tool_use", toolUse: { name: "note_forget" } },
          { type: "tool_use", toolUse: { name: "readFile" } },
          { type: "tool_use", toolUse: { name: "note_whatever_new" } },
        ]) await options.onEvent(event);
        return {
          finalText: "任务已完成", rounds: 3,
          usage: { input_tokens: 7, output_tokens: 3 }, termination: { reason: "end_turn" },
          compactionStats: [],
        };
      },
    },
  }));

  const notes = payload.diagnostics.notes;
  assert.equal(notes.observed, true);
  assert.equal(notes.source, core.NOTE_COUNT_SOURCE);
  assert.equal(notes.writes, 2, "note_take 与 note_forget（留墓碑）都动 store ⇒ 记成写");
  assert.equal(notes.reads, 2, "note_read 与 note_list 只读 ⇒ 记成读");
  assert.equal(notes.unclassified, 1, "认不出的 note_* 只进 byName，不并进写/读两个数");
  assert.deepEqual(notes.byName, {
    note_take: 1, note_list: 1, note_read: 1, note_forget: 1, note_whatever_new: 1,
  });
  assert.deepEqual(payload.diagnostics.modelMetadataMissingEvents, {
    count: 1, observed: true, source: "onEvent:model_metadata_missing",
  });
  const text = core.formatPayloadForModel(payload);
  assert.match(text, /notes 写=2\/读=2（未归类 note_\* 1）/u);
  assert.match(text, /note_take=1/u);
  assert.match(text, /model_metadata_missing=YES events=1/u);
});

// ---------------------------------------------------------------------------
// #314：erix_run 接 finalGuard（默认关、显式开）。全部离线（fake provider +
// 注入的谓词），不打模型；引擎的终局裁决走真 `runToolLoop`（本单**一字没改**引擎）。
// ---------------------------------------------------------------------------

const DRAFT_END_TURN = {
  content: [{ type: "text", text: "任务已完成\n\n## 取证边界\nx\n\n## 基点\ny\n\n## 结论\nz\n\n## 未验证\n无" }],
  stopReason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 2 },
};
const acceptAll = () => ({ action: "accept" });
const reviseAlways = () => ({ action: "revise", message: "缺 ## 基点，请补齐" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("#314 R1：默认关 ⇒ 透传给引擎的 options 里一个 finalGuard 键都没有，verification 仍是 skipped", async () => {
  const captured = {};
  const payload = await core.runErixRun(
    { task: "改一行", cwd: repoRoot, maxRounds: 4 },
    makeDeps({ provider: createFakeProvider([DRAFT_END_TURN]), captured }),
  );
  // 「默认不透传」必须是**结构上**的不透传，不是「传了个 undefined」
  assert.ok(!("finalGuard" in captured.options), JSON.stringify(Object.keys(captured.options)));
  assert.ok(!("finalGuardTimeoutMs" in captured.options), "默认关时连超时都不该下发");
  assert.equal(payload.termination.reason, "end_turn");
  assert.equal(payload.verification.status, "skipped", JSON.stringify(payload.verification));
  assert.equal(payload.verification.reason, "no_final_guard");
  // 引擎的 guardMetrics 也在 verification 上（本层不重抄它，宿主面另记自己的墙钟成本）
  assert.deepEqual(payload.verification.metrics, {
    verified: 0, skipped: 0, revised: 0, unverified: 0, guard_error: 0,
  });
  // 观测面：没开启也要有一行如实的话（而不是缺字段），且终局面文本不假称已通过
  assert.equal(payload.diagnostics.finalGuard.enabled, false);
  assert.equal(payload.diagnostics.finalGuard.calls, 0);
  const text = core.formatPayloadForModel(payload);
  assert.match(text, /finalGuard=disabled/u);
  assert.doesNotMatch(text, /finalGuard calls=/u);
  assert.doesNotMatch(captured.options.system, /## 基点/u, "默认关时提示词一个字节都不许多");
});

test("#314 R1：显式开启 ⇒ 透传回调 + 显式的小 finalGuardTimeoutMs，引擎侧真的落到 verified", async () => {
  const captured = {};
  const payload = await core.runErixRun(
    { task: "改一行", cwd: repoRoot, maxRounds: 4, finalGuard: true },
    makeDeps({
      provider: createFakeProvider([DRAFT_END_TURN]),
      captured,
      extra: { finalGuardInspect: acceptAll },
    }),
  );
  assert.equal(typeof captured.options.finalGuard, "function");
  assert.equal(captured.options.finalGuardTimeoutMs, FINAL_GUARD_TIMEOUT_MS);
  assert.ok(FINAL_GUARD_TIMEOUT_MS < 30_000, "别靠引擎默认的 30s（坑 ①）");
  assert.equal(payload.verification.status, "verified", JSON.stringify(payload.verification));
  assert.equal(payload.diagnostics.finalGuard.enabled, true);
  assert.equal(payload.diagnostics.finalGuard.calls, 1);
  assert.equal(payload.diagnostics.finalGuard.reviseRounds, 0);
  // 开启时提示词才写四段槽位（段名与 guard 的 `FINAL_DRAFT_SECTIONS` 同源，一处改两处生效）
  for (const section of FINAL_DRAFT_SECTIONS) {
    assert.ok(captured.options.system.includes(section), `提示词缺槽位 ${section}`);
  }
});

test("#314 R1：finalGuardTimeoutMs 可显式覆盖（调用方想更紧就自己给）", async () => {
  const captured = {};
  await core.runErixRun(
    { task: "t", cwd: repoRoot, maxRounds: 3, finalGuard: true, finalGuardTimeoutMs: 1_234 },
    makeDeps({
      provider: createFakeProvider([DRAFT_END_TURN]),
      captured,
      extra: { finalGuardInspect: acceptAll },
    }),
  );
  assert.equal(captured.options.finalGuardTimeoutMs, 1_234);
});

test("#314 坑①：guard 的等待晚于 run 截止线，宿主硬 abort 必须留余量（否则钱花了拿不到 verified）", async () => {
  // run 截止线 1s，谓词要跑 1.2s：引擎在轮边界**之后**才叫 guard，stop 判定 → guard 之间
  // 没有 deadline 检查，所以这 1.2s 全落在「宿主说了算」的窗口里。本层那根 setTimeout 若
  // 仍卡在 params.timeoutMs=1000，就会在谓词跑完前 abort ⇒ payload 是 aborted、verification
  // 拿不到 verified（钱花了）。开启时把硬 abort 往后挪 FINAL_GUARD_WORST_CASE_MS 才不会红。
  const slowInspect = async () => {
    await sleep(1_200);
    return acceptAll();
  };
  const payload = await core.runErixRun(
    { task: "t", cwd: repoRoot, maxRounds: 3, timeoutMs: 1_000, finalGuard: true },
    makeDeps({
      provider: createFakeProvider([DRAFT_END_TURN]),
      extra: { finalGuardInspect: slowInspect },
    }),
  );
  assert.equal(payload.timeout, false, `宿主自己把核验掐死了：${JSON.stringify(payload.termination)}`);
  assert.equal(payload.aborted, false, JSON.stringify(payload.termination));
  assert.ok(payload.verification, `verification 整块都没了（被硬 abort 抢掉）：${JSON.stringify(payload.termination)}`);
  assert.equal(payload.verification.status, "verified", JSON.stringify(payload.verification));
});

test("#314 C3：重试用尽 ⇒ 终局 unverified（不是 verified），成本与 revise 轮数都进 diagnostics", async () => {
  const captured = {};
  const payload = await core.runErixRun(
    { task: "t", cwd: repoRoot, maxRounds: 6, finalGuard: true },
    makeDeps({
      provider: createFakeProvider([{ ...DRAFT_END_TURN, times: 6 }]),
      captured,
      extra: { finalGuardInspect: reviseAlways },
    }),
  );
  assert.equal(payload.termination.reason, "final_guard_unverified", JSON.stringify(payload.termination));
  assert.equal(payload.verification.status, "unverified");
  assert.equal(payload.verification.reason, "max_retries");
  // 引擎 finalGuardMaxRetries 默认 2 ⇒ guard 被叫 1 + 2 = 3 次，一次也没 accept
  assert.equal(payload.diagnostics.finalGuard.calls, 3);
  assert.equal(payload.diagnostics.finalGuard.reviseRounds, 3);
  assert.equal(payload.diagnostics.finalGuard.accepted, 0);
  assert.equal(payload.diagnostics.finalGuard.reviseRounds <= 1 + ENGINE_FINAL_GUARD_MAX_RETRIES, true);
  assert.equal(payload.diagnostics.finalGuard.worstCaseExtraMs, 3 * FINAL_GUARD_TIMEOUT_MS);
  const text = core.formatPayloadForModel(payload);
  assert.match(text, /finalGuard calls=3/u);
  assert.match(text, /revise=3\/2/u);
  assert.match(text, /verification=unverified\/max_retries/u);
});

test("#314 R1：finalGuard 只认真布尔；没开启时传超时是 bad_params（不静默吞掉用户意图）", () => {
  for (const value of ["true", 1, "yes", {}]) {
    assert.throws(
      () => core.parseRunParams({ task: "t", cwd: "/tmp", finalGuard: value }),
      (error) => error.code === "bad_params",
      `finalGuard=${JSON.stringify(value)} 该报错`,
    );
  }
  assert.deepEqual(core.parseRunParams({ task: "t", cwd: "/tmp", finalGuard: false }), {
    task: "t", cwd: "/tmp", maxRounds: core.DEFAULT_MAX_ROUNDS, timeoutMs: core.DEFAULT_TIMEOUT_MS,
  }, "finalGuard:false 必须与「没传」逐字同形（默认路径零变化）");
  assert.equal(core.parseRunParams({ task: "t", cwd: "/tmp", finalGuard: true }).finalGuard, true);
  assert.throws(
    () => core.parseRunParams({ task: "t", cwd: "/tmp", finalGuardTimeoutMs: 5_000 }),
    (error) => error.code === "bad_params" && /只在 finalGuard: true 时有意义/u.test(error.message),
  );
});
