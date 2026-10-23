// issue #441：把引擎**自带**的可重试静默相位截止接到 CLI（本单只接线，`src/` 一行不改）。
//
// 现场：`src/providers/timeout.js` 到点抛 `KitError("timeout", …, { retryable: true })`，而 `timeout`
// 在 `RETRYABLE_CODES` 里 ⇒ 这条错误会走 `src/loop/provider-runner.js` 的重试分支。但 CLI 从来没把
// `firstByteTimeoutMs` / `streamIdleTimeoutMs` / `requestTimeoutMs` 传给 provider（此前
// `grep -rn 'firstByteTimeoutMs' bin/` 零命中，`bin/config.js` 的白名单也不含它们）⇒ 默认配置下
// 静默只有 CLI 自己的 idle 看门狗会收尾，而 idle 走的是**不可重试**的 abort 路径
// ⇒ 「静默 → 重试」这条通道结构性失效（#433 里 27% 的格子就是这么死的）。
//
// ## 取值关系（显式定义；同一份口径写进 docs/host-consumer-contract{,_cn}.md 与 0.24.0 升级指南）
//
// 1. **idle 关闭**（`--idle-timeout 0`，`erix repl` 的默认值）⇒ **一律不派生**，装配结果与接线前
//    逐字一致（provider 仍是 `timeoutMs` 那条 legacy 绝对截止）。用户显式配的相位键照原样透传
//    （它们本来就在 `...config` 里），此时语义归引擎的相位模型。
// 2. **idle 开启** ⇒ 静默预算 `budget = ⌊idle × 3/4⌋ ms`（`silentPhaseTimeoutMs`），三个相位截止
//    都取它：
//      · `firstByteTimeoutMs` —— 流式：响应头到第一个正文字节之间的静默；
//      · `streamIdleTimeoutMs` —— 流式：两个正文字节之间的静默；
//      · `requestTimeoutMs` —— 请求头相位，**也是非流式路径上唯一的那条截止**（`provider.chat()`
//        只认它；`erix chat` 默认非流式 ⇒ 不接它这条票就只修了 `--stream` 的人）。
//    为什么是 3/4 而不是「等于 idle」：**必须严格小于 idle 窗口**，否则两条截止同时起跑、而 idle
//    的计时起点更早（请求期就开始走）⇒ idle 必然先响，又回到不可重试的那条路。留出的 1/4 是给
//    重试退避（默认 `backoffBaseMs = 1500`，第二次退避 3s）与下一次尝试的窗口。
//    **这条预算只保证「单次尝试的静默截止先响」，不保证「退避也落在 idle 窗口里」**：CLI 在
//    `attempt` / `recovering` 事件上喂 idle 表（见 bin/cli.js / bin/repl.js），但退避本身是**一次**
//    喂表之后的等待，`--idle-timeout` 小于退避序列（1.5s / 3s / 6s…，上限 10s）时 idle 仍会在退避
//    期收尾（不可重试，与接线前一致）。默认 idle = 300s ⇒ 永不发生；这是**如实记下**的边界，
//    不是隐藏行为（契约与 0.24.0 升级指南同一处写着）。
// 3. `streamTotalTimeoutMs` **不从 idle 派生**：它是「整条流」的**绝对上限**，不是静默截止；而流式期
//    idle 会被 `onDelta` 喂表本来就不会响 ⇒ 拿 3/4 个窗口去当绝对上限，只会误杀「一直在吐字节的
//    长输出」（把它变成一次重试，大概率重蹈覆辙）。引擎默认 300s 与接线前那条 legacy 300s 同量级，
//    保持不动；用户要改就显式配 `streamTotalTimeoutMs`（`bin/config.js` 白名单已收）。
//    用户显式配了 legacy `timeout` 时，它**同时**作为 `streamTotalTimeoutMs` 透传——相位模型一开，
//    legacy 那条绝对截止就失效了（`resolveProviderTimeouts` 的 `hasExplicitPhase` 判据），
//    不透传等于把用户显式要的绝对天花板（例如 `timeout: 600000`）悄悄降到引擎默认 300s。
// 4. **显式配置优先、不被隐式改写**（与 `ERIX_EXEC_TIMEOUT_MS` 同一口径）：用户显式给了
//    `firstByteTimeoutMs` / `streamIdleTimeoutMs` / `requestTimeoutMs` / `timeout` 就**原样使用**，
//    即使它 ≥ idle 窗口——只打一行警告（静默仍可能先被 idle 收尾），绝不改值。
//
// 零依赖、纯 ESM。

/** 静默相位预算的分子：截止 = ⌊idle × 分子/分母⌋。 */
export const SILENT_PHASE_BUDGET_NUMERATOR = 3;
/** 静默相位预算的分母（1 − 3/4 = 1/4 个窗口留给退避与下一次尝试）。 */
export const SILENT_PHASE_BUDGET_DENOMINATOR = 4;

/** 会被本模块写进 provider 装配的相位键（`bin/config.js` 的白名单是同一批名字）。 */
export const PROVIDER_PHASE_TIMEOUT_FIELDS = [
  "requestTimeoutMs",
  "firstByteTimeoutMs",
  "streamIdleTimeoutMs",
  "streamTotalTimeoutMs",
];

/**
 * 显式配置的判定：`>= 0` 的有限数（**含 0**）。0 在引擎的 `normalizeDuration` 里是合法值
 * （`value >= 0`，意思是「立刻到点」）——所以「显式配置优先」也必须认它，否则 `timeout: 0`
 * 这种写法会被悄悄换成派生值，那正是本单明令禁止的「隐式改写」。
 */
function explicitDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 静默预算：`⌊idle × 3/4⌋` 毫秒；idle 未启用（非正整数，含 0）⇒ `undefined`（不派生）。
 *
 * 严格小于 idle 窗口是这条预算的**定义**而不是巧合：两条截止同时起跑时 idle 的起点更早，
 * 相等就等于 idle 先响（不可重试）。
 *
 * @param {number} idleSeconds `--idle-timeout` 的秒数
 * @returns {number | undefined} 毫秒
 */
export function silentPhaseTimeoutMs(idleSeconds) {
  if (!Number.isInteger(idleSeconds) || idleSeconds <= 0) return undefined;
  const idleMs = idleSeconds * 1000;
  return Math.max(
    1,
    Math.floor((idleMs * SILENT_PHASE_BUDGET_NUMERATOR) / SILENT_PHASE_BUDGET_DENOMINATOR),
  );
}

/**
 * 算出要交给 `createOpenAIProvider` 的相位截止。
 *
 * 返回值只含**本模块主张**的键（调用方 `{...config, ...fields}` 装配，显式配置与派生值不会打架：
 * 同键时两者取值相同）。idle 关闭 ⇒ 空对象（接线前的装配逐字保留）。
 *
 * @param {{
 *   idleSeconds:number,
 *   config?:Record<string, any>,
 *   warn?:(line:string) => void,
 * }} options
 * @returns {Record<string, number>} 相位截止（毫秒）
 */
export function resolveProviderPhaseTimeouts({
  idleSeconds,
  config = {},
  warn = (line) => console.error(line),
} = {}) {
  const budget = silentPhaseTimeoutMs(idleSeconds);
  if (budget === undefined) return {};
  const idleMs = idleSeconds * 1000;

  // 显式来源各自记一个标签：警告要说清「哪来的值」。
  const explicit = {
    requestTimeoutMs: explicitDuration(config.requestTimeoutMs) !== undefined
      ? { value: config.requestTimeoutMs, label: "requestTimeoutMs" }
      : explicitDuration(config.timeout) !== undefined
        ? { value: config.timeout, label: "timeout" }
        : undefined,
    firstByteTimeoutMs: explicitDuration(config.firstByteTimeoutMs) !== undefined
      ? { value: config.firstByteTimeoutMs, label: "firstByteTimeoutMs" }
      : undefined,
    streamIdleTimeoutMs: explicitDuration(config.streamIdleTimeoutMs) !== undefined
      ? { value: config.streamIdleTimeoutMs, label: "streamIdleTimeoutMs" }
      : undefined,
    streamTotalTimeoutMs: explicitDuration(config.streamTotalTimeoutMs) !== undefined
      ? { value: config.streamTotalTimeoutMs, label: "streamTotalTimeoutMs" }
      : explicitDuration(config.timeout) !== undefined
        ? { value: config.timeout, label: "timeout" }
        : undefined,
  };

  const fields = {};
  // 三个「静默类」截止：显式值优先，否则取预算。
  for (const field of ["requestTimeoutMs", "firstByteTimeoutMs", "streamIdleTimeoutMs"]) {
    const picked = explicit[field];
    fields[field] = picked === undefined ? budget : picked.value;
    if (picked !== undefined && picked.value >= idleMs) {
      warn(
        `⚠️ ${picked.label}=${picked.value}ms ≥ --idle-timeout ${idleSeconds}s 窗口`
        + "：显式配置优先、**不改值**；同样的静默仍可能先被 idle 看门狗（不可重试）收尾，"
        + "而不是先走可重试的 provider 超时。",
      );
    }
  }
  // 绝对上限（不是静默截止）：只在用户显式要过的时候透传，绝不从 idle 派生。
  if (explicit.streamTotalTimeoutMs !== undefined) {
    fields.streamTotalTimeoutMs = explicit.streamTotalTimeoutMs.value;
  }
  return fields;
}
