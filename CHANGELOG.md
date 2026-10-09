# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。

## [Unreleased]

### Documentation

- `docs/harness-comparison/` 的 pi 对比基线 **0.84.2 → 1.1.0**（issue #190，纯文档：零代码、零版本号变化、正文一字未改）：按 `docs/maintenance-policy.md`「快照类文档不重写、只追加修订注」的惯例，在 `README.md`、`01-pi-agent.md`（新增 §7）、`06-cross-comparison.md`（新增 §7）、`07-takeaways-and-open-questions.md`（新增 §6）的**文末追加有边界的修订小节**，正文保留 0.84.2 快照与全部 `dist/...:行号` 引用作为「我们曾经这么认为」的留痕，新基线只在修订小节声明。只更正两条已证实过期的事实（MCP 已内置、`tool_search` 已内置且**默认关闭**；证据一律取 `earendil-works/pi` tag `v1.1.0` 源码仓的 `packages/...`，与正文的 npm 产物路径分开标注）；会话中途 system message 写成 1.1.0 的**新增能力**而非「我们错了」，`before_agent_start` 返回 `systemPrompt` 即整体替换本轮 prompt 的窄表述按上游 `docs/extensions.md:103` 原文保留；`pi-agent-core` 拆分标为**范围外信息**（§0 已声明不在分析范围）；观察者隔离的本仓原结论仍成立（上游 `packages/agent/src/agent.ts` 的 listener 循环无 try/catch，抛错以 `stopReason:"error"` 终止 run），但补上两侧限定——pi 侧只能停在「原语层」（harness `src/core/extensions/runner.ts` 是逐 handler 包 catch 的），本仓侧经 `onObserverError` 的记账是**内存记账、非持久账本**且仅被 `await` 的 `onRound`/`onToolResult` 承诺隔离异步 rejection。**不新建英文版**：本目录历史上就无中英对，`scripts/docs-sync-check.mjs` 只校验 `host-consumer-contract` 那一对，新造即无人校验的孤儿。`02`/`03`/`04`/`05`/`08` 与其余四家（touwaka / codex / hermes / erix）的数字一个没动。
## [0.18.0] - 2026-10-09
### Added

- 仓库新增 **pi extension 示例 `examples/pi-extension/`（issue #193，仓库层产物，不进 npm tarball）**：`erix_run` 工具把「自包含修代码任务」委托给 erix 库内嵌 run——进度走事件流、取消走 `signal.abort()`、终局结构化（含 #180 载荷与 #176 `errorCode`）；含装载自证测试与真机冒烟。安装：拷目录到 `~/.pi/agent/extensions/erix-run`，未发版期用 `ERIX_AGENT_LIB` 指仓路径（本地可改用 `~/.pi/agent/node_modules/erix-agent` symlink）。
- `context.strategy` 接受内置策略名字符串，`fold-llm` 开箱自带 summarizer（issue #167，方案 C，additive / semver minor）：`context.strategy` 除策略对象外还可写 `"sliding-window" | "fold-statistical" | "fold-llm"`（**对象形式行为逐字不变**：同一引用透传，引擎不重写注入的对象，手工 `createFoldLlmStrategy` 缺 `summarizer` 仍按它自己的构造期 `TypeError` 失败；未知名字 / 空串 / 既非字符串也非对象的值在**首次 provider 调用前**抛 `TypeError` 并列出合法值）。名字在启动期一次性解析成实例（`src/compact/strategy-resolution.js`，接入点 `src/loop/orchestrator.js:988-1003`），下游 `configuredStrategy` 通道零改动；名字形态额外接上 context 级 `recoveryHint`/`stubFor`。名字解析出 `fold-llm` 且未注入 summarizer 时，引擎注入默认 summarizer = **本 run 的主力 provider**（`src/compact/provider-summarizer.js`：一次无工具补全，输入 = `SUMMARIZER_PROMPT_GUIDE` + 被折叠消息确定性序列化 + 被折叠轮次范围）。⚠ 成本：每次压缩多一次主力模型调用（体量约等于被折叠的老轮次），因此 `fold-llm` 只能显式选用。记账：该调用的 usage 走与 wrapup judge 同口径的 `addUsage(…, {trackLatest:false})`（`src/loop/orchestrator.js:979`）并入 `result.usage`/`error.usage`，并转发宿主 `onUsage`，但**不推 `rounds`**、不参与 stall、不更新压缩判断用的 `latestApiInputTokens`；reject/throw/空文本一律降级到既有统计摘要（下一轮上下文带 `[fold-llm 摘要失败…]` 标记），run 不因此中途死亡。手动注入对象仍为覆盖通道（可接便宜模型；该形态引擎不记账）。CLI 同步补 `--compaction <name>`（chat/repl）与 `slots.default.compaction` 字段（旗标优先），**默认 `fold-statistical` 不变**；非法名字直接报 usage 错误而不是默默回落。根导出新增 `BUILTIN_COMPACTION_STRATEGIES`/`BUILTIN_COMPACTION_STRATEGY_NAMES`/`isBuiltinCompactionStrategyName`/`resolveCompactionStrategy`/`createProviderSummarizer`/`serializeFoldedMessages`。
- `termination.errorCode`（issue #176，additive / semver minor）：`reason === "failed"` 的终局（`result.termination` 与抛出的 `error.termination`）现在携带根因分类——引擎只透传错误已有的分类字段（`KitError.code`，如 `timeout`/`rate_limited`/`auth`/`server`/`checkpoint_failed`），未携带时回落 `"unknown"`，绝不自己归因；其他 reason 不带该字段。宿主终止裁决表（#170）可从此按 `errorCode` 分流，不再解析 `termination.detail` 字符串。
- abort/failed 抛错携带终局载荷（issue #180，方案 A，additive / semver minor）：`runToolLoop` 抛出的错误现在挂 `error.usage`（与 `result.usage` 同一个对象，含 `cacheRead`/`cacheWrite`）、`error.rounds`、`error.finalText`（无产出时为 `""`）；`reason === "aborted"` 时 `termination` 同步 `{usage, rounds, partial:true}`。无累计量时为零值而非缺字段。「abort = 抛错」语义不变，宿主不再需要为用户点「停止」的 run 写死 `usage: 0`。新增 `terminationPayloadContract` 契约套件（`erix-agent/contract-tests`）。
- `runToolLoop` 新增一次性诊断事件 `model_metadata_missing`（issue #182，additive 事件类型 = semver minor）：当 `modelConfig`/`modelMetadata`/`model`/`provider`/`context` 里探不到 `contextWindowTokens` + `maxOutputTokens` 完整组合、且宿主也没直接给 `context.budgetTokens` 时（即 `budgetTokens` 推不出来），每个 run 恰好发一条 `{type, runId, detail}`：上下文压缩完全不跑、单轮聚合输出预算（#120）保持关闭、输出截断上限退回 4096（已知窗口或显式 `outputHygiene.limit` 已定值时 `detail` 改报实际解析值）。形状与一次性去重风格照抄 `persistence_capability_degraded`（同样绕开 `emitEvent` 直调 `onEvent?.()`，因为事件在启动期触发）。宿主自此可在验收/CI 里直接断言「我的装配是否把压缩关掉了」（真机 92 轮 run compaction=0 的根因）。零配置宿主行为不变（只是多一条事件）；`docs/host-consumer-contract.md` 与中文版同步。
- provider 新增 `defaultHeaders` 与 `extraBody` 注入口（issue #181，additive / semver minor）：宿主无需包装 `fetchImpl` 即可给请求打 per-run/per-session 归因标识（LiteLLM spend log 可直接对 `run_id`）。红线：引擎自有 header（openai 侧 `Authorization`/`Content-Type`，anthropic 侧 `x-api-key`/`anthropic-version`）不可覆盖，宿主同名（大小写不敏感）构造期抛 `TypeError`；告警与错误文案只带字段名不带值；`extraBody` 与引擎字段冲突时引擎优先 + `console.warn`。两参数都不传时请求头/体与旧版逐字节一致。`__proto__` 作为 header 名同样生效（自有属性赋值，不被原型 setter 静默丢）。
- judge 记录增补模型标识与 run 级 outcome 关联（issue #165，additive 字段 + additive 事件类型 = semver minor）：`onJudge` 每条决策记录（`round` / `intercept` / `degraded`，含 `run-snapshot-executor` 的拦截决策——字段统一在 `emitJudge` 这一个收口落，四条产生路径不会分叉）新增 `runId`（宿主传入的 run 标识，即与终局汇总的 join 键）、`model`（被评决策发生时 run **实际使用**的模型标识：按与 `modelMetadataFor()` 同一候选顺序 `modelConfig`→`modelMetadata`→`model`→`provider`→`context`、键顺序 `model`→`model_name` 解析，首个命中且**不合并**；**探不到就缺省字段**而不是写 `"unknown"`——写占位值会让「没配模型」与「模型真叫 unknown」在账面上无法区分）、`judgeModel`（仅当 judge 走了与 run 不同的 evaluator 模型时出现，让校准指标能区分被评模型与评它的模型）。`onEvent` 同时新增一次性终局事件 `run_outcome`：`{type, runId, model, judgeModel?, rounds, judgeRecordCount, termination, verification}`，成功路径在 `finish()` 持久化落地之后发、抛错路径在 `fail()` 里发，去重门保证一次 run 恰好一条（`judgeRecordCount` 让宿主能发现掉行）。outcome 采 **append-only 汇总**（方案 ①）而非结束时回写该 run 的全部决策记录（方案 ② 会破 JSONL 的 append-only 语义，宿主可能已在消费），宿主按 `runId` join 即得「这批决策 ↔ 这个终局」。发射口刻意吞掉宿主 `onEvent` 的抛错（与其他事件「#173 现状：onEvent 抛错 fatal」不同）：一条审计记录不得把已跑完的 run 变成 `failed`。`chat` 的 `judge.log`（`--judge-log` / `ERIX_JUDGE_LOG` / 默认 `outputs/<runId>/judge.log`）把该汇总也落同一文件，注入路径与默认路径共用同一写入器 → 两处记录形状逐字段一致。per-model judge 校准（blocked 率 / 误拦率 / extend ROI）自此可分组归因，不再需要人工考古。判别键：决策记录带 `kind`，汇总记录带 `type: "run_outcome"` 且不带 `kind`/`action`，故按决策计数/过滤的宿主代码不受影响。

- 文件工具纳入公开 exports（issue #184，ADR-005 第二层补账，零 npm 依赖）：新增 `src/tools/file-tools.js` 规范实现，`createFileTools({ cwd, allowRead, allowWrite })` **只从 `erix-agent/tools` 子路径导出**，**不属于包根主导出**（实测：`src/index.js` 里 `createFileTools` 出现 0 次；`package.json` 的 `exports` 只有 `.` / `./tools` / `./contract-tests`，无深路径；已发布包从包根拿不到该符号）——与 `docs/decisions/005-tool-system.md` Layer Two「It is not part of the main export; it is available only through an explicit `import … from "erix-agent/tools"`」一致。原「包根与 tools 双导出（先例 `src/tools/notes.js`）」是误记：notes 那组符号（`src/index.js` re-export `./tools/notes.js`）确实是包根 + `./tools` 双导出，但它不是文件工具的导出先例，文件工具只走子路径。返回 `{ definitions, executeTool, executors }`。`bin/tools.js` 反过来 import 它，自己只留 `exec`（ADR-005 红线：库不自带会执行的工具）、`todo_*`（CLI 会话状态 `~/.erix/todos/`）、终端回显 `wrapExecuteTool`、`--tools` 过滤与提示词装配，`createCliTools` 返回值形状逐字不变（`bin/cli.js` / `bin/repl.js` 两个调用点零改动）。**边界只有两个布尔谓词**，默认 `() => true`（库里不放任何 jail 默认、不引入错误类型、不做 containment、零安全承诺，ADR-009 牢笼归宿主）：库负责 `path.resolve` 归一后把**绝对路径**喂给谓词，并在遍历中**逐条**判定（宿主在外面包一层 `executeTool` 拿不到这个挂钩）。`executeTool` 同时接受位置形态 `(name, input, context)` 与结构化 `({id, name, input, context, signal})`（顶层 `signal` 并入 `context.signal`）。**可中止**：遍历每 32 个条目 `setImmediate` 让出一次并查中止（中止抛 AbortError 交给引擎），**无 signal 时完全不插入让出**，非中止路径行为与开销零变化。工具名与既有 schema 字段（`offset`/`limit`/`path`/`pattern`/`glob`/`is_regex`/`max_results`/`maxResults`/`depth`）逐字保持，新参数一律 snake_case：`include_vendor` / `include_hidden`（`rg`/`grep`/`tree`）、`max_bytes`（`readFile`）、`rg` 的 `is_regex`（默认 `true`，与真实 `rg` 与本库 `grep` 同口径）；两个搜索工具都同时接受 `max_results` 与 `maxResults`。新增契约套件 `fileToolsContract`（`test/contract/file-tools.js`，工厂注入风格，已进 `test/contract/index.js` 与 npm `files` 白名单；vendor 用例自建临时 `node_modules` fixture，一律注入临时 cwd，不碰真实 `~/.erix`）。契约文档新增「File tool registration」中英两节（含 Tier 2 host integration 口径）。
- 技能包 loader 纳入公开 exports（issue #197，ADR-005 第二层补账，接 #184 的同一条线，零 npm 依赖）：新增 `src/skills/loader.js` 规范实现，`skillDirectories` / `discoverSkills` / `loadSkill` / `loadAllSkills` / `buildSkillTools` / `warnBuiltinToolConflicts` 六个符号从 `erix-agent/tools` 子路径导出，**不新增 `./skills` 子路径**（打包面不扩、`files` 只多一个契约套件文件，本来就读 `./tools` 的宿主不需要多一条 import 映射）。`bin/skills.js` 改成**薄装配 + re-export**：只注入 CLI 自己那份内置技能目录并把库符号原样转出，`bin/cli.js` / `bin/repl.js` / `scripts/notes-why-experiment.mjs` 三个调用点零改动，`erix skills` 与 repl `/skills` 行为逐字不变（发现顺序、校验失败形状、`buildSkillTools` 产出的 schema 形态三件事实另有断言铉住：契约套件跑库实现，CLI 层另设对照段，含「`bin/skills.js` 的 `loadSkill`/`warnBuiltinToolConflicts` 必须是库的**同一函数引用**」防有人复刻第二份）。**`bundledDir` 参数化是必须的坑而不是风格选择**：原先的 `path.resolve(new URL("../skills/", import.meta.url))` 在 `bin/` 里恰好命中 `<pkg>/skills`，搬进 `src/skills/` 就差一层，宿主从 npm 包解析时又是另一套，且猜错的症状是「内置技能静默发现不到」而不是报错；库内不留任何 `import.meta.url` 派生默认值，**不传（`undefined`/`null`/空串）= 内置根完全不参与发现**，CLI 显式传 `bin/` 的上一级 `skills/`，宿主传自己那一份。优先级不变：内置 < 用户全局 < 项目本地（同名后者整体替换），`skillsDir` 仍是单目录覆盖（相对路径按 `cwd` 解析）。新增契约套件 `skillsLoaderContract(label, { discoverSkills, loadSkill, buildSkillTools })`（`test/contract/skills-loader.js`，工厂注入风格照 `test/contract/file-tools.js`，已进 `test/contract/index.js` 与 npm `files` 白名单；九组断言：两个不同 `bundledDir` → 发现结果跟着换（含一个不在自身父级链上的深层路径）、不传时内置根缺席、优先级、`skillsDir` 覆盖、校验失败不阻塞且 `errors[]` 形状是 `{skillId, dir, error}` 且整技能跳过、`loadSkill` 四种坏形状各自拒（含 legacy `getTools()` 回落目录名）、产出即库 `ToolSchema`（缺 `required` / 字段类型不符 / `Unknown tool: …` 均由 `createToolRegistry` 真实执行）、同名冲突整体跳过）。技能测试一律注入 `home`/`cwd`/`bundledDir`，不碰真实 `~/.erix`。反向实测（临时改 loader 后还原）：原样把 `new URL("../skills/", import.meta.url)` 当默认值搬进库 → 2 红；层级改成仓内恰好命中的 `../../skills` → 2 红；直接忽略 `bundledDir` 写死自身层级 → 4 红（含契约两组）。契约文档新增「Skills loader registration」/「技能加载器注册（issue #197）」中英两节（Tier 2 写法照「File tool registration」，中英标题数 54 → 55，契约套件计数句与「标准用法」表同步为九文件/十一函数），README 中英模块地图补 `src/skills/loader.js`、`erix-agent/tools` 的导出描述与所引 `files` 清单一并同步。

- 新增单一搜索入口 **`searchText`**（issue #195，additive / semver minor，零 npm 依赖）：`rg` 与 `grep` 是我们自己写的纯 Node 实现（`src/tools/file-tools.js` 里没有任何 `execFile`/`spawn`），却借了两个 CLI 命令的名字——**借来的名字带来借来的先验**（模型按先验写 `glob: "**/*.test.ts"`，而本实现的名称过滤从不跨 `/`；按先验以为 `.gitignore` 生效，其实完全不读；把「没命中」读成「仓库里真没有」，其实可能整棵 `vendor` 被跳过——最后这类正是 #184 修的「静默撒谎」，只是撒谎主体从输出换成了名字）。`searchText({ pattern, mode, path?, name_pattern?, max_results?/maxResults?, offset?, include_vendor?, include_hidden? })`：**`mode` 必填且无默认值**（`"literal"` 字面量 / `"regex"` JavaScript 正则；没传或非法一律返回 `错误：searchText 必须显式给出 mode …（无默认值）`，**不回落默认**——#184 被迫翻转「`rg` 字面量 / `grep` 正则」这对相反默认就是同一族缺陷，「默认 literal」只是把歧义留给调用方）；**R2 改名**：只匹配文件名的过滤参数叫 `name_pattern`（描述里写死「只匹配文件名、不跨 `/`」，`**/*.ts` 一律不命中），`searchText` **不接受 `glob`**——收到就返回指向 `name_pattern` 的错误结果，而不是静默忽略一个「看着能用」的键（静默忽略是同一个谎的另一面）。返回 `{ content, metadata }`：跳过账/截断/续读偏移同时有结构化字段（`searchHits`/`searchMatchedLines`/`searchFiles`/`searchLimit`/`searchOffset`/`searchTruncated`/`searchNextOffset`/`searchSkipped{vendorDirectories,hiddenDirectories,largeFiles,binaryFiles,deniedPaths}`），**进 transcript、不上 wire**——模型侧唯一的通道仍是 `toolMarker()` 产出的 marker 文本，文档与描述都不写「模型能读字段」。`offset` 续读被截断的结果（把 `searchNextOffset` 原样传回）。**R4 一条没做**：`-i`、`-A/-B/-C`、`--type`、`.gitignore` 感知全部没顺手加（它们与边界注入/输出预算/中止交叉：`-A/-B` 顶破字节上限、读 `.gitignore` 自己要过 `allowRead`），要先有 transcript 证据。契约文档新增「Search tool (issue #195)」/「搜索工具（issue #195）」中英两节。
- 新增第二个写工具 **`edit`**（issue #191，additive / semver minor，零 npm 依赖）：`createFileTools`（`erix-agent/tools`）的定义 / 入参校验 / 执行里加入精确多点编辑 `{ path, edits }`。`edits` 只接受三种形状（`[{oldText,newText}]` / 单对象 / 两者的 JSON 字符串）且**只归一形状不猜意图**；匹配为**字节级精确**（无 NFKC / 引号折叠 / 空白容忍），每条 `oldText` 必须**恰好命中一次**，各条均对着**原始内容**匹配（不叠加前序编辑后的状态）、已匹配区间不得重叠。0 命中、多次命中、越界写、内容无变化**都是错误结果而非抛错**，不产生部分写。成功结果首行为「已编辑 <显示路径>」并自带 unified 风格短 diff。存此工具的理由：写面此前只有 `writeFile{path, content}`，改 3 行要重吐整个文件（`src/loop/orchestrator.js` 3277 行 ≈ 33k 输出 token），而那次重吐本身可能被输出预算截断（`continuation_exhausted` 是本库一等终止原因）——`edit` 把「改一小段」的代价从文件大小变成 diff 大小。
### Changed

- 宿主观察者回调抛错后果统一为「记一笔错、继续跑」（issue #173 PR-B，行为放宽 = semver minor）：九个观察者通道的宿主回调抛错，原先三档后果（onEvent/onRound/onToolResult **杀 run**、onDelta 等流式通道隔离、onJudge 静默吞）现统一为：经 `onObserverError`（现携带 `{channel, ...}` 上下文）报告后 **run 照常继续**。三条边界：① 旧「throw 拒绝 run」契约示例（#182 装配自检）改为预检查/`signal.abort` 姿势，要终止 run 用 abort（抛错带 #180 全载荷）；② `onToolResult` 是改写钩子非纯观察者，异常 fallback = **保留原始结果** + 上报，改写/脱敏逻辑须在 hook 内自防；③ 启动期直调路径（`persistence_capability_degraded`/`model_metadata_missing`）纳入同一隔离通道，其旧「startup throw fatal」注解逻辑删除。回调须同步返回（仅被 await 的 onRound/onToolResult 承诺隔离 rejected Promise）；观察者错误 best-effort 无持久化账本，宿主应计数 onObserverError。双宿主（touwaka/erix-station）消费者审计：零迁移成本，无一家用回调抛错做控制流。
- token 估算热路径优化（issue #172，零行为变化）：`estimateTokens` 加 ASCII 快路径（实测 5.3×，结果**逐字节同值**，仓库内复刻旧实现 80k+ 码点/fuzz 比对）；`compactBeforeRound` 删 3 对纯重复全量估算（每轮 8→5 次）；`trimGovernorHistory` O(n²) 线性化（resume 灌历史场景实测 391×）。每轮估算 CPU 实测 302ms → 37ms（−87.8%）。

- `writeToolNames` 默认值从 `["writeFile"]` 变为 `["writeFile", "edit"]`（issue #191）：judge 的「自上次评估以来是否发生过写」此前看不见 `edit`，会漏看一批实质改动。默认集归一为 `src/reflection/judge.js` 的 `DEFAULT_WRITE_TOOL_NAMES` 单一真值（orchestrator 参数默认值与 judge timeline 回退共用，已有 drift 锚点看住）；**显式传 `writeToolNames` 的宿主不受影响**。
- **中间夹超宽行时的出口兑现**（issue #196 追加轮 R4，真缺陷）：`readFile` 遇到「第 3 行是 20 万字符、其余是短行」这类文件时，只发 `[本次返回已达 max_bytes=…；下一步：readFile 传 offset=N 继续]`，而那条超宽行可能**一个字节都没回来**（整行落在单个 64 KiB 读块内时走的是「整行装不进剩余额度」分支，跨块才走截断分支）——`readBytesCap` 的 `offset` 语义钉死是「下一个未读整行」，照做正好跳过它，模型再怎么续读也取不到那条行，marker 更没说要提高 `max_bytes`。修法只补采集与第二条 marker：**续读 `offset` 语义不变**，`readLineWindow()` 在额度触顶分支里额外采下「单行本身超内容预算」那条的行号（普通短行被额度截住**不采**——它靠续读就能拿回，报成超宽行是另一条谎），`fileReadMarkers()` 于是按原有顺序追加 `[单行超过 max_bytes=…，已截断 N 行：首条第 L 行（文件 P，SIZE）；下一步：readFile 传 offset=<该行 offset>, limit=1 并提高 max_bytes]`（触顶在前、被裁行在后；触顶措辞不声称内容完整）。新增契约用例钉「**照做能拿回**」：从 marker 文本正则抽出 `offset=` 后的数字，原样传回 `readFile({offset, limit:1, max_bytes:400000})` 必须拿到整条超宽行，两种形态（跨块半行 / 块内整行未回）各钉一次；同额度再读一次的对照断言说明出口为什么必须写「并提高 `max_bytes`」。
- **别名截断 marker 给出真值**（issue #196 追加轮 R5，主 agent 裁决）：`rg` / `grep` 的截断 marker 里那个「不给数的 offset」换成**本次实际返回的命中条数**（与 `metadata.searchNextOffset` 同一个表达式，不各算一套），即 `[命中过多，已按 max_results=N 截断；下一步：改用 searchText 传 offset=<真值> 继续（本别名不接受 offset）]`。上一轮藏数的理由是「别名不吃 offset」——复核成立的是「#188 只约束命中行/分组形状/`max_results` 数字」，但「不吃入参」不等于「不给数」：模型照抄这个数到 `searchText` 就能续读，不给就只能自己数命中行。契约断言随之换语义：原 `doesNotMatch(/offset=\d+ 继续/)`（守「别名不给数」）改成钉「别名 marker 的数字 == 本次命中条数 == `searchNextOffset`」，并保留行为断言「别名传 `offset` 参数输出逐字不变（它给数但不吃数）」。
- **`formatSize` 补 GB / TB 两档**（issue #196 追加轮 R6）：原先最大只到 MB，`formatSize(1e12)` 吐 `953674.3MB`——六位数带单位等于没单位。新档与 MB 同规则（一位小数、1024 基数），进位判据统一为「**渲染后的值**到 1024 就晋级」，所以 `1073741823` → `1.0GB` 而不是 `1024.0MB`、`1024GB` → `1.0TB`、`1e12` → `931.3GB`。连带同步三处检查面：`scripts/docs-drift-check.mjs` 的可读单位锚点原先**写死 `KB`/`MB` 两个字面**（加档会静默失效），现逐档抽取；契约文档中英两处单位清单与实现侧边界表（含 `1023MB`/`1GB`/`1024GB`/`1.5TB` 与「五档都有样本」的档位齐全断言）同步；反向实测过：把源码里的 `GB` 字面改掉 → `check:docs` 立即变红。

- `rg`/`grep` 与 `searchText` 的**命中正文由同一段代码产生**（issue #195 硬判据）：三个入口共用一个实现体，命中行的取值、500 字符行宽截断、`（无命中）` 口径、排除账、截断 marker 全部只产出一次，两种 `format`（`rg` 扁平 `文件:行号:正文` / `grep` 按文件分组）只是同一个 hits 数组的两种排版。契约新增逐字等式用例：同一份 fixture 上 `searchText(mode:"regex")` / `rg` / `grep` 的命中正文（剥掉各自前缀、剥掉弃用行）**逐字相等**，且长行仍是 500 + 一个 `…`。这不等价于「三个工具输出相同」——别名各自的渲染形状属 Stable，宿主要依赖的不变式是命中正文。`grep` 的 `glob` 参数补上描述（只匹配文件名、不跨 `/`），语义未动。
- **模型可见文本变更（宿主按 marker/输出逐字匹配的代码会受影响）**：① CLI 系统提示的工具清单行新增 `searchText` 一句（含「mode 必填、无默认值」「name_pattern 只匹配文件名、不跨 `/`」）并把 `rg`/`grep` 各标为「已弃用，请改用 searchText 并显式传 mode」，vendor 跳过段的工具名单同步成 `searchText/rg/grep/tree`；② `test/fixtures/cli-golden.json` 内嵌的整段提示词随之变更——**golden 变了 = 模型可见面变了**，这是刻意的，没有为了 golden 不变而把新工具藏进描述文字；③ `rg`/`grep` 结果尾部新增一行弃用提示（拿工具输出做逐字相等比较的宿主会看到它）。

- 三处**模型可见文本**变更（issue #184，不是纯 additive，宿主按 marker 子串匹配的代码会受影响）：① `rg` 空命中从**空字符串**改成 `（无命中）`（空串让模型分不清「没搜到」与「搜了但被静音」，`grep` 早就是这个口径）；② `tree` 撞上限从静默 `return` 改成带 marker + 剩余计数：条目上限触发 `[另有 N 条未列出，条目上限 500 已达；…]`、depth 到顶触发 `[另有 N 个目录未展开，depth=D 已到上限；传 depth=D+2 或 include_vendor=true 查看更多]`；③ `rg`/`grep`/`tree` 结果尾部新增排除账 `[已跳过 node_modules/.git 等 N 个目录、M 个 >1MiB 文件、…；要一起搜传 include_vendor=true, include_hidden=true]`（`grep` 此前跳 vendor/隐藏目录却**一字不提**，`rg` 压根不跳）。三者都是「默认去噪 + 显式回报 + 可撤销开关 + 写进工具描述」而非显示全部（ADR-010）；`node_modules` 与 `.git` 在任何默认参数组合下都进跳过账。连带：`tree` 现在与 `grep` 共用同一套跳过逻辑（此前只有 `grep` 跳），CLI 系统提示的工具清单段新增一句「默认跳过 node_modules、dist、build、target、vendor 与 `.` 开头的目录（结果尾部会回报跳过数量）；要一起搜传 `include_vendor=true`、`include_hidden=true`」，`test/fixtures/cli-golden.json` 内嵌整段提示词同步。
- `readFile` 改为有界读（issue #184）：单次返回不超过 `max_bytes`（默认 `262144`，`ERIX_FILE_READ_MAX_BYTES` 可覆盖，三件套钳到 1024–4194304，非法值回退默认）。实现是定位读（`openSync` + `readSync(fd, …, position)`）+ 行窗口**按块扫行 + 早停**，内存上限 = 一个块 + 一个残段；此前 `readFileSync` 整文件读，几百 MB 直接 `RangeError: Invalid string length` 或 OOM-kill，run 以 transport 错误终态。文件 ≤ `max_bytes` 时输出与历史**逐字节一致**（行号格式与 `[共 N 行，offset=… 继续]` marker 原样保留，这是模型侧唯一通道）；超限时的新 marker 为 `[本次返回已达 max_bytes=…，共 N 行；offset=… 继续]` / `[文件 N 字节 > max_bytes=…，行窗口之后的内容未读取；offset=… 继续]` / `[单行超过 max_bytes=…，超长部分已截断]`。
- `rg` 搜索模式默认值与真实命令对齐（issue #184 追加轮 A，**翻转本轮早些时候的口径**）：不传 `is_regex` 时 `rg` 按**正则**匹配。为什么翻：真实 `rg` 的默认就是正则，字面量在真实命令里是旗标（`rg --fixed-strings` / `grep -F`），而模型对 `rg` 的先验也是正则；且上一轮把 `rg` 默认改成字面量后，**同一个库里两个搜索工具（`rg` 字面量 / `grep` 正则）默认相反**，这是本轮引入的新反常。`grep` 的默认（正则）本轮**未动**。逃生口命名跟着真实旗标走：`rg` 与 `grep` 的 `is_regex=false` 在描述里直接写明等价 `rg --fixed-strings` / `grep -F`，让模型先验直接映射。连带 CLI 系统提示工具清单行与 `test/fixtures/cli-golden.json` 内嵌提示词、两个工具的 schema 描述、契约文档中英两节一同改口径；断言不是只改文案：`test/contract/file-tools.js` 与 `test/tools/file-tools.test.js` 在同一份 fixture 上并排钉住「默认命中 `a.b` **与** `axb`」与「`is_regex=false` 只命中 `a.b`」（`foo|bar` 同理：正则 3 行 / 字面量 1 行）。能力面未动（无 `-i`/`-A`/`-B`/`--type`、**不读 `.gitignore`**，vendor 是自己硬编码的跳过清单 + 结果尾部排除账），该偏离已写进契约的宿主可见声明与工具描述。
- `rg` 无效正则硬化 + 上限收口（issue #184）：无效正则返回 `错误：无效正则：…` 工具错误结果而非抛异常（此前 `new RegExp(pattern)` 直接抛）。`rg` 的 `maxResults` 现与 `grep` 同样钳到硬上限 200 并在触顶时带 `[命中过多，已按 max_results=N 截断]` marker（此前既无上限也无 marker）。
- `grep` 命中行截断上限 **200 → 500** 字符（`GREP_LINE_LIMIT`，issue #184 追加轮 A，用户批准）：200 会把正常代码行截成半行，模型看到半行容易误判（同一口径参照：pi 1.1.0 的行截断用的也是 500）。行为变化面只有一个：`grep` 命中的行长在 (200, 500] 区间时以前带 `…` 现在整行返回；>500 仍截到 500 + `…`；`rg` 当时压根不做行截断（两工具口径不一致，已写进契约与交付报告的残留点——**已由下一条抹平**，两条同属未发布区间，这里的「不一致」只是本轮的中间态）。断言两边同时钉住：`test/tools/file-tools.test.js` 钉「恰好 500 + 前缀 + 省略号」与「407 字符的行整行返回」，`test/tools.test.js` 在 CLI 层同样翻转。**不动**的两个数：`FILE_READ_MAX_BYTES_DEFAULT`（256 KiB vs pi 50KB 的取舍另议，#195）与 `GREP_MAX_RESULTS_HARD_CAP`（200，防爆输出的基准还在）；marker「给下一步具体动作 + `formatSize()`」已另开 **#196**，不在本轮。
- 两个搜索工具的**命中行宽上限收口成同一个数**（`GREP_LINE_LIMIT`，issue #184 追加轮 A 收口第三条）：`rg` 的命中行现在与 `grep` 走**同一个** `truncateDisplayText(line, GREP_LINE_LIMIT)`，**未新增第二个常量**（口径唯一）。修的是上一条自己留下的反常：同一个 807 字符的命中行，`grep` 截到 500 + `…`（正文 501 字符）、`rg` 却原样返回 807 字符正文（直测复现，不是推测），同一个库里两个搜索工具口径相反，与本轮刚修掉的「两个工具默认值相反」同形状。上限语义与 `grep` 逐字一致：整行 ≤500 原样返回，>500 截到 500 + 尾部一个 `…`。**为什么保留截断而不是照真实命令一律不截**：真实 `rg`/`grep` 都**不截行**（已实测 807 字符逐字节原样输出），所以这条截断是**本实现自己的输出预算**——一个超长行（minified 文件常见：一行几百 KB）能独自把一次工具调用撑爆；该偏离此前只写在契约里，本轮同时补进**两个工具的描述**（两边同口径：`whole up to 500 characters` / `this implementation's own output budget` / 真实命令 `never truncates lines`）。**`GREP_LINE_LIMIT` 的值未动（仍是 500）**，`FILE_READ_MAX_RESULTS_HARD_CAP`（200）与 `FILE_READ_MAX_BYTES_DEFAULT`（#195）也未动。测试：`test/contract/file-tools.js` 新增契约不变式——同一份 807/297 字符 fixture 上 `rg` 与 `grep` 的命中行正文**逐字相等**且都是 500 + `…`（297 字符的行两边都整行返回）；`test/tools/file-tools.test.js` 里「`rg` 压根不做行截断」那条断言翻成「`rg` 必须按同一个数截」，并补上两个工具描述的 schema 真值断言；既有的 500/297 两条断言保留。**负控制**：常量临时改回 200 → `node --test` 1205 / 1197 pass / **3 fail**（新不变式报 `rg 必须按 500 + 省略号截断，实得到 201`），已还原到 500。中英契约的默认值清单那条从「`grep` 截到 500、`rg` 不截」改成「**两个搜索工具**都截到 500，且这是本实现的默认值而非对宿主的要求」。
- 所有「跳过 / 截断 / 空命中」文案改由 `src/tools/file-tools.js` 内**单一** marker 生成函数 `toolMarker(kind, values)` 产出，五个 executor 只传语义值、不再各自拼带方括号的字符串（issue #188 三层分级的前置：marker 字面量 = Experimental，可在任意 minor 变，改文案只动一处；`allowRead`/`allowWrite` 谓词签名与「返回 `false` → 工具返回错误结果而不抛异常」= Stable）。
- **截断 marker 从「只报告状态」改成「给出可执行的下一步」，结果文本里的字节数改走人类可读单位**（issue #196 R1+R2，模型可见变更，仍属 marker 字面量 = Experimental 那一层；本轮不做 R3 的「截断判定抽独立模块」，**四个默认值一个都没动**：`FILE_READ_MAX_BYTES_DEFAULT=262144`、`GREP_LINE_LIMIT=500`、`GREP_MAX_RESULTS_HARD_CAP=200`、`MAX_TREE_ENTRIES=500`）。四类截断的 marker 尾部统一挂 `；下一步：<工具> 传 <参数>=<值>`（前缀收成模块内常量 `NEXT_STEP_CLAUSE`，措辞只此一处），带的全是**本次调用的真值**：`[共 12 行，offset=5 继续]` → `[共 12 行，剩余 7 行；下一步：readFile 传 offset=5 继续]`；`[本次返回已达 max_bytes=4096 字节上限；offset=34 继续]` → `[本次返回已达 max_bytes=4KB 上限；下一步：readFile 传 offset=34 继续]`；未扫到 EOF 那条同形状；`[单行超过 max_bytes=262144，超长部分已截断]` → `[单行超过 max_bytes=256KB，已截断 1 行：首条第 1 行（文件 one-line.txt，3.0MB）；下一步：readFile 传 offset=0, limit=1 并提高 max_bytes]`（新增：被截那行的**行号 + 文件路径 + 该行 0-based offset + 文件真实大小**，行号由 `readLineWindow` 逐条采集，不再是只有一个布尔）；搜索侧 `[命中过多，已按 max_results=3 截断；offset=3 继续]` → `…；下一步：searchText 传 offset=3 继续]`，别名（不吃 `offset`）的出口指向规范入口 `[…；下一步：改用 searchText 传 offset 续读（本别名不接受 offset）]`。**相对 issue 原文的一处收紧**：marker 里只允许出现本模块自己的 `readFile` / `searchText`，**不得**写 `exec`/`sed`——`exec` 属 CLI 装配层（`bin/tools.js`，ADR-005 把「会执行的工具」挡在库外），库不能假设宿主装了它，而 `metadata` 不上 wire、marker 是模型唯一通道，写进去就是兑不了现的支票（理由写进 `toolMarker` 的文档注释，并由契约用例逐条断言）。新增导出 `formatSize(bytes)`（与 `toolMarker` 同文件）：`B`/`KB`/`MB`，1024 基数，`<1024` → `NNNB`、整 KB → `NNNKB`、非整除按 KB 四舍五入（`1536` → `2KB`）、跨 MB 一位小数（`1572864` → `1.5MB`）、进位到 1024KB 晋级 MB（`1048575` → `1.0MB`）；**同一段结果文本里可读值与裸字节数不再并存**（模型对不上账），阈值本身继续以裸数字住在文档与 `metadata` 里。同步面：`docs/host-consumer-contract*.md` 中英成对（含旧 marker 字面量与搜索节引用）、`scripts/docs-drift-check.mjs` 新增两条真值锚点（`NEXT_STEP_CLAUSE` 与 `formatSize` 的 `FILE_READ_MAX_BYTES_DEFAULT/1024` + `KB`/`MB` 单位，各反向实测过一次：改源码必红）、契约套件 `fileToolsContract` 新增两组断言（用**两份不同 path/limit/max_bytes/max_results 的 fixture** 钉「真值随调用变化」而不是模板，并钉住 marker 里不得出现 `exec`/`sed`/`awk`/`cat`）、实现侧补 `formatSize` 边界表。`test/fixtures/cli-golden.json` 实测**无需改动**（golden 内嵌的是系统提示与 run state，marker 文本不进 system prompt，`node --test test/cli.test.js` 34/34 逐字仍对齐）。
### Deprecated

- `rg` 与 `grep` 降级为 `searchText` 的**薄别名**（issue #195，弃用节奏按 #188 三层分级：工具名与入参形状属 **Stable** → **本轮只加告警、不删**，移除要等一次 major + 升级指南）：两者内部共跑 `searchText` 的同一个实现体（`rg` → `mode="regex"`、`grep` → `mode="regex"` + `glob`，与 #184 追加轮 A 之后的行为等价），入参形状逐字不变（继续吃 `glob` / `is_regex`，`is_regex=false` 仍是 `rg --fixed-strings` / `grep -F`），结果尾部各挂一行 `[已弃用 rg：它是 searchText 的薄别名，请改用 …；rg 将在后续 major 版本移除]`（marker 文案属 Experimental，只走 `toolMarker()` 单一通道）。继任入口：`rg` → `searchText` + `mode="regex"`；`grep` → `searchText` + `mode="regex"` + `name_pattern`（原 `glob`）。
### Fixed

- 契约测试套件的 notes 断言按 issue #183 裁决做**放宽 + 补强**（裁决 3B / 2 / 5 的上游半边；**零运行时行为变化**——`src/` 一行未改，改动全部落在 `test/contract/` 与 `test/store/`）：① **tombstone 放宽（3B）**——`revoke` 成功后的断言从「必须是 `state:"revoked"` 墓碑」改为「记录**可观察地消失**」：`read()` 返回 `state:"revoked"` 墓碑**或** `undefined`（物理删除）都算兑现，重复 revoke 接受 `unchanged`（墓碑）或 `missing`（已物理删除）但不得再 `found`/`revoked:1`；`missing` 哨兵与 `expectedState`/`expectedUpdatedAt` 并发护栏断言原样保留。② **LWW 拆套件（裁决 2）**——「并发同键双写都必须成功」从通用 `notesStoreContract` 移入文件适配器自己的测试树（`test/store/notes.test.js`，连同文件适配器的墓碑形态断言一起），并新增**可选子套件** `notesStoreCasContract`（`erix-agent/contract-tests` 的第九个注册函数）：并发同键写至多一方失败、失败必须是抛错而不是静默丢弃、胜者必须是那条完整可读的记录。③ **limit 阈值用例（裁决 5 上游半边）**——通用套件原先只用单条记录证 `limit:5000`，根本证不了 200 上限；现在造 205 条钉住「给了 limit 就钳到恰好 200 / 不给 limit 全量返回」，并按 `src/store/notes.js:398-405` 的真实行为断言非法 limit（`0`、`-1`、`1.5`、`NaN`、`2**53`、字符串）抛 `TypeError`（**没有**新造上游不存在的语义）。**谁被解锁**：把 revoke 做成物理删除、或让并发写按比较-交换拒冲突方的宿主（touwaka 型 DB store）此前必然为红，现在能跑绿——`test/store/notes-store-forms.test.js` 用这两种形态跑完整通用套件与子套件，并保留两条负控制断言钉住「放宽前为什么会红」。**谁不受影响**：断言只放宽不收紧（唯一新增的 limit 阈值面只是把上游既有行为说出来），内置文件适配器全绿（`test/store/notes.test.js` + `test/store/notes-store-forms.test.js`），engine 与 notes 工具层零改动。
- 升级指南把「上游发了什么字段」当成「宿主表里已有该列」的事实口径修正（issue #183，宿主 touwaka 报告，零行为变化）：`duration_ms` 一类列**全是宿主自有**——引擎只把 `duration` 打进 `execution.metadata`（`src/loop/run-snapshot-executor.js:99,116`）并摊平到 `tool_result` 块（`:325-330`），`RoundRecord` 顶层没有 `duration`、展示投影的 `toolCalls[]` 也没有该字段，且这一行为早于 0.14 就已存在（`git log -S "metadata.duration" -- src/`），因此**没有任何一次引擎升级会创建/重命名/回填宿主的列**；touwaka 生产库当时根本没有该列，补齐花了 DDL / 写入侧（落了字面 `NULL`）/ 读取侧（控制器 `SELECT` 漏列）三个宿主侧修复，无一来自上游。同时新增两条全局规则：「引擎发出 X ≠ 你的表里有 X」（0.17.0 指南 §4）与**双侧同步义务**——宿主的空库基线与升级迁移两条路径互斥，只写进 upgrade 一侧的迁移新装库永远拿不到（§5，touwaka 的 `init-database.js` vs `upgrade-database.js` 踩过两次）。**诚实口径**：四份指南的旧正文从未提及 `duration_ms`，即旧文本里并不存在一句需要删除的错误断言，本轮只新增事实与自查口径。同时修新写正文里 5 处 坐标偏错（`errors.js:2`→`:1`、`classifyHttpError` 行区、`classifyFetchException` 误指到 `isRetryableNetworkException`、`wrapup.js:131-134`→`:132-135`、`callProvider` 行区）与「七个套件」计数（实为**七文件/八注册函数**，`execute-tool.js` 一个文件导出两个）。
- 启动期 `model_metadata_missing` 诊断事件的宿主回调抛错改走与 `fail()` 同口径的终局注解（#182/#180 合流处独立验收发现：原先会抛出不带 `termination`/载荷的裸错误；同时 abort 信号优先于 `failed` 判定，与 `fail()` 一致）。
- 契约文档措辞收窄两处（独立验收发现）：#180 载荷承诺限定「运行生命周期开始之后抛出的错误」（运行前选项校验/装配错误本就不携带）；#181 「构造时快照」明确为**顶层**快照（`extraBody` 嵌套对象按引用共享）。
- 文档事实漂移修正（issue #164，零行为变化，中英成对）：README 的「当前包版本 v0.9.0」改为与 `package.json` 联动口径（真值只写一处，由 `npm run check:docs` 校验）并补齐 0.9→0.17 里程碑条目；`stallDetection` 默认值由错误的 `{ window: 4 }` + 「默认模式 `appear`」改为代码真值 `{ window: 4, mode: "consecutive" }`（并写明 `ERIX_STALL_MODE` 覆盖与「显式传对象但未写 `mode` 仍回落 `appear`」这两个真实边界）；模块地图补齐 `src/display/projection.js`、`src/providers/http-shared.js`、`src/store/append-user-turn.js`；README 引用的 `files`/`exports` 清单与 `package.json` 对齐；`docs/requirements.md`（中英）的「当前版本」口径从 0.8.0 推至 0.17.0（新增 v0.9.0–v0.17.0 阶段行，v0.8.0 行降为已交付）并在 FR-2.3 钉上 stall 默认模式。

- CLI 侧两处 **signal 丢失**（issue #184，现成 bug，不依赖新 API）：`wrapExecuteTool` 只取 `firstArg.context` 与 `firstArg.id`，丢掉了引擎放在**顶层**的 `signal`（`src/loop/run-snapshot-executor.js:244`）；`createCliTools.executeTool` 调的是 `executor(normalizedInput)`，连 `context` 都不传。两处现在都把信号并/透传进 `context.signal`，否则库里的遍历与有界读永远看不到中止信号（无 signal 时不凭空造 `signal` 字段，形状与历史一致）。
- 越界读写不再抛异常：`allowRead` 返回 `false` 时 `readFile` 与被拒的遍历根路径返回 `错误：读取被宿主边界拒绝：…` 文本结果，遍历类工具跳过该条目并计入排除账；`allowWrite` 返回 `false` 时 `writeFile` 返回 `错误：写入被宿主边界拒绝：…` 且不落盘（沿用 `bin/tools.js` 既有的「错误结果而非异常」口径）。
### Documentation

- 契约（中英同步，`docs/host-consumer-contract*.md`）把 issue #183 的三条口径写成正文：**TTL**——上游不承诺记录级过期（`expires_at` 是历史遗留字段、`purge` 从不读它），宿主保留/过期策略自定，而 `toolResultTtl` 是另一物（provider request-view 里折叠工具结果的轮数）；**scope**——接口级多 scope 是硬能力（每请求自带 `scopeRef`，`purge` 是唯一扫遍全部 scope 的方法），实例级固定 scope 是合法部署形态（官方装配器 `createBuiltinNotesTools` 同形），并给出固定 scope 端口跑套件的适配说明（在 factory 里把请求的 `scopeRef` 解析到对应实例，而不是丢弃该字段）；**deepEqual 的可测试定义**——JSON 值全字段往返（非白名单）、数组序保真、对象键序不承重、JSON 不可表示值（`undefined`/`Date`/`BigInt`/函数/`NaN`/循环引用）不在承诺内，并写明裁决 6A 的要求：宿主把 `record_version`/`expires_at` 一类元数据列在端口出口投影掉，使公共记录形状永远干净。同时把 `revoke` 承诺改写为「可观察消失」并显式声明「墓碑不可复活从未是现行承诺」、LWW 一段限定到文件适配器并补上「CAS store 合法」一句、`list` 一段补上「非法 limit 抛错 / 超过 200 钳制」两半；契约测试套件章节同步：注册函数八→九（`notes-store.js` 现导出两个）、标准用法围栏与表格补上 `notesStoreCasContract`、套件清单的 notes 行改为已裁决口径，并新增「放宽也是一个信号」一条（bump 后变绿同样是 changelog）。
- 四份升级指南（0.14.0/0.15.0/0.16.0/0.17.0）逐条补上**可逐字执行的宿主自查命令**（issue #183）：把「宿主需要有的列/表/索引」从陈述现状改为给命令，包括 `SHOW COLUMNS` / `INFORMATION_SCHEMA.COLUMNS` / `SHOW INDEX` / `EXPLAIN` / SQLite `PRAGMA table_info` 与逐引擎 CLI 形式，加 `node -e` 能力探针（探 `loadRunStateStatus` 等——它被故意排除在 `RUN_STATE_STORE_METHODS`/`OPTIONAL_TRANSCRIPT_STORE_METHODS` 外，缺实现时**一句告警都没有**），并给存在性之外的两段实测（写入侧不得是字面 `NULL`、读取侧 `SELECT` 必须带该列——touwaka 的两个真 bug 各对应一段）。0.17.0 §6 附「0.14.0→0.17.0 自查覆盖表」，把每一条宿主侧声明对应到哪条命令，**无命令的条目显式写理由**（如「无需迁移」或投影字段从不落盘），使「没命令」是决定而不是漏项；并把双侧落地步（新建临时库只走新装路径再重跑自查）推进 CI。（需同步 CN 的只有契约文档：四份升级指南无 CN 对应物，本轮未新建）
- 契约新增「压缩策略选择（issue #167）」（中英同步）：`context.strategy` 名字|对象双形式、启动期解析与报错时机、名字形态对 `recoveryHint`/`stubFor` 的接管范围、fold-llm 默认 summarizer 的输入构成与**成本提示**（每次压缩多一次主力调用）、usage 计入总账与 `onUsage` 可见性、「不计轮次/stall、不动 `latestApiInputTokens`」与降级口径；`docs/requirements*.md` FR-3.4/3.5 从「部分交付 / 需宿主注入」改写为三策略均可名字选用 + 默认 summarizer 仍受 `maxSummaryTokens` 约束（#167）。原任务 3（`src/display/projection.js` 容错分支收窄）经证据裁决为**不收窄**：全文件 457 行只有 1 处 `try/catch`（`safeStringify`，`src/display/projection.js:126-132`）可数，其余“容错分支”是被契约与测试钉住的输入容忍（`docs/host-consumer-contract.md`：“accepts any subset of records … without throwing”；`test/display/projection.test.js:279-291` 直接断言 `[null, undefined, 7, "x"]` 与 `messages: {}`/`response: {content: null}` 不抛错；transcript JSONL 是 append-only 历史，跳版本 resume 时字段缺失/额外是必然而非假设），收窄会拿已文档化的 no-throw 保证换 ≤ 10 行收益，故只记录结论不动代码。
- 契约新增「终止裁决决策表（issue #170）」（中英同步）：9 个返回态 reason + 抛错态 `persistence_failed` 逐行给出**触发机制（file:line）/ 在优先级链中的位置 / 宿主开关 / 推荐宿主动作**（`src/reflection/governor.js:59-129`、`src/loop/termination.js:93-100`、`src/loop/orchestrator.js:845-895,2866-2891,3010-3090` 等逐行校对），并附 `verification.status` 四值与 CLI 退出码映射（`verified`/`skipped`/`unverified`/`error` → `0`/`4`/`2`/`3`，`bin/cli.js:1015-1022`）与「机制优先级与互斥关系」小节（token 补全边界 → stall → wrapup 声明 → completion 关键词兜底 → `no_tool` → judge end-turn 评估 → 停止后验证 → `fail()` 分类）；`failed` 行按 `termination.errorCode` 分流（#176）、`aborted` 行指向 `error.usage`/`rounds`/`finalText`（#180）。宿主不再需要通读 orchestrator 就能裁决终局。
- 契约新增「模型元数据与预算推导（issue #182）」（中英同步）：把 `modelConfig`/`modelMetadata` 能携带的字段钉成表格（`contextWindowTokens`/`maxOutputTokens`/`maxTokens`/`temperature`/`topP` 与思考类、超时、身份类、未知字段），逐项标注**进 provider 请求 / 驱动预算与压缩 / 缺省行为**；写清 duck-type 探测顺序 `[modelConfig, modelMetadata, model, provider, context]` 且**首个命中不合并**（`src/loop/budget.js:59-69`）、`modelConfig` 必须是解析器、`session.modelSlot` per-run 选槽与未知槽回落 `default`、slot 未知字段的惰性透传承诺，以及两种口径的触发条件（元数据缺位 → 静默跳过 + 恰好一条 `model_metadata_missing`；值非法/窗口不够大 → `computeBudget` 运行前抛 `invalid_budget`，不带 #180 载荷），并把该事件正式引为宿主装配自检断言点；#181 节末原本悬空的一段预算文字改为指向新节的指针（不重复、不漂移）。
- 契约新增可执行的「多模型槽位装配示例（issue #182）」（中英同步）：`slots` 目录 JSON 形状 + `createJsonFileModelConfigProvider` → per-run `session.modelSlot` 选槽 → `createOpenAIProvider(slot)`，把“温度/`max_tokens`/思考档位跟着模型走”钉死；`test/contract/doc-examples.js` 的 js 围栏数 6→7，新围栏以真文件 provider + 真 openai provider + 真 `runToolLoop` 跑 L3（只给磁盘与网络接桩），epilogue 断言 per-run 选槽真的落到了请求的 `model`/`max_tokens`/`temperature` 上、`apiKeyEnv` 在 `resolve()` 时被物化。
- 0.17.0 升级指南 §2 参考 SQL 改为与契约正文/运行时同一 nullish 判据（issue #171，宿主 touwaka 报告：旧 `OR` sketch 在 `dedupKey`/`roundKey` 并存且不等时多命中，照抄会静默丢一轮）；契约新增 `loadMaxRound` 非空 store 返 `≥0` 边界、`__` 宿主保留记账命名空间声明；契约套件新增 nullish 判据分叉 fixture（宿主写成 `OR` 会红）。
- 新增轻量文档漂移检查 `scripts/docs-drift-check.mjs`（issue #164，零依赖）：把「文档说的 == 代码/清单里真值」钉成可执行检查——① 版本（README/requirements 的「当前版本」声明、文中引用的任何版本号不得高于 `package.json`、requirements 阶段表 current 行）；② 关键默认值白名单 14 条（stall 窗口与模式、maxRounds、maxTokenContinuations、TTL 与 fold 阈值、judge interval/timeout/failureLimit、reflection 自动启用门槛、maxExtensions/maxRoundsCap、退避上下限、writeToolNames/writeToolPathKeys、notes 统一保留期），真值直接从 `src/` 参数默认值里抽（抽不到就报错，避免规则静默失效）；③ README 引用的 `files`/`exports` 清单与 `package.json` 逐项比对，并校 `test/contract/index.js` 再导出的套件真的在 `files` 里；④ 模块地图必须覆盖 `src/` 全部文件；⑤ README 引用的仓库内路径与 `node <file>` / `npm run <script>` 命令存在；⑥ 中英 README 标题骸架对齐（做法参考 `docs-sync-check.mjs`，更轻）。与 #158 三层验证同口径采用**先告警后阻塞**：会误导宿主的为 error，只表示文档没跟上的滞后信号为 warn（`--strict` 升级）。挂入 `npm run check:docs`（带 `docs-sync-check`）与 `npm run check:docs:strict`；README 「Engineering constraints」与 AGENTS 开发命令表已补说明，规范写法约定（「当前版本」声明的固定句式）写在脚本顶部注释里。判据层（升级指南的参考 SQL 与运行时同判据）本轮只纳入人工清单，中期归 #158 扩展覆盖面。
- 契约新增「Judge record correlation and run outcome（issue #165）」中英两节：`runId`/`model`/`judgeModel`/`run_outcome` 四个字段的出现条件与解析口径表格、为什么用独立终局记录而非回写（append-only）、判别键（`kind` vs `type`）、这一个事件的宿主抛错为何被吞，以及字段稳定性承诺（只 additive 演进：同一主版本内不重命名/不改型/不删字段；档案仍是 debug/分析面，不是完成证书）。README 中英同步 `onJudge` 段与 `--judge-log` 条目（顺带修掉 #55 之后残留的「经过脱敏的 / redacted」措辞——档案早已原样落盘）；AGENTS 中英 §6 补 judge.log 记录形状一行。

- 契约新增「Search tool (issue #195)」/「搜索工具（issue #195）」中英两节（`docs/host-consumer-contract*.md`，写法照 `File tool registration` 的 Tier 2 口径）：为什么要新名字（借来的名字带来借来的先验，逐条列出模型会踩的三个先验）、`mode` 必填且**无默认值**的错误结果形状、`name_pattern` 只匹配文件名/不跨 `/` 与 `searchText` 拒绝 `glob` 的裁决（「报错」而非「忽略并回报」，二选一选了前者）、`{content, metadata}` 的字段清单与**「进 transcript、不上 wire」**口径（宿主需要稳定信号就按 metadata 分支，不要按 marker 子串匹配）、别名命中正文逐字等式是宿主要依赖的不变式而渲染形状不是、R4 明确没做的四条与其交叉原因。README 中英「内置工具」段同步（新增 `searchText`、把 `rg`/`grep` 标为薄别名并把「两个搜索工具」改成「三个」），`scripts/docs-drift-check.mjs` 新增两条**行为锚点**真值规则（`mode` 必填取值来自源码 `SEARCH_MODES`；`name_pattern` 语义锚点是 `nameExpression.test(path.basename(filePath))` 那一处匹配对象），并把「rg 默认搜索模式为正则」的锚点跟 `aliasSearchMode()` 抽取函数同步——三条都反向实测过：改源码锚点必红。

- 契约新增「File tool registration」/「文件工具注册」两节（`docs/host-consumer-contract*.md` 中英成对，结构与措辞照 `### Notes tool registration`）：工厂返回的三个视图（`definitions` / 结构化 `executeTool` / `executors`）、默认无 containment 的理由、以及**两层口径**——`allowRead`/`allowWrite` 的谓词签名 `(absolutePath: string) => boolean` 与「返回 `false` → 工具返回错误结果而不抛异常」属 **Stable**，而**所有 marker 字面量属 Experimental**（可在任意 minor 变，指向 issue #188 的三层分级；需要稳定信号的宿主按工具结果分支，不按 marker 子串匹配）；另列出六组会改变模型所见内容的默认值（含「`rg` 与 `grep` **都**默认正则、`is_regex=false` = `rg --fixed-strings` / `grep -F`」与「**两个搜索工具**命中行截断 500 字符（原 200，且原先只有 `grep` 截、`rg` 不截）」两条，`rg` 默认值翻转对「自带旧 CLI 那份」的宿主单独标为行为性注意），并显式声明一条能力偏离：搜索是**纯 Node 子集、不是 `rg`/`grep` 二进制**（无 `-i`/`-A`/`-B`/`--type`，**不读 `.gitignore`**，vendor 是自己硬编码的跳过清单 + 结果尾部排除账）。README 中英模块地图补 `src/tools/file-tools.js`，README 中英引用的 `files` 清单与 `package.json` 对齐（新增 `test/contract/file-tools.js`）。
## [0.17.0] - 2026-10-08

本次合并 #157/#160/#158：`appendUserTurn` 成对可选快路径探针（DB 宿主事务内免全量读）、
内置 file store 幂等缓存与契约文档示例可执行性检查。宿主升级指引见
[docs/host-upgrade-guide-0.17.0.md](docs/host-upgrade-guide-0.17.0.md)。

### Added

- `appendUserTurn` 新增成对可选快路径探针（issue #157，写侧契约）：宿主 store 同时实现 `loadByDedupKey(key, dedupKey)` 与 `loadMaxRound(key)` 时，预写 user 轮改走点查路径（先算 dedupKey → 命中即返回；未命中才 `loadMaxRound` 派生 round → `appendRound`），全程零 `load` 调用，消除 DB store 事务内全量读随数据量线性变慢；只实现其一等同全不实现，回退现行为（全量 `load`）逐行不变；返回值违约抛 `TypeError`；签名、`written` 语义与返回形状不变，内置 file store 不实现（#160 已优化）。契约文档「TranscriptStore capability tiers」与「Multi-turn resume contract」中英同步。
- 契约文档示例可执行性检查（issue #158）：新增 `test/contract/doc-examples.{js,test.js}`，直接从 `docs/host-consumer-contract.md` 提取全部 5 个 ```js 围栏做三层验证（L1 语法编译 / L2 真实符号链接 / L3 注入上下文子进程真实执行，超时 15s），并断言 CN 版围栏代码骨架与 EN 一致；API 漂移会让 `npm test` 变红并报出围栏行号与子进程 stderr。两个新文件不进 npm files 白名单（宿主不需要）。新增 `npm run check:docs-examples`。

### Fixed

- file store 的幂等判定改为进程内 dedup key 缓存（`(size, mtimeMs)` 校验，issue #160）：每次 `appendRound` 不再全量读 transcript，`appendUserTurn` 每轮全量读 2→1 次（CLI resume 路径 3→2 次），300 轮单次调用 p50 从 50 ms 降至 22.5 ms。幂等语义、崩溃修复与 `load()` 行为不变（无新文件、无格式变更）。

## [0.16.0] - 2026-10-08

本次合并 #151/#152/#153/#154，并吸收未发布的 0.15.1 文档与打包修复。宿主迁移指引见
[docs/host-upgrade-guide-0.16.0.md](docs/host-upgrade-guide-0.16.0.md)。

### Fixed

- 修复 npm 包缺少中文版宿主消费者契约，并将包内指向未随包发布文档的相对链接改为 GitHub 绝对链接。
- 移除 README 中指向未入库 `docs/tasks/` 的死链；`check:pack-links` 现在会报告仓库内不存在的链接目标（警告，不阻塞）。

### Added

- 展示投影新增稳定身份 `key`（turn 级与 `toolCalls[]` 级），同一输入数组内唯一且确定；新增 `meta.sourceInferred`，仅文本前缀启发式命中时出现。
- 新增阻塞式 `npm run check:pack-links` 包内链接闭合检查。

### Changed（宿主契约新增义务）

- 新增「Store fidelity requirements」：宿主 store 必须保留完整 `RoundRecord` 与 message 对象（包括未知字段）；`messages[].meta.source` 是引擎保留标记；`load()` 必须对同一 `round` 的记录按持久化追加顺序返回，引擎不做二次排序。

### Compatibility

- 宿主应按 `docs/host-upgrade-guide-0.16.0.md` 自查 store 保真与同轮排序。
- 投影新增字段均为 additive（非破坏）；无 API 移除。

## [0.15.0] - 2026-10-07

来源：宿主 erix-station 反馈的三个 issue（Gitea erix-llm-kit #95/#96/#97）——「transcript 作为唯一真相」
的完整宿主侧接口：读侧官方展示投影（PR #146）+ 写侧追加用户轮引擎能力（PR #147）+ 升级指南形状
修正（21a7672）；另含独立第三方审计后的收口（PR #148：契约语义收窄、行为硬化、测试/类型/中文文档补口）。
全部为增量能力，无破坏性变更。宿主迁移指引见
[docs/host-upgrade-guide-0.15.0.md](docs/host-upgrade-guide-0.15.0.md)。

### Added

- `appendUserTurn(store, { key, text, messageId?, ts? })`（宿主 Gitea issue #97，写侧契约）：
  引擎能力化「预写入 user 轮 + `resume: true`」多轮续跑模式——round 推导（复用现有最大 round，
  空 store 为 0）、dedupKey 生成与唯一性（有 `messageId` 时稳定幂等）、记录形态、幂等判据
  （顺序重跑语义，以 `dedupKey` 为准）全部由引擎负责；内置 CLI/REPL 已改为调用它。契约文档
  新增「Multi-turn resume contract」小节（含 resume 时 `initialMessages`/`initialUserMessage`
  被忽略的前提声明、事务内落树时机）。中文同步小节见 `host-consumer-contract_cn.md`。
- `projectTranscriptForDisplay(records)`（宿主 Gitea issue #95，读侧契约）：官方宿主展示投影纯函数，
  输出 `[{ role, text, blocks, toolCalls?, reasoning?, folded?, round, ts, meta }]`——reasoning 与
  text 分离、折叠轮只呈现摘要+范围+导航指针（不渲染 `foldedPayload` 原文）、合成轮以
  `meta.synthetic`/`meta.source` 标注。契约文档新增「Host display projection」小节：展示字段白名单、
  稳定性承诺（投影输出形状是宿主可长期依赖的契约面，`RoundRecord` 内部字段不是）、只读视图声明、
  反模式声明（不要把第二份有损消息表当模型上下文来源）。
- `test/contract/engine-api.js` 契约套件（PR #148）：宿主可引用验证包入口导出
  `appendUserTurn`/`projectTranscriptForDisplay` 与最小预写行为；随包发布。

### Fixed

- 0.14.0 升级指南 §1 示例与源码/契约测试不一致（宿主 Gitea issue #96）：`loadRunStateStatus`
  返回**状态字符串**（`Promise<string | undefined>`）而非状态记录对象，示例改为
  `if (status === "succeeded")`；契约文档 capability tiers 表附近同步补返回形状。

### Changed（契约语义明确，无行为破坏）

- `appendUserTurn` 行为硬化（PR #148）：`store.load()` 返回非数组现在抛 `TypeError`（不再静默
  当空库）；仅空白 `text` 拒绝；`written: true` 语义明确为「本次调用执行了 appendRound」，
  不承诺并发去重下落盘——同一 key 的追加应由宿主串行或在接收事务内发起（顺序重跑幂等不受影响）。
- `RoundRecord` typedef 补齐既有事实字段 `roundKey`/`navigationRecord`（仅 JSDoc 补全）。

## [0.14.0] - 2026-10-03

来源：issue #139/#140 工具幂等声明与 partial 落盘（PR #141/#142，含 e2e 验收发现的
#143 流式前提校验，PR #144）+ issue #91 项 1/项 2 run-state 终态通道拆分（PR #92/#93/#94，
决策记录 ADR-019）+ issue #89 run-state 损坏态回落与可用性棘轮修复（PR #90）+ issue #136
notes 凭据检测退役 + issue #60 Phase 2 loop.js shim 删除。
宿主迁移指引见
[docs/host-upgrade-guide-0.14.0.md](docs/host-upgrade-guide-0.14.0.md)，契约文本见
[docs/host-consumer-contract.md](docs/host-consumer-contract.md)。

### Added

- 可选 partial 落盘窗口（issue #140）：`partialPersistence` 缺省关闭；启用后按 interval
  单飞覆盖写流式 assistant 文本到 run snapshot，resume 可恢复有效 partial，沿用现有
  `saveRunSnapshot`，不新增 TranscriptStore 方法；启用需设置 `stream: true`，
  否则启动时报错（issue #143）。
- 工具重放幂等声明（issue #139）：工具 schema 可声明 `replay: "safe" | "unsafe"`，
  run snapshot 持久化每个 pending intent；`replayPolicy: "per-tool-declaration"` 下只自动重放
  safe 工具，unsafe 工具回注 interrupted 结果并发出待宿主决策事件。缺省 `always-replay`
  保持现有恢复行为。

### Changed（BREAKING）

- **run-state 终态与快照拆分通道**（issue #91 项 2）：`markRunState` 现在独立写终态，
  宿主可用新增的 `loadRunStateStatus` 读取（引擎不调用、不校验该宿主面向读方法）；
  `saveRunState` 的 latest-only 快照不再写入 `state` 键。宿主应将
  `loadRunState(runId).state` 迁移为 `loadRunStateStatus(runId)`，继续用 `loadRunState`
  读取快照字段。旧数据中的内嵌 `state` 仍由 `loadRunState` 原样透传，并作为新 status
  reader 的回落来源。
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

### Fixed

- **损坏的 run-state 不再被 record fallback 吞掉**（issue #89）：独立 run-state 存在但校验不通过时，
  旧行为会「报告 `state_unavailable`、却从最新 `RoundRecord.runState` 恢复一份**更旧**的状态」。
  现在明确区分「**不存在**」（`loadRunState` 缺失或返回 `undefined`，才允许 fallback 到 record）与
  「**存在但无效**」（报不可用、**不** fallback）。
- **消除 `stateAvailability` 的自我传播**（issue #89）：该字段是**本次 resume 的观测结果**，不再作为
  后续 resume 的结构校验拒绝条件——修掉「一次损坏 → 之后每次 resume 都判不可用」的棘轮（实测该污染
  会同时击中两份拷贝）。字段本身仍随 run-state 保留供诊断。详见 `docs/host-consumer-contract.md`。
- 行为影响：独立 state 损坏时不再静默使用旧状态（run 照常继续，只是不恢复状态）；未实现
  `loadRunState` 的宿主（如 touwaka 的 `{appendRound, load}` 最小 store）不受影响。

## [0.13.0] - 2026-09-30

来源：issue #78 run snapshot 更名与 capability 分级（PR #80）+ issue #75
chat 会话接续与会话索引（PR #79）+ issue #81 测试全量隔离真实 ~/.erix
（PR #85）。
宿主迁移指引见
[docs/host-consumer-contract.md](docs/host-consumer-contract.md)。

### Changed（BREAKING）

- **checkpoint 更名 run snapshot，快照/run-state 方法降级为可选 capability**
  （issue #78，PR #80）：语义显式化为 latest-only autosave——每轮覆盖同一
  槽位、仅用于中断恢复现场，从来不是多版本 checkpoint。更名：
  `saveCheckpoint` → `saveRunSnapshot`，
  `loadLatestCheckpoint` → `loadLatestRunSnapshot`；`appendCheckpoint`
  **并入** `saveRunSnapshot`（两者同为覆盖写，保留 append 只会误导出版本化
  错觉）。**capability 分级**：必需方法只剩 `appendRound`/`load`
  （TRANSCRIPT_STORE_METHODS）；可选 run snapshot（`saveRunSnapshot`/
  `loadLatestRunSnapshot`）+ 可选 run-state（`saveRunState`/`loadRunState`/
  `markRunState`）缺省时引擎跳过对应持久化、run 正常执行（仅不支持中途
  crash resume），每个缺失方法只发一条 `persistence_capability_degraded`
  诊断事件（`{type, runId, method, detail}`，不每轮刷屏）；广告了方法但写
  失败仍按原档位终止 run。file store 落盘后缀 `.checkpoint.json` →
  `.snapshot.json`，读取优先新后缀、ENOENT 回落旧后缀（读取兼容，不做数据
  迁移）。旧方法名在 file/memory store 保留为 `@deprecated` 别名；运行时
  兼容只实现旧名的第三方 store（写入解析 `saveRunSnapshot` → `saveCheckpoint`
  → `appendCheckpoint`，读取解析 `loadLatestRunSnapshot` → `loadLatestCheckpoint`）——
  宿主应迁移到新名，别名可能在未来 major 移除。

### Added

- **chat 增加 `-c`/`--continue` 与 `-r` 会话接续**（issue #75，PR #79）：
  `-c` 解析为当前 cwd 最近会话（等价手动 `--session <最近id>`，与 `--session`
  互斥，无可续会话报清晰错误）；`-r` 为零依赖交互式 picker（readline
  keypress + raw mode，Esc/Ctrl+C 取消，非 TTY 报 usageError）。新增
  `bin/sessions.js`：`~/.erix/sessions.json` 缓存索引（sessionId/cwd/
  updatedAt/firstUserText，上限 500 条，原子写入、失败静默），索引丢失/损坏时
  readdir transcripts 目录重建（只认可往返的 `*.jsonl`，跳过 run-h-* 哈希
  文件名与非法 JSON 行会话）；cwd 归属单独持久化在 `~/.erix/session-meta.json`。
  chat/repl 运行后 upsert 索引（仅收录真实产出 transcript 的会话）；
  resume 判定逻辑一行未改，`src/` 零改动。

### Fixed

- **测试全量隔离真实 `~/.erix`**（issue #81，PR #85）：系统排查 test/ 全部
  `runChat`/`runRepl`/`createMcpProxyTool`/`buildSkillTools` 调用点，凡缺省
  解析真实 `~/.erix` 的路径全部注入临时 home / notesDir / skillsDir / 空
  MCP 配置——纯测试改动、不碰生产代码。覆盖：note_take 真实写入
  `~/.erix/notes/`（本机实证）、收尾 purgeInactiveNoteScopes 以真实笔记目录为
  扫描对象（存在删除真实笔记风险）、MCP 代理/skills 工具缺省解析
  `~/.erix/mcp.json`、`test/fixtures/cli-golden.json` 删除环境依赖段落使黄金
  用例确定化。此前这些用例在装有真实配置的机器上行为不确定且有副作用。

## [0.12.0] - 2026-09-27

来源：issue #67 notes host 迁移（PR 1 #71 生命周期拆分、PR 2 #72 list 契约与
semantic 缓存、PR 3 #73 schema run-only；决策记录 ADR-018，含维护者复盘的
D3 决策反转——revision/分页协议判定为 YAGNI，出厂前削减）+ 出厂前外部审计
收口（统一保留期、janitor 删除、liveness 框架删除、purge 去分页）。
宿主迁移指引见
[docs/host-upgrade-guide-0.12.0.md](docs/host-upgrade-guide-0.12.0.md)，契约文本见
[docs/host-consumer-contract.md](docs/host-consumer-contract.md)。

### Changed（BREAKING）

- **notes lifecycle 收敛为单一收尾钩子**（issue #67 PR 1 + ADR-018 D8）：`lifecycle`
  只剩 `onRunComplete`（只调 completeRun，active → done，返回 `{ completed, errors }`）。
  `onRunStart` no-op 兼容桩删除——run 起点不做任何 notes 维护。
- **janitor 删除，双计时器合一为统一保留期**（ADR-018 D7）：done 的「过期翻转
  → revoked 墓碑」机制整体消失；根决策为**会话时钟**——笔记寿命 = 会话寿命 +
  尸检期（默认 30 天）。库内 `store.purge()` 是可移植兜底基线：scope 目录内
  全部记录文件的最大 mtime 距今超过 `ERIX_NOTES_RETENTION_MS` → 整个 scope
  的记录文件（含 active）整体删除、空目录移除；未超期 → 整个 scope 豁免
  （含其中很老的笔记）。`done`/`revoked` 退化为纯语义标签（模型可见性与
  forensics），与清理无关。
- **维护责任全部归宿主**：引擎不做任何隐式清理；CLI/REPL 自身作为宿主在收尾时
  按会话时钟清理（chat = transcript mtime，30 天无对话活动的 session 其笔记随
  transcript 过期一起清理；找不到 transcript 回退笔记 mtime）。嵌入式宿主
  自行调度 `store.purge()` 或基于宿主知识（调度器状态）用 `store.list` +
  `store.revoke` 原语自建清理循环。
- **liveness 端口框架整体删除**（ADR-018 D8）：宿主知道 scope 死活，拿着公开
  `store.revoke` 原语三行循环即可，库不需要 liveness 知识。删除 assembler 的
  `liveness` 选项、`validateLiveness()`、`lifecycle.revokeInactive()` 全部实现。
  `store.revoke()`（含 `expectedState`/`expectedUpdatedAt` 陈旧读护栏）保留——
  它就是宿主自建清理循环的原语。
- **`NotesStore` 必需方法定为六个**：`write/read/list/complete/revoke/purge`，
  assembler 创建期 `assertNotesStore` 校验，缺方法立即 `TypeError`（不再静默回退
  隐式 file store）。
- **`purge()` 去分页**（审计 C 项）：删除 `limit`/`cursor` 参数与 opaque-key
  游标协议，一次调用全量扫描、全量处理（扫描本就全量读，分页只省内存切片）；
  返回值收敛为 `{ status, scanned, purged }`（`scanned` = 扫描的 scope 目录数，
  `purged` = 删除的记录文件数）。`before` 参数保留且语义不变：只能缩小范围。
- **`complete()` 不再写 `expires_at`**（ADR-018 D7）：该字段退役为历史遗留——
  purge 不读它，新写入的 done 记录不带此字段，旧文件无需迁移；记录的
  `updated_at` 退化为纯语义元数据（排序用），与清理无关。
- **配置单旋钮**：`ERIX_NOTES_RETENTION_MS`（默认 30 天）统一控制保留期；
  `ERIX_NOTES_GRACE_MS`（0.11.0 发布过）降为 deprecated alias，两者并存以新
  变量为准。`ERIX_NOTES_DONE_GRACE_MS` / `ERIX_NOTES_TOMBSTONE_RETENTION_MS`
  从未随 0.12.0 发布，直接消失，无兼容包袱（done 的 7 天宽限概念一并消失）。
- **`note_list` schema 瘦身**：删除 `source` 与 `minRelevance` 两个输入参数
  （模型侧很少用）；保留 `tag`、`includeInactive`。store 层 `list()` 的
  `filters.source`/`filters.minRelevance` 能力保留（内部消费方/远程 store
  契约完整性）。
- **`list()` 契约**：`filters`（`state`/`tag`/`source`/`minRelevance`）与
  `sort`（`relevance`/`pinned_updated`，稳定比较下沉 store，不再裸调
  localeCompare）下沉 store；不给 `limit` 返回全部匹配记录，给了 `limit`
  钳制最大 200（store 层参数保留：semantic 传 20、内部消费方可用）。
- **`note_list` 参数与输出收窄**（issue #67 PR 2 + 维护者追加简化）：`cursor`
  （翻页）与 `limit`（限额）参数全部移除——始终返回该 scope 全部匹配记录
  （实测平均约 2 条、峰值 9 条，20 条以内 LLM 完全可应对）；输出移除
  `total`/`nextCursor`/`revision`/`sourceRevision`，保留 `count` 与过滤
  （`tag`/`includeInactive`）。
- **schema 收敛 run-only**（issue #67 PR 3）：4 个 `note_*` 工具 scope enum 只剩
  `["run"]`，`project`/`user` 直接 invalid（不再是"暂不支持"的假 API 表面）。

### Added

- **store 新方法**：`revoke(request)` 写撤销墓碑，带 `expectedState`/`expectedUpdatedAt`
  并发护栏（竞态返回 `unchanged`，不覆盖）；`purge(request)` 物理删除过期
  scope（统一保留期到期 + 整本删除，`before` 只能缩小范围）。
- **CLI/REPL 会话时钟维护**（`bin/tools.js` 的 `purgeInactiveNoteScopes()`）：
  收尾时遍历 notes scope，按对应会话文件（chat = `<transcriptsDir>/<scopeRef>.jsonl`，
  repl = 会话存档）mtime 判定生死；无会话文件回退笔记文件最大 mtime；维护失败
  静默，绝不影响主流程。
- **`normalizeNoteRecord()`**（`src/store/notes.js` 导出）：记录时间字段统一兜底——
  缺 `updated_at` 回退 `created_at`，均缺/非法用固定 epoch
  `1970-01-01T00:00:00.000Z`（不伪造"现在"）。
- **semanticStateProvider 进程内缓存**（纯 epoch 短路）：assembler 内任何变更
  推进 epoch，epoch 未变零 list 调用直接复用缓存文本，变化才重渲染；list 失败
  返回 `undefined` 绝不拿旧缓存冒充最新。
- **notes 持久化失败上报扩展**：`revoke`/`purge` 纳入上报面（`revoke`/`purge`
  按写副作用分类）。

### Removed

- **删除 `store.janitor()` 与模块级 `runNotesJanitor()`**（ADR-018 D7）：
  done 过期翻转的唯一职责随双计时器合一消失；宿主维护循环从两条并一条
  （只循环 purge）。
- **删除 liveness 端口框架**：`createBuiltinNotesTools({ liveness })` 选项、
  `validateLiveness()`、`lifecycle.revokeInactive()`。active orphan 清理 =
  宿主知识 + `store.list`/`store.revoke` 原语自建循环（无 liveness 的宿主
  active orphan 永不自动回收，宁积累不误杀）。
- **删除 `lifecycle.onRunStart()`**：no-op 兼容桩不再保留；run 起点零 notes 开销。
- **删除 `complete()` 的 `expires_at` 写入与 `note_take` 的透传保留**：
  该字段退役为历史遗留。
- **`note_list` 删除 `source`/`minRelevance` 入参**（schema 属性 + 校验 +
  透传全删）。
- **删除 `recordAutoCapture()`**（issue #67 PR 3，ADR-016 收尾）：`note_take` 为唯一
  写入口；历史 auto 记录读取能力保留（输出仍标注 `@auto` provenance）。

### Fixed

- **误杀面归零**：active 记录的生死不再由引擎时间启发式判定（0.11.x janitor
  误杀回归已随 janitor 删除彻底消除）；scope 级豁免保证活会话内的老笔记
  永不清理。
- **complete 全量收集**：complete 改为内部扫描本 scope 全量置 done（不受 limit
  钳制截断）；实测单 run 平均约 2 条、峰值 9 条笔记，无翻页/版本协议负担。

## [0.11.0] - 2026-09-26

来源：issue #61 重构（notes assembler API 收敛，`refactor-260926-01`）。

### Changed（BREAKING）

- `createBuiltinNotesTools()` 返回对象收敛为 6 键 canonical API：`definitions` /
  `executors` / `executeTool` / `resolveTools` / `lifecycle` / `semanticStateProvider`；
  退役 7 个冗余别名键：`tools`、`provider`、`listTools`、`notesJanitor`、
  `notesCompleteRun`、`runNotesJanitor`、`completeRun`（issue #61）。
- 迁移指引：需要 provider 形态的宿主，用 `erix-agent/tools` 子路径导出的
  `createStaticToolProvider` 配合 assembler 的 `definitions` 自建
  （`createStaticToolProvider({ sets: { default: notes.definitions } })`）；
  原 janitor / complete 可调用别名改走 `lifecycle.onRunStart(...)` /
  `lifecycle.onRunComplete(...)`（后者返回 `{completed, janitor, errors}`）。
  模块级导出的实现函数 `runNotesJanitor` / `completeRun`（`src/tools/notes.js`，
  经 `erix-agent/tools` 子路径 re-export）为 lifecycle 内部实现，不受影响、照旧可用。
- 旧 skill loader 消费方：直接 import `src/tools/notes.js` 导出的函数，或经
  `erix-agent/tools` 子路径获取同源导出。
- bundled notes skill 退役：删除 `skills/notes/`（skill.mjs 兼容 shim 一并移除），notes
  工具交付统一走 `createBuiltinNotesTools` 工厂；`erix skills` 不再列出 bundled notes
  （bundled skill 发现机制本身保留，`skills/` 目录仍在发现列表，用户级 skill 发现不受影响）；
  `getSkillDefinition()` 导出连同 `erix-agent/tools` 子路径的 `getNotesSkillDefinition`
  re-export 一并删除。第三方依赖 bundled notes skill 的旧 loader 会失去该发现路径，
  需改为直接 import `src/tools/notes.js` 或 `erix-agent/tools` 子路径（breaking）。

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
