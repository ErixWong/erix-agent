# 宿主消费者契约

本文件是 `erix-agent` 0.5.0 的宿主接入边界。引擎负责维护可对账的运行事实；
宿主负责工具权限、归档策略、重试/重跑策略和最终消费判断。相关责任边界见
[ADR-012](decisions/012-engine-truth-model-efficiency-host-policy.md) 与
[ADR-013](decisions/013-guard-charter.md)。

## 终稿 verification

宿主消费 `runToolLoop` 返回值时，必须先读取 `verification.status`：

| 状态 | 契约 |
|---|---|
| `verified` | 唯一可以视为来源已核验的终稿状态。 |
| `skipped` | 没有可核验项或 guard 未启用；**不等于没问题**，不得改写为 `verified`。 |
| `unverified` | 来源核验要求未满足；CLI 退出码为 2，宿主不得当作成功结果消费。 |
| `error` | guard 异常或超时；CLI 退出码为 3，宿主不得当作已核验事实消费。 |

引擎不存在“交付物认证”或“完成度认证”层。我们放弃了静态匹配式 gauge：
引擎只报告轮次、工具、文件调用、归档、终止和 verification 等事实；任务是否完成、
交付物是否满足需求，以及是否允许自动进入下游，判断归宿主、测试系统或人工审核。

## bounded recall

精确取货按地址使用对象式接口，所有上限必须在 store 源头生效：

```js
const page = await store.recall({
  runId,
  fromRound,
  toRound,
  artifactRef, // 可选：精确 artifact/locator
  limit,
  maxBytes,
  cursor,     // 首页省略；后续原样回传
});
```

`cursor` 是不透明游标，不得解析、拼接或跨 `runId`、范围、参数和 source version
复用；它还绑定 `limit`、`maxBytes`、`pattern` 和 `artifactRef`，任一变化都必须
重新寻址。`artifactRef` 只返回精确目标，目标缺失为 `unrecoverable`；`limit: 0`
或 `maxBytes: 0` 会被拒绝，不产生不可推进游标。`truncated` 必须使用返回的
`nextCursor` 续取；不能把一次有界切片当作完整档案。文件 store 对超过源记录硬顶的
单条 JSONL 记录返回 `truncated` + `error.code: "record_too_large"` 和可推进游标，
明确该记录被跳过。
`unrecoverable` 表示目标轮次或工件缺失、损坏或无法证明原值，不能降级为空字符串成功；
`stale` 表示来源版本/游标已失效，必须重新寻址。bounded recall 是原文导航，不是语义搜索、
完成证明或 provenance 验证。

## replayableSource 与工件状态

`replayableSource` 的可信来源顺序是：

`declared > policy > heuristic > unknown`。

`unknown` 表示没有足够声明，不能被当作安全、可重放或已核验；它也不能转化为布尔安全
断言。`ok`、`truncated`、`missing`、`stale`、`unrecoverable` 是工件/归档事实状态，
消费者应回到对应 artifact/locator 和 digest 做精确核对。

## 重复命令与副作用

相同规范化命令现在**执行并告知**，不再由引擎拦截。告知通过 `rerunOf` 指向首次
round、artifact、digest、locator 和状态；每次执行仍独立归档。告知不能撤销已经发生的
付款、删除、发布、写入或外部 API 副作用，也不能证明模型会正确使用首次来源。

因此，宿主必须在工具能力、权限、沙盒或幂等层承担副作用与重跑风险，并决定
`unrecoverable`、`stale`、`unverified` 是否转人工、重试或失败。guard 仍是 opt-in
机械核对器：不得向 guard 添加自然语言推断、关键词猜测或相似度规则；应优先采用
折叠 stub、结构化告知、生产者声明和有界取货等源头机制。

## run state

引擎可在折叠点注入有界的确定性 run state，并在 TranscriptStore 中以当前版本 upsert。
它只包含引擎已知事实：预算、工具足迹、写文件路径、注入的 todo 状态、折叠/导航计数、
终止与错误计数。`todoStateProvider` 和 `semanticStateProvider` 均由宿主注入；后者返回
有界文本与版本，版本不匹配会标为 `stale`。持久对象有 64 KiB 总序列化硬顶，
工具名/文件/todo 条目和字段长度也有上限；裁剪会在 `bounds.truncated` 及省略计数中
显式标记。未知、缺失或损坏 schema 不会静默恢复默认值，resume 会返回
`runState.stateAvailability.status = "state_unavailable"`（文件 JSON 损坏也如此）。
引擎不自行调用模型，语义文本也不能覆盖确定性事实。
