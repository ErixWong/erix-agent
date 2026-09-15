# Bounded recall API 设计

- 状态：设计稿（不实现）
- 日期：2026-09-14
- 关联：[memory and compaction RFC](./2026-09-14-memory-and-compaction-rfc.md)、[评审](./2026-09-14-memory-and-compaction-rfc-review.md)、Issue [#82](https://github.com/ErixWong/erix-agent/issues/82)

## 目标与边界

Tier 3 的职责是按已知地址取回 transcript/archive 的有限切片，不是第二个
语义记忆系统。宿主显式 opt-in 后才接线；核心 loop 不自动调用 recall，recall
也不做 embedding、关键词扩展或语义搜索。Memento/折叠摘要只提供导航，不能替代
store 中的真相。

本设计解决两个边界问题：

1. 返回大小必须在 store 读取源头受限，不能先拼出全量字符串再由工具层截断。
2. 缺失、陈旧和截断必须是机器可辨识的状态，不能用空字符串伪装成“没有结果”。

## Store 层签名

宿主实现的 store 可提供以下对象参数接口：

```js
await store.recall({
  runId,
  fromRound, // 可选，包含
  toRound,   // 可选，包含
  limit,     // 可选，返回的记录/片段数上限
  cursor,    // 可选，上一次响应返回的不透明续取游标
  maxBytes,  // 可选，响应 payload 的字节上限
});
```

`runId` 必填；`fromRound`、`toRound` 必须是非负整数且范围有效。
`limit` 和 `maxBytes` 是硬上限，store 不得为了计算总数或生成摘要而读取并
缓存范围内的完整结果。`cursor` 由 store 生成和解释，调用方不得解析或修改。
游标应绑定 `runId`、范围、权限/租约和数据版本；参数变化时必须拒绝或返回
显式的 `cursor_mismatch`，不能静默从错误位置继续。

建议响应形状：

```js
{
  status: "ok" | "empty" | "truncated" | "unrecoverable" | "stale" | "error",
  items: [{
    round,
    kind: "message" | "folded_payload" | "artifact",
    content,              // 已按 maxBytes 限制的结构化切片
    locator,              // 可选，原始位置
    digest,               // 可选，源记录/工件 digest
  }],
  nextCursor: string | null,
  truncated: boolean,
  sourceVersion: string | null,
  error: { code, message } | null,
}
```

`items` 本身也必须是有界的；响应 JSON、编码和 envelope 计入
`maxBytes`。单个 item 大于剩余预算时，store 应返回可识别的
`item_too_large`/`truncated` 状态和续取信息，而不是构造一个无界 item。
实现可以使用流式 JSONL、数据库游标或文件逐行扫描，但不得把全量内容先
合并成字符串再截断。

## 错误、缺失与陈旧语义

| 状态 | 语义 | 调用方行为 |
|---|---|---|
| `ok` | 返回完整的当前切片 | 消费 `items`；`nextCursor` 非空时可续取 |
| `empty` | 范围存在且没有匹配/可返回条目 | 与“范围不存在”区分，不得宣称恢复成功 |
| `truncated` | 受 `limit`/`maxBytes` 限制，仍有数据 | 保留并展示截断标记；只用 `nextCursor` 续取 |
| `unrecoverable` | 请求的轮次、工件或必要归档已缺失/损坏 | 明确报告“不可恢复”；不得重跑工具或编造值 |
| `stale` | 游标或 source version 对应的数据已变更、过期或不再授权 | 丢弃旧游标，重新请求并让宿主决定是否接受新版本 |
| `error` | I/O、权限、参数或后端故障 | 保留错误码和可审计日志；不得静默降级为空结果 |

范围边界越过已知水位时，若 store 能证明缺失，返回 `unrecoverable`；
不能证明是空范围时返回 `error` 或 `stale`，不要猜测。权限拒绝应保持
`error`（例如 `forbidden`），不应泄漏“是否存在”。

## 与 Tier 3 / Memento 的契约

- 折叠产生的 `roundFrom`/`roundTo`、artifact `locator` 和 `digest` 是
  recall 的地址输入；导航记录不携带值，也不赋予 store 之外的事实权威。
- Memento/摘要只写“可取回”“已截断”“不可恢复”等状态及有限地址。
  它可以被丢弃或替换，不得通过重复注入累积游标或历史正文。
- 取回结果必须保留 `round`、`kind`、`digest` 等 provenance，使宿主能把
  结果与归档对账；digest 不匹配时应返回 `stale`/`unrecoverable`，而不是
  把新内容当作旧轮次内容。
- 现有位置参数 `store.recall(runId, fromRound, toRound, pattern)` 属于
  兼容接口。迁移期间可由宿主适配，但新接口不把 `pattern` 当作语义检索；
  若需要筛选，必须在已限定的 source-side slice 上执行并计入预算。

## 宿主接入约束

recall 是宿主 opt-in 能力。宿主负责：

- 选择何时向模型暴露 recall 工具以及如何翻译 `status`；
- 设置每次请求的 `limit`/`maxBytes`、权限和 retention；
- 在 `stale`、`unrecoverable` 或连续截断时停止重试并交给上层策略；
- 不把 `unknown` replayability 或导航 digest 解释成值本身。

库的参考工具可以把 `truncated + nextCursor` 变成下一步提示，但不能隐藏
错误、自动扩大预算或在失败时重跑原工具。语义搜索、跨 run 主题记忆和
多角色重试属于宿主层，不进入该 API。

## 确定性验收

实现该设计时至少需要覆盖：source-side `maxBytes`、`limit` 和 cursor
续取；参数变化导致的 cursor 拒绝；缺失轮次的 `unrecoverable`；截断的
显式标记；陈旧 digest/version；权限/I/O 错误不变成空结果；以及多次
Memento 注入的替换而非膨胀。本文不包含这些接口的实现。
