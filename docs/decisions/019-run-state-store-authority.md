# ADR-019：run-state 存储形态与权威模型（保留双写 + 终态/快照拆通道；拒绝删除任一份拷贝；记录两条未排期架构备选）

- 状态：Accepted（2026-10-03）
- 关联：issue #82（决策 C：双写收口）、#89（同源缺陷修复：损坏态回落 + 可用性棘轮）、#91（项 1/项 2 交付 + 两条备选停放处，本 ADR 落定后关闭）、#78（run snapshot / run-state 降级为可选 capability）、#83（引擎内部机制名统一为 run snapshot）
- 依据：issue #82 三方案分析（含 touwaka store 实测：只实现 `{appendRound, load}`，不实现 run-state）；#91 评论中的 `@earendil-works/pi-durable` 对照（本机 clone `~/projects/github/pi/packages/durable`）；PR #90 / #92 / #93 / #94

## 背景

引擎把「最新运行状态」以三种形态持有：

| 形态 | 载体 | 用途 |
|---|---|---|
| 每轮快照 | `RoundRecord.runState`（随 transcript 落盘） | history 侧；resume 的兼容回落 |
| 独立 latest-only | `saveRunState` / `loadRunState` | 最新权威；宿主免扫 transcript 即可查询 |
| 终态标记 | `markRunState` | 宿主查询 run 结局（`running` / `succeeded` / `failed` / `aborted` / `guard_error` / `unverified_error`） |

前两者**写在同一节奏**（每轮 `refreshRunState()`），契约自 #78 起记为 "Known duplication (documented, not fixed here)"。归属长期模糊，并在核查 #82 时暴露出两个**真缺陷**（#89 修复）：

1. 独立 state **存在但无效**时仍回落 record —— 诊断报「不可用」，实际却用了一份**更旧**的状态；
2. `stateAvailability` 自我传播 —— 一次损坏之后，每次 resume 都判不可用（永久 degraded），且污染同时击中两份拷贝。

同时 `loadRunState()` 的返回值是**混装对象**（快照字段 + 终态字符串），宿主只能靠嗅探区分；终态寄生于快照槽，使「删掉独立存储」在结构上不可行。

## 决策

### D1：保留双写（方案 C），并定权威优先级

| 方案 | 内容 | 结论 |
|---|---|---|
| A | 删 `RoundRecord.runState`，只留独立存储 | **拒绝**：touwaka 的 run-state 恢复**唯一**走 record 回落（其 store 只实现 `{appendRound, load}`，无 `loadRunState` → 走 capability-degraded 后回落 record）。删掉它 = touwaka 的 resume 静默退化（工具计数/预算/fold/todo/semantic 全丢）；要修就得给 touwaka 补 3 个方法，**与 #78 的降级方向相反** |
| B | 删独立存储，只留 record | **推迟**（见 D5）：终态与「`appendRound` 失败仍留痕」无家可归 |
| **C** | **维持双写，写清边界** | **采纳** |

**权威优先级（引擎 resume）**：

1. 独立 state **有效** → 用它；`RoundRecord.runState` 只作 history，不参与
2. 独立 state **不存在**（无 `loadRunState`，或返回 `undefined`）→ 回落最新 `RoundRecord.runState`（#78 的能力降级语义，必须保住）
3. 独立 state **存在但无效** → 报 `state_unavailable`，**不回落**（#89 修复；观测结果不得回流成下一次的准入判断）
4. 两份都缺 → 状态全缺，run 正常跑 + 发 `persistence_capability_degraded`

### D2：终态与快照拆通道（已实施，PR #93 / #94）

- `markRunState` 写**独立通道**（file store：`<runId>.status.json`；memory store：独立 map）
- 新增**宿主面向**可选读 `loadRunStateStatus`：引擎不调用、不校验，**故意不加入** `RUN_STATE_STORE_METHODS` / `OPTIONAL_TRANSCRIPT_STORE_METHODS`（否则已实现旧三件套的宿主会收到虚假的降级事件）
- `saveRunState` 的 latest-only 快照**不再写** `state` 键；`loadRunState` 对旧数据内嵌的 `state` **原样透传**（读取兼容，不迁移）
- status 文件损坏/畸形时**显式抛错**，不静默回落到可能过期的旧值
- 契约测试从「断言参考实现的物理形状」改为**断言语义**：此前 `test/contract/transcript-store.js` 直接断言 `loadRunState(id).state`，等于强迫第三方 store 照抄我们的打包方式

### D3：`RoundRecord.runState` 是 history 侧，不承载终态

### D4：物理布局归宿主，引擎只规定语义通道

引擎规定「快照」与「终态」两个语义通道，**不规定打包方式**：一张表两列、两个文件、两张表都是合法实现。file/memory store 的形态只是其中一种选择。

### D5：两条未排期的架构备选（参照 pi-durable）

pi-durable 的对照要点（证据见 #91 评论）：单一原子 `commit(writes[]) → Seq`；`StorageWrite` 是判别联合，端口只承载语义、SQLite 后端各自建表；status 是独立实体（`tasks.status` + 按 status 的索引）；**「latest」是日志/修订的投影，而不是第二份存储**；契约靠 conformance suite 锁语义。

| 备选 | 内容 | 前提 / 代价 | 状态 |
|---|---|---|---|
| ① 单一原子提交端口 | 所有状态变化走一个原子批次 + 全局序号 | 需放弃「宿主注入 store + 可选能力分级」的架构前提（erix 是零依赖**库**，pi-durable 是自持存储的 harness）；属 breaking 大改 | **不排期** |
| ② 日志内标记替代第二份存储 | 让 record 自带「当前状态载体」标记，standalone 快照存储整体删除（= B 的技术实现） | 改 `RoundRecord` 形状（宿主可见数据形状）；且仍会失去「`appendRound` 失败时的状态留痕」与「宿主免扫 transcript 查询」 | **不排期** |

**D2 之后，方案 B 的技术前提已具备**（终态不再寄生快照槽）；是否推进取决于「维护双写的成本 > 迁移成本」是否成立。

## 后果

- **契约/数据**：`loadRunState(id).state` 读法变更属 **BREAKING**（记于 `CHANGELOG.md` 的 `[Unreleased]`），迁移指引 = 改用 `loadRunStateStatus(id)`；旧数据仍可读（内嵌 `state` 透传 + status 回落），无数据迁移。
- **宿主**：未实现 run-state 的宿主（touwaka）**零影响**；已实现的按迁移指引切换终态读取。
- **#82 的验收①**（决策落 ADR）由本文件补足。
- **回头条件**：touwaka 上 run snapshot（必然要动 store 层），或宿主数量增长到维护双写的成本超过迁移成本时，重新评估 D5；届时以 pi-durable 的设计（原子提交 / 语义端口 / conformance suite）为参照。
