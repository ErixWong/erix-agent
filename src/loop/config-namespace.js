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
//      收在同一组里），并且被钉成一张只有一条记录的显式表 + 自检里「登记了别名的叶子必须真
//      存在」（死条目）——它没有把「去掉路径前缀」退化成一张随便写的重命名表，也不许再长第二条。
//   2. **只有一张表**。分组表 `CONFIG_NAMESPACE_SCHEMA` 是唯一手写的部分；展开映射
//      (`CONFIG_ALIAS_PATHS`)、配置面名单 (`CONFIG_SURFACE_OPTION_NAMES`) 都从它机械派生。
//      完整性由 `configSchemaSelfCheck()` 对着 `RUN_TOOL_LOOP_OPTION_NAMES` 核：
//      每个顶层选项必须**恰好**落在「配置面」或「能力面」之一（漏一个、重一个都算问题）。
//      于是「往白名单加一个选项但忘了分类」不会静默——它会让自检报红（见
//      `test/loop-config-namespace-497.test.js`）。
//      **#517 把这条恒等式改成单向**：方向是「每个顶层选项 → 恰好一个家」，**不是**「每个
//      配置叶子 ⇔ 一个顶层键」。一个 `config` 叶子**可以没有**对应的顶层选项——那正是 S3 删完
//      顶层扁平配置键之后 `config.run.maxRounds` 这类叶子的形状。仍然红的是：未分类的顶层键、
//      同一键落在两个面、容器漏登记、以及别名表里的死条目。被放行的那一半由另一条锁兜住：
//      `config` 的**每个叶子**都必须被 round-trip 覆盖名单取到值（`test/loop-capabilities-
//      namespace-498.test.js` 的 S7，逐叶子核，与叶子有没有顶层键无关）——于是「删了顶层键」
//      不会顺手造出一个没人摸过的叶子。
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
  //      ① **History, final ruling in #527.** S4a kept `tools` on the capability list; S4b moved
  //        it to `config.input.tools` on the reading "the engine only validates `replay`, reads
  //        `name` / `inputSchema`, and forwards the object". The A6 reachability check disproved
  //        that: an entry may carry `handler` / `validate` / `execute` / a function inside
  //        `inputSchema`, and "`config` holds data only" makes those shapes **flat-reachable,
  //        nested-unreachable**. The #527 ruling therefore says `tools` belongs to neither plane:
  //        it is a **permanent top-level option (the third station)**, the same class as `provider`
  //        / `executeTool` / `store`. The `config.input.tools` leaf was removed; writing it is an
  //        unknown leaf rejected on the spot. The capability plane is now purely behaviour
  //        carriers — the counter-example no longer exists.
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
//      `config` throws at startup and names the key (#527: `tools` is on the third station, so
//      writing it into `config` is rejected too — the message points at the top level). This rule
//      applies to the **new namespace only** — explicit fine-grained options
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
// Priority (scope 2): `config.*` wins over the flat top-level key of the same knob.
// Conflicts are never silent: when two `config` sources (`policy.config` / the call-level `config`)
// both give one leaf, `collectConfigSourceConflicts` records it per leaf and the orchestrator emits
// one `config_override_conflict` event (the single emission point, same rule as #469's
// `context_unknown_option`: an observer that throws must not affect the run).
// #545: the "flat vs config" branch is no longer a **conflict** but an internal invariant — no entry
// route can produce both spellings (see the JSDoc of `expandConfigNamespace`).
//
// 零运行时依赖：只用相对路径 + `node:` 内置。

import { isDeepStrictEqual } from "node:util";

import { tagValidationRoute } from "../assembly-validators.js";
import {
  CAPABILITIES_NAMESPACE_OPTION_NAME,
  CAPABILITIES_NAMESPACE_SCHEMA,
  CAPABILITIES_SLOT_LEAF_NAMES,
  CAPABILITIES_SURFACE_OPTION_NAMES,
  CAPABILITY_HOOK_NAMES,
  CAPABILITY_SLOT_DESTINATIONS,
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
 * 起点是 **43 键 / 7 组**：草稿的 45 键 + #497 复审 R1 按新判据从能力面移进来的
 * `persistence`（→ `run`）与 `model` / `modelMetadata` / `session`（→ `metadata`）+ #497 复审
 * 第二轮按「字符串标量属数据」裁决从能力面移进来的 `runId` / `cwd`（→ `run`）；
 * **#498 S4a 又减去 9 个**：`observers` 整组（8 个回调，搬去 `capabilities.hooks`）与
 * `finalGuard`（值必须是函数 ⇒ 按判据它是行为载体，回能力面；见文件头约束 4）。
 * **#498 S4b 对调两个**：`deliverables` 搬去 `capabilities.checks`（它的每一条都带函数）、
 * `tools` moved in from the capability plane (`input.tools`, then considered data).
 * **#527 removed it again**: the reachability check proved an entry may carry function members,
 * and the config plane holds data only ⇒ it is not a config key, it is a **permanent top-level
 * option (the third station)**. The config plane was therefore **42 keys / 7 groups** (43 −
 * `tools`), and the `input` group keeps 5 leaves.
 * **#531 removes one more**: `session` left the `metadata` group, so the plane is **41 keys / 7
 * groups**. The reason is not the data/behaviour criterion (session is plain data) but the
 * **double entry**: the top-level option and the assembly port's member are the *same value*
 * (`assemblyPortOptions(port).session === port.session`), so a `config.metadata.session` home
 * would be a second home for one key — the one thing the ruling forbids. It is a permanent
 * top-level option (the third station) instead, and writing the old nested spelling is an
 * unknown leaf rejected on the spot.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CONFIG_NAMESPACE_SCHEMA = Object.freeze({
  // The input family: the blocks fixed at the start of a run (system prompt, seed messages) and
  // their switches. S4b renamed `prompt` to `input` and folded `messages` in as a nested alias
  // (the flat `initialMessages`; the one registered rename, see `CONFIG_LEAF_ALIASES`).
  // #527 removed `tools`: it is not a data key (entries may carry function members), so its home
  // is the top level (the third station); writing `config.input.tools` is now an unknown leaf.
  input: Object.freeze([
    "system",
    "cacheStablePrefix",
    "initialUserMessage",
    "messages",
    "wrapup",
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
  //   · `expert` / `user` / `task` / `requestId` / `toolContext`：拼进工具上下文与 judge 简报。
  // 这五个键里的后五个曾经只有「透传」一面，所以本组以前写成「引擎不解释其内部结构」；
  // 按现判据（文件头约束 3）它们同属配置面，描述按实测改。
  // ⚠ `session` **不在这里**（#531）：它是纯数据，但它的顶层选项与装配口成员是**同一个值**
  // （`assemblyPortOptions(port).session === port.session`，引用相等），给它一个嵌套家就是
  // 「一个键两个家」——正是本仓裁决禁止的那件事。所以它属**第三站**（永久顶层面），
  // 写 `config.metadata.session` 现在是未知叶子当场拒。
  metadata: Object.freeze([
    "expert",
    "user",
    "task",
    "requestId",
    "toolContext",
    "model",
    "modelMetadata",
  ]),
  // ⚠ 这里曾有第八组 `observers`（8 个 `on*` 回调）——**#498 S4a 整组删除**。
  // 回调不是数据：它们让 `config` 子树过不了 JSON round-trip，而「`config` 子树必须 round-trip
  // 等值」是 0.28 的硬判据。规范之家是 `capabilities.hooks`（`src/loop/capabilities-namespace.js`），
  // 12 个回调逐个在那边点名（#498 S4b 起 `finalGuard` 也在其中）；顶层扁平 `onRound` 等 0.26
  // 已发布面**照旧可用**（搬家是 S5/S6/S7
  // 的事，不在本刀）。0.27.0 未发布 ⇒ 删掉这组对任何外部宿主都是零成本。
});

/**
 * The capability surface (**22 items**, meaning the **top-level option** layer): the behaviour
 * carriers the host **hands in**.
 *
 * #498 S4c adds one boundary: the capability schema also holds nine **nested-slot** leaves
 * (`ports.*` and six `hooks.*`), which are **not** top-level options (they never were, and this slice
 * invents none) — so they are not on this 22-item list and take no part in the three-way identity
 * ("config surface + capability surface + containers = allowlist"). Their destinations are registered
 * in `CAPABILITY_SLOT_DESTINATIONS` (`src/loop/capabilities-namespace.js`) and delivered on the
 * `slots` side channel.
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
 * 反例（为什么 `persistence` / `model` / `modelMetadata` **不在**这里）：引擎读它们的
 * 已知字段并据值改行为（`persistence` 的模式字面量被校验并选持久化路径；`model`/`modelMetadata`
 * 的窗口数字被拿去算预算）——那是配置，不是行为载体。
 *
 * 反例（为什么 `session` **不在**这里，issue #531）：它是数据不是行为载体（`id` / `modelSlot` /
 * `initialMessages` 被读），所以按判据它本来该进配置面；但它的顶层选项与装配口成员是**同一个值**
 * （`assemblyPortOptions(port).session === port.session`），任何嵌套家都会让它有两个入口指向
 * 两个家。裁决是**两个入口、一个家**：家是第三站（顶层），嵌套拼写是未知叶子。
 *
 * Counter-example (why `runId` / `cwd` are **not** here): they are **string scalars** — the engine
 * does not call them, it only validates the literal, reads known fields and forwards them.
 *
 * Counter-example (why `tools` is **not** here, issue #527): a tool entry may carry function
 * members (`handler` / `validate` / `execute` / a function inside `inputSchema`), while the
 * capability criterion is "the engine calls or dereferences it" — the engine never calls those
 * members, it only reads `name` / `inputSchema` and projects the entry to the provider. It is not
 * config either (`config` holds data only, see constraint 4 in the file header) ⇒ it is a
 * **permanent top-level option (the third station)**, the same class as `provider` /
 * `executeTool` / `store`. `TOP_LEVEL_SURFACE_OPTION_NAMES` is that station.
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
  // #498 S4c: the last four entries of `CAPABILITY_HOOK_NAMES` (`onReflection` / `onBeforeFold` /
  // `onAfterFold` / `stubFor`) have **no** top-level flat alias ⇒ they are not top-level options and
  // therefore cannot be on this list (the three-way identity would go red). Together with `ports.*`
  // they are the "nested-slot leaves", whose destinations live in `CAPABILITY_SLOT_DESTINATIONS`.
  ...CAPABILITY_HOOK_NAMES.filter((name) => !CAPABILITY_PORT_OPTION_NAMES.includes(name)
    && !CAPABILITIES_SLOT_LEAF_NAMES.includes(name)),
  // #498 S4b：`capabilities.checks` 那一组（`deliverables`）。以前它挂在 `config.guard` 上，
  // 而配置面只装数据 ⇒ 能写的只有 `[]`；整键搬进能力面之后那个过渡态消失。
  ...CAPABILITIES_SURFACE_OPTION_NAMES.filter((name) => !CAPABILITY_PORT_OPTION_NAMES.includes(name)
    && !CAPABILITY_HOOK_NAMES.includes(name)),
]);

/**
 * The **third station** (issue #527): options that live **only** at the top level.
 *
 * These are the keys with **no nested home** — `configPathForOption(name)` and
 * `capabilitiesPathForOption(name)` both return `undefined`. The nine adapter / identity keys
 * (`provider`, `executeTool`, `store`, …) have always been like this; `tools` joins them by the #527
 * ruling, which removed the `config.input.tools` leaf (its entries may carry function members, so it
 * cannot live in the data-only `config` subtree, and the engine never calls those members, so it is
 * not a capability either). `session` joins them by the #531 ruling, for the opposite reason: it *is*
 * plain data, but its top-level option and the assembly port's member are **the same value**
 * (`assemblyPortOptions(port).session === port.session`), so a `config.metadata.session` home would
 * be a **second home for one key**. Two entries, one home: the top level.
 *
 * The table is hand-written on purpose: it is the **ownership classification** the self-check needs
 * to answer "every top-level option has exactly one home". Membership is verified mechanically in
 * both directions (`configSchemaSelfCheck`): every entry must be a top-level option with no nested
 * home, and every top-level option with no nested home must be an entry. The two containers
 * (`config` / `capabilities`) are not members — they are their own bucket and disappear on expansion.
 *
 * `tools` is the machine proof of the 11 → 12 account: before #527 it had a config home, so the
 * "no nested home" group was 11 keys; after the leaf is removed it is 12. Re-adding the leaf turns
 * `configSchemaSelfCheck` red (the same key would be both a config surface key and a third-station
 * key), which is exactly the reverse proof that this table is live rather than a copied expectation.
 * `session` repeats the proof one step later (#531): the third station goes 10 → 11 when the
 * `config.metadata.session` leaf is removed, and putting that leaf back turns the same self-check
 * red — which is why the closed-door test can pin the rejection instead of trusting a list.
 *
 * @type {readonly string[]}
 */
export const TOP_LEVEL_SURFACE_OPTION_NAMES = Object.freeze([
  "assemblyPort",
  "provider",
  "executeTool",
  "store",
  "modelConfig",
  "signal",
  "todoStateProvider",
  "semanticStateProvider",
  "diagnostics",
  "tools",
  // #531: `session` — plain data, but the top-level option and the assembly port member
  // (`createAssemblyPort({ session })` → `assemblyPortOptions(port).session`) are the same value,
  // so its one home is here; `config.metadata.session` is now an unknown leaf.
  "session",
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
 * #517 之后「配置面」这一项是 `configPlaneOptionNames(optionNames)`（叶子映射到、**且**白名单
 * 里真的还有的顶层键），所以一个叶子失去顶层键时它只从这一项里掉出去，不会把恒等式弄红。
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
 * 它是显式的、只有一条、且由 `configSchemaSelfCheck` 核两件事：**登记了别名的叶子必须真存在**
 * （否则就是一条死条目）与**不许改名撞到本组已有的叶子名**。
 * #517：自检**不再**要求「映射到的名字必须是顶层选项」——叶子可以没有顶层键（S3 的形状）。
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

/**
 * 配置面叶子的**扁平名字全集**（派生：schema 的扁平并集过别名表，顺序 = 分组顺序 + 组内顺序）。
 *
 * ⚠ #517 起它的名字只是「schema 会映射到的顶层键名」，**不再**蕴含「这些键真的还在白名单里」：
 * 一个 `config` 叶子可以没有对应的顶层选项（S3 删完顶层扁平配置键之后就是那个形状）。想知道
 * 「哪些还是真选项」用 `configPlaneOptionNames(optionNames)`；两者在 #517 当时**逐字相等**
 * （43 = 43，本刀不删任何键），差集只在 S3 之后非空。
 */
export const CONFIG_SURFACE_OPTION_NAMES = Object.freeze(
  CONFIG_NAMESPACE_GROUPS.flatMap((group) => (
    CONFIG_NAMESPACE_SCHEMA[group].map((leaf) => configOptionNameForLeaf(group, leaf))
  )),
);

/**
 * #517：配置面里**真的还是顶层选项**的那些键（`CONFIG_SURFACE_OPTION_NAMES` ∩ `optionNames`）。
 *
 * 这是单向化之后「配置面」这一项的定义：一个叶子失去顶层键（S3）只会从这里掉出去，**不会**
 * 让自检报「maps to …, which is not a top-level option」——那条红以前是对的，现在它是
 * 「叶子可以没有顶层键」的反面。仍然成立的是恒等式的另一头：每个顶层选项恰好落在一个家里。
 *
 * @param {readonly string[]} optionNames 顶层选项白名单（`RUN_TOOL_LOOP_OPTION_NAMES`）
 * @returns {string[]} 仍是顶层选项的配置键（schema 顺序）
 */
export function configPlaneOptionNames(optionNames) {
  const allowed = new Set(optionNames);
  return CONFIG_SURFACE_OPTION_NAMES.filter((name) => allowed.has(name));
}

const CONFIG_SURFACE_OPTION_SET = new Set(CONFIG_SURFACE_OPTION_NAMES);
const CAPABILITY_OPTION_SET = new Set(CAPABILITY_OPTION_NAMES);
const TOP_LEVEL_SURFACE_OPTION_SET = new Set(TOP_LEVEL_SURFACE_OPTION_NAMES);
const CONFIG_GROUP_SET = new Set(CONFIG_NAMESPACE_GROUPS);

/**
 * The **disjoint home buckets** of the top-level allowlist (issue #527).
 *
 * Four buckets, no overlap, and together they add up to the allowlist:
 *   · `configPlane` — the config leaves that still have a top-level key (intersection);
 *   · `capability` — capability options that are **not** third-station keys (they have a nested
 *     `capabilities.*` home or are hooks whose home is `capabilities.hooks`);
 *   · `topLevelSurface` — the permanent top-level options (no nested home at all);
 *   · `containers` — `config` / `capabilities`, which disappear on expansion.
 *
 * Why the capability bucket subtracts the third station: the nine adapter / identity keys are both
 * capability options (behaviour carriers) **and** permanent top-level options (no nested home). The
 * ownership account needs a disjoint partition, so the third station wins for those nine; the
 * semantic `CAPABILITY_OPTION_NAMES` list is unchanged (22 entries) and still answers "is this a
 * capability option". `tools` and `session` are the two third-station members that are **not**
 * capability options (`tools` because the engine never calls its function members, `session`
 * because it is plain data whose only home is the top level, #531).
 *
 * @param {readonly string[]} optionNames 顶层选项白名单
 * @returns {{configPlane: string[], capability: string[], topLevelSurface: string[], containers: string[]}}
 */
export function optionHomeBuckets(optionNames) {
  const allowed = new Set(optionNames);
  const topLevelSurface = TOP_LEVEL_SURFACE_OPTION_NAMES.filter((name) => allowed.has(name));
  const topLevelSet = new Set(topLevelSurface);
  return {
    configPlane: configPlaneOptionNames(optionNames),
    capability: CAPABILITY_OPTION_NAMES.filter((name) => allowed.has(name) && !topLevelSet.has(name)),
    topLevelSurface,
    containers: NAMESPACE_CONTAINER_OPTION_NAMES.filter((name) => allowed.has(name)),
  };
}

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
 * Schema self-check: **four-way closure** — every top-level option must fall in exactly one of
 * "config surface / capability / permanent top-level surface / container" (issue #527 added the
 * third station; the first three buckets are defined by `optionHomeBuckets`).
 *
 * 这条自检是「只有一张表」的锁：新增一个顶层选项却忘了分类 ⇒ 这里报「未分类」；
 * 同一个键同时出现在两处（或同一组里出现两次）⇒ 这里报「重复」。测试对着
 * `RUN_TOOL_LOOP_OPTION_NAMES` 跑它，于是白名单与 schema 不可能各改各的。
 *
 * #498 S4a 把它从「两向」改成「三向」：容器从 1 个（`config`）变成 2 个（+ `capabilities`），
 * 且 `capabilities.hooks` 里的每个回调都必须在能力面名单里、并且是顶层白名单里的真选项——
 * 于是「往 hooks 加一个回调却忘了分类」「hooks 里的名字根本不存在」两种漂移都红。
 *
 * #517 把它改成**单向**（纯语义重构，零行为变更）：恒等式说的是「**每个顶层选项 → 恰好一个家**」，
 * 不是「每个配置叶子 ⇔ 一个顶层键」。所以：
 *   · **仍然红**：未分类的顶层键、同一个键落在两个面、容器漏登记、能力面叶子不是真选项、
 *     别名表里的死条目（登记了但叶子不存在）、同一组里两个叶子映射到同一个键；
 *   · **新变成绿**：一个 `config` 叶子映射到的顶层键不在 `optionNames` 里。这正是 S3 删完
 *     顶层扁平配置键之后 `config.run.maxRounds` 这类叶子的形状——以前它会报
 *     `config.run.maxRounds maps to "maxRounds", which is not a top-level option`，于是「改闸口」
 *     与「删键」被迫塞进同一刀（#498 S4c 已为这个付过一次返工）。
 * 放行的那一半由**另一条锁**兜住：`config` 的每个叶子都必须被 round-trip 覆盖名单取到值
 * （`test/loop-capabilities-namespace-498.test.js` S7：逐叶子核，与叶子有没有顶层键无关）——
 * 「删了顶层键」不会顺手造出一个没人摸过的叶子。
 *
 * @param {readonly string[]} optionNames 顶层选项白名单（`RUN_TOOL_LOOP_OPTION_NAMES`）
 * @param {{leafAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>}} [overrides]
 *   Self-check hook (#498 S4b review): lets a test inject a leaf-alias table so the "an alias must
 *   not rename onto an existing leaf name" branch is reachable. Production callers omit it and get
 *   the real `CONFIG_LEAF_ALIASES`; nothing else in the check is injectable.
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function configSchemaSelfCheck(optionNames, { leafAliases = CONFIG_LEAF_ALIASES } = {}) {
  const problems = [];
  // #517：配置面 = 「叶子映射到的键」∩「白名单里真有的键」。单向化就发生在这一行：失去顶层键的
  // 叶子只是不在这里出现，不会变成一条问题。
  const configPlaneNames = configPlaneOptionNames(optionNames);
  const configPlaneSet = new Set(configPlaneNames);
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
    if (TOP_LEVEL_SURFACE_OPTION_SET.has(name)) {
      problems.push(
        `${JSON.stringify(name)} is both a config surface key and a permanent top-level surface option`
        + " (the third station: a key cannot have a config home and no nested home at the same time)",
      );
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
  // Every **flat** `capabilities.hooks` callback must be on the capability list (otherwise "added a
  // callback and forgot to classify it" would be silent). #498 S4c: the last four callbacks are
  // **nested-slot** leaves (no top-level flat alias); not being on this list is by design, not an
  // omission — the reverse check is `capabilitiesSchemaSelfCheck`'s "a slotted leaf must not be a
  // top-level option".
  for (const hook of CAPABILITY_HOOK_NAMES) {
    if (CAPABILITIES_SLOT_LEAF_NAMES.includes(hook)) continue;
    if (!CAPABILITY_OPTION_SET.has(hook)) {
      problems.push(`capabilities.hooks names ${JSON.stringify(hook)}, which is not on the capability list`);
    }
  }
  // #498 S4b：能力面那一半的自检（每组的形状校验器存在、叶子是真选项、别名表与 schema 对得上）。
  // #498 S3：嵌套槽叶子的「壳必须存在」不再等于「壳是顶层选项」——`ports.sleepImpl` 的壳是
  // `retry`，它本刀搬去了 `config.timing.retry`（展开相仍写回 `effectiveOptions.retry`）。
  // 所以把「这个名字还解析得到引擎会读的东西」的定义交给调用方：顶层选项 ∪ 仍在 schema 里的
  // 配置叶子。判据的**意图**（去向不许指向一个不存在的键）一字未变。
  problems.push(...capabilitiesSchemaSelfCheck(optionNames, {
    shellIsKnown: (name) => optionNames.includes(name) || configPathForOption(name) !== undefined,
  }));
  // #517：这里**不再**逐叶子核「映射到的顶层键必须真在名单里」——一个配置叶子可以没有顶层键
  // （S3 的形状），那不是漂移。反过来两个叶子不得映射到同一个键（否则展开时一个静默盖掉另一个），
  // 这一条由上面 `seen` 那一轮对 `CONFIG_SURFACE_OPTION_NAMES` 的重复检测负责，与白名单无关。
  // 别名表自己的完整性：一条路径一个叶子（同一组里把同一个叶子写两遍会让 `CONFIG_ALIAS_PATHS`
  // 静默去重，别名表就不再是 schema 的逐字投影）。
  const leafCount = CONFIG_NAMESPACE_GROUPS.reduce(
    (total, group) => total + CONFIG_NAMESPACE_SCHEMA[group].length,
    0,
  );
  if (CONFIG_ALIAS_PATHS.size !== leafCount) {
    problems.push(
      `config alias table has ${CONFIG_ALIAS_PATHS.size} paths`
      + ` for ${leafCount} schema leaves (a leaf name appears twice in a group)`,
    );
  }
  for (const group of Object.keys(leafAliases)) {
    if (!CONFIG_GROUP_SET.has(group)) {
      problems.push(`leaf alias table names unknown group ${JSON.stringify(group)}`);
    }
    for (const [leaf, option] of Object.entries(leafAliases[group])) {
      // #517：死条目 = 登记了别名、但那个**叶子**不存在。注意核的是叶子而不是「别名指向的顶层键」
      // ——后者在 S3 之后会合法地消失（`input.messages` 的扁平孪生 `initialMessages` 就在删除名单里）。
      if (!CONFIG_NAMESPACE_SCHEMA[group]?.includes(leaf)) {
        problems.push(`leaf alias ${group}.${leaf} is not a leaf of that group`);
      }
      if (CONFIG_NAMESPACE_SCHEMA[group]?.includes(option)) {
        problems.push(`leaf alias ${group}.${leaf} renames to ${option}, which is already a leaf name`);
      }
    }
  }
  const unclassified = new Set();
  for (const name of optionNames) {
    if (NAMESPACE_CONTAINER_OPTION_SET.has(name)) continue;
    if (!configPlaneSet.has(name) && !CAPABILITY_OPTION_SET.has(name)
      && !TOP_LEVEL_SURFACE_OPTION_SET.has(name)) {
      problems.push(
        `top-level option ${JSON.stringify(name)} is classified nowhere`
        + " (config surface / capability list / top-level surface)",
      );
      unclassified.add(name);
    }
  }
  // #527: the third station is verified in **both directions**, so it cannot degrade into a copied
  // expectation list. Every entry must be a real top-level option with **no** nested home; every
  // top-level option with no nested home must be an entry (completeness). `tools` is the reason this
  // table exists: it used to have `config.input.tools`, and removing that leaf is what moves it here.
  const topLevelSeen = new Set();
  for (const name of TOP_LEVEL_SURFACE_OPTION_NAMES) {
    if (topLevelSeen.has(name)) problems.push(`top-level surface list repeats ${JSON.stringify(name)}`);
    topLevelSeen.add(name);
    if (!optionNames.includes(name)) {
      problems.push(`top-level surface names ${JSON.stringify(name)}, which is not a top-level option`);
    }
    if (configPathForOption(name) !== undefined) {
      problems.push(
        `${JSON.stringify(name)} is on the top-level surface list but still has a config home`
        + ` (config.${configPathForOption(name)})`,
      );
    }
    if (capabilitiesPathForOption(name) !== undefined) {
      problems.push(
        `${JSON.stringify(name)} is on the top-level surface list but still has a capability home`
        + ` (capabilities.${capabilitiesPathForOption(name)})`,
      );
    }
  }
  for (const name of optionNames) {
    if (NAMESPACE_CONTAINER_OPTION_SET.has(name)) continue;
    if (unclassified.has(name)) continue;
    if (configPathForOption(name) !== undefined) continue;
    if (capabilitiesPathForOption(name) !== undefined) continue;
    if (!TOP_LEVEL_SURFACE_OPTION_SET.has(name)) {
      problems.push(
        `top-level option ${JSON.stringify(name)} has no nested home but is not on the top-level surface list`
        + " (the third station must name every permanent top-level option)",
      );
    }
  }
  for (const container of NAMESPACE_CONTAINER_OPTION_NAMES) {
    if (!optionNames.includes(container)) {
      problems.push(`top-level options do not accept ${JSON.stringify(container)} (a namespace container)`);
    }
  }
  // #517：这一轮只核**能力面**（能力面叶子必须是真选项）。配置面叶子不再在这里被核——
  // 它可以没有顶层键；`configPlaneNames` 已经把它从「配置面」这一项里掉了出去，于是
  // 上面「classified nowhere」也不会误报它。
  for (const name of CAPABILITY_OPTION_NAMES) {
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
    // #527: a permanent top-level option written at the top of `config` (`config.tools`) is not a
    // namespace at all. Point at the third station instead of enumerating config groups, which would
    // send the host looking for a group that does not exist.
    if (TOP_LEVEL_SURFACE_OPTION_SET.has(group)) {
      problems.push(
        `config.${group}: ${JSON.stringify(group)} is a permanent top-level option`
        + ` (the third station) — write it at the top level as ${group}: …)`,
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
        problems.push(`unknown config.${group} option: ${JSON.stringify(leaf)}${misplacedLeafHint(group, leaf)}`);
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
 * The destination tail for an unknown config leaf: it may be a leaf of another config group, or a
 * capability member (#498 S4c).
 *
 * Writing it one level too high (`config.folding.onBeforeFold` / `config.timing.sleepImpl`) is the
 * most common slip, so a leaf that has a capability home should not just answer "unknown leaf +
 * accepted list".
 *
 * @param {string} group
 * @param {string} leaf
 * @returns {string}
 */
function misplacedLeafHint(group, leaf) {
  const configHome = configPathForOption(leaf);
  if (configHome !== undefined) return ` (${JSON.stringify(leaf)} belongs to config.${configHome})`;
  const capabilityHome = capabilitiesPathForOption(leaf);
  if (capabilityHome !== undefined) return ` (${JSON.stringify(leaf)} belongs to capabilities.${capabilityHome})`;
  // #527: the closed door. After the leaf is removed, `config.input.tools` must be rejected as an
  // **unknown leaf**, and the text must say where the value really lives — the third station, at the
  // top level — not merely enumerate the leaves the group still accepts (that would read as "tools
  // is gone", which is false).
  if (TOP_LEVEL_SURFACE_OPTION_SET.has(leaf)) {
    return ` (${JSON.stringify(leaf)} is a permanent top-level option — the third station —`
      + ` write it at the top level: ${leaf}: …)`;
  }
  return ` (accepted: ${CONFIG_NAMESPACE_SCHEMA[group].join(", ")})`;
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
 * The one message for a function value: name the **full path**, the reason (round-trip) and the
 * **canonical home**.
 *
 * The home has three tiers, because three kinds of function have different destinations (#498 S4c
 * rewrote the third tier from "point vaguely in a direction" to **naming the real destination** — the
 * old wording, `the matching capability port slot`, pointed at a place that did not exist yet, so a
 * host that followed the hint changed the value and still had nowhere to put it):
 *   · host callbacks / deliverables checks / port implementations (the name is on the capability
 *     schema, including the #498 S4c nested-slot leaves) ⇒ `its canonical home is
 *     capabilities.<group>.<leaf>` (spelled out: `capabilities.hooks.onRound` /
 *     `capabilities.checks.deliverables` / `capabilities.ports.sleepImpl`);
 *   · a **data key** of the config surface (`tools` and friends) ⇒ it is supposed to be plain data and
 *     has nowhere else to go, so the message is `there is no capability home for it: …` (never
 *     "its canonical home is none", which does not read). Since #498 S3 A8 it also says outright
 *     that **the engine never called the function** — the value is only forwarded (into the tool
 *     context / judge brief), so a host must not read the rejection as "a capability was lost";
 *   · everything else (the leaf name itself is not on the capability schema, e.g. `provider` inside
 *     `judge.provider`) ⇒ the **full path** is matched against `CAPABILITY_SLOT_DESTINATIONS` by
 *     longest prefix (`timing.retry.sleepImpl` → `ports.sleepImpl`, `run.reflection.judge.provider` →
 *     `ports.judgeProvider`) ⇒ still names `capabilities.ports.<slot>`; when nothing matches it
 *     enumerates the three port slots that really exist instead of inventing slot names.
 *
 * @param {string} path
 * @returns {string}
 */
function functionValueProblemMessage(path) {
  const leaf = path.replace(/\[\d+\]$/u, "").split(".").at(-1) ?? "";
  const capabilityPath = capabilitiesPathForOption(leaf) ?? capabilityPathForConfigPath(path);
  const home = capabilityPath !== undefined
    ? `its canonical home is capabilities.${capabilityPath}`
    : CONFIG_SURFACE_OPTION_SET.has(leaf)
      ? `there is no capability home for it: ${JSON.stringify(leaf)} is a data key of the config namespace`
        + " — the engine never calls it, it only forwards the value — so pass plain data"
        + " (host callbacks belong under capabilities.hooks.<name>)"
      : "its canonical home is capabilities (capabilities.hooks.<name> for a host callback,"
        + " capabilities.ports.<slot> for a port implementation — the accepted slots are"
        + ` ${capabilityPortSlotLabels()})`;
  return `${path} is not accepted: ${JSON.stringify(leaf)} is a function, and the config namespace`
    + " holds data only (the config subtree must survive a JSON round-trip unchanged)"
    + ` — ${home}`;
}

/**
 * Map a **config-side** function path back to the capability slot it really belongs to (#498 S4c).
 *
 * When the leaf name itself is not on the capability schema (`config.run.reflection.judge.provider`
 * has the leaf `provider` — a top-level capability key, but there is no `provider` *leaf* on the
 * capability schema), only the **full path** can locate it: each destination in
 * `CAPABILITY_SLOT_DESTINATIONS` (`["reflection", "judge", "provider"]`) is turned into a config path
 * (`run.reflection.judge.provider`) and matched by longest prefix, so a function one level deeper such
 * as `config.folding.context.strategy.compact` still lands on `ports.strategy`.
 *
 * @param {string} path shaped like `config.folding.context.onBeforeFold`
 * @returns {string|undefined}
 */
function capabilityPathForConfigPath(path) {
  const relative = path.startsWith("config.") ? path.slice("config.".length) : path;
  let best;
  for (const [capabilityPath, destination] of Object.entries(CAPABILITY_SLOT_DESTINATIONS)) {
    const [shell, ...rest] = destination.path;
    const configPath = configPathForOption(shell);
    if (configPath === undefined) continue;
    const prefix = `${configPath}.${rest.join(".")}`;
    if (relative !== prefix && !relative.startsWith(`${prefix}.`)) continue;
    if (best === undefined || prefix.length > best.prefix.length) best = { prefix, capabilityPath };
  }
  return best?.capabilityPath;
}

/** The port-slot enumeration used in error text (schema order, so text and schema cannot disagree). */
function capabilityPortSlotLabels() {
  return CAPABILITIES_NAMESPACE_SCHEMA.ports.join(", ");
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
 * Expansion rules (each one is a criterion of this slice):
 *   · `config.<group>.<leaf>` is written back to its flat top-level key (the leaf goes through
 *     `CONFIG_LEAF_ALIASES` first, so `input.messages` → `initialMessages`); downstream still sees a
 *     flat representation, which is why #496's semantic phase judges config values the same way;
 *   · a leaf's `undefined` means "not given" (the existing `value !== undefined` merge rule);
 *   · `config` itself disappears from the result.
 *
 * **The "flat vs config" branch was removed (issue #545)** and replaced by an internal invariant: the
 * flat twin must have **no** value before a leaf is written back. Who can still reach that assertion?
 * **Nobody** — all three sources are closed one by one:
 *   ① call-level explicit options: the name gate (`assertRunToolLoopOptionNames`) only admits
 *      `RUN_TOOL_LOOP_OPTION_NAMES`, and after S3 **no config leaf is left on the allowlist**
 *      (`configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES)` is empty; a test pins it);
 *   ② the assembly port's `policy`: since #545 it takes **data only** and translates every leaf name
 *      into `config.<path>` (`translatedPolicyConfigLeaves`), so the merged tree it produces holds no
 *      flat config key at all;
 *   ③ port-derived keys (`provider` / `tools` / `session` / `onEvent` …): third station or capability
 *      plane — not one of them is a config leaf.
 * So "one knob, two spellings" cannot occur in the **merged representation** any more, and this is not
 * "unreachable code that the gates call green": it is an invariant with teeth — a future option source
 * that skips its name gate throws here and names the leaf, instead of silently letting `config` win
 * (which is exactly what happened before #497).
 *
 * Returns a new object; the input is not mutated.
 *
 * @param {Record<string, any>} options the merged option representation (may carry `config`)
 * @param {{via?: "assembly"|"direct"}} [route]
 * @returns {{
 *   options: Record<string, any>,
 *   conflicts: Array<{path: string, key: string}>,
 * }} `conflicts` is always empty on this side (there is nothing left to report here — see the
 *   invariant above); the field stays because callers destructure `{ options, conflicts }` and the
 *   `capabilities` side has the same shape.
 */
export function expandConfigNamespace(options, route = {}) {
  const config = options.config;
  if (config === undefined) return { options, conflicts: [] };
  assertConfigNamespace(config, route);
  const expanded = { ...options };
  delete expanded.config;
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    const bag = /** @type {Record<string, any>|undefined} */ (config[group]);
    if (bag === undefined) continue;
    for (const [leaf, value] of Object.entries(bag)) {
      if (value === undefined) continue;
      const key = configOptionNameForLeaf(group, leaf);
      if (expanded[key] !== undefined) {
        // Internal invariant (#545), not a user-facing rejection: no entry route can produce a flat
        // config key any more (see the JSDoc above). Reaching this means a new option source skipped
        // its name gate — fail loudly instead of letting `config` win in silence.
        throw tagValidationRoute(
          new TypeError(
            `internal invariant: config.${group}.${leaf} has a flat twin ${JSON.stringify(key)} in the`
            + " merged option tree, but no entry route emits flat config keys (issue #545)."
            + " A new option source is bypassing its name gate.",
          ),
          route.via,
        );
      }
      expanded[key] = value;
    }
  }
  return { options: expanded, conflicts: [] };
}
