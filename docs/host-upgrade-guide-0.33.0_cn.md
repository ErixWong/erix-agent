<!-- doc-version: 0.33.0 -->
# 宿主升级指南：0.33.0

> 范围：issue #838 的 run snapshot 退役及其宿主影响，写于 0.33.0 切版之前。
> 已经在跑的进程不会原地迁移。

## 1. 先读这张表

| 如果你 … | 那么 0.33.0 里 |
|---|---|
| 保留着 `<runId>.snapshot.json` | 它是可删的陈旧文件；引擎不再读写它（§2.1） |
| 实现了 `saveRunSnapshot` / `loadLatestRunSnapshot` 或旧名 `loadLatestCheckpoint` | 引擎不再调用；实现留着或删除都可以（§2.2） |
| 升级时有 run 正在执行 | 用旧版本跑完，或停止后重启；账本是唯一真值（§2.3） |
| 需要中断工具结果的正文 | 崩溃缺口可能丢正文；恢复只报告账本能证明的事实（§2.4） |
| 检查 run-state 的 `errors.checkpoint` | 为兼容字段形状而保留，恒为 `0` 且永不增长 |

## 2. run snapshot 退役（#838）

### 2.1 引擎不再读写 run snapshot

旧版本留下的 `<runId>.snapshot.json` 是陈旧文件，不再是恢复输入。引擎既不写新快照，也不读旧
快照。你可以删除陈旧文件，无须做快照迁移；恢复上下文由账本重建。

### 2.2 引擎不再调用快照 store 方法

引擎不再调用 `saveRunSnapshot` 与 `loadLatestRunSnapshot`；旧名 `loadLatestCheckpoint` 也不再使用。
store 实现留着这些方法没有坏处；删除它们也不会导致引擎报错。宿主不再需要提供这项能力。

### 2.3 完成或重启正在执行的 run

升级时若有 run 正在执行，要么先用旧版本让它跑完，要么停止后在新版本从账本重启。不要期待内存
状态或落盘快照能跨版本续接；账本是唯一恢复真值。

### 2.4 工具结果正文可能在崩溃缺口中丢失

若进程在工具返回后、结果写入账本前崩溃，该工具的结果正文会丢失。账本能证明工具跑过时，
引擎使用 `UNPERSISTED_TOOL_RESULT_TEXT`（「跑过，结果不可用」）；没有执行证据时使用
`NO_EVIDENCE_TOOL_RESULT_TEXT`（「未知」）。没有证据时不会谎称「从未执行」。

## Retired run-snapshot / checkpoint errors

run snapshot 不再参与持久化或恢复。因此引擎不再发出 `checkpoint_failed`，
`persistence_error.phase` 也不再取 `checkpoint_before_tool` 或 `checkpoint_after_tool`。
这些名称只作为历史值保留并标废，不是当前持久化失败的别名。

当前 transcript 与 run-state 写入失败仍通过 `persistence_failed` 和适用的账本/run-state 阶段报告。
不要假设 checkpoint 已写入或被拒绝后再据此重试。run-state 中的
`deterministic.errors.checkpoint` 为兼容字段形状而保留，恒为 `0`；持久化失败应读取
`deterministic.errors.unpersisted` 及其条目。

`saveRunSnapshot` / `loadLatestRunSnapshot` 能力声明已删除。宿主可以为自身目的保留私有存储，
但 erix 不再发现或调用这些方法。恢复事实来自账本行，包括恢复行。

## 3. 在你自己那边验一遍

- 想清理磁盘时可删掉陈旧 `<runId>.snapshot.json`；引擎会忽略它。
- 其他代码若还会用快照 store 方法，可以保留；引擎不再调用它们。
- 在中断工具后续跑，区分「跑过，结果不可用」与「未知」；两者都表示引擎无法恢复丢失的正文。
