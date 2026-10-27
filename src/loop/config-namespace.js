// @ts-check
// issue #497（S2）—— `config: { … }` 嵌套命名空间：**别名 = schema 路径**，不是第二张映射表。
// issue #498（S4a）—— 回调出树：`config.observers` 整组删除，规范之家是 `capabilities.hooks`
// （`src/loop/capabilities-namespace.js`），于是「`config` 子树过 JSON round-trip 等值」从
// **目标**变成**现状**；同时 `config` 里的函数值 intake 当场拒绝并点名完整路径（约束 4）。
// issue #498（S4b）—— 分类收口：`config.prompt` 改名 `input`（并把 `tools` / `messages` 收成
// 嵌套别名，于是能力面最后一个「数据却留在能力面」的成员归位）；`config.guard.deliverables`
// 整键删除（搬去 `capabilities.checks`）；`resume` 归位 `config.run.resume`（幻影组
// `session.resume` 别名删除，见 `src/assembly.js`）。
//
// 病根（母单 #495）：同一个 run 的配置住在两个命名空间——顶层 65 个选项里的配置键，加上装配口
// `policy` 里仅存的两个。宿主要给「一次 run 的旋钮」时没有一棵可读的树，也没有一个可以整体
// 校验/序列化/文档化的形状。本模块给出那棵树。
//
// 设计约束（本单的验收判据）：
//   1. **别名 = schema 路径**。`config.run.maxRounds` 与顶层 `maxRounds` 是同一个键的两种写法，
//      叶子名**逐字等于**顶层键名 ⇒ 展开就是「去掉路径前缀」，没有重命名表。谁也别想在这里
//      加一条「`config.run.rounds` → `maxRounds`」的别名——那会立刻多出第二套名字。
//      ⚠ 唯一的例外是 `CONFIG_LEAF_ALIASES`（#498 S4b）：`config.input.messages` 是顶层
//      `initialMessages` 的嵌套别名。它是**主 agent 裁决**要求的那条（输入载荷族的三个成员
//      收在同一组里），并且被钉成一张只有一条记录的显式表 + 自检里「别名目标必须真存在」——
//      它没有把「去掉路径前缀」退化成一张随便写的重命名表，也不许再长第二条。
//   2. **只有一张表**。分组表 `CONFIG_NAMESPACE_SCHEMA` 是唯一手写的部分；展开映射
//      (`CONFIG_ALIAS_PATHS`)、配置面名单 (`CONFIG_SURFACE_OPTION_NAMES`) 都从它机械派生。
//      完整性由 `configSchemaSelfCheck()` 对着 `RUN_TOOL_LOOP_OPTION_NAMES` 核：
//      每个顶层选项必须**恰好**落在「配置面」或「能力面」之一（漏一个、重一个都算问题）。
//      于是「往白名单加一个选项但忘了分类」不会静默——它会让自检报红（见
//      `test/loop-config-namespace-497.test.js`）。
//   3. **能力面不接受配置覆盖**（母单裁决），而**这条面的判据是行为、不是「引擎不解释」**
//      （#497 复审 R1 更正：旧判据「能力面 = 引擎不解释其值」是**假的**——`session` 的
//      `id`/`modelSlot`/`resume`/`initialMessages` 都被读，`model`/`modelMetadata` 的
//      `contextWindowTokens`/`maxOutputTokens` 数字被拿去算预算，`persistence` 的字面量被校验
//      并决定整条持久化路径。按旧判据分类等于把四个**配置**键锁在配置树外面）。
//      现判据（中英成对地写在契约里，见 `docs/host-consumer-contract{,_cn}.md` 的
//      「config 命名空间 / The `config` namespace」一节）：
//        · **能力面** = 宿主提供的**行为载体**（函数 / 端口对象），引擎**调用或解引用**它
//          （端口方法被调、信号被监听、回调被投递）；
//        · **配置面** = 引擎**按已知字段校值并解释**的数据（枚举字面量、数字、布尔、字符串标量、
//          结构已知的对象）。
  //      ⚠ 两点如实披露（#497 复审第二轮，第二点已由 #498 S4a 兑现）：
  //      ① **历史口径**（#498 S4b 已翻转，留着是因为它记录了判据怎么被兑现的）：S4a 那一版里
  //        `tools` **不满足**这条判据——引擎从不调用工具声明的成员，只校 `replay`、读 `name` /
  //        `inputSchema` 并原样送进请求体，按判据它是数据。当时它留在能力面是因为它属「输入
  //        载荷族」，整族的归属被推迟到 S4b。**S4b 已把它归位**：`tools` 现在是配置键
  //        （`config.input.tools`，与扁平 `tools` 是同一个键），所以能力面**现在是**纯「函数 /
  //        端口对象」——`tools` 这个反例不再存在。同一刀把交付物判据（`{name, check}` 数组）
  //        反向搬进 `capabilities.checks`，能力面因此多了一组，而 `hooks` 不变成口袋。
  //      ② 这条判据**已是现状**（不再是目标）：0.28.0 的 S4a 删掉了 `config.observers` 整组，11 个
  //        回调的规范之家是 `capabilities.hooks`，于是 `config` 子树只剩纯数据、过 JSON round-trip
  //        等值；反向由下面的约束 4 守住——`config` 里出现函数值，intake 当场拒绝。
  //
  //   4. **`config` 里不许有函数值**（#498 S4a 的核心判据）。round-trip 是事后体检，拒绝能保证
  //      「宿主以为设置了、其实没设置」不可能发生。整棵树（含数组元素）逐节点走一遍，函数值
  //      一律启动即抛并点名**完整路径**（`config.folding.context.onBeforeFold` 这种形态），报错里
  //      说清规范之家：`capabilities.hooks.<name>`（宿主回调）、`capabilities.checks.deliverables`
  //      （交付物判据）或对应的能力面端口位。
  //      **不收下再在展开时丢函数**——那正是「配了等于没配」的静默形状。
  //      因此 `finalGuard`（值必须是函数的那个配置叶子）在本刀**离开配置面**、回到能力面：
  //      一个「永远只能写函数」的叶子留在配置树里，会让本条的判据与 round-trip 断言同时失真。
  //      S4b 同理把 `deliverables` 整键搬走（它的每一条都带函数 `check`，留在配置面就只能写 `[]`）。
//      于是 `provider` / `store` / `modelConfig` / `signal` / 回调出口 … 这 22 项写进
//      `config` 一律启动即抛，报错点名该键（#498 S4b 之后 `tools` 已归配置面、`deliverables`
//      反向搬进能力面：两边的**条数没变**，变的是组成）。注意这条**只作用于新命名空间**——显式细粒度选项
//      覆盖装配口同名成员（`resolveAssemblyMember`（`src/assembly.js`））是既有行为，
//      `test/contract/assembly-port.js` 有断言，本单一个字都没改。
//
//      **`runId` / `cwd` 为什么在配置面**（#497 复审第二轮裁决，取消了上一轮给判据加的
//      「以及身份/环境注入」那一条腿）。两条理由，第一条是判据自身的健康，第二条是更强的正向理由：
//        1. 判据的价值在于**机械可检验**：能力面 = 被调用/被解引用的行为载体，配置面 = 被校值并
//           解释的数据。为两个键单开一条例外，判据就退化成「先分好类、再补理由」——谁来分类都能
//           自证。
//        2. 0.28 的可检验目标是「`config` 子树必须过 JSON round-trip 等值」。`runId` / `cwd` 是
//           **字符串标量、天然 JSON 安全**；能力面应当只剩函数/端口对象。把它们留在能力面，那条
//           0.28 判据就得反过来开例外（一条 round-trip 判据要豁免两个字符串键，它也就不再是判据）。
//      所以它们是 `config.run.runId` / `config.run.cwd`：别名新增，**顶层扁平键一字未动**。
//
// 优先级（范围 2）：同名时 `config.*` 覆盖顶层扁平键；顶层扁平键继续接受、行为一字不变。
// 冲突不静默——`expandConfigNamespace` 把「同一个键两种写法给了不同的值」记进 `conflicts`，
// 由 orchestrator 发一条 `config_override_conflict` 事件（唯一的发射点，与 #469 的
// `context_unknown_option` 同口径：观察者抛错不得影响 run）。
//
// 零运行时依赖：只用相对路径 + `node:` 内置。

import { isDeepStrictEqual } from "node:util";

import { tagValidationRoute } from "../assembly-validators.js";
import {
  CAPABILITIES_NAMESPACE_OPTION_NAME,
  CAPABILITIES_NAMESPACE_SCHEMA,
  CAPABILITIES_SURFACE_OPTION_NAMES,
  CAPABILITY_HOOK_NAMES,
  capabilitiesPathForOption,
  capabilitiesSchemaSelfCheck,
} from "./capabilities-namespace.js";

/**
 * 配置面的**唯一手写表**：分组 → 该组接受的叶子名。
 *
 * 叶子名必须逐字等于 `RUN_TOOL_LOOP_OPTION_NAMES` 里的顶层键名（见文件头约束 1；
 * 唯一例外是 `CONFIG_LEAF_ALIASES` 里的 `input.messages` → `initialMessages`）。
 * 分组的判据是「引擎里由谁消费」：同一子系统/同一生命周期阶段的旋钮放在一起，于是
 * `config.folding.*` 全是压缩与折叠、`config.guard.*` 全是强制收尾、`config.timing.*`
 * 全是时间预算。分组本身**不参与语义**（展开后一律回到顶层扁平键），它只影响可读性、
 * 报错文案与文档。
 *
 * 45 个配置键的分类草稿在 `docs/delivery/analysis-261023-406-normalization-design.md`
 * （15 run + 10 tuning 核心 + 10 folding + 10 其它）——该文件在本仓库树上**不存在**（`docs/delivery/`
 * 是 gitignore 的本机档案目录），所以这里的分组是照代码实测重新分类的结果，不是照抄草稿。
 * 现表共 **43 键 / 7 组**：草稿的 45 键 + #497 复审 R1 按新判据从能力面移进来的
 * `persistence`（→ `run`）与 `model` / `modelMetadata` / `session`（→ `metadata`）+ #497 复审
 * 第二轮按「字符串标量属数据」裁决从能力面移进来的 `runId` / `cwd`（→ `run`）；
 * **#498 S4a 又减去 9 个**：`observers` 整组（8 个回调，搬去 `capabilities.hooks`）与
 * `finalGuard`（值必须是函数 ⇒ 按判据它是行为载体，回能力面；见文件头约束 4）。
 * **#498 S4b 对调两个**：`deliverables` 搬去 `capabilities.checks`（它的每一条都带函数）、
 * `tools` 从能力面搬进来（`input.tools`，按判据它是数据）⇒ 条数仍是 43，组数仍是 7（`prompt`
 * 改名 `input`）。52 − 9 = 43 的算式不变，变的是成员。
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CONFIG_NAMESPACE_SCHEMA = Object.freeze({
  // 输入载荷族：一次 run 开头就定下来的那几块输入（系统提示、种子消息、工具声明）与开关。
  // #498 S4b 把 `prompt` 改名 `input` 并把两个顶层键收成嵌套别名：`tools`（顶层 `tools`）与
  // `messages`（顶层 `initialMessages`，唯一一条重命名，见 `CONFIG_LEAF_ALIASES`）。
  input: Object.freeze([
    "system",
    "cacheStablePrefix",
    "initialUserMessage",
    "messages",
    "wrapup",
    "tools",
  ]),
  // 轮次与循环控制：跑多久、什么算卡住、什么时候续、什么时候停、中途治理（judge/扩轮）、
  // 以及持久化**模式**（`persistence` 是「这次 run 要不要落盘」的旋钮，与同组的
  // `partialPersistence` / `replayPolicy` 同族；它以前被错归进能力面，见文件头约束 3）。
  run: Object.freeze([
    "maxRounds",
    "maxTokenContinuations",
    "stallDetection",
    "completion",
    "replayPolicy",
    "invalidArguments",
    "partialPersistence",
    "persistence",
    "outputHygiene",
    "writeToolNames",
    "writeToolPathKeys",
    "resume",
    "stream",
    "reflection",
    // 身份与环境：两个**字符串标量**。它们以前按「身份/环境注入」留在能力面，现在按判据
    // （字符串标量 = 被原样带走的数据，不是被调用的行为载体）归配置面；0.28 的「`config` 子树
    // 必须过 JSON round-trip 等值」也要求它们是数据（见文件头约束 3 的两条理由）。
    "runId",
    "cwd",
  ]),
  // 请求侧的取值：每一发模型调用都带上的采样参数与端点能力。
  tuning: Object.freeze([
    "maxTokens",
    "temperature",
    "topP",
    "cacheCapable",
  ]),
  // 时间预算：单发超时、整条 run 的死线、以及失败重试的退避（强制收尾自己的超时在 guard 组）。
  timing: Object.freeze([
    "timeoutMs",
    "deadlineMs",
    "retry",
  ]),
  // 压缩与折叠：预算、策略、工具结果的生命周期。
  folding: Object.freeze([
    "context",
    "toolResultTtl",
    "toolResultFoldMinTokens",
  ]),
  // 强制收尾（final guard）与它的预算。
  // ⚠ `finalGuard` **不在这里**（#498 S4a）：它的值必须是函数，而 `config` 里不许有函数值
  // （文件头约束 4）——一个「永远只能写函数」的叶子留在配置树里，会让 round-trip 判据失真。
  // 它现在属能力面（`capabilities.hooks.finalGuard`），顶层扁平 `finalGuard` 一字未动。
  // ⚠ `deliverables` 也不在这里（#498 S4b）：每一条都带函数 `check`，所以它整键搬进了
  // `capabilities.checks.deliverables`，配置面里能写的只有 `[]` 的那个过渡态随之消失。
  guard: Object.freeze([
    "finalGuardMaxRetries",
    "finalGuardTimeoutMs",
    "finalGuardExtend",
  ]),
  // 宿主带来的数据：引擎**按已知字段**读其中的值，其余键原样透传 / 拼进 payload。
  //   · `model` / `modelMetadata`：`contextWindowTokens` / `maxOutputTokens` 两个数字被读
  //     （`modelMetadataFor`（`src/loop/budget.js`）→ 压缩预算与输出卫生的 15% 窗口钳制）；
  //   · `session`：`id` / `modelSlot` / `resume` / `initialMessages` 被读（启动校验、
  //     `modelConfig.resolve(session?.modelSlot)`、续跑与初始消息）；
  //   · `expert` / `user` / `task` / `requestId` / `toolContext`：拼进工具上下文与 judge 简报。
  // 这五个键里的后五个曾经只有「透传」一面，所以本组以前写成「引擎不解释其内部结构」；
  // 按现判据（文件头约束 3）它们同属配置面，描述按实测改。
  metadata: Object.freeze([
    "expert",
    "user",
    "task",
    "requestId",
    "toolContext",
    "model",
    "modelMetadata",
    "session",
  ]),
  // ⚠ 这里曾有第八组 `observers`（8 个 `on*` 回调）——**#498 S4a 整组删除**。
  // 回调不是数据：它们让 `config` 子树过不了 JSON round-trip，而「`config` 子树必须 round-trip
  // 等值」是 0.28 的硬判据。规范之家是 `capabilities.hooks`（`src/loop/capabilities-namespace.js`），
  // 12 个回调逐个在那边点名（#498 S4b 起 `finalGuard` 也在其中）；顶层扁平 `onRound` 等 0.26
  // 已发布面**照旧可用**（搬家是 S5/S6/S7
  // 的事，不在本刀）。0.27.0 未发布 ⇒ 删掉这组对任何外部宿主都是零成本。
});

/**
 * 能力面（**22 项**）：宿主**递进来**的行为载体。
 *
 * 判据（#497 复审 R1 更正后的版本，与文件头约束 3 同一句话）：**能力面 = 宿主提供的行为载体
 * （函数 / 端口对象），引擎调用或解引用它；配置面 = 引擎按已知字段校值并解释的数据**。
 * 所以这里的成员只有三类：
 *   · 适配器 / 端口对象（方法被引擎调用）：`provider`、`executeTool`、`store`、
 *     `modelConfig`、`assemblyPort`、`todoStateProvider`、`semanticStateProvider`；
 *   · 中止信号（被监听）：`signal`；
 *   · 宿主回调 / 行为载体（被投递、被调用）：`onEvent`、`onObserverError`、`onPersistenceError`、
 *     `diagnostics`，加上 `CAPABILITY_HOOK_NAMES`（`src/loop/capabilities-namespace.js`）里尚未
 *     列到的 **9 项**（#498 S4a 的 8 个观察者通道 + #498 S4b 的 `finalGuard`），再加
 *     `capabilities.checks` 那一组（#498 S4b：`deliverables`，每项带函数 `check`）。
 *
 * 派生而不是手抄：第三类里的 9 条从 `CAPABILITY_HOOK_NAMES` 机械减去已在上面列过的三条，
 * 第四类从 `CAPABILITIES_SURFACE_OPTION_NAMES` 减去已在上面列过的名字——于是「往
 * `capabilities` 加一个叶子却忘了分类」不会静默（`configSchemaSelfCheck` 报红）。
 *
 * 反例（为什么 `persistence` / `model` / `modelMetadata` / `session` **不在**这里）：引擎读它们的
 * 已知字段并据值改行为（`persistence` 的模式字面量被校验并选持久化路径；`model`/`modelMetadata`
 * 的窗口数字被拿去算预算；`session` 的 `id`/`modelSlot`/`initialMessages` 被读）——
 * 那是配置，不是行为载体。
 *
 * 反例（为什么 `runId` / `cwd` / `tools` **不在**这里）：`runId` / `cwd` 是**字符串标量**，
 * `tools` 是工具声明的**数组**——引擎不调用它们，只校字面量、读已知字段并原样带进 payload。
 * `tools` 曾在能力面（S4a 的历史口径，见文件头约束 3 披露①），#498 S4b 已把它归到
 * `config.input.tools`。
 *
 * `config` 里出现其中任何一个 ⇒ 启动即抛（母单裁决）；回调的**规范之家**是
 * `capabilities.hooks`，交付物判据是 `capabilities.checks.deliverables`（都是
 * `src/loop/capabilities-namespace.js`），不是 `config`。
 *
 * ⚠ 这条收窄**只作用于新命名空间**：显式细粒度选项覆盖装配口同名成员
 * （`resolveAssemblyMember`（`src/assembly.js`）；`test/contract/assembly-port.js` 的
 * 「显式细粒度 provider 覆盖端口 provider」断言）是既有行为，本单不改。
 *
 * @type {readonly string[]}
 */
const CAPABILITY_PORT_OPTION_NAMES = Object.freeze([
  // 适配器（装配口成员）/ 端口对象：方法被引擎调用
  "assemblyPort",
  "provider",
  "executeTool",
  "store",
  "modelConfig",
  // 中止信号与状态源
  "signal",
  "todoStateProvider",
  "semanticStateProvider",
  // 错误 / 事件出口
  "onEvent",
  "onObserverError",
  "onPersistenceError",
  "diagnostics",
]);

/** 上面的 12 项（端口 / 信号 / 出口）——与 `CAPABILITY_HOOK_NAMES` 的差集就是 9 个回调通道。 */
export const CAPABILITY_PLANE_BASE_OPTION_NAMES = CAPABILITY_PORT_OPTION_NAMES;

export const CAPABILITY_OPTION_NAMES = Object.freeze([
  ...CAPABILITY_PORT_OPTION_NAMES,
  // #498 S4a：8 个观察者通道（`onRound` / `onJudge` / `onToolResult` / `onDelta` /
  // `onReasoningDelta` / `onToolCall` / `onUsage` / `onFoldSummary`）从 `config.observers`
  // 整组移进能力面。它们本来就是回调——判据一直说它们在能力面，只是 0.27 把它们关在配置树里。
  // #498 S4b：`finalGuard` 也在这一支里（`CAPABILITY_HOOK_NAMES` 的第 12 项，见那边的注释）。
  ...CAPABILITY_HOOK_NAMES.filter((name) => !CAPABILITY_PORT_OPTION_NAMES.includes(name)),
  // #498 S4b：`capabilities.checks` 那一组（`deliverables`）。以前它挂在 `config.guard` 上，
  // 而配置面只装数据 ⇒ 能写的只有 `[]`；整键搬进能力面之后那个过渡态消失。
  ...CAPABILITIES_SURFACE_OPTION_NAMES.filter((name) => !CAPABILITY_PORT_OPTION_NAMES.includes(name)
    && !CAPABILITY_HOOK_NAMES.includes(name)),
]);

/** 配置面的分组名（顺序即报错文案里的枚举顺序）。 */
export const CONFIG_NAMESPACE_GROUPS = Object.freeze(Object.keys(CONFIG_NAMESPACE_SCHEMA));

/**
 * 命名空间自己的顶层键名。它是**容器**，不属于配置面也不属于能力面——展开后它就消失了，
 * 所以 `configSchemaSelfCheck` 把它排除在「必须分类」的集合之外（但要求它确实在顶层白名单里）。
 */
export const CONFIG_NAMESPACE_OPTION_NAME = "config";

/**
 * 两个容器的名单（#498 S4a 起是复数：`capabilities` 与 `config` **同等待遇**）。
 *
 * 容器 = 一棵树的入口键：它自己不是旋钮、不是能力键，展开后就消失。三向闭合的第三向就是它——
 * 「能力面 + 配置面 + 容器 = 顶层白名单」这条恒等式由 `configSchemaSelfCheck` 逐项核。
 */
export const NAMESPACE_CONTAINER_OPTION_NAMES = Object.freeze([
  CONFIG_NAMESPACE_OPTION_NAME,
  CAPABILITIES_NAMESPACE_OPTION_NAME,
]);

const NAMESPACE_CONTAINER_OPTION_SET = new Set(NAMESPACE_CONTAINER_OPTION_NAMES);

/**
 * 叶子名 → 顶层键名的**唯一**例外表（#498 S4b）。
 *
 * 整个模块只有这一条重命名：`config.input.messages` 是顶层 `initialMessages` 的嵌套别名
 * （主 agent 裁决：输入载荷族收在同一组里，成员名沿用「消息」这个更短的叫法）。
 * 它是显式的、只有一条、且由 `configSchemaSelfCheck` 反向核（映射到的名字必须真是顶层选项）。
 * 其余每个叶子名仍逐字等于顶层键名——不要往这张表里加第二条，那会让「别名 = schema 路径」
 * 退化成一张随便写的重命名表。
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
const CONFIG_LEAF_ALIASES = Object.freeze({
  input: Object.freeze({ messages: "initialMessages" }),
});

/**
 * **改名过的分组**：老组名 → 新组名（#498 S4b）。
 *
 * 报错必须指出去处——`config.prompt` 只回一句「未知分组 + 接受名单」，宿主得自己猜它变成了什么。
 * 这张表只有一条（`prompt` → `input`），它只影响**报错文案**，不参与任何取值逻辑。
 *
 * @type {Readonly<Record<string, string>>}
 */
const CONFIG_RENAMED_GROUPS = Object.freeze({ prompt: "input" });

/**
 * 某个配置叶子对应的顶层键名（`("input", "messages")` → `"initialMessages"`）。
 *
 * @param {string} group
 * @param {string} leaf
 * @returns {string}
 */
export function configOptionNameForLeaf(group, leaf) {
  return CONFIG_LEAF_ALIASES[group]?.[leaf] ?? leaf;
}

/** 配置面叶子 → 顶层键名的别名表（导出给测试核对覆盖度用）。 */
export const CONFIG_LEAF_ALIAS_PATHS = CONFIG_LEAF_ALIASES;

/**
 * 展开后的**别名表**：`"<group>.<leaf>"` → 顶层键名。
 *
 * 机械派生（叶子名逐字等于顶层键名，唯一例外见 `CONFIG_LEAF_ALIASES`），不是手写映射：
 * 加一个键只需在 `CONFIG_NAMESPACE_SCHEMA` 里把它放进某一组，别名自动出现。
 *
 * @type {ReadonlyMap<string, string>}
 */
export const CONFIG_ALIAS_PATHS = new Map(
  CONFIG_NAMESPACE_GROUPS.flatMap((group) => (
    CONFIG_NAMESPACE_SCHEMA[group].map((leaf) => [`${group}.${leaf}`, configOptionNameForLeaf(group, leaf)])
  )),
);

/** 配置面的顶层键全集（派生：schema 的扁平并集过别名表，顺序 = 分组顺序 + 组内顺序）。 */
export const CONFIG_SURFACE_OPTION_NAMES = Object.freeze(
  CONFIG_NAMESPACE_GROUPS.flatMap((group) => (
    CONFIG_NAMESPACE_SCHEMA[group].map((leaf) => configOptionNameForLeaf(group, leaf))
  )),
);

const CONFIG_SURFACE_OPTION_SET = new Set(CONFIG_SURFACE_OPTION_NAMES);
const CAPABILITY_OPTION_SET = new Set(CAPABILITY_OPTION_NAMES);
const CONFIG_GROUP_SET = new Set(CONFIG_NAMESPACE_GROUPS);

/**
 * 某个顶层配置键的 schema 路径（`maxRounds` → `"run.maxRounds"`），不属配置面时返回 undefined。
 *
 * @param {string} optionName
 * @returns {string|undefined}
 */
export function configPathForOption(optionName) {
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      if (configOptionNameForLeaf(group, leaf) === optionName) return `${group}.${leaf}`;
    }
  }
  return undefined;
}

/**
 * schema 自检：**三向闭合**——每个顶层选项必须**恰好**落在「配置面 / 能力面 / 容器」之一。
 *
 * 这条自检是「只有一张表」的锁：新增一个顶层选项却忘了分类 ⇒ 这里报「未分类」；
 * 同一个键同时出现在两处（或同一组里出现两次）⇒ 这里报「重复」。测试对着
 * `RUN_TOOL_LOOP_OPTION_NAMES` 跑它，于是白名单与 schema 不可能各改各的。
 *
 * #498 S4a 把它从「两向」改成「三向」：容器从 1 个（`config`）变成 2 个（+ `capabilities`），
 * 且 `capabilities.hooks` 里的每个回调都必须在能力面名单里、并且是顶层白名单里的真选项——
 * 于是「往 hooks 加一个回调却忘了分类」「hooks 里的名字根本不存在」两种漂移都红。
 *
 * @param {readonly string[]} optionNames 顶层选项白名单（`RUN_TOOL_LOOP_OPTION_NAMES`）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function configSchemaSelfCheck(optionNames) {
  const problems = [];
  const seen = new Map();
  for (const name of CONFIG_SURFACE_OPTION_NAMES) {
    const previous = seen.get(name);
    if (previous !== undefined) {
      problems.push(`config surface lists ${JSON.stringify(name)} twice (also in ${JSON.stringify(previous)})`);
      continue;
    }
    seen.set(name, configPathForOption(name));
    if (CAPABILITY_OPTION_SET.has(name)) {
      problems.push(`${JSON.stringify(name)} is both a config surface key and a capability option`);
    }
    if (NAMESPACE_CONTAINER_OPTION_SET.has(name)) {
      problems.push(`${JSON.stringify(name)} is a namespace container and cannot also be a config surface key`);
    }
  }
  const capabilitySeen = new Set();
  for (const name of CAPABILITY_OPTION_NAMES) {
    if (capabilitySeen.has(name)) problems.push(`capability list repeats ${JSON.stringify(name)}`);
    capabilitySeen.add(name);
    if (NAMESPACE_CONTAINER_OPTION_SET.has(name)) {
      problems.push(`${JSON.stringify(name)} is a namespace container and cannot also be a capability option`);
    }
  }
  // `capabilities.hooks` 的每个回调都必须在能力面名单里（否则「加了回调却忘了分类」会静默）。
  for (const hook of CAPABILITY_HOOK_NAMES) {
    if (!CAPABILITY_OPTION_SET.has(hook)) {
      problems.push(`capabilities.hooks names ${JSON.stringify(hook)}, which is not on the capability list`);
    }
  }
  // #498 S4b：能力面那一半的自检（每组的形状校验器存在、叶子是真选项、别名表与 schema 对得上）。
  problems.push(...capabilitiesSchemaSelfCheck(optionNames));
  // 配置面那一半：每个叶子映射到的顶层键必须真在名单里，且两个叶子不得映射到同一个键。
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      const option = configOptionNameForLeaf(group, leaf);
      if (!optionNames.includes(option)) {
        problems.push(
          `config.${group}.${leaf} maps to ${JSON.stringify(option)}, which is not a top-level option`,
        );
      }
    }
  }
  if (CONFIG_ALIAS_PATHS.size !== CONFIG_SURFACE_OPTION_NAMES.length) {
    problems.push(
      `config alias table has ${CONFIG_ALIAS_PATHS.size} paths`
      + ` for ${CONFIG_SURFACE_OPTION_NAMES.length} surface keys (two leaves map to the same key)`,
    );
  }
  for (const group of Object.keys(CONFIG_LEAF_ALIASES)) {
    if (!CONFIG_GROUP_SET.has(group)) {
      problems.push(`leaf alias table names unknown group ${JSON.stringify(group)}`);
    }
    for (const [leaf, option] of Object.entries(CONFIG_LEAF_ALIASES[group])) {
      if (!CONFIG_NAMESPACE_SCHEMA[group]?.includes(leaf)) {
        problems.push(`leaf alias ${group}.${leaf} is not a leaf of that group`);
      }
      if (CONFIG_NAMESPACE_SCHEMA[group]?.includes(option)) {
        problems.push(`leaf alias ${group}.${leaf} renames to ${option}, which is already a leaf name`);
      }
    }
  }
  for (const name of optionNames) {
    if (NAMESPACE_CONTAINER_OPTION_SET.has(name)) continue;
    if (!CONFIG_SURFACE_OPTION_SET.has(name) && !CAPABILITY_OPTION_SET.has(name)) {
      problems.push(`top-level option ${JSON.stringify(name)} is classified nowhere (config surface or capability list)`);
    }
  }
  for (const container of NAMESPACE_CONTAINER_OPTION_NAMES) {
    if (!optionNames.includes(container)) {
      problems.push(`top-level options do not accept ${JSON.stringify(container)} (a namespace container)`);
    }
  }
  for (const name of [...CONFIG_SURFACE_OPTION_NAMES, ...CAPABILITY_OPTION_NAMES]) {
    if (!optionNames.includes(name)) {
      problems.push(`schema names ${JSON.stringify(name)}, which is not a top-level option`);
    }
  }
  return problems;
}

/**
 * 某个叶子名住在哪个配置组里（`messages` → `"input"`）；不在任何组里时 undefined。
 *
 * 只用于报错文案：把叶子写在 `config` 顶层（`config.messages`）是最容易犯的误写之一，
 * 而 `configPathForOption` 回答的是「这个**顶层键**住在哪」——两个问题不同。
 *
 * @param {string} leaf
 * @returns {string|undefined}
 */
function configGroupForLeaf(leaf) {
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    if (CONFIG_NAMESPACE_SCHEMA[group].includes(leaf)) return group;
  }
  return undefined;
}

/**
 * `config` 命名空间的**名称/形状**问题（纯函数，不抛）。
 *
 * 三类问题分开说，因为它们的修法不同：
 *   · 能力键 ⇒ 这条路本来就不该走（配置面不接受能力覆盖）；
 *   · 扁平键写进了 config ⇒ 教他写成 `config.<group>.<key>`（路径由 schema 派生）；
 *   · 真·未知的名字 ⇒ 报「未知」并枚举该层接受的名单。
 *
 * @param {unknown} config `config` 的值（调用方已确认它不是 undefined）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function collectConfigNamespaceProblems(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be an object (or omitted)"];
  }
  const problems = [];
  for (const [group, value] of Object.entries(/** @type {Record<string, unknown>} */ (config))) {
    if (CAPABILITY_OPTION_SET.has(group)) {
      problems.push(capabilityProblemMessage(`config.${group}`, group));
      continue;
    }
    if (group === CAPABILITIES_NAMESPACE_OPTION_NAME) {
      problems.push(
        "config.capabilities: capabilities is a sibling namespace, not a config group"
        + " (write capabilities.hooks.<name> at the top level)",
      );
      continue;
    }
    if (CAPABILITIES_NAMESPACE_SCHEMA[group] !== undefined) {
      problems.push(
        `config.${group}: capabilities.${group} is a capability group, not a config group`
        + ` (write capabilities.${group}.<leaf> at the top level)`,
      );
      continue;
    }
    const path = configPathForOption(group);
    if (path !== undefined) {
      problems.push(
        `config.${group}: flat option keys are not accepted at the top of config`
        + ` (write config.${path} instead)`,
      );
      continue;
    }
    const leafHome = configGroupForLeaf(group);
    if (leafHome !== undefined) {
      problems.push(
        `config.${group}: leaf names are not accepted at the top of config`
        + ` (write config.${leafHome}.${group} instead)`,
      );
      continue;
    }
    if (!CONFIG_GROUP_SET.has(group)) {
      const renamed = CONFIG_RENAMED_GROUPS[group];
      problems.push(
        renamed === undefined
          ? `unknown config namespace: ${JSON.stringify(group)}`
            + ` (accepted: ${CONFIG_NAMESPACE_GROUPS.join(", ")})`
          : `config.${group}: the ${JSON.stringify(group)} group is now ${JSON.stringify(renamed)}`
            + ` (write config.${renamed}.<leaf> instead, e.g. config.${renamed}.${CONFIG_NAMESPACE_SCHEMA[renamed][0]})`,
      );
      continue;
    }
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`config.${group} must be an object`);
      continue;
    }
    for (const leaf of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
      if (CAPABILITY_OPTION_SET.has(leaf)) {
        problems.push(capabilityProblemMessage(`config.${group}.${leaf}`, leaf));
        continue;
      }
      if (!CONFIG_NAMESPACE_SCHEMA[group].includes(leaf)) {
        const misplaced = configPathForOption(leaf);
        problems.push(
          `unknown config.${group} option: ${JSON.stringify(leaf)}`
          + (misplaced === undefined
            ? ` (accepted: ${CONFIG_NAMESPACE_SCHEMA[group].join(", ")})`
            : ` (${JSON.stringify(leaf)} belongs to config.${misplaced})`),
        );
        continue;
      }
      // #498 S4a 约束 4：**合法叶子的值里不许有函数**。只走结构上已被接受的叶子（未知分组 /
      // 未知叶子已经在上面报过，不再拿它们的内部形状叠一条噪声）。
      const leafValue = /** @type {Record<string, unknown>} */ (value)[leaf];
      if (leafValue === undefined) continue;
      for (const functionPath of collectFunctionPaths(leafValue, `config.${group}.${leaf}`)) {
        problems.push(functionValueProblemMessage(functionPath));
      }
    }
  }
  return problems;
}

/**
 * 一棵子树里所有**函数值**的完整路径（含数组下标：`config.guard.deliverables[0].check`）。
 *
 * 逐节点走，不做类型推断：这条判据要回答的只有「这棵树能不能过 JSON round-trip」，
 * 而函数恰好是 `JSON.stringify` 会静默丢掉的那一类值（丢在数组里就是 `null`）。
 *
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
function collectFunctionPaths(value, path) {
  if (typeof value === "function") return [path];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectFunctionPaths(item, `${path}[${index}]`));
  }
  return Object.entries(/** @type {Record<string, unknown>} */ (value))
    .flatMap(([key, item]) => collectFunctionPaths(item, `${path}.${key}`));
}

/**
 * 函数值的统一文案：点名**完整路径**，说清原因（round-trip）与**规范之家**。
 *
 * 「规范之家」分三档，因为三类函数的目的地不同：
 *   · 宿主回调 / 交付物判据（名字就在能力面 schema 里）⇒ `capabilities.<group>.<leaf>`
 *     （可以逐字点出来，例如 `capabilities.hooks.onRound` / `capabilities.checks.deliverables`）；
 *   · 配置面自己的**数据键**（`tools` 之类）⇒ 它本来就该是纯数据，没有别处可搬；
 *   · 其余（`sleepImpl` / `judge.provider` …）⇒ 能力面里的对应端口位，端口容器本刀未收
 *     （S4b 之后裁），所以只能说到「能力面」这一层，不编造 `capabilities.ports.x`。
 *
 * @param {string} path
 * @returns {string}
 */
function functionValueProblemMessage(path) {
  const leaf = path.replace(/\[\d+\]$/u, "").split(".").at(-1) ?? "";
  const capabilityPath = capabilitiesPathForOption(leaf);
  const home = capabilityPath !== undefined
    ? `capabilities.${capabilityPath}`
    : CONFIG_SURFACE_OPTION_SET.has(leaf)
      ? `none: ${JSON.stringify(leaf)} is a data key of the config namespace, so pass plain data`
        + " (host callbacks belong under capabilities.hooks.<name>)"
      : "capabilities (capabilities.hooks.<name> for a host callback, or the matching capability port slot)";
  return `${path} is not accepted: ${JSON.stringify(leaf)} is a function, and the config namespace`
    + " holds data only (the config subtree must survive a JSON round-trip unchanged)"
    + ` — its canonical home is ${home}`;
}

/**
 * 能力键的统一文案：点名该键，并说清「能力面不接受配置覆盖」。
 *
 * 能力面里的名字多一句去处（#498 S4a / S4b）：它们的规范之家是 `capabilities.<group>.<leaf>`
 * ——报错不说去处，宿主只会把同一个值换个位置再撞一次。
 *
 * @param {string} path
 * @param {string} name
 * @returns {string}
 */
function capabilityProblemMessage(path, name) {
  const capabilityPath = capabilitiesPathForOption(name);
  return `${path} is not accepted: ${JSON.stringify(name)} is a capability/injection option,`
    + " and the capability surface cannot be overridden through the config namespace"
    + (capabilityPath === undefined
      ? " (pass it as a top-level option or through the assembly port)"
      : ` (pass it as capabilities.${capabilityPath} or as the top-level option)`);
}

/**
 * 名称/形状闸口：问题非空就抛 `TypeError`（贴路线标签，与 #496 的语义相同一口径）。
 *
 * @param {unknown} config
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {void}
 */
export function assertConfigNamespace(config, route = {}) {
  if (config === undefined) return;
  const problems = collectConfigNamespaceProblems(config);
  if (problems.length === 0) return;
  throw tagValidationRoute(new TypeError(problems.join("; ")), route.via);
}

/**
 * 两个 `config` 源同时在场时的**逐叶冲突**（#497 复审 R4）。
 *
 * 病根：装配口 `policy.config` 与调用级 `config` 是同一棵树的两个来源，而合并规则是
 * 「后写者胜」——调用级的那份**整棵**覆盖 policy 的那份。语义保留（这是既有合并规则的性质，
 * 不是本单发明的），但覆盖以前**零事件**：policy 里写了 `run.maxRounds: 4`、调用级写了 1，
 * 实测 4 轮变 1 轮、`onEvent` 一条都没收到。而「扁平 vs `config`」的冲突是会发
 * `config_override_conflict` 的，于是同一个引擎里出现两套静默度不同的规则。
 *
 * 本函数只做一件事：把两个源里**同一个叶子路径都给了值、且值不同**的那些叶子列出来，
 * 形状与 `expandConfigNamespace` 的 `conflicts` 逐字一致（`{ path, key }`，只带路径与键名——
 * 值可能是函数/大对象，不进事件载荷）。规则也与扁平冲突逐字同口径：
 *   · 只有一边给了值（另一边 `undefined` 或没有这个键）⇒ **不算冲突**；
 *   · 两边深度相等 ⇒ 不算冲突；
 *   · 顺序 = schema 分组顺序 + 组内顺序（确定、可断言）。
 *
 * 注意「整棵覆盖」的另一面：只写在**被覆盖的那棵树**里的叶子会被丢掉（回到默认值）——那是
 * 既有取值语义的一部分，本函数不改它，只在契约里写清（宿主不该把它当逐叶合并用）。
 *
 * @param {unknown} previousConfig 被覆盖的那棵树（装配口 `policy.config`）
 * @param {unknown} nextConfig 胜出的那棵树（调用级 `config`）
 * @returns {Array<{path: string, key: string}>} 逐叶冲突（空 = 没有可报的）
 */
export function collectConfigSourceConflicts(previousConfig, nextConfig) {
  const conflicts = [];
  if (!isConfigObject(previousConfig) || !isConfigObject(nextConfig)) return conflicts;
  const previous = /** @type {Record<string, any>} */ (previousConfig);
  const next = /** @type {Record<string, any>} */ (nextConfig);
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    const previousBag = previous[group];
    const nextBag = next[group];
    if (!isConfigObject(previousBag) || !isConfigObject(nextBag)) continue;
    for (const leaf of CONFIG_NAMESPACE_SCHEMA[group]) {
      const previousValue = previousBag[leaf];
      const nextValue = nextBag[leaf];
      if (previousValue === undefined || nextValue === undefined) continue;
      if (isDeepStrictEqual(previousValue, nextValue)) continue;
      conflicts.push({ path: `${group}.${leaf}`, key: configOptionNameForLeaf(group, leaf) });
    }
  }
  return conflicts;
}

/** `config` 树的一层是否为「普通对象」（`null` / 数组 / 标量都不是）。 */
function isConfigObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 展开 `config` 命名空间：把每个叶子写回它的顶层扁平键，并记下**冲突**。
 *
 * 展开规则（逐条都是本单的验收判据）：
 *   · `config.<group>.<leaf>` 与顶层 `<leaf>` 是同一个键 ⇒ 展开后只剩顶层那个键；
 *     叶子过 `CONFIG_LEAF_ALIASES` 后才是顶层键名（`input.messages` → `initialMessages`）；
 *   · 同名时 **config 赢**（范围 2 的优先级），顶层扁平键继续接受、行为不变；
 *   · 叶子的 `undefined` 逐字等于「没给」（与既有合并规则 `value !== undefined` 同口径），
 *     于是它既不覆盖扁平值、也不算冲突；
 *   · 两边都给了**不同的值** ⇒ 记一条冲突（`path` 是 schema 路径，`key` 是顶层键名，
 *     所以 `input.messages` 的冲突报成 `{ path: "input.messages", key: "initialMessages" }`）；
 *   · `config` 本身从展开结果里消失（下游看到的仍是一份扁平表示，#496 的语义相闸口
 *     因此对 config 里写的值一视同仁）。
 *
 * 返回新对象，不改入参。
 *
 * @param {Record<string, any>} options 合并后的选项表示（可能带 `config`）
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {{
 *   options: Record<string, any>,
 *   conflicts: Array<{path: string, key: string}>,
 * }} `conflicts` 里只放路径与键名：值可能是函数/大对象，不进事件载荷。
 */
export function expandConfigNamespace(options, route = {}) {
  const config = options.config;
  if (config === undefined) return { options, conflicts: [] };
  assertConfigNamespace(config, route);
  const expanded = { ...options };
  delete expanded.config;
  const conflicts = [];
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    const bag = /** @type {Record<string, any>|undefined} */ (config[group]);
    if (bag === undefined) continue;
    for (const [leaf, value] of Object.entries(bag)) {
      if (value === undefined) continue;
      const key = configOptionNameForLeaf(group, leaf);
      const flatValue = expanded[key];
      if (flatValue !== undefined && !isDeepStrictEqual(flatValue, value)) {
        conflicts.push({ path: `${group}.${leaf}`, key });
      }
      expanded[key] = value;
    }
  }
  return { options: expanded, conflicts };
}
