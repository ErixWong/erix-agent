<!-- doc-version: 0.20.0 -->
# 宿主升级指南：0.20.0

这本指南只写宿主**需要动手**的变更，共两族加一条：存储侧（T1/T2，issue #284 / #285——
落盘的 tool result 里的字段命名空间，以及随它一起发布的 CLI 退出码与打包事实）、中止侧
（issue #282 及其漏网补口 / #283——「停止」意味着什么、它留下了什么），外加一条被钉住的形态契约
（issue #220）。完整清单仍在 `CHANGELOG.md`；下面某一节没写到你的代码路径，那一节对你就是
空操作。

**想跳过这本指南之前，先把这句读完：落盘的 tool result 里的字段名字变了。** 协议字段与线
格式没变——`type` / `tool_use_id` / `content` / `is_error` 仍然由 Anthropic 与 OpenAI 转换器
放在原来的位置，`TranscriptStore` 的方法签名与 `RoundRecord` 的顶层形状也没动。变的是**存储
块内部的命名空间**：引擎事实从顶层搬进了 `erix.*`，你自己的扩展键从被摊平的顶层搬进了
`metadata.*`。选项名一个没改，方法签名一个没改。包仍然是零 npm 运行时依赖、纯 ESM、要求
Node 22。

## 1. 变更总览

| 变更 | 会被它绊到的宿主 | 节 |
| --- | --- | --- |
| 工具事实改住 `erix.*` / `metadata.*`；被摊平的顶层名字退役（T1/T2，issue #284 / #285） | 从 0.20.0 写出的结果块上读 `block.erixRound`、`block.duration`、`block.executionStatus`、`block.success`，或读自己被摊平到顶层的扩展键 | 2 |
| 旧记录保留一代的读兼容，且引擎命名空间优先 | 依赖顶层旧名字**已经消失**，或依赖两侧都在时顶层名字说话算数 | 3 |
| 终局裁决处 `aborted` 压过 `judge_done` 与 `final_guard_unverified`，凡是能走到终局的通路都算（issue #282 及其漏网补口） | 把「没抛异常、reason 是 `judge_done`」当成「这个 run 没被停过」的证据 | 4 |
| 被中止的 run 不为进行中的那一轮写 transcript 记录，且 `termination.partial` 说的是载荷而不是 store（issue #283，裁决 = β） | 从 transcript store 里读「部分结果」，或者看到被停掉的 run 最后一轮 0 条记录就去报 bug | 5 |
| `createFileTools().executeTool()` 的四种成功返回形态由随包契约套件钉住（issue #220） | 不会坏；宿主得到一个判别式，可以删掉自己那层猜形态的代码 | 6 |
| `TOOL_RESULT_CONTRACT` 补记 `erix.executionStatus` 的**存在条件**（issue #286 追加项）；引擎行为本身没变 | 只读了那份常量，就假设每个结果块都带 `erix.executionStatus` | 7 |
| 核验没执行时 `erix run` 退出码是 **4**（`verification.status === "skipped"`），且 `examples/` / `scripts/` 不在发布产物里 | CI 脚本只映射了 0/1/2/3，或者宿主从装好的包里 `require` 一条 `examples/` 下面的路径 | 8 |

## 2. 工具事实搬进 `erix.*` 与 `metadata.*`（T1/T2，issue #284 / #285）

`src/tool-fact.js` 里的 `buildToolResultFact()` 是 `tool_result` 块唯一的构造点，
`TOOL_RESULT_CONTRACT`（从包根导出）是「谁拥有哪个字段」唯一的真相陈述。到 0.20.0，
`legacyTopLevel` 入参与「把宿主那张 map 摊到顶层」这一步一起**删掉了**：引擎产出的块恰好
就是协议字段（`type` / `tool_use_id` / `content`，错误与中断结果再加 `is_error`）+
`metadata.*` + `erix.*`。

退役名单（`TOOL_RESULT_CONTRACT.legacy` 里就是这张表，随包契约套件也有一条哨兵——这些名字
再出现在顶层就红）：

| 退役的顶层名字 | 改读这个 |
| --- | --- |
| `erixRound` | `erix.round` |
| `duration` | `erix.durationMs` |
| `executionStatus` | `erix.executionStatus` |
| `success` | `erix.success` |
| `toolCallKey`（顶层从来没有过它，列出来是为了把五个字段说全） | `erix.toolCallKey` |
| 被摊平到顶层的任意宿主扩展键（`artifactStatus`、`path`……） | `metadata.<你的键>`，例如 `metadata.artifactStatus` |

五个引擎字段，一次说清：

| 字段 | 它是什么 |
| --- | --- |
| `erix.toolCallKey` | 一次被接受的调用的耐久身份（见下） |
| `erix.round` | 产出该结果的那一轮 |
| `erix.durationMs` | executor 耗时，只捕获一次（见下） |
| `erix.executionStatus` | **只在**两种特殊状态下存在——见第 7 节 |
| `erix.success` | 现在**无条件写**（`success !== false`，与退役前顶层 `success` 同一个表达式） |

**`erix.success` 一定在。** 退役之前它只在宿主或 `onToolResult` 钩子真的表过态时才写；顶层
那个键没了之后还按条件写，宿主就分不清「成功」与「没人表过态」，那正是 issue #234 那一类
误判。请把 `erix.success` 当成一个恒定存在的布尔值读。

**`erix.durationMs` 缺失意味着「不知道」，不是 0。** 它只覆盖一个区间——从「即将调用
executor」到「该 promise settle 或 reject」，捕获一次——并且刻意**不含** `onToolResult` 的
改写、输出卫生与单轮聚合预算。有三种状态**根本没有**这个字段：judge 拦截（调用从未执行）、
unsafe 重放被中止、executor 尚未 settle 就被中止。写 `?? 0` 等于把「我们不知道」渲染成「它
瞬间完成」。退役的顶层 `duration` 没这个性质：它只在一条路径上自洽，那也是在双写期内两个
数字可以合法不相等的原因。

**`erix.toolCallKey` 是跨通道的关联键。** 一次被接受的调用只分配一次键，从第一个可识别的
流式 `onToolCall` 片段一路带到 `tool_use` 块、`tool_result`、`onEvent` 载荷克隆，以及展示
投影。resume 与 run-snapshot 复放**沿用已落盘的值**；已经有身份的调用绝不重新生成。
`provider id` / `tool_use_id` 仍是协议配对键——引擎只读，永不改写。
`createDisplayProjection` 的 `toolCalls[]` 条目新增了 `toolCallKey` 与 `durationMs`，而 T1
之前写的记录上两者是**直接缺省、不被合成**。

**两个副作用，谁 owns 谁就看谁：**

- 你那些名为 `content` 或 `is_error` 的扩展键，过去能盖掉同名的协议字段（扁平 map 摊在最
  后面）。现在盖不动了：它们只存在于 `metadata.content` / `metadata.is_error`，协议字段赢。
  `metadata` 与 `erix` 是构造器独占的命名空间。（`type` / `tool_use_id` / `content` /
  `is_error` 仍然**没有**登记进 `TOOL_RESULT_CONTRACT.reserved.topLevelKeys`；要不要收紧是
  另一个决定。）
- 随包契约套件自己的断言也跟着搬了：`test/contract/execute-tool.js` 现在断言宿主扩展键住在
  `metadata.artifactStatus`，且顶层**不得**再出现它。拿旧形状断言去跑随包契约的宿主会看到
  红——那是本条变更，不是套件坏了。

**该做什么。** 在你的宿主里 grep 那五个退役名字，以及任何从结果块顶层读自己扩展键的地方，
全部改成读 `erix.*` / `metadata.*`（双写期内这就是向前兼容的读法）。你自己写结果块的话，
往 `metadata.*` 里写。字段归属的完整表格见
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)「工具事实与字段归属（issue #284
/ #285）」与「onEvent 工具事件字段清单（issue #284 / #285）」。

## 3. 读侧保留一代兼容

**本版本之前**写下的记录仍然带着退役的顶层名字，而引擎的每条读路径现在都是「引擎命名空间
优先，顶层只作为旧记录的回退」：TTL 请求视图折叠、展示投影、续跑复放（原样带回——既不重算
也不补写）、单轮聚合预算里「拦截不算输出」的排除项、judge 时间线与对话渲染、L0 客观事实，
以及 `hasSuccessfulToolResult`。你可以依赖的几条推论：

- 你在 0.19 写的、顶层只有 `erixRound` / `duration` / `executionStatus` 的记录，0.20 依然能
  正确读出来——回退是真的，由反向测试钉住；
- 两种拼法同时存在且取值不一致时，`erix.*` 赢。别去读顶层来「看引擎到底怎么想」；
- 只有**一代**，不是永远：回退是为已经在盘上的记录留的，所以现在就把读侧迁走，别再新增
  顶层读法。
- 跟着这次翻转一起消失的是一个静默错误：聚合预算过去靠 `block.executionStatus` 排除拦截
  输出，而那个键**从来没被写过**，于是「拦截不计入输出」实际上早就失效了。现在两侧都读，
  T1 双写期内写下的记录同样受保护。

## 4. 「停止」压过 round judge 与 finalGuard（issue #282 及其漏网补口）

本版本之前，终局的 `stop` 分支只从治理动作推导 `termination.reason`，全程不看
`signal.aborted`。两个后果，都是在 `test/loop-abort-terminal-priority.test.js` 的假
provider 脚手架上实测出来的：

- 在「最后一轮已经答完、end-turn judge 已返回」的窗口里点停止，run 会**正常返回**
  `{ termination: { reason: "judge_done" } }`——没有 `aborted`、没有 `partial`、没有
  `usage`、没有 `rounds`。宿主根本分不出「被停掉」与「跑完了」。
- 中止已经落下，引擎照旧发起 judge 的模型请求：单轮 run **2 次模型请求**，其中一次纯浪费。

现在这条优先级在终局裁决处收口一次：**`aborted` 压过 `judge_done` / `final_guard_*`。**
上面那个 run 改为在接住的对象上抛出

```
{ reason: "aborted", detail: "user stop", usage: {…}, rounds: 1, partial: true }
```

（`error.termination`，外加 issue #180 的 `error.usage` / `error.rounds` /
`error.finalText`）；而信号在 end-turn judge 本该启动时就已经中止的 run，只发 **1 次模型
请求**——judge 调用整次跳过，于是停止立刻生效，而不是等一个 LLM 往返。

issue #282 的漏网面 补上的是 #282 漏掉的两个窗口，而且是真实负载下宿主最常撞的那两个：judge 判
`done: false` 时选的是 **nudge**，它直接 `continue`，根本不进 `stop` 分支（于是循环又跑了
一轮主模型调用，最后把一个用户早已停掉的 run 报成 `max_rounds_cap`）；循环结束后的轮数预算
收尾整段落在循环的 `try`/`catch` **之外**，中止落在那段收尾里时，要么以裸 `AbortError`
抛出、连 `termination` 都没有，要么（如果中止落在你自己的 `finalGuard` 里）被报成
`max_rounds_cap`。现在两条都覆盖：

| 中止落点 | 引擎 | 你看到 |
| --- | --- | --- |
| judge 开始之前 | judge 调用跳过 | 少一次模型请求，立刻停 |
| judge 请求在飞期间 | judge 被打断 | `aborted` + issue #180 载荷 |
| judge 已返回，裁决为「停」 | reason 推导拒绝采纳 judge 结论 | `aborted` + `{usage, rounds, partial:true}`，绝不是 `judge_done` |
| judge 已返回，裁决为「继续」（nudge / extend） | 进下一轮之前先查轮数预算与信号 | `aborted` + 同一份载荷，绝不是 `max_rounds_cap`，且**不再发起模型请求** |
| 循环结束后的 forced final 调用期间 | 收尾已经并进同一条错误通路 | `aborted` 且**带着** issue #180 载荷（此前：一个没有 `termination` 的裸 `AbortError`） |
| `finalGuard` 执行期间 | 终局返回前再查一次信号 | `aborted`，绝不是 `final_guard_unverified` 或 `max_rounds_cap` |

**该做什么。** 如果你的宿主按 `termination.reason` 分流，无需改动——你现在收到的是本来就该
收到的那一行。如果它按「有没有抛异常」分流（「返回了就说明没被停」），那个假设才是 bug：
`aborted` 一直是抛错（issue #180），而本版本之后它还能从若干此前被改写的地方抛出来。请把
中止载荷留住——`partial: true` 意味着部分文本在 `error.finalText` 上，错误上的 usage 才是
这次停止的真实账单。关闭收尾这个窗口带来一处副作用：如果**你自己的**收尾回调
（`forceFinalizer`、`finalGuard`）抛错，它不再以裸异常冒出整次调用，而是变成一个
`reason: "failed"` 并带 `errorCode` 的终局——与本包对其他所有宿主回调错误的姿态一致。

## 5. 被停掉的 run 到底留下了什么（issue #283）

#283 的裁决是 **β：引擎不追溯补写一条 `interrupted` 轮记录**。轮次的提交点是
`appendRound` 成功；在那之前被打断的一轮既没有稳定轮键，也可能带着没有配对 `tool_result`
的 `tool_use` 块——那会让 transcript 在续跑契约上不可重放。

所以 `termination.partial: true` 指的是**错误上的那份载荷**，对 store 不作任何断言。每条
事实去真正持有它的渠道读——六行完整对照表在
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)「中止后事实的真相分布（issue
#283）」。简版：

| 你想要 | 去读 |
| --- | --- |
| 已经跑完的轮次 | transcript store（中止不碰已提交轮） |
| 中止轮里已经流出过的文本 | run-snapshot 渠道：`partialPersistence` + `stream: true`——**默认关，且是尽力而为**：只有已提交的部分文本，**不含 reasoning**，可能什么都没有，最多陈旧 `intervalMs` |
| 部分终稿文本 | `error.finalText`——唯一有保证的部分文本渠道 |
| 这次 run 花了多少 | `error.usage` / `error.rounds` |
| 最后一次 judge 裁决 | judge 记录渠道（`onJudge` / `judge.log`，issue #165） |

**该做什么。** 如果你的界面出现「点停止后助手回复整体消失」，修的地方在你这一侧边界：
渲染 `error.finalText`。只有当你确实还想要进行中那一轮**已提交的**部分文本时才打开
`partialPersistence`（并配 `stream: true`）——那是一份快照而不是保证，而且它永远不含
reasoning。不要为「最后一轮 0 条 `RoundRecord`」报持久化 bug——那是既定形状。

## 6. 工具结果形态自此被钉住（issue #220）

`createFileTools().executeTool()` 的成功返回值一直有四种不同的顶层形态。随包契约套件此前
只是**读**这些形态，现在它断言这些形态；包同时导出了一个判别式，让你能删掉自己那层猜形态
的代码：

| 工具 | 成功形态 | `classifyFileToolResult().kind` |
| --- | --- | --- |
| `readFile` | `string` | `text` |
| `edit` | `string` | `text` |
| `writeFile` | `number`（写入字节数） | `bytes` |
| `searchText` | `{ content, metadata }` | `content-metadata` |

```js
import { createFileTools, classifyFileToolResult } from "erix-agent/tools";

const result = await tools.executeTool("writeFile", { path: "a.txt", content: "" });
const fact = classifyFileToolResult(result);
switch (fact.kind) {
  case "text": render(fact.text); break;
  case "bytes": billBytes(fact.bytes); break;
  case "content-metadata": render(fact.text); account(fact.metadata); break;
  case "unknown": escalate({ tool: name, value: result }); break;
  default: assertNever(fact.kind); // 上游新增第五种形态时，在你的编译里当场红
}
```

`classifyFileToolResult` 从 `erix-agent/tools` 子路径导出（**不进包根**，ADR-005），返回
类型是按 `kind` 关联的判别联合，所以 `fact.bytes` 恰好在 `"bytes"` 那一支才是 `number`。
这一举消掉的两个坑都是真实宿主报上来的：`writeFile` 返回 `0` 是**成功**写入了空文件
（`if (!result)` 是错的），而光看 `typeof result === "string"` **不是**成败判据——错误结果
也是字符串（顶层形态与 `readFile` 一致）。完整规则清单见
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)「成功返回的四种顶层形态
（issue #220）」。

## 7. `erix.executionStatus` 只在特殊状态存在（issue #286 追加项）

一句话说清：**0.19 之前有宿主把顶层的 `executionStatus` 当成恒定存在来读 → 0.20.0 起它根本
不在顶层，而在 `erix.*` 里也只在两种特殊状态下存在（`intercepted` = 审计拦截、
`interrupted` = 续跑改写）。普通成功或失败的结果块上这个字段是缺席的（`undefined`）——不是
空串，也不是 `ok` 占位。**

| | 旧（0.19 的误读） | 新（现在钉住的事实） |
| --- | --- | --- |
| 位置 | 顶层 `executionStatus` | 只有 `erix.executionStatus`（被摊平的顶层键已退役，见第 2 节） |
| 存在性 | 当成「每个结果块都有」来读 | 有条件的：只有 `intercepted` / `interrupted` 两种特殊状态 |
| 机器可读的条件 | 哪里都没记 | `TOOL_RESULT_CONTRACT.engine.fields.executionStatus.writtenFor === "special states only"`，外加 `presentValues: ["intercepted", "interrupted"]`（`src/tool-fact.js`） |
| 断言写法 | 「有就查一下」 | `Object.hasOwn(block.erix, "executionStatus") === false`（随包 `toolResultEnvelopeContract` 在普通块上**无条件**断言其缺席） |

引擎行为这里没变——变的是常量面不再诱导错误的读法。如果你的宿主靠「status 存在」来表达
「这个块值得关注」，请改成拿值与那两种特殊状态比。

## 8. CLI 退出码 4，以及打包产物里没有什么

`erix run` 现在能区分「核验通过」与「核验压根没跑」（`bin/cli.js` 的
`exitCodeForVerification`）：

| 退出码 | 含义 |
| --- | --- |
| 0 | 跑完了，且核验接受了终稿 |
| 2 | `verification.status === "unverified"` |
| 3 | `verification.status === "error"` |
| **4** | `verification.status === "skipped"`——核验没执行（没有归档输出，或归档里没有可核验的值） |

只映射 0/1/2/3 的 CI 包装会把「没人真的检查过」当成成功，或者当成崩溃；把 4 这一支补上。

`package.json` 的 `files` 白名单发布 `src`、`bin`、`skills`、`docs` 与 `test/contract/*.js`
那几套契约——**`examples/` 与 `scripts/` 不在里面**，所以这两个目录里的任何东西都不在装好的
包里。`require` 或 `import` 一条 `examples/` 下面的路径（比如 `erix_run` 的进度格式化器）在
本仓里能跑，装完之后就会炸：把你需要的代码复制走，或者通过 `erix-agent/contract-tests` 跑
随包契约套件。

## 9. 升级自查

1. `grep -rn "erixRound\|\.duration\b\|executionStatus\|\.success\b\|toolCallKey" <你的宿主>`
   ——每个命中都必须读 `erix.round` / `erix.durationMs` / `erix.executionStatus` /
   `erix.success` / `erix.toolCallKey`，而不是顶层（第 2、3 节）。
2. `grep -rn "<你自己的扩展键>" <你的宿主>` ——你放在结果块上的键必须从 `metadata.*` 读，而
   `durationMs` 的缺席不得被塌缩成 `0`（第 2 节）。
3. `grep -rn "judge_done" <你的宿主>` ——每个命中都只能在 `signal.aborted` 未置位时才可达
   （issue #282 及其漏网补口，第 4 节）。
4. `grep -rn "partial" <你的宿主>` ——任何读 `termination.partial` 的地方，文本都要去
   `error.finalText` 读，而不是读 transcript store（issue #283，第 5 节）。
5. `grep -rn "typeof result\|String(result)\|\[object Object\]" <你的宿主>` ——用
   `classifyFileToolResult` 加穷尽 switch 取代手写形态处理（issue #220，第 6 节）。
6. `grep -rn "examples/" <你的宿主>` ——任何东西都不许依赖一个发布产物里没有的路径（第 8 节）。
7. 拿随包套件跑你自己的适配器（`erix-agent/contract-tests`）：`fileToolsContract` 现在含那
   四条形态断言，`toolResultEnvelopeContract` 现在会拒绝退役的顶层名字。

## 10. 没有变的部分

选项名一个没改，方法签名一个没改。`TranscriptStore` 的方法与 `RoundRecord` 的顶层形状没动，
两个协议转换器发上线的仍然一直是那一份字段（`type` / `tool_use_id` / `content`，错误或被中断
的结果再加 `is_error`）——`erix.*` 与 `metadata.*` 从不上 wire。`end_turn` 仍然是正常成功的
出口，未被停掉的 run 仍然能拿到 `judge_done`。对终局对象钉死 `deepEqual` 的宿主不需要改动，
除非它走到过「中止落在一次终局前的增值调用里」那条路径。本指南英文版：
[host-upgrade-guide-0.20.0.md](host-upgrade-guide-0.20.0.md)；契约本身在
[host-consumer-contract.md](host-consumer-contract.md)，其同步中文版是
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)。
