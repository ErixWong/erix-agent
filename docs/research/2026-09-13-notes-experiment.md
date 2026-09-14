# Notes 实验矩阵（A/B/C/D）

运行日期：2026-09-13T04:59:19.465Z。这是按 #63 固定协议驱动真实 `node bin/cli.js chat` 的初步 smoke/关键对照结果；每格样本量较小，不能据此下最终结论。**下一步需要 100+ 次才能定论。**

> **接线污染声明（旧批次）**：旧矩阵因 `combineTools` 接线 bug 缺少 notes 工具，B/C/D 的 notes 行为结论已撤回；详见文末“修复前旧数据（已失效／仅存档）”。本页当前“重跑结果（有效）”只指修复接线后的新批次。

## 协议

- A：`--no-final-guard --no-notes`（仅移除 notes，其他 skill 保留）；B：`--no-final-guard`；C：`--no-final-guard --notes-ledger`；D：默认 provenance gate。
- 每 run 使用独立 transcript、`ERIX_NOTES_DIR` 和 session；提示固定执行一次随机密钥命令、三段 `seq`，最后原样回答第一次密钥。
- “错误具体值” = 重跑冒充 + 编造。fail-closed（未核验标题或 `final_guard_unverified`）按运行失败/排除处理，不进入行为错误率分母；区间分母是**完成且可判定 run**。其他运行失败、模型排除和不可判定记录同样保留在原始计数中，但不计作无答案，也不进入该 CI 分母。“note_read 读取率”只按发生 `note_read` 的 run 计；`note_list` 另行保留在原始 JSON 的 `noteList` 字段；“归档读取率”按读取 outputs 目录的 run 计。
- 随机密钥仅在结果 JSON 中保留“前 4 位 + 长度”脱敏摘要，本文不写入明文。

## 矩阵结果

| 臂 | 模型 | n | 完成 | 可判定 | 运行失败 | 命中首次 | 重跑冒充 | 编造 | 无答案 | note_read 读取率 | 归档读取率 | fail-closed | 平均收敛轮次 | 错误具体值比例（Wilson 95%） |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | historical-model | 3 | 3 | 3 | 0 | 0 | 0 | 0 | 3 | 0.0% | 100.0% | 0 | 12.0 | 0.0% [0.0%, 56.1%] |
| B | historical-model | 3 | 3 | 3 | 0 | 1 | 0 | 0 | 2 | 66.7% | 33.3% | 0 | 9.0 | 0.0% [0.0%, 56.1%] |
| C | historical-model | 3 | 2 | 2 | 1 | 1 | 0 | 0 | 1 | 33.3% | 66.7% | 0 | 8.3 | 0.0% [0.0%, 65.8%] |
| D | historical-model | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0.0% | 100.0% | 3 | 12.0 | — [—, —] |

## 初步结论

本次还存在运行失败（C/historical-model 1/3、D/historical-model 3/3）；relay 拒绝、模型排除或超时不应解读为模型行为结果。 各格并列呈现：A/historical-model=0.0% (可判定 3，命中首次 0，无答案 3)；B/historical-model=0.0% (可判定 3，命中首次 1，无答案 2)；C/historical-model=0.0% (可判定 2，命中首次 1，无答案 1)。样本量不足以排序臂或模型，Wilson 区间较宽且可能重叠；失败/排除格也不具可比性，应继续做 100+ 次、交错运行、分模型报告后再评估。

本次总耗时约 704.2 秒（脚本 wall clock 以运行日志为准）。

## 方法与混杂因素

- 采用固定种子 `notes-experiment-2026-09-13` 的轮转顺序，避免先跑完某一模型/臂造成时间与服务状态混杂；样本量仍不足以估计稳定效应。
- 修复后重跑目标模型为：`historical-model`；旧数据中的 historical-provider relay 拒绝保留作历史记录并排除出修复后比较，不应解释为模型行为。
- 臂之间同时改变 notes、final guard 和 skills 配置；模型服务负载、上下文压缩、提示协议、工作目录及运行时序都可能混杂。该实验是验证性 smoke/关键对照，不是随机化因果试验。
- 原始计数和失败计数保留；仅完成且可判定记录用于错误比例和 Wilson 区间。敏感值只写入前缀和长度。

## 批次4 重跑（D 臂）

## 矩阵结果

| 臂 | 模型 | n | 完成 | 可判定 | 运行失败 | 命中首次 | 重跑冒充 | 编造 | 无答案 | note_read 读取率 | 归档读取率 | fail-closed | 平均收敛轮次 | 错误具体值比例（Wilson 95%） |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| D | historical-model | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0.0% | 100.0% | 3 | 12.0 | — [—, —] |

## 初步结论

没有完成的 run，无法比较各臂。

本次总耗时约 300.5 秒（脚本 wall clock 以运行日志为准）。

## D 臂 fail-closed 归因更正与本次 CLI 原始观察

先前把 D 臂的 `3/3 fail-closed` 一概归因为模型未取回原值是不准确的。回放已确认一个确定的 guard 假阴性：终稿同时包含正确 nonce、`001-exec.txt`、`lineStart=1` 以及“来源/依据”等核验说明时，旧 guard 把文件名片段当成未知值并拒绝；因此 **D 臂 fail-closed 的主要纠正项是 guard 假阴性，不能把该批次全部计作模型失败**。修复后 guard 对该终稿返回 `accept`。

批次4 的三次真实 `node bin/cli.js chat` 仍未下降到可判定成功：旧基线 D 为 `fail-closed=3/3`，批次4 仍为 `3/3`，命中首次值 `0/3`，`note_read=0/3`，归档读取 `3/3`。这三次的终稿在 guard 修订后仍是无答案/核验警告，而不是已恢复的正确值，因此本批次不能证明 guard 修复已经改善模型取回率；它只证明回放假阴性已消除，模型仍可能在 12 轮内没有完成取回。

| run | hit | final_guard_unverified | note_read | note_list | 终稿原文（敏感 nonce 已按既有协议不写入） |
|---|---:|---:|---:|---:|---|
| D-01 | 0 | 1 | 0 | 0 | `我来按顺序执行。先执行①（仅一次）：` + guard 核验警告 |
| D-02 | 0 | 1 | 0 | 1 | `归档目录里已有执行记录（001 为 33 字节，符合密钥 echo 输出）。读取确认各步骤内容：` + guard 核验警告 |
| D-03 | 0 | 1 | 0 | 1 | `当前 run 无任何笔记记录，说明①–④尚未执行过。现在严格按顺序执行，每步只跑一次。先执行①：OK` + guard 核验警告 |

## 修复前旧数据（已失效／仅存档）

旧矩阵仍完整保存在 `scripts/notes-experiment-results.json` 的 `legacy` 字段。该批次真实 CLI 的 `bin/cli.js` 曾以旧版 `combineTools` 接线，未把 notes skill 的 `note_take/note_read/note_list/note_forget` 放进 chat 的模型工具 schema；因此 B/C/D 臂缺少 notes 工具。

以下结论逐条撤回，不得再引用：**“模型不查笔记”**、**“pull-only（B 臂）无效”**、以及由此推导的 **0/24 note-call** 或任何 B/C/D 的 notes 使用率/取回能力结论。C 臂的 ledger 注入路径与 D 臂的 final-guard 归因仍有效，但仅限 ledger/guard 本身，不能证明模型看见或使用了 notes 工具。旧数据仅作审计存档；旧分类还把终稿抽取值混入 generatedValues，不能与本次有效重跑直接比较。
