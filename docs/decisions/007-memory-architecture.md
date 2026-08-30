# ADR-007：记忆系统架构——五层记忆 / episode / recall 三态 / 热冷双循环

- 状态：已决策（方向性架构，v1.x/v2 设计输入；v0.2 按"后果"节对齐）2026-08-29
- 背景：psyche 设计本意是"极小初始上下文 + 合适的回忆工具 = 无限扩展"，需 LLM 闲时整理归档；
  touwaka topics 是归档初步实现。外部调研见 docs/research/2026-08-29-memory-context-research.md
  （Letta sleep-time 双 agent、生产上下文工程三机制、A-MEM、Generative Agents）。
- 关联：ADR-002（档案/视图分离）、ADR-003（压缩谱系）、ADR-004（反思缓行与冷循环形态）、ADR-005（recall 内置理由）。

## 决策一：五层记忆模型 + 五种驱动

```
上下文内 │ L3 facts + 记忆地图（极小硬预算）  ▲ ⑤注入：session 开始
         │ L1 fold 摘要（替代被折轮次）        ▲ ②预算驱动：每轮检查
         │ L0 工作记忆（最近 N 轮原始消息）    ▲ ①循环驱动：每轮
─────────┼──────────────────────────────────
上下文外 │ L2 episode（摘要+索引+指针）        ▲ ③事件驱动（热归档）④闲时驱动（冷循环）
         │ 地基：TranscriptStore 完整原文      ▲ ①循环驱动（每轮快照）
                 ◀── recall 三态（⑤模型按需）──
```

| # | 驱动 | 执行者 | LLM 成本 | 作用于 |
|---|---|---|---|---|
| ① | 循环驱动（每轮自动） | runToolLoop | 0 | 地基、L0 |
| ② | 预算驱动（超阈值触发） | CompactionStrategy | 0 或 1 次/折叠 | L1 |
| ③ | 事件驱动（run/session 结束） | 热归档（调用方任务） | 1 次/episode | L2 诞生 |
| ④ | 闲时驱动（idle 定期） | 冷循环 agent（archive 槽） | 按频率配 | L2 整理、L3 蒸馏 |
| ⑤ | 按需驱动（模型/注入） | recall 工具 + session 注入 | 检索零 LLM 成本 | L2/L3 → 上下文 |

成本结构原则：**主循环（①②⑤）几乎不花 LLM 钱，理解性工作（③④）移出用户等待路径**（sleep-time compute 的 Pareto 改进）。

## 决策二：episode 定义——血缘，不是对应

episode = **一段完整"经历"的归档件**（借自认知科学情节记忆，与 L3 语义记忆对仗）。
边界 = **目标边界（run/task），不是轮数、不是消息下标、不是话题段**。
30 轮是一个 episode；30 轮 + 审计失败 + 再来 30 轮仍是一个 episode——审计失败是内部转折点，
不是边界。touwaka topics"时间连续段强对应消息"的切法已证伪（话题检测切错则语义碎）。

```js
episode = {
  id, summary,                    // 叙事重建；观测事实与推断意图分档标注（推断不进审计证据链）
  phases: [{ name, rounds, outcome }],       // 内部阶段/尝试结构
  index: { keywords, entities,
           decisions: [{ what, why }],
           openItems, importance /* 1-10，归档时 LLM 打 */,
           artifacts: { filesChanged, commits, verifiedBy } },  // 编码场景一等索引件
  sourceRef: [{ runId, fromRound, toRound }, ...],  // 指针数组：新建一段、合并追加、可跨 run
  access: { count, lastAt },      // recall 命中即 touch，喂养遗忘
}
```

指针语义三条：① **血缘非同一性**——回答"摘要从哪些原文来"，episode 是派生物，可合并/拆分/跨 session；
② **弱引用**——store 生命周期在调用方（ADR-002），指针可悬空，recall 取原文时优雅降级
（"原文已归档清理，仅存摘要"+ 可信度分档：原文可核对 > 仅有摘要 > 降级旧摘要）；
③ **不存原文副本**——单一数据源在 TranscriptStore，episode 保持轻量（衰减降级的对象）。

## 决策三：热冷双循环

- **热归档（③）**：run/session 结束触发；从**档案**（非上下文，fold 不影响档案，不变量 5）读全貌，
  **一次 LLM 调用同时产出 summary + index + phases**（索引与摘要同源，防漂移）。
  归档者看后见之明，能从工具序列/工件/审计结论反推真实因果链（learned context > raw context）。
- **冷循环（④）**：**独立 agent**（ADR-001 slot 扩展 "archive" 槽，可配更强模型），anytime 更新不阻塞主循环。三职责，可独立开关：
  ① 蒸馏 L3 facts（跨 episode 提炼，分区组织：偏好/项目事实/决策/未结）；
  ② 合并高重叠 episode / 拆分过粗的（sourceRef 追加，不重编号）；
  ③ 衰减：`access.count` 长期为零的摘要降档再折叠（**不删原文**）；
  冲突事实不覆盖，标 `supersededBy + 时间戳`（bi-temporal：事实会过期，旧值留档供审计）。
- **主循环零写工具**（sleep-time 核心教训：主 agent 挂记忆编辑工具又慢又不可靠）。
  模型说"记住这个" → 记在 transcript，冷循环自然提炼。例外：`note` 工具（显式偏好记忆）
  带项目政策，放调用方侧（touwaka INotesStore 是现成实现），不进库。

## 决策四：recall——单工具三态渐进（主循环唯一记忆工具）

工具预算纪律（外部实证 19 个精工具优于 46 个）：L3 facts/记忆地图走**注入**不走工具；
主循环只给一个工具，按参数渐进展开：

| 调用 | 行为 | 硬顶（默认可配） |
|---|---|---|
| `recall()` | 记忆地图：episode 一行一条（id/标题/重要性/时间/未结）+ 折叠水位线 | 500 tok，按 importance 截尾 |
| `recall({pattern})` | **优先用法**：搜索引件+已折轮次，grep -C 摘录 + 续查指针 | 单段 300 / 最多 5 段 / 总 1500 tok |
| `recall({episodeId}` 或轮次范围） | 回档案取原文（可对账）；悬空按决策二降级 | 单 result 500 / 总 2000 tok |

**四层防撑爆**：① 三态渐进（先小钱后大钱）；② 各档硬顶 + 截断路标（"[截断，共 12k，offset=5 继续]"，
不静默砍）；③ 回喂前过 `onToolResult` 海关（库提供 truncateToTokens 助手）；④ 系统自稳
（超预算下轮压缩泄洪）+ 防乒乓（stallDetection 抓重复签名；**fold 摘要须留痕**"已于第 X 轮 recall 过
'JWT'（结论：…）"，已回忆事实进摘要防重复回忆）。

**五层引导**（模型不会自觉 recall，引导是设计出来的）：
① 摘要面包屑——fold 摘要带主题词/未结事项/可操作 recall 示例（摘要是检索索引的上下文投影）；
② 低摩擦接口——**pattern 优先，round 范围辅助**（对 v0.2 recall 规格的直接修正），空结果给替代建议；
③ description 写触发时机；④ **循环主动提示**——检测到迷失信号（重复劳动/stall 前兆）注入
"早期轮次已折叠，可 recall 找回"（runToolLoop 钩子，框架级产品需硬编码，我们是库给挂载点）；
⑤ 记忆地图注入初始上下文。

## 决策五：编码场景特化

编码的记忆原料是**动作不是言语**：`记忆 = 工件证据（硬） + 工具序列（足迹） + 归档推断叙事（软，标注） + 少量决策便签`。

- `index.artifacts`（filesChanged/commits/verifiedBy）是一等索引件——"当时为什么这么改"最佳证据是
  diff/文件现状/测试结果，recall 时可重读重跑（状态所在地原则第三次应用）。
- 思考缺口（想了很多没说）解法 = 归档重建 + 工件核对 + 推断标注，**不是逐轮记录**；
  决策便签走调用方 prompt 政策（"方向性决策用一句话说明理由"）；
  thinking 块若上游回传则存 store 不进上下文（raw 逃生舱，v1.x 再议，加分项非主防线）。
- 此节再次印证 ADR-004：编码场景"为什么"能在归档时从工件重建，每轮反思是成本翻倍买寂寞。

## 决策六：分期路线与评测纪律

| 步 | 内容 | 独立验收 |
|---|---|---|
| 1. v0.2 | file store + recall（pattern 优先）+ fold-llm（摘要模板含"禁止重做"+主题词面包屑+留痕）+ tools 子路径 | recall 好用吗 |
| 2. 记忆评测夹具 v1（随 v0.2） | 植入已知事实的长对话 → 折叠 → 提问 → 断言命中率与**模型自发调用率** | 后续一切记忆工作的回归网 |
| 3. app_container 迁移 | 24 轮真实场景 | 校准预算默认值、真实重做率 |
| 4. v1.x | clear-results（ADR-003 ①a）+ episode 结构 + ArchiveStore 接口（内置 memory/file）+ 热归档 | 索引件抽取质量 |
| 5. v2 | psyche + 冷循环（archive 槽）+ L3 facts 注入 + episode 建链 | 全管道召回率 |

纪律：**检索件先行、每步独立验收、后一步不许 degrade 前一步指标**（冷循环蒸馏若降低召回率即回滚）。
记忆系统最大失败模式是"架构漂亮、召回稀烂"，评测夹具是唯一防线。

## 附录：示例场景（真实案例锚定）

以 2026-08-29 erix-agent v0.1 开发（~40 轮工具调用）为完整示例：
episode 含 phases（契约脚手架→四 worker 并行→集成排障→合入）、decisions（relay 拒 Qwen3.5 换
kimi-for-coding；强制压缩 e2e 用 initialMessages 构造历史确定性触发）、artifacts（31 文件/commits 8cd7022/
92 测试绿）、openItems（app_container 迁移）；三天后 recall({pattern:"强制压缩"}) 命中摘录、
access.count++；一周后冷循环蒸馏出 L3 fact"my-relay token 未开通 Qwen3.5"进初始上下文；
后来开通则旧 fact 标 superseded 留档；三个月未再访问则摘要降档、40 轮原文不动。
（该示例同时是 v0.2 记忆评测夹具的设计参考。）
