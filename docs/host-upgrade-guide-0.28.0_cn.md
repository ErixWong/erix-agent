# 宿主升级指南：0.28.0

**版本：0.28.0（2026-10-29）。** 这一版把 `runToolLoop` 的输入面收敛成「一个值只有一个住址」：每个配置项
只有一个规位写法 `config.<组>.<叶>`；每个宿主行为都配在 `capabilities.*` 下；剩下的顶层选项都是引擎必须
**持有**的东西（端口、工厂、回调），而不是它**当数据读**的东西。

**0.27.0 从未发布。** 已发布的版本线是 0.26.0 → 0.28.0，没有任何宿主装上过 0.27.0，因此也不需要从它的
中间形态迁移。如果你钉的是 `0.26.0`，下面每一节都按「从 0.26.0 到 0.28.0」写。

机械部分是改名字。真正需要你注意的是：**过去引擎会忽略的名字，现在会在启动期抛**——一个拼错或过期的选项
从前什么都不 cost，现在 cost 你一次失败的 run。第 11 节告诉你怎么证明自己已经干净。

## 1. 变更总览

| 你要改什么 | 为什么改 | 见 |
|---|---|---|
| 44 个扁平写法迁进 `config.<组>.<叶>` | 一个值一个住址（issue #498 S3） | §3 |
| 宿主行为迁进 `capabilities.hooks.*` / `capabilities.ports.*` | 行为不是数据（issue #530、#545） | §4 |
| 顶层 `session` 只当身份容器；你的载荷搬去 `config.folding.context.session` | 容器把载荷盖掉了（issue #513、#550、#551） | §5 |
| 未知名字现在会抛（装配口成员、`session` 子键、退役扁平名） | 静默才是 bug（issue #556、#513、#498） | §6 |
| `config.run.stream` 必须是布尔；`config.timing.retry.sleepImpl` 没了 | 两套互相矛盾的判定 / 一次没人做的读（issue #538、#520） | §7 |
| 升级后出现的 `.d.ts` 类型错误是新的、而且是对的 | 声明面现在等于被接受的选项集（issue #522） | §8 |

### 本版动到的宿主可见表面

* `src/loop/option-normalization.js` — 顶层被接受名单，以及扁平写法的拒绝。
* `src/loop/config-namespace.js` — 规位叶子模式、值规则、已搬迁键的指路判词。
* `src/assembly.js`、`src/assembly-validators.js` — 装配口：只产规位叶、成员闸、`session` 容器规则。
* `src/loop/budget.js`、`src/loop/provider-runner.js` — 不透明载荷与流式判定的读取点。
* `src/normalization/parse-model-json.js`、`src/config/slot-provider.js` — 模型输出归一化入口，以及槽位 → provider 工厂对。
* `docs/host-consumer-contract.md`（与 `_cn`）—— 权威契约，全篇同步更新。

## 2. 输入面：两个平面 + 一个第三站

* **数据**进 `config`，按配置对象分组。规位模式就是 `CONFIG_NAMESPACE_SCHEMA`
  （`src/loop/config-namespace.js`）：**41 个叶子**、七个组 —— `input`(5)、`run`(16)、`tuning`(4)、
  `timing`(3)、`folding`(3)、`guard`(3)、`metadata`(7)。**扁平别名一条都不再登记**：
  `CONFIG_ALIAS_PATHS` 是空的——这就是「扁平写法不是『也支持的写法』，而是被拒」的机器可读形式。
* **行为**进 `capabilities`：`hooks`（引擎要调的回调）、`ports`（引擎要委托的对象）、`slots`（引擎要选的
  provider）。它住在 `config` 的兄弟容器里，因为它是被**调用**的，不是被读的。
* **第三站**是剩下的顶层选项集 `RUN_TOOL_LOOP_OPTION_NAMES`（`src/loop/option-normalization.js`）：
  **26 个被接受的名字** —— 11 个端口/工厂（`assemblyPort`、`provider`、`tools`、`executeTool`、
  `modelConfig`、`store`、`signal`、`deliverables`、`finalGuard`、`todoStateProvider`、
  `semanticStateProvider`）、12 个观察者/回调成员（`onEvent`、`onRound`、`onToolResult`、`onJudge`、
  `onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage`、`onPersistenceError`、`onObserverError`、
  `onFoldSummary`、`diagnostics`）、身份容器 `session`，以及两个平面容器 `config` 与 `capabilities`。

两条入口——直连的选项对象与 `createAssemblyPort`——接受的是**同一批规位叶子**。装配口不再往选项树里
写退役扁平名（issue #544），所以「装配口替我归一化了」不再是一个扁平写法能用的理由。

## 3. 扁平配置写法没了（issue #498 S3）

把下面任何一个名字写成顶层 `runToolLoop` 选项都会在启动期抛，判词形如
`unknown runToolLoop option: "timeoutMs" (its canonical home is config.timing.timeoutMs; the flat spelling is rejected)`。

| 退役的顶层名 | 请写成 | issue |
|---|---|---|
| `timeoutMs`、`deadlineMs`、`retry` | `config.timing.timeoutMs` / `.deadlineMs` / `.retry` | #498 |
| `context`、`toolResultTtl`、`toolResultFoldMinTokens` | `config.folding.context` / `.toolResultTtl` / `.toolResultFoldMinTokens` | #498 |
| `cacheStablePrefix`、`initialMessages` | `config.input.cacheStablePrefix` / `.initialMessages` | #498、#517 |
| `initialUserMessage` | `config.input.initialUserMessage` | #498 |
| `system` | `config.input.system` | #498 |
| `wrapup` | `config.input.wrapup` | #498、#530 |
| `maxTokens`、`temperature`、`topP` | `config.tuning.maxTokens` / `.temperature` / `.topP` | #498 |
| `cacheCapable` | `config.tuning.cacheCapable` | #498 |
| `finalGuardMaxRetries`、`finalGuardTimeoutMs`、`finalGuardExtend` | `config.guard.*` | #498 |
| `modelMetadata`、`requestId`、`toolContext`、`expert` | `config.metadata.*` | #498 |
| `user`、`model`、`task` | `config.metadata.user` / `.model` / `.task` | #498、#531 |
| `invalidArguments`、`replayPolicy`、`writeToolPathKeys`、`writeToolNames` | `config.run.*` | #498 |
| `partialPersistence`、`maxTokenContinuations`、`stream`、`resume`、`runId`、`maxRounds`、`completion` | `config.run.*` | #498、#538 |
| `stallDetection`、`persistence`、`outputHygiene`、`cwd` | `config.run.stallDetection` / `.persistence` / `.outputHygiene` / `.cwd` | #498、#562 |
| `reflection` | 11 个数据成员进 `config.run.reflection.*`；两个被调用的成员进 `capabilities` | #530 |
| 当数据叶子用的 `session` | 顶层 `session`（端口不是数据） | #531 |

**为什么对写法正确的宿主是「行为不变」。** 展开相（`expandConfigNamespace`，
`src/loop/config-namespace.js`）会把每个被接受的规位叶子写回引擎一直在读的那个名字，所以本版**没有**改
任何消费端的读侧：用新写法配出来的 run，与用旧写法配的同一个 run 表现一致。变的只有**你被允许把值写在哪**。

**宿主最容易混的两条边界。**

* `finalGuard` 是**钩子**，不是数据键：它仍是顶层的能力成员，而它的三个配置键去了 `config.guard.*`。
* `tools` 仍是顶层选项。嵌套写法 `config.input.tools` **从来没有成立过**——它在某个模式形状里列着，但
  没有任何代码读过它，0.28 把这一条删掉了（§9）。

## 4. 宿主行为住在 `capabilities`（issue #530、#545）

`reflection` 是最后一个退役的扁平键，而它退役的方式与其他键不同：11 个数据成员进
`config.run.reflection.*`，而引擎真正会调的两样去了本来就有位置的那个平面——`onReflection` →
`capabilities.hooks.onReflection`，`judge.provider` → `capabilities.ports.judgeProvider`。
`metadata`、`completion` 这些键从来不会被调用，所以在它们那里拒掉函数是一个**裁决过的收窄**；
而 `reflection` 的成员真的会被调用，所以它们必须**搬个地方**，而不是简单地不再接受函数。

装配口上的 `policy` **只装数据**（issue #545）：它的被接受键集由规位叶子加上两个容器 `config` /
`capabilities` 派生，且每个被接受的叶子都翻译成 `config.<组>.<叶>`。把能力扁平写进 `policy` 会被拒并指路，例如
`unknown assembly policy option: "onFoldSummary" (policy carries data only: …)`。优先级是：显式的
`policy.config` 树压过翻译出来的叶子，而端口派生叶子**只补洞**。

## 5. `session` 是身份容器；你的载荷换了家（issue #513、#550、#551）

顶层 `session` 只接受 `session.id`、`session.modelSlot`、`session.initialMessages`。被接受集合是从
**实际读它的地方**派生的（`SESSION_MEMBER_READ_POINTS`，`src/assembly-validators.js`），所以不可能与引擎
漂移。`session.id` 会变成 `config.run.runId`，`session.initialMessages` 播第一轮 —— 现在**两条路都生效**，
这对「以前通过端口传了、但一直被静默忽略」的宿主是行为变化（issue #550）。

你从前当**不透明载荷**塞进 `session` 的东西，现在写 `config.folding.context.session`。它会以
`context.session` 到达你的工具执行处——而且**你没设的时候这个键是不存在的**，不是空对象（issue #550）。
`config.metadata.session` 会被一条指路判词拒掉（issue #551），所以写错的地方会告诉你该写哪，而不是安静地
变成 `undefined`。

## 6. 未知名字现在会抛

本版落了三道闸，全部在启动期、全部点名怎么改：

* **退役扁平名**（issue #498）——见 §3。
* **`session` 容器里的未知成员**（issue #513），两条路都拒：
  `unknown session option: session.bogusSubkey (accepted: session.id, session.modelSlot, session.initialMessages)`。
* **装配口顶层未知成员**（issue #556）。到 0.27 为止，多出来的键会被接受然后丢掉，而宿主最常写的两个名字
  **恰好是另一条路的两个容器**，于是顶层 `{ config: … }` 意味着零反馈、零效果。闸在任何宿主工厂之前运行，
  且被接受集合从构造端口的那张表派生（`ASSEMBLY_PORT_MEMBER_READ_POINTS`，`src/assembly.js`）：
  `unknown assembly port option: "config" (accepted: …); its canonical home is policy.config: …`
  非对象入参现在读作 `assembly port must be an object (got null)`。

以上每一句都被机器钉住：`test/contract-verbatim-verdicts-553.test.js` 从**运行中的引擎**读出这些句子，并与
契约文本比对，所以文档没法安静地承诺一句引擎已经不打印的话（issue #553、#554、#557）。

## 7. 两条现在开始生效的值规则

* **`config.run.stream` 必须是布尔**（issue #538）。它从前喂两套不同判定（记哪个通道名、以及调 `chat` 还是
  `chatStream`），现在合成一个派生值（`streamsThisRun`，`src/loop/provider-runner.js`）。非布尔值在**两条路**
  都在入口处抛，而不是产出一个悄悄不同的传输形态：
  `config.run.stream must be a boolean (received: number)`。
* **`config.timing.retry.sleepImpl` 不再是回调字段**（issue #520）。没有任何引擎代码读它，所以过期取值现在
  直接被忽略——还传它的宿主不会拿到错误（这是**刻意的放宽**，与上面那条收紧正好相反）。

## 8. 声明面现在等于被接受集合（issue #522）

`src/index.d.ts` 里声明的顶层键与接受的选项白名单是对账的，所以升级后一个新的 TypeScript 错误，通常就是
你写了一个运行时同样会拒的名字。契约里「不该编译通过」的坏样本用 `tsc --strict` 检查，未知选项键会以
`TS2353` 失败，而不是编译通过、到启动期才炸。

## 9. 三个从来不存在过的写法

别把这些当迁移写——它们从来没有生效过，本版故意这么写清：

* `config.input.tools`（#527）：在某个模式形状里列着，**从未被任何代码路径读过**；该条目已删，`tools`
  仍是顶层选项。
* 当数据叶子用的 `config.metadata.session`（#531、#551）：`session` 是端口；载荷之家是
  `config.folding.context.session`。
* 顶层的 `messages`，以及把它当**迁移目的地**写出来的 `config.input.messages`（#562）：这个扁平名从来没
  在白名单里占过位置，所以引擎用那句普通的未知选项判词拒掉它，且**不带**指路子句——因为没有旧家可指。
  叶子本身是活的，而且也一直是这个地址：`config.input.messages`。

## 10. 没有变的东西

* 引擎的**读侧**：每个消费端仍读同一个内部名字，由展开相写回。
* 停机、验证、退出码语义；不带 `--final-guard` 时那个 `skipped` 的退出码仍是 `4`。
* transcript 与 run-state 的落盘格式；从旧账本 resume。
* 工具执行、压缩策略默认值、reflection 门槛、终稿核验契约（含命名交付物判据
  `createNamedDeliverableChecks`，`bin/final-guard.js`）。
* CLI、两个内建 provider 工厂，以及零运行时依赖这条红线。

## 11. 在你自己这边验一遍

1. **把你还在写的退役名字全找出来。** 在你的仓库根目录跑：

   ```bash
   grep -rnE '\b(timeoutMs|deadlineMs|retry|toolResultTtl|toolResultFoldMinTokens|cacheStablePrefix|initialMessages|initialUserMessage|cacheCapable|finalGuardMaxRetries|finalGuardTimeoutMs|finalGuardExtend|maxTokens|temperature|topP|modelMetadata|requestId|toolContext|expert|partialPersistence|maxTokenContinuations|invalidArguments|replayPolicy|writeToolPathKeys|writeToolNames|completion|resume|runId|maxRounds|wrapup)\b' src/
   ```

   会有误报（你自己的字段名、引擎**事件**载荷里的字段、本仓库文档里的 `effectiveOptions`）。你要找的是
   **写进你交给 `runToolLoop` / `createAssemblyPort` 的那个选项对象的名字**。

2. **跑你的测试套件，读第一个错误而不是最后一个。** 本版每一次拒绝都在启动期，且判词点名规位住址，
   所以第一个失败的用例通常就是全部要改的地方。

3. **如果你自己装配端口**，检查顶层除了被接受的成员之外什么都没有，并且从前塞在那里的数据现在在 `policy`
   里面（§6）。

4. **用发布出去的声明文件给你的宿主做类型检查**（`tsc --strict`）。选项键上新出现的 `TS2353`，意味着运行时
   也会拒它（§8）。

## 12. CLI 的 `delegate` 是示例，不是契约（issue #617）

`erix chat` 与 `erix repl` 多了一个显式开启的 `--delegate` 旗标。**库的契约面没有跟着动**：你能依赖的
仍然是三件东西——`config.run.parentRunId`（opaque，只镜像、不解释）、簿记三件套（名册 / 并发租约 /
完成通知去重），以及 `createDelegateTool`（`src/tools/delegation/tool.js`），而它的 `runChild` 是
**由宿主注入**的。

留在你这一侧的是：

* **子 run 怎么跑起来。** 库从不 fork、不 spawn、也不 import `child_process`。你给 `createDelegateTool`
  一个 `runChild`，由你决定子 run **是什么**（同进程、子进程、远端）。
* **落盘位置。** 名册是簿记不是 transcript：`writeRecord`（`src/tools/delegation/roster.js`）一个子 run
  一条记录，而那个子 run 的 transcript 放哪由你定。CLI 从名册目录派生（`<rosterDir>/transcripts/`），
  于是子 run **绝不**追加进父的会话文件——CLI 的会话 id 由工作目录派生，父子同目录本来会撞同一个文件名。
* **编排与唤醒父 run。** `notifyParent` 是你提供的回调。**没有**通往运行中 `runToolLoop` 的邮箱：
  后台子 run 的完成经那个回调到达父侧（CLI 把那一行打到 stderr），父 run 再用 `action=result` 取回终局。
  假装有邮箱，是更糟的契约。

CLI 是这套分工的**可运行示例与验证器**，而且默认关闭：`delegate` 不在默认工具面上，也不在默认系统提示里。
开启用 `--delegate`，配额用 `--delegate-max-children <n>`（默认 2）、预算用 `--delegate-timeout-ms <n>`
（默认 600000）；名册目录默认 `~/.erix/delegation/`，可用 `ERIX_DELEGATION_DIR` 搬走。三条 v1 边界是
**刻意的**，不是遗漏：子 run 是**同进程嵌套的 `runToolLoop`**（不起子进程、不起守护进程）、子 run 的
工具面**不含 `delegate`**（不递归派生）、子 run 的 transcript 是它自己的文件。

**把子 run 写在哪登记上去，否则父的 `tail` 看不见（issue #626 C1）。** 记录是库建的，而库不知道你的
目录布局，所以名册里的 `transcriptPath` 字段只有**你**填了才有——起了子却没登记路径的宿主，拿到的
`tail` 永远答 `no_transcript_path`。旋钮叫 `transcriptPathFor`：一个 `(runId) => string` 的函数，与
`runChild` 一起交给派生工具工厂。给了它，库在**创建记录的那一次原子写**里就把路径写进去，所以
派生后立刻 `tail` 的父 run 已经看得见（不存在「先建记录、再补写第二遍」的窗口）；不给，字段照旧
缺省，现有宿主一字不改也不会破。路径请用 store 自己的命名助手推导，不要自己拼 `<runId>.jsonl`
——store 会把它认为不安全的 id 哈希掉，手拼的路径对那一类 id 恒错，而错法是「文件永远不存在」。

`tail` 把两种失败分开，这个区分本身就是契约：`no_transcript_path` 是记录里没有路径（**你这侧的
配置缺陷**），`no_transcript` 是路径在、文件不在或打不开（子还没落第一行 / 档案已清理，**正常时序**）。
把两者合成一个，就会把「你没接」读成「子没干活」。

**这套示例面的三处修正（issue #630 S1）。** 三条都是「记录与结果必须说真话」，都不新增默认能力。

* **`action=result` 带回子 run 的终稿。** 终态那一次名册写现在会存 `resultText`（子的终稿，
  上限 **4000 字符**，被截断时带 `truncated: true`）与 `errorMessage`（子的错误，上限 1000，
  只在子抛错时写）——写进**存终态 `state` 的同一次原子写**，不是事后补写第二遍。`result` 返回名册的终态字段再加 `text`（有截断 / 错误时还有 `truncated` /
  `error`）。在此之前，后台子 run 的终稿被直接丢掉：父只拿到 `state` 与 `termination`，答案是「看 `tail` 猜」。
* **名册里的 cwd 字段是子 run 实际跑在的目录——前提是你告诉它。** 模型给的 cwd 是请求、不是事实：
  库不解析相对路径，也不知道你的缺省目录是谁。端口是 cwdFor：`(requested, runId) => string`。
  提供了它，库就**只解析一次**，并且**同一个值**既写记录、又交给 `runChild`（不存在「记录一个、
  执行另一个」）；返回值必须是非空字符串，否则工厂当场抛。不提供就保持旧行为——但那时名册的
  cwd 字段 **不代表**子实际跑在哪，所以想要记录为真的宿主应当总是提供它。CLI 就是这么做的：
  `cwdFor: (requested) => path.resolve(requested ?? parentCwd)`。
* **子 run 的工具面是父的子集。** 派生绝不扩权：子工具集在进引擎之前就用父的 `--tools` 白名单
  （同一个 `filterToolsByAllowlist`）过滤过，而 `delegate` 本身永不下传（v1 不递归）。
  没有白名单时子照旧拿全量，与以前逐字一致。

整条链路的闸门是 `examples/delegate-real-e2e.test.mjs`，即 `npm run check:release:real` 的第 2 步：
真上游下父 run 派生一个子 run，断言子名册记录带的是父的 `config.run.runId`、子 run 以 `end_turn` 收尾、
名册终态 `completed`、父侧被唤醒**恰好一次**。
