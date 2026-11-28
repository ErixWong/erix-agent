# ADR-022：先按关系库设计，再反推 store 端口（折叠记录升为独立事实）

> **状态补充（2026-11-27）——表结构部分已被形状设计稿取代。** 本文记录的是**第二版**的提案：它把折叠的
> 产物当成「一份累计文档」。现行的形状设计在
> [`docs/design/2026-11-27-context-and-fold-shape.md`](../design/2026-11-27-context-and-fold-shape.md)
> ——折叠改为**每次一条局部日志**，原文不复制，上下文按预算梯度渲染。本文正文**一字未改**（决策记录不
> 事后重写），做对的部分（`rounds` 形状、`fold_round_rows`、恢复行两族语义、事实分层）被设计稿原样沿用。

> **第二刀（2026-11-28）——`folds` 的列集合落到形状稿的九列，外加一个幂等键。** 本文 §1.3 要求
> 「与 `buildFoldedFacts` 的返回键逐键对齐，一个都不许丢」；那条规则把**实现细节当成了契约**：
> `buildFoldedFacts` 是「一份累计替代物」那个形状的产物。第二刀按形状稿
> （[`docs/design/2026-11-27-context-and-fold-shape.md`](../design/2026-11-27-context-and-fold-shape.md)
> §1.4）定为九列，**外加 `fold_id`**（理由见下）。正文**不改**（同一纪律：决策文不事后重写），
> §1.3 与 §5 判据 8 里的旧列集合**已被本节取代**。
>
> | 列 | 类型 | 说明 |
> |---|---|---|
> | `run_id` / `seq` | text / bigint | **PK(run_id, seq)**；`seq` 由写入方分配（§1.3 末段那条分配器逻辑不变） |
> | `fold_id` | text | **UNIQUE(run_id, fold_id)** —— **幂等键**，见下 |
> | `cut_round` / `cut_msg_seq` | int | 切点：这一折吃掉「≤ 此切点」的全部消息 |
> | `from_round` | int | **本折覆盖的第一轮**（261128-13 补）。切点单独表达不了「吃了哪些轮」：真机现场 `1–5, 6–6, 8–8` 有口子（第 7 轮一轮未折，`src/compact/fold-statistical.js:834` 引的原始数据），只按「上一折切点 + 1」推会把它误报成已折 |
> | `rounds` | int | **本折轮数**（同上）。它不总等于区间长度——`buildFoldedFacts` 单独收 `input.rounds`，统计折的真实计数可能不同 ⇒ 单独存，不靠算术推 |
> | `title` | text | 模型写的短标题，可空；模型没给就是 `NULL`（**新写入必须绕过 `buildFoldedFacts` 的首行回退**，否则回退出来的标题会被当成模型标题存下） |
> | `description` | text | 模型写的三节（行动 / 遗留 / 关键词），约 400 token |
> | `tokens_before` / `tokens_after` | int | 折叠前后上下文 token（省了多少挂在折上） |
> | `created_at` | timestamptz | 信封时刻 |
>
> **为什么形状稿的九列不够：幂等键不是行身份。** 形状稿 §1.4 写「折叠身份就是主键 `(run_id, seq)`，
> 不需要哈希」——那对**读**成立，对**写**不成立：`seq` 是写入时分配的，重投同一份折叠会拿到**新号**，
> 于是「同一次折叠重放」变成两行。现有两个实现都靠 `foldId` 去重：`src/store/folds.js:8-9`
> （「命中已投的 `foldId` 拿回首次那个号」）、`src/store/memory.js:261-264` 与 `src/store/file.js:817-820`
> （按 `foldId` 找已有行）。所以 `fold_id` 是**必需列**，形状稿这一句要按此更正。
>
> **累计正文 `text` 不是列**：它是「`seq ≤ n` 的 `description` 按序拼接」这个函数。存它就是同一件事
> 存 N 份、每份越来越长（实测摘要 3.9k → 5.9k → 6.9k token，涨的全是重复），而且每次重写不可审计。
>
> **「退役」= 不再是列，不等于不再是宿主可见的键。** `foldedFacts` 是**契约面**
> （`docs/host-consumer-contract.md:6962` 逐字列出 `{ text, source, strategy, from, to, rounds, bytes,
> truncated?, degradeReason?, foldId, seq }`，`onFoldSummary` 还把它整份递给宿主）。所以下面这张表说的是
> **表里不再存**，宿主侧那些键要么由九列**导出**，要么按废弃流程单独走——不能因为「没人读」就当它不存在。
>
> | 代码里的键 | 表里被什么取代 | 宿主可见性 |
> |---|---|---|
> | `text` | `description` 按 `seq` 拼接渲染（函数） | 契约键，**仍递**（导出值）；`recall_ask` 的证据面要改成按 `cut_round` 取原文 |
> | `summary` / `summaryDropped` | 并进 `description`；「被挤掉」不再是状态——解析不出就是折叠失败 | 契约未单独列 `summaryDropped` |
> | `origin` / `source` / `strategy` | 折叠文本的作者只有一种（引擎摘要器） | `source` / `strategy` 是**契约键**，导出值；`origin` 零读者零契约 |
> | `toolCalls` | `description` 的 `## 行动` | 契约未单列 |
> | `bytes` / `bytesBefore` / `truncated` | `tokens_before` / `tokens_after`（只留预算尺子） | `bytes` / `truncated` 是**契约键**（`:6962` 逐字列出），导出值；`bytesBefore` 零读者零契约 |
> | `degradeReason` | 不降级：解析不出就是折叠失败 | **契约键**（可选），导出值 |
> | `fingerprint` | 并入 `fold_id`（同一身份） | 契约里由 `foldId` 承担 |
> | `titleFallback` | `title IS NULL` 就是「模型没给」 | 零读者零契约 |
> | `descriptionTruncated` | 今天零读者零契约（`src/` 只有转发链，契约零提及） | 零读者零契约 |
> | `from` / `to` / `rounds` | `cut_round` + 上一折切点（`seq-1`）推出区间 | **契约键**（`:6962` 列出 `from`/`to`/`rounds`），导出值 |
> | `increment` | 就是这一行本身（一折一行，没有"增量"这回事） | 契约未单列 |
> | `trigger` | **不是 `buildFoldedFacts` 的键**，也**不是** `folds` 的列 | 它是一等可选字段挂在 `compactionStats` 上（`orchestrator.js:275`、`:2780`），契约有审计语义 ⇒ **继续留在 `compactionStats`**，不进 `folds` |
>
> **落地时要跟着改的读点**（只列 `recall_ask` 是不完整的）：
>
> | 读点 | 现在读什么 | 九列之后 |
> |---|---|---|
> | `src/loop/recall-runner.js:27` | 折叠事实的 `text` | 按 `cut_round` 去 `rounds` 取原文 |
> | `src/compact/resume-fold-trim.js:105` | `fact.text` + `foldedRoundRange.to` | 按 `seq` 取 `description` 拼接 |
> | `src/compact/fold-statistical.js:790` / `:544` | `summary` / `toolCalls` | 这两个键不再由折叠产生 |
> | `onFoldSummary` 的 payload | `{ ...foldedFacts, round }` 整份 | 由九列导出同样的键（契约面不动） |
>
> **§2 端口与 §5 判据 8 跟着变**：`appendFold(runId, fold)` 的入参是上表九列 + `fold_id`（**不含累计
> `text`**），且必须保持「同 `fold_id` 重投 ⇒ 返回首次那个 `seq`」；`loadFolds(runId)` 返回**局部日志
> 序列**，不是一份累计正文；判据 8 从「与 `buildFoldedFacts` 逐键对齐」改成「与本节列集合逐列对齐，
> 且每个没有列的键都在退役表里有一行并注明宿主可见性」。

- 状态：Proposed（2026-11-27，第二版）
- 关联：#896（召回层）、#601（折叠记录账本）、#567（foldId/seq）、#769（恢复行独立通道）、#827（partial 槽）、
  ADR-018（notes）、ADR-020（transcript 单一来源）
- 触发：用户指出「折叠后的记录没有自己的位置」——它寄生在**触发折叠那一轮的轮记录字段** `record.foldedFacts` 上。
- **第二版修订**：第一版被审查否掉四处硬事实（见 §7「第一版的错」）。本版逐条改，不再声称任何未验证的东西。

---

## 0. 为什么先设计表

现有形状是**从文件存储反推出来的**：一 run 一个 transcript `.jsonl`（另有 recovery / partial / state 侧车），
一次折叠发生时把 `foldedFacts` 挂在那一轮的记录上。于是「一次跨轮区间的折叠事件」被存成「某一轮的一个字段」，
读的时候要扫全表挑字段（`orchestrator.js:2332-2346` 的 resume）。

本文反过来：**先写清关系模型（表、主键、约束、索引、并发语义），再从表推出端口方法**。
文件存储届时是这套模型的一种投影（一表一侧车），`src/` 仍然零 npm 依赖。

---

## 1. 关系模型

### 1.1 `runs`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `run_id` | text | **PK** | |
| `status` | text | | 终态字符串（`loadRunStateStatus` 读它） |
| `state` | jsonb | | `saveRunState` / `loadRunState` 载荷 |
| `migration_folds_complete` | bool | not null default false | §4 的**迁移完成标记**（原子判据，不是"表非空"） |
| `created_at` / `updated_at` | timestamptz | not null | |

### 1.2 `rounds` —— 消息行流（**不存折叠事实**）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `run_id` | text | **PK₁**, FK→runs | |
| `seq` | bigint | **PK₂** | run 内严格递增（落盘序） |
| `round` | int | not null | 轮号 > 0 |
| `kind` | text | not null | `round` / `message` |
| `dedup_key` | text | not null | 口径**逐字照** `recordKey`：`dedupKey ?? roundKey ?? "<runId>:round:<round>"` |
| `payload_sha256` | text | not null | `payloadFingerprint(record)` 的值（`transcript-dedup.js:189`） |
| `payload` | jsonb | not null | 该行内容 |
| `created_at` | timestamptz | not null | |

约束：`PK(run_id, seq)`；**`UNIQUE(run_id, dedup_key)`**；索引 `(run_id, round DESC)`（`loadMaxRound`）、
`(run_id, kind, round)`。

> ⚠ **唯一约束本身不等于现有的幂等契约。** 现有口径（`transcript-dedup.js:72-75`、`file.js:379-396`）是：
> 同 key **同 payload** ⇒ 幂等 no-op 返回 false；同 key **异 payload** ⇒ 抛 `TranscriptDedupConflictError`。
> 单纯 `ON CONFLICT DO NOTHING` 会把后者**静默吞掉**。所以 `appendRound` 的 DB 实现必须写成
> 「插入；冲突时比较 `payload_sha256`：相等 ⇒ 返回 false；不等 ⇒ 抛」——`payload_sha256` 列就是为这一步存在的。

### 1.3 `folds` —— 一次折叠 = 一行（新表）

列集合**逐键对齐** `buildFoldedFacts` 的返回值（`fold-summary-journal.js:736-766`），一个都不许丢：

| 列 | 类型 | 说明（对应 `foldedFacts` 的哪个键） |
|---|---|---|
| `run_id` / `seq` | text / bigint | **PK(run_id, seq)**；`seq` = `#567` 的 run 内严格递增折叠序 |
| `fold_id` | text | **UNIQUE(run_id, fold_id)**；= `foldSummaryFingerprint` 的值，幂等键 |
| `fingerprint` | text | `foldedFacts.fingerprint`（与 `fold_id` 同源但**分开存**：历史记录可能只有其一） |
| `from_round` / `to_round` | int | `from` / `to`（区间） |
| `rounds_count` | int | `rounds`（本折吃掉的轮数） |
| `text` | text | `text`（累计替代物正文，≤4096 字节） |
| `title` | text | `title` |
| `title_fallback` | bool | `titleFallback`（语义折但模型没给标题） |
| `origin` | text | `origin`：`semantic` / `mechanical` / `host`（**三个值都允许**，不是只有两个） |
| `source` | text | `source`（默认 `strategy`）——与 `origin` **语义不同**，不许合并 |
| `strategy` | text | `strategy`（默认 `unknown`） |
| `summary` | text | `summary`（描述/摘要段，独立子配额） |
| `summary_dropped` | bool | `summaryDropped`（被挤掉，不是"模型没写"） |
| `description_truncated` | bool | `descriptionTruncated` |
| `tool_calls` | jsonb | `toolCalls`（≤8 条 × ≤80 字符） |
| `increment` | jsonb | `increment` **整体**：`{text, title, origin, from, to, rounds, bytes, truncated, bytesBefore}` |
| `bytes` | int | `bytes` = **`text` + `summary`** 的字节数（第一版写成 `body + description` 是错的） |
| `truncated` / `bytes_before` | bool / int | `truncated` / `bytesBefore` |
| `degrade_reason` | text | `degradeReason`（≤120 字符） |
| `trigger` | text | `#930` 的 `trigger`。**取值以代码为准**：`budget` / `context_window_exceeded` / 其余（`orchestrator.js:278`）。⚠ `trigger` **不在** `buildFoldedFacts` 的返回里（它记在 `compactionStats` 上，`orchestrator.js:4180-4182,5047-5049`）⇒ 它是**本 ADR 新增的列**，不是"从 foldedFacts 搬过来" |
| `created_at` | timestamptz | |

索引：`PK(run_id, seq)`；`UNIQUE(run_id, fold_id)`；`(run_id, from_round, to_round)`。

**`seq` 的分配**（现有实现是应用层分配器，`fold-summary-journal.js:263-303`）：DB 侧用
`folds_seq(run_id PK, next bigint)`，一次事务内 `next = next+1`；`INSERT … ON CONFLICT (run_id, fold_id)
DO NOTHING` 后再 `SELECT seq WHERE fold_id` ⇒ 同 `fold_id` 重投拿回**同一个** `seq`，新折叠接在最大值之后。
约束不能代替这段逻辑，所以端口方法必须写明它，而不是声称"唯一约束就够了"。

### 1.4 `fold_round_rows` —— 这次折叠**吃掉了哪些轮记录行**（新表）

`(run_id, round)` **不唯一**（崩溃轮有消息行 + 轮载体行；同一轮在 restore / 重折之后可能有多代行），
所以「`from_round..to_round` 反查原文」**定位不到那一代行**。必须记成员关系：

| 列 | 约束 |
|---|---|
| `fold_run_id`, `fold_seq` | FK → `folds(run_id, seq)`，**PK₁₂** |
| `round_run_id`, `round_seq` | FK → `rounds(run_id, seq)`，**PK₃₄** |

`recall_ask(foldSeq)` 因此拿到的是**精确的行集合**，而不是一个可能对不上代的轮号区间。

### 1.5 `recovery_rows` —— 恢复行（#769 / #827，两族语义不同）

| 列 | 类型 | 说明 |
|---|---|---|
| `run_id` / `seq` | text / bigint | **PK** |
| `event` | text | `tool-executed` / `partial-text` / … |
| `round` | int | 槽事件按轮定界 |
| `dedup_key` | text | 恢复行也有去重键（`file.js:683-688`） |
| `payload_sha256` | text | 同 §1.2 的冲突判定 |
| `payload` | jsonb | |
| `created_at` | timestamptz | |

**两族语义必须在表上分开**：

- `event = 'partial-text'`：**槽**——**整个 run 只留一条**（不是每轮一条）、原子替换，且替换时**跨轮自剪枝**
  （旧轮的 partial 行一并删；读侧只认崩溃轮，`file.js:429-432,486-517`）
  ⇒ 约束**应当**是 **`UNIQUE(run_id) WHERE event='partial-text'`**（第二版写成 `(run_id, round)` 是错的：那样会
  允许每轮各留一条，而实现是把旧轮的行一起剪掉）。
  ⚠ 但**现有实现只是逻辑上唯一**：合并冲突重试若干次后它会**退回追加**，可能留下重复行
  （`file.js:583-586`）。所以 DB 侧的条件唯一约束是**收紧**，不是"把现状照搬"——迁移时要先按 `(run_id)`
  去重（保留最后一条），否则建约束会失败；
- 其余事件：**只追加、永不替换、一行不丢**。

文件侧今天已经是两个文件分流（`.partial.jsonl` 整文件重写 / `.recovery.jsonl` 只追加，`file.js:687-688`），
DB 侧用上表的条件唯一约束表达同一件事。

### 1.6 `notes` / `note_history`（ADR-018，不变）

`notes(run_id, key, current jsonb, state, pinned, provenance jsonb, created_at, updated_at, revoked_at)`，
PK(run_id, key)，索引 `(updated_at)` 供保留期物理删除；
`note_history(run_id, key, version, payload, state, created_at)`，PK(run_id,key,version)。

### 1.7 关系总图

```
runs 1─┬─N rounds ────┐
       ├─N folds ─────┤ fold_round_rows  (folds N─N rounds，精确到行)
       ├─N recovery_rows
       └─N notes 1─N note_history
```

---

## 2. 从表反推端口

| 端口方法 | 落到 | 语义要点（不能只靠约束的地方写在这里） |
|---|---|---|
| `appendRound(runId, record)` | `rounds` | 冲突时比 `payload_sha256`：相等 ⇒ no-op(false)；不等 ⇒ 抛 `TranscriptDedupConflictError` |
| `load(runId)` | `rounds` ORDER BY seq → `foldMessageRows` | |
| `loadRawRows(runId)` | 同上不折 | |
| `loadByDedupKey` / `loadMaxRound` | 索引 | 可选快路径 |
| **`appendFold(runId, fold)`** | `folds` + `fold_round_rows` | 分配/复用 `seq`（§1.3）；同 `fold_id` 重投 ⇒ no-op 且返回既有 `seq` |
| **`loadFolds(runId)`** | `folds` ORDER BY seq | resume 一次查询；**兼容期还要并上旧轮记录里的 `foldedFacts`**（§4） |
| `appendRecoveryRow` 等 | `recovery_rows` | 槽事件走替换 + 跨轮剪枝；其余只追加 |
| run-state 四个 | `runs` | `markRunState` 是单行更新 |
| `note_*` | `notes` / `note_history` | 不变 |

**端口不该有的**：`record.foldedFacts` 作为轮记录的一部分（折叠只经 `appendFold`）。
**端口管不了的**：`foldedPayload` —— 见 §3。

---

## 3. 关于"单一事实源"：第一版说过头了，本版纠正

第一版说「摘要正文有四处副本，改成 `folds.body` 单一源，消息流里那份派生即可」。**这是错的**，逐条纠正：

| 东西 | 真实身份 | 归属 |
|---|---|---|
| `folds.text` / `folds.summary` / `title` … | **折叠事实**（给宿主与账本读） | 本 ADR 的新表 |
| 实际喂给模型的那条 user 消息（`fedSummaryText`） | **某一轮的请求事实**：它含任务原文与安全层插的 `[已修剪]`，并且只在"能被验证"时才落账（`orchestrator.js:4793-4864`） | 留在**该轮的记录**上，不从 `folds` 派生 |
| `requestStateBlock` | run 状态块的渲染 | run-state（`orchestrator.js:5138`、`:5729-5770`） |
| `foldedPayload` | **归档的原始消息**（咨询性字段），**会被持久化**在轮记录里；单条记录超限时**可被剥掉重试**（`orchestrator.js:6425`、`:6451`、`:6453-6477`） | 轮记录（咨询性），不是折叠事实 |
| `compactionStats[].foldSummary` | 指标 | 诊断面，只放信号 |

所以本 ADR 的准确主张是：**折叠事实**有单一源（`folds`）；**请求事实**仍归轮记录；两者不混。
第一版说 `foldedPayload` "永不持久化"是**硬错误**（它确实落盘，只是超限时可剥）。

---

## 4. 兼容与迁移

1. **读兼容不是"表空才回退"**（第一版错了：迁移中途失败会让表非空、于是漏掉未迁的那些）。
   正确口径：**两边都读、按折叠身份去重**——`loadFolds` = `folds` 行 ∪ 旧轮记录里的 `foldedFacts`，
   以 `fold_id ?? fingerprint ?? (from,to,text 的哈希)` 为身份去重；`folds` 行优先。
2. **迁移完成标记**：`runs.migration_folds_complete`。迁移在一个事务里写完再置 true；`loadFolds`
   在该标记为 true 之后才可以只读 `folds`。中途失败 ⇒ 标记为 false ⇒ 继续走合并读。
3. **写新**：新折叠只写 `folds` + `fold_round_rows`；轮记录不再写 `foldedFacts`。
4. **版本**：`appendFold` / `loadFolds` **先做成可选**（缺失 ⇒ 退回写轮记录字段 + 发一次
   `store_folds_channel_absent` 诊断），与 `#769` 恢复行、`#157` 快路径探针的既有做法一致；
   **下一主版本**才改成必需。第一版说"本单直接主版本 +1、改成必需"不符合本仓先例。

---

## 5. 判据（落地时逐条钉住）

1. `rounds` 里**零** `foldedFacts`（grep + 一条"新折叠后轮记录字段为空"的断言）；
2. 同 `fold_id` 重投 ⇒ 不新增行、`seq` 不变；同 `dedup_key` **异 payload** ⇒ 抛冲突（不许 no-op）；
3. resume 只查 `folds`（`migration_folds_complete=true` 时），**不**扫轮记录——用计数器证；
4. 迁移中途失败 ⇒ 标记 false ⇒ `loadFolds` 仍能给出完整集合（合并读，按身份去重）；
5. `recall_ask(foldSeq)` 的原文来自 `fold_round_rows` 的**精确行集合**；构造"同轮多代行"用例证它不串代；
6. 改 `folds.text` ⇒ 宿主读到的折叠事实变；**消息流里那条已发出的摘要不变**（证两者不是同一份）；
7. 内存 / 文件两种实现对同一操作序列产出逐字节相同的 `loadFolds()`；
8. `folds` 的列集合与 `buildFoldedFacts` 的返回键**逐键对齐**（一条表驱动断言，漏一个键就红）。

---

## 6. 不做

- 不引入 ORM / SQL 依赖：DB 只是宿主的一种实现，`src/` 里仍只有 JSONL 与内存两种。
- 不把 `rounds.payload` 拆成"一条消息一行"：原子单位是**轮**（`foldMessageRows` 的口径）。
- 不动 `foldedPayload` 的既有语义（咨询性、可剥、可落盘）。

---

## 7. 第一版的错（留痕，别照抄回去）

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
