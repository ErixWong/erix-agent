# 调研：记忆系统与上下文压缩的外部实践（2026-08-29）

> 目的：为 v2（psyche / 记忆系统）与 v0.2（fold-llm / recall）吸收业界已验证的做法。
> 方法：unifuncs 联网检索 + 原文精读（Letta sleep-time blog、生产上下文工程综述）。
> 结论分三部分：外部实践扫描 → 我们设计被验证的部分 → 需要吸收的修正。

## 1. 外部实践扫描

### 1.1 Letta（MemGPT）：分层记忆 + sleep-time compute

- **三级记忆**：core memory（上下文内，块式可编辑）/ archival memory（agent 自主写入的外部存储）/
  recall memory（对话历史检索）。最新形态 **MemFS**：git 仓库支撑的记忆文件系统。
- **Sleep-time compute**（[blog](https://www.letta.com/blog/sleep-time-compute/) / [arXiv 2504.13171](https://arxiv.org/abs/2504.13171)）：
  **双 agent 架构**——primary agent 管对话（**故意不给** core memory 编辑工具），
  sleep-time agent 在闲时异步重写/整理双方记忆，可独立配更强模型（主 agent gpt-4o-mini，
  睡眠 agent gpt-4.1/Sonnet），以 "anytime" 方式更新（主 agent 随时可读，不等整理完成）。
  动机与我们完全一致：单 agent 边对话边管记忆**又慢又不可靠**；增量形成的记忆会变乱，
  需要持续重写保持 clean。实证：数学基准上 Pareto 改进（成本移入闲时，性能不降）。

### 1.2 生产级上下文工程（Anthropic cookbook / tianpan.co 综述 / JetBrains 研究）

三种**正交**机制，组合使用：

| 机制 | 成本 | 保真度 | 要点 |
|---|---|---|---|
| compaction（LLM 摘要） | 有推理成本 | 有损高保真 | 阈值默认 150K/最小 50K；自定义摘要提示词全权负责保留项 |
| **tool-result clearing** | **零推理成本** | 机械修剪 | 旧 tool_result 替换为占位符，**保留 tool_use 记录**；`exclude_tools` 保护有状态结果（记忆/凭据/任务状态） |
| external memory（记忆工具） | 低 | 持久 | agent 自主读写外部文件（Claude Code 的 NOTES.md 模式），跨 session |

关键实证：

- **JetBrains（SWE-bench Verified, 2025-12）**：observation masking（滚动窗口只留最近 N 个完整工具结果）
  对 Qwen3-Coder 480B **成本降 52% 且解决率反升 2.6%**——"可重获取的输出清掉是安全的"被实证
  （= 我们 ADR-003"状态所在地原则"的独立验证）。
- **反直觉警告：LLM 摘要使轨迹长度增加 13–15%**（摘要掩盖自然停止信号，agent 超过最佳停止点继续尝试）；
  摘要成本可超实例总支出 7%。→ 压缩不是免费午餐，需监控压缩后轨迹长度。
- **上下文腐烂（context rot）**：GPT-4 准确率随信息位置从 98.1% 跌到 64.1%；
  应在**有效窗口 ~70%** 触发压缩，而非等硬限制（腐烂后连摘要质量都下降）。
- 预算分配参考：系统 10–15% / 工具 schema 15–20% / 检索知识 30–40% / 历史 20–30% / 缓冲 10–15%。
- 工具数量控制：19 个设计良好的工具优于 46 个（决策瘫痪吃注意力）。
- 衡量核心指标：**任务完成率作为任务中点上下文大小的函数**——定位"有效窗口"的真实位置。

### 1.3 独立记忆产品（Mem0 / Zep / LangMem 等）

- **Mem0**：记忆层（非 agent runtime），写入时 LLM 判定 ADD/UPDATE/DELETE/NOOP，主打 token 高效、生态最大（~55k stars）。
- **Zep/Graphiti**：**时序知识图谱**（bi-temporal：事实有效期 + 入库时间），实体/关系/情节，
  检索 71.2% 基准分（对比评测中最高）。适合"事实会过期"的场景。
- **LangMem**：LangGraph 生态绑定。
- 社区共识**四层记忆**：工作 / 情节（episodic）/ 语义（semantic）/ 程序（procedural）。

### 1.4 学术线

- **Generative Agents**（Stanford）：检索评分 = recency + relevance + **importance**（LLM 打分）；
  reflection 把细节蒸馏成高层抽象——"重要性评分"与"反思蒸馏"的鼻祖。
- **A-MEM**（NeurIPS 2025，[arXiv 2502.12110](https://arxiv.org/abs/2502.12110)）：Zettelkasten 卡片盒——
  原子笔记（语义属性标注）+ 写入时自动建链 + **记忆演化**（新笔记触发旧笔记更新）。
  核心主张：记忆系统的价值不在"更好的向量库"，而在**自组织的笔记网络**。
- **ReMe**（2025）：**关键点级记忆优于轨迹级记忆**——只存关键推理步骤，不存整个交互轨迹。
- ICLR 2026 已设 Memory for LLM-Based Agentic Systems 专题 workshop——该方向正快速主流化。

## 2. 我们的设计被外部验证的部分

| 我们的设计 | 外部印证 |
|---|---|
| 极小初始上下文 + recall 工具 = 无限扩展（psyche 本意） | Letta core/archival 范式即此；MemFS 进一步把记忆文件化 |
| LLM 闲时整理归档回忆 | sleep-time compute 已产品化，且证明 Pareto 改进 |
| L0–L3 分层记忆模型 | 社区四层共识（工作/情节/语义/程序）同构 |
| 状态所在地原则（开发任务状态在磁盘，统计摘要+recall 够） | JetBrains：clearing 可重获取输出，成本降 52% 解决率反升 |
| 遗忘/衰减（touch/LRU 降级） | MemGPT "调取增强、未用衰减"；各产品均内置 |
| 摘要必带原文指针（防幻觉复利） | Anthropic external memory 与 Zep 情节指针同做法 |
| 双模型槽位（ADR-001 slot） | sleep-time agent 独立配更强模型——slot 机制天然支持扩展 "archive" 槽 |

## 3. 需要吸收的修正（按优先级）

### 3.1 压缩谱系补一级：tool-result clearing（影响 v0.2/v1.x）

现状：谱系① sliding-window 是**整组丢弃**，粒度太粗。外部最佳实践是**先清结果、再谈摘要**：
保留 tool_use 记录与最近 N 个完整 tool_result，旧 result 换占位符——零推理成本、缓存友好、实证有效。

**落地**：谱系①拆为 ①a `clear-results`（半丢弃：清 result 留足迹，protect 名单可配——
对应 exclude_tools；这正是 fold-statistical 摘要里"工具足迹"的数据源前置形态）→ ①b sliding-window（整组丢弃）。
ADR-003 已补记。注意与 ADR-005 的 recall 配合：被清的 result 原文在 TranscriptStore，可 recall 取回——
**clearing + recall = 我们相对 Anthropic clearing 的增量**（他们清了就没了，我们有档案）。

### 3.2 摘要必须保留"停止信号"（影响 v0.2 fold-llm）

外部警告：摘要掩盖停止信号 → 轨迹延长 13–15%。
**落地**：fold-llm 的工作日志格式（阶段/已改文件/已验证项/**下一步**）已含"下一步"——
把"**已完成项禁止重做**"显式写入摘要模板；行为指标（压缩后重做率）已在 v0.1 验收中，保留。

### 3.3 压缩触发阈值重估：70% 预腐烂（影响 v0.2+ 默认预算）

现状：FR-3.1 余量 max(2000, 10%窗口) ≈ 90% 才触发。外部建议 ~70%（有效窗口内）。
**落地**：budget 公式系数本就可配；默认值暂不硬改（我们 token 估算宁高勿低 +15%，
等效提前触发，部分覆盖），但在 ADR-003 补记该权衡与外部依据，留待 app_container 实测数据校准。

### 3.4 冷循环采纳"双 agent"形态（影响 v2 设计）

我们的"热归档/冷整理"双循环与 sleep-time 双 agent 同构，额外吸收三点：
① 冷循环是**独立运行的 agent/任务**，不占主循环上下文与工具面；
② 冷循环可配**更强模型**（slot 机制扩展 "archive" 槽即可，ADR-001 不用改）；
③ **anytime 更新**：整理结果随时可被主循环读，不阻塞、不等完成。

### 3.5 episode 索引件对标 A-MEM（影响 v2 数据结构）

v2 episode 的索引件（关键词/实体/决策/未结事项）与 A-MEM note construction 一致；
可留的后期增量：**episode 间建链**（related 指针）与**记忆演化**（新 episode 触发旧 episode 更新）——
先做单向蒸馏，建链等召回评测数据说话。

### 3.6 衡量指标补强（影响 testing.md）

- 已有：压缩后重做率、recall 命中率（记忆基准 fixture）。
- 补充：**任务完成率 vs 上下文大小曲线**（定位有效窗口）、**压缩后轨迹长度**（防 3.2 的延长效应）、
  压缩/清理回收 token 数。

## 4. 参考链接

- Letta sleep-time compute：https://www.letta.com/blog/sleep-time-compute/ ｜ https://arxiv.org/abs/2504.13171
- Letta MemFS / memory & dreaming：https://docs.letta.com/concepts/memfs ｜ https://docs.letta.com/configuration/memory/
- Anthropic 上下文工程：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- 生产级上下文工程综述（tianpan.co）：https://tianpan.co/zh/blog/2026-02-26-context-engineering-memory-compaction-tool-clearing
- A-MEM：https://arxiv.org/abs/2502.12110 ｜ Generative Agents：检索=recency+relevance+importance
- 记忆产品对比：https://mem0.ai/blog/mem0-vs-zep ｜ https://medium.com/@wasowski.jarek/i-compared-5-ai-agent-memory-systems-across-6-dimensions-none-wins-6a658335ed0a
- 四层架构与遗忘机制综述：https://zhuanlan.zhihu.com/p/2050287092194973690
