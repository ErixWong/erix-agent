# 宿主消费者契约

> 英文版：[host-consumer-contract.md](host-consumer-contract.md)
> 同步基线：host-consumer-contract.md @ 2026-10-16（已同步 #307 「统一入口 `parseModelJson`」（三态失败可分 / 失败不带 value / 无 repair / topOnly 两档 / requireKeys 是 any-of 键存在性 / 四处迁移裁决表）与 #305 「Reflection 决策解析」；#220 「成功返回的四种顶层形态」（readFile/edit→string、writeFile→number、searchText→{content,metadata} 逐个钉 typeof，加 `classifyFileToolResult` 判别式与 default:assertNever 用法）；#282 「终局前的增值调用在中止时的行为」（aborted 永远优先于 judge_done / final_guard_*：已中止则跳过整次 judge 调用、judge 在飞时立即中断、judge 已返回但终局未定也必须抛 aborted 并保留 #180 载荷）；#283 「中止后事实的真相分布」（β 裁决：不为被中止的进行中轮补写 RoundRecord；`partial:true` 只指终局载荷不指 transcript；六行渠道对照表）；#179 HTTP 状态码分类（`invalid_request`/`not_found`/`conflict` 三个新 code 与取值表、`retryable` 与重试面逐字不变、未列出的状态码仍落 `unknown`）；#197 技能加载器注册（`bundledDir` 归调用方、库内不猜层级、内置 < 全局 < 项目的优先级、不阻塞且可枚举的 `{skillId, dir, error}` 失败形状、产出即 `ToolSchema`、无新沙箱）与 `skillsLoaderContract` 套件；#184 文件工具注册（`allowRead`/`allowWrite` 谓词与「false → 错误结果而不抛」属 Stable、marker 字面量属 Experimental → #188 三层分级；追加轮 A：`rg` 默认翻回**正则**与真实命令一致、`is_regex=false` = `rg --fixed-strings`/`grep -F`、不读 `.gitignore` 与硬编码 vendor 跳过的偏离声明）；#165 judge 记录关联字段与 run 级 outcome 汇总事件；#167 压缩策略选择（`context.strategy` 名字|对象、fold-llm 默认 summarizer 的成本与 usage 记账）；#170 终止裁决决策表；#182 模型元数据与预算推导 + 多模型槽位装配示例与一次性 `model_metadata_missing` 诊断事件；#181 provider 请求注入口 defaultHeaders/extraBody；#173 观察者回调抛错统一隔离；#183 重试预算（`retry` 默认 false / 两条独立循环 / 不覆盖清单 / 可断言观测点）与契约测试套件定位（漂移哨兵≠宿主一致性测试、标准注入用法、套件清单）；#157 appendUserTurn 成对可选快路径探针；0.16.0 宿主保真、同轮保序契约与升级指南指针）

本文定义 `erix-agent` 的宿主集成边界。引擎维护可审计的运行事实；工具权限、归档策略、
重试/重跑策略以及最终消费决策归宿主。责任边界见
[ADR-012](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/012-engine-truth-model-efficiency-host-policy.md) 与
[ADR-013](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/013-guard-charter.md)。0.6.0 迁移步骤见
[host-upgrade-guide-0.6.0.md](host-upgrade-guide-0.6.0.md)；0.12.0 notes 契约迁移步骤见
[host-upgrade-guide-0.12.0.md](host-upgrade-guide-0.12.0.md)；0.16.0 store 保真、同轮保序与
展示投影增量变更的迁移步骤见
[host-upgrade-guide-0.16.0.md](host-upgrade-guide-0.16.0.md)。

## `runToolLoop` 选项与工具执行契约

`runToolLoop` 只接受以下顶层选项键。陌生键抛 `TypeError`，不再被静默忽略。宿主的私有
元数据必须放进显式命名空间，例如 `toolContext` 或 `context`。

```text
assemblyPort, provider, system, wrapup, initialUserMessage, initialMessages, tools,
writeToolNames, writeToolPathKeys, executeTool, maxRounds, maxTokens,
temperature, topP, timeoutMs, deadlineMs, reflection, stallDetection, retry,
completion, finalGuard, finalGuardMaxRetries, finalGuardTimeoutMs,
maxTokenContinuations, toolResultTtl, toolResultFoldMinTokens, context,
todoStateProvider, semanticStateProvider, partialPersistence,
modelConfig, modelMetadata, model, expert, user, task, session, requestId,
toolContext, store, persistence, runId, cwd, deliverables, invalidArguments, resume, onRound, onJudge,
onToolResult, onPersistenceError, diagnostics, onObserverError, signal, stream,
onDelta, onReasoningDelta, onToolCall, onUsage, onEvent, onFoldSummary, finalGuardExtend, config
```

`partialPersistence` 默认为 `false`，保持既有的流式零写入行为。设为
`{ intervalMs, minBytes? }` 可启用按间隔节流的部分 assistant 文本快照。它复用既有的
latest-only `saveRunSnapshot` capability，不引入新的 store 方法；缺该 capability 时
不发生部分写入。恢复时，较新快照中形状完好的 `partialText`/`partialRound` 会被作为
assistant 文本消费，而不带这些字段的旧快照保持既有行为。设了 `minBytes` 时，比它小的
单个 delta 不会触发写入；当间隔损失界限必须作用于每一个到来的 delta 时就不要传它。
前提：设 `stream: true`，否则启动即抛。

`executeTool` 边界只有一种调用形态，不做 arity 协商：

```js
executeTool({ id, name, input, context, signal })
```

规范的执行结果只有三种形态：

- `string`
- `{ content, metadata?, success? }`
- `Error`

旧的 `{ data, success, ... }` 形态与其他鸭子类型形态为兼容起见仍被宽松归一化，但已废弃，
不得依赖。

### 选项校验发生在哪里（issue #496）

选项校验是**规范化表示的性质**，不是宿主恰好调了哪条入口路线的性质。两相共用同一份规则来源：

- **预检相** —— 对象形状 + 顶层名称白名单，在**任何宿主端口被读取之前**跑
  （`assertRunToolLoopOptionNames`（`src/loop/option-normalization.js`））。所以未知顶层键仍然早于
  `assemblyPortOptions`、早于 `modelConfig.resolve`、早于能力缺失检查抛出。
- **语义相** —— 取值与回调形状规则，跑在**合并后**的表示上：`assertSemanticOptionValues`（`src/assembly-validators.js`）
  在显式选项覆盖完 assembled 值之后被调用，而 `createAssemblyPort`
  对它的 `policy` 调的是**同一个函数**。规则本体住在 `collectSemanticOptionProblems`（`src/assembly-validators.js`）：
  一个条件、一句文案，没有按路线抄的第二份。

于是两条路线抛的是**同一个 `TypeError`、同一句文案**，唯一差别是错误对象上的自有属性 `via`：
装配口形态是 `"assembly"`，细粒度 `runToolLoop` 选项是 `"direct"`。这些文案**不带**
`did you mean` 后缀（那个后缀只属于顶层名称白名单）。

语义相只管这几条：`context` 给了就必须是对象（省略或 `null` = 没配）；`context` 里**拼错的摘要
旋钮名**抛；旋钮取值必须是正安全整数；每个承载宿主回调的字段给了就必须是函数——`finalGuard`、
`retry.sleepImpl`、`reflection.onReflection`、`diagnostics.error`、`onFoldSummary`（顶层）、
`context.onBeforeFold`、`context.onAfterFold`。有两族**刻意留在原地**：
`deliverables[].check` 由 `normalizeDeliverables`（`src/loop/deliverables.js`）校，其余取值规则
（`maxRounds` / `partialPersistence` / `persistence` …）是 `runToolLoop` 自己的启动校验——它们本来就
对每条路线都跑，因为两条路线都汇到那里。

回调字段只有一条口径：**省略 = 不订阅**；`null` 与其余非函数值一律 = 给了但给错 ⇒ 启动即抛。
**唯一例外**是 `context: null`，它逐字等于省略 `context`——理由不是宽容，而是引擎在那里的读取本来
就对 `undefined` 与 `null` 完全相同，把它改成抛错只会破坏「把可空字段原样传下去」的宿主，买不到
任何性质。顶层回调**刻意不给**这条例外：`finalGuard: null` / `retry.sleepImpl: null` /
`onFoldSummary: null` 一律抛。口径统一优先于少一类半破坏，而「`null` 钩子悄悄等于没钩子」正是本
版要喊出来的那类静默配置。

`context` 里的宿主元数据键（既不是引擎读的键、也不是拼错的旋钮名）照旧**放行**——它们绝不抛。
两条路线在这里**只差这一处**可观察事实：装配口路线通过一条 `context_unknown_option` 事件如实报出，
直连路线则**从不发这条事件**（装配口是它唯一的发射点），所以静默放行。这**不是**说直连没有观察者通道——
`onEvent` 在那条路线上是一等选项，实测能收到 `round_start` / `attempt` / `usage` / `round_end` /
`run_outcome`（见「九个宿主回调观察一个 run」那一节）。到的只是**这一条**事件而已；在直连侧等它的宿主会
永远等不到——这是路线的性质，不是校验的性质。

`unknown assembly policy context option: …` 这句是**历史措辞**：宿主在按这个串做匹配，所以逐字保留。
直连路线上并不存在 `policy` 这回事——它留在这里只因为改名会打断宿主既有的字符串匹配。

旋钮家族判据本身（与已知旋钮名的编辑距离 ≤ 2）一字未改，但它的**爆炸半径变了**：以前只有装配口
宿主吃它，现在**所有** `runToolLoop` 宿主都吃。实测边界——`summarizerBudget` / `summarizerTimeout` /
`maxSummaryToken` 会被判成手滑而抛；`summaryStyle` / `summarizerNote` / `maxSummaryChars` 照旧放行。

0.27.0 里需要知道的行为变化：`context` 下拼错的摘要旋钮名、以及上面任一回调字段里的非函数值，以前在
细粒度路线上是**静默忽略**（run 直接用默认值跑）。现在两者都启动即抛。把这些回调接出配置树的能力面
**不在** 0.27.0 里——它在 0.28.0 落地（issue #498），在那之前现有位置照旧工作。

### config 命名空间（issue #497）

一次 run 的配置从此有第二种写法。`config` 是一棵**嵌套命名空间**，它的叶子是顶层扁平键的别名，
而别名**就是** schema 路径：`config.run.maxRounds` 与扁平的 `maxRounds` 是同一个旋钮，叶子名
永远逐字等于扁平选项名。这里没有重命名表：唯一手写的部分只有一张 schema
`CONFIG_NAMESPACE_SCHEMA`（`src/loop/config-namespace.js`），别名表 `CONFIG_ALIAS_PATHS`
（`src/loop/config-namespace.js`）与配置面名单 `CONFIG_SURFACE_OPTION_NAMES`
（`src/loop/config-namespace.js`）都从它派生，再由 `configSchemaSelfCheck`
（`src/loop/config-namespace.js`）对着顶层白名单核账：每个顶层选项必须**恰好**被归入
*配置面*（52 键）或*能力面*（13 键）之一，而 `config` 自己是那个容器。

| 命名空间 | 旋钮 |
| --- | --- |
| `config.prompt` | `system`、`cacheStablePrefix`、`initialUserMessage`、`initialMessages`、`wrapup` |
| `config.run` | `maxRounds`、`maxTokenContinuations`、`stallDetection`、`completion`、`replayPolicy`、`invalidArguments`、`partialPersistence`、`persistence`、`outputHygiene`、`writeToolNames`、`writeToolPathKeys`、`resume`、`stream`、`reflection`、`runId`、`cwd` |
| `config.tuning` | `maxTokens`、`temperature`、`topP`、`cacheCapable` |
| `config.timing` | `timeoutMs`、`deadlineMs`、`retry` |
| `config.folding` | `context`、`toolResultTtl`、`toolResultFoldMinTokens` |
| `config.guard` | `finalGuard`、`finalGuardMaxRetries`、`finalGuardTimeoutMs`、`finalGuardExtend`、`deliverables` |
| `config.metadata` | `expert`、`user`、`task`、`requestId`、`toolContext`、`model`、`modelMetadata`、`session` |
| `config.observers` | `onRound`、`onJudge`、`onToolResult`、`onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage`、`onFoldSummary` |

它由五条规则管着：

- **优先级** —— 同一个旋钮两种写法都给时，`config.*` 赢。扁平键继续被接受，且只要它是唯一写法，
  行为与今天逐字相同。叶子设成 `undefined` 逐字等于「没给」（与扁平合并用的是同一条规则），
  所以它既不覆盖扁平值、也不算冲突。
- **冲突不静默** —— 两种写法都给了**不同的值**时，引擎在第一轮之前发一条
  `config_override_conflict` 事件：`{ type: "config_override_conflict", runId?, conflicts: [{ path, key }], detail }`。
  载荷只带路径与键名（值可能是函数或大对象）。这条事件上的观察者抛错与其他观察者通道同口径被隔离——
  经 `onObserverError` 记账，run 继续跑。
  **同一条事件也管第二对来源**（issue #497 复审 R4）：装配口的 `policy.config` 与调用级 `config`
  是**同一棵树**的两种来源，而调用级那份按**整棵**覆盖（既有「后写者胜」的合并规则，一字未改）。
  这次覆盖逐叶上报，用的就是同一条事件、同一套字段：两个源里**同一个叶子都给了不同的值**时，
  该叶子在 `conflicts` 里出现一次（`{ path, key }`，按 path 去重，顺序 = 分组顺序 + 组内声明顺序）。
  值相同、或只有一边给了值的叶子都不算冲突——同时注意整棵覆盖的另一面：只写在**被覆盖的那棵树**
  里的叶子会被**丢掉**（回到默认值），别把两个源当逐叶合并用。修之前实测：policy 写
  `run.maxRounds: 4`、调用级写 `1` ⇒ 只跑 **1** 轮、**零**事件。
- **结构等价** —— 同一份配置写成扁平与写成 `config`，规范化后的 `effectiveOptions` 逐键相同。
  展开发生在**合并后**的表示上（装配口已折进来之后、语义相之前），所以 `config` 里的值走的是与
  扁平孪生完全相同的那套校验：`config.folding.context` 里拼错的摘要旋钮名抛的是与扁平 `context`
  同一句，`config.guard.finalGuard` 必须是函数的原因与 `finalGuard` 必须是函数完全一样。
- **能力键一律拒绝** —— `CAPABILITY_OPTION_NAMES`（`src/loop/config-namespace.js`）里的 13 项能力
  选项不是配置：`provider`、`tools`、`executeTool`、`store`、`modelConfig`、`assemblyPort`、
  `signal`、`todoStateProvider`、`semanticStateProvider`、`onEvent`、
  `onObserverError`、`onPersistenceError`、`diagnostics`。把它们写进 `config`（顶层或组内）⇒
  启动即抛并点名该键，错误带着与其他闸口相同的 `via` 标签（`"direct"` / `"assembly"`）。
  **这条收窄只作用于新命名空间**：既有优先级规则——显式细粒度选项覆盖装配口提供的同名成员
  （`resolveAssemblyMember`（`src/assembly.js`），例如显式 `provider` 仍能盖端口 provider）——
  一字未动，`test/contract/assembly-port.js` 照旧断言它（「显式细粒度 provider 覆盖端口 provider」）。

  **这条线画在哪里（issue #497 复审 R1，判据是行为面）：** 能力面 = 宿主递进来的**行为载体**——
  引擎**调用或解引用**的函数与端口对象（端口方法被调、信号被监听、回调被投递）。配置面 = 引擎
  **按已知字段校值并解释**的数据——枚举字面量、数字、布尔、字符串标量、结构已知的对象。所以有
  四个键从能力面移到了配置面（写进 `config` 会被接受并真的生效）：`persistence`
  （`config.run.persistence`；`"none"` / `"required"` 字面量被校验并决定持久化路径——`"required"`
  会打开 transcript store 的方法校验）、`model` / `modelMetadata`（`config.metadata.*`；
  `contextWindowTokens` / `maxOutputTokens` 两个数字被 `modelMetadataFor`（`src/loop/budget.js`）
  读去推压缩预算与「15% 窗口」的输出上限）、`session`（`config.metadata.session`；`id` 被校验、
  `modelSlot` 被交给 `modelConfig.resolve`、`resume` / `initialMessages` 被读）。旧判据
  「能力面 = 引擎不解释其值」对这四个键**实测为假**。

  **`runId` / `cwd` 也是配置**（issue #497 复审第二轮——上一轮给判据加的那条「身份/环境注入」腿
  **取消**），所以它们是 `config.run.runId` / `config.run.cwd`；顶层扁平键一字未动（这是新增别名，
  不是迁移）。两条理由：
  1. 判据的价值在于**机械可检验**：能力面 = 被调用/被解引用的行为载体，配置面 = 被校值并解释的
     数据。为两个键单开一条例外，判据就退化成「先分好类、再补理由」——谁来分类都能自证。
  2. 更强的正向理由：0.28 的可检验目标是「`config` 子树必须过 JSON round-trip 等值」。`runId` /
     `cwd` 是**字符串标量、天然 JSON 安全**，而能力面应当只剩函数/端口对象。把它们留在能力面，
     那条 0.28 判据就得反过来开例外——一条要豁免两个字符串键的 round-trip 规则已经不算规则。
- **形状与名称** —— `config` 本身必须是对象（`null`、数组、字符串都抛）；未知分组、未知叶子、
  把扁平键写在 `config` 顶层（`config.maxRounds` 会被回一句「写 `config.run.maxRounds`」）、
  以及把叶子写错组（`config.run.temperature` 会指向 `config.tuning.temperature`）都在
  **任何宿主端口被读取之前**抛，并把该层接受的名字按 schema 枚举出来。

`config` 从不进引擎：展开会把它删掉，所以 `effectiveOptions`——以及 `normalizeRunToolLoopOptions`
（`src/loop/option-normalization.js`）返回的 `explicitOptions`——里只剩扁平键。装配口的 `policy`
同样接受 `config`，于是两条入口路线共用这一次展开（`via` 标签负责说明是哪条路线抛的）。

过渡口径：新宿主只用 `config`。顶层扁平键是**原语 / 过渡面**——继续接受、继续校验、继续有文档——
但行进方向是一面。删除窗口属 #495 的发布阶梯，**计划在 0.28**（是计划，不是本版给出的承诺）；
0.27.0 一个扁平键都不删。

### 工具引数解析不了的时候（issue #409）

每一次工具调用都带着一段模型自己写的引数。引擎分两层解析它，且**从不发明值**。L0 是对原文的
一次朴素 `JSON.parse`；失败才进 L1，跑 `REPAIR_RULES`（`src/text/repair-json.js`）那张确定性规则表：
剥代码围栏、单引号串与裸键、非法转义按**反斜杠加倍**（`\.` → `\\.`）变合法、Python 字面量
`True`/`False`/`None`、尾逗号。截断补全也在这张表里，但**默认关**：它是唯一会补出模型没写过的
结构的规则，而实测语料（110 份 transcript / 312 条真实终答）里截断类需求 = 0 条——默认关的依据是
**零需求**，不是「有风险」。

让这一层可以默认开的是那条不变量：**修复产出的每一个字符串值，必须仍是原始文本里逐字存在的一段。**
改了值字节的规则会被机器判为不合格，而不是靠品味裁量。被否掉的那种做法就是 `jsonrepair` 处理
非法转义的方式：`{"api":"http\.request"}` 会被修成值 `http.request`，而它在原文里再也找不到，
任何逐字闸门都会把它整条丢掉。加倍则让值逐字等于原文，同时让文本变得可解析。

`parseJsonWithRepair`（`src/text/repair-json.js`）是工具路径用的「先 L0 再 L1」入口，
`parseToolArguments`（`src/messages/tool-arguments.js`）是 OpenAI 非流式转换、OpenAI 流式累加器、
Anthropic 流式组装**三处共用**的那一份，所以两条协议在这里不可能各长一套。严格入口一字未动：
`parseModelJson` 仍然不做任何 repair（见它自己那一节）——修复只存在于工具引数这条路上。

修完仍然解析不出来时，默认行为（`invalidArguments: "reject"`，白名单成员见
`RUN_TOOL_LOOP_OPTION_NAMES`（`src/loop/option-normalization.js`））是**根本不执行这个工具**。引擎返回一条 `is_error` 的
`tool_result`，正文由 `describeToolArgumentsParseError`（`src/messages/tool-arguments.js`）拼出来：
解析器原话、**从 1 开始数的**字符位置与它附近的一小段原文、以及按该工具自己的 `inputSchema` 渲染的
正确形状示例。后面那句指示是「只改参数写法、重发同一次调用」——不换工具，也不凭猜测补内容。这条结果带
`erix.executionStatus: "rejected"`；因为调用从未执行，它不带 `erix.round`、不带 `erix.durationMs`、
也不带 `erix.success`（与 judge 拦截同一套存在性口径）。`tool_use` 块上另带
`erix.argumentsParseError`（`{reason, message, position?, text}`，additive 可选键，永不上 wire），
于是宿主不必去解析 `content` 就能分清「模型把 JSON 写坏了」与「工具自己失败了」。这次调用不重试、
也不额外花一次模型调用：模型下一轮拿到判词，自己把参数改对。

`invalidArguments: "execute"` 逐字节恢复 #409 之前的行为：坏 payload 照旧以
`{_truncatedArguments, _raw}` 交到 `executeTool`，工具照跑，模型看到的是那个工具自己报的二次错误
（典型的是「缺必填字段」）而不是解析判词。这两半——交给执行器的假对象、以及回来的那条二次错误——
都由 `deepEqual` 用例钉住。

## 观察者回调抛错（issue #173）

宿主共有九个回调在观察一个 run：八个事件通道 `onEvent`、`onRound`、`onToolResult`、
`onJudge`、`onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage`，加上错账户本身
（`onObserverError`）。**其中任何一个抛错，都是「记一笔、继续跑」**——后果只有一种。
改动之前同一类故障有三种后果：`onEvent`、`onRound`、`onToolResult` 抛错会以
`termination.reason: "failed"` 杀掉整个 run，流式通道经 `onObserverError` 上报，而
`onJudge` 消失在一个裸 `catch {}` 里。

```text
观察者同步抛错，或返回 rejected Promise（onRound / onToolResult）
  └─ reportObserverError(error, { channel, … })   src/loop/orchestrator.js:892-899
       ├─ onObserverError(error, context)         宿主错账户，同步调用
       └─ console.error("Observer callback error:", error, context)
                                                  未配置错账户、或错账户自己抛错时
```

1. **run 继续跑。** 任何观察者错误都改变不了 `termination.reason`、返回结果与已落盘的
   内容。`onRound` 抛错时该轮已经 `appendRound` 落库，后续轮照跑；`onToolResult` 抛错时
   工具结果照常送给模型；`onEvent` 抛错后引擎继续发事件（事件流不再在第一次宿主失败处
   断裂）。仍能终结 run 的只有引擎自己的路径：见「终止裁决决策表（issue #170）」。
2. **每一笔上报都报出自己的通道。** `onObserverError(error, context)` 收到的是一个普通
   对象，恒带 `channel`——即回调名，引擎若未给出则为 `"unknown"`；宿主传了 `runId` 选项时
   恒带 `runId`，因此并行跑多个 run 的宿主能把错误归因到具体 run。下表列出每个通道额外的
   字段全集，均为 additive 字段，宿主不得要求更多：

| `context.channel` | 额外字段 | 引擎防护点 |
|---|---|---|
| `onEvent` | `type`，事件自带 `round` 时再带 `round` | `emitEvent`（`src/loop/orchestrator.js`） |
| `onEvent`（启动期诊断） | `type: "model_metadata_missing"`，或 `type: "persistence_capability_degraded"` 加 `method` | `notifyCapabilitySkipped` / `notifyModelMetadataMissing` 里的本地防护（`src/loop/orchestrator.js`）：这两条路径在 `emitEvent` 定义之前就触发，因此直调 `onEvent` |
| `onRound` | `round` | `src/loop/orchestrator.js` |
| `onToolResult` | `toolName`、`round` | `src/loop/run-snapshot-executor.js:266-294` |
| `onJudge` | `round`、`kind` | `emitJudge`（`src/loop/orchestrator.js`） |
| `onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage` | `round`、`type`（流式事件类型） | `dispatchAttemptEvent`（`src/loop/provider-runner.js`） |

   启动期诊断事件即使宿主抛错也保持「每个 run 恰好一条」的去重承诺：去重标记在回调之前
   就已置位。
3. **观察者错误是 best-effort，且不在任何其他账上。** 它们永不进入
   `result.unpersisted`，不产生 `delivery_failure` 条目，也不写进 run state。要计数就
   由宿主自己在 `onObserverError` 侧累计；持久化的观察者错误计量另立课题（issue #173
   已定边界：按现状接受）。
4. **错账户自己不要抛。** `onObserverError` 抛错时引擎先打
   `Observer error reporter failed:`，随后回落到
   `console.error("Observer callback error:", error, context)`。两种情况 run 都不受影响。
   没配错账户时 console 那一行就是唯一信号，所以生产宿主必须自己配一个并计数。
5. **抛错不是宿主停机的手段。** 请用 `signal.abort()`：循环随即抛出标准的 `aborted`
   形状，并携带 issue #180 载荷（`error.usage` / `error.rounds` / `error.finalText`）。
   原先靠「sink 抛错」终止 run 的宿主必须迁移到 abort 信号——现在抛错只会上报。
6. **回调必须同步返回。** 只有 `onRound` 与 `onToolResult` 是被 await 的，因此也只有这两
   条通道同时隔离 rejected Promise 与同步 throw。`onEvent`、`onJudge` 与四条流式通道只接
   同步 throw：`async` 回调稍后 reject 的 Promise 会以 unhandled rejection 逃到宿主侧。
   请保持回调同步，或在回调内部自己把异步包起来。
7. **`onToolResult` 是数据改写钩子，不是纯观察者。** 它的返回值会**替换**工具结果（返回
   `undefined` 才保留引擎结果），所以它失败时有数据后果：异常 fallback 是
   **原样保留的引擎执行结果**——绝不是部分改写、也不是空结果——外加一条带 `toolName` 与
   `round` 的 `channel: "onToolResult"` 上报。在这个 hook 里做脱敏、裁剪、格式改写的宿主
   必须自己防住自己的逻辑：脱敏函数一抛错，送给模型的就是未脱敏的引擎原始结果。

这条通道只覆盖上述回调。`executeTool` 的错误会变成工具结果，`onPersistenceError` 与
`diagnostics.error` 走持久化账本与 `delivery_failure`（见「持久化失败上报」），
`finalGuard` 以 `verification.status: "error"` 呈现，`reflection.onReflection` 与压缩钩子
`onBeforeFold` / `onAfterFold` 的未捕获抛错仍会抵达 `fail()`，`todoStateProvider` 与
`semanticStateProvider` 则以 `status: "error"` 的 run-state 片段呈现。别把观察者隔离
外推到这些回调上。

## Provider 请求注入口（issue #181）

`createOpenAIProvider` 与 `createAnthropicProvider` 新增两个完全可选的选项，让宿主无需
包装 `fetchImpl` 就能给自己的请求打上归因标识（会话级 / run 级）：

```js
const provider = createOpenAIProvider({
  endpoint, apiKey, model,
  defaultHeaders: { "X-Station-Run-Id": runId, "X-Station-Session-Id": sessionId },
  extraBody: { user: `${fde}:${sessionId}` },
});
await provider.chat({ messages });
```

- `defaultHeaders` 是**追加**到引擎自有请求头之后，引擎头的值与顺序保持不变。引擎头
  不可被覆盖：宿主传入与 OpenAI 侧 `Authorization` / `Content-Type` 或 Anthropic 侧
  `x-api-key` / `anthropic-version` / `content-type` 同名（大小写不敏感）的键时，在
  **构造时**抛 `TypeError`，而不是静默忽略。值为 `undefined` / `null` 的键跳过（供宿主
  条件注入）；其余值必须是字符串、数字或布尔，且不得包含 CR、LF、NUL。
- **header 值不得进入错误文案与日志。** 该注入口新增的每一条文案只写 header 名字，不写
  值 —— 与 `apiKey` 脱敏同口径，因为宿主会把网关 key 放进 header。
- `extraBody` 在引擎组装**之后**合并进 JSON 请求体，因此引擎自有字段永远优先，宿主无法
  悄悄改掉 `stream` 或 `model`。保留字段为 `model`、`messages`、`system`、`tools`、
  `max_tokens`、`temperature`、`top_p`、`stream`、`stream_options`、`frequency_penalty`、
  `presence_penalty`、`response_format`；宿主传保留字段一律丢弃，与引擎当次请求已写入的
  字段同名（例如经 `providerOptions` 带进来的）同样丢弃。
- 每一个被丢弃的字段都会通过 `console.warn` 向 stderr 告警，只带字段名（不带值），且每个
  provider 实例每个字段只说一次：保留字段在构造时告警，逐请求冲突在首次出现时告警。
- 两个注入口都在构造时取**顶层**快照：事后改宿主自己的对象不会改变线上行为；但
  **`extraBody` 里的嵌套对象仍按引用共享**——需要稳定的值请自行深拷贝/冻结。宿主本来就是按 run
  构造 provider，这也正是设计粒度。
- 两个参数都不传时，发出的请求头与请求体与之前版本**逐字节一致**。`providerOptions` 仍是
  payload 逃生口，对核心字段依旧**静默**丢弃；`extraBody` 是会告警的那条通道。

预算元数据是另一份契约：模型 slot 能携带哪些字段、按什么顺序被探测、loop 何时发出一次性的
`model_metadata_missing` 诊断事件，全部在下文「模型元数据与预算推导（issue #182）」里定义
（issue #182）。

## HTTP 状态码分类（issue #179）

非 2xx 的 provider 响应会变成由 `classifyHttpError`
（`src/providers/errors.js:105-129`）造出的 `KitError`，包根把它再导出
（`src/index.js:2`）。它的 `code` 是宿主可见的，并且会经 `termination.errorCode`
第二次抵达宿主（issue #176，见下文「终局载荷」）。映射如下：

| HTTP 状态码 | `KitError.code` | `retryable` |
|---|---|---|
| 408 | `timeout` | `true` |
| 429 | `rate_limited` | `true` |
| 401 / 403 | `auth` | `false` |
| 500-599 | `server` | `true` |
| 400 / 422 | `invalid_request` | `false` |
| 404 | `not_found` | `false` |
| 409 | `conflict` | `false` |
| 其余任意状态码，或没有状态码 | `unknown` | `false` |

本节的契约就两条：

- **只有 `code` 这个字符串变宽了。** `invalid_request`、`not_found`、`conflict`
  是新增取值（issue #179：取值面扩展 = semver minor）；在此之前 400 / 404 / 409 /
  422 一律报 `unknown`。任何状态码的 `retryable` 都没动——这四个原本就不可重试、
  现在仍不可重试——`KitError` 既没加字段也没删字段，上表既有的每一行原样未动，
  因此重试路径依旧只重发 `retryable === true` 那一组（见下文「重试预算（issue #183）」）。
- **`"unknown"` 没有变成死值。** 表里没写到的状态码——402、405、410、413、415、
  418、499、600，或压根没有 status——继续落 `unknown`，所以宿主的 `unknown` 分支
  依然存在，只是不再兜住那四个状态码。按 `code === "unknown"`（或
  `termination.errorCode === "unknown"`）来表达「请求不合法 / 模型名写错」的宿主，
  必须把那条分支扩到这三个新 code；一条把未分类一律当 `unknown` 的 `default`
  分支无需改动。

500-599 那一行是数值区间比较，所以会强转进该区间的非数字 `status`（例如字符串
`"500"`）仍落 `server`；其余每一行都按严格相等匹配。传输层事实本身与分类是两件事：
`error.status` 始终保留原始数字，想要数字而不是类别的宿主该读它。

## 重试预算（issue #183）

**不配置就是不重试。** `retry` 默认 `false`（`resolvedModelConfig`，`src/loop/orchestrator.js`），在该状态下
引擎每轮**恰好**发一次 provider 调用、每次 store 调用**恰好**写一次。想要重试的宿主必须显式
要求；没要求的宿主不得假设一次 provider 调用会被重发。本节就是完整规则集；它的终局一面是
下文「终止裁决决策表（issue #170）」里的 `failed` 行。

### 派生值

只有**对象**才会打开重试：`retryOptions = retry && typeof retry === "object" ? retry : null`
（`runStateAvailability`，`src/loop/orchestrator.js`），所以 `retry: true` **不是**「启用重试」——它与完全不写
该选项完全等价。

| 输入 | 生效值 | 推导 |
|---|---|---|
| `retry` 缺省 / `false` / `true` | `retryAttempts = 0`，完全没有重试路径 | `:713-715` |
| `retry: {}` | `retryAttempts = 2` → 每轮最多 3 次 provider 调用 | `Number.isInteger(attempts) ? Math.max(0, attempts) : 2`（`:714-718`） |
| `retry: { attempts: n }` | **整数** `n` 取 `Math.max(0, n)` | `:716-717` |
| `retry: { attempts: 2.5 }` / `{ attempts: "2" }` | 静默变 `2` —— 非整数值被丢弃，从不校验 | `:716`，回落 `:718` |
| `retry: { attempts: -1 }` | `0`（夹取，不报错） | `:717` |
| `retry.backoffBaseMs` | 缺省或非有限值时 `1500`；负数夹到 `0` | `:719-721` |
| `retry.backoffMaxMs` | 缺省或非有限值时 `10000`；负数夹到 `0` | `:722-724` |
| `retry.sleepImpl` | `defaultSleep`（`src/loop/abort.js:16`）；宿主传值按 `sleepImpl(delay, signal)` 调用 | `:725`、`:885`、`:1636-1641` |

第 *n* 次重试（0 起始）前的等待在两条循环里都是
`Math.min(backoffBaseMs * 2 ** n, backoffMaxMs)`
（`src/loop/provider-runner.js:246-249`、`src/loop/orchestrator.js`）。睡眠是
可中断的：run 的 signal 会传给 `sleepImpl` 并被 `waitForRetry` 竞争
（`forcedFinal`，`src/loop/orchestrator.js`），因此在退避等待期间 `signal.abort()` 抛出的是
标准的 `aborted` 形状，携带 issue #180 的载荷。

只有被标为 `retryable === true` 的错误才会被重试
（`src/loop/provider-runner.js:219`）。该集合是 `KitError.code` ∈ `timeout`、
`rate_limited`、`server`、`disconnect`（`src/providers/errors.js:1,14-16`），经
`classifyHttpError` 得知的 HTTP 408/429/5xx（`:105-129`），经 `classifyFetchException`
得知的可重试传输失败（`:166-198`，由 `isRetryableNetworkException` `:148-157` 判定），
以及一条既无文本、也无工具调用、也无推理的 assistant 消息
（`src/messages/canonical.js:448-454`）。其余一切 —— `auth`、`aborted`、
`invalid_request`/`not_found`/`conflict` 这三个 4xx 分类（issue #179）、选项校验抛的
`TypeError`、宿主 store 的 bug —— 首次见到就原样重抛。

### 一个选项，两条独立循环

同样三个数字喂给两条**计数器相互独立**的循环。它们不会相乘，宿主不得把它们建模成一个
全局尝试预算：

| 循环 | 坐标 | 门槛 | 预算 |
|---|---|---|---|
| 每轮 provider 调用 | `src/loop/provider-runner.js:33-263`（`callProvider`） | `retryOptions !== null` **且** `error.retryable === true`（`:219`） | **每轮** `retryAttempts + 1` 次 provider 调用；一个 run 因此封顶于 `maxRounds × (retryAttempts + 1)` |
| 持久化 store 写入 | `src/loop/orchestrator.js:875-891` | 同一组数字，**没有** `retryable` 门槛 | **每次 store 调用** `retryAttempts + 1` 次写入，与 provider 循环无关 |

持久化重试绝不会重发 provider 调用，provider 重试也绝不会重写记录。
`retry: { attempts: 0 }` 与 `retry: false` 在观测上等价：一次 provider 调用、一次 store
写入、没有 `recovering` 事件，且 `attempt` 事件上 `maxAttempts: 1`。

### 这条预算不覆盖什么

不要把它外推到引擎其余部分：

- **工具从不重试。** 失败的 `executeTool` 变成一条 `is_error` 的 `tool_result`；要不要
  重跑是宿主的决定（见「工具重放策略（issue #139）」，那一节说的是 resume，不是重试）。
- **轮外补全各只有一次尝试**：收尾调用（`src/loop/termination.js:234`）、收尾/`judge`
  文本归一化器（`normalizeWrapupWithLlm`，`src/reflection/wrapup.js`）、以及 `fold-llm` 默认 summarizer
  （`finalPersistence`，`src/loop/orchestrator.js`）。它们都不消耗本预算。
- **run 本身从不重试。** 整 run 重跑/重排队策略属于宿主（ADR-012），而
  `maxTokenContinuations`（默认 `3`）与 `finalGuardMaxRetries` 是另外的预算：前者续写被
  `max_tokens` 截断的响应，后者重新询问终答 guard。两者都不是错误重试预算，也不受
  `retry` 影响。

### 流式：同一份预算，一处需要知道的行为变化

**不存在第二个流重试计数器**。对 `stream: true` 的 run 而言，上面那条循环*就是*流恢复：
`recovering` / `recovered` 是它的事件面，失败的尝试会先回滚到尝试前快照，再重新请求
整个补全（`src/loop/provider-runner.js:224-243`）。

- `DEFAULT_STREAM_RECOVERY_MAX_ATTEMPTS` **不是本包里的标识符**（grep 证真）。被当作它的
  值引用的那个 `2`，其实是 `src/loop/orchestrator.js` 的 `retryAttempts` 回落值。
  CLI 自己的那个 `2` 来自 `ERIX_RETRY_ATTEMPTS`（`bin/cli.js`），CLI 把它作为
  `retry: { attempts: … }` 传下；**库**默认仍是 `false`，所以「把 CLI 行为抄进宿主」正是
  这个数字被误归因的方式。
- `partialPersistence` 是持久性而非重试：它提交一个将死尝试的部分文本
  （`onPartialAttemptEnd({ retrying: true })`，`roundEventDeltas`，`src/loop/orchestrator.js`），
  不额外增加任何尝试。
- **值得在你自己的测试里断言的一个副作用：**当 `retryAttempts > 0` 时，流式观察者回调会
  按尝试缓存，只在该尝试成功后才-次派发
  （`src/loop/provider-runner.js:111-117`，在 `:192-194` 冲刷），于是
  `onDelta`/`onReasoningDelta`/`onToolCall`/`onUsage` 是在尝试末尾一次到达而非逐段到达。
  `retry: false`（或 `attempts: 0`）时它们逐段到达
  （`src/loop/provider-runner.js:112-115`）。因此启用重试会改变你的渲染节奏；这是上游
  行为，不是宿主 bug。

### 宿主可断言的观测点

| 想钉住什么 | 可断言的通道 |
|---|---|
| 每轮 provider 尝试数 | `attempt` 事件 `{ type, round, attempt, maxAttempts }`（`src/loop/provider-runner.js:86-91`）；`maxAttempts === retryAttempts + 1`，所以宿主无需知道选项值就能断言这个上限 |
| 重试真的发生了 | `recovering` 事件（`src/loop/provider-runner.js:252-258`）；`recovered` 标记重试后成功的那一次（`:188-191`、`:203-206`） |
| 退避时序，且不付墙钟代价 | 注入 `retry.sleepImpl` 并记录每一个 `delay` —— 条数就是实际发生的重试次数，记录到的值能钉死 `min(base × 2ⁿ, max)` 公式 |
| 没有 N×M 的 provider 放大 | 你自己的 provider 包装的请求计数器，对着 `attempt` 事件对、也对着 `maxRounds × (retryAttempts + 1)` 断言 |
| store 写入重试 | **不存在逐尝试事件。** 唯一信号是两条循环走完后的终局 `persistence_error` 上报（`reportObserverError`，`src/loop/orchestrator.js`）；包上你自己的 store 方法计数，这是目前唯一能证明 store 侧循环跑过的办法 |

遗留（issue #183）：运行结果不携带聚合的尝试/重试计数，因此每 run 总量得宿主自己从事件
里拼。今天**不承诺**可持久化的重试计数器；请把 `attempt` / `recovering` / `recovered` 与
`retry.sleepImpl` 当作受支持的观测点全集。

### 静默是一条可重试的截止——前提是有人把它接上（issue #441）

引擎自带**静默截止**：`firstByteTimeoutMs`、`streamIdleTimeoutMs`、`streamTotalTimeoutMs`、
`requestTimeoutMs`。到点抛的是 `KitError("timeout", …, { retryable: true })`
（`src/providers/timeout.js`），而 `timeout` 在 `RETRYABLE_CODES` 里
（`src/providers/errors.js`）——也就是说「provider 静默」本来就该落到上面那条重试循环上，
而不是硬杀。但 0.24.0 之前**没有任何 CLI 代码传过这四个键**（`grep -rn 'firstByteTimeoutMs' bin/`
零命中，CLI 的配置白名单也不收），于是能终结一次静默 run 的只剩 CLI 的 idle 看门狗——而它 abort 的是
run 的 `AbortSignal`，那条路**不可重试**。本节记录的就是这个结构性失效的修法。

CLI 现在在**一处**从 `--idle-timeout` 派生**其中两个**（解析器在 `bin/provider-timeouts.js`，
`bin/cli.js` 与 `bin/repl.js` 用的是同一份）：

| `--idle-timeout` | 传给 provider 的东西 |
|---|---|
| `0`（`erix repl` 默认） | **不派生任何东西**——与 0.24.0 之前的装配逐字一致：只有 legacy `timeoutMs` 那条截止。配置文件里显式写的相位键照旧透传（那时语义归引擎的相位模型） |
| `N > 0`（`erix chat` 默认 `300`） | `firstByteTimeoutMs` = `streamIdleTimeoutMs` = `⌊N × 3/4⌋` ms，除非用户显式配了那一个键。`requestTimeoutMs` **不派生**：非流式那条截止保持 legacy（`config.timeout ?? 300_000`） |

四条规则，按顺序：

1. **静默预算严格小于 idle 窗口。** 相等是缺陷而不是偏好：一次静默请求里两条截止同时起跑，
   而 idle 的起点**更早**（provider 调用之前就武装了）⇒ `截止 === idle` 永远解成不可重试的 abort。
   留出的四分之一是重试需要的空间——退避（`backoffBaseMs = 1500`，第二次 `3000`）加下一次尝试。
2. **`requestTimeoutMs` 故意不派生**——非流式路径保持它的 legacy 截止（`config.timeout ?? 300_000`）。
   那条路径上 `requestTimeoutMs` 量的是**整段生成**、不是静默（`provider.chat()` 只有一条绝对截止），
   把它派生成 `⌊idle × 3/4⌋` 等于把默认配置下 `[⌊idle × 3/4⌋, idle)` = `[225s, 300s)` 这条带从
   **活的**变成**必死**：真 HTTP 上游、`ERIX_RETRY_ATTEMPTS=2` 实测，**240s** 后才回的请求在接线前是
   **240.29s / `end_turn` / 退码 4**，接线后变成 **225.21s 被杀 / `failed` / `errorCode: "timeout"`**。
   要让非流式**静默**可重试，截止必须**严格小于** idle 窗口，而 idle 与 legacy `timeout` 默认**都是
   `300`** ⇒ 任何收缩都会杀掉这条带。非流式静默的正解是「判死后重试」（issue #433 fix 1，见下一节），
   不是提前掐死：CLI 现在会在看门狗命中后退避、从 transcript 续跑同一个 run，只有预算用尽才以
   `idle_timeout` 收尾（那条路上每次尝试 1 发，引擎侧不重试）。
3. **`streamTotalTimeoutMs` 不派生。** 它是单条流的**绝对上限**，不是静默截止；而流在吐字节时 idle
   会被 `onDelta` 喂表、本来就不会响——拿 idle 窗口派生它，只会把「长但健康」的输出变成一次
   注定重蹈覆辙的重试。引擎默认值（`300000`）保留。显式 legacy `timeout` **会**作为
   `streamTotalTimeoutMs` 透传：相位模型一开，legacy 那条绝对截止就失效
   （`src/providers/payload.js` 的 `hasExplicitPhase`），不透传等于把用户要的天花板悄悄降下来。
4. **显式相位配置优先、不被隐式改写**：相位值 ≥ idle 窗口时原样使用，只打一行警告——那种静默
   仍可能被不可重试的 idle 路径收尾。这四个键还会在**加载时校验**：
   不是「`>= 0` 的安全整数」（`-1000`、`"abc"`、`true`、`1.5`）就报错并**点名该键**，而不是以
   `undefined` 的身份进引擎——在那里它要么意味着「这个相位的截止悄悄不存在」（流式），要么意味着
   「请求立刻超时、上游 0 发」（非流式）。`0` 合法，意思是「已经到点」。
   legacy `timeout` / `timeoutMs` **不在**这条校验面内——它照旧原样透传，所以非数值会一路进 `setTimeout`，
   行为等同「已经到点」；加载期校验只覆盖这四个相位键，因为是本次改动让它们变成承重的。
   （注意：CLI 的 `exec` 天花板自 issue #433 fix 4 起走**另一条**规则——显式 `ERIX_EXEC_TIMEOUT_MS`
   会被**收敛**成 `min(exec, idle − 60s)` 并打一条 loud 日志；理由只对命令超时成立，见
   「工具执行不是静默，`exec` 也不能长过 idle 窗口」。）

两个宿主可观测的后果：

- 静默的 **`--stream`** run 在重试用尽后终局是 `termination.reason: "failed"` +
  `termination.errorCode: "timeout"`，不再是 `reason: "aborted"` 且没有 `errorCode`。这**不是**
  契约扩展：`failed` 本来就带 `errorCode`（issue #176），也没有任何别的 reason 因此新增该字段。
  把 `aborted` 当「静默被杀」判断的宿主，对流式 run 要改判 `failed` + `errorCode: "timeout"`；
  **非流式静默在截止面没有变化**，仍以 `idle_timeout` 收尾（在 CLI 的重试预算用尽之后，issue #433
  fix 1）——issue #440 之后那个错误保留引擎的终局载荷（见「CLI 的 idle 判死保留载荷」）。
- CLI 用 `attempt` 与 `recovering` 事件喂 idle 表，所以一次重试（含它的退避）算**进展**而不是
  「无进展」。不喂的话 idle 窗口会把退避切断，静默又回到 abort 那条路。

这条预算保证的是「**单次尝试**的静默截止先于 idle 看门狗响」；它**不**把重试的**退避**塞进 idle
窗口。`--idle-timeout` **小于或等于**退避序列（`backoffBaseMs = 1500`，之后 `3000`、`6000`……上限
`backoffMaxMs = 10000`）时，退避期仍可能被不可重试的 idle 路径收尾——与本次改动之前完全一样；
实测 `--idle-timeout 3` 时第二次退避恰好 `3000ms`、**等于**窗口：2 发 / 9.21s / `aborted`。
默认值（`300`）下不会发生。

## AssemblyPort

装配完整 run 的宿主可以只提供一个经过校验的组合根，而不必重复逐项接线：

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider
  provider,    // Provider
  tools: { definitions, executeTool, getToolMetadata? },
  store?,      // 可选 TranscriptStore
  session: { id, resume?, initialMessages? },
  policy?,     // 显式 run 选项
  emit?,       // (eventType, payload) => void
});

await runToolLoop({ assemblyPort });
```

传给 `createAssemblyPort` 时，`modelConfig`、`provider`、`tools`、`store`、`session`
和 `policy` 也可以是同步的零参工厂。启动时必须具备 `modelConfig.resolve`、
`provider.chat` 或 `provider.chatStream`、`tools.definitions`、`tools.executeTool`、
`session.id`。若提供 `store`，它必须具备两个必需方法 `appendRound` 与 `load`；
缺必需方法在 run 开始前抛 `TypeError`。`policy` 只装具名的 `runToolLoop` 选项；
陌生 policy 键会被拒绝。

### TranscriptStore capability 分级（issue #78）

原 "checkpoint" 表面更名为 **run snapshot** 并降级为可选 capability。实际语义从来就是
latest-only 自动保存（每轮覆盖同一槽位、仅用于中断恢复现场），从来不是多版本 checkpoint。
分级如下：

| 分级 | 方法 | 缺失时行为 |
| --- | --- | --- |
| 必需 | `appendRound`、`load` | assembly/startup 抛 `TypeError` |
| 可选 run snapshot | `saveRunSnapshot`、`loadLatestRunSnapshot` | 跳过快照持久化；run 正常跑完，仅不支持中途 crash resume |
| 可选 run-state | `saveRunState`、`loadRunState`、`markRunState` | 跳过 run-state 持久化；run 正常跑完 |
| 宿主面向的可选终态读取 | `loadRunStateStatus` | 引擎不调用、不校验；缺失不会发出 capability 降级事件 |
| 可选预写快路径探针（issue #157） | `loadByDedupKey`、`loadMaxRound` | `appendUserTurn` 回退全量 `load`（成对生效：只实现其一等同全不实现） |

`loadRunStateStatus` 解析为终态**字符串**——`(runId: string) => Promise<string | undefined>`，
该 run 未记录终态时返回 `undefined`——不是状态记录对象（与 `src/store/memory.js` /
`src/store/file.js` 的源 typedef 一致）。

可选方法缺失时，引擎对每个缺失方法只发**一条**
`persistence_capability_degraded` 事件（`{type, runId, method, detail}`），
随后整轮 run 跳过对应持久化——不每轮刷屏。`getToolMetadata` 与 `emit` 仍是可选项。

### 工具重放策略（issue #139）

工具 schema 可以在每个规范 `tools` 定义上声明 `replay: "safe" | "unsafe"`；省略即
`unsafe`，其他取值在启动时被拒绝。该声明是引擎元数据，不会发送给模型。run snapshot
会把解析后的声明持久化到每个 `pendingToolUses` 条目上，因此恢复时使用发起该工具调用
时记录下来的意图。

`replayPolicy` 默认为 `"always-replay"`，无论声明如何都保持既有的续跑行为。选择
`"per-tool-declaration"` 则只重放被记录为 `safe` 的条目。unsafe 条目（包括没有
`replay` 字段的旧快照）不会被执行；模型会收到一条 `tool_result`，带
`executionStatus: "interrupted"`、`is_error: true`，外加解释说明以及 run snapshot 中
可用的已捕获输出。引擎发出可选的 `tool_replay_decision_required` 事件，带 run/tool 的
ID 与 `requiresHostDecision: true`。任何后续处置决策归宿主；引擎不会调度或重试该工具。

出厂工具针对这条规则**实际标了什么**，以及宿主切到 `"per-tool-declaration"` 的接线清单，
记在本节末尾的「出厂工具的 replay 标注现状与切换清单（issue #139）」。

`saveRunState`/`loadRunState` 管理每个 run 的单份 latest-only 结构化快照，不保留版本历史。
新写入的快照不再持久化 `state` 键；`markRunState` 通过独立通道写终态。宿主需要读取终态时，
应使用可选的 `loadRunStateStatus`（返回终态字符串，`Promise<string | undefined>`；形状见上方
说明）。引擎不会调用或校验这个宿主面向的方法。该方法优先读取独立
status，再回落读取旧 `.state.json` 数据内嵌的 `state`。`loadRunState` 对旧快照对象仍原样透传，
包括其中的 `state` 键。仅当 status 文件不存在时才回落；status JSON 损坏或解析后没有字符串
`status` 时会抛错，不会回落到可能过期的旧值。

**迁移指引。** 将宿主的 `loadRunState(runId).state` 改为 `loadRunStateStatus(runId)`；继续用
`loadRunState` 读取 `stateVersion`、`deterministic`、`semantic` 等快照字段。旧的内嵌终态仍可读取，
但新写入的快照不再带 `state`。

**更名与合并。** `saveCheckpoint` → `saveRunSnapshot`，
`loadLatestCheckpoint` → `loadLatestRunSnapshot`。`appendCheckpoint` **并入
`saveRunSnapshot`**：两者本来就是同一语义的 latest-only 覆盖写，单独保留 "append"
只会误导出"有版本"的错觉。file store 的快照落盘文件改为 `<runId>.snapshot.json`
（原 `<runId>.checkpoint.json`）；读取时新后缀不存在则回落旧后缀（读取兼容，不做数据迁移）。

**过渡期别名（deprecated）。** 库内 store 仍保留
`saveCheckpoint` / `appendCheckpoint` / `loadLatestCheckpoint`，标记 `@deprecated`
并内部委托新方法。只实现旧名的第三方 store 继续可用：引擎按
`saveRunSnapshot` → `saveCheckpoint` → `appendCheckpoint` 解析快照写入，
`loadLatestRunSnapshot` → `loadLatestCheckpoint` 解析快照读取。宿主应迁移到新名；
未来 major 版本可能移除别名。

**已知重复（已决策，未移除）。** 最新 run-state 被双写：既内嵌在每轮
round record（`RoundRecord.runState`）里，又经独立 run-state 方法
（`saveRunState`/`markRunState`）落盘。两份拷贝都是承重的，所以 issue #82 选择保留而非删除
其中一份——权威规则、以及被拒绝/推迟的备选见
[ADR-019](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/019-run-state-store-authority.md)。
独立 run-state（`saveRunState`/`loadRunState`）是 latest-only 权威状态；随 transcript
保存的 `RoundRecord.runState` 属于 history 侧的每轮快照。引擎恢复时优先采用有效的独立 state；
仅当独立 state 不存在时才回落到最新 record；若独立 state 存在但无效，则报告
`state_unavailable`，且不回落。

`modelConfig` 始终是 resolver 形态的 `ModelConfigProvider`——即便它是随 `assemblyPort`
一起显式提供的覆盖项。plain 配置对象会被拒绝并给出迁移提示，请用
`createModelConfigResolver(config)`（或 `createStaticModelConfigProvider(config)`）包装。

既有的细粒度 `runToolLoop` 选项继续受支持。两种形式同时存在时，先解析 AssemblyPort，
显式提供的细粒度选项覆盖对应的装配值。这样端口留在组合边界上，不包裹也不改动循环的注入
契约。若提供了 `emit`，它作为默认事件 sink；显式 `onEvent` 仍然优先。
`erix-agent/contract-tests` 的 `assemblyPortContract` 锁定这些启动与优先级规则。
装配形态的细粒度入口在第一次 provider 调用前执行同等的 provider、executor、
model-config、session 与 required 持久化 fail-fast 校验。`persistence: "none"`
不要求 TranscriptStore。

库内 `createAssemblyPort` 是参考装配实现，不做任何 I/O。CLI 继续使用它自己的文件型
provider、工具与 transcript 适配器，因此没有宿主需要一次性迁移到该端口。

### 出厂工具的 replay 标注现状与切换清单（issue #139）

上一小节是规则。本小节记录**出厂工具今天实际标了什么**——宿主从包外看不见这个，而它
直接决定切换的代价。现状是：**一个都没标**——在 `src/tools` 与 `bin/tools.js` 里搜这个
字段一无所获，唯一读它的两处是启动校验（`partialPersistenceConfig`，`src/loop/orchestrator.js`）与解析器
（`src/loop/orchestrator.js:1890-1902`）。

| 工具 | 出厂入口 | 今天标了 `replay` 吗 | `per-tool-declaration` 下的续跑行为 | 副作用类别 |
| --- | --- | --- | --- | --- |
| `readFile` | `erix-agent/tools` | 没标 | 不重放 → interrupted | 无 |
| `searchText` | 同上 | 没标 | 不重放 → interrupted | 无 |
| `rg` | 同上 | 没标 | 不重放 → interrupted | 无（已弃用别名） |
| `grep` | 同上 | 没标 | 不重放 → interrupted | 无（已弃用别名） |
| `tree` | 同上 | 没标 | 不重放 → interrupted | 无 |
| `edit` | 同上 | 没标 | 不重放 → interrupted | 写文件 |
| `writeFile` | 同上 | 没标 | 不重放 → interrupted | 写文件 |
| `note_read` | 包根与 `erix-agent/tools` | 没标 | 不重放 → interrupted | 无 |
| `note_list` | 同上 | 没标 | 不重放 → interrupted | 无 |
| `note_take` | 同上 | 没标 | 不重放 → interrupted | 写一条笔记记录 |
| `note_forget` | 同上 | 没标 | 不重放 → interrupted | 作废一条笔记记录 |
| `exec` | CLI 装配层，不是发布的 API 入口（issue #194） | 没标 | 不重放 → interrupted | 任意 |
| `todo_list` | CLI 装配层 | 没标 | 不重放 → interrupted | 无 |
| `todo_add` | CLI 装配层 | 没标 | 不重放 → interrupted | 写按工作目录隔离的 todo 文件 |
| `todo_done` | CLI 装配层 | 没标 | 不重放 → interrupted | 写按工作目录隔离的 todo 文件 |
| `todo_clear` | CLI 装配层 | 没标 | 不重放 → interrupted | 写按工作目录隔离的 todo 文件 |
| 技能包工具（工具名由各包自定） | `erix-agent/tools` | 没标——加载器不添加该字段 | 不重放 → interrupted | 取决于包自带的 executor |
| CLI 那个唯一的 MCP 代理工具 | CLI 装配层 | 没标 | 不重放 → interrupted | 取决于被代理的 server 工具 |

**默认取向：没标就是 `unsafe`，而整支出厂工具队都是没标的。**所以不打标注就打开
`"per-tool-declaration"`，等于把**每一次**续跑的**每一个**挂起调用都当成 unsafe——
连纯读类工具也一样回来一条 `interrupted` 错误结果，与 `exec` 完全同形。引擎不做任何
推断：它不看工具名，不看 executor，也不看 `writeToolNames`（该选项只喂 judge 的
filesWritten 计数器，`src/loop/orchestrator.js`）。挂起条目里没记录该字段的旧快照
同样按这个方向解析（`docs/host-upgrade-guide-0.14.0.md`）。

**为什么库一个都不标。**重放声明描述的是 **executor**，不是 schema，而这些工厂发出去的
是 schema：`definitions` 数组是普通对象，宿主可以把它路由给自己选的任何 executor（沙箱化
的读、同时写审计行的 edit、只入队的 writeFile）。把 `safe` 烧进库里等于替别人的 executor
作保，所以标注住在拥有 `executeTool` 的那一方——与 ADR-009 把 `allowRead` / `allowWrite`
作为全部边界面的分工一致。在出厂默认落地之前，**标注是宿主侧的活**，上表的副作用类别
列就是那个将来默认值的形状（只读工具默认 safe，其余 unsafe）。技能包是唯一已经可以由
作者自己标的地方：`buildSkillTools` 将每个包的 tool 条目原样透传
（`src/skills/loader.js:344-348`；它的校验只要求 `name` 与 `inputSchema`，
`src/skills/loader.js:72-100`），所以包自己标了就会被尊重。MCP 桥接是另一个地方——
库内没有 MCP 层（ADR-005），自己接 server 的宿主拿到的是它自己构造的工具条目，就该逐
server、逐工具决定；一个代理工具顶替无数个 executor（CLI 那个 MCP 代理工具正是这个形状）
带不动一句全量判定，那里诚实的答案是 `unsafe`。

**切换清单。**

1. **按你真正接上去的 executor 判定，而不是按工具名。**本地普通读是 `safe` 候选；同一个
   名字被代理到远程沙箱、按次计费、或穿过一个审计 sink 写入就不是。把只读工具标 `safe`
   附带一个语义注意：重放发生在之后，结果反映的是重放时刻的世界状态，不是中止时刻的。
2. **给你传进去的 definitions 打标注。**工厂不代打，且每次调用都返回其 schema 的一份全新
   `structuredClone`，所以改返回值是安全的：

   ```js
   import { createFileTools } from "erix-agent/tools";

   const WRITE_TOOLS = new Set(["edit", "writeFile"]);
   const fileTools = createFileTools({ cwd: process.cwd() });
   const tools = fileTools.definitions.map((definition) => ({
     ...definition,
     replay: WRITE_TOOLS.has(definition.name) ? "unsafe" : "safe",
   }));
   if (tools.find((tool) => tool.name === "readFile").replay !== "safe") {
     throw new Error("replay labelling did not survive the factory clone");
   }
   ```

3. **显式选择，并知道它在哪里生效。**`replayPolicy` 仍默认 `"always-replay"`。传
   `"per-tool-declaration"` 作为 `runToolLoop` 选项，或作为 AssemblyPort `policy` 里的同名
   键（`src/assembly.js` 已列入白名单，`test/contract/assembly-port.test.js:47-53` 断言）。该
   策略**只**在续跑路径上被读取（`guardedMessages`，`src/loop/orchestrator.js`）：`resume: false`，或
   store 不具备 run snapshot 能力时，根本没有挂起队列，该选项是空的。
4. **让新事件类型过白名单。**若宿主按 `type` 字符串集合过滤 `onEvent`，就**必须**加上
   `tool_replay_decision_required`，否则信号会被静默丢弃而其他一切看起来健康：模型
   反正会收到那条 interrupted 的 `tool_result`，run 照旧往下跑，只剩下宿主那一半——
   知道“欠一个处置决定”——消失。引擎对每个被跳过的挂起调用发**一**条，紧跟在其配对的
   `tool_result` 事件**之前**，载荷为
   `{ type, runId, round, toolUseId, toolName, replay: "unsafe", requiresHostDecision: true,
   partialOutputAvailable }`（`src/loop/orchestrator.js`）。README 里那份事件枚举是
   示意（“including …”）而不是白名单，照拄进 `Set` 的宿主需要重新拄一次。
5. **正确读结果形状。**结果带 `is_error: true` 与 `executionStatus: "interrupted"`。如果
   消息里已经存在该调用 id 的 `tool_result` 块，引擎会**原地重写那个块**
   （`isLowBudget`，`src/loop/orchestrator.js`）而不是追加第二条，所以差量比对消息的宿主必须
   预期一处变更而不是新增。`executionStatus` 会进入 display 投影
   （`src/display/projection.js:158-160`），且此后这条 interrupted 结果就是普通的本轮文本：
   只有 `intercepted` 结果被排除在聚合预算计数之外（`src/loop/aggregate-budget.js:150-153`）。
6. **处理部分输出。**`partialOutputAvailable` 说明有没有找到可展示的内容；为 true 时结果
   文本以 `Previously captured partial output:` 段结尾，内容由中止那轮已归档的输出加上
   已经记录过的结果内容去重拼成（`compactionStat`，`src/loop/orchestrator.js`）。
7. **不指望重试，也不指望重新挂起。**被跳过调用的 id **不会**进 `executedToolIds`，引擎
   不调度任何东西，run 带着模型看到的一条错误继续。后续处置——问用户、携带宿主自己的
   指令再续一次、或放弃这次调用——归宿主，而且是一个每个 `toolUseId` 最多只做一次的
   决定。
8. **先把在跑的 run 排干，并校好 store 的保真度。**声明在写快照那一刻被冻结进每个挂起
   条目，所以切换之前写的快照里没有该字段，续跑时一律解析为 unsafe：在跑 run 的每个
   挂起调用（连只读类在内）都会变成一次 interrupted 决定。不把快照未知字段原样带回来的
   store 会丢掉记录下来的意图，解析器于是回落到**当前**的 `tools` 数组
   （`src/loop/orchestrator.js:1890-1902`）；随包发布的 `transcriptStoreContract` 已经会带回
   一条带 `replay: "unsafe"` 的挂起条目并做深比较（`test/contract/transcript-store.js:124-142`），
   所以能跑过该套件的宿主 store 会保留这个字段（另见「Store 保真要求」）。
9. **知道 fail-fast 在哪。**两个字面量以外的 `replay` 取值，以及未知的 `replayPolicy`，都在
   第一次 provider 调用前抛 `TypeError`（`hasExplicitModelConfigOverride`，`src/loop/orchestrator.js` 与 `:583-587`）——
   写错是启动就碎，不是在续跑路径上默默分错类。
10. **声明对模型与事件流都不可见。**该键从 provider 工具清单里被剔掉
    （`hasReplayDeclarations`，`src/loop/orchestrator.js`），并从续跑路径的 `tool_use` 载荷里被删除
    （`guardedMessages`，`src/loop/orchestrator.js`），所以想展示“这个标了 safe”的宿主只能从自己的
    `tools` 数组里读，不能从事件里读。

**尚未锁定。**`docs-drift-check` 没有哪条规则会去读工具源码里该标注的存在与否，所以本表
两个方向都可能默默飘：将来出厂侧真标了，与这一小节必须在同一个 PR 里。

## 模型元数据与预算推导（issue #182）

`modelConfig` 与 `modelMetadata` 是白名单选项名，但它们能携带哪些字段此前契约零字。
其中只有 `contextWindowTokens` 与 `maxOutputTokens` 这一对字段对引擎自己的预算推算
有分量（且必须成对），其余字段全部流向 provider 请求。两个预算字段都不写的宿主，
整个 run 的上下文压缩与单轮聚合输出预算都是关的，唯一的信号就是下文的
`model_metadata_missing` 事件。

### 探测顺序与槽位选择

| 探测位次 | 候选 | 需要装什么 |
|---|---|---|
| 1 | **已解析的** `modelConfig` | `modelConfig.resolve(session?.modelSlot)` 返回的对象——解析器本身从不被探测 |
| 2 | `modelMetadata` | 只承载元数据；没有其他地方读它 |
| 3 | `model` | `model` 选项对象 |
| 4 | `provider` | 两个内置工厂在构造时拿到 `contextWindowTokens` / `maxOutputTokens` 后，会将其回挂在返回的对象上（`src/providers/openai.js:575-584`、`src/providers/anthropic.js:541-550`） |
| 5 | `context` | 压缩上下文选项 |

- 探测按上述固定顺序 duck-type，返回**第一个**携带任一字段的候选
  （`src/loop/budget.js:59-69`，调用点 `notifyModelMetadataMissing`，`src/loop/orchestrator.js`）。
  字段**从不跨候选合并**：slot 里只写 `contextWindowTokens`、`modelMetadata` 里只写
  `maxOutputTokens`，结果是什么预算也推不出来。这一对字段必须写在同一个对象里。
- `modelConfig` 必须是解析器（`{ resolve(slot?) }`）。直接把普通配置对象当
  `modelConfig` 传会在启动期抛 `assembly port is missing methods:
  modelConfig.resolve`——因为这个选项名一出现就被当成端口读
  （`persistenceMode`，`src/loop/orchestrator.js`）。被探测的是**解析后的值**，不是解析器。
- 槽位选择是 per-run 的：槽位名经 `session.modelSlot` 传入
  （`persistenceMode`，`src/loop/orchestrator.js`）。两个内置 provider 对不认识的槽位名都
  回落到 `default` 槽，所以拼错槽位名不会让这个 run 失败。
- `createJsonFileModelConfigProvider` 从 JSON 文件读
  `{ "slots": { "<name>": { … } } }`；`createStaticModelConfigProvider` 接内存里的同构形状。
  两者都是**原样**返回 slot，只额外物化一个 `apiKey`
  （`apiKey` → `apiKeyEnv` → `apiKeyFile`，`src/config/api-key.js:9-36`）。

### 字段契约

| slot 字段 | 单位 | 进 provider 请求 | 驱动预算 / 压缩 | 缺省行为 |
|---|---|---|---|---|
| `contextWindowTokens` | token（正安全整数） | 否 | **是**——预算输入，也决定输出截断上限的尺寸 | 推不出预算 → 压缩与聚合输出预算均关；上限退回 `4096` |
| `maxOutputTokens` | token（≥ 0 的安全整数） | 是，作为 `maxTokens` 缺席时的 `max_tokens` 默认值 | **是**——第二个必需的预算输入 | OpenAI 不写 `max_tokens`；Anthropic 用 `4096`；推不出预算 |
| `maxTokens` | token | 是——请求 `max_tokens`，优先于 `maxOutputTokens` | **否**，从不参与预算 | 字段省略 |
| `temperature` | 数值 | 是——`temperature` | 否 | 字段省略 |
| `topP` | 数值 | 是——`top_p` | 否 | 字段省略 |
| `thinking`、`reasoning`、`reasoning_effort`、`enable_thinking`、`chat_template_kwargs` | 因协议而异 | 是，原样拷进 payload | 否 | 字段省略；推理模型识别关闭 |
| `model_type`、`supports_reasoning`、`thinking_format` | 因协议而异 | 否，但它们会把端点标为推理模型并打开 stream-usage 探针；回挂在 provider 对象上 | 否 | 探针关闭 |
| `frequency_penalty`、`presence_penalty`、`response_format`、`providerOptions` | 因协议而异 | 是（`providerOptions` 里核心字段是**静默**丢弃的，见 #181） | 否 | 字段省略 |
| `timeoutMs`、`requestTimeoutMs`、`firstByteTimeoutMs`、`streamIdleTimeoutMs`、`streamTotalTimeoutMs`（snake_case 别名同样接受） | ms | 请求 / 流超时 | 否 | 引擎默认值 |
| `endpoint`、`apiKey` / `apiKeyEnv` / `apiKeyFile`、`model` / `model_name`、`protocol` | — | 端点与凭据身份；`protocol` 选的是**宿主自己**要构造哪个工厂——引擎从不按它分发 | 否 | endpoint / key / model 解析后为空时，provider 构造抛 `provider_config`（`src/providers/errors.js:37-51`） |

循环自身的 `maxTokens`、`temperature`、`topP` 选项会注入每一次请求，因此**覆盖**
slot 里的同名字段（`src/loop/provider-runner.js:128-130`、`src/providers/openai.js:51-55`）。

**slot 里的未知字段是惰性的，也是安全的。** 内置 provider 原样拷贝 slot
（`src/config/json-file.js:22-39`、`src/config/static.js:26-38`），两个工厂又只读固定的
参数列表（`src/providers/openai.js:110-153`、`src/providers/anthropic.js:290-334`），
所以认不出的键既上不了线，也不会抛错。这条安全声明只覆盖
**slot 对象**：*顶层* `runToolLoop` 选项写错名仍会抛 `TypeError`（见「`runToolLoop`
选项与工具执行契约」）。

### 预算推导

`budgetTokens = context.budgetTokens ?? computeBudget({ contextWindowTokens, maxOutputTokens })`，
其中 `computeBudget = contextWindowTokens - maxOutputTokens - max(2000, ceil(窗口 × 0.1))`
（`persist`，`src/loop/orchestrator.js`、`src/compact/budget.js:9-33`）。
`budgetTokens` 是上下文压缩、单轮聚合输出预算、以及 request-view 预算块的总门。
输出截断上限是另一套推导：先看显式 `outputHygiene.limit`，否则
`clamp(15% × contextWindowTokens, 8192, 100000)`，否则 `4096`
（`persist`，`src/loop/orchestrator.js`）。

| 启动时的条件 | 引擎行为 |
|---|---|
| 五个候选里两个字段都找不到 | **静默跳过**：`budgetTokens` 保持 `undefined`，压缩与聚合输出预算保持关，并且恰好发**一条** `model_metadata_missing` 事件 |
| 字段找到了但值非法（非整数、字符串、窗口 ≤ 0、`maxOutputTokens` < 0）或窗口不够大（算出的预算 ≤ 0） | `computeBudget` 在首次 provider 调用前**抛 `invalid_budget`** |
| 宿主自己给了 `context.budgetTokens` | 完全绕开推导——压缩是否启用只看这个值，且无论探测到什么**都不发**事件；非正 / 非整数值由 `validateBudget` 抛 `invalid_budget` |
| 宿主给了 `context.strategy` | 策略被询问时会原样拿到 `budgetTokens`，所以配了策略就能在零元数据下自己门控压缩（`stateAvailability`，`src/loop/orchestrator.js`）；注意内置 sliding-window 策略也是拿这个值去比，`undefined` 时永不触发（`src/compact/sliding-window.js:34-36`） |

两种 `invalid_budget` 都是**运行前**抛错：运行生命周期尚未开始，抛出的错误不带
`termination`、`usage`、`rounds`、`finalText`（边界见「终局载荷（issue #176 / #180）」
里的范围声明）。

### 压缩策略选择（issue #167）

`context.strategy` 既接受策略**对象**（语义逐字不变），也接受内置**名字**
`"sliding-window" | "fold-statistical" | "fold-llm"`。名字在 **run 启动期一次性**解析成宿主自己
也能构造出的那个实例（`src/compact/strategy-resolution.js`，接入点 `src/loop/orchestrator.js`），
因此下游 configuredStrategy 通道零改动。未知名字、空字符串、以及既不是字符串也不是对象的值，
都会在**首次 provider 调用前**抛 `TypeError` 并列出合法值——与上面同一种「运行前」抛错形状
（不带 `termination`/`usage`/`rounds`/`finalText`）。名字形态的策略还会接上 context 级的
`recoveryHint` 与 `stubFor`；对象形态依旧由宿主自己设在对象上，引擎绝不重写注入的对象——
手工 `createFoldLlmStrategy` 但缺 `summarizer` 时，仍按它自己的构造期 `TypeError` 失败。

`fold-llm` 名字形态会注入一个复用**本 run 主力 provider** 的默认 summarizer
（`src/compact/provider-summarizer.js`）：每次压缩一次无工具补全，输入是
`SUMMARIZER_PROMPT_GUIDE` + 被折叠消息的确定性序列化 + 被折叠轮次范围。成本与记账属于契约：

- **每次压缩多一次主力模型调用**，输入体量约等于被折叠的老轮次。因此 `fold-llm` 只能显式选用；
  默认 everywhere 仍是 `fold-statistical`（库层未配策略时仍为 `sliding-window`）。
- 它的 usage 走与其他辅助调用同一的 `addUsage` 路径并入 run 总账（`persist`，`src/loop/orchestrator.js`，
  `trackLatest: false`），并通过 `onUsage` 上报，因此 `result.usage` / `error.usage` 是完整的。这次调用
  **不推 `rounds`**、不参与 stall 检测、也不更新后续压缩判断用的 `latestApiInputTokens` / `latestApiEstimatedTokens`。
- summarizer reject / throw / 返回空文本时，与注入式 summarizer 一样降级到统计摘要（下一轮上下文里
  会出现 `[fold-llm 摘要失败…]` 标记）。摘要失败不会杀死 run。
- 自己注入策略对象仍是覆盖通道（比如把 summarizer 接成便宜模型）。该形态下引擎**不**为摘要记账——由宿主自己算。

### 装配自检断言点

`model_metadata_missing`（`{type, runId, detail}`，每个 run 最多一条）就是宿主对自己
装配的断言点：指望压缩生效的宿主断言它**不出现**；故意不压缩的宿主断言它恰好出现一次。
`detail` 还报出实际解析到的输出上限，所以同一个断言也能接住「我的窗口没参与输出截断上限的计算」。
断言请在**启动之前**做，或者在装配后用 `signal.abort()`：这个启动期事件上 `onEvent` 抛错
不再是「拒掉 run」的机制，而是经 `onObserverError` 上报后 run 继续
（`reportObserverError`，`src/loop/orchestrator.js`；见「观察者回调抛错（issue #173）」）。

### 多模型槽位装配示例（issue #182）

一份模型目录、一个模型一个 slot、每个 run 选一个 slot。把请求参数与预算元数据
放在一起，才能让 temperature、`max_tokens`、思考档位跟着被选中的模型走，而不是
被钉在整个进程上：

```json
{
  "slots": {
    "default": {
      "protocol": "openai",
      "endpoint": "https://gateway.example/v1",
      "apiKeyEnv": "GATEWAY_KEY",
      "model": "big-model",
      "contextWindowTokens": 200000,
      "maxOutputTokens": 8192,
      "maxTokens": 2048,
      "temperature": 0.2,
      "reasoning_effort": "low"
    },
    "triage": {
      "protocol": "openai",
      "endpoint": "https://gateway.example/v1",
      "apiKeyEnv": "GATEWAY_KEY",
      "model": "small-model",
      "contextWindowTokens": 32768,
      "maxOutputTokens": 4096,
      "maxTokens": 1024,
      "temperature": 0
    }
  }
}
```

```js
import { createJsonFileModelConfigProvider, createOpenAIProvider, runToolLoop } from "erix-agent";

const modelConfig = createJsonFileModelConfigProvider({ path: configPath });

// per-run 的槽位选择跟着 run 走，不跟着进程走。
// 不认识的槽位名会回落到 "default" 槽，而不是让这个 run 失败。
const modelSlot = run.triage ? "triage" : undefined;
const slot = await modelConfig.resolve(modelSlot);

// 启动前的预检：现在在回调里抛错只会得到上报（issue #173），所以「没元数据就
// 不要启动」这个决定必须在 run 存在之前做。
if (slot.contextWindowTokens === undefined || slot.maxOutputTokens === undefined) {
  throw new Error("slot carries no window metadata: compaction is off for this run");
}

const events = [];
const controller = new AbortController();
const result = await runToolLoop({
  provider: createOpenAIProvider(slot),  // 请求参数：model / max_tokens / temperature 均来自 slot
  modelConfig,                           // 预算元数据：经 session.modelSlot 重新解析
  session: { id: run.id, modelSlot },
  initialUserMessage: run.prompt,
  executeTool,
  maxRounds: 8,
  persistence: "none",
  signal: controller.signal,
  onEvent: (event) => {
    events.push(event.type);
    // 装配之后仍可用的逃生口：回调终结 run 只能靠 abort 信号，绝不能靠抛错（issue #173）。
    if (event.type === "model_metadata_missing") controller.abort();
  },
});

result.termination.reason; // "end_turn"——真正证明预算被推导出来的是上面那个启动前预检
```

引擎不会在 run 中途换模型：宿主用自己选的 slot 构造 provider，循环只是重新读一次
slot 拿预算元数据。一个确实需要换模型的 run 应当结束，随后换一个
`session.modelSlot` 开新 run。

## 多轮续跑契约（issue #97）

要用新的用户消息继续一个既有 run，宿主需**预写入一个用户轮**到 transcript store，
然后以 `resume: true` 调用 `runToolLoop`。当且仅当 `resume: true` 与提供的 `store`、
`runId` 同时成立时（即 `restoreResume`（`src/loop/resume-manager.js`）的条件分支），引擎会从
`store.load(runId)` 重建消息状态，并**忽略 `initialMessages` 与 `initialUserMessage`**
——宿主提供的用户消息只能通过预写记录到达模型，绝不通过这两个选项。resume 而缺少
`store` 或 `runId` 属于未支持的调用：此时初始消息选项不会被覆盖。

正确的预写 `RoundRecord` 必须满足：

- **形状：** `{ round, messages: [{ role: "user", content: [{ type: "text",
  text }] }], dedupKey, roundKey, ts }`，`ts` 为 ISO-8601 字符串
  （`new Date().toISOString()`）。预写行**不得**带 `kind` / `seq`——这两个字段是
  引擎逐条消息行的标记（`kind: "message"` + 安全整数 `seq`）；带上它们的行会被
  恢复侧的 `restoreResume`（`src/loop/resume-manager.js`）判成引擎行并算进**崩溃
  现场**（补跑结果因此排到它之后、`tool_use` 与 `tool_result` 不再相邻 ⇒
  `invalid_messages`）。
- **round：** 复用 `load` 结果中的现有最大 round（`Math.max(0, ...rounds)`，空
  store 为 `0`）。引擎从该最大 round 续起并把自身记录落在更后的 round；预写不得推
  进它。空 `load` 结果是种子路径：在 round `0` 预写该轮；内置 CLI 则在没有既有记录
  时不带 `resume` 地传 `initialMessages`/`initialUserMessage`，对引擎而言等价。
- **dedupKey：** 命名空间为 `"<key>:input:<suffix>"`，每轮唯一。引擎自身行写在
  `"<runId>:engine:round:<n>"`、`"…:engine:round:0:seed"`（种子行）、`"…:msg:<round>:<seq>"`
  （**一条消息一行，每轮可多行**——见「档案行形状」一节）、`"…:resume"`、`"…:control:<slot>"`
  与事实行 `"…:fold:<fp>"` / `"…:ttl:<fp>"`（见下一条）下，
  宿主 `:input:` 键永不与引擎行碰撞。
- **引擎控制行（issue #326）：** 引擎在当前轮记录**已经落盘之后**注入给模型的文本——judge 评审意见
  nudge、扩轮续跑提示、finalGuard revise 意见、强制收尾指令及其终稿 assistant——在**产生的那一刻**
  入账，写成引擎命名空间的一行，键为 `"<runId>:engine:round:<n>:control:<slot>"`（`slot` ∈
  `judge-nudge` / `extend` / `guard-revise` / `forced-final`）。这一行就是普通 `RoundRecord`，
  `messages` 里是带 `meta.source`（#323 标记）的普通消息：**没有新增 record kind，也没有新增消息字段**。
  于是宿主看到的行数会多于轮数——按轮渲染的投影必须以 `round` 为键并按 `dedupKey` 去重；只展示
  用户/assistant 正文的 UI 继续按现有做法跳过 `meta.source === "judge-control"` 即可。同一槽位重放
  幂等：崩溃重跑不会多出行，且这一行的 `ts` 漂移不会把重放判成 payload 冲突（#326 去重规则）。
  修之前这类文本是「模型见过、`load()` 里没有」，进程重启后引擎对自己说过什么零档案。
  - **judge 的「方向提示」故意不是上面那类行。** `pendingDirectionHints`
    （`src/loop/run-snapshot-executor.js`，文案出自 `directionHintText`
    （`src/loop/reflection.js`））被 flush 成一条独立 `user` 消息的时机，在本轮自己的
    `appendRound` **之前**（flush 点在工具块里，而轮记录是在同一次迭代的圈底写的），
    所以它的正文是由轮记录本身带走的——resume 路径上则是由 `"…:resume"` 那一行带走，
    轮号取回放的 run 快照 `resumeRunSnapshot`（`src/loop/orchestrator.js`）。于是
    `load()` 里恰好只有一份，`restoreResume`（`src/loop/resume-manager.js`）也只重建
    一份。给方向提示再补一条 `:control:` 行会把同一份正文存两遍，并让 `restoreResume`
    把它给模型喂两遍——宿主**不要**指望上面那个 slot 清单里有 `direction-hint`，
    只按 `dedupKey` 认引擎文本的投影会在普通轮键下找到它。守卫在
    `test/loop-persist-engine-text.test.js`，中英两道。
- **幂等性：** store 按 `dedupKey`（回落 `roundKey`，两者都缺时回落 store 自造的
  `<runId>:round:<n>`）去重，崩溃重跑的判定依据是 `dedupKey`：同 `dedupKey` **且
  payload 未变**的重复 append 是 no-op，因此稳定的 `dedupKey`（由宿主消息 id 推
  导）使预写可安全重复。这个保证是**顺序重跑**语义——崩溃重跑或按 `dedupKey` 的
  顺序重试。同一 key 的并发追加不在保证范围内：宿主应按 key 串行发起
  追加（或在接收事务内发起）。`appendRound` 的解析值不在契约里（内置实现解析为
  `undefined`）；要拿既有记录请用 `load`，或取 `appendUserTurn` 回传的 `record` 字段。
- **时机：** 在接受用户消息的事务内持久化该轮（当宿主决定该轮属于本 run 时），
  而不是懒到 worker 接手之后再写——否则接受与预写之间崩溃会丢失或重复该轮。

### 恢复运行会被告知「这是复活赛」（issue #404）

续跑**不是**一段连续会话：两段之间进程死过一次，于是有些 `tool_use` 根本没有结果，引擎不得不在下一次
请求之前替它补跑或标注。issue #404 之前模型对此一无所知——它把引擎补跑出来的结果当成自己上一次调用的
输出，或者重发一遍有副作用的调用（`git commit`、`npm publish`、HTTP `POST`、覆盖写、建 PR），而第一次
可能已经落地了。

当且仅当 `resume: true` 配上真的产出过账本的 `store` 与 `runId` 时，`restoreResume`
（`src/loop/resume-manager.js`）会规划**一条**引擎控制消息，由主循环在恢复出来的上下文**之后**（补跑结果
之后）、第一次请求**之前**注入。正文四行，每一件事实在账本里都已经存在：

| 那一行说的是 | 事实来源 |
| --- | --- |
| 这是恢复运行、上一段停在第 N 轮、停机原因（账本里有才说） | `runLoopState.rounds` 与 `deterministic.termination.reason`（`src/run-state.js`） |
| 崩溃时哪些 `tool_use` 没有结果（`id` + 工具名 + 参数摘要） | `pendingTrailingToolUses`（`src/messages/rounds.js`），在补跑**之前**读 |
| 账本记过写过哪些文件 / 最近调过哪些工具 | `deterministic.filesWritten` 与 governor 的时间线 |
| 动手前先勘验、别直接重发有副作用的调用 | 固定文案 |

宿主能观察到什么、不能推出什么：

- **它是 `messages` 里的一条消息。** 形状 `{ role: "user", content: [{ type: "text", text }], meta:
  { source: "judge-control" } }`——#323 的 marker，于是 judge 输入照旧跳过它，而主模型读得到。
  它**不是**新的 payload 键，`finalGuard` payload 里也一个字节都没加。
- **它按既有的 `:control:` 行入账**，`dedupKey` 是 `<runId>:engine:round:<n>:control:resume-notice:<fp>`
  （`<fp>` 是正文指纹）。同一份事实 ⇒ 同 key ⇒ 崩溃重跑不写第二行、本次恢复也不再注入第二份；事实变了
  （例如上一次崩溃把 `termination` 记成了 `failed`）⇒ 换 key ⇒ 多一行，旧那条仍留在上下文里。
  所以按轮数行的宿主在恢复的 run 上看到的是**行数比轮数多**，与 judge nudge / 扩轮 / 强制收尾那几行同一个口径。
- **`messages` 会多一条。** 恢复的第一次请求比崩溃时的账本多一条消息（账本多一行 `:control:`）；
  轮号记账、`result.messages`、输入 token 计数都包含它。首次（非 resume）运行一个字节都不变。
- **它不是验收机制。** 它是给模型的忠告，不是闸门：验收仍看 `finalGuard` / 交付物判据，一个 guard 判
  `accept` 的恢复 run 就是 `verified`，与模型有没有照告示去做无关。引擎无法让模型一定去勘验——所以
  有副作用的工具**仍然应该由宿主自己加幂等键**（键 / 锁 / 去重表）。见升级指南的「没变的」那一节。
- **它可能被折掉。** 告示是最新的一轮，默认 `keepRounds` 会把它留在保留窗口内；但激进的压缩配置
  （例如 `keepRounds: 0`）会在同一轮就把它折进摘要，那时模型读到的摘要而不是告示原文。

### 同 key 异 payload 的冲突（issue #326）

一次 `appendRound` 命中已存在的 key 时，**只有 payload 就是那条记录**才是 no-op。
同 key 带不同 payload 是错误：既不静默覆盖，也不静默丢弃。issue #326 之前内置 store
默默接受这种情形——第二次的 payload 被丢掉，引擎与宿主都拿不到任何信号——于是「续接轮
被去重掉了」或「同一消息 id 换了正文」这类事实永远观察不到。现在两个内置 store 以完全
相同的方式拒绝它（判据只有一份实现：`src/store/transcript-dedup.js`，两个 store 不
可能各自漂）：

- 抛出的错误带稳定 `code`：`dedup_payload_conflict`，宿主不需要 `instanceof` 也能
  分流。消息里点名 `runId`、key、两份 payload 指纹（`sha256:<24 hex>`），以及顶层
  差异字段名；同样的值也作为属性挂出（`key`、`existingFingerprint`、
  `incomingFingerprint`、`differingFields`）。
- 拒绝是惰性的：既有记录字节不动，也不落新行。之后拿原 payload 重放仍幂等。
- 依赖旧行为（同 key 异 payload、第二次写被静默忽略）的宿主现在会看到这个错误。
  `runToolLoop` 把抛错的 store 当作持久化失败（重试耗尽后 `persistence_failed`），
  于是原本静默的丢失会变成显式的 run 失败，而不是一份悄悄少了一行的 transcript。

「同 payload」指的是文档化的摘要，不是逐字节相等：对记录的规范化 JSON 取 `sha256`——
对象键逐层排序（字段顺序不是语义）、数组保序（消息顺序**是**语义）、`undefined`/函数/
symbol 成员按 `JSON.stringify` 的同样取舍丢掉——最后这一条正是「内存里的活对象」与
「JSONL 读回来的同一行」能得到同一指纹的前提。先剥掉四个**顶层**字段，因为它们是信封
不是 payload：`dedupKey` 与 `roundKey`（它们就是刚匹配上的那个 key），加上 `round` 与
`ts`（`appendUserTurn` 的 `round` 取 store 现有最大 round、`ts` 取 `new Date()`，所以
同一稳定 `dedupKey` 崩溃重跑时这两个必然漂）。把这种漂移当成冲突会把上面承诺的「预写
可安全重复」变成抛错，而两个误判方向不对称：**误判成冲突比漏判更糟**。所以排除表就只
有这四个名字，嵌套的 `ts` 算内容，其余一律算 payload：`messages`、`response`、
`foldedPayload`、`usage`、`runState`，以及宿主自有的未知字段。

### load 返回顺序

`load(runId)` 必须按持久化追加顺序返回全部记录；尤其是同一 `round` 的多条记录必须保留
追加顺序（先追加的先返回）。SQL 类 store 应按持久化追加序号排序，或按持久化插入时间加
唯一次级键排序。例如，当 round 按追加顺序单调递增时，可用
`ORDER BY round_no, append_seq`，其中 `append_seq` 是单调递增的持久化列或持久化主键的一
部分。排序必须保证整个结果集都与追加顺序一致；不得依赖查询执行计划、主键扫描巧合或
`filesort` 的偶然结果。

`src/loop/resume-manager.js` 按 `load()` 返回顺序重建状态，且不对记录二次排序。受顺序
影响的不只是 `messages`，还包括 governor history（`:101-109`）、供
`taskBriefSource` 使用的 round 0 seed 消息（`:88-90`），以及对顺序敏感的 snapshot
`recordedEntries` 匹配（`:152-200`）。典型平局是上一段引擎轮处于 `round=max`，预写 user
行也处于同一 round——因为 `appendUserTurn` 刻意复用最大 round。若这两行顺序反转，新用户
消息就会排在上一段引擎轮之前，改变消息序列语义。

引擎不会对同 round 记录二次排序或修正，包括不会按 `dedupKey` 命名空间等启发式处理；
顺序是宿主 store 的责任。`appendUserTurn` 继续复用最大 round，这是本契约的既有约定。

宿主不应手写这套逻辑。引擎导出
`appendUserTurn(store, { key, text, messageId?, ts? })`，一次调用完成 `load`、round
推导、`dedupKey` 生成、幂等检查与 `appendRound`。带 `messageId` 时 `dedupKey` 稳定
（`<key>:input:<messageId>`），重跑天然幂等；不带时后缀退化为时间戳 + 随机 UUID（每次
调用唯一）。它解析为 `{ key, dedupKey, round, written, record? }`——幂等检查命中时
`written: false` 并附既有 `record`。内置 CLI 与 REPL 是参考消费者。

`appendUserTurn` 另为数据库型宿主提供**成对可选快路径**（issue #157）：当 `store`
同时实现 `loadByDedupKey(key, dedupKey)` 与 `loadMaxRound(key)` 时，助手先算出
`dedupKey` 再点查 `loadByDedupKey`——命中立即返回（既不调 `loadMaxRound` 也不调
`load`）；未命中才由 `loadMaxRound` 推导 `round` 后追加。快路径全程不调用
`store.load`。只实现两个探针之一等同全不实现：上方全量 `load` 路径原样执行。
`loadByDedupKey` 点查必须按 `(record.dedupKey ?? record.roundKey) === dedupKey`
匹配——与全量路径对 `load` 结果使用的判据相同——并返回完整既存记录（命中）或
`null`/`undefined`（未命中）。`loadMaxRound(key)` 必须等价于对 `load` 结果取
`Math.max(0, …安全整数 round…)`，空 store 返回 `null`/`undefined`（或负数）。
违约抛 `TypeError`：`loadByDedupKey` 返回值既非对象也非 `null`/`undefined`；
`loadMaxRound` 返回值既非 number 也非 `null`/`undefined`；或 `loadMaxRound` 返回的
number 不是安全整数。命中记录自身 `round` 不是安全整数时，助手回落由
`loadMaxRound` 推导。内置 file store 两个探针都不实现（点查对 JSONL 无意义）。

## 持久化失败上报

持久化失败有两条可靠通道，都不依赖模型是否读提示：

- `result.unpersisted` —— 错误账单（数组，schema 冻结）。每条含 `ts`、`kind`、`port`、
  `operation`、可选 `phase`、`fatal`、`repeat`、可选 `lastTs`（吸收重复失败时更新）
  与 `error: { name, message }`，外加加法键 `error.phase`（issue #439；只在错误对象自带它时
  存在——见下面 `persistence_error` 的条目形状）。message 截断到 500 字符、不带堆栈；
  `delivery_failure` 条目额外带 `failedEvent`（没能送出去的事件身份）。完全相同的
  失败——同 port/operation/phase/fatal/message、错误自带 `phase` 时也同 `error.phase`，
  `delivery_failure` 还要同 failedEvent 身份——会去重成一条并累加 `repeat`，不会刷屏。
- `diagnostics.error(event)` —— 同一身份的事件；宿主编排了 sink 时投递。sink 自身抛错
  也会记成一条 `delivery_failure`。
- 抛出的错误本身 —— 因落盘失败而死的 run 抛的是 `KitError`，两个出口的字段面相同：
  工具边界的 `checkpoint_failed`（`assertSnapshotPersisted`，`src/loop/run-snapshot-executor.js`）
  与 run 末尾的 `persistence_failed`（`makePersistenceFailure`，`src/loop/orchestrator.js`）。
  两者都带 `operation`、`phase`、`sideEffect`、`persistence`、`persistenceError`、`cause`、
  `errorCode`、`unpersisted`（issue #230），宿主分流不必再解析 `message`。对称的是**键名与
  取值类型**——同名同形，一条读法管两个出口：
  - `cause` —— 两侧都是**底层错误对象**（绝不是字符串）。`checkpoint_failed` 上取链上最深那一环，
    即 store 自己抛的那个错；没有 store 失败明细时退回持久化失败本身。所以无论接到哪个出口，
    `err.cause?.code` 都同样可读。
  - `errorCode` —— 两侧都是**字符串**，与 `termination.errorCode` 同一套口径读取
    （`terminationErrorCodeForError`，`src/loop/termination.js`：取根因自身的 `code`，取不到即
    `"unknown"`）。只要分类结果的宿主读这个字段即可，不必自己去 `cause` 上摸 `.code`；
    同一份底层故障在两个出口上给出同一个字符串。
  - `unpersisted` —— 两侧都是**原始冻结数组**（`result.unpersisted` 的 schema，自 issue #109 起
    未变），所以 `err.unpersisted.length` 两侧都能用。`normalizeUnpersisted`（`src/run-state.js`）
    的 `{ count, items }` 投影属于 `<runId>.state.json` 那条路径（`deterministic.errors.unpersisted`），
    **不**写进错误对象。

  错误码本身与 `phase`/`sideEffect` 语义不因此改变：工具前失败仍报 `not_started` 并阻断执行，
  工具后失败仍报 `executed_uncommitted`。

deterministic run-state 里带同一份账单（`deterministic.errors.unpersisted`），run 中途
崩溃也不会丢；模型可见渲染只给条数，不把宿主错误正文灌进上下文。

失败档位按操作而非按端口划分：transcript 的 append 与 run-snapshot/run-state 写失败会终止
run（副作用被追踪，见 ADR-013）——但仅当 store 实现了该方法；缺可选 capability 的 store 是
降级而非报错（见上文「TranscriptStore capability 分级」）。notes 写失败则继续 + 事件 + 账单，
且工具结果不会长得像“已保存”。宿主端口通过注入的 `reportPersistenceFailure` 桥上报自己的写
失败，事件与账单形状与 transcript 路径一致。

`result.completionErrors[]` 收集收尾失败（多个失败互不覆盖）。主结果若是异常，原异常
仍是主，收尾失败挂在 `error.completionErrors` 上。

## 终局载荷（issue #176 / #180）

无论 `runToolLoop` 是正常返回还是抛错，终局都要把同一套事实交给宿主。下列字段全部是
additive：既有字段不变形状、不变值、不变语义，忽略它们的宿主行为与从前一致。

| 字段 | 出现在 | 契约 |
|---|---|---|
| `termination.errorCode` | `result.termination` / `error.termination` 且 `reason === "failed"` 时 | 失败的根因分类。引擎只透传错误**已有**的分类字段（`KitError.code`，如 `timeout`、`rate_limited`、`auth`、`server`、`checkpoint_failed`），没带分类时回落 `"unknown"`——绝不自己发明或重新归因。其他 reason 不得多出该字段。宿主裁决表因此可以直接按 `errorCode` 分流，而不是解析 `termination.detail` 字符串。provider 的 HTTP 失败交出的是 `classifyHttpError` 的取值集，所以 issue #179 之后一个被拒的请求会在这里以 `invalid_request`、`not_found` 或 `conflict` 出现，而不像以前那样以 `unknown` 出现（见「HTTP 状态码分类（issue #179）」）。 |
| `error.usage`、`error.rounds`、`error.finalText` | 运行生命周期开始之后抛出的每一个错误——即终局 `fail()` 路径；issue #173 删掉了第二个生产者（启动期诊断注解），因此 `fail()` 是唯一来源 | 抛错时刻的累计用量——就是 `result.usage` 本会携带的**同一个对象**（含 `cacheRead`/`cacheWrite`）——外加轮号与已产出的部分终稿（无产出时为 `""`）。尚未产生任何累计时，这些字段是**零值而不是缺字段**：`{ input_tokens: 0, output_tokens: 0 }`、`0`、`""`。运行开始前的校验错误（未知/非法选项 `TypeError`、装配失败、`modelConfig.resolve` 拒绝）时尚不存在 run，不携带这些字段；宿主观察者抛错也不携带了——它现在根本不会抛错（见「观察者回调抛错（issue #173）」）。 |
| `termination.usage`、`termination.rounds`、`termination.partial` | `error.termination` 且 `reason === "aborted"` 时 | 与错误对象上的量同口径（`termination.usage === error.usage`），`partial: true` 表示这是部分稿而非终稿。 |

abort 载荷的存在理由：用户点「停止」的 run 真的花了 token。引擎此前的行为是抛出异常而
把累计量留在函数作用域里，宿主只能在 `catch` 分支写死
`usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0`——于是最长（最贵）的那批 run 记账为
0；靠累加 `usage` 事件也求不出真值：该事件只在 provider 响应完成后才发，而收尾的
`final_guard` / 强制收尾请求根本不发 `usage` 事件。宿主必须从接到的错误上读这份载荷；
「停掉的 run 就不记账」不是合法行为。

`aborted` 仍然意味着「循环抛错」——本次改动不把 abort 变成正常返回，正常返回路径也不会
多出 `errorCode`、`partial` 或嵌套 `usage` 字段。要不要重跑、要不要告警、怎么记账，仍然是
宿主的决策（reason 枚举见下文「终答核验」，终态另见运行状态一节）。

### CLI 的 idle 判死保留载荷（issue #440）

CLI 自己也是一个宿主，它自己的看门狗（`--idle-timeout`）是能把一个 run 收成 `aborted` 的
两个东西之一——另一个是宿主自己的 `signal.abort()`。issue #440 之前，看门狗抛的是一个新造的
`IdleTimeoutError`，把上面整份载荷**全丢了**：驱动 CLI 的宿主 / bench 只拿得到「超时了」，
拿不到「这个 run 死之前烧了多少 token、跑到第几轮、有没有半成品」——这正是「一次超时无法
从外部复盘」的形状。

现在抛出的错误携带什么：

| 事实 | CLI idle 错误上的值 | 说明 |
|---|---|---|
| `error.code` | `"idle_timeout"` | **判别面，一字不变**——CLI 最外层 `catch`、repl 的行处理、外部 bench 统计都按它分流。它的唯一声明是 `IDLE_TIMEOUT_CODE`（`bin/idle.js`） |
| `error.name` / `error.message` | `"IdleTimeoutError"` / `任务 <N> 秒无进展，已中止` | 不变（面向人的文案） |
| `error.termination` | 引擎自己那份 `aborted` 终局 | `reason: "aborted"`、`partial: true`，且它的 `usage` / `rounds` 与下面两个字段相同 |
| `error.usage`、`error.rounds`、`error.finalText` | 引擎的累计量 | **同一个对象**，不是拷贝——`termination.usage === error.usage` 成立 ⇒ 两者都视作**只读**：改一处会改到另一处（引擎本来就是这个口径） |
| `error.cause` | 引擎原本抛的那个错误 | 抵达终局 `fail()` 的那个 `AbortError` |
| `error.partial` | **不存在** | 本契约里没有顶层 `partial`；标记位是 `termination.partial` |

两条边界，都是实测口径而不是假设：

- **不伪造。** 载荷长在引擎的错误上，是因为终局 `fail()` 给它盖了注解
  （`annotateTermination`（`src/loop/termination.js`））。如果看门狗命中时在飞的是**别的**
  东西、而不是那条终局路径，这些键就是**不出现**——不是值为 `undefined` 的键，更不是零值。
  所以宿主必须把它们当可选字段处理，与上表对「运行开始前的错误」的说法一致。
- **在哪里可观测。** `erix chat` 把这个错误抛给调用方，宿主 / bench 从它身上读载荷。交互式
  `erix repl` 把它变成一行文案、不向外抛，所以那里**观测不到**载荷——能观测到的是判别面
  （`code` / `message`）。这里是两层事实，**不是**一句话：① **构造入口只有一份**——错误类与搬运
  载荷的逻辑同在一处（`idleTimeoutFailure`（`bin/idle.js`）），不存在会跑偏的第二份实现；
  ② **载荷的可观测程度按入口分开**——`chat` 侧它可以从 `process` 层抛出的错误对象上读；`repl`
  侧只保证判别面：错误在那里变成一行文案、不外抛，载荷的保留由「共享构造入口 + 实参形状守卫 +
  `test/repl-idle-payload.test.js` 的观测缝断言」共同保证，**不是** repl 对宿主的任何承诺。

可达性（在本树上实测，见「静默是一条可重试的截止」）：静默的 **`--stream`** run 先被 provider
的相位截止收掉，重试用尽后终局是 `failed` / `errorCode: "timeout"`，所以 idle 判死**不是**那条
路径上的常态；静默的**非流式** run 仍以 `idle_timeout` 收尾（legacy `requestTimeoutMs` 故意不派生），
但那是在 CLI 的重试预算用尽之后（issue #433 fix 1）；任何「provider 根本没有相位截止」（例如宿主注入的
provider）或「idle 窗口不大于重试退避」的 run 也一样。

### CLI 判死后从账本续跑（issue #433 fix 1）

idle 看门狗曾经是终局：`bin/cli.js` 的最外层 `catch` 看到 `code === "idle_timeout"` 就
`process.exitCode = 1`，把一个已经付过好几轮费用的 run 直接扔掉。支撑这次改判的现场数据
（55 个被看门狗打死的 run）是：静默**通常自愈**——46/55 一个字节都没回来，而未删失窗口里
>300s 的静默每 1000 轮出现 7 次（中位 400s、最长 1168s），经历过它的 35 个 run 里 18 个最终
拿到分，而**新请求** 3.4–15s 就起流。所以 CLI 现在**退避后从持久化 transcript 续跑同一个
run**，既不死等，也不把任务从头重跑：

- `--idle-retry-budget <seconds>`（仅 `chat`，默认 **900**，`0` = 关闭），按**从第一次判死起的
  墙钟总时长**算——退避**与**重试尝试都算在里面，所以它不是「退避之和」。
  **这改变了静默 run 的默认墙钟**：依赖「静默 ⇒ 快速退出」的宿主必须传 `--idle-retry-budget 0`。
  **实测最坏**（上游永久静默、`--idle-timeout 1`、默认预算）：从启动到进程退出 **130.3s**，共 9 发，
  退避 `1, 2, 4, 8, 16, 30, 30, 30` 秒——这个窗口下先撞的是**次数**闸。默认 `--idle-timeout 300`
  时先撞的是预算：从启动 **约 1200s**——**这一格是推算、不是实测**（300s 首窗 + 900s 预算 +
  最后一个窗口：判死落在 300s / 601s / 903s / 1207s，第四次判死时已用 907s ≥ 900s）。
  模型用**等比实测**验证，而不是真跑 20 分钟：`idle=2` / `budget=6` + 上游永久静默 ⇒ 墙钟
  **9084ms**、3 发、退避 `[1000, 2000]`ms、`exhausted: "budget"`——「首窗 + 预算 + 最后一个窗口」
  这个模型算得 9.0s，而「预算 + 启动」那种口径会得 7s / 2 发，被实测否掉。
  **第一次重试约在 2s 时发起**（1s 窗口 + 1s 首段退避）。
- 指数退避：`IDLE_RETRY_BASE_DELAY_MS`（`bin/idle.js`）= 1000，每次翻倍，夹在
  `IDLE_RETRY_MAX_DELAY_MS` = 30000；每次退避还会被剩余预算夹住。
- 第二道**独立**的闸：`IDLE_RETRY_MAX_ATTEMPTS` = 8 次重试。只靠预算的话，
  `--idle-timeout 1` 会把 900s 摊成几百发 provider 调用；有 30s 上限时 8 段退避之和约 121s
  ⇒ 两道闸会合，而不是一道悄悄替另一道兜底。
- 重试是**续跑、不是重跑**：引擎的 `resume` 路径（`restoreResume`（`src/loop/resume-manager.js`））
  从 transcript 与 run snapshot 重建上下文，所以已经付过费的轮次与 token 都留着——`rounds` 从
  账本接着数，续跑的请求里带着判死前已落盘的工具结果。
- 只有 transcript 非空时才重试：store 里一条记录都没有的 run（例如持久化失败）直接落
  `idle_timeout`，而不是被一个 resume 错误顶掉真正的终局原因。

宿主能观测到什么、从哪里读：

| 事实 | 渠道 |
|---|---|
| 重试次数、每次退避、预算、累计 usage、哪道闸停的 | `result.idleRetry`（成功）/ `error.idleRetry`（终局） |
| 每一步一条记录（`phase: "backoff"` / `"recovered"` / `"exhausted"`，带 `retries` / `backoffMs` / `usage` / `idleSeconds`） | `judge.log` 的 `type: "idle_retry"` |
| 每次重试一行人类可读日志 + 一条汇总 | stderr（`idleLog` 槽位，进程内可注入） |

边界，按实测口径写：

- **不是所有静默都被救。** `--stream` 的静默先撞 provider 的可重试相位截止（上一节），落到引擎
  自己的重试循环上；`--idle-timeout 0` 完全关闭看门狗（没有重试）；`erix repl` 没有重试
  （它的默认窗口是 0，而且那是交互式会话）。
- **终局形状不变。** 预算或次数用尽时，run 与之前一字不差地收尾：`code === "idle_timeout"`、
  `name === "IdleTimeoutError"`，以及 issue #440 的四件载荷（`termination` / `usage` / `rounds` /
  `finalText`，没有顶层 `partial`）。`error.idleRetry.exhausted` 说明是哪道闸停的
  （`"budget"` / `"max_attempts"` / `"no_transcript"`）。
- **引擎自己的重试计数一个字没动。** 每次重试是一次独立的 `runToolLoop` 调用，所以 provider 层的
  `attempt` / `recovering` 事件按尝试重新起算，`judge.log` 里每次尝试都有一条 `run_outcome`
  （最后一条才是终局）。CLI 的记账是上面的 `idleRetry` 快照，不是对引擎计数器的重算。
- **终局错误上的 `usage` 是最后一次尝试的 usage**（引擎的契约形状）；跨尝试的总量在
  `idleRetry.usage` 里。

### 工具执行不是静默，`exec` 也不能长过 idle 窗口（issue #433 fix 3 / fix 4）

两条都在 CLI 侧，`src/` 一行未改：

- **fix 3 —— 喂表。** 工具执行期间每 `toolHeartbeatIntervalMs`（= `idle/4`，夹在 250ms–30s）
  喂一次看门狗，所以比 idle 窗口还长的命令不再打死整个 run。喂表是**有界**的：到
  `toolHeartbeatCapMs`（= `exec` 天花板，即 `max(30s, idle − 60s)`）就停，静默窗口重新开始
  计时 ⇒ 永不返回的工具仍然会被收掉——没有这条界，喂表会把 fix 1 变成「永不判死」。证据可观测：每次被喂过的执行都会打一行
  `[idle-heartbeat] <工具名>：执行期喂过 idle 计时器 N 次`（只在 `N > 0` 时打，行里还带着生效的
  **上限** `上限 <n>ms`——那正是接线证据，CLI 级用例靠它钉住装配处的缺省值），真的喂到上限
  还会再打一行。
- **fix 4 —— 天花板。** 生效的 `exec` 超时是 `min(配置值, max(30s, idle − 60s))`，**包括**显式
  `ERIX_EXEC_TIMEOUT_MS`（它以前是原样使用的）。钳制真的降低了取值时 CLI 打一条 loud 日志；
  它**不会**启动即报错——`exec == idle` 是 bench 的真实配置，判据是「终局不得是 `idle_timeout`」。
  `idle ≤ 30s` 时 30s 下限胜出（`execCeilingMsForIdle` = `max(30s, idle − 60s)` ⇒ 生效值就是
  30000ms ≥ idle）、`exec < idle` 根本不可能成立；`idle > 30s`（含 31 / 50 / 90s）时天花板严格
  小于窗口、这条不变式成立。`idle ≤ 30s` 这种情形也会打日志（日志自己的触发条件就是
  `effectiveMs >= idleMs`，与 `idle ≤ 30s` 同一个边界），那时真正
  兑付的是上面的喂表（最坏 `30s + idle`，实测数在 CLI README 里）。

### 终局前的增值调用在中止时的行为（issue #282）

end-turn judge 与 finalGuard 都是卡在「最后一轮模型回答」与「终局判定」之间的**增值调用**：
每一个都实打实地烧一次 provider 往返，而且它们都没有资格覆盖用户的中止。规则只有一句话，
issue #282 之后它收口在终局判定本身，而不是在每个调用点各补一个洞：
**`aborted` 永远优先于 `judge_done` 与 `final_guard_*`**。

| 场景 | 引擎行为 | 宿主看到什么 |
|---|---|---|
| end-turn judge 将要发起时 `signal.abort()` 已置位 | 整次 judge 调用被**直接跳过**——入口守卫是 `src/loop/orchestrator.js` 里的 `roundJudgeEnabled && isEndTurn && !signal?.aborted` | 比 issue #282 之前少一次模型请求，停止体感延迟从「一次 LLM 往返」降到「立即」 |
| judge 请求在飞期间中止 | judge 调用被中断，abort 错误抵达 `fail()` | `reason: "aborted"` 并携带 issue #180 载荷 |
| judge 已返回、终局 reason 尚未推导时中止 | 终局 `stop` 分支先查信号（分支入口的 `throwIfAborted(signal)`），宁可抛错也不把 judge 的结论当终态 | `reason: "aborted"` 加 `{usage, rounds, partial:true}`——**绝不是** `judge_done` |
| finalGuard 执行期间中止 | `finish(reason)` 之前的同一个检查点再查一次信号 | `reason: "aborted"`，绝不会是 `final_guard_unverified` |

模型已产出的文本不会因中止而丢：它仍在 `error.finalText` 上（issue #180）。judge 真的跑过时，
它的结论仍会记到 judge 记录渠道（见「judge 记录关联与 run 级 outcome（issue #165）」），
因此宿主能区分「judge 认为已交付」与「用户让它跑完的」。

### 中止后事实的真相分布（issue #283）

被中止的 run **不会为正在进行的那一轮留下任何由引擎写下的 transcript 记录**：引擎只在 `appendRound`
成功时提交轮次，而在此之前被中断的轮次不会被追溯补写。一个例外在这里说清、以免被当成保证：
`persist()` 是在**调用 store 之前**查信号的（`src/loop/orchestrator.js`，重试循环以
`throwIfAborted(signal)` 开头），所以中止落下时**已经在途**的那次 `appendRound` 仍可能落地。
把进行中那一轮当作“没有记录”来读，也不要拿它当一个能对账的计数。
这是明意的裁决（issue #283，
取 β），不是 oversight——中止轮没有稳定的轮键，它的 tool_use 块可能没有配对的 `tool_result`
（那会让 transcript 在续跑契约上不可重放），而且补写半轮会惘然改变 `rounds` 的计数口径。

因此 `termination.partial: true` 指的是**载荷**，不是 transcript：它断言接住的那个错误对象
携带了部分事实（`error.finalText`、`error.usage`、`error.rounds`，并同口径镜像进
`termination`），对 store 不作任何断言。宿主若要把「已经发生过什么」呈现出来，必须去拿
真正持有该事实的那个渠道：

| 中止后宿主想展示的事实 | 持有它的渠道 | 是否保证 |
|---|---|---|
| run 已经跑完的轮次 | transcript store 里的 `RoundRecord`（`appendRound` 写入） | 保证——中止从不改写或删除已提交轮 |
| 中止轮里已经流出过的文本——**reasoning / thinking 增量从来不进这个渠道** | run-snapshot 渠道，即 `partialPersistence:{intervalMs}` 配合 `stream:true` | **尽力而为，可能根本什么都没有。**里面只有*已提交的*那一份部分**文本**：一次提交需要一个 `minBytes` 的增量并且间隔定时器真的触发，而 attempt 结束时定时器会被清掉、缓冲区里剩下的东西不赶出去，中止也不强制 flush。存在时最多陈旧 `intervalMs`。不开则进行中轮根本快照都没有（唯一例外就是上面的在途 `appendRound`） |
| 部分终稿文本本身 | `error.finalText`（以及 `termination.partial`），issue #180 | 保证——无产出时为 `""`；**这是唯一有保证的部分文本渠道** |
| 被停掉的 run 到底花了多少 | `error.usage` / `termination.usage`、`error.rounds` / `termination.rounds` | 保证——与正常返回本会携带的是同一个对象 |
| 中止前最后一次 judge 裁决 | judge 记录渠道（`onJudge` 回调 / `judge.log`），issue #165 | judge 真跑过就有；被中止跳过时没有（见上表） |
| 进行中那一轮的 transcript 记录 | **没有宿主能依赖的渠道** | 不保证——引擎故意不补写 `interrupted` 轮（β）；只有恰好已在途的那次 `appendRound` 可能落地，而它不是一条可以安排预期的渠道 |

对宿主的两个推论，均以本节为准：想要屏幕上有部分文本，宿主必须读 `error.finalText`——那才是
有保证的渠道——而 `partialPersistence` 买的是一份尽力而为的*已提交*部分文本快照（不含 reasoning，
可能什么都没有，最多陈旧 `intervalMs`）；且宿主不得把「`partial: true` 但该轮在 store 里 0 条
`RoundRecord`」当成持久化 bug——那就是未开部分持久化时中止的既定形状。

它的价值主张说到底是这一条：`partialPersistence` 只降低**续跑时重新生成这段正文**的成本；它不是
把这段正文摆到用户面前的渠道（那是 `error.finalText`），而它在稳态下做的那些快照写入，在宿主自己的
崩溃重排队率低时是净亏。所以先量那个数再决定——排队里的 run 中 `attempts > 1` 的占比
（`run_queue.attempts`，erix-station 读的就是这个数）——按你自己的数决定，别照搬别处量出来的阈值。
提出这个选项的宿主本身就是证据，这是观测、不是建议：erix-station 开发期十天里自然崩溃重排约 1 次
（全量 `attempts > 1` 为 8/133，其中 3 条是人为 `docker pause` / `kill -9` 演练）；⚠ 单机单用户、
且是它修完自身缺陷之后的样本，不外推。这也不构成退役这个选项的理由：它留在白名单里，五个测试文件
覆盖着，关着的时候零成本。

## 用量分账：逐轮账 vs 引擎开销（issue #438）

`result.usage` 一字未动：它累计这个 run **每一次** provider 调用——模型自己的响应，加上引擎为
自己发起的调用。issue #438 只**加**键做分账：既有键的形状与语义一律不变，忽略新键的宿主行为
与今天逐字一致。

| 键 | 落在哪 | 语义 |
|---|---|---|
| `usage` | `result`（不变） | run 累计，覆盖**全部** provider 调用：`modelUsage` + `engineUsage`，逐字段相加（缺键当 0） |
| `modelUsage` | `result`（**新**） | run 累计里主循环自己那些模型响应（含 `max_tokens` 续写的每一发） |
| `engineUsage` | `result`（**新**） | run 累计里引擎**自己发起**的调用 |
| `usage` | `RoundRecord`（**新**） | 本轮**全部**模型响应的累计：续写每一发都算 |
| `engineUsage` | `RoundRecord`（**新**） | 本轮**期间**跑过的引擎自发起调用；一个都没有时**缺键** |
| `response.usage` | `RoundRecord`（不变） | **只含本轮最后一发**响应——历史形状，逐字保留 |

宿主必须读对的四件事（读错就是静默算错钱）：

- **`record.response.usage` 不是这一轮的花费。** 它就是本轮最后那一次 provider 响应的 `usage`。
  撞上 `stopReason: "max_tokens"` 的轮会**在同一轮内**续写（最多 `maxTokenContinuations` 次额外请求，
  全部并进同一条 assistant 消息与同一条 `RoundRecord`），于是 `response.usage` 只带最后一发。
  真实轮上的实测：三发 700 + 700 + 7 个 `output_tokens`（共 1407）留下的是
  `response.usage.output_tokens === 7`——200 倍量级失真。issue #438 之前契约从没写过它是哪一种，
  所以把它当「本轮的用量」读的宿主，读到的是一个从未被承诺过的数。**本轮的花费读 `record.usage`。**
  `response.usage` 逐字不变，因为已有宿主在读它——投影也一样：`meta.usage` 仍是那个「最后一发」的值，
  issue #438 刻意没有把它换掉。
- **`record.usage` 才是逐轮账。** 它把本轮每一发响应加起来，所以预算、计费、以及「每轮输出多少」
  这类分析读它。`input_tokens` / `output_tokens` **恒在**（provider 没报时是 0，绝不是缺键），
  `cacheRead` / `cacheWrite` 只在某一发报过时才出现（与 `result.usage` 同一条字段在场规则）。
  无续写、且 provider 四个字段都报的那一轮，`record.usage` 与 `record.response.usage` 深相等；
  这条等式是测试钉住的，不是巧合。完全没有用量时该键仍在，形状是
  `{ input_tokens: 0, output_tokens: 0 }`。**本版本之前**写下的记录（或宿主自己写的那行）压根没有
  `record.usage`：它是加法键，缺键的意思是「这行早于这个键」，绝不当 0 读。
- **引擎开销是另一个桶，永不进逐轮账。** 引擎会发起模型没要求的 provider 调用：round judge、
  收尾归一化器、折叠摘要器、以及强制收尾（`forceFinalIfNeeded`（`src/loop/termination.js`））。
  它们的用量落进 `engineUsage`——前三个是**轮级**（它们在轮内跑），强制收尾是 **run 级**
  （它在最后一条轮记录落盘**之后**才发生，永远归不到某一轮）。因此逐轮账里只有模型的输出，
  这正是「模型话多」与「引擎开销大」还能分开的原因。轮记录上的 `engineUsage`：本轮没有这类调用
  ⇒ **缺键**；有调用但 provider 没报用量 ⇒ 零值。run 级那个键恒在。两个桶都只在唯一记账点
  （`addUsage`（`src/loop/orchestrator.js`））按一个 `account` 参数入桶，不存在第二本会漂的账。
- **`finalGuard` 的用量两个桶都不计，中止载荷也不带分账。** guard 是**宿主**回调：引擎不发起那次
  调用、也测不到它，所以它既不能算模型输出、也不能算引擎开销——guard 里真调了模型的宿主自己记。
  另外中止的 run 仍然只抛 `error.usage` / `termination.usage`（issue #180）。两个桶的加法关系**只成
  立在成功结果上**：那里 `usage` 依旧等于 `modelUsage` + `engineUsage` 逐字段相加。`RoundRecord`
  上没有这样一个键——轮记录**没有** `modelUsage`，所以 `record.usage` 就是**模型桶本身**（上面表格那
  行写的正是「本轮**模型**用量」），本轮的总账是 `record.usage`（模型桶）+ `record.engineUsage`
  （引擎桶）；后者在本轮没发起过引擎调用时**缺键**，宿主相加时按 0 读。要分清的是：`record.usage`
  是模型那一份、不是本轮总账——现成的「两桶之和」只有成功结果上的 `result.usage` 一个。

## judge 记录关联字段与 run 级 outcome（issue #165）

judge 决策经 `onJudge` 交给宿主消费（CLI 把它们追加进 `judge.log`，宿主可落任意去处）。
两个 additive 字段让这些记录能按模型分组，一个 additive 事件让它们能与终局 join。
既有字段名称、形状、语义一律不动，完全不读这三个新字段的宿主行为与之前一致。

| 字段 | 出现在 | 契约 |
|---|---|---|
| `runId` | 每条 `onJudge` 记录与 `run_outcome` 事件 | 宿主传给 `runToolLoop` 的 run 标识，也是流式决策与终局记录之间的 join 键。宿主没传 `runId` 时该字段**缺省**——引擎不自己编一个。 |
| `model` | 每条 `onJudge` 记录与 `run_outcome` 事件 | 被评决策发生时 run **实际使用**的模型标识，从 run 选项 / provider 配置解析。探测顺序与 `modelMetadataFor()` 一致（`modelConfig` → `modelMetadata` → `model` → `provider` → `context`），键顺序 `model` → `model_name`（与 provider 构造侧同口径），首个命中且**不合并**。绝不硬编码。任一候选都探不到非空名字时该字段**缺省**：写 `"unknown"` 会让「没配模型」与「真有个叫 unknown 的模型」在账面上无法区分。 |
| `judgeModel` | `onJudge` 记录，仅当 judge 走了与 run 不同的 evaluator 模型 | 让 per-model 校准能区分「被评的模型」与「评它的模型」。judge 与 run 同模型时缺省。 |
| `compaction` 统计 | `onEvent`（`type: "compaction"`）与 `<runId>.state.json` 里的 `deterministic.compactionStats` 窗口 | 既有键-round-for-round 不动。**additive（issue #464 A）：** `strategyName` 只在引擎能如实说出时才出现——它写的是**真正执行了本次折叠**的那个策略（含库层兜底的 `"sliding-window"`），不是宿主配置项原文。忽略它的宿主看到的形状与从前逐字一致。 **additive（issue #469 ④）：** `foldSummary` 记的是这一发摘要调用的**结果状态**——`degradeKind`（`timeout` / `context_window_exceeded` / `error`）、`degradeReason`、`inputTruncated`、`droppedMessages`、`finishReason`、`inputTokens`、`outputTokens`、`priorSummaryTruncated`、`priorSummaryBytes`、`droppedRounds`、`attempts`、`budgetExhausted`、`reused`。与 `strategyName` 同口径：**无事实 ⇒ 无键**——这次折叠什么都没产出诊断信号时，形状逐字不变。摘要正文本身不进这里（它在 `record.foldedFacts` 上）。 |
| `compaction_strategy_fallback` 事件 | `onEvent`，一个 run 最多一条 | **additive（issue #464 A）。** `{ type: "compaction_strategy_fallback", round, detail }`，仅在 `context.strategy` **未配置**且折叠是**预算兜底触发**的那一刻发出——也就是引擎库层的 `sliding-window` 真的跑了（整轮头部丢弃、无摘要、无锚点，即 issue #464 B）。形状对齐 `model_metadata_missing`（issue #182）：`detail` 首句是宿主可直接断言的固定原文，能解析出预算时再附上 `budgetTokens` / `estimatedTokens`。 |
| `run_outcome` 事件 | `onEvent`，一次 run 恰好一条——judge 从未运行的 run 同样发 | `{ type: "run_outcome", runId?, model?, judgeModel?, rounds, judgeRecordCount, termination, verification }`。成功路径在持久化落地后发，抛错路径在 `fail()` 里发；去重门保证一个 run 恰好一条。`termination` / `verification` 是 `runToolLoop` 返回值（或 `fail()` 构造出的终局）的副本。 |

为什么是一条独立的终局记录，而不是把 outcome 回写进决策记录：judge 记录是 run 还在跑时
就流出、outcome 到终局才知道，回头改写已发出的记录会破掉 JSONL 的 append-only 语义（宿主
可能已在消费）。因此关联方式是 **join**：每条决策记录带 `runId`，终局记录带 outcome。
判别键：决策记录带 `kind`（`round` / `intercept`）；终局记录带 `type: "run_outcome"` 且
**不带** `kind` 与 `action`，故按 `kind` / `action` 计数或过滤决策的宿主代码不受影响。
`judgeRecordCount` 可让宿主发现掉行：它等于本 run 交给 `onJudge` 的记录条数。
续跑语义：一次 `runToolLoop` 调用发一条 `run_outcome`。续跑复用同一个 `runId`，因此一个 `runId`
可能合法地带着多条终局记录——取最后一条作为当前终局，需要逐次尝试时按 `(runId, ts)` 作键。

`run_outcome` 是既有 `onEvent` 流上的新增事件类型（additive 事件类型 = semver minor）；
没有引入新回调，因为 `onJudge` 的 payload 语义是「一条 judge 决策」，把终局裁决塞进去会让
按决策计数的宿主静默跑偏。宿主在这个终局事件上的抛错遵循统一观察者规则（issue #173）：
经 `onObserverError` 上报、绝不改变终局——审计记录不得把已跑完的 run 变成 `failed`。

字段稳定性：记录形状是宿主消费面，因此字段只 additive 演进——只会新增可选字段，同一主版本内
不重命名、不改型、不删字段。该档案仍是 debug/分析面，不是完成证书：循环依旧不仲裁完成（见「终答核验」）。

## 终止裁决决策表（issue #170）

宿主应该能不读循环就判断一个终局该怎么办。下面每个机制写的都是**同一个**
`termination.reason` 字段，但一个 run 里只能有一个机制获胜：它们是有序且互斥的。
行号引用是实现真相；代码与本表不一致时，代码是对的，本表就是 bug。

返回路径上可枚举的 reason 共 9 个（`runToolLoop`，`src/loop/orchestrator.js`）；
`persistence_failed` 是第十个，只在抛错路径上出现，所以也列出。`truncated` 恰好
对 `max_rounds_cap`、`continuation_exhausted`、`stall`、`final_guard_unverified` 为
`true`（`src/loop/termination.js:7-11`）。

| `termination.reason` | 触发机制（file:line） | 在优先级链中的位置 | 宿主开关 | 推荐宿主动作 |
|---|---|---|---|---|
| `end_turn` | 治理层 stop `completion`（`src/reflection/governor.js:118`）或兜底 stop `complete`（`src/reflection/governor.js:134`），均由 `terminationReasonForAction` 映射（`src/loop/termination.js:111`）。输入：`shouldContinue`（`src/loop/orchestrator.js`）、`completionSignalDetected`（来自 wrapup 信封 `done:true`、`completion.signals` 关键词命中，或 LLM 归一化器（`src/loop/orchestrator.js` 的 end-turn 收尾块，内部调 `normalizeWrapupText`（`src/reflection/wrapup.js`））） | 轮内优先级**最低**的 stop——其余 stop 与 nudge 都先被试过，且本轮 judge 可以用 `judge_done` 抢走它（`src/loop/orchestrator.js:3357-3365`） | 不可关（它是正常成功出口）。`wrapup:false` 拆掉 JSON 信封通路（`src/loop/orchestrator.js`）；`completion:{signals:[…]}` 拓宽关键词探测（`src/loop/orchestrator.js`） | **接受**，但必须先看 `verification.status`——`end_turn` 本身不是交付证明 |
| `judge_done` | 本轮 judge `done:true` 且 `confidence >= 0.7` 且发生在 end-turn 轮（`src/loop/orchestrator.js:3357-3365`，`isEndTurn` 在 3053），映射在 `src/loop/termination.js:94` | 轮内**最高**的 stop：先于治理层评估，因此压过 stall 与 completion | `reflection:false`、`reflection:{roundJudge:false}`、`ERIX_NO_ROUND_JUDGE=1`、`ERIX_NO_REFLECTION=1`（`src/loop/orchestrator.js`）。注意 `maxRounds >= 16` 时 reflection 默认自动开启（`src/loop/orchestrator.js`、`src/loop/reflection.js:8`） | **先接受再核验**：这是模型侧的主张而不是检查。交给下游前先过 `finalGuard` / CI |
| `no_tool` | 治理层 stop `noTool`（`src/reflection/governor.js:122`），门在 `noToolRound`（`src/loop/orchestrator.js`）且连续数 `>= maxNoToolRounds`（默认 3，`maxNoToolRounds`，`src/loop/orchestrator.js`） | 在 completion stop 之下、`complete` 兜底之上 | `completion:false` 使 `noToolRound` 恒为 `false`，此 reason 因此**不可达**，run 会改以 `end_turn` 结束；`completion:{maxNoToolRounds:n}` 可调阈值（`0` 为首次即停） | **重试 / 重新提问**：既没声明完成、`truncated` 又为 `false`（什么都没被截断）——它只是在散文里空转。反复出现则告警 |
| `stall` | 同一工具调用签名在处理窗口内重复（`src/loop/orchestrator.js:2712-2726`）叠加 streak 累加（`src/loop/orchestrator.js:2763-2770`），stop 在 `src/reflection/governor.js:67-70`，`STALL_STREAK_LIMIT = 3`（`src/reflection/governor.js:3`），映射在 `src/loop/termination.js:97` | 仅次于 `continuation_exhausted` 的 stop；设计上就高于收尾/错误重复 nudge，不能被饿死（`src/reflection/governor.js:65`） | `stallDetection:false` 使其**不可达**（`errorHashes`，`src/loop/orchestrator.js`）；`stallDetection:{window,mode}` 可调；`ERIX_STALL_MODE` 覆盖 mode（选项为 `false` 时不覆盖） | **告警 + 换思路重试**：`truncated:true`，不要把文本当答案接受。宿主自己的重复检测应当在这一点上触发 |
| `continuation_exhausted` | provider 连续返 `max_tokens` 且补全预算耗尽（`continuationExhausted`，`src/loop/orchestrator.js`，循环在 2635）；治理层 stop `cap`（`src/reflection/governor.js:62-64` / `133-135`）被映射成本 reason，**优先于** `max_rounds_cap`（`src/loop/termination.js:116`） | 两个治理入口的**首要**检查——链顶 | `maxTokenContinuations`（`messageRounds`，`src/loop/orchestrator.js`，默认 3；`0` 使首次 `max_tokens` 就终局） | **用更多输出空间重试**（抬高 `maxTokens`/`maxOutputTokens`），或接受部分文本并告警；`truncated:true` |
| `max_rounds_cap` | (a) 治理层 stop `cap`：接近上限且不允许扩轮（`src/reflection/governor.js:147-149`）；(b) 轮循环自然跑完（`runToolLoop`，`src/loop/orchestrator.js`，收尾在 `3189-3207`） | (a) 预算边界，在 stall 之下；(b) 在最后一轮之后、任何停止后核验结论生效之前 | `maxRounds`（必需选项）；扩轮余量走 `reflection:{maxExtensions, maxRoundsCap, extensionStep}`（`termination`，`src/loop/orchestrator.js`）；`ERIX_NO_REFLECTION=1` 关掉自动 reflection | **续跑或按部分交付记账**：用多轮续跑契约继续，否则拿部分结果记账并告警；`truncated:true` |
| `final_guard_unverified` | 配了 `finalGuard` 且它没能认证：不可续跑降级（`src/loop/orchestrator.js:3529-3542`）、修订次数触顶（`3544-3559`）、或轮循环跑完的收尾（`3558-3578`）。只对 6 个 guard 适用 reason 生效（`src/loop/termination.js:14-21`），且仅当 `finalGuard` 是函数（`src/loop/orchestrator.js`） | 严格位于 stop 之后的**后阶段**：它替换 reason，不介入轮内治理 | 整体不传 `finalGuard`（此时 `verification` 为 `skipped` / `no_final_guard`，`src/loop/orchestrator.js:1663-1665`）；`finalGuardMaxRetries` 调修订上限（默认 2，`budgetRounds`，`src/loop/orchestrator.js`） | **不得当已验事实消费**：`verification.status === "unverified"`（`non_continuable` / `max_retries`）。转人工复核或测试系统 |
| `aborted` | 终局 `fail()` 路径且宿主 signal 已 abort（`src/loop/orchestrator.js:1058-1116`；分类在 1061 与 1080-1085，注解在 1103-1108） | 在抛错路径上压过失败分类——信号先被检查。issue #173 之后，宿主回调无法靠抛错抵达本行：`signal.abort()` 是回调侧唯一的触发器，上面那条 issue #180 载荷规则对它照常生效。issue #282 之后，同一个检查也跑到终局 `stop` 分支的入口以及 `finish(reason)` 之前，因此「终局前的增值调用」（end-turn judge / finalGuard）再也不能把用户的中止改写成 `judge_done` 或 `final_guard_unverified`——见「终局前的增值调用在中止时的行为（issue #282）」 | 没有可关项：触发者是宿主自己的 `AbortSignal` | **记账，不自建重跑**：读 `error.usage` / `error.rounds` / `error.finalText`（issue #180）与 `termination.partial`；是用户要停的。**静默** run 不再必然落到这一行：issue #441 之后 CLI 接上了引擎的可重试相位截止，静默在重试用尽后以 `failed` / `errorCode: "timeout"` 收尾（见「静默是一条可重试的截止」）；本行现在的含义是「信号真的被 abort 了」——宿主动的手，或者没有任何相位截止能先响时 idle 看门狗动的手；看门狗动的手时，载荷仍以 `code: "idle_timeout"` 挂在抛出的错误上（issue #440，见「CLI 的 idle 判死保留载荷」） |
| `failed` | run 生命周期内抛出的任意错误，经 `fail()`（`src/loop/orchestrator.js:1058-1116`，循环 catch 在 `3576-3580`），并透传 `termination.errorCode`（`src/loop/termination.js:43-57`）；宿主观察者抛错不再是它的来源之一（issue #173） | 兜底：轮根本没跑完，因此压过任何尚未完成的治理决策 | `retry:{attempts, backoffBaseMs, backoffMaxMs}` 决定到这步前重试多少（`src/loop/orchestrator.js`）；reason 本身不可关 | **按 `termination.errorCode` 分流**（issue #176）：可重试（`timeout`、`rate_limited`、`server`）→ 退避重试；`auth` → 告警并停；`invalid_request` / `not_found` / `conflict`（issue #179）→ 去修请求体、模型名或冲突的资源，重发同一份 payload 帮不上忙；`unknown` → 转去查 `termination.detail` |
| `persistence_failed` | 同一个 `fail()` 路径，在错误携带持久化信息时被选中（`src/loop/orchestrator.js:1080-1085`），并额外挂上 `operation` / `phase` / `sideEffect`（`src/loop/orchestrator.js`） | 替换 `failed`，不会反向发生；不带 `errorCode`（该字段为 `failed` 专属） | `persistence:"none"` 直接移除 transcript 写入路径；可选 store 能力是降级而非失败（见能力分级） | **告警**：副作用被跟踪过，所以这是完整性信号（ADR-013），不是重试候选 |

### 核验状态与 CLI 退出码

核验结论与终局 reason 是两个独立的轴：`end_turn` 可以 `unverified`；而
`max_rounds_cap` / `stall` / `continuation_exhausted` 只能以 `skipped` 或 `error`
收尾——配了 guard 之后它们拿不到 `verified`，因为 guard 对这三个 reason 返回
`accept` 也仍然以 `final_guard_unverified` 终局（`src/loop/orchestrator.js:3529-3542`）。
CLI 映射在 `exitCodeForVerification`（`bin/cli.js`）：

| `verification.status` | 含义 | 实际会看到的 `verification.reason` | CLI 退出码 |
|---|---|---|---|
| `verified` | 已配置的 guard 接受了一份终答 | —（无 reason 字段） | `0` |
| `skipped` | 什么都没查——**不是**「答案对」的主张，不得改写成 `verified` | `no_final_guard`（`src/loop/orchestrator.js`）；CLI guard 的 `no_capture_evidence` / `no_extractable_candidates`（`bin/final-guard.js:86,89`） | `4` |
| `unverified` | 核验执行了但未通过 | `non_continuable`（`src/loop/orchestrator.js`）、`max_retries`（`3547-3551`） | `2` |
| `error` | guard 抛错、返回非法裁决或超时（对可用性 fail-open，但永远不会变 `verified`） | `timeout` 或 `error`——两者都由 `errorReason`（`src/loop/termination.js`）决出 | `3` |

`exitCodeForVerification` 对其他任何 status（包括根本没有 `verification` 对象）都返回
`0`，所以**退出码 0 本身不是已验答案的证明**——请读 `verification.status`。抛错的 run
从 CLI 顶层 handler 退出 `1`（`bin/cli.js:1032-1042`），那是失败信号，不是核验结果。

### 机制优先级与互斥关系

同一个轮次内只有一个机制能拍板，顺序如下
（`judge_done`，`src/loop/orchestrator.js`、`src/reflection/governor.js:59-126`、
`src/loop/termination.js:111`）：

1. **token 补全边界**——连续 `max_tokens` 响应置上 `continuationExhausted`，它是两个
   治理入口的首要检查（`src/reflection/governor.js:62-64`、`133-135`）。因为
   `continuationExhausted` 在 `cap` 映射之前被检查（`src/loop/termination.js:116`），
   由输出截断引起的 `cap` stop 报的是 `continuation_exhausted`，**永远不会**是
   `max_rounds_cap`。
2. **stall stop**（`src/reflection/governor.js:67-70`）——故意高于收尾 nudge 与错误
   重复 nudge，以免真打转被低优先级 nudge 拖到退化成 `max_rounds_cap`。
3. **wrapup 声明**——`done:true` 信封会压住 `shouldContinue` 并置上
   `completionSignalDetected`（`src/loop/orchestrator.js`），这既产生
   `completion` stop（`src/reflection/governor.js:118`），又使 `noToolRound`
   为假（`src/loop/orchestrator.js:3230-3233`）。**声明完成与 `no_tool` 因此互斥。**
4. **completion 关键词兜底**——同样这个信号，在没解析出信封时来自
   `completion.signals` 命中终答文本（`src/loop/orchestrator.js` 的 end-turn 收尾块），或来自
   end-turn 轮完全拿不到 JSON **且文本非空**时的 LLM 归一化器（`src/loop/orchestrator.js` 的 end-turn 收尾块，开关是
   `reflection.wrapupNormalize` / `ERIX_WRAPUP_NORMALIZE=1`）。
5. **`no_tool` stop**——只在什么都没声明完成且本轮没调工具时可达
   （`src/loop/orchestrator.js:3230-3233`）。
6. **judge 的 end-turn 评估**——`judge_done` 在治理层**之前**被评估
   （`src/loop/orchestrator.js:3357-3365`），因此在其生效的那一轮压过 2-5；它要求
   `isEndTurn`，即 `stopReason === "end_turn"` 且无工具调用
   （`src/loop/orchestrator.js`）。工具轮因此永远不可能产生 `judge_done`；
   `max_tokens` 轮也不可能同时产生 `judge_done` 与 `continuation_exhausted`
   （映射先优 `judge_done`，`src/loop/termination.js:94`）。
7. **停止后验证**——stop reason 定下来后，六个可收尾 reason（三条不可续跑的 +
   `judge_done`（issue #467）+ `end_turn` / `no_tool`（issue #475，只在整个 run 一个
   字都没写过时才会走到））可能多一次强制收尾的 provider 调用，且只在
   `hasFinalDraft`（`src/loop/termination.js`）为假时——也就是这个 run 本来会以零
   终稿收场时（`src/loop/termination.js:203-256`），然后 `finalGuard` 可以 accept /
   skip / revise / 失败。`revise` 不是终局：它注入一条用户消息，本轮治理重新开始
   （`src/loop/orchestrator.js:3156-3178`）。修订重试次数受 `finalGuardMaxRetries`
   约束（默认 2，`budgetRounds`，`src/loop/orchestrator.js`），guard 自身超时默认 30s
   （`budgetRounds`，`src/loop/orchestrator.js`）。
   强制收尾产出的正文是**只在 payload 面**的（issue #467）：它经 `result.finalText`
   到达宿主，另在账本里多出一条由 `appendEngineMessagesToTranscript`
   （`src/loop/orchestrator.js`）写的行，而这条行的 `roundKey` 与最后一条轮记录
   **相同**——只有 `dedupKey` 能区分两者——并且它**从不经事件**到达宿主：`forced_final`
   只带 `{type, round, reason}`，`run_outcome` 不带 `finalText`。因此只按事件渲染的
   宿主，修完之后仍然会把评审卡当成最后一条可见内容。又因为 `accept` 永远不得建立在
   `finalText` 非空之上（见 `S6a`），宿主侧的验收判定必须读 `termination.forcedFinal`。
8. **`fail()` 分类**——任何时刻抛错都会用 `aborted`（信号已置）或 `failed` /
   `persistence_failed` 替换掉上面全部（`src/loop/orchestrator.js:1058-1116`）。

**中途「目标已达成」 advisory —— `reflection.judgeDoneAdvisory`（issue #322）。**
透明拦截审计若判定 `done: true` 且 `confidence >= 0.7`，今天只有人能看到：
`directionHintText`（`src/loop/reflection.js`）只对 `off_track` 产文本，那条 `reason`
从未进过后续任何 provider 请求。开启该子键后（默认 `false`），这条判定会额外把评审意见
回灌给**主模型**：由 `judgeDoneAdvisoryText`（`src/loop/reflection.js`）生成一条合成的
`user` 文本消息，经 `offerJudgeDoneAdvisory`（`src/loop/run-snapshot-executor.js`）的**单槽**
收下，由 `flushJudgeDoneAdvisory`（`src/loop/orchestrator.js`）在两个 flush 点（正常轮与
resume）投递——同一套策略、同一个槽。宿主可见的保证：

- 消息带 `meta.source: "judge-control"`，因此 `renderConversation`
  （`src/reflection/judge.js`）继续把它排除在外：主模型读得到，judge 读不回自己的意见。
  没有新增 marker 值，排除判据也没改成集合；
- 它是**意见**：不拦任何工具调用、不提前结束任何一轮、不进 `tool_result`。开与关之间
  `termination`、`tool_result` 事实链、usage、工具执行次数完全相同；判定达成后继续扫尾仍是
  合法状态；
- **单槽而非队列**：同一轮多次「达成」覆盖待投递文本而不是追加，因此没有每轮上限、没有合并
  计数、也没有按 transcript 的终身额度；它刻意不进方向提示那条 FIFO，也不参与它的每轮 2 条合并；
- judge 的 `reason` 截断到 200 字符、整条 advisory 截断到 400 字符
  （`JUDGE_DONE_ADVISORY_REASON_LIMIT` / `JUDGE_DONE_ADVISORY_LIMIT`，`src/loop/reflection.js`）；
  文案明写这条主张**未独立核验**，并要求「已满足就只做交付总结、不要新增工作；有缺项就只补必要项」，
  绝不出现「已核验/已验证」；
- 同一个子键同时门控 `directionHintText`（`src/loop/reflection.js`）里 `uncertain` 的**中性**文案：
  关闭时 `uncertain` 依然一条方向提示都不产、provider 请求序列与不开本选项时**逐字相同**；开启后
  `uncertain` 不再被说成「当前路线可能偏，可考虑换思路」（那句会诱导模型多做路线尝试）。
  两种情况下 `off_track` 的文案与注入时机都不变；
- 非布尔值在启动期抛 `TypeError: reflection.judgeDoneAdvisory must be a boolean`，且不新增任何
  judge 调用；
- 已知毛刺（本单刻意不修）：待投递的 advisory 不属于 run snapshot，因此若在一次 flush 发生之前
  resume，这条意见会丢失。


## Reflection 决策解析（issue #305）

`parseReflectionDecision`（`src/loop/reflection.js`）把 reflection 模型的一次回答
解析成治理器要消费的决策对象。它是**宿主可见 API**：包入口（`src/index.js`）与
`src/loop/orchestrator.js` 都把它再导出出去，而引擎自身从不调用它。

**JSON 抠取用的是顶层平衡扫描**，不是贪婪正则。扫描只有一处实现 ——
`jsonCandidates`（`src/text/json-candidates.js`），从收尾 JSON 解析器
（`tryParseWrapupJson`，`src/reflection/wrapup.js`）逐字提取而来，后者的行为
一字未改 —— 于是本包里两个「模型 JSON 解析器」不再对「对象到哪里结束」各持一说。
该扫描感知字符串与转义，**只**产括号深度归零的对象，外层未闭合的对象**一个都不产**。

| 字段 | 取值 | 模型没写这个字段时 |
|---|---|---|
| `progress` | 来自 `progress` 的有限数 | `undefined` |
| `stalled` | 只有字面 `stalled: true` 才是 `true` | `false` |
| `continueFlag` | 只有字面 `continue: true` 才是 `true` | `false` |
| `stallPattern` / `reason` / `plan` | 该字段的 `String(...)` | `""` |
| `via` | `"json"` 或 `"prose_fallback"` | 恒在 |

`via` 声明的是取值**来源**，不是 schema 结论：`"json"` 表示值来自可解析的顶层对象，
`"prose_fallback"` 表示值来自对整段文本的关键词匹配。六个字段**全部可缺省**，
所以 `{"progress":3}` 这样的半集是合法决策，仍走 `"json"` 路径。只有一处刻意例外：
顶层对象解析成功却**一个都不含**
`progress`/`stalled`/`continue`/`stallPattern`/`reason`/`plan` 时，什么都搬运不过来，
结果按 `"prose_fallback"` 上报。

修好之前用的是贪婪 `/{[\s\S]*}/`：尾话里出现一对花括号（散文里的 `{plan}` 占位符、
```` ```json ```` 围栏后面跟一句说明、或者并列的两个顶层对象）就会抠出一坨解析不了的东西；
`JSON.parse` 抛错，关键词兜底便在**含 JSON 自身的**整段文本上匹配 —— 于是它匹配到的是
那些键名，把模型刚刚明确写下的布尔值静默翻了个向（`"continue": false` 回来变成
`continueFlag: true`）。

两处邻居**有意不动**：兜底路径的 `reason` 截断口径保持 `value.slice(0, 200)`
（UTF-16 码元），尽管 `truncate`（`src/reflection/judge.js`）用 `Array.from` 按码点计数
—— 统一它会改动宿主可见的值；轮次 judge（`parseJudgeDecision`，`src/reflection/judge.js`）
也照样从**每个** `{` 起扫一次，外层未闭合时返回的仍是内层残片。issue #307 只是把那份扫描
搬进 `parseModelJson`（`src/text/parse-model-json.js`）当作它的 `topOnly: false` 档 ——
行为逐字相同 —— 改这个裁决本身归 issue #309。

## 统一入口 `parseModelJson`（issue #307）

`parseModelJson`（`src/text/parse-model-json.js`）是本包从模型文本里抠 JSON 的**唯一公共
入口**。在这之前，四处地方各干这件事、对「对象到哪里结束」给出四种答案；其中两处（reflection
解析器与轮次 judge）现在都由这一个入口供给。它从包根（`src/index.js`）导出，并被
`engineApiContract` 覆盖。

```js
import { parseModelJson } from "erix-agent";

// parseModelJson(text, { topOnly = true, requireKeys = null } = {}) ->
//   { ok: true, value, via: "json", candidates } | { ok: false, error, candidates }
const hit = parseModelJson('reasoning {"done":true,"confidence":1} trailing prose');
if (hit.ok) {
  // hit.value — JSON.parse 的直接产物（字段校验归调用方），
  // hit.via — 字面量 "json"，hit.candidates — 按出现顺序的全部平衡切片
} else {
  // hit.error — "no_candidate" | "unparsable" | "shape_mismatch"；这一支没有 `value` 键
}

const unparsable = parseModelJson('{"a":,}');
const shapeMismatch = parseModelJson('{"confidence":0.5}', { requireKeys: ["done"] });
const noCandidate = parseModelJson('{"a":1');   // 外层未闭合：什么都不产，也不补括号

if (hit.ok !== true || hit.via !== "json" || hit.value.done !== true) throw new Error("example input must hit");
if (unparsable.error !== "unparsable" || shapeMismatch.error !== "shape_mismatch"
  || noCandidate.error !== "no_candidate") throw new Error("the three failure kinds must stay distinguishable");
if ("value" in unparsable || "value" in shapeMismatch || "value" in noCandidate) {
  throw new Error("a miss carries no value key, not even value: undefined");
}
```

失败是**三态**判定，因为三种原因需要宿主做三件不同的事（换提示词 / 认了它没按 JSON 回答 /
去补那个缺的字段）：

| `error` | 什么时候出现 |
|---|---|
| `no_candidate` | 扫描件一个候选都没产 —— 纯散文，或花括号始终不配对 |
| `unparsable` | 有候选，但 `JSON.parse` 全部抛错（例：`{"a":,}`） |
| `shape_mismatch` | 有候选解析成功，但没有一个满足 `requireKeys` |

**没有 repair。** 不补闭合括号、不删尾逗号、不改值：解析不了的候选就是落选（本文档的
「归一化器只许搬运」章程）。失败结果里**没有** `value` 键 —— 不是 `value: undefined` ——
于是 `if (!result.ok)` 之后手里真的什么都没有，也不会把一次失败的解析误当成「模型回了个空对象」。

`candidates` 恒为**完整**扫描结果（按出现顺序，含未胜出的候选），所以调用方可以在它之上
跑自己那份更严的逐候选校验 —— `parseJudgeDecision`（`src/reflection/judge.js`）正是靠这一
点在自己不再持有扫描器的情况下保持行为不变。

**两档扫描，仍然只有一份文件。** `topOnly` 缺省 `true`：只有括号深度归零的对象才是候选，
外层未闭合时什么都不产。`topOnly: false` 从**每个** `{` 起扫一次，于是外层未闭合时会先产
内层残片；这一档只为让 `parseJudgeDecision`（`src/reflection/judge.js`）复用同一份扫描而
**行为零变更**而存在（改那个裁决归 issue #309）。

`requireKeys` 判的是键**存在性**且是 any-of —— 候选至少含有列出键中的一个即合格 —— 且从不
看值类型。这与 `jsonCandidates`（`src/text/json-candidates.js`）的分工一致：扫描共享，结论
归调用方。空数组或 `null` 表示「不做形状校验」。

四处各自去了哪里、为什么：

| 位置 | 裁决 | 理由 |
|---|---|---|
| `parseReflectionDecision`（`src/loop/reflection.js`） | **已迁**（缺省档 + `requireKeys` = 六个决策键） | 行为与 issue #306 发布的版本逐字相同；对拍用例拿它和那份实现的副本比，覆盖已知形状加 3000 条确定性随机输入 |
| `parseJudgeDecision`（`src/reflection/judge.js`） | 扫描器换成公共入口的 `topOnly: false`，**它自己的逐候选循环留着** | judge 必须跳过「能解析但不合格」的候选（`done` 不是字面布尔、`confidence` 不在 [0,1]）再试下一个；公共入口只返回单个 `value`，直接拿它当结论会把「跳过这个候选」变成「整次解析失败」 |
| `tryParseWrapupJson`（`src/reflection/wrapup.js`） | **未迁**，仍直接调 `jsonCandidates` | 它的门槛比键存在性严（`done` 必须字面布尔；出现 `action`/`note` 就把对象退回内联 L1 路径），而且同样必须「跳过并续试」。跳过是承重的：`{"done":"true"}{"done":true}` 必须返回第二个。内层的 `{"done":…}` 不得绕过那条 mandatory-done 守卫（issue #30 follow-up），所以这里的扫描继续保持只认顶层 |
| `extractL0Facts`（`src/reflection/l0.js`）、`parseFoldSummaryMatch`（`src/compact/fold-statistical.js`） | **不在本单** | 两者都不是「在模型散文里找 JSON」：L0 取的是模型散文里的 `<erix-summary>` 标签——注意**引擎并不要求模型写它**（issue #465：`parseL1Summary` 只做读侧解析，`src/` 内没有任何提示词注入点，宿主既不注入也不提示时恒落 `summary: "missing"`），折叠摘要读的是**引擎自己**写下的 `导航记录：{…}` 行并且 fail-closed 到 `undefined`。去掉标签 / 行锚定会放宽它们接受的形状 —— 那是行为变更，不是去重 |

## 带可选兜底的模型输出归一化：`normalizeModelJson`（issue #406）

`normalizeModelJson`（`src/normalization/parse-model-json.js`）是 `parseModelJson`
（`src/text/parse-model-json.js`）的**异步**兄弟。它存在的原因很具体：宿主此前各自从模型
输出里抠 JSON，而每一种方言——围栏块、尾逗号、单引号、Python 字面量、截断的答案——都从不同
实现那里拿到不同答案。

**它不取代 `parseModelJson`，两者也不许合并成一个函数。** 一个是同步、绝不修复；另一个是异步、
只修结构，末尾还带一次可选的模型调用。宿主同时 `await` 两个，会从一个拿到值、从另一个拿到
`Promise`；而把它们折成一个函数，会让每一处既有的 `parseModelJson` 调用点静默改变行为。

| | `parseModelJson`（`src/text/parse-model-json.js`） | `normalizeModelJson`（`src/normalization/parse-model-json.js`） |
|---|---|---|
| 层 | L0，严格档 | L1 确定性修复 + 闸门 + 可选 L2 兜底 |
| 同步性 | **同步** | **异步**（恒定返回 `Promise`） |
| 修不修 | **绝不修** | 只修结构——值的字节保原样 |
| 发不发请求 | 从不 | 只有 `llm: true`、候选非空**且**每个确定性候选都失败时才发 |
| 结果 | `{ ok, value, via, candidates }` / `{ ok: false, error, candidates }` | `{ ok, value, repaired?, llmUsed?, dropped? }` / `{ ok: false, error, llmUsed? }` |

失败三态沿用**同一组名字**，但两边的映射**不一一对应**，宿主必须按对的那一档分流：

| `error` | `normalizeModelJson` | `parseModelJson` |
|---|---|---|
| `no_candidate` | 输入为空，或截断输入——**任一**候选是截断形状（补全规则改得动它） | 什么都没扫出来（纯散文，或括号永不闭合） |
| `unparsable` | 有候选但每个都解析不了——**纯散文落这一档**，因为整段原文本身就是候选 | 有候选但每个 `JSON.parse` 都抛 |
| `shape_mismatch` | 有候选解析成功，但一个都没过 `validate` | 有候选解析成功，但一个都不满足 `requireKeys` |

这里**如实公开两处**差异（不粉饰）：宿主只要把其中任一处读成「和 `parseModelJson` 同一个答案」，分流就会错。

**① `parseModelJson` 只可能返回对象。** 它的扫描只找**顶层平衡对象**，拿到值之后还会把数组 /
非对象判掉（`src/text/parse-model-json.js` 逐条跳过），所以**顶层非对象**根本成不了候选：`[1,2]`、
`123`、`"hello"`、`null`、`true` 在那边一律 `no_candidate`，在这个入口一律 `ok` 且值就是它
（**没有** `repaired` 键——什么都没被改写）。本入口的 `no_candidate` 只对应上表那两档，**不要**
读成「这里没有 JSON」。

**② 补全规则修不动的截断是「一类」，不是单个形状。** 这一类的每一个形状在 `parseModelJson` 是
`no_candidate`（括号永不闭合 ⇒ 扫描一个候选都不产），在本入口是 `unparsable`（候选集复用的是
L0 那份扫描，而它产出的候选没有一个补得出来——补全要求「补完即可 `JSON.parse`」）。本分支实测：

- 片段**前**夹散文 — `前言 {"a":1`；
- 片段**后**夹散文 — `{"a":1 以上是结果。`；
- 片段**不是对象** — `前言 [1,2`（L0 的扫描只产对象，所以一个候选都活不下来）；
- 围栏内的截断之后又夹散文 — 一个块体为 `{"a":1 以上是结果。` 的 `json` 围栏（围栏块体是整块
  剩下的全部，散文也在里面）；
- #406 那个场景：截断的**工具引数**串，值里带**裸换行** —
  `{"tool":"readFile","args":{"path":"a<newline>以上`：补全得先修一个非法字符、而不只是
  闭合括号，所以这段文本连截断形状都不是。

最后一条有个必须点名的边：把同一个换行写成**两字符的 JSON 转义** `\n`
（`{"tool":"readFile","args":{"path":"a\n以上`）时，它**是**截断形状、补得成一个可解析的
对象，两边都是 `no_candidate`。差异的成因是**裸换行那个字节**，不是工具引数这个形状。

两个入口说的是同一件事（「这里没有 JSON」），只是数尝试的方式不同。这是**一类**形状——任何
补全规则改不动的截断——不是单个特例，`test/normalization/parse-model-json.test.js` 逐条钉住。

**出处是 `repaired`，且只有真的改了文本时才有这个键。** `repaired: { rule, trusted }`：
`rule` 是**实际生效**的规则 id 按施加顺序用 `+` 连接；`trusted` 为 `true` 当且仅当生效的全是
引擎自带规则。宿主经 `repair.inject` 注入的规则一律 `trusted: false`——引擎替不了宿主证明
别人那条规则的保字节性。所以能解析的输入**根本没有** `repaired` 键（不是 `repaired: null`）。

**闸门永远对候选的原始字节判。** `validate` 的调用形状是 `validate(value, source)`，其中
`source` 是**输入原文的切片**——绝不是修后文本。这是整层承重的不变量：一条会改写值的修复
（比如把 `http\.request` 改成 `http.request`）否则就能拿调用方从未见过的文本过掉
`source.includes(value)` 这类逐字核验，那就是一条**被静默伪造的值**。**补全版**候选同样受这条
约束：闸门拿到的是**补全前**的原文（输入 `{"a":` ⇒ 闸门看到 `{"a":`，不是 `{"a":null}`）——
否则一条补全规则就能凭空造一个字符串值，而每一道逐字核验都会放行它。第二个参数是 additive 的：
只写 `(value) => …` 的宿主照旧可用，但那样它就放弃了「证明值没被改写」的能力。

`source.includes(value)` 这个配方有一条限定，而且它正是 #406 的主场景（工具引数里就是**带 `\n`
的代码串**）：那道逐字核验只对**不含 JSON 转义**的字符串值成立。模型写成 `"line1\nline2"`、
`"tab\there"`、`"quote\"inside"` 的值，到 `validate` 手里已经是**解码后**的（`\n` 是真换行），
原文切片里永远不可能逐字包含它——于是天真的 `includes` 会把一个完全合法的值误杀成
`shape_mismatch`。这类值要**两侧解码后比**：把切片解出来（`JSON.parse(source)`）比值，或拿
`JSON.stringify(value)` 去掉首尾引号后比，而不要在原始文本上做逐字节搜索。

**候选**是整段原文、每一个围栏块（**含未闭合围栏剩下的那段块体**）、以及 L0 的扫描抠出的
**每个顶层平衡对象**，按这个顺序逐个独立试完再过闸门；第一个「可解析 **且** 过闸门」的候选
胜出。**这个顺序是承重的**：围栏块排在 L0 扫描**之前**，所以更晚出现的围栏对象会**压过**文本里
更早的顶层对象——`{"a":1}` 后面跟一个装着 `{"b":2}` 的 `json` 围栏，本入口给 `{"b":2}`，
而 `parseModelJson` 给 `{"a":1}`。第三档复用 L0 的扫描（`jsonCandidates`（`src/text/json-candidates.js`）），
存在的理由就是设计裁定 D1（「内部调 L0，不复制扫描」）：只有「整段原文 + 围栏」时，这个入口会
比它声称包装的 L0 **更弱**。测试文件里钉住的每个形状都是「整段原文与每一个围栏块体都解析不了」
的那一类，于是唯一能胜出的候选只能来自 L0 的扫描
（`好的，结果如下：{"done":true}`、`{"done":true} 以上是结果。`、`{"a":1}}extra{`、
`前言 {"outer":{"done":true}} 后语`、`~~~json` 围栏）。
`repair.truncateCompletion` 显式开时，每个候选的补全版会作为**额外**候选追加在末尾。补全与规则表
**串联**跑（先本档启用的规则，`truncation` 最后），这才是它真能救回东西的原因：纯截断、围栏里的
截断（**闭合与未闭合围栏都算**）、以及截断叠加结构缺陷（`{"a":"x\\.y"` ⇒ `invalid-escape` 先把
转义加倍，再补 `}`）——出处会把生效的规则逐个点名（`invalid-escape+truncation`）。它**救不回**
补全规则改不动的那类截断（见上面 `no_candidate` 那条差异），且它默认关，所以本来就完整的输入绝不会凭空
长出 `truncation` 出处。

```js
import { normalizeModelJson } from "erix-agent";

// normalizeModelJson(rawText, { validate?, provider?, slot?, llm?, thinking?, maxTokens?, signal?, repair?, schema? })
//   -> Promise<{ ok: true, value, repaired?: {rule, trusted}, llmUsed?: true, dropped? }
//             | { ok: false, error: "no_candidate" | "unparsable" | "shape_mismatch", llmUsed?: true }>
const clean = await normalizeModelJson('{"done":true}');
if (clean.ok !== true || clean.repaired !== undefined) throw new Error("a parseable input is not repaired");

const repaired = await normalizeModelJson('{"done":true,}');
if (repaired.repaired.rule !== "trailing-comma" || repaired.repaired.trusted !== true) {
  throw new Error("provenance must name the rule and whether the engine trusts it");
}

// 闸门的第二个参数是候选的**原始字节**，绝不是修后文本。
const raw = '{"path":"a\\.b"}';
const injected = { id: "host-unescape", apply: (text) => text.replace("a\\.b", "a.b") };
const gated = await normalizeModelJson(raw, {
  repair: { inject: [injected] },
  validate: (value, source) => ({ ok: source.includes(value.path) }),
});
if (gated.ok !== false || gated.error !== "shape_mismatch") {
  throw new Error("a value the original text does not contain must be rejected");
}

// 截断输入：与同步入口同一判词，除非显式开补全。
const truncated = await normalizeModelJson('{"outer":{"done":true}');
if (truncated.error !== "no_candidate") throw new Error("truncation is not repaired by default");
const completed = await normalizeModelJson('{"outer":{"done":true}', { repair: { truncateCompletion: true } });
if (completed.repaired.rule !== "truncation") throw new Error("opting in must be visible in provenance");
```

可选的模型调用（L2）是这里**唯一**会花钱的东西，`llm: true` 是它唯一的开关：只有每个确定性候选
都失败之后才发，而且候选集为空时**一次都不发**（空输入 / 纯空白 ⇒ 零请求，没有原文可交给模型）。
请求恒定带 `reasoning_effort` 且钉在不思考的取值上（归一化文本不是推理任务），
它的产物仍要过同一道 `validate` 闸门——L2 的产物过不了闸门就是 `shape_mismatch`，绝不静默接受。

`loadModelSlot` / `createProviderForSlot`（`src/config/slot-provider.js`）的存在，是让宿主不必自己
写一份配置读取就能拿到 L2 需要的 provider：前者读 `slots.default` 并校验必填字段
（`config_missing` / `config_invalid`），后者把槽位摊平成 OpenAI 兼容 provider。

#### 可选调用的成本

每次调用**最多 1 个请求、从不重试**：`llm: true` 买的是一次归一化机会，第二个请求不会发——解析
失败不发、闸门判掉不发、模型答歪了也不发。这里也**没有内建的成本上限**：`maxTokens` 不新造
默认值（不传就用 provider 自己的默认），选项面上**没有 timeout 旋钮**——唯一的超时是 `slot`
路径钉死的那个，`DEFAULT_PROVIDER_TIMEOUT_MS`（`src/config/slot-provider.js`）= 300 s 硬挂钟
上限（每请求）。`slot` 这条路还意味着**读盘**：它的起点是 `loadModelSlot`，在拼请求之前先读并
校验配置文件，所以把这条路径放进热循环的宿主每次调用都要付一次文件 I/O。最后：provider 抛错时是
**抛异常**出 `normalizeModelJson`，**不会**折进那三个失败态。宿主需要自己的成本 / 失败上限，就在
调用点包一层。

#### 引擎的收尾归一化走的就是这个入口（issue #406 B2-b）

循环自己那条收尾归一化——`end_turn` 轮、无工具调用、解析不出信封时触发的兜底，开关是
`reflection.wrapupNormalize` / `ERIX_WRAPUP_NORMALIZE=1`——不再自己拼一份请求。它调
`normalizeWrapupText`（在 `src/reflection/wrapup.js`），后者转调 `normalizeModelJson`，
`thinking: "none"`、信封形状作为 `schema` 示例；公开入口 `normalizeWrapupWithLlm` 是同一个
函数的薄壳。一个实现 = 两个调用方共用同一份提示词、同一道闸门、同一个「不思考」取值、同一份
失败事实。五条宿主可观察的后果：

- **只有一份提示词，上下文也少了。** 旧的内联提示词（任务目标、已运行轮数、
  `JSON.stringify(text)`）与旧的收尾专用提示词都删了。留下来的请求是本入口的通用「把原始
  文本归一化」提示词 + 信封形状示例，所以归一化器看到的是原文与形状——**不是**任务目标或
  轮数。**这是一条质量风险，按风险写**：`done` 剩下的唯一线索是那个形状示例（它的 `done` 是
  `false`），因为旧内联那句判据（「已给出明确结论 / 产物就绪 ⇒ `done=true`；中途停下或放弃 ⇒
  判断产出是否可判定」）随那份提示词一起删了，而**没有任何测试钉住统一提示词下的 `done` 语义**。
- **闸门共享，而且判的是 agent 自己的原文。** 每个 `findings` 值必须逐字出现在 agent 的原文
  里；不在的条目**在本入口静默丢弃**——`dropped` 清单只在下一层（`normalizeModelJson` / `wrapupGate`
  的返回值）可见，收尾归一化的返回值上**没有**它——而不是把整个信封拒收。这道判据从不拿归一化
  器自己的回答当 `source`——那等于让它给自己的改写作证。公开入口现在也过这道闸门；B2-b 之前
  它对一条被改写的值（例如 agent 原文写 `gold-417`、归一化器答 `gold-4173`）**一点检查都没
  有**。
- **确定性修复命中就不发请求。** L1 规则修得动的形状——尾逗号、加倍的非法转义——用**零**次
  模型调用就归一化完，字符串值的字节保持原样。B2-b 之前这些形状要花一次模型调用。
- **空文本 / 纯空白原文一次请求都不发。** 候选集为空，本入口不花这次调用（见上面 L2 那一
  节）。循环随后走它普通的无工具路径，终稿就是模型这一轮的真实输出（可能是空串）。B2-b 之前
  内联路径对空文本也会发一次请求。
- **失败是结构化的。** 入口返回 `{ ok: false, error }`；循环在第一次失败后仍然把本 run 的归一
  化开关就地关断（与之前同一语义——不会每轮重试），provider 抛错仍走循环的 `catch` 降级。
  `normalizeWrapupWithLlm` 在归一化失败时返回 `null`，evaluator 自己抛的错照旧抛出来。

公开入口就是同一个函数，所以上面这些后果对它同样成立：原文本身就是可解析信封、或 L1 规则修
得动的输入 ⇒ **不发模型请求**直接返回；空 / 纯空白输入 ⇒ 一次请求都不发、返回 `null`（以前
会发一次）。归一化器自己的回答也过同一套 L1 规则（`{"done":true,}` 以前算失败并关断本 run 的
归一化，现在会被修好）。

`summary` / `output` 是给用户看的散文、不是声明的事实，所以**不**做逐字核验；只核 `findings`。

## 可复用的归一化原语

## 可复用的归一化原语

自带 OpenAI 兼容传输层的宿主可以从包根导入这些辅助函数。它们不做 I/O，也不调用模型：

| 导出 | 签名 | 语义 |
|---|---|---|
| `normalizeOpenAIUsage` | `(usage) -> canonical usage \| undefined` | `null`/`undefined` 返回 `undefined`；其他输入返回对象，把存在的 `prompt_tokens`/`completion_tokens` 映射为 `input_tokens`/`output_tokens`（所以 `{}`、数组、字符串都得到 `{}`）。**不接受** canonical alias。 |
| `normalizeOpenAIStopReason` | `(reason, fallback = "unknown") -> string` | 把 `stop`、`tool_calls`/`function_call`、`length` 映射为规范 stop reason；未知值原样透传。 |
| `parseOpenAIToolArguments` | `(rawArguments) -> any` | 解析 JSON；缺省时返回 `{}`；畸形值放在 `_truncatedArguments` 与 `_raw` 下返回。自 issue #409 起它走与引擎工具循环同一条「先 L0 再 L1」的路径（非法转义是加倍、绝不删除），所以修得出来的 payload 现在会返回解析后的对象；仍然失败的 payload 逐字保留旧的 `_truncatedArguments`/`_raw` 形状。判词不在这个返回值上——它挂在 `tool_use` 块的 `erix.argumentsParseError` 上。 |
| `createOpenAIStreamAccumulator` | `() -> accumulator` | 累积带索引的或 legacy 的流式 tool-call 片段；`getToolUseBlocks()` 返回规范 tool-use 块。 |

`createOpenAIStreamAccumulator().addToolCallDelta()` 接受 OpenAI delta 或
`{ index, id, name, argumentsDelta }`；`addFunctionCallDelta()` 接受 legacy
`function_call` delta。畸形参数的行为刻意与库内规范响应转换保持一致。

## 终答核验

宿主消费 `runToolLoop` 结果前，必须检查 `verification.status`：

| 状态 | 契约 |
|---|---|
| `verified` | loop 用于表示由已配置 guard 接受的终答的唯一状态。 |
| `skipped` | 没有可供 guard 比较的内容，或 guard 未启用。**这不表示答案正确**，不得改写为 `verified`。CLI 退出码为 4，因此“没核验”与 `verified`（退出码 0）可区分。 |
| `unverified` | 未满足所需的来源核验。CLI 退出码为 2；宿主不得将该结果作为成功结果消费。 |
| `error` | guard 抛出异常、返回无效决策或超时。CLI 退出码为 3；宿主不得将该结果作为已核验事实消费。 |

`finalGuard` 在 `runToolLoop` 和 CLI 中均为 opt-in。在 `runToolLoop` 中省略它会产生
`status: "skipped"` 且 `reason: "no_final_guard"`。CLI 用 `--final-guard` 或
`ERIX_FINAL_GUARD=1` 启用；默认关闭，`--no-final-guard` 是兼容 no-op。`finalGuardTimeoutMs`
默认 30000，非正值使用默认值。上述退出码只描述核验结果；常规 provider、工具或循环失败
走正常失败路径。

`verification.metrics` 是 guard 的**裁决计数**，不是第二个判决：`metrics.verified` 数的是
返回 `accept` 的 guard 调用次数，所以一次被 `max_rounds_cap` 掐停、guard 判 `accept` 的 run
会读到 `metrics.verified: 1`，而 `verification.status` 仍是 `unverified`
（`reason: "non_continuable"`、`termination.reason: "final_guard_unverified"`）——计数说的是
「裁决发生过」，状态说的是「什么都没被接受」。判「是否验收」只准读 `verification.status`；
`metrics` 是观测面，任何时候都不得当成状态来读。

loop 在因 `end_turn`、`no_tool`、`judge_done`、`max_rounds_cap`、`stall`、
`continuation_exhausted` 停机前，会调用已配置的 guard。guard 收到
`finalText`、`findings`、`messages`、`round`、`rounds`、`signal` 与 `termination`。
`findings` 是结束信封声明的 `label -> 精确值` 映射，是可核验断言的权威载体；核验不解析
`finalText`。`{ action: "accept" }` 允许正常终止。`{ action: "skip", reason }` 以
`skipped` 终止。`{ action: "revise", message }` 会作为独立 user 文本消息注入并继续循环，
最多 `finalGuardMaxRetries` 次修正重试（默认 2）。若到上限仍需修正，loop 保留最后的
`finalText`，把 `verification.status` 置为 `unverified`，并以
`termination.reason === "final_guard_unverified"` 终止（fail-closed）。

不可续的停机原因 `max_rounds_cap`、`stall`、`continuation_exhausted`
不会仅因 guard 返回 `accept` 就变成 verified；它们降级为
`final_guard_unverified`。guard 抛错、返回无效决策或超时，对循环可用性是 fail-open：
原终止原因保留，但 `verification.status` 为 `error`，结果永远不会是 `verified`。
每种 guard 结果都发出 `onEvent` 事件，`type: "final_guard"`，`action` 为 `accept`、
`skip`、`revise`、`degraded` 或 `error`。当 store 提供 `markRunState` 时，终态为：
未核验结果 `unverified_error`、guard 错误 `guard_error`、其余 `succeeded`。

#### 预算类停机上的补跑桥：`finalGuardExtend`（issue #386 切片 3）

`finalGuardExtend: boolean`，**默认 `false`**。不传或传 `false` 时，每一类预算停机都与上面那段
逐字一致。传 `true` 时，**预算类**停机（`max_rounds_cap`、`continuation_exhausted`）上的 `revise`
裁决可以借引擎**既有**的中途扩轮机制——`extensionAllowed`（`src/reflection/governor.js`），落地动作
`applyGovernorExtension`（`src/loop/orchestrator.js`）：同一份计数器、同一种
`meta.source: "judge-control"` 的 user 消息——**最多补跑一次**，而不是直接降级。四个条件必须同时成立：

| 条件 | 细节 |
|---|---|
| 停机原因 ∈ `{max_rounds_cap, continuation_exhausted}` | **`stall` 永远不补**——stall 的定义就是「连续无进展」，给它轮次是纯烧钱。集合是 `FINAL_GUARD_EXTENDABLE_REASONS`（`src/loop/termination.js`）；`FINAL_GUARD_NON_CONTINUABLE_REASONS` 与每一个 `termination.reason` 取值都一字未改 |
| `finalGuardExtend === true` | 宿主显式 opt-in；`null` / 数字 / 字符串一律 `TypeError`（`"false"` 这种写法绝不许把它打开） |
| guard 本轮裁决是 `revise` | `accept` / `skip` / guard 报错都不触发——桥只服务「guard 知道还差什么」那一格 |
| `extensionAllowed` **且** 预算闸 | 与中途扩轮**同一份**计数器（`extensionCount < reflection.maxExtensions && effectiveMaxRounds < reflection.maxRoundsCap`），外加：最近一次真实 API 输入已超 `context.budgetTokens`（`isApiInputOverBudget`（`src/loop/budget.js`））、或本 run 的单轮聚合输出预算已经归档/stub 过工具结果（`src/loop/aggregate-budget.js`）时拒绝。给一个已经超预算的 run 补轮 = 撕掉预算承诺 |

成本与观测面：

- **每个 run 最多 1 次**（`governorState.guardExtensionUsed`），与 governor 自己的扩轮额度
  **互相独立**——guard 拿不到第二份「继续跑」的预算；
- 配额**进 run state**（`deterministic.guardExtension.used`，`src/run-state.js`，由
  `src/loop/resume-manager.js` 恢复），且**跨 resume 不重置**：「跑 → 崩 → resume」不许每次
  都铸一份新配额。没有该字段的旧 state 读作「没用过」；
- 新事件 `{ type: "final_guard_extend", round, from_max_rounds, to_max_rounds, guard_extension: true }`，
  以及 `verification.metrics.guard_extensions: 1`——**只在真的补跑过时**出现。未 opt-in（或 opt-in
  但一次都没补）的 run，其 `verification` / `metrics` 与今天逐字相同；
- 补跑发生在触发它的那次停机**已经强制收尾之后**，所以补跑过的 run 即使最后以 `end_turn` 收场，
  `termination` 里也可能带 `forcedFinal: true`（强制收尾确实跑过，之后才继续）。桥不改写任何
  `termination.reason` 取值，也不引入新的停机原因。
- 若那次停机在末条 assistant 上留下了**悬空 `tool_use`**（强制收尾那一轮模型回的是工具调用而不是
  纯文本），桥会先用一条引擎自写的 `tool_result` 把它结清（`is_error: true`，正文取
  `PENDING_TOOL_RESULT_TEXT`（`src/loop/pending-tool-result.js`），以 `[erix]` marker 开头），**然后**才注入
  控制文本（issue #393）。注入的 user 消息绝不能把 `tool_use` 与它的结果隔开——否则**本库自己的消息
  校验器**会在任何一个请求发出**之前**本地抛 `invalid_messages` 拒掉整份历史，宿主收到
  `termination: failed`（2026-10-22 实测更正：**零 HTTP**，拒的不是 provider；规矩按本库说的两协议里
  最严的那一档立——Anthropic 形状对这个形状回 400，而实跑的 OpenAI 兼容中转会回 200 并让模型自己编
  一个结局）。那条 `tool_result` 陈述的是事实
  （「这次调用根本没跑」），所以该调用**不会**被执行；`tool_use` 的 id 读不出来的畸形尾巴补不出合法
  结果，这一格**不补跑**，行为与未 opt-in 完全一致。
- **同一个结清动作在**每一条**引擎自写控制消息之前都会跑，不只是补跑桥**（issue #394）。另外两个注入点
  原先有同一个洞：**强制收尾**（`forceFinalIfNeeded`（`src/loop/termination.js`），它的
  `【强制收尾】` 指令从前是**先 push、后**校验消息序）与 **`revise` 续跑消息**（
  `applyGovernorExtension`（`src/loop/orchestrator.js`）覆盖的是扩轮那一路；停机后那条 `revise`
  消息是兄弟洞）。三处现在都调同一个共享实现 `answerPendingTailToolUses`
  （`src/loop/pending-tool-result.js`），判据复用 `pendingTrailingToolUses`
  （`src/messages/rounds.js`）、结果块复用唯一构造点 `buildToolResultFact`（`src/tool-fact.js`）。
  于是「末条 assistant 带一条没人回答的 `tool_use`」的 run——**被截断的工具调用轮**：provider 回了
  `max_tokens` / `finish_reason: "length"` 且带 `tool_calls` / `tool_use` 块，续写预算又用尽——
  现在能拿到真实终局，而不是 `failed` / `invalid_messages`。**这是行为变化**：这种 run 从前以
  `termination: { reason: "failed", errorCode: "invalid_messages" }` 被拒（CLI 退出码 **1**）且
  **终稿丢失**；现在以 `continuation_exhausted` 收场、`finalText` 有值（没配 `finalGuard` 时 CLI
  退出码 **4**，因为 `verification` 仍是 `skipped` / `no_final_guard`），并多出一条引擎自写的
  `tool_result` 与一行 `:control:` 档案行。那条 `tool_result` 同样只是陈述事实——该调用**不会**被执行，
  模型可以重新发起；`tool_use` 的 id 读不出来的畸形尾巴**不结清**，run 仍如实报 `invalid_messages`。
  把 `failed`（或退出码 1）当「可重试」的宿主需要重新判断：这些 run 现在会正常跑完。

引擎没有独立的“交付认证”或“完成认证”层。它报告轮数、工具、文件调用、归档、终止与核验
等事实。任务是否完成、交付物是否满足要求、能否自动进入下游，仍由宿主、测试系统或人工
审核决定。

### `finalGuard` 载荷：既有 7 键 + 10 个加法事实（issue #386）

payload 由 `callFinalGuard`（`src/loop/termination.js`）组装。上面列的 7 个键
（`finalText`、`findings`、`messages`、`round`、`rounds`、`signal`、`termination`）是原有契约：
名字、类型、**顺序**与取值一律不变。其后是 10 个**加法**键，每个都只在引擎真读得到那份事实时才写
——**缺席就是「没探到 / 没提供」的信号**，绝不用 `null`、`0`、`""` 或 `{}` 冒充：

| 键 | 类型 | 含义 | 上限 |
|---|---|---|---|
| `cwd` | string | 宿主传给 `runToolLoop` 的 `cwd`，原样 | 无——引擎从不解释它（不 `chdir`、不校验存在性、不拼路径） |
| `runId` | string | 宿主传的 `runId`，原样 | 无 |
| `filesWritten` | `[{ path, round }]` | run 的时间线台账里记录的写工具调用 | **最后 50 条**；更早的被丢掉并置 `filesWrittenTruncated: true` |
| `fileWrites` | `[{ path, round, tool }]` | 写工具调用声明的**原始** `tool_use.input[pathKey]` 值（issue #388）：不摘要、不截断，可直接 `stat()` | **最后 50 条**（`FILE_LEDGER_LIMIT`，与引擎台账同一个常量）；更早的被丢掉并置 `fileWritesTruncated: true` |
| `toolStats` | `{ [工具名]: { calls, failures } }` | run 的工具计数，**plain object**（`JSON.stringify(new Map())` 是 `{}`，直接交 `Map` 你只会读到空对象） | 按 `calls` 取**前 40** 个工具名；`toolStatsTruncated: true` |
| `taskBrief` | string | 本次 run 由 `resolveTaskBrief`（`src/loop/task-brief.js`）产出、judge 与收尾看到的那份任务简报 | 2000 码点；`taskBriefTruncated: true` |
| `selfReport` | `{ done, summary, output, findings }` | 模型**最后一次归一化后**的 wrap-up 信封（跑过归一化就用归一化那份；绝不重新解析散文） | `summary` 与 `output` 各 2000 码点；`selfReportSummaryTruncated` / `selfReportOutputTruncated` |
| `usage` | `{ input_tokens, output_tokens, cacheRead?, cacheWrite? }` | run 累计 usage，与结果里那份是同一份 | 无 |
| `elapsedMs` | number | 从 loop 起算的墙钟毫秒 | 无 |
| `attempt` | number | 这是第几次 guard 调用，**1 起且单调递增**（跨 `revise` 重试） | 无 |
| `guardBudget` | number | 本次 run 生效的 `finalGuardMaxRetries` | 无 |

这个面有四条性质必须写明，因为它们最容易读错：

- **`selfReport.findings` 与 `findings` 是同一个对象。** 不存在「`findings` 有值而 `selfReport`
  缺该键」的路径：组装时把 payload 自己的 `findings` 注进 `selfReport`，两者不可能分叉。信封没声明
  任何值时，**两边都没有该键**。
- **`filesWritten[].path` 是摘要参数，不是规范路径。** 它来自 judge 的时间线（`summarizeArgument`
  （`src/reflection/judge.js`）），被截到 40 个码点且**不带任何截断标记**。把它当提示（「这个 run
  写过一条长这样的路径」），核事实请用文件系统、`messages` 里的 tool_result 或 `cwd`；别拿它当 join 键。
  **要精确值就用 `fileWrites[].path`**（issue #388）：它是原始入参值，`stat()`/`existsSync()` 才有意义；
  摘要不是（>40 码点的路径被无声截断，拿它建判据会系统性误拦已经做对的 run）。
- **`filesWritten` 与 `toolStats` 在任何一次 `runToolLoop` 里都在场**（空数组 / 空对象的意思是
  「这个 run 什么都没记」——这本身就是事实）。`cwd`、`runId`、`taskBrief`、`selfReport` 只在真有
  东西可报时在场。
- **开销有上限且已实测。** `node scripts/final-guard-probe.mjs` 离线跑「30 轮 × 4KB 工具输出」：
  `messages` 257,618 字节、加法键 4,789 字节 = **1.86%**（`fileWrites` 落地前是 2,242 字节），
  预算上限是 < 2%。所以宿主可以整包落盘/入队
  而不用怕体积，guard 也可以读事实而不是重解析 transcript（小 run 的 `messages` 是 611 字节，真实 run
  几十 KB 到 MB）。

**权威地位的前提：`verified` 只和 guard 手里的证据一样硬。** `accept` 必须建立在**独立事实**上——磁盘上
的文件、命令的退出码、store 里的一行——绝不是「`finalText` 非空」。探针把这个反例钉成了一个场景（`S6a`）：
只看 `finalText.trim() !== ""` 的 guard，会为一个交付物**根本不存在**的 run 返回 `verified`；而同一份撒谎
脚本交给查磁盘的 guard，在 `attempt: 1` 被抓住、`attempt: 2` 被补救。这个反例现在还多了一格（`S6b`）：同一个
橡皮章 guard 加上宿主声明的 `deliverables` 判据之后，终局是 `unverified` / `deliverables_failed`——拦住它的是
机器闸门，不是一段更好的 prompt（见下一节）。全部都在 `node scripts/final-guard-probe.mjs` 里、零模型调用
可复现——不是口口相传的经验。

### 交付物机器判据：宿主声明、引擎执行的闸门（issue #386 切片 2）

`deliverables` 让**宿主**声明「什么算交付完成」，而**引擎**决定两件事：判据**何时**核、
核不过**有什么后果**。这就是「橡皮章」问题的解药——只看 `finalText.trim() !== ""` 就
`accept` 的 guard，再也不能把「交付物根本不存在」变成 `verified`。

选项形状与校验（任何一条不满足都在 run 启动**之前**抛 `TypeError`，与其它选项同一口径）：

```text
deliverables?: [
  { name: string（非空、同一 run 内唯一）, check: (facts) => boolean | {ok, detail?} | Promise<…> },
  …… 至多 20 条 ……
]
```

- `deliverables` 可选，至多 **20** 条；`[]` 等价于**未声明**（零条判据等于没有判据，行为
  与不传该选项完全相同）。
- `name` 必须是非空字符串，且在同一 run 内唯一。
- `check(facts)` 允许同步或异步。`facts` 就是 **guard 即将拿到的那一份**事实
  （`buildFinalGuardPayload` 的输出，至少含 `cwd` / `fileWrites` / `filesWritten` /
  `toolStats` / `taskBrief` / `selfReport` / `findings` / `finalText` / `attempt` /
  `rounds`）。它**不含** `deliverables` 自己（不自我指涉）。

两条 fail-closed 纪律由契约写死——判据写错或卡住必须**拦住**，不许白放：

| `check` 的结果 | 记账结果 |
|---|---|
| 返回 `true` | `{ ok: true }` |
| 返回 `false` | `{ ok: false }` |
| 返回 `{ ok: boolean, detail? }` | 原样搬 |
| 返回其它任何值（字符串 / 数字 / `{ ok: "yes" }` / `undefined`） | `{ ok: false, detail: "invalid_result" }` |
| 抛异常 | `{ ok: false, detail: "threw" }` |
| 耗时超过 `finalGuardTimeoutMs` | `{ ok: false, detail: "timeout" }` |

超时**复用** `finalGuardTimeoutMs`——没有单独的 `deliverablesTimeoutMs` 旋钮；计时是
**逐条**的（前一条慢不会让后一条被判超时）。

**核验时机：每次调用 guard 之前都核一遍**，不是每个 run 只核一次。于是 guard 判 `revise`
之后，下一次 `attempt` 的判据会自动重算：真补做了的模型能拿到 `verified`，只是换了个
说法的模型拿不到。

结果进两个面，且只在宿主声明了判据时出现：

- payload：`deliverables: [{ name, ok, detail? }]` 与 `deliverablesAllPassed: boolean`。
  guard 因此能看见机器判据的结论，而不是只能读模型的嘴。
- `verification.metrics`：`deliverables_checked` / `deliverables_failed`，一个 run 内累计
  （多次 guard 调用各自累加），与既有的 `verified` / `skipped` / `revised` /
  `unverified` / `guard_error` 并列（既有五个键的语义一字不变），另有
  `deliverables_machine_only`——**只**在「单靠判据就产出了 `verified`」那一格出现
  （guard `skip`，issue #392）。

闸门本身——这个选项存在的理由。它在**每一种** guard 裁决下都成立，不只是 `accept`
（issue #392）：`skip` 的意思是「这次 guard 验不了」，从来不是「交付物没交付」，所以机器结论
在**两个方向**上都压过它。

| 判据结果 | guard 意见 | `verification.status` |
|---|---|---|
| 全部通过 | `accept` | `verified`——与今天一致，只是多记两个计数 |
| **有失败** | `accept` | **`unverified`，`reason: "deliverables_failed"`**——机器证据压过 guard 意见 |
| **有失败** | `skip` | **`unverified`，`reason: "deliverables_failed"`**——证据压过「我验不了」 |
| **全部通过** | `skip` | **`verified`，`reason: "machine_only"`**——机器判据**本身**构成验收，而且要标明这一点 |
| **有失败** | guard 报错 / 超时 | **`unverified`，`reason: "deliverables_failed"`**——机器说了「没过」，这比「不知道」更强 |
| 全部通过 | guard 报错 / 超时 | **`error`——刻意不升级**（理由见下面的边界） |
| 有失败 | `revise` | 与今天一致（修订次数触顶 ⇒ `unverified`；预算类停机 ⇒ `non_continuable`） |
| 未声明判据 | 任意 | **逐字不变**：payload 无键、metrics 无键、事件无字段 |

`reason: "machine_only"` 是宿主**必须逐字读**的那一格：它的意思是「引擎用**宿主自己的判据**
验收了这次 run」，**不是**「guard 判过了」。如果你的策略要求 guard 本身必须判过，那就该把
`machine_only` 当成「我的 guard 跳过了——去收紧判据或 guard」，因为它描述的正是这件事。
聚合形式的同一个事实是 `metrics.deliverables_machine_only`（**只**在这一格出现）；
`metrics.verified` 在这一格**刻意不涨**：它数的是 guard 的 `accept` 裁决，语义一字不变。

因为 `machine_only` 就是 `verified`，所以一条声明了判据、guard 又 `skip` 的 CLI run：
判据全通过时退出码是 **0**（不再是 4），判据有失败时是 **2**。

改之前这两个面是**自相矛盾**的：判据已经**失败**的 run 仍然退 **4**（「没人验过」）、终稿标题
还是朴素的 `=== 终稿 ===`，而这次 run 自己的 metrics 里明明记着 `deliverables_failed: 1`——
机器已经判了，CI 读到的退出码却说它没判。本机修前实测的那一对是 `4` / `4`（判据通过 / 失败），
修后是 `0` / `2`。

**没有声明 `deliverables` 的宿主完全不受影响。** 没有判据就没有「机器结论」可以压过任何东西：
guard `skip` 仍然产出 `{ status: "skipped", reason: <guard 自己的 skip 原因> }`，CLI 仍然退 **4**，
payload 无键、metrics 无键、事件无字段。引擎自己的发布冒烟也属于这一类——
`npm run check:release` 跑的那次 `chat` **不带**判据并断言退出 **4**；它必须继续退 4，事实上也仍然退 4。

四条边界是刻意的：

- **`termination.reason` 不被改写。** 闸门只改 `verification`，不引入新的停机原因；
  既有的 `final_guard_unverified` 路径（修订次数触顶、不可续跑降级）一字未动。
- **guard 报错 + 判据全通过仍然是 `error`。** guard 抛异常/超时是**基础设施故障**
  （宿主回调写错、依赖挂了），把它升级成 `verified: machine_only` 等于用一条机器判据
  盖掉一次真实故障——宿主会读到「至少机器验过了」，而它该去修的那次故障被藏起来了。
  这个不对称是故意的：判据**失败**照样赢（`unverified`），因为「机器说没过」是一个
  已决的答案，而「guard 坏了」不是。
- **不可续跑终局也照核一次，但结论不变。** `max_rounds_cap` / `stall` /
  `continuation_exhausted` 上判据会跑一遍并记账，但 `revise` 收尾仍是既有的
  `non_continuable`。闸门只贴标签，不新造停止行为。
- **事件只多字段。** `type: "final_guard"` 的事件带 `deliverables_failed: <n>`
  （只在声明了判据时出现），machine-only 那一格另带 `machine_only: true`——
  它的 `action` 仍是 `"skip"`、`reason` 仍是 guard 自己的 skip 原因，宿主不必读 metrics
  就能观测闸门。既有事件字段一律不动。

判据里该用哪个路径键：`fileWrites[].path` 是 `tool_use.input[pathKey]` 的**原始值**
（逐字，可直接 `stat()`）；`filesWritten[].path` 是 judge timeline 的 40 码点摘要
（只能当提示，见上面那张载荷表）。拿摘要建判据会**系统性误拦**已经做对的 run。

**本仓出厂的宿主只给「命名判据」，不开放谓词（issue #391）。** CLI（`erix chat` / `erix repl`）
有 `--require-deliverable [<path>]`，pi 扩展有 `requireDeliverable: true` 与 `deliverablePaths: string[]`。
两个工厂都在 `bin/final-guard.js`：`createDeliverableChecks`（`bin/final-guard.js`）产出
`files_written_exist`，`createNamedDeliverableChecks`（`bin/final-guard.js`）按宿主声明的路径
逐条产出一条判据。**都不接受宿主自带 `check` 函数**：
函数没法安全穿过扩展/工具边界（pi 要序列化 `details` 与 `structuredContent`，扩展装载面不是数据通道），
所以那个面只能选「跑哪几条命名判据」。

**两种语义，都刻意保留。** 它们回答不同的问题，谁也不是谁的细化：

| 声明方式 | 它问的问题 | 判据 | 模型什么都不声明时 |
|---|---|---|---|
| `requireDeliverable: true`（裸 `--require-deliverable`） | 「**你说过要写的东西**还在盘上吗」 | `createDeliverableChecks()` 读 `fileWrites` | **通过**（空集合 ⇒ `every()` 恒真） |
| `deliverablePaths: [...]`（`--require-deliverable <path>`） | 「**这次任务要求的这些文件**在盘上吗」 | `createNamedDeliverableChecks(paths)` 读宿主清单 | **不通过**（判据与模型的嘴无关） |

布尔那条是「没撒谎」判据，不是「做了事」判据：**一次工具都没调**的 run 不会声明任何写路径，
于是判据通过、`verification` 变成 `verified`（issue #391 回帖里的实测）。「这次必须交付
`report.md`」只能靠命名路径表达。反过来命名那条也替代不了布尔那条——探索型任务事先不知道文件名，
但「别声称写了 A 又把 A 写丢」仍然要核——所以宿主可以两条都给（条数相加，合计受
`DELIVERABLES_LIMIT` 约束）。

四条随之而来的事实：

- **两者都不能单独用。** 判据是拦 guard `accept` 的闸门，而引擎只在 `finalGuard` 存在时才核它
  ——所以 `--require-deliverable` 不带 `--final-guard`（以及 `requireDeliverable` / `deliverablePaths`
  不带 `finalGuard: true`）是**用法错误**，不是静默空转。CLI 那一种组合的行为从 `exit 4` 变成了 `exit 1`。
- **`cwd` 是宿主的责任。** 判据按 `cwd` 解析相对路径，而那个 `cwd` 只在宿主传了
  `runToolLoop({ cwd })` 时才存在；引擎永远不补、不 `chdir`、也不检查它是否存在——判据于是 fail-closed
  （`ok:false`），这正是 #391 的原始症状。`erix chat --cwd <dir>`（缺省进程工作目录）与 `erix_run`
  必填的 `cwd` 参数就是这处接线。绝对路径不需要 `cwd`。
- **判据与 guard 共享一份预算。** 两者的上限都是 `finalGuardTimeoutMs`，而判据在**每次** attempt
  里跑在 guard **之前**，所以按「3 × 超时」算硬 abort 余量的宿主，每声明一条判据就要多留一个超时
  （1 条判据 + pi 扩展的 10s ⇒ 3 × (10s + 10s) = 60s；N 条 ⇒ 3 × (10s + N × 10s)）。
- **布尔那条的已知局限。** `fileWrites[].path` 是模型给的**原始**路径：若它是相对路径而宿主 `cwd`
  与进程工作目录不同，存在性检查会按进程 cwd 解析、可能误判。要求「某个具体文件必须在盘上」请用命名判据。

### 宿主侧的 guard 接线与截止线余量（issue #314）

pi 宿主扩展（`examples/pi-extension/erix-run-core.js`）带一个 `finalGuard` 开关，**默认关**。
开关关着时，扩展交给 `runToolLoop` 的 options 里**根本没有 `finalGuard` 这个键**（而不是一个值为
`undefined` 的键），所以 `verification` 仍是 `{ status: "skipped", reason: "no_final_guard" }`，
`end_turn` 依旧是一个声称而不是一个证明。传 `finalGuard: true` 时，循环才会拿到回调，并拿到一个
**显式给小的** `finalGuardTimeoutMs`（`FINAL_GUARD_TIMEOUT_MS`（`examples/pi-extension/erix-run-final-guard.js`）= 10000），
而不是依赖引擎默认的 30000。

这个超时必须显式给，理由在 guard 所处的位置：引擎只在**轮边界**查 run 截止线
（`remainingMs`（`src/loop/orchestrator.js`）），stop 判定 → guard 调用之间**没有** deadline 检查；
而骑在循环之上的宿主自己还有一根硬 abort 定时器（`runErixRun`（`examples/pi-extension/erix-run-core.js`））。
靠引擎默认值时，一次 guard 调用 + 最多 `finalGuardMaxRetries` 次 revise 可以等 `3 × 30000` ms
——全部落在宿主定时器早已过期**之后**：token 花了，结论被自己的 abort 抢掉。所以扩展同时做两件事：
把单次等待预算压低，并把硬 abort 往后挪 `FINAL_GUARD_WORST_CASE_MS`（`examples/pi-extension/erix-run-final-guard.js`，= 3 × 10000 ms），
而下发给引擎的 run 截止线**不动**（不拿它掩盖额外开销）。

开启的最坏成本：**最多 2 个额外模型往返**（引擎 `finalGuardMaxRetries` 默认 2）+ **最多 3 次
guard 等待**（每次上限是 `finalGuardTimeoutMs`）。成本落在宿主载荷的 `diagnostics.finalGuard`
（调用次数 / 累计墙钟 / `reviseRounds` / 声明与对不上的基点 / 派生结论提醒），与压缩、notes 两层
平级；引擎自己的计数仍在 `verification.metrics` 上（`guardMetrics`（`src/loop/orchestrator.js`））。
宿主不得把自己的计数当成引擎的，所以两边各带一个 `source` 字段。

扩展的谓词（`inspectFinalDraft`（`examples/pi-extension/erix-run-final-guard.js`））故意做得很窄：
终稿四段（`FINAL_DRAFT_SECTIONS`（`examples/pi-extension/erix-run-final-guard.js`），段名槽位也只在开关打开时
才写进系统提示词），外加**一个**硬闸——「基点」段声明的每个字面值必须在**本次** run 的
`tool_result` 块里逐字出现（`collectToolResultText`（`examples/pi-extension/erix-run-final-guard.js`））。
其余（比值、百分比、「总计」类）只提醒不拦。声明的基点对不上时，**任何分支都不 accept**：
重试用尽后循环以 `final_guard_unverified` 收尾，`verification.status` 为 `unverified`（`max_retries`）——
这是 fail-closed 规矩过了，不是答案过了。

### NotesStore 接口、作用域与写契约（0.12.0）

`NotesStore` 端口有六个必需方法：

```text
write, read, list, complete, revoke, purge
```

`createBuiltinNotesTools` 在 assembler 创建期即经 `assertNotesStore` 校验——缺任一方法
在第一轮 run 之前抛 `TypeError`，不再静默回退到隐式 file store。`write`/`read` 是 run
作用域的记录读写对；`list` 返回朴素数组；`complete`、`revoke` 是生命周期方法；
`purge` 是维护方法，见 [notes 维护调度](#notes-维护调度0120)。

`list()` 返回 `NoteRecord[]`，不再是分页页面对象：

```js
const records = await store.list({
  scope: "run",
  scopeRef,
  // 均可选：
  limit,    // 仅显式传入时生效：钳制最大 200；不传 = 返回全部匹配记录
  filters,  // { state, tag, source, minRelevance }
  sort,     // "relevance" | "pinned_updated"（稳定比较，不裸调 localeCompare）
});
```

不给 `limit` 返回全部匹配记录——内部消费方（`complete` 与宿主自建清理循环）依赖这个
全量语义。无 cursor、无 `cursor_stale` 状态、无 scope revision 协议：维护者复盘实测
（单 run 平均约 2 条、峰值 9 条）判定翻页与版本锚为 YAGNI，0.12.0 出厂前削减
（ADR-018 D3 决策反转）。`purge` 无分页协议——一次调用全量扫描处理每个 scope
（见 [notes 维护调度](#notes-维护调度0120)）。

显式传入的 `limit` 先校验再钳制（`src/store/notes-port.js:246-253`，issue #183 第 5 组）：
不是正 safe integer 的值——`0`、`-1`、`1.5`、`NaN`、`2**53`、字符串——在读取任何数据
之前就抛 `TypeError`；而任何大于 200 的值被钳到 200，不是报错。契约套件现在用
超过 200 条存量钉住这两半：默默把 `limit: 0` 归一化成 `1`、或对 `limit: 5000`
返回 5000 条的宿主会变红。

文件型 `NotesStore` 在适配器边界上对每个 `scopeRef` 做一次规范化。`../escape`、绝对
路径、编码分隔符等不安全的 scope 引用会被映射为稳定的 `run-h-...` 目录；目录与持久化的
`record.scopeRef` 使用同一个规范值。宿主与技能必须把原始逻辑 scope 引用交给适配器，
不要预先规范化。已处于规范哈希形态的既有目录仍可读，并参与 list、complete、revoke、purge。

文件适配器假定每个 scope/key 只有一个写入者。并发的读-改-写更新可能丢一次更新及其被
取代的历史（last-write-wins）。这条一写者规则是**这个适配器**的属性，不是端口的：
拒绝并发同键写中落后一方的 store（比较-交换）是合法的 `NotesStore` 实现，随包契约
套件已不再要求两个并发写都成功——last-write-wins 断言已搬到文件适配器自己的测试树，
比较-交换宿主改跑可选的 `notesStoreCasContract` 子套件（见
[契约测试套件](#契约测试套件issue-183)）。在文件适配器上需要并发更新的宿主必须在
宿主边界串行化；适配器不提供锁或其他并发机制。`revoke`
在 API 层再进一步：`expectedState` / `expectedUpdatedAt` 并发护栏让与其他写入方竞态的
revoke 返回 `{ status: "unchanged" }`，而不是覆盖它没见过的记录。

`revoke` 承诺的是记录**不再可被观察到**（issue #183 第 3 组，裁决 3B）。一次
`{ status: "found", revoked: 1 }` 的结果之后，记录不得还能被当成 active 笔记读到：
`read()` 要么返回一个 `state: "revoked"` 的墓碑，要么因为 store 已把记录直接删掉而返回
`undefined`，两种形态都合法。不变的是护栏行为而不是存储形态：对不存在的 key 的
revoke 答 `{ status: "missing", revoked: 0 }`，重复 revoke 不得再多加一次撤销（墓碑
宿主答 `unchanged`，物理删除宿主答 `missing`）。「墓碑不可复活」从未是现行承诺——
引擎里没有任何路径消费 `revoked` 态，所以 revoke 时物理删除的宿主不是较弱实现，
宿主也不得把「行还在」读成一个保证。

两种 scope 拓扑都合法且都在承重（issue #183 第 7 组）。**接口级多 scope 是硬能力**：
每个请求自带 `scopeRef`，一个 store 实例服务多个 scope，而 `purge` 是唯一扫遍
所有 scope 的方法（它忽略 `scopeRef`）。**实例级固定 scope 同样合法**：官方 assembler
`createBuiltinNotesTools` 就是在创建期绑定一个逻辑 run scope（`src/tools/notes.js:627`）、
全部返回视图复用该绑定，因此一个「每租户/expert 一个 store 实例、底层共享多 scope 数据库」
的宿主与上游同形，不是偏航。要拿固定 scope 的宿主端口跑契约套件，适配点在 factory：交给套件一个能把
请求里的 `scopeRef` 解析到该 scope 对应实例（按需创建即可）的 factory，而不是把
这个字段丢掉——套件里那些同时点名两个 scope 的断言（`other-run`、规范化的
`run-h-...` 形态）正好是丢弃 `scopeRef` 的 factory 会为之变红的那几条。

记录时间字段在每次读取时兜底：缺 `updated_at` 回退 `created_at`，两者都缺用固定 epoch
`1970-01-01T00:00:00.000Z`（适配器绝不替没写过的记录伪造"现在"）。
`normalizeNoteRecord()`（从 `src/store/notes.js` 导出）是适配器 read/list 出口与
tools 层（注入 store）共用的兜底。

### Notes 工具注册来源

规范的 notes 工具实现位于 `src/tools/notes.js`。headless 宿主可以从包根或
`erix-agent/tools` 子路径调用 `createBuiltinNotesTools({ notesDir, notesStore, runId })`
（Tier 2 宿主集成）。工厂是全套 assembler：创建时即绑定逻辑 run scope、notes 目录
（`notesDir` ?? `ERIX_NOTES_DIR` ?? `~/.erix/notes`）与单一 `NotesStore` 实例，
所有返回视图共用它们，并强制覆盖调用方伪造的 `__erix` 注入。返回对象包含：

- `definitions`——四个 `note_*` schema；
- `resolveTools`——registry schema 解析视图；需要 `ToolProvider` 形态的宿主
  （如用于 `createCompositeToolProvider` 聚合）可自行构建：
  `createStaticToolProvider({ sets: { default: notes.definitions } })`；
- `executors(name, input, context)`——registry 位置参数形态；
- `executeTool({id, name, input, context, signal})`——结构化形态，对齐 `runToolLoop`/
  run-snapshot-executor 的调用约定（位置参数形态 `executeTool(name, input, context)`
  为兼容既有调用方保留）；
- `lifecycle`——单一收尾钩子（0.12.0）。`onRunComplete` 只调 `completeRun`
  （active → done），返回 `{ completed, errors }`。收尾错误收集在返回值的
  `errors[]` 里返回，不抛出覆盖主错误。入参接受可选的 `reportPersistenceFailure`
  reporter（`onRunComplete({ reportPersistenceFailure })`）：注入后 complete 期间的
  store 失败像工具执行失败一样经它上报。没有 `onRunStart` 钩子，引擎侧也没有
  liveness：run 起点对 notes 零维护。无参调用（如下例）保持原行为——失败只经
  返回值的 `errors[]` 或抛出的错误可见；
- `semanticStateProvider`——ADR-015 折叠点 notes 小抄目录（仅 active、最多 20 条、
  pinned 优先后按 `updated_at` 排序、版本回声 `state.stateVersion`）。入参 payload
  接受可选的 `reportPersistenceFailure`：显式传入时，store list 失败经它上报
  （该情形下 provider 仍返回 `undefined`）。

典型接线（显式 try/finally）：

```js
const notes = createBuiltinNotesTools({ runId, notesDir, notesStore });
try {
  return await runToolLoop({
    /* ... */
    tools: [...hostTools, ...notes.definitions],
    executeTool: async (execution) => {
      if (notesToolNames.has(execution.name)) {
        return notes.executeTool(execution);
      }
      return hostExecuteTool(execution);
    },
    semanticStateProvider: notes.semanticStateProvider,
  });
} finally {
  const { errors } = await notes.lifecycle.onRunComplete();
  for (const failure of errors) {
    hostReportCompletionError(failure.operation, failure.error);
  }
}
```

notes 写失败经引擎的通用宿主持久化失败报告桥上报（`context.reportPersistenceFailure`，
`port: "notes"`），不得静默吞错。宿主仍负责选择并注入 `NotesStore` 与逻辑 run scope。

active orphan 清理完全是宿主的事：引擎没有 liveness 知识。想回收死 scope 的 active
笔记的宿主，用公开原语自己写三行循环——`store.list({ filters: { state: "active" } })` +
`store.revoke({ ..., expectedState, expectedUpdatedAt })`——死活判据用宿主自己的知识
（调度器状态、进程表、最后心跳）。`expectedState`/`expectedUpdatedAt` 护栏吸收
宿主 list 与 revoke 之间的陈旧读窗口；没有这类循环的宿主永不自动回收 active orphan
（宁积累不误杀）。

**note 的 provenance 是调用方自报的 metadata，不是事实。** 记录上 `source` 以外的
`provenance` 字段——`verified`、`toolUseId`、`round`——由调用方自报、可被伪造，
不得作为授权输入或任何 guard 的依据。run 实际做了什么，事实依据是归档 transcript
（`toolOutputs`，ADR-016），而不是 note 记录上的任何字段。

CLI 的 bundled `skills/notes/skill.mjs` 已于 v0.11.0 退役（issue #61），与 assembler
别名键一并移除：notes 统一经 `createBuiltinNotesTools` 工厂交付，`erix skills`
不再列出 bundled notes skill（用户/项目 skill 发现不受影响）。旧第三方 skill
loader 请直接 import `src/tools/notes.js` 或 `erix-agent/tools` 子路径；bundled notes
shim 自身的 `getSkillDefinition` 导出（`erix-agent/tools` 子路径的
`getNotesSkillDefinition`）已随 shim 一并删除，通用 skill loader 对第三方 skill 的
`getSkillDefinition()` 支持不受影响。它不是第二套
实现，也不再是可独立复制运行的 skill；
可移植集成应使用 npm 包入口。

### 文件工具注册

文件工具的规范实现是 `src/tools/file-tools.js`。无头宿主**只能**从 `erix-agent/tools`
子路径调用 `createFileTools({ cwd, allowRead, allowWrite })`——它**不**从包根导出
（ADR-005 第二层：「不属于主导出，只能经显式 `import … from "erix-agent/tools"`」；
`package.json` 的 `exports` 只有 `.` / `./tools` / `./contract-tests`，无深路径），
这就是 Tier 2 host integration。库不带牢笼：两个谓词就是边界的全部，默认都是
`() => true`，与历史 `path.resolve(cwd, value)` 行为完全一致（不做 containment、
不做安全承诺；ADR-009 把牢笼留给宿主）。路径归一由库自己做，喂给谓词的是
**绝对路径**，而且是在遍历中**逐条**判定；这个逐条挂钩正是宿主在外面包一层
`executeTool` 做不到、必须在库里挂钩的理由。

返回对象包含：

- `definitions`：`readFile` / `searchText` / `rg` / `grep` / `tree` / `edit` / `writeFile` 七个
  schema（项数由契约套件 `fileToolsContract` 断言：`searchText` 由 issue #195 加入、`edit` 由
  issue #191 加入）。工具名与既有字段（`offset`/`limit`/`path`/`pattern`/`glob`/`is_regex`/
  `max_results`/`maxResults`/`depth`）保持不变，自带过 CLI 那份实现的宿主接上本
  工厂是零迁移——**但有一条行为口径要注意**：`rg` 的 `is_regex` 默认是 `true`（#184
  追加轮 A，与真实 `rg` 命令一致），而已退役的 CLI 那份实现把「不传 `is_regex`」当作
  字面量，携那个默认的宿主会看到不同的命中结果（见下面的默认值清单）；新参数一律
  snake_case，两个搜索工具都同时接受 `max_results` 与 `maxResults` 两种上限写法；
- `executeTool({id, name, input, context, signal})`：与 `runToolLoop` /
  run-snapshot-executor 调用约定对齐的结构化视图（同时保留位置形态
  `executeTool(name, input, context)` 以兼容现有调用方）。放在**顶层**的 `signal`
  会被并入 `context.signal`；遍历每 32 个条目让出一次事件循环，且**仅在存在
  signal 时**插入，所以不可中止路径的开销与行为零变化；
- `executors(name, input, context)`：registry 的位置参数视图，CLI 用的就是它，
  并在它旁边拼上自己的 `exec` 与 `todo_*`（ADR-005：库不自带会执行的工具）。

**边界语义属 Stable。** `allowRead` 对某个遍历条目返回 `false`，工具就跳过该条目，
并把计数写进结果尾部的排除账；`readFile` 以及被拒的遍历根路径则返回错误结果文本
（`错误：…`）而非抛异常。`allowWrite` 返回 `false` 同样返回错误结果文本：不抛，
库也不引入自己的错误类型。宿主可以依赖两件事：谓词签名
`(absolutePath: string) => boolean`，以及「返回 `false` → 工具返回错误结果而不抛
异常」这条规则；但不得把错误文本的措辞当契约。

**marker 字面量属 Experimental**（issue #188 三层分级，可在任意 minor 变）。所有
「跳过 / 截断 / 空命中」字符串：`[已跳过 …]` 排除账、`[另有 N 条未列出 …]` 与
`[另有 N 个目录未展开 …]` 两个 tree marker、
`[共 N 行（文件 <size>），剩余 M 行；下一步：readFile 传 offset=K 继续]`（`<size>` 段是
`formatSize()` 渲染出的该文件真实大小——issue #267 补上它，是因为只看行数答不了「剩下的内容能不能
一次读完」；同一段结果里它不会与裸字节数并排出现），以及空命中
的 `（无命中）`，全部由 `src/tools/file-tools.js` 里**单一** marker 生成函数产出
（executor 只传语义值，不各自拼带方括号的字符串）。这正是文案能只改一处、而不是
改五个调用点的原因。需要稳定信号的宿主只能按拿到的工具结果分支，不得按 marker
子串匹配。

**截断 marker 必须给出一条可执行的出口**（issue #196 R1）。只报告「已经截断了」是半件事：
搜索的 `metadata` 进 transcript 但**不上 wire**，marker 文本是模型唯一读得到的通道，
一条没有出口的 marker 等于让模型自己猜那个数。所以每一处读/搜截断的 marker 都以
`；下一步：<工具> 传 <参数>=<值>` 收尾，带的是**本次调用**的真值——行窗口或 `max_bytes`
触顶后下一次 `readFile` 该传的 `offset`、超宽行的**行号加文件路径**、命中截断后的续读
`offset`。marker 里允许出现的工具名只有本模块自己的（`readFile` / `searchText`）：
`exec` 属 CLI 装配层（`bin/tools.js`），ADR-005 把「会执行东西的工具」挡在库外，写进去
就是给模型开一张本库兑不了现的支票——这一条相对 issue 原文是收紧。
两个追加细节（issue #196 第二轮）：其一，超宽行**没跨读块**时也要回报——整行落在一个
64 KiB 读块内时它是一字节都没回来（而不是回了一半），而 `max_bytes` 触顶 marker 的
`offset` 语义钉死为「下一个未读整行」，照做正好跳过它，那条行的剩余内容永远取不到；
所以两条 marker 的先后是固定的（触顶在前，被裁那行自己的行号 / `offset` / 路径 / 文件
大小在后），且触顶那条**不得声称内容完整**。其二，`rg` / `grep` 别名的截断 marker 现在
给出与 `searchText` 同源的数（本次返回的命中条数，也就是 `metadata.searchNextOffset`
里那个值），但它自己仍不接受 `offset` 参数——给数与吃参数是两条承诺。

**结果文本里的字节数一律人类可读**（issue #196 R2）。`formatSize()`（与 `toolMarker()`
同文件、由 `src/tools/file-tools.js` 导出）按 1024 基数渲染 `B`/`KB`/`MB`/`GB`/`TB`
（`262144` → `256KB`、`1572864` → `1.5MB`、`1536` → `2KB`、`1073741824` → `1.0GB`、
`1649267441664` → `1.5TB`）；进位判据看的是**渲染后的值**是否到 1024，到就晋级上一档，
所以永远不会出现 `1024.0MB`，而 `1e12` 是 `931.3GB` 而不是只有 MB 档时那个六位数的
`953674.3MB`——六位数带单位等于没单位（issue #196 追加轮）。并且同一段结果文本里
**不会**同时出现可读值与裸字节数——同一件事给两个数，模型对不上账。阈值本身在本文与
`metadata` 里仍写裸数字，那里没有第二份数字互相打脸。

**这两个辅助函数的导出面限定。** `formatSize()` 与 `toolMarker()` 是
`src/tools/file-tools.js` 的**模块级导出**——上面那段描述的是模块内部，不是公共 API。
它们**不在公共 `exports` 面**上：`package.json` 只映射 `.` / `./tools` /
`./contract-tests`（无深路径），`erix-agent/tools` 的 barrel 也没把它们转出，因此
把本包当依赖安装的宿主**当前拿不到**这两个函数。需要同样渲染请自行实现；把它们转进
`erix-agent/tools` 是后续可选动作（additive minor），在那之前本段任何一句都不构成
导入承诺——而且 marker 文案本身仍属 Experimental（见上文），宿主应读结构化的
`metadata` 字段而不是解析 marker 文本。

宿主必须知道的默认值，因为它们会改变模型看到的东西（ADR-010：默认去噪只有在可撤销
时才是合法的）：

- `rg` / `grep` / `tree` 默认跳过 `node_modules`、`dist`、`build`、`target`、
  `vendor` 与 `.` 开头的目录（含 `.git`），除非传 `include_vendor=true` /
  `include_hidden=true`；结果尾部会带跳过数量，以及能撤销它们的开关名。排除账只点名
  **本次真的被跳过的类别**（vendor 目录 / 隐藏目录，各自带自己的计数与真实目录名样本），
  计数为 0 的类别一字不提；尾部开关提示只列调用方**尚未**传的 flag，所以已经传了
  `include_vendor=true` 的那次调用不会再被劝一遍（issue #222：旧文案写死
  `node_modules/.git 等 N 个目录` 并无条件劝 `include_vendor=true, include_hidden=true`，
  模型据此判定参数被忽略，弃用工具去跑 `shell grep`）；
- **`tree` 的根标签可回放**（issue #215）。只要目标解析到工作目录根，首行就是 `./`——
  `path` 缺省、`.`、`./`、空串、绝对根路径、用 `..` 绕回来的写法，都给同一行首行与同一份
  条目，所以把首行当 `path` 传回去一定成功。此前除了字面 `.` 之外的写法都退成工作目录的
  basename，模型读成「根下有个同名子目录」，回放必然 `ENOENT`；
- **`tree` 指向非根目标时，首行也是可回放的相对路径**（issue #358，即 #215 的另一半）。
  目标在根之下时，首行是它**相对工具根目录**的路径（形如 `<父目录>/sub/`），去掉尾斜杠抄回
  `path` 就能逐字拿回同一棵树；两个同名的目录也分得开。此前首行是裸 basename，能不能回放全看运气；
- **`readFile` 会说出自己改过哪些入参**（issue #358）。`offset` / `limit` / `max_bytes` 都要过
  归一化与钳制（`offset:"120"` 在这里不算数字、负数钳到 0、小数向下取整、`max_bytes` 钳到
  `[1 KiB, 4 MiB]`），而兜底值恰好等于默认值 ⇒「被我改了」与「你本来就要这个」在旧输出里逐字
  不可分。现在这类调用会带 `[参数校正：…]`，同时给出原值与实际生效值。语义一字未改——这是**只报告**；
  `offset` 越过文件末尾时返回 `[已到末尾：…]` 并附真实行数，不再返回空串；
- **读侧路径错误保留通道、去掉 errno**（issue #358，#234 的尾巴）。路径不存在**仍然抛**——引擎会把
  抛出变成 `is_error: true` 并给 `toolStats.failures` / `toolErrorCount` 各记一次，改成返回文本就会
  把这次失败从账本上抹掉——但 message 用的是本模块自己的句式，且只出现相对工具根目录的路径，宿主的
  绝对路径不再被注进 transcript。`readFile` 指向**目录**时返回文本结果（`错误：路径是目录：…`），与
  `edit` 同口径：那是调用方给错了东西，不是 I/O 故障；
- **两个搜索工具都默认按正则匹配**（`rg` 与 `grep` 一致，也是真实 `rg` / `grep`
  命令自己的默认；#184 追加轮 A 推翻了此前「`rg` 默认字面量」的选择——同一库里两个
  搜索工具默认相反才是本轮修掉的反常）。`is_regex=false` 是字面量逃生口，按真实旗标
  命名：等价 `rg --fixed-strings` / `grep -F`。非法正则返回工具错误结果
  `错误：无效正则：…`，**绝不抛异常**（真实命令是非零退出）；
- **两个搜索工具把每条命中行截到同一个 500 字符** + 尾部一个 `…`，共用**同一个**上限，两边不可能
  再各自漂移（#184 追加轮 A：上限原先是 200，会把正常代码行截成半行，模型看到半行容易误判；且当时
  只有 `grep` 截、`rg` 原样输出，同一库里两个搜索工具口径相反）。真实 `rg` / `grep` 命令**都不截行**
  （已实测：807 字符的命中行逐字节原样输出），所以这个截断是**本实现自己的输出预算**——一个超长行
  （minified 文件常见：一行几百 KB）能独自把一次工具调用撑爆。这个数是**本实现的默认值**，不是对宿主
  的要求，且已写进两个工具的描述；
- 空命中结果是 `（无命中）`，不再是空串；
- `tree` 截断永远带 marker，并给出剩余计数与能放宽它的参数；
- `readFile` 有界：单次返回不超过 `max_bytes` 个 UTF-8 字节（默认 `262144`，可用
  `ERIX_FILE_READ_MAX_BYTES` 覆盖，钳到 1024-4194304），行窗口按块扫行 + 早停，
  不再把整个文件读进内存；
- 每条截断 marker 都以「可执行的下一步」收尾，带的是**本次调用**的真值（续读要传的
  `readFile` `offset`、被截那行的行号与文件路径、或搜索的续读 `offset`），且只允许点名
  `readFile` 或 `searchText`——`exec` 是 CLI 自己的工具，不属于库（issue #196 R1）；
- 结果文本里的字节数一律人类可读（`B`/`KB`/`MB`/`GB`/`TB`，1024 基数，走 `formatSize`），
  可读值与裸字节数不在同一段结果文本里并存（issue #196 R2）；裸的默认值继续留在本文
  与 `metadata` 里。

**搜索是纯 Node 子集，不是 `rg` / `grep` 二进制**（issue #184）。只有默认值与逃生口命名
跟真实命令一致，能力面故意不一致：没有 `-i`、没有 `-A`/`-B` 上下文行、没有 `--type`/
`--include`，模式是 JavaScript 正则（ripgrep 内置的是另一套正则引擎，GNU `grep` 默认是
BRE，都不是这里用的 JavaScript flavor），**完全不读 `.gitignore`**，vendor 排除是一份硬
编码清单（`node_modules`/`dist`/`build`/`target`/`vendor`），以结果尾部的排除账回报，而不
是 ripgrep 那套 ignore 文件遍历。宿主不得把自己的模型或用户误导成「这就是 ripgrep 二进制」。

CLI 只保留装配与呈现：`bin/tools.js` import 本模块，自己只加 `exec` 与 `todo_*`，
且不传任何谓词，所以 CLI 行为与以前一致，仍是「无边界」。`bin/` 不再持有第二套
文件工具实现（issue #184）。

### 成功返回的四种顶层形态（issue #220）

`createFileTools().executeTool()` 的**成功**返回值有四种互不相同的顶层形态。这些形态是契约，
不是实现细节：随包的 `fileToolsContract` 套件逐个断言它们的 `typeof`（以及下面那个判别式
返回的 `kind`），以以下列任何一种改动都会把套件跑红，而不是静悄悄落到宿主界面上：把四种
摊平、包一层、或「统一成一种」。

| 工具 | 成功时的顶层形态 | 里面装的是什么 | `classifyFileToolResult().kind` |
|---|---|---|---|
| `readFile` | `string` | 带行号的正文；截断与跳过账以尾部 marker 行追加 | `text` |
| `edit` | `string` | 一行摘要 + unified diff | `text` |
| `writeFile` | `number` | 写入字节数——是真正的数字，所以 `0` 是合法的成功值 | `bytes` |
| `searchText` | `object`，顶层键恰好是 `content` 与 `metadata` | `content` 是命中正文，`metadata` 携带结构化账（截断 / 跳过 / 上限） | `content-metadata` |

宿主可以程着写的规则：

- **用 `erix-agent/tools` 导出的 `classifyFileToolResult` 钉形态，而不是用字符串包含去猜。**
  它返回 `{ kind, text, bytes, metadata }`，其中 `kind` 是判别联合
  `"text" | "bytes" | "content-metadata" | "unknown"`。宿主按 `kind` 分支，并在 `default` 里
  `assertNever(kind)`：引擎日后新增第五种形态时，是宿主自己的编译在那个 `default` 上报错，
  而不是界面渲染出 `[object Object]`。
- `typeof result === "string"` **不是**成败判据：错误结果也是字符串（前缀 `"错误："`），
  顶层形态与 `readFile` 一致。区分两者只看错误前缀，绝不看形态。
- 裸 `number` 正是 `if (!result)` 这个写法出错的原因：`writeFile` 返回 `0` 的意思是
  「写入空文件成功」。
- 套件里的 `contentOf` / `metadataOf` 仍作为过渡期读取子保留给手工收敛的宿主。它们是读取子，
  不是契约——上面那些断言才是。

### 文件编辑工具 `edit`（issue #191）

`edit` 是同一个 `definitions` 数组、同一个 `executeTool` 入口里的**第二个写工具**——
已经按上面「文件工具注册」接线的宿主，零额外接线就拿到它。它存在的理由：工具面此前
只有 `writeFile{path, content}`，改三行就得重打整份文件（`src/loop/orchestrator.js`
3277 行 ≈ 33k 输出 token），而这次整写本身还可能被模型自己的输出预算切断——
`continuation_exhausted` 在本库是一等的终止原因。`edit` 把「改一小段」的成本从
整文件量级降到 diff 量级。

```js
import { createFileTools } from "erix-agent/tools";

const fileTools = createFileTools({ cwd, allowWrite: (absolutePath) => absolutePath === expectedPath });

const edited = await fileTools.executeTool({
  id: "toolu_edit_1",
  name: "edit",
  input: { path: "a.js", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
  context: {},
});

// 越界写：allowWrite false 走的是与 writeFile 同一份错误结果，不抛、不落盘
const denied = await createFileTools({ cwd, allowWrite: () => false })
  .executeTool({ id: "toolu_edit_2", name: "edit", input: { path: "a.js", edits: [{ oldText: "const a = 2;", newText: "const a = 3;" }] }, context: {} });
```

宿主可以依赖的事实：

| 面 | 契约 |
| --- | --- |
| 入参 | `{ path, edits }`。`edits` 只收三种形状、且只收这三种：`[{oldText, newText}]`、单个 `{oldText, newText}` 对象、或上面两种的 JSON 字符串。其余形状（非法 JSON、`oldText`/`newText` 不是字符串、空列表）一律错误结果。收这三种形状是归一**形状**，从不猜意图 |
| 匹配 | 逐字节精确。`oldText` 必须与文件里某段文本逐字符相等，空白与缩进也算。**没有模糊兜底**：不做 NFKC 折叠、不做弯引号折叠、不做行尾空白容忍 |
| 唯一性 | 每条 `oldText` 必须命中且仅命中一次。0 次与 `N>1` 次都是错误结果；`N>1` 的文案会报出到底几处，以及前两处的行号 |
| 独立性 | 每条 `oldText` 都对**原文**匹配，而不是对同一次调用里前几条改完的中间态匹配；各条命中区间不得重叠 |
| 原子性 | 全部通过校验才写入。没有部分落盘，且「全部无变化」也是错误结果（`未做任何修改…`），不是静默成功 |
| 写边界 | `allowWrite(absolutePath)`——与 `writeFile` 同一个谓词，且在读任何内容之前判定。越界是错误结果、绝不抛，文件保持原有字节 |
| 行尾 | BOM 保留；行尾里含 CRLF 的文件在 LF 空间里匹配、按 CRLF 写回。因此混合行尾的文件写回时会被归一到 CRLF——结果首行会写 `CRLF 行尾已保留`，而不是把这件事藏起来 |
| 结果 | 一行摘要（`已编辑 <path>，替换 N 处，首个变更行 N，写入 N 字节`，按实际情况追加 BOM/CRLF 说明），随后是 3 行上下文的 unified 风格 diff，按编辑区间分组，上限 8 段 / 200 行。被截断时追加一条带剩余计数与 `readFile` 下一步的截断 marker（ADR-010：去噪必须可撤销） |
| diff 保真度 | 这个 diff 是**自证凭证，不是补丁**：hunk 按编辑区间切、取整行边界并剪公共前后缀，因此它可能比最小 LCS diff **多**报变更行（绝不会少报），并且不承诺 `git apply` 可用。要逐字节确认请用 `readFile` |
| 护栏 | 目标超过 4 MiB、单次超过 64 条、含 NUL 的（二进制）文件、目录、不存在的路径，全部返回错误结果并给出下一步（新建走 `writeFile`，回读走 `readFile`） |
| judge | `edit` 在默认 `writeToolNames`（`["writeFile", "edit"]`）里，因此宿主不配置也能让它的 `path` 进入 judge 的 `filesWritten`。宿主显式传入的 `writeToolNames` 是**整体替换**那个默认值——绝不与它合并 |

**为什么本轮不做模糊兜底。** pi 的 `edit` 带 NFKC 归一、弯引号折叠与行尾空白容忍，
那是它的 transcript **踩坑之后**加的：模型从 `readFile` 回显里抄错一个字符就 0 命中。
本库没有这类 transcript 证据（与 issue #195 R4 把 `-i`/`-A`/`.gitignore` 挡在
`searchText` 门外是同一条规则：没证据就别扩面），而兜底会把模型唯一能自证的信号
——`0 命中`，一个它可以据此行动的错误结果——换成「静默改到了另一个位置」。这正是
issue #184/#195 一路在收的那类静默撒谎。具体算账：一个看着像但错的模糊命中要一整轮
往返才能发现，一次精确匹配落空只花一次重试。日后要加兜底是 additive 的（它只放宽
匹配面，从不收窄），所以这里没有任何单向门。

给工具副作用分类的宿主（写日志、权限确认、TUI 的写入标记、重放策略）必须把 `edit`
当**写**：它的 `path` 参数长得和 `readFile` 一样，一份只把 `writeFile` 记成写工具的
名单会漏报每一次编辑。退役前的 `bin/tools.js` 工具面从来没有过这件事，而 CLI 现在把
`edit` 列进了工具清单行——这正是本次发布 `test/fixtures/cli-golden.json` 变更的原因。

### 搜索工具（issue #195）

`searchText` 是唯一的搜索入口（Tier 2 host integration，注册路径与「文件工具注册」
一致），`rg` 与 `grep` 现在它的**薄别名**。为什么要一个新名字：`rg` 与 `grep` 是我们
自己写的纯 Node 实现（整文件工具里没有任何 `execFile`/`spawn`），却借了两个 CLI 命令的
名字——**借来的名字会带来借来的先验**。模型看到 `rg` 就会写 `glob: "**/*.test.ts"`（这里
的名称过滤从不跨 `/`）、先验地以为 `.gitignore` 生效（不生效）、把「没命中」读成「仓库里
真没有」（其实可能整棵 `vendor` 被跳过）。最后一类正是 issue #184 干掉的那批静默撒谎，
只是撒谎的主体从输出换成了**名字**。

宿主可以依赖的契约面：

- `mode` **必填且无默认值**——合法取值只有 `"literal"`（字面量）与 `"regex"`（JavaScript
  正则）。没传或传了非法值会返回工具错误结果`错误：searchText 必须显式给出 mode …
  （无默认值）`，绝不自己猜一个。这就是这个工具的存在理由：issue #184 不得不翻转一对
  「`rg` 默认字面量 / `grep` 默认正则」的相反默认，而「默认 `literal`」只会把歧义留给
  调用方。别名仍保留布尔逃生口：那里的 `is_regex=false` 就是 `mode: "literal"`（等价
  `rg --fixed-strings` / `grep -F`），正则默认未动。
- 名称过滤参数叫 `name_pattern`：它**只匹配文件名**、**从不跨 `/`**，所以 `**/*.ts`
  这类模式一律不命中。它不再叫 `glob`——**只有子集能力就不该顶着完整能力的名字**。
  `searchText` **不接受 `glob`**：传了会返回一错误结果并指向 `name_pattern`，而不是
  静默忽略一个「看着能用」的键；`grep` 别名继续吃 `glob`（语义相同），因为它的入参
  形状属 Stable。
- `content` 是扁平的 `path:line:命中行` 形态，一行一条命中。两个别名保留各自的历史渲染
  （`rg` 扁平、`grep` 按文件分组），所以**跳工具的不变式是「命中行正文」**：三个入口共跑
  同一份实现体，连 500 字符行宽上限、`（无命中）` 口径与排除账都一起产生。契约套件逐字钉
  住了这个等式（issue #195 硬判据）；宿主不得在别名上假定扁平形态去写解析器。别名的截断 marker 带的是与规范入口同一个数
（`…；下一步：改用 searchText 传 offset=N 继续（本别名不接受 offset）`，N = 本次返回的
命中条数），即别名**给真值但不因此获得参数**（issue #196 追加轮）。
- `path` **不存在**时返回**错误结果，永不落 `（无命中）`**（issue #219）。`（无命中）` 的
  语义是「搜过了，没有」；路径写错时给同一句话就是**假阴性**——`metadata.searchFiles` 只进
  transcript、不上 wire，模型唯一的通道就是那句字符串，于是会把「路径写错了」读成「代码里
  没有这个」。三个入口一律返回文本结果 `错误：路径不存在：<path>`（与 jail 越界、无效正则
  同一条通道：文本，不抛）。两种情形严格分开：**存在**但没有命中的目录仍是 `（无命中）`；
  `path` 指向**文件**时只搜这个文件（行为未变，现由契约套件钉住）。
- `searchText` 返回 `{ content, metadata }`。`metadata` 携带 `searchHits`、
  `searchMatchedLines`、`searchFiles`、`searchLimit`、`searchOffset`、`searchTruncated`、
  `searchNextOffset`（仅在截断时）与 `searchSkipped { vendorDirectories,
  hiddenDirectories, largeFiles, binaryFiles, deniedPaths }`。这些字段**进 transcript、
  不上 wire**：模型侧读的仍是 marker 文本（`[已跳过 …]`、`[命中过多，已按
  max_results=N 截断；下一步：searchText 传 offset=N 继续]`、`（无命中）`），
  仍由单一 `toolMarker()` 函数产出（文案属
  Experimental，issue #188）。需要稳定信号的宿主按 `metadata` 分支，**不要按 marker 子串
  匹配**，也不要要求上面没列出的键。`offset` 用来续读被截断的结果：把
  `metadata.searchNextOffset` 原样传回来即可。
- 本轮弃用只是**告警**（issue #188：工具名与入参形状属 Stable，移除要等 major）。
  `rg` 与 `grep` 会在结果尾部挂一行 `[已弃用 rg：它是 searchText 的薄别名，…]`。拿工具
  输出做逐字相等比较的宿主会看到这一行——它是模型可见变更；CLI 系统提示的工具清单行与
  `test/fixtures/cli-golden.json` 同理。
  这一行里的迁移提示按**本次入参**生成（issue #221）：`is_regex=false` → `mode="literal"`，
  其余 → `mode="regex"`；`grep` 只在本次真的传了 `glob` 时才点名 `name_pattern`。写死
  `mode="regex"` 会静默换语义——`literal` 不解释元字符、`regex` 解释（`a.b`、`\d+`、`(x)`
  的命中集不同），而 `mode` 无默认值，这条提示就是模型唯一的迁移依据。契约套件钉住「照提示
  改写 → 命中集不变」。
- **没发生**的事（issue #195 R4）：没加 `-i`、没加 `-A`/`-B`/`-C` 上下文行、没加
  `--type`、没加 `.gitignore` 感知。每一条都会与边界注入/输出预算/中止交叉（`-A`/`-B`
  会顶破字节上限；读 `.gitignore` 本身要过 `allowRead`），所以上游要求先看 transcript
  证据——模型到底写了哪些我们不支持的参数形状、因此误判了几次。
### 技能加载器注册（issue #197）

技能包 loader 的规范实现是 `src/skills/loader.js`，经 `erix-agent/tools` 导出——
**故意没有**新增 `./skills` 子路径：打包面一字不改，本来就读 `./tools` 的宿主不需要多一条 import 映射。
`bin/skills.js` 只剩装配 + re-export（它唯一的职责是把自己那份内置技能目录补进去），
所以 `erix skills` 与 repl 的 `/skills` 行为与搬迁前逐字一致。

公开面是六个函数：

- `skillDirectories({ home, cwd, skillsDir, bundledDir })` — 返回真实存在的技能根，顺序是
  用户全局 → 项目本地 → 内置；
- `discoverSkills({ home, cwd, skillsDir, bundledDir })` — 一级技能目录 `[{ id, dir }]`，
  尾部挂一个不可枚举的 `errors` 数组；
- `loadSkill(dir)` / `loadAllSkills(options)` — 校验单个技能目录 / 全部已发现的目录；
- `buildSkillTools({ home, cwd, skillsDir, bundledDir, excludeSkillIds, builtinNames })` —
  装配出 `{ tools, executeTool, errors }`，`errors` 同时带上所有被跳过的原因；
- `warnBuiltinToolConflicts(errors, { warn })` — CLI 那条同名冲突的一次性告警。

**`bundledDir` 是宿主必须看懂的那个选项。** 内置技能目录**归调用方所有**：库绞不按自身
文件位置推导它，不传 `bundledDir` 就等于内置根压根不参与发现——只看 `<home>/.erix/skills`
与 `<cwd>/.erix/skills`。理由不是风格：退役前的 `bin/skills.js` 把路径写成相对 `import.meta.url`
的 `../skills`，文件住在 `bin/` 时恰好命中 `<package>/skills`，搬到 `src/skills/` 就差一层，
宿主从 `node_modules` 里解析这个包时又是另一套。猜错的失败方式是**静默**的——内置技能就是
发现不到了——所以这个参数是契约而不是便利顶。CLI 传自己的 `<package>/skills`；宿主传自己
那一份，或者什么都不传、只拿用户级与项目级技能。

优先级是定死的：内置技能在同名竞争里输给用户全局技能，用户全局技能又输给项目本地技能
（扫描顺序 内置 → 全局 → 项目，后者替换前者）。`skillsDir` 是单目录覆盖（即 CLI 的
`--skills-dir`）：一旦给出就只扫那一个目录，相对值按 `cwd` 解析。

**发现与校验都不阻塞，且每个失败都可枚举。** `loadSkill` 对单个目录是抛错（不支持的
`schema_version`、绝对路径或逃逸技能根的 entrypoint、空 / 重复 / 畸形的 `tools`、既没导出
`getSkillDefinition()` 也没导出 `getTools()` 的模块），`loadAllSkills` / `buildSkillTools`
会把每一次抛错转成一条 `{ skillId, dir, error }` 记录——`error` 是字符串，该技能**整体**被
跳过（不会留下半套工具），同一根下的其他技能照常装配。工具名与 `builtinNames` 冲突的技能
也按同一条路回报并被跳过，而不是静默覆盖内置工具。宿主可以对「记录形状」与「整体跳过」这两件事
编码，不得对那些错误文案编码。

`buildSkillTools` 交出去的就是本库的 `ToolSchema` 列表，直接交给 `createToolRegistry`，所以
技能工具身上 registry 的 input 校验是真生效的：缺 `required` 字段或字段类型不符会拿回
registry 的 `Tool <name> …` 文本，未注册的名字拿回 `Unknown tool: <name>`，都不抛。
技能模块是**在宿主进程内、以宿主的权限**被 import 的——库不提供任何沙箱（ADR-008，
ADR-009 把牢笼留在宿主侧），所以 `excludeSkillIds` 与 `builtinNames` 是策略输入，不是安全边界。

`erix-agent/contract-tests` 里的 `skillsLoaderContract(label, { discoverSkills, loadSkill,
buildSkillTools })` 会断言「内置目录由参数决定」「优先级」「不阻塞且可枚举的 errors 形状」
「产出是 ToolSchema 形态」四组事实，对宿主接进来的任何实现都跑同一套。

### notes 维护调度（0.12.0）

根规则是**会话时钟**（ADR-018 D7）：笔记寿命 = 会话寿命 + 保留期（尸检期）。
会话最后活动由宿主定义——CLI 用 transcript mtime（30 天无对话活动的 session，
其笔记随 transcript 过期一起清理）；调度型宿主用调度器状态。引擎不猜不问。

库内 `store.purge()` 是没有会话时钟的宿主的可移植兜底基线：对每个 scope 目录，
若全部记录文件的最新写入（最大文件 mtime——不解析 JSON）早于
`now - ERIX_NOTES_RETENTION_MS`（默认 30 天），**该 scope 的全部记录文件（含
active）整体删除**，空目录一并移除；未超期的 scope 整体豁免（其中很老的笔记也
保留——会话活着，笔记本整体保留）。`purge` 每次调用一次全量扫描——没有
`limit`/`cursor` 协议——返回 `{ status, scanned, purged }`（`scanned` 为扫描的
scope 目录数，`purged` 为删除的记录文件数）。可选 `before` 参数只能缩小范围
（取更早的 cutoff，绝不放大删除窗口）。CLI 在 run 收尾后接着跑会话时钟清扫；
嵌入式宿主自行调度 `purge()`。

**上游不承诺记录级过期（issue #183 第 1 组）。** `expires_at` 是历史遗留字段：内置
文件适配器从不读它，`purge` 只看 scope 时钟，也没有任何上游路径因为时间戳到期而
把记录变得不可见。宿主完全可以自定保留/过期策略（TTL 列、每 run 限额、定时清扫），
契约套件也不会往任何一个方向断言。不要把 `toolResultTtl` 当成 notes TTL：那个旋钮数
的是 provider request-view 里折叠大工具结果的轮数（见
[取回与 request-view 折叠](#取回与-request-view-折叠)），与笔记寿命无关。真正属于
契约的生命周期义务只有 `complete`（把整个 scope 的 `active` 置成 `done`）与一个
真的按自己的时钟删到期记录、并对不可解析的 `before` 报错的 `purge`。

### CLI 侧来源 guard

`bin/final-guard.js` 中的 CLI guard 是确定性的来源检查器，而不是任务完成度评估器
（ADR-016）。证据是本 run transcript 的归档工具输出（`toolOutputs`，字节保真）；没有可重放性过滤——每条归档输出都是证据。（旧 transcript 的 legacy capture manifest 仍可读，但新 run 不再写。）guard 用字符串相等
比对信封声明的 `findings` 与归档捕获值；**从不解析自由散文**。

- 声明的 label 命中归档值 → 该条通过；
- 声明的 label 在归档里存在但值不符 → `action: "revise"`（伪造信号），消息里带上捕获值；
- 声明的 label 在归档里完全不存在（例如派生计数）→ 告警并跳过该条：既无法核验也无法
  证伪，在此处打回只会诱发绕路（已实测）；
- 归档里有捕获值、信封却一条都不声明 → `action: "revise"`。有东西可比却不声明，是模型
  跳过了声明步骤，并不等于“本任务没有可核验值”。guard 在 `finalGuardMaxRetries` 内重试，
  之后 fail-closed 到 `unverified`；绝不会静默放过。

整个 run 没有归档输出时返回 `action: "skip"` 与 `reason: "no_capture_evidence"`。
归档输出里没有可提取候选值时返回 `action: "skip"` 与
`reason: "no_extractable_candidates"`。guard 不添加自然语言推断、关键词猜测或相似度
规则。跳过检查仍不等于 `verified`。

当 loop 必须用 LLM 把散文终答归一化成信封时（`ERIX_WRAPUP_NORMALIZE=1` 或
`reflection.wrapupNormalize`），归一化器只许搬运：每个归一化后的 finding 值都必须逐字
出现在模型自己的终答文本里，否则该条在 guard 看到之前就被丢弃。LLM 不得在通往核验的
路上“修好”模型的值，那会让核验不可复现。这道闸门就是 `normalizeModelJson` 给收尾信封的
同一道（issue #406 B2-b）——引擎与公开归一化器不可能对「什么叫逐字」各持一说。

## 取回与 request-view 折叠

模型侧取回采用 note-first：先用 `note_list` 发现已保存的笔记，再用
`note_read` 读取精确内容。不要猜测遗忘的值，也不要依赖 transcript recall API；
recall 适配器已在 0.8.0 契约中退役。

旧的或较大的工具结果只会在 provider request view 中折叠。`toolResultTtl`
默认为 `2` 轮（`0` 表示禁用），`toolResultFoldMinTokens` 默认为估算的
`4000` token。在 `age === ttl - 1` 的 warning round 中，模型会被要求使用
`note_take` 提取重要事实；折叠占位符包含 navigation digest，并在适用时包含
JSON skeleton。run snapshot 保留完整工具结果文本。note、todo、错误和显式保护的
结果不会折叠。

## 重复命令与副作用（ADR-016）

引擎不做可重放性分类、重跑检测或重跑告知。重复命令会正常执行并返回它的新输出。重跑值
错配的风险由系统提示里的一行承担：“重跑同一命令可能得到不同的值；需要早期精确值时先
用 note_list 再用 note_read，不要凭记忆。”

因此宿主必须在自己的工具能力、权限、沙箱或幂等层里承担副作用与重跑风险，并决定未核验
结果应当触发人工审核、重试还是失败。guard 仍是一个 opt-in 的机械检查器；不要往里面加
自然语言推断、关键词猜测或相似度规则。

## 错误账本（issue #109 第 1 步）

`runToolLoop` 结果带两个恒定存在的账本字段：

- `result.unpersisted: Entry[]` —— run 期间持久化失败的权威记录。默认 `[]`。
- `result.completionErrors: []` —— 预留给收尾阶段失败（在后续步骤接线）；默认 `[]`。

`Entry` 取值之一：

- `persistence_error`：`{ kind, port, operation, phase?, fatal, error: {name, message, phase?}, ts }`，
  其中今天 `port` 为 `"transcript"`；`"resource"`/`"notes"` 随各自接入步骤出现。`error`
  归一化为 `{name, message}`，message 截断到 500 字符（约束 result 体积；丢弃堆栈）。
  **issue #439 起的加法面：** 错误对象自带 `phase` 时原样保留（非空字符串，压平空白并截到
  32 字符——与 run-state 投影的 `safeText(entry.phase, 32)` 同一口径）；取不到就**完全没有
  `phase` 键**（绝不写 `phase: undefined`，也不猜值）。这就是宿主不必解析 `message` 就能分出
  「请求没发出去」（`phase: "request"`）与「流中间断了」（`phase: "stream"`）的字段，而这两类
  可重试性不同。它与条目自身的 `phase`（持久化阶段——`transcript` / `notes` /
  `checkpoint_before_tool` / …）是**两个字段**，后者的语义一字未改。
- `delivery_failure`：`diagnostics.error`（或 `onPersistenceError`）sink 自己抛错——错误
  发生了但结构化事件没送达。`port` 恒为 `"diagnostics"`（坏掉的通道）；出事的端口在
  `failedEvent.port`。
- `ledger_overflow`：账本达到上限（100 条）丢弃记录时生成的申报条目，带 `dropped: number`。
- 另外，`repeat` 字段表示同一失败被去重合并的次数（首条为 1）。

投递保证：账本与 `diagnostics.error` 事件是两条可靠通道；模型可见提示仅为 advisory，
从不计入投递。异常终止的 run 会把账本挂在抛出的持久化失败上，即 `error.unpersisted`——
`persistence_failed` 与 `checkpoint_failed` 上都是原始冻结数组（issue #230：两个出口同形，
`{ count, items }` 投影留在 `<runId>.state.json` 那条路径；见上文「持久化失败上报」）。

`persistence_error` 诊断事件现在带 `port: "transcript"`；该字段是增量添加，既有消费者
不受影响。

## 折叠摘要结构

两种轮次折叠策略（`fold-statistical` 与 `fold-llm`）都会在头部任务消息（或
`summaryRole: "system"` 时的 system 消息）前部冠以单个折叠摘要文本块。其固定分节，按顺序为：

1. 标记行 `【上下文折叠·v1·erix-9f6e2c】早期第 N–M 轮（共 K 轮）已折叠。`，
   外加确定性的工具足迹（`工具足迹：name×count, …` 或 `无`）。
2. 可选的 `导航记录：{…}` 行（有界 JSON，仅当被折叠的工具结果携带归档产物时出现）。
3. 可选的 `[已折叠] …` 存根（最多 10 条）。
4. 恢复提示行。
5. 可选的**锚点索引**分节（机械抽取，不经 LLM 改写）：

   ```
   ## 锚点索引（机械抽取，未经 LLM 改写）
   paths: src/a/b.js:12, …
   shas: 1ed3f35, …
   issues: #32, …
   urls: https://…
   errors: TypeError: …, …
   ```

   锚点用正则从被折叠的负载中抽取——只取自 `tool_result` 内容与真实用户消息，绝不取自
   assistant 散文。各类按固定顺序 `paths, shas, issues, urls, errors` 渲染；
   `errors` 行含 `Error`/`Exception`/`Traceback`/`fatal:`，逐字保留至多 120 字符、
   最多 5 条。同一行内多个值以 `, ` 连接；值内的字面 `,` 或 `\` 在渲染时转义为
   `\,` / `\\`，在该分节被重新解析时反转义，因此每一类都能在反复折叠之间无损往返
   （例如错误行 `Error: failed, retry later` 或 URL 查询串 `?a=1,2` 仍是单个值）。
   注意 `paths` 的正则字符集排除了 `,`，含逗号的 paths 不会被抽取——这是接受的漏报代价。
   上限：锚点总计 20 个，整个分节 1200 字符（按频次排序，其次按首次出现）。连续折叠之间
   该分节会被重新解析并按类做并集合并（既有条目在前、新条目追加、去重）后重新钳制，
   因此锚点在反复折叠中不丢失、不重复、不溢出。

   锚点分节默认开启。传 `anchors: false`（策略工厂或每次 `compact` 的选项）可恢复
   0.7.0 的确切行为——没有锚点分节，且此前折叠摘要中带有的锚点分节会在合并时被丢弃
   （一次 `anchors: false` 折叠会彻底移除早先默认折叠创建的锚点分节）；摘要其余部分
   不变。对象形态 `anchors: { maxPerKind, maxChars }` 可钳制每类条数与分节字符数。
   在 `fold-llm` 中，该分节在 LLM 摘要之后（且在尺寸钳制之后）追加，因此
   `maxSummaryTokens` 截不到它。

## Store 保真要求

宿主 `TranscriptStore` **必须保留完整的 `RoundRecord` 与完整 message 对象**，包括宿主不认识
的字段。不得按字段白名单重建 record 或 message：必需字段会随实现演进，丢弃未知字段可能改变
引擎行为。

这里有两个彼此独立的保真口径：

- **展示投影保真**：保留 `projectTranscriptForDisplay` 读取并生成正确轮次、标签、工具预览、
  折叠摘要、排序与时间戳所需的字段。
- **resume / 模型上下文保真**：`load()` 必须重建相同的 messages、内容块、元数据、顺序与未知
  字段，使模型回放与 judge 过滤看到相同上下文。展示投影看似正常，不能证明 resume 保真。

与投影和 judge 正确性相关的最小字段至少包括：

| 字段 | 丢失后的退化 |
|---|---|
| `messages[].meta.source` | 合成分类会回退到文本前缀启发式；引擎注入的 judge 方向提示可能显示成真实用户消息，并在 resume 后逃过 judge 的 `judge-control` 排除。当前文本启发式不识别其 `【Judge 评审意见】` 前缀。普通历史消息没有该字段，并不能证明 store 有损。 |
| `messages[].content[type="tool_use"].id` 与 `messages[].content[type="tool_result"].tool_use_id` | 工具调用无法与结果配对，投影中的工具结果预览会丢失。 |
| `response.content`（含 reasoning 块） | assistant 输出、工具调用或推理可能从投影及重建的模型上下文中消失。 |
| `folded` | 折叠轮横幅与折叠段呈现被省略。 |
| `foldedRoundRange` | 横幅失去精确的折叠轮次范围。 |
| `foldedPayload` | 恢复与锚定所需的折叠归档消息不可用。 |
| `navigationRecord` | 折叠导航及归档产物链接丢失。 |
| `summary` | 组合折叠摘要失去轮次 action/note 兜底内容。 |
| `round` | 轮次丢失轮号，无法按记录的轮号排序。 |
| `ts` | 投影轮次失去时间戳。 |

有损 store 当前不会触发报错。投影会静默回退：部分合成消息使用文本前缀嗅探，缺少 response
时用 `textPreview`，缺少带标记的折叠摘要时用 `summary` 兜底；这些回退不会检测或报告 store
有损。宿主必须自证保真，例如针对自身 schema 与未知字段运行并扩展
`test/contract/transcript-store.js` 中的断言。

### 档案行形状：消息行 + 只留元数据的轮行（工单 261021）

自 **0.23.0** 起，引擎把一条消息在**成型的那一刻**写进档案，而不是整轮末一次性写。一个档案行只携带
一条消息：

```ts
{ round, roundKey: `${runId}:round:${round}`,
  dedupKey: `${runId}:msg:${round}:${seq}`,   // seq 轮内从 0 单调递增
  kind: "message", seq, messages: [那一条消息], ts,
  partOf?: string }                            // 已写入的那条消息的分片
```

轮行本身（`<runId>:engine:round:<n>`，在 `src/loop/orchestrator.js#runToolLoop` 里以 `record`
构造）对新 run **只留元数据**：`response`、`textPreview`、`toolUses`、`summary`、`l0facts`、
`runState`、`judge`、`wrapup`、`compactionStats`、`toolOutputs` … —— `messages` 字段已消失。
`src/store/message-rows.js#foldMessageRows`（两个内置 store 的 `load()` 都会调它）把消息行
折回那条轮行，因此 `load()` 的宿主可见形状——以及
`records.flatMap((record) => record.messages ?? [])` 这条口径——与改造前写出的账本**除 #439 新增的
逐条 `ts` 外**逐字一致（下一条；金样：`scripts/message-journal-golden.mjs`，夹具里没有消息行，
因此它钉的正是 #439 之前的形状）。

对宿主 store 与宿主读方的以下推论：

- `kind`、`seq`、`partOf` 从此是**携带保真语义的字段**：丢了它们，消息行就折不回去，会
  以独立行的形式留在 `load()` 数组里。分组看 `round`，排序看 `seq`。
- **从消息行折出来的每条逻辑消息都带自己的 `ts`（issue #439）。** 消息行在消息成型时就打了 `ts`，
  所以折叠把它放到**消息对象上**：`load()` 结果里每条逻辑消息都有 `messages[i].ts`，
  取值是**首片行**的（起头那条消息的那一行——与 issue #430 的「锚点钉在首片」同一口径；
  `partOf` 分片只往后面接 content block，不改写这个戳）。没有它时，宿主做时间线/延迟分析
  会**对每一条走过折叠的消息都没有时间戳**：载体行自己的 `ts` 是**轮行**落盘的时刻，不是
  这条消息成型的时刻。行上没有 `ts`（手写行、不落 `ts` 的宿主 store）⇒ 消息上**完全没有
  `ts` 键**，绝不是 `ts: undefined`。
  **这个限定的边界（两个真实形状）：** 承诺只覆盖「**从消息行**折出来的」消息，因此没有经过
  消息行的 `load()` 消息没有 `ts`——① 载体是**旧版折叠产物**（≤0.24.0，或宿主自研折叠）；
  ② 载体行**自己**带的引擎控制正文（`…:resume` 行的控制文本）。
  **「这一轮已折过」的守卫对逐条 `ts` 是盲的（刻意的）：** 它判的是**同一段正文**是否已折过，
  比较时两侧都剥掉信封 `ts`（`withoutJournalTs`）。因此载体已带同一段正文时该轮跳过，**即便
  载体里那些消息没有 `ts`、或者 `ts` 不同**——**不回填**。这是加法面：既有键一个未改；
  引擎自己的恢复路径刻意按
  **不含逐条 `ts`** 的规范化消息读账本（`foldLedgerMessages`），于是同一份折叠输入跨 resume
  保持同一个身份（折叠摘要的复用键，issue #326，就是拿这些消息算的）。
  **不要把 `load()` 折出来的消息回写成消息行。** 消息上的 `ts` 是**嵌套** payload 字段，不是
  同 key 摘要会剥掉的那个**顶层**信封 `ts`：原样回写同一个 `dedupKey` 会判成 payload 冲突
  （`code: dedup_payload_conflict`、`differingFields: ["messages"]`；实测如此——基点版本不撞）。
  排除表就只剥四个**顶层**字段，见 `### 同 key 异 payload 的冲突（issue #326）` 一节
  （「嵌套的 `ts` 算内容」）。
- 不要假设「轮行携带正文」。载体可能是 `<runId>:engine:round:<n>`、`<runId>:round:<n>`
  （宿主默认键）或 `<runId>:engine:round:<n>:resume`；如果 run 崩在轮行落盘之前，消息行会
  原样留在数组里——这是崩溃恢复契约，不是 store 缺陷。
- 引擎控制文本行（`src/loop/orchestrator.js#appendEngineMessagesToTranscript` 写的
  `<runId>:engine:round:<n>:control:<slot>`，以及 `appendEngineFactToTranscript` 写的
  `…:fold:` / `…:ttl:` 事实行）刻意不带 `seq`，因此折叠层原样透传。
- **续跑后账本闭合（工单 261021）。** 同一个 `runId` 再跑一次（`resume: true`）只从账本重建
  上下文，而账本是**追加式**的：已落盘的行不会被改写，续跑只在其后追加。因此 `load()` 折叠后
  每条逻辑消息**恰好出现一次**，一次工具调用也**恰好一份结果**（同 `erix.toolCallKey`、同
  `tool_use_id`）——**每一个**结果都会落成行，不只是续跑重新执行的那批：崩溃时**已经执行完**
  （结果已成型、账本里还没有对应行）的那批结果，由
  `journalResumeUnpersistedToolResults`（`src/loop/orchestrator.js`）在补跑段**之前**用同一条
  写侧写下去。两类结果都用 `partOf` 接回崩溃轮那条聚合 `tool_result` 消息，不新增消息；锚点就是
  `restoreResume`（`src/loop/resume-manager.js`）从账本里读出的 `resumeToolResultRowKey`。
  崩溃轮**一条结果行都没落**时，首片自己就是那条聚合消息、并成为后续分片的锚点。锚点永远是**首片**，
  **不随分片推进**：分片行的 key 不是合法的 `partOf` 寻址目标（分片不新增逻辑消息，折叠会把它的 key
  映射到**下一条**消息），这正是「把 `partOf` 链到上一片」时第三条结果会自己新起一条消息的原因。于是
  同一崩溃轮的**所有**结果都折回**一条**聚合 `user` 消息，条数不限，绝不会变成「每条结果各一条
  `user` 消息」，`<runId>:msg:<round>:<seq>` 的序号语义也按 issue #326 保持。钉住它的是
  `test/loop-resume-unpersisted-tool-results.test.js` 里的 `#430` 端到端用例（前两例共用同一份崩溃
  现场：`threeToolCrashScene`（`test/loop-resume-unpersisted-tool-results.test.js`））与
  `test/store/message-rows-fold.test.js` 的四行单元用例；修前三个工具调用实测折成 `[[t1,t2],[t3]]`、
  第二次恢复 `invalid_messages`（issue #430）。
  issue #420 之前这半批结果靠 `resumeUnpersistedToolResults` 交出去，
  注释承诺「交给 orchestr 逐条入账」，而全仓没有读取方：它唯一的载体是 latest-only 覆盖写的 run
  snapshot，下一轮真跑一个工具就被覆盖 ⇒ 那个 `runId` 从此不可恢复（第一次模型请求之前就
  `invalid_messages`，0 次请求）。**升级路径的守卫（issue #424）**：逐条消息行出现之前写下的账本里，
  崩溃轮的 `assistant` 正文只存在于 run snapshot，此时把那批结果入账就会留下「没有配对 `assistant`」
  的 `tool_result` 行，下一次恢复同样 `invalid_messages`。因此
  `journalResumeUnpersistedToolResults`（`src/loop/orchestrator.js`）先看一个由
  `restoreResume`（`src/loop/resume-manager.js`）在**折叠后的**账本条目上算好的事实——崩溃轮的正文里
  是否已有 `assistant` 消息；没有就**整段跳过**入账（退回 #420 之前的语义：只进内存、由快照兜住），
  账本内容与 #420 之前的档案逐字一致，并在既有 `onEvent` 通道上恰好发一条
  `resume_journal_skipped`（`{type, runId, round, reason, count}`）。宿主可见的顺序有一个细节：崩溃轮的载体行
  `…:engine:round:<n>:resume` 写在宿主
  `:input:` 行**之后**，而折叠把正文挤到载体行的位置上（`load()` 按追加顺序返回），所以
  `load()` 里「续跑提示」可能排在崩溃轮正文之前；模型上下文不受这个顺序影响——
  `restoreResume`（`src/loop/resume-manager.js`）把 `:input:` 行当 tail，延后到补跑结果之后才拼。
  真上游守卫：`examples/resume-real-e2e.test.mjs`（`ERIX_E2E_REAL=1`：真进程 SIGKILL → 同
  `--session` 续跑 → 账本闭合 / 不丢 / 不重复执行 / 半行隔离）。
- **读账本一律过 `load()`，不要自己拿原始行再折一遍。**
  `foldMessageRows`（`src/store/message-rows.js`）是唯一的读侧，而且自 issue #401 起它是**公共 API**：
  `import { foldMessageRows } from "erix-agent"`。自己拼 `load()` 返回值的宿主 store 直接调它就行——
  这个模块的深路径不在包的 `exports` 里，而在 #401 之前这个函数在打包安装里**根本拿不到**
  （`ERR_PACKAGE_PATH_NOT_EXPORTED`），所以「自己实现一套折叠」是当时唯一可选项。自己重实现折叠——例如按内容
  指纹给消息去重——会把**合法的重复**静默丢掉：两条前 400 字符相同的长消息会被并成一条，
  而任何基于那个数组的计数都会错，且错不错取决于负载文本（「CLI 是不是真跑了 ≥2 次工具」
  这种计数可能读成 1）。仓内先例：`scripts/cli-real-smoke.mjs` 的工具结果计数取自
  `createFileTranscriptStore({ dir }).load(runId)`。

### 落盘行形状 ≠ `load()` 之后的形状（issue #361）

这是两个形状，只有第二个是宿主读到的。issue #353 就是宿主把第一个当成了第二个，于是报了一条
**不存在的** 0.23 回归。

**`load(runId)` 返回的是折叠后的形状。** `foldMessageRows`（`src/store/message-rows.js`）
在两个内置 store 的 `load()` 里都会跑——`createMemoryTranscriptStore`（`src/store/memory.js`）
与 `createFileTranscriptStore`（`src/store/file.js`）——它在数组返回前把每一条
`kind: "message"` 行的正文折回该轮的载体行。哪一行算载体由
`isRoundCarrier`（`src/store/message-rows.js`）判定。宿主自己实现的 `TranscriptStore`
必须产出同样的结果：折叠是读侧，不是可选项。

**落盘的不是这个形状。** 档案里的轮载体行（`<runId>:engine:round:<n>`）只留元数据，**根本没有
`messages` 键**；正文在各自的 `kind: "message"` 行里。所以数行数、数轮数、读正文三件事都必须先过
`load()`，不要自己拿原始行拼一遍。拿原始档案去摊平 `record.messages` 得到的是空数组，不是 transcript。

**行数 ≥ 轮数是常态（#326 之后）。** `load()` 的结果里除了消息行，还有引擎事实行
（`…:engine:round:<n>:fold:<fp>` 与 `…:ttl:<fp>`，构造上就是 `messages: []`）和引擎控制行
（`…:engine:round:<n>:control:<slot>`，带 `messages` 但不带 `seq`）。所以「一轮一条记录」从那时起
就不再成立。宿主 materializer——任何把 `load()` 输出变成轮次的东西，无论为了展示、入队还是写进第二个
store——必须按 `round` 归并、按 `dedupKey` 去重，不得假设记录与轮次一一对应。这正是 issue #328 C 组
对 station 与 touwaka 的 materializer 提的要求，而本段就是它在本仓的权威出处。

**一条可核对的判据。** `load()` 之后，一条轮记录的 `messages` 里同时有 `tool_use` 块与配对的
`tool_result` 块——是两条消息，但在同一条记录内。这正是 #353 探针里 `[ok]` 与 `[pending]` 的分界：
折叠生效时，续跑重建出的治理时间线把该工具调用标成 `[ok]`；折叠不生效时，调用与结果落在不同行、
配不上对，同一条时间线只能读到 `[pending]`。

### 折叠是公共 API，引擎兜了一层（issue #401）

**未折叠 store 的两个症状**（`load()` 把落盘行原样返回——issue #401 背后那条真机事故）：

1. **治理时间线读成 `[pending]` 而不是 `[ok]`。** `tool_use` 与它的 `tool_result` 落在两条不同记录里，
   配不上对；该轮的时间线条目于是被建构成「调了、没人答」。
2. **一轮被数成很多条。** 每条消息行都是独立记录，于是任何数记录的东西——治理的轮次历史、
   `l0facts` 的重抽取、「这次 run 真调了几次工具」的计数——都把一轮正文读成好几条消息。

还有第三种形状，它不是症状而是另一种 bug：既折了**又**保留原始消息行的 store，会把同一轮正文
返回两遍（实测：两条消息的一轮变成 `assistant+user+assistant+user`）。

**引擎现在做什么。** `restoreResume`（`src/loop/resume-manager.js`）在重建上下文之前，把
`store.load()` 的返回值**再折一次**，于是 resume 这条路不再依赖宿主有没有折。折叠本身会跳过
**载体行已经带着这一轮折叠正文**的轮（`foldMessageRows`，从包根导出）——正是这条规则让「两份都留」
那种形状不会把正文翻倍。

**但仍然建议宿主自己折。** 这层兜底只管 **resume 路径**。展示投影
（`projectTranscriptForDisplay`，`src/display/projection.js`）直接读 `load()` 的输出，未折叠的 store
在它那里仍然是歪的；你自己按 `records.flatMap((record) => record.messages ?? [])` 写的每一个读方同理。
折叠属于 `load()`；`foldMessageRows` 现在从打包安装里拿得到，这条义务才真的可履行，
而 `test/contract/transcript-store.js` 现在会断言它——三格判据，原样存取的 store 会红
（实测：既有 22 格全绿、三格折叠判据全红）。

## 工具事实与字段归属（issue #284 / #285）

引擎产出的每一条 `tool_result` 都是一个**事实对象**，只在一个构造点产生：
`src/tool-fact.js` 的 `buildToolResultFact()`，与下面的常量一起从包根导出。「谁拥有哪个
字段」本身是一个导出常量 `TOOL_RESULT_CONTRACT`，由**三方消费同一份**：构造器按它写路径，
`test/contract/tool-result-envelope.js` 从它生成期望字段集合，`check:docs` 锚点把本节下面
这份字段清单与它**双向**比成员（并核对中英两侧的声明点处数）。因此任何一个引擎字段改名
或新增，另外两方会立即变红，而不是各说各话。

三条硬规则：

1. 宿主扩展只能写进 `metadata`；引擎不会读出它们去覆盖引擎事实；
2. 引擎事实只能写进 `erix`；构造器最后才写该命名空间，因此摊平到顶层的宿主键盖不掉它；
3. `is_error` 留在顶层——它是 wire 字段（Anthropic 请求构造器会发出去），不是命名空间成员。

`metadata` 与 `erix` 是**保留的顶层键名**，登记在 `TOOL_RESULT_CONTRACT.reserved.topLevelKeys`
里。下面那张退役表之后已经**没有摊平这一步**了，所以这两个名字是构造器**独占**的（不再是
「被过滤器跳过」）：宿主那个恰好同名的扩展键只能住在宿主命名空间里，在
`metadata.metadata` / `metadata.erix` 取得到。退役之前它确实会先被写到顶层、一条语句之后
就被自己的命名空间盖掉——活下来什么取决于写入顺序而不是归属。**刻意不**登记为保留键的是
`type`、`tool_use_id`、`content`、`is_error`，这一刀**没改**这份登记（要不要收紧它是另一个
决定，不是这一刀的）。但顺带的变化值得知道：宿主键被摊到顶层的那段时期里，一个写作
`content` 或 `is_error` 的扩展键真的会盖掉协议字段；现在宿主扩展再也没有通往顶层的路，
也就再盖不动了。

构造器从不把 `metadata` 摊平到顶层，而这一刀之后它**一个别的顶层键也不写**：引擎产出的
`tool_result` 恰好就是协议字段 + `metadata.*` + `erix.*`。`erix` 与 `metadata` 都不会发给 provider：两个协议
转换器都按显式字段清单序列化 `tool_result`，所这两个命名空间都是 `onWire: false`。输出
卫生、单轮聚合、折叠三层只替换 `content`，事实字段原样存活。

### 字段清单（与 `TOOL_RESULT_CONTRACT` 锚定）

协议必需字段是 `type` / `tool_use_id` / `content`。条件协议字段只有一个，就是 `is_error`：
仅在结果为错误中断时存在。引擎命名空间恰好五个字段，每一个都以 `erix.<字段>` 寻址：
`toolCallKey` / `round` / `durationMs` / `executionStatus` / `success`。宿主命名空间就一个
键，内容就是 executor 交回来的扩展。

| 字段 | 拥有者 | 写入时机 | 含义 |
|---|---|---|---|
| `type`、`tool_use_id`、`content` | 协议 | 总是 | `tool_use_id` 是 provider 的配对键：引擎只读它、永不改写它（`groupIntoRounds`/`validateMessages` 的配对校验与 run snapshot 的复放查找都依赖它）。 |
| `is_error` | 协议 | 仅错误/中断结果 | wire 字段，按设计就在顶层。 |
| `erix.toolCallKey` | 引擎 | 每一个被引擎接受的 `tool_use`，以及由它构造出的结果 | 跳通道身份：一次被接受的调用只分配一次，从第一个可识别的流式片段开始，一路带到 `tool_use` 块（因此也在持久化块与 `tool_use` 事件克隆上）、`tool_result` 与投影。resume 与复放**沿用**已落盘的值，已有身份的调用绝不重生成。但 provider 的配对 id **不是身份**，也不保证 run 内唯一（轮内 index 前缀，或畸形响应兜底成 `call_legacy`），所以下一轮再出现同一个 id 就是**一次新调用**，会拿到新 key：只有被确认为同一次调用时才继承 —— 本轮的复放窗口，或从崩溃现场恢复回来的那一条 pending 调用。**升级前写下的记录复放时两端都缺身份**（见下面那条 carve-out）。 |
| `erix.round` | 引擎 | 调用真的执行了 | **执行轮**。它不是事件 envelope 的 `round`（交付轮），两者刻意不合并。 |
| `erix.durationMs` | 引擎 | executor 的 promise settle 或 reject 了 | 从「调用 executor 前」到「该 promise settle/reject」的毫秒数。 |
| `erix.executionStatus` | 引擎 | 仅特殊状态 | `intercepted` / `interrupted` / `rejected`。这个存在条件同样机器可读：`TOOL_RESULT_CONTRACT.engine.fields.executionStatus` 携 `writtenFor: "special states only"` 与 `presentValues`（`src/tool-fact.js`），因此只读常量的宿主不得假设每个结果块上都有这个字段（issue #286）。`rejected`（issue #409）表示这次调用的引数解析不了，工具**从未执行**，结果正文是解析器判词。 |
| `erix.success` | 引擎 | executor 的 promise settle 过的每一条结果 | 引擎归一化后的布尔值（`success !== false`）。顶层 `success` 退役后它就**无条件写**：顶层没了以后还按「宿主声明过才写」，宿主就分不清「成功」与「没表过态」。根本没跑的调用（judge 拦截、中断重放）没有成败可言，因此也没有该字段。 |
| `metadata.*` | 宿主 | executor 返了扩展就有 | 宿主唯一可写的命名空间。 |

### durationMs 在 executor settle 时刻捕获，缺失就是未知

`durationMs` 只覆盖一个区间：从「调用 executor 前」到「该 promise settle 或 reject」。它
**不含** `onToolResult` 改写、输出卫生与单轮聚合预算。`durationMs` 缺失意味着 **未知，
不是 0**：根本没跑的调用（judge 拦截）、被当作中断重放的 unsafe 调用、以及 executor 尚未
settle 就被中止的调用都没有耗时字段，而 `?? 0` 会把「我们不知道」渲染成「它瞬间完成」。
executor 的六种返回形态（`string`、`number`、`{content, metadata}`、遗留的 `{data}`、
返回的 `Error`、抛出的非 abort 异常）都带耗时，因为「报错前跑了 40ms」也是一件事实。

这曾是一次**口径收紧**：旧顶层 `duration` 键保持历史行为，即只有当该钩子返回**结构化**
对象时才会把 `onToolResult` 的耗时算进去，所以双写期内两个数字在那条路径上会合法地不相等。
那个顶层键现在已退役，`erix.durationMs` 是引擎发布的唯一耗时——一个测量、一个口径，
不再需要对着两个数字调和。

### 双写结束时的退役名单，以及旧记录一代内可读

T1 承诺的双写期到一个 minor 为止，本刀就是结束它的那一刀。引擎**不再写**下面这些顶层名，
所以还在读它们的宿主必须迁移（CHANGELOG 挂 `Changed（BREAKING）`）：

| 退役的顶层名 | 新归属 |
|---|---|
| `erixRound` | `erix.round` |
| `duration` | `erix.durationMs` |
| `executionStatus` | `erix.executionStatus` |
| `success` | `erix.success` |
| 摊平到顶层的任意宿主键 | `metadata.<宿主键>` |

两件事要分清：

1. **写入已停。** `buildToolResultFact()` 里那条摊平路径整个删掉了，所以退役名不可能从哪个
   调用点默默回来。引擎产出的 `tool_result` 恰好带 `type` / `tool_use_id` / `content`
   （错误与中断结果另带 `is_error`）、`metadata.*`、`erix.*`。写作 `content` 或 `is_error` 的
   宿主扩展键也再也盖不动协议字段了，它的家在 `metadata.content` / `metadata.is_error`。
2. **读侧仍留一代。** 升级前落盘的记录里可能仍带着这些名字，而所有读路径都是**引擎命名空间优先、
   顶层只作旧记录回退**：TTL 折叠（`src/loop/tool-result-ttl.js`，年龄标记）、投影
   （`src/display/projection.js`，执行状态）、续跑复放（`src/loop/orchestrator.js`，原样带回
   已记录的那一块，不重算也不补写）、单轮聚合预算（`src/loop/aggregate-budget.js`，
   「拦截不是输出」）、judge 的时间线与对话渲染（`src/reflection/judge.js`）、L0 客观事实
   （`src/reflection/l0.js`）、以及 `hasSuccessfulToolResult`（`src/loop/messages.js`）。
   `TOOL_RESULT_CONTRACT.legacy` 写着同一张表，外加 `written: false` 与上面这个读窗口——
   也就是说「什么退役了」由常量说，不靠散文。

这一刀里唯一一处**新增信息**而不是搬家的事：`erix.success` 对每一条 executor settle 过的结果
都写，不再只看宿主声明没声明。取值仍是退役前顶层那个表达式（`success !== false`），所以宿主
原来依赖的语义一点没变；`success: 0` 过去会以裸值 `0` 出现在顶层，而 `erix.success` 从 T1 起
就是归一化后的 `true`——那个归一化不是这一刀新加的。

### 存在性矩阵

这张矩阵就是 `test/contract/tool-result-envelope.js` 的验收表：每一行都有对应断言，外加
反向断言（拦截没有耗时、复放不重算、宿主同名键**只在** `metadata` 而绝不在顶层、退役名单里
的顶层旧名一个都不许再出现、provider `id` 未被改写）。

| 情形 | erix.toolCallKey | erix.round | erix.durationMs | is_error | erix.executionStatus | B 里有记录 |
|---|---|---|---|---|---|---|
| 成功（string / number / 结构化 / 遗留四形态-pass） | 有 | 有 | 有 | 无 | 无 | 有 |
| 失败（返回 Error / 抛非 abort 异常） | 有 | 有 | 有 | 有 | 无 | 有 |
| judge 拦截 | 有 | 无 | 无——从未执行 | 无 | intercepted | 有 |
| 引数解析不了（issue #409） | 有 | 无 | 无——从未执行 | 有 | rejected | 有 |
| resume 里的 unsafe 中断重放 | 有，沿用落盘值 | 无 | 无 | 有 | interrupted | 有 |
| 已完成结果的复放 | 有，同一个值 | 原值 | 原值，不重算 | 原值 | 原值 | 复用原记录 |
| executor 未 settle 就中止 | tool_use 上有 | 无 | 无 | 无 | 无 | 可能没有 |

`erix.success` 刻意不是矩阵的一列：输入侧是 executor 的返回形状（`{content, success:false}`，
并保留历史的 `value.success ?? metadata.success` 兼容读），输出侧是归一化后的布尔值，
对每一条 executor settle 过的结果都写。两侧不得混为一谈：executor 的**返回值**里带
`metadata.success` **确实**参与上面的归一化（就是上文那个历史兼容读），所以 executor 仍可以
靠它报失败；但宿主往一条**已经生成的** `tool_result` 里（在 `metadata.*` 内）写
`metadata.success` 只改变记录本身——`erix.success` 是引擎在 settle 时写的，**永不**从
`metadata.*` 反推。

### 实时事件流与 transcript 之间的那一条等式

`tool_use` / `tool_result` 事件在 `RoundRecord` 存在之前就发出了，所以事件流不是从记录
派生的。只承诺一条相等：对于已提交的调用，事件里的事实与记录里存下的块必须带同一个
`toolCallKey`、同一个配对 id、同一个 `is_error`、同一套 `erix.*` 与同一份 `metadata`——
同一个对象的两个克隆。`content` 不在等式里（折叠可能改它），事件 envelope 与增量永不
进入记录，折叠也不会倒灌成更早的事件；run 被中止或 append 失败时记录可以就是没有——
引擎从不为了把等式捽圆而发明一条记录。

### carve-out：复放升级前写下的记录

升级前写下的 run snapshot 里根本没有 `erix`。复放这样一条记录，是同一次调用的**两端都
没有 `toolCallKey` 的唯一合法情形**：引擎原样复放那条已记录的结果（它从不回写已落盘的
事实），并且这一轮**也不给配对的 `tool_use` 块认领** key。两端都缺才是诚实的状态——
凭空造一个 key 会让 `tool_use` 端带着一个 `tool_result` 端没有的身份，比两端都缺更糟，
因为宿主于是无从判断该信哪一端。具体说：

- 引擎什么都不伪造：不造 `erix` 对象、不造顶层 `toolCallKey`，也不从配对 id 推出一个；
- 宿主因此必须把 `toolCallKey` 看成**逐调用可选，而不是逐版本可选**：从升级前的检查点
  续跑的 run 会把「无身份的 fact」与「有身份的 fact」混着交出来，无身份那几条请按配对 id
  建自己的卡；
- 升级之后被接受的调用不受影响——两端一定带同一个 key。

`test/contract/tool-result-envelope.js`（「复放升级前的已记录结果」那条）钉住了这个行为。

## onEvent 工具事件字段清单（issue #284 / #285）

`onEvent` 是结构化事件的单一通道；下面列出引擎循环发出的与工具相关的事件类型，以及每个
事件携带的载荷字段，这样宿主不必猜「哪个身份键在哪个位置」。下面的字段名是载荷键，不是
`erix` 路径：`toolUse` 与 `toolResult` 就是事实对象的克隆，所以上一节的一切都能从它们取到。

| 事件类型 | 载荷字段 | 说明 |
|---|---|---|
| `tool_use` | round, toolUse | 每个被接受的调用恰好一条；发出时身份键已挂在块上，因此引擎接受的调用里 `toolUse.erix.toolCallKey` 必在。 |
| `tool_result` | round, toolResult | 就是上面说的事实克隆。`round` 是**交付轮**：复放时它完全可能不同于事实里的执行轮。 |
| `tool_replay_decision_required` | runId, round, toolUseId, toolName, replay, requiresHostDecision, partialOutputAvailable | 在配对的那条 interrupted 结果**之前**发出。本单它仍只带 provider 配对键：把身份键也加进来不在本工单范围内，目前请按 `toolUseId` 关联两者。 |
| `tool_output_aggregate` | round, toolUseId, name, action, reason, budgetTokens, inlineTokens, costTokens, projectedTokens, contentLength, archivedBytes | 单轮输出预算。`projectedTokens` 只出现在准入路径，`archivedBytes` 只出现在归档/不可恢复路径；该事件只讲 content 体量，从不携带事实字段。 |

流式片段**不是** `onEvent` 事件：引擎循环把片段交给 `onToolCall` 回调，那里的 fragment 保持
历史形状（`index`、可选 `id`、可选 `name`、可选 `argumentsDelta`），现在额外带一个
`toolCallKey`——与被接受的 `tool_use` 块同一个值，从第一个可识别片段起就一致。宿主直接
调用 provider 时，provider 可以额外向它被交给的 `onEvent` 回调发自己的 `tool_call` 事件；
引擎循环不注入那个回调，所以一次普通的 `runToolLoop` 一个 `tool_call` 也不发，随包套件
钉住了这个事实。

## 宿主展示投影

transcript 就是模型上下文真相：`RoundRecord` 为回放保持字节保真，同时携带模型面对的
负载与面向展示的字段。需要人类可读聊天视图的宿主应从 transcript 派生，而不是维护第二
张有损消息表。`projectTranscriptForDisplay` 是官方、宿主无关的投影助手：

```js
import { projectTranscriptForDisplay } from "erix-agent";

const turns = projectTranscriptForDisplay(await store.load(runId));
// [{ key, role, text, blocks, toolCalls?, reasoning?, folded?, round, ts, meta }]
```

**输入必须是 `store.load()` 的折叠输出，不是原始 journal 行。** `load()` 是 journal 的读侧：
账本改成「一条消息一落盘」之后，一个 run 的文件里有两种行——轮行（带 `response.content`、
**没有** `messages`）与消息行（assistant 正文，落盘于工具执行**之前**，因此不带 `erix`
执行事实）。直接把原始行喂给投影，同一轮会被投影两遍（`toolCallKey` 重复），并且执行事实
（如 `erix.durationMs`）全部缺席——投影本身没错，错在宿主的输入。请从引擎自己的恢复路径
用的同一个入口取数组：文件账本 `createFileTranscriptStore({ dir }).load(runId)`，内存账本
`createMemoryTranscriptStore().load(runId)`，把**那个**数组交给投影。

它是纯函数：无 I/O、无模型调用、构造结果时不变更输入记录、无宿主特有假设。它接受任意记录
子集（过滤或切片后的 `load()` 结果均可），按 `round` 升序返回轮次；没有可用 `round` 的记
录保持输入顺序并排在最后（同 `round` 的记录也保持输入相对顺序）。

### 投影身份与工具调用形状

每条投影轮次都有一个 `key`，派生格式为 `${roundToken}#${recordIndex}:${entryIndex}`。
`roundToken` 在 round 可用时为 `String(round)`，否则为 `?`；`recordIndex` 是记录在输入数组
中的零起始位置，`entryIndex` 是该记录所投影出的轮次零起始位置。每个工具调用也有一个
`key`，格式为 `${turnKey}:t${toolCallIndex}`，其中 `toolCallIndex` 是该轮 `toolCalls` 数组
中的零起始位置。同一次投影内这些 key 唯一；使用同一输入数组再次投影时，它们具有确定性。
它们不是持久标识：过滤、切片或追加输入数组都可能改变 key，不保证不同输入数组之间保持稳定。

`toolCalls` 是摘要数组，其公开形状为：
`{ key, name, id?, argsSummary?, resultPreview?, isError?, executionStatus? }`。

| 字段 | 含义 |
|---|---|
| `key` | 宿主渲染用的非空工具调用身份，由所属轮次 key 与位置派生；它不是 provider 的工具调用 ID。 |
| `name` | provider 提供的工具名；缺失时为空字符串。 |
| `id?` | provider 提供的 `tool_use.id`，存在时转为字符串，缺失时省略；它仍用于结果关联，而 `blocks[].id` 原样透传。 |
| `argsSummary?` | 工具输入的有界单行摘要；没有可摘要内容时省略。 |
| `resultPreview?` | 关联工具结果的有界预览；没有非空结果文本时省略。 |
| `isError?` | 关联结果是否明确标记为错误；没有错误标记时省略。 |
| `executionStatus?` | 关联结果提供的字符串执行状态；否则省略。 |

在单条记录内，结果按消息顺序以 `tool_use_id` 建索引；多个 `tool_result` 块复用同一 ID 时，
后写入的结果覆盖先前结果。该记录中所有 ID 相同的工具调用都会拿到同一条最后结果。这是当前
行为，不是按出现顺序配对；provider 复用工具调用 ID 属于退化输入。结果仅在单条记录内关联，
不会跨记录匹配。provider 未提供 ID 时，工具调用仍有展示 `key`。

投影结果不会被冻结或深拷贝。每轮的 `blocks` 是新数组，但普通块元素与输入共享引用；修改
元素会改到输入记录。只有为移除折叠标记而拆分的块才会重建为 `{ ...block, text: head }`，
修改该块不会改到输入块（其中嵌套对象仍是浅层共享）。每轮的 `meta` 对象是新建的，但存在时其内嵌值
（如 `meta.usage`、`meta.navigationRecord`、`meta.foldedRoundRange`、`meta.summary`、
`meta.judge`、`meta.wrapup`）与输入共享引用。若需保持源 record 不变，宿主应把这些共享值
视为不可变。

### 宿主可渲染哪些 `RoundRecord` 字段

| 字段 | 通道 | 宿主指引 |
|---|---|---|
| `textPreview` | 展示 | 有界的 assistant 文本预览。可安全渲染；投影仅在 `response` 缺失（旧记录）时用它兜底。 |
| `summary` | 展示 | 每轮的 `{ action, note }` 摘要（或 `"missing"`）。可安全渲染，通常作单行轮次注解。它**不是**折叠摘要。 |
| `folded` / `foldedRoundRange` | 展示 | 标记早期上下文被折叠的轮次及被折叠的 round 区间。可安全渲染为“此段已折叠”横幅。 |
| `foldedFacts` | 展示 / 取证（有界） | 被折掉的**早期历史**的机械替代物：`src/compact/fold-summary-journal.js` 的 `buildFoldedFacts()` 返回值 `{ text, source, strategy, from, to, rounds, bytes, truncated?, degradeReason? }`，按 `FOLDED_FACTS_MAX_BYTES` 夹断。纯加法：`summary` 仍是**本轮自身**摘要，不被它覆盖；`source` 交代文本出自策略还是摘要器。resume 侧 `planFoldedHistoryTrim` 会拿它当替代物，按水位线把正文从重建的上下文里摘掉，并在 `summarySource` 里如实标 `strategy`（模型未必见过这份文本）——issue #470。 |
| `foldedPayload` | 展示（有界） | 被折叠移除的原始消息，**仅含本轮新折走的那部分**：引擎会对着本会话已归档的内容去重，并把归档夹到一个字节预算（默认 262144 字节，`context.maxFoldedPayloadBytes` > 环境变量 `ERIX_FOLD_ARCHIVE_MAX_BYTES` > 默认值，`0` = 只留指针）——issue #460。它仍然是归档而不是展示文本：**不要**倒进聊天视图。投影只报 `meta.foldedPayloadMessages`（计数）。 |
> **resume 会按折叠水位线裁正文（#462）。** 恢复时引擎从轮行推导水位线（`foldedRoundRange.to`），把水位线及以下的那些轮从重建的上下文里摘掉，再把一份**覆盖到水位线**的折叠替代物接回头部。可当替代物的有两个键：模型本来就在看的 `record.foldedSummary`（事实行，区间嵌套在 `foldedRoundRange.{from,to}`），以及 #470 之后同样可用的 `record.foldedFacts`（轮记录键，区间是**平铺**的 `{from,to}`，见上表）——后者让**不调 LLM 摘要器**的宿主（`sliding-window` / `fold-statistical`）续跑时不再从第 1 轮重折；用它回填时 `summarySource` 如实标 `strategy`（模型未必见过这份文本）。于是宿主在续跑后看到的重放正文会变少——账本本身不改写，被摘掉的正文各自那一行都还在。**两个键都挑不出覆盖水位线的事实**时（升版前的老账本，或折走来自预算兜底那条既无摘要也无替代物的路径），续跑上下文与今天逐字一致，所有正文保持可见。规划与回填在 `src/compact/resume-fold-trim.js` 的 `planFoldedHistoryTrim` / `injectFoldSummaryIntoHead`，两个键的形状差异（嵌套 vs 平铺）由 `pickCoveringFoldAlternative` 显式适配。**注意 #470 之后「预算兜底折走」不再等于「逐字一致」**：那条路现在也带 `foldedFacts` 替代物，水位线以下的正文同样会被裁掉。

> **投递出口 `onFoldSummary`（#470）。** 折叠替代物是**宿主侧的数据**，所以宿主不该自己去轮询账本、也不该反过来猜 `record.foldedFacts` 的语义。`onFoldSummary?.(payload)` 在**替代物定稿处**被调用，**一次折叠一次**，递的是**落进轮记录的那一份**的克隆再加 `round`（`{ ...foldedFacts, round }`：`text`、`source`、`strategy`、`from`、`to`、`rounds`、`bytes`，以及有值时才带的 `truncated` / `degradeReason`。**additive（issue #479）：** 载荷还带宿主写「折走第 a–b 轮」所需的三个数，全部由引擎算好、宿主不必二次推导——`foldedRoundRange {from, to}`（本次折叠的区间，与轮记录同形）、`foldedThrough`（**折叠之后**的 run 作用域水位线）、`foldedRoundCount`（run 内累计折过的轮数）。两者都是 run 作用域，且 **resume 的 run 从持久化值（`deterministic.fold` / 轮记录）续起、不归零**——所以「run 内累计」不等于「本进程启动以来」。三者都不替换既有键；忽略它们的老宿主看到的形状逐字不变）。四条边界属于契约：**无 `text` ⇒ 不调用**（既不投递，也不造空横幅）；钩子抛错/reject **不走** `reportObserverError`，而是走 `reportHostPersistenceFailure`，即一条 `port: "notes"`、`operation: "onFoldSummary"`、`phase: "fold_summary_delivery"`、`fatal: false` 的 `persistence_error`（账本 + `diagnostics.error` + `onPersistenceError`）；这类失败**绝不改写 run 的终局**，也拖不死循环；不传这个钩子时行为逐字不变。装配期就校形状：非函数值抛 `TypeError: onFoldSummary must be a function`，配套的字节上界旋钮 `context.maxFoldedFactsBytes` 不是安全正整数就抛 `maxFoldedFactsBytes must be a positive integer`（默认值不变 = `FOLDED_FACTS_MAX_BYTES` 2048，于是宿主的「输入上限 / 输出预算 / 容器上限」可以同一个来源）。

> **钩子配在哪、三个区间键的作用域是什么、以及 `context.onFoldSummary` 为什么退役（issue #499）。** `onFoldSummary` 配在装配端口策略项（`policy.onFoldSummary`）或直接入口的顶层选项（`runToolLoop({ onFoldSummary })`）——它**不从 `context` 读**。`context.onFoldSummary` 自 issue #499 起**已退役**：这个键从 `context` 的合法键集合（`CONTEXT_OPTION_NAMES`（`src/assembly-validators.js`））里移除，所以现在与其它宿主元数据键**逐格同形**——装配口路线通过一条 `context_unknown_option` 事件报出，直连路线静默放行，**两条路线都不抛**。选「退役」而不是「抛」是刻意的：`context` 里的键是宿主元数据的形状，不是拼错的摘要旋钮名，抛就是破坏（#493 的口径）。本文档早前的修订版把这个键写成「会被忽略」——那正是本次退役要消掉的那种静默配置：引擎从来没读过它，而白名单里那一条只买到「绿灯 + **零**事件」。同一份载荷还带折叠范围三键（issue #479）：`foldedRoundRange {from,to}` 是**本次**折叠的轮次区间，`foldedThrough` 是**本次折叠之后**的水位线，`foldedRoundCount` 是**run 作用域**的累计已折轮数——刻意不是会话/账本总账：resume 之后它只数这个 run 折过的部分，宿主若需要会话级数字，得自己把此前各 run 收到的计数相加。
>
> **四个上限都是 `context` 旋钮（issue #469，宿主审计 B1）：** `context.summarizerTimeoutMs`（provider 层**单发**超时，默认 `30000`）、`context.summarizerBudgetMs`（策略层**整条步骤死线**，首发与超窗自愈重试共用，默认 `30000`）、`context.maxSummarizerInputBytes`（被折窗口的字节上限，默认 `49152`）、`context.maxPriorSummaryBytes`（续写基底的字节上限，默认 `24576`）。两个超时名**刻意不合并**：单发上限与整步骤死线回答的是两个问题。省略即逐字等于今天的值；显式传入的 `summarizerTimeoutMs` 语义是**上限**（与调用方剩余预算取小），否则它会被步骤死线静默盖掉。两条入口路线现在共用同一道闸口、都在启动期校（issue #496）：非安全正整数抛 `TypeError: <key> must be a positive integer`，**未知** `context` 子键抛 `unknown assembly policy context option: "…"` 而不是被静默丢弃（`#331` 的形状）。四个键只对**内置名字形态**生效（`context.strategy: "fold-llm"`）；对象形态自带策略时上限归宿主自己。 **`context.maxSummaryTokens` 是第五个旋钮（issue #493，下游 fde-station）：** 它定摘要的输出预算（默认 `1400`），并且**同时给那一发的 `maxTokens` 封顶**——摘要调用以前原样继承 run 的 `maxTokens`（实测 32768），模型按 32k 写满、结果再被 1400 剪回，纯白烧。现在两者按 `min(run 的 maxTokens, maxSummaryTokens)` 对齐。**未知 `context` 子键按家族校验，不搞一刀切：** 拼错的摘要旋钮名（`maxPriorSummaryByte`、`summarizeBudgetMs`，判据是**与已知旋钮名的编辑距离 ≤ 2**，不是「含 `summar` 就算」，所以 `summaryStyle` / `summarizerNote` 这类业务键照旧合法）两条路线都抛，其余未知键**当宿主元数据放行**（`src/loop/budget.js` 自己就从 `context` 读 `toolContext` / `expert` / `user` / `session` / `requestId`，文档开头也让宿主把私有元数据放这里）——放行的键在**装配口路线**上通过一条 `context_unknown_option` 事件如实报出（直连路线从不发这条事件，静默放行），不阻断装配。**两条运维注记：** 复用指纹现在包含续写基底，所以**既有账本升级后首次必然 miss 一次**，那次 resume 首折叠会重算一份摘要；以及当**单独一轮就超过** 48 KB 输入上限时，没有整轮可丢（`droppedRounds` 仍为 0）——那一格由 token 守卫逐条裁消息，并在省略注里留痕。
>
> **续写基底按账本作用域播（issue #469，宿主裁决 A）：** resume 出来的 run 第一次折叠从**账本**播种，取源与读侧裁剪同一条规则（先 `pickCoveringFoldSummary`，再 `record.foldedFacts`；嵌套 `foldedRoundRange.{from,to}` 与平铺 `{from,to}` 两种形状都收）。优先级是契约：**显式调用参数 > 策略构造参数 > in-run 闭包 > 账本播种**——非 resume、或挑不出覆盖水位线的事实时，行为逐字退回今天。`compactionStats[].foldSummary` 增 `priorSummaryOrigin: "ledger" | "in-run"`（没有基底就不写键，与家族其余键同口径）。复用指纹**包含基底**：resume 后第一次折叠会重算一次而不是无声忽略播进来的基底（有意的取舍：宁可少命中一格，也不无声丢脉络）。
>
> **五节摘要在默认配置下自洽（issue #469，宿主审计 C 片）：** `maxSummaryTokens` 默认改为 `1400`——五节、每节约 150 个中文字实际要 ~1,335 token（实测）；旧默认 `800` 只容得下每节 ~80 字，于是**合规的模型输出会被无声剪成五节里的两节**。预算真的紧时，裁剪**从最低档开始且保留标题**（`## 标题` + `[已修剪]` 正文）——骨架消失比正文丢失更难诊断，下一次折叠的摘要器连「曾经有这一节」都看不到。优先级现在是：`## 下一步` / `## 恢复提示` 与 `## 主题词面包屑` 同列第一档，然后 `## 已验证项`，再 `## 已改文件`。**`foldSummary.finishReason` 的值域：** 按 provider 归一后原样透出（`end_turn`、`max_tokens`、`stop_sequence` …）；`max_tokens` 表示摘要本身被模型输出预算截断、**不是完整摘要**。宿主遇到未知值必须按「未知」处理，不得当「正常」。
>
> **摘要调用本身（issue #469 ①②③，erix-station 2026-10-26 裁决）。** 三条边界属于契约、不是可调默认值。**①思考显式关：** 请求同时带 `reasoning_effort: "none"`、`enable_thinking: false`、`chat_template_kwargs: {"thinking": false}`——绝不靠模型默认值（真机只带前者仍产出 584 个 `reasoning_token`）；不接受未知字段的上游可用 `thinkingMode: "inherit"` 退回旧形状。**②30 s 是整条摘要步骤的死线、不是每次尝试的：** 剩余预算按 `timeoutMs` 下发给每一次尝试，所以超窗自愈重试与首发共享同一条 30 s；剩余不足 2 s 就不再重试并记 `budgetExhausted`。**超时永不重试。** **③输入范围固定：** 只喂**被折走的轮次** + **上一份折叠摘要**（续写基底，单独计 24 KB，超了从头部截并标记 `priorSummaryTruncated`）；未折走的活上下文一概不喂（那是重复付费，而且会诱导摘要去复述模型仍看得见的东西）。被折窗口本身以**字节** 48 KB 为上限，按**整轮**从旧到新截，绝不截断单轮中部；另有一层由 `budgetTokens` 同源推出的 **token 护栏**作为模型窗口的最后一道防线，它**可能**丢单条最旧消息，所以「48 KB 那顶帽子」不能读成「轮永远不会被切开」。两层都留省略注。
| `foldedPayloadMeta` | 展示 / 取证 | `{ messages, bytes, capBytes, droppedMessages, droppedBytes, dedupedMessages, dedupedBytes }`——这份归档实际携带了本次折叠的多少，外加 `rejectedByHost: true`（宿主对单条记录定界、引擎剥掉归档重试后拿下的那条）。咨询性字段；可渲染为“归档已夹断”的标注。 |
| `navigationRecord` | 展示 | 有界归档指针 `{ roundFrom, roundTo, artifacts[], truncated? }`，指向被恢复的工具输出。渲染为导航链接/指针，绝不作为消息内容。 |
| `messages` | 模型 | 精确的模型上下文切片，含 `tool_use`/`tool_result` 块与折叠占位符。不要裸渲染；投影从中提取可展示文本与工具调用摘要。issue #335 起，投影里 assistant 条目的**正文正本也以这里为准**（消息一成型就落盘）；`response.content` 只是老账本与宿主手写行的回退。 |
| `messages[].meta` | 模型 / 引擎 | 保留该对象及未知键。`meta.source` 是引擎保留标记，投影分类与 judge 可见性依赖它；不得复用它承载宿主自己的来源信息。 |
| `response` | 模型 | 完整的 provider 响应内容（`text`、`reasoning`、`tool_use` 块）、`stopReason`、`usage`。投影展示的正文与块取自 `messages`，不再取自这里；只有 `stopReason`/`usage` 会被抄进投影的 `meta`。其块形状是模型面向的，可能变化。**它的 `usage` 只含本轮最后一发响应**——本轮的完整逐轮账是同级键 `record.usage`（见「用量分账：逐轮账 vs 引擎开销（issue #438）」）。 |
| `l0facts`、`runState`、`compactionStats`、`judge`、`wrapup`、`toolOutputs`、`dedupKey`、`roundKey` | 模型 / 引擎内部 | 给 governor、resume、诊断用的事实。只有 `judge`/`wrapup`/`summary`/`stopReason`/`usage`/`toolUses`/`dedupKey` 被拷进投影的 `meta` 供可选标注；其余不属于展示表面。 |

### 稳定性承诺

**投影输出形状就是宿主可长期依赖的契约表面**：`key`、`role`、`text`、`blocks`、
`toolCalls`（包括每个工具调用的 `key`）、`reasoning`、`folded`、`round`、`ts`、`meta`。
`RoundRecord` 内部细节不是。只要投影继续
产出相同形状，`messages`/`response`/`foldedPayload`/`runState` 内部的字段名、嵌套与块形
状可在次版本间变化。投影条目与 `meta` 的增量追加是非破坏性的；宿主必须忽略未知的
`meta` 键，不得对键顺序做断言。投影形状的破坏性变更遵循常规版本化迁移策略，并在升级
指南中公告。

`blocks` 是透传的块数组，供需要更丰富渲染（代码块、图片、结构化工具输入）的宿主使用。
只展示纯文本的宿主应改用 `text` 与 `reasoning`。

### 折叠轮次

折叠轮次始终以**摘要加区间**渲染，绝不渲染原始负载：

- 投影会在该轮自身内容之前发出一条 `role: "system"`、`folded: true` 的轮次。当记录携带
  带标记的折叠摘要时其 `text` 就是该摘要（恢复后的种子记录把摘要块留在头部任务消息里，
  投影会把它从用户气泡里拆出）；否则是 `foldedRoundRange`、`summary` 与
  `navigationRecord` 产物计数的有界组合。
- `meta.foldedRoundRange`、`meta.navigationRecord`、`meta.foldedPayloadMessages` 为宿主
  的折叠段 UI 提供信息（“此段已折叠，摘要如下”，外加归档链接）。
- 宿主不得在聊天流中渲染 `foldedPayload` 内容。它是被折叠掉的原始材料，为恢复与锚点
  保留；展示它会破坏折叠，把模型已看不到的负载重新塞回来。
- **归档是咨询性的、且有界（issue #460）。** 宿主有权对**单条记录**定界（本站 1 MB）。
  宿主对超限记录回 `400` **不得**被换算成令 run 终局的 `persistence_failed`：引擎会剥掉
  `foldedPayload`、重试一次 `appendRound`，并记一条非致命（`fatal: false`）的持久化事实；
  降级那条记录带 `foldedPayloadMeta.rejectedByHost: true`。只有剥完仍失败才终局。宿主
  不得把「归档缺失或被夹断」当成数据丢失：正文早已在各自那一行轮记录里，而
  `foldedRoundRange` 与 `navigationRecord` 仍是那份有界指针。

### 推理文本

`reasoning` 携带该轮的推理文本（规范 `reasoning` 块，外加 provider 归一化的
`thinking`/`reasoning_content` 形状），**从不**合并进 `text`。建议默认用折叠/可展开块
展示，因为它长且噪，并与答案保持视觉区分。宿主在向模型回放历史时，不得在自己的存储
中静默丢弃推理——推理回放是模型侧契约（见 thinking 模式要求），与本展示字段无关。自
issue #407 起，流式一侧也会把 `delta.reasoning`（字符串或 `{ content: "…" }` 两种形状）与
`delta.reasoning_text` 折进同一个规范 `reasoning` 块，于是中继用哪个名字不再决定这个字段里有没有
东西：名字跟着**请求体**走，而不是跟着模型走（`streamReasoningText`（`src/providers/openai.js`））。
还有一处不对称没关掉——`reasoning_text` 在非流式路径上仍不被识别。

### 合成消息

运行时注入的消息对模型可见但非用户撰写。投影保留其底层 role（通常是 `user`，有时是
`system`）并加标签：

- 每个非用户撰写轮次都带 `meta.synthetic: true`；真实用户与 assistant 轮带
  `meta.synthetic: false`。
- transcript 带标记时 `meta.source` 标明注入方：`judge-control`（引擎自写的控制文本：
  round-judge 方向提示与续跑催促、extend / extend+redirect 续跑文本、`finalGuard` 的
  `revise` 消息、强制收尾指令，以及 blocked 拦截路径写进快照的方向提示——issue #323）、
  `audit-intercept`（重复命令拦截文本）、`system`、`fold-summary`（折叠横幅）、
  `wrapup`，或 `textPreview`（assistant 轮的旧版预览兜底）。
- `judge-control` 消息仍留在模型可见的会话里（主模型必须仍能看到它们）；它们只被排除在
  judge 自己的输入之外，排除点是评审模块里的会话渲染 `renderConversation`（与上文
  `judge-control` 排除说明同一模块）。宿主不得以该排除为由把它们从 transcript 或上下文里
  删掉。
- `message.meta.source` 是引擎保留字段：投影把**任何非空字符串**值判为 synthetic。宿主不得
  在其中存放普通来源信息，否则真实消息也会被误分类。
- 只有投影通过匹配已配置的文本前缀来判断合成消息时，才会添加
  `meta.sourceInferred: true`。它是增量 `meta` 字段（宿主须忽略未知 `meta` 键），UI 可选展示
  “此条分类来自启发式”；它不是有损 store 检测标记。由 `message.meta.source` 提供分类时，
  以及仅因 `role: "system"` 而判为合成时，均不会添加该字段。
- 轮级判定在存在时出现在 `meta.judge` 与 `meta.wrapup`，宿主无需解析散文就能标注一轮。

宿主应区分地渲染合成轮（徽标、淡化样式）或折叠它们，但不得从声称镜像 transcript 的视图
中丢弃它们。

### 反模式

不要把第二张有损消息表当作模型上下文的真相源。只存 `{ role, text }` 的 UI 表无法往返
工具调用、推理与折叠状态；它一旦出现，宿主就被迫向模型重新注入历史，而 thinking 模式
provider 会拒收纯文本的 assistant 历史。受支持的模式是单 store：transcript 保持模型
上下文，每个 UI 视图都通过 `projectTranscriptForDisplay` 从它派生（与 #91、#135 同一
主题）。宿主特有锚点（session id、序号、附件、run 归属）可以存在 transcript 旁边，但
消息内容不得在那里重复一份。

## 运行状态

引擎构建确定性的运行状态，并能在上下文折叠时注入其有界渲染。它会替换既有的单个 run-state
块而不是追加重复块，并在提供的 `TranscriptStore` 支持时用 `saveRunState` 持久化当前状态。
确定性部分只包含引擎已知事实：预算、工具调用次数与失败次数、已写文件路径、注入的 todo
状态、折叠/导航计数、终止原因，以及工具/checkpoint/未存上（`unpersisted`）计数。
当前终止原因使用与 loop 相同的取值，包括 `end_turn`、`no_tool`、`stall`、
`max_rounds_cap`、`judge_done`、`continuation_exhausted`、
`final_guard_unverified`、`aborted`、`failed`。

`todoStateProvider` 是可选的宿主 todo 状态回调。`semanticStateProvider` 是可选的宿主回调，
提供有界语义文本与版本。版本不匹配会把语义部分标为 `stale`；语义数据是增量，不能覆盖
确定性事实。引擎不调用模型来获取语义状态。
**semantic 段什么时候刷新（issue #479，属契约）：** `refreshRunState` 的调用口径是
`{ semantic: persistInject || requestInject, inject: persistInject }`，即 `semanticStateProvider` **只在**
引擎即将把 run-state 注入下一份请求时（低预算注入或请求式注入）才被调用。因此「发生了折叠、但当轮没有触发
注入」是**预期**形态：注照样落账、进会话目录，但不会在**同一轮**重新进入模型可见上文，要等下一次普通注入。
宿主可以把这个边界写进自己的文档——它是行为，不是意外。

持久化对象受 `RUN_STATE_MAX_SERIALIZED_BYTES`（`64 * 1024`）约束。渲染的提示块受
`RUN_STATE_MAX_CHARS`（`1600`）约束。run-state 辅助函数还把工具条目限制为 128、文件条目
128、todo 条目 64、普通受限的 name/path/id/status 字段 120 字符、语义源文本 1200 字符
（多行：保留换行，每条目录条目单独成行，最多 16 行，行数被裁剪时显式报告
`... (semantic lines truncated: N more)`）。条目或序列化状态被裁剪时，`bounds.truncated`
与相应的省略计数是显式的；渲染块在触到 1600 字符上限时使用 `[run state truncated]`。
语义文本自身的字符级裁剪由持久化的 `semantic.truncated` 标志表达，不内联渲染。
闭合标记 `[/run state]` 在渲染之后恒被追加，因此截断时依然存活——旧块会被原地替换，
而不会在上下文中累积出第二份。

`deterministic.compactionStats` 是一份**窗口**而不是全量历史：只留最后 32 条，以便 state
文件体积有界。自 issue #315 起文件自己会说这件事——`deterministic.compactionStatsWindow`
（`{ limit, dropped, total }`）记录窗口大小、被丢弃的条数与本次 run 实际产出的条数，
宿主不必读引擎源码就能知道手里这份是全量还是尾巴。`total > limit`（等价于 `dropped > 0`）
即说明这份是尾巴；run 返回值上的 `compactionStats` 仍是全量。字段只在本次 run 至少产出
一条统计（`total > 0`）时出现；一条都没有时没有可截断的东西，缺席不是歧义。
`bounds.truncated` 覆盖的是体积驱动的裁剪（工具/文件/todo 条目与序列化超限），不含这个
定长窗口，请读窗口字段。旧版本落盘的 state 没有 `compactionStatsWindow`，仍照旧可读。

未知 schema 或不完整的持久化状态不会被静默当作有效默认值。恢复时它表现为
`runState.stateAvailability.status = "state_unavailable"`（例如 `unknown_schema` 或
`missing_fields`）。损坏的 file-store JSON 状态同样报告为不可用，而不是被恢复。完全不存
在的持久化状态是正常的，不等同于“存在但无效”。
`stateAvailability` 是本次 resume 的诊断观测结果，会随 state 保留用于诊断，但不会仅因该标记
而拒绝下一次 resume 时结构仍然有效的 state。

## erix_run 终局面：分层削减与 notes 计数（issue #313）

引擎早就是逐轮报分层压缩的：每条 `compactionStats` 条目都带一个 `layers` 映射，键是
`COMPACTION_LAYER_IDS`（`src/compact/pipeline.js`）从 `COMPACTION_PIPELINE` 派生出来的真实层 id，
由循环里各观测点调 `observeCompactionLayer`（`src/compact/pipeline.js`）写入，再由
`createCompactionStat`（`src/compact/pipeline.js`）归一。而 `erix_run` 这层宿主扩展过去会把整张表
摺成三个数就丢弃，于是某条 `ttl` 层折叠 69 次、省下 650,581 tok 的 run 仍然只打出一个
`compaction=0/1`，被读成「压缩没生效」。现在 `buildDiagnostics`
（`examples/pi-extension/erix-run-core.js`）把分层与 notes 计数都留在终局面上。**只做增量**：
`compacted` 与 `foldedRounds` 的含义与取值一律不动，`diagnostics.compaction.events` /
`.compactedRounds` / `.foldedRounds` 与本小节存在之前逐字相同。

| 终局面字段 | 真来源 | 含义 |
| --- | --- | --- |
| `diagnostics.compaction.events` / `.compactedRounds` / `.foldedRounds` | `compactionStats` 数组 | 自 #313 之前未变。文本里的 `compaction=<compactedRounds>/<events>` **不是**「压缩没生效」 |
| `diagnostics.compaction.layers.roundsObserved` | 带 `layers` 字段的条目数 | 真正被评过分层轮数；为 `0` 时文本渲染 `unknown`，而不是报成「什也没省」 |
| `diagnostics.compaction.layers.tokensBeforePeak` | 这些条目里 `tokensBefore` 的最大值 | 本次 run 达到过的最大压缩前上下文 |
| `diagnostics.compaction.layers.byLayerId.<id>` | `summarizeCompactionLayers`（`examples/pi-extension/erix-run-core.js`）逐条累加 `layers.<id>` | **引擎声明的每个层 id** 的 `{triggered, tokensSaved}`；本层不自创、不改名 |
| `diagnostics.compaction.layers.roles[]` | `COMPACTION_LAYER_ROLES`（`examples/pi-extension/erix-run-core.js`） | 文本里分开命名的四个归组：`wholeRoundFold`（`slidingWindow`+`foldStatistical`+`foldLlm`）、`ttlResultFold`（`ttl`）、`outputClamp`（`enforceSize`）、`foldFidelity`（`anchors`） |
| `diagnostics.compaction.layers.unattributed[]` | 数据里出现、但没有任何归组点名的层 id | 前向兼容兼Rail：引擎以后新增的层一会被渲染出来，不会被归组表吞掉 |
| `diagnostics.notes.writes` / `.reads` / `.byName` / `.unclassified` | `countNoteToolEvent`（`examples/pi-extension/erix-run-core.js`）数 `onEvent` 收到的 `tool_use` 事件 | 写 = `note_take` / `note_forget`（两者都动 store），读 = `note_read` / `note_list`；认不出的 `note_*` 名字只进 `byName` / `unclassified`，绝不并进这两个数 |
| `diagnostics.notes.source` | `NOTE_COUNT_SOURCE`（`examples/pi-extension/erix-run-core.js`） | 恒为 `onEvent:tool_use`：计数是事件流的读数，不是从别的字段推出来的 |
| `diagnostics.modelMetadataMissingEvents.count` | `onEvent` 收到的 `model_metadata_missing` 事件 | 事件数。既有的 `modelMetadataMissing` 标志含义与取值不变 |
| `diagnostics.notes.observed` / `diagnostics.modelMetadataMissingEvents.observed` | 是否真的进入了内层循环 | `false` ⇒ 文本渲染 `unknown`：装配期就失败的 run 一个事件也没产生，「没事件」不等于「没调用」 |

| `diagnostics.compaction.layers.source` / `.truncationNote` / `.compactionStatsWindow` | `COMPACTION_STATS_SOURCE` / `COMPACTION_STATS_TRUNCATION_NOTE`（`examples/pi-extension/erix-run-core.js`）；窗口账从 `<runId>.state.json` 读（`readRunStateFile`） | 汇总读的是**哪一份** `compactionStats`：run 返回值（或抛错载荷）上那份**全量**。而 `<runId>.state.json` 里那份要经 `normalizeCompactionStats(value, limit)`（`src/compact/pipeline.js`）截尾（调用点 `createDeterministicRunState`（`src/run-state.js`）），即 `value.slice(-limit)` 只留最后 `limit` 条 —— 长 run 去那个文件数削减账会静默少算。自 issue #315 起文件把那个窗口自报为 `deterministic.compactionStatsWindow`（`{ limit, dropped, total }`）；自 issue #373 起 `truncationNote` **念的就是这几个数字**（`layers.compactionStatsWindow` 同时给出结构化形状），文件里没有这个字段（老档）时明说「条数不可当压缩次数用」 |

`formatCompactionLayerSummary`（`examples/pi-extension/erix-run-core.js`）把四个归组逐行渲染，
上面那个事故 run 现在读起来是：

```text
[diagnostics] model=… compaction=0/2（=compactedRounds/events，不等于「压缩没生效」） … model_metadata_missing=YES events=1
  ↳ 整轮折叠（slidingWindow+foldStatistical+foldLlm）=0 次/0 tok
  ↳ 逐条TTL削减（ttl）=69 次/650581 tok
  ↳ 输出钳制（enforceSize）=0 次/0 tok
  ↳ 折叠锚点（anchors）=0 次/0 tok
  ↳ 分层观测=2 条评估条目，tokensBefore 峰值 130000
  ↳ 来源 runResult.compactionStats（全量）；若改读 state.json：该文件自报 deterministic.compactionStatsWindow：limit=32、dropped=0、total=2——没有丢条目，这份窗口就是全量
  ↳ notes 写=2/读=2 ｜ note_take=2 note_read=1 note_list=1 ｜ 来源 onEvent:tool_use
```

宿主读取约束：

- 分层收益只从 `layers.byLayerId` / `layers.roles` 读，**不要**拿 `compacted` /
  `compactedRounds` 当结论：`foldedRounds = 0` 的 run 完全可能把全部收益都放在 `ttl` 上。
- `unknown` 是「没测到」而不是 `0`：计数源不存在时本层就渲染 `unknown`，绝不拿相邻字段推一个数。
- 不要拿不在 `COMPACTION_LAYER_IDS`（`src/compact/pipeline.js`）里的层名做匹配：上面四个归组
  点名的都是引擎的真 id，新增的层会出现在 `layers.unattributed` 里。
- 终局面会自报数据源（`layers.source`）：请从 run 返回值上读这份账；如果宿主改为重读
  `<runId>.state.json`，它拿到的是一个**最后 32 条**的窗口，不能当成全 run 的削减总量报出去。
  自 issue #315 起那个文件会把窗口自报为 `deterministic.compactionStatsWindow`
  （`{ limit, dropped, total }`，见「运行状态」一节）。

## 契约测试套件（issue #183）

`erix-agent/contract-tests`（即 `./contract-tests` 子路径导出，`test/contract/index.js`）
随包发布十个套件文件、共**十二个**可复用的 `node:test` 注册函数（`execute-tool.js` 里有两个：
现行形状与迁移形状；`notes-store.js` 自 issue #183 起也有两个：通用套件与可选的 CAS
子套件）。每一个的签名都是 `xxxContract(label, factory)`：调用它即注册一批以
`label` 命名的断言，在 `node --test` 跑起来之前什么都不会执行。`npm run check:docs:strict`
会对「被 `test/contract/index.js` 再导出、但 `files` 白名单漏掉」的套件直接失败（在普通的
`npm run check:docs` 下它是 warn），因此随包集合不可能无声变小。十二个里最新的是
`toolResultEnvelopeContract`（issue #284 / #285），其次是 `skillsLoaderContract`（issue #197），
再是 `fileToolsContract`（issue #184）：装在已发布的 0.18.0 上的宿主只有九个套件文件、
十一个注册函数，不是十个文件、十二个函数。

**两个数各自数的是什么（实测）**：套件文件 = `test/contract/` 下除 `test/contract/index.js`
之外的 `.js` 文件，共十个（`test/contract/transcript-store.js`、
`test/contract/model-config-provider.js`、`test/contract/execute-tool.js`、
`test/contract/assembly-port.js`、`test/contract/notes-store.js`、
`test/contract/engine-api.js`、`test/contract/termination-payload.js`、
`test/contract/file-tools.js`、`test/contract/skills-loader.js`、
`test/contract/tool-result-envelope.js`）；注册函数 = `test/contract/index.js` 再导出的导出名，
共十二个（`import("erix-agent/contract-tests")` 实测 `Object.keys(...)` 长度 = 12）。两个数都
不含 `test/contract/index.js` 本身，也不含同目录里不进包的 `*.test.js`。

**随包的是那些文件本身、一条一条列出来的**：`package.json` 的 `files` 逐条枚举
`test/contract/*.js`，**不收目录**——所以同一目录下的 `node --test` 套件被刻意留在包外
（`test/contract/boundary-parity.test.js` 就 import 了 `test/helpers/`，永远进不了 tarball）。
实测：`npm pack --dry-run --json` 里 `.test.js` 文件数 = **0**，而上面那些套件文件全部按名字逐个在列。

### 套件能证明什么、不能证明什么（issue #183）

**一个套件断言的是「你安装的那个版本上，上游实现的行为」。** 它的价值是**引擎升级的漂移
哨兵**：当你 bump `erix-agent` 版本时，对着你自己的适配器重跑这些套件，一条变红的断言就
指名了哪个契约动了。它**不是**宿主一致性测试，也替代不了宿主自己的一致性测试：

- 一个套件只钉住上游**真正写过**的那些断言。你的实现游走在上游表面*之外*的语义 —— 无论是
  新增、省略还是重新解释 —— 对它都是不可见的：上游从不触碰的东西，没有任何东西在断言它。
- touwaka 的实证：把它的 transcript store 故意改成上游并不具备的一种语义，随包的套件**照样
  全绿**。套件没有对这个改动提出异议，是因为改动就在它的视野之外。
- 同一个不对称也反向成立：套件全绿，对你的 schema、你的迁移、你的连接管理、你的清理机制
  一无所知。那些属于适配器测试，归你负责（这条规则写在各套件的头部注释里）。
- 所以把它们接成**哨兵，而不是你自己语义的门禁**：每次引擎版本 bump 都跑一遍，把一条变红的
  断言当作一行 changelog 来读；为你自己发明出来的行为另留一套宿主所有的套件。为了让升级变绿
  而弱化一条随包的断言，等于丢掉这个套件携带的唯一信号（0.16.0 升级指南对「保真 + 保序」这一
  对断言说的是同一件事）。
- **放宽也是一个信号。** 一次版本 bump 把原来红的套件变绿，意味着上游放宽了一个承诺
  ——这同样要当 changelog 读，因为它往往就是自家适配器在等的那张许可证。issue #183 就是
  这个形状：`revoke` 现在承诺的是「可观察消失」（墓碑**或**物理删除皆可），last-write-wins
  并发断言从通用 notes 套件移到了文件适配器自己的测试里，比较-交换宿主新增了可选的
  `notesStoreCasContract`。这几条不会让原本就能过的适配器变红，也不会反过来给宿主作保：
  上游不再断言被放宽的那部分，所以那份保证（如果你需要）现在归你自己写测试。
- **收紧是它的镜像（issue #265）。** notes 套件新增 4 条断言，钉的全是端口 typedef
  早已写明、套件却从未碰过的行为：空 `filters.state` 数组与非法 `filters.source` 必须
  抛 `TypeError`；可见的 revoke 墓碑必须带 `revoked_at` 与 `revoke_reason`；`purge` 的
  `scanned` 是 scope 数而非记录数，且 `before` 只能缩小删除窗口。它们的起因就是引擎
  自己的手抄内存适配器被这套套件量红——所以曾静默忽略这些行为的宿主适配器，下次
  升级时会看到**新失败**：那是哨兵在报漂移，不是套件层面凭空新增的承诺——这 4 条
  在 typedef 里早就写着。

**套件里对记录做 `deepEqual` 的地方，那条断言是 JSON 值相等（issue #183 第 6 组）。**
它可测，也有边界，两半都是承诺的一部分：

- **JSON 值的每一个字段都必须回来**，不是白名单子集：上游不认识的字段（`extension`、
  未来的元数据键）也必须原样往返；
- **数组序是值的一部分**：`superseded`、`tags` 与 `current.content` 块必须逐元素同序回来；
- **对象键序不承重**——只有键序不同的两条记录是相等的，宿主可以重序列化；
- **JSON 不可表示的值不在承诺内**：`undefined` 成员、编码器会丢掉的值、`Date`/`BigInt`/`RegExp`
  实例、函数、`NaN`/`Infinity`，以及共享/循环引用。一个值经 JSON 抵达 store，就按 JSON 形态比；
  宿主自留这类值时必须在端口出口投影成 JSON 形态——这正是裁决对宿主自有元数据列（
  `record_version`、`expires_at`）的要求：列留在 schema 里，从公共记录形状里去掉，
  使「进去的形状」就是「出来的形状」。

### 标准用法（issue #183）

把你的实现作为 factory 参数注入；`label` 是生成的每条测试标题的前缀，所以每个适配器用一个
稳定的名字。这些套件只做注册，因此对你自己的测试树跑一次普通的 `node --test` 就会执行它们。
factory 必须**每次调用都交出一个干净的**实现 —— 每个断言组都把它当作一个全新命名空间，且
多个套件会反复进入它：

```js
import { notesStoreCasContract, notesStoreContract, transcriptStoreContract } from "erix-agent/contract-tests";
import { createFileNotesStore, createMemoryNotesStore, createMemoryTranscriptStore } from "erix-agent";

transcriptStoreContract("my-host-store", () => createMemoryTranscriptStore());
// 「每次调用都交出干净的实现」：factory 每调用一次给一个全新命名空间——这里用
// notes 根目录下的全新子目录
notesStoreContract("my-host-store", () => createFileNotesStore({ dir: mkdtempSync(notesDir + "/general-") }));
// 引擎自 issue #265 起自带内存版 NotesStore 适配器：同一个套件、第二个 label 再注册
// 一遍——宿主自家适配器受的就是这把尺
notesStoreContract("my-memory-adapter", () => createMemoryNotesStore());
// 比较-交换型 store 额外注册这个可选子套件：它只要求并发写至多一方失败、胜者可读
notesStoreCasContract("my-host-store", () => createFileNotesStore({ dir: mkdtempSync(notesDir + "/cas-") }));
```

issue #265 之后引擎自己就带两个 NotesStore 适配器——文件版（`createFileNotesStore`）
与内存版（`createMemoryNotesStore`）——两者在仓内都是对着这同一套套件、以不同 label
table-driven 各跑一遍。它们共用**同一份**端口语义实现（`src/store/notes-port.js`，
内部模块、不发公共面）：宿主写第三份适配器，受的是同一把尺，漏了哪条就冒同样的红。

其余六个是同一个形状，只有第二个参数不同：

| 套件 | 第二个参数 | factory 必须交回什么 |
|---|---|---|
| `transcriptStoreContract(label, createStore)` | factory | 一个干净的 `TranscriptStore`（必需层 `appendRound`/`load`；run snapshot、run-state 与 issue #157 探针这些方法在存在时会被检验） |
| `notesStoreContract(label, createStore)` | factory | 一个干净的 `NotesStore`（write/read/list/complete/revoke/purge） |
| `notesStoreCasContract(label, createStore)` | factory | 同一个 `NotesStore`，由比较-交换型宿主**额外**注册（issue #183）：并发那条断言容忍一方被拒，不再要求两写都落盘 |
| `modelConfigProviderContract(label, setup)` | async setup | `{ provider, slot, expect: { defaultModel, slotModel, materializedKey } }`；provider 需要一个 `default` 槽加上 `slot`，且 `slot` 的 key 要能经间接引用被物化 |
| `executeToolContract(label, createExecutor)` | factory | 你的 `executeTool` 函数（或 `{ executeTool }`） |
| `executeToolMigrationContract(label, createExecutor)` | factory | 同一个执行器，针对已退役的位置参数调用形状做断言 |
| `assemblyPortContract(label, createPort)` | factory | 你的 `AssemblyPort` 对象；套件会在它之上启动一个真实的 `runToolLoop` |
| `engineApiContract(label, getEntry)` | factory | **包入口命名空间**，即 `() => import("erix-agent")` —— 它断言的是导出的引擎 API，不是你的代码 |
| `terminationPayloadContract(label, getEntry)` | factory | 同一个入口命名空间（`{ runToolLoop }`）；它自带 provider 桩 |
| `skillsLoaderContract(label, { discoverSkills, loadSkill, buildSkillTools })` | 三个函数，不是 factory | 宿主接进来的技能包 loader；它断言 `bundledDir` 归调用方、内置 → 全局 → 项目的优先级、不阻塞的 `{skillId, dir, error}` 失败形状，以及 `ToolSchema` 产出形态 |

### 套件清单（issue #183）

「harness」指该套件跑在什么上面：你的 factory（宿主侧），还是打包的引擎（上游侧，即纯漂移
哨兵）。

| 套件 | 断言什么 | 你必须满足的部分 | 它顺带钉住的上游内部细节 |
|---|---|---|---|
| `transcript-store.js`（22 条） | 记录往返保真（块结构、元数据、未知字段、`meta.source`）、同轮追加顺序、未知键 → `[]`、多 run 隔离、run snapshot 的 latest-only 覆盖写、不带 `state` 的 run-state 快照、写失败向上抛、`round: 0` 种子、折叠载荷往返、成对的探针层，以及同 key 的幂等/冲突层（issue #326：同 payload 重放（含顶层 `ts`/`round` 漂了、字段换了顺序）是 no-op，异 payload 以 `dedup_payload_conflict` 报冲突，数组顺序与宿主自有字段算 payload，`roundKey` 与 `<runId>:round:<n>` 回落键同受约束） | 全部这些：它就是 `TranscriptStore` 契约本身，而随包的保真/保序断言恰恰是「从字段白名单重建」型适配器会挂掉的那几条 | `:input:`/`:engine:round:` 键形状、`(record.dedupKey ?? record.roundKey)` 谓词及其 `??`-而非-`OR` 分叉（issue #171）、探针结果 `null`/`undefined` 的容忍、`dedup_payload_conflict` 错误码 |
| `notes-store.js`（9 条） | 端口校验（`assertNotesStore`）、落盘前拒绝畸形记录、完整记录往返、作用域隔离与显式未命中、不安全作用域经规范存储与生命周期往返、`limit` 阈值（存量超过 200：给了 limit 就钳到恰好 200，非法 limit 抛错）、带 `expectedState`/`expectedUpdatedAt` guard 的 revoke 可观察消失，以及 issue #265 新增：空 `filters.state` 数组与非法 `filters.source` 必须拒、revoke 墓碑上 `revoked_at`/`revoke_reason` 可见、`purge` 的 `scanned` 是 scope 数且 `before` 只能缩小窗口 | 端口面与记录/guard 语义。issue #183 之后上游硬义务与宿主策略的分界已写死：端口只承诺「可观察消失」（墓碑**或**物理删除皆可）且不管记录过期，而一写者 last-write-wins 是文件适配器自己的事，已不在这里断言。#265 新增只断言 typedef 早已承诺的行为，但它们是发布面上的新断言：宿主适配器曾静默忽略其中任何一条，升级后就会冒新红 | 文件存储形状的错误文案（`/valid NoteRecord/`、`/parseable date/`、`/positive safe integer/`、`/filters\.state/`、`/filters\.source/`）、保留期/purge 时机 |
| `notes-store.js` → `notesStoreCasContract`（1 条，可选；issue #183） | 并发同键写：至多一方失败，失败必须是抛错而不是静默丢弃，胜者必须是那条以完整形状可读的记录 | 只给比较-交换宿主跑，且是在 `notesStoreContract` 之外的**额外**一层 —— 这个子套件刻意比被移除的 last-write-wins 断言更弱，跑绿它对串行化写者一无所证 | 它顺便踩到的两个载荷内容（`left`/`right`），而不是任何冲突错误文案 |
| `assembly-port.js`（4 条） | 端口能启动一个真实 loop 并跑完，`emit(type, payload)` 收到带 payload 的事件类型，显式的细粒度 `provider` 选项覆盖端口自带的 provider，缺少 `chat`/`chatStream` 的 provider 在启动时被 `createAssemblyPort` 与 `runToolLoop` 双双拒绝 | 你的端口所必需的适配器与它的 `emit` 接收端 | 优先级规则（显式选项胜过端口）、启动校验的错误文案 |
| `execute-tool.js`（7 条）+ `executeToolMigrationContract`（2 条） | 你的执行器恰好收到一个结构化执行对象，且每种规范返回形态（`string`、`{content, metadata, success}`、遗留的 `{data}`、返回的 `Error`、抛出的 `Error`）都变成文档规定的 `tool_result` | 调用形状与返回形状。迁移套件还额外证明：裸的位置参数 `(name, input)` 执行器是被**拒绝**的，不是被静默支持 | 这些断言是通过 `runToolLoop` 的 provider 请求观测到的，而不是通过某个公开结果字段 |
| `model-config-provider.js`（4 条） | `resolve()` → default 槽，`resolve(slot)` → 具名槽，未知槽 → 回落 default，以及 `apiKey` 间接引用物化（ADR-001） | 你的 provider 的槽位解析与 key 物化 | 没有任何引擎侧内容：它从不加载引擎 |
| `engine-api.js`（2 条） | 包入口把 `appendUserTurn` 与 `projectTranscriptForDisplay` 导出为函数，且 `appendUserTurn` 在一个最小 store stub 上完成一次预写（含 `dedupKey`/`roundKey` 形状，以及这次预写能喂给展示投影） | 无 —— 这是入口面的哨兵；上游某次 bump 重命名或删掉引擎 API 时它会变红 | 预写记录的确切形状（`round: 0`、`dedupKey`、`roundKey`、`ts`） |
| `termination-payload.js`（4 条） | `failed` 终局携带 `termination.errorCode`（分类透传、`unknown` 回落），abort 抛错携带 `usage`/`rounds`/`finalText` 与 `termination.partial`，累计 usage 按轮归属，成功路径保持旧形状（不会凭空冒出 `errorCode`/`partial`/`usage`） | 不直接对应 —— 它是你宿主侧裁决表的回归网（issue #170 / #176 / #180） | 被打桩的 provider 脚本、`usage` 的「零值 vs 缺字段」规则 |

### 宿主接线规则

- 在你的自己的测试树里，用真实适配器，在每次引擎 bump 之后、发布验收之前，跑完所有宿主侧
  套件（transcript store、notes store、model config provider、execute tool、assembly port）。
- 把入口级哨兵（`engineApiContract`、`terminationPayloadContract`）接一次即可；成本是两次
  注册，换来的是接住「上游重命名了我忘记 grep 的东西」这一类事故。
- 宿主自己发明的行为留在宿主所有的测试里。如果某个随包套件与一条宿主需求冲突，提 issue
  反馈，而不是 fork 套件：fork 掉就丢掉了哨兵。
