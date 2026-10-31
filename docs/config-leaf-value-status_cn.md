# 配置叶子的「值类型 / 值域」现状表（issue #586）

> ⚠ **本表由探针生成，手改数字算伪造。** 生成器：`scripts/config-leaf-value-probe.mjs`
> 复现（一条命令重出全表）：`node scripts/config-leaf-value-probe.mjs`；
> 刷表（唯一合法姿势）：`node scripts/config-leaf-value-probe.mjs --sync docs/config-leaf-value-status.md docs/config-leaf-value-status_cn.md`；
> 验表（CI 阻塞步 `npm run check:config-leaf-values`）：`node scripts/config-leaf-value-probe.mjs --verify docs/config-leaf-value-status.md docs/config-leaf-value-status_cn.md`。

## 1. 探针口径（这张表到底测了什么）

**错值矩阵**：每个叶子逐字喂同一组 8 个值 —— `"8"`（字符串数字）、`"bogus"`（枚举式字符串）、`-1`（负数）、`0.5`（小数（小于一））、`true`（布尔）、`null`（null）、`[]`（数组）、`{}`（对象）。矩阵不假装知道「每个叶子的正确类型是什么」：每个格子只是「宿主可能写出来的一个值」，结局由引擎自己说。

⚠ 矩阵里**有些格子对某些叶子本来就是合法类型**（`true` 对布尔叶子、`{}` 对对象叶子、`"8"` / `"bogus"` 对字符串叶子、`[]` 对消息列表）。它们是**对照组**：证明探针不是把所有值都判红，读表时别把「合法值被接受」读成漏校验。

**场景**：一次两轮 run（第一轮 1 次工具调用，第二轮 end_turn），带一个内存 store（`createMemoryTranscriptStore`，不落盘），不触发折叠、不触发 judge。跑一次直连路线 `runToolLoop({ config })`，把 provider 收到的请求体、工具调用上下文、事件流与结果骨架做成**指纹**；指纹里易变的字段（工具调用键、耗时、闭包）折成占位符。

**八种结局**（代码 → 判据）：

- `G` — gate：`config` 名称/形状闸口当场拒（值规则 `CONFIG_LEAF_VALUE_RULES` 也在这一层）
- `V` — semantic：语义相拒（`assertSemanticOptionValues`）
- `S` — startup：进了 run，第一发请求之前就抛，且**判词点名了这个叶子**（引擎的取值校验）
- `C` — crash：进了 run，第一发请求之前就炸，但**判词不点名这个叶子**（引擎内部错误，宿主读不出该怎么改）
- `U` — use：第一发请求之后才抛（真·带到使用点）
- `A` — accepted+live：没抛，且本次 run 的指纹与基线不同（错值真的生效了）
- `·` — accepted+inert：没抛，且指纹与基线逐字相同（本场景里配了等于没配）
- `H` — hung：超过单格上限未结束

「拒在哪一层」由**栈帧**给出：第一个落在 `src/` 的帧，取**文件名 + 函数名**（不取行号——行号会被无关重构撞红，函数名只在语义变化时动）。「生效在哪」由**指纹差异的第一个路径**给出（`requests[0].temperature` 这种），所以「悄悄接受」不是形容词，是一个具体位置加一对值。

**边界（别把这张表读成它没有的东西）**：只测直连路线（装配口 `policy.config` 过的是**同一道**展开闸口，差异只在 `via` 标签，那条由 #496 的测试钉住）；`·` 只回答「**本场景里**没观察到差异」，不回答「这个值永远没有影响」——折叠、续跑、持久化、judge、强制收尾这些深分支各有各的触发条件，本表不覆盖。

## 2. 叶子账（实测，不抄任何数字）

**实测 43 叶 = 30 init / 13 call**，分 8 组；今天**已有值规则**的叶子 2 / 43：`config.run.stream`、`config.continuity.handoff`。

| 分组 | 叶数 | 叶子 |
| --- | --- | --- |
| `input` | 5 | `input.system` `input.cacheStablePrefix` `input.initialUserMessage` `input.messages` `input.wrapup` |
| `run` | 17 | `run.maxRounds` `run.maxTokenContinuations` `run.stallDetection` `run.completion` `run.replayPolicy` `run.invalidArguments` `run.partialPersistence` `run.persistence` `run.outputHygiene` `run.writeToolNames` `run.writeToolPathKeys` `run.resume` `run.stream` `run.reflection` `run.runId` `run.cwd` `run.parentRunId` |
| `tuning` | 4 | `tuning.maxTokens` `tuning.temperature` `tuning.topP` `tuning.cacheCapable` |
| `timing` | 3 | `timing.timeoutMs` `timing.deadlineMs` `timing.retry` |
| `folding` | 3 | `folding.context` `folding.toolResultTtl` `folding.toolResultFoldMinTokens` |
| `guard` | 3 | `guard.finalGuardMaxRetries` `guard.finalGuardTimeoutMs` `guard.finalGuardExtend` |
| `metadata` | 7 | `metadata.expert` `metadata.user` `metadata.task` `metadata.requestId` `metadata.toolContext` `metadata.model` `metadata.modelMetadata` |
| `continuity` | 1 | `continuity.handoff` |
| **合计** | **43** | **30 init / 13 call** |

⚠ 两件事别混进来：① `init` / `call` 这一列是 **#571 片1** 的产物（`CONFIG_LEAF_BINDING`），本单只把它当一列读出来，一个绑定都没新增或改动；② **「键名不存在」那道闸口**（#571 片1 已落地）**不是本单的产物**——表里 `G` 那几格是**值规则**（`CONFIG_LEAF_VALUE_RULES`，今天只有 `config.run.stream`（#538）与 `config.continuity.handoff`（#598）两条），键名闸口管的是「这个键存不存在」，本表测的是「这个值合不合法」。

本单**零行为变更**：`src/` 一个字节都没动，接受面没有收窄也没有放宽（裁定归维护者，见 §6）。

## 3. 现状矩阵（叶 × 错值）

行 = 叶子（`init` / `call` 归属来自 `CONFIG_LEAF_BINDING`），列 = 喂进去的错值，格 = 结局代码（图例见 §1）。

| 叶子 | 绑定 | `"8"` | `"bogus"` | `-1` | `0.5` | `true` | `null` | `[]` | `{}` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `config.input.system` | init | A | A | A | A | A | A | A | A |
| `config.input.cacheStablePrefix` | init | · | · | · | · | · | · | · | · |
| `config.input.initialUserMessage` | call | A | A | A | A | A | A | A | A |
| `config.input.messages` | call | C | C | C | C | C | C | A | C |
| `config.input.wrapup` | init | A | A | A | A | A | A | A | A |
| `config.run.maxRounds` | init | S | S | S | S | S | S | S | S |
| `config.run.maxTokenContinuations` | init | · | · | · | · | · | · | · | · |
| `config.run.stallDetection` | init | · | · | · | · | · | · | · | · |
| `config.run.completion` | init | A | A | A | A | A | A | A | A |
| `config.run.replayPolicy` | init | S | S | S | S | S | S | S | S |
| `config.run.invalidArguments` | init | S | S | S | S | S | S | S | S |
| `config.run.partialPersistence` | init | S | S | S | S | S | S | S | S |
| `config.run.persistence` | init | S | S | S | S | S | · | S | S |
| `config.run.outputHygiene` | init | S | S | S | S | S | S | S | · |
| `config.run.writeToolNames` | init | · | · | · | · | · | · | · | · |
| `config.run.writeToolPathKeys` | init | · | · | · | · | · | · | · | · |
| `config.run.resume` | call | · | · | · | · | · | · | · | · |
| `config.run.stream` | call | G | G | G | G | A | G | G | G |
| `config.run.reflection` | init | · | · | · | · | A | · | A | A |
| `config.run.runId` | call | A | A | A | A | A | A | A | A |
| `config.run.cwd` | init | · | · | S | S | S | S | S | S |
| `config.run.parentRunId` | call | A | A | A | A | A | A | A | A |
| `config.tuning.maxTokens` | init | A | A | A | A | A | A | A | A |
| `config.tuning.temperature` | init | A | A | A | A | A | A | A | A |
| `config.tuning.topP` | init | A | A | A | A | A | A | A | A |
| `config.tuning.cacheCapable` | init | · | · | · | · | · | · | · | · |
| `config.timing.timeoutMs` | init | · | · | · | A | · | · | · | · |
| `config.timing.deadlineMs` | init | · | · | · | A | · | · | · | · |
| `config.timing.retry` | init | · | · | · | · | · | · | A | A |
| `config.folding.context` | init | V | V | V | V | V | · | V | · |
| `config.folding.toolResultTtl` | init | · | · | · | · | · | · | · | · |
| `config.folding.toolResultFoldMinTokens` | init | · | · | · | A | · | · | · | · |
| `config.guard.finalGuardMaxRetries` | init | · | · | · | · | · | · | · | · |
| `config.guard.finalGuardTimeoutMs` | init | · | · | · | · | · | · | · | · |
| `config.guard.finalGuardExtend` | init | S | S | S | S | · | S | S | S |
| `config.metadata.expert` | call | A | A | A | A | A | A | A | A |
| `config.metadata.user` | call | A | A | A | A | A | A | A | A |
| `config.metadata.task` | call | A | A | A | A | A | A | A | A |
| `config.metadata.requestId` | call | A | A | A | A | A | A | A | A |
| `config.metadata.toolContext` | call | · | · | · | · | · | · | · | · |
| `config.metadata.model` | call | A | A | · | · | · | · | · | · |
| `config.metadata.modelMetadata` | call | A | A | · | · | · | · | · | · |
| `config.continuity.handoff` | init | G | G | G | G | G | G | G | G |

## 4. 结局计数（逐格实测）

| 代码 | 格数 | 判据 |
| --- | --- | --- |
| `G` | 15 | gate：`config` 名称/形状闸口当场拒（值规则 `CONFIG_LEAF_VALUE_RULES` 也在这一层） |
| `V` | 6 | semantic：语义相拒（`assertSemanticOptionValues`） |
| `S` | 59 | startup：进了 run，第一发请求之前就抛，且**判词点名了这个叶子**（引擎的取值校验） |
| `C` | 7 | crash：进了 run，第一发请求之前就炸，但**判词不点名这个叶子**（引擎内部错误，宿主读不出该怎么改） |
| `U` | 0 | use：第一发请求之后才抛（真·带到使用点） |
| `A` | 118 | accepted+live：没抛，且本次 run 的指纹与基线不同（错值真的生效了） |
| `·` | 139 | accepted+inert：没抛，且指纹与基线逐字相同（本场景里配了等于没配） |
| `H` | 0 | hung：超过单格上限未结束 |
| **合计** | **344** | 43 × 8 |

## 5. 逐格明细（非 inert 的每一格：拒在哪层 / 判词原文 / 生效在哪）

共 205 格（其余 139 格是 `·`，即本场景无可观察差异，不列）。判词是引擎的原话，逐字未改。

| 叶子 | 错值 | 结局 | 层 / 生效路径 | 判词原文 / 可观察差异 |
| --- | --- | --- | --- | --- |
| `config.input.system` | `"8"` | A | requests[0].system | requests[0].system: (absent) → {"content":"8","cacheBoundary":true} |
| `config.input.system` | `"bogus"` | A | requests[0].system | requests[0].system: (absent) → {"content":"bogus","cacheBoundary":true} |
| `config.input.system` | `-1` | A | requests[0].system | requests[0].system: (absent) → {"content":-1,"cacheBoundary":true} |
| `config.input.system` | `0.5` | A | requests[0].system | requests[0].system: (absent) → {"content":0.5,"cacheBoundary":true} |
| `config.input.system` | `true` | A | requests[0].system | requests[0].system: (absent) → {"content":true,"cacheBoundary":true} |
| `config.input.system` | `null` | A | requests[0].system | requests[0].system: (absent) → null |
| `config.input.system` | `[]` | A | requests[0].system | requests[0].system: (absent) → {"content":[],"cacheBoundary":true} |
| `config.input.system` | `{}` | A | requests[0].system | requests[0].system: (absent) → {"content":{},"cacheBoundary":true} |
| `config.input.initialUserMessage` | `"8"` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → "8" |
| `config.input.initialUserMessage` | `"bogus"` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → "bogus" |
| `config.input.initialUserMessage` | `-1` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → -1 |
| `config.input.initialUserMessage` | `0.5` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → 0.5 |
| `config.input.initialUserMessage` | `true` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → true |
| `config.input.initialUserMessage` | `null` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → null |
| `config.input.initialUserMessage` | `[]` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → [] |
| `config.input.initialUserMessage` | `{}` | A | requests[0].messages[0].content[0].text | requests[0].messages[0].content[0].text: "go" → {} |
| `config.input.messages` | `"8"` | C | orchestrator.js runToolLoop | TypeError: Invalid value used as weak map key |
| `config.input.messages` | `"bogus"` | C | orchestrator.js runToolLoop | TypeError: Invalid value used as weak map key |
| `config.input.messages` | `-1` | C | orchestrator.js runToolLoop | TypeError: initialMessages is not iterable |
| `config.input.messages` | `0.5` | C | orchestrator.js runToolLoop | TypeError: initialMessages is not iterable |
| `config.input.messages` | `true` | C | orchestrator.js runToolLoop | TypeError: initialMessages is not iterable |
| `config.input.messages` | `null` | C | orchestrator.js runToolLoop | TypeError: initialMessages is not iterable |
| `config.input.messages` | `[]` | A | requests[0].messages[0] | requests[0].messages[0]: {"role":"user","content":[{"type":"text","text":"go"}],"cacheBoundary":true} → (absent) |
| `config.input.messages` | `{}` | C | orchestrator.js runToolLoop | TypeError: initialMessages is not iterable |
| `config.input.wrapup` | `"8"` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.input.wrapup` | `"bogus"` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.input.wrapup` | `-1` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.input.wrapup` | `0.5` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.input.wrapup` | `true` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.input.wrapup` | `null` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.input.wrapup` | `[]` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.input.wrapup` | `{}` | A | requests[0].system | requests[0].system: (absent) → {"content":"任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：\n{\"done\":true,\"summary... |
| `config.run.maxRounds` | `"8"` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.maxRounds` | `"bogus"` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.maxRounds` | `-1` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.maxRounds` | `0.5` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.maxRounds` | `true` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.maxRounds` | `null` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.maxRounds` | `[]` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.maxRounds` | `{}` | S | orchestrator.js runToolLoop | TypeError: maxRounds must be a finite positive integer |
| `config.run.completion` | `"8"` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.completion` | `"bogus"` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.completion` | `-1` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.completion` | `0.5` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.completion` | `true` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.completion` | `null` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.completion` | `[]` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.completion` | `{}` | A | requests[2] | requests[2]: (absent) → {"messages":[{"role":"user","content":[{"type":"text","text":"go"}],"cacheBou... |
| `config.run.replayPolicy` | `"8"` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.replayPolicy` | `"bogus"` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.replayPolicy` | `-1` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.replayPolicy` | `0.5` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.replayPolicy` | `true` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.replayPolicy` | `null` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.replayPolicy` | `[]` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.replayPolicy` | `{}` | S | orchestrator.js runToolLoop | TypeError: replayPolicy must be "always-replay" or "per-tool-declaration" |
| `config.run.invalidArguments` | `"8"` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.invalidArguments` | `"bogus"` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.invalidArguments` | `-1` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.invalidArguments` | `0.5` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.invalidArguments` | `true` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.invalidArguments` | `null` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.invalidArguments` | `[]` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.invalidArguments` | `{}` | S | orchestrator.js runToolLoop | TypeError: invalidArguments must be "reject" or "execute" |
| `config.run.partialPersistence` | `"8"` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.partialPersistence` | `"bogus"` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.partialPersistence` | `-1` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.partialPersistence` | `0.5` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.partialPersistence` | `true` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.partialPersistence` | `null` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.partialPersistence` | `[]` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.partialPersistence` | `{}` | S | orchestrator.js runToolLoop | TypeError: partialPersistence requires stream: true |
| `config.run.persistence` | `"8"` | S | orchestrator.js runToolLoop | TypeError: persistence must be "none" or "required" |
| `config.run.persistence` | `"bogus"` | S | orchestrator.js runToolLoop | TypeError: persistence must be "none" or "required" |
| `config.run.persistence` | `-1` | S | orchestrator.js runToolLoop | TypeError: persistence must be "none" or "required" |
| `config.run.persistence` | `0.5` | S | orchestrator.js runToolLoop | TypeError: persistence must be "none" or "required" |
| `config.run.persistence` | `true` | S | orchestrator.js runToolLoop | TypeError: persistence must be "none" or "required" |
| `config.run.persistence` | `[]` | S | orchestrator.js runToolLoop | TypeError: persistence must be "none" or "required" |
| `config.run.persistence` | `{}` | S | orchestrator.js runToolLoop | TypeError: persistence must be "none" or "required" |
| `config.run.outputHygiene` | `"8"` | S | orchestrator.js runToolLoop | TypeError: outputHygiene must be false or an object like { limit: 4096 } |
| `config.run.outputHygiene` | `"bogus"` | S | orchestrator.js runToolLoop | TypeError: outputHygiene must be false or an object like { limit: 4096 } |
| `config.run.outputHygiene` | `-1` | S | orchestrator.js runToolLoop | TypeError: outputHygiene must be false or an object like { limit: 4096 } |
| `config.run.outputHygiene` | `0.5` | S | orchestrator.js runToolLoop | TypeError: outputHygiene must be false or an object like { limit: 4096 } |
| `config.run.outputHygiene` | `true` | S | orchestrator.js runToolLoop | TypeError: outputHygiene must be false or an object like { limit: 4096 } |
| `config.run.outputHygiene` | `null` | S | orchestrator.js runToolLoop | TypeError: outputHygiene must be false or an object like { limit: 4096 } |
| `config.run.outputHygiene` | `[]` | S | orchestrator.js runToolLoop | TypeError: outputHygiene must be false or an object like { limit: 4096 } |
| `config.run.stream` | `"8"` | G | config-namespace.js assertConfigNamespace | TypeError: config.run.stream must be a boolean (received: string) |
| `config.run.stream` | `"bogus"` | G | config-namespace.js assertConfigNamespace | TypeError: config.run.stream must be a boolean (received: string) |
| `config.run.stream` | `-1` | G | config-namespace.js assertConfigNamespace | TypeError: config.run.stream must be a boolean (received: number) |
| `config.run.stream` | `0.5` | G | config-namespace.js assertConfigNamespace | TypeError: config.run.stream must be a boolean (received: number) |
| `config.run.stream` | `true` | A | requests[0].onDelta | requests[0].onDelta: (absent) → "<function>" |
| `config.run.stream` | `null` | G | config-namespace.js assertConfigNamespace | TypeError: config.run.stream must be a boolean (received: null) |
| `config.run.stream` | `[]` | G | config-namespace.js assertConfigNamespace | TypeError: config.run.stream must be a boolean (received: array) |
| `config.run.stream` | `{}` | G | config-namespace.js assertConfigNamespace | TypeError: config.run.stream must be a boolean (received: object) |
| `config.run.reflection` | `true` | A | requests[2] | requests[2]: (absent) → {"system":"你是交付评审者，独立判断任务是否完成。只输出 JSON。","messages":[{"role":"user","content"... |
| `config.run.reflection` | `[]` | A | requests[2] | requests[2]: (absent) → {"system":"你是交付评审者，独立判断任务是否完成。只输出 JSON。","messages":[{"role":"user","content"... |
| `config.run.reflection` | `{}` | A | requests[2] | requests[2]: (absent) → {"system":"你是交付评审者，独立判断任务是否完成。只输出 JSON。","messages":[{"role":"user","content"... |
| `config.run.runId` | `"8"` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → "8" |
| `config.run.runId` | `"bogus"` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → "bogus" |
| `config.run.runId` | `-1` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → -1 |
| `config.run.runId` | `0.5` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → 0.5 |
| `config.run.runId` | `true` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → true |
| `config.run.runId` | `null` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → null |
| `config.run.runId` | `[]` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → [] |
| `config.run.runId` | `{}` | A | toolCalls[0].context.runId | toolCalls[0].context.runId: (absent) → {} |
| `config.run.cwd` | `-1` | S | orchestrator.js runToolLoop | TypeError: cwd must be a string |
| `config.run.cwd` | `0.5` | S | orchestrator.js runToolLoop | TypeError: cwd must be a string |
| `config.run.cwd` | `true` | S | orchestrator.js runToolLoop | TypeError: cwd must be a string |
| `config.run.cwd` | `null` | S | orchestrator.js runToolLoop | TypeError: cwd must be a string |
| `config.run.cwd` | `[]` | S | orchestrator.js runToolLoop | TypeError: cwd must be a string |
| `config.run.cwd` | `{}` | S | orchestrator.js runToolLoop | TypeError: cwd must be a string |
| `config.run.parentRunId` | `"8"` | A | events[0].parentRunId | events[0].parentRunId: (absent) → "8" |
| `config.run.parentRunId` | `"bogus"` | A | events[0].parentRunId | events[0].parentRunId: (absent) → "bogus" |
| `config.run.parentRunId` | `-1` | A | events[0].parentRunId | events[0].parentRunId: (absent) → -1 |
| `config.run.parentRunId` | `0.5` | A | events[0].parentRunId | events[0].parentRunId: (absent) → 0.5 |
| `config.run.parentRunId` | `true` | A | events[0].parentRunId | events[0].parentRunId: (absent) → true |
| `config.run.parentRunId` | `null` | A | events[0].parentRunId | events[0].parentRunId: (absent) → null |
| `config.run.parentRunId` | `[]` | A | events[0].parentRunId | events[0].parentRunId: (absent) → [] |
| `config.run.parentRunId` | `{}` | A | events[0].parentRunId | events[0].parentRunId: (absent) → {} |
| `config.tuning.maxTokens` | `"8"` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → "8" |
| `config.tuning.maxTokens` | `"bogus"` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → "bogus" |
| `config.tuning.maxTokens` | `-1` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → -1 |
| `config.tuning.maxTokens` | `0.5` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → 0.5 |
| `config.tuning.maxTokens` | `true` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → true |
| `config.tuning.maxTokens` | `null` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → null |
| `config.tuning.maxTokens` | `[]` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → [] |
| `config.tuning.maxTokens` | `{}` | A | requests[0].maxTokens | requests[0].maxTokens: (absent) → {} |
| `config.tuning.temperature` | `"8"` | A | requests[0].temperature | requests[0].temperature: (absent) → "8" |
| `config.tuning.temperature` | `"bogus"` | A | requests[0].temperature | requests[0].temperature: (absent) → "bogus" |
| `config.tuning.temperature` | `-1` | A | requests[0].temperature | requests[0].temperature: (absent) → -1 |
| `config.tuning.temperature` | `0.5` | A | requests[0].temperature | requests[0].temperature: (absent) → 0.5 |
| `config.tuning.temperature` | `true` | A | requests[0].temperature | requests[0].temperature: (absent) → true |
| `config.tuning.temperature` | `null` | A | requests[0].temperature | requests[0].temperature: (absent) → null |
| `config.tuning.temperature` | `[]` | A | requests[0].temperature | requests[0].temperature: (absent) → [] |
| `config.tuning.temperature` | `{}` | A | requests[0].temperature | requests[0].temperature: (absent) → {} |
| `config.tuning.topP` | `"8"` | A | requests[0].topP | requests[0].topP: (absent) → "8" |
| `config.tuning.topP` | `"bogus"` | A | requests[0].topP | requests[0].topP: (absent) → "bogus" |
| `config.tuning.topP` | `-1` | A | requests[0].topP | requests[0].topP: (absent) → -1 |
| `config.tuning.topP` | `0.5` | A | requests[0].topP | requests[0].topP: (absent) → 0.5 |
| `config.tuning.topP` | `true` | A | requests[0].topP | requests[0].topP: (absent) → true |
| `config.tuning.topP` | `null` | A | requests[0].topP | requests[0].topP: (absent) → null |
| `config.tuning.topP` | `[]` | A | requests[0].topP | requests[0].topP: (absent) → [] |
| `config.tuning.topP` | `{}` | A | requests[0].topP | requests[0].topP: (absent) → {} |
| `config.timing.timeoutMs` | `0.5` | A | requests[1].messages[2].cacheBoundary | requests[1].messages[2].cacheBoundary: true → (absent) |
| `config.timing.deadlineMs` | `0.5` | A | requests[1].messages[2].cacheBoundary | requests[1].messages[2].cacheBoundary: true → (absent) |
| `config.timing.retry` | `[]` | A | events[2].maxAttempts | events[2].maxAttempts: 1 → 3 |
| `config.timing.retry` | `{}` | A | events[2].maxAttempts | events[2].maxAttempts: 1 → 3 |
| `config.folding.context` | `"8"` | V | assembly-validators.js assertSemanticOptionValues | TypeError: context must be an object |
| `config.folding.context` | `"bogus"` | V | assembly-validators.js assertSemanticOptionValues | TypeError: context must be an object |
| `config.folding.context` | `-1` | V | assembly-validators.js assertSemanticOptionValues | TypeError: context must be an object |
| `config.folding.context` | `0.5` | V | assembly-validators.js assertSemanticOptionValues | TypeError: context must be an object |
| `config.folding.context` | `true` | V | assembly-validators.js assertSemanticOptionValues | TypeError: context must be an object |
| `config.folding.context` | `[]` | V | assembly-validators.js assertSemanticOptionValues | TypeError: context must be an object |
| `config.folding.toolResultFoldMinTokens` | `0.5` | A | requests[1].messages[2].content[0].content | requests[1].messages[2].content[0].content: "tool-output" → "tool-output\n【TTL 预警】此结果下一轮将折叠为句柄；若后续仍需，请现在用 note_take 记录要点" |
| `config.guard.finalGuardExtend` | `"8"` | S | orchestrator.js runToolLoop | TypeError: finalGuardExtend must be a boolean |
| `config.guard.finalGuardExtend` | `"bogus"` | S | orchestrator.js runToolLoop | TypeError: finalGuardExtend must be a boolean |
| `config.guard.finalGuardExtend` | `-1` | S | orchestrator.js runToolLoop | TypeError: finalGuardExtend must be a boolean |
| `config.guard.finalGuardExtend` | `0.5` | S | orchestrator.js runToolLoop | TypeError: finalGuardExtend must be a boolean |
| `config.guard.finalGuardExtend` | `null` | S | orchestrator.js runToolLoop | TypeError: finalGuardExtend must be a boolean |
| `config.guard.finalGuardExtend` | `[]` | S | orchestrator.js runToolLoop | TypeError: finalGuardExtend must be a boolean |
| `config.guard.finalGuardExtend` | `{}` | S | orchestrator.js runToolLoop | TypeError: finalGuardExtend must be a boolean |
| `config.metadata.expert` | `"8"` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → "8" |
| `config.metadata.expert` | `"bogus"` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → "bogus" |
| `config.metadata.expert` | `-1` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → -1 |
| `config.metadata.expert` | `0.5` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → 0.5 |
| `config.metadata.expert` | `true` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → true |
| `config.metadata.expert` | `null` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → null |
| `config.metadata.expert` | `[]` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → [] |
| `config.metadata.expert` | `{}` | A | toolCalls[0].context.expert | toolCalls[0].context.expert: (absent) → {} |
| `config.metadata.user` | `"8"` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → "8" |
| `config.metadata.user` | `"bogus"` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → "bogus" |
| `config.metadata.user` | `-1` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → -1 |
| `config.metadata.user` | `0.5` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → 0.5 |
| `config.metadata.user` | `true` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → true |
| `config.metadata.user` | `null` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → null |
| `config.metadata.user` | `[]` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → [] |
| `config.metadata.user` | `{}` | A | toolCalls[0].context.user | toolCalls[0].context.user: (absent) → {} |
| `config.metadata.task` | `"8"` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → "8" |
| `config.metadata.task` | `"bogus"` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → "bogus" |
| `config.metadata.task` | `-1` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → -1 |
| `config.metadata.task` | `0.5` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → 0.5 |
| `config.metadata.task` | `true` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → true |
| `config.metadata.task` | `null` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → null |
| `config.metadata.task` | `[]` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → [] |
| `config.metadata.task` | `{}` | A | toolCalls[0].context.task | toolCalls[0].context.task: (absent) → {} |
| `config.metadata.requestId` | `"8"` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → "8" |
| `config.metadata.requestId` | `"bogus"` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → "bogus" |
| `config.metadata.requestId` | `-1` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → -1 |
| `config.metadata.requestId` | `0.5` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → 0.5 |
| `config.metadata.requestId` | `true` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → true |
| `config.metadata.requestId` | `null` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → null |
| `config.metadata.requestId` | `[]` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → [] |
| `config.metadata.requestId` | `{}` | A | toolCalls[0].context.requestId | toolCalls[0].context.requestId: (absent) → {} |
| `config.metadata.model` | `"8"` | A | events[9].model | events[9].model: "fake-model" → "8" |
| `config.metadata.model` | `"bogus"` | A | events[9].model | events[9].model: "fake-model" → "bogus" |
| `config.metadata.modelMetadata` | `"8"` | A | events[9].model | events[9].model: "fake-model" → "8" |
| `config.metadata.modelMetadata` | `"bogus"` | A | events[9].model | events[9].model: "fake-model" → "bogus" |
| `config.continuity.handoff` | `"8"` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: string) |
| `config.continuity.handoff` | `"bogus"` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: string) |
| `config.continuity.handoff` | `-1` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: number) |
| `config.continuity.handoff` | `0.5` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: number) |
| `config.continuity.handoff` | `true` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: boolean) |
| `config.continuity.handoff` | `null` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: null) |
| `config.continuity.handoff` | `[]` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: array) |
| `config.continuity.handoff` | `{}` | G | config-namespace.js assertConfigNamespace | TypeError: config.continuity.handoff must be one of "off" / "prompt" / "prompt-and-fallback" (received: object) |

## 6. 裁定建议（本单不收窄任何接受面）

**本单一个字都没改行为。** 下面只是按这张表排出的候选，供维护者裁定「哪一条值得进下一个 breaking 版本」——每条收窄都是**收窄接受面** ⇒ 要记 Breaking，得有破坏预算才能做。

- ① 错值**真的生效**（`A`）的叶子 22 个：`config.input.system`、`config.input.initialUserMessage`、`config.input.messages`、`config.input.wrapup`、`config.run.completion`、`config.run.stream`、`config.run.reflection`、`config.run.runId`、`config.run.parentRunId`、`config.tuning.maxTokens`、`config.tuning.temperature`、`config.tuning.topP`、`config.timing.timeoutMs`、`config.timing.deadlineMs`、`config.timing.retry`、`config.folding.toolResultFoldMinTokens`、`config.metadata.expert`、`config.metadata.user`、`config.metadata.task`、`config.metadata.requestId`、`config.metadata.model`、`config.metadata.modelMetadata`——收窄它们改的是「宿主写错却照跑」的行为，影响面最大，也最容易在宿主侧炸出「以前能跑」；
- ② 错值炸成**不点名该叶子**的引擎错误（`C` / `U`）的叶子 1 个：`config.input.messages`——这些今天已经是硬失败，但判词不教宿主怎么改，补类型校验是**把错误提前并点名**，不改变「失败」这个事实；
- ③ 8 个错值**全部静默接受**（`·` 满格）的叶子 11 个：`config.input.cacheStablePrefix`、`config.run.maxTokenContinuations`、`config.run.stallDetection`、`config.run.writeToolNames`、`config.run.writeToolPathKeys`、`config.run.resume`、`config.tuning.cacheCapable`、`config.folding.toolResultTtl`、`config.guard.finalGuardMaxRetries`、`config.guard.finalGuardTimeoutMs`、`config.metadata.toolContext`——它们最像「配了等于没配」，但 `·` 只说明本场景没走到（见 §7），裁定前需要各自的深分支场景。

## 7. 残留风险 / 这张表不覆盖的东西

- **场景面**：一次两轮 run。折叠、续跑（`config.run.resume`）、持久化（`config.run.persistence`）、judge（`config.run.reflection`）、强制收尾（`config.guard.*`）与续接块（`config.continuity.handoff`）的深分支没有被触发，`·` 在这些叶子上只说明「本场景没走到」；
- **路线面**：只测直连路线。装配口 `policy.config` 与它共用同一道展开闸口（`expandConfigNamespace`），但那条路线上的 `via` 标签与构造期抛错次序不在本表内；
- **矩阵面**：8 个错值不是「全部错值」。每个叶子都可能有这张矩阵没喂到的错型（比如 `NaN`、形状对但语义错的对象）；
- **时间面（`config.timing.*`）**：小数那一格是 `0.5` 不是 `3.7` —— `3.7` / `1000.5` 落在治理层的「剩余预算 < 2×单轮耗时 ⇒ 收尾提示」阈值附近，同一格在一台忙机器上会在 `A` 与 `·` 之间抖动（实测 8 次里 2 次不同）；`0.5` 把剩余预算直接压成负值，判定不再依赖机器负载（实测 20 次 + 8 路并发同值）。读表时把这两行当「阈值附近的抖动被消掉了」，不是「时间叶子已经测全了」；
- **判词稳定性**：明细表记的是**今天的**判词原文。引擎改一句话就会让 `--verify` 红——那是**设计如此**（表是量出来的），刷表姿势是 `--sync`，不是手改。

