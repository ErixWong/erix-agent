# 策略方差与缓存经济学基准（2026-09-26）

> 任务文档（本地，不入库）：docs/tasks/done/260926-strategy-variance-benchmark/REPORT.md
> 关联 issue：#44（cache-adaptive folding，本文是其数据来源）｜ #40 ｜ #39
> 口径：erix-station 只读代码分析（prompt 与 260920 基准逐字同）、relay deepseek-flash、隔离 HOME、cwd=erix-station、n=3×2 臂 + 1 作废批（cwd 协议错误，详见任务文档）

## 1. 设计与结果

两臂对照：control = 基准 prompt 逐字；strategy = 追加「盘点建图 → 大文件切片读 → note_take → 重读前必 note_read → 高风险点允许精读」策略块。单变量仅追加。

| tag | 轮数 | input | cacheRead | output | 工具剖面 | judge |
|---|---|---|---|---|---|---|
| c1 | 60 | 1,794,941 | 1,544,832 | 32,993 | readFile 52（http.js 重读×13）+ exec 24 | done@59 |
| c2 | 65 | 1,763,756 | 1,543,168 | 29,608 | exec 68 + readFile 7 + note 24/0 | done@64 |
| c3 | 63 | 2,073,715 | 1,839,488 | 31,393 | exec 104 + note 6/1 | done@62 |
| s1 | 65 | 2,486,679 | 2,224,896 | 22,837 | readFile 49（http.js×11、internal.js×8 重读）+ exec 34 | done@64 |
| s2 | 47 | 1,507,490 | 1,329,664 | 27,001 | readFile 39 + exec 26 + note 13/4 | done@46 |
| s3 | 57 | 1,577,263 | 1,350,528 | 37,231 | exec 75 + note 23/8 | done@56 |

- 对照组 input 方差 max/min **18%**（1.76–2.07M）；策略组 **65%**（1.51–2.49M）；均值持平（1.877M vs 1.857M）
- 质量（12 类已知风险命中矩阵）：c 臂 6/5/6，s 臂 6/7/**10**；六份报告均带 file:line 证据；glm 深潜曾发现的 deleteProvider 非事务本次 0/6 命中——**覆盖抽签跨模型持续存在**

## 2. 结论

1. **方差是模型相关的**：deepseek-flash 自然方差 18%、自然模式 exec/切片主导；「深潜 vs 快取」73% 双峰是 glm 特有。#39 模式控制器必须按模型分型标定。
2. **prompt 锁不住策略**：s1 收到「重读前必 note_read」仍 18 次重读前 0 次查笔记。prompt = 免费默认倾向，不是控制手段。
3. **折叠→重读互害存在但代价小**：重叠重读债务 20–61k tok（input 的 1–3%）；深潜主要开销在轮数。
4. **note 不能替代重读**：100% 重读发生在该文件已有笔记时（21/21、18/18、14/14）；笔记是终稿引用清单（结构索引 + 行号），重读要的是被折叠的源码文本本身——互补不替代。c2 写 24 读 0（只写内存）。
5. **cache-capable 端点解锁 #40**：deepseek-flash 响应带 cacheRead（87.8%），有效 input 成本较无缓存口径降 79%（≥60% 达标）；#42 归因 A/B 归入 #44。

## 3. 缓存时代经济学（→ #44）

TTL 折叠省的是缓存价（~1/10）重发、换来全价新 token 重读；TTL=2 是无缓存时代的默认。cache-capable 端点上净收益薄，深潜式 run 可能为负。**方案不是调大 TTL**（延迟同一笔账；且 TTL 只咬 ≥4k 大结果，切片式读取 1.4–4.3k 从未被折叠）：v1 配置声明 `cacheCapable` → TTL=0 交阈值压缩兜底；v2 按 #42 的 cacheRead 比率自动判定；阈值压缩触发口径同步 cache-aware（大压缩 = 整段缓存失效）。pi 对照：全文常驻 + 阈值一次性 LLM 压缩，交互场景的默认值在缓存时代是对的经济账。

## 4. #44 A/B 追加：TTL=0 臂证伪（2026-09-26 补充）

PR #45（cacheCapable→TTL=0）合并后按 issue 验证方案跑了 TTL=0 臂（n=3，/tmp/erix-bench-260926-ttl0/，input 7.9M）：

| 指标 | TTL=2 基线（n=6） | TTL=0（n=3） | 变化 |
|---|---|---|---|
| input 均值 | 1.877M | 2.635M | +40% |
| 有效计费 (in−cr)+0.1cr | ~392k/run | ~598k/run | **+53%** |
| 重叠重读率 | 深潜 run 20–34% | 37–38% | 未降反升 |
| 交付 | 6/6 | 2/3（t2 跑满 64 轮未交付，终稿泄漏 DSML 标记） | 变差 |
| 质量命中（12 类） | 5–7 | 7/0/8 | 持平 |

**结论（证伪两个前提）**：① 重读是注意力行为，全文常驻照样重叠重读——折叠的「重读成本」是虚账；② 缓存折扣只覆盖重复前缀，全文常驻让每轮新增尾部变大（全价部分 250k→370k/run）——折叠削的正是全价尾部。**TTL 折叠在 cache-capable 端点依然净赚，v1 处方撤回**：`cacheCapable` 字段保留作观测信号但不推荐启用，v2（自动判定切 TTL）取消。

## 5. 成本

18 run（作废批 6 + 260926 v2 批 6 + #44 TTL=0 批 3 + …）累计 input ≈ 25.3M（~86% 缓存价）、output ≈ 400k。

## 6. 复现要点

runner 必须显式 `cd ~/projects/erix-station`（v1 作废教训：cwd 是协议的一部分）；产物 /tmp/erix-bench-260926-strategy/ 重启即失，本报告与任务文档为准。分析脚本逻辑（工具序列/区间重叠重读/命中矩阵）已内嵌任务文档表格。

## 7. #46 追加：erix vs pi 无头同任务对比（2026-09-26）

pi 0.84.2 `-p`（deepseek-flash，n=3，erix-station 只读分析同任务）vs erix TTL=2 基线（n=6）：

- 有效成本/run：erix **392k** vs pi **680k**（缓存重发税 347k + 新增 293k + compaction 全价 124k）——erix 低 39%
- 交付 100% vs 100%；质量命中 6.7 vs 7.7（n 小不显著）；终稿 13–17k vs 13–15k
- 结构性差异：erix TTL 折叠为确定性规则（零 LLM 调用），pi 阈值压缩为 LLM 总结（2–3 次/run、全价、刻意禁缓存写）；pi 全文常驻 + AGENTS.md + thinking=high → ΣcacheRead 3.47M/run

**判定**：无头场景 erix 强制协议栈为净收益（成本 -39%、质量持平）。与 §4 的 TTL=0 证伪互为印证——「规则折叠削全价尾部」在跨 harness 对照中再次成立。诚实标注：erix judge 审计调用未计入成本（不影响排序）；pi 读 AGENTS.md 属其原生设计。
