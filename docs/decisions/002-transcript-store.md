# ADR-002：消息存取走 TranscriptStore 适配器，内置 memory + file(JSONL)

- 状态：已决策（2026-08-29）
- 背景：循环本身只需要内存数组。持久化的价值在三点：
  ① **崩溃续跑**——app_container 现状是 task 失败从头重跑，24 轮开发烧掉全部已付 token；
  ② **审计**——每轮 transcript 可追溯（两项目都有此诉求）；
  ③ **recall 的数据源**——折叠的原文要有处可查（ADR-005）。

## 决策

定义 `TranscriptStore` 接口（appendRound / load / recall），内置两个实现：

| 适配器 | 形态 | 用途 |
|---|---|---|
| `memory` | 进程内 Map | 默认；一次性任务、测试 |
| `file` | `dir/<runId>.jsonl`，**每轮一行**追加 | 崩溃续跑 + 审计 + recall 后端 |

JSONL 记录格式：

```json
{"round": 7, "folded": false, "ts": "…", "messages": [ /* 本轮新增的 canonical 消息 */ ]}
{"round": 8, "folded": true,  "ts": "…", "messages": […], "foldedPayload": [ /* 被折叠轮次原文 */ ]}
```

**关键语义：fold 只影响上下文，不影响档案。** 被折叠的轮次完整留在 store，
`load()` 可重建完整历史；`recall(fromRound, toRound, pattern)` 对原文做范围读取/grep。

**崩溃续跑**：`runToolLoop({ store, runId, resume: true })` 启动时 `load()` 恢复消息与轮次，
从断点继续。app_container 的 reaper 任务级重试由此从"从头重跑"升级为"断点续跑"。

DB 适配器（app_container 落 `task_runs`、touwaka 落 payload 缓存）留在项目侧实现同一接口。

## 理由

- JSONL 追加写天然崩溃安全（不会像整块 JSON 写一半损坏），按行流式读天然支持 recall grep。
- 文件是零基础设施的最低公分母，与 ADR-001 同一哲学。
- "上下文视图"与"完整档案"分离是这个库的核心心智：压缩是对**视图**的操作，档案永远完整。

## 后果

- file store 目录需要调用方管理生命周期（任务结束清理/归档），库只提供 `load/recall`，不做 GC。
- runId 唯一性由调用方保证（建议 = 任务/run 主键）。
- **档案完整性补记（2026-08-29，v0.2 记忆基准实测发现）**：
  ① 初始消息（initialMessages/initialUserMessage）不进每轮增量记录——runToolLoop 启动时先写
  **round 0 种子记录**，否则初始历史永不在档案中，fold 后 recall 找不到；resume 续跑基数改取
  max(record.round)（兼容种子记录）。
  ② `recall` 检索语料必须**同时覆盖 record.messages 与 record.foldedPayload**（被折轮次的原文在
  foldedPayload 里）——memory/file 两实现及 tools/recall 均已修正并加回归测试。
