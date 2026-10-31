// issue #519（#518 第三片）：直连路线 `runToolLoop({ assemblyPort, <x> })` 的显式覆盖不再静默赢。
//
// 活体（改动前实测）：`createAssemblyPort({ provider: FROM-PORT })` +
// `runToolLoop({ assemblyPort, provider: FROM-EXPLICIT })` ⇒ **NO THROW**，终稿取 `FROM-EXPLICIT`。
// 根因是 `normalizeRunToolLoopOptions` 把 `explicitOptions` **逐键盖到** `assembledOptions` 上，
// 无冲突闸口 —— 与 #518b 刚在 `overrides` 通道禁掉的是同一件事，只是另一条入口。
//
// 本文件钉三格（工单 ③ 的逐字要求）+ 射程边界（工单 ④：本票不扩大射程，只登记）：
//   ① 两边不同值 ⇒ 抛，且点名 `assemblyPort.<x>` 与 `runToolLoop.<x>`；
//   ② 一边是 `undefined` ⇒ **不抛**（`undefined` = 「没给」，与合并口径 `value !== undefined` 同源）；
//   ③ 两边同值 ⇒ **也抛**（#518b 的裁决：来源唯一性本身就是要保的东西，不引入 deep-equal 豁免）。
// 反向证（防「恒绿装饰」）：
//   · 删掉 `assertDirectRouteConflicts(...)` 那一行 ⇒ ①②③ 全红（闸口不存在了）；
//   · 把 `if (value === undefined) continue;` 删掉 ⇒ ② 红；
//   · 把闸口改成「值不同才抛」（加 deep-equal 豁免）⇒ ③ 红；
//   · 往 `DIRECT_ROUTE_CONFLICT_EXEMPTIONS` 里加一个键 ⇒ 该键的冲突格与「例外清单恰三项」同时红。
//
// 隔离：零真实 LLM、不写盘、不碰 `~/.erix`（provider 是脚本化假实现，run 只跑一轮 end_turn）。

import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort, DIRECT_ROUTE_CONFLICT_EXEMPTIONS } from "../src/assembly.js";
import { runToolLoop } from "../src/loop/orchestrator.js";

const CONFLICT_PREFIX = "runToolLoop option conflicts with the assembly port: ";

/** 一次就结束的脚本化 provider；`label` 落进终稿，用来判「谁真的跑过」。 */
function providerSaying(label) {
  const calls = [];
  return {
    calls,
    async chat() {
      calls.push(label);
      return { content: [{ type: "text", text: label }], stopReason: "end_turn" };
    },
  };
}

const EXECUTE_TOOL = async () => "unused";

/** 合法的 transcript store（两个方法就是全部要求，见 `TRANSCRIPT_STORE_METHODS`）。 */
function validStore() {
  return {
    async appendRound() {},
    async load() {
      return [];
    },
  };
}

/**
 * 一个「每个键都给了值」的端口：provider / tools / executeTool / store / session / emit / policy。
 * 覆盖面自洽那一格用它，这样「端口能产出哪些键」是当场枚举出来的事实，不是手抄清单。
 */
function fullPortInput(overrides = {}) {
  return {
    modelConfig: { resolve: async () => ({ model: "port-model" }) },
    provider: providerSaying("FROM-PORT"),
    tools: { definitions: [], executeTool: EXECUTE_TOOL },
    store: validStore(),
    session: { id: `direct-519-${process.pid}` },
    emit: () => {},
    ...overrides,
  };
}

const baseConfig = { input: { wrapup: false }, run: { maxRounds: 1, completion: false } };

/** 「抛了什么」（不抛返回 null）。 */
const thrown = (promise) => promise.then(() => null, (error) => error);

// ================================================================ ① 两边不同值 ⇒ 抛
test("#519 ①：端口与调用点各给一次 provider ⇒ 启动期抛，点名 assemblyPort.provider 与 runToolLoop.provider", async () => {
  const explicit = providerSaying("FROM-EXPLICIT");
  const port = createAssemblyPort(fullPortInput());
  const error = await thrown(runToolLoop({
    assemblyPort: port,
    provider: explicit,
    config: baseConfig,
  }));
  assert.equal(
    error.message,
    `${CONFLICT_PREFIX}"provider" comes from assemblyPort.provider (construction)`
      + " and runToolLoop.provider (call); pass it in one place only",
  );
  assert.equal(error instanceof TypeError, true, "同类：TypeError（与 overrides 通道的冲突闸口一致）");
  assert.deepEqual(explicit.calls, [], "注定要抛的调用一次 provider 都不该调");
});

test("#519 ①：其余端口派生键逐个点名（executeTool / tools / store / session / onEvent）", async () => {
  // 每个键都拿「端口里那份」的**另一个值**去撞，断言判词逐字点名两个来源。
  // `onEvent` 的来源拼写是 `assemblyPort.emit`（端口成员名，不是调用点的键名）。
  const cases = [
    { key: "executeTool", value: async () => "other", origin: "assemblyPort.tools.executeTool" },
    { key: "tools", value: [{ name: "other", inputSchema: { type: "object" } }], origin: "assemblyPort.tools.definitions" },
    { key: "store", value: validStore(), origin: "assemblyPort.store" },
    { key: "session", value: { id: "other-session" }, origin: "assemblyPort.session" },
    { key: "onEvent", value: () => {}, origin: "assemblyPort.emit" },
  ];
  for (const { key, value, origin } of cases) {
    const port = createAssemblyPort(fullPortInput());
    const error = await thrown(runToolLoop({ assemblyPort: port, [key]: value, config: baseConfig }));
    assert.equal(
      error?.message,
      `${CONFLICT_PREFIX}${JSON.stringify(key)} comes from ${origin} (construction)`
        + ` and runToolLoop.${key} (call); pass it in one place only`,
      `${key}：判词必须点名端口侧的来源（${origin}）与调用点侧（runToolLoop.${key}）`,
    );
  }
});

// ================================================================ ② 一边是 undefined ⇒ 不抛
test("#519 ②：调用点写 undefined ⇒ 不抛，端口那份照旧生效（undefined = 没给）", async () => {
  const port = createAssemblyPort(fullPortInput());
  const result = await runToolLoop({
    assemblyPort: port,
    provider: undefined,
    executeTool: undefined,
    store: undefined,
    session: undefined,
    onEvent: undefined,
    config: baseConfig,
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.finalText, "FROM-PORT", "端口那份 provider 必须是真跑过的那一个");
});

test("#519 ②：端口没产出的键 ⇒ 调用点照旧能补（闸口只拦「两边都有值」）", async () => {
  // 端口没有 store / emit ⇒ 调用点的 store 与 onEvent 是**合法**的（这不是冲突，是补洞）。
  const port = createAssemblyPort(fullPortInput({ store: undefined, emit: undefined }));
  const events = [];
  const result = await runToolLoop({
    assemblyPort: port,
    store: validStore(),
    onEvent: (event) => events.push(event),
    config: baseConfig,
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.ok(events.length > 0, "调用点给的 onEvent 必须真的收到事件（证明它没被静默丢掉）");
});

// ================================================================ ③ 两边同值 ⇒ 也抛
test("#519 ③：两边给的是同一个对象也抛（#518b 的裁决：不引入 deep-equal 豁免）", async () => {
  const shared = providerSaying("SHARED");
  const port = createAssemblyPort(fullPortInput({ provider: shared }));
  const error = await thrown(runToolLoop({ assemblyPort: port, provider: shared, config: baseConfig }));
  assert.equal(
    error?.message,
    `${CONFLICT_PREFIX}"provider" comes from assemblyPort.provider (construction)`
      + " and runToolLoop.provider (call); pass it in one place only",
    "值相同不构成豁免：两处各写了一次，其中一处早晚会漂（放宽要改裁决，不是实现者的选择）",
  );
  assert.deepEqual(shared.calls, [], "抛在跑之前");

  // 同值也不放过的**另一条**键：`session` 容器（同一份引用）。
  const session = { id: "same-session-519" };
  const port2 = createAssemblyPort(fullPortInput({ session }));
  const error2 = await thrown(runToolLoop({ assemblyPort: port2, session, config: baseConfig }));
  assert.match(error2?.message ?? "", /"session" comes from assemblyPort\.session/u);
});

// ================================================================ 射程边界（工单 ④：本票不扩大射程）
test("#519 边界：例外清单恰三项，且每一项都真的不走冲突闸口", async () => {
  assert.deepEqual(
    [...DIRECT_ROUTE_CONFLICT_EXEMPTIONS].sort(),
    ["capabilities", "config", "modelConfig"],
    "例外清单是本单裁决的**全部**射程边界；加一项就是改裁决（这格会红）",
  );

  // modelConfig：`overrides` 通道唯一保留的例外（自带 validateModelConfigResolver 校验）。
  // 直连路线把它原样当 `overrides.modelConfig` 传下去，所以这里抛就会让两条路线**不一致**。
  const port = createAssemblyPort(fullPortInput());
  const result = await runToolLoop({
    assemblyPort: port,
    modelConfig: { resolve: async () => ({ model: "explicit-model" }) },
    config: baseConfig,
  });
  assert.equal(result.termination.reason, "end_turn", "modelConfig 覆盖通道照旧可用（两条路线对称）");
});

test("#519 边界：config 容器仍是「调用级整棵赢 + 逐叶 config_override_conflict」，不是启动期抛", async () => {
  const events = [];
  // `emit: undefined` ⇒ 端口不产 `onEvent`，于是调用点那份 onEvent 是合法的（补洞，不是冲突）。
  const port = createAssemblyPort(fullPortInput({
    emit: undefined,
    policy: { config: { run: { maxRounds: 4 }, tuning: { temperature: 0.1 } } },
  }));
  const result = await runToolLoop({
    assemblyPort: port,
    // 调用级 config 与 policy.config 值不同（4 vs 1）⇒ 以前是静默覆盖，现在也**不**抛：
    // 两个容器的冲突出口是逐叶事件（#497 / #498 R4 / #545），本单不扩大射程。
    config: { ...baseConfig, run: { maxRounds: 1, completion: false }, tuning: { temperature: 0.1 } },
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.rounds, 1, "调用级 config 整棵赢（既有合并规则一字未动）");
  const conflicts = events.filter((event) => event.type === "config_override_conflict");
  assert.equal(conflicts.length, 1, "值不同的那个叶子发一条事件（同值的 temperature 不发）");
  assert.deepEqual(
    conflicts[0].conflicts,
    [{ path: "run.maxRounds", key: "maxRounds" }],
    "逐叶事件的载荷与 #497 那条逐字同形（本单一个字都没动它）",
  );
});

test("#519 边界：capabilities 容器同理（逐叶事件，不是启动期抛）", async () => {
  const events = [];
  const portCalls = [];
  const port = createAssemblyPort(fullPortInput({
    emit: undefined,
    policy: { capabilities: { hooks: { onEvent: () => { portCalls.push("port"); } } } },
  }));
  const result = await runToolLoop({
    assemblyPort: port,
    capabilities: { hooks: { onEvent: () => { portCalls.push("call"); } } },
    config: baseConfig,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(portCalls.includes("call"), true, "调用级 capabilities 整棵赢（既有规则）");
});

// ================================================================ 覆盖面自洽：端口产出的键一个都不漏
test("#519 自洽：端口能产出的每个键，要么被闸口拦住、要么在例外清单里（新键不会静默绕过）", async () => {
  const port = createAssemblyPort(fullPortInput({ policy: { config: { run: { maxRounds: 2 } }, capabilities: { hooks: { onEvent: () => {} } } } }));
  const produced = await (await import("../src/assembly.js")).assemblyPortOptions(port);
  // 端口产出的键是**构造出来的事实**，不是手抄清单：新增一个端口派生键而没进来源表/例外清单时，
  // 这一格会红（它会掉进「两者都不是」的分支）。
  const checked = [];
  for (const key of Object.keys(produced)) {
    if (produced[key] === undefined) continue;
    if (DIRECT_ROUTE_CONFLICT_EXEMPTIONS.has(key)) continue;
    // 冲突值：换成一个「肯定不同」的值即可 —— 判定只看两边是否有值，不看值本身（③ 已钉）。
    const error = await thrown(runToolLoop({ assemblyPort: port, [key]: Symbol("other"), config: baseConfig }));
    assert.equal(
      error?.message?.startsWith(`${CONFLICT_PREFIX}${JSON.stringify(key)}`),
      true,
      `端口产出的 ${key} 必须被冲突闸口拦住（实际：${error?.message ?? "没抛"}）`,
    );
    checked.push(key);
  }
  assert.deepEqual(
    checked.sort(),
    ["executeTool", "onEvent", "provider", "session", "store", "tools"],
    "端口今天产出的派生键就是这六个（`config` / `capabilities` / `modelConfig` 在例外清单里）",
  );
});
