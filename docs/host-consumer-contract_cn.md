# 宿主消费者契约

> English version: [host-consumer-contract.md](host-consumer-contract.md)

本文件定义 `erix-agent` 的宿主集成边界。引擎维护可审计的运行事实；宿主负责工具权限、
归档策略、重试/重跑策略以及最终消费决策。责任边界见
[ADR-012](decisions/012-engine-truth-model-efficiency-host-policy_cn.md) 和
[ADR-013](decisions/013-guard-charter_cn.md)。

## `runToolLoop` 选项与工具执行契约

`runToolLoop` 只接受已登记的顶层选项；未知键会抛出 `TypeError`。宿主私有元数据应放在
`toolContext`/`context` 中。`executeTool` 没有位置参数协商，循环始终以一个对象调用：

```js
executeTool({ id, name, input, context, signal })
```

三种规范返回形态是 `string`、`{ content, metadata?, success? }` 和 `Error`。旧的
`{ data, success, ... }` 及其他 duck-typed 形状仍会为兼容性宽容归一化，但已弃用，不应依赖。
0.6.0 的破坏性变更和迁移示例见
[host-upgrade-guide-0.6.0.md](host-upgrade-guide-0.6.0.md)。

## 终答核验

宿主消费 `runToolLoop` 结果前，必须检查 `verification.status`：

| 状态 | 契约 |
|---|---|
| `verified` | loop 用于表示由已配置 guard 接受的终答的唯一状态。 |
| `skipped` | 没有可供 guard 比较的内容，或 guard 未启用。**这不表示答案正确**，不得改写为 `verified`。 |
| `unverified` | 未满足所需的来源核验。CLI 退出码为 2；宿主不得将该结果作为成功结果消费。 |
| `error` | guard 抛出异常、返回无效决策或超时。CLI 退出码为 3；宿主不得将该结果作为已核验事实消费。 |

`finalGuard` 在 `runToolLoop` 和 CLI 中均为 opt-in。在 `runToolLoop` 中省略它会产生
`status: "skipped"` 和 `reason: "no_final_guard"`。CLI 通过 `--final-guard` 或
`ERIX_FINAL_GUARD=1` 启用；默认禁用，`--no-final-guard` 是兼容性 no-op。
默认 `finalGuardTimeoutMs` 为 30000；非正值使用该默认值。上述核验退出码仅描述核验结果；
普通的 provider、工具或 loop 失败遵循正常失败路径。

在因 `end_turn`、`no_tool`、`judge_done`、`max_rounds_cap`、`stall`、
`continuation_exhausted` 或 `reflection_stop` 停止前，loop 会调用已配置的 guard。
guard 会收到 `finalText`、`messages`、`round`、`rounds`、`signal` 和 `termination`，
以及当前的 `rerunDetected` 值。`{ action: "accept" }` 允许正常终止。
`{ action: "skip", reason }` 以 `skipped` 终止。`{ action: "revise", message }`
决策会作为独立的 user 文本消息注入，loop 随后继续，最多进行
`finalGuardMaxRetries` 次修订重试（默认 2 次）。如果达到上限时仍需要修订，loop
保留最后的 `finalText`，将 `verification.status` 设为 `unverified`，并以
`termination.reason === "final_guard_unverified"` 终止（fail-closed）。

不可继续的停止原因 `max_rounds_cap`、`stall`、`continuation_exhausted` 和
`reflection_stop` 不会仅因 guard 返回 `accept` 就变为 verified；它们会降级为
`final_guard_unverified`。guard 异常、无效决策或超时对于 loop 可用性是 fail-open：
原始终止原因会保留，但 `verification.status` 为 `error`，结果绝不会是 `verified`。
每个 guard 结果都会发出一个 `onEvent` 事件，`type: "final_guard"`，其 `action` 为
`accept`、`skip`、`revise`、`degraded` 或 `error` 之一。带有 `rerunCited: true`
的已接受决策仍为 `verified`，但会单独计入 `verification.metrics.rerun_cited`。
当 store 提供 `markRunState` 时，未核验结果的终态为 `unverified_error`，guard
错误的终态为 `guard_error`，其他情况为 `succeeded`。

引擎没有单独的“交付认证”或“完成认证”层。它报告轮次、工具、文件调用、归档、
终止和核验等事实。任务是否完成、交付物是否满足要求，以及是否可以自动进入下游，
仍由宿主、测试系统或人工审核决定。

### CLI 侧来源 guard

`bin/final-guard.js` 中的 CLI guard 是确定性的来源检查器，而不是任务完成度评估器。
它只考虑 `archiveDir` 下能够核验为 `kind: "erix.tool-capture"` 且具有
`schemaVersion: 1`、位于运行归档根目录内的匹配归档路径、普通的非符号链接归档文件、
`replayable: false`、`truncated: false`、64 字符十六进制 `digest`、有效 `locator`
以及与归档字节匹配的 digest 的 capture manifest。可重放 artifact 以及可重放性未知的
artifact 不会成为可信 capture 值。缺失、伪造、越界、截断或 digest 不匹配的 capture
无法建立核验。

没有 capture manifest 时返回 `action: "skip"` 和 `reason: "no_capture_manifest"`。
可读 artifact 但没有可提取候选值时返回 `action: "skip"` 和
`reason: "no_extractable_candidates"`。没有可比较的显式标签的终答返回
`action: "skip"` 和 `reason: "no_comparable_label"`。显式归因会与 capture 的值比较。
首次 capture 中的值可以直接接受；后续重跑中的值需要显式来源引用，例如
`来源=note_read:<key>` 或 `来源=归档:<file>`，并返回
`{ action: "accept", rerunCited: true }`。guard 不添加自然语言推断、关键词猜测或
相似度规则。跳过检查仍不等于 `verified`。

## 有界 recall

使用 store API 的对象形式进行精确、有界的取回。每个上限都必须在 store 源头强制执行：

```js
const page = await store.recall({
  runId,
  fromRound,
  toRound,
  pattern,
  artifactRef,
  limit,
  maxBytes,
  cursor,
});
```

对象形式请求字段为 `runId`、`fromRound`、`toRound`、`pattern`、`artifactRef`、
`limit`、`maxBytes` 和 `cursor`。`fromRound` 和 `toRound` 是非负整数边界；
`pattern` 是可选的子串过滤器。`artifactRef` 可以通过字符串身份，或
`artifactId`、`id`、`archivePath`、`digest` 等字段标识一个精确 artifact。
`limit` 和 `maxBytes` 是可选上限；`limit: 0` 和 `maxBytes: 0` 会以
`status: "error"` 被拒绝，且不返回 cursor。旧的
`store.recall(runId, fromRound, toRound, pattern)` 位置参数形式仍是独立的字符串返回
接口，不提供有界分页状态或 cursor。

`cursor` 是不透明值。不得解析、拼接、编辑，也不得跨不同的 `runId`、范围、
`pattern`、`limit`、`maxBytes`、`artifactRef` 或 source version 复用。它绑定上述
所有值以及 cursor 版本 `v` 和 `sig`。签名是规范化载荷的 SHA-256 digest，截取为
16 个十六进制字符。调用方不得依赖或修改编码、字段布局或载荷。格式错误或为空的
cursor、无效的 base64url、非 JSON 载荷、缺失字段、未知版本或签名失败都会返回
`status: "cursor_mismatch"`、空的 `text` 且没有新的 cursor。实现不得静默从头开始
或跳过内容。source version 或绑定请求不再匹配的有效 cursor 会返回
`status: "stale"`，同样没有可消费的文本。`cursor_mismatch` 和 `stale` 都必须丢弃，
不得消费。

结果是包含 `text`、`truncated` 和 `status` 的对象；有更多有界内容时包含
`nextCursor`，适用时包含 `error`。`truncated` 要求调用方使用返回的 `nextCursor`
继续；单个有界页面不是完整归档。取回按 UTF-8 字节切片且不会拆分代码点，因此继续
取回可以重新组装片段，不会重复或遗漏片段字节。file store 对单条 JSONL 源记录的
有界解析上限为 64 KiB。如果记录更大，则跳过该记录，file store 返回带有
`error.code: "record_too_large"` 的 `truncated` 以及可继续使用的 cursor。

`artifactRef` 只选择完全匹配的 artifact。如果找不到，结果为
`status: "unrecoverable"`，而不是成功的空字符串。无法证明请求范围完整的缺失或不完整
范围也会报告 `unrecoverable`。在未请求精确 artifact 时，`empty` 表示没有片段匹配。
无效请求参数和零上限使用 `status: "error"`。memory store 使用 revision source version；
file store 使用 transcript 文件的身份、大小和修改时间。因此，只要源未改变，
file-store cursor 可以由新的 store 实例继续使用，但签名没有密钥，不构成对抗性认证边界。

有界 recall 是原始 transcript 导航，不是语义搜索、完成证明或来源核验。本库不提供安全
边界；根据 ADR-009，宿主仍负责权限、租约和对抗性认证。

## `replayableSource` 与 artifact 状态

`replayableSource` 的可信顺序是：

`declared > policy > heuristic > unknown`。

先采用显式声明，然后是配置的不可重放策略，最后是内置的 `exec` heuristic。
`unknown` 表示声明不足以做出可重放性判断：不得将其视为安全、可重放或已核验，
也不得将其转换为布尔安全断言。在 `unknown` 情况下，省略 `replayable`，而不是
将其设为默认值。

归档和 artifact 事实使用 `ok`、`truncated`、`missing`、`stale` 和
`unrecoverable`。artifact 携带 `artifactId`、`archivePath`、`digest`、`locator`
和状态元数据；消费者必须回到那个确切的 `artifact`/`locator` 并核验 `digest`，
而不是信任展示字符串。大于 1 MiB 的归档以 `truncated: true` 保存，digest 是实际
存储在磁盘上的字节的 digest；此类 artifact 无法通过 CLI 来源 guard。

`createMemoryTranscriptStore` 和 `createFileTranscriptStore` 按 `runId` 隔离 transcript
记录。`appendRound` 依次按 `dedupKey`、`roundKey`、`${runId}:round:${round}` 去重。
这只是持久化幂等，不会去重或抑制工具执行。file store 设计为每个 `runId` 一个写入者；
跨进程并发写入需要宿主提供文件锁。

## 重复命令与副作用

使用 CLI `archiveDir` 时，相同的规范化 `exec` 命令会**执行并报告**，不会被阻止。
规范化会去除首尾空白并规范换行符。重复跟踪以 archive directory 为范围，并加载已有
capture 元数据，因此新的 CLI 工具实例也能识别之前的执行。每次执行都会尝试自己的归档；
归档失败时不会留下可恢复的 artifact。

结构化工具结果元数据通过 `rerunOf` 报告首次执行：

```js
{
  round,
  artifactId,
  archivePath,
  digest,
  locator,
  status,
}
```

面向模型的 notice 只展示安全的首次值、归档路径和 artifact 状态，且有界。需要
`round`、`digest`、`locator` 或完整来源记录的宿主必须读取结构化元数据，不得解析 notice。
重复执行还会设置 `runState.rerunDetected`；这不能证明模型会正确使用首次来源。
`rerunOf` 及其 notice 无法撤销已经发生的付款、删除、发布、写入或外部 API 副作用。

因此，宿主必须在工具能力、权限、沙盒或幂等层承载副作用与重跑风险，并决定
`unrecoverable`、`stale` 或 `unverified` 是否应触发人工审核、重试或失败。guard
仍是 opt-in 的机械检查器；不要向其中添加自然语言推断、关键词猜测或相似度规则。
优先使用折叠 stub、结构化 notice、生产者声明和有界取回等源头机制。

## 运行状态

引擎构建确定性的运行状态，并可在上下文折叠时注入其有界渲染结果。它会替换现有的
单个运行状态块，而不是追加重复块；当所提供的 `TranscriptStore` 支持
`saveRunState` 时，会持久化当前状态。确定性部分只包含引擎已知事实：预算、工具调用
计数和失败数、写入文件路径、注入的 todo 状态、折叠/导航/capture 计数、终止，以及
工具/checkpoint/archive 错误数。当前终止原因使用与 loop 相同的 termination 值，
包括 `end_turn`、`no_tool`、`stall`、`max_rounds_cap`、`reflection_stop`、
`judge_done`、`continuation_exhausted`、`final_guard_unverified`、`aborted` 和
`failed`。

`todoStateProvider` 是可选的宿主 todo 状态回调。`semanticStateProvider` 是可选的宿主
回调，提供有界语义文本和版本。版本不匹配会将语义部分标记为 `stale`；语义数据是
附加信息，不能覆盖确定性事实。引擎不会调用模型来获取语义状态。

持久化对象受 `RUN_STATE_MAX_SERIALIZED_BYTES`（`64 * 1024`）限制。渲染的 prompt
块受 `RUN_STATE_MAX_CHARS`（`400`）限制。运行状态 helper 还会将工具条目限制为 128、
文件条目限制为 128、todo 条目限制为 64，将普通的有界 name/path/id/status 字段限制
为 120 个字符，将语义源文本限制为 220 个字符。裁剪条目或序列化状态时，
`bounds.truncated` 和适用的省略计数会明确记录；达到 400 字符限制时，渲染块使用
`[run state truncated]`。

未知 schema 或不完整的持久化状态不会被静默当作有效默认值。resume 时，它会以
`runState.stateAvailability.status = "state_unavailable"` 暴露（例如
`unknown_schema` 或 `missing_fields`）。损坏的 file-store JSON 状态也会报告不可用，
而不是恢复。完全不存在的持久化状态是正常情况，不等同于存在但无效的状态。
