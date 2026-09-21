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

## 4. 成本

12 run（含作废批）input ≈ 17.4M（~87% 缓存价）、output ≈ 342k。有效批次 input 11.2M / output 181k。

## 5. 复现要点

runner 必须显式 `cd ~/projects/erix-station`（v1 作废教训：cwd 是协议的一部分）；产物 /tmp/erix-bench-260926-strategy/ 重启即失，本报告与任务文档为准。分析脚本逻辑（工具序列/区间重叠重读/命中矩阵）已内嵌任务文档表格。
