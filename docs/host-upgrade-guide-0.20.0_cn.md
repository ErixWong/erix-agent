# 宿主升级指南：0.20.0

本指南只讲 0.20.0 里宿主**需要动作**的变更：三个发版阻断项，主题都是「一次被停止的 run
到底意味着什么」与「一个工具结果长什么样」（issue #282、issue #283、issue #220）。
`CHANGELOG.md` 仍是完整清单；下面某一节描述的不是你的代码路径，那一节对你就是 no-op。

本次没有改动任何选项名、方法签名或存储格式。三项变更里有两项能在终局上观察到，一项能在
工具结果上观察到。包仍然零 npm 运行时依赖、纯 ESM、要求 Node 22。

## 1. 变更总览

| 变更 | 会打破哪种宿主 | 小节 |
| --- | --- | --- |
| 终局裁决处 `aborted` 现在压过 `judge_done` 与 `final_guard_unverified`（issue #282） | 把「没抛异常、reason 是 `judge_done`」当成「这次 run 没被停止」的证据 | 2 |
| 被中止的 run **不会**为进行中的那一轮写任何 transcript 记录，且 `termination.partial` 说的是载荷而不是 store（issue #283，裁决 = β） | 从 transcript store 里读「部分结果」，或看到被停掉的 run 最后一轮 0 条记录就报 bug | 3 |
| `createFileTools().executeTool()` 的四种成功返回形态被随包契约套件钉住（issue #220） | 没有东西被打破；宿主拿到一个判别式，得以删掉自己那层猜形态的代码 | 4 |

## 2. 「停止」压过 end-turn judge 与 finalGuard（issue #282）

此前终局 `stop` 分支的 reason 只由治理动作推导，全程不看 `signal.aborted`。两个后果，
都在 `test/loop-abort-terminal-priority.test.js` 的假 provider 脚手架上实测过：

- 在「最后一轮已回答完、end-turn judge 已返回」的窗口里点停止，run **正常返回**
  `{ termination: { reason: "judge_done" } }`——没有 `aborted`、没有 `partial`、没有
  `usage`、没有 `rounds`。宿主根本无法区分「被停止」与「跑完了」。
- 即使中止早已置位，引擎照样发起 judge 那次模型请求：一个单轮 run 花掉 **2 次模型请求**，
  其中一次纯属白烧。

现在优先级规则在终局判定处收口一次：**`aborted` 永远优先于 `judge_done` / `final_guard_*`**。
上面那个 run 改为抛出，错误上的 `error.termination` 是

```
{ reason: "aborted", detail: "user stop", usage: {…}, rounds: 1, partial: true }
```

并同时带 `error.usage` / `error.rounds` / `error.finalText`（issue #180）；而中止若发生在
end-turn judge 将要发起之前，整个 run 只发 **1 次模型请求**——judge 被整次跳过，停止立即
生效，不再等一次 LLM 往返。

**该做什么。** 如果你的宿主按 `termination.reason` 分支，无需改动——你只是终于收到了本该
收到的那一行。如果它按「有没有抛异常」分支（「返回了，所以没被停」），那个假设才是 bug：
`aborted` 从一开始就是抛错（issue #180），而这次连它原先被改写的几条路径也一并收口。
务必接住载荷——`partial: true` 意味着部分文本在 `error.finalText` 上，错误上的 usage
就是这次被停掉的 run 的真实账单。

两个「终局前增值调用」在中止时的行为，一张表（完整版见
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)「终局前的增值调用在中止时的
行为（issue #282）」）：

| 中止落点 | 引擎 | 宿主看到 |
| --- | --- | --- |
| judge 发起之前 | judge 调用整次跳过 | 少一次模型请求，停止即时生效 |
| judge 请求在飞期间 | judge 被中断 | `aborted` + issue #180 载荷 |
| judge 已返回之后 | 终局拒绝采纳 judge 的结论 | `aborted` + `{usage, rounds, partial:true}`，绝不是 `judge_done` |
| finalGuard 执行期间 | 终局返回前再查一次信号 | `aborted`，绝不是 `final_guard_unverified` |

## 3. 被停掉的 run 到底留下了什么（issue #283）

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
| 中止轮里已经流出过的文本 | run-snapshot 渠道：`partialPersistence` + `stream: true`——**默认关** |
| 部分终稿文本 | `error.finalText` |
| 这次 run 花了多少 | `error.usage` / `error.rounds` |
| 最后一次 judge 裁决 | judge 记录渠道（`onJudge` / `judge.log`，issue #165） |

**该做什么。** 如果你的界面出现「点停止后助手回复整体消失」，修的地方在你这一侧边界：
渲染 `error.finalText`；若你要的是进行中那一轮的部分文本而非终稿，就打开
`partialPersistence`（并配 `stream: true`）。不要为「最后一轮 0 条 `RoundRecord`」报持久化
bug——那是既定形状。

## 4. 工具结果形态自此被钉住（issue #220）

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

这一举消掉的两个坑都是真实宿主报上来的：`writeFile` 返回 `0` 是**成功**写入了空文件
（`if (!result)` 是错的），而光看 `typeof result === "string"` **不是**成败判据——错误结果
也是字符串（顶层形态与 `readFile` 一致）。完整规则清单见
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)「成功返回的四种顶层形态
（issue #220）」。

## 5. 升级自查

1. `grep -rn "judge_done" <你的宿主>`——每一处命中都必须只在 `signal.aborted` 未置位时才可达
   （issue #282）。
2. `grep -rn "partial" <你的宿主>`——凡读 `termination.partial` 之处，文本都要改读
   `error.finalText`，而不是 transcript store（issue #283）。
3. `grep -rn "typeof result\|String(result)\|\[object Object\]" <你的宿主>`——把临时的形态
   收敛换成 `classifyFileToolResult` + 穷尽 switch（issue #220）。
4. 用随包套件跑一遍你的适配器（`erix-agent/contract-tests`）；`fileToolsContract` 里现在
   含那四条形态断言。

## 6. 没有变的部分

没有选项或方法签名搬家；没有存储格式搬家；`end_turn` 仍是正常成功出口，未被停止的 run 照旧
能拿到 `judge_done`。对终局对象做精确 `deepEqual` 的宿主不需要改动，除非它恰好走到了「judge
窗口内中止」那条路径。本指南英文版：
[host-upgrade-guide-0.20.0.md](host-upgrade-guide-0.20.0.md)；契约本体见
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)，其英文真相版是
[host-consumer-contract.md](host-consumer-contract.md)。
