// issue #875 第一刀（S1）：`erix-run-liveness.js` 的离线单测 —— erix_run 向 pi-web 申报「本会话还有活」。
//
// 为什么需要这件事：pi-web 在**一个 Node 进程里跑 N 个会话**，空闲 `PI_WEB_IDLE_TIMEOUT_MS`（默认 10 分钟）
// 就回收，判据是 `isRunning() || hasActiveProvider({sessionId, sessionFile})`。后台 `erix_run` 从会话角度
// 不算 running（派工那次工具调用早就返回了），所以不申报就必然被回收 ⇒ 终局通知只能记
// `delivery:"orphaned"`，要等用户下次点开会话才补投（盘上实测迟到 44 分钟 / 867 分钟）。
//
// 这一格面（全离线，不碰 pi、不碰网络）：
//   · 注册面的**形状**（1-7 条）——假 registry **照抄宿主 0.13.0 的校验与簿记口径**（见下面
//     `createFakeHostRegistry` 的逐字对照），不许放宽：两边错在一起就是自证；
//   · `sessionHasLiveWork` 的**判据**（8-11 条）——含复核 C 条（已结算但还有投递重试待投的那段窗口）。
//
// 接线面（`session_start` 注册 / `session_shutdown` 释放 / 多会话隔离）在
// `test/examples/erix-run-async.test.js` 末尾的 #875 那一节，它拿的是真 factory + 真 handler。

import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVENESS_PROVIDER_NAME,
  PI_WEB_LIVENESS_REGISTRY_KEY,
  registerSessionLiveness,
  resolvePiWebLivenessRegistry,
  sessionHasLiveWork,
} from "../../examples/pi-extension/erix-run-liveness.js";

/** 宿主那张表挂在 `Symbol.for(这个键)` 上（值逐字取自宿主，改一个字就是另开一张表）。 */
const REGISTRY_SYMBOL = Symbol.for(PI_WEB_LIVENESS_REGISTRY_KEY);

/**
 * 假 registry：**逐条照抄 pi-web 0.13.0 `lib/session-liveness.ts` 的口径**（放宽任何一条，本层就是自证）。
 *
 * | 宿主原文 | 这里 |
 * |---|---|
 * | `validateProvider`：provider 必须是对象 | 同 |
 * | provider `name` 必须匹配 `^[A-Za-z0-9_-]{1,64}$` | 同（本层先挡一遍，格 5 钉的就是「本层挡了、没劳驾宿主」） |
 * | `assertNonEmptyString(sessionId)` | 同 |
 * | `sessionFile !== undefined` 时才校验，且必须非空 | 同 ⇒ 空串必须**抛**（所以本层宁可不带这个键） |
 * | `typeof isActive !== "function"` ⇒ 抛 | 同 |
 * | provider 存进 `Map`，键是 `Symbol(name)`；`release` 用 `disposed` 一次性开关 ⇒ **幂等** | 同 |
 * | `hasActiveProvider` 按 `sessionId ∪ sessionFile` 精确匹配；`isActive` 抛 ⇒ **fail-safe 保留会话** | 同（0.13.0 另有 `list()`，这里也照抄，测试拿它查表） |
 *
 * @param {{version?:number, throwOnRegister?:boolean}} [options]
 */
function createFakeHostRegistry(options = {}) {
  /** @type {Map<symbol, {name:string, sessionId:string, sessionFile?:string, isActive:()=>boolean}>} */
  const providers = new Map();
  /** 宿主收到过的每一次 `register` 调用（含**抛出去之前**那一次——格 5 要的就是这个计数）。 */
  const registerCalls = [];
  let namePattern = /^[A-Za-z0-9_-]{1,64}$/;
  const assertNonEmptyString = (value, field) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Session liveness provider ${field} must be a non-empty string`);
    }
  };
  const registry = {
    version: options.version ?? 1,
    register(provider) {
      registerCalls.push(provider);
      if (options.throwOnRegister === true) throw new Error("host refuses this provider");
      if (!provider || typeof provider !== "object") throw new Error("Session liveness provider must be an object");
      if (typeof provider.name !== "string" || !namePattern.test(provider.name)) {
        throw new Error("Session liveness provider name must match ^[A-Za-z0-9_-]{1,64}$");
      }
      assertNonEmptyString(provider.sessionId, "sessionId");
      if (provider.sessionFile !== undefined) assertNonEmptyString(provider.sessionFile, "sessionFile");
      if (typeof provider.isActive !== "function") throw new Error("Session liveness provider isActive must be a function");
      const token = Symbol(provider.name);
      providers.set(token, provider);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        providers.delete(token);
      };
    },
    hasActiveProvider(session) {
      const identities = new Set([session.sessionId, session.sessionFile].filter((value) => Boolean(value)));
      for (const provider of providers.values()) {
        if (!identities.has(provider.sessionId) && (!provider.sessionFile || !identities.has(provider.sessionFile))) continue;
        try {
          const active = provider.isActive();
          if (typeof active !== "boolean") throw new Error("isActive() must return a boolean");
          if (active) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
    list: () => [...providers.values()],
  };
  return { registry, providers, registerCalls, list: () => registry.list() };
}

/** 把假表挂到**真 globalThis** 上，返回还原函数（不挂就别让上一格的表漏进下一格）。 */
function installOnGlobalThis(registry) {
  const had = REGISTRY_SYMBOL in globalThis;
  const before = globalThis[REGISTRY_SYMBOL];
  if (registry === undefined) delete globalThis[REGISTRY_SYMBOL];
  else globalThis[REGISTRY_SYMBOL] = registry;
  return () => {
    if (had) globalThis[REGISTRY_SYMBOL] = before;
    else delete globalThis[REGISTRY_SYMBOL];
  };
}

test("#875 格1：正常注册 ⇒ registered === true，宿主表里出现一条 name:\"erix-run\" 且 sessionId 精确匹配", () => {
  const host = createFakeHostRegistry();
  const lease = registerSessionLiveness({
    sessionId: "875-A",
    isActive: () => false,
    globalObject: { [REGISTRY_SYMBOL]: host.registry },
  });
  assert.equal(lease.registered, true, "registry 在场且参数合法就必须注册上");
  const rows = host.list();
  assert.equal(rows.length, 1, `宿主表里必须恰好一条，实测 ${JSON.stringify(rows.map((row) => row.name))}`);
  assert.equal(rows[0].name, "erix-run", "provider 名字面（别顺手改成 erix_run：下划线不在宿主的字符集里）");
  assert.equal(rows[0].name, LIVENESS_PROVIDER_NAME);
  assert.equal(rows[0].sessionId, "875-A", "sessionId 必须逐字等于派工会话那个 id（宿主按它精确匹配）");
  assert.equal(host.registry.hasActiveProvider({ sessionId: "875-A" }), false, "没有在飞的活 ⇒ 宿主问出 false");
});

test("#875 格2：release 调两次 ⇒ 表里查不到，且不抛（幂等）", () => {
  const host = createFakeHostRegistry();
  const lease = registerSessionLiveness({
    sessionId: "875-release",
    isActive: () => true,
    globalObject: { [REGISTRY_SYMBOL]: host.registry },
  });
  assert.equal(lease.registered, true);
  assert.equal(host.list().length, 1);
  assert.doesNotThrow(() => lease.release(), "第一次释放不许抛");
  assert.equal(host.list().length, 0, "释放后表里查不到");
  assert.doesNotThrow(() => lease.release(), "第二次释放也必须安静（宿主的 release 是幂等的）");
  assert.equal(host.list().length, 0);
  assert.equal(host.registerCalls.length, 1, "幂等靠的是同一条注册，不许偷偷再注册一次");
  assert.equal(host.registry.hasActiveProvider({ sessionId: "875-release" }), false,
    "释放之后宿主问不出活性（否则这个会话永远回收不掉）");
});

test("#875 格2b：release 绑的是**自己那一次注册** ⇒ 迟到的释放动不了后来者的 lease（复核 H2）", () => {
  const host = createFakeHostRegistry();
  const globalObject = { [REGISTRY_SYMBOL]: host.registry };
  const first = registerSessionLiveness({ sessionId: "875-taken-over", isActive: () => true, globalObject });
  // 同一个会话被新实例接管：新 lease 建立，旧实例的迟到事件此刻才到。
  const second = registerSessionLiveness({ sessionId: "875-taken-over", isActive: () => true, globalObject });
  assert.equal(first.registered && second.registered, true);
  assert.equal(host.list().length, 2, "两条注册此刻都在表里（宿主按 Symbol(name) 键，不会互相覆盖）");
  first.release();
  assert.equal(host.list().length, 1, "迟到的释放只能放掉它自己那条");
  const rows = host.list();
  assert.equal(rows[0].sessionId, "875-taken-over");
  assert.equal(host.registry.hasActiveProvider({ sessionId: "875-taken-over" }), true,
    "活实例的 lease 不许被迟到的 release 放掉（放掉了就正问题是那个会话又被回收）");
  second.release();
  assert.equal(host.list().length, 0);
});

test("#875 格3：registry 缺席 ⇒ registered === false，release() 不抛，且不往 globalThis 里造表", () => {
  const restore = installOnGlobalThis(undefined);
  try {
    assert.equal(resolvePiWebLivenessRegistry(), null, "没挂键就是没有这条通道");
    const lease = registerSessionLiveness({ sessionId: "875-no-host", isActive: () => true });
    assert.equal(lease.registered, false, "pi CLI / 老版本 pi-web：降级成今天的行为");
    assert.doesNotThrow(() => lease.release(), "缺席时 release 也必须可用且不抛");
    assert.equal(globalThis[REGISTRY_SYMBOL], undefined,
      "本层只读不写：自己造一张表等于冒充宿主（宿主自己会建，不需要扩展替它建）");
  } finally {
    restore();
  }
});

test("#875 格4：version !== 1 的旧表 ⇒ 当它不存在（registered === false），且一次也没调用它的 register", () => {
  const host = createFakeHostRegistry({ version: 2 });
  const globalObject = { [REGISTRY_SYMBOL]: host.registry };
  assert.equal(resolvePiWebLivenessRegistry(globalObject), null, "版本对不上就是另一张表");
  const lease = registerSessionLiveness({ sessionId: "875-old-host", isActive: () => true, globalObject });
  assert.equal(lease.registered, false);
  assert.equal(host.registerCalls.length, 0, "校验不过就别劳驾那张表（拿旧表的 register 试一把，是拿宿主的不确定性赌）");
  assert.doesNotThrow(() => lease.release());
});

test("#875 格4b：register 不是函数的表 ⇒ 同样当它不存在", () => {
  const globalObject = { [REGISTRY_SYMBOL]: { version: 1, hasActiveProvider: () => false } };
  assert.equal(resolvePiWebLivenessRegistry(globalObject), null);
  const lease = registerSessionLiveness({ sessionId: "875-bad-registry", isActive: () => true, globalObject });
  assert.equal(lease.registered, false);
  assert.doesNotThrow(() => lease.release());
});

test("#875 格5：坏参数（空 sessionId / isActive 非函数 / name 含空格）⇒ registered === false 且没调用宿主的 register", () => {
  const host = createFakeHostRegistry();
  const globalObject = { [REGISTRY_SYMBOL]: host.registry };
  const cases = [
    ["空 sessionId", { sessionId: "", isActive: () => true }],
    ["缺 sessionId", { isActive: () => true }],
    ["isActive 不是函数", { sessionId: "875-bad", isActive: "yes" }],
    ["name 含空格（不在宿主字符集里）", { sessionId: "875-bad", isActive: () => true, name: "erix run" }],
    ["name 为空", { sessionId: "875-bad", isActive: () => true, name: "" }],
  ];
  for (const [label, options] of cases) {
    const lease = registerSessionLiveness({ ...options, globalObject });
    assert.equal(lease.registered, false, `${label}：必须挡在本层，不许注册`);
    assert.doesNotThrow(() => lease.release(), `${label}：release 仍要可用`);
  }
  assert.equal(host.registerCalls.length, 0,
    "本层先挡 ⇒ 一次也不劳驾宿主（拿「宿主会抛」当降级路径，就是把异常打给用户）");
});

test("#875 格6：宿主的 register 抛异常 ⇒ registered === false，函数本身不抛（绝不许把宿主带崩）", () => {
  const host = createFakeHostRegistry({ throwOnRegister: true });
  const globalObject = { [REGISTRY_SYMBOL]: host.registry };
  let lease;
  assert.doesNotThrow(() => {
    lease = registerSessionLiveness({ sessionId: "875-rejected", isActive: () => true, globalObject });
  }, "宿主拒收是本层内部事实，不是异常");
  assert.equal(lease.registered, false);
  assert.equal(host.registerCalls.length, 1, "这一条确实到了宿主门口才被拒（不是本层提前挡下）");
  assert.doesNotThrow(() => lease.release(), "拒收之后 release 也要可用（调用方不必分情况）");
});

test("#875 格6b：register returns 非函数 ⇒ 同样降级成「没这条通道」", () => {
  const globalObject = { [REGISTRY_SYMBOL]: { version: 1, register: () => undefined, hasActiveProvider: () => false } };
  const lease = registerSessionLiveness({ sessionId: "875-no-release", isActive: () => true, globalObject });
  assert.equal(lease.registered, false, "拿不到 release 就等于拿不到 lease（否则没人能放掉它）");
  assert.doesNotThrow(() => lease.release());
});

test("#875 格7：sessionFile 为空串 / undefined ⇒ 交给宿主的对象里根本没有这个键（宿主会拿空串抛）", () => {
  for (const value of ["", undefined]) {
    const host = createFakeHostRegistry();
    const lease = registerSessionLiveness({
      sessionId: "875-file",
      sessionFile: value,
      isActive: () => false,
      globalObject: { [REGISTRY_SYMBOL]: host.registry },
    });
    assert.equal(lease.registered, true, `sessionFile=${JSON.stringify(value)} 时也要注册得上（这一格只关一个键的存在性）`);
    assert.equal(host.registerCalls.length, 1);
    assert.ok(!("sessionFile" in host.registerCalls[0]),
      "不许把空 sessionFile 递给宿主（宿主的 assertNonEmptyString 会抛 ⇒ 整条 lease 都建不起来），实测键："
      + JSON.stringify(Object.keys(host.registerCalls[0])));
    lease.release();
  }
  // 对照组：非空 sessionFile 必须**带上**（宿主按 sessionId ∪ sessionFile 找 provider，漏了这个键就少一个匹配维度）
  const host = createFakeHostRegistry();
  const lease = registerSessionLiveness({
    sessionId: "875-file",
    sessionFile: "/tmp/875-session.jsonl",
    isActive: () => true,
    globalObject: { [REGISTRY_SYMBOL]: host.registry },
  });
  assert.equal(host.registerCalls[0].sessionFile, "/tmp/875-session.jsonl");
  assert.equal(host.registry.hasActiveProvider({ sessionId: "other", sessionFile: "/tmp/875-session.jsonl" }), true,
    "宿主只拿 sessionFile 来问（sessionId 对不上）也要问得到这一条 —— 少了那个键这里就是 false");
  assert.equal(host.registry.hasActiveProvider({ sessionId: "875-file" }), true, "按 sessionId 问同样要得到 true");
  assert.equal(host.registry.hasActiveProvider({ sessionId: "other", sessionFile: "/tmp/nope.jsonl" }), false,
    "不相干的会话不许被本条 lease 挡下来");
  lease.release();
});

test("#875 格8：sessionHasLiveWork —— queued / running ⇒ true；completed 且没有 notifyRetry ⇒ false", () => {
  const jobs = new Map([
    ["r-queued", { ownerSessionId: "875-live", status: "queued" }],
    ["r-running", { ownerSessionId: "875-live", status: "running" }],
  ]);
  assert.equal(sessionHasLiveWork(jobs, "875-live"), true, "queued 算在飞");
  jobs.delete("r-queued");
  assert.equal(sessionHasLiveWork(jobs, "875-live"), true, "running 算在飞");
  jobs.set("r-done", { ownerSessionId: "875-live", status: "completed" });
  jobs.delete("r-running");
  assert.equal(sessionHasLiveWork(jobs, "875-live"), false, "结算完且没欠账 ⇒ 不许再替它挡回收（否则会话永不回收）");
  for (const status of ["aborted", "failed", "cancelled"]) {
    jobs.set("r-done", { ownerSessionId: "875-live", status });
    assert.equal(sessionHasLiveWork(jobs, "875-live"), false, `${status} 不是 ACTIVE_JOB_STATUSES 里的值`);
  }
});

test("#875 格9：completed 但 notifyRetry 还在 ⇒ true（复核 C 条：run 跑完、通知还没投出去的那段窗口）", () => {
  const jobs = new Map([["r-retry", { ownerSessionId: "875-retry", status: "completed", notifyRetry: {} }]]);
  assert.equal(sessionHasLiveWork(jobs, "875-retry"), true,
    "这段窗口只有 5/10/30 秒，但回收掉它就等于把刚跑完的终局退回 orphaned");
  // 对照组：定时器已被清（`notifyRetry === undefined`）就不再挡回收
  jobs.get("r-retry").notifyRetry = undefined;
  assert.equal(sessionHasLiveWork(jobs, "875-retry"), false, "notifyRetry 清掉之后必须放开，否则会话永不回收");
});

test("#875 格10：别人名下的 job 不算本会话的活（多会话隔离）", () => {
  const jobs = new Map([
    ["r-a", { ownerSessionId: "875-A", status: "running" }],
    ["r-b", { ownerSessionId: "875-B", status: "running" }],
    ["r-anon", { status: "running" }],
  ]);
  assert.equal(sessionHasLiveWork(jobs, "875-C"), false,
    "进程里有活 ≠ 本会话有活（拿「进程里有活」当判据，所有会话都永不回收）");
  assert.equal(sessionHasLiveWork(jobs, "875-A"), true);
  assert.equal(sessionHasLiveWork(jobs, "875-B"), true);
});

test("#875 格11：sessionId 为空 / jobs 为 undefined ⇒ false 且不抛", () => {
  const jobs = new Map([["r", { ownerSessionId: "875-x", status: "running" }]]);
  assert.equal(sessionHasLiveWork(jobs, ""), false);
  assert.equal(sessionHasLiveWork(jobs, undefined), false);
  assert.equal(sessionHasLiveWork(undefined, "875-x"), false, "runtime 还没建（测试装载器直接调 execute）也不许抛");
  assert.equal(sessionHasLiveWork(new Map(), "875-x"), false);
  assert.equal(sessionHasLiveWork({ notAIterable: true }, "875-x"), false, "形状不对就当没有（判据不许抛给宿主）");
});
