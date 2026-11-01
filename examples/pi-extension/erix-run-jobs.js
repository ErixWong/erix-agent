// erix_run 的异步执行层（issue #234）：job 注册表 + `status.json` 落盘 + 立即返回句柄 +
// `action` 查询/取消面 + run 级超时看门狗 + 完成投递去重。
//
// 机制参考（本文件**不 import** pi-subagents，所以下面不是「照搬代码」而是「从哪个位置取了什么主意」；
// 逐条上游行号 + 本层落点的完整对照见 docs/research/2026-10-13-pi-subagents-async-attribution.md）：
//   - 立即返回句柄 + 进程内 job 注册表：pi-subagents `extension/index.js:284`（`asyncJobs: new Map()`）、
//     `runs/background/async-job-tracker.js:770,893`（`asyncJobs.set` 登记）、
//     `runs/background/async-execution.js:1440,2011`（不等内层跑完就返回，`details` 带 runId/asyncId 当句柄）
//   - 状态落盘 `<dir>/status.json`：pi-subagents `shared/utils.js:126`（本层落点见 `statusFilePath`，但路径
//     不跟它的 `asyncDir`，且 tmp + rename 原子写是本层自己加的）
//   - 唤醒策略 `!(quiet && completed)`：pi-subagents `runs/background/notify.js:226-227`
//   - 投递去重（TTL + 容量上限）：pi-subagents `runs/background/notify.js:371`（两个常量 `:19-20`，
//     本层 `:38-39` 逐字同值）
//   - 超时定时器归 run 级、不在工具调用里：上游是把 `timeoutMs`/`deadlineAt` 交给那个独立 runner 进程
//     （`runs/background/async-execution.js:1211,1440,1647`）；`watchdog/runtime.js` 是 review/settle 的大循环，
//     本层只取「到点 abort + 把终局写成 aborted」这一小片，不抄整套看门狗
//
// 与 pi 的接线（`pi.sendMessage` / `ctx.isIdle()` / `session_start`）全在 erix-run.ts 与
// erix-run-parent-wake.js 里；**本文件不 import pi**，所以 `node --test` 可以直接加载它。
//
// issue #654（本文件的两次加法，都不碰上面的机制）：
//   1. **按会话隔离的投递句柄**：job 上记派工那一刻的 `ownerSessionId`，投递前按它去
//      `createSessionHandleRegistry()` 查**那个会话的**句柄；查不到就记 `delivery:"orphaned"`，
//      **绝不退化成「投给进程里最后启动的那个会话」**（pi-web 一个进程跑 N 个会话，扩展 factory
//      每会话各调一次 ⇒ 进程级单槽必然被后到者覆盖，通知投错会话）。
//   2. **投递事实落盘**：`delivery` / `notifyTargetSessionId` / `notifyError` 进 `jobView`（= `status.json`），
//      并且三处 settle 路径一律**先投递、后落盘**——先落盘那一刻投递还没发生，盘上永远是空值。
//      只有 `delivery === "sent"` 才 `claim.settle(true)`（有界重试是下一张单，本文件只做判定）。
//
// ⚠ 后台 run **与扩展同进程**——这是**本单自己的选择**，不是学 pi-subagents：上游**每个**后台 run 都
// `spawn` 一个独立 runner 进程（`runs/background/async-execution.js:4` 导入 `spawn`、`spawnRunner` 定义在 `:385`、
// `:484` 真调用，调用点 `:1255` / `:1800`；旧注释说它「也没为每个子任务 spawn」是假的，#269 已改）。
// 代价：pi 进程退出或 `/reload` 会杀掉在跑的后台 run，不会自动续跑。跨重启恢复不属于本单（那是 #207 R2 + run-state store）。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  artifactPaths,
  buildErrorPayload,
  buildSuccessPayload,
  newRunId,
  parseRunParams,
  resolveArtifacts,
  runErixRun,
} from "./erix-run-core.js";

/** `status.json` 的状态机取值（照 pi-subagents 的 queued/running + 本层的三种终局）。 */
export const JOB_STATUSES = Object.freeze(["queued", "running", "completed", "failed", "aborted"]);
/** 还没结束的取值（`list` 与「还有活没干完」的判据）。 */
export const ACTIVE_JOB_STATUSES = Object.freeze(["queued", "running"]);
/**
 * 完成投递去重注册表的 TTL / 容量上限（照 pi-subagents `runs/background/notify.js:19-20`
 * 的 `COMPLETION_SEND_TTL_MS` / `COMPLETION_SEND_REGISTRY_CAP`，两个值逐字取同一对）。
 */
export const COMPLETION_SEND_TTL_MS = 10 * 60 * 1000;
export const COMPLETION_SEND_REGISTRY_CAP = 4_096;
/** 去重注册表 / job 注册表挂在 globalThis 的 `Symbol.for` 键（扩展 `/reload` 之后不丢）。 */
export const SEND_REGISTRY_SYMBOL = Symbol.for("erix-run.completion-send-registry.v1");
export const JOB_REGISTRY_SYMBOL = Symbol.for("erix-run.async-jobs.v1");
/** 会话句柄注册表（issue #654）：`sessionId` → 那个会话的投递句柄。 */
export const SESSION_HANDLE_REGISTRY_SYMBOL = Symbol.for("erix-run.session-handles.v1");

/**
 * 投递事实的取值域（issue #654 缺陷 2）。`delivery` 字段**恒在场**（未尝试时是 `null`），取值只在这五个里：
 *
 * | 取值 | 含义 |
 * |---|---|
 * | `sent` | 投递调用被宿主接受（不抛、也没被显式拒绝）。⚠ 诚实边界：pi 的 `sendMessage` 契约是 `void`，异步失败经 `runner.emitError` 上报、不回到调用方 ⇒ 本层能确认的**上界**就是「调用被接受」 |
 * | `deduped` | 同一个 run 的完成已经投过，本次被去重注册表挡下（次数记在 `job.deduped`） |
 * | `failed` | 投递调用抛了异常，或句柄 / 宿主显式拒绝（原因在 `job.notifyError`） |
 * | `orphaned` | 派工会话的句柄查不到（会话已关闭 / 扩展实例已换）⇒ **不投给任何存活会话** |
 * | `no-owner` | 这条 job 没有会话身份（派工时没拿到 `sessionId`）⇒ 本层不替调用方猜目标 |
 */
export const DELIVERY_VALUES = Object.freeze(["sent", "deduped", "failed", "orphaned", "no-owner"]);

function textOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return String(value ?? "");
}

/**
 * 唤醒策略（照 pi-subagents `runs/background/notify.js:226` 的
 * `scheduledCompletionTriggersTurn(origin, outcome) = !(origin.quiet === true && outcome === "completed")`）。
 *
 * 没有这一档，一批便宜切片会把主会话打断成筛子：**quiet 的成功完成只落状态、不吵父会话**；
 * 失败/中止仍然要唤醒（那是可动作的结果，不是噪音）。
 *
 * @param {{quiet?:boolean, outcome?:string}} [input]
 * @returns {boolean}
 */
export function completionTriggersTurn(input = {}) {
  return !(input.quiet === true && input.outcome === "completed");
}

/** 终局载荷 → 状态机的终局取值（`completed` / `failed` / `aborted`）。 */
export function outcomeOf(payload) {
  if (payload?.aborted === true) return "aborted";
  return payload?.ok === true ? "completed" : "failed";
}

/**
 * 投递去重注册表（照 pi-subagents `runs/background/notify.js:371` 的
 * `createCompletionSendRegistry(ttlMs, cap)`）：**同一个 run 的完成只投递一次**。
 *
 * 重复来源是真实的：终局可能同时来自「内层 run 返回」与「看门狗到点」，`/reload` 之后旧
 * 实例的闭包还会再投一次，宿主重试也会。语义与上游一致：
 *   - `claim(key, now)` 首次返回 `{owned:true, settle(accepted)}`；后来者 `{owned:false}`；
 *   - `settle(false)` 会把条目**删掉**（没投成功就允许再投），`settle(true)` 记 `deliveredAt`；
 *   - `prune` 先按 TTL 清，再按容量上限从插入序淘汰**已投递**的条目（未投递的 in-flight 不动）。
 *
 * @param {number} [ttlMs]
 * @param {number} [cap]
 */
export function createCompletionSendRegistry(ttlMs = COMPLETION_SEND_TTL_MS, cap = COMPLETION_SEND_REGISTRY_CAP) {
  /** @type {Map<string, {deliveredAt?:number}>} */
  const entries = new Map();
  const prune = (now) => {
    for (const [key, entry] of entries) {
      if (entry.deliveredAt !== undefined && now - entry.deliveredAt > ttlMs) entries.delete(key);
    }
    if (entries.size <= cap) return;
    for (const key of [...entries.keys()]) {
      if (entries.size <= cap) break;
      if (entries.get(key)?.deliveredAt !== undefined) entries.delete(key);
    }
  };
  return {
    claim(key, now = Date.now()) {
      prune(now);
      if (entries.has(key)) return { owned: false, settle: () => {} };
      let claimed = false;
      entries.set(key, {});
      claimed = true;
      return {
        owned: true,
        settle(accepted, settleNow = now) {
          if (!claimed || entries.get(key)?.settled === true) return;
          const entry = entries.get(key);
          if (entry === undefined) return;
          entry.settled = true;
          if (accepted === true) {
            entry.deliveredAt = settleNow;
            prune(settleNow);
          } else {
            entries.delete(key);
          }
        },
      };
    },
    has: (key) => entries.has(key),
    get size() { return entries.size; },
    clear: () => entries.clear(),
  };
}

/** 进程级去重注册表（`Symbol.for` 挂 globalThis：`/reload` 之后新实例仍知道「这个 run 投过了」）。 */
export function globalCompletionSendRegistry() {
  const store = /** @type {any} */ (globalThis);
  return store[SEND_REGISTRY_SYMBOL] ?? (store[SEND_REGISTRY_SYMBOL] = createCompletionSendRegistry());
}

/**
 * job 注册表：内存 Map + 已知 `sessionDir` 清单（`action:"status"` 在内存查不到时按清单读盘）。
 * 同样 `Symbol.for` 挂 globalThis —— `/reload` 后新扩展实例仍能查/能取消（旧 run 的闭包还在写盘）。
 */
export function createAsyncJobRegistry() {
  /** @type {Map<string, object>} */
  const jobs = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  return {
    jobs,
    dirs,
    set: (runId, job) => jobs.set(runId, job),
    get: (runId) => jobs.get(runId),
    delete: (runId) => jobs.delete(runId),
    list: () => [...jobs.values()],
    noteDir: (dir) => { if (typeof dir === "string" && dir !== "") dirs.add(dir); },
    knownDirs: () => [...dirs],
    get size() { return jobs.size; },
    clear: () => { jobs.clear(); dirs.clear(); },
  };
}

export function globalAsyncJobRegistry() {
  const store = /** @type {any} */ (globalThis);
  return store[JOB_REGISTRY_SYMBOL] ?? (store[JOB_REGISTRY_SYMBOL] = createAsyncJobRegistry());
}

/**
 * 会话句柄注册表（issue #654 缺陷 1）：**按 `sessionId` 键**，不是进程级单槽。
 *
 * 为什么需要它：pi 的多会话宿主（pi-web）在**一个 Node 进程里跑 N 个会话**，扩展 factory 对每个
 * 会话各调一次（pi 的 `loader.js` 把 factory 缓存在进程级 `extensionCache`，但 `await factory(api)`
 * 处是**每会话各调一次**）——所以「模块级 `let wake / piRef`」这种单槽必然被后到者覆盖：A 会话
 * 派工的 run 结算时会把通知投到 B 会话的 `pi` 上，连「父会话忙不忙」（`ctx.isIdle()`）读的也是 B 的。
 *
 * 句柄由扩展在 `session_start` 里注册（每会话一份，闭包捕获**自己那个会话的** `pi` / 唤醒器）；
 * 投递时按 `job.ownerSessionId` 查——查不到就是 `orphaned`，不允许退化成「最后一个会话」。
 * `Symbol.for` 挂 globalThis 的理由与另两个注册表同：`/reload` 之后新实例仍能查到旧 run 的归属。
 */
export function createSessionHandleRegistry() {
  /** @type {Map<string, object>} */
  const handles = new Map();
  const usable = (sessionId) => typeof sessionId === "string" && sessionId !== "";
  return {
    set(sessionId, handle) {
      // 空 id / 空句柄不登记：它们只会变成「投给谁都不对」的垃圾条目。
      if (!usable(sessionId) || handle === null || handle === undefined) return false;
      handles.set(sessionId, handle);
      return true;
    },
    get: (sessionId) => (usable(sessionId) ? handles.get(sessionId) : undefined),
    has: (sessionId) => usable(sessionId) && handles.has(sessionId),
    delete: (sessionId) => handles.delete(sessionId),
    ids: () => [...handles.keys()],
    get size() { return handles.size; },
    clear: () => handles.clear(),
  };
}

export function globalSessionHandleRegistry() {
  const store = /** @type {any} */ (globalThis);
  return store[SESSION_HANDLE_REGISTRY_SYMBOL]
    ?? (store[SESSION_HANDLE_REGISTRY_SYMBOL] = createSessionHandleRegistry());
}

/**
 * 投递口的返回值 → 投递事实（issue #654 缺陷 3）。
 *
 * 旧的判定是 `accepted = notify(...) !== false`：`true` 只代表「调用没抛」，随后 `claim.settle(true)`
 * 把去重位记成已投递，连重投的机会都没了。现在把三件事一起纳入判定：
 *   - `false` ⇒ `failed`（宿主/句柄显式拒绝）；
 *   - `DELIVERY_VALUES` 里的字符串或 `{delivery}` 对象 ⇒ 原样记（投递口自己说得更细，比如 `no-owner`）；
 *   - 其余真值 / `undefined` ⇒ `sent`（pi 的 `sendMessage` 契约是 `void`，不抛即“被接受”，上界见 `DELIVERY_VALUES` 表）。
 *
 * @param {unknown} verdict
 * @returns {string}
 */
function deliveryOf(verdict) {
  if (verdict === false) return "failed";
  if (typeof verdict === "string") return DELIVERY_VALUES.includes(verdict) ? verdict : "sent";
  if (verdict !== null && typeof verdict === "object") {
    const claimed = /** @type {{delivery?:unknown}} */ (verdict).delivery;
    if (typeof claimed === "string") return DELIVERY_VALUES.includes(claimed) ? claimed : "sent";
  }
  return "sent";
}

/** @param {unknown} verdict */
function notifyErrorOf(verdict) {
  if (verdict === null || typeof verdict !== "object") return undefined;
  const error = /** @type {{error?:unknown}} */ (verdict).error;
  return typeof error === "string" && error !== "" ? error : undefined;
}

/**
 * `status.json` 的落点：`<sessionDir>/outputs/<safeRunId>/status.json` —— 与 #207 的
 * `judge.log` **同一棵目录树**（一个 run 的产物集中在一处，不新造布局）。
 * 没传 `sessionDir` 的异步 run 只有内存注册表（进程活着的期间可查），**不落盘**。
 */
export function statusFilePath({ sessionDir, runId }) {
  if (sessionDir === undefined || sessionDir === null || sessionDir === "") return undefined;
  // 与 judge.log **同目录**：布局只由 core 的 artifactPaths 定一处，这里不重算 safeId。
  const { judgeLogPath } = artifactPaths({ sessionDir, runId });
  return path.join(path.dirname(judgeLogPath), "status.json");
}

/**
 * 写 `status.json`：**同目录 tmp + rename 的原子写**（读者永远看不到半截文件）。写不进去只回报错误。
 *
 * `deps` 是测试注入缝（照 `erix-run-core.js` 的 `deps.createStore` 风格，#237 R4）：
 * `mkdirSync` / `writeFileSync` / `renameSync` / `unlinkSync` 都可换；没注入时就是真 fs，
 * 行为与注入前逐字一致。**没这条缝时「原子写」一条测试都钉不住**（主 agent 实测：把它
 * 退化成「直接写同名文件」，全量测试零红）。
 *
 * 写中途失败时的三条保证（由 test/examples/erix-run-async.test.js 的 #237 R4 四条钉住）：
 *   1. **旧文件内容不被破坏**：renamed 没成功就没人动过 `status.json`；
 *   2. **不留 `.tmp-` 残留**：半截临时文件在 catch 里清掉；
 *   3. **不抛**：错误以 `{path, error}` 回报，由 `persistStatus` 放进 `job.statusWriteError`
 *      → 经 `jobView` 进查询视图与 `details`（模型看得见「这次没落盘」），不把派工/查询面带崩。
 *
 * @param {{sessionDir?:string|null, runId:string, view:object, now?:()=>number}} input
 * @param {{mkdirSync?:Function, writeFileSync?:Function, renameSync?:Function, unlinkSync?:Function}} [deps]
 */
export function writeStatusFile({ sessionDir, runId, view, now = () => Date.now() }, deps = {}) {
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const writeFile = deps.writeFileSync ?? writeFileSync;
  const rename = deps.renameSync ?? renameSync;
  const unlink = deps.unlinkSync ?? unlinkSync;
  const file = statusFilePath({ sessionDir, runId });
  if (file === undefined) return { path: undefined, error: undefined };
  let tmp;
  try {
    mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    tmp = `${file}.tmp-${process.pid}-${now().toString(36)}`;
    writeFile(tmp, `${JSON.stringify(view, null, 2)}\n`, "utf8");
    rename(tmp, file);
    return { path: file, error: undefined };
  } catch (error) {
    // 半截临时文件不能留在盘上：读者只该看到 `status.json` 这一个名字。
    if (tmp !== undefined) {
      try { unlink(tmp); } catch { /* 清不掉也只能作罢：旧 status.json 已经保住了 */ }
    }
    return { path: file, error: textOf(error?.message ?? error) };
  }
}

/** 从盘上读一个 run 的状态（内存注册表 miss 时的兜底；坏文件一律当「没有」，绝不抛）。 */
export function readStatusFile({ sessionDir, runId }) {
  const file = statusFilePath({ sessionDir, runId });
  if (file === undefined || !existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同步终局结果的**字段表**（#276 的结构修法：不再手抄）。
 *
 * 这张清单是在**模块装载期**从 core 的两个载荷构造器（`runJob` 返回值的唯一产地，
 * `erix-run-core.js` 的 `buildSuccessPayload`/`buildErrorPayload`）**现场探出来**的：
 * 上游新加一个同步字段，这张表当场变长，`jobView` 跟着把它投到 `action:"result"` /
 * `action:"status"` / `status.json` 三处——「抄漏」在结构上不会再发生（#276 与 A3/`d14f0f7`
 * 都是手抄投影拄漏，两次都没人守）。
 *
 * 两个构造器都是纯函数（不碰 fs / 网络），拿最小探针各跑一次是零成本的；两条出口都要探，
 * 因为抛错载荷多一个 `error`。探不动（上游改了签名）时不在装载期抛，只让
 * `UNPROJECTED_SYNC_FIELDS` 与测试报红。
 *
 * @returns {string[]}
 */
function probeSyncResultFields() {
  const probeInput = {
    timeout: false,
    aborted: false,
    observerErrors: [],
    metadataEvents: [],
    ledgerErrors: [],
    persistenceErrors: [],
    context: {},
  };
  /** @type {Set<string>} */
  const fields = new Set();
  for (const [build, source] of [[buildSuccessPayload, {}], [buildErrorPayload, new Error("#276 probe")]]) {
    try {
      const payload = build(source, probeInput);
      for (const field of Object.keys(payload ?? {})) fields.add(field);
    } catch { /* 探不动就少一个字段：由 UNPROJECTED_SYNC_FIELDS / #276 断言报红，不拖垮扩展 */ }
  }
  return [...fields];
}

/** 视图必须覆盖的同步字段全集（**派生值**，不是手抄清单）。 */
export const SYNC_RESULT_FIELDS = Object.freeze(probeSyncResultFields());

/**
 * 终局事实的**逐字段口径表**：只回答「这个字段怎么投（含未终局时的零值形状）」，
 * **不回答「有哪些字段」**（后者由 `SYNC_RESULT_FIELDS` 定）——所以加字段只需要在一处登记口径，
 * 而口径没登记也不会丢数据（走 `projectUnknownField`），只是 `UNPROJECTED_SYNC_FIELDS` 非空报红。
 */
const TERMINAL_FIELD_SHAPES = {
  ok: (payload) => payload?.ok ?? null,
  finalText: (payload) => (typeof payload?.finalText === "string" ? payload.finalText : ""),
  rounds: (payload) => payload?.rounds ?? 0,
  truncated: (payload) => payload?.truncated ?? false,
  usage: (payload) => payload?.usage ?? { input_tokens: 0, output_tokens: 0 },
  termination: (payload) => payload?.termination ?? null,
  verification: (payload) => payload?.verification ?? null,
  timeout: (payload, job) => payload?.timeout === true || job?.timedOut === true,
  aborted: (payload, job) => payload?.aborted === true || job?.status === "aborted",
  // 沿用 core 的 `resolveArtifacts` 口径（宁给 `null` 不猜路径），不在视图里另写一份。
  artifacts: (payload, job) => {
    const artifacts = payload?.artifacts ?? resolveArtifacts(job?.persistence ?? {});
    return {
      transcriptPath: typeof artifacts?.transcriptPath === "string" ? artifacts.transcriptPath : null,
      judgeLogPath: typeof artifacts?.judgeLogPath === "string" ? artifacts.judgeLogPath : null,
    };
  },
  extensionCount: (payload) => payload?.extensionCount ?? 0,
  maxExtensions: (payload) => payload?.maxExtensions ?? 0,
  resumable: (payload) => payload?.resumable === true,
  // #276 的主角。#266 的 `notesLifecycle` 就在它下面，所以三处下游（status/result/status.json）一起活。
  diagnostics: (payload) => payload?.diagnostics ?? null,
  error: (payload, job) => payload?.error
    ?? (job?.cancelReason === undefined ? undefined : { name: "AbortError", message: job.cancelReason }),
};

/** 探到的同步字段里本层还没定投影口径的那些——恒为空才算健康，非空即缺陷（#276 的看守）。 */
export const UNPROJECTED_SYNC_FIELDS = Object.freeze(
  SYNC_RESULT_FIELDS.filter((field) => TERMINAL_FIELD_SHAPES[field] === undefined),
);

/**
 * 同步终局载荷 → 视图的终局事实块：字段集 = `SYNC_RESULT_FIELDS` ∪ 载荷自带的键。
 * 还没终局（没载荷）时字段仍然恒在场（与 #261 的 `finalText: ""` 同口径，查询侧不必分两种形状）。
 */
function projectTerminalFacts(job) {
  const payload = job?.payload;
  /** @type {Record<string, any>} */
  const facts = {};
  for (const field of SYNC_RESULT_FIELDS) {
    const shape = TERMINAL_FIELD_SHAPES[field];
    // 没登记口径的字段：**原样透传、缺位给 null，绝不静默丢**（地板）。
    facts[field] = shape === undefined ? (payload?.[field] ?? null) : shape(payload, job);
  }
  // 真值源比探针多知道的字段（宿主自己注入的 runJob、或装载期没探到的新字段）也不许丢。
  for (const field of Object.keys(payload ?? {})) {
    if (facts[field] === undefined) facts[field] = payload[field];
  }
  return facts;
}

/**
 * job → 可序列化视图（也是 `status.json` 的内容）。
 *
 * **形状主张（#276）**：终局视图 = **同步终局结果的每一个字段**（由 `projectTerminalFacts` 从
 * core 的载荷构造器派生，不手抄）**再加** job 自己的运行时事实。所以 `action:"result"` /
 * `action:"status"` / `status.json` 三处与同步返回同形（`diagnostics` 整块、`termination` 完整形状），
 * 而三处本来就共用这一个 `jobView`，不存在第二份拼装。
 * 刻意只给子集的是**另外两个视图**（都不是终局面）：`handleOf`（派工即返回的句柄）与
 * `action:"list"` 的摘要行——两者的键集合均有测试钉死，README「异步执行」一节写了理由。
 *
 * 四件套 = `termination.reason` / `truncated` / `rounds` / `usage`；`artifacts` 走 core 的
 * `resolveArtifacts`（**同一份 `existsSync` 口径**，不在这里另写一遍「宁给 null 不猜路径」）。
 */
export function jobView(job, { now = () => Date.now() } = {}) {
  return {
    // —— job 自己的运行时事实（异步面独有，同步返回里没有）
    runId: job.runId,
    status: job.status,
    cwd: job.cwd,
    model: job.model ?? null,
    maxRounds: job.maxRounds,
    timeoutMs: job.timeoutMs,
    sessionDir: job.sessionDir ?? null,
    statusPath: job.statusPath ?? null,
    quiet: job.quiet === true,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    elapsedMs: job.startedAt === undefined ? null : (job.finishedAt ?? now()) - job.startedAt,
    // —— 同步终局面：字段集从真值源派生，一个不拾（#276：`diagnostics` 就是这么丢的）
    ...projectTerminalFacts(job),
    // —— 异步面独有：落盘与进度
    statusWriteError: job.statusWriteError,
    progressTail: (job.progress ?? []).slice(-10),
    // —— 异步面独有：**投递事实**（issue #654 缺陷 2）。四个字段**恒在场**（未尝试时 `null` / `0`），
    //    不是「投成功了才写」——`status.json` 是 `/reload`、pi 重启后唯一残留，
    //    「投没投出去 / 投给了哪个会话 / 为什么没投成」必须能在盘上读到（口径照 #261 R4③）。
    //    它们在 `jobView` 里而不是只在内存 job 上：`status.json` 的内容就是这个函数的返回。
    ownerSessionId: job.ownerSessionId ?? null,
    delivery: job.delivery ?? null,
    notifyTargetSessionId: job.notifyTargetSessionId ?? null,
    notifyError: job.notifyError ?? null,
    deduped: job.deduped ?? 0,
  };
}

/**
 * 立即返回的句柄（工单 R1/机制 1 的形状）。
 *
 * **它是刻意的子集（9 键），本单没动它的语义**（#276）：派工那一刻四件套还不存在，句柄只负责
 * 让宿主拿住 `runId` 去查。它**不是**终局面，所以不能拿它的字段少当「异步视图本来就可以缺字段」
 * 的借口（终局视图的覆盖规矩在 `jobView` 上面，`syncOnlyFields` 为空）。键集合由
 * `#234 R1` / `#237 R2` / `#276 R2⑤` 钉死。
 */
export function handleOf(job) {
  return {
    runId: job.runId,
    status: job.status,
    cwd: job.cwd,
    model: job.model ?? null,
    maxRounds: job.maxRounds,
    timeoutMs: job.timeoutMs,
    sessionDir: job.sessionDir ?? null,
    statusPath: job.statusPath ?? null,
    quiet: job.quiet === true,
  };
}

/**
 * 异步运行时：把「派工 → 落状态 → 完成投递」这条链从工具调用里搬出来。
 *
 * @param {{
 *   home?:string, env?:NodeJS.ProcessEnv, now?:()=>number,
 *   runJob?:(params:object, opts:{signal:AbortSignal, onProgress?:(line:string)=>void, runId:string})=>Promise<any>,
 *   notify?:(job:object, content:string, opts:{triggersTurn:boolean, outcome:string, session?:object})=>unknown,
 *     // 返回值就是投递事实（见 `deliveryOf`）：`false` / `{delivery:"failed", error}` ⇒ failed；
 *     // `DELIVERY_VALUES` 里的字符串（或 `{delivery}`）⇒ 原样记账；其余真值 / `undefined` ⇒ sent。
 *     // `session` 是**派工会话的句柄**（按 `job.ownerSessionId` 从 `sessionHandles` 查出来的），
 *     // 查不到时本层根本不调 notify（记 `orphaned`），所以投递口拿不到“别的会话的 pi”。
 *   sendRegistry?:object, registry?:object, sessionHandles?:object,
 *   deps?:object,   // 透传给 core.runErixRun 与 writeStatusFile（后者的 fs 注入缝见 #237 R4）,
 * }} [options]
 */
export function createAsyncRuntime(options = {}) {
  const now = options.now ?? (() => Date.now());
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const registry = options.registry ?? globalAsyncJobRegistry();
  const sendRegistry = options.sendRegistry ?? globalCompletionSendRegistry();
  /** 会话句柄表（#654）：`sessionId` → 那个会话的投递句柄；默认是进程级按会话键的那一份。 */
  const sessionHandles = options.sessionHandles ?? globalSessionHandleRegistry();
  const deps = options.deps ?? {};
  /** 内层 run 的唯一注入缝（单测拿它换掉真引擎；默认就是 core.runErixRun） */
  const runJob = options.runJob ?? ((params, opts) => runErixRun(params, {
    ...deps,
    env,
    home,
    now,
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
    signal: opts.signal,
    ...(opts.onProgress === undefined ? {} : { onProgress: opts.onProgress }),
  }));
  /** 完成通知的投递口（生产接 parent-wake；单测收集调用次数） */
  const notify = options.notify ?? (() => true);

  const persistStatus = (job) => {
    // `deps` 一路传到落盘（#237 R4 的注入缝）：没注入时 writeStatusFile 用的就是真 fs。
    const written = writeStatusFile({ sessionDir: job.sessionDir, runId: job.runId, view: jobView(job, { now }), now }, deps);
    job.statusPath = written.path ?? job.statusPath;
    if (written.error !== undefined) job.statusWriteError = written.error;
    return job.statusPath;
  };

  /**
   * 记一笔投递事实（#654 缺陷 2）。四个字段都进 `jobView` → `status.json`，所以调用顺序比“记得写”更重要：
   * 见下面 `notifyThenPersist`（**先投递、后落盘**）。
   *
   * @param {object} job
   * @param {string} delivery
   * @param {{target?:string|null, error?:string}} [facts]
   */
  const recordDelivery = (job, delivery, facts = {}) => {
    job.delivery = delivery;
    // `null` 也是事实（“没有目标会话”），只有 `undefined`（= 调用方没提供）才不动旧值。
    if (facts.target !== undefined) job.notifyTargetSessionId = facts.target;
    job.notifyError = facts.error;
    return delivery;
  };

  /**
   * 完成投递（**带去重** + **按会话隔离**）。`sendRegistry.claim` 不是 owned 就直接返回 —— 同一 run 的终局
   * 可能被看门狗与内层返回各触发一次，`/reload` 后旧闭包还可能再来一次，只许投一次。
   *
   * 归属校验（#654 缺陷 1）：投递目标只从 `job.ownerSessionId` 查 `sessionHandles`，**没有任何回退到
   * “进程里最后启动的那个会话”的路径**。查不到就记 `orphaned` 并**不调 notify**。
   *
   * @param {object} job
   * @returns {{delivered:boolean, deduped:boolean, delivery:string, triggersTurn?:boolean}}
   */
  const notifySettled = (job) => {
    const key = `erix-run:${job.runId}`;
    const claim = sendRegistry.claim(key, now());
    if (claim.owned !== true) {
      job.deduped = (job.deduped ?? 0) + 1;
      // 去重**不覆盖**已有的投递事实：先到的那次已经写了 `sent`，那一份才是事实；
      // 只有在同一个 job 上还没记过任何投递时（`/reload` 后的新实例、或被看门狗先抢到）才记 `deduped`。
      if (job.delivery === undefined) recordDelivery(job, "deduped", { target: job.notifyTargetSessionId });
      return { delivered: false, deduped: true, delivery: job.delivery ?? "deduped" };
    }
    const view = jobView(job, { now });
    const outcome = job.status === "completed" || job.status === "failed" || job.status === "aborted"
      ? job.status : outcomeOf(job.payload);
    const triggersTurn = completionTriggersTurn({ quiet: job.quiet, outcome });
    const content = `[erix_run ${job.runId}] ${outcome}`
      + ` termination=${view.termination?.reason ?? "?"} rounds=${view.rounds}`
      + ` ↑${view.usage?.input_tokens ?? 0}/↓${view.usage?.output_tokens ?? 0}`
      + ` timeout=${view.timeout} aborted=${view.aborted}`
      + ` transcript=${view.artifacts.transcriptPath ?? "none"} judgeLog=${view.artifacts.judgeLogPath ?? "none"}`
      + (view.error?.message ? ` error=${view.error.message}` : "")
      + `；用 erix_run(action:"result", runId:${JSON.stringify(job.runId)}) 取完整终局。`;
    const ownerSessionId = typeof job.ownerSessionId === "string" && job.ownerSessionId !== ""
      ? job.ownerSessionId : undefined;
    const session = ownerSessionId === undefined ? undefined : sessionHandles.get(ownerSessionId);
    if (ownerSessionId !== undefined && session === undefined) {
      // 派工会话已不在（会话关了 / 扩展实例换了）：**不投给任何存活会话**。
      recordDelivery(job, "orphaned", { target: ownerSessionId });
      // 没投出去 ⇒ 去重位让给将来（有界重试是下一张单 S3，本单只做判定）。
      claim.settle(false, now());
      return { delivered: false, deduped: false, delivery: "orphaned", triggersTurn };
    }
    let delivery = "failed";
    try {
      const verdict = notify(job, content, { triggersTurn, outcome, session });
      delivery = deliveryOf(verdict);
      recordDelivery(job, delivery, { target: ownerSessionId ?? null, error: notifyErrorOf(verdict) });
    } catch (error) {
      // 投不出去：去重注册表要把它让给下一次重试（照 pi-subagents sendCompletion 的 try/catch 口径）
      delivery = recordDelivery(job, "failed", {
        target: ownerSessionId ?? null,
        error: textOf(error?.message ?? error),
      });
    }
    // 缺陷 3：只有**真的投出去**（sent）才把去重位记成已投递；其余一律 `settle(false)`（条目删掉），
    // 让将来的重投还有机会。旧代码是 `notify(...) !== false` ⇒ true 就锁死，连重投机会都没了。
    claim.settle(delivery === "sent", now());
    return { delivered: delivery === "sent", deduped: false, delivery, triggersTurn };
  };

  /**
   * “先投递、后落盘”（#654 缺陷 2 的**顺序坑**）。`status.json` 的内容就是 `jobView` 的投影：
   * 先落盘那一刻 `delivery` / `notifyTargetSessionId` 还没被赋值 ⇒ 盘上永远是空值，加字段等于没加。
   * 投递链上真抛了也收成 `delivery:"failed"` 的可机读事实，**绝不跳过落盘**
   * （盘上没有终局比投递失败更糟：查询侧会永远停在 running）。
   */
  const notifyThenPersist = (job) => {
    try {
      notifySettled(job);
    } catch (error) {
      recordDelivery(job, "failed", {
        target: job.notifyTargetSessionId,
        error: textOf(error?.message ?? error),
      });
    }
    persistStatus(job);
  };

  const settle = (job, payload) => {
    if (job.status !== "queued" && job.status !== "running") {
      // 看门狗/取消已经先落过 aborted 终局：内层的真终局仍然要当权威事实覆盖上去（四件套
      // 来自引擎，比看门狗知道得多），但**不再重复投递**（去重注册表也再挡一道）。
      job.payload = payload;
      job.latePayload = true;
      persistStatus(job);
      return;
    }
    job.payload = payload;
    job.status = outcomeOf(payload);
    job.finishedAt = now();
    if (job.watchdog !== undefined) { clearTimeout(job.watchdog); job.watchdog = undefined; }
    // ⚠ 顺序（#654 缺陷 2 的顺序坑）：**先投递、后落盘**。`status.json` 的内容就是 `jobView` 的投影，
    // 先落盘那一刻 `delivery` / `notifyTargetSessionId` 还没被赋值 ⇒ 盘上永远是空值（等于没修）。
    notifyThenPersist(job);
  };

  /** 派工：立即返回句柄，内层 run 在后台跑（**不 await**）。 */
  const start = (rawParams, { signal, sessionId } = {}) => {
    // 参数校验同步做：坏参数必须当场报给模型，不能变成「派工成功了但后台一条错误载荷」。
    // 形状上直接复用同步面（runErixRun 会把 ErixRunError 归一成 ok:false + error.code 载荷），
    // 免得同一个坏参数在同步/异步两条路上给出两种形状（一个有 structuredContent、一个只剩文本）。
    let params;
    try {
      params = parseRunParams(rawParams, { home });
    } catch {
      return sync(rawParams, { signal });
    }
    const runId = newRunId(now);
    const job = {
      runId,
      status: "queued",
      // #654 缺陷 1：派工那一刻的**会话身份**（`ctx.sessionManager.getSessionId()`）。投递时按它查句柄，
      // 所以「谁派的工」是一件记在 job 上的事实，不再取决于「哪个会话最后启动」。
      ownerSessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined,
      cwd: params.cwd,
      model: params.model ?? null,
      maxRounds: params.maxRounds,
      timeoutMs: params.timeoutMs,
      sessionDir: params.sessionDir,
      quiet: rawParams?.quiet === true,
      createdAt: now(),
      progress: [],
      persistence: params.sessionDir === undefined ? undefined : artifactPaths({ sessionDir: params.sessionDir, runId }),
      controller: new AbortController(),
      timedOut: false,
    };
    job.statusPath = statusFilePath({ sessionDir: job.sessionDir, runId });
    registry.set(runId, job);
    if (job.sessionDir !== undefined) registry.noteDir(job.sessionDir);
    persistStatus(job);

    // run 级看门狗（机制 5 / R5）：定时器**不在 execute() 里**，异步分支返回后到点仍要把
    // 终局写成 aborted 并落进 status.json —— 否则查询侧永远停在 running。
    job.watchdog = setTimeout(() => {
      job.timedOut = true;
      job.status = "aborted";
      job.finishedAt = now();
      job.watchdog = undefined;
      job.timedOutReason = `erix_run 超时（${job.timeoutMs}ms）`;
      // 先投递、后落盘（#654 缺陷 2 的顺序坑，口径同 settle）。
      notifyThenPersist(job);
      // 真正的 abort 走 job 自己的 controller → runErixRun 的 deps.signal → 内层 runToolLoop
      job.controller.abort(new Error(job.timedOutReason));
    }, params.timeoutMs);
    // 后台 run 不该自己把 node 进程钉住（pi 退出时不必等它）
    job.watchdog?.unref?.();

    job.startedAt = now();
    job.status = "running";
    persistStatus(job);

    const onProgress = (line) => {
      job.progress.push(line);
      if (job.progress.length > 400) job.progress.splice(0, job.progress.length - 400);
    };
    // 派工工具调用自己的 signal **不接**：它在 execute() 返回时就结束了，接上去等于每个
    // 后台 run 一出生就被取消。取消通道是 action:"cancel"（R3）。
    void signal;
    Promise.resolve()
      .then(() => runJob(params, { signal: job.controller.signal, onProgress, runId }))
      .then(
        (payload) => settle(job, payload),
        (error) => settle(job, {
          ok: false,
          finalText: "",
          rounds: 0,
          truncated: false,
          usage: { input_tokens: 0, output_tokens: 0 },
          termination: { reason: "failed", detail: textOf(error?.message ?? error), errorCode: "unknown" },
          timeout: false,
          aborted: job.controller.signal.aborted,
          artifacts: { transcriptPath: null, judgeLogPath: null },
          extensionCount: 0,
          maxExtensions: 0,
          resumable: false,
          error: { name: error?.name ?? "Error", message: textOf(error?.message ?? error) },
        }),
      )
      .catch(() => { /* notify/落盘链上的最后兜底：任何异常都不许冒到 pi */ });

    return { kind: "started", handle: handleOf(job) };
    // ⚠ **不把 `job` 一并交出去**（#237）：`job` 是活对象（AbortController / `setTimeout` 句柄
    //   / 未结算 promise，内部还有循环引用）。以前这里返回 `{kind, handle, job}`，而
    //   `erix-run.ts` 把整个 outcome 当 `details` 交给宿主 → pi 序列化 details 时抛
    //   `Converting circular structure to JSON` → 白烧一轮 auto-retry。`job` 只留在本模块
    //   内部（注册表 / 闭包）用；可机读面一律走 `handleOf` / `jobView` 的纯数据视图。
  };

  /** 同步分支：行为与 #207 逐字一致（`async` 不传就走这里）。 */
  const sync = async (rawParams, { signal, onProgress } = {}) => {
    // 不在这里预解析：原始参数直接交给 runErixRun，让它按原样把 ErixRunError 归一成
    // ok:false + error.code 的载荷（#207 之前的行为逐字不变）。在这里预解析会把坏参数
    // 变成一抛，形状从「结构化终局」塌成「扩展内部异常」。
    const payload = await runJob(rawParams, {
      signal: signal ?? deps.signal,
      onProgress: onProgress ?? deps.onProgress,
      runId: undefined,
    });
    return { kind: "sync", payload };
  };

  const lookup = (runId) => {
    const job = registry.get(runId);
    if (job !== undefined) return { source: "memory", job, view: jobView(job, { now }) };
    for (const dir of registry.knownDirs()) {
      const disk = readStatusFile({ sessionDir: dir, runId });
      if (disk !== undefined) return { source: "disk", job: undefined, view: disk };
    }
    return { source: "missing", job: undefined, view: undefined };
  };

  /** `action` 面：status / result / list / cancel（R2/R3）。 */
  const act = (rawParams) => {
    const action = textOf(rawParams?.action).trim().toLowerCase();
    if (action === "list") {
      const jobs = registry.list().map((job) => {
        const view = jobView(job, { now });
        // list 只给摘要（一张表别把上下文撑爆），细节走 status/result
        return {
          runId: view.runId, status: view.status, cwd: view.cwd, model: view.model,
          rounds: view.rounds, termination: view.termination, ok: view.ok,
          createdAt: view.createdAt, finishedAt: view.finishedAt, elapsedMs: view.elapsedMs,
          sessionDir: view.sessionDir, statusPath: view.statusPath,
        };
      });
      return { kind: "list", jobs, active: jobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status)).length };
    }
    const runId = textOf(rawParams?.runId).trim();
    if (runId === "") {
      return { kind: "error", code: "bad_params", message: `action:${action} 需要 runId（list 不需要）` };
    }
    const found = lookup(runId);
    if (found.source === "missing") {
      return { kind: "unknown-run", runId, message: `没有找到 run ${runId}（内存注册表与已知 sessionDir 下的 status.json 都查过；进程重启或没传 sessionDir 时内存表不跨重启）` };
    }
    if (action === "cancel") {
      const job = found.job;
      if (job === undefined || !ACTIVE_JOB_STATUSES.includes(job.status)) {
        return { kind: "cancel", cancelled: false, view: found.view, message: "该 run 已经结束（或只存在于盘上），无需取消" };
      }
      job.cancelReason = `erix_run 被调用方取消（action:"cancel"）`;
      job.status = "aborted";
      job.finishedAt = now();
      if (job.watchdog !== undefined) { clearTimeout(job.watchdog); job.watchdog = undefined; }
      // 先投递、后落盘（#654 缺陷 2 的顺序坑，口径同 settle）：否则返回的 view / 盘上都看不到投递事实。
      notifyThenPersist(job);
      // signal 打进内层 runToolLoop（R3）：runErixRun 的 relayCancel 会把终局写成 aborted
      job.controller.abort(new Error(job.cancelReason));
      return { kind: "cancel", cancelled: true, view: jobView(job, { now }) };
    }
    if (action === "result") {
      return { kind: "result", source: found.source, view: found.view };
    }
    // 默认（含 action:"status"）：给状态视图
    return { kind: "status", source: found.source, view: found.view };
  };

  /**
   * 生命周期清理（机制 6）：`session_shutdown` 调它，**幂等**（重复调用不重复清、不抛）。
   * ⚠ 不 abort 在跑的 run：同进程的 run 归进程活着这件事管（README 的限制条），
   *   扩展重载 / 会话切换时把人家正在跑的活掐掉不是清理，是破坏。
   */
  let shutDown = false;
  const shutdown = () => {
    if (shutDown) return false;
    shutDown = true;
    for (const job of registry.list()) {
      if (job.watchdog !== undefined) { clearTimeout(job.watchdog); job.watchdog = undefined; }
    }
    return true;
  };

  return {
    start, sync, act, dispatch, shutdown, registry, sendRegistry, sessionHandles,
    notifySettled, settle, persistStatus, notifyThenPersist, jobs: registry.jobs,
  };

  function dispatch(params, opts = {}) {
    const action = textOf(params?.action).trim();
    if (action !== "") return Promise.resolve(act(params));
    // 默认 false：不传 async 就是原有的同步语义（R1）。变异这里翻成默认异步，同步语义测试必须红。
    if (params?.async === true) return Promise.resolve(start(params, opts));
    return sync(params, opts);
  }
}
