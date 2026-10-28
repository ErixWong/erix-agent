// issue #521（#495 的 A2 前置刀）：**「给一轮 run 一条初始用户消息」的唯一实现**。
//
// 病根（实测）：`initialUserMessage` 这个**顶层扁平拼写**在 `test/` 里有 475 处写点、摊在 88 个文件里。
// 它的规位家已经是 `config.input.initialUserMessage`（`CONFIG_NAMESPACE_SCHEMA.input`，
// 展开相写回 `effectiveOptions.initialUserMessage`，引擎读侧不变），所以从
// `RUN_TOOL_LOOP_OPTION_NAMES` 删掉这个键只需要**一处**翻译；但只要写点还摊在 88 个文件里，
// 删键就是一次 475 行的改拼写 + 55 个文件「已经有 `config: {`，朴素替换会造重复键、后者静默胜」的雷区。
//
// 本模块把那个动作收成**一处**：
//   · 调用方（88 个测试文件）照旧写 `runDirect({ … initialUserMessage: "…" … })`；
//   · 夹具在**调 `runToolLoop` 之前**把它并进 `config.input.initialUserMessage`，
//     并**删掉**扁平键（引擎永远看不到旧拼写）；
//   · 删键之后这里一行都不用改，测试也不必跟着改——这就是本刀的全部目的。
//
// **删键已经发生（#498 S3 A2b）**：`initialUserMessage` 不再是 `RUN_TOOL_LOOP_OPTION_NAMES` 的成员，
// 引擎的名称闸口现在会拒收扁平拼写（文案点名新家 `config.input.initialUserMessage`）。
// 于是本模块的 `initialUserMessage` 入参是一条**纯夹具级 API**：它是 88 个测试文件既有的调用方
// 拼写，**不是**引擎拼写，也不在任何契约面 / 文档里出现。谁想写新格子，用 `seed:`。
// `test/loop-seed-fixture-521.test.js` 的 F1 / E1 把这条钉住：夹具的产物里**没有**扁平键，
// 漏摘就会被引擎当场拒。
//
// 三条硬约束（改动前先读，改错会静默降强度）：
//   1. **不许造第二个 `config` 键**：`extra` 里已经有 `config: { … }` 时必须**并进同一个容器**
//      （`{ ...config, input: { ...config.input, initialUserMessage } }`）。同一对象字面量里两个
//      `config` 键是后者静默胜——`test/loop-seed-fixture-521.test.js` 的 G 段逐文件扫源码钉住这件事，
//      不是靠自觉。
//   2. **语义必须逐字等于今天**：`config` 赢过同名扁平键（`expandConfigNamespace` 的优先级），
//      所以并进 `config` 之后引擎读到的 `effectiveOptions.initialUserMessage` 与改前同值。
//      改的是**写侧拼写**，不是行为；这也是为什么本夹具不做任何别的规范化。
//   3. **形状拒绝格不许被夹具吃掉**：调用方把 `config` 写成非对象（`null` / `[]` / `"nested"`）时
//      那格测的是「config 必须是对象」这条拒绝，夹具**不覆盖**它（照原样透传、不并种子），
//      否则名称闸口会先抛、文案换成另一条，断言跟着失真。
//   4. **`run` 组四件（#498 S3 A12）同样收在这里**（`withRunFamily`）：`stallDetection` /
//      `outputHygiene` / `persistence` / `partialPersistence` 的顶层扁平拼写已经退役，而它们在
//      `test/` 里有 121 处写点、摊在 41 个文件里（多数文件**已经有** `config: {`）——朴素替换会造
//      重复键、后者静默胜，正是约束 1 那个雷区。夹具把它们并进同一个容器并摘键，与种子同一条
//      纪律：这是**夹具入参**，不是引擎拼写。
//   5. **`input` 组的 `wrapup`（#528）走同一条路**（`withInputFamily`）：家是 `config.input.wrapup`，
//      与种子同一个容器，所以翻译点也在本文件（不另造第二套夹具）。**规位赢扁平**——两者同时
//      在场时保留 `config.input.wrapup`、只摘扁平键，与引擎的展开优先级同向。
//
// 零真实 LLM、不写盘、不碰 `~/.erix`：夹具只做对象合并，run 的隔离仍由调用方负责。

import { runToolLoop } from "../../src/loop/orchestrator.js";

/**
 * 把「种子首轮消息」并进唯一的 `config` 容器，返回**可以直接喂给 `runToolLoop`** 的选项对象。
 *
 * 接受两种**夹具级**拼写（都只在本模块的边界存在，绝不透传给引擎）：
 *   · `initialUserMessage: "…"` —— **旧扁平拼写**，88 个既有测试文件用的就是它。⚠ 它**不是引擎拼写**：
 *     #498 S3 A2b 之后引擎会拒收它（`unknown runToolLoop option: "initialUserMessage" (its canonical
 *     home is config.input.initialUserMessage; the flat spelling is rejected)`）。这里保留它只为让
 *     那 88 个调用方不必跟着改拼写——翻译完就把这个键摘掉；
 *   · `seed: "…"` —— 夹具自己的规范拼写，新写的格子用它（`seed` 赢过 `initialUserMessage`）。
 * 两条都是夹具的入参约定，宿主面 / 契约面**都没有**它们；引擎只认 `config.input.initialUserMessage`。
 *
 * 返回值里**一定没有** `initialUserMessage` 这个顶层键（F1 钉住）：夹具是「翻译 + 摘键」，不是
 * 「多传一个别名」。漏摘的后果不是形状不洁，而是引擎当场拒（E1 反向格）。
 *
 * `undefined` 逐字等于「没给种子」（与 `runToolLoop` 的 `value !== undefined` 合并口径同源），
 * 于是 `runDirect({ initialUserMessage: undefined })` 不产生 `config.input.initialUserMessage`。
 *
 * @param {Record<string, unknown>} [options]
 * @returns {Record<string, unknown>}
 */
/**
 * `run` 组四件（#498 S3 A12）的**夹具级**拼写 → 规位 `config.run.*`。
 *
 * 与种子同理（见文件头约束 4）：它们的顶层扁平拼写已经退役，引擎会拒；但这四件在 `test/` 里
 * 有 121 处写点、摊在 41 个文件里，且其中大部分文件**已经有** `config: {` 容器——朴素替换会造
 * 重复键（后者静默胜）。所以把「搬进唯一的 `config` 容器」这个动作收在本模块**一处**。
 * 这里收下的四个名字是**夹具入参约定**，不是引擎拼写：翻译完就摘键，`runToolLoop` 永远看不到
 * 扁平形态。新写的格子请直接用 `config: { run: { … } }`。
 *
 * @type {readonly string[]}
 */
const RUN_FAMILY_FIXTURE_KEYS = Object.freeze([
  "stallDetection",
  "outputHygiene",
  "persistence",
  "partialPersistence",
  // #498 S3 A14: `maxTokenContinuations` joins the same group (home `config.run.maxTokenContinuations`).
  // It is a **scalar** rather than a data shell, but the fixture only moves spellings, so the same
  // translation applies verbatim. `undefined` is treated as "not given" (same rule as the seed below).
  "maxTokenContinuations",
  // #498 S3 A15: `cwd` (home `config.run.cwd`). Same reasoning; the value is a plain string, and the
  // engine's own type check still runs after expansion (a non-string is still `cwd must be a string`).
  "cwd",
  // #498 S3 A16: `stream` (home `config.run.stream`). Same reasoning again — the fixture only moves
  // spellings. The engine's read side (the one truthiness test in `src/loop/orchestrator.js`) is
  // unchanged, so `true` / `false` / object values behave exactly as before.
  "stream",
  // #498 S3 A19: `resume` (home `config.run.resume`). Same reasoning — the fixture only moves the
  // spelling. The engine's read side only ever *tests* `resume` for truthiness
  // (`if (!ctx.resume || …)` in `src/loop/resume-manager.js`), so `true` / `false` behave exactly as
  // before; a function value was never behaviour at this position (see the slice test's gate-2 row).
  "resume",
  // #498 S3 A20: `runId` (home `config.run.runId`, already in `CONFIG_NAMESPACE_SCHEMA.run` since
  // #497). Same reasoning once more — a plain string scalar, so the fixture only moves the spelling;
  // the expansion phase writes it back onto `effectiveOptions.runId`, and the engine's read side
  // (the `runId` destructure in `src/loop/orchestrator.js`) never changed. Note the words that are
  // *not* this option: the `runId` **field** on transcript / round rows and on every `judge.log`
  // decision record (#165), the CLI display and the `examples/pi-extension` run handle, and the
  // `~/.erix/transcripts/outputs/<runId>/` directory name are all downstream of the value, not
  // spellings of it.
  "runId",
  // #498 S3 A21: `maxRounds` (home `config.run.maxRounds`, in `CONFIG_NAMESPACE_SCHEMA.run` since
  // #497). Same reasoning again — an integer scalar, so the fixture only moves the spelling; the
  // expansion phase writes it back onto `effectiveOptions.maxRounds`, and every engine reader (the
  // `maxRounds` destructure in `src/loop/orchestrator.js`, the governor's round budget, the
  // `forceFinalIfNeeded` cap) never changed.
  "maxRounds",
]);

/**
 * `input` 组里靠本夹具翻译的扁平拼写（#528）。
 *
 * `wrapup` 的家是 `config.input.wrapup`（`CONFIG_NAMESPACE_SCHEMA.input`），展开相写回
 * `effectiveOptions.wrapup`，引擎读侧（`src/loop/orchestrator.js` 里 `wrapup !== false` 那处真值
 * 判断）一字不动。这些名字是**夹具入参约定**，不是引擎拼写；翻译完就摘键。
 *
 * @type {readonly string[]}
 */
const INPUT_FAMILY_FIXTURE_KEYS = Object.freeze([
  "wrapup",
]);

/**
 * 把 `run` 组四件的扁平夹具拼写搬进 `config.run.*`（约束 1：不许造第二个 `config` 键）。
 * 非对象 `config` / `config.run` 是「形状拒绝」格，原样透传（约束 3）。
 *
 * @param {Record<string, any>} options
 * @returns {Record<string, any>}
 */
function withRunFamily(options) {
  const rest = { ...options };
  const moved = {};
  for (const key of RUN_FAMILY_FIXTURE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rest, key)) continue;
    if (rest[key] !== undefined) moved[key] = rest[key];
    delete rest[key];
  }
  if (Object.keys(moved).length === 0) return rest;
  const config = rest.config;
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    return options;
  }
  const base = config === undefined ? {} : config;
  const run = base.run;
  if (run !== undefined && (run === null || typeof run !== "object" || Array.isArray(run))) {
    return options;
  }
  return { ...rest, config: { ...base, run: { ...(run ?? {}), ...moved } } };
}

/**
 * `input` 组的夹具级拼写 → 规位 `config.input.*`（#528）。
 *
 * 目前只有一件：`wrapup`（家 `config.input.wrapup`）。它和种子同组、同一条纪律——
 * 调用方照旧写扁平 `wrapup: false`，夹具在**调 `runToolLoop` 之前**把它并进唯一的
 * `config.input` 容器并摘掉扁平键；`runToolLoop` 永远看不到旧拼写。
 *
 * 与种子的两处差别（都是照引擎的实际语义，不是夹具自己发明的）：
 *   · **规位赢扁平**：`config.input.wrapup` 与扁平 `wrapup` 同时在场时保留规位那份
 *     （展开相写回 `effectiveOptions.wrapup`，所以引擎读到的就是规位那份），只摘扁平键；
 *   · 形状拒绝格（非对象 `config` / `config.input`）**原样透传**（与 `withRunFamily` 同一条约束 3）。
 *
 * @param {Record<string, any>} options
 * @returns {Record<string, any>}
 */
function withInputFamily(options) {
  const rest = { ...options };
  const moved = {};
  for (const key of INPUT_FAMILY_FIXTURE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rest, key)) continue;
    if (rest[key] !== undefined) moved[key] = rest[key];
    delete rest[key];
  }
  if (Object.keys(moved).length === 0) return rest;
  const config = rest.config;
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    return options;
  }
  const base = config === undefined ? {} : config;
  const input = base.input;
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    return options;
  }
  return { ...rest, config: { ...base, input: { ...moved, ...(input ?? {}) } } };
}

export function withSeed(options = {}) {
  const { seed, initialUserMessage, ...flat } = withInputFamily(withRunFamily(options));
  const message = seed === undefined ? initialUserMessage : seed;
  const rest = flat;
  const config = rest.config;
  // 约束 3：非对象 `config` 是「形状拒绝」格，原样透传（不并种子、不新建第二个键）。
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    return rest;
  }
  if (message === undefined) return rest;
  const base = config === undefined ? {} : config;
  const input = base.input;
  // `config.input` 是非对象时同理：那格测的是 input 的形状，不是种子。
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    return rest;
  }
  return {
    ...rest,
    config: { ...base, input: { ...(input ?? {}), initialUserMessage: message } },
  };
}

/**
 * 直连路线跑一次 `runToolLoop`（共享夹具，见文件头）。
 *
 * 只做一件事：把种子首轮消息翻译到 `config.input.initialUserMessage` 之后原样转发。
 * 其余选项（`provider` / `executeTool` / `assemblyPort` / `maxRounds` …）一律透传，
 * 夹具不替调用方补默认值——各文件的「最小合法集」不一样，补默认值等于把一份策略塞进 88 个格子。
 *
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export function runDirect(options = {}) {
  return runToolLoop(withSeed(options));
}

/** 直连路线的「抛了什么」（不抛返回 `null`）。与 `runDirect` 同源，只多一层 `.then`。 */
export function directError(options = {}) {
  return runDirect(options).then(() => null, (error) => error);
}
