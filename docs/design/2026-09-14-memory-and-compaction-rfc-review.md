# RFC《记忆系统与折叠方案全面重构》独立对抗性评审

- 对象：`docs/design/2026-09-14-memory-and-compaction-rfc.md`
- 对象 PR：[ErixWong/erix-agent#81](https://github.com/ErixWong/erix-agent/pull/81)
- 性质：静态代码/文档评审；**本评审没有发起任何模型、relay 或实验调用**
- 相关重构：[Issue #82](https://github.com/ErixWong/erix-agent/issues/82)

## 0. 结论先行

RFC 抓住了真正的问题：上下文视图的丢失不能把正确性外包给模型提示词；`foldedPayload`、归档 provenance、可重放性和模型效率必须分层。但是 RFC 把三个不同问题混在一起：

1. **档案数据面**：当前已经有 append-only transcript、`foldedPayload`、轮次范围和按范围 `recall`。因此“折叠必然丢真值且没有地址”作为当前仓库的绝对断言不成立。
2. **模型可见控制面**：CLI 默认不把库的 `recall` 工具放进 schema；generic host 也可以不注入 `stubFor`/`protectedMessage`。因此“档案存在”不等于“模型有低摩擦、可靠的导航”。
3. **策略与实验面**：RFC 的大量 e2e 数字只在 RFC 或机器结果中出现，部分有 tracked 原始聚合，部分没有可审计的对应物；若没有 run manifest、版本、输入协议和原始结果，不能从中推出因果结论。

建议不按 RFC 原样进入一次性大重构。4.0.0 之后先做兼容的真相/来源契约与确定性回归，再做有界导航索引；自动抽取“决策/约束”、profile 默认值、LLM 叙事摘要和跨 run 记忆全部后置。

## A. 事实核对

### A.1 D1-D8 逐条核对

| 断言 | 结论 | 代码/文档证据与反证 |
|---|---|---|
| D1：折叠会丢后续需要的真值，且不留地址 | **部分成立，绝对表述不成立** | 视图确实会移除被折消息；但 loop 把 `foldedPayload` 与 `foldedRoundRange` 写入 round record（`src/loop.js:2633-2642`），file store 按 round 过滤并同时检索 `messages`/`foldedPayload`（`src/store/file.js:231-264`），memory store 也如此（`src/store/memory.js:73-100`）。contract test 验证范围和 `foldedPayload` 可回取（`test/contract/transcript-store.js:84-130`）。CLI 当前也确实传入 `stubFor`（`bin/cli.js:559-566`），并把不可重放结果归档/自动捕获（`bin/tools.js:749-785`）。真正成立的较窄命题是：**没有 store、没有 host recall、没有 stub 或归档失败时，模型可见性和恢复路径不受库核心自动保证**；README 也明确“未注入 `stubFor` 时保持原有丢弃行为”（`README.md:90`）。RFC 附录中的 nonce e2e 没有在 tracked 测试/报告中找到对应 run manifest，因此该具体实例仅口头证据。 |
| D2：保护判据按角色而非可恢复性 | **核心成立，但“只跳过”略夸大** | CLI 默认使用 `protectedMessage: isRealUser`（`bin/config.js:126-144`）；`selectFoldedRounds` 按消息是否命中保护函数选整轮（`src/compact/helpers.js:54-72`），不是按值是否可重放或未来价值选。coding 中“用户发言极少、保护几乎无收益”是场景推断，不是代码事实。预算不足时 loop 还会显式降级最旧 protected 消息并记录计数（`src/loop.js:526-550`、`src/loop.js:2104-2112`），所以不是永远跳过。 |
| D3：可重放性由引擎猜、写死正则 | **现象成立，责任归因错误** | 写死正则和分类确实存在于 CLI 参考工具（`bin/tools.js:30-44`、`bin/tools.js:706-715`），不是 `src/loop.js` 的引擎规则。loop 接收 executor 返回的 metadata 并原样放进 canonical `tool_result`（`src/loop.js:1504-1541`）；ADR-005 规定执行由调用方负责（`docs/decisions/005-tool-system.md:11-17`）。准确说法应是“当前 CLI host 的 exec policy 是 heuristic，核心只消费 host 提供的 metadata”。 |
| D4：按完全相同命令串拦截，可改写绕过 | **机制成立；具体 bash e2e 仅口头证据** | duplicate map 以 normalized command 为 key（`bin/tools.js:718-735`），只有相同 key 且 `!replayable` 才读取首次捕获并拦截（`bin/tools.js:739-745`）；不同命令会真正执行并只附首次值警示（`bin/tools.js:788-796`，测试 `test/notes-autocapture.test.js:322-344`）。仓库测试已经覆盖不同 shell 包装命令的“允许重跑但带警示”，但 RFC 指出的原始实验文本/完整 run 未找到。 |
| D5：删除值索引时连唯一导航索引也删除，折叠后模型无目录 | **过度断言；模型可见导航确实不完整** | 当前 fold summary 至少包含折叠轮次和工具足迹（`src/compact/fold-statistical.js:102-108`），archive recovery hint 还生成最多 10 条不可重放归档的目录视图（`bin/final-guard.js:192-205`），并把候选值与归档路径做成最多 200 字符 stub（`bin/final-guard.js:207-250`）。同时，`createRecallTool` 虽然支持 overview、pattern、范围和硬顶（`src/tools/recall.js:273-355`），CLI 明确测试“不带 recall 工具”（`test/cli.test.js:199-215`）；这支持“导航没有自动接到 CLI 模型 schema”，不支持“仓库完全没有地址索引”。RFC 中“2–6 个归档/run、6–21 次 note_read”的具体数据未在 tracked 报告中找到，属于仅口头证据。 |
| D6：guard 默认关导致丢失可见和归档索引一起消失；CLI 未传 stubFor，stub 是死代码 | **当前代码反证，断言已过时** | guard 默认关闭只影响是否调用 final provenance gate（`bin/cli.js:154-160`）；compaction context 无论 guard 是否开启都把 `buildCaptureRecoveryHint` 和 `buildCaptureStub` 传进去（`bin/cli.js:559-566`）。`buildCaptureRecoveryHint` 的 `[本 run 状态]` 生成处虽在 `bin/final-guard.js:253-262`，它是被 CLI 作为 recovery hint 调用的普通函数，不是 final guard 的执行结果。`stubFor` 的功能由策略调用（`src/compact/fold-statistical.js:218-241`、`src/compact/helpers.js:115-124`），且有测试（`test/compact/fold-statistical.test.js:164-220`）。仍成立的较窄问题是：没有 compact budget/context window 时 CLI 不传 recovery hint；库宿主不注入 hook 时也不会自动生成 stub。 |
| D7：notes 作为折叠解由模型自写，依赖元认知 | **效率层面成立，作为正确性批评成立** | `note_take` 确实由模型工具调用写入，且返回“后续需要先 note_read”的引导（`skills/notes/skill.mjs:348-416`）；note schema 的 `when-to-use` 也要求模型决定何时记录（`skills/notes/skill.mjs:665-712`）。但 CLI 对不可重放输出另有自动 capture 路径（`bin/tools.js:337-345`、`bin/tools.js:776-785`），所以“所有 notes 都由模型自写”不准确。ADR-012 明确 notes 只能是效率捷径、不能承担正确性（`docs/decisions/012-engine-truth-model-efficiency-host-policy.md:17-23`、`:33-38`）。RFC 说“修复后 3 次/run”等具体调用数字没有可审计的原始 run 记录。 |
| D8：主要失败原因是不收敛而不是不查证 | **有方向性证据，不足以证明主因/因果** | tracked 矩阵确实显示 deepseek-flash 三臂共 30 个 run 全部 `noAnswer`、平均 12 轮；B/C 分别有 30/28 次 `note_read`（`docs/research/2026-09-14-notes-matrix-n30.md:17-31`），这支持“调用工具不等于收敛”。但“因此主要原因是收敛”仍是解释而非实验识别：各臂同时改变 notes/guard/提示/归档路径，矩阵自己承认混杂和 n=10/臂功效不足（同文件 `:31-55`）。RFC 所称修复后 deepseek-flash n=3、3/3 和 token 数未在仓库其他文档/JSON 中找到对应物，属于仅口头证据。 |

### A.2 附录 A 的实证可追溯性

| 附录断言 | 仓库中能否对应 | 评审判断 |
|---|---|---|
| chat 旧 `combineTools` 未包含 notes | **能** | 旧批次污染声明在 `docs/research/2026-09-13-notes-experiment.md:62-65`；当前实现已改为合并 skill tools（`bin/cli.js:356-372`），不能继续当作当前缺陷。 |
| kimi n=14/臂，21.4%/7.1%，guard 92.9% | **部分能** | `scripts/notes-experiment-results.json:14596` 有 21.4%/7.1% 的机器结果；但 RFC 的“额度污染”、完整臂定义、guard 92.9% 需要关联该 JSON 的 batch/run 元数据，RFC 没给指针。应标为可追溯但证据上下文不完整。 |
| deepseek-flash n=10/臂、30/30 noAnswer、note_read 3/run | **能，数值需精确表述** | 聚合表 `docs/research/2026-09-14-notes-matrix-n30.md:17-31` 支持 30 个 run 全部 noAnswer；B 为 30/10，C 为 28/10，不是所有臂恰好 3/run。 |
| 修复后 pilot n=3、3/3、7/6/14、77,591 input | **找不到** | RFC 是唯一命中这些精确数字的文件；标为**仅口头证据**，不能作为 release gate。 |
| guard 构造输入零调用 | **能以确定性测试对应** | 九类 provenance contract 在 `test/notes-final-guard.test.js:90-120`，文件名/来源边界在 `:220-249`；但 RFC 的 A/A′/E/B/D/G 标签没有映射表，无法逐项复算。 |
| 静默错答 nonce 实例 | **找不到** | 精确值只出现在 RFC；没有提交的 transcript、manifest、provider 请求和版本锁定，标为**仅口头证据**。不在本评审重复具体值。 |
| 341k 预估、869,909 实际、2.5× | **找不到** | 没有成本账单、调用清单或原始结果对应物，标为**仅口头证据**。 |

### A.3 自相矛盾与既有 ADR 冲突

1. **RFC 自身的 P3/P4 冲突**：P3 说可恢复信息只留指针、不留副本（RFC `:34`）；P4 又要求不可重放值保留原值（`:35`），目标架构 Tier 0 还定义为完整 transcript。应区分“上下文视图不放副本”和“档案/安全 stub 保留副本”。
2. **Tier 1 不含值 vs B 策略保留值**：验证方案要求索引“不含值”（RFC `:181`），但 B 说保留值/决策/约束原话（`:108-110`），Memento 示例也放了 nonce（`:136-142`）。需要定义“索引元数据”和“受保护事实 stub”两种不同对象。
3. **D6 与当前实现矛盾**：RFC `:77` 说 CLI 未传 `stubFor`，但 `bin/cli.js:559-566` 明确传入。
4. **D5 与当前实现/ADR-002 矛盾**：RFC `:76` 说没有地址；当前有 `foldedRoundRange`、fold summary 的范围和 archive index（`src/loop.js:2633-2640`、`src/compact/fold-statistical.js:102-108`、`bin/final-guard.js:192-205`）。问题是没有统一的模型-facing recall 接线，而不是零地址。
5. **RFC 把“问题域①完整实现不成立”说得太强**：ADR-010 的“完整”至少指近无损 transcript + recall 数据面（`docs/decisions/010-context-shaping-philosophy.md:10-18`）；ADR-002 还明确规定 fold 只影响视图、原文留在 store（`docs/decisions/002-transcript-store.md:18-29`）。RFC 足以挑战“模型导航 UX 完整”，不足以否定“档案数据面近无损”的原决策。建议修 ADR-010 的限定语，不要反转整条决策。
6. **与 ADR-012 的偏差**：ADR-012 把 `stubFor`、`finalGuard`、TranscriptStore 明确放在宿主策略边界（`docs/decisions/012-engine-truth-model-efficiency-host-policy.md:17-23`）；RFC 却把 exec 分类、重复拦截和“值不离开上下文”写成引擎统一机械保证（RFC `:155-162`），但没有定义宿主策略与引擎未知状态的冲突协议。
7. **章节计数错误**：RFC 第 8 节标题要求评审开放问题，但实际只编号了 7 个问题（RFC `:211-217`），不是 8 个。

## B. 第一性原理审查

### B.1 P1-P4 是否完整

四条原则是有用的安全直觉，但不是完整的不变量集合：

- **缺少销毁时机**：必须在视图删除前完成 capture、digest、checkpoint 和索引；“压缩时再分类”可能已经错过工具返回/归档失败窗口。当前 checkpoint 甚至明确是 at-least-once，副作用工具需宿主幂等（`docs/decisions/002-transcript-store.md:31-35`）。
- **缺少销毁代价**：分类、写归档、建索引、再次读取和 LLM 摘要都消耗时间、磁盘、token 和上下文预算。P1 只说未来价值，没有规定 `cost <= saved_context` 或超时策略。
- **缺少多 consumer 语义**：模型、final guard、judge、resume worker、审计器可能需要不同视图。一个“可见/已丢弃”标记不能假设只有模型一个消费者；guard 默认关闭也不能改变档案事实。
- **缺少并发/重入**：file store 只保证单进程单 run 的 append lock，跨进程写同一 transcript 是设计外场景（`src/store/file.js:176-183`）；notes 的 current 更新也必须面对同 key 并发写。`onAfterFold` 若再次触发 fold/store 读写，需明确不可重入或版本检查。
- **缺少跨 run/生命周期**：pointer 需要 retention、GC、权限、runId/episode 身份和失效状态；ADR-002 把生命周期与 runId 唯一性交给调用方（`docs/decisions/002-transcript-store.md:45-52`），RFC 不能把“地址”当成永不过期。
- **缺少机密/权限不变量**：P4 的“保原值”可能把 secret 带进 stub、index、日志或跨 consumer。当前 stub 至少过滤候选 credential（`bin/final-guard.js:232-249`），但 RFC 没把该过滤、digest、访问控制和日志脱敏提升为统一契约。

建议新增 P5-P8：

| 原理 | 必须保证 |
|---|---|
| P5 时序 | 先 durable capture，再从视图删除；每次折叠有单调版本、范围和 provenance。 |
| P6 成本 | 每个恢复路径有硬顶、超时和 fail-closed 状态；不能用无限 recall 换取“可逆”。 |
| P7 多 consumer | “档案真相”“模型视图”“验证视图”分离；任何 consumer 都不能把索引当真相。 |
| P8 失效 | pointer、artifact、index 都能明确变为 stale/missing/unauthorized，而不是空字符串成功。 |

### B.2 判定法 A/B 不足之处

**判定法 A**（删提示词看正确性）能检验“提示词是否承重”，不能检验效率、成本、延迟、模型是否会主动查找，也不能证明删除后仍有可调用的机械恢复 API。反例：删掉 `[本 run 状态]` 后档案仍完整，正确性理论上成立，但模型可能不再读取归档，任务完成率/成本下降；A 会把效率损失误判成“没有问题”。

**判定法 B**（能无损重新获得就可丢）把“可获得”误当成“可重建”。以下反例会让它失效：

- 归档被截断、digest 对不上、文件被修改或 retention 已 GC：可以“读到东西”，但不是原值；归档本身最多 1 MiB 且会标记 `truncated`（`bin/tools.js:393-449`）。
- 需要权限、网络、时间窗口或宿主状态的输出：理论上可再取，实际可能不可访问。
- 文件当前状态可重读，但历史决策/用户约束不在工件中；“同一代码状态”不等于“同一理由”。
- 命令值可由固定 seed 重建，但工具有副作用；值可重建不代表可以安全重跑。

应把 B 改为：**在声明的 retention、权限、digest、版本和成本上限内，能得到 byte-identical artifact 或明确证明不可得**。否则分类为 `unknown`，按不可安全重放处理。

### B.3 Tier 1 是否会成为新的“会说谎的中间层”

会。误抽取、过时范围、重复合并、权限变化和摘要漂移都会让索引看起来像事实。RFC 的“索引错了可从 Tier 0 兜底”只有在模型/host 真的提供可用的全局查询且查询不会撑爆上下文时成立。

要保证“索引绝不承重”：

1. Tier 1 条目必须带 `sourceRef`、`artifactId`、`digest`、schema/version、生成时间和状态；没有 sourceRef 的条目只能作导航提示，不能作事实。
2. 任何“值/决策/约束”在交付或 guard 中都必须回到 Tier 0/artifact 核验；index 命中不能直接满足 provenance。
3. 用确定性来源优先：工具 metadata、round range、显式 user message 和 host 注释；LLM/heuristic 抽取只能标为 `derived`，不能覆盖 `observed`。
4. retrieval 发现 digest、范围或权限不匹配时返回 `stale`/`missing`/`unauthorized`，不能返回空成功。
5. index 条目数、字符数、每次 recall 总预算必须硬顶；超过上限要有 continuation cursor 或显式失败。
6. 维护 `indexVersion` 和 rebuild/invalidated 事件，禁止把旧索引静默套在新 run 或新 archive 上。

### B.4 “coding = A+B，默认不用 LLM 摘要”是否站得住

作为**4.0.0 的保守默认**基本站得住：编码的工件和测试结果通常可重读，确定性 stub 没有 LLM 漂移；ADR-010 也认为编码原文信息密度高、状态在磁盘（`docs/decisions/010-context-shaping-philosophy.md:68-75`）。但 RFC 把它说成 coding 的主路径而没有边界，仍有风险：

- 长 coding 会话需要“为何选择方案 B”“哪些尝试已失败”“用户不允许改什么”；文件/测试只能回答部分“是什么”，不能完整回答因果叙事。
- B 的“原话截取”会把噪声、重复讨论和相互否定的决定一起保留；没有状态机就无法判断哪个决定 superseded。
- A+B 没有明确保留未完成阶段、验收标准、失败尝试和当前 blocker；只留值/指针可能导致重复工作。
- 叙事摘要并非只能全量默认或完全禁用。更合理的是 host/任务显式 opt-in，或异步冷循环生成带来源的 phase ledger；不把它放在请求路径的正确性链上。

### B.5 “可重放性由工具/宿主声明”如何落地

方向正确，但 RFC 的 `true|false` 不够：

- 工具 schema 的静态属性无法表达某一次调用的动态状态；exec 结果应携带 invocation-level `replayability: "yes"|"no"|"unknown"`、policy id、reason、artifactRef 和 digest。
- host policy 与引擎 fallback 必须规定优先级：**宿主执行器的明确 `no` 优先；明确 `yes` 不能覆盖不可验证的 artifact/side effect；缺失或冲突一律 `unknown`，按 no-safe-replay 处理**。引擎 fallback 只能收紧，不能把 host 的 `no` 放宽为 yes。
- `replayableSource` 是 provenance 元数据，不是事实授权。消费方可以用它解释和统计，但不能因为 `"heuristic"` 就把重跑值当原值。
- “按声明类别拦截”仍需相同 invocation identity 或 host 提供 dedup key；仅按“类别”拦截会误把两个不同参数、不同资源或不同时间窗口当成同一调用。
- checkpoint 的 at-least-once 语义意味着“拦截重复执行”不能代替宿主幂等；这点已有 ADR-002 明确约束（`docs/decisions/002-transcript-store.md:31-35`）。

### B.6 Memento 契约“非承重”是否自洽

对正确性自洽，对工程效率不完整。删除契约后不应产生静默错答，这是 ADR-012 的正确要求（`docs/decisions/012-engine-truth-model-efficiency-host-policy.md:33-38`）；但“效率”也不是免费赠品，至少应验证：

- token/input 是否下降；
- recall 首次命中延迟、调用轮数和重复调用率是否下降；
- 错误指针、stale pointer、误导性摘要是否增加；
- 折叠后未完成工作、约束和 artifact provenance 是否保持；
- 契约被截断或多个折叠合并时是否替换而非膨胀。

因此 Memento 应当是**可丢弃的缓存/导航层**，有 deterministic fallback（overview、round watermark、artifact list），并以 telemetry/确定性测试证明效率收益；不能只写一段提示词然后声称非承重。

### B.7 本 RFC 是否真的解决“模型不调工具”

**没有从根上解决，只降低了调用成本。** 当前代码证明：

- CLI 合并 notes skill，但不自动把 `recall` 放入 schema；测试明确断言 `recall` 不在 chat tools 中（`test/cli.test.js:199-215`）。
- final guard 默认关闭（`bin/cli.js:154-160`），即使开启，无法比较的终稿也可以 `skip`（`bin/final-guard.js:369-377`），不是强制取回。
- tracked deepseek 矩阵中 notes 被调用但 30/30 noAnswer（`docs/research/2026-09-14-notes-matrix-n30.md:17-31`），说明“提供提示/工具”不等于收敛。

真正的解决方案应是：对不可重放值由引擎/host 自动保存、在终稿协议中绑定 artifact provenance；模型不取回时交付 `unverified`/`unrecoverable`，而不是继续赌提示词。若产品接受“模型可能不查，任务因此失败”，则 RFC 应明确这是效率改进而不是可靠性保证。

## C. 遗漏、风险与宿主影响

### C.1 RFC 未覆盖的失败模式

1. **Tier 3 自身撑爆上下文**：file store 的 `recall` 先把匹配内容累加成完整字符串（`src/store/file.js:231-264`）；`src/tools/recall.js` 的分段/硬顶在 store 返回后才执行（`:258-269`、`:300-348`）。大段结果可能先耗尽内存、延迟或日志，再被截断。
2. **索引数量与膨胀**：RFC 说“有界/替换式”，没有规定每次/每 run/每 profile 的条目数、字符数、版本和合并规则；多次 fold 的旧索引可能重复。
3. **recall 滥用与乒乓**：工具可以被模型反复调用；当前每次有局部 hard cap，但没有跨轮累计 retrieval budget 或重复请求去重（`src/tools/recall.js:4-7`、`:296-355`）。
4. **多 run/跨 run**：notes 实际限制为 run scope，其他 scope 返回 unsupported（`skills/notes/skill.mjs:315-345`）；store recall 以 runId 隔离（`src/store/file.js:231-240`）。RFC 把跨 run LTM 留给宿主，但没有定义 archive pointer 如何防止误跨 run。
5. **宿主直接调用 `runToolLoop`**：若未传 `protectedMessage`/`stubFor`，`foldOptions` 默认为 undefined（`src/compact/helpers.js:150-183`），generic loop 只透传宿主显式给出的 context（`src/loop.js:2019-2028`）；这与 RFC 所称“引擎机械保证”不一致。
6. **并发 notes 写入**：当前 file transcript 明确只支持单写者/同实例锁，跨进程需要宿主锁（`src/store/file.js:176-183`）；notes 同 key 的 current/superseded 更新没有 RFC 级 compare-and-swap/lease 契约。
7. **错误与超时静默降级**：recall backend 异常会被捕获并回落到 `load`/undefined（`src/tools/recall.js:258-269`）；这可能把“存储失败”伪装成“未命中”。RFC 要求大声失败，却没有定义 retrieval error 的返回协议。
8. **归档失败/截断**：不可重放归档失败时当前实现会返回“原始输出不可恢复”的提示（`bin/tools.js:466-480`），但 RFC 没规定如何阻止后续 index 把它当可恢复 pointer。
9. **成本放大**：fold-llm 每次折叠增加一次模型调用（`src/compact/fold-llm.js:266-281`）；auto-capture、notes 写盘、manifest、index rebuild 也会增加 I/O 和延迟。RFC 没给 per-run cost budget。
10. **安全泄漏**：把原值放入 stub/index/Memento 可能泄漏 secret；当前代码只在 capture stub 候选提取处过滤（`bin/final-guard.js:232-249`），不等于所有 host 注入的 `recoveryHint` 都脱敏。
11. **side effect 与 replayability 混淆**：同一输出可重复但命令有副作用，或命令值不可重复但重新执行没有副作用；单一 boolean 无法表达两者。
12. **resume 与重入**：checkpoint 是 at-least-once，崩溃后可能再次执行工具；pointer/index 生成必须幂等，不能只在“正常 fold”路径成立。

### C.2 对宿主的影响与兼容迁移

受影响的现有契约包括：

- `recoveryHint` 是 string/function，function 接收 `foldedPayload`、`folded`、`retained`、`roundRange`（`src/compact/helpers.js:14-18`、`src/compact/fold-statistical.js:218-223`）。
- `onAfterFold` 接收 compact result，当前包括 `messages`、`foldedPayload`、`foldedRounds`、`tokensBefore/After`、可选 `foldedRoundRange`（`src/compact/fold-statistical.js:256-265`；其他策略同构）。
- `RoundRecord` 现有 `folded`/`foldedPayload` 是 store/resume/recall 的数据格式（`docs/decisions/002-transcript-store.md:18-29`；`src/loop.js:2633-2642`）。
- `verification` 有 `verified/skipped/unverified/error` 等状态，CLI 还把默认 guard 关闭作为兼容语义（`src/loop.js:1257-1268`、`bin/cli.js:746-765`）。
- CLI flags `--final-guard/--no-final-guard` 是用户可见行为（`bin/cli.js:42-55`、`:208-214`）。
- notes JSON 保存 `current + superseded + folded + provenance + artifactRef`，并以 run scope、墓碑和 superseded 语义读取（`skills/notes/skill.mjs:380-405`、`:430-473`）。

兼容策略：

1. **只增不改旧字段**：`foldedPayload`、`foldedRoundRange`、旧 summary 和旧 notes 继续可读；新增 `memorySchemaVersion`、`index`、`replayability` 时使用可选字段。
2. **双读一写**：新实现能读 legacy round record；在 feature flag 关闭时仍写旧格式；flag 开启后同时保留旧字段和新 index，至少经过一个版本窗口。
3. **回调契约保留形状**：扩展 payload 字段而不删除已有字段；`recoveryHint` 返回非空 string 的旧行为不变；`onAfterFold` 不改变 promise/错误传播语义。
4. **旧 host 安全默认**：未提供 replayability 时写 `unknown`，不把旧缺省值假设成 replayable；但暂不强行改变 4.0.0 的 compaction/guard 默认，避免 silent behavior change。
5. **迁移工具与回滚**：提供离线 rebuild index；每条 index 带 source digest；回滚只需关闭 profile/flag，旧 transcript 仍可由 `foldedPayload` 和 round range recall。
6. **notes 迁移**：不把 Tier 1 自动条目直接改写为用户 note；保留旧 JSON，新增 `provenance.source="index"` 也必须只读/可撤销，并避免覆盖 agent current。

### C.3 现在做什么，推迟什么

| 优先级 | 建议 | 理由 |
|---|---|---|
| **P0 现在做** | 补齐确定性契约测试：store 配置/未配置、folded payload、round range、stub 脱敏、归档失败、unknown replayability、resume 重入；把 RFC D6/D5 的过时表述改正。 | 4.0.0 刚发布，低破坏、可回滚、无需模型证据即可验证。 |
| **P0 现在做** | 定义 invocation-level replayability 与 host policy/fallback 优先级；保留现有 regex 作为 CLI fallback，但输出 `source/reason`，缺失为 unknown。 | 直接降低静默错答风险，且不要求一次改完所有 host。 |
| **P1 现在做（窄版）** | 增加统一、可选、带 digest 的 bounded navigation record：round watermark、artifact id、locator、状态；不自动抽取“决策/约束”原话。 | 解决模型导航缺口而不改变旧 fold 产物；能用确定性测试验收。 |
| **P1 先设计后实现** | host-facing bounded recall API，store 层从源头支持 limit/cursor/bytes，避免先构造全量字符串；定义 retrieval error/stale。 | 这是 Tier 3 的硬安全边界，不能只在工具层截断。 |
| **P2 推迟** | `coding/chat` profile 默认值、A+B/C+D 全面切换、保护判据从 role 改成可恢复性、策略 F。 | 需要真实 host 场景与非地板评测；默认行为变化可能破坏现有宿主。 |
| **P2/P3 推迟** | 自动决策/约束抽取、LLM 叙事摘要、notes 降级/删除、跨 run episode/LTM。 | 证据弱、语义误判和迁移面大；ADR-007/010 已把 LTM/冷循环放在宿主与后续阶段。 |

## D. 第 8 节开放问题的回答

RFC 实际列出 7 个编号问题；下面回答这 7 个，并补充一个被遗漏的第 8 问。

### Q1. Tier 1 决策/约束原话如何避免噪声，是否需要宿主抽取器？

不要先做通用自动语义抽取。第一版只收集可证明来源：显式 user message、host/tool metadata、结构化 `decision`/`constraint` callback；同一 key 以版本和 superseded 状态存储。宿主可以注入 extractor，但输出必须标 `derived`、带 sourceRef，不能覆盖 `observed`，也不能绕过 artifact 核验。

### Q2. 段索引粒度按轮次够不够，是否需要 topic 边界？

轮次范围是核心最小粒度，因为 store 已以 round 过滤；但单一 `{from,to}` 不能表达非连续折叠、跨 run 或 archive 文件。建议 `sourceRef[]` 支持多个连续范围 + artifact locator；topic boundary 作为宿主可选 metadata，不进入核心语义，不把 touwaka topics 变成 engine 真相。

### Q3. 可恢复性保护后预算如何分配？

不能从 role 全量改成“所有看起来重要的条目都保留”。固定降级顺序应为：

1. 不可安全重放且无完整 artifact 的值；
2. 显式 user constraint/abort/acceptance；
3. checkpoint/provenance 所需的最小 tool facts；
4. 有 digest 的 pointer/index；
5. 冗余工具足迹和叙事。

每一层都有 hard cap；若连第 1/2 层都放不下，返回可识别的 `context_budget_unrepresentable`/`unverified`，不静默降级。`protectedDowngraded` 只能作为告警，不能伪装成功。

### Q4. notes 去留？

保留，但缩小职责：notes 是显式语义便签和 host 可选效率缓存；自动 capture 是 provenance/index 数据，不应依赖模型 `note_take`。不要在没有迁移和使用数据时删除 notes；也不要把自动 Tier 1 直接写入 notes current，避免污染 agent 语义记录。

### Q5. coding 默认 A+B 会否损害长 coding 会话？

会损害一部分需要因果连续性的长任务，因此只能作为保守默认而非普遍真理。建议 default 是确定性 artifact/pointer + 小型 phase ledger；当任务 profile 明确需要叙事时，host opt-in fold-llm/异步摘要，且摘要仅改善效率，不能成为事实来源。

### Q6. ADR-010 的 psyche 边界是否要改？

要改限定语，不要推翻。ADR-010 关于 psyche=问题域②、recall=问题域①的边界仍成立（`docs/decisions/010-context-shaping-philosophy.md:10-18`）。应把“erix 折叠系 = 问题域①完整实现”改为“档案数据面近无损实现；模型-facing 导航/策略接线仍由 host 提供，尚未形成统一默认 UX”。

### Q7. 迁移与兼容如何处理？

采用上面的 additive schema：保留 `foldedPayload`/`foldedRoundRange`/回调字段，新增 `memorySchemaVersion` 与 index；旧 host 不认识新字段也能继续工作。先双写/双读和离线 rebuild，稳定后再考虑默认启用；不在 4.0.0 直接改变 guard、profile 或保护语义。

### Q8（RFC 漏列）. 如果模型仍然不调工具，系统保证是什么？

系统不能保证模型完成取回，只能保证不把未知值伪装成已验证值。不可重放值应由 host/engine 自动 capture；未核验终稿必须返回 `unverified`/`unrecoverable`，并让宿主决定重试或人工接管。若产品要求“必须完成”，就需要确定性终止/来源协议或 host-side retrieval，而不是增加更多提示词。

## E. 建议的分期重构方案

### Stage 0：冻结事实与契约（立即）

- 修正 RFC 对 D5/D6 的表述，补充每个实验的 batch/run manifest、代码版本、臂定义和失败分母。
- 把“档案真相”“模型视图”“验证视图”写成独立接口说明。
- 验收：所有当前测试保持；能用无模型 fake provider 重现 fold/recall/stub/guard 的确定性结果；无 provider/relay 网络调用。
- 风险/回滚：文档与测试无运行时风险；直接回滚文档即可。

### Stage 1：真相与 replayability 契约（P0）

- 增加 invocation-level tri-state replayability、source/reason/policy id、artifact digest/locator。
- host 明确 `no` 优先；缺失/冲突为 `unknown`；CLI regex 仅是 fallback，不改为引擎猜测。
- 保证 fold 前先 durable capture；folded record 继续保存 `foldedPayload` 和 round range；对 archive failure/truncation 显式建状态。
- 验收：同一 tool result 在 fold、resume、final guard 中 provenance 一致；未知值不能被标成 verified；重复 checkpoint 不产生错误的“原值”。
- 风险：新 metadata 影响 host schema。回滚：保留旧 `replayable` boolean 读写，新字段可选。

### Stage 2：bounded navigation 与 retrieval（窄 P1）

- 新增可选 `navigation` record，内容只包括 sourceRef、round range、artifact id、digest、locator、状态和有限工具足迹；不做通用 LLM 决策抽取。
- 将 `store.recall` 扩展为 host 可选的 limit/cursor/bytes 或 streaming contract，从源头限制读取；工具层保留现有 output hard cap 兼容路径。
- 取回失败返回 `stale`/`missing`/`unauthorized`/`timeout`，禁止空字符串伪装未命中。
- 验收：索引错误不能直接交付事实；每个导航条目可追溯到 round/artifact；多次 fold 替换同一索引版本而不膨胀；recall 的内存/输出有可测硬顶。
- 风险：宿主 store 适配器需要改接口。回滚：关闭 navigation flag，旧 `foldedPayload`/range 继续服务。

### Stage 3：CLI/host 接线与迁移

- CLI 继续传 `stubFor`/recovery hint；对 generic `runToolLoop` 提供显式 host adapter，而不是暗改库默认。
- 提供 opt-in recall tool/schema；保留当前“不默认暴露 recall”的兼容行为，直到 host 评测证明默认开启不会增加工具噪声。
- notes 维持 run-scope JSON 格式；新增 index provenance 不覆盖 agent current。
- 验收：旧 CLI flags、`verification` 状态、`onAfterFold`/`recoveryHint` 调用方均通过；legacy transcript 可读、新 transcript 可由旧读者读取。
- 风险：模型 schema 增加工具会改变行为。回滚：按 host/profile 关闭。

### Stage 4：受控 profile 与评测

- 先提供 profile 选择而不改变默认：`coding-deterministic`、`coding-narrative-opt-in`、`chat-host-owned`。
- 只用确定性 fixture 测 T1-T4；未来若做模型 pilot，先 3–5 次确认可区分，再按 ADR-012 报预算/模型/调用数并独立记录。
- 验收：T1 首次值与 artifact 一致且无未声明重跑；T2/T3 有 sourceRef；T4 无法恢复时 fail-closed；profile 的 token/round/retrieval 指标不劣化到不可接受。
- 风险：LLM 摘要漂移、成本放大、样本混杂。回滚：关闭 narrative profile，保留确定性路径。

### Stage 5：长期记忆与语义抽取（推迟）

- 只有在 Stage 4 证明 coding deterministic path 的瓶颈确是叙事/跨 run continuity 后，才设计 episode、topic、冷循环和 L3。
- 这些属于 ADR-007/010 的宿主/LTM 范围，不应先塞进核心 loop。
- 验收和回滚由宿主独立定义；核心 transcript/index 不依赖冷循环成功。

### 与 RFC 的关键差异

1. 不接受 D6“stub 死代码”和 D5“没有任何地址”的当前代码结论；改为“模型-facing 接线不统一”。
2. 不把 replayability、重复执行拦截和 final correctness 全部下沉为无条件 engine guarantee；采用 host authoritative + engine conservative unknown。
3. 不立即把保护判据从 role 全改成“可恢复性”；先引入分层 priority 和 budget-unrepresentable fail-closed。
4. 不在 P1 自动抽取决策/约束原话，不把 Tier 1 当作事实来源。
5. 不改变 4.0.0 的 guard、recall 暴露和 profile 默认；先 additive、双读双写、可回滚。
6. 把 Tier 3 的“有界”从工具输出层推进到 store 读取源头，避免先全量读再截断。

## 结论摘要

- **不成立/夸大**：D1/D5/D6 的绝对表述；D3 把 CLI heuristic 归因于 engine；D7 把自动 capture 与模型 notes 混为一谈；D8 把相关性证据写成主因因果；附录中 pilot、nonce e2e、成本 2.5× 缺少可追溯记录。
- **关键反驳**：索引不是事实；pointer 需要 retention/digest/权限/失效协议；A/B 不能覆盖时机、代价、多 consumer、并发和跨 run；Memento 可以非承重但仍需效率验收；提示词/工具并不能保证模型调用工具。
- **先做**：P0 确定性真相/replayability/归档/round range/stub/resume 契约与测试；窄 P1 做 bounded navigation 和源头限流 retrieval。
- **推迟**：自动语义抽取、profile 默认切换、LLM 叙事摘要、notes 删除、跨 run LTM/episode。
- **调用声明**：本评审只读取本地代码/文档并执行静态仓库/Git 操作，确认未发起任何模型调用、relay 调用或实验脚本。
