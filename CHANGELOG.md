# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。

## [Unreleased]

### Changed（BREAKING）

- 退役 notes 写入侧凭据检测（issue #136）：`note_take` 不再按 key/content 形状拦截疑似凭据，
  写入与回读恢复一致契约；如需写入拦截由宿主在工具调用层自行负责。
- `erix-agent/tools` 子路径不再导出 `looksLikeCredential` / `normalizedLabel`（breaking）；
  `src/tools/credential-patterns.js` 本体保留，仍供 `src/run-state.js` 脱敏与
  `bin/final-guard*` 候选行过滤内部使用。
- 删除 `src/loop.js` 转发 shim（issue #60 Phase 2）：`runToolLoop` / `parseReflectionDecision`
  改由 `src/index.js` 直接从 `loop/orchestrator.js` 与 `loop/reflection.js` 导出；包入口与
  `erix-agent` 主入口导出不变。直捣 `src/loop.js` 相对路径的宿主消费方需改为直接 import
  对应实现文件（`package.json` 的 `exports` 未暴露 `./loop.js` 子路径，包名子路径导入本就不可达）。

### Changed

- 清理 legacy reflection 残留（issue #60）：删除全仓零调用的 `reflectionPrompt()`；
  `termination.reason` 的 `"reflection_stop"` 枚举值与 `"reflection-stop"` action 映射删除
  （引擎内部枚举值，v0.9.0 起已不可达，不在契约测试锁定面）。宿主若仍按字符串匹配该值，
  需自行调整。

## [0.9.0] - 2026-09-22

来源：issue #49 修复（PR #50，260920 基准 64 轮撞 cap 实证驱动）。

### Changed（BREAKING）

- **扩轮决策统一归 judge**（issue #49）：nearLimit（`budgetRounds >= floor(effectiveMaxRounds × 0.8)`）时，end-turn judge 与工具拦截审计的 prompt 追加预算事实（`r/上限`、`extensionCount/maxExtensions`）并要求返回 `extend`/`extendReason`/`plan`；`extend:true` 且扩展配额未用时给有效预算增加 `extensionStep` 轮（拦截审计也携带该决策，模型从不 `end_turn` 也能触达扩轮）；`extend:false` 注入收尾压力 nudge；字段缺失/解析失败/超时 fail-closed 不扩。此前默认配置（roundJudge on）下扩轮路径不可达，长任务只能撞 `max_rounds_cap` 靠 wrapup 兜底。
- 删除 legacy nearLimit reflection 路径：`reflection.triggerRound` 选项移除、`callReflection` 独立评估调用移除；`reflection_stop` 终止原因保留在类型枚举中但当前无触发路径（stop 权归 roundJudge/termination）。
- `onReflection` 回调保留，现在仅在 judge 扩轮决策时触发（`decision` 为 judge 决策数据）。

### Fixed

- docs/architecture 双语对齐：移除 `triggerRound`/固定 `extensionStep=32`/`judgeIntervalRound=5` 过时默认值，补 nearLimit extend 决策口径。

## [0.8.0] - 2026-09-21

来源：issue #33 修复批次（PR #134）+ 260920 基准驱动两批（PR #34 judge/预算/工具层效率、PR #37 TTL 折叠与 recall 退役）+ 文档同步（PR #38）。

> ⚠️ 0.7.1 曾提交版本号但从未发布到 registry（registry 无此版本），其内容并入本版本，不再单独发 0.7.1。

### Removed（BREAKING）

- **退役 recall 工具与 bounded-recall 协议**（issue #36）：删除 `src/tools/recall.js`、`src/store/bounded-recall.js` 及全部模型可见面（工具注册、系统提示行、归档通知、guard 捕获指针、TTL 占位符配方）；取回指引统一 note-first（`note_list` → `note_read`）；ADR-015 标记 superseded，ADR-016 补记退役决策。依据：四 run 基准（recall 2/0/6/0，bench7 note 闭环 31/21 完全替代）。**宿主如依赖 `boundedRecall` 公共导出或 recall 工具需改造为 note 工作流。**

### Added

- **工具结果 TTL 折叠**（issue #35）：大结果次轮起折叠为句柄——年龄（`erixRound` 标记）+ 体积（4k tokens）双门槛，请求视图层折叠（checkpoint 保持全文）；预警轮（`age===ttl-1` 追加「下一轮折叠」提示，给模型免费提炼窗口）+ 结构化导航摘要（函数/类/章节签名 + JSON 骨架，≤600 字符）；类型感知（never-fold 名单）；终稿保护。环境变量 `ERIX_TOOL_RESULT_TTL`（默认 2，0=关）/ `ERIX_TOOL_RESULT_FOLD_MIN_TOKENS`（默认 4000）。参考 touwaka `truncateToolContent` 生产经验，erix 护栏更强。
- **空 assistant 消息可重试 + CLI 默认接通重试**：present-but-empty message 标记 `retryable:true`（relay/vLLM 瞬时空响应实测），结构性错误保持不可重试；`runToolLoop` 默认 `retry{attempts:2}`，`ERIX_RETRY_ATTEMPTS` 可覆盖。
- **CLI 新增 `--tools` 白名单**（chat/repl）：硬只读红线能力；**新增纯 node grep 工具**（glob 过滤 / 结果上限 / 目录跳过）。
- **系统提示新增思考语言指令**：内部思考一律使用英文，可见输出跟随用户语言。
- **折叠锚点接入 fold-statistical 默认路径**（issue #33 A）：折叠摘要默认携带机械抽取的精确标识，不再仅限显式调用方。
- **judge LLM 用量进 judge.log 与逐轮事件**（issue #33 B）：轮判与拦截审计的 token 消耗可观测。

### Fixed

- **judge/预算/工具层效率修复**（260920 基准驱动）：INTERCEPT 会话预算 40k→6k（40k 必超 30s 超时，6/7 空转）；judge maxTokens 512；恢复 judge 请求 `reasoning_effort:none`（GLM 上唯一真正关思考的参数，前次「负优化」结论纠正）；纯思考响应（reasoning-only）不再抛 missing content；round judge maxTokens 512→1024 修复 JSON 截断；judge 原始输出落盘 judge.log（raw 字段，脱敏保留正文）。
- **最后一轮强制无 tools 请求**：文本终稿收尾，不再撞 max_rounds 截断。
- **intercept judge 对只读工具放行**（issue #33 C）：readFile/tree/rg/note_read/note_list/recall 类调用不再被审计拦截（实测拦截净收益为负）。
- **fold-llm summarizer 运行时失败降级为统计摘要**（issue #33 D）；`anchors:false` 清理改为 head 全量剥离（含 system/role 切换）；锚点逗号 round-trip、降级摘要补 stub 与导航、judge parse 失败带 usage 等评审退回项。

### 文档

- 新增架构图文档 `docs/charts.md` / `charts_cn.md`（数据流 / 模块架构 / 端到端时序 / 机制解析 / 评审 Q&A），并随 recall 退役同步（机制解析 4 改写为「档案与小抄」，移除 bounded-recall 节点）。
- 源码结构描述同步（`src/loop/` 目录化）；清理 jail/file-tools 过期残留；docs/tasks 目录移出版本控制。

## [0.7.0] - 2026-09-19

来源：2026-09-18 真实项目运行时评估（`docs/eval/2026-09-18-erix-060-real-project-eval.md`，touwaka 快照 × deepseek-flash，10 run）的优化清单批次 1/2；方案经 GitHub Copilot 架构审计修订（批末重写→增量准入、砍同轮去重、截断方向下沉宿主）。

### Added

- **单轮聚合输出预算**（`src/loop/aggregate-budget.js`）：工具结果到达即判定内联或归档+stub（增量准入，不重排、不改 tool_use_id），整轮可见输出超 `clamp(0.30 × 可用预算, 16000, 200000)` 估算 token 时逐条归档；intercept 控制性结果不计入；失败结果 stub 保留 `is_error` 与关键错误片段；归档失败 fail-closed（`unrecoverable`，不承诺 recall 可取回）。无窗口配置时聚合层关闭，行为同 0.6.0。
- **折叠摘要锚点索引**（`src/compact/anchors.js`）：折叠时从被折原文正则机械抽取 commit SHA / PR·issue 号 / 路径:行号 / URL，作为不经 LLM 的保真层追加到摘要尾（频次排序、封顶 20 条 / 1200 字符），同时是 recall 的搜索关键词种子。
- 折叠摘要补「用户最新未解决输入」逐字引用与反向信号识别（stop/undo/取消 → 覆盖旧待办的警告行）。
- CLI exec 截断改 **head+tail**（保留命令上下文与结尾报错；readFile 维持 head+offset）。
- 环境变量 `ERIX_JUDGE_INTERVAL`（intercept 审计间隔，默认 10）与 `ERIX_STALL_MODE`（appear/consecutive，默认 consecutive）文档化。
- 新增运行时成本/召回回归工具：erix-bench `harness/cost-report.mjs`（累计 input / 末轮 input 比）与 `harness/recall-probe/`（折叠后召回探针，5/5 fixture 自测）。

### Changed

- **intercept judge 审计间隔默认 5 → 10**，且 `direction:"on_track"` + `done:false` 时不再拦截（放行，judge 事件带 `passThrough:"on_track"`）。运行时评估实测旧默认在单任务内产生 39 次误拦截（最高占 18.6% 工具调用）。
- **stall 检测默认 `mode: "consecutive"`**（原 `appear`：窗口内出现过同签名即停滞，合法重读文件被误判掐断任务）。显式传 `stallDetection` 的宿主语义不变，`ERIX_STALL_MODE=appear` 可显式回退。
- **输出卫生单结果阈值按窗口缩放**：`clamp(15% × contextWindowTokens, 8192, 100000)`；无窗口配置保持 4096；显式 `outputHygiene.limit` 优先级最高。
- resume 语义：轮号（身份，跨 resume 连续）与轮预算（`budgetRounds`，每次 run 从 0 起计）拆分——**resume 后续聊不再继承耗尽的轮预算**；run-state `budget` 双报 `rounds`（会话累计）/ `runRounds` / `remainingRounds`。

### Fixed

- 续接轮 transcript 完整性：resume 后新轮次的记录不再因 dedupKey 轮号撞车而留近空行。

### 文档

- `docs/eval/2026-09-18-erix-060-real-project-eval.md`：0.6.0 真实项目综合评估报告。
- `docs/harness-comparison/`：五家 harness 上下文/记忆机制横向对比补实施方案。

## [0.6.0] - 2026-09-18

破坏窗口收口（ADR-015 / ADR-016 / #109 / #110 / #111）。以下条目此前记在 Unreleased，现随 0.6.0 一并发布。

### Breaking（ADR-016：可重放概念退役）

- **replayable 分类学整体删除**：`resolveReplayability` / `isNonReplayableCommand` /
  `NON_REPLAYABLE_COMMAND_PATTERNS` / `replayableSource` 四源分类、工具 schema 的
  `replayable` 字段、宿主选项 `replayable` / `toolReplayability` / `nonReplayable`、
  tool_result 块上的 `replayable` 标记全部移除。"命令是否幂等"不可机器判定，
  分类学是对不可判定问题建的架子（依据：五家 harness 对照无一做幂等分类；
  43 轮野外实测 auto-capture 0 触发；codex Goals 模式"机器可数才机器强制"原则）。
- **重跑检测与重跑告知退役**：`duplicateCommands` / `rerunOf` / 重跑警示文案、
  跨进程 `hydrateTranscriptCaptures`、run-state 的 `nonReplayableCaptures` /
  `unrecoverableCaptures` / `errors.archive` 字段、guard metrics 的 `rerun_cited`
  全部删除。重跑值错配风险降为系统提示一行："重跑同一命令可能得到不同的值；
  需要早期精确值时用 recall 取回，不要凭记忆"。
- **auto-capture 退役**：`bin/auto-capture.js` 删除；exec 不再自动写捕获笔记
  （`candidateLines` 迁入 final-guard-support 供 guard 抽值）。显式 notes
  （note_take/note_read/note_list）不受影响。
- **guard 解耦并扩大核验面**：终稿核验不再只针对"非重放捕获值"，改为对 transcript
  **全部归档输出**比对。核验载体是结束协议信封的 `findings` 字段（label→精确值），
  guard 只做字符串相等比对，**不再解析终稿散文**——散文正则抽取已被实测证伪
  （`「TARGET=gold-4173」` 被判成伪造值，诚实终稿被误杀）。来源指向要求与
  first/rerun 之辨删除；guard 贡献面更大、代码更少。
- `runToolLoop` 选项 `runState`（唯一用途是共享 rerunDetected 标记）删除；
  `wrapExecuteTool` 选项 `capture` / `notesScope` 删除；`createCliTools` 选项
  收窄为 `cwd`。
- 老 transcript 中带 `replayable` 标记的块：新代码忽略该标记，向后兼容读。

### 窗口内清理（ResourceStore 端口，0.5.1 无影响）

> 该端口只存在于未发布的 0.6.0 窗口（先随 #106 新增，后随 ADR-015 收尾删除），0.5.1 没有它——宿主不需要迁移，唯一可见影响是显式传该键会被陌生顶层键校验拒绝。

- **`resourceStore` 端口整体删除**（ADR-015 4a/4b 的收尾）：输出档案角色早已并入
  transcript `toolOutputs`，capture 证据角色并入 #109 第 2 步；剩下唯一的 fold 用途
  也随 ADR-015 的"一个档案"结论消失。删除 `validateResourceStore`、
  `createFileResourceStore`、fold 的 `materializeFoldResources`、`resourceStoreContract`
  契约测试与 `assembly.js`/`runToolLoop` 的对应选项。宿主若仍传该键，会因陌生顶层键被
  排拒（fail-loud，而不是静默忽略）。
- **`executeToolContract` 拆出迁移负例组**（契约测试套件）：位置形态 `(name, input)`
  从"通过路径里的兼容诊断"改为 `executeToolMigrationContract` 的负例断言（`name`
  收到整个 execution 对象、`input` 为 `undefined` = 必错），契约通过路径只描述
  结构化形态。宿主 store/executor 若原先靠宽松断言"全绿"，升级后可能变红——这是
  有意收紧，见 0.6.0 升级指南。

### fix（#109 第 3/4 步：错误通道与账本可靠性）

- **账本去重**：完全相同的持久化失败（同 port/operation/phase/fatal/错误消息）合并为
  一条并累加 `repeat`，不再每轮刷一条；`toUnpersisted` 返回浅拷贝，调用方不能改内部数组。
- **账本落盘**：deterministic run-state 新增 `deterministic.errors.unpersisted`
  （`{ count, items }`，最多留 10 条明细），run 中途崩溃不丢账；模型可见渲染只显示条数
  （`errors=tool/checkpoint/unpersisted`），宿主错误正文不进上下文。
- **异常路径的收尾失败不再只剩 stderr**：主结果是异常时，收尾失败数组挂到
  `error.completionErrors` 上（此前只在 `console.error` 里）。
- **`NotesStore` 写契约与作用域规范化**写入宿主契约（中英同步）；文档事实源对齐
  `normalizeOpenAIUsage` 的真实语义（不接受 canonical alias、非 null 输入返回对象）。

### fix（#127：实测四轮暴露的待修点）

- **guard：有捕获值却没声明 findings → 打回，不再静默跳过**。此前
  "归档里有可核验值、终稿信封没写 findings" 被当作 `skipped` 放过，等于模型
  可以自己免检；现在改为 `revise`（消息列出可用 label 与 recall 配方），
  重试耗尽后 fail-closed 到 `unverified`。真无值可核的两种情形
  （`no_capture_evidence` / `no_extractable_candidates`）仍为 `skipped`。
- **CLI 退出码区分"没核验"与"核过了"**：`skipped` 由 0 改为 4（`verified` 仍是 0，
  `unverified` 2，`error` 3），并在 `--help` 里写明。此前调用方无法区分两者。
- **recall 新增按行直读**：`recall({ fromRound, lineOffset, lineLimit })` 一次取回
  归档输出的连续行窗口（带行号与"共 N 行 / 继续读用 lineOffset="导航标记，
  导航信息不会被截断吃掉）；单次默认 100 行、硬顶 400 行，总量受 token 预算约束。
  实测中模型为读 42KB 输出的中段，用 12 次"假装行号"的正则探针绕了 10 轮
  （多花约 60k tokens）。
- **LLM 归一化只许搬运，不许改写**：归一化提示词明确"值必须逐字摘自 agent 原文"，
  并对归一化结果做机械校验——值不是原文逐字子串的条目直接丢弃。同时修掉一个
  真实缺口：LLM 归一化路径产生的 `findings` 此前没有传给 guard（静默丢失），
  现在与信封路径一致透传。
- **reflection 门槛单一来源 + 扩轮步长按比例**：CLI 曾把门槛写死为
  `max-rounds >= 32`，与库常量 `DEFAULT_REFLECTION_MIN_ROUNDS`（16）漂移——16 轮
  的任务永远拿不到扩轮保护（实测第 4 次运行踩线过关）。CLI 现在复用同一个常量；
  默认扩轮步长由固定 `+32` 改为 `max(8, maxRounds * 0.5)`（16 轮任务一次扩 8 轮，
  而不是一口气加到 48）。

### Breaking（`erix-agent/tools` 子路径）

- **`JailError` / `createJail` / `createFileTools` 删除**（窗口内 commit `a8cd193`，
  原为死代码对）。0.5.1 从 `erix-agent/tools` 导入这三个符号的宿主必须改用自己的
  路径/权限实现；本库自 ADR-009 起不提供安全边界。
- **`resourceStore`（`erix-agent/tools` 之外的装配端口）为非破坏项**：该端口在
  未发布的 0.6.0 窗口内新增又删除，0.5.1 从未包含它；唯一可见影响是宿主显式传该键
  会因陌生顶层键被拒。

### feat（ADR-015 整窗）

- **recall 标配化**：引擎默认注册 `recall` 工具（可 opt-out；宿主同名工具让位；
  无 store 时显式撕票，不静默）。新增按行直读 `recall({ fromRound, lineOffset,
  lineLimit })`（默认 100 行、硬顶 400 行、导航标记不会被截断吃掉）。
- **输出卫生进引擎**：超限工具输出全量归档进 transcript 的字节保真 `toolOutputs`，
  模型可见侧只留截断提示 + recall 配方；checkpoint/resume 字节保真；CLI 不再写第二份
  archive 文件、不再有 `.meta.json` / 路径提示（模型侧零路径）。
- **notes 小抄目录注入 run-state**：semantic 槽位 220→1200 字符、多行渲染（条目各自
  成行）、行数封顶 16 行且截断可见；整块渲染上限 400→1600 字符。
- **新增公共导出**：`createAssemblyPort` / `assemblyPortOptions` /
  `createModelConfigResolver` / `createFileNotesStore` / `assertNotesStore` /
  `NotesStoreError` / `isNoteRecord` / `boundedRecall` / `normalizeOpenAIUsage` /
  `normalizeOpenAIStopReason` / `parseOpenAIToolArguments` /
  `createOpenAIStreamAccumulator` / `DEFAULT_REFLECTION_MIN_ROUNDS`。
- 显式 notes、持久化失败诚实上报（#109）、guard 防伪造职责、折叠值锚点 stub 泛化到
  全部 tool_result。

## [0.5.1] - 2026-09-15

### fix

- 修复折叠摘要、导航记录、stub、`[本 run 状态]` 和 run state 重复累积的问题。根因是 run-state
  前置使旧摘要无法被识别；现按 `FOLD_SUMMARY_MARKER` 识别并替换，保留去重后的历史 stub 与导航信息。
- 0.5.0 用户应升级；该缺陷会导致长会话上下文膨胀。

### test

- 新增端到端 Memento 场景集成测试（`test/integration/memento-scenario.test.js`），覆盖 S1 折叠后真值仍在请求负载、
  S2 凭据不进 stub、S3 重跑告知与双份归档、S4 两次折叠替换语义、S5 bounded recall 逐字节拼回与游标拒绝；
  断言面向 provider 侧请求，补上“接线类 bug 无法被内部结构断言发现”的盲区。

## [0.5.0] - 2026-09-15

### Breaking

- CLI 终稿 provenance guard 改为默认关闭；需要核验时显式使用 `--final-guard` 或
  `ERIX_FINAL_GUARD=1`。`--no-final-guard` 保留为兼容 no-op，库 API 的 `finalGuard` 注入语义不变。
- **行为变更**：相同规范化命令再次执行不再拦截；执行照常完成后告知首次记录与工件状态，
  成功归档时 metadata 返回 `rerunOf`（首次 round/artifactId/digest/locator/status），
  归档序号会从既有目录恢复并在跨进程冲突时安全递增。该告知不撤销付款、删除、发布、
  写入或外部 API 副作用，也不是正确性保证。
- 本版本包含宿主可见的默认行为变化与新的 `runToolLoop`/TranscriptStore API，按语义化版本规则从
  0.4.0 升为 minor 版本 0.5.0；宿主必须阅读消费者契约后再升级。

### Changed

- 重跑告知现在以 `rerunOf` 和工件状态 `ok`/`truncated`/`missing`/`stale`/`unrecoverable`
  表达事实；副作用与重跑风险不由引擎替宿主裁决。
- `replayableSource` 的优先级固定为 `declared > policy > heuristic > unknown`；`unknown`
  不再提供布尔安全断言。
- 折叠导航记录保持有界并仅用于地址导航；折叠 stub 保留非重放结果的安全最小事实，不把值
  伪装成语义决定或 provenance 证明。
- 工具剩余轮次不超过 2 轮时继续发出低预算提示；达到上限、stall 或 continuation 耗尽时默认追加
  `forcedFinal` 收尾，`ERIX_NO_FORCED_FINAL=1` 可显式关闭。

### feat

- `exec` 重复执行结果元数据附带首次 `rerunOf`（round/artifactId/archivePath/digest/locator）
  与机械工件状态 `ok`/`truncated`/`missing`/`stale`/`unrecoverable`。
- TranscriptStore 新增对象参数 bounded recall API（`limit`/`cursor`/`maxBytes`），
  在 store 源头限制返回切片并提供绑定全部参数的可续取游标与
  `unrecoverable`/`stale`/`truncated` 状态；`artifactRef` 精确过滤，零上限显式拒绝，
  游标增加跨进程可用的内容完整性校验，篡改即拒且不返回正文；文件 store 对超大 JSONL 单条记录返回 `record_too_large` 并以游标推进而不整行物化；
  旧位置参数 `recall` 保持兼容，CLI 不新增 recall 工具。
- 折叠时可由 CLI/宿主注入 `stubFor`，为不可重放工具结果保留有界、去凭据的最小事实 stub。
- 折叠状态加入替换式、有界的 `navigationRecord`（最多 10 条 artifact、最多 400 字符），
  携带 `locator`/`digest`/`status` 供模型导航和归档对账，不注入捕获值。
- 工具和归档 metadata 增加 `replayableSource`（`declared`/`policy`/`heuristic`/`unknown`）；
  `unknown` 继续归档但不宣称可重放、不触发重跑拦截。
- 增加 store/无 store 折叠终止、折叠轮次范围、stub 脱敏与截断、归档失败、
  replayability 来源优先级、unknown、resume 重入和导航记录边界的确定性契约测试。
- 新增确定性 run state：预算/低预算提示、工具调用与失败、`filesWritten`、注入式 todo 状态、
  折叠与导航计数、不可重放/不可恢复捕获、终止及工具/checkpoint/归档错误计数；持久对象
  具备 64 KiB 总硬顶与条目/字段上限，裁剪带 `bounds.truncated` 标记，替换式注入并支持
  resume 幂等；未知、缺字段或损坏 schema 显式返回 `state_unavailable`，不静默恢复默认。
- 新增宿主注入的 `todoStateProvider`/`semanticStateProvider` 接口；语义半只接受有界文本与版本，
  版本不匹配明确标为 `stale`，引擎不调用模型。
- 工具结果在剩余轮次不超过 2 轮时追加预算提示；轮次上限、stall 或 continuation 耗尽且没有终稿时，loop 可追加一次禁用工具的强制收尾。
- `note_list` 按 `relevance` 降序、`updated_at` 降序排序，并支持 `minRelevance`、`tag`、`source` 筛选；自动捕获默认 relevance 为 `0.8`，旧记录按 `0.5` 处理。

### fix

- 修复实验护栏在已传 `--yes` 时仍打印 dry-run 提示的问题。
- 成本预估改用历史最大值（下限）而不是均值，避免系统性偏乐观。

### docs

- 新增 `docs/host-consumer-contract.md`，明确 verification、bounded recall、replayableSource、
  重跑告知以及 ADR-012/013 的宿主责任边界。
- 新增 ADR-013 guard 章程：guard 只做精确比对，禁止从模型自然语言推断，保持 opt-in；
  同步补充 ADR-012 与范围修订评估中的确定性 run state 决策。
- README 增加消费者契约入口、run state 说明，并同步 0.5.0 发版与宿主迁移要点。
- 明确 `verification.status === "skipped"` 时 CLI 仍可退出 0；只有 `verified` 才表示来源已核验，
  并收窄跨进程重跑、bounded recall 源头限流和 run state 有界性的措辞。

## [0.4.0] - 2026-09-14

### Breaking

- `9fd2277`（#74）：移除 `--notes-ledger`、`ERIX_NOTES_LEDGER` 及 notes 值索引/ledger 的所有 system prompt 注入通道。
- `9fd2277`（#74）：`note_read` 移除 `version`；notes 改为 `current` + 最多 3 条 `superseded` + `folded`，状态收敛为 `active`、`done`、`revoked`，工具返回 status 收敛为 `found`、`missing`、`revoked`、`invalid`、`unsupported`。
- `9fd2277`（#74）：移除 `ERIX_RUN_ID`、`ERIX_NOTES_HISTORY_LIMIT`、`ERIX_NOTES_MAX_HISTORY`、`ERIX_NOTES_MAX_VERSIONS`、`ERIX_NOTES_LOCK_TIMEOUT_MS`、`ERIX_NOTES_LOCK_STALE_MS`；notes scope 改由宿主显式 `__erix` 或 cwd 派生。
- `9fd2277`（#74）：移除版本链、per-key 锁、形态 token 扫描和重复恢复指引；归档 capture manifest 仍是 guard 唯一信任源。
- `740331a`（#76）：**guard 语义变更**——终稿核验从「形态推断」改为「来源核对」：涉及本 run 捕获值时需带来源（`来源=note_read:<key>` 或 `来源=归档:<文件名>`）；无可核验来源的重跑捕获值会被判 `unverified`（CLI 退出码 2），不再静默交付。

### feat

- `bf5e885`：新增 notes 技能，提供 run scope 的 `note_take`、`note_read`、`note_list`、`note_forget` 四个工具，并随包分发。
- `fe71758`：增加 auto-capture 引用式捕获、非幂等命令 sidecar 和 GC 墓碑验证。
- `ab525fb`：增加库级 `finalGuard`、CLI provenance 核对和 fail-closed 标记。
- `0d15747`：加入 notes 实验矩阵、真实 CLI 跑数和报告，为后续可用性修复提供基线。

### fix

- `8f4e352`、`2bb9497`、`b049c66`、`1c1ff54`：工具结果超过 800 字符时归档到
  `<transcriptDir>/outputs/<runId>/`，把归档目录注入 system prompt 和折叠摘要 `recoveryHint`，
  并在重复命令时返回首次输出归档位置，避免重跑结果冒充原值。
- `4308b98`：收紧提示词来源约束，禁止重跑值冒充一次性原值，并将端到端验证改为摘要保真度检查。
- `f7502c4`、`e172f08`、`52db092`、`05d5580`：补齐 notes 并发安全、scope 接管与生命周期，
  使 provenance 不可由 notes 伪造；capture manifest 成为唯一信任源，归档 digest 一致性、凭据过滤、
  guard 全覆盖和 `guard_error` 语义均 fail-closed/显式记录。
- `d86dfbc`：非幂等命令即使输出很短也写 sidecar，并拦截同一命令的重跑；更正被错误接线污染的实验结论。
- `f26ea47`：移除 CLI recall 工具，折叠摘要改由调用方注入 recovery hint，`recall.js` 优先使用
  `store.recall()`。
- `0f5cfa1`、`939886e`、`5d56397`：notes 从“只存引用”改为短值直接存入 `content`，同时保留
  `artifactRef` 审计链；增加值型索引（`note_list` 只列 key/标签）、中文工具描述和一步 `note_read` 取值。
- `5062cd6`：修复 final-guard 假阴性，不再把归档文件名和定位元数据当作待核验值。
- `d4eae32`：修复生产阻塞项：protected messages 超预算时降级并记录
  `compactionStats[].protectedDowngraded`，CLI 给出警告；`filesWritten` 支持
  `writeToolNames` / `writeToolPathKeys`，默认写工具仍为 `writeFile`；补充 #30/#32 验证结论。
- `79787de`、`91fdcea`、`55ce957`、`54f6af6`、`31f0a44`、`7917d63`、`758321c`、
  `1a511eb`、`d138e85`、`bfaa764`：合并上述 notes、归档、provenance 和生产阻塞修复批次。
- `9fd2277`（#74）：notes 记忆层瘦身——删除值索引/ledger 注入、版本链与有界历史、per-key 锁与租约、
  `ERIX_RUN_ID` 双轨作用域、guard 形态 token 扫描、`relevance` 字段与分散的恢复指引。
- `740331a`（#76）：静默错答结构性修复——根因是「系统折叠掉真值 + 允许一个会撒谎的恢复动作（重跑）+ 无条件信任输出」。
  修复为三件事：① 折叠点状态标记（丢失可见，不含值/key）；② 混合非幂等重跑前置警示（首次值指针），
  ③ guard 降级为**来源核对器**：首次捕获值直接放行；后续重跑捕获值需来源指向该 artifact（记 `rerun_cited`）；
  归属值不对应任何捕获则 revise；无归属则 `skipped`。散文式归属（`label 是/为 value`、`label: value`）纳入核验，
  且不再因终稿引用归档路径而误杀正确答案。

### docs

- `1990991`：新增 `docs/research/2026-09-13-notes-why.md`，记录 notes 取回链路断裂、
  CLI 接线污染和人工复核后的结论；`docs/research/2026-09-13-notes-experiment.md` 记录有效重跑、
  provenance gate 和 notes ledger 的实验矩阵。
- 更新 README 的 0.4.0 能力说明、notes 的“值 + 引用”行为、`writeToolNames` 配置以及宿主接入要点。
- 早前批次的流式透传、checkpoint fail-closed、resume 补全、file store、providers 兼容修复、
  repl 会话、MCP 生命周期和输入校验已在 0.3.5 发布，详见 0.3.5。

### Changed

- `9fd2277`（#74）：notes 数据模型改为 `current` + `superseded[≤3]` + `folded`，生命周期收敛为 `active`/`done`/`revoked`；非幂等 exec 每次只自动捕获一条有界输出摘录（逐行凭据检测，命中则只存 `artifactRef`）；verification 输出 `verified`/`skipped`/`revised`/`unverified`/`guard_error` 度量。
- `740331a`（#76）：折叠点注入 `[本 run 状态]` 标记（不含捕获值/key，替换而非追加）；非同命令的非幂等重跑前置警示（含首次值 `note_read` 指针与归档路径）并置 `rerunDetected`；verification 度量增加 `rerun_cited`。
- `f4ad713`（#72）：修复 `test/notes-autocapture.test.js` 中唯一的嵌套 `test()`（父测试先结束导致子测试被取消），全量测试连续 5 次稳定通过。

### refactor

- `9fd2277`（#74）：notes 记忆层瘦身——notes + auto-capture + final-guard 机制代码 1812 → 1142 行（-37%）；system prompt 注入通道 3 → 0，每轮额外 I/O 归零，工具返回 status 10 → 5，删除 `relevance` 死字段与分散的恢复指引。

### 行为变更与宿主接入

- `writeToolNames` 新增为 loop 选项；不再通过工具名猜测自定义写工具，路径参数由
  `writeToolPathKeys`（默认 `["path", "file_path"]`）解析。
- CLI 新增 `--no-notes`、`--notes-ledger`、`--no-final-guard`；`wrapup: false` 与
  `ERIX_NO_WRAPUP_INSTRUCTION=1` 会关闭整个 wrapup 指令/解析/替换/归一化协议。
- provenance gate 的 `unverified` 结果对应 store 的 `unverified_error` 和 CLI 退出码 2；
  guard 异常或超时对应 `guard_error` 和退出码 3。宿主应先检查 `verification.status`，
  只有 `verified` 才消费为已核验终稿。
- notes 是 pull-only：system prompt 只提供值型笔记的 key/标签索引，不注入笔记值；模型需要时调用
  `note_read`（未知 key 才先 `note_list`），归档引用只用于审计和有界恢复。

[0.6.0]: https://github.com/ErixWong/erix-agent/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/ErixWong/erix-agent/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ErixWong/erix-agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ErixWong/erix-agent/compare/v0.3.5...v0.4.0
