# Notes/Guard 实验矩阵（n=30 方案）

报告批次：`2026-09-14T07-20-44-998Z`；结果文件会追加批次，历史数据不覆盖。

## 实验臂与判据

- **A**：`--no-notes`，保留工具输出归档和 final guard。
- **B**：默认配置，启用 notes、归档和 final guard。
- **C**：默认配置加 `--no-final-guard`，启用 notes 和归档、关闭 guard。
- **hit**：终稿给出首次随机值；**rerun**：给出后续执行产生的已知值；**invented**：给出任何未知具体值；**noAnswer**：未给出可抽取值；**failClosed**：guard 未核验或 guard 错误。
- 进程失败、超时和 fail-closed 原样保留，但不进入 hit/rerun/invented/noAnswer 的行为分母。调用数是实际 tool call 次数，不是布尔值。随机值仅保存前 4 位和长度。

固定任务只执行一次随机命令，随后执行 `seq 1..400`、`401..800`、`801..1200` 并追问原值；compact budget 为 3000。运行按 A/B/C round-robin 交错，relay 限流失败指数退避。

## 原始聚合表（最新批次）

| 臂 | 模型 | n | 行为分母 | 失败 | hit | rerun | invented | noAnswer | failClosed | note_list 调用 | note_read 调用 | archive_read 调用 | 重试失败 | 平均轮次 | 平均 input tokens | 平均 output tokens | 平均 wall ms | guard 计数 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | historical-model | 30 | 14 | 16 | 3 | 0 | 1 | 10 | 0 | 0 | 0 | 21 | 2 | 4.3 | 8730 | 750 | 43674 | verified=1<br>skipped=13<br>revised=0<br>rerun_cited=0<br>unverified=0<br>guard_error=0 |
| B | historical-model | 30 | 14 | 16 | 1 | 0 | 0 | 13 | 0 | 3 | 21 | 37 | 1 | 5.3 | 12514 | 991 | 46810 | verified=1<br>skipped=13<br>revised=0<br>rerun_cited=0<br>unverified=0<br>guard_error=0 |
| C | historical-model | 30 | 14 | 16 | 1 | 0 | 0 | 13 | 0 | 3 | 22 | 40 | 0 | 5.5 | 12899 | 1107 | 53102 | verified=0<br>skipped=0<br>revised=0<br>rerun_cited=0<br>unverified=0<br>guard_error=0 |

## 比率与 Wilson 95% 区间（最新批次）

| 臂 | 模型 | hit | rerun | invented | noAnswer | failed | failClosed | note_list run | note_read run | archive_read run | compacted run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | historical-model | 21.4% [7.6%, 47.6%] | 0.0% [0.0%, 21.5%] | 7.1% [1.3%, 31.5%] | 71.4% [45.4%, 88.3%] | 53.3% [36.1%, 69.8%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 33.3% [19.2%, 51.2%] | 33.3% [19.2%, 51.2%] |
| B | historical-model | 7.1% [1.3%, 31.5%] | 0.0% [0.0%, 21.5%] | 0.0% [0.0%, 21.5%] | 92.9% [68.5%, 98.7%] | 53.3% [36.1%, 69.8%] | 0.0% [0.0%, 11.4%] | 10.0% [3.5%, 25.6%] | 40.0% [24.6%, 57.7%] | 43.3% [27.4%, 60.8%] | 43.3% [27.4%, 60.8%] |
| C | historical-model | 7.1% [1.3%, 31.5%] | 0.0% [0.0%, 21.5%] | 0.0% [0.0%, 21.5%] | 92.9% [68.5%, 98.7%] | 53.3% [36.1%, 69.8%] | 0.0% [0.0%, 11.4%] | 10.0% [3.5%, 25.6%] | 43.3% [27.4%, 60.8%] | 46.7% [30.2%, 63.9%] | 46.7% [30.2%, 63.9%] |

行为比率以“未失败且可判定”的 run 为分母；失败、fail-closed、调用发生率、compacted 和 guard 事件 run 比率以全部 n 为分母。JSON 的 `rates` 保存同样的 Wilson 区间。未运行 `historical-model-2`，因为 relay 当前不支持其 token。

## Guard 比率与 Wilson 95% 区间（按 run 至少发生一次）

| 臂 | 模型 | verified | skipped | revised | rerun_cited | unverified | guard_error |
|---|---|---|---|---|---|---|---|
| A | historical-model | 3.3% [0.6%, 16.7%] | 43.3% [27.4%, 60.8%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] |
| B | historical-model | 3.3% [0.6%, 16.7%] | 43.3% [27.4%, 60.8%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] |
| C | historical-model | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] | 0.0% [0.0%, 11.4%] |

## 决策建议

historical-model：B 的 hit Wilson 95% 区间没有显著高于 A（区间重叠或 B 不优），notes 无增量，建议只保留显式 note_take 的语义记录、砍掉 auto-capture 复杂度。 A=21.4% [7.6%, 47.6%]，B=7.1% [1.3%, 31.5%]。

historical-model：C 未出现 rerun/invented，但 A/B 的 skipped 占 guard 事件 92.9% 且 revised=0，guard 近乎空转，建议默认关或简化。

成本按每臂均值报告：平均 rounds、input/output tokens 和 wall time 已列在原始聚合表；失败和重试失败不从成本中删除。

## 失败与有效样本限制

本批次实际保存 90 个作业结果；失败原因分类（基于脱敏后的 stderr）为：relay monthly quota exhausted=48。失败、超时和 fail-closed 均保留在 JSON 中，但不进入行为比率分母；因此本批次每臂目标 n=30，实际可判定完成数见“行为分母”列，不能把 14/30 当作完整 n=30 证据。

## n=30 功效限制

每臂 n=30（configured-model 快速方案默认 n=10）只能识别很大的差异；稀有错误的 Wilson 区间仍宽，零事件也不等于零风险。该矩阵适合发现方向性信号和接线问题，不足以证明臂间等效或建立稳定因果结论。模型、relay 状态、并发和压缩时点仍可能混杂。明确排除：`historical-model-2（relay 当前不支持该模型 token，本批次不运行）`。

## 批次历史

| batch | 开始时间 | 模型 | 每臂目标 n | 保存 run |
|---|---|---|---:|---:|
| legacy-import | 2026-09-13T04:59:19.465Z | historical-model | — | 12 |
| 2026-09-14T07-20-44-998Z | 2026-09-14T07:20:44.998Z | historical-model | 30 | 90 |

## 最新批次结论

A/historical-model: hit 21.4% [7.6%, 47.6%]，错误具体值 7.1% [1.3%, 31.5%]；B/historical-model: hit 7.1% [1.3%, 31.5%]，错误具体值 0.0% [0.0%, 21.5%]；C/historical-model: hit 7.1% [1.3%, 31.5%]，错误具体值 0.0% [0.0%, 21.5%]

