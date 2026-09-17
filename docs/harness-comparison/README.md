# Agent Harness 上下文与记忆机制横向对比

> 目录用途：把 5 个 agent harness 在**上下文 / 记忆**方面的实现读透并横向对比，为自研 agent（本项目 erix-agent）的架构决策提供事实依据。
> 创建于 2026-09-17。前一轮相关工作：`docs/research/2026-08-29-memory-context-research.md`（外部实践扫描 + 业界论文），本目录补的是**可执行代码级**的一手对比。

## 目录

| 文件 | 内容 |
|---|---|
| [01-pi-agent.md](01-pi-agent.md) | pi（pi-coding-agent）单项目剖析 |
| [02-touwaka.md](02-touwaka.md) | touwaka（touwaka-mate）单项目剖析 |
| [03-codex.md](03-codex.md) | OpenAI Codex CLI（codex-rs，Rust）单项目剖析 |
| [04-hermes-agent.md](04-hermes-agent.md) | NousResearch Hermes Agent（Python）单项目剖析 |
| [05-erix-llm-kit.md](05-erix-llm-kit.md) | 本项目 erix-agent / erix-llm-kit 单项目剖析 |
| **[06-cross-comparison.md](06-cross-comparison.md)** | **五方对比主文档**（按 5 个维度逐项对照） |
| [07-takeaways-and-open-questions.md](07-takeaways-and-open-questions.md)，[08-runtime-erix-battery.md](08-runtime-erix-battery.md)（运行时实测）| 结论、可借鉴清单、开放问题 |

## 分析对象与快照

| 项目 | 语言 / 形态 | 代码位置 | 版本快照 |
|---|---|---|---|
| pi | TypeScript → `dist/*.js`（含 sourcemap）+ 官方 docs | `~/.npm-global/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent` | `@earendil-works/pi-coding-agent` 0.84.2 |
| touwaka | Node.js ESM（Koa + Sequelize/MySQL） | `~/projects/touwaka` | `bcf8ef8`，v0.4.0 |
| codex | Rust（Cargo workspace） | `~/projects/github/codex` | `800d183`（depth=1） |
| hermes-agent | Python（CLI + Gateway + Desktop） | `~/projects/github/hermes-agent` | `6005aa1`（depth=1） |
| erix-agent | 零依赖 Node ESM | 本仓库 | `0c309e6`，v0.5.1 |

> 外部仓库统一 clone 到 `~/projects/github/`；pi 未单独 clone（npm 包自带可读 `dist/` 与 `*.js.map` 的 `sourcesContent`，能还原原始 TS）。

## 方法

1. **探查**：先在 5 个代码库里定位与 5 个维度相关的入口文件（压缩 / 历史管理 / 工具截断 / 技能 / 记忆）。
2. **分工深读**：每个项目派一个只读研究员，按统一模板（§0 范围、§1 上下文构造、§2 工具输出截断与查询、§3 折叠与召回、§4 技能与工具、§5 per-user 长期记忆、§6 亮点与代价）产出文档，要求每条结论带 `文件:行号` 证据，找不到写「未找到 / 未确认」。
3. **抽查验证**：主 agent 对进入对比矩阵的关键数字与机制逐条回源核对（截断阈值、压缩阈值、feature 默认开关、召回语料、隔离键等），核对通过后才进入本对比。
4. **差异标注**：文档与实现不一致处（如 pi 的 `retainedTail`、touwaka 的「全部未归档消息」）一律以代码为准并显式标注。

**方法的边界**：结论来自静态代码阅读（含官方文档互证），**没有跑运行时实验**。因此「阈值触发后的实际行为」「压缩质量」「缓存命中率」这类需要实测的问题，本文只给机制与默认值，不给效果评价。

## 一页结论（详细见 06）

1. **「压缩」正在分化为两条路线**：**无损召回派**（hermes / touwaka / erix / pi：压缩只改「进入上下文的路径」，原文留在 DB / JSONL / 文件里，并给出召回工具或路径）与**有损摘要派**（codex 默认：assistant、推理、工具调用与工具输出全部丢弃，只留真实 user 消息 + 摘要）。分歧点集中在**默认路径下的工具输出是否还能取回**。
2. **prompt 缓存是否被当成一级架构约束，是这五个实现最大的分水岭**。hermes（三层 stable/context/volatile + 会话级冻结快照 + `api_content` 逐字重放）与 codex（world-state 全量一次 + 之后只发 RFC 7386 merge-patch diff + 稳定 id）把它写进不变量；pi 靠「只在结构变化时重建」间接得到；touwaka（时间戳每轮变）与 erix（折叠原地改写历史）基本放弃这项收益。
3. **工具输出的「三层防线」正在成为事实标准**：① 单结果上限 + 可执行的截断提示 → ② 落盘/落库 + 指针 + 恢复指令 → ③ 单轮聚合预算。hermes 做得最完整（还有同调用去重 + 按模型窗口缩放）；pi / codex / erix 都缺第 ③ 层。
4. **「截断提示必须能被模型直接执行」**是五个项目里质量差异最大的细节：pi 给 `offset=` / 可粘贴的 `sed` 命令 / 全量路径，hermes 给 `read_file` 路径 + 「不要重新请求远端」，touwaka 给可直接复制的 `recall({...})` 调用，erix 给 `recall({ round, pattern })` 配方；而给一句 `[truncated]` 就等于静默丢信息。
5. **工具数量问题有三种成熟解法**：延迟加载 / 工具搜索（codex 用 tantivy BM25 + `ToolExposure` 六值、hermes 用 Tool Search 桥 + 清单三级退化、pi 靠扩展自实现）、**单代理工具**（erix 把 N 个 MCP server 收敛成 1 个 schema）、以及全量硬扛（touwaka）。pi 与 touwaka 都**没有**工具 schema 的 token 预算。
6. **per-user 长期记忆是全场最不成熟的一环**。pi 与 erix **完全没有**跨 session 记忆（靠 AGENTS.md 层级 / run 作用域 notes 替代）；codex 有完整的两阶段后台流水线，但隔离单位是 `CODEX_HOME`（不按 project）、检索只有 substring、且 feature 默认关闭；hermes 只有 **profile** 粒度（同一 profile 下多个 gateway 用户共享 `MEMORY.md`），per-user 语义要靠外部 provider 补；touwaka 有 `user_id × expert_id` 维度，但用户画像「存而不用」、检索是 SQL LIKE。
7. **记忆写入的共识是「主循环少写、冷路径整理」**：hermes 每 10 轮起一个后台 review fork（`skip_memory=True`，主对话与 prompt 缓存不受影响），codex 用「stage1 抽取 → stage2 consolidation 子 agent 重写 `MEMORY.md`」两阶段后台流水线 + git workspace diff，erix 主张「主循环零写工具」并把整理交给 `completeRun` + janitor，touwaka 借 topic 压缩顺带产出画像。
8. **几个高杠杆的工程细节值得直接复用**：给每个注入片段打类型标签（codex `ContentItemKind`，是「压缩时只保真实 user 消息」的前提）；用 marker 合并/替换而不是追加（erix，防多次压缩堆叠摘要）；以「轮」为折叠原子单位、绝不切在 tool 结果上（touwaka `groupIntoRounds`、pi 的合法切点约束）；精确标识（PR / SHA / 路径 / 错误串）用正则机械抽取而不经过 LLM（hermes 锚点索引）；压缩 = 软归档 + 检索显式包含归档行（hermes `active=0, compacted=1` + FTS5 条件）。

## 阅读建议

- 只想要结论 → 本文「一页结论」+ [07-takeaways](07-takeaways-and-open-questions.md) 的决策清单。
- 想抄具体设计 → 直接看 [06-cross-comparison.md](06-cross-comparison.md) 对应维度表，再回单项目文档按 `文件:行号` 读原文。
- 想评估本项目的定位 → [05-erix-llm-kit.md](05-erix-llm-kit.md) §6 + [06](06-cross-comparison.md) 的「erix 相对位置」小节。
