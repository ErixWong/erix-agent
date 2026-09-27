# ADR-018：notes 生命周期三阶段拆分（complete/revoke/purge）、宿主 liveness 承接 active orphan 清理、list 朴素数组契约（revision/分页协议已判定 YAGNI 并削减）

- 状态：Accepted（2026-09-27）
- 关联：实施 issue #67（PR 1 #71 / PR 2 #72 list 契约与 semantic 缓存 / PR 3 #73）；D3 记录决策反转：初版实现 revision+分页后由维护者复盘削减（单 run 实测平均 2 条、峰值 9 条，YAGNI）；修订 ADR-015（notes 小抄目录）与 ADR-016（replayable 退役）中 notes 写入与 janitor 的表述；破坏面落在 0.12.0
- 依据：issue #67 方案（issuecomment-1555 第 4 节）；0.11.x janitor 时间启发式在宿主调度场景下的误杀分析

## 背景

0.11.x 的 notes 维护是"引擎替宿主猜"：run 起点跑 janitor，janitor 用一个时间启发式
（grace 窗口内没有活动的 scope 视为 orphan）撤销 active 记录，list 返回全量数组，
`recordAutoCapture` 仍是第二写入口。0.11.0 实测部署后三条矛盾汇合：

1. **误杀**：宿主调度型运行（定时拉起、长间隔 resume）的 scope 长时间不活动是常态，
   不是死亡。grace 窗口一到，活着的 run 的 active 记录被引擎静默撤销——
   "宁积累不误杀"被时间启发式系统性违反。
2. **不可分页**：list 返回全量数组，scope 内记录增长后每次 list/semantic 目录
   都是全量读；工具层与宿主都没有翻页协议。
3. **写入口分裂**：ADR-016 已经退役 replayable 概念，但 auto-capture 仍作为
   第二写入口存在，`note_take` 不是唯一写者。

## 决策

### D1：lifecycle 三阶段拆分，janitor 不再猜 orphan

`lifecycle` 收敛为 `onRunStart`（no-op 兼容入口，run 起点不再 GC）/
`onRunComplete`（只调 completeRun，active → done，返回 `{ completed, errors }`，
移除 `janitor` 字段）/`revokeInactive({ scopeRefs, reason? })`（宿主 liveness 入口）。

`janitor` 收窄为一件事：撤销 `state === "done"` 且 `expires_at` 已过的记录。
done 的过期是 completeRun 自己写下的确定性事实（`expires_at = now +
ERIX_NOTES_DONE_GRACE_MS`），不存在猜测；active 的生死不可由时间推断，权归宿主。

### D2：active orphan 清理 = 宿主 liveness callback，不用 lease 文件

| 方案 | 正确性 | 宿主成本 | 结论 |
|---|---|---|---|
| lease 文件（scope 目录内写心跳租约，janitor 按租约过期回收） | 租约写失败/时钟回拨会把活 run 判死，误杀面与旧启发式同构 | 引擎要在每次工具执行路径上写文件（热路径副作用） | 拒绝：把心跳义务藏进了引擎，误杀风险没消除 |
| 时间启发式（旧方案，无信号） | 静默 run 被判死 | 零 | 拒绝：0.11.x 已实测误杀 |
| **宿主 liveness callback**（`liveness.isAlive(scopeRef, { now, ttlMs })`，引擎只在宿主显式调 `revokeInactive` 时调用） | 生死判定的知识（调度器状态、进程表、最后心跳）本来就在宿主；`isAlive` 抛错进 `errors[]`，绝不解释为 false | 宿主传一个函数 + 一次显式调度 | **采纳**：判定的知识归知识所在方，引擎零猜测 |

无 liveness 的宿主：active orphan 永不自动回收。这是显式接受的代价
（积累优于误杀），与 ADR-012 的引擎真相/宿主策略分工一致。

### D3：list 朴素数组契约——revision/分页协议实现后判定 YAGNI，0.12.0 出厂前削减

初版实现了完整方案：`list()` 返回 `NotesListPage { status: "found"|
"cursor_stale", records, nextCursor, revision }`，cursor 是不透明串
`"<revision>:<offset>"`，revision 是每个 scope 单调递增的目录级版本
（隐藏文件 `.revision`），semantic 目录缓存做 epoch × revision 两级短路。

维护者复盘实测数据后决策反转：单 run 笔记量平均约 2 条、峰值 9 条——
20 条以内 LLM 完全可应对，翻页协议、cursor_stale 恢复语义、revision
落盘/重建/缓存的复杂度全部是为一个不存在的规模问题支付的。0.12.0
未发布，出厂前削减零额外 breaking 成本。最终契约：

- `list()` 返回 `NoteRecord[]`；不给 `limit` = 全部匹配记录（内部消费方
  complete/revokeInactive 依赖全量语义），给了 `limit` 钳制最大 200。
  `filters`/`sort` 照旧下沉 store。
- `note_list` 连 `limit` 一并移除：始终返回该 scope 全部匹配记录，
  无截断提示；超限用 `tag`/`source`/`minRelevance` 过滤缩小范围。
- **保留 epoch 缓存的理由**：semantic 目录是纯进程内派生视图，fold 点
  高频调用；单写者约定下「assembler 内任何写方法推进 epoch、epoch 未变
  直接复用文本」是最便宜的正确短路，不依赖任何落盘协议。删 revision
  后缓存退化为纯 `{ epoch, text }`。

不选"纯 offset 游标"（初版已拒绝）的理由在反转后不再相关；若未来单
scope 规模数量级增长，分页是局部优化，届时以实测数据重开决策。

### D4：file adapter 内存视图，不写 .index.json

list 每次扫描目录构建内存视图后排序分页，不维护 `.index.json` 索引。
理由：单 scope 记录量在 note_list（≤200/页）与 semantic（≤20）的消费规模下
全量读取成本可控；索引要写穿 write/complete/revoke/janitor/purge 五处失效点
并处理崩溃一致性（索引与目录脱节后的重建协议），复杂度大于收益。
若未来单 scope 规模数量级增长，索引是局部优化，不动本决策的接口面。

### D5：normalize 用固定 epoch 兜底，不用"现在"

`normalizeNoteRecord()`：缺 `updated_at` 回退 `created_at`，均缺/非法用固定
epoch `1970-01-01T00:00:00.000Z`。不用当前时间——用 now 兜底会把"缺时间字段"
洗成"最近更新"，排序与增量缓存会被脏数据系统性污染；1970 显式表达
"时间未知"，排在任何真实时间之前，可审计。normalize 不洗白非法记录
（调用方先经 `isNoteRecord` 严格校验），只补时间字段。

### D6：schema 收敛 run-only，`recordAutoCapture` 删除（PR 3）

四个 `note_*` 工具 scope enum 只剩 `["run"]`；project/user 直接 invalid。
`recordAutoCapture()` 删除（ADR-016 收尾），`note_take` 是唯一写入口；
历史 auto 记录的读取能力（`source` 过滤、`@auto` 标记）保留。

## 后果

- **破坏面（0.12.0）**：`NotesStore` 必需方法扩为七方法（创建期
  `assertNotesStore` fail-fast）；`onRunComplete` 返回值去掉 `janitor` 字段；
  `onRunStart` 不再 GC；`note_list` 移除 `cursor`/`limit` 参数、输出移除
  `total`；`ERIX_NOTES_GRACE_MS` 降级为 deprecated
  alias；`recordAutoCapture` 删除。迁移指引见
  [host-upgrade-guide-0.12.0.md](../host-upgrade-guide-0.12.0.md)。
- **得到的**：误杀面归零（active 生死只由宿主知识判定）；写入口单一；
  janitor 语义可机械验证（done + expires_at，无启发式）；list/semantic
  消费面零协议负担（实测平均 2 条、峰值 9 条）。
- **失去的**：无 liveness 宿主的 active 记录无限积累（显式接受）；
  宿主多承担两个显式维护循环（janitor/purge 翻页）。
- **兼容**：list 回到 0.11.x 的数组形态（0.12.0 未发布，无 shipped
  分页契约需要兼容）；老目录无 `.revision` 直接可读，遗留的 `.revision`
  文件是惰性垃圾，由 purge 或宿主清理；semantic 缓存纯 epoch 短路，
  与任何落盘协议解耦。
