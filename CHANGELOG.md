# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。

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

[0.5.0]: https://github.com/ErixWong/erix-agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ErixWong/erix-agent/compare/v0.3.5...v0.4.0
