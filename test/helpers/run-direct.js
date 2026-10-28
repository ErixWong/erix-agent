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
//
// 零真实 LLM、不写盘、不碰 `~/.erix`：夹具只做对象合并，run 的隔离仍由调用方负责。

import { runToolLoop } from "../../src/loop/orchestrator.js";

/**
 * 把「种子首轮消息」并进唯一的 `config` 容器，返回**可以直接喂给 `runToolLoop`** 的选项对象。
 *
 * 接受两种调用方拼写（都只在夹具边界存在，绝不透传给引擎）：
 *   · `initialUserMessage: "…"` —— 旧扁平拼写，88 个既有文件用的就是它（本刀的迁移面）；
 *   · `seed: "…"` —— 夹具自己的规范拼写，新写的格子用它（`seed` 赢过 `initialUserMessage`）。
 *
 * `undefined` 逐字等于「没给种子」（与 `runToolLoop` 的 `value !== undefined` 合并口径同源），
 * 于是 `runDirect({ initialUserMessage: undefined })` 不产生 `config.input.initialUserMessage`。
 *
 * @param {Record<string, unknown>} [options]
 * @returns {Record<string, unknown>}
 */
export function withSeed(options = {}) {
  const { seed, initialUserMessage, ...rest } = options;
  const message = seed === undefined ? initialUserMessage : seed;
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
