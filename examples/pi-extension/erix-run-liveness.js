// @ts-check
// erix_run 的「会话活性申报」（issue #875）：**逐条对照** pi-web 0.13.0 的宿主契约
// （`globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")]`，README §Extension Session Liveness）。
//
// 为什么需要它：pi-web 在一个 Node 进程里跑 N 个会话，空闲 `PI_WEB_IDLE_TIMEOUT_MS`（默认 10 分钟）
// 就回收 —— 回收判据是 `isRunning() || hasActiveProvider({sessionId, sessionFile})`。后台 run 从会话
// 角度看**不算 running**（派工那次工具调用早就返回了），所以不申报就必然被回收；回收后终局通知只能
// 记 `delivery:"orphaned"`，等用户下次点开（`session_start` → `requeueOrphaned`）才补投一次。
//
// 本文件不 import pi：registry 从 globalThis 取、`isActive` 由调用方注入，所以 `node --test` 可测。
// 唯一的仓内 import 是 `ACTIVE_JOB_STATUSES`（判「还有在飞的 job」的口径必须只有一份）。

import { ACTIVE_JOB_STATUSES } from "./erix-run-jobs.js";

/** 宿主的版本化注册表键（值逐字取自宿主；改一个字就等于另开一张表）。 */
export const PI_WEB_LIVENESS_REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
/** 宿主接受的 provider 名字面（`^[A-Za-z0-9_-]{1,64}$`）。 */
export const LIVENESS_PROVIDER_NAME = "erix-run";
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 取宿主那张注册表。**照抄宿主的自校验口径**（`version === 1` + `register` 是函数）：
 * 校验不过就当它不存在 —— 契约缺席时「没有这条通道」是事实，不是错误。
 *
 * @param {object} [globalObject]
 * @returns {{version:number, register:Function, hasActiveProvider?:Function}|null}
 */
export function resolvePiWebLivenessRegistry(globalObject = globalThis) {
  const store = /** @type {any} */ (globalObject);
  const registry = store[Symbol.for(PI_WEB_LIVENESS_REGISTRY_KEY)];
  if (!registry || typeof registry !== "object") return null;
  if (registry.version !== 1) return null;
  if (typeof registry.register !== "function") return null;
  return registry;
}

/**
 * 申报本会话的活性。返回的 `release` **幂等**，并且**绑在这一次注册上**（不读任何可变的会话 id）——
 * 迟到的事件只能放掉它自己那条 lease，不会误放后来者的（issue #875 复核 H2）。
 *
 * registry 缺席（pi CLI、老版本 pi-web）⇒ `{registered:false, release:noop}`，**不抛**：
 * 这条通道只影响宿主的自动回收，缺席时退化成今天的行为。
 *
 * @param {{sessionId?:string, sessionFile?:string, isActive?:()=>boolean,
 *          name?:string, globalObject?:object}} [options]
 * @returns {{registered:boolean, release:()=>void}}
 */
export function registerSessionLiveness(options = {}) {
  const noop = Object.freeze({ registered: false, release: () => {} });
  const { sessionId, sessionFile, isActive, name = LIVENESS_PROVIDER_NAME, globalObject } = options;
  // 宿主 `register` 会对这几格抛（`name` / `sessionId` / `sessionFile` 非空、`isActive` 是函数）⇒ 本层先挡，
  // 不拿「宿主抛异常」当降级路径（那会把异常打给用户）。`name` 的正则校验是**本层自己加的**（比宿主更严：
  // 宿主只校非空；`^[A-Za-z0-9_-]{1,64}$` 在宿主里是另一处的 `HOLDER_PATTERN`，不是 provider 名校验）。
  if (typeof sessionId !== "string" || sessionId === "") return noop;
  if (typeof isActive !== "function") return noop;
  if (!PROVIDER_NAME_PATTERN.test(name)) return noop;
  const registry = resolvePiWebLivenessRegistry(globalObject);
  if (registry === null) return noop;
  try {
    const release = registry.register({
      name,
      sessionId,
      ...(typeof sessionFile === "string" && sessionFile !== "" ? { sessionFile } : {}),
      isActive,
    });
    if (typeof release === "function") return { registered: true, release };
  } catch {
    // 宿主拒收 ⇒ 降级成「没这条通道」。绝不许把宿主带崩。
  }
  return noop;
}

/**
 * 本会话名下还有没有「值得为它挡一次回收」的活。两个来源，缺一不可：
 *
 * 1. `ACTIVE_JOB_STATUSES` 里的 job（`queued` / `running`）；
 * 2. **已结算但还有待投递重试的 job**（`job.notifyRetry !== undefined`）——
 *    这一段窗口只有 5/10/30 秒，但正好落在「run 跑完了、通知还没投出去」上，
 *    回收掉它就等于把刚跑完的终局退回 `orphaned`（issue #875 复核 C 条）。
 *
 * @param {Map<string, object>|undefined} jobs 进程级 job 表（`asyncRuntime().jobs`）
 * @param {string|undefined} sessionId
 * @returns {boolean}
 */
export function sessionHasLiveWork(jobs, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const iterable = typeof jobs?.values === "function" ? jobs.values() : [];
  for (const job of iterable) {
    if (job?.ownerSessionId !== sessionId) continue;
    if (ACTIVE_JOB_STATUSES.includes(job.status)) return true;
    if (job.notifyRetry !== undefined) return true;
  }
  return false;
}
