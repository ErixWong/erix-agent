// @ts-check
// 工具事实（tool fact）契约面 —— 单一构造点 + 双命名空间 + 常量单一真相（工单 261014 T1，上游 #284 / #285）。
//
// 病根：引擎注入字段与宿主自有 metadata 曾挤在同一个扁平 map 里（`run-snapshot-executor.js` 的
// `...execution.metadata`），同类缺陷已出现四次（`erixRound`、`is_error`、`duration`、#284 的身份）。
// 本模块不补一条字段，而是把两件事变成同源事实：
//   1. **同一个 tool_result 事实只由 `buildToolResultFact()` 构造一次**（引擎事实在 `erix.*`，
//      宿主扩展在 `metadata.*`，`is_error` 留在顶层是 wire 字段）；构造器**不**把 metadata 摊平到顶层；
//   2. **「谁是某个字段的拥有者」写进导出的 `TOOL_RESULT_CONTRACT`**，由三方消费同一份：
//      构造器（按它写路径）、`scripts/docs-drift-check.mjs`（契约文档的字段清单与该常量双向比成员）、
//      `test/contract/tool-result-envelope.js`（从常量生成期望字段集合）。
//
// T1 是 additive 双写期；**T2（工单 261014）结束双写**：引擎不再写顶层摊平的宿主键，也不再写顶层
// `erixRound` / `duration` / `executionStatus` / `success`。那是 BREAKING，进 CHANGELOG 的
// `Changed (BREAKING)`；退役名单与「旧记录一代内仍可读」的口径写在 `TOOL_RESULT_CONTRACT.legacy`。
// 写侧只剩协议字段 + `metadata.*` + `erix.*`；读侧仍承认顶层旧名一代，共七处（`erix` 优先、顶层回退）：
// TTL 折叠、投影、续跑复放、单轮聚合预算、judge 时间线与对话渲染、L0 客观事实、`hasSuccessfulToolResult`。
//
// 零依赖红线：只用 `node:` 内置 + 相对路径。

import { randomBytes } from "node:crypto";

/** 递归冻结（常量面不许被宿主或引擎某处悄悄改写）。 */
function deepFreeze(
  /** @type {any} */ value,
) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * 字段归属的唯一真相（工单 §4）。
 *
 * 消费方与本常量的关系是**成员级**的：新增/改名一个引擎字段必须改这里，于是
 * 契约文档的字段清单（`docs-drift-check` 的 `anchors` 规则）与契约测试的期望字段集
 * 会同时变红，而不是留下第三处自说自话的清单。
 */
export const TOOL_RESULT_CONTRACT = deepFreeze({
  protocol: {
    required: ["type", "tool_use_id", "content"],
    conditional: {
      is_error: "仅在结果为错误/中断时存在；Anthropic wire 字段（src/messages/anthropic.js 会发），引擎写",
    },
  },
  engine: {
    ns: "erix",
    fields: {
      toolCallKey: {
        owner: "engine",
        stages: ["use", "result", "streamFragment", "projection"],
        resumeStable: true,
        onWire: false,
      },
      round: {
        owner: "engine",
        stages: ["result", "projection"],
        resumeStable: true,
        onWire: false,
      },
      durationMs: {
        owner: "engine",
        stages: ["result", "projection"],
        resumeStable: true,
        onWire: false,
        capturedAt: "executor settle",
        recomputedOnReplay: false,
      },
      executionStatus: {
        owner: "engine",
        stages: ["result", "projection"],
        resumeStable: true,
        onWire: false,
        // 存在条件（issue #286 追加：常量面以前不标这个，只读 TOOL_RESULT_CONTRACT 的宿主会按「每个结果块都有」写代码）
        writtenFor: "special states only",
        presentValues: ["intercepted", "interrupted"],
        note: "只在特殊状态写：interrupted 来自 resume 改写（src/loop/orchestrator.js），intercepted 来自审计拦截（src/loop/run-snapshot-executor.js）；普通成功结果块上本字段不存在（undefined），不是空串也不是 ok 之类的占位值。",
      },
      success: {
        owner: "engine",
        stages: ["result"],
        resumeStable: true,
        onWire: false,
        writtenFor: "every executed result",
        note: "T2 起一律写：顶层 success 停写后它是成败的唯一出口，「宿主声明过才写」会把「成功」与「未声明」压成同一件事",
      },
    },
  },
  host: {
    ns: "metadata",
    rule: "宿主只能写这里，引擎不得读出后覆盖引擎事实",
  },
  /**
   * 顶层保留键名（工单 261014 T1-fix 第 5 项，T2 停写后仍然成立）：这两个名字**就是命名空间本身**，
   * 永远由构造器写。宿主自有的同名键只能住在 `metadata.<键>` 里（`metadata.metadata` / `metadata.erix`）——
   * 停写后顶层已没有摊平路径，所以这不再是一个「看写入顺序才知道结果」的静默丢值，而是一句干净的归属声明。
   * 注意**不包含** `type` / `tool_use_id` / `content` / `is_error`：那四个协议字段被宿主键覆盖与否是另一件
   * 事（工单 261014 §7 明写本刀**不**把它们纳入保留键，收紧另案）。
   */
  reserved: {
    topLevelKeys: ["metadata", "erix"],
    rule: "构造器独占这两个顶层键；宿主的同名扩展只在 metadata.<键> 里可取",
  },
  /**
   * **退役名单**（T2 起不再是「双写对照表」）：这些顶层名引擎**已经不再写**，
   * 但升级前落盘的旧记录（run snapshot / transcript）里可能仍有 —— 读路径保留一代，
   * 共三处：`src/loop/tool-result-ttl.js`（年龄标记）、`src/display/projection.js`（执行状态）、
   * `src/loop/orchestrator.js` 的续跑复放（原值直接带回，不重算也不补写）。
   */
  legacy: {
    aliases: {
      erixRound: "erix.round",
      duration: "erix.durationMs",
      executionStatus: "erix.executionStatus",
      success: "erix.success",
      "<host key>@top level": "metadata.<host key>",
    },
    written: false,
    readWindow: "旧记录一代内仍可读（上面那七处读路径，见 docs/host-consumer-contract 的退役一节）",
    retireAt: "下一个 minor（CHANGELOG 挂 Changed（BREAKING））",
  },
});

/** 引擎命名空间名（`TOOL_RESULT_CONTRACT.engine.ns` 的别名，避免调用点到处点路径）。 */
export const TOOL_FACT_ENGINE_NS = TOOL_RESULT_CONTRACT.engine.ns;
/** 宿主命名空间名（`TOOL_RESULT_CONTRACT.host.ns` 的别名）。 */
export const TOOL_FACT_HOST_NS = TOOL_RESULT_CONTRACT.host.ns;

/**
 * 引擎事实字段名（从常量派生，构造器只认这一份清单）。
 * @type {Record<string, { owner: string, stages: readonly string[], resumeStable: boolean, onWire: boolean }>}
 */
const ENGINE_FIELDS = /** @type {any} */ (TOOL_RESULT_CONTRACT.engine.fields);

// T2 停写之后，构造器不再有「把键铺到顶层」这条路径，所以 `TOOL_RESULT_CONTRACT.reserved.topLevelKeys`
// 不再需要一个运行时过滤器：顶层的 `metadata` / `erix` 天然只能由下面的命名空间写入产生。
// 常量仍然**登记**它们（契约中英两侧的「保留键名」声明由它锚定，改名就红）。


/** 引擎身份键的随机源：`node:crypto` 的 6 字节 hex（无第三方 id 生成器）。 */
export function allocateToolCallKey() {
  return `tc_${randomBytes(6).toString("hex")}`;
}

/**
 * 跨通道身份键注册表：**一次调用只分配一次**，值从「第一个可识别的流式片段」一直带到
 * `tool_use` 块、`onToolCall` fragment、`tool_result`、投影（工单 §2 线 A / §5）。
 *
 * 为什么不直接把 id 当身份：`toolCallKey` 必须比 provider `id` 更早存在（OpenAI 允许
 * 先推 arguments 后推 id），也必须在 provider 不给 id 的边界（老协议/畸形响应）下仍然存在；
 * 反过来 provider `id` 是**协议配对键**（`src/messages/rounds.js` 的配对校验、run snapshot
 * 的复放查找都靠它），本模块只读它、绝不改写它。
 *
 * 生命周期：一个 provider attempt 一个注册表（`beginToolCallAttempt` 换新的）。重试 attempt 的
 * 新响应有新的 provider id，也就有新的 key——被丢弃的那次 attempt 的调用不该和真正执行的那次
 * 共用一个身份（否则宿主的流式卡片会把两者并成一张）。
 */
export function createToolCallKeyRegistry(
  /** @type {() => string} */ allocate = allocateToolCallKey,
) {
  /** @type {Map<string, string>} provider id → 已分配的 key（同值复用的依据） */
  const byId = new Map();
  /** @type {Map<number, string>} 片段 index → 暂定 key（id 还没到时的桥） */
  const byIndex = new Map();

  /**
   * 给一个 `onToolCall` fragment 取（或分配）key。
   * @param {{ index?: unknown, id?: unknown }} fragment
   * @returns {string}
   */
  function keyForFragment(fragment) {
    const id = typeof fragment?.id === "string" && fragment.id !== "" ? fragment.id : undefined;
    const index = Number.isInteger(fragment?.index) && Number(fragment.index) >= 0
      ? Number(fragment.index)
      : undefined;
    if (id !== undefined) {
      const known = byId.get(id);
      if (known !== undefined) {
        if (index !== undefined) byIndex.set(index, known);
        return known;
      }
      // id 迟到（OpenAI 常见：arguments 先到、id 后到）→ 沿用该 index 的暂定 key，
      // 于是「第一个可识别片段」到 tool_use 块始终是同一个值。
      const provisional = index !== undefined ? byIndex.get(index) : undefined;
      const key = provisional ?? allocate();
      byId.set(id, key);
      if (index !== undefined) byIndex.set(index, key);
      return key;
    }
    if (index === undefined) return allocate();
    const existing = byIndex.get(index);
    if (existing !== undefined) return existing;
    const created = allocate();
    byIndex.set(index, created);
    return created;
  }

  function bind(id, key) {
    if (typeof id === "string" && id !== "" && typeof key === "string" && key !== ""
      && !byId.has(id)) {
      byId.set(id, key);
    }
  }

  /**
   * 不分配地查一下这个块是否已有身份：块上已写（resume / 复放带回的旧值）或本 attempt 的流式
   * 片段已绑过。顺手把块上的旧值绑到 provider id 上，于是同一个 attempt 里同一个 id 再被发一次
   * 也是同一个 key。**跳轮不在这里继承**：provider id 不保证 run 内唯一（issue #284），跳轮的
   * 继承只能由调用点拿「本轮已记录的结果」确认（orchestrator 的 `acceptedToolCallKey`）。
   * @param {{ id?: unknown, erix?: { toolCallKey?: unknown } }} block
   * @returns {string | undefined}
   */
  function peek(block) {
    const id = typeof block?.id === "string" && block.id !== "" ? block.id : undefined;
    const onBlock = block?.erix?.toolCallKey;
    if (typeof onBlock === "string" && onBlock !== "") {
      bind(id, onBlock);
      return onBlock;
    }
    return id !== undefined ? byId.get(id) : undefined;
  }

  return {
    keyForFragment,
    peek,
    /**
     * 调用被接受时（`tool_use` 块进上下文）认领 key：块上已有就复用（resume / 复放带回旧值），
     * 本 attempt 的流式片段已绑过就沿用，否则现场分配。**没有「按 provider id 扫历史」那一路**
     *（工单 261014 T1-fix 第 1 项）：新一轮的新调用即使与上一轮同名 id 也必须拿到新身份，
     * 否则只是把串号从 `id` 搬进 `toolCallKey`。
     * @param {{ id?: unknown }} block
     * @param {string} [confirmedReplay] 由**调用点确认是同一次调用**的旧值。目前只有一路：
     *   resume 崩溃现场里那条尚未产出结果的 pending 调用（同 id、且**没有配对 tool_result**
     *   的那个块就是它本人）。它不是「按 id 扫历史」：已配过结果的同 id 旧块已被排除掉。
     * @returns {string}
     */
    claimForBlock(block, confirmedReplay) {
      const known = peek(block);
      if (known !== undefined) return known;
      const id = typeof block?.id === "string" && block.id !== "" ? block.id : undefined;
      const key = typeof confirmedReplay === "string" && confirmedReplay !== ""
        ? confirmedReplay
        : allocate();
      bind(id, key);
      return key;
    },
  };
}

/**
 * 把 `toolCallKey` 挂到 `tool_use` 块上（**additive**：`erix` 之外一个键都不动）。
 * 块上已有同名字段一律复用——resume/run snapshot 复放的块带着旧值回来，重生成就等于
 * 把同一件事实在两条线上变成两件事。
 *
 * @param {any} block canonical `tool_use` 块（就地改，与 assistant.content / RoundRecord 同引用）
 * @param {string} [assigned] 调用点已算好的 key（缺省时现场分配）
 * @returns {string | undefined} 该块最终使用的 key
 */
export function ensureToolCallKeyOnBlock(block, assigned) {
  if (block === null || typeof block !== "object") return undefined;
  const existing = block.erix && typeof block.erix === "object"
    ? block.erix.toolCallKey
    : undefined;
  if (typeof existing === "string" && existing !== "") return existing;
  const key = typeof assigned === "string" && assigned !== "" ? assigned : allocateToolCallKey();
  block.erix = {
    ...(block.erix && typeof block.erix === "object" ? block.erix : {}),
    toolCallKey: key,
  };
  return key;
}

/**
 * 构造一个 canonical `tool_result` **事实**（唯一构造点）。
 *
 * 写入顺序 = 优先级顺序（后写覆盖先写）：`type`/`tool_use_id`/`content` → `metadata`（宿主命名空间）
 * → `is_error`（wire）→ `erix`（引擎命名空间）。除此之外**一个顶层键也不写**：T1 的 `legacyTopLevel`
 * 双写包到 T2 整条删除（工单 261014 §3），所以引擎写出的块只剩协议字段 + `metadata.*` + `erix.*`。
 * `content` 是协议必需字段（模型可见文本），调用点必须给；`input` 只在测试里允许缺省。
 *
 * @param {{
 *   toolUseId?: unknown,
 *   content?: unknown,
 *   isError?: boolean,
 *   hostMetadata?: Record<string, unknown>,
 *   engine?: Record<string, unknown>,
 * }} [input]
 * @returns {Record<string, any>}
 */
export function buildToolResultFact(input = {}) {
  /** @type {Record<string, any>} */
  const fact = {
    type: "tool_result",
    ...(input.toolUseId === undefined ? {} : { tool_use_id: input.toolUseId }),
    content: input.content,
  };
  // T2 停写：顶层不再有双写包（旧形状里只有协议字段 + 两个命名空间）。宿主的扩展只能落在
  // `metadata.<键>`，因此保留键名（`metadata` / `erix`）也不再需要过滤器——没有摊平路径就没有覆盖。
  const hostMetadata = input.hostMetadata;
  if (hostMetadata && Object.keys(hostMetadata).length > 0) {
    fact[TOOL_FACT_HOST_NS] = { ...hostMetadata };
  }
  if (input.isError === true) fact.is_error = true;
  /** @type {Record<string, any>} */
  const engineFacts = {};
  const provided = /** @type {Record<string, unknown>} */ (input.engine ?? {});
  for (const name of Object.keys(ENGINE_FIELDS)) {
    if (provided[name] !== undefined) engineFacts[name] = provided[name];
  }
  if (Object.keys(engineFacts).length > 0) fact[TOOL_FACT_ENGINE_NS] = engineFacts;
  return fact;
}
