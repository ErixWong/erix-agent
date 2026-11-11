# erix-agent — 项目 AGENTS.md（中文版）

> 英文版：[AGENTS.md](AGENTS.md)。本机共享约定：`~/projects/AGENTS.md`。
> **本页是 system prompt 的一部分：每一轮全额重发，上下文折叠也不会动它**（字节预算由
> `npm run check:agents-directives` 持有，issue #726）。它只留「会改变在这里做什么」的事实；历史、政策演变、
> 事故复盘、逐文件数字都在冷层 `docs/maintenance/command-reference_cn.md`。本页出现的数字要么归门禁持有
> （当场对账），要么是一个指针——绝不当手抄件。

## 1. 这个项目是什么

- **自研的 headless 编码 agent**：零依赖 LLM 运行时（双协议流式 + 工具循环 + 折叠 + 断点 + 续跑），用来在宿主里
  无人值守地跑（fde-workshop / touwaka）。pi = 交互式（人在环里），erix = headless（宿主调度）：互补，不是竞争。
- **边界就是一个任务生命周期**——`runToolLoop`，`executeTool` 由宿主注入。多角色仲裁、重试调度、编排是宿主的活，
  库不吸收。
- **`bin/` 是验证器/调试器，不是契约面。** 对 `bin/` 的**新增**依赖必须先升进 `src/`。现存唯一一笔借款：`exec`
  （只在 `bin/tools.js`）被 `examples/pi-extension` 借用。能力基准在独立的 `erix-bench` 仓库里以 headless 方式跑。
- 安全不内建（ADR-009）：用它的人负责；内嵌运行由宿主隔离。
- **红线**：零 npm 依赖（只 import `node:` 内置模块与相对路径）、纯 ESM、Node 22+、绝不提交 token。这条线管的是
  import，不是工具链：`typescript` 与 `@types/node` 是用户授权进来的 devDependencies（issue #213）——只为生成
  声明而存在，`src/` 与 `bin/` 都不 import 它们。
- `package-lock.json` 刻意 gitignore ⇒ 装依赖用 `npm install --include=dev`，**永远不要** `npm ci`。

## 2. 代码结构住在哪里

`README.md` 的「Module map」一节就是那棵结构树，也是 `check:docs` 当场对账的那一份（树有多大：
`find src -name '*.js' -not -name '*.d.ts' | wc -l`）。本页不留它的复本：漂移检查会把「写了却已不存在的路径」
判红，却永远不会因为「存在却没人写下来」而红——所以手抄在这页的树会一边每轮收费一边静默腐烂。

- 唯一一条属于规则而不是属于地图的结构事实：**mock MCP server 留在 `fixtures/`，绝不放进 `test/`**——
  `node --test` 会跑 `test/` 下的每一个文件，那些 server 会把它挂住。

## 3. 开发命令

一行一道闸：它判什么，以及改那道闸管的东西之前先读哪一节（锚点都是
`docs/maintenance/command-reference_cn.md` 的小节）。

| 命令 | 判什么 | 先读这一节 |
|---|---|---|
| `npm test` | 全量套件（`node --test`） | `#test-suite` |
| `node --check <file>` | 单个文件的语法 | — |
| `npm run check:syntax` | 每一个被跟踪的 `.js`/`.mjs`/`.cjs` 的语法 | `#check-syntax` |
| `npm run check:test-summary` | 套件汇总数对着它登记的基线 | `#check-test-summary` |
| `npm run check:changelog` | 公共面合并是否写进 CHANGELOG | `#check-changelog` |
| `npm run check:docs` | 文档漂移 + 中英同步 | `#check-docs` |
| `npm run check:docs:strict` | 同上，且告警也阻塞 | `#check-docs` |
| `node scripts/docs-drift-check.mjs --self-test` | 锚点自己的反向证 | `#docs-anchors` |
| `npm run check:docs-examples` | 两份契约与两份 README 里的 JS 代码围栏 | `#check-docs-examples` |
| `npm run check:pack-links` | 随包 Markdown 链接 + `.d.ts` 与发布面声称 | `#check-pack-links` |
| `npm run check:release` | 离线发布前检查清单合成一条命令 | `#check-release` |
| `npm run check:release:real` | 真实上游清单（门控 `ERIX_E2E_REAL=1`） | `#check-release-real` |
| `npm run release:day` | 发版日的四个 `--stage` | `#release-day` |
| `npm run check:cli-real` | 装好的 CLI 打真实上游（受门控） | `#check-cli-real` |
| `npm run check:docs-spelling` | 活文档里退役的扁平选项拼写 | `#check-docs-spelling` |
| `npm run check:agents-directives` | 本页：状态句、会过期的抄件、裸坐标、字节预算 | `#check-agents-directives` |
| `npm run types:build` | 生成随包发布的 `src/**/*.d.ts` | `#type-surface` |
| `npm run check:types-build` | 那些声明仍能生成、且带着入口符号 | `#type-surface` |
| `npm run check:types` | `--checkJs` 错误数棘轮（`--with-tools`：基线 **137** / 28 个文件） | `#type-ratchets` |
| `npm run check:types:strict` | strict 棘轮（阻塞；它的基线住在脚本里） | `#type-ratchets` |
| `npm run check:mutation` | 已提交的变异样本表对着这棵树 | `#check-mutation` |
| `npm run check:mutation:run` | 样本真的咬得住（变异 → 红 → 还原 → 绿） | `#check-mutation` |
| `npm run check:exports` | 每个导出名被谁消费——**不判定**；三个入口含 `test/contract/`，另有 `internal-only` 一档 | `#check-exports` |
| `npm run check:exports:deprecated` | 零消费者删除登记表与标记规矩 | `#check-exports-deprecated` |
| `npm run check:host-consumers` | 宿主侧对待删名字的 import（只给 `--hosts` 才判、CI 不跑；候选清单现算） | `#check-host-consumers` |
| `npm run check:inventory` | 兼容性钉子表对着测试的 AST | `#check-inventory` |
| `npm run check:config-leaf-values` | 配置叶取值表对着一次实跑探针 | `#check-config-leaf-values` |
| `node bin/cli.js …` | 本地跑 CLI，只为调试 | `#cli-local` |

- CI（`.github/workflows/ci.yml`）**按判据性质分两个 job**（issue #802）：`real`（行为面，每次事件都阻塞，
  node 22 **与** 24）与 `registries`（提交进库的表 vs 树，在 `pull_request` 上看得见但**不停车**）。
  **没有文档 job**——文档检查是**定期由 agent 跑的一趟检查**（`docs/maintenance/doc-review-pass_cn.md`），
  不是闸。改它 ⇒ 先读 `#ci`。`check:host-consumers` 与 `npm run soak` 必须留在 CI 之外。
- **闸的可复现性**：`check:docs` 与 `check:docs:strict` 必须在开发工作树里**和**在全新克隆里都 exit 0。需要
  `node_modules` 的闸在裸克隆里以 `Cannot find module 'typescript'` 失败，含义是**这道闸没能跑**，
  永远不是回归 ⇒ `#gate-reproducibility`。
- 测试隔离：碰 `~/.erix` 或 `~/.pi` 的测试必须注入 `home` / `cwd`（skills/mcp/config 测试是先例），否则它会污染真实
  用户配置。
- 类型面规则（issue #213）：`src/**/*.d.ts` 是**生成物、永不入库**；`prepack` 重新生成它们且**只能往 stderr 打日志**。
  有两种 JSDoc 形状会**静默**把参数退化成 `any` ⇒ `#type-surface`。
- **类型棘轮**（`check:types` / `check:types:strict`，issue #214 / #417）：root 档不追求清零，对着
  `scripts/type-check-ratchet.mjs` 里的 `BASELINE_ROOT = 102`（已接受的债，实测 102 个错）比：超过 ⇒ exit 1，
  等于 ⇒ 绿，低于 ⇒ 绿 + 「可下调至 N」提示，所以这个数只减不增；逐文件承载量与是否宿主可及都由 `--verbose` 打印。
  此前那些读数（各自树上实测 142 / 185 / 218 / 226 / 261）是**历史值**，绝不当现值用。
  `--with-tools` 把并集扩到 `./tools`（基线 **137** / 28 个文件 = 102 + 19 + 16）；`check:types:strict` 在同一条命令上追加
  `--strict`、对着脚本里它自己那对基线，它阻塞，且**两档在同一笔提交里一起降**。⚠ **跑棘轮之前先删掉生成物**
  （`find src -name '*.d.ts' -delete`）：生成物在场时 `tsc` 会把 `./x.js` 解析到同目录的声明，查的是声明而不是实现。
- **量数纪律**（issue #653，对本文提到的每一道棘轮和每一张派生表都成立）：派生数与基线**只在最终树上取**；基点落后
  `main` 就先 rebase 再取数；降下的债与它对应的基线 / 派生表更新**在同一个 PR 里**一起进。
- 新增文件首行开 `// @ts-check`（它声明意愿，不是范围开关——范围是入口的 import 图）。
- 文档规则（issue #164）：改 `README*.md`、`docs/requirements*.md`、任何默认值或 `files`/`exports` 清单，必须保持
  `npm run check:docs` 绿。「当前版本」这类句子的规定写法写在 `scripts/docs-drift-check.mjs` 的文件头注释里。
  中英成对文档必须同步（本页配 `AGENTS.md`）。
- 引用**另一个仓库**的文件：写成 `<仓名>:<那个仓里的路径>`——例如
  `pi-subagents:src/runs/background/async-execution.js:4`——且仓名必须在 `scripts/docs-drift-check.mjs` 的
  `EXTERNAL_REPO_PREFIXES` 里登记过（没登记的名字红，登记了却没人引用也红）。**不带前缀的路径就是本仓内的路径，
  必须在这里解析得到。**
- **锚点**：本页只有四个数归门禁、也只有它们是现值——`BASELINE_ROOT = 102`、符号锚点地板
  `SYMBOL_ANCHOR_MIN_UNIQUE = 243`（只升：掉到地板以下就红——锚点在退化被抓住）、裸行号棘轮
  `BARE_LINE_REF_BASELINE = 6`（只降）、锚点覆盖面地板 `REF_SCAN_DOCS_MINIMUM = 53`。文档不得依赖裸行号：
  指位置要写符号 + 它的文件（`` `符号`（`路径`） ``），不写 `路径:123`。实测流水住在
  `docs/maintenance/symbol-anchor-ledger_cn.md`。加锚点或搬锚点之前先读 `#docs-anchors`。

## 4. 发版日

四条命令，按这个顺序。下面五行清单与 `scripts/release-day.mjs` 里的 `PREFLIGHT_STEPS` 逐行对账；每一步判什么
写在 `#release-day`：

```bash
npm run release:day -- --stage preflight --hosts <host repo dirs>
#   [1/5] check:changelog                       每个公共面合并都在本版段落里有名字
#   [2/5] CHANGELOG [Unreleased] carry          还停在 `## [Unreleased]` 下的条目
#   [3/5] ERIX_E2E_REAL=1 check:release:real    真实上游；没带那个环境变量 ⇒ 什么都没跑 = 未判定
#   [4/5] check:release                         离线：包形状 / 装好的包 / TS 宿主 / CLI 假上游
#   [5/5] check:host-consumers -- --hosts …     每个宿主命中都必须已被本版升级指南覆盖
npm run release:day -- --stage publish       # 打印操作单，exit 3；`npm publish` 由你自己在终端跑
npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]
npm run release:day -- --stage finalize      # 给切版打 tag → 双推 → 两侧各验一次 → 文档闸
```

- `writeback` 重写发布态并重跑 `check:docs`；`finalize` 在那个状态不在盘上、或工作树不干净时**拒绝**打 tag。
  `writeback` 永远不许跳过。
- **宿主消费者那一步答的是覆盖度，不是否决权**：本仓就是上游，所以宿主 import 了一个被标记待删的名字，
  意思是「升级指南必须写清拿什么替换」，而不是「所以把那个名字留着」。
- npm 12 在 `~/.npm-global/bin/npm`，而 `PATH` 里 `/usr/bin/npm`（10.x）盖住它 ⇒ 用绝对路径调它。
- 认证是 device flow（`npm login --auth-type=web`），而且**每一次 publish 都各自认证一次**。非 TTY 下 URL 会被打成
  `***`，所以**抓到它的那条消息里就要交给用户**（几分钟就过期）；**不要在「Press ENTER to open in the browser」
  上按 ENTER**——没有浏览器时会触发 `xdg-open`，失败并杀掉 npm（code 3），让它继续轮询。预发布版本必须显式带
  `--tag`。
- publish 会烧掉那个版本号；`+ erix-agent@<ver>` 那一行不等于可用（registry 有延迟）⇒ 先轮询
  `npm view erix-agent version --prefer-online`，再用 `--prefer-online` 安装，然后跑
  `erix --version && erix chat "…"`。
- 当前版本：`package.json` 写 `0.32.0`（本仓版本），发布行——npm 的 `dist-tags.latest`——是 `0.31.0`。
  `check:docs` 每次运行都拿 `package.json` 与 registry **当场**对这两个数，所以两句都不带测量日期。改版本用
  `npm version <x.y.z> --no-git-tag-version`。
- `package.json` 那一面：去掉 `private`、`repository.url` 用 `git+https://…` 形态、`files` 是一份很长的显式
  白名单（读 `package.json`，别抄）；用 `npm publish --dry-run` 看产物 ⇒
  `docs/maintenance/command-reference_cn.md#publish-prerequisites` 与 `#npm-policy`。随包安装应列出 **90** 个
  `.d.ts`（`prepack` 生成，由 `npm run check:pack-links` 对账）。
- **打 tag 之前有两步是人工的**（锚点只覆盖有人登记过的维度）：① 手工走一遍**默认值**、**数字**与**名称集合**
  这三类声称，范围是两份 README、两份 AGENTS 与两份契约文档；② 如果 `check:changelog` 打了 `unattributed` 提示，
  就把里面每个短 sha 的 first-parent diff 读一遍 ⇒ `#unattributed-merges`。

## 5. Git 与远端

- **一条代码线，双推**：`origin` 从 `ErixWong/erix-agent`（GitHub）fetch，push 到 GitHub **加** Gitea
  （`git.erix.vip/eric/erix-llm-kit`）；`git push origin <ref>` 两边一起更新。这一对推送得你自己做——
  `sync-erix-mirror.sh` 那个 cron 是关着的且必须保持关，某个 push URL 失败时那一侧会静默落后：
  **推完两侧各验一次**。
- **GitHub 是工作流的真值**：issue、PR、评审都在那里。Gitea 只是代码镜像（没有 Actions 流水线；它的 issue/PR 区
  是一份冻结的历史归档——不要在那边开单或回帖）。
- 贡献流程：动到公共面的东西从 `feat-YYMMDD-NN-<描述>` / `fix-YYMMDD-NN-<描述>` 开分支 → PR 进 `main`；小修复与
  文档可直推。提交信息：conventional commits + 中文摘要。

## 6. 运行时数据与本机环境

- 运行时写出来的一切都住在 `~/.erix/`，**永不入库**（LLM 配置、MCP 注册表、会话历史、transcript、用户级 skills、
  按 cwd 隔离的待办清单）⇒ 那份树形图在 `#local-runtime-data`。
- **judge 决策有固定的家**：`~/.erix/transcripts/outputs/<runId>/judge.log`，与 transcript、工具捕获同目录同生命周期
  ——要看 judge 行为就去那里，别靠 `/tmp` 重定向。
- 模型配置来自 `~/.erix/config.json` 的 `default` 槽（relay `api.ai.erix.vip/v1`）——`erix_run` 扩展读的就是同一个
  文件，它不跟着 pi 的当前模型走。
- 本地调试用本仓的 CLI（`node bin/cli.js chat`）；监督者看 `/tmp/erix-*-log.txt` 里的逐步输出。
- agent 在本仓干活时：**读之前先估读预算，并一次装进来**，长任务先用 `todo_add` 拆开，汇报之前先给验证声明。

## 7. 模型与成本纪律

- 绝不硬编码模型名：从用户配置里读，或者用用户明确点名的那个。
- 模型不可用就直接失败；不要替换，也不要悄悄回落到别的模型。
- 任何批量实验之前，先报模型、调用次数与基于历史均值的成本/耗时估计，并拿到用户确认。
