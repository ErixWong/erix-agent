// @ts-check
// issue #798：`reasoning_effort` 的 **CLI 面**——三通道接线 + 统计行的思考分解。
//
// 分工（本模块存在的理由）：引擎面与观测面在 #785 已经齐了（`observeSentReasoningParams` 交
// `sentRequestParams`、`normalizeOpenAIUsage` 交 `reasoningTokens`），缺的只是宿主侧没人接线：
// env 不被读、没有旗标、统计行看不见。所以本模块**只做宿主侧的事**，`src/` 一字未动——
// 尤其 `applyProviderPayloadOptions` 里 GLM 那条 `none→low`（ADR-017）仍在 payload 层生效，
// 本模块注入的值也要过它。
//
// 三条口径（写死，别照抄 `--model`）：
// 1. **优先级 `--effort` > `LLM_KIT_REASONING_EFFORT` > `slots.default.reasoning_effort`**，
//    与既有 `--model`（env **压过**旗标，见 `bin/config.js` 的 model 解析）**故意不同**：
//    旗标是「这一次」的意图，env 是「这个 shell」的意图，配置文件是「默认」。
//    钉住它的用例：`test/cli-reasoning-effort-798.test.js`。
// 2. **不做值域校验**（#788 parked）：值原样透传，非法值由上游 4xx 列出它的合法值清单
//    （qwen 族报 8 项、GLM 族报 7 项 ⇒ 任何本地枚举都是错的）。空值例外：`--effort ""`
//    与 `LLM_KIT_REASONING_EFFORT="  "` 一律**视为未提供**（不发字段），不是发一个空串。
// 3. **有事实才有格**（照 #785 P1）：上游没回报 `reasoning_tokens` 就**不打**那一项，
//    绝不打 `0` 冒充「没思考」——「回报 0」与「没回报」是两个不同事实。

/** 通道名字 → 人在 CLI 上拧的那个旋钮（`--help` 与统计行的文案同源）。 */
export const REASONING_EFFORT_CHANNELS = Object.freeze({
  cliFlag: "--effort",
  cliEnv: "LLM_KIT_REASONING_EFFORT",
  slotDefault: "slots.default.reasoning_effort",
});

/**
 * 空值处理：非字符串 / 空串 / 纯空白 ⇒ `undefined`（= 未提供，不发字段）。
 * 其余**原样**返回（去掉首尾空白，与 `readEnvironmentValue` 同口径），**不校验值域**。
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function normalizeReasoningEffort(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 三通道优先级裁决（issue #798 判据 2 —— 两种「同时在场」的组合都要取对的那个）。
 *
 * @param {{ flag?: unknown, env?: Record<string, string | undefined>, slot?: unknown }} [input]
 * @returns {{ value: string|undefined, source: string|undefined, label: string|undefined }}
 *   `source` 是机器名（`cliFlag` / `cliEnv` / `slotDefault`），`label` 是给人看的那个旋钮名；
 *   三处都没值 ⇒ 两者都 `undefined`（没有事实就不产键）。
 */
export function resolveReasoningEffort({ flag, env = process.env, slot } = {}) {
  const fromFlag = normalizeReasoningEffort(flag);
  if (fromFlag !== undefined) {
    return { value: fromFlag, source: "cliFlag", label: REASONING_EFFORT_CHANNELS.cliFlag };
  }
  const fromEnv = normalizeReasoningEffort(env?.LLM_KIT_REASONING_EFFORT);
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: "cliEnv", label: REASONING_EFFORT_CHANNELS.cliEnv };
  }
  const fromSlot = normalizeReasoningEffort(slot);
  if (fromSlot !== undefined) {
    return { value: fromSlot, source: "slotDefault", label: REASONING_EFFORT_CHANNELS.slotDefault };
  }
  return { value: undefined, source: undefined, label: undefined };
}

/**
 * 「本次 CLI 覆盖」的那一份值：只有**旗标或 env** 给的值才注进请求通道。
 *
 * slot 的值**不注**——它本来就走 provider 构造参数那条路，硬注会让观测面把配置文件里的默认
 * 也报成 `request`，「这次覆盖的」与「配置文件里写的」那个二分（判据 ① 的全部内容）就地消失。
 *
 * @param {{ value?: string, source?: string }} resolved `resolveReasoningEffort` 的返回值
 * @returns {string|undefined}
 */
export function cliReasoningOverride(resolved) {
  return resolved?.source === "cliFlag" || resolved?.source === "cliEnv"
    ? resolved.value
    : undefined;
}

/**
 * 引擎与 CLI 会从 provider 对象上取走的成员名册（**防漂移表**，由
 * `test/cli-reasoning-effort-798.test.js` 钉住：漏一个转发就红）。
 *
 * 事实来源（不是抄的）：引擎只有 `provider.chat` / `provider.chatStream` 两个调用点
 * （`src/loop/provider-runner.js`），装配口校验 `typeof provider.chat/chatStream`
 * （`src/assembly-validators.js`），`createOpenAIProvider` 交回的对象另带这些**数据**成员。
 */
export const PROVIDER_MEMBER_SURFACE = Object.freeze([
  "chat",
  "chatStream",
  "protocol",
  "model",
  "model_type",
  "supports_reasoning",
  "thinking_format",
  "contextWindowTokens",
  "maxOutputTokens",
]);

/** 需要注入请求级覆盖的方法（只有它们带 `req`，其余成员是数据，透传即可）。 */
const REQUEST_METHODS = Object.freeze(["chat", "chatStream"]);

/**
 * 把「本次 CLI 覆盖的值」注进**请求通道**（issue #798 判据 1 的实现方式，裁决 A）。
 *
 * 为什么走请求通道而不是 provider 构造参数：构造参数在引擎眼里是 `slotDefault`，
 * 那样轮记录里「这次 CLI 覆盖的」与「配置文件里写的」就分不开；注进 `req` 之后
 * 观测面交回的 `sentRequestParams.reasoningEffort.source` 是 `request`（≠ `slotDefault`），
 * 而 `hostValue` 仍是**翻译前**的值（GLM 的 `none→low` 只在 payload 层，`translated:true`
 * 会把它自己记下来）。没给值 ⇒ 原对象**原样返回**（不包装 = 零行为变化）。
 *
 * ⚠ 这是宿主侧的一层薄包装，**不是**新引擎 API；provider 自己怎么解释这个键由 `src/` 决定。
 *
 * @param {any} provider
 * @param {string|undefined} value
 * @returns {any}
 */
export function withCliReasoningEffort(provider, value) {
  if (value === undefined || provider === null || typeof provider !== "object") return provider;
  // 原型委托：将来 provider 多出来的成员**自动**可见，包装层不可能静默吞掉一个新方法
  // （`PROVIDER_MEMBER_SURFACE` 那张表钉的是「今天被取走的成员仍在」，这行兜住明天新增的）。
  const wrapped = Object.create(provider);
  for (const name of REQUEST_METHODS) {
    const original = provider[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (request = {}) => original.call(provider, {
      ...request,
      reasoning_effort: value,
    });
  }
  return wrapped;
}

/**
 * 统计行的思考分解收集器（issue #798 判据 3；口径照 #785 P1「有事实才有格」）。
 *
 * 读的两处事实都在**轮记录**上（引擎原样落盘的那些）：`record.response.usage.reasoningTokens`
 * （契约：这个键骑在最后一发的 usage 上，**不进** `record.usage` 的四字段累加）与
 * `record.sentRequestParams.reasoningEffort`（`translated:true` 时把「设的值 → 实际发的值」
 * 一起打，GLM 那条 `none→low` 必须肉眼可见）。
 *
 * @returns {{ observe: (record: any) => void, format: () => string, observed: () => boolean }}
 */
export function createReasoningEffortStats() {
  let reported = false;
  let total = 0;
  /** @type {Map<string, string>} */
  const translations = new Map();

  return {
    observe(record) {
      const tokens = record?.response?.usage?.reasoningTokens;
      // 只认「上游真的回报了这个键且是个数」——`undefined` 不是 0，`0` 是真测量。
      if (Number.isFinite(tokens)) {
        reported = true;
        total += tokens;
      }
      const effort = record?.sentRequestParams?.reasoningEffort;
      if (effort?.translated === true) {
        translations.set(String(effort.hostValue), String(effort.sentValue));
      }
    },
    observed() {
      return reported || translations.size > 0;
    },
    /** 无事实 ⇒ **空串**（打出的行里连字段名都不出现，不是 `reasoningTokens=0`）。 */
    format() {
      const parts = [];
      if (reported) parts.push(`reasoningTokens=${total}`);
      for (const [hostValue, sentValue] of translations) {
        parts.push(`effort=${hostValue}→${sentValue}`);
      }
      return parts.join(" ");
    },
  };
}

/** 拼进统计行：无事实 ⇒ 空串 ⇒ 那一行与接线前逐字一致。 */
export function reasoningStatsSuffix(stats) {
  const formatted = stats.format();
  return formatted === "" ? "" : ` ${formatted}`;
}
