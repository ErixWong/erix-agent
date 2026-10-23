// issue #441：把引擎**自带**的可重试静默相位截止接到 CLI（本单只接线，`src/` 一行不改）。
//
// 现场：`src/providers/timeout.js` 到点抛 `KitError("timeout", …, { retryable: true })`，而 `timeout`
// 在 `RETRYABLE_CODES` 里 ⇒ 这条错误会走 `src/loop/provider-runner.js` 的重试分支。但 CLI 从来没把
// `firstByteTimeoutMs` / `streamIdleTimeoutMs` 传给 provider（此前 `grep -rn 'firstByteTimeoutMs' bin/`
// 零命中，`bin/config.js` 的白名单也不含它们）⇒ 默认配置下静默只有 CLI 自己的 idle 看门狗会收尾，
// 而 idle 走的是**不可重试**的 abort 路径 ⇒ 「静默 → 重试」这条通道结构性失效（#433 里 27% 的格子
// 就是这么死的）。
//
// ## 取值关系（显式定义；同一份口径写进 docs/host-consumer-contract{,_cn}.md 与 0.24.0 升级指南）
//
// 1. **idle 关闭**（`--idle-timeout 0`，`erix repl` 的默认值）⇒ **一律不派生**，装配结果与接线前
//    逐字一致（provider 仍是 `timeoutMs` 那条 legacy 绝对截止）。用户显式配的相位键照原样透传
//    （它们本来就在 `...config` 里），此时语义归引擎的相位模型。
// 2. **idle 开启** ⇒ 静默预算 `budget = ⌊idle × 3/4⌋ ms`（`silentPhaseTimeoutMs`），**只派生两个
//    流式相位**：
//      · `firstByteTimeoutMs` —— 流式：响应头到第一个正文字节之间的静默；
//      · `streamIdleTimeoutMs` —— 流式：两个正文字节之间的静默。
//    为什么是 3/4 而不是「等于 idle」：**必须严格小于 idle 窗口**，否则两条截止同时起跑、而 idle
//    的计时起点更早（请求期就开始走）⇒ idle 必然先响，又回到不可重试的那条路。留出的 1/4 是给
//    重试退避（默认 `backoffBaseMs = 1500`，第二次退避 3s）与下一次尝试的窗口。
//    **这条预算只保证「单次尝试的静默截止先响」，不保证「退避也落在 idle 窗口里」**：CLI 在
//    `attempt` / `recovering` 事件上喂 idle 表（见 bin/cli.js / bin/repl.js），但退避本身是**一次**
//    喂表之后的等待，`--idle-timeout` **小于或等于**退避序列（1.5s / 3s / 6s…，上限 10s）时 idle 仍会
//    在退避期收尾（不可重试，与接线前一致）。实测（`ERIX_RETRY_ATTEMPTS=2`、全程静默）：`--idle-timeout 3`
//    时第二次退避恰好 3000ms、**等于**窗口 ⇒ idle 先响，2 发 / 9.21s / `aborted`。默认 idle = 300s
//    ⇒ 永不发生；这是**如实记下**的边界，不是隐藏行为（契约与 0.24.0 升级指南同一处写着）。
// 3. **`requestTimeoutMs` 不在派生面内**（评审实测退回：此前那条 `⌊idle×3/4⌋` 的派生是错的）。
//    非流式的「请求时间」量的是**整段生成时间**，不是首字节时间——`provider.chat()` 只有一条绝对截止
//    （`requestTimeoutMs ?? legacy(timeout/timeoutMs) ?? 120000`，`src/providers/openai.js`）。把它派生
//    到 `⌊idle×3/4⌋`，等于把默认配置下 `[⌊idle×3/4⌋, idle)` = **`[225s, 300s)`** 这条**以前是活的**
//    带变成必死带。真 HTTP 上游、`ERIX_RETRY_ATTEMPTS=2` 实测（240s 后回一个字节，慢而**健康**）：
//      · 接线前（`2994998`）：**1 发 / 240.29s / 退码 4 / `end_turn`（成功）**；
//      · 接线后（`8ab818f`）：**1 发 / 225.21s / 退码 1 / `failed`+`timeout`（被杀）**，
//        默认 attempts 下 3 发 / 679.73s / `failed`。
//    而要让**非流式静默**可重试，截止必须 **< idle**，可 idle 与 legacy `timeout` 默认**都是 300**
//    ⇒ **任何**收缩都会杀掉这条以前成功的带。非流式静默的正解是「判死后重试」（#433 fix 1），不是
//    提前掐死。所以这里**保持 legacy**：`bin/cli.js` / `bin/repl.js` 照旧传
//    `timeoutMs: config.timeout ?? 300_000`，本模块不碰 `requestTimeoutMs`。
//    相位模型一开，引擎只关掉 `legacyTimeoutMs`（`hasExplicitPhase`，`src/providers/payload.js`），
//    `requestTimeoutMs` 仍回落到那个 `timeoutMs` ⇒ 非流式的截止仍是用户配的 legacy 值（默认 300s），
//    没有隐形收缩。
//    边界（如实记下）：流式 `firstByteTimeoutMs` 的同一段 `[225s, 300s)` 静默仍会被重试——那是**刻意的**，
//    它量的是**静默**（静默 225s 才吐首字节的上游本身就值得重试）；非流式那条带不能收，是因为它量的是
//    **整段生成**。非流式静默今天仍**不可重试**（idle 起点更早、与 legacy 截止同值时必然先响），
//    等 #433 fix 1。
// 4. `streamTotalTimeoutMs` **不从 idle 派生**：它是「整条流」的**绝对上限**，不是静默截止；而流式期
//    idle 会被 `onDelta` 喂表本来就不会响 ⇒ 拿 3/4 个窗口去当绝对上限，只会误杀「一直在吐字节的
//    长输出」（把它变成一次重试，大概率重蹈覆辙）。引擎默认 300s 与接线前那条 legacy 300s 同量级，
//    保持不动；用户要改就显式配 `streamTotalTimeoutMs`（`bin/config.js` 白名单已收）。
//    用户显式配了 legacy `timeout` 时，它**同时**作为 `streamTotalTimeoutMs` 透传——相位模型一开，
//    legacy 那条绝对截止就失效了（`resolveProviderTimeouts` 的 `hasExplicitPhase` 判据），
//    不透传等于把用户显式要的绝对天花板（例如 `timeout: 600000`）悄悄降到引擎默认 300s。
// 5. **显式配置优先、不被隐式改写**（与 `ERIX_EXEC_TIMEOUT_MS` 同一口径）：用户显式给了
//    `firstByteTimeoutMs` / `streamIdleTimeoutMs` / `streamTotalTimeoutMs` / `timeout` 就**原样使用**，
//    即使它 ≥ idle 窗口——只打一行警告（静默仍可能先被 idle 收尾），绝不改值。
//    显式 `requestTimeoutMs` 同样原样透传（它不在本模块的主张面内，见第 3 条）；本模块不为它打警告，
//    因为非流式的实际先后关系由 legacy 截止与 idle 起点决定，与相位键无关。
//
// 零依赖、纯 ESM。

/** 静默相位预算的分子：截止 = ⌊idle × 分子/分母⌋。 */
export const SILENT_PHASE_BUDGET_NUMERATOR = 3;
/** 静默相位预算的分母（1 − 3/4 = 1/4 个窗口留给退避与下一次尝试）。 */
export const SILENT_PHASE_BUDGET_DENOMINATOR = 4;

/** `bin/config.js` 白名单里的相位键（4 个；`requestTimeoutMs` 只透传、本模块**不派生**，见头注释第 3 条）。 */
export const PROVIDER_PHASE_TIMEOUT_FIELDS = [
  "requestTimeoutMs",
  "firstByteTimeoutMs",
  "streamIdleTimeoutMs",
  "streamTotalTimeoutMs",
];

/** 本模块**派生**的静默相位键。`requestTimeoutMs` 故意不在其中（评审实测退回，见头注释第 3 条）。 */
export const DERIVED_SILENT_PHASE_FIELDS = ["firstByteTimeoutMs", "streamIdleTimeoutMs"];

/**
 * 显式配置的判定：`>= 0` 的有限数（**含 0**）。0 在引擎的 `normalizeDuration` 里是合法值
 * （`value >= 0`，意思是「立刻到点」）——所以「显式配置优先」也必须认它，否则 `timeout: 0`
 * 这种写法会被悄悄换成派生值，那正是本单明令禁止的「隐式改写」。
 */
function explicitDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 相位截止键的取值校验（`bin/config.js` 用它校验配置文件里的那四个键）。
 *
 * 这 4 个键是**新键**、没有历史配置包袱，所以「写了但等于没写」不再被容忍：引擎的 `normalizeDuration`
 * （`src/providers/timeout.js`）只把「有限数且 >= 0」当合法值，其余一律返 `undefined` ⇒ `-1000` /
 * `"abc"` / `true` 在非流式路径上会变成立刻超时（上游 **0 发**），在流式路径上是「该相位的截止静默
 * 失效」，而 idle 开启时又会派一个值把它盖掉（**0 警告**）。所以非法值**直接报错并点名键**，不回落到
 * 默认值——本单修的就是「写了等于没写」这类坑。`0` 是合法值（引擎里等于「立刻到点」），照原样透传。
 *
 * @param {string} field 键名（只用于报错点名）
 * @param {unknown} value 配置值
 * @returns {number} 校验通过的毫秒数
 */
export function assertPhaseTimeoutValue(field, value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(
    `配置项 ${field} 的取值不合法：${JSON.stringify(value)}。`
    + "请写成 >= 0 的整数毫秒数（例如 300000；0 = 立刻到点）。",
  );
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
 * 主张面 = 两个流式静默相位（派生）+ `streamTotalTimeoutMs`（只在显式要过时透传）。
 * **`requestTimeoutMs` 不在其中**：非流式截止保持 legacy，理由与实测数见头注释第 3 条。
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

  const fields = {};
  // 两个「流式静默类」截止：显式值优先，否则取预算。
  for (const field of DERIVED_SILENT_PHASE_FIELDS) {
    const explicit = explicitDuration(config[field]);
    fields[field] = explicit === undefined ? budget : explicit;
    if (explicit !== undefined && explicit >= idleMs) {
      warn(
        `⚠️ ${field}=${explicit}ms ≥ --idle-timeout ${idleSeconds}s 窗口`
        + "：显式配置优先、**不改值**；同样的静默仍可能先被 idle 看门狗（不可重试）收尾，"
        + "而不是先走可重试的 provider 超时。",
      );
    }
  }
  // 绝对上限（不是静默截止）：只在用户显式要过的时候透传，绝不从 idle 派生。
  const explicitTotal = explicitDuration(config.streamTotalTimeoutMs);
  const legacy = explicitDuration(config.timeout);
  if (explicitTotal !== undefined) {
    fields.streamTotalTimeoutMs = explicitTotal;
  } else if (legacy !== undefined) {
    fields.streamTotalTimeoutMs = legacy;
  }
  return fields;
}
