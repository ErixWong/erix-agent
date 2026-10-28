// issue #498 S6：`buildLoopOptions` 的**内部映射迁移**（母单 #495）的离线自证。
//
// 本刀只动一件事：`erix-run-core.js` 的 `buildLoopOptions` 递给 `runToolLoop` 的**形状**
// （数据 ⇒ `config.*`、回调 ⇒ `capabilities.*`）。对 pi 的**工具参数面**一个字节都没动
// （`erix-run.ts` 的 schema 与 README 的参数表逐字保留），返回的四件套也不变。
//
// 这个文件把「零变化」变成机器判据，四段各管一件事：
//   A. **逐键去向**：迁移前的每一个扁平键都必须能在 `config.*` / `capabilities.*` 找到，
//      且顶层**不再有同名扁平键**；留在顶层的只允许是端口对象 / 信号 / 错误出口那五个。
//   B. **有效选项等价**：把新形状与迁移前的扁平 golden 都过一遍引擎自己的
//      `normalizeRunToolLoopOptions`（`src/loop/option-normalization.js`），展开后的
//      `effectiveOptions` 必须逐键深度相等，且两边都**零** `config_override_conflict`。
//   C. **反向证 ≥ 3 条**（少了它们，「迁过去了」只是一句自称）：
//      ① 同一个键既写扁平又写 `config` ⇒ 真 run 里必须冒 `config_override_conflict`；
//      ② 把交付物判据挪回 `config.guard.deliverables` ⇒ 启动即抛（那个键在 S4b 已删）；
//      ③ 把某个 hooks 映射改错名字 ⇒ 未知子键闸口当场抛。
//   D. **离线端到端**：真引擎 + 本地脚本化上游（`fetchImpl` 桩，不打真 relay）跑一次
//      `erix_run`，断言四件套形状 / `verification.status` 语义 / `sessionDir` 产物位置
//      （transcript、judge.log、异步 status.json）都不变。
//
// 为什么 A/B 直接读引擎的两张别名表（`CONFIG_ALIAS_PATHS` / `CAPABILITIES_ALIAS_PATHS`）：
// 「每个数据键都能在 `config.*` 找到」这句话的真值只有引擎自己知道——在这里手抄一份
// `maxRounds → run.maxRounds` 的对照表就等于多出第二套名字，正是 #497/#498 要杀的东西。
// 本文件是**仓内测试**（`examples/pi-extension` 不进 npm 包），读引擎内部表是刻意的。
//
// 零依赖红线：只用 node: 内置 + 仓内相对路径；纯 ESM；不碰真实 `~/.erix`（home / cwd /
// sessionDir 全在 mkdtemp 里）；不打网络（provider 的 `fetchImpl` 是桩）。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_SLOT_DESTINATIONS,
  capabilitiesPathForOption,
} from "../../src/loop/capabilities-namespace.js";
import { configPathForOption } from "../../src/loop/config-namespace.js";
import { normalizeRunToolLoopOptions } from "../../src/loop/option-normalization.js";
import { createMemoryTranscriptStore, createOpenAIProvider, runToolLoop } from "../../src/index.js";
import * as core from "./erix-run-core.js";
import { createAsyncRuntime, statusFilePath } from "./erix-run-jobs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 临时目录 + 收尾删除（本文件不碰真实 `~/.erix`）。 */
function makeTmpDir(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `i498s6-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 一组「把每条分支都点亮」的入参：所有条件键（strategy / reflection / finalGuard /
 * deliverables / diagnostics / 观察者）都在场，等价断言才覆盖得到它们。
 */
function richInput() {
  const onEvent = () => {};
  const onObserverError = () => {};
  const onPersistenceError = () => {};
  const onJudge = () => {};
  const onReflection = () => {};
  const finalGuard = async () => ({ action: "accept" });
  const deliverables = [{ name: "report.md", check: () => [] }];
  return {
    params: {
      task: "修 bug",
      cwd: "/work/proj",
      maxRounds: 9,
      timeoutMs: 60_000,
      strategy: "fold-statistical",
      finalGuardTimeoutMs: 12_345,
    },
    slot: { contextWindowTokens: 200_000, maxOutputTokens: 4_096 },
    provider: { chat: async () => ({ content: [], stopReason: "end_turn" }) },
    tools: { tools: [{ name: "exec", description: "跑命令", inputSchema: { type: "object" } }], executeTool: async () => "ok" },
    store: createMemoryTranscriptStore(),
    signal: new AbortController().signal,
    runId: "run-migration",
    system: "SYS",
    onEvent,
    onObserverError,
    onPersistenceError,
    onJudge,
    diagnostics: { error: () => {} },
    reflection: { enabled: true, maxExtensions: 3, extensionStep: 8, judgeDoneAdvisory: true, onReflection },
    finalGuard,
    deliverables,
  };
}

/**
 * **迁移前**（main `0b2d858`）的扁平装配——逐字照抄那一版 `buildLoopOptions` 的返回形状。
 *
 * 它是等价断言的 golden：新形状展开后必须与它逐键相等。刻意**照抄而不是引用**：
 * 一旦有人把新形状改回扁平、或把某个键悄悄丢掉，这份 golden 不会跟着变。
 */
function legacyFlatOptions(input) {
  const {
    params, slot, provider, tools, store, signal, runId,
    system, onEvent, onObserverError, onPersistenceError, onJudge, diagnostics,
    reflection, finalGuard, deliverables,
  } = input;
  const options = {
    provider,
    task: params.task,
    cwd: params.cwd,
    tools: tools.tools,
    executeTool: tools.executeTool,
    maxRounds: params.maxRounds,
    stream: false,
    signal,
    runId,
    store,
    wrapup: false,
    // #498 S3 (`timing` slice): `timeoutMs` / `retry` no longer have a flat spelling — the golden
    // uses their canonical home `config.timing.*`. The equivalence claim is unaffected: the
    // expansion phase writes them back to `effectiveOptions.timeoutMs` / `.retry`, which is exactly
    // the mechanism this slice relies on.
    // #498 S3 A2b: `initialUserMessage` lost its flat spelling as well — same canonical home
    // (`config.input.initialUserMessage`), same mechanism. Merged into the one `config` tree.
    // #498 S3 A6: `system` follows it — the golden keeps the same shape the shipped `buildLoopOptions`
    // emits (`config.input.system`), because the flat spelling is now rejected at the name gate.
    config: {
      input: {
        system: system ?? core.buildSystemPrompt({ lib: { binTools: {} }, cwd: params.cwd, tools: tools.tools }),
        initialUserMessage: params.task,
      },
      timing: { timeoutMs: params.timeoutMs, retry: { attempts: 2 } },
    },
    completion: { signals: ["任务已完成", "已完成", "全部完成", "无需继续", "任务结束", "没有更多步骤"], maxNoToolRounds: 3 },
    ...(reflection === undefined ? {} : { reflection }),
    ...(onEvent === undefined ? {} : { onEvent }),
    ...(onObserverError === undefined ? {} : { onObserverError }),
    ...(onPersistenceError === undefined ? {} : { onPersistenceError }),
    ...(onJudge === undefined ? {} : { onJudge }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(finalGuard === undefined ? {} : { finalGuard }),
    ...(deliverables === undefined ? {} : { deliverables }),
  };
  // #498 S3 (`folding` slice): `context` is retired as a flat option. `params.strategy` here is a
  // **built-in name** (data), so it belongs to `config.folding.context.strategy` — the object form
  // would go to `capabilities.ports.strategy` instead. The equivalence claim is unaffected: the
  // expansion phase writes it back to `effectiveOptions.context.strategy`.
  // Merged into the **same** `config` tree (a second `config:` key would replace the timing one).
  if (params.strategy !== undefined) options.config.folding = { context: { strategy: params.strategy } };
  // #498 S3 (`guard` slice): `finalGuardTimeoutMs` is retired as a flat option too — the golden writes
  // it at its canonical home `config.guard.finalGuardTimeoutMs`. Same mechanism as the `timing` /
  // `folding` keys above: the expansion phase writes it back to `effectiveOptions.finalGuardTimeoutMs`,
  // so the equivalence claim is unaffected. Merged into the **same** `config` tree.
  if (finalGuard !== undefined) {
    options.config.guard = { finalGuardTimeoutMs: params.finalGuardTimeoutMs ?? 10_000 };
  }
  // #498 S3 (`metadata` slice, segment A8): `modelMetadata` / `requestId` / `toolContext` / `expert`
  // are retired as flat options as well. Their canonical home is `config.metadata.*`; the expansion
  // phase writes them back onto `effectiveOptions.modelMetadata` / `.requestId` / `.toolContext` /
  // `.expert`, so the equivalence claim below is unaffected. Merged into the **same** `config` tree
  // (a second `config:` key would replace the `input` / `timing` / `guard` groups above).
  if (Number.isSafeInteger(slot.contextWindowTokens) && Number.isSafeInteger(slot.maxOutputTokens)) {
    options.config.metadata = {
      modelMetadata: {
        contextWindowTokens: slot.contextWindowTokens,
        maxOutputTokens: slot.maxOutputTokens,
      },
    };
  }
  return options;
}

/** 沿 `"run.reflection"` 这样的 schema 路径读容器里的值。 */
function readConfigPath(options, configPath) {
  let current = options.config;
  for (const segment of configPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

/** 沿 `"hooks.onEvent"` 这样的能力面路径读容器里的值。 */
function readCapabilitiesPath(options, capabilityPath) {
  let current = options.capabilities;
  for (const segment of capabilityPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * 端口对象 / 信号 / 错误出口 + `tools`——**唯一允许留在顶层**的六项（issue #527 起）。
 *
 * 它们没有命名空间规位不是漏了：`capabilities.ports` 只收「壳内实现」
 * （`sleepImpl` / `judgeProvider` / `strategy`），适配器端口对象明确不进（见
 * `src/loop/capabilities-namespace.js` 的文件头）。所以这张名单是「无处可搬」的清单，
 * 不是「先放这儿以后再说」。
 *
 * `tools` 是 #527 的裁决：工具声明可以带函数成员，所以它既不能进只装数据的 `config`，
 * 引擎也不调用那些成员，所以它不是能力面 ⇒ **永久顶层面（第三站）**，与端口对象同类。
 */
const TOP_LEVEL_ONLY_KEYS = ["provider", "executeTool", "store", "signal", "diagnostics", "tools"];

/** 容器键（展开后消失，既不是配置面也不是能力面）。 */
const CONTAINER_KEYS = ["config", "capabilities"];

// ---------------------------------------------------------------------------
// A. 逐键去向：数据 ⇒ config.*，回调 ⇒ capabilities.*，顶层不再有同名扁平键
// ---------------------------------------------------------------------------

test("S6-A 迁移前的每个扁平键都有唯一新规位，且顶层不再有同名扁平键", () => {
  const input = richInput();
  const legacy = legacyFlatOptions(input);
  const options = core.buildLoopOptions(input);

  // 顶层的键集必须**恰好**是「端口对象五项 + 两个容器」：多一个就是悄悄留下的扁平键。
  assert.deepEqual(
    Object.keys(options).sort(),
    [...TOP_LEVEL_ONLY_KEYS, ...CONTAINER_KEYS].sort(),
    "顶层只允许端口对象/信号/错误出口 + tools + 两个容器",
  );

  const unclassified = [];
  for (const [flatKey, legacyValue] of Object.entries(legacy)) {
    // #498 S3: the golden itself carries the `config` container now (the three `timing` keys lost
    // their flat spelling), and a container is neither a config leaf nor a capability member — it
    // disappears during expansion. Skip it instead of calling it "unclassified".
    if (CONTAINER_KEYS.includes(flatKey)) continue;
    const configPath = configPathForOption(flatKey);
    const capabilityPath = capabilitiesPathForOption(flatKey);
    if (configPath === undefined && capabilityPath === undefined) {
      // 端口对象 / 信号 / 错误出口：**没有命名空间规位**，必须原样留在顶层。
      if (!TOP_LEVEL_ONLY_KEYS.includes(flatKey)) {
        unclassified.push(flatKey);
        continue;
      }
      assert.equal(options[flatKey], legacyValue, `${flatKey} 留在顶层但值变了`);
      continue;
    }
    // 一个旋钮只写一侧：顶层不许再有同名扁平键。
    assert.equal(Object.hasOwn(options, flatKey), false, `${flatKey} 仍留在顶层（一个旋钮只能写一侧）`);
    if (configPath !== undefined) {
      const value = readConfigPath(options, configPath);
      assert.notEqual(value, undefined, `${flatKey} 在 config.${configPath} 里找不到`);
      if (flatKey === "reflection") {
        // 复合旋钮：数据半边进 config，回调半边进能力面（下一段单独断言）。
        const { onReflection: legacyHook, ...legacyData } = legacyValue;
        const { onReflection: movedHook, ...data } = value;
        assert.equal(typeof legacyHook, "function", "golden 里 reflection.onReflection 应是函数");
        assert.equal(movedHook, undefined, "config 里不许有函数值（回调整键搬走）");
        assert.deepEqual(data, legacyData, "config.run.reflection 的数据半边必须逐键相等");
        assert.equal(
          readCapabilitiesPath(options, "hooks.onReflection"),
          legacyHook,
          "reflection.onReflection 必须原样出现在 capabilities.hooks.onReflection",
        );
        continue;
      }
      assert.deepEqual(value, legacyValue, `${flatKey} 在 config.${configPath} 里的值必须逐字相等`);
      continue;
    }
    // 能力面：扁平叶子（别名）或嵌套槽位（无扁平别名）。
    const slot = CAPABILITY_SLOT_DESTINATIONS[capabilityPath];
    const value = readCapabilitiesPath(options, capabilityPath);
    assert.notEqual(value, undefined, `${flatKey} 在 capabilities.${capabilityPath} 里找不到`);
    if (flatKey === "deliverables") {
      assert.deepEqual(value, legacyValue, "交付物判据必须原样搬到 capabilities.checks.deliverables");
    } else {
      assert.equal(value, legacyValue, `${flatKey} 回调必须原样出现在 capabilities.${capabilityPath}（按同一性）`);
    }
    assert.equal(slot, undefined, `${capabilityPath} 不该是嵌套槽位（它本身是顶层选项）`);
  }

  assert.deepEqual(unclassified, [], "有扁平键既不在配置面也不在能力面（映射漏了它）");

  // 反向：每个落在 config.* 里的叶子都必须真映射回一个顶层选项名（别名 = schema 路径）。
  for (const [group, bag] of Object.entries(options.config)) {
    for (const leaf of Object.keys(bag)) {
      assert.equal(
        configPathForOption(leaf),
        `${group}.${leaf}`,
        `config.${group}.${leaf} 的叶子名与引擎的 schema 路径对不上`,
      );
    }
  }
});

test("S6-A2 默认路径一个字节都不多：没开 finalGuard / 没声明判据 / 没传观察者时两个容器都瘦", () => {
  const options = core.buildLoopOptions({
    params: { task: "t", cwd: "/w", maxRounds: 8, timeoutMs: 1_000 },
    slot: {},
    provider: {},
    tools: { tools: [{ name: "exec" }], executeTool: async () => "ok" },
    store: {},
    signal: new AbortController().signal,
    runId: "run-bare",
    system: "SYS",
  });
  assert.equal(Object.hasOwn(options.config.run, "reflection"), false, "reflection 未指定时不下发（引擎缺省）");
  assert.equal(Object.hasOwn(options.config, "guard"), false, "finalGuard 未开时连 guard 组都没有");
  assert.equal(Object.hasOwn(options.config, "folding"), false, "没传 strategy 时不下发 folding.context");
  assert.equal(Object.hasOwn(options.config.metadata, "modelMetadata"), false, "预算元数据不齐时一个字段都不给");
  assert.equal(Object.hasOwn(options, "capabilities"), false, "没有回调也没有判据 ⇒ 连 capabilities 容器都没有");
});

// ---------------------------------------------------------------------------
// B. 有效选项等价（引擎自己的展开器说了算）
// ---------------------------------------------------------------------------

test("S6-B 展开后的 effectiveOptions 与迁移前扁平 golden 逐键相等，且两边零冲突", async () => {
  const input = richInput();
  const legacy = legacyFlatOptions(input);
  const options = core.buildLoopOptions(input);

  const migrated = await normalizeRunToolLoopOptions(options);
  const before = await normalizeRunToolLoopOptions(legacy);

  assert.deepEqual(migrated.configConflicts, [], "新形状自己不许制造 config_override_conflict");
  assert.deepEqual(before.configConflicts, [], "golden 侧同样零冲突（对照组干净）");

  // 唯一的结构差：`reflection.onReflection` 从数据壳搬到了嵌套槽位（引擎在 orchestrator 里
  // 以 `capabilityHooks.onReflection ?? effectiveReflection.onReflection` 解析，容器赢）。
  const splitReflection = (effective) => {
    const { onReflection, ...rest } = effective.reflection;
    return { rest, onReflection };
  };
  const migratedReflection = splitReflection(migrated.effectiveOptions);
  const beforeReflection = splitReflection(before.effectiveOptions);
  assert.equal(migratedReflection.onReflection, undefined, "新形状的数据壳里不许再留回调");
  assert.equal(beforeReflection.onReflection, input.reflection.onReflection, "golden 侧回调仍在壳里");
  assert.equal(
    migrated.capabilitySlots.hooks?.onReflection,
    input.reflection.onReflection,
    "回调必须原样落在能力面嵌套槽位里（引擎按同一性解析）",
  );

  assert.deepEqual(
    { ...migrated.effectiveOptions, reflection: migratedReflection.rest },
    { ...before.effectiveOptions, reflection: beforeReflection.rest },
    "展开后的有效选项必须与迁移前逐键相等（含回调按同一性比较）",
  );
});

// ---------------------------------------------------------------------------
// C. 反向证（三条，缺一条这套断言就只是自称）
// ---------------------------------------------------------------------------

/** 本地脚本化上游：不打网络，按脚本回 OpenAI 形状的响应。 */
function scriptedFetch(responses) {
  let index = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls, count: () => index };
}

/** 一条「一句话就收工」的脚本化响应（end_turn）。 */
function endTurnResponse(text) {
  return {
    id: "chatcmpl-scripted",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 5 },
  };
}

test("S6-C1 反向证①：同一个键既写扁平又写 config ⇒ 真 run 里冒 config_override_conflict", async () => {
  const upstream = scriptedFetch([endTurnResponse("任务已完成：改好了")]);
  const events = [];
  const options = core.buildLoopOptions({
    params: { task: "t", cwd: "/w", maxRounds: 9, timeoutMs: 10_000 },
    slot: { contextWindowTokens: 200_000, maxOutputTokens: 4_096 },
    provider: createOpenAIProvider({
      endpoint: "http://127.0.0.1:9/v1", apiKey: "scripted-key", model: "scripted-model", fetchImpl: upstream.fetchImpl,
    }),
    tools: { tools: [], executeTool: async () => "ok" },
    store: createMemoryTranscriptStore(),
    signal: new AbortController().signal,
    runId: "run-conflict",
    system: "SYS",
    onEvent: (event) => events.push(event),
  });
  // 反向证本体：把已经迁移的 `maxRounds` 再写一份扁平、且值不同。
  options.maxRounds = 1;
  const result = await runToolLoop(options);

  const conflicts = events.filter((event) => event?.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, `应恰好一条 config_override_conflict，实际 ${conflicts.length}`);
  assert.deepEqual(
    conflicts[0].conflicts,
    [{ path: "run.maxRounds", key: "maxRounds" }],
    "冲突载荷必须点名 schema 路径与顶层键名",
  );
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(upstream.count(), 1, "真 run 只该打一发脚本化上游");
});

test("S6-C2 反向证②：把交付物判据挪回 config.guard.deliverables ⇒ 启动即抛（S4b 已删那个键）", async () => {
  const input = richInput();
  const options = core.buildLoopOptions(input);
  const checks = options.capabilities.checks.deliverables;
  delete options.capabilities.checks;
  options.config.guard = { ...options.config.guard, deliverables: checks };

  await assert.rejects(
    () => normalizeRunToolLoopOptions(options),
    (error) => {
      // 引擎把它认成「能力键写进 config」（`deliverables` 在能力面上），而不是「未知叶子」——
      // 两条都比「收下、不校、不生效」好；判据是：必须点名这个键 + 必须指出去处。
      assert.match(error.message, /^config\.guard\.deliverables is not accepted: "deliverables" is a capability\/injection option/u);
      assert.match(error.message, /capabilities\.checks\.deliverables/u, "文案必须指出去处，否则宿主只会再撞一次");
      return true;
    },
  );

  // 正向对照：放回能力面就过（红不是因为别的地方坏了）。
  const good = core.buildLoopOptions(input);
  const normalized = await normalizeRunToolLoopOptions(good);
  assert.deepEqual(normalized.effectiveOptions.deliverables, input.deliverables);
});

test("S6-C3 反向证③：hooks 映射改错名字 ⇒ 未知子键闸口当场抛", async () => {
  const options = core.buildLoopOptions(richInput());
  const typo = { ...options.capabilities.hooks };
  typo.onEventt = typo.onEvent;
  delete typo.onEvent;

  await assert.rejects(
    () => normalizeRunToolLoopOptions({ ...options, capabilities: { ...options.capabilities, hooks: typo } }),
    (error) => {
      assert.match(error.message, /unknown capabilities\.hooks option: "onEventt"/u);
      return true;
    },
  );

  // 同一道闸口也挡「组名写错」——两条都是「配了等于没配」的形状。
  await assert.rejects(
    () => normalizeRunToolLoopOptions({ ...options, capabilities: { hoks: options.capabilities.hooks } }),
    (error) => {
      assert.match(error.message, /unknown capabilities namespace: "hoks"/u);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// D. 离线端到端：真引擎 + 本地脚本化上游（不打真 relay）
// ---------------------------------------------------------------------------

/** 真引擎 + 桩 provider 的 runErixRun 依赖面（home / cwd / sessionDir 全在临时目录）。 */
function offlineDeps({ dir, fetchImpl, slot }) {
  return {
    env: { ...process.env, [core.LIB_ENV]: path.join(repoRoot, "src", "index.js") },
    home: dir,
    createProvider: () => createOpenAIProvider({
      endpoint: "http://127.0.0.1:9/v1", apiKey: "scripted-key", model: "scripted-model", fetchImpl,
    }),
    loadSlot: async () => ({ slot }),
  };
}

const SCRIPTED_SLOT = Object.freeze({
  endpoint: "http://127.0.0.1:9/v1",
  model: "scripted-model",
  apiKey: "scripted-key",
  contextWindowTokens: 200_000,
  maxOutputTokens: 4_096,
});

test("S6-D 离线 e2e：四件套 / verification.status / sessionDir 产物位置都不变", async () => {
  const { dir, cleanup } = makeTmpDir("e2e");
  try {
    const sessionDir = path.join(dir, "sessions");
    const upstream = scriptedFetch([endTurnResponse("任务已完成：改好了 a.js 第 2 行")]);
    const progressLines = [];
    const payload = await core.runErixRun(
      { task: "修 bug", cwd: dir, maxRounds: 4, strategy: "sliding-window", timeoutMs: 60_000, sessionDir },
      { ...offlineDeps({ dir, fetchImpl: upstream.fetchImpl, slot: SCRIPTED_SLOT }), onProgress: (line) => progressLines.push(line) },
    );

    assert.equal(upstream.count(), 1, "脚本化上游只该收到一发请求（离线证明：没打真 relay）");
    // —— 四件套形状不变 ——
    assert.equal(typeof payload.finalText, "string");
    assert.equal(payload.finalText, "任务已完成：改好了 a.js 第 2 行");
    assert.equal(payload.termination.reason, "end_turn", "termination 仍由引擎裁决");
    assert.deepEqual(payload.verification, {
      status: "skipped",
      reason: "no_final_guard",
      metrics: { verified: 0, skipped: 0, revised: 0, unverified: 0, guard_error: 0 },
    }, "verification 语义不变：本层不开 finalGuard ⇒ 恒 skipped / no_final_guard");
    assert.equal(payload.ok, true);
    assert.equal(payload.rounds, 1);
    assert.deepEqual(payload.usage, { input_tokens: 11, output_tokens: 5 });
    assert.equal(payload.diagnostics.observerErrors.count, 0, "观察者零错误 ⇒ capabilities.hooks 真的送到了引擎");

    // —— sessionDir 产物位置不变 ——
    assert.ok(payload.artifacts.transcriptPath.startsWith(sessionDir), payload.artifacts.transcriptPath);
    assert.ok(payload.artifacts.judgeLogPath.startsWith(path.join(sessionDir, "outputs")), payload.artifacts.judgeLogPath);
    assert.ok(existsSync(payload.artifacts.transcriptPath), "transcript 必须真在盘上");
    assert.ok(existsSync(payload.artifacts.judgeLogPath), "judge.log 必须真在盘上");
    const judgeLines = readFileSync(payload.artifacts.judgeLogPath, "utf8").split("\n").filter((line) => line.trim() !== "");
    const last = JSON.parse(judgeLines.at(-1));
    assert.equal(last.type, "run_outcome", "judge.log 末行仍是 run_outcome 汇总");
    assert.equal(last.termination.reason, "end_turn");
    assert.equal(last.verification.status, "skipped", "日志里的 verification 与载荷同口径");
    // 进度行仍走同一通道（事件经 capabilities.hooks.onEvent 送到宿主）。
    assert.ok(progressLines.some((line) => line.includes("erix_run 结束")), progressLines.join("\n"));
  } finally {
    cleanup();
  }
});

test("S6-D2 离线 e2e（异步）：status.json 仍在 <sessionDir>/outputs/<safeRunId>/ 下", async () => {
  const { dir, cleanup } = makeTmpDir("async");
  try {
    const sessionDir = path.join(dir, "sessions");
    const upstream = scriptedFetch([endTurnResponse("任务已完成：改好了")]);
    const deps = offlineDeps({ dir, fetchImpl: upstream.fetchImpl, slot: SCRIPTED_SLOT });
    const runtime = createAsyncRuntime({ home: dir, env: deps.env, deps, notify: () => true });
    const started = await runtime.dispatch({
      task: "修 bug", cwd: dir, maxRounds: 2, timeoutMs: 30_000, sessionDir, async: true,
    });
    assert.equal(started.kind, "started", JSON.stringify(started));
    const runId = started.handle.runId;

    const deadline = Date.now() + 60_000;
    let status = "running";
    while (Date.now() < deadline) {
      const view = runtime.act({ action: "status", runId }).view;
      status = view.status;
      if (status !== "running" && status !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status, "completed", "异步 run 必须自己跑到 completed");

    const statusPath = statusFilePath({ sessionDir, runId });
    assert.equal(started.handle.statusPath, statusPath, "句柄里的 statusPath 与推导式一致（位置没变）");
    assert.ok(existsSync(statusPath), `status.json 必须在盘上：${statusPath}`);
    const view = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(view.runId, runId);
    assert.equal(view.status, "completed");
    assert.equal(view.termination.reason, "end_turn");
    assert.equal(view.verification.status, "skipped", "status.json 里的 verification 语义同样不变");
    runtime.shutdown();
  } finally {
    cleanup();
  }
});
