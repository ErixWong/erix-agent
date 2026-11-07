# erix-agent — 项目 AGENTS.md

> English version: [AGENTS.md](AGENTS.md)

项目特有规则；共享/全局约定见 `~/projects/AGENTS.md`，并且有意不在此重复。本文件随仓库走（GitHub: ErixWong/erix-agent）。

## 1. 项目定位

**自研无头编码 agent（headless agent）**：零依赖 LLM agent 运行时（双协议流式 + 工具循环 + 压缩 + checkpoint），用于**无人值守、宿主编排**场景（fde-workshop / touwaka 嵌入式底座）。

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

一道闸一行，只留三样：命令、**它判什么**、以及「动它管的那些东西之前先读哪一节」的祈使句。长篇理由、反向证与
踩坑记录全在 `docs/maintenance/command-reference_cn.md`——那是冷层（碰到这道闸才读），本页是指令面（每次任务都
照做）。第三列别跳：它点名的每一个坑，本仓都真栽过一次。

| 命令 | 它判什么 | 动之前 |
|---|---|---|
| `npm test` | 全量套件（`node --test`） | 新增或改动测试 ⇒ 先读 `docs/maintenance/command-reference_cn.md#test-suite` |
| `node --check <file>` | 单个文件的语法 | 只查一个文件 ⇒ 不用读别的 |
| `npm run check:syntax` | **每一份入库** `.js`/`.mjs`/`.cjs` 的语法 | 移动或重命名入库文件 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-syntax` |
| `npm run check:test-summary` | 套件汇总与它登记的基线 | 动 `test/test-suite-baseline.json` ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-test-summary` |
| `npm run check:changelog` | 碰到公开面的合并有没有被本版 CHANGELOG 点名 | 合并任何碰到公开面的改动 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-changelog` |
| `npm run check:docs` | 文档漂移 + 中英成对（版本、清单、模块图、路径、现值声称） | 动 `README*`、`docs/`、`files`/`exports`、默认值或版本 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-docs` |
| `npm run check:docs:strict` | 同上，告警也阻塞 | 与上一行同一批触发条件 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-docs` |
| `node scripts/docs-drift-check.mjs --self-test` | 锚点自己的反向证——#302 之前是另一回事：没有 `docs/tasks/`（未入库）的检出里曾有 3 例已知假红，那些红已经没了 | 改 `scripts/docs-drift-check.mjs` ⇒ 先读 `docs/maintenance/command-reference_cn.md#docs-anchors` |
| `npm run check:docs-examples` | 两份契约与两份根 README 的 JS 代码块（编译、链接、真跑） | 改那四份里的示例块 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-docs-examples` |
| `npm run check:pack-links` | 随包 Markdown 的链接闭合 + `.d.ts` 与发布面声称 | 动 `files`/`exports` 或声明数 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-pack-links` |
| `npm run check:release` | 离线发版前清单（一条命令六步） | 改动随包发布的东西 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-release` |
| `npm run check:release:real` | 真上游清单（受闸门控制） | 发版前带 `ERIX_E2E_REAL=1` 跑 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-release-real` |
| `npm run release:day` | 发版日四个 `--stage`；回写面是 `--sync`（`scripts/release-day.mjs`） | 发版 ⇒ 先读 `docs/maintenance/command-reference_cn.md#release-day` |
| `npm run check:cli-real` | **装后** CLI 打真上游（受闸门控制） | 动 `bin/` ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-cli-real` |
| `npm run check:docs-spelling` | 活文档里的退役扁平拼写 | 新增或改任何 `docs/**.md`、README ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-docs-spelling` |
| `npm run check:agents-directives` | 本页：工单状态句、过期实测数、裸行号、**以及字节预算** | 改 `AGENTS.md`/`AGENTS_cn.md` ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-agents-directives` |
| `npm run types:build` | 生成随包发布的 `src/**/*.d.ts` | 动宿主可见签名 ⇒ 先读 `docs/maintenance/command-reference_cn.md#types-build` |
| `npm run check:types-build` | 声明还生成得出来、且带公共符号 | 同上 ⇒ 先读 `docs/maintenance/command-reference_cn.md#types-build` |
| `npm run check:types` | `--checkJs` 错误数棘轮（`--with-tools`：基线 **131** / 28 个文件） | 动 `src/` ⇒ 先读 `docs/maintenance/command-reference_cn.md#type-ratchets` |
| `npm run check:mutation` | 常驻变异样本表与树对账 | 改 `test/mutation-samples.md` ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-mutation` |
| `npm run check:mutation:run` | 样本真的会被咬住（变异 → 红 → 还原 → 绿） | 同上 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-mutation` |
| `npm run check:exports` | 每个导出名谁在用——**清点、不判定**；三个入口含 `test/contract/`，另有 `internal-only` 一档（`scripts/export-consumer-check.mjs`） | 删导出 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-exports` |
| `npm run check:exports:deprecated` | 零消费者删除登记与 `@deprecated` 标记规矩 | 标记或删除导出 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-exports-deprecated` |
| `npm run check:host-consumers` | 宿主侧对「标了要删」的名字的 import——给了 `--hosts` 才判、CI 不跑，候选清单由探针自己的 `computeInventory` 现算、不抄第二份（`scripts/host-consumer-probe.mjs`） | 破坏性发版之前 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-host-consumers` |
| `npm run check:inventory` | 兼容钉子表与测试 AST 对账 | 动兼容钉子 ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-inventory` |
| `npm run check:config-leaf-values` | 配置叶子值现状表与实跑探针 | 动配置 schema ⇒ 先读 `docs/maintenance/command-reference_cn.md#check-config-leaf-values` |
| `npm run check:types:strict` | strict 棘轮，阻塞门禁；两条基线住在脚本里，**本文不抄** | 动 `src/` ⇒ 先读 `docs/maintenance/command-reference_cn.md#type-ratchets` |
| `node bin/cli.js ...` | 本地跑 CLI，无需安装 | 只调试 ⇒ 不用读别的 |

- **CI 的接线不等于闸的清单**（issue #187）：`.github/workflows/ci.yml` 按固定顺序跑阻塞步骤，装依赖一律 `npm install --include=dev`，**绝不用** `npm ci`（本仓刻意 gitignore 了 `package-lock.json`）。要动它 ⇒ 先读 `docs/maintenance/command-reference_cn.md#ci`：有序步骤清单与两处「本来就该红」的形状都在那一节。
- **门禁可复现口径**（issue #280）：`npm run check:docs` 与 `check:docs:strict` 在开发工作树里和在全新 clone 上都必须 exit 0。真正需要 `node_modules` 的那几道（`check:inventory`、三道 `tsc` 棘轮、`check:pack-links`、`check:release`）在裸检出里会以 `Cannot find module 'typescript'` 非零退出——那是「门禁跑不动」，绝不是回归。本地归档那一档按**声明**裁决，不按文件在不在。完整裁决在 `docs/maintenance/command-reference_cn.md#gate-reproducibility`。
- 测试隔离规则：涉及 `~/.erix` 或 `~/.pi` 的测试必须注入 `home`/`cwd` 参数（skills/mcp/config 测试提供了先例），以免污染真实用户配置。
- 类型面规则（issue #213）：`src/**/*.d.ts` 是**生成物、永不入库**（`.gitignore` 已覆盖）；`prepack` 钩子重新生成它们、且**只能往 stderr 打日志**；宿主可见签名要紧时，读生成的 `.d.ts`，不读源码注释。有两种 JSDoc 形状会**静默**把参数退化成 `any`——写之前先读 `docs/maintenance/command-reference_cn.md#type-surface`。
- 类型棘轮（`check:types` / `check:types:strict`，issue #214 / #417）：`npm run check:types` **不追求清零**——96 个错（涉 26 个文件）是已接受的债，与 `scripts/type-check-ratchet.mjs` 里的 `BASELINE_ROOT = 96` 常量比较（也就是那条基线常量 **96**；两档是两次独立测量）：超过 ⇒ exit 1，等于 ⇒ 绿，低于 ⇒ 绿 + 提示「可下调至 N」，所以这个数只减不增。**先还哪一半**：96 个里有 26 个文件承载了这些错，逐文件计数与「是否宿主可及」都由 `--verbose` 逐条打印，本页不抄那份分解（抄来的半分解决定基线一动就过期）。本页仍然声称、且由 `npm run check:types` 现读对账的是文件数：其中 **26 个带错**。生成物在场时同一条命令会报**无 `.d.ts` = 96 个错**、而**声明在场 = 0 个错**，所以残留的 `src/**/*.d.ts` 是硬失败而不是假绿。`npm run check:types -- --with-tools` 把并集扩到 `./tools` 入口（基线 **131** / 28 个文件 = 96 + 19 + 16）；`check:types:strict` 是同一条命令追加 `--strict`、对着同一份脚本里它自己的那对基线，它阻塞，并且**两档必须在同一笔提交里一起测、一起降**。每文件的分布与逐条错误由命令自己打印（`--verbose`、`--show-errors N`）；逐轮流水账留在压低基线的那几笔提交里。
  - **新增文件必须首行开 `// @ts-check`。** 它是「愿意被检查」的声明，不是范围开关——范围是入口的 import 图。
  - **历史值就是历史值，常量是唯一真值**：此前那些读数（在各自的树上实测 142 / 185 / 218 / 226 / 261；`git archive` 对照树在同一条命令下逐字复现 142 / 185）是**历史值**，
    按当时为真保留、绝不当现值用。现值就是常量那个：实测 96 个错（`BASELINE_ROOT = 96`，由 `npm run check:docs` 现读对账）。
  - ⚠ **跑棘轮之前先删掉生成物**：`find src -name '*.d.ts' -delete`。生成物在场时 `tsc` 解析 `./x.js` 会优先命中同目录的 `x.d.ts`，于是检查的是声明而不是实现。
  - **量数纪律（issue #653），对本文提到的每一道棘轮、每一张派生表都成立**：
    - **派生数与基线只在最终树上取。**
    - **基点落后 main 就先 rebase 再取数。** 本分支的基点在 main 后面时，先 rebase 到 main，之后再取数。
    - **降债与它对应的基线 / 派生表更新在同一个 PR 里原子地进。** 同一个 PR 内部保留多个 commit 是对的，
      但两半必须一起进。这三条为什么各自承重，见 `docs/maintenance/command-reference_cn.md#type-ratchets`。
- 文档规则（issue #164）：改 `README*.md`、`docs/requirements*.md`、任何默认值或 `files`/`exports` 清单时，必须保持 `npm run check:docs` 绿。该检查从 `package.json` 与 `src/` 现读真值，所以文档不会悄悄漂移；「当前版本」这类句子的规定写法写在 `scripts/docs-drift-check.mjs` 的文件头注释里。中英成对文档必须同步（见 `AGENTS_cn.md`）。
- 引用**另一个仓库**的文件时（工单 261021-03 B1）：写成 `<仓名>:<那个仓里的路径>`——例如 `touwaka:lib/agent/`、`pi-subagents:src/runs/background/async-execution.js:4`。带前缀的引用**不**在本仓里解析，它的行号也不计入下面的裸行号棘轮；仓名必须是 `scripts/docs-drift-check.mjs` 的 `EXTERNAL_REPO_PREFIXES` 里登记过的（未登记的名字红，登记了却没人引用也红）。**不带前缀的路径就是本仓内的路径，必须在这里解析得到**——这正是那个标记的全部意义：它标的是归属，不是一张免检票。
- **锚点粒度与文档行号锚点**（issue #210 / #286）：本文只有四个数属于门禁、也只有它们是现值——`BASELINE_ROOT = 96`、符号锚点地板 `SYMBOL_ANCHOR_MIN_UNIQUE = 237`（只升：掉到地板以下就红，那是「锚点在退化」被抓住）、裸行号棘轮 `BARE_LINE_REF_BASELINE = 6`（只降）、以及锚点覆盖面地板 `REF_SCAN_DOCS_MINIMUM = 51`。文档不得依赖裸行号：指位置要写符号 + 它的文件（`` `符号`（`路径`） ``），不写 `路径:123`。原先挂在这一节后面的实测流水已整条搬到 `docs/maintenance/symbol-anchor-ledger_cn.md`——那是历史，不是现状，本文不再复述。哪些锚点是逐处级、区间判据、豁免登记表与逐条证明它们的自测，都在 `docs/maintenance/command-reference_cn.md#docs-anchors`——加锚点或搬锚点之前先读那一节。

## 4. npm 发布指南（已根据 2026-08 政策验证）

### 前置条件（`package.json`）
- 必须移除 `private`（否则 403）；使用 node 脚本编辑 JSON，不要用 sed 删除一行（否则尾部逗号会破坏 JSON）。
- `files` 是一份**很长的显式白名单**——唯一真值是 `package.json`，不要从这里转抄：`src`、`bin`、`skills`、`README.md`、`README_cn.md`、`CHANGELOG.md`、宿主契约中英两份、各版本的升级指南（逐个列名）、`LICENSE`，以及 `test/contract/` 下的契约套件——**逐个文件枚举**（`test/contract/assembly-port.js`、`…`，没有目录条目，所以同目录的 `*.test.js` 套件从不随包）。发布前使用 `npm publish --dry-run` 检查 tarball。
- `repository.url` 使用 `git+https://...` 格式（或运行 `npm pkg fix`）。
- 类型面（issue #213）：顶层 `types` 指向 `./src/index.d.ts`，`exports["."]` 与 `exports["./tools"]` 各带一个匹配的 `types`
  条件；`exports["./contract-tests"]` **刻意不带** `types`（其目标在 `test/` 下，不在声明依赖图里）。
  因此干净检出里一个 `.d.ts` 都没有——装包后应列出 **89** 个 `.d.ts`；**这个数由 `npm run check:pack-links`
  与 tarball 内容对账——不许手抄进这两份口径文件。** `npm run check:types-build` 是「还能不能生成」的门禁。
  哪一刀把哪个模块接进了声明依赖图、以及此前每一个数，都是历史：
  `docs/maintenance/command-reference_cn.md#type-surface`。

- 当前版本：`package.json` 写 `0.31.0`（本仓版本），发布行——npm 的 `dist-tags.latest`——是 `0.31.0`。这两句由 `check:docs` 每次运行**当场对账**（它读 `package.json` 与 registry，句子过期就红），所以两句都不带测量日期：日期自己不会过期，而当场对账不需要第二份真值（issue #511）。版本变更使用 `npm version <x.y.z> --no-git-tag-version`（功能完整的首发版本不要使用 0.0.0）。`0.24.0` **从未发布**到 registry（已发布序列是 0.23.0 -> 0.25.0），且刻意**不补发**：`0.25.0` 已取代它，`CHANGELOG.md` 里 0.24.0 那段保留为「那一刻为真」的历史。

### npm 2026 政策变化（TOTP 停止 + bypass token 限制）
- ❌ 不再支持新的 TOTP 注册（`enable-2fa` 返回 404）。
- ❌ bypass-2FA granular tokens 从 2026-08 起失去直接发布权限。
- ✅ **唯一途径（`npm@12`）**：`npm i -g npm@12` → `npm login --auth-type=web` → `npm publish`（device flow，终端打印认证 URL）。
- ⚠️ **每次 publish 都会触发它自己的 device flow 认证**，即使刚跑过 `npm login` 也一样；认证 URL 必须在**抓到它的同一条消息里**交给用户（几分钟就过期，每次发布都要新的一条）。非 TTY 环境下 URL 会被掩码成 `***`——用户要在自己的终端里跑；无头环境的 pty 抓取配方在 `docs/maintenance/command-reference_cn.md#pitfall-4`。
- ⚠️ **不要在 "Press ENTER to open in the browser..." 提示处按 ENTER**：没有浏览器时它会触发 `xdg-open`，失败后直接杀掉 npm（code 3）。让它自己轮询。
- ⚠️ **预发布版本必须显式指定 `--tag`**（由 npm12 强制）：`npm publish --tag latest`；否则会报告 `You must specify a tag when publishing a prerelease version`。

### 发版前必跑清单（强制——0.23.0 的教训）

发布前有**两件事是强制的**，而 0.23.0 两件都没跑，因为两件都靠「记得手动跑」：**文档审计**与**真机清单**。现在两件是同一条命令，需要记住的只剩这一条：

```bash
npm run release:day -- --stage preflight --hosts <宿主仓目录>
#   [1/7] check:changelog                       本版 CHANGELOG 段点名了每一个碰到公开面的合并（issue #691）
#   [2/7] CHANGELOG [Unreleased] carry          本版段已经开了、而条目还停在 `## [Unreleased]` 里的漏搬形态（issue #715）
#   [3/7] check:docs                            文档审计（漂移 + 中英成对）
#   [4/7] check:docs:strict                     同上，告警也阻塞
#   [5/7] ERIX_E2E_REAL=1 check:release:real    真机清单；闸门关着 ⇒ 未判定，绝不是绿
#   [6/7] check:release                         离线：tarball 形状 / 装后包 / TS 宿主 / CLI 假上游
#   [7/7] check:host-consumers -- --hosts …     宿主侧探针：每一处命中都必须已被升级指南覆盖
```

它按顺序跑，**任一红就停在那一步并点名第几步**。不带 `ERIX_E2E_REAL=1` 时真上游那一步**什么都不跑**——那**不是**通过，
命令会明说「未判定」并 exit 2 而不是 0，于是「真上游那一半没做」再也不可能看起来像一次绿的发布。

- **`[Unreleased]` 搬运**（issue #715）是上面清单的第 2 步，它答**三态**（红 / 未判定 / 绿）。哪一态是哪种、为什么 `--sync` 搬不动那些条目、以及它打印的可执行动作，都在 `docs/maintenance/command-reference_cn.md#release-day` —— 开版本节或挪标题行之前先读它。

之后人工只剩**发布与扫码**两件事，而过去靠人记的那两步现在也是阶段：

```bash
npm run release:day -- --stage publish     # 打印操作单并 exit 3；`npm publish` 在你自己的终端里跑
npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]   # 回写 → 提交 → check:docs
npm run release:day -- --stage finalize    # tag（指向切版提交）→ 双推 → 两侧现验 → 文档门禁
```

`--stage writeback` 是**绝不能跳过**的那一步：它只改发布态那几句，并在打任何 tag 之前重跑 `check:docs`。
`finalize` 只在那笔状态在盘上、且工作树干净时才打 tag，所以「tag 出去了、文档还写着未发布」不可能发生。

- **第 5 步是 0.31 这次发版的强制项**（issue #429）：`npm run check:host-consumers -- --hosts <宿主仓目录>` 走一遍宿主检出，要求每一个「标了要删」的名字都**已经**在本版升级指南里有行——**判据是覆盖，不是否决**（本仓是上游，宿主命中是「指南必须写明换成什么」的理由，绝不是「留着这个名字」的理由）。把每个活着的检出都传进来；它不在 CI 里跑，也不许开始跑。完整裁定在 `docs/maintenance/command-reference_cn.md#check-host-consumers`。

**机械门禁之外**（`check:docs` / `check:docs:strict` / `check:release`），打 tag 前**还要人工过一遍三类「声称值」**——**默认值**（`default X` / 默认 `X`）、**数字**（N 步 / N 个 / 常量数值）、**名字集合**（策略名、工具名、flag）。范围：两份 README + 两份 AGENTS + 两份契约。
理由：锚点只覆盖已登记的维度，而**默认值这类最容易改也最影响成本**的事实曾漏网——#614 把 **CLI 槽位默认**压缩策略改成 `fold-llm`，两份 README 与契约都仍写 `fold-statistical`，`check:docs` 却全绿。
发现可机械检查的，**顺手加锚点**（一次成本、永久免疫）；不可机械的才留在人工清单里。

- **`unattributed` 那一遍**是打 tag 前的最后一道人工：`check:changelog` 打印 `unattributed` 提示（碰到公开面、但合并主题里没有单号，按设计**只打印、不阻塞**）时，里面每一个短 sha 都必须人工走一遍——读它的 first-parent diff，要么确认这处公开改动已经写进本版 CHANGELOG 段，要么写下一个后来人能复核的理由。做法在 `docs/maintenance/command-reference_cn.md#unattributed-merges`。

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

运行时写的一切都在 `~/.erix/` 下，**永不入库**：LLM 配置、MCP 服务器登记、会话历史（id 由 cwd 推导）、
transcripts（每轮的 round 行 + 每条消息一行，以及每次 run 的归档）、用户级技能、按 cwd 隔离的任务清单。

- **judge 日志有固定的家**：`transcripts/outputs/<runId>/judge.log`，与 transcript / 工具抓取的目录和生命周期一致；
  supervisor 要看 judge 行为就看这里，不要依赖 `/tmp` 重定向。
- 按模型的校准指标（blocked 率 / false-block 率 / extend ROI）是对决策记录与每次 run 的 `run_outcome` 汇总行
  做 `runId` join——记录形状、目录树与那条注释的其余部分在
  `docs/maintenance/command-reference_cn.md#local-runtime-data`。

## 7. 本地运行环境事实

- Relay：`api.ai.erix.vip/v1`；模型必须由用户配置（`contextWindow 262144`、`maxOutputTokens 65536` → 自动压缩预算 ~170k）。`erix_run` 读的就是同一份 `slots.default`，不跟随 pi 当前模型。
- 工具执行/验证：erix 工作使用 `node bin/cli.js chat`（本仓库），监督者监视 `/tmp/erix-*-log.txt` 以获取逐步输出。
- erix 编码任务红线：**读文件前先估额度、一次要够**（工具描述里已写好额度事实：默认行数、单次字节上限与 token 换算），而不是保守地小步分段读；长任务先用 `todo_add` 拆解，汇报前作出验证声明。

## 8. 模型与成本纪律

- 禁止硬编码模型名称；始终从用户配置读取，或使用用户明确提供的模型。
- 模型不可用时立即失败；绝不替换模型或回退到其他模型。
- 任何批量实验开始前，必须报告模型、调用次数和基于历史平均值的成本/时长估算，并取得用户确认。
- 尊重用户对供应商和配额的选择；用户更换模型通常是出于成本或配额原因，因此不得悄悄切回原模型。