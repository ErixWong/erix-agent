# erix-agent — 项目 AGENTS.md

> English version: [AGENTS.md](AGENTS.md)

项目特有规则；共享/全局约定见 `~/projects/AGENTS.md`，并且有意不在此重复。本文件随仓库走（GitHub: ErixWong/erix-agent）。

## 1. 项目定位

**自研无头编码 agent（headless agent）**：零依赖 LLM agent 运行时（双协议流式 + 工具循环 + 压缩 + checkpoint），用于**无人值守、宿主编排**场景（app_container / touwaka 嵌入式底座）。

- 产品形态 = **无头 agent**：`runToolLoop` 单任务生命周期（start/run/stop/resume/event stream），执行（`executeTool`）由宿主注入；**边界止于单个任务生命周期**；多角色编排/仲裁/重试调度由宿主负责，不纳入库中。
- **CLI (`bin/`) 是验证器/调试器，不是重点**：交互式 TUI + `chat` 单次入口（可作为 bench 入口）；能力验证使用 erix-bench 无头 harness（容器驱动 + 判分器，对比 `--agent erix|pi`），而交互式 repl 仅测试人机协作。
- 与 pi 的关系：**pi = 交互式 agent（人在环）；erix = 无头 agent（无人值守、宿主调度）——互补而非竞争**。
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
│                  # task-brief、abort、block-helpers、tool-result-ttl
├── compact/       # 上下文压缩：budget、pipeline、sliding-window、fold-statistical、
│                  # fold-llm、anchors、fold-fidelity、enforce-size、helpers
├── config/        # 配置适配器
├── messages/      # 规范消息模型 + OpenAI/Anthropic 转换
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
examples/         # 示例（skills/ 示例、演示和基准）
docs/             # 设计文档、ADR 决策记录、研究和任务文档
skills/           # skill 定义
scripts/          # 实验脚本和结果
```

## 3. 开发命令

| 命令 | 用途 |
|---|---|
| `npm test` | 全量测试（`node --test`） |
| `node --check <file>` | 语法安全检查 |
| `npm run check:docs` | 文档漂移检查（`scripts/docs-drift-check.mjs`：版本声明、README 引用的 `files`/`exports` 清单、模块地图、文中路径与命令、从 `src/` 直抽的 14 条关键默认值、中英 README 标题骸架）+ 中英契约标题结构对齐 |
| `npm run check:docs:strict` | 同上，但把告警升级为失败 |
| `node scripts/docs-drift-check.mjs --self-test` | 清单/枚举/单位类锚点的反向证自测（issue #210）：改文档一处声明 → 红、改源码真值 → 红、都不改 → 绿；变异没落上去也算失败（#210 R2） |
| `npm run check:docs-examples` | 真实执行 `docs/host-consumer-contract.md` 里的 js 围栏（issue #158） |
| `npm run check:pack-links` | 随包 Markdown 的链接闭合检查 |
| `npm run types:build` | 把随包发布的 `.d.ts` 生成到 `src/**/*.d.ts` 并保留（issue #213；`prepack` 钩子跑的是同一个脚本） |
| `npm run check:types-build` | 断言式门禁：`tsc` exit 0 / 声明文件数 > 0 / `src/index.d.ts` 含 `runToolLoop` / `src/tools/index.d.ts` 含 `createFileTools`，跑完删掉生成物（issue #213；需要先 `npm install --include=dev`） |
| `npm run check:types` | `--checkJs` **棘轮**：统计从 `src/index.js` 可达的类型错误总数，超过 `scripts/type-check-ratchet.mjs` 里写死的基线常量 **217** 就失败（issue #214；棘轮 = 只减不增，低于基线仍通过并提示「可下调至 N」）。**跑之前先删掉生成的 `src/**/*.d.ts`**——见下面「`--checkJs` 棘轮规则」。加 `-- --with-tools` 可把范围扩到 `./tools` 入口（基线 261，自 #214 起未复测） |
| `node bin/cli.js ...` | 本地运行 CLI（无需安装） |

- 测试隔离规则：涉及 `~/.erix` 或 `~/.pi` 的测试必须注入 `home`/`cwd` 参数（skills/mcp/config 测试提供了先例），以免污染真实用户配置。
- 类型面规则（issue #213）：`src/**/*.d.ts` 是**生成物、永不入库**（`.gitignore` 已覆盖）；`files` 里本来就有 `src`，
  所以 tarball 里有声明而仓库里没有。`prepack` 钩子在 `npm pack`/`npm publish` 前重新生成它们，且**只能往 stderr 打日志**——
  lifecycle 脚本继承 npm 的 stdout，而 `scripts/pack-link-check.mjs` 要把 `npm pack --dry-run --json` 当纯 JSON 解析。
  两种 JSDoc 形状会**静默**把参数退化成 `any`（编译一个错都不报，只有读生成的 `.d.ts` 才看得见；#213 R4 两处都已修）：
  **内联 `@param {{ … }}` 类型字面量里独占一行的 `//` 注释**，以及**没有紧贴被文档化声明的文档块**。
  宿主可见签名要紧的时候，去读生成的 `.d.ts`，而不是源码里的注释。
- 文档规则（issue #164）：改 `README*.md`、`docs/requirements*.md`、任何默认值或 `files`/`exports` 清单时，必须保证 `npm run check:docs` 绿。该检查直接从 `package.json` 与 `src/` 取真值，因此文档无法静默漂移；「当前版本」声明的规范写法写在 `scripts/docs-drift-check.mjs` 顶部注释里。中英文文档成对同步（见 `AGENTS_cn.md` 对应小节）。
- 锚点粒度（issue #210）：**不要默认「文档里删一处提及就会红」**——多数锚点是*存在性*级的（`defaults` 全组、`modulemap`、`paths`：它们只问「那个文件里有没有这个字符串」，所以从同一句里删掉一处额外提及仍然绿）。只有这些是*逐处*级的（每个声明点单独比对，缺 / 多 / 改名都红）：`version` 的当前版本声明、README 的 `files`/`exports` 围栏（与 `package.json` **双向对称**比对——文档里改名或删键也会红，不只是多写才红），以及清单/枚举/单位类锚点（文件工具清单、CLI 工具清单、vendor 跳过目录、`formatSize` 的单位档位与每一条 `` `字节数` → `可读值` `` 示例映射、内置压缩策略名）。这些锚点还会对账**中英两侧的声明点处数**，接住「把某一侧的整句声明删掉」这一类。每条逐处锚点的反向证都固化在 `node scripts/docs-drift-check.mjs --self-test` 里；改了 `scripts/docs-drift-check.mjs` 就要跑一次。每个锚点属于哪一级、以及剩下那些为何**没**升级，写在脚本头部注释里。
- `--checkJs` 棘轮规则（issue #214）：`npm run check:types` **不追求清零**——217 个错（涉 29 个文件）是已接受的债（#214 首测是 218，issue #177 刀 1 给 `src/loop/orchestrator.js` 还掉 1 个）。
  它保证的是**只减不增**：总数与 `scripts/type-check-ratchet.mjs` 里的 `BASELINE_ROOT = 217` 常量比较（2026-10-10 在
  #213 之后的树上实测，环境 `typescript@5.9.3` + `@types/node@22.20.5`；issue 正文里的 226 在 #213 之前的树
  `bc3ad02` 上逐字复现，这正是入库值是 218 而不是 226 的原因）。**先还哪一半**：218 个里有 190 个落在**宿主真的能碰到的公共面**
  上（从两个入口沿 `export … from` 可达、与从生成的 `src/index.d.ts`/`src/tools/index.d.ts` 沿类型引用可达，两种独立量法
  得同一集合，共 40 个文件）；剩下 28 个在 9 个宿主点不到名的纯实现内部文件里（`run-snapshot-executor` 8、`compact/pipeline` 5、
  `error-ledger` 3、`providers/timeout` 3，另有 5 个文件各 1-2 个）。准入规则：
  - **新增文件必须首行开 `// @ts-check`。** 它是「这份文件愿意被检查」的声明，**不是范围开关**：`--checkJs` 加上
    `src/index.js` 已经会把整张 import 图拉进来（`--listFiles` 实测单入口能到 `src/` 下 **55 个文件**，其中 **29 个带错**），
    所以「只编入口」根本限制不了范围；白名单只能按文件加，这正是 #214 R2 要的事。
  - **改动某个文件时，若它的错误数能降就是顺路机会**（#179 那一类：随本就在改这个文件的 PR 消化，不单开单）。
    总数降下来后，把基线常量的下调**单独一次提交**，并在提交信息里写清哪个文件减了几个——棘轮的全部价值在于「这个数只会变小」。
  - ⚠ **跑之前先删掉生成物。** tsc 解析 `./x.js` 时**优先命中同目录的 `x.d.ts`**，所以 `npm run types:build`/`prepack`
    之后，本门禁会变成「在检查声明而不是实现」：同一棵工作树实测，**无 `.d.ts` 在场 = 218 个错**，**60 个 `.d.ts` 在场 =
    0 个错**（`--skipLibCheck` 直接跳过声明文件），去掉 `--skipLibCheck` = **87 个错且全部落在 `.d.ts` 上**。
    「0 < 基线」在这里是**假绿**，所以脚本对残留的 `src/**/*.d.ts` 直接变红（仓库提交了 0 个 `.d.ts`，存在即生成物）；
    清掉即可：`find src -name '*.d.ts' -delete`（生成物不入库、可随时重建）。
  - 故意留着的盲区（规格就是这么定的）：第二个公共入口 `src/tools/index.js` 会拉进包根图里**到不了**的
    `src/tools/file-tools.js`（27 个错）与 `src/skills/loader.js`（16 个），所以这两个文件的新错默认**卡不住**；
    `npm run check:types -- --with-tools` 卡并集（基线 **261** / 31 个文件），将来收紧就走这条路，不要拿它当「反正卡不住」的理由。
  - 工具链许可（issue #213，#214 重申）：`typescript` + `@types/node` 只能待在 dev——零运行时依赖红线约束的是
    `src/`/`bin/` 的 import（`node:` 内置 + 相对路径），本门禁也不新增依赖（只用 `node:` 内置，不建 tsconfig、不引入新工具）。

## 4. npm 发布指南（已根据 2026-08 政策验证）

### 前置条件（`package.json`）
- 必须移除 `private`（否则 403）；使用 node 脚本编辑 JSON，不要用 sed 删除一行（否则尾部逗号会破坏 JSON）。
- `files`: `["src", "bin", "skills", "README.md", "CHANGELOG.md", "docs/host-consumer-contract.md", "test/contract", "LICENSE"]` — 发布前使用 `npm publish --dry-run` 检查 tarball。
- `repository.url` 使用 `git+https://...` 格式（或运行 `npm pkg fix`）。
- 类型面（issue #213）：顶层 `types` 指向 `./src/index.d.ts`，`exports["."]` 与 `exports["./tools"]` 各带对应的 `types` 条件；
  `exports["./contract-tests"]` **刻意不带** `types`（其目标在 `test/` 下，不在声明依赖图里）。声明由 `prepack` 钩子生成，
  因此干净检出里一个 `.d.ts` 都没有——`npm publish --dry-run` 应列出约 60 个 `.d.ts`（0.18.0 实测：打包体积 +约 44 kB、
  解包 +约 139 kB）；`npm run check:types-build` 就是「还能不能生成」的门禁。
- 当前版本：`0.18.0`；版本变更使用 `npm version <x.y.z> --no-git-tag-version`（功能完整的首发版本不要使用 0.0.0）。

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
│   ├── <runId>.jsonl          # 逐轮记录（含 judge 决策字段）
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
- erix 编码任务红线：每个文件只读一次（按 offset/limit 分段），长任务先用 `todo_add` 拆解，汇报前作出验证声明。

## 8. 模型与成本纪律

- 禁止硬编码模型名称；始终从用户配置读取，或使用用户明确提供的模型。
- 模型不可用时立即失败；绝不替换模型或回退到其他模型。
- 任何批量实验开始前，必须报告模型、调用次数和基于历史平均值的成本/时长估算，并取得用户确认。
- 尊重用户对供应商和配额的选择；用户更换模型通常是出于成本或配额原因，因此不得悄悄切回原模型。
