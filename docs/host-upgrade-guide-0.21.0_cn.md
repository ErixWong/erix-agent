# 宿主升级指南：0.21.0

这本指南覆盖 0.21.0 里宿主**能看见**的变更，共三处，**没有一处会打断调用点**：一处是只
会减少引擎自己造成的失败的缺陷修复（issue #305），一处是你可以选择采用的新公共入口
（issue #307），一处只会**减少**上游返回的 `400` 的请求形态守卫（issue #292）。第四项改动
（文档锚点纪律，issue #286）是仓库内部纪律，列在这里只为让你知道为什么没有为它写更多东西。
完整清单仍在 `CHANGELOG.md`；下面某一节没写到你的代码路径，那一节对你就是空操作。

**想跳过这本指南之前，先把这句读完：选项名一个没改，方法签名一个没改，导出一个没动。**
行为变了的两个函数都是宿主可见的小工具（`parseReflectionDecision`，`src/loop/reflection.js`），
外加一个全新的（`parseModelJson`，`src/text/parse-model-json.js`）；其余全是你在既有结构里
本来就会忽略的 additive 键。包仍然是零 npm 运行时依赖、纯 ESM、要求 Node 22。

## 1. 变更总览

| 变更 | 会被它绊到的宿主 | 节 |
| --- | --- | --- |
| `parseReflectionDecision` 不再把模型明确写下的布尔值翻向，返回体新增来源标记 `via`（`"json"` \| `"prose_fallback"`）（issue #305） | 对整个返回对象做深比较，或曾假设手写的 `{…}` 决策可能被翻反 | 2 |
| `parseModelJson` 从包根导出，成为「从模型文本里抠 JSON」的唯一入口（issue #307） | 不会坏；自带花括号扫描器的宿主多了一个可选替代 | 3 |
| 发给上游的请求视图始终保留一条真 user 轮，极小 `context.budgetTokens` 不再触发 `400 No user query found in messages`（issue #292） | 不会坏；以前会以 `failed` 收场的 run 现在能跑 | 4 |
| 宿主可读文档里的裸行号变成只降不升的棘轮，代码引用改成符号锚点（issue #286） | 不会坏——这是仓库内的文档纪律 | 5 |

## 2. 写下来的 `false` 不再以 `true` 回来（issue #305）

`parseReflectionDecision`（`src/loop/reflection.js`）从包根（`src/index.js`）导出，供自己
解析 reflection 回答的宿主使用，引擎内部也走它。它的抠取原先是贪婪的 `/\{[\s\S]*\}/`，于是
**尾话里的一对花括号**——散文中的一个 `{plan}` 占位符、```` ```json ```` 围栏后跟一句说明、
并列的两个顶层对象、外层未闭合——会让抠出来的一坨解析不了；`JSON.parse` 抛错后直接 fall
through 到关键词兜底，而**兜底跑在含 JSON 自身的整段文本上**：它匹配到的是键名，于是模型
明确写了 `"continue": false` 却回来 `continueFlag: true`，`progress` 一起丢掉。

现在抠取换成与 wrapup 解析器共用的**顶层平衡扫描**：`jsonCandidates`
（`src/text/json-candidates.js`）感知字符串与转义，只在括号深度归零处切候选，未闭合的外层
**什么都不产**。今天就是错的四种形状由此修好：issue 原形状、围栏 + 带括号尾话、并列两个顶层
对象、外层未闭合却包着一个完整的内层对象。

**返回对象多了一个键。** `via` 说明数值的来路：来自可解析的顶层对象是 `"json"`，来自对整段
文本做关键词匹配是 `"prose_fallback"`。在生成的声明里它是字面量联合
`"json" | "prose_fallback"`，不是 `string`，可以直接收窄。它只声明**来源**，不是 schema
结论：六个决策字段照旧全部可缺省，所以 `{"progress":3}` 仍是合法决策并留在 `"json"` 这一路。
唯一的刻意例外是顶层对象可解析却六个决策键一个都不含——什么都搬运不过来，按
`"prose_fallback"` 上报。

**要不要动作。** 不必。若你对整个决策对象做 `deepEqual`，把 `via` 加进断言；若想区分「模型用
JSON 回答了」与「我们从散文里猜的」，读 `via`，别再自己反推。两处邻近值**有意不变**：兜底里
`reason` 的截断仍是 UTF-16 码元的 `value.slice(0, 200)`（轮次 judge 的 `truncate`
（`src/reflection/judge.js`）按码点计数——统一会改一个你本来就能观察到的值）；
`parseJudgeDecision`（`src/reflection/judge.js`）仍从**每个** `{` 起扫一次，未闭合的外层照样
会交出它的内层残片。

## 3. 抠模型 JSON 只有一个入口（issue #307）

`parseModelJson`（`src/text/parse-model-json.js`）是新函数，从包根（`src/index.js`）导出。
它替本包那两个模型 JSON 解析器接管了四处「对对象到哪里结束各持一说」的自带扫描器。你不
欠它一次采用；但你的宿主若在做同一件事，就该用它。

```js
import { parseModelJson } from "erix-agent";

// parseModelJson(text, { topOnly = true, requireKeys = null } = {}) ->
//   { ok: true, value, via: "json", candidates } | { ok: false, error, candidates }
const hit = parseModelJson('reasoning {"done":true,"confidence":1} trailing prose');
if (hit.ok) {
  use(hit.value);          // 就是 JSON.parse 的产物；值校验仍归你
} else {
  // hit.error："no_candidate" | "unparsable" | "shape_mismatch"——而且这里没有 `value` 键
}
```

三条性质就是它存在的全部理由，并且三条都被随包契约套件（`engineApiContract`）钉住：

- **失败是三态**，因为三种成因需要三种不同反应（换个提示词重问 / 接受它这次没用 JSON
  回答 / 去要那个缺的字段）：`no_candidate`（扫描件什么都没产）、`unparsable`（有候选但每个
  `JSON.parse` 都抛，例 `{"a":,}`）、`shape_mismatch`（有候选解析成功，却没有一个满足
  `requireKeys`）。
- **失败结果里没有 `value` 键**——不是 `value: undefined`。写完 `if (!result.ok)` 你手里真的
  什么都没有，于是一次失败的解析不会被当成「模型回了个空对象」。
- **没有任何 repair。** 不补闭合括号、不删尾逗号、不改值。这就是
  [host-consumer-contract.md](host-consumer-contract.md) 里的「归一化器只许搬运」章程。

两档扫描，仍是一份文件：`topOnly` 缺省 `true`（只认括号深度归零的对象；未闭合的外层什么都不
产）。`topOnly: false` 从**每个** `{` 起扫一次，于是未闭合的外层会先交出内层残片——这一档
只是为了让 `parseJudgeDecision`（`src/reflection/judge.js`）**行为零变更**地共用这份扫描。
`requireKeys` 是键存在性的 any-of 判定，且从不在意值类型。`candidates` 恒为**完整**扫描结果
（含未胜出的），所以你可以在它之上跑自己那份更严的逐候选校验。

两处邻近实现刻意**没有**迁移，知道原因能省你一个缺陷单：`tryParseWrapupJson`
（`src/reflection/wrapup.js`）的门槛比键存在性更严且必须跳过并续试；L0 与 fold-summary 那两处
读取（`src/reflection/l0.js`、`src/compact/fold-statistical.js`）不属于同一类问题——前者取
引擎要求模型写的标签，后者读引擎自己写下的行并 fail-closed。

## 4. 极小的 token 额度不再把请求清空（issue #292）

`context.budgetTokens` 小到连一条消息都装不下时，压缩的 safety 层（`safeTruncateMessages`，
`src/loop/budget.js`）会从头删未保护的消息，可能把**唯一的 user 轮连同整个列表**一起删空。
真上游（OpenAI 兼容 relay）对此回 `400 invalid_request`——"No user query found in messages"——
于是小预算配置从「能跑」退化成「必然 `failed`」。

修法是不变量而不是调参：`ensureUserTurnView`（`src/loop/request-user-view.js`）在**视图定稿
处**执行——TTL 折叠与 run-state 追加之后、`request` 对象组装之前（`src/loop/provider-runner.js`，
一处守卫同时覆盖 `chat` 与 `chatStream`）——并在压缩结果写回持久消息列表之前再执行一次
（`src/loop/orchestrator.js`）。退让顺序是：视图本来就含一条真 user 轮就原样放行 → 否则从
**未折叠 / 未压缩**的源视图里保底保留**最新**一条 user 轮（连同它必需的 assistant 配对）→
否则放弃本次折叠、改用源视图 → 否则原样返回并把这一格记为不可回补。每一步都用
`validateMessages`（`src/messages/rounds.js`）验一遍，所以回补出来的视图不会带着孤儿
`tool_result` 或缺结果的 `tool_use`。尾部 pending `tool_use` 在放行格是被容忍的——那正是
`max_tokens` 续写与续跑留下的形状。

**要不要动作。** 不必。你会看到的变化：一个原本会抛 `400` 并以 `reason: "failed"` 收场的 run
现在能跑。若你钉着「小预算仍会压缩」，那条还在——守卫不是「预算小就整体不压缩」；健康预算下
压缩行为逐字不变（`compacted` 仍为真、`foldedRounds` 仍大于 0、`tokensAfter < tokensBefore`）。

**两个你可能会注意到的 additive 键，也可以完全无视。** 守卫真的生效那一次，该轮在
`compactionStats` 里的条目会带 `userTurnGuard`（`"preserved_latest_user_turn"` |
`"abandoned_fold"`，判别式是 `isUserTurnGuardAction`，`src/loop/request-user-view.js`）与
`userTurnGuardChannel`（`"chat"` | `"chatStream"` | `"persisted"`）。它们**只在真的发生了什么事
时才出现**——没用到守卫的 run 产出的键与升级前一字不差。`compactionStats` 是引擎内部的诊断
数据（见 [host-consumer-contract.md](host-consumer-contract.md) 的 transcript meta 表），不属于
展示投影，别在它上面搭 UI。

## 5. 文档锚点纪律（issue #286）——宿主无需动作

本包每一份宿主可读文档（README、契约、以及本系列每一份升级指南）从此遵守两条规则：代码引用
是**符号锚点**（`` `名字` `` 加上它所在的文件），门禁会拿真声明去解它；**裸行号**是只降不升的
棘轮。对你而言，这意味着本系列较早指南里残留的行号是其中最不可信的部分，而新写的符号锚点是
机器核对过的。这条不花你任何成本。

## 6. 升级自查

1. `grep -rn "parseReflectionDecision" <your host>` —— 若你对返回对象做断言，补上 `via`；
   若你曾自己反推「这到底是 JSON 还是散文」，改成读 `via`（第 2 节）。
2. `grep -rn "JSON.parse\|\\\\{\\[\\\\s\\\\S\\]" <your host>` —— 凡是你自己扫模型文本的地方都是
   `parseModelJson` 的候选；若你保留自己的扫描器，务必确认未闭合的外层不会把内层残片当成答案
   （第 3 节）。
3. `grep -rn "budgetTokens" <your host>` —— 小预算不再需要绕道；把你为「首个请求会 400 所以
   重试」加的绷带拆掉（第 4 节）。
4. `grep -rn "No user query found" <your host>` —— 这个错误串从此不再到达；若你的代码为它开了
   特例，分支留着，但别再指望它命中。
5. 拿随包契约套件跑你的适配器（`erix-agent/contract-tests`）：`engineApiContract` 现已覆盖
   `parseModelJson` 的三种失败态与「失败不带 `value` 键」。

## 7. 没有变的部分

选项名、方法签名、导出都没有被删除或改名；`runToolLoop` 的选项与 `TranscriptStore` 的方法
一字未动。`parseModelJson` 是 additive，`via` 是 additive，而 `#292` 那道守卫只会往一个本来
会被上游拒掉的视图里**加**消息。`end_turn` 仍是正常成功出口，终止原因集合也没变。本指南英文
原版：[host-upgrade-guide-0.21.0.md](host-upgrade-guide-0.21.0.md)；契约本身是
[host-consumer-contract.md](host-consumer-contract.md)，其中文同步版是
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)。
