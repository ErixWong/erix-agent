// issue #433 T0：CLI 的 idle 看门狗（无进展中止）**只有这一份实现**。
//
// 为什么独立成文件：`bin/cli.js` 与 `bin/repl.js` 此前各有一份**逐字同构**的 `createIdleTimeout`。
// 本刀要改的行为（工具执行期喂表、`onDelta` 无条件喂表）必须两边同时生效；留两份实现就等于
// 「改一处、另一处照旧」——那正是 #433 记录的现场之一（双实现本身就是缺陷）。
//
// 本刀**不改**的既有语义（改动属别的票，别顺手加）：
//  - `timedOut()` 是**单向**的：置真之后 `touch()` 直接 return，判死不会复活（重试属 #441）。
//  - `controller.abort()` **不带 reason**。
//  - `seconds` 不是正整数（含 0）⇒ 返回 `null`，调用方靠 `idle?.` 全套短路。
//
// issue #440：**判死之后抛哪个错误**也归这里（`IdleTimeoutError` / `idleTimeoutFailure`）。
// 此前两个入口各自 `new IdleTimeoutError(…)` 顶掉引擎抛出的错误，把 #176/#180 的终局载荷
// （`termination` / `usage` / `rounds` / `finalText`）整片丢掉；现在只有这一份构造入口，
// 「改一处、另一处照旧」不再可能。
//
// 零依赖、纯 ESM（只用 node: 内置的定时器/AbortController）。

/** `chat` 的 idle 默认窗口（秒）。`repl` 默认 0 = 不启用，见 DEFAULT_REPL_IDLE_TIMEOUT_SECONDS。 */
export const DEFAULT_CHAT_IDLE_TIMEOUT_SECONDS = 300;
/** `repl` 的 idle 默认窗口（秒）：交互式会话里人可能长时间思考，默认不启用。 */
export const DEFAULT_REPL_IDLE_TIMEOUT_SECONDS = 0;

/** exec 天花板与 idle 之间必须留的余量：天花板必须**先**响，否则那条命令超时事实上不可达。 */
export const EXEC_CEILING_MARGIN_MS = 60_000;
/** exec 天花板的下限（idle 很小时 `idle − 60s` 会退化成 0 甚至负数，不能拿它当超时）。 */
export const EXEC_CEILING_FLOOR_MS = 30_000;

/** 工具执行期喂表的间隔区间（idle/4 夹在这里）。 */
export const TOOL_HEARTBEAT_MIN_INTERVAL_MS = 250;
export const TOOL_HEARTBEAT_MAX_INTERVAL_MS = 30_000;

/**
 * 造一个 idle 看门狗。
 *
 * @param {number} seconds 静默窗口（秒）。非正整数 ⇒ `null`（不启用）。
 * @returns {{controller: AbortController, seconds: number, timedOut: () => boolean,
 *   touch: () => void, dispose: () => void} | null}
 */
export function createIdleTimeout(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const touch = () => {
    if (timedOut) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, seconds * 1000);
  };
  touch();
  return {
    controller,
    seconds,
    timedOut: () => timedOut,
    touch,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * idle 中止的判别面（`error.code`）。
 *
 * **这个值是契约，不是实现细节**：`bin/cli.js` 的顶层 catch（决定打印哪条文案）、`bin/repl.js`
 * 的行处理（决定 `printError` 还是 `writeLine`）、以及外部的 bench 统计都按它分流。
 * 改名/换值等于同时改三处判别面，属别的票。
 */
export const IDLE_TIMEOUT_CODE = "idle_timeout";

/**
 * idle 看门狗命中时抛的错误。`name` / `code` / `message` 都是既有面，别顺手改。
 */
export class IdleTimeoutError extends Error {
  /**
   * @param {number} seconds 静默窗口（秒），只进面向人的消息。
   * @param {unknown} [cause] 引擎抛出的原始错误：保留成因链（`error.cause`），不影响判别面。
   */
  constructor(seconds, cause) {
    super(`任务 ${seconds} 秒无进展，已中止`, cause === undefined ? undefined : { cause });
    this.name = "IdleTimeoutError";
    this.code = IDLE_TIMEOUT_CODE;
  }
}

/**
 * 引擎在终局 `fail()` 路径上挂到**抛出的错误**上的载荷键（issue #176 / #180）。
 *
 * 注意 `partial` **不在**这一层：契约里没有顶层 `error.partial`，标记位是 `termination.partial`
 * （恒 `true`）。别在这里凭空造一个顶层 `partial` 去「对齐」想象中的形状。
 */
export const TERMINATION_PAYLOAD_KEYS = Object.freeze([
  "termination",
  "usage",
  "rounds",
  "finalText",
]);

/**
 * idle 看门狗命中时**唯一**的错误构造入口（issue #440）。
 *
 * 现场：两个入口原先都是 `throw new IdleTimeoutError(seconds)`，把引擎刚抛出的那个**已注解**的
 * 错误整个顶掉 ⇒ `error.termination` / `error.usage` / `error.rounds` / `error.finalText` 全变
 * `undefined`，宿主与 bench 只拿得到「超时了」，拿不到「这个 run 死之前烧了多少 token、跑到第几轮、
 * 有没有半成品」。
 *
 * 修法：判别面（`name` / `code` / `message`）逐字不变，只把**原始错误上已经有的**载荷键原样搬过来
 * （同一个对象，所以 `termination.usage === usage` 这条契约自然成立），并保留 `cause`。
 *
 * **不伪造**：原始错误没有该键时（例如 run 还没进 `fail()`、抛的是别的东西），这个键**不出现**——
 * 不写 `undefined`、更不写零值。
 *
 * @param {number} seconds 静默窗口（秒）
 * @param {unknown} [cause] 引擎抛出的原始错误
 * @returns {IdleTimeoutError}
 */
export function idleTimeoutFailure(seconds, cause) {
  const thrown = new IdleTimeoutError(seconds, cause);
  if (cause === null || typeof cause !== "object") return thrown;
  for (const key of TERMINATION_PAYLOAD_KEYS) {
    if (cause[key] !== undefined) thrown[key] = cause[key];
  }
  return thrown;
}

/**
 * 工具执行期的喂表间隔：`idle/4`，夹在 [`TOOL_HEARTBEAT_MIN_INTERVAL_MS`, `TOOL_HEARTBEAT_MAX_INTERVAL_MS`]。
 *
 * 为什么是 idle/4：喂表间隔必须**明显小于**窗口，否则一次抖动就能把窗口吃完（idle=1s 时 250ms 一跳，
 * 一次 tick 迟到 750ms 也还有余量）；上界 30s 是为了让 `--idle-timeout 600` 这种长窗口不会只喂
 * 4 次就撞上限，下界 250ms 是为了不让短窗口把定时器变成忙等。
 *
 * @param {number} seconds
 * @returns {number} 毫秒
 */
export function toolHeartbeatIntervalMs(seconds) {
  const quarter = Math.floor((seconds * 1000) / 4);
  return Math.min(
    TOOL_HEARTBEAT_MAX_INTERVAL_MS,
    Math.max(TOOL_HEARTBEAT_MIN_INTERVAL_MS, quarter),
  );
}

/**
 * install 档 exec 上限（天花板）按 idle 收口：`idle − EXEC_CEILING_MARGIN_MS`，下限 `EXEC_CEILING_FLOOR_MS`。
 *
 * 为什么天花板必须 < idle：idle 的计时起点更早（模型请求期就开始走），同值时 idle 必然先响 ⇒
 * install 档的「命令超时」结果事实上不可达，一条挂住的安装命令的结局是「整个 run 被打死」。
 * 留 60s 余量让「命令超时」有足够的时间被返回、入账、让模型看见。
 *
 * idle 未启用（`<= 0`）⇒ `null`（不钳：没有窗口就没有要先响的对象）。
 *
 * @param {number} seconds
 * @returns {number | null} 毫秒
 */
export function execCeilingMsForIdle(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  return Math.max(EXEC_CEILING_FLOOR_MS, seconds * 1000 - EXEC_CEILING_MARGIN_MS);
}

/**
 * 工具执行期喂表的**上限**（毫秒）：= install 档 exec 天花板（`execCeilingMsForIdle`）。
 * 到点停止喂表，静默窗口重新开始计时 ⇒ 一个永不返回的工具仍然会被看门狗收掉。
 *
 * @param {number} seconds
 * @returns {number} 毫秒
 */
export function toolHeartbeatCapMs(seconds) {
  return execCeilingMsForIdle(seconds) ?? 0;
}

/**
 * 工具执行期喂表（issue #433 T0 的核心）。
 *
 * 现场：`bin/cli.js` / `bin/repl.js` 里包装 `executeTool` 的那段是
 * `const result = await executeTool(execution); idle?.touch();` —— `touch()` 排在 `await` **之后**。
 * 于是一条长命令（install 档 300s）执行期间静默表一直在走，到点把**整个 run** 打死。
 *
 * 选的是哪一条（工单给了二选一）：
 *   ① **工具执行期周期性喂 `touch()`**（本实现）；
 *   ② 「把工具耗时从静默窗口里扣掉」（工具返回后把计时器按耗时回拨）。
 * 选 ① 的理由：② 需要把「静默窗口」拆成「累计静默时长 + 剩余预算」并改 `timedOut()` 的判据，
 * 那会碰到本刀明令不动的语义（单向判死、abort 不带 reason）；① 只是多打几次 `touch()`，
 * 判死/abort/dispose 三件事一个字节都不动，而且对**流式与非流式**都成立（工具执行期本来就没有
 * 任何字节级信号可喂）。
 *
 * 「别把窗口彻底关掉」怎么保证：喂表**不是无界的**——上限是 `execCeilingMsForIdle(seconds)`
 * （install 档 exec 天花板，装配处已把它钳到 `idle − 60s`）。到上限就停止喂表，静默窗口重新开始
 * 计时 ⇒ 工具执行期仍受「天花板 + 一个完整 idle 窗口」约束，一个永不返回的工具不会让看门狗失效。
 *
 * **可观测证据（issue #433 fix 3 的验收原文：日志里要能看到「工具执行期间喂过计时器」的行）**：
 * 每次工具执行收尾时打一行 `[idle-heartbeat] …：执行期喂过 idle 计时器 N 次`（`N > 0` 才打，
 * 短命令不会刷屏）；真的喂到上限时另打一行说明「停止喂表、窗口重新计时」。日志走调用方注入的
 * `log`（`bin/cli.js` / `bin/repl.js` 都接到 stderr），缺省 no-op——不替调用方决定往哪写。
 *
 * @template T
 * @param {ReturnType<typeof createIdleTimeout>} idle
 * @param {() => Promise<T> | T} run
 * @param {{ label?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<T>}
 */
export function withToolHeartbeat(idle, run, { label, log } = {}) {
  if (idle === null || idle === undefined) return Promise.resolve().then(run);
  const emit = typeof log === "function" ? log : () => {};
  const name = typeof label === "string" && label !== "" ? label : "tool";
  const intervalMs = toolHeartbeatIntervalMs(idle.seconds);
  const capMs = toolHeartbeatCapMs(idle.seconds);
  const startedAt = Date.now();
  let ticks = 0;
  let capped = false;
  const timer = setInterval(() => {
    if (Date.now() - startedAt >= capMs) {
      // 到上限就停喂：工具执行期不是无界静默窗口（见上面的注释），剩下的交给 idle 自己判死。
      if (!capped) {
        capped = true;
        emit(
          `[idle-heartbeat] ${name}：执行期喂表已到上限 ${capMs}ms，停止喂表`
          + "（静默窗口重新开始计时，挂住的工具仍会被看门狗收掉）",
        );
      }
      clearInterval(timer);
      return;
    }
    idle.touch();
    ticks += 1;
  }, intervalMs);
  // 只喂表，不该把进程钉住：run 结束（或抛错）时立刻清掉，不靠 unref 兜底。
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (ticks > 0) {
      emit(
        `[idle-heartbeat] ${name}：执行期喂过 idle 计时器 ${ticks} 次`
        + `（间隔 ${intervalMs}ms，用时 ${Date.now() - startedAt}ms）`,
      );
    }
  };
  return Promise.resolve()
    .then(run)
    .then(
      (value) => {
        stop();
        return value;
      },
      (error) => {
        stop();
        throw error;
      },
    );
}

// ── issue #433 fix 1：判死之后**从账本续跑**（不是整单重跑）──────────────────────────────
//
// 现场（issue 实测）：27% 的格子被 `idle_timeout` 中止、reward 全 0，其中 46/55 该轮一个字节都
// 没回来；而这种静默**通常自愈**（未删失窗里 >300s 静默每 1000 轮 7 次、中位 400s，经历过的 35
// 个 run 有 18 个最终拿到分），中转探针显示**新请求 3.4–15s 就起流** ⇒ **干等不如重发**。
//
// 为什么是「从快照/账本续跑」而不是「整单重跑」：#440 之后判死错误上已经带着 `rounds` /
// `usage` / `finalText`，引擎侧本来就有 `resume` 面（`restoreResume`，读 transcript 账本 + run
// snapshot）。整单重跑等于把已经付过费的 6~19 轮再烧一遍。
//
// ⚠ 与 #441 的交互（如实写在契约里，别说成「所有静默都被救」）：**流式**静默现在先撞 provider
// 的相位截止（`⌊idle×3/4⌋`，`KitError("timeout", …, {retryable:true})`，走引擎自己的重试通道），
// 所以 fix 1 主要救的是**非流式**（`requestTimeoutMs` 故意不派生）与「provider 没有相位截止」
// （宿主注入的 provider）两条路径。

/** 重试**总预算**的默认值（秒）：从第一次判死开始计时，用尽才落 `idle_timeout` 终局。 */
export const DEFAULT_IDLE_RETRY_BUDGET_SECONDS = 900;

/** 退避起点（毫秒）：中转探针实测新请求 3.4–15s 就起流，所以第一档不必等太久。 */
export const IDLE_RETRY_BASE_DELAY_MS = 1_000;
/** 单次退避上限（毫秒）：指数退避夹在这里，避免长预算下退避把窗口本身吃掉。 */
export const IDLE_RETRY_MAX_DELAY_MS = 30_000;

/**
 * 重试**次数**硬上限（不含首发）。为什么是 8：
 *  - 预算（默认 900s）在有意义的 idle 窗口下本来就先撞线（`idle=300s` ⇒ 最多 2~3 次）；
 *  - 但 `--idle-timeout 1` 这种极小窗口能把 900s 预算摊成几百次重试 ⇒ 次数上限是**成本闸**：
 *    指数退避前 8 档之和 ≈ `1+2+4+8+16+32+64+128 = 255s`，第 9 次起预算/次数必有一个先响；
 *  - 8 次 ≈ 一个 run 最多 9 发请求，配合预算仍是有界的（「不许无限重试」的双闸）。
 */
export const IDLE_RETRY_MAX_ATTEMPTS = 8;

/**
 * 第 `retryIndex` 次重试（1 起算）的退避时长：`base × 2^(n-1)`，夹在 `IDLE_RETRY_MAX_DELAY_MS`。
 *
 * @param {number} retryIndex
 * @returns {number} 毫秒
 */
export function idleRetryBackoffMs(retryIndex) {
  const index = Number.isInteger(retryIndex) && retryIndex > 0 ? retryIndex : 1;
  const raw = IDLE_RETRY_BASE_DELAY_MS * 2 ** (index - 1);
  return Math.min(IDLE_RETRY_MAX_DELAY_MS, raw);
}

/**
 * 重试决策（纯函数）：预算与次数**双闸**。
 *
 * 语义：`budgetMs` 从**第一次判死**起算（含退避与后续尝试的耗时）；`elapsedMs >= budgetMs` ⇒
 * `reason: "budget"`；`retries >= maxAttempts` ⇒ `reason: "max_attempts"`。都满足时返回的
 * `backoffMs` 会被剩余预算夹住（退避可以短，但**不会为负**）。
 *
 * @param {{ retries: number, elapsedMs: number, budgetMs: number, maxAttempts?: number }} input
 * @returns {{ retry: boolean, reason?: "budget" | "max_attempts", backoffMs?: number, retryIndex?: number }}
 */
export function planIdleRetry({
  retries,
  elapsedMs,
  budgetMs,
  maxAttempts = IDLE_RETRY_MAX_ATTEMPTS,
}) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return { retry: false, reason: "budget" };
  if (!Number.isInteger(retries) || retries < 0) return { retry: false, reason: "max_attempts" };
  if (retries >= maxAttempts) return { retry: false, reason: "max_attempts" };
  const remainingMs = budgetMs - (Number.isFinite(elapsedMs) ? elapsedMs : 0);
  if (remainingMs <= 0) return { retry: false, reason: "budget" };
  const retryIndex = retries + 1;
  return {
    retry: true,
    backoffMs: Math.min(idleRetryBackoffMs(retryIndex), remainingMs),
    retryIndex,
  };
}

/** 累加 usage（只累数值字段；`undefined` 视为 0，不伪造键）。 */
function addUsage(target, usage) {
  if (usage === null || typeof usage !== "object") return;
  for (const [key, value] of Object.entries(usage)) {
    if (!Number.isFinite(value)) continue;
    target[key] = (target[key] ?? 0) + value;
  }
}

/**
 * 重试记账（issue #433 验收原文：「重试次数/退避进 run state 与事件」）。
 *
 * 只记账、不做决定（决定在 `planIdleRetry`）：
 *  - `markKilled(usage)`：一次判死，把这次尝试的 usage 累进总账；
 *  - `next()`：问「还能不能再试一次」，把结论里的 `elapsedMs` / `retries` / `budgetMs` 一并带出；
 *  - `recordBackoff(ms)`：真的退避了，记一笔（次数 +1）；
 *  - `recordUsage(usage)`：成功那一发的 usage 也累进总账；
 *  - `snapshot()`：交给终局载荷 / judge.log 的**同一份**形状。
 *
 * @param {{ budgetMs?: number, maxAttempts?: number, now?: () => number }} [options]
 */
export function createIdleRetryState({
  budgetMs = DEFAULT_IDLE_RETRY_BUDGET_SECONDS * 1000,
  maxAttempts = IDLE_RETRY_MAX_ATTEMPTS,
  now = () => Date.now(),
} = {}) {
  const backoffMs = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let retries = 0;
  let startedAt;
  let exhausted;
  const elapsed = () => (startedAt === undefined ? 0 : Math.max(0, now() - startedAt));
  return {
    markKilled(attemptUsage) {
      if (startedAt === undefined) startedAt = now();
      addUsage(usage, attemptUsage);
    },
    next() {
      const decision = planIdleRetry({
        retries,
        elapsedMs: elapsed(),
        budgetMs,
        maxAttempts,
      });
      if (!decision.retry) exhausted = decision.reason;
      return { ...decision, retries, elapsedMs: elapsed(), budgetMs, maxAttempts };
    },
    recordBackoff(ms) {
      retries += 1;
      backoffMs.push(ms);
    },
    recordUsage(attemptUsage) {
      addUsage(usage, attemptUsage);
    },
    snapshot() {
      return {
        retries,
        backoffMs: [...backoffMs],
        budgetMs,
        maxAttempts,
        elapsedMs: elapsed(),
        usage: { ...usage },
        ...(exhausted === undefined ? {} : { exhausted }),
      };
    },
  };
}
