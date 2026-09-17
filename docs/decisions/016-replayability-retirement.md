# ADR-016：可重放（replayable）概念退役，guard 解耦为全量归档核验

- 状态：Accepted（2026-09-17）
- 关联：修订 ADR-012（引擎真相模型）与 ADR-013（guard 宪章）中的可重放部分；承接 ADR-015（上下文卫生统一）；破坏面落在 0.6.0（#111）
- 依据：issue #119；对照证据 docs/harness-comparison/（五家对照 + codex Goals 模式核实）

## 背景

自 0.3.x 起，本引擎围绕"命令是否可重放（幂等）"建了一套确定性机制：四源分类学
（declared / policy / heuristic / unknown）、工具 schema 的 `replayable` 字段、
重跑检测与警示（duplicateCommands + rerunOf）、非重放 exec 的 auto-capture
（捕值入笔记供 guard 溯源）、guard 只核验"非重放捕获值"。

三条证据链在 2026-09 汇合，否定这套设计的必要性：

1. **横对照**：pi / codex / hermes 都没有任何命令幂等分类、重跑检测或值溯源
   机器。hermes 用一句提示语；codex 默认路径截断有损、取回靠重跑；pi 给路径让
   人自己读。四家先验上都不做，且无人报告因此产生故障。
2. **纵实测**：43 轮真实静态分析（PrintServiceCore），auto-capture 0 触发，
   未发生重跑值错配事故。整套捕值机制在实际负载下零产出。
3. **可判定性**："命令是否幂等"不可机器判定。heuristic 正则清单（`$RANDOM` 等）
   只能覆盖显例，分类学是对不可判定问题建的架子——这正是过度设计的定义。
   对照 codex Goals 模式的划分原则：**机器可数的事实（token、turn 数）机器强制；
   不可机器判定的事实留给提示语纪律**。codex 连"目标是否达成"都只用提示语约束。

## 决策

### D1：可重放概念全面退役

删除 replayable 分类学、schema 字段、宿主选项、tool_result 块标记、重跑检测
全家（duplicateCommands / rerunGuidance / rerunOf）、run-state 确定性块的
nonReplayableCaptures / unrecoverableCaptures / archiveFailureCount 字段。

### D2：重跑风险降为提示语

"重跑同一命令可能得到不同的值；需要早期精确值时用 recall 取回"——hermes 同款
一行，进系统提示。不建机器。

### D3：auto-capture 死亡

captureToolExecution、auto 键族、captureCount 全删。显式 notes（note_take /
note_read / note_list）保留——模型主动记录与幂等无关，且是 notes 的本体价值。
skill 文件自包含，recordAutoCapture 留在 skill 内不再被 CLI 调用。

### D4：guard 解耦（ADR-013 修订）

核验范围从"非重放捕获值"扩大为"transcript 全部归档输出"：终稿中显式引用的
`label=value` 必须能在 transcript 的归档输出（toolOutputs / 折叠原文）中找到，
找不到打回。随可重放一起消失的还有 first/rerun 之辨、来源指向机制（note_read
的 artifactRef 溯源保留，显式笔记仍可作来源）。guard 的防伪造职责不变，证据
面反而变大。

### D5：不动的东西

输出卫生（尺寸维度，4096 + toolOutputs 字节保真 + recall 配方）、recall 工具
及契约、折叠机制本体。fold 抽值 stub 的 replayable 过滤删除，改为对全部
tool_result 统一抽值（值锚点不再区分来源）。

## 后果

- **破坏面（0.6.0）**：工具 schema `replayable` 字段、宿主选项
  `toolReplayability` / `nonReplayable`、tool_result 块 `replayable` 标记、
  run-state deterministic.fold 字段收缩、`erix-agent` 库内 replayable 相关
  导出。老 transcript 里带 replayable 标记的块：新代码忽略该标记，向后兼容读。
- **失去的**：重跑值错配从"引擎插警示"降为"提示语提醒 + 模型自觉"。接受此损
  失的依据：横对照四家皆如此、纵实测零事故、提示语成本近零。
- **得到的**：删掉约一个分类学 + 一条捕值链路；guard 更简单、覆盖面更大；
  架构词汇里不再有不可判定的概念。
- resume 兼容：老 transcript 的 deterministic.fold 旧字段由 resume 侧
  `?? 0` 默认值吸收，不需要迁移。
