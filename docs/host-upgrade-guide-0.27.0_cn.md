# 宿主升级指南：0.27.0

**这是「折叠摘要器终于有了死线、预算和体积上限」那一版。** 0.26.0 让折叠说出自己删掉了什么；0.27.0 让说出这句话
背后那次 LLM 调用变得**有界**——限时、限输入、限输出——并且在降级时说清**是怎么降的**。没有删除、没有改名、没有
store 方法签名变动、没有导出或依赖搬迁，运行时依赖仍然是**零**个 npm 包。

下面每一条都是加法，或者是一个行为更好的默认值，**只有两处需要你看一眼**：摘要输出预算的默认值从 `800` 移到
`1400`（§4），摘要请求的 `maxTokens` 不再原样继承 run 的值（§2）。按 0.26.0 编译通过的宿主，编译与运行都不变。
完整清单仍在 `CHANGELOG.md`，字段级真相仍在 `docs/host-consumer-contract.md`。

## 1. 变更总览

| 变更 | 你需要动手吗 |
| --- | --- |
| `context` 上五个摘要旋钮（§2） | 不需要——全不传就是下面这套默认值 |
| 摘要请求 `maxTokens` = `min(run maxTokens, maxSummaryTokens)`（§2） | 需要，如果你断言过摘要请求体 |
| `context` 未知子键：旋钮拼错抛、宿主元数据放行并留事件（§3） | 需要，如果你往 `context` 放过自己的键 |
| 摘要预算默认 `800 → 1400`；裁剪保留小节标题；主题词上移一档（§4） | 需要，如果你钉住了旧的截断形状 |
| 续写基底跨 resume 播种，复用键把它算进去（§5） | 需要，**每份既有账本预期会重算一次** |
| `compaction.foldSummary` 上的降级事实，含 `degradeKind` 与 `finishReason`（§6） | 不需要——纯加法，无事实不写键 |
| 单轮就超过输入上限时没有整轮可丢（§7） | 不需要，但钉 `droppedRounds` 之前先读这段 |
| 同一批旋钮的嵌套 `config` 命名空间（§10） | 不需要——扁平键照旧工作；两种写法都给时 `config.*` 赢 |

### 本次发版动到的面（宿主可见）

- `src/loop/orchestrator.js` —— 摘要器接线：两层死线、输入上限、`summaryMaxTokens` 取小对齐、续写基底播种。
- `src/compact/provider-summarizer.js` —— 死线真的中止在飞的 provider 调用；错误保留自己的类型。
- `src/compact/fold-llm.js` —— 摘要预算默认值、保留骨架的裁剪、小节档位顺序、`degradeKind` 归因。
- `src/assembly-validators.js` / `src/assembly.js` —— `context` 白名单（五个引擎自读键 + 全部旋钮）、按编辑距离判旋钮家族、`contextOptionNameSelfCheck()`。
- `src/loop/budget.js` —— `context.toolContext` / `expert` / `user` / `session` / `requestId`：一直在被读，此前却没进白名单。
- `src/tools/file-tools.js` —— `readFile` 描述里的中位档按新口径复测（字节中性；测试容差常量一个没动）。
- `src/loop/config-namespace.js` —— `config` 命名空间的 schema、从它派生的别名表，以及能力面的拒绝名单（`runId` / `cwd` 是配置面不是能力面：字符串标量、JSON 安全）。

## 2. 五个摘要旋钮，以及一根终于真的生效的上限

`context` 接受五个旋钮。**五个都不传就是推荐配置**：下面这套默认值就是一位生产宿主提出的裁定值，所以「省略」
与「写死」等价。

| 旋钮 | 默认值 | 含义 |
| --- | --- | --- |
| `summarizerTimeoutMs` | `30000` | **provider 层、单发**死线。会中止在飞的那次 HTTP 调用；宿主 abort 整个 run 时现在也真的中止这一发，而不是事后才发现 |
| `summarizerBudgetMs` | `30000` | **策略层、整条步骤**死线。首发与「换更短输入自愈重试」共用它——与上一行**刻意是两个语义**，不要合并 |
| `maxSummarizerInputBytes` | `49152`（48 KB） | 喂给摘要器的硬字节上限。按被折的整轮量算，所以它咬不动的情形见 §7 |
| `maxPriorSummaryBytes` | `24576`（24 KB） | 作为续写基底的上一份摘要的体积上限 |
| `maxSummaryTokens` | `1400` | 摘要的**输出**预算（本版之前是 `800`——见 §4） |

五个都必须是安全正整数，否则装配期抛 `TypeError` 并点名键名。`null` / `0` / `-1` / `1.5` / `"1000"` 都属于
「给了，但给错」；只有省略才等于默认。

**如果你断言过请求体，这是唯一一处要核对的行为变化**：摘要请求的 `maxTokens` 以前原样继承 run 的值——设了
`maxTokens: 32768` 的宿主等于花钱让模型写满 32k，再被摘要预算剪回去。现在是：

```js
summaryMaxTokens = Math.min(run.maxTokens ?? Infinity, context.maxSummaryTokens ?? 1400)
```

只会更严，不会更松。想要回到旧上限，显式设 `context.maxSummaryTokens`。

## 3. `context` 未知子键：拼错会抛，你的元数据不会

0.26.0 会把未知子键**静默丢掉**（宿主以为配上了，引擎用的是默认值）。装配期现在分两种情况：

- **旋钮家族的手滑照旧抛**——与某个已知旋钮名编辑距离 ≤ 2 的键（`maxPriorSummaryByte`、`summarizeBudgetMs`、
  `summarizerTimeouts`…）是明确事故，在装配期报 `unknown … context option`。判据是**编辑距离，不是词根包含**：
  名字里带个 `summar` 不构成旋钮。
- **其余都算宿主元数据**——契约一直说宿主私有元数据可以放 `context`（`workspaceName`、`summaryStyle`、
  `summarizerNote`…）。这类键**放行**，并在**装配口路线**上如实报一条事件、不静默（直连路线从不发这条事件，见本节末）：

```
type: "context_unknown_option"
keys: ["workspaceName"]
note: "unknown context keys are tolerated as host metadata; summarizer knob typos throw instead"
```

另外补齐了 `toolContext`、`expert`、`user`、`session`、`requestId`——引擎自己在 `src/loop/budget.js` 里读它们。
在 0.26.x 上往 `context` 放这几个键的宿主会在装配期吃一个 `TypeError`：那是我方白名单的漏列，本版修掉。

**`context.onFoldSummary` 在本版退役（issue #499）。** 它以前留在「合法键」名单里，而引擎**从不**从 `context`
读它——投递钩子的真实位置是顶层（`runToolLoop({ onFoldSummary })`）或装配端口策略项（`policy.onFoldSummary`）。
那一条白名单只买到「绿灯 + **零**事件」：配上了、不生效、还看不见。现在它是普通的放行键——装配口路线通过一条
`context_unknown_option` 报出，直连路线静默放行，**两条路线都不抛**（它是宿主元数据的形状，不是拼错的旋钮名）。
若你曾在 `context` 下配过它，请搬到上面两个真实位置之一；没配过则一切照旧。

⚠ **这套校验现在两条路线都跑**（issue #496）。以前直接调 `runToolLoop(options)` 的宿主对 `context` 拿不到任何
校验，拼错的旋钮静默无效；这处不对称已经消除：两条路线抛**同一个 `TypeError`、同一句文案**，错误对象上带
`via: "direct" | "assembly"`，让你看得出是从哪道门进来的。**只剩一处不对称，且只有这一处**：
`context_unknown_option` 事件只由装配口发出，直连路线永远收不到（`onEvent` 在那条路线上照常工作，只是收不到
这一条事件）。

这次修复带来两个宿主可见后果，两个都不是静默无操作：

- **旋钮家族判据的爆炸半径随修复一起变大了。**判据本身一字未改（对已知旋钮名取编辑距离 ≤ 2，从不按子串），
  但 0.27.0 之前只有走装配口的宿主吃它，现在**所有**宿主都吃。实测：`summarizerBudget`、`summarizerTimeout`、
  `maxSummaryToken` 现在**会抛**；`summaryStyle`、`summarizerNote`、`maxSummaryChars`、`workspaceName` 照旧放行。
- **回调给了非函数值现在启动即抛**，不再悄悄当没给：`finalGuard`、`retry.sleepImpl`、`reflection.onReflection`、
  `diagnostics.error`、`onFoldSummary`、`context.onBeforeFold`、`context.onAfterFold`。`null` 算「给了但给错」。
  **唯一例外**是 `context: null`，它逐字等于「没配」（实测与省略该键行为完全相同）。

## 4. 摘要预算：默认值挪了，裁剪也不再糊掉骨架

三件相关的改动，目标都是「五节合同在默认配置下就成立」：

1. **`maxSummaryTokens` 默认 `800 → 1400`。** 五节 × 每节 150 个中文字实测约 1,335 token，所以按旧默认值，一个
   完全守合同的模型照样会被剪成两节。
2. **裁剪保留骨架。** 以前超预算的整节（含 `## 标题`）被换成一行 `[已修剪]`，读的人和下一次折叠的摘要器都看不出
   「曾经有这一节」；现在只剪正文：`## 标题\n[已修剪]`。
3. **主题词上移档位**，与 `## 下一步` 同属第 1 档。顺序现在是：下一步 / 恢复提示 > 主题词 > 已验证项 >
   已改文件。预算一紧，先没的是文件清单，而不是「接下来该搜什么」的唯一线索。

`compaction.foldSummary.finishReason` 原样透出 provider 归一后的值；`max_tokens` 意味着**这份摘要被输出预算截断
过、不是完整摘要**。未知的取值请按「未知」处理，不许当成「正常」。

## 5. 续写基底能跨 resume 活下来——代价是升级后每份既有账本重算一次

「上一份摘要」以前只是某个策略实例里的闭包，于是**resume 出来的 run 第一次折叠没有基底**，而模型那边在上下文里
明明看得见上一份。现在它按账本（会话作用域）播种，复用与折叠替代物回填同一个「覆盖区间挑取器」，并如实报告：

```
compaction.foldSummary.priorSummaryOrigin: "ledger" | "in-run"     // 没有基底就不写这个键
```

优先级写死：显式调用参数 > 策略构造参数 > in-run 闭包 > 账本播种。

**每个既有会话请预期一次这样的开销**：复用指纹现在把基底文本算进去了，所以本次发版之前写下的账本，升级后第一次
折叠会 miss 掉已存的摘要并重算一份。这是故意的（不算进去的话，偏偏在最需要基底的那次折叠上，播进来的基底会被无声
忽略），**不是回归信号**——同区间第二次折叠就重新命中。

## 6. 摘要成了次品时，要说出来

降级**不新增事件类型**，事实记在折叠统计上，界面得自己去读：

```
compaction.foldSummary = {
  degradeKind,            // "timeout" | "context_window_exceeded" | "error"
  degradeReason,          // 给人读的整句
  inputTruncated, droppedMessages, droppedRounds,
  finishReason, inputTokens, outputTokens,
  priorSummaryTruncated, priorSummaryBytes,
  attempts, budgetExhausted, reused,
  strategyName            // 在 stat 本体上：真正执行这次折叠的策略
}
```

与 `strategyName` 同一条纪律：**无事实不写键**——一次干净的折叠让这个形状逐字不变，所以「键不存在」的意思是
「没出岔子」，不是「我们没看」。`fold-statistical` 永远不写上面任何一个键（它不经 LLM），这是契约不是 bug。
降级**不是 run 失败**：模型拿到的仍是替代物，别把一条 `degradeKind` 刷成红色终态。

## 7. 一轮就超宽的胖轮，没有整轮可丢

`maxSummarizerInputBytes` 是按被折叠的那些轮算的。如果**单独一轮**就已经超过上限，就没有整轮可以再丢：
`droppedRounds` 保持 `0`，由 token 守卫逐条裁掉，并留一条省略注。形状是「一条用户消息 = 一个 run」的宿主会常态
性撞上这条——验收判据不要假设那根字节上限一定会触发。

## 8. 什么没变

- 没有删除或改名任何 API；导出没搬；`runToolLoop` 选项名不变。
- `TranscriptStore` / `NotesStore` 签名不变；无迁移；没有新增必需 store 方法。
- `fold-statistical` 与 `sliding-window` 仍是零 LLM、零成本，输出不变。
- 0.26.0 的 `record.foldedFacts` / `onFoldSummary` 载荷不变，只多了三个范围键（`foldedRoundRange`、
  `foldedThrough`、`foldedRoundCount`——注意 `foldedRoundCount` 是 **run 作用域**）。
- 运行时依赖：仍然零个。

## 9. 在你自己这边验一遍

```bash
npm i erix-agent@0.27.0
node -e 'import("erix-agent").then(m=>console.log(Object.keys(m).length))'   # 冒烟：公共面能加载
```

然后在你自己的验收里补四格：

1. **旋钮真的走到线上**：设 `context.maxSummaryTokens = 200`，断言摘要请求体带 `maxTokens: 200`，而 run 自己仍是
   原来那个较大的值。
2. **装配期拒的是坏值、不是你的元数据**：`{ maxSummaryTokens: 0 }` 抛；`{ workspaceName: "x" }` 能装配并发一条
   `context_unknown_option`。
3. **降级看得见**：制造一次摘要器超时，断言 `compaction` 事件上 `compaction.foldSummary.degradeKind === "timeout"`，
   且这个 run 照常正常收尾。
4. **升级那一次 miss 只有一次**：在一个既有会话上连折两次，断言第一次重算了（`priorSummaryOrigin` 在），第二次没有
   再烧同一份基底。

## 10. 一次 run 的配置只有一面：`config`

0.27.0 给配置键加了第二种写法，而且是嵌套的。`config.run.maxRounds` 与扁平的 `maxRounds` 是同一个
旋钮：叶子名逐字等于扁平选项名（唯一一条登记在案的例外：`config.input.messages` 是扁平
`initialMessages`），别名**就是** schema 路径——没有要记的东西，也没有会漂的第二张映射表。
七个分组是 `input` / `run` / `tuning` / `timing` / `folding` / `guard` / `metadata`，
契约里「config 命名空间（issue #497）」那一节把每个旋钮逐个列出。

**回调不在配置树里**（issue #498 S4a）。`capabilities.hooks` 是它们的规范之家——`onEvent`、
`onObserverError`、`onPersistenceError`、`onRound`、`onJudge`、`onToolResult`、`onDelta`、
`onReasoningDelta`、`onToolCall`、`onUsage`、`onFoldSummary`——而顶层扁平写法继续逐字可用。
**没有** `config.observers` 这一组：0.27.0 草案里带着的那组**在发布前就删掉了**，因为回调是行为
而不是数据，装着一个回调的 `config` 子树过不了 JSON round-trip。同一个理由：`config` 里出现任何
函数值现在 intake 当场拒绝并点名完整路径（`config.timing.retry.sleepImpl`、
`config.folding.context.onBeforeFold` …），而 `finalGuard`（值必须是函数）离开了配置面
（顶层扁平 `finalGuard` 一字未动）。

**同一个版本里还有两处搬动**（issue #498 S4b）：`deliverables` 也离开了配置面（它的每一条都带函数
`check`），现在住在 `capabilities.checks.deliverables`——「`config` 里只能写 `deliverables: []`」
那个过渡态因此消失。`finalGuard` 收进了 `capabilities.hooks`（当时 12 个成员；下面那一刀之后是 16 个）。`tools`
反向归位：它是数据，现在是 `config.input.tools`（扁平 `tools` 一字未动），于是能力面就是纯粹的
「行为载体」。`session` 只装数据——草案里的 `session.resume` 别名已删，现在写它在**两条入口路线**上都会抛
（装配口的 `createAssemblyPort` 与直连的 `runToolLoop` 选项，共用同一道语义相），并点名完整路径
`session.resume`；要续跑请写 `resume`（或 `config.run.resume`）。两条路线都不静默忽略它。

**同一个版本里的第三刀**（issue #498 S4c）：住在壳**里面**的行为载体拿到了真实归宿。
`capabilities.ports` 现在存在，三个槽位——`sleepImpl`（重试定时器，原 `retry.sleepImpl`）、
`judgeProvider`（judge 评估器，原 `reflection.judge.provider`；接受 callable 或 `{ chat }` 对象）、
`strategy`（压缩策略对象，原 `context.strategy`）。`capabilities.hooks` 长到 **16** 个回调
（`onReflection`、`onBeforeFold`、`onAfterFold`、`stubFor` 加入），外加两个形态多态旋钮的**函数形态**
——`protectedMessage` 与 `recoveryHint`——它们的数据形态（字符串或数组）留在 `config.folding.context`。
这 9 个叶子**没有一个是新的顶层选项**：白名单仍是 67 条，上面那些嵌套老槽位照旧可用。两条要知道的
规则：端口位可以是对象，`hooks` 必须 callable；同一个旋钮两种写法给了**不同**的值 ⇒ 发那一条
`config_override_conflict`（path 是 `ports.sleepImpl` / `hooks.onBeforeFold` /
`folding.context.protectedMessage`）。**`reflection.judge.evaluator` 已退役**——它曾是
`reflection.judge.provider` 的纯别名；现在写它在两条入口路线上都抛，并指向
`capabilities.ports.judgeProvider`。

你需要动手的：**没有**。今天在传的扁平键继续被接受，行为与以前逐字相同。若你打算采用它，有两点要知道：

1. **优先级** —— 同一个旋钮两种写法都给时 `config.*` 赢，且引擎在第一轮之前发一条
   `config_override_conflict` 事件：`{ type, runId?, conflicts: [{ path, key }], detail }`。
   没有静默——看到这条事件，说明那一次 run 里有一个旋钮有两个真相来源。**同一条事件也管装配口的
   `policy.config` 与调用级 `config`**：调用级那棵树按整棵覆盖（既有「后写者胜」的合并规则，一字未改），
   两个源里同一个叶子给了不同值的，逐叶上报。值相同不算冲突；只写在被覆盖那棵树里的叶子会被
   **丢掉**，所以别把两个源当逐叶合并用。
2. **能力键一律拒绝** —— `provider`、`executeTool`、`store`、`modelConfig`、`assemblyPort`、
   `signal`、`todoStateProvider`、`semanticStateProvider`、`onEvent`、
   `onObserverError`、`onPersistenceError`、`diagnostics`、八个观察者通道（`onRound`、`onJudge`、
   `onToolResult`、`onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage`、`onFoldSummary`）、
   `finalGuard` 与 `deliverables` 都不是配置。把它们写进 `config` ⇒ 启动即抛并点名该键；有新家的
   还会点出 `capabilities.hooks.<name>` / `capabilities.checks.<leaf>`。这条线是**行为面**的：能力面 = 你递进来的**行为载体**（引擎调用或
   解引用的函数 / 端口对象），配置面 = 引擎**按已知字段校值并解释**的数据。所以本版里 `persistence`
   （`config.run.persistence`）与 `model` / `modelMetadata` / `session`（`config.metadata.*`）都是
   配置——引擎读它们的已知字段（持久化模式字面量、窗口数字、`session.id` / `modelSlot`）。
   `runId` / `cwd` 同样在配置面（`config.run.runId` / `config.run.cwd`）：它们是字符串标量、天然
   JSON 安全，而「`config` 子树过 JSON round-trip 等值」要求能力面只剩函数/端口对象——这条性质现在
   由默认套件**机器断言**（每个 schema 叶子一个代表性数据取值，然后 `JSON.parse(JSON.stringify(cfg))`
   逐叶比），不再只是一句承诺。这条收窄**只作用于新命名空间**：直连路线的优先级规则——显式细粒度
   选项覆盖装配口提供的同名成员（`src/loop/option-normalization.js`），例如
   `runToolLoop({ assemblyPort, provider })` 里显式 `provider` 仍能盖端口 provider——一字未动，
   `test/contract/assembly-port.js` 照旧断言它。**唯一变的是**（issue #498，自 0.28.0 起）
   `assemblyPortOptions` 的第二个参数：端口已经产出的键再出现在 `overrides` 里，现在启动期抛，
   不再静默取胜者（见契约里的「调用期覆盖通道」一节）。

新宿主：配置写 `config`，行为载体写 `capabilities`（回调进 `hooks`、交付物判据进 `checks`、
基础设施与策略实现进 `ports`）。顶层扁平键是**原语 / 过渡面**——继续接受、
继续校验、继续有文档——它们的删除窗口属母单（#495）的发布阶梯。本版一个都不删。
