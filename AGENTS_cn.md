# erix-agent — 项目 AGENTS.md

> English version: [AGENTS.md](AGENTS.md)

项目特有规则；共享/全局约定见 `~/projects/AGENTS.md`，并且有意不在此重复。本文件随仓库走（GitHub: ErixWong/erix-agent）。

## 1. 项目定位

**自研无头编码 agent（headless agent）**：零依赖 LLM agent 运行时（双协议流式 + 工具循环 + 压缩 + checkpoint），用于**无人值守、宿主编排**场景（app_container / touwaka 嵌入式底座）。

- 产品形态 = **无头 agent**：`runToolLoop` 单任务生命周期（start/run/stop/resume/event stream），执行（`executeTool`）由宿主注入；**边界止于单个任务生命周期**；多角色编排/仲裁/重试调度由宿主负责，不纳入库中。
- **CLI (`bin/`) 是验证器/调试器，不是重点**：交互式 TUI + `chat` 单次入口（可作为 bench 入口）；能力验证使用 erix-bench 无头 harness（容器驱动 + 判分器，对比 `--agent erix|pi`），而交互式 repl 仅测试人机协作。
- 与 pi 的关系：**pi = 交互式 agent（人在环）；erix = 无头 agent（无人值守、宿主调度）——互补而非竞争**。
- **已知边界缺口：`erix_run`（`examples/pi-extension`）为拿 `exec` 与工具提示词装配而依赖 `bin/tools.js`**——因为 `exec` 从未进入 `src/` 公共面（`grep 'name: "exec"' src/` 为空）。既然 `bin/` 是验证器/调试器而不是契约面，**新增**对 `bin/` 的依赖必须先把能力提到 `src/` 公共面（或由宿主自己实现那个工具）——见 `examples/pi-extension/README.md` 的「边界：不得依赖 `bin/`」一节。
- 安全分层（ADR-009）：agent 不内置安全；**使用者负责**（本地 = 信任域；嵌入式容器由宿主隔离）。
- 红线：**零 npm 依赖**（只导入 node: 内置模块 + 相对路径），纯 ESM、Node 22+，绝不提交 key/token。
  这条红线约束的是**import，不是工具链**：`typescript` + `@types/node` 是经用户授权的 devDependency（issue #213，发布 `.d.ts` 类型面），
  它们只为生成声明而存在，`src/`/`bin/` 从不 import，也不会作为依赖进入 tarball。`package-lock.json` 刻意被 git 忽略
  （仓库历史上从来没有 lockfile，加它属于另一个决定）。

## 2. 代码结构

```
src/
├── index.js
├── assembly.js    # AssemblyPort 校验（宿主边界）
├── assembly-validators.js  # 端口/选项校验共享实现（内部模块）
├── run-state.js
├── tokens.js
├── loop/          # 编排核心：orchestrator（runToolLoop）、option-normalization、
│                  # provider-runner、run-snapshot-executor、budget、aggregate-budget、
│                  # termination、resume-manager、error-ledger、messages、reflection、
│                  # task-brief、abort、block-helpers、tool-result-ttl、deliverables
├── compact/       # 上下文压缩：budget、pipeline、sliding-window、fold-statistical、
│                  # fold-llm、anchors、fold-fidelity、enforce-size、helpers
├── config/        # 配置适配器（含槽位 → provider 构造件 loadModelSlot / createProviderForSlot，issue #406）
├── messages/      # 规范消息模型 + OpenAI/Anthropic 转换
├── normalization/ # 模型输出归一化：normalizeModelJson（L1 保字节修复、闸门判原始字节、
│                  # 可选 L2 LLM 兜底，issue #406）——与 text/ 里同步 L0 的 parseModelJson
│                  # 是**两个入口**，不是同一个函数的两个名字
├── providers/     # OpenAI/Anthropic 双协议 provider
├── reflection/    # governor、judge、l0、wrapup
├── skills/        # 技能包 loader（发现/校验/装配）的规范实现；内置技能目录由调用方注入（`bundledDir`），
│                  # 库内绝不从自身文件层级推断
├── store/         # file、memory、notes
├── text/          # 共享文本辅助函数（label 归一化）
└── tools/         # registry、providers、notes、文件工具，以及技能 loader 的转出
                   # （可选 erix-agent/tools 子路径）
bin/              # CLI（验证器/调试器）：cli.js（入口/chat）、repl.js（TUI）、tools.js（内置工具 + 提示词）、skills.js（只是 src/skills/loader.js 的薄装配）、mcp.js、config.js、final-guard-support.js、final-guard.js、guard-metrics.js
test/             # 单元测试（node --test），包含 compact/、providers/、tools/、config/、messages/、contract/、helpers/、fixtures/、integration/ 以及顶层测试文件
fixtures/         # 测试夹具（mock MCP 服务器）——⚠️ mock MCP 服务器不得放在 test/ 下（node --test 会运行 test/ 下的所有文件，可能卡住）
examples/         # 可运行示例（exec-demo.js 及其默认跳过的 e2e 测试）、示例技能包（skills/）、pi 扩展
                  # （pi-extension/）、溯源复现用例，以及仓内的 memory-benchmark.js。
                  # 本仓没有 examples/benchmarks/ 目录：能力基准在独立仓 `erix-bench`
docs/             # 设计文档、ADR 决策记录、研究和任务文档
skills/           # skill 定义
scripts/          # 实验脚本和结果
```

## 3. 开发命令

| 命令 | 用途 |
|---|---|
| `npm test` | 全量测试（`node --test`） |
| `node --check <file>` | 语法安全检查 |
| `npm run check:syntax` | **全量**语法检查（issue #187）：`scripts/syntax-check.mjs` 把 `git ls-files` 里每一个跟踪的 `.js`/`.mjs`/`.cjs`（`src/`、`bin/`、`scripts/`、`test/`、`examples/`、`fixtures/`）都过一遍 `node --check`，红就点名文件并非零退出。`npm run check` 故意**保留**成单文件的 `node --check src/index.js`：`check:docs` 会校文档引用的命令真的存在，把它换掉反而制造文档漂移 |
| `npm run check:docs` | 文档漂移检查（`scripts/docs-drift-check.mjs`：版本声明、README 引用的 `files`/`exports` 清单、模块地图、文中路径与命令、从 `src/` 直抽的 14 条关键默认值、`bin/cli.js` 帮助文本与两份 README 的 usage 行双向对账的 CLI 旗标清单、中英 README 标题骸架，**以及自 issue #511 起的「这句话属于哪个版本」**：每份升级指南第一行必须自述版本；把事实归给**后面**那个版本的句子必须带指向那份指南的前向指针；「没有 `config.X`」对 `CONFIG_NAMESPACE_SCHEMA` 核、「V 加的」对该版 CHANGELOG 段核；每个带日期的 CHANGELOG 段必须写明发布了没有；`AGENTS*.md` 那两句「当前版本」当场对账——本仓版本对 `package.json`、发布行对 npm 的 `dist-tags.latest`——且两句都不许带测量日期）+ 中英契约标题结构对齐 |
| `npm run check:docs:strict` | 同上，但把告警升级为失败 |
| `node scripts/docs-drift-check.mjs --self-test` | 清单/枚举/单位类锚点的反向证自测（issue #210）：改文档一处声明 → 红、改源码真值 → 红、都不改 → 绿；变异没落上去也算失败（#210 R2） **自 issue #302 起，在哪棵树里跑都不影响结论**：`#280` 那两条树形用例跑在**合成树夹具**上，判定与本机是否存在那个不入库的 `docs/tasks/` 目录无关——在 `git archive HEAD | tar -x` 造出的「无 / 空 / 有 `docs/tasks/`」三种检出里实测：**103 例、三种树形全部 0 红**。#302 之前是另一回事：没有 `docs/tasks/` 的检出里 3 例是**已知假红**（树里有个空的则 5 例），由 issue #281 记录在案——那批红已经不存在，所以「必须在开发树里跑」是历史，不是现在的要求。 |
| `npm run check:docs-examples` | 真实执行**两份契约文档与两份根 README**（自 issue #576 起 `README.md` / `README_cn.md` 也在面内）里的 js 围栏，每格三层——语法编译、真实符号链接、独立子进程真实执行——且 README 目标表本身被看守（摘掉一条目标，守卫格就红）。执行**离线**：脚本化假 provider / `fetchImpl` 桩，不碰网络、不读 `~/.erix`（issue #158、#576） |
| `npm run check:pack-links` | 随包 Markdown 的链接闭合检查，**外加** `.d.ts` 声称对账：四份入口文档里每一句「装包应列 **N** 个 `.d.ts`」都必须等于同一次 `npm pack --dry-run --json` 列出的 `src/**/*.d.ts` 条目数（不为了数数再跑一次 `tsc`），**外加** `test/contract/` 发布面对账（issue #505）：`files` 对那个目录是**逐个列举**、从不收目录，于是「新加一个 `.js` 却没人把它加进 `files`」会静默不打包而**没有任何门禁会红**（`check:release` 只反方向断言）。三条判据：**①（红）** `test/contract/` 下存在、却不在 tarball 清单里的非 `*.test.js` 的 `.js` 逐个点名——那就是「忘了加进 `files`」；**②（红）** `files` 里列的 `test/contract/...` 在磁盘上不存在就点名——历史残留的死条目；**③（只打印，永不红）** 每个 `test/contract/*.test.js` 连同「谁跑它」与「有意不随包」的说明逐条列出（它们是 `node --test` 套件，`npm pack` 清单里 `*.test.js` 恒为 **0**——这一行存在的全部理由，就是免得后来人又把它当成漏包）。「有意不发布」必须在 `CONTRACT_PUBLISH_EXEMPTIONS` 里登记（今天恰好一条：只被 `check:docs-examples` 套件 import 的文档示例 harness——正解是把它搬出发布面目录，那是 #498 S8 的活），而登记表自己被双向看守：文件没了、文件其实随包了、`why` 为空、`path` 不是 `test/contract/` 下的具体文件、条数与 `CONTRACT_PUBLISH_EXEMPTION_MAX`（**1**，多了少了都红）对不上 ⇒ 全红。仍然**离线**、仍然只跑一次 `npm pack --dry-run --json`；`node scripts/pack-link-check.mjs --self-test` 带 **16 例**反向证（内存夹具 + 本仓真树，不跑 `npm pack`、不联网） |
| `npm run check:release` | 把发版前那条手工验证变成一条命令（issue #257 T5）：按顺序六步，红就点名第几步——`npm pack` → 断言 tarball（声明文件数 > 0、当前版本的中英两份升级指南都在、随包的 `test/contract/` 文件一个不少、`files` 白名单之外没有杂物；Markdown 链接闭合**交给** `check:pack-links`，不在这里重写）→ 把 tarball 装进一个一次性临时项目并断言 `import("erix-agent")`/`import("erix-agent/tools")` → 用**装好的包**跑随包契约套件 → 用 `tsc --strict --skipLibCheck` 编译一个真 TypeScript 宿主（退 0，且未知的 `runToolLoop` option 键**必须**报 `TS2353`）并把编译产物真跑一遍 → 拿本地假上游冒烟装好的 `erix` CLI（`--version` 等于 `package.json`；一次成功的 `chat` 退 **4**，因为不开 `--final-guard` 时核验是 `skipped`；`--session` 不存在退 1）→ CLI 跨 run 续接（`config.continuity.handoff`，issue #598：零 token 两轮 e2e——A 存 / B 召回 / 默认关 / 非法值拒绝）。离线（`npm --offline` + 一次性 cache/userconfig + 假 `HOME`）、跑完自清、约 15 秒 |
| `npm run check:release:real` | **发版前真机清单**（工单 261021-13；写它的直接起因是 0.23.0 在「文档审计没跑 + 四条真上游 e2e 没跑」的状态下发车）：八条按固定顺序串成一条命令——`node --test examples/tool-fact-e2e.test.mjs` → `examples/delegate-real-e2e.test.mjs`（父 run 派生一个子 run，issue #617）→ `examples/normalize-truncation-real-e2e.test.mjs`（归一化兜底的截断判别，issue #637）→ `examples/resume-real-e2e.test.mjs` → `examples/cross-version-real-e2e.test.mjs` → `examples/pi-extension/erix-run-e2e.test.mjs` → `node scripts/cli-real-smoke.mjs` → `examples/fold-default-real-e2e.mjs`（默认压缩策略 `fold-llm` 真机，issue #619）——每条前打 `=== [i/8] <名字> ===`，跑完打该条的 `tests/pass/fail` 与耗时；每条单独 **900 秒**硬超时（超时算红，按**进程组** `SIGKILL` 以免孙进程继续烧钱，然后继续下一条）。任一条红 ⇒ **跑完整张清单后** exit 1，末尾点名是哪几条；全绿 exit 0 并打总耗时。闸门：`ERIX_E2E_REAL=1` 不是 1 时**一步都不跑**、exit 0、打分类原因（与 `examples/e2e-real-gate.mjs` 同一套 `GAP_CODES`），因此永不成为任何默认门禁的硬依赖；但闸门**开着**而配置/凭据/端点不可用 ⇒ exit **1**（发版必跑项被「跳过」冒充「通过」正是 PR #289 阻断 1 的镜像错误）；子进程出现闸门/配置类 skip 也判红（预检与子进程口径打架 = 装置坏了），别的 skip（例：跨版本那条的「旧 CLI 0.22.0 不可用」）不判红但在汇总里点名。本脚本**一个字节也不写**（不建临时目录、不写 `~/.erix`），隔离留在各子命令的消费点 |
| `npm run check:cli-real` | 装后 CLI 打真上游的 gate 冒烟（工单 261015 T5，#284/#285 收尾）：`npm pack` → 把 tarball 装进一次性临时项目 → 用**装好的 `erix`**（不是 `node bin/cli.js`）打真上游跑一个 ≥2 次工具的任务，断言退出码承诺（不开 `--final-guard` 的成功 run 退 **4** = 核验 skipped）、transcript 里 `tool_result` 的字段面、以及装好的包自己的投影。只有 `ERIX_E2E_REAL=1` 才跑；闸门关着时 exit 0 并打出**分类**原因（gate 缺失 / 配置不存在 / JSON 坏了 / 缺字段 / 端点不可达）。模型名从 `slots.default` 读（`ERIX_E2E_CONFIG` 可换路径）。另两条同闸门的套件：`examples/tool-fact-e2e.test.mjs` 与 `examples/pi-extension/erix-run-e2e.test.mjs`（`npm test` 里默认 skip，真上游不是默认门禁的硬依赖）。需要 `node_modules`；自清理，不写真实 `~/.npmrc` 与 `~/.erix/config.json` |
| `npm run check:docs-spelling` | 活文档里**退役扁平选项拼写**的**阻塞门禁**（issue #560；脚本本身是 #523 的 `scripts/retired-spelling-scan.mjs --strict`）：退役集从 `CONFIG_SURFACE_OPTION_NAMES` 减去 `RUN_TOOL_LOOP_OPTION_NAMES` 派生（从不拄清单），只在**代码语境**里算命中（围栏与行内 span；`config: { … }` 子树按叶子名跳过；`AMBIGUOUS_KEYS` 里那些「同时是别的东西的名字」不进判据），且面上每一份**入库的**文档——`docs/**/*.md` 加两份根 README（issue #572）——都**按路径**分类：现状描述（`architecture*`、`charts*`、`requirements*`、`testing*`、`maintenance-policy*`、`soak.md`）必须写成当前 API；历史记录（`decisions/*`、`v0.*`、`design/*`、`research/*`、`harness-comparison/*`、`suggestions/*`、`issue-469-*`、`tasks/*`、`host-upgrade-guide-*`）、契约（`host-consumer-contract*`）与根文档（`README.md`、`README_cn.md`，即「根文档」这一档，issue #572）正文一字不改，靠**命中数钉子**看守（根文档的钉子在 `ROOT_DOC_BODY_PINS`；`SUSPECT(dropped)` = 有人把历史改写成规位形态、`SUSPECT(raised)` = 往历史里补了扁平拼写、`UNPINNED` = 历史/契约/根文档类有命中却没登记钉子；钉子只许点名**入库**文件——指向清单外路径的钉子算 `DEAD-PIN`，同样红）。**文件清单只取 `git ls-files`**（issue #560）：扫描面是**入库的** `docs/**/*.md` 加两份入库的根 README（issue #572——**显式** pathspec 清单 `SCAN_PATHSPECS`，绝不是 `.`，所以面不会偷偷变成整个仓库），绝不走文件系统遍历——因为 `docs/tasks/` 与 `docs/delivery/` 是被 gitignore 的本地档案，走盘会让同一份仓库内容在开发树 `--strict` exit 1、在干净克隆 exit 0（CI 跑的是克隆，那批红永远见不到）。`git` 不可用 / 不在仓库内 / 仓库顶层不是本脚本所在目录 / 清单为空 ⇒ 扫描器**显式报错 exit 2**，**绝不**退回文件系统遍历（静默退回等于把「两个答案」留在原地，只是更难发现）。**哪份清单都不在的 `docs/**.md` 按现状类照扫**——「这张单没管到」那一类已经删了，未知分类不是免检。`check:docs` 完全不读选项拼写形态，所以这是紧跟 `check:docs:strict` 的独立阻塞步；`node scripts/retired-spelling-scan.mjs --self-test` 是这道门自己的反向证（阻塞，22 例；它拿**入库面的副本**当真扫描对象、在副本上造红——其中三例是 issue #572 扩面的反向证：往 `README.md` 里塞一句扁平拼写 ⇒ `--strict` 与 `--strict --json` 都红、还原 ⇒ 两路都绿；根文档的钉子对不上 ⇒ `SUSPECT(dropped)`；根文档的钉子指向清单外 ⇒ `DEAD-PIN`）。`--strict --json` 是**同一道门**的机器读法（issue #575）：红集合（`gateVerdicts()`）与「红数 → 退出码」（`gateExitCode()`）各只有一份，两条输出分支都只读它们，所以 `--strict --json` 在有红的面子上与文本分支一样答 exit 1，且 JSON 里带 `gate.{strict,gating,mode,red,counts,exitCode,wouldExitCode}` —— #575 之前 `--json` 分支无条件 `process.exitCode = 0`，任何机器消费者都把红读成绿。报告模式（`--json` 不带 `--strict`）仍是 exit 0，但照样报出同一个红数并标 `gating: false` |


跨版本套件（`examples/cross-version-real-e2e.test.mjs`）的老账本读**仓内夹具** `test/fixtures/journal-0.22.0/`——它是 `erix-agent@0.22.0` 的真实 CLI 产物（4 行、2 次 `readFile`，另含 state/status/snapshot）。**只读夹具，不许就地重生成**（重生成会改掉字节，而这个用例的意义正是「字节就是 0.22.0 当时写的」）。只有续跑那半需要真上游，所以闸门关时它仍跑离线那半（2 pass / 0 skip），不再整条 skip。
| `npm run types:build` | 把随包发布的 `.d.ts` 生成到 `src/**/*.d.ts` 并保留（issue #213；`prepack` 钩子跑的是同一个脚本） |
| `npm run check:types-build` | 断言式门禁：`tsc` exit 0 / 声明文件数 > 0 / `src/index.d.ts` 含 `runToolLoop` / `src/tools/index.d.ts` 含 `createFileTools`，跑完删掉生成物（issue #213；需要先 `npm install --include=dev`） |
| `npm run check:types` | `--checkJs` **棘轮**：统计从 `src/index.js` 可达的类型错误总数，超过 `scripts/type-check-ratchet.mjs` 里写死的基线常量 **108** 就失败（issue #214；棘轮 = 只减不增，低于基线仍通过并提示「可下调至 N」；每次下调都**两档一起复测**——2026-10-31 同日两笔：先 **116 → 110** 与 **152 → 146**（各降 6，issue #630 S2），后 **110 → 108** 与 **146 → 144**（各降 2，全在 `src/loop/orchestrator.js` 14 → 12，是 #473/#435 那次合并的副产物；改前对照树 `3ee458d` / `af2d54e` / `81541c5` 同一条命令都读 110 / orchestrator 14）；再上一轮 2026-10-23 两档各降 1：117 → 116 与 153 → 152）。**跑之前先删掉生成的 `src/**/*.d.ts`**——见下面「`--checkJs` 棘轮规则」。加 `-- --with-tools` 可把范围扩到 `./tools` 入口（基线 **144** / 29 个文件） |
| `npm run check:mutation` | **常驻变异样本表校验**（issue #257 T7）：`node scripts/mutation-sample-check.mjs --verify test/mutation-samples.md` 把表里三个**派生列**——锚点行号、锚点 sha256 前缀、命中数——连同合计行，全部从**真树**重算再与入库数字对账；任何不一致都 exit 1 并点名到行。这张表是各刀**手工做过、验完就丢**的那些变异的常驻形态（`state-view` 的活引用 / `getOnly` / 字段面，`state-view` **接线侧**的字段清单（`src/loop/orchestrator.js` 的 `runSnapshotContext`），`result.messages` 的数组身份，provider 的 `retryable` 映射与 4xx → `code` 分类，abort 分类，`sessionScanPrefix` 哈希式）；它**故意不去重复** `--self-test` 家族已经钉住的那批（文档锚点、打包链接、退役拼写、测试卫生、导出消费者），所以它是五个行为面，而不是原文设想的通用 6–10 条样本表。**`--sync` 是改派生列唯一合法的姿势——手改数字就是造假**（`node scripts/mutation-sample-check.mjs --sync test/mutation-samples.md`）。不靠手改也会红的：锚点已死、锚点在该文件里不唯一、捕获者文件没了、变异与锚点逐字相同、期望红签名短于四个字符、以及表掉到样本数下限以下。实测 0.1 秒，所以在 CI 里是阻塞步骤 `Mutation sample table verify`，紧跟 `Compatibility-pin inventory verify`（同一族：入库的表必须与真树对得上） |
| `npm run check:mutation:run` | **这些样本真的会被闸咬住**（issue #257 T7）：`node scripts/mutation-sample-check.mjs --run test/mutation-samples.md` 逐条把变异写进真文件、用 `node --test` 跑该条的捕获者，要求**非 0 退出、且 `not ok N - …` 那一行里含该条的期望红签名**——通过的 `ok N -` 行不算，红在别的断言上也不算，因为「非 0 退出」本身也是语法错 / 模块找不到 / 基线本来红会给出的东西。然后还原文件并要求**绿**：这才把红归因给变异，而不是归因给这棵树。**变异没落地 = 失败，不是通过**（#210 R2 的口径：替换会原样返回，判据会因此恒真）。还原结果逐字节核对，并挂了 `SIGINT`/`SIGTERM` 还原钩子；它是整条 CI 里**唯一**会改写 tracked 源文件的步骤，所以排在**最后**。8 条 ×（变异后 + 还原后）= 16 次单文件运行，实测 **4.5 秒** |
| `npm run check:exports` | 导出消费者清点（issue #406 裁定③；也服务 #419③ 那类「import 了却没人调」；计数口径在 #429 修过）：`scripts/export-consumer-check.mjs` 的入口清单从 `package.json` 的 `exports` **现读**（不再另抄一份），所以**三个**公共入口都进清点（`.` → `src/index.js`、`./tools` → `src/tools/index.js`、`./contract-tests` → `test/contract/index.js`）；每个导出名按「谁在真消费」分档：**包内消费者**（`src/`、`bin/`）、**发布面消费者**（`examples/`、`test/contract/`——`test/contract` 在 `files` 里随包发布、宿主安装后自己跑，那里的命中是真消费）、**暴露面**（`test/contract/` 之外的 `test/`、`docs/`、`scripts/`，单列成自身测试数 / 文档提及数 / 脚本提及数，**刻意不算消费者**）。名字在自己定义文件内、除声明那一处之外还被引用 ⇒ 单列成 **internal-only**——那不是死导出（该做的是去掉 `export`，不是删符号），不进候选清单。所以「可删候选」要求**包内与发布面两档都零命中、且本文件内零自用**；今天实测 154 个导出名：可删候选 17 个、internal-only 23 个、发布面消费者 12 个。输出按档一张表 + 口径说明 + 逐字复现命令；`--json` 给机器读同一份事实（`candidates` / `publishConsumers` / `internalOnly` / `tiers`）。**只是清点，不判定、不挂门禁**：零消费者不是错误（exit 0），也不删任何导出（删除要等宿主迁移 + 版本边界，是另一张票）；只有「读不出真值」才红（exit 2）——`package.json` 或它的 `exports` 读不出、入口读不到、扫描面目录 / 文件读不出、导出名解析不出来、遇到它明确不展开的 `export *` / 非名单式导出、定义文件不存在、或者定义文件在但里面找不到这个符号。`--self-test` 钉着反向证：删掉一个真消费者 ⇒ 候选 +1、加回来 ⇒ 回到原值，有状态 `g` 正则会漏报，花括号里的注释会被当成名字，`export *` 会被点名而不是静默漏；修过的每条口径各有一条三态反向证（第三个入口、发布面档、internal-only 档、扫描面目录读不出、定义文件里没这个符号）。刻意**没有**挂进 `.github/workflows/ci.yml`——先让人看几轮再谈进不进 |
| `npm run check:exports:deprecated` | **#429 的判据**（它兑现的决策：零消费者导出**只登记 + 标 `@deprecated`**，删除并入 0.30 破坏包；本命令不删任何东西，`check:exports` 也照旧只是清点）：把「公共入口导出名的定义文件里带 `issue #429: removed in 0.30 …` 的登记」与「`check:exports` **现算**的候选清单」对账（`computeInventory()` 是 **import 进来的**，不抄第二份名单——抄一份就是 #429 修掉的那条漂移路径）。红（exit 1，逐条点名 `符号 @ 文件:行`）有六个码：**R1** 零消费者候选没有登记；**R2** **有消费者**的名字（包内 / 发布面 / internal-only——最后一种的处置是去掉 `export`，不是标删除）带了 0.30 标记；**R3** 删除版本不是 `0.30`；**R4** 没写迁移目标（`` migrate to `X` `` 且 `X` 必须真的在树里声明过，或字面量 `no in-tree replacement`）；**R5** 标记块**不是紧贴声明那一个** doc 块（#213 R4 那个 tsc 会静默丢掉的形状）；**R6** 有标记却认不出它贴的是哪个声明（**不许静默跳过**）。读不出真值 ⇒ exit 2：清点本身不完整，或 `--types` 找不到生成的 `.d.ts`。`--types` 读 `npm run types:build` 的生成物，要求标记**活着进** `src/**/*.d.ts`——别名 const（`export const a = f;`）必须写显式 `@type {typeof f}`，否则 tsc 会把被别名函数的 doc 连注释一起复制过来、新标记静默消失（实测：不写 `@type` 时 `src/reflection/l0.js` 那四个标记在 `src/reflection/l0.d.ts` 里一个都没有）；`test/contract/*.js` 不在声明图里（`exports["./contract-tests"]` 没有 `types` 键），这些名字**带理由列成跳过**，不是静默通过。`--self-test` 在**真树内存副本**上有 11 条反向证（不写盘）：基线绿、删掉一条登记 ⇒ R1 点名 ⇒ 还原 ⇒ 绿、**给一个有消费者的符号也标上 ⇒ R2 点名**（本票 ④ 的反向证：删掉别处的消费者不会让候选数变化，只有这条规则拦得住）、版本写错 ⇒ R3、迁移目标被抹掉 / 指到不存在的符号 ⇒ R4、块与声明之间插一个空行 ⇒ R5、internal-only 被标删除 ⇒ R2，变异没落上一律算失败。**边界：它只证仓内零消费者**——宿主仓（touwaka / app_container / erix-station / pi）不在扫描面里，删除前仍须另核宿主，所以「删除」这件事留在 #429 里没关 |
| `npm run check:inventory` | 兼容钉子清点表校验（issue #534）：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` 从被扫测试文件的 AST **重新推导**扁平钉子的数量，再与入库的那张表对账——任何不一致都 exit 1，并且点名是哪个文件、两个数字各是多少。实测 **1.8 秒 / ~150 MB**，所以在 CI 里是**阻塞**步骤 `Compatibility-pin inventory verify`，位置在 `Test suite` 之后、`Test hygiene guard` 之前（这张表清点的是测试文件，测试还没跑就验它没意义）。同一个脚本的 **`--sync`** 模式是改那张表**唯一合法**的姿势——**手改数字就是造假**——所以**任何动到兼容钉子的切片都必须同片重跑 `--sync`**：`node scripts/flat-count-inventory.mjs . --sync test/compat-pin-inventory.md`（`--verify` 同理要带表路径）。**少了表路径会崩**：脚本用 `process.argv[4]` 当表路径，只写 `node scripts/flat-count-inventory.mjs . --sync` 就是 `readFileSync(undefined)` 的 `ERR_INVALID_ARG_TYPE`，不是「什么都不做」。开单理由：那张表自称“逐行零误差”，而 A12 交上来时带着 3 处不一致，全靠主 agent 手跑 `--verify` 才抓到。生成器自 #529 起就住在仓库里；在那之前文档里写的复跑命令指向一个 `/tmp` 副本，那正是下一片 worker 根本刷不动这张表的原因 |
| `npm run check:config-leaf-values` | 配置叶子值类型现状表校验（issue #586）：`node scripts/config-leaf-value-probe.mjs --verify docs/config-leaf-value-status.md docs/config-leaf-value-status_cn.md` 重跑探针（每个 schema 叶子 × 8 个固定错值，每一格都过一次真的两轮 `runToolLoop`），再把重算出来的中英两张表与入库的那两张对账——任何漂移都 exit 1 并点名文件。探针**实测**每一格的结局，而不是断言愿望：`G` / `V` 在 `config` 闸口 / 语义相被拒，`S` 在 run 启动期被拒**且判词点名该叶子**，`C` 在启动期炸但**不点名**，`U` 到第一发请求之后才抛，`A` 是被接受且**真的生效**（run 的指纹变了），`·` 是被接受但**无差异**（指纹逐字相同）。「拒在哪一层」取自**栈帧**（文件名 + 函数名，从不取行号 ⇒ 无关重构撞不红它），「生效在哪」取自指纹的**第一个差异路径**，所以「悄悄接受」是一个位置加一对值，不是形容词。`--sync` 是刷这张表**唯一合法**的姿势（手改数字就是造假）；`configSchemaSelfCheck` 红、或三次基线跑的指纹不一致时，探针**拒绝出表**（`exit 2`）——指纹不稳会把 `A` / `·` 变成噪声。实测 **约 0.8 秒**，所以在 CI 里是**阻塞**步骤 `Config-leaf value status verify`，紧跟 `Compatibility-pin inventory verify`。**它一个字都没收窄接受面**：每条类型校验都是收窄 ⇒ 要记 Breaking，裁定权留在维护者手里 |
| `npm run check:types:strict` | **只观测、不判定**（issue #416）：用与 `npm run check:types` **同一条** `tsc` 命令再追加 `--strict`（入口、依赖图、`typescript` + `@types/node` 都是同一对）跑一遍，打印总数 + 按文件 + 按错误码的分布，头部带口径说明与逐字复现命令。**观测到的数不影响退出码**——不管它多大；非 0 只代表**脚本自己**跑不成（tsc 缺失 / tsc 非 0 退出却零解析 / `src/**/*.d.ts` 生成物在场，被共用的陈旧声明守卫拦下而不是报一个假的 0；实测：`npm run types:build` 之后跑本命令 **exit 1**）——所以 CI 那一步带 `continue-on-error: true`。**棘轮量的那个数是「非 strict」那一档**：卡门禁的仍是 `npm run check:types`；这一行存在的意义只是让 strict 那笔债每次都出现在日志里、不再看不见。strict 总数**不是门禁、不钉、会漂**（快照 2026-10-23：#416 分支上 **1690 个错 / 65 个文件**，同一天集成树上 **1687 / 65**——两个都是真值，差的是树）：命令输出是唯一真值，不同步这些字面量、也不在任何地方断言具体数字。加 `-- --with-tools` 覆盖 `./tools` 入口，加 `-- --verbose` 出完整分布 |
| `node bin/cli.js ...` | 本地运行 CLI（无需安装） |

- CI（issue #187）：`.github/workflows/ci.yml` 在 `pull_request`、`push` 到 `main`、以及 `workflow_dispatch`（手工重跑入口；注意 `POST …/dispatches` 在 GitHub **第一次见过**这份 workflow 之前一直返 **404**，推上分支 + 跑过任意一次就注册好了，之后 dispatch 返 204）三种触发下跑，矩阵是 **node 22**、`fail-fast: false` —— 22 既是 `engines` 声明的最低版本，**也是宿主实际在跑的那个**，所以门禁验证的是用户真在用的运行时，不是没人部署的更新版本。装依赖用的是 `npm install --include=dev`，**绝不是** `npm ci`——本仓故意把 `package-lock.json` 整份 gitignore（见 `.gitignore` 里「npm lockfile 不入库」那条注释），而那两个 dev 包（`typescript` + `@types/node`，issue #213）正是 `check:types` / `check:types-build` / `check:pack-links` / `check:release` 能跑起来的前提。按顺序**阻塞**的步骤：`check:syntax` → `test` → `check:docs` → `check:docs:strict`（今天它就是绿的 ⇒ 直接阻塞，issue #187 提案里的 `continue-on-error` 在落地前已作废）→ `check:docs-spelling`（issue #560：退役扁平拼写硬门，`scripts/retired-spelling-scan.mjs --strict`）→ `node scripts/retired-spelling-scan.mjs --self-test` → `check:docs-examples` → `check:pack-links` → `node scripts/pack-link-check.mjs --self-test` → `check:inventory`（issue #534：从 AST 重新推导兼容钉子清点表并与入库数字对账；实测 1.8 秒，所以它阻塞）→ `check:config-leaf-values`（issue #586：重跑配置叶子值类型探针、把重算出来的中英两张现状表与入库的比对；`npm run` 实测约 1 秒，所以它阻塞）→ `check:mutation`（issue #257 T7：从真树重算变异样本表的派生列与合计行——手改数字就红；它挨着 `check:inventory`，因为两条都是「入库的表必须与真树对得上」）→ `mutation-sample-check --self-test`（同一套判据跑在内存夹具上：手改行号 / sha / 合计行红，锚点死了 / 锚点重复 / 捕获者没了 / 空变异 / 签名被削弱红，删掉一条样本**即使再 `--sync` 把合计刷对**也红在样本数下限，`--sync` 动了手写列红，变异没落地也红——#210 R2 的口径）→ `check:exports:deprecated`（issue #429：把 `check:exports` 现算的零消费者候选清单与源码里的 `@deprecated` 登记对账——候选没登记、**有消费者**的名字被标 0.30 删除、版本不是 0.30、没写迁移目标、标记块不是紧贴声明那一个，逐条红并点名 `符号 @ 文件:行`）→ `deprecated-export-check --self-test`（真树内存副本上的 11 条反向证，含本票要的那一条：给有消费者的符号也标上 ⇒ 红并点名）→ `check:tests` → `test-hygiene-check --self-test` → `check:types` → `check:types-build` → `check:cli-real`（CI 里 `ERIX_E2E_REAL` 闸门是关着的 ⇒ 它 exit 0 并打分类原因：它自证的是这套自检装置本身没坏，不是真上游可用的信号）→ `if: matrix.node == 22` 的 `check:release`（离线且自清；今天矩阵只有一格 ⇒ 条件恒真，留着是给以后再加一个 node 版本时当护栏）→ `docs-drift-check --self-test` → `check:mutation:run`（issue #257 T7：逐条变异 → 捕获者必须红在点名的断言上 → 还原 → 绿；排在**最后**是因为它是唯一会改写 tracked 源文件的步骤，也因为它跑的是单个测试文件，前面那套测试必须已经绿了，「变异后的红」才可归因；实测 4.5 秒）。有一步是故意**不阻塞**的：issue #416 的 strict 观测点（`npm run check:types:strict`）带 `continue-on-error: true`——它打印的数从不参与任何判定，但脚本自己在环境不干净时（残留 `src/**/*.d.ts`）仍可能 exit 1，所以「只观测」是由那个 flag 兑现的，不是靠命令自己的退出码。`node scripts/test-hygiene-check.mjs --self-test` 是卫生守卫自己的反向证，自 issue #374 起**阻塞**：同一张规则表跑在**内存里的假文件集合**上（不落盘、不碰 `test/`）——`mkdtempSync(...)` / `mkdtemp(...)` / `fs.mkdtemp(...)` 各必须红、`makeTmp(...)` 必须绿、`test-hygiene-exempt: <理由>` 绿而缺理由的写法红且点名行号、`test/helpers/tmp.js` 自身不计数，变异没落上也算失败（#210 R2 的口径）。它刻意与 `check:tests` 分成两个 CI 步骤：`check:tests` 证的是「今天的 `test/` 干净」，这条证的是「规则表还拦得住」——改坏规则表时前者照样绿（实测：把 `bare-mkdtemp` 的 `Sync` 变体删掉 ⇒ `check:tests` 仍 exit 0，这一步 3 例红）。`npm run soak` 需要真实 relay 配置与 key ⇒ **绝不进**默认 CI。`node scripts/docs-drift-check.mjs --self-test` 自 issue #302 起是**阻塞**项：它的期望集合与「被 gitignore 的 `docs/tasks/` 目录在不在」彻底解耦——`#280` 那两条树形用例现在跑在**合成树夹具**上（无档案目录 / 空档案目录 / 有档案目录，三种形状各跑一遍），落地检查比对的是夹具声明的档案清单，而不是这台机器上的真实实物数。在三棵 `git archive HEAD | tar -x` 造出来的树上实测：**103 例、三种树形全部 0 红**——issue #281 在管的那批干净克隆红数（预期红 3 例、树里有个空 `docs/tasks/` 时 5 例）**已经不存在**，所以那个年代的 `continue-on-error: true` 已摘掉转阻塞。仍然会红、且本来就该红的两种形状都不是回归：**在 `.gitignore` 里新增一条目录规则却没在 `IGNORED_DIR_CLASSES` 里登记类别**（检查器会点名那条规则本身：`.gitignore:N 的目录规则 … 没在 IGNORED_DIR_CLASSES 里分类`），以及自 #302 起的**反向**——`IGNORED_DIR_CLASSES` 里有类别、而 `.gitignore` 里已经没有对应规则（空转条目；`test/static-guards.test.js` 双向看守这一对，那条 `build-output` 死条目（dist 目录：`.gitignore` 里从来没有过它的规则）就是这么被找出来删掉的）。`docs/delivery/` 因此既像 `docs/tasks/` 一样登记类别，也保持不入库，**交付证据的持久落点是 PR/issue 评论，不是仓库树**。 Gitea 只是代码镜像：那边**不建** Actions，GitHub 仍是唯一执行方。
- 门禁可复现口径（issue #280）：`npm run check:docs` 与 `npm run check:docs:strict` 在开发工作树里和在全新 clone 里（`git archive HEAD | tar -x -C <空目录>` 解出来的那棵树）必须同样 exit 0。「本机档案」这一类——`docs/tasks/` 下的文件，该目录被 `.gitignore` 整目录忽略、故意不入库，因此任何 clone 里都不存在——按**声明**裁决（`LOCAL_ARCHIVE_REFS` 逐条登记，或引用就地写明「本机 / 不入库 / 归档」），实物只在那个目录恰好在场时顺便核实，核不到不得把门禁判红。真正有本机前置的是 `npm run check:pack-links` 与 `npm run check:release` 两张：它们需要 `node_modules`（要调 `tsc` / `npm pack`）。
- 测试隔离规则：涉及 `~/.erix` 或 `~/.pi` 的测试必须注入 `home`/`cwd` 参数（skills/mcp/config 测试提供了先例），以免污染真实用户配置。
- 类型面规则（issue #213）：`src/**/*.d.ts` 是**生成物、永不入库**（`.gitignore` 已覆盖）；`files` 里本来就有 `src`，
  所以 tarball 里有声明而仓库里没有。`prepack` 钩子在 `npm pack`/`npm publish` 前重新生成它们，且**只能往 stderr 打日志**——
  lifecycle 脚本继承 npm 的 stdout，而 `scripts/pack-link-check.mjs` 要把 `npm pack --dry-run --json` 当纯 JSON 解析。
  两种 JSDoc 形状会**静默**把参数退化成 `any`（编译一个错都不报，只有读生成的 `.d.ts` 才看得见；#213 R4 两处都已修）：
  **内联 `@param {{ … }}` 类型字面量里独占一行的 `//` 注释**，以及**没有紧贴被文档化声明的文档块**。
  宿主可见签名要紧的时候，去读生成的 `.d.ts`，而不是源码里的注释。
- 文档规则（issue #164）：改 `README*.md`、`docs/requirements*.md`、任何默认值或 `files`/`exports` 清单时，必须保证 `npm run check:docs` 绿。该检查直接从 `package.json` 与 `src/` 取真值，因此文档无法静默漂移；「当前版本」声明的规范写法写在 `scripts/docs-drift-check.mjs` 顶部注释里。中英文文档成对同步（见 `AGENTS_cn.md` 对应小节）。
- 引用**另一个仓库**的文件时（工单 261021-03 B1）：写成 `<仓名>:<那个仓里的路径>`——例如 `touwaka:lib/agent/`、`pi-subagents:src/runs/background/async-execution.js:4`。带前缀的引用**不查本仓存在性**，它的行号也**不计入**下面的裸行号棘轮；但仓名必须是 `scripts/docs-drift-check.mjs` 里 `EXTERNAL_REPO_PREFIXES` 登记过的那几个（清单外的仓名红，登记了却没人用的仓名也红）。**不带前缀的路径就是本仓路径，必须能在本仓解到**——前缀的作用是声明归属，不是发一张免检票。
- 锚点粒度（issue #210）：**不要默认「文档里删一处提及就会红」**——多数锚点是*存在性*级的（`defaults` 全组、`modulemap`、`paths`：它们只问「那个文件里有没有这个字符串」，所以从同一句里删掉一处额外提及仍然绿）。只有这些是*逐处*级的（每个声明点单独比对，缺 / 多 / 改名都红）：`version` 的当前版本声明、README 的 `files`/`exports` 围栏（与 `package.json` **双向对称**比对——文档里改名或删键也会红，不只是多写才红），以及清单/枚举/单位类锚点（文件工具清单、CLI 工具清单、vendor 跳过目录、`formatSize` 的单位档位与每一条 `` `字节数` → `可读值` `` 示例映射、内置压缩策略名），以及 `cli-flags` 锚点（issue #391 R4：`erix chat` / `erix repl` 两条 usage 行的旗标集合与 `bin/cli.js` 帮助文本**双向逐处**对账——帮助里加了旗标而 README 忘了写是红，README 凭空多写一个也是红；`-c|--continue`、`--no-final-guard` 这类别名一律计入；放行表 `CLI_FLAG_EXEMPTIONS` 必须空着或逐条写明理由，条目空转本身即红）。这些锚点还会对账**中英两侧的声明点处数**，接住「把某一侧的整句声明删掉」这一类。每条逐处锚点的反向证都固化在 `node scripts/docs-drift-check.mjs --self-test` 里；改了 `scripts/docs-drift-check.mjs` 就要跑一次。每个锚点属于哪一级、以及剩下那些为何**没**升级，写在脚本头部注释里。
- 文档行号锚点（issue #286，第一批 T-a）：文档不得依赖**裸行号**。`paths` 过去在解析引用时会把 `:1234` 剥掉，
  于是只校到「文件在不在」——行号漂到别的函数、甚至漂出文件末尾都照样绿（契约曾把 `src/store/notes.js` 的 limit
  校验指到第 398 行，而那个文件只有 383 行）。现在三条锚点钉住这件事，三条都接进了 `--self-test`：
  *`symbol-anchor`* 是**逐处**级的：每一处 `` `符号`（`路径`） `` 或 `[符号](路径)` 形式的引用，都必须在**那个文件里**
  抽到该符号的真实声明（`function` / `class` / `const|let|var` 绑定 / 解构 / 再导出 / 方法 / 对象键 / `process.env.X`）。
  抽取只认**代码面**：注释与字符串字面量先被涂成空格，只活在注释里或引号里的名字**不算**声明（issue #299——
  修之前，块注释里写一行 `const X = 1;` 就能「证明」X 已声明，注释里一句带引号的名字还能喂进弱档）。
  找不到符号就红，报错会点名该文件里**实际存在的相近符号**；一个文件里连一条声明都抽不到同样算红（#164 口径：
  抽不到真值不许静默放行）。**字符串值**（终止原因、provider 错误码）是唯一弱一档的形态，只在
  `scripts/docs-drift-check.mjs` 的 `SYMBOL_VALUE_MEMBERSHIP` 里逐份点名并写明理由的那 4 个文件里被接受。 裸行号棘轮的唯一键是 (文档, 目标文件, 行区间)，**不含文档自己的行号**——于是把
  `` `符号`（`路径:1517-1531`） `` 改写成不带括号/链接的裸 `路径:1517-1531`，棘轮那个数一字不变，而符号校验整条消失。
  因此 `symbols` 自带一条**只增不减的下限** `SYMBOL_ANCHOR_MIN_UNIQUE = 180`（**现值** **180 组** / **546 处**——issue #637 的契约中英成对段落「截断自成一档」引 `stopReasonOf`（`src/normalization/parse-model-json.js`）⇒ +1 组 / +5 处；此前 **179 组** / **541 处**，来自 issue #617 P2 的 0.28.0 升级指南中英成对小节「CLI 的 `delegate` 是示例，不是契约」引 `createDelegateTool` / `TERMINATION_TO_STATE`（`src/tools/delegation/tool.js`）、`writeRecord`（`src/tools/delegation/roster.js`）与 `createCliDelegation`（`bin/delegation.js`）⇒ +2 组 / +3 处：同一次切版前文档的 A2 片（issue #578，#588 / #589）往观察者事件表加了两行加法事件、给续接块那节加了两条结构性规则，引 `pendingTailToolUses`（`src/loop/pending-tool-result.js`）、`roundHoldsContinuityBlock`、`selectFoldedRounds`、`isProtectedMessage`（都在 `src/compact/helpers.js`）、`summarizeFoldedPayload`（`src/compact/fold-statistical.js`）、`ensureUserTurnView`（`src/loop/request-user-view.js`）⇒ 在 A 片之上 **+4 组 / +5 处**；A 片（#569 / #568 契约小节）把 158 抬到 164、+6 组 / +24 处，基线是把两份契约退回备份在同一棵树量的 158 组 / 492 处（这句话原先写的 489 自己就过期了 3 处）。⚠ **这句话自己也在锚点覆盖面里**：它带的 `(path)` 锚点把 `AGENTS.md` 抬了 20 → 25 组、`AGENTS_cn.md` 抬了 43 → 47 组，所以地板**必须在改完 AGENTS 之后**重测——先量后写会拿到偏低的数（163 就是这么来的），而那两条 `--self-test` 的判据就是「实测 == 地板」，偏低必红；此前 **158 组** / **489 处**：#571 片1 的 `createAgent` 契约小节中英成对落地，引 `createAgent`（`src/loop/orchestrator.js`）与 `CONFIG_LEAF_BINDING`、`configSchemaSelfCheck`、`configLeafNamesForBinding`（都在 `src/loop/config-namespace.js`）⇒ +4 组 / +16 处；此前 **154 组** / **473 处**：issue #545 把 `policy` 收成只装数据，「构造期有值 + 调用期又给」的活样本从 `policy.todoStateProvider` 换成端口派生键，中英契约因此各多引 `assertAssemblyOverrideConflicts`（`src/assembly.js`）⇒ +1 组 / +1 处，在合入 main `66a362f` 之后的树上实测；此前 **153 组 / 452 处**：issue #498 S4c 相对基点 `cdf0f6d` 的 **151 组 / 444 处**是 **+2 组 / +8 处**——契约中英成对改动新增的 `#### capabilities.ports（issue #498 S4c）` 小节把「9 个没有扁平别名的叶子」的去向表 `CAPABILITY_SLOT_DESTINATIONS`（`src/loop/capabilities-namespace.js`）在两种语言里各引两处，并把策略对象原样透传的那个函数 `resolveCompactionStrategy`（`src/compact/strategy-resolution.js`）各引一处（+2 组 / +6 处），本句自己也把这两组各引一处（+2 处），在本分支树上 `--verbose` 实测；此前 **151 组** / **444 处**：issue #498 S4b 的契约中英成对改动 +1 组 / +6 处——`config` 一节新增 `CONFIG_LEAF_ALIAS_PATHS`（`src/loop/config-namespace.js`）这条「唯一登记在案的叶子别名」锚点，另加 `normalizeDeliverables`（`src/loop/deliverables.js`）与同一别名符号的若干处重引（`capabilities.checks` 的形状规则明说「不在这里复述」），在本分支树上 `--verbose` 实测；此前 **150 组** / **438 处**：issue #498 S4a 让契约中英各新增成对一节「capabilities 命名空间」，引用新模块 `capabilities-namespace.js` 的三组符号（schema 表、回调名单与派生别名表）⇒ +3 组 / +8 处，在 main `b3ee7f1` 的树上 `--verbose` 实测；此前 **147 组** / **430 处**：第二轮复审把本句里被串行吞掉的 `again to 121` / `again to 122` 两条链项放回降序位置、删掉重复段 ⇒ 组数不变、处数 −2（432 → 430），裸行号一处未增（仍 130 vs 130）；那 147 组 / 432 处本身是 #497 复审的六条必改（R1 判据重写、R4 两个 config 源的逐叶冲突、R6 随包面更正）让契约中英各多引 `resolveAssemblyMember`（`src/assembly.js`）与 `modelMetadataFor`（`src/loop/budget.js`）后在**最终树**上 `--verbose` 实测的（相对 145 组 / 423 处是 +2 组 / +9 处）；此前 **145 组** / **423 处**：issue #497 的契约中英各新增一节（`### The config namespace (issue #497)` / `### config 命名空间（issue #497）`），引用六个符号——`config` 的 schema 与从它派生的别名表 / 配置面名单、schema 自检与能力面名单（都在 `src/loop/config-namespace.js`），以及展开这个命名空间的规范化函数——在合入 main `109a0a3`（#499 之后）的树上重测（+6 组 / +7 处）；此前 **139 组** / **416 处**（issue #499 退役 `context.onFoldSummary`，契约中英与 README 中英声称句各多引一处 `CONTEXT_OPTION_NAMES`（`src/assembly-validators.js`）⇒ +1 组 / +4 处，在 main `109a0a3` 上实测）；此前 **138 组** / **412 处**：issue #496 的契约中英各新增一节（`### Where option validation happens (issue #496)` / `### 选项校验发生在哪里（issue #496）`），引用四个闸口符号 `assertRunToolLoopOptionNames`（`src/loop/option-normalization.js`）、`assertSemanticOptionValues` 与 `collectSemanticOptionProblems`（`src/assembly-validators.js`）、`normalizeDeliverables`（`src/loop/deliverables.js`），在本分支树上 `--verbose` 实测 138 组 / 412 处、裸行号一处未增；此前 **134 组** / **398 处**：0.26.0 的发版收尾新增的 `docs/host-upgrade-guide-0.26.0.md` 与 `docs/host-upgrade-guide-0.26.0_cn.md` 中英成对，各自把两个符号与各自的文件写进同一处锚点 ⇒ 新增 `buildFoldedFacts`（`src/compact/fold-summary-journal.js`，折叠替代物的构造器）与 `planFoldedHistoryTrim`（`src/compact/resume-fold-trim.js`，续跑按水位线裁剪的规划器）两组（+2 组 / +8 处），在本分支树上重测）；此前 **132 组** / **390 处**（#467 把强制收尾接进 `judge_done`，契约「终局」小节中英各新增一段，新增正文把两个符号与各自文件写进同一处锚点 ⇒ 新增 `hasFinalDraft`（`src/loop/termination.js`）与 `appendEngineMessagesToTranscript`（`src/loop/orchestrator.js`）两组（EN +2 处 / CN +1 处），在合入 `main` `f489398e` 之后的树上重测）；此前 **130 组** / **387 处**（
  issue #433 fix 1（CLI 判死后从账本续跑）的契约中英成对小节用符号锚点引用 `IDLE_RETRY_BASE_DELAY_MS`（`bin/idle.js`，退避起点）并把既有的 `restoreResume`（`src/loop/resume-manager.js`）各多引一处 ⇒ **+1 组 / +4 处**，在 `main` `cf280d7` 之上重测）；
  此前 129 组 / 380 处：issue #440（CLI idle 判死保留引擎终局载荷）的契约中英成对小节用符号锚点引用 `idleTimeoutFailure` / `IDLE_TIMEOUT_CODE`（`bin/idle.js`）与 `annotateTermination`（`src/loop/termination.js`）⇒ **+3 组**，在合流 `main` 之后的树上重测；该单支上测得的 128 组 / 391 处按历史值留着，不当现值；
  此前 PR #451（issue #406 B2-b）合并前的评审必修项把契约中英里指向 end-turn 收尾块的两处裸行号换成符号锚点 `normalizeWrapupText`（`src/reflection/wrapup.js`），中英各一处 ⇒ **+1 组**，在合并 `main` `7d0e9dd` 之后的树上重测 **126 组** / **389 处**，下限随之抬到 126；
  此前 PR #443 的归一化底座与 main 上的 #438 逐轮分账、#434 install 档合流之后在**合并后的树**上重测 **125 组** / **385 处**——下限不许取两支的最大值，合并树上同时挂着两支的锚点；
  此前 PR #443 合并前评审的必修项让契约中英「可选调用的成本」一节落地之后实测 **123 组** / **355 处**（+1 组 / +5 处：新锚点 `DEFAULT_PROVIDER_TIMEOUT_MS`（`src/config/slot-provider.js`）在契约中英各一处 + 本文件声称句一处，既有锚点 `jsonCandidates` 随候选一段的改写在中英契约各多一处；契约 EN 99 → 101 / CN 94 → 96），下限随之抬到 123；
  此前 issue #406 B2-a 的 `normalizeModelJson` 契约中英成对一节之后实测 **122 组** / **350 处**（+2 组 / +9 处：`normalizeModelJson`（`src/normalization/parse-model-json.js`）、`createProviderForSlot`（`src/config/slot-provider.js`）；契约 EN 94 → 99 / CN 90 → 94），下限随之抬到 122；
  此前 issue #438 的逐轮用量分账（续写覆盖 `response` ⇒ 轮档案只记最后一发）落成契约中英成对的一节之后实测 **121 组** / **344 处**（+1 组 / +4 处：`addUsage`（`src/loop/orchestrator.js`），分桶的唯一记账点，契约中英各一处；契约 EN 96 / CN 92），下限随之抬到 121；
  此前 issue #430 的「分片锚点钉在首片」——同一崩溃轮的结果无论几条都折回**一条**聚合 `user` 消息——让契约中英各多一处锚点，指向新的钉住用例（`threeToolCrashScene`，`test/loop-resume-unpersisted-tool-results.test.js` 里的共用崩溃现场）之后实测 **121 组** / **341 处**（+1 组 / +2 处），下限随之抬到 121；
  两支合流后两支的锚点同时在树上（中英 AGENTS 的声称句自己也各多一处锚点：`AGENTS.md` 因合并多出 `threeToolCrashScene`）⇒ 实测 **122 组** / **346 处**（契约 EN 97 / CN 93），下限随之抬到 122；
  此前 issue #424 的「升级路径守卫」让契约中英各多两处既有锚点（`journalResumeUnpersistedToolResults`、`restoreResume`）之后实测 **120 组** / **339 处**（+0 组 / +4 处），下限不变；
  此前 issue #420 把「续跑后账本闭合」从补跑那批扩到**所有**结果之后实测 **120 组** / **335 处**（+1 组：`journalResumeUnpersistedToolResults`（`src/loop/orchestrator.js`），契约中英各一处 + 本文件声称句一处；契约 EN 92 / CN 88），下限随之抬到 120；
  此前 issue #409 的「工具引数解析失败 ⇒ 不执行该工具 + 把解析器原判词作为 `is_error` 的 `tool_result` 退给模型」落成契约中英成对的一节之后实测 **119 组** / **327 处**（+5 组，各中英两处：`REPAIR_RULES` 与 `parseJsonWithRepair`（`src/text/repair-json.js`）、`parseToolArguments` 与 `describeToolArgumentsParseError`（`src/messages/tool-arguments.js`）、`RUN_TOOL_LOOP_OPTION_NAMES`（`src/loop/option-normalization.js`）；契约 EN 85 → 90 / CN 81 → 86），下限随之抬到 119；
  此前 issue #407 的流式思考别名（只认 `delta.reasoning_content` ⇒ 走引擎自己拼的请求时**两个模型的思考 100% 丢失**）落成 CHANGELOG + 契约中英「推理文本」各一句 + 0.24.0 指南中英 §15 之后实测 **114 组** / **317 处**（+5 组，引入 5 个新锚点：`streamReasoningText` / `REASONING_DELTA_FIELDS` / `chatStream` / `probeStreamUsage`（`src/providers/openai.js`）、`openAIResponseToCanonical`（`src/messages/canonical.js`）；**声称句自己也入锚点面**（`AGENTS.md` 从 0 组变 2 组、`AGENTS_cn.md` 15 → 17）；契约 EN 84 → 85 / CN 80 → 81，0.24.0 指南 EN 21 → 29 / CN 24 → 32），下限随之抬到 114（下限不跟着升，#286 返工 R1 的两例自测会因「实测 ≫ 下限」而 fail-open：109 的下限在 114 组上空转，两例从 ✓ 变红，而 `--self-test` 是 CI 的阻断步）；
  此前 issue #394 的「强制收尾 / guard 续跑注入前结清悬空 `tool_use`」小节落成契约 + 0.24.0 指南中英成对之后实测 **109 组** / **287 处**（+4 组：`answerPendingTailToolUses` / `PENDING_TOOL_RESULT_TEXT`（`src/loop/pending-tool-result.js`）、`pendingTrailingToolUses`（`src/messages/rounds.js`）、`buildToolResultFact`（`src/tool-fact.js`）、`exitCodeForVerification`（`bin/cli.js`）），下限随之抬到 109；
  此前 issue #393 修轮让契约中英成对补了两句（悬空 `tool_use` 先结清再注入、`metrics.verified` 不等于 `verification.status`）之后实测 **105 组** / **264 处**（+1 组：`PENDING_TOOL_RESULT_TEXT`（`src/loop/pending-tool-result.js`，issue #394 把它与结清动作一起搬进共享实现）），下限随之抬到 103；
  此前工单 R / issue #386 切片 3 让契约中英成对新增「预算类停机上的补跑桥」小节、0.24.0 中英指南同步加 §10 之后实测 **102 组** / **260 处**（+4 组：`extensionAllowed`（`src/reflection/governor.js`，本单把可见性从私有改成导出，判定表一字未动）、`applyGovernorExtension`（`src/loop/orchestrator.js`）、`FINAL_GUARD_EXTENDABLE_REASONS`（`src/loop/termination.js`）、`isApiInputOverBudget`（`src/loop/budget.js`）），下限随之抬到 102；
  此前工单 P / issue #386 切片 1 让契约中英成对新增「`finalGuard` 载荷：既有 7 键 + 10 个加法事实」小节、0.24.0 中英指南同步加 §8 之后实测 **98 组** / **247 处**（+3 组：`callFinalGuard`（`src/loop/termination.js`）、`summarizeArgument`（`src/reflection/judge.js`）、`resolveTaskBrief`（`src/loop/task-brief.js`）），下限随之抬到 98；
  此前工单 261022-17 发版准备让 0.24.0 中英成对宿主升级指南落地后实测 **95 组** / **238 处**（+14 组：`compactionStatsWindow` / `validateRunState` / `RUN_STATE_MAX_SERIALIZED_BYTES` / `COMPACTION_STATS_SERIALIZED_LIMIT`（`src/run-state.js`）、`COMPACTION_STATS_STATE_LIMIT`（`src/compact/pipeline.js`）、`assertSnapshotPersisted` / `makePersistenceFailure`、`toolMarker` / `displayName` / `searchRootError` / `withDeprecation`（`src/tools/file-tools.js`）、`BASELINE_WITH_TOOLS`（`scripts/type-check-ratchet.mjs`）、`makeTmp`（`test/helpers/tmp.js`）），下限随之抬到 95；
  此前 #315 的 `compactionStatsWindow` 小节 +1 组 / +2 处，实测 81 组 / 203 处；工单 F2 / issue #361 把契约中英成对新增的「落盘行形状 ≠ `load()` 之后的形状」小节落地后实测 **80 组** / **201 处**（唯一组数 +3：`isRoundCarrier` / `createMemoryTranscriptStore` / `createFileTranscriptStore`），下限随之抬到 80；
  此前工单 261021-12 发版准备让 0.23.0 中英成对宿主升级指南落地后实测 **77 组** / **194 处**（唯一组数 +1，新指南的锚点含 `projectTranscriptForDisplay` / `foldMessageRows`），下限随之抬到 77；
  此前工单 261021-11 让读账本一律过 `load()` 的契约子项落地后实测 **76 组** / **189 处**（+1 组：`foldMessageRows`），下限随之抬到 76；
  此前工单 261021-04 把方向提示的档案口径写成中英成对的契约子项后实测 **75 组** / **185 处**（+3 组：`pendingDirectionHints` / `directionHintText` / `restoreResume`），下限随之抬到 75；
  此前工单 261021-03 B1 把架构×2 / 图表×2 / 需求对照×2 与 `examples/pi-extension/README.md` 纳面后实测 **72 组** / **180 处**，下限随之抬到 72（+5 组：`resolvedToolResultTtl` / `markStablePrefix` / `loadModelSlot` / `createProviderForSlot` / `createJsonFileModelConfigProvider`）；
  此前 #326 的 store 去重契约中英成对小节落地后实测 67 组 / 173 处，下限随之抬到 67；此前 2026-10-16 在 0.21.0 中英成对指南落地、
  并按 issue #293 补正 0.19.0 指南之后由 32 抬到 35；#313 的契约新节合到它们之上之后实测 45 组 / 107 处；#314 的
  宿主侧 guard 接线一节中英成对落地后实测 **53 组**唯一 (符号, 文件) / **122 处**，下限随之抬到 53；工单 261016-021
  把 0.21.0 中英成对指南补上 #313 / #314 / #312(b) 三节之后实测 **63 组** / **165 处**，下限随之抬到 63；`--verbose` 可复核）；工单 V（issue #391）把契约中英的交付物小节改成「只给命名判据」并新增 `createNamedDeliverableChecks`——两个新组：`createDeliverableChecks` 与 `createNamedDeliverableChecks`，都在 `bin/final-guard.js`，`--verbose` 实测 **105 组 / 264 处**（契约 EN 75 / CN 74），下限随之抬到 105：掉到下限以下就红——那是「锚点在退化」被抓住，不是棘轮上升——超过它则收到「请把下限升上去」的提示。
  两个数都是从脚本自身文本里读回来的，这正是 `--self-test` 能证明它们真的是锁的原因。
  *`symbol-anchor-span`*（#286 第二刀 T-b1a）是上面那条的**逐处**搭档：符号锚点**自带行号区间**时
  （`` `符号`（`路径:1517-1531`） ``），该区间必须**与该符号在被引文件里的真值位相交**（`lo <= p <= hi`）。真值位 =
  该名字的**全部**声明处（不只首处：`sideEffect` 在持久化归一化与 `fail()` 里各合法出现一次），再加上那 4 份点名文件里
  该具名字面量的出现行。区间指错地方正是 #286 的漂移形状——符号对、行号错，而旧的 `paths` 在解析前把行号剥掉，根本
  看不见。合法修法两条：**删掉区间**（`` `符号`（`路径`） ``，首选：行号会漂，`symbols` 从来不需要它），或把区间挪到真的
  覆盖声明处。不带区间的锚点不在本判据范围内，这也正是「删区间」能让下面那道棘轮合法下降的原因。
  *`bare-lines`* 是**只减不增的棘轮**：`src/**.js:N` / `:N-M` 形态的裸行号引用，按唯一 (文档, 目标文件, 行区间) 计数，
  不得超过同一份脚本里的 `BARE_LINE_REF_BASELINE = 130`（从 132 降下来：PR #451 把契约里两处指向 end-turn 收尾块的
  裸行号换成了符号锚点）。这个数可以复核：`node scripts/docs-drift-check.mjs --verbose`
  会打出实测「134 唯一区间 − 4 处声明式豁免 = 130」。豁免走 `BARE_LINE_EXEMPTIONS`，**三个信号缺一不放行**（评审 R4 把从前的整行 OR 收紧成 AND）：
  ① 表里点名这一条（文档 + 占位路径）；② 引用行里确实写着那个占位路径；③ 同一行还有「示例/示意/宿主仓根」
  这类就地声明词——同一行剩着一句 `for example` 之类的附带措辞不算声明。条目自己还要过配置校（声明词若能
  匹配空串 = 这一侧恒真、或带 `g` 标志让 `.test()` 变有状态 ⇒ 红）；没被任何引用用到的条目本身也会红
  （与 #286 已落在 `test/static-guards.test.js` 的双条件同口径）。
  行号越界是**错误**，不是观察项。覆盖面是宿主真会读的 **37** 份文档：两份 README、中英 AGENTS、中英契约、中英架构、中英图表、中英需求对照、`examples/pi-extension/README.md`，加上
  **全部** `docs/host-upgrade-guide*.md`（按目录实扫，新指南一落地就自动在面内）。按目录实扫有一个静默失效的形状：
  把某份指南改名到不再匹配那个模式，脚本侧和用同一个 glob 的测试侧**一起**少一份，两边数字仍然相等 ⇒ 覆盖面悄悄缩面。
  所以有 `REF_SCAN_DOCS_MINIMUM = 45` 这道下限（13 份点名文档 + 当前实扫到的 32 份指南；0.22.0 中英成对指南落地时
  由 22 抬到 26，工单 261021-03 B1 因「架构×2 + 图表×2 + 需求对照×2 + `examples/pi-extension/README.md` 纳入 `paths` 判据」由 24 抬到 **31**——那七份是「会被当成现状读」的活文档，它们不在面内时「`src/providers/index.js` 这类路径漂了不会红」），并且 `test/docs-anchor-ratchet.test.js` 里另硬编码了那 13 + 24 个文件名做对照：改名或新增指南，两处不同步就红。`CHANGELOG.md` 明确**不参与**：
  它的行号记的是「发版那一刻为真」的事实，改掉等于伪造历史（与 #278 的简称登记表同一套理由）。
  第一批 T-a 做的是基建与棘轮；第二批 T-b1a 把契约里**自带区间的符号锚点**那一族改绿（中英同一个 PR），基线从 244 降到 232；第三批 T-b1b 收尾同一族——两份契约里剩下的裸 `src/loop/orchestrator.js:N[-M]` 条目要么**删掉区间**（首选，并把真声明处的符号名写进句子：`resolvedModelConfig` / `reportObserverError` / `persist` / `isEndTurn` 等），要么作为**范围性事实**保留并把区间对过代码，基线从 232 降到 144。剩下的 `provider-runner.js` / `termination.js` / `governor.js` 三族属 T-b2，而「把基线常量降下来并在提交信息里写理由」
  仍然是「确实少了一些」唯一可核对的写法。
- `--checkJs` 棘轮规则（issue #214）：`npm run check:types` **不追求清零**——108 个错（涉 27 个文件）是已接受的债（#214 首测是 218，issue #177 刀 1 给 `src/loop/orchestrator.js` 还掉 1 个；PR #249（即 #213 的两个 provider 工厂 JSDoc）又还掉 75 个，**全部落在那两个工厂文件**：`src/providers/openai.js` 46 → 7、`src/providers/anthropic.js` 45 → 9，其余 27 个带错文件一个没动；issue #265 把 `src/store/notes.js` 的端口语义抽进两个新模块后又还掉 21 个，**同样全部落在那一个文件**：`src/store/notes.js` 27 → 6，两个首行 `// @ts-check` 的新模块（`src/store/notes-port.js`、`src/store/notes-memory.js`）各自贡献 0 个，其余 28 个带错文件一个没动——逐文件对账用的是 `git archive` 取出的 `7354fab^` 对照树，它在同一条命令下逐字复现 142 / 185）。
  它保证的是**只减不增**：总数与 `scripts/type-check-ratchet.mjs` 里的 `BASELINE_ROOT = 108` 常量比较（2026-10-31 在
  `c92c8fa` 上复测，环境 `typescript@5.9.3` + `@types/node@22.20.5`，**两档在同一笔提交里一起下调**：110 → 108 与 146 → 144，各降 2，
  那 2 个全部落在 `src/loop/orchestrator.js` **14 → 12**（#473/#435 把 `deliverablesAllPassed` / `deliverablesFailures` 那一段的两个内联表达式
  提成带类型的局部量，重构顺带消掉的，不是专门去修类型债）；同日上一笔是 116 → 110 与 152 → 146，各降 6；
  上一轮 2026-10-23 是 117 → 116 与 153 → 152，各降 1；
  2026-10-21 那轮量到的 117 / 153、2026-10-15 那轮量到的
  119 / 162 都是**历史值**；issue 正文里的 226 在 #213 之前的树
  `bc3ad02` 上逐字复现，这正是 #214 当时入库值是 218 而不是 226 的原因）。**先还哪一半**：108 个里有 79（2026-10-31 于 `c92c8fa` 重算：可及 79 / 宿主不可及 29 = 108——本轮那 −2 全在 `src/loop/orchestrator.js` 14 → 12，它**在可及那半边** ⇒ 可及份额自己从 81 掉到 79，而宿主点不到名的 29 个 / 9 个文件一个没动）；上一笔（同日 #630 S2）重算：可及 81 / 宿主不可及 29 = 110——那一笔的 −6 落在 `src/run-state.js` 10 → 4、`src/loop/orchestrator.js` 17 → 14、`src/reflection/wrapup.js` 3 → 0（该文件退出错误集合），同时 `src/compact/pipeline.js` 3 → 6 与 `src/compact/fold-llm.js` 2 → 5，于是可及份额 90 → 81、可及文件 19 → 18；2026-10-23 那轮是 可及 90 / 宿主不可及 26 = 116；2026-10-21 那轮是 91 + 26 = 117；本轮少掉的 1 条在 `src/messages/openai-normalization.js`，**它在可及那一半**（`src/index.js` 直接 `export … from` 它）⇒ 可及份额自己从 91 掉到 90、可及文件 20 → 19，不可及那一半的 26 个 / 9 个文件一个没动；2026-10-15 那轮是 93 + 26 = 119，那次少掉的 2 条全在 `src/compact/pipeline.js`（不可及那一半）⇒ 可及份额仍是 93） 个（涉 19 个文件）落在**宿主真的能碰到的公共面**
  上（2026-10-13 **重新实测**：把 tsc 输出按文件聚合，再把每个文件对闭包分类，**不是**从 142 时代的 114 减 21 推出来的——从生成的 `src/index.d.ts`/`src/tools/index.d.ts` 沿声明里的相对说明符**传递地**可达的 `src/` 下模块共 **51 个**（2026-10-31 复测，不含两个入口文件本身；含它们 53 个）——本段更早记的 42（2026-10-21）与 40 / 38 / 41 都是**历史值**，来自一个更窄的遍历器；这个数的用途只是「判断哪些文件在不可及那一半」，而那个集合没变，仍是 9 个文件）；剩下 29 个仍在同样的 9 个宿主点不到名的纯实现内部文件里（`run-snapshot-executor` 8、`compact/pipeline` 6、
  `error-ledger` 3、`providers/timeout` 3，另有 5 个文件各 1-2 个）——2026-10-31 重测仍是这 9 个文件（只有 `compact/pipeline` 动了，+3）；#265 那 21 个因此全落在公共面那半边（`src/store/notes.js` 本来就在公共闭包里）。准入规则：
  - **新增文件必须首行开 `// @ts-check`。** 它是「这份文件愿意被检查」的声明，**不是范围开关**：`--checkJs` 加上
    `src/index.js` 已经会把整张 import 图拉进来（`--listFiles` 实测单入口能到 `src/` 下 **70 个文件**（2026-10-23 复测；2026-10-21 记的 65、2026-10-13 记的 58、#265 之前的 56 都是**历史值**），其中 **27 个带错**），
    所以「只编入口」根本限制不了范围；白名单只能按文件加，这正是 #214 R2 要的事。
  - **改动某个文件时，若它的错误数能降就是顺路机会**（#179 那一类：随本就在改这个文件的 PR 消化，不单开单）。
    总数降下来后，把基线常量的下调**单独一次提交**，并在提交信息里写清哪个文件减了几个——棘轮的全部价值在于「这个数只会变小」。
  - ⚠ **跑之前先删掉生成物。** tsc 解析 `./x.js` 时**优先命中同目录的 `x.d.ts`**，所以 `npm run types:build`/`prepack`
    之后，本门禁会变成「在检查声明而不是实现」：同一棵工作树实测（2026-10-11 在 #249 之后的那棵树上复测），**无 `.d.ts` 在场 = 142 个错**，**61 个 `.d.ts` 在场 =
    0 个错**（`--skipLibCheck` 直接跳过声明文件），去掉 `--skipLibCheck` = **13 个错且全部落在 `.d.ts` 上**。**2026-10-31 在 `c92c8fa` 上重跑同一组对照（上一组是 2026-10-23 于 #409 之后的树上跑的）**：生成物数量已是 **87** 个（历史值：2026-10-23 那棵树 75 个、2026-10-21 那棵树 72 个、2026-10-22 那棵树 71 个、2026-10-15 那棵树 65 个、2026-10-11 那棵树 61 个、`39e96f1` 上 63 个、0.20.0 出厂 64 个），**无 `.d.ts` = 108 个错**（2026-10-31 于 `c92c8fa` 复测；2026-10-23 那棵树读 110）、**87 个在场 = 0 个错**、去掉 `--skipLibCheck` = **13 个错且全落在 `.d.ts` 上**（仍集中在 `src/run-state` / `src/providers/errors` / `src/reflection/wrapup` 三处，分别是 7 / 3 / 3 条）。
    「0 < 基线」在这里是**假绿**，所以脚本对残留的 `src/**/*.d.ts` 直接变红（仓库提交了 0 个 `.d.ts`，存在即生成物）；
    清掉即可：`find src -name '*.d.ts' -delete`（生成物不入库、可随时重建）。
  - 故意留着的盲区（规格就是这么定的）：第二个公共入口 `src/tools/index.js` 会拉进包根图里**到不了**的
    `src/tools/file-tools.js`（20 个错）与 `src/skills/loader.js`（16 个），所以这两个文件的新错默认**卡不住**；
    `npm run check:types -- --with-tools` 卡并集（基线 **144** / 29 个文件 = 108 + 20 + 16，2026-10-31 于 `c92c8fa` 重测；这里的每文件计数每次下调都要重新数——本轮两档各降的那 2 个**一个都不在** `src/tools/file-tools.js` 与 `src/skills/loader.js`（仍 20 / 16），全在 `src/loop/orchestrator.js` 14 → 12；上一笔两档各降的那 6 个**一个都不在** `src/tools/file-tools.js` 与 `src/skills/loader.js`（仍 20 / 16）：是 `src/run-state.js` 10 → 4、`src/loop/orchestrator.js` 17 → 14、`src/reflection/wrapup.js` 3 → 0（退出错误集合），对 `src/compact/pipeline.js` 3 → 6 与 `src/compact/fold-llm.js` 2 → 5；上一轮两档各降的那同一个 1 是 `src/messages/openai-normalization.js` 1 → 0，来自 issue #409（`6b604e7` 把 `parseOpenAIToolArguments` 改走共享的 `parseToolArguments`，`d9a0989` 再把 `parseJsonWithRepair` 的 `@returns` 拍平成单形状、把新文件 `src/messages/tool-arguments.js` 短暂带进的那 1 个也消掉），带错文件数随之 31 → 30；上一轮（2026-10-22）`src/tools/file-tools.js` 23 → 20、`src/skills/loader.js` 仍 16，156 → 153 的那 3 个全在这里，是 PR #370（issue #358 读侧诚实性）把 `editDiffTruncated` 并进那个 cause 联合类型顺带消掉的；再上一轮 160 → 156 的 4 个也全在这个文件（27 → 23），来自 PR #356 为 `toolMarker` 加的 `markerCount` 窄化），将来收紧就走这条路，不要拿它当「反正卡不住」的理由。
    ⚠ 退役的 261 里悄悄留着 #177 已经还掉的那 1 个（那一档当时没跟着复测）：**下调基线必须两档在同一笔提交里一起复测、一起降**。
  - 工具链许可（issue #213，#214 重申）：`typescript` + `@types/node` 只能待在 dev——零运行时依赖红线约束的是
    `src/`/`bin/` 的 import（`node:` 内置 + 相对路径），本门禁也不新增依赖（只用 `node:` 内置，不建 tsconfig、不引入新工具）。

## 4. npm 发布指南（已根据 2026-08 政策验证）

### 前置条件（`package.json`）
- 必须移除 `private`（否则 403）；使用 node 脚本编辑 JSON，不要用 sed 删除一行（否则尾部逗号会破坏 JSON）。
- `files` 是一份**很长的显式白名单**——唯一真值是 `package.json`，不要从这里转抄：`src`、`bin`、`skills`、`README.md`、`README_cn.md`、`CHANGELOG.md`、宿主契约中英两份、各版本的升级指南（逐个列名）、`LICENSE`，以及 `test/contract/` 下的契约套件——**逐个文件枚举**（`test/contract/assembly-port.js`、`…`，没有目录条目，所以同目录的 `*.test.js` 套件从不随包）。发布前使用 `npm publish --dry-run` 检查 tarball。
- `repository.url` 使用 `git+https://...` 格式（或运行 `npm pkg fix`）。
- 类型面（issue #213）：顶层 `types` 指向 `./src/index.d.ts`，`exports["."]` 与 `exports["./tools"]` 各带对应的 `types` 条件；
  `exports["./contract-tests"]` **刻意不带** `types`（其目标在 `test/` 下，不在声明依赖图里）。声明由 `prepack` 钩子生成，
  因此干净检出里一个 `.d.ts` 都没有——装包后应列出 **88** 个 `.d.ts`（在 #246 第一刀的树上实测：`npm pack --dry-run --json`
  列出整整 88 个，因为本刀把 `src/loop/state-view.js` 接进了声明依赖图，它的声明也开始随包；此前 **87**（在 #626 C1 的树上实测，
  列出整整 87 个，因为那一单新增 `src/tools/delegation/tail.js`；此前 **86**（在 #617 P1b 的树上实测，
  因为该单新增 `src/tools/delegation/tool.js`）；此前 **85**（在 #617 P1a 的树上实测，
  因为该单新增 `src/tools/delegation/roster.js`、`src/tools/delegation/capacity.js` 与
  `src/tools/delegation/notify.js`）；此前 **82**（在 #568 的树上实测，因为该单新增 `src/loop/continuity-block.js`）；此前 **81**（在 #498 S4a 的树上实测，因为该单新增
  `src/loop/capabilities-namespace.js`）；此前 **80**（在 #497 的树上实测，因为该单新增
  `src/loop/config-namespace.js`）；此前 **79**（2026-10-25 在 #462 的树上实测，因为该单新增
  `src/compact/resume-fold-trim.js`；再此前 78（2026-10-24 在 #460 的树上实测，因为该单新增
  `src/compact/fold-archive.js`）；此前 77（2026-10-23 在 #406 B2-a 的树上实测，因为该单新增 `src/normalization/parse-model-json.js`
  与 `src/config/slot-provider.js`）；此前是 75，因为 #409 新增 `src/text/repair-json.js` 与 `src/messages/tool-arguments.js`；再此前 73，因为 #404 新增 `src/loop/resume-notice.js`；再此前 72，因为 #394 新增 `src/loop/pending-tool-result.js`；再此前 71，因为 #386 切片 2 新增 `src/loop/deliverables.js`；再此前 70，因为 #333 新增 `src/store/message-rows.js`；再此前 69，因为 #326 新增 `src/store/transcript-dedup.js`、#322 新增 `src/compact/fold-summary-journal.js`）。**这个数由
  `npm run check:pack-links` 与 tarball 内容对账——不许手抄进这两份口径文件，门禁会点名文档与行。**
  以下都是**历史值**，按当时为真保留：67（#307 之后，2026-10-16 实测）、66（#305 新增 `src/text/json-candidates.js` 之后）、
  65（#292 之后，2026-10-15 实测）、64（0.20.0 的 tarball）、63（0.19.0 时代）；体积 +约 44 kB（打包）/ +约 139 kB（解包）是 0.18.0 上实测的。
  `npm run check:types-build` 是「还能不能生成」的门禁。
- 当前版本：`package.json` 写 `0.29.0`（本仓版本），发布行——npm 的 `dist-tags.latest`——是 `0.29.0`；这两句由 `check:docs` 每次运行**当场对账**（它读 `package.json` 与 registry，句子过期就红），所以两句都不带测量日期：日期自己不会过期，而当场对账不需要第二份真值（issue #511）。版本变更使用 `npm version <x.y.z> --no-git-tag-version`（功能完整的首发版本不要使用 0.0.0）。`0.24.0` **从未发布**到 registry（已发布序列是 0.23.0 -> 0.25.0），且刻意**不补发**：`0.25.0` 已取代它，`CHANGELOG.md` 里 0.24.0 那段保留为「那一刻为真」的历史。

### npm 2026 政策变化（TOTP 停止 + bypass token 限制）
- ❌ 不再支持新的 TOTP 注册（`enable-2fa` 返回 404）。
- ❌ bypass-2FA granular tokens 从 2026-08 起失去直接发布权限。
- ✅ **唯一途径（`npm@12`）**：
  ```bash
  npm i -g npm@12                    # 升级（系统 npm 10 不支持新流程）
  npm login --auth-type=web          # 浏览器 OAuth + passkey
  npm publish                        # device flow：终端打印认证 URL
  ```
- **发布交互（已在 2026-09 验证）**：即使已执行 `npm login`，`npm publish` 仍会触发**一次独立的 device flow 认证**（EOTP；每次发布都要重新认证，而不是由登录覆盖）——终端会打印 `https://www.npmjs.com/auth/cli/<id>`；将其复制到浏览器，在手机上使用相机扫描/确认 passkey，然后命令行自动继续。
- ⚠️ **预发布版本必须显式指定 `--tag`**（由 npm12 强制）：`npm publish --tag latest`；否则会报告 `You must specify a tag when publishing a prerelease version`。
- ⚠️ 在非 TTY 环境（脚本/管道）中，认证 URL 会被掩码为 `***`——**用户必须在自己的终端运行**；在 agent 侧，使用 Python pty 方案为用户捕获真实 URL（见陷阱 4）。
- ⚠️ **不要在 "Press ENTER to open in the browser..." 提示处按 ENTER**（已在 2026-09 验证）：没有浏览器时，按 ENTER 会触发 `xdg-open` 失败并终止 npm（`command failed`，code 3）。如果不按 ENTER，npm 会继续轮询认证状态并正常完成。

### 发版前必跑清单（强制——0.23.0 的教训）

发布前有**两件事是强制的**，而 0.23.0 两件都没跑，因为两件都靠「记得手动跑」：**文档审计**与**真机清单**。按这个顺序跑完，才轮到 `npm publish`：

```bash
npm run check:docs && npm run check:docs:strict   # 文档审计（漂移 + 中英成对）
ERIX_E2E_REAL=1 npm run check:release:real        # 真机清单（七条，红就点名）
npm run check:release                             # 离线：tarball 形状 / 装后包 / TS 宿主 / CLI 假上游
```

不带 `ERIX_E2E_REAL=1` 时中间那条**什么都不跑**并 exit 0——那**不是**通过，那意味着这次发版的真上游那一半根本没做，发版不算验过。
文档审计也不是可选项：0.23.0 发出去的文档里就有审计本来会抓到的东西（契约版本标注、中英成对、存储图）。

**机械门禁之外**（`check:docs` / `check:docs:strict` / `check:release`），打 tag 前**还要人工过一遍三类「声称值」**——**默认值**（`default X` / 默认 `X`）、**数字**（N 步 / N 个 / 常量数值）、**名字集合**（策略名、工具名、flag）。范围：两份 README + 两份 AGENTS + 两份契约。
理由：锚点只覆盖已登记的维度，而**默认值这类最容易改也最影响成本**的事实曾漏网——#614 把默认压缩策略改成 `fold-llm`，两份 README 与契约都仍写 `fold-statistical`，`check:docs` 却全绿。
发现可机械检查的，**顺手加锚点**（一次成本、永久免疫）；不可机械的才留在人工清单里。

### 发布验证闭环
```bash
npm publish --dry-run        # 看 tarball 内容
npm publish                  # 发布（web 认证）
npm view erix-agent version  # 确认 registry
npm unlink -g <旧包名>        # 清本地 link 残留（否则 i -g 报文件冲突）
npm i -g erix-agent          # 全局安装正式包
erix --version && erix chat "..."   # 端到端验证（复用 ~/.erix/config.json）
```

### 踩坑速记
1. 使用 node 脚本编辑 `package.json`；编辑后通过 `node -e "JSON.parse(...)"` 验证。
2. 发布前解除本地 link（`@erix/llm-kit` 是历史遗留）。
3. npm 政策变化很快（TOTP/bypass 已于 2026 年转变）——遇到 403/EOTP 时，先查看官方 changelog。
4. 对于无浏览器 + 非 TTY 的认证流程（已于 2026-09 验证，在没有桌面环境的机器上）：用 Python pty 包装 npm（`pty.fork()` + `select` 读取输出），使用 `setsid nohup` 完全脱离进程组，防止 bash 工具清理它；在脚本中使用正则将 `https://www.npmjs.com/(login|auth/cli)/[0-9a-f-]+` 提取到文件，然后读取 URL 并交给用户在浏览器中操作；**不要自动按 ENTER**（见上文）。登录成功会将 token 写入 `~/.npmrc`；发布成功由日志行 `+ erix-agent@<ver>` 标记；参考实现 `/tmp/npm-pty-login5.py`。

## 5. Git 与远程

- **两个仓库、一份代码、双推**：`origin` 从 GitHub 拉取（工作流真相源），推送时**同时推** GitHub 和 Gitea —— `git push origin <ref>` 会更新两边。
  - `origin` fetch = `ErixWong/erix-agent`（GitHub）
  - `origin` push URL = GitHub **+** `git.erix.vip/eric/erix-llm-kit`（Gitea）
- **GitHub** = 开发工作流真相源：issue、PR、评审都在这里。Gitea 的 issue/PR 区是冻结的历史归档，**不新开、不回复**。
- **Gitea** = 仅代码镜像（同一份提交，双推跟随）。
- **`sync-erix-mirror.sh` cron 已停用（2026-10-03）**：镜像 cron 已证实会反复同步错误版本；双推是唯一同步机制。若某次推送在其中一个 URL 失败，该侧会静默落后 —— 推送后请核对两边。
- 提交流程：分支 `feat-YYMMDD-NN-<描述>` → PR 合并到 main（大改动）；小改动/文档可直接推送。
- 提交信息：conventional commits + 中文摘要
- 历史注记：2026-09-30 前 GitHub 为真相源，当日某会话把角色翻转为 Gitea（提交 `2ee65ce`，加镜像 cron + 双推 URL）；2026-10-03 翻回：GitHub 重新作为工作流真相源，cron 停用，两仓靠双推保持一致。旧的「Gitea 优先」描述误导过后续会话 —— 本段与 `AGENTS.md` 需同步维护。

## 6. 本地运行数据（不提交到仓库）

```
~/.erix/
├── config.json        # LLM 配置（endpoint/model/apiKey/maxOutputTokens/contextWindowTokens）
├── mcp.json           # MCP server 注册（标准格式，可复用 ~/.config/mcp/mcp.json）
├── <session>.json     # 会话历史（id 按 cwd 派生）
├── transcripts/
│   ├── <runId>.jsonl          # 只留元数据的轮行 + 一条消息一行（`kind:"message"`，`seq` / `partOf?`）；`load()` 折叠回轮行
│   └── outputs/<runId>/       # 该 run 的全部产物归档：工具捕获、报告、judge.log
│       └── judge.log          # judge 决策 JSONL（默认写这里；--judge-log / ERIX_JUDGE_LOG 可覆盖）
├── skills/            # 用户级 skill（自描述协议）
└── todos/             # 任务清单（按 cwd 隔离）
```

- **judge 日志有固定归属**：`transcripts/outputs/<runId>/judge.log`，与 transcript/工具捕获同目录同生命周期；监督者排查 judge 行为直接看这里，不再依赖 `/tmp` 重定向。
- **judge.log 记录形状（#165，additive）**：每条决策记录带 `runId` + 被评决策发生时 run 实际使用的 `model`（judge 走另一个 evaluator 模型时再带 `judgeModel`；探不到就缺省字段，绝不写占位值），且每个 run 的末条是一条 `run_outcome` 汇总记录（`termination` + `verification`）——追加而非回写。per-model 校准指标（blocked 率 / 误拦率 / extend ROI）就是把这两类记录按 `runId` join。

## 7. 本地运行环境事实

- Relay：`api.ai.erix.vip/v1`；模型必须由用户配置（`contextWindow 262144`、`maxOutputTokens 65536` → 自动压缩预算 ~170k）。`erix_run` 读的就是同一份 `slots.default`，不跟随 pi 当前模型。
- 工具执行/验证：erix 工作使用 `node bin/cli.js chat`（本仓库），监督者监视 `/tmp/erix-*-log.txt` 以获取逐步输出。
- erix 编码任务红线：**读文件前先估额度、一次要够**（工具描述里已写好额度事实：默认行数、单次字节上限与 token 换算），而不是保守地小步分段读；长任务先用 `todo_add` 拆解，汇报前作出验证声明。

## 8. 模型与成本纪律

- 禁止硬编码模型名称；始终从用户配置读取，或使用用户明确提供的模型。
- 模型不可用时立即失败；绝不替换模型或回退到其他模型。
- 任何批量实验开始前，必须报告模型、调用次数和基于历史平均值的成本/时长估算，并取得用户确认。
- 尊重用户对供应商和配额的选择；用户更换模型通常是出于成本或配额原因，因此不得悄悄切回原模型。
