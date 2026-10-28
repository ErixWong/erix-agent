# 扁平选项写点清点表（#498 S7 的退役前置清单）

> 用途：**#498 S9 一次性退役 11 个顶层扁平回调键**那一刀，要靠这张表决定「改哪些文件、哪些文件
> 一个字都不许动」。所以下面每一行都是**文件级、可核对**的条目，不是散文。
>
> 本文件随 `test/` 落盘、**不进 npm 包**（`package.json` 的 `files` 没有它）。
>
> 生成方式（可复跑，不许凭感觉）：AST 走 `test/**`（排除 `test/contract/**`，那是 #498 S8 独占），
> 数**属性写法**的命中次数（`PropertyAssignment` / `ShorthandPropertyAssignment` 的名字），规则五条：
>
> 1. 只数属性名（注释、字符串、白名单数组里的字样都不算）；
> 2. **数到被数的键就停**，不再往它的值里走（`retry: { sleepImpl }` 只算 `retry` 一个）；
> 3. `capabilities` / `config` 容器同样数到就停（容器里的同名叶子是**规位写法**，不是扁平写点）；
> 4. **进 `context` 同名壳也停**（`context: { onFoldSummary }` 与 `context: foldContext({ onFoldSummary })`
>    都只算 `context` 一个——壳内写点不是扁平写点）；
> 5. 不数「同名变量落进记录对象」的简写（`onObserverError: (error, context) => seen.push({ error, context })`
>    里的 `context` 不算）——这条是规则 2 的推论。
>
> 按这五条：**迁移前 388 / 迁移后 351 / 附表 678 / COMPAT-PIN 66**。复跑命令在文末「复跑方法」，
> 跑出来逐字就是这四个数；**漏掉规则 2/4 会得 390 / 353**（多出来的 2 个写点都藏在「被数的键的值」里，
> 例如 `test/loop-context-on-fold-summary-retired-499.test.js` 的 `context: foldContext({ onFoldSummary })`）。
>
> 计数口径：`onEvent` / `onRound` / `onJudge` / `onToolResult` / `onDelta` / `onReasoningDelta` /
> `onToolCall` / `onUsage` / `onObserverError` / `onPersistenceError` / `onFoldSummary` 这 **11 个是
> S9 的退役面**；`finalGuard` / `deliverables` 同属能力面，**且已有规位**（`capabilities.hooks.finalGuard` /
> `capabilities.checks.deliverables`，见 `docs/host-consumer-contract.md`）⇒ 按母单裁决属 **S9 的移除项**：
> 本表把它们计入 `MIGRATE`，**必须继续迁**，不是「可选清理」。真正可选的是附表那 **678** 个数据面壳内
> 写点（S9 不退役数据键，另立单，**不在 0.28 路径**上）。
>
> 五类（机器可判，判据见下）。**三类是外部所有权**（S5 / S6 / S8），S7 一律不碰；
> 只有 `MIGRATE` 是 S7 自己的活：
> * **COMPAT-PIN** —— 那格测试的**被测对象就是选项面本身**。不许迁：它们是「扁平写法仍然可用」的
>   兼容钉，S9 退役那天才由那一刀统一改。
> * **OWNED-BY-S5** —— 文件里的**选项装配断言区**由 #498 S5 提前迁移（见下节），本轮任何人别碰。
> * **OWNED-BY-S6** —— `test/examples/*` 里断言 `buildLoopOptions` **装配形状**的那 5 个文件归
>   #498 S6（见下节），本轮任何人别碰。
> * **SKIP-S8** —— `test/contract/**`（#498 S8 独占，S7 一个字不碰；本表不列）。
> * **MIGRATE** —— 断言测的是别的机制（折叠 / 持久化 / 预算 / 续跑 / 工具环 / 压缩策略 / 观察者通道…），
>   扁平键只是**搭台**。按 S7a / S7b / S7c 三片分派。

## 判据：什么样的文件算 COMPAT-PIN

文件里存在**至少一格**，它的断言直接读选项面本身，即出现下列任一「机器可判」的记号：

* `config_override_conflict`（容器与扁平键冲突的事件名）；
* 命名空间报错文案：`unknown capabilities` / `is not accepted` / `must be a function`；
* 名单本身：`RUN_TOOL_LOOP_OPTION_NAMES` / `CAPABILITY_*` / `CONFIG_*`（导出名）；
* 白名单计数（`RUN_TOOL_LOOP_OPTION_NAMES.length` 之类的字面值对账）；
* 选项闸文案：`unknown runToolLoop option`（接受面 = 白名单的那句报错）。

⚠ 三个「记号命中但整文件不是 COMPAT-PIN」的坑（本表按**格**判，不按记号判）：

* `test/loop.test.js` 命中 `unknown runToolLoop option`，但那是**一格**（「rejects unknown runToolLoop
  options with a close suggestion」）；文件其余部分测的是别的机制 ⇒ 分类为 `MIGRATE · 含 COMPAT-PIN 格`，
  迁搭台写点时**别动那一格**。
* `test/loop-on-fold-summary.test.js` 命中 `must be a function`（`assembly policy option onFoldSummary
  must be a function (or omitted)`），那是 #499 的形状报错钉 ⇒ 同样只留那一格。
* `test/loop-deliverables.test.js` 命中 `deliverables[0].check must be a function`，那是**值形状**钉
  （S9 之后它仍在扁平侧），也只留那一格。

## COMPAT-PIN（不许迁，登记备查）

| 文件 | 扁平写点 | 它钉的是哪一面 |
| --- | --- | --- |
| `test/loop-option-normalization.test.js` | 0（容器/白名单面） | `RUN_TOOL_LOOP_OPTION_NAMES` 的**顺序与 67 条**、未知键建议、预检相位（`Proxy` 钉「端口未被触碰」）、容器展开顺序 |
| `test/loop-config-namespace-497.test.js` | 16 | `config` 名称/形状预检、`config_override_conflict`、函数值拒绝（`is not accepted`）、三向闭合自检 |
| `test/loop-capabilities-namespace-498.test.js` | 20 | `capabilities` 名称/形状预检、`hooks` 叶子必须是函数（`must be a function`）、`config_override_conflict`（`path: "hooks.<leaf>"`）、容器赢扁平的优先级 |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | 7 | `ports.*` / 4 个 in-shell 回调 / 两个形态多态旋钮的**目的地表**与冲突路径、`sleepImpl` 被真的调到（行为证据） |
| `test/loop-option-gate-496.test.js` | 15 | 选项闸：接受面 = 白名单（`unknown runToolLoop option`）、语义相取值校验、`onFoldSummary` / `finalGuard` / `deliverables` 的形状报错 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | 8 | #499 的**范围钉**：`context.onFoldSummary` 退役、**顶层扁平 `onFoldSummary` 必须还在**（它 `import` 了 `RUN_TOOL_LOOP_OPTION_NAMES` 并断言 `includes("onFoldSummary")`）⇒ S9 之前这里必须保持扁平 |

合计 **66** 个写点。这 6 个文件在 S9 那一刀里是 **11 个退役键**的唯一「扁平写点保留区」（附表那 678
个数据面壳内写点不在退役面内）；退役时它们要逐个改写为「扁平写法现在抛错」的**反向钉**，而不是删掉。

## OWNED-BY-S5（本轮别碰，S5 提前做）

#498 S5 迁 `bin/` 时必须同步改「捕获到的扁平选项」那 24 行断言
（`captured.cwd` / `captured.tools` / `captured.deliverables` / `captured.finalGuard` /
`captured.finalGuardMaxRetries` / `captured.context.recoveryHint`），
那 24 行按本表的分类规则本来也属 MIGRATE，现**提前由 S5 做**，因此这 4 个文件本轮任何切片都不得改：

| 文件 | 扁平写点 | 谁拥有哪一区 |
| --- | --- | --- |
| `test/cli.test.js` | 2（`finalGuard`×2） | **选项装配断言区**（`captured.*` 的 24 行）归 S5；其余 CLI 行为断言不属 S7 范围 |
| `test/repl.test.js` | 1（`finalGuard`×1） | 同上（REPL 侧的同族捕获断言） |
| `test/host-cwd-wiring.test.js` | 8（`finalGuard`×5, `deliverables`×3） | **整个文件的选项装配断言区**归 S5（cwd 透传与交付物判据的装配断言） |
| `test/notes-final-guard.test.js` | 2（`finalGuard`×2） | 同上（notes 侧 finalGuard 装配断言） |

合计 **13** 个写点。理由：这 4 个文件的扁平写点**与 `bin/` 的捕获断言是同一批**——S5 改 `bin/` 的
同时必须改它们，两边分开做会出现「`bin/` 已改、断言还按旧形状读」的中间态红。S9 退役时这 4 个文件
由 S5 的交接口径直接处理，不需要 S7 再插一手。

## OWNED-BY-S6（本轮别碰，S6 提前做）

这 5 个文件断言的是 `buildLoopOptions`（`examples/pi-extension/` 侧）递给引擎的**装配形状**——
而「改这个形状」正是 #498 S6 的交付物本体。所以它们的扁平写点**不能**由 S7 单独迁：S7 先把断言
改成规位，S6 再改装配形状，两边会互相打脸（断言先绿后红，或者为了绿而把 S6 的形状改动顶回去）。

| 文件 | 扁平写点 | 它断言的是哪一面 |
| --- | --- | --- |
| `test/examples/erix-run-core.test.js` | 21（`finalGuard`×19, `onEvent`×1, `onObserverError`×1） | `buildLoopOptions` 的完整装配形状（含 `finalGuard` 与两条观察者出口） |
| `test/examples/erix-run-details.test.js` | 0 | 装配形状的细节字段（本文件当前只有壳内写点） |
| `test/examples/erix-run-readchain.test.js` | 0 | 读链装配（本文件当前没有上表口径内的写点） |
| `test/examples/erix-run-tool-list.test.js` | 0 | 工具清单装配（本文件当前只有 `tools` / `prompt` 壳内写点） |
| `test/examples/erix-run-notes-lifecycle.test.js` | 0 | notes 生命周期装配（本文件当前只有 `tools` 壳内写点） |

合计 **21** 个上表口径内的写点（另有 38 个壳内写点）。交接口径：S6 改完 `buildLoopOptions` 之后，
这 5 个文件的断言由 S6 一并对齐到新形状；S9 退役扁平键时它们已经是规位写法，S7 不需要再插一手。

⚠ `test/examples/erix-run-core.smoke.test.js`（0 个上表口径内的写点）、`test/examples/erix-run-async.test.js`、
`test/examples/erix-run-pi-load.test.js` **不在** S6 的这 5 个之内——它们不在这份所有权清单里，
本表按各自的实际写点归类。

## MIGRATE（S7a / S7b / S7c 分派）

| 文件 | 写点 | 明细 | 分类 |
| --- | --- | --- | --- |
| `test/loop-observer-isolation.test.js` | 33 | `onEvent`×6, `onObserverError`×15, `onRound`×3, `onToolResult`×4, `onDelta`×1, `onReasoningDelta`×1, `onToolCall`×1, `onUsage`×1, `onJudge`×1 | MIGRATE · S7b |
| `test/loop-guard-extend.test.js` | 26 | `finalGuard`×13, `onEvent`×13 | MIGRATE · S7c |
| `test/loop-deliverables-outrank.test.js` | 25 | `deliverables`×1, `finalGuard`×22, `onEvent`×2 | MIGRATE · S7c |
| `test/loop-deliverables.test.js` | 24 | `finalGuard`×11, `onEvent`×2, `deliverables`×11 | MIGRATE · 含 COMPAT-PIN 格 |
| `test/examples/erix-run-core.test.js` | 21 | `onEvent`×1, `onObserverError`×1, `finalGuard`×19 | OWNED-BY-S6 |
| `test/loop-capabilities-namespace-498.test.js` | 20 | `deliverables`×9, `onRound`×2, `onEvent`×5, `finalGuard`×4 | COMPAT-PIN |
| `test/loop-config-namespace-497.test.js` | 16 | `onEvent`×13, `finalGuard`×2, `onObserverError`×1 | COMPAT-PIN |
| `test/loop-option-gate-496.test.js` | 15 | `onFoldSummary`×7, `finalGuard`×6, `deliverables`×2 | COMPAT-PIN |
| `test/model-metadata-diagnostics.test.js` | 15 | `onEvent`×13, `onObserverError`×2 | MIGRATE · S7b |
| `test/loop-final-guard.test.js` | 14 | `finalGuard`×10, `onEvent`×4 | MIGRATE · S7c |
| `test/loop-on-fold-summary.test.js` | 13 | `onFoldSummary`×11, `onPersistenceError`×2 | MIGRATE · 含 COMPAT-PIN 格 |
| `test/loop-stream.test.js` | 11 | `onDelta`×7, `onUsage`×1, `onEvent`×1, `onObserverError`×2 | MIGRATE · S7b |
| `test/e2e/upstream.test.js` | 8 | `onDelta`×5, `onEvent`×1, `onUsage`×2 | MIGRATE · S7b |
| `test/host-cwd-wiring.test.js` | 8 | `finalGuard`×5, `deliverables`×3 | OWNED-BY-S5 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | 8 | `onEvent`×1, `onFoldSummary`×7 | COMPAT-PIN |
| `test/loop-usage-accounting.test.js` | 8 | `onRound`×8 | MIGRATE · S7b |
| `test/providers/v020-beta.test.js` | 8 | `onEvent`×2, `onReasoningDelta`×2, `onToolCall`×2, `onUsage`×2 | MIGRATE · S7b |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | 7 | `onEvent`×7 | COMPAT-PIN |
| `test/providers/openai-stream.test.js` | 6 | `onDelta`×1, `onUsage`×1, `onEvent`×2, `onReasoningDelta`×2 | MIGRATE · S7b |
| `test/loop-final-guard-payload.test.js` | 5 | `finalGuard`×5 | MIGRATE · S7c |
| `test/loop-resume.test.js` | 5 | `onEvent`×4, `onJudge`×1 | MIGRATE · S7c |
| `test/loop-callback-this.test.js` | 4 | `onToolResult`×1, `finalGuard`×1, `onDelta`×1, `onObserverError`×1 | MIGRATE · S7b（3）+ S7c（1） |
| `test/loop-v020-rc.test.js` | 4 | `onPersistenceError`×4 | MIGRATE · S7b |
| `test/tool-fact-success-parity.test.js` | 4 | `onEvent`×2, `onToolResult`×2 | MIGRATE · S7b |
| `test/loop-resume-unpersisted-tool-results.test.js` | 3 | `onEvent`×3 | MIGRATE · S7b |
| `test/loop-v020-beta.test.js` | 3 | `onDelta`×1, `onReasoningDelta`×1, `onEvent`×1 | MIGRATE · S7b |
| `test/output-aggregate-budget.test.js` | 3 | `onEvent`×3 | MIGRATE · S7b |
| `test/cli.test.js` | 2 | `finalGuard`×2 | OWNED-BY-S5 |
| `test/compact/provider-summarizer.test.js` | 2 | `onUsage`×2 | MIGRATE · S7b |
| `test/compaction-strategy-name.test.js` | 2 | `onEvent`×1, `onUsage`×1 | MIGRATE · S7c |
| `test/notes-candidates-and-scopes.test.js` | 2 | `finalGuard`×2 | MIGRATE · S7c |
| `test/notes-final-guard.test.js` | 2 | `finalGuard`×2 | OWNED-BY-S5 |
| `test/persistence-diagnostics.test.js` | 2 | `onPersistenceError`×1, `onEvent`×1 | MIGRATE · S7b |
| `test/providers/anthropic.test.js` | 2 | `onDelta`×2 | MIGRATE · S7b |
| `test/wrapup.test.js` | 2 | `finalGuard`×2 | MIGRATE · S7c |
| `test/app-container-p0.test.js` | 1 | `onRound`×1 | MIGRATE · S7b |
| `test/compaction-observability.test.js` | 1 | `onEvent`×1 | MIGRATE · S7b |
| `test/compaction-strategy-fallback.test.js` | 1 | `onEvent`×1 | MIGRATE · S7b |
| `test/integration/todo-builtin.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c |
| `test/judge-record.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c（S7a 遗留） |
| `test/loop-abort-terminal-priority.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c（S7a 遗留） |
| `test/loop-forced-final-by-state-475.test.js` | 1 | `onEvent`×1 | MIGRATE · S7b |
| `test/loop-governance-cells.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c（S7a 遗留） |
| `test/loop-invalid-arguments.test.js` | 1 | `onEvent`×1 | MIGRATE · S7b |
| `test/loop-pending-tool-result.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c |
| `test/loop-persist-engine-text.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c |
| `test/loop-termination.test.js` | 1 | `onEvent`×1 | MIGRATE · S7b |
| `test/loop.test.js` | 1 | `onToolResult`×1 | MIGRATE · 含 COMPAT-PIN 格 |
| `test/messages-identity.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c |
| `test/repl.test.js` | 1 | `finalGuard`×1 | OWNED-BY-S5 |
| `test/run-snapshot-executor.test.js` | 1 | `onToolResult`×1 | MIGRATE · S7b |
| `test/run-state.test.js` | 1 | `onRound`×1 | MIGRATE · S7b |
| `test/wrapup-normalization-unified.test.js` | 1 | `finalGuard`×1 | MIGRATE · S7c |


### 分派小结（按上表口径，迁移**后**实测）

**「写点」这一列的口径是「迁移后仍在树上的写点数」**，所以列和必须 = 合计 351（逐点只算一次）。

| 类 | 文件数 | 写点（迁移后仍在树上） |
| --- | --- | --- |
| `MIGRATE · S7a`（本刀已迁：**迁移前** 37 个写点，迁移后 **0**） | 7 | 0（迁移前 37，已不在树里） |
| `MIGRATE · S7a 遗留`（3 个 `finalGuard`；**已补进下行 S7c 的 90**，本行不重复计） | 3（⊂ 上行的 7） | 0（已计入 S7c） |
| `MIGRATE · S7b` | 24 | 123 |
| `MIGRATE · S7c`（含 S7a 遗留 3 + S7b 让出的 `loop-callback-this` 1） | 17 | 90 |
| `MIGRATE · 含 COMPAT-PIN 格`（迁搭台写点，**逐格**跳过选项面断言） | 3 | 38 |
| `COMPAT-PIN` | 6 | 66 |
| `OWNED-BY-S5` | 4 | 13 |
| `OWNED-BY-S6` | 5 | 21 |
| **合计（迁移后实测）** | **62** | **351** |

脚注：

* 写点列和 = `0 + 0 + 123 + 90 + 38 + 66 + 13 + 21 = 351`，与本列合计逐字相等。等价拆法（不含 S7a 两行）：
  `123 + 90 + 38 + 66 + 13 + 21 = 351`。
* S7a 那 **37** 是**迁移前**的数（迁移后已不在树里）⇒ 记 0、不进列和；把「37 已迁」和「迁移后剩余」混在
  同一列里会让列和变成 385（= 351 + 37 − 3），那是**列语义坏了**，不是数错了。
* S7a 遗留的 **3** 个 `finalGuard`（`judge-record` / `loop-abort-terminal-priority` / `loop-governance-cells`）
  已补进 S7c 清单 ⇒ 只在 S7c 的 90 里数**一次**。
* 文件数 **62** 是**去重后**的 `7 + 24 + 13 + 3 + 6 + 4 + 5`：S7c 的 17 里有 4 个是借来的（3 个来自 S7a 的 7、
  1 个 `loop-callback-this` 来自 S7b 的 24），所以把各行文件数直接相加得 69 是**交叉引用**不是漏计。
* 上表「分类」列是逐点归片的**唯一权威**：同一文件跨片时写 `MIGRATE · S7b（3）+ S7c（1）`，两片各数各的。
  核对命令（文末「复跑方法」第 3 条）会把这张小结与本表逐行对账，退出码非 0 就是列语义又坏了。

## S7b 清单（24 个文件 / **123** 个写点）

（AST 对这 24 个文件的能力面写点是 **124**；其中 `test/loop-callback-this.test.js` 的 `finalGuard`×1
让给 S7c ⇒ 本片 **123**。逐点只算一次，见上「分派小结」脚注。）

主题：**观察者通道与流式回调**（`onEvent` / `onObserverError` / `onPersistenceError` / `onDelta` /
`onReasoningDelta` / `onToolCall` / `onUsage` / `onToolResult` / `onRound`）。
冲突面：**不碰 `bin/`、不碰 `src/`**（全部是纯测试文件）；与 S5 的唯一重叠面是「S5 若顺手改
`src/providers/**` 的选项读法」——那会同时改 `test/providers/*` 的期望值，动之前先对表。
与 S6 无重叠（S6 的 5 个文件全在 `test/examples/`）。

| 文件 | 写点 | 明细 |
| --- | --- | --- |
| `test/loop-observer-isolation.test.js` | 33 | `onEvent`×6, `onObserverError`×15, `onRound`×3, `onToolResult`×4, `onDelta`×1, `onReasoningDelta`×1, `onToolCall`×1, `onUsage`×1, `onJudge`×1 |
| `test/model-metadata-diagnostics.test.js` | 15 | `onEvent`×13, `onObserverError`×2 |
| `test/loop-stream.test.js` | 11 | `onDelta`×7, `onUsage`×1, `onEvent`×1, `onObserverError`×2 |
| `test/loop-usage-accounting.test.js` | 8 | `onRound`×8 |
| `test/e2e/upstream.test.js` | 8 | `onDelta`×5, `onEvent`×1, `onUsage`×2 |
| `test/providers/v020-beta.test.js` | 8 | `onEvent`×2, `onReasoningDelta`×2, `onToolCall`×2, `onUsage`×2 |
| `test/providers/openai-stream.test.js` | 6 | `onDelta`×1, `onUsage`×1, `onEvent`×2, `onReasoningDelta`×2 |
| `test/loop-v020-rc.test.js` | 4 | `onPersistenceError`×4 |
| `test/tool-fact-success-parity.test.js` | 4 | `onEvent`×2, `onToolResult`×2 |
| `test/loop-callback-this.test.js` | 3 | `onToolResult`×1, `onDelta`×1, `onObserverError`×1 |
| `test/loop-resume-unpersisted-tool-results.test.js` | 3 | `onEvent`×3 |
| `test/output-aggregate-budget.test.js` | 3 | `onEvent`×3 |
| `test/loop-v020-beta.test.js` | 3 | `onDelta`×1, `onReasoningDelta`×1, `onEvent`×1 |
| `test/persistence-diagnostics.test.js` | 2 | `onPersistenceError`×1, `onEvent`×1 |
| `test/providers/anthropic.test.js` | 2 | `onDelta`×2 |
| `test/compact/provider-summarizer.test.js` | 2 | `onUsage`×2 |
| `test/run-state.test.js` | 1 | `onRound`×1 |
| `test/loop-invalid-arguments.test.js` | 1 | `onEvent`×1 |
| `test/compaction-strategy-fallback.test.js` | 1 | `onEvent`×1 |
| `test/app-container-p0.test.js` | 1 | `onRound`×1 |
| `test/compaction-observability.test.js` | 1 | `onEvent`×1 |
| `test/loop-termination.test.js` | 1 | `onEvent`×1 |
| `test/run-snapshot-executor.test.js` | 1 | `onToolResult`×1 |
| `test/loop-forced-final-by-state-475.test.js` | 1 | `onEvent`×1 |

⚠ `test/loop-callback-this.test.js` 的 `finalGuard`×1 属能力面**且已有规位**（`capabilities.hooks.finalGuard`）
⇒ 按母单裁决属 S9 的移除项、**必须迁**，只是**不归 S7b**：S7b 只迁 `this` 绑定的那三个回调，
`finalGuard` 那一格让给 S7c（一个旋钮只写一侧，别两边各改一次；本文件在 AST 上是 4 个写点 = 3 + 1）。

## S7c 清单（**17** 个纯 MIGRATE 文件 / **90** 个写点，+ 3 个含 COMPAT-PIN 格的文件 / 38 个写点）

这 17 个 = 原 13 个 + 4 个 `finalGuard` 写点所在文件（S7a 遗留 3 + S7b 让出 1）；
`finalGuard` 有规位（`capabilities.hooks.finalGuard`）⇒ 属 S9 的移除项，**必须继续迁**，不是可选清理。

主题：**强制收尾 / 交付物判据 / 折叠摘要**（`finalGuard` / `deliverables` / `onFoldSummary`）。
冲突面：**不碰 `bin/`、不碰 `src/`**；与 S5 的重叠面是 `finalGuard` 的**装配断言**（S5 已拿走
`test/cli.test.js` / `test/repl.test.js` / `test/host-cwd-wiring.test.js` / `test/notes-final-guard.test.js`
那 13 个写点）——S7c 动的是**行为**断言，两边按文件切开，不交叉。
与 S6 无重叠。

| 文件 | 写点 | 明细 |
| --- | --- | --- |
| `test/loop-guard-extend.test.js` | 26 | `finalGuard`×13, `onEvent`×13 |
| `test/loop-deliverables-outrank.test.js` | 25 | `deliverables`×1, `finalGuard`×22, `onEvent`×2 |
| `test/loop-final-guard.test.js` | 14 | `finalGuard`×10, `onEvent`×4 |
| `test/loop-resume.test.js` | 5 | `onEvent`×4, `onJudge`×1 |
| `test/loop-final-guard-payload.test.js` | 5 | `finalGuard`×5 |
| `test/compaction-strategy-name.test.js` | 2 | `onEvent`×1, `onUsage`×1 |
| `test/wrapup.test.js` | 2 | `finalGuard`×2 |
| `test/notes-candidates-and-scopes.test.js` | 2 | `finalGuard`×2 |
| `test/messages-identity.test.js` | 1 | `finalGuard`×1 |
| `test/loop-persist-engine-text.test.js` | 1 | `finalGuard`×1 |
| `test/integration/todo-builtin.test.js` | 1 | `finalGuard`×1 |
| `test/wrapup-normalization-unified.test.js` | 1 | `finalGuard`×1 |
| `test/loop-pending-tool-result.test.js` | 1 | `finalGuard`×1 |
| `test/loop-callback-this.test.js` | 1 | `finalGuard`×1（S7b 只迁 `this` 那三个回调，本格让给 S7c） |
| `test/judge-record.test.js` | 1 | `finalGuard`×1（S7a 遗留） |
| `test/loop-abort-terminal-priority.test.js` | 1 | `finalGuard`×1（S7a 遗留） |
| `test/loop-governance-cells.test.js` | 1 | `finalGuard`×1（S7a 遗留） |

含 COMPAT-PIN 格（**逐格**跳过选项面断言，其余照迁）：

| 文件 | 写点 | 明细 | 哪一格留扁平 |
| --- | --- | --- | --- |
| `test/loop-deliverables.test.js` | 24 | `finalGuard`×11, `onEvent`×2, `deliverables`×11 | `deliverables[0].check must be a function` 那一格（值形状钉） |
| `test/loop-on-fold-summary.test.js` | 13 | `onFoldSummary`×11, `onPersistenceError`×2 | `assembly policy option onFoldSummary must be a function (or omitted)` 那一格（#499 形状钉） |
| `test/loop.test.js` | 1 | `onToolResult`×1 | 「rejects unknown runToolLoop options with a close suggestion」那一格 |

## 附表：`finalGuard` / `deliverables` 之外的**壳内写点**（数据面，S9 不退役）

这些键的规范之家是 `config.*`（数据 ⇒ `config.*`），但**它们不在 S9 的 11 个退役键里**——扁平数据键
在 S9 之后仍然被接受（`config` 是加法，优先级是「容器赢扁平」）。所以迁它们是**可选的整洁**，不是
退役前置；本表只做清点，不做分派。理由（原先引「见报告『我不同意的点』」，那份报告不在仓库里，
内容搬到这里）：**数据键没有退役窗口**——S9 只砍 11 个回调键，`config.*` 是加法且「容器赢扁平」，
所以扁平数据键在 S9 之后仍然被接受；把它们也迁一遍是**整洁**，收益是少一条兼容路径，风险是要动
678 个写点。**结论：不在 0.28 路径上**，S9 不需要等它，另立单做。

计数口径与上表同（AST、数到被数的键就停、进了同名壳就停，于是 `context: { strategy }` 只算 `context` 一个）。
合计 **678**（= `node /tmp/flat-count.cjs .` 的第二个数；附表 95 行逐行相加也是 678）。

| 文件 | 写点 | 明细 |
| --- | --- | --- |
| `test/judge.test.js` | 60 | `reflection`×52, `initialMessages`×5, `context`×1, `resume`×2 |
| `test/loop-option-gate-496.test.js` | 45 | `tools`×3, `context`×31, `retry`×5, `reflection`×5, `sleepImpl`×1 |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | 44 | `tools`×2, `context`×13, `reflection`×6, `sleepImpl`×3, `judgeProvider`×3, `strategy`×3, `retry`×9, `initialMessages`×5 |
| `test/loop-resume.test.js` | 37 | `tools`×8, `resume`×23, `initialMessages`×1, `reflection`×3, `context`×2 |
| `test/cli.test.js` | 36 | `prompt`×28, `tools`×3, `context`×2, `reflection`×3 |
| `test/examples/erix-run-core.test.js` | 24 | `tools`×14, `strategy`×4, `reflection`×3, `context`×3 |
| `test/loop-resume-notice.test.js` | 20 | `tools`×9, `resume`×7, `reflection`×2, `context`×2 |
| `test/loop-guard-extend.test.js` | 17 | `reflection`×13, `resume`×1, `context`×3 |
| `test/messages-identity.test.js` | 17 | `strategy`×12, `tools`×2, `context`×3 |
| `test/loop-persist-engine-text.test.js` | 16 | `tools`×6, `reflection`×8, `resume`×2 |
| `test/judge-record.test.js` | 15 | `reflection`×13, `context`×2 |
| `test/loop-config-namespace-497.test.js` | 14 | `tools`×5, `initialMessages`×2, `resume`×2, `context`×2, `reflection`×1, `retry`×2 |
| `test/loop-resume-anchor.test.js` | 13 | `resume`×7, `tools`×6 |
| `test/loop-v020-rc.test.js` | 13 | `context`×10, `initialMessages`×2, `resume`×1 |
| `test/integration/memento-scenario.test.js` | 11 | `tools`×4, `reflection`×4, `context`×3 |
| `test/loop-fold-context-knobs-469.test.js` | 11 | `context`×3, `tools`×2, `strategy`×6 |
| `test/loop-request-user-invariant.test.js` | 11 | `initialMessages`×6, `tools`×3, `context`×1, `resume`×1 |
| `test/reflection.test.js` | 11 | `reflection`×10, `resume`×1 |
| `test/compaction-strategy-name.test.js` | 10 | `context`×2, `strategy`×8 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | 10 | `strategy`×1, `tools`×2, `context`×7 |
| `test/compact/resume-fold-trim.test.js` | 9 | `strategy`×5, `context`×1, `resume`×3 |
| `test/examples/erix-run-tool-list.test.js` | 9 | `tools`×7, `prompt`×2 |
| `test/cli-idle-retry.test.js` | 8 | `retry`×5, `prompt`×3 |
| `test/loop-capabilities-namespace-498.test.js` | 8 | `tools`×2, `retry`×3, `resume`×1, `reflection`×1, `context`×1 |
| `test/loop-option-normalization.test.js` | 8 | `tools`×5, `initialMessages`×1, `resume`×2 |
| `test/loop-on-fold-summary.test.js` | 7 | `tools`×3, `context`×4 |
| `test/loop-persist-compaction-facts.test.js` | 7 | `strategy`×1, `reflection`×3, `context`×2, `resume`×1 |
| `test/loop-resume-unpersisted-tool-results.test.js` | 7 | `resume`×6, `tools`×1 |
| `test/output-aggregate-budget.test.js` | 7 | `context`×4, `resume`×1, `reflection`×2 |
| `test/compact/folded-facts.test.js` | 6 | `reflection`×1, `context`×1, `strategy`×4 |
| `test/examples/erix-run-async.test.js` | 6 | `tools`×4, `strategy`×1, `context`×1 |
| `test/integration/no-todo-switch.test.js` | 6 | `prompt`×5, `tools`×1 |
| `test/loop-abort-terminal-priority.test.js` | 6 | `judgeProvider`×1, `reflection`×5 |
| `test/loop-fr2.test.js` | 6 | `retry`×3, `initialMessages`×1, `context`×2 |
| `test/run-state.test.js` | 6 | `resume`×3, `context`×3 |
| `test/cli-idle.test.js` | 5 | `prompt`×5 |
| `test/loop-resume-fold-immunity.test.js` | 5 | `tools`×2, `reflection`×2, `resume`×1 |
| `test/loop-resume-prior-seed-469.test.js` | 5 | `reflection`×2, `context`×2, `resume`×1 |
| `test/loop-stream.test.js` | 5 | `retry`×4, `resume`×1 |
| `test/loop-final-guard.test.js` | 4 | `reflection`×4 |
| `test/loop-governance-cells.test.js` | 4 | `resume`×1, `reflection`×3 |
| `test/loop-governance-switch-cells.test.js` | 4 | `reflection`×4 |
| `test/loop-intercept-count-cells.test.js` | 4 | `reflection`×3, `resume`×1 |
| `test/loop-invalid-arguments.test.js` | 4 | `tools`×3, `resume`×1 |
| `test/persistence-diagnostics.test.js` | 4 | `retry`×2, `reflection`×2 |
| `test/wrapup.test.js` | 4 | `initialMessages`×1, `reflection`×3 |
| `test/capture-honesty.test.js` | 3 | `prompt`×3 |
| `test/cli-process.test.js` | 3 | `prompt`×3 |
| `test/examples/erix-run-notes-lifecycle.test.js` | 3 | `tools`×3 |
| `test/loop-folded-facts-sliding-resume.test.js` | 3 | `strategy`×1, `tools`×1, `context`×1 |
| `test/loop-persistence-phase.test.js` | 3 | `tools`×1, `reflection`×1, `retry`×1 |
| `test/loop-usage-accounting.test.js` | 3 | `reflection`×2, `context`×1 |
| `test/loop.test.js` | 3 | `tools`×1, `reflection`×2 |
| `test/model-metadata-diagnostics.test.js` | 3 | `tools`×1, `context`×2 |
| `test/notes-final-guard.test.js` | 3 | `prompt`×3 |
| `test/tool-fact-success-parity.test.js` | 3 | `context`×1, `reflection`×1, `resume`×1 |
| `test/tools/notes.test.js` | 3 | `context`×3 |
| `test/compact/fold-archive.test.js` | 2 | `context`×2 |
| `test/compaction-strategy-fallback.test.js` | 2 | `context`×2 |
| `test/display/projection.test.js` | 2 | `reflection`×1, `context`×1 |
| `test/examples/erix-run-core.smoke.test.js` | 2 | `strategy`×2 |
| `test/examples/erix-run-details.test.js` | 2 | `strategy`×1, `reflection`×1 |
| `test/loop-fold-count-cells.test.js` | 2 | `context`×1, `resume`×1 |
| `test/loop-observer-isolation.test.js` | 2 | `context`×1, `reflection`×1 |
| `test/loop-run-state-cells.test.js` | 2 | `resume`×2 |
| `test/loop-v020-beta.test.js` | 2 | `retry`×2 |
| `test/loop-v020.test.js` | 2 | `initialMessages`×1, `context`×1 |
| `test/messages/anthropic.test.js` | 2 | `tools`×2 |
| `test/notes-candidates-and-scopes.test.js` | 2 | `prompt`×2 |
| `test/providers/anthropic.test.js` | 2 | `tools`×2 |
| `test/providers/openai-stream.test.js` | 2 | `tools`×2 |
| `test/providers/openai.test.js` | 2 | `tools`×2 |
| `test/repl.test.js` | 2 | `tools`×1, `prompt`×1 |
| `test/skills.test.js` | 2 | `tools`×2 |
| `test/tools.test.js` | 2 | `context`×2 |
| `test/app-container-p0.test.js` | 1 | `retry`×1 |
| `test/cli-idle-payload.test.js` | 1 | `prompt`×1 |
| `test/compaction-observability.test.js` | 1 | `context`×1 |
| `test/e2e/upstream.test.js` | 1 | `retry`×1 |
| `test/helpers/engine-fact-rows.js` | 1 | `strategy`×1 |
| `test/host-cwd-wiring.test.js` | 1 | `tools`×1 |
| `test/integration/todo-builtin.test.js` | 1 | `prompt`×1 |
| `test/loop-error-budget-cells.test.js` | 1 | `resume`×1 |
| `test/loop-judge-done-forced-final.test.js` | 1 | `reflection`×1 |
| `test/loop-message-rows-crash-matrix.test.js` | 1 | `tools`×1 |
| `test/loop-resume-summary-history.test.js` | 1 | `resume`×1 |
| `test/loop-run-loop-state-tdz.test.js` | 1 | `reflection`×1 |
| `test/loop-termination.test.js` | 1 | `reflection`×1 |
| `test/output-hygiene.test.js` | 1 | `resume`×1 |
| `test/provider-runner.test.js` | 1 | `context`×1 |
| `test/providers/error-classification.test.js` | 1 | `retry`×1 |
| `test/run-snapshot-executor.test.js` | 1 | `context`×1 |
| `test/tokens-estimate-hotpath.test.js` | 1 | `context`×1 |
| `test/wrapup-normalization-unified.test.js` | 1 | `reflection`×1 |
| `test/wrapup-protocol-observer.test.js` | 1 | `reflection`×1 |


## 复跑方法

数字是**一次性 AST 走查**的产物（口径逐字写在顶部「生成方式」里，规则五条）。走查脚本本身**没有随仓库
落盘**——#498 S7 的红线是「只改 `test/**`」，所以不往 `scripts/` 里加新工具；下面是**可直接跑**的版本
（粘到 `/tmp/flat-count.cjs`，在仓库根执行；`typescript` 在 `devDependencies` 里，`npm ci` 后就有）。

```bash
cat > /tmp/flat-count.cjs <<'SCRIPT'
#!/usr/bin/env node
/**
 * 扁平选项写点计数器 + 清点表核对器（#498 S7）。
 *
 * 用法（在仓库根跑；需要 `typescript`，仓库 devDependencies 里有）：
 *   node /tmp/flat-count.cjs .                      # 三个总数
 *   node /tmp/flat-count.cjs . --files              # 逐文件明细
 *   node /tmp/flat-count.cjs . --verify test/compat-pin-inventory.md   # 与本表逐行对账
 *   node /tmp/flat-count.cjs /tmp/base-498          # 迁移前基线（388 / 678）
 *
 * 口径（五条，缺一条数就对不上本表）：
 *   1. 走 <root>/test/**，跳过 <root>/test/contract/**（#498 S8 独占）；
 *   2. 只数属性写法（`PropertyAssignment` / `ShorthandPropertyAssignment`）的**名字**；
 *   3. **数到被数的键就停**，不再往它的值里走 —— 于是 `retry: { sleepImpl }` 只算 `retry` 一个，
 *      `onObserverError: (error, context) => seen.push({ error, context })` 里的 `context` 不算
 *      （「同名变量落进记录对象」的简写不是扁平写点）；
 *   4. `capabilities` / `config` 容器同样数到就停（容器里的同名叶子是规位写法，不是扁平写点）；
 *   5. `context` 同名壳也停（`context: foldContext({ onFoldSummary })` 只算 `context` 一个）。
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require(path.join(process.cwd(), "node_modules", "typescript"));

const RETIRED = [
  "onEvent", "onRound", "onJudge", "onToolResult", "onDelta", "onReasoningDelta",
  "onToolCall", "onUsage", "onObserverError", "onPersistenceError", "onFoldSummary",
];
const CAPABILITY_FACE = new Set([...RETIRED, "finalGuard", "deliverables"]);
const DATA_KEYS = new Set([
  "reflection", "tools", "context", "resume", "retry", "initialMessages", "prompt",
  "strategy", "sleepImpl", "judgeProvider",
]);
const ALL = new Set([...CAPABILITY_FACE, ...DATA_KEYS]);
const CONTAINERS = new Set(["capabilities", "config"]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function count(root) {
  const hits = [];
  for (const file of walk(path.join(root, "test"), [])) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel.startsWith("test/contract/")) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (n) => {
      if (!n) return;
      if (ts.isPropertyAssignment(n)) {
        const name = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : null;
        if (name && ALL.has(name)) hits.push({ file: rel, key: name });
        if (name && (CONTAINERS.has(name) || ALL.has(name))) return; // 规则 3 / 4 / 5
      } else if (ts.isShorthandPropertyAssignment(n)) {
        if (ALL.has(n.name.text)) hits.push({ file: rel, key: n.name.text });
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const per = new Map();
  for (const h of hits) {
    const cur = per.get(h.file) || { total: 0, cap: 0, data: 0, byKey: new Map() };
    cur.total += 1;
    if (CAPABILITY_FACE.has(h.key)) cur.cap += 1; else cur.data += 1;
    cur.byKey.set(h.key, (cur.byKey.get(h.key) || 0) + 1);
    per.set(h.file, cur);
  }
  return { hits, per };
}

function verify(root, mdPath) {
  const { per } = count(root);
  const lines = fs.readFileSync(mdPath, "utf8").split("\n");
  const bad = [];
  const mainRows = [];
  const appRows = [];
  const summary = [];
  let section = "";
  let inSummary = false;
  for (const line of lines) {
    if (line.startsWith("## ")) { section = line; inSummary = false; }
    if (line.startsWith("### 分派小结")) { inSummary = true; continue; }
    if (inSummary) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 5) continue;
      const files = (cells[2].match(/^\*?\*?(\d+)/) || [])[1];
      const points = (cells[3].match(/^\*?\*?(\d+)/) || [])[1];
      if (files === undefined || points === undefined) continue;
      summary.push({ label: cells[1].replace(/`/g, "").replace(/\*\*/g, ""), files: Number(files), points: Number(points) });
      continue;
    }
    const m = line.match(/^\| `(test\/[^`]+)` \| (\d+)（?[^|]*\| ?(.*)$/);
    if (!m) continue;
    const row = { file: m[1], claimed: Number(m[2]), tail: m[3] };
    if (section.startsWith("## 附表")) appRows.push(row);
    else if (section.startsWith("## MIGRATE（")) mainRows.push(row);
  }
  const astCap = (f) => (per.get(f)?.cap ?? 0);
  const astData = (f) => (per.get(f)?.data ?? 0);

  for (const row of mainRows) if (row.claimed !== astCap(row.file)) bad.push(`主表 ${row.file}：表 ${row.claimed} / AST ${astCap(row.file)}`);
  for (const row of appRows) if (row.claimed !== astData(row.file)) bad.push(`附表 ${row.file}：表 ${row.claimed} / AST ${astData(row.file)}`);
  const mainSum = mainRows.reduce((s, r) => s + r.claimed, 0);
  const appSum = appRows.reduce((s, r) => s + r.claimed, 0);
  const astMain = [...per.values()].reduce((s, v) => s + v.cap, 0);
  const astApp = [...per.values()].reduce((s, v) => s + v.data, 0);

  // 分组：主表「分类」列是唯一权威（同文件跨片时写 `S7b（3）+ S7c（1）` 逐点归片）
  const groups = new Map();
  const addTo = (g, n) => groups.set(g, (groups.get(g) || 0) + n);
  for (const row of mainRows) {
    const tail = row.tail;
    const split = [...tail.matchAll(/S7([abc])（(\d+)）/g)];
    if (split.length) { for (const s of split) addTo(`S7${s[1]}`, Number(s[2])); continue; }
    const plain = tail.match(/MIGRATE · S7([abc])/);
    if (plain) { addTo(`S7${plain[1]}`, row.claimed); continue; }
    if (/COMPAT-PIN 格/.test(tail)) { addTo("含 COMPAT-PIN 格", row.claimed); continue; }
    if (/COMPAT-PIN/.test(tail)) { addTo("COMPAT-PIN", row.claimed); continue; }
    if (/OWNED-BY-S5/.test(tail)) { addTo("OWNED-BY-S5", row.claimed); continue; }
    if (/OWNED-BY-S6/.test(tail)) { addTo("OWNED-BY-S6", row.claimed); continue; }
    addTo(`?${tail}`, row.claimed);
  }

  console.log(`主表 ${mainRows.length} 行：表合计 ${mainSum} / AST 合计 ${astMain}`);
  console.log(`附表 ${appRows.length} 行：表合计 ${appSum} / AST 合计 ${astApp}`);
  const groupNames = ["S7a", "S7b", "S7c", "含 COMPAT-PIN 格", "COMPAT-PIN", "OWNED-BY-S5", "OWNED-BY-S6"];
  for (const g of groupNames) console.log(`  ${g.padEnd(18)} 逐点归片合计 ${groups.get(g) ?? 0}`);
  const groupSum = [...groups.entries()].filter(([g]) => g !== "S7a").reduce((s, [, v]) => s + v, 0);
  console.log(`  非 S7a 合计 ${groupSum}（应 = 主表合计 ${mainSum}）`);
  if (summary.length) {
    console.log(`分派小结 ${summary.length} 行：`);
    const groupOf = (label) => {
      const m = label.match(/S7([abc])/);
      if (m) return `S7${m[1]}`;
      if (/含 COMPAT-PIN 格/.test(label)) return "含 COMPAT-PIN 格";
      if (/COMPAT-PIN/.test(label)) return "COMPAT-PIN";
      if (/OWNED-BY-S5/.test(label)) return "OWNED-BY-S5";
      if (/OWNED-BY-S6/.test(label)) return "OWNED-BY-S6";
      return null;
    };
    let sumPoints = 0;
    let totalPoints = null;
    for (const s of summary) {
      const g = groupOf(s.label);
      const isTotal = /合计/.test(s.label);
      if (isTotal) totalPoints = s.points;
      else sumPoints += s.points;
      const actual = isTotal ? astMain : (groups.get(g) ?? 0);
      const ok = s.points === actual;
      if (!ok) bad.push(`分派小结 ${s.label}：表 ${s.points} / 逐点归片 ${actual}`);
      console.log(`  表 ${s.label}：文件 ${s.files} / 写点 ${s.points}（逐点归片 ${actual}）${ok ? " ✅" : " ✗"}`);
    }
    if (totalPoints !== null && sumPoints !== totalPoints) {
      bad.push(`分派小结列和 ${sumPoints} ≠ 合计 ${totalPoints}`);
      console.log(`  列和 ${sumPoints} ≠ 合计 ${totalPoints} ✗`);
    } else if (totalPoints !== null) {
      console.log(`  列和 ${sumPoints} = 合计 ${totalPoints} ✅`);
    }
  }
  if (bad.length) { console.log("不一致："); for (const b of bad) console.log("  ✗ " + b); }
  else console.log("逐文件：0 处不一致");
  return bad.length;
}

function main() {
  const root = process.argv[2] || ".";
  const mode = process.argv[3] || "";
  const { hits, per } = count(root);
  if (mode === "--files") {
    const rows = [...per.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
    for (const [f, v] of rows) {
      const detail = [...v.byKey.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, c]) => `${k}×${c}`).join(", ");
      console.log(`${String(v.total).padStart(3)}  ${f}  |  ${detail}`);
    }
    console.log(`--- 文件数 ${rows.length}  写点合计 ${rows.reduce((s, [, v]) => s + v.total, 0)}`);
    return;
  }
  if (mode === "--verify") { process.exitCode = verify(root, process.argv[4]) === 0 ? 0 : 1; return; }
  const cap = hits.filter((h) => CAPABILITY_FACE.has(h.key)).length;
  const data = hits.filter((h) => DATA_KEYS.has(h.key)).length;
  console.log(`能力面 13 键（主表口径）：${cap}`);
  console.log(`数据面 10 键（附表口径）：${data}`);
  console.log(`全部写点：${hits.length}`);
}

main();
SCRIPT

# 1) 迁移后的三个总数（本表主表 351 / 附表 678 / 全部 1029）
node /tmp/flat-count.cjs .                       # ⇒ 能力面 13 键 351 / 数据面 10 键 678 / 全部 1029
node /tmp/flat-count.cjs . --files               # ⇒ 逐文件明细（103 行，与本表逐行零误差）

# 2) 迁移前基线（388 / 678 / 1066）：把 S7a 迁移前的树解到 /tmp/base-498
rm -rf /tmp/base-498 && mkdir -p /tmp/base-498 && git archive 0b2d858 test | tar -x -C /tmp/base-498
node /tmp/flat-count.cjs /tmp/base-498           # ⇒ 能力面 13 键 388 / 数据面 10 键 678 / 全部 1066
                                                 #    388 − 37（S7a 已迁）= 351 ✅

# 3) 与本表逐行对账（主表 53 行 + 附表 95 行 + 分派小结的加总式；不一致 ⇒ 退出码 1）
node /tmp/flat-count.cjs . --verify test/compat-pin-inventory.md; echo "EXIT=$?"   # ⇒ EXIT=0

# 4) 两个交叉核对的 grep（口径比 AST 宽：会数到注释与断言里的字样，所以数字只会 ≥ 本表）
#    COMPAT-PIN 记号命中（哪些文件「被测对象就是选项面」）
grep -rln 'config_override_conflict\|unknown capabilities\|is not accepted\|must be a function\|unknown runToolLoop option\|RUN_TOOL_LOOP_OPTION_NAMES\|CAPABILITY_\|CONFIG_' test --include='*.js' | grep -v '^test/contract/'
#    11 个退役键的**剩余**扁平写点（S7 每落一片，这个数字必须往下走）
grep -rc '^ *\(onEvent\|onRound\|onJudge\|onToolResult\|onDelta\|onReasoningDelta\|onToolCall\|onUsage\|onObserverError\|onPersistenceError\|onFoldSummary\) *:' test --include='*.js' | grep -v ':0$'

# 5) 基线计数（迁移前后都必须一致：本刀前后都是 2381 格 / 107 个 test 文件）
node --test 2>&1 | grep -E '^# (tests|pass|fail|skipped) '     # ⇒ 2381 / 2372 / 0 / 9
```

⚠ 第 5 条**不能**写成 `grep -c '^test(' test/*.test.js | awk …`：那条命令只数顶层文件里行首的 `test(`，
实测 **1221**，既漏掉缩进的格、也漏掉子目录（`test/**/**.test.js`），跑不出 2381。
