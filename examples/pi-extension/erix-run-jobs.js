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
// ⚠ 后台 run **与扩展同进程**——这是**本单自己的选择**，不是学 pi-subagents：上游**每个**后台 run 都
// `spawn` 一个独立 runner 进程（`runs/background/async-execution.js:4` 导入 `spawn`、`spawnRunner` 定义在 `:385`、
// `:484` 真调用，调用点 `:1255` / `:1800`；旧注释说它「也没为每个子任务 spawn」是假的，#269 已改）。
// 代价：pi 进程退出或 `/reload` 会杀掉在跑的后台 run，不会自动续跑。跨重启恢复不属于本单（那是 #207 R2 + run-state store）。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  artifactPaths,
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
 * job → 可序列化视图（也是 `status.json` 的内容）。
 *
 * **终局四件套 + #207 R4 的 `artifacts` 恒在场**（`action:"result"` 与盘上文件同一个形状）：
 * 四件套 = `termination.reason` / `truncated` / `rounds` / `usage`；`artifacts` 走 core 的
 * `resolveArtifacts`（**同一份 `existsSync` 口径**，不在这里另写一遍「宁给 null 不猜路径」）。
 */
export function jobView(job, { now = () => Date.now() } = {}) {
  const payload = job?.payload;
  const artifacts = payload?.artifacts ?? resolveArtifacts(job?.persistence ?? {});
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
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    elapsedMs: job.startedAt === undefined ? null : (job.finishedAt ?? now()) - job.startedAt,
    // —— 终局四件套（未终局时给 null/零值形状，字段不缺，省得查询侧分两种形状解析）
    ok: payload?.ok ?? null,
    termination: payload?.termination ?? null,
    truncated: payload?.truncated ?? false,
    rounds: payload?.rounds ?? 0,
    usage: payload?.usage ?? { input_tokens: 0, output_tokens: 0 },
    timeout: payload?.timeout === true || job.timedOut === true,
    aborted: payload?.aborted === true || job.status === "aborted",
    // —— 终稿正文（#261）：**原样透传，视图层不截断**（单一真值：显示层 format.js 才有 4000 字口径）。
    //    载荷没带 / 还没终局时给 "" 而不是 undefined —— 与本文件「未终局时给 null/零值形状，
    //    字段不缺」同口径，查询侧不必分两种形状。缺了这个字段时 format.js 的 result 正文支是
    //    死分支、status.json 里也没有交付物正文。
    finalText: typeof payload?.finalText === "string" ? payload.finalText : "",
    // —— #207 R4 的决策事实（同一个 resolveArtifacts 口径）
    artifacts: {
      transcriptPath: typeof artifacts?.transcriptPath === "string" ? artifacts.transcriptPath : null,
      judgeLogPath: typeof artifacts?.judgeLogPath === "string" ? artifacts.judgeLogPath : null,
    },
    extensionCount: payload?.extensionCount ?? 0,
    maxExtensions: payload?.maxExtensions ?? 0,
    resumable: payload?.resumable === true,
    error: payload?.error ?? (job.cancelReason === undefined ? undefined : { name: "AbortError", message: job.cancelReason }),
    statusWriteError: job.statusWriteError,
    progressTail: (job.progress ?? []).slice(-10),
  };
}

/** 立即返回的句柄（工单 R1/机制 1 的形状）。 */
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
 *   notify?:(job:object, content:string, opts:{triggersTurn:boolean, outcome:string})=>unknown,
 *   sendRegistry?:object, registry?:object,
 *   deps?:object,   // 透传给 core.runErixRun 与 writeStatusFile（后者的 fs 注入缝见 #237 R4）,
 * }} [options]
 */
export function createAsyncRuntime(options = {}) {
  const now = options.now ?? (() => Date.now());
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const registry = options.registry ?? globalAsyncJobRegistry();
  const sendRegistry = options.sendRegistry ?? globalCompletionSendRegistry();
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
   * 完成投递（**带去重**）。`sendRegistry.claim` 不是 owned 就直接返回 —— 同一 run 的终局
   * 可能被看门狗与内层返回各触发一次，`/reload` 后旧闭包还可能再来一次，只许投一次。
   */
  const notifySettled = (job) => {
    const key = `erix-run:${job.runId}`;
    const claim = sendRegistry.claim(key, now());
    if (claim.owned !== true) {
      job.deduped = (job.deduped ?? 0) + 1;
      return { delivered: false, deduped: true };
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
    let accepted = false;
    try {
      accepted = notify(job, content, { triggersTurn, outcome }) !== false;
    } catch (error) {
      job.notifyError = textOf(error?.message ?? error);
      accepted = false;
    }
    claim.settle(accepted, now());
    return { delivered: accepted, deduped: false, triggersTurn };
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
    persistStatus(job);
    notifySettled(job);
  };

  /** 派工：立即返回句柄，内层 run 在后台跑（**不 await**）。 */
  const start = (rawParams, { signal } = {}) => {
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
      persistStatus(job);
      notifySettled(job);
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
      persistStatus(job);
      // signal 打进内层 runToolLoop（R3）：runErixRun 的 relayCancel 会把终局写成 aborted
      job.controller.abort(new Error(job.cancelReason));
      notifySettled(job);
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

  return { start, sync, act, dispatch, shutdown, registry, sendRegistry, notifySettled, settle, persistStatus, jobs: registry.jobs };

  function dispatch(params, opts = {}) {
    const action = textOf(params?.action).trim();
    if (action !== "") return Promise.resolve(act(params));
    // 默认 false：不传 async 就是原有的同步语义（R1）。变异这里翻成默认异步，同步语义测试必须红。
    if (params?.async === true) return Promise.resolve(start(params, opts));
    return sync(params, opts);
  }
}
