<!-- doc-version: 0.33.0 -->
# 宿主升级指南：0.33.0

> 范围：run snapshot 退役与契约清理（#838 S2）。本指南记录不再属于当前持久化契约的宿主可见名称和值。

## 先读这张表

| 如果你 … | 那么 0.33.0 里 |
|---|---|
| 捕获 `checkpoint_failed` | 不要再把它当作当前引擎错误处理；自 run snapshot 退役后它已废弃且不再发出 |
| 按 `persistence_error.phase` 分流 | 从当前阶段处理中移除 `checkpoint_before_tool` / `checkpoint_after_tool`；引擎现在不会发出这两个值 |
| 检查 run-state 的 `errors.checkpoint` | 为兼容字段形状而保留，恒为 `0` 且永不增长 |
| 只为 erix 实现 run snapshot 方法 | 从 adapter 契约中移除这项可选能力；引擎不再调用它 |
| 恢复一个 run | 依赖 transcript 账本与 run-state，不依赖 run snapshot 兜底格 |

<a id="retired-run-snapshot-checkpoint-errors"></a>
## 已退役的 run snapshot checkpoint 错误

run snapshot 不再参与持久化或恢复。因此引擎不再发出 `checkpoint_failed`，
`persistence_error.phase` 也不再取 `checkpoint_before_tool` 或 `checkpoint_after_tool`。
这些名称只作为历史值保留并标废，不是当前持久化失败的别名。

当前 transcript 与 run-state 写入失败仍通过 `persistence_failed` 和适用的账本/run-state 阶段报告。
不要假设 checkpoint 已写入或被拒绝后再据此重试。run-state 中的
`deterministic.errors.checkpoint` 为兼容字段形状而保留，恒为 `0`；持久化失败应读取
`deterministic.errors.unpersisted` 及其条目。

`saveRunSnapshot` / `loadLatestRunSnapshot` 能力声明已删除。宿主可以为自身目的保留私有存储，
但 erix 不再发现或调用这些方法。恢复事实来自 transcript 行、恢复行与 run-state。
