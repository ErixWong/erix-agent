# ADR-022：先按关系库设计，再反推 store 端口（折叠记录升为独立事实）

- 状态：Proposed（2026-11-27，第三版）
- 关联：#566（累计体 vs 增量）、#567（foldId/seq）、#601（折叠记录账本）、#738（逐字喂出的字节）、
  #769（恢复行独立通道）、#827（partial 槽）、#896（召回层）、#897（title/description/教训）、
  #898（折叠必须由 LLM 完成）、#930（超窗自恢复）、#971（本 ADR 的落地单）、
  ADR-018（notes）、ADR-020（transcript 单一来源）
- 触发：用户指出「折叠后的记录没有自己的位置」——它寄生在**触发折叠那一轮的轮记录字段** `record.foldedFacts` 上。
- **第三版修订**：第二版把「一份累计文档」当成折叠的产物；本版改成「每次折叠一条**局部日志**，
  上下文按预算对同一批日志做梯度渲染」。第二版留下的七处逐条列在 §9。

---

## 0. 为什么先设计表

现有形状是**从文件存储反推出来的**：一 run 一个 transcript `.jsonl`（另有 recovery / partial / state 侧车），
一次折叠发生时把 `foldedFacts` 挂在那一轮的记录上。于是「一次跨轮区间的折叠事件」被存成「某一轮的一个字段」，
读的时候要扫全表挑字段。

本文反过来：**先写清关系模型（表、主键、约束、索引、并发语义），再从表推出端口方法**。
文件存储届时是这套模型的一种投影（一表一侧车），`src/` 仍然零 npm 依赖。

---

## 1. 关系模型

### 1.1 `runs` —— 会话

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `run_id` | text | **PK** | 跨 resume 不变 |
| `status` | text | | 终态字符串（`loadRunStateStatus` 读它） |
| `state` | jsonb | | `saveRunState` / `loadRunState` 载荷 |
| `state_schema_version` | int | not null | 格式代次（`RUN_STATE_SCHEMA_VERSION`） |
| `state_epoch` | int | not null | **run 内「状态块注入过几次」的计数**，用来判派生缓存（`semantic` 小抄目录）是否过期。不是版本号：只在注入轮 +1，失败收尾那次会用同一个号重写 |
| `migration_folds_complete` | bool | not null default false | §5 的**迁移完成标记**（原子判据，不是"表非空"） |
| `created_at` / `updated_at` | timestamptz | not null | |

### 1.2 `rounds` —— 行流（**不存折叠事实**）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `run_id` | text | **PK₁**, FK→runs | |
| `seq` | bigint | **PK₂** | run 内严格递增（落盘序） |
| `round` | int | not null | 轮号 ≥ 0；`0` 是 seed 行 |
| `kind` | text | not null | `round` / `message` / `control` / `fact` |
| `dedup_key` | text | not null | 口径**逐字照** `recordKey`：`dedupKey ?? roundKey ?? "<runId>:round:<round>"` |
| `payload_fingerprint` | text | not null | `payloadFingerprint(record)` 的值，形状是 **`sha256:<24 hex>`**（不是 64 位摘要；列名跟着这个形状，不叫 `payload_sha256`） |
| `payload` | jsonb | not null | 该行内容（`kind='message'` 时是一条消息，content 块留在 payload 里） |
| `created_at` | timestamptz | not null | |

约束：`PK(run_id, seq)`；**`UNIQUE(run_id, dedup_key)`**；索引 `(run_id, round DESC)`（`loadMaxRound`）、
`(run_id, kind, round)`。

> ⚠ **唯一约束本身不等于现有的幂等契约。** 现有口径是：同 key **同 payload** ⇒ 幂等 no-op 返回 false；
> 同 key **异 payload** ⇒ 抛 `TranscriptDedupConflictError`。单纯 `ON CONFLICT DO NOTHING` 会把后者
> **静默吞掉**。所以 `appendRound` 的 DB 实现必须写成「插入；冲突时比较 `payload_fingerprint`：相等 ⇒
> 返回 false；不等 ⇒ 抛」——这一列就是为这一步存在的。

`payload` 不拆到块一级：原子单位是**消息**（`foldMessageRows` 的口径）。只有需要
`tool_use ↔ tool_result ↔ 执行证据` 三向 join 时才拆出 `content_block`，本版不做（§7）。

### 1.3 `folds` —— 一次折叠 = 一行（第三版重写）

第三版的核心改动：**折叠的产物不是一份累计文档，而是一条局部日志**。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `run_id` / `seq` | text / bigint | **PK(run_id, seq)** | `seq` = run 内严格递增折叠序 |
| `from_round` / `to_round` | int | not null | 本折吃掉的轮区间 |
| `prior_seq` | bigint | FK→folds(run_id, seq)，可空 | 续写基底 = 上一折。**用外键，不用哈希**（§9 第 3 条） |
| `title` | text | not null | **模型写的短标题**，≤ 60 字符 |
| `title_src` | text | not null | `model` / `first_line`（回退，见 §4 硬前提①） |
| `description` | text | not null | **本折日志正文**，300–500 token，自解释、无指代 |
| `description_tokens` | int | not null | 渲染时按它算预算（估算器口径） |
| `stage_no` | int | 可空，FK→stages | 归属的阶段线（§4 降级第三档） |
| `source` | text | not null | `llm` / `host`（**没有 `statistical`**：折叠必须由 LLM 完成） |
| `origin` | text | not null | `semantic` / `host`（**没有 `mechanical`**） |
| `trigger` | text | not null | `budget` / `context_window_recovery` / `manual` |
| `superseded_by` | bigint | 可空，FK→folds(run_id, seq) | 这一折的日志被后来的某一折取代（模型编错了、或白板已吸收）。**只加指针，不改行**——append-only |
| `created_at` | timestamptz | not null | |

索引：`PK(run_id, seq)`；**`UNIQUE(run_id, from_round, to_round, prior_seq)`**；`(run_id, stage_no)`。

**为什么幂等键不是哈希**：`(from_round, to_round, prior_seq)` 三元组就是「这是哪一次折叠」的完整身份
——崩溃重跑同一个折叠决策必然算出同一个三元组。第二版用 `foldSummaryFingerprint` 当幂等键，是为了
在**没有行 id 的 JSONL** 里认出「同一次折叠」；有了主键，这层哈希没有存在的理由（§9 第 3 条）。

**为什么没有 `text`（累计体）**：第二版的 `folds.text` 是「截至本折的累计替代物」，它每折被重写一次，
于是同一段内容被压缩两遍、三遍（§9 第 5 条）。第三版只存**本折**的 `description`，旧行一个字不动。

### 1.4 `fold_round_rows` —— 这次折叠吃掉了哪些行（沿用第二版）

`(run_id, round)` **不唯一**（崩溃轮有消息行 + 轮载体行；同一轮在 restore / 重折之后可能有多代行），
所以「`from_round..to_round` 反查原文」**定位不到那一代行**。必须记成员关系：

| 列 | 约束 |
|---|---|
| `fold_run_id`, `fold_seq` | FK → `folds(run_id, seq)`，**PK₁₂** |
| `round_run_id`, `round_seq` | FK → `rounds(run_id, seq)`，**PK₃₄** |
| `excluded` | bool not null default false + `exclude_reason`（`clamped` / `deduped` / `safety_removed`） |

**原文一条都不复制。** `foldedPayload` 从「落盘的正文副本」变成**派生查询**：

```sql
SELECT r.* FROM fold_round_rows m JOIN rounds r ON r.run_id = m.round_run_id AND r.seq = m.round_seq
 WHERE m.fold_run_id = ? AND m.fold_seq = ? AND m.excluded = false;
```

实测依据：一份真机归档里，被归档的副本 940,278 字节，而它拷贝的那些行自己合计 941,379 字节
——**差 0.1%，等于纯冗余**（测量现场见 #971 评论）。

### 1.5 `stages` —— 阶段线（第三版新增）

折数一多，`title` 也是线性增长的（1000 折 × 20 token = 20k）。最老的那些按区间并成一行。

| 列 | 类型 | 约束 |
|---|---|---|
| `run_id` | text | **PK₁** |
| `stage_no` | int | **PK₂** |
| `from_fold_seq` / `to_fold_seq` | bigint | not null，闭区间 |
| `label` | text | not null，≤ 40 字符；模型给或机械拼 |

分组可以是机械的（按区间），阶段名让 LLM 每 10 折起一次名——**很便宜，不需要"摘要的摘要"**。

生成时机：每新增 10 折，把**最老**的 10 折并进一个新 stage。`label` 由同一次折叠调用顺带产出
（§4.10 的第 ③ 件事），拿不到就机械拼「第 a–b 折」并标 `label_src='mechanical'`。
已并进 stage 的折**不再出现在第一、二层**——第三档独占它们（§4.2 的 ③）。

### 1.6 `notes` / `note_history` / 白板（ADR-018 + 第三版）

`notes(run_id, key, current jsonb, state, pinned, relevance, provenance jsonb, created_at, updated_at, revoked_at)`，
PK(run_id, key)；`note_history(run_id, key, version, payload, state, created_at)`，PK(run_id,key,version)。

**白板是 note 的一个维度，不是新实体**（第三版新增）：

| 新增 | 说明 |
|---|---|
| `notes.board` | `NULL` = 长尾笔记（可检索、会过期）；`'whiteboard'` = 白板（强制注入、不过期、有预算） |
| `note_ops` | 操作记录：`(run_id, log_seq, key, board, op, fold_seq, before jsonb, after jsonb, ts)`，`op ∈ write/complete/revoke/purge/drop` |

两条策略跟着改：`purge` 跳过 `board IS NOT NULL`；`note_list` 默认 `board IS NULL`（白板不混进长尾结果）。

白板的**准入判据**（写不出就不许进）：不记住的后果必须是一次**可观测的失败**（重复劳动 / 违反约束 /
重跑已失败的路）。白板 ≤ 1200 字符、条目 ≤ 12 条，满了必须删一条才能进新的。

### 1.7 `budget_verdict` —— 装不下的证据（第三版新增）

「超预算就显式失败」只有在**说清差多少**时才成立。

| 列 | 类型 | 说明 |
|---|---|---|
| `run_id` / `round` / `check_idx` | text / int / int | **PK** |
| `source` | text | `estimate`（引擎本地数）/ `provider`（真实 tokenizer 报 `context_window_exceeded`） |
| `fold_seq` | bigint | 哪一折之后数的，可空 |
| `budget_tokens` / `measured_tokens` | bigint | not null |
| `over_by` | bigint | 生成列：`greatest(measured - budget, 0)` |
| `layers_tried` | jsonb | 按尝试顺序：`["ttl","aggregate","stub"]` |
| `outcome` | text | `ok` / `degraded` / `failed` |
| `ts` | timestamptz | |

终局 `termination_code = 'cannot_fit'` 时，宿主查这张表最后一行就知道差多少、试过什么。

### 1.8 `recovery_rows` —— 恢复行（#769 / #827，两族语义不同，沿用第二版）

| 列 | 类型 | 说明 |
|---|---|---|
| `run_id` / `seq` | text / bigint | **PK** |
| `event` | text | `tool-executed` / `tool-result-unledgered` / `partial-text` |
| `round` | int | 槽事件按轮定界 |
| `dedup_key` / `payload_fingerprint` / `payload` / `created_at` | | 同 §1.2 的冲突判定 |

**两族语义必须在表上分开**：

- `event = 'partial-text'`：**槽**——同 `(run_id, round)` 只留一条、原子替换，且替换时跨轮自剪枝
  ⇒ `UNIQUE(run_id, round) WHERE event='partial-text'`；
- 其余事件：**只追加、永不替换、一行不丢**。

### 1.9 关系总图

```
runs 1─┬─N rounds ──────────┐
       ├─N folds ───────────┤ fold_round_rows (folds N─N rounds，精确到行)
       │      └─N:1 stages  │
       ├─N recovery_rows    │
       ├─N budget_verdict   │
       └─N notes 1─N note_history
                └─N note_ops
```

---

## 2. 从表反推端口

| 端口方法 | 落到 | 语义要点（不能只靠约束的地方写在这里） |
|---|---|---|
| `appendRound(runId, record)` | `rounds` | 冲突时比 `payload_fingerprint`：相等 ⇒ no-op(false)；不等 ⇒ 抛 `TranscriptDedupConflictError` |
| `load(runId)` | `rounds` ORDER BY seq → `foldMessageRows` | |
| `loadRawRows(runId)` | 同上不折 | |
| `loadByDedupKey` / `loadMaxRound` | 索引 | 可选快路径 |
| **`appendFold(runId, fold)`** | `folds` + `fold_round_rows` | 分配/复用 `seq`；`(from,to,prior)` 冲突 ⇒ no-op 且返回既有 `seq` |
| **`loadFolds(runId)`** | `folds` ORDER BY seq | resume 一次查询；兼容期并上旧轮记录里的 `foldedFacts`（§5） |
| **`appendStage` / `loadStages`** | `stages` | 阶段线，可选端口 |
| `appendRecoveryRow` 等 | `recovery_rows` | 槽事件走替换 + 跨轮剪枝；其余只追加 |
| run-state 四个 | `runs` | `markRunState` 是单行更新 |
| `note_*` | `notes` / `note_history` / `note_ops` | 白板走同一个端口，多一个 `board` 参数 |

**端口不该有的**：`record.foldedFacts` 作为轮记录的一部分（折叠只经 `appendFold`）；
`foldedPayload` 作为落盘字段（它是 §1.4 的派生查询）。

---

## 3. 关于"单一事实源"：第一版说过头了（第二版纠正，第三版沿用）

第一版说「摘要正文有四处副本，改成 `folds.body` 单一源，消息流里那份派生即可」。**这是错的**：

| 东西 | 真实身份 | 归属 |
|---|---|---|
| `folds.title` / `folds.description` | **折叠事实**（本折日志） | §1.3 的新表 |
| 实际喂给模型的那串字节 | **某一轮的请求事实**。今天字段名有两个，**别混**：`foldedSummary.text` 是折叠后**整条消息**的投影（含原任务正文与安全层插的 `[已修剪]`）；`foldedSummary.fedSummaryText` 才是「写侧当场证得的那一块」逐字副本，只在证得过时才落账 | 留在**该轮的记录**上，不从 `folds` 派生 |
| `requestStateBlock` | run 状态块的渲染 | run-state |
| `foldedPayload` | 被折走的原始消息 | **派生**（§1.4 的行集合查询），不落正文 |
| `compactionStats[].foldSummary` | 指标 | 诊断面，只放信号 |

准确主张：**折叠事实**有单一源（`folds`）；**请求事实**归轮记录；两者不混。

> 第三版新增一条：喂给模型的那串字节，**写点后移到请求组装处**（所有压缩层定稿之后）。
> 于是它记的就是"模型真正看到的那一串"，不再需要「钉住块对象身份 + 自证」（今天的
> `pickFedSummaryTextBlock` / `verified` / `pin_*` 全部消失）。

---

## 4. 上下文组装（第三版新增，本版的重点）

### 4.1 四层

```
┌────────────────────────────────────────────┐
│ 系统提示        固定（项目指令、常量、规矩）    │
├────────────────────────────────────────────┤
│ 遥远的回忆      只留 title，按轮次升序          │  ← 折数多时降级到这里
├────────────────────────────────────────────┤
│ 详细日志        title + description，按轮次升序 │  ← 最近的几折
├────────────────────────────────────────────┤
│ 白板            现状（约束 / 待办 / 教训）      │
├────────────────────────────────────────────┤
│ 活跃保留区      最近 K token 的原始消息          │
└────────────────────────────────────────────┘
```

**关键性质：不重写。** 每次折叠只追加一条 `folds` 行；旧行一个字不动。所谓"渐变"是
**对同一批日志按预算做梯度渲染**，不是"再摘要一次"。

### 4.2 渲染算法（确定性，零 LLM）

```
B = 窗口 × 2.5%                       ← **历史层**预算（白板另算，见 §4.3）
从最新一折往回：
  ① 60% B 给 description（每条 ≤ 500 token）
  ② 30% B 给 title（每条 ≤ 20 token）
  ③ 剩下给阶段线（每 10 折一行）
```

同一批记录 + 同一个预算 ⇒ 同一输出（golden 可测）。

### 4.3 预算划分

| 用途 | 200k 窗口 | 512k 窗口 |
|---|---|---|
| 白板（固定 **1500 token ≈ 1000 汉字**，不随窗口缩放） | 1.5k | 1.5k |
| 详细日志（60% B） | 3.0k | 7.7k |
| 遥远的回忆（30% B） | 1.5k | 3.8k |
| 阶段线（10% B） | 0.5k | 1.3k |
| **历史层合计（B = 2.5%）** | **5.0k** | **12.8k** |
| **白板 + 历史层** | **6.5k（3.3%）** | **14.3k（2.8%）** |
| 活跃保留区（4%） | 8k | 20k |
| 余量 | 16k | 16k |

白板**不跟着窗口缩放**：它是「必须一直在」的东西，大小应该由条目上限（§4.11）定，不由窗口定。
窗口小的时候宁可少放几条日志，不少放一条约束。

### 4.4 实测依据（为什么值得改）

一份 2,019 轮的会话，折叠 3 次，摘要 **3.9k → 5.9k → 6.9k token**（逐次增长），占折叠前上下文
1.2%–1.6%。增长的部分就是"每次重写整份"带进来的重复内容。按本版的局部日志口径，同样 3 次折叠
是 3 × 400 ≈ 1.2k，**不随折数增长**。（测量现场见 #971 评论。）

### 4.5 三条硬前提（缺一条这套就塌）

1. **`title` 必须是模型写的短标题。** 今天的 `titleFallback` 会退回"正文首行"——首行做不了"遥远的
   回忆"，它不是标题。回退必须留 `title_src='first_line'`，且这种记录**不进第一层**（只能进第二层）。
2. **`description` 必须自解释。** 今天的 prompt 已要求"不出现『上面』『刚才』『该文件』"。在旧形状里
   这是好习惯；在按轮次全量排列的新形状里它是**硬前提**——每条会被单独拿出来读。判据是机械的：
   出现依赖上下文的指代词 ⇒ 该折记录不合规。
3. **必须有阶段线。** 否则 `title` 数量线性增长（§1.5）。

### 4.6 折叠前的闸门

增量日志 + 白板漏记 = 那条信息永久离开上下文，而账本上看不出异常（折叠本身没错）。
所以需要一条**机械**判据（不靠模型自觉）：

> 折叠前检查区间内有没有"还没结清"的东西——未解决的 user 消息、失败的测试、未完成的待办。
> 有，且白板上找不到对应条目 ⇒ **拒绝折**，或强制先写白板。

### 4.7 不做"摘要的摘要"

分层的目的只是"保留可追溯的骨架"，而骨架用**阶段线 + 指针**表达：200 token，零调用，不失真。
再叠一层摘要要一次 LLM 调用 + 一份独立预算 + 自己也会膨胀，且每层都改写一遍，越往上越不准。

**层数上限 2（白板 + 日志）**。想加第三层，先回答"这一层的信息能不能压成 200 token 的阶段线"。
能，就不加层；不能，说明要的是"回忆细节"，那是账本的活，不是上下文的活。

### 4.8 渲染的边界与退化

| 情况 | 行为 |
|---|---|
| 估算与真实 tokenizer 不一致 | 按 **0.9B** 渲染（留 10% 余量）；provider 报 `context_window_exceeded` ⇒ 按 §1.7 记一行、**降一档重试一次**，同一档不许重试两次 |
| 窗口极小（装不下一条 description + 一条 title） | 降级顺序：最新一条 description → 只给 title → 只给阶段线 |
| 连一条阶段线都装不下 | **`cannot_fit` 显式失败**。不许静默只给保留区——模型会以为自己是从头开始的，然后重复劳动 |
| 任何一档装不下整条 | **降档，不夹断**。半条 description 比没有更坏：模型会补全不存在的细节 |

**永远不出现"零历史"**：至少留一条阶段线，让模型知道"你看到的历史是被折过的"。

### 4.9 白板与日志的边界

同一条信息只能住一处：

| 说的是 | 住哪 |
|---|---|
| "现在是什么"（约束、待办、已知的坑、当前阶段） | 白板 |
| "这一折发生了什么"（改了什么、验证了什么、为什么这么改） | 日志 |

两处都写的后果不是浪费 token，是模型读到**两份略有出入的版本**，然后按其中一份行动。

这条边界靠 prompt 约束 + 人工评审守，**不做脚本闸**——措辞类判定写 `if/else` 只会把注意力换成改常量
（本仓的既有纪律：脚本只判可机械判定的事实）。

### 4.10 折叠时一次调用产出三件事

折叠那次 LLM 调用同时产出：

1. `description`（本折日志）
2. `title`（短标题）
3. **白板更新指令**（`add` / `update` / `drop` 的结构化清单）

分开调用是两次付费、两次延迟，而且第二次看不到第一次的输入。

失败语义（必须写死，否则实现时一定被写成"静默忽略"）：

| 哪一步失败 | 行为 |
|---|---|
| `description` / `title` 解析不出 | 折叠失败（`summarizer_failed`）——没有日志的折叠等于没折 |
| 白板更新指令解析不出 | **折叠照常落账**，白板保持不变，记一条 `error_event`。**不许**写空的 `note_ops`（没发生操作就不留操作记录） |
| 某条 `add` 超过白板上限 | 该条不进，记一条 `op='drop'` 说明是被上限挡的（不是模型没提） |

### 4.11 两种文本的固定节

**`description`（本折日志）—— 5 节，固定顺序，约 400 token**

| 节 | 写什么 | 谁写 |
|---|---|---|
| `## 阶段` | 这一折做了什么、关键转折 | 模型 |
| `## 验证` | 跑过什么、结果如何（命令 + 结论） | 模型 |
| `## 卡点` | 没解决的、试过但失败的 | 模型 |
| `## 提交` | 这一折的 commit（短 sha + 标题） | **机械填**（从区间内的 `git commit` 结果里抓）；抓不到就留空 |
| `## 关键词` | 检索原文用的词（文件 / 工具 / 报错 / 未结事项） | 模型 |

**没有 `## 改动`（文件清单）**：文件清单能从 commit 里查，而且 Git 才是权威。要知改了什么，去看
commit；描述里只需要一串 commit 当索引。

**`## 提交` 必须机械填**：sha 不许由模型写——写错一个字符就是一个指向不存在对象的指针，
而账本上看不出来。抓不到就**留空**（无事实不写键）。

**为什么没有 `## 下一步`**：下一步属于"现状"，住白板。两处都写就会出现两份略有出入的版本，
模型会按其中一份行动。同理也不写"目标""约束""教训"。

**白板 —— 预算 1500 token（≈ 1000 汉字），4 类条目 + 1 条阶段线**

| 类（`kind`） | 渲染成 | 条目上限 | 单条上限 | 退场条件 |
|---|---|---|---|---|
| `constraint` | `## 约束` | 5 | 55 字 | 用户撤销 / 任务结束 |
| `todo` | `## 待办`（doing / waiting） | 6 | 45 字 | done（保留行但不注入） |
| `lesson` | `## 教训` | 2 | 70 字 | 被推翻 / 不再相关 |
| `fact` | `## 事实`（关键路径、常量、环境） | 4 | 45 字 | 被证伪 |
| 阶段线 | `## 阶段线` 一行 | 1 | 40 字 | 不淘汰 |

合计：5×55 + 6×45 + 2×70 + 4×45 + 40 + 段头 40 ≈ **945 字 ≈ 1400 token**，卡在 1500 以内。

白板**不是散文，是条目清单**：渲染时按上表顺序拼成 5 段，每段内按 `pinned` → `relevance` →
`updated_at` 排。退场条件是**状态**（done / 被推翻 / 被证伪），不是"多久没用到"——按时间淘汰就是
在做记忆模型，不是在做 agent。

---

## 5. 兼容与迁移

1. **读兼容不是"表空才回退"**：两边都读、**按完整折叠身份去重**——身份是
   `(from_round, to_round, prior_seq)` 三元组，**不是** `(from_round, to_round)`。
   同一区间先后有两个不同的折（恢复前 `prior_seq=NULL`、恢复后 `prior_seq=3`）是**两次折叠**，
   按区间去重会让新行盖掉旧行，§4 渲染就静默少一折。`folds` 行优先。
2. **迁移完成标记**：`runs.migration_folds_complete`。迁移在一个事务里写完再置 true；`loadFolds`
   在该标记为 true 之后才可以只读 `folds`。中途失败 ⇒ 标记为 false ⇒ 继续走合并读。
3. **写新**：新折叠只写 `folds` + `fold_round_rows`；轮记录不再写 `foldedFacts`。
4. **旧记录里的退役枚举值**（迁移必须交代，否则读侧会丢行）：

| 旧值 | 去哪 |
|---|---|
| `origin = 'mechanical'` | 原样保留（不改写历史），但该折 **不进第一、二层**，只进阶段线；渲染时标 `legacy=true` |
| `source = 'statistical'` / `'strategy'` | 同上 |
| `degradeReason = 'budget_fallback_mechanical'` | 原样保留，仅作审计；新代码不再产出该值 |
| 旧的 `text`（累计体） | 只用于生成 `description`（整段）与 `title`（首行），`title_src='first_line'`，标 `migrated=true` |

   规则是「**写侧收窄，读侧宽容**」：新行不可能再出现这些值，旧行读得回来、只是不冒充日志。
5. **旧记录没有 `title` / `description`**：迁移时从旧的 `text` 取首行当 `title`（`title_src='first_line'`），
   整段当 `description` 并标 `migrated=true`。这类记录只进第二层，不进第一层（§4.5 ①）。
6. **`foldedPayload` 退役**：从落盘字段变成派生查询（§1.4）。宿主若在读它，升级指南要给替代查询。
7. **版本**：`appendFold` / `loadFolds` / `appendStage` **先做成可选**（缺失 ⇒ 退回写轮记录字段 + 发一次
   `store_folds_channel_absent` 诊断），与 #769 恢复行、#157 快路径探针的既有做法一致；
   **下一主版本**才改成必需。
8. **宿主横幅的替代映射**（宿主今天读的五个字段都要有去处）：

| 今天宿主读 | 之后读 |
|---|---|
| `record.foldedFacts.text`（累计替代物） | 最新一折的 `folds.description`；要累计语义就按 `seq` 自己拼 |
| `record.foldedFacts.title` | `folds.title` |
| `record.foldedFacts.toolCalls` | 由 `fold_round_rows` 现查（不落表） |
| `record.foldedPayload` | §1.4 的派生查询 |
| `record.foldedRoundRange` | `folds.from_round` / `to_round` |

   `migration_folds_complete` 置 true 之后，旧字段一律为空——读旧字段的宿主会**静默拿到空横幅**，
   所以升级指南必须把这张表抄进去，并在迁移期同时写新旧两处。

---

## 6. 判据（落地时逐条钉住）

1. `rounds` 里**零** `foldedFacts`——**仅在 `appendFold` 能力在场且 `migration_folds_complete=true` 时**成立。
   能力缺失时的降级路径（§5.7 退回写轮记录字段 + 发诊断）是明文允许的，本判据不适用。
2. 同 `(from_round, to_round, prior_seq)` 重投 ⇒ 不新增行、`seq` 不变；同 `dedup_key` **异 payload**
   ⇒ 抛冲突（不许 no-op）；
3. resume 只查 `folds`（`migration_folds_complete=true` 时），**不**扫轮记录——用计数器证；
4. 迁移中途失败 ⇒ 标记 false ⇒ `loadFolds` 仍能给出完整集合（合并读，按身份去重）；
5. `fold_round_rows` 分两层测：
   - **store 层**（可测）：手工构造成员集合 ⇒ 精确查回，且"同轮多代行"不串代；
   - **引擎层**（今天做不到，标 blocked）：真实折叠必须能给出"被折消息 → 账本行 key"的成员身份。
     今天引擎只在内存 `messages` 数组上做折叠决策，唯一的行锚点是 `partOf` 首片 key（且只覆盖分片）。
     **这条判据的前置是补锚点**，不补就不能写成"落地即可验证"。
6. **渲染确定性**：同一批 `folds` + 同一预算 ⇒ 逐字节相同的四层输出（golden）；
7. **梯度降级**：把预算压到只够 3 条 description，断言第 4 条起变成 title、第 N 条起并进阶段线，
   且**没有任何一条被夹断**（降级不是截断）；
8. **`title` 硬前提**：`title_src='first_line'` 的记录不出现在第一层；模型没给 title 的折叠不许静默通过；
9. **`description` 自解释**（**只验词表，不冒充语义审查**）：机械检查"上面 / 刚才 / 该文件 / 前面提到"
   四个词，命中即该折记录不合规。它**不能**验证广义的"自解释"——那一半靠 prompt 与人工评审。
10. **白板**：CRUD 有 `note_ops` 记录；`purge` 跳过白板；`note_list` 默认不返回白板；上限 1200 字符满了
    必须淘汰（淘汰留 `op='drop'`）；
11. **折叠前闸门**（只取机械可判的那一半）：区间内存在**没有 `tool_result` 的 `tool_use`**
    ⇒ 拒绝折。"白板有没有对应条目"**不做闸**（无法机械判定）——改为折叠 prompt 强制要求产出
    "本折遗留事项"清单，并与白板的差异记进 `note_ops`，供人复核。
12. **超预算显式失败**：`cannot_fit` 终局时 `budget_verdict` 最后一行给出 budget / measured / over_by /
    layers_tried 四个数。
13. 内存 / 文件两种实现对同一操作序列产出逐字节相同的 `loadFolds()`。
14. **渲染留余量**：按 0.9B 渲染；provider 报超窗 ⇒ 降一档重试**一次**（同一档重试两次即红）。
15. **退化顺序**：把预算压到极小，断言顺序是「最新一条 description → 只给 title → 只给阶段线 →
    `cannot_fit`」，且**任何一步都不产出"零历史"**（判据：渲染结果里至少有一条阶段线或一折 title）。
16. **渲染不夹断**：输出里不存在半条 `description`（整条进或降一档）。
17. **合并调用的失败语义**（**只在闸门通过、折叠确实发生之后适用**；闸门拒折时本条不适用）：
    白板更新指令解析失败 ⇒ 折叠照常落账、白板不变、有一条 `error_event`，且 `note_ops` **零新增**。
18. **作废**：`superseded_by` 指向的那一折不再出现在渲染里，但行还在、`seq` 还在（append-only 不破）。

---

## 7. 不做

- **不做遗忘曲线 / 时间衰减**：遗忘已经天然存在——召回的信息留在保留区就清晰，保留区滑过去就模糊。
  该设计的是"什么不该被遗忘"（白板），不是"多久该忘"。
- **不做摘要的摘要**：只做梯度渲染（§4.7）。
- 不引入 ORM / SQL 依赖：DB 只是宿主的一种实现，`src/` 里仍只有 JSONL 与内存两种。
- 不把 `rounds.payload` 拆到块一级：原子单位是**消息**；只有需要 tool 三向 join 时才拆。
- 不做"无限保留历史原文"：原文在账本里，上下文只放骨架。

---

## 8. 第一版的错（留痕，别照抄回去）

| # | 第一版写的 | 事实 |
|---|---|---|
| 1 | `ON CONFLICT DO NOTHING` 就能表达 `appendRound` 幂等 | 同 key **异** payload 必须**抛**，no-op 会把冲突吞掉 |
| 2 | `folds` 只需 12 列 | 漏了 `toolCalls` / `summary` / `summaryDropped` / `descriptionTruncated` / `source` / `strategy` / `rounds` / `degradeReason`，且 `increment` 是结构化对象 |
| 3 | `bytes = body + description` | 现口径是 `text + summary` |
| 4 | `loadFolds` 在表空时回退扫旧记录 | 迁移中途失败会漏数据；要合并读 + 完成标记 |
| 5 | 消息流里那份摘要可由 `folds` 派生 | 它含任务原文与 `[已修剪]`，是**请求事实**，只在可验证时落账 |
| 6 | `foldedPayload` 永不持久化 | **它落盘**（咨询性字段），只在超限时被剥掉重试 |
| 7 | `recall_ask(fromRound,toRound)` 足以定位原文 | `(run_id, round)` 不唯一 ⇒ 需要 `fold_round_rows` |
| 8 | 本单即可把两个方法改成必需（主版本 +1） | 本仓先例是**先可选 + 降级诊断**，下一主版本才必需 |
| 9 | 引 `orchestrator.js:5136` 作为"写进轮记录" | 那是 `compactBeforeRound` 的返回值；真正赋值在 `:6440`，落盘在 `:6451` |

## 9. 第二版留下的七处（第三版改了什么）

| # | 第二版写的 | 第三版 |
|---|---|---|
| 1 | `folds.origin` 三个值都允许（`semantic` / `mechanical` / `host`） | 收窄到 `semantic` / `host`：折叠必须由 LLM 完成（#898），机械文本不是折叠 |
| 2 | `degrade_reason`（`budget_fallback_mechanical`）是一列 | 删掉。超预算的出路是"先用请求视图降级（TTL / 聚合 / 桩），再显式失败"，不是"塞一段机械摘要" |
| 3 | `fold_id` = `foldSummaryFingerprint`，指纹兼做幂等键 | 幂等键改成 `UNIQUE(run_id, from_round, to_round, prior_seq)`；续写基底用外键 `prior_seq`。哈希是为"没有行 id 的存储"发明的，有了主键就没有理由 |
| 4 | `foldedPayload` 的既有语义不动（咨询性、可剥、可落盘） | 有了 `fold_round_rows` 的精确行集合，副本没有存在理由 ⇒ 变派生查询（实测副本 940,278 B vs 原文 941,379 B，0.1% 冗余） |
| 5 | 折叠的产物是「一份累计文档」（`text`），另有 `increment` 表达本折 | 只存**本折**的 `description`；累计体退役。累计体会让同一段内容被压缩两遍以上（实测 3.9k → 6.9k） |
| 6 | 只有 `runs` 一层；`notes` "不变" | 白板 = `notes.board` 维度 + `note_ops`（**不新造实体**）。**不建 segment 表**：`rounds` / `runRounds` 两个计数器确实不同，但没有读者需要那个边界；要归因成本就查 `llm_call` 按轮聚合，不为此多一张表 |
| 7 | 没有"上下文怎么组装"这一节 | 新增 §4：四层 + 确定性渲染算法 + 预算划分 + 三条硬前提 + 折叠前闸门；并新增 `budget_verdict` 承载"装不下"的数字 |

**第二版做对、第三版原样保留的**：§1.2 的 `rounds` 形状与冲突判据、§1.4 的 `fold_round_rows`、
§1.8 的恢复行两族语义、§3 的"折叠事实 vs 请求事实"分层、§5 的合并读 + 完成标记、§8 的九条错账。
